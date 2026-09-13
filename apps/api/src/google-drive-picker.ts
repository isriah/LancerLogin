import { providerFetch } from './maintenance.ts';
import type { Env } from './index.ts';
import { activeGoogleConnection, googleConnectionRow, googleHash, readGoogleBody, GoogleConnectionError, googleCapability } from './google-connection.ts';
import { encryptIntegration, decryptIntegration } from './integration-crypto.ts';
import { driveProofRoute } from './google-drive-proof.ts';
import {preservedDriveSource} from './documentation-drive-source.ts';

const scope='https://www.googleapis.com/auth/drive.file';
type Actor={userId:string;expiresAt:number};
type Intent={id:string;actor_user_id:string;session_hash:string;generation:string;connection_revision:number;purpose:string;status:string;expires_at:number;ciphertext:string;iv:string};
function fail(status:number,message:string):never{throw new GoogleConnectionError(status,message);}
const cookie=(r:Request,name:string)=>r.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
const db=(env:Env)=>env.DB??fail(503,'Database unavailable');
const key=(env:Env)=>env.INTEGRATION_KEY??fail(503,'Integration encryption unavailable');
const admin="EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND role='admin' AND active=1)";
const documentation="EXISTS(SELECT 1 FROM users u JOIN platform_module_configuration c ON c.installation_id=u.installation_id LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id='primary' AND u.id=? AND u.active=1 AND c.hours_enabled=1 AND c.documentation_enabled=1 AND (u.role='admin' OR (u.role='staff' AND g.documentation_manage=1))) AND COALESCE((SELECT files_enabled FROM documentation_sections WHERE installation_id='primary'),1)=1";
const purposeGuard=(purpose:string)=>purpose==='documentation-source'?documentation:admin;
const connection="EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND revision=? AND grant_error IS NOT 'revoked')";
function connectionFence(iv:string|null|undefined){if(!iv||!/^[A-Za-z0-9+/_=-]{12,100}$/.test(iv))fail(409,'Shared connection unavailable');return connection+" AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND active_iv='"+iv+"')";}
const reply=(body:unknown)=>Response.json(body,{headers:{'cache-control':'no-store'}});
export async function pickerProvider(url:string,init:RequestInit={}, env?: Env) {
 try {const response=await providerFetch(env)(url,{...init,redirect:'manual',signal:AbortSignal.timeout(10000)});if(!response.ok)fail(response.status===429||response.status>=500?503:409,'Google operation was not confirmed');return await readGoogleBody(response);}
 catch(error){if(error instanceof GoogleConnectionError)throw error;return fail(503,'Google operation was not confirmed');}
}
export async function pickerInput(request:Request){
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')fail(415,'Provide JSON');
 if(!request.body)fail(400,'Provide an object');const reader=request.body.getReader();let total=0;const chunks:Uint8Array[]=[];
 let timer:ReturnType<typeof setTimeout>|undefined;const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new GoogleConnectionError(408,'Request timed out')),10000);});
 try{for(;;){const next=await Promise.race([reader.read(),deadline]);if(next.done)break;total+=next.value.length;if(total>4096)fail(413,'Request too large');chunks.push(next.value);}}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
 try{const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;}catch{return fail(400,'Provide an object');}
}
export function pickerFields(input:Record<string,unknown>,names:string[]){if(Object.keys(input).some(x=>!names.includes(x)))fail(400,'Unknown field');}
export function pickerText(value:unknown,max=128){if(typeof value!=='string'||!value||value.length>max)return fail(400,'Invalid field');return value;}
async function seal(env:Env,value:Record<string,string>){return encryptIntegration({installation:'primary',purpose:'drive-picker',...value},key(env));}
async function open(env:Env,row:{ciphertext:string;iv:string}){const value=await decryptIntegration(row.ciphertext,row.iv,key(env));if(value.installation!=='primary'||value.purpose!=='drive-picker')fail(409,'Picker state unavailable');return value;}
async function live(env:Env){const value=await activeGoogleConnection(env);if(!value?.driveEnabled||!value.organizationProof||!value.grant?.scopes.includes(scope)||value.grantError==='revoked')return fail(409,'Enable and authorize shared Drive first');return value;}
function callback(env:Env){const origin=new URL(env.ALLOWED_ORIGIN);if(origin.protocol!=='https:'||origin.origin!==env.ALLOWED_ORIGIN)fail(503,'Invalid dashboard origin');return origin.origin+'/api/admin/connections/google/callback';}
export async function clearPickerSession(env:Env,request:Request){const session=cookie(request,'lancerlogin_session');if(session&&env.DB)await env.DB.prepare("DELETE FROM google_picker_intents WHERE installation_id='primary' AND session_hash=?").bind(await googleHash(session)).run();}
export function isPickerCallback(request:Request){return new URL(request.url).searchParams.get('state')?.startsWith('picker.')===true;}
// Only fixed stage/reason pairs may cross the diagnostic boundary. Never derive
// a reason from a provider error, message, claim value or response body.
const pickerFailures={
 admission:['consent_declined','code_missing'],
 code_exchange:['state_unavailable','provider_unconfirmed'],
 token_validation:['access_token_shape','scope_mismatch','token_type_mismatch','expiry_shape'],
 token_information:['provider_unconfirmed'],
 identity_validation:['client_mismatch','subject_mismatch','scope_mismatch','expiry_shape'],
 drive_identity:['provider_unconfirmed','identity_invalid','account_mismatch','connection_changed'],
 persistence:['connection_changed','write_unconfirmed'],
} as const;
type FailureStage=keyof typeof pickerFailures;
type PickerFailure={stage:FailureStage;reason:string};
function safePickerFailure(value:Record<string,string>):PickerFailure|undefined{
 const stage=value.failureStage,reason=value.failureReason;
 if(typeof stage!=='string'||typeof reason!=='string'||!Object.hasOwn(pickerFailures,stage)||!(pickerFailures[stage as FailureStage] as readonly string[]).includes(reason))return;
 return {stage:stage as FailureStage,reason};
}
export async function drivePickerCallback(request:Request,env:Env){
 let destination='/settings/integrations';
 let success=false,diagnostic:PickerFailure={stage:'admission',reason:'consent_declined'};
 let consumed:{intent:Intent;fence:string}|undefined;
 const checking=(stage:FailureStage,reason:string)=>{diagnostic={stage,reason};};
 try{
  const url=new URL(request.url),state=pickerText(url.searchParams.get('state'),200);if(state!==cookie(request,'lancerlogin_picker_state'))fail(400,'Invalid Picker state');
  const store=db(env),intent=await store.prepare("SELECT * FROM google_picker_intents WHERE installation_id='primary' AND state_hash=? AND status='pending' AND expires_at>?").bind(await googleHash(state),Date.now()).first<Intent>();if(!intent)fail(409,'Picker intent expired');if(intent.purpose==='documentation-source')destination='/documentation';
  const session=cookie(request,'lancerlogin_session');if(session&&await googleHash(session)!==intent.session_hash)fail(403,'Wrong session');
  const activeRow=await googleConnectionRow(env),active=await live(env),boundConnection=connectionFence(activeRow?.active_iv);if(active.generation!==intent.generation)fail(409,'Google connection changed');
  const claimed=await store.prepare(`UPDATE google_picker_intents SET status='exchanging' WHERE installation_id='primary' AND id=? AND status='pending' AND expires_at>? AND ${purposeGuard(intent.purpose)} AND ${boundConnection}`).bind(intent.id,Date.now(),intent.actor_user_id,intent.connection_revision).run();if(claimed.meta?.changes!==1)fail(409,'Picker authorization ended');
  consumed={intent,fence:boundConnection};
  if(url.searchParams.has('error'))fail(409,'Picker consent declined');
  checking('admission','code_missing');const code=pickerText(url.searchParams.get('code'),4096);
  checking('code_exchange','state_unavailable');const saved=await open(env,intent);
  checking('code_exchange','provider_unconfirmed');
  const token=await pickerProvider('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:active.clientId,client_secret:active.clientSecret,grant_type:'authorization_code',code,code_verifier:saved.verifier,redirect_uri:callback(env)})}, env);
  checking('token_validation','access_token_shape');const accessToken=pickerText(token.access_token,16000);
  checking('token_validation','scope_mismatch');if(token.scope!==scope)fail(409,'Google did not return isolated Drive access');
  checking('token_validation','token_type_mismatch');if(token.token_type!=='Bearer')fail(409,'Google did not return isolated Drive access');
  checking('token_validation','expiry_shape');if(!Number.isSafeInteger(token.expires_in)||Number(token.expires_in)<30)fail(409,'Google did not return isolated Drive access');
  // Provider URL is never logged or reflected. Identity and exact scopes are checked
  // before this token can cross the server/browser boundary.
  checking('token_information','provider_unconfirmed');
  const info=await pickerProvider('https://www.googleapis.com/oauth2/v2/tokeninfo?access_token='+encodeURIComponent(accessToken),{method:'POST'}, env);
  checking('identity_validation','client_mismatch');if(info.audience!==active.clientId||info.issued_to!==active.clientId)fail(409,'Picker account or scope does not match');
  checking('identity_validation','scope_mismatch');if(info.scope!==scope)fail(409,'Picker account or scope does not match');
  checking('identity_validation','expiry_shape');if(!Number.isSafeInteger(info.expires_in)||Number(info.expires_in)<30)fail(409,'Picker account or scope does not match');
  checking('drive_identity','connection_changed');
  const capability=await googleCapability(env,'drive');
  if(capability.generation!==intent.generation||capability.signature!==activeRow?.active_iv)fail(409,'Google connection changed');
  checking('drive_identity','provider_unconfirmed');const organizationToken=await capability.accessToken();
  checking('drive_identity','connection_changed');const identityRow=await googleConnectionRow(env);
  if(identityRow?.active_iv!==capability.signature||identityRow?.revision!==intent.connection_revision||identityRow?.grant_error==='revoked')fail(409,'Google connection changed');
  checking('drive_identity','provider_unconfirmed');
  const aboutUrl='https://www.googleapis.com/drive/v3/about?fields=user(permissionId)';
  const isolatedUser=await pickerProvider(aboutUrl,{headers:{authorization:'Bearer '+accessToken}}, env);
  const organizationalUser=await pickerProvider(aboutUrl,{headers:{authorization:'Bearer '+organizationToken}}, env);
  checking('drive_identity','identity_invalid');
  const permissionId=(user:unknown)=>user&&typeof user==='object'&&!Array.isArray(user)?(user as Record<string,unknown>).permissionId:undefined;
  const isolatedId=permissionId(isolatedUser.user),organizationalId=permissionId(organizationalUser.user);
  if(typeof isolatedId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(isolatedId)||typeof organizationalId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(organizationalId))fail(409,'Drive account could not be verified');
  checking('drive_identity','account_mismatch');if(isolatedId!==organizationalId)fail(409,'Picker account or scope does not match');
  checking('persistence','connection_changed');const current=await live(env);if(current.generation!==intent.generation)fail(409,'Google connection changed');
  checking('persistence','write_unconfirmed');
  const expires=Math.min(intent.expires_at,Date.now()+Math.min(Number(info.expires_in),Number(token.expires_in))*1000-5000),encrypted=await seal(env,{token:accessToken,tokenExpires:String(expires)});
  const result=await store.prepare(`UPDATE google_picker_intents SET status='ready',ciphertext=?,iv=?,expires_at=? WHERE installation_id='primary' AND id=? AND status='exchanging' AND expires_at>? AND ${purposeGuard(intent.purpose)} AND ${boundConnection}`).bind(encrypted.ciphertext,encrypted.iv,expires,intent.id,Date.now(),intent.actor_user_id,intent.connection_revision).run();if(result.meta?.changes!==1)fail(409,'Picker authorization ended');success=true;
 }catch{
  // Diagnostic persistence is best effort, only for this consumed, unexpired
  // intent under its original authority. Never overwrite ready/replaced state.
  if(consumed)try{
   const {intent,fence}=consumed,encrypted=await seal(env,{failureStage:diagnostic.stage,failureReason:diagnostic.reason});
   await db(env).prepare(`UPDATE google_picker_intents SET ciphertext=?,iv=? WHERE installation_id='primary' AND id=? AND session_hash=? AND generation=? AND iv=? AND status='exchanging' AND expires_at>? AND ${purposeGuard(intent.purpose)} AND ${fence}`).bind(encrypted.ciphertext,encrypted.iv,intent.id,intent.session_hash,intent.generation,intent.iv,Date.now(),intent.actor_user_id,intent.connection_revision).run();
  }catch{/* Preserve the generic redirect even if diagnostics are unavailable. */}
 }
 return new Response(null,{status:302,headers:{location:env.ALLOWED_ORIGIN+destination+'?drivePicker='+(success?'ready':'failed'),'cache-control':'no-store','set-cookie':'lancerlogin_picker_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'}});
}
export async function drivePickerRoute(request:Request,env:Env,actor:Actor){
 if(!Number.isSafeInteger(actor.expiresAt)||actor.expiresAt<=Date.now())fail(401,'Session expired');
 const store=db(env),path=new URL(request.url).pathname.replace('/admin/connections/google/drive','');
 const row=await googleConnectionRow(env),active=await live(env),boundConnection=connectionFence(row?.active_iv),session=cookie(request,'lancerlogin_session')??fail(401,'Sign in required'),sessionHash=await googleHash(session);
 const input:Record<string,unknown>=request.method==='GET'?{revision:row!.revision}:await pickerInput(request);
 let purpose=path==='/picker/authorize'?String(input.purpose):new URL(request.url).searchParams.get('purpose')??'root';
 if(['/picker/claim','/selection'].includes(path)){
  const selected=await store.prepare("SELECT purpose FROM google_picker_intents WHERE installation_id='primary' AND id=? AND actor_user_id=? AND session_hash=? AND generation=? AND connection_revision=? AND expires_at>?").bind(pickerText(input.intentId),actor.userId,sessionHash,active.generation,row!.revision,Date.now()).first<{purpose:string}>();
  if(!selected)fail(409,'Picker intent unavailable');purpose=selected.purpose;
 }
 if(purpose==='documentation-source'&&!['/status','/picker/authorize','/picker/claim','/selection'].includes(path))fail(403,'Documentation selection only');
 const guard=purposeGuard(purpose)+` AND ${actor.expiresAt}>CAST(unixepoch('subsec')*1000 AS INTEGER)`;
 if(!await store.prepare(`SELECT 1 WHERE ${guard}`).bind(actor.userId).first())fail(403,'Picker access unavailable');
 await store.prepare("DELETE FROM google_picker_intents WHERE installation_id='primary' AND (expires_at<=? OR generation<>? OR connection_revision<>?)").bind(Date.now(),active.generation,row!.revision).run();
 const config=await store.prepare("SELECT revision,project_number,browser_key,root_id,root_name,generation FROM google_drive_feasibility WHERE installation_id='primary'").first<{revision:number;project_number:string;browser_key:string;root_id:string|null;root_name:string|null;generation:string}>();
 if(path==='/status'&&request.method==='GET'){
  const stored=await store.prepare(`SELECT * FROM google_picker_intents WHERE installation_id='primary' AND actor_user_id=? AND session_hash=? AND expires_at>? AND ((?='documentation-source' AND purpose='documentation-source') OR (?<>'documentation-source' AND purpose IN ('root','source'))) AND ${guard} AND ${boundConnection} ORDER BY expires_at DESC LIMIT 1`).bind(actor.userId,sessionHash,Date.now(),purpose,purpose,actor.userId,row!.revision).first<Intent>();
  let diagnostic:PickerFailure|undefined;
  if(stored?.status==='exchanging')try{diagnostic=safePickerFailure(await open(env,stored));}catch{/* Old or unavailable envelopes carry no diagnostic. */}
  const intent=stored?{id:stored.id,purpose:stored.purpose,status:stored.status,...(diagnostic?{diagnostic}:{})}:null;
  return reply({revision:row!.revision,configured:Boolean(config&&config.generation===active.generation),configRevision:config?.revision??0,rootName:config?.generation===active.generation?config.root_name:null,intent});
 }
 if(input.revision!==row!.revision)fail(409,'Google connection changed; reload');
 if(path==='/configuration'&&request.method==='PUT'){
  pickerFields(input,['revision','configRevision','projectNumber','browserKey']);const project=pickerText(input.projectNumber,30),browserKey=pickerText(input.browserKey,200);if(!/^\d{1,30}$/.test(project)||!/^[A-Za-z0-9_-]{20,200}$/.test(browserKey)||input.configRevision!==(config?.revision??0))fail(400,'Check Picker configuration');
  const result=await store.batch([store.prepare(`INSERT INTO google_drive_feasibility(installation_id,revision,project_number,browser_key,generation) SELECT 'primary',1,?,?,? WHERE ${guard} AND ${boundConnection} ON CONFLICT(installation_id) DO UPDATE SET revision=revision+1,project_number=excluded.project_number,browser_key=excluded.browser_key,generation=excluded.generation,root_id=NULL,root_name=NULL WHERE revision=?`).bind(project,browserKey,active.generation,actor.userId,row!.revision,input.configRevision),store.prepare("DELETE FROM google_picker_intents WHERE installation_id='primary' AND changes()=1")]);if(result[0].meta?.changes!==1)fail(409,'Configuration changed; reload');return reply({saved:true});
 }
 if(!config||config.generation!==active.generation)fail(409,'Configure Picker first');
 if(path.startsWith('/feasibility-runs')){
  if(!config.root_id)fail(409,'Select the private test root first');let source:Record<string,string>|undefined;
  if(path==='/feasibility-runs'&&request.method==='POST'){
   const intent=await store.prepare("SELECT * FROM google_picker_intents WHERE installation_id='primary' AND id=? AND actor_user_id=? AND session_hash=? AND purpose='source' AND status='selected' AND expires_at>?").bind(pickerText(input.sourceIntentId),actor.userId,sessionHash,Date.now()).first<Intent>();if(!intent)fail(409,'Select a synthetic source first');source=await open(env,intent);
  }
  return driveProofRoute(request,env,actor,input,path,config.root_id,active.generation,source?{fileId:source.fileId,resourceKey:source.resourceKey,version:source.version,mime:source.mime,checksum:source.checksum}:undefined);
 }
 if(path==='/picker/authorize'&&request.method==='POST'){
  pickerFields(input,['revision','purpose']);if(!['root','source','documentation-source'].includes(String(input.purpose)))fail(400,'Choose selection purpose');
  const state='picker.'+crypto.randomUUID()+crypto.randomUUID(),id=crypto.randomUUID(),verifier=crypto.randomUUID()+crypto.randomUUID(),encrypted=await seal(env,{verifier});
  const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const results=await store.batch([store.prepare("DELETE FROM google_picker_intents WHERE installation_id='primary' AND actor_user_id=? AND session_hash=? AND ((?='documentation-source' AND purpose='documentation-source') OR (?<>'documentation-source' AND purpose IN ('root','source')))").bind(actor.userId,sessionHash,purpose,purpose),store.prepare(`INSERT INTO google_picker_intents(installation_id,id,state_hash,actor_user_id,session_hash,generation,connection_revision,purpose,status,expires_at,ciphertext,iv) SELECT 'primary',?,?,?,?,?,?,?,'pending',?,?,? WHERE ${guard} AND ${boundConnection} AND (SELECT COUNT(*) FROM google_picker_intents WHERE installation_id='primary')<32`).bind(id,await googleHash(state),actor.userId,sessionHash,active.generation,row!.revision,input.purpose,Math.min(actor.expiresAt,Date.now()+600000),encrypted.ciphertext,encrypted.iv,actor.userId,row!.revision)]);if(results[1].meta?.changes!==1)fail(409,'Picker unavailable; reload');
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.search=new URLSearchParams({client_id:active.clientId,redirect_uri:callback(env),response_type:'code',scope,include_granted_scopes:'false',access_type:'online',prompt:'select_account',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
  return Response.json({authorizationUrl:url.href},{headers:{'cache-control':'no-store','set-cookie':`lancerlogin_picker_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`}});
 }
 if(path==='/picker/claim'&&request.method==='POST'){
  pickerFields(input,['revision','intentId']);const id=pickerText(input.intentId),intent=await store.prepare("SELECT * FROM google_picker_intents WHERE installation_id='primary' AND id=? AND actor_user_id=? AND session_hash=? AND status='ready' AND expires_at>?").bind(id,actor.userId,sessionHash,Date.now()).first<Intent>();if(!intent)fail(409,'Picker access expired or was already claimed');const saved=await open(env,intent);
  const blank=await seal(env,{}),claimed=await store.prepare(`UPDATE google_picker_intents SET status='claimed',ciphertext=?,iv=? WHERE installation_id='primary' AND id=? AND status='ready' AND expires_at>? AND ${guard} AND ${boundConnection}`).bind(blank.ciphertext,blank.iv,id,Date.now(),actor.userId,row!.revision).run();if(claimed.meta?.changes!==1)fail(409,'Picker access changed');
  return reply({intentId:id,purpose:intent.purpose,accessToken:saved.token,expiresAt:Number(saved.tokenExpires),scope,projectNumber:config.project_number,browserKey:config.browser_key});
 }
 if(path==='/selection'&&request.method==='POST'){
  pickerFields(input,['revision','intentId','fileId','resourceKey']);const id=pickerText(input.intentId),fileId=pickerText(input.fileId),resourceKey=input.resourceKey===undefined?'':pickerText(input.resourceKey);
  if(!/^[A-Za-z0-9_-]+$/.test(fileId)||resourceKey&&!/^[A-Za-z0-9_-]+$/.test(resourceKey))fail(400,'Invalid selection');
  const intent=await store.prepare("SELECT * FROM google_picker_intents WHERE installation_id='primary' AND id=? AND actor_user_id=? AND session_hash=? AND status='claimed' AND expires_at>?").bind(id,actor.userId,sessionHash,Date.now()).first<Intent>();if(!intent)fail(409,'Select again with Picker');
  const capability=await googleCapability(env,'drive'),token=await capability.accessToken(),headers:Record<string,string>={authorization:'Bearer '+token};if(resourceKey)headers['x-goog-drive-resource-keys']=fileId+'/'+resourceKey;
  const file=await pickerProvider('https://www.googleapis.com/drive/v3/files/'+fileId+'?fields=id,name,mimeType,size,sha256Checksum,version,modifiedTime,trashed,driveId,ownedByMe,capabilities(canCopy,canAddChildren)',{headers}, env);
  if(intent.purpose!=='documentation-source'&&(file.id!==fileId||file.trashed!==false||file.driveId||file.ownedByMe!==true))fail(409,'Choose an owned My Drive test file');
  const name=pickerText(file.name,255),mime=pickerText(file.mimeType,150),caps=file.capabilities as Record<string,unknown>|undefined;
  if(intent.purpose==='root'){
   if(mime!=='application/vnd.google-apps.folder'||caps?.canAddChildren!==true)fail(409,'Choose a writable folder');
   const permissions=await pickerProvider('https://www.googleapis.com/drive/v3/files/'+fileId+'/permissions?fields=permissions(type,role),nextPageToken&pageSize=100',{headers}, env);
   if(!Array.isArray(permissions.permissions)||permissions.nextPageToken||permissions.permissions.some((p:any)=>p.type!=='user'||p.role!=='owner'))fail(409,'Choose a private owner-only test folder');
  }else if(intent.purpose==='documentation-source'){preservedDriveSource(file,fileId);}
  else if(!name.startsWith('LancerLogin synthetic ')||caps?.canCopy!==true||(!['application/pdf','image/png','application/vnd.google-apps.document'].includes(mime))||(mime!=='application/vnd.google-apps.document'&&(!/^\d+$/.test(String(file.size))||Number(file.size)>1048576)))fail(409,'Choose a supported LancerLogin synthetic test source under 1 MiB');
  const encrypted=await seal(env,{fileId,name,mime,resourceKey,version:String(file.version??''),modifiedTime:String(file.modifiedTime??''),checksum:String(file.sha256Checksum??''),size:String(file.size??'')});
  const updates=[store.prepare(`UPDATE google_picker_intents SET status='selected',ciphertext=?,iv=? WHERE installation_id='primary' AND id=? AND status='claimed' AND expires_at>? AND ${guard} AND ${boundConnection}`).bind(encrypted.ciphertext,encrypted.iv,id,Date.now(),actor.userId,row!.revision)];
  if(intent.purpose==='root')updates.push(store.prepare("UPDATE google_drive_feasibility SET root_id=?,root_name=?,revision=revision+1 WHERE installation_id='primary' AND revision=? AND changes()=1").bind(fileId,name,config.revision));
  const results=await store.batch(updates);if(results.some(x=>x.meta?.changes!==1))fail(409,'Selection changed; reload');return reply({selected:true,purpose:intent.purpose,name,mimeType:mime,intentId:id});
 }
 return fail(404,'Drive action unavailable');
}

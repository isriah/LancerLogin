import { providerFetch } from './maintenance.ts';
import type {Env} from './index.ts';
import {googleCapability,googleConnectionRow,GoogleConnectionError,readGoogleBody} from './google-connection.ts';
import {encryptIntegration,decryptIntegration} from './integration-crypto.ts';
import {pickerProvider,pickerText,pickerFields} from './google-drive-picker.ts';

type State={root:string;source:string;sourceKey:string;sourceVersion:string;sourceChecksum:string;mime:string;ids:string[];step:number;pending:boolean;session?:string;offset:number;copyId?:string;published:boolean;replacement:boolean;verified:boolean};
type Run={id:string;revision:number;status:string;generation:string;ciphertext:string;iv:string};
const stages=['folders','copy','private-upload','public-upload','publish','replace','verify'] as const;
function fail(message:string):never{throw new GoogleConnectionError(409,message);}
const json=(body:unknown)=>Response.json(body,{headers:{'cache-control':'no-store'}});
const prefix='https://www.googleapis.com/drive/v3/files';
function validateSession(value:unknown){const url=new URL(pickerText(value,4096));if(url.protocol!=='https:'||url.hostname!=='www.googleapis.com'||url.port||url.username||url.password||url.hash||!/^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]{1,128})?$/.test(url.pathname)||url.searchParams.get('uploadType')!=='resumable')fail('Unexpected upload session');return url.href;}
// A valid synthetic PDF padded with comments, large enough to require multiple chunks.
export function syntheticDrivePdf(replacement=false){
 const text=replacement?'Synthetic replacement packet':'Synthetic private packet',parts=['%PDF-1.4\n'],offsets=[0];
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const stream=`BT /F1 18 Tf 40 740 Td (${text}) Tj ET`;objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
 objects.forEach((o,i)=>{offsets.push(parts.join('').length);parts.push(`${i+1} 0 obj\n${o}\nendobj\n`);});const xref=parts.join('').length;parts.push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
 parts.push(('% synthetic padding\n').repeat(30000));return new TextEncoder().encode(parts.join(''));
}
async function digest(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes).buffer)),x=>x.toString(16).padStart(2,'0')).join('');}
async function media(url:string,init:RequestInit, env?: Env){try{return await providerFetch(env)(url,{...init,redirect:'manual',signal:AbortSignal.timeout(10000)});}catch{return fail('Upload outcome is uncertain; inspect the existing run');}}
export function uploadOffset(response:Response,total:number){if(response.status!==308)fail('Upload status is not resumable');const range=response.headers.get('range');if(range===null)return 0;const match=/^bytes=0-(\d+)$/.exec(range);if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[1])>=total)fail('Invalid upload checkpoint');return Number(match[1])+1;}
async function storeState(env:Env,run:Run,state:State,status:string,actor:{userId:string;expiresAt:number},connectionRevision:number,connectionIv:string|null){
 const encrypted=await encryptIntegration({installation:'primary',purpose:'drive-proof',payload:JSON.stringify(state)},env.INTEGRATION_KEY!);
 const result=await env.DB!.prepare("UPDATE google_drive_proof_runs SET ciphertext=?,iv=?,status=?,revision=revision+1 WHERE installation_id='primary' AND id=? AND revision=? AND EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND role='admin' AND active=1) AND ?>CAST(unixepoch('subsec')*1000 AS INTEGER) AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND revision=? AND active_iv=? AND grant_error IS NOT 'revoked')").bind(encrypted.ciphertext,encrypted.iv,status,run.id,run.revision,actor.userId,actor.expiresAt,connectionRevision,connectionIv).run();if(result.meta?.changes!==1)fail('Run or authority changed; reload');run.revision++;run.status=status;
}
function summary(run:Run,state:State){return {id:run.id,revision:run.revision,status:run.status,stage:stages[state.step]??'complete',pending:state.pending,offset:state.offset,published:state.published,verified:state.verified,publicUrl:state.published?'https://drive.google.com/file/d/'+state.ids[4]+'/view':null};}
export async function driveProofRoute(request:Request,env:Env,actor:{userId:string;expiresAt:number},input:Record<string,unknown>,path:string,root:string,generation:string,source?:{fileId:string;resourceKey:string;version:string;mime:string;checksum:string}){
 const db=env.DB!,connection=await googleConnectionRow(env);if(input.revision!==connection?.revision)fail('Connection changed; reload');
 const capability=await googleCapability(env,'drive');if(capability.generation!==generation)fail('Connection changed');
 if(path==='/feasibility-runs'&&request.method==='POST'){
  pickerFields(input,['revision','runId','sourceIntentId','confirmation']);const requestedId=pickerText(input.runId);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestedId))fail('Provide a run UUID');if(await db.prepare("SELECT id FROM google_drive_proof_runs WHERE installation_id='primary' AND id=?").bind(requestedId).first())fail('Run already exists; inspect it instead of creating again');if(input.confirmation!=='RUN SYNTHETIC DRIVE PROOF'||!source)fail('Explicit synthetic proof confirmation required');
  if((await db.prepare("SELECT COUNT(*) AS n FROM google_drive_proof_runs WHERE installation_id='primary'").first<{n:number}>())!.n>=16)fail('Synthetic run budget exhausted; coordinator review required');
  const token=await capability.accessToken(),result=await pickerProvider(prefix+'/generateIds?count=5&space=drive&type=files',{headers:{authorization:'Bearer '+token}}, env);if(!Array.isArray(result.ids)||result.ids.length!==5||new Set(result.ids).size!==5||result.ids.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(x)))fail('Google did not allocate test identities');
  const state:State={root,source:source.fileId,sourceKey:source.resourceKey,sourceVersion:source.version,sourceChecksum:source.checksum,mime:source.mime,ids:result.ids as string[],step:0,pending:false,offset:0,published:false,replacement:false,verified:false};
  const encrypted=await encryptIntegration({installation:'primary',purpose:'drive-proof',payload:JSON.stringify(state)},env.INTEGRATION_KEY!),id=requestedId;
  const saved=await db.prepare("INSERT INTO google_drive_proof_runs(installation_id,id,actor_user_id,generation,status,ciphertext,iv,created_at) SELECT 'primary',?,?,?,'ready',?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND role='admin' AND active=1) AND ?>CAST(unixepoch('subsec')*1000 AS INTEGER) AND EXISTS(SELECT 1 FROM google_connections WHERE installation_id='primary' AND revision=? AND active_iv=? AND grant_error IS NOT 'revoked') AND (SELECT COUNT(*) FROM google_drive_proof_runs WHERE installation_id='primary')<16").bind(id,actor.userId,generation,encrypted.ciphertext,encrypted.iv,Date.now(),actor.userId,actor.expiresAt,connection!.revision,connection!.active_iv).run();if(saved.meta?.changes!==1)fail('Run was not recorded');return json(summary({id,revision:0,status:'ready',generation,...encrypted},state));
 }
 const match=/^\/feasibility-runs\/([a-zA-Z0-9-]{1,128})(\/resume)?$/.exec(path);if(!match)fail('Unknown run');
 const run=await db.prepare("SELECT * FROM google_drive_proof_runs WHERE installation_id='primary' AND id=?").bind(match[1]).first<Run>();if(!run||run.generation!==generation)fail('Run belongs to an unavailable connection');
 const envelope=await decryptIntegration(run.ciphertext,run.iv,env.INTEGRATION_KEY!);if(envelope.installation!=='primary'||envelope.purpose!=='drive-proof')fail('Invalid run');const state=JSON.parse(envelope.payload) as State;
 if(request.method==='GET')return json(summary(run,state));
 pickerFields(input,['revision','runRevision','confirmation']);if(!match[2]||request.method!=='POST'||input.runRevision!==run.revision||input.confirmation!=='CONTINUE SYNTHETIC DRIVE PROOF')fail('Reload and explicitly continue this run');
 if(state.step>=stages.length)return json(summary(run,state));
 const wasPending=state.pending;
 const token=await capability.accessToken(),headers={authorization:'Bearer '+token},meta=(id:string)=>pickerProvider(prefix+'/'+id+'?fields=id,mimeType,parents,size,sha256Checksum,appProperties,trashed',{headers}, env);
 const privateFolder=async(id:string,parent?:string)=>{
  const folder=await pickerProvider(prefix+'/'+id+'?fields=id,mimeType,parents,trashed,ownedByMe,capabilities(canAddChildren)',{headers}, env);
  if(folder.id!==id||folder.mimeType!=='application/vnd.google-apps.folder'||folder.trashed===true||folder.ownedByMe!==true||(folder.capabilities as any)?.canAddChildren!==true||(parent&&(!Array.isArray(folder.parents)||!folder.parents.includes(parent))))fail('Private destination changed; coordinator review required');
  const permissions=await pickerProvider(prefix+'/'+id+'/permissions?fields=permissions(type,role),nextPageToken&pageSize=100',{headers}, env);if(!Array.isArray(permissions.permissions)||!permissions.permissions.length||permissions.nextPageToken||permissions.permissions.some((p:any)=>p.type!=='user'||p.role!=='owner'))fail('Private destination is no longer owner-only');
 };
 // Selection is not a permanent privacy proof. Revalidate immediately before
 // each bounded write/chunk, including when continuing a previously saved run.
 if(state.step<6){await privateFolder(state.root);const parent=state.step===1?state.ids[0]:state.step===2?state.ids[1]:state.step>=3?state.ids[2]:undefined;if(parent)await privateFolder(parent,state.root);}
 if(state.step===4){const reviewed=await meta(state.ids[4]),expectedBytes=syntheticDrivePdf();if(reviewed.mimeType!=='application/pdf'||reviewed.trashed===true||Number(reviewed.size)!==expectedBytes.length||reviewed.sha256Checksum!==await digest(expectedBytes)||(reviewed.appProperties as any)?.lancerloginProof!==run.id||!Array.isArray(reviewed.parents)||reviewed.parents.length!==1||reviewed.parents[0]!==state.ids[2])fail('Public candidate changed; review before publishing');}
 state.pending=true;await storeState(env,run,state,'pending',actor,connection!.revision,connection!.active_iv);
 // Every network mutation is preceded by durable pending state. A pending copy,
 // folder or permission operation is reconciled by reads, never repeated blindly.
 if(state.step===0){
  if(wasPending){for(const id of state.ids.slice(0,3)){const file=await meta(id);if((file.appProperties as any)?.lancerloginProof!==run.id||!Array.isArray(file.parents)||!file.parents.includes(state.root))fail('Folder outcome needs coordinator review');}}
  else for(let i=0;i<3;i++)await pickerProvider(prefix+'?fields=id',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({id:state.ids[i],name:['LancerLogin synthetic originals','LancerLogin synthetic private versions','LancerLogin synthetic published'][i],mimeType:'application/vnd.google-apps.folder',parents:[state.root],appProperties:{lancerloginProof:run.id}})}, env);
  state.step++;
 }else if(state.step===1){
  const q="trashed=false and appProperties has { key='lancerloginProof' and value='"+run.id+"' } and '"+state.ids[0]+"' in parents";
  if(wasPending){const result=await pickerProvider(prefix+'?q='+encodeURIComponent(q)+'&fields=files(id,mimeType),nextPageToken&pageSize=2',{headers}, env);if(!Array.isArray(result.files)||result.files.length!==1||result.nextPageToken)fail('Copy outcome needs coordinator review; no duplicate was created');state.copyId=pickerText((result.files[0] as any).id);}
  else{
   const sourceHeaders={...headers,...(state.sourceKey?{'x-goog-drive-resource-keys':state.source+'/'+state.sourceKey}:{})};
   const current=await pickerProvider(prefix+'/'+state.source+'?fields=id,version,capabilities(canCopy)',{headers:sourceHeaders}, env);if(String(current.version)!==state.sourceVersion||(current.capabilities as any)?.canCopy!==true)fail('Synthetic source changed; select again');
   const copied=await pickerProvider(prefix+'/'+state.source+'/copy?fields=id,mimeType,parents',{method:'POST',headers:{...sourceHeaders,'content-type':'application/json'},body:JSON.stringify({name:'LancerLogin synthetic preserved source',parents:[state.ids[0]],appProperties:{lancerloginProof:run.id}})}, env);state.copyId=pickerText(copied.id);
  }
  const after=await pickerProvider(prefix+'/'+state.source+'?fields=version',{headers:{...headers,...(state.sourceKey?{'x-goog-drive-resource-keys':state.source+'/'+state.sourceKey}:{})}}, env);if(String(after.version)!==state.sourceVersion)fail('Source changed during copying; coordinator review required');
  const copied=await meta(state.copyId!);if(state.mime!=='application/vnd.google-apps.document'&&(!/^[a-f0-9]{64}$/.test(state.sourceChecksum)||copied.sha256Checksum!==state.sourceChecksum))fail('Copied content checksum was not verified');if(copied.mimeType!==state.mime||!(copied.parents as string[])?.includes(state.ids[0]))fail('Copy metadata was not verified');state.step++;
 }else if([2,3,5].includes(state.step)){
  const replacement=state.step===5,bytes=syntheticDrivePdf(replacement),fileId=state.step===2?state.ids[3]:state.ids[4],parent=state.step===2?state.ids[1]:state.ids[2];
  if(!state.session){
   if(wasPending){const file=await meta(fileId);if(file.sha256Checksum===await digest(bytes)&&Number(file.size)===bytes.length){state.step++;state.offset=0;}else fail('Upload initialization outcome needs coordinator review');}
   else{
    const target='https://www.googleapis.com/upload/drive/v3/files'+(replacement?'/'+fileId:'')+'?uploadType=resumable&fields=id,size,sha256Checksum';
    const response=await media(target,{method:replacement?'PATCH':'POST',headers:{...headers,'content-type':'application/json','x-upload-content-type':'application/pdf','x-upload-content-length':String(bytes.length)},body:JSON.stringify(replacement?{}:{id:fileId,name:'LancerLogin synthetic packet.pdf',mimeType:'application/pdf',parents:[parent],appProperties:{lancerloginProof:run.id}})}, env);
    if(!response.ok)fail('Upload initialization was not confirmed');state.session=validateSession(response.headers.get('location'));state.offset=0;
   }
  }else{
   const session=validateSession(state.session);let response:Response;
   if(wasPending)response=await media(session,{method:'PUT',headers:{...headers,'content-range':'bytes */'+bytes.length,'content-length':'0'}}, env);
   else {const end=Math.min(state.offset+262144,bytes.length),chunk=bytes.slice(state.offset,end);response=await media(session,{method:'PUT',headers:{...headers,'content-type':'application/pdf','content-range':`bytes ${state.offset}-${end-1}/${bytes.length}`,'content-length':String(chunk.length)},body:chunk}, env);}
   if(response.status===308)state.offset=uploadOffset(response,bytes.length);
   else if(response.status===200||response.status===201){await readGoogleBody(response);const file=await meta(fileId);if(file.sha256Checksum!==await digest(bytes)||Number(file.size)!==bytes.length)fail('Completed PDF does not match synthetic input');state.step++;state.session=undefined;state.offset=0;if(replacement)state.replacement=true;}
   else fail('Upload session unavailable; coordinator read-back required');
  }
 }else if(state.step===4){
  if(!wasPending)await pickerProvider(prefix+'/'+state.ids[4]+'/permissions?fields=id',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({type:'anyone',role:'reader',allowFileDiscovery:false})}, env);
  const permissions=await pickerProvider(prefix+'/'+state.ids[4]+'/permissions?fields=permissions(type,role),nextPageToken&pageSize=100',{headers}, env);if(!Array.isArray(permissions.permissions)||permissions.nextPageToken||!permissions.permissions.some((p:any)=>p.type==='anyone'&&p.role==='reader'))fail('Publication was not verified');state.published=true;state.step++;
 }else{
  for(const id of [state.root,...state.ids.slice(0,4),state.copyId!]){const permissions=await pickerProvider(prefix+'/'+id+'/permissions?fields=permissions(type,role),nextPageToken&pageSize=100',{headers}, env);if(!Array.isArray(permissions.permissions)||permissions.nextPageToken||permissions.permissions.some((p:any)=>p.type!=='user'||p.role!=='owner'))fail('Private source or folder permissions changed');}
  const original=await meta(state.ids[3]),published=await meta(state.ids[4]);if(original.sha256Checksum!==await digest(syntheticDrivePdf())||published.sha256Checksum!==await digest(syntheticDrivePdf(true)))fail('Private/public version proof failed');state.verified=true;state.step++;
 }
 state.pending=false;await storeState(env,run,state,state.verified?'verified':'ready',actor,connection!.revision,connection!.active_iv);return json(summary(run,state));
}

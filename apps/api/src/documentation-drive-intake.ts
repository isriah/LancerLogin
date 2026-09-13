import { documentationAvailable } from '../../../packages/shared/src/release-capabilities.ts';
import { providerFetch } from './maintenance.ts';
import type {Env} from './index.ts';
import {HttpError} from './http-error.ts';
import {googleCapability,googleHash} from './google-connection.ts';
import {encryptIntegration,decryptIntegration} from './integration-crypto.ts';
import {pickerInput,pickerFields,pickerProvider} from './google-drive-picker.ts';
import {preservedDriveSource,samePreservedDriveSource,type PreservedDriveSource} from './documentation-drive-source.ts';
import {preservedCopyQuery,reconcilePreservedCopy,verifyPreservedCopy} from './documentation-drive-copy.ts';
import {artifactFileColumns,artifactPreservedColumns} from './documentation-artifacts.ts';
import {readOriginalBytes,documentCompute,validatedOriginalMetadata,validatedOriginalChunk} from './documentation-upload.ts';
type Row=Record<string,any>;
type Actor={userId:string;expiresAt:number};
const columns=['installation_id','id','author_user_id','request_hash','key_hash','title','caption','source_id','source_version','source_json','resource_ciphertext','resource_iv','activities_json','initiatives_json','section_revision','root_id','root_revision','connection_generation','connection_iv','state','dispatched','file_id','file_version','copied_at','compute_id','manifest_digest','snapshot_digest','validation_outcome','lease_token','lease_expires_ms','artifact_id','error_code','created_at','updated_at'];
export const driveCopyColumns={documentation_drive_copy_operations:columns};
async function computeJson(response:Response){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readOriginalBytes(response,16384))) as Row;}catch{return fail(503,'Original validation response unavailable');}}
const prefix='https://www.googleapis.com/drive/v3/files',chunkSize=262144;
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function fail(status=409,message='Preserved copy needs reconciliation; read its status before continuing'):never{throw new HttpError(status,message);}
const staff="EXISTS(SELECT 1 FROM users u JOIN platform_module_configuration c ON c.installation_id=u.installation_id LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id='primary' AND u.id=? AND u.active=1 AND c.hours_enabled=1 AND c.documentation_enabled=1 AND (u.role='admin' OR (u.role='staff' AND g.documentation_manage=1)))";
const ownership="EXISTS(SELECT 1 FROM google_drive_storage s JOIN google_connections c ON c.installation_id=s.installation_id WHERE s.installation_id=o.installation_id AND s.root_id=o.root_id AND s.revision=o.root_revision AND s.generation=o.connection_generation AND s.verified_iv=o.connection_iv AND c.active_iv=o.connection_iv AND c.grant_error IS NOT 'revoked')";
const eligibility=`COALESCE((SELECT files_enabled FROM documentation_sections WHERE installation_id=o.installation_id),1)=1 AND COALESCE((SELECT revision FROM documentation_sections WHERE installation_id=o.installation_id),0)=o.section_revision
 AND NOT EXISTS(SELECT 1 FROM json_each(o.activities_json) j WHERE NOT EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=o.installation_id AND id=json_extract(j.value,'$.activityId') AND revision=json_extract(j.value,'$.revision') AND archived=0 AND impact_relevant=1))
 AND NOT EXISTS(SELECT 1 FROM json_each(o.initiatives_json) j WHERE NOT EXISTS(SELECT 1 FROM documentation_initiatives WHERE installation_id=o.installation_id AND id=json_extract(j.value,'$.initiativeId') AND revision=json_extract(j.value,'$.revision') AND archived=0))`;
function links(value:unknown,key:string){if(!Array.isArray(value)||value.length>100)fail(400);for(const v of value)if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!==[key,'revision'].sort().join(',')||!id(v[key])||!integer(v.revision))fail(400);if(new Set(value.map(v=>v[key])).size!==value.length)fail(400);return value;}
const status=(o:Row)=>({reference:o.id,title:o.title,state:o.state,saved:o.state==='saved',artifactId:o.artifact_id,requiresReconciliation:Boolean(o.dispatched&&o.state!=='saved'),...(o.error_code?{error:o.error_code}:{})});
const source=(o:Row):PreservedDriveSource=>JSON.parse(o.source_json);
async function current(env:Env,o:Row,actor:Actor,eligible=true){if(actor.expiresAt<=Date.now()||!await env.DB!.prepare(`SELECT 1 FROM documentation_drive_copy_operations o WHERE o.installation_id='primary' AND o.id=? AND ${staff} AND ${ownership} ${eligible?'AND '+eligibility:''} AND (? IS NULL OR (o.lease_token=? AND o.lease_expires_ms>?))`).bind(o.id,actor.userId,o.lease_token??null,o.lease_token??null,Date.now()).first())fail();}
async function save(env:Env,o:Row,changes:Row){const keys=Object.keys(changes),result=await env.DB!.prepare(`UPDATE documentation_drive_copy_operations SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE installation_id='primary' AND id=? AND lease_token=? AND lease_expires_ms>?`).bind(...keys.map(k=>changes[k]),new Date().toISOString(),o.id,o.lease_token,Date.now()).run();if(result.meta?.changes!==1)fail();Object.assign(o,changes);}
async function headers(env:Env,o:Row,actor:Actor,forSource=false){await current(env,o,actor,false);const cap=await googleCapability(env,'drive');if(cap.signature!==o.connection_iv||cap.generation!==o.connection_generation)fail();const token=await cap.accessToken();await current(env,o,actor,false);const h:Record<string,string>={authorization:'Bearer '+token};if(forSource&&o.resource_ciphertext){const value=await decryptIntegration(o.resource_ciphertext,o.resource_iv,env.INTEGRATION_KEY!);if(value.operation!==o.id||value.installation!=='primary')fail();h['x-goog-drive-resource-keys']=o.source_id+'/'+value.resourceKey;}return h;}
async function metadata(env:Env,o:Row,actor:Actor,file:string,forSource=false){return pickerProvider(prefix+'/'+file+'?fields=id,name,mimeType,version,size,sha256Checksum,trashed,ownedByMe,driveId,parents,appProperties,capabilities(canCopy,canAddChildren)',{headers:await headers(env,o,actor,forSource)}, env);}
async function permissions(env:Env,o:Row,actor:Actor,file:string){return pickerProvider(prefix+'/'+file+'/permissions?fields=permissions(type,role,deleted),nextPageToken&pageSize=100',{headers:await headers(env,o,actor)}, env);}
async function privateRoot(env:Env,o:Row,actor:Actor){const f=await metadata(env,o,actor,o.root_id),p=await permissions(env,o,actor,o.root_id);if(f.id!==o.root_id||f.mimeType!=='application/vnd.google-apps.folder'||f.trashed!==false||f.ownedByMe!==true||f.driveId||(f.capabilities as Row)?.canAddChildren!==true||p.nextPageToken||!Array.isArray(p.permissions)||p.permissions.length!==1||(p.permissions[0] as Row).type!=='user'||(p.permissions[0] as Row).role!=='owner'||(p.permissions[0] as Row).deleted===true)fail();}
async function checkSource(env:Env,o:Row,actor:Actor){const before=source(o),after=preservedDriveSource(await metadata(env,o,actor,o.source_id,true),o.source_id);if(!samePreservedDriveSource({...before,sha256:after.sha256===undefined?undefined:before.sha256},after))fail(409,'Source changed; reconcile the existing operation');return after;}
const hashBytes=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('');
async function media(env:Env,o:Row,actor:Actor,file:string,forSource=false){const r=await providerFetch(env)(prefix+'/'+file+'?alt=media',{headers:await headers(env,o,actor,forSource),redirect:'manual',signal:AbortSignal.timeout(10000)});if(!r.ok){void r.body?.cancel();fail();}const bytes=await readOriginalBytes(r,4194304);if(bytes.length!==source(o).byteLength)fail();return bytes;}
const computeRow=(o:Row)=>({...o,mime:source(o).mime,byte_length:source(o).byteLength,sha256:source(o).sha256});

async function admit(request:Request,env:Env,actor:Actor,input:Row){
 pickerFields(input,['sourceIntentId','title','caption','activities','initiatives','sectionRevision','idempotencyKey']);
 if(!id(input.sourceIntentId)||!id(input.idempotencyKey)||input.idempotencyKey.length<16||typeof input.title!=='string'||!input.title.trim()||input.title.length>200||typeof(input.caption??'')!=='string'||(input.caption??'').length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.title+(input.caption??''))||!integer(input.sectionRevision))fail(400);
 const activities=links(input.activities??[],'activityId'),initiatives=links(input.initiatives??[],'initiativeId');if(activities.length+initiatives.length>100)fail(400);
 const requestHash=await googleHash(JSON.stringify([actor.userId,input])),keyHash=await googleHash(input.idempotencyKey),db=env.DB!;
 const existing=await db.prepare("SELECT * FROM documentation_drive_copy_operations WHERE installation_id='primary' AND author_user_id=? AND key_hash=?").bind(actor.userId,keyHash).first<Row>();if(existing){if(existing.request_hash!==requestHash)fail(409,'Idempotency key already used for another request');return status(existing);}
 const session=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lancerlogin_session='))?.slice('lancerlogin_session='.length);if(!session)fail(401);
 const sessionHash=await googleHash(session),intent=await db.prepare("SELECT * FROM google_picker_intents WHERE installation_id='primary' AND id=? AND actor_user_id=? AND session_hash=? AND purpose='documentation-source' AND status='selected' AND expires_at>?").bind(input.sourceIntentId,actor.userId,sessionHash,Date.now()).first<Row>();if(!intent)fail(409,'Select the source again with Picker');
 const selected=await decryptIntegration(intent.ciphertext,intent.iv,env.INTEGRATION_KEY!);if(selected.installation!=='primary'||selected.purpose!=='drive-picker')fail();
 const src=preservedDriveSource({id:selected.fileId,name:selected.name,mimeType:selected.mime,version:selected.version,trashed:false,capabilities:{canCopy:true},size:selected.size,...(selected.checksum?{sha256Checksum:selected.checksum}:{})},selected.fileId);
 const cap=await googleCapability(env,'drive'),root=await db.prepare("SELECT s.* FROM google_drive_storage s JOIN google_connections c ON c.installation_id=s.installation_id WHERE s.installation_id='primary' AND s.verified_iv=? AND s.generation=? AND c.revision=?").bind(cap.signature,cap.generation,intent.connection_revision).first<Row>();if(!root||intent.generation!==cap.generation)fail(409,'Verify the original private storage connection');
 const op=crypto.randomUUID(),now=new Date().toISOString(),encrypted=selected.resourceKey?await encryptIntegration({installation:'primary',operation:op,resourceKey:selected.resourceKey},env.INTEGRATION_KEY!):null;
 const o:Row=Object.fromEntries(columns.map(k=>[k,null]));Object.assign(o,{installation_id:'primary',id:op,author_user_id:actor.userId,request_hash:requestHash,key_hash:keyHash,title:input.title,caption:input.caption??'',source_id:src.id,source_version:src.version,source_json:JSON.stringify(src),resource_ciphertext:encrypted?.ciphertext??null,resource_iv:encrypted?.iv??null,activities_json:JSON.stringify(activities),initiatives_json:JSON.stringify(initiatives),section_revision:input.sectionRevision,root_id:root.root_id,root_revision:root.revision,connection_generation:cap.generation,connection_iv:cap.signature,state:'ready',dispatched:0,lease_expires_ms:0,created_at:now,updated_at:now});
 await db.batch([
  db.prepare(`INSERT INTO documentation_drive_copy_operations(${columns.join(',')}) SELECT ${columns.map(()=>'?').join(',')} WHERE ${staff} AND EXISTS(SELECT 1 FROM google_picker_intents WHERE installation_id='primary' AND id=? AND iv=? AND actor_user_id=? AND session_hash=? AND purpose='documentation-source' AND status='selected' AND expires_at>?) AND (SELECT COUNT(*) FROM documentation_drive_copy_operations WHERE installation_id='primary' AND created_at>=?)<500`).bind(...columns.map(k=>o[k]),actor.userId,intent.id,intent.iv,actor.userId,sessionHash,Date.now(),new Date(Date.now()-86400000).toISOString()),
  db.prepare(`DELETE FROM documentation_drive_copy_operations AS o WHERE installation_id='primary' AND id=? AND NOT (${ownership} AND ${eligibility})`).bind(op),
  db.prepare("DELETE FROM google_picker_intents WHERE installation_id='primary' AND id=? AND EXISTS(SELECT 1 FROM documentation_drive_copy_operations WHERE installation_id='primary' AND id=?)").bind(intent.id,op)
 ]);
 if(!await db.prepare("SELECT 1 FROM documentation_drive_copy_operations WHERE installation_id='primary' AND id=?").bind(op).first())fail(409,'Source, settings, association or authority changed');return status(o);
}

async function commit(env:Env,o:Row,actor:Actor){
 await current(env,o,actor);const db=env.DB!,src=source(o),url='https://drive.google.com/file/d/'+o.file_id+'/view',now=new Date().toISOString(),audit=crypto.randomUUID();
 const cols=[...artifactFileColumns,...artifactPreservedColumns],values=['preserved-drive',o.file_id,o.root_id,o.connection_generation,src.sha256??null,src.byteLength??null,src.mime,o.validation_outcome,src.id,src.version,o.copied_at,o.file_version];
 const admitted="EXISTS(SELECT 1 FROM audit_log WHERE installation_id='primary' AND id=?)";
 const statements=[db.prepare(`INSERT INTO documentation_artifacts(installation_id,id,title,caption,url,original_url,author_user_id,source,created_at,updated_at,${cols.join(',')}) SELECT 'primary',o.id,o.title,o.caption,?,?,o.author_user_id,'staff',?,?,${cols.map(()=>'?').join(',')} FROM documentation_drive_copy_operations o WHERE o.installation_id='primary' AND o.id=? AND o.lease_token=? AND o.lease_expires_ms>? AND ${staff} AND ${ownership} AND ${eligibility}`).bind(url,url,now,now,...values,o.id,o.lease_token,Date.now(),actor.userId),
 db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,'primary',?,'documentation.drive-copy.preserved','documentation_artifact',?,? WHERE changes()=1").bind(audit,actor.userId,o.id,now),
 db.prepare(`INSERT INTO documentation_artifact_revisions(installation_id,artifact_id,revision,actor_user_id,title,caption,url,original_url,archived,created_at,${cols.join(',')}) SELECT installation_id,id,0,author_user_id,title,caption,url,original_url,0,created_at,${cols.join(',')} FROM documentation_artifacts WHERE installation_id='primary' AND id=? AND ${admitted}`).bind(o.id,audit)];
 for(const [kind,key] of [['activities','activity'],['initiatives','initiative']])statements.push(db.prepare(`INSERT INTO documentation_artifact_${kind}(installation_id,artifact_id,${key}_id) SELECT 'primary',?,json_extract(value,'$.${key}Id') FROM json_each(?) WHERE ${admitted}`).bind(o.id,o[kind+'_json'],audit),db.prepare(`INSERT INTO documentation_artifact_revision_${kind}(installation_id,artifact_id,revision,${key}_id) SELECT installation_id,artifact_id,0,${key}_id FROM documentation_artifact_${kind} WHERE installation_id='primary' AND artifact_id=? AND ${admitted}`).bind(o.id,audit));
 statements.push(db.prepare(`UPDATE documentation_drive_copy_operations SET state='saved',artifact_id=id,resource_ciphertext=NULL,resource_iv=NULL,error_code=NULL,updated_at=? WHERE installation_id='primary' AND id=? AND lease_token=? AND ${admitted}`).bind(now,o.id,o.lease_token,audit));
 const result=await db.batch(statements);if(result[1].meta?.changes!==1)fail();o.state='saved';o.artifact_id=o.id;
}

async function advance(env:Env,o:Row,actor:Actor){
 if(o.state==='saved')return status(o);await current(env,o,actor,false);const now=Date.now(),lease=crypto.randomUUID();
 const claim=await env.DB!.prepare(`UPDATE documentation_drive_copy_operations AS o SET lease_token=?,lease_expires_ms=? WHERE installation_id='primary' AND id=? AND lease_expires_ms<=? AND ${staff} AND ${ownership}`).bind(lease,Math.min(now+120000,actor.expiresAt),o.id,now,actor.userId).run();if(claim.meta?.changes!==1)fail(409,'Copy is advancing; read its status');
 o=(await env.DB!.prepare("SELECT * FROM documentation_drive_copy_operations WHERE installation_id='primary' AND id=? AND lease_token=?").bind(o.id,lease).first<Row>())!;
 try{
  if(o.state==='failed')fail(409,'This intake requires a new explicit selection');
  await privateRoot(env,o,actor);
  if(!o.dispatched){
   await current(env,o,actor);await checkSource(env,o,actor);let src=source(o);
   if(!src.native&&!o.validation_outcome){
    if(!o.compute_id){
     const bytes=await media(env,o,actor,o.source_id,true),sha256=await hashBytes(bytes);if(src.sha256&&src.sha256!==sha256)fail();src={...src,sha256};await checkSource(env,o,actor);
     const computeId=Date.now()+'-'+crypto.randomUUID(),snapshot=await googleHash(JSON.stringify([o.id,o.request_hash,o.root_id,o.connection_generation]));
     await save(env,o,{source_json:JSON.stringify(src),compute_id:computeId,snapshot_digest:snapshot,state:'validating'});
    }
    if(!o.manifest_digest){
     src=source(o);const manifest={version:1,id:o.compute_id,operation:'validate-artifact',policyVersion:'document-input-v1',snapshotDigest:o.snapshot_digest,items:[{id:'original',revision:'1',caption:'',url:'https://drive.google.com/',type:src.mime,byteLength:src.byteLength,sha256:src.sha256,...(src.mime==='application/pdf'?{selectedPages:[1]}:{})}]};
     const response=await documentCompute(env,'/jobs','POST',JSON.stringify(manifest),{'content-type':'application/json'}),result=await computeJson(response);if(result.id!==o.compute_id||!hex(result.manifestDigest))fail();await save(env,o,{manifest_digest:result.manifestDigest});
    }
    const response=await documentCompute(env,'/jobs/'+o.compute_id),result=await computeJson(response);if(result.id!==o.compute_id||result.manifestDigest!==o.manifest_digest)fail();
    if(result.state==='failed'){await save(env,o,{state:'failed',error_code:'INPUT_REJECTED'});return status(o);}
    if(result.state==='complete'){
     const m=await validatedOriginalMetadata(env,computeRow(o)),whole=new Uint8Array(src.byteLength!);for(let n=0;n<m.chunkCount;n++)whole.set(await validatedOriginalChunk(env,computeRow(o),m,n),n*chunkSize);if(await hashBytes(whole)!==src.sha256)fail();await save(env,o,{validation_outcome:m.outcome,state:'ready'});return status(o);
    }
    if(result.state==='staging'){
     const bytes=await media(env,o,actor,o.source_id,true);if(await hashBytes(bytes)!==source(o).sha256)fail();await checkSource(env,o,actor);
     for(let n=0;n<Math.ceil(bytes.length/chunkSize);n++)await documentCompute(env,'/jobs/'+o.compute_id+'/items/0/chunks/'+n,'PUT',bytes.slice(n*chunkSize,(n+1)*chunkSize) as BodyInit,{'content-type':'application/octet-stream'});
     await documentCompute(env,'/jobs/'+o.compute_id+'/seal','POST');
    }
    return status(o);
   }
   await current(env,o,actor);await checkSource(env,o,actor);
   // Durable dispatch is irreversible locally: every subsequent request searches this marker only.
   await save(env,o,{dispatched:1,state:'reconciling'});
   const copied=await pickerProvider(prefix+'/'+o.source_id+'/copy?fields=id',{method:'POST',headers:{...await headers(env,o,actor,true),'content-type':'application/json'},body:JSON.stringify({name:o.title,parents:[o.root_id],appProperties:{lancerloginDocumentationCopy:o.id}})}, env);if(!id(copied.id))fail();await save(env,o,{file_id:copied.id});
  }
  if(!o.file_id){const found=await pickerProvider(prefix+'?q='+encodeURIComponent(preservedCopyQuery(o.id,o.root_id))+'&fields=files(id,parents,trashed,appProperties),nextPageToken,incompleteSearch&pageSize=2',{headers:await headers(env,o,actor)}, env);await save(env,o,{file_id:reconcilePreservedCopy(found,o.id,o.root_id)});}
  await checkSource(env,o,actor);const copied=await metadata(env,o,actor,o.file_id),src=source(o);
  if(!src.native&&copied.sha256Checksum===undefined){const bytes=await media(env,o,actor,o.file_id);copied.sha256Checksum=await hashBytes(bytes);}
  const verified=verifyPreservedCopy(copied,await permissions(env,o,actor,o.file_id),o.file_id,o.id,o.root_id,src);
  await save(env,o,{file_version:verified.version,copied_at:o.copied_at??new Date().toISOString(),validation_outcome:src.native?'native':o.validation_outcome});
  await privateRoot(env,o,actor);await current(env,o,actor);await commit(env,o,actor);return status(o);
 }catch(error){if(o.dispatched&&o.state!=='saved')await save(env,o,{state:'reconciling',error_code:'REMOTE_RESULT_UNKNOWN'}).catch(()=>{});throw error;}
 finally{await env.DB!.prepare("UPDATE documentation_drive_copy_operations SET lease_token=NULL,lease_expires_ms=0 WHERE installation_id='primary' AND id=? AND lease_token=?").bind(o.id,lease).run();}
}

export async function driveCopyRoute(request:Request,env:Env,actor:Actor){
 if(!documentationAvailable)throw new HttpError(404,'Activity Documentation is unavailable in this release');
 if(!env.DB||!env.INTEGRATION_KEY)fail(503);if(actor.expiresAt<=Date.now()||!await env.DB.prepare('SELECT 1 WHERE '+staff).bind(actor.userId).first())fail(403);
 const url=new URL(request.url),path=url.pathname.slice('/admin/documentation/drive-copies'.length),reply=(body:unknown,code=200)=>Response.json(body,{status:code,headers:{'cache-control':'no-store'}});
 if(!path&&request.method==='GET'){const after=url.searchParams.get('after')??'',limit=Number(url.searchParams.get('limit')??25);if(!/^\??(?:(?:after|limit)=[^&]*&?)*$/.test(url.search)||after&&!id(after)||!Number.isInteger(limit)||limit<1||limit>50)fail(400);const rows=(await env.DB.prepare(`SELECT * FROM documentation_drive_copy_operations WHERE installation_id='primary' AND id>? AND ${staff} ORDER BY id LIMIT ?`).bind(after,actor.userId,limit+1).all<Row>()).results??[];return reply({operations:rows.slice(0,limit).map(status),next:rows.length>limit?rows[limit-1].id:null});}
 if(url.search)fail(400);if(!path&&request.method==='POST')return reply(await admit(request,env,actor,await pickerInput(request)),202);
 const match=/^\/([A-Za-z0-9_-]{1,128})(?:\/(advance|reconcile))?$/.exec(path);if(!match)fail(404);const o=await env.DB.prepare(`SELECT * FROM documentation_drive_copy_operations WHERE installation_id='primary' AND id=? AND ${staff}`).bind(match[1],actor.userId).first<Row>();if(!o)fail(404);
 if(!match[2]&&request.method==='GET')return reply(status(o));if(!match[2]||request.method!=='POST')fail(405);pickerFields(await pickerInput(request),[]);
 // Reconciliation retains the original generation/root. Connection replacement cannot silently adopt a different owner.
 if(match[2]==='reconcile'){const cap=await googleCapability(env,'drive'),root=await env.DB.prepare("SELECT * FROM google_drive_storage WHERE installation_id='primary' AND root_id=? AND generation=? AND verified_iv=?").bind(o.root_id,o.connection_generation,cap.signature).first<Row>();if(!root||cap.generation!==o.connection_generation)fail();await env.DB.prepare(`UPDATE documentation_drive_copy_operations SET connection_iv=?,root_revision=? WHERE installation_id='primary' AND id=? AND lease_expires_ms<=? AND ${staff} AND EXISTS(SELECT 1 FROM google_drive_storage WHERE installation_id='primary' AND root_id=? AND revision=? AND verified_iv=?)`).bind(cap.signature,root.revision,o.id,Date.now(),actor.userId,o.root_id,root.revision,cap.signature).run();o.connection_iv=cap.signature;o.root_revision=root.revision;}
 return reply(await advance(env,o,actor),202);
}

export function prepareDriveCopyRestore(tables:Record<string,Row[]>,restoring=true){
 const bad=()=>fail(400,'Invalid preserved Drive inventory backup'),seen=new Set<string>(),files=new Set<string>(),artifacts=new Map((tables.documentation_artifacts??[]).map(a=>[a.id,a])),users=new Set((tables.users??[]).map(u=>u.id));
 for(const o of tables.documentation_drive_copy_operations??[]){
  if(Object.keys(o).sort().join(',')!==[...columns].sort().join(',')||o.installation_id!=='primary'||!id(o.id)||seen.has(o.id)||!users.has(o.author_user_id)||!hex(o.request_hash)||!hex(o.key_hash)||!id(o.source_id)||!id(o.root_id)||!integer(o.root_revision)||!integer(o.section_revision)||typeof o.connection_generation!=='string'||!o.connection_generation||typeof o.connection_iv!=='string'||!integer(o.lease_expires_ms)||![0,1].includes(o.dispatched)||!['ready','validating','reconciling','saved','failed'].includes(o.state)||typeof o.title!=='string'||!o.title.trim()||o.title.length>200||typeof o.caption!=='string'||o.caption.length>4000||typeof o.created_at!=='string'||!Number.isFinite(Date.parse(o.created_at))||typeof o.updated_at!=='string'||!Number.isFinite(Date.parse(o.updated_at))||Date.parse(o.updated_at)<Date.parse(o.created_at)||(o.resource_ciphertext===null)!==(o.resource_iv===null)||o.file_id!==null&&(!id(o.file_id)||files.has(o.file_id)||!o.dispatched))bad();
  seen.add(o.id);if(o.file_id)files.add(o.file_id);
  let src:PreservedDriveSource;try{src=source(o);const canonical=preservedDriveSource({id:src.id,name:src.name,mimeType:src.mime,version:src.version,trashed:false,capabilities:{canCopy:true},...(src.native?{}:{size:String(src.byteLength),...(src.sha256?{sha256Checksum:src.sha256}:{})})},o.source_id);if(JSON.stringify(canonical)!==JSON.stringify(src)||src.version!==o.source_version)bad();}catch{return bad();}
  let activities:Row[],initiatives:Row[];try{activities=links(JSON.parse(o.activities_json),'activityId');initiatives=links(JSON.parse(o.initiatives_json),'initiativeId');}catch{return bad();}if(activities.length+initiatives.length>100)bad();
  if(activities.some(a=>!(tables.hours_activities??[]).some(r=>r.id===a.activityId))||initiatives.some(a=>!(tables.documentation_initiatives??[]).some(r=>r.id===a.initiativeId)))bad();
  if(o.validation_outcome!==null&&!['native','embedded','linked-only'].includes(o.validation_outcome)||src.native&&o.validation_outcome!==null&&o.validation_outcome!=='native'||!src.native&&o.validation_outcome==='native'||o.manifest_digest!==null&&!hex(o.manifest_digest)||o.snapshot_digest!==null&&!hex(o.snapshot_digest)||o.compute_id!==null&&(typeof o.compute_id!=='string'||!/^\d{13}-[a-f0-9-]{36}$/.test(o.compute_id)))bad();
  if(o.state==='saved'){
   const a=artifacts.get(o.artifact_id);if(!o.dispatched||!a||a.kind!=='preserved-drive'||a.file_id!==o.file_id||a.file_root_id!==o.root_id||a.file_generation!==o.connection_generation||a.file_source_id!==o.source_id||a.file_source_version!==o.source_version||a.file_version!==o.file_version||a.file_copied_at!==o.copied_at||a.file_mime!==src.mime||a.file_size!==(src.byteLength??null)||a.file_sha256!==(src.sha256??null)||a.validation_outcome!==o.validation_outcome||a.author_user_id!==o.author_user_id||a.source!=='staff'||a.url!=='https://drive.google.com/file/d/'+o.file_id+'/view'||a.original_url!==a.url)bad();
  }else if(o.artifact_id!==null)bad();
  if(restoring){o.resource_ciphertext=null;o.resource_iv=null;o.lease_token=null;o.lease_expires_ms=0;if(o.state!=='saved'){o.state=o.dispatched?'reconciling':'failed';o.error_code='RESTORE_RECONCILIATION_REQUIRED';}}
 }
 for(const a of artifacts.values())if(a.kind==='preserved-drive'&&!(tables.documentation_drive_copy_operations??[]).some(o=>o.state==='saved'&&o.artifact_id===a.id))bad();
}

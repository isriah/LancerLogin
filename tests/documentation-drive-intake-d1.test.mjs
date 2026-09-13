import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import worker from '../apps/api/src/index.ts';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {googleHash} from '../apps/api/src/google-connection.ts';
import {createSessionCodec,hashPassword} from '../apps/api/src/runtime-security.ts';
import {prepareDriveCopyRestore} from '../apps/api/src/documentation-drive-intake.ts';
const sha=b=>createHash('sha256').update(b).digest('hex');
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('Drive copy intake preserves native provenance and reconciles uncertain dispatch without duplicate copies',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']})),priorFetch=globalThis.fetch;
 try{
  const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local')"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic Team','UTC')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01'),('docs','primary','synthetic-docs','staff','2026-01-01'),('hours','primary','synthetic-hours','staff','2026-01-01'),('operator','primary','synthetic-operator','operator','2026-01-01')"),
   db.prepare("INSERT INTO platform_module_configuration VALUES('primary',1,1,1)"),db.prepare("INSERT INTO platform_module_grants VALUES('primary','docs',0,1),('primary','hours',1,0)"),db.prepare("INSERT INTO hours_entry_settings(installation_id) VALUES('primary')")
  ]);
  await db.prepare("UPDATE users SET password_hash=? WHERE id='admin'").bind(await hashPassword('synthetic recovery password')).run();
  const connection={clientId:'synthetic-client',clientSecret:'synthetic-secret',loginEnabled:false,calendarEnabled:false,driveEnabled:true,generation:'generation',loginProof:false,organizationProof:true,calendarProof:false,legacyFingerprint:'[null,null,{}]',grant:{proofId:'proof',refreshToken:'synthetic-refresh',subject:'synthetic',scopes:['https://www.googleapis.com/auth/drive.file']}};
  const encrypted=await encryptIntegration({payload:JSON.stringify(connection),installation:'primary',slot:'active'},secret);
  await db.prepare("INSERT INTO google_connections(installation_id,active_ciphertext,active_iv,revision,updated_at,shared_mode,grant_proof_id) VALUES('primary',?,?,1,'2026-01-01',1,'proof')").bind(encrypted.ciphertext,encrypted.iv).run();
  await db.prepare("INSERT INTO google_drive_storage VALUES('primary',1,'root','Synthetic root','generation',?,'2026-01-01')").bind(encrypted.iv).run();
  const original=Buffer.from('Synthetic binary original'),jobs=new Map();let rejectInput=false;
  const compute={async fetch(request){const p=new URL(request.url).pathname;if(p==='/jobs'){const manifest=await request.json();if(!jobs.has(manifest.id))jobs.set(manifest.id,{manifest,state:'staging',chunks:new Map()});return Response.json({id:manifest.id,manifestDigest:sha(JSON.stringify(manifest))});}const id=p.split('/')[2],job=jobs.get(id),m=job.manifest,manifestDigest=sha(JSON.stringify(m));if(request.method==='PUT'){job.chunks.set(p.split('/').at(-1),Buffer.from(await request.arrayBuffer()));return Response.json({id});}if(p.endsWith('/seal')){assert.deepEqual(Buffer.concat([...job.chunks.values()]),original);job.state=rejectInput?'failed':'complete';return Response.json({id,state:job.state});}if(p.endsWith('/original'))return Response.json({jobId:id,itemIndex:0,id:'original',revision:'1',type:m.items[0].type,byteLength:original.length,sha256:sha(original),chunkSize:262144,chunkCount:1,chunkSha256:[sha(original)],manifestDigest,snapshotDigest:m.snapshotDigest,policyVersion:'document-input-v1',outcome:'linked-only',expiresAt:Date.now()+100000});if(p.endsWith('/original/chunks/0'))return new Response(original,{headers:{'content-type':'application/octet-stream','content-length':String(original.length),'x-document-item-index':'0','x-document-chunk-index':'0','x-document-byte-offset':'0','x-document-sha256':sha(original),'x-document-chunk-sha256':sha(original),'x-document-manifest-sha256':manifestDigest,'x-document-snapshot-sha256':m.snapshotDigest}});return Response.json({id,manifestDigest,state:job.state});}};
  const env={DOCUMENT_COMPUTE:compute,DB:db,INTEGRATION_KEY:secret,SESSION_KEY:secret,ALLOWED_ORIGIN:'https://fixture.test',APP_MODE:'configured'},sessions={};for(const [user,role] of [['docs','staff'],['admin','admin'],['hours','staff'],['operator','operator']])sessions[user]=await createSessionCodec(secret).issue({userId:user,role});
  const call=(path,input,user='docs',method=input?'POST':'GET')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+sessions[user],...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})}),env);
  const base='/admin/documentation/drive-copies',native={id:'source',name:'Synthetic original',mimeType:'application/vnd.google-apps.presentation',version:'7',trashed:false,capabilities:{canCopy:true}};let copies=0,loseAck=false,matchCount=1;const remote=new Map();
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(url);if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'synthetic-token'});
   assert.equal(u.hostname,'www.googleapis.com');const p=u.pathname;if(u.searchParams.get('alt')==='media')return new Response(original);
   if(p.endsWith('/permissions'))return Response.json({permissions:[{type:'user',role:'owner'}]});
   if(p.endsWith('/source/copy')){copies++;const body=JSON.parse(init.body),id='copy-'+copies;remote.set(id,{id,name:body.name,mimeType:native.mimeType,version:'1',trashed:false,ownedByMe:true,parents:body.parents,appProperties:body.appProperties,...(native.size?{size:native.size,sha256Checksum:native.sha256Checksum}:{})});if(loseAck)throw Error('synthetic lost acknowledgement');return Response.json({id});}
   if(p.endsWith('/source'))return Response.json(native);
   if(p.endsWith('/root'))return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',trashed:false,ownedByMe:true,capabilities:{canAddChildren:true}});
   if(p==='/drive/v3/files'){const query=u.searchParams.get('q'),matches=[...remote.values()].filter(f=>query.includes(f.appProperties.lancerloginDocumentationCopy));return Response.json({files:matchCount===0?[]:matchCount===2?[...matches,...matches]:matches});}
   if(remote.has(p.split('/').at(-1)))return Response.json(remote.get(p.split('/').at(-1)));
   throw Error('Unexpected fake provider path '+p);
  };
  let serial=0;
  const selection=async(purpose='documentation-source')=>{const id='intent-'+(++serial),seal=await encryptIntegration({installation:'primary',purpose:'drive-picker',fileId:'source',name:native.name,mime:native.mimeType,version:native.version,resourceKey:'synthetic-resource-key',size:String(native.size??''),checksum:native.sha256Checksum??''},secret);await db.prepare("INSERT INTO google_picker_intents VALUES('primary',?,?,?,?,?,1,?,'selected',?,?,?)").bind(id,await googleHash(id),'docs',await googleHash(sessions.docs),'generation',purpose,Date.now()+600000,seal.ciphertext,seal.iv).run();return {sourceIntentId:id,title:'Synthetic preserved evidence',caption:'',sectionRevision:0,activities:[],initiatives:[],idempotencyKey:'synthetic-intake-key-'+serial};};
  const body=await selection();assert.equal((await call(base,body,'hours')).status,403);assert.equal((await call(base,body,'operator')).status,403);
  assert.equal((await call(base,{...body,sectionRevision:1})).status,409);
  assert.equal((await call(base,body,'admin')).status,409);
  const other=await call(base,{...body,sourceIntentId:(await selection('source')).sourceIntentId});assert.equal(other.status,409);
  const admission=await call(base,body);assert.equal(admission.status,202,await admission.clone().text());const op=await admission.json();assert.equal((await (await call(base,body)).json()).reference,op.reference);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM google_picker_intents WHERE id=?').bind(body.sourceIntentId).first()).n,0);
  await db.prepare("UPDATE google_drive_storage SET revision=2 WHERE installation_id='primary'").run();assert.equal((await call(base+'/'+op.reference+'/advance',{})).status,409);assert.equal(copies,0);await db.prepare("UPDATE google_drive_storage SET revision=1 WHERE installation_id='primary'").run();
  native.version='8';assert.equal((await call(base+'/'+op.reference+'/advance',{})).status,409);assert.equal(copies,0);native.version='7';
  let result=await call(base+'/'+op.reference+'/advance',{});assert.equal(result.status,202,await result.clone().text());assert.equal((await result.json()).saved,true);assert.equal(copies,1);
  const detail=await (await call('/admin/documentation/artifacts/'+op.reference)).json();assert.equal(detail.artifact.kind,'preserved-drive');assert.equal(detail.artifact.preservedDrive.validation.outcome,'native');assert.ok(!Object.hasOwn(detail.artifact.preservedDrive,'sha256'));
  assert.equal((await call('/admin/documentation/artifacts/'+op.reference,{revision:0,sectionRevision:0,url:'https://example.invalid/replace'},'docs','PATCH')).status,400);
  result=await call('/admin/documentation/artifacts/'+op.reference,{revision:0,sectionRevision:0,title:'Updated caption label'},'docs','PATCH');assert.equal(result.status,200,await result.clone().text());
  const history=await (await call('/admin/documentation/artifacts/'+op.reference+'/history')).json();assert.equal(history.revisions.length,2);assert.deepEqual(history.revisions[0].preservedDrive,history.revisions[1].preservedDrive);
  // Binary originals pass isolated original-byte validation before the only dispatch.
  Object.assign(native,{mimeType:'application/octet-stream',size:String(original.length),sha256Checksum:sha(original)});
  const binaryBody=await selection(),binary=await (await call(base,binaryBody)).json(),beforeBinary=copies;
  for(let phase=0;phase<3;phase++){result=await call(base+'/'+binary.reference+'/advance',{});assert.equal(result.status,202,await result.clone().text());if(phase<2)assert.equal(copies,beforeBinary);}
  const binaryDetail=await (await call('/admin/documentation/artifacts/'+binary.reference)).json();assert.equal(binaryDetail.artifact.preservedDrive.sha256,sha(original));assert.equal(binaryDetail.artifact.preservedDrive.byteLength,original.length);assert.equal(binaryDetail.artifact.preservedDrive.validation.outcome,'linked-only');
  rejectInput=true;const rejected=await (await call(base,await selection())).json(),beforeRejected=copies;await call(base+'/'+rejected.reference+'/advance',{});result=await call(base+'/'+rejected.reference+'/advance',{});assert.equal((await result.json()).state,'failed');assert.equal(copies,beforeRejected);rejectInput=false;
  Object.assign(native,{mimeType:'application/vnd.google-apps.presentation'});delete native.size;delete native.sha256Checksum;
  const backup=await (await call('/admin/data/backup?scope=installation',undefined,'admin')).json();assert.equal(backup.schemaVersion,28);assert.equal(backup.tables.documentation_drive_copy_operations[0].resource_ciphertext,null);prepareDriveCopyRestore(structuredClone(backup.tables));
  const lostBody=await selection(),lost=await (await call(base,lostBody)).json();loseAck=true;assert.equal((await call(base+'/'+lost.reference+'/advance',{})).status,503);assert.equal(copies,3);loseAck=false;
  for(const count of [0,2]){matchCount=count;assert.equal((await call(base+'/'+lost.reference+'/reconcile',{})).status,409);assert.equal(copies,3);}matchCount=1;
  const incomplete=await (await call('/admin/data/backup?scope=installation',undefined,'admin')).json(),restored=structuredClone(incomplete.tables);prepareDriveCopyRestore(restored);assert.equal(restored.documentation_drive_copy_operations.find(o=>o.id===lost.reference).state,'reconciling');
  assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup},'admin')).status,409);
  result=await call(base+'/'+lost.reference+'/reconcile',{});assert.equal(result.status,202,await result.clone().text());assert.equal((await result.json()).saved,true);assert.equal(copies,3);
  assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup},'admin')).status,409);
  const complete=await (await call('/admin/data/backup?scope=installation',undefined,'admin')).json();result=await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:complete},'admin');assert.equal(result.status,200,await result.clone().text());assert.equal(copies,3);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{globalThis.fetch=priorFetch;await mf.dispose();}
});

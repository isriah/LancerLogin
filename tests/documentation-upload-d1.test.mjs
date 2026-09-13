import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {admitUpload,advanceUpload,uploadRoute,prepareUploadRestore,acknowledgedOffset} from '../apps/api/src/documentation-upload.ts';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import worker from '../apps/api/src/index.ts';
import {createSessionCodec,hashPassword} from '../apps/api/src/runtime-security.ts';
import {createHash} from 'node:crypto';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sha=b=>createHash('sha256').update(b).digest('hex');

test('durable binary intake preserves exact originals, private ownership and ambiguous receipts', {timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));const oldFetch=globalThis.fetch;
 try{
  const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic Team','UTC')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01'),('docs','primary','synthetic-docs','staff','2026-01-01'),('hours','primary','synthetic-hours','staff','2026-01-01'),('operator','primary','synthetic-operator','operator','2026-01-01')"),
   db.prepare("INSERT INTO platform_module_configuration VALUES('primary',1,1,1)"),
   db.prepare("INSERT INTO platform_module_grants VALUES('primary','docs',0,1),('primary','hours',1,0)"),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,description,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary','activity','event','event','2026-01-19','Synthetic eligible activity','PRIVATE HOURS DESCRIPTION','UTC',1,'2026-01-01','2026-01-01'),('primary','unrelated','event','event','2026-01-19','Unrelated hours-only','PRIVATE UNRELATED','UTC',0,'2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_entry_settings(installation_id) VALUES('primary')"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member1','primary','00123','PRIVATE','ONE','2026-01-01'),('member2','primary','00456','PRIVATE','TWO','2026-01-01')")
  ]);

 const original=Buffer.alloc(4194304,65),manifestStore=new Map(),chunks=new Map();let activeReads=0,maxReads=0;let computeComplete=false,remoteComplete=false,remoteOffset=0,createCount=0,mediaReads=0,partial=true,loseAck=false;
 const connection={clientId:'synthetic-client',clientSecret:'synthetic-secret',loginEnabled:false,calendarEnabled:false,driveEnabled:true,generation:'generation',loginProof:false,organizationProof:true,calendarProof:false,legacyFingerprint:'[null,null,{}]',grant:{proofId:'proof',refreshToken:'synthetic-refresh',subject:'synthetic',scopes:['https://www.googleapis.com/auth/drive.file']}};
 await db.prepare("UPDATE users SET password_hash=? WHERE id='admin'").bind(await hashPassword('synthetic recovery password')).run();
 const crypt=await encryptIntegration({payload:JSON.stringify(connection),installation:'primary',slot:'active'},secret);
 await db.prepare("INSERT INTO google_connections(installation_id,active_ciphertext,active_iv,revision,updated_at) VALUES('primary',?,?,1,'2026-01-01')").bind(crypt.ciphertext,crypt.iv).run();
 await db.prepare("UPDATE google_connections SET shared_mode=1,grant_proof_id='proof'").run();
 await db.prepare("INSERT INTO google_drive_storage VALUES('primary',1,'root','Synthetic private root','generation',?,'2026-01-01')").bind(crypt.iv).run();
 const compute={async fetch(request){const p=new URL(request.url).pathname;if(p==='/jobs'){const m=await request.json();manifestStore.set(m.id,m);return Response.json({id:m.id,manifestDigest:sha(JSON.stringify(m)),state:'staging'});}const id=p.split('/')[2],m=manifestStore.get(id),manifestDigest=sha(JSON.stringify(m));
 if(request.method==='PUT'){const n=Number(p.split('/').at(-1)),b=Buffer.from(await request.arrayBuffer());if(chunks.has(id+':'+n)&&!chunks.get(id+':'+n).equals(b))return new Response(null,{status:409});chunks.set(id+':'+n,b);return Response.json({id});}
 if(p.endsWith('/seal')){computeComplete=true;return Response.json({id,state:'queued'});}
 if(p.endsWith('/original'))return Response.json({jobId:id,itemIndex:0,id:'original',revision:'1',type:m.items[0].type,byteLength:original.length,sha256:sha(original),chunkSize:262144,chunkCount:Math.ceil(original.length/262144),chunkSha256:Array.from({length:Math.ceil(original.length/262144)},(_,n)=>sha(original.subarray(n*262144,(n+1)*262144))),manifestDigest,snapshotDigest:m.snapshotDigest,policyVersion:'document-input-v1',outcome:'linked-only',expiresAt:Date.now()+100000});
 if(p.includes('/original/chunks/')){activeReads++;maxReads=Math.max(maxReads,activeReads);await new Promise(r=>setTimeout(r,25));activeReads--;const n=Number(p.split('/').at(-1)),b=original.subarray(n*262144,(n+1)*262144);return new Response(b,{headers:{'content-type':'application/octet-stream','content-length':String(b.length),'x-document-item-index':'0','x-document-chunk-index':String(n),'x-document-byte-offset':String(n*262144),'x-document-sha256':sha(original),'x-document-chunk-sha256':sha(b),'x-document-manifest-sha256':manifestDigest,'x-document-snapshot-sha256':m.snapshotDigest}});}
 return Response.json({id,manifestDigest,state:computeComplete?'complete':'staging'});
 }};
 let currentOp;
 globalThis.fetch=async(url,init={})=>{url=String(url);assert.ok(url.startsWith('https://www.googleapis.com/')||url==='https://oauth2.googleapis.com/token');if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-token'});
 if(url.includes('/permissions?'))return Response.json({permissions:[{type:'user',role:'owner'}]});
 if(url.includes('/files/root?'))return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',trashed:false,ownedByMe:true,capabilities:{canAddChildren:true}});
 if(url.includes('generateIds'))return Response.json({ids:['reserved-file']});
 if(url.includes('uploadType=resumable')){if(init.method==='POST'){createCount++;return new Response(null,{headers:{location:'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic'}});}const headers=new Headers(init.headers);if(headers.get('content-range').startsWith('bytes */'))return remoteComplete?Response.json({id:'reserved-file'}):new Response(null,{status:308,headers:remoteOffset?{range:'bytes=0-'+(remoteOffset-1)}:{}});
 const b=Buffer.from(init.body);if(partial){remoteOffset+=7;partial=false;}else remoteOffset+=b.length;remoteComplete=remoteOffset===original.length;if(loseAck){loseAck=false;throw Error('synthetic lost response');}return remoteComplete?Response.json({id:'reserved-file'}):new Response(null,{status:308,headers:{range:'bytes=0-'+(remoteOffset-1)}});}
 if(url.includes('alt=media')){mediaReads++;return new Response(original);}
 if(url.includes('/files/reserved-file?'))return remoteComplete?Response.json({id:'reserved-file',mimeType:'text/plain',size:String(original.length),trashed:false,ownedByMe:true,parents:['root'],appProperties:{lancerloginUpload:currentOp}}):new Response(null,{status:404});
 throw Error('unexpected synthetic provider route');};
 const env={DB:db,APP_MODE:'configured',SESSION_KEY:secret,INTEGRATION_KEY:secret,ALLOWED_ORIGIN:'https://fixture.test',DOCUMENT_COMPUTE:compute};
 const payload={title:'Synthetic original',mime:'text/plain',byteLength:original.length,sha256:sha(original),sectionRevision:0,activities:[{activityId:'activity',revision:0}],idempotencyKey:'synthetic-upload-key'};
 const actor={source:'public',memberId:'member1'},admitted=await admitUpload(env,payload,actor);currentOp=admitted.reference;
 await assert.rejects(()=>uploadRoute(new Request('https://fixture.test/public/documentation/uploads/'+currentOp),env),e=>e.status===403);
 await assert.rejects(()=>admitUpload(env,{...payload,idempotencyKey:'synthetic-staff-denied'}, {source:'staff',userId:'operator',expiresAt:Date.now()+100000}),e=>e.status===409);
 const row=()=>db.prepare('SELECT * FROM documentation_upload_operations WHERE id=?').bind(currentOp).first();
 assert.equal((await admitUpload(env,payload,actor)).reference,currentOp);await assert.rejects(()=>admitUpload(env,{...payload,title:'Changed'},actor),e=>e.status===409);
 await advanceUpload(env,await row(),'chunks/0',original.subarray(0,262144));await advanceUpload(env,await row(),'chunks/0',original.subarray(0,262144));await assert.rejects(async()=>advanceUpload(env,await row(),'chunks/0',Buffer.alloc(262144)),e=>e.status===409);
 for(let n=1;n<Math.ceil(original.length/262144);n++)await advanceUpload(env,await row(),'chunks/'+n,original.subarray(n*262144,(n+1)*262144));await advanceUpload(env,await row(),'seal');assert.equal((await advanceUpload(env,await row(),'advance')).state,'ready');assert.equal(maxReads,4);
 const overlapping=await Promise.allSettled([advanceUpload(env,await row(),'advance'),advanceUpload(env,await row(),'advance')]);assert.equal(overlapping.filter(r=>r.status==='fulfilled').length,1);assert.equal((await row()).state,'preserving');assert.equal(createCount,1);
 await advanceUpload(env,await row(),'advance');assert.equal((await row()).upload_offset,7);
 loseAck=true;await assert.rejects(async()=>advanceUpload(env,await row(),'advance'));assert.equal((await row()).state,'reconciling');
 await assert.rejects(()=>db.prepare("DELETE FROM installations WHERE id='primary'").run(),/documentation_upload_in_flight/);
 for(let i=0;i<20&&(await row()).state!=='saved';i++)await advanceUpload(env,await row(),'advance');assert.equal((await row()).state,'saved');assert.equal(createCount,1);assert.equal(mediaReads,1);
 const a=await db.prepare('SELECT * FROM documentation_artifacts WHERE id=?').bind(currentOp).first();assert.equal(a.kind,'file');assert.equal(a.author_user_id,null);assert.equal(a.author_member_id,'member1');assert.equal(a.file_sha256,sha(original));assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_artifact_revisions WHERE artifact_id=?').bind(currentOp).first()).n,1);

 const session=await createSessionCodec(secret).issue({userId:'admin',role:'admin'}),api=async(path,body)=>worker.fetch(new Request('https://fixture.test'+path,{method:body?'POST':'GET',headers:{cookie:'lancerlogin_session='+session,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
 const backupResponse=await api('/admin/data/backup?scope=installation');assert.equal(backupResponse.status,200);const backup=await backupResponse.json();assert.equal(backup.schemaVersion,28);assert.equal(backup.tables.documentation_upload_operations[0].ticket_hash,null);assert.equal(backup.tables.documentation_upload_operations[0].session_ciphertext,null);
 prepareUploadRestore(structuredClone(backup.tables));for(const [key,value]of [['mime','image/png'],['source','staff'],['sha256','0'.repeat(64)],['unexpected','bad']]){const bad=structuredClone(backup.tables);bad.documentation_upload_operations[0][key]=value;assert.throws(()=>prepareUploadRestore(bad));}
 await assert.rejects(()=>db.batch([db.prepare("INSERT INTO documentation_upload_restore_guard VALUES('primary','[]')"),db.prepare("DELETE FROM installations WHERE id='primary'")]),/documentation_upload_inventory/);
 const restored=await api('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});assert.equal(restored.status,200,await restored.clone().text());assert.equal((await row()).state,'saved');assert.equal((await row()).ticket_hash,null);assert.equal((await db.prepare('SELECT * FROM documentation_artifact_revisions WHERE artifact_id=?').bind(currentOp).first()).actor_member_id,'member1');
 await db.prepare("UPDATE members SET active=0 WHERE id='member1'").run();await assert.rejects(async()=>advanceUpload(env,await row(),'advance'),e=>e.status===409);
 assert.equal(acknowledgedOffset(new Response(null,{status:308,headers:{range:'bytes=0-6'}}),100),7);assert.throws(()=>acknowledgedOffset(new Response(null,{status:308,headers:{range:'bytes=1-6'}}),100));
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});

test('populated migrations47 and48 preserve historical claim artifact pins and cascading histories',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));try{
  const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')&&Number(n.slice(0,4))<47).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic Team','UTC')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01'),('docs','primary','synthetic-docs','staff','2026-01-01'),('hours','primary','synthetic-hours','staff','2026-01-01'),('operator','primary','synthetic-operator','operator','2026-01-01')"),
   db.prepare("INSERT INTO platform_module_configuration VALUES('primary',1,1,1)"),
   db.prepare("INSERT INTO platform_module_grants VALUES('primary','docs',0,1),('primary','hours',1,0)"),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,description,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary','activity','event','event','2026-01-19','Synthetic eligible activity','PRIVATE HOURS DESCRIPTION','UTC',1,'2026-01-01','2026-01-01'),('primary','unrelated','event','event','2026-01-19','Unrelated hours-only','PRIVATE UNRELATED','UTC',0,'2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_entry_settings(installation_id) VALUES('primary')"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member1','primary','00123','PRIVATE','ONE','2026-01-01'),('member2','primary','00456','PRIVATE','TWO','2026-01-01')")
  ]);

 await db.batch([
 db.prepare("INSERT INTO documentation_artifacts VALUES('primary','link','Current','Caption','https://example.invalid/new','https://example.invalid/old',0,NULL,NULL,NULL,NULL,1,'docs','2026-01-01','2026-01-02')"),
 db.prepare("INSERT INTO documentation_artifact_revisions VALUES('primary','link',0,'docs','Old','Caption','https://example.invalid/old','https://example.invalid/old',0,NULL,NULL,NULL,NULL,'2026-01-01'),('primary','link',1,'docs','Current','Caption','https://example.invalid/new','https://example.invalid/old',0,NULL,NULL,NULL,NULL,'2026-01-02')"),
 db.prepare("INSERT INTO documentation_artifact_activities VALUES('primary','link','activity')"),db.prepare("INSERT INTO documentation_artifact_revision_activities VALUES('primary','link',0,'activity'),('primary','link',1,'activity')"),
 db.prepare("INSERT INTO documentation_definitions VALUES('primary','definition','Definition','Synthetic definition','Source',0,0,'docs','2026-01-01','2026-01-01')"),db.prepare("INSERT INTO documentation_definition_revisions VALUES('primary','definition',0,'docs','Definition','Synthetic definition','Source',0,'2026-01-01')"),
 db.prepare("INSERT INTO documentation_claims VALUES('primary','claim','Claim','definition',0,'2026-01-01','2026-01-02','Rationale',0,NULL,NULL,NULL,NULL,0,'docs','2026-01-01','2026-01-01')"),db.prepare("INSERT INTO documentation_claim_revisions VALUES('primary','claim',0,'docs','Claim','definition',0,'2026-01-01','2026-01-02','Rationale',0,NULL,NULL,NULL,NULL,'2026-01-01')"),db.prepare("INSERT INTO documentation_claim_revision_artifacts VALUES('primary','claim',0,'link',0)")]);
 const names=['documentation_artifacts','documentation_artifact_revisions','documentation_artifact_activities','documentation_artifact_revision_activities','documentation_claim_revision_artifacts'],before={};for(const n of names)before[n]=(await db.prepare('SELECT * FROM '+n).all()).results;
 await db.batch(migrationStatements(readFileSync(new URL('0047_durable_binary_intake.sql',directory),'utf8')).map(s=>db.prepare(s)));
 for(const n of names){const after=(await db.prepare('SELECT * FROM '+n).all()).results;assert.equal(after.length,before[n].length);for(let i=0;i<after.length;i++)for(const [k,v]of Object.entries(before[n][i]))assert.deepEqual(after[i][k],v);}
 await db.prepare("INSERT INTO documentation_artifacts(installation_id,id,title,caption,url,original_url,author_user_id,created_at,updated_at,kind,file_id,file_root_id,file_generation,file_sha256,file_size,file_mime,validation_outcome) VALUES('primary','binary','Synthetic original','','https://drive.google.com/file/d/original/view','https://drive.google.com/file/d/original/view','docs','2026-01-01','2026-01-01','file','original','root','generation',?,10,'application/octet-stream','linked-only')").bind('a'.repeat(64)).run();
 await db.prepare("INSERT INTO documentation_artifact_revisions(installation_id,artifact_id,revision,actor_user_id,title,caption,url,original_url,created_at,kind,file_id,file_root_id,file_generation,file_sha256,file_size,file_mime,validation_outcome) SELECT installation_id,id,revision,author_user_id,title,caption,url,original_url,created_at,kind,file_id,file_root_id,file_generation,file_sha256,file_size,file_mime,validation_outcome FROM documentation_artifacts WHERE id='binary'").run();
 for(const n of names)before[n]=(await db.prepare('SELECT * FROM '+n).all()).results;
 await db.batch(migrationStatements(readFileSync(new URL('0048_preserved_drive_copies.sql',directory),'utf8')).map(s=>db.prepare(s)));
 for(const n of names){const after=(await db.prepare('SELECT * FROM '+n).all()).results;assert.equal(after.length,before[n].length);for(let i=0;i<after.length;i++)for(const [k,v]of Object.entries(before[n][i]))assert.deepEqual(after[i][k],v);}
 assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});

test('public Files catalog is independent of Notes and keeps transport, current eligibility and privacy gates', {timeout:60000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){throw Error("No provider calls")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{
  const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
   db.prepare("INSERT INTO platform_module_configuration VALUES('primary',1,1,1)"),
   db.prepare("INSERT INTO documentation_sections VALUES('primary',1,7,0,0,1)"),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01'),('foreign','event','Event','event','2026-01-01','2026-01-01')"),
   ...[['primary','a',0,1],['primary','b',0,1],['primary','archived',1,1],['primary','irrelevant',0,0],['foreign','foreign',0,1]].map(([installation,id,archived,relevant])=>db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,description,planning_time_zone,impact_relevant,archived,created_at,updated_at) VALUES(?,?,'event','event','2020-01-01',?,'PRIVATE DESCRIPTION','UTC',?,?,'2026-01-01','2026-01-01')").bind(installation,id,'Activity '+id,relevant,archived))
  ]);
  const env={DB:db,SESSION_KEY:secret,ALLOWED_ORIGIN:'https://fixture.test'},get=path=>uploadRoute(new Request('https://fixture.test/public/documentation/uploads/'+path),env);
  const context=await get('context');assert.equal(context.headers.get('cache-control'),'no-store');assert.deepEqual(await context.json(),{available:true,sectionRevision:7});
  const page=await (await get('activities?limit=1')).json();assert.deepEqual(page,{activities:[{id:'a',title:'Activity a',serviceDate:'2020-01-01',mode:'event',revision:0}],next:'a',sectionRevision:7});
  assert.deepEqual(await (await get('activities?after=a&limit=1')).json(),{activities:[{id:'b',title:'Activity b',serviceDate:'2020-01-01',mode:'event',revision:0}],next:null,sectionRevision:7});
  assert.doesNotMatch(JSON.stringify(await (await get('activities')).json()),/PRIVATE|foreign|archived|irrelevant/);
  const {publicDocumentation}=await import('../apps/api/src/public-documentation.ts');assert.deepEqual(await (await publicDocumentation(new Request('https://fixture.test/public/documentation/context'),env)).json(),{available:false});
  for(const path of ['context?limit=1','activities?limit=0','activities?limit=51','activities?after=bad!','activities?limit=1&limit=2','activities?unknown=1'])await assert.rejects(()=>get(path),e=>e.status===400);
  await db.prepare("UPDATE hours_activities SET archived=1 WHERE installation_id='primary' AND id='a'").run();assert.equal((await (await get('activities')).json()).activities[0].id,'b');
  for(const change of ["UPDATE documentation_sections SET files_enabled=0","UPDATE documentation_sections SET files_enabled=1; UPDATE platform_module_configuration SET documentation_enabled=0","UPDATE platform_module_configuration SET documentation_enabled=0,hours_enabled=0"]){for(const sql of change.split(';'))await db.prepare(sql).run();assert.deepEqual(await (await get('context')).json(),{available:false});await assert.rejects(()=>get('activities'),e=>e.status===403);}
  await db.prepare("UPDATE platform_module_configuration SET hours_enabled=1,documentation_enabled=1").run();await db.prepare("DELETE FROM documentation_sections").run();assert.deepEqual(await (await get('context')).json(),{available:true,sectionRevision:0});
  assert.ok((await db.prepare("SELECT SUM(attempts) n FROM public_documentation_admission WHERE policy='read-v1'").first()).n>0);
  await db.prepare("UPDATE public_documentation_admission SET attempts=capacity WHERE policy='read-v1'").run();await assert.rejects(()=>get('context'),e=>e.status===429);
 }finally{await mf.dispose();}
});

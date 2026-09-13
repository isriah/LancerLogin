import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {driveProofRoute,syntheticDrivePdf,uploadOffset} from '../apps/api/src/google-drive-proof.ts';
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',scope='https://www.googleapis.com/auth/drive.file',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('resumable checkpoints reject malformed ranges and use inclusive byte endpoints',()=>{
 assert.equal(uploadOffset(new Response(null,{status:308}),100),0);assert.equal(uploadOffset(new Response(null,{status:308,headers:{range:'bytes=0-42'}}),100),43);
 for(const range of ['bytes=1-42','bytes=0-100','bytes=0--1','bytes=0-99999999999999999999'])assert.throws(()=>uploadOffset(new Response(null,{status:308,headers:{range}}),100));assert.throws(()=>uploadOffset(new Response(null,{status:302}),100));
});
test('synthetic Drive run actual D1 persists ambiguous copy and 308 recovery, stable public ID and private originals',{timeout:60000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']})),originalFetch=globalThis.fetch;
 try{
  const db=await mf.getD1Database('DB'),migrations=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,migrations),'utf8')).map(x=>db.prepare(x)));
  await db.batch([db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local')"),db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01')")]);
  const active={clientId:'synthetic-client',clientSecret:'synthetic-secret',generation:'synthetic-generation',driveEnabled:true,organizationProof:true,grant:{proofId:'synthetic-proof',subject:'synthetic-subject',refreshToken:'synthetic-refresh',scopes:[scope]}};
  const encrypted=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify(active)},key);await db.prepare("INSERT INTO google_connections(installation_id,shared_mode,revision,active_ciphertext,active_iv,updated_at,grant_proof_id) VALUES('primary',1,1,?,?,'2026-01-01','synthetic-proof')").bind(encrypted.ciphertext,encrypted.iv).run();
  const env={DB:db,SESSION_KEY:key,INTEGRATION_KEY:key,ALLOWED_ORIGIN:'https://fixture.test'},actor={userId:'admin',expiresAt:Date.now()+3600000},files=new Map([['root',{id:'root',mimeType:'application/vnd.google-apps.folder',ownedByMe:true,capabilities:{canAddChildren:true},permissions:[{type:'user',role:'owner'}]}],['source',{id:'source',version:'1',mimeType:'application/vnd.google-apps.document',capabilities:{canCopy:true}}]]),uploads=new Map();
  let lostCopy=true,lostChunk=true,copies=0,probes=0,restoreDuringAllocation=false;
  globalThis.fetch=async(raw,init={})=>{
   const url=new URL(raw),method=init.method??'GET';assert.equal(init.redirect,'manual');
   if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'synthetic-combined-server-only',scope});
   if(url.pathname.endsWith('/generateIds')){
    if(restoreDuringAllocation){
     const restored=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify({...active,generation:'restored-generation'})},key);
     await db.batch([db.prepare("DELETE FROM installations WHERE id='primary'"),db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local')"),db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01')"),db.prepare("INSERT INTO google_connections(installation_id,shared_mode,revision,active_ciphertext,active_iv,updated_at,grant_proof_id) VALUES('primary',1,1,?,?,'2026-01-01','synthetic-proof')").bind(restored.ciphertext,restored.iv)]);
    }
    return Response.json({ids:['originals','private','published','private-pdf','public-pdf']});
   }
   if(url.pathname.startsWith('/upload/')){
    if(['POST','PATCH'].includes(method)){const metadata=JSON.parse(init.body),id=metadata.id??url.pathname.split('/').at(-1),session='https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id='+id;uploads.set(id,{metadata:{...files.get(id),...metadata,id},bytes:new Uint8Array(),total:Number(init.headers['x-upload-content-length'])});return new Response(null,{status:200,headers:{location:session}});}
    const upload=uploads.get(url.searchParams.get('upload_id')),range=init.headers['content-range'];if(range.startsWith('bytes */')){probes++;if(upload.bytes.length===upload.total)return Response.json({id:upload.metadata.id});return new Response(null,{status:308,headers:upload.bytes.length?{range:'bytes=0-'+(upload.bytes.length-1)}:{}});}
    const [,start,end,total]=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);assert.equal(Number(start),upload.bytes.length);assert.equal(Number(total),upload.total);const next=new Uint8Array(Number(end)+1);next.set(upload.bytes);next.set(init.body,Number(start));upload.bytes=next;
    if(upload.bytes.length===upload.total){files.set(upload.metadata.id,{...upload.metadata,size:upload.bytes.length,sha256Checksum:hash(upload.bytes),permissions:upload.metadata.permissions??[{type:'user',role:'owner'}]});return Response.json({id:upload.metadata.id});}
    if(lostChunk){lostChunk=false;throw Error('synthetic lost response');}return new Response(null,{status:308,headers:{range:'bytes=0-'+(upload.bytes.length-1)}});
   }
   const segments=url.pathname.split('/'),id=segments[4];
   if(url.pathname.endsWith('/copy')){copies++;const body=JSON.parse(init.body),copy={...files.get('source'),...body,id:'native-copy',permissions:[{type:'user',role:'owner'}]};files.set(copy.id,copy);if(lostCopy){lostCopy=false;throw Error('synthetic lost copy response');}return Response.json(copy);}
   if(url.pathname.endsWith('/permissions')){const file=files.get(id);if(method==='POST'){file.permissions.push(JSON.parse(init.body));return Response.json({id:'public-permission'});}return Response.json({permissions:file.permissions});}
   if(method==='POST'){const body=JSON.parse(init.body);assert.ok(!files.has(body.id));files.set(body.id,{...body,ownedByMe:true,capabilities:{canAddChildren:true},permissions:[{type:'user',role:'owner'}]});return Response.json({id:body.id});}
   if(url.searchParams.has('q'))return Response.json({files:[files.get('native-copy')]});
   assert.ok(files.has(id),'known synthetic file '+id);return Response.json(files.get(id));
  };
  const runId='00000000-0000-4000-8000-000000000001',path='/feasibility-runs/'+runId;
  const invoke=(input,route=path+'/resume',method='POST')=>driveProofRoute(new Request('https://fixture.test'+route,{method}),env,actor,input,route,'root','synthetic-generation',{fileId:'source',resourceKey:'',version:'1',mime:'application/vnd.google-apps.document',checksum:''});
  let state=await (await invoke({revision:1,runId,sourceIntentId:'source',confirmation:'RUN SYNTHETIC DRIVE PROOF'},'/feasibility-runs')).json();
  const read=async()=>state=await (await invoke({revision:1},path,'GET')).json();
  const step=async()=>{try{state=await (await invoke({revision:1,runRevision:state.revision,confirmation:'CONTINUE SYNTHETIC DRIVE PROOF'})).json();}catch{await read();assert.equal(state.pending,true);}};
  await step();assert.equal(state.stage,'copy');files.get('root').permissions.push({type:'anyone',role:'reader'});
  await assert.rejects(()=>invoke({revision:1,runRevision:state.revision,confirmation:'CONTINUE SYNTHETIC DRIVE PROOF'}),/owner-only/);assert.equal(copies,0);await read();assert.equal(state.pending,false);files.get('root').permissions.pop();
  for(let i=0;i<25&&state.stage!=='publish';i++)await step();assert.equal(state.stage,'publish');const goodHash=files.get('public-pdf').sha256Checksum;files.get('public-pdf').sha256Checksum='external-change';
  await assert.rejects(()=>invoke({revision:1,runRevision:state.revision,confirmation:'CONTINUE SYNTHETIC DRIVE PROOF'}),/candidate changed/);assert.deepEqual(files.get('public-pdf').permissions,[{type:'user',role:'owner'}]);await read();assert.equal(state.pending,false);files.get('public-pdf').sha256Checksum=goodHash;
  for(let i=0;i<15&&!state.verified;i++)await step();assert.equal(state.verified,true,JSON.stringify(state));assert.equal(copies,1);assert.equal(probes,1);assert.equal(state.publicUrl,'https://drive.google.com/file/d/public-pdf/view');
  assert.equal(files.get('private-pdf').sha256Checksum,hash(syntheticDrivePdf()));assert.equal(files.get('public-pdf').sha256Checksum,hash(syntheticDrivePdf(true)));assert.equal(files.get('source').version,'1');assert.deepEqual(files.get('native-copy').permissions,[{type:'user',role:'owner'}]);assert.deepEqual(files.get('root').permissions,[{type:'user',role:'owner'}]);
  await assert.rejects(()=>invoke({revision:1,runId,sourceIntentId:'source',confirmation:'RUN SYNTHETIC DRIVE PROOF'},'/feasibility-runs'),/already exists/);
  restoreDuringAllocation=true;const fileCount=files.size;
  await assert.rejects(()=>invoke({revision:1,runId:'00000000-0000-4000-8000-000000000002',sourceIntentId:'source',confirmation:'RUN SYNTHETIC DRIVE PROOF'},'/feasibility-runs'),/Run was not recorded/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM google_drive_proof_runs').first()).n,0);assert.equal(files.size,fileCount);
 }finally{globalThis.fetch=originalFetch;await mf.dispose();}
});

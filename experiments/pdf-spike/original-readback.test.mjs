import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import images from './synthetic-images.json' with {type:'json'};
import {COMPUTE_LIMITS} from './compute-runtime.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
test('real workerd original readback preserves PNG JPEG modern PDF across restart and fails closed on identity, storage and expiry',{timeout:120000},async()=>{
 const persistence=await mkdtemp(join(tmpdir(),'ll-compute-original-'));
 const source=`import {DocumentComputeQueue,singleton} from './experiments/pdf-spike/compute-runtime.mjs';
 export class Fixture extends DocumentComputeQueue {
  now(){return Date.now()+(this.offset??0);}
  async schedule(tx){await tx.deleteAlarm();}
  async fetch(req){const p=new URL(req.url).pathname;
   if(p==='/fixture/alarm'){await this.alarm();return new Response('ok');}
   if(p==='/fixture/expire'){this.offset=86400001;return new Response('ok');}
   if(p==='/fixture/storage'){const v=await req.json(),key='input:'+v.id+':'+v.item+':'+v.chunk;
    if(v.action==='delete')await this.storage.delete(key);
    if(v.action==='flip'){const b=await this.storage.get(key);b[0]^=1;await this.storage.put(key,b);}
    if(v.action==='swap')await this.storage.put(key,await this.storage.get('input:'+v.id+':'+v.other+':'+v.chunk));
    if(v.action==='restore')await this.storage.put(key,Uint8Array.from(v.bytes));
    if(v.action==='legacy'){const s=await this.state();delete s.jobs[v.id].inputDigests;await this.storage.put('state',s);}
    return new Response('ok');}
   return super.fetch(req);}
 }
 export default {fetch(req,env){return env.QUEUE.get(env.QUEUE.idFromName(singleton)).fetch(req);}};`;
 const bundled=await build({stdin:{contents:source,resolveDir:resolve('.')},bundle:true,platform:'browser',format:'esm',write:false});
 const options=()=>convertV4MiniflareOptions({name:'original-readback-local',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-09-04',durableObjects:{QUEUE:{className:'Fixture',useSQLite:true}},resourcePersistencePath:persistence,telemetry:{enabled:false},log:new Log(LogLevel.ERROR),outboundService:()=>{throw Error('Unexpected outbound request');}});
 let mf=new Miniflare(options());
 const call=(path,method='GET',body,headers={})=>mf.dispatchFetch('https://compute.invalid'+path,{method,headers,...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});
 const doc=await PDFDocument.create();const page=doc.addPage([500,700]);page.drawText('Ordinary modern vector and image PDF');page.drawImage(await doc.embedJpg(Buffer.from(images.jpeg,'base64')),{x:10,y:10,width:200,height:100});const saved=await doc.save({useObjectStreams:true});assert.match(Buffer.from(saved).toString('latin1'),/ObjStm/);
 // Legal trailing whitespace gives an ordinary modern PDF multiple transport chunks.
 const originals=[Buffer.from(images.png,'base64'),Buffer.from(images.jpeg,'base64'),Buffer.concat([saved,Buffer.alloc(COMPUTE_LIMITS.chunk+31,32)])];
 const id=Date.now()+'-'+randomUUID(),manifest={version:1,id,operation:'assemble-packet',policyVersion:'document-input-v1',snapshotDigest:'a'.repeat(64),items:originals.map((bytes,i)=>({id:'item-'+i,revision:'revision-'+i,caption:'Synthetic source',url:'https://example.invalid/private',type:['image/png','image/jpeg','application/pdf'][i],byteLength:bytes.length,sha256:digest(bytes),...(i===2?{selectedPages:[1]}:{})}))};
 try{
  const admitted=await(await call('/jobs','POST',manifest)).json();const identity={'x-document-manifest-sha256':admitted.manifestDigest,'x-document-snapshot-sha256':manifest.snapshotDigest};
  const meta=i=>'/jobs/'+id+'/items/'+i+'/original',chunk=(i,n)=>meta(i)+'/chunks/'+n,headers=i=>({...identity,'x-document-item-sha256':manifest.items[i].sha256});
  assert.equal((await call(meta(0),'GET',undefined,identity)).status,409);
  for(let i=0;i<originals.length;i++)for(let n=0;n<Math.ceil(originals[i].length/COMPUTE_LIMITS.chunk);n++)assert.equal((await call('/jobs/'+id+'/items/'+i+'/chunks/'+n,'PUT',originals[i].subarray(n*COMPUTE_LIMITS.chunk,(n+1)*COMPUTE_LIMITS.chunk))).status,200);
  assert.equal((await call('/jobs/'+id+'/seal','POST')).status,202);assert.equal((await call(meta(0),'GET',undefined,identity)).status,409);await call('/fixture/alarm','POST');assert.equal((await(await call('/jobs/'+id)).json()).state,'complete');
  async function verify(){for(let i=0;i<originals.length;i++){const response=await call(meta(i),'GET',undefined,identity);assert.equal(response.status,200);const m=await response.json();assert.equal(m.id,manifest.items[i].id);assert.equal(m.revision,manifest.items[i].revision);assert.equal(m.itemIndex,i);assert.equal(m.type,manifest.items[i].type);assert.equal(m.outcome,'embedded');assert.equal(m.sha256,digest(originals[i]));assert.equal(m.byteLength,originals[i].length);assert.equal(m.manifestDigest,identity['x-document-manifest-sha256']);assert.equal(m.snapshotDigest,manifest.snapshotDigest);const parts=[];for(let n=0;n<m.chunkCount;n++){const r=await call(chunk(i,n),'GET',undefined,headers(i));assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-document-item-index'),String(i));assert.equal(r.headers.get('x-document-chunk-index'),String(n));assert.equal(r.headers.get('x-document-byte-offset'),String(n*COMPUTE_LIMITS.chunk));const bytes=Buffer.from(await r.arrayBuffer());assert.equal(bytes.length,Number(r.headers.get('content-length')));assert.ok(bytes.length<=COMPUTE_LIMITS.chunk);assert.equal(digest(bytes),r.headers.get('x-document-chunk-sha256'));assert.equal(digest(bytes),m.chunkSha256[n]);assert.equal(r.headers.get('x-document-sha256'),m.sha256);parts.push(bytes);}assert.deepEqual(Buffer.concat(parts),originals[i]);}}
  await verify();await mf.dispose();mf=new Miniflare(options());await verify();
  const pdf=await call('/jobs/'+id+'/result');assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.equal((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount(),4);
  for(const [path,h,status] of [[meta(0),{},409],[meta(0),{...identity,'x-document-manifest-sha256':'b'.repeat(64)},409],[meta(0),{...identity,'x-document-snapshot-sha256':'b'.repeat(64)},409],[chunk(0,0),headers(1),409],[meta(3),identity,400],[meta('00'),identity,404],[chunk(0,'00'),headers(0),404],[chunk(0,1),headers(0),400],[chunk(0,'9007199254740992'),headers(0),400],[meta(0)+'?snapshot=other',identity,404]])assert.equal((await call(path,'GET',undefined,h)).status,status,path);
  assert.equal((await call(meta(0),'POST',undefined,identity)).status,405);
  const mutate=action=>call('/fixture/storage','POST',{id,item:0,chunk:0,...action});
  await mutate({action:'flip'});assert.equal((await call(chunk(0,0),'GET',undefined,headers(0))).status,409);await mutate({action:'restore',bytes:[...originals[0]]});
  await mutate({action:'swap',other:1});assert.equal((await call(chunk(0,0),'GET',undefined,headers(0))).status,409);await mutate({action:'restore',bytes:[...originals[0]]});
  await mutate({action:'delete'});assert.equal((await call(meta(0),'GET',undefined,identity)).status,200);assert.equal((await call(chunk(0,0),'GET',undefined,headers(0))).status,409);await mutate({action:'restore',bytes:[...originals[0]]});
  const badId=Date.now()+'-'+randomUUID(),bad={...manifest,id:badId,operation:'validate-artifact',items:[{...manifest.items[0],byteLength:1,sha256:digest(Buffer.from([1]))}]};const badState=await(await call('/jobs','POST',bad)).json();await call('/jobs/'+badId+'/items/0/chunks/0','PUT',Buffer.from([1]));await call('/jobs/'+badId+'/seal','POST');await call('/fixture/alarm','POST');assert.equal((await(await call('/jobs/'+badId)).json()).state,'failed');assert.equal((await call('/jobs/'+badId+'/items/0/original','GET',undefined,{'x-document-manifest-sha256':badState.manifestDigest,'x-document-snapshot-sha256':bad.snapshotDigest})).status,409);
  await mutate({action:'legacy'});assert.equal((await call(meta(0),'GET',undefined,identity)).status,409);await call('/fixture/expire','POST');assert.equal((await call(chunk(1,0),'GET',undefined,headers(1))).status,409);await call('/fixture/alarm','POST');assert.equal((await call(meta(1),'GET',undefined,identity)).status,404);
 }finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});

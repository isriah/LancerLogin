import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {DocumentComputeQueue,COMPUTE_LIMITS} from './compute-runtime.mjs';
const {PDFDocument}=createRequire(import.meta.url)('pdf-lib');
const confirmation={confirmation:'RUN FIXED SYNTHETIC DOCUMENT COMPUTE'},digest=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('actual workerd persists inputs/results, serializes admission, recovers interrupted work and keeps proof tombstones',async()=>{
 const persistence=await mkdtemp(join(tmpdir(),'ll-document-compute-'));
 const source=`import {DocumentComputeQueue,singleton} from './experiments/pdf-spike/compute-runtime.mjs';
 export class Fixture extends DocumentComputeQueue {
  now(){return Date.now()+(this.offset??0);}
  async fetch(req){const p=new URL(req.url).pathname;
   if(p==='/fixture/expire'){this.offset=86400001;return new Response('ok');}
   if(p==='/fixture/interrupted'){const s=await this.state();const id=s.queue.shift();s.active=id;s.jobs[id].state='running';s.jobs[id].attempts=1;await this.storage.put('state',s);await this.storage.setAlarm(Date.now()+100);return new Response('ok');}
   if(p==='/fixture/alarm'){await this.alarm();return new Response('ok');}
   if(p==='/fixture/state')return Response.json(await this.state());return super.fetch(req);}
  async build(j){if(j.proof==='cpu-fault-v1'||j.proof==='memory-fault-v1')throw Error('Synthetic test seam; real faults are never executed locally');return super.build(j);}
 }
 export default {fetch(req,env){return env.DOCUMENT_COMPUTE_QUEUE.get(env.DOCUMENT_COMPUTE_QUEUE.idFromName(singleton)).fetch(req);}};`;
 const bundled=await build({stdin:{contents:source,resolveDir:resolve('.')},bundle:true,platform:'browser',format:'esm',write:false});
 const opts=mode=>convertV4MiniflareOptions({name:'document-compute-local',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-09-04',durableObjects:{DOCUMENT_COMPUTE_QUEUE:{className:'Fixture',useSQLite:true}},bindings:mode?{DOCUMENT_COMPUTE_PROOF_MODE:mode}:{},resourcePersistencePath:persistence,telemetry:{enabled:false},log:new Log(LogLevel.ERROR),outboundService:()=>{throw Error('Unexpected outbound request');}});
 let mf=new Miniflare(opts('synthetic'));
 const call=(path,method='GET',body)=>mf.dispatchFetch('https://compute.invalid'+path,{method,...(body!==undefined?{headers:{'content-type':'application/json'},body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)}:{})});
 const finished=async path=>{for(let n=0;n<80;n++){const j=await(await call(path)).json();if(['complete','failed','expired'].includes(j.state))return j;await sleep(100);}throw Error('Job did not finish');};
 try{
  for(const id of ['png-v1','jpeg-v1','modern-pdf-v1'])assert.equal((await call('/proofs/'+id,'POST',confirmation)).status,202);
  assert.equal((await call('/proofs/mixed-v1','POST',confirmation)).status,409);
  for(const id of ['png-v1','jpeg-v1','modern-pdf-v1']){const j=await finished('/proofs/'+id);assert.equal(j.state,'complete');assert.equal(j.attempts,1);const result=await call('/proofs/'+id+'/result');const b=new Uint8Array(await result.arrayBuffer());assert.equal(digest(b),j.sha256);assert.equal((await PDFDocument.load(b)).getPageCount(),j.pageCount);}
  const before=await(await call('/proofs/modern-pdf-v1')).json();assert.deepEqual(await(await call('/proofs/modern-pdf-v1','POST',confirmation)).json(),before);
  await mf.dispose();mf=new Miniflare(opts('synthetic'));assert.deepEqual(await(await call('/proofs/modern-pdf-v1')).json(),before);
  const png=Buffer.alloc(COMPUTE_LIMITS.chunk*2+17,65),id=Date.now()+'-'+randomUUID();
  const manifest={version:1,id,operation:'assemble-packet',policyVersion:'document-input-v1',snapshotDigest:'a'.repeat(64),items:[{id:'linked',revision:'r1',caption:'Synthetic linked bytes',url:'https://example.invalid/private',type:'application/octet-stream',byteLength:png.length,sha256:digest(png)}]};
  assert.equal((await call('/jobs','POST',manifest)).status,201);assert.equal((await call('/jobs','POST',{...manifest,snapshotDigest:'b'.repeat(64)})).status,409);
  assert.equal((await call('/jobs/'+id+'/seal','POST')).status,409);
  const first=png.subarray(0,COMPUTE_LIMITS.chunk);
  assert.equal((await call('/jobs/'+id+'/items/0/chunks/0','PUT',first)).status,200);assert.equal((await call('/jobs/'+id+'/items/0/chunks/0','PUT',first)).status,200);
  const corrupt=Buffer.from(first);corrupt[20]^=1;assert.equal((await call('/jobs/'+id+'/items/0/chunks/0','PUT',corrupt)).status,409);
  for(let n=1;n<3;n++)assert.equal((await call('/jobs/'+id+'/items/0/chunks/'+n,'PUT',png.subarray(n*COMPUTE_LIMITS.chunk,(n+1)*COMPUTE_LIMITS.chunk))).status,200);
  assert.equal((await call('/jobs/'+id+'/seal','POST')).status,202);
  await mf.dispose();mf=new Miniflare(opts('synthetic'));assert.equal((await finished('/jobs/'+id)).state,'complete');
  const packet=await call('/jobs/'+id+'/result');assert.equal((await PDFDocument.load(await packet.arrayBuffer())).getPageCount(),1);
  await call('/proofs/cpu-fault-v1','POST',confirmation);await call('/fixture/interrupted','POST');await mf.dispose();mf=new Miniflare(opts('synthetic'));
  const interrupted=await finished('/proofs/cpu-fault-v1');assert.equal(interrupted.error,'EXECUTION_INTERRUPTED');assert.equal(interrupted.attempts,1);
  await call('/proofs/recovery-v1','POST',confirmation);assert.equal((await finished('/proofs/recovery-v1')).state,'complete');
  await call('/fixture/expire','POST');await call('/fixture/alarm','POST');const tombstone=await(await call('/proofs/cpu-fault-v1','POST',confirmation)).json();assert.equal(tombstone.state,'expired');assert.equal(tombstone.attempts,1);assert.equal((await call('/proofs/recovery-v1/result')).status,409);
  await mf.dispose();mf=new Miniflare(opts());assert.equal((await call('/proofs/memory-fault-v1','POST',confirmation)).status,404);
 }finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
class Storage{
 constructor(){this.values=new Map();}
 async get(k){return structuredClone(this.values.get(k));}async put(k,v){this.values.set(k,structuredClone(v));}async delete(k){this.values.delete(k);}async setAlarm(t){this.alarm=t;}async deleteAlarm(){this.alarm=null;}
 async transaction(fn){const before=structuredClone(this.values);try{return await fn(this);}catch(e){this.values=before;throw e;}}
}
test('completion rollback hides partial output and never retries the failed parser',async()=>{
 const storage=new Storage();let builds=0;class Fixture extends DocumentComputeQueue{async build(){builds++;return {bytes:new Uint8Array(COMPUTE_LIMITS.chunk+1),pageCount:1};}}
 const worker=new Fixture({storage},{DOCUMENT_COMPUTE_PROOF_MODE:'synthetic'});await worker.fetch(new Request('https://x/proofs/png-v1',{method:'POST',body:JSON.stringify(confirmation)}));
 const put=storage.put.bind(storage);storage.put=async(k,v)=>{if(k==='output:proof-png-v1:1')throw Error('synthetic rollback');return put(k,v);};await worker.alarm();assert.equal((await storage.get('state')).jobs['proof-png-v1'].state,'failed');assert.equal(await storage.get('output:proof-png-v1:0'),undefined);await worker.alarm();assert.equal(builds,1);
});
test('ordinary identities expire without lifetime exhaustion while fixed proof tombstones persist',async()=>{
 const storage=new Storage();let now=Date.now();class Fixture extends DocumentComputeQueue{now(){return now;}}
 const worker=new Fixture({storage},{DOCUMENT_COMPUTE_PROOF_MODE:'synthetic'});
 await worker.fetch(new Request('https://x/proofs/cpu-fault-v1',{method:'POST',body:JSON.stringify(confirmation)}));
 let first;
 for(let i=0;i<130;i++){now+=COMPUTE_LIMITS.retention+1;const m={version:1,id:now+'-'+randomUUID(),operation:'validate-artifact',policyVersion:'document-input-v1',snapshotDigest:'a'.repeat(64),items:[{id:'x',revision:'r1',caption:'Synthetic',url:'https://example.invalid/',type:'text/plain',byteLength:1,sha256:'0'.repeat(64)}]};first??=m;
  const response=await worker.fetch(new Request('https://x/jobs',{method:'POST',body:JSON.stringify(m)}));assert.equal(response.status,201);assert.ok(Object.keys((await storage.get('state')).jobs).length<=2);
 }
 assert.equal((await worker.fetch(new Request('https://x/jobs',{method:'POST',body:JSON.stringify(first)}))).status,409);
 assert.equal((await(await worker.fetch(new Request('https://x/proofs/cpu-fault-v1',{method:'POST',body:JSON.stringify(confirmation)}))).json()).state,'expired');
});
test('an awaited parser cannot overlap a second alarm in the same instance',async()=>{
 const storage=new Storage();let finish,calls=0;class Fixture extends DocumentComputeQueue{async build(){calls++;await new Promise(r=>{finish=r;});return {bytes:new Uint8Array([1]),pageCount:1};}}
 const worker=new Fixture({storage},{DOCUMENT_COMPUTE_PROOF_MODE:'synthetic'});for(const id of ['png-v1','jpeg-v1'])await worker.fetch(new Request('https://x/proofs/'+id,{method:'POST',body:JSON.stringify(confirmation)}));
 const running=worker.alarm();while(!finish)await sleep(1);await worker.alarm();assert.equal(calls,1);assert.equal((await storage.get('state')).active,'proof-png-v1');finish();await running;assert.equal((await storage.get('state')).jobs['proof-jpeg-v1'].state,'queued');
});
test('digest mismatch and malformed manifests never enter the parser queue',async()=>{
 const storage=new Storage(),worker=new DocumentComputeQueue({storage},{}),id=Date.now()+'-'+randomUUID();
 const m={version:1,id,operation:'validate-artifact',policyVersion:'document-input-v1',snapshotDigest:'a'.repeat(64),items:[{id:'x',revision:'r1',caption:'Synthetic',url:'https://example.invalid/',type:'text/plain',byteLength:1,sha256:'0'.repeat(64)}]};
 const post=body=>worker.fetch(new Request('https://x/jobs',{method:'POST',body:JSON.stringify(body)}));assert.equal((await post({...m,unknown:true})).status,400);assert.equal((await post(m)).status,201);
 assert.equal((await worker.fetch(new Request('https://x/jobs/'+id+'/items/0/chunks/0',{method:'PUT',body:new Uint8Array([1])}))).status,200);
 const seal=await worker.fetch(new Request('https://x/jobs/'+id+'/seal',{method:'POST'}));assert.equal(seal.status,409);assert.equal((await seal.json()).error,'INPUT_DIGEST_MISMATCH');assert.deepEqual((await storage.get('state')).queue,[]);
});

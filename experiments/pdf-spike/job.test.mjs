import test from 'node:test';
import assert from 'node:assert/strict';
import {PdfSpikeJob} from './pdf-job.mjs';
import worker from './job-worker.mjs';
import {PDFDocument} from 'pdf-lib';
const env={SPIKE_TOKEN:'synthetic-local-test-only-000000000000'};
const request=(id,method='GET',suffix='',body)=>new Request(`https://example.invalid/jobs/${id}${suffix}`,{method,headers:{authorization:`Bearer ${env.SPIKE_TOKEN}`},...(body?{body}:{})});
class Storage {
  data=new Map(); alarm=null;
  async get(k) {return structuredClone(this.data.get(k));}
  async put(k,v) {this.data.set(k,structuredClone(v));}
  async delete(k) {return this.data.delete(k);}
  async setAlarm(value) {this.alarm=value;}
  async deleteAlarm() {this.alarm=null;}
  async transaction(fn) {const before=structuredClone(this.data),alarm=this.alarm;try{return await fn(this);}catch(e){this.data=before;this.alarm=alarm;throw e;}}
}
test('authenticate every route, bound IDs/bodies and avoid unauthorized object creation',async()=>{
  const storage=new Storage(),job=new PdfSpikeJob({storage},env);
  assert.equal((await job.fetch(new Request('https://example.invalid/jobs/png-1'))).status,401);
  assert.equal((await job.fetch(request('unbounded-900','POST'))).status,404);
  assert.equal((await job.fetch(request('png-1','POST','','{}'))).status,400);
  assert.equal(storage.data.size,0);
  assert.equal((await worker.fetch(new Request('https://example.invalid/jobs/png-1'),{PDF_SPIKE_JOBS:{idFromName(){throw Error('must not call');}}})).status,401);
});
test('persist queued state before reply; alarm assembles and stores immutable digest/result',async()=>{
  const storage=new Storage(),job=new PdfSpikeJob({storage},env);
  assert.equal((await job.fetch(request('mixed-1','POST'))).status,202);
  assert.equal((await storage.get('job:mixed-1')).state,'queued');assert.ok(storage.alarm);
  assert.equal((await job.fetch(request('jpeg-1','POST'))).status,409);
  assert.equal((await job.fetch(request('mixed-1','GET','/result'))).status,409);
  // New instance models loss of browser/Worker object references before alarm delivery.
  await new PdfSpikeJob({storage},env).alarm();
  const status=await (await job.fetch(request('mixed-1'))).json();
  assert.equal(status.state,'complete');assert.equal(status.attempts,1);assert.match(status.sha256,/^[a-f0-9]{64}$/);
  const response=await job.fetch(request('mixed-1','GET','/result')),bytes=await response.arrayBuffer();
  assert.equal((await PDFDocument.load(bytes)).getPageCount(),5);
  const sha=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');assert.equal(sha,status.sha256);
  assert.equal(storage.alarm,null);assert.equal(await storage.get('active'),undefined);
  assert.equal((await job.fetch(request('mixed-1','POST'))).status,200);
  await job.alarm();assert.deepEqual(await storage.get('job:mixed-1'),status);
});
test('bounded retries persist across restart without recording exception messages',async()=>{
  class Broken extends PdfSpikeJob {async build(){throw new Error('Do not persist this arbitrary message');}}
  const storage=new Storage();await new Broken({storage},env).fetch(request('vector-1','POST'));
  for(let i=0;i<3;i++) await new Broken({storage},env).alarm();
  const status=await storage.get('job:vector-1');assert.equal(status.state,'failed');assert.equal(status.attempts,3);
  assert.equal(status.error,'ATTEMPT_LIMIT');assert.equal(storage.alarm,null);assert.equal(await storage.get('result:vector-1'),undefined);
  assert.ok(!JSON.stringify(status).includes('arbitrary'));await new Broken({storage},env).alarm();
  assert.deepEqual(await storage.get('job:vector-1'),status);
});
test('watchdog recovers running attempt and attempt ceiling stops repeated interrupted builds',async()=>{
  const storage=new Storage(),job=new PdfSpikeJob({storage},env);
  await job.fetch(request('jpeg-2','POST'));
  const queued=await storage.get('job:jpeg-2');await storage.put('job:jpeg-2',{...queued,state:'running',attempts:1});
  await new PdfSpikeJob({storage},env).alarm();assert.equal((await storage.get('job:jpeg-2')).attempts,2);
  await storage.put('active','png-3');await storage.put('job:png-3',{id:'png-3',kind:'png',state:'running',attempts:3});
  await job.alarm();assert.equal((await storage.get('job:png-3')).state,'failed');
});
test('fixed image and vector workloads remain inside durable result cap',async()=>{
  for(const id of ['png-1','jpeg-1','vector-1']) {
    const storage=new Storage(),job=new PdfSpikeJob({storage},env);await job.fetch(request(id,'POST'));await job.alarm();
    const status=await storage.get(`job:${id}`);assert.equal(status.state,'complete');assert.ok(status.byteLength<1024*1024);
    assert.equal(status.pageCount,id==='png-1'?5:id==='jpeg-1'?8:42);
  }
});
test('atomic completion rollback retries without a partial published result',async()=>{
  class FaultStorage extends Storage {
    failOnce=true;
    async put(k,v) {if(v?.state==='complete' && this.failOnce){this.failOnce=false;throw Error('synthetic storage fault');}return super.put(k,v);}
  }
  const storage=new FaultStorage(),job=new PdfSpikeJob({storage},env);
  await job.fetch(request('mixed-3','POST'));await job.alarm();
  assert.equal((await storage.get('job:mixed-3')).state,'retry');assert.equal(await storage.get('result:mixed-3'),undefined);
  await new PdfSpikeJob({storage},env).alarm();
  const completed=await storage.get('job:mixed-3');assert.equal(completed.state,'complete');assert.equal(completed.attempts,2);assert.equal(completed.error,undefined);
});

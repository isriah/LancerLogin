import {validateAndAssemble,InputError} from './input-validation.mjs';
import {PreflightError} from './assemble.mjs';
import {computeFixture,proofCases} from './compute-fixtures.mjs';
export const COMPUTE_LIMITS=Object.freeze({chunk:262144,input:12*1024**2,output:16*1024**2,live:3,records:128,metadata:262144,retention:86400000});
export const singleton='installation-document-compute-v1';
const json=(v,s=200)=>Response.json(v,{status:s,headers:{'cache-control':'no-store'}});
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const text=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&/^[\x20-\x7e]+$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const idPattern=/^[1-9][0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
class GateError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const fail=(c,s)=>{throw new GateError(c,s);};
async function boundedRead(body,max){if(!body)return new Uint8Array();const reader=body.getReader(),parts=[];let size=0,timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new GateError('BODY_DEADLINE',408)),5000);});
 try{for(;;){const {value,done}=await Promise.race([reader.read(),timeout]);if(done)break;if(value.length>max-size)fail('BODY_LIMIT',413);size+=value.length;parts.push(value);}}catch(e){void reader.cancel().catch(()=>{});throw e;}finally{clearTimeout(timer);reader.releaseLock();}
 const result=new Uint8Array(size);let p=0;for(const part of parts){result.set(part,p);p+=part.length;}return result;}
function manifest(v,now){
 if(!exact(v,['version','id','operation','policyVersion','snapshotDigest','items'])||v.version!==1||!idPattern.test(v.id)||!['validate-artifact','assemble-packet'].includes(v.operation)||v.policyVersion!=='document-input-v1'||!hex(v.snapshotDigest)||!Array.isArray(v.items)||!v.items.length||v.items.length>20||v.operation==='validate-artifact'&&v.items.length!==1)fail('INVALID_MANIFEST');
 const issued=Number(v.id.slice(0,13));if(issued>now+1000||issued+COMPUTE_LIMITS.retention<=now)fail('JOB_ID_EXPIRED_OR_FUTURE',409);
 let total=0;const ids=new Set();
 for(const i of v.items){const keys=['id','revision','caption','url','type','byteLength','sha256',...(i?.type==='application/pdf'?['selectedPages']:[])];
  if(!exact(i,keys)||!text(i.id,32)||ids.has(i.id)||!text(i.revision,24)||typeof i.caption!=='string'||i.caption.length>180||!/^[\x20-\x7e]*$/.test(i.caption)||!text(i.type,100)||!hex(i.sha256)||!Number.isSafeInteger(i.byteLength)||i.byteLength<1||i.byteLength>4194304)fail('INVALID_MANIFEST');
  ids.add(i.id);total+=i.byteLength;let u;try{u=new URL(i.url);}catch{fail('INVALID_MANIFEST');}if(u.protocol!=='https:'||u.username||u.password||i.url.length>1000)fail('INVALID_MANIFEST');
  if(i.type==='application/pdf'&&(!Array.isArray(i.selectedPages)||!i.selectedPages.length||i.selectedPages.length>40||new Set(i.selectedPages).size!==i.selectedPages.length||i.selectedPages.some(p=>!Number.isInteger(p)||p<1||p>40)))fail('INVALID_MANIFEST');
 }
 if(total>COMPUTE_LIMITS.input)fail('INPUT_LIMIT');return v;
}
const key=(id,item,chunk)=>`input:${id}:${item}:${chunk}`;
const outputKey=(id,n)=>`output:${id}:${n}`;
const publicJob=j=>{const {manifest,received,inputDigests,...safe}=j;return safe;};
let requests=0;
export class DocumentComputeQueue{
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;}
 now(){return Date.now();}
 async state(tx=this.storage){return await tx.get('state')??{jobs:{},queue:[],active:null};}
 async save(tx,s){if(new TextEncoder().encode(JSON.stringify(s)).length>COMPUTE_LIMITS.metadata)fail('METADATA_LIMIT',409);await tx.put('state',s);}
 async schedule(tx,s){const live=Object.values(s.jobs).filter(j=>j.state!=='expired');const expiry=Math.min(...live.map(j=>j.expiresAt));
  if(s.queue.length||s.active)await tx.setAlarm(this.now()+(s.active?60000:1000));else if(Number.isFinite(expiry))await tx.setAlarm(Math.max(this.now()+1000,expiry));else await tx.deleteAlarm();}
 async expire(tx,s){for(const j of Object.values(s.jobs)){if(j.id===s.active||j.state==='expired'||j.expiresAt>this.now())continue;
  await this.erase(tx,j);s.queue=s.queue.filter(id=>id!==j.id);if(j.proof)s.jobs[j.id]={id:j.id,manifestDigest:j.manifestDigest,state:'expired',attempts:j.attempts,createdAt:j.createdAt,expiresAt:j.expiresAt,proof:j.proof};else delete s.jobs[j.id];}}
 async erase(tx,j){if(j.manifest)for(let i=0;i<j.manifest.items.length;i++)for(let n=0;n<Math.ceil(j.manifest.items[i].byteLength/COMPUTE_LIMITS.chunk);n++)await tx.delete(key(j.id,i,n));
  for(let n=0;n<Math.ceil((j.byteLength??COMPUTE_LIMITS.output)/COMPUTE_LIMITS.chunk);n++)await tx.delete(outputKey(j.id,n));}
 async readJson(request){try{return JSON.parse(new TextDecoder().decode(await boundedRead(request.body,65536)));}catch{fail('INVALID_BODY');}}
 async fetch(request){
  if(requests>=3)return json({error:'SERVICE_BUSY'},503);requests++;
  try{return await this.route(request);}catch(e){return json({error:e instanceof GateError?e.code:'COMPUTE_UNAVAILABLE'},e instanceof GateError?e.status:503);}finally{requests--;}
 }
 async route(request){const u=new URL(request.url);if(u.search)fail('NOT_FOUND',404);
  const proof=/^\/proofs\/([a-z0-9-]+)(\/result)?$/.exec(u.pathname);
  if(proof){if(this.env.DOCUMENT_COMPUTE_PROOF_MODE!=='synthetic'||!proofCases.includes(proof[1]))fail('NOT_FOUND',404);
   const id='proof-'+proof[1];if(request.method==='POST'&&!proof[2]){const body=await this.readJson(request);if(!exact(body,['confirmation'])||body.confirmation!=='RUN FIXED SYNTHETIC DOCUMENT COMPUTE')fail('INVALID_BODY');
    return this.storage.transaction(async tx=>{const s=await this.state(tx);await this.expire(tx,s);if(s.jobs[id])return json(publicJob(s.jobs[id]));this.capacity(s);
     const now=this.now();const j={id,proof:proof[1],manifestDigest:await hash(new TextEncoder().encode('document-compute-proof-v1:'+proof[1])),state:'queued',attempts:0,createdAt:now,expiresAt:now+COMPUTE_LIMITS.retention};s.jobs[id]=j;s.queue.push(id);await this.save(tx,s);await this.schedule(tx,s);return json(publicJob(j),202);});
   }if(request.method==='GET')return this.result(id,!!proof[2]);fail('METHOD_NOT_ALLOWED',405);
  }
  if(u.pathname==='/jobs'&&request.method==='POST'){const m=manifest(await this.readJson(request),this.now());const digest=await hash(new TextEncoder().encode(JSON.stringify(m)));
   return this.storage.transaction(async tx=>{const s=await this.state(tx);await this.expire(tx,s);if(s.jobs[m.id]){if(s.jobs[m.id].manifestDigest!==digest)fail('IDENTITY_CONFLICT',409);return json(publicJob(s.jobs[m.id]));}this.capacity(s);
    const now=this.now();const j={id:m.id,manifest:m,manifestDigest:digest,state:'staging',received:m.items.map(()=>0),attempts:0,createdAt:now,expiresAt:Number(m.id.slice(0,13))+COMPUTE_LIMITS.retention};s.jobs[m.id]=j;await this.save(tx,s);await this.schedule(tx,s);return json(publicJob(j),201);});
  }
  const original=/^\/jobs\/([a-f0-9-]+)\/items\/(0|[1-9]\d*)\/original(?:\/chunks\/(0|[1-9]\d*))?$/.exec(u.pathname);
  if(original){if(!idPattern.test(original[1]))fail('NOT_FOUND',404);if(request.method!=='GET')fail('METHOD_NOT_ALLOWED',405);return this.original(request,original[1],Number(original[2]),original[3]===undefined?undefined:Number(original[3]));}
  const match=/^\/jobs\/([a-f0-9-]+)(?:\/(seal|result)|\/items\/(\d+)\/chunks\/(\d+))?$/.exec(u.pathname);if(!match||!idPattern.test(match[1]))fail('NOT_FOUND',404);const id=match[1];
  if(request.method==='GET'&&!match[3])return this.result(id,match[2]==='result');
  if(request.method==='PUT'&&match[3]!==undefined){const bytes=await boundedRead(request.body,COMPUTE_LIMITS.chunk),i=Number(match[3]),n=Number(match[4]);
   return this.storage.transaction(async tx=>{const s=await this.state(tx),j=s.jobs[id];if(!j||j.state!=='staging'||j.expiresAt<=this.now())fail('JOB_NOT_STAGING',409);const item=j.manifest.items[i];if(!item||!Number.isSafeInteger(n)||n<0||n>=Math.ceil(item.byteLength/COMPUTE_LIMITS.chunk)||bytes.length!==Math.min(COMPUTE_LIMITS.chunk,item.byteLength-n*COMPUTE_LIMITS.chunk))fail('INVALID_CHUNK');
    const k=key(id,i,n),existing=await tx.get(k);if(existing){if(await hash(existing)!==await hash(bytes))fail('CHUNK_CONFLICT',409);return json(publicJob(j));}
    if(n!==j.received[i])fail('CHUNK_ORDER',409);await tx.put(k,bytes);j.received[i]++;await this.save(tx,s);return json(publicJob(j));});
  }
  if(request.method==='POST'&&match[2]==='seal'){if(request.body&&(await boundedRead(request.body,1)).length)fail('INVALID_BODY');
   return this.storage.transaction(async tx=>{const s=await this.state(tx),j=s.jobs[id];if(!j)fail('NOT_FOUND',404);if(j.state!=='staging')return json(publicJob(j));if(j.expiresAt<=this.now())fail('EXPIRED',409);
    const inputDigests=[];
    for(let i=0;i<j.manifest.items.length;i++){const bytes=await this.input(tx,j,i);if(await hash(bytes)!==j.manifest.items[i].sha256)fail('INPUT_DIGEST_MISMATCH',409);const chunks=[];for(let n=0;n<Math.ceil(bytes.length/COMPUTE_LIMITS.chunk);n++)chunks.push(await hash(bytes.subarray(n*COMPUTE_LIMITS.chunk,(n+1)*COMPUTE_LIMITS.chunk)));inputDigests.push(chunks);}
    j.inputDigests=inputDigests;
    j.state='queued';s.queue.push(id);await this.save(tx,s);await this.schedule(tx,s);return json(publicJob(j),202);});
  }fail('METHOD_NOT_ALLOWED',405);
 }
 capacity(s){if(Object.keys(s.jobs).length>=COMPUTE_LIMITS.records)fail('HISTORY_CAPACITY',409);if(Object.values(s.jobs).filter(j=>['staging','queued','running'].includes(j.state)).length>=COMPUTE_LIMITS.live)fail('QUEUE_FULL',409);
  // At most three retained byte sets, including completed outputs, until expiry.
  const retained=Object.values(s.jobs).reduce((n,j)=>n+(j.state==='expired'?0:(j.manifest?.items.reduce((sum,i)=>sum+i.byteLength,0)??0)+(j.byteLength??(['staging','queued','running'].includes(j.state)?COMPUTE_LIMITS.output:0))),0);
  if(retained+COMPUTE_LIMITS.input+COMPUTE_LIMITS.output>3*(COMPUTE_LIMITS.input+COMPUTE_LIMITS.output))fail('RETENTION_CAPACITY',409);}
 async input(tx,j,i){const item=j.manifest.items[i],bytes=new Uint8Array(item.byteLength);for(let n=0;n<Math.ceil(item.byteLength/COMPUTE_LIMITS.chunk);n++){const chunk=await tx.get(key(j.id,i,n));if(!chunk)fail('INPUT_INCOMPLETE',409);bytes.set(chunk,n*COMPUTE_LIMITS.chunk);}return bytes;}
 async original(request,id,i,n){return this.storage.transaction(async tx=>{
  const s=await this.state(tx),j=s.jobs[id];if(!j)fail('NOT_FOUND',404);if(j.state!=='complete'||j.expiresAt<=this.now()||!j.manifest)fail('ORIGINAL_UNAVAILABLE',409);
  if(request.headers.get('x-document-manifest-sha256')!==j.manifestDigest||request.headers.get('x-document-snapshot-sha256')!==j.manifest.snapshotDigest)fail('IDENTITY_CONFLICT',409);
  if(!Number.isSafeInteger(i)||i<0||i>=j.manifest.items.length)fail('INVALID_ITEM',400);const item=j.manifest.items[i],count=Math.ceil(item.byteLength/COMPUTE_LIMITS.chunk),digests=j.inputDigests?.[i];
  const outcomes=j.outcomes?.filter(value=>value.id===item.id);if(outcomes?.length!==1||outcomes[0].sha256!==item.sha256||!['embedded','linked-only'].includes(outcomes[0].outcome)||!Array.isArray(digests)||digests.length!==count||digests.some(value=>!hex(value)))fail('ORIGINAL_UNAVAILABLE',409);
  if(n===undefined)return json({jobId:id,itemIndex:i,id:item.id,revision:item.revision,type:item.type,byteLength:item.byteLength,sha256:item.sha256,chunkSize:COMPUTE_LIMITS.chunk,chunkCount:count,chunkSha256:digests,manifestDigest:j.manifestDigest,snapshotDigest:j.manifest.snapshotDigest,policyVersion:j.manifest.policyVersion,outcome:outcomes[0].outcome,expiresAt:j.expiresAt});
  if(!Number.isSafeInteger(n)||n<0||n>=count)fail('INVALID_CHUNK',400);if(request.headers.get('x-document-item-sha256')!==item.sha256)fail('IDENTITY_CONFLICT',409);
  const offset=n*COMPUTE_LIMITS.chunk,length=Math.min(COMPUTE_LIMITS.chunk,item.byteLength-offset),bytes=await tx.get(key(id,i,n));
  if(!(bytes instanceof Uint8Array)||bytes.length!==length||await hash(bytes)!==digests[n])fail('ORIGINAL_CHUNK_UNAVAILABLE',409);if(j.expiresAt<=this.now())fail('ORIGINAL_UNAVAILABLE',409);
  return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-length':String(length),'cache-control':'no-store','x-content-type-options':'nosniff','x-document-item-index':String(i),'x-document-chunk-index':String(n),'x-document-byte-offset':String(offset),'x-document-sha256':item.sha256,'x-document-chunk-sha256':digests[n],'x-document-manifest-sha256':j.manifestDigest,'x-document-snapshot-sha256':j.manifest.snapshotDigest}});
 });}
 async result(id,binary){const s=await this.state(),j=s.jobs[id];if(!j)fail('NOT_FOUND',404);if(!binary)return json(publicJob(j));if(j.state!=='complete'||j.expiresAt<=this.now())fail('RESULT_UNAVAILABLE',409);
  const storage=this.storage;let n=0,remaining=j.byteLength;return new Response(new ReadableStream({async pull(c){try{if(!remaining){c.close();return;}const chunk=await storage.get(outputKey(id,n++));if(!chunk||chunk.length!==Math.min(remaining,COMPUTE_LIMITS.chunk))throw Error();remaining-=chunk.length;c.enqueue(chunk);}catch{c.error(new Error('RESULT_UNAVAILABLE'));}}}),{headers:{'content-type':'application/pdf','content-length':String(j.byteLength),'cache-control':'no-store','x-document-sha256':j.sha256,'x-document-manifest-sha256':j.manifestDigest}});}
 async build(j){if(j.proof)return computeFixture(j.proof,this.env.DOCUMENT_COMPUTE_PROOF_MODE==='synthetic');
  const items=[];for(let i=0;i<j.manifest.items.length;i++){const {byteLength,sha256,...item}=j.manifest.items[i];const bytes=await this.input(this.storage,j,i);if(await hash(bytes)!==sha256)fail('INPUT_DIGEST_MISMATCH');items.push({...item,bytes});}
  return validateAndAssemble(items,{isolatedComparison:true});}
 async alarm(){if(this.running)return;this.running=true;try{await this.executeAlarm();}finally{this.running=false;}}
 async executeAlarm(){const job=await this.storage.transaction(async tx=>{const s=await this.state(tx);await this.expire(tx,s);
   if(s.active){const old=s.jobs[s.active];if(old?.state==='running'){old.state='failed';old.error='EXECUTION_INTERRUPTED';old.finishedAt=this.now();}s.active=null;}
   const id=s.queue.shift();if(!id){await this.save(tx,s);await this.schedule(tx,s);return null;}const j=s.jobs[id];j.state='running';j.attempts=1;j.startedAt=this.now();s.active=id;await this.save(tx,s);await this.schedule(tx,s);return structuredClone(j);});
  if(!job)return;try{const result=await this.build(job);if(!(result.bytes instanceof Uint8Array)||result.bytes.length>COMPUTE_LIMITS.output)fail('OUTPUT_LIMIT');const sha256=await hash(result.bytes);
   await this.storage.transaction(async tx=>{const s=await this.state(tx),j=s.jobs[job.id];if(s.active!==job.id||j.state!=='running'||j.manifestDigest!==job.manifestDigest)fail('STALE_COMPLETION');
    for(let n=0;n<Math.ceil(result.bytes.length/COMPUTE_LIMITS.chunk);n++)await tx.put(outputKey(j.id,n),result.bytes.slice(n*COMPUTE_LIMITS.chunk,(n+1)*COMPUTE_LIMITS.chunk));
    const outcomes=(result.results??[]).map(r=>({id:r.id,outcome:r.outcome,sha256:r.sha256}));
    if(outcomes.some(r=>!text(r.id,32)||!['embedded','linked-only'].includes(r.outcome)||!hex(r.sha256)))fail('INVALID_OUTPUT');
    Object.assign(j,{state:'complete',finishedAt:this.now(),sha256,byteLength:result.bytes.length,pageCount:result.pageCount,outcomes});s.active=null;await this.save(tx,s);await this.schedule(tx,s);});
  }catch(error){await this.storage.transaction(async tx=>{const s=await this.state(tx),j=s.jobs[job.id];if(s.active===job.id&&j.state==='running'){j.state='failed';j.error=job.proof==='memory-fault-v1'&&error?.message==='FAULT_BOUNDARY_INCONCLUSIVE'?'FAULT_BOUNDARY_INCONCLUSIVE':'COMPUTATION_FAILED';if(error instanceof InputError||error instanceof PreflightError){j.error='INPUT_REJECTED';j.rejectionCode=error.code;}j.finishedAt=this.now();s.active=null;}await this.save(tx,s);await this.schedule(tx,s);});}
 }
}

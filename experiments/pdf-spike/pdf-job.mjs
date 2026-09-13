import { buildFixedPacket } from './job-fixtures.mjs';
const ID=/^(vector|png|jpeg|mixed)-[123]$/;
const MAX_ATTEMPTS=3, MAX_RESULT_BYTES=1024*1024;
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const statusKey=id=>`job:${id}`, resultKey=id=>`result:${id}`;
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
export async function authorized(request,env) {
  if(typeof env.SPIKE_TOKEN !== 'string' || env.SPIKE_TOKEN.length<32) return false;
  const value=request.headers.get('authorization') ?? '';
  if(value.length>512) return false;
  const expected=await digest(new TextEncoder().encode(`Bearer ${env.SPIKE_TOKEN}`));
  const actual=await digest(new TextEncoder().encode(value));
  let diff=0; for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^actual.charCodeAt(i); return diff===0;
}
export class PdfSpikeJob {
  constructor(ctx,env) { this.storage=ctx.storage; this.env=env; }
  // Test seams are class overrides, never request-controlled options.
  build(kind) { return buildFixedPacket(kind); }
  async fetch(request) {
    if(!await authorized(request,this.env)) return json({error:'UNAUTHORIZED'},401);
    const url=new URL(request.url), match=/^\/jobs\/([^/]+)(\/result)?$/.exec(url.pathname);
    if(url.search || !match || !ID.test(match[1])) return json({error:'NOT_FOUND'},404);
    const id=match[1], key=statusKey(id);
    if(request.method==='POST' && !match[2]) {
      if(request.body!==null) {
        const reader=request.body.getReader();
        try {const first=await reader.read(); if(!first.done) {await reader.cancel(); return json({error:'NO_REQUEST_BODY_ALLOWED'},400);}}
        finally {reader.releaseLock();}
      }
      return this.storage.transaction(async tx=>{
        const existing=await tx.get(key); if(existing) return json(existing,['complete','failed'].includes(existing.state)?200:202);
        if(await tx.get('active')) return json({error:'ASSEMBLY_BUSY'},409);
        const job={id,kind:id.split('-')[0],fixtureRevision:'fixed-r1',state:'queued',attempts:0,createdAt:Date.now()};
        await tx.put(key,job); await tx.put('active',id); await tx.setAlarm(Date.now()+1000);
        return json(job,202);
      });
    }
    if(request.method!=='GET') return json({error:'METHOD_NOT_ALLOWED'},405);
    const job=await this.storage.get(key); if(!job) return json({error:'NOT_FOUND'},404);
    if(!match[2]) return json(job);
    if(job.state!=='complete') return json({error:'RESULT_NOT_READY',state:job.state},409);
    const bytes=await this.storage.get(resultKey(id));
    if(!bytes) return json({error:'RESULT_UNAVAILABLE'},503);
    return new Response(bytes,{headers:{'content-type':'application/pdf','cache-control':'no-store','x-packet-sha256':job.sha256,'x-packet-pages':String(job.pageCount)}});
  }
  async alarm() {
    const job=await this.storage.transaction(async tx=>{
      const id=await tx.get('active'); if(!id) return null;
      const current=await tx.get(statusKey(id));
      if(!current || ['complete','failed'].includes(current.state)) {await tx.delete('active'); await tx.deleteAlarm(); return null;}
      if(current.attempts>=MAX_ATTEMPTS) {
        await tx.put(statusKey(id),{...current,state:'failed',error:'ATTEMPT_LIMIT',finishedAt:Date.now()});
        await tx.delete('active'); await tx.deleteAlarm(); return null;
      }
      const running={...current,state:'running',attempts:current.attempts+1,startedAt:Date.now()};
      await tx.put(statusKey(id),running);
      // Persist a watchdog before expensive work, including for runtime termination.
      await tx.setAlarm(Date.now()+60_000); return running;
    });
    if(!job) return;
    const started=Date.now();
    try {
      const result=await this.build(job.kind);
      if(result.bytes.length>MAX_RESULT_BYTES) throw new Error('FIXED_RESULT_TOO_LARGE');
      const sha256=await digest(result.bytes);
      const {error:previousError,...successfulJob}=job;
      await this.storage.transaction(async tx=>{
        await tx.put(resultKey(job.id),result.bytes);
        await tx.put(statusKey(job.id),{...successfulJob,state:'complete',finishedAt:Date.now(),elapsedMs:Date.now()-started,sha256,byteLength:result.bytes.length,pageCount:result.pageCount});
        await tx.delete('active'); await tx.deleteAlarm();
      });
    } catch {
      // Fixed error code only: never persist arbitrary library errors or bytes in status/logs.
      await this.storage.transaction(async tx=>{
        const failed=job.attempts>=MAX_ATTEMPTS;
        await tx.put(statusKey(job.id),{...job,state:failed?'failed':'retry',error:failed?'ATTEMPT_LIMIT':'ASSEMBLY_RETRY',...(failed?{finishedAt:Date.now()}:{})});
        if(failed) {await tx.delete('active'); await tx.deleteAlarm();}
        else await tx.setAlarm(Date.now()+1000);
      });
    }
  }
}

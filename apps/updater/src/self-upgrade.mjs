import {createUpdaterReleaseVerifier} from '../../../packages/shared/src/updater/updater-release.mjs';
import {sha256} from '../../../packages/shared/src/updater/application-release.mjs';
import {toBase64,fromBase64} from './checkpoint.mjs';
import {ARTIFACT_CHUNK_BYTES} from './artifact-store.mjs';
const check=(ok,code)=>{if(!ok)throw Error(code);};
const exact=(v,keys)=>check(v&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),'self-upgrade-request');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const record=(manifestBytes,signatureBytes)=>({manifest:toBase64(manifestBytes),signature:toBase64(signatureBytes)});
const unpack=r=>({manifestBytes:fromBase64(r.manifest),signatureBytes:fromBase64(r.signature)});
const artifactKey=release=>'updater-self:'+release.manifestSha256;

/** Unwired supervisor component. The externally enforced fence must exclude every
 * old updater execution and new admission; replacing Worker code is not a fence.
 * Store, primary database, transport, authority and capability are trusted construction inputs.
 */
export async function createSelfUpgradeExecutor({installationId,database,store,transport,trust,capability,withUpdaterQuiescence}){
 check(capability&&typeof capability==='object'&&typeof withUpdaterQuiescence==='function'&&installationId===transport.identity.installationId,'self-upgrade-configuration');
 const verifier=createUpdaterReleaseVerifier(trust),pins=structuredClone(transport.identity),key='updater-self-control';
 const identity={pins,trust:await sha256(new TextEncoder().encode(JSON.stringify({...trust,publicKey:[...trust.publicKey]})))};
 const primary=()=>database.withSession?database.withSession('first-primary'):database;
 async function idle(){
  const row=await primary().prepare(`SELECT state_json,
   (SELECT state FROM updater_maintenance WHERE installation_id=?) maintenance,
   (SELECT state_json FROM updater_job_maintenance WHERE installation_id=?) owner,
   (SELECT COUNT(*) FROM updater_job_holds WHERE installation_id=? AND state='active') holds,
   (SELECT COUNT(*) FROM updater_execution_permits WHERE installation_id=? AND state='active') permits,
   (SELECT COUNT(*) FROM updater_execution_operations o JOIN updater_execution_permits p ON p.permit_id=o.permit_id WHERE p.installation_id=? AND o.state='pending') pending
   FROM updater_state WHERE id=1 AND installation_id=?`).bind(...Array(6).fill(installationId)).first();
  check(row,'self-upgrade-app-state');const app=JSON.parse(row.state_json),owner=row.owner?JSON.parse(row.owner):null;
  check(app.format===1&&(!app.job||(['succeeded','recovered'].includes(app.job.status)&&!app.job.operation))&&row.maintenance==='open'&&(!owner||owner.phase==='open')&&row.holds===0&&row.permits===0&&row.pending===0,'self-upgrade-not-idle');return app;
 }
 async function authority(proof){check(typeof proof?.assertHeld==='function','self-upgrade-fence');await proof.assertHeld();await idle();await proof.assertHeld();}
 async function run(supplied,fn){check(supplied===capability,'self-upgrade-unauthorized');return withUpdaterQuiescence(async proof=>{await authority(proof);return fn(proof);});}
 async function read(){const row=await store.operation(key);check(row&&same(row.value.identity,identity)&&row.value.format===1,'self-upgrade-not-initialized');return row;}
 async function save(row,value,proof){await authority(proof);check(await store.replace(key,row.revision,value),'self-upgrade-conflict');return read();}
 const verify=r=>verifier.verify(...[unpack(r).manifestBytes,unpack(r).signatureBytes]);
 const view=value=>({installed:structuredClone(value.installed.metadata),job:value.job?{requestId:value.job.requestId,mode:value.job.mode,phase:value.job.phase,nextChunk:value.job.nextChunk??null,operationId:value.job.operationId??null}:null,chunkSize:ARTIFACT_CHUNK_BYTES});
 async function staged(release){const id=artifactKey(release),info=await store.info(id);check(info&&info.chunk_count===await store.nextChunk(id),'self-upgrade-artifact-incomplete');if(!info.sealed)await store.seal(id);return verifier.verifyArtifact(release,await store.read(id));}
 return Object.freeze({
  async status(supplied){check(supplied===capability,'self-upgrade-unauthorized');return view((await read()).value);},
  async initialize(supplied,input){return run(supplied,async proof=>{
   exact(input,['requestId','manifestBytes','signatureBytes','installed']);exact(input.installed,['updaterVersion','stateSchema','highestUpdaterSequence']);
   const release=await verifier.verify(input.manifestBytes,input.signatureBytes),m=release.manifest,app=await idle();
   check(input.installed.updaterVersion===m.version&&input.installed.stateSchema===m.targetStateSchema&&Number.isSafeInteger(input.installed.highestUpdaterSequence)&&input.installed.highestUpdaterSequence>=m.sequence&&app.installed.updaterVersion===m.version,'self-upgrade-bootstrap');
   check(/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId),'self-upgrade-request');
   const previous=await store.operation(key),releaseRecord=record(input.manifestBytes,input.signatureBytes);
   if(previous){const row=await read();check(row.value.bootstrap.requestId===input.requestId&&same(row.value.bootstrap.metadata,input.installed)&&same(row.value.bootstrap.release,releaseRecord),'self-upgrade-bootstrap-conflict');return view(row.value);}
   await authority(proof);check(await store.claim(key,{format:1,identity,bootstrap:{requestId:input.requestId,metadata:structuredClone(input.installed),release:releaseRecord},installed:{metadata:structuredClone(input.installed),release:releaseRecord,receipt:null},job:{requestId:input.requestId,mode:'bootstrap',phase:'staging',release:releaseRecord,nextChunk:0}}),'self-upgrade-conflict');return view((await read()).value);
  });},
  async admit(supplied,input){return run(supplied,async proof=>{
   exact(input,['requestId','manifestBytes','signatureBytes']);check(/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId),'self-upgrade-request');
   const release=await verifier.verify(input.manifestBytes,input.signatureBytes),row=await read(),value=structuredClone(row.value),releaseRecord=record(input.manifestBytes,input.signatureBytes);
   if(value.job?.requestId===input.requestId){check(same(value.job.release,releaseRecord),'self-upgrade-request-conflict');return view(value);}
   check(value.installed.receipt&&(!value.job||['accepted','recovered'].includes(value.job.phase)),'self-upgrade-busy');
   verifier.evaluateUpdate(release,value.installed.metadata);
   value.job={requestId:input.requestId,mode:'upgrade',phase:'staging',release:releaseRecord,nextChunk:0,prior:structuredClone(value.installed),operationId:crypto.randomUUID()};
   // Reservation, installed state and active owner move in one encrypted CAS.
   value.installed.metadata.highestUpdaterSequence=release.manifest.sequence;
   return view((await save(row,value,proof)).value);
  });},
  async writeChunk(supplied,input){const bytes=Uint8Array.from(input.bytes);return run(supplied,async proof=>{
   exact(input,['requestId','index','bytes']);const row=await read(),job=row.value.job;check(job?.requestId===input.requestId&&job.phase==='staging'&&Number.isSafeInteger(input.index)&&input.index>=0&&input.index<=job.nextChunk,'self-upgrade-chunk');
   const release=await verify(job.release),a=release.manifest.artifact,id=artifactKey(release);check(bytes.length===Math.min(ARTIFACT_CHUNK_BYTES,a.bytes-input.index*ARTIFACT_CHUNK_BYTES)&&bytes.length>0,'self-upgrade-chunk');
   await authority(proof);await store.begin({artifactId:id,bytes:a.bytes,digest:a.sha256});await store.writeChunk(id,input.index,bytes);
   const value=structuredClone(row.value);value.job.nextChunk=Math.max(job.nextChunk,input.index+1);return view((await save(row,value,proof)).value);
  });},
  async advance(supplied,{requestId}){return run(supplied,async proof=>{
   const row=await read(),value=structuredClone(row.value),job=value.job;check(job?.requestId===requestId,'self-upgrade-job');
   if(['accepted','recovered'].includes(job.phase))return view(value);
   const target=job.mode==='recovery'?job.prior.release:job.release,release=await verify(target);
   if(job.phase==='staging'){
    await staged(release);await authority(proof);
    if(job.mode==='bootstrap'){value.installed.receipt=await transport.inspect(unpack(target));value.job=null;return view((await save(row,value,proof)).value);}
    const prior=await transport.inspect(unpack(job.prior.release));check(same(prior.configuration,pins),'self-upgrade-prior-pins');job.prior.receipt=prior;job.phase='prepared';return view((await save(row,value,proof)).value);
   }
   if(job.phase==='prepared'||job.phase==='recovery-prepared'){
    const bytes=await staged(release);
    // Inspect the exact currently installed version, not only the requested target.
    const expected=job.mode==='recovery'?job.release:job.prior.release;
    const observed=await transport.inspect(unpack(expected));check(same(observed,job.mode==='recovery'?value.installed.receipt:job.prior.receipt),'self-upgrade-prior-drift');
    job.phase='dispatched';const dispatched=await save(row,value,proof);
    await transport.dispatch({record:unpack(target),bytes,operationId:job.operationId,assertAuthority:async()=>{await authority(proof);const latest=await read();check(latest.revision===dispatched.revision&&latest.value.job.phase==='dispatched'&&latest.value.job.operationId===job.operationId,'self-upgrade-dispatch-owner');}});
    return view((await read()).value);
   }
   if(job.phase==='dispatched'){
    const result=await transport.reconcile({record:unpack(target),operationId:job.operationId});if(result.outcome!=='applied')return view(value);
    check(result.receipt.manifestSha256===release.manifestSha256&&same(result.receipt.configuration,pins),'self-upgrade-receipt');
    value.installed={metadata:{updaterVersion:release.manifest.version,stateSchema:value.installed.metadata.stateSchema,highestUpdaterSequence:value.installed.metadata.highestUpdaterSequence},release:target,receipt:result.receipt};
    job.phase=job.mode==='recovery'?'recovered':'deployed';return view((await save(row,value,proof)).value);
   }
   check(job.phase==='deployed','self-upgrade-phase');return view(value);
  });},
  async accept(supplied,{requestId}){return run(supplied,async proof=>{
   const row=await read(),value=structuredClone(row.value);check(value.job?.requestId===requestId&&value.job.phase==='deployed','self-upgrade-not-deployed');
   // Explicit supervisor acceptance is not a synthesized health claim.
   await transport.inspect(unpack(value.installed.release));value.job.phase='accepted';return view((await save(row,value,proof)).value);
  });},
  async recover(supplied,{requestId,recoveryRequestId}){return run(supplied,async proof=>{
   check(/^[A-Za-z0-9_-]{1,128}$/.test(recoveryRequestId),'self-recovery-request');const row=await read(),value=structuredClone(row.value),job=value.job;
   if(job?.mode==='recovery'&&job.requestId===recoveryRequestId){check(job.failedRequestId===requestId,'self-recovery-conflict');return view(value);}
   check(job?.requestId===requestId&&job.mode==='upgrade'&&job.phase==='deployed'&&job.prior?.receipt,'self-recovery-unresolved');
   const prior=await verify(job.prior.release);check(prior.manifest.targetStateSchema===value.installed.metadata.stateSchema,'self-recovery-schema');await staged(prior);await transport.inspect(unpack(job.release));
   value.job={...job,requestId:recoveryRequestId,failedRequestId:requestId,mode:'recovery',phase:'recovery-prepared',operationId:crypto.randomUUID()};return view((await save(row,value,proof)).value);
  });},
 });
}

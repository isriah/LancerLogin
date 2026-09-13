import { createWriterFence } from './writer-fence.mjs';
import { createApplicationRestore } from './application-restore.mjs';
import { fromBase64 } from './checkpoint.mjs';
const check=value=>{if(!value)throw Error('restore-composition');};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createRuntimeRestore({pins,policy,database,updaterDatabase,artifacts,store,cipher,verifier,withClosedEpoch,token,fetch}){
 const capability={}, scopes=new Map();
 const select=names=>Object.fromEntries(names.map(name=>[name,pins[name]]));
 const release=raw=>({manifestBytes:fromBase64(raw.manifest),signatureBytes:fromBase64(raw.signature)});
 const writer=createWriterFence({pins:{...select(['installationId','applicationDatabaseId','accountId','worker','workerSettings','nonsecretBindings']),maintenanceService:policy.maintenanceService,secretBindings:policy.secretBindings},adoption:policy.adoption,coverage:policy.coverage,token,verifier,store:artifacts,fetch,
  withAuthority:async(request,callback)=>{const scope=scopes.get(request.holdId);check(scope&&same(scope.expected,request));return callback({...request,currentRelease:scope.currentRelease,priorRelease:scope.priorRelease});}});

 const transport=createApplicationRestore({pins:select(['installationId','applicationDatabaseId','updaterDatabaseId']),database,updaterDatabase,store:artifacts,cipher,verifier,capability,withWriterFence:writer.withWriterFence});
 async function run(context,readOnly=false){return withClosedEpoch({installationId:pins.installationId,operationId:context.operationId},async authority=>{
  const key=`restore-handoff:${context.jobId}`,row=await artifacts.operation(key);check(row&&row.value.recoveryJobId===context.jobId&&row.value.epoch===authority.epoch);check(!row.value.operationId||row.value.operationId===context.operationId);
  const expected={installationId:pins.installationId,applicationDatabaseId:pins.applicationDatabaseId,epoch:authority.epoch,jobId:context.jobId,operationId:context.operationId,holdId:authority.holdId};
  let checkpoint=context.checkpoint;if(!checkpoint){const current=(await store.read()).state;checkpoint=await cipher.open(current.checkpoint.jobId,current.checkpoint.envelope);}
  const currentRelease=row.value.failedJob.completed.some(entry=>entry.kind==='deployApi'&&!entry.failed)?row.value.failedJob.release:checkpoint.priorRelease;
  scopes.set(authority.holdId,{expected,currentRelease:release(currentRelease),priorRelease:release(checkpoint.priorRelease)});
  try{
  const prepared=row.value.fence?{value:{phase:'complete'}}:await artifacts.operation(`writer-fence:${context.operationId}`);
  if(prepared?.value.phase!=='complete'){if(readOnly)return {outcome:'unknown'};await writer.prepare(expected);return {outcome:'pending'};}
  if(!row.value.fence){if(readOnly)return {outcome:'unknown'};return await writer.withWriterFence(expected,async evidence=>{const fence=Object.fromEntries(['accountId','worker','manifestSha256','configurationSha256'].map(key=>[key,evidence[key]]));check(await artifacts.replace(key,row.revision,{...row.value,operationId:context.operationId,holdId:authority.holdId,fence}));return {outcome:'pending'};});}
  // Rotate only execution authority; readonly transport never changes restore cursor/data.
  if(row.value.holdId!==authority.holdId)check(await artifacts.replace(key,row.revision,{...row.value,holdId:authority.holdId}));
  return await transport[readOnly?'reconcile':'advance'](capability,{jobId:context.jobId,operationId:context.operationId});
  }finally{scopes.delete(authority.holdId);}
 });}
 return {
  recoveryQuiescence:true,restoreBackup:context=>run(context),continueRestore:(context,readOnly)=>run(context,readOnly),
  readRestoreHandoff:async jobId=>(await artifacts.operation(`restore-handoff:${jobId}`))?.value,
  async restoreHandoff({phase,current,epoch,request,archiveId}){
   if(phase==='archive'){
    check(current.job.status==='failed'&&!current.job.operation&&current.job.mode==='update');const checkpoint=await cipher.open(current.checkpoint.jobId,current.checkpoint.envelope);check(checkpoint.backup?.verified===true&&checkpoint.backup.identity.epoch===epoch&&checkpoint.backup.identity.jobId===current.job.id);
    const value={installationId:pins.installationId,failedJob:current.job,failedInstalled:current.installed,checkpointJobId:current.checkpoint.jobId,backupId:checkpoint.backup.backupId,backupSha256:checkpoint.backup.sha256,epoch,requestId:request.requestId},key=`restore-archive:${request.requestId}`;
    const row=await artifacts.operation(key);if(!row)await artifacts.claim(key,value);check(same((await artifacts.operation(key)).value,value));return key;
   }
   const archive=(await artifacts.operation(archiveId))?.value,job=current.job;check(archive&&archive.epoch===epoch&&job.mode==='restore'&&job.failedJobId===archive.failedJob.id&&job.checkpointJobId===archive.checkpointJobId&&job.requestId===archive.requestId&&!job.operation);
   const key=`restore-handoff:${job.id}`,value={...archive,recoveryJobId:job.id,operationId:null,holdId:null,fence:null},row=await artifacts.operation(key);if(!row)await artifacts.claim(key,value);else check(same(row.value,value));return key;
  },
 };
}

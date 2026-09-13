import {createSelfUpgradeExecutor} from './src/self-upgrade.mjs';

// Construct using retained trusted supervisor code outside the Worker being replaced.
// No imports, HTTP calls or health responses from that Worker are required.
// This module supplies no credential acquisition or quiescence implementation.
export async function createUpdaterSelfRecovery(trustedDependencies){
 const executor=await createSelfUpgradeExecutor(trustedDependencies);
 return Object.freeze({status:executor.status,recover:executor.recover,async advance(capability,request){
  const {job}=await executor.status(capability);
  if(!job||job.requestId!==request.requestId||(job.mode!=='recovery'&&!['dispatched','deployed'].includes(job.phase)))throw Error('self-recovery-unresolved');
  return executor.advance(capability,request);
 }});
}

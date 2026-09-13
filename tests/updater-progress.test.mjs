import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryProgress } from '../apps/updater/recovery-progress.mjs';
import { normalizedRecoveryLink } from '../apps/dashboard/src/recovery-link.ts';
const current = () => ({ job: { id:'job-1',status:'running',step:'backup',completedSteps:2,operationId:'operation-1' }, maintenance:{state:'closed',phase:'closed'} });
function fixture() {
  let state=current(), visible=true, reads=0, advances=0, advance=async()=>state, now=0; const timers=new Map(), messages=[];let next=0;
  const controller=createRecoveryProgress({read:async()=>{reads++;return state;},advance:async id=>{assert.equal(id,'job-1');advances++;return advance();},show:()=>{},notice:value=>messages.push(value),visible:()=>visible,now:()=>now,later:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},cancel:id=>timers.delete(id)});
  controller.accept(state);
  return {controller,messages,timers,get reads(){return reads;},get advances(){return advances;},set now(value){now=value;},set state(value){state=value;},set advance(value){advance=value;},hide(){visible=false;controller.visibilityChanged();},show(){visible=true;controller.visibilityChanged();},async tick(){const entry=timers.entries().next().value;if(entry){timers.delete(entry[0]);entry[1].fn();}await new Promise(resolve=>setImmediate(resolve));}};
}

test('confirmed advance uses250ms while uncertain response and reconciliation retain slower backoff',async()=>{
  const f=fixture();f.controller.arm('job-1');await f.tick();await f.tick();assert.equal([...f.timers.values()][0].ms,250);
  f.advance=async()=>{throw Error('unknown');};await f.tick();assert.equal([...f.timers.values()][0].ms,4000);
  await f.tick();assert.equal([...f.timers.values()][0].ms,1000,'readback alone is not confirmed advancement');
  f.advance=async()=>({...current(),job:{...current().job,status:'reconciling'}});await f.tick();assert.equal([...f.timers.values()][0].ms,2000);
});

test('expiry stops future dispatch while observing the current response and reauthentication never arms',async()=>{
  const f=fixture(), value={...current(),expiresAt:10};f.state=value;f.controller.accept(value);f.controller.arm('job-1');await f.tick();let settle;f.advance=()=>new Promise(resolve=>{settle=resolve;});await f.tick();assert.equal(f.advances,1);
  f.now=10000;assert.equal(f.controller.checkExpiry(),true);assert.equal(f.controller.active(),false);const flight=f.controller.refresh();settle(value);await flight;assert.equal(f.timers.size,0);assert.equal(f.advances,1);
  const renewed={...value,expiresAt:910};f.state=renewed;await f.controller.action(async()=>renewed);assert.equal(f.controller.active(),false);await f.tick();assert.equal(f.advances,1);
  f.controller.arm('job-1');await f.tick();await f.tick();assert.equal(f.advances,2);
});
test('explicit job arming, hidden/manual pause retain one underlying flight and require visible readback',async()=>{
  const f=fixture();await f.tick();assert.equal(f.advances,0);f.controller.arm('other');assert.equal(f.timers.size,0);
  f.controller.arm('job-1');await f.tick();assert.equal(f.reads,1);let settle;f.advance=()=>new Promise(resolve=>{settle=resolve;});await f.tick();assert.equal(f.advances,1);
  f.hide();f.show();await f.tick();assert.equal(f.advances,1);f.controller.pause();const refresh=f.controller.refresh();assert.equal(f.reads,1);settle(current());await refresh;await f.tick();assert.equal(f.advances,1);assert.equal(f.controller.active(),false);
});
test('lost response reads status before same-job continuation, then stops on different job',async()=>{
  const f=fixture();f.controller.arm('job-1');await f.tick();f.advance=async()=>{throw Error('lost');};await f.tick();assert.equal(f.advances,1);await f.tick();assert.equal(f.reads,2);assert.equal(f.advances,1);
  f.state={...current(),job:{...current().job,id:'other'}};f.hide();f.show();await f.tick();assert.equal(f.controller.active(),false);assert.equal(f.advances,1);
});
test('unchanged reconciliation has bounded backoff and401 requires explicit reauthentication',async()=>{
  const f=fixture();f.state={...current(),job:{...current().job,status:'reconciling'}};f.controller.arm('job-1');await f.tick();for(let i=0;i<6;i++)await f.tick();assert.equal(f.advances,6);assert.equal(f.controller.active(),false);assert.ok(f.messages.at(-1).includes('not progressed'));
  const g=fixture();g.controller.arm('job-1');await g.tick();g.advance=async()=>{throw Object.assign(Error('expired'),{status:401});};await g.tick();assert.equal(g.controller.active(),false);assert.ok(g.messages.at(-1).includes('Sign in again'));
});
test('terminal code status continues maintenance reopening until authoritative open',async()=>{
  const f=fixture();f.state={...current(),job:{...current().job,status:'succeeded'},maintenance:{state:'closed',phase:'reopening'}};f.controller.accept({...current(),job:{...current().job,status:'succeeded'},maintenance:{state:'closed',phase:'reopening'}});f.controller.arm('job-1');await f.tick();await f.tick();assert.equal(f.advances,1);assert.equal(f.controller.active(),true);
  f.state={...current(),job:{...current().job,status:'succeeded'},maintenance:{state:'open',phase:'open'}};await f.tick();assert.equal(f.controller.active(),false);assert.equal(f.timers.size,0);
});
test('cached recovery bridge accepts only normalized HTTPS fixed-path navigation',()=>{
  assert.equal(normalizedRecoveryLink('https://recovery.example.invalid/recovery'),'https://recovery.example.invalid/recovery');
  for(const value of ['http://recovery.example.invalid/recovery','https://user@recovery.example.invalid/recovery','https://recovery.example.invalid/recovery?job=1','https://recovery.example.invalid/recovery#arm','https://recovery.example.invalid/other','javascript:alert(1)'])assert.equal(normalizedRecoveryLink(value),undefined);
});
test('manual pause while recovery acknowledgment is pending suppresses later automatic arming',async()=>{
  const f=fixture();let settle;const action=f.controller.action(()=>new Promise(resolve=>{settle=resolve;}),value=>value.job.id);await new Promise(resolve=>setImmediate(resolve));f.controller.pause();settle(current());await action;await f.tick();assert.equal(f.controller.active(),false);assert.equal(f.advances,0);assert.equal(f.timers.size,0);
});

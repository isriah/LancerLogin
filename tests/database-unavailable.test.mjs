import test from 'node:test';
import assert from 'node:assert/strict';
import {isDailyD1ReadQuota} from '../apps/api/src/database-unavailable.ts';
import worker from '../apps/api/src/index.ts';
const quota="Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC)";
const observed=quota+'. See https://developers.cloudflare.com/d1/platform/limits/ for more details.';
const known=()=>new Error('D1_ERROR: '+observed);
test('D1 quota classifier requires exact wording and structured provenance with a bounded cause walk',()=>{
 for(const error of [known(),new Error('D1_ERROR',{cause:new Error(quota)}),Object.assign(new Error(quota),{code:7500}),Object.assign(new Error(observed),{code:7500}),new Error('wrapper',{cause:known()})])assert.equal(isDailyD1ReadQuota(error),true);
 for(const error of [new Error(quota),{code:7500,message:quota},new Error('D1_ERROR: quota exceeded'),new Error('D1_ERROR: '+quota+' synthetic-secret'),new Error('D1_ERROR: '+quota.replace('row read','row write')),Object.assign(new Error(quota),{code:'7500'}),new Error('provider quota words',{cause:{code:7500,message:quota}})])assert.equal(isDailyD1ReadQuota(error),false);
 const circular=new Error('D1_ERROR');circular.cause=circular;assert.equal(isDailyD1ReadQuota(circular),false);let deep=known();for(let i=0;i<6;i++)deep=new Error('wrapper',{cause:deep});assert.equal(isDailyD1ReadQuota(deep),false);
 let touched=false;const hostile=new Error('unknown');Object.defineProperty(hostile,'cause',{get(){touched=true;throw Error();}});assert.equal(isDailyD1ReadQuota(hostile),false);assert.equal(touched,false);
});
test('actual Worker boundary sanitizes quota at either setup query and local sign-in without retrying D1',async()=>{
 for(const path of ['/setup/status','/auth/local'])for(const failureAt of path==='/setup/status'?[1,2]:[1]){
  let reads=0;const env={DB:{prepare(){return {bind(){return this;},async first(){if(++reads===failureAt)throw known();return {id:'primary',authMode:'local'};}};}},ALLOWED_ORIGIN:'https://fixture.test',SESSION_KEY:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',APP_MODE:'unconfigured'};
  const response=await worker.fetch(new Request('https://api.test'+path,{method:path==='/auth/local'?'POST':'GET',headers:{origin:env.ALLOWED_ORIGIN,'content-type':'application/json'},...(path==='/auth/local'?{body:JSON.stringify({username:'synthetic',password:'synthetic-password'})}:{})}),env);
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'The service is temporarily unavailable. Please try again later.',code:'database_temporarily_unavailable'});assert.equal(reads,failureAt);assert.equal(response.headers.get('access-control-allow-origin'),env.ALLOWED_ORIGIN);
 }
});
test('unknown database failures preserve the configured Worker generic 500',async()=>{
 const env={DB:{prepare(){throw new Error('synthetic-private-SQL quota exceeded');}},APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
 const response=await worker.fetch(new Request('https://api.test/setup/status'),env);assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'Request failed'});
});

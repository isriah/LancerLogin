import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrationStatements } from './migration-statements.mjs';
import { hashPassword, verifyPassword } from '../apps/api/src/runtime-security.ts';
import { hashApiPassword, verifyApiPassword, passwordComputationRequest, PasswordComputation, PasswordComputationGate, canonicalPasswordHash } from '../apps/api/src/password-computation.ts';
const secret=Buffer.alloc(32,7).toString('base64url'),password='Synthetic test password only';
const baseEnv={SESSION_KEY:secret,PASSWORD_COMPUTATION_MODE:'durable'};
const signed=(input)=>{const body=JSON.stringify(input),digest=createHash('sha256').update(body).digest('base64url'),signature=createHmac('sha256',Buffer.from(secret,'base64url')).update('LancerLogin/password-computation/v1\n'+digest).digest('base64url');return new Request('https://password.internal/compute',{method:'POST',headers:{'content-type':'application/json','x-ll-password-auth':signature},body});};

test('standard inline compatibility and configured failures never fall back to HTTP scrypt',async()=>{
 const encoded=await hashApiPassword({},password,'user-create');assert.ok(canonicalPasswordHash(encoded));assert.equal(await verifyApiPassword({},password,encoded),true);assert.equal(await verifyPassword(password,encoded),true);
 for(const env of [{PASSWORD_COMPUTATION_MODE:'durable'},{PASSWORD_COMPUTATION_MODE:'invented'},{...baseEnv,PASSWORD_COMPUTATION:{idFromName:()=>0,get:()=>({fetch:()=>{throw Error('synthetic private failure');}})}}])await assert.rejects(()=>verifyApiPassword(env,password,encoded),error=>error.status===503&&!error.message.includes('private'));
 const resultEnv=response=>({...baseEnv,PASSWORD_COMPUTATION:{idFromName:()=>0,get:()=>({fetch:async()=>response})}});
 for(const response of [new Response('private downstream details',{status:500}),Response.json({version:1,requestId:'other',operation:'verify',value:true}),new Response('x'.repeat(513))])await assert.rejects(()=>verifyApiPassword(resultEnv(response),password,encoded),error=>error.status===503);
});

test('deadline aborts binding request; a late response cannot authorize a caller', {timeout:10000},async()=>{
 let aborted=false,finish;const env={...baseEnv,PASSWORD_COMPUTATION:{idFromName:()=>0,get:()=>({fetch:request=>{request.signal.addEventListener('abort',()=>aborted=true);return new Promise(resolve=>{finish=async()=>{const dto=await request.json();resolve(Response.json({version:2,requestId:dto.requestId,operation:'verify',value:true}));};});}})}};
 let success=false;await assert.rejects(async()=>{await verifyApiPassword(env,password,null);success=true;},error=>error.status===503);assert.equal(aborted,true);await finish();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(success,false);
});

test('private DTO authorization, expiry, replay, bounds and storage-free computation',async()=>{
 const state=new Proxy({}, {get(){throw Error('Password service touched durable state');}}),instance=new PasswordComputation(state,baseEnv);
 assert.equal((await instance.fetch(new Request('https://password.internal/compute',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}))).status,403);
 const req=await passwordComputationRequest(baseEnv,{operation:'hash',purpose:'first-admin',password});const response=await instance.fetch(req.clone());assert.equal(response.status,200);assert.ok(canonicalPasswordHash((await response.json()).value));assert.equal((await instance.fetch(req.clone())).status,409);
 const original=JSON.parse(await(await passwordComputationRequest(baseEnv,{operation:'verify',purpose:'local-login',password,encoded:null})).text());
 for(const change of [v=>v.purpose='user-create',v=>v.operation='arbitrary',v=>v.installationId='other',v=>v.expiresAt=0,v=>v.expiresAt=Date.now()+60000,v=>v.cost=1,v=>v.encoded='scrypt$1$8$1$x$x',v=>v.password='x'.repeat(262145)]){const input=structuredClone(original);input.requestId=crypto.randomUUID();change(input);assert.equal((await instance.fetch(signed(input))).status,400);}
 const tampered=new Request(req.url,{method:'POST',headers:req.headers,body:(await req.clone().text()).replace('first-admin','user-create')});assert.equal((await instance.fetch(tampered)).status,403);
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(264193));},cancel(){cancelled=true;}});const oversized=new Request(req.url,{method:'POST',headers:req.headers,body:stream,duplex:'half'});assert.equal((await instance.fetch(oversized)).status,503);assert.equal(cancelled,true);
 await assert.rejects(()=>passwordComputationRequest(baseEnv,{operation:'hash',purpose:'password-reset',password:'x'.repeat(262145)}));
 // JSON escaping must fit every password representable in the original API envelope.
 const escaped='\n'.repeat(120000),large=await passwordComputationRequest(baseEnv,{operation:'hash',purpose:'password-reset',password:escaped});assert.ok((await large.text()).length<264192);
});

test('stalled internal request and response bodies are cancelled within fixed deadlines', {timeout:10000},async()=>{
 let cancelled=false;const instance=new PasswordComputation({},baseEnv);
 const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;return new Promise(()=>{});}});
 let responseCancelled=false,resolveCancelled;const cancellation=new Promise(resolve=>resolveCancelled=resolve);
 const stalledResponse=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){responseCancelled=true;resolveCancelled();}}));
 const env={...baseEnv,PASSWORD_COMPUTATION:{idFromName:()=>0,get:()=>({fetch:async()=>stalledResponse})}};
 const [response]=await Promise.all([instance.fetch(new Request('https://password.internal/compute',{method:'POST',headers:{'content-type':'application/json','x-ll-password-auth':'a'.repeat(43)},body:stream,duplex:'half'})),assert.rejects(()=>verifyApiPassword(env,password,null),error=>error.status===503)]);
 assert.equal(response.status,503);assert.equal(cancelled,true);
 await Promise.race([cancellation,new Promise(resolve=>setTimeout(resolve,1000))]);assert.equal(responseCancelled,true);
});


test('bounded gate admits one active computation and two waiters; expired work never starts',async()=>{
 const gate=new PasswordComputationGate(),order=[];await gate.enter(Date.now()+1000);order.push(1);
 const second=gate.enter(Date.now()+1000).then(()=>order.push(2));const third=gate.enter(Date.now()+1000).then(()=>order.push(3));
 await assert.rejects(()=>gate.enter(Date.now()+1000),error=>error.status===503);assert.deepEqual(order,[1]);gate.leave();await second;assert.deepEqual(order,[1,2]);gate.leave();await third;assert.deepEqual(order,[1,2,3]);gate.leave();
 await gate.enter(Date.now()+1000);let ran=false;await assert.rejects(async()=>{await gate.enter(Date.now()+20);ran=true;},error=>error.status===503);gate.leave();assert.equal(ran,false);await gate.enter(Date.now()+1000);gate.leave();
});

test('actual workerd private DO and D1 preserve bootstrap, existing passwords, Staff lifecycle and lockouts', {timeout:60000},async()=>{
 const fixture=`import worker from './apps/api/src/index.ts';import {PasswordComputation} from './apps/api/src/password-computation.ts';
 export class FixturePassword extends PasswordComputation{constructor(state,env){super(state,env);this.fixtureStorage=state.storage;this.fixtureEnv=env;}async fetch(req){if(req.url==='https://password.internal/fixture-storage'){return Response.json({keys:(await this.fixtureStorage.list()).size,alarm:await this.fixtureStorage.getAlarm()});}const result=await super.fetch(req);const race=await this.fixtureEnv.DB.prepare('SELECT action,encoded FROM fixture_password_race').first();if(race){if(race.action==='password')await this.fixtureEnv.DB.prepare("UPDATE users SET password_hash=? WHERE local_username='staff'").bind(race.encoded).run();if(race.action==='active')await this.fixtureEnv.DB.prepare("UPDATE users SET active=0 WHERE local_username='staff'").run();if(race.action==='role')await this.fixtureEnv.DB.prepare("UPDATE users SET role='operator' WHERE local_username='staff'").run();await this.fixtureEnv.DB.prepare('DELETE FROM fixture_password_race').run();}return result;}}
 export default {fetch(req,env,ctx){if(new URL(req.url).pathname==='/fixture-unavailable')return worker.fetch(new Request('https://fixture.invalid/auth/local',req),{...env,PASSWORD_COMPUTATION:undefined},ctx);if(new URL(req.url).pathname==='/fixture-storage')return env.PASSWORD_COMPUTATION.get(env.PASSWORD_COMPUTATION.idFromName('primary')).fetch(new Request('https://password.internal/fixture-storage'));return worker.fetch(req,env,ctx);}};`;
 const bundle=await build({stdin:{contents:fixture,resolveDir:resolve('.')},bundle:true,format:'esm',platform:'browser',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-01',bindings:{...baseEnv,APP_MODE:'unconfigured',ALLOWED_ORIGIN:'https://fixture.invalid',BOOTSTRAP_CODE_HASH:createHash('sha256').update('synthetic-setup-code').digest('base64url')},durableObjects:{PASSWORD_COMPUTATION:{className:'FixturePassword',useSQLite:true}},d1Databases:['DB'],telemetry:{enabled:false}}));
 const call=(path,body,cookie,method=body?'POST':'GET')=>mf.dispatchFetch('https://fixture.invalid'+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const db=await mf.getD1Database('DB'),migrations=new URL('../apps/api/migrations/',import.meta.url);for(const file of readdirSync(migrations).filter(v=>v.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(file,migrations),'utf8')).map(sql=>db.prepare(sql)));
  await db.prepare('CREATE TABLE fixture_password_race(action TEXT,encoded TEXT)').run();
  assert.equal((await call('/compute',{operation:'hash',password})).status,404);
  const bootstrap={setupCode:'synthetic-setup-code',organizationName:'Synthetic test',timeZone:'UTC',authMode:'local',localUsername:'admin',localPassword:password,telemetryAccepted:false};
  assert.equal((await call('/setup/bootstrap',{...bootstrap,setupCode:'wrong'})).status,403);let result=await call('/setup/bootstrap',bootstrap);assert.equal(result.status,201,await result.clone().text());
  const admin=await db.prepare("SELECT id,password_hash FROM users WHERE local_username='admin'").first();assert.equal(await verifyPassword(password,admin.password_hash),true);
  // Old inline-generated hash with a password longer than 1024 bytes remains usable.
  const longPassword='Synthetic-'.repeat(300),legacy=await hashPassword(longPassword,new Uint8Array(16).fill(9));await db.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(legacy,admin.id).run();
  result=await call('/auth/local',{username:'admin',password:longPassword});assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0];assert.equal((await call('/auth/session',null,cookie)).status,200);
  assert.equal((await call('/auth/local',{username:'unknown',password})).status,401);assert.equal((await call('/auth/local',{username:'admin',password:'wrong'})).status,401);
  assert.equal((await db.prepare('SELECT failed_login_count n FROM users WHERE id=?').bind(admin.id).first()).n,1);
  result=await call('/admin/users',{localUsername:'staff',localPassword:password,role:'staff'},cookie);assert.equal(result.status,201,await result.clone().text());const staff=(await result.json()).user.id;
  result=await call('/auth/local',{username:'staff',password});assert.equal(result.status,200);const staffCookie=result.headers.get('set-cookie').split(';')[0];assert.equal((await call('/admin/users',{localUsername:'forbidden',localPassword:password,role:'staff'},staffCookie)).status,403);
  const reset='Synthetic replacement password';assert.equal((await call('/admin/users/'+staff,{localPassword:reset},cookie,'PATCH')).status,200);assert.equal((await call('/auth/local',{username:'staff',password})).status,401);assert.equal((await call('/auth/local',{username:'staff',password:reset})).status,200);
  await db.prepare("UPDATE users SET failed_login_count=5,locked_until='2099-01-01T00:00:00Z' WHERE id=?").bind(staff).run();assert.equal((await call('/auth/local',{username:'staff',password:reset})).status,401);assert.equal((await db.prepare('SELECT failed_login_count n FROM users WHERE id=?').bind(staff).first()).n,5);
  // Fixture-only DO hook mutates D1 after actual scrypt completes but before
  // the computation response returns, exercising the new authority boundary.
  const currentHash=(await db.prepare('SELECT password_hash FROM users WHERE id=?').bind(staff).first()).password_hash;
  for(const action of ['password','active','role']){
   await db.prepare("UPDATE users SET active=1,role='staff',password_hash=?,failed_login_count=3,locked_until=NULL WHERE id=?").bind(currentHash,staff).run();
   await db.prepare('INSERT INTO fixture_password_race(action,encoded) VALUES (?,?)').bind(action,legacy).run();
   result=await call('/auth/local',{username:'staff',password:reset});assert.equal(result.status,401);assert.equal(result.headers.get('set-cookie'),null);assert.equal((await db.prepare('SELECT failed_login_count n FROM users WHERE id=?').bind(staff).first()).n,3);
  }
  result=await call('/fixture-unavailable',{username:'admin',password:longPassword});assert.equal(result.status,503);assert.equal(result.headers.get('set-cookie'),null);assert.equal((await db.prepare('SELECT failed_login_count n FROM users WHERE id=?').bind(admin.id).first()).n,1);
  const storage=await(await call('/fixture-storage')).json();assert.deepEqual(storage,{keys:0,alarm:null});
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});

test('v2 independent clocks enforce bounded skew, lifetime and full replay horizon',async()=>{
 const realNow=Date.now,issuedAt=realNow(),encoded=await hashPassword(password);
 const instance=new PasswordComputation({},baseEnv);
 try{
  for(const offset of [-1000,1000]){
   Date.now=()=>issuedAt;const request=await passwordComputationRequest(baseEnv,{operation:'verify',purpose:'local-login',password,encoded});
   Date.now=()=>issuedAt+offset;const response=await instance.fetch(request);assert.equal(response.status,200);assert.equal((await response.json()).value,true);
  }
  Date.now=()=>issuedAt;const request=await passwordComputationRequest(baseEnv,{operation:'verify',purpose:'local-login',password,encoded}),dto=await request.clone().json();
  for(const offset of [-1001,6000]){Date.now=()=>issuedAt+offset;const response=await instance.fetch(request.clone());assert.equal(response.status,400);assert.equal(response.headers.get('x-ll-password-error'),'envelope-time');}
  Date.now=()=>issuedAt;
  for(const change of [v=>v.version=1,v=>delete v.issuedAt,v=>v.issuedAt=Number.MAX_SAFE_INTEGER+1,v=>v.expiresAt=Number.MAX_SAFE_INTEGER,v=>v.expiresAt++,v=>v.issuedAt--]){const input=structuredClone(dto);change(input);assert.equal((await instance.fetch(signed(input))).status,400);}
  // Behind-clock admission caps work at +4000 caller time, but replay remains
  // fenced through +6000, including after that work budget has elapsed.
  Date.now=()=>issuedAt-1000;assert.equal((await instance.fetch(request.clone())).status,200);
  Date.now=()=>issuedAt+5999;assert.equal((await instance.fetch(request.clone())).status,409);
  Date.now=()=>issuedAt+6000;assert.equal((await instance.fetch(request.clone())).status,400);
 }finally{Date.now=realNow;}
});

test('API logs only fixed categories, never arbitrary internal header or exception text',async()=>{
 const warnings=[],warn=console.warn;console.warn=(...values)=>warnings.push(values);
 try{
  for(const reason of ['envelope-time','synthetic private detail','constructor','',null]){
   const env={...baseEnv,PASSWORD_COMPUTATION:{idFromName:()=>0,get:()=>({fetch:async()=>new Response('synthetic private body',{status:400,headers:reason===null?{}:{'x-ll-password-error':reason}})})}};
   await assert.rejects(()=>verifyApiPassword(env,password,null),error=>error.status===503&&error.message==='Password service unavailable; try again later');
  }
  const env={...baseEnv,PASSWORD_COMPUTATION:{idFromName:()=>0,get:()=>({fetch:async()=>{throw Error('synthetic private exception');}})}};
  await assert.rejects(()=>verifyApiPassword(env,password,null));
  assert.deepEqual(warnings,[['password-computation failure','internal-envelope-time'],...Array.from({length:4},()=>['password-computation failure','internal-unclassified']),['password-computation failure','binding-fetch']]);
 }finally{console.warn=warn;}
});

test('sequential private computations release the isolate gate after every success',async()=>{
 const instance=new PasswordComputation({},baseEnv),encoded=await hashPassword(password);
 for(let index=0;index<4;index++){
  const response=await instance.fetch(await passwordComputationRequest(baseEnv,{operation:'verify',purpose:'local-login',password,encoded}));
  assert.equal(response.status,200);assert.equal((await response.json()).value,true);assert.equal(response.headers.get('x-ll-password-error'),null);
 }
});

test('caller rejects otherwise valid v2 output after its original signed expiry',async()=>{
 const realNow=Date.now,now=realNow();
 const env={...baseEnv,PASSWORD_COMPUTATION:{idFromName:()=>0,get:()=>({fetch:async request=>{const dto=await request.json();Date.now=()=>dto.expiresAt;return Response.json({version:2,requestId:dto.requestId,operation:'verify',value:true});}})}};
 try{Date.now=()=>now;await assert.rejects(()=>verifyApiPassword(env,password,null),error=>error.status===503);}finally{Date.now=realNow;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import worker, { PlatformScheduler } from '../apps/api/src/index.ts';
import { runApplication, providerFetch } from '../apps/api/src/maintenance.ts';
import { schedulerClass } from '../apps/api/src/platform-scheduler.ts';
import { createMaintenanceCore } from '../apps/updater/src/maintenance.mjs';
import { createMaintenanceService } from '../apps/updater/maintenance-service.mjs';
import { signMaintenanceRequest } from '../packages/shared/src/updater/maintenance-auth.ts';
import { discordRequest } from '../apps/api/src/discord-platform.ts';
import { pickerProvider } from '../apps/api/src/google-drive-picker.ts';
import { validateGoogleIdentity } from '../apps/api/src/google-connection.ts';
import { editPrivateInteraction } from '../apps/api/src/discord-interaction-reply.ts';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'maintenance-app-')),db=new DatabaseSync(join(dir,'updater.sqlite')),app=new DatabaseSync(join(dir,'app.sqlite'));
 for(const name of ['0005_updater_maintenance.sql','0006_updater_execution_proofs.sql'])db.exec(readFileSync(new URL('../apps/updater/state/'+name,import.meta.url),'utf8'));
 app.exec('CREATE TABLE data(value TEXT UNIQUE);');
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;db.close();app.close();rmSync(dir,{recursive:true,force:true});});
 const adapt=(sqlite,wrap=false)=>({prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},async first(){return sqlite.prepare(sql).get(...args)??null;},async run(){try{sqlite.prepare(sql).run(...args);return {success:true};}catch(error){if(wrap&&error.errcode%256===19)throw new Error('D1_ERROR: '+error.message+': SQLITE_CONSTRAINT');throw error;}},async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};}};return statement;}});
 const execution={},maintenance={},secret='7'.repeat(64),installation='synthetic';
 const database=adapt(db);database.withSession=mode=>{assert.equal(mode,'first-primary');return adapt(db);};
 const core=createMaintenanceCore({database,installationId:installation,executionCapability:execution,maintenanceCapability:maintenance,readReopenEvidence:async context=>({...context,jobTerminal:true,healthVerified:true})});
 await core.initialize(maintenance);
 const service=createMaintenanceService({core,capability:execution,installationId:installation,appSecret:secret});
 const control={lose:null,calls:[]};
 const env={APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.invalid',DB:adapt(app,true),MAINTENANCE_APP_KEY:secret,MAINTENANCE_INSTALLATION_ID:installation,MAINTENANCE:{async fetch(request){const action=new URL(request.url).pathname.split('/').at(-1);control.calls.push(action);const response=await service.fetch(request);if(control.lose===action){control.lose=null;throw Error('lost acknowledgment');}return response;}}};
 return {db,app,core,maintenance,service,env,control,secret,installation,close:()=>core.close(maintenance,{epoch:0,jobId:'job'})};
}
test('private lifecycle proof is hashed, bound to epoch/installation, and cannot readmit or force-clear',async t=>{
 const f=await fixture(t),permitId=crypto.randomUUID(),proof='9'.repeat(64);
 const request=()=>signMaintenanceRequest(f.secret,f.installation,'admit',{permitId,proof});
 assert.equal((await (await f.service.fetch(await request())).json()).status,'admitted');
 assert.equal((await (await f.service.fetch(await request())).json()).status,'not-admitted');
 const row=f.db.prepare('SELECT release_hash FROM updater_execution_permits').get();assert.notEqual(row.release_hash,proof);assert.equal(row.release_hash.length,64);
 for(const body of [{permitId,epoch:0,proof:'8'.repeat(64)},{permitId,epoch:1,proof}])assert.equal((await f.service.fetch(await signMaintenanceRequest(f.secret,f.installation,'release',body))).status,503);
 assert.equal((await f.service.fetch(await signMaintenanceRequest(f.secret,'wrong','release',{permitId,epoch:0,proof}))).status,503);
 assert.equal((await f.service.fetch(new Request('https://maintenance.internal/private/maintenance/release',{method:'POST',body:JSON.stringify({role:'admin',permitId})}))).status,503);
 await f.close();assert.equal((await f.core.ready(f.maintenance,1)).state,'draining');
 assert.equal((await f.service.fetch(await signMaintenanceRequest(f.secret,f.installation,'release',{permitId,epoch:0,proof}))).status,200);
 assert.equal((await f.core.ready(f.maintenance,1)).state,'closed');
});
test('lost admission acknowledgment executes no handler and cannot clear its orphan; partial config fails closed',async t=>{
 const f=await fixture(t);let calls=0;f.control.lose='admit';
 await assert.rejects(runApplication(f.env,undefined,async()=>{calls++;}));assert.equal(calls,0);
 await f.close();assert.equal((await f.core.ready(f.maintenance,1)).state,'draining');
 await assert.rejects(runApplication({MAINTENANCE_APP_KEY:f.secret},undefined,async()=>{calls++;}));assert.equal(calls,0);
});
test('scoped SQL, expected constraint failure and nested background work release with two lifecycle writes',async t=>{
 const f=await fixture(t),later=deferred(),nested=deferred(),drains=[];let retained;
 const result=await runApplication(f.env,{waitUntil:p=>drains.push(p)},async(env,context)=>{
  assert.equal(env.MAINTENANCE,undefined);assert.equal(env.MAINTENANCE_APP_KEY,undefined);
  retained=env.DB.prepare('INSERT INTO data VALUES(?)').bind('one');await retained.run();
  await assert.rejects(retained.run(),/SQLITE_CONSTRAINT/);
  context.waitUntil(later.promise.then(()=>{context.waitUntil(nested.promise);}));return 42;
 });
 assert.equal(result,42);await f.close();assert.equal((await f.core.ready(f.maintenance,1)).state,'draining');
 later.resolve();await later.promise;assert.equal((await f.core.ready(f.maintenance,1)).state,'draining');nested.resolve();await Promise.all(drains);
 assert.equal((await f.core.ready(f.maintenance,1)).state,'closed');assert.throws(()=>retained.run(),/revoked/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM updater_execution_operations').get().n,0);
 assert.deepEqual(f.control.calls,['admit','release']);assert.equal(f.app.prepare('SELECT count(*) AS n FROM data').get().n,1);
});
test('deadline-raced provider body remains tracked, known synchronous response drains, 202 stays ambiguous',async t=>{
 const f=await fixture(t),body=deferred(),entered=deferred(),drains=[];let retained;
 globalThis.fetch=async()=>{entered.resolve();return new Response(new ReadableStream({async start(controller){await body.promise;controller.enqueue(new TextEncoder().encode('{"id":"synthetic"}'));controller.close();}}),{status:200});};
 await runApplication(f.env,{waitUntil:p=>drains.push(p)},async env=>{
  retained=providerFetch(env);const call=retained('https://discord.com/api/v10/channels/123/messages',{method:'POST',body:'{}'});await entered.promise;
  assert.equal(await Promise.race([call,Promise.resolve('deadline')]),'deadline');
 });
 await f.close();assert.equal((await f.core.ready(f.maintenance,1)).state,'draining');body.resolve();await Promise.all(drains);assert.equal((await f.core.ready(f.maintenance,1)).state,'closed');
 assert.throws(()=>retained('https://discord.com/api/v10/channels/123/messages',{method:'POST'}),/revoked/);
 await f.core.reopen(f.maintenance,1);globalThis.fetch=async()=>new Response('{}',{status:202});
 await runApplication(f.env,undefined,async env=>{await providerFetch(env)('https://discord.com/api/v10/channels/123/messages',{method:'POST'});});
 await f.core.close(f.maintenance,{epoch:1,jobId:'second'});assert.equal((await f.core.ready(f.maintenance,2)).state,'draining');
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM updater_execution_operations WHERE state='pending'").get().n,1);
});
test('actual HTTP auth, cron and scheduler auth/alarm reject before application DB access during maintenance',async t=>{
 const f=await fixture(t);await f.close();await f.core.ready(f.maintenance,1);let queries=0;
 const env={...f.env,DB:{prepare(){queries++;throw Error('should not access app');}},PLATFORM_SCHEDULER_MODE:'durable'};
 assert.equal((await worker.fetch(new Request('https://api.invalid/admin/updater/status'),env)).status,503);
 assert.equal((await worker.fetch(new Request('https://api.invalid/auth/local',{method:'POST',body:'{}'}),env)).status,503);
 assert.equal((await worker.fetch(new Request('https://api.invalid/health'),env)).status,200);
 await assert.rejects(worker.scheduled({cron:'*/5 * * * *'},env));
 const scheduler=new PlatformScheduler({storage:{get:async()=>undefined,deleteAlarm:async()=>{}}},env);
 await assert.rejects(scheduler.fetch(new Request('https://scheduler.internal/status')));await scheduler.alarm();assert.equal(queries,0);
});
test('scheduler execution includes authorization, enabled predicate and prepared budget environment',async t=>{
 const f=await fixture(t);let saved,alarm,prepared=0;
 const storage={get:async()=>saved,put:async(_,v)=>{saved=v;},transaction:async fn=>fn(),getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;},deleteAlarm:async()=>{alarm=null;}};
 const C=schedulerClass([{id:'one',interval:300000,enabled:async env=>{await env.DB.prepare('INSERT INTO data VALUES(?)').bind('enabled').run();return true;},run:async env=>{await env.DB.prepare('INSERT INTO data VALUES(?)').bind('run').run();}}],async(_,env)=>{await env.DB.prepare('INSERT INTO data VALUES(?)').bind('auth').run();return true;},()=>true,env=>{prepared++;return {...env};},(env,work)=>runApplication(env,undefined,work));
 const scheduler=new C({storage},f.env);await scheduler.fetch(new Request('https://scheduler.internal/start',{method:'POST'}));saved.jobs.one.next=0;await scheduler.alarm();
 assert.equal(prepared,1);assert.equal(f.app.prepare('SELECT count(*) AS n FROM data').get().n,3);assert.deepEqual(f.control.calls,['admit','release','admit','release']);
 await f.close();await f.core.ready(f.maintenance,1);saved.jobs.one.next=0;await scheduler.alarm();
 assert.equal(saved.jobs.one.outcome,'paused');assert.ok(alarm>Date.now());assert.equal(prepared,1);
 await f.core.reopen(f.maintenance,1);saved.jobs.one.next=0;await scheduler.alarm();assert.equal(prepared,2);assert.ok(alarm>Date.now());
});
test('private lifecycle deadline bounds a signal-ignoring response body without starting the handler',async t=>{
 const f=await fixture(t),entered=deferred(),body=deferred();let invoked=false;
 const nativeTimeout=globalThis.setTimeout;t.after(()=>{globalThis.setTimeout=nativeTimeout;});
 globalThis.setTimeout=(callback,ms,...args)=>ms===10000?nativeTimeout(()=>{void entered.promise.then(()=>callback(...args));},1):nativeTimeout(callback,ms,...args);
 f.env.MAINTENANCE={async fetch(request){await f.service.fetch(request);entered.resolve();return new Response(new ReadableStream({async start(controller){await body.promise;controller.enqueue(new TextEncoder().encode('{"status":"admitted","epoch":0}'));controller.close();}}));}};
 await assert.rejects(runApplication(f.env,undefined,async()=>{invoked=true;}));assert.equal(invoked,false);body.resolve();
 await f.close();assert.equal((await f.core.ready(f.maintenance,1)).state,'draining');
});
test('Resend receipt and isolated document queue drain without allowing generic provider202',async t=>{
 const f=await fixture(t);
 globalThis.fetch=async input=>new URL(input.url).hostname==='api.resend.com'?Response.json({id:'12345678-1234-1234-1234-123456789abc'}):new Response(null,{status:204});
 f.env.DOCUMENT_COMPUTE={fetch:async()=>Response.json({id:'synthetic-job',manifestDigest:'a'.repeat(64),state:'staging'},{status:201})};
 await runApplication(f.env,undefined,async env=>{
  await providerFetch(env)('https://api.resend.com/emails',{method:'POST',body:'{}'});
  await env.DOCUMENT_COMPUTE.fetch(new Request('https://document.internal/jobs',{method:'POST',body:'{}'}));
 });
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM updater_execution_operations').get().n,0);
 f.env.DOCUMENT_COMPUTE={fetch:async()=>Response.json({id:'synthetic-job',manifestDigest:'a'.repeat(64),state:'queued'},{status:202})};
 await runApplication(f.env,undefined,async env=>{await env.DOCUMENT_COMPUTE.fetch(new Request('https://document.internal/jobs/123/seal',{method:'POST'}));});
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM updater_execution_operations WHERE state='pending'").get().n,0);
});
test('document readback permits bounded 4MiB bytes represented as base64 JSON',async t=>{
 const f=await fixture(t),encoded=Buffer.alloc(4*1024*1024,1).toString('base64');
 f.env.DOCUMENT_COMPUTE={fetch:async()=>Response.json({bytes:encoded})};
 await runApplication(f.env,undefined,async env=>{
  const value=await(await env.DOCUMENT_COMPUTE.fetch(new Request('https://document.internal/jobs/123/items/0/original'))).json();assert.equal(value.bytes.length,encoded.length);
 });
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM updater_execution_permits WHERE state='active'").get().n,0);
});
test('actual HTTP errors do not record retired diagnostics and still release permits',async t=>{
 const f=await fixture(t);let diagnostic=0;
 f.env.DB={prepare(sql){
  if(sql.startsWith('SELECT telemetry_accepted_at'))return {first:async()=>({acceptedAt:'synthetic'})};
  if(sql.startsWith('INSERT INTO telemetry_diagnostics'))return {bind(){return this;},async run(){diagnostic++;return {success:true};}};
  throw Error('synthetic preparation failure');
 }};
 const response=await worker.fetch(new Request('https://api.invalid/setup/status'),f.env);assert.equal(response.status,500);assert.equal(diagnostic,0);
 assert.deepEqual(f.control.calls,['admit','release']);
});
test('production API has no global provider fetch calls outside explicit maintenance transport',()=>{
 const helpers={discordRequest:5,reconcileDiscordApplicationCommands:5,pickerProvider:3,validateGoogleIdentity:3,editPrivateInteraction:6,downloadDocumentationFile:2,googleCalendarProviderRequest:5};
 for(const file of readdirSync(new URL('../apps/api/src',import.meta.url)).filter(name=>name.endsWith('.ts')&&name!=='maintenance.ts')){
  const source=readFileSync(new URL('../apps/api/src/'+file,import.meta.url),'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const walk=node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){const name=node.expression.text;assert.notEqual(name,'fetch',file);if(name in helpers){assert.equal(node.arguments.length,helpers[name],file+':'+name);assert.equal(node.arguments.at(-1).getText(tree),'env',file+':'+name);}}ts.forEachChild(node,walk);};walk(tree);
 }
});
test('actual Discord, private reply, Google identity and picker helpers retain scoped transport and revoke',async t=>{
 const f=await fixture(t);let retained,calls=0;
 assert.throws(()=>providerFetch(f.env),/maintenance/);
 globalThis.fetch=async request=>{calls++;return Response.json(new URL(request.url).pathname==='/tokeninfo'?{aud:'client',iss:'https://accounts.google.com',email_verified:true,sub:'synthetic',email:'synthetic@example.invalid',exp:Date.now()/1000+60}:{id:'synthetic'});};
 await runApplication(f.env,undefined,async env=>{
  retained=env;
  await discordRequest({botToken:'synthetic'},'/channels/123',{method:'GET'},false,env);
  await pickerProvider('https://www.googleapis.com/drive/v3/files/synthetic',{},env);
  await validateGoogleIdentity('synthetic','client',env);
  await editPrivateInteraction('123456789012','synthetic',{content:'test'},Date.now()+60000,undefined,env);
 });
 assert.equal(calls,4);
 await assert.rejects(pickerProvider('https://www.googleapis.com/drive/v3/files/synthetic',{},retained));assert.equal(calls,4);
});

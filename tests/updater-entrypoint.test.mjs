import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { updaterConfiguration } from '../apps/updater/worker-config.mjs';
import { routeUpdater } from '../apps/updater/worker-router.mjs';
import { buildUpdaterWorker } from '../scripts/build-updater-worker.mjs';
import { signedUpdaterRequest } from '../packages/shared/src/updater/service-auth.ts';
import { signMaintenanceRequest } from '../packages/shared/src/updater/maintenance-auth.ts';
import { fixture } from './updater-bootstrap-fixture.mjs';

test('exact configuration rejects overrides and uninitialized routing fails closed',async t=>{
  const f=await fixture(t);
  for(const changed of [{...f.env,EXTRA:'override'},{...f.env,APP_HMAC:'bad'},{...f.env,UPDATER_CONFIG:f.env.UPDATER_CONFIG.replace('"format":1','"format":1,"format":1')},{...f.env,VALIDATION_DB:f.env.APPLICATION_DB},{...f.env,UPDATER_CONFIG:JSON.stringify({...f.config,pins:{...f.config.pins,recoveryOrigin:'https://user@recovery.example.invalid'}})}])assert.throws(()=>updaterConfiguration(changed));
  const request=new Request(f.config.pins.recoveryOrigin+'/recovery');assert.equal((await routeUpdater(f.env,'public',request)).status,503);
  await f.initialize();assert.equal((await routeUpdater(f.env,'public',request)).status,200);
  assert.equal((await routeUpdater(f.env,'public',new Request(f.config.pins.recoveryOrigin+'/control'))).status,200);
  assert.equal((await routeUpdater(f.env,'public',new Request('https://wrong.example.invalid/recovery'))).status,404);
  const unavailable=await routeUpdater({...f.env,APP_HMAC:'invalid-sensitive-value'},'public',request);assert.equal(unavailable.status,503);assert.equal(await unavailable.text(),JSON.stringify({error:'Updater is unavailable.'}));
  for(const path of ['/v1/status','/private/maintenance/admit','/initialize','/recovery/initialize','/recovery/status?override=1','/recovery%2fstatus'])assert.equal((await routeUpdater(f.env,'public',new Request(f.config.pins.recoveryOrigin+path))).status,404);
  const status=await signedUpdaterRequest({secret:f.env.APP_HMAC,installationId:f.config.pins.installationId,actorId:'synthetic-admin',action:'status'});
  assert.equal((await routeUpdater(f.env,'public',status.clone())).status,404);const result=await routeUpdater(f.env,'application',status);assert.equal(result.status,200);assert.equal((await result.json()).installedVersion,'1.0.0');
});

test('offline bundle routes real initialized D1 state through private named entrypoints only',async t=>{
  const f=await fixture(t);await f.initialize();const directory=await mkdtemp(join(tmpdir(),'ll-updater-entry-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'updater.mjs');const built=await buildUpdaterWorker(path),bundle=await readFile(path,'utf8');assert.ok(built.bytes>1000);await assert.rejects(()=>buildUpdaterWorker(path));
  for(const key of ['CHECKPOINT_KEY','GITHUB_TOKEN','CLOUDFLARE_TOKEN','APP_HMAC','MAINTENANCE_HMAC','RECOVERY_CREDENTIAL_SHA256'])assert.ok(!bundle.includes(f.env[key]),'build has no supplied secret values');
  const {APPLICATION_DB,UPDATER_DB,VALIDATION_DB,...strings}=f.env;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'entry-test',modules:true,script:'export default {fetch(request,env){const u=new URL(request.url);return env[u.pathname==="/maintenance"?"MAINTENANCE":"APPLICATION"].fetch(new Request(u.pathname==="/maintenance"?"https://maintenance.internal/private/maintenance/admit":"https://updater.internal/v1/status",request));}}',compatibilityDate:'2026-09-04',serviceBindings:{APPLICATION:{name:'updater',entrypoint:'ApplicationUpdates'},MAINTENANCE:{name:'updater',entrypoint:'MaintenanceLifecycle'}}},{name:'updater',modules:true,script:bundle,compatibilityDate:'2026-09-04',bindings:strings,d1Databases:['APPLICATION_DB','UPDATER_DB','VALIDATION_DB']}]}));t.after(()=>mf.dispose());
  const db=await mf.getD1Database('UPDATER_DB','updater');
  for(const file of readdirSync(new URL('../apps/updater/state/',import.meta.url))){const sql=readFileSync(new URL(`../apps/updater/state/${file}`,import.meta.url),'utf8');for(const statement of sql.replace(/--[^\n]*/g,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();}
  // Fixture-only transfer of real trusted initialization, not a shipped bootstrap route.
  for(const {name} of f.updater.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all()){
    const columns=f.updater.prepare(`PRAGMA table_info("${name}")`).all().map(x=>x.name),rows=f.updater.prepare(`SELECT ${columns.map(x=>'"'+x+'"').join(',')} FROM "${name}"`).all();
    for(const row of rows)await db.prepare(`INSERT INTO "${name}"(${columns.map(x=>'"'+x+'"').join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  }
  const publicWorker=await mf.getWorker('updater');assert.equal((await publicWorker.fetch(f.config.pins.recoveryOrigin+'/recovery')).status,200);assert.equal((await publicWorker.fetch('https://updater.internal/v1/status')).status,404);
  const signed=await signedUpdaterRequest({secret:f.env.APP_HMAC,installationId:f.config.pins.installationId,actorId:'synthetic-admin',action:'status'});const response=await mf.dispatchFetch('https://fixture.invalid/status',{method:signed.method,headers:Object.fromEntries(signed.headers)});assert.equal(response.status,200);assert.equal((await response.json()).schema,49);
  assert.equal((await mf.dispatchFetch('https://fixture.invalid/status')).status,401);
  const permit=await signMaintenanceRequest(f.env.MAINTENANCE_HMAC,f.config.pins.installationId,'admit',{permitId:'synthetic-execution',proof:'aa'.repeat(32)});const admitted=await mf.dispatchFetch('https://fixture.invalid/maintenance',{method:permit.method,headers:Object.fromEntries(permit.headers),body:await permit.clone().text()});assert.equal(admitted.status,200);assert.equal((await admitted.json()).status,'admitted');
  assert.equal((await publicWorker.fetch('https://maintenance.internal/private/maintenance/admit',{method:permit.method,headers:Object.fromEntries(permit.headers),body:await permit.clone().text()})).status,404);
  t.diagnostic(`generic module ${built.bytes} bytes; named entrypoints tested locally, no deployed resource/secret provisioning`);
});

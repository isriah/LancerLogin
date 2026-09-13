import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { moduleSnapshot, configureModules, setModuleGrants, requireModuleCapability, requireModuleEnabled } from '../apps/api/src/platform-modules.ts';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';

class Database {
  raw = new DatabaseSync(':memory:');
  constructor() {
    this.raw.exec('PRAGMA foreign_keys=ON');
    for (const f of readdirSync(new URL('../apps/api/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) this.raw.exec(readFileSync(new URL('../apps/api/migrations/'+f,import.meta.url),'utf8'));
    this.raw.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'),('other','2026-01-01','local'); INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01'),('operator','primary','operator','operator','2026-01-01'),('foreign','other','foreign','operator','2026-01-01');`);
    this.raw.exec('INSERT INTO hours_entry_settings(installation_id) SELECT id FROM installations');
  }
  prepare(sql) {
    let values=[]; const db=this;
    return { bind(...args){values=args;return this;}, async first(){return db.raw.prepare(sql).get(...values)??null;},async all(){return {results:db.raw.prepare(sql).all(...values)};},async run(){if(/^\s*SELECT\b/i.test(sql))return {success:true,results:db.raw.prepare(sql).all(...values)};const r=db.raw.prepare(sql).run(...values);return {success:true,meta:{changes:Number(r.changes)}};} };
  }
  queue = Promise.resolve();
  async batch(statements) { const prior=this.queue; let release; this.queue=new Promise(resolve=>release=resolve); await prior; try { return await this.transaction(statements); } finally { release(); } }
  async transaction(statements) {this.raw.exec('BEGIN'); try {const results=[];for(const s of statements) results.push(await s.run());this.raw.exec('COMMIT');return results;}catch(e){this.raw.exec('ROLLBACK');throw e;} }
}
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
async function request(db,path,body,user='admin',method=body?'POST':'GET') {
  const token=await createSessionCodec(key).issue({userId:user,role:user==='admin'?'admin':'operator'});
  return worker.fetch(new Request('https://api.example.test'+path,{method,headers:{cookie:'lancerlogin_session='+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),{APP_MODE:'configured',ALLOWED_ORIGIN:'https://example.test',SESSION_KEY:key,DB:db});
}
test('ordered migrations default core-only; dependency and optimistic revision are atomic',async()=>{
 const db=new Database();assert.deepEqual((await moduleSnapshot(db,'primary','admin')).capabilities,[]);
 await assert.rejects(configureModules(db,'primary','admin',{enabled:['activity-documentation'],revision:0}),/requires/);
 await configureModules(db,'primary','admin',{enabled:['hour-tracking'],revision:0});
 await assert.rejects(configureModules(db,'primary','admin',{enabled:[],revision:0}),/changed/);
 await configureModules(db,'primary','admin',{enabled:['hour-tracking','activity-documentation'],revision:1});
 assert.equal((await moduleSnapshot(db,'primary','admin')).revision,2);
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM audit_log').get().n,2);
 assert.throws(()=>db.raw.exec("UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'"),/CHECK/);
 db.raw.close();
});
test('grants do not follow Operator role; revocation/deactivation/demotion reload and disable retains grants',async()=>{
 const db=new Database();await configureModules(db,'primary','admin',{enabled:['hour-tracking','activity-documentation'],revision:0});
 await assert.rejects(requireModuleCapability(db,'primary','operator','hours.manage'),/unavailable/);
 await setModuleGrants(db,'primary','admin','operator',{capabilities:['hours.manage','documentation.manage']});
 await requireModuleCapability(db,'primary','operator','documentation.manage');
 await configureModules(db,'primary','admin',{enabled:[],revision:1});
 await assert.rejects(requireModuleEnabled(db,'primary','hour-tracking'),/disabled/);
 assert.equal(db.raw.prepare('SELECT hours_manage FROM platform_module_grants').get().hours_manage,1);
 await configureModules(db,'primary','admin',{enabled:['hour-tracking','activity-documentation'],revision:2});
 await requireModuleCapability(db,'primary','operator','hours.manage');
 await setModuleGrants(db,'primary','admin','operator',{capabilities:[]});
 await assert.rejects(requireModuleCapability(db,'primary','operator','hours.manage'),/unavailable/);
 db.raw.exec("UPDATE users SET active=0 WHERE id='operator'");
 await assert.rejects(moduleSnapshot(db,'primary','operator'),/unavailable/);
 await assert.rejects(setModuleGrants(db,'primary','admin','operator',{capabilities:['hours.manage']}),/unavailable/);
 await assert.rejects(setModuleGrants(db,'primary','admin','foreign',{capabilities:['hours.manage']}),/unavailable/);
 db.raw.exec("UPDATE users SET role='operator' WHERE id='admin'");
 await assert.rejects(configureModules(db,'primary','admin',{enabled:[],revision:3}),/unavailable/);
 db.raw.close();
});
test('HTTP boundaries reject unauthorized mutations and unknown fields; snapshot contains only own grants',async()=>{
 const db=new Database();
 assert.equal((await request(db,'/admin/modules',{enabled:['hour-tracking'],revision:0},'operator','PUT')).status,403);
 assert.equal((await request(db,'/admin/modules',{enabled:['hour-tracking'],revision:0,installationId:'other'},'admin','PUT')).status,400);
 assert.equal((await request(db,'/admin/modules',{enabled:['unknown'],revision:0},'admin','PUT')).status,400);
 assert.equal((await request(db,'/admin/modules',{enabled:['hour-tracking'],revision:0},'admin','PUT')).status,200);
 assert.equal((await request(db,'/admin/modules/grants/operator',{capabilities:['hours.manage']},'admin','PUT')).status,200);
 const snapshot=await (await request(db,'/platform/modules',undefined,'operator')).json();assert.deepEqual(snapshot.capabilities,['hours.manage']);assert.equal(snapshot.users,undefined);
 db.raw.exec("UPDATE users SET active=0 WHERE id='operator'");assert.equal((await request(db,'/platform/modules',undefined,'operator')).status,401);
 db.raw.close();
});
test('installation backup roundtrip preserves modules, legacy defaults off, invalid snapshots reject before deletion',async()=>{
 const db=new Database();await configureModules(db,'primary','admin',{enabled:['hour-tracking','activity-documentation'],revision:0});await setModuleGrants(db,'primary','admin','operator',{capabilities:['hours.manage']});
 const backup=await (await request(db,'/admin/data/backup?scope=installation')).json();assert.equal(backup.schemaVersion,28);assert.equal(backup.tables.platform_module_grants.length,1);
 const bad=structuredClone(backup);bad.tables.platform_module_configuration[0].hours_enabled=0;
 assert.equal((await request(db,'/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:bad})).status,400);
 assert.equal((await moduleSnapshot(db,'primary','admin')).revision,1);
 assert.equal((await request(db,'/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup})).status,200);
 assert.deepEqual((await moduleSnapshot(db,'primary','operator')).capabilities,['hours.manage']);
 assert.equal((await request(db,'/admin/data',{scope:'attendance',confirmation:'DELETE ATTENDANCE'},'admin','DELETE')).status,200);
 assert.deepEqual((await moduleSnapshot(db,'primary','operator')).capabilities,['hours.manage']);
 const legacy=structuredClone(backup);legacy.schemaVersion=13;delete legacy.tables.platform_module_configuration;delete legacy.tables.platform_module_grants;
 assert.equal((await request(db,'/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy})).status,200);
 assert.deepEqual((await moduleSnapshot(db,'primary','admin')).capabilities,[]);
 db.raw.close();
});

test('simultaneous conflicting configuration writes admit only one revision',async()=>{
 const db=new Database();const results=await Promise.allSettled([configureModules(db,'primary','admin',{enabled:['hour-tracking'],revision:0}),configureModules(db,'primary','admin',{enabled:[],revision:0})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal((await moduleSnapshot(db,'primary','admin')).revision,1);assert.equal(db.raw.prepare('SELECT count(*) AS n FROM audit_log').get().n,1);db.raw.close();
});

test('audit failure rolls back enablement and grants with the same transaction',async()=>{
 const db=new Database();db.raw.exec("CREATE TRIGGER reject_module_audit BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'modules.%' BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END");
 await assert.rejects(configureModules(db,'primary','admin',{enabled:['hour-tracking'],revision:0}),/audit unavailable/);
 assert.equal((await moduleSnapshot(db,'primary','admin')).revision,0);
 await assert.rejects(setModuleGrants(db,'primary','admin','operator',{capabilities:['hours.manage']}),/audit unavailable/);
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM platform_module_grants').get().n,0);db.raw.close();
});
test('attendance restore preserves modules; invalid grant backup is rejected; installation delete cascades',async()=>{
 const db=new Database();await configureModules(db,'primary','admin',{enabled:['hour-tracking'],revision:0});await setModuleGrants(db,'primary','admin','operator',{capabilities:['hours.manage']});
 const grants=await request(db,'/admin/modules/grants/operator');assert.deepEqual((await grants.json()).capabilities,['hours.manage']);
 assert.equal((await request(db,'/admin/modules/grants/admin',undefined,'operator')).status,403);
 const attendance=await (await request(db,'/admin/data/backup?scope=meetings')).json();
 assert.equal(attendance.tables.platform_module_configuration,undefined);
 assert.equal((await request(db,'/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:attendance})).status,200);
 assert.deepEqual((await moduleSnapshot(db,'primary','operator')).capabilities,['hours.manage']);
 const bad=await (await request(db,'/admin/data/backup?scope=installation')).json();bad.tables.platform_module_grants[0].user_id='foreign';
 assert.equal((await request(db,'/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:bad})).status,400);
 assert.deepEqual((await moduleSnapshot(db,'primary','operator')).capabilities,['hours.manage']);
 assert.equal((await request(db,'/admin/data',{scope:'installation',confirmation:'DELETE INSTALLATION'},'admin','DELETE')).status,200);
 assert.equal(db.raw.prepare('SELECT count(*) AS n FROM platform_module_configuration').get().n,0);assert.equal(db.raw.prepare('SELECT count(*) AS n FROM platform_module_grants').get().n,0);db.raw.close();
});

test('module PUT preflight remains restricted to configured browser origin',async()=>{
 for (const origin of ['https://example.test','https://untrusted.test']) {
  const result=await worker.fetch(new Request('https://api.example.test/admin/modules',{method:'OPTIONS',headers:{origin,'access-control-request-method':'PUT','access-control-request-headers':'content-type'}}),{APP_MODE:'configured',ALLOWED_ORIGIN:'https://example.test'});
  assert.equal(result.status,204);assert.match(result.headers.get('access-control-allow-methods'),/PUT/);
  assert.equal(result.headers.get('access-control-allow-origin'),origin==='https://example.test'?origin:null);
 }
});

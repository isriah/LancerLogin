import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { configureModules, setModuleGrants, moduleSnapshot } from '../apps/api/src/platform-modules.ts';

test('local D1 batch preserves atomic configuration, audit and grant predicates', async () => {
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try {
  const db=await mf.getD1Database('DB');
  await db.batch([
   db.prepare('CREATE TABLE installations(id TEXT PRIMARY KEY)'),
   db.prepare('CREATE TABLE users(id TEXT PRIMARY KEY, installation_id TEXT REFERENCES installations(id), role TEXT, active INTEGER)'),
   db.prepare('CREATE TABLE audit_log(id TEXT PRIMARY KEY,installation_id TEXT,actor_user_id TEXT,action TEXT,target_type TEXT,target_id TEXT,metadata_json TEXT,created_at TEXT)'),
   ...readFileSync(new URL('../apps/api/migrations/0029_platform_modules.sql',import.meta.url),'utf8').split(';').filter(s=>s.trim()).map(s=>db.prepare(s)),
   db.prepare("INSERT INTO installations VALUES ('primary'),('other')"),
   db.prepare("INSERT INTO users VALUES ('admin','primary','admin',1),('operator','primary','operator',1),('foreign','other','operator',1)"),
  ]);
  const results=await Promise.allSettled([configureModules(db,'primary','admin',{enabled:['hour-tracking'],revision:0}),configureModules(db,'primary','admin',{enabled:[],revision:0})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM audit_log').first()).n,1);
  await configureModules(db,'primary','admin',{enabled:['hour-tracking','activity-documentation'],revision:1});
  await setModuleGrants(db,'primary','admin','operator',{capabilities:['hours.manage']});
  assert.deepEqual((await moduleSnapshot(db,'primary','operator')).capabilities,['hours.manage']);
  await assert.rejects(setModuleGrants(db,'primary','admin','foreign',{capabilities:['hours.manage']}),/unavailable/);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM audit_log').first()).n,3);
  await assert.rejects(db.prepare("UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'").run(),/CHECK/);
  assert.equal((await moduleSnapshot(db,'primary','admin')).revision,2);
 } finally {await mf.dispose();}
});

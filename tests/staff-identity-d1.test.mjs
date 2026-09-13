import { migrationStatements } from './migration-statements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec, hashPassword } from '../apps/api/src/runtime-security.ts';
import { configureModules, setModuleGrants } from '../apps/api/src/platform-modules.ts';
const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const migrations = new URL('../apps/api/migrations/', import.meta.url);
const statements = name => migrationStatements(readFileSync(new URL(name,migrations),'utf8'));
test('populated local D1 staff migration, live role authorization, local sign-in and backup roundtrip', {timeout:30000}, async () => {
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try {
  const db=await mf.getD1Database('DB');
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql') && n<'0030').sort()) await db.batch(statements(name).map(s=>db.prepare(s)));
  const passwordHash=await hashPassword('synthetic test password only');
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,password_hash,role,created_at) VALUES ('admin','primary','admin',?,'admin','2026-01-01'),('operator','primary','operator',?,'operator','2026-01-01')").bind(passwordHash,passwordHash),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES ('member','primary','fixture-1','Synthetic','Member','2026-01-01')"),
   db.prepare("UPDATE users SET member_id='member' WHERE id='operator'"),
   db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,created_at) VALUES ('prior','primary','operator','fixture','user','2026-01-01')"),
   db.prepare("INSERT INTO platform_module_grants VALUES ('primary','operator',1,0)"),
  ]);
  const before=await db.prepare('SELECT * FROM users ORDER BY id').all();
  await db.batch(statements('0030_staff_identity.sql').map(s=>db.prepare(s)));
  assert.deepEqual((await db.prepare('SELECT * FROM users ORDER BY id').all()).results,before.results);
  assert.equal((await db.prepare("SELECT actor_user_id FROM audit_log WHERE id='prior'").first()).actor_user_id,'operator');
  assert.equal((await db.prepare('SELECT count(*) n FROM platform_module_grants').first()).n,1);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  await assert.rejects(db.prepare("UPDATE users SET role='invented' WHERE id='operator'").run(),/CHECK/);
  const env={DB:db,SESSION_KEY:secret,APP_MODE:'unconfigured'};
  const call=async(path,body,identity='admin',signedRole='admin',method=body?'POST':'GET')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:identity,role:signedRole}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  for (const change of ["role='staff'", "active=0"]) {
   const audits=(await db.prepare('SELECT count(*) n FROM audit_log').first()).n;
   env.DB={prepare:sql=>db.prepare(sql),batch:async statements=>{await db.prepare("UPDATE users SET "+change+" WHERE id='admin'").run();return db.batch(statements);}};
   const denied=await call('/admin/users',{localUsername:'racing-admin',localPassword:'synthetic test password only',role:'admin'});
   env.DB=db;
   assert.equal(denied.status,409);
   assert.equal((await db.prepare("SELECT count(*) n FROM users WHERE local_username='racing-admin'").first()).n,0);
   assert.equal((await db.prepare('SELECT count(*) n FROM audit_log').first()).n,audits);
   await db.prepare("UPDATE users SET role='admin',active=1 WHERE id='admin'").run();
  }
  const create=await call('/admin/users',{localUsername:'committee',localPassword:'synthetic test password only',role:'staff'}); assert.equal(create.status,201,await create.clone().text());
  const staff=(await db.prepare("SELECT id FROM users WHERE local_username='committee'").first()).id;
  let result=await call('/auth/local',{username:'committee',password:'synthetic test password only'});assert.equal(result.status,200);assert.equal((await result.json()).user.role,'staff');
  assert.equal((await (await call('/auth/session',null,staff,'admin')).json()).user.role,'staff');
  for(const path of ['/admin/users','/admin/members','/meetings','/exports/attendance.csv','/integrations/capabilities','/admin/kiosks','/admin/data/backup?scope=installation']) assert.equal((await call(path,null,staff,'admin')).status,403,path);
  assert.deepEqual((await (await call('/platform/modules',null,staff,'staff')).json()).capabilities,[]);
  await configureModules(db,'primary','admin',{enabled:['hour-tracking'],revision:0});
  await setModuleGrants(db,'primary','admin',staff,{capabilities:['hours.manage']});
  assert.deepEqual((await (await call('/platform/modules',null,staff,'staff')).json()).capabilities,['hours.manage']);
  assert.equal((await call('/admin/users/'+staff,{role:'operator'},'admin','admin','PATCH')).status,200);
  assert.deepEqual((await (await call('/platform/modules',null,staff,'staff')).json()).capabilities,['hours.manage']);
  assert.equal((await call('/admin/users/'+staff,{role:'staff'},'admin','admin','PATCH')).status,200);
  assert.equal((await call('/admin/users/admin',{role:'staff'},'admin','admin','PATCH')).status,409);
  assert.equal((await call('/admin/users/'+staff,{role:''},'admin','admin','PATCH')).status,400);
  await call("/admin/users/"+staff,{role:"admin"},"admin","admin","PATCH");
  let release;const ready=new Promise(resolve=>{release=resolve;});let entrants=0;
  env.DB={prepare:sql=>db.prepare(sql),batch:async statements=>{entrants++;if(entrants===2)release();await ready;return db.batch(statements);}};
  const races=await Promise.all([call("/admin/users/"+staff,{role:"staff"},"admin","admin","PATCH"),call("/admin/users/admin",{role:"staff"},staff,"admin","PATCH")]);
  env.DB=db;
  assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  assert.equal((await db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND active=1").first()).n,1);
  await db.prepare("UPDATE users SET role=CASE WHEN id='admin' THEN 'admin' WHEN id='operator' THEN 'operator' ELSE 'staff' END").run();
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql') && n>'0030_staff_identity.sql').sort()) await db.batch(statements(name).map(s=>db.prepare(s)));
  const backup=await (await call('/admin/data/backup?scope=installation')).json();
  assert.equal(backup.schemaVersion,28);
  const invalid=structuredClone(backup);invalid.tables.users[0].role='invented';
  assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:invalid})).status,400);
  const noAdmin=structuredClone(backup);noAdmin.tables.users.forEach(row=>row.role='staff');
  assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:noAdmin})).status,400);
  assert.equal((await db.prepare('SELECT count(*) n FROM users').first()).n,3);
  result=await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});assert.equal(result.status,200,await result.clone().text());
  assert.deepEqual((await (await call('/platform/modules',null,staff,'staff')).json()).capabilities,['hours.manage']);
  const older=structuredClone(backup);older.schemaVersion=14;older.tables.users=older.tables.users.map(row=>({...row,role:row.role==='staff'?'operator':row.role}));
  assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:older})).status,200);
  await db.prepare("UPDATE users SET active=0 WHERE id=?").bind(staff).run();
  assert.equal((await call('/auth/session',null,staff,'staff')).status,401);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 } finally {await mf.dispose();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import worker from '../apps/api/src/index.ts';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {accountingRoute} from '../apps/api/src/hour-accounting.ts';
const migrations=new URL('../apps/api/migrations/',import.meta.url),key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('staff hour member choices and exact reopen readback are bounded private live-authorized D1 reads',{timeout:60000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{const db=await mf.getD1Database('DB');for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,migrations),'utf8')).map(s=>db.prepare(s)));
 await db.batch([
 db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
 db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01'),('staff','primary','staff','staff','2026-01-01'),('operator','primary','operator','operator','2026-01-01'),('foreign-staff','foreign','foreign-staff','staff','2026-01-01')"),
 db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1)"),
 db.prepare("INSERT INTO platform_module_grants(installation_id,user_id,hours_manage) VALUES('primary','staff',1)"),
 db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,active,created_at) VALUES('m1','primary','00123','Synthetic','Name','private@example.test',1,'2026-01-01'),('m2','primary','00456','Synthetic','Name',null,1,'2026-01-01'),('m3','primary','00789','Archived','Name',null,0,'2026-01-01'),('foreign','foreign','00123','Foreign','Name',null,1,'2026-01-01')"),
 db.prepare("INSERT INTO hours_reopen_windows(installation_id,id,activity_id,starts_ms,expires_ms,actor_user_id,created_at) VALUES('primary','window',null,1000,2000,'staff','2026-01-01'),('foreign','foreign-window',null,1000,2000,'foreign-staff','2026-01-01')"),
 ]);
 const env={DB:db,SESSION_KEY:key,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
 const get=async(path,actor='staff')=>worker.fetch(new Request('https://fixture.test/admin/hours/'+path,{headers:{cookie:'lancerlogin_session='+await createSessionCodec(key).issue({userId:actor,role:'admin'})}}),env);
 const list=await(await get('member-choices?limit=1')).json();assert.deepEqual(list,{items:[{id:'m1',label:'Synthetic Name',externalId:'00123',active:true}],nextCursor:'m1'});
 assert.deepEqual((await(await get('member-choices?after=m1')).json()).items.map(r=>r.id),['m2']);
 assert.deepEqual((await(await get('member-choices?active=false')).json()).items.map(r=>r.id),['m3']);
 assert.equal((await(await get('member-choices?active=all')).json()).items.length,3);
 assert.equal((await(await get('member-choices?q=00123')).json()).items[0].externalId,'00123');
 assert.equal((await(await get('member-choices?q=%25')).json()).items.length,0);
 const detail=await(await get('member-choices/m3')).json();assert.equal(detail.active,false);assert.deepEqual(Object.keys(detail).sort(),['active','externalId','id','label']);
 assert.equal((await get('member-choices/foreign')).status,404);assert.equal((await get('member-choices','operator')).status,403);
 for(const suffix of ['?limit=101','?active=1','?q='+('x'.repeat(101)),'?active=true&active=false','?email=x','/m1?active=all'])assert.equal((await get('member-choices'+suffix)).status,400);
 const read=(at)=>accountingRoute(db,'primary','staff',new Request('https://fixture.test/admin/hours/reopen-windows/window'),undefined,at);
 assert.equal((await read(1500)).body.active,true);assert.equal((await read(2000)).body.active,false);
 await db.prepare("UPDATE hours_reopen_windows SET revoked=1 WHERE id='window'").run();assert.equal((await read(1500)).body.active,false);
 assert.equal((await get('reopen-windows/absent')).status,404);assert.equal((await get('reopen-windows/foreign-window')).status,404);
 env.DB={prepare:sql=>{const statement=db.prepare(sql);if(!sql.includes('SELECT id,first_name'))return statement;return {bind:(...args)=>({first:()=>statement.bind(...args).first(),all:async()=>{await db.prepare("UPDATE platform_module_grants SET hours_manage=0 WHERE user_id='staff'").run();return statement.bind(...args).all();}})};},batch:s=>db.batch(s)};
 assert.equal((await get('member-choices')).status,403);env.DB=db;
 await db.prepare("UPDATE platform_module_grants SET hours_manage=1 WHERE user_id='staff'").run();await db.prepare("UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'").run();assert.equal((await get('member-choices','admin')).status,403);
 }finally{await mf.dispose();}
});

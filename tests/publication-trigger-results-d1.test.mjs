import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import worker from '../apps/api/src/index.ts';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import {googleCapability,googleScopes} from '../apps/api/src/google-connection.ts';
const key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('actual D1 HTTP mutation success excludes publication trigger row counts',{timeout:120000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']})),oldFetch=globalThis.fetch;
 try{
 const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);
 for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
 await db.batch([
 db.prepare("INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled) VALUES('primary','2026-01-01','local',1)"),
 db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic','UTC')"),
 db.prepare("INSERT INTO users(id,installation_id,local_username,password_hash,role,created_at) VALUES('admin','primary','admin','scrypt$32768$8$1$synthetic-not-a-credential','admin','2026-01-01'),('staff','primary','staff',NULL,'staff','2026-01-01'),('operator','primary','operator',NULL,'operator','2026-01-01')"),
 db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1)"),
 db.prepare("INSERT INTO platform_module_grants(installation_id,user_id,hours_manage) VALUES('primary','staff',1)"),
 db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01')")]);
 const seed=async id=>db.batch([
 db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary',?,'event','event','2099-01-01','Synthetic','UTC',0,'2026-01-01','2026-01-01')").bind(id),
 db.prepare("INSERT INTO hours_publication_intents(installation_id,activity_id,provider,enabled,revision,generation,activity_revision,actor_user_id,snapshot_json,updated_at) VALUES('primary',?,'google',1,1,1,0,'staff','{}','2026-01-01')").bind(id),
 db.prepare("INSERT INTO hours_publication_generations(installation_id,activity_id,provider,generation,connection_generation,destination,application_id,marker,created_at) VALUES('primary',?,'google',1,'synthetic-generation','synthetic-calendar','',?,'2026-01-01')").bind(id,crypto.randomUUID().replaceAll('-','')),
 db.prepare("INSERT INTO hours_publication_operations(installation_id,activity_id,provider,generation,action,snapshot_json,actor_user_id,activity_revision,updated_at) VALUES('primary',?,'google',1,'upsert','{}','staff',0,'2026-01-01')").bind(id)]);
 let changed=[];const env={DB:{prepare:s=>db.prepare(s),batch:async ss=>{const result=await db.batch(ss);changed=result.map(r=>r.meta?.changes);return result;}},SESSION_KEY:key,INTEGRATION_KEY:key,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
 const http=async(path,body,method='PATCH',actor='staff')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+await createSessionCodec(key).issue({userId:actor,role:actor==='admin'?'admin':'staff'}),'content-type':'application/json'},body:JSON.stringify(body)}),env);
 const success=async(path,body,method,actor)=>{const r=await http(path,body,method,actor);assert.equal(r.status,200,JSON.stringify({body:await r.clone().text(),changed}));return r.json();};
 await seed('edit');await success('/admin/hours/activities/edit',{revision:0,title:'Edited'});assert.ok(changed[0]>1);assert.equal(changed[1],1);assert.equal((await db.prepare("SELECT revision FROM hours_activities WHERE id='edit'").first()).revision,1);
 const audits=async()=>Number((await db.prepare('SELECT count(*) n FROM audit_log').first()).n);let count=await audits();assert.equal((await http('/admin/hours/activities/edit',{revision:0,title:'Stale'})).status,409);assert.equal(await audits(),count);
 await success('/admin/hours/activities/edit',{revision:1,archived:true});assert.ok(changed[0]>1);assert.equal((await db.prepare("SELECT archived FROM hours_activities WHERE id='edit'").first()).archived,1);assert.equal((await db.prepare("SELECT count(*) n FROM hours_publication_operations WHERE activity_id='edit' AND action='delete'").first()).n,1);
 await seed('disable');await success('/admin/modules',{enabled:[],revision:0},'PUT','admin');assert.ok(changed[0]>1);assert.equal(changed[1],1);assert.equal((await db.prepare('SELECT hours_enabled FROM platform_module_configuration').first()).hours_enabled,0);
 count=await audits();assert.equal((await http('/admin/modules',{enabled:['hour-tracking'],revision:0},'PUT','admin')).status,409);assert.equal(await audits(),count);await success('/admin/modules',{enabled:['hour-tracking'],revision:1},'PUT','admin');
 // Current authority lost between admission and transaction cannot be mistaken for success.
 let injected=false;env.DB={prepare:s=>db.prepare(s),batch:async ss=>{if(!injected){injected=true;await db.prepare("UPDATE platform_module_grants SET hours_manage=0 WHERE user_id='staff'").run();}return db.batch(ss);}};
 count=await audits();assert.equal((await http('/admin/hours/activities/disable',{revision:0,title:'Denied'})).status,409);assert.equal(await audits(),count);assert.equal((await db.prepare("SELECT revision FROM hours_activities WHERE id='disable'").first()).revision,0);
 injected=false;env.DB={prepare:s=>db.prepare(s),batch:async ss=>{if(!injected){injected=true;await db.prepare("UPDATE users SET active=0 WHERE id='admin'").run();}return db.batch(ss);}};
 assert.equal((await http('/admin/modules',{enabled:[],revision:2},'PUT','admin')).status,409);assert.equal((await db.prepare('SELECT hours_enabled FROM platform_module_configuration').first()).hours_enabled,1);
 env.DB=db;await db.batch([db.prepare("UPDATE users SET active=1 WHERE id='admin'"),db.prepare("UPDATE platform_module_grants SET hours_manage=1 WHERE user_id='staff'")]);
 // Shared Google promotion/removal and refresh are also trigger-bearing writes.
 const active={clientId:'synthetic-client',clientSecret:'synthetic-secret',generation:'synthetic-generation',loginEnabled:false,loginProof:false,calendarEnabled:true,driveEnabled:false,organizationProof:true,calendarProof:true,calendarId:'synthetic-calendar',calendarLabel:'Synthetic',calendarVerifiedAt:'2026-01-01',legacyFingerprint:JSON.stringify([null,null,{google_enabled:0,google_calendar_enabled:1,auth_mode:'local'}]),grant:{proofId:'synthetic-proof',subject:'synthetic-subject',refreshToken:'synthetic-refresh',scopes:[...googleScopes.calendar]}};
 const packed=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify(active)},key);await db.prepare("INSERT INTO google_connections(installation_id,shared_mode,revision,active_ciphertext,active_iv,grant_proof_id,updated_at) VALUES('primary',1,0,?,?,'synthetic-proof','2026-01-01')").bind(packed.ciphertext,packed.iv).run();
 let calls=0;globalThis.fetch=async url=>{assert.equal(String(url),'https://oauth2.googleapis.com/token');calls++;return Response.json({access_token:'synthetic-access',scope:[...googleScopes.calendar,...googleScopes.drive].join(' ')});};

 const rotated=await encryptIntegration({installation:'primary',slot:'active',payload:JSON.stringify({...active,calendarLabel:'Synthetic refreshed'})},key);
 injected=false;env.DB={prepare:s=>db.prepare(s),batch:async ss=>{if(!injected){injected=true;await db.prepare('UPDATE google_connections SET active_ciphertext=?,active_iv=?').bind(rotated.ciphertext,rotated.iv).run();}return db.batch(ss);}};
 await assert.rejects(async()=>await (await googleCapability(env,'calendar')).accessToken(),error=>error.status===409);assert.equal((await db.prepare('SELECT active_ciphertext FROM google_connections').first()).active_ciphertext,rotated.ciphertext);
 env.DB=db;await db.prepare('UPDATE google_connections SET active_ciphertext=?,active_iv=?').bind(packed.ciphertext,packed.iv).run();calls=0;
 assert.equal(await (await googleCapability(env,'calendar')).accessToken(),'synthetic-access');assert.equal(calls,1);
 let revision=(await db.prepare('SELECT revision FROM google_connections').first()).revision;
 let state=await success('/admin/connections/google/candidate',{revision,loginEnabled:false,calendarEnabled:true,driveEnabled:false},'POST','admin');

 injected=false;env.DB={prepare:s=>db.prepare(s),batch:async ss=>{if(!injected){injected=true;await db.prepare("UPDATE users SET active=0 WHERE id='admin'").run();}return db.batch(ss);}};
 count=await audits();assert.equal((await http('/admin/connections/google/promote',{revision:state.revision},'POST','admin')).status,409);assert.equal(await audits(),count);
 env.DB=db;await db.prepare("UPDATE users SET active=1 WHERE id='admin'").run();
 state=await success('/admin/connections/google/promote',{revision:state.revision},'POST','admin');assert.equal(state.active.calendarReady,true);
 count=await audits();assert.equal((await http('/admin/connections/google',{revision:state.revision-1,confirmation:'REMOVE GOOGLE CONNECTION'},'DELETE','admin')).status,409);assert.equal(await audits(),count);
 state=await success('/admin/connections/google',{revision:state.revision,confirmation:'REMOVE GOOGLE CONNECTION'},'DELETE','admin');assert.equal(state.active,null);
 }finally{globalThis.fetch=oldFetch;await mf.dispose();}
});

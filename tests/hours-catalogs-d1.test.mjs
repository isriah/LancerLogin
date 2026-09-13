import { migrationStatements } from './migration-statements.mjs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const migrations=new URL('../apps/api/migrations/',import.meta.url);
const sql=name=>migrationStatements(readFileSync(new URL(name,migrations),'utf8'));
test('hours catalogs on populated local D1 preserve core data, enforce live grants, atomic edits and backup isolation',{timeout:120000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{
  const db=await mf.getD1Database('DB');
  for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')&&name<'0032').sort())await db.batch(sql(name).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES ('primary','Synthetic Team','UTC')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,password_hash,role,created_at) VALUES ('admin','primary','admin','preserved-hash','admin','2026-01-01'),('staff','primary','staff','preserved-staff-hash','staff','2026-01-01'),('operator','primary','operator',null,'operator','2026-01-01'),('foreign-user','foreign','foreign',null,'staff','2026-01-01')"),
   db.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,notes,created_by,created_at) VALUES ('meeting','primary','Synthetic Event','2026-09-09T10:00:00Z','2026-09-09T11:00:00Z','PRIVATE ATTENDANCE NOTE','admin','2026-01-01')"),
  ]);
  const prior=(await db.prepare('SELECT * FROM users ORDER BY id').all()).results;
  await db.batch(sql('0032_hours_catalogs.sql').map(s=>db.prepare(s)));
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')&&n>'0032_hours_catalogs.sql').sort())await db.batch(sql(name).map(s=>db.prepare(s)));
  assert.deepEqual((await db.prepare('SELECT * FROM users ORDER BY id').all()).results,prior);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  const env={DB:db,SESSION_KEY:secret,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
  const call=async(path,body,user='admin',method=body?'POST':'GET')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:user,role:'admin'}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  const good=async(path,body,user='admin',method=body?'POST':'GET')=>{const response=await call(path,body,user,method);assert.ok(response.ok,`${path}: ${response.status} ${await response.clone().text()}`);return response.json();};
  assert.equal((await call('/admin/hours/categories')).status,403);
  await good('/admin/modules',{enabled:['hour-tracking'],revision:0},'admin','PUT');
  assert.equal((await call('/admin/hours/categories',undefined,'operator')).status,403);
  await good('/admin/modules/grants/staff',{capabilities:['hours.manage']},'admin','PUT');
  assert.equal((await call('/admin/hours/categories/event',undefined,'staff','DELETE')).status,405);
  assert.equal((await call('/admin/hours/categories',{name:'x'.repeat(17000),mode:'event'},'staff')).status,413);
  const categories=(await good('/admin/hours/categories',undefined,'staff')).items;
  assert.deepEqual(categories.map(row=>[row.name,row.mode,row.impactDefault]).sort(),[['Event','event',false],['Other Service','task',false],['Team Support','team',false]]);
  const team=await good('/admin/hours/teams',{number:'00123',name:'Synthetic Partner',organization:'Synthetic Org',program:'FTC',historicalDescriptors:'Prior support descriptor; not a claim'},'staff');
  const event=await good('/admin/hours/activities',{categoryId:'event',sourceMeetingId:'meeting',responsibleStaffIds:['staff'],partnerTeamIds:[team.id]},'staff');
  let detail=await good('/admin/hours/activities/'+event.id,undefined,'staff');
  assert.equal(detail.title,'Synthetic Event');assert.equal(detail.description,'');assert.equal(detail.sourceState,'current');assert.equal(detail.impactRelevant,false);assert.doesNotMatch(JSON.stringify(detail),/PRIVATE ATTENDANCE NOTE/);
  assert.deepEqual(detail.responsibleStaffIds,['staff']);assert.deepEqual(detail.partnerTeamIds,[team.id]);
  await good('/admin/hours/categories/event',{revision:0,impactDefault:true},'staff','PATCH');
  assert.equal((await good('/admin/hours/activities/'+event.id,undefined,'staff')).impactRelevant,false);
  const event2=await good('/admin/hours/activities',{categoryId:'event',serviceDate:'2026-09-09',title:'Independent overlapping event'},'staff');
  assert.equal((await good('/admin/hours/activities/'+event2.id,undefined,'staff')).impactRelevant,true);
  await good('/admin/hours/activities/'+event2.id,{revision:0,impactRelevant:false},'staff','PATCH');
  assert.equal((await call('/admin/hours/categories/event',{revision:1,mode:'task'},'staff','PATCH')).status,409);
  assert.equal((await db.prepare('SELECT count(*) n FROM meetings').first()).n,1);
  assert.equal((await db.prepare('SELECT count(*) n FROM attendance_events').first()).n,0);
  const support=await good('/admin/hours/activities',{categoryId:'team-support',teamId:team.id,serviceDate:'2026-09-09'},'staff');
  assert.equal((await call('/admin/hours/activities',{categoryId:'team-support',teamId:team.id,serviceDate:'2026-09-09'},'staff')).status,409);
  assert.equal((await call('/admin/hours/activities/'+support.id,{revision:0,serviceDate:'2026-09-10'},'staff','PATCH')).status,400);
  const task=await good('/admin/hours/activities',{categoryId:'other-service',serviceDate:'2026-09-09'},'staff');
  assert.equal((await call('/admin/hours/activities',{categoryId:'other-service',serviceDate:'2026-09-09'},'staff')).status,409);
  for(const body of [{categoryId:'event',serviceDate:'2026-02-30'},{categoryId:'event',serviceDate:'2026-09-09',responsibleStaffIds:['foreign-user']},{categoryId:'event',serviceDate:'2026-09-09',partnerTeamIds:['absent']},{categoryId:'event',serviceDate:'2026-09-09',publishGoogle:true}])assert.ok([400,409].includes((await call('/admin/hours/activities',body,'staff')).status));
  for(const [deny,restore,body] of [["UPDATE hours_categories SET archived=1 WHERE id='event'","UPDATE hours_categories SET archived=0 WHERE id='event'",{categoryId:'event',serviceDate:'2026-09-10'}],["UPDATE hours_teams SET archived=1 WHERE id=?","UPDATE hours_teams SET archived=0 WHERE id=?",{categoryId:'team-support',teamId:team.id,serviceDate:'2026-09-10'}]]){
   const run=statement=>statement.includes('?')?db.prepare(statement).bind(team.id).run():db.prepare(statement).run();
   env.DB={prepare:s=>db.prepare(s),batch:async statements=>{await run(deny);return db.batch(statements);}};
   assert.equal((await call('/admin/hours/activities',body,'staff')).status,409);env.DB=db;await run(restore);
  }
  const page=await good('/admin/hours/activities?limit=2',undefined,'staff');assert.equal(page.items.length,2);assert.ok(page.nextCursor);const page2=await good('/admin/hours/activities?limit=2&after='+page.nextCursor,undefined,'staff');assert.equal(page2.items.length,2);assert.equal(new Set([...page.items,...page2.items].map(row=>row.id)).size,4);
  const zoneBody={categoryId:'event',serviceDate:'2026-09-09',expectedTimeZone:'UTC',startsAt:'2026-09-09T12:00:00Z',endsAt:'2026-09-09T13:00:00Z'};
  const beforeZone=(await db.prepare('SELECT count(*) n FROM hours_activities').first()).n;
  await db.prepare("UPDATE organization_settings SET time_zone='America/New_York' WHERE installation_id='primary'").run();
  assert.equal((await call('/admin/hours/activities',zoneBody,'staff')).status,409);
  await db.prepare("UPDATE organization_settings SET time_zone='UTC' WHERE installation_id='primary'").run();
  env.DB={prepare:s=>db.prepare(s),batch:async statements=>{await db.prepare("UPDATE organization_settings SET time_zone='America/New_York' WHERE installation_id='primary'").run();return db.batch(statements);}};
  assert.equal((await call('/admin/hours/activities',zoneBody,'staff')).status,409);env.DB=db;
  assert.equal((await db.prepare('SELECT count(*) n FROM hours_activities').first()).n,beforeZone);
  await db.prepare("UPDATE organization_settings SET time_zone='UTC' WHERE installation_id='primary'").run();
  const zoneCreated=await good('/admin/hours/activities',zoneBody,'staff'); assert.equal((await good('/admin/hours/activities/'+zoneCreated.id)).planningTimeZone,'UTC');
  const midnight=await good('/admin/hours/activities',{categoryId:'event',serviceDate:'2026-09-09',startsAt:'2026-09-09T00:00:00Z',endsAt:'2026-09-10T00:00:00Z'},'staff');
  for(const endsAt of ['2026-09-10T00:00:00.001Z','2026-09-12T00:00:00Z'])assert.equal((await call('/admin/hours/activities',{categoryId:'event',serviceDate:'2026-09-09',startsAt:'2026-09-09T00:00:00Z',endsAt},'staff')).status,400);
  await db.prepare("UPDATE meetings SET ends_at='2026-09-12T11:00:00Z' WHERE id='meeting'").run();
  assert.equal((await call('/admin/hours/activities',{categoryId:'event',sourceMeetingId:'meeting'},'staff')).status,400);
  const untimed=await good('/admin/hours/activities',{categoryId:'event',sourceMeetingId:'meeting',startsAt:null,endsAt:null},'staff');
  const untimedDetail=await good('/admin/hours/activities/'+untimed.id);
  assert.equal(untimedDetail.startsAt,null);assert.equal(untimedDetail.endsAt,null);assert.equal(untimedDetail.sourceSnapshot.endsAt,'2026-09-12T11:00:00Z');
  assert.equal((await call('/admin/hours/activities',{categoryId:'event',sourceMeetingId:'meeting',startsAt:null},'staff')).status,400);
  const perDay=await good('/admin/hours/activities',{categoryId:'event',sourceMeetingId:'meeting',serviceDate:'2026-09-10',startsAt:'2026-09-10T10:00:00Z',endsAt:'2026-09-10T11:00:00Z'},'staff');
  assert.equal((await good('/admin/hours/activities/'+perDay.id)).sourceSnapshot.endsAt,'2026-09-12T11:00:00Z');
  await db.prepare("UPDATE meetings SET ends_at='2026-09-09T11:00:00Z' WHERE id='meeting'").run();
  await db.prepare("UPDATE organization_settings SET time_zone='America/New_York' WHERE installation_id='primary'").run();
  for(const [serviceDate,startsAt,endsAt,hours] of [['2026-03-08','2026-03-08T00:00:00-05:00','2026-03-09T00:00:00-04:00',23],['2026-11-01','2026-11-01T00:00:00-04:00','2026-11-02T00:00:00-05:00',25]]){
   const day=await good('/admin/hours/activities',{categoryId:'event',serviceDate,startsAt,endsAt},'staff');
   const saved=await good('/admin/hours/activities/'+day.id);assert.equal(saved.planningTimeZone,'America/New_York');assert.equal((Date.parse(saved.endsAt)-Date.parse(saved.startsAt))/3600000,hours);
  }
  await db.prepare("UPDATE organization_settings SET time_zone='Asia/Tokyo' WHERE installation_id='primary'").run();
  await good('/admin/hours/activities/'+midnight.id,{revision:0,title:'Unchanged original day'},'staff','PATCH');
  assert.equal((await good('/admin/hours/activities/'+midnight.id)).planningTimeZone,'UTC');
  const races=await Promise.all([call('/admin/hours/activities/'+event.id,{revision:0,title:'First edit'},'staff','PATCH'),call('/admin/hours/activities/'+event.id,{revision:0,title:'Second edit'},'staff','PATCH')]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  let auditCount=(await db.prepare("SELECT count(*) n FROM audit_log WHERE action LIKE 'hours.%'").first()).n;
  env.DB={prepare:s=>db.prepare(s),batch:async statements=>{await db.prepare("UPDATE platform_module_grants SET hours_manage=0 WHERE user_id='staff'").run();return db.batch(statements);}};
  assert.equal((await call('/admin/hours/activities/'+event.id,{revision:1,title:'Unauthorized',responsibleStaffIds:[],partnerTeamIds:[]},'staff','PATCH')).status,409);env.DB=db;
  assert.equal((await db.prepare("SELECT count(*) n FROM audit_log WHERE action LIKE 'hours.%'").first()).n,auditCount);
  assert.deepEqual((await good('/admin/hours/activities/'+event.id)).responsibleStaffIds,['staff']);
  await good('/admin/modules/grants/staff',{capabilities:['hours.manage']},'admin','PUT');
  for(const [deny,restore] of [["UPDATE users SET active=0 WHERE id='staff'","UPDATE users SET active=1 WHERE id='staff'"],["UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'","UPDATE platform_module_configuration SET hours_enabled=1 WHERE installation_id='primary'"]]){
   env.DB={prepare:s=>db.prepare(s),batch:async statements=>{await db.prepare(deny).run();return db.batch(statements);}};
   assert.equal((await call('/admin/hours/teams/'+team.id,{revision:0,name:'Denied at commit'},'staff','PATCH')).status,409);env.DB=db;await db.prepare(restore).run();
   assert.equal((await db.prepare("SELECT count(*) n FROM audit_log WHERE action LIKE 'hours.%'").first()).n,auditCount);
  }
  await good('/admin/hours/categories/other-service',{revision:0,archived:true},'staff','PATCH');
  await db.prepare("CREATE TRIGGER fail_hours_audit BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'hours.%' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
  assert.equal((await call('/admin/hours/teams/'+team.id,{revision:0,name:'Must rollback'},'staff','PATCH')).status,500);
  assert.equal((await good('/admin/hours/teams/'+team.id)).name,'Synthetic Partner');await db.prepare('DROP TRIGGER fail_hours_audit').run();
  await good('/admin/hours/teams/'+team.id,{revision:0,archived:true},'staff','PATCH');assert.equal((await good('/admin/hours/teams',undefined,'staff')).items.length,0);
  assert.equal((await good('/admin/hours/teams?archived=all',undefined,'staff')).items[0].number,'00123');
  await good('/admin/hours/activities/'+task.id,{revision:0,archived:true},'staff','PATCH');
  await good('/admin/hours/activities/'+task.id,{revision:1,archived:false},'staff','PATCH');
  assert.equal((await good('/admin/hours/activities/'+task.id)).archived,false);
  await good('/admin/hours/activities/'+task.id,{revision:2,archived:true},'staff','PATCH');
  const emptyTeam=await good('/admin/hours/teams',{name:'Minimal team'},'staff');
  const emptyDetail=await good('/admin/hours/teams/'+emptyTeam.id);for(const key of ['number','organization','program','historicalDescriptors'])assert.equal(emptyDetail[key],'');
  await good('/admin/hours/teams/'+emptyTeam.id,{revision:0,archived:true},'staff','PATCH');
  await good('/admin/hours/teams/'+emptyTeam.id,{revision:1,archived:false},'staff','PATCH');
  assert.equal((await good('/admin/hours/teams/'+emptyTeam.id)).archived,false);
  const beforeDisable=(await db.prepare('SELECT * FROM hours_activities ORDER BY id').all()).results;
  await good('/admin/modules',{enabled:[],revision:1},'admin','PUT');assert.equal((await call('/admin/hours/activities',undefined,'staff')).status,403);assert.deepEqual((await db.prepare('SELECT * FROM hours_activities ORDER BY id').all()).results,beforeDisable);
  await good('/admin/modules',{enabled:['hour-tracking'],revision:2},'admin','PUT');
  await db.prepare("UPDATE meetings SET title='Changed core title' WHERE id='meeting'").run();assert.equal((await good('/admin/hours/activities/'+event.id)).sourceState,'changed');
  const meetingBackup=await good('/admin/data/backup?scope=meetings');
  await good('/admin/data',{scope:'attendance',confirmation:'DELETE ATTENDANCE'},'admin','DELETE');assert.equal((await good('/admin/hours/activities/'+event.id)).sourceState,'unavailable');
  assert.deepEqual((await db.prepare('SELECT * FROM hours_activities ORDER BY id').all()).results,beforeDisable);
  await good('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meetingBackup});assert.equal((await good('/admin/hours/activities/'+event.id)).sourceState,'changed');
  const backup=await good('/admin/data/backup?scope=installation');assert.equal(backup.schemaVersion,28);
  const multiday=structuredClone(backup);const timed=multiday.tables.hours_activities.find(row=>row.id===midnight.id);timed.ends_at='2026-09-12T00:00:00Z';assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:multiday})).status,400);
  const badZone=structuredClone(backup);badZone.tables.hours_activities[0].planning_time_zone='Invalid/Zone';assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:badZone})).status,400);
  const bad=structuredClone(backup);bad.tables.hours_activity_staff[0].user_id='foreign-user';assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:bad})).status,400);
  const leaked=structuredClone(backup);leaked.tables.hours_activities.find(row=>row.source_snapshot).source_snapshot='{"private":"must reject"}';assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:leaked})).status,400);
  await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});
  for(const table of ['hours_categories','hours_teams','hours_activities','hours_activity_staff','hours_activity_teams'])assert.deepEqual((await db.prepare(`SELECT * FROM ${table} WHERE installation_id='primary' ORDER BY 1,2`).all()).results,backup.tables[table].sort((a,b)=>String(a.id??a.activity_id).localeCompare(String(b.id??b.activity_id))));
  assert.deepEqual((await db.prepare('SELECT * FROM users ORDER BY id').all()).results,prior);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  const legacy=structuredClone(backup);legacy.schemaVersion=16;for(const table of Object.keys(legacy.tables).filter(name=>name.startsWith('hours_')))delete legacy.tables[table];await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy});assert.equal((await good('/admin/hours/categories')).items.length,3);
  await db.prepare("DELETE FROM installations WHERE id='primary'").run();
  env.APP_MODE='unconfigured';env.BOOTSTRAP_CODE_HASH=createHash('sha256').update('synthetic-setup-code').digest('base64url');
  const setup=await call('/setup/bootstrap',{setupCode:'synthetic-setup-code',organizationName:'Synthetic Fresh Team',timeZone:'UTC',authMode:'local',localUsername:'synthetic-admin',localPassword:'synthetic-test-password'});
  assert.equal(setup.status,201,await setup.text());
  assert.equal((await db.prepare("SELECT count(*) n FROM hours_categories WHERE installation_id='primary'").first()).n,3);
  assert.equal((await db.prepare("SELECT sum(impact_default) n FROM hours_categories WHERE installation_id='primary'").first()).n,0);
 }finally{await mf.dispose();}
});

test('hours planning selectors on local D1 expose only bounded labels and planning data under current grants',{timeout:60000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try {
  const db=await mf.getD1Database('DB');for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort())await db.batch(sql(name).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES ('primary','Synthetic Team','America/New_York')"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('member','primary','private-roster-id','Synthetic','Planner','private-member@example.test','2026-01-01')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,email,password_hash,role,created_at,member_id) VALUES ('admin','primary','admin','private-admin@example.test','PRIVATE-HASH','admin','2026-01-01',NULL),('staff','primary','staff',NULL,NULL,'staff','2026-01-01','member'),('operator','primary','operator',NULL,NULL,'operator','2026-01-01',NULL),('unnamed','primary',NULL,'private-google@example.test',NULL,'staff','2026-01-01',NULL),('inactive','primary','inactive',NULL,NULL,'staff','2026-01-01',NULL),('hidden','primary','hidden',NULL,NULL,'staff','2026-01-01',NULL),('foreign-user','foreign','foreign',NULL,NULL,'staff','2026-01-01',NULL)"),
   db.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,notes,created_by,created_at,is_test,deleted_at) VALUES ('a-source','primary','Synthetic late event','2026-09-10T02:00:00Z','2026-09-10T03:00:00Z','PRIVATE NOTE','admin','2026-01-01',0,NULL),('b-source','primary','Synthetic next event','2026-09-10T14:00:00Z','2026-09-10T15:00:00Z','PRIVATE NOTE','admin','2026-01-01',0,NULL),('test-source','primary','PRIVATE TEST','2026-09-10T14:00:00Z',NULL,NULL,'admin','2026-01-01',1,NULL),('deleted-source','primary','PRIVATE DELETED','2026-09-10T14:00:00Z',NULL,NULL,'admin','2026-01-01',0,'2026-01-01'),('foreign-source','foreign','PRIVATE FOREIGN','2026-09-10T14:00:00Z',NULL,NULL,'foreign-user','2026-01-01',0,NULL)"),
  ]);
  const env={DB:db,SESSION_KEY:secret,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
  const call=async(path,user='staff',body,method=body?'POST':'GET')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:user,role:'admin'}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  const good=async(path,user='staff',body,method)=>{const r=await call(path,user,body,method);assert.equal(r.status,200,await r.clone().text());return r.json();};
  assert.equal((await call('/admin/hours/responsible-staff')).status,403);
  await good('/admin/modules','admin',{enabled:['hour-tracking'],revision:0},'PUT');await good('/admin/modules/grants/staff','admin',{capabilities:['hours.manage']},'PUT');
  await db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES ('primary','event','Event','event','2026-01-01','2026-01-01')").run();
  const created=await call('/admin/hours/activities','staff',{categoryId:'event',serviceDate:'2026-09-09',responsibleStaffIds:['inactive','unnamed']});assert.equal(created.status,201);const activity=(await created.json()).id;
  await db.prepare("UPDATE users SET active=0 WHERE id IN ('inactive','hidden')").run();
  let result=await good('/admin/hours/responsible-staff');assert.deepEqual(result.items.map(x=>x.id),['admin','operator','staff','unnamed']);assert.deepEqual(Object.keys(result.items[0]).sort(),['active','id','label','linked','selectable']);
  assert.equal(result.items.find(x=>x.id==='staff').label,'Synthetic Planner');assert.deepEqual(result.items.find(x=>x.id==='unnamed'),{id:'unnamed',label:'Account needs a roster link or local username',active:true,selectable:false,linked:false});
  assert.doesNotMatch(JSON.stringify(result),/private-|PRIVATE|memberId|email|password|role|foreign|hidden/);
  result=await good('/admin/hours/responsible-staff?activityId='+activity);assert.equal(result.items.find(x=>x.id==='inactive').active,false);assert.equal(result.items.find(x=>x.id==='inactive').selectable,false);assert.equal(result.items.find(x=>x.id==='inactive').linked,true);assert.equal(result.items.find(x=>x.id==='unnamed').label,'Previously linked account — display identity unavailable');assert.ok(!result.items.some(x=>x.id==='hidden'));
  const page=await good('/admin/hours/responsible-staff?limit=1');assert.equal(page.items.length,1);assert.equal(page.nextCursor,'admin');assert.equal((await good('/admin/hours/responsible-staff?limit=1&after=admin')).items[0].id,'operator');
  await db.batch([db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES ('foreign','foreign-event','Foreign','event','2026-01-01','2026-01-01')"),db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES ('foreign','foreign-activity','foreign-event','event','2026-09-09','Private','UTC',0,'2026-01-01','2026-01-01')")]);
  assert.equal((await call('/admin/hours/responsible-staff?activityId=foreign-activity')).status,404);
  assert.equal((await call('/admin/hours/responsible-staff?activityId=foreign')).status,404);
  result=await good('/admin/hours/attendance-sources?limit=1');assert.equal(result.nextCursor,'a-source');assert.equal(result.timeZone,'America/New_York');assert.deepEqual(result.items,[{id:'a-source',title:'Synthetic late event',startsAt:'2026-09-10T02:00:00Z',endsAt:'2026-09-10T03:00:00Z',serviceDate:'2026-09-09'}]);
  assert.deepEqual((await good('/admin/hours/attendance-sources?after=a-source')).items.map(x=>x.id),['b-source']);
  result=await good('/admin/hours/attendance-sources?from=2026-09-10T02%3A00%3A00Z&to=2026-09-10T14%3A00%3A00Z');assert.equal(result.items.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|notes|attendance|required|isTest|createdBy|weight|roster/);
  for(const path of ['/admin/hours/responsible-staff?limit=101','/admin/hours/responsible-staff?limit=1&limit=2','/admin/hours/responsible-staff?active=all','/admin/hours/responsible-staff?after='+('x'.repeat(129)),'/admin/hours/attendance-sources?from=2026-02-30T00:00:00Z','/admin/hours/attendance-sources?from=2026-09-10T00:00:00Z&to=2026-09-09T00:00:00Z','/admin/hours/attendance-sources?includeNotes=true','/admin/hours/attendance-sources?from=2026-09-10T00:00:00Z&from=2026-09-10T00:00:00Z','/admin/hours/responsible-staff?activityId=','/admin/hours/responsible-staff?activityId='+('x'.repeat(129))])assert.equal((await call(path)).status,400,path);
  for(const path of ['/admin/hours/responsible-staff','/admin/hours/attendance-sources']){assert.equal((await call(path,'operator')).status,403);assert.equal((await call(path,'staff',{},'POST')).status,405);}
  assert.equal((await call('/admin/users')).status,403);assert.equal((await call('/meetings')).status,403);
  await db.prepare("UPDATE organization_settings SET time_zone='UTC' WHERE installation_id='primary'").run();
  await db.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('year-zero','primary','Early date','0000-06-01T10:00:00Z','0000-06-01T11:00:00Z','admin','2026-01-01'),('year-99','primary','Early year','0099-06-01T10:00:00Z','0099-06-01T11:00:00Z','admin','2026-01-01')").run();
  assert.deepEqual((await good('/admin/hours/attendance-sources?to=0100-01-01T00:00:00Z')).items.map(item=>item.serviceDate).sort(),['0000-06-01','0099-06-01']);
  for(const [source,expected] of [['year-zero','0000-06-01'],['year-99','0099-06-01']]){const r=await call('/admin/hours/activities','staff',{categoryId:'event',sourceMeetingId:source});assert.equal(r.status,201,await r.clone().text());const saved=await good('/admin/hours/activities/'+(await r.json()).id);assert.equal(saved.serviceDate,expected);assert.equal(saved.sourceSnapshot.serviceDate,expected);assert.equal(saved.sourceState,'current');}

  await db.prepare("UPDATE platform_module_grants SET hours_manage=0 WHERE user_id='staff'").run();assert.equal((await call('/admin/hours/responsible-staff')).status,403);
  await db.prepare("UPDATE platform_module_grants SET hours_manage=1 WHERE user_id='staff'").run();await db.prepare("UPDATE users SET active=0 WHERE id='staff'").run();assert.equal((await call('/admin/hours/attendance-sources')).status,401);
  await db.prepare("UPDATE users SET active=1 WHERE id='staff'").run();await db.prepare("UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'").run();assert.equal((await call('/admin/hours/attendance-sources')).status,403);
 }finally{await mf.dispose();}
});

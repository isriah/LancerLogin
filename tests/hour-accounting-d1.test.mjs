import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readdirSync,readFileSync } from 'node:fs';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery as migrationStatements } from 'wrangler';
import { DatabaseSync } from 'node:sqlite';
import { hoursCatalogRoute } from '../apps/api/src/hours-catalogs.ts';
import worker from '../apps/api/src/index.ts';
import { submitStaffHours,submitSelfAssertedHours,submitLinkedDiscordHours,accountingRoute } from '../apps/api/src/hour-accounting.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';
const migrations=new URL('../apps/api/migrations/',import.meta.url);
test('accounting migration uses hosted-compatible trigger predicates and pinned Wrangler local transport',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')&&n<'0033').sort())db.exec(readFileSync(new URL(name,migrations),'utf8'));
  const sql=readFileSync(new URL('0033_hour_accounting.sql',migrations),'utf8');
  // The hosted query parser rejects CASE ... END inside trigger BEGIN ... END,
  // although SQLite and Wrangler's local splitter accept it (see transport doc).
  const chunks=migrationStatements(sql);
  assert.equal(chunks.length,16);
  const triggers=chunks.filter(s=>/CREATE TRIGGER/i.test(s));
  assert.equal(triggers.length,6);
  for(const trigger of triggers){assert.doesNotMatch(trigger,/\bCASE\b/i);assert.match(trigger,/END;?\s*$/i);}
  for(const statement of chunks)db.exec(statement);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'hours_%'").get().n,6);
 }finally{db.close();}
});
const now=Date.parse('2026-01-20T18:00:00Z'),secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const failure=async(p,status)=>assert.rejects(p,error=>error.status===status);
const key=n=>'synthetic-submission-'+n;
function counted(db){let count=0;const wrap=s=>({raw:s,bind:(...v)=>wrap(s.bind(...v)),first:(...v)=>{count++;return s.first(...v);},all:()=>{count++;return s.all();},run:()=>{count++;return s.run();}});return {db:{prepare:s=>wrap(db.prepare(s)),batch:s=>{count+=s.length;return db.batch(s.map(x=>x.raw));}},get:()=>count};}

test('accounting migration and real D1 transactions preserve exact history, overlap safety, receipts and roster identities',{timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{
  const db=await mf.getD1Database('DB');
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')&&n<'0033').sort())await db.batch(migrationStatements(readFileSync(new URL(name,migrations),'utf8')).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic Team','UTC')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01'),('staff','primary','synthetic-staff','staff','2026-01-01'),('operator','primary','synthetic-operator','operator','2026-01-01')"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,created_at) VALUES('m1','primary','00123','Synthetic','One','123456789012345678','2026-01-01'),('m2','primary','00456','Synthetic','Two',null,'2026-01-01'),('other','foreign','00123','Synthetic','Foreign',null,'2026-01-01')"),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01'),('primary','task','Other Service','task','2026-01-01','2026-01-01'),('primary','team','Team Support','team','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_teams(installation_id,id,name,created_at,updated_at) VALUES('primary','team1','Synthetic Partner','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO platform_module_configuration(installation_id,hours_enabled) VALUES('primary',1)"),
   db.prepare("INSERT INTO platform_module_grants(installation_id,user_id,hours_manage) VALUES('primary','staff',1)"),
  ]);
  const beforeUsers=(await db.prepare('SELECT * FROM users ORDER BY id').all()).results;
  await db.batch(migrationStatements(readFileSync(new URL('0033_hour_accounting.sql',migrations),'utf8')).map(s=>db.prepare(s)));
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')&&n>'0033_hour_accounting.sql').sort())await db.batch(migrationStatements(readFileSync(new URL(name,migrations),'utf8')).map(s=>db.prepare(s)));
  assert.deepEqual((await db.prepare('SELECT * FROM users ORDER BY id').all()).results,beforeUsers);
  const env={DB:db,SESSION_KEY:secret,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.test'};
  const http=async(path,body,method=body?'POST':'GET')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:'admin',role:'admin'}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  const good=async(path,body,method)=>{const r=await http(path,body,method);assert.ok(r.ok,await r.clone().text());return r.json();};
  const route=async(path,body,method=body?'POST':'GET',database=db,at=now)=> (await accountingRoute(database,'primary','staff',new Request('https://fixture.test/admin/hours/'+path,{method}),body,at)).body;
  const event=await good('/admin/hours/activities',{categoryId:'event',serviceDate:'2026-01-20',title:'Synthetic Event'});
  const old=await good('/admin/hours/activities',{categoryId:'event',serviceDate:'2025-01-01',title:'Old Event'});
  const payload={memberId:'m1',activityId:event.id,startLocal:'09:00',endLocal:'10:00',endNextDay:false,idempotencyKey:key('first')};
  assert.equal((await http('/admin/hours/entries',payload)).status,400);
  await failure(submitStaffHours(db,'primary','staff',{...payload,expectedTimeZone:'America/New_York'},now),409);
  const settingsContext=await route('entry-settings');assert.equal(settingsContext.timeZone,'UTC');assert.equal(settingsContext.today,'2026-01-20');
  const measuredHttp=counted(db);env.DB=measuredHttp.db;
  const httpReceipt=await good('/admin/hours/entries',{...payload,memberId:'m2',startLocal:'16:00',endLocal:'17:00',expectedTimeZone:'UTC',idempotencyKey:key('http')});env.DB=db;
  assert.equal(httpReceipt.duration_minutes,60);assert.ok(measuredHttp.get()<50);console.log('Staff HTTP entry local D1 statement count:',measuredHttp.get());
  const measured=counted(db),first=await submitStaffHours(measured.db,'primary','staff',payload,now);assert.equal(first.duration_minutes,60);assert.ok(measured.get()<50);console.log('Staff entry local D1 statement count:',measured.get());
  assert.deepEqual(await submitStaffHours(db,'primary','staff',payload,now),first);
  await failure(submitStaffHours(db,'primary','staff',{...payload,endLocal:'11:00'},now),409);
  await failure(submitStaffHours(db,'primary','operator',{...payload,idempotencyKey:key('operator')},now),403);
  await failure(submitSelfAssertedHours(db,'primary',{...payload,memberId:'00123',idempotencyKey:key('overlap')},now),409);
  const duplicate={...payload,memberId:'00123',startLocal:'10:00',endLocal:'11:00',idempotencyKey:key('parallel')};
  const retry=await Promise.all([submitSelfAssertedHours(db,'primary',duplicate,now),submitSelfAssertedHours(db,'primary',duplicate,now)]);assert.deepEqual(retry[0],retry[1]);
  const concurrent=await Promise.allSettled([submitSelfAssertedHours(db,'primary',{...duplicate,startLocal:'11:00',endLocal:'12:00',idempotencyKey:key('race-public')},now),submitLinkedDiscordHours(db,'primary','123456789012345678',{activityId:event.id,startLocal:'11:30',endLocal:'12:30',endNextDay:false,idempotencyKey:key('race-discord')},now)]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal(concurrent.find(r=>r.status==='rejected').reason.status,409);
  await failure(submitSelfAssertedHours(db,'primary',{...duplicate,channel:'staff',idempotencyKey:key('forge')},now),400);
  await failure(submitSelfAssertedHours(db,'primary',{...duplicate,memberId:'123',idempotencyKey:key('zeros')},now),400);
  await failure(submitStaffHours(db,'primary','staff',{...payload,startLocal:'19:00',endLocal:'20:00',idempotencyKey:key('future')},now),400);
  await failure(submitStaffHours(db,'primary','staff',{...payload,startLocal:'23:00',endLocal:'01:00',idempotencyKey:key('overnight-no')},now),400);
  await failure(submitStaffHours(db,'primary','staff',{...payload,startLocal:'08:00',endLocal:'08:01:01',idempotencyKey:key('fraction')},now),400);
  const taskPayload={memberId:'m2',categoryId:'task',serviceDate:'2026-01-19',startLocal:'23:00',endLocal:'01:00',endNextDay:true,taskNotes:'Synthetic task',idempotencyKey:key('task')};
  const measuredTask=counted(db),task=await submitStaffHours(measuredTask.db,'primary','staff',taskPayload,now);assert.equal(task.duration_minutes,120);assert.ok(measuredTask.get()<50);console.log('Canonical task entry local D1 statement count:',measuredTask.get());
  const support=await Promise.all([submitStaffHours(db,'primary','staff',{memberId:'m1',categoryId:'team',teamId:'team1',serviceDate:'2026-01-18',startLocal:'09:00',endLocal:'10:00',endNextDay:false,idempotencyKey:key('team1')},now),submitStaffHours(db,'primary','staff',{memberId:'m2',categoryId:'team',teamId:'team1',serviceDate:'2026-01-18',startLocal:'09:00',endLocal:'10:00',endNextDay:false,idempotencyKey:key('team2')},now)]);assert.equal(support[0].activity_id,support[1].activity_id);
  await failure(route('entries/'+first.id,{revision:0,memberId:'m2',activityId:task.activity_id,startLocal:'23:30',endLocal:'00:30',endNextDay:true,reason:'Correct mistaken member'},'PATCH'),409);
  const corrected=await route('entries/'+first.id,{revision:0,memberId:'m2',reason:'Correct mistaken member'},'PATCH');assert.equal(corrected.revision,1);
  await route('entries/'+first.id+'/void',{revision:1,reason:'Duplicate staff record'});assert.deepEqual(await submitStaffHours(db,'primary','staff',payload,now),first);
  const history=await route('entries/'+first.id+'/history');assert.deepEqual(history.items.map(r=>[r.revision,r.memberId,r.action]),[[0,'m1','created'],[1,'m2','corrected'],[2,'m2','voided']]);
  assert.equal((await http('/admin/hours/activities/'+event.id,{revision:0,serviceDate:'2026-01-21'},'PATCH')).status,409);
  await good('/admin/hours/activities/'+event.id,{revision:0,title:'Planning may change'},'PATCH');
  await failure(route('entries/'+first.id,{revision:0,reason:'Stale'},'PATCH'),409);
  const staffHistorical=await submitStaffHours(db,'primary','staff',{...payload,activityId:old.id,idempotencyKey:key('historical')},now);assert.equal(staffHistorical.duration_minutes,60);
  const oldPublic={memberId:'00123',activityId:old.id,startLocal:'10:00',endLocal:'11:00',endNextDay:false,idempotencyKey:key('reopen')};
  await failure(submitSelfAssertedHours(db,'primary',oldPublic,now),409);
  const window=await route('reopen-windows',{activityId:old.id,durationHours:1});await submitSelfAssertedHours(db,'primary',oldPublic,now);
  await failure(submitSelfAssertedHours(db,'primary',{...oldPublic,startLocal:'11:00',endLocal:'12:00',idempotencyKey:key('expired')},now+3600000),409);
  await route('reopen-windows/'+window.id,{revision:0,revoked:true},'PATCH');
  await route('reopen-windows',{activityId:null});
  await failure(submitSelfAssertedHours(db,'primary',{memberId:'00123',categoryId:'task',serviceDate:'2025-01-01',startLocal:'12:00',endLocal:'13:00',endNextDay:false,idempotencyKey:key('global-task')},now),409);
  const eligible={memberId:'00123',categoryId:'task',serviceDate:'2026-01-14',startLocal:'10:00',endLocal:'11:00',endNextDay:false,idempotencyKey:key('day-seven')};
  await submitSelfAssertedHours(db,'primary',eligible,now);
  await failure(submitSelfAssertedHours(db,'primary',{...eligible,serviceDate:'2026-01-13',idempotencyKey:key('day-eight')},now),409);
  await route('entry-settings',{revision:0,reportingDays:8,reopenHours:2},'PUT');
  await submitSelfAssertedHours(db,'primary',{...eligible,serviceDate:'2026-01-13',idempotencyKey:key('configured-eight')},now);
  await route('entry-settings',{revision:1,reportingDays:7},'PUT');
  await db.prepare("UPDATE organization_settings SET time_zone='America/New_York' WHERE installation_id='primary'").run();
  const zoned=await submitSelfAssertedHours(db,'primary',{...eligible,memberId:'00456',idempotencyKey:key('local-cutoff')},Date.parse('2026-01-21T00:30:00Z'));
  assert.equal(zoned.time_zone,'America/New_York');
  const dst=await submitStaffHours(db,'primary','staff',{memberId:'m2',categoryId:'task',serviceDate:'2025-11-02',startLocal:'00:30',endLocal:'02:30',endNextDay:false,idempotencyKey:key('dst')},now);assert.equal(dst.duration_minutes,180);
  await failure(submitStaffHours(db,'primary','staff',{memberId:'m2',categoryId:'task',serviceDate:'2025-11-02',startLocal:'01:30',endLocal:'02:00',endNextDay:false,idempotencyKey:key('fold')},now),400);
  await db.prepare("UPDATE organization_settings SET time_zone='UTC' WHERE installation_id='primary'").run();
  await route('entries/'+zoned.id,{revision:0,taskNotes:'Saved zone remains',reason:'Clarify task'},'PATCH',db,Date.parse('2026-01-21T00:31:00Z'));assert.equal((await route('entries/'+zoned.id)).timeZone,'America/New_York');
  const beforeVoid=await route('entries/'+zoned.id),formatParts=Intl.DateTimeFormat.prototype.formatToParts;
  Intl.DateTimeFormat.prototype.formatToParts=function(...args){if(this.resolvedOptions().timeZone==='America/New_York')throw new Error('Synthetic historical timezone interpretation changed');return formatParts.apply(this,args);};
  try{await route('entries/'+zoned.id+'/void',{revision:1,reason:'Void without reinterpreting clocks'},'POST',db,Date.parse('2026-01-21T00:32:00Z'));}finally{Intl.DateTimeFormat.prototype.formatToParts=formatParts;}
  const afterVoid=await route('entries/'+zoned.id);for(const field of ['timeZone','startLocal','endLocal','startMs','endMs','durationMinutes','startOffsetSeconds','endOffsetSeconds'])assert.equal(afterVoid[field],beforeVoid[field]);
  const ancient=await submitStaffHours(db,'primary','staff',{memberId:'m2',categoryId:'task',serviceDate:'0000-01-01',startLocal:'00:00',endLocal:'01:00',endNextDay:false,idempotencyKey:key('year-zero')},now);assert.equal(ancient.duration_minutes,60);
  const dateRace=await good('/admin/hours/activities',{categoryId:'event',serviceDate:'2026-01-16',title:'Date race'});
  const dateWrapped={prepare:s=>db.prepare(s),batch:async statements=>{await submitStaffHours(db,'primary','staff',{...payload,activityId:dateRace.id,idempotencyKey:key('date-race')},now);return db.batch(statements);}};
  await failure(hoursCatalogRoute(dateWrapped,'primary','staff',new Request('https://fixture.test/admin/hours/activities/'+dateRace.id,{method:'PATCH'}),{revision:0,serviceDate:'2026-01-17'}),409);
  const moved=await good('/admin/hours/activities',{categoryId:'event',serviceDate:'2026-01-15',title:'Move first'});
  const movedDb={prepare:s=>db.prepare(s),batch:async statements=>{await db.prepare('UPDATE hours_activities SET service_date=?,revision=revision+1 WHERE id=?').bind('2026-01-16',moved.id).run();return db.batch(statements);}};
  await failure(submitStaffHours(movedDb,'primary','staff',{...payload,activityId:moved.id,idempotencyKey:key('moved')},now),409);
  const beforeDenied=(await db.prepare('SELECT count(*) n FROM hours_entries').first()).n;
  for(const [deny,restore,kind] of [["UPDATE platform_module_grants SET hours_manage=0 WHERE user_id='staff'","UPDATE platform_module_grants SET hours_manage=1 WHERE user_id='staff'",'staff'],["UPDATE members SET active=0 WHERE id='m1'","UPDATE members SET active=1 WHERE id='m1'",'public'],["UPDATE members SET discord_user_id=NULL WHERE id='m1'","UPDATE members SET discord_user_id='123456789012345678' WHERE id='m1'",'discord']]){
   const wrapped={prepare:s=>db.prepare(s),batch:async statements=>{await db.prepare(deny).run();return db.batch(statements);}};
   const data={activityId:event.id,startLocal:'15:00',endLocal:'16:00',endNextDay:false,idempotencyKey:key('revoked-'+kind)};
   await failure(kind==='staff'?submitStaffHours(wrapped,'primary','staff',{...data,memberId:'m1'},now):kind==='public'?submitSelfAssertedHours(wrapped,'primary',{...data,memberId:'00123'},now):submitLinkedDiscordHours(wrapped,'primary','123456789012345678',data,now),409);await db.prepare(restore).run();
  }
  for(const [deny,restore] of [["UPDATE users SET active=0 WHERE id='staff'","UPDATE users SET active=1 WHERE id='staff'"],["UPDATE platform_module_configuration SET hours_enabled=0 WHERE installation_id='primary'","UPDATE platform_module_configuration SET hours_enabled=1 WHERE installation_id='primary'"],["UPDATE hours_categories SET archived=1 WHERE id='task'","UPDATE hours_categories SET archived=0 WHERE id='task'"],["UPDATE organization_settings SET time_zone='Asia/Tokyo' WHERE installation_id='primary'","UPDATE organization_settings SET time_zone='UTC' WHERE installation_id='primary'"]]){
   const wrapped={prepare:s=>db.prepare(s),batch:async statements=>{await db.prepare(deny).run();return db.batch(statements);}};
   await failure(submitStaffHours(wrapped,'primary','staff',{...taskPayload,serviceDate:'2026-01-12',idempotencyKey:key(deny)},now),409);await db.prepare(restore).run();
  }
  assert.equal((await db.prepare('SELECT count(*) n FROM hours_entries').first()).n,beforeDenied);
  await db.prepare("CREATE TRIGGER fail_hour_audit BEFORE INSERT ON audit_log WHEN NEW.action='hours.entry.created' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
  await assert.rejects(submitStaffHours(db,'primary','staff',{...payload,categoryId:'task',activityId:undefined,serviceDate:'2026-01-17',idempotencyKey:key('rollback')},now));await db.prepare('DROP TRIGGER fail_hour_audit').run();assert.equal(await db.prepare("SELECT id FROM hours_activities WHERE category_id='task' AND service_date='2026-01-17'").first(),null);
  assert.equal((await http('/admin/members/m1',{confirmation:'DELETE MEMBER 00123'},'DELETE')).status,409);
  assert.equal((await http('/admin/data',{scope:'roster',confirmation:'DELETE ROSTER'},'DELETE')).status,409);
  await db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('m3','primary','00789','Synthetic','Prior','2026-01-01'),('m4','primary','00999','Synthetic','Current','2026-01-01')").run();
  const reassigned=await submitStaffHours(db,'primary','staff',{...payload,memberId:'m3',idempotencyKey:key('prior-only')},now);
  await route('entries/'+reassigned.id,{revision:0,memberId:'m4',reason:'Correct attribution'},'PATCH');await route('entries/'+reassigned.id+'/void',{revision:1,reason:'Void mistaken record'});
  assert.equal((await db.prepare("SELECT count(*) n FROM hours_entries WHERE member_id='m3'").first()).n,0);
  assert.equal((await http('/admin/members/m3',{confirmation:'DELETE MEMBER 00789'},'DELETE')).status,409);
  assert.equal((await http('/admin/members/m4',{confirmation:'DELETE MEMBER 00999'},'DELETE')).status,409);
  const sum=(await db.prepare("SELECT sum(duration_minutes) n FROM hours_entries WHERE status='counted'").first()).n;assert.ok(Number.isInteger(sum)&&sum>0);
  await good('/admin/members/m3',{active:false},'PATCH');
  await submitStaffHours(db,'primary','staff',{...payload,memberId:'m3',activityId:old.id,startLocal:'15:00',endLocal:'16:00',idempotencyKey:key('archived-staff')},now);
  await assert.rejects(db.prepare('UPDATE hours_submission_keys SET receipt=receipt').run(),/hours_receipt_immutable/);
  await assert.rejects(db.prepare('UPDATE hours_entry_revisions SET snapshot=snapshot').run(),/hours_revision_immutable/);
  await assert.rejects(db.prepare("UPDATE hours_entries SET time_zone='Asia/Tokyo'").run(),/hours_entry_provenance/);
  const preserved=(await db.prepare('SELECT * FROM hours_entries ORDER BY id').all()).results;
  await good('/admin/modules',{enabled:[],revision:0},'PUT');
  await failure(submitSelfAssertedHours(db,'primary',duplicate,now),403);
  assert.deepEqual((await db.prepare('SELECT * FROM hours_entries ORDER BY id').all()).results,preserved);
  await good('/admin/modules',{enabled:['hour-tracking'],revision:1},'PUT');
  await db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('m5','primary','00005','Synthetic','Race','2026-01-01'),('m7','primary','00007','Synthetic','Unused','2026-01-01')").run();
  await db.prepare("UPDATE users SET member_id='m5' WHERE id='operator'").run();
  env.DB={prepare:s=>db.prepare(s),batch:async statements=>{await submitStaffHours(db,'primary','staff',{...payload,memberId:'m5',idempotencyKey:key('delete-race')},now);return db.batch(statements);}};
  assert.equal((await http('/admin/members/m5',{confirmation:'DELETE MEMBER 00005'},'DELETE')).status,409);env.DB=db;
  assert.equal((await db.prepare("SELECT member_id FROM users WHERE id='operator'").first()).member_id,'m5');
  await db.prepare("UPDATE users SET member_id='m7' WHERE id='operator'").run();
  await db.prepare("CREATE TRIGGER fail_roster_audit BEFORE INSERT ON audit_log WHEN NEW.action='roster.member_deleted' BEGIN SELECT RAISE(ABORT,'synthetic roster audit failure'); END").run();
  assert.equal((await http('/admin/members/m7',{confirmation:'DELETE MEMBER 00007'},'DELETE')).status,500);
  assert.equal((await db.prepare("SELECT member_id FROM users WHERE id='operator'").first()).member_id,'m7');
  assert.ok(await db.prepare("SELECT id FROM members WHERE id='m7'").first());await db.prepare('DROP TRIGGER fail_roster_audit').run();
  await good('/admin/members/m7',{confirmation:'DELETE MEMBER 00007'},'DELETE');assert.equal((await db.prepare("SELECT member_id FROM users WHERE id='operator'").first()).member_id,null);
  const allEntries=(await db.prepare('SELECT * FROM hours_entries ORDER BY id').all()).results;
  await good('/admin/members',{mode:'replace',members:[{memberId:'00456',firstName:'Synthetic',lastName:'Renamed'}]});assert.equal((await db.prepare("SELECT active FROM members WHERE id='m1'").first()).active,0);
  await good('/admin/members',{mode:'merge',members:[{memberId:'00123',firstName:'Synthetic',lastName:'Restored'}]});assert.equal((await db.prepare("SELECT id FROM members WHERE external_id='00123' AND installation_id='primary'").first()).id,'m1');
  const roster=await good('/admin/data/backup?scope=roster');roster.tables.members.find(r=>r.id==='m1').id='different-backup-id';await good('/admin/data/restore',{scope:'roster',confirmation:'RESTORE ROSTER',backup:roster});assert.equal((await db.prepare("SELECT id FROM members WHERE external_id='00123' AND installation_id='primary'").first()).id,'m1');
  await good('/admin/data',{scope:'attendance',confirmation:'DELETE ATTENDANCE'},'DELETE');assert.deepEqual((await db.prepare('SELECT * FROM hours_entries ORDER BY id').all()).results,allEntries);
  let injected=false,releaseRead;const mutationDone=new Promise(resolve=>{releaseRead=resolve;});
  const inject=async()=>{if(injected)return;injected=true;await submitStaffHours(db,'primary','staff',{...payload,memberId:'m5',startLocal:'15:00',endLocal:'16:00',idempotencyKey:key('snapshot-race')},now);releaseRead();};
  const wrapRead=(sql,values=[])=>{const raw=db.prepare(sql).bind(...values);return {raw,bind:(...args)=>wrapRead(sql,args),first:()=>raw.first(),run:()=>raw.run(),all:async()=>{if(/FROM hours_entry_revisions|FROM hours_submission_keys/.test(sql))await mutationDone;const result=await raw.all();if(/FROM hours_entries\b/.test(sql))await inject();return result;}};};
  env.DB={prepare:s=>wrapRead(s),batch:async statements=>{const result=await db.batch(statements.map(s=>s.raw));await inject();return result;}};
  const backup=await good('/admin/data/backup?scope=installation');env.DB=db;assert.equal(backup.schemaVersion,28);assert.equal(injected,true);assert.equal(backup.tables.hours_submission_keys.length,backup.tables.hours_entries.length);assert.equal((await db.prepare('SELECT count(*) n FROM hours_entries').first()).n,backup.tables.hours_entries.length+1);
  for(const damage of [b=>b.tables.hours_entries[0].duration_minutes++,b=>b.tables.hours_entry_revisions.pop(),b=>b.tables.hours_submission_keys[0].receipt='{}',b=>b.tables.hours_entries[0].member_id='other']){const invalid=structuredClone(backup);damage(invalid);assert.equal((await http('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:invalid})).status,400);}
  await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup});assert.deepEqual((await db.prepare('SELECT * FROM hours_entries ORDER BY id').all()).results,allEntries);assert.deepEqual(await submitStaffHours(db,'primary','staff',payload,now),first);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  const legacy=structuredClone(backup);legacy.schemaVersion=17;for(const table of ['hours_entries','hours_entry_revisions','hours_submission_keys','hours_reopen_windows','hours_entry_settings'])delete legacy.tables[table];
  await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy});
  assert.equal((await db.prepare("SELECT count(*) n FROM hours_entries WHERE installation_id='primary'").first()).n,0);
  assert.equal((await db.prepare("SELECT reopen_hours FROM hours_entry_settings WHERE installation_id='primary'").first()).reopen_hours,24);
  await good('/admin/data',{scope:'installation',confirmation:'DELETE INSTALLATION'},'DELETE');assert.equal((await db.prepare("SELECT count(*) n FROM hours_entries WHERE installation_id='primary'").first()).n,0);
  env.BOOTSTRAP_CODE_HASH=createHash('sha256').update('synthetic-setup-code').digest('base64url');
  await good('/setup/bootstrap',{setupCode:'synthetic-setup-code',organizationName:'Synthetic Fresh',timeZone:'UTC',authMode:'local',localUsername:'synthetic-fresh',localPassword:'synthetic-test-password'});
  assert.equal((await db.prepare("SELECT reporting_days FROM hours_entry_settings WHERE installation_id='primary'").first()).reporting_days,7);
 }finally{await mf.dispose();}
});

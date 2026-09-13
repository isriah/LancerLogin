import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {submitStaffHours,accountingRoute} from '../apps/api/src/hour-accounting.ts';
import {documentationRoute,documentationSectionRegistry} from '../apps/api/src/documentation-foundation.ts';
import worker from '../apps/api/src/index.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('private Documentation D1 notes, narrow summaries, atomic gates and portable history', {timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{
  const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
  await db.batch([
   db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'),('foreign','2026-01-01','local')"),
   db.prepare("INSERT INTO organization_settings(installation_id,organization_name,time_zone) VALUES('primary','Synthetic Team','UTC')"),
   db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-01-01'),('docs','primary','synthetic-docs','staff','2026-01-01'),('hours','primary','synthetic-hours','staff','2026-01-01'),('operator','primary','synthetic-operator','operator','2026-01-01')"),
   db.prepare("INSERT INTO platform_module_configuration VALUES('primary',1,1,1)"),
   db.prepare("INSERT INTO platform_module_grants VALUES('primary','docs',0,1),('primary','hours',1,0)"),
   db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('primary','event','Event','event','2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,description,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary','activity','event','event','2026-01-19','Synthetic eligible activity','PRIVATE HOURS DESCRIPTION','UTC',1,'2026-01-01','2026-01-01'),('primary','unrelated','event','event','2026-01-19','Unrelated hours-only','PRIVATE UNRELATED','UTC',0,'2026-01-01','2026-01-01')"),
   db.prepare("INSERT INTO hours_entry_settings(installation_id) VALUES('primary')"),
   db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member1','primary','00123','PRIVATE','ONE','2026-01-01'),('member2','primary','00456','PRIVATE','TWO','2026-01-01')")
  ]);
  const env={DB:db,APP_MODE:'configured',SESSION_KEY:secret,ALLOWED_ORIGIN:'https://fixture.test'};
  const call=async(path,input,user='docs',method=input?'POST':'GET')=>worker.fetch(new Request('https://fixture.test'+path,{method,headers:{cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:user,role:'admin'}),...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})}),env);
  const good=async(...args)=>{const r=await call(...args);assert.ok(r.ok,await r.clone().text());return r.json();};const base='/admin/documentation';
  assert.equal((await call(base+'/activities',null,'hours')).status,403);assert.equal((await call(base+'/activities',null,'operator')).status,403);
  assert.deepEqual(documentationSectionRegistry.map(s=>[s.id,s.version]),[['notes',1],['photos-files',1],['participant-hours',1]]);
  assert.equal((await good(base+'/sections')).revision,0);
  assert.equal((await call(base+'/sections',{version:1,revision:0,notesEnabled:true,summaryEnabled:true},'docs','PUT')).status,409);
  assert.deepEqual((await good(base+'/activities?archival=true')).activities.map(a=>a.id),['activity']);assert.equal((await call(base+'/activities/unrelated')).status,404);
  for(const change of ['visibility','section']){
   let injected=false;
   const raced={prepare(sql){const statement=db.prepare(sql);return {bind(...args){const bound=statement.bind(...args);return {async first(){if(sql.includes('AS section_revision')&&!injected){injected=true;await db.prepare(change==='visibility'?"UPDATE hours_activities SET impact_relevant=0 WHERE id='activity'":"INSERT INTO documentation_sections(installation_id,version,revision,notes_enabled,summary_enabled) VALUES('primary',1,1,1,0)").run();}return bound.first();},all:()=>bound.all(),run:()=>bound.run()};}};},batch:statements=>db.batch(statements)};
   const read=()=>documentationRoute(raced,'primary','docs',new Request('https://fixture.test'+base+'/activities/activity'));
   if(change==='visibility')await assert.rejects(read,e=>e.status===404);else assert.equal((await read()).body.summary,undefined);
   assert.equal(injected,true);await db.prepare("UPDATE hours_activities SET impact_relevant=1 WHERE id='activity'").run();await db.prepare('DELETE FROM documentation_sections').run();
  }
  let n=(await good(base+'/activities/activity/notes',{activityRevision:0,sectionRevision:0,text:'Private synthetic note'})).note;
  assert.equal(n.authorUserId,'docs');const created=n.createdAt;
  n=(await good(base+'/notes/'+n.id,{revision:0,activityRevision:0,sectionRevision:0,text:'界'.repeat(8000)},'docs','PATCH')).note;assert.equal(n.text.length,8000);assert.equal(n.createdAt,created);assert.equal(n.authorUserId,'docs');
  assert.equal((await call(base+'/notes/'+n.id,{revision:0,activityRevision:0,sectionRevision:0,text:'stale'},'docs','PATCH')).status,409);
  assert.equal((await call(base+'/notes/'+n.id,{revision:1,activityRevision:0,sectionRevision:0,text:'x'.repeat(8001)},'docs','PATCH')).status,400);
  const history=await good(base+'/notes/'+n.id+'/history?limit=1');assert.equal(history.next,0);assert.equal(history.authorUserId,'docs');assert.equal((await good(base+'/notes/'+n.id+'/history?after=0')).revisions.length,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target_type='documentation' AND metadata_json LIKE '%Private synthetic%'").first()).n,0);
  const now=Date.parse('2026-01-20T18:00:00Z');let last;
  for(const [index,memberId,startLocal,endLocal] of [[1,'member1','09:00','10:00'],[2,'member1','10:00','10:30'],[3,'member2','11:00','11:15'],[4,'member2','12:00','13:00']])last=await submitStaffHours(db,'primary','admin',{memberId,activityId:'activity',startLocal,endLocal,endNextDay:false,idempotencyKey:'synthetic-docs-'+index},now);
  await accountingRoute(db,'primary','admin',new Request('https://fixture.test/admin/hours/entries/'+last.id+'/void',{method:'POST'}),{revision:0,reason:'Synthetic excluded entry'},now);
  const activity=await good(base+'/activities/activity');assert.deepEqual(activity.summary,{countedMinutes:105,distinctParticipants:2});assert.doesNotMatch(JSON.stringify(activity),/member1|member2|00123|PRIVATE|description|sourceMeeting/);
  for(const race of ['grant','module','section','activity']){
   const count=(await db.prepare('SELECT COUNT(*) n FROM documentation_note_revisions').first()).n;
   const raced={prepare:s=>db.prepare(s),async batch(statements){if(race==='grant')await db.prepare("UPDATE platform_module_grants SET documentation_manage=0 WHERE user_id='docs'").run();if(race==='module')await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=0').run();if(race==='section')await db.prepare("INSERT INTO documentation_sections(installation_id,version,revision,notes_enabled,summary_enabled) VALUES('primary',1,1,0,1)").run();if(race==='activity')await db.prepare("UPDATE hours_activities SET impact_relevant=0,revision=1 WHERE id='activity'").run();return db.batch(statements);}};
   await assert.rejects(()=>documentationRoute(raced,'primary','docs',new Request('https://fixture.test'+base+'/notes/'+n.id,{method:'PATCH'}),{revision:1,activityRevision:0,sectionRevision:0,text:'raced'}),e=>e.status===409);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_note_revisions').first()).n,count);
   await db.prepare("UPDATE platform_module_grants SET documentation_manage=1 WHERE user_id='docs'").run();await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=1').run();await db.prepare('DELETE FROM documentation_sections').run();await db.prepare("UPDATE hours_activities SET impact_relevant=1,revision=0 WHERE id='activity'").run();
  }
  await good(base+'/sections',{version:1,revision:0,notesEnabled:false,summaryEnabled:false},'admin','PUT');assert.equal((await good(base+'/activities/activity')).summary,undefined);assert.equal((await good(base+'/activities/activity/notes')).readOnly,true);assert.equal((await good(base+'/notes/'+n.id+'/history')).revisions.length,2);
  assert.equal((await call(base+'/notes/'+n.id,{revision:1,activityRevision:0,sectionRevision:1,text:'disabled'},'docs','PATCH')).status,409);
  await good(base+'/sections',{version:1,revision:1,notesEnabled:true,summaryEnabled:true},'admin','PUT');
  await db.prepare("UPDATE hours_activities SET archived=1,impact_relevant=0,revision=1 WHERE id='activity'").run();assert.equal((await good(base+'/activities')).activities.length,0);assert.deepEqual((await good(base+'/activities?archival=true')).activities.map(a=>a.id),['activity']);assert.equal((await good(base+'/activities/activity/notes')).readOnly,true);assert.equal((await call(base+'/notes/'+n.id,{revision:1,activityRevision:1,sectionRevision:2,archived:true},'docs','PATCH')).status,409);
  await db.prepare("UPDATE hours_activities SET archived=0,impact_relevant=1,revision=2 WHERE id='activity'").run();n=(await good(base+'/notes/'+n.id,{revision:1,activityRevision:2,sectionRevision:2,archived:true},'admin','PATCH')).note;assert.equal(n.authorUserId,'docs');assert.equal(n.archived,true);
  await db.prepare("UPDATE users SET active=0 WHERE id='docs'").run();assert.equal((await call(base+'/notes/'+n.id)).status,401);assert.equal((await good(base+'/notes/'+n.id+'/history',null,'admin')).revisions.length,3);
  await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=0').run();assert.equal((await call(base+'/notes/'+n.id,null,'admin')).status,403);await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=1').run();
  const backup=await good('/admin/data/backup?scope=installation',null,'admin');assert.equal(backup.schemaVersion,28);assert.equal(backup.tables.documentation_notes.length,1);assert.equal(backup.tables.documentation_note_revisions.length,3);
  for(const corrupt of [b=>b.tables.documentation_note_revisions.pop(),b=>b.tables.documentation_note_revisions.push(b.tables.documentation_note_revisions[0]),b=>b.tables.documentation_notes[0].author_user_id='missing',b=>b.tables.documentation_notes[0].installation_id='foreign',b=>b.tables.documentation_note_revisions[0].actor_user_id='admin',b=>b.tables.documentation_sections[0].version=2]){const bad=structuredClone(backup);corrupt(bad);assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:bad},'admin')).status,400);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,1);}
  const meetings=await good('/admin/data/backup?scope=meetings',null,'admin');await good('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meetings},'admin');assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_note_revisions').first()).n,3);
  await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup},'admin');assert.equal((await good(base+'/notes/'+n.id,null,'admin')).note.authorUserId,'docs');
  const priorFormat=structuredClone(backup);priorFormat.schemaVersion=25;delete priorFormat.tables.documentation_note_submission_keys;for(const row of priorFormat.tables.documentation_notes)for(const key of ['author_member_id','source','review_decision','reviewed_revision','reviewer_user_id','reviewed_at'])delete row[key];for(const row of priorFormat.tables.documentation_note_revisions)for(const key of ['actor_member_id','source','review_decision','reviewed_revision','reviewer_user_id','reviewed_at'])delete row[key];await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:priorFormat},'admin');const restored=(await good(base+'/notes/'+n.id,null,'admin')).note;assert.equal(restored.authorUserId,'docs');assert.equal(restored.contributor.source,'staff');assert.equal(restored.review,null);
  const legacy=structuredClone(backup);legacy.schemaVersion=20;for(const t of ['documentation_sections','documentation_notes','documentation_note_revisions'])delete legacy.tables[t];await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy},'admin');assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,0);assert.equal((await good(base+'/sections',null,'admin')).notesEnabled,true);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});

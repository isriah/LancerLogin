import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {submitStaffHours,accountingRoute} from '../apps/api/src/hour-accounting.ts';
import {documentationRoute,documentationSectionRegistry} from '../apps/api/src/documentation-foundation.ts';
import {admitPublicDocumentation} from '../apps/api/src/public-documentation-admission.ts';
import worker from '../apps/api/src/index.ts';
import {submitMemberDocumentationNote,publicDocumentation} from '../apps/api/src/public-documentation.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('member Documentation shares note history, atomic admission, curation and portable provenance', {timeout:180000},async()=>{
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
  const input={memberId:'00123',activityId:'activity',activityRevision:0,sectionRevision:0,text:'Synthetic member note',idempotencyKey:'synthetic-documentation-key'};
  const submit=(v=input, database=db)=>submitMemberDocumentationNote(database,'primary',v);
  const receipts=await Promise.all([submit(),submit()]);assert.deepEqual(receipts[0],receipts[1]);assert.deepEqual(Object.keys(receipts[0]).sort(),['accepted','reference']);
  const publicPost=(body,origin='https://fixture.test')=>worker.fetch(new Request('https://fixture.test/public/documentation/notes',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),env);
  assert.deepEqual(await (await publicPost(input)).json(),receipts[0]);assert.equal((await publicPost(input,'https://foreign.test')).status,403);
  assert.equal((await publicPost({...input,text:'界'.repeat(8000)})).status,409);assert.equal((await publicPost({...input,source:'staff'})).status,409);
  const noteId=receipts[0].reference;assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,1);
  await assert.rejects(()=>submit({...input,text:'changed'}),e=>e.status===409);
  await assert.rejects(()=>submit({...input,idempotencyKey:'another-invalid-key',source:'staff'}),e=>e.status===409);
  let note=(await documentationRoute(db,'primary','docs',new Request('https://fixture.test/admin/documentation/notes/'+noteId))).body.note;
  assert.equal(note.authorUserId,null);assert.equal(note.contributor.memberId,'member1');assert.equal(note.contributor.attribution,'self_asserted');assert.equal(note.review,null);
  const update=async(body,method='PATCH',suffix='')=>documentationRoute(db,'primary','docs',new Request('https://fixture.test/admin/documentation/notes/'+noteId+suffix,{method}),body);
  const reviews=await Promise.allSettled([update({revision:0,activityRevision:0,sectionRevision:0,decision:'reviewed'},'POST','/review'),update({revision:0,activityRevision:0,sectionRevision:0,decision:'rejected'},'POST','/review')]);assert.equal(reviews.filter(r=>r.status==='fulfilled').length,1);assert.equal(reviews.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  note=(await update({revision:1,activityRevision:0,sectionRevision:0,text:'Staff curated text'})).body.note;assert.equal(note.review,null);assert.equal(note.contributor.memberId,'member1');
  const history=(await documentationRoute(db,'primary','docs',new Request('https://fixture.test/admin/documentation/notes/'+noteId+'/history'))).body;
  assert.equal(history.revisions[0].text,input.text);assert.equal(history.revisions[0].actorUserId,null);assert.equal(history.revisions[1].review.reviewedRevision,0);assert.equal(history.revisions[2].actorUserId,'docs');
  let injected=false;const racedRead={prepare(sql){return {bind(...args){const stmt=db.prepare(sql).bind(...args);return {async first(){if(!injected&&sql.includes(' history FROM documentation_notes')){injected=true;await db.prepare("UPDATE platform_module_grants SET documentation_manage=0 WHERE user_id='docs'").run();}return stmt.first();},all:()=>stmt.all(),run:()=>stmt.run()};}};},batch:stmts=>db.batch(stmts)};
  await assert.rejects(()=>documentationRoute(racedRead,'primary','docs',new Request('https://fixture.test/admin/documentation/notes/'+noteId+'/history')),e=>e.status===404);assert.equal(injected,true);await db.prepare("UPDATE platform_module_grants SET documentation_manage=1 WHERE user_id='docs'").run();
  await assert.rejects(()=>db.prepare("UPDATE documentation_notes SET review_decision='reviewed',reviewed_revision=NULL,reviewer_user_id='docs',reviewed_at=updated_at WHERE id=?").bind(noteId).run());
  for(const race of ['member','module','section','activity']){
   const raced={prepare:s=>db.prepare(s),async batch(statements){await db.prepare(race==='member'?"UPDATE members SET active=0 WHERE id='member1'":race==='module'?"UPDATE platform_module_configuration SET documentation_enabled=0":race==='section'?"INSERT INTO documentation_sections(installation_id,notes_enabled) VALUES('primary',0)":"UPDATE hours_activities SET impact_relevant=0 WHERE id='activity'").run();return db.batch(statements);}};
   await assert.rejects(()=>submit({...input,idempotencyKey:'synthetic-race-key-'+race},raced),e=>e.status===409);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,1);
   await db.prepare("UPDATE members SET active=1 WHERE id='member1'").run();await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=1').run();await db.prepare('DELETE FROM documentation_sections').run();await db.prepare("UPDATE hours_activities SET impact_relevant=1 WHERE id='activity'").run();
  }
  const publicGet=path=>publicDocumentation(new Request('https://fixture.test/public/documentation/'+path),env);
  const catalog=await (await publicGet('activities')).json();assert.equal(catalog.activities[0].id,'activity');assert.doesNotMatch(JSON.stringify(catalog),/PRIVATE|member1|description|summary|Synthetic member/);
  assert.equal((await publicGet('notes')).status,405);assert.equal((await publicGet('activities?limit=1&limit=2')).status,400);
  await db.prepare("UPDATE members SET active=0 WHERE id='member1'").run();await db.prepare("UPDATE hours_activities SET archived=1,impact_relevant=0 WHERE id='activity'").run();
  assert.deepEqual(await submit(),receipts[0]);assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_documentation_drafts').first()).n,0);assert.equal((await (await publicGet('activities')).json()).activities.length,0);
  await assert.rejects(()=>update({revision:2,activityRevision:0,sectionRevision:0,text:'forbidden'}),e=>e.status===409);
  await assert.rejects(()=>db.prepare("DELETE FROM members WHERE id='member1'").run());
  const call=async(path,body)=>worker.fetch(new Request('https://fixture.test'+path,{method:body?'POST':'GET',headers:{cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:'admin',role:'admin'}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  await db.prepare("INSERT INTO discord_documentation_drafts VALUES('primary','synthetic-note-draft','111111111111111111','222222222222222222','synthetic-iv',0,9999999999999,NULL,'opaque','iv')").run();
  const backupResponse=await call('/admin/data/backup?scope=installation');assert.equal(backupResponse.status,200);const backup=await backupResponse.json();assert.equal(backup.schemaVersion,28);assert.equal(backup.tables.discord_documentation_drafts,undefined);
  const {validateDocumentationBackup}=await import('../apps/api/src/documentation-foundation.ts');validateDocumentationBackup(backup.tables);
  for(const mutation of [b=>b.documentation_notes[0].author_user_id='docs',b=>b.documentation_note_revisions[0].actor_member_id='member2',b=>b.documentation_note_submission_keys.splice(0),b=>b.documentation_note_revisions[1].reviewed_revision=1]){const b=structuredClone(backup.tables);mutation(b);assert.throws(()=>validateDocumentationBackup(b));}
  const meetings=await (await call('/admin/data/backup?scope=meetings')).json();assert.equal((await call('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meetings})).status,200);
  assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup})).status,200);assert.deepEqual(await submit(),receipts[0]);assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_documentation_drafts').first()).n,0);
  await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=0').run();assert.deepEqual(await submit(),receipts[0]);assert.equal((await db.prepare('SELECT COUNT(*) n FROM discord_documentation_drafts').first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_notes').first()).n,1);
  await db.prepare('DELETE FROM public_documentation_admission').run();await db.prepare('DELETE FROM public_documentation_admission_clock').run();
  for(let i=0;i<30;i++)await admitPublicDocumentation(db,'primary',secret,'mutation',60000,'invalid-'+i);
  await assert.rejects(()=>admitPublicDocumentation(db,'primary',secret,'mutation',60000,null),e=>e.status===429);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM public_hour_admission').first()).n,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE metadata_json LIKE '%Synthetic member%' OR metadata_json LIKE '%00123%'").first()).n,0);
 }finally{await mf.dispose();}
});

test('populated schema44 migration preserves staff note identities and history', {timeout:180000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
 try{
  const db=await mf.getD1Database('DB'),directory=new URL('../apps/api/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')&&!n.startsWith('0045_')).sort())await db.batch(migrationStatements(readFileSync(new URL(name,directory),'utf8')).map(s=>db.prepare(s)));
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

  await db.prepare("INSERT INTO documentation_notes VALUES('primary','old-note','activity','docs','Original synthetic note',0,1,'2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')").run();
  await db.prepare("INSERT INTO documentation_note_revisions VALUES('primary','old-note',0,'docs','First synthetic note',0,'2026-01-01T00:00:00.000Z'),('primary','old-note',1,'admin','Original synthetic note',0,'2026-01-02T00:00:00.000Z')").run();
  const old=await db.prepare('SELECT * FROM documentation_notes').first(),history=(await db.prepare('SELECT * FROM documentation_note_revisions ORDER BY revision').all()).results;
  await db.batch(migrationStatements(readFileSync(new URL('0045_member_documentation_notes.sql',directory),'utf8')).map(s=>db.prepare(s)));
  const current=await db.prepare('SELECT * FROM documentation_notes').first();for(const [k,v]of Object.entries(old))assert.deepEqual(current[k],v);assert.equal(current.source,'staff');assert.equal(current.author_member_id,null);
  const revised=(await db.prepare('SELECT * FROM documentation_note_revisions ORDER BY revision').all()).results;for(let i=0;i<history.length;i++)for(const [k,v]of Object.entries(history[i]))assert.deepEqual(revised[i][k],v);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});

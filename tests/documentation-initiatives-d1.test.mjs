import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {submitStaffHours,accountingRoute} from '../apps/api/src/hour-accounting.ts';
import {initiativeRoute} from '../apps/api/src/documentation-initiatives.ts';
import worker from '../apps/api/src/index.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('private initiatives preserve narrative/membership history, race fences and overlap-safe aggregates', {timeout:180000},async()=>{
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
  const good=async(...args)=>{const r=await call(...args);assert.ok(r.ok,await r.clone().text());return r.json();};const base='/admin/documentation/initiatives';
  const create=(activities=[],title='Synthetic initiative')=>good(base,{title,narrative:'Private synthetic initiative narrative',activities});
  const link=(activityId='activity',revision=0)=>({activityId,revision});
  assert.equal((await call(base,null,'hours')).status,403);assert.equal((await call(base,null,'operator')).status,403);
  await db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary','activity2','event','event','2026-01-19','Second synthetic event','UTC',1,'2026-01-01','2026-01-01')").run();
  let one=(await create([link()])).initiative;const two=(await create([link(),link('activity2')],'Second initiative')).initiative;const empty=(await create()).initiative;
  assert.equal(one.authorUserId,'docs');assert.equal((await good(base+'/'+empty.id)).summary.countedMinutes,0);
  assert.equal((await call(base,{title:'Duplicate',activities:[link(),link()]})).status,400);
  assert.equal((await call(base,{title:'Nonimpact',activities:[link('unrelated')]})).status,409);
  await db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('foreign','event','Synthetic foreign','event','2026-01-01','2026-01-01')").run();
  await db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('foreign','foreign-activity','event','event','2026-01-19','Foreign synthetic event','UTC',1,'2026-01-01','2026-01-01')").run();
  assert.equal((await call(base,{title:'Cross scope',activities:[link('foreign-activity')]})).status,409);
  const now=Date.parse('2026-01-20T18:00:00Z');let last;
  for(const [index,memberId,activityId,startLocal,endLocal] of [[1,'member1','activity','09:00','10:00'],[2,'member2','activity','10:00','10:30'],[3,'member1','activity2','11:00','11:15'],[4,'member2','activity2','12:00','13:00']])last=await submitStaffHours(db,'primary','admin',{memberId,activityId,startLocal,endLocal,endNextDay:false,idempotencyKey:'synthetic-initiative-'+index},now);
  await accountingRoute(db,'primary','admin',new Request('https://fixture.test/admin/hours/entries/'+last.id+'/void',{method:'POST'}),{revision:0,reason:'Synthetic excluded entry'},now);
  const rollup=await good(base+'/summary',{initiativeIds:[one.id,two.id]});assert.deepEqual(rollup,{linkedActivityCount:2,eligibleActivityCount:2,omittedActivityCount:0,summary:{countedMinutes:105,distinctParticipants:2}});assert.doesNotMatch(JSON.stringify(rollup),/member1|member2|00123|PRIVATE/);
  assert.equal((await call(base+'/summary',{initiativeIds:[one.id,'missing']})).status,404);assert.equal((await call(base+'/summary',{initiativeIds:[one.id,one.id]})).status,400);
  const detail=await good(base+'/'+one.id);assert.equal(detail.summary.countedMinutes,90);assert.doesNotMatch(JSON.stringify(detail),/PRIVATE HOURS|description|member1|member2/);
  const created=one.createdAt;
  one=(await good(base+'/'+one.id,{revision:0,narrative:'\u754c'.repeat(8000),activities:[link(),link('activity2')]},'docs','PATCH')).initiative;assert.equal(one.narrative.length,8000);assert.equal(one.createdAt,created);assert.equal(one.authorUserId,'docs');
  assert.equal((await call(base+'/'+one.id,{revision:0,title:'Stale'},'docs','PATCH')).status,409);assert.equal((await call(base+'/'+one.id,{revision:1,narrative:'x'.repeat(8001)},'docs','PATCH')).status,400);
  const h=await good(base+'/'+one.id+'/history?limit=1');assert.equal(h.next,0);assert.deepEqual(h.revisions[0].activityIds,['activity']);assert.equal((await good(base+'/'+one.id+'/history?after=0')).revisions[0].activityIds.length,2);
  const listing=await good(base+'?limit=1');assert.equal(listing.initiatives.length,1);assert.ok(listing.next);assert.equal((await good(base+'?after='+listing.next)).initiatives.length,2);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target_type='documentation_initiative' AND metadata_json LIKE '%Private synthetic%'").first()).n,0);
  // Every write fence is rechecked inside the transaction, after the initial authority read.
  for(const race of ['grant','module','relevance','activity-revision']){
   const before=(await db.prepare('SELECT COUNT(*) n FROM documentation_initiative_revisions').first()).n;
   const raced={prepare:sql=>db.prepare(sql),async batch(statements){if(race==='grant')await db.prepare("UPDATE platform_module_grants SET documentation_manage=0 WHERE user_id='docs'").run();if(race==='module')await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=0').run();if(race==='relevance')await db.prepare("UPDATE hours_activities SET impact_relevant=0 WHERE id='activity'").run();if(race==='activity-revision')await db.prepare("UPDATE hours_activities SET revision=1 WHERE id='activity'").run();return db.batch(statements);}};
   await assert.rejects(()=>initiativeRoute(raced,'primary','docs',new Request('https://fixture.test'+base+'/'+empty.id,{method:'PATCH'}),{revision:0,activities:[link()]}),e=>e.status===409);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_initiative_revisions').first()).n,before);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_initiative_activities WHERE initiative_id=?').bind(empty.id).first()).n,0);
   await db.prepare("UPDATE platform_module_grants SET documentation_manage=1 WHERE user_id='docs'").run();await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=1').run();await db.prepare("UPDATE hours_activities SET impact_relevant=1,revision=0 WHERE id='activity'").run();
  }
  // Two contenders for the same revision: only the winner adds history/membership.
  const concurrent=await Promise.all([call(base+'/'+empty.id,{revision:0,title:'First'},'docs','PATCH'),call(base+'/'+empty.id,{revision:0,title:'Second'},'docs','PATCH')]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  // Section disable is independently enforced for aggregates in the same SQL snapshot.
  let injected=false;const racedRead={prepare:sql=>db.prepare(sql),async batch(statements){if(!injected){injected=true;await db.prepare("INSERT INTO documentation_sections(installation_id,version,revision,notes_enabled,summary_enabled) VALUES('primary',1,1,0,0)").run();}return db.batch(statements);}};
  assert.equal((await initiativeRoute(racedRead,'primary','docs',new Request('https://fixture.test'+base+'/'+one.id))).body.summary,undefined);
  assert.equal((await good(base+'/summary',{initiativeIds:[one.id,two.id]})).summary,undefined);
  // Initiative grouping is independent of activity-notes configuration.
  one=(await good(base+'/'+one.id,{revision:1,title:'Independent grouping'},'docs','PATCH')).initiative;
  await db.prepare('UPDATE documentation_sections SET summary_enabled=1').run();
  await db.prepare("UPDATE hours_activities SET impact_relevant=0,archived=1,revision=1 WHERE id='activity'").run();
  const retained=await good(base+'/'+one.id);assert.equal(retained.activities.length,2);assert.equal(retained.omittedActivityCount,1);assert.equal(retained.summary.countedMinutes,15);
  assert.equal((await good(base+'/summary',{initiativeIds:[one.id,two.id]})).summary.countedMinutes,15);
  one=(await good(base+'/'+one.id,{revision:2,narrative:'Retained archived link',activities:[link(),link('activity2')]},'docs','PATCH')).initiative;
  assert.equal((await call(base+'/'+empty.id,{revision:1,activities:[link()]},'docs','PATCH')).status,409);
  one=(await good(base+'/'+one.id,{revision:3,archived:true},'docs','PATCH')).initiative;assert.equal((await good(base)).initiatives.length,2);assert.equal((await good(base+'?archival=true')).initiatives.length,3);assert.equal((await good(base+'/'+one.id)).summary.countedMinutes,0);
  assert.equal((await call(base+'/'+one.id,{revision:4,narrative:'Blocked'},'docs','PATCH')).status,409);assert.equal((await call(base+'/'+one.id,{revision:4,archived:false,title:'Blocked mixed edit'},'docs','PATCH')).status,409);
  one=(await good(base+'/'+one.id,{revision:4,archived:false},'admin','PATCH')).initiative;assert.equal(one.authorUserId,'docs');
  one=(await good(base+'/'+one.id,{revision:5,activities:[link('activity2')]},'docs','PATCH')).initiative;
  assert.equal((await good(base+'/'+one.id+'/history')).revisions[3].activityIds.length,2);assert.equal((await good(base+'/'+one.id)).activities.length,1);
  // Historical membership resolves only current same-installation titles, even after removal/relevance loss.
  await db.prepare("UPDATE hours_activities SET title='Renamed synthetic event' WHERE installation_id='primary' AND id='activity'").run();
  await db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('foreign','activity','event','event','2026-01-19','Foreign synthetic same-ID title','UTC',1,'2026-01-01','2026-01-01')").run();
  const titledHistory=await good(base+'/'+one.id+'/history');
  assert.deepEqual(titledHistory.revisions[0].activities,[{activityId:'activity',title:'Renamed synthetic event'}]);
  assert.deepEqual(titledHistory.revisions[0].activityIds,['activity']);
  assert.equal(titledHistory.revisions[6].activities.some(a=>a.activityId==='activity'),false);
  assert.doesNotMatch(JSON.stringify(titledHistory),/Foreign synthetic|PRIVATE HOURS|description|member1|member2/);
  assert.equal((await call(base+'/'+one.id+'/history',null,'hours')).status,403);
  const historyRace={prepare:sql=>db.prepare(sql),async batch(statements){await db.prepare("UPDATE platform_module_grants SET documentation_manage=0 WHERE user_id='docs'").run();return db.batch(statements);}};
  await assert.rejects(()=>initiativeRoute(historyRace,'primary','docs',new Request('https://fixture.test'+base+'/'+one.id+'/history')),e=>e.status===404);
  await db.prepare("UPDATE platform_module_grants SET documentation_manage=1 WHERE user_id='docs'").run();
  await db.prepare("UPDATE users SET active=0 WHERE id='docs'").run();assert.equal((await call(base+'/'+one.id)).status,401);assert.equal((await good(base+'/'+one.id+'/history',null,'admin')).revisions.length,7);
  const backup=await good('/admin/data/backup?scope=installation',null,'admin');assert.equal(backup.schemaVersion,28);
  for(const corrupt of [b=>b.tables.documentation_initiative_revisions.pop(),b=>b.tables.documentation_initiative_revisions.push(b.tables.documentation_initiative_revisions[0]),b=>b.tables.documentation_initiatives[0].author_user_id='missing',b=>b.tables.documentation_initiative_activities[0].installation_id='foreign',b=>b.tables.documentation_initiative_revision_activities[0].activity_id='foreign-activity',b=>b.tables.documentation_initiative_revision_activities.push(b.tables.documentation_initiative_revision_activities[0]),b=>b.tables.documentation_initiative_activities.pop()]){const bad=structuredClone(backup);corrupt(bad);assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:bad},'admin')).status,400);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_initiatives').first()).n,3);}
  const meeting=await good('/admin/data/backup?scope=meetings',null,'admin');await good('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meeting},'admin');assert.equal((await good(base+'/'+one.id+'/history',null,'admin')).revisions.length,7);
  await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup},'admin');assert.equal((await good(base+'/'+one.id+'/history',null,'admin')).revisions.length,7);assert.equal((await good(base+'/'+one.id,null,'admin')).initiative.authorUserId,'docs');
  const legacy=structuredClone(backup);legacy.schemaVersion=21;for(const name of Object.keys(legacy.tables).filter(k=>k.startsWith('documentation_initiative')))delete legacy.tables[name];await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy},'admin');assert.equal((await good(base,null,'admin')).initiatives.length,0);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});

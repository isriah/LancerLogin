import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {submitStaffHours,accountingRoute} from '../apps/api/src/hour-accounting.ts';
import {artifactRoute,artifactUrl} from '../apps/api/src/documentation-artifacts.ts';
import worker from '../apps/api/src/index.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('link artifacts enforce review revisions, section gates and immutable provenance without fetching', {timeout:180000},async()=>{
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
  const good=async(...args)=>{const r=await call(...args);assert.ok(r.ok,await r.clone().text());return r.json();};const base='/admin/documentation/artifacts';
  let sr=0;const payload={title:'Synthetic evidence',caption:'Private synthetic caption',url:'https://example.invalid/evidence',sectionRevision:sr};
  const initiative=(await good('/admin/documentation/initiatives',{title:'Synthetic context'})).initiative;
  const activity={activityId:'activity',revision:0},context={initiativeId:initiative.id,revision:0};
  const original=globalThis.fetch;let fetched=0;globalThis.fetch=async()=>{fetched++;throw Error('External links must never be fetched');};
  try{
  assert.equal((await call(base,null,'hours')).status,403);assert.equal((await call(base,null,'operator')).status,403);
  for(const url of ['http://example.invalid','https://user:pass@example.invalid','https://example.invalid/a b','https://example.invalid/\n','javascript:alert(1)','https://example.invalid/'+ 'x'.repeat(2048)])assert.throws(()=>artifactUrl(url));
  let artifact=(await good(base,{...payload,activities:[activity],initiatives:[context]})).artifact;const created=artifact.createdAt;assert.equal(artifact.kind,'external-link');assert.equal(artifact.review,null);
  const standalone=(await good(base,payload)).artifact;
  assert.equal((await call(base,{...payload,activities:[activity,activity]})).status,400);assert.equal((await call(base,{...payload,activities:[{activityId:'unrelated',revision:0}]})).status,409);
  assert.equal((await call(base,{...payload,initiatives:[{initiativeId:'foreign',revision:0}]})).status,409);
  const concurrent=await Promise.all([call(base+'/'+artifact.id+'/review',{revision:0,sectionRevision:sr,decision:'reviewed'},'docs'),call(base+'/'+artifact.id+'/review',{revision:0,sectionRevision:sr,decision:'rejected'},'admin')]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  artifact=(await good(base+'/'+artifact.id)).artifact;assert.equal(artifact.revision,1);assert.equal(artifact.review.reviewedRevision,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_artifact_reviews').first()).n,1);
  artifact=(await good(base+'/'+artifact.id,{revision:1,sectionRevision:sr,url:'https://example.invalid/revised',caption:'Updated'},'docs','PATCH')).artifact;assert.equal(artifact.review,null);assert.equal(artifact.originalUrl,payload.url);assert.equal(artifact.authorUserId,'docs');assert.equal(artifact.createdAt,created);
  const h=await good(base+'/'+artifact.id+'/history?limit=2');assert.equal(h.next,1);assert.equal(h.revisions[1].review.reviewedRevision,0);assert.equal(h.revisions[0].url,payload.url);assert.equal((await good(base+'/'+artifact.id+'/history?after=1')).revisions[0].url,'https://example.invalid/revised');
  for(const race of ['grant','module','section','section-revision','activity','initiative']){
   const before=(await db.prepare('SELECT COUNT(*) n FROM documentation_artifact_revisions').first()).n;
   const raced={prepare:sql=>db.prepare(sql),async batch(statements){if(race==='grant')await db.prepare("UPDATE platform_module_grants SET documentation_manage=0 WHERE user_id='docs'").run();if(race==='module')await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=0').run();if(race==='section'||race==='section-revision')await db.prepare("INSERT INTO documentation_sections(installation_id,files_enabled,revision) VALUES('primary',?,?)").bind(race==='section'?0:1,race==='section'?0:1).run();if(race==='activity')await db.prepare("UPDATE hours_activities SET impact_relevant=0 WHERE id='activity'").run();if(race==='initiative')await db.prepare('UPDATE documentation_initiatives SET archived=1').run();return db.batch(statements);}};
   await assert.rejects(()=>artifactRoute(raced,'primary','docs',new Request('https://fixture.test'+base+'/'+standalone.id,{method:'PATCH'}),{revision:0,sectionRevision:0,activities:[activity],initiatives:[context]}),e=>e.status===409);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_artifact_revisions').first()).n,before);
   await db.prepare("UPDATE platform_module_grants SET documentation_manage=1 WHERE user_id='docs'").run();await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=1').run();await db.prepare('DELETE FROM documentation_sections').run();await db.prepare("UPDATE hours_activities SET impact_relevant=1 WHERE id='activity'").run();await db.prepare('UPDATE documentation_initiatives SET archived=0').run();
  }
  // Old section clients preserve the newly configured files flag.
  await good('/admin/documentation/sections',{version:1,revision:0,notesEnabled:true,summaryEnabled:true,filesEnabled:false},'admin','PUT');
  await good('/admin/documentation/sections',{version:1,revision:1,notesEnabled:false,summaryEnabled:false},'admin','PUT');assert.equal((await good('/admin/documentation/sections')).filesEnabled,false);
  assert.equal((await good(base+'/'+artifact.id)).artifact.id,artifact.id);assert.equal((await good(base+'/'+artifact.id)).readOnly,true);assert.equal((await call(base+'/'+artifact.id+'/review',{revision:artifact.revision,sectionRevision:2,decision:'reviewed'})).status,409);
  await good('/admin/documentation/sections',{version:1,revision:2,notesEnabled:false,summaryEnabled:false,filesEnabled:true},'admin','PUT');sr=3;
  await db.prepare("UPDATE hours_activities SET archived=1,impact_relevant=0,title='Current archived context',revision=1 WHERE id='activity'").run();await good('/admin/documentation/initiatives/'+initiative.id,{revision:0,archived:true},'docs','PATCH');
  const retained=await good(base+'/'+artifact.id);assert.equal(retained.activities[0].eligible,false);assert.equal(retained.initiatives[0].eligible,false);
  artifact=(await good(base+'/'+artifact.id,{revision:artifact.revision,sectionRevision:sr,caption:'Retained history',activities:[activity],initiatives:[context]},'docs','PATCH')).artifact;
  artifact=(await good(base+'/'+artifact.id+'/review',{revision:artifact.revision,sectionRevision:sr,decision:'reviewed'})).artifact;
  artifact=(await good(base+'/'+artifact.id,{revision:artifact.revision,sectionRevision:sr,archived:true},'docs','PATCH')).artifact;assert.equal(artifact.review,null);
  assert.equal((await call(base+'/'+artifact.id+'/review',{revision:artifact.revision,sectionRevision:sr,decision:'reviewed'})).status,409);
  artifact=(await good(base+'/'+artifact.id,{revision:artifact.revision,sectionRevision:sr,archived:false},'admin','PATCH')).artifact;
  artifact=(await good(base+'/'+artifact.id,{revision:artifact.revision,sectionRevision:sr,activities:[],initiatives:[]},'docs','PATCH')).artifact;
  const history=await good(base+'/'+artifact.id+'/history');assert.equal(history.revisions[0].activities[0].title,'Current archived context');assert.equal(history.revisions.at(-1).activities.length,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target_type='documentation_artifact' AND metadata_json <> '{}'").first()).n,0);assert.equal(fetched,0);
  await db.prepare("UPDATE users SET active=0 WHERE id='docs'").run();assert.equal((await call(base+'/'+artifact.id)).status,401);
  const backup=await good('/admin/data/backup?scope=installation',null,'admin');assert.equal(backup.schemaVersion,28);
  for(const corrupt of [b=>b.tables.documentation_artifact_revisions.pop(),b=>b.tables.documentation_artifact_reviews.pop(),b=>b.tables.documentation_artifact_reviews.push(b.tables.documentation_artifact_reviews[0]),b=>b.tables.documentation_artifact_reviews[0].reviewed_revision=99,b=>b.tables.documentation_artifact_reviews[0].decision='other',b=>b.tables.documentation_artifacts[0].original_url='https://example.invalid/tampered',b=>b.tables.documentation_artifact_revision_activities[0].installation_id='foreign',b=>b.tables.documentation_artifact_revision_initiatives[0].initiative_id='foreign',b=>b.tables.documentation_sections[0].files_enabled=2]){const bad=structuredClone(backup);corrupt(bad);assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:bad},'admin')).status,400);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_artifacts').first()).n,2);}
  const meetings=await good('/admin/data/backup?scope=meetings',null,'admin');await good('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meetings},'admin');assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_artifact_reviews').first()).n,2);
  await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup},'admin');assert.equal((await good(base+'/'+artifact.id+'/history',null,'admin')).revisions.length,history.revisions.length);
  const legacy=structuredClone(backup);legacy.schemaVersion=23;for(const name of Object.keys(legacy.tables).filter(k=>k.startsWith('documentation_artifact')||k==='google_drive_storage'))delete legacy.tables[name];for(const r of legacy.tables.documentation_sections)delete r.files_enabled;await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy},'admin');assert.equal((await good(base,null,'admin')).artifacts.length,0);assert.equal((await good('/admin/documentation/sections',null,'admin')).filesEnabled,true);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{globalThis.fetch=original;}
 }finally{await mf.dispose();}
});

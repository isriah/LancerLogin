import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {createSessionCodec} from '../apps/api/src/runtime-security.ts';
import {submitStaffHours,accountingRoute} from '../apps/api/src/hour-accounting.ts';
import {metricRoute,metricDecimal,metricKinds} from '../apps/api/src/documentation-metrics.ts';
import worker from '../apps/api/src/index.ts';
const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
test('manual metrics retain exact decimals, semantics, associations and immutable backup history', {timeout:180000},async()=>{
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
  const good=async(...args)=>{const r=await call(...args);assert.ok(r.ok,await r.clone().text());return r.json();};const base='/admin/documentation/metrics';
  const payload={title:'Synthetic metric',kind:'outcomes',value:'1.2500',unit:'synthetic units',periodStart:'2024-02-29',periodEnd:'2024-03-01',source:'Private synthetic source',method:'Synthetic method',basis:'estimated'};
  const make=(extra={})=>good(base,{...payload,...extra});
  const activity={activityId:'activity',revision:0};
  const initiative=(await good('/admin/documentation/initiatives',{title:'Synthetic context'})).initiative;
  const context={initiativeId:initiative.id,revision:0};
  assert.equal((await call(base,null,'hours')).status,403);assert.equal((await call(base,null,'operator')).status,403);
  const originalHours=JSON.stringify((await db.prepare('SELECT * FROM hours_entries').all()).results);
  let metric=(await make({activities:[activity],initiatives:[context]})).metric;const created=metric.createdAt;
  assert.equal(metric.value,'1.2500');assert.equal(metric.authorUserId,'docs');assert.equal(metric.basis,'estimated');
  assert.equal((await db.prepare('SELECT typeof(value) storage FROM documentation_metrics WHERE id=?').bind(metric.id).first()).storage,'text');
  const standalone=(await make()).metric;assert.equal((await good(base+'/'+standalone.id)).activities.length,0);
  for(const value of ['0','0.000000','-0.000001','999999999999999.999999','-999999999999999.999999','1.0','1.00'])assert.equal(metricDecimal(value),value);
  for(const value of [1,NaN,Infinity,'1e3','+1','01','-0','-0.000000','0.0000001','1000000000000000',' 1','1.','.1','1,2'])assert.throws(()=>metricDecimal(value));
  for(const extra of [{value:1},{value:'1e3'},{periodStart:'2023-02-29'},{periodStart:'2024-03-02'},{periodEnd:'1900-01-01'},{periodStart:'1899-12-31'},{periodEnd:'10000-01-01'},{periodEnd:'2024-03-01T00:00:00Z'},{kind:'unique-participants'},{basis:'verified'},{source:''},{method:' '},{unit:''},{activities:[activity,activity]},{initiatives:[context,context]},{activities:[{activityId:'unrelated',revision:0}]}])assert.ok([400,409].includes((await call(base,{...payload,...extra})).status));
  for(const kind of metricKinds){const r=await make({kind,value:'-1.00',periodStart:'1900-01-01',periodEnd:'9999-12-31',basis:'measured'});assert.equal(r.metric.kind,kind);assert.equal(r.metric.value,'-1.00');}
  assert.equal(JSON.stringify((await db.prepare('SELECT * FROM hours_entries').all()).results),originalHours);
  assert.equal((await call(base+'/summary',{metricIds:[metric.id]})).status,405);
  const boundedLinks=Array.from({length:100},(_,i)=>({activityId:'bounded-'+i,revision:0}));
  await db.batch(boundedLinks.map(link=>db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('primary',?,'event','event','2026-01-19','Synthetic bounded context','UTC',1,'2026-01-01','2026-01-01')").bind(link.activityId)));
  const bounded=(await make({activities:boundedLinks})).metric;
  assert.equal((await good(base+'/'+bounded.id)).activities.length,100);
  assert.equal((await call(base+'/'+bounded.id,{revision:0,initiatives:[context]},'docs','PATCH')).status,409);
  assert.equal((await good(base+'/'+bounded.id)).initiatives.length,0);
  // Foreign identities cannot be associated or read, even with a valid local grant.
  await db.prepare("INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES('foreign','event','Foreign synthetic','event','2026-01-01','2026-01-01')").run();
  await db.prepare("INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,planning_time_zone,impact_relevant,created_at,updated_at) VALUES('foreign','foreign-activity','event','event','2026-01-19','Foreign synthetic activity','UTC',1,'2026-01-01','2026-01-01')").run();
  assert.equal((await call(base,{...payload,activities:[{activityId:'foreign-activity',revision:0}]})).status,409);assert.equal((await call(base,{...payload,initiatives:[{initiativeId:'foreign-initiative',revision:0}]})).status,409);
  metric=(await good(base+'/'+metric.id,{revision:0,value:'1.00',basis:'measured'},'docs','PATCH')).metric;assert.equal(metric.createdAt,created);assert.equal(metric.authorUserId,'docs');
  assert.equal((await call(base+'/'+metric.id,{revision:0,value:'2.00'},'docs','PATCH')).status,409);
  const history=await good(base+'/'+metric.id+'/history?limit=1');assert.equal(history.next,0);assert.equal(history.revisions[0].value,'1.2500');assert.equal(history.revisions[0].basis,'estimated');assert.equal((await good(base+'/'+metric.id+'/history?after=0')).revisions[0].value,'1.00');
  const list=await good(base+'?limit=1');assert.equal(list.metrics.length,1);assert.ok(list.next);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE target_type='documentation_metric' AND metadata_json <> '{}'").first()).n,0);
  for(const race of ['grant','module','activity','activity-revision','initiative','initiative-revision']){
   const before=(await db.prepare('SELECT COUNT(*) n FROM documentation_metric_revisions').first()).n;
   const raced={prepare:sql=>db.prepare(sql),async batch(statements){if(race==='grant')await db.prepare("UPDATE platform_module_grants SET documentation_manage=0 WHERE user_id='docs'").run();if(race==='module')await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=0').run();if(race==='activity')await db.prepare("UPDATE hours_activities SET impact_relevant=0 WHERE id='activity'").run();if(race==='activity-revision')await db.prepare("UPDATE hours_activities SET revision=1 WHERE id='activity'").run();if(race==='initiative')await db.prepare('UPDATE documentation_initiatives SET archived=1').run();if(race==='initiative-revision')await db.prepare('UPDATE documentation_initiatives SET revision=1').run();return db.batch(statements);}};
   await assert.rejects(()=>metricRoute(raced,'primary','docs',new Request('https://fixture.test'+base+'/'+standalone.id,{method:'PATCH'}),{revision:0,activities:[activity],initiatives:[context]}),e=>e.status===409);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_metric_revisions').first()).n,before);
   await db.prepare("UPDATE platform_module_grants SET documentation_manage=1 WHERE user_id='docs'").run();await db.prepare('UPDATE platform_module_configuration SET documentation_enabled=1').run();await db.prepare("UPDATE hours_activities SET impact_relevant=1,revision=0 WHERE id='activity'").run();await db.prepare('UPDATE documentation_initiatives SET archived=0,revision=0').run();
  }
  const concurrent=await Promise.all([call(base+'/'+standalone.id,{revision:0,value:'2.0'},'docs','PATCH'),call(base+'/'+standalone.id,{revision:0,value:'3.0'},'docs','PATCH')]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  await db.prepare("INSERT INTO documentation_sections(installation_id,version,revision,notes_enabled,summary_enabled) VALUES('primary',1,1,0,0)").run();
  await db.prepare("UPDATE hours_activities SET impact_relevant=0,archived=1,title='Current retained activity title',revision=1 WHERE id='activity'").run();
  await good('/admin/documentation/initiatives/'+initiative.id,{revision:0,archived:true},'docs','PATCH');
  const retained=await good(base+'/'+metric.id);assert.equal(retained.activities[0].eligible,false);assert.equal(retained.initiatives[0].eligible,false);assert.equal(retained.metric.value,'1.00');assert.equal(retained.summary,undefined);
  metric=(await good(base+'/'+metric.id,{revision:1,source:'Updated source',activities:[activity],initiatives:[context]},'docs','PATCH')).metric;
  assert.equal((await call(base,{...payload,activities:[activity]})).status,409);assert.equal((await call(base,{...payload,initiatives:[context]})).status,409);
  metric=(await good(base+'/'+metric.id,{revision:2,activities:[],initiatives:[]},'docs','PATCH')).metric;
  const prior=await good(base+'/'+metric.id+'/history');assert.equal(prior.revisions[0].activities[0].title,'Current retained activity title');assert.equal(prior.revisions[0].activities[0].eligible,false);assert.equal(prior.revisions[3].activities.length,0);
  metric=(await good(base+'/'+metric.id,{revision:3,archived:true},'docs','PATCH')).metric;assert.equal((await call(base+'/'+metric.id,{revision:4,method:'Blocked'},'docs','PATCH')).status,409);assert.equal((await call(base+'/'+metric.id,{revision:4,archived:false,value:'2'},'docs','PATCH')).status,409);
  assert.equal((await good(base+'?limit=50')).metrics.some(m=>m.id===metric.id),false);assert.equal((await good(base+'?archival=true&limit=50')).metrics.some(m=>m.id===metric.id),true);
  metric=(await good(base+'/'+metric.id,{revision:4,archived:false},'admin','PATCH')).metric;
  await db.prepare("UPDATE users SET active=0 WHERE id='docs'").run();assert.equal((await call(base+'/'+metric.id)).status,401);assert.equal((await good(base+'/'+metric.id+'/history',null,'admin')).revisions.length,6);
  const backup=await good('/admin/data/backup?scope=installation',null,'admin');assert.equal(backup.schemaVersion,28);const count=backup.tables.documentation_metrics.length;
  for(const corrupt of [b=>b.tables.documentation_metric_revisions.pop(),b=>b.tables.documentation_metric_revisions.push(b.tables.documentation_metric_revisions[0]),b=>b.tables.documentation_metrics[0].author_user_id='missing',b=>b.tables.documentation_metric_revision_activities[0].installation_id='foreign',b=>b.tables.documentation_metric_revision_activities[0].activity_id='foreign-activity',b=>b.tables.documentation_metric_revision_initiatives[0].initiative_id='foreign-initiative',b=>b.tables.documentation_metric_revision_activities.push(b.tables.documentation_metric_revision_activities[0]),b=>b.tables.documentation_metrics[0].value=1.25,b=>b.tables.documentation_metrics[0].period_end='2023-02-29',b=>b.tables.documentation_metric_revisions[0].actor_user_id='admin']){const bad=structuredClone(backup);corrupt(bad);assert.equal((await call('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:bad},'admin')).status,400);assert.equal((await db.prepare('SELECT COUNT(*) n FROM documentation_metrics').first()).n,count);}
  const meetings=await good('/admin/data/backup?scope=meetings',null,'admin');await good('/admin/data/restore',{scope:'meetings',confirmation:'RESTORE MEETINGS',backup:meetings},'admin');assert.equal((await good(base+'/'+metric.id+'/history',null,'admin')).revisions.length,6);
  await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup},'admin');assert.equal((await good(base+'/'+metric.id+'/history',null,'admin')).revisions[0].value,'1.2500');assert.equal((await good(base+'/'+metric.id,null,'admin')).metric.value,'1.00');
  const legacy=structuredClone(backup);legacy.schemaVersion=22;for(const name of Object.keys(legacy.tables).filter(k=>k.startsWith('documentation_metric')))delete legacy.tables[name];await good('/admin/data/restore',{scope:'installation',confirmation:'RESTORE INSTALLATION',backup:legacy},'admin');assert.equal((await good(base,null,'admin')).metrics.length,0);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});

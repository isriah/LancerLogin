import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createApplicationRestore } from '../apps/updater/src/application-restore.mjs';
import { createVerifiedBackup } from '../apps/updater/src/backup.mjs';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher,toBase64 } from '../apps/updater/src/checkpoint.mjs';
import { createApplicationVerifier,sha256,signedBytes } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
import { selectSnapshotCatalog } from '../apps/updater/src/snapshot-catalog-registry.mjs';
import { createMigrationTransport } from '../apps/updater/src/migrations.mjs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

function binding(db,trace){const native=new WeakMap();return {withSession(mode){assert.equal(mode,'first-primary');return this;},prepare(sql){let args=[];const result={bind(...values){args=values.map(x=>x instanceof ArrayBuffer?new Uint8Array(x):x);return this;},async first(){trace?.(sql,'read');return db.prepare(sql).get(...args)??null;},async all(){trace?.(sql,'read');return {results:db.prepare(sql).all(...args)};}};native.set(result,()=>{trace?.(sql,'statement');db.prepare(sql).run(...args);});return result;},async batch(items){trace?.(null,'batch');db.exec('BEGIN');try{for(const item of items)native.get(item)();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}trace?.(null,'committed');}};}
async function fixture(t,schema){
  const app=new DatabaseSync(':memory:'),updater=new DatabaseSync(':memory:'),validation=new DatabaseSync(':memory:');t.after(()=>{app.close();updater.close();validation.close();});app.exec('PRAGMA foreign_keys=ON');validation.exec('PRAGMA foreign_keys=ON');
  const catalog=selectSnapshotCatalog(`schema-${schema}-v1`).catalog;
  for(const object of [...catalog.objects.filter(x=>x.type==='table'&&x.name!=='sqlite_sequence'),...catalog.objects.filter(x=>x.type!=='table'&&x.sql)])app.exec(object.sql);
  for(const entry of catalog.ledger)app.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(entry.id);
  app.exec("UPDATE sqlite_sequence SET seq=900 WHERE name='d1_migrations'; INSERT INTO installations VALUES('primary','2026','local',NULL,NULL,0,0,0,0); INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','1','Synthetic','Member','2026'); INSERT INTO audit_log(rowid,id,installation_id,action,target_type,target_id,metadata_json,created_at) VALUES(-1,'audit','primary','synthetic','synthetic',CAST(X'610062' AS TEXT),X'00FF','2026'); INSERT INTO public_hour_admission_clock(rowid,installation_id,last_seen_ms) VALUES(-9223372036854775808,'primary',9223372036854775807)");
  if(schema===46){app.exec("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('docs','primary','synthetic-docs','staff','2026'); INSERT INTO documentation_artifacts VALUES('primary','link','Current','Caption','https://example.invalid/new','https://example.invalid/old',0,NULL,NULL,NULL,NULL,1,'docs','2026','2026'); INSERT INTO documentation_artifact_revisions VALUES('primary','link',0,'docs','Old','Caption','https://example.invalid/old','https://example.invalid/old',0,NULL,NULL,NULL,NULL,'2026'),('primary','link',1,'docs','Current','Caption','https://example.invalid/new','https://example.invalid/old',0,NULL,NULL,NULL,NULL,'2026')");}
  for(const name of readdirSync(new URL('../apps/updater/state/',import.meta.url)))updater.exec(readFileSync(new URL(`../apps/updater/state/${name}`,import.meta.url),'utf8'));
  let calls=0,batches=0,hook=()=>{};const appBinding=binding(app,(sql,kind)=>{if(kind==='read'||kind==='batch')calls++;if(kind==='batch')batches++;hook(sql,kind);}),updaterBinding=binding(updater,(_sql,kind)=>{if(kind==='read'||kind==='batch')calls++;});
  const pins={installationId:'synthetic-restore',applicationDatabaseId:crypto.randomUUID(),updaterDatabaseId:crypto.randomUUID()},cipher=await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)),pins.installationId),store=createArtifactStore({database:updaterBinding,installationId:pins.installationId,cipher});
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),trust={product:'LancerLogin',channel:'development',repository:{id:1,owner:'synthetic',name:'restore'},keyId:'synthetic',publicKey:new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))},verifier=createApplicationVerifier(trust);
  async function release(sequence,targetSchema){const ledger=selectSnapshotCatalog(`schema-${targetSchema}-v1`).catalog.ledger,files=new Map([['api.mjs',new TextEncoder().encode('export default {}')],['dashboard.tar',packDashboard([{path:'index.html',bytes:new TextEncoder().encode('synthetic')}])]]);for(const entry of ledger)files.set(entry.id,new Uint8Array(readFileSync(new URL(`../apps/api/migrations/${entry.id}`,import.meta.url))));const artifacts=await Promise.all([...files].map(async([name,bytes])=>({name,role:name.endsWith('.sql')?'migration':name.endsWith('.tar')?'dashboard':'api',bytes:bytes.length,sha256:await sha256(bytes)})));const manifest={format:1,kind:'application',product:trust.product,channel:trust.channel,repository:trust.repository,keyId:trust.keyId,sequence,version:`${sequence}.0.0`,sourceCommit:'a'.repeat(40),minimumUpdaterVersion:'1.0.0',targetSchema,codeRollback:'compatible',artifacts,migrations:ledger.map((x,i)=>({...x,artifact:x.id,fromSchema:i,toSchema:i+1})),compatibility:{installedVersion:{min:'1.0.0',max:'2.0.0'},installedSchema:{min:schema,max:targetSchema},apiVersion:1,apiSchema:{min:schema,max:49},frontendApi:{min:1,max:1}}};const bytes=new TextEncoder().encode(JSON.stringify(manifest)),signature=new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,signedBytes(bytes)));return {record:{releaseId:sequence,manifest:toBase64(bytes),signature:toBase64(signature)},bytes,signature,files,manifest,handle:await verifier.verify(bytes,signature)};}
  const prior=await release(1,schema),target=await release(2,49),failedId=crypto.randomUUID(),backupId=crypto.randomUUID(),epoch=2;
  const backup=createVerifiedBackup({pins:{...pins,validationDatabaseId:crypto.randomUUID()},applicationDatabase:appBinding,validationDatabase:binding(validation),store,withClosedEpoch:async(req,callback)=>callback({...req,jobId:failedId,state:'closed',epoch,schema,ledger:catalog.ledger,manifestSha256:target.handle.manifestSha256})});
  let result;for(let i=0;i<700;i++){result=await backup.backup({installationId:pins.installationId,jobId:failedId,operationId:backupId,manifestSha256:target.handle.manifestSha256});if(result.outcome==='applied')break;assert.equal(result.outcome,'pending');}assert.equal(result.outcome,'applied');const retained=result.receipt;
  const completed=[];if(schema===46){const migrations=createMigrationTransport({pins,database:appBinding,store,verifier,withClosedEpoch:async(req,callback)=>callback({...req,jobId:failedId,state:'closed',epoch,schema:46,ledger:catalog.ledger,backupVerified:true})}),release=await migrations.verifyRelease(target.bytes,target.signature),entry=target.manifest.migrations[46],id=crypto.randomUUID();assert.equal((await migrations.applyMigration({operationId:id,release,migrationId:entry.id,bytes:target.files.get(entry.id)})).outcome,'applied');completed.push({id,kind:'applyMigration'});}
  // Deliberate post-backup data corruption stands in for a failed signed migration.
  app.prepare("UPDATE members SET first_name='Damaged' WHERE id='member'").run();
  const failedInstalled={version:'1.0.0',schema:schema===46?47:49,ledger:selectSnapshotCatalog(`schema-${schema===46?47:49}-v1`).catalog.ledger},jobId=crypto.randomUUID(),operationId=crypto.randomUUID(),holdId=crypto.randomUUID(),requestId=crypto.randomUUID();
  completed.push({id:crypto.randomUUID(),kind:schema===46?'applyMigration':'deployApi',failed:true});
  const failedJob={id:failedId,checkpointJobId:failedId,mode:'update',status:'failed',operation:null,completed,release:target.record},checkpoint={priorInstalled:{...failedInstalled,schema,ledger:catalog.ledger},priorRelease:prior.record,backup:retained};
  const state={installed:failedInstalled,checkpoint:{jobId:failedId,backupReady:true,envelope:await cipher.seal(failedId,checkpoint)},job:{id:jobId,failedJobId:failedId,checkpointJobId:failedId,requestId,mode:'restore',status:'running',release:prior.record,operation:{id:operationId,kind:'restoreBackup'}}};
  updater.prepare('INSERT INTO updater_state VALUES(1,?,0,?)').run(pins.installationId,JSON.stringify(state));updater.prepare("INSERT INTO updater_maintenance VALUES(1,?,?,'closed',?)").run(pins.installationId,epoch,jobId);updater.prepare('INSERT INTO updater_job_maintenance VALUES(?,0,?)').run(pins.installationId,JSON.stringify({phase:'closed',epoch,jobId}));updater.prepare("INSERT INTO updater_job_holds VALUES(?,?,?,?,?,'active')").run(holdId,pins.installationId,jobId,epoch,operationId);
  const handoff={installationId:pins.installationId,failedJob,failedInstalled,checkpointJobId:failedId,backupId,backupSha256:retained.sha256,epoch,recoveryJobId:jobId,requestId,operationId,holdId,fence:{accountId:'a'.repeat(32),worker:'synthetic-api',manifestSha256:prior.handle.manifestSha256,configurationSha256:'b'.repeat(64)}};await store.claim(`restore-handoff:${jobId}`,handoff);
  const capability={},request={jobId,operationId};let attested=true,maxCalls=0;
  let targetBinding=appBinding;const build=()=>createApplicationRestore({pins,database:targetBinding,updaterDatabase:updaterBinding,store,cipher,verifier,capability,withWriterFence:async(expected,callback)=>{if(!attested)throw Error('writer-not-attested');assert.deepEqual(Object.keys(expected).sort(),["applicationDatabaseId","epoch","holdId","installationId","jobId","operationId"]);return callback({...expected,...handoff.fence});}});
  return {app,updater,store,retained,state,handoff,useTarget(db){targetBinding=db;},request,capability,build,pins,hook(fn){hook=fn;},attest(value){attested=value;},get batches(){return batches;},get maxCalls(){return maxCalls;},async advance(){calls=0;const result=await build().advance(capability,request);maxCalls=Math.max(maxCalls,calls);assert.ok(calls<=45,`binding calls ${calls}`);return result;}};
}
for(const schema of [46,49])test(`internal destructive restore ${schema===46?47:49}->${schema} preserves verified backup and typed data`,async t=>{
  const f=await fixture(t,schema),initialBatches=f.batches;
  const beforeReconcile=f.updater.prepare('SELECT operation_id,revision,envelope FROM updater_provider_operations ORDER BY operation_id').all();
  assert.equal((await f.build().reconcile(f.capability,f.request)).outcome,'unknown');assert.equal(f.batches,initialBatches);assert.deepEqual(f.updater.prepare('SELECT operation_id,revision,envelope FROM updater_provider_operations ORDER BY operation_id').all(),beforeReconcile,'initial read-only reconciliation never claims');
  const backupKey=`backup:${f.retained.backupId}`,backupRecord=await f.store.operation(backupKey);
  await f.store.replace(backupKey,backupRecord.revision,{...backupRecord.value,receipt:null});assert.equal((await f.advance()).outcome,'unknown');assert.equal(f.batches,initialBatches);await f.store.replace(backupKey,(await f.store.operation(backupKey)).revision,backupRecord.value);
  f.attest(false);assert.equal((await f.advance()).outcome,'unknown');assert.equal(f.batches,initialBatches);f.attest(true);
  f.updater.prepare("UPDATE updater_maintenance SET epoch=epoch+1").run();assert.equal((await f.advance()).outcome,'unknown');assert.equal(f.batches,initialBatches);f.updater.prepare("UPDATE updater_maintenance SET epoch=epoch-1").run();
  let lost=0,cleanup=false,data=false;f.hook((sql,kind)=>{if(sql==='DROP TABLE _ll_restore_owner')cleanup=true;if(sql?.startsWith('INSERT INTO "audit_log"'))data=true;if(kind==='committed'&&(lost===0||data&&lost===1||cleanup&&lost===2)){lost++;throw Error('lost acknowledgment');}});
  let result,previousUnknown=false,extra=false,extraRejected=false;for(let i=0;i<1000;i++){
    const operation=await f.store.operation(`application-restore:${f.request.operationId}`);
    if(!extra&&operation?.value.cursor.phase==='final-compare'){
      f.app.prepare("INSERT INTO audit_log(id,installation_id,action,target_type,created_at) VALUES('extra','primary','synthetic','synthetic','2026')").run();extra=true;
    }
    const before=f.batches;
    if(previousUnknown){const records=f.updater.prepare('SELECT operation_id,revision,envelope FROM updater_provider_operations ORDER BY operation_id').all();const observed=await f.build().reconcile(f.capability,f.request);assert.equal(observed.outcome,'pending');assert.equal(f.batches,before);assert.deepEqual(f.updater.prepare('SELECT operation_id,revision,envelope FROM updater_provider_operations ORDER BY operation_id').all(),records,'read-only reconciliation changes no updater record');}
    result=await f.advance();if(previousUnknown)assert.equal(f.batches,before,'unknown acknowledgment reconciles without redispatch');previousUnknown=result.outcome==='unknown';
    if(result.outcome==='applied')break;assert.ok(['pending','unknown'].includes(result.outcome),JSON.stringify(result));
    if(result.outcome==='unknown'&&result.reason==='restore-data'){
      assert.ok(extra&&!extraRejected);extraRejected=true;f.app.prepare("DELETE FROM audit_log WHERE id='extra'").run();
    }else if(result.outcome==='unknown')assert.equal(result.reason,'restore-unavailable',JSON.stringify(result));
    if(i===2){const before=f.batches;f.app.prepare("UPDATE _ll_restore_owner SET owner='foreign'").run();assert.equal((await f.advance()).reason,'restore-owner');assert.equal(f.batches,before);f.app.prepare('UPDATE _ll_restore_owner SET owner=?').run(f.request.operationId);}
    if(i===4){const key=`restore-handoff:${f.request.jobId}`,row=await f.store.operation(key),holdId=crypto.randomUUID();f.updater.prepare('UPDATE updater_job_holds SET hold_id=?').run(holdId);await f.store.replace(key,row.revision,{...row.value,holdId});}
  }
  assert.equal(result.outcome,'applied',JSON.stringify(result));assert.equal(lost,3);assert.ok(extraRejected);assert.equal(result.receipt.schema,schema);
  assert.equal(f.app.prepare("SELECT first_name FROM members WHERE id='member'").get().first_name,'Synthetic');assert.equal(f.app.prepare("SELECT hex(target_id) AS t,hex(metadata_json) AS b FROM audit_log WHERE id='audit'").get().t,'610062');assert.equal(f.app.prepare("SELECT CAST(last_seen_ms AS TEXT) AS i FROM public_hour_admission_clock").get().i,'9223372036854775807');
  assert.equal(f.app.prepare("SELECT seq FROM sqlite_sequence WHERE name='d1_migrations'").get().seq,900);assert.equal(f.app.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name GLOB '_ll_restore_*'").get().n,0);
  if(schema===46)assert.deepEqual(f.app.prepare('SELECT title FROM documentation_artifact_revisions ORDER BY revision').all().map(x=>x.title),['Old','Current']);
  assert.deepEqual((await f.store.operation(`backup:${f.retained.backupId}`)).value.receipt,f.retained);assert.deepEqual(JSON.parse(f.updater.prepare('SELECT state_json FROM updater_state').get().state_json),f.state);
  t.diagnostic(`max binding calls per advance ${f.maxCalls}; synthetic positive attestor, no runtime or hosted fence claim`);
});

test('compiled schema guard rejects target drift atomically after independent admission',async t=>{
  const f=await fixture(t,49);let injected=false;
  f.hook((_sql,kind)=>{if(kind==='batch'&&!injected){injected=true;f.app.exec('CREATE TABLE unexpected_writer(value)');}});
  assert.equal((await f.advance()).outcome,'unknown');
  assert.equal(f.app.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name GLOB '_ll_restore_*'").get().n,0,'whole ownership batch rolled back');
  assert.equal(f.app.prepare("SELECT first_name FROM members WHERE id='member'").get().first_name,'Damaged','no destructive cleanup');
  const count=f.batches;assert.equal((await f.advance()).outcome,'unknown');assert.equal(f.batches,count,'missing ownership acknowledgment never redispatches');
});

test('actual local D1 destructive47->46 supports guarded DDL, typed replay and final metadata removal',async t=>{
  const f=await fixture(t,46),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic")}}',compatibilityDate:'2026-08-01',d1Databases:['APP']}));t.after(()=>mf.dispose());const app=await mf.getD1Database('APP');
  const {catalog,plan}=selectSnapshotCatalog('schema-47-v1');
  const quote=x=>'"'+x+'"';
  for(const object of catalog.objects.filter(x=>x.type==='table'&&x.name!=='sqlite_sequence'))await app.prepare(object.sql).run();
  for(const name of plan.earlyIndexes)await app.prepare(catalog.objects.find(x=>x.name===name).sql).run();
  for(const name of [...plan.order,'sqlite_sequence']){
    if(name==='sqlite_sequence')await app.prepare('DELETE FROM sqlite_sequence').run();
    const table=catalog.tables.find(x=>x.name===name),columns=['_rowid_',...table.columns];
    // Fixture-only SQLite quoting copies populated failed-schema rows exactly.
    const rows=f.app.prepare(`SELECT ${columns.map((x,i)=>`quote(${quote(x)}) AS c${i}`).join(',')} FROM ${quote(name)} ORDER BY _rowid_`).all();
    for(const row of rows)await app.prepare(`INSERT INTO ${quote(name)}(${columns.map(quote).join(',')}) VALUES(${Object.values(row).join(',')})`).run();
  }
  for(const object of catalog.objects.filter(x=>x.type!=='table'&&x.sql&&!plan.earlyIndexes.includes(x.name)))await app.prepare(object.sql).run();
  let lost=false,cleanup=false,batches=0;
  f.useTarget({withSession(mode){assert.equal(mode,'first-primary');return this;},prepare(sql){if(sql==='DROP TABLE _ll_restore_owner')cleanup=true;return app.prepare(sql);},async batch(statements){batches++;const result=await app.batch(statements);if(cleanup&&!lost){lost=true;throw Error('lost D1 cleanup acknowledgment');}return result;}});
  let result;for(let i=0;i<1000;i++){result=await f.advance();if(result.outcome==='applied')break;if(result.outcome==='unknown'){assert.equal(result.reason,'restore-unavailable');const before=batches;assert.equal((await f.advance()).outcome,'pending');assert.equal(batches,before);}}
  assert.equal(result.outcome,'applied',JSON.stringify(result));assert.ok(lost);
  assert.equal((await app.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first()).n,46);
  assert.equal((await app.prepare("SELECT CAST(last_seen_ms AS TEXT) AS i FROM public_hour_admission_clock").first()).i,'9223372036854775807');
  assert.deepEqual((await app.prepare('SELECT title FROM documentation_artifact_revisions ORDER BY revision').all()).results.map(x=>x.title),['Old','Current']);
  assert.equal((await app.prepare("SELECT seq FROM sqlite_sequence WHERE name='d1_migrations'").first()).seq,900);
  assert.equal((await app.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name GLOB '_ll_restore_*'").first()).n,0);
});

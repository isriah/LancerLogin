import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createUpdaterRuntime } from '../apps/updater/runtime.mjs';
import { recoveryCredentialDigest } from '../apps/updater/recovery-service.mjs';
import { signedUpdaterRequest } from '../packages/shared/src/updater/service-auth.ts';
import { sha256, signedBytes } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
import { snapshotCatalog } from '../apps/updater/src/snapshot-catalog.mjs';
import { selectSnapshotCatalog } from '../apps/updater/src/snapshot-catalog-registry.mjs';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { bootstrapAdoption } from './updater-bootstrap-adoption.mjs';
const encode = text => new TextEncoder().encode(text), json = value => Response.json(value), provider = value => json({ success: true, result: value });
function binding(db, after = () => {}, afterBatch = () => {}, executed = () => {}) {
  const statements = new WeakMap();
  return { withSession(mode) { assert.equal(mode, 'first-primary'); return this; }, prepare(sql) { let args = []; const statement = { bind(...values) { args = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value); return this; }, async first() { executed(sql); const value = db.prepare(sql).get(...args) ?? null; after(sql); return value; }, async all() { executed(sql); return { success: true, results: db.prepare(sql).all(...args) }; }, async run() { executed(sql); return db.prepare(sql).run(...args); } }; statements.set(statement, () => { executed(sql,'batch-item'); return db.prepare(sql).run(...args); }); return statement; }, async batch(items) { executed(null,'batch'); db.exec('BEGIN'); try { for (const item of items) statements.get(item)(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } afterBatch(); return []; } };
}
async function scenario(t, initialSchema = 49, { twoUpdates = false, operationalRows = 0, recoveryFacade = false, controlFacade = false, restoreScenario = false } = {}) {
  const initialCatalog = selectSnapshotCatalog(`schema-${initialSchema}-v1`).catalog;
  const app = new DatabaseSync(':memory:'), updater = new DatabaseSync(':memory:'), validation = new DatabaseSync(':memory:'); t.after(() => { app.close(); updater.close(); validation.close(); });
  app.exec('PRAGMA foreign_keys=ON'); validation.exec('PRAGMA foreign_keys=ON');
  for (const object of [...initialCatalog.objects.filter(o => o.type === 'table' && o.name !== 'sqlite_sequence'), ...initialCatalog.objects.filter(o => o.type !== 'table' && o.sql)]) app.exec(object.sql);
  for (const entry of initialCatalog.ledger) app.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(entry.id);
  app.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026','local')");
  app.exec("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','1','Synthetic','Member','2026')");
  for(let i=0;i<operationalRows;i++)app.prepare("INSERT INTO audit_log(id,installation_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,'primary','synthetic','profile',?,'{}','2026')").run(`audit-${i}`,`target-${i}`);
  const expectedAudit=app.prepare('SELECT rowid AS snapshot_rowid,* FROM audit_log ORDER BY rowid').all();
  const preserved = {};
  if(initialSchema===46){
    app.exec("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('docs','primary','synthetic-docs','staff','2026-01-01')");
    app.exec("INSERT INTO documentation_artifacts VALUES('primary','link','Current','Caption','https://example.invalid/new','https://example.invalid/old',0,NULL,NULL,NULL,NULL,1,'docs','2026-01-01','2026-01-02')");
    app.exec("INSERT INTO documentation_artifact_revisions VALUES('primary','link',0,'docs','Old','Caption','https://example.invalid/old','https://example.invalid/old',0,NULL,NULL,NULL,NULL,'2026-01-01'),('primary','link',1,'docs','Current','Caption','https://example.invalid/new','https://example.invalid/old',0,NULL,NULL,NULL,NULL,'2026-01-02')");
    app.exec("INSERT INTO documentation_definitions VALUES('primary','definition','Definition','Synthetic definition','Source',0,0,'docs','2026-01-01','2026-01-01')");
    app.exec("INSERT INTO documentation_definition_revisions VALUES('primary','definition',0,'docs','Definition','Synthetic definition','Source',0,'2026-01-01')");
    app.exec("INSERT INTO documentation_claims VALUES('primary','claim','Claim','definition',0,'2026-01-01','2026-01-02','Rationale',0,NULL,NULL,NULL,NULL,0,'docs','2026-01-01','2026-01-01')");
    app.exec("INSERT INTO documentation_claim_revisions VALUES('primary','claim',0,'docs','Claim','definition',0,'2026-01-01','2026-01-02','Rationale',0,NULL,NULL,NULL,NULL,'2026-01-01')");
    app.exec("INSERT INTO documentation_claim_revision_artifacts VALUES('primary','claim',0,'link',0)");
    for(const name of ['documentation_artifacts','documentation_artifact_revisions','documentation_claim_revision_artifacts'])preserved[name]=app.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
  }
  for (const file of readdirSync(new URL('../apps/updater/state/', import.meta.url))) updater.exec(readFileSync(new URL(`../apps/updater/state/${file}`, import.meta.url), 'utf8'));
  const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']);
  const trust = { product: 'LancerLogin', channel: 'development', repository: { id: 123, owner: 'synthetic', name: 'runtime' }, keyId: 'synthetic', publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey)) };
  const pins = { installationId: 'synthetic-runtime', accountId: 'a'.repeat(32), worker: 'synthetic-api', pagesProject: 'synthetic-pages', productionBranch: 'main', applicationDatabaseId: crypto.randomUUID(), updaterDatabaseId: crypto.randomUUID(), validationDatabaseId: crypto.randomUUID(), workerSettings: { compatibility_date: '2026-09-04', compatibility_flags: [] }, nonsecretBindings: [], apiOrigin: 'https://api.example.invalid', dashboardOrigin: 'https://pages.example.invalid', recoveryOrigin: 'https://recovery.example.invalid' };
  pins.nonsecretBindings = [{ name: 'DB', type: 'd1', id: pins.applicationDatabaseId }, { name: 'RELEASE_VERSION', type: 'plain_text', text: '1.0.0' }];
  if(restoreScenario)pins.nonsecretBindings.push({name:'MAINTENANCE',type:'service',service:'synthetic-updater'},{name:'MAINTENANCE_INSTALLATION_ID',type:'plain_text',text:pins.installationId});
  const fixtures = [];
  for (const sequence of (twoUpdates ? [1,2,3] : [1,2])) {
    const ledger = sequence === 1 ? initialCatalog.ledger : snapshotCatalog.ledger;
    const files = new Map([['api.mjs', encode(`export default {fetch(){return new Response('synthetic ${sequence}')}}`)], ['dashboard.tar', packDashboard([{ path: '_worker.js', bytes: encode('export default {}') }, { path: 'index.html', bytes: encode(`<p>Synthetic ${sequence}</p>`) }])]]);
    for (const entry of ledger) files.set(entry.id, new Uint8Array(readFileSync(new URL(`../apps/api/migrations/${entry.id}`, import.meta.url))));
    const artifacts = await Promise.all([...files].map(async ([name, bytes]) => ({ name, role: name.endsWith('.sql') ? 'migration' : name.endsWith('.tar') ? 'dashboard' : 'api', bytes: bytes.length, sha256: await sha256(bytes) })));
    const manifest = { format:1, kind:'application', product:trust.product, channel:trust.channel, repository:trust.repository, keyId:trust.keyId, sequence, version:`${sequence}.0.0`, sourceCommit:String(sequence).repeat(40), minimumUpdaterVersion:'1.0.0', compatibility:{ installedVersion:{min:'1.0.0',max:'2.0.0'}, installedSchema:{min:initialSchema,max:ledger.length}, apiVersion:1, apiSchema:{min:initialSchema,max:49}, frontendApi:{min:1,max:1} }, targetSchema:ledger.length, codeRollback:'compatible', artifacts, migrations:ledger.map((entry, i) => ({...entry, artifact:entry.id, fromSchema:i,toSchema:i+1})) };
    const manifestBytes = encode(JSON.stringify(manifest)), signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', signing.privateKey, signedBytes(manifestBytes)));
    files.set('manifest.json',manifestBytes); files.set('manifest.sig',signatureBytes);
    fixtures.push({ manifest, manifestBytes, signatureBytes, files, digest:await sha256(manifestBytes), release:{id:sequence*1000,immutable:true,draft:false,prerelease:false,published_at:'2026-09-01T00:00:00Z',tag_name:`v${sequence}.0.0`}, assets:[...files].map(([name,bytes],i)=>({id:sequence*1000+i+1,name,size:bytes.length,state:'uploaded'})) });
  }
  let visibleSequences=2, measured=false, metrics;
  const resetMetrics=()=>{metrics={advances:0,steps:{},sql:{application:0,updater:0,validation:0},bindingCalls:{application:0,updater:0,validation:0},fetchReads:0,fetchWrites:0,maxSqlPerAdvance:0,maxSqlStep:null,maxBindingCallsPerAdvance:0,maxFetchPerAdvance:0,admission:null};measured=true;};
  const executed=name=>(sql,kind)=>{if(measured){if(sql!==null)metrics.sql[name]++;if(kind!=='batch-item')metrics.bindingCalls[name]++;}};
  let apiFixture = fixtures[0], pagesFixture = fixtures[0], badHealth = initialSchema === 49 || restoreScenario, failReopen = false, failedReopenReads = null, codeReads = 0, deployments = 0;
  let apiVersion = {id:crypto.randomUUID(),annotations:{}}, apiDeployment = {id:'initial-api',versions:[{version_id:apiVersion.id,percentage:100}]};
  let pageDeployment = {id:'initial-pages',environment:'production',latest_stage:{name:'deploy',status:'success'},deployment_trigger:{metadata:{branch:'main',commit_hash:fixtures[0].manifest.sourceCommit,commit_message:`LancerLogin updater ${crypto.randomUUID()} ${fixtures[0].digest}`}}};
  const assets = new Map(), config = { compatibility_date:'2026-09-04',env_vars:{PRIVATE_PROXY:{type:'secret_text'}} }, base = 'https://api.github.com/repos/synthetic/runtime';
  async function fetcher(url, options) {
    const parsed = new URL(url), path = parsed.pathname, method = options.method; if(measured){const read=(!method||method==='GET'||path.endsWith('/query')||path.endsWith('/assets/check-missing'));metrics[read?'fetchReads':'fetchWrites']++;if(path.endsWith('/query'))metrics.sql.application++;} assert.equal(options.redirect,'manual');
    if (parsed.origin === 'https://api.github.com') {
      if (url === base) return json({id:123,owner:{login:'synthetic'},name:'runtime',private:true});
      if (url === `${base}/releases?per_page=30&page=1`) return json(fixtures.filter(f=>f.manifest.sequence<=visibleSequences).map(f=>f.release));
      for (const f of fixtures) { if (url === `${base}/releases/${f.release.id}`) return json(f.release); const prefix = `${base}/releases/${f.release.id}/assets?per_page=30&page=`; if (url.startsWith(prefix)) {const n=Number(url.slice(prefix.length)); return json(f.assets.slice((n-1)*30,n*30));} for(const asset of f.assets) if(url===`${base}/releases/assets/${asset.id}`) return new Response(f.files.get(asset.name)); }
    } else if (parsed.origin === 'https://api.cloudflare.com') {
      if(path.endsWith('/settings')) return provider({...pins.workerSettings,bindings:[...pins.nonsecretBindings.map(b=>b.name==='RELEASE_VERSION'?{...b,text:apiFixture.manifest.version}:b),{name:'SESSION_SECRET',type:'secret_text'},...(restoreScenario?[{name:'MAINTENANCE_APP_KEY',type:'secret_text'}]:[])]});
      if(path.includes('/versions/')) return provider(apiVersion); if(path.endsWith('/versions')) return provider({items:[apiVersion]});
      if(path.endsWith('/content/v2')) {codeReads++;return new Response(apiFixture.files.get('api.mjs'));}
      if(path.endsWith('/synthetic-api/deployments')) return provider({deployments:[apiDeployment]});
      if(path.endsWith('/synthetic-api') && method==='PUT') {const meta=JSON.parse(options.body.get('metadata')); assert.deepEqual(meta.keep_bindings,['secret_text','secret_key']); apiFixture=fixtures.find(f=>f.manifest.version===meta.bindings.find(b=>b.name==='RELEASE_VERSION').text); assert.deepEqual(new Uint8Array(await options.body.get('api.mjs').arrayBuffer()),apiFixture.files.get('api.mjs')); apiVersion={id:crypto.randomUUID(),annotations:meta.annotations};apiDeployment={id:`api-${++deployments}`,versions:[{version_id:apiVersion.id,percentage:100}]};return provider({id:pins.worker});}
      if(path.endsWith('/upload-token')) return provider({jwt:'synthetic-upload-token'});
      if(path.endsWith('/assets/upload')) {for(const asset of JSON.parse(options.body)) assets.set(asset.key,asset.value);return provider(null);}
      if(path.endsWith('/assets/check-missing')) return provider(JSON.parse(options.body).hashes.filter(hash=>!assets.has(hash)));
      if(path.endsWith('/synthetic-pages/deployments') && method==='POST') {pagesFixture=fixtures.find(f=>f.manifest.sourceCommit===options.body.get('commit_hash'));const manifest=JSON.parse(options.body.get('manifest'));assert.equal(Buffer.from(assets.get(manifest['/index.html']),'base64').toString(),`<p>Synthetic ${pagesFixture.manifest.sequence}</p>`);pageDeployment={id:`pages-${++deployments}`,environment:'production',latest_stage:{name:'deploy',status:'success'},deployment_trigger:{metadata:{branch:'main',commit_hash:options.body.get('commit_hash'),commit_message:options.body.get('commit_message')}}};return provider(pageDeployment);}
      if(path.endsWith('/synthetic-pages/deployments')) return provider([pageDeployment]);
      if(path.endsWith('/synthetic-pages')) return provider({name:pins.pagesProject,source:null,production_branch:'main',canonical_deployment:pageDeployment,deployment_configs:{production:config}});
      if(path.endsWith('/query')) {assert.deepEqual(JSON.parse(options.body),{sql:'SELECT name FROM d1_migrations ORDER BY id'});return provider([{success:true,results:app.prepare('SELECT name FROM d1_migrations ORDER BY id').all()}]);}
    } else if([pins.apiOrigin,pins.dashboardOrigin].includes(parsed.origin)) {
      assert.equal(options.headers.Authorization,undefined);
      if(['/health','/api/health'].includes(path)) {const invalid=failReopen || (badHealth && apiFixture.manifest.sequence===2);if(failReopen){failReopen=false;failedReopenReads=codeReads;}return json({ok:true,service:'lancerlogin-api',mode:'ready',releaseVersion:invalid?'invalid':apiFixture.manifest.version});}
      if(path==='/') return new Response(`<p>Synthetic ${pagesFixture.manifest.sequence}</p>`);
    }
    throw Error(`unexpected synthetic endpoint ${url}`);
  }
  const credential='c'.repeat(64), secrets={checkpointKey:crypto.getRandomValues(new Uint8Array(32)),githubToken:'synthetic-github-token',cloudflareToken:'synthetic-cloudflare-token',appHmac:'a'.repeat(64),maintenanceHmac:'b'.repeat(64),recoveryCredentialSha256:await recoveryCredentialDigest(credential,pins.installationId)};
  let lostInitialize=false, lost47=false, migrationBatches=0,lostArchive=false,archiveRetried=false,lostRestore=false;
  const bindings={application:binding(app,()=>{},()=>{if(restoreScenario&&app.prepare("SELECT 1 FROM sqlite_schema WHERE name='_ll_restore_owner'").get()){if(!lostRestore){lostRestore=true;throw Error('lost restore acknowledgment');}return;}migrationBatches++;if(initialSchema===46 && !lost47 && app.prepare("SELECT 1 FROM sqlite_schema WHERE name='d1_migrations'").get()&&app.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n===47){lost47=true;throw Error('lost47 acknowledgment');}},executed('application')),updater:binding(updater,sql=>{if(restoreScenario&&!lostArchive&&sql.startsWith('INSERT INTO updater_provider_operations')&&updater.prepare("SELECT 1 FROM updater_provider_operations WHERE operation_id LIKE 'restore-archive:%'").get()){lostArchive=true;throw Error('lost archive acknowledgment');}if(!lostInitialize && sql.startsWith('INSERT INTO updater_state ')){lostInitialize=true;throw Error('lost initialize acknowledgment');}},()=>{},executed('updater')),validation:binding(validation,()=>{},()=>{},executed('validation'))}, bootstrapCapability={};
  const fencePolicy=restoreScenario?{maintenanceService:'synthetic-updater',secretBindings:[{name:'SESSION_SECRET',type:'secret_text'},{name:'MAINTENANCE_APP_KEY',type:'secret_text'}],adoption:{installationId:pins.installationId,applicationDatabaseId:pins.applicationDatabaseId,accountId:pins.accountId,worker:pins.worker,maintenanceService:'synthetic-updater',recordSha256:'f'.repeat(64),contract:'exclusive-writers-fenced-adoption-v1'},coverage:fixtures.map(f=>({apiSha256:f.manifest.artifacts.find(a=>a.role==='api').sha256,protocol:'maintenance-v1',entryPoints:['http','scheduled','scheduler-fetch','scheduler-alarm']}))}:undefined;
  const options={pins,trust,bindings,secrets,bootstrapCapability,fetch:fetcher,...(fencePolicy?{fencePolicy}:{})}, build=()=>createUpdaterRuntime(options);
  await assert.rejects(()=>createUpdaterRuntime({...options,bindings:{...bindings,validation:bindings.application}}),/identity/);
  let runtime=await build(); const init={releaseId:1000,manifestBytes:fixtures[0].manifestBytes,signatureBytes:fixtures[0].signatureBytes,updaterVersion:'1.0.0',artifacts:fixtures[0].files,adoption:await bootstrapAdoption(pins,{apiDeploymentId:apiDeployment.id,apiVersionId:apiVersion.id,pagesDeploymentId:pageDeployment.id,config,secretBindings:[{name:'SESSION_SECRET',type:'secret_text'},...(restoreScenario?[{name:'MAINTENANCE_APP_KEY',type:'secret_text'}]:[])]})};
  await assert.rejects(()=>runtime.initialize({},init),/identity/);
  let initialized;for(let i=0;i<170;i++){try{initialized=await runtime.initialize(bootstrapCapability,init);}catch(error){assert.equal(error.message,'lost initialize acknowledgment');runtime=await build();continue;}if(initialized.outcome==='initialized')break;if(i===3)runtime=await build();}assert.equal(initialized.outcome,'initialized');assert.ok(lostInitialize);
  assert.equal(runtime.engine,undefined);assert.equal((await runtime.application.fetch(new Request('https://updater.invalid/v1/status'))).status,401);
  let driverCookie, driverCsrf;
  if (recoveryFacade) {
    const response = await runtime.recovery.fetch(new Request(`${pins.recoveryOrigin}/recovery/session`, { method: 'POST', headers: { origin: pins.recoveryOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ credential }) }));
    assert.equal(response.status, 200); driverCookie = response.headers.get('set-cookie').split(';')[0];
    const status = await runtime.recovery.fetch(new Request(`${pins.recoveryOrigin}/recovery/status`, { headers: { cookie: driverCookie } }));
    driverCsrf = (await status.json()).csrfToken;
  }
  async function appCall(action,body={},expectedStatus=200) {
    if(controlFacade&&action==='start'){
      const grantResponse=await runtime.application.fetch(await signedUpdaterRequest({secret:secrets.appHmac,installationId:pins.installationId,actorId:'synthetic-admin',action:'control-grant',body}));assert.equal(grantResponse.status,200);const grant=await grantResponse.json();
      const exchanged=await runtime.controls.fetch(new Request(pins.recoveryOrigin+'/control/exchange',{method:'POST',headers:{origin:pins.recoveryOrigin,'content-type':'application/json'},body:JSON.stringify({grant:grant.grant})}));assert.equal(exchanged.status,200);driverCookie=exchanged.headers.get('set-cookie').split(';')[0];
      const confirmed=await runtime.controls.fetch(new Request(pins.recoveryOrigin+'/control/status',{headers:{cookie:driverCookie}}));assert.equal(confirmed.status,200);driverCsrf=(await confirmed.json()).csrfToken;
    }
    const beforeSql=measured?Object.values(metrics.sql).reduce((a,b)=>a+b,0):0,beforeFetch=measured?metrics.fetchReads+metrics.fetchWrites:0,beforeBindings=measured?Object.values(metrics.bindingCalls).reduce((a,b)=>a+b,0):0;
    if(measured&&action==='advance'){metrics.advances++;const step=status?.job?.step??'maintenance';metrics.steps[step]=(metrics.steps[step]??0)+1;}
    const independent = (recoveryFacade||controlFacade) && action === 'advance', surface=controlFacade?'control':'recovery';
    const request=independent ? new Request(`${pins.recoveryOrigin}/${surface}/advance`, { method: 'POST', headers: { cookie: driverCookie, origin: pins.recoveryOrigin, 'content-type': 'application/json', [`x-${surface}-csrf`]: driverCsrf, [`x-${surface}-nonce`]: crypto.randomUUID() }, body: JSON.stringify(body) }) : await signedUpdaterRequest({secret:secrets.appHmac,installationId:pins.installationId,actorId:'synthetic-admin',action,body});const response=await runtime[independent ? (controlFacade?'controls':'recovery') : 'application'].fetch(request);const value=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(value));
    if(measured&&action==='advance'){
      const sql=Object.values(metrics.sql).reduce((a,b)=>a+b,0)-beforeSql, bindings=Object.values(metrics.bindingCalls).reduce((a,b)=>a+b,0)-beforeBindings, fetches=metrics.fetchReads+metrics.fetchWrites-beforeFetch;
      const sample={step:status?.job?.step,sqlExecutions:sql,bindingCalls:bindings,fetchRequests:fetches};
      if(sql>metrics.maxSqlPerAdvance){metrics.maxSqlPerAdvance=sql;metrics.maxSqlStep=status?.job?.step;metrics.sqlPeak=sample;}
      if(bindings>metrics.maxBindingCallsPerAdvance){metrics.maxBindingCallsPerAdvance=bindings;metrics.bindingPeak=sample;}
      if(fetches>metrics.maxFetchPerAdvance){metrics.maxFetchPerAdvance=fetches;metrics.fetchPeak=sample;}
      if(!metrics.combinedPeak || bindings+fetches>metrics.combinedPeak.bindingCalls+metrics.combinedPeak.fetchRequests)metrics.combinedPeak=sample;
      if(controlFacade)assert.ok(bindings<=46,`control binding budget: ${JSON.stringify(sample)}`);
      if(recoveryFacade)assert.ok(bindings<=44,`recovery binding budget: ${JSON.stringify(sample)}`);
    }
    if(measured&&action==='start')metrics.admission={action:'start',step:'admission',sqlExecutions:Object.values(metrics.sql).reduce((a,b)=>a+b,0)-beforeSql,bindingCalls:Object.values(metrics.bindingCalls).reduce((a,b)=>a+b,0)-beforeBindings,fetchRequests:metrics.fetchReads+metrics.fetchWrites-beforeFetch};
    return value;
  }
  let status;for(let i=0;i<6;i++){status=await appCall('check');if(status.availability?.status==='available')break;}assert.equal(status.availability.status,'available');
  if(twoUpdates||restoreScenario)resetMetrics();const firstStarted=performance.now();
  status=await appCall('start',{requestId:crypto.randomUUID(),releaseId:2000});const failedJobId=status.job.id;
  const intermediate = new Set(); let rejectedWrongBackup=false;
  for(let i=0;i<((twoUpdates||restoreScenario)?2000:500);i++){
    status=await appCall('advance',{jobId:failedJobId});if([47,48].includes(status.schema))intermediate.add(status.schema);
    if(status.schema===47 && !rejectedWrongBackup && !twoUpdates){
      const saved=updater.prepare('SELECT state_json FROM updater_state').get().state_json,current=JSON.parse(saved),cipher=await createCheckpointCipher(secrets.checkpointKey,pins.installationId),checkpoint=await cipher.open(current.checkpoint.jobId,current.checkpoint.envelope);
      checkpoint.backup.schema=49;current.checkpoint.envelope=await cipher.seal(current.checkpoint.jobId,checkpoint);updater.prepare('UPDATE updater_state SET state_json=?').run(JSON.stringify(current));
      await appCall('advance',{jobId:failedJobId},409);assert.equal(migrationBatches,1,'invalid original backup blocks next migration');updater.prepare('UPDATE updater_state SET state_json=?').run(saved);rejectedWrongBackup=true;
    }
    if(status.job.status==='failed' || status.maintenance.state==='open')break;if(i===100 || status.job.status==='reconciling')runtime=await build();
  }
  if(controlFacade){assert.equal(updater.prepare('SELECT session_hash FROM updater_control_requests WHERE request_id=?').get(status.job.requestId).session_hash,null);assert.equal((await runtime.controls.fetch(new Request(pins.recoveryOrigin+'/control/status',{headers:{cookie:driverCookie}}))).status,401);}
  if(initialSchema===46&&!restoreScenario){
    assert.equal(status.job.status,'succeeded');assert.equal(status.schema,49);assert.equal(status.maintenance.state,'open');assert.deepEqual([...intermediate],[47,48]);assert.ok(lost47 && (twoUpdates || rejectedWrongBackup));assert.equal(migrationBatches,3,'lost47 acknowledgment never redispatches');
    assert.equal(app.prepare("SELECT first_name FROM members WHERE id='member'").get().first_name,'Synthetic');assert.equal(app.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n,49);
    for(const [name,rows] of Object.entries(preserved))for(const db of [app,validation]){const actual=db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();assert.equal(actual.length,rows.length);for(let i=0;i<rows.length;i++)for(const [key,value] of Object.entries(rows[i]))assert.deepEqual(actual[i][key],value,`${name}.${key} preserved`);}
    const current=JSON.parse(updater.prepare('SELECT state_json FROM updater_state').get().state_json), cipher=await createCheckpointCipher(secrets.checkpointKey,pins.installationId), checkpoint=await cipher.open(current.checkpoint.jobId,current.checkpoint.envelope);
    assert.equal(checkpoint.priorInstalled.schema,46);assert.equal(checkpoint.backup.schema,46);assert.equal(checkpoint.backup.verified,true);assert.equal(checkpoint.backup.validation.schema,46);assert.deepEqual(checkpoint.priorInstalled.ledger,initialCatalog.ledger);assert.equal(validation.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n,46);assert.equal(validation.prepare("SELECT first_name FROM members WHERE id='member'").get().first_name,'Synthetic');
    if(twoUpdates){
      for(const db of [app,validation])assert.deepEqual(db.prepare('SELECT rowid AS snapshot_rowid,* FROM audit_log ORDER BY rowid').all(),expectedAudit);
      const firstMetrics={...structuredClone(metrics),elapsedMs:Math.round(performance.now()-firstStarted)},firstEpoch=status.maintenance.epoch,firstBackup=structuredClone(checkpoint.backup);measured=false;
      const artifactStore=createArtifactStore({database:bindings.updater,installationId:pins.installationId,cipher});
      const firstSnapshot=structuredClone((await artifactStore.operation(`snapshot:${firstBackup.backupId}`)).value),firstValidation=structuredClone((await artifactStore.operation(`snapshot-replay:${firstBackup.backupId}`)).value);
      visibleSequences=3;for(let i=0;i<6;i++){status=await appCall('check');if(status.availability?.status==='available')break;}assert.equal(status.availability.releaseId,3000);
      resetMetrics();const secondStarted=performance.now();status=await appCall('start',{requestId:crypto.randomUUID(),releaseId:3000});const secondJob=status.job.id;assert.notEqual(secondJob,failedJobId);assert.equal(status.maintenance.epoch,firstEpoch+1);
      for(let i=0;i<2000;i++){status=await appCall('advance',{jobId:secondJob});if(status.maintenance.state==='open'||status.job.status==='failed')break;if(i===200)runtime=await build();}
      const secondMetrics={...structuredClone(metrics),elapsedMs:Math.round(performance.now()-secondStarted)};measured=false;
      assert.equal(status.job.status,'succeeded');assert.equal(status.installedVersion,'3.0.0');assert.equal(status.highestSequence,3);assert.equal(status.schema,49);assert.equal(status.maintenance.state,'open');assert.equal(migrationBatches,3);
      const finalState=JSON.parse(updater.prepare('SELECT state_json FROM updater_state').get().state_json),finalCheckpoint=await cipher.open(finalState.checkpoint.jobId,finalState.checkpoint.envelope),secondBackup=finalCheckpoint.backup;
      assert.equal(secondBackup.schema,49);assert.equal(secondBackup.verified,true);assert.notEqual(secondBackup.backupId,firstBackup.backupId);assert.equal(secondBackup.identity.epoch,firstBackup.identity.epoch+1);
      assert.deepEqual((await artifactStore.operation(`backup:${firstBackup.backupId}`)).value.receipt,firstBackup);
      assert.deepEqual((await artifactStore.operation(`backup:${secondBackup.backupId}`)).value.receipt,secondBackup);
      assert.deepEqual((await artifactStore.operation(`snapshot:${firstBackup.backupId}`)).value,firstSnapshot);
      assert.deepEqual((await artifactStore.operation(`snapshot-replay:${firstBackup.backupId}`)).value,firstValidation);
      assert.equal(await sha256(await artifactStore.read(firstSnapshot.pages[0].artifactId)),firstSnapshot.pages[0].sha256);
      for(const db of [app,validation])assert.deepEqual(db.prepare('SELECT rowid AS snapshot_rowid,* FROM audit_log ORDER BY rowid').all(),expectedAudit);
      assert.equal(validation.prepare('SELECT COUNT(*) AS n FROM _ll_snapshot_generations').get().n,2);
      t.diagnostic(JSON.stringify({operationalRows,recoveryFacade,controlFacade,first:firstMetrics,second:secondMetrics}));
    }
    return;
  }
  assert.equal(status.job.status,'failed');assert.equal(status.job.step,'health');assert.equal(status.maintenance.state,'closed');assert.equal(status.recoveryAvailable,true);
  badHealth=false; const response=await runtime.recovery.fetch(new Request(`${pins.recoveryOrigin}/recovery/session`,{method:'POST',headers:{origin:pins.recoveryOrigin,'content-type':'application/json'},body:JSON.stringify({credential})}));assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];
  let failureObserved=false;
  async function recoverCall(action,body) {const before=restoreScenario?{sql:Object.values(metrics.sql).reduce((a,b)=>a+b,0),bindings:Object.values(metrics.bindingCalls).reduce((a,b)=>a+b,0),fetch:metrics.fetchReads+metrics.fetchWrites}:null;const headers={cookie,origin:pins.recoveryOrigin};if(body){headers['content-type']='application/json';headers['x-recovery-csrf']=status.csrfToken;headers['x-recovery-nonce']=crypto.randomUUID();}const result=await runtime.recovery.fetch(new Request(`${pins.recoveryOrigin}/recovery/${action}`,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})}));const value=await result.json();if(before){const sample={action,step:status.job?.step,sql:Object.values(metrics.sql).reduce((a,b)=>a+b,0)-before.sql,bindings:Object.values(metrics.bindingCalls).reduce((a,b)=>a+b,0)-before.bindings,fetch:metrics.fetchReads+metrics.fetchWrites-before.fetch};metrics.recoveryCalls=(metrics.recoveryCalls??0)+1;if(!metrics.recoveryPeak||sample.bindings>metrics.recoveryPeak.bindings)metrics.recoveryPeak=sample;assert.ok(sample.bindings<=49,JSON.stringify(sample));}if(restoreScenario&&action==='recovery'&&value.recoveryRequest?.state==='pending'&&lostArchive&&!archiveRetried){archiveRetried=true;return recoverCall(action,body);}if(result.status===409 && failedReopenReads!==null && !failureObserved){failureObserved=true;return recoverCall('status');}assert.equal(result.status,200,JSON.stringify(value));return value;}
  const restoreEpoch=status.maintenance.epoch;status=await recoverCall('status');if(restoreScenario){const enabled=runtime;runtime=await createUpdaterRuntime({...options,fencePolicy:undefined});const rejected=await recoverCall('recovery',{requestId:crypto.randomUUID(),failedJobId,mode:'restore',confirmation:'RESTORE APPLICATION DATABASE'});assert.equal(rejected.recoveryRequest.state,'rejected');assert.equal(rejected.job.id,failedJobId);runtime=enabled;}status=await recoverCall('recovery',{requestId:crypto.randomUUID(),failedJobId,mode:restoreScenario?'restore':'code-recovery',confirmation:restoreScenario?'RESTORE APPLICATION DATABASE':'RECOVER APPLICATION CODE'});
  let readsAtTerminal;for(let i=0;i<(restoreScenario?2000:70);i++){status=await recoverCall('advance',{jobId:status.job.id});if(status.job.status==='recovered' && readsAtTerminal===undefined){readsAtTerminal=codeReads;failReopen=true;}if(status.maintenance.state==='open')break;runtime=await build();}
  assert.equal(status.job.status,'recovered');assert.equal(status.installedVersion,'1.0.0');assert.equal(status.highestSequence,2);assert.equal(status.maintenance.state,'open');assert.ok(codeReads>readsAtTerminal,'reopening performed fresh provider code scan');assert.ok(failureObserved && codeReads>failedReopenReads,'failed reopening scan restarts with fresh code verification');assert.equal(apiFixture.manifest.sequence,1);assert.equal(pagesFixture.manifest.sequence,1);
  if(restoreScenario){assert.ok(lostArchive&&archiveRetried&&lostRestore);assert.equal(status.maintenance.epoch,restoreEpoch);assert.deepEqual(app.prepare('SELECT rowid AS snapshot_rowid,* FROM audit_log ORDER BY rowid').all(),expectedAudit);for(const [name,rows]of Object.entries(preserved))assert.deepEqual(app.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),rows);t.diagnostic(JSON.stringify({restoreScenario,metrics}));}
  assert.equal((await runtime.initialize(bootstrapCapability,init)).outcome,'initialized');assert.equal((await appCall('status')).job.id,status.job.id,'bootstrap replay never resets a job');
}
test('runtime drives schema49 backup, failed health, independent recovery and fresh reopening', t => scenario(t));
test('runtime upgrades populated46 to49 with retained46 backup and lost47 acknowledgment', t => scenario(t,46));

test('runtime profiles two consecutive updates with1000 operational rows and retained validation generations', t => scenario(t,46,{twoUpdates:true,operationalRows:1000}));
test('runtime profiles recovery facade with1000 operational rows', t => scenario(t,46,{twoUpdates:true,operationalRows:1000,recoveryFacade:true}));

test('runtime profiles delegated controls with1000 operational rows', t => scenario(t,46,{twoUpdates:true,operationalRows:1000,controlFacade:true}));

test('runtime restores46 after completed49 migrations and health failure under optional reviewed fence policy',t=>scenario(t,46,{restoreScenario:true,operationalRows:10}));

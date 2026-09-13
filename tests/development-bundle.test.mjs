import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { packageBundle, verifyBundle, validateIdentity, buildDevelopmentConfig, prepareSecrets, bootstrap, inspectHoursProxy, prepareHoursProxySecret, HOURS_PROXY_CONFIG, inspectScheduler, SCHEDULER_CONFIG, PASSWORD_COMPUTATION_CONFIG } from '../scripts/development-bundle.mjs';
import { DEVELOPMENT_REPOSITORY, DEVELOPMENT_RESOURCES } from '../scripts/development-preflight.mjs';

const identity = { repository: DEVELOPMENT_REPOSITORY, accountId: 'a'.repeat(32), apiOrigin: 'https://lancerlogin-v2-example-api.example.workers.dev', pagesOrigin: 'https://lancerlogin-v2-example-dashboard.pages.dev', resources: DEVELOPMENT_RESOURCES.map(r => ({ ...r, id: r.kind === 'worker' ? r.name : randomUUID() })) };
const report = { repository: DEVELOPMENT_REPOSITORY, mode: 'report', resources: identity.resources.map(r => ({ ...r, state: 'exists' })) };
async function fixture(t, migrationNames = ['0001_initial.sql'], approvedIdentity = identity) {
  const root = resolve('.provision', `bundle-test-${randomUUID()}`);
  await mkdir(join(root, 'source/pages'), { recursive: true });
  await mkdir(join(root, 'source/migrations'));
  await writeFile(join(root, 'source/api.js'), 'export default {fetch(){return new Response("ok")}}');
  await writeFile(join(root, 'source/pages/index.html'), '<html>development fixture</html>');
  for (const name of migrationNames) await writeFile(join(root, 'source/migrations', name), '-- synthetic migration fixture');
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  const result = await packageBundle({ output: bundle, identity: approvedIdentity, report, sourceCommit: 'b'.repeat(40), version: '0.22.2', apiFile: join(root, 'source/api.js'), pagesDirectory: join(root, 'source/pages'), migrationsDirectory: join(root, 'source/migrations') });
  return { root, bundle, digest: result.manifestSha256 };
}
test('exact account-resource names, IDs, repository and origins required', () => {
  assert.equal(validateIdentity(identity, report), identity);
  for (const change of [{ repository: 'isriah/LancerLogin' }, { apiOrigin: 'https://production.workers.dev' }, { pagesOrigin: 'https://example.com' }, { accountId: 'bad' }, { resources: identity.resources.slice(1) }, { resources: identity.resources.map(r => ({ ...r, id: randomUUID() })) }]) assert.throws(() => validateIdentity({ ...identity, ...change }, report));
  assert.throws(() => validateIdentity(identity, { ...report, resources: report.resources.map(r => ({ ...r, state: 'missing' })) }));
});
test('immutable inventory rejects changed, extra, missing and manifest-tampered artifacts', async t => {
  const { bundle, digest } = await fixture(t);
  const manifest = await verifyBundle(bundle, digest, identity);
  assert.equal(manifest.schema.migrations[0], 'migrations/0001_initial.sql');
  const file = join(bundle, 'api/index.js'), original = await readFile(file);
  await writeFile(file, 'tampered');
  await assert.rejects(verifyBundle(bundle, digest, identity), /inventory/);
  await writeFile(file, original);
  await writeFile(join(bundle, 'extra'), 'unexpected');
  await assert.rejects(verifyBundle(bundle, digest, identity), /inventory/);
  await rm(join(bundle, 'extra'));
  await rm(file);
  await assert.rejects(verifyBundle(bundle, digest, identity), /inventory/);
  await writeFile(file, original);
  await writeFile(join(bundle, 'manifest.json'), '{}');
  await assert.rejects(verifyBundle(bundle, digest, identity), /Manifest digest/);
});
test('config uses prebuilt artifacts and excludes community telemetry, update workflows and updater credentials', async t => {
  const { bundle, digest } = await fixture(t);
  const config = buildDevelopmentConfig(identity, await verifyBundle(bundle, digest, identity), bundle);
  assert.equal(config.main, join(bundle, 'api/index.js'));
  assert.deepEqual(Object.keys(config.vars).sort(), ['ALLOWED_ORIGIN', 'APP_MODE', 'RELEASE_VERSION']);
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.keep_vars, false);
  assert.deepEqual(config.triggers, { crons: [] }, 'P0 explicitly clears only its development Worker schedules without consuming account cron quota');
  const proxy = await readFile(join(bundle, 'pages/_worker.js'), 'utf8');
  assert.ok(proxy.includes(identity.apiOrigin));
});
test('secret generation is durable and uploads only missing keys without rotating existing values', async t => {
  const { root } = await fixture(t), path = join(root, 'secrets.json');
  assert.deepEqual(await prepareSecrets(path, ['SESSION_KEY', 'INTEGRATION_KEY', 'BOOTSTRAP_CODE_HASH']), { secrets: {}, generated: false });
  const first = await prepareSecrets(path, ['INTEGRATION_KEY']);
  assert.deepEqual(Object.keys(first.secrets), ['SESSION_KEY', 'BOOTSTRAP_CODE_HASH']);
  const contents = await readFile(path, 'utf8');
  const second = await prepareSecrets(path, ['SESSION_KEY', 'INTEGRATION_KEY']);
  assert.deepEqual(Object.keys(second.secrets), ['BOOTSTRAP_CODE_HASH']);
  assert.equal(second.secrets.BOOTSTRAP_CODE_HASH, first.secrets.BOOTSTRAP_CODE_HASH);
  assert.equal(await readFile(path, 'utf8'), contents);
});
test('account mismatch blocks provider calls and command execution', async t => {
  const { bundle, digest } = await fixture(t);
  let calls = 0;
  await assert.rejects(bootstrap({ identity, bundle, digest, stage: 'deploy', env: { CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32), CLOUDFLARE_API_TOKEN: 'cfat_test' }, fetchImpl: () => { calls++; }, runner: () => { calls++; } }), /approved account/);
  assert.equal(calls, 0);
});
function providerMock({ tables = [], subdomain = 'example', migrations = ['0001_initial.sql'] } = {}) {
  const mutations = [], secretRequests = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname.split(`/accounts/${identity.accountId}/`)[1];
    let result;
    if (path === 'tokens/verify') result = { status: 'active' };
    else if (path === 'workers/scripts') result = [{ id: 'lancerlogin-v2-example-api' }];
    else if (path === 'pages/projects/lancerlogin-v2-example-dashboard') result = {...identity.resources.find(r=>r.name==='lancerlogin-v2-example-dashboard'),deployment_configs:{production:{env_vars:{}}}};
    else if (path === 'pages/projects') result = identity.resources.filter(r => r.kind === 'pages');
    else if (path === 'd1/database') result = identity.resources.filter(r => r.kind === 'd1').map(r => ({ ...r, uuid: r.id }));
    else if (path === 'workers/services/lancerlogin-v2-example-api') result = { default_environment: { script: { id: SCHEDULER_CONFIG.worker } } };
    else if (path.endsWith('/settings')) result = { bindings: [] };
    else if (path === 'workers/durable_objects/namespaces') return Response.json({ success: true, result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0 } });
    else if (path === 'workers/subdomain') result = { subdomain };
    else if (path.endsWith('/query')) result = [{ success: true, results: JSON.parse(options.body).sql.includes('FROM d1_migrations') ? migrations.map(name => ({ name })) : tables }];
    else if (path.endsWith('/secrets')) { secretRequests.push(path); result = ['SESSION_KEY', 'INTEGRATION_KEY', 'BOOTSTRAP_CODE_HASH'].map(name => ({ name, type: 'secret_text' })); }
    else throw new Error('Unexpected mock route');
    if (options.method && options.method !== 'GET' && !path.endsWith('/query')) mutations.push(path);
    return Response.json({ success: true, result });
  };
  return { fetchImpl, mutations, secretRequests };
}
test('mock deployment preserves all existing secrets and uses only prebuilt exact-target commands', async t => {
  const { bundle, digest } = await fixture(t), mock = providerMock(), commands = [];
  const result = await bootstrap({ identity, bundle, digest, stage: 'deploy', env: { CLOUDFLARE_ACCOUNT_ID: identity.accountId, CLOUDFLARE_API_TOKEN: 'cfat_test' }, fetchImpl: mock.fetchImpl, runner: args => commands.push(args) });
  assert.equal(result.completed, true);
  assert.deepEqual(mock.mutations, []);
  assert.equal(commands.length, 2);
  assert.ok(commands.every(args => args.includes('--no-bundle')));
  assert.ok(commands[1].includes('lancerlogin-v2-example-dashboard'));
});
test('deploy refuses uninitialized, partial, mismatched and newer schemas before secrets or uploads', async t => {
  const { bundle, digest } = await fixture(t, ['0001_initial.sql', '0002_next.sql']);
  for (const migrations of [[], ['0001_initial.sql'], ['0001_initial.sql', '0002_wrong.sql'], ['0001_initial.sql', '0002_next.sql', '0003_newer.sql'], ['0002_next.sql', '0001_initial.sql']]) {
    const mock = providerMock({ migrations }), commands = [];
    await assert.rejects(bootstrap({ identity, bundle, digest, stage: 'deploy', env: { CLOUDFLARE_ACCOUNT_ID: identity.accountId, CLOUDFLARE_API_TOKEN: 'cfat_test' }, fetchImpl: mock.fetchImpl, runner: args => commands.push(args) }), /migration ledger/);
    assert.deepEqual(commands, []);
    assert.deepEqual(mock.secretRequests, []);
    assert.deepEqual(mock.mutations, []);
  }
});
test('wrong live subdomain and existing D1 tables block all deployment commands', async t => {
  const { bundle, digest } = await fixture(t);
  for (const options of [{ subdomain: 'wrong' }, { tables: [{ name: 'installation' }] }]) {
    let commands = 0;
    await assert.rejects(bootstrap({ identity, bundle, digest, stage: 'migrate-fresh', env: { CLOUDFLARE_ACCOUNT_ID: identity.accountId, CLOUDFLARE_API_TOKEN: 'cfat_test' }, fetchImpl: providerMock(options).fetchImpl, runner: () => commands++ }));
    assert.equal(commands, 0);
  }
  const commands = [];
  await bootstrap({ identity, bundle, digest, stage: 'migrate-fresh', env: { CLOUDFLARE_ACCOUNT_ID: identity.accountId, CLOUDFLARE_API_TOKEN: 'cfat_test' }, fetchImpl: providerMock().fetchImpl, runner: args => commands.push(args) });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].slice(0, 5), ['d1', 'migrations', 'apply', 'lancerlogin-v2-example-data', '--remote']);
});

const approvedScheduler = { ...SCHEDULER_CONFIG, namespaceId: 'd'.repeat(32) };
function schedulerApi({ settings, namespaces } = {}) {
  return async path => path.includes('/services/') ? { default_environment: { script: { id: SCHEDULER_CONFIG.worker, migration_tag: settings ? settings.migration_tag : SCHEDULER_CONFIG.migrationTag } } } : path.endsWith('/settings') ? (settings ?? { migration_tag: SCHEDULER_CONFIG.migrationTag, bindings: [
    { name: SCHEDULER_CONFIG.binding, type: 'durable_object_namespace', class_name: SCHEDULER_CONFIG.className, namespace_id: approvedScheduler.namespaceId },
    { name: 'PLATFORM_SCHEDULER_MODE', type: 'plain_text', text: 'durable' }
  ] }) : { result: namespaces ?? [{ id: approvedScheduler.namespaceId, name: 'synthetic-scheduler-namespace', script: SCHEDULER_CONFIG.worker, class: SCHEDULER_CONFIG.className, use_sqlite: true }], result_info: { page: 1, per_page: 100, count: namespaces?.length ?? 1, total_count: namespaces?.length ?? 1 } };
}
test('scheduler approval pins every field and rejects arbitrary resources and missing identity', async () => {
  for (const key of Object.keys(SCHEDULER_CONFIG)) assert.throws(() => validateIdentity({ ...identity, scheduler: { ...approvedScheduler, [key]: 'wrong' } }, report));
  assert.throws(() => validateIdentity({ ...identity, scheduler: { ...approvedScheduler, arbitrary: true } }, report));
  assert.throws(() => validateIdentity({ ...identity, scheduler: { ...approvedScheduler, namespaceId: 'wrong' } }, report));
  await assert.rejects(inspectScheduler(schedulerApi(), identity), /approval required/);
  assert.deepEqual(await inspectScheduler(schedulerApi(), { ...identity, scheduler: approvedScheduler }), { state: 'existing', namespaceId: approvedScheduler.namespaceId, namespaceName: 'synthetic-scheduler-namespace' });
  await assert.rejects(inspectScheduler(schedulerApi(), { ...identity, scheduler: { ...approvedScheduler, namespaceId: null } }), /independently approve/);
  assert.equal((await inspectScheduler(schedulerApi(), { ...identity, scheduler: { ...approvedScheduler, namespaceId: null } }, { capture: true })).namespaceId, approvedScheduler.namespaceId);
});
test('scheduler refuses missing, foreign, non-SQLite, duplicate and rollback provider state', async () => {
  const approved = { ...identity, scheduler: approvedScheduler }, api = schedulerApi(), settings = await api('/settings'), response = await api('/namespaces');
  for (const patch of [{ settings: { bindings: [] } }, { settings: { ...settings, migration_tag: 'platform-scheduler-v2' } },
    { settings: { ...settings, bindings: settings.bindings.slice(1) } }, { settings: { ...settings, bindings: [...settings.bindings, settings.bindings[0]] } },
    { namespaces: [] }, { namespaces: [{ ...response.result[0], script: 'another-worker' }] }, { namespaces: [{ ...response.result[0], class: 'Other' }] },
    { namespaces: [{ ...response.result[0], use_sqlite: false }] }, { namespaces: [{ ...response.result[0], id: 'e'.repeat(32) }] },
    { namespaces: [...response.result, ...response.result] }]) await assert.rejects(inspectScheduler(schedulerApi(patch), approved));
  for (const field of ['name', 'class_name', 'namespace_id', 'script_name', 'environment']) {
    const changed = structuredClone(settings); changed.bindings[0][field] = 'wrong';
    await assert.rejects(inspectScheduler(schedulerApi({ settings: changed }), approved));
  }
  await assert.rejects(inspectScheduler(async () => ({ bindings: [], result: [], result_info: { page: 1 } }), approved), /Malformed/);
});
test('legacy artifact cannot activate scheduler and scheduler manifest cannot be downgraded', async t => {
  const { bundle, digest } = await fixture(t);
  await assert.rejects(verifyBundle(bundle, digest, { ...identity, scheduler: approvedScheduler }), /approval mismatch/);
  const manifest = await verifyBundle(bundle, digest, identity);
  manifest.scheduler = SCHEDULER_CONFIG;
  assert.throws(() => buildDevelopmentConfig(identity, manifest, bundle), /approval mismatch/);
  const config = buildDevelopmentConfig({ ...identity, scheduler: approvedScheduler }, manifest, bundle);
  assert.deepEqual(config.migrations, [{ tag: SCHEDULER_CONFIG.migrationTag, new_sqlite_classes: ['PlatformScheduler'] }]);
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'PLATFORM_SCHEDULER', class_name: 'PlatformScheduler' }]);
  assert.equal(config.vars.PLATFORM_SCHEDULER_MODE, 'durable');
  assert.deepEqual(config.triggers.crons, []);
});

test('initial scheduler upload pauses for independent capture, retries fail closed, and approved redeploy preserves state', async t => {
  const initial = { ...identity, scheduler: { ...approvedScheduler, namespaceId: null } };
  const { bundle, digest } = await fixture(t, undefined, initial), mock = providerMock(), commands = [];
  const checkpoint = resolve('.provision/bootstrap', `scheduler-${createHash('sha256').update(identity.accountId).digest('hex')}.json`);
  t.after(async () => { await rm(checkpoint, { force: true }); await rm(checkpoint + '.observed.json', { force: true }); });
  let deployed = false;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.split(`/accounts/${identity.accountId}/`)[1];
    if (deployed && (path.endsWith('/settings') || path.includes('/services/') || path.endsWith('/namespaces'))) {
      const result = await schedulerApi()(path);
      return Response.json(path.endsWith('/namespaces') ? { success: true, ...result } : { success: true, result });
    }
    return mock.fetchImpl(url, options);
  };
  const args = { identity: initial, bundle, digest, stage: 'deploy', env: { CLOUDFLARE_ACCOUNT_ID: identity.accountId, CLOUDFLARE_API_TOKEN: 'cfat_test' }, fetchImpl,
    runner: command => { commands.push(command); deployed = true; } };
  const result = await bootstrap(args);
  assert.equal(result.completed, false); assert.equal(result.schedulerCaptureRequired, true); assert.equal(commands.length, 1);
  assert.equal(JSON.parse(await readFile(checkpoint)).state, 'creation-intent');
  await assert.rejects(bootstrap(args), /independently approve/);
  deployed = false;
  await assert.rejects(bootstrap(args), /intent already exists/);
  deployed = true;
  const captured = await bootstrap({ ...args, stage: 'capture-scheduler' });
  assert.equal(captured.approvalRequired, true); assert.equal(commands.length, 1);
  const observed = JSON.parse(await readFile(checkpoint + '.observed.json'));
  assert.equal(observed.approval, false); assert.equal(observed.namespaceId, approvedScheduler.namespaceId);
  assert.equal(initial.scheduler.namespaceId, null, 'capture cannot change independent approval');
  const completed = await bootstrap({ ...args, identity: { ...identity, scheduler: approvedScheduler } });
  assert.equal(completed.completed, true); assert.equal(commands.length, 3); assert.equal(commands[2][0], 'pages');
  assert.deepEqual(mock.mutations, []);
});
test('namespace inventory checks later pages and fails closed on malformed or failed provider reads before secret access', async t => {
  const approved = { ...identity, scheduler: approvedScheduler }, base = schedulerApi();
  let pages = 0;
  assert.equal((await inspectScheduler(async path => {
    if (!path.includes('/namespaces?')) return base(path);
    pages++; const page = Number(new URL('https://example.test/' + path).searchParams.get('page'));
    return { result: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: 'synthetic-other', script: 'other-worker', class: 'Other' })) : (await base(path)).result, result_info: { page, per_page: 100, count: page === 1 ? 100 : 1, total_count: 101 } };
  }, approved)).state, 'existing');
  assert.equal(pages, 2);
  const { bundle, digest } = await fixture(t), mock = providerMock();
  let commands = 0;
  await assert.rejects(bootstrap({ identity, bundle, digest, stage: 'deploy', env: { CLOUDFLARE_ACCOUNT_ID: identity.accountId, CLOUDFLARE_API_TOKEN: 'cfat_test' },
    fetchImpl: (url, options) => url.includes('/settings') ? Promise.reject(new Error('sensitive provider text')) : mock.fetchImpl(url, options), runner: () => commands++ }), error => error.message === 'Development provider operation failed; output suppressed');
  assert.equal(commands, 0); assert.deepEqual(mock.secretRequests, []);
});

test('live empty namespace pagination without total_pages proves absence', async () => {
  const base = schedulerApi({ settings: { bindings: [] }, namespaces: [] });
  const empty = { result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0 } };
  const api = path => path.includes('/namespaces?') ? empty : base(path);
  assert.deepEqual(await inspectScheduler(api, identity), { state: 'absent' });
  assert.deepEqual(await inspectScheduler(api, { ...identity, scheduler: { ...approvedScheduler, namespaceId: null } }), { state: 'create' });
  for (const total_pages of [0, 1]) {
    empty.result_info.total_pages = total_pages;
    assert.equal((await inspectScheduler(api, identity)).state, 'absent');
  }
});
test('namespace count metadata rejects missing, inconsistent, oversized and noninteger values', async () => {
  const base = schedulerApi({ settings: { bindings: [] }, namespaces: [] });
  for (const patch of [
    { total_count: undefined }, { total_count: -1 }, { total_count: 10_001 }, { total_count: 0.5 }, { total_count: '0' },
    { total_count: 1 }, { count: undefined }, { count: -1 }, { count: 1 }, { count: 0.5 },
    { per_page: undefined }, { per_page: 0 }, { per_page: 20 }, { page: 2 },
    { total_pages: -1 }, { total_pages: 2 }, { total_pages: 0.5 }, { total_pages: '1' },
  ]) await assert.rejects(inspectScheduler(path => path.includes('/namespaces?')
    ? { result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0, ...patch } } : base(path), identity), /Malformed scheduler namespace inventory/);
});
test('namespace multi-page inventory rejects changed totals, duplicate IDs and contradictory total_pages', async () => {
  const base = schedulerApi(), approved = { ...identity, scheduler: approvedScheduler };
  for (const scenario of ['changed-total', 'duplicate-id', 'bad-pages']) {
    await assert.rejects(inspectScheduler(async path => {
      if (!path.includes('/namespaces?')) return base(path);
      const page = Number(new URL('https://example.test/' + path).searchParams.get('page'));
      const first = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(32, '0'), name: 'synthetic-other', script: 'other-worker', class: 'Other' }));
      const result = page === 1 ? first : scenario === 'duplicate-id' ? [first[0]] : (await base(path)).result;
      return { result, result_info: { page, per_page: 100, count: result.length,
        total_count: scenario === 'changed-total' && page === 2 ? 100 : 101, total_pages: scenario === 'bad-pages' ? 1 : 2 } };
    }, approved), /Malformed scheduler namespace inventory/);
  }
});

test('public Hours proxy approval pins artifact and local derivation without printing or replacing secrets',async t=>{
 const {root}=await fixture(t),saved=join(root,'saved.json'),output=join(root,'hours-key.txt');
 await writeFile(saved,JSON.stringify({secrets:{SESSION_KEY:'A'.repeat(43)}}));
 const observed=await prepareHoursProxySecret(identity,saved,output);
 if(process.platform==='win32'){
  const aclCheck=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$acl=[System.IO.File]::GetAccessControl($env:LANCERLOGIN_HOURS_SECRET_PATH); $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; [bool]($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference -eq $sid -and $rules[0].AccessControlType -eq 'Allow')"],{env:{...process.env,LANCERLOGIN_HOURS_SECRET_PATH:output},windowsHide:true,encoding:'utf8'}).trim();assert.equal(aclCheck,'True');
 }
 assert.equal(observed.approval,false);assert.deepEqual(Object.keys(observed).sort(),['approval','keySha256','project','protocol','secret']);
 const approved={...identity,hoursProxy:{...HOURS_PROXY_CONFIG,keySha256:observed.keySha256}};
 const artifact=await fixture(t,['0001_initial.sql'],approved);
 assert.deepEqual((await verifyBundle(artifact.bundle,artifact.digest,approved)).hoursProxy,approved.hoursProxy);
 await assert.rejects(verifyBundle(artifact.bundle,artifact.digest,identity),/artifact approval/);
 for(const change of [{secret:'OTHER'},{project:'other'},{protocol:'v0'},{keySha256:'bad'},{unexpected:true}])assert.throws(()=>validateIdentity({...approved,hoursProxy:{...approved.hoursProxy,...change}},report),/proxy approval/);
 await assert.rejects(prepareHoursProxySecret(approved,saved,output),/EEXIST/);
 const project={...identity.resources.find(r=>r.name===HOURS_PROXY_CONFIG.project),deployment_configs:{production:{env_vars:{UNRELATED:{type:'plain_text',value:'preserve'},HOURS_PROXY_KEY:{type:'secret_text',value:'masked'}}}}};
 const before=JSON.stringify(project),api=async path=>{assert.equal(path,'pages/projects/'+HOURS_PROXY_CONFIG.project);return project;};
 await inspectHoursProxy(api,approved,saved);assert.equal(JSON.stringify(project),before);
 await assert.rejects(inspectHoursProxy(api,identity,saved),/downgrade/);
 for(const binding of [undefined,{type:'plain_text',value:'wrong'}]){project.deployment_configs.production.env_vars.HOURS_PROXY_KEY=binding;await assert.rejects(inspectHoursProxy(api,approved,saved),/missing or has wrong type/);}
 project.deployment_configs.production.env_vars.HOURS_PROXY_KEY={type:'secret_text'};
 await writeFile(saved,JSON.stringify({secrets:{SESSION_KEY:Buffer.alloc(32,1).toString('base64url')}}));
 await assert.rejects(inspectHoursProxy(api,approved,saved),/rotation/);
 await assert.rejects(prepareHoursProxySecret(approved,saved,join(root,'new.txt')),/rotation/);
 await assert.rejects(inspectHoursProxy(async()=>({...project,id:'wrong'}),approved,saved),/Malformed/);
 await assert.rejects(inspectHoursProxy(async()=>({...project,deployment_configs:{}}),identity,saved),/Malformed/);
});

test('deployed public Hours secret prevents legacy deployment before API secret writes or upload',async t=>{
 const {bundle,digest}=await fixture(t),mock=providerMock();let commands=0;
 const fetchImpl=async(url,options)=>url.endsWith('/pages/projects/'+HOURS_PROXY_CONFIG.project)?Response.json({success:true,result:{...identity.resources.find(r=>r.name===HOURS_PROXY_CONFIG.project),deployment_configs:{production:{env_vars:{HOURS_PROXY_KEY:{type:'secret_text'}}}}}}):mock.fetchImpl(url,options);
 await assert.rejects(bootstrap({identity,bundle,digest,stage:'deploy',env:{CLOUDFLARE_ACCOUNT_ID:identity.accountId,CLOUDFLARE_API_TOKEN:'cfat_test'},fetchImpl,runner:()=>commands++}),/downgrade/);
 assert.equal(commands,0);assert.deepEqual(mock.secretRequests,[]);assert.deepEqual(mock.mutations,[]);
});


const approvedPassword={...PASSWORD_COMPUTATION_CONFIG,namespaceId:'e'.repeat(32)};
const passwordIdentity={...identity,scheduler:approvedScheduler,passwordComputation:approvedPassword};
function passwordApi({present=true,settings,namespaces}={}){
 const records=[{id:approvedScheduler.namespaceId,name:'provider-scheduler',script:SCHEDULER_CONFIG.worker,class:SCHEDULER_CONFIG.className,use_sqlite:true},...(present?[{id:approvedPassword.namespaceId,name:'provider-derived-password-name',script:PASSWORD_COMPUTATION_CONFIG.worker,class:PASSWORD_COMPUTATION_CONFIG.className,use_sqlite:true}]:[])];
 const config={migration_tag:present?PASSWORD_COMPUTATION_CONFIG.migrationTag:SCHEDULER_CONFIG.migrationTag,bindings:[{name:SCHEDULER_CONFIG.binding,type:'durable_object_namespace',class_name:SCHEDULER_CONFIG.className,namespace_id:approvedScheduler.namespaceId},{name:'PLATFORM_SCHEDULER_MODE',type:'plain_text',text:'durable'},...(present?[{name:PASSWORD_COMPUTATION_CONFIG.binding,type:'durable_object_namespace',class_name:PASSWORD_COMPUTATION_CONFIG.className,namespace_id:approvedPassword.namespaceId},{name:'PASSWORD_COMPUTATION_MODE',type:'plain_text',text:'durable'}]:[])]};
 return schedulerApi({settings:settings??config,namespaces:namespaces??records});
}
test('password approval requires exact fields and a pinned existing scheduler',async()=>{
 for(const field of Object.keys(PASSWORD_COMPUTATION_CONFIG))assert.throws(()=>validateIdentity({...passwordIdentity,passwordComputation:{...approvedPassword,[field]:'wrong'}},report));
 for(const patch of [{namespaceId:'wrong'},{namespaceName:'chosen-name'},{extra:true}])assert.throws(()=>validateIdentity({...passwordIdentity,passwordComputation:{...approvedPassword,...patch}},report));
 for(const scheduler of [undefined,{...approvedScheduler,namespaceId:null}])assert.throws(()=>validateIdentity({...passwordIdentity,scheduler},report),/pinned existing scheduler/);
 await assert.rejects(inspectScheduler(passwordApi(),{...identity,scheduler:approvedScheduler}),/approval required/);
 await assert.rejects(inspectScheduler(passwordApi(),identity),/approval required/);
 const result=await inspectScheduler(passwordApi(),passwordIdentity);assert.equal(result.namespaceId,approvedScheduler.namespaceId);assert.deepEqual(result.passwordComputation,{state:'existing',namespaceId:approvedPassword.namespaceId,namespaceName:'provider-derived-password-name'});
 await assert.rejects(inspectScheduler(passwordApi({present:false}),passwordIdentity));
 assert.equal((await inspectScheduler(passwordApi({present:false}),{...passwordIdentity,passwordComputation:{...approvedPassword,namespaceId:null}})).passwordComputation.state,'create');
});
test('password inventory rejects wrong, extra, duplicate, orphan and migration rollback states',async()=>{
 const api=passwordApi(),settings=await api('/settings'),inventory=(await api('/namespaces')).result;
 for(const field of ['name','type','class_name','namespace_id','script_name','environment']){const changed=structuredClone(settings);changed.bindings[2][field]='wrong';await assert.rejects(inspectScheduler(passwordApi({settings:changed}),passwordIdentity));}
 for(const field of ['script','class','use_sqlite','id']){const changed=structuredClone(inventory);changed[1][field]='wrong';await assert.rejects(inspectScheduler(passwordApi({namespaces:changed}),passwordIdentity));}
 for(const bindings of [settings.bindings.slice(0,2),settings.bindings.filter(b=>b.name!=='PASSWORD_COMPUTATION_MODE'),[...settings.bindings,settings.bindings[2]],[...settings.bindings,{name:'OTHER',type:'durable_object_namespace',namespace_id:'f'.repeat(32)}]])await assert.rejects(inspectScheduler(passwordApi({settings:{...settings,bindings}}),passwordIdentity));
 for(const namespaces of [inventory.slice(0,1),[inventory[1]],[...inventory,inventory[1]],[...inventory,{...inventory[1],id:'f'.repeat(32),class:'Unknown'}]])await assert.rejects(inspectScheduler(passwordApi({namespaces}),passwordIdentity));
 for(const migration_tag of [null,SCHEDULER_CONFIG.migrationTag,'future-tag'])await assert.rejects(inspectScheduler(passwordApi({settings:{...settings,migration_tag}}),passwordIdentity));
 const incorrectMode=structuredClone(settings);incorrectMode.bindings[3].text='inline';await assert.rejects(inspectScheduler(passwordApi({settings:incorrectMode}),passwordIdentity));
 await assert.rejects(inspectScheduler(passwordApi(),{...passwordIdentity,passwordComputation:{...approvedPassword,namespaceId:null}}),/independently approve/);
});
test('password manifest opt-in preserves ordered scheduler migration and rejects old artifacts or identities',async t=>{
 const {bundle,digest}=await fixture(t,undefined,passwordIdentity),manifest=await verifyBundle(bundle,digest,passwordIdentity);
 const config=buildDevelopmentConfig(passwordIdentity,manifest,bundle);assert.deepEqual(config.migrations,[{tag:SCHEDULER_CONFIG.migrationTag,new_sqlite_classes:['PlatformScheduler']},{tag:PASSWORD_COMPUTATION_CONFIG.migrationTag,new_sqlite_classes:['PasswordComputation']}]);
 assert.deepEqual(config.durable_objects.bindings,[{name:'PLATFORM_SCHEDULER',class_name:'PlatformScheduler'},{name:'PASSWORD_COMPUTATION',class_name:'PasswordComputation'}]);assert.equal(config.vars.PASSWORD_COMPUTATION_MODE,'durable');assert.equal(config.vars.PLATFORM_SCHEDULER_MODE,'durable');assert.deepEqual(config.triggers.crons,[]);
 await assert.rejects(verifyBundle(bundle,digest,{...identity,scheduler:approvedScheduler}),/approval mismatch/);
 const old=await fixture(t,undefined,{...identity,scheduler:approvedScheduler});await assert.rejects(verifyBundle(old.bundle,old.digest,passwordIdentity),/approval mismatch/);
 const legacy=await fixture(t);const base=buildDevelopmentConfig(identity,await verifyBundle(legacy.bundle,legacy.digest,identity),legacy.bundle);assert.equal(base.vars.PASSWORD_COMPUTATION_MODE,undefined);assert.equal(base.durable_objects,undefined);
});
test('password prepare creation capture and pinned redeployment preserve scheduler and secrets',async t=>{
 const initial={...passwordIdentity,passwordComputation:{...approvedPassword,namespaceId:null}},{bundle,digest}=await fixture(t,undefined,initial),mock=providerMock(),commands=[];
 const checkpoint=resolve('.provision/bootstrap',`password-computation-${createHash('sha256').update(identity.accountId).digest('hex')}.json`);
 t.after(async()=>{await rm(checkpoint,{force:true});await rm(checkpoint+'.observed.json',{force:true});});let deployed=false;
 const fetchImpl=async(url,options)=>{const path=new URL(url).pathname.split(`/accounts/${identity.accountId}/`)[1];if(path?.endsWith('/settings')||path?.includes('/services/')||path?.endsWith('/namespaces')){const value=await passwordApi({present:deployed})(path);return Response.json(path.endsWith('/namespaces')?{success:true,...value}:{success:true,result:value});}return mock.fetchImpl(url,options);};
 const args={identity:initial,bundle,digest,stage:'deploy',env:{CLOUDFLARE_ACCOUNT_ID:identity.accountId,CLOUDFLARE_API_TOKEN:'cfat_test'},fetchImpl,runner:command=>{commands.push(command);deployed=true;}};
 assert.equal((await bootstrap({...args,stage:'prepare'})).verified,true);assert.equal(commands.length,0);
 await assert.rejects(bootstrap({...args,stage:'migrate-fresh'}),/initialized database/);
 const result=await bootstrap(args);assert.equal(result.passwordComputationCaptureRequired,true);assert.equal(result.completed,false);assert.equal(commands.length,1);const intent=JSON.parse(await readFile(checkpoint));assert.equal(intent.state,'creation-intent');assert.equal(intent.schedulerNamespaceId,approvedScheduler.namespaceId);assert.equal(intent.manifestSha256,digest);
 await assert.rejects(bootstrap(args),/independently approve/);deployed=false;await assert.rejects(bootstrap(args),/intent already exists/);deployed=true;
 assert.equal((await bootstrap({...args,stage:'capture-password-computation'})).approvalRequired,true);assert.equal(commands.length,1);const observed=JSON.parse(await readFile(checkpoint+'.observed.json'));assert.equal(observed.approval,false);assert.equal(observed.namespaceName,'provider-derived-password-name');assert.equal(observed.schedulerNamespaceId,approvedScheduler.namespaceId);assert.equal(observed.namespaceId,approvedPassword.namespaceId);assert.equal(initial.passwordComputation.namespaceId,null);
 const oldIdentity={...identity,scheduler:approvedScheduler},old=await fixture(t,undefined,oldIdentity);
 await assert.rejects(bootstrap({...args,identity:oldIdentity,bundle:old.bundle,digest:old.digest}),/approval required/);assert.equal(commands.length,1);
 await assert.rejects(bootstrap({...args,identity:passwordIdentity,bundle:old.bundle,digest:old.digest}),/approval mismatch/);assert.equal(commands.length,1);
 await writeFile(checkpoint,JSON.stringify({...intent,schedulerNamespaceId:'f'.repeat(32)}));await assert.rejects(bootstrap({...args,stage:'capture-password-computation'}),/checkpoint mismatch/);await writeFile(checkpoint,JSON.stringify(intent));
 assert.equal((await bootstrap({...args,identity:passwordIdentity})).completed,true);assert.equal(commands.length,3);assert.equal(commands[2][0],'pages');assert.equal((await inspectScheduler(passwordApi(),passwordIdentity)).namespaceId,approvedScheduler.namespaceId);assert.deepEqual(mock.mutations,[]);
});
test('failed password dispatch retains creation intent and blocks a blind retry',async t=>{
 const initial={...passwordIdentity,passwordComputation:{...approvedPassword,namespaceId:null}},{bundle,digest}=await fixture(t,undefined,initial),mock=providerMock();
 const checkpoint=resolve('.provision/bootstrap',`password-computation-${createHash('sha256').update(identity.accountId).digest('hex')}.json`);t.after(async()=>{await rm(checkpoint,{force:true});});let commands=0;
 const fetchImpl=async(url,options)=>{const path=new URL(url).pathname.split(`/accounts/${identity.accountId}/`)[1];if(path?.endsWith('/settings')||path?.includes('/services/')||path?.endsWith('/namespaces')){const value=await passwordApi({present:false})(path);return Response.json(path.endsWith('/namespaces')?{success:true,...value}:{success:true,result:value});}return mock.fetchImpl(url,options);};
 const args={identity:initial,bundle,digest,stage:'deploy',env:{CLOUDFLARE_ACCOUNT_ID:identity.accountId,CLOUDFLARE_API_TOKEN:'cfat_test'},fetchImpl,runner:()=>{commands++;throw Error('synthetic lost dispatch');}};
 await assert.rejects(bootstrap(args),/synthetic lost dispatch/);assert.equal(JSON.parse(await readFile(checkpoint)).state,'creation-intent');await assert.rejects(bootstrap(args),/intent already exists/);assert.equal(commands,1);assert.deepEqual(mock.mutations,[]);
});

import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, readdir, lstat, open } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DEVELOPMENT_REPOSITORY, DEVELOPMENT_RESOURCES, developmentPreflight } from './development-preflight.mjs';
import { deriveHoursProxyKey } from '../packages/shared/src/hours-proxy.ts';
import { buildPagesProxy } from './prepare-pages-proxy.mjs';
import {documentComputeApproval,documentComputeManifest,inspectDocumentCompute} from './document-compute-config.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const requiredSecrets = ['SESSION_KEY', 'INTEGRATION_KEY', 'BOOTSTRAP_CODE_HASH'];
const fail = message => { throw new Error(message); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function localOutput(path) {
  const absolute = resolve(path), root = resolve('.provision');
  if (!absolute.startsWith(root + '/') && !absolute.startsWith(root + '\\')) fail('Output must be inside ignored .provision');
  return absolute;
}
export const HOURS_PROXY_CONFIG = Object.freeze({ protocol: 'hours-proxy-v1', project: 'lancerlogin-v2-example-dashboard', secret: 'HOURS_PROXY_KEY' });
function hoursProxyApproval(identity) {
  const value=identity.hoursProxy;
  if(value===undefined)return null;
  if(!value||Object.keys(value).sort().join(',')!==[...Object.keys(HOURS_PROXY_CONFIG),'keySha256'].sort().join(',')||Object.entries(HOURS_PROXY_CONFIG).some(([k,v])=>value[k]!==v)||!/^[a-f0-9]{64}$/.test(value.keySha256??''))fail('Invalid public Hours proxy approval');
  return value;
}
function hoursProxyManifest(identity,manifest){
  const approved=hoursProxyApproval(identity);
  if(JSON.stringify(manifest.hoursProxy??null)!==JSON.stringify(approved))fail('Public Hours proxy artifact approval mismatch');
  return approved;
}
async function localHoursProxyKey(identity,secretsPath){
  try{const secrets=await json(localOutput(secretsPath));return await deriveHoursProxyKey(secrets.secrets?.SESSION_KEY,'primary',identity.pagesOrigin,identity.apiOrigin);}catch{fail('Saved API session key unavailable or invalid; no secret was generated');}
}
// Local preparation only: the coordinator reviews metadata and separately provisions this one Pages secret.
export async function prepareHoursProxySecret(identity,secretsPath,output){
  const report={repository:identity.repository,mode:'report',resources:identity.resources?.map(r=>({...r,state:'exists'}))};
  validateIdentity(identity,report);
  const secret=await localHoursProxyKey(identity,secretsPath),target=localOutput(output);
  if(identity.hoursProxy&&identity.hoursProxy.keySha256!==hash(secret))fail('Public Hours proxy key rotation requires renewed approval');
  await mkdir(resolve(target,'..'),{recursive:true});
  const created=await open(target,'wx',0o600);await created.close();
  {
    if(process.platform==='win32'){
      try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.FileSecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $acl.AddAccessRule($rule); [System.IO.File]::SetAccessControl($env:LANCERLOGIN_HOURS_SECRET_PATH,$acl)"],{env:{...process.env,LANCERLOGIN_HOURS_SECRET_PATH:target},windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000});}
      catch{fail('Unable to restrict local secret file access; empty file retained, no secret written');}
    }
    if(!(await lstat(target)).isFile())fail('Local secret target changed; no secret written');
    await writeFile(target,secret,{flag:'r+',mode:0o600});
  }
  return {...HOURS_PROXY_CONFIG,keySha256:hash(secret),approval:false};
}
export async function inspectHoursProxy(api,identity,secretsPath='.provision/bootstrap/secrets.json'){
  const approved=hoursProxyApproval(identity),project=await api('pages/projects/'+HOURS_PROXY_CONFIG.project);
  const expected=identity.resources.find(r=>r.kind==='pages'&&r.name===HOURS_PROXY_CONFIG.project);
  const vars=project?.deployment_configs?.production?.env_vars;
  if(!project||project.id!==expected?.id||project.name!==HOURS_PROXY_CONFIG.project||!vars||typeof vars!=='object'||Array.isArray(vars))fail('Malformed exact development Pages settings');
  const binding=vars[HOURS_PROXY_CONFIG.secret];
  if(!approved){if(binding!==undefined)fail('Public Hours proxy approval required; refusing configuration downgrade');return;}
  if(!binding||binding.type!=='secret_text')fail('Approved Pages public Hours secret is missing or has wrong type');
  if(hash(await localHoursProxyKey(identity,secretsPath))!==approved.keySha256)fail('Public Hours proxy key rotation requires renewed approval');
}
export const SCHEDULER_CONFIG = Object.freeze({ worker: 'lancerlogin-v2-example-api', className: 'PlatformScheduler', binding: 'PLATFORM_SCHEDULER', migrationTag: 'platform-scheduler-v1', mode: 'durable' });
export const PASSWORD_COMPUTATION_CONFIG = Object.freeze({ worker: 'lancerlogin-v2-example-api', className: 'PasswordComputation', binding: 'PASSWORD_COMPUTATION', migrationTag: 'password-computation-v1', mode: 'durable' });
function passwordApproval(identity) {
  const value=identity.passwordComputation;if(value===undefined)return null;
  if(!value||Object.keys(value).sort().join(',')!==[...Object.keys(PASSWORD_COMPUTATION_CONFIG),'namespaceId'].sort().join(',')||Object.entries(PASSWORD_COMPUTATION_CONFIG).some(([key,expected])=>value[key]!==expected)||(value.namespaceId!==null&&!/^[a-f0-9]{32}$/.test(value.namespaceId??'')))fail('Invalid password computation approval');
  if(!schedulerApproval(identity)?.namespaceId)fail('Password computation requires an independently pinned existing scheduler');
  return value;
}
function passwordManifest(identity,manifest){const approved=passwordApproval(identity);if(JSON.stringify(manifest.passwordComputation??null)!==JSON.stringify(approved?PASSWORD_COMPUTATION_CONFIG:null))fail('Password computation artifact approval mismatch');return approved;}
function schedulerApproval(identity) {
  const value = identity.scheduler;
  if (value === undefined) return null;
  if (!value || Object.keys(value).sort().join(',') !== [...Object.keys(SCHEDULER_CONFIG), 'namespaceId'].sort().join(',')
    || Object.entries(SCHEDULER_CONFIG).some(([key, expected]) => value[key] !== expected)
    || (value.namespaceId !== null && !/^[a-f0-9]{32}$/.test(value.namespaceId ?? ''))) fail('Invalid scheduler approval');
  return value;
}
function schedulerManifest(identity, manifest) {
  const approved = schedulerApproval(identity);
  if (JSON.stringify(manifest.scheduler ?? null) !== JSON.stringify(approved ? SCHEDULER_CONFIG : null)) fail('Scheduler artifact approval mismatch');
  return approved;
}
// Only fixed endpoints; all pages are checked so an orphaned namespace cannot be missed.
export async function inspectScheduler(api, identity, { capture = false, capturePassword = false } = {}) {
  const approved = schedulerApproval(identity),password=passwordApproval(identity);
  const settings = await api('workers/scripts/lancerlogin-v2-example-api/settings');
  if (!settings || !Array.isArray(settings.bindings) || settings.bindings.some(b => !b || typeof b.name !== 'string' || typeof b.type !== 'string')) fail('Malformed Worker settings');
  const service = await api('workers/services/lancerlogin-v2-example-api');
  const script = service?.default_environment?.script;
  if (!script || script.id !== SCHEDULER_CONFIG.worker || (script.migration_tag != null && typeof script.migration_tag !== 'string')) fail('Malformed scheduler service metadata');
  const namespaces = [];
  let expectedTotal;
  for (let page = 1; ; page++) {
    const response = await api(`workers/durable_objects/namespaces?page=${page}&per_page=100`, 'GET', undefined, true);
    const info = response?.result_info;
    if (!Array.isArray(response?.result) || !info || info.page !== page || info.per_page !== 100
      || !Number.isInteger(info.total_count) || info.total_count < 0 || info.total_count > 10_000
      || !Number.isInteger(info.count) || info.count !== response.result.length
      || info.count !== Math.min(100, Math.max(0, info.total_count - (page - 1) * 100))
      || (expectedTotal !== undefined && expectedTotal !== info.total_count)
      || (info.total_pages !== undefined && (!Number.isInteger(info.total_pages)
        || (info.total_pages !== Math.ceil(info.total_count / 100) && !(info.total_count === 0 && info.total_pages === 1))))
      || response.result.some(n => !n || typeof n.id !== 'string' || typeof n.script !== 'string' || typeof n.class !== 'string' || typeof n.name !== 'string' || !n.name.length)) fail('Malformed scheduler namespace inventory');
    expectedTotal = info.total_count;
    namespaces.push(...response.result);
    if (new Set(namespaces.map(n => n.id)).size !== namespaces.length) fail('Malformed scheduler namespace inventory');
    if (namespaces.length === expectedTotal) break;
  }
  const allOwned = namespaces.filter(n => n.script === SCHEDULER_CONFIG.worker);
  await inspectDocumentCompute(api,identity,settings.bindings,namespaces);
  const passwordOwned=allOwned.filter(n=>n.class===PASSWORD_COMPUTATION_CONFIG.className);
  const passwordBindings=settings.bindings.filter(b=>b.name===PASSWORD_COMPUTATION_CONFIG.binding);
  const passwordModes=settings.bindings.filter(b=>b.name==='PASSWORD_COMPUTATION_MODE');
  const passwordAbsent=!passwordOwned.length&&!passwordBindings.length&&!passwordModes.length;
  if(!password&&(!passwordAbsent||script.migration_tag===PASSWORD_COMPUTATION_CONFIG.migrationTag))fail('Password computation approval required; refusing to remove deployed state');
  let passwordState;
  if(password){
    if(passwordAbsent&&password.namespaceId===null&&!capturePassword&&script.migration_tag===SCHEDULER_CONFIG.migrationTag)passwordState={state:'create'};
    else {
      const n=passwordOwned[0],b=passwordBindings[0],m=passwordModes[0];
      if(passwordOwned.length!==1||passwordBindings.length!==1||passwordModes.length!==1||script.migration_tag!==PASSWORD_COMPUTATION_CONFIG.migrationTag||n.use_sqlite!==true||!/^[a-f0-9]{32}$/.test(n.id)||b.type!=='durable_object_namespace'||b.class_name!==PASSWORD_COMPUTATION_CONFIG.className||b.namespace_id!==n.id||(b.script_name!=null&&b.script_name!==PASSWORD_COMPUTATION_CONFIG.worker)||b.environment!=null||m.type!=='plain_text'||m.text!=='durable'||(password.namespaceId!==null&&password.namespaceId!==n.id))fail('Password computation namespace or migration state mismatch');
      if(password.namespaceId===null&&!capturePassword)fail('Capture and independently approve the created password computation namespace before redeployment');
      passwordState={state:'existing',namespaceId:n.id,namespaceName:n.name};
    }
  }
  const owned = allOwned.filter(n=>!password||n.class!==PASSWORD_COMPUTATION_CONFIG.className);
  const bindings = settings.bindings.filter(b => (b.type === 'durable_object_namespace' || b.name === SCHEDULER_CONFIG.binding) && (!password||b.name!==PASSWORD_COMPUTATION_CONFIG.binding));
  const modes = settings.bindings.filter(b => b.name === 'PLATFORM_SCHEDULER_MODE');
  const absent = !owned.length && !bindings.length && !modes.length && !script.migration_tag;
  if (!approved) {
    if (!absent) fail('Scheduler approval required; refusing to remove deployed state');
    return { state: 'absent' };
  }
  if (approved.namespaceId === null && absent && !capture) return { state: 'create' };
  if (owned.length !== 1 || bindings.length !== 1 || modes.length !== 1 || script.migration_tag !== (passwordState?.state==='existing'?PASSWORD_COMPUTATION_CONFIG.migrationTag:SCHEDULER_CONFIG.migrationTag)
    || owned[0].class !== SCHEDULER_CONFIG.className || owned[0].use_sqlite !== true || !/^[a-f0-9]{32}$/.test(owned[0].id)
    || bindings[0].type !== 'durable_object_namespace' || bindings[0].name !== SCHEDULER_CONFIG.binding || bindings[0].class_name !== SCHEDULER_CONFIG.className
    || (bindings[0].script_name != null && bindings[0].script_name !== SCHEDULER_CONFIG.worker) || bindings[0].environment != null
    || bindings[0].namespace_id !== owned[0].id || modes[0].type !== 'plain_text' || modes[0].text !== 'durable'
    || (approved.namespaceId !== null && approved.namespaceId !== owned[0].id)) fail('Scheduler namespace or migration state mismatch');
  if (approved.namespaceId === null && !capture) fail('Capture and independently approve the created scheduler namespace before redeployment');
  return { state: 'existing', namespaceId: owned[0].id, namespaceName: owned[0].name, ...(passwordState?{passwordComputation:passwordState}:{}) };
}
export function validateIdentity(identity, report) {
  if (identity.repository !== DEVELOPMENT_REPOSITORY || report.repository !== DEVELOPMENT_REPOSITORY || report.mode !== 'report') fail('Development repository/report mismatch');
  if (!/^[a-f0-9]{32}$/.test(identity.accountId ?? '')) fail('Invalid approved account');
  if (identity.resources?.length !== DEVELOPMENT_RESOURCES.length || report.resources?.length !== DEVELOPMENT_RESOURCES.length) fail('Incomplete resource identities');
  for (const target of DEVELOPMENT_RESOURCES) {
    const expected = identity.resources.filter(r => r.kind === target.kind && r.name === target.name);
    const actual = report.resources.filter(r => r.kind === target.kind && r.name === target.name);
    if (expected.length !== 1 || actual.length !== 1 || actual[0].state !== 'exists' || actual[0].id !== expected[0].id) fail('Exact development resource mismatch');
    if (target.kind === 'worker' ? expected[0].id !== target.name : !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expected[0].id)) fail('Invalid resource ID');
  }
  if (!/^https:\/\/lancerlogin-v2-example-api\.[a-z0-9-]+\.workers\.dev$/.test(identity.apiOrigin ?? '') || identity.pagesOrigin !== 'https://lancerlogin-v2-example-dashboard.pages.dev') fail('Development URL mismatch');
  schedulerApproval(identity);
  passwordApproval(identity);
  hoursProxyApproval(identity);
  documentComputeApproval(identity);
  return identity;
}
async function inventory(root, directory = root) {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), stat = await lstat(path);
    if (stat.isSymbolicLink()) fail('Artifact symlinks are forbidden');
    if (stat.isDirectory()) entries.push(...await inventory(root, path));
    else if (stat.isFile()) entries.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: hash(await readFile(path)), bytes: stat.size });
    else fail('Unsupported artifact file');
  }
  return entries;
}
export async function packageBundle({ output, identity, report, sourceCommit, version, apiFile, pagesDirectory, migrationsDirectory }) {
  validateIdentity(identity, report);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^\d+\.\d+\.\d+$/.test(version)) fail('Invalid build metadata');
  output = localOutput(output);
  await mkdir(output); // Never overwrite a reviewed bundle.
  await mkdir(join(output, 'api'));
  await cp(apiFile, join(output, 'api/index.js'));
  await cp(pagesDirectory, join(output, 'pages'), { recursive: true });
  await writeFile(join(output, 'pages/_worker.js'), buildPagesProxy(identity.apiOrigin));
  await cp(migrationsDirectory, join(output, 'migrations'), { recursive: true });
  const files = await inventory(output);
  const migrations = files.filter(f => f.path.startsWith('migrations/')).map(f => f.path);
  if (!migrations.length || migrations.some(p => !/^migrations\/\d+_[a-z0-9_]+\.sql$/.test(p))) fail('Invalid migration inventory');
  const manifest = { format: 1, purpose: 'initial-development-bootstrap', repository: DEVELOPMENT_REPOSITORY, sourceCommit, version,
    compatibilityDate: '2026-08-01', schema: { baseline: 'fresh-database-only', migrations },
    telemetryEndpoint: null, updateSource: null, apiOrigin: identity.apiOrigin, pagesOrigin: identity.pagesOrigin, files, ...(documentComputeApproval(identity)?{documentCompute:documentComputeApproval(identity)}:{}), ...(hoursProxyApproval(identity)?{hoursProxy:hoursProxyApproval(identity)}:{}), ...(schedulerApproval(identity) ? { scheduler: SCHEDULER_CONFIG } : {}), ...(passwordApproval(identity)?{passwordComputation:PASSWORD_COMPUTATION_CONFIG}:{}) };
  await save(join(output, 'manifest.json'), manifest);
  return { manifestSha256: hash(await readFile(join(output, 'manifest.json'))), files: files.length };
}
export async function verifyBundle(directory, digest, identity) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '') || hash(await readFile(join(directory, 'manifest.json'))) !== digest) fail('Manifest digest mismatch');
  const manifest = await json(join(directory, 'manifest.json'));
  if (manifest.format !== 1 || manifest.purpose !== 'initial-development-bootstrap' || manifest.repository !== DEVELOPMENT_REPOSITORY || manifest.apiOrigin !== identity.apiOrigin || manifest.pagesOrigin !== identity.pagesOrigin || manifest.telemetryEndpoint !== null || manifest.updateSource !== null || manifest.schema?.baseline !== 'fresh-database-only' || manifest.compatibilityDate !== '2026-08-01') fail('Bundle compatibility or destination mismatch');
  schedulerManifest(identity, manifest);
  passwordManifest(identity,manifest);
  hoursProxyManifest(identity, manifest);
  documentComputeManifest(identity,manifest);
  const actual = (await inventory(directory)).filter(f => f.path !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) fail('Artifact digest or inventory mismatch');
  if (!actual.some(f => f.path === 'api/index.js') || !actual.some(f => f.path === 'pages/index.html') || !actual.some(f => f.path === 'pages/_worker.js')) fail('Incomplete deploy artifacts');
  return manifest;
}
export function buildDevelopmentConfig(identity, manifest, bundle) {
  const scheduler = schedulerManifest(identity, manifest),password=passwordManifest(identity,manifest),compute=documentComputeManifest(identity,manifest);
  const classes=[...(scheduler?[SCHEDULER_CONFIG]:[]),...(password?[PASSWORD_COMPUTATION_CONFIG]:[])];
  return { ...(scheduler ? { durable_objects: { bindings: classes.map(c=>({name:c.binding,class_name:c.className})) }, migrations: classes.map(c=>({tag:c.migrationTag,new_sqlite_classes:[c.className]})) } : {}), name: 'lancerlogin-v2-example-api', account_id: identity.accountId, main: join(bundle, 'api/index.js'),
    compatibility_date: manifest.compatibilityDate, workers_dev: true, keep_vars: false,
    ...(compute?{services:[{binding:'DOCUMENT_COMPUTE',service:compute.worker}]}:{}),
    vars: { APP_MODE: 'configured', ALLOWED_ORIGIN: identity.pagesOrigin, RELEASE_VERSION: manifest.version, ...(compute?.proofMode==='synthetic'?{DOCUMENT_COMPUTE_PROOF_MODE:'synthetic'}:{}), ...(scheduler ? { PLATFORM_SCHEDULER_MODE: 'durable' } : {}),...(password?{PASSWORD_COMPUTATION_MODE:'durable'}:{}) },
    // Initial P0 has no provider jobs; scheduler acceptance belongs to the platform phase.
    triggers: { crons: [] },
    d1_databases: [{ binding: 'DB', database_name: 'lancerlogin-v2-example-data', database_id: identity.resources.find(r => r.name === 'lancerlogin-v2-example-data').id, migrations_dir: join(bundle, 'migrations') }] };
}
export async function prepareSecrets(path, existingNames) {
  if (!Array.isArray(existingNames) || existingNames.some(n => typeof n !== 'string')) fail('Malformed secret inventory');
  const missing = requiredSecrets.filter(n => !existingNames.includes(n));
  if (!missing.length) return { secrets: {}, generated: false };
  path = localOutput(path);
  let saved;
  try { saved = await json(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!saved) {
    const setupCode = randomBytes(24).toString('base64url');
    saved = { setupCode, secrets: { SESSION_KEY: randomBytes(32).toString('base64url'), INTEGRATION_KEY: randomBytes(32).toString('base64url'), BOOTSTRAP_CODE_HASH: createHash('sha256').update(setupCode).digest('base64url') } };
    await writeFile(path, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
  }
  if (requiredSecrets.some(n => !/^[A-Za-z0-9_-]{43}$/.test(saved.secrets?.[n] ?? ''))) fail('Invalid saved bootstrap secrets');
  return { secrets: Object.fromEntries(missing.map(n => [n, saved.secrets[n]])), generated: true };
}
function runWrangler(args, env, input) {
  const cli = resolve('node_modules/wrangler/bin/wrangler.js');
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].includes(name.toUpperCase())));
  Object.assign(childEnv, { CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'none', WRANGLER_LOG_SANITIZE: 'true',
    // Wrangler writes debug logs even at log=none. A null device prevents durable provider logs.
    WRANGLER_LOG_PATH: process.platform === 'win32' ? resolve('.provision/bootstrap/NUL.log') : '/dev/null/wrangler.log' });
  try { execFileSync(process.execPath, [cli, ...args], { input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000, env: childEnv, maxBuffer: 8 * 1024 * 1024 }); }
  catch { fail('Wrangler operation failed; raw provider output suppressed'); }
}
export async function bootstrap({ identity, bundle, digest, stage, env = process.env, fetchImpl = fetch, runner = runWrangler }) {
  if (!['prepare', 'migrate-fresh', 'deploy', 'capture-scheduler', 'capture-password-computation'].includes(stage)) fail('Unsupported bootstrap stage');
  // Fresh provider inventory on EVERY stage, before writing config or invoking a deployment command.
  const report = await developmentPreflight({ repository: identity.repository, expectedAccountId: identity.accountId, env, fetchImpl });
  validateIdentity(identity, report);
  bundle = resolve(bundle);
  const manifest = await verifyBundle(bundle, digest, identity);
  const api = async (path, method = 'GET', body, envelope = false) => {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error();
      return envelope ? result : result.result;
    } catch { fail('Development provider operation failed; output suppressed'); }
  };
  const subdomain = await api('workers/subdomain');
  if (identity.apiOrigin !== `https://lancerlogin-v2-example-api.${subdomain?.subdomain}.workers.dev`) fail('Account Worker URL does not match approved origin');
  await inspectHoursProxy(api,identity);
  await mkdir('.provision/bootstrap', { recursive: true });
  const scheduler = await inspectScheduler(api, identity, { capture: stage === 'capture-scheduler',capturePassword:stage==='capture-password-computation' });
  const checkpoint = resolve('.provision/bootstrap', `scheduler-${hash(identity.accountId)}.json`);
  const password=scheduler.passwordComputation;
  const passwordCheckpoint=resolve('.provision/bootstrap',`password-computation-${hash(identity.accountId)}.json`);
  if(stage==='capture-password-computation'){
    if(!identity.passwordComputation||password?.state!=='existing')fail('No created password computation namespace to capture');
    let intent;try{intent=await json(passwordCheckpoint);}catch{fail('Password computation creation checkpoint is unavailable; reconcile before capture');}
    const expected={accountId:identity.accountId,...PASSWORD_COMPUTATION_CONFIG,schedulerNamespaceId:scheduler.namespaceId,manifestSha256:digest,state:'creation-intent'};
    if(!intent||Object.keys(intent).sort().join(',')!==Object.keys(expected).sort().join(',')||Object.entries(expected).some(([key,value])=>intent[key]!==value))fail('Password computation creation checkpoint mismatch');
    await save(passwordCheckpoint+'.observed.json',{accountId:identity.accountId,...PASSWORD_COMPUTATION_CONFIG,...password,schedulerNamespaceId:scheduler.namespaceId,useSqlite:true,manifestSha256:digest,approval:false});
    return {stage,verified:true,approvalRequired:true};
  }
  if(password?.state==='create'){
    try{await readFile(passwordCheckpoint);fail('Password computation creation intent already exists; reconcile before any retry');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(stage==='migrate-fresh')fail('Password computation requires an initialized database and pinned existing scheduler');
  }
  if (stage === 'capture-scheduler') {
    if (!identity.scheduler || scheduler.state !== 'existing') fail('No created scheduler to capture');
    await save(checkpoint + '.observed.json', { accountId: identity.accountId, ...SCHEDULER_CONFIG, ...scheduler, useSqlite: true, manifestSha256: digest, approval: false });
    return { stage, verified: true, approvalRequired: true };
  }
  if (scheduler.state === 'create') {
    try { await readFile(checkpoint); fail('Scheduler creation intent already exists; reconcile before any retry'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stage === 'migrate-fresh') fail('Scheduler creation requires a separately initialized database');
  }
  const config = resolve('.provision/bootstrap/wrangler.json');
  await save(config, buildDevelopmentConfig(identity, manifest, bundle));
  if (stage === 'prepare') return { stage, verified: true };
  const db = identity.resources.find(r => r.name === 'lancerlogin-v2-example-data').id;
  if (stage === 'migrate-fresh') {
    const results = await api(`d1/database/${db}/query`, 'POST', { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" });
    if (!Array.isArray(results) || results.length !== 1 || results[0].success !== true || !Array.isArray(results[0].results) || results[0].results.length) fail('Initial migration requires an empty development database; inspect partial migrations before resuming');
    runner(['d1', 'migrations', 'apply', 'lancerlogin-v2-example-data', '--remote', '--config', config], env);
  } else {
    // P0 supports only this exact schema, not forward/backward migration compatibility.
    const schema = await api(`d1/database/${db}/query`, 'POST', { sql: 'SELECT name FROM d1_migrations ORDER BY id' });
    const expectedMigrations = manifest.schema.migrations.map(path => path.slice('migrations/'.length));
    if (!Array.isArray(schema) || schema.length !== 1 || schema[0].success !== true || !Array.isArray(schema[0].results)
      || JSON.stringify(schema[0].results.map(row => row?.name)) !== JSON.stringify(expectedMigrations)) {
      fail('Development database migration ledger does not exactly match the reviewed bundle');
    }
    const current = await api('workers/scripts/lancerlogin-v2-example-api/secrets');
    if (!Array.isArray(current) || current.some(s => s.type !== 'secret_text' || typeof s.name !== 'string')) fail('Malformed Worker secret inventory');
    const prepared = await prepareSecrets('.provision/bootstrap/secrets.json', current.map(s => s.name));
    // Upload only missing values; never rotate or delete existing remote secrets.
    for (const [name, text] of Object.entries(prepared.secrets)) {
      const latest = await api('workers/scripts/lancerlogin-v2-example-api/secrets');
      if (!Array.isArray(latest)) fail('Malformed Worker secret inventory');
      if (!latest.some(s => s.name === name)) await api('workers/scripts/lancerlogin-v2-example-api/secrets', 'PUT', { name, text, type: 'secret_text' });
    }
    await verifyBundle(bundle, digest, identity);
    // Recheck immediately before upload. Bootstrap is exclusive, not a distributed deployment lock.
    await inspectHoursProxy(api,identity);
    await inspectScheduler(api, identity);
    if (scheduler.state === 'create') await writeFile(checkpoint, JSON.stringify({ accountId: identity.accountId, worker: SCHEDULER_CONFIG.worker, manifestSha256: digest, state: 'creation-intent' }), { flag: 'wx', mode: 0o600 });
    if(password?.state==='create'){
      const file=await open(passwordCheckpoint,'wx',0o600);
      try{await file.writeFile(JSON.stringify({accountId:identity.accountId,...PASSWORD_COMPUTATION_CONFIG,schedulerNamespaceId:identity.scheduler.namespaceId,manifestSha256:digest,state:'creation-intent'}));await file.sync();}finally{await file.close();}
    }
    runner(['deploy', '--no-bundle', '--config', config], env);
    if(password?.state==='create')return {stage,completed:false,passwordComputationCaptureRequired:true,manifestSha256:digest};
    if (scheduler.state === 'create') return { stage, completed: false, schedulerCaptureRequired: true, manifestSha256: digest };
    await inspectHoursProxy(api,identity);
    await inspectScheduler(api, identity);
    await verifyBundle(bundle, digest, identity);
    runner(['pages', 'deploy', join(bundle, 'pages'), '--project-name', 'lancerlogin-v2-example-dashboard', '--branch', 'main', '--commit-hash', manifest.sourceCommit, '--commit-dirty=true', '--no-bundle'], env);
  }
  return { stage, completed: true, manifestSha256: digest };
}
async function main() {
  const [stage, identityPath, bundlePath, digest] = process.argv.slice(2);
  if (!identityPath || !bundlePath) fail('Usage: development-bundle.mjs build|prepare|migrate-fresh|deploy|capture-scheduler|capture-password-computation identity.json .provision/bundle [reviewed-manifest-sha256]');
  const identity = await json(identityPath);
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  if (![ `https://github.com/${DEVELOPMENT_REPOSITORY}.git`, `git@github.com:${DEVELOPMENT_REPOSITORY}.git` ].includes(remote)) fail('Wrong checkout repository');
  if (stage === 'build') {
    const report = await json(identity.reportPath);
    validateIdentity(identity, report);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
    if (status.trim()) fail('Commit tracked changes before packaging');
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // Build tools use only locally installed lockfile dependencies. No source fetch.
    const staging = localOutput(`.provision/build-${randomBytes(8).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    const { build } = await import('esbuild');
    await build({ entryPoints: ['apps/api/src/index.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: join(staging, 'api.js') });
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/dashboard/tsconfig.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', join(staging, 'pages')], { cwd: resolve('apps/dashboard'), env: { ...process.env, VITE_API_BASE_URL: '/api', VITE_DISABLE_PUBLIC_UPDATES: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return packageBundle({ output: bundlePath, identity, report, sourceCommit, version: (await json('package.json')).version, apiFile: join(staging, 'api.js'), pagesDirectory: join(staging, 'pages'), migrationsDirectory: 'apps/api/migrations' });
  }
  return bootstrap({ stage, identity, bundle: bundlePath, digest });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Development bootstrap failed; check approved identities, artifact digest, stage prerequisites and secure credential setup. Raw output suppressed.'); process.exitCode = 1; });

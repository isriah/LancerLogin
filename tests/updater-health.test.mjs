import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createApplicationVerifier, sha256, signedBytes } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
import { createArtifactStore, ARTIFACT_CHUNK_BYTES } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createPostDeploymentHealth, createHealthAdapters } from '../apps/updater/src/health.mjs';

const utf8 = new TextEncoder(), json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const provider = value => json({ success: true, result: value });
function d1(db) { return { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { results: db.prepare(sql).all(...args) }; } }; } }; }
async function setup() {
  const updater = new DatabaseSync(':memory:'), app = new DatabaseSync(':memory:');
  updater.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql', import.meta.url), 'utf8'));
  app.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO d1_migrations VALUES(1,'0001_synthetic.sql')");
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const trust = { product: 'LancerLogin', channel: 'development', keyId: 'synthetic', repository: { id: 1, owner: 'synthetic', name: 'health' }, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)) };
  const pagesFiles = [{ path: '_worker.js', bytes: utf8.encode('export default {}') }, { path: 'app.js', bytes: utf8.encode('document.title="Synthetic";') }, { path: 'index.html', bytes: utf8.encode('<script src="/app.js"></script>') }];
  const files = new Map([['api.mjs', utf8.encode('export default {fetch(){return new Response("synthetic")}}')], ['dashboard.tar', packDashboard(pagesFiles)], ['0001_synthetic.sql', utf8.encode('CREATE TABLE synthetic(id INTEGER);')]]);
  const artifacts = await Promise.all([...files].map(async ([name, bytes]) => ({ role: name.endsWith('.tar') ? 'dashboard' : name.endsWith('.sql') ? 'migration' : 'api', name, bytes: bytes.length, sha256: await sha256(bytes) })));
  const migration = artifacts.find(artifact => artifact.role === 'migration');
  const manifest = { format: 1, kind: 'application', product: trust.product, channel: trust.channel, keyId: trust.keyId, repository: trust.repository, sequence: 2, version: '2.0.0', sourceCommit: 'b'.repeat(40), minimumUpdaterVersion: '1.0.0', compatibility: { installedVersion: { min: '1.0.0', max: '2.0.0' }, installedSchema: { min: 0, max: 1 }, apiVersion: 1, apiSchema: { min: 0, max: 2 }, frontendApi: { min: 1, max: 1 } }, targetSchema: 1, codeRollback: 'compatible', artifacts, migrations: [{ id: migration.name, artifact: migration.name, sha256: migration.sha256, fromSchema: 0, toSchema: 1 }] };
  const manifestBytes = utf8.encode(JSON.stringify(manifest)), signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, signedBytes(manifestBytes))), digest = await sha256(manifestBytes);
  const pins = { installationId: 'synthetic-install', accountId: 'a'.repeat(32), worker: 'synthetic-api', pagesProject: 'synthetic-pages', productionBranch: 'main', applicationDatabaseId: '11111111-1111-4111-8111-111111111111', apiOrigin: 'https://synthetic-api.example.invalid', dashboardOrigin: 'https://synthetic-pages.example.invalid' };
  const state = { mode: 'update', healthOperationId: crypto.randomUUID(), apiOperationId: crypto.randomUUID(), pagesOperationId: crypto.randomUUID(), schema: 1, ledger: [{ id: migration.name, sha256: migration.sha256 }] };
  const apiVersionId = '22222222-2222-4222-8222-222222222222';
  const store = createArtifactStore({ database: d1(updater), installationId: pins.installationId, cipher: await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)), pins.installationId) });
  await store.claim(state.apiOperationId, { kind: 'api', digest, receipt: { manifestSha256: digest, versionId: apiVersionId, deploymentId: 'api-deployment' } });
  await store.claim(state.pagesOperationId, { kind: 'pages', digest, receipt: { manifestSha256: digest, deploymentId: 'pages-deployment' } });
  const archive = files.get('dashboard.tar'), archiveId = `${digest}:dashboard.tar`;
  await store.begin({ artifactId: archiveId, bytes: archive.length, digest: await sha256(archive) });
  for (let offset = 0; offset < archive.length; offset += ARTIFACT_CHUNK_BYTES) await store.writeChunk(archiveId, offset / ARTIFACT_CHUNK_BYTES, archive.slice(offset, offset + ARTIFACT_CHUNK_BYTES));
  await store.seal(archiveId);
  const controls = { staleApi: false, badAsset: false, drift: false, unavailable: false }, calls = [];
  const health = createPostDeploymentHealth({ pins, token: 'synthetic-readonly-cloudflare-token', verifier: createApplicationVerifier(trust), store, readTrustedState: async () => structuredClone(state), fetch: async (url, options) => {
    const parsed = new URL(url); calls.push({ url, method: options.method });
    assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
    if (controls.unavailable) { controls.unavailable = false; return new Response(null, { status: 503 }); }
    if (parsed.origin === 'https://api.cloudflare.com') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-readonly-cloudflare-token');
      assert.ok(parsed.pathname.includes(pins.accountId));
      if (parsed.pathname.endsWith('/deployments')) return provider({ deployments: [{ id: 'api-deployment', versions: [{ version_id: apiVersionId, percentage: 100 }] }] });
      if (parsed.pathname.includes('/versions/')) return provider({ id: apiVersionId, annotations: { 'workers/message': `LancerLogin updater ${state.apiOperationId} ${digest}` } });
      if (parsed.pathname.endsWith('/synthetic-pages')) return provider({ name: pins.pagesProject, production_branch: pins.productionBranch, canonical_deployment: { id: controls.drift ? 'changed-deployment' : 'pages-deployment', environment: 'production', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { branch: pins.productionBranch, commit_hash: manifest.sourceCommit, commit_message: `LancerLogin updater ${state.pagesOperationId} ${digest}` } } } });
      if (parsed.pathname.endsWith('/content/v2')) return new Response(files.get('api.mjs'));
      if (parsed.pathname.endsWith('/query')) {
        assert.ok(parsed.pathname.includes(pins.applicationDatabaseId));
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { sql: 'SELECT name FROM d1_migrations ORDER BY id' });
        return provider([{ success: true, results: app.prepare('SELECT name FROM d1_migrations ORDER BY id').all() }]);
      }
    } else {
      assert.equal(options.headers.Authorization, undefined);
      assert.ok([pins.apiOrigin, pins.dashboardOrigin].includes(parsed.origin));
      if (['/health', '/api/health'].includes(parsed.pathname)) return json({ ok: true, service: 'lancerlogin-api', mode: 'ready', releaseVersion: controls.staleApi ? '1.0.0' : '2.0.0' });
      const path = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
      const file = pagesFiles.find(file => file.path === path);
      if (file && path !== '_worker.js') return new Response(controls.badAsset ? utf8.encode('wrong') : file.bytes);
    }
    throw Error('unexpected synthetic endpoint');
  } });
  const release = await health.verifyRelease(manifestBytes, signatureBytes);
  const request = { installationId: pins.installationId, operationId: state.healthOperationId, release };
  return { updater, app, store, health, request, controls, calls, state,
    async run() { for (let i = 0; i < 15; i++) { const result = await health.advance(request); if (result.outcome !== 'pending') return result; } throw Error('step budget'); },
    async until(phase) { for (let i = 0; i < 15; i++) { const row = await store.operation(state.healthOperationId); if (row?.value.phase === phase) return; assert.equal((await health.advance(request)).outcome, 'pending'); } throw Error('step budget'); },
    close() { updater.close(); app.close(); },
  };
}

test('health verifies actual code, proxy/version, ordered D1 ledger and every public signed asset', async () => {
  const f = await setup();
  try {
    const result = await f.run();
    assert.equal(result.outcome, 'applied');
    assert.equal(result.receipt.version, '2.0.0'); assert.equal(result.receipt.schema, 1);
    assert.equal(result.receipt.publicFilesVerified, 2);
    assert.equal(f.calls.filter(call => call.url.endsWith('/content/v2')).length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/query')).length, 2);
    assert.ok(f.calls.some(call => call.url.endsWith('/api/health')));
    assert.equal(f.calls.filter(call => call.url.endsWith('/_worker.js')).length, 0);
    assert.ok(f.calls.every(call => call.method === 'GET' || call.url.endsWith('/query')));
  } finally { f.close(); }
});

test('health rejects stale API version and observed migration ledger mismatch', async () => {
  for (const kind of ['api', 'ledger']) {
    const f = await setup();
    try {
      if (kind === 'api') f.controls.staleApi = true;
      else f.app.exec("UPDATE d1_migrations SET name='0001_wrong.sql'");
      const result = await f.run();
      assert.equal(result.outcome, 'failed');
      assert.equal(result.code, kind === 'api' ? 'health-api-version' : 'health-migration-ledger-mismatch');
    } finally { f.close(); }
  }
});

test('asset tampering and deployment drift during the scan cannot produce success', async () => {
  for (const kind of ['asset', 'deployment']) {
    const f = await setup();
    try {
      await f.until(kind === 'asset' ? 'assets' : 'final');
      if (kind === 'asset') f.controls.badAsset = true;
      else f.controls.drift = true;
      const result = await f.run();
      assert.equal(result.outcome, 'failed');
      assert.equal(result.code, kind === 'asset' ? 'health-dashboard-asset' : 'health-pages-deployment');
    } finally { f.close(); }
  }
});

test('unknown reads safely resume through engine reconciliation glue; forged contexts fail before fetch', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.health.advance({ ...f.request, apiOrigin: 'https://wrong.invalid' }), /health-request/);
    await assert.rejects(f.health.advance({ ...f.request, release: structuredClone(f.request.release) }), /health-untrusted-context/);
    assert.equal(f.calls.length, 0);
    f.controls.unavailable = true;
    const adapters = createHealthAdapters({ health: f.health, installationId: f.request.installationId, resolveRelease: () => f.request.release, fallback: { continueOperation() { throw Error('wrong continuation'); }, reconcile() { throw Error('wrong reconciliation'); } } });
    const context = { kind: 'health', operationId: f.request.operationId };
    assert.equal((await adapters.health(context)).outcome, 'unknown');
    assert.equal((await adapters.reconcile(context)).outcome, 'pending');
    assert.equal((await adapters.continueOperation(context)).outcome, 'pending');
    assert.equal((await f.run()).outcome, 'applied');
  } finally { f.close(); }
});

test('healthy code-only recovery verifies the newer retained database ledger', async () => {
  const f = await setup();
  try {
    f.state.mode = 'code-recovery'; f.state.schema = 2;
    f.state.ledger.push({ id: '0002_newer.sql', sha256: 'c'.repeat(64) });
    f.app.exec("INSERT INTO d1_migrations VALUES(2,'0002_newer.sql')");
    assert.equal(f.request.release.manifest.targetSchema, 1);
    const result = await f.run();
    assert.equal(result.outcome, 'applied');
    assert.equal(result.receipt.schema, 2);
    assert.equal(result.receipt.version, '2.0.0');
  } finally { f.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createApplicationVerifier, signedBytes, sha256 } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createArtifactStore, ARTIFACT_CHUNK_BYTES } from '../apps/updater/src/artifact-store.mjs';
import { createCloudflareCodeTransport, createCloudflareCodeAdapters, pagesAssetHash } from '../apps/updater/src/cloudflare-code.mjs';
import { createUpdaterStore } from '../apps/updater/src/store.mjs';
import { createUpdaterEngine } from '../apps/updater/src/engine.mjs';

const utf8 = new TextEncoder();
const response = result => new Response(JSON.stringify({ success: true, result }), { headers: { 'Content-Type': 'application/json' } });
function d1(sqlite, stats = { count: 0 }) {
  return { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { stats.count++; return sqlite.prepare(sql).get(...args) ?? null; }, async all() { stats.count++; return { results: sqlite.prepare(sql).all(...args) }; } }; } };
}
async function setup({ largePages = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const migration of ['0001_updater_state.sql', '0002_updater_artifacts.sql']) db.exec(readFileSync(new URL(`../apps/updater/state/${migration}`, import.meta.url), 'utf8'));
  const cipher = await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)), 'synthetic-install');
  const stats = { count: 0 }, database = d1(db, stats);
  const artifactStore = createArtifactStore({ database, installationId: 'synthetic-install', cipher });
  const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const trust = { product: 'LancerLogin', channel: 'development', keyId: 'synthetic', repository: { id: 1, owner: 'synthetic', name: 'release' }, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey)) };
  const pins = { installationId: 'synthetic-install', accountId: 'a'.repeat(32), worker: 'synthetic-api', pagesProject: 'synthetic-pages', productionBranch: 'main', applicationDatabaseId: '11111111-1111-4111-8111-111111111111', workerSettings: { compatibility_date: '2026-09-04', compatibility_flags: [] }, nonsecretBindings: [{ name: 'DB', type: 'd1', id: '11111111-1111-4111-8111-111111111111' }, { name: 'CONFIG', type: 'plain_text', text: 'synthetic-only' }, { name: 'RELEASE_VERSION', type: 'plain_text', text: '1.0.0' }] };
  const fixtures = new Map();
  for (const sequence of [1, 2]) {
    const files = new Map([['api.mjs', utf8.encode(`export default {fetch(){return new Response('synthetic ${sequence}')}};`)], ['dashboard.tar', packDashboard([{ path: '_worker.js', bytes: utf8.encode('export default {fetch(request,env){return env.ASSETS.fetch(request)}}') }, { path: 'index.html', bytes: utf8.encode(`<p>Synthetic ${sequence}</p>`) }])]]);
    if (largePages && sequence === 2) files.set('dashboard.tar', packDashboard([{ path: '_worker.js', bytes: new Uint8Array(8388608).fill(32) }, { path: 'index.html', bytes: new Uint8Array(8386560).fill(32) }]));
    const artifacts = await Promise.all([...files].map(async ([name, bytes]) => ({ role: name.endsWith('.tar') ? 'dashboard' : 'api', name, bytes: bytes.length, sha256: await sha256(bytes) })));
    const manifest = { format: 1, kind: 'application', product: trust.product, channel: trust.channel, keyId: trust.keyId, repository: trust.repository, sequence, version: `${sequence}.0.0`, sourceCommit: String(sequence).repeat(40), minimumUpdaterVersion: '1.0.0', compatibility: { installedVersion: { min: '1.0.0', max: '9.0.0' }, installedSchema: { min: 0, max: 0 }, apiVersion: 1, apiSchema: { min: 0, max: 0 }, frontendApi: { min: 1, max: 1 } }, targetSchema: 0, codeRollback: 'compatible', artifacts, migrations: [] };
    const manifestBytes = utf8.encode(JSON.stringify(manifest)), signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', signing.privateKey, signedBytes(manifestBytes)));
    fixtures.set(sequence, { manifestBytes, signatureBytes, files, manifest });
  }
  const calls = [], controls = { loseAsset: false, losePages: false, loseApi: false, redirect: false }, hashes = new Set();
  let apiBytes = fixtures.get(1).files.get('api.mjs'), releaseVersion = '1.0.0';
  let apiVersion = { id: '22222222-2222-4222-8222-222222222222', annotations: {} };
  let apiDeployment = { id: 'synthetic-api-prior', versions: [{ version_id: apiVersion.id, percentage: 100 }] };
  let pageDeployment = { id: 'synthetic-pages-prior', environment: 'production', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: '1'.repeat(40), branch: 'main', commit_message: `LancerLogin updater ${crypto.randomUUID()} ${await sha256(fixtures.get(1).manifestBytes)}` } } };
  const projectConfiguration = { env_vars: { PRIVATE_PROXY: { type: 'secret_text', value: 'synthetic-provider-secret' } }, compatibility_date: '2026-09-04' };
  async function fetcher(url, options) {
    const path = new URL(url).pathname.replace('/client/v4', ''), method = options.method;
    calls.push({ path, method, authorization: options.headers.Authorization });
    assert.equal(new URL(url).origin, 'https://api.cloudflare.com');
    assert.equal(options.redirect, 'manual');
    if (controls.redirect) return new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/private' } });
    if (path.endsWith('/settings')) return response({ ...pins.workerSettings, bindings: [...pins.nonsecretBindings.map(binding => binding.name === 'RELEASE_VERSION' ? { ...binding, text: releaseVersion } : binding), { name: 'SESSION_SECRET', type: 'secret_text' }] });
    if (path.includes('/versions/')) return response(apiVersion);
    if (path.endsWith('/versions')) return response({ items: [apiVersion] });
    if (path.endsWith('/content/v2')) return new Response(apiBytes, { headers: { 'Content-Type': 'application/javascript' } });
    if (path.endsWith('/synthetic-api/deployments')) return response({ deployments: [apiDeployment] });
    if (path.endsWith('/synthetic-api') && method === 'PUT') {
      const metadata = JSON.parse(options.body.get('metadata'));
      assert.deepEqual(metadata.keep_bindings, ['secret_text', 'secret_key']);
      releaseVersion = metadata.bindings.find(binding => binding.name === 'RELEASE_VERSION').text;
      assert.deepEqual(metadata.bindings, pins.nonsecretBindings.map(binding => binding.name === 'RELEASE_VERSION' ? { ...binding, text: releaseVersion } : binding));
      assert.equal(metadata.keep_assets, true);
      assert.equal(metadata.compatibility_date, pins.workerSettings.compatibility_date);
      assert.equal(metadata.bindings.some(binding => binding.name === 'SESSION_SECRET'), false);
      apiVersion = { id: '33333333-3333-4333-8333-333333333333', annotations: metadata.annotations };
      apiDeployment = { id: 'synthetic-api-next', versions: [{ version_id: apiVersion.id, percentage: 100 }] };
      apiBytes = new Uint8Array(await options.body.get('api.mjs').arrayBuffer());
      if (controls.loseApi) { controls.loseApi = false; throw Error('synthetic acknowledgment lost'); }
      return response({ id: pins.worker });
    }
    if (path.endsWith('/upload-token')) return response({ jwt: 'synthetic-project-upload-token' });
    if (path === '/pages/assets/upload') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-project-upload-token');
      for (const entry of JSON.parse(options.body)) { hashes.add(entry.key); assert.equal(entry.base64, true); }
      if (controls.loseAsset) { controls.loseAsset = false; throw Error('synthetic asset acknowledgment lost'); }
      return response(null);
    }
    if (path === '/pages/assets/check-missing') return response(JSON.parse(options.body).hashes.filter(hash => !hashes.has(hash)));
    if (path.endsWith('/synthetic-pages/deployments') && method === 'POST') {
      assert.ok(options.body.get('_worker.js') instanceof Blob);
      assert.equal(options.body.has('env_vars'), false);
      const manifest = JSON.parse(options.body.get('manifest'));
      assert.deepEqual(Object.keys(manifest), ['/index.html']);
      assert.ok(hashes.has(manifest['/index.html']));
      pageDeployment = { id: 'synthetic-pages-next', environment: 'production', latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: options.body.get('commit_hash'), commit_message: options.body.get('commit_message'), branch: options.body.get('branch') } } };
      if (controls.losePages) { controls.losePages = false; throw Error('synthetic deployment acknowledgment lost'); }
      return response(pageDeployment);
    }
    if (path.endsWith('/synthetic-pages/deployments')) return response([pageDeployment]);
    if (path.endsWith('/synthetic-pages')) return response({ name: pins.pagesProject, source: null, production_branch: pins.productionBranch, canonical_deployment: pageDeployment, deployment_configs: { production: projectConfiguration } });
    throw Error(`Unexpected synthetic endpoint ${path}`);
  }
  const transport = createCloudflareCodeTransport({ pins, token: 'synthetic-provider-token', verifier: createApplicationVerifier(trust), store: artifactStore, fetch: fetcher });
  const releases = new Map();
  for (const [number, fixture] of fixtures) releases.set(number, await transport.verifyRelease(fixture.manifestBytes, fixture.signatureBytes));
  const args = (number = 2, operationId = crypto.randomUUID()) => ({ installationId: pins.installationId, release: releases.get(number), operationId });
  async function stageAll(number) {
    for (const [name, bytes] of fixtures.get(number).files) {
      const request = { ...args(number), name, bytes };
      for (let i = 0; i < 10; i++) { if ((await transport.stage(request)).outcome === 'applied') break; }
    }
  }
  return { get releaseVersion() { return releaseVersion; }, db, database, stats, cipher, artifactStore, transport, args, fixtures, releases, stageAll, calls, controls, trust, pins };
}

test('encrypted artifact chunks survive reconstruction, bind commitments and reject tampering', async () => {
  const f = await setup();
  try {
    const bytes = Uint8Array.from({ length: ARTIFACT_CHUNK_BYTES * 2 + 17 }, (_, i) => i % 251), id = 'synthetic:large';
    await f.artifactStore.begin({ artifactId: id, bytes: bytes.length, digest: await sha256(bytes) });
    for (let index = 0; index < 3; index++) await f.artifactStore.writeChunk(id, index, bytes.slice(index * ARTIFACT_CHUNK_BYTES, (index + 1) * ARTIFACT_CHUNK_BYTES));
    await assert.rejects(f.artifactStore.read(id), /unsealed/);
    await f.artifactStore.seal(id);
    const reopened = createArtifactStore({ database: d1(f.db), installationId: f.pins.installationId, cipher: f.cipher });
    assert.deepEqual(await reopened.read(id), bytes);
    const rows = f.db.prepare('SELECT envelope FROM updater_artifact_chunks').all();
    assert.ok(rows.every(row => row.envelope.length < 180000));
    f.db.prepare("UPDATE updater_artifact_chunks SET sha256=? WHERE artifact_id=? AND chunk_index=0").run('0'.repeat(64), id);
    await assert.rejects(reopened.read(id), /checkpoint-integrity/);
  } finally { f.db.close(); }
});

test('portable Pages hash matches BLAKE3 empty and Wrangler multi-chunk vectors', () => {
  assert.equal(pagesAssetHash(new Uint8Array(), ''), 'af1349b9f5f9a1a6a0404dea36dcc949');
  assert.equal(pagesAssetHash(Uint8Array.from({ length: 2049 }, (_, i) => i % 251), 'main.js'), '3d7900d946fab18a00eb3c7fc5b16190');
});

test('signed context/resource checks precede fetch; Worker lost acknowledgment reconciles once', async () => {
  const f = await setup();
  try {
    const args = { ...f.args(), priorRelease: f.releases.get(1) };
    await assert.rejects(f.transport.deployApi({ ...args, installationId: 'wrong' }), /untrusted-context/);
    await assert.rejects(f.transport.deployApi({ ...args, release: structuredClone(args.release) }), /untrusted-context/);
    await assert.rejects(f.transport.deployApi({ ...args, worker: 'other' }), /request/);
    assert.equal(f.calls.length, 0);
    await f.stageAll(2);
    f.controls.loseApi = true;
    assert.equal((await f.transport.deployApi(args)).outcome, 'unknown');
    assert.equal((await f.transport.reconcile({ installationId: args.installationId, release: args.release, operationId: args.operationId })).outcome, 'applied');
    assert.equal((await f.transport.deployApi(args)).outcome, 'applied');
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(f.releaseVersion, '2.0.0');
    await f.stageAll(1);
    const rollback = { ...f.args(1), priorRelease: f.releases.get(2) };
    assert.equal((await f.transport.deployApi(rollback)).outcome, 'applied');
    assert.equal(f.releaseVersion, '1.0.0');
    const other = { ...f.args(2), priorRelease: f.releases.get(2) };
    f.controls.redirect = true;
    await assert.rejects(f.transport.deployApi(other), /provider-redirect/);
    assert.ok(f.calls.every(call => !call.path.includes('untrusted')));
  } finally { f.db.close(); }
});

test('engine continues bounded Pages preparation and reconciles lost asset/deployment acknowledgments', async () => {
  const f = await setup();
  try {
    await f.stageAll(1);
    const capability = {}, engineStore = createUpdaterStore(d1(f.db), f.pins.installationId);
    const code = createCloudflareCodeAdapters({ transport: f.transport, installationId: f.pins.installationId, resolveRelease: context => [...f.releases.values()].find(release => release.manifestSha256 === context.manifestSha256), resolveInstalledRelease: () => f.releases.get(1), resolveDeployedRelease: () => f.releases.get(1) });
    const adapters = { ...code,
      async readManifest({ releaseId }) { return f.fixtures.get(releaseId); },
      async readArtifact(context) { return f.fixtures.get(context.releaseId).files.get(context.artifact.name); },
      async backup() { return { outcome: 'applied', receipt: { verified: true, backupId: 'synthetic-backup', sha256: 'b'.repeat(64), schema: 0 } }; },
      async health(context) { return { outcome: 'applied', receipt: { manifestSha256: context.manifestSha256, version: context.manifest.version, schema: 0 } }; },
    };
    const engine = createUpdaterEngine({ store: engineStore, verifier: createApplicationVerifier(f.trust), readDashboard, cipher: f.cipher, adapters, capability, installationId: f.pins.installationId });
    await engine.initialize(capability, { releaseId: 1, ...f.fixtures.get(1), updaterVersion: '1.0.0', ledger: [] });
    const initial = await engine.requestUpdate(capability, { releaseId: 2, requestId: crypto.randomUUID() });
    f.controls.loseAsset = true; f.controls.losePages = true;
    let final, unknownCount = 0;
    for (let i = 0; i < 30; i++) {
      final = await engine.advance(capability, initial.job.id);
      if (final.job.status === 'reconciling') unknownCount++;
      if (final.job.status === 'succeeded') break;
    }
    assert.equal(final.job.status, 'succeeded');
    assert.equal(final.installedVersion, '2.0.0');
    assert.equal(unknownCount, 2);
    assert.equal(f.calls.filter(call => call.path === '/pages/assets/upload').length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/synthetic-pages/deployments') && call.method === 'POST').length, 1);
    const serialized = f.db.prepare('SELECT envelope FROM updater_provider_operations').all().map(row => row.envelope).join('');
    assert.doesNotMatch(serialized, /synthetic-provider-secret|synthetic-provider-token/);
    // Readback remains available after capture with no app/source download.
    const prior = await code.readRecoveryArtifact({ manifestSha256: f.releases.get(1).manifestSha256, artifact: { name: 'api.mjs' } });
    assert.deepEqual(prior, f.fixtures.get(1).files.get('api.mjs'));
  } finally { f.db.close(); }
});

test('maximum signed archive advancement keeps combined engine and transport D1 calls bounded', async t => {
  const f = await setup({ largePages: true });
  try {
    await f.stageAll(1);
    const target = f.releases.get(2);
    assert.equal(f.fixtures.get(2).files.get('dashboard.tar').length, 16777216);
    // Populate the real encrypted staging table once, avoiding 171 repeated
    // source downloads solely to reach the maximum-read acceptance boundary.
    for (const [name, bytes] of f.fixtures.get(2).files) {
      const id = `${target.manifestSha256}:${name}`;
      await f.artifactStore.begin({ artifactId: id, bytes: bytes.length, digest: await sha256(bytes) });
      for (let offset = 0; offset < bytes.length; offset += ARTIFACT_CHUNK_BYTES) await f.artifactStore.writeChunk(id, offset / ARTIFACT_CHUNK_BYTES, bytes.slice(offset, offset + ARTIFACT_CHUNK_BYTES));
      await f.artifactStore.seal(id);
    }
    const capability = {}, code = createCloudflareCodeAdapters({ transport: f.transport, installationId: f.pins.installationId, resolveRelease: context => [...f.releases.values()].find(release => release.manifestSha256 === context.manifestSha256), resolveInstalledRelease: () => f.releases.get(1), resolveDeployedRelease: () => f.releases.get(1) });
    const engine = createUpdaterEngine({ store: createUpdaterStore(f.database, f.pins.installationId), verifier: createApplicationVerifier(f.trust), readDashboard, cipher: f.cipher, capability, installationId: f.pins.installationId, adapters: { ...code,
      async readManifest({ releaseId }) { return f.fixtures.get(releaseId); },
      async readArtifact(context) { return f.fixtures.get(context.releaseId).files.get(context.artifact.name); },
      async backup() { return { outcome: 'applied', receipt: { verified: true, backupId: 'synthetic-backup', sha256: 'b'.repeat(64), schema: 0 } }; },
    } });
    await engine.initialize(capability, { releaseId: 1, ...f.fixtures.get(1), updaterVersion: '1.0.0', ledger: [] });
    const started = await engine.requestUpdate(capability, { releaseId: 2, requestId: crypto.randomUUID() });
    for (let i = 0; i < 15 && (await engine.status(capability)).job.step !== 'deployPages'; i++) await engine.advance(capability, started.job.id);
    await engine.advance(capability, started.job.id); // Acknowledge pinned Pages configuration.
    f.stats.count = 0;
    const result = await engine.advance(capability, started.job.id);
    assert.equal(result.job.status, 'running');
    assert.equal(result.job.step, 'deployPages');
    assert.ok(f.stats.count <= 40, `D1 query count ${f.stats.count}`);
    t.diagnostic(`Maximum archive asset advancement: ${f.stats.count} D1 queries, excluding service authentication.`);
    assert.equal(f.calls.filter(call => call.path === '/pages/assets/upload').length, 1);
  } finally { f.db.close(); }
});

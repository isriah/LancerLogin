import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createUpdaterService } from '../apps/updater/service.mjs';
import { createUpdaterEngine } from '../apps/updater/src/engine.mjs';
import { createUpdaterStore } from '../apps/updater/src/store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createApplicationVerifier, signedBytes, sha256 } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
import { signedUpdaterRequest } from '../packages/shared/src/updater/service-auth.ts';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';
const secret = 'ab'.repeat(32), install = 'synthetic-install';
const request = (action, body = {}) => signedUpdaterRequest({ secret, installationId: install, actorId: 'admin-1', action, body });
test('recovery origin is constructor-only exact HTTPS authority',()=>{for(const recoveryOrigin of ['http://recovery.example.invalid','https://user@recovery.example.invalid','https://recovery.example.invalid/path','https://recovery.example.invalid?override=1'])assert.throws(()=>createUpdaterService({recoveryOrigin}));});
async function fixture(t, breaking = false) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const file of ['0001_updater_state.sql', '0003_updater_service.sql']) db.exec(readFileSync(new URL(`../apps/updater/state/${file}`, import.meta.url), 'utf8'));
  const database = { prepare(sql) { let values = []; return { bind(...next) { values = next; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async run() { return db.prepare(sql).run(...values); } }; } };
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pins = { product: 'LancerLogin', repository: { id: 1, owner: 'synthetic', name: 'service-test' }, channel: 'development', keyId: 'synthetic', publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  const releases = new Map(), staged = new Map();
  for (const sequence of [1, 2]) {
    const files = new Map([['api.mjs', new TextEncoder().encode(`export default {version:'${sequence}.0.0'};`)], ['dashboard.tar', packDashboard([{ path: 'index.html', bytes: new TextEncoder().encode('Synthetic') }])]]);
    const artifacts = await Promise.all([...files].map(async ([name, bytes]) => ({ role: name.endsWith('.tar') ? 'dashboard' : 'api', name, bytes: bytes.length, sha256: await sha256(bytes) })));
    const apiVersion = breaking && sequence === 2 ? 2 : 1;
    const manifest = { format: 1, kind: 'application', product: pins.product, repository: pins.repository, channel: pins.channel, keyId: pins.keyId, sequence, version: `${sequence}.0.0`, sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '1.0.0', targetSchema: 0, codeRollback: 'compatible', artifacts, migrations: [], compatibility: { installedVersion: { min: '1.0.0', max: '1.0.0' }, installedSchema: { min: 0, max: 0 }, apiVersion, apiSchema: { min: 0, max: 0 }, frontendApi: { min: apiVersion, max: apiVersion } } };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)), signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, signedBytes(manifestBytes)));
    releases.set(sequence, { manifestBytes, signatureBytes, files });
  }
  const capability = {}, store = createUpdaterStore(database, install), applied = receipt => ({ outcome: 'applied', receipt });
  const adapters = {
    readManifest: async ({ releaseId }) => releases.get(releaseId),
    readArtifact: async ({ releaseId, artifact }) => releases.get(releaseId).files.get(artifact.name),
    stageArtifact: async context => { staged.set(context.artifact.name, context.bytes); return applied({ manifestSha256: context.manifestSha256, name: context.artifact.name, sha256: context.artifact.sha256 }); },
    readStagedArtifact: async context => staged.get(context.artifact.name),
    captureCheckpoint: async () => applied({ priorCode: { api: 'synthetic', dashboard: 'synthetic' }, configuration: { synthetic: true } }),
    backup: async () => applied({ backupId: 'synthetic', sha256: 'c'.repeat(64), schema: 0, verified: true }),
    deployApi: async context => applied({ manifestSha256: context.manifestSha256 }),
    deployPages: async context => applied({ manifestSha256: context.manifestSha256 }),
    health: async context => applied({ version: context.manifest.version, schema: 0, manifestSha256: context.manifestSha256 }),
  };
  const engine = createUpdaterEngine({ store, verifier: createApplicationVerifier(pins), readDashboard, cipher: await createCheckpointCipher(new Uint8Array(32).fill(7), install), adapters, capability, installationId: install });
  await engine.initialize(capability, { releaseId: 1, ...releases.get(1), updaterVersion: '1.0.0', ledger: [] });
  const source = { async available(state, progress) { return progress ? { status: 'available', identity: { releaseId: 2 }, version: '2.0.0', sequence: 2 } : { status: 'checking', checked: 1, total: 2, progress: { nextIndex: 1 } }; }, async resume(identity) { assert.equal(identity.releaseId, 2); } };
  let statusReads = 0;
  const observedEngine = { ...engine, async status(...args) { statusReads++; return engine.status(...args); } };
  const service = createUpdaterService({ engine: observedEngine, source, store, database, capability, installationId: install, appSecret: secret, recoveryOrigin: 'https://recovery.example.invalid' });
  const call = async (action, body) => { const response = await service.fetch(await request(action, body)); assert.equal(response.status, 200); return response.json(); };
  return { service, call, db, store, statusReads: () => statusReads };
}
test('signed service drives actual engine, retains admission identity and stops offering a completed release', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('check')).availability.status, 'checking');
  assert.equal((await f.call('check')).availability.version, '2.0.0');
  const body = { requestId: crypto.randomUUID(), releaseId: 2 };
  let status = await f.call('start', body); const jobId = status.job.id;
  assert.equal(status.recoveryUrl, 'https://recovery.example.invalid/recovery');
  assert.equal(status.job.requestId, body.requestId); assert.equal(status.admission.state, 'accepted');
  assert.equal(status.availability.status, 'not-checked');
  assert.equal((await f.call('start', body)).job.id, jobId);
  const reads = f.statusReads();
  for (let count = 0; count < 12 && status.job.status === 'running'; count++) status = await f.call('advance', { jobId });
  assert.equal(f.statusReads(), reads, 'advance result is enriched without another engine status read');
  assert.equal(status.job.status, 'succeeded'); assert.equal(status.installedVersion, '2.0.0');
  assert.equal(status.availability.status, 'not-checked'); assert.equal(status.availability.releaseId, undefined);
  assert.equal((await f.call('status')).job.requestId, body.requestId);
  const serialized = JSON.stringify(status); assert.ok(!serialized.includes('manifestBytes') && !serialized.includes('ciphertext') && !serialized.includes(secret));
});
test('authoritatively rejected admission remains rejected and allows a distinct future request', async t => {
  const f = await fixture(t, true); await f.call('check'); await f.call('check');
  const body = { requestId: crypto.randomUUID(), releaseId: 2 }, rejected = await f.call('start', body);
  assert.equal(rejected.admission.state, 'rejected'); assert.equal(rejected.admission.reason, 'maintenance-required'); assert.equal(rejected.job, null);
  assert.equal((await f.call('start', body)).admission.state, 'rejected');
  const replacement = await f.call('start', { ...body, requestId: crypto.randomUUID() }); assert.notEqual(replacement.admission.requestId, body.requestId);
});
test('service rejects replay, signed-body tampering, wrong installation and oversized bodies before dispatch', async t => {
  const f = await fixture(t), original = await request('check'), replay = original.clone();
  assert.equal((await f.service.fetch(original)).status, 200); assert.equal((await f.service.fetch(replay)).status, 409);
  const signed = await request('check');
  assert.equal((await f.service.fetch(new Request(signed.url, { method: 'POST', headers: signed.headers, body: '{"releaseId":2}' }))).status, 401);
  assert.equal((await f.service.fetch(new Request(signed.url, { method: 'POST', headers: signed.headers, body: 'x'.repeat(4097) }))).status, 401);
  const wrong = await signedUpdaterRequest({ secret, installationId: 'other-install', actorId: 'admin-1', action: 'status' }); assert.equal((await f.service.fetch(wrong)).status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM updater_service_nonces').get().count, 1);
});
test('API reloads stored Admin authority, refuses staff/demotion and reports unconfigured without workflow handoff', async () => {
  const sessionKey = 'A'.repeat(43); let role = 'staff', calls = 0;
  const database = { prepare() { return { bind() { return this; }, async first() { return { id: 'admin-1', role }; } }; } };
  const env = { APP_MODE: 'configured', ALLOWED_ORIGIN: 'https://dashboard.invalid', DB: database, SESSION_KEY: sessionKey, UPDATER_INSTALLATION_ID: install, UPDATER_APP_KEY: secret, UPDATER: { async fetch(request) { calls++; assert.ok(request.headers.get('x-ll-signature')); return Response.json({ configured: true, installedVersion: '1.0.0', job: null, availability: { status: 'not-checked' } }); } } };
  const cookie = `lancerlogin_session=${await createSessionCodec(sessionKey).issue({ userId: 'admin-1', role: 'admin' })}`;
  const apiRequest = () => new Request('https://api.invalid/admin/updater/status', { headers: { cookie } });
  assert.equal((await worker.fetch(apiRequest(), env)).status, 403); assert.equal(calls, 0);
  role = 'admin'; assert.equal((await worker.fetch(apiRequest(), env)).status, 200); assert.equal(calls, 1);
  role = 'operator'; assert.equal((await worker.fetch(apiRequest(), env)).status, 403); assert.equal(calls, 1);
  role = 'admin'; delete env.UPDATER; const result = await worker.fetch(apiRequest(), env); assert.equal((await result.json()).configured, false);
});

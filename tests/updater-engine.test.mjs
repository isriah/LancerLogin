import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationVerifier, signedBytes, sha256 } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
import { createUpdaterStore } from '../apps/updater/src/store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createUpdaterEngine } from '../apps/updater/src/engine.mjs';

const utf8 = new TextEncoder();
const applied = receipt => ({ outcome: 'applied', receipt });
const requestId = () => crypto.randomUUID();
const d1 = sqlite => ({ prepare(sql) {
  let values = [];
  return { bind(...args) { values = args; return this; }, async first() { return sqlite.prepare(sql).get(...values) ?? null; } };
} });

async function fixture({ brokenMigration = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lancer-updater-'));
  const paths = Object.fromEntries(['updater', 'app', 'provider', 'backup'].map(name => [name, join(directory, `${name}.sqlite`)]));
  let updater = new DatabaseSync(paths.updater), app = new DatabaseSync(paths.app);
  const priorConnections = [];
  const provider = new DatabaseSync(paths.provider);
  updater.exec(readFileSync(new URL('../apps/updater/state/0001_updater_state.sql', import.meta.url), 'utf8'));
  app.exec('CREATE TABLE preserved(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO preserved VALUES(1, \'synthetic-preserved\'); CREATE TABLE migration_ledger(id TEXT PRIMARY KEY, sha256 TEXT, operation_id TEXT UNIQUE, from_schema INTEGER, to_schema INTEGER)');
  provider.exec('CREATE TABLE operations(id TEXT PRIMARY KEY, kind TEXT NOT NULL, receipt TEXT); CREATE TABLE staging(name TEXT PRIMARY KEY, bytes BLOB NOT NULL)');
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pins = { product: 'LancerLogin', channel: 'development', repository: { id: 1, owner: 'synthetic', name: 'updater-test' }, keyId: 'synthetic', publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)) };
  const releases = new Map();
  async function makeRelease(sequence, schema, codeRollback = 'compatible') {
    const files = new Map([
      ['api.mjs', utf8.encode(`export default {version: '${sequence}.0.0'};`)],
      ['dashboard.tar', packDashboard([{ path: 'index.html', bytes: utf8.encode(`<p>Synthetic ${sequence}</p>`) }])],
    ]);
    for (let i = 1; i <= schema; i++) files.set(`${String(i).padStart(4, '0')}_synthetic.sql`, utf8.encode(i === 2 && brokenMigration ? 'CREATE TABLE invalid(' : `CREATE TABLE added_${i}(id INTEGER PRIMARY KEY);`));
    const artifacts = await Promise.all([...files].map(async ([name, bytes]) => ({ role: name.endsWith('.sql') ? 'migration' : name.endsWith('.tar') ? 'dashboard' : 'api', name, bytes: bytes.length, sha256: await sha256(bytes) })));
    const migrations = artifacts.filter(item => item.role === 'migration').map((item, i) => ({ id: item.name, fromSchema: i, toSchema: i + 1, artifact: item.name, sha256: item.sha256 }));
    const manifest = { format: 1, kind: 'application', product: pins.product, channel: pins.channel, keyId: pins.keyId, repository: pins.repository, sequence, version: `${sequence}.0.0`, sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '1.0.0', compatibility: { installedVersion: { min: '1.0.0', max: '9.0.0' }, installedSchema: { min: 0, max: schema }, apiVersion: 1, apiSchema: { min: 0, max: 2 }, frontendApi: { min: 1, max: 1 } }, targetSchema: schema, codeRollback, artifacts, migrations };
    const manifestBytes = utf8.encode(JSON.stringify(manifest));
    const signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, signedBytes(manifestBytes)));
    releases.set(sequence, { manifest, manifestBytes, signatureBytes, files });
    return releases.get(sequence);
  }
  await makeRelease(1, 0);
  await makeRelease(2, 2, brokenMigration ? 'restore-required' : 'compatible');
  const capability = Object.freeze({});
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const cipher = await createCheckpointCipher(rawKey, 'synthetic-install');
  const controls = { lostAcknowledgment: null, hold: null, fail: null, sourceUnavailable: false, tamperStaged: false };
  const counts = {};
  const record = (context, receipt) => { provider.prepare('UPDATE operations SET receipt=? WHERE id=?').run(JSON.stringify(receipt), context.operationId); return applied(receipt); };
  const begin = async (kind, context) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    provider.prepare('INSERT INTO operations(id,kind) VALUES(?,?)').run(context.operationId, kind);
    if (controls.hold?.kind === kind) await controls.hold.promise;
  };
  const lost = (kind, value) => { if (controls.lostAcknowledgment === kind) { controls.lostAcknowledgment = null; throw Error('synthetic lost acknowledgment'); } return value; };
  const adapters = {
    recoveryQuiescence: true,
    async readManifest({ releaseId }) { if (controls.sourceUnavailable) throw Error('source-unavailable'); return releases.get(releaseId); },
    async readArtifact({ releaseId, artifact }) { if (controls.sourceUnavailable) throw Error('source-unavailable'); return releases.get(releaseId).files.get(artifact.name); },
    async readRecoveryArtifact({ artifact }) { return new Uint8Array(provider.prepare('SELECT bytes FROM staging WHERE name=?').get(`recovery:${artifact.name}`).bytes); },
    async readStagedArtifact({ manifestSha256, artifact }) {
      const bytes = new Uint8Array(provider.prepare('SELECT bytes FROM staging WHERE name=?').get(`${manifestSha256}:${artifact.name}`).bytes);
      if (controls.tamperStaged) bytes[0] ^= 1;
      return bytes;
    },
    async stageArtifact(context) {
      await begin('stageArtifact', context);
      if (controls.fail === 'stageArtifact') return { outcome: 'failed', terminal: true };
      provider.prepare('INSERT OR REPLACE INTO staging(name,bytes) VALUES(?,?)').run(`${context.manifestSha256}:${context.artifact.name}`, context.bytes);
      return lost('stageArtifact', record(context, { manifestSha256: context.manifestSha256, name: context.artifact.name, sha256: context.artifact.sha256 }));
    },
    async captureCheckpoint(context) {
      await begin('captureCheckpoint', context);
      for (const [name, bytes] of releases.get(1).files) provider.prepare('INSERT OR REPLACE INTO staging(name,bytes) VALUES(?,?)').run(`recovery:${name}`, bytes);
      return record(context, { priorCode: { api: 'synthetic-api-version', dashboard: 'synthetic-pages-deployment' }, configuration: { secret: 'synthetic-retained-configuration' } });
    },
    async backup(context) {
      await begin('backup', context);
      copyFileSync(paths.app, paths.backup);
      return record(context, { backupId: 'synthetic-backup', sha256: await sha256(readFileSync(paths.backup)), verified: true, schema: context.installed.schema });
    },
    async applyMigration(context) {
      await begin('applyMigration', context);
      const migration = context.migration;
      try {
        app.exec('BEGIN IMMEDIATE');
        app.exec(new TextDecoder().decode(context.bytes));
        app.prepare('INSERT INTO migration_ledger VALUES(?,?,?,?,?)').run(migration.id, migration.sha256, context.operationId, migration.fromSchema, migration.toSchema);
        app.exec('COMMIT');
      } catch { app.exec('ROLLBACK'); return { outcome: 'failed', terminal: true }; }
      return lost('applyMigration', record(context, migration));
    },
    async deployApi(context) {
      await begin('deployApi', context);
      if (controls.fail === 'deployApi') return { outcome: 'failed', terminal: true };
      return lost('deployApi', record(context, { manifestSha256: context.manifestSha256 }));
    },
    async deployPages(context) { await begin('deployPages', context); return record(context, { manifestSha256: context.manifestSha256 }); },
    async health(context) { await begin('health', context); return record(context, { version: context.manifest.version, schema: context.installed.schema, manifestSha256: context.manifestSha256 }); },
    async restoreBackup(context) {
      await begin('restoreBackup', context);
      assert.equal(await sha256(readFileSync(paths.backup)), context.checkpoint.backup.sha256);
      app.close(); copyFileSync(paths.backup, paths.app); app = new DatabaseSync(paths.app);
      return record(context, { ...context.checkpoint.backup });
    },
    async reconcile(context) {
      counts.reconcile = (counts.reconcile ?? 0) + 1;
      const row = provider.prepare('SELECT receipt FROM operations WHERE id=?').get(context.operationId);
      return row?.receipt ? applied(JSON.parse(row.receipt)) : { outcome: 'unknown' };
    },
  };
  const construct = () => createUpdaterEngine({ store: createUpdaterStore(d1(updater), 'synthetic-install'), verifier: createApplicationVerifier(pins), readDashboard, cipher, adapters, capability, installationId: 'synthetic-install' });
  let engine = construct();
  await engine.initialize(capability, { releaseId: 1, ...releases.get(1), updaterVersion: '1.0.0', ledger: [] });
  return {
    get engine() { return engine; }, capability, controls, counts, releases, makeRelease, cipher,
    get app() { return app; }, get updater() { return updater; },
    async start() { return engine.requestUpdate(capability, { releaseId: 2, requestId: requestId() }); },
    async until(jobId, predicate) {
      for (let i = 0; i < 30; i++) { const status = await engine.status(capability); if (predicate(status)) return status; await engine.advance(capability, jobId); }
      throw Error('synthetic-step-budget');
    },
    restart() { priorConnections.push(updater); updater = new DatabaseSync(paths.updater); engine = construct(); },
    close() { updater.close(); for (const connection of priorConnections) connection.close(); app.close(); provider.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('signed admission rejects browser role assertions, tampering, arbitrary overrides and concurrent jobs', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.engine.status({ role: 'admin' }), /unauthorized/);
    await assert.rejects(f.engine.requestUpdate(f.capability, { releaseId: 2, requestId: requestId(), resource: 'other-worker' }), /request/);
    f.releases.get(2).signatureBytes[0] ^= 1;
    await assert.rejects(f.start(), /signature/);
    assert.equal((await f.engine.status(f.capability)).job, null);
    f.releases.get(2).signatureBytes[0] ^= 1;
    const results = await Promise.allSettled([f.start(), f.start()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(Object.keys(f.counts).length, 0);
    await assert.rejects(f.start(), /update-busy/);
  } finally { f.close(); }
});

test('restart reconciles committed migration after lost acknowledgment without a second mutation', async () => {
  const f = await fixture();
  try {
    const { job } = await f.start();
    await f.until(job.id, status => status.job.step === 'applyMigration');
    f.controls.lostAcknowledgment = 'applyMigration';
    const unknown = await f.engine.advance(f.capability, job.id);
    assert.equal(unknown.job.status, 'reconciling');
    assert.equal(f.app.prepare('SELECT COUNT(*) n FROM migration_ledger').get().n, 1);
    f.restart();
    const reconciled = await f.engine.advance(f.capability, job.id);
    assert.equal(reconciled.schema, 1);
    assert.equal(f.counts.applyMigration, 1);
    const done = await f.until(job.id, status => status.job.status === 'succeeded');
    assert.equal(done.installedVersion, '2.0.0');
    assert.equal(done.schema, 2);
    assert.equal(f.counts.applyMigration, 2);
    assert.equal(f.app.prepare('SELECT value FROM preserved').get().value, 'synthetic-preserved');
  } finally { f.close(); }
});

test('concurrent advancement never steals an in-flight dispatch or retries empty readback', async () => {
  const f = await fixture();
  try {
    const { job } = await f.start();
    let release;
    f.controls.hold = { kind: 'stageArtifact', promise: new Promise(resolve => { release = resolve; }) };
    const pending = f.engine.advance(f.capability, job.id);
    for (let i = 0; i < 100 && !f.counts.stageArtifact; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.counts.stageArtifact, 1);
    assert.equal((await f.engine.advance(f.capability, job.id)).job.status, 'reconciling');
    f.restart();
    assert.equal((await f.engine.advance(f.capability, job.id)).job.status, 'reconciling');
    assert.equal(f.counts.stageArtifact, 1);
    release();
    await pending;
    // The delayed owner and replacement process use distinct SQLite connections.
    assert.equal((await f.engine.status(f.capability)).job.completedSteps, 1);
    assert.equal(f.counts.stageArtifact, 1);
  } finally { f.close(); }
});

test('failed migration retains earlier committed schema; independent restore preserves high-water mark', async () => {
  const f = await fixture({ brokenMigration: true });
  try {
    const { job } = await f.start();
    const failed = await f.until(job.id, status => status.job.status === 'failed');
    assert.equal(failed.schema, 1);
    assert.ok(f.app.prepare("SELECT name FROM sqlite_schema WHERE name='added_1'").get());
    await assert.rejects(f.engine.requestRecovery(f.capability, { failedJobId: job.id, mode: 'code-recovery', requestId: requestId() }), /restore-required/);
    f.controls.sourceUnavailable = true;
    f.restart();
    const recovery = await f.engine.requestRecovery(f.capability, { failedJobId: job.id, mode: 'restore', requestId: requestId() });
    const restored = await f.until(recovery.job.id, status => status.job.status === 'recovered');
    assert.equal(restored.schema, 0);
    assert.equal(restored.installedVersion, '1.0.0');
    assert.equal(restored.highestSequence, 2);
    assert.equal(f.app.prepare("SELECT name FROM sqlite_schema WHERE name='added_1'").get(), undefined);
    assert.equal(f.app.prepare('SELECT value FROM preserved').get().value, 'synthetic-preserved');
    f.controls.sourceUnavailable = false;
    await assert.rejects(f.start(), /downgrade/);
    assert.equal(f.counts.restoreBackup, 1);
  } finally { f.close(); }
});

test('code-only recovery keeps migrated schema and refuses damaged staging before deployment', async () => {
  const f = await fixture();
  try {
    const { job } = await f.start();
    await f.until(job.id, status => status.job.step === 'deployApi');
    f.controls.tamperStaged = true;
    await assert.rejects(f.engine.advance(f.capability, job.id), /artifact-digest/);
    assert.equal(f.counts.deployApi, undefined);
    f.controls.tamperStaged = false;
    f.controls.fail = 'deployApi';
    await f.engine.advance(f.capability, job.id);
    f.controls.fail = null;
    const recovery = await f.engine.requestRecovery(f.capability, { failedJobId: job.id, mode: 'code-recovery', requestId: requestId() });
    const result = await f.until(recovery.job.id, status => status.job.status === 'recovered');
    assert.equal(result.schema, 2);
    assert.equal(result.installedVersion, '1.0.0');
    assert.equal(result.highestSequence, 2);
    assert.equal(f.counts.restoreBackup, undefined);
  } finally { f.close(); }
});

test('updater checkpoint encrypts retained configuration and rejects moved envelopes', async () => {
  const f = await fixture();
  try {
    const { job } = await f.start();
    await f.until(job.id, status => status.job.step === 'applyMigration');
    const raw = f.updater.prepare('SELECT state_json FROM updater_state').get().state_json;
    assert.doesNotMatch(raw, /synthetic-retained-configuration/);
    assert.doesNotMatch(JSON.stringify(await f.engine.status(f.capability)), /ciphertext|configuration|signature/);
    const checkpoint = JSON.parse(raw).checkpoint;
    assert.equal((await f.cipher.open(checkpoint.jobId, checkpoint.envelope)).provider.configuration.secret, 'synthetic-retained-configuration');
    await assert.rejects(f.cipher.open('different-job', checkpoint.envelope), /checkpoint-integrity/);
  } finally { f.close(); }
});

test('explicit preparation retry resumes known rejection but cannot clear an unknown operation', async () => {
  const f = await fixture();
  try {
    const { job } = await f.start();
    f.controls.fail = 'stageArtifact';
    const failed = await f.engine.advance(f.capability, job.id);
    assert.equal(failed.job.status, 'failed');
    assert.equal(failed.recoveryAvailable, false);
    const retry = { jobId: job.id, failedOperationId: failed.job.retryPreparationOperationId };
    await f.engine.retryPreparation(f.capability, retry);
    f.controls.fail = null;
    f.controls.lostAcknowledgment = 'stageArtifact';
    const unknown = await f.engine.advance(f.capability, job.id);
    assert.equal(unknown.job.status, 'reconciling');
    const replayed = await f.engine.retryPreparation(f.capability, retry);
    assert.equal(replayed.job.operationId, unknown.job.operationId);
    assert.equal(replayed.job.status, 'reconciling');
    await assert.rejects(f.engine.retryPreparation(f.capability, { jobId: job.id, failedOperationId: unknown.job.operationId }), /preparation-retry-unavailable/);
    assert.equal(f.counts.stageArtifact, 2);
    const done = await f.until(job.id, status => status.job.status === 'succeeded');
    assert.equal(done.highestSequence, 2);
    assert.equal(done.schema, 2);
    assert.equal(f.counts.stageArtifact, 5); // Four artifacts, one known rejection.
  } finally { f.close(); }
});

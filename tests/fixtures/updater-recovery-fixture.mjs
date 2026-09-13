import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRecoveryService, recoveryCredentialDigest } from '../../apps/updater/recovery-service.mjs';
import { createUpdaterEngine } from '../../apps/updater/src/engine.mjs';
import { createUpdaterStore } from '../../apps/updater/src/store.mjs';
import { createCheckpointCipher } from '../../apps/updater/src/checkpoint.mjs';
import { createApplicationVerifier, sha256, signedBytes } from '../../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard } from '../../packages/shared/src/updater/dashboard-archive.mjs';
export async function recoveryFixture() {
  const db = new DatabaseSync(':memory:'), installationId = 'synthetic-recovery', origin = 'https://recovery.example.invalid';
  for (const file of ['0001_updater_state.sql', '0004_updater_recovery_sessions.sql']) db.exec(readFileSync(new URL(`../../apps/updater/state/${file}`, import.meta.url), 'utf8'));
  const database = { prepare(sql) { let values = []; return { bind(...next) { values = next; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async run() { return db.prepare(sql).run(...values); } }; } };
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']), capability = {}, releases = new Map(), staged = new Map();
  const pins = { product: 'LancerLogin', repository: { id: 1, owner: 'synthetic', name: 'recovery-test' }, channel: 'development', keyId: 'synthetic', publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)) };
  for (const sequence of [1, 2]) {
    const files = new Map([['api.mjs', new TextEncoder().encode(`export default {version:'${sequence}.0.0'};`)], ['dashboard.tar', packDashboard([{ path: 'index.html', bytes: new TextEncoder().encode('Synthetic recovery') }])]]);
    const artifacts = await Promise.all([...files].map(async ([name, bytes]) => ({ role: name.endsWith('.tar') ? 'dashboard' : 'api', name, bytes: bytes.length, sha256: await sha256(bytes) })));
    const manifest = { format: 1, kind: 'application', product: pins.product, repository: pins.repository, channel: pins.channel, keyId: pins.keyId, sequence, version: `${sequence}.0.0`, sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '1.0.0', targetSchema: 0, codeRollback: 'compatible', artifacts, migrations: [], compatibility: { installedVersion: { min: '1.0.0', max: '1.0.0' }, installedSchema: { min: 0, max: 0 }, apiVersion: 1, apiSchema: { min: 0, max: 0 }, frontendApi: { min: 1, max: 1 } } };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)), signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, signedBytes(manifestBytes)));
    releases.set(sequence, { manifestBytes, signatureBytes, files });
  }
  const store = createUpdaterStore(database, installationId), applied = receipt => ({ outcome: 'applied', receipt });
  let appUnavailable = false, sourceCallsAfterFailure = 0, clock = Date.now();
  const adapters = {
    readManifest: async ({ releaseId }) => { if (appUnavailable) { sourceCallsAfterFailure++; throw Error('source-offline'); } return releases.get(releaseId); },
    readArtifact: async ({ releaseId, artifact }) => releases.get(releaseId).files.get(artifact.name),
    readRecoveryArtifact: async ({ artifact }) => releases.get(1).files.get(artifact.name),
    stageArtifact: async context => { staged.set(context.artifact.name, context.bytes); return applied({ manifestSha256: context.manifestSha256, name: context.artifact.name, sha256: context.artifact.sha256 }); },
    readStagedArtifact: async context => staged.get(context.artifact.name),
    captureCheckpoint: async () => applied({ priorCode: { api: 'synthetic-retained-api', dashboard: 'synthetic-retained-pages' }, configuration: { synthetic: true } }),
    backup: async () => applied({ backupId: 'synthetic-verified-backup', sha256: 'c'.repeat(64), schema: 0, verified: true }),
    deployApi: async context => context.manifest.sequence === 2 ? { outcome: 'failed', terminal: true } : applied({ manifestSha256: context.manifestSha256 }),
    deployPages: async context => applied({ manifestSha256: context.manifestSha256 }),
    health: async context => applied({ version: context.manifest.version, schema: 0, manifestSha256: context.manifestSha256 }),
  };
  const engine = createUpdaterEngine({ store, verifier: createApplicationVerifier(pins), readDashboard, cipher: await createCheckpointCipher(new Uint8Array(32).fill(17), installationId), adapters, capability, installationId });
  await engine.initialize(capability, { releaseId: 1, ...releases.get(1), updaterVersion: '1.0.0', ledger: [] });
  let status = await engine.requestUpdate(capability, { requestId: crypto.randomUUID(), releaseId: 2 });
  for (let count = 0; count < 10 && status.job.status === 'running'; count++) status = await engine.advance(capability, status.job.id);
  if (status.job.status !== 'failed' || !status.recoveryAvailable) throw Error('fixture-did-not-fail-recoverably');
  appUnavailable = true;
  const credential = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let statusReads = 0;
  const observedEngine = { ...engine, async status(...args) { statusReads++; return engine.status(...args); } };
  const service = createRecoveryService({ engine: observedEngine, store, database, capability, installationId, origin, credentialSha256: await recoveryCredentialDigest(credential, installationId), now: () => clock });
  return { service, credential, origin, installationId, db, failedJobId: status.job.id, statusReads: () => statusReads, sourceCalls: () => sourceCallsAfterFailure, expire: () => { clock += 901000; }, close: () => db.close() };
}

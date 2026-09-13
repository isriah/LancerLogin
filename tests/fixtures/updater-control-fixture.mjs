import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createUpdaterService } from '../../apps/updater/service.mjs';
import { createUpdaterEngine } from '../../apps/updater/src/engine.mjs';
import { createUpdaterStore } from '../../apps/updater/src/store.mjs';
import { createCheckpointCipher } from '../../apps/updater/src/checkpoint.mjs';
import { createApplicationVerifier, signedBytes, sha256 } from '../../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard } from '../../packages/shared/src/updater/dashboard-archive.mjs';
import { signedUpdaterRequest } from '../../packages/shared/src/updater/service-auth.ts';
import {createControlService} from '../../apps/updater/control-service.mjs';

const secret = 'ab'.repeat(32), install = 'synthetic-install';
const request = (action, body = {}) => signedUpdaterRequest({ secret, installationId: install, actorId: 'admin-1', action, body });

export async function controlFixture(t, breaking = false) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const file of ['0001_updater_state.sql', '0003_updater_service.sql','0008_updater_control.sql']) db.exec(readFileSync(new URL(`../../apps/updater/state/${file}`, import.meta.url), 'utf8'));
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
  let clock=Date.now();const origin='https://recovery.example.invalid',dashboardOrigin='https://dashboard.example.invalid';
  const controls=createControlService({engine:observedEngine,store,database,capability,installationId:install,origin,dashboardOrigin,now:()=>clock});
  const service = createUpdaterService({ engine: observedEngine, source, store, database, capability, installationId: install, appSecret: secret, controls, recoveryOrigin: 'https://recovery.example.invalid' });
  const call = async (action, body) => { const response = await service.fetch(await request(action, body)); assert.equal(response.status, 200); return response.json(); };
  return { service,call,db,store,controls,origin,dashboardOrigin,expire:()=>{clock+=901000},request,secret,install,statusReads:()=>statusReads };
}

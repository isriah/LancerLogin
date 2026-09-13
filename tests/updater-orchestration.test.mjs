import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintenanceOrchestration } from '../apps/updater/src/orchestration.mjs';
import { snapshotCatalog } from '../apps/updater/src/snapshot-catalog.mjs';
import { createUpdaterStore } from '../apps/updater/src/store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createApplicationVerifier, sha256, signedBytes } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
async function fixture({ failDeploy = false, failPreparation = false, failBackup = false, initialSchema = 49, restoreEnabled = false } = {}) {
  const db = new DatabaseSync(':memory:'), installationId = 'synthetic-recovery', origin = 'https://recovery.example.invalid';
  for (const file of ['0001_updater_state.sql', '0005_updater_maintenance.sql', '0006_updater_execution_proofs.sql', '0007_updater_job_maintenance.sql']) db.exec(readFileSync(new URL(`../apps/updater/state/${file}`, import.meta.url), 'utf8'));
  let loseClose = false, loseHandoff = false;
  const database = { prepare(sql) { let values = []; return { bind(...next) { values = next; return this; }, async first() { const result = db.prepare(sql).get(...values) ?? null; if (loseClose && sql.startsWith("UPDATE updater_maintenance SET epoch")) { loseClose = false; throw Error('lost-close-ack'); } if (loseHandoff && sql.startsWith('UPDATE updater_maintenance SET job_id=')) { loseHandoff = false; throw Error('lost-handoff-ack'); } return result; }, async run() { return db.prepare(sql).run(...values); } }; } };
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']), capability = {}, releases = new Map(), staged = new Map();
  const pins = { product: 'LancerLogin', repository: { id: 1, owner: 'synthetic', name: 'recovery-test' }, channel: 'development', keyId: 'synthetic', publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)) };
  for (const sequence of [1, 2]) {
    const ledger=snapshotCatalog.ledger.slice(0,sequence===1?initialSchema:49);
    const files = new Map([['api.mjs', new TextEncoder().encode(`export default {version:'${sequence}.0.0'};`)], ['dashboard.tar', packDashboard([{ path: 'index.html', bytes: new TextEncoder().encode('Synthetic recovery') }])]]);
    for (const item of ledger) files.set(item.id, new Uint8Array(readFileSync(new URL(`../apps/api/migrations/${item.id}`, import.meta.url))));
    const artifacts = await Promise.all([...files].map(async ([name, bytes]) => ({ role: name.endsWith('.sql') ? 'migration' : name.endsWith('.tar') ? 'dashboard' : 'api', name, bytes: bytes.length, sha256: await sha256(bytes) })));
    const manifest = { format: 1, kind: 'application', product: pins.product, repository: pins.repository, channel: pins.channel, keyId: pins.keyId, sequence, version: `${sequence}.0.0`, sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '1.0.0', targetSchema: ledger.length, codeRollback: 'compatible', artifacts, migrations: ledger.map((item, i) => ({ ...item, artifact: item.id, fromSchema: i, toSchema: i + 1 })), compatibility: { installedVersion: { min: '1.0.0', max: '1.0.0' }, installedSchema: { min: initialSchema, max: ledger.length }, apiVersion: 1, apiSchema: { min: initialSchema, max: 49 }, frontendApi: { min: 1, max: 1 } } };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)), signatureBytes = new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, signedBytes(manifestBytes)));
    releases.set(sequence, { manifestBytes, signatureBytes, files });
  }
  const store = createUpdaterStore(database, installationId), applied = receipt => ({ outcome: 'applied', receipt });
  let appUnavailable = false, sourceCallsAfterFailure = 0, gate = null, stageCalls = 0, healthOkay = true, authority;
  const authorities = [];
  const adapters = {
    readManifest: async ({ releaseId }) => { if (appUnavailable) { sourceCallsAfterFailure++; throw Error('source-offline'); } return releases.get(releaseId); },
    readArtifact: async ({ releaseId, artifact }) => releases.get(releaseId).files.get(artifact.name),
    readRecoveryArtifact: async ({ artifact }) => releases.get(1).files.get(artifact.name),
    stageArtifact: async context => { stageCalls++; if (failPreparation) return { outcome: 'failed', terminal: true }; if (gate) await gate; staged.set(context.artifact.name, context.bytes); return applied({ manifestSha256: context.manifestSha256, name: context.artifact.name, sha256: context.artifact.sha256 }); },
    readStagedArtifact: async context => staged.get(context.artifact.name),
    captureCheckpoint: async () => applied({ priorCode: { api: 'synthetic-retained-api', dashboard: 'synthetic-retained-pages' }, configuration: { synthetic: true } }),
    backup: async context => { if (failBackup) return { outcome: 'failed', terminal: true }; await assert.rejects(authority({ ...context, operationId: 'wrong-operation' }, () => assert.fail('wrong operation accepted')), /orchestration-authority/); return authority(context, async proof => { authorities.push(proof); return applied({ backupId: 'synthetic-verified-backup', sha256: 'c'.repeat(64), schema: initialSchema, verified: true, identity:{jobId:context.jobId,epoch:proof.epoch} }); }); },
    applyMigration:async context=>context.migration.fromSchema===47?{outcome:'failed',terminal:true}:applied({...context.migration}),
    deployApi: async context => authority(context, async proof => { authorities.push(proof); return failDeploy && context.manifest.sequence === 2 ? { outcome: 'failed', terminal: true } : applied({ manifestSha256: context.manifestSha256 }); }),
    deployPages: async context => applied({ manifestSha256: context.manifestSha256 }),
    health: async context => applied({ version: context.manifest.version, schema: context.installed.schema, manifestSha256: context.manifestSha256 }),
  };
  const archives=new Map(),handoffs=new Map();if(restoreEnabled)Object.assign(adapters,{recoveryQuiescence:true,restoreBackup:async()=>({outcome:'pending'}),restoreHandoff:async input=>{if(input.phase==='archive'){archives.set(input.request.requestId,{failedJob:structuredClone(input.current.job),failedInstalled:structuredClone(input.current.installed),checkpointJobId:input.current.checkpoint.jobId,epoch:input.epoch});return input.request.requestId;}handoffs.set(input.current.job.id,archives.get(input.archiveId));},readRestoreHandoff:async id=>handoffs.get(id)});
  const executionCapability = {}, engine = createMaintenanceOrchestration({ database, installationId, store, verifier: createApplicationVerifier(pins), readDashboard, cipher: await createCheckpointCipher(new Uint8Array(32).fill(17), installationId), capability, executionCapability,
    createAdapters({ withClosedEpoch }) { authority = withClosedEpoch; return adapters; },
    readHealthEvidence: async expected => ({ ...expected, verified: healthOkay }),
  });
  await engine.initialize(capability, { releaseId: 1, ...releases.get(1), updaterVersion: '1.0.0', ledger: snapshotCatalog.ledger.slice(0,initialSchema) });
  const request = { requestId: crypto.randomUUID(), releaseId: 2 };
  return { engine, capability, executionCapability, store, db, authorities, request, installationId,
    start: () => engine.requestUpdate(capability, request),
    status: () => engine.status(capability),
    advance: async () => engine.advance(capability, (await engine.status(capability)).job.id),
    authority: input => authority(input, () => assert.fail('unexpected authority')),
    gate: value => { gate = value; }, calls: () => stageCalls,
    loseClose: () => { loseClose = true; }, loseHandoff: () => { loseHandoff = true; }, health: value => { healthOkay = value; },
    async finish() { for (let i = 0; i < 65; i++) { const status = await engine.status(capability); if (['failed', 'succeeded', 'recovered'].includes(status.job.status)) return status; await engine.advance(capability, status.job.id); } throw Error('fixture-progress'); },
    close: () => db.close(),
  };
}

test('close returns while its own app permit drains; lost acknowledgment retains exact job/epoch', async () => {
  const f = await fixture(); try {
    const permit = await f.engine.executionCore.admit(f.executionCapability, { permitId: 'own-request' });
    f.loseClose(); await assert.rejects(f.start(), /lost-close-ack/);
    const status = await f.start(); assert.equal(status.maintenance.state, 'draining'); assert.equal(status.maintenance.epoch, 1);
    assert.equal((await f.advance()).job.cursor, status.job.cursor); assert.equal(f.calls(), 0);
    await f.engine.executionCore.release(f.executionCapability, permit.permit);
    assert.equal((await f.advance()).maintenance.state, 'closed');
    assert.equal((await f.start()).job.id, status.job.id);
    await assert.rejects(f.authority({ installationId: f.installationId, operationId: 'invented' }), /orchestration-authority/);
  } finally { f.close(); }
});

test('concurrent advance dispatches once; exact operation authority derives backup and health gates reopening', async () => {
  const f = await fixture(); try {
    await f.start(); await f.advance();
    let release; f.gate(new Promise(resolve => { release = resolve; }));
    const pending = f.advance(); while (!f.calls()) await new Promise(resolve => setImmediate(resolve));
    await f.advance(); assert.equal(f.calls(), 1); release(); await pending; f.gate(null);
    const result = await f.finish(); assert.equal(result.job.status, 'succeeded');
    assert.equal(f.authorities.length, 2); assert.equal(f.authorities[0].backupVerified, false); assert.equal(f.authorities[1].backupVerified, true);
    assert.ok(f.authorities.every(proof => Object.isFrozen(proof) && proof.jobId === result.job.id && proof.epoch === 1 && proof.operationId));
    f.health(false); await f.advance(); await assert.rejects(f.advance(), /orchestration-health/);
    assert.equal((await f.status()).maintenance.state, 'closed');
    f.health(true); await f.advance(); assert.equal((await f.advance()).maintenance.state, 'open');
  } finally { f.close(); }
});

test('failed job does not reopen; exact recovery lineage retains closed epoch through code recovery', async () => {
  const f = await fixture({ failDeploy: true }); try {
    await f.start(); const failed = await f.finish(); assert.equal(failed.job.status, 'failed');
    assert.equal(failed.maintenance.state, 'closed'); assert.equal((await f.advance()).maintenance.phase, 'closed');
    await assert.rejects(f.engine.retryPreparation(f.capability, { jobId: failed.job.id, failedOperationId: 'wrong' }), /preparation-retry-unavailable/);
    assert.equal((await f.status()).maintenance.phase, 'closed');
    const request = { failedJobId: failed.job.id, mode: 'code-recovery', requestId: crypto.randomUUID() };
    await assert.rejects(f.engine.requestRecovery(f.capability, { ...request, failedJobId: 'wrong' }), /orchestration-lineage/);
    await assert.rejects(f.engine.requestRecovery(f.capability, { ...request, mode: 'restore' }), /restore-unavailable/);
    f.loseHandoff(); await assert.rejects(f.engine.requestRecovery(f.capability, request), /lost-handoff-ack/);
    assert.equal((await f.status()).maintenance.phase, 'handoff');
    const recovery = await f.engine.requestRecovery(f.capability, request); assert.notEqual(recovery.job.id, failed.job.id); assert.equal(recovery.maintenance.epoch, 1);
    assert.equal((await f.engine.requestRecovery(f.capability, request)).job.id, recovery.job.id);
    assert.equal((await f.finish()).job.status, 'recovered');
    await f.advance(); assert.equal((await f.advance()).maintenance.state, 'open');
  } finally { f.close(); }
});

test('persisted orphan hold never expires or permits another dispatch', async () => {
  const f = await fixture(); try {
    await f.start(); const status = await f.advance();
    f.db.prepare("INSERT INTO updater_job_holds VALUES(?,?,?,?,?,?)").run('orphan', f.installationId, status.job.id, 1, 'uncertain', 'active');
    for (let i = 0; i < 3; i++) assert.equal((await f.advance()).maintenance.blocked, true);
    assert.equal(f.calls(), 0); assert.equal((await f.status()).maintenance.state, 'closed');
  } finally { f.close(); }
});

test('invalid recovery without backup and stale retry cannot poison a preparation failure', async () => {
  const f = await fixture({ failBackup: true }); try {
    await f.start(); const failed = await f.finish();
    await assert.rejects(f.engine.requestRecovery(f.capability, { failedJobId: failed.job.id, requestId: crypto.randomUUID(), mode: 'code-recovery' }), /backup-unavailable/);
    await assert.rejects(f.engine.retryPreparation(f.capability, { jobId: failed.job.id, failedOperationId: 'wrong' }), /preparation-retry-unavailable/);
    assert.equal((await f.status()).maintenance.phase, 'closed');
    const retried = await f.engine.retryPreparation(f.capability, { jobId: failed.job.id, failedOperationId: failed.job.retryPreparationOperationId });
    assert.equal(retried.job.status, 'running'); assert.equal(retried.maintenance.state, 'closed');
  } finally { f.close(); }
});

test('restore handoff admits archived intermediate47 and rejects UUID mode changes',async()=>{const f=await fixture({initialSchema:46,restoreEnabled:true});try{await f.start();const failed=await f.finish();assert.equal(failed.schema,47);assert.equal(failed.job.status,'failed');const request={failedJobId:failed.job.id,requestId:crypto.randomUUID(),mode:'restore'};f.loseHandoff();await assert.rejects(f.engine.requestRecovery(f.capability,request),/lost-handoff-ack/);const recovery=await f.engine.requestRecovery(f.capability,request);assert.equal(recovery.maintenance.epoch,failed.maintenance.epoch);await assert.rejects(f.engine.requestRecovery(f.capability,{...request,mode:'code-recovery'}),/request-conflict/);const advanced=await f.advance();assert.equal(advanced.job.id,recovery.job.id);assert.equal(advanced.schema,47);assert.equal(advanced.maintenance.state,'closed');}finally{f.close();}});

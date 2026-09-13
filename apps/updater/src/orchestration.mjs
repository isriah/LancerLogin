import { createUpdaterEngine } from './engine.mjs';
import { createMaintenanceCore } from './maintenance.mjs';
import { snapshotCatalog } from './snapshot-catalog.mjs';
import { selectSnapshotCatalog } from './snapshot-catalog-registry.mjs';
import { fromBase64 } from './checkpoint.mjs';
const check = (value, code) => { if (!value) throw Error(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const terminal = job => job && ['succeeded', 'recovered', 'failed'].includes(job.status) && !job.operation;
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };

export function createMaintenanceOrchestration({ database, installationId, store, verifier, cipher, readDashboard, createAdapters, readHealthEvidence, capability, executionCapability }) {
  class PendingHealth extends Error {}
  check(typeof capability === 'object' && capability && capability !== executionCapability && typeof createAdapters === 'function' && typeof readHealthEvidence === 'function', 'orchestration-configuration');
  const engineCapability = {}, maintenanceCapability = {}, live = new Map();
  const first = (sql, ...params) => (database.withSession ? database.withSession('first-primary') : database).prepare(sql).bind(...params).first();
  const authorize = supplied => check(supplied === capability, 'unauthorized');
  const owner = async () => { const row = await first('SELECT revision,state_json FROM updater_job_maintenance WHERE installation_id=?', installationId); return row ? { revision: row.revision, value: JSON.parse(row.state_json) } : null; };
  const save = (row, value) => row ? first('UPDATE updater_job_maintenance SET revision=revision+1,state_json=? WHERE installation_id=? AND revision=? RETURNING revision', JSON.stringify(value), installationId, row.revision) : first('INSERT INTO updater_job_maintenance(installation_id,state_json) VALUES(?,?) ON CONFLICT DO NOTHING RETURNING revision', installationId, JSON.stringify(value));
  const held = () => first("SELECT hold_id FROM updater_job_holds WHERE installation_id=? AND state='active' LIMIT 1", installationId);
  const state = async () => (await store.read()).state;
  async function known(value) {
    const schema = value.installed.schema;
    check([46,47,48,49].includes(schema) && same(value.installed.ledger, snapshotCatalog.ledger.slice(0, schema)), 'orchestration-schema');
    if ([47,48].includes(schema)) {
      const job = value.job, checkpoint = value.checkpoint;
      if(job?.mode==='restore'){const saved=await adapters.readRestoreHandoff?.(job.id),ownerRow=await owner();check(saved&&saved.failedJob.id===job.failedJobId&&saved.checkpointJobId===job.checkpointJobId&&same(saved.failedInstalled,value.installed)&&ownerRow?.value.phase==='closed'&&ownerRow.value.jobId===job.id&&ownerRow.value.epoch===saved.epoch,'orchestration-schema');return;}
      check(job?.mode === 'update' && checkpoint?.jobId === job.checkpointJobId && checkpoint.backupReady, 'orchestration-schema');
      const release = await verified(job.release), prior = await cipher.open(checkpoint.jobId, checkpoint.envelope), ownerRow = await owner();
      check(release.manifest.targetSchema === 49 && same(release.manifest.migrations.map(({id,sha256}) => ({id,sha256})), snapshotCatalog.ledger) && prior.priorInstalled.schema === 46 && same(prior.priorInstalled.ledger, snapshotCatalog.ledger.slice(0,46)) && prior.backup?.verified === true && prior.backup.schema === 46 && ownerRow?.value.phase === 'closed' && ownerRow.value.jobId === job.id && prior.backup.identity?.jobId === job.id && prior.backup.identity?.epoch === ownerRow.value.epoch, 'orchestration-schema');
    }
  }
  async function verified(record) { return verifier.verify(fromBase64(record.manifest), fromBase64(record.signature)); }
  const core = createMaintenanceCore({ database, installationId, executionCapability, maintenanceCapability,
    async readRecoveryEvidence(input) {
      const current = await state(), row = await owner(), value = row?.value, job = current.job;
      return { valid: Boolean(value?.phase === 'handoff' && value.jobId === input.failedJobId && value.epoch === input.epoch && job?.id === input.recoveryJobId && job.failedJobId === input.failedJobId && job.requestId === value.recovery.requestId && job.checkpointJobId === value.checkpointJobId && !job.operation && current.checkpoint?.jobId === value.checkpointJobId && !await held()) };
    },
    async readReopenEvidence(input) {
      const current = await state(), row = await owner();
      check(row?.value.phase === 'reopening' && row.value.jobId === input.jobId && row.value.epoch === input.epoch && current.job?.id === input.jobId && terminal(current.job) && !await held(), 'orchestration-reopen');
      const release = await verified(current.release);
      const expected = freeze({ installationId, jobId: input.jobId, epoch: input.epoch, manifestSha256: release.manifestSha256, version: current.installed.version, schema: current.installed.schema });
      const evidence = await readHealthEvidence(expected);
      if (evidence?.outcome === 'pending') throw new PendingHealth();
      check(evidence?.verified === true && Object.entries(expected).every(([key, value]) => evidence[key] === value), 'orchestration-health');
      const latest = await state(); check(latest.job?.id === input.jobId && terminal(latest.job) && !await held(), 'orchestration-reopen');
      return { installationId, epoch: input.epoch, jobId: input.jobId, jobTerminal: true, healthVerified: true };
    },
  });
  async function withClosedEpoch(request, callback) {
    // One fresh primary snapshot at EACH independent adapter boundary. This is
    // not cached authority: the live hold is still conditionally bound below.
    const observed = await first('SELECT s.state_json AS engine_json,o.state_json AS owner_json,m.state,m.epoch,m.job_id AS jobId,h.hold_id AS holdId,h.operation_id AS heldOperationId FROM updater_state s JOIN updater_job_maintenance o ON o.installation_id=s.installation_id JOIN updater_maintenance m ON m.installation_id=s.installation_id JOIN updater_job_holds h ON h.installation_id=s.installation_id AND h.state=\'active\' WHERE s.id=1 AND s.installation_id=?', installationId);
    check(observed, 'orchestration-authority');
    const current = JSON.parse(observed.engine_json), row = { value: JSON.parse(observed.owner_json) }, maintenance = observed, job = current.job;
    const entry = [...live.entries()].find(([, value]) => value.jobId === job?.id && value.epoch === row?.value.epoch);
    check(entry && observed.holdId===entry[0] && row.value.phase === 'closed' && maintenance.state === 'closed' && maintenance.jobId === job.id && maintenance.epoch === row.value.epoch && row.value.jobId === job.id && request.installationId === installationId && request.operationId === job.operation?.id, 'orchestration-authority');
    const release = await verified(job.release); check(!request.manifestSha256 || request.manifestSha256 === release.manifestSha256, 'orchestration-authority');
    if(observed.heldOperationId!==request.operationId)check(await first("UPDATE updater_job_holds SET operation_id=? WHERE hold_id=? AND installation_id=? AND state='active' AND (operation_id IS NULL OR operation_id=?) RETURNING hold_id", request.operationId, entry[0], installationId, request.operationId), 'orchestration-authority');
    let backupVerified = false;
    if (current.checkpoint?.jobId === job.checkpointJobId && current.checkpoint.backupReady) { const checkpoint = await cipher.open(current.checkpoint.jobId, current.checkpoint.envelope); backupVerified = checkpoint.backup?.verified === true; }
    return callback(freeze({ installationId, jobId: job.id, operationId: job.operation.id, holdId: entry[0], epoch: row.value.epoch, state: 'closed', schema: current.installed.schema, ledger: structuredClone(current.installed.ledger), manifestSha256: release.manifestSha256, backupVerified }));
  }
  const adapters = createAdapters({ withClosedEpoch });
  const raw = createUpdaterEngine({ store, verifier, cipher, readDashboard, capability: engineCapability, installationId, adapters: { ...adapters, recoveryQuiescence: adapters.recoveryQuiescence === true, async readManifest(input) { const source = await adapters.readManifest(input), release = await verifier.verify(source.manifestBytes, source.signatureBytes); check(release.manifest.targetSchema === 49 && same(release.manifest.migrations.map(({ id, sha256 }) => ({ id, sha256 })), snapshotCatalog.ledger), 'orchestration-schema'); return source; } } });
  async function status() {
    const value = await raw.status(engineCapability), row = await owner(), maintenance = await core.status(maintenanceCapability);
    return { ...value, maintenance: { phase: row?.value.phase ?? 'open', state: maintenance.state, epoch: maintenance.epoch, blocked: Boolean(maintenance.blocker || await held()) } };
  }
  async function bind(jobId) {
    const current = await state(); await known(current); check(current.job?.id === jobId, 'job');
    const row = await owner(); if (row?.value.jobId === jobId) return row;
    const maintenance = await core.status(maintenanceCapability);
    check((!row || row.value.phase === 'open') && maintenance.state === 'open', 'orchestration-busy');
    check(await save(row, { jobId, epoch: maintenance.epoch + 1, phase: 'closing' }), 'orchestration-conflict'); return owner();
  }
  async function close(row) {
    const maintenance = await core.close(maintenanceCapability, { epoch: row.value.epoch - 1, jobId: row.value.jobId });
    await save(row, { ...row.value, phase: maintenance.state === 'closed' ? 'closed' : 'draining' }); return status();
  }
  async function handoff(row) {
    await raw.requestRecovery(engineCapability, row.value.recovery);
    const current = await state(), job = current.job;
    check(job.failedJobId === row.value.jobId && job.requestId === row.value.recovery.requestId && job.checkpointJobId === row.value.checkpointJobId && !job.operation, 'orchestration-lineage');
    if(row.value.restoreArchive)await adapters.restoreHandoff({phase:'bind',current,epoch:row.value.epoch,archiveId:row.value.restoreArchive});
    await core.handoffRecovery(maintenanceCapability, { epoch: row.value.epoch, failedJobId: row.value.jobId, recoveryJobId: job.id });
    await save(row, { jobId: job.id, epoch: row.value.epoch, phase: 'closed' }); return status();
  }
  return Object.freeze({
    executionCore: Object.freeze(Object.fromEntries(['admit', 'release', 'recordAmbiguity', 'operationStatus', 'admitWithProof', 'withProof'].map(name => [name, core[name]]))),
    async initialize(supplied, input) { authorize(supplied); const release = await verifier.verify(input.manifestBytes, input.signatureBytes); check([46,49].includes(release.manifest.targetSchema), 'orchestration-schema'); const catalog = selectSnapshotCatalog(`schema-${release.manifest.targetSchema}-v1`).catalog; check(same(input.ledger, catalog.ledger), 'orchestration-schema'); await core.initialize(maintenanceCapability); const result = await raw.initialize(engineCapability, input); await known(await state()); return result; },
    async status(supplied) { authorize(supplied); return status(); },
    async requestUpdate(supplied, request) { authorize(supplied); await known(await state()); const existing = await owner(); check(!existing || existing.value.phase === 'open' || (await state()).job?.requestId === request.requestId, 'orchestration-busy'); await raw.requestUpdate(engineCapability, request); const row = await bind((await state()).job.id); return row.value.phase === 'closing' ? close(row) : status(); },
    async advance(supplied, jobId) {
      authorize(supplied); let row = await owner();
      if (row?.value.phase === 'handoff') { check(jobId === row.value.jobId || jobId === (await state()).job?.id, 'job'); return handoff(row); }
      row = await bind(jobId);
      if (row.value.phase === 'closing') return close(row);
      if (row.value.phase === 'draining') { const result = await core.ready(maintenanceCapability, row.value.epoch); if (result.state === 'closed') await save(row, { ...row.value, phase: 'closed' }); return status(); }
      if (row.value.phase === 'open') return status();
      if (row.value.phase === 'retrying') { await raw.retryPreparation(engineCapability, row.value.retry); await save(row, { ...row.value, phase: 'closed', retry: undefined }); return status(); }
      if (row.value.phase === 'reopening') {
        try { await core.reopen(maintenanceCapability, row.value.epoch); await save(row, { ...row.value, phase: 'open' }); }
        catch (error) { if (error instanceof PendingHealth) return status(); const observed = await core.status(maintenanceCapability); if (observed.state === 'open' && observed.epoch === row.value.epoch && observed.jobId === row.value.jobId) await save(row, { ...row.value, phase: 'open' }); else { await save(row, { ...row.value, phase: 'closed' }); throw error; } }
        return status();
      }
      const current = await state(); await known(current); check(current.job?.id === jobId, 'job');
      if (terminal(current.job)) { if (current.job.status === 'failed') return status(); if (await held()) return status(); check(await save(row, { ...row.value, phase: 'reopening' }), 'orchestration-conflict'); return status(); }
      const holdId = crypto.randomUUID();
      const claimed = await first("INSERT INTO updater_job_holds(hold_id,installation_id,job_id,epoch,operation_id,state) SELECT ?,?,?,?,?,'active' WHERE EXISTS(SELECT 1 FROM updater_job_maintenance o JOIN updater_maintenance m ON m.installation_id=o.installation_id WHERE o.installation_id=? AND json_extract(o.state_json,'$.jobId')=? AND json_extract(o.state_json,'$.phase')='closed' AND json_extract(o.state_json,'$.epoch')=? AND m.state='closed' AND m.epoch=? AND m.job_id=?) AND NOT EXISTS(SELECT 1 FROM updater_job_holds WHERE installation_id=? AND state='active') RETURNING hold_id", holdId, installationId, jobId, row.value.epoch, current.job.operation?.id??null, installationId, jobId, row.value.epoch, row.value.epoch, jobId, installationId);
      if (!claimed) return status(); live.set(holdId, { jobId, epoch: row.value.epoch });
      try { await raw.advance(engineCapability, jobId); }
      finally { live.delete(holdId); await first("UPDATE updater_job_holds SET state='released' WHERE hold_id=? AND installation_id=? AND state='active' RETURNING hold_id", holdId, installationId); }
      return status();
    },
    async retryPreparation(supplied, request) { authorize(supplied); check(request && Object.keys(request).length === 2 && typeof request.jobId === 'string' && typeof request.failedOperationId === 'string', 'request'); const current = await state(); if (current.job?.id === request.jobId && current.job.lastPreparationRetry === request.failedOperationId) return status(); const publicValue = await raw.status(engineCapability); check(publicValue.job?.id === request.jobId && publicValue.job.retryPreparationOperationId === request.failedOperationId, 'preparation-retry-unavailable'); const row = await owner(); check(row?.value.phase === 'closed' && row.value.jobId === request.jobId && !await held(), 'orchestration-busy'); check(await save(row, { ...row.value, phase: 'retrying', retry: request }), 'orchestration-conflict'); await raw.retryPreparation(engineCapability, request); await save(await owner(), { ...row.value, phase: 'closed' }); return status(); },
    async requestRecovery(supplied, request) {
      authorize(supplied); check(request && Object.keys(request).length === 3 && typeof request.failedJobId === 'string' && typeof request.requestId === 'string' && /^[a-f0-9-]{36}$/.test(request.requestId), 'request'); check(request.mode === 'code-recovery' || (request.mode === 'restore' && adapters.recoveryQuiescence === true && adapters.restoreBackup && adapters.restoreHandoff), 'restore-unavailable'); let row = await owner();
      if (row?.value.phase === 'handoff') { check(same(row.value.recovery, request), 'request-conflict'); return handoff(row); }
      const current = await state();
      if (current.job?.requestId === request.requestId && current.job.failedJobId === request.failedJobId) {check(current.job.mode===request.mode,'request-conflict');return status();}
      check(row?.value.phase === 'closed' && row.value.jobId === request.failedJobId && current.job?.id === request.failedJobId && current.job.status === 'failed' && !current.job.operation && current.checkpoint?.jobId === current.job.checkpointJobId && !await held(), 'orchestration-lineage');
      const checkpoint = await cipher.open(current.checkpoint.jobId, current.checkpoint.envelope), prior = await verified(checkpoint.priorRelease);
      check(checkpoint.backup?.verified === true, 'backup-unavailable');
      if(request.mode==='code-recovery')verifier.evaluateCodeRecovery(prior, current.installed, { manifestSha256: prior.manifestSha256, sequence: prior.manifest.sequence, version: prior.manifest.version, schema: prior.manifest.targetSchema, codeRollback: checkpoint.codeRollback });
      const restoreArchive=request.mode==='restore'?await adapters.restoreHandoff({phase:'archive',current,epoch:row.value.epoch,request}):undefined;
      check(await save(row, { ...row.value, ...(restoreArchive?{restoreArchive}:{}), phase: 'handoff', recovery: structuredClone(request), checkpointJobId: current.job.checkpointJobId }), 'orchestration-conflict'); return handoff(await owner());
    },
  });
}

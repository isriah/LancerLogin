// Every query starts on the primary when D1 read replication is enabled. The
// adapter without withSession is for a primary-only binding/local SQLite tests.
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const exact = (value, keys) => value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function createMaintenanceCore({ database, installationId, executionCapability, maintenanceCapability,
  readReopenEvidence, resolveOperation = async () => null, readRecoveryEvidence = async () => null }) {
  if (!database?.prepare || !identifier(installationId) || typeof executionCapability !== 'object' || !executionCapability || typeof maintenanceCapability !== 'object' || !maintenanceCapability || executionCapability === maintenanceCapability || typeof readReopenEvidence !== 'function') throw Error('maintenance-configuration');
  const owned = new WeakSet();
  const authorize = (actual, expected) => { if (actual !== expected) throw Error('maintenance-authorization'); };
  const first = (sql, ...args) => (database.withSession ? database.withSession('first-primary') : database).prepare(sql).bind(...args).first();
  const permit = value => { if (!owned.has(value)) throw Error('maintenance-permit'); return value; };
  const epoch = value => { if (!Number.isSafeInteger(value) || value < 0) throw Error('maintenance-epoch'); };
  const state = async () => {
    const row = await first('SELECT installation_id, epoch, state, job_id AS jobId FROM updater_maintenance WHERE id=1');
    if (!row || row.installation_id !== installationId) throw Error('maintenance-installation');
    return row;
  };
  const readPermit = async id => first('SELECT permit_id AS id, epoch, state FROM updater_execution_permits WHERE installation_id=? AND permit_id=?', installationId, id);
  const proofHash = async proof => {
    if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) throw Error('maintenance-proof');
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const api = Object.freeze({
    async admitWithProof(capability, input) {
      authorize(capability, executionCapability);
      if (!exact(input, ['permitId', 'proof']) || !identifier(input.permitId)) throw Error('maintenance-request');
      const digest = await proofHash(input.proof);
      const row = await first("INSERT INTO updater_execution_permits(permit_id,installation_id,epoch,state,release_hash) SELECT ?,installation_id,epoch,'active',? FROM updater_maintenance WHERE id=1 AND installation_id=? AND state='open' ON CONFLICT(permit_id) DO NOTHING RETURNING epoch", input.permitId, digest, installationId);
      return row ? { status: 'admitted', epoch: row.epoch } : { status: 'not-admitted' };
    },
    async withProof(capability, input, action, operationId, kind) {
      authorize(capability, executionCapability);
      if (!exact(input, ['permitId', 'epoch', 'proof']) || !identifier(input.permitId)) throw Error('maintenance-request');
      epoch(input.epoch);
      const row = await first('SELECT permit_id FROM updater_execution_permits WHERE installation_id=? AND permit_id=? AND epoch=? AND release_hash=?', installationId, input.permitId, input.epoch, await proofHash(input.proof));
      if (!row) throw Error('maintenance-proof');
      const handle = Object.freeze({ id: input.permitId, epoch: input.epoch }); owned.add(handle);
      if (action === 'release') return api.release(capability, handle);
      if (action === 'ambiguity') { await api.recordAmbiguity(capability, handle, operationId, kind); return { status: 'recorded' }; }
      if (action === 'operation') return api.operationStatus(capability, handle, operationId);
      throw Error('maintenance-request');
    },
    async initialize(capability) {
      authorize(capability, maintenanceCapability);
      await first("INSERT INTO updater_maintenance(id,installation_id,epoch,state) VALUES(1,?,0,'open') ON CONFLICT(id) DO NOTHING RETURNING id", installationId);
      return state();
    },
    async admit(capability, input) {
      authorize(capability, executionCapability);
      if (!exact(input, ['permitId']) || !identifier(input.permitId)) throw Error('maintenance-request');
      const row = await first("INSERT INTO updater_execution_permits(permit_id,installation_id,epoch,state) SELECT ?,installation_id,epoch,'active' FROM updater_maintenance WHERE id=1 AND installation_id=? AND state='open' ON CONFLICT(permit_id) DO NOTHING RETURNING epoch", input.permitId, installationId);
      if (!row) return Object.freeze({ status: 'not-admitted' }); // An old identity NEVER grants a second execution.
      const handle = Object.freeze({ id: input.permitId, epoch: row.epoch });
      owned.add(handle);
      return Object.freeze({ status: 'admitted', permit: handle });
    },
    async lookup(capability, permitId) {
      authorize(capability, maintenanceCapability);
      if (!identifier(permitId)) throw Error('maintenance-request');
      return readPermit(permitId); // Diagnostics only, never an executable handle.
    },
    async status(capability) {
      authorize(capability, maintenanceCapability);
      const current = await state();
      const blocker = await first("SELECT permit_id AS permitId FROM updater_execution_permits WHERE installation_id=? AND state='active' ORDER BY permit_id LIMIT 1", installationId);
      const operation = blocker ? await first("SELECT operation_id AS operationId,kind FROM updater_execution_operations WHERE permit_id=? AND state='pending' ORDER BY operation_id LIMIT 1", blocker.permitId) : null;
      return { epoch: current.epoch, state: current.state, jobId: current.jobId, blocker: blocker ? { ...blocker, operation } : null };
    },
    async recordAmbiguity(capability, handle, operationId, kind) {
      authorize(capability, executionCapability); permit(handle);
      if (!identifier(operationId) || !identifier(kind)) throw Error('maintenance-operation');
      const row = await first("INSERT INTO updater_execution_operations(operation_id,permit_id,kind,state) SELECT ?,permit_id,?,'pending' FROM updater_execution_permits WHERE permit_id=? AND installation_id=? AND epoch=? AND state='active' ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id", operationId, kind, handle.id, installationId, handle.epoch);
      if (!row) throw Error('maintenance-operation-not-admitted');
    },
    async operationStatus(capability, handle, operationId) {
      authorize(capability, executionCapability); permit(handle);
      if (!identifier(operationId)) throw Error('maintenance-operation');
      return first('SELECT state FROM updater_execution_operations WHERE operation_id=? AND permit_id=?', operationId, handle.id);
    },
    async reconcileOperation(capability, input) {
      authorize(capability, maintenanceCapability);
      if (!exact(input, ['permitId', 'operationId']) || !identifier(input.permitId) || !identifier(input.operationId)) throw Error('maintenance-request');
      const row = await first("SELECT o.operation_id AS operationId,o.kind,p.permit_id AS permitId,p.epoch FROM updater_execution_operations o JOIN updater_execution_permits p ON p.permit_id=o.permit_id WHERE o.operation_id=? AND p.permit_id=? AND p.installation_id=? AND p.state='active' AND o.state='pending'", input.operationId, input.permitId, installationId);
      if (!row) return { status: 'unchanged' };
      const result = await resolveOperation(Object.freeze({ ...row, installationId }));
      if (!result || result.outcome !== 'complete' || result.operationId !== row.operationId || result.permitId !== row.permitId || result.epoch !== row.epoch) return { status: 'unknown' };
      await first("UPDATE updater_execution_operations SET state='complete' WHERE operation_id=? AND permit_id=? AND state='pending' RETURNING operation_id", row.operationId, row.permitId);
      return { status: 'complete' }; // Does NOT release an execution, including an orphan.
    },
    async release(capability, handle) {
      authorize(capability, executionCapability); permit(handle);
      const row = await first("UPDATE updater_execution_permits SET state='released' WHERE permit_id=? AND installation_id=? AND epoch=? AND state='active' AND NOT EXISTS(SELECT 1 FROM updater_execution_operations WHERE permit_id=? AND state='pending') RETURNING permit_id", handle.id, installationId, handle.epoch, handle.id);
      if (row) return { status: 'released' };
      const found = await readPermit(handle.id);
      return { status: found?.state === 'released' ? 'released' : 'blocked' };
    },
    async close(capability, input) {
      authorize(capability, maintenanceCapability);
      if (!exact(input, ['epoch', 'jobId']) || !identifier(input.jobId)) throw Error('maintenance-request');
      epoch(input.epoch);
      if (input.epoch === Number.MAX_SAFE_INTEGER) throw Error('maintenance-epoch');
      await first("UPDATE updater_maintenance SET epoch=epoch+1,state='draining',job_id=? WHERE id=1 AND installation_id=? AND epoch=? AND state='open' RETURNING epoch", input.jobId, installationId, input.epoch);
      const row = await state();
      if (row.epoch !== input.epoch + 1 || row.jobId !== input.jobId || row.state === 'open') throw Error('maintenance-conflict');
      return { epoch: row.epoch, state: row.state, jobId: row.jobId };
    },
    async ready(capability, expectedEpoch) {
      authorize(capability, maintenanceCapability); epoch(expectedEpoch);
      await first("UPDATE updater_maintenance SET state='closed' WHERE id=1 AND installation_id=? AND epoch=? AND state='draining' AND NOT EXISTS(SELECT 1 FROM updater_execution_permits WHERE installation_id=? AND state='active') RETURNING epoch", installationId, expectedEpoch, installationId);
      const row = await state();
      if (row.epoch !== expectedEpoch || row.state === 'open') throw Error('maintenance-conflict');
      return { epoch: row.epoch, state: row.state, jobId: row.jobId };
    },
    async handoffRecovery(capability, input) {
      authorize(capability, maintenanceCapability);
      if (!exact(input, ['epoch', 'failedJobId', 'recoveryJobId']) || !identifier(input.failedJobId) || !identifier(input.recoveryJobId)) throw Error('maintenance-request');
      epoch(input.epoch);
      const evidence = await readRecoveryEvidence(Object.freeze({ ...input, installationId }));
      if (!evidence || evidence.valid !== true) throw Error('maintenance-recovery-lineage');
      await first("UPDATE updater_maintenance SET job_id=? WHERE id=1 AND installation_id=? AND epoch=? AND state='closed' AND job_id=? AND NOT EXISTS(SELECT 1 FROM updater_execution_permits WHERE installation_id=? AND state='active') RETURNING epoch", input.recoveryJobId, installationId, input.epoch, input.failedJobId, installationId);
      const current = await state();
      if (current.epoch !== input.epoch || current.state !== 'closed' || current.jobId !== input.recoveryJobId) throw Error('maintenance-conflict');
      return { epoch: current.epoch, state: current.state, jobId: current.jobId };
    },
    async reopen(capability, expectedEpoch) {
      authorize(capability, maintenanceCapability); epoch(expectedEpoch);
      const row = await state();
      if (row.epoch !== expectedEpoch || !row.jobId) throw Error('maintenance-conflict');
      if (row.state === 'open') return { epoch: row.epoch, state: 'open' }; // Lost-ack retry; no second transition.
      if (row.state !== 'closed') throw Error('maintenance-not-drained');
      const evidence = await readReopenEvidence(Object.freeze({ installationId, epoch: row.epoch, jobId: row.jobId }));
      if (!evidence || evidence.epoch !== row.epoch || evidence.jobId !== row.jobId || evidence.installationId !== installationId || evidence.jobTerminal !== true || evidence.healthVerified !== true) throw Error('maintenance-health-required');
      const reopened = await first("UPDATE updater_maintenance SET state='open' WHERE id=1 AND installation_id=? AND epoch=? AND state='closed' AND job_id=? AND NOT EXISTS(SELECT 1 FROM updater_execution_permits WHERE installation_id=? AND state='active') RETURNING epoch", installationId, row.epoch, row.jobId, installationId);
      if (!reopened) throw Error('maintenance-conflict');
      return { epoch: row.epoch, state: 'open' };
    },
  });
  return api;
}

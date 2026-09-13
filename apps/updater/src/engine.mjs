import { fromBase64, toBase64 } from './checkpoint.mjs';

const check = (condition, code) => { if (!condition) throw Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => check(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'request');
const releaseRecord = (releaseId, bytes, signature) => ({ releaseId, manifest: toBase64(bytes), signature: toBase64(signature) });
const preparationFailed = job => job?.status === 'failed' && !job.operation && ['stageArtifact', 'captureCheckpoint', 'backup'].includes(job.steps[job.cursor]?.kind);
const publicStatus = state => ({
  installedVersion: state.installed.version, schema: state.installed.schema,
  highestSequence: state.installed.highestSequence,
  job: state.job ? {
    id: state.job.id, mode: state.job.mode, status: state.job.status,
    step: state.job.steps[state.job.cursor]?.kind ?? 'complete',
    completedSteps: state.job.cursor, totalSteps: state.job.steps.length,
    operationId: state.job.operation?.id ?? null,
    failure: state.job.failure,
    retryPreparationOperationId: preparationFailed(state.job) ? state.job.completed.at(-1).id : null,
  } : null,
  recoveryAvailable: state.job?.status === 'failed' && state.checkpoint?.jobId === state.job.checkpointJobId && state.checkpoint.backupReady === true,
});

/**
 * In-process engine, NOT an HTTP authentication boundary. The capability must
 * originate in trusted updater transport after current Admin/recovery checks.
 * Provider credentials/resource pins exist only inside adapters, never requests.
 */
export function createUpdaterEngine({ store, verifier, readDashboard, cipher, adapters, capability, installationId, randomId = () => crypto.randomUUID() }) {
  check(object(capability), 'capability');
  check(typeof readDashboard === 'function', 'dashboard-validator');
  const authorize = supplied => check(supplied === capability, 'unauthorized');
  const read = async () => { const row = await store.read(); check(row?.state.format === 1, 'not-initialized'); return row; };
  const verifyRecord = record => verifier.verify(fromBase64(record.manifest), fromBase64(record.signature));
  const persist = async (row, state) => check(await store.replace(row.revision, state), 'state-conflict');
  const checkpointValue = state => cipher.open(state.checkpoint.jobId, state.checkpoint.envelope);
  const active = job => job && ['running', 'reconciling'].includes(job.status);

  async function planUpdate(verified, state) {
    const evaluation = verifier.evaluateUpdate(verified, state.installed);
    const prior = await verifyRecord(state.release);
    const old = prior.manifest.compatibility, target = verified.manifest;
    // Until maintenance orchestration is implemented, fail before any mutation.
    check(target.targetSchema >= old.apiSchema.min && target.targetSchema <= old.apiSchema.max && target.compatibility.apiVersion >= old.frontendApi.min && target.compatibility.apiVersion <= old.frontendApi.max, 'maintenance-required');
    return [
      ...target.artifacts.map(artifact => ({ kind: 'stageArtifact', name: artifact.name })),
      { kind: 'captureCheckpoint' }, { kind: 'backup' },
      ...evaluation.migrations.map(migration => ({ kind: 'applyMigration', name: migration.artifact })),
      { kind: 'deployApi' }, { kind: 'deployPages' }, { kind: 'health' },
    ];
  }

  async function contextFor(state, step, verified) {
    const job = state.job;
    const context = {
      installationId, jobId: job.id, releaseId: job.release.releaseId,
      manifestSha256: verified.manifestSha256, manifest: verified.manifest,
      installed: structuredClone(state.installed),
    };
    if (step.name) context.artifact = verified.manifest.artifacts.find(artifact => artifact.name === step.name);
    if (step.kind === 'applyMigration') context.migration = verified.manifest.migrations.find(migration => migration.artifact === step.name);
    if (step.kind === 'stageArtifact') {
      const bytes = job.mode === 'update'
        ? await adapters.readArtifact({ ...context })
        : await adapters.readRecoveryArtifact({ ...context, checkpoint: await checkpointValue(state) });
      context.bytes = await verifier.verifyArtifact(verified, step.name, bytes);
      if (context.artifact.role === 'dashboard') readDashboard(context.bytes);
    }
    if (['applyMigration', 'deployApi', 'deployPages'].includes(step.kind)) {
      const artifact = context.artifact ?? verified.manifest.artifacts.find(artifact => artifact.role === (step.kind === 'deployApi' ? 'api' : 'dashboard'));
      context.artifact = artifact;
      const bytes = await adapters.readStagedArtifact({ ...context });
      context.bytes = await verifier.verifyArtifact(verified, artifact.name, bytes);
      if (artifact.role === 'dashboard') readDashboard(context.bytes);
    }
    if (state.checkpoint && step.kind !== 'stageArtifact') context.checkpoint = await checkpointValue(state);
    return context;
  }

  function validateReceipt(step, verified, state, receipt) {
    check(object(receipt), 'operation-receipt');
    if (step.kind === 'stageArtifact') {
      const descriptor = verified.manifest.artifacts.find(item => item.name === step.name);
      check(receipt.name === step.name && receipt.sha256 === descriptor.sha256 && receipt.manifestSha256 === verified.manifestSha256, 'stage-receipt');
    } else if (step.kind === 'captureCheckpoint') {
      check(object(receipt.priorCode) && object(receipt.configuration), 'checkpoint-receipt');
    } else if (step.kind === 'backup') {
      check(receipt.verified === true && receipt.schema === state.installed.schema && typeof receipt.backupId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(receipt.backupId) && /^[a-f0-9]{64}$/.test(receipt.sha256), 'backup-receipt');
    } else if (step.kind === 'applyMigration') {
      const migration = verified.manifest.migrations.find(item => item.artifact === step.name);
      check(receipt.id === migration.id && receipt.sha256 === migration.sha256 && receipt.fromSchema === state.installed.schema && receipt.toSchema === migration.toSchema, 'migration-receipt');
    } else if (['deployApi', 'deployPages'].includes(step.kind)) {
      check(receipt.manifestSha256 === verified.manifestSha256, 'deployment-receipt');
    } else if (step.kind === 'health') {
      check(receipt.version === verified.manifest.version && receipt.schema === state.installed.schema && receipt.manifestSha256 === verified.manifestSha256, 'health-receipt');
    }
  }

  async function finish(operationId, result) {
    const row = await read(), state = row.state, job = state.job;
    // Another caller may already have reconciled this exact operation.
    if (!job || job.operation?.id !== operationId || !active(job)) return publicStatus(state);
    const step = job.steps[job.cursor];
    const verified = await verifyRecord(job.release);
    if (result?.outcome === 'applied') {
      try {
        validateReceipt(step, verified, state, result.receipt);
        if (step.kind === 'captureCheckpoint') {
          const checkpoint = { priorInstalled: state.installed, priorRelease: state.release, codeRollback: verified.manifest.codeRollback, provider: result.receipt, backup: null };
          state.checkpoint = { jobId: job.id, backupReady: false, envelope: await cipher.seal(job.id, checkpoint) };
        } else if (step.kind === 'backup') {
          const checkpoint = await checkpointValue(state);
          checkpoint.backup = result.receipt;
          state.checkpoint.envelope = await cipher.seal(state.checkpoint.jobId, checkpoint);
          state.checkpoint.backupReady = true;
        } else if (step.kind === 'applyMigration') {
          const migration = verified.manifest.migrations.find(item => item.artifact === step.name);
          state.installed.schema = migration.toSchema;
          state.installed.ledger.push({ id: migration.id, sha256: migration.sha256 });
        } else if (step.kind === 'restoreBackup') {
          const checkpoint = await checkpointValue(state);
          check(result.receipt.backupId === checkpoint.backup.backupId && result.receipt.sha256 === checkpoint.backup.sha256 && result.receipt.schema === checkpoint.priorInstalled.schema, 'restore-receipt');
          state.installed.schema = checkpoint.priorInstalled.schema;
          state.installed.ledger = checkpoint.priorInstalled.ledger;
        }
        job.completed.push({ id: operationId, kind: step.kind });
        job.operation = null;
        job.cursor++;
        job.status = 'running';
        job.failure = null;
        if (job.cursor === job.steps.length) {
          state.installed.version = verified.manifest.version;
          state.release = job.release;
          job.status = job.mode === 'update' ? 'succeeded' : 'recovered';
        }
      } catch {
        // Even malformed success is ambiguous: the provider may have mutated.
        job.status = 'reconciling'; job.failure = 'receipt-unverified';
        job.operation.state = 'unknown';
      }
    } else if (result?.outcome === 'pending' && typeof adapters.continueOperation === 'function') {
      // A trusted adapter may acknowledge a durable bounded substep without
      // completing the whole engine operation. Unknown dispatches cannot enter
      // this state unless read-only reconciliation proves safe continuation.
      job.status = 'running'; job.failure = null; job.operation.state = 'pending';
    } else if (result?.outcome === 'failed' && result.terminal === true) {
      // Adapters may return this only for a definitive provider rejection or an
      // identity-bound terminal failed operation, never a timeout/empty lookup.
      job.status = 'failed'; job.failure = 'operation-failed';
      job.completed.push({ id: operationId, kind: step.kind, failed: true });
      job.operation = null;
    } else {
      job.status = 'reconciling'; job.failure = 'acknowledgment-unknown';
      job.operation.state = 'unknown';
    }
    if (!await store.replace(row.revision, state)) return publicStatus((await read()).state);
    return publicStatus(state);
  }

  return Object.freeze({
    async initialize(supplied, { releaseId, manifestBytes, signatureBytes, updaterVersion, ledger }) {
      authorize(supplied);
      check(Number.isSafeInteger(releaseId) && releaseId > 0, 'release-id');
      const bytes = Uint8Array.from(manifestBytes), signature = Uint8Array.from(signatureBytes);
      const verified = await verifier.verify(bytes, signature), manifest = verified.manifest;
      check(typeof updaterVersion === 'string' && /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(updaterVersion), 'updater-version');
      check(JSON.stringify(ledger) === JSON.stringify(manifest.migrations.map(({ id, sha256 }) => ({ id, sha256 }))), 'installed-ledger');
      const state = {
        format: 1, installed: { version: manifest.version, schema: manifest.targetSchema, updaterVersion, highestSequence: manifest.sequence, ledger: structuredClone(ledger) },
        release: releaseRecord(releaseId, bytes, signature), job: null, checkpoint: null,
      };
      check(await store.initialize(state), 'already-initialized');
      return publicStatus(state);
    },
    async status(supplied) { authorize(supplied); return publicStatus((await read()).state); },
    async requestUpdate(supplied, request) {
      authorize(supplied); exact(request, ['releaseId', 'requestId']);
      check(Number.isSafeInteger(request.releaseId) && request.releaseId > 0 && typeof request.requestId === 'string' && /^[a-f0-9-]{36}$/.test(request.requestId), 'request');
      request = { releaseId: request.releaseId, requestId: request.requestId };
      const row = await read(), state = row.state;
      if (state.job?.requestId === request.requestId) {
        check(state.job.mode === 'update' && state.job.release.releaseId === request.releaseId, 'request-conflict');
        return publicStatus(state);
      }
      check(!state.job || ['succeeded', 'recovered'].includes(state.job.status), 'update-busy');
      const source = await adapters.readManifest({ releaseId: request.releaseId });
      const bytes = Uint8Array.from(source.manifestBytes), signature = Uint8Array.from(source.signatureBytes);
      const verified = await verifier.verify(bytes, signature);
      const steps = await planUpdate(verified, state);
      state.installed.highestSequence = verified.manifest.sequence;
      const id = randomId();
      state.job = { id, checkpointJobId: id, requestId: request.requestId, mode: 'update', status: 'running', release: releaseRecord(request.releaseId, bytes, signature), cursor: 0, steps, operation: null, completed: [], failure: null };
      await persist(row, state);
      return publicStatus(state);
    },
    async requestRecovery(supplied, request) {
      authorize(supplied); exact(request, ['failedJobId', 'mode', 'requestId']);
      check(['code-recovery', 'restore'].includes(request.mode) && typeof request.requestId === 'string' && /^[a-f0-9-]{36}$/.test(request.requestId), 'request');
      request = { failedJobId: request.failedJobId, mode: request.mode, requestId: request.requestId };
      const row = await read(), state = row.state;
      if (state.job?.requestId === request.requestId) {
        check(state.job.mode === request.mode && state.job.failedJobId === request.failedJobId, 'request-conflict');
        return publicStatus(state);
      }
      check(state.job?.id === request.failedJobId && state.job.status === 'failed' && !state.job.operation && state.checkpoint?.jobId === state.job.checkpointJobId, 'recovery-unavailable');
      const checkpoint = await checkpointValue(state), prior = await verifyRecord(checkpoint.priorRelease);
      check(checkpoint.backup?.verified === true, 'backup-unavailable');
      if (request.mode === 'code-recovery') {
        verifier.evaluateCodeRecovery(prior, state.installed, { manifestSha256: prior.manifestSha256, sequence: prior.manifest.sequence, version: prior.manifest.version, schema: prior.manifest.targetSchema, codeRollback: checkpoint.codeRollback });
      } else {
        // Database restoration is destructive and requires this separately
        // authorized engine call plus trusted transport confirmation. The adapter
        // must quiesce app writes for restore through final health/reopening.
        check(adapters.restoreBackup && adapters.recoveryQuiescence === true, 'restore-unavailable');
      }
      state.job = {
        id: randomId(), checkpointJobId: state.checkpoint.jobId, requestId: request.requestId, failedJobId: request.failedJobId,
        mode: request.mode, status: 'running', release: checkpoint.priorRelease,
        cursor: 0, operation: null, completed: [], failure: null,
        steps: [
          ...prior.manifest.artifacts.filter(artifact => artifact.role !== 'migration').map(artifact => ({ kind: 'stageArtifact', name: artifact.name })),
          ...(request.mode === 'restore' ? [{ kind: 'restoreBackup' }] : []),
          // The prior frontend already proved compatibility with both APIs on
          // admission, so restore it before restoring the prior API.
          { kind: 'deployPages' }, { kind: 'deployApi' }, { kind: 'health' },
        ],
      };
      await persist(row, state);
      return publicStatus(state);
    },
    async retryPreparation(supplied, request) {
      authorize(supplied); exact(request, ['jobId', 'failedOperationId']);
      const { jobId, failedOperationId } = request;
      check(typeof jobId === 'string' && typeof failedOperationId === 'string', 'request');
      const row = await read(), state = row.state, job = state.job;
      check(job?.id === jobId, 'job');
      // Replaying the explicit retry must never clear a later operation/failure.
      if (job.lastPreparationRetry === failedOperationId) return publicStatus(state);
      check(preparationFailed(job) && job.completed.at(-1)?.id === failedOperationId && job.completed.at(-1)?.failed === true, 'preparation-retry-unavailable');
      job.lastPreparationRetry = failedOperationId;
      job.status = 'running'; job.failure = null;
      // Keep the exact release, cursor, installed ledger and sequence. The next
      // advance claims a new operation only after this confirmed rejection.
      await persist(row, state);
      return publicStatus(state);
    },
    async advance(supplied, jobId) {
      authorize(supplied);
      const row = await read(), state = row.state, job = state.job;
      check(job?.id === jobId, 'job');
      if (!active(job)) return publicStatus(state);
      const step = job.steps[job.cursor];
      if (job.operation) {
        if (job.operation.state === 'pending') {
          let result;
          try {
            const verified = await verifyRecord(job.release);
            const context = await contextFor(state, step, verified);
            result = await adapters.continueOperation({ ...context, operationId: job.operation.id, kind: step.kind });
          } catch { result = { outcome: 'unknown' }; }
          return finish(job.operation.id, result);
        }
        // Readback only. Neither lease expiry nor process restart authorizes a
        // second dispatch. Empty/negative readback must remain unknown.
        let result;
        try {
          const verified = await verifyRecord(job.release);
          result = await adapters.reconcile({ installationId, jobId, operationId: job.operation.id, kind: step.kind, name: step.name, manifestSha256: verified.manifestSha256, manifest: verified.manifest });
        } catch { result = { outcome: 'unknown' }; }
        return finish(job.operation.id, result);
      }
      const verified = await verifyRecord(job.release);
      // Downloads/readback and cryptographic checks happen before ownership. A
      // contender that loses the CAS cannot issue the mutating adapter call.
      const context = await contextFor(state, step, verified);
      const operationId = randomId();
      job.operation = { id: operationId, kind: step.kind, state: 'dispatched' };
      if (!await store.replace(row.revision, state)) return publicStatus((await read()).state);
      let result;
      try { result = await adapters[step.kind]({ ...context, operationId }); }
      catch { result = { outcome: 'unknown' }; }
      return finish(operationId, result);
    },
  });
}

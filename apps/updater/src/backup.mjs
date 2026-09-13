import { createSnapshotCapture } from './snapshot-capture.mjs';
import { createSnapshotReplay } from './snapshot-replay.mjs';
import { selectSnapshotCatalog } from './snapshot-catalog-registry.mjs';
const check = (ok) => { if (!ok) throw Error('backup-identity'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// Composition pins are bootstrap-owned. Completed validation generations may be reused under closed-epoch authority.
export function createVerifiedBackup({ pins: supplied, applicationDatabase, validationDatabase, store, withClosedEpoch }) {
  const pins = structuredClone(supplied), capability = {};
  const { validationDatabaseId, ...capturePins } = pins;
  const catalogs = new Map([46,49].map(schema => {
    const catalogKey = `schema-${schema}-v1`, { catalog, catalogSha256 } = selectSnapshotCatalog(catalogKey);
    const capture = createSnapshotCapture({ pins: capturePins, database: applicationDatabase, store, withClosedEpoch, catalogKey });
    const replay = createSnapshotReplay({ pins, database: validationDatabase, store, capture, capability, catalogKey, withClosedEpoch });
    return [schema, { catalog, catalogSha256, capture, replay }];
  }));
  async function run(context, readOnly) {
    try {
      check(context?.installationId === pins.installationId && uuid(context.jobId) && uuid(context.operationId) && /^[a-f0-9]{64}$/.test(context.manifestSha256) && (!context.kind || context.kind === 'backup'));
      return await withClosedEpoch({ installationId: pins.installationId, operationId: context.operationId, manifestSha256: context.manifestSha256 }, async authority => {
        check(catalogs.has(authority?.schema));
        const { catalog: snapshotCatalog, catalogSha256, capture, replay } = catalogs.get(authority.schema), schema = authority.schema;
        check(authority?.installationId === pins.installationId && authority.jobId === context.jobId && authority.operationId === context.operationId && authority.manifestSha256 === context.manifestSha256 && authority.state === 'closed' && Number.isSafeInteger(authority.epoch) && authority.epoch > 0 && same(authority.ledger, snapshotCatalog.ledger));
        const identity = { ...pins, operationId: context.operationId, jobId: context.jobId, epoch: authority.epoch, releaseManifestSha256: authority.manifestSha256, schema, catalogSha256 };
        const key = `backup:${context.operationId}`;
        let row = await store.operation(key);
        if (!row) {
          if (readOnly) return { outcome: 'unknown' };
          if (!await store.claim(key, { identity, phase: 'capture' })) return { outcome: 'unknown' };
          return { outcome: 'pending' };
        }
        check(same(row.value.identity, identity));
        if (row.value.phase === 'capture') {
          if (readOnly) {
            // Only updater-owned capture CAS/chunks can run here. Validation has
            // not begun; no unknown target dispatch can be reclassified.
            return { outcome: 'pending' };
          }
          const result = await capture.advance(context.operationId);
          if (result.outcome !== 'snapshot-candidate') return result.outcome === 'pending' ? { outcome: 'pending' } : { outcome: 'unknown' };
          const manifest = await capture.describe(context.operationId);
          check(manifest.identity.jobId === identity.jobId && manifest.identity.epoch === identity.epoch);
          return await store.replace(key, row.revision, { identity, phase: 'validate', manifestSha256: manifest.manifestSha256 }) ? { outcome: 'pending' } : { outcome: 'unknown' };
        }
        check(['validate', 'complete'].includes(row.value.phase));
        return await capture.withReader(context.operationId, async reader => {
        const manifest = await capture.describe(context.operationId, reader);
        check(manifest.manifestSha256 === row.value.manifestSha256 && manifest.identity.jobId === identity.jobId && manifest.identity.epoch === identity.epoch && manifest.schema === schema && manifest.catalogSha256 === catalogSha256 && manifest.chainSha256 === snapshotCatalog.chainSha256);
        // Reconciliation includes any durable target-generation adoption/cleanup.
        const result = await replay[readOnly || row.value.phase === 'complete' ? 'reconcile' : 'advance'](capability, { operationId: context.operationId, snapshotId: context.operationId }, reader);
        if (result.outcome !== 'validated') return result.outcome === 'pending' ? { outcome: 'pending' } : { outcome: 'unknown' };
        const expected = { format: 'typed-replay-v1', ...pins, operationId: context.operationId, snapshotId: context.operationId, manifestSha256: manifest.manifestSha256, catalogSha256, schema, chainSha256: snapshotCatalog.chainSha256 };
        check(same(result.receipt, expected));
        const receipt = { backupId: context.operationId, sha256: manifest.manifestSha256, schema, verified: true, identity, validation: expected };
        if (row.value.phase === 'complete') { check(same(row.value.receipt, receipt)); return { outcome: 'applied', receipt }; }
        // Read-only reconciliation can prove continuation, but cannot save the
        // adapter's final receipt or promote the engine operation itself yet.
        if (readOnly) return { outcome: 'pending' };
        return await store.replace(key, row.revision, { ...row.value, phase: 'complete', receipt }) ? { outcome: 'applied', receipt } : { outcome: 'unknown' };
        });
      });
    } catch { return { outcome: 'unknown' }; }
  }
  return Object.freeze({ backup: context => run(context, false), continueOperation: context => run(context, false), reconcile: context => run(context, true) });
}

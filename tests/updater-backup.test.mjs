import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createVerifiedBackup } from '../apps/updater/src/backup.mjs';
import { createSnapshotReplay } from '../apps/updater/src/snapshot-replay.mjs';
import { createSnapshotCapture } from '../apps/updater/src/snapshot-capture.mjs';
import { snapshotCatalog } from '../apps/updater/src/snapshot-catalog.mjs';

test('actual capture and isolated replay compose a restart-safe engine backup receipt', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("synthetic")}}', compatibilityDate: '2026-08-01', d1Databases: ['APP','VALIDATION','ABSENT'] })); t.after(() => mf.dispose());
  const app = await mf.getD1Database('APP'), target = await mf.getD1Database('VALIDATION');
  const schema = [...snapshotCatalog.objects.filter(o => o.type === 'table' && o.name !== 'sqlite_sequence'), ...snapshotCatalog.objects.filter(o => o.type !== 'table' && o.sql)];
  for (let i = 0; i < schema.length; i += 20) await app.batch(schema.slice(i, i + 20).map(o => app.prepare(o.sql)));
  await app.batch(snapshotCatalog.ledger.map(entry => app.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(entry.id)));
  await app.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026','local')").run();
  await app.prepare("INSERT INTO public_hour_admission_clock VALUES('primary',9223372036854775807)").run();
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close()); sqlite.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql', import.meta.url), 'utf8'));
  let queries = 0, batches = 0, lost = false;
  const database = { prepare(sql) { let params = []; return { bind(...values) { params = values; return this; }, async first() { queries++; return sqlite.prepare(sql).get(...params) ?? null; }, async all() { queries++; return { results: sqlite.prepare(sql).all(...params) }; } }; } };
  const pins = { installationId: 'synthetic-backup', applicationDatabaseId: crypto.randomUUID(), updaterDatabaseId: crypto.randomUUID(), validationDatabaseId: crypto.randomUUID() };
  const store = createArtifactStore({ database, installationId: pins.installationId, cipher: await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)), pins.installationId) });
  const context = { installationId: pins.installationId, operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), manifestSha256: 'a'.repeat(64), kind: 'backup' };
  const authority = { ...context, state: 'closed', epoch: 1, schema: 49, ledger: snapshotCatalog.ledger };
  const withClosedEpoch = async (request, callback) => { assert.equal(request.operationId, authority.operationId); assert.equal(request.installationId, authority.installationId); return callback(structuredClone(authority)); };
  const validation = { withSession(mode) { assert.equal(mode, 'first-primary'); return this; }, prepare(sql) { queries++; return target.prepare(sql); }, async batch(statements) { batches++; await target.batch(statements); if (!lost) { lost = true; throw Error('lost claim acknowledgment'); } } };
  const build = () => createVerifiedBackup({ pins, applicationDatabase: { prepare(sql) { queries++; return app.prepare(sql); } }, validationDatabase: validation, store, withClosedEpoch });
  const changes = () => sqlite.prepare('SELECT total_changes() AS n').get().n;
  async function reconcile() { const writes = changes(), dispatches = batches; const result = await build().reconcile(context); assert.equal(changes(), writes, 'reconciliation writes no updater rows'); assert.equal(batches, dispatches, 'reconciliation never mutates validation target'); return result; }
  assert.equal((await reconcile()).outcome, 'unknown');
  assert.equal((await build().backup(context)).outcome, 'pending');
  authority.epoch++; assert.equal((await build().continueOperation(context)).outcome, 'unknown'); authority.epoch--;
  assert.equal((await build().continueOperation({ ...context, jobId: crypto.randomUUID() })).outcome, 'unknown');
  assert.equal((await build().continueOperation({ ...context, manifestSha256: 'b'.repeat(64) })).outcome, 'unknown');
  let result, maxQueries = 0;
  for (let i = 0; i < 400; i++) {
    queries = 0; result = await build().continueOperation(context); maxQueries = Math.max(maxQueries, queries); assert.ok(queries <= 50, `whole adapter query bound ${queries}`);
    if (result.outcome === 'applied') break;
    if (result.outcome === 'unknown') assert.equal((await reconcile()).outcome, 'pending');
    else assert.equal(result.outcome, 'pending');
  }
  assert.equal(result.outcome, 'applied'); assert.ok(lost); assert.equal(result.receipt.verified, true); assert.equal(result.receipt.schema, 49); assert.equal(result.receipt.backupId, context.operationId);
  const captureRow = await store.operation(`snapshot:${context.operationId}`); assert.equal(result.receipt.sha256, captureRow.value.manifestSha256); assert.equal(result.receipt.identity.epoch, 1);
  assert.deepEqual(await reconcile(), result); authority.epoch++; assert.equal((await reconcile()).outcome, 'unknown'); authority.epoch--;
  const { validationDatabaseId, ...capturePins } = pins;
  const capture = createSnapshotCapture({ pins: capturePins, database: app, store, withClosedEpoch });
  const absent = await mf.getD1Database('ABSENT'), cap = {}, replayId = crypto.randomUUID(); let absentBatches = 0;
  const replay = createSnapshotReplay({ pins: { ...pins, validationDatabaseId: crypto.randomUUID() }, database: { prepare: sql => absent.prepare(sql), async batch() { absentBatches++; throw Error('never acknowledged'); } }, store, capture, capability: cap });
  const input = { operationId: replayId, snapshotId: context.operationId };
  assert.equal((await replay.advance(cap, input)).outcome, 'unknown'); const written = changes();
  for (let i = 0; i < 2; i++) assert.equal((await replay.reconcile(cap, input)).outcome, 'unknown');
  assert.equal(changes(), written); assert.equal(absentBatches, 1);
  const replayRow = await store.operation(`snapshot-replay:${context.operationId}`), forged = structuredClone(replayRow.value); forged.identity.validationDatabaseId = crypto.randomUUID(); await store.replace(`snapshot-replay:${context.operationId}`, replayRow.revision, forged);
  assert.equal((await reconcile()).outcome, 'unknown');
  t.diagnostic(`Maximum whole adapter statements per advance: ${maxQueries}`);
});

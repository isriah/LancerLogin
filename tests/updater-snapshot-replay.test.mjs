import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createSnapshotCapture } from '../apps/updater/src/snapshot-capture.mjs';
import { createSnapshotReplay } from '../apps/updater/src/snapshot-replay.mjs';
import { snapshotCatalog } from '../apps/updater/src/snapshot-catalog.mjs';

test('isolated schema49 replay, typed fidelity, durable acknowledgment and rejection boundaries', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("synthetic")}}', compatibilityDate: '2026-08-01', d1Databases: ['SOURCE','GOOD','ABSENT','OWNER','EXTRA','TAMPER'] }));
  t.after(() => mf.dispose()); const source = await mf.getD1Database('SOURCE');
  const sql = [...snapshotCatalog.objects.filter(o => o.type === 'table' && o.name !== 'sqlite_sequence'), ...snapshotCatalog.objects.filter(o => o.type !== 'table' && o.sql)].map(o => o.sql);
  for (let i = 0; i < sql.length; i += 20) await source.batch(sql.slice(i, i + 20).map(sql => source.prepare(sql)));
  await source.batch(snapshotCatalog.ledger.map(entry => source.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(entry.id)));
  await source.batch([
    source.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='d1_migrations'"),
    source.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026','local'),('secondary','2026','local')"),
    source.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','1','Synthetic','Member','2026')"),
    source.prepare("INSERT INTO users(id,installation_id,local_username,created_at,member_id,role) VALUES('user','primary','synthetic','2026','member','admin')"),
    source.prepare("INSERT INTO platform_module_grants(installation_id,user_id) VALUES('primary','user')"),
    source.prepare("INSERT INTO public_hour_admission_clock(rowid,installation_id,last_seen_ms) VALUES(-9223372036854775808,'primary',9223372036854775807),(9223372036854775807,'secondary',0.1)"),
    source.prepare("INSERT INTO audit_log(rowid,id,installation_id,action,target_type,target_id,metadata_json,created_at) VALUES(-1,'audit','primary','synthetic','synthetic',CAST(X'610062' AS TEXT),X'00FF','2026'),(2,'audit2','primary','synthetic','synthetic',NULL,'unicode 🌱','2026')")
  ]);
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close()); sqlite.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql', import.meta.url), 'utf8'));
  let queries = 0, maxQueries = 0;
  const state = { prepare(sql) { let params = []; return { bind(...values) { params = values; return this; }, async first() { queries++; return sqlite.prepare(sql).get(...params) ?? null; }, async all() { queries++; return { results: sqlite.prepare(sql).all(...params) }; } }; } };
  const store = createArtifactStore({ database: state, installationId: 'synthetic-replay', cipher: await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)), 'synthetic-replay') });
  const pins = { installationId: 'synthetic-replay', applicationDatabaseId: '11111111-1111-4111-8111-111111111111', updaterDatabaseId: '22222222-2222-4222-8222-222222222222' };
  const snapshotId = crypto.randomUUID(), authority = { ...pins, operationId: snapshotId, jobId: crypto.randomUUID(), epoch: 1, state: 'closed', schema: 49, ledger: snapshotCatalog.ledger };
  const capture = createSnapshotCapture({ pins, database: source, store, withClosedEpoch: async (_, run) => run(authority) });
  let captured; for (let i = 0; i < 400; i++) { captured = await capture.advance(snapshotId); if (captured.outcome === 'snapshot-candidate') break; }
  assert.equal(captured.outcome, 'snapshot-candidate'); assert.equal(captured.candidate.verified, false);
  async function fixture(name, customCapture = capture) {
    const db = await mf.getD1Database(name), capability = {}, operationId = crypto.randomUUID(); let batches = 0, hook;
    const wrapper = { withSession(mode) { assert.equal(mode, 'first-primary'); return this; }, prepare(sql) { queries++; return db.prepare(sql); }, async batch(statements) { batches++; if (hook) return hook(statements); return db.batch(statements); } };
    const replay = createSnapshotReplay({ pins: { ...pins, validationDatabaseId: crypto.randomUUID() }, database: wrapper, store, capture: customCapture, capability });
    return { db, operationId, batches: () => batches, hook: value => { hook = value; }, async advance() { queries = 0; const result = await replay.advance(capability, { operationId, snapshotId }); maxQueries = Math.max(maxQueries, queries); assert.ok(queries <= 50, `combined source accessor/store/target statements ${queries}`); return result; }, replay };
  }
  async function finish(f, before) { let result; for (let i = 0; i < 300; i++) { if (before) await before(); result = await f.advance(); if (['validated','rejected'].includes(result.outcome)) return result; assert.notEqual(result.outcome, 'unknown', JSON.stringify(await store.operation(`snapshot-replay:${f.operationId}`))); } throw Error(`unfinished ${JSON.stringify(result)}`); }
  await t.test('full schema, FK order, rowids, int64, REAL, text/blob and sequence survive lost batch acknowledgment', async () => {
    const f = await fixture('GOOD'); await f.advance(); await f.advance();
    let lost = false; f.hook(async statements => { await f.db.batch(statements); if (!lost) { lost = true; throw Error('lost acknowledgment'); } });
    assert.equal((await f.advance()).outcome, 'unknown'); const count = f.batches(); assert.equal((await f.advance()).outcome, 'pending'); assert.equal(f.batches(), count);
    const result = await finish(f); assert.equal(result.outcome, 'validated'); assert.equal(result.receipt.format, 'typed-replay-v1'); assert.equal(result.receipt.verified, undefined);
    assert.equal((await f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='d1_migrations'").first()).seq, 900);
    assert.equal((await f.db.prepare("SELECT hex(target_id) AS text,hex(metadata_json) AS blob FROM audit_log WHERE id='audit'").first()).text, '610062');
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM platform_module_grants").first()).n, 1);
  });
  await t.test('absent receipt remains unknown and never redispatches', async () => {
    const f = await fixture('ABSENT'); await f.advance(); await f.advance(); f.hook(async () => { throw Error('dropped before dispatch'); });
    assert.equal((await f.advance()).outcome, 'unknown'); const count = f.batches(); for (let i = 0; i < 3; i++) assert.equal((await f.advance()).outcome, 'unknown'); assert.equal(f.batches(), count);
  });
  await t.test('wrong owner races abort the entire mutation batch', async () => {
    const f = await fixture('OWNER'); await f.advance(); await f.advance();
    f.hook(async statements => { await f.db.prepare("UPDATE _ll_snapshot_owner SET owner='wrong'").run(); return f.db.batch(statements); });
    assert.equal((await f.advance()).outcome, 'unknown'); assert.equal((await f.advance()).reason, 'validation-owner');
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM _ll_snapshot_steps').first()).n, 0);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='audit_log'").first()).n, 0);
  });
  await t.test('extra deployed rows cannot pass canonical trailing readback', async () => {
    const f = await fixture('EXTRA'); let added = false;
    const result = await finish(f, async () => { const current = await store.operation(`snapshot-replay:${f.operationId}`); if (!added && current?.value.cursor.phase === 'compare') { added = true; await f.db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('extra','2026','local')").run(); } });
    assert.ok(added); assert.equal(result.reason, 'validation-data');
  });
  await t.test('sealed manifest tampering is rejected and resource/capability overrides fail before queries', async () => {
    const f = await fixture('TAMPER'); await assert.rejects(() => f.replay.advance({}, { operationId: f.operationId, snapshotId }), /authorization/);
    assert.throws(() => createSnapshotReplay({ pins: { ...pins, validationDatabaseId: pins.applicationDatabaseId }, capability: {} }), /pins/);
    const old = await store.operation(`snapshot:${snapshotId}`), value = structuredClone(old.value); value.pages[0].sha256 = '0'.repeat(64); await store.replace(`snapshot:${snapshotId}`, old.revision, value);
    await assert.rejects(() => capture.describe(snapshotId)); assert.equal((await f.advance()).outcome, 'rejected'); assert.equal(f.batches(), 0);
  });
  t.diagnostic(`Maximum combined statements per replay advance: ${maxQueries}`);
});

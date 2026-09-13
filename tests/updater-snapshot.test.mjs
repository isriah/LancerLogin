import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createSnapshotCapture } from '../apps/updater/src/snapshot-capture.mjs';
import { snapshotCatalog } from '../apps/updater/src/snapshot-catalog.mjs';
import { typedPageQuery, encodeTypedPage, SNAPSHOT_LIMITS } from '../apps/updater/src/snapshot-codec.mjs';
async function d1(t) { const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("synthetic")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] })); t.after(() => mf.dispose()); return mf.getD1Database('DB'); }
async function setup(t) {
  const db = await d1(t);
  const sql = [...snapshotCatalog.objects.filter(o => o.type === 'table' && o.name !== 'sqlite_sequence'), ...snapshotCatalog.objects.filter(o => o.type !== 'table' && o.sql)].map(o => o.sql);
  for (let start = 0; start < sql.length; start += 20) await db.batch(sql.slice(start, start + 20).map(sql => db.prepare(sql)));
  await db.batch(snapshotCatalog.ledger.map(entry => db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(entry.id)));
  await db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local')").run();
  await db.prepare("INSERT INTO public_hour_admission_clock VALUES('primary',9223372036854775807)").run();
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close()); sqlite.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql', import.meta.url), 'utf8'));
  let queries = 0;
  const state = { prepare(sql) { let params = []; return { bind(...values) { params = values; return this; }, async first() { queries++; return sqlite.prepare(sql).get(...params) ?? null; }, async all() { queries++; return { results: sqlite.prepare(sql).all(...params) }; } }; } };
  const store = createArtifactStore({ database: state, installationId: 'synthetic-snapshot', cipher: await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)), 'synthetic-snapshot') });
  const pins = { installationId: 'synthetic-snapshot', applicationDatabaseId: '11111111-1111-4111-8111-111111111111', updaterDatabaseId: '22222222-2222-4222-8222-222222222222' };
  const id = crypto.randomUUID(), authority = { installationId: pins.installationId, operationId: id, jobId: crypto.randomUUID(), epoch: 1, state: 'closed', schema: 49, ledger: snapshotCatalog.ledger };
  const binding = { prepare(sql) { queries++; return db.prepare(sql); } };
  const build = (custom = store) => createSnapshotCapture({ pins, database: binding, store: custom, withClosedEpoch: async (_, run) => run(structuredClone(authority)) });
  return { db, store, sqlite, id, authority, build, budget() { const value = queries; queries = 0; return value; } };
}
test('actual D1 typed projection preserves int64, negative/min/max rowids, binary/text/NULL and REAL without numeric transport', async t => {
  const db = await d1(t); await db.prepare('CREATE TABLE edge(i,t,b,r,n)').run();
  await db.prepare("INSERT INTO edge(rowid,i,t,b,r,n) VALUES(-9223372036854775808,9223372036854775807,CAST(X'610062' AS TEXT),X'00FF',0.1,NULL),(-1,-9223372036854775808,'unicode 🌱',X'',1.2345678901234567,NULL),(9223372036854775807,0,'last',NULL,0.0,NULL)").run();
  const table = { name: 'edge', columns: ['i', 't', 'b', 'r', 'n'] }; let after = null; const seen = [];
  const first = typedPageQuery(table, null), initial = (await db.prepare(first.sql).all()).results; seen.push(...JSON.parse(new TextDecoder().decode(encodeTypedPage(table, initial, null))).rows);
  after = '-1'; const resumed = typedPageQuery(table, after); assert.deepEqual((await db.prepare(resumed.sql).bind(...resumed.params).all()).results.map(row => row.rowId), ['9223372036854775807']);
  assert.deepEqual(seen.map(row => row[0]), ['-9223372036854775808', '-1', '9223372036854775807']);
  assert.deepEqual(seen[0][1].slice(0, 3), [['integer', '9223372036854775807'], ['text', '610062'], ['blob', '00FF']]);
  assert.deepEqual(seen[1][1][0], ['integer', '-9223372036854775808']); assert.deepEqual(seen[0][1][4], ['null']);
  assert.equal(seen[0][1][3][0], 'real'); assert.equal(typeof seen[0][1][3][1], 'string');
  assert.equal((await db.prepare('SELECT CAST(? AS REAL)=r AS matches FROM edge WHERE rowid=-9223372036854775808').bind(seen[0][1][3][1]).first()).matches, 1);
  await db.prepare('CREATE TABLE compact(value)').run(); await db.prepare('WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<130) INSERT INTO compact SELECT i FROM n').run();
  const compact = { name: 'compact', columns: ['value'] }; let cursor = null, counts = [];
  for (let i = 0; i < 3; i++) { const query = typedPageQuery(compact, cursor), rows = (await db.prepare(query.sql).bind(...query.params).all()).results; counts.push(rows.length); encodeTypedPage(compact, rows, cursor); cursor = rows.at(-1).rowId; }
  assert.deepEqual(counts, [64, 64, 2]);
  await db.prepare('CREATE TABLE bulky(value)').run(); await db.prepare('INSERT INTO bulky VALUES(zeroblob(200000)),(zeroblob(200000)),(zeroblob(200000))').run();
  const bulky = { name: 'bulky', columns: ['value'] }, query = typedPageQuery(bulky, null), rows = (await db.prepare(query.sql).all()).results;
  assert.equal(rows.length, 2); assert.ok(encodeTypedPage(bulky, rows, null).length < SNAPSHOT_LIMITS.pageBytes);
});
test('schema49 capture seals encrypted pages before cursor progress and resumes a lost chunk acknowledgment', async t => {
  const f = await setup(t); let lost = false;
  const uncertain = { ...f.store, async writeChunk(...args) { await f.store.writeChunk(...args); if (!lost) { lost = true; throw Error('lost-ack'); } } };
  let outcome; for (let i = 0; i < 350; i++) { outcome = await f.build(uncertain).advance(f.id); assert.ok(f.budget() <= 50, 'source plus updater storage statements per advance'); if (outcome.outcome === 'snapshot-candidate') break; }
  assert.equal(outcome.outcome, 'snapshot-candidate'); assert.equal(outcome.candidate.verified, false); assert.ok(lost);
  const pages = []; for (let i = 0; i < outcome.candidate.pages; i++) pages.push(JSON.parse(new TextDecoder().decode(await f.build().readPage(f.id, i))));
  const operational = pages.find(page => page.table === 'public_hour_admission_clock'); assert.ok(operational); assert.deepEqual(operational.rows[0][1][1], ['integer', '9223372036854775807']);
  assert.equal(pages.filter(page => page.table === 'd1_migrations').reduce((sum, page) => sum + page.rows.length, 0), 49);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT envelope FROM updater_artifact_chunks').all()).includes('9223372036854775807'));
  const capture = f.build(); let expired;
  await assert.rejects(() => capture.describe(f.id, {}), /snapshot-reader/);
  f.budget();
  await capture.withReader(f.id, async reader => {
    expired = reader;
    const manifest = await capture.describe(f.id, reader);
    manifest.pages.length = 0;
    assert.equal((await capture.describe(f.id, reader)).pages.length, outcome.candidate.pages, 'returned descriptions cannot modify private reader');
    assert.equal(f.budget(), 1, 'one completed manifest read per scope');
    await assert.rejects(() => f.build().describe(f.id, reader), /snapshot-reader/);
    await assert.rejects(() => capture.describe(crypto.randomUUID(), reader), /snapshot-reader/);
    await capture.readPage(f.id, 0, reader); assert.equal(f.budget(), 2, 'each page still reads sealed metadata and encrypted chunks');
    const saved = f.sqlite.prepare('SELECT envelope FROM updater_artifact_chunks LIMIT 1').get().envelope;
    f.sqlite.prepare("UPDATE updater_artifact_chunks SET envelope='{}' WHERE rowid=(SELECT rowid FROM updater_artifact_chunks LIMIT 1)").run();
    await assert.rejects(() => capture.readPage(f.id, 0, reader));
    f.sqlite.prepare('UPDATE updater_artifact_chunks SET envelope=? WHERE rowid=(SELECT rowid FROM updater_artifact_chunks LIMIT 1)').run(saved);
  });
  await assert.rejects(() => capture.describe(f.id, expired), /snapshot-reader/);
});
test('capture rejects changed epoch and unknown schema; oversized raw rows never materialize hexadecimal payload', async t => {
  const f = await setup(t); assert.equal((await f.build().advance(f.id)).outcome, 'pending'); f.authority.epoch++;
  assert.equal((await f.build().advance(f.id)).outcome, 'unknown'); f.authority.epoch--;
  await f.db.prepare('CREATE TABLE sqlitex_extra(value)').run(); const second = crypto.randomUUID(); f.authority.operationId = second;
  assert.equal((await f.build().advance(second)).outcome, 'unknown');
  await f.db.prepare('CREATE TABLE large_row(value)').run(); await f.db.prepare('INSERT INTO large_row VALUES(zeroblob(?))').bind(SNAPSHOT_LIMITS.rowBytes + 1).run();
  const table = { name: 'large_row', columns: ['value'] }, query = typedPageQuery(table, null), rows = (await f.db.prepare(query.sql).all()).results;
  assert.equal(rows[0].cells, 'oversize'); assert.throws(() => encodeTypedPage(table, rows, null), /row-size/);
});

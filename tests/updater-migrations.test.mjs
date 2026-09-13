import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { createMigrationTransport } from '../apps/updater/src/migrations.mjs';
import { splitMigrationSql } from '../apps/updater/src/migration-sql.mjs';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createApplicationVerifier, sha256, signedBytes } from '../packages/shared/src/updater/application-release.mjs';
const encode = value => new TextEncoder().encode(value);
const goodSql = "-- trigger ; boundary\nPRAGMA defer_foreign_keys=ON; CREATE TABLE transport_probe(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO transport_probe VALUES(1,'literal; -- kept'); CREATE TRIGGER transport_guard BEFORE UPDATE ON transport_probe BEGIN SELECT CASE WHEN NEW.id=2 THEN RAISE(ABORT,'blocked; value') ELSE 1 END; END;";
async function fixture(t, sql = goodSql) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("synthetic")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB', 'STATE'] })); t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB'), state = await mf.getD1Database('STATE');
  await state.batch(unstable_splitSqlQuery(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql', import.meta.url), 'utf8')).map(sql => state.prepare(sql)));
  // Actual installed Wrangler native schema: name is deliberately nullable.
  await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const verifier = createApplicationVerifier({ product: 'LancerLogin', channel: 'development', repository: { id: 1, owner: 'synthetic', name: 'migration-test' }, keyId: 'synthetic', publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) });
  const artifacts = [], migrations = [];
  for (let i = 1; i <= 47; i++) { const name = `${String(i).padStart(4, '0')}_fixture.sql`, bytes = encode(i === 47 ? sql : '-- prior trusted fixture'); const digest = await sha256(bytes); artifacts.push({ role: 'migration', name, bytes: bytes.length, sha256: digest }); migrations.push({ id: name, artifact: name, fromSchema: i - 1, toSchema: i, sha256: digest }); }
  for (const [role, name] of [['api', 'api.mjs'], ['dashboard', 'dashboard.tar']]) artifacts.push({ role, name, bytes: 1, sha256: await sha256(encode('x')) });
  const manifest = { format: 1, kind: 'application', product: 'LancerLogin', repository: { id: 1, owner: 'synthetic', name: 'migration-test' }, channel: 'development', keyId: 'synthetic', sequence: 2, version: '2.0.0', sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '1.0.0', targetSchema: 47, codeRollback: 'restore-required', artifacts, migrations, compatibility: { installedVersion: { min: '1.0.0', max: '1.0.0' }, installedSchema: { min: 46, max: 46 }, apiVersion: 1, apiSchema: { min: 46, max: 47 }, frontendApi: { min: 1, max: 1 } } };
  const bytes = encode(JSON.stringify(manifest)), signature = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, signedBytes(bytes)));
  await db.batch(migrations.slice(0, 46).map(m => db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(m.id)));
  const pins = { installationId: 'synthetic-migration', applicationDatabaseId: '11111111-1111-4111-8111-111111111111', updaterDatabaseId: '22222222-2222-4222-8222-222222222222' };
  const operationId = crypto.randomUUID(), jobId = crypto.randomUUID();
  const authority = { installationId: pins.installationId, operationId, jobId, epoch: 1, state: 'closed', backupVerified: true, schema: 46, manifestSha256: await sha256(bytes), ledger: migrations.slice(0, 46).map(({ id, sha256 }) => ({ id, sha256 })) };
  const store = createArtifactStore({ database: state, installationId: pins.installationId, cipher: await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)), pins.installationId) });
  let batches = 0, queries = 0, lose = false, drift = false;
  const binding = { prepare: sql => { queries++; return db.prepare(sql); }, async batch(statements) { batches++; if (drift) await db.prepare("UPDATE d1_migrations SET name='synthetic-drift' WHERE id=1").run(); const result = await db.batch(statements); if (lose) { lose = false; throw Error('lost-ack'); } return result; } };
  const build = () => createMigrationTransport({ pins, database: binding, store, verifier, withClosedEpoch: async (request, run) => run(Object.freeze(structuredClone(authority))) });
  const transport = build(), release = await transport.verifyRelease(bytes, signature);
  return { db, state, store, authority, transport, build, bytes, signature, request: { operationId, release, migrationId: migrations[46].id, bytes: encode(sql) }, batches: () => batches, queries: () => queries, lose: () => { lose = true; }, drift: () => { drift = true; } };
}
test('actual local D1 atomically applies signed SQL, trigger and native ledger; lost acknowledgment reconciles without replay', async t => {
  const f = await fixture(t); f.lose(); assert.equal((await f.transport.applyMigration(f.request)).outcome, 'unknown');
  assert.equal((await f.db.prepare('SELECT value FROM transport_probe').first()).value, 'literal; -- kept');
  const restarted = f.build(), release = await restarted.verifyRelease(f.bytes, f.signature);
  const result = await restarted.reconcileMigration({ ...f.request, release }); assert.equal(result.outcome, 'applied'); assert.equal(result.receipt.toSchema, 47);
  f.authority.epoch = 2; assert.equal((await restarted.reconcileMigration({ ...f.request, release })).outcome, 'unknown'); f.authority.epoch = 1;
  assert.equal((await restarted.applyMigration({ ...f.request, release })).outcome, 'applied'); assert.equal(f.batches(), 1);
  await assert.rejects(() => f.db.prepare('UPDATE transport_probe SET id=2').run(), /blocked/);
  assert.ok(f.queries() < 50, 'application binding statement count only; updater-store/authority costs are separate');
});
test('actual local D1 rolls back DDL, data and native ledger together; absent ledger never triggers blind replay', async t => {
  const f = await fixture(t, 'CREATE TABLE rollback_probe(id INTEGER PRIMARY KEY); INSERT INTO rollback_probe VALUES(1); INSERT INTO rollback_probe VALUES(1);');
  assert.equal((await f.transport.applyMigration(f.request)).outcome, 'unknown');
  assert.equal(await f.db.prepare("SELECT name FROM sqlite_schema WHERE name='rollback_probe'").first(), null);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first()).count, 46);
  assert.equal((await f.transport.applyMigration(f.request)).outcome, 'unknown'); assert.equal(f.batches(), 1);
});
test('digest, order, authority epoch and native-prefix mismatches prevent mutation and duplicate-name adoption', async t => {
  const f = await fixture(t);
  assert.equal((await f.transport.applyMigration({ ...f.request, bytes: encode('DROP TABLE installations;') })).outcome, 'unknown');
  assert.equal((await f.transport.applyMigration({ ...f.request, migrationId: '0046_fixture.sql' })).outcome, 'unknown');
  f.authority.state = 'open'; assert.equal((await f.transport.applyMigration(f.request)).outcome, 'unknown'); f.authority.state = 'closed';
  f.authority.operationId = crypto.randomUUID(); assert.equal((await f.transport.applyMigration(f.request)).outcome, 'unknown'); f.authority.operationId = f.request.operationId;
  await f.db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(f.request.migrationId).run();
  assert.equal((await f.transport.applyMigration(f.request)).outcome, 'unknown'); assert.equal(f.batches(), 0);
  await f.db.prepare('DELETE FROM d1_migrations WHERE name=?').bind(f.request.migrationId).run(); f.drift();
  assert.equal((await f.transport.applyMigration(f.request)).outcome, 'unknown'); assert.equal(f.batches(), 1);
  assert.equal(await f.db.prepare("SELECT name FROM sqlite_schema WHERE name='transport_probe'").first(), null, 'in-batch prefix guard blocks all migration SQL after preflight drift');
  assert.equal(await f.db.prepare('SELECT name FROM d1_migrations WHERE name=?').bind(f.request.migrationId).first(), null);
});
test('bounded lexer preserves reviewed 47-49 boundaries and rejects unsupported controls and ambiguous syntax', () => {
  const directory = new URL('../apps/api/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^004[789]_/.test(name))) { const bytes = readFileSync(new URL(name, directory)); const split = splitMigrationSql(bytes); assert.equal(split.length, unstable_splitSqlQuery(bytes.toString()).length); assert.ok(split.length <= 36); }
  assert.equal(splitMigrationSql(encode(goodSql)).length, 4);
  for (const sql of ["BEGIN; CREATE TABLE x(id); COMMIT;", 'PRAGMA foreign_keys=OFF;', 'PRAGMA writable_schema=ON;', 'INSERT INTO "d1_migrations" VALUES(1);', "CREATE TABLE x(value TEXT DEFAULT 'unterminated);", '/* unterminated', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1;', 'CREATE TABLE x(id);'.repeat(37)]) assert.throws(() => splitMigrationSql(encode(sql)));
  assert.throws(() => splitMigrationSql(new Uint8Array(131073)));
});

import { splitMigrationSql } from './migration-sql.mjs';
const check = (value, code) => { if (!value) throw Error(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const unknown = () => ({ outcome: 'unknown' });

// withClosedEpoch is trusted bootstrap authority, not a browser assertion. It
// must durably exclude reopen/other migration dispatch throughout ambiguous work.
export function createMigrationTransport({ pins: input, database, store, verifier, withClosedEpoch }) {
  const pins = structuredClone(input), handles = new WeakSet();
  check(Object.keys(pins).sort().join(',') === 'applicationDatabaseId,installationId,updaterDatabaseId', 'migration-pins');
  check(/^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId) && uuid(pins.applicationDatabaseId) && uuid(pins.updaterDatabaseId) && pins.applicationDatabaseId !== pins.updaterDatabaseId, 'migration-pins');
  check(typeof database?.batch === 'function' && typeof withClosedEpoch === 'function', 'migration-binding');
  const primary = () => database.withSession ? database.withSession('first-primary') : database;
  const key = id => `migration:${id}`;
  async function names(db) {
    const result = await db.prepare('SELECT name FROM d1_migrations ORDER BY id LIMIT 255').all();
    check(result.success !== false && Array.isArray(result.results) && result.results.length <= 254, 'migration-ledger');
    return result.results.map(row => { check(typeof row.name === 'string' && row.name.length <= 67, 'migration-ledger'); return row.name; });
  }
  async function run(request, reconcileOnly) {
    try {
      check(request && Object.keys(request).sort().join(',') === 'bytes,migrationId,operationId,release' && uuid(request.operationId) && handles.has(request.release), 'migration-request');
      const release = request.release, migration = release.manifest.migrations.find(item => item.id === request.migrationId);
      check(migration && migration.fromSchema >= 46 && migration.toSchema <= 49, 'migration-range');
      const bytes = await verifier.verifyArtifact(release, migration.artifact, request.bytes), statements = splitMigrationSql(bytes);
      const before = release.manifest.migrations.slice(0, migration.fromSchema).map(({ id, sha256 }) => ({ id, sha256 }));
      return await withClosedEpoch(Object.freeze({ installationId: pins.installationId, operationId: request.operationId, manifestSha256: release.manifestSha256, migrationId: migration.id }), async authority => {
        check(authority && authority.installationId === pins.installationId && authority.operationId === request.operationId && authority.manifestSha256 === release.manifestSha256 && uuid(authority.jobId) && authority.state === 'closed' && Number.isSafeInteger(authority.epoch) && authority.epoch > 0 && authority.backupVerified === true && authority.schema === migration.fromSchema && same(authority.ledger, before), 'migration-authority');
        const identity = { ...pins, operationId: request.operationId, jobId: authority.jobId, epoch: authority.epoch, manifestSha256: release.manifestSha256, migrationId: migration.id, sha256: migration.sha256, fromSchema: migration.fromSchema, toSchema: migration.toSchema };
        const receipt = { id: migration.id, sha256: migration.sha256, fromSchema: migration.fromSchema, toSchema: migration.toSchema };
        const db = primary(), prior = await store.operation(key(request.operationId)), expected = before.map(entry => entry.id), after = [...expected, migration.id];
        if (prior) {
          check(same(prior.value.identity, identity), 'migration-operation-conflict');
          // Absence is not rejection: never redispatch a possibly in-flight batch.
          return same(await names(db), after) ? { outcome: 'applied', receipt } : unknown();
        }
        if (reconcileOnly) return unknown();
        check(same(await names(db), expected), 'migration-ledger');
        const columns = await db.prepare('PRAGMA table_info(d1_migrations)').all();
        check(columns.results?.some(column => column.name === 'name' && column.type.toUpperCase() === 'TEXT'), 'migration-native-schema');
        check(await store.claim(key(request.operationId), { identity, state: 'dispatched' }), 'migration-operation-conflict');
        // Guard insertion raises a JSON parse error if any ordered native
        // prefix differs. SQL and native name commit or roll back together.
        const guard = db.prepare("INSERT INTO d1_migrations(name) VALUES(CASE WHEN (SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY id)) = ? THEN ? ELSE json_extract('migration-ledger-mismatch','$') END)").bind(JSON.stringify(expected), migration.id);
        try { await db.batch([guard, ...statements.map(sql => db.prepare(sql))]); } catch { return unknown(); }
        return same(await names(primary()), after) ? { outcome: 'applied', receipt } : unknown();
      });
    } catch { return unknown(); }
  }
  return Object.freeze({
    async verifyRelease(manifestBytes, signatureBytes) { const release = await verifier.verify(manifestBytes, signatureBytes); handles.add(release); return release; },
    applyMigration: request => run(request, false),
    reconcileMigration: request => run(request, true),
  });
}

// quick-check: covers apps/api/migrations/**
// The reference team's entire installation (tests-ts/fixtures/reference-installation.ts: three seasons, about 74,000
// records, a 24 MB backup) backed up and restored in parts on real local D1 (Miniflare's workerd), driven by the
// dashboard's own client. No request carries more than one part, no request makes more than a handful of D1 queries, and
// the final batch is a fixed number of statements however many rows it restores: D1 copies the staged rows itself.
// The single-request restore cannot take this file at all. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniflareD1 } from './fixtures/miniflare-d1.mjs';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';
import { referenceCounts, referenceInstallationSql } from '../tests-ts/fixtures/reference-installation.ts';
import { downloadBackup, partTargetBytes, restoreInParts } from '../apps/dashboard/src/backup-transfer.ts';
import { BACKUP_PART_TARGET_CHARS } from '../apps/api/src/data-transfer.ts';
import { backupRecordCounts, estimateRestoreWrites } from '../packages/shared/src/restore-writes.ts';

const baseInstallation = [
  "INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2024-08-01','local')",
  "INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2024-08-01')",
  "INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1)",
  "INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0)",
  "INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1)",
  "INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,0)",
  "INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES ('primary','admin',0)",
  "INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES ('primary','admin',0)",
  "INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC')",
];
const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('on local D1 both restore routes store unusual values identically, and a document kept in pieces comes back whole', { timeout: 300000 }, async () => {
  const first = await createMiniflareD1(); const second = await createMiniflareD1();
  try {
    const small = { members: 20, labels: 2, kiosks: 1, meetingsPerSeason: 12, seasons: 1, attendeesPerMeeting: 4, correctionsPerMeeting: 1, noticeRecipientsPerMeeting: 1, auditEntries: 120, deliveries: 20 };
    const client = async ({ database }) => {
      for (const sql of [...baseInstallation, ...referenceInstallationSql(small)]) await database.exec(sql);
      const env = { DB: database, SESSION_KEY: secret, APP_MODE: 'configured' }; let cookie = 'lancerlogin_session=' + await createSessionCodec(secret).issue({ userId: 'admin', role: 'admin' });
      await worker.fetch(new Request('https://fixture.test/health'), env);
      return async (path, init) => { const result = await worker.fetch(new Request('https://fixture.test' + path, { method: init?.method ?? 'GET', headers: { cookie, ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) }, body: init?.body }), env); const set = result.headers.get('set-cookie'); if (set?.startsWith('lancerlogin_session=') && result.ok) cookie = set.split(';')[0]; return result; };
    };
    const whole = await client(first); const inParts = await client(second);
    const file = await (await whole('/admin/data/backup?scope=installation')).json();
    // A number and a boolean where the column holds text, a NUL, an emoji, both halves of a surrogate pair alone, and a
    // run of emoji long enough that the stored document is cut inside it.
    const odd = ['Test \u0000 NUL', 'Test 😀 emoji', 'Test \ud83d half', 'Test \udc00 other half', 777, 12.5, true, false, 0];
    file.tables.attendance_corrections.slice(0, odd.length).forEach((row, index) => { row.reason = odd[index]; });
    file.tables.audit_log.slice(0, odd.length).forEach((row, index) => { row.target_id = odd[index]; });
    file.tables.meetings.slice(0, odd.length).forEach((row, index) => { row.notes = odd[index]; });
    file.tables.members.slice(0, odd.length).forEach((row, index) => { row.last_name = odd[index]; });
    file.tables.organization_settings[0].subtitle = 'Test ' + '😀'.repeat(300_000);
    const single = await whole('/admin/data/restore', { method: 'POST', body: JSON.stringify({ scope: 'installation', confirmation: 'RESTORE INSTALLATION', backup: file }) });
    assert.equal(single.status, 200, await single.clone().text());
    const parted = await restoreInParts(inParts, { scope: 'installation', confirmation: 'RESTORE INSTALLATION', backup: file });
    assert.equal(parted.status, 200, await parted.clone().text());
    const quoted = async ({ database }, table, columns, order) => (await database.prepare(`SELECT ${columns.map((column) => `quote(${column}) AS ${column}`).join(', ')} FROM ${table} ORDER BY ${order}`).all()).results;
    for (const [table, columns, order] of [['attendance_corrections', ['id', 'reason', 'member_id', 'created_at'], 'id'], ["audit_log WHERE action <> 'data.backup_restored'", ['id', 'target_id', 'action', 'metadata_json'], 'id'], ['meetings', ['id', 'title', 'notes', 'attendance_weight', 'required', 'ends_at'], 'id'], ['members', ['id', 'last_name', 'active', 'inactive_periods_json'], 'id'], ['attendance_events', ['id', 'kiosk_event_id', 'created_by', 'action'], 'id'], ['organization_settings', ['subtitle', 'late_scan_minutes'], '1']]) {
      const expected = await quoted(first, table, columns, order);
      assert.deepEqual(await quoted(second, table, columns, order), expected, table);
      assert.ok(expected.length > 0, table);
    }
    // D1 binds numbers and booleans as REAL, so in a text column they read 777.0, 1.0 and 0.0 on both routes.
    const reasons = new Set((await quoted(second, 'attendance_corrections', ['reason'], 'id')).map((row) => row.reason));
    for (const value of ["'777.0'", "'12.5'", "'1.0'", "'0.0'"]) assert.ok(reasons.has(value), value);
    assert.equal((await second.database.prepare('SELECT subtitle FROM organization_settings').first()).subtitle, file.tables.organization_settings[0].subtitle);
    const triggers = async ({ database }) => (await database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).results;
    assert.deepEqual(await triggers(second), await triggers(first)); assert.ok((await triggers(second)).filter((trigger) => trigger.name.startsWith('report_revision_')).length >= 27);
    // A backup in parts of those rows is the single request's file.
    const downloaded = JSON.parse((await downloadBackup(inParts, { scope: 'installation' })).text); const again = await (await inParts('/admin/data/backup?scope=installation')).json();
    for (const table of ['attendance_corrections', 'meetings', 'members', 'organization_settings', 'attendance_events']) assert.deepEqual(downloaded.tables[table], again.tables[table], table);
  } finally { await first.runtime.dispose(); await second.runtime.dispose(); }
});

test('the reference installation backs up and restores in parts on local D1', { timeout: 300000 }, async () => {
  const { runtime, database } = await createMiniflareD1();
  try {
    for (const sql of [...baseInstallation, ...referenceInstallationSql()]) await database.exec(sql);

    // Count what each request asks of D1: every query, and the size of every batch. Requests overlap, so each has its own count.
    const counting = () => {
      const usage = { queries: 0, largestBatch: 0, written: 0 };
      const counted = (statement) => ({ bind: (...values) => counted(statement.bind(...values)), first: (...args) => { usage.queries += 1; return statement.first(...args); }, all: () => { usage.queries += 1; return statement.all(); }, run: () => { usage.queries += 1; return statement.run(); }, statement });
      return { usage, db: { prepare: (sql) => counted(database.prepare(sql)), batch: (list) => { usage.queries += 1; usage.largestBatch = Math.max(usage.largestBatch, list.length); return database.batch(list.map((item) => item.statement ?? item)).then((results) => { for (const result of results) usage.written += result.meta?.rows_written ?? 0; return results; }); } } };
    };
    const env = { DB: database, SESSION_KEY: secret, APP_MODE: 'configured' };
    let cookie = 'lancerlogin_session=' + await createSessionCodec(secret).issue({ userId: 'admin', role: 'admin' });
    await worker.fetch(new Request('https://fixture.test/health'), env);
    const sent = [];
    const request = async (path, init) => {
      const { usage, db } = counting();
      const result = await worker.fetch(new Request('https://fixture.test' + path, { method: init?.method ?? 'GET', headers: { cookie, ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) }, body: init?.body }), { ...env, DB: db });
      const body = await result.clone().arrayBuffer();
      sent.push({ method: init?.method ?? 'GET', path, sent: init?.body?.length ?? 0, received: body.byteLength, status: result.status, ...usage });
      const set = result.headers.get('set-cookie'); if (set?.startsWith('lancerlogin_session=') && result.ok) cookie = set.split(';')[0];
      return result;
    };
    const of = (pattern, method) => sent.filter((item) => pattern.test(item.path) && (!method || item.method === method));

    const downloaded = await downloadBackup(request, { scope: 'installation' });
    const backup = JSON.parse(downloaded.text); const counts = referenceCounts();
    for (const [table, count] of Object.entries(counts)) assert.equal(backup.tables[table].length, count, table);
    const records = Object.values(backup.tables).reduce((total, rows) => total + rows.length, 0);
    assert.ok(records > 73_000 && downloaded.text.length > 20_000_000, `${records} records, ${downloaded.text.length} bytes`);
    const downloads = of(/\/backup\/sessions\/[^/]+\/parts\//);
    assert.ok(downloads.length > 200, `${downloads.length} backup parts`);
    // A part ends with the row that crosses the target; UTF-8 text here is ASCII, so characters are bytes.
    assert.ok(downloads.every((item) => item.status === 200 && item.received <= BACKUP_PART_TARGET_CHARS + 1_000 && item.queries <= 8), JSON.stringify(downloads.find((item) => item.received > BACKUP_PART_TARGET_CHARS + 1_000 || item.queries > 8)));
    const started = of(/\/backup\/sessions$/)[0]; assert.ok(started.queries <= 8 && started.largestBatch < 80, JSON.stringify(started));
    assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM data_transfer_chunks').first()).n, 0);

    // The single-request restore refuses a file this size outright.
    const whole = await request('/admin/data/restore', { method: 'POST', body: JSON.stringify({ scope: 'installation', confirmation: 'RESTORE INSTALLATION', backup }) });
    assert.equal(whole.status, 413);

    // Change the installation, then bring it back from the file.
    await database.exec("DELETE FROM attendance_events WHERE meeting_id IN (SELECT id FROM meetings WHERE title LIKE 'Test Meeting 1%')");
    await database.exec("UPDATE members SET first_name = 'Changed'");
    sent.length = 0;
    const restored = await restoreInParts(request, { scope: 'installation', confirmation: 'RESTORE INSTALLATION', backup });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.deepEqual(await restored.json(), { restored: true, scope: 'installation', recovery: { revokedKiosks: 3, invalidatedPairingCodes: 3, pausedProviderOperations: 0 } });
    const uploads = of(/\/restore\/sessions\/[^/]+\/parts\//, 'PUT');
    assert.ok(uploads.length > 300, `${uploads.length} restore parts`);
    assert.ok(uploads.every((item) => item.status === 200 && item.sent <= partTargetBytes && item.queries <= 8), JSON.stringify(uploads.find((item) => item.sent > partTargetBytes || item.queries > 8)));
    // Starting sends the document without the staged tables' rows; the final request sends no rows at all, and its batch
    // is a statement or two per table, not one per hundred values.
    const begun = of(/\/restore\/sessions$/)[0]; const committed = of(/\/commit$/)[0];
    assert.ok(begun.sent < 200_000 && begun.queries <= 8, JSON.stringify(begun));
    assert.ok(committed.sent < 500 && committed.queries <= 16 && committed.largestBatch < 220, JSON.stringify(committed));
    // The estimate the restore's start returned (records and their indexes) against what D1 counted for the final batch,
    // which also removed the rows that were there: the estimate is a floor, and not far below.
    const estimate = estimateRestoreWrites(backupRecordCounts(backup));
    assert.ok(estimate > 400_000 && committed.written >= estimate && committed.written <= estimate * 1.5, `estimated ${estimate}, D1 counted ${committed.written}`);
    console.log(`reference restore: estimated ${estimate} rows written, D1 counted ${committed.written}`);
    assert.ok(sent.every((item) => item.queries < 50));

    for (const [table, count] of Object.entries(counts)) assert.equal((await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, count + (table === 'audit_log' ? 1 : 0), table);
    assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results, []);
    // The finished restore keeps its answer and marker; nothing else is staged.
    assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM data_transfer_sessions WHERE result_json IS NULL').first()).n, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM data_transfer_chunks WHERE table_name <> '#commit'").first()).n, 0);
    assert.equal((await database.prepare("SELECT COUNT(*) AS n FROM kiosks WHERE active = 1 OR token_hash NOT LIKE 'restored-%'").first()).n, 0);
    // The restored installation backs up to the same rows; only what a restore deliberately changes differs.
    const again = JSON.parse((await downloadBackup(request, { scope: 'installation' })).text);
    const differing = Object.keys(backup.tables).filter((table) => JSON.stringify(backup.tables[table]) !== JSON.stringify(again.tables[table]));
    assert.deepEqual(differing, ['platform_module_administration', 'platform_module_administration_epochs', 'platform_module_epochs', 'platform_modules', 'platform_module_assignment_epochs', 'platform_module_assignment_revisions', 'pairing_codes', 'kiosks', 'audit_log']);
  } finally { await runtime.dispose(); }
});

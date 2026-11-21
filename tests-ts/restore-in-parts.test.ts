// quick-check: covers apps/api/migrations/**
// Dashboard backups and restores in parts (apps/api/src/data-transfer.ts, apps/dashboard/src/backup-transfer.ts), through
// the Worker on a real migrated SQLite database and driven by the dashboard's own client code. A restore in parts must
// leave exactly what the single-request restore leaves, for current and older backups; a restore that is refused, fails
// or is abandoned at any stage must leave the installation exactly as it was; a part that was changed on the way is
// refused; staging is cleaned up; and a backup in parts is the file the single request produces. All data is synthetic.
import test from "node:test";
import assert from "node:assert/strict";

const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, sessionSecret, restoredSessionCookie } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");
const { referenceInstallationSql, referenceShape, referenceCounts } = await import("./fixtures/reference-installation.ts");
const { omitContestResubmissionFields } = await import("./fixtures/backup-versions.ts");
const { pruneStaleRows } = await import("../apps/api/src/stale-row-pruning.ts");
const transfer = await import("../apps/dashboard/src/backup-transfer.ts");
const staging = await import("../apps/api/src/data-transfer.ts");
const writes = await import("../packages/shared/src/restore-writes.ts");
type TransferRequest = import("../apps/dashboard/src/backup-transfer.ts").TransferRequest;
type Backup = { schemaVersion: number; scope: string; exportedAt?: string; tables: Record<string, Record<string, unknown>[]>; [key: string]: unknown };

/** A small installation with the reference team's shape: every staged table spans several parts. */
const smallShape = { ...referenceShape, members: 40, labels: 4, kiosks: 2, meetingsPerSeason: 30, seasons: 2, attendeesPerMeeting: 6, correctionsPerMeeting: 1, noticeRecipientsPerMeeting: 2, auditEntries: 400, deliveries: 150 };
const codec = createSessionCodec(sessionSecret);

async function fixture(options: { data?: boolean } = {}) {
  const db = new BackupDatabase(); const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" };
  if (options.data !== false) for (const sql of referenceInstallationSql(smallShape)) db.raw.exec(sql);
  await worker.fetch(new Request("https://fixture.test/health"), env as never);
  let cookie = "lancerlogin_session=" + await codec.issue({ userId: "admin", role: "admin" });
  const sent: { method: string; path: string; bytes: number; status: number }[] = [];
  const send = async (path: string, init: { method?: string; body?: string | Uint8Array; cookie?: string } = {}) => {
    const method = init.method ?? "GET";
    const result = await worker.fetch(new Request("https://fixture.test" + path, { method, headers: { cookie: init.cookie ?? cookie, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, body: init.body }), env as never);
    sent.push({ method, path, bytes: typeof init.body === "string" ? Buffer.byteLength(init.body) : init.body?.length ?? 0, status: result.status });
    if (!init.cookie) cookie = restoredSessionCookie(result) ?? cookie;
    return result;
  };
  const request: TransferRequest = (path, init) => send(path, init);
  const json = async (path: string, init?: Parameters<typeof send>[1]) => { const result = await send(path, init); return { status: result.status, body: await result.json() as Record<string, any> }; };
  const backup = async (scope = "installation") => { const result = await send(`/admin/data/backup?scope=${scope}`); assert.equal(result.status, 200, await result.clone().text()); return await result.json() as Backup; };
  const restoreWhole = (file: unknown, scope = "installation", extra: Record<string, unknown> = {}) => send("/admin/data/restore", { method: "POST", body: JSON.stringify({ scope, confirmation: `RESTORE ${scope.toUpperCase()}`, backup: file, ...extra }) });
  const restoreParts = (file: unknown, scope = "installation", extra: Record<string, unknown> = {}) => transfer.restoreInParts(request, { scope: scope as "installation", confirmation: `RESTORE ${scope.toUpperCase()}`, backup: file, wait: async () => undefined, ...extra });
  /** Start a restore by hand: the session, the parts and their declared digests. */
  const begin = async (file: unknown, scope = "installation", change: (body: Record<string, any>) => void = () => undefined) => {
    const { document, parts } = transfer.splitBackup(file);
    const declared = await Promise.all(parts.map(async (part) => ({ table: part.table, rows: part.rows, sha256: await transfer.sha256Hex(part.body) })));
    const body: Record<string, any> = { scope, confirmation: `RESTORE ${scope.toUpperCase()}`, document, parts: declared }; change(body);
    const result = await json("/admin/data/restore/sessions", { method: "POST", body: JSON.stringify(body) });
    const base = `/admin/data/restore/sessions/${result.body.id}`;
    return { ...result, parts, base, upload: (seq: number, bytes: string | Uint8Array = parts[seq]!.body) => json(`${base}/parts/${seq}`, { method: "PUT", body: bytes }), commit: (change: Record<string, unknown> = {}) => json(`${base}/commit`, { method: "POST", body: JSON.stringify({ confirmation: `RESTORE ${scope.toUpperCase()}`, digest: result.body.digest, ...change }) }) };
  };
  // What is still staged. A restore that completed keeps its answer and its marker, and nothing else, until it expires.
  const stagedRows = () => db.count("SELECT (SELECT COUNT(*) FROM data_transfer_sessions WHERE result_json IS NULL) + (SELECT COUNT(*) FROM data_transfer_chunks WHERE table_name <> '#commit') AS n");
  const triggers = () => db.rows("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name");
  const revision = () => db.count("SELECT revision AS n FROM report_data_revision WHERE installation_id = 'primary'");
  return { db, env, sent, send, request, json, backup, restoreWhole, restoreParts, begin, stagedRows, triggers, revision, cookie: () => cookie };
}

/** Values that differ between any two restores: retired credentials are random, and epochs and audit times follow the clock. */
function masked(table: string, row: Record<string, unknown>) {
  const copy = { ...row };
  if (table === "kiosks" && String(copy.token_hash).startsWith("'restored-")) copy.token_hash = "restored";
  if (table === "pairing_codes" && String(copy.code_hash).startsWith("'restored-")) copy.code_hash = "restored";
  if (table === "users") delete copy.session_epoch;
  if (table === "audit_log" && copy.action === "'data.backup_restored'") { delete copy.id; delete copy.created_at; }
  // A restore starts the participation start correction again under a random run id (participation-start-correction.ts).
  if (table === "participation_start_correction") { delete copy.run_id; delete copy.started_at; }
  return copy;
}
/**
 * Every row of every table outside staging, in a stable order, each value as SQLite's quote() writes it: its storage
 * class and exact content, so 777 and '777' and '777.0' differ, and so do texts that only differ in bytes.
 */
function dump(db: InstanceType<typeof BackupDatabase>, options: { mask?: boolean; skip?: readonly string[] } = {}) {
  const tables = db.rows<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'data_transfer_%' ORDER BY name").map((row) => row.name).filter((name) => !options.skip?.includes(name));
  return Object.fromEntries(tables.map((table) => {
    const columns = db.rows<{ name: string }>(`PRAGMA table_info("${table}")`).map((column) => column.name);
    return [table, db.rows(`SELECT ${columns.map((column) => `quote("${column}") AS "${column}"`).join(", ")} FROM "${table}"`).map((row) => JSON.stringify(options.mask ? masked(table, row) : row)).sort()];
  }));
}
/** Request bookkeeping every authenticated request may touch; never part of what a restore replaces or protects. */
const operational = ["platform_scheduler_state", "platform_module_catalog", "auth_rate_limits", "auth_attempts", "d1_migrations"];
function assertSameData(left: ReturnType<typeof dump>, right: ReturnType<typeof dump>, message: string) {
  for (const table of Object.keys(left)) assert.deepEqual(right[table], left[table], `${message}: ${table}`);
  assert.deepEqual(Object.keys(right), Object.keys(left));
}

test("a backup file is split into the document and parts of bounded size, and the fallback digest is SHA-256", async () => {
  const source = await fixture(); const file = await source.backup();
  const { document, parts } = transfer.splitBackup(file); const skeleton = JSON.parse(document) as Backup;
  assert.ok(parts.length > 8, "the staged tables span several parts");
  for (const part of parts) {
    assert.ok(part.body.length <= transfer.partTargetBytes, `part of ${part.table} is ${part.body.length} bytes`);
    assert.ok(transfer.stagedTables.includes(part.table)); assert.deepEqual(skeleton.tables[part.table], []);
  }
  // Joined again, the parts are the tables they were cut from, byte for byte as JSON.stringify writes them.
  for (const table of new Set(parts.map((part) => part.table))) {
    const mine = parts.filter((part) => part.table === table); const rows = mine.flatMap((part) => JSON.parse(Buffer.from(part.body).toString("utf8")) as unknown[]);
    assert.deepEqual(rows, file.tables[table]); assert.equal(mine.reduce((total, part) => total + part.rows, 0), file.tables[table]!.length);
    assert.equal(Buffer.from(mine[0]!.body).toString("utf8"), JSON.stringify(file.tables[table]!.slice(0, mine[0]!.rows)));
  }
  // Tables other than the staged ones, and small staged ones, stay in the document untouched.
  assert.deepEqual(skeleton.tables.members, file.tables.members); assert.deepEqual(skeleton.tables.meeting_audience_labels, file.tables.meeting_audience_labels);
  assert.deepEqual({ ...skeleton, tables: null }, { ...file, tables: null });
  // A row too large for any part keeps its table in the document; something that is not a backup goes whole.
  const large = structuredClone(file); large.tables.audit_log![0]!.metadata_json = JSON.stringify({ synthetic: "x".repeat(300_000) });
  const kept = transfer.splitBackup(large); assert.ok(!kept.parts.some((part) => part.table === "audit_log")); assert.equal((JSON.parse(kept.document) as Backup).tables.audit_log!.length, file.tables.audit_log!.length);
  assert.deepEqual(transfer.splitBackup({ product: "Other" }), { document: '{"product":"Other"}', parts: [] });
  assert.deepEqual(transfer.splitBackup("text"), { document: '"text"', parts: [] });
  for (const text of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "Test Student é ✓ ".repeat(1000)]) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(transfer.sha256Fallback(bytes), await transfer.sha256Hex(bytes), `digest of ${text.length} characters`); assert.equal(await staging.sha256Hex(text), await transfer.sha256Hex(bytes));
  }
  assert.equal(transfer.sha256Fallback(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

for (const scope of ["installation", "meetings", "roster"] as const) {
  test(`restore in parts leaves exactly what the single-request restore leaves (${scope})`, async () => {
    const source = await fixture(); const file = await source.backup(scope);
    // Something for the restore to stop: queued provider work must come back failed, counted, from parts and document alike.
    if (scope !== "roster") { file.tables.discord_attendance_notifications![3]!.status = "pending"; file.tables.discord_attendance_notifications![70 % file.tables.discord_attendance_notifications!.length]!.status = "pending"; }
    if (scope === "installation") file.tables.integration_deliveries![5]!.status = "pending";
    // Values the two routes must store identically, in tables that travel in parts and in the document: a number where
    // the column holds text, text with a NUL, an emoji, and half a surrogate pair (which D1 stores as U+FFFD).
    const odd = ["Test \u0000 NUL", "Test 😀 emoji", "Test \ud83d half", "Test \udc00 other half", 777, 12.5, 0];
    if (scope !== "roster") { file.tables.attendance_corrections!.slice(0, odd.length).forEach((row, index) => { row.reason = odd[index]!; }); file.tables.meetings!.slice(0, odd.length).forEach((row, index) => { row.notes = odd[index]!; row.title = odd[odd.length - 1 - index]!; }); file.tables.meeting_templates = []; }
    if (scope === "installation") file.tables.audit_log!.slice(0, odd.length).forEach((row, index) => { row.target_id = odd[index]!; });
    if (scope !== "meetings") { file.tables.members!.slice(0, odd.length).forEach((row, index) => { row.last_name = odd[index]!; }); file.tables.member_label_changes!.slice(0, 3).forEach((row, index) => { row.created_at = [20260901, "2026-09-01T00:00:00.000Z😀", 1.5][index]!; }); }
    const whole = await fixture({ data: scope !== "installation" }); const inParts = await fixture({ data: scope !== "installation" });
    // The targets differ from the backup, so the restore has rows to remove, change and bring back.
    for (const target of [whole, inParts]) if (scope !== "installation") target.db.raw.exec("DELETE FROM attendance_events WHERE rowid % 3 = 0; UPDATE meetings SET title = 'Changed' WHERE rowid % 2 = 0; UPDATE members SET first_name = 'Changed' WHERE rowid % 2 = 0; DELETE FROM member_label_changes WHERE rowid % 2 = 0;");
    const elsewhere = "lancerlogin_session=" + await codec.issue({ userId: "admin", role: "admin" }); const mine = inParts.cookie();
    const schema = inParts.triggers(); const revisions = [whole.revision(), inParts.revision()]; assert.ok(schema.filter((trigger: any) => trigger.name.startsWith("report_revision_")).length >= 27);
    const first = await whole.restoreWhole(file, scope); assert.equal(first.status, 200, await first.clone().text());
    const second = await inParts.restoreParts(file, scope); assert.equal(second?.status, 200, await second?.clone().text());
    const expected = await first.json() as Record<string, any>; const actual = await second!.json() as Record<string, any>;
    assert.deepEqual(actual, expected);
    // The report revision triggers are set aside for the batch and put back exactly; the revision moves once, not per row.
    for (const target of [whole, inParts]) assert.deepEqual(target.triggers(), schema);
    assert.deepEqual([whole.revision(), inParts.revision()], revisions.map((value) => value + 1));
    if (scope !== "roster") assert.deepEqual(inParts.db.rows("SELECT typeof(reason) AS kind, reason FROM attendance_corrections WHERE reason IN ('777.0', '12.5', '0.0') ORDER BY reason"), [{ kind: "text", reason: "0.0" }, { kind: "text", reason: "12.5" }, { kind: "text", reason: "777.0" }]);
    if (scope !== "roster") assert.deepEqual(inParts.db.rows("SELECT hex(reason) AS bytes FROM attendance_corrections WHERE reason LIKE 'Test %' ORDER BY 1"), ["Test \u0000 NUL", "Test \ufffd half", "Test \ufffd other half", "Test 😀 emoji"].map((text) => ({ bytes: Buffer.from(text, "utf8").toString("hex").toUpperCase() })).sort((left, right) => left.bytes < right.bytes ? -1 : 1));
    assert.equal(expected.recovery.pausedProviderOperations, scope === "installation" ? 3 : scope === "meetings" ? 2 : 0);
    assertSameData(dump(whole.db, { mask: true, skip: operational }), dump(inParts.db, { mask: true, skip: operational }), "restore in parts");
    assert.equal(inParts.stagedRows(), 0, "the final batch removes the staged parts");
    if (scope !== "roster") assert.equal(inParts.db.count("SELECT COUNT(*) AS n FROM discord_attendance_notifications WHERE status = 'pending'"), 0);
    const uploads = inParts.sent.filter((item) => item.method === "PUT");
    assert.ok(uploads.length >= (scope === "roster" ? 1 : 4), `${uploads.length} parts`); assert.ok(uploads.every((item) => item.bytes <= transfer.partTargetBytes && item.status === 200));
    // An installation restore ends every session and keeps the restoring Admin signed in under the new epoch, as in one
    // request; the other categories leave sessions alone.
    assert.equal(Boolean(restoredSessionCookie(second!)), scope === "installation");
    assert.deepEqual([(await inParts.send("/auth/session", { cookie: elsewhere })).status, (await inParts.send("/auth/session", { cookie: mine })).status, (await inParts.send("/auth/session")).status], scope === "installation" ? [401, 401, 200] : [200, 200, 200]);
    assert.equal(inParts.db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'data.backup_restored'"), 1);
    assert.deepEqual(inParts.db.rows("PRAGMA foreign_key_check"), []);
    assert.deepEqual(inParts.db.rows("PRAGMA foreign_key_check"), []);
    // The Admin who restored stays signed in, and the restored state backs up and restores again.
    const again = await inParts.backup(scope); assert.deepEqual(again.tables.attendance_events ?? [], file.tables.attendance_events ?? []);
    assert.equal((await inParts.restoreParts(again, scope))?.status, 200);
  });
}

test("older backups restore in parts as they do in one request", async () => {
  const source = await fixture(); const current = await source.backup();
  for (const schemaVersion of [41, 44, 46, 49, 51]) {
    const file = structuredClone(current); file.schemaVersion = schemaVersion; omitContestResubmissionFields(file);
    const whole = await fixture({ data: false }); const inParts = await fixture({ data: false });
    const first = await whole.restoreWhole(file); assert.equal(first.status, 200, `schema ${schemaVersion}: ${await first.clone().text()}`);
    const second = await inParts.restoreParts(file); assert.equal(second?.status, 200, `schema ${schemaVersion} in parts: ${await second?.clone().text()}`);
    assert.deepEqual(await second!.json(), await first.json());
    assertSameData(dump(whole.db, { mask: true, skip: operational }), dump(inParts.db, { mask: true, skip: operational }), `schema ${schemaVersion}`);
    assert.ok(inParts.sent.some((item) => item.method === "PUT"));
    whole.db.raw.close(); inParts.db.raw.close();
  }
});

test("a schema 1 backup's scans gain the same check-outs whether its events arrive in parts or in the document", async () => {
  const source = await fixture(); const current = await source.backup("meetings");
  // Schema 1: arrivals only, no audiences, weights, templates, notices or recipients, and no resubmission history.
  const pick = (rows: Record<string, unknown>[], columns: string[]) => rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
  const events = current.tables.attendance_events!.filter((row) => row.action === "check_in");
  // Two scans of one meeting by one member at the same time: the earliest-listed one is the one that closes attendance.
  events.push({ ...events[0]!, id: "test-event-tie", kiosk_event_id: "test-scan-tie", created_by: "admin" }, { ...events[1]!, id: "test-event-later", kiosk_event_id: "test-scan-later", occurred_at: "2099-01-01T00:00:00.000Z", created_by: "admin" }, { ...events[2]!, id: "test-event-unassigned", kiosk_event_id: "test-scan-unassigned", meeting_id: null });
  const file = { product: "LancerLogin", schemaVersion: 1, scope: "meetings", exportedAt: current.exportedAt, tables: {
    meetings: pick(current.tables.meetings!, ["id", "installation_id", "title", "starts_at", "ends_at", "required", "notes", "created_by", "created_at", "is_test"]).map((row, index) => index === 0 ? { ...row, ends_at: null } : row),
    attendance_events: pick(events, ["id", "installation_id", "member_id", "meeting_id", "source", "occurred_at", "kiosk_event_id", "created_by"]),
    attendance_corrections: current.tables.attendance_corrections!,
    discord_attendance_contests: pick(current.tables.discord_attendance_contests!, ["installation_id", "meeting_id", "member_id", "message_id", "status", "resolved_by", "resolved_at", "created_at"]),
  } };
  const whole = await fixture(); const inParts = await fixture();
  const first = await whole.restoreWhole(file, "meetings"); assert.equal(first.status, 200, await first.clone().text());
  const second = await inParts.restoreParts(file, "meetings"); assert.equal(second?.status, 200, await second?.clone().text());
  assertSameData(dump(whole.db, { mask: true, skip: operational }), dump(inParts.db, { mask: true, skip: operational }), "schema 1");
  assert.ok(inParts.sent.filter((item) => item.method === "PUT").length >= 2);
  const checkouts = inParts.db.rows<{ id: string; occurred_at: string; created_by: string | null }>("SELECT id, occurred_at, created_by FROM attendance_events WHERE action = 'check_out'");
  assert.equal(checkouts.length, events.length - 3, "one check-out for each member and meeting");
  assert.ok(checkouts.every((row) => row.id.startsWith("legacy-restore-checkout:")));
  assert.equal(checkouts.find((row) => row.id === `legacy-restore-checkout:${events[0]!.member_id}:${events[0]!.meeting_id}`)?.created_by, null, "the earliest-listed of two simultaneous scans");
  assert.equal(checkouts.find((row) => row.id === `legacy-restore-checkout:${events[1]!.member_id}:${events[1]!.meeting_id}`)?.occurred_at, "2099-01-01T00:00:00.000Z");
  assert.equal(inParts.db.count("SELECT COUNT(*) AS n FROM meetings WHERE ends_at IS NULL"), 0);
});

test("a restore that is refused before it starts stages nothing and changes nothing", async () => {
  const f = await fixture(); const file = await f.backup(); const before = dump(f.db, { skip: operational });
  const refused = async (label: string, status: number, change: (body: Record<string, any>) => void, pattern: RegExp) => {
    const result = await f.begin(file, "installation", change);
    assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`); assert.match(String(result.body.error), pattern, label);
    assert.equal(f.stagedRows(), 0, label); assertSameData(before, dump(f.db, { skip: operational }), label);
    return result.body;
  };
  const edited = (edit: (document: Backup) => void) => (body: Record<string, any>) => { const document = JSON.parse(body.document) as Backup; edit(document); body.document = JSON.stringify(document); };
  await refused("confirmation", 400, (body) => { body.confirmation = "restore installation"; }, /Type RESTORE INSTALLATION exactly/);
  await refused("scope", 400, (body) => { body.scope = "everything"; }, /Restore scope must be/);
  await refused("missing document", 400, (body) => { delete body.document; }, /must include the backup document/);
  await refused("broken JSON", 400, (body) => { body.document = body.document.slice(0, -5); }, /not valid JSON/);
  await refused("another category", 400, edited((document) => { document.scope = "roster"; }), /not a matching current LancerLogin backup/);
  await refused("ownership", 400, edited((document) => { (document.ownership as any).core.tables.pop(); }), /ownership does not match/);
  await refused("unknown table", 400, edited((document) => { document.tables.synthetic_table = []; }), /tables that are not owned/);
  await refused("invalid kiosk", 400, edited((document) => { document.tables.kiosks![0]!.authentication_method = "retina"; }), /invalid kiosk authentication method/);
  await refused("invalid authority", 400, edited((document) => { document.tables.platform_module_administration = []; }), /module administration state is incomplete/);
  await refused("rows in both places", 400, edited((document) => { document.tables.attendance_events = [{ id: "test" }]; }), /both in the backup document and in parts/);
  await refused("part of an unstaged table", 400, (body) => { body.parts[0].table = "users"; }, /list of parts is invalid/);
  await refused("part without a digest", 400, (body) => { body.parts[0].sha256 = "none"; }, /list of parts is invalid/);
  await refused("too many records", 400, (body) => { body.parts[0].rows = 150_001; }, /too many records/);
  // A plugin section this build cannot restore is refused as in one request, with the same body for the discard choice.
  const unavailable = { id: "synthetic-missing", label: "Synthetic Missing", contractVersion: 1, backupVersion: 1, source: null, commit: null, tables: { synthetic_rows: [{ installation_id: "primary", id: "test-row" }] } };
  const body = await refused("unavailable module", 409, edited((document) => { document.externalModules = [unavailable]; }), /module data this installation cannot restore/);
  assert.equal(body.code, "module-restore-refused"); assert.deepEqual(body.optOut, { available: true, excludeModules: ["synthetic-missing"] }); assert.equal(body.modules[0].rows, 1);
  const single = await f.restoreWhole({ ...file, externalModules: [unavailable] }); assert.equal(single.status, 409); assert.deepEqual(await single.json(), body);
  // Only an Admin may start one.
  const operator = "lancerlogin_session=" + await codec.issue({ userId: "operator", role: "operator" });
  assert.equal((await f.send("/admin/data/restore/sessions", { method: "POST", body: "{}", cookie: operator })).status, 403);
  assert.equal((await f.send("/admin/data/restore/sessions", { method: "POST", body: "{}", cookie: "lancerlogin_session=none" })).status, 401);
  assertSameData(before, dump(f.db, { skip: operational }), "after every refusal");
});

test("a part that was changed, damaged or mislabelled is refused and nothing is replaced", async () => {
  const f = await fixture(); const file = await f.backup(); const before = dump(f.db, { skip: operational });
  const session = await f.begin(file); assert.equal(session.status, 201, JSON.stringify(session.body));
  assert.deepEqual(session.body.parts, session.parts.map((_, index) => index)); assert.match(session.body.digest, /^[0-9a-f]{64}$/);
  const events = session.parts.findIndex((part) => part.table === "attendance_events"); const text = Buffer.from(session.parts[events]!.body).toString("utf8");
  // One changed value: the bytes no longer match what the restore declared.
  const tampered = await session.upload(events, text.replace('"check_in"', '"check_out"'));
  assert.equal(tampered.status, 409); assert.equal(tampered.body.code, "restore_part_mismatch"); assert.match(tampered.body.error, /did not arrive as it was sent. Nothing was changed/);
  assert.equal((await session.upload(events, text.slice(0, -40))).body.code, "restore_part_mismatch");
  // Another part's bytes under this part's number, and a number that was never declared.
  assert.equal((await session.upload(events, session.parts[events + 1]!.body)).body.code, "restore_part_mismatch");
  assert.equal((await session.upload(session.parts.length, "[]")).status, 404);
  assert.equal((await f.send(`${session.base}/parts/x`, { method: "PUT", body: "[]" })).status, 404);
  assert.equal((await f.send(`${session.base}/parts/${events}`, { method: "PUT", body: new Uint8Array(staging.RESTORE_PART_MAX_BYTES + 1) })).status, 413);
  // Another Admin cannot upload into, read, commit or cancel this restore.
  f.db.raw.exec("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin-two','primary','admin-two','admin','2026-01-01'); INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES ('primary','admin-two',0); INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES ('primary','admin-two',0);");
  const other = "lancerlogin_session=" + await codec.issue({ userId: "admin-two", role: "admin" });
  assert.equal((await f.send(`${session.base}/parts/${events}`, { method: "PUT", body: session.parts[events]!.body, cookie: other })).status, 404);
  assert.equal((await f.send(session.base, { cookie: other })).status, 404);
  assert.equal((await f.send(`${session.base}/commit`, { method: "POST", body: JSON.stringify({ confirmation: "RESTORE INSTALLATION", digest: session.body.digest }), cookie: other })).status, 404);
  assert.equal((await f.send(session.base, { method: "DELETE", cookie: other })).status, 200); assert.equal((await f.json(session.base)).status, 200, "another Admin's cancel removes nothing");
  f.db.raw.exec("DELETE FROM platform_module_assignment_revisions WHERE user_id = 'admin-two'; DELETE FROM platform_module_assignment_epochs WHERE user_id = 'admin-two'; DELETE FROM users WHERE id = 'admin-two'");
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_chunks WHERE payload IS NOT NULL AND seq >= 0"), 0, "no refused part was staged");
  assertSameData(before, dump(f.db, { skip: operational }), "after refused parts");
  // The untouched part is accepted, twice over, and staged in the Worker's own form: arrays in column order.
  assert.deepEqual((await session.upload(events)).body, { received: events }); assert.equal((await session.upload(events)).status, 200);
  const staged = JSON.parse(f.db.rows<{ payload: string }>("SELECT payload FROM data_transfer_chunks WHERE seq = ?", events)[0]!.payload) as unknown[][];
  assert.deepEqual(staged[0], Object.values(file.tables.attendance_events![0]!)); assert.equal(staged.length, session.parts[events]!.rows);
  assertSameData(before, dump(f.db, { skip: operational }), "after a staged part");
});

test("rows are checked as each part arrives, and staged as the Worker read them", async () => {
  const f = await fixture(); const file = await f.backup(); const before = dump(f.db, { skip: operational });
  // The digest is declared for the changed bytes, so each part arrives intact and is refused for what it holds. A table
  // small enough to stay in the document is refused with the same message when the restore starts.
  let refusedAsParts = 0;
  const invalid = async (label: string, table: string, edit: (rows: Record<string, any>[]) => unknown, pattern: RegExp) => {
    const changed = structuredClone(file); edit(changed.tables[table]!);
    const session = await f.begin(changed); const seq = session.parts.findIndex((part) => part.table === table);
    const answer = seq < 0 ? session : await session.upload(seq); if (seq >= 0) { assert.equal(session.status, 201, `${label}: ${JSON.stringify(session.body)}`); refusedAsParts += 1; }
    assert.equal(answer.status, 400, `${label}: ${JSON.stringify(answer.body)}`); assert.match(String(answer.body.error), pattern, label);
    assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_chunks WHERE payload IS NOT NULL AND seq >= 0"), 0, label);
  };
  await invalid("object value", "attendance_events", (rows) => { rows[0]!.source = { nested: true }; }, /attendance_events contains an invalid row/);
  await invalid("missing column", "attendance_events", (rows) => { delete rows[1]!.action; }, /attendance_events contains an invalid row/);
  await invalid("undeclared column", "audit_log", (rows) => { rows[0]!.synthetic = 1; }, /audit_log contains an invalid row/);
  await invalid("row that is not an object", "meetings", (rows) => { rows[2] = ["test"] as never; }, /meetings contains an invalid row/);
  await invalid("another installation", "attendance_corrections", (rows) => { rows[0]!.installation_id = "other"; }, /attendance_corrections is not scoped to this installation/);
  await invalid("contest history", "discord_attendance_contests", (rows) => { rows[0]!.prior_reviews_json = '[{"status":"approved"}]'; }, /contest review history is invalid/);
  await invalid("label change source", "member_label_changes", (rows) => { rows[0]!.source = "kiosk"; }, /label change has an invalid source/);
  assert.ok(refusedAsParts >= 5, `${refusedAsParts} refused as parts`);
  // A part holding fewer rows than it declared, though its bytes are the declared ones.
  const short = await f.begin(file, "installation", (body) => { body.parts[0].rows += 1; }); assert.equal(short.status, 201);
  const refused = await short.upload(0); assert.equal(refused.status, 400); assert.match(refused.body.error, /does not hold the rows its part declared/);
  // JSON with a repeated key: JavaScript reads the last value and SQLite's json_extract the first. The Worker stages what
  // it checked, so a pending delivery hidden behind a harmless first value still restores stopped, and counted.
  const session = await f.begin(file); const seq = session.parts.findIndex((part) => part.table === "integration_deliveries");
  const crafted = Buffer.from(session.parts[seq]!.body).toString("utf8").replace('"status":"delivered"', '"status":"delivered","status":"pending"');
  const begun = await f.json("/admin/data/restore/sessions", { method: "POST", body: JSON.stringify({ scope: "installation", confirmation: "RESTORE INSTALLATION", document: transfer.splitBackup(file).document, parts: await Promise.all(session.parts.map(async (part, index) => ({ table: part.table, rows: part.rows, sha256: await transfer.sha256Hex(index === seq ? new TextEncoder().encode(crafted) : part.body) }))) }) });
  assert.equal(begun.status, 201); const base = `/admin/data/restore/sessions/${begun.body.id}`;
  for (let index = 0; index < session.parts.length; index += 1) assert.equal((await f.send(`${base}/parts/${index}`, { method: "PUT", body: index === seq ? crafted : session.parts[index]!.body })).status, 200);
  assertSameData(before, dump(f.db, { skip: operational }), "before the final request");
  const committed = await f.json(`${base}/commit`, { method: "POST", body: JSON.stringify({ confirmation: "RESTORE INSTALLATION", digest: begun.body.digest }) });
  assert.equal(committed.status, 200, JSON.stringify(committed.body)); assert.equal(committed.body.recovery.pausedProviderOperations, 1);
  assert.deepEqual(f.db.rows("SELECT status, COUNT(*) AS n FROM integration_deliveries GROUP BY status ORDER BY status"), [{ status: "delivered", n: smallShape.deliveries - 1 }, { status: "failed", n: 1 }]);
});

test("the final request refuses an incomplete, mismatched or unconfirmed restore, and a failed one rolls back whole", async () => {
  const f = await fixture(); const file = await f.backup(); const before = dump(f.db, { skip: operational }); const schema = f.triggers();
  const session = await f.begin(file); const count = session.parts.length;
  for (let seq = 0; seq < count - 2; seq += 1) assert.equal((await session.upload(seq)).status, 200);
  // An interrupted upload can see what is missing and carry on.
  const status = await f.json(session.base); assert.deepEqual([status.status, status.body.parts, status.body.missing], [200, count, [count - 2, count - 1]]);
  const incomplete = await session.commit(); assert.equal(incomplete.status, 409); assert.equal(incomplete.body.code, "restore_incomplete"); assert.equal(incomplete.body.missing, 2); assert.match(incomplete.body.error, /2 parts of the backup have not been uploaded. Nothing was changed/);
  assert.equal((await session.upload(count - 2)).status, 200); assert.equal((await session.upload(count - 1)).status, 200);
  assert.deepEqual((await f.json(session.base)).body.missing, []);
  const unconfirmed = await session.commit({ confirmation: "RESTORE" }); assert.equal(unconfirmed.status, 400); assert.match(unconfirmed.body.error, /Type RESTORE INSTALLATION exactly/);
  const mismatched = await session.commit({ digest: "0".repeat(64) }); assert.equal(mismatched.status, 409); assert.equal(mismatched.body.code, "restore_digest_mismatch");
  assertSameData(before, dump(f.db, { skip: operational }), "after refused final requests");
  // Should a part go missing between the check and the batch, the batch's own guard stops it before any row changes.
  f.db.raw.prepare("UPDATE data_transfer_chunks SET payload = NULL WHERE session_id = ? AND seq = 0").run(session.body.id);
  await assert.rejects(f.db.batch([...staging.stagedCommitGuards(f.db, session.body.id), f.db.prepare("DELETE FROM installations")]), /UNIQUE constraint failed: data_transfer_chunks/);
  assert.equal((await session.upload(0)).status, 200);
  assertSameData(before, dump(f.db, { skip: operational }), "after the guard");

  // A backup whose rows the database refuses (a scan by a member the backup does not hold) fails in the final batch:
  // every statement before it is undone, and the staged parts are still there to cancel.
  const broken = structuredClone(file); broken.tables.attendance_events!.at(-1)!.member_id = "test-member-nobody";
  const failing = await f.begin(broken); for (let seq = 0; seq < failing.parts.length; seq += 1) assert.equal((await failing.upload(seq)).status, 200);
  assert.equal((await f.json(session.base)).status, 404, "starting another restore ended the first");
  const failed = await failing.commit(); assert.equal(failed.status, 500, JSON.stringify(failed.body)); assert.equal(failed.body.error, "Request failed");
  assertSameData(before, dump(f.db, { skip: operational }), "after the failed batch");
  assert.ok(f.stagedRows() > failing.parts.length);
  assert.deepEqual((await f.json(failing.base, { method: "DELETE" })).body, { cancelled: true }); assert.equal(f.stagedRows(), 0);
  // What was cancelled cannot be committed, uploaded to or read; the first restore's session went the same way.
  for (const gone of [failing, session]) { const late = await gone.commit(); assert.equal(late.status, 404); assert.equal(late.body.code, "transfer_session_missing"); assert.match(late.body.error, /no longer in progress: it was cancelled or replaced/); assert.equal((await gone.upload(0)).status, 404); }
  assertSameData(before, dump(f.db, { skip: operational }), "after cancelling");

  // The dashboard's client cancels by itself when a part is refused or the final request is.
  const viaClient = await f.restoreParts(broken); assert.equal(viaClient?.status, 500); assert.equal(f.stagedRows(), 0);
  const tamper: TransferRequest = (path, init) => f.request(path, path.includes("/parts/3") ? { ...init, body: "[]" } : init);
  await assert.rejects(transfer.restoreInParts(tamper, { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: file }), (error: unknown) => error instanceof transfer.TransferRefused && error.response.status === 409);
  assert.equal(f.stagedRows(), 0); assertSameData(before, dump(f.db, { skip: operational }), "after the client cancelled");
  // The failed batch put the report revision triggers back, and the cancelled and refused restores never touched them.
  assert.deepEqual(f.triggers(), schema);
  // A part that fails in transit is sent again.
  let dropped = 0; const flaky: TransferRequest = async (path, init) => { if (path.includes("/parts/") && dropped < 2) { dropped += 1; if (dropped === 1) throw new TypeError("fetch failed"); return Response.json({ error: "Synthetic outage" }, { status: 503 }); } return f.request(path, init); };
  const retried = await transfer.restoreInParts(flaky, { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: file, wait: async () => undefined }); assert.equal(retried?.status, 200); assert.equal(dropped, 2);
  // An API without restore in parts answers 404, and the caller falls back to the single request.
  assert.equal(await transfer.restoreInParts(async () => Response.json({ error: "Not found" }, { status: 404 }), { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: file }), undefined);
});

test("a backup document larger than one stored value restores intact, and the stored copy is checked before it is used", async () => {
  const source = await fixture(); const file = await source.backup();
  // A long run of emoji in the document, placed so that the 500,000th UTF-16 unit, where the stored text is cut, falls
  // between the two halves of one of them.
  const settings = file.tables.organization_settings![0]!; settings.subtitle = "Test " + "😀".repeat(300_000);
  if ((500_000 - transfer.splitBackup(file).document.indexOf("😀")) % 2 === 0) settings.organization_name = `${settings.organization_name}x`;
  const document = transfer.splitBackup(file).document; const at = document.indexOf("😀");
  assert.equal((500_000 - at) % 2, 1); assert.equal(document.charCodeAt(499_999) & 0xfc00, 0xd800, "the cut would fall inside a surrogate pair");
  const whole = await fixture({ data: false }); const inParts = await fixture({ data: false });
  assert.equal((await whole.restoreWhole(file)).status, 200); const restored = await inParts.restoreParts(file); assert.equal(restored?.status, 200, await restored?.clone().text());
  assert.ok(inParts.db.count("SELECT COUNT(*) AS n FROM audit_log") > 100);
  assert.equal(inParts.db.rows<{ subtitle: string }>("SELECT subtitle FROM organization_settings")[0]!.subtitle, settings.subtitle);
  assertSameData(dump(whole.db, { mask: true, skip: operational }), dump(inParts.db, { mask: true, skip: operational }), "a document in pieces");
  // Should the stored copy differ from the text that was checked, the final request refuses it and nothing is replaced.
  const before = dump(inParts.db, { skip: operational }); const session = await inParts.begin(file); for (let seq = 0; seq < session.parts.length; seq += 1) await session.upload(seq);
  assert.ok(inParts.db.count("SELECT COUNT(*) AS n FROM data_transfer_chunks WHERE table_name = '#document'") >= 2);
  inParts.db.raw.exec("UPDATE data_transfer_chunks SET payload = replace(payload, 'Student', 'Changed') WHERE table_name = '#document'");
  const refused = await session.commit(); assert.equal(refused.status, 409, JSON.stringify(refused.body)); assert.equal(refused.body.code, "restore_document_mismatch"); assert.match(refused.body.error, /Nothing was changed/);
  assertSameData(before, dump(inParts.db, { skip: operational }), "after the refused document");
});

test("the final request can be sent again and is answered the same without running twice", async () => {
  const f = await fixture(); const file = await f.backup("meetings"); file.tables.discord_attendance_notifications![1]!.status = "pending";
  const session = await f.begin(file, "meetings"); for (let seq = 0; seq < session.parts.length; seq += 1) await session.upload(seq);
  const first = await session.commit(); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.recovery.pausedProviderOperations, 1);
  const after = dump(f.db, { skip: operational }); const audits = () => f.db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'data.backup_restored'"); assert.equal(audits(), 1);
  // Its answer was lost on the way, say: the same request again gets the same answer, and nothing runs a second time.
  f.db.raw.exec("UPDATE meetings SET title = 'Edited after the restore' WHERE rowid = 1"); const edited = dump(f.db, { skip: operational });
  for (let repeat = 0; repeat < 2; repeat += 1) { const again = await session.commit(); assert.equal(again.status, 200); assert.deepEqual(again.body, first.body); }
  assertSameData(edited, dump(f.db, { skip: operational }), "after repeated final requests"); assert.equal(audits(), 1); assert.notDeepEqual(edited, after);
  const status = await f.json(session.base); assert.deepEqual([status.status, status.body.committed, status.body.missing], [200, true, []]);
  // A repeat still needs the confirmation, and a final batch for a session that already completed is stopped by its marker.
  assert.equal((await session.commit({ confirmation: "no" })).status, 400);
  await assert.rejects(f.db.batch([...staging.stagedCommitGuards(f.db, session.body.id), f.db.prepare("DELETE FROM installations")]), /UNIQUE constraint failed: data_transfer_chunks/);
  assert.equal(f.stagedRows(), 0); assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_chunks"), 1, "only the marker is kept");

  // The dashboard's client sends the final request again when no answer arrives, as a browser would: without the new
  // session cookie an entire-installation restore's lost answer carried.
  const withLostAnswers = (lose: number, scope: string) => { let lost = 0; const cookie = f.cookie(); const requests: string[] = [];
    const request: TransferRequest = async (path, init) => { requests.push(path); if (!path.endsWith("/commit")) return f.request(path, init); const result = await f.send(path, { ...init, cookie }); if (lost < lose) { lost += 1; throw new TypeError("fetch failed"); } return result; };
    return { requests, run: () => transfer.restoreInParts(request, { scope: scope as "meetings", confirmation: `RESTORE ${scope.toUpperCase()}`, backup: scope === "meetings" ? file : installation, wait: async () => undefined }) }; };
  const installation = await f.backup();
  const once = withLostAnswers(1, "meetings"); const answered = await once.run(); assert.equal(answered?.status, 200); assert.deepEqual(await answered!.json(), first.body);
  assert.equal(once.requests.filter((path) => path.endsWith("/commit")).length, 2); assert.equal(audits(), 2);
  // No answer at all: the outcome is unknown, and is reported as that rather than as a failure.
  await assert.rejects(withLostAnswers(9, "meetings").run(), (error: unknown) => error instanceof transfer.RestoreOutcomeUnknown && !error.signedOut); assert.equal(audits(), 3);
  // An entire-installation restore that completed ended every session, the asking one included: that is its answer.
  await assert.rejects(withLostAnswers(1, "installation").run(), (error: unknown) => error instanceof transfer.RestoreOutcomeUnknown && error.signedOut);
});

test("an upload or download whose connection drops carries on with what is missing", async () => {
  const f = await fixture(); const file = await f.backup(); const before = dump(f.db, { skip: operational });
  // Every request for parts fails for a while after the third part: longer than one part's own three tries.
  const outage = (kind: "restore" | "backup") => { let failing = 0; let moved = 0; const requests: string[] = []; const waits: number[] = [];
    const request: TransferRequest = async (path, init) => {
      requests.push(`${init?.method ?? "GET"} ${path.replace(/[0-9a-f-]{36}/, "id")}`);
      if (path.includes("/parts/")) { if (moved === 3 && failing < 9) { failing += 1; throw new TypeError("fetch failed"); } const result = await f.request(path, init); moved += 1; return result; }
      return f.request(path, init);
    };
    return { requests, waits, request, wait: async (milliseconds: number) => { waits.push(milliseconds); } }; };
  const up = outage("restore");
  const restored = await transfer.restoreInParts(up.request, { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: file, wait: up.wait });
  assert.equal(restored?.status, 200, await restored?.clone().text());
  // It asked which parts were missing instead of cancelling, and no part that had arrived was sent twice.
  assert.ok(up.requests.includes("GET /admin/data/restore/sessions/id")); assert.ok(!up.requests.some((path) => path.startsWith("DELETE"))); assert.ok(up.waits.includes(1_000));
  const sentParts = up.requests.filter((path) => path.startsWith("PUT")); const parts = transfer.splitBackup(file).parts.length;
  assert.equal(new Set(sentParts).size, parts); assert.ok(sentParts.length <= parts + 9 + 4, `${sentParts.length} uploads for ${parts} parts`);
  const restoredData = dump(f.db, { skip: operational }); for (const table of ["attendance_events", "meetings", "members", "attendance_corrections", "integration_deliveries"]) assert.deepEqual(restoredData[table], before[table], `${table} restored after an outage`);
  const down = outage("backup"); const downloaded = await transfer.downloadBackup(down.request, { scope: "meetings", wait: down.wait });
  assert.ok(downloaded); assert.deepEqual((JSON.parse(downloaded.text) as Backup).tables.attendance_events, (await f.backup("meetings")).tables.attendance_events);
  assert.ok(!down.requests.some((path) => path.startsWith("DELETE"))); assert.ok(down.waits.includes(1_000));
  // A connection that never comes back ends the transfer; the restore changed nothing.
  const state = dump(f.db, { skip: operational });
  const dead: TransferRequest = async (path, init) => { if (path.includes("/parts/") || init?.method === undefined) throw new TypeError("fetch failed"); return f.request(path, init); };
  await assert.rejects(transfer.restoreInParts(dead, { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: file, wait: async () => undefined }), TypeError);
  assertSameData(state, dump(f.db, { skip: operational }), "after an upload that never resumed");
});

test("the backup file is put together and checked before the download is completed", async () => {
  const f = await fixture(); const calls: string[] = [];
  f.db.raw.exec(`INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at,maintenance) VALUES('7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2d','primary','v9.9.9','${"a".repeat(40)}','Synthetic','9.9.8','prepared','2026-01-01','2099-01-01','2026-01-01',0)`);
  const exportedAt = () => f.db.rows<{ at: string | null }>("SELECT backup_exported_at AS at FROM web_update_requests")[0]!.at;
  // The start answer claims a part with a row more than the table will hold: the assembled file cannot be right.
  const wrong: TransferRequest = async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path.split("/").at(-1)}`); const result = await f.request(path, init);
    if (!path.endsWith("/backup/sessions")) return result;
    const body = await result.json() as { document: Backup }; body.document.tables.members = [{ id: "test-extra-row" }];
    return Response.json(body, { status: result.status });
  };
  await assert.rejects(transfer.downloadBackup(wrong, { scope: "installation", updateRequestId: "7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2d" }), /parts do not match its tables/);
  assert.ok(!calls.includes("POST complete"), "a file that failed its check never completes the download"); assert.equal(exportedAt(), null); assert.equal(f.stagedRows(), 0);
  // Completing is the last request of a good download.
  calls.length = 0; const good: TransferRequest = (path, init) => { calls.push(`${init?.method ?? "GET"} ${path.split("/").at(-1)}`); return f.request(path, init); };
  assert.ok(await transfer.downloadBackup(good, { scope: "installation", updateRequestId: "7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2d" })); assert.equal(calls.at(-1), "POST complete"); assert.notEqual(exportedAt(), null);
  // An ordinary download is not lost because tidying up afterwards failed.
  const untidy: TransferRequest = (path, init) => path.endsWith("/complete") ? Promise.reject(new TypeError("fetch failed")) : f.request(path, init);
  assert.ok(await transfer.downloadBackup(untidy, { scope: "roster", wait: async () => undefined }));
});

test("each Admin has one restore and one download staged, another Admin's is left alone, and their number is bounded", async () => {
  const f = await fixture();
  const admins = ["admin-b", "admin-c", "admin-d", "admin-e"];
  for (const id of admins) f.db.raw.exec(`INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('${id}','primary','${id}','admin','2026-01-01'); INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES ('primary','${id}',0); INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES ('primary','${id}',0);`);
  const cookieFor = async (id: string) => "lancerlogin_session=" + await codec.issue({ userId: id, role: "admin" });
  const start = async (cookie?: string, scope = "installation") => { const result = await f.send("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope }), ...(cookie ? { cookie } : {}) }); assert.equal(result.status, 201); return await result.json() as { id: string; parts: { seq: number }[] }; };
  const part = (session: { id: string; parts: { seq: number }[] }, cookie?: string) => f.send(`/admin/data/backup/sessions/${session.id}/parts/${session.parts[0]!.seq}`, cookie ? { cookie } : {});
  // A web update's backup being downloaded by one Admin survives another Admin's download, and that Admin's restore.
  const mine = await start(); const other = await cookieFor("admin-b"); const theirs = await start(other);
  assert.equal((await part(mine)).status, 200); assert.equal((await part(theirs, other)).status, 200);
  const file = await f.backup("roster"); const restore = await f.begin(file, "roster"); assert.equal(restore.status, 201); assert.equal((await part(mine)).status, 200);
  // The same Admin starting again replaces only their own.
  const again = await start(other, "roster"); assert.equal((await part(theirs, other)).status, 404); assert.equal((await part(again, other)).status, 200); assert.equal((await part(mine)).status, 200);
  assert.equal((await f.json(restore.base)).status, 200);
  // No more than the limit are kept, whoever started them: the oldest goes.
  for (const id of admins.slice(1)) { await new Promise((resolve) => setTimeout(resolve, 3)); await start(await cookieFor(id), "roster"); }
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_sessions WHERE kind = 'backup'"), staging.TRANSFER_SESSION_LIMIT);
  assert.equal((await part(mine)).status, 404, "the oldest download made way"); assert.equal((await part(again, other)).status, 200);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_sessions WHERE kind = 'restore'"), 1);
});

test("the estimate of rows a restore writes follows the schema, and the start of a restore returns it", async () => {
  const f = await fixture(); const file = await f.backup();
  // One written row for the record and one for each index of its table; the report revision triggers are set aside.
  for (const table of Object.keys(file.tables)) assert.equal(writes.restoreWriteCosts[table], 1 + f.db.rows(`PRAGMA index_list('${table}')`).length, `${table}: update restoreWriteCosts in packages/shared/src/restore-writes.ts`);
  assert.deepEqual(Object.keys(writes.restoreWriteCosts).filter((table) => !(table in file.tables)), []);
  const counts = writes.backupRecordCounts(file); assert.equal(counts.attendance_events, file.tables.attendance_events!.length);
  const estimate = writes.estimateRestoreWrites(counts); assert.ok(estimate > 6 * file.tables.attendance_events!.length);
  // What the dashboard works out from the file is what the API works out from the checked backup.
  const session = await f.begin(file); assert.equal(session.body.estimatedRowsWritten, estimate);
  for (const scope of ["meetings", "roster"]) { const scoped = await f.backup(scope); assert.equal((await f.begin(scoped, scope)).body.estimatedRowsWritten, writes.estimateRestoreWrites(writes.backupRecordCounts(scoped)), scope); }
  // Plugin sections count with a default cost; something that is not a backup counts nothing.
  assert.equal(writes.estimateRestoreWrites(writes.backupRecordCounts({ tables: { members: [{}, {}] }, externalModules: [{ tables: { synthetic_rows: [{}, {}, {}] } }] })), 2 * writes.restoreWriteCosts.members! + 3 * writes.defaultRestoreWriteCost);
  assert.deepEqual(writes.backupRecordCounts("text"), {}); assert.ok(writes.restoreWriteWarningRows < writes.d1FreeDailyRowsWritten);
});

test("an abandoned restore is cleaned up, and deleting data removes what is staged", async () => {
  const f = await fixture();

  // Abandoned: parts uploaded, then nothing. The scheduled clean-up removes it once it expires, and not before.
  const abandoned = await f.begin(await f.backup()); await abandoned.upload(0); await abandoned.upload(1);
  assert.ok(f.stagedRows() > 3); const live = dump(f.db, { skip: operational });
  await pruneStaleRows(f.db, Date.now() + staging.TRANSFER_SESSION_MS - 60_000); assert.ok(f.stagedRows() > 3);
  f.db.raw.exec("UPDATE data_transfer_sessions SET expires_at = '2020-01-01T00:00:00.000Z'");
  // Expired, it can no longer be used even before the clean-up runs.
  assert.equal((await abandoned.upload(2)).status, 404); assert.equal((await abandoned.commit()).status, 404); assert.equal((await f.json(abandoned.base)).status, 404);
  await pruneStaleRows(f.db); assert.equal(f.stagedRows(), 0);
  assertSameData(live, dump(f.db, { skip: operational }), "after the clean-up");
  // Starting a backup or a restore also removes expired sessions of either kind.
  const expired = await f.begin(await f.backup()); f.db.raw.exec("UPDATE data_transfer_sessions SET expires_at = '2020-01-01T00:00:00.000Z'");
  assert.equal((await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "roster" }) })).status, 201);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_sessions WHERE id = ?", expired.body.id), 0); assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_sessions"), 1);
  // Staging never travels in a backup, and each deletion removes what is staged: parts hold rows of the data deleted.
  const backup = await f.backup(); assert.ok(!Object.keys(backup.tables).some((table) => table.startsWith("data_transfer")));
  for (const [scope, confirmation] of [["attendance", "DELETE ATTENDANCE"], ["roster", "DELETE ROSTER"]]) {
    const waiting = await f.begin(backup); await waiting.upload(0); await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "meetings" }) }); assert.ok(f.stagedRows() > 4);
    assert.equal((await f.send("/admin/data", { method: "DELETE", body: JSON.stringify({ scope, confirmation }) })).status, 200, scope);
    assert.equal(f.stagedRows(), 0, scope); assert.equal(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_sessions"), 0);
  }
  const staged = await f.begin(backup); await staged.upload(0); assert.ok(f.stagedRows() > 2);
  assert.equal((await f.send("/admin/data", { method: "DELETE", body: JSON.stringify({ scope: "installation", confirmation: "DELETE INSTALLATION" }) })).status, 200);
  assert.equal(f.stagedRows(), 0); assert.equal(f.db.count("SELECT COUNT(*) AS n FROM installations"), 0);
});

for (const scope of ["installation", "meetings", "roster"] as const) {
  test(`backup in parts is the file the single request produces, from one snapshot (${scope})`, async () => {
    const f = await fixture();
    // A registration of a module this build does not have stays out of both.
    if (scope === "installation") f.db.raw.exec("INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','synthetic-removed',1); INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','synthetic-removed',1,1,'disabled',1,0);");
    f.db.raw.exec("UPDATE discord_label_role_mappings SET sync_direction = 'two_way' WHERE 0; UPDATE meetings SET attendance_weight = 1.5 WHERE rowid % 4 = 0");
    // Text a part must carry exactly: a NUL, an emoji, separators JSON treats specially, and a number stored as text.
    f.db.raw.prepare("UPDATE meetings SET notes = ? WHERE rowid % 7 = 0").run("Test   NUL 😀   \"quoted\" \ud83d"); f.db.raw.prepare("UPDATE members SET last_name = ? WHERE rowid % 5 = 0").run("Test   😀"); f.db.raw.exec("UPDATE members SET first_name = 777 WHERE rowid % 9 = 0");
    const audits = () => f.db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'data.backup_exported'");
    const single = await f.backup(scope); assert.equal(audits(), 1);
    // The snapshot is taken when the download starts: rows written while parts are fetched are not in the file.
    let interfered = false;
    const during: TransferRequest = async (path, init) => { if (path.includes("/parts/") && !interfered) { interfered = true; f.db.raw.exec("UPDATE members SET first_name = 'Later'; DELETE FROM attendance_events; UPDATE meetings SET title = 'Later'"); } return f.request(path, init); };
    const progress: [number, number][] = [];
    const downloaded = await transfer.downloadBackup(during, { scope, onProgress: (done, total) => progress.push([done, total]) });
    assert.ok(downloaded && interfered); assert.equal(audits(), 2, "a backup in parts writes the same audit entry");
    const file = JSON.parse(downloaded.text) as Backup;
    assert.match(downloaded.filename, new RegExp(`^lancerlogin-${scope}-backup-\\d{4}-\\d{2}-\\d{2}\\.json$`));
    // The single request ran first, so its own audit entry is the one row the later snapshot adds.
    const expected = structuredClone(single); if (scope === "installation") expected.tables.audit_log!.push(file.tables.audit_log!.at(-1)!);
    assert.deepEqual(Object.keys(file), Object.keys(single)); assert.deepEqual(Object.keys(file.tables), Object.keys(single.tables));
    assert.deepEqual({ ...file, exportedAt: null }, { ...expected, exportedAt: null });
    if (scope === "installation") { assert.equal(file.tables.audit_log!.at(-1)!.action, "data.backup_exported"); assert.ok(!file.tables.platform_modules!.some((row) => row.module_id === "synthetic-removed")); }
    if (scope === "roster") assert.deepEqual([file.attendanceRecentDays, file.attendancePolicyActivatedOn], [30, null]);
    if (scope !== "roster") assert.ok(file.tables.meetings!.some((row) => row.attendance_weight === 1.5) && file.tables.meetings!.some((row) => row.attendance_weight === 1));
    assert.equal(f.stagedRows(), 0, "completing the download removes the staged parts");
    const parts = f.sent.filter((item) => item.path.includes("/backup/sessions/") && item.path.includes("/parts/"));
    assert.ok(parts.length >= (scope === "roster" ? 3 : 8)); assert.deepEqual(progress.at(-1), [parts.length, parts.length]);
  });
}

test("backup parts are bounded, private to their Admin and gone once the download ends", async () => {
  const f = await fixture();
  const begun = await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "installation" }) }); assert.equal(begun.status, 201, JSON.stringify(begun.body));
  const base = `/admin/data/backup/sessions/${begun.body.id}`; const parts = begun.body.parts as { seq: number; rows: number; table: string }[];
  assert.deepEqual(begun.body.columns.installations.slice(0, 3), ["id", "created_at", "auth_mode"]); assert.deepEqual(Object.keys(begun.body.columns), [...new Set(parts.map((part) => part.table))]);
  assert.deepEqual(Object.values(begun.body.document.tables as Record<string, unknown[]>).filter((rows) => rows.length), [], "the document carries no rows");
  const counts = referenceCounts(smallShape) as Record<string, number>;
  for (const table of ["attendance_events", "meetings", "audit_log"]) assert.equal(parts.filter((part) => part.table === table).reduce((total, part) => total + part.rows, 0), counts[table], table);
  // Each part ends with the row that crosses the target, so none is larger than the target plus one row.
  const sizes = f.db.rows<{ seq: number; size: number }>("SELECT seq, length(payload) AS size FROM data_transfer_chunks WHERE seq >= 0");
  assert.equal(sizes.length, parts.length); assert.ok(sizes.every((part) => part.size <= staging.BACKUP_PART_TARGET_CHARS + 2_000), `largest part ${Math.max(...sizes.map((part) => part.size))}`);
  assert.ok(parts.filter((part) => part.table === "attendance_events").length >= 2);
  const first = await f.send(`${base}/parts/${parts[0]!.seq}`); assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "no-store"); assert.match(first.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await first.json(), [["primary", "2026-01-01T00:00:00.000Z", "local", null, null, 0, 0, 0, 0]]);
  assert.equal((await f.send(`${base}/parts/999999999`)).status, 404); assert.equal((await f.send(`${base}/parts/-1`)).status, 404);
  const operator = "lancerlogin_session=" + await codec.issue({ userId: "operator", role: "operator" });
  assert.equal((await f.send(`${base}/parts/${parts[0]!.seq}`, { cookie: operator })).status, 403);
  assert.equal((await f.send("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "installation" }), cookie: operator })).status, 403);
  assert.equal((await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "everything" }) })).status, 400);
  assert.equal((await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "roster", updateRequestId: "update" }) })).status, 400);
  // Starting another download replaces this one; a part of the old one is gone, and so is completing it.
  const next = await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "meetings" }) }); assert.equal(next.status, 201);
  const gone = await f.json(`${base}/parts/${parts[0]!.seq}`); assert.equal(gone.status, 404); assert.equal(gone.body.code, "transfer_session_missing");
  assert.equal((await f.json(`${base}/complete`, { method: "POST", body: "{}" })).status, 404);
  assert.deepEqual((await f.json(`/admin/data/backup/sessions/${next.body.id}`, { method: "DELETE" })).body, { cancelled: true }); assert.equal(f.stagedRows(), 0);
  // A download whose part fails is cancelled by the client; an API that cannot stage a backup falls back to one request.
  const failing: TransferRequest = (path, init) => path.includes("/parts/") ? Promise.resolve(Response.json({ error: "Synthetic" }, { status: 404 })) : f.request(path, init);
  await assert.rejects(transfer.downloadBackup(failing, { scope: "meetings" }), transfer.TransferRefused); assert.equal(f.stagedRows(), 0);
  for (const status of [404, 503]) assert.equal(await transfer.downloadBackup(async () => Response.json({ error: "Unavailable" }, { status }), { scope: "meetings" }), undefined);
});

test("a web update's backup is recorded when the download in parts completes, not when it starts", async () => {
  const f = await fixture();
  f.db.raw.exec(`INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at,maintenance) VALUES('7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2a','primary','v9.9.9','${"a".repeat(40)}','Synthetic','9.9.8','prepared','2026-01-01','2099-01-01','2026-01-01',0)`);
  const exportedAt = () => f.db.rows<{ at: string | null }>("SELECT backup_exported_at AS at FROM web_update_requests WHERE id = '7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2a'")[0]!.at;
  const begun = await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "installation", updateRequestId: "7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2a" }) }); assert.equal(begun.status, 201, JSON.stringify(begun.body));
  assert.equal(exportedAt(), null);
  for (const part of begun.body.parts as { seq: number }[]) assert.equal((await f.send(`/admin/data/backup/sessions/${begun.body.id}/parts/${part.seq}`)).status, 200);
  assert.equal(exportedAt(), null);
  assert.deepEqual((await f.json(`/admin/data/backup/sessions/${begun.body.id}/complete`, { method: "POST", body: "{}" })).body, { completed: true });
  assert.notEqual(exportedAt(), null); assert.equal(f.stagedRows(), 0);
  // Through the client, and a cancelled download records nothing.
  f.db.raw.exec("UPDATE web_update_requests SET backup_exported_at = NULL");
  const cancelled = await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "installation", updateRequestId: "7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2a" }) });
  await f.json(`/admin/data/backup/sessions/${cancelled.body.id}`, { method: "DELETE" }); assert.equal(exportedAt(), null);
  assert.ok(await transfer.downloadBackup(f.request, { scope: "installation", updateRequestId: "7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2a" })); assert.notEqual(exportedAt(), null);
});

test("while an update suspends writes, restores and staged backups wait as every other write does", async () => {
  const f = await fixture(); const file = await f.backup(); const session = await f.begin(file); await session.upload(0);
  f.db.raw.exec(`INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,stage,maintenance,created_at,expires_at,updated_at) VALUES('7a1f0c7e-4c1b-4d5e-9f3a-2b6c8d0e1f2b','primary','v9.9.9','${"a".repeat(40)}','Synthetic','9.9.8','running','deploy',1,'2026-01-01','2099-01-01','2026-01-01')`);
  const before = dump(f.db, { skip: operational });
  for (const answer of [await session.upload(1), await session.commit(), await f.begin(file), await f.json("/admin/data/restore", { method: "POST", body: JSON.stringify({ scope: "installation", confirmation: "RESTORE INSTALLATION", backup: file }) }), await f.json("/admin/data/backup/sessions", { method: "POST", body: JSON.stringify({ scope: "installation" }) })]) {
    assert.equal(answer.status, 503); assert.equal(answer.body.code, "update_maintenance");
  }
  assertSameData(before, dump(f.db, { skip: operational }), "during maintenance");
  // A backup can still be taken: the dashboard falls back to the single read-only request.
  assert.equal(await transfer.downloadBackup(f.request, { scope: "installation" }), undefined); assert.equal((await f.send("/admin/data/backup?scope=installation")).status, 200);
  // Once the update is over the staged restore carries on where it stopped.
  f.db.raw.exec("UPDATE web_update_requests SET maintenance = 0, state = 'succeeded'");
  for (let seq = 1; seq < session.parts.length; seq += 1) assert.equal((await session.upload(seq)).status, 200);
  assert.equal((await session.commit()).status, 200);
});

test("staged SQL stays within D1's limits and keeps values exact", async () => {
  const f = await fixture({ data: false });
  // More columns than D1 allows arguments in one function call (32), with every kind of value a backup row holds.
  const columns = Array.from({ length: 70 }, (_, index) => `c${index}`);
  f.db.raw.exec(`CREATE TABLE synthetic_wide (installation_id TEXT, ${columns.map((column) => `${column}`).join(", ")}); CREATE TABLE synthetic_copy (installation_id TEXT, ${columns.join(", ")});`);
  const values = (row: number) => columns.map((_, index) => index % 5 === 0 ? null : index % 5 === 1 ? row * 1000 + index : index % 5 === 2 ? row + index / 8 : index % 5 === 3 ? `Test "quoted" \\ value é ✓ ${row}-${index}\n` : '{"json":["text",1]}');
  const insert = f.db.raw.prepare(`INSERT INTO synthetic_wide VALUES ('primary', ${columns.map(() => "?").join(", ")})`);
  for (let row = 0; row < 900; row += 1) insert.run(...values(row) as never[]);
  const session = await staging.createBackupSession(f.db, { userId: "admin", scope: "installation", sources: [{ table: "synthetic_wide", columns: ["installation_id", ...columns], where: "installation_id = 'primary'" }, { table: "synthetic_copy", columns: ["installation_id", ...columns], where: "installation_id = 'primary'" }] });
  const sql = f.db.rows<{ seq: number; payload: string; row_count: number }>("SELECT seq, payload, row_count FROM data_transfer_chunks WHERE seq >= 0 ORDER BY seq");
  assert.ok(sql.length > 5 && session.parts.length === sql.length); assert.ok(session.parts.every((part) => part.source === 0), "an empty table has no parts");
  const rows = sql.flatMap((part) => { const list = JSON.parse(part.payload) as unknown[][]; assert.equal(list.length, part.row_count); return list; });
  assert.deepEqual(rows, Array.from({ length: 900 }, (_, row) => ["primary", ...values(row)]), "every row once, in table order, with exact values");
  // No function call in the generated SQL takes more than 32 arguments.
  const prepared: string[] = []; const recording = { prepare: (text: string) => { prepared.push(text); return f.db.prepare(text); }, batch: (list: never[]) => f.db.batch(list) };
  await staging.createBackupSession(recording as never, { userId: "admin", scope: "installation", sources: [{ table: "synthetic_wide", columns: ["installation_id", ...columns], where: "installation_id = 'primary'" }] });
  const calls = prepared.join("\n").match(/json_array\([^()]*\)/g) ?? []; assert.ok(calls.length >= 3); assert.ok(calls.every((call) => call.split(",").length <= 32));
  // The staged form copies back into a table unchanged, however many columns.
  const id = (await staging.createRestoreSession(f.db, { userId: "admin", scope: "installation", document: "{}", parts: [{ seq: 0, table: "synthetic_copy", rows: rows.length, sha256: "0".repeat(64) }], context: {} })).id;
  await staging.storeRestorePart(f.db, id, 0, staging.stagedPayload("synthetic_copy", ["installation_id", ...columns], rows.map((row) => Object.fromEntries(["installation_id", ...columns].map((column, index) => [column, row[index]])))), 0);
  await f.db.batch([...staging.stagedCommitGuards(f.db, id), staging.stagedRowsInsert(f.db, id, "synthetic_copy", ["installation_id", ...columns]), ...staging.stagedCommitCleanup(f.db, id, { restored: true })]);
  const quoted = (table: string) => f.db.rows(`SELECT ${["installation_id", ...columns].map((column) => `quote(${column}) AS ${column}`).join(", ")} FROM ${table}`);
  assert.deepEqual(quoted("synthetic_copy"), quoted("synthetic_wide")); assert.deepEqual(await staging.restoreSessionResult(f.db, id), { restored: true });
  assert.equal(await staging.restoreSessionResult(f.db, "00000000-0000-4000-8000-000000000000"), null);
  assert.throws(() => staging.stagedPayload("synthetic_copy", ["installation_id", "c0"], [{ installation_id: "primary" }]), /contains an invalid row/);
  assert.throws(() => staging.stagedRowsInsert(f.db, id, "synthetic; DROP TABLE users", ["id"]), /plain identifiers/);
  // A backup document larger than one stored value is kept in pieces and read back whole.
  const document = JSON.stringify({ text: "é".repeat(1_300_000) });
  const large = await staging.createRestoreSession(f.db, { userId: "admin", scope: "installation", document, parts: [], context: { note: "synthetic" } });
  assert.ok(f.db.count("SELECT COUNT(*) AS n FROM data_transfer_chunks WHERE table_name = '#document'") >= 3);
  const loaded = await staging.loadStagedRestore(f.db, large.id, "admin"); assert.equal(loaded.document, document); assert.deepEqual([loaded.missing, loaded.paused, loaded.digest, loaded.context], [0, 0, large.digest, { note: "synthetic", documentSha256: await staging.sha256Hex(document) }]);
  // A piece never ends between the two halves of a surrogate pair, wherever the pair falls, and the pieces join to the text.
  for (const lead of ["", "x", "xy"]) {
    const text = lead + "😀".repeat(40) + "é" + "\u0000" + "😀".repeat(9); const pieces = staging.documentPieces(text, 7);
    assert.equal(pieces.join(""), text); assert.ok(pieces.every((piece) => piece.length <= 7 && piece.length >= 1 && Buffer.from(piece, "utf8").toString("utf8") === piece), lead);
  }
  assert.deepEqual(staging.documentPieces("", 7), []); assert.deepEqual(staging.documentPieces("😀😀", 1).join(""), "😀😀");
  // Half a pair alone is staged as U+FFFD, the bytes D1 stores when the same text is bound.
  assert.equal(staging.stagedPayload("synthetic_copy", ["c0", "c1"], [{ c0: "a\ud83db", c1: "\\ud83d \u0000 😀" }]), JSON.stringify([["a\ufffdb", "\\ud83d \u0000 😀"]]));
});

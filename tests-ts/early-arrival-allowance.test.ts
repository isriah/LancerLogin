// quick-check: covers apps/api/migrations/**
// The early arrival allowance on a real migrated SQLite database: the 0099 upgrade, kiosk scans in the early window at
// their own time, the scan resolution for meetings that already overlap, meeting saves, and backup schema 51.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { applyCoreMigrations, readCoreMigrations } from "./fixtures/d1-database.ts";
import { BackupDatabase, backupClient } from "./fixtures/backup-database.ts";
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";

const secret = "A".repeat(43);
const schema50Golden = JSON.parse(readFileSync(new URL("./fixtures/first-party-backup-envelope-schema-50.json", import.meta.url), "utf8"));

test("migration 0099 gives existing installations the 15-minute allowance and keeps meetings that now overlap", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const migrations = readCoreMigrations(); const index = migrations.findIndex((file) => file.name === "0099_early_scan_minutes.sql");
    assert.ok(index > 0);
    applyCoreMigrations(sqlite, migrations.slice(0, index));
    // Forty minutes apart: clear of the 30-minute late window before the upgrade, overlapping by 15 minutes early after it.
    sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO organization_settings(installation_id,time_zone,late_scan_minutes) VALUES ('primary','UTC',30);
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('first','primary','Test Build','2026-09-30T18:00:00.000Z','2026-09-30T20:00:00.000Z','admin','2026-01-01');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('second','primary','Test Rehearsal','2026-09-30T20:40:00.000Z','2026-09-30T22:00:00.000Z','admin','2026-01-01');`);
    applyCoreMigrations(sqlite, migrations.slice(index));
    assert.deepEqual({ ...sqlite.prepare("SELECT late_scan_minutes AS late, early_scan_minutes AS early FROM organization_settings").get() }, { late: 30, early: 15 });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM meetings WHERE deleted_at IS NULL").get()?.n, 2, "the upgrade keeps both meetings");
    assert.throws(() => sqlite.exec("UPDATE organization_settings SET early_scan_minutes = 181"), /CHECK/);
    assert.throws(() => sqlite.exec("UPDATE organization_settings SET early_scan_minutes = -1"), /CHECK/);
  } finally { sqlite.close(); }
});

test("a kiosk scan in the early arrival window is an arrival at its own time; one before it is refused", async (context) => {
  const { call, scan, events } = await fixture(context);
  const before = await scan("SYN-001", "early-0", "2026-09-30T17:44:00.000Z");
  assert.equal(before.status, 409);
  assert.deepEqual(await before.json(), { error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting" });
  const chosen = await scan("SYN-001", "early-1", "2026-09-30T17:44:59.000Z", "evening");
  assert.equal(chosen.status, 409, "one second before the window opens");
  assert.deepEqual(await chosen.json(), { error: "This meeting has not started", code: "scan_window_closed" }, "the wording the kiosk recognizes");

  const opening = await scan("SYN-001", "early-2", "2026-09-30T17:45:00.000Z");
  assert.equal(opening.status, 202, await opening.clone().text());
  const arrival = await opening.json() as { meeting: { id: string; title: string }; action: string };
  assert.deepEqual(arrival.meeting, { id: "evening", title: "Test Evening" }, "found without choosing a meeting");
  assert.equal(arrival.action, "check_in");
  const inside = await scan("SYN-002", "early-3", "2026-09-30T17:50:00.000Z", "evening");
  assert.equal(inside.status, 202, await inside.clone().text());
  assert.deepEqual(events(), [
    { member: "member", meeting: "evening", action: "check_in", at: "2026-09-30T17:45:00.000Z" },
    { member: "member-b", meeting: "evening", action: "check_in", at: "2026-09-30T17:50:00.000Z" },
  ], "each arrival keeps its scan time, not the 6:00 PM start");

  // After the meeting, the early arrival is present and not counted as a late arrival.
  assert.equal((await scan("SYN-002", "leave-b", "2026-09-30T20:05:00.000Z")).status, 202);
  const attendance = await (await call("/attendance?meetingId=evening")).json() as { attendance: { externalId: string; disposition: string; checkedInAt?: string; lateMinutes?: number }[] };
  const avery = attendance.attendance.find((row) => row.externalId === "SYN-002")!;
  assert.equal(avery.disposition, "present");
  assert.equal(avery.checkedInAt, "2026-09-30T17:50:00.000Z");
  assert.equal(avery.lateMinutes, undefined);
});

test("a scan in both an earlier meeting's late window and an overlapping next meeting's early window goes to the earlier meeting", async (context) => {
  const { database, scan, events } = await fixture(context);
  // Saved before the early arrival allowance: Test Evening's scans close at 8:30 PM, Test Late Session's open at 8:25 PM.
  database.sqlite.exec("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('late-session','primary','Test Late Session','2026-09-30T20:40:00.000Z','2026-09-30T22:00:00.000Z','admin','2026-01-01')");
  assert.equal((await scan("SYN-001", "arrive-a", "2026-09-30T18:05:00.000Z")).status, 202);
  const leave = await scan("SYN-001", "leave-a", "2026-09-30T20:27:00.000Z");
  assert.equal(leave.status, 202);
  assert.deepEqual((await leave.json() as { meeting: { id: string }; action: string }).meeting.id, "evening", "a departure in both windows stays with the meeting in its late window");
  const both = await scan("SYN-002", "both-b", "2026-09-30T20:30:00.000Z");
  assert.equal((await both.json() as { meeting: { id: string } }).meeting.id, "evening", "the last moment of the late window still belongs to the earlier meeting");
  const next = await scan("SYN-002", "next-b", "2026-09-30T20:32:00.000Z");
  assert.equal(next.status, 202, await next.clone().text());
  assert.equal((await next.json() as { meeting: { id: string } }).meeting.id, "late-session", "after the late window closes, the next meeting's early window takes the scan");
  assert.deepEqual(events().map((event) => [event.member, event.meeting, event.action]), [
    ["member", "evening", "check_in"], ["member", "evening", "check_out"], ["member-b", "evening", "check_in"], ["member-b", "late-session", "check_in"],
  ]);
});

test("meeting saves refuse overlaps through the early window and ignore overlaps saved before it", async (context) => {
  const { database, call } = await fixture(context);
  const create = (title: string, startsAt: string, endsAt: string) => call("/meetings", { title, startsAt, endsAt, required: true });
  const clash = await create("Test Proposed", "2026-09-30T20:40:00.000Z", "2026-09-30T21:00:00.000Z");
  assert.equal(clash.status, 409, "Test Evening closes at 8:30 PM and this one would open at 8:25 PM");
  assert.match((await clash.json() as { error: string }).error, /cannot overlap\. Test Evening \(2026-09-30T18:00:00\.000Z\) conflicts with Test Proposed \(2026-09-30T20:40:00\.000Z\)/);
  const clear = await create("Test Proposed", "2026-09-30T20:46:00.000Z", "2026-09-30T21:00:00.000Z");
  assert.equal(clear.status, 201, await clear.clone().text());

  // Two meetings that already overlap by the early window do not block an unrelated meeting nearby.
  database.sqlite.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('legacy-a','primary','Test Legacy A','2026-10-01T18:00:00.000Z','2026-10-01T20:00:00.000Z','admin','2026-01-01');
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('legacy-b','primary','Test Legacy B','2026-10-01T20:40:00.000Z','2026-10-01T21:00:00.000Z','admin','2026-01-01');`);
  const unrelated = await create("Test Unrelated", "2026-10-01T23:00:00.000Z", "2026-10-01T23:30:00.000Z");
  assert.equal(unrelated.status, 201, await unrelated.clone().text());
  const edit = await call("/meetings/legacy-b", { title: "Test Legacy B", startsAt: "2026-10-01T20:40:00.000Z", endsAt: "2026-10-01T21:10:00.000Z", required: true }, "PATCH");
  assert.equal(edit.status, 409, "editing a meeting that overlaps keeps refusing until it is moved clear");
  assert.match((await edit.json() as { error: string }).error, /Test Legacy A .* conflicts with Test Legacy B/);
});

test("schema 51 backups carry the early arrival allowance and older backups restore with 15 minutes", async (context) => {
  const db = new BackupDatabase(); context.after(() => db.raw.close()); const client = backupClient(worker, db);
  db.raw.exec("UPDATE organization_settings SET early_scan_minutes = 40");
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 51);
  assert.equal(backup.tables.organization_settings[0].early_scan_minutes, 40);
  for (const scope of ["meetings", "roster"] as const) assert.equal("organization_settings" in (await client.backup(scope)).tables, false);

  db.raw.exec("UPDATE organization_settings SET early_scan_minutes = 5");
  const restored = await client.restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal(db.rows("SELECT early_scan_minutes AS early FROM organization_settings")[0].early, 40, "the allowance restores");

  const invalid = structuredClone(backup); invalid.tables.organization_settings[0].early_scan_minutes = 181;
  assert.equal((await client.restore(invalid)).status, 400);

  const legacy = structuredClone(backup); legacy.schemaVersion = 50; omitContestResubmissionFields(legacy);
  assert.deepEqual(legacy.ownership, schema50Golden.installation.ownership, "the shaped archive carries the schema 50 ownership");
  assert.equal("early_scan_minutes" in legacy.tables.organization_settings[0], false);
  const stray = structuredClone(legacy); stray.tables.organization_settings[0].early_scan_minutes = 40;
  assert.equal((await client.restore(stray)).status, 400, "a schema 50 archive never carried the allowance");
  const older = await client.restore(legacy); assert.equal(older.status, 200, await older.clone().text());
  assert.equal(db.rows("SELECT early_scan_minutes AS early FROM organization_settings")[0].early, 15, "an older backup restores the default");
});

async function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T21:00:00Z") });
  context.mock.method(globalThis, "fetch", () => { throw new Error("No live provider access is permitted in this fixture"); });
  const database = new Database(); context.after(() => database.sqlite.close());
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database } as unknown as Env;
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const call = (path: string, body?: unknown, method?: string, token?: string) => worker.fetch(new Request(`https://api.example.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }), ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const created = await call("/admin/pairing-codes", { kioskName: "Test Front Kiosk" }); assert.equal(created.status, 201);
  const paired = await call("/kiosk/pair", { code: (await created.json() as { code: string }).code, kioskName: "Test Front Kiosk" }); assert.equal(paired.status, 201);
  const kiosk = await paired.json() as { kioskToken: string; pairingId: string };
  const scan = (memberId: string, eventId: string, occurredAt: string, meetingId?: string) => call("/kiosk/attendance", { memberId, eventId, occurredAt, pairingId: kiosk.pairingId, ...(meetingId ? { meetingId } : {}) }, "POST", kiosk.kioskToken);
  const events = () => database.sqlite.prepare("SELECT member_id AS member, meeting_id AS meeting, action, occurred_at AS at FROM attendance_events ORDER BY occurred_at, member_id").all().map((row) => ({ ...row }));
  return { database, call, scan, events };
}

// Real SQLite with D1's atomic batch semantics, migrated from apps/api/migrations. All data is synthetic.
type Statement = { execute(): unknown };
class Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    applyCoreMigrations(this.sqlite);
    this.sqlite.exec(`
      INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('member','primary','SYN-001','Test Student','A','student.a@example.test','2026-01-01');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('member-b','primary','SYN-002','Test Student','B','student.b@example.test','2026-01-01');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('evening','primary','Test Evening','2026-09-30T18:00:00.000Z','2026-09-30T20:00:00.000Z','admin','2026-01-01');
    `);
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    return {
      bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { return (database.sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { return { results: database.sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() { return this.execute(); },
      execute() {
        const query = database.sqlite.prepare(sql);
        const before = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        const results = query.columns().length ? query.all(...params as []) : (query.run(...params as []), []);
        const after = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        return { success: true, results, meta: { changes: after - before } };
      },
    };
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec("COMMIT"); return result; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}

// Data-integrity and D1 read-cost behavior of the Worker API on a real migrated SQLite database: meetings restore keeps
// live calendar links, kiosk roster revisions ignore scans, bounded meeting overlap reads, correction targets, and the
// restore time-limit error.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, backupClient, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");

const dashboardOrigin = "https://dashboard.example.test";

/** BackupDatabase whose batches also return rows, as D1 does, so module-scoped workspace reads work. */
class IntegrityDatabase extends BackupDatabase {
  onSelect?: (sql: string, rows: number) => void;
  override prepare(sql: string) {
    const statement = super.prepare(sql); const bind = statement.bind.bind(statement); const all = statement.all.bind(statement);
    return Object.assign(statement, { sql, values: [] as unknown[], all: async () => { const result = await all(); this.onSelect?.(sql, result.results.length); return result; }, bind(...values: unknown[]) { (statement as { values?: unknown[] }).values = values; bind(...values); return statement; } });
  }
  // Executes synchronously, so batches running concurrently never interleave inside one transaction.
  override async batch(statements: { run(): Promise<unknown> }[]) {
    this.batches += 1; this.raw.exec("BEGIN");
    try {
      const results = (statements as unknown as { sql: string; values: unknown[] }[]).map(({ sql, values }) => {
        const native = this.raw.prepare(sql);
        if (/^\s*SELECT\b/i.test(sql)) { const rows = native.all(...values as never[]); this.onSelect?.(sql, rows.length); return { success: true, results: rows }; }
        return { success: true, meta: { changes: Number(native.run(...values as never[]).changes) } };
      });
      this.raw.exec("COMMIT"); return results;
    } catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
}

function fixture() {
  const db = new IntegrityDatabase();
  const client = backupClient(worker, db);
  return { db, client };
}

const meetingRow = (id: string, startsAt: string, endsAt: string, extra = "") =>
  `INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at${extra ? ",weight_category_id" : ""}) VALUES ('${id}','primary','Meeting ${id}','${startsAt}','${endsAt}','admin','2026-01-01T00:00:00.000Z'${extra ? `,'${extra}'` : ""});`;

/** Record the rows each meeting-overlap read returns. */
function watchOverlapReads(db: IntegrityDatabase) {
  const reads: number[] = [];
  db.onSelect = (sql, rows) => { if (sql.startsWith("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings")) reads.push(rows); };
  return reads;
}

test("a meetings restore keeps calendar links for meetings that survive and reports detached events", async (t) => {
  const { db, client } = fixture(); t.after(() => db.raw.close());
  db.raw.exec(`INSERT INTO meeting_weight_categories(id,installation_id,name,weight,position,active,created_by,created_at,updated_at) VALUES ('weight-a','primary','Build',2,0,1,'admin','2026-01-01','2026-01-01');
    ${meetingRow("kept", "2026-03-01T18:00:00.000Z", "2026-03-01T20:00:00.000Z", "weight-a")}
    ${meetingRow("dropped", "2026-03-08T18:00:00.000Z", "2026-03-08T20:00:00.000Z")}
    INSERT INTO google_calendar_event_mappings(installation_id,meeting_id,event_id,updated_at) VALUES ('primary','kept','google-kept','2026-01-02'),('primary','dropped','google-dropped','2026-01-02');
    INSERT INTO discord_calendar_event_mappings(installation_id,meeting_id,event_id,updated_at) VALUES ('primary','kept','discord-kept','2026-01-02'),('primary','dropped','discord-dropped','2026-01-02');
    INSERT INTO discord_calendar_operations(installation_id,meeting_id,generation,action,event_id,status,updated_at) VALUES ('primary','kept',1,'upsert','discord-kept','delivered','2026-01-02');`);
  const backup = await client.backup("meetings");
  backup.tables.meetings = backup.tables.meetings.filter((row: Record<string, unknown>) => row.id !== "dropped");
  db.raw.exec("UPDATE meetings SET title = 'Renamed after the backup' WHERE id = 'kept'");

  const restored = await client.call("/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup });
  assert.equal(restored.status, 200, await restored.clone().text());
  const body = await restored.json() as { recovery: Record<string, number> };
  assert.equal(body.recovery.detachedCalendarEvents, 2, "the dropped meeting's Google and Discord events are reported");

  assert.deepEqual(db.rows("SELECT id, title, weight_category_id FROM meetings ORDER BY id"), [{ id: "kept", title: "Meeting kept", weight_category_id: "weight-a" }]);
  assert.deepEqual(db.rows("SELECT meeting_id, event_id FROM google_calendar_event_mappings"), [{ meeting_id: "kept", event_id: "google-kept" }]);
  assert.deepEqual(db.rows("SELECT meeting_id, event_id FROM discord_calendar_event_mappings"), [{ meeting_id: "kept", event_id: "discord-kept" }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE meeting_id = 'kept'"), 1);
  const audit = JSON.parse(String(db.rows<{ metadata_json: string }>("SELECT metadata_json FROM audit_log WHERE action = 'data.backup_restored'")[0]!.metadata_json));
  assert.equal(audit.recovery.detachedCalendarEvents, 2);
});

test("kiosk roster revision ignores scans and corrections but follows member changes", async (t) => {
  const { db, client } = fixture(); t.after(() => db.raw.close());
  await client.call("/health");
  const token = "synthetic-kiosk-token";
  db.raw.exec(`INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES ('pair-a','primary','hash-a','2099-01-01','admin','2026-01-01');
    INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at,active) VALUES ('kiosk-a','primary','pair-a','Kiosk A','${createHash("sha256").update(token).digest("base64url")}','2026-01-01',1);
    ${meetingRow("live", "2026-03-01T18:00:00.000Z", "2026-03-01T20:00:00.000Z")}`);
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" };
  const roster = (etag?: string) => worker.fetch(new Request("https://fixture.test/kiosk/roster", { headers: { authorization: `Bearer ${token}`, ...(etag ? { "if-none-match": etag } : {}) } }), env);
  const first = await roster(); assert.equal(first.status, 200, await first.clone().text());
  const etag = first.headers.get("etag")!; assert.match(etag, /^"kiosk-roster-v1-\d+"$/);
  const reportRevision = () => db.count("SELECT revision AS n FROM report_data_revision WHERE installation_id = 'primary'");
  const before = reportRevision();
  db.raw.exec(`INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,occurred_at,source,action) VALUES ('scan-1','primary','member','live','2026-03-01T18:05:00.000Z','kiosk','check_in');
    INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) VALUES ('fix-1','primary','member','live','excused','Synthetic','admin','2026-03-02');`);
  assert.ok(reportRevision() > before, "reports are still invalidated by scans");
  assert.equal((await roster(etag)).status, 304, "the kiosk roster stays cached during a meeting");
  db.raw.exec("UPDATE members SET first_name = 'Renamed' WHERE id = 'member'");
  const changed = await roster(etag); assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.deepEqual((await changed.json() as { members: { firstName: string }[] }).members.map((member) => member.firstName), ["Renamed"]);
});

test("the roster revision migration starts at the current report revision", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readdirSync, readFileSync } = await import("node:fs");
  const directory = new URL("../apps/api/migrations/", import.meta.url);
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    if (file === "0082_kiosk_roster_revision.sql") raw.exec("UPDATE report_data_revision SET revision = 41 WHERE installation_id = 'primary'");
    raw.exec(readFileSync(new URL(file, directory), "utf8"));
  }
  assert.deepEqual({ ...raw.prepare("SELECT revision FROM kiosk_roster_revision WHERE installation_id = 'primary'").get() }, { revision: 41 });
  raw.close();
});

test("a recurring overnight series keeps its clock end time across a daylight-saving change", async (t) => {
  const { db, client } = fixture(); t.after(() => db.raw.close());
  db.raw.exec("UPDATE organization_settings SET time_zone = 'America/New_York' WHERE installation_id = 'primary'");
  // Synthetic weekly 7 PM to 9 AM meeting starting 2026-10-24 (EDT); New York falls back on 2026-11-01.
  const created = await client.call("/meetings", { title: "Synthetic overnight", startsAt: "2026-10-24T23:00:00.000Z", endsAt: "2026-10-25T13:00:00.000Z", required: true, recurrence: { frequency: "weekly", until: "2026-11-08T23:59:00.000Z" } });
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(db.rows("SELECT starts_at AS startsAt, ends_at AS endsAt FROM meetings ORDER BY starts_at"), [
    { startsAt: "2026-10-24T23:00:00.000Z", endsAt: "2026-10-25T13:00:00.000Z" },
    { startsAt: "2026-10-31T23:00:00.000Z", endsAt: "2026-11-01T14:00:00.000Z" },
    { startsAt: "2026-11-08T00:00:00.000Z", endsAt: "2026-11-08T14:00:00.000Z" },
  ]);
});

test("meeting overlap reads only meetings near the proposed window, and branding skips it unless the late window grows", async (t) => {
  const { db, client } = fixture(); t.after(() => db.raw.close());
  const far = Array.from({ length: 40 }, (_, index) => meetingRow(`far-${index}`, new Date(Date.UTC(2025, 0, 1 + index * 3, 18)).toISOString(), new Date(Date.UTC(2025, 0, 1 + index * 3, 20)).toISOString())).join("\n");
  db.raw.exec(`${far}\n${meetingRow("near", "2026-05-01T18:00:00.000Z", "2026-05-01T20:00:00.000Z")}
${meetingRow("after", "2026-05-01T22:00:00.000Z", "2026-05-01T23:00:00.000Z")}`);
  const reads = watchOverlapReads(db);
  const create = (startsAt: string, endsAt: string) => client.call("/meetings", { title: "Proposed", startsAt, endsAt, required: true });

  const conflict = await create("2026-05-01T20:10:00.000Z", "2026-05-01T21:00:00.000Z");
  assert.equal(conflict.status, 409, "a meeting inside the 30-minute late window still conflicts");
  assert.match((await conflict.json() as { error: string }).error, /Meeting near/);
  const created = await create("2026-05-03T18:00:00.000Z", "2026-05-03T20:00:00.000Z");
  assert.equal(created.status, 201, await created.clone().text());
  assert.ok(reads.length === 2 && reads.every((rows) => rows <= 2), `only nearby meetings are read, not all 42: ${reads}`);

  reads.length = 0;
  const settings = await (await client.call("/admin/branding")).json() as { settings: Record<string, unknown> };
  const brandingEnv = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: dashboardOrigin };
  const brandingCookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  const save = (lateScanMinutes: number) => worker.fetch(new Request("https://fixture.test/admin/branding", { method: "PATCH", headers: { cookie: brandingCookie, "content-type": "application/json", origin: dashboardOrigin }, body: JSON.stringify({ ...settings.settings, organizationName: "Synthetic Club", primaryColor: "#123456", secondaryColor: "#654321", appearance: "system", logoBackdrop: "auto", discordContestWindowHours: 24, lateScanMinutes }) }), brandingEnv);
  assert.equal((await save(30)).status, 200);
  assert.equal((await save(10)).status, 200);
  assert.deepEqual(reads, [], "an unchanged or shorter late window reads no meetings");
  const grown = await save(180);
  assert.equal(grown.status, 409, "a longer late window that makes existing meetings overlap is refused");
  assert.deepEqual(reads, [43], "a longer late window checks every meeting");
});

test("corrections refuse unknown members and meetings with 404 and deleted meetings with 409", async (t) => {
  const { db, client } = fixture(); t.after(() => db.raw.close());
  db.raw.exec(`${meetingRow("live", "2026-03-01T18:00:00.000Z", "2026-03-01T20:00:00.000Z")}
    ${meetingRow("gone", "2026-03-08T18:00:00.000Z", "2026-03-08T20:00:00.000Z")}
    UPDATE meetings SET deleted_at = '2026-03-09T00:00:00.000Z' WHERE id = 'gone';`);
  const correct = (memberId: string, meetingId: string) => client.call("/attendance/corrections", { memberId, meetingId, disposition: "excused", reason: "Synthetic" });
  const unknownMember = await correct("nobody", "live"); assert.equal(unknownMember.status, 404, await unknownMember.clone().text()); assert.match((await unknownMember.json() as { error: string }).error, /Member not found/);
  const unknownMeeting = await correct("member", "missing"); assert.equal(unknownMeeting.status, 404); assert.match((await unknownMeeting.json() as { error: string }).error, /Meeting not found/);
  assert.equal((await correct("member", "gone")).status, 409);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM attendance_corrections"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'attendance.corrected'"), 0);
  const accepted = await correct("member", "live"); assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal(db.count("SELECT COUNT(*) AS n FROM attendance_corrections WHERE meeting_id = 'live'"), 1);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'attendance.corrected'"), 1);
});

test("a restore that exceeds D1's time limit returns an actionable 503 and changes nothing", async (t) => {
  const { db, client } = fixture(); t.after(() => db.raw.close());
  db.raw.exec(meetingRow("kept", "2026-03-01T18:00:00.000Z", "2026-03-01T20:00:00.000Z"));
  const backup = await client.backup("meetings");
  const batch = db.batch.bind(db);
  db.batch = async () => { throw new Error("D1 DB storage operation exceeded timeout which caused object to be reset."); };
  const result = await client.call("/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup });
  db.batch = batch;
  assert.equal(result.status, 503);
  assert.match((await result.json() as { error: string }).error, /Nothing was changed.*D1 restore workflow/);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM meetings"), 1);
});

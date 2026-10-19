import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { meetingDeletion, restoreMeetingDeletion, type MeetingDeletion } from "../apps/api/src/meeting-deletion.ts";
import { overlappingMeetingWindows } from "../apps/api/src/attendance-lifecycle.ts";
import type { D1Database, D1Result, D1Statement } from "../apps/api/src/d1-usage.ts";

class Statement implements D1Statement {
  readonly db: Database; readonly sql: string; readonly values: unknown[];
  constructor(db: Database, sql: string, values: unknown[] = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  result(): D1Result {
    const native = this.db.sqlite.prepare(this.sql);
    return /^\s*SELECT\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)
      ? { results: native.all(...this.values as []), meta: { changes: 0 } }
      : { success: true, meta: { changes: Number(native.run(...this.values as []).changes) } };
  }
  async first<T>() { return (this.result().results?.[0] as T | undefined) ?? null; }
  async all<T>() { return this.result() as D1Result<T>; }
  async run() { return this.result(); }
}
class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:"); beforeRestore?: () => void;
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-18','local'),('other','2026-10-18','local');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-10-18'),('operator','primary','operator','operator','2026-10-18');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','operator',0); INSERT INTO platform_module_assignment_revisions VALUES('primary','operator',0);
      INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','["attendance.manage"]');`);
    this.addMeeting("meeting-1", "2026-10-20T15:00:00.000Z", "2026-10-20T17:00:00.000Z");
    this.addMeeting("meeting-2", "2026-10-27T15:00:00.000Z", "2026-10-27T17:00:00.000Z");
    this.sqlite.exec("UPDATE meetings SET series_id='series-1', notes='Saved notes', attendance_weight=2 WHERE installation_id='primary'");
  }
  addMeeting(id: string, start: string, end: string, installation = "primary") {
    this.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES(?,?,?,?,?,1,'admin','2026-10-18')").run(id, installation, id, start, end);
  }
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(input: D1Statement[]) {
    const statements = input as Statement[];
    if (this.beforeRestore && statements.some(item => item.sql.includes("AS meeting_undo_available"))) { const before = this.beforeRestore; this.beforeRestore = undefined; before(); }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const results = statements.map(item => item.result()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  rows(table: string) { return this.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); }
  close() { this.sqlite.close(); }
}
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
async function call(db: Database, path: string, method: string, body?: unknown, role: "admin" | "operator" | null = "operator") {
  const cookie = role ? `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: role, role })}` : "";
  return worker.fetch(new Request(`https://api.example.test${path}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined }), { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: db } as Env);
}
async function deleteFuture(db: Database) {
  const response = await call(db, "/meetings/meeting-1", "DELETE", { scope: "future" });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { deletion: MeetingDeletion }).deletion;
}

test("exact deletion Undo restores original meetings and preserves related records and concurrent Carpool changes", async () => {
  const db = new Database(); try {
    db.sqlite.exec(`INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','SYN-001','Synthetic','Member','2026-10-18');
      INSERT INTO member_labels(id,installation_id,name,created_by,created_at) VALUES('label','primary','Synthetic group','admin','2026-10-18');
      INSERT INTO meeting_audience_labels VALUES('primary','meeting-1','label');
      INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,created_by,action) VALUES('scan','primary','member','meeting-1','manual','2026-10-20T15:02:00.000Z','admin','check_in');
      INSERT INTO attendance_corrections VALUES('correction','primary','member','meeting-1','excused','Synthetic reason','admin','2026-10-18');
      INSERT INTO carpool_plans(installation_id,id,title,created_by,created_at,updated_at,meeting_id) VALUES('primary','plan','Synthetic plan','admin','2026-10-18','2026-10-18','meeting-1');
      INSERT INTO google_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,updated_at) VALUES('primary','meeting-1','llsynthetic',1,1,'2026-10-18');
      INSERT INTO discord_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,updated_at) VALUES('primary','meeting-1','synthetic-event',1,1,'2026-10-18');`);
    const before = db.rows("meetings"); const related = ["attendance_events", "attendance_corrections", "meeting_audience_labels"].map(table => db.rows(table));
    const deletion = await deleteFuture(db);
    db.sqlite.exec("UPDATE carpool_plans SET title='Edited while meeting was deleted', revision=revision+1 WHERE id='plan'");
    const result = await call(db, "/meetings/meeting-1/restore", "POST", { scope: "future", deletion });
    assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json() as { restored: number }).restored, 2);
    assert.deepEqual(db.rows("meetings"), before);
    assert.deepEqual(["attendance_events", "attendance_corrections", "meeting_audience_labels"].map(table => db.rows(table)), related);
    assert.equal(db.rows("carpool_plans")[0]!.title, "Edited while meeting was deleted"); assert.equal(db.rows("carpool_plans")[0]!.meeting_id, "meeting-1");
    const google = db.rows("google_calendar_operations"); assert.ok(google.some(row => row.action === "delete" && row.event_id === "llsynthetic")); assert.ok(google.some(row => row.action === "upsert" && row.event_id === db.rows("google_calendar_event_mappings")[0]!.event_id)); assert.equal(db.rows("google_calendar_event_mappings")[0]!.generation, 2);
    const discord = db.rows("discord_calendar_operations"); assert.ok(discord.some(row => row.action === "delete" && row.event_id === "synthetic-event")); assert.ok(discord.some(row => row.action === "upsert" && row.generation === 2));
    const audits = db.rows("audit_log").length;
    assert.equal((await call(db, "/meetings/meeting-1/restore", "POST", { deletion })).status, 409); assert.equal(db.rows("audit_log").length, audits);
  } finally { db.close(); }
});

test("future and bulk deletion return only rows deleted by that request", async () => {
  const db = new Database(); try {
    db.sqlite.exec("UPDATE meetings SET deleted_at='2026-10-17T12:00:00.000Z' WHERE id='meeting-2'");
    const deletion = await deleteFuture(db); assert.deepEqual(deletion.meetingIds, ["meeting-1"]);
    assert.equal((await call(db, "/meetings/meeting-1/restore", "POST", { scope: "future", deletion })).status, 200);
    assert.equal(db.rows("meetings")[1]!.deleted_at, "2026-10-17T12:00:00.000Z");
    const bulk = await call(db, "/meetings/bulk-delete", "POST", { meetingIds: ["meeting-1", "meeting-2", "missing"], confirmation: "DELETE SELECTED MEETINGS" });
    const body = await bulk.json() as { deleted: number; deletion: MeetingDeletion }; assert.equal(body.deleted, 1); assert.deepEqual(body.deletion.meetingIds, ["meeting-1"]);
    assert.equal((await call(db, "/meetings/meeting-1/restore", "POST", { scope: "selection", deletion: body.deletion })).status, 200);
    assert.equal(db.rows("meetings")[1]!.deleted_at, "2026-10-17T12:00:00.000Z");
  } finally { db.close(); }
});

test("stale revisions and newly overlapping windows roll back the complete Undo before audit or provider work", async () => {
  for (const change of ["revision", "missing", "overlap", "late-window"] as const) {
    const db = new Database(); try {
      const deletion = await deleteFuture(db); const audits = db.rows("audit_log").length;
      db.beforeRestore = () => {
        if (change === "revision") db.sqlite.exec("UPDATE meetings SET deleted_at='2026-10-18T23:00:00.000Z' WHERE id='meeting-2'");
        else if (change === "missing") db.sqlite.exec("DELETE FROM meetings WHERE id='meeting-2'");
        else db.addMeeting("new-meeting", change === "overlap" ? "2026-10-27T16:00:00.000Z" : "2026-10-27T17:30:00.000Z", "2026-10-27T18:00:00.000Z");
      };
      const result = await call(db, "/meetings/meeting-1/restore", "POST", { deletion }); assert.equal(result.status, 409, await result.clone().text());
      assert.ok(db.rows("meetings").filter(row => deletion.meetingIds.includes(String(row.id))).every(row => row.deleted_at !== null));
      assert.equal(db.rows("audit_log").length, audits); assert.equal(db.rows("google_calendar_operations").length, 0); assert.equal(db.rows("discord_calendar_operations").length, 0);
    } finally { db.close(); }
  }
});

test("Undo checks current permissions and rejects a grant revoked at the mutation boundary", async () => {
  const db = new Database(); try {
    const deletion = await deleteFuture(db);
    assert.equal((await call(db, "/meetings/meeting-1/restore", "POST", { deletion }, null)).status, 401);
    db.beforeRestore = () => db.sqlite.exec("DELETE FROM platform_module_assignments WHERE user_id='operator'");
    assert.equal((await call(db, "/meetings/meeting-1/restore", "POST", { deletion })).status, 403);
    assert.ok(db.rows("meetings").every(row => row.deleted_at !== null));
    assert.equal((await call(db, "/meetings/meeting-1/restore", "POST", { deletion }, "admin")).status, 200);
  } finally { db.close(); }
});

test("Undo uses the attendance policy's inclusive close boundary with default and configured late windows", async () => {
  for (const minutes of [0, 30, 45]) {
    for (const extraMs of [0, 1]) {
      const db = new Database(); try {
        const deletion = await deleteFuture(db);
        if (minutes !== 30) db.sqlite.prepare("UPDATE organization_settings SET late_scan_minutes=? WHERE installation_id='primary'").run(minutes);
        const startsAt = new Date(Date.parse("2026-10-27T17:00:00.000Z") + minutes * 60_000 + extraMs).toISOString();
        const later = { startsAt, endsAt: "2026-10-27T20:00:00.000Z" };
        const conflicts = overlappingMeetingWindows([{ startsAt: "2026-10-27T15:00:00.000Z", endsAt: "2026-10-27T17:00:00.000Z" }, later], minutes);
        db.addMeeting("later", later.startsAt, later.endsAt);
        const response = await call(db, "/meetings/meeting-1/restore", "POST", { deletion });
        assert.equal(response.status, conflicts ? 409 : 200, `${minutes} late minutes, ${extraMs}ms after boundary: ${await response.text()}`);
      } finally { db.close(); }
    }
  }
});

test("Undo validates its exact batch and does not cross installations", async () => {
  const db = new Database(); try {
    const deletion = await deleteFuture(db);
    for (const invalid of [undefined, {}, { ...deletion, meetingIds: [] }, { ...deletion, meetingIds: ["meeting-1", "meeting-1"] }, { ...deletion, deletedAt: "bad" }]) assert.throws(() => meetingDeletion(invalid, "meeting-1"));
    assert.equal((await call(db, "/meetings/meeting-1/restore", "POST", { scope: "future" })).status, 400);
    db.addMeeting("foreign", "2026-10-20T15:00:00.000Z", "2026-10-20T17:00:00.000Z", "other");
    db.sqlite.prepare("UPDATE meetings SET deleted_at=? WHERE id='foreign'").run(deletion.deletedAt);
    await assert.rejects(restoreMeetingDeletion(db, { ...deletion, meetingIds: ["meeting-1", "foreign"] }), /Nothing was restored/);
    assert.ok(db.rows("meetings").every(row => row.deleted_at !== null));
  } finally { db.close(); }
});

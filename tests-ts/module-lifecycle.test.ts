import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { D1Database, D1Result, D1Statement } from "../apps/api/src/d1-usage.ts";
import { attendanceSetupRoute } from "../apps/api/src/attendance-module-setup.ts";
import { runModuleCleanup } from "../apps/api/src/module-cleanup.ts";
import { captureModuleWorkspaceDatabase } from "../apps/api/src/module-database-scope.ts";
import { configureModulePlatform, readModulePlatformSnapshot, readModuleSetup, updateModuleSetup } from "../apps/api/src/module-platform.ts";
import { carpoolRoute, createCarpoolPlan } from "../apps/api/src/carpool-api.ts";

class Statement implements D1Statement {
  readonly database: DatabaseSync;
  readonly sql: string;
  values: unknown[] = [];
  constructor(database: DatabaseSync, sql: string) { this.database = database; this.sql = sql; }
  bind(...values: unknown[]) { const next = new Statement(this.database, this.sql); next.values = values; return next; }
  native(): StatementSync { return this.database.prepare(this.sql); }
  async first<T>() { return (this.native().get(...this.values as []) as T | undefined) ?? null; }
  async all<T>() { return { results: this.native().all(...this.values as []) as T[], meta: { changes: 0 } } as D1Result<T>; }
  async run() { const result = this.native().run(...this.values as []); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
  batchResult(): D1Result {
    const statement = this.native();
    if (/^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(this.sql)) return { success: true, results: statement.all(...this.values as []), meta: { changes: 0 } } as D1Result;
    const result = statement.run(...this.values as []);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor(setupComplete = false) {
    for (const file of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-09-28','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES
        ('admin','primary','admin','admin','2026-09-28'),('operator','primary','operator','operator','2026-09-28');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO platform_module_administration VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1),('primary','hour-tracking',1),('primary','carpool',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor)
        VALUES('primary','attendance',1,1,'enabled',2,${setupComplete ? 1 : 0},0),
          ('primary','hour-tracking',1,1,'disabled',1,0,0),
          ('primary','carpool',1,1,'disabled',1,0,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','admin',0),('primary','operator',0);
      INSERT INTO platform_module_assignment_revisions VALUES('primary','admin',0),('primary','operator',0);
      INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','["attendance.manage"]');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from)
        VALUES('member','primary','1001','Synthetic','Member','2026-09-28','2026-09-28');
      INSERT INTO hours_entry_settings(installation_id) VALUES('primary');
      INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES
        ('primary','event','Event','event',1,'2026-09-28','2026-09-28'),
        ('primary','team-support','Team Support','team',1,'2026-09-28','2026-09-28'),
        ('primary','other-service','Other Service','task',1,'2026-09-28','2026-09-28');`);
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof Statement)) throw new Error("Unexpected test statement");
        return statement.batchResult();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}

function request(path: string, method: string, body?: unknown) {
  return new Request(`https://synthetic.test${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("Carpool lookup runs with unrelated modules disabled and cleanup removes its execution authority", async () => {
  const database = new Database(true);
  try {
    database.sqlite.exec("UPDATE platform_modules SET phase='disabled'; UPDATE platform_modules SET phase='enabled',setup_complete=1 WHERE module_id='carpool'");
    const scoped = captureModuleWorkspaceDatabase(database, "carpool", 1, "admin", "carpool.manage");
    const plan = await createCarpoolPlan(scoped, "admin", { title: "Synthetic independent lookup" }); const id = String(plan.plan.id);
    await carpoolRoute(scoped, "admin", request(`/admin/carpool/plans/${id}/people`, "POST"), { displayName: "Synthetic rider", outboundStatus: "needs-ride", outboundAddress: "1 Synthetic St, Example, PA 19000", outboundLatitude: null, outboundLongitude: null, outboundSeats: null, returnStatus: "needs-ride", returnAddress: "1 Synthetic St, Example, PA 19000", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: true, notes: "", contact: "", memberId: null });
    const result = (await carpoolRoute(scoped, "admin", request(`/admin/carpool/plans/${id}/locations/resolve`, "POST"), { automatic: true }, { id: "synthetic", async resolve() { return { latitude: 40, longitude: -74 }; } })).body as any;
    assert.equal(result.locationLookup.state, "complete"); assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM carpool_location_resolution").get()?.n, 1);
    database.sqlite.exec("UPDATE platform_modules SET phase='retained',disabled_at='2000-01-01T00:00:00Z',delete_after='2000-01-08T00:00:00Z' WHERE module_id='carpool'");
    let deleted = false;
    for (let index = 0; index < 15; index++) { const result = await runModuleCleanup(database, new Date(), 20); if (result.status === "deleted") { deleted = true; break; } assert.equal(result.status, "progress"); }
    assert.equal(deleted, true); assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM carpool_location_resolution").get()?.n, 0); assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM members").get()?.n, 1); assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM hours_categories").get()?.n, 3);
  } finally { database.close(); }
});

test("Attendance setup validates rules, a same-day meeting, browser input, and optional skips", async () => {
  const database = new Database();
  try {
    let state = await readModuleSetup(database, "admin", "attendance");
    assert.equal(state.ready, false);
    assert.deepEqual(state.steps.map((step) => [step.id, step.valid]), [["rules", true], ["meeting", false], ["input", false], ["calendar", false], ["discord", false]]);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "rules", outcome: "completed" });
    await assert.rejects(updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "meeting", outcome: "completed" }), /Complete the current setup step/);

    const now = new Date();
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(now); dayEnd.setUTCHours(23, 59, 59, 999);
    const startsAt = new Date(Math.max(dayStart.getTime(), now.getTime() - 5 * 60_000)).toISOString();
    const endsAt = new Date(Math.min(dayEnd.getTime(), now.getTime() + 55 * 60_000)).toISOString();
    const meetingResponse = await attendanceSetupRoute(request("/module-setup/attendance/meeting", "POST", { title: "Same-day setup meeting", startsAt, endsAt, required: true }), database, "admin");
    assert.equal(meetingResponse.status, 201);
    const meetingId = String((await meetingResponse.json() as { id: string }).id);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "meeting", outcome: "completed" });
    assert.equal(state.steps.find((step) => step.id === "meeting")?.valid, true);

    assert.equal((await attendanceSetupRoute(request("/module-setup/attendance/input", "POST", { action: "start", name: "Synthetic browser" }), database, "admin")).status, 200);
    const scan = await attendanceSetupRoute(request("/module-setup/attendance/input", "POST", { action: "scan", memberId: "1001", meetingId, eventId: "setup-event" }), database, "admin");
    assert.equal(scan.status, 202);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "input", outcome: "completed" });
    assert.equal(state.ready, true);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "calendar", outcome: "skipped" });
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "discord", outcome: "skipped" });
    assert.equal(state.ready, true);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM attendance_events WHERE source='simulator'").get()?.count, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM platform_module_setup_progress").get()?.count, 5);
  } finally { database.close(); }
});

test("Attendance disablement revokes captured authority, supports recovery, and cleans only module-owned data", async () => {
  const database = new Database(true);
  try {
    database.sqlite.exec(`INSERT INTO member_labels(id,installation_id,name,created_by,created_at) VALUES('label','primary','Preserved label','admin','2026-09-28');
      INSERT INTO saved_report_views(id,installation_id,owner_user_id,scope,name,definition_json,created_by,updated_by,created_at,updated_at)
        VALUES('report','primary','admin','personal','Preserved report','{}','admin','admin','2026-09-28','2026-09-28');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES('meeting','primary','Cleanup meeting','2026-09-28T12:00:00Z','2026-09-28T13:00:00Z','admin','2026-09-28');
      INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,kiosk_event_id,created_by,action)
        VALUES('event','primary','member','meeting','kiosk','2026-09-28T12:00:00Z','event-key','admin','check_in');
      INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,redeemed_at,created_by,created_at,purpose)
        VALUES('pair','primary','pair-hash','2026-09-29','2026-09-28','admin','2026-09-28','hardware');
      INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at) VALUES('kiosk','primary','pair','Synthetic kiosk','token-hash','2026-09-28');
      INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at) VALUES('command','primary','kiosk','reload_display','admin','2026-09-28');
      INSERT INTO platform_module_setup_progress VALUES('primary','attendance','rules',2,'completed','2026-09-28','admin');`);

    const captured = captureModuleWorkspaceDatabase(database, "attendance", 1, "admin", "attendance.manage");
    assert.equal((await captured.prepare("SELECT title FROM meetings WHERE id='meeting'").first<{ title: string }>())?.title, "Cleanup meeting");
    let snapshot = await configureModulePlatform(database, "admin", { enabled: [], revision: 0, confirmDisable: [{ moduleId: "attendance", generation: 1 }] });
    assert.equal(snapshot.modules[0]?.phase, "retained");
    assert.equal(snapshot.modules[0]?.generation, 2);
    assert.equal(database.sqlite.prepare("SELECT active FROM kiosks WHERE id='kiosk'").get()?.active, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM kiosk_commands").get()?.count, 0);
    await assert.rejects(captured.prepare("SELECT title FROM meetings").all(), (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 403));

    snapshot = await configureModulePlatform(database, "admin", { enabled: ["attendance"], revision: 1, confirmDisable: [] });
    assert.equal(snapshot.modules[0]?.phase, "enabled");
    assert.equal(snapshot.modules[0]?.generation, 2);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM meetings").get()?.count, 1);
    const current = captureModuleWorkspaceDatabase(database, "attendance", 2, "admin", "attendance.manage");
    assert.equal((await current.prepare("SELECT COUNT(*) AS count FROM meetings").first<{ count: number }>())?.count, 1);

    snapshot = await configureModulePlatform(database, "admin", { enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 2 }] });
    assert.equal(snapshot.modules[0]?.generation, 3);
    database.sqlite.exec("UPDATE platform_modules SET disabled_at='2026-09-13T00:00:00Z',delete_after='2026-09-20T00:00:00Z' WHERE module_id='attendance'");
    const cleanupNow = new Date();
    let deleted = false;
    for (let index = 0; index < 100; index += 1) {
      const result = await runModuleCleanup(database, cleanupNow, 1);
      if (result.status === "deleted") { deleted = true; break; }
      const cleanup = database.sqlite.prepare("SELECT deletion_cursor AS cursor,cleanup_failure AS failure FROM platform_modules WHERE module_id='attendance'").get();
      assert.equal(result.status, "progress", JSON.stringify(cleanup));
    }
    assert.equal(deleted, true);
    snapshot = await readModulePlatformSnapshot(database, "admin");
    assert.equal(snapshot.modules[0]?.phase, "deleted");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM meetings").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM attendance_events").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM kiosks").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT attendance_required_from AS value FROM members WHERE id='member'").get()?.value, null);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM members").get()?.count, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM member_labels WHERE id='label'").get()?.count, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM saved_report_views WHERE id='report'").get()?.count, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 2);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM platform_module_assignments").get()?.count, 0);

    snapshot = await configureModulePlatform(database, "admin", { enabled: ["attendance"], revision: snapshot.revision, confirmDisable: [] });
    assert.equal(snapshot.modules[0]?.phase, "enabled");
    assert.equal(snapshot.modules[0]?.generation, 4);
    assert.equal(snapshot.modules[0]?.setup.ready, false);
  } finally { database.close(); }
});

test("resumed retired-review cleanup preserves historical cursor positions and removes operational tombstones", async () => {
  const database = new Database(true);
  try {
    database.sqlite.exec(`UPDATE platform_modules SET phase='deleting',deletion_cursor=31,disabled_at='2000-01-01',delete_after='2000-01-08' WHERE module_id='attendance';
      INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at,purpose) VALUES('review-pair','primary','hash','2000-01-01','admin','2000-01-01','hardware');
      INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at) VALUES('review-kiosk','primary','review-pair','Synthetic review kiosk','token','2000-01-01');`);
    database.sqlite.exec("INSERT INTO kiosk_fingerprint_retired_review_grants VALUES('primary','old-grant')");
    assert.equal((await runModuleCleanup(database, new Date(), 1)).status, "progress");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM kiosk_fingerprint_review_manifests").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM kiosk_fingerprint_review_slots").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT deletion_cursor AS cursor FROM platform_modules WHERE module_id='attendance'").get()?.cursor, 32);
    assert.equal((await runModuleCleanup(database, new Date(), 1)).status, "progress");
    assert.equal(database.sqlite.prepare("SELECT deletion_cursor AS cursor FROM platform_modules WHERE module_id='attendance'").get()?.cursor, 33);
    database.sqlite.exec("UPDATE platform_modules SET deletion_cursor=36 WHERE module_id='attendance'");
    assert.equal((await runModuleCleanup(database, new Date(), 1)).status, "progress");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM kiosk_fingerprint_retired_review_grants").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM members").get()?.count, 1);
  } finally { database.close(); }
});

test("Outreach lifecycle retains, deletes, and reseeds only Outreach-owned data", async () => {
  const database = new Database(true);
  try {
    let snapshot = await configureModulePlatform(database, "admin", { enabled: ["attendance", "hour-tracking"], revision: 0, confirmDisable: [] });
    const outreach = snapshot.modules.find((module) => module.id === "hour-tracking")!;
    assert.equal(outreach.phase, "enabled");
    database.sqlite.exec(`UPDATE platform_modules SET setup_complete=1 WHERE module_id='hour-tracking';
      INSERT INTO hours_teams(installation_id,id,name,created_at,updated_at) VALUES('primary','team','Synthetic team','2026-09-28','2026-09-28');
      INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,team_id,title,created_at,updated_at)
        VALUES('primary','activity','team-support','team','2026-09-28','team','Synthetic support','2026-09-28','2026-09-28');
      INSERT INTO hours_labels(installation_id,id,name,created_at,updated_at) VALUES('primary','mentoring','Mentoring','2026-09-28','2026-09-28');
      INSERT INTO hours_activity_labels(installation_id,activity_id,label_id,created_at) VALUES('primary','activity','mentoring','2026-09-28');
      INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_ms,end_ms,start_offset_seconds,end_offset_seconds,duration_minutes,attribution,actor_user_id,created_at,updated_at)
        VALUES('primary','entry','member','activity','2026-09-28','UTC','09:00','10:00',1790586000000,1790589600000,0,0,60,'staff_recorded','admin','2026-09-28','2026-09-28');
      INSERT INTO hours_entry_revisions(installation_id,entry_id,revision,member_id,activity_id,action,actor_user_id,snapshot_json,created_at)
        VALUES('primary','entry',0,'member','activity','created','admin','{}','2026-09-28');
      INSERT INTO hours_submission_keys(installation_id,channel,key_hash,fingerprint,entry_id,receipt_json,created_at)
        VALUES('primary','staff','key','fingerprint','entry','{}','2026-09-28');`);
    const captured = captureModuleWorkspaceDatabase(database, "hour-tracking", 1, "admin", "hours.manage");
    assert.equal((await captured.prepare("SELECT COUNT(*) AS count FROM hours_entries").first<{ count: number }>())?.count, 1);

    snapshot = await configureModulePlatform(database, "admin", { enabled: ["attendance"], revision: 1, confirmDisable: [{ moduleId: "hour-tracking", generation: 1 }] });
    assert.equal(snapshot.modules.find((module) => module.id === "hour-tracking")?.phase, "retained");
    await assert.rejects(captured.prepare("SELECT * FROM hours_entries").all(), (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 403));
    database.sqlite.exec("UPDATE platform_modules SET disabled_at='2026-09-13T00:00:00Z',delete_after='2026-09-20T00:00:00Z' WHERE module_id='hour-tracking'");
    const cleanupNow = new Date();
    let deleted = false;
    for (let index = 0; index < 50; index += 1) {
      const result = await runModuleCleanup(database, cleanupNow, 1);
      if (result.status === "deleted") { deleted = true; break; }
      const cleanup = database.sqlite.prepare("SELECT deletion_cursor AS cursor,cleanup_failure AS failure FROM platform_modules WHERE module_id='hour-tracking'").get();
      assert.equal(result.status, "progress", JSON.stringify(cleanup));
    }
    assert.equal(deleted, true);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_entries").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_categories").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_labels").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_activity_labels").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM meetings").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM members").get()?.count, 1);
    snapshot = await readModulePlatformSnapshot(database, "admin");
    assert.equal(snapshot.modules.find((module) => module.id === "attendance")?.phase, "enabled");

    snapshot = await configureModulePlatform(database, "admin", { enabled: ["attendance", "hour-tracking"], revision: snapshot.revision, confirmDisable: [] });
    assert.equal(snapshot.modules.find((module) => module.id === "hour-tracking")?.generation, 3);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_categories").get()?.count, 3);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_entry_settings").get()?.count, 1);
  } finally { database.close(); }
});

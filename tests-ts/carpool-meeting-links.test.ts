import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createMeetingReferenceAccess } from "../apps/api/src/attendance-meeting-reference.ts";
import { carpoolMeetingId } from "../apps/api/src/carpool-meeting-links.ts";
import { carpoolRoute, createCarpoolPlan } from "../apps/api/src/carpool-api.ts";
import { captureModuleWorkspaceDatabase } from "../apps/api/src/module-database-scope.ts";
import { requireModuleWorkspace } from "../apps/api/src/module-platform.ts";
import { validateCarpoolBackupTables } from "../apps/api/src/carpool-backup.ts";
import { HttpError } from "../apps/api/src/http-error.ts";
import type { D1Database, D1Result, D1Statement } from "../apps/api/src/d1-usage.ts";

class Statement implements D1Statement {
  readonly db: Database; readonly sql: string; readonly values: unknown[];
  constructor(db: Database, sql: string, values: unknown[] = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  result(): D1Result { const native = this.db.sqlite.prepare(this.sql); return /^\s*SELECT\b/i.test(this.sql) ? { results: native.all(...this.values as []), meta: { changes: 0 } } : { success: true, meta: { changes: Number(native.run(...this.values as []).changes) } }; }
  async first<T>() { return (this.db.sqlite.prepare(this.sql).get(...this.values as []) as T | undefined) ?? null; }
  async all<T>() { return this.result() as D1Result<T>; }
  async run() { return this.result(); }
}
class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:"); beforeMutation?: () => void;
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-10','local'),('other','2026-10-10','local');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-10-10'),('operator','primary','operator','operator','2026-10-10');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1),('primary','carpool',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0),('primary','carpool',1,1,'enabled',1,1,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','operator',0); INSERT INTO platform_module_assignment_revisions VALUES('primary','operator',0);
      INSERT INTO platform_module_assignments VALUES('primary','operator','carpool','["carpool.manage"]');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES('meeting-1','primary','Build session','2026-10-10T15:00:00Z','2026-10-10T17:00:00Z',1,'admin','2026-10-10'),('foreign-meeting','other','Protected foreign title','2026-10-10T15:00:00Z','2026-10-10T17:00:00Z',1,'admin','2026-10-10');`);
  }
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(input: D1Statement[]) { const statements = input as Statement[]; if (this.beforeMutation && statements.some((item) => /^(?:UPDATE|INSERT INTO) carpool_plans/.test(item.sql))) { const before = this.beforeMutation; this.beforeMutation = undefined; before(); } this.sqlite.exec("BEGIN IMMEDIATE"); try { const results = statements.map((item) => item.result()); this.sqlite.exec("COMMIT"); return results; } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; } }
  close() { this.sqlite.close(); }
}
const request = (path: string, method = "GET") => new Request(`https://synthetic.test${path}`, { method });
const denied = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
async function authority(db: Database, actor = "admin") { const generation = await requireModuleWorkspace(db, actor, "carpool"); const scoped = captureModuleWorkspaceDatabase(db, "carpool", generation, actor, "carpool.manage"); return { db: scoped, access: await createMeetingReferenceAccess(scoped, actor) }; }
async function route(db: Database, path: string, method = "GET", body?: unknown, actor = "admin") { const access = await authority(db, actor); return carpoolRoute(access.db, actor, request(path, method), body, undefined, access.access); }

test("optional meeting links allow multiple plans and only project current-installation navigation", async () => {
  const db = new Database(); try {
    const first = await route(db, "/admin/carpool/plans", "POST", { title: "Outbound rides", meetingId: "meeting-1" }); const second = await route(db, "/admin/carpool/plans", "POST", { title: "Late rides", meetingId: "meeting-1" });
    const firstPlan = (first.body as any).plan; assert.notEqual(firstPlan.id, (second.body as any).plan.id);
    const context = (await route(db, `/admin/carpool/context?planId=${firstPlan.id}`)).body as any;
    assert.equal(context.relatedMeeting.title, "Build session"); assert.deepEqual(context.meetingChoices.map((item: any) => item.id), ["meeting-1"]);
    assert.equal(((await route(db, "/admin/carpool/meeting-links")).body as any).links.length, 2);
    await assert.rejects(route(db, "/admin/carpool/plans", "POST", { title: "Foreign", meetingId: "foreign-meeting" }), denied(400));
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM attendance_events").first<any>()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM discord_calendar_operations").first<any>()).count, 0);
  } finally { db.close(); }
});

test("disabled Attendance retains opaque links, hides reference data, and allows unlink", async () => {
  const db = new Database(); try {
    const plan = ((await route(db, "/admin/carpool/plans", "POST", { title: "Retained plan", meetingId: "meeting-1" })).body as any).plan;
    db.sqlite.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='attendance'");
    const context = (await route(db, `/admin/carpool/context?planId=${plan.id}`)).body as any;
    assert.equal(context.detail.plan.meetingId, "meeting-1"); assert.equal(context.relatedMeeting, null); assert.deepEqual(context.meetingChoices, []); assert.equal(context.meetingReferencesAvailable, false);
    assert.deepEqual((await route(db, "/admin/carpool/meeting-links")).body, { available: false, links: [] });
    await assert.rejects(route(db, "/admin/carpool/plans", "POST", { title: "No access", meetingId: "meeting-1" }), denied(403));
    const exported = (await route(db, `/admin/carpool/plans/${plan.id}/export?kind=backup`)).body as any; assert.equal(exported.plan.meetingId, null);
    const saved = (await route(db, `/admin/carpool/plans/${plan.id}`, "PATCH", { revision: 0, notes: "Still usable" })).body as any; assert.equal(saved.plan.meetingId, "meeting-1");
    const unlinked = (await route(db, `/admin/carpool/plans/${plan.id}`, "PATCH", { revision: 1, meetingId: null })).body as any; assert.equal(unlinked.plan.meetingId, null);
    db.sqlite.exec("DELETE FROM meetings WHERE id='meeting-1'"); assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM carpool_plans").first<any>()).count, 1);
  } finally { db.close(); }
});

test("Operators need both capabilities and race-time revocation rolls back link and audit", async () => {
  const db = new Database(); try {
    const noAttendance = await authority(db, "operator"); assert.equal(noAttendance.access, undefined);
    await assert.rejects(route(db, "/admin/carpool/plans", "POST", { title: "No grant", meetingId: "meeting-1" }, "operator"), denied(403));
    db.sqlite.exec("INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','[\"attendance.manage\"]')");
    const captured = await authority(db, "operator");
    db.beforeMutation = () => db.sqlite.exec("DELETE FROM platform_module_assignments WHERE module_id='attendance'");
    await assert.rejects(createCarpoolPlan(captured.db, "operator", { title: "Racing grant", meetingId: "meeting-1" }, captured.access), denied(403));
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM carpool_plans").first<any>()).count, 0); assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_log").first<any>()).count, 0);
    db.sqlite.exec("INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','[\"attendance.manage\"]')"); const next = await authority(db, "operator");
    db.beforeMutation = () => db.sqlite.exec("UPDATE platform_modules SET generation=2 WHERE module_id='carpool'");
    await assert.rejects(createCarpoolPlan(next.db, "operator", { title: "Racing Carpool", meetingId: "meeting-1" }, next.access), denied(403));
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM carpool_plans").first<any>()).count, 0);
  } finally { db.close(); }
});

test("meeting deletion between validation and mutation fails closed without deleting plans", async () => {
  const db = new Database(); try {
    const plan = ((await route(db, "/admin/carpool/plans", "POST", { title: "Standalone" })).body as any).plan; const captured = await authority(db); const audits = (await db.prepare("SELECT COUNT(*) AS count FROM audit_log").first<any>()).count;
    db.beforeMutation = () => db.sqlite.exec("UPDATE meetings SET deleted_at='2026-10-10' WHERE id='meeting-1'");
    await assert.rejects(carpoolRoute(captured.db, "admin", request(`/admin/carpool/plans/${plan.id}`, "PATCH"), { revision: 0, meetingId: "meeting-1" }, undefined, captured.access), denied(409));
    assert.equal((await db.prepare("SELECT meeting_id FROM carpool_plans").first<any>()).meeting_id, null); assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_log").first<any>()).count, audits);
  } finally { db.close(); }
});

test("Carpool backup references are bounded opaque nullable identities, never cross-module foreign keys", () => {
  assert.equal(carpoolMeetingId(null), null); assert.equal(carpoolMeetingId("opaque-missing"), "opaque-missing");
  for (const invalid of [12, "", " ", " padded ", "x".repeat(129), {}]) assert.throws(() => carpoolMeetingId(invalid), /available meeting/);
  validateCarpoolBackupTables({ carpool_plans: [{ installation_id: "primary", id: "plan", meeting_id: "missing-meeting" }], carpool_people: [], carpool_assignments: [], carpool_unresolved: [] });
});

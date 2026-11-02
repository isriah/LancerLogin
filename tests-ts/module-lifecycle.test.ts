// Module lifecycle, retention and cleanup that need no plugin, run without composing one. The Outreach-dependent cases are in outreach/module-lifecycle.ts (outreach-module-lifecycle.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { Database, request } from "./fixtures/lifecycle-database.ts";
import { attendanceSetupRoute } from "../apps/api/src/attendance-module-setup.ts";
import { runModuleCleanup } from "../apps/api/src/module-cleanup.ts";
import { captureModuleWorkspaceDatabase } from "../apps/api/src/module-database-scope.ts";
import { configureModulePlatform, readModulePlatformSnapshot, readModuleSetup, updateModuleSetup } from "../apps/api/src/module-platform.ts";

test("Attendance setup validates rules, a same-day meeting, a paired kiosk that checked in, and optional skips", async () => {
  const database = new Database();
  try {
    let state = await readModuleSetup(database, "admin", "attendance");
    assert.equal(state.ready, false);
    assert.deepEqual(state.steps.map((step) => [step.id, step.valid]), [["rules", true], ["meeting", false], ["input", false], ["calendar", false], ["discord", false]]);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "rules", outcome: "completed" });
    await assert.rejects(updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "meeting", outcome: "completed" }), /Complete the current setup step/);

    const meetingDefaults = await attendanceSetupRoute(request("/module-setup/attendance/meeting", "GET"), database, "admin");
    assert.equal((await meetingDefaults.json() as { timeZone: string }).timeZone, "UTC");
    const now = new Date();
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(now); dayEnd.setUTCHours(23, 59, 59, 999);
    const startsAt = new Date(Math.max(dayStart.getTime(), now.getTime() - 5 * 60_000)).toISOString();
    const endsAt = new Date(Math.min(dayEnd.getTime(), now.getTime() + 55 * 60_000)).toISOString();
    const meetingResponse = await attendanceSetupRoute(request("/module-setup/attendance/meeting", "POST", { title: "Same-day setup meeting", startsAt, endsAt, required: true }), database, "admin");
    assert.equal(meetingResponse.status, 201);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "meeting", outcome: "completed" });
    assert.equal(state.steps.find((step) => step.id === "meeting")?.valid, true);

    // Verified attendance input waits for an active paired kiosk, Pi or web, that has checked in.
    const kiosks = async () => (await (await attendanceSetupRoute(request("/module-setup/attendance/input", "GET"), database, "admin")).json() as { kiosks: { name: string; kind: string; lastSeenAt: string | null }[] }).kiosks;
    assert.deepEqual(await kiosks(), []);
    await assert.rejects(attendanceSetupRoute(request("/module-setup/attendance/input", "POST", { action: "start", name: "Synthetic browser" }), database, "admin"), (error: { status?: number }) => error.status === 405);
    await assert.rejects(updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "input", outcome: "completed" }), /Complete the current setup step/);
    database.sqlite.exec(`INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,redeemed_at,created_by,created_at,purpose,kiosk_kind,kiosk_name)
        VALUES('setup-pair','primary','setup-hash','2026-09-29','2026-09-28','admin','2026-09-28','hardware','web','Test web kiosk A');
      INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at,kind) VALUES('setup-kiosk','primary','setup-pair','Test web kiosk A','setup-token','2026-09-28','web');`);
    assert.deepEqual(await kiosks(), [{ id: "setup-kiosk", name: "Test web kiosk A", kind: "web", lastSeenAt: null }]);
    assert.equal((await readModuleSetup(database, "admin", "attendance")).steps.find((step) => step.id === "input")?.valid, false, "paired but not yet checked in");
    await assert.rejects(updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "input", outcome: "completed" }), /Complete the current setup step/);
    database.sqlite.exec("UPDATE kiosks SET active=0,last_seen_at='2026-09-28T12:00:00Z' WHERE id='setup-kiosk'");
    assert.equal((await readModuleSetup(database, "admin", "attendance")).steps.find((step) => step.id === "input")?.valid, false, "a retired kiosk does not count");
    database.sqlite.exec("UPDATE kiosks SET active=1 WHERE id='setup-kiosk'");
    assert.equal((await readModuleSetup(database, "admin", "attendance")).steps.find((step) => step.id === "input")?.valid, true);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "input", outcome: "completed" });
    assert.equal(state.ready, true);
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "calendar", outcome: "skipped" });
    state = await updateModuleSetup(database, "admin", "attendance", { generation: 1, stepId: "discord", outcome: "skipped" });
    assert.equal(state.ready, true);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM attendance_events").get()?.count, 0, "setup records no attendance");
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

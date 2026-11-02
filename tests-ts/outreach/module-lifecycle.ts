import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "../fixtures/lifecycle-database.ts";
import { runModuleCleanup } from "../../apps/api/src/module-cleanup.ts";
import { captureModuleWorkspaceDatabase } from "../../apps/api/src/module-database-scope.ts";
import { configureModulePlatform, readModulePlatformSnapshot } from "../../apps/api/src/module-platform.ts";

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

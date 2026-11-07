// Each module's reporting start date (operational baseline) in Core: migration 0096, backups and restores, without plugins.
// tests-ts/outreach/report-baselines.ts covers the Outreach date's endpoint, catalog and reports with the plugin composed.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../apps/api/src/index.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { BackupDatabase, backupClient } from "./fixtures/backup-database.ts";
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";
import { readCoreMigrations } from "./fixtures/d1-database.ts";

test("migration 0096 gives Outreach the single baseline every report used before", () => {
  const migrations = readCoreMigrations(); const index = migrations.findIndex((file) => file.name === "0096_module_report_baselines.sql");
  assert.ok(index > 0);
  for (const [attendance, expected] of [["2026-09-01", [{ module_id: "hour-tracking", starts_on: "2026-09-01", revision: 0 }]], ["2026-12-31", [{ module_id: "hour-tracking", starts_on: "2026-12-31", revision: 0 }]], [null, []]] as const) {
    const db = new DatabaseSync(":memory:");
    try {
      for (const file of migrations.slice(0, index)) db.exec(file.content);
      db.exec("INSERT INTO installations(id, created_at, auth_mode) VALUES ('primary', '2026-01-01T00:00:00.000Z', 'local')");
      db.prepare("INSERT INTO organization_settings(installation_id, organization_name, time_zone, attendance_reporting_starts_on) VALUES ('primary', 'Synthetic Robotics', 'America/New_York', ?)").run(attendance);
      db.exec(migrations[index]!.content);
      assert.deepEqual(db.prepare("SELECT module_id, starts_on, revision FROM module_report_baselines").all().map((row) => ({ ...row })), expected, String(attendance));
      assert.throws(() => db.exec("INSERT INTO module_report_baselines VALUES ('primary', 'attendance', NULL, 0, 'now')"), /CHECK/, "Attendance's date stays in organization_settings");
      assert.throws(() => db.exec("INSERT INTO module_report_baselines VALUES ('primary', 'other', '2026-02-30', 0, 'now')"), /CHECK/);
    } finally { db.close(); }
  }
});

test("without the Outreach plugin there is no Outreach date to edit, and backups leave its row out", async (t) => {
  assert.equal(bundledModuleRegistry.get("hour-tracking"), undefined);
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  for (const moduleId of ["hour-tracking", "attendance"]) assert.equal((await client.call(`/admin/modules/${moduleId}/report-baseline`)).status, 404, moduleId);
  db.raw.exec("UPDATE organization_settings SET attendance_reporting_starts_on='2026-09-01'; INSERT INTO module_report_baselines VALUES ('primary', 'hour-tracking', '2026-08-15', 3, '2026-10-01T00:00:00.000Z')");
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 50); assert.deepEqual(backup.tables.module_report_baselines, [], "a module not in this build carries none of its data");
  for (const scope of ["meetings", "roster"] as const) assert.equal("module_report_baselines" in (await client.backup(scope)).tables, false);
  const invalid = structuredClone(backup); invalid.tables.module_report_baselines = [{ installation_id: "primary", module_id: "attendance", starts_on: "2026-09-01", revision: 0, updated_at: "2026-10-01T00:00:00.000Z" }];
  assert.equal((await client.restore(invalid)).status, 400);
  const badDate = structuredClone(backup); badDate.tables.module_report_baselines = [{ installation_id: "primary", module_id: "hour-tracking", starts_on: "2026-02-30", revision: 0, updated_at: "2026-10-01T00:00:00.000Z" }];
  assert.equal((await client.restore(badDate)).status, 400);
});

test("a schema 49 backup restores Outreach's date from the single baseline it carried", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  db.raw.exec("UPDATE organization_settings SET attendance_reporting_starts_on='2026-12-31'");
  const legacy = await client.backup("installation"); legacy.schemaVersion = 49; omitContestResubmissionFields(legacy);
  assert.equal("module_report_baselines" in legacy.tables, false);
  db.raw.exec("DELETE FROM module_report_baselines");
  const restored = await client.restore(legacy); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(db.rows("SELECT module_id, starts_on, revision FROM module_report_baselines"), [{ module_id: "hour-tracking", starts_on: "2026-12-31", revision: 0 }]);
  db.raw.exec("UPDATE organization_settings SET attendance_reporting_starts_on=NULL");
  const blank = await client.backup("installation"); blank.schemaVersion = 49; omitContestResubmissionFields(blank);
  assert.equal((await client.restore(blank)).status, 200);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM module_report_baselines"), 0);
});

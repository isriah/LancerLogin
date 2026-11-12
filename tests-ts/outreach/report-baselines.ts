// Outreach's reporting start date (operational baseline) with the plugin composed: the Admin endpoint behind the SDK's
// ReportingStartDateField, the report catalog, and backups.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../apps/api/src/index.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { backupClient, sessionSecret } from "../fixtures/backup-database.ts";
import { PluginDatabase } from "../fixtures/plugin-database.ts";

const env = (db: PluginDatabase) => ({ DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" });
async function call(db: PluginDatabase, path: string, init: { method?: string; body?: unknown; role?: "admin" | "operator" } = {}) {
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: init.role ?? "admin", role: init.role ?? "admin" });
  return worker.fetch(new Request("https://fixture.test" + path, { method: init.method ?? "GET", headers: { cookie, ...(init.body ? { "content-type": "application/json" } : {}) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }), env(db));
}
const path = "/admin/modules/hour-tracking/report-baseline";

test("Admins read and save Outreach's reporting start date with a revision check", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close());
  db.raw.exec("UPDATE organization_settings SET time_zone='America/New_York', attendance_reporting_starts_on='2026-09-01'");
  const initial = await call(db, path); assert.equal(initial.status, 200);
  assert.deepEqual({ ...await initial.json() as Record<string, unknown>, today: undefined }, { moduleId: "hour-tracking", label: "Outreach", startsOn: null, revision: 0, timeZone: "America/New_York", today: undefined });
  const saved = await call(db, path, { method: "PUT", body: { startsOn: "2026-08-15", revision: 0 } }); assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual({ ...await saved.json() as Record<string, unknown>, today: undefined }, { moduleId: "hour-tracking", label: "Outreach", startsOn: "2026-08-15", revision: 1, timeZone: "America/New_York", today: undefined });
  assert.equal((await call(db, path, { method: "PUT", body: { startsOn: "2026-07-01", revision: 0 } })).status, 409, "a stale edit is refused");
  assert.deepEqual(db.rows("SELECT starts_on, revision FROM module_report_baselines WHERE module_id='hour-tracking'"), [{ starts_on: "2026-08-15", revision: 1 }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action='reports.baseline_updated' AND target_id='hour-tracking'"), 1);
  for (const body of [{ startsOn: "2026-02-30", revision: 1 }, { startsOn: "08/15/2026", revision: 1 }, { startsOn: "2026-08-15" }]) assert.equal((await call(db, path, { method: "PUT", body })).status, 400, JSON.stringify(body));
  const cleared = await call(db, path, { method: "PUT", body: { startsOn: null, revision: 1 } }); assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { startsOn: string | null }).startsOn, null);
  assert.equal(db.rows<{ attendance_reporting_starts_on: string }>("SELECT attendance_reporting_starts_on FROM organization_settings")[0]!.attendance_reporting_starts_on, "2026-09-01", "Attendance's date is separate");
  assert.equal((await call(db, path, { role: "operator" })).status, 403);
  assert.equal((await call(db, "/admin/modules/attendance/report-baseline")).status, 404, "Attendance's date is in Meeting configuration");
  assert.equal((await call(db, "/admin/modules/carpool/report-baseline")).status, 404);
});

test("the report catalog lists each module's date and Outreach datasets name it as their baseline", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close());
  db.raw.exec("UPDATE organization_settings SET attendance_reporting_starts_on='2026-09-01'; INSERT INTO module_report_baselines VALUES ('primary', 'hour-tracking', '2026-08-15', 1, '2026-10-01T00:00:00.000Z')");
  const catalog = await (await call(db, "/reports/catalog")).json() as { baseline: string; baselines: unknown; datasets: { id: string; baselineModule?: string }[] };
  assert.equal(catalog.baseline, "2026-09-01");
  assert.deepEqual(catalog.baselines, [{ moduleId: "attendance", label: "Attendance", startsOn: "2026-09-01" }, { moduleId: "hour-tracking", label: "Outreach", startsOn: "2026-08-15" }]);
  assert.deepEqual(Object.fromEntries(catalog.datasets.map((dataset) => [dataset.id, dataset.baselineModule ?? null])), { "core.members": null, "core.combined-members": null, "attendance.members": "attendance", "outreach.members": "hour-tracking", "outreach.activities": "hour-tracking", "outreach.entries": "hour-tracking", "outreach.teams": "hour-tracking" });
});

test("installation backups carry Outreach's date and restore it", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  db.raw.exec("INSERT INTO module_report_baselines VALUES ('primary', 'hour-tracking', '2026-08-15', 2, '2026-10-01T00:00:00.000Z')");
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 51);
  assert.deepEqual(backup.tables.module_report_baselines, [{ installation_id: "primary", module_id: "hour-tracking", starts_on: "2026-08-15", revision: 2, updated_at: "2026-10-01T00:00:00.000Z" }]);
  db.raw.exec("UPDATE module_report_baselines SET starts_on='2026-12-31'");
  const restored = await client.restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(db.rows("SELECT module_id, starts_on, revision FROM module_report_baselines"), [{ module_id: "hour-tracking", starts_on: "2026-08-15", revision: 2 }]);
});

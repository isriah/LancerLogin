// Carpool's place in the module platform once composed: registry ownership, scoped stylesheet and reviewed controls,
// lifecycle and cleanup with unrelated modules disabled, and historical backups that predate its plugin section.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
// The Worker loads first, as in a composed build, so the plugin modules it imports initialize in build order.
import worker from "../../apps/api/src/index.ts";
import manifest from "@lancerlogin-test/carpool/src/manifest.ts";
import api from "@lancerlogin-test/carpool/src/api.ts";
import { carpoolRoute, createCarpoolPlan } from "@lancerlogin-test/carpool/src/api/carpool-api.ts";
import { installedApiModule } from "../../apps/api/src/installed-api-modules.ts";
import { runModuleCleanup } from "../../apps/api/src/module-cleanup.ts";
import { captureModuleWorkspaceDatabase } from "../../apps/api/src/module-database-scope.ts";
import { dashboardModuleScope } from "../../apps/dashboard/src/design-conformance.ts";
import { extractedModules } from "../../apps/api/src/extracted-modules.ts";
import { attendanceModule, bundledModuleRegistry, createModuleRegistry } from "../../packages/shared/src/module-platform.ts";
import { backupClient } from "../fixtures/backup-database.ts";
import { omitContestResubmissionFields } from "../fixtures/backup-versions.ts";
import { carpoolPlugin } from "../fixtures/carpool-plugin.ts";
import { Database, request } from "../fixtures/lifecycle-database.ts";
import { PluginDatabase } from "../fixtures/plugin-database.ts";
import { stylesheetRules } from "../fixtures/stylesheet-rules.ts";

const root = carpoolPlugin.available ? carpoolPlugin.root : "";

test("Carpool is standalone and owns only its module surfaces", () => {
  assert.deepEqual(bundledModuleRegistry.modules.map((module) => module.id), ["attendance", "hour-tracking", "carpool"]);
  assert.deepEqual(bundledModuleRegistry.validateSelection(["carpool"]), ["carpool"]);
  assert.deepEqual(manifest.dependencies, []);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/carpool/context")?.module.id, "carpool");
  assert.equal(bundledModuleRegistry.routeOwner("/module-setup/carpool/plan")?.route.access, "setup");
  assert.equal(bundledModuleRegistry.tableOwner("carpool_people")?.id, "carpool");
  assert.equal(bundledModuleRegistry.tableOwner("carpool_location_resolution")?.id, "carpool");
  assert.ok(manifest.backup.nonPortableTables?.includes("carpool_location_resolution"));
  assert.ok(manifest.lifecycle.cleanupTargets.includes("carpool_location_resolution"));
  assert.equal(bundledModuleRegistry.tableOwner("members"), undefined);
  assert.equal(manifest.persistence.tables.some((table) => table.startsWith("hours_") || table === "meetings"), false);
  assert.equal(manifest.tablePrefix, "carpool_");
  assert.equal(createModuleRegistry([attendanceModule, bundledModuleRegistry.get("hour-tracking")!, manifest]).tableOwner("carpool_plans")?.id, "carpool");
});

test("the plugin keeps the identity, lifecycle and cleanup it had as a first-party module", () => {
  const extracted = extractedModules.find((module) => module.id === "carpool")!;
  assert.equal(manifest.label, extracted.label); assert.equal(manifest.contractVersion, extracted.contractVersion);
  assert.equal(manifest.setup.version, 1);
  assert.deepEqual(manifest.persistence.tables, extracted.catalogDefinition.tables);
  assert.deepEqual(manifest.deletedData, extracted.catalogDefinition.deletedData);
  // Interrupted deletions resume at a persisted cursor, so the steps must be identical and in the same order.
  assert.deepEqual(JSON.parse(JSON.stringify(api.cleanup.steps)), extracted.catalogDefinition.cleanup);
  assert.equal(manifest.lifecycle.cleanupTargets.length, api.cleanup.steps.length);
  assert.deepEqual(Object.keys(api.backup!.tables), [...manifest.backup.tables]);
  assert.deepEqual(Object.keys(api.backup!.tables), extracted.tables.map((table) => table.name));
  assert.equal(installedApiModule("carpool"), api);
});

test("the Carpool stylesheet stays beneath its module root and Core stylesheets leave Carpool classes alone", async () => {
  const css = await readFile(join(root, "src/carpool.css"), "utf8");
  const scope = dashboardModuleScope("carpool"); const rules = stylesheetRules(css);
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    if (rule.keyframes) { assert.ok(rule.keyframes.startsWith("carpool-"), `keyframes ${rule.keyframes} must use the module prefix`); continue; }
    for (const selector of rule.selectors) {
      const scoped = selector.indexOf(scope); const moduleClass = selector.indexOf(".carpool-");
      assert.ok(scoped >= 0 && (moduleClass < 0 || moduleClass > scoped), `carpool.css: ${selector} must sit beneath ${scope}`);
    }
  }
  const sources = await readdir(join(root, "src"), { recursive: true });
  const importers = [];
  for (const file of sources.map((name) => String(name).replaceAll("\\", "/")).filter((name) => /\.tsx?$/.test(name))) if ((await readFile(join(root, "src", file), "utf8")).includes('import "./carpool.css";')) importers.push(file);
  assert.deepEqual(importers, ["dashboard.tsx"], "carpool.css loads only through the dashboard contribution");
  for (const file of (await readdir("apps/dashboard/src")).filter((name) => name.endsWith(".css"))) assert.doesNotMatch(await readFile(`apps/dashboard/src/${file}`, "utf8"), /\.carpool-/, `${file} must not style Carpool classes`);
});

test("raw Carpool dashboard controls remain in the reviewed UI inventory", async () => {
  type Counts = Partial<Record<"button" | "input" | "select" | "textarea" | "summary", number>>;
  const reviewed: Record<string, Counts> = {
    "carpool-plan-form.tsx": { button: 2, input: 7, select: 3, textarea: 1, summary: 1 },
    "carpool-settings.tsx": { button: 1, input: 4 },
    "carpool-setup-workspace.tsx": { button: 1, input: 2 },
    "carpool-meeting-links.tsx": { select: 1 },
    "carpool-workspace.tsx": { button: 20, input: 1, select: 2 },
    "carpool-share.tsx": { button: 4, select: 1, summary: 1 },
    "carpool-location-status.tsx": { button: 1 },
    "carpool-import.tsx": { button: 14, input: 2, select: 3, summary: 1 },
    "carpool-participant-editor.tsx": { button: 11, input: 7, select: 2, textarea: 1, summary: 2 },
    "carpool-people.tsx": { button: 5, input: 1, select: 1 },
    "carpool-pin-map.tsx": { button: 1 },
    "carpool-groups.tsx": { button: 27, input: 6, select: 3, summary: 1 },
    "carpool-rebuild-preview.tsx": { button: 4, input: 1, summary: 1 },
    "carpool-assignment-editor.tsx": { button: 4, select: 1 },
  };
  const actual: Record<string, Counts> = {};
  const files = [...(await readdir(join(root, "src/dashboard"))).filter((file) => file.endsWith(".tsx")).map((file) => join("dashboard", file)), "dashboard.tsx"];
  for (const file of files) {
    const source = await readFile(join(root, "src", file), "utf8"); const counts: Counts = {};
    for (const tag of ["button", "input", "select", "textarea", "summary"] as const) { const count = [...source.matchAll(new RegExp(`<${tag}\\b`, "g"))].length; if (count) counts[tag] = count; }
    if (Object.keys(counts).length) actual[file.replace(/^dashboard[\\/]/, "")] = counts;
  }
  assert.deepEqual(actual, reviewed, "Native control markup changed. Use the shared UI patterns and focused rendered coverage, then review and update this inventory deliberately.");
});

test("Carpool lookup runs with unrelated modules disabled and cleanup removes its execution authority", async () => {
  const database = new Database(true);
  try {
    database.sqlite.exec("INSERT INTO platform_module_epochs VALUES('primary','carpool',1); INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','carpool',1,1,'disabled',1,0,0)");
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

test("schema 30 archives restore Carpool plans through the plugin and schema 28 archives start Carpool disabled and empty", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  db.raw.exec(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','carpool',1);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','carpool',1,1,'disabled',1,0);
    INSERT INTO carpool_plans(installation_id,id,title,destination,radius_miles,preferred_radius_miles,notes,archived,revision,created_at,updated_at) VALUES('primary','schema-30-plan','Schema 30 plan','Competition venue',12,4,'',0,0,'2026-09-28','2026-09-28');`);
  const backup = await client.backup("installation");
  const carpool = backup.externalModules.find((entry: { id: string }) => entry.id === "carpool");
  const schema30 = structuredClone(backup); schema30.externalModules = []; Object.assign(schema30.tables, carpool.tables); delete schema30.tables.carpool_settings;
  schema30.schemaVersion = 30; omitContestResubmissionFields(schema30);
  delete schema30.tables.hours_public_form_settings;
  for (const row of schema30.tables.kiosks) { delete row.configured_authentication_method; delete row.authentication_method; }
  for (const row of schema30.tables.hours_publication_operations) delete row.event_snapshot_json;
  for (const row of schema30.tables.members) delete row.inactive_periods_json;
  for (const row of schema30.tables.hours_correction_requests) delete row.activity_id;
  for (const row of schema30.tables.carpool_plans) for (const column of ["meeting_id", "trip_scope", "group_settings_json", "last_rebuild_json", "time_zone", "outbound_departure_at", "return_departure_at"]) delete row[column];
  for (const row of schema30.tables.organization_settings) delete row.kiosk_authentication_method;
  for (const name of ["discord_attendance_notifications", "discord_attendance_recipients"]) for (const row of schema30.tables[name]) delete row.delivery_id;
  let result = await client.restore(schema30); assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(db.rows("SELECT title, trip_scope, meeting_id, time_zone FROM carpool_plans WHERE id='schema-30-plan'"), [{ title: "Schema 30 plan", trip_scope: "both", meeting_id: null, time_zone: "UTC" }]);
  assert.deepEqual(db.rows("SELECT phase FROM platform_modules WHERE module_id='carpool'"), [{ phase: "disabled" }]);
  const schema28 = structuredClone(schema30); schema28.schemaVersion = 28; schema28.ownership.modules = schema28.ownership.modules.filter((module: { id: string }) => module.id !== "carpool");
  for (const table of Object.keys(schema28.tables).filter((name) => name.startsWith("carpool_"))) delete schema28.tables[table];
  for (const table of ["platform_module_epochs", "platform_modules", "platform_module_assignments", "platform_module_setup_progress"]) schema28.tables[table] = schema28.tables[table].filter((row: Record<string, unknown>) => row.module_id !== "carpool");
  delete schema28.tables.hours_labels; delete schema28.tables.hours_activity_labels; delete schema28.tables.hours_publication_settings;
  for (const row of schema28.tables.hours_activities) { delete row.event_start_local; delete row.event_end_local; delete row.event_start_occurrence; delete row.event_end_occurrence; }
  for (const row of schema28.tables.hours_publication_operations) delete row.action;
  result = await client.restore(schema28); assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(db.rows("SELECT phase FROM platform_modules WHERE module_id='carpool'"), [{ phase: "disabled" }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM carpool_plans"), 0);
});

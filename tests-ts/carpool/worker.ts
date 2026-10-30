// Carpool through the Worker with the plugin composed: route admission, settings authority, lifecycle on an upgraded
// installation, and backups. Current backups carry Carpool in its plugin section; archives exported while Carpool was
// first-party (schema 42 and earlier) carry it in Core's section and restore through the plugin's adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { type Env } from "../../apps/api/src/index.ts";
import { reconcileInstalledModules } from "../../apps/api/src/module-catalog.ts";
import { runModuleCleanup } from "../../apps/api/src/module-cleanup.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { omitContestResubmissionFields } from "../fixtures/backup-versions.ts";
import { BackupDatabase, backupClient } from "../fixtures/backup-database.ts";
import { PluginDatabase } from "../fixtures/plugin-database.ts";
import { carpoolPlugin } from "../fixtures/carpool-plugin.ts";
import { FakeDatabase, request, seedInstallationBackupFoundation, sessionCookie, sessionSecret } from "../fixtures/worker-fake-database.ts";

type Backup = Record<string, any>;
const carpoolTables = ["carpool_settings", "carpool_plans", "carpool_people", "carpool_assignments", "carpool_unresolved", "carpool_import_profiles", "carpool_location_cache"];
const section = (backup: Backup) => backup.externalModules.find((entry: { id: string }) => entry.id === "carpool");

/** The disabled Carpool lifecycle rows an installation has once Carpool is registered. */
function seedWithCarpool(database: FakeDatabase) {
  seedInstallationBackupFoundation(database);
  (database.lists.get("FROM platform_module_epochs WHERE") as Record<string, unknown>[]).push({ installation_id: "primary", module_id: "carpool", generation: 1 });
  (database.lists.get("FROM platform_modules WHERE") as Record<string, unknown>[]).push({ installation_id: "primary", module_id: "carpool", contract_version: 1, generation: 1, phase: "disabled", setup_version: 1, setup_complete: 0, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null });
}

/** The archive Core exported at an earlier schema while Carpool was first-party: Carpool tables sit in Core's section. */
function historical(current: Backup, schemaVersion: number): Backup {
  const copy = structuredClone(current); const carpool = section(copy);
  copy.externalModules = copy.externalModules.filter((entry: { id: string }) => entry.id !== "carpool");
  Object.assign(copy.tables, carpool.tables); copy.schemaVersion = schemaVersion;
  if (schemaVersion < 35) delete copy.tables.carpool_settings;
  omitContestResubmissionFields(copy);
  return copy;
}

test("the composed Worker reports and serves the Carpool plugin", async () => {
  assert.equal(carpoolPlugin.available, true);
  const health = await worker.fetch(new Request("https://api.example.test/health"), { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", DB: new FakeDatabase() } as unknown as Env);
  assert.deepEqual((await health.json() as { modules: string[] }).modules, ["attendance", "hour-tracking", "carpool"]);
});

test("Worker composition exposes Carpool navigation only with both current module permissions", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("operator"); let attendance = true; let carpool = true;
  database.rows.set("SELECT m.generation FROM users u", (_sql: string, values: unknown[]) => (values[0] === "attendance" ? attendance : carpool) ? { generation: 1 } : undefined);
  database.lists.set("SELECT meeting_id AS meetingId,id,title FROM carpool_plans", [{ meetingId: "meeting-1", id: "plan-1", title: "Synthetic plan" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const read = () => worker.fetch(request("/admin/carpool/meeting-links", undefined, { cookie }), env);
  const visible = await read(); assert.equal(visible.status, 200); assert.deepEqual(await visible.json(), { available: true, links: [{ meetingId: "meeting-1", id: "plan-1", title: "Synthetic plan" }] });
  attendance = false; database.calls = []; const unavailable = await read(); assert.equal(unavailable.status, 200); assert.deepEqual(await unavailable.json(), { available: false, links: [] });
  assert.equal(database.calls.some(call => call.sql.includes("FROM carpool_plans") || call.sql.includes("FROM meetings")), false);
  carpool = false; assert.equal((await read()).status, 403);
});

test("Carpool settings require current Admin authorization and never expose credentials", async () => {
  // CARPOOL_GEOAPIFY_KEY in the Worker environment is not a fallback: plugins never receive the environment.
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: "A".repeat(43), CARPOOL_GEOAPIFY_KEY: "synthetic-deployment-key", DB: database } as unknown as Env;
  const operator = await worker.fetch(request("/admin/carpool/settings", undefined, { cookie: await sessionCookie("operator") }), env); assert.equal(operator.status, 403);
  assert.equal(database.calls.some(call => call.sql.includes("carpool_settings") || call.sql.includes("carpool_geocoding_credentials")), false);
  const admin = await worker.fetch(request("/admin/carpool/settings", undefined, { cookie: await sessionCookie("admin") }), env); assert.equal(admin.status, 200, await admin.clone().text());
  assert.deepEqual(await admin.json(), { radiusMiles: 12, preferredRadiusMiles: 4, revision: 0, geocodingConfigured: false, canSaveApiKey: true });
});

test("invalid Carpool rows are refused before writes and schema 29 archives register Carpool fresh", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedWithCarpool(database);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const installation = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Backup;
  assert.equal(installation.schemaVersion, 45); assert.equal(carpoolTables.some((table) => table in installation.tables), false);
  const savedAt = "2026-09-29T00:00:00Z";
  const rows = {
    carpool_plans: [{ installation_id: "primary", id: "plan-1", title: "Tampered", destination: "Arena", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "both", group_settings_json: "[]", last_rebuild_json: null, time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }],
    carpool_people: [
      { installation_id: "primary", plan_id: "plan-1", id: "driver", member_id: null, display_name: "Driver", contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: "offer", outbound_address: "One", outbound_lat: 40, outbound_lon: -74, outbound_seats: 1, return_status: "offer", return_address: "One", return_lat: 40, return_lon: -74, return_seats: 1, return_same_as_outbound: 1, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: null, outbound_location_label: null, return_location_source: null, return_location_label: null },
      { installation_id: "primary", plan_id: "plan-1", id: "rider", member_id: null, display_name: "Rider", contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: "needs-ride", outbound_address: "Two", outbound_lat: 40.1, outbound_lon: -74.1, outbound_seats: null, return_status: "needs-ride", return_address: "Two", return_lat: 40.1, return_lon: -74.1, return_seats: null, return_same_as_outbound: 1, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: null, outbound_location_label: null, return_location_source: null, return_location_label: null },
    ],
    carpool_assignments: [{ installation_id: "primary", plan_id: "plan-1", direction: "outbound", rider_id: "rider", vehicle_person_id: "driver", distance_miles: 1, locked: 0, manual: 0, created_at: savedAt, updated_at: savedAt }],
    carpool_unresolved: [{ installation_id: "primary", plan_id: "plan-1", direction: "outbound", rider_id: "rider", reason: "needs-review", detail: "Conflicting state", created_at: savedAt }],
  };
  const tampered = structuredClone(installation); Object.assign(section(tampered).tables, rows);
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: tampered }, { cookie }), env)).status, 400);
  const tamperedHistorical = historical(installation, 42); Object.assign(tamperedHistorical.tables, rows);
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: tamperedHistorical }, { cookie }), env)).status, 400);
  assert.equal(database.batches.length, 0);
  const schema29 = structuredClone(installation); schema29.externalModules = schema29.externalModules.filter((entry: { id: string }) => entry.id !== "carpool"); schema29.schemaVersion = 29; omitContestResubmissionFields(schema29);
  for (const table of ["platform_module_epochs", "platform_modules"]) schema29.tables[table] = schema29.tables[table].filter((row: Record<string, unknown>) => row.module_id !== "carpool");
  const restored29 = await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: schema29 }, { cookie }), env); assert.equal(restored29.status, 200, await restored29.clone().text());
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO platform_modules") && item.values.includes("carpool")));
});

test("Carpool meeting links survive strict schema33 recovery and older archives default to standalone", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedWithCarpool(database);
  const savedAt = "2026-10-10T00:00:00Z";
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic navigation", destination: "", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: "unavailable-meeting", trip_scope: "both", group_settings_json: "[]", last_rebuild_json: null, time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Backup;
  assert.equal(current.schemaVersion, 45); assert.equal(section(current).tables.carpool_plans[0].meeting_id, "unavailable-meeting");
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  const missing = structuredClone(current); delete section(missing).tables.carpool_plans[0].meeting_id;
  assert.equal((await restore(missing)).status, 400);
  for (const invalid of [123, "", " ", " padded "]) { const changed = structuredClone(current); section(changed).tables.carpool_plans[0].meeting_id = invalid; assert.equal((await restore(changed)).status, 400); }
  for (const invalid of [123, "", " ", " padded "]) { const changed = historical(current, 42); changed.tables.carpool_plans[0].meeting_id = invalid; assert.equal((await restore(changed)).status, 400); }
  assert.equal(database.batches.length, 0);
  const restored = await restore(current); assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok(database.batches.at(-1)!.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.includes("unavailable-meeting")), "Optional opaque links do not require an Attendance table foreign key");
  const previous = historical(current, 32);
  delete previous.tables.hours_public_form_settings;
  const outreachOwner = previous.ownership.modules.find((module: Record<string, unknown>) => module.id === "hour-tracking");
  outreachOwner.tables = outreachOwner.tables.filter((table: string) => table !== "hours_public_form_settings");
  for (const row of previous.tables.hours_correction_requests) delete row.activity_id;
  for (const row of previous.tables.carpool_plans) { delete row.meeting_id; delete row.trip_scope; delete row.group_settings_json; delete row.last_rebuild_json; delete row.time_zone; delete row.outbound_departure_at; delete row.return_departure_at; }
  const migrated = await restore(previous); assert.equal(migrated.status, 200, await migrated.clone().text());
  assert.ok(database.batches.at(-1)!.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.sql.includes("meeting_id") && item.values.includes(null) && item.values.at(-6) === "both"));
});

test("Carpool schema37 preserves trip scope and pin provenance and defaults schema36 archives", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedWithCarpool(database); const savedAt = "2026-10-14T00:00:00Z";
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic return plan", destination: "Synthetic venue", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "return", group_settings_json: "[]", last_rebuild_json: null, time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }]);
  database.lists.set("FROM carpool_people WHERE", [{ installation_id: "primary", plan_id: "plan-1", id: "person-1", member_id: null, display_name: "Synthetic rider", contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: "unknown", outbound_address: "", outbound_lat: null, outbound_lon: null, outbound_seats: null, return_status: "needs-ride", return_address: "Synthetic address", return_lat: 40, return_lon: -74, return_seats: null, return_same_as_outbound: 0, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: null, outbound_location_label: null, return_location_source: "lookup", return_location_label: "Synthetic matched address" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Backup; assert.equal(current.schemaVersion, 45);
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  const mutations = [(tables: Backup) => { delete tables.carpool_plans[0].trip_scope; }, (tables: Backup) => { tables.carpool_plans[0].trip_scope = "unexpected"; }, (tables: Backup) => { tables.carpool_people[0].return_location_source = "no-match"; }, (tables: Backup) => { delete tables.carpool_people[0].return_location_label; }];
  for (const mutate of mutations) { const bad = structuredClone(current); mutate(section(bad).tables); assert.equal((await restore(bad)).status, 400); }
  for (const mutate of mutations) { const bad = historical(current, 42); mutate(bad.tables); assert.equal((await restore(bad)).status, 400); }
  assert.equal(database.batches.length, 0); const result = await restore(current); assert.equal(result.status, 200, await result.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_people") && item.values.includes("lookup") && item.values.includes("Synthetic matched address"))); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-6) === "return"));
  const older = historical(current, 36); delete older.tables.carpool_plans[0].trip_scope; delete older.tables.carpool_plans[0].group_settings_json; delete older.tables.carpool_plans[0].last_rebuild_json; delete older.tables.carpool_plans[0].time_zone; delete older.tables.carpool_plans[0].outbound_departure_at; delete older.tables.carpool_plans[0].return_departure_at; for (const row of older.tables.carpool_people) for (const key of ["outbound_location_source", "outbound_location_label", "return_location_source", "return_location_label"]) delete row[key];
  const migrated = await restore(older); assert.equal(migrated.status, 200, await migrated.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-6) === "both")); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_people") && item.values.slice(-4).every(value => value === null)));
});

test("Carpool schema38 validates group labels and complete rebuild recovery while schema37 defaults them", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedWithCarpool(database); const savedAt = "2026-10-14T00:00:00Z";
  const settings = JSON.stringify([{ direction: "outbound", vehiclePersonId: "driver", label: "Synthetic east group", color: "teal" }]); const snapshot = { version: 1, revision: 3, directions: ["outbound"], radiusMiles: 12, preferredRadiusMiles: 4, assignments: [{ direction: "outbound", riderId: "rider", vehiclePersonId: "driver", distanceMiles: 1, locked: true, manual: true }], unresolved: [] };
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic groups", destination: "Synthetic venue", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 20, preferred_radius_miles: 6, notes: "", archived: 0, revision: 3, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "both", group_settings_json: settings, last_rebuild_json: JSON.stringify(snapshot), time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }]);
  database.lists.set("FROM carpool_people WHERE", ["driver", "rider"].map(id => ({ installation_id: "primary", plan_id: "plan-1", id, member_id: null, display_name: "Synthetic " + id, contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: id === "driver" ? "offer" : "needs-ride", outbound_address: "Synthetic pickup", outbound_lat: 40, outbound_lon: -74, outbound_seats: id === "driver" ? 1 : null, return_status: "transit", return_address: "", return_lat: null, return_lon: null, return_seats: null, return_same_as_outbound: 0, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: "manual", outbound_location_label: null, return_location_source: null, return_location_label: null })));
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Backup; assert.equal(current.schemaVersion, 45);
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  const mutations = [(tables: Backup) => { delete tables.carpool_plans[0].group_settings_json; }, (tables: Backup) => { tables.carpool_plans[0].group_settings_json = JSON.stringify([{ direction: "outbound", vehiclePersonId: "missing", label: "Group", color: "blue" }]); }, (tables: Backup) => { tables.carpool_plans[0].last_rebuild_json = JSON.stringify({ ...snapshot, revision: 4 }); }, (tables: Backup) => { tables.carpool_plans[0].last_rebuild_json = JSON.stringify({ ...snapshot, assignments: [...snapshot.assignments, ...snapshot.assignments] }); }, (tables: Backup) => { tables.carpool_people[0].outbound_seats = 0; }];
  for (const mutate of mutations) { const bad = structuredClone(current); mutate(section(bad).tables); assert.equal((await restore(bad)).status, 400); }
  for (const mutate of mutations) { const bad = historical(current, 42); mutate(bad.tables); assert.equal((await restore(bad)).status, 400); }
  assert.equal(database.batches.length, 0); const restored = await restore(current); assert.equal(restored.status, 200, await restored.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.includes(settings) && item.values.includes(JSON.stringify(snapshot))));
  const older = historical(current, 37); delete older.tables.carpool_plans[0].group_settings_json; delete older.tables.carpool_plans[0].last_rebuild_json; delete older.tables.carpool_plans[0].time_zone; delete older.tables.carpool_plans[0].outbound_departure_at; delete older.tables.carpool_plans[0].return_departure_at; const migrated = await restore(older); assert.equal(migrated.status, 200, await migrated.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-5) === "[]" && item.values.at(-4) === null));
});

test("Carpool schema39 validates trip timing before writes and defaults schema38 timing", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedWithCarpool(database); const savedAt = "2026-10-14T00:00:00Z";
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic timed event", destination: "Synthetic venue", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "both", group_settings_json: "[]", last_rebuild_json: null, time_zone: "America/New_York", outbound_departure_at: "2026-10-14T12:00:00.000Z", return_departure_at: "2026-10-14T22:00:00.000Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Backup; assert.equal(current.schemaVersion, 45);
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  const mutations = [(row: Backup) => { delete row.time_zone; }, (row: Backup) => { row.time_zone = null; }, (row: Backup) => { row.time_zone = "Invalid/Zone"; }, (row: Backup) => { row.outbound_departure_at = "2026-02-30T12:00:00.000Z"; }, (row: Backup) => { row.outbound_departure_at = ""; }, (row: Backup) => { row.return_departure_at = row.outbound_departure_at; }];
  for (const mutate of mutations) { const bad = structuredClone(current); mutate(section(bad).tables.carpool_plans[0]); assert.equal((await restore(bad)).status, 400); }
  for (const mutate of mutations) { const bad = historical(current, 42); mutate(bad.tables.carpool_plans[0]); assert.equal((await restore(bad)).status, 400); }
  assert.equal(database.batches.length, 0); const restored = await restore(current); assert.equal(restored.status, 200, await restored.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-3) === "America/New_York" && item.values.at(-2) === "2026-10-14T12:00:00.000Z"));
  const older = historical(current, 38); for (const key of ["time_zone", "outbound_departure_at", "return_departure_at"]) delete older.tables.carpool_plans[0][key]; const migrated = await restore(older); assert.equal(migrated.status, 200, await migrated.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-3) === "UTC" && item.values.at(-2) === null && item.values.at(-1) === null));
});

const fixture = JSON.parse(readFileSync(new URL("../fixtures/carpool-first-party-backup.json", import.meta.url), "utf8")) as Backup;
const sortedRows = (rows: readonly Record<string, unknown>[]) => rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
function assertCarpoolRows(db: BackupDatabase, expected: Record<string, readonly Record<string, unknown>[]>) {
  for (const table of carpoolTables) assert.deepEqual(sortedRows(db.rows(`SELECT * FROM ${table}`)), sortedRows(expected[table] ?? []), `${table} rows`);
}

test("a real schema 42 backup exported while Carpool was first-party restores through the plugin adapter", async (t) => {
  // tests-ts/fixtures/carpool-first-party-backup.json was exported by the Core Worker at e4a348ff (Carpool first-party) from a
  // synthetic installation: an enabled, set-up Carpool with plans, participants, locations, assignments, an unresolved ride,
  // an import profile, location cache entries, saved settings, a saved (non-portable) API key and lookup lease, and a kiosk.
  assert.equal(fixture.schemaVersion, 42);
  assert.ok(carpoolTables.every((table) => Array.isArray(fixture.tables[table])));
  assert.equal(JSON.stringify(fixture).includes("synthetic-carpool-ciphertext"), false);
  const db = new PluginDatabase(); t.after(() => db.raw.close());
  const client = backupClient(worker, db);
  const restored = await client.restore(fixture); assert.equal(restored.status, 200, await restored.clone().text());
  const body = await restored.json() as Record<string, unknown>;
  assert.deepEqual(body.recovery, { revokedKiosks: 1, invalidatedPairingCodes: 1, pausedProviderOperations: 0 }); assert.equal("excludedModules" in body, false);
  assertCarpoolRows(db, fixture.tables);
  assert.deepEqual(db.rows("SELECT phase, setup_complete FROM platform_modules WHERE module_id='carpool'"), [{ phase: "enabled", setup_complete: 1 }]);
  assert.deepEqual(db.rows("SELECT step_id, outcome FROM platform_module_setup_progress WHERE module_id='carpool'"), [{ step_id: "workspace", outcome: "completed" }]);
  assert.deepEqual(db.rows("SELECT user_id, capabilities_json FROM platform_module_assignments WHERE module_id='carpool'"), [{ user_id: "operator", capabilities_json: '["carpool.manage"]' }]);
  assert.deepEqual(db.rows("SELECT active, token_hash = 'synthetic-token-a' AS unchanged FROM kiosks"), [{ active: 0, unchanged: 0 }], "kiosk credentials are revoked as before");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM carpool_geocoding_credentials") + db.count("SELECT COUNT(*) AS n FROM carpool_location_resolution"), 0);

  // The next backup carries Carpool in its plugin section, with the same rows, and Core's section no longer owns Carpool.
  const current = await client.backup("installation");
  assert.equal(current.schemaVersion, 45);
  assert.equal(carpoolTables.some((table) => table in current.tables), false);
  // Outreach also moved into a plugin (schema 44), so Core's ownership metadata lists only Attendance.
  assert.deepEqual(current.ownership.modules.map((module: { id: string }) => module.id), ["attendance"]);
  const carpool = section(current);
  assert.deepEqual({ ...carpool, tables: undefined }, { id: "carpool", label: "Carpool", contractVersion: 1, backupVersion: 2, source: null, commit: null, tables: undefined });
  for (const table of carpoolTables) assert.deepEqual(sortedRows(carpool.tables[table]), sortedRows(fixture.tables[table]), `${table} in the plugin section`);

  // The same data restores from the plugin section and from the schema 41 form of the historical archive.
  for (const backup of [current, (() => { const legacy = structuredClone(fixture); legacy.schemaVersion = 41; delete legacy.externalModules; return legacy; })()]) {
    const target = new PluginDatabase(); t.after(() => target.raw.close());
    const result = await backupClient(worker, target).restore(backup); assert.equal(result.status, 200, await result.clone().text());
    assertCarpoolRows(target, fixture.tables);
    assert.deepEqual(target.rows("SELECT phase, setup_complete FROM platform_modules WHERE module_id='carpool'"), [{ phase: "enabled", setup_complete: 1 }]);
  }
});

test("installation recovery preserves Carpool defaults and removes nonportable credentials", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close());
  db.raw.exec(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','carpool',1);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','carpool',1,1,'disabled',1,0);
    INSERT INTO carpool_settings VALUES('primary',20,6,2,'2026-10-13T12:00:00Z'); INSERT INTO carpool_geocoding_credentials VALUES('primary','synthetic-encrypted-key','synthetic-iv',0);
    INSERT INTO carpool_plans(installation_id,id,title,created_at,updated_at) VALUES('primary','lookup-plan','Synthetic lookup recovery','2026-10-13T12:00:00Z','2026-10-13T12:00:00Z');
    INSERT INTO carpool_location_resolution VALUES('primary','lookup-plan','synthetic-input','running','synthetic-lease','2099-01-01T00:00:00Z',NULL);`);
  const client = backupClient(worker, db);
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 45); assert.equal(section(backup).tables.carpool_settings[0].preferred_radius_miles, 6);
  assert.equal("carpool_geocoding_credentials" in section(backup).tables, false); assert.doesNotMatch(JSON.stringify(backup), /synthetic-encrypted-key/);
  assert.equal("carpool_location_resolution" in section(backup).tables, false); assert.doesNotMatch(JSON.stringify(backup), /synthetic-lease|synthetic-input/);
  assert.equal((await client.restore(backup)).status, 200);
  assert.equal(db.count("SELECT preferred_radius_miles AS n FROM carpool_settings"), 6); assert.equal(db.count("SELECT COUNT(*) AS n FROM carpool_geocoding_credentials"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM carpool_location_resolution"), 0);
  const legacy = historical(backup, 34); legacy.tables.carpool_plans = [];
  const restored = await client.restore(legacy); assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal(db.count("SELECT COUNT(*) AS n FROM carpool_settings"), 0);
});

test("an installation that used first-party Carpool keeps its data, lifecycle and cleanup when the plugin is composed", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close()); db.recordCoreMigrations();
  const recorded = JSON.parse(readFileSync(new URL("../fixtures/carpool-first-party-catalog.json", import.meta.url), "utf8")) as { json: string; sha: string };
  db.raw.exec(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','carpool',2);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','carpool',1,2,'enabled',1,1);
    INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES ('primary','carpool','workspace',1,'completed','2026-03-01T00:00:00.000Z','admin');
    INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ('primary','operator','carpool','["carpool.manage"]');
    INSERT INTO carpool_plans(installation_id,id,title,created_at,updated_at) VALUES('primary','kept-plan','Synthetic kept plan','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z');
    INSERT INTO carpool_people(installation_id,plan_id,id,display_name,outbound_status,return_status,created_at,updated_at) VALUES('primary','kept-plan','kept-person','Synthetic Person','arranged','arranged','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z');`);
  db.raw.prepare("INSERT INTO platform_module_catalog(installation_id,module_id,origin,source,source_commit,contract_version,definition_json,definition_sha256,installed,recorded_at) VALUES ('primary','carpool','first-party',NULL,NULL,1,?,?,1,'2026-03-01T00:00:00.000Z')").run(recorded.json, recorded.sha);

  // Reconciliation adopts the historical schema without running SQL, and records the plugin in place of the first-party definition.
  assert.deepEqual(await reconcileInstalledModules(db as never), { changed: true, failures: [] });
  assert.deepEqual(db.rows("SELECT sequence, name FROM platform_module_migrations WHERE module_id='carpool'"), [{ sequence: 0, name: "adopted-baseline" }]);
  assert.deepEqual(db.rows("SELECT origin, installed, source, source_commit FROM platform_module_catalog WHERE module_id='carpool'"), [{ origin: "external", installed: 1, source: carpoolPlugin.available ? carpoolPlugin.source : null, source_commit: carpoolPlugin.available ? carpoolPlugin.commit : null }]);
  assert.deepEqual(db.rows("SELECT phase, generation, setup_complete FROM platform_modules WHERE module_id='carpool'"), [{ phase: "enabled", generation: 2, setup_complete: 1 }]);

  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", CARPOOL_GEOAPIFY_KEY: "synthetic-deployment-key" } as unknown as Env;
  const call = async (path: string, init: { method?: string; body?: unknown; user?: "admin" | "operator" } = {}) => {
    const user = init.user ?? "admin";
    const headers: Record<string, string> = { cookie: "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: user, role: user }) };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  let modules = await call("/platform/modules");
  const carpool = modules.body.modules.find((module: { id: string }) => module.id === "carpool");
  assert.equal(carpool.phase, "enabled"); assert.equal(carpool.workspaceReady, true); assert.equal(carpool.unavailable, undefined);
  const context = await call("/admin/carpool/context", { user: "operator" });
  assert.equal(context.status, 200, JSON.stringify(context.body)); assert.deepEqual(context.body.plans.map((plan: { id: string }) => plan.id), ["kept-plan"]);
  assert.equal(context.body.geocodingConfigured, false, "the legacy deployment-variable key is not read by the plugin");

  // Disabling retains the data; after the deadline, the plugin's cleanup steps remove Carpool data, setup and assignments only.
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance"], revision: modules.body.revision, confirmDisable: [{ moduleId: "carpool", generation: 2 }] } });
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  assert.equal(modules.body.modules.find((module: { id: string }) => module.id === "carpool").phase, "retained");
  db.raw.exec("UPDATE platform_modules SET disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z' WHERE module_id='carpool'");
  for (let pass = 0; pass < 20 && db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='carpool' AND phase='deleted'") === 0; pass += 1) await runModuleCleanup(db as never);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='carpool' AND phase='deleted'"), 1);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM carpool_plans") + db.count("SELECT COUNT(*) AS n FROM carpool_people"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_setup_progress WHERE module_id='carpool'") + db.count("SELECT COUNT(*) AS n FROM platform_module_assignments WHERE module_id='carpool'"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_setup_progress WHERE module_id='attendance'"), 3);
});

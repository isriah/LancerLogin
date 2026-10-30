// Core without the Carpool plugin: modules that moved from first-party into plugins (apps/api/src/extracted-modules.ts) keep
// historical backups restorable, never orphan retained data, and stay out of new backups. The same archive restoring through
// the composed plugin is covered by tests-ts/carpool-worker.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../apps/api/src/index.ts";
import { extractedModules } from "../apps/api/src/extracted-modules.ts";
import { reconcileInstalledModules } from "../apps/api/src/module-catalog.ts";
import { runModuleCleanup } from "../apps/api/src/module-cleanup.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { readModuleSnapshot } from "../apps/dashboard/src/module-client.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { BackupDatabase, backupClient, sessionSecret } from "./fixtures/backup-database.ts";

type Backup = Record<string, any>;
// Exported by the Core Worker at e4a348ff while Carpool was first-party; see tests-ts/carpool/worker.ts.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/carpool-first-party-backup.json", import.meta.url), "utf8")) as Backup;
const recordedCatalog = JSON.parse(readFileSync(new URL("./fixtures/carpool-first-party-catalog.json", import.meta.url), "utf8")) as { json: string; sha: string };
const carpoolTables = ["carpool_settings", "carpool_plans", "carpool_people", "carpool_assignments", "carpool_unresolved", "carpool_import_profiles", "carpool_location_cache"];
const carpoolRows = carpoolTables.reduce((total, table) => total + fixture.tables[table].length, 0);
const moduleKeyed = ["platform_module_epochs", "platform_modules", "platform_module_assignments", "platform_module_setup_progress"];
const carpoolState = (db: BackupDatabase) => moduleKeyed.reduce((total, table) => total + db.count(`SELECT COUNT(*) AS n FROM ${table} WHERE module_id='carpool'`), 0)
  + carpoolTables.reduce((total, table) => total + db.count(`SELECT COUNT(*) AS n FROM ${table}`), 0);
const schema41 = () => { const legacy = structuredClone(fixture); legacy.schemaVersion = 41; delete legacy.externalModules; return legacy; };

test("Carpool is no longer a first-party module, and its frozen definitions match what Core recorded while it was", () => {
  assert.equal(bundledModuleRegistry.get("carpool"), undefined);
  const carpool = extractedModules.find((module) => module.id === "carpool")!;
  const json = JSON.stringify(carpool.catalogDefinition);
  assert.equal(json, recordedCatalog.json);
  assert.equal(createHash("sha256").update(json).digest("hex"), recordedCatalog.sha);
  assert.deepEqual(carpool.tables.map((table) => table.name), carpoolTables);
  assert.deepEqual(fixture.ownership.modules.find((module: { id: string }) => module.id === "carpool"), { id: "carpool", contractVersion: 1, backupVersion: 1, tables: carpoolTables, sharedFields: [], transientAuthority: [] });
});

test("a historical backup holding Carpool data is refused without the plugin until the data is explicitly discarded", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  db.raw.exec("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) VALUES ('kept','primary','900','Kept','Member','2026-01-01','2026-01-01')");
  for (const backup of [fixture, schema41()]) {
    const refused = await client.restore(backup);
    assert.equal(refused.status, 409);
    const body = await refused.json() as Record<string, any>;
    assert.equal(body.code, "module-restore-refused"); assert.equal(body.reason, "unavailable-modules");
    assert.deepEqual(body.modules, [{ id: "carpool", label: "Carpool", status: "missing", requiredBackupVersion: 1, installedBackupVersion: null, requiredContractVersion: 1, installedContractVersion: null, source: null, commit: null, rows: carpoolRows }]);
    assert.deepEqual(body.optOut, { available: true, excludeModules: ["carpool"] });
    assert.match(body.details[0], /Carpool \(carpool\) is not installed/);
  }
  assert.equal(db.batches, 0, "refusal happens before any write");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM members WHERE id='kept'"), 1);

  const discarded = await client.restore(fixture, { excludeModules: ["carpool"] });
  assert.equal(discarded.status, 200, await discarded.clone().text());
  const body = await discarded.json() as Record<string, any>;
  assert.deepEqual(body.excludedModules, [{ id: "carpool", label: "Carpool", status: "missing", backupVersion: 1, source: null, commit: null, rows: carpoolRows }]);
  assert.deepEqual(body.recovery, { revokedKiosks: 1, invalidatedPairingCodes: 1, pausedProviderOperations: 0 });
  assert.equal(carpoolState(db), 0, "discarded Carpool restores absent: no lifecycle, assignments, setup progress or rows");
  assert.deepEqual(db.rows("SELECT id FROM members ORDER BY id"), fixture.tables.members.map((row: { id: string }) => ({ id: row.id })).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)));
  assert.deepEqual(db.rows("SELECT module_id, capabilities_json FROM platform_module_assignments"), [{ module_id: "attendance", capabilities_json: '["attendance.manage"]' }]);
  const audit = JSON.parse(String(db.rows<{ metadata_json: string }>("SELECT metadata_json FROM audit_log WHERE action='data.backup_restored'")[0]!.metadata_json));
  assert.deepEqual(audit.excludedModules, body.excludedModules);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM kiosks WHERE active=1"), 0);
});

test("a historical backup with an unused Carpool restores without the plugin and without a confirmation", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  const unused = structuredClone(fixture);
  for (const table of carpoolTables) unused.tables[table] = [];
  unused.tables.platform_modules = unused.tables.platform_modules.map((row: Record<string, unknown>) => row.module_id === "carpool" ? { ...row, phase: "disabled", setup_complete: 0 } : row);
  unused.tables.platform_module_setup_progress = unused.tables.platform_module_setup_progress.filter((row: Record<string, unknown>) => row.module_id !== "carpool");
  unused.tables.platform_module_assignments = unused.tables.platform_module_assignments.filter((row: Record<string, unknown>) => row.module_id !== "carpool");
  const restored = await client.restore(unused); assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal("excludedModules" in (await restored.json() as object), false);
  assert.equal(carpoolState(db), 0);
  // Any Carpool state still makes the restore an explicit decision.
  for (const change of [(backup: Backup) => { backup.tables.carpool_import_profiles = fixture.tables.carpool_import_profiles; }, (backup: Backup) => { backup.tables.platform_modules = fixture.tables.platform_modules; }, (backup: Backup) => { backup.tables.platform_module_assignments = fixture.tables.platform_module_assignments; }]) {
    const used = structuredClone(unused); change(used);
    assert.equal((await client.restore(used)).status, 409);
  }
});

test("historical Carpool ownership and placement are still checked exactly", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  const ownership = structuredClone(fixture); ownership.ownership.modules = ownership.ownership.modules.filter((module: { id: string }) => module.id !== "carpool");
  const missingTable = structuredClone(fixture); delete missingTable.tables.carpool_people;
  const badRow = structuredClone(fixture); badRow.tables.carpool_plans[0].title = { nested: true };
  const duplicate = structuredClone(fixture); duplicate.externalModules = [{ id: "carpool", label: "Carpool", contractVersion: 1, backupVersion: 2, source: null, commit: null, tables: {} }];
  const unknown = structuredClone(fixture); unknown.schemaVersion = 43; unknown.ownership.modules = unknown.ownership.modules.filter((module: { id: string }) => module.id !== "carpool");
  for (const backup of [ownership, missingTable, badRow, duplicate, unknown]) assert.equal((await client.restore(backup, { excludeModules: ["carpool"] })).status, 400);
  assert.equal(db.batches, 0);
});

test("without the plugin, Carpool lifecycle state stays out of new backups and retained data is listed and deleted from the frozen definition", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close());
  // An installation upgraded straight past the extraction: Carpool enabled with data, and no installed-module catalog entry.
  db.raw.exec(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','carpool',3);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','carpool',1,3,'enabled',1,1);
    INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES ('primary','carpool','workspace',1,'completed','2026-03-01T00:00:00.000Z','admin');
    INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ('primary','operator','carpool','["carpool.manage"]');
    INSERT INTO carpool_settings VALUES('primary',20,6,2,'2026-03-01T00:00:00Z'); INSERT INTO carpool_geocoding_credentials VALUES('primary','synthetic-encrypted-key','synthetic-iv',0);
    INSERT INTO carpool_plans(installation_id,id,title,created_at,updated_at) VALUES('primary','retained-plan','Synthetic retained plan','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z');
    INSERT INTO carpool_people(installation_id,plan_id,id,display_name,outbound_status,return_status,created_at,updated_at) VALUES('primary','retained-plan','retained-person','Synthetic Person','arranged','arranged','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z');
    INSERT INTO carpool_location_resolution VALUES('primary','retained-plan','synthetic-input','complete',NULL,NULL,NULL);`);

  // Backups contain no Carpool state: this build has no adapter for its data and could not restore its lifecycle rows.
  const client = backupClient(worker, db);
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 45); assert.deepEqual(backup.externalModules, []);
  for (const table of moduleKeyed) assert.equal(backup.tables[table].some((row: Record<string, unknown>) => row.module_id === "carpool"), false, table);
  assert.doesNotMatch(JSON.stringify(backup), /carpool|synthetic-encrypted-key/i);

  // Settings reconciles first, records the frozen first-party definition, and lists Carpool as no longer installed.
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "PUT") => {
    const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
    const response = await worker.fetch(new Request(`https://fixture.test${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }), { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  let modules = await call("/platform/modules");
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  const listed = modules.body.modules.find((module: { id: string }) => module.id === "carpool");
  // The dashboard accepts the snapshot, so a removed plugin never makes the rest of the workspace unverifiable.
  assert.equal(readModuleSnapshot(modules.body).modules.find((module) => module.id === "carpool")?.unavailable, "removed");
  assert.deepEqual({ unavailable: listed.unavailable, phase: listed.phase, enabled: listed.enabled, label: listed.label, data: listed.deletion.data }, { unavailable: "removed", phase: "enabled", enabled: true, label: "Carpool", data: JSON.parse(recordedCatalog.json).deletedData });
  assert.deepEqual(db.rows("SELECT origin, installed, definition_sha256 FROM platform_module_catalog WHERE module_id='carpool'"), [{ origin: "first-party", installed: 0, definition_sha256: recordedCatalog.sha }]);
  assert.equal((await reconcileInstalledModules(db as never)).changed, false, "the definition is recorded once");

  // It cannot be newly enabled, only turned off; its data is then deleted with the steps it had as a first-party module.
  modules = await call("/admin/modules", { enabled: ["attendance"], revision: modules.body.revision, confirmDisable: [{ moduleId: "carpool", generation: 3 }] });
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  assert.equal(modules.body.modules.find((module: { id: string }) => module.id === "carpool").phase, "retained");
  db.raw.exec("UPDATE platform_modules SET disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z' WHERE module_id='carpool'");
  for (let pass = 0; pass < 20 && db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='carpool' AND phase='deleted'") === 0; pass += 1) await runModuleCleanup(db as never);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='carpool' AND phase='deleted'"), 1);
  for (const table of [...carpoolTables, "carpool_geocoding_credentials", "carpool_location_resolution"]) assert.equal(db.count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_setup_progress WHERE module_id='carpool'") + db.count("SELECT COUNT(*) AS n FROM platform_module_assignments WHERE module_id='carpool'"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_setup_progress WHERE module_id='attendance'"), 3);
  modules = await call("/platform/modules");
  assert.equal(modules.body.modules.some((module: { id: string }) => module.id === "carpool"), false, "a deleted module without code is no longer listed");
});

test("a catalog entry recorded while Carpool was first-party is marked removed when Core no longer ships it", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close());
  db.raw.exec(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','carpool',1);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,disabled_at,delete_after) VALUES ('primary','carpool',1,1,'retained',1,0,'2026-03-01T00:00:00.000Z','2026-03-08T00:00:00.000Z');`);
  db.raw.prepare("INSERT INTO platform_module_catalog(installation_id,module_id,origin,source,source_commit,contract_version,definition_json,definition_sha256,installed,recorded_at) VALUES ('primary','carpool','first-party',NULL,NULL,1,?,?,1,'2026-03-01T00:00:00.000Z')").run(recordedCatalog.json, recordedCatalog.sha);
  assert.equal((await reconcileInstalledModules(db as never)).changed, true);
  assert.deepEqual(db.rows("SELECT origin, installed, definition_sha256 FROM platform_module_catalog WHERE module_id='carpool'"), [{ origin: "first-party", installed: 0, definition_sha256: recordedCatalog.sha }]);
});

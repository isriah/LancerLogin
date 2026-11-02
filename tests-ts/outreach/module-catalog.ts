// quick-check: covers apps/api/migrations/**
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileInstalledModules } from "../../apps/api/src/module-catalog.ts";
import { runModuleCleanup } from "../../apps/api/src/module-cleanup.ts";
import { ModuleRegistrationIncomplete, configureModulePlatform, readModulePlatformSnapshot } from "../../apps/api/src/module-platform.ts";
import type { ModuleMigrationPackage } from "../../apps/api/src/module-migrations.ts";
import { TestD1Database } from "../fixtures/d1-database.ts";

class Database extends TestD1Database {
  queries = 0;
  constructor() {
    // Core migrations are recorded as applied, as D1 records them, so official Outreach can adopt its historical tables.
    super({ recordMigrations: true, seed: `INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-26','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-10-26');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO platform_module_administration VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1),('primary','hour-tracking',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor)
        VALUES('primary','attendance',1,1,'disabled',2,0,0),('primary','hour-tracking',1,1,'disabled',1,0,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','admin',0);
      INSERT INTO platform_module_assignment_revisions VALUES('primary','admin',0);` });
  }
  override prepare(sql: string) { this.queries += 1; return super.prepare(sql); }
  count(sql: string) { return Number((this.sqlite.prepare(sql).get() as { n: number }).n); }
}

const legacyDefinition = JSON.stringify({
  label: "Legacy plugin", description: "A plugin whose code was removed.", dependencies: [], tables: ["legacy_records"], deletedData: ["Legacy records"],
  cleanup: [{ kind: "delete", table: "legacy_records" }, { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["legacy"] }, { kind: "assignments" }],
});

function installRemovedPlugin(database: Database, phase: "enabled" | "retained", definition = legacyDefinition) {
  database.sqlite.exec(`CREATE TABLE legacy_records(installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(installation_id,id));
    INSERT INTO legacy_records VALUES('primary','one'),('primary','two');
    INSERT INTO platform_module_epochs VALUES('primary','legacy',1);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,disabled_at,delete_after,deletion_cursor)
      VALUES('primary','legacy',1,1,'${phase}',1,1,${phase === "retained" ? "'2026-01-01T00:00:00.000Z','2026-01-08T00:00:00.000Z'" : "NULL,NULL"},0);`);
  database.sqlite.prepare(`INSERT INTO platform_module_catalog(installation_id,module_id,origin,source,source_commit,contract_version,definition_json,definition_sha256,installed,recorded_at)
    VALUES('primary','legacy','external','https://example.test/legacy.git','${"a".repeat(40)}',1,?,?,1,'2026-01-01T00:00:00.000Z')`).run(definition, "b".repeat(64));
}

test("reconciliation records installed module definitions once and then reads only", async () => {
  const database = new Database();
  try {
    assert.deepEqual(await reconcileInstalledModules(database), { changed: true, failures: [] });
    const rows = database.sqlite.prepare("SELECT module_id AS id,origin,installed,json_extract(definition_json,'$.label') AS label FROM platform_module_catalog ORDER BY module_id").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: "attendance", origin: "first-party", installed: 1, label: "Attendance" },
      // A module that moved into a plugin is recorded as removed with its frozen first-party definition (extracted-modules.ts).
      { id: "carpool", origin: "first-party", installed: 0, label: "Carpool" },
      // Official Outreach is an external plugin that adopted its historical Core tables.
      { id: "hour-tracking", origin: "external", installed: 1, label: "Outreach Participation" },
    ]);
    database.queries = 0;
    assert.deepEqual(await reconcileInstalledModules(database), { changed: false, failures: [] });
    assert.equal(database.queries, 1);
  } finally { database.close(); }
});

test("a module installed after setup is registered as disabled before its first snapshot", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("DELETE FROM platform_modules WHERE module_id='hour-tracking'; DELETE FROM platform_module_epochs WHERE module_id='hour-tracking'");
    await assert.rejects(readModulePlatformSnapshot(database, "admin"), ModuleRegistrationIncomplete);
    await reconcileInstalledModules(database);
    const outreach = (await readModulePlatformSnapshot(database, "admin")).modules.find((module) => module.id === "hour-tracking");
    assert.equal(outreach?.phase, "disabled"); assert.equal(outreach?.generation, 1); assert.equal(outreach?.unavailable, undefined);
  } finally { database.close(); }
});

test("a removed plugin stays visible, can be disabled, and its retained data is deleted from the recorded definition", async () => {
  const database = new Database();
  try {
    installRemovedPlugin(database, "enabled");
    await reconcileInstalledModules(database);
    assert.equal(database.count("SELECT installed AS n FROM platform_module_catalog WHERE module_id='legacy'"), 0);
    let snapshot = await readModulePlatformSnapshot(database, "admin");
    const legacy = snapshot.modules.find((module) => module.id === "legacy");
    assert.equal(legacy?.unavailable, "removed"); assert.equal(legacy?.label, "Legacy plugin"); assert.equal(legacy?.enabled, true);
    assert.deepEqual(legacy?.effectiveCapabilities, []); assert.deepEqual(legacy?.navigation, []); assert.deepEqual(legacy?.deletion.data, ["Legacy records"]);
    assert.deepEqual(snapshot.capabilities, []);
    await assert.rejects(configureModulePlatform(database, "admin", { enabled: [], revision: snapshot.revision }), /confirm the current Legacy plugin generation/);
    snapshot = await configureModulePlatform(database, "admin", { enabled: ["legacy", "hour-tracking"], revision: snapshot.revision });
    assert.equal(snapshot.modules.find((module) => module.id === "legacy")?.phase, "enabled"); assert.equal(snapshot.modules.find((module) => module.id === "hour-tracking")?.phase, "enabled");
    snapshot = await configureModulePlatform(database, "admin", { enabled: ["legacy"], revision: snapshot.revision, confirmDisable: [{ moduleId: "hour-tracking", generation: 1 }] });
    snapshot = await configureModulePlatform(database, "admin", { enabled: [], revision: snapshot.revision, confirmDisable: [{ moduleId: "legacy", generation: 1 }] });
    await assert.rejects(configureModulePlatform(database, "admin", { enabled: ["legacy"], revision: snapshot.revision }), /Select available modules/);
    assert.equal(snapshot.modules.find((module) => module.id === "legacy")?.phase, "retained");
    // The cleanup guard compares deadlines with the database clock, so move the retention window into the past.
    database.sqlite.exec("UPDATE platform_modules SET disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z' WHERE module_id='legacy'");
    const deadline = new Date();
    const statuses: string[] = [];
    for (let pass = 0; pass < 10; pass += 1) { const result = await runModuleCleanup(database, deadline); statuses.push(result.status); if (result.status === "deleted" || result.status === "idle") break; }
    assert.equal(statuses.at(-1), "deleted");
    assert.equal(database.count("SELECT COUNT(*) AS n FROM legacy_records"), 0);
    assert.equal(database.sqlite.prepare("SELECT phase FROM platform_modules WHERE module_id='legacy'").get()?.phase, "deleted");
    assert.equal((await readModulePlatformSnapshot(database, "admin")).modules.some((module) => module.id === "legacy"), false);
  } finally { database.close(); }
});

const extraMigration = (statements: string[]): ModuleMigrationPackage => ({ moduleId: "hour-tracking", tablePrefix: "hours_", migrations: [{ sequence: 1, name: "0001_extra_records.sql", sha256: "c".repeat(64), statements }] });

test("reconciliation applies pending module migrations through the ledger before registering the module", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("DELETE FROM platform_modules WHERE module_id='hour-tracking'; DELETE FROM platform_module_epochs WHERE module_id='hour-tracking'");
    const migrations = [extraMigration(["CREATE TABLE hours_extra_records(installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(installation_id,id))"])];
    const sources = { "hour-tracking": { source: "https://example.test/owner/outreach.git", commit: "d".repeat(40) } };
    assert.deepEqual(await reconcileInstalledModules(database, new Date(), { migrations, sources }), { changed: true, failures: [] });
    assert.equal(database.count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='hours_extra_records'"), 1);
    assert.deepEqual({ ...database.sqlite.prepare("SELECT module_id,sequence,name FROM platform_module_migrations").get() }, { module_id: "hour-tracking", sequence: 1, name: "0001_extra_records.sql" });
    assert.deepEqual({ ...database.sqlite.prepare("SELECT source,source_commit,json_extract(definition_json,'$.migrationHead') AS head FROM platform_module_catalog WHERE module_id='hour-tracking'").get() }, { source: sources["hour-tracking"].source, source_commit: sources["hour-tracking"].commit, head: "c".repeat(64) });
    assert.equal((await readModulePlatformSnapshot(database, "admin")).modules.find((module) => module.id === "hour-tracking")?.phase, "disabled");
    database.queries = 0;
    assert.deepEqual(await reconcileInstalledModules(database, new Date(), { migrations, sources }), { changed: false, failures: [] });
    assert.equal(database.queries, 1);
  } finally { database.close(); }
});

test("an upgrade that skips a required earlier release applies nothing, keeps the recorded definition and reports why", async () => {
  const database = new Database();
  try {
    const sources = { "hour-tracking": { source: "https://example.test/owner/outreach.git", commit: "d".repeat(40) } };
    const table = (name: string) => `CREATE TABLE ${name}(installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(installation_id,id))`;
    const first = { sequence: 1, name: "0001_extra_records.sql", sha256: "c".repeat(64), statements: [table("hours_extra_records")] };
    // The second release moves data out of hours_extra_records at run time; the third drops the table.
    const second = { sequence: 2, name: "0002_moved_records.sql", sha256: "d".repeat(64), statements: [table("hours_moved_records")] };
    const third = { sequence: 3, name: "0003_drop_extra_records.sql", sha256: "e".repeat(64), statements: ["DROP TABLE hours_extra_records"] };
    const release = (migrations: ModuleMigrationPackage["migrations"], upgradeRequiresMigrations?: string[]): ModuleMigrationPackage[] => [{ moduleId: "hour-tracking", tablePrefix: "hours_", migrations, ...(upgradeRequiresMigrations ? { upgradeRequiresMigrations } : {}) }];
    const latest = release([first, second, third], ["0002_moved_records.sql"]);
    const recorded = () => ({ ...database.sqlite.prepare("SELECT definition_sha256 AS sha, json_extract(definition_json,'$.migrationHead') AS head FROM platform_module_catalog WHERE module_id='hour-tracking'").get() });
    const ledger = () => database.sqlite.prepare("SELECT name FROM platform_module_migrations WHERE module_id='hour-tracking' ORDER BY sequence").all().map((row) => row.name);
    const tables = () => database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hours_extra_records','hours_moved_records') ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(await reconcileInstalledModules(database, new Date(), { migrations: release([first]), sources }), { changed: true, failures: [] });
    database.sqlite.exec("UPDATE platform_modules SET phase='enabled', setup_complete=1 WHERE module_id='hour-tracking'");
    const before = recorded();
    assert.equal(before.head, "c".repeat(64));

    // The installation skips the second release: none of the pending migrations run and the old definition stays recorded.
    const result = await reconcileInstalledModules(database, new Date(), { migrations: latest, sources });
    assert.equal(result.changed, false); assert.equal(result.failures.length, 1); assert.equal(result.failures[0]?.moduleId, "hour-tracking");
    assert.match(result.failures[0]!.message, /^This version of .+ can't be installed as an upgrade yet\. Install an earlier .+ release first: this installation hasn't applied the .+ migration 0002_moved_records\.sql \(it has applied up to 0001_extra_records\.sql\)\./);
    assert.deepEqual(ledger(), ["0001_extra_records.sql"]);
    assert.deepEqual(tables(), ["hours_extra_records"]);
    assert.deepEqual(recorded(), before);
    // The module keeps its lifecycle state; the failure retries on later passes until the path is fixed.
    assert.equal((await readModulePlatformSnapshot(database, "admin")).modules.find((module) => module.id === "hour-tracking")?.phase, "enabled");
    assert.equal((await reconcileInstalledModules(database, new Date(), { migrations: latest, sources })).failures.length, 1);

    // Installing the second release first, then the latest, applies everything in order.
    assert.deepEqual(await reconcileInstalledModules(database, new Date(), { migrations: release([first, second]), sources }), { changed: true, failures: [] });
    assert.deepEqual(await reconcileInstalledModules(database, new Date(), { migrations: latest, sources }), { changed: true, failures: [] });
    assert.deepEqual(ledger(), ["0001_extra_records.sql", "0002_moved_records.sql", "0003_drop_extra_records.sql"]);
    assert.deepEqual(tables(), ["hours_moved_records"]);
    assert.equal(recorded().head, "e".repeat(64));
  } finally { database.close(); }
});

test("a fresh install applies a release with an upgrade requirement directly", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("DELETE FROM platform_modules WHERE module_id='hour-tracking'; DELETE FROM platform_module_epochs WHERE module_id='hour-tracking'");
    const table = (name: string) => `CREATE TABLE ${name}(installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(installation_id,id))`;
    const migrations: ModuleMigrationPackage[] = [{ moduleId: "hour-tracking", tablePrefix: "hours_", upgradeRequiresMigrations: ["0001_extra_records.sql"], migrations: [
      { sequence: 1, name: "0001_extra_records.sql", sha256: "c".repeat(64), statements: [table("hours_extra_records")] },
      { sequence: 2, name: "0002_drop_extra_records.sql", sha256: "d".repeat(64), statements: ["DROP TABLE hours_extra_records"] },
    ] }];
    assert.deepEqual(await reconcileInstalledModules(database, new Date(), { migrations }), { changed: true, failures: [] });
    assert.equal(database.count("SELECT COUNT(*) AS n FROM platform_module_migrations WHERE module_id='hour-tracking'"), 2);
    assert.equal((await readModulePlatformSnapshot(database, "admin")).modules.find((module) => module.id === "hour-tracking")?.phase, "disabled");
  } finally { database.close(); }
});

test("a module whose migration fails stays unregistered while other modules keep working", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("DELETE FROM platform_modules WHERE module_id='hour-tracking'; DELETE FROM platform_module_epochs WHERE module_id='hour-tracking'");
    const migrations = [extraMigration(["CREATE TABLE hours_entries(installation_id TEXT)"])];
    const result = await reconcileInstalledModules(database, new Date(), { migrations });
    assert.equal(result.failures.length, 1); assert.equal(result.failures[0]?.moduleId, "hour-tracking"); assert.match(result.failures[0]!.message, /0001_extra_records\.sql failed/);
    assert.equal(database.count("SELECT COUNT(*) AS n FROM platform_module_migrations"), 0);
    assert.equal(database.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='hour-tracking'"), 0);
    await assert.rejects(readModulePlatformSnapshot(database, "admin"), ModuleRegistrationIncomplete);
    const shown = await readModulePlatformSnapshot(database, "admin", { unregistered: "show" });
    const outreach = shown.modules.find((module) => module.id === "hour-tracking");
    assert.equal(outreach?.unavailable, "setup-incomplete"); assert.equal(outreach?.enabled, false); assert.match(String(outreach?.deletion.cleanupFailure), /retries automatically/);
    await assert.rejects(configureModulePlatform(database, "admin", { enabled: ["hour-tracking"], revision: shown.revision }), /still being set up/);
    const saved = await configureModulePlatform(database, "admin", { enabled: ["attendance"], revision: shown.revision });
    assert.equal(saved.modules.find((module) => module.id === "attendance")?.phase, "enabled");
    assert.equal(saved.modules.find((module) => module.id === "hour-tracking")?.unavailable, "setup-incomplete");
  } finally { database.close(); }
});

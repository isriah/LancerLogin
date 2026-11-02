// Module catalog reconciliation cases that need no plugin, run without composing one. The Outreach-dependent cases are in outreach/module-catalog.ts (outreach-module-catalog.test.ts).
// quick-check: covers apps/api/migrations/**
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileInstalledModules } from "../apps/api/src/module-catalog.ts";
import { runModuleCleanup } from "../apps/api/src/module-cleanup.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";

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

test("reconciliation does not register modules before installation setup", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("DELETE FROM installations");
    assert.deepEqual(await reconcileInstalledModules(database), { changed: false, failures: [], unconfigured: true });
    assert.equal(database.count("SELECT COUNT(*) AS n FROM platform_module_catalog"), 0);
  } finally { database.close(); }
});

test("an unreadable recorded definition marks cleanup for retry instead of failing the maintenance pass", async () => {
  const database = new Database();
  try {
    installRemovedPlugin(database, "retained", JSON.stringify({ label: "Broken", description: "", dependencies: [], tables: [], deletedData: [], cleanup: [{ kind: "delete", table: "bad table" }] }));
    await reconcileInstalledModules(database);
    assert.deepEqual(await runModuleCleanup(database, new Date("2026-02-01T00:00:00.000Z")), { status: "retry-required" });
    assert.equal(database.sqlite.prepare("SELECT cleanup_failure AS failure FROM platform_modules WHERE module_id='legacy'").get()?.failure, "retry-required");
    assert.equal(database.count("SELECT COUNT(*) AS n FROM legacy_records"), 2);
  } finally { database.close(); }
});

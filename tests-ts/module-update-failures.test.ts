// quick-check: covers apps/api/migrations/**
// A module whose migrations are refused or fail is recorded for Settings > Modules, and the record clears once the module
// reconciles. Runs on Core alone: the built-in Attendance module stands in for a plugin with a synthetic migration package.
import test from "node:test";
import assert from "node:assert/strict";
import { moduleUpdateFailureFor, readModuleUpdateFailures, reconcileInstalledModules } from "../apps/api/src/module-catalog.ts";
import { ModuleMigrationError, type ModuleMigrationPackage } from "../apps/api/src/module-migrations.ts";
import { pluginManagementState } from "../apps/api/src/plugin-selection.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";


class Database extends TestD1Database {
  constructor() {
    super({ recordMigrations: true, seed: `INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-26','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','synthetic-admin','admin','2026-10-26');
      INSERT INTO platform_module_administration VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs VALUES('primary',0);` });
  }
  rows(sql: string) { return this.sqlite.prepare(sql).all().map((row) => ({ ...row })); }
}

const table = (name: string) => `CREATE TABLE ${name}(installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, PRIMARY KEY(installation_id,id))`;
const first = { sequence: 1, name: "0001_synthetic_records.sql", sha256: "c".repeat(64), statements: [table("synthetic_records")] };
const second = { sequence: 2, name: "0002_synthetic_moved.sql", sha256: "d".repeat(64), statements: [table("synthetic_moved")] };
const third = { sequence: 3, name: "0003_synthetic_drop.sql", sha256: "e".repeat(64), statements: ["DROP TABLE synthetic_records"] };
const release = (migrations: ModuleMigrationPackage["migrations"], upgradeRequiresMigrations?: string[]): ModuleMigrationPackage[] =>
  [{ moduleId: "attendance", tablePrefix: "synthetic_", migrations, ...(upgradeRequiresMigrations ? { upgradeRequiresMigrations } : {}) }];
const failureRows = (db: Database) => db.rows("SELECT module_id, code, first_failed_at, last_tried_at FROM platform_module_update_failures");

test("a refused upgrade is recorded with its plain-English message and cleared once reconciliation succeeds", async () => {
  const db = new Database();
  assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-01T10:00:00.000Z"), { migrations: release([first]) }), { changed: true, failures: [] });
  assert.deepEqual(failureRows(db), []);

  // The build skips the release that adds 0002: refused, nothing applied, and recorded for Admins.
  const latest = release([first, second, third], ["0002_synthetic_moved.sql"]);
  const refused = await reconcileInstalledModules(db, new Date("2026-11-01T11:00:00.000Z"), { migrations: latest });
  assert.equal(refused.changed, false); assert.equal(refused.failures.length, 1);
  assert.deepEqual(failureRows(db), [{ module_id: "attendance", code: "module_migration_upgrade_path_required", first_failed_at: "2026-11-01T11:00:00.000Z", last_tried_at: "2026-11-01T11:00:00.000Z" }]);
  const [shown] = await readModuleUpdateFailures(db);
  assert.equal(shown?.message, refused.failures[0]!.message);
  assert.match(shown!.message, /can't be installed as an upgrade yet\. Install an earlier Attendance release first: .*0002_synthetic_moved\.sql \(it has applied up to 0001_synthetic_records\.sql\)/);

  // A later attempt with the same refusal keeps when it started and updates when it was last tried.
  await reconcileInstalledModules(db, new Date("2026-11-01T11:01:00.000Z"), { migrations: latest });
  assert.deepEqual(failureRows(db), [{ module_id: "attendance", code: "module_migration_upgrade_path_required", first_failed_at: "2026-11-01T11:00:00.000Z", last_tried_at: "2026-11-01T11:01:00.000Z" }]);

  // Settings > Modules reads it through the existing Admin plugin state.
  const state = await pluginManagementState({ DB: db } as never, { installed: {}, principal: { userId: "admin", role: "admin", expiresAt: 0 } as never, passwordAvailable: true, googleAvailable: false });
  assert.deepEqual(state.updateFailures.map((failure) => [failure.moduleId, failure.code, failure.lastTriedAt]), [["attendance", "module_migration_upgrade_path_required", "2026-11-01T11:01:00.000Z"]]);

  // Installing the missing release reconciles the module and clears the record.
  assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-01T12:00:00.000Z"), { migrations: release([first, second]) }), { changed: true, failures: [] });
  assert.deepEqual(failureRows(db), []);
  assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-01T12:05:00.000Z"), { migrations: latest }), { changed: true, failures: [] });
  assert.deepEqual(await readModuleUpdateFailures(db), []);
  db.sqlite.close();
});

test("other migration failures are recorded with a generic message, never the raw database error", async () => {
  const db = new Database();
  const broken = release([{ ...first, statements: ["CREATE TABLE synthetic_records(installation_id TEXT)", "CREATE TABLE synthetic_records(installation_id TEXT)"] }]);
  const result = await reconcileInstalledModules(db, new Date("2026-11-01T10:00:00.000Z"), { migrations: broken });
  assert.equal(result.failures.length, 1);
  const [failure] = await readModuleUpdateFailures(db);
  assert.equal(failure?.code, "module_migration_failed");
  assert.match(failure!.message, /^LancerLogin could not finish updating Attendance's database/);
  assert.doesNotMatch(failure!.message, /already exists|synthetic_records/);
  assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-01T10:05:00.000Z"), { migrations: release([first]) }), { changed: true, failures: [] });
  assert.deepEqual(failureRows(db), []);
  db.sqlite.close();
});

test("the recorded message keeps a refusal's explanation and replaces anything else", () => {
  assert.deepEqual(moduleUpdateFailureFor("Synthetic Notes", new ModuleMigrationError("module_migration_upgrade_path_required", "Install 1.1 first.")), { code: "module_migration_upgrade_path_required", message: "Install 1.1 first." });
  const other = moduleUpdateFailureFor("Synthetic Notes", new ModuleMigrationError("module_migration_hash_review_required", "Module x: applied 0001 has a different hash"));
  assert.equal(other.code, "module_migration_hash_review_required"); assert.match(other.message, /Synthetic Notes/); assert.doesNotMatch(other.message, /different hash/);
  assert.equal(moduleUpdateFailureFor("Synthetic Notes", new Error("D1_ERROR: boom")).code, "module_migration_failed");
});

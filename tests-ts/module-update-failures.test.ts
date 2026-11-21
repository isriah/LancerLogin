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
  /** Errors thrown by batches, so a test can say what an overlapping pass failed on. */
  readonly batchErrors: string[] = [];
  /** Passes are held after reading the module migration ledger until this many have read it (0: no holding). */
  ledgerReaders = 0;
  /** Make the next batch fail without running, as a dropped D1 request does. */
  failNextBatch = false;
  /** Run once, just before the next batch that records an update failure. */
  beforeFailureRecord: (() => Promise<unknown>) | undefined;
  private waiting: (() => void)[] = [];
  writes() { return Number((this.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n); }
  override prepare(sql: string) {
    const statement = super.prepare(sql);
    if (!this.ledgerReaders || !/FROM platform_module_migrations/.test(sql)) return statement;
    // Both passes read the ledger before either writes: the interleaving two Worker isolates produce on a deployment's
    // first requests. Held by a count, not a timer, so the test does not depend on timing.
    const hold = async <T>(read: Promise<T>) => {
      const result = await read;
      if (this.ledgerReaders) await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length >= this.ledgerReaders) { this.ledgerReaders = 0; for (const release of this.waiting.splice(0)) release(); }
      });
      return result;
    };
    return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { all: () => hold(bound.all()) }; } } as never;
  }
  override async batch(statements: Parameters<TestD1Database["batch"]>[0]) {
    if (this.failNextBatch) { this.failNextBatch = false; throw new Error("D1_ERROR: synthetic dropped request"); }
    const before = this.beforeFailureRecord;
    if (before && statements.some((statement) => /INSERT INTO platform_module_update_failures/.test((statement as unknown as { sql: string }).sql))) { this.beforeFailureRecord = undefined; await before(); }
    try { return await super.batch(statements); }
    catch (error) { this.batchErrors.push(error instanceof Error ? error.message : String(error)); throw error; }
  }
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

// A real update (2.0.0 to 2.1.0-beta.10) left a module_migration_failed record for a module whose migrations another pass
// had applied 130 ms earlier, and nothing ever deleted it. These tests hold two passes at the point that update reached:
// both have read the ledger and planned the same pending migrations before either writes.
for (const [title, statements, loserError] of [
  ["its own SQL", [table("synthetic_records")], /table synthetic_records already exists/],
  ["the ledger's primary key", [table("synthetic_records").replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")], /UNIQUE constraint failed: platform_module_migrations/],
] as const) {
  test(`two passes that start together both succeed when the second one's batch fails on ${title}`, async () => {
    const db = new Database();
    const migrations = release([{ ...first, statements: [...statements] }, second]);
    db.ledgerReaders = 2;
    const results = await Promise.all([
      reconcileInstalledModules(db, new Date("2026-11-20T16:02:17.646Z"), { migrations }),
      reconcileInstalledModules(db, new Date("2026-11-20T16:02:17.775Z"), { migrations }),
    ]);
    // The second pass's batch really did fail and roll back; that is not a failed migration.
    assert.equal(db.batchErrors.length, 1); assert.match(db.batchErrors[0]!, loserError);
    assert.deepEqual(results.map((result) => result.failures), [[], []]);
    assert.deepEqual(failureRows(db), []);
    assert.deepEqual(db.rows("SELECT sequence, name FROM platform_module_migrations WHERE module_id='attendance' ORDER BY sequence"), [{ sequence: 1, name: first.name }, { sequence: 2, name: second.name }]);
    assert.deepEqual(db.rows("SELECT name FROM sqlite_master WHERE name IN ('synthetic_records','synthetic_moved') ORDER BY name"), [{ name: "synthetic_moved" }, { name: "synthetic_records" }]);
    assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-20T16:03:00.000Z"), { migrations }), { changed: false, failures: [] });
    assert.deepEqual(failureRows(db), []);
    db.sqlite.close();
  });
}

test("a pass whose batch was lost records no failure once another pass has brought the module up to date", async () => {
  const db = new Database();
  const migrations = release([first]);
  // This pass's migration batch never reaches the database, and the ledger still shows the migration pending when it
  // looks again. Before it records that, another pass applies the migration and records the module.
  db.failNextBatch = true;
  db.beforeFailureRecord = () => reconcileInstalledModules(db, new Date("2026-11-20T16:02:17.646Z"), { migrations });
  const lost = await reconcileInstalledModules(db, new Date("2026-11-20T16:02:17.775Z"), { migrations });
  assert.equal(lost.failures.length, 1, "this pass did fail, so its isolate tries again");
  assert.deepEqual(failureRows(db), [], "but the module is up to date, so Admins are shown nothing");
  assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-20T16:03:17.775Z"), { migrations }), { changed: false, failures: [] });
  db.sqlite.close();
});

test("a failure record left for an up-to-date module is deleted by the next pass, at no cost when there is none", async () => {
  const db = new Database();
  const migrations = release([first]);
  await reconcileInstalledModules(db, new Date("2026-11-20T16:02:17.646Z"), { migrations });
  // The record installations already hold from the overlapping passes above.
  const stale = moduleUpdateFailureFor("Attendance", new Error("duplicate column name"));
  db.sqlite.prepare("INSERT INTO platform_module_update_failures VALUES('primary','attendance',?,?,?,?)").run(stale.code, stale.message, "2026-11-20T16:02:17.775Z", "2026-11-20T16:02:17.775Z");
  assert.equal((await readModuleUpdateFailures(db)).length, 1);

  let reads = db.reads;
  assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-20T16:05:00.000Z"), { migrations }), { changed: false, failures: [] });
  assert.equal(db.reads - reads, 1, "learned from the catalog read every pass already makes");
  assert.deepEqual(failureRows(db), []);

  // Steady state afterwards: the same single read, and nothing written.
  reads = db.reads; const writes = db.writes();
  assert.deepEqual(await reconcileInstalledModules(db, new Date("2026-11-20T16:10:00.000Z"), { migrations }), { changed: false, failures: [] });
  assert.equal(db.reads - reads, 1); assert.equal(db.writes(), writes);
  assert.equal(db.batchErrors.length, 0);
  db.sqlite.close();
});

test("a migration that keeps failing keeps its record, with the latest attempt", async () => {
  const db = new Database();
  const broken = release([first, { ...second, statements: ["CREATE TABLE synthetic_records(installation_id TEXT)"] }]);
  assert.equal((await reconcileInstalledModules(db, new Date("2026-11-01T10:00:00.000Z"), { migrations: broken })).failures.length, 1);
  assert.equal((await reconcileInstalledModules(db, new Date("2026-11-01T10:01:00.000Z"), { migrations: broken })).failures.length, 1);
  assert.deepEqual(failureRows(db), [{ module_id: "attendance", code: "module_migration_failed", first_failed_at: "2026-11-01T10:00:00.000Z", last_tried_at: "2026-11-01T10:01:00.000Z" }]);
  // The first migration stayed applied and recorded; only the broken one is pending.
  assert.deepEqual(db.rows("SELECT name FROM platform_module_migrations WHERE module_id='attendance'"), [{ name: first.name }]);
  db.sqlite.close();
});

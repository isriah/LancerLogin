// Shared in-memory D1 for TypeScript tests: every Core migration, then optional module migrations through the
// module migration runner. Without `modules` the database matches what tests have always built inline.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { D1Database, D1Result, D1Statement } from "../../apps/api/src/d1-usage.ts";
import { adoptedBaselineName, applyModuleMigrations, d1ModuleMigrationExecutor, loadModuleMigrationPackage, moduleMigrationLedgerTable, planModuleMigrations, type MigrationDirectoryReader, type MigrationFile, type ModuleMigrationLedgerEntry, type ModuleMigrationPackage } from "../../apps/api/src/module-migrations.ts";

export const coreMigrationDirectory = fileURLToPath(new URL("../../apps/api/migrations/", import.meta.url));
export const nodeMigrationDirectoryReader: MigrationDirectoryReader = { list: (directory) => readdir(directory), read: (path) => readFile(path, "utf8") };

export function readCoreMigrations(): MigrationFile[] {
  return readdirSync(coreMigrationDirectory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort().map((name) => ({ name, content: readFileSync(`${coreMigrationDirectory}/${name}`, "utf8") }));
}

/** Record Core migrations in d1_migrations, as D1 does once it has applied them, so adopted baselines can be checked. */
export function recordCoreMigrations(sqlite: DatabaseSync, names: readonly string[] = readCoreMigrations().map((file) => file.name)) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const insert = sqlite.prepare("INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)");
  for (const name of names) insert.run(name);
}

/**
 * Apply composed modules' migration packages to a synchronous fixture database right after Core migrations, as the Worker's
 * module reconciliation does on an installation's first request: the runner's plan against the ledger, then each pending
 * migration's statements and its ledger row in one transaction (an adopted baseline records its row without SQL). Pass the
 * composed build's packages (`externalModuleMigrations`); an empty list, as in a Core build without plugins, changes nothing.
 * Returns the ledger the packages expect, for assertions that follow the composed plugin rather than a hard-coded list.
 */
export function applyComposedModuleMigrations(sqlite: DatabaseSync, packages: readonly ModuleMigrationPackage[], options: { readonly coreAppliedMigrations?: readonly string[]; readonly now?: string } = {}) {
  const coreApplied = options.coreAppliedMigrations ?? readCoreMigrations().map((file) => file.name);
  const now = options.now ?? new Date().toISOString();
  for (const pkg of packages) {
    const ledger = sqlite.prepare(`SELECT sequence, name, sha256 FROM ${moduleMigrationLedgerTable} WHERE module_id = ? ORDER BY sequence`).all(pkg.moduleId) as ModuleMigrationLedgerEntry[];
    for (const migration of planModuleMigrations(pkg, ledger, coreApplied).pending) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migration.statements) sqlite.exec(statement);
        sqlite.prepare(`INSERT INTO ${moduleMigrationLedgerTable} (module_id, sequence, name, sha256, applied_at) VALUES (?, ?, ?, ?, ?)`).run(pkg.moduleId, migration.sequence, migration.name, migration.sha256, now);
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  }
}

/** The ledger rows (sequence and name, in order) a module's migration package records once fully applied. */
export function expectedModuleLedger(pkg: ModuleMigrationPackage | undefined): { sequence: number; name: string }[] {
  if (!pkg) return [];
  return [...pkg.baseline ? [{ sequence: 0, name: adoptedBaselineName }] : [], ...pkg.migrations.map(({ sequence, name }) => ({ sequence, name }))];
}

/** A module whose migrations the runner applies after Core migrations. */
export type TestModuleMigrations = { readonly moduleId: string; readonly tablePrefix: string; readonly directory?: string; readonly adoptedCoreMigrations?: readonly string[] };

class Statement implements D1Statement {
  readonly database: DatabaseSync;
  readonly sql: string;
  values: unknown[] = [];
  constructor(database: DatabaseSync, sql: string) { this.database = database; this.sql = sql; }
  bind(...values: unknown[]) { const next = new Statement(this.database, this.sql); next.values = values; return next; }
  native(): StatementSync { return this.database.prepare(this.sql); }
  async first<T>() { return (this.native().get(...this.values as []) as T | undefined) ?? null; }
  async all<T>() { return { results: this.native().all(...this.values as []) as T[], meta: { changes: 0 } } as D1Result<T>; }
  async run() { const result = this.native().run(...this.values as []); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
  batchResult(): D1Result {
    const statement = this.native();
    if (/^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(this.sql)) return { success: true, results: statement.all(...this.values as []), meta: { changes: 0 } } as D1Result;
    const result = statement.run(...this.values as []);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

export class TestD1Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly coreMigrations: readonly MigrationFile[];
  constructor(coreMigrations = readCoreMigrations()) {
    this.coreMigrations = coreMigrations;
    for (const file of coreMigrations) this.sqlite.exec(file.content);
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  /** Atomic like a D1 batch: every statement commits or none does. */
  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => (statement as Statement).batchResult());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  /** Apply module migrations in order through the module migration runner. */
  async applyModuleMigrations(modules: readonly TestModuleMigrations[], now?: () => string) {
    const executor = d1ModuleMigrationExecutor(this);
    const applied: Record<string, readonly string[]> = {};
    for (const module of modules) {
      const pkg = await loadModuleMigrationPackage(nodeMigrationDirectoryReader, { ...module, coreMigrations: this.coreMigrations });
      applied[module.moduleId] = (await applyModuleMigrations(executor, pkg, { coreAppliedMigrations: this.coreMigrations.map((file) => file.name), now })).applied;
    }
    return applied;
  }
}

/** Build a Core database. Module migrations run only when `modules` is given explicitly. */
export async function createTestD1Database(options: { readonly modules?: readonly TestModuleMigrations[]; readonly now?: () => string } = {}) {
  const database = new TestD1Database();
  if (options.modules?.length) await database.applyModuleMigrations(options.modules, options.now);
  return database;
}

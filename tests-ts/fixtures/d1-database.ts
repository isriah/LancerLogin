// Shared in-memory D1 for TypeScript tests: every Core migration, then optional module migrations through the
// module migration runner. Without `modules` the database matches what tests have always built inline.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { D1Database, D1Result, D1Statement } from "../../apps/api/src/d1-usage.ts";
import { applyModuleMigrations, d1ModuleMigrationExecutor, loadModuleMigrationPackage, type MigrationDirectoryReader, type MigrationFile } from "../../apps/api/src/module-migrations.ts";

export const coreMigrationDirectory = fileURLToPath(new URL("../../apps/api/migrations/", import.meta.url));
export const nodeMigrationDirectoryReader: MigrationDirectoryReader = { list: (directory) => readdir(directory), read: (path) => readFile(path, "utf8") };

export function readCoreMigrations(): MigrationFile[] {
  return readdirSync(coreMigrationDirectory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort().map((name) => ({ name, content: readFileSync(`${coreMigrationDirectory}/${name}`, "utf8") }));
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

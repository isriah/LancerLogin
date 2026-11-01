// The migrated backup fixture database with D1 batch semantics for Worker route handlers and module reconciliation.
import { BackupDatabase } from "./backup-database.ts";
import { recordCoreMigrations } from "./d1-database.ts";

/** The migrated fixture database, with D1 batch semantics for route handlers: reads inside a batch return rows. */
export class PluginDatabase extends BackupDatabase {
  prepare(sql: string) {
    let values: unknown[] = []; const raw = this.raw;
    const statement = {
      sql,
      bind(...args: unknown[]) { values = args; return statement; },
      async first() { return raw.prepare(sql).get(...values as never[]) ?? null; },
      async all() { return { results: raw.prepare(sql).all(...values as never[]), meta: { changes: 0 } }; },
      async run() { const result = raw.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }
  // Batches run one at a time, as D1 serializes them; route handlers issue several concurrently.
  private pending: Promise<unknown> = Promise.resolve();
  batch(statements: { sql?: string; all(): Promise<unknown>; run(): Promise<unknown> }[]) {
    const result = this.pending.then(() => this.transaction(statements)); this.pending = result.catch(() => undefined); return result;
  }
  private async transaction(statements: { sql?: string; all(): Promise<unknown>; run(): Promise<unknown> }[]) {
    this.batches += 1; this.raw.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(/^\s*(?:SELECT|WITH)\b/i.test(statement.sql ?? "") ? await statement.all() : await statement.run()); this.raw.exec("COMMIT"); return results; }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
  /** Record every Core migration as applied, as D1 does, so adopted baselines can be checked. */
  recordCoreMigrations() { recordCoreMigrations(this.raw); }
}

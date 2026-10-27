// Migrated SQLite database with D1 batch semantics and a Core installation seed, for module lifecycle tests.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { D1Database, D1Result, D1Statement } from "../../apps/api/src/d1-usage.ts";

export class Statement implements D1Statement {
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

export class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor(setupComplete = false) {
    for (const file of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-09-28','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES
        ('admin','primary','admin','admin','2026-09-28'),('operator','primary','operator','operator','2026-09-28');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO platform_module_administration VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1),('primary','hour-tracking',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor)
        VALUES('primary','attendance',1,1,'enabled',2,${setupComplete ? 1 : 0},0),
          ('primary','hour-tracking',1,1,'disabled',1,0,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','admin',0),('primary','operator',0);
      INSERT INTO platform_module_assignment_revisions VALUES('primary','admin',0),('primary','operator',0);
      INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','["attendance.manage"]');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from)
        VALUES('member','primary','1001','Synthetic','Member','2026-09-28','2026-09-28');
      INSERT INTO hours_entry_settings(installation_id) VALUES('primary');
      INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES
        ('primary','event','Event','event',1,'2026-09-28','2026-09-28'),
        ('primary','team-support','Team Support','team',1,'2026-09-28','2026-09-28'),
        ('primary','other-service','Other Service','task',1,'2026-09-28','2026-09-28');`);
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof Statement)) throw new Error("Unexpected test statement");
        return statement.batchResult();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}

export function request(path: string, method: string, body?: unknown) {
  return new Request(`https://synthetic.test${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

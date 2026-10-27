// Real SQLite database with every Core migration, for backup and restore tests through the Worker.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";

const migrations = new URL("../../apps/api/migrations/", import.meta.url);
export const sessionSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class BackupDatabase {
  readonly raw = new DatabaseSync(":memory:");
  batches = 0;
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) this.raw.exec(readFileSync(new URL(file, migrations), "utf8"));
    this.raw.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01T00:00:00.000Z','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01'),('operator','primary','operator','operator','2026-01-01');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) VALUES ('member','primary','001','Synthetic','Member','2026-01-01','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      INSERT INTO hours_entry_settings(installation_id) VALUES ('primary');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) SELECT installation_id,id,0 FROM users;
      INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) SELECT installation_id,id,0 FROM users;
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1),('primary','hour-tracking',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1),('primary','hour-tracking',1,1,'disabled',1,0);
      INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) SELECT 'primary','attendance',value,2,'completed','2026-01-01T00:00:00.000Z','admin' FROM json_each('["rules","meeting","input"]');`);
  }
  prepare(sql: string) {
    let values: unknown[] = []; const raw = this.raw;
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async first() { return raw.prepare(sql).get(...values as never[]) ?? null; },
      async all() { return { results: raw.prepare(sql).all(...values as never[]) }; },
      async run() { const result = raw.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.batches += 1; this.raw.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.raw.exec("COMMIT"); return results; }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
  rows<T = Record<string, unknown>>(sql: string, ...values: unknown[]) { return this.raw.prepare(sql).all(...values as never[]).map((row) => ({ ...row })) as T[]; }
  count(sql: string, ...values: unknown[]) { return Number((this.raw.prepare(sql).get(...values as never[]) as { n: number }).n); }
}

type Fetcher = { fetch(request: Request, env: unknown): Promise<Response> };
export function backupClient(worker: Fetcher, db: BackupDatabase) {
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" };
  // A Worker isolate reconciles installed modules before its first request. Serve that request up front so the batch
  // count measures only writes made by the requests under test.
  let started: Promise<void> | undefined;
  const call = async (path: string, body?: unknown) => {
    await (started ??= worker.fetch(new Request("https://fixture.test/health"), env).then(() => { db.batches = 0; }));
    const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
    return worker.fetch(new Request("https://fixture.test" + path, { method: body ? "POST" : "GET", headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  };
  return {
    call,
    async backup(scope: "meetings" | "roster" | "installation") { const result = await call(`/admin/data/backup?scope=${scope}`); if (!result.ok) throw new Error(await result.text()); return await result.json() as Record<string, any>; },
    restore: (backup: unknown, extra: Record<string, unknown> = {}) => call("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup, ...extra }),
  };
}

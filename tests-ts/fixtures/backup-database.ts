// quick-check: covers apps/api/migrations/**
// Real SQLite database with every Core migration, the d1_migrations ledger and a seeded installation, for backup and restore
// tests through the Worker. The database is the canonical TestD1Database (d1-database.ts).
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { InstallationSeed, TestD1Database, attendanceWithOutreachDisabled } from "./d1-database.ts";

export const sessionSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** The installation backup tests start from: two users, one member, Attendance set up and Outreach disabled. */
export const backupSeed = () => new InstallationSeed("2026-01-01T00:00:00.000Z", { rowsCreatedAt: "2026-01-01" })
  .users("admin", "operator").members({ id: "member", externalId: "001", firstName: "Synthetic", lastName: "Member" })
  .organization().hoursEntrySettings().modules(...attendanceWithOutreachDisabled(true))
  .setupProgress("attendance", 2, ["rules", "meeting", "input"], "2026-01-01T00:00:00.000Z", "admin");

export class BackupDatabase extends TestD1Database {
  batches = 0;
  // D1 records every applied Core migration in d1_migrations; module reconciliation reads it to accept adopted baselines.
  constructor() { super({ recordMigrations: true, seed: backupSeed() }); }
  get raw() { return this.sqlite; }
  override async batch(statements: Parameters<TestD1Database["batch"]>[0]) { this.batches += 1; return super.batch(statements); }
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

// quick-check: covers apps/api/migrations/**
// Migrated SQLite database with D1 batch semantics and a Core installation seed, for module lifecycle tests. The database is
// the canonical TestD1Database (d1-database.ts).
import { InstallationSeed, Statement, TestD1Database, attendanceWithOutreachDisabled } from "./d1-database.ts";

export { Statement };

/** The installation lifecycle tests start from: Attendance (set up or not) assigned to the operator, Outreach disabled. */
export const lifecycleSeed = (setupComplete = false) => new InstallationSeed("2026-09-28")
  .users("admin", "operator").organization().modules(...attendanceWithOutreachDisabled(setupComplete))
  .assign("operator", "attendance", ["attendance.manage"])
  .members({ id: "member", externalId: "1001", firstName: "Synthetic", lastName: "Member" })
  .hoursEntrySettings()
  .add(`INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES
    ('primary','event','Event','event',1,'2026-09-28','2026-09-28'),
    ('primary','team-support','Team Support','team',1,'2026-09-28','2026-09-28'),
    ('primary','other-service','Other Service','task',1,'2026-09-28','2026-09-28');`);

export class Database extends TestD1Database {
  constructor(setupComplete = false) { super({ seed: lifecycleSeed(setupComplete) }); }
}

export function request(path: string, method: string, body?: unknown) {
  return new Request(`https://synthetic.test${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

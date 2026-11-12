// quick-check: covers apps/api/migrations/**
import { omitContestResubmissionFields, pluginSectionTables } from "../fixtures/backup-versions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { type Env } from "../../apps/api/src/index.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { walkthroughs } from "../../packages/shared/src/walkthrough.ts";
import { externalModuleMigrations } from "../../apps/api/src/generated/external-module-data.ts";
import { applyComposedModuleMigrations, recordCoreMigrations, applyCoreMigrations } from "../fixtures/d1-database.ts";

class Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    applyCoreMigrations(this.sqlite);
    // Then the composed Outreach plugin's own migrations, as the Worker's module reconciliation applies them after Core's.
    recordCoreMigrations(this.sqlite); applyComposedModuleMigrations(this.sqlite, externalModuleMigrations, { now: "2026-09-25T00:00:00.000Z" });
    this.sqlite.exec(`INSERT INTO installations (id, created_at, auth_mode) VALUES ('primary', '2026-09-25', 'local'), ('other', '2026-09-25', 'local');
      INSERT INTO users (id, installation_id, local_username, role, created_at) VALUES ('admin', 'primary', 'admin', 'admin', '2026-09-25'), ('operator', 'primary', 'operator', 'operator', '2026-09-25'), ('outsider', 'other', 'outsider', 'admin', '2026-09-25');
      INSERT INTO platform_module_administration VALUES ('primary', 0, 1);
      INSERT INTO platform_module_administration_epochs VALUES ('primary', 0);
      INSERT INTO platform_module_epochs VALUES ('primary', 'attendance', 1);
      INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,disabled_at,delete_after,deletion_cursor,cleanup_failure)
        VALUES ('primary', 'attendance', 1, 1, 'enabled', 2, 1, NULL, NULL, 0, NULL);
      INSERT INTO platform_module_epochs VALUES ('primary', 'hour-tracking', 1);
      INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,disabled_at,delete_after,deletion_cursor,cleanup_failure)
        VALUES ('primary', 'hour-tracking', 1, 1, 'disabled', 1, 0, NULL, NULL, 0, NULL);
      INSERT INTO platform_module_assignment_epochs VALUES ('primary', 'admin', 0), ('primary', 'operator', 0);
      INSERT INTO platform_module_assignment_revisions VALUES ('primary', 'admin', 0), ('primary', 'operator', 0);
      INSERT INTO platform_module_assignments VALUES ('primary', 'operator', 'attendance', '["attendance.manage"]');
      INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES
        ('primary','attendance','rules',2,'completed','2026-09-25','admin'),
        ('primary','attendance','meeting',2,'completed','2026-09-25','admin'),
        ('primary','attendance','input',2,'completed','2026-09-25','admin'),
        ('primary','attendance','calendar',2,'skipped','2026-09-25','admin'),
        ('primary','attendance','discord',2,'skipped','2026-09-25','admin');
      INSERT INTO organization_settings (installation_id, time_zone) VALUES ('primary', 'UTC');
      INSERT INTO hours_entry_settings(installation_id) VALUES ('primary');
      INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES
        ('primary','event','Event','event',1,'2026-09-25','2026-09-25'),
        ('primary','team-support','Team Support','team',1,'2026-09-25','2026-09-25'),
        ('primary','other-service','Other Service','task',1,'2026-09-25','2026-09-25');`);
  }
  prepare(sql: string) {
    let values: unknown[] = []; const db = this.sqlite;
    return { bind(...next: unknown[]) { values = next; return this; },
      async first() { return db.prepare(sql).get(...values as []) ?? null; },
      async all() { return { results: db.prepare(sql).all(...values as []) }; },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values as []).changes) } }; } };
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
const secret = "A".repeat(43);
const origin = "https://dashboard.example.test";
async function call(database: Database, path: string, user = "admin", body?: unknown, requestOrigin = origin) {
  const token = user ? await createSessionCodec(secret).issue({ userId: user, role: user === "operator" ? "operator" : "admin" }) : "";
  const request = new Request(`https://api.example.test${path}`, { method: body ? path === "/admin/data/restore" || path === "/admin/setup/reset" ? "POST" : "PATCH" : "GET", headers: { origin: requestOrigin, "content-type": "application/json", cookie: `lancerlogin_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
  return worker.fetch(request, { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, DB: database } as unknown as Env);
}
const endpoint = "/auth/walkthroughs/dashboard";
const progress = { version: 1, status: "in_progress", stepId: "search" };

function historicalBackup(source: any, version: number) {
  source.schemaVersion = version; omitContestResubmissionFields(source);
  if (version < 40) for (const row of source.tables.kiosks ?? []) delete row.configured_authentication_method;
  if (version < 36) for (const row of source.tables.hours_publication_operations ?? []) delete row.event_snapshot_json;
  if (version < 34) for (const row of source.tables.members ?? []) delete row.inactive_periods_json;
  if (version < 33) {
    delete source.tables.hours_public_form_settings;
    const owner = source.ownership?.modules.find((module: any) => module.id === "hour-tracking");
    if (owner) owner.tables = owner.tables.filter((table: string) => table !== "hours_public_form_settings");
    for (const row of source.tables.hours_correction_requests ?? []) delete row.activity_id;
  }
  return source;
}

test("Outreach schema33 restores privacy and event corrections while older ownership defaults safely off", async () => {
  const db = new Database();
  try {
    db.sqlite.exec(`INSERT INTO hours_public_form_settings(installation_id,member_validation,revision,updated_at) VALUES('primary','name',2,'2026-09-28T18:00:00Z');
      INSERT INTO hours_public_lookup_limits VALUES('primary',1780000000000,4);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('synthetic-member','primary','SYN-001','Synthetic','Member','2026-09-28');
      INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES('primary','synthetic-event','event','event','2026-09-28','Synthetic drive','2026-09-28','2026-09-28');
      INSERT INTO hours_correction_requests(installation_id,id,channel,attribution,requester_member_id,entry_id,claimed_service_date,message,key_hash,fingerprint,status,revision,created_at,activity_id)
        VALUES('primary','synthetic-request','public','self_asserted','synthetic-member',NULL,'2026-09-28','Please review the morning entry.','synthetic-key','synthetic-fingerprint','open',0,'2026-09-28T18:00:00Z','synthetic-event');`);
    const backup = await (await call(db, "/admin/data/backup?scope=installation")).json() as any;
    // Current backups carry Outreach in its plugin section; the schema 32 form below carries it in Core's section.
    const outreach = (source: any) => pluginSectionTables(source, "hour-tracking")!;
    assert.equal(backup.schemaVersion, 51); assert.equal(outreach(backup).hours_public_form_settings![0]!.member_validation, "name");
    assert.equal(outreach(backup).hours_correction_requests![0]!.activity_id, "synthetic-event"); assert.equal(outreach(backup).hours_public_lookup_limits, undefined); assert.equal(backup.tables.hours_public_form_settings, undefined);
    const restore = (source: unknown) => call(db, "/admin/data/restore", "admin", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: source });
    const invalid = structuredClone(backup); outreach(invalid).hours_public_form_settings![0]!.member_validation = "roster";
    assert.equal((await restore(invalid)).status, 400); assert.equal(db.sqlite.prepare("SELECT member_validation FROM hours_public_form_settings").get()?.member_validation, "name");
    const badActivity = structuredClone(backup); outreach(badActivity).hours_correction_requests![0]!.activity_id = "missing";
    assert.equal((await restore(badActivity)).status, 400);
    let result = await restore(backup); assert.equal(result.status, 200, await result.clone().text());
    assert.equal(db.sqlite.prepare("SELECT activity_id FROM hours_correction_requests").get()?.activity_id, "synthetic-event");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_public_lookup_limits").get()?.count, 0);
    const previous = historicalBackup(structuredClone(backup), 32); delete previous.tables.hours_public_form_settings;
    for (const row of previous.tables.members) delete row.inactive_periods_json;
    previous.ownership.modules.find((module: any) => module.id === "hour-tracking").tables = previous.ownership.modules.find((module: any) => module.id === "hour-tracking").tables.filter((table: string) => table !== "hours_public_form_settings");
    for (const row of previous.tables.hours_correction_requests) delete row.activity_id;
    result = await restore(previous); assert.equal(result.status, 200, await result.clone().text());
    assert.equal(db.sqlite.prepare("SELECT member_validation FROM hours_public_form_settings").get()?.member_validation, "off");
    assert.equal(db.sqlite.prepare("SELECT activity_id FROM hours_correction_requests").get()?.activity_id, null);
    const mixed = structuredClone(previous); mixed.tables.hours_public_form_settings = outreach(backup).hours_public_form_settings;
    assert.equal((await restore(mixed)).status, 400);
  } finally { db.sqlite.close(); }
});

test("entire-installation backups round-trip progress, older backups reset it, and category restores preserve it", async () => {
  const db = new Database();
  try {
    await call(db, endpoint, "admin", { ...progress, status: "completed", stepId: "recurrence" });
    db.sqlite.exec("INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES('primary',0,0,'2026-09-28','2026-09-28'); INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,event_start_local,event_end_local,created_at,updated_at) VALUES('primary','scheduled-event','event','event','2026-10-10','Scheduled event','17:00','18:00','2026-09-28','2026-09-28')");
    const backup = await (await call(db, "/admin/data/backup?scope=installation")).json() as any;
    assert.equal(backup.schemaVersion, 51);
    assert.equal(backup.tables.organization_settings[0].kiosk_authentication_method, "fingerprint");
    // Outreach rows travel in its plugin section; the historical forms below carry them in Core's section.
    const outreach = pluginSectionTables(backup, "hour-tracking")!;
    assert.deepEqual(outreach.hours_publication_settings!.map((item: any) => [item.automatic, item.revision]), [[0, 0]]);
    assert.equal(outreach.hours_activities!.find((item: any) => item.id === "scheduled-event")?.event_start_local, "17:00");
    assert.equal(backup.tables.user_walkthroughs.length, 1);
    assert.equal(backup.tables.platform_modules.find((item: any) => item.module_id === "attendance")?.phase, "enabled");
    assert.equal(backup.tables.platform_modules.find((item: any) => item.module_id === "hour-tracking")?.phase, "disabled");
    const restore = async (scope: string, source: unknown) => call(db, "/admin/data/restore", "admin", { scope, confirmation: `RESTORE ${scope.toUpperCase()}`, backup: source });
    let result = await restore("installation", backup); assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await call(db, "/platform/modules")).status, 200);
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "completed");
    const schema30 = historicalBackup(structuredClone(backup), 30);
    for (const item of schema30.tables.organization_settings) item.kiosk_authentication_method = "qr";
    result = await restore("installation", schema30); assert.equal(result.status, 200, await result.clone().text());
    assert.equal(db.sqlite.prepare("SELECT kiosk_authentication_method FROM organization_settings WHERE installation_id='primary'").get()?.kiosk_authentication_method, "fingerprint");
    const schema28 = historicalBackup(structuredClone(backup), 28); delete schema28.tables.hours_publication_settings;
    for (const item of schema28.tables.hours_activities) { delete item.event_start_local; delete item.event_end_local; delete item.event_start_occurrence; delete item.event_end_occurrence; }
    for (const item of schema28.tables.hours_publication_operations) delete item.action;
    result = await restore("installation", schema28); assert.equal(result.status, 200, await result.clone().text());
    assert.equal(db.sqlite.prepare("SELECT automatic FROM hours_publication_settings WHERE installation_id='primary'").get()?.automatic, 0);
    assert.deepEqual({ ...db.sqlite.prepare("SELECT event_start_local,event_end_local FROM hours_activities WHERE id='scheduled-event'").get() }, { event_start_local: null, event_end_local: null });
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "completed");
    for (const scope of ["roster", "meetings"]) {
      const category = await (await call(db, `/admin/data/backup?scope=${scope}`)).json() as any;
      assert.equal(category.tables.user_walkthroughs, undefined);
      result = await restore(scope, category); assert.equal(result.status, 200, await result.clone().text());
      assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "completed");
    }
    const invalid = structuredClone(backup); invalid.tables.user_walkthroughs[0].user_id = "outsider";
    assert.equal((await restore("installation", invalid)).status, 400);
    const priorOutreach = historicalBackup(structuredClone(backup), 28); delete priorOutreach.tables.hours_labels; delete priorOutreach.tables.hours_activity_labels;
    result = await restore("installation", priorOutreach); assert.equal(result.status, 200, await result.clone().text());
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_labels").get()?.count, 3);
    assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    const old = historicalBackup(structuredClone(backup), 20); delete old.tables.user_walkthroughs;
    for (const table of Object.keys(old.tables).filter((table) => table.startsWith("platform_module"))) delete old.tables[table];
    result = await restore("installation", old); assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await call(db, "/platform/modules")).status, 200);
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "not_started");
    assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.sqlite.close(); }
});

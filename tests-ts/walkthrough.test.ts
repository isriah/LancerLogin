// Walkthrough progress and installation backups that need no plugin, run without composing one. The Outreach-dependent cases are in outreach/walkthrough.ts (outreach-walkthrough.test.ts).
// quick-check: covers apps/api/migrations/**
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { walkthroughs } from "../packages/shared/src/walkthrough.ts";
import { externalModuleMigrations } from "../apps/api/src/generated/external-module-data.ts";
import { applyComposedModuleMigrations, recordCoreMigrations, applyCoreMigrations, readCoreMigrations } from "./fixtures/d1-database.ts";

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

test("portable kiosk methods round-trip independently and older backups preserve their effective global configuration", async () => {
  const db = new Database();
  try {
    db.sqlite.exec(`INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES('pair-front','primary','code-front','2026-09-26','admin','2026-09-25'),('pair-side','primary','code-side','2026-09-26','admin','2026-09-25');
      INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,active,created_at,authentication_method,configured_authentication_method) VALUES
      ('front','primary','pair-front','Front','synthetic-front',1,'2026-09-25','fingerprint','qr'),
      ('side','primary','pair-side','Side','synthetic-side',1,'2026-09-25','rfid','nfc');
      UPDATE organization_settings SET kiosk_authentication_method='member_id' WHERE installation_id='primary'`);
    const backup = await (await call(db, "/admin/data/backup?scope=installation")).json() as any;
    assert.equal(backup.schemaVersion, 51);
    const restore = (source: any) => call(db, "/admin/data/restore", "admin", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: source });
    for (const method of ["camera", null, undefined]) {
      const invalid = structuredClone(backup); invalid.tables.kiosks[0].configured_authentication_method = method;
      assert.equal((await restore(invalid)).status, 400);
      assert.equal(db.sqlite.prepare("SELECT configured_authentication_method AS method FROM kiosks WHERE id='front'").get()?.method, "qr");
    }
    let result = await restore(backup); assert.equal(result.status, 200, await result.clone().text());
    assert.deepEqual(db.sqlite.prepare("SELECT authentication_method AS reported,configured_authentication_method AS configured FROM kiosks ORDER BY id").all().map(row => ({ ...row })), [{ reported: "fingerprint", configured: "qr" }, { reported: "rfid", configured: "nfc" }]);
    const legacy = historicalBackup(structuredClone(backup), 39);
    result = await restore(legacy); assert.equal(result.status, 200, await result.clone().text());
    assert.deepEqual(db.sqlite.prepare("SELECT configured_authentication_method AS method FROM kiosks").all().map(row => row.method), ["member_id", "member_id"]);
    const malformed = historicalBackup(structuredClone(backup), 39); malformed.tables.organization_settings[0].kiosk_authentication_method = "camera";
    assert.equal((await restore(malformed)).status, 400);
    assert.deepEqual(db.sqlite.prepare("SELECT configured_authentication_method AS method FROM kiosks").all().map(row => row.method), ["member_id", "member_id"]);
  } finally { db.sqlite.close(); }
});

test("walkthrough progress persists per account and enforces session, installation, origin and input boundaries", async () => {
  const db = new Database();
  try {
    assert.equal((await call(db, endpoint, "")).status, 401);
    assert.equal((await call(db, endpoint, "outsider")).status, 401);
    for (const user of ["admin", "operator"]) {
      assert.equal((await (await call(db, endpoint, user)).json() as any).progress.status, "not_started");
      assert.equal((await call(db, endpoint, user, progress)).status, 200);
    }
    await call(db, endpoint, "admin", { ...progress, status: "dismissed" });
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "dismissed");
    assert.equal((await (await call(db, endpoint, "operator")).json() as any).progress.status, "in_progress");
    assert.equal((await call(db, endpoint, "admin", progress, "https://untrusted.example")).status, 403);
    for (const invalid of [{ ...progress, userId: "operator" }, { ...progress, status: "unknown" }, { ...progress, version: 2 }, { ...progress, stepId: null }, { ...progress, stepId: "missing" }, { status: "completed" }]) assert.equal((await call(db, endpoint, "admin", invalid)).status, 400);
    assert.equal((await call(db, "/auth/walkthroughs/missing")).status, 404);
    assert.equal((await call(db, "/auth/walkthroughs/__proto__")).status, 404);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM user_walkthroughs").get()?.n, 2);
    db.sqlite.exec("UPDATE users SET active = 0 WHERE id = 'operator'");
    assert.equal((await call(db, endpoint, "operator", progress)).status, 401);
  } finally { db.sqlite.close(); }
});

test("every registered page accepts independent walkthrough progress", async () => {
  const db = new Database();
  try {
    for (const [pageId, definition] of Object.entries(walkthroughs)) {
      const pageEndpoint = `/auth/walkthroughs/${pageId}`;
      const initial = await (await call(db, pageEndpoint)).json() as any;
      assert.deepEqual(initial.progress, { pageId, version: definition.version, status: "not_started", stepId: null });
      const stepId = definition.steps.at(-1)!;
      const response = await call(db, pageEndpoint, "admin", { version: definition.version, status: "completed", stepId });
      assert.equal(response.status, 200, `${pageId}: ${await response.clone().text()}`);
      const saved = await (await call(db, pageEndpoint)).json() as any;
      assert.deepEqual(saved.progress, { pageId, version: definition.version, status: "completed", stepId });
    }
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM user_walkthroughs").get()?.n, Object.keys(walkthroughs).length);
  } finally { db.sqlite.close(); }
});

test("legacy roster summary progress remains readable and survives backup restore", async () => {
  const db = new Database();
  try {
    const legacy = { version: 1, status: "in_progress", stepId: "summary" };
    assert.equal((await call(db, "/auth/walkthroughs/roster", "admin", legacy)).status, 200);
    const backup = await (await call(db, "/admin/data/backup?scope=installation")).json() as any;
    const restored = await call(db, "/admin/data/restore", "admin", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup });
    assert.equal(restored.status, 200, await restored.clone().text());
    const saved = await (await call(db, "/auth/walkthroughs/roster")).json() as any;
    assert.deepEqual(saved.progress, { pageId: "roster", ...legacy });
    assert.equal(walkthroughs.roster.steps[0], "filters");
  } finally { db.sqlite.close(); }
});

test("walkthrough migration preserves an existing installation and saved reports", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migration = "0038_page_walkthroughs.sql";
    applyCoreMigrations(db, readCoreMigrations().filter((file) => file.name < migration));
    db.exec("INSERT INTO installations (id, created_at, auth_mode) VALUES ('primary', '2026-09-25', 'local'); INSERT INTO users (id, installation_id, local_username, role, created_at) VALUES ('admin', 'primary', 'admin', 'admin', '2026-09-25');");
    db.prepare("INSERT INTO saved_report_views VALUES (?,?,?,?,?,?,1,?,?,?,?)").run("report", "primary", "admin", "personal", "Existing report", "{}", "admin", "admin", "2026-09-25", "2026-09-25");
    db.prepare("INSERT INTO saved_report_tabs VALUES (?,?,?,?,?)").run("primary", "admin", "report", 0, "2026-09-25");
    const before = db.prepare("SELECT name, type, sql FROM sqlite_master ORDER BY name").all();
    db.exec(readFileSync(`apps/api/migrations/${migration}`, "utf8"));
    assert.deepEqual(db.prepare("SELECT name, type, sql FROM sqlite_master WHERE tbl_name != 'user_walkthroughs' ORDER BY name").all(), before);
    assert.equal(db.prepare("SELECT name FROM saved_report_views WHERE id = 'report'").get()?.name, "Existing report");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM saved_report_tabs").get()?.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_walkthroughs").get()?.count, 0);
    db.exec("INSERT INTO user_walkthroughs VALUES ('primary', 'admin', 'reports', 1, 'in_progress', 'filters', '2026-09-26');");
    assert.equal(db.prepare("SELECT local_username FROM users WHERE id = 'admin'").get()?.local_username, "admin");
  } finally { db.close(); }
});

test("installation recovery preserves the contest block setting and previous rejection history", async () => {
  const database = new Database();
  try {
    database.sqlite.exec(`UPDATE organization_settings SET discord_block_recontests_after_rejection=1;
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('contest-member','primary','SYN','Synthetic','Member','2026-10-15');
      INSERT INTO meetings(id,installation_id,title,starts_at,created_by,created_at) VALUES('contest-meeting','primary','Synthetic','2026-10-15T10:00:00Z','admin','2026-10-15');`);
    const history = JSON.stringify([{ messageId: "old", createdAt: "2026-10-15T10:00:00Z", status: "rejected", resolvedBy: "admin", resolvedAt: "2026-10-15T11:00:00Z", reviewNote: "Retained review", submittedByDiscordUserId: "synthetic" }]);
    database.sqlite.prepare("INSERT INTO discord_attendance_contests(installation_id,meeting_id,member_id,message_id,status,created_at,prior_reviews_json) VALUES('primary','contest-meeting','contest-member','new','open','2026-10-15T12:00:00Z',?)").run(history);
    const backup = await (await call(database, "/admin/data/backup?scope=installation")).json() as any;
    assert.equal(backup.tables.organization_settings[0].discord_block_recontests_after_rejection, 1);
    database.sqlite.exec("UPDATE organization_settings SET discord_block_recontests_after_rejection=0; UPDATE discord_attendance_contests SET prior_reviews_json='[]'");
    const result = await call(database, "/admin/data/restore", "admin", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(database.sqlite.prepare("SELECT discord_block_recontests_after_rejection AS blocked FROM organization_settings WHERE installation_id='primary'").get()!.blocked, 1);
    assert.equal(database.sqlite.prepare("SELECT prior_reviews_json FROM discord_attendance_contests").get()!.prior_reviews_json, history);
  } finally { database.sqlite.close(); }
});

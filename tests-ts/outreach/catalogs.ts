import { omitContestResubmissionFields, pluginSectionTables } from "../fixtures/backup-versions.ts";
import { bundledModuleRegistry } from "../../packages/shared/src/module-platform.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { D1Database, D1Result, D1Statement } from "../../apps/api/src/d1-usage.ts";
import { outreachCatalogRoute, outreachSetupRoute } from "@lancerlogin-test/outreach/src/api/outreach-catalogs.ts";
import { outreachEntryRoute } from "@lancerlogin-test/outreach/src/api/outreach-entries.ts";
import { outreachPublicRoute } from "@lancerlogin-test/outreach/src/api/outreach-public.ts";
import { publicFormSettingsRoute } from "@lancerlogin-test/outreach/src/api/outreach-public-settings.ts";
import worker, { type Env } from "../../apps/api/src/index.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { outreachReviewRoute } from "@lancerlogin-test/outreach/src/api/outreach-review.ts";
import { dispatchModuleDiscordCommand } from "../../apps/api/src/module-discord.ts";
import { outreachPublicationRoute, processOutreachPublicationOperations, outreachGoogleEventPayload, type OutreachPublicationEvent, type OutreachPublicationProvider, type OutreachPublicationProviders } from "@lancerlogin-test/outreach/src/api/outreach-publication.ts";
import { readModuleSetup, updateModuleSetup } from "../../apps/api/src/module-platform.ts";
import { outreachReportHandlers } from "@lancerlogin-test/outreach/src/api/outreach-reporting.ts";
import { defaultReportDefinition } from "../../apps/api/src/report-builder.ts";

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
  batchResult(): D1Result { if (/^\s*(?:SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) return { success: true, results: this.native().all(...this.values as []), meta: { changes: 0 } } as D1Result; const result = this.native().run(...this.values as []); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
}

class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-09-28','local');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','America/New_York');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-09-28');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','1001','Synthetic','Member','2026-09-28');
      INSERT INTO platform_module_administration VALUES('primary',0,1);
      INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1),('primary','hour-tracking',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES
        ('primary','attendance',1,1,'disabled',2,0,0),('primary','hour-tracking',1,1,'enabled',1,0,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','admin',0);
      INSERT INTO platform_module_assignment_revisions VALUES('primary','admin',0);
      INSERT INTO hours_entry_settings(installation_id) VALUES('primary');
      INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES('primary',0,0,'2026-09-28','2026-09-28');
      INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES
        ('primary','event','Event','event',1,'2026-09-28','2026-09-28'),
        ('primary','team-support','Team Support','team',1,'2026-09-28','2026-09-28'),
        ('primary','other-service','Other Service','task',1,'2026-09-28','2026-09-28');`);
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const results = statements.map((statement) => (statement as Statement).batchResult()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}

function request(path: string, method = "GET") { return new Request(`https://synthetic.test${path}`, { method }); }
function publicRequest(path: string, method = "GET") { return new Request(`https://synthetic.test${path}`, { method, headers: method === "GET" ? undefined : { origin: "https://synthetic.test" } }); }

test("real Worker module-scoped lookup retains rate-limit RETURNING rows and revokes disabled modules", async () => {
  const database = new Database(); const now = Date.parse("2026-09-28T18:00:00Z");
  try {
    database.sqlite.exec("UPDATE platform_modules SET setup_complete=1 WHERE module_id='hour-tracking'");
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://synthetic.test", SESSION_KEY: "A".repeat(43), DB: database } as unknown as Env;
    const session = await createSessionCodec("A".repeat(43)).issue({ userId: "admin", role: "admin" });
    const updated = await worker.fetch(new Request("https://synthetic.test/admin/hours/public-form-settings", { method: "PUT", headers: { origin: "https://synthetic.test", "content-type": "application/json", cookie: `lancerlogin_session=${session}` }, body: JSON.stringify({ memberValidation: "name", revision: 0 }) }), env);
    assert.equal(updated.status, 200, await updated.clone().text()); assert.deepEqual(await updated.json(), { memberValidation: "name", revision: 1 });
    const lookup = () => worker.fetch(new Request("https://synthetic.test/public/hours/member-validation", { method: "POST", headers: { origin: "https://synthetic.test", "content-type": "application/json" }, body: JSON.stringify({ memberExternalId: "1001" }) }), env);
    let result = await lookup(); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { mode: "name", valid: true, name: "Synthetic Member" });
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    database.sqlite.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='hour-tracking'");
    result = await lookup(); assert.equal(result.status, 409); assert.doesNotMatch(await result.text(), /Synthetic Member|"valid"/);
  } finally { database.close(); }
});

test("public ID modes enforce exact projections, default off, active membership, and bounded lookups", async () => {
  const database = new Database(); const now = Date.parse("2026-09-28T18:00:00Z");
  try {
    const queries: string[] = []; const prepare = database.prepare.bind(database);
    database.prepare = sql => { queries.push(sql); return prepare(sql); };
    const lookup = (memberExternalId: unknown = "1001", time = now) => outreachPublicRoute(database, publicRequest("/public/hours/member-validation", "POST"), "https://synthetic.test", { memberExternalId }, time);
    assert.deepEqual((await lookup()).body, { mode: "off" });
    assert.equal(queries.some(sql => sql.includes("FROM members")), false);
    let saved = await publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings", "PUT"), { memberValidation: "validity", revision: 0 }, now);
    assert.deepEqual(saved.body, { memberValidation: "validity", revision: 1 });
    queries.length = 0;
    assert.deepEqual((await lookup()).body, { mode: "validity", valid: true });
    assert.equal(queries.some(sql => /first_name|last_name|external_id AS/.test(sql)), false);
    assert.deepEqual((await lookup("100")).body, { mode: "validity", valid: false });
    assert.deepEqual((await lookup("%" )).body, { mode: "validity", valid: false });
    await assert.rejects(lookup(["1001", "1002"]), /Enter a roster member ID/);
    await assert.rejects(outreachPublicRoute(database, publicRequest("/public/hours/member-validation", "POST"), "https://synthetic.test", { memberExternalId: "1001", limit: 100 }, now), /Enter one roster member ID/);
    saved = await publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings", "PUT"), { memberValidation: "name", revision: 1 }, now);
    assert.deepEqual((await lookup()).body, { mode: "name", valid: true, name: "Synthetic Member" });
    database.sqlite.exec("UPDATE members SET active=0 WHERE id='member'");
    assert.deepEqual((await lookup()).body, { mode: "name", valid: false });
    database.sqlite.exec("UPDATE members SET active=1 WHERE id='member'");
    for (let index = 0; index < 55; index++) assert.equal((await lookup()).status, 200);
    assert.equal((await lookup()).status, 429);
    assert.equal((await lookup("1001", now + 60_000)).status, 200);
    assert.deepEqual(Object.keys(database.sqlite.prepare("SELECT * FROM hours_public_lookup_limits").get()!).sort(), ["attempts", "installation_id", "window_start_ms"]);
    await publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings", "PUT"), { memberValidation: "off", revision: 2 }, now);
    assert.deepEqual((await lookup()).body, { mode: "off" });
    await assert.rejects(publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings", "PUT"), { memberValidation: "name", revision: 2 }, now), /changed/);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='outreach.public_form_privacy_updated'").get()?.count, 3);
  } finally { database.close(); }
});

test("changing privacy during a lookup fails closed without returning names or validity", async () => {
  const database = new Database(); const now = Date.parse("2026-09-28T18:00:00Z");
  try {
    await publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings", "PUT"), { memberValidation: "name", revision: 0 }, now);
    const prepare = database.prepare.bind(database);
    database.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes("FROM members")) return statement;
      // Bind normally creates a fresh adapter, so keep this interception on it.
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => { const bound = bind(...values); const first = bound.first.bind(bound); bound.first = async <T>() => { const row = await first<T>(); database.sqlite.exec("UPDATE hours_public_form_settings SET member_validation='off',revision=revision+1"); return row; }; return bound; };
      return statement;
    };
    const result = await outreachPublicRoute(database, publicRequest("/public/hours/member-validation", "POST"), "https://synthetic.test", { memberExternalId: "1001" }, now);
    assert.deepEqual(result.body, { mode: "off" });
  } finally { database.close(); }
});

test("privacy settings recheck active Admin authority in the settings read and atomic write", async () => {
  const database = new Database(); const now = Date.parse("2026-09-28T18:00:00Z");
  try {
    assert.deepEqual((await publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings"))).body, { memberValidation: "off", revision: 0 });
    database.sqlite.exec("UPDATE users SET role='operator' WHERE id='admin'");
    await assert.rejects(publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings")), /Current Administrator access/);
    database.sqlite.exec("UPDATE users SET role='admin' WHERE id='admin'");
    const batch = database.batch.bind(database);
    database.batch = async statements => { database.sqlite.exec("UPDATE users SET role='operator' WHERE id='admin'"); return batch(statements); };
    await assert.rejects(publicFormSettingsRoute(database, "admin", request("/admin/hours/public-form-settings", "PUT"), { memberValidation: "name", revision: 0 }, now), /changed/);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_public_form_settings").get()?.count, 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='outreach.public_form_privacy_updated'").get()?.count, 0);
  } finally { database.close(); }
});

test("event-level correction requests disclose no history and Staff chooses one audited entry", async () => {
  const database = new Database(); const now = Date.parse("2026-09-28T18:00:00Z");
  try {
    const activity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-28", title: "Synthetic public event", description: "", location: "", impactRelevant: true, archived: false });
    const activityId = String((activity.body as { id: string }).id);
    const entry = { memberExternalId: "1001", activityId, serviceDate: "2026-09-28", startLocal: "09:00", endLocal: "10:00", taskNotes: "", expectedTimeZone: "America/New_York", idempotencyKey: "public-event-correction-entry-1" };
    const first = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", entry, now);
    await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", { ...entry, startLocal: "11:00", endLocal: "12:00", idempotencyKey: "public-event-correction-entry-2" }, now);
    const payload = { memberExternalId: "1001", activityId, message: "The morning entry should end at 10:30.", idempotencyKey: "public-event-correction-request" };
    const result = await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", payload, now);
    assert.equal(result.status, 202);
    assert.deepEqual(Object.keys(result.body as object).sort(), ["createdAt", "reference", "status"]);
    assert.deepEqual((await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", payload, now)).body, result.body);
    const reference = String((result.body as { reference: string }).reference);
    const row = database.sqlite.prepare("SELECT * FROM hours_correction_requests WHERE id=?").get(reference)!;
    assert.equal(row.entry_id, null); assert.equal(row.activity_id, activityId);
    const candidates = await outreachReviewRoute(database, "admin", request(`/admin/hours/corrections/${reference}/entries?limit=1`));
    assert.equal((candidates.body as PageResult).items.length, 1); assert.ok((candidates.body as PageResult).nextCursor);
    assert.equal((candidates.body as PageResult).items[0]?.timeZone, "America/New_York");
    assert.equal(database.sqlite.prepare("SELECT SUM(duration_minutes) AS total FROM hours_entries").get()?.total, 120);
    const entryId = String((first.body as { id: string }).id);
    await assert.rejects(outreachReviewRoute(database, "admin", request(`/admin/hours/corrections/${reference}/resolve`, "POST"), { action: "corrected", note: "Verified", requestRevision: 0, entryRevision: 0, endLocal: "10:30" }, now), /Select the affected/);
    await outreachReviewRoute(database, "admin", request(`/admin/hours/corrections/${reference}/resolve`, "POST"), { action: "corrected", note: "Verified morning time", requestRevision: 0, entryId, entryRevision: 0, endLocal: "10:30" }, now);
    assert.equal(database.sqlite.prepare("SELECT SUM(duration_minutes) AS total FROM hours_entries").get()?.total, 150);
    assert.equal(database.sqlite.prepare("SELECT entry_id FROM hours_correction_resolutions WHERE request_id=?").get(reference)?.entry_id, entryId);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_entry_revisions WHERE entry_id=?").get(entryId)?.count, 2);
    assert.throws(() => database.sqlite.prepare("UPDATE hours_correction_requests SET activity_id=NULL WHERE id=?").run(reference), /immutable/);
    database.sqlite.exec("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('empty-member','primary','9999','No','Entries','2026-09-28');");
    const empty = await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", { ...payload, memberExternalId: "9999", idempotencyKey: "public-event-correction-empty" }, now);
    assert.equal(empty.status, result.status); assert.deepEqual(Object.keys(empty.body as object).sort(), Object.keys(result.body as object).sort());
    const emptyReference = String((empty.body as { reference: string }).reference);
    await assert.rejects(outreachReviewRoute(database, "admin", request(`/admin/hours/corrections/${emptyReference}/resolve`, "POST"), { action: "voided", note: "Wrong member must not be selected", requestRevision: 0, entryId, entryRevision: 1 }, now), /requesting member and selected activity/);
    assert.equal(database.sqlite.prepare("SELECT SUM(duration_minutes) AS total FROM hours_entries").get()?.total, 150);
    await assert.rejects(outreachPublicRoute(database, publicRequest(`/public/hours/corrections/${reference}/entries`), "https://synthetic.test", undefined, now), /not found/);
    await assert.rejects(outreachPublicRoute(database, publicRequest("/public/hours/correction-activities?memberExternalId=1001"), "https://synthetic.test", undefined, now), /filter/);
  } finally { database.close(); }
});
type PageResult = { items: Array<Record<string, unknown>>; nextCursor: string | null };

test("Outreach label migration preserves legacy categories, activities, and associations", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql") && name < "0047_outreach_activity_labels.sql").sort()) database.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    database.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-09-28','local');
      INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES('primary','food','Food pantry','task',1,'2026-09-01','2026-09-02');
      INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES('primary','activity','food','task','2026-09-20','Sort donations','2026-09-03','2026-09-04');`);
    const before = { ...database.prepare("SELECT * FROM hours_activities WHERE id='activity'").get() };
    database.exec(readFileSync("apps/api/migrations/0047_outreach_activity_labels.sql", "utf8"));
    assert.deepEqual({ ...database.prepare("SELECT id,name,archived,revision,created_at,updated_at FROM hours_labels WHERE id='food'").get() }, { id: "food", name: "Food pantry", archived: 0, revision: 0, created_at: "2026-09-01", updated_at: "2026-09-02" });
    assert.deepEqual({ ...database.prepare("SELECT activity_id,label_id,created_at FROM hours_activity_labels").get() }, { activity_id: "activity", label_id: "food", created_at: "2026-09-03" });
    assert.deepEqual({ ...database.prepare("SELECT * FROM hours_activities WHERE id='activity'").get() }, before);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM hours_categories").get()?.count, 1);
  } finally { database.close(); }
});

test("Outreach report projections aggregate stable member, activity, entry, and supported-team rows", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member-2','primary','1002','Second','Member','2026-09-28');");
    database.sqlite.exec(`
      INSERT INTO hours_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES('primary','team-1','1234','Team Alpha','FRC','2026-09-28','2026-09-28');
      INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,team_id,title,created_at,updated_at) VALUES
        ('primary','activity-1','team-support','team','2026-09-20','team-1','Mentoring Team Alpha','2026-09-28','2026-09-28'),
        ('primary','activity-2','event','event','2026-08-01',NULL,'Summer event','2026-09-28','2026-09-28');
      INSERT INTO hours_labels(installation_id,id,name,created_at,updated_at) VALUES
        ('primary','community','Community partners','2026-09-28','2026-09-28'),
        ('primary','food','Food access','2026-09-28','2026-09-28');
      INSERT INTO hours_activity_labels(installation_id,activity_id,label_id,created_at) VALUES
        ('primary','activity-1','community','2026-09-28'),('primary','activity-1','food','2026-09-28'),('primary','activity-2','food','2026-09-28');
      INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_ms,end_ms,start_offset_seconds,end_offset_seconds,duration_minutes,attribution,actor_user_id,created_at,updated_at) VALUES
        ('primary','entry-1','member','activity-1','2026-09-20','UTC','10:00','11:00',0,3600000,0,0,60,'staff_recorded','admin','2026-09-28','2026-09-28'),
        ('primary','entry-2','member-2','activity-1','2026-09-20','UTC','11:00','12:40',3600000,9600000,0,0,100,'staff_recorded','admin','2026-09-28','2026-09-28'),
        ('primary','entry-3','member','activity-2','2026-08-01','UTC','09:00','09:30',10000000,11800000,0,0,30,'staff_recorded','admin','2026-09-28','2026-09-28');
    `);
    const context = { from: "2026-09-01", to: "2026-09-30", today: "2026-09-28" };
    const activityDefinition = defaultReportDefinition(false, "outreach.activities");
    activityDefinition.columnFilters = [{ column: { key: "outreach.activity.participants" }, operator: "minimum", value: "2" }];
    const activities = await outreachReportHandlers["outreach.activities"]!(database, activityDefinition, context);
    assert.equal(activities.length, 1); assert.equal(activities[0]!.id, "activity-1"); assert.equal(activities[0]!.cells["outreach.activity.participants"]?.text, "2"); assert.equal(activities[0]!.cells["outreach.activity.minutes"]?.text, "160");
    const labeledActivityDefinition = defaultReportDefinition(false, "outreach.activities");
    labeledActivityDefinition.outreachLabelIds = ["community", "food"]; labeledActivityDefinition.outreachLabelMatch = "all";
    const labeledActivities = await outreachReportHandlers["outreach.activities"]!(database, labeledActivityDefinition, context);
    assert.deepEqual(labeledActivities.map((row) => [row.id, row.cells["outreach.activity.minutes"]?.text]), [["activity-1", "160"]]);
    const teamDefinition = defaultReportDefinition(false, "outreach.teams"); teamDefinition.columns.push({ key: "outreach.team.activities" });
    const teams = await outreachReportHandlers["outreach.teams"]!(database, teamDefinition, context);
    assert.equal(teams[0]!.cells["outreach.team.participants"]?.text, "2"); assert.equal(teams[0]!.cells["outreach.team.activities"]?.text, "1");
    const memberDefinition = defaultReportDefinition(false, "outreach.members");
    const members = await outreachReportHandlers["outreach.members"]!(database, memberDefinition, context);
    assert.deepEqual(members.map((row) => [row.label, row.cells["outreach.member.minutes"]?.text, row.cells["outreach.member.minutes"]?.sortValue]), [["Second Member", "1.67", 1.67], ["Synthetic Member", "1.00", 1]]);
    memberDefinition.outreachLabelIds = ["community", "food"]; memberDefinition.outreachLabelMatch = "all";
    const labelFilteredMembers = await outreachReportHandlers["outreach.members"]!(database, memberDefinition, context);
    assert.deepEqual(labelFilteredMembers.map((row) => [row.label, row.cells["outreach.member.minutes"]?.text]), [["Second Member", "1.67"], ["Synthetic Member", "1.00"]]);
    memberDefinition.outreachLabelIds = [];
    memberDefinition.columnFilters = [{ column: { key: "outreach.member.minutes", unit: "hours" }, operator: "minimum", value: "1.5" }];
    memberDefinition.sort = { column: { key: "outreach.member.minutes", unit: "hours" }, direction: "desc" };
    const ranked = await outreachReportHandlers["outreach.members"]!(database, memberDefinition, context);
    assert.deepEqual(ranked.map((row) => row.label), ["Second Member"]);
    const entries = await outreachReportHandlers["outreach.entries"]!(database, defaultReportDefinition(false, "outreach.entries"), context);
    assert.deepEqual(entries.map((row) => row.id).sort(), ["entry-1", "entry-2"]);
  } finally { database.close(); }
});

test("Outreach setup uses one-card predicates for its required independent workflow", async () => {
  const database = new Database();
  try {
    let setup = await readModuleSetup(database, "admin", "hour-tracking");
    assert.deepEqual(setup.steps.map((step) => [step.id, step.valid]), [["rules", true], ["catalog", false]]);
    const rules = await outreachSetupRoute(database, "admin", request("/module-setup/hour-tracking/rules"));
    assert.deepEqual({ ...(rules.body as { values: Record<string, number> }).values }, { reportingDays: 30, reopenHours: 24, revision: 0 });
    const saved = await outreachSetupRoute(database, "admin", request("/module-setup/hour-tracking/rules", "PUT"), { reportingDays: 45, reopenHours: 36, revision: 0 });
    assert.deepEqual(saved.body, { values: { reportingDays: 45, reopenHours: 36, revision: 1 } });
    await updateModuleSetup(database, "admin", "hour-tracking", { generation: 1, stepId: "rules", outcome: "completed" });
    await outreachSetupRoute(database, "admin", request("/module-setup/hour-tracking/catalog", "POST"), { name: "Team 9999", number: "9999", program: "FRC" });
    setup = await updateModuleSetup(database, "admin", "hour-tracking", { generation: 1, stepId: "catalog", outcome: "completed" });
    assert.equal(setup.ready, true);
  } finally { database.close(); }
});

test("Outreach catalogs preserve simplified fields without active Attendance reuse", async () => {
  const database = new Database();
  try {
    const team = await outreachCatalogRoute(database, "admin", request("/admin/hours/teams", "POST"), { name: "Team 9999", number: "09999", program: "FRC", archived: false });
    const teamId = String((team.body as { id: string }).id);
    assert.equal((team.body as { number: string }).number, "09999");
    assert.equal("historicalDescriptors" in (team.body as Record<string, unknown>), false);
    await assert.rejects(outreachCatalogRoute(database, "admin", request("/admin/hours/teams", "POST"), { name: "Invalid", historicalDescriptors: "Removed field" }), /Unknown Outreach catalog field/);
    await assert.rejects(outreachCatalogRoute(database, "admin", request("/admin/hours/teams", "POST"), { name: "Invalid", organization: "Removed field" }), /Unknown Outreach catalog field/);

    const label = await outreachCatalogRoute(database, "admin", request("/admin/hours/labels", "POST"), { name: "Food pantry", archived: false });
    const labelId = String((label.body as { id: string }).id);
    const task = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "task", labelIds: [labelId], serviceDate: "2026-09-28", teamId: null, title: "Sort donations", description: "Evening shift", location: "Community center", impactRelevant: true, archived: false });
    assert.equal((task.body as { mode: string }).mode, "task");
    assert.deepEqual((task.body as { labelIds: string[] }).labelIds, [labelId]);
    const taskId = String((task.body as { id: string }).id);
    const updatedTask = await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${taskId}`, "PATCH"), { revision: 0, description: "Updated without changing labels" });
    assert.deepEqual((updatedTask.body as { labelIds: string[] }).labelIds, [labelId]);
    await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "team", serviceDate: "2026-09-28", teamId, title: "Design review", description: "", location: "", impactRelevant: true, archived: false });
    const secondTeamActivity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "team", serviceDate: "2026-09-28", teamId, title: "Build mentoring", description: "", location: "", impactRelevant: true, archived: false });
    assert.equal((secondTeamActivity.body as { title: string }).title, "Build mentoring");
    const otherService = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "task", serviceDate: "2026-09-27", teamId: null, title: "Manual Other Service", description: "", location: "", impactRelevant: true, archived: false });
    assert.equal((otherService.body as { mode: string }).mode, "task");

    const allLabeled = await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities?labelIds=${labelId}&labelMatch=all`));
    assert.deepEqual((allLabeled.body as { items: Array<{ id: string }> }).items.map((item) => item.id), [taskId]);

    const teams = await outreachCatalogRoute(database, "admin", request("/admin/hours/teams?archived=all"));
    assert.deepEqual((teams.body as { items: Array<{ participantCount: number; countedMinutes: number }> }).items.map((item) => [item.participantCount, item.countedMinutes]), [[0, 0]]);
    await assert.rejects(outreachCatalogRoute(database, "admin", request("/admin/hours/attendance-sources")), /Outreach route not found/);
    await assert.rejects(outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-28", teamId: null, title: "Legacy reuse attempt", sourceMeetingId: "meeting-legacy", archived: false }), /Unknown Outreach catalog field/);

    database.sqlite.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES('meeting-legacy','primary','Historical meeting','2026-09-20T13:00:00Z','2026-09-20T14:00:00Z','admin','2026-09-01');
      INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,description,location,impact_relevant,source_meeting_id,source_snapshot,created_at,updated_at)
      VALUES('primary','activity-legacy','event','event','2026-09-20','Historical outreach','Original description','Library',1,'meeting-legacy','{"title":"Historical meeting","serviceDate":"2026-09-20"}','2026-09-01','2026-09-01');`);
    const updated = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities/activity-legacy", "PATCH"), { revision: 0, description: "Updated description" });
    assert.equal((updated.body as { sourceMeetingId: string }).sourceMeetingId, "meeting-legacy");
    assert.deepEqual((updated.body as { sourceSnapshot: unknown }).sourceSnapshot, { title: "Historical meeting", serviceDate: "2026-09-20" });
    assert.deepEqual({ ...database.sqlite.prepare("SELECT source_meeting_id,source_snapshot FROM hours_activities WHERE id='activity-legacy'").get() }, { source_meeting_id: "meeting-legacy", source_snapshot: '{"title":"Historical meeting","serviceDate":"2026-09-20"}' });
  } finally { database.close(); }
});

test("staff entries enforce civil time, overlap, idempotency, attribution, history, and supported-team totals", async () => {
  const database = new Database();
  try {
    const team = await outreachCatalogRoute(database, "admin", request("/admin/hours/teams", "POST"), { name: "Team 9999", number: "9999", program: "FRC", archived: false });
    const teamId = String((team.body as { id: string }).id);
    const activity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "team", serviceDate: "2026-09-28", teamId, title: "Design review", description: "", location: "Lab", impactRelevant: true, archived: false });
    const activityId = String((activity.body as { id: string }).id);
    const now = Date.parse("2026-09-28T18:00:00Z");
    const payload = { memberId: "member", activityId, serviceDate: "2026-09-28", startLocal: "09:00", endLocal: "10:00", taskNotes: "CAD review", staffReason: "Transcribed the signed event roster", idempotencyKey: "checkpoint-four-entry-1", expectedTimeZone: "America/New_York" };
    await assert.rejects(outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { ...payload, staffReason: undefined }, now), /valid Outreach entry fields/);
    const created = await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), payload, now);
    assert.equal(created.status, 201);
    const entry = created.body as { id: string; durationMinutes: number; attribution: string; channel: string };
    assert.equal(entry.durationMinutes, 60); assert.equal(entry.attribution, "staff_recorded"); assert.equal(entry.channel, "staff");
    const replay = await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), payload, now);
    assert.equal(replay.status, 200); assert.equal((replay.body as { id: string }).id, entry.id);
    await assert.rejects(outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { ...payload, endLocal: "10:05" }, now), /different Outreach input/);
    await assert.rejects(outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { ...payload, startLocal: "09:30", endLocal: "10:30", idempotencyKey: "checkpoint-four-entry-2" }, now), /overlaps already counted/);

    const history = await outreachEntryRoute(database, "admin", request(`/admin/hours/entries/${entry.id}/history`));
    assert.equal((history.body as { items: Array<{ action: string; reason: string; snapshot: { durationMinutes: number } }> }).items[0]?.action, "created");
    assert.equal((history.body as { items: Array<{ reason: string }> }).items[0]?.reason, "Transcribed the signed event roster");
    assert.equal((history.body as { items: Array<{ snapshot: { durationMinutes: number } }> }).items[0]?.snapshot.durationMinutes, 60);
    const listed = await outreachEntryRoute(database, "admin", request("/admin/hours/entries?status=all"));
    assert.equal((listed.body as { items: Array<{ staffReason: string }> }).items[0]?.staffReason, "Transcribed the signed event roster");
    const totals = await outreachEntryRoute(database, "admin", request("/admin/hours/totals"));
    assert.deepEqual((totals.body as { summary: { entries: number; participants: number; countedMinutes: number } }).summary, { entries: 1, participants: 1, countedMinutes: 60 });
    assert.deepEqual((totals.body as { teams: Array<{ participants: number; countedMinutes: number }> }).teams.map((item) => [item.participants, item.countedMinutes]), [[1, 60]]);

    const foldActivity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-11-01", teamId: null, title: "DST outreach", description: "", location: "", impactRelevant: true, archived: false });
    const foldPayload = { memberId: "member", activityId: String((foldActivity.body as { id: string }).id), serviceDate: "2026-11-01", startLocal: "01:00", endLocal: "01:30", taskNotes: "Repeated clock", staffReason: "Recovered from the event sign-in sheet", idempotencyKey: "checkpoint-four-entry-fold", expectedTimeZone: "America/New_York" };
    await assert.rejects(outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), foldPayload, Date.parse("2026-11-02T12:00:00Z")), /earlier or later occurrence/);
    const folded = await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { ...foldPayload, startOccurrence: "earlier", endOccurrence: "later" }, Date.parse("2026-11-02T12:00:00Z"));
    assert.equal((folded.body as { durationMinutes: number }).durationMinutes, 90);

    const oldActivity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "task", serviceDate: "2026-08-01", teamId: null, title: "Archived paper record", description: "", location: "", impactRelevant: true, archived: false });
    const oldPayload = { memberId: "member", activityId: String((oldActivity.body as { id: string }).id), serviceDate: "2026-08-01", startLocal: "12:00", endLocal: "12:30", taskNotes: "Paper record", staffReason: "Backfilled after staff verification", idempotencyKey: "checkpoint-four-entry-old", expectedTimeZone: "America/New_York" };
    const oldEntry = await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), oldPayload, now);
    assert.equal(oldEntry.status, 201);

    const futureActivity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-29", teamId: null, title: "Tomorrow's event", description: "", location: "", impactRelevant: true, archived: false });
    const futurePayload = { ...payload, activityId: String((futureActivity.body as { id: string }).id), serviceDate: "2026-09-29", startLocal: "09:00", endLocal: "10:00", idempotencyKey: "checkpoint-four-entry-future" };
    await assert.rejects(outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), futurePayload, now), /future service date/);
  } finally { database.close(); }
});

test("member submissions use pre-populated activities of every mode and honor explicit reopen windows", async () => {
  const database = new Database();
  try {
    const oldEvent = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-08-01", teamId: null, title: "Reopened food drive", description: "", location: "Library", impactRelevant: true, archived: false });
    const activityId = String((oldEvent.body as { id: string }).id); const now = Date.parse("2026-09-28T18:00:00Z");
    let choices = await outreachPublicRoute(database, publicRequest("/public/hours/activities?mode=event"), "https://synthetic.test", undefined, now);
    assert.deepEqual((choices.body as { items: unknown[] }).items, []);
    database.sqlite.prepare(`INSERT INTO hours_reopen_windows(installation_id,id,activity_id,starts_ms,expires_ms,reason,actor_user_id,created_at,updated_at)
      VALUES('primary','window-1',?,?,?,?,?,'2026-09-28T17:59:00Z','2026-09-28T17:59:00Z')`).run(activityId, now - 60_000, now + 3_600_000, "Late paper sign-in", "admin");
    choices = await outreachPublicRoute(database, publicRequest("/public/hours/activities?mode=event"), "https://synthetic.test", undefined, now);
    assert.deepEqual((choices.body as { items: Array<{ id: string; reopened: boolean }> }).items.map((item) => [item.id, item.reopened]), [[activityId, true]]);

    const eventPayload = { memberExternalId: "1001", activityId, serviceDate: "2026-08-01", startLocal: "09:00", endLocal: "10:00", taskNotes: "Food drive", idempotencyKey: "checkpoint-five-public-event", expectedTimeZone: "America/New_York" };
    const created = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", eventPayload, now);
    assert.equal(created.status, 201); assert.equal((created.body as { durationMinutes: number }).durationMinutes, 60); assert.equal("memberId" in (created.body as Record<string, unknown>), false);
    const replay = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", eventPayload, now);
    assert.equal(replay.status, 200); assert.equal((replay.body as { id: string }).id, (created.body as { id: string }).id);

    const taskActivity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "task", serviceDate: "2026-09-28", teamId: null, title: "Donation sorting", description: "", location: "Warehouse", impactRelevant: true, archived: false });
    const taskActivityId = String((taskActivity.body as { id: string }).id);
    const futureActivity = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-29", teamId: null, title: "Future event", description: "", location: "", impactRelevant: true, archived: false });
    const currentActivities = await outreachPublicRoute(database, publicRequest("/public/hours/activities"), "https://synthetic.test", undefined, now);
    assert.equal((currentActivities.body as { items: Array<{ id: string; mode: string }> }).items.some((item) => item.id === taskActivityId && item.mode === "task"), true);
    assert.equal((currentActivities.body as { items: Array<{ id: string }> }).items.some((item) => item.id === String((futureActivity.body as { id: string }).id)), false);
    const legacyAlias = await outreachPublicRoute(database, publicRequest("/public/hours/events"), "https://synthetic.test", undefined, now);
    assert.equal((legacyAlias.body as { items: Array<{ id: string }> }).items.some((item) => item.id === taskActivityId), true);
    const task = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", { memberExternalId: "1001", activityId: taskActivityId, serviceDate: "2026-09-28", startLocal: "11:00", endLocal: "11:30", taskNotes: "Donation sorting", idempotencyKey: "checkpoint-five-public-task", expectedTimeZone: "America/New_York" }, now);
    assert.equal(task.status, 201); assert.equal((task.body as { durationMinutes: number }).durationMinutes, 30);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_activities WHERE category_id='other-service' AND service_date='2026-09-28'").get()?.count, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_entries WHERE channel='public' AND attribution='self_asserted'").get()?.count, 2);

    const missingActivity = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", { memberExternalId: "1001", serviceDate: "2026-09-28", startLocal: "12:00", endLocal: "12:30", taskNotes: "Not pre-populated", idempotencyKey: "checkpoint-five-missing-activity", expectedTimeZone: "America/New_York" }, now);
    assert.equal(missingActivity.status, 400); assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_activities WHERE category_id='other-service' AND service_date='2026-09-28'").get()?.count, 1);

    const oldTask = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "task", serviceDate: "2026-08-02", teamId: null, title: "Reopened donation sorting", description: "", location: "Warehouse", impactRelevant: true, archived: false });
    const oldTaskId = String((oldTask.body as { id: string }).id);
    await outreachReviewRoute(database, "admin", request("/admin/hours/reopen-windows", "POST"), { activityId: oldTaskId, hours: 12, reason: "Late form availability", settingsRevision: 0 }, now);
    const reopenedTaskChoices = await outreachPublicRoute(database, publicRequest("/public/hours/activities?mode=task"), "https://synthetic.test", undefined, now);
    assert.deepEqual((reopenedTaskChoices.body as { items: Array<{ id: string; mode: string; reopened: boolean }> }).items.filter((item) => item.id === oldTaskId).map((item) => [item.id, item.mode, item.reopened]), [[oldTaskId, "task", true]]);
    const reopenedTask = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", { memberExternalId: "1001", activityId: oldTaskId, serviceDate: "2026-08-02", startLocal: "13:00", endLocal: "13:30", taskNotes: "Old activity", idempotencyKey: "checkpoint-five-public-old-task", expectedTimeZone: "America/New_York" }, now);
    assert.equal(reopenedTask.status, 201);

    const rejected = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", { ...eventPayload, memberExternalId: "unknown", idempotencyKey: "checkpoint-five-public-unknown" }, now);
    assert.equal(rejected.status, 400); assert.equal((rejected.body as { code: string }).code, "identity_not_verified");
    await assert.rejects(outreachPublicRoute(database, new Request("https://synthetic.test/public/hours/entries", { method: "POST", headers: { origin: "https://other.test" } }), "https://synthetic.test", eventPayload, now), /published LancerLogin submission page/);
  } finally { database.close(); }
});

test("reporting windows and correction decisions preserve an immutable accounting history", async () => {
  const database = new Database();
  try {
    const now = Date.parse("2026-09-28T18:00:00Z");
    const oldEvent = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-08-01", teamId: null, title: "Older community drive", description: "", location: "Library", impactRelevant: true, archived: false });
    const oldActivityId = String((oldEvent.body as { id: string }).id);
    const opened = await outreachReviewRoute(database, "admin", request("/admin/hours/reopen-windows", "POST"), { activityId: oldActivityId, hours: 12, reason: "Late paper sign-in", settingsRevision: 0 }, now);
    assert.equal(opened.status, 201);
    let choices = await outreachPublicRoute(database, publicRequest("/public/hours/activities?mode=event"), "https://synthetic.test", undefined, now);
    assert.deepEqual((choices.body as { items: Array<{ id: string; reopened: boolean }> }).items.map((item) => [item.id, item.reopened]), [[oldActivityId, true]]);
    const windows = await outreachReviewRoute(database, "admin", request("/admin/hours/reopen-windows?limit=100"), undefined, now);
    const window = (windows.body as { items: Array<{ id: string; active: boolean; revision: number }> }).items[0]!;
    assert.equal(window.active, true);
    await outreachReviewRoute(database, "admin", request(`/admin/hours/reopen-windows/${window.id}`, "PATCH"), { revision: window.revision, revoked: true }, now);
    choices = await outreachPublicRoute(database, publicRequest("/public/hours/activities?mode=event"), "https://synthetic.test", undefined, now);
    assert.deepEqual((choices.body as { items: unknown[] }).items, []);

    const currentEvent = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-28", teamId: null, title: "Community open house", description: "", location: "School", impactRelevant: true, archived: false });
    const activityId = String((currentEvent.body as { id: string }).id);
    const entry = await outreachPublicRoute(database, publicRequest("/public/hours/entries", "POST"), "https://synthetic.test", { memberExternalId: "1001", activityId, serviceDate: "2026-09-28", startLocal: "09:00", endLocal: "10:00", taskNotes: "Greeting visitors", idempotencyKey: "checkpoint-five-corrected-entry", expectedTimeZone: "America/New_York" }, now);
    const entryId = String((entry.body as { id: string }).id);
    const correctionPayload = { memberExternalId: "1001", receiptId: entryId, serviceDate: "2026-09-28", message: "I stayed until 10:30.", idempotencyKey: "checkpoint-five-correction-request-one" };
    const requested = await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", correctionPayload, now);
    assert.equal(requested.status, 202);
    const replay = await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", correctionPayload, now);
    assert.equal(replay.status, 200); assert.equal((replay.body as { reference: string }).reference, (requested.body as { reference: string }).reference);
    let corrections = await outreachReviewRoute(database, "admin", request("/admin/hours/corrections?status=open&limit=100"));
    const correction = (corrections.body as { items: Array<{ id: string; revision: number; entryRevision: number }> }).items[0]!;
    await outreachReviewRoute(database, "admin", request(`/admin/hours/corrections/${correction.id}/resolve`, "POST"), { action: "corrected", note: "Verified against the event lead's sign-out sheet.", requestRevision: correction.revision, entryRevision: correction.entryRevision, memberId: "member", activityId, startLocal: "09:00", endLocal: "10:30", taskNotes: "Greeting visitors and cleanup" }, now + 60_000);
    let totals = await outreachEntryRoute(database, "admin", request("/admin/hours/totals"));
    assert.deepEqual((totals.body as { summary: object }).summary, { entries: 1, participants: 1, countedMinutes: 90 });
    let history = await outreachEntryRoute(database, "admin", request(`/admin/hours/entries/${entryId}/history`));
    assert.deepEqual((history.body as { items: Array<{ revision: number; action: string }> }).items.map((item) => [item.revision, item.action]), [[0, "created"], [1, "corrected"]]);

    const voidPayload = { memberExternalId: "1001", receiptId: entryId, message: "This entry belongs to a different day.", idempotencyKey: "checkpoint-five-correction-request-two" };
    await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", voidPayload, now + 120_000);
    corrections = await outreachReviewRoute(database, "admin", request("/admin/hours/corrections?status=open&limit=100"));
    const voidRequest = (corrections.body as { items: Array<{ id: string; revision: number; entryRevision: number }> }).items[0]!;
    await outreachReviewRoute(database, "admin", request(`/admin/hours/corrections/${voidRequest.id}/resolve`, "POST"), { action: "voided", note: "Member and lead confirmed the mistaken receipt.", requestRevision: voidRequest.revision, entryRevision: voidRequest.entryRevision }, now + 180_000);
    totals = await outreachEntryRoute(database, "admin", request("/admin/hours/totals"));
    assert.deepEqual((totals.body as { summary: object }).summary, { entries: 0, participants: 0, countedMinutes: 0 });
    history = await outreachEntryRoute(database, "admin", request(`/admin/hours/entries/${entryId}/history`));
    assert.deepEqual((history.body as { items: Array<{ revision: number; action: string }> }).items.map((item) => [item.revision, item.action]), [[0, "created"], [1, "corrected"], [2, "voided"]]);
    assert.throws(() => database.sqlite.prepare("UPDATE hours_entry_revisions SET reason='rewritten' WHERE entry_id=? AND revision=1").run(entryId), /hours_entry_revision_immutable/);

    const noReceipt = await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", { memberExternalId: "1001", serviceDate: "2026-09-28", message: "Please review my handwritten record.", idempotencyKey: "checkpoint-five-correction-no-receipt" }, now + 240_000);
    assert.equal(noReceipt.status, 400); assert.equal((noReceipt.body as { code: string }).code, "input_not_accepted");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_correction_requests WHERE key_hash IS NOT NULL AND status='open'").get()?.count, 0);

    const allEntries = await outreachEntryRoute(database, "admin", request("/admin/hours/entries?status=all&limit=100"));
    assert.equal((allEntries.body as { items: Array<{ id: string; status: string }> }).items.some((item) => item.id === entryId && item.status === "void"), true);
  } finally { database.close(); }
});

test("linked Discord commands share Outreach submission and correction authority", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("UPDATE platform_modules SET setup_complete=1 WHERE module_id='hour-tracking'; UPDATE members SET discord_user_id='323456789012345678' WHERE id='member'");
    await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-28", teamId: null, title: "Discord service day", description: "", location: "Library", impactRelevant: true, archived: false });
    const now = Date.parse("2026-09-28T18:00:00Z"); const interaction = { id: "423456789012345678", type: 2, data: { name: "outreach-submit", options: [{ name: "activity", value: "Discord service day" }, { name: "start", value: "09:00" }, { name: "end", value: "10:00" }, { name: "notes", value: "Sorted supplies" }] }, member: { user: { id: "323456789012345678" } } };
    const message = await dispatchModuleDiscordCommand(database, interaction, now);
    assert.match(String(message), /Participation recorded: 60 minutes/); const receipt = String(message).match(/Receipt: ([0-9a-f-]+)/)?.[1]; assert.ok(receipt);
    assert.match(String(await dispatchModuleDiscordCommand(database, interaction, now)), /already recorded/);
    assert.equal(database.sqlite.prepare("SELECT channel FROM hours_entries WHERE id=?").get(receipt)?.channel, "discord");
    const correction = { id: "523456789012345678", type: 2, data: { name: "outreach-correction", options: [{ name: "message", value: "I stayed longer." }, { name: "receipt", value: receipt }] }, member: { user: { id: "323456789012345678" } } };
    const correctionMessage = await dispatchModuleDiscordCommand(database, correction, now + 60_000);
    assert.match(String(correctionMessage), /Correction request received/);
    assert.equal(database.sqlite.prepare("SELECT channel FROM hours_correction_requests WHERE entry_id=?").get(receipt)?.channel, "discord");
  } finally { database.close(); }
});

test("Event publication defaults off, supports explicit and automatic queues, and cleans up provider ownership", async () => {
  const database = new Database();
  const published: Array<{ provider: OutreachPublicationProvider; event: OutreachPublicationEvent; externalId?: string }> = [];
  const removed: Array<{ provider: OutreachPublicationProvider; externalId: string }> = [];
  let failDiscord = true;
  const providers: OutreachPublicationProviders = {
    status: async () => ({ google_calendar: true, discord: true }),
    publish: async (provider, event, externalId) => { published.push({ provider, event, externalId }); if (provider === "discord" && failDiscord) throw new Error("Synthetic Discord outage"); return externalId ?? `${provider}-${event.activityId}`; },
    remove: async (provider, externalId) => { removed.push({ provider, externalId }); },
  };
  try {
    const now = Date.parse("2026-09-28T18:00:00Z");
    assert.deepEqual(await outreachPublicationRoute(database, providers, "admin", request("/admin/hours/publication-settings"), undefined, now), { status: 200, body: { automatic: false, revision: 0 } });

    const unscheduled = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-30", teamId: null, title: "Future service fair", description: "Meet community partners", location: "Gym", impactRelevant: true, archived: false }, providers, now);
    const activityId = String((unscheduled.body as { id: string }).id);
    await assert.rejects(outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${activityId}/publication`, "POST"), { activityRevision: 0, publicationRevision: null, provider: "invalid" }, now), /supported publication destination/);
    const scheduled = await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${activityId}`, "PATCH"), { revision: 0, eventStartLocal: "17:00", eventEndLocal: "19:00" }, providers, now);
    assert.equal((scheduled.body as { revision: number }).revision, 1);
    const queued = await outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${activityId}/publication`, "POST"), { activityRevision: 1, publicationRevision: null }, now);
    assert.equal(queued.status, 202); assert.deepEqual(published, []);
    assert.deepEqual(await processOutreachPublicationOperations(database, providers, now + 60_000), { delivered: 1, failed: 1, pending: 0 });
    let listed = await outreachPublicationRoute(database, providers, "admin", request("/admin/hours/publications")); let item = (listed.body as { items: Array<{ googleStatus: string; discordStatus: string; discordError: string }> }).items[0]!;
    assert.equal(item.googleStatus, "delivered"); assert.equal(item.discordStatus, "failed"); assert.match(item.discordError, /Synthetic Discord outage/);
    await outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${activityId}/publication/retry`, "POST"), { revision: 0, provider: "discord" }, now + 120_000);
    failDiscord = false; assert.deepEqual(await processOutreachPublicationOperations(database, providers, now + 180_000), { delivered: 1, failed: 0, pending: 0 });

    await outreachPublicationRoute(database, providers, "admin", request("/admin/hours/publication-settings", "PATCH"), { automatic: true, revision: 0 }, now);
    await assert.rejects(outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-10-01", teamId: null, title: "Missing schedule", description: "", location: "", impactRelevant: true, eventStartLocal: "09:00", archived: false }, providers, now), /event start time/);
    const historical = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-20", teamId: null, title: "Historical backfill", description: "", location: "", impactRelevant: true, archived: false }, providers, now);
    assert.equal((historical.body as { publicationQueue: { reason: string } }).publicationQueue.reason, "not_eligible");
    const pastScheduled = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-20", teamId: null, title: "Historical scheduled backfill", description: "", location: "", impactRelevant: true, eventStartLocal: "09:00", eventEndLocal: "10:00", archived: false }, providers, now);
    assert.equal((pastScheduled.body as { publicationQueue: { reason: string } }).publicationQueue.reason, "not_eligible");
    for (const past of [historical, pastScheduled]) {
      const id = String((past.body as { id: string }).id);
      const result = await outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${id}/publication`, "POST"), { activityRevision: 0, publicationRevision: null, provider: "google_calendar" }, now);
      assert.equal(result.status, 202);
      await assert.rejects(outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${id}/publication`, "POST"), { activityRevision: 0, publicationRevision: 0, provider: "discord" }, now), /future/);
    }
    assert.deepEqual(await processOutreachPublicationOperations(database, providers, now + 190_000), { delivered: 2, failed: 0, pending: 0 });
    const task = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "task", serviceDate: "2026-10-01", teamId: null, title: "Never published", description: "", location: "", impactRelevant: true, archived: false }, providers, now);
    assert.equal("publicationQueue" in (task.body as Record<string, unknown>), false);

    const automatic = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-10-02", teamId: null, title: "Automatic event", description: "", location: "Field", impactRelevant: true, eventStartLocal: "17:00", eventEndLocal: "18:00", archived: false }, providers, now);
    const automaticId = String((automatic.body as { id: string }).id); assert.deepEqual((automatic.body as { publicationQueue: { queuedProviders: string[] } }).publicationQueue.queuedProviders, ["google_calendar", "discord"]);
    assert.deepEqual(await processOutreachPublicationOperations(database, providers, now + 240_000), { delivered: 2, failed: 0, pending: 0 });
    const updated = await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${automaticId}`, "PATCH"), { revision: 0, title: "Automatic event updated" }, providers, now + 300_000);
    assert.equal((updated.body as { publicationQueue: { revision: number } }).publicationQueue.revision, 1);
    await processOutreachPublicationOperations(database, providers, now + 360_000);
    assert.equal(published.filter((entry) => entry.event.activityId === automaticId && entry.externalId).length, 2);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${automaticId}`, "PATCH"), { revision: 1, archived: true }, providers, now + 420_000);
    assert.deepEqual(await processOutreachPublicationOperations(database, providers, now + 480_000), { delivered: 2, failed: 0, pending: 0 });
    assert.deepEqual(removed.map((entry) => entry.provider).sort(), ["discord", "google_calendar"]);

    const beforeArchive = published.length;
    const pending = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-10-03", teamId: null, title: "Archive before delivery", description: "", location: "", impactRelevant: true, eventStartLocal: "17:00", eventEndLocal: "18:00", archived: false }, providers, now);
    const pendingId = String((pending.body as { id: string }).id);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${pendingId}`, "PATCH"), { revision: 0, archived: true }, providers, now + 1_000);
    await processOutreachPublicationOperations(database, providers, now + 60_000);
    assert.equal(published.length, beforeArchive); assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_publication_operations WHERE activity_id=? AND action='publish' AND status='failed' AND next_attempt_at IS NULL").get(pendingId)?.count, 2);

    const racing = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-10-03", teamId: null, title: "Processing archive guard", description: "", location: "", impactRelevant: true, eventStartLocal: "19:00", eventEndLocal: "20:00", archived: false }, providers, now);
    const racingId = String((racing.body as { id: string }).id);
    database.sqlite.prepare("UPDATE hours_publication_operations SET status='processing',lease_token='synthetic-lease',lease_expires_at='2026-09-28T20:00:00Z' WHERE activity_id=? AND provider='google_calendar'").run(racingId);
    await assert.rejects(outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${racingId}`, "PATCH"), { revision: 0, archived: true }, providers, now + 2_000), /Outreach record changed/);
    assert.equal(database.sqlite.prepare("SELECT archived FROM hours_activities WHERE id=?").get(racingId)?.archived, 0);
    database.sqlite.prepare("UPDATE hours_publication_operations SET status='pending',lease_token=NULL,lease_expires_at=NULL WHERE activity_id=? AND provider='google_calendar'").run(racingId);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${racingId}`, "PATCH"), { revision: 0, archived: true }, providers, now + 3_000);

    const unavailable: OutreachPublicationProviders = { status: async () => { throw new Error("Synthetic status outage"); }, publish: providers.publish, remove: providers.remove };
    const saved = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-10-04", teamId: null, title: "Saved despite queue outage", description: "", location: "", impactRelevant: true, eventStartLocal: "17:00", eventEndLocal: "18:00", archived: false }, unavailable, now);
    assert.equal((saved.body as { publicationQueue: { reason: string } }).publicationQueue.reason, "queue_failed");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM hours_activities WHERE title='Saved despite queue outage'").get()?.count, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='outreach.publication_queue_failed'").get()?.count, 1);

    listed = await outreachPublicationRoute(database, providers, "admin", request("/admin/hours/publications")); item = (listed.body as { items: Array<{ activityId: string; googleAction: string }> }).items.find((entry) => entry.activityId === automaticId)!;
    assert.equal(item.googleAction, "delete");
    assert.throws(() => database.sqlite.prepare("UPDATE hours_activity_publications SET reviewed_by_user_id=NULL,revision=revision+1 WHERE activity_id=?").run(activityId), /hours_activity_publication_transition/);
  } finally { database.close(); }
});

test("event edits preserve submitted dates, times, hours and immutable revisions", async () => {
  const database = new Database(); const now = Date.parse("2026-09-28T18:00:00Z");
  try {
    const created = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-28", teamId: null, title: "Original event", description: "Original", location: "Library", impactRelevant: true, archived: false, eventStartLocal: "09:00", eventEndLocal: "10:00" }, undefined, now);
    const id = String((created.body as { id: string }).id);
    await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { memberId: "member", activityId: id, serviceDate: "2026-09-28", startLocal: "09:00", endLocal: "10:00", taskNotes: "Service", staffReason: "Verified attendance", idempotencyKey: "synthetic-preserved-entry", expectedTimeZone: "America/New_York" }, now);
    const entries = database.sqlite.prepare("SELECT * FROM hours_entries").all(); const revisions = database.sqlite.prepare("SELECT * FROM hours_entry_revisions").all();
    const updated = await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 0, title: "Edited event", serviceDate: "2026-09-27", description: "Edited", location: "Museum", impactRelevant: false, archived: true, labelIds: [], eventStartLocal: "12:00", eventEndLocal: "14:00" }, undefined, now);
    assert.equal((updated.body as { title: string }).title, "Edited event"); assert.deepEqual(database.sqlite.prepare("SELECT * FROM hours_entries").all(), entries); assert.deepEqual(database.sqlite.prepare("SELECT * FROM hours_entry_revisions").all(), revisions);
    const list = await outreachEntryRoute(database, "admin", request(`/admin/hours/entries?activityId=${id}&status=all`)); assert.equal((list.body as { items: { durationMinutes: number; serviceDate: string }[] }).items[0]?.durationMinutes, 60); assert.equal((list.body as { items: { serviceDate: string }[] }).items[0]?.serviceDate, "2026-09-28");
    const correction = await outreachPublicRoute(database, publicRequest("/public/hours/corrections", "POST"), "https://synthetic.test", { memberExternalId: "1001", activityId: id, message: "Correct the ending time", idempotencyKey: "synthetic-preserved-correction" }, now);
    const reference = String((correction.body as { reference: string }).reference);
    await outreachReviewRoute(database, "admin", request(`/admin/hours/corrections/${reference}/resolve`, "POST"), { action: "corrected", note: "Reviewed original service date", requestRevision: 0, entryId: String(entries[0]!.id), entryRevision: 0, endLocal: "10:30" }, now);
    const corrected = database.sqlite.prepare("SELECT service_date,duration_minutes FROM hours_entries").get(); assert.equal(corrected?.service_date, "2026-09-28"); assert.equal(corrected?.duration_minutes, 90);
    for (const program of [undefined, "", "FIRST", "FRC custom"]) await assert.rejects(outreachCatalogRoute(database, "admin", request("/admin/hours/teams", "POST"), { name: "Invalid team", program }), /Choose Explore/);
    for (const program of ["Explore", "Challenge", "FTC", "FRC"]) assert.equal((await outreachCatalogRoute(database, "admin", request("/admin/hours/teams", "POST"), { name: `${program} team`, program })).status, 201);
  } finally { database.close(); }
});

test("activity type changes preserve entries, require an active team and clean up Event publication", async () => {
  const database = new Database(); const now = Date.parse("2026-09-28T18:00:00Z"); const removed: string[] = [];
  const providers: OutreachPublicationProviders = { status: async () => ({ google_calendar: true, discord: false }), publish: async () => "synthetic-published-event", remove: async (_provider, id) => { removed.push(id); } };
  try {
    const created = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-28", teamId: null, title: "Convertible service", eventStartLocal: "19:00", eventEndLocal: "20:00", archived: false }, providers, now);
    const id = String((created.body as { id: string }).id);
    await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { memberId: "member", activityId: id, serviceDate: "2026-09-28", startLocal: "09:00", endLocal: "10:00", taskNotes: "Service", staffReason: "Verified", idempotencyKey: "synthetic-convert-entry", expectedTimeZone: "America/New_York" }, now);
    const original = database.sqlite.prepare("SELECT * FROM hours_entries").all();
    await outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${id}/publication`, "POST"), { activityRevision: 0, publicationRevision: null }, now); await processOutreachPublicationOperations(database, providers, now + 1000);
    const pending = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate: "2026-09-28", teamId: null, title: "Pending Event conversion", eventStartLocal: "19:00", eventEndLocal: "20:00" }, providers, now);
    const pendingId = String((pending.body as { id: string }).id);
    await outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${pendingId}/publication`, "POST"), { activityRevision: 0, publicationRevision: null }, now);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${pendingId}`, "PATCH"), { revision: 0, mode: "task" }, providers, now + 1000);
    assert.equal(database.sqlite.prepare("SELECT status FROM hours_publication_operations WHERE activity_id=?").get(pendingId)?.status, "failed"); assert.deepEqual(await processOutreachPublicationOperations(database, providers, now + 1500), { delivered: 0, failed: 0, pending: 0 });
    const team = await outreachCatalogRoute(database, "admin", request("/admin/hours/teams", "POST"), { name: "Synthetic FTC", program: "FTC", archived: false }); const teamId = String((team.body as { id: string }).id);
    await assert.rejects(outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 0, mode: "team" }, providers, now), /requires a supported team/);
    const converted = await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 0, mode: "team", teamId, serviceDate: "2026-09-27" }, providers, now + 2000);
    assert.equal((converted.body as { eventStartLocal: string | null }).eventStartLocal, null); assert.deepEqual(database.sqlite.prepare("SELECT * FROM hours_entries").all(), original);
    await processOutreachPublicationOperations(database, providers, now + 3000); assert.deepEqual(removed, ["synthetic-published-event"]);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 1, mode: "task", teamId: null }, providers, now + 4000);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 2, mode: "event", serviceDate: "2026-09-28", eventStartLocal: "19:00", eventEndLocal: "20:00" }, providers, now + 5000);
    await assert.rejects(outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 0, mode: "task" }, providers, now), /record changed/); assert.deepEqual(database.sqlite.prepare("SELECT * FROM hours_entries").all(), original);
    await outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${id}/publication`, "POST"), { activityRevision: 3, publicationRevision: 1 }, now + 6000);
    database.sqlite.prepare("UPDATE hours_publication_operations SET status='processing',lease_token='synthetic-lease',lease_expires_at='2026-09-28T20:00:00Z' WHERE activity_id=? AND status='pending'").run(id);
    await assert.rejects(outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 3, mode: "task" }, providers, now), /record changed/); assert.equal(database.sqlite.prepare("SELECT mode FROM hours_activities WHERE id=?").get(id)?.mode, "event");
  } finally { database.close(); }
});

async function batchActivity(database: Database, serviceDate: string, now: number, title = "Synthetic batch event") {
  const result = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate, teamId: null, title, description: "", location: "Library", impactRelevant: true, archived: false }, undefined, now);
  return String((result.body as { id: string }).id);
}

test("direct participation edits and deletion retain provenance, revisions and overlap protection", async () => {
  const database = new Database(); const now = Date.parse("2026-10-13T18:00:00Z");
  try {
    const activityId = await batchActivity(database, "2026-10-12", now);
    const payload = { memberId: "member", activityId, serviceDate: "2026-10-12", startLocal: "09:00", endLocal: "10:00", taskNotes: "Original notes", staffReason: "Recovered sheet", idempotencyKey: "synthetic-direct-entry-1", expectedTimeZone: "America/New_York" };
    const created = (await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), payload, now)).body as { id: string };
    await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { ...payload, startLocal: "11:00", endLocal: "12:00", idempotencyKey: "synthetic-direct-entry-2" }, now);
    const path = `/admin/hours/entries/${created.id}`;
    await assert.rejects(outreachEntryRoute(database, "admin", request(path, "PATCH"), { revision: 0, action: "corrected", endLocal: "11:30", reason: "Checked sheet" }, now), /overlaps/);
    await assert.rejects(outreachEntryRoute(database, "admin", request(path, "PATCH"), { revision: 0, action: "corrected", reason: "Checked sheet", attribution: "self_asserted" }, now), /supported entry edit/);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${activityId}`, "PATCH"), { revision: 0, serviceDate: "2026-10-11" }, undefined, now);
    const edited = (await outreachEntryRoute(database, "admin", request(path, "PATCH"), { revision: 0, action: "corrected", endLocal: "10:30", taskNotes: "Corrected notes", reason: "Checked sheet" }, now)).body as Record<string, unknown>;
    assert.equal(edited.serviceDate, "2026-10-12"); assert.equal(edited.durationMinutes, 90); assert.equal(edited.revision, 1); assert.equal(edited.attribution, "staff_recorded"); assert.equal(edited.staffReason, "Recovered sheet");
    await assert.rejects(outreachEntryRoute(database, "admin", request(path, "PATCH"), { revision: 0, action: "voided", reason: "Duplicate" }, now), /entry changed/);
    const removed = (await outreachEntryRoute(database, "admin", request(path, "PATCH"), { revision: 1, action: "voided", reason: "Duplicate" }, now)).body as Record<string, unknown>;
    assert.equal(removed.status, "void"); assert.equal(removed.revision, 2);
    const history = (await outreachEntryRoute(database, "admin", request(`${path}/history`))).body as { items: Array<{ action: string; reason: string }> };
    assert.deepEqual(history.items.map(item => item.action), ["created", "corrected", "voided"]); assert.equal(history.items[2]!.reason, "Duplicate");
    const totals = (await outreachEntryRoute(database, "admin", request("/admin/hours/totals"))).body as { summary: { countedMinutes: number } }; assert.equal(totals.summary.countedMinutes, 60);
    await assert.rejects(outreachEntryRoute(database, "admin", request(path, "PATCH"), { revision: 2, action: "corrected", reason: "Change" }, now), /entry changed/);
  } finally { database.close(); }
});

test("submission log pages newest logged entries with stable ties independently of service dates", async () => {
  const database = new Database(); const now = Date.parse("2026-10-13T18:00:00Z");
  try {
    const older = await batchActivity(database, "2026-09-10", now); const newer = await batchActivity(database, "2026-10-12", now);
    const ids: string[] = [];
    for (const [index, activityId, serviceDate, startLocal] of [[0, newer, "2026-10-12", "09:00"], [1, older, "2026-09-10", "09:00"], [2, older, "2026-09-10", "11:00"]] as const) {
      const result = await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { memberId: "member", activityId, serviceDate, startLocal, endLocal: startLocal === "11:00" ? "12:00" : "10:00", taskNotes: "", staffReason: "Verified", idempotencyKey: `synthetic-log-entry-${index}`, expectedTimeZone: "America/New_York" }, now + (index ? 1000 : 0)); ids.push((result.body as { id: string }).id);
    }
    const ordered = [ids[1]!, ids[2]!].sort().reverse().concat(ids[0]!); const seen: string[] = []; let cursor: string | null = null;
    do { const page = (await outreachEntryRoute(database, "admin", request(`/admin/hours/entries?order=logged-desc&limit=1${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`))).body as { items: Array<{ id: string }>; nextCursor: string | null }; seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(seen, ordered);
    await assert.rejects(outreachEntryRoute(database, "admin", request("/admin/hours/entries?order=logged-desc&after=invalid")), /cursor/);
  } finally { database.close(); }
});

test("reporting can reopen in its last 24 hours and resets expiry from the action time", async () => {
  const database = new Database(); const now = Date.parse("2026-10-13T18:00:00Z");
  try {
    const id = await batchActivity(database, "2026-09-14", now); // Default closes at Oct 14 midnight in New York.
    const body = { activityId: id, hours: 24, reason: "Reporting reopened for 24 hours", settingsRevision: 0 };
    const result = await outreachReviewRoute(database, "admin", request("/admin/hours/reopen-windows", "POST"), body, now);
    assert.equal((result.body as { expiresMs: number }).expiresMs, now + 86_400_000);
    await assert.rejects(outreachReviewRoute(database, "admin", request("/admin/hours/reopen-windows", "POST"), body, now), /fewer than 24 hours/);
    const again = await outreachReviewRoute(database, "admin", request("/admin/hours/reopen-windows", "POST"), body, now + 1000); assert.equal((again.body as { expiresMs: number }).expiresMs, now + 1000 + 86_400_000);
    const recent = await batchActivity(database, "2026-10-12", now);
    await assert.rejects(outreachReviewRoute(database, "admin", request("/admin/hours/reopen-windows", "POST"), { ...body, activityId: recent }, now), /fewer than 24 hours/);
  } finally { database.close(); }
});

test("catalog search and pagination expose accurate active and archived counts", async () => {
  const database = new Database();
  try {
    for (let index = 0; index < 105; index++) database.sqlite.prepare("INSERT INTO hours_labels(installation_id,id,name,archived,created_at,updated_at) VALUES('primary',?,?,?,'2026-10-13','2026-10-13')").run(`label-${String(index).padStart(3, "0")}`, `Synthetic label ${index}`, Number(index === 104));
    const first = (await outreachCatalogRoute(database, "admin", request("/admin/hours/labels?limit=20"))).body as { items: unknown[]; nextCursor: string; total: number; activeCount: number; archivedCount: number };
    assert.equal(first.items.length, 20); assert.equal(first.total, 104); assert.equal(first.activeCount, 104); assert.equal(first.archivedCount, 1);
    const second = (await outreachCatalogRoute(database, "admin", request(`/admin/hours/labels?limit=20&after=${first.nextCursor}`))).body as { total: number }; assert.equal(second.total, 104);
    const searched = (await outreachCatalogRoute(database, "admin", request("/admin/hours/labels?q=LABEL%20103"))).body as { items: Array<{ name: string }>; total: number }; assert.equal(searched.total, 1); assert.equal(searched.items[0]!.name, "Synthetic label 103");
    const archived = (await outreachCatalogRoute(database, "admin", request("/admin/hours/labels?archived=true"))).body as { total: number }; assert.equal(archived.total, 1);
  } finally { database.close(); }
});

test("destination publication retains independent event snapshots, all-day dates and removal state", async () => {
  const database = new Database(); const now = Date.parse("2026-10-13T18:00:00Z");
  const sent: Array<{ provider: string; event: OutreachPublicationEvent }> = []; const removed: string[] = [];
  const providers: OutreachPublicationProviders = { status: async () => ({ google_calendar: true, discord: true }), publish: async (provider, event) => { sent.push({ provider, event }); return `synthetic-${provider}`; }, remove: async provider => { removed.push(provider); } };
  try {
    const id = await batchActivity(database, "2026-11-01", now, "Original all-day title"); const path = `/admin/hours/activities/${id}/publication`;
    await outreachPublicationRoute(database, providers, "admin", request(path, "POST"), { activityRevision: 0, publicationRevision: null, provider: "google_calendar" }, now);
    await outreachCatalogRoute(database, "admin", request(`/admin/hours/activities/${id}`, "PATCH"), { revision: 0, title: "Discord-only title", eventStartLocal: "10:00", eventEndLocal: "11:00" }, undefined, now);
    await outreachPublicationRoute(database, providers, "admin", request(path, "POST"), { activityRevision: 1, publicationRevision: 0, provider: "discord" }, now);
    assert.deepEqual(await processOutreachPublicationOperations(database, providers, now + 1000), { delivered: 2, failed: 0, pending: 0 });
    const google = sent.find(item => item.provider === "google_calendar")!.event; const discord = sent.find(item => item.provider === "discord")!.event;
    const allDayPayload = outreachGoogleEventPayload(google); const timedPayload = outreachGoogleEventPayload(discord);
    assert.deepEqual(allDayPayload.start, { date: "2026-11-01", dateTime: null, timeZone: null }); assert.deepEqual(allDayPayload.end, { date: "2026-11-02", dateTime: null, timeZone: null });
    assert.deepEqual(timedPayload.start, { date: null, dateTime: discord.startsAt, timeZone: "America/New_York" }); assert.deepEqual(timedPayload.end, { date: null, dateTime: discord.endsAt, timeZone: "America/New_York" });
    assert.equal(google.title, "Original all-day title"); assert.equal(google.allDay, true); assert.equal(google.serviceDate, "2026-11-01"); assert.equal(Date.parse(google.endsAt) - Date.parse(google.startsAt), 25 * 3_600_000); assert.equal(discord.title, "Discord-only title"); assert.equal(discord.allDay, false);
    await outreachPublicationRoute(database, providers, "admin", request(path, "POST"), { activityRevision: 1, publicationRevision: 1, provider: "google_calendar", action: "delete" }, now + 2000);
    await processOutreachPublicationOperations(database, providers, now + 3000); assert.deepEqual(removed, ["google_calendar"]); assert.equal(sent.length, 2);
    const listed = (await outreachPublicationRoute(database, providers, "admin", request("/admin/hours/publications"))).body as { items: Array<{ googleAction: string; googleStatus: string; discordAction: string; discordStatus: string }> }; assert.equal(listed.items[0]!.googleAction, "delete"); assert.equal(listed.items[0]!.googleStatus, "delivered"); assert.equal(listed.items[0]!.discordStatus, "delivered"); assert.equal(listed.items[0]!.discordAction, "publish");
    await outreachPublicationRoute(database, providers, "admin", request(path, "POST"), { activityRevision: 1, publicationRevision: 2, provider: "google_calendar" }, now + 4000); await processOutreachPublicationOperations(database, providers, now + 5000); assert.equal(sent.length, 3); assert.equal(sent[2]!.provider, "google_calendar");
  } finally { database.close(); }
});

test("Worker entry edits require the current staff account, origin and enabled module", async () => {
  const database = new Database(); const now = Date.parse("2026-10-13T18:00:00Z");
  try {
    const id = await batchActivity(database, "2026-10-12", now);
    const created = (await outreachEntryRoute(database, "admin", request("/admin/hours/entries", "POST"), { memberId: "member", activityId: id, serviceDate: "2026-10-12", startLocal: "09:00", endLocal: "10:00", taskNotes: "", staffReason: "Verified", idempotencyKey: "synthetic-worker-edit-1", expectedTimeZone: "America/New_York" }, now)).body as { id: string };
    database.sqlite.exec("UPDATE platform_modules SET setup_complete=1 WHERE module_id='hour-tracking'");
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://synthetic.test", SESSION_KEY: "A".repeat(43), DB: database } as unknown as Env;
    const session = await createSessionCodec("A".repeat(43)).issue({ userId: "admin", role: "admin" });
    const edit = (origin = "https://synthetic.test") => worker.fetch(new Request(`https://synthetic.test/admin/hours/entries/${created.id}`, { method: "PATCH", headers: { origin, "content-type": "application/json", cookie: `lancerlogin_session=${session}` }, body: JSON.stringify({ revision: 0, action: "corrected", reason: "Verified", endLocal: "10:30" }) }), env);
    assert.equal((await edit("https://different.test")).status, 403);
    database.sqlite.exec("UPDATE users SET active=0 WHERE id='admin'"); assert.equal((await edit()).status, 401); database.sqlite.exec("UPDATE users SET active=1 WHERE id='admin'");
    database.sqlite.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='hour-tracking'"); assert.equal((await edit()).status, 403); database.sqlite.exec("UPDATE platform_modules SET phase='enabled' WHERE module_id='hour-tracking'");
    const result = await edit(); assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json() as { durationMinutes: number }).durationMinutes, 90);
  } finally { database.close(); }
});

test("portable publication snapshots validate before restore and adapt schema 35 without replay", async () => {
  const database = new Database(); const now = Date.parse("2026-10-13T18:00:00Z");
  const providers: OutreachPublicationProviders = { status: async () => ({ google_calendar: true, discord: false }), publish: async () => "synthetic-google-id", remove: async () => undefined };
  try {
    for (const module of bundledModuleRegistry.modules) {
      database.sqlite.prepare("INSERT OR IGNORE INTO platform_module_epochs(installation_id,module_id,generation) VALUES('primary',?,1)").run(module.id);
      database.sqlite.prepare("INSERT OR IGNORE INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary',?,?,1,'disabled',?,0,0)").run(module.id, module.contractVersion, module.setup.version);
    }
    const id = await batchActivity(database, "2026-11-01", now);
    await outreachPublicationRoute(database, providers, "admin", request(`/admin/hours/activities/${id}/publication`, "POST"), { activityRevision: 0, publicationRevision: null, provider: "google_calendar" }, now);
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://synthetic.test", SESSION_KEY: "A".repeat(43), DB: database } as unknown as Env;
    const session = await createSessionCodec("A".repeat(43)).issue({ userId: "admin", role: "admin" }); const cookie = `lancerlogin_session=${session}`;
    const result = await worker.fetch(new Request("https://synthetic.test/admin/data/backup?scope=installation", { headers: { cookie } }), env); assert.equal(result.status, 200, await result.clone().text());
    const backup = await result.json() as { schemaVersion: number; tables: Record<string, Array<Record<string, unknown>>> };
    // Outreach rows travel in the Outreach plugin section; older schemas below carry them in Core's section, as first-party Outreach exported them.
    assert.equal(backup.schemaVersion, 44); const snapshot = JSON.parse(String(pluginSectionTables(backup, "hour-tracking")!.hours_publication_operations![0]!.event_snapshot_json)); assert.equal(snapshot.allDay, true);
    const restore = (value: unknown) => worker.fetch(new Request("https://synthetic.test/admin/data/restore", { method: "POST", headers: { cookie, origin: "https://synthetic.test", "content-type": "application/json" }, body: JSON.stringify({ scope: "installation", confirmation: "RESTORE INSTALLATION", backup: value }) }), env);
    const corrupted = structuredClone(backup); pluginSectionTables(corrupted, "hour-tracking")!.hours_publication_operations![0]!.event_snapshot_json = JSON.stringify({ ...snapshot, activityId: "unrelated" });
    const rejected = await restore(corrupted); assert.equal(rejected.status, 400, await rejected.clone().text()); assert.match(await rejected.text(), /publication snapshots/); assert.equal(database.sqlite.prepare("SELECT status FROM hours_publication_operations WHERE activity_id=?").get(id)?.status, "pending");
    const currentRestore = await restore(backup); assert.equal(currentRestore.status, 200, await currentRestore.clone().text());
    const currentRow = database.sqlite.prepare("SELECT status,event_snapshot_json,next_attempt_at FROM hours_publication_operations WHERE activity_id=?").get(id)!; assert.equal(JSON.parse(String(currentRow.event_snapshot_json)).allDay, true); assert.equal(currentRow.status, "failed"); assert.equal(currentRow.next_attempt_at, null);
    const legacy = structuredClone(backup); legacy.schemaVersion = 35; omitContestResubmissionFields(legacy); for (const row of legacy.tables.hours_publication_operations!) delete row.event_snapshot_json;
    const restored = await restore(legacy); assert.equal(restored.status, 200, await restored.clone().text());
    const retained = database.sqlite.prepare("SELECT status,event_snapshot_json,next_attempt_at FROM hours_publication_operations WHERE activity_id=?").get(id)!; assert.equal(retained.event_snapshot_json, null); assert.equal(retained.status, "failed"); assert.equal(retained.next_attempt_at, null);
    const legacy28 = structuredClone(backup); legacy28.schemaVersion = 28; omitContestResubmissionFields(legacy28);
    delete legacy28.tables.hours_public_form_settings; delete legacy28.tables.hours_labels; delete legacy28.tables.hours_activity_labels; delete legacy28.tables.hours_publication_settings;
    for (const row of legacy28.tables.members!) delete row.inactive_periods_json;
    for (const row of legacy28.tables.hours_activities!) { delete row.event_start_local; delete row.event_end_local; delete row.event_start_occurrence; delete row.event_end_occurrence; }
    for (const row of legacy28.tables.hours_correction_requests!) delete row.activity_id;
    for (const row of legacy28.tables.hours_publication_operations!) { delete row.event_snapshot_json; delete row.action; }
    const restored28 = await restore(legacy28); assert.equal(restored28.status, 200, await restored28.clone().text());
    const historical = database.sqlite.prepare("SELECT action,event_snapshot_json,status FROM hours_publication_operations WHERE activity_id=?").get(id)!; assert.equal(historical.action, "publish"); assert.equal(historical.event_snapshot_json, null); assert.equal(historical.status, "failed");
  } finally { database.close(); }
});

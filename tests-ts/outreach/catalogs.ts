// quick-check: covers apps/api/migrations/**
import { omitContestResubmissionFields, pluginSectionTables } from "../fixtures/backup-versions.ts";
import { bundledModuleRegistry } from "../../packages/shared/src/module-platform.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { outreachCatalogRoute, outreachSetupRoute } from "@lancerlogin-test/outreach/src/api/outreach-catalogs.ts";
import { outreachEntryRoute } from "@lancerlogin-test/outreach/src/api/outreach-entries.ts";
import worker, { type Env } from "../../apps/api/src/index.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { dispatchModuleDiscordCommand } from "../../apps/api/src/module-discord.ts";
import { outreachPublicationRoute, type OutreachPublicationProviders } from "@lancerlogin-test/outreach/src/api/outreach-publication.ts";
import { readModuleSetup, updateModuleSetup } from "../../apps/api/src/module-platform.ts";
import { outreachReportHandlers } from "@lancerlogin-test/outreach/src/api/outreach-reporting.ts";
import { defaultReportDefinition } from "../../apps/api/src/report-builder.ts";
import { externalModuleMigrations } from "../../apps/api/src/generated/external-module-data.ts";
import { applyComposedModuleMigrations, TestD1Database, applyCoreMigrations, readCoreMigrations } from "../fixtures/d1-database.ts";

class Database extends TestD1Database {
  constructor() {
    super({ recordMigrations: true });
    // Then the composed Outreach plugin's own migrations, as the Worker's module reconciliation applies them after Core's.
    applyComposedModuleMigrations(this.sqlite, externalModuleMigrations, { now: "2026-09-28T00:00:00.000Z" });
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
}

function request(path: string, method = "GET") { return new Request(`https://synthetic.test${path}`, { method }); }
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

test("Outreach label migration preserves legacy categories, activities, and associations", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyCoreMigrations(database, readCoreMigrations().filter((file) => file.name < "0047_outreach_activity_labels.sql"));
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

async function batchActivity(database: Database, serviceDate: string, now: number, title = "Synthetic batch event") {
  const result = await outreachCatalogRoute(database, "admin", request("/admin/hours/activities", "POST"), { mode: "event", serviceDate, teamId: null, title, description: "", location: "Library", impactRelevant: true, archived: false }, undefined, now);
  return String((result.body as { id: string }).id);
}

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
    assert.equal(backup.schemaVersion, 49); const snapshot = JSON.parse(String(pluginSectionTables(backup, "hour-tracking")!.hours_publication_operations![0]!.event_snapshot_json)); assert.equal(snapshot.allDay, true);
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

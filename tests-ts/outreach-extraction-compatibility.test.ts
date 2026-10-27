// Core without the Outreach plugin, as an installation that opts out of official modules runs it: historical backups that
// carry Outreach in Core's section stay restorable, retained Outreach data is never orphaned, and Outreach stays out of new
// backups. The same archives restoring through the composed plugin are covered by tests-ts/outreach-catalogs.test.ts,
// tests-ts/walkthrough.test.ts and tests-ts/outreach-platform.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../apps/api/src/index.ts";
import { extractedModules } from "../apps/api/src/extracted-modules.ts";
import { reconcileInstalledModules } from "../apps/api/src/module-catalog.ts";
import { runModuleCleanup } from "../apps/api/src/module-cleanup.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { walkthroughs } from "../packages/shared/src/walkthrough.ts";
import { BackupDatabase, backupClient, sessionSecret } from "./fixtures/backup-database.ts";

type Backup = Record<string, any>;
// Exported by the Core Worker at e4a348ff while Outreach and Carpool were first-party (see tests-ts/carpool/worker.ts).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/carpool-first-party-backup.json", import.meta.url), "utf8")) as Backup;
const recordedCatalog = JSON.parse(readFileSync(new URL("./fixtures/outreach-first-party-catalog.json", import.meta.url), "utf8")) as { json: string; sha: string };
const outreach = extractedModules.find((module) => module.id === "hour-tracking")!;
const outreachTables = outreach.tables.map((table) => table.name);
const moduleKeyed = ["platform_module_epochs", "platform_modules", "platform_module_assignments", "platform_module_setup_progress"];

/** The schema 42 archive with Outreach used: enabled and set up, an Operator assignment, participation data and walkthrough progress. */
function usedOutreach(): Backup {
  const backup = structuredClone(fixture);
  backup.tables.platform_modules = backup.tables.platform_modules.map((row: Record<string, unknown>) => row.module_id === "hour-tracking" ? { ...row, phase: "enabled", setup_complete: 1 } : row);
  backup.tables.platform_module_setup_progress.push(...["rules", "catalog"].map((step_id) => ({ installation_id: "primary", module_id: "hour-tracking", step_id, setup_version: 1, outcome: "completed", completed_at: "2026-02-01T00:00:00.000Z", completed_by: "admin" })));
  backup.tables.platform_module_assignments = backup.tables.platform_module_assignments.map((row: Record<string, unknown>) => row.module_id === "attendance" ? row : row);
  backup.tables.platform_module_assignments.push({ installation_id: "primary", user_id: "operator", module_id: "hour-tracking", capabilities_json: '["hours.manage"]' });
  backup.tables.hours_categories = [{ installation_id: "primary", id: "event", name: "Event", mode: "event", impact_default: 1, archived: 0, revision: 0, created_at: "2026-01-01", updated_at: "2026-01-01" }];
  backup.tables.hours_teams = [{ installation_id: "primary", id: "team-1", number: "1001", name: "Synthetic Team", program: "FRC", historical_descriptors: "[]", archived: 0, revision: 0, created_at: "2026-01-01", updated_at: "2026-01-01" }];
  backup.tables.hours_activities = [{ installation_id: "primary", id: "activity-1", category_id: "event", mode: "event", service_date: "2026-02-01", team_id: null, title: "Synthetic open house", description: "", location: "", impact_relevant: 1, source_meeting_id: null, source_snapshot: null, archived: 0, revision: 0, created_at: "2026-02-01", updated_at: "2026-02-01", event_start_local: null, event_end_local: null, event_start_occurrence: null, event_end_occurrence: null }];
  backup.tables.user_walkthroughs.push({ installation_id: "primary", user_id: "admin", page_id: "outreach", content_version: 1, status: "completed", step_id: null, updated_at: "2026-02-01T00:00:00.000Z" });
  return backup;
}
const outreachRows = (backup: Backup) => outreachTables.reduce((total, table) => total + backup.tables[table].length, 0);

test("Outreach is no longer a first-party module, and its frozen definitions match what Core recorded while it was", () => {
  assert.equal(bundledModuleRegistry.get("hour-tracking"), undefined);
  assert.equal(Object.hasOwn(walkthroughs, "outreach"), false);
  const json = JSON.stringify(outreach.catalogDefinition);
  assert.equal(json, recordedCatalog.json);
  assert.equal(createHash("sha256").update(json).digest("hex"), recordedCatalog.sha);
  assert.deepEqual(fixture.ownership.modules.find((module: { id: string }) => module.id === "hour-tracking"), { id: "hour-tracking", contractVersion: 1, backupVersion: 2, tables: outreachTables, sharedFields: [], transientAuthority: [{ table: "hours_publication_operations", columns: ["status", "next_attempt_at", "lease_token", "lease_expires_at"] }] });
  assert.deepEqual(extractedModules.map((module) => module.id), ["hour-tracking", "carpool"], "historical ownership lists Outreach before Carpool");
});

test("a historical backup holding Outreach data is refused without the plugin until the data is explicitly discarded", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  const backup = usedOutreach();
  const refused = await client.restore(backup);
  assert.equal(refused.status, 409);
  const body = await refused.json() as Record<string, any>;
  assert.equal(body.code, "module-restore-refused");
  assert.deepEqual(body.modules.map((module: { id: string }) => module.id), ["hour-tracking", "carpool"]);
  assert.deepEqual(body.modules[0], { id: "hour-tracking", label: "Outreach Participation", status: "missing", requiredBackupVersion: 2, installedBackupVersion: null, requiredContractVersion: 1, installedContractVersion: null, source: null, commit: null, rows: outreachRows(backup) });
  assert.match(body.details[0], /Outreach Participation \(hour-tracking\) is not installed/);
  assert.equal((await client.restore(backup, { excludeModules: ["carpool"] })).status, 409, "Outreach must be discarded explicitly too");
  assert.equal(db.batches, 0, "refusal happens before any write");

  const discarded = await client.restore(backup, { excludeModules: ["hour-tracking", "carpool"] });
  assert.equal(discarded.status, 200, await discarded.clone().text());
  const result = await discarded.json() as Record<string, any>;
  assert.deepEqual(result.excludedModules.map((module: { id: string; rows: number }) => [module.id, module.rows]), [["hour-tracking", outreachRows(backup)], ["carpool", result.excludedModules[1].rows]]);
  // Generation epochs are monotonic authority that every restore keeps; everything else about Outreach restores absent.
  for (const table of moduleKeyed.filter((name) => name !== "platform_module_epochs")) assert.equal(db.count(`SELECT COUNT(*) AS n FROM ${table} WHERE module_id='hour-tracking'`), 0, table);
  for (const table of outreachTables) assert.equal(db.count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM user_walkthroughs WHERE page_id='outreach'"), 0, "progress on Outreach's walkthrough is not restored without its plugin");
  assert.deepEqual(db.rows("SELECT module_id FROM platform_module_assignments ORDER BY module_id"), [{ module_id: "attendance" }]);
});

test("a historical backup with an unused Outreach restores without the plugin and without a confirmation", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  // The archive's Outreach is disabled with only the default entry settings every installation received.
  assert.deepEqual(fixture.tables.platform_modules.find((row: { module_id: string }) => row.module_id === "hour-tracking").phase, "disabled");
  assert.equal(outreachRows(fixture), fixture.tables.hours_entry_settings.length);
  const restored = await client.restore(fixture, { excludeModules: ["carpool"] });
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual((await restored.json() as Record<string, any>).excludedModules.map((module: { id: string }) => module.id), ["carpool"]);
  for (const table of moduleKeyed.filter((name) => name !== "platform_module_epochs")) assert.equal(db.count(`SELECT COUNT(*) AS n FROM ${table} WHERE module_id='hour-tracking'`), 0, table);
  // Any Outreach state still makes the restore an explicit decision.
  for (const change of [(backup: Backup) => { backup.tables.hours_teams = usedOutreach().tables.hours_teams; }, (backup: Backup) => { backup.tables.platform_modules = usedOutreach().tables.platform_modules; backup.tables.platform_module_setup_progress = usedOutreach().tables.platform_module_setup_progress; }]) {
    const used = structuredClone(fixture); change(used);
    const refused = await client.restore(used, { excludeModules: ["carpool"] });
    assert.equal(refused.status, 409, await refused.clone().text());
  }
});

test("historical Outreach ownership and placement are still checked exactly", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  const ownership = usedOutreach(); ownership.ownership.modules = ownership.ownership.modules.filter((module: { id: string }) => module.id !== "hour-tracking");
  const missingTable = usedOutreach(); delete missingTable.tables.hours_teams;
  const badRow = usedOutreach(); badRow.tables.hours_activities[0].title = { nested: true };
  const duplicate = usedOutreach(); duplicate.externalModules = [{ id: "hour-tracking", label: "Outreach Participation", contractVersion: 1, backupVersion: 3, source: null, commit: null, tables: {} }];
  for (const backup of [ownership, missingTable, badRow, duplicate]) assert.equal((await client.restore(backup, { excludeModules: ["hour-tracking", "carpool"] })).status, 400);
  assert.equal(db.batches, 0);
});

test("without the plugin, retained Outreach data stays out of new backups, keeps members from deletion, and is deleted from the frozen definition", async (t) => {
  const db = new BackupDatabase(); t.after(() => db.raw.close());
  // An installation that opted out of official modules after using Outreach: enabled with data and no catalog entry.
  db.raw.exec(`UPDATE platform_modules SET phase='enabled',setup_complete=1,generation=3 WHERE module_id='hour-tracking'; UPDATE platform_module_epochs SET generation=3 WHERE module_id='hour-tracking';
    INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ('primary','operator','hour-tracking','["hours.manage"]');
    INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES('primary','event','Event','event',1,'2026-01-01','2026-01-01');
    INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES('primary','activity-1','event','event','2026-02-01','Synthetic retained activity','2026-02-01','2026-02-01');
    INSERT INTO hours_entries(installation_id,id,member_id,activity_id,service_date,time_zone,start_local,end_local,start_ms,end_ms,start_offset_seconds,end_offset_seconds,duration_minutes,status,channel,attribution,revision,created_at,updated_at)
      VALUES('primary','entry-1','member','activity-1','2026-02-01','UTC','10:00','11:00',1769940000000,1769943600000,0,0,60,'counted','staff','staff_recorded',0,'2026-02-01','2026-02-01');`);
  const client = backupClient(worker, db);
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 44); assert.deepEqual(backup.externalModules, []);
  for (const table of moduleKeyed) assert.equal(backup.tables[table].some((row: Record<string, unknown>) => row.module_id === "hour-tracking"), false, table);
  assert.doesNotMatch(JSON.stringify(backup), /hour-tracking|hours_|Synthetic retained activity/);

  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "PUT") => {
    const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
    const response = await worker.fetch(new Request(`https://fixture.test${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }), { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  // Retained participation history still refers to its member, so neither the member nor the roster can be deleted.
  const member = await call("/admin/members/member", { confirmation: "DELETE MEMBER 001" }, "DELETE");
  assert.equal(member.status, 409, JSON.stringify(member.body)); assert.match(member.body.error, /Attendance or Outreach history/);
  const roster = await call("/admin/data", { scope: "roster", confirmation: "DELETE ROSTER" }, "DELETE");
  assert.equal(roster.status, 409); assert.match(roster.body.error, /Delete Attendance and Outreach participation first/);

  // Settings records the frozen first-party definition and lists Outreach as no longer installed.
  let modules = await call("/platform/modules");
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  const listed = modules.body.modules.find((module: { id: string }) => module.id === "hour-tracking");
  assert.deepEqual({ unavailable: listed.unavailable, phase: listed.phase, label: listed.label, data: listed.deletion.data }, { unavailable: "removed", phase: "enabled", label: "Outreach Participation", data: JSON.parse(recordedCatalog.json).deletedData });
  assert.deepEqual(db.rows("SELECT origin, installed, definition_sha256 FROM platform_module_catalog WHERE module_id='hour-tracking'"), [{ origin: "first-party", installed: 0, definition_sha256: recordedCatalog.sha }]);
  assert.equal((await reconcileInstalledModules(db as never)).changed, false, "the definition is recorded once");

  // It can only be turned off; its data is then deleted with the steps it had as a first-party module.
  modules = await call("/admin/modules", { enabled: ["attendance"], revision: modules.body.revision, confirmDisable: [{ moduleId: "hour-tracking", generation: 3 }] });
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  db.raw.exec("UPDATE platform_modules SET disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z' WHERE module_id='hour-tracking'");
  for (let pass = 0; pass < 30 && db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='hour-tracking' AND phase='deleted'") === 0; pass += 1) await runModuleCleanup(db as never);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='hour-tracking' AND phase='deleted'"), 1);
  for (const table of ["hours_entries", "hours_activities", "hours_categories", "hours_entry_settings"]) assert.equal(db.count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_assignments WHERE module_id='hour-tracking'"), 0);
  const deleted = await call("/admin/members/member", { confirmation: "DELETE MEMBER 001" }, "DELETE");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
});

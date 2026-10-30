// Outreach's place in the module platform once composed as the official plugin: registry ownership, the identity and
// cleanup it had as a first-party module, scoped stylesheet and reviewed controls, first enablement seeds, adoption of
// an existing installation's data, and historical backups that predate its plugin section.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
// The Worker loads first, as in a composed build, so the plugin modules it imports initialize in build order.
import worker from "../../apps/api/src/index.ts";
import manifest from "@lancerlogin-test/outreach/src/manifest.ts";
import api from "@lancerlogin-test/outreach/src/api.ts";
import { installedApiModule } from "../../apps/api/src/installed-api-modules.ts";
import { configureModulePlatform, readModulePlatformSnapshot } from "../../apps/api/src/module-platform.ts";
import { reconcileInstalledModules } from "../../apps/api/src/module-catalog.ts";
import { externalModuleIds } from "../../apps/api/src/module-contributions.ts";
import { dashboardModuleScope } from "../../apps/dashboard/src/design-conformance.ts";
import { extractedModules } from "../../apps/api/src/extracted-modules.ts";
import { bundledModuleRegistry, firstPartyModules } from "../../packages/shared/src/module-platform.ts";
import { walkthroughs } from "../../packages/shared/src/walkthrough.ts";
import { backupClient } from "../fixtures/backup-database.ts";
import { outreachPlugin } from "../fixtures/outreach-plugin.ts";
import { Database } from "../fixtures/lifecycle-database.ts";
import { PluginDatabase } from "../fixtures/plugin-database.ts";
import { stylesheetRules } from "../fixtures/stylesheet-rules.ts";
import { readFileSync } from "node:fs";

const root = outreachPlugin.available ? outreachPlugin.root : "";
const extracted = extractedModules.find((module) => module.id === "hour-tracking")!;
const recordedCatalog = JSON.parse(readFileSync(new URL("../fixtures/outreach-first-party-catalog.json", import.meta.url), "utf8")) as { json: string; sha: string };

test("Outreach is the official plugin and owns only its module surfaces", () => {
  assert.deepEqual(firstPartyModules.map((module) => module.id), ["attendance"]);
  assert.deepEqual(bundledModuleRegistry.modules.map((module) => module.id), ["attendance", "hour-tracking"]);
  assert.equal(externalModuleIds.has("hour-tracking"), true);
  assert.deepEqual(manifest.dependencies, []);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/hours/entries")?.module.id, "hour-tracking");
  assert.equal(bundledModuleRegistry.routeOwner("/public/hours/context")?.route.access, "service");
  assert.equal(bundledModuleRegistry.routeOwner("/module-setup/hour-tracking/catalog")?.route.access, "setup");
  assert.equal(bundledModuleRegistry.tableOwner("hours_entries")?.id, "hour-tracking");
  assert.equal(bundledModuleRegistry.tableOwner("members"), undefined);
  assert.equal(manifest.tablePrefix, "hours_");
  assert.deepEqual(manifest.persistence.sharedFields, []);
  assert.deepEqual(bundledModuleRegistry.reportFilters.map((filter) => [filter.id, filter.selectionKey, filter.matchKey]), [["outreach-labels", "outreachLabelIds", "outreachLabelMatch"]]);
  assert.equal(bundledModuleRegistry.reportFilterOwner("outreach-labels")?.id, "hour-tracking");
  assert.equal(bundledModuleRegistry.reportFieldAliases["outreach.activity.category"], "outreach.activity.labels");
  assert.deepEqual(walkthroughs.outreach, { version: 1, steps: ["activities", "member-submissions", "submission-log", "corrections", "manual-entry", "reports-handoff"] });
  assert.equal(manifest.jobs.find((job) => job.id === "hour-tracking.publication")?.label, "Outreach event publication");
});

test("the plugin keeps the identity, lifecycle and cleanup it had as a first-party module", () => {
  assert.equal(JSON.stringify(extracted.catalogDefinition), recordedCatalog.json);
  assert.equal(manifest.label, extracted.label); assert.equal(manifest.contractVersion, extracted.contractVersion);
  assert.equal(manifest.setup.version, 1);
  assert.deepEqual(manifest.setup.steps.map((step) => step.id), ["rules", "catalog"]);
  assert.deepEqual(manifest.capabilities, [{ id: "hours.manage", label: "Manage Outreach Participation", operator: true }]);
  assert.deepEqual(manifest.persistence.tables, extracted.catalogDefinition.tables);
  assert.deepEqual(manifest.deletedData, extracted.catalogDefinition.deletedData);
  // Interrupted deletions resume at a persisted cursor, so the steps must be identical and in the same order.
  assert.deepEqual(JSON.parse(JSON.stringify(api.cleanup.steps)), extracted.catalogDefinition.cleanup);
  assert.deepEqual(manifest.persistence.transientAuthority, extracted.transientAuthority);
  assert.deepEqual(Object.keys(api.backup!.tables), [...manifest.backup.tables]);
  // The plugin restores parent tables first in its own order; Core's historical section listed the same tables in its order.
  assert.deepEqual(Object.keys(api.backup!.tables).sort(), extracted.tables.map((table) => table.name).sort());
  assert.equal(api.backup!.version, 3); assert.equal(extracted.backupVersion, 2);
  assert.deepEqual(api.rosterReferences, extracted.rosterReferences);
  assert.deepEqual(api.privateResponseRoutes, ["/public/hours"]);
  assert.equal(installedApiModule("hour-tracking"), api);
});

test("the Outreach stylesheet stays beneath its module root and Core stylesheets leave Outreach classes alone", async () => {
  const css = await readFile(join(root, "src/outreach.css"), "utf8");
  const scope = dashboardModuleScope("hour-tracking"); const rules = stylesheetRules(css);
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.equal(rule.keyframes, undefined, "Outreach declares no keyframes");
    for (const selector of rule.selectors) {
      const scoped = selector.indexOf(scope); const moduleClass = selector.search(/\.(?:outreach-|public-outreach-|compact-activity-heading|compact-back-link|team-dialog-archive)/);
      assert.ok(scoped >= 0 && (moduleClass < 0 || moduleClass > scoped), `outreach.css: ${selector} must sit beneath ${scope}`);
    }
  }
  const sources = await readdir(join(root, "src"), { recursive: true });
  const importers = [];
  for (const file of sources.map((name) => String(name).replaceAll("\\", "/")).filter((name) => /\.tsx?$/.test(name))) if ((await readFile(join(root, "src", file), "utf8")).includes('import "./outreach.css";')) importers.push(file);
  assert.deepEqual(importers, ["dashboard.tsx"], "outreach.css loads only through the dashboard contribution");
  for (const file of (await readdir("apps/dashboard/src")).filter((name) => name.endsWith(".css"))) assert.doesNotMatch(await readFile(`apps/dashboard/src/${file}`, "utf8"), /\.(?:outreach-|public-outreach-)/, `${file} must not style Outreach classes`);
});

test("raw Outreach dashboard controls remain in the reviewed UI inventory", async () => {
  type Counts = Partial<Record<"button" | "input" | "select" | "textarea" | "summary", number>>;
  // Moved unchanged from Core's inventory when Outreach became a plugin.
  const reviewed: Record<string, Counts> = {
    "outreach-activity-publication.tsx": { button: 4, input: 2, select: 1 },
    "outreach-clock.tsx": { button: 9, select: 1 },
    "outreach-setup-workspace.tsx": { button: 2, input: 3, select: 1 },
    "outreach-entry-edit.tsx": { button: 3, select: 2, textarea: 2 },
    "outreach-settings.tsx": { button: 12, input: 4, select: 2 },
    "outreach-workspace.tsx": { button: 24, input: 12, select: 10, textarea: 6, summary: 3 },
    "public-outreach-form.tsx": { button: 10, input: 1, select: 2, textarea: 2 },
    "outreach-public-settings.tsx": { button: 1, select: 1 },
  };
  const actual: Record<string, Counts> = {};
  const files = [...(await readdir(join(root, "src/dashboard"))).filter((file) => file.endsWith(".tsx")).map((file) => join("dashboard", file)), "dashboard.tsx"];
  for (const file of files) {
    const source = await readFile(join(root, "src", file), "utf8"); const counts: Counts = {};
    for (const tag of ["button", "input", "select", "textarea", "summary"] as const) { const count = [...source.matchAll(new RegExp(`<${tag}\\b`, "g"))].length; if (count) counts[tag] = count; }
    if (Object.keys(counts).length) actual[file.replace(/^dashboard[\\/]/, "")] = counts;
  }
  assert.deepEqual(actual, reviewed, "Native control markup changed. Use the shared UI patterns and focused rendered coverage, then review and update this inventory deliberately.");
});

test("a new installation receives Outreach's former installation defaults on first enablement", async () => {
  const database = new Database(true);
  try {
    // A fresh installation: Outreach is registered disabled and has no rows until an Admin enables it.
    database.sqlite.exec("DELETE FROM hours_categories; DELETE FROM hours_entry_settings; DELETE FROM hours_publication_settings; DELETE FROM hours_public_form_settings");
    const before = await readModulePlatformSnapshot(database, "admin");
    const enabled = await configureModulePlatform(database, "admin", { enabled: ["attendance", "hour-tracking"], revision: before.revision });
    assert.equal(enabled.modules.find((module) => module.id === "hour-tracking")?.phase, "enabled");
    // Exactly the rows Core's first-party installation seed created, with the enablement time as their creation time.
    assert.deepEqual(database.sqlite.prepare("SELECT installation_id,reporting_days,reopen_hours,revision FROM hours_entry_settings").all().map((row) => ({ ...row })), [{ installation_id: "primary", reporting_days: 30, reopen_hours: 24, revision: 0 }]);
    const publication = database.sqlite.prepare("SELECT installation_id,automatic,revision,created_at,updated_at FROM hours_publication_settings").all().map((row) => ({ ...row }));
    assert.equal(publication.length, 1); assert.deepEqual({ ...publication[0], created_at: undefined, updated_at: undefined }, { installation_id: "primary", automatic: 0, revision: 0, created_at: undefined, updated_at: undefined });
    assert.equal(publication[0]!.created_at, publication[0]!.updated_at);
    assert.deepEqual(database.sqlite.prepare("SELECT id,name,mode,impact_default,archived,revision FROM hours_categories ORDER BY id").all().map((row) => ({ ...row })), [
      { id: "event", name: "Event", mode: "event", impact_default: 1, archived: 0, revision: 0 },
      { id: "other-service", name: "Other Service", mode: "task", impact_default: 1, archived: 0, revision: 0 },
      { id: "team-support", name: "Team Support", mode: "team", impact_default: 1, archived: 0, revision: 0 },
    ]);
    // The publication setting route works immediately, as it did on a first-party installation.
    assert.deepEqual(await (await import("@lancerlogin-test/outreach/src/api/outreach-publication.ts")).readOutreachPublicationSetting(database), { automatic: false, revision: 0 });
  } finally { database.close(); }
});

test("first enablement keeps the settings and labels an existing installation already has", async () => {
  const database = new Database(true);
  try {
    database.sqlite.exec(`UPDATE hours_entry_settings SET reporting_days=14,reopen_hours=48,revision=3;
      INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at) VALUES('primary',1,4,'2026-01-01','2026-02-01');
      UPDATE hours_categories SET name='Community Event',revision=2 WHERE id='event';`);
    const before = await readModulePlatformSnapshot(database, "admin");
    await configureModulePlatform(database, "admin", { enabled: ["attendance", "hour-tracking"], revision: before.revision });
    assert.deepEqual({ ...database.sqlite.prepare("SELECT reporting_days,reopen_hours,revision FROM hours_entry_settings").get() }, { reporting_days: 14, reopen_hours: 48, revision: 3 });
    assert.deepEqual({ ...database.sqlite.prepare("SELECT automatic,revision,created_at FROM hours_publication_settings").get() }, { automatic: 1, revision: 4, created_at: "2026-01-01" });
    assert.deepEqual({ ...database.sqlite.prepare("SELECT name,revision FROM hours_categories WHERE id='event'").get() }, { name: "Community Event", revision: 2 });
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM hours_categories").get()?.n, 3);
  } finally { database.close(); }
});

test("an installation that used first-party Outreach keeps its data and lifecycle when the official plugin replaces it", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close()); db.recordCoreMigrations();
  // Outreach enabled with setup, an Operator assignment and participation data, and the catalog entry first-party Outreach recorded.
  db.raw.exec(`UPDATE platform_modules SET phase='enabled',setup_complete=1,generation=2 WHERE module_id='hour-tracking'; UPDATE platform_module_epochs SET generation=2 WHERE module_id='hour-tracking';
    INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES ('primary','hour-tracking','rules',1,'completed','2026-02-01T00:00:00.000Z','admin'),('primary','hour-tracking','catalog',1,'completed','2026-02-01T00:00:00.000Z','admin');
    INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ('primary','operator','hour-tracking','["hours.manage"]');
    INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at) VALUES ('primary','event','Event','event',1,'2026-01-01','2026-01-01');
    INSERT INTO hours_teams(installation_id,id,number,name,program,created_at,updated_at) VALUES ('primary','team-1','1001','Synthetic Team','FRC','2026-01-01','2026-01-01');
    INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,title,created_at,updated_at) VALUES ('primary','activity-1','event','event','2026-02-01','Synthetic open house','2026-02-01','2026-02-01');`);
  db.raw.prepare("INSERT INTO platform_module_catalog(installation_id,module_id,origin,source,source_commit,contract_version,definition_json,definition_sha256,installed,recorded_at) VALUES ('primary','hour-tracking','first-party',NULL,NULL,1,?,?,1,'2026-02-01T00:00:00.000Z')").run(recordedCatalog.json, recordedCatalog.sha);
  const result = await reconcileInstalledModules(db as never);
  assert.deepEqual(result.failures, []);
  // The adopted baseline is recorded without running SQL, the catalog now names the external plugin, and nothing else changes.
  assert.deepEqual(db.rows("SELECT module_id, sequence, name FROM platform_module_migrations WHERE module_id='hour-tracking'"), [{ module_id: "hour-tracking", sequence: 0, name: "adopted-baseline" }]);
  assert.deepEqual(db.rows("SELECT origin, installed, source, source_commit FROM platform_module_catalog WHERE module_id='hour-tracking'"), [{ origin: "external", installed: 1, source: outreachPlugin.available ? outreachPlugin.source : null, source_commit: outreachPlugin.available ? outreachPlugin.commit : null }]);
  assert.deepEqual(db.rows("SELECT phase, generation, setup_complete FROM platform_modules WHERE module_id='hour-tracking'"), [{ phase: "enabled", generation: 2, setup_complete: 1 }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_assignments WHERE module_id='hour-tracking'"), 1);
  assert.deepEqual(db.rows("SELECT id, title FROM hours_activities"), [{ id: "activity-1", title: "Synthetic open house" }]);
  const client = backupClient(worker, db);
  const snapshot = await (await client.call("/platform/modules")).json() as { modules: { id: string; phase: string; workspaceReady: boolean; unavailable?: string }[] };
  const listed = snapshot.modules.find((module) => module.id === "hour-tracking")!;
  assert.deepEqual([listed.phase, listed.workspaceReady, "unavailable" in listed], ["enabled", true, false]);
  // Its next backup carries Outreach in the plugin section, and that backup restores the same rows.
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 45);
  const section = backup.externalModules.find((entry: { id: string }) => entry.id === "hour-tracking");
  assert.deepEqual({ ...section, tables: undefined }, { id: "hour-tracking", label: "Outreach Participation", contractVersion: 1, backupVersion: 3, source: outreachPlugin.available ? outreachPlugin.source : null, commit: outreachPlugin.available ? outreachPlugin.commit : null, tables: undefined });
  assert.deepEqual(section.tables.hours_activities.map((row: { id: string }) => row.id), ["activity-1"]);
  const restored = await client.restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(db.rows("SELECT id FROM hours_teams"), [{ id: "team-1" }]);
  assert.deepEqual(db.rows("SELECT phase, setup_complete FROM platform_modules WHERE module_id='hour-tracking'"), [{ phase: "enabled", setup_complete: 1 }]);
});

test("a real schema 42 backup exported while Outreach and Carpool were first-party restores Outreach through the plugin", async (t) => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/carpool-first-party-backup.json", import.meta.url), "utf8"));
  const db = new PluginDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  // Carpool is not composed here, so its data must be discarded explicitly; Outreach's Core-section rows restore through the plugin.
  const refused = await client.restore(fixture); assert.equal(refused.status, 409);
  assert.deepEqual((await refused.json() as { modules: { id: string }[] }).modules.map((module) => module.id), ["carpool"]);
  const restored = await client.restore(fixture, { excludeModules: ["carpool"] }); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(db.rows("SELECT phase, setup_complete FROM platform_modules WHERE module_id='hour-tracking'"), [{ phase: "disabled", setup_complete: 0 }]);
  assert.deepEqual(db.rows("SELECT installation_id, reporting_days, reopen_hours FROM hours_entry_settings"), fixture.tables.hours_entry_settings.map(({ installation_id, reporting_days, reopen_hours }: Record<string, unknown>) => ({ installation_id, reporting_days, reopen_hours })));
  assert.equal(db.count("SELECT COUNT(*) AS n FROM hours_public_form_settings"), fixture.tables.hours_public_form_settings.length);
});

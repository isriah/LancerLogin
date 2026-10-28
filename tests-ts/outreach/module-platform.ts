import test from "node:test";
import assert from "node:assert/strict";
import { attendanceModule, bundledModuleRegistry, createModuleRegistry } from "../../packages/shared/src/module-platform.ts";
import { createModuleDiscordDispatcher } from "../../apps/api/src/module-discord.ts";
import { createModuleReportDispatcher } from "../../apps/api/src/module-reporting.ts";
import { validateModuleAssignments, validateModuleConfiguration } from "../../apps/api/src/module-platform.ts";

// Outreach is the official plugin composed for this file; its manifest is no longer a first-party export.
const outreachModule = bundledModuleRegistry.get("hour-tracking")!;

test("bundled registration keeps Core routes outside Attendance ownership", () => {
  assert.equal(bundledModuleRegistry.routeOwner("/admin/members"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/labels"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/integrations"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/data/backup"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/update-info"), undefined);
});

test("bundled registration assigns Attendance entry points to the module", () => {
  assert.equal(bundledModuleRegistry.routeOwner("/meetings")?.module.id, "attendance");
  assert.equal(bundledModuleRegistry.routeOwner("/admin/members/member-1/history")?.module.id, "attendance");
  assert.equal(bundledModuleRegistry.routeOwner("/module-setup/attendance/rules")?.route.access, "setup");
  assert.equal(bundledModuleRegistry.routeOwner("/admin/attendance/members")?.route.access, "workspace");
  assert.equal(bundledModuleRegistry.routeOwner("/kiosk/attendance")?.route.access, "service");
  assert.equal(bundledModuleRegistry.routeOwner("/reports/query"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/reports/catalog"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/exports/report.csv"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/reports/leaderboard")?.route.access, "workspace");
});

test("bundled registration assigns Outreach entry points without an Attendance dependency", () => {
  const outreach = bundledModuleRegistry.modules.find((module) => module.id === "hour-tracking");
  assert.deepEqual(outreach?.dependencies, []);
  assert.equal(bundledModuleRegistry.routeOwner("/admin/hours/entries")?.module.id, "hour-tracking");
  assert.equal(bundledModuleRegistry.routeOwner("/admin/hours/entries")?.route.access, "workspace");
  assert.equal(bundledModuleRegistry.routeOwner("/module-setup/hour-tracking/catalog")?.route.access, "setup");
  assert.deepEqual(outreach?.setup.steps.map((step) => [step.id, step.required]), [["rules", true], ["catalog", true]]);
  assert.equal(bundledModuleRegistry.discordCommandOwner("outreach-submit")?.id, "hour-tracking");
  assert.equal(bundledModuleRegistry.discordCommandOwner("outreach-correction")?.id, "hour-tracking");
  const memberDuration = outreach?.reportDatasets?.find((dataset) => dataset.id === "outreach.members")?.fields.find((field) => field.id === "outreach.member.minutes");
  assert.deepEqual(memberDuration?.durationUnits, ["minutes", "hours"]);
  assert.equal(memberDuration?.defaultDurationUnit, "hours");
  assert.equal(bundledModuleRegistry.routeOwner("/discord/interactions"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/discord/link"), undefined);
  assert.equal(bundledModuleRegistry.routeOwner("/discord/missing")?.module.id, "attendance");
});

test("module Discord command contributions reject collisions", () => {
  const persistence = { tables: [], sharedFields: [], transientAuthority: [] };
  const backup = { version: 1, tables: [] };
  const first = { ...outreachModule, interfaces: [], reportFilters: [], walkthroughs: {}, id: "synthetic-one", capabilities: [{ id: "synthetic.one", label: "One", operator: true }], jobs: [], reportDatasets: [], persistence, backup, lifecycle: { cleanupTargets: ["synthetic-one"] }, discordCommands: [{ name: "shared-command", type: 1 as const, description: "First synthetic command" }] };
  const second = { ...outreachModule, interfaces: [], reportFilters: [], walkthroughs: {}, id: "synthetic-two", capabilities: [{ id: "synthetic.two", label: "Two", operator: true }], jobs: [], reportDatasets: [], persistence, backup, lifecycle: { cleanupTargets: ["synthetic-two"] }, discordCommands: [{ name: "shared-command", type: 1 as const, description: "Second synthetic command" }] };
  assert.throws(() => createModuleRegistry([first, second]), /duplicate Discord command contribution/i);
});

test("an unshipped synthetic module can contribute a Discord command without Core branching", () => {
  const synthetic = { ...outreachModule, interfaces: [], reportFilters: [], walkthroughs: {}, id: "synthetic", label: "Synthetic", capabilities: [{ id: "synthetic.manage", label: "Manage Synthetic", operator: true }], jobs: [], reportDatasets: [], discordCommands: [{ name: "synthetic-check", type: 1 as const, description: "Check the synthetic extension contract" }] };
  const registry = createModuleRegistry([synthetic]);
  const dispatch = createModuleDiscordDispatcher(registry, [{ moduleId: "synthetic", handlers: { "synthetic-check": async () => "Synthetic extension ready" } }]);
  assert.equal(registry.discordCommandOwner("synthetic-check")?.id, "synthetic");
  assert.equal(typeof dispatch, "function");
  assert.throws(() => createModuleDiscordDispatcher(registry, [{ moduleId: "synthetic", handlers: {} }]), /handlers do not match declared commands/i);
});

test("an unshipped synthetic module can contribute a report dataset through the static projection contract", async () => {
  const synthetic = { ...outreachModule, interfaces: [], reportFilters: [], walkthroughs: {}, id: "synthetic", label: "Synthetic", capabilities: [{ id: "synthetic.manage", label: "Manage Synthetic", operator: true }], jobs: [], discordCommands: [], reportDatasets: [{
    id: "synthetic.records", label: "Synthetic records", description: "Synthetic report contract proof.", rowIdentity: "synthetic.record.id", capability: "synthetic.manage",
    fields: [{ id: "synthetic.record.id", label: "Record ID", group: "Synthetic", kind: "dimension" as const, valueType: "text" as const, sortable: true, filterOperators: ["contains" as const] }], filters: [], groupBy: ["synthetic.record.id"], defaultColumns: ["synthetic.record.id"], defaultSort: { field: "synthetic.record.id", direction: "asc" as const }, relationships: [],
  }] };
  const registry = createModuleRegistry([synthetic]);
  const dispatcher = createModuleReportDispatcher(registry, [{ moduleId: "synthetic", handlers: { "synthetic.records": async () => [{ id: "one", label: "One", cells: { "synthetic.record.id": { text: "one", sortValue: "one" } } }] } }]);
  assert.equal(dispatcher.owner("synthetic.records")?.id, "synthetic");
  assert.throws(() => createModuleReportDispatcher(registry, [{ moduleId: "synthetic", handlers: {} }]), /handlers do not match declared datasets/i);
  assert.throws(() => createModuleRegistry([{ ...synthetic, reportDatasets: [{ ...synthetic.reportDatasets[0], relationships: [{ dataset: "missing.records", localField: "synthetic.record.id", foreignField: "missing.record.id" }] }] }]), /relationship target is unavailable/i);
  assert.throws(() => createModuleRegistry([{ ...synthetic, reportDatasets: [{ ...synthetic.reportDatasets[0], fields: [{ id: "core.member.name", label: "Conflicting member", group: "Synthetic", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] }], rowIdentity: "core.member.name", groupBy: ["core.member.name"], defaultColumns: ["core.member.name"], defaultSort: { field: "core.member.name", direction: "asc" } }] }]), /conflicting shared report field/i);
});

test("Attendance setup declares required work and skippable integrations", () => {
  const attendance = bundledModuleRegistry.modules.find((module) => module.id === "attendance");
  assert.equal(attendance?.setup.version, 2);
  assert.deepEqual(attendance?.setup.steps.filter((step) => step.required).map((step) => step.id), ["rules", "meeting", "input"]);
  assert.deepEqual(attendance?.setup.steps.filter((step) => !step.required).map((step) => step.id), ["calendar", "discord"]);
});

test("module persistence and portable backup ownership are collision checked", () => {
  assert.equal(bundledModuleRegistry.tableOwner("meetings")?.id, "attendance");
  assert.equal(bundledModuleRegistry.tableOwner("hours_entries")?.id, "hour-tracking");
  assert.equal(bundledModuleRegistry.tableOwner("members"), undefined);
  assert.equal(attendanceModule.backup.version, 2);
  assert.ok(attendanceModule.persistence.sharedFields.some((entry) => entry.table === "organization_settings" && entry.columns.includes("kiosk_authentication_method")));
  assert.deepEqual(bundledModuleRegistry.tableOwner("kiosks")?.persistence.transientAuthority.find((entry) => entry.table === "kiosks")?.columns, ["token_hash", "active"]);
  const duplicateTableModule = { ...outreachModule, interfaces: [], persistence: { ...outreachModule.persistence, tables: [...outreachModule.persistence.tables, "meetings"] }, backup: { ...outreachModule.backup, tables: [...outreachModule.backup.tables, "meetings"] } };
  assert.throws(() => createModuleRegistry([attendanceModule, duplicateTableModule]), /duplicate module persistence table/i);
  assert.throws(() => createModuleRegistry([{ ...outreachModule, interfaces: [], persistence: { ...outreachModule.persistence, transientAuthority: [{ table: "members", columns: ["active"] }] } }]), /Transient authority must belong to a module table/i);
});

test("module selection supports Core-only, Attendance, and Outreach installations", () => {
  assert.deepEqual(bundledModuleRegistry.validateSelection([]), []);
  assert.deepEqual(bundledModuleRegistry.validateSelection(["attendance"]), ["attendance"]);
  assert.deepEqual(bundledModuleRegistry.validateSelection(["hour-tracking"]), ["hour-tracking"]);
  assert.deepEqual(bundledModuleRegistry.validateSelection(["attendance", "hour-tracking"]), ["attendance", "hour-tracking"]);
  assert.deepEqual(bundledModuleRegistry.modules.map((module) => module.id), ["attendance", "hour-tracking"]);
  assert.throws(() => bundledModuleRegistry.validateSelection(["unknown"]));
});

test("module configuration requires explicit current disable authority", () => {
  assert.deepEqual(validateModuleConfiguration({ enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 3 }] }), {
    enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 3 }],
  });
  assert.throws(() => validateModuleConfiguration({ enabled: ["attendance", "attendance"], revision: 2 }));
  assert.throws(() => validateModuleConfiguration({ enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 0 }] }));
});

test("Operator assignments accept only declared Operator capabilities", () => {
  assert.deepEqual(validateModuleAssignments({ capabilities: ["attendance.manage"], revision: 0 }), { capabilities: ["attendance.manage"], revision: 0 });
  assert.deepEqual(validateModuleAssignments({ capabilities: ["hours.manage"], revision: 0 }), { capabilities: ["hours.manage"], revision: 0 });
  assert.deepEqual(validateModuleAssignments({ capabilities: [], revision: 4 }), { capabilities: [], revision: 4 });
  assert.throws(() => validateModuleAssignments({ capabilities: ["attendance.admin"], revision: 0 }));
});

test("module table prefixes claim owned names without overlapping another module", () => {
  assert.equal(outreachModule.tablePrefix, "hours_");
  assert.equal(attendanceModule.tablePrefix, undefined);
  const persistence = { tables: ["example_items", "example_notes"], sharedFields: [], transientAuthority: [] };
  const example = { ...outreachModule, interfaces: [], reportFilters: [], walkthroughs: {}, id: "example", label: "Example", capabilities: [{ id: "example.manage", label: "Manage Example", operator: true }], navigation: [], settings: [], setup: { version: 1, steps: [] }, jobs: [], discordCommands: [], reportDatasets: [], apiRoutes: [{ path: "/admin/example", match: "prefix" as const, access: "workspace" as const }], tablePrefix: "example_", persistence, backup: { version: 1, tables: ["example_items", "example_notes"] }, lifecycle: { cleanupTargets: ["example_items", "example_notes"] } };
  assert.equal(createModuleRegistry([attendanceModule, outreachModule, example]).tableOwner("example_items")?.id, "example");
  for (const tablePrefix of ["Example_", "example", "_example_", "1example_", "example-", "example_.", ""]) assert.throws(() => createModuleRegistry([{ ...example, tablePrefix }]), /Invalid module table prefix/, tablePrefix);
  assert.throws(() => createModuleRegistry([{ ...example, persistence: { ...persistence, tables: ["example_items", "notes"] }, backup: { version: 1, tables: ["example_items", "notes"] }, lifecycle: { cleanupTargets: ["example_items", "notes"] } }]), /Invalid module table prefix/);
  const second = { ...example, id: "second", capabilities: [{ id: "second.manage", label: "Manage Second", operator: true }], persistence: { ...persistence, tables: [] }, backup: { version: 1, tables: [] }, lifecycle: { cleanupTargets: ["second"] } };
  assert.equal(createModuleRegistry([example, { ...second, tablePrefix: "second_" }]).modules.length, 2);
  assert.equal(createModuleRegistry([example, { ...second, tablePrefix: "ex_" }]).modules.length, 2);
  for (const tablePrefix of ["example_", "example_extra_"]) assert.throws(() => createModuleRegistry([example, { ...second, tablePrefix }]), /Overlapping module table prefix/, tablePrefix);
  assert.throws(() => createModuleRegistry([{ ...example, tablePrefix: "ex_", persistence: { ...persistence, tables: [] }, backup: { version: 1, tables: [] }, lifecycle: { cleanupTargets: ["example"] } }, { ...second, tablePrefix: "ex_a_" }]), /Overlapping module table prefix/);
  // A prefix may not claim names another module already declares, even when that module has no prefix.
  assert.throws(() => createModuleRegistry([attendanceModule, { ...second, tablePrefix: "meeting_" }]), /Overlapping module table prefix/);
  assert.throws(() => createModuleRegistry([outreachModule, { ...second, tablePrefix: "hours_public_" }]), /Overlapping module table prefix/);
});

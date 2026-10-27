import test from "node:test";
import assert from "node:assert/strict";
import { attendanceModule, createModuleRegistry, type ModuleDefinition , bundledModuleRegistry } from "../../packages/shared/src/module-platform.ts";
import { composeDashboardModules, contributedModules, createDashboardModuleSet, dashboardModuleWideLayout, dashboardSlotContributors, dashboardSlots, decodeDashboardPathParams, matchDashboardPath, resolveDashboardModulePage, validDashboardPathPattern, type DashboardModuleContribution } from "../../apps/dashboard/src/module-contributions.ts";
import { externalDashboardModules } from "../../apps/dashboard/src/generated/external-modules.ts";

// Outreach is the official plugin composed for this file; its manifest is no longer a first-party export.
const outreachModule = bundledModuleRegistry.get("hour-tracking")!;

// A synthetic standalone module with a wide workspace, a nested plan route, a settings page and setup.
const ridesModule: ModuleDefinition = {
  ...outreachModule, reportFilters: [], walkthroughs: {}, id: "rides", label: "Rides", description: "Synthetic module for dashboard contribution tests.",
  capabilities: [{ id: "rides.manage", label: "Manage Rides", operator: true }], navigation: [{ label: "Rides", path: "/rides" }], settings: [{ label: "Rides", path: "/settings/rides" }],
  setup: { version: 1, steps: [{ id: "workspace", label: "First plan", required: true }] }, jobs: [], discordCommands: [], reportDatasets: [],
  apiRoutes: [{ path: "/admin/rides", match: "prefix", access: "workspace" }], tablePrefix: "rides_", persistence: { tables: [], sharedFields: [], transientAuthority: [] },
  backup: { version: 1, tables: [] }, lifecycle: { cleanupTargets: ["platform_module_assignments:rides"] }, deletedData: ["Synthetic rides"],
};
const registry = createModuleRegistry([attendanceModule, outreachModule, ridesModule]);
const render = () => null;
const setup = () => null;
const attendance: DashboardModuleContribution = { moduleId: "attendance", coreShell: true, setup };
const outreach: DashboardModuleContribution = {
  moduleId: "hour-tracking",
  routes: [{ path: "/hours", render, wide: true }, { path: "/hours/activities/:activityId+", render, wide: true }],
  settingsPages: [{ path: "/settings/outreach-setup", operator: true, render }],
  setup,
  walkthroughs: [{ path: "/hours", definition: { pageId: "outreach", readySelector: "", returnFocusSelector: "", welcomeTitle: "", welcomeDescription: "", finishTitle: "", finishDescription: "", steps: [] } }],
};
const rides: DashboardModuleContribution = {
  moduleId: "rides",
  routes: [{ path: "/rides", render, wide: true }, { path: "/rides/plans/:planId+", render, wide: true }],
  settingsPages: [{ path: "/settings/rides", render }],
  setup,
};

test("core builds without plugins compose no external dashboard modules", () => {
  assert.deepEqual(externalDashboardModules, []);
});

test("path patterns match the hand-written dashboard routes they replace", () => {
  for (const pattern of ["/hours", "/hours/activities/:activityId+", "/rides/plans/:planId+", "/a/:b/c"]) assert.equal(validDashboardPathPattern(pattern), true, pattern);
  for (const pattern of ["hours", "/hours/", "/:rest+/after", "/a/:id/:id", "/a//b", "/a/:Bad"]) assert.equal(validDashboardPathPattern(pattern), false, pattern);
  const legacy = (path: string) => path.startsWith("/hours/activities/") && path.slice("/hours/activities/".length) ? path.slice("/hours/activities/".length) : undefined;
  for (const path of ["/hours", "/hours/activities", "/hours/activities/a", "/hours/activities/a/b", "/hours/activities//x", "/hours/activity/a", "/hoursx"]) {
    assert.equal(matchDashboardPath("/hours/activities/:activityId+", path)?.activityId, legacy(path), path);
  }
  assert.deepEqual(matchDashboardPath("/hours", "/hours"), {});
  assert.equal(matchDashboardPath("/hours", "/hours/x"), undefined);
  assert.deepEqual(matchDashboardPath("/a/:b/c", "/a/x/c"), { b: "x" });
  assert.equal(matchDashboardPath("/a/:b/c", "/a//c"), undefined);
  assert.deepEqual(decodeDashboardPathParams({ planId: "plan%2Fone" }), { planId: "plan/one" });
  assert.throws(() => decodeDashboardPathParams({ planId: "%E0" }), URIError);
});

test("dashboard contributions must implement exactly the registry declarations", () => {
  const modules = createDashboardModuleSet(registry, [rides, attendance, outreach]);
  assert.deepEqual(modules.all.map((item) => item.moduleId), ["attendance", "hour-tracking", "rides"]);
  assert.equal(modules.require("rides"), rides);
  assert.equal(modules.get("missing"), undefined);
  assert.throws(() => modules.require("missing"), /Unknown module contribution/);
  const invalid: [string, DashboardModuleContribution[], RegExp][] = [
    ["missing module", [attendance, outreach], /rides dashboard implementation is missing/],
    ["duplicate module", [attendance, outreach, rides, rides], /Invalid or duplicate/],
    ["undeclared module", [attendance, outreach, rides, { moduleId: "unknown" }], /Invalid or duplicate/],
    ["unrendered navigation", [attendance, outreach, { ...rides, routes: [{ path: "/rides/plans/:planId+", render }] }], /navigation is not rendered/],
    ["route outside navigation", [attendance, outreach, { ...rides, routes: [...rides.routes!, { path: "/roster", render }] }], /routes do not match/],
    ["duplicate route", [attendance, outreach, { ...rides, routes: [...rides.routes!, { path: "/rides", render }] }], /routes do not match/],
    ["invalid route pattern", [attendance, outreach, { ...rides, routes: [...rides.routes!, { path: "/rides/:rest+/x", render }] }], /routes do not match/],
    ["missing settings", [attendance, outreach, { ...rides, settingsPages: [] }], /settings pages do not match/],
    ["undeclared settings", [attendance, outreach, { ...rides, settingsPages: [...rides.settingsPages!, { path: "/settings/rides-extra", render }] }], /settings pages do not match/],
    ["walkthrough without route", [attendance, { ...outreach, walkthroughs: [{ ...outreach.walkthroughs![0]!, path: "/hours/other" }] }, rides], /walkthroughs do not match/],
    ["missing setup", [attendance, outreach, { ...rides, setup: undefined }], /setup workspace does not match/],
    ["core shell pages", [{ ...attendance, routes: [] }, outreach, rides], /pages remain in the Core shell/],
    ["contributed core pages", [{ moduleId: "attendance", setup }, outreach, rides], /navigation is not rendered/],
  ];
  for (const [name, contributions, message] of invalid) assert.throws(() => createDashboardModuleSet(registry, contributions), message, name);
});

test("contributed pages render only for ready modules, Admin-only settings stay Admin-only, and wide layout is static", () => {
  const modules = createDashboardModuleSet(registry, [attendance, outreach, rides]);
  const allReady = () => true;
  assert.deepEqual(contributedModules(modules, allReady).map(({ manifest }) => manifest.id), ["hour-tracking", "rides"]);
  assert.deepEqual(contributedModules(modules, (id) => id === "rides").flatMap(({ manifest }) => manifest.navigation.map((item) => item.label)), ["Rides"]);
  assert.equal(resolveDashboardModulePage(modules, "/rides/plans/plan%2Fone", "operator", allReady)?.params.planId, "plan%2Fone");
  assert.equal(resolveDashboardModulePage(modules, "/rides", "admin", (id) => id !== "rides"), undefined);
  assert.equal(resolveDashboardModulePage(modules, "/settings/rides", "operator", allReady), undefined);
  assert.equal(resolveDashboardModulePage(modules, "/settings/rides", "admin", allReady)?.moduleId, "rides");
  assert.equal(resolveDashboardModulePage(modules, "/settings/outreach-setup", "operator", allReady)?.moduleId, "hour-tracking");
  assert.equal(resolveDashboardModulePage(modules, "/dashboard", "admin", allReady), undefined);
  for (const path of ["/hours", "/hours/activities/x", "/rides", "/rides/plans/x"]) assert.equal(dashboardModuleWideLayout(modules, path), true, path);
  for (const path of ["/settings/rides", "/settings/outreach-setup", "/rides/plans", "/dashboard"]) assert.equal(dashboardModuleWideLayout(modules, path), false, path);
});

test("slot contributions must target host slots of the matching kind and render only while host and module are ready", () => {
  const badge = () => null;
  const withSlots = { ...rides, slotData: { "attendance.meeting-collection": () => [] }, slots: { "attendance.calendar-meeting-badge": badge, "attendance.meeting-detail-panel": badge } } as DashboardModuleContribution;
  const modules = createDashboardModuleSet(registry, [attendance, outreach, withSlots]);
  const invalid: [string, DashboardModuleContribution][] = [
    ["unknown slot", { ...rides, slots: { "attendance.unknown": badge } } as unknown as DashboardModuleContribution],
    ["data hook in a render slot", { ...rides, slotData: { "attendance.calendar-meeting-badge": () => [] } } as unknown as DashboardModuleContribution],
    ["component in a data slot", { ...rides, slots: { "attendance.meeting-collection": badge } } as unknown as DashboardModuleContribution],
    ["missing component", { ...rides, slots: { "attendance.calendar-meeting-badge": undefined } } as unknown as DashboardModuleContribution],
  ];
  for (const [name, contribution] of invalid) assert.throws(() => createDashboardModuleSet(registry, [attendance, outreach, contribution]), /slot contributions do not match host slots/, name);
  const ids = (slot: Parameters<typeof dashboardSlotContributors>[1], ready: (id: string) => boolean) => dashboardSlotContributors(modules, slot, ready).map(({ manifest }) => manifest.id);
  assert.deepEqual(ids("attendance.calendar-meeting-badge", () => true), ["rides"]);
  assert.deepEqual(ids("attendance.meeting-collection", () => true), ["rides"]);
  assert.deepEqual(ids("attendance.meeting-directory-badge", () => true), []);
  assert.deepEqual(ids("attendance.calendar-meeting-badge", (id) => id !== "attendance"), [], "the host module must be ready");
  assert.deepEqual(ids("attendance.calendar-meeting-badge", (id) => id !== "rides"), [], "the contributing module must be ready");
  for (const [slot, definition] of Object.entries(dashboardSlots)) assert.equal(registry.get(definition.host)?.id, definition.host, slot);
});

test("an invalid plugin dashboard contribution is left out without breaking Core or other plugins", () => {
  const plugin = (id: string) => ({ ...ridesModule, id, label: id, tablePrefix: `${id}_`, capabilities: [{ id: `${id}.manage`, label: id, operator: true }], navigation: [{ label: id, path: `/${id}` }], settings: [], setup: { version: 1, steps: [] },
    apiRoutes: [{ path: `/admin/${id}`, match: "prefix" as const, access: "workspace" as const }], persistence: { tables: [`${id}_rows`], sharedFields: [], transientAuthority: [] }, backup: { version: 1, tables: [`${id}_rows`] }, lifecycle: { cleanupTargets: [`${id}_rows`] } });
  const valid: DashboardModuleContribution = { moduleId: "valid", routes: [{ path: "/valid", render }] };
  const broken: DashboardModuleContribution = { moduleId: "broken" };
  const orphan: DashboardModuleContribution = { moduleId: "orphan", routes: [{ path: "/orphan", render }] };
  const reported: string[] = [];
  const set = composeDashboardModules({
    firstParty: [attendanceModule, outreachModule, ridesModule], firstPartyContributions: [attendance, outreach, rides],
    externalManifests: [plugin("broken"), plugin("valid")], externalContributions: [broken, valid, orphan],
    createRegistry: createModuleRegistry, report: (moduleId) => reported.push(moduleId),
  });
  assert.deepEqual(set.all.map((contribution) => contribution.moduleId), ["attendance", "hour-tracking", "rides", "valid"]);
  assert.deepEqual(reported, ["broken", "orphan"]);
});

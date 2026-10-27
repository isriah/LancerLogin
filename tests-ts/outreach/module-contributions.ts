import test from "node:test";
import assert from "node:assert/strict";
import { bundledModuleRegistry, createModuleRegistry, type ModuleDefinition } from "../../packages/shared/src/module-platform.ts";
import { createApiModuleSet, type ApiModuleContribution } from "../../apps/api/src/module-contributions.ts";
import { installedApiModules } from "../../apps/api/src/installed-api-modules.ts";

// Outreach is the official plugin composed for this file; its manifest is no longer a first-party export.
const outreachModule = bundledModuleRegistry.get("hour-tracking")!;

const synthetic: ModuleDefinition = {
  ...outreachModule,
  reportFilters: [],
  walkthroughs: {},
  id: "synthetic",
  description: "Synthetic module for contribution binding tests.",
  discordCommands: [],
  reportDatasets: [],
  label: "Synthetic",
  capabilities: [{ id: "synthetic.manage", label: "Manage Synthetic", operator: true }],
  navigation: [{ label: "Synthetic", path: "/synthetic" }],
  settings: [],
  setup: { version: 1, steps: [{ id: "workspace", label: "First record", required: true }] },
  jobs: [{ id: "synthetic.sync", interval: 300_000 }],
  apiRoutes: [{ path: "/admin/synthetic", match: "prefix", access: "workspace" }, { path: "/public/synthetic", match: "prefix", access: "service" }],
  tablePrefix: "synthetic_",
  persistence: { tables: ["synthetic_records"], sharedFields: [], transientAuthority: [] },
  backup: { version: 1, tables: ["synthetic_records"] },
  lifecycle: { cleanupTargets: ["synthetic_records", "platform_module_assignments:synthetic"] },
  deletedData: ["Synthetic records"],
};
const registry = createModuleRegistry([synthetic]);
const handled = async () => new Response("ok");
const contribution: ApiModuleContribution<unknown> = {
  moduleId: "synthetic",
  routes: { "/admin/synthetic": handled, "/public/synthetic": handled },
  privateResponseRoutes: ["/public/synthetic"],
  setup: { predicates: { workspace: (installationId) => ({ sql: "EXISTS(SELECT 1 FROM synthetic_records WHERE installation_id=?)", bindings: [installationId] }) }, stepValid: async () => true },
  jobs: { "synthetic.sync": async () => undefined },
  cleanup: { steps: [{ kind: "delete", table: "synthetic_records" }, { kind: "assignments" }] },
};

test("an unshipped synthetic module registers routes, setup, jobs and cleanup without Core branching", () => {
  const modules = createApiModuleSet(registry, [contribution]);
  assert.equal(modules.require("synthetic").routes?.["/admin/synthetic"], handled);
  assert.deepEqual(modules.all.map((module) => module.moduleId), ["synthetic"]);
});

test("module contributions must implement exactly what the module declares", () => {
  const rejects = (changes: Partial<ApiModuleContribution<unknown>>, pattern: RegExp) => assert.throws(() => createApiModuleSet(registry, [{ ...contribution, ...changes }]), pattern);
  rejects({ routes: { "/admin/synthetic": handled } }, /route handlers do not match/);
  rejects({ routes: { ...contribution.routes, "/admin/undeclared": handled } }, /route handlers do not match/);
  rejects({ coreRoutes: true }, /route handlers do not match/);
  rejects({ privateResponseRoutes: ["/admin/undeclared"] }, /private response routes must be declared/);
  rejects({ setup: { ...contribution.setup, predicates: {} } }, /setup bindings do not match/);
  rejects({ jobs: {} }, /job handlers do not match/);
  rejects({ jobs: { ...contribution.jobs, "synthetic.extra": async () => undefined } }, /job handlers do not match/);
  rejects({ reports: { "synthetic.records": async () => [] } }, /report handlers do not match/);
  rejects({ discord: { "synthetic-check": async () => "ok" } }, /Discord handlers do not match/);
  rejects({ cleanup: { steps: [] } }, /cleanup steps are invalid/);
  rejects({ cleanup: { steps: [{ kind: "delete", table: "synthetic_records; DROP TABLE members" }] } }, /cleanup steps are invalid/);
  rejects({ moduleId: "unknown" }, /Invalid or duplicate module contribution/);
  assert.throws(() => createApiModuleSet(registry, [contribution, contribution]), /Invalid or duplicate module contribution/);
  assert.throws(() => createApiModuleSet(registry, []), /implementation is missing/);
});

test("installed first-party modules satisfy the registry once Attendance runtime handlers are bound", () => {
  const attendance = bundledModuleRegistry.get("attendance")!;
  const runtime = {
    jobs: Object.fromEntries(attendance.jobs.map((job) => [job.id, async () => undefined])),
    reports: Object.fromEntries((attendance.reportDatasets ?? []).map((dataset) => [dataset.id, async () => []])),
  };
  const bound = installedApiModules.map((module) => module.moduleId === "attendance" ? { ...module, ...runtime } : module);
  assert.deepEqual(createApiModuleSet(bundledModuleRegistry, bound).all.map((module) => module.moduleId), bundledModuleRegistry.modules.map((module) => module.id));
  assert.throws(() => createApiModuleSet(bundledModuleRegistry, installedApiModules), /Module attendance job handlers do not match declared jobs/);
  assert.equal(installedApiModules.find((module) => module.moduleId === "attendance")?.coreRoutes, true);
  assert.deepEqual(installedApiModules.find((module) => module.moduleId === "hour-tracking")?.privateResponseRoutes, ["/public/hours"]);
});

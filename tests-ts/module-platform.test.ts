// Module registry, assignments and table ownership that need no plugin, run without composing one. The Outreach-dependent cases are in outreach/module-platform.ts (outreach-module-platform.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { validateModuleConfiguration } from "../apps/api/src/module-platform.ts";

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

test("Attendance setup declares required work and skippable integrations", () => {
  const attendance = bundledModuleRegistry.modules.find((module) => module.id === "attendance");
  assert.equal(attendance?.setup.version, 2);
  assert.deepEqual(attendance?.setup.steps.filter((step) => step.required).map((step) => step.id), ["rules", "meeting", "input"]);
  assert.deepEqual(attendance?.setup.steps.filter((step) => !step.required).map((step) => step.id), ["calendar", "discord"]);
});

test("module configuration requires explicit current disable authority", () => {
  assert.deepEqual(validateModuleConfiguration({ enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 3 }] }), {
    enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 3 }],
  });
  assert.throws(() => validateModuleConfiguration({ enabled: ["attendance", "attendance"], revision: 2 }));
  assert.throws(() => validateModuleConfiguration({ enabled: [], revision: 2, confirmDisable: [{ moduleId: "attendance", generation: 0 }] }));
});

import test from "node:test";
import assert from "node:assert/strict";
import { dashboardConformanceMatrix, dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance.ts";

test("dashboard conformance inventory assigns every governed surface to WU-055 through WU-060", () => {
  const owners = new Set(dashboardConformanceMatrix.map(({ owner }) => owner));
  assert.deepEqual([...owners].sort(), ["WU-055", "WU-056", "WU-057", "WU-058", "WU-059", "WU-060"]);
  assert.equal(dashboardConformanceMatrix.every(({ routes, overlays, states }) => routes.length && overlays.length && states.length), true);

  const routes = dashboardConformanceMatrix.flatMap(({ routes }) => routes);
  for (const route of [
    "/dashboard", "/meetings", "/meetings/[ID]", "/attendance", "/reports", "/roster", "/roster/[ID]", "/kiosks",
    "/settings/organization", "/settings/configuration", "/settings/access", "/settings/integrations",
    "/settings/privacy", "/settings/data", "/settings/guided-setup", "/settings/updates",
  ]) assert.equal(routes.includes(route), true, `${route} must remain in the executable inventory`);

  const overlays = dashboardConformanceMatrix.flatMap(({ overlays }) => overlays).join(" ");
  for (const overlay of ["completion dialog", "creation dialog", "edit dialog", "duplicate dialog", "delete dialog", "pairing dialog", "loading overlay", "contest dialog", "update popup"]) {
    assert.match(overlays, new RegExp(overlay));
  }
});

test("dashboard conformance inventory pins the required reference combinations", () => {
  assert.deepEqual(dashboardConformanceReferences.viewports, [{ width: 1280, height: 900 }, { width: 390, height: 844 }]);
  assert.deepEqual(dashboardConformanceReferences.themes, ["light", "dark"]);
  assert.deepEqual(dashboardConformanceReferences.brand, { primary: "#7c3aed", secondary: "#0f766e" });
  assert.deepEqual(dashboardConformanceReferences.input, ["pointer", "keyboard"]);
  assert.deepEqual(dashboardConformanceReferences.motion, ["no-preference", "reduce"]);
  assert.deepEqual(dashboardConformanceReferences.roles, ["admin", "operator"]);
});

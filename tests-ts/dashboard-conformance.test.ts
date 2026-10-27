import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { stylesheetRules } from "./fixtures/stylesheet-rules.ts";
import { dashboardConformanceMatrix, dashboardConformanceReferences, dashboardModuleScope, dashboardModuleStylesheets } from "../apps/dashboard/src/design-conformance.ts";

test("dashboard conformance inventory assigns every governed surface to 01-authentication through 06-convergence", () => {
  const owners = new Set(dashboardConformanceMatrix.map(({ owner }) => owner));
  assert.deepEqual([...owners].sort(), ["01-authentication", "02-meetings", "03-reporting", "04-kiosks", "05-settings", "06-convergence"]);
  assert.equal(dashboardConformanceMatrix.every(({ routes, overlays, states, browserSpecs }) => routes.length && overlays.length && states.length && browserSpecs.length), true);

  const routes = dashboardConformanceMatrix.flatMap(({ routes }) => routes);
  for (const route of [
    "/dashboard", "/meetings", "/meetings/[ID]", "/attendance", "/reports", "/roster", "/roster/[ID]", "/kiosks",
    "/settings/organization", "/settings/configuration", "/settings/access", "/settings/integrations",
    "/settings/data", "/settings/guided-setup", "/settings/updates", "/hours", "/submit-hours",
  ]) assert.equal(routes.includes(route), true, `${route} must remain in the executable inventory`);

  const overlays = dashboardConformanceMatrix.flatMap(({ overlays }) => overlays).join(" ");
  for (const overlay of ["completion dialog", "creation dialog", "edit dialog", "duplicate dialog", "delete dialog", "pairing dialog", "loading overlay", "contest dialog", "update popup"]) {
    assert.match(overlays, new RegExp(overlay));
  }
});

test("every governed surface names executable rendered conformance coverage", async () => {
  const specs = new Set(dashboardConformanceMatrix.flatMap(({ browserSpecs }) => browserSpecs));
  for (const spec of specs) await access(`tests-browser/${spec}`);
});

test("dashboard conformance inventory pins the required reference combinations", () => {
  assert.deepEqual(dashboardConformanceReferences.viewports, [{ width: 1280, height: 900 }, { width: 390, height: 844 }]);
  assert.deepEqual(dashboardConformanceReferences.themes, ["light", "dark"]);
  assert.deepEqual(dashboardConformanceReferences.brand, { primary: "#7c3aed", secondary: "#0f766e" });
  assert.deepEqual(dashboardConformanceReferences.input, ["pointer", "keyboard"]);
  assert.deepEqual(dashboardConformanceReferences.motion, ["no-preference", "reduce"]);
  assert.deepEqual(dashboardConformanceReferences.roles, ["admin", "operator"]);
});

test("module stylesheets stay beneath their module root and Core stylesheets leave module classes alone", async () => {
  const folder = "apps/dashboard/src";
  const files = (await readdir(folder, { recursive: true })).map((file) => String(file).replaceAll("\\", "/"));
  const sources = new Map(await Promise.all(files.filter((file) => /\.(css|tsx?)$/.test(file)).map(async (file) => [file, await readFile(`${folder}/${file}`, "utf8")] as const)));
  const moduleSheets = new Set<string>(dashboardModuleStylesheets.map(({ stylesheet }) => stylesheet));
  for (const sheet of dashboardModuleStylesheets) {
    const css = sources.get(sheet.stylesheet);
    assert.ok(css, `${sheet.stylesheet} must exist`);
    const scope = dashboardModuleScope(sheet.moduleId);
    const rules = stylesheetRules(css);
    assert.ok(rules.length > 0);
    for (const rule of rules) {
      if (rule.keyframes) { assert.ok(rule.keyframes.startsWith(sheet.classPrefix), `${sheet.stylesheet} keyframes ${rule.keyframes} must use the module prefix`); continue; }
      for (const selector of rule.selectors) {
        const scoped = selector.indexOf(scope); const moduleClass = selector.indexOf(`.${sheet.classPrefix}`);
        assert.ok(scoped >= 0 && (moduleClass < 0 || moduleClass > scoped), `${sheet.stylesheet}: ${selector} must sit beneath ${scope}`);
      }
    }
    const importers = [...sources].filter(([file, source]) => /\.tsx?$/.test(file) && source.includes(`import "./${sheet.stylesheet}";`)).map(([file]) => file);
    assert.deepEqual(importers, [sheet.contribution], `${sheet.stylesheet} loads only through its dashboard contribution`);
    for (const spec of sheet.browserSpecs) await access(`tests-browser/${spec}`);
    for (const [file, source] of sources) if (file.endsWith(".css") && !moduleSheets.has(file)) assert.doesNotMatch(source, new RegExp(`\\.${sheet.classPrefix}`), `${file} must not style ${sheet.moduleId} classes`);
  }
});

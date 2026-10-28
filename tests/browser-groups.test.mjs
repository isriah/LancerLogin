import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserGroups, defaultSpecSeconds, discoverBrowserSpecs, parsePart, partitionGroup, pluginDependency, readBrowserGroupManifest, specsForGroup, validateBrowserGroups } from "../scripts/browser-groups.mjs";

// The release gate runs tests-browser in three groups (tests-browser/groups.json). A spec file that is not assigned,
// or a plugin spec placed where the plugins are not composed, would silently drop coverage, so both fail here.
test("every browser spec file is assigned to exactly one valid group with a feature area", () => {
  assert.deepEqual(validateBrowserGroups(), []);
  const { specs } = readBrowserGroupManifest();
  assert.deepEqual(Object.keys(specs).sort(), discoverBrowserSpecs());
});

test("plugin-only specs are in the plugin group and never in the plugin-free core run", () => {
  const { specs } = readBrowserGroupManifest();
  const core = new Set(specsForGroup("core"));
  for (const file of discoverBrowserSpecs()) {
    const dependency = pluginDependency(readFileSync(join("tests-browser", file), "utf8"));
    if (dependency === "file") {
      assert.equal(specs[file].group, "plugin", file);
      assert.ok(!core.has(`tests-browser/${file}`), file);
    }
    // Files that mix plugin-dependent and Core tests run in both modes.
    if (dependency === "tests") assert.equal(specs[file].group, "integration", file);
  }
});

test("the groups cover every spec: core runs core and integration files, the composed groups run the rest", () => {
  const all = discoverBrowserSpecs().map((file) => `tests-browser/${file}`);
  const core = specsForGroup("core"), plugin = specsForGroup("plugin"), integration = specsForGroup("integration");
  assert.deepEqual([...core, ...plugin].sort(), all);
  assert.ok(integration.every((file) => core.includes(file)));
  assert.ok(plugin.every((file) => !core.includes(file)));
  assert.ok(integration.length && plugin.length);
  assert.deepEqual(Object.fromEntries(Object.entries(browserGroups).map(([name, value]) => [name, value.composed])), { core: false, plugin: true, integration: true });
  // The Outreach and Carpool specs, and the Core areas that change with plugins, stay in their groups.
  for (const file of ["outreach-workflow.spec.ts", "carpool-workflow.spec.ts", "modular-reporting.spec.ts"]) assert.ok(plugin.includes(`tests-browser/${file}`), file);
  for (const file of ["settings-conformance.spec.ts", "plugin-management.spec.ts", "module-platform.spec.ts", "module-setup-finish-later.spec.ts", "dashboard-startup.spec.ts", "shell-conformance.spec.ts"])
    assert.ok(integration.includes(`tests-browser/${file}`), file);
});

test("plugin dependency is read from the spec source", () => {
  assert.equal(pluginDependency('import { requireOutreachPlugin } from "./outreach-fixtures";\n\nrequireOutreachPlugin();\n'), "file");
  assert.equal(pluginDependency("requireCarpoolPlugin();\ntest(\"x\", () => {});\n"), "file");
  assert.equal(pluginDependency('test("x", async () => {\n  requireOutreachPlugin();\n});\n'), "tests");
  assert.equal(pluginDependency('test("x", async () => {\n  test.skip(!carpoolComposed, carpoolSkipReason);\n});\n'), "tests");
  assert.equal(pluginDependency('import { outreachSnapshot } from "./module-fixtures";\ntest("x", () => {});\n'), "none");
});

test("validation reports unassigned files, unknown files, invalid groups and misplaced plugin specs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "browser-groups-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests-browser"));
  const write = (file, source) => writeFileSync(join(root, "tests-browser", file), source);
  write("core.spec.ts", 'test("core", () => {});\n');
  write("outreach.spec.ts", "requireOutreachPlugin();\n");
  write("mixed.spec.ts", 'test("x", () => {\n  requireCarpoolPlugin();\n});\n');
  write("new.spec.ts", 'test("new", () => {});\n');
  write("helper.ts", "export {};\n");
  const manifest = (specs) => writeFileSync(join(root, "tests-browser", "groups.json"), JSON.stringify({ specs }));
  manifest({ "core.spec.ts": { group: "core", area: "A" }, "outreach.spec.ts": { group: "plugin", area: "B" }, "mixed.spec.ts": { group: "integration", area: "C" }, "new.spec.ts": { group: "core", area: "D" } });
  assert.deepEqual(validateBrowserGroups(root), []);
  assert.deepEqual(specsForGroup("core", root), ["tests-browser/core.spec.ts", "tests-browser/mixed.spec.ts", "tests-browser/new.spec.ts"]);
  assert.deepEqual(specsForGroup("plugin", root), ["tests-browser/outreach.spec.ts"]);
  assert.deepEqual(specsForGroup("integration", root), ["tests-browser/mixed.spec.ts"]);
  assert.throws(() => specsForGroup("everything", root), /Unknown browser group/);

  manifest({ "core.spec.ts": { group: "core", area: "A" }, "outreach.spec.ts": { group: "core", area: "B" }, "mixed.spec.ts": { group: "plugin", area: "C" }, "gone.spec.ts": { group: "core", area: "E" }, "new.spec.ts": { group: "extra", area: "D" } });
  const problems = validateBrowserGroups(root).join("\n");
  assert.match(problems, /outreach\.spec\.ts skips entirely without a plugin, so it belongs in the plugin group, not core/);
  assert.match(problems, /mixed\.spec\.ts has plugin-dependent tests and Core tests, so it belongs in the integration group, not plugin/);
  assert.match(problems, /lists gone\.spec\.ts, which is not a spec file/);
  assert.match(problems, /new\.spec\.ts has group "extra"/);
  assert.throws(() => specsForGroup("core", root), /Browser groups are invalid/);

  manifest({ "core.spec.ts": { group: "plugin", area: "A" }, "outreach.spec.ts": { group: "plugin", area: "" }, "mixed.spec.ts": { group: "integration", area: "C" } });
  const second = validateBrowserGroups(root).join("\n");
  assert.match(second, /new\.spec\.ts is not assigned to a browser group/);
  assert.match(second, /core\.spec\.ts does not require a plugin/);
  assert.match(second, /outreach\.spec\.ts needs a feature area/);
});

test("the browser runner selects a group and refuses a group in the wrong composition mode", () => {
  const runner = readFileSync("scripts/run-browser-tests.mjs", "utf8");
  assert.match(runner, /takeOption\(composeOption\.args, "--group"\)/);
  assert.match(runner, /browserGroups\[group\]\.composed && !selection/);
  assert.match(runner, /!browserGroups\[group\]\.composed && selection/);
  assert.match(runner, /specsForGroup\(group, workspace\)/);
});

test("parts split a group by whole files, cover it exactly once and balance measured seconds", (t) => {
  for (const [group, parts] of [["core", 4], ["core", 5], ["plugin", 1], ["plugin", 2], ["integration", 1], ["integration", 2]]) {
    const split = partitionGroup(group, parts);
    assert.equal(split.length, parts);
    assert.deepEqual(split.flatMap((part) => part.files).sort(), specsForGroup(group));
    assert.ok(split.every((part) => part.files.length > 0), group);
  }
  const root = mkdtempSync(join(tmpdir(), "browser-parts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests-browser"));
  const specs = {};
  for (const [name, seconds] of [["a", 300], ["b", 200], ["c", 100], ["d", 100], ["e", undefined]]) {
    writeFileSync(join(root, "tests-browser", `${name}.spec.ts`), 'test("x", () => {});\n');
    specs[`${name}.spec.ts`] = { group: "core", area: "A", ...(seconds ? { seconds } : {}) };
  }
  writeFileSync(join(root, "tests-browser", "groups.json"), JSON.stringify({ specs }));
  // Longest first onto the lightest part; e has no measurement and counts as defaultSpecSeconds.
  assert.equal(defaultSpecSeconds, 60);
  assert.deepEqual(partitionGroup("core", 2, root), [
    { seconds: 400, files: ["tests-browser/a.spec.ts", "tests-browser/d.spec.ts"] },
    { seconds: 360, files: ["tests-browser/b.spec.ts", "tests-browser/c.spec.ts", "tests-browser/e.spec.ts"] },
  ]);
  for (const parts of [0, 6, 1.5]) assert.throws(() => partitionGroup("core", parts, root), /cannot be split/);
  assert.deepEqual(parsePart("2/5"), { part: 2, parts: 5 });
  for (const bad of ["0/5", "6/5", "2", "a/b", "2/5/1"]) assert.throws(() => parsePart(bad), /--part needs/);
  specs["a.spec.ts"].seconds = -1;
  writeFileSync(join(root, "tests-browser", "groups.json"), JSON.stringify({ specs }));
  assert.match(validateBrowserGroups(root).join("\n"), /a\.spec\.ts has seconds -1/);
});

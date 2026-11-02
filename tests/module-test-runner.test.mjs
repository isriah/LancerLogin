import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTestClosures, closureChain, executedFiles } from "../scripts/check-quick.mjs";
import { discoverModuleManifests, requiredPluginVariables, runModuleTests } from "../scripts/run-module-tests.mjs";

function workspace(manifest, { createTest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lancerlogin-module-tests-"));
  mkdirSync(join(root, "module-tests"));
  mkdirSync(join(root, "tests-ts"));
  if (createTest) writeFileSync(join(root, "tests-ts", "example.test.ts"), "export {};\n");
  writeFileSync(join(root, "module-tests", `${manifest.module}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

const selection = {
  javascript: [],
  typescript: ["tests-ts/example.test.ts"],
  browser: [],
  typecheckWorkspaces: [],
  buildWorkspaces: [],
};
const manifest = { schemaVersion: 1, module: "example", label: "Example", fast: selection, acceptance: selection };

test("module test manifests support list and non-executing selections", () => {
  const root = workspace(manifest);
  assert.deepEqual([...discoverModuleManifests(root).keys()], ["example"]);
  assert.equal(runModuleTests({ root, mode: "list", execute: false }), 0);
  assert.equal(runModuleTests({ root, mode: "fast", moduleId: "example", execute: false }), 0);
});

test("module test manifests reject unknown modules", () => {
  const root = workspace(manifest);
  assert.throws(() => runModuleTests({ root, mode: "fast", moduleId: "missing", execute: false }), /Unknown module missing.*example \(Example\)/i);
});

test("the Outreach plugin's manifest answers to outreach, and unknown IDs name each manifest's label", () => {
  assert.equal(runModuleTests({ mode: "fast", moduleId: "outreach", execute: false }), 0);
  assert.throws(() => runModuleTests({ mode: "fast", moduleId: "outreach-plugin", execute: false }), /hour-tracking \(Outreach Participation plugin; also outreach\)/);
});

// A plugin that can't be fetched must fail the module gate, not turn its tests into skips.
test("module runs require every plugin their selection composes", () => {
  const manifests = discoverModuleManifests();
  // Attendance composes no plugin and lists no plugin-gated test, but the runner still requires Core's official modules,
  // which every manifest composes by default, so a test added later that composes Outreach fails rather than skips.
  assert.deepEqual(requiredPluginVariables(manifests.get("attendance")), { LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN: "1" });
  assert.deepEqual(requiredPluginVariables(manifest, workspace(manifest)), {});
  assert.deepEqual(requiredPluginVariables(manifests.get("hour-tracking")), { LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN: "1" });
  assert.deepEqual(requiredPluginVariables(manifests.get("carpool")), { LANCERLOGIN_REQUIRE_CARPOOL_PLUGIN: "1", LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN: "1" });
});

test("module test manifests reject missing files", () => {
  const root = workspace(manifest, { createTest: false });
  assert.throws(() => discoverModuleManifests(root), /missing or invalid typescript file/i);
});

test("module test manifests reject empty selections", () => {
  const empty = { javascript: [], typescript: [], browser: [], typecheckWorkspaces: [], buildWorkspaces: [] };
  const root = workspace({ ...manifest, fast: empty });
  assert.throws(() => discoverModuleManifests(root), /example fast selection is empty/i);
});

// A test that composes a plugin's fixture belongs in that plugin's manifest, or its module gate misses it (#108). The
// static import closures from the Quick check decide which tests compose it (import it, not just name it);
// browser specs aren't walked.
const pluginFixtures = { "hour-tracking": "tests-ts/fixtures/outreach-plugin.ts", carpool: "tests-ts/fixtures/carpool-plugin.ts", visits: "tests-ts/fixtures/visits-plugin.ts" };
// Tests that compose a plugin fixture but aren't in its manifest yet. Each is a follow-up for whoever owns the
// manifests: add it to the module's fast or acceptance lists and remove it here. An entry already listed is ignored.
const manifestExceptions = {
  "hour-tracking": [],
  carpool: [],
  visits: [],
};
const repositoryFiles = (() => { try { return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean); } catch { return undefined; } })();

test("every test that composes a plugin fixture is in that plugin's module manifest", { skip: !repositoryFiles && "no git checkout" }, () => {
  const { closures } = buildTestClosures((path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } }, () => repositoryFiles);
  const manifests = discoverModuleManifests();
  const missing = [];
  for (const [module, fixture] of Object.entries(pluginFixtures)) {
    const manifest = manifests.get(module);
    assert.ok(manifest, `module-tests/${module}.json exists`);
    for (const file of manifestExceptions[module]) assert.ok(existsSync(file), `${file} in the ${module} exceptions still exists`);
    const listed = new Set([...manifest.fast.javascript, ...manifest.fast.typescript, ...manifest.acceptance.javascript, ...manifest.acceptance.typescript, ...manifestExceptions[module]]);
    const composing = [...closures].filter(([, closure]) => executedFiles(closure).includes(fixture));
    assert.ok(composing.length, `some test composes ${fixture}`);
    for (const [file, closure] of composing) if (!listed.has(file)) missing.push(`${file} (${module}: ${closureChain(closure, fixture).join(" -> ")})`);
  }
  assert.deepEqual(missing, [], "add these tests to the module's fast or acceptance lists");
});

test("fast mode rejects browser and build work", () => {
  const invalid = { ...selection, browser: ["tests-browser/example.spec.ts"] };
  const root = workspace({ ...manifest, fast: invalid });
  assert.throws(() => discoverModuleManifests(root), /fast selection must contain logic tests only/i);
});

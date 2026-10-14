import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverModuleManifests, runModuleTests } from "../scripts/run-module-tests.mjs";

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
  assert.throws(() => runModuleTests({ root, mode: "fast", moduleId: "missing", execute: false }), /Unknown module missing.*example/i);
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

test("fast mode rejects browser and build work", () => {
  const invalid = { ...selection, browser: ["tests-browser/example.spec.ts"] };
  const root = workspace({ ...manifest, fast: invalid });
  assert.throws(() => discoverModuleManifests(root), /fast selection must contain logic tests only/i);
});

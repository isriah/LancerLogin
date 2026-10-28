import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  CompositionError, checkImportSpecifier, composeModules, defaultGeneratedContent, fetchPinnedPlugin, generatedFiles, gitEnvironment, importSpecifiers, inspectPlugin,
  installPluginDependencies, moduleDataContent, moduleDataFile, parseModuleSelection, restoreModuleDefaults, runCommand, satisfiesCoreRange, scanPluginSources, validateModuleSet, validatePluginPackage, verifyPinnedCheckout,
  checkPeerDependencies, coreProvidedPackages, effectiveSelection, enforceSourceAllowlist, ownSetupProgressStep, parseSelectionFile, satisfiesPeerRange,
  compositionEnvironment, inspectionEnvironment, pluginTokenHosts,
} from "../scripts/compose-modules.mjs";
import { attendanceModule, bundledModuleRegistry, createModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { moduleContractVersion, moduleSdkPackageName, supportedModuleContractVersions } from "../packages/shared/src/module-contract.ts";
import { createApiModuleSet } from "../apps/api/src/module-contributions.ts";
import { createModuleDiscordDispatcher } from "../apps/api/src/module-discord.ts";
import { createModuleReportDispatcher } from "../apps/api/src/module-reporting.ts";
import { createTestD1Database } from "./fixtures/d1-database.ts";
import { prepareTestComposition } from "../scripts/test-plugin-sources.mjs";
import { isolatedGitEnv } from "../scripts/git-env.mjs";
import { registerHooks } from "node:module";

// Composed plugin code imported below resolves the module SDK to this Core's copy, as a composed build does.
const coreParent = new URL("../package.json", import.meta.url).href;
registerHooks({ resolve: (specifier, context, nextResolve) => nextResolve(specifier, specifier === "@lancerlogin/module-sdk" || specifier.startsWith("@lancerlogin/module-sdk/") ? { ...context, parentURL: coreParent } : context) });

const fixture = "tests/fixtures/module-plugins/example";
const corePackage = JSON.parse(readFileSync("package.json", "utf8"));
const sha = (content: string) => createHash("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex");
const rejects = (pattern: RegExp) => (error: unknown) => error instanceof CompositionError && pattern.test(error.message);
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: isolatedGitEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function temporary(t: test.TestContext, name: string) {
  const directory = mkdtempSync(join(tmpdir(), `lancerlogin-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A local git repository built from the fixture plugin, optionally changed first. */
function pluginRepository(t: test.TestContext, change?: (directory: string) => void) {
  const directory = join(temporary(t, "plugin-source"), "example");
  cpSync(fixture, directory, { recursive: true });
  change?.(directory);
  git(directory, "init", "--quiet");
  git(directory, "add", "-A");
  git(directory, "commit", "--quiet", "-m", "Synthetic plugin");
  return { directory, source: pathToFileURL(directory).href, commit: git(directory, "rev-parse", "HEAD") };
}

/** A temporary output root standing in for a Core checkout that has the dashboard module contract. */
function outputRoot(t: test.TestContext, dashboardContract = true) {
  const root = temporary(t, "compose-output");
  if (dashboardContract) { mkdirSync(join(root, "apps/dashboard/src"), { recursive: true }); writeFileSync(join(root, "apps/dashboard/src/module-contributions.ts"), "export type DashboardModuleContribution = unknown;\n"); }
  return root;
}

async function compose(t: test.TestContext, modules: unknown[], options: { output?: string; env?: NodeJS.ProcessEnv; installCommand?: unknown } = {}) {
  const output = options.output ?? outputRoot(t);
  const selectionPath = join(temporary(t, "selection"), "lancerlogin.modules.json");
  writeFileSync(selectionPath, JSON.stringify({ format: 1, modules }));
  const log: string[] = [];
  const result = await composeModules({ selectionPath, outputRoot: output, allowFileSources: true, env: options.env ?? { ...process.env, LANCERLOGIN_PLUGIN_TOKEN: undefined }, log: (line: string) => log.push(line), installCommand: options.installCommand });
  return { result, output, log };
}

const generated = (root: string, kind: keyof typeof generatedFiles) => { const path = join(root, generatedFiles[kind].path); return existsSync(path) ? readFileSync(path, "utf8") : undefined; };

test("the Core module contract version and the Core release version come from Core", () => {
  assert.equal(moduleContractVersion, 1);
  assert.deepEqual(supportedModuleContractVersions, [1]);
  assert.equal(moduleSdkPackageName, "@lancerlogin/module-sdk");
  assert.match(corePackage.version, /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
});

test("committed generated defaults match what --restore writes", async (t) => {
  for (const kind of ["manifests", "api", "dashboard"] as const) assert.equal(readFileSync(generatedFiles[kind].path, "utf8").replaceAll("\r\n", "\n"), defaultGeneratedContent(kind));
  assert.equal(readFileSync(moduleDataFile, "utf8").replaceAll("\r\n", "\n"), moduleDataContent());
  assert.equal(defaultGeneratedContent("dashboard"), "// Replaced by module composition for an installation's selected plugins. Core builds without plugins use this empty default.\nimport type { DashboardModuleContribution } from \"../module-contributions.ts\";\n\nexport const externalDashboardModules: readonly DashboardModuleContribution[] = [];\n");
  // Without a dashboard contract or file there is no dashboard default to restore.
  const bare = outputRoot(t, false);
  assert.deepEqual(await restoreModuleDefaults({ outputRoot: bare }), [generatedFiles.manifests.path, generatedFiles.api.path, moduleDataFile]);
  assert.equal(existsSync(join(bare, generatedFiles.dashboard.path)), false);
  assert.deepEqual(await restoreModuleDefaults({ outputRoot: bare }), []);
  // A CRLF checkout keeps its line endings so a restored file compares clean.
  writeFileSync(join(bare, generatedFiles.api.path), "changed\r\n");
  await restoreModuleDefaults({ outputRoot: bare });
  assert.equal(readFileSync(join(bare, generatedFiles.api.path), "utf8"), defaultGeneratedContent("api").replaceAll("\n", "\r\n"));
});

test("selection files accept only exact, pinned https entries", () => {
  const commit = "a".repeat(40);
  const entry = { id: "example", source: "https://github.com/example-owner/lancerlogin-example.git", commit };
  const parse = (value: unknown, allowFileSources = false) => parseModuleSelection(JSON.stringify(value), { allowFileSources });
  assert.deepEqual(parse({ format: 1, modules: [entry] }), [entry]);
  assert.deepEqual(parse({ format: 1, modules: [] }), []);
  assert.deepEqual(parse({ format: 1, modules: [{ ...entry, track: "nightly" }] }), [{ ...entry, track: "nightly" }], "the dashboard's release track is accepted and does not change the pin");
  const cases: [unknown, RegExp][] = [
    [{ format: 2, modules: [] }, /format must be 1/],
    [{ format: 1, modules: [], extra: true }, /unknown keys: extra/],
    [{ format: 1 }, /missing: modules/],
    [{ format: 1, modules: [{ ...entry, branch: "main" }] }, /unknown keys: branch/],
    [{ format: 1, modules: [entry, { ...entry, source: "https://github.com/example-owner/other.git" }] }, /more than once/],
    [{ format: 1, modules: [entry, { ...entry, id: "other" }] }, /for more than one module/],
    [{ format: 1, modules: [{ ...entry, commit: "main" }] }, /full 40-character/],
    [{ format: 1, modules: [{ ...entry, commit: "v1.0.0" }] }, /full 40-character/],
    [{ format: 1, modules: [{ ...entry, commit: "a".repeat(7) }] }, /full 40-character/],
    [{ format: 1, modules: [{ ...entry, commit: "A".repeat(40) }] }, /full 40-character/],
    [{ format: 1, modules: [{ ...entry, source: "http://github.com/o/r.git" }] }, /must use https/],
    [{ format: 1, modules: [{ ...entry, source: "git@github.com:o/r.git" }] }, /https git URL|must use https/],
    [{ format: 1, modules: [{ ...entry, source: "ssh://github.com/o/r.git" }] }, /must use https/],
    [{ format: 1, modules: [{ ...entry, source: "https://user:secret@github.com/o/r.git" }] }, /must not contain credentials/],
    [{ format: 1, modules: [{ ...entry, source: "https://github.com/o/r.git?ref=main" }] }, /must look like/],
    [{ format: 1, modules: [{ ...entry, source: "https://github.com/o/r" }] }, /must look like/],
    [{ format: 1, modules: [{ ...entry, source: "https://github.com:8443/o/r.git" }] }, /must look like/],
    [{ format: 1, modules: [{ ...entry, source: "file:///tmp/plugin" }] }, /must use https/],
    [{ format: 1, modules: [{ ...entry, id: "Example" }] }, /invalid module ID/],
    [{ format: 1, modules: [{ ...entry, track: "weekly" }] }, /track "weekly" is not supported/],
  ];
  for (const [value, pattern] of cases) assert.throws(() => parse(value), rejects(pattern), JSON.stringify(value));
  assert.throws(() => parseModuleSelection("{"), rejects(/not valid JSON/));
  assert.equal(parse({ format: 1, modules: [{ ...entry, source: "file:///tmp/plugin" }] }, true)[0]!.source, "file:///tmp/plugin");
});

test("Core ranges follow package.json comparators with npm's beta rule", () => {
  assert.equal(satisfiesCoreRange("2.0.0-beta.11", ">=2.0.0-beta.0 <3.0.0"), true);
  assert.equal(satisfiesCoreRange("2.0.0", ">=2.0.0-beta.0 <3.0.0"), true);
  assert.equal(satisfiesCoreRange("2.4.1", ">=2.0.0-beta.0 <3.0.0"), true);
  assert.equal(satisfiesCoreRange("3.0.0", ">=2.0.0-beta.0 <3.0.0"), false);
  assert.equal(satisfiesCoreRange("3.0.0-beta.1", ">=2.0.0-beta.0 <3.0.0"), false);
  assert.equal(satisfiesCoreRange("2.1.0-beta.1", ">=2.0.0-beta.0 <3.0.0"), false);
  assert.equal(satisfiesCoreRange("2.0.0-beta.11", ">=2.0.0-beta.12"), false);
  assert.equal(satisfiesCoreRange("2.0.0-beta.11", "=2.0.0-beta.11"), true);
  assert.equal(satisfiesCoreRange("1.2.6", ">=2.0.0 || >=1.2.0 <1.3.0"), true);
  for (const range of ["^2.0.0", "~2.0.0", "2.x", "*", "", ">= 2.0.0", "2.0.0 - 3.0.0", ">=2.0.0-rc.1", "latest"]) assert.throws(() => satisfiesCoreRange("2.0.0", range), rejects(/not supported|non-empty/), range);
});

test("plugin packages declare their module, contract, Core range, prefix and in-plugin entries", (t) => {
  const pluginRoot = temporary(t, "package");
  const pkg = JSON.parse(readFileSync(`${fixture}/package.json`, "utf8"));
  const validate = (change: (value: any) => void = () => {}, moduleId = "example", coreVersion = corePackage.version) => { const value = structuredClone(pkg); change(value); return validatePluginPackage(value, { moduleId, pluginRoot, coreVersion }); };
  const plugin = validate();
  assert.equal(plugin.tablePrefix, "example_");
  assert.equal(plugin.entries.api, join(pluginRoot, "src/api.ts"));
  assert.equal(plugin.migrations, join(pluginRoot, "migrations"));
  assert.ok(validate((value) => { delete value.lancerlogin.entries.dashboard; delete value.lancerlogin.migrations; delete value.lancerlogin.adoptedCoreMigrations; }));
  const cases: [(value: any) => void, RegExp][] = [
    [(value) => { delete value.type; }, /"type": "module"/],
    [(value) => { value.lancerlogin.extra = true; }, /unknown keys: extra/],
    [(value) => { delete value.lancerlogin.core; }, /missing: core/],
    [(value) => { value.lancerlogin.moduleId = "other"; }, /does not match the selected module/],
    [(value) => { value.lancerlogin.contract = 2; }, /needs module contract 2; this Core supports contract 1/],
    [(value) => { value.lancerlogin.contract = "1"; }, /positive integer/],
    [(value) => { value.lancerlogin.core = ">=3.0.0"; }, /supports LancerLogin core >=3\.0\.0; this Core is/],
    [(value) => { value.lancerlogin.core = "^2.0.0"; }, /Module example: Core range/],
    [(value) => { value.lancerlogin.tablePrefix = "platform_"; }, /reserved/],
    [(value) => { value.lancerlogin.tablePrefix = "example"; }, /Invalid module table prefix/],
    [(value) => { value.lancerlogin.entries.api = "../../apps/api/src/index.ts"; }, /relative path/],
    [(value) => { value.lancerlogin.entries.api = "src/api.ts"; }, /relative path/],
    [(value) => { value.lancerlogin.entries.api = "./src/api.json"; }, /must be one of/],
    [(value) => { value.lancerlogin.entries.worker = "./src/worker.ts"; }, /unknown keys: worker/],
    [(value) => { delete value.lancerlogin.entries.api; }, /missing: api/],
    [(value) => { value.lancerlogin.migrations = "./../migrations"; }, /relative path/],
    [(value) => { value.lancerlogin.adoptedCoreMigrations = "0049_carpool_module.sql"; }, /must be an array/],
  ];
  for (const [change, pattern] of cases) assert.throws(() => validate(change), rejects(pattern), String(change));
  assert.throws(() => validate(undefined, "other"), rejects(/does not match the selected module other/));
  assert.throws(() => validate(undefined, "example", "3.0.0"), rejects(/this Core is 3\.0\.0/));
});

test("plugin sources may import only their own files, declared dependencies, Node built-ins and the SDK", async (t) => {
  assert.deepEqual(importSpecifiers(`import a from "./a.ts"; import type { B } from '@lancerlogin/module-sdk';\nimport "./side.ts";\nexport { c } from "./c.ts"; export * from "dep/sub";\nconst d = await import("./d.ts"); // import x from "../../commented.ts"\n/* import y from "../../block.ts" */ const url = "https://example.invalid/x"; const r = require("node:fs");\nimport.meta.url; thing.require(name);`).sort(),
    ["./a.ts", "./c.ts", "./d.ts", "./side.ts", "@lancerlogin/module-sdk", "dep/sub", "node:fs"]);
  assert.throws(() => importSpecifiers("const name = './x.ts'; await import(name);"), /string literal/);
  const pluginRoot = temporary(t, "imports");
  const file = join(pluginRoot, "src/api.ts");
  const check = (specifier: string) => checkImportSpecifier(specifier, { file, pluginRoot, dependencies: new Set(["dep", "@scope/dep"]) });
  for (const specifier of ["./items.ts", "../migrations/x.sql", "dep", "dep/sub/path.js", "@scope/dep/x", "@lancerlogin/module-sdk", "@lancerlogin/module-sdk/dashboard", "node:crypto"]) assert.doesNotThrow(() => check(specifier), specifier);
  const cases: [string, RegExp][] = [
    ["../../apps/api/src/index.ts", /stay inside the plugin/],
    ["../../../../packages/shared/src/module-platform.ts", /stay inside the plugin/],
    ["apps/api/src/index.ts", /Core internals/],
    ["lancerlogin/packages/shared/src/module-platform.ts", /Core internals/],
    ["@lancerlogin/shared", /Core packages are internal/],
    ["@lancerlogin/api/src/index.ts", /Core internals|Core packages/],
    ["undeclared", /not a declared dependency/],
    ["fs", /not a declared dependency/],
    ["/abs/path.ts", /absolute/],
    ["C:/abs/path.ts", /absolute/],
    ["file:///abs/path.ts", /absolute/],
    ["https://example.invalid/x.js", /absolute/],
    ["#internal", /package-internal/],
    // cloudflare:workers exposes the Worker environment and its secrets, which Core withholds from external modules.
    ["cloudflare:workers", /Cloudflare runtime modules are not available to plugins, because cloudflare:workers exposes the Worker environment/],
    ["cloudflare:sockets", /Cloudflare runtime modules are not available to plugins/],
    ["cloudflare:email", /Cloudflare runtime modules are not available to plugins/],
  ];
  for (const [specifier, pattern] of cases) assert.throws(() => check(specifier), rejects(pattern), specifier);
  cpSync(fixture, join(pluginRoot, "plugin"), { recursive: true });
  const pkg = JSON.parse(readFileSync(`${fixture}/package.json`, "utf8"));
  await scanPluginSources(join(pluginRoot, "plugin"), pkg);
  writeFileSync(join(pluginRoot, "plugin/tsconfig.json"), "{ \"compilerOptions\": { \"paths\": { \"core/*\": [\"../../apps/*\"] } } }");
  await assert.rejects(scanPluginSources(join(pluginRoot, "plugin"), pkg), rejects(/must not remap module resolution/));
});

test("development dependencies are importable only from files composition does not bundle", async (t) => {
  const pluginRoot = join(temporary(t, "dev-dependencies"), "plugin");
  cpSync(fixture, pluginRoot, { recursive: true });
  const pkg = { ...JSON.parse(readFileSync(`${fixture}/package.json`, "utf8")), devDependencies: { "dev-tool": "1.0.0", react: "^19.1.1" }, dependencies: { "runtime-dep": "1.0.0" } };
  const entries = ["src/manifest.ts", "src/api.ts", "src/dashboard.tsx"].map((path) => join(pluginRoot, path));
  // The plugin's own tests and scripts may import development dependencies; composed files may import runtime ones.
  mkdirSync(join(pluginRoot, "tests"), { recursive: true }); mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  writeFileSync(join(pluginRoot, "tests/items.test.ts"), "import tool from \"dev-tool\";\nimport { countOpenItems } from \"../src/items.ts\";\n");
  writeFileSync(join(pluginRoot, "scripts/release.mjs"), "import tool from \"dev-tool\";\n");
  writeFileSync(join(pluginRoot, "src/runtime.ts"), "export { default } from \"runtime-dep\";\n");
  writeFileSync(join(pluginRoot, "src/api.ts"), `${readFileSync(join(pluginRoot, "src/api.ts"), "utf8")}\nimport "./runtime.ts";\n`);
  const { composedFiles } = await scanPluginSources(pluginRoot, pkg, entries);
  assert.deepEqual(composedFiles, ["src/api.ts", "src/dashboard.tsx", "src/items.ts", "src/manifest.ts", "src/runtime.ts"]);
  // Without entries every file counts as composed, so a test's development import is refused too.
  await assert.rejects(scanPluginSources(pluginRoot, pkg), rejects(/(tests\/items\.test\.ts|scripts\/release\.mjs) imports "dev-tool": dev-tool is only a devDependency/));

  // A composed file, directly or through relative imports (with or without an extension), must not use one.
  const refused = async (file: string, content: string, pattern: RegExp) => {
    const original = readFileSync(join(pluginRoot, file), "utf8");
    writeFileSync(join(pluginRoot, file), `${original}\n${content}\n`);
    try { await assert.rejects(scanPluginSources(pluginRoot, pkg, entries), rejects(pattern), content); } finally { writeFileSync(join(pluginRoot, file), original); }
  };
  await refused("src/items.ts", "import tool from \"dev-tool\";", /src\/items\.ts imports "dev-tool": dev-tool is only a devDependency, but this file is part of the composed module/);
  await refused("src/dashboard.tsx", "import { useState } from \"react\";", /react is only a devDependency/);
  await refused("src/items.ts", "import \"../scripts/release.mjs\";", /scripts\/release\.mjs imports "dev-tool": dev-tool is only a devDependency/);
  writeFileSync(join(pluginRoot, "src/helper.js"), "export { default } from \"dev-tool/sub\";\n");
  await refused("src/items.ts", "export * from \"./helper\";", /src\/helper\.js imports "dev-tool\/sub": dev-tool is only a devDependency/);
  mkdirSync(join(pluginRoot, "src/lib"), { recursive: true }); writeFileSync(join(pluginRoot, "src/lib/index.ts"), "const tool = await import(\"dev-tool\");\n");
  await refused("src/manifest.ts", "import \"./lib\";", /src\/lib\/index\.ts imports "dev-tool": dev-tool is only a devDependency/);
  // A peer gets the peer range check, so declaring React as a peer is the way to use Core's copy.
  assert.ok(await scanPluginSources(pluginRoot, { ...pkg, peerDependencies: { react: "^19.1.1" } }, entries));

  // Through composition, the refusal happens before anything is installed or written.
  const repository = pluginRepository(t, (directory) => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")), devDependencies: { react: "^17.0.0" } }, null, 2));
    writeFileSync(join(directory, "src/items.ts"), `import { version } from "react";\n${readFileSync(join(directory, "src/items.ts"), "utf8")}`);
  });
  const output = outputRoot(t); let installed = false;
  await assert.rejects(compose(t, [{ id: "example", source: repository.source, commit: repository.commit }], { output, installCommand: async () => { installed = true; return { stdout: "", stderr: "" }; } }), rejects(/src\/items\.ts imports "react": react is only a devDependency/));
  assert.equal(installed, false);
  assert.equal(generated(output, "manifests"), undefined);
});

test("collisions with first-party or other plugins are refused through the Core registry", async (t) => {
  const plugin = join(temporary(t, "inspect"), "example");
  cpSync(fixture, plugin, { recursive: true });
  const inspected = await inspectPlugin({ pluginRoot: plugin, entries: { manifest: join(plugin, "src/manifest.ts"), api: join(plugin, "src/api.ts") }, env: { ...process.env, CLOUDFLARE_API_TOKEN: "synthetic-deployment-secret" } });
  assert.deepEqual(inspected.api.routes, ["/module-setup/example", "/admin/example", "/public/example"]);
  const firstParty = bundledModuleRegistry.modules;
  const external = (change: (manifest: any, api: any) => void = () => {}, moduleId = "example") => { const manifest = structuredClone(inspected.manifest); const api = structuredClone(inspected.api); change(manifest, api); return { plugin: { moduleId }, manifest, api }; };
  const registry = await validateModuleSet(firstParty, [external()]);
  assert.equal(registry.routeOwner("/public/example/requests")?.module.id, "example");
  assert.equal(registry.tableOwner("example_items")?.id, "example");
  // A second plugin must not reuse anything the first one owns.
  const second = (change: (manifest: any, api: any) => void) => external((manifest, api) => {
    Object.assign(manifest, { id: "second", label: "Second", tablePrefix: "second_", capabilities: [{ id: "second.manage", label: "Manage Second", operator: true }], jobs: [], discordCommands: [], reportDatasets: [], interfaces: [], navigation: [{ label: "Second", path: "/second" }], settings: [], apiRoutes: [{ path: "/admin/second", match: "prefix", access: "workspace" }] });
    Object.assign(manifest.persistence, { tables: ["second_items"] }); Object.assign(manifest.backup, { tables: ["second_items"], nonPortableTables: [] }); manifest.lifecycle = { cleanupTargets: ["second_items"] };
    Object.assign(api, { moduleId: "second", routes: ["/admin/second"], jobs: [], reports: [], discord: [], interfaces: {}, cleanup: { steps: [{ kind: "delete", table: "second_items" }] }, backup: { version: 1, tables: { second_items: api.backup.tables.example_items }, hooks: [] } });
    change(manifest, api);
  }, "second");
  assert.ok(await validateModuleSet(firstParty, [external(), second(() => {})]));
  // Composition applies the same external-module rules the Worker applies when it loads.
  await assert.rejects(validateModuleSet(firstParty, [external((manifest, api) => { api.installationSeed = true; })]), rejects(/External module example cannot use Core routes or installation seeds/));
  await assert.rejects(validateModuleSet(firstParty, [external((manifest, api) => { delete api.backup; })]), rejects(/External module example requires a backup adapter/));
  await assert.rejects(validateModuleSet(firstParty, [external((manifest, api) => { api.privateResponseRoutes = ["/admin/undeclared"]; })]), rejects(/private response routes must be declared/));
  const collisions: [(manifest: any, api: any) => void, RegExp][] = [
    [(manifest) => { manifest.discordCommands = [{ name: "example-status", type: 1, description: "Duplicate" }]; }, /Module second conflicts with installed modules: Invalid or duplicate Discord command/],
    [(manifest) => { manifest.discordCommands = [{ name: "example-status", type: 1, description: "Duplicate" }]; }, /Discord command/],
    [(manifest) => { manifest.capabilities = [{ id: "example.manage", label: "Duplicate", operator: true }]; }, /Invalid module capability/],
    [(manifest) => { manifest.jobs = [{ id: "example.digest", interval: 300_000 }]; }, /Invalid module job/],
    [(manifest) => { manifest.reportDatasets = [{ ...structuredClone(inspected.manifest.reportDatasets[0]), capability: "second.manage" }]; }, /report dataset/],
    [(manifest) => { manifest.tablePrefix = "example_"; manifest.persistence.tables = ["example_notes"]; manifest.backup.tables = ["example_notes"]; manifest.lifecycle.cleanupTargets = ["example_notes"]; }, /Overlapping module table prefix/],
    [(manifest) => { manifest.persistence.tables = ["second_items", "example_items"]; manifest.backup.tables = ["second_items", "example_items"]; }, /persistence table|table prefix/],
    [(manifest) => { manifest.tablePrefix = "example_x_"; manifest.persistence.tables = []; manifest.backup.tables = []; }, /Overlapping module table prefix/],
    [(manifest) => { manifest.apiRoutes = [{ path: "/admin/example/items", match: "exact", access: "workspace" }]; }, /route \/admin\/example\/items overlaps module example route \/admin\/example/],
    [(manifest) => { manifest.navigation = [{ label: "Duplicate", path: "/example" }]; }, /dashboard path \/example is already used by module example/],
    [(manifest) => { manifest.navigation = [{ label: "Meetings", path: "/dashboard" }]; }, /already used by module attendance/],
    [(_manifest, api) => { api.routes = []; }, /route handlers do not match declared routes/],
    [(_manifest, api) => { api.jobs = ["second.extra"]; }, /job handlers do not match/],
  ];
  for (const [change, pattern] of collisions) await assert.rejects(validateModuleSet(firstParty, [external(), second(change)]), rejects(pattern), String(change));
  await assert.rejects(validateModuleSet(firstParty, [external(undefined, "attendance")]), rejects(/first-party module/));
  await assert.rejects(validateModuleSet(firstParty, [external(), external()]), rejects(/conflicts with installed modules: Invalid module definition/));
  // The inspection child never receives deployment credentials from the composing process.
  const probe = join(temporary(t, "probe"), "probe");
  cpSync(fixture, probe, { recursive: true });
  writeFileSync(join(probe, "src/manifest.ts"), "export default { environment: Object.keys(process.env) };\n");
  const seen = await inspectPlugin({ pluginRoot: probe, entries: { manifest: join(probe, "src/manifest.ts"), api: join(probe, "src/api.ts") }, env: { ...process.env, CLOUDFLARE_API_TOKEN: "synthetic-deployment-secret", LANCERLOGIN_PLUGIN_TOKEN: "synthetic-plugin-token", WEB_UPDATE_TOKEN: "synthetic", HTTPS_PROXY: "http://user:synthetic@proxy.invalid:8080", ACTIONS_ID_TOKEN_REQUEST_URL: "https://synthetic.invalid" } });
  assert.equal(seen.manifest.environment.some((name: string) => /TOKEN|SECRET|KEY|CLOUDFLARE|PROXY|ACTIONS/i.test(name)), false, seen.manifest.environment.join(","));
});

test("a composed plugin is pinned, checked, generated by relative import and works through the contracts", async (t) => {
  const repository = pluginRepository(t);
  const env = { ...process.env, LANCERLOGIN_PLUGIN_TOKEN: "synthetic-plugin-token-value" };
  const { result, output, log } = await compose(t, [{ id: "example", source: repository.source, commit: repository.commit }], { env });
  assert.equal(result.composed, true);
  const checkout = join(output, ".provision/module-plugins/example");
  assert.equal(git(checkout, "rev-parse", "HEAD"), repository.commit);
  assert.equal(generated(output, "manifests"), [
    "// Generated by scripts/compose-modules.mjs for the plugins in lancerlogin.modules.json. Do not commit; restore with npm run compose:modules -- --restore.",
    "import type { ModuleDefinition } from \"../module-platform.ts\";",
    "import module_example from \"../../../../.provision/module-plugins/example/src/manifest.ts\";",
    "", "export const externalModuleManifests: readonly ModuleDefinition[] = [module_example];", "",
  ].join("\n"));
  assert.match(generated(output, "api")!, /import module_example from "\.\.\/\.\.\/\.\.\/\.\.\/\.provision\/module-plugins\/example\/src\/api\.ts";\n\nexport const externalApiModules: readonly ApiModuleContribution<unknown>\[\] = \[module_example\];/);
  assert.match(generated(output, "dashboard")!, /import module_example from "\.\.\/\.\.\/\.\.\/\.\.\/\.provision\/module-plugins\/example\/src\/dashboard\.tsx";\n\nexport const externalDashboardModules: readonly DashboardModuleContribution\[\] = \[module_example\];/);
  const staged = JSON.parse(readFileSync(join(output, ".provision/module-migrations.json"), "utf8"));
  assert.deepEqual(staged, { format: 1, core: { version: corePackage.version, contract: 1 }, modules: [{
    id: "example", source: repository.source, commit: repository.commit, tablePrefix: "example_", directory: ".provision/module-plugins/example/migrations", root: ".provision/module-plugins/example", adoptedCoreMigrations: [], baseline: null,
    migrations: [{ sequence: 1, name: "0001_create_example_tables.sql", sha256: sha(readFileSync(`${fixture}/migrations/0001_create_example_tables.sql`, "utf8")) }],
  }] });
  for (const text of [...log, ...readdirSync(join(output, ".provision")).filter((name) => name.endsWith(".json")).map((name) => readFileSync(join(output, ".provision", name), "utf8")), ...(["manifests", "api", "dashboard"] as const).map((kind) => generated(output, kind)!)]) assert.doesNotMatch(text, /synthetic-plugin-token-value/);

  // The generated lists import the pinned checkout, and its contributions satisfy Core's binders.
  const { externalModuleManifests } = await import(pathToFileURL(join(output, generatedFiles.manifests.path)).href);
  const { externalApiModules } = await import(pathToFileURL(join(output, generatedFiles.api.path)).href);
  assert.deepEqual(externalModuleManifests.map((module: any) => module.id), ["example"]);
  const registry = createModuleRegistry([attendanceModule, ...externalModuleManifests]);
  const [api] = externalApiModules;
  const stub = async () => undefined; const handlers = (names: string[]) => Object.fromEntries(names.map((name) => [name, stub]));
  const firstParty = [attendanceModule].map((module) => ({ moduleId: module.id, coreRoutes: true as const, setup: { predicates: handlers(module.setup.steps.map((step) => step.id)), stepValid: async () => true }, jobs: handlers(module.jobs.map((job) => job.id)), reports: handlers((module.reportDatasets ?? []).map((dataset) => dataset.id)), discord: handlers(module.discordCommands.map((command) => command.name)), cleanup: { steps: [{ kind: "assignments" as const }] } }));
  assert.equal(createApiModuleSet(registry, [...firstParty, api], { externalModuleIds: new Set(["example"]) }).require("example"), api);
  const exampleOnly = createModuleRegistry(externalModuleManifests);
  assert.equal(typeof createModuleDiscordDispatcher(exampleOnly, [{ moduleId: "example", handlers: api.discord }]), "function");
  const reports = createModuleReportDispatcher(exampleOnly, [{ moduleId: "example", handlers: api.reports }]);

  // Plugin migrations apply through the module migration runner, then each contribution runs against them.
  const db = await createTestD1Database({ modules: [{ moduleId: "example", tablePrefix: "example_", directory: join(checkout, "migrations") }] });
  db.sqlite.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-26','local'); INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-10-26');");
  assert.deepEqual(db.sqlite.prepare("SELECT module_id, sequence, name FROM platform_module_migrations").all().map((row) => ({ ...row })), [{ module_id: "example", sequence: 1, name: "0001_create_example_tables.sql" }]);
  const roles: string[][] = []; let originChecks = 0;
  const context = (path: string, method = "GET", body?: unknown) => {
    const request = new Request(`https://synthetic.test${path}`, { method });
    return { request, url: new URL(request.url), env: {}, db, services: {}, async requireRole(allowed: string[]) { roles.push(allowed); return { userId: "admin", role: "admin" }; }, async json() { return body; }, async body() { return body; }, respond: (value: unknown, status = 200) => Response.json(value, { status }), requireDashboardOrigin() { originChecks++; } };
  };
  const route = (path: string) => api.routes[registry.routeOwner(path)!.route.path];
  assert.equal((await route("/module-setup/example")(context("/module-setup/example")))!.status, 200);
  assert.equal((await route("/admin/example/items")(context("/admin/example/items", "POST", { id: "kit", title: "Robot kit" })))!.status, 201);
  assert.equal(originChecks, 1);
  assert.equal(registry.routeOwner("/public/example/requests")?.route.access, "service");
  assert.equal((await route("/public/example/requests")(context("/public/example/requests", "POST", { id: "request-1", itemId: "kit", note: "Synthetic" })))!.status, 202);
  assert.equal((await route("/public/example/requests")(context("/public/example/requests", "POST", { id: "request-2", itemId: "missing" })))!.status, 404);
  assert.equal(await route("/admin/example/other")(context("/admin/example/other")), undefined);
  assert.deepEqual(await (await route("/admin/example/items")(context("/admin/example/items")))!.json(), { items: [{ id: "kit", title: "Robot kit", requests: 1 }] });
  assert.deepEqual(roles, [["admin"], ["admin", "operator"], ["admin", "operator"]]);
  const predicate = api.setup.predicates.catalog("primary");
  assert.deepEqual({ ...db.sqlite.prepare(`SELECT ${predicate.sql} AS ready`).get(...predicate.bindings) as object }, { ready: 1 });
  assert.equal(await api.setup.stepValid(db, "catalog"), true);
  assert.deepEqual(await api.jobs["example.digest"]({ env: {}, db, services: {} }), { open: 1 });
  assert.equal((db.sqlite.prepare("SELECT digest_count FROM example_items").get() as { digest_count: number }).digest_count, 1);
  assert.equal(await api.discord["example-status"](db, { data: { name: "example-status", options: [{ name: "title", value: "Robot kit" }] } }, Date.now()), "1 open Example item titled Robot kit");
  const rows = await reports.run("example.items", db, {} as never, { to: "2026-10-26", today: "2026-10-26" });
  assert.deepEqual(rows.map((row: any) => [row.id, row.cells["example.item.requests"].sortValue]), [["kit", 1]]);

  // --restore returns every generated file to its committed default and drops the staged manifest.
  const restore = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/compose-modules.mjs", "--restore", "--output-root", output], { encoding: "utf8" });
  assert.equal(restore.status, 0, restore.stderr);
  for (const kind of ["manifests", "api", "dashboard"] as const) assert.equal(generated(output, kind), defaultGeneratedContent(kind));
  assert.equal(existsSync(join(output, ".provision/module-migrations.json")), false);
});

test("the private repository's source allowlist limits selected plugin sources with the Worker's rules", async (t) => {
  const commit = "a".repeat(40);
  const trusted = { id: "trusted", source: "https://github.com/Trusted-Org/trusted.git", commit };
  const anyOwner = { id: "elsewhere", source: "https://git.example.org/anyone/elsewhere.git", commit };
  const otherOwner = { id: "stranger", source: "https://github.com/stranger/plugin.git", commit };
  const otherHost = { id: "foreign", source: "https://gitlab.com/trusted-org/foreign.git", commit };
  const allowlist = JSON.stringify({ format: 1, allowedSources: ["github.com/trusted-org", "git.example.org"] });
  // Host match, optional owner match ignoring case: the same decisions the Worker makes for dashboard changes.
  assert.doesNotThrow(() => enforceSourceAllowlist({ modules: [trusted, anyOwner] }, allowlist));
  assert.throws(() => enforceSourceAllowlist({ modules: [trusted, otherOwner] }, allowlist), rejects(/Module stranger source https:\/\/github\.com\/stranger\/plugin\.git is not allowed by lancerlogin\.plugin-sources\.json, which permits github\.com\/trusted-org, git\.example\.org/));
  assert.throws(() => enforceSourceAllowlist({ modules: [otherHost] }, allowlist), rejects(/Module foreign source .* is not allowed/));
  assert.doesNotThrow(() => enforceSourceAllowlist({ modules: [otherOwner, otherHost] }, undefined), "without the file any source is allowed");
  for (const invalid of ["not json", "[]", JSON.stringify({ format: 2, allowedSources: [] }), JSON.stringify({ format: 1, allowedSources: ["GitHub.com/x"] }), JSON.stringify({ format: 1, allowedSources: ["https://github.com/x"] }), JSON.stringify({ format: 1, allowedSources: [], extra: true })]) {
    assert.throws(() => enforceSourceAllowlist({ modules: [] }, invalid), rejects(/lancerlogin\.plugin-sources\.json .*so no plugin source is allowed\. Repair lancerlogin\.plugin-sources\.json in the private deployment repository/), invalid);
  }
  assert.throws(() => enforceSourceAllowlist(undefined, "{"), rejects(/not valid JSON/), "an invalid file fails closed even without a selection");

  // Through composition, the allowlist beside the selection file is checked before any plugin is fetched or any file written.
  const env = { ...process.env, LANCERLOGIN_PLUGIN_TOKEN: undefined };
  const official = join(temporary(t, "allowlist-official"), "official-modules.json");
  const officialPin = { id: "official", source: "https://github.com/lancerlogin-core/official.git", commit: "b".repeat(40) };
  writeFileSync(official, JSON.stringify({ format: 1, status: "active", modules: [officialPin] }));
  const run = async (modules: unknown[], allowlistText: string | undefined, extra: Record<string, unknown> = {}) => {
    const directory = temporary(t, "allowlist-selection");
    const selectionPath = join(directory, "lancerlogin.modules.json");
    writeFileSync(selectionPath, JSON.stringify({ format: 1, modules, ...extra }));
    if (allowlistText !== undefined) writeFileSync(join(directory, "lancerlogin.plugin-sources.json"), allowlistText);
    const output = outputRoot(t); const fetched: string[] = [];
    // Fetching is where an allowed plugin would go next; stop there without the network.
    const runCommand = async (_command: string, args: string[]) => { const source = args.find((arg) => arg.startsWith("https://")); if (source) fetched.push(source); if (args.includes("fetch")) throw new CompositionError("fetch reached"); return { stdout: "", stderr: "" }; };
    const attempt = composeModules({ selectionPath, outputRoot: output, workDirectory: join(temporary(t, "allowlist-work"), "plugins"), officialModules: true, officialModulesPath: official, env, log: () => {}, runCommand });
    return { attempt, output, fetched };
  };
  const allowed = await run([trusted], allowlist);
  await assert.rejects(allowed.attempt, rejects(/^fetch reached$/));
  assert.deepEqual(allowed.fetched, [officialPin.source], "an allowed selection proceeds to fetching; Core's official pin is not checked against the allowlist");
  const forbiddenOwner = await run([trusted, otherOwner], allowlist);
  await assert.rejects(forbiddenOwner.attempt, rejects(/Module stranger source .* is not allowed by lancerlogin\.plugin-sources\.json/));
  assert.deepEqual(forbiddenOwner.fetched, []);
  assert.equal(generated(forbiddenOwner.output, "manifests"), undefined, "nothing is written when a source is refused");
  const forbiddenHost = await run([otherHost], allowlist);
  await assert.rejects(forbiddenHost.attempt, rejects(/Module foreign source .* is not allowed/));
  assert.deepEqual(forbiddenHost.fetched, []);
  // A selection entry that pins an official module names its own source, so the allowlist applies to it, as in the Worker.
  const officialOverride = await run([{ ...officialPin, commit: "c".repeat(40) }], allowlist);
  await assert.rejects(officialOverride.attempt, rejects(/Module official source .* is not allowed/));
  const invalid = await run([trusted], "{ \"format\": 1 }");
  await assert.rejects(invalid.attempt, rejects(/must contain format 1 and an allowedSources array, so no plugin source is allowed/));
  assert.deepEqual(invalid.fetched, []);
  const optedOutInvalid = await run([], "not json", { officialModules: false });
  await assert.rejects(optedOutInvalid.attempt, rejects(/not valid JSON/), "an invalid file refuses composition even when nothing is selected");
  const unrestricted = await run([otherOwner, otherHost], undefined);
  await assert.rejects(unrestricted.attempt, rejects(/^fetch reached$/));
  assert.deepEqual(unrestricted.fetched, [officialPin.source], "without the file any source proceeds to fetching");
});

test("without a selection file or official modules composition changes nothing", (t) => {
  const output = outputRoot(t);
  const before = readdirSync(output, { recursive: true }).sort();
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/compose-modules.mjs", "--no-official-modules", "--selection", join(output, "missing.json"), "--output-root", output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /No lancerlogin\.modules\.json found; composing first-party modules only/);
  assert.deepEqual(readdirSync(output, { recursive: true }).sort(), before);
  const unknown = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/compose-modules.mjs", "--branch", "main"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Module composition failed: Unknown argument --branch/);
});

test("pins, imports, migrations and compatibility failures stop composition before any generated file is written", async (t) => {
  const repository = pluginRepository(t);
  const attempt = async (modules: unknown[], change?: (directory: string) => void) => {
    const output = outputRoot(t);
    const source = change ? pluginRepository(t, change) : repository;
    const selected = modules.map((entry: any) => ({ id: "example", source: source.source, commit: source.commit, ...entry }));
    try { await compose(t, selected, { output }); } finally {
      for (const kind of ["manifests", "api", "dashboard"] as const) assert.equal(generated(output, kind), undefined, `${kind} was written`);
      assert.equal(existsSync(join(output, ".provision/module-migrations.json")), false);
    }
  };
  const edit = (path: string, from: string | RegExp, to: string) => (directory: string) => { const file = join(directory, path); writeFileSync(file, readFileSync(file, "utf8").replace(from, to)); };
  await assert.rejects(attempt([{ commit: "0".repeat(40) }]), rejects(/git fetch failed/));
  await assert.rejects(attempt([{ commit: "main" }]), rejects(/full 40-character/));
  await assert.rejects(attempt([{ source: "https://github.com/example-owner/example" }]), rejects(/must look like/));
  await assert.rejects(attempt([{}], edit("src/items.ts", "// Example-owned", "import { bundledModuleRegistry } from \"../../../../packages/shared/src/module-platform.ts\";\n// Example-owned")), rejects(/src\/items\.ts imports .*stay inside the plugin/));
  await assert.rejects(attempt([{}], edit("src/api.ts", "import { countOpenItems", "import { HttpError } from \"@lancerlogin/api/src/http-error.ts\";\nimport { countOpenItems")), rejects(/Core packages are internal|Core internals/));
  await assert.rejects(attempt([{}], (directory) => {
    const sql = "ALTER TABLE members ADD COLUMN example_flag INTEGER;\n";
    writeFileSync(join(directory, "migrations/0002_core_column.sql"), sql);
    writeFileSync(join(directory, "migrations/reviewed.json"), JSON.stringify([...JSON.parse(readFileSync(join(directory, "migrations/reviewed.json"), "utf8")), { name: "0002_core_column.sql", sha256: sha(sql) }]));
  }), rejects(/0002_core_column\.sql: table members is outside the module table prefix example_/));
  await assert.rejects(attempt([{}], edit("migrations/0001_create_example_tables.sql", "closed INTEGER", "closed  INTEGER")), rejects(/does not match its reviewed hash/));
  await assert.rejects(attempt([{}], edit("src/manifest.ts", "tables: [\"example_items\", \"example_requests\"]", "tables: [\"example_items\", \"example_requests\", \"example_missing\"]")), rejects(/backup ownership|declares tables/));
  await assert.rejects(attempt([{}], edit("package.json", "\"contract\": 1", "\"contract\": 2")), rejects(/needs module contract 2/));
  await assert.rejects(attempt([{}], edit("package.json", ">=2.0.0-beta.0 <3.0.0", ">=3.0.0 <4.0.0")), rejects(/supports LancerLogin core >=3\.0\.0 <4\.0\.0; this Core is/));
  await assert.rejects(attempt([{}], edit("src/manifest.ts", "persistence: { tables: [\"example_items\", \"example_requests\"], sharedFields: []", "persistence: { tables: [\"example_items\", \"example_requests\"], sharedFields: [{ table: \"members\", columns: [\"example_flag\"] }]")), rejects(/declares sharedFields/));
  await assert.rejects(attempt([{}], edit("src/manifest.ts", "{ path: \"/public/example\", match: \"prefix\", access: \"service\" }", "{ path: \"/admin/members\", match: \"prefix\", access: \"workspace\" }")), rejects(/must use the module's own name/));
  await assert.rejects(attempt([{}], edit("src/api.ts", "cleanup: { steps: [{ kind: \"delete\", table: \"example_requests\" }", "cleanup: { steps: [{ kind: \"delete\", table: \"members\" }")), rejects(/cleanup step targets "members"/));
  await assert.rejects(attempt([{}], edit("src/api.ts", "\"example-status\": async", "\"example-other\": async")), rejects(/Discord handlers do not match/));
  await assert.rejects(attempt([{ id: "attendance" }]), rejects(/first-party module/));
  // A plugin with a dashboard entry needs a Core that has the dashboard module contract.
  const bare = outputRoot(t, false);
  await assert.rejects(compose(t, [{ id: "example", source: repository.source, commit: repository.commit }], { output: bare }), rejects(/no dashboard module contract/));
  assert.equal(generated(bare, "manifests"), undefined);
});

test("a checkout must be exactly the pinned commit without links or submodules", async (t) => {
  const repository = pluginRepository(t);
  const other = pluginRepository(t, (directory) => writeFileSync(join(directory, "README.md"), "Other synthetic commit\n"));
  const directory = join(temporary(t, "checkout"), "example");
  await fetchPinnedPlugin({ source: repository.source, commit: repository.commit, directory, env: process.env, allowFileSources: true });
  await assert.rejects(verifyPinnedCheckout({ directory, commit: other.commit, env: process.env }), rejects(/not the pinned commit/));
  writeFileSync(join(directory, "package.json"), "{}");
  await assert.rejects(verifyPinnedCheckout({ directory, commit: repository.commit, env: process.env }), rejects(/differs from the commit/));
  await assert.rejects(fetchPinnedPlugin({ source: repository.source, commit: repository.commit, directory: join(temporary(t, "blocked"), "example"), env: process.env, allowFileSources: false }), rejects(/transport 'file' not allowed/));
  const linked = pluginRepository(t, () => {});
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: linked.directory, input: "../../apps", encoding: "utf8", env: isolatedGitEnv() }).stdout.trim();
  git(linked.directory, "update-index", "--add", "--cacheinfo", `120000,${blob},src/core`);
  git(linked.directory, "commit", "--quiet", "-m", "Link outside the plugin");
  const linkedCommit = git(linked.directory, "rev-parse", "HEAD");
  await assert.rejects(fetchPinnedPlugin({ source: linked.source, commit: linkedCommit, directory: join(temporary(t, "linked"), "example"), env: process.env, allowFileSources: true }), rejects(/symbolic links or submodules/));
});

test("composition passes no credentials to child processes, and inspection gets no proxy settings", () => {
  const environment = {
    PATH: "/bin", HOME: "/home/runner", TEMP: "/tmp", npm_execpath: "/npm-cli.js", HTTPS_PROXY: "http://user:synthetic@proxy.invalid:8080",
    LANCERLOGIN_PLUGIN_TOKEN: "plugin", CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "account", WEB_UPDATE_TOKEN: "update", GITHUB_TOKEN: "gh",
    SESSION_KEY: "key", FINGERPRINT_VAULT_KEY: "vault", MODULE_SELECTION_TOKEN: "selection", ACTIONS_RUNTIME_TOKEN: "runtime", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid",
    RUNNER_TRACKING_ID: "runner", NPM_CONFIG__AUTH: "npm", NODE_AUTH_TOKEN: "node", DEPLOY_PASSWORD: "password", SSH_PRIVATE_KEY_PATH: "/key", SIGNING_KEY_ID: "id", SETUP_CODE: "code", AWS_SECRET_ACCESS_KEY: "aws", CREDENTIALS_JSON: "{}",
  };
  assert.deepEqual(compositionEnvironment(environment), { PATH: "/bin", HOME: "/home/runner", TEMP: "/tmp", npm_execpath: "/npm-cli.js", HTTPS_PROXY: "http://user:synthetic@proxy.invalid:8080", LANCERLOGIN_PLUGIN_TOKEN: "plugin" });
  assert.deepEqual(inspectionEnvironment(environment), { PATH: "/bin", HOME: "/home/runner", TEMP: "/tmp" });
});

test("the plugin token goes only to github.com and hosts the installation lists in its source allowlist", async (t) => {
  const env = { PATH: process.env.PATH, LANCERLOGIN_PLUGIN_TOKEN: "ghp_syntheticTokenValue" };
  const header = (source: string, options?: { tokenHosts?: Set<string> }) => gitEnvironment(env, source, options).GIT_CONFIG_KEY_0;
  assert.equal(header("https://github.com/example-owner/private-plugin.git"), "http.https://github.com/.extraHeader");
  for (const source of ["https://collector.example/x/y.git", "https://gitlab.com/owner/plugin.git", "https://api.github.com/owner/plugin.git", "https://github.com.collector.example/owner/plugin.git"]) {
    const gitEnv = gitEnvironment(env, source);
    assert.equal(gitEnv.GIT_CONFIG_COUNT, undefined, source);
    assert.doesNotMatch(JSON.stringify(gitEnv), /ghp_syntheticTokenValue|eC1hY2Nlc3MtdG9rZW46/, source);
  }
  assert.equal(header("https://git.example.org/owner/plugin.git", { tokenHosts: new Set(["git.example.org"]) }), "http.https://git.example.org/.extraHeader");
  assert.deepEqual([...pluginTokenHosts(undefined)], ["github.com"]);
  assert.deepEqual([...pluginTokenHosts(JSON.stringify({ format: 1, allowedSources: ["github.com/trusted-org", "git.example.org/team", "code.example.net"] }))].sort(), ["code.example.net", "git.example.org", "github.com"]);
  assert.deepEqual([...pluginTokenHosts("not json")], ["github.com"], "an invalid allowlist adds no host (and refuses composition anyway)");

  // Through composition: a selection naming another host is fetched without the token unless the allowlist lists that host.
  const commit = "a".repeat(40);
  const attempt = async (source: string, allowlistText?: string) => {
    const directory = temporary(t, "token-selection");
    const selectionPath = join(directory, "lancerlogin.modules.json");
    writeFileSync(selectionPath, JSON.stringify({ format: 1, modules: [{ id: "remote", source, commit }] }));
    if (allowlistText !== undefined) writeFileSync(join(directory, "lancerlogin.plugin-sources.json"), allowlistText);
    let fetchEnv: Record<string, string> | undefined;
    const runCommand = async (_command: string, args: string[], options: { env: Record<string, string> }) => { if (args.includes("fetch")) { fetchEnv = options.env; throw new CompositionError("fetch reached"); } return { stdout: "", stderr: "" }; };
    await assert.rejects(composeModules({ selectionPath, outputRoot: outputRoot(t), workDirectory: join(temporary(t, "token-work"), "plugins"), officialModules: false, env, log: () => {}, runCommand }), rejects(/^fetch reached$/));
    return fetchEnv!;
  };
  assert.equal((await attempt("https://collector.example/x/y.git")).GIT_CONFIG_COUNT, undefined, "without an allowlist only github.com receives the token");
  assert.equal((await attempt("https://github.com/owner/private-plugin.git")).GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  const listed = await attempt("https://git.example.org/team/plugin.git", JSON.stringify({ format: 1, allowedSources: ["git.example.org/team"] }));
  assert.equal(listed.GIT_CONFIG_KEY_0, "http.https://git.example.org/.extraHeader");
  assert.equal(listed.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:ghp_syntheticTokenValue").toString("base64")}`);
  assert.equal((await attempt("https://github.com/trusted-org/plugin.git", JSON.stringify({ format: 1, allowedSources: ["github.com/trusted-org"] }))).GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
});

test("private plugin tokens travel only as a transient host-scoped header and installs never run scripts", async (t) => {
  const env = { PATH: process.env.PATH, LANCERLOGIN_PLUGIN_TOKEN: "ghp_syntheticTokenValue", CLOUDFLARE_API_TOKEN: "cfat_synthetic", SESSION_KEY: "synthetic" };
  const gitEnv = gitEnvironment(env, "https://github.com/example-owner/private-plugin.git");
  assert.deepEqual([gitEnv.GIT_CONFIG_COUNT, gitEnv.GIT_CONFIG_KEY_0, gitEnv.GIT_TERMINAL_PROMPT], ["1", "http.https://github.com/.extraHeader", "0"]);
  assert.equal(gitEnv.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:ghp_syntheticTokenValue").toString("base64")}`);
  for (const name of ["LANCERLOGIN_PLUGIN_TOKEN", "CLOUDFLARE_API_TOKEN", "SESSION_KEY"]) assert.equal(name in gitEnv, false, name);
  assert.equal("GIT_CONFIG_COUNT" in gitEnvironment(env, "file:///tmp/plugin"), false);
  assert.throws(() => gitEnvironment({ LANCERLOGIN_PLUGIN_TOKEN: "bad\ntoken" }, "https://github.com/o/r.git"), rejects(/unsupported characters/));
  const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
  const run = async (command: string, args: string[], options: { env: Record<string, string> }) => { calls.push({ command, args, env: options.env }); return { stdout: args.includes("rev-parse") ? "c".repeat(40) : "", stderr: "" }; };
  await fetchPinnedPlugin({ source: "https://github.com/example-owner/private-plugin.git", commit: "c".repeat(40), directory: join(temporary(t, "token"), "example"), env, allowFileSources: false, run });
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.args), /ghp_syntheticTokenValue|eC1hY2Nlc3MtdG9rZW46/);
  const fetch = calls.find((call) => call.args.includes("fetch"))!;
  assert.deepEqual(fetch.args.slice(2, 6), ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]);
  assert.ok(fetch.args.includes("--depth=1") && fetch.args.includes("--no-recurse-submodules") && !fetch.args.includes("protocol.file.allow=always"));
  assert.equal(fetch.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  // A failure message never repeats the token, even when a child prints it.
  await assert.rejects(runCommand(process.execPath, ["-e", "console.error('remote said ' + process.argv[1]); process.exit(1)", "ghp_syntheticTokenValue"], { cwd: process.cwd(), env: { PATH: process.env.PATH }, redactFrom: env }), (error: unknown) => error instanceof CompositionError && /remote said \[redacted\]/.test(error.message) && !error.message.includes("ghp_syntheticTokenValue"));

  const pluginRoot = temporary(t, "install");
  const installs: { args: string[]; env: Record<string, string> }[] = [];
  const install = async (_command: string, args: string[], options: { env: Record<string, string> }) => { installs.push({ args, env: options.env }); return { stdout: "", stderr: "" }; };
  assert.equal(await installPluginDependencies({ pluginRoot, pkg: { lancerlogin: { moduleId: "example" } }, env, run: install }), false);
  await assert.rejects(installPluginDependencies({ pluginRoot, pkg: { lancerlogin: { moduleId: "example" }, dependencies: { dep: "1.0.0" } }, env, run: install }), rejects(/no package-lock\.json/));
  writeFileSync(join(pluginRoot, "package-lock.json"), "{}");
  assert.equal(await installPluginDependencies({ pluginRoot, pkg: { lancerlogin: { moduleId: "example" }, dependencies: { dep: "1.0.0" } }, env, run: install }), true);
  assert.deepEqual(installs[0]!.args.slice(-6), ["ci", "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund"]);
  // Peer and development dependencies are never installed per plugin: peers resolve to Core's single copy.
  assert.equal(await installPluginDependencies({ pluginRoot: temporary(t, "peers"), pkg: { lancerlogin: { moduleId: "example" }, peerDependencies: { react: "^19.1.1" }, devDependencies: { tool: "1.0.0" } }, env, run: install }), false);
  assert.equal(installs.length, 1);
  assert.equal(installs[0]!.env.npm_config_ignore_scripts, "true");
  for (const name of ["LANCERLOGIN_PLUGIN_TOKEN", "CLOUDFLARE_API_TOKEN", "SESSION_KEY"]) assert.equal(name in installs[0]!.env, false, name);
});

test("import scanning ignores keywords inside quoted strings but still finds every real import", () => {
  const source = [
    'import { a } from "./a.ts";',
    'if (parts[4] === "import" && method === "POST") route();',
    'const view = <section className="carpool-import" aria-labelledby="title" />;',
    "const note = 'please import \"x\" later';",
    'const lazy = await import("./lazy.ts");',
    'const template = `${await import("./template.ts")}`;',
    'export * from "./reexport.ts";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(source).sort(), ["./a.ts", "./lazy.ts", "./reexport.ts", "./template.ts"]);
  assert.throws(() => importSpecifiers('const name = "x"; import(name);'), rejects(/string literal/));
});

test("a plugin may clean only its own setup progress among Core tables", () => {
  assert.equal(ownSetupProgressStep({ kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["example"] }, "example"), true);
  for (const step of [
    { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["other"] },
    { kind: "delete", table: "platform_module_setup_progress", where: "1=1", bindings: ["example"] },
    { kind: "delete", table: "platform_module_setup_progress" },
    { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["example"], extra: true },
    { kind: "reset", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["example"] },
    { kind: "delete", table: "platform_module_assignments", where: "module_id=?", bindings: ["example"] },
  ]) assert.equal(ownSetupProgressStep(step, "example"), false, JSON.stringify(step));
});

test("peer dependencies must be packages Core provides, at versions within the declared range", async () => {
  for (const [version, range, expected] of [["19.1.1", "^19.1.1", true], ["19.4.0", "^19.1.1", true], ["20.0.0", "^19.1.1", false], ["19.0.9", "^19.1.1", false], ["1.9.4", "~1.9.0", true], ["1.10.0", "~1.9.0", false], ["0.3.2", "^0.3.1", true], ["0.4.0", "^0.3.1", false], ["1.0.0", ">=1.0.0 <2.0.0", true], ["2.0.0", ">=1.0.0 <2.0.0 || 3.0.0", false], ["3.0.0", ">=1.0.0 <2.0.0 || 3.0.0", true], ["1.2.3-beta.1", "^1.2.0", true]] as const) assert.equal(satisfiesPeerRange(version, range), expected, `${version} ${range}`);
  assert.throws(() => satisfiesPeerRange("1.0.0", "latest"), rejects(/not supported/));
  const provided = await coreProvidedPackages();
  assert.equal(provided.get(moduleSdkPackageName), JSON.parse(readFileSync("packages/module-sdk/package.json", "utf8")).version);
  assert.match(provided.get("react") ?? "", /^19\./); assert.match(provided.get("leaflet") ?? "", /^1\./);
  assert.doesNotThrow(() => checkPeerDependencies({ peerDependencies: { [moduleSdkPackageName]: "^1.0.0", react: "^19.1.1", leaflet: "^1.9.4" } }, "example", provided));
  assert.throws(() => checkPeerDependencies({ peerDependencies: { "left-pad": "^1.0.0" } }, "example", provided), rejects(/peer dependency left-pad is not provided by this Core/));
  assert.throws(() => checkPeerDependencies({ peerDependencies: { react: "^18.0.0" } }, "example", provided), rejects(/needs react \^18\.0\.0; this Core provides react 19\./));
});

test("the official default selection composes Core's pinned plugins unless an installation opts out", async (t) => {
  const repository = pluginRepository(t);
  const pinned = { id: "example", source: repository.source, commit: repository.commit };
  const shipped = parseSelectionFile(readFileSync("scripts/official-modules.json", "utf8"), { name: "official-modules.json", official: true });
  // Outreach is the first official module, pinned to an exact commit of its https repository.
  assert.equal(shipped.status, "active"); assert.equal(shipped.officialModules, undefined);
  assert.deepEqual(shipped.modules.map((module: { id: string }) => module.id), ["hour-tracking"]);
  assert.match(shipped.modules[0]!.commit, /^[0-9a-f]{40}$/);
  assert.equal(shipped.modules[0]!.source, "https://github.com/isriah/lancerlogin-outreach.git");
  assert.throws(() => parseSelectionFile(JSON.stringify({ format: 1, modules: [], officialModules: "no" })), rejects(/officialModules must be true or false/));
  assert.throws(() => parseSelectionFile(JSON.stringify({ format: 1, modules: [], status: "proposed" })), rejects(/unknown keys: status/));
  assert.throws(() => parseSelectionFile(JSON.stringify({ format: 1, modules: [], officialModules: false }), { name: "official-modules.json", official: true }), rejects(/unknown keys: officialModules/));
  const official = { modules: [pinned] };
  const other = { id: "other", source: "https://github.com/example-owner/other.git", commit: "b".repeat(40) };
  const lines: string[] = []; const log = (line: string) => lines.push(line);
  assert.deepEqual(effectiveSelection({ selection: { modules: [other], officialModules: false }, official: undefined, log }), [other]);
  assert.match(lines.at(-1)!, /excludes official modules; it was ignored/);
  assert.deepEqual(effectiveSelection({ selection: undefined, official, log }), [pinned]);
  assert.deepEqual(effectiveSelection({ selection: { modules: [other] }, official, log }), [pinned, other]);
  assert.deepEqual(effectiveSelection({ selection: { modules: [other], officialModules: false }, official, log }), [other]);
  const held = { ...pinned, commit: "c".repeat(40) };
  assert.deepEqual(effectiveSelection({ selection: { modules: [held] }, official, log }), [held], "an installation pin replaces Core's pin for the same module");
  assert.throws(() => effectiveSelection({ selection: { modules: [{ ...other, source: pinned.source }] }, official, log }), rejects(/also an official module source/));

  // Through composition: a caller that leaves official modules out changes nothing without a selection; with them, an
  // official plugin composes even without a selection file.
  const list = join(temporary(t, "official"), "official-modules.json");
  writeFileSync(list, JSON.stringify({ format: 1, status: "active", modules: [pinned] }));
  const missingSelection = join(temporary(t, "none"), "lancerlogin.modules.json");
  const env = { ...process.env, LANCERLOGIN_PLUGIN_TOKEN: undefined };
  const off = await composeModules({ selectionPath: missingSelection, outputRoot: outputRoot(t), workDirectory: join(temporary(t, "work-off"), "plugins"), allowFileSources: true, env, log: () => {} });
  assert.equal(off.composed, false);
  const on = await composeModules({ selectionPath: missingSelection, outputRoot: outputRoot(t), workDirectory: join(temporary(t, "work-on"), "plugins"), allowFileSources: true, officialModules: true, officialModulesPath: list, env, log: () => {} });
  assert.deepEqual(on.modules, ["example"]);
  const optOut = join(temporary(t, "opt-out"), "lancerlogin.modules.json");
  writeFileSync(optOut, JSON.stringify({ format: 1, modules: [], officialModules: false }));
  const declined = await composeModules({ selectionPath: optOut, outputRoot: outputRoot(t), workDirectory: join(temporary(t, "work-declined"), "plugins"), allowFileSources: true, officialModules: true, officialModulesPath: list, env, log: () => {} });
  assert.deepEqual(declined.modules, []);
  const noSelection = await composeModules({ selectionPath: null, outputRoot: outputRoot(t), workDirectory: join(temporary(t, "work-null"), "plugins"), allowFileSources: true, officialModules: true, officialModulesPath: list, env, log: () => {} });
  assert.deepEqual(noSelection.modules, ["example"], "updates without a selection file compose the official modules alone");
  // Core's shipped list composes Outreach from its private repository when it is reachable (LANCERLOGIN_PLUGIN_TOKEN or a
  // local checkout of the pinned commit); otherwise this check reports why it was skipped. The command line includes
  // official modules unless told not to.
  const shippedComposition = prepareTestComposition({ scratch: temporary(t, "shipped-list") });
  if ("reason" in shippedComposition) {
    if (process.env.LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN === "1") throw new Error(shippedComposition.reason as string);
    t.diagnostic(`Skipped composing Core's shipped official list: ${shippedComposition.reason}`);
  } else {
    const officialList = (shippedComposition.args as string[])[(shippedComposition.args as string[]).indexOf("--official-list") + 1]!;
    const shippedOfficial = await composeModules({ selectionPath: missingSelection, outputRoot: outputRoot(t), workDirectory: join(temporary(t, "work-shipped"), "plugins"), allowFileSources: true, officialModules: true, officialModulesPath: officialList, env: shippedComposition.env, log: () => {} });
    assert.deepEqual(shippedOfficial.modules, ["hour-tracking"]);
  }
  const cli = (...extra: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/compose-modules.mjs", "--official-list", list, "--test-allow-file-sources", ...extra], { encoding: "utf8", env: { ...process.env, LANCERLOGIN_PLUGIN_TOKEN: "" } });
  const byDefault = cli("--selection", missingSelection, "--output-root", outputRoot(t), "--work-directory", join(temporary(t, "work-cli"), "plugins"));
  assert.equal(byDefault.status, 0, byDefault.stderr); assert.match(byDefault.stdout, /Composed module example/);
  const excluded = cli("--no-official-modules", "--selection", missingSelection, "--output-root", outputRoot(t), "--work-directory", join(temporary(t, "work-cli-off"), "plugins"));
  assert.equal(excluded.status, 0, excluded.stderr); assert.match(excluded.stdout, /composing first-party modules only/);
});

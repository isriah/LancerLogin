// Local plugin development (npm run plugins:dev): its guards, its separation from installation builds, and a local
// folder composed with exactly the checks a pinned plugin receives. Tests compose into temporary output roots and never
// start the development servers.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultGeneratedContent, generatedFiles, moduleDataContent, moduleDataFile, parseSelectionFile, CompositionError } from "../scripts/compose-modules.mjs";
import { composeUpdateModules } from "../scripts/run-web-upgrade.mjs";
import {
  PluginDevelopmentError, composeLocalPlugins, developmentEnvironmentRefusal, developmentRuntime, localDevelopmentHeader, localPluginFiles, refusedEnvironmentMarkers, restoreLocalComposition,
} from "../scripts/plugin-dev.mjs";
import { isolatedGitEnv } from "../scripts/git-env.mjs";

const fixture = "tests/fixtures/module-plugins/example";
const coreRoot = fileURLToPath(new URL("../", import.meta.url));
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: isolatedGitEnv() });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
/** This process's environment without any CI or deployment marker, as on a developer's computer. */
const developerEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !refusedEnvironmentMarkers.includes(name)));

function temporary(t: test.TestContext, name: string) {
  const directory = mkdtempSync(join(tmpdir(), `lancerlogin-${name}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function outputRoot(t: test.TestContext) {
  const root = temporary(t, "plugin-dev-output");
  mkdirSync(join(root, "apps/dashboard/src"), { recursive: true });
  writeFileSync(join(root, "apps/dashboard/src/module-contributions.ts"), "export type DashboardModuleContribution = unknown;\n");
  return root;
}
/** A copy of the example plugin in its own git work tree, with a committed baseline. */
function pluginFolder(t: test.TestContext, change?: (directory: string) => void) {
  const directory = join(temporary(t, "plugin-dev-plugin"), "example");
  cpSync(fixture, directory, { recursive: true });
  writeFileSync(join(directory, ".gitignore"), "node_modules/\ndist/\n");
  git(directory, "init", "--quiet");
  git(directory, "add", "-A");
  git(directory, "commit", "--quiet", "-m", "Synthetic plugin");
  change?.(directory);
  return directory;
}
const read = (root: string, path: string) => existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n") : undefined;
const committedGenerated = () => [...Object.values(generatedFiles).map((file) => file.path), moduleDataFile].map((path) => read(coreRoot, path));

test("local plugin development refuses CI and deployment environments", () => {
  assert.equal(developmentEnvironmentRefusal({ PATH: "x" }), undefined);
  assert.equal(developmentEnvironmentRefusal({ CI: "false", GITHUB_ACTIONS: "", CF_PAGES: "0" }), undefined);
  for (const marker of ["CI", "GITHUB_ACTIONS", "CF_PAGES", "WORKERS_CI", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "INSTALLATION_SLUG", "WEB_UPDATE_TOKEN", "LANCERLOGIN_MODULE_SELECTION_TOKEN"]) {
    assert.match(developmentEnvironmentRefusal({ [marker]: "true" }) ?? "", new RegExp(`${marker} is set`), marker);
  }

  // The command refuses before it snapshots, composes or touches a generated file.
  const before = committedGenerated();
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/plugin-dev.mjs", "--plugin", fixture, "--no-official-modules"], { cwd: coreRoot, encoding: "utf8", env: { ...developerEnvironment(), CI: "true" } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Local plugin development failed: .*CI is set/);
  assert.deepEqual(committedGenerated(), before);
  const unknown = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/plugin-dev.mjs", "--plugin", fixture, "--selection", "lancerlogin.modules.json"], { cwd: coreRoot, encoding: "utf8", env: developerEnvironment() });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument --selection/);
});

test("installation builds, web updates and dashboard plugin management cannot use a local plugin", async () => {
  // Every lancerlogin.modules.json, and the Worker's plugin changes, accept only pinned https sources.
  const local = { id: "example", source: "file:///tmp/example", commit: "a".repeat(40) };
  assert.throws(() => parseSelectionFile(JSON.stringify({ format: 1, modules: [local] })), (error: unknown) => error instanceof CompositionError && /source must use https/.test(error.message));
  assert.throws(() => parseSelectionFile(JSON.stringify({ format: 1, modules: [{ ...local, path: "../example" }] })), CompositionError);
  // Web updates compose without file sources.
  let options: Record<string, unknown> | undefined;
  await composeUpdateModules({ selectionPath: "lancerlogin.modules.json", environment: {}, compose: async (value: Record<string, unknown>) => { options = value; return { modules: [] }; } });
  assert.equal(options?.allowFileSources, undefined);
  assert.equal(options?.officialModules, true);
  // Installation composition has no local option.
  const cli = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/compose-modules.mjs", "--plugin", fixture], { cwd: coreRoot, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Unknown argument --plugin/);
  // Nothing an installation runs refers to the local development mode.
  const installationFiles = [
    ...readdirSync(join(coreRoot, ".github/workflows")).map((name) => `.github/workflows/${name}`),
    "scripts/compose-modules.mjs", "scripts/run-web-upgrade.mjs", "scripts/prepare-cloudflare-provision.mjs", "scripts/test-plugin-sources.mjs",
    "apps/api/src/plugin-selection.ts", "apps/api/src/index.ts", "packages/shared/src/module-selection.ts",
  ];
  for (const path of installationFiles) assert.doesNotMatch(readFileSync(join(coreRoot, path), "utf8"), /plugin-dev|plugins:dev/, path);
});

test("a local plugin folder is snapshotted with its uncommitted work and composed like a pinned plugin", async (t) => {
  const directory = pluginFolder(t, (root) => {
    // Uncommitted work is included; ignored build output and dependencies are not.
    writeFileSync(join(root, "src/items.ts"), `${readFileSync(join(root, "src/items.ts"), "utf8")}\nexport const localEdit = true;\n`);
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist/bundle.js"), "import '../../../apps/api/src/index.ts';\n");
    mkdirSync(join(root, "node_modules/left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
  });
  assert.deepEqual(await localPluginFiles(directory), [".gitignore", "migrations/0001_create_example_tables.sql", "migrations/reviewed.json", "package.json", "src/api.ts", "src/dashboard.tsx", "src/items.ts", "src/manifest.ts"]);

  const output = outputRoot(t);
  const state = join(temporary(t, "plugin-dev-state"), "plugin-dev");
  const log: string[] = [];
  const result = await composeLocalPlugins({ plugins: [directory], officialModules: false, outputRoot: output, stateDirectory: state, env: developerEnvironment(), log: (line: string) => log.push(line) });
  assert.equal(result.composed, true);
  assert.deepEqual(result.modules, ["example"]);
  const [pin] = result.local;
  assert.match(pin.source, /^file:\/\//);
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  // Composition fetched the snapshot commit and checked it out exactly, as for a pinned https plugin.
  const checkout = join(state, "plugins/example");
  assert.equal(git(checkout, "rev-parse", "HEAD"), pin.commit);
  assert.match(readFileSync(join(checkout, "src/items.ts"), "utf8"), /localEdit/);
  assert.equal(existsSync(join(checkout, "dist")), false);
  assert.ok(log.some((line) => /Composed module example \(1 migration\(s\)\)/.test(line)), log.join("\n"));

  // Every generated file names itself as a local development composition and imports the composed checkout.
  for (const path of [...Object.values(generatedFiles).map((file) => file.path), moduleDataFile]) assert.equal(read(output, path)!.split("\n")[0], localDevelopmentHeader, path);
  assert.match(read(output, generatedFiles.manifests.path)!, /import module_example from "\.\.\/\.\.\/\.\.\/\.\.\/.*plugin-dev\/plugins\/example\/src\/manifest\.ts";/);
  assert.match(read(output, generatedFiles.dashboard.path)!, /plugin-dev\/plugins\/example\/src\/dashboard\.tsx/);
  assert.notEqual(read(output, generatedFiles.manifests.path), defaultGeneratedContent("manifests"));
  // The selection composition read lives in the ignored state directory and is not named lancerlogin.modules.json.
  assert.deepEqual(readdirSync(state).sort(), ["plugin-dev.selection.json", "plugins", "sources"]);

  // A second composition replaces the first; restoring returns the committed plugin-free defaults.
  writeFileSync(join(directory, "src/items.ts"), `${readFileSync(join(directory, "src/items.ts"), "utf8")}\nexport const secondEdit = true;\n`);
  const again = await composeLocalPlugins({ plugins: [directory], officialModules: false, outputRoot: output, stateDirectory: state, env: developerEnvironment(), log: () => {} });
  assert.notEqual(again.local[0].commit, pin.commit);
  assert.match(readFileSync(join(checkout, "src/items.ts"), "utf8"), /secondEdit/);
  await restoreLocalComposition({ outputRoot: output, stateDirectory: state });
  for (const kind of ["manifests", "api", "dashboard"] as const) assert.equal(read(output, generatedFiles[kind].path), defaultGeneratedContent(kind));
  assert.equal(read(output, moduleDataFile), moduleDataContent());
  assert.equal(existsSync(join(output, ".provision/module-migrations.json")), false);
});

test("a local plugin is refused for the same reasons as a pinned plugin, before any generated file is written", async (t) => {
  const attempt = async (change: (directory: string) => void) => {
    const output = outputRoot(t);
    const state = join(temporary(t, "plugin-dev-state"), "plugin-dev");
    const directory = pluginFolder(t, change);
    try { await composeLocalPlugins({ plugins: [directory], officialModules: false, outputRoot: output, stateDirectory: state, env: developerEnvironment(), log: () => {} }); }
    catch (error) {
      assert.ok(error instanceof CompositionError || error instanceof PluginDevelopmentError, String(error));
      assert.equal(existsSync(join(output, generatedFiles.manifests.path)), false);
      assert.equal(existsSync(join(output, moduleDataFile)), false);
      return (error as Error).message;
    }
    return assert.fail("composition should have been refused");
  };
  assert.match(await attempt((root) => writeFileSync(join(root, "src/items.ts"), "import '../../../apps/api/src/index.ts';\n")), /relative imports must stay inside the plugin/);
  assert.match(await attempt((root) => writeFileSync(join(root, "src/items.ts"), "import '@lancerlogin/shared';\n")), /Core packages are internal; use @lancerlogin\/module-sdk/);
  assert.match(await attempt((root) => writeFileSync(join(root, "migrations/0001_create_example_tables.sql"), "CREATE TABLE example_items (id TEXT);\n")), /does not match its reviewed hash/);
  assert.match(await attempt((root) => { const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); pkg.peerDependencies = { react: "^1.0.0" }; writeFileSync(join(root, "package.json"), JSON.stringify(pkg)); }), /needs react \^1\.0\.0; this Core provides react/);
  assert.match(await attempt((root) => { const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); pkg.lancerlogin.moduleId = "Not Valid"; writeFileSync(join(root, "package.json"), JSON.stringify(pkg)); }), /no valid lancerlogin\.moduleId/);
  await assert.rejects(composeLocalPlugins({ plugins: [], officialModules: false, outputRoot: outputRoot(t), env: developerEnvironment() }), /--plugin <folder>/);
  await assert.rejects(composeLocalPlugins({ plugins: [fixture], officialModules: false, outputRoot: outputRoot(t), env: { ...developerEnvironment(), GITHUB_ACTIONS: "true" } }), /GITHUB_ACTIONS is set/);
});

test("the local Worker configuration uses a local database, the dashboard origin and generated development secrets", async (t) => {
  const state = join(temporary(t, "plugin-dev-runtime"), "plugin-dev");
  const runtime = await developmentRuntime({ stateDirectory: state, apiPort: 8788, dashboardPort: 5174 });
  const config = JSON.parse(readFileSync(runtime.configPath, "utf8"));
  assert.equal(config.vars.ALLOWED_ORIGIN, "http://localhost:5174");
  assert.equal(runtime.apiUrl, "http://localhost:8788");
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(existsSync(join(state, config.main)), true, "main is relative to the state directory");
  const vars = readFileSync(join(state, ".dev.vars"), "utf8");
  for (const name of ["SESSION_KEY", "INTEGRATION_KEY", "FINGERPRINT_VAULT_KEY", "BOOTSTRAP_CODE_HASH"]) assert.match(vars, new RegExp(`^${name}=[A-Za-z0-9_-]{40,}$`, "m"), name);
  // Values persist for the checkout's local database.
  const again = await developmentRuntime({ stateDirectory: state, apiPort: 8788, dashboardPort: 5174 });
  assert.equal(again.setupCode, runtime.setupCode);
  assert.equal(readFileSync(join(state, ".dev.vars"), "utf8"), vars);
});

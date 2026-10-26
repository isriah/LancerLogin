import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const modes = new Set(["fast", "acceptance"]);
const selectionKeys = ["javascript", "typescript", "browser", "typecheckWorkspaces", "buildWorkspaces"];
const fileRules = {
  javascript: { directory: "tests", suffix: ".test.mjs" },
  typescript: { directory: "tests-ts", suffix: ".test.ts" },
  browser: { directory: "tests-browser", suffix: ".spec.ts" },
};

function inside(root, target) {
  const value = relative(resolve(root), resolve(target));
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function stringArray(value, context) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${context} must be an array of non-empty strings.`);
  if (new Set(value).size !== value.length) throw new Error(`${context} contains duplicate entries.`);
  return value;
}

function validateSelection(root, moduleId, mode, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${moduleId} ${mode} selection is required.`);
  const unknownKeys = Object.keys(value).filter((key) => !selectionKeys.includes(key));
  if (unknownKeys.length) throw new Error(`${moduleId} ${mode} selection has unknown keys: ${unknownKeys.join(", ")}.`);
  const selection = Object.fromEntries(selectionKeys.map((key) => [key, stringArray(value[key], `${moduleId} ${mode} ${key}`)]));
  const selectedCount = selectionKeys.reduce((count, key) => count + selection[key].length, 0);
  if (!selectedCount) throw new Error(`${moduleId} ${mode} selection is empty.`);
  if (mode === "fast" && (selection.browser.length || selection.typecheckWorkspaces.length || selection.buildWorkspaces.length)) throw new Error(`${moduleId} fast selection must contain logic tests only.`);
  for (const [kind, rule] of Object.entries(fileRules)) for (const file of selection[kind]) {
    const normalized = file.replaceAll("\\", "/");
    const target = resolve(root, normalized);
    if (!normalized.startsWith(`${rule.directory}/`) || !normalized.endsWith(rule.suffix) || !inside(root, target) || !existsSync(target) || !statSync(target).isFile()) throw new Error(`${moduleId} ${mode} references missing or invalid ${kind} file: ${file}.`);
  }
  for (const key of ["typecheckWorkspaces", "buildWorkspaces"]) for (const workspace of selection[key]) {
    if (!/^@lancerlogin\/[a-z0-9-]+$/.test(workspace)) throw new Error(`${moduleId} ${mode} has an invalid workspace name: ${workspace}.`);
    const packageDirectory = readdirSync(join(root, workspace === "@lancerlogin/shared" ? "packages" : "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, workspace === "@lancerlogin/shared" ? "packages" : "apps", entry.name))
      .find((directory) => {
        try { return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === workspace; } catch { return false; }
      });
    if (!packageDirectory) throw new Error(`${moduleId} ${mode} references missing workspace: ${workspace}.`);
    const scripts = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")).scripts ?? {};
    const requiredScript = key === "typecheckWorkspaces" ? "typecheck" : "build";
    if (!scripts[requiredScript]) throw new Error(`${moduleId} ${mode} workspace ${workspace} has no ${requiredScript} script.`);
  }
  return selection;
}

export function discoverModuleManifests(root = process.cwd()) {
  const directory = join(root, "module-tests");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error("Module test manifest directory is missing: module-tests.");
  const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (!files.length) throw new Error("Module test manifest directory contains no JSON manifests.");
  const manifests = new Map();
  for (const name of files) {
    let value;
    try { value = JSON.parse(readFileSync(join(directory, name), "utf8")); } catch (error) { throw new Error(`Invalid module test manifest ${name}: ${error.message}`); }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) throw new Error(`Module test manifest ${name} must use schemaVersion 1.`);
    if (typeof value.module !== "string" || !/^[a-z0-9-]+$/.test(value.module) || name !== `${value.module}.json`) throw new Error(`Module test manifest ${name} has an invalid module identity.`);
    if (manifests.has(value.module)) throw new Error(`Duplicate module test manifest: ${value.module}.`);
    if (typeof value.label !== "string" || !value.label.trim()) throw new Error(`Module test manifest ${name} requires a label.`);
    const manifest = { schemaVersion: 1, module: value.module, label: value.label, fast: validateSelection(root, value.module, "fast", value.fast), acceptance: validateSelection(root, value.module, "acceptance", value.acceptance) };
    manifests.set(manifest.module, manifest);
  }
  return manifests;
}

function printSelection(manifest, mode) {
  const selection = manifest[mode];
  console.log(`${manifest.module} - ${manifest.label} - ${mode}`);
  for (const key of selectionKeys) {
    console.log(`  ${key}:`);
    for (const item of selection[key]) console.log(`    ${item}`);
    if (!selection[key].length) console.log("    (none)");
  }
}

function run(root, label, command, args) {
  console.log(`\n${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed${result.signal ? ` (${result.signal})` : ""}.`);
}

function runNpm(root, label, args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) return run(root, label, process.execPath, [npmCli, ...args]);
  if (process.platform === "win32") throw new Error(`${label} cannot locate npm's JavaScript entrypoint.`);
  return run(root, label, "npm", args);
}

export function runModuleTests({ root = process.cwd(), mode, moduleId, execute = true } = {}) {
  const manifests = discoverModuleManifests(root);
  if (mode === "list") {
    if (moduleId && !manifests.has(moduleId)) throw new Error(`Unknown module ${moduleId}. Available modules: ${[...manifests.keys()].join(", ")}.`);
    for (const manifest of moduleId ? [manifests.get(moduleId)] : manifests.values()) for (const selectionMode of modes) printSelection(manifest, selectionMode);
    return 0;
  }
  if (!modes.has(mode)) throw new Error("Mode must be list, fast, or acceptance.");
  if (!moduleId || !manifests.has(moduleId)) throw new Error(`Unknown module ${moduleId ?? "(missing)"}. Available modules: ${[...manifests.keys()].join(", ")}.`);
  const manifest = manifests.get(moduleId);
  const selection = manifest[mode];
  printSelection(manifest, mode);
  if (!execute) return 0;
  if (selection.javascript.length) run(root, `${manifest.label} JavaScript tests`, process.execPath, ["--test", "--test-concurrency=2", ...selection.javascript]);
  if (selection.typescript.length) run(root, `${manifest.label} TypeScript tests`, process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=2", ...selection.typescript]);
  if (selection.browser.length) run(root, `${manifest.label} browser tests`, process.execPath, [join(root, "scripts", "run-browser-tests.mjs"), ...selection.browser, `--workers=${process.env.CI ? 1 : 2}`]);
  if (selection.typecheckWorkspaces.length) runNpm(root, `${manifest.label} typechecks`, ["run", "typecheck", ...selection.typecheckWorkspaces.flatMap((workspace) => ["--workspace", workspace])]);
  if (selection.buildWorkspaces.length) runNpm(root, `${manifest.label} builds`, ["run", "build", ...selection.buildWorkspaces.flatMap((workspace) => ["--workspace", workspace])]);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, moduleId, ...extra] = process.argv.slice(2);
    if (extra.length || !mode || mode === "list" && process.argv.slice(2).length > 2 || mode !== "list" && process.argv.slice(2).length !== 2) throw new Error("Usage: node scripts/run-module-tests.mjs list [module] | fast <module> | acceptance <module>");
    process.exitCode = runModuleTests({ mode, moduleId });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Module verification failed.");
    process.exitCode = 1;
  }
}

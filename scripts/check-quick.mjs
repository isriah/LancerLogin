// Quick development check: typecheck the workspaces a change touches and run the fast Node tests that reference the
// changed files. It is an edit-loop aid, not verification: `npm run verify:all`, the unfiltered browser suite and the
// complete Verify workflow remain the gates for publication and release.
//
//   npm run check:quick                     changes since the merge base with the default base, plus uncommitted work
//   npm run check:quick -- --base REF       compare with REF instead
//   npm run check:quick -- --list           print the selection and the reasons without running it
//   npm run check:quick -- --all-typecheck  typecheck every workspace regardless of the change
//   npm run check:quick -- --all            every workspace typecheck and every fast test (the private CI quick check)
//
// The default base is, in order: LANCERLOGIN_CHECK_BASE, `git config lancerlogin.checkBase`, the current branch's
// upstream when that is a different branch, then origin/HEAD.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kioskOnlyTests } from "./run-web-tests.mjs";
import { isolatedGitEnv } from "./git-env.mjs";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const workspaces = {
  "@lancerlogin/shared": "packages/shared",
  "@lancerlogin/module-sdk": "packages/module-sdk",
  "@lancerlogin/api": "apps/api",
  "@lancerlogin/dashboard": "apps/dashboard",
  "@lancerlogin/kiosk": "apps/kiosk",
};
const allWorkspaces = Object.keys(workspaces);
// Shared contracts (and the module SDK they import) are imported by source path from every application, so a change
// there typechecks them all.
const typecheckOwners = [
  { prefix: "packages/shared/", workspaces: ["@lancerlogin/shared", "@lancerlogin/api", "@lancerlogin/dashboard", "@lancerlogin/kiosk"] },
  { prefix: "packages/module-sdk/", workspaces: allWorkspaces },
  { prefix: "apps/api/", workspaces: ["@lancerlogin/api"] },
  { prefix: "apps/dashboard/", workspaces: ["@lancerlogin/dashboard"] },
  { prefix: "apps/kiosk/", workspaces: ["@lancerlogin/kiosk"] },
];
const rootBuildFiles = new Set(["package.json", "package-lock.json", "tsconfig.json"]);
const codeExtensions = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs", ".json", ".css", ".sql", ".yml", ".yaml", ".sh", ".html"]);

// Suites too slow for an edit loop (each over 10 seconds alone) are left to npm test, verify:all and Verify unless the
// suite itself changed. Physical kiosk suites never run here; verify:kiosk owns them.
export const slowTests = new Set([
  "tests/kiosk-poll-service.test.mjs",
  "tests/kiosk-operator-service.test.mjs",
  "tests/web-updates-workerd.test.mjs",
  "tests-ts/module-composition.test.ts",
  "tests-ts/fingerprint-vault.test.ts",
]);
export const deviceTests = new Set(kioskOnlyTests);
// Run when a change maps to no test, or touches root build files. Kept small: these cover the module platform,
// dashboard conformance and the test runners themselves in well under a minute.
export const defaultTests = [
  "tests/web-test-runner.test.mjs",
  "tests/check-quick.test.mjs",
  "tests-ts/module-platform.test.ts",
  "tests-ts/dashboard-conformance.test.ts",
];

export const browserGroupsTest = "tests/browser-groups.test.mjs";
const browserSpec = /^tests-browser\/[^/]+\.spec\.ts$/;
const isTestFile = (path) => /^(?:tests|private)\/.+\.test\.mjs$/.test(path) || /^tests-ts\/.+\.test\.ts$/.test(path);
const withoutExtension = (path) => path.slice(0, path.length - extname(path).length);

// The text a test would contain if it imported or read this file: its repository path without the extension, and for
// test helpers the path relative to the test directory (tests import them as ./fixtures/x.ts or ../fixtures/x.ts).
export function referenceKeys(path) {
  const keys = [withoutExtension(path)];
  const testHelper = /^(?:tests|tests-ts|tests-browser)\/(.+)$/.exec(path)?.[1];
  if (testHelper && testHelper.includes("/")) keys.push(withoutExtension(testHelper));
  else if (testHelper && basename(testHelper, extname(testHelper)).length >= 6) keys.push(`./${withoutExtension(testHelper)}`);
  return keys;
}

/**
 * Select the quick checks for a set of changed repository paths.
 * @param {object} input
 * @param {string[]} input.changes repository-relative paths with forward slashes (deleted files included)
 * @param {Map<string, string>} input.tests every fast-candidate test file and its source text
 * @param {(path: string) => boolean} [input.exists] whether a changed path still exists
 * @param {boolean} [input.allTypecheck]
 * @param {boolean} [input.all] select every workspace and every fast test
 */
export function selectQuickChecks({ changes, tests, exists = () => true, allTypecheck = false, all = false }) {
  const typecheck = new Map(); const selected = new Map(); const skipped = new Map(); const notes = [];
  const add = (map, key, reason) => { if (!map.has(key)) map.set(key, []); if (!map.get(key).includes(reason)) map.get(key).push(reason); };
  const select = (file, reason, changed = false) => deviceTests.has(file) || slowTests.has(file) && !changed ? add(skipped, file, reason) : add(selected, file, reason);
  if (allTypecheck || all) for (const workspace of allWorkspaces) add(typecheck, workspace, all ? "--all" : "--all-typecheck");
  if (all) for (const file of tests.keys()) select(file, "--all");
  let rootBuildChange = false;
  for (const path of [...new Set(changes)].sort()) {
    if (rootBuildFiles.has(path)) {
      rootBuildChange = true;
      for (const workspace of allWorkspaces) add(typecheck, workspace, `${path} changed`);
      continue;
    }
    for (const rule of typecheckOwners) if (path.startsWith(rule.prefix) && codeExtensions.has(extname(path))) {
      for (const workspace of rule.workspaces) add(typecheck, workspace, `${path} changed`);
    }
    if (isTestFile(path)) {
      if (exists(path)) select(path, "changed test", true);
      continue;
    }
    if (!codeExtensions.has(extname(path)) && !path.endsWith(".md")) continue;
    if (!path.includes("/")) continue; // other root files have no reliable reference text
    const keys = referenceKeys(path);
    let matched = false;
    // Browser specs are not run here, but adding, removing or changing one must keep the release-gate group manifest
    // (tests-browser/groups.json) complete and correct.
    if (browserSpec.test(path) && tests.has(browserGroupsTest)) { select(browserGroupsTest, `${path} must keep its browser group`); matched = true; }
    for (const [file, source] of tests) if (keys.some((key) => source.includes(key))) { select(file, `references ${path}`); matched = true; }
    if (!matched && !path.endsWith(".md")) notes.push(`No fast test references ${path}`);
  }
  let fallback = false;
  if (!all && (!selected.size || rootBuildChange)) {
    fallback = !selected.size;
    for (const file of defaultTests) if (tests.has(file)) add(selected, file, rootBuildChange ? "root build file changed: default set" : "default set: nothing else mapped");
  }
  const sortedEntries = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, reasons]) => ({ name, reasons }));
  const chosen = sortedEntries(selected);
  return {
    typecheck: sortedEntries(typecheck).sort((a, b) => allWorkspaces.indexOf(a.name) - allWorkspaces.indexOf(b.name)),
    javascript: chosen.filter(({ name }) => name.endsWith(".mjs")),
    typescript: chosen.filter(({ name }) => name.endsWith(".ts")),
    skipped: sortedEntries(skipped),
    fallback,
    notes,
  };
}

export function discoverFastTests(root = rootDirectory) {
  const tests = new Map();
  // private/ holds development-only tooling tests in private repositories and is absent from public exports.
  for (const [directory, suffix] of [["tests", ".test.mjs"], ["tests-ts", ".test.ts"], ["private", ".test.mjs"]]) {
    if (!existsSync(join(root, directory))) continue;
    for (const name of readdirSync(join(root, directory), { recursive: true })) {
      const path = `${directory}/${String(name).replaceAll("\\", "/")}`;
      if (path.endsWith(suffix)) tests.set(path, readFileSync(join(root, path), "utf8"));
    }
  }
  return tests;
}

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const tryGit = (root, args) => { try { return git(root, args).trim(); } catch { return ""; } };

export function defaultBase(root = rootDirectory, env = process.env) {
  if (env.LANCERLOGIN_CHECK_BASE) return { ref: env.LANCERLOGIN_CHECK_BASE, source: "LANCERLOGIN_CHECK_BASE" };
  const configured = tryGit(root, ["config", "--get", "lancerlogin.checkBase"]);
  if (configured) return { ref: configured, source: "git config lancerlogin.checkBase" };
  const branch = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const upstream = tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream && branch && upstream.replace(/^[^/]+\//, "") !== branch) return { ref: upstream, source: "branch upstream" };
  const originHead = tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return { ref: originHead, source: "origin/HEAD" };
  throw new Error("No base found. Pass --base REF, set LANCERLOGIN_CHECK_BASE, or run git remote set-head origin --auto.");
}

/** Committed changes since the merge base with `base`, plus staged, unstaged and untracked work. */
export function changedPaths(root, base) {
  if (typeof base !== "string" || !base || base.startsWith("-") || /[\r\n\0]/.test(base)) throw new Error("Invalid base revision");
  const baseSha = git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
  const mergeBase = tryGit(root, ["merge-base", baseSha, "HEAD"]);
  if (!mergeBase) throw new Error(`${base} shares no history with HEAD. Pass --base REF, or run git remote set-head origin --auto if origin/HEAD is stale.`);
  const split = (value) => value.split("\0").filter(Boolean);
  const paths = [...split(git(root, ["diff", "--name-only", "-z", "--no-renames", mergeBase, "--"])),
    ...split(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))];
  return { mergeBase, paths: [...new Set(paths)].sort() };
}

function typecheckCommand(root, workspace) {
  const directory = join(root, workspaces[workspace]);
  const script = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).scripts?.typecheck;
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  // Run tsc directly so workspaces check in parallel; anything other than a plain tsc script goes through npm.
  if (typeof script === "string" && /^tsc(?: [\w./-]+)*$/.test(script) && existsSync(tsc)) return { program: process.execPath, args: [tsc, ...script.split(" ").slice(1)], cwd: directory };
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) return { program: process.execPath, args: [npmCli, "run", "typecheck", "--workspace", workspace], cwd: root };
  return { program: "npm", args: ["run", "typecheck", "--workspace", workspace], cwd: root, shell: process.platform === "win32" };
}

function run(program, args, { cwd, buffer = false, shell = false }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    // Tests create their own repositories; a hook's GIT_DIR or GIT_INDEX_FILE must not point them at this one.
    const child = spawn(program, args, { cwd, shell, env: isolatedGitEnv(), windowsHide: true, stdio: buffer ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    if (buffer) { child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; }); }
    child.once("error", (error) => resolvePromise({ status: 1, output: `${output}${error.message}\n`, seconds: (Date.now() - started) / 1000 }));
    child.once("close", (status, signal) => resolvePromise({ status: status ?? 1, signal, output, seconds: (Date.now() - started) / 1000 }));
  });
}

function printPlan(plan, base, changes) {
  console.log(`Quick check against ${base.ref} (${base.source}), merge base ${changes.mergeBase.slice(0, 12)}: ${changes.paths.length} changed file(s).`);
  console.log("This is a development check, not release verification.");
  const section = (title, entries) => {
    console.log(`\n${title}:`);
    if (!entries.length) console.log("  (none)");
    for (const { name, reasons } of entries) console.log(`  ${name}\n      ${reasons.slice(0, 3).join("; ")}${reasons.length > 3 ? `; and ${reasons.length - 3} more` : ""}`);
  };
  section("Typecheck", plan.typecheck);
  section("Node tests", plan.javascript);
  section("TypeScript tests", plan.typescript);
  if (plan.skipped.length) section("Not run here: slow or physical-kiosk suites (npm test and verify:kiosk run them)", plan.skipped);
  if (plan.notes.length) console.log(`\n${plan.notes.map((note) => `Note: ${note}`).join("\n")}`);
  if (plan.fallback) console.log("\nNo changed file mapped to a fast test, so the default set runs.");
}

/** The check could not start: a bad option or no usable base. Only this maps to exit code 2, which the pre-push hook lets through. */
export class StartupError extends Error {}
/** Exit 1 means a check failed or something unexpected broke; exit 2 is reserved for a StartupError. */
export const exitCodeFor = (error) => error instanceof StartupError ? 2 : 1;

export async function main(args, root = rootDirectory) {
  const options = { list: false, all: false, allTypecheck: false, concurrency: 2 };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--list") options.list = true;
    else if (key === "--all-typecheck") options.allTypecheck = true;
    else if (key === "--all") options.all = true;
    else if (key === "--base" || key === "--concurrency") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new StartupError(`Missing value for ${key}`);
      if (key === "--base") options.base = value;
      else { options.concurrency = Number(value); if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new StartupError("--concurrency must be 1 to 8"); }
    } else throw new StartupError("Usage: node scripts/check-quick.mjs [--base REF] [--list] [--all | --all-typecheck] [--concurrency N]");
  }
  const started = Date.now();
  let base, changes;
  try {
    base = options.base ? { ref: options.base, source: "--base" } : defaultBase(root);
    changes = changedPaths(root, base.ref);
  } catch (error) { throw new StartupError(error instanceof Error ? error.message : String(error), { cause: error }); }
  const plan = selectQuickChecks({ changes: changes.paths, tests: discoverFastTests(root), exists: (path) => existsSync(join(root, path)), allTypecheck: options.allTypecheck, all: options.all });
  printPlan(plan, base, changes);
  if (options.list) return 0;

  const failures = [];
  // Typechecks run in parallel with buffered output; the tests then stream.
  const typechecks = plan.typecheck.map(({ name }) => {
    const command = typecheckCommand(root, name);
    return run(command.program, command.args, { cwd: command.cwd, buffer: true, shell: command.shell }).then((result) => ({ name, ...result }));
  });
  const testRuns = [];
  const concurrency = `--test-concurrency=${options.concurrency}`;
  if (plan.javascript.length) testRuns.push(["Node tests", [ "--test", concurrency, ...plan.javascript.map(({ name }) => name)]]);
  if (plan.typescript.length) testRuns.push(["TypeScript tests", ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", concurrency, ...plan.typescript.map(({ name }) => name)]]);
  for (const [label, testArgs] of testRuns) {
    console.log(`\n${label}:`);
    const result = await run(process.execPath, testArgs, { cwd: root });
    if (result.status !== 0) failures.push(`${label} (exit ${result.status})`);
  }
  for (const result of await Promise.all(typechecks)) {
    console.log(`\nTypecheck ${result.name}: ${result.status === 0 ? "passed" : "FAILED"} in ${result.seconds.toFixed(1)}s`);
    if (result.status !== 0) { process.stdout.write(result.output); failures.push(`Typecheck ${result.name}`); }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length) { console.error(`\nQuick check failed in ${seconds}s: ${failures.join(", ")}.`); return 1; }
  console.log(`\nQuick check passed in ${seconds}s.`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Exit 1 means a check failed or an unexpected error occurred; exit 2 means only that the check could not start
  // (bad option, no usable base). The pre-push hook lets exit 2 through, so nothing else may map to it.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof StartupError ? error.message : `Quick check stopped unexpectedly: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = exitCodeFor(error);
  });
}

// Quick development check: typecheck the workspaces a change touches and run the fast Node tests that reference the
// changed files, reach them through their static import closure, or declare them with a `quick-check: covers` header.
// It is an edit-loop aid, not verification: `npm run verify:all`, the unfiltered browser suite and the complete Verify
// workflow remain the gates for publication and release.
//
//   npm run check:quick                     changes since the merge base with the default base, plus uncommitted work
//   npm run check:quick -- --base REF       compare with REF instead
//   npm run check:quick -- --list           print the selection and the reasons without running it
//   npm run check:quick -- --list --why P   also print how each selecting test reaches path P
//   npm run check:quick -- --selection text text matching only, as private CI runs it to keep its minutes flat
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
// Plugin pins and composition: a change here also runs `verify:module -- fast <id>` for each affected plugin (which
// requires the plugin, failing instead of skipping when it can't be fetched) and runs the composition suite.
const compositionTest = "tests-ts/module-composition.test.ts";
const compositionFiles = [/^scripts\/(?:official|known)-modules\.json$/, /^tests\/fixtures\/[^/]+\.modules\.json$/, /^module-tests\/[^/]+\.json$/, /^scripts\/(?:compose-modules|test-plugin-sources)\.mjs$/];
export const isCompositionFile = (path) => compositionFiles.some((pattern) => pattern.test(path));
// Plugin module IDs with the selection each composes (module-tests/<id>.json pluginSelection); main reads the manifests.
export const pluginModules = { "hour-tracking": "tests/fixtures/official.modules.json", carpool: "tests/fixtures/carpool.modules.json" };
/** The plugin modules whose fast gate a changed path affects. */
export function affectedPlugins(path, plugins = pluginModules) {
  if (!isCompositionFile(path)) return [];
  const ids = Object.keys(plugins).sort();
  if (/^tests\/fixtures\/[^/]+\.modules\.json$/.test(path)) return ids.filter((id) => plugins[id] === path);
  const manifest = /^module-tests\/([^/]+)\.json$/.exec(path)?.[1];
  return manifest ? ids.filter((id) => id === manifest) : ids;
}
// Run when a change maps to no test, or touches root build files. Kept small: these cover the module platform,
// dashboard conformance and the test runners themselves in well under a minute.
export const defaultTests = [
  "tests/web-test-runner.test.mjs",
  "tests/check-quick.test.mjs",
  "tests-ts/module-platform.test.ts",
  "tests-ts/outreach-module-platform.test.ts",
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

// Static closures. A test also covers every file it reaches through `import`, `export ... from` and literal `import()`
// (JSON imports included), and, from test-side code, string literals naming a repository file: scripts under scripts/
// are walked as spawned, anything else it names (fixtures, data, source read as text) is a leaf. Directories never become
// edges and computed paths are invisible, so a test or helper declares what it reads that way with a header that every
// test whose closure includes it inherits:
//   // quick-check: covers apps/api/migrations/**
const testSideCode = /^(?:tests|tests-ts|scripts|private)\//;
const parsedExtensions = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs"]);
const importPattern = /\b(?:import|export)\s*(?:type\s+)?(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const literalPattern = /(["'`])([^"'`$\s\\]+)\1/g;
const joinedPattern = /\b(?:join|resolve)\(([^()]*)\)/g;
const coverPattern = /^[ \t]*\/\/[ \t]*quick-check:[ \t]*covers[ \t]+(.+)$/gm;
const directoryReadPattern = /\b(readdir|readdirSync|cpSync|glob|globSync)\s*\(/g;

function normalize(path) {
  const parts = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!parts.length) return undefined; parts.pop(); } else parts.push(part);
  }
  return parts.join("/");
}
const directoryOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const literalCandidates = (from, literal) => (/^\.\.?\//.test(literal) ? [normalize(`${directoryOf(from)}/${literal}`)] : [normalize(literal), normalize(`${directoryOf(from)}/${literal}`)]).filter(Boolean);

/** A glob as a RegExp: `**` spans folders, `*` and `?` stay within one. */
export function globPattern(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      const folder = glob[index + 2] === "/";
      source += folder ? "(?:.*/)?" : ".*";
      index += folder ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The globs a source text declares with `// quick-check: covers <glob> [<glob> ...]`. */
export const coverHeaders = (source) => [...source.matchAll(coverPattern)].flatMap((match) => match[1].trim().split(/\s+/));

function workspaceExports(files, readFile) {
  const exports = new Map();
  for (const file of files) if (/^(?:apps|packages)\/[^/]+\/package\.json$/.test(file)) {
    let value;
    try { value = JSON.parse(readFile(file) ?? ""); } catch { continue; }
    const entries = typeof value.exports === "string" ? { ".": value.exports } : value.exports ?? {};
    for (const [key, target] of Object.entries(entries)) if (typeof target === "string") exports.set(`${value.name}${key === "." ? "" : key.slice(1)}`, normalize(`${directoryOf(file)}/${target}`));
  }
  return exports;
}

/**
 * Build every test's static closure and inherited `covers` globs, for selectQuickChecks.
 * @param {(path: string) => string | undefined} readFile source text of a repository-relative path
 * @param {() => string[]} listFiles every repository file, tracked and untracked, with forward slashes
 */
export function buildTestClosures(readFile, listFiles) {
  const files = new Set(listFiles());
  const packages = workspaceExports(files, readFile);
  const sources = new Map();
  const source = (file) => {
    if (!sources.has(file)) sources.set(file, parsedExtensions.has(extname(file)) ? readFile(file) ?? "" : "");
    return sources.get(file);
  };
  const resolveImport = (from, specifier) => {
    if (packages.has(specifier)) return packages.get(specifier);
    if (!/^\.\.?\//.test(specifier)) return undefined;
    const base = normalize(`${directoryOf(from)}/${specifier}`);
    if (!base) return undefined;
    const stem = base.replace(/\.(?:m?js|jsx)$/, "");
    return [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.mjs`].find((candidate) => files.has(candidate));
  };
  const edgeCache = new Map();
  const edges = (file) => {
    if (edgeCache.has(file)) return edgeCache.get(file);
    const text = source(file); const found = new Map();
    for (const match of text.matchAll(importPattern)) {
      const target = resolveImport(file, match[1] ?? match[2]);
      if (target && target !== file) found.set(target, "imports");
    }
    if (testSideCode.test(file)) {
      const literals = [...text.matchAll(literalPattern)].map((match) => match[2]);
      for (const match of text.matchAll(joinedPattern)) {
        const parts = [...match[1].matchAll(literalPattern)].map((part) => part[2]);
        if (parts.length > 1) literals.push(parts.join("/"));
      }
      for (const literal of literals) {
        if (!literal.includes("/") && !literal.includes(".")) continue;
        const target = literalCandidates(file, literal).find((candidate) => files.has(candidate));
        if (!target || target === file || found.has(target)) continue;
        found.set(target, parsedExtensions.has(extname(target)) && target.startsWith("scripts/") ? "runs" : "reads");
      }
    }
    const list = [...found].map(([target, kind]) => ({ target, kind }));
    edgeCache.set(file, list);
    return list;
  };
  const headers = new Map();
  const headersOf = (file) => {
    if (!headers.has(file)) headers.set(file, coverHeaders(source(file)));
    return headers.get(file);
  };
  const closureCache = new Map();
  /** Every file `start` reaches, each mapped to the step that reached it (null for `start`). */
  const closureOf = (start) => {
    if (closureCache.has(start)) return closureCache.get(start);
    const reached = new Map([[start, null]]); const queue = [start];
    for (let index = 0; index < queue.length; index++) for (const { target, kind } of edges(queue[index])) {
      if (reached.has(target)) continue;
      reached.set(target, { from: queue[index], kind });
      if (kind !== "reads") queue.push(target);
    }
    closureCache.set(start, reached);
    return reached;
  };
  const closures = new Map(); const covers = new Map();
  for (const file of [...files].filter(isTestFile).sort()) {
    const closure = closureOf(file);
    closures.set(file, closure);
    covers.set(file, [...new Set(executedFiles(closure).flatMap(headersOf))]);
  }
  return { closures, covers, headers: new Map([...headers].filter(([, globs]) => globs.length)), closureOf, files };
}

/** The files of a closure that run (the start and what it imports or spawns), not those it only reads; headers come from these. */
export const executedFiles = (closure) => [...closure].filter(([, step]) => step?.kind !== "reads").map(([file]) => file);

/** The files by which a closure reaches `file`, starting with the closure's own start, or undefined. */
export function closureChain(closure, file) {
  if (!closure?.has?.(file) || !(closure instanceof Map)) return undefined;
  const chain = [file];
  for (let step = closure.get(file); step; step = closure.get(step.from)) chain.unshift(step.from);
  return chain;
}

/**
 * Directories a source reads with a literal readdir, readdirSync, cpSync or glob argument: a string, a template
 * literal's leading folders, or the literal segments of join, resolve or new URL. Only folders holding repository files
 * count; anything else is temporary or computed.
 */
export function literalDirectoryReads(file, text, files) {
  const directories = new Set();
  for (const path of files) for (let index = path.indexOf("/"); index > 0; index = path.indexOf("/", index + 1)) directories.add(path.slice(0, index));
  const reads = [];
  for (const match of text.matchAll(directoryReadPattern)) {
    const start = match.index + match[0].length; let depth = 0; let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) { if (!depth) break; depth--; } else if (char === "," && !depth) break;
    }
    const argument = text.slice(start, end).trim();
    const template = /^`([^`]*?)\$\{/.exec(argument);
    let literal;
    if (/^(["'`])[^"'`$]*\1$/.test(argument)) literal = argument.slice(1, -1);
    else if (template) literal = template[1].slice(0, Math.max(template[1].lastIndexOf("/"), 0));
    else if (/^(?:join|resolve|new URL)\(/.test(argument)) literal = [...argument.matchAll(literalPattern)].map((part) => part[2]).join("/");
    const directory = literal ? literalCandidates(file, literal).find((candidate) => directories.has(candidate)) : undefined;
    if (directory) reads.push({ call: match[1], directory, line: text.slice(0, match.index).split("\n").length });
  }
  return reads;
}

/**
 * Select the quick checks for a set of changed repository paths.
 * @param {object} input
 * @param {string[]} input.changes repository-relative paths with forward slashes (deleted files included)
 * @param {Map<string, string>} input.tests every fast-candidate test file and its source text
 * @param {(path: string) => boolean} [input.exists] whether a changed path still exists
 * @param {Map<string, { has(path: string): boolean }>} [input.closures] each test's static closure (buildTestClosures)
 * @param {Map<string, string[]>} [input.covers] each test's declared and inherited `covers` globs (buildTestClosures)
 * @param {Record<string, string>} [input.plugins] plugin module IDs and the test selection each composes
 * @param {(path: string) => boolean} [input.exists] whether a changed path still exists
 * @param {boolean} [input.allTypecheck]
 * @param {boolean} [input.all] select every workspace and every fast test
 * @param {"full" | "text"} [input.selection] "text" uses text matching only: no closures, headers or module gates
 */
export function selectQuickChecks({ changes, tests, closures = new Map(), covers = new Map(), plugins = pluginModules, exists = () => true, allTypecheck = false, all = false, selection = "full" }) {
  if (selection === "text") { closures = new Map(); covers = new Map(); plugins = {}; }
  const typecheck = new Map(); const selected = new Map(); const skipped = new Map(); const modules = new Map(); const notes = [];
  const add = (map, key, reason) => { if (!map.has(key)) map.set(key, []); if (!map.get(key).includes(reason)) map.get(key).push(reason); };
  const uniqueChanges = [...new Set(changes)].sort();
  // A pin or composition change runs the composition suite here, beside each affected plugin's fast module gate.
  const compositionChange = selection !== "text" && uniqueChanges.some(isCompositionFile);
  const slow = (file) => slowTests.has(file) && !(compositionChange && file === compositionTest);
  const select = (file, reason, changed = false) => deviceTests.has(file) || slow(file) && !changed ? add(skipped, file, reason) : add(selected, file, reason);
  if (allTypecheck || all) for (const workspace of allWorkspaces) add(typecheck, workspace, all ? "--all" : "--all-typecheck");
  if (all) for (const file of tests.keys()) select(file, "--all");
  const coverPatterns = new Map([...covers].map(([file, globs]) => [file, globs.map((glob) => [glob, globPattern(glob)])]));
  let rootBuildChange = false;
  for (const path of uniqueChanges) {
    for (const id of affectedPlugins(path, plugins)) add(modules, id, `${path} changed`);
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
    // Text matching needs a known file type and a folder; root files have no reliable reference text.
    const textual = (codeExtensions.has(extname(path)) || path.endsWith(".md")) && path.includes("/");
    const keys = textual ? referenceKeys(path) : [];
    let matched = false;
    // Browser specs are not run here, but adding, removing or changing one must keep the release-gate group manifest
    // (tests-browser/groups.json) complete and correct.
    if (browserSpec.test(path) && tests.has(browserGroupsTest)) { select(browserGroupsTest, `${path} must keep its browser group`); matched = true; }
    for (const [file, source] of tests) {
      if (keys.some((key) => source.includes(key))) { select(file, `references ${path}`); matched = true; }
      if (closures.get(file)?.has(path)) { select(file, `imports or reads ${path}`); matched = true; }
      for (const [glob, pattern] of coverPatterns.get(file) ?? []) if (pattern.test(path)) { select(file, `covers ${glob}`); matched = true; }
    }
    if (matched || path.endsWith(".md")) continue;
    if (!path.includes("/")) notes.push(`No fast test imports, reads or declares the root file ${path}`);
    else if (!textual) notes.push(`No fast test imports, reads or declares ${path} (${extname(path) || "extensionless"} files are not matched by text)`);
    else notes.push(`No fast test references ${path}`);
  }
  // A changed slow suite runs; it is not also reported as left out.
  for (const file of selected.keys()) skipped.delete(file);
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
    modules: sortedEntries(modules),
    fallback,
    notes,
  };
}

/**
 * Why tests select `path`: for each test, the chain its closure follows to the file, the header whose glob matches it,
 * or its own text reference.
 */
export function explainPath(path, { tests, closures, headers }) {
  const lines = [];
  const describe = (closure, file) => closureChain(closure, file).map((step, index) => index ? `${closure.get(step).kind} ${step}` : step).join(" -> ");
  for (const [file, closure] of closures) {
    const reasons = [];
    if (closureChain(closure, path)) reasons.push(describe(closure, path));
    for (const reached of executedFiles(closure)) for (const glob of headers.get(reached) ?? []) if (globPattern(glob).test(path)) reasons.push(`${describe(closure, reached)} declares covers ${glob}`);
    const keys = path.includes("/") && (codeExtensions.has(extname(path)) || path.endsWith(".md")) ? referenceKeys(path) : [];
    if (keys.some((key) => tests.get(file)?.includes(key))) reasons.push(`its text references ${keys.find((key) => tests.get(file).includes(key))}`);
    if (reasons.length) lines.push(`  ${file}`, ...reasons.map((reason) => `      ${reason}`));
  }
  return lines;
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

/** Plugin module IDs and their pluginSelection, from module-tests/*.json. */
function pluginManifests(root) {
  const directory = join(root, "module-tests");
  if (!existsSync(directory)) return {};
  const plugins = {};
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".json"))) {
    try { const manifest = JSON.parse(readFileSync(join(directory, name), "utf8")); if (manifest.pluginSelection) plugins[manifest.module] = manifest.pluginSelection; } catch { /* run-module-tests reports invalid manifests */ }
  }
  return plugins;
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
  if (plan.modules?.length) section("Module gates: verify:module -- fast <id>, plugins required", plan.modules);
  if (plan.skipped.length) section("Not run here: slow or physical-kiosk suites (npm test and verify:kiosk run them)", plan.skipped);
  if (plan.notes.length) console.log(`\n${plan.notes.map((note) => `Note: ${note}`).join("\n")}`);
  if (plan.fallback) console.log("\nNo changed file mapped to a fast test, so the default set runs.");
}

/** The check could not start: a bad option or no usable base. Only this maps to exit code 2, which the pre-push hook lets through. */
export class StartupError extends Error {}
/** Exit 1 means a check failed or something unexpected broke; exit 2 is reserved for a StartupError. */
export const exitCodeFor = (error) => error instanceof StartupError ? 2 : 1;

export async function main(args, root = rootDirectory) {
  const options = { list: false, all: false, allTypecheck: false, concurrency: 2, selection: "full" };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--list") options.list = true;
    else if (key === "--all-typecheck") options.allTypecheck = true;
    else if (key === "--all") options.all = true;
    else if (key === "--base" || key === "--concurrency" || key === "--why" || key === "--selection") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new StartupError(`Missing value for ${key}`);
      if (key === "--base") options.base = value;
      else if (key === "--why") { options.why = value.replaceAll("\\", "/").replace(/^\.\//, ""); options.list = true; }
      else if (key === "--selection") { if (value !== "full" && value !== "text") throw new StartupError("--selection must be full or text"); options.selection = value; }
      else { options.concurrency = Number(value); if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new StartupError("--concurrency must be 1 to 8"); }
    } else throw new StartupError("Usage: node scripts/check-quick.mjs [--base REF] [--list [--why PATH]] [--all | --all-typecheck] [--selection full|text] [--concurrency N]");
  }
  const started = Date.now();
  let base, changes;
  try {
    base = options.base ? { ref: options.base, source: "--base" } : defaultBase(root);
    changes = changedPaths(root, base.ref);
  } catch (error) { throw new StartupError(error instanceof Error ? error.message : String(error), { cause: error }); }
  const tests = discoverFastTests(root);
  // The text selection (private CI, to keep its Actions minutes flat) skips the walk unless --why needs it.
  const walk = options.selection === "full" || options.why;
  const walkStarted = Date.now();
  const graph = walk ? buildTestClosures((path) => { try { return readFileSync(join(root, path), "utf8"); } catch { return undefined; } },
    () => git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) : undefined;
  const walkSeconds = (Date.now() - walkStarted) / 1000;
  const plan = selectQuickChecks({ changes: changes.paths, tests, closures: graph?.closures, covers: graph?.covers, plugins: pluginManifests(root), exists: (path) => existsSync(join(root, path)), allTypecheck: options.allTypecheck, all: options.all, selection: options.selection });
  printPlan(plan, base, changes);
  if (options.selection === "text") console.log("\nText-match selection: no import closures, covers headers or module gates (the local check and pre-push hook use them).");
  else console.log(`\nImport closures of ${graph.closures.size} tests over ${graph.files.size} files took ${walkSeconds.toFixed(2)}s.`);
  if (options.why) {
    const lines = explainPath(options.why, { tests, ...graph });
    console.log(`\nWhy tests select ${options.why}:\n${lines.length ? lines.join("\n") : "  no test imports, reads, declares or references it"}`);
  }
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
  for (const { name } of plan.modules) testRuns.push([`Module gate ${name}`, [join(root, "scripts", "run-module-tests.mjs"), "fast", name]]);
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

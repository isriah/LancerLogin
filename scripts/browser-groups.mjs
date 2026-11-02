// Browser spec groups for the complete release gate. tests-browser/groups.json assigns every spec file to one group:
//
//   core         Core behaviour. Runs plugin-free.
//   plugin       Needs the official Outreach or Carpool plugin; the whole file skips without it. Runs composed only.
//   integration  Core behaviour that changes when plugins exist (module navigation, Settings > Modules and plugin
//                management, module setup, backup and restore, shell and startup), or a Core file with individual
//                plugin-dependent tests. Runs plugin-free with Core and again composed.
//
// `--group <name>` on scripts/run-browser-tests.mjs selects the files to run:
//
//   core         every core and integration file, plugin-free
//   plugin       every plugin file, composed
//   integration  every integration file, composed
//
// tests/browser-groups.test.mjs fails when a spec file is unassigned, a plugin-only file is outside the plugin group,
// or a file with individual plugin-dependent tests is not an integration file.
//
// Each file's `seconds` balances the gate's --part split. Refresh them from the Playwright JSON reports of a gate run on
// CI runners (one report per shard; include every shard of the groups you refresh):
//
//   node scripts/browser-groups.mjs --refresh-seconds <report.json> [<report.json> ...]
//
// A file's seconds become the sum of its tests' first-attempt durations across the reports, so a retry does not count
// twice; files the reports did not run keep theirs. Use CI reports only: a local machine weighs specs differently.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const browserDirectory = "tests-browser";
export const manifestPath = `${browserDirectory}/groups.json`;
export const assignments = Object.freeze(["core", "plugin", "integration"]);
// What each --group runs, and whether it runs with the official plugins composed.
export const browserGroups = Object.freeze({
  core: Object.freeze({ includes: Object.freeze(["core", "integration"]), composed: false }),
  plugin: Object.freeze({ includes: Object.freeze(["plugin"]), composed: true }),
  integration: Object.freeze({ includes: Object.freeze(["integration"]), composed: true }),
});

// A top-level requireOutreachPlugin() or requireCarpoolPlugin() skips the whole file without that plugin.
const wholeFilePluginRequirement = /^require(?:Outreach|Carpool)Plugin\(\);/m;
// An indented requirement, or a per-test skip on a composed flag, skips individual tests only.
const testPluginRequirement = /^[ \t]+(?:require(?:Outreach|Carpool)Plugin\(\);|test\.skip\(!\w+Composed\b)/m;

export function readBrowserGroupManifest(root = rootDirectory) {
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
  if (!manifest || typeof manifest !== "object" || !manifest.specs || typeof manifest.specs !== "object" || Array.isArray(manifest.specs)) throw new Error(`${manifestPath} needs a "specs" object`);
  return manifest;
}

export function discoverBrowserSpecs(root = rootDirectory) {
  return readdirSync(join(root, browserDirectory)).filter((name) => name.endsWith(".spec.ts")).sort();
}

/** How a spec depends on plugins, read from its source: "file" (whole file skips), "tests" (some tests skip) or "none". */
export function pluginDependency(source) {
  if (wholeFilePluginRequirement.test(source)) return "file";
  if (testPluginRequirement.test(source)) return "tests";
  return "none";
}

/** Every problem with the manifest: unassigned or unknown files, invalid groups, and plugin dependencies in the wrong group. */
export function validateBrowserGroups(root = rootDirectory) {
  const problems = [];
  const { specs } = readBrowserGroupManifest(root);
  const files = discoverBrowserSpecs(root);
  for (const file of files) if (!(file in specs)) problems.push(`${file} is not assigned to a browser group in ${manifestPath}`);
  for (const [file, entry] of Object.entries(specs)) {
    if (!files.includes(file)) { problems.push(`${manifestPath} lists ${file}, which is not a spec file in ${browserDirectory}`); continue; }
    if (!entry || !assignments.includes(entry.group)) { problems.push(`${file} has group ${JSON.stringify(entry?.group)}; use ${assignments.join(", ")}`); continue; }
    if (typeof entry.area !== "string" || !entry.area.trim()) problems.push(`${file} needs a feature area`);
    if ("seconds" in entry && !(Number.isFinite(entry.seconds) && entry.seconds > 0)) problems.push(`${file} has seconds ${JSON.stringify(entry.seconds)}; use a positive number or leave it out`);
    const dependency = pluginDependency(readFileSync(join(root, browserDirectory, file), "utf8"));
    if (dependency === "file" && entry.group !== "plugin") problems.push(`${file} skips entirely without a plugin, so it belongs in the plugin group, not ${entry.group}`);
    if (dependency === "tests" && entry.group !== "integration") problems.push(`${file} has plugin-dependent tests and Core tests, so it belongs in the integration group, not ${entry.group}`);
    if (dependency === "none" && entry.group === "plugin") problems.push(`${file} does not require a plugin, so the plugin group would never run it plugin-free; use core or integration`);
  }
  return problems;
}

/** The spec paths, relative to the repository root, that one --group runs. */
export function specsForGroup(group, root = rootDirectory) {
  const definition = browserGroups[group];
  if (!definition) throw new Error(`Unknown browser group ${JSON.stringify(group)}; use ${Object.keys(browserGroups).join(", ")}`);
  const problems = validateBrowserGroups(root);
  if (problems.length) throw new Error(`Browser groups are invalid:\n${problems.join("\n")}`);
  const { specs } = readBrowserGroupManifest(root);
  const selected = Object.keys(specs).filter((file) => definition.includes.includes(specs[file].group)).sort();
  if (!selected.length || selected.some((file) => !existsSync(join(root, browserDirectory, file)))) throw new Error(`Browser group ${group} selects no runnable spec files`);
  return selected.map((file) => `${browserDirectory}/${file}`);
}

// The gate splits each group into parts by whole spec files, balanced by each file's measured `seconds` (one worker,
// recorded in the manifest; a file without a measurement counts as defaultSpecSeconds). Playwright's own --shard splits
// by test count in file order, which left one plugin-free shard five times slower than another.
export const defaultSpecSeconds = 60;

/** Split a group into `parts` lists of spec paths with similar total seconds (longest file first, onto the lightest part). */
export function partitionGroup(group, parts, root = rootDirectory) {
  const files = specsForGroup(group, root);
  if (!Number.isInteger(parts) || parts < 1 || parts > files.length) throw new Error(`Browser group ${group} cannot be split into ${parts} part(s)`);
  const { specs } = readBrowserGroupManifest(root);
  const seconds = (path) => specs[path.slice(browserDirectory.length + 1)].seconds ?? defaultSpecSeconds;
  const buckets = Array.from({ length: parts }, () => ({ seconds: 0, files: [] }));
  for (const file of [...files].sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b))) {
    const lightest = buckets.reduce((best, bucket) => bucket.seconds < best.seconds ? bucket : best);
    lightest.files.push(file); lightest.seconds += seconds(file);
  }
  return buckets.map((bucket) => ({ seconds: bucket.seconds, files: bucket.files.sort() }));
}

/** Parse "i/n" for --part. */
export function parsePart(value) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(value));
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`--part needs the form i/n with 1 <= i <= n, not ${value}`);
  return { part: Number(match[1]), parts: Number(match[2]) };
}

/** Seconds per spec file in one Playwright JSON report: the sum of each test's first-attempt duration. */
export function specSecondsFromReport(report) {
  const milliseconds = new Map();
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const name = basename(String(spec.file ?? file ?? "").replaceAll("\\", "/"));
      milliseconds.set(name, (milliseconds.get(name) ?? 0) + (test.results?.[0]?.duration ?? 0));
    }
    for (const child of suite.suites ?? []) walk(child, child.file ?? file);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  return new Map([...milliseconds].map(([file, ms]) => [file, ms / 1000]));
}

/**
 * Replace each reported file's `seconds` in groups.json with its measured time, rounded up to whole seconds. A file in
 * several reports (an integration file runs in a Core part and again composed) takes the largest. Keeps the file's line
 * endings. Returns the changed files.
 */
export function refreshSpecSeconds(reports, root = rootDirectory) {
  const measured = new Map();
  for (const report of reports) for (const [file, seconds] of specSecondsFromReport(report)) measured.set(file, Math.max(measured.get(file) ?? 0, seconds));
  const path = join(root, manifestPath);
  const raw = readFileSync(path, "utf8");
  const manifest = readBrowserGroupManifest(root);
  const changes = [];
  for (const [file, seconds] of [...measured].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = manifest.specs[file];
    if (!entry || seconds <= 0) continue;
    const next = Math.max(1, Math.ceil(seconds));
    if (entry.seconds !== next) { changes.push({ file, from: entry.seconds, to: next }); entry.seconds = next; }
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  if (changes.length) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`.replaceAll("\n", eol));
  return changes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [option, ...paths] = process.argv.slice(2);
  if (option !== "--refresh-seconds" || !paths.length) {
    console.error("Usage: node scripts/browser-groups.mjs --refresh-seconds <playwright-report.json> [...]");
    process.exit(2);
  }
  const changes = refreshSpecSeconds(paths.map((path) => JSON.parse(readFileSync(path, "utf8"))));
  for (const { file, from, to } of changes) console.log(`${file}: ${from ?? "-"} -> ${to}`);
  console.log(changes.length ? `Updated ${changes.length} file(s) in ${manifestPath}.` : `${manifestPath} already matches the reports.`);
}

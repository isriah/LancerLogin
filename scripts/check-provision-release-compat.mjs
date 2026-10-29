import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// Confirms that every official release the installation workflow can select contains the files the workflow runs from it.
// It also checks the other direction. Installation and update workflows published with earlier releases keep running in
// adopters' private repositories and resolve "latest stable" to this release. Each must either compose plugins itself or
// reach this release's composition guard (the dashboard prebuild) before any D1 migration.
export const officialRepository = "isriah/LancerLogin";
const workflowPath = ".github/workflows/provision-template.yml";
const upgradeWorkflowPath = ".github/workflows/upgrade-web.yml";
const sourceDirectory = "lancerlogin-source";

function workflowSteps(workflow) {
  const steps = workflow.split(/\r?\n(?= {6}- )/);
  return steps.slice(1);
}

/** fromStep limits the requirements to the steps from that index on (used for steps after D1 migrations). */
export function provisionReleaseRequirements(workflow, { fromStep = 0 } = {}) {
  const sourceIsDefault = new RegExp(`^ {4}defaults:\\s+run:\\s+working-directory: ${sourceDirectory}\\s*$`, "m").test(workflow);
  const required = new Set();
  const guarded = new Set();
  for (const step of workflowSteps(workflow).slice(fromStep)) {
    const cache = step.match(new RegExp(`cache-dependency-path: ${sourceDirectory}/(\\S+)`));
    if (cache) required.add(cache[1]);
    const directory = step.match(/^\s+working-directory: (\S+)\s*$/m)?.[1];
    const runsInSource = directory ? directory === sourceDirectory : sourceIsDefault;
    if (!runsInSource || !/^\s+run:/m.test(step)) continue;
    for (const [, path] of step.matchAll(/\bnode (scripts\/[\w./-]+\.mjs)\b/g)) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\[ -f ${escaped} \\]`).test(step)) guarded.add(path);
      else required.add(path);
    }
  }
  if (required.size) required.add("package.json");
  return { required: [...required].sort(), guarded: [...guarded].filter((path) => !required.has(path)).sort() };
}

export function missingReleaseFiles(requirements, releaseFiles) {
  const files = releaseFiles instanceof Set ? releaseFiles : new Set(releaseFiles);
  return requirements.required.filter((path) => !files.has(path));
}

const dashboardWorkspaceBuild = /\bnpm (?:--workspace @lancerlogin\/dashboard run build|run build)\b/;
const migrationApply = /\bd1 migrations apply\b/;

/**
 * Problems an installation workflow published with an earlier release has when it builds this release; empty when none.
 * guardInstalled: this release's dashboard build refuses a CI build without composition.
 * hasFile: whether this release contains a path.
 */
export function archivedProvisionProblems(workflow, { guardInstalled, hasFile }) {
  const steps = workflowSteps(workflow);
  const migrationIndex = steps.findIndex((step) => migrationApply.test(step));
  if (migrationIndex < 0) return [];
  const before = steps.slice(0, migrationIndex);
  const problems = [];
  const composes = before.some((step) => /\bnode scripts\/compose-modules\.mjs\b/.test(step));
  const guardedBuild = guardInstalled && before.some((step) => dashboardWorkspaceBuild.test(step));
  if (!composes && !guardedBuild) problems.push("builds without plugin composition and reaches D1 migrations without the composition guard");
  // A file the workflow runs only after migrations, and that this release lacks, would stop it halfway.
  const missing = provisionReleaseRequirements(workflow, { fromStep: migrationIndex + 1 }).required.filter((path) => path !== "package.json" && !hasFile(path));
  if (missing.length) problems.push(`runs ${missing.join(", ")} after D1 migrations, which this release lacks`);
  return problems;
}

/**
 * Problems an update workflow published with an earlier release has when it updates to this release; empty when none.
 * One that runs this release's own runner (lancerlogin-source/scripts/run-web-upgrade.mjs) composes before claim. One
 * that runs the controller's copy of an older runner must build the dashboard through the workspace build, and so reach
 * the composition guard, before it migrates.
 */
export function archivedUpgradeProblems(workflow, controllerRunner, { guardInstalled }) {
  if (/node lancerlogin-source\/scripts\/run-web-upgrade\.mjs\s*$/m.test(workflow)) return [];
  if (!/node deployment-control\/scripts\/run-web-upgrade\.mjs\s*$/m.test(workflow)) return [];
  if (controllerRunner === undefined) return ["runs a controller copy of the update runner that could not be read"];
  const buildsDashboard = /"--workspace", "@lancerlogin\/dashboard", "run", "build"/.test(controllerRunner);
  const build = controllerRunner.indexOf("io.build("); const migrate = controllerRunner.indexOf("io.migrate(");
  if (!(guardInstalled && buildsDashboard && build >= 0 && migrate > build)) return ["runs an older controller update runner that reaches D1 migrations without the composition guard"];
  return [];
}

/** Whether this checkout's dashboard build refuses a CI build that did not compose plugins. */
export async function compositionGuardInstalled(root = ".") {
  try {
    const dashboard = JSON.parse(await readFile(`${root}/apps/dashboard/package.json`, "utf8"));
    return /scripts\/check-module-composition\.mjs/.test(dashboard.scripts?.prebuild ?? "") && existsSync(`${root}/scripts/check-module-composition.mjs`);
  } catch { return false; }
}

async function github(path, token, { raw = false, optional = false } = {}) {
  const response = await fetch(`https://api.github.com/${path}`, { headers: { Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (optional && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub request failed for ${path}: HTTP ${response.status}`);
  return raw ? response.text() : response.json();
}

/** The installation workflow installs only the latest stable release. */
export async function selectableReleases(token) {
  const latest = await github(`repos/${officialRepository}/releases/latest`, token);
  return [latest.tag_name];
}

/** Every published (non-draft) official release. */
export async function publishedReleases(token) {
  const tags = [];
  for (let page = 1; page <= 10; page++) {
    const releases = await github(`repos/${officialRepository}/releases?per_page=100&page=${page}`, token);
    tags.push(...releases.filter((release) => release.draft === false).map((release) => release.tag_name));
    if (releases.length < 100) break;
  }
  return tags;
}

export async function releaseFiles(tag, token) {
  const commit = await github(`repos/${officialRepository}/commits/${encodeURIComponent(tag)}`, token);
  const tree = await github(`repos/${officialRepository}/git/trees/${commit.commit.tree.sha}?recursive=1`, token);
  if (tree.truncated) throw new Error(`The file list for ${tag} is truncated.`);
  return new Set(tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
}

/** Checks every archived installation and update workflow against this checkout, the release candidate. */
export async function archivedWorkflowFailures(token) {
  const guardInstalled = await compositionGuardInstalled();
  const hasFile = (path) => existsSync(path);
  const failures = [];
  for (const tag of await publishedReleases(token)) {
    const ref = encodeURIComponent(tag);
    const provision = await github(`repos/${officialRepository}/contents/${workflowPath}?ref=${ref}`, token, { raw: true, optional: true });
    if (provision) for (const problem of archivedProvisionProblems(provision, { guardInstalled, hasFile })) failures.push(`${tag} ${workflowPath} ${problem}`);
    const upgrade = await github(`repos/${officialRepository}/contents/${upgradeWorkflowPath}?ref=${ref}`, token, { raw: true, optional: true });
    if (!upgrade) continue;
    const controllerRunner = /node deployment-control\/scripts\/run-web-upgrade\.mjs\s*$/m.test(upgrade)
      ? await github(`repos/${officialRepository}/contents/scripts/run-web-upgrade.mjs?ref=${ref}`, token, { raw: true, optional: true }) : "";
    for (const problem of archivedUpgradeProblems(upgrade, controllerRunner, { guardInstalled })) failures.push(`${tag} ${upgradeWorkflowPath} ${problem}`);
  }
  return failures;
}

async function main() {
  const requirements = provisionReleaseRequirements(await readFile(workflowPath, "utf8"));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const failures = [];
  for (const tag of await selectableReleases(token)) {
    const missing = missingReleaseFiles(requirements, await releaseFiles(tag, token));
    if (missing.length) failures.push(`${tag} lacks ${missing.join(", ")}`);
    else console.log(`${tag} contains every file the installation workflow runs.`);
  }
  if (requirements.guarded.length) console.log(`Optional when present: ${requirements.guarded.join(", ")}.`);
  const archived = await archivedWorkflowFailures(token);
  if (archived.length) failures.push(...archived);
  else console.log("Every installation and update workflow published with an earlier release composes plugins or reaches this release's composition guard before D1 migrations.");
  if (failures.length) {
    console.error(`Installation or update workflows would fail or deploy unsafely:\n${failures.join("\n")}\nGuard a step with [ -f <path> ], stop selecting that release, or keep this release's composition guard in the dashboard build.`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("check-provision-release-compat.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

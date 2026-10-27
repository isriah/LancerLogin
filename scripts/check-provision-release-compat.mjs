import { readFile } from "node:fs/promises";

// Confirms that every official release the installation workflow can select contains the files the workflow runs from it.
export const officialRepository = "isriah/LancerLogin";
const workflowPath = ".github/workflows/provision-template.yml";
const sourceDirectory = "lancerlogin-source";

function workflowSteps(workflow) {
  const steps = workflow.split(/\r?\n(?= {6}- )/);
  return steps.slice(1);
}

export function provisionReleaseRequirements(workflow) {
  const templateRelease = workflow.match(/^\s+TEMPLATE_RELEASE:\s*(v\d+\.\d+\.\d+)\s*$/m)?.[1];
  const sourceIsDefault = new RegExp(`^ {4}defaults:\\s+run:\\s+working-directory: ${sourceDirectory}\\s*$`, "m").test(workflow);
  const required = new Set();
  const guarded = new Set();
  for (const step of workflowSteps(workflow)) {
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
  return { templateRelease, required: [...required].sort(), guarded: [...guarded].filter((path) => !required.has(path)).sort() };
}

export function missingReleaseFiles(requirements, releaseFiles) {
  const files = releaseFiles instanceof Set ? releaseFiles : new Set(releaseFiles);
  return requirements.required.filter((path) => !files.has(path));
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com/${path}`, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub request failed for ${path}: HTTP ${response.status}`);
  return response.json();
}

export async function selectableReleases(requirements, token) {
  if (!requirements.templateRelease) throw new Error("The installation workflow has no pinned TEMPLATE_RELEASE.");
  const latest = await github(`repos/${officialRepository}/releases/latest`, token);
  return [...new Set([latest.tag_name, requirements.templateRelease])];
}

export async function releaseFiles(tag, token) {
  const commit = await github(`repos/${officialRepository}/commits/${encodeURIComponent(tag)}`, token);
  const tree = await github(`repos/${officialRepository}/git/trees/${commit.commit.tree.sha}?recursive=1`, token);
  if (tree.truncated) throw new Error(`The file list for ${tag} is truncated.`);
  return new Set(tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
}

async function main() {
  const requirements = provisionReleaseRequirements(await readFile(workflowPath, "utf8"));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const failures = [];
  for (const tag of await selectableReleases(requirements, token)) {
    const missing = missingReleaseFiles(requirements, await releaseFiles(tag, token));
    if (missing.length) failures.push(`${tag} lacks ${missing.join(", ")}`);
    else console.log(`${tag} contains every file the installation workflow runs.`);
  }
  if (requirements.guarded.length) console.log(`Optional when present: ${requirements.guarded.join(", ")}.`);
  if (failures.length) {
    console.error(`The installation workflow runs files that a selectable release does not contain:\n${failures.join("\n")}\nGuard the step with [ -f <path> ] or stop selecting that release.`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("check-provision-release-compat.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

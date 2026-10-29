// Documentation-only scope for the Verify workflow (.github/workflows/ci.yml, "Select verification scope").
//
// A pull request or push whose every changed path is under docs/ or docs-site/ is a documentation-only change: Verify
// still reports its required jobs, but the verify job runs only the documentation checks selected here instead of the
// application install, typecheck, tests and build. Any other path, a new branch, an unreadable diff, a release commit,
// a manual dispatch or a scheduled run is never documentation-only.
//
//   node scripts/ci-scope.mjs --event push --base <before> --head <after> [--head-message <text>]
//   node scripts/ci-scope.mjs --event pull_request --base <base sha> --head <head sha>
//
// Prints GitHub step outputs (docs, docs-tests, docs-install, docs-reason), one per line.
// Uses only Node built-ins so it runs before npm ci.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deviceTests, referenceKeys } from "./check-quick.mjs";
import { isolatedGitEnv } from "./git-env.mjs";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zeroSha = "0000000000000000000000000000000000000000";
// docs/releases/ counts: a release's notes are read from its own tagged commit, so a later correction on the branch
// cannot change a published release, and a new release's notes arrive in a "Release v..." commit, which is never
// documentation-only.
export const documentationPath = /^(?:docs|docs-site)\/[^/]/;
// Always run: it covers every public docs-site page, its links and its assets, and needs no dependencies.
export const docsSiteTest = "tests/docs-site.test.mjs";

/**
 * Decide whether a change is documentation-only.
 * @param {object} input
 * @param {string} input.event GitHub event name
 * @param {string[] | null} input.files changed paths, or null when the diff could not be read
 * @param {string} [input.headMessage] head commit message of a push
 */
export function classifyChange({ event, files, headMessage = "" }) {
  if (event !== "push" && event !== "pull_request") return { docs: false, reason: `${event || "unknown"} event runs complete verification` };
  if (event === "push" && /^Release v/.test(headMessage)) return { docs: false, reason: "release commit" };
  if (!files) return { docs: false, reason: "changed files could not be determined" };
  if (!files.length) return { docs: false, reason: "no changed files" };
  const other = files.filter((path) => !documentationPath.test(path));
  if (other.length) return { docs: false, reason: `${other.length} changed path(s) outside docs/ and docs-site/, first ${other[0]}` };
  return { docs: true, reason: `${files.length} documentation file(s) changed` };
}

/**
 * The Node tests a documentation-only change must pass: the docs-site suite and every fast test that reads a changed
 * documentation file (the same reference rule as scripts/check-quick.mjs). Device-only kiosk suites never run here.
 * @param {string[]} files changed documentation paths
 * @param {Map<string, string>} tests test path to source text
 */
export function selectDocsTests(files, tests) {
  const selected = new Set([docsSiteTest]);
  for (const path of files) {
    const keys = referenceKeys(path);
    for (const [file, source] of tests) if (!deviceTests.has(file) && keys.some((key) => source.includes(key))) selected.add(file);
  }
  const list = [...selected].sort();
  // Only the docs-site suite is known to need no installed dependencies.
  return { tests: list, install: list.some((file) => file !== docsSiteTest) };
}

export function discoverNodeTests(root = rootDirectory) {
  const tests = new Map();
  const directory = join(root, "tests");
  if (!existsSync(directory)) return tests;
  for (const name of readdirSync(directory)) if (name.endsWith(".test.mjs")) tests.set(`tests/${name}`, readFileSync(join(directory, name), "utf8"));
  return tests;
}

// Pull requests compare with the merge base, so base-branch commits the pull request does not contain are not counted.
// Renames are split into a deletion and an addition so moving a file into docs/ still names its old path.
export function changedFiles({ event, base, head, root = rootDirectory }) {
  if (!base || !head || base === zeroSha) return null;
  const range = event === "pull_request" ? `${base}...${head}` : `${base}..${head}`;
  try {
    const output = execFileSync("git", ["-C", root, "diff", "--name-only", "--no-renames", "-z", range], {
      encoding: "utf8", windowsHide: true, env: isolatedGitEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
    return output.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--event", "--base", "--head", "--head-message"].includes(flag) || index + 1 >= argv.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[flag.slice(2)] = argv[index += 1];
  }
  return options;
}

export function scopeOutputs(options, root = rootDirectory) {
  const event = options.event ?? "";
  const files = event === "push" || event === "pull_request" ? changedFiles({ event, base: options.base, head: options.head, root }) : null;
  const decision = classifyChange({ event, files, headMessage: options["head-message"] ?? "" });
  const selection = decision.docs ? selectDocsTests(files, discoverNodeTests(root)) : { tests: [], install: false };
  return { docs: decision.docs, reason: decision.reason, tests: selection.tests, install: selection.install };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = scopeOutputs(parseArguments(process.argv.slice(2)));
    // A changed path may contain any character; keep each output on one line.
    const line = (value) => String(value).replace(/[^\x20-\x7e]/g, "?");
    process.stdout.write(`docs=${result.docs}\ndocs-tests=${line(result.tests.join(" "))}\ndocs-install=${result.install}\ndocs-reason=${line(result.reason)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

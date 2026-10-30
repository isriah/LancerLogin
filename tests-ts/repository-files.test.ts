import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { gitBlobSha, latestRefreshRun, officialRepository, proposeRepositoryFiles, repositoryFilePaths, repositoryFilesStatus, syncBranch, type GitHubCall } from "../apps/api/src/repository-files.ts";
import { WebUpdateError } from "../apps/api/src/web-updates.ts";

const repo = "example/private-install";
const blobSha = (text: string) => { const bytes = Buffer.from(text, "utf8"); return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest("hex"); };
const permission = () => new WebUpdateError(503, "credential_permission", "The deployment credential is missing a required repository permission.");
const fail = (status: number, code: string, message: string): never => { throw new WebUpdateError(status, code, message); };

/** Static and workflow-run reachability, so the fixed list never drifts from what the workflows run from the repository. */
test("the fixed file list is exactly the adopter workflows and every script they run from the repository checkout", () => {
  const workflows = [".github/workflows/provision-template.yml", ".github/workflows/refresh-web-update-credential.yml", ".github/workflows/upgrade-web.yml"];
  const roots = new Set<string>();
  for (const workflow of workflows) {
    const text = readFileSync(workflow, "utf8");
    // Scripts run from the repository checkout: deployment-control/ in upgrade-web.yml, the working directory (fallback) in refresh.
    for (const match of text.matchAll(/node (deployment-control\/)?(scripts\/[a-z0-9-]+\.mjs)/g)) if (match[1] || workflow.includes("refresh-web-update-credential")) roots.add(match[2]!);
  }
  assert.deepEqual([...roots].sort(), ["scripts/refresh-web-update-credential.mjs", "scripts/run-web-upgrade.mjs"]);
  const seen = new Set<string>(); const stack = [...roots];
  while (stack.length) {
    const file = normalize(stack.pop()!).replaceAll("\\", "/");
    if (seen.has(file)) continue; seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const path = join(dirname(file), match[1]!); if (existsSync(path)) stack.push(path);
    }
  }
  assert.deepEqual([...repositoryFilePaths].sort(), [...workflows, ...seen].sort());
  for (const path of repositoryFilePaths) assert.doesNotMatch(path, /lancerlogin\.|secret|\.env/i, "installation-owned files and secrets are never synced");
});

test("git blob SHAs match git's own object IDs", async () => {
  assert.equal(await gitBlobSha(new TextEncoder().encode("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

type Route = (init?: RequestInit) => Response | Promise<Response>;
/** A GitHub stand-in: listings for main and the release tag, plus explicit routes. Records every call. */
function github(options: { installed?: Record<string, string>; release?: Record<string, string>; routes?: Record<string, Route> } = {}) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const release = options.release ?? Object.fromEntries(repositoryFilePaths.map((path) => [path, `release ${path}\n`]));
  const installed = options.installed ?? { ...release };
  const listing = (files: Record<string, string>, directory: string) => Object.entries(files).filter(([path]) => path.slice(0, path.lastIndexOf("/")) === directory).map(([path, text]) => ({ type: "file", path, name: path.split("/").at(-1), sha: blobSha(text) }));
  const call: GitHubCall = async (path, init) => {
    calls.push({ path, init });
    for (const [pattern, route] of Object.entries(options.routes ?? {})) if (path === pattern || path.startsWith(`${pattern}?`)) return route(init);
    const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=(.+)$/.exec(path);
    if (contents) return Response.json(listing(contents[1] === officialRepository ? release : installed, contents[2]!));
    const blob = /^\/repos\/isriah\/LancerLogin\/git\/blobs\/([0-9a-f]{40})$/.exec(path);
    if (blob) { const text = Object.values(release).find((value) => blobSha(value) === blob[1]); return text === undefined ? new Response(null, { status: 404 }) : Response.json({ encoding: "base64", content: Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n") }); }
    return new Response(null, { status: 404 });
  };
  return { call, calls };
}

test("repository file status compares the fixed files on main with the installed release tag", async () => {
  const current = github();
  assert.deepEqual(await repositoryFilesStatus(current.call, repo, "2.0.1"), { state: "current", release: "v2.0.1", outdated: [], pullRequest: null });
  assert.ok(current.calls.every((call) => call.path.endsWith("?ref=main") ? call.path.startsWith(`/repos/${repo}/contents/`) : call.path.startsWith(`/repos/${officialRepository}/contents/`) && call.path.endsWith("?ref=v2.0.1")));
  assert.equal(current.calls.length, 6, "one listing per directory in each repository");

  const releaseFiles = Object.fromEntries(repositoryFilePaths.map((path) => [path, `release ${path}\n`]));
  const older = { ...releaseFiles, ".github/workflows/refresh-web-update-credential.yml": "old\n" } as Record<string, string>;
  delete older["scripts/workflow-annotations.mjs"];
  const outdated = github({ installed: older, routes: { [`/repos/${repo}/pulls`]: () => Response.json([{ number: 7 }]) } });
  assert.deepEqual(await repositoryFilesStatus(outdated.call, repo, "2.0.1"), { state: "outdated", release: "v2.0.1", outdated: [".github/workflows/refresh-web-update-credential.yml", "scripts/workflow-annotations.mjs"], pullRequest: { number: 7, url: `https://github.com/${repo}/pull/7` } });
  assert.ok(outdated.calls.some((call) => call.path === `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`example:${syncBranch("v2.0.1")}`)}&per_page=1`));

  // A file the release lacks is never proposed, even when the repository still has it.
  const { "scripts/prepare-pages-proxy.mjs": _skipped, ...releaseWithout } = releaseFiles;
  assert.equal((await repositoryFilesStatus(github({ release: releaseWithout, installed: releaseFiles }).call, repo, "2.0.1")).state, "current");

  const released = github(); const denied: GitHubCall = async (path, init) => { if (path.includes(repo)) throw permission(); return released.call(path, init); };
  assert.equal((await repositoryFilesStatus(denied, repo, "2.0.1")).state, "permission_required");
  assert.equal((await repositoryFilesStatus(async () => new Response(null, { status: 500 }), repo, "2.0.1")).state, "unknown");
  const development = github();
  assert.deepEqual(await repositoryFilesStatus(development.call, repo, "development"), { state: "unknown", release: null, outdated: [], pullRequest: null });
  assert.equal(development.calls.length, 0);
});

const runs = (run: object | undefined) => () => Response.json({ workflow_runs: run ? [run] : [] });
test("the latest credential refresh run reports its failure code from the job's error annotation", async () => {
  const runsPath = `/repos/${repo}/actions/workflows/refresh-web-update-credential.yml/runs`;
  const jobs = () => Response.json({ jobs: [{ id: 99, conclusion: "failure", steps: [{ name: "npm ci", conclusion: "success" }, { name: "Verify and upload only the fixed Worker dispatch and plugin selection credentials", conclusion: "failure" }] }] });
  const run = { id: 41, status: "completed", conclusion: "failure", updated_at: "2026-10-28T10:00:00Z" };
  const runUrl = `https://github.com/${repo}/actions/runs/41`;
  const annotated = (annotations: object[]) => github({ routes: { [runsPath]: runs(run), [`/repos/${repo}/actions/runs/41/jobs`]: jobs, [`/repos/${repo}/check-runs/99/annotations`]: () => Response.json(annotations) } });

  assert.deepEqual(await latestRefreshRun(annotated([{ annotation_level: "warning", title: "installed_release_unresolved" }, { annotation_level: "failure", title: "dispatch_credential_access_denied", message: "..." }, { annotation_level: "failure", title: "", message: "Process completed with exit code 1." }]).call, repo),
    { state: "failed", runUrl, finishedAt: "2026-10-28T10:00:00.000Z", code: "dispatch_credential_access_denied", reason: "coded", failedStep: "Verify and upload only the fixed Worker dispatch and plugin selection credentials" });
  // Earlier scripts print only a generic failure: no coded annotation, or the generic fallback code.
  for (const annotations of [[{ annotation_level: "failure", title: "", message: "Process completed with exit code 1." }], [{ annotation_level: "failure", title: "credential_refresh_failed", message: "Credential refresh stopped." }]]) {
    const result = await latestRefreshRun(annotated(annotations).call, repo);
    assert.equal(result.reason, "unexplained"); assert.equal(result.code, null); assert.equal(result.state, "failed");
  }
  // Without Checks: Read-only the annotations are refused; the failed step is still reported.
  const unreadable = await latestRefreshRun(github({ routes: { [runsPath]: runs(run), [`/repos/${repo}/actions/runs/41/jobs`]: jobs, [`/repos/${repo}/check-runs/99/annotations`]: () => { throw permission(); } } }).call, repo);
  assert.equal(unreadable.reason, "unreadable"); assert.match(unreadable.failedStep ?? "", /Verify and upload/);

  assert.deepEqual(await latestRefreshRun(github({ routes: { [runsPath]: runs(undefined) } }).call, repo), { state: "none", runUrl: null, finishedAt: null, code: null, reason: null, failedStep: null });
  assert.equal((await latestRefreshRun(github({ routes: { [runsPath]: runs({ id: 42, status: "in_progress" }) } }).call, repo)).state, "running");
  const succeeded = github({ routes: { [runsPath]: runs({ id: 43, status: "completed", conclusion: "success", updated_at: "2026-10-28T11:00:00Z" }) } });
  assert.deepEqual(await latestRefreshRun(succeeded.call, repo), { state: "succeeded", runUrl: `https://github.com/${repo}/actions/runs/43`, finishedAt: "2026-10-28T11:00:00.000Z", code: null, reason: null, failedStep: null });
  assert.equal(succeeded.calls.length, 1, "a success needs no job or annotation reads");
  assert.equal((await latestRefreshRun(github({ routes: { [runsPath]: runs({ id: 44, status: "completed", conclusion: "cancelled" }) } }).call, repo)).code, "run_cancelled");
  assert.equal((await latestRefreshRun(github({ routes: { [runsPath]: runs({ id: "44", status: "completed", conclusion: "failure" }) } }).call, repo)).state, "unknown");
  assert.equal((await latestRefreshRun(async () => { throw new WebUpdateError(503, "provider_unavailable", "down"); }, repo)).state, "unknown");
});

const outdatedFiles = () => {
  const release = Object.fromEntries(repositoryFilePaths.map((path) => [path, `release ${path}\n`]));
  return { release, installed: { ...release, ".github/workflows/upgrade-web.yml": "old controller\n", "scripts/run-web-upgrade.mjs": "old runner\n" } };
};
const mainSha = "a".repeat(40); const treeSha = "b".repeat(40); const newTree = "c".repeat(40); const newCommit = "d".repeat(40);
const writeRoutes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
  [`/repos/${repo}/pulls`]: (init) => init?.method === "POST" ? Response.json({ number: 12 }, { status: 201 }) : Response.json([]),
  [`/repos/${repo}/git/ref/heads/main`]: () => Response.json({ object: { sha: mainSha } }),
  [`/repos/${repo}/git/commits/${mainSha}`]: () => Response.json({ tree: { sha: treeSha } }),
  [`/repos/${repo}/git/trees`]: () => Response.json({ sha: newTree }, { status: 201 }),
  [`/repos/${repo}/git/commits`]: () => Response.json({ sha: newCommit }, { status: 201 }),
  [`/repos/${repo}/git/refs`]: () => Response.json({ ref: "refs/heads/x" }, { status: 201 }),
  ...overrides,
});
const body = (init?: RequestInit) => JSON.parse(String(init?.body));

test("Update repository files opens one pull request with the release's exact files and never merges", async () => {
  const fixture = outdatedFiles(); const mock = github({ ...fixture, routes: writeRoutes() });
  const result = await proposeRepositoryFiles(mock.call, fail, repo, "2.0.1");
  assert.deepEqual(result, { pullRequest: { number: 12, url: `https://github.com/${repo}/pull/12` }, created: true, release: "v2.0.1", files: [".github/workflows/upgrade-web.yml", "scripts/run-web-upgrade.mjs"] });
  const tree = body(mock.calls.find((call) => call.path === `/repos/${repo}/git/trees`)!.init);
  assert.equal(tree.base_tree, treeSha);
  assert.deepEqual(tree.tree, [".github/workflows/upgrade-web.yml", "scripts/run-web-upgrade.mjs"].map((path) => ({ path, mode: "100644", type: "blob", content: fixture.release[path] })));
  assert.deepEqual(body(mock.calls.find((call) => call.path === `/repos/${repo}/git/commits` && call.init?.method === "POST")!.init), { message: "Update LancerLogin workflow files to v2.0.1", tree: newTree, parents: [mainSha] });
  assert.deepEqual(body(mock.calls.find((call) => call.path === `/repos/${repo}/git/refs`)!.init), { ref: "refs/heads/lancerlogin/update-files-2.0.1", sha: newCommit });
  const pull = body(mock.calls.find((call) => call.path === `/repos/${repo}/pulls` && call.init?.method === "POST")!.init);
  assert.equal(pull.head, "lancerlogin/update-files-2.0.1"); assert.equal(pull.base, "main"); assert.match(pull.body, /lancerlogin\.modules\.json, other installation files and secrets are not changed/);
  // Writes go only to the deployment repository; the official repository is only read. Nothing merges or touches main.
  for (const call of mock.calls.filter((item) => item.init?.method)) assert.ok(call.path.startsWith(`/repos/${repo}/`), call.path);
  assert.ok(!mock.calls.some((call) => /\/merge|heads\/main$/.test(call.path) && call.init?.method));
  assert.ok(!mock.calls.some((call) => /lancerlogin\.(modules|plugin-sources)\.json/.test(call.path)));
  assert.ok(tree.tree.every((entry: { path: string }) => repositoryFilePaths.includes(entry.path)));
});

test("Update repository files returns an open pull request, reuses its branch and refuses when nothing is outdated", async () => {
  const open = github({ ...outdatedFiles(), routes: writeRoutes({ [`/repos/${repo}/pulls`]: () => Response.json([{ number: 5 }]) }) });
  assert.deepEqual((await proposeRepositoryFiles(open.call, fail, repo, "2.0.1")).pullRequest, { number: 5, url: `https://github.com/${repo}/pull/5` });
  assert.ok(!open.calls.some((call) => call.init?.method), "an open pull request is returned without writing");

  const existingBranch = github({ ...outdatedFiles(), routes: writeRoutes({
    [`/repos/${repo}/git/refs`]: () => Response.json({ message: "Reference already exists" }, { status: 422 }),
    [`/repos/${repo}/git/refs/heads/lancerlogin/update-files-2.0.1`]: () => Response.json({}),
  }) });
  assert.equal((await proposeRepositoryFiles(existingBranch.call, fail, repo, "2.0.1")).created, true);
  const update = existingBranch.calls.find((call) => call.path.endsWith("/git/refs/heads/lancerlogin/update-files-2.0.1"))!;
  assert.equal(update.init?.method, "PATCH"); assert.deepEqual(body(update.init), { sha: newCommit, force: true });

  await assert.rejects(proposeRepositoryFiles(github({ routes: writeRoutes() }).call, fail, repo, "2.0.1"), { code: "repository_files_current" });
  await assert.rejects(proposeRepositoryFiles(github().call, fail, repo, "development"), { code: "release_unavailable" });
  // A release file whose content does not match its listed blob is never written.
  const fixture = outdatedFiles();
  const tampered = github({ ...fixture, routes: writeRoutes({ [`/repos/${officialRepository}/git/blobs/${blobSha(fixture.release[".github/workflows/upgrade-web.yml"]!)}`]: () => Response.json({ encoding: "base64", content: Buffer.from("tampered\n").toString("base64") }) }) });
  await assert.rejects(proposeRepositoryFiles(tampered.call, fail, repo, "2.0.1"), { code: "provider_unavailable" });
  assert.ok(!tampered.calls.some((call) => call.init?.method));
});

test("a missing token permission is named: Contents, Pull requests or Workflows", async () => {
  const cases: Array<[string, Record<string, Route>]> = [
    ["repository_files_pull_requests_permission", { [`/repos/${repo}/pulls`]: () => { throw permission(); } }],
    ["repository_files_contents_permission", { [`/repos/${repo}/git/trees`]: () => new Response(null, { status: 403 }) }],
    ["repository_files_contents_permission", { [`/repos/${repo}/git/ref/heads/main`]: () => { throw permission(); } }],
    ["repository_files_workflows_permission", { [`/repos/${repo}/git/refs`]: () => Response.json({ message: "refusing to allow a Personal Access Token to create or update workflow `.github/workflows/upgrade-web.yml` without `workflows` permission" }, { status: 422 }) }],
    ["repository_files_workflows_permission", { [`/repos/${repo}/git/refs`]: () => new Response(null, { status: 404 }) }],
    ["repository_files_pull_requests_permission", { [`/repos/${repo}/pulls`]: (init) => init?.method === "POST" ? new Response(null, { status: 403 }) : Response.json([]) }],
  ];
  for (const [code, routes] of cases) await assert.rejects(proposeRepositoryFiles(github({ ...outdatedFiles(), routes: writeRoutes(routes) }).call, fail, repo, "2.0.1"), { code, status: 403 }, code);
  // Reading the repository's files without Contents access is named too.
  const released = github(); const denied: GitHubCall = async (path, init) => { if (path.includes(repo)) throw permission(); return released.call(path, init); };
  await assert.rejects(proposeRepositoryFiles(denied, fail, repo, "2.0.1"), { code: "repository_files_contents_permission" });
});

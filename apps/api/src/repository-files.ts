/**
 * The deployment repository's own release files. A repository created from the template keeps the workflows and scripts
 * it was created with: web updates deploy a new release but never change the repository. Settings > Updates compares the
 * fixed files below with the installed release and can propose the release's versions in a pull request, which the
 * installer reviews and merges on GitHub. Nothing is ever merged here.
 *
 * Only these release-owned paths are read or written. Installation-owned files (lancerlogin.modules.json,
 * lancerlogin.plugin-sources.json and everything else) and secrets are never touched.
 */
import { parseReleaseVersion } from "../../../packages/shared/src/release-policy.mjs";

export const officialRepository = "isriah/LancerLogin";
export const refreshWorkflow = "refresh-web-update-credential.yml";
/**
 * The adopter workflows and every script they run from the repository checkout, with the scripts' local imports.
 * upgrade-web.yml runs scripts/run-web-upgrade.mjs --validate from the repository before checking out the release, and
 * refresh-web-update-credential.yml falls back to its repository copy when the installed release cannot be resolved.
 * tests-ts/repository-files.test.ts keeps this list equal to what the workflows actually run.
 */
export const repositoryFilePaths: readonly string[] = [
  ".github/workflows/provision-template.yml",
  ".github/workflows/refresh-web-update-credential.yml",
  ".github/workflows/upgrade-web.yml",
  "packages/shared/src/release-policy.mjs",
  "scripts/database-identity.mjs",
  "scripts/ensure-fingerprint-vault-key.mjs",
  "scripts/prepare-cloudflare-provision.mjs",
  "scripts/prepare-pages-proxy.mjs",
  "scripts/refresh-web-update-credential.mjs",
  "scripts/run-web-upgrade.mjs",
  "scripts/workflow-annotations.mjs",
];
const directories = [...new Set(repositoryFilePaths.map((path) => path.slice(0, path.lastIndexOf("/"))))];

/** One GitHub API call with the dashboard update credential. Throws WebUpdateError for 401, 403, 429 and redirects. */
export type GitHubCall = (path: string, init?: RequestInit) => Promise<Response>;
export type Fail = (status: number, code: string, message: string) => never;
export type PullRequestLink = { number: number; url: string };
/**
 * current: the files match the installed release. outdated: at least one differs or is missing. permission_required: the
 * dashboard update credential cannot read the repository's contents. unknown: not checked (no credential, a development
 * build, or GitHub unavailable).
 */
export type RepositoryFiles = { state: "current" | "outdated" | "permission_required" | "unknown"; release: string | null; outdated: string[]; pullRequest: PullRequestLink | null };
/**
 * The latest "Refresh web update credential" run. code is the fixed code from its error annotation (or the run conclusion
 * for a cancelled, timed out or skipped run). reason: coded when the code explains the failure, unexplained when the run
 * failed without one (as earlier scripts do), unreadable when the credential cannot read annotations (Checks: Read-only).
 */
export type RefreshRun = {
  state: "none" | "running" | "succeeded" | "failed" | "unknown"; runUrl: string | null; finishedAt: string | null;
  code: string | null; reason: "coded" | "unexplained" | "unreadable" | null; failedStep: string | null;
};
export type RepositoryFilesProposal = { pullRequest: PullRequestLink; created: boolean; release: string; files: string[] };

const codePattern = /^[a-z][a-z0-9_]{2,80}$/;
const shaPattern = /^[0-9a-f]{40}$/;
/** Codes that only say the refresh stopped, without a cause: earlier scripts and unexpected errors. */
const unexplainedCodes = new Set(["credential_refresh_failed"]);
const permissionDenied = (error: unknown) => (error as { code?: string } | undefined)?.code === "credential_permission";

/** The installed release's tag, or null for a development build. */
export function installedReleaseTag(version: string | undefined): string | null {
  return version && parseReleaseVersion(version) ? `v${version.replace(/^v/, "")}` : null;
}
export const syncBranch = (tag: string) => `lancerlogin/update-files-${tag.replace(/^v/, "")}`;
export const unknownRepositoryFiles = (version?: string): RepositoryFiles => ({ state: "unknown", release: installedReleaseTag(version), outdated: [], pullRequest: null });
export const unknownRefreshRun: RefreshRun = { state: "unknown", runUrl: null, finishedAt: null, code: null, reason: null, failedStep: null };

async function json(response: Response): Promise<unknown> { return response.json().catch(() => undefined); }
const validDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

async function listDirectory(call: GitHubCall, repo: string, directory: string, ref: string): Promise<Array<[string, string]>> {
  const response = await call(`/repos/${repo}/contents/${directory}?ref=${encodeURIComponent(ref)}`);
  if (response.status === 404) return [];
  const entries = response.ok ? await json(response) : undefined;
  if (!Array.isArray(entries)) throw new Error("repository_files_unavailable");
  return entries.flatMap((entry: { type?: unknown; path?: unknown; sha?: unknown }) => entry?.type === "file" && typeof entry.path === "string" && typeof entry.sha === "string" && shaPattern.test(entry.sha) ? [[entry.path, entry.sha] as [string, string]] : []);
}
/** Git blob SHAs of the fixed files at a ref, from one directory listing per directory. */
async function fileShas(call: GitHubCall, repo: string, ref: string): Promise<Map<string, string>> {
  const listed = new Map((await Promise.all(directories.map((directory) => listDirectory(call, repo, directory, ref)))).flat());
  return new Map(repositoryFilePaths.flatMap((path) => listed.has(path) ? [[path, listed.get(path)!] as [string, string]] : []));
}
/** The fixed files whose installed copy differs from, or lacks, the release's version. Files the release lacks are skipped. */
export async function outdatedRepositoryFiles(call: GitHubCall, repo: string, tag: string): Promise<Array<{ path: string; sha: string }>> {
  const [installation, release] = await Promise.all([fileShas(call, repo, "main"), fileShas(call, officialRepository, tag)]);
  if (!release.size) throw new Error("repository_files_unavailable");
  return repositoryFilePaths.flatMap((path) => { const sha = release.get(path); return sha && installation.get(path) !== sha ? [{ path, sha }] : []; });
}
const pullRequestLink = (repo: string, value: unknown): PullRequestLink | null => {
  const number = (value as { number?: unknown } | undefined)?.number;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? { number, url: `https://github.com/${repo}/pull/${number}` } : null;
};
async function openPullRequest(call: GitHubCall, repo: string, branch: string): Promise<PullRequestLink | null> {
  const owner = repo.split("/")[0]!;
  const response = await call(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`);
  if (!response.ok) { if (response.status === 404) throw Object.assign(new Error("credential_permission"), { code: "credential_permission" }); return null; }
  const list = await json(response);
  return Array.isArray(list) ? pullRequestLink(repo, list[0]) : null;
}

/** Settings > Updates: whether the repository's release files match the installed release. Never throws. */
export async function repositoryFilesStatus(call: GitHubCall, repo: string, version: string | undefined): Promise<RepositoryFiles> {
  const release = installedReleaseTag(version);
  if (!release) return unknownRepositoryFiles(version);
  try {
    const outdated = await outdatedRepositoryFiles(call, repo, release);
    if (!outdated.length) return { state: "current", release, outdated: [], pullRequest: null };
    const pullRequest = await openPullRequest(call, repo, syncBranch(release)).catch(() => null);
    return { state: "outdated", release, outdated: outdated.map((file) => file.path), pullRequest };
  } catch (error) {
    return { state: permissionDenied(error) ? "permission_required" : "unknown", release, outdated: [], pullRequest: null };
  }
}

/** The latest run of Refresh web update credential and, for a failure, the fixed code its error annotation names. Never throws. */
export async function latestRefreshRun(call: GitHubCall, repo: string): Promise<RefreshRun> {
  try {
    const response = await call(`/repos/${repo}/actions/workflows/${refreshWorkflow}/runs?per_page=1&exclude_pull_requests=true`);
    if (response.status === 404) return { ...unknownRefreshRun, state: "none" };
    if (!response.ok) return unknownRefreshRun;
    const run = ((await json(response)) as { workflow_runs?: unknown[] } | undefined)?.workflow_runs?.[0] as { id?: unknown; status?: unknown; conclusion?: unknown; updated_at?: unknown } | undefined;
    if (!run) return { ...unknownRefreshRun, state: "none" };
    if (typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id <= 0) return unknownRefreshRun;
    const base = { ...unknownRefreshRun, runUrl: `https://github.com/${repo}/actions/runs/${run.id}` };
    if (run.status !== "completed") return { ...base, state: "running" };
    const finishedAt = validDate(run.updated_at);
    if (run.conclusion === "success") return { ...base, state: "succeeded", finishedAt };
    if (run.conclusion === "cancelled" || run.conclusion === "timed_out" || run.conclusion === "skipped") return { ...base, state: "failed", finishedAt, code: `run_${run.conclusion}`, reason: "coded" };
    const failed = { ...base, state: "failed" as const, finishedAt, reason: "unexplained" as const };
    const jobsResponse = await call(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=20`);
    const jobs = jobsResponse.ok ? ((await json(jobsResponse)) as { jobs?: unknown[] } | undefined)?.jobs : undefined;
    const job = (Array.isArray(jobs) ? jobs : []).find((item) => (item as { conclusion?: unknown })?.conclusion === "failure") as { id?: unknown; steps?: Array<{ name?: unknown; conclusion?: unknown }> } | undefined;
    if (!job || typeof job.id !== "number" || !Number.isSafeInteger(job.id)) return failed;
    const stepName = (Array.isArray(job.steps) ? job.steps : []).find((step) => step?.conclusion === "failure")?.name;
    const failedStep = typeof stepName === "string" && stepName.length <= 200 ? stepName : null;
    let annotations: unknown;
    try {
      const annotationsResponse = await call(`/repos/${repo}/check-runs/${job.id}/annotations?per_page=50`);
      if (annotationsResponse.status === 404) return { ...failed, failedStep, reason: "unreadable" };
      annotations = annotationsResponse.ok ? await json(annotationsResponse) : undefined;
    } catch (error) {
      if (permissionDenied(error)) return { ...failed, failedStep, reason: "unreadable" };
      throw error;
    }
    const code = (Array.isArray(annotations) ? annotations : []).map((item) => item as { annotation_level?: unknown; title?: unknown })
      .find((item) => item.annotation_level === "failure" && typeof item.title === "string" && codePattern.test(item.title))?.title as string | undefined;
    return code && !unexplainedCodes.has(code) ? { ...failed, failedStep, code, reason: "coded" } : { ...failed, failedStep };
  } catch { return unknownRefreshRun; }
}

/** Git's blob SHA-1 for content, so a downloaded release file is used only if it is exactly the listed blob. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const data = new Uint8Array(header.byteLength + bytes.byteLength); data.set(header); data.set(bytes, header.byteLength);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", data))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export type Permission = "contents" | "workflows" | "pull_requests";
export const permissionCodes: Record<Permission, string> = { contents: "repository_files_contents_permission", workflows: "repository_files_workflows_permission", pull_requests: "repository_files_pull_requests_permission" };
const permissionNames: Record<Permission, string> = { contents: "Contents", workflows: "Workflows", pull_requests: "Pull requests" };

/**
 * Creates the branch lancerlogin/update-files-<version> with the installed release's versions of the outdated fixed files
 * and opens a pull request for it, or returns the pull request that is already open. Needs the dashboard update credential
 * to have Contents, Pull requests and Workflows: Read and write; a refusal names the permission to add. Never merges.
 */
export async function proposeRepositoryFiles(call: GitHubCall, fail: Fail, repo: string, version: string | undefined): Promise<RepositoryFilesProposal> {
  const release = installedReleaseTag(version) ?? fail(503, "release_unavailable", "Repository files can only be updated to an installed official release.");
  const missing = (permission: Permission): never => fail(403, permissionCodes[permission], `The dashboard update credential needs ${permissionNames[permission]}: Read and write on ${repo}.`);
  const step = async (permission: Permission, path: string, init?: RequestInit) => {
    let response: Response;
    try { response = await call(path, init); } catch (error) { if (permissionDenied(error)) missing(permission); throw error; }
    if (response.status === 403 || response.status === 404) missing(permission);
    return response;
  };
  const unavailable = (): never => fail(503, "provider_unavailable", "GitHub did not complete the repository file update. Nothing was merged; try again later.");
  const post = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });

  let outdated: Array<{ path: string; sha: string }>;
  try { outdated = await outdatedRepositoryFiles(call, repo, release); }
  catch (error) { if (permissionDenied(error)) missing("contents"); if ((error as Error).message === "repository_files_unavailable") unavailable(); throw error; }
  if (!outdated.length) fail(409, "repository_files_current", `The repository's workflow files already match ${release}.`);
  const files = outdated.map((file) => file.path);
  const branch = syncBranch(release);

  // Reading pull requests first finds a missing Pull requests permission before anything is written.
  let existing: PullRequestLink | null;
  try { existing = await openPullRequest(call, repo, branch); } catch (error) { if (permissionDenied(error)) missing("pull_requests"); throw error; }
  if (existing) return { pullRequest: existing, created: false, release, files };

  const head = await json(await step("contents", `/repos/${repo}/git/ref/heads/main`)) as { object?: { sha?: unknown } } | undefined;
  const mainSha = head?.object?.sha;
  if (typeof mainSha !== "string" || !shaPattern.test(mainSha)) return unavailable();
  const commit = await json(await step("contents", `/repos/${repo}/git/commits/${mainSha}`)) as { tree?: { sha?: unknown } } | undefined;
  const baseTree = commit?.tree?.sha;
  if (typeof baseTree !== "string" || !shaPattern.test(baseTree)) return unavailable();

  const entries = [];
  for (const file of outdated) {
    const response = await call(`/repos/${officialRepository}/git/blobs/${file.sha}`);
    const blob = response.ok ? await json(response) as { content?: unknown; encoding?: unknown } | undefined : undefined;
    if (typeof blob?.content !== "string" || blob.encoding !== "base64") return unavailable();
    const bytes = decodeBase64(blob.content);
    if (await gitBlobSha(bytes) !== file.sha) return unavailable();
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return unavailable(); }
    entries.push({ path: file.path, mode: "100644", type: "blob", content });
  }
  const tree = await json(await step("contents", `/repos/${repo}/git/trees`, post({ base_tree: baseTree, tree: entries }))) as { sha?: unknown } | undefined;
  if (typeof tree?.sha !== "string" || !shaPattern.test(tree.sha)) return unavailable();
  const created = await json(await step("contents", `/repos/${repo}/git/commits`, post({ message: `Update LancerLogin workflow files to ${release}`, tree: tree.sha, parents: [mainSha] }))) as { sha?: unknown } | undefined;
  if (typeof created?.sha !== "string" || !shaPattern.test(created.sha)) return unavailable();

  // Commits that change .github/workflows can only be put on a branch with Workflows: Read and write.
  let ref = await step("workflows", `/repos/${repo}/git/refs`, post({ ref: `refs/heads/${branch}`, sha: created.sha }));
  if (ref.status === 422) {
    const message = String(((await json(ref)) as { message?: unknown } | undefined)?.message ?? "");
    if (/already exists/i.test(message)) ref = await step("workflows", `/repos/${repo}/git/refs/heads/${branch}`, post({ sha: created.sha, force: true }, "PATCH"));
    else if (/workflow/i.test(message)) missing("workflows");
  }
  if (!ref.ok) return /workflow/i.test(String(((await json(ref)) as { message?: unknown } | undefined)?.message ?? "")) ? missing("workflows") : unavailable();

  const body = [
    `This pull request updates the deployment repository's LancerLogin workflow files to ${release}, the release this installation runs.`,
    "",
    "Dashboard web updates deploy new releases but never change this repository, so these files stay at the version the repository was created from until they are updated here.",
    "",
    "Files:",
    ...files.map((path) => `- \`${path}\``),
    "",
    "Each file is the official release's exact version. lancerlogin.modules.json, other installation files and secrets are not changed.",
    "",
    "Opened from Settings > Updates in the LancerLogin dashboard. Review the changes, then merge this pull request.",
  ].join("\n");
  const pull = await step("pull_requests", `/repos/${repo}/pulls`, post({ title: `Update LancerLogin workflow files to ${release}`, head: branch, base: "main", body }));
  if (pull.status === 422) {
    const open = await openPullRequest(call, repo, branch).catch(() => null);
    if (open) return { pullRequest: open, created: false, release, files };
    return unavailable();
  }
  const link = pull.ok ? pullRequestLink(repo, await json(pull)) : null;
  return link ? { pullRequest: link, created: true, release, files } : unavailable();
}

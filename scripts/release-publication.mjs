import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLatestPromotion, releasePublicationPolicy } from "./release-channel.mjs";

export const repository = "isriah/LancerLogin";
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const validRun = (value) => /^[1-9][0-9]{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The release-gate browser suite runs in three groups (tests-browser/groups.json): Core plugin-free, and the plugin and
// integration groups with the official plugins composed. Each count must match its matrix in .github/workflows/ci.yml.
export const browserShardCounts = Object.freeze({ core: 4, plugin: 1, integration: 1 });
const shardNames = (label, count) => Array.from({ length: count }, (_, index) => `${label} ${index + 1}/${count}`);
export const requiredJobs = Object.freeze(["actionlint", "verify", "dependency-audit", "browser-smoke", ...shardNames("Core browser shard", browserShardCounts.core),
  ...shardNames("Plugin browser shard", browserShardCounts.plugin), ...shardNames("Integration browser shard", browserShardCounts.integration)]);
export function assetNames(tag) {
  releasePublicationPolicy(tag);
  return ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => {
    const name = `lancerlogin-kiosk-${tag.slice(1)}-linux-${arch}.tar.gz`; return [name, `${name}.sha256`];
  })].sort();
}
export function github(args, binary = false) {
  try { return execFileSync("gh", args, { encoding: binary ? undefined : "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "" }, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr))) { const missing = new Error("github_not_found"); missing.status = 404; throw missing; }
    throw new Error("github_command_failed", { cause: error });
  }
}
const api = (gh, path) => JSON.parse(gh(["api", "--hostname", "github.com", "-H", "X-GitHub-Api-Version: 2026-03-10", `repos/${repository}/${path}`]));
const cliRepo = ["--repo", `github.com/${repository}`];
// A complete Verify run counts for the exact commit when a maintainer dispatched it for that commit, or when it ran on a
// push to the trusted branch (only releases before v2.0.0-beta.16; pushes no longer run the complete gate). A dispatch runs the workflow file from that commit, so its evidence is the same;
// resolveRelease separately requires the commit to be on the trusted branch before accepting it.
const trustedVerifyRun = (run, sha, branch) => run.head_sha === sha && (run.event === "push" && run.head_branch === branch || run.event === "workflow_dispatch");
export function assertCompleteVerify(run, jobs, sha, branch) {
  if (!trustedVerifyRun(run, sha, branch) || run.status !== "completed" || run.conclusion !== "success"
    || jobs.length !== requiredJobs.length || !requiredJobs.every((name) => jobs.some((job) => job.name === name && job.conclusion === "success"))) throw new Error("complete_trusted_branch_verify_required");
}
export function resolveRelease(tag, gh = github) {
  const policy = releasePublicationPolicy(tag);
  const commit = api(gh, `commits/${tag}`);
  if (!shaPattern.test(commit.sha) || !commit.commit?.message?.split("\n")[0].startsWith(`Release ${tag}`)) throw new Error("verified_release_commit_required");
  const comparison = api(gh, `compare/${policy.branch}...${commit.sha}`);
  if (!["identical", "behind"].includes(comparison.status)) throw new Error("release_commit_not_on_trusted_branch");
  const runs = api(gh, `actions/workflows/ci.yml/runs?head_sha=${commit.sha}&status=success&per_page=100`).workflow_runs ?? [];
  const candidates = runs.filter((item) => item.conclusion === "success" && trustedVerifyRun(item, commit.sha, policy.branch) && validRun(item.id))
    .toSorted((a, b) => Number(b.event === "push") - Number(a.event === "push"));
  for (const run of candidates) {
    const jobs = api(gh, `actions/runs/${run.id}/jobs?per_page=100`).jobs;
    try { assertCompleteVerify(run, jobs, commit.sha, policy.branch); return { tag, sha: commit.sha, ...policy }; } catch {}
  }
  throw new Error("complete_trusted_branch_verify_required");
}
async function regularFile(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("bounded_regular_release_file_required");
  return readFile(path);
}
export async function inspectAssets(directory, tag) {
  const names = assetNames(tag);
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error("exactly_six_release_assets_required");
  const digests = {};
  for (const name of names) digests[name] = hash(await regularFile(join(directory, name), 32 * 1024 * 1024));
  for (const name of names.filter((item) => !item.endsWith(".sha256"))) {
    const checksum = (await regularFile(join(directory, `${name}.sha256`), 512)).toString("utf8").trim();
    if (checksum !== `${digests[name]}  ${name}`) throw new Error("release_checksum_mismatch");
  }
  return digests;
}
export async function createBundle(tag, sha, source, directory, { runId, producerSha }) {
  if (!shaPattern.test(sha) || !shaPattern.test(producerSha) || !validRun(runId)) throw new Error("invalid_bundle_identity");
  const version = JSON.parse(await regularFile(join(source, "package.json"), 64_000)).version;
  if (`v${version}` !== tag) throw new Error("release_version_mismatch");
  const notes = await regularFile(join(source, "docs", "releases", `${tag}.md`), 32_000);
  const assets = await inspectAssets(join(directory, "artifacts"), tag);
  await writeFile(join(directory, "notes.md"), notes, { flag: "wx" });
  await writeFile(join(directory, "bundle.json"), JSON.stringify({ format: 1, repository, tag, sha, runId: String(runId), producerSha,
    linuxUnprivileged: true, notesSha256: hash(notes), assets }) + "\n", { flag: "wx" });
}
export async function validateBundle(directory, context, run, notes) {
  const entries = (await readdir(directory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(["artifacts", "bundle.json", "notes.md"])) throw new Error("unexpected_bundle_file");
  const manifest = JSON.parse(await regularFile(join(directory, "bundle.json"), 16_000));
  const keys = ["assets", "format", "linuxUnprivileged", "notesSha256", "producerSha", "repository", "runId", "sha", "tag"].sort();
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(keys) || manifest.format !== 1 || manifest.repository !== repository
    || manifest.tag !== context.tag || manifest.sha !== context.sha || manifest.runId !== String(run.id) || manifest.producerSha !== run.head_sha
    || manifest.linuxUnprivileged !== true || !digestPattern.test(manifest.notesSha256)) throw new Error("release_bundle_identity_mismatch");
  const folder = await lstat(join(directory, "artifacts"));
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("release_bundle_identity_mismatch");
  const digests = await inspectAssets(join(directory, "artifacts"), context.tag);
  if (JSON.stringify(Object.keys(manifest.assets ?? {}).sort()) !== JSON.stringify(assetNames(context.tag))
    || Object.keys(digests).some((name) => manifest.assets[name] !== digests[name])) throw new Error("release_asset_digest_mismatch");
  if (hash(await regularFile(join(directory, "notes.md"), 32_000)) !== manifest.notesSha256 || hash(notes) !== manifest.notesSha256) throw new Error("release_notes_mismatch");
  return digests;
}
function existingRelease(gh, tag) {
  try { return api(gh, `releases/tags/${tag}`); } catch (error) { if (error.status !== 404) throw error; }
  // The tag endpoint excludes unpublished drafts. Authenticated release lists
  // include owner-visible drafts, which must be found before creating/resuming.
  for (let page = 1; page <= 10; page++) {
    const releases = api(gh, `releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error("release_lookup_failed");
    const matches = releases.filter((release) => release.tag_name === tag);
    if (matches.length > 1) throw new Error("ambiguous_release_identity");
    if (matches.length === 1) return matches[0];
    if (releases.length < 100) return;
  }
  throw new Error("release_lookup_limit_exceeded");
}
function assertAssets(release, digests) {
  if (!Array.isArray(release.assets) || JSON.stringify(release.assets.map((asset) => asset.name).sort()) !== JSON.stringify(Object.keys(digests).sort())
    || release.assets.some((asset) => asset.digest !== `sha256:${digests[asset.name]}`)) throw new Error("uploaded_release_assets_mismatch");
}
export async function publishRelease(tag, runId, { publish = false, gh = github } = {}) {
  if (!validRun(runId)) throw new Error("invalid_release_run");
  const context = resolveRelease(tag, gh);
  const run = api(gh, `actions/runs/${runId}`);
  if (run.id !== Number(runId) || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || run.status !== "completed" || run.conclusion !== "success"
    || run.path !== ".github/workflows/release.yml" || !shaPattern.test(run.head_sha)
    || !(run.event === "push" && run.head_sha === context.sha && run.head_branch === tag || run.event === "workflow_dispatch" && run.head_branch === "main")) throw new Error("trusted_release_packaging_run_required");
  const jobs = api(gh, `actions/runs/${runId}/jobs?per_page=100`).jobs;
  if (jobs.length !== 1 || jobs[0].conclusion !== "success" || !jobs[0].labels?.includes("ubuntu-latest")
    || !jobs[0].steps?.some((step) => step.name === "Package and validate both kiosk release archives" && step.conclusion === "success")) throw new Error("linux_verified_artifacts_required");
  const prior = existingRelease(gh, tag);
  if (prior && prior.draft !== true) throw new Error("published_release_never_replaced");
  if (api(gh, "immutable-releases").enabled !== true) throw new Error("immutable_releases_required");
  const latest = api(gh, "releases/latest").tag_name;
  if (!releasePublicationPolicy(latest).latest) throw new Error("stable_latest_required");
  assertLatestPromotion(tag, latest);
  const artifactList = api(gh, `actions/runs/${runId}/artifacts?per_page=100`);
  const artifacts = artifactList.artifacts;
  if (artifactList.total_count !== 1 || artifacts?.length !== 1) throw new Error("one_exact_release_bundle_required");
  const artifact = artifacts[0];
  if (!validRun(artifact.id) || artifact.name !== `lancerlogin-release-${tag}` || artifact.expired !== false
    || artifact.workflow_run?.id !== Number(runId) || artifact.workflow_run?.head_sha !== run.head_sha
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 64 * 1024 * 1024
    || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) throw new Error("valid_release_bundle_artifact_required");
  // Preserve ZIP bytes in a captured buffer, never a terminal. CLI text guards
  // must not reject or transform binary content before its digest is checked.
  const zip = gh(["api", "--allow-escape-sequences", "--hostname", "github.com", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], true);
  if (`sha256:${hash(zip)}` !== artifact.digest) throw new Error("release_bundle_download_digest_mismatch");
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-publication-"));
  try {
    gh(["run", "download", String(runId), ...cliRepo, "--name", artifact.name, "--dir", directory]);
    const retained = api(gh, `actions/artifacts/${artifact.id}`);
    if (retained.id !== artifact.id || retained.digest !== artifact.digest || retained.expired !== false) throw new Error("release_bundle_changed");
    const sourceNotes = api(gh, `contents/docs/releases/${tag}.md?ref=${context.sha}`);
    if (sourceNotes.encoding !== "base64" || typeof sourceNotes.content !== "string" || !Number.isSafeInteger(sourceNotes.size)
      || sourceNotes.size <= 0 || sourceNotes.size > 32_000) throw new Error("release_notes_mismatch");
    const digests = await validateBundle(directory, context, run, Buffer.from(sourceNotes.content, "base64"));
    if (!publish) return { ...context, runId: String(runId), assets: 6, published: false };
    // Recheck immediately before writes. Only drafts may be resumed.
    if (api(gh, "immutable-releases").enabled !== true) throw new Error("immutable_releases_required");
    if (api(gh, `commits/${tag}`).sha !== context.sha) throw new Error("release_tag_changed");
    const current = existingRelease(gh, tag);
    if (current && current.draft !== true) throw new Error("published_release_never_replaced");
    assertLatestPromotion(tag, api(gh, "releases/latest").tag_name);
    if (!current) gh(["release", "create", tag, ...cliRepo, "--draft", "--verify-tag", "--target", context.sha, `--prerelease=${context.prerelease}`, "--latest=false",
      "--notes-file", join(directory, "notes.md"), "--title", `LancerLogin ${tag}`]);
    gh(["release", "upload", tag, ...cliRepo, ...assetNames(tag).map((name) => join(directory, "artifacts", name)), "--clobber"]);
    const draft = existingRelease(gh, tag);
    if (draft?.draft !== true) throw new Error("draft_required_before_publication");
    assertAssets(draft, digests);
    if (api(gh, "immutable-releases").enabled !== true || api(gh, `commits/${tag}`).sha !== context.sha) throw new Error("publication_preflight_changed");
    assertLatestPromotion(tag, api(gh, "releases/latest").tag_name);
    gh(["release", "edit", tag, ...cliRepo, "--draft=false", `--prerelease=${context.prerelease}`, `--latest=${context.latest}`,
      "--notes-file", join(directory, "notes.md"), "--title", `LancerLogin ${tag}`]);
    const result = existingRelease(gh, tag);
    if (result?.draft !== false || result.immutable !== true || result.prerelease !== context.prerelease) throw new Error("published_release_verification_failed");
    assertAssets(result, digests);
    if (api(gh, "releases/latest").tag_name !== (context.latest ? tag : latest)) throw new Error("latest_verification_failed");
    return { ...context, runId: String(runId), assets: 6, published: true, url: result.html_url };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, tag, ...args] = process.argv.slice(2);
    if (command === "resolve" && args.length === 0) for (const [key, value] of Object.entries(resolveRelease(tag))) console.log(`${key}=${value}`);
    else if (command === "bundle" && args.length === 3 && process.platform === "linux" && process.env.GITHUB_ACTIONS === "true")
      await createBundle(tag, args[0], args[1], args[2], { runId: process.env.GITHUB_RUN_ID, producerSha: process.env.GITHUB_SHA });
    else if (command === "publish" && (args.length === 1 || args.length === 2 && args[1] === "--publish")) console.log(JSON.stringify(await publishRelease(tag, args[0], { publish: args[1] === "--publish" })));
    else throw new Error("Use resolve TAG, bundle TAG SHA SOURCE DIRECTORY in Linux CI, or publish TAG RUN_ID [--publish].");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNames, assertCompleteVerify, createBundle, publishRelease, resolveRelease, validateBundle } from "../scripts/release-publication.mjs";

const sha = "a".repeat(40), producerSha = "b".repeat(40);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const notes = Buffer.from("# Synthetic release\n\nBugs fixed\n\nNone.\n");
const jobs = ["actionlint", "verify", "dependency-audit", "browser-smoke", ...[1, 2, 3, 4, 5, 6].map((n) => `Browser shard ${n}/6`)].map((name) => ({ name, conclusion: "success" }));
async function fixture(tag = "v1.2.6", changes = {}) {
  const root = await mkdtemp(join(tmpdir(), "release-publisher-test-"));
  const source = join(root, "source"), bundle = join(root, "bundle");
  await mkdir(join(source, "docs", "releases"), { recursive: true }); await mkdir(join(bundle, "artifacts"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ version: tag.slice(1) })); await writeFile(join(source, "docs", "releases", `${tag}.md`), notes);
  for (const name of assetNames(tag).filter((name) => !name.endsWith(".sha256"))) {
    const bytes = Buffer.from(`Synthetic artifact ${name}`); await writeFile(join(bundle, "artifacts", name), bytes);
    await writeFile(join(bundle, "artifacts", `${name}.sha256`), `${digest(bytes)}  ${name}\n`);
  }
  await createBundle(tag, sha, source, bundle, { runId: 11, producerSha });
  const manifest = JSON.parse(await readFile(join(bundle, "bundle.json")));
  const branch = tag.includes("beta") ? "modular" : "main";
  const ci = { id: 7, head_sha: sha, head_branch: branch, event: "push", status: "completed", conclusion: "success", ...changes.ci };
  const run = { id: 11, repository: { full_name: "isriah/LancerLogin" }, head_repository: { full_name: "isriah/LancerLogin" }, head_sha: producerSha,
    head_branch: "main", event: "workflow_dispatch", path: ".github/workflows/release.yml", status: "completed", conclusion: "success", ...changes.run };
  const zip = Buffer.from("Synthetic ZIP bytes bound by GitHub artifact digest");
  const artifact = { id: 13, name: `lancerlogin-release-${tag}`, expired: false, workflow_run: { id: 11, head_sha: producerSha }, size_in_bytes: zip.length, digest: `sha256:${digest(zip)}`, ...changes.artifact };
  const calls = []; let release = changes.draft ? { tag_name: tag, draft: true, assets: [] } : undefined;
  let latest = "v1.2.5", immutableReads = 0, tagReads = 0;
  function gh(args, binary) {
    calls.push(args);
    if (args[0] === "api") {
      const endpoint = args.at(-1).replace("repos/isriah/LancerLogin/", ""); let result;
      if (endpoint === `commits/${tag}`) { tagReads++; result = { sha: changes.tagChanged && tagReads > 1 ? producerSha : changes.sha ?? sha, commit: { message: `Release ${tag} with synthetic content` } }; }
      else if (endpoint === `compare/${branch}...${changes.sha ?? sha}`) result = { status: changes.compare ?? "identical" };
      else if (endpoint.startsWith("actions/workflows/ci.yml/runs?")) result = { workflow_runs: [ci] };
      else if (endpoint === "actions/runs/7/jobs?per_page=100") result = { jobs: changes.jobs ?? jobs };
      else if (endpoint === "actions/runs/11") result = run;
      else if (endpoint === "actions/runs/11/jobs?per_page=100") result = { jobs: [{ conclusion: "success", labels: ["ubuntu-latest"], steps: [{ name: "Package and validate both kiosk release archives", conclusion: "success" }], ...changes.packageJob }] };
      else if (endpoint === "releases/latest") result = { tag_name: changes.latest ?? latest };
      else if (endpoint === "immutable-releases") { immutableReads++; result = { enabled: changes.immutable === undefined ? true : changes.immutable && immutableReads < 3 }; }
      else if (endpoint === `releases/tags/${tag}`) { if (changes.published) result = { draft: false }; else if (!release || release.draft) { const missing = new Error("not_found"); missing.status = 404; throw missing; } else result = release; }
      else if (endpoint === "releases?per_page=100&page=1") result = changes.duplicateRelease ? [{ tag_name: tag, draft: true }, { tag_name: tag, draft: true }] : release ? [release] : [];
      else if (endpoint === "actions/runs/11/artifacts?per_page=100") result = { total_count: 1, artifacts: [artifact], ...changes.artifactList };
      else if (endpoint === "actions/artifacts/13/zip") { assert.equal(binary, true); assert.ok(args.includes("--allow-escape-sequences")); return changes.zip ?? zip; }
      else if (endpoint === "actions/artifacts/13") result = { ...artifact, ...changes.retained };
      else if (endpoint === `contents/docs/releases/${tag}.md?ref=${sha}`) result = { content: notes.toString("base64"), encoding: "base64", size: notes.length };
      else throw new Error(`Unexpected endpoint ${endpoint}`);
      return JSON.stringify(result);
    }
    if (args[0] === "release") {
      if (args[1] === "create") release = { tag_name: tag, draft: true, assets: [] };
      if (args[1] === "upload") { release.assets = assetNames(tag).map((name) => ({ name, digest: `sha256:${manifest.assets[name]}` }));
        if (changes.uploadMismatch) release.assets[0].digest = `sha256:${"0".repeat(64)}`; }
      if (args[1] === "edit") { release = { ...release, draft: false, immutable: true, prerelease: tag.includes("beta"), html_url: `https://github.com/isriah/LancerLogin/releases/tag/${tag}` }; if (!tag.includes("beta")) latest = tag; }
      return "";
    }
    throw new Error("Unexpected CLI call");
  }
  // publishRelease uses a synchronous CLI; test download has to behave synchronously too.
  const { cpSync, writeFileSync } = await import("node:fs");
  const syncGh = (args, binary) => {
    if (args[0] !== "run") return gh(args, binary);
    calls.push(args); const directory = args[args.indexOf("--dir") + 1]; cpSync(bundle, directory, { recursive: true });
    if (changes.damage) writeFileSync(join(directory, "notes.md"), "changed"); return "";
  };
  return { root, bundle, run, gh: syncGh, calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("trusted release requires every exact source-branch job", () => {
  const run = { head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success" };
  assert.doesNotThrow(() => assertCompleteVerify(run, jobs, sha, "main"));
  // A maintainer-dispatched run on the exact commit runs that commit's workflow and is equivalent evidence.
  assert.doesNotThrow(() => assertCompleteVerify({ ...run, event: "workflow_dispatch", head_branch: "codex/release-v1.2.6" }, jobs, sha, "main"));
  for (const bad of [{ ...run, event: "pull_request" }, { ...run, event: "schedule" }, { ...run, head_sha: producerSha }, { ...run, head_branch: "modular" },
    { ...run, event: "workflow_dispatch", head_sha: producerSha }, { ...run, conclusion: "cancelled" }]) assert.throws(() => assertCompleteVerify(bad, jobs, sha, "main"));
  for (const bad of [jobs.slice(1), jobs.map((item, index) => index ? item : { ...item, conclusion: "skipped" }),
    jobs.map((item) => ({ ...item, name: item.name.replace("/6", "/4") }))]) assert.throws(() => assertCompleteVerify(run, bad, sha, "main"));
});
test("a dispatched exact-commit Verify satisfies the tag gate only when the commit is on the trusted branch", async () => {
  const dispatched = { event: "workflow_dispatch", head_branch: "codex/release-v2.0.0-beta.9" };
  for (const compare of ["identical", "behind"]) {
    const f = await fixture("v2.0.0-beta.9", { ci: dispatched, compare });
    try { assert.equal(resolveRelease("v2.0.0-beta.9", f.gh).sha, sha); } finally { await f.cleanup(); }
  }
  for (const changes of [{ ci: dispatched, compare: "ahead" }, { ci: dispatched, compare: "diverged" }, { ci: { ...dispatched, head_sha: producerSha } },
    { ci: { event: "pull_request" } }, { ci: dispatched, jobs: jobs.slice(1) }]) {
    const f = await fixture("v2.0.0-beta.9", changes);
    try { assert.throws(() => resolveRelease("v2.0.0-beta.9", f.gh), /release_commit_not_on_trusted_branch|complete_trusted_branch_verify_required/, JSON.stringify(changes)); }
    finally { await f.cleanup(); }
  }
});
test("preview is read-only; explicit publication assembles a draft and advances Stable", async () => {
  const f = await fixture();
  try {
    assert.equal((await publishRelease("v1.2.6", "11", { gh: f.gh })).published, false);
    assert.equal(f.calls.filter((args) => args[0] === "release").length, 0);
    const result = await publishRelease("v1.2.6", "11", { gh: f.gh, publish: true }); assert.equal(result.published, true);
    assert.deepEqual(f.calls.filter((args) => args[0] === "release").map((args) => args[1]), ["create", "upload", "edit"]);
    assert.ok(f.calls.find((args) => args[1] === "create").includes("--latest=false"));
    assert.ok(f.calls.find((args) => args[1] === "edit").includes("--latest=true"));
    assert.ok(f.calls.some((args) => args.at(-1).endsWith("releases?per_page=100&page=1")), "draft lookup uses authenticated release lists when tag lookup returns 404");
  } finally { await f.cleanup(); }
});
test("Beta stays a prerelease and cannot become Latest", async () => {
  const f = await fixture("v2.0.0-beta.1");
  try { assert.equal((await publishRelease("v2.0.0-beta.1", 11, { gh: f.gh, publish: true })).published, true);
    const edit = f.calls.find((args) => args[1] === "edit"); assert.ok(edit.includes("--prerelease=true")); assert.ok(edit.includes("--latest=false"));
  } finally { await f.cleanup(); }
});
test("owner-visible draft is resumed without creating a second release", async () => {
  const f = await fixture("v1.2.6", { draft: true });
  try { assert.equal((await publishRelease("v1.2.6", 11, { gh: f.gh, publish: true })).published, true);
    assert.deepEqual(f.calls.filter((args) => args[0] === "release").map((args) => args[1]), ["upload", "edit"]);
  } finally { await f.cleanup(); }
});
test("identity, permissions and artifact failures prevent publication", async () => {
  const failures = [
    { jobs: jobs.slice(1) }, { published: true }, { immutable: false }, { run: { event: "pull_request" } }, { run: { head_repository: { full_name: "other/repo" } } },
    { run: { head_branch: "modular" } }, { packageJob: { labels: ["windows-latest"] } }, { packageJob: { steps: [] } }, { artifact: { expired: true } },
    { artifact: { digest: "sha256:invalid" } }, { artifactList: { total_count: 2 } }, { zip: Buffer.from("modified") }, { retained: { digest: `sha256:${"0".repeat(64)}` } },
    { artifact: { size_in_bytes: 0 } }, { artifact: { size_in_bytes: null } }, { artifact: { size_in_bytes: 65 * 1024 * 1024 } },
    { damage: true }, { latest: "v1.2.6" }, { tagChanged: true }, { duplicateRelease: true },
  ];
  for (const changes of failures) {
    const f = await fixture("v1.2.6", changes);
    try { await assert.rejects(publishRelease("v1.2.6", 11, { gh: f.gh, publish: true })); assert.equal(f.calls.filter((args) => args[0] === "release").length, 0, JSON.stringify(changes)); }
    finally { await f.cleanup(); }
  }
  await assert.rejects(publishRelease("v1.2.6", "9007199254740992"), /invalid_release_run/);
});
test("immutability changing after draft upload prevents final publication", async () => {
  const f = await fixture("v1.2.6", { immutable: true });
  try { await assert.rejects(publishRelease("v1.2.6", 11, { gh: f.gh, publish: true }), /publication_preflight_changed/);
    assert.deepEqual(f.calls.filter((args) => args[0] === "release").map((args) => args[1]), ["create", "upload"]);
  } finally { await f.cleanup(); }
});
test("incorrect uploaded hashes leave a draft unpublished", async () => {
  const f = await fixture("v1.2.6", { uploadMismatch: true });
  try { await assert.rejects(publishRelease("v1.2.6", 11, { gh: f.gh, publish: true }), /uploaded_release_assets_mismatch/);
    assert.deepEqual(f.calls.filter((args) => args[0] === "release").map((args) => args[1]), ["create", "upload"]);
  } finally { await f.cleanup(); }
});
test("incorrect packaged checksums prevent any release mutation", async () => {
  const f = await fixture();
  try { await writeFile(join(f.bundle, "artifacts", "install-lancerlogin.sh.sha256"), `${"0".repeat(64)}  install-lancerlogin.sh\n`);
    await assert.rejects(publishRelease("v1.2.6", 11, { gh: f.gh, publish: true }), /release_checksum_mismatch/);
    assert.equal(f.calls.filter((args) => args[0] === "release").length, 0);
  } finally { await f.cleanup(); }
});
test("bundle source and notes are independently verified", async () => {
  const f = await fixture();
  try {
    assert.equal(resolveRelease("v1.2.6", f.gh).sha, sha);
    await validateBundle(f.bundle, { tag: "v1.2.6", sha }, f.run, notes);
    await assert.rejects(validateBundle(f.bundle, { tag: "v1.2.6", sha: producerSha }, f.run, notes), /identity_mismatch/);
    await assert.rejects(validateBundle(f.bundle, { tag: "v1.2.6", sha }, f.run, Buffer.from("wrong")), /notes_mismatch/);
    await writeFile(join(f.bundle, "artifacts", "extra"), "unexpected");
    await assert.rejects(validateBundle(f.bundle, { tag: "v1.2.6", sha }, f.run, notes), /exactly_six/);
  } finally { await f.cleanup(); }
});

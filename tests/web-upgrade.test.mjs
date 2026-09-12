import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validateUpgradeEnvironment, validateOfficialSource, validateMigrationPolicy, executeWebUpgrade, createLiveUpgradeIO } from "../scripts/run-web-upgrade.mjs";
import { verifyDispatchCredential, verifyCredentialTarget } from "../scripts/refresh-web-update-credential.mjs";
import { syntheticUpgradeIO, rehearseSyntheticWebUpgrade } from "../scripts/rehearse-web-upgrade.mjs";
import { buildPagesProxy } from "../scripts/prepare-pages-proxy.mjs";
import { recoverWebUpdate } from "../scripts/recover-web-update.mjs";

const env = { REPOSITORY_PRIVATE: "true", UPDATE_REPOSITORY: "example/private-install", REQUEST_ID: "11111111-1111-1111-1111-111111111111", RELEASE_TAG: "v1.0.0", RELEASE_SHA: "b".repeat(40), EXECUTOR_RUN_ID: "123", INSTALLATION_SLUG: "example", DATABASE_ID: "22222222-2222-2222-2222-222222222222", API_URL: "https://example-api.account.workers.dev", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "cfat_synthetic", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString() };
test("live adapter keeps Worker configuration out of the actual Pages CLI invocation", async () => {
  const source = await mkdtemp(join(tmpdir(), "lancerlogin-upgrade-cli-"));
  try {
    const executable = join(source, "node_modules/wrangler/bin");
    await mkdir(executable, { recursive: true });
    // Exercise the live adapter's real child process, recording only synthetic argv.
    await writeFile(join(executable, "wrangler.js"), "require('node:fs').appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');");
    const isolatedEnv = { CI: "true", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: source, TMP: source, HOME: source, USERPROFILE: source, XDG_CONFIG_HOME: source,
      WRANGLER_HOME: source, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false",
      CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:1" };
    const context = validateUpgradeEnvironment(env);
    const io = await createLiveUpgradeIO(context, isolatedEnv, source);
    await io.deployApi(); await io.deployPages();
    const [workerArgs, pagesArgs] = (await readFile(join(source, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(workerArgs, ["deploy", "--message", `Web update ${context.requestId}`, "--config", join(source, ".provision/wrangler.json")]);
    assert.deepEqual(pagesArgs, ["pages", "deploy", "apps/dashboard/dist", "--project-name=example-dashboard", "--branch=main", `--commit-hash=${context.sha}`, "--commit-dirty=false"]);
    // The locked real CLI must pass argument validation and stop at missing credentials.
    // Its HOME is empty, no credentials are inherited, and its API origin is loopback only.
    const cli = resolve("node_modules/wrangler/bin/wrangler.js");
    const invoke = args => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: source, env: isolatedEnv, encoding: "utf8", timeout: 30_000 });
      assert.ifError(result.error); assert.equal(result.status, 1);
      return result.stdout + result.stderr;
    };
    assert.match(invoke([...pagesArgs, "--config", join(source, ".provision/wrangler.json")]), /Pages does not support custom paths for the Wrangler configuration file/);
    const accepted = invoke(pagesArgs);
    assert.doesNotMatch(accepted, /does not support custom paths|Unknown argument/);
    assert.match(accepted, /CLOUDFLARE_API_TOKEN/);
  } finally { await rm(source, { recursive: true, force: true }); }
});
test("fixed upgrade parameters reject public, malformed and resource substitutions", () => {
  assert.equal(validateUpgradeEnvironment(env).tag, "v1.0.0");
  for (const substitution of [{ REPOSITORY_PRIVATE: "false" }, { UPDATE_REPOSITORY: "isriah/LancerLogin" }, { RELEASE_TAG: "v1.0.0-rc1" }, { RELEASE_SHA: "main" }, { INSTALLATION_SLUG: "example;command" }, { DATABASE_ID: "unknown" }, { API_URL: "https://another-api.account.workers.dev" }, { CLOUDFLARE_API_TOKEN: "unscoped" }]) assert.throws(() => validateUpgradeEnvironment({ ...env, ...substitution }));
});
test("official stable source is pinned once and requires all release assets", async () => {
  const context = validateUpgradeEnvironment(env);
  const assets = ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => [`lancerlogin-kiosk-1.0.0-linux-${arch}.tar.gz`, `lancerlogin-kiosk-1.0.0-linux-${arch}.tar.gz.sha256`])].map((name) => ({ name }));
  const release = { tag_name: context.tag, draft: false, prerelease: false, assets };
  await validateOfficialSource(context, async (url) => url.includes("/commits/") ? { sha: context.sha } : release);
  await assert.rejects(validateOfficialSource(context, async (url) => url.includes("/commits/") ? { sha: "c".repeat(40) } : release), /release_commit_mismatch/);
  await assert.rejects(validateOfficialSource(context, async () => ({ ...release, prerelease: true })), /official_release_required/);
});
test("migration review hashes are portable across LF/CRLF and unknown schemas fail closed", async () => {
  const directory = "apps/api/migrations"; const names = (await readdir(directory)).sort();
  const files = await Promise.all(names.map(async (name) => ({ name, content: await readFile(`${directory}/${name}`, "utf8") })));
  const policy = JSON.parse(await readFile("scripts/web-upgrade-policy.json", "utf8"));
  await validateMigrationPolicy(policy, files, names.slice(0, 28), "0.23.2", "v0.24.0");
  await validateMigrationPolicy(policy, files.map((file) => ({ ...file, content: file.content.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") })), names, "0.24.0", "v1.0.0");
  await assert.rejects(validateMigrationPolicy(policy, files, [...names, "9999_unknown.sql"], "0.24.0", "v1.0.0"), /migration_path_review_required/);
  await assert.rejects(validateMigrationPolicy(policy, [{ ...files[0], content: "changed" }, ...files.slice(1)], names, "0.24.0", "v1.0.0"), /migration_hash_review_required/);
  await assert.rejects(validateMigrationPolicy(policy, files, names, "0.1.0", "v1.0.0"), /migration_compatibility_review_required/);
  assert.equal(policy.reviewedMigrations.at(-1).sha256, createHash("sha256").update(files.at(-1).content.replaceAll("\r\n", "\n")).digest("hex"));
});
test("synthetic rehearsal covers bridge/V1, partial failures, checkpoints and duplicate execution", async () => {
  const evidence = await rehearseSyntheticWebUpgrade(); assert.equal(evidence.providerAcceptance, false); assert.equal(evidence.cases.length, 11);
  for (const failure of evidence.cases.filter((entry) => entry.stage)) assert.equal(failure.automaticDatabaseRestore, false);
  const { io, installation } = syntheticUpgradeIO();
  await executeWebUpgrade({ runId: "123", tag: "v1.0.0" }, io);
  await executeWebUpgrade({ runId: "456", tag: "v1.0.0" }, io);
  assert.equal(installation.mutations, 3);
});
test("operator recovery requires completed workflow, schema review and matching healthy releases", async () => {
  const row = { id: "synthetic-request", state: "recovery_required", run_id: "123", previous_version: "0.24.0", release_tag: "v1.0.0" }; let finalized = 0;
  const io = { runCompleted: async () => true, verifiedHealthyVersion: async () => "1.0.0", finalize: async () => { finalized++; } };
  await assert.rejects(recoverWebUpdate(row, io), /explicit_recovery_review_required/);
  const approval = { confirmation: "RECOVER WEB UPDATE synthetic-request", schemaCompatibilityReviewed: true };
  await assert.rejects(recoverWebUpdate(row, { ...io, runCompleted: async () => false }, approval), /workflow_completion_required/);
  await assert.rejects(recoverWebUpdate(row, { ...io, verifiedHealthyVersion: async () => "0.23.2" }, approval), /recovery_release_mismatch/);
  assert.equal(finalized, 0); assert.equal((await recoverWebUpdate(row, io, approval)).state, "succeeded"); assert.equal(finalized, 1);
});
test("credential refresh validates private workflow without exposing/provider-logging token", async () => {
  const calls = []; const credentialEnv = { ...env, LANCERLOGIN_UPDATE_REPOSITORY: "example/private-install", LANCERLOGIN_WEB_UPDATE_TOKEN: "synthetic" };
  await verifyDispatchCredential(credentialEnv, async (url, init) => { calls.push({ url, init }); return Response.json(url.includes("/workflows/") ? { state: "active", path: ".github/workflows/upgrade-web.yml" } : { private: true }); });
  assert.equal(calls.length, 2); assert.equal(calls.every((call) => call.url.startsWith("https://api.github.com/repos/example/private-install")), true);
  await assert.rejects(verifyDispatchCredential(credentialEnv, async () => Response.json({ private: false })), /private_repository_required/);
});
test("refresh refuses wrong account/missing Worker/wrong D1 before secret mutation", async () => {
  const requests = []; const result = (url) => url.endsWith("/tokens/verify") ? { status: "active" } : url.includes("/d1/") ? { uuid: env.DATABASE_ID, name: "example-data" } : { bindings: [{ name: "DB", type: "d1", id: env.DATABASE_ID }] };
  await verifyCredentialTarget(env, async (url, init) => { requests.push({ url, init }); return Response.json({ success: true, result: result(url) }); });
  assert.equal(requests.length, 3); assert.equal(requests.every((request) => !request.init.method), true);
  await assert.rejects(verifyCredentialTarget(env, async () => new Response(null, { status: 401 })), /credential_target_unavailable/);
  await assert.rejects(verifyCredentialTarget(env, async (url) => url.includes("/settings") ? new Response(null, { status: 404 }) : Response.json({ success: true, result: result(url) })), /credential_target_unavailable/);
  await assert.rejects(verifyCredentialTarget(env, async (url) => Response.json({ success: true, result: url.includes("/settings") ? { bindings: [{ name: "DB", type: "d1", id: "wrong" }] } : result(url) })), /worker_database_mismatch/);
});
test("Pages reports its own exact release and never infers identity from proxy health", async () => {
  const module = await import(`data:text/javascript,${encodeURIComponent(buildPagesProxy("https://api.test", "1.0.0"))}`);
  const response = await module.default.fetch(new Request("https://example.pages.dev/__lancerlogin-release"), {});
  assert.deepEqual(await response.json(), { releaseVersion: "1.0.0" }); assert.equal(response.headers.get("cache-control"), "no-store");
});
test("workflow boundaries and concurrency isolate official publication from private upgrades", async () => {
  for (const name of ["provision-template", "upgrade-web", "refresh-web-update-credential"]) assert.match(await readFile(`.github/workflows/${name}.yml`, "utf8"), /group: lancerlogin-production-installation/);
  for (const name of ["docs", "release"]) assert.match(await readFile(`.github/workflows/${name}.yml`, "utf8"), /github\.repository == 'isriah\/LancerLogin' && github\.event\.repository\.private == false/);
  assert.match(await readFile(".github/workflows/deploy-telemetry-collector.yml", "utf8"), /github\.repository == 'isriah\/LancerLogin-dev' && github\.event\.repository\.private == true/);
  const workflow = await readFile(".github/workflows/upgrade-web.yml", "utf8");
  assert.match(workflow, /environment: production/); assert.match(workflow, /repository: isriah\/LancerLogin/);
  assert.doesNotMatch(workflow, /inputs\.(?:installation_slug|repository|workflow|command)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validateUpgradeEnvironment, validateOfficialSource, validateMigrationPolicy, executeWebUpgrade, createLiveUpgradeIO, retainedDashboardOrigin, controllerCredentialMinimumValidityMs, pluginCompositionEnvironment, composeUpdateModules, verifyPinnedSelection, gitBlobSha, absentSelectionSha } from "../scripts/run-web-upgrade.mjs";
import { verifyDispatchCredential, verifyCredentialTarget, verifySelectionCredential } from "../scripts/refresh-web-update-credential.mjs";
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
      // The banner starts an npm registry update check and waits only 100 ms for it. The commands below then fail fast,
      // so wrangler exited with that request in flight, which crashes Node 24.14 on Windows (0xC0000409, libuv
      // UV_HANDLE_CLOSING assertion; not seen on the pinned 24.21.0). Hiding the banner skips the check, so the CLI
      // makes no network request at all.
      WRANGLER_HIDE_BANNER: "true",
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
      assert.ifError(result.error); assert.equal(result.status, 1, result.stdout + result.stderr);
      return result.stdout + result.stderr;
    };
    assert.match(invoke([...pagesArgs, "--config", join(source, ".provision/wrangler.json")]), /Pages does not support custom paths for the Wrangler configuration file/);
    const accepted = invoke(pagesArgs);
    assert.doesNotMatch(accepted, /does not support custom paths|Unknown argument/);
    assert.match(accepted, /CLOUDFLARE_API_TOKEN/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("live upgrade prepares a missing vault key over stdin after migrations and refuses lost-key replacement", async () => {
  const source = await mkdtemp(join(tmpdir(), "lancerlogin-vault-upgrade-"));
  const originalFetch = globalThis.fetch;
  try {
    const executable = join(source, "node_modules/wrangler/bin");
    await mkdir(executable, { recursive: true });
    await writeFile(join(executable, "wrangler.js"), [
      "const fs = require('node:fs'); const args = process.argv.slice(2);",
      "if (args[0] === 'secret' && args[1] === 'list') {",
      "fs.appendFileSync('calls.jsonl', JSON.stringify({args})+'\\n');",
      "process.stdout.write(JSON.stringify(fs.existsSync('key-present')?[{name:'FINGERPRINT_VAULT_KEY'}]:[]));",
      "} else if (args[0] === 'secret' && args[1] === 'put') {",
      "let input=''; process.stdin.on('data', chunk => input+=chunk); process.stdin.on('end', () => {",
      "const canonical=/^[A-Za-z0-9_-]{43}\\n$/.test(input);",
      "fs.appendFileSync('calls.jsonl', JSON.stringify({args,canonical})+'\\n');",
      "fs.writeFileSync('key-present','metadata only'); process.stdout.write(input); });",
      "} else fs.appendFileSync('calls.jsonl', JSON.stringify({args})+'\\n');",
    ].join("\n"));
    const context = validateUpgradeEnvironment(env);
    const isolatedEnv = { ...env, CI: "true", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: source, TMP: source, HOME: source, USERPROFILE: source, XDG_CONFIG_HOME: source };
    let enabled = 0; let queries = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.DATABASE_ID}/query`);
      assert.equal(init.method, "POST");
      assert.match(JSON.parse(init.body).sql, /kiosk_fingerprint_vault_settings/);
      queries++;
      return Response.json({ success: true, result: [{ success: true, results: [{ enabled, stored: enabled }] }] });
    };
    const io = await createLiveUpgradeIO(context, isolatedEnv, source);
    await io.migrate();
    const calls = (await readFile(join(source, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls[0].args.slice(0, 5), ["d1", "migrations", "apply", "example-data", "--remote"]);
    assert.deepEqual(calls[2].args.slice(0, 3), ["secret", "put", "FINGERPRINT_VAULT_KEY"]);
    assert.equal(calls[2].canonical, true); assert.equal(queries, 1);
    await io.migrate(); assert.equal(queries, 1, "retained key needs no template-state query");
    await rm(join(source, "key-present"));
    enabled = 1;
    await assert.rejects(io.migrate(), /vault_original_key_recovery_required/);
    const allCalls = (await readFile(join(source, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(allCalls.filter((call) => call.args[1] === "put").length, 1);
  } finally { globalThis.fetch = originalFetch; await rm(source, { recursive: true, force: true }); }
});

test("fixed upgrade parameters reject public, malformed and resource substitutions", () => {
  assert.equal(validateUpgradeEnvironment(env).tag, "v1.0.0");
  for (const substitution of [{ REPOSITORY_PRIVATE: "false" }, { UPDATE_REPOSITORY: "isriah/LancerLogin" }, { RELEASE_TAG: "v1.0.0-rc1" }, { RELEASE_SHA: "main" }, { INSTALLATION_SLUG: "example;command" }, { DATABASE_ID: "unknown" }, { API_URL: "https://another-api.account.workers.dev" }, { CLOUDFLARE_API_TOKEN: "unscoped" }]) assert.throws(() => validateUpgradeEnvironment({ ...env, ...substitution }));
  assert.throws(() => validateUpgradeEnvironment({ ...env, WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + controllerCredentialMinimumValidityMs - 1_000).toISOString() }), /dispatch_credential_expiry_required/);
});

test("upgrade controller retains only the registered Pages or custom dashboard origin", () => {
  const pages = { subdomain: "example-dashboard.pages.dev", domains: ["login.example.org"] };
  for (const origin of ["https://example-dashboard.pages.dev", "https://login.example.org"]) assert.equal(retainedDashboardOrigin({ bindings: [{ name: "ALLOWED_ORIGIN", type: "plain_text", text: origin }] }, pages), origin);
  for (const origin of ["http://login.example.org", "https://evil.example.org", "https://login.example.org/path"]) assert.throws(() => retainedDashboardOrigin({ bindings: [{ name: "ALLOWED_ORIGIN", type: "plain_text", text: origin }] }, pages));
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
  let superseded;
  const result = await recoverWebUpdate(row, { ...io, verifiedHealthyVersion: async () => "1.2.0", finalize: async (...values) => { superseded = values; } }, approval);
  assert.deepEqual(superseded, ["failed", "superseded_by_later_release"]); assert.equal(result.superseded, true); assert.equal(result.maintenance, false);
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
  const workflow = await readFile(".github/workflows/upgrade-web.yml", "utf8");
  assert.match(workflow, /environment: production/); assert.match(workflow, /repository: isriah\/LancerLogin/);
  assert.match(workflow, /node lancerlogin-source\/scripts\/run-web-upgrade\.mjs/);
  assert.doesNotMatch(workflow, /run: node deployment-control\/scripts\/run-web-upgrade\.mjs\s*$/m);
  assert.doesNotMatch(workflow, /inputs\.(?:installation_slug|repository|workflow|command)/);
});

test("renamed controller checks retained database name, UUID, account and Worker binding together", async () => {
  const renamed = { ...env, INSTALLATION_SLUG: "renamed", API_URL: "https://renamed-api.account.workers.dev", DATABASE_NAME: "original-data" };
  assert.equal(validateUpgradeEnvironment(renamed).databaseName, "original-data");
  assert.throws(() => validateUpgradeEnvironment({ ...renamed, DATABASE_NAME: "../unsafe" }), /fixed_database_name_invalid/);
  const result = (url, name = "original-data") => url.endsWith("/tokens/verify") ? { status: "active" } : url.includes("/d1/") ? { uuid: env.DATABASE_ID, name } : { bindings: [{ name: "DB", type: "d1", id: env.DATABASE_ID }] };
  await verifyCredentialTarget(renamed, async (url) => Response.json({ success: true, result: result(url) }));
  await assert.rejects(verifyCredentialTarget(renamed, async (url) => Response.json({ success: true, result: result(url, "renamed-data") })), /database_identity_mismatch/);
  await assert.rejects(verifyCredentialTarget(renamed, async (url) => Response.json({ success: true, result: url.includes("/settings") ? { bindings: [{ name: "DB", type: "d1", id: "wrong" }] } : result(url) })), /worker_database_mismatch/);
});

test("updates compose the release's official modules with or without the controller's plugin selection", async () => {
  const calls = [];
  const compose = async (options) => { calls.push(options); return { composed: true, modules: options.selectionPath ? ["hour-tracking", "carpool"] : ["hour-tracking"] }; };
  const environment = { PATH: "/bin", CLOUDFLARE_API_TOKEN: "cf", WEB_UPDATE_TOKEN: "update", LANCERLOGIN_PLUGIN_TOKEN: "plugin" };
  assert.deepEqual(await composeUpdateModules({ selectionPath: "deployment-control/lancerlogin.modules.json", environment, compose }), ["hour-tracking", "carpool"]);
  assert.deepEqual(await composeUpdateModules({ selectionPath: undefined, environment, compose }), ["hour-tracking"]);
  assert.deepEqual(calls.map(({ selectionPath, officialModules, env }) => ({ selectionPath, officialModules, env })), [
    { selectionPath: "deployment-control/lancerlogin.modules.json", officialModules: true, env: { PATH: "/bin", LANCERLOGIN_PLUGIN_TOKEN: "plugin" } },
    { selectionPath: null, officialModules: true, env: { PATH: "/bin", LANCERLOGIN_PLUGIN_TOKEN: "plugin" } },
  ]);
  // An incompatible plugin stops the update in preflight, before claim or maintenance.
  await assert.rejects(composeUpdateModules({ selectionPath: undefined, environment, compose: async () => { throw new Error("Module hour-tracking needs module contract 2"); } }), /needs module contract 2/);
  const source = await readFile("scripts/run-web-upgrade.mjs", "utf8");
  assert.match(source, /composedModules = await preflightModules\(/);
  assert.match(source, /compose: \(\) => composeUpdateModules\(\{ selectionPath: existsSync\(selection\) \? selection : undefined, environment \}\),/);
});

test("update preflight composition enforces the controller's plugin source allowlist before claim", async (t) => {
  // The real composition, with the selection and allowlist in a stand-in controller checkout: a refused source or an
  // invalid allowlist throws before any plugin is fetched, so the update stops before claim or maintenance.
  const controller = await mkdtemp(join(tmpdir(), "lancerlogin-upgrade-allowlist-"));
  t.after(() => rm(controller, { recursive: true, force: true }));
  const selection = join(controller, "lancerlogin.modules.json");
  const allowlist = join(controller, "lancerlogin.plugin-sources.json");
  const environment = { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: "cf" };
  await writeFile(selection, JSON.stringify({ format: 1, modules: [{ id: "stranger", source: "https://github.com/stranger/plugin.git", commit: "a".repeat(40) }] }));
  await writeFile(allowlist, JSON.stringify({ format: 1, allowedSources: ["github.com/trusted-org"] }));
  await assert.rejects(composeUpdateModules({ selectionPath: selection, environment }), /Module stranger source https:\/\/github\.com\/stranger\/plugin\.git is not allowed by lancerlogin\.plugin-sources\.json/);
  await writeFile(allowlist, JSON.stringify({ format: 1, allowedSources: ["gitlab.com"] }));
  await assert.rejects(composeUpdateModules({ selectionPath: selection, environment }), /Module stranger source .* is not allowed/);
  await writeFile(allowlist, "not json");
  await assert.rejects(composeUpdateModules({ selectionPath: selection, environment }), /lancerlogin\.plugin-sources\.json is not valid JSON, so no plugin source is allowed/);
});

test("plugin composition during an update never receives deployment or update credentials", () => {
  const environment = pluginCompositionEnvironment({ PATH: "/bin", HOME: "/home/runner", CLOUDFLARE_API_TOKEN: "cf", CLOUDFLARE_ACCOUNT_ID: "account", WEB_UPDATE_TOKEN: "update", GITHUB_TOKEN: "gh", INTEGRATION_KEY: "key", LANCERLOGIN_PLUGIN_TOKEN: "plugin" });
  assert.deepEqual(environment, { PATH: "/bin", HOME: "/home/runner", LANCERLOGIN_PLUGIN_TOKEN: "plugin" });
});
test("plugin-changes requests redeploy only the installed release with exactly the pinned selection", async () => {
  const directory = "apps/api/migrations"; const names = (await readdir(directory)).sort();
  const files = await Promise.all(names.map(async (name) => ({ name, content: await readFile(`${directory}/${name}`, "utf8") })));
  const policy = JSON.parse(await readFile("scripts/web-upgrade-policy.json", "utf8"));
  await validateMigrationPolicy(policy, files, names, "2.0.0-beta.11", "v2.0.0-beta.11", { sameRelease: true });
  await assert.rejects(validateMigrationPolicy(policy, files, names, "2.0.0-beta.11", "v2.0.0-beta.11"), /migration_compatibility_review_required/);
  await assert.rejects(validateMigrationPolicy(policy, files, names, "2.0.0-beta.11", "v2.0.0-beta.12", { sameRelease: true }), /migration_compatibility_review_required/);
  const controller = await mkdtemp(join(tmpdir(), "lancerlogin-selection-pin-"));
  try {
    const path = join(controller, "lancerlogin.modules.json"); const text = "{\n  \"format\": 1,\n  \"modules\": []\n}\n";
    await verifyPinnedSelection(absentSelectionSha, path);
    await verifyPinnedSelection(null, path);
    await writeFile(path, text);
    const git = spawnSync("git", ["hash-object", path], { encoding: "utf8" });
    if (git.status === 0) assert.equal(gitBlobSha(text), git.stdout.trim());
    await verifyPinnedSelection(gitBlobSha(text), path);
    await assert.rejects(verifyPinnedSelection(absentSelectionSha, path), /module_selection_changed/);
    await assert.rejects(verifyPinnedSelection("1".repeat(40), path), /module_selection_changed/);
    await assert.rejects(verifyPinnedSelection("not-a-sha", path), /module_selection_invalid/);
  } finally { await rm(controller, { recursive: true, force: true }); }
});
test("the optional plugin selection credential is verified, distinct from the dispatch token and uploaded only when present", async () => {
  const base = { ...env, LANCERLOGIN_UPDATE_REPOSITORY: "example/private-install", LANCERLOGIN_WEB_UPDATE_TOKEN: "synthetic-dispatch" };
  assert.equal(await verifySelectionCredential(base, async () => { throw new Error("no request without a selection token"); }), false);
  const selection = { ...base, LANCERLOGIN_MODULE_SELECTION_TOKEN: "synthetic-selection", MODULE_SELECTION_TOKEN_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString() };
  const calls = [];
  assert.equal(await verifySelectionCredential(selection, async (url, init) => { calls.push({ url, init }); return Response.json({ private: true }); }), true);
  assert.deepEqual(calls.map((call) => call.url), ["https://api.github.com/repos/example/private-install", "https://api.github.com/repos/example/private-install/contents/?ref=main"]);
  assert.equal(calls.every((call) => call.init.headers.authorization === "Bearer synthetic-selection" && call.init.redirect === "error" && !call.init.method), true);
  await assert.rejects(verifySelectionCredential({ ...selection, LANCERLOGIN_MODULE_SELECTION_TOKEN: "synthetic-dispatch" }, async () => Response.json({ private: true })), /selection_credential_must_be_distinct/);
  await assert.rejects(verifySelectionCredential({ ...selection, MODULE_SELECTION_TOKEN_EXPIRES_AT: "2020-01-01" }, async () => Response.json({ private: true })), /selection_credential_expiry_required/);
  await assert.rejects(verifySelectionCredential(selection, async (url) => url.includes("/contents/") ? new Response(null, { status: 403 }) : Response.json({ private: true })), /selection_credential_access_denied/);
  await assert.rejects(verifySelectionCredential(selection, async () => Response.json({ private: false })), /private_repository_required/);
  for (const name of ["provision-template", "refresh-web-update-credential"]) {
    const workflow = await readFile(`.github/workflows/${name}.yml`, "utf8");
    assert.match(workflow, /LANCERLOGIN_MODULE_SELECTION_TOKEN: \$\{\{ secrets\.LANCERLOGIN_MODULE_SELECTION_TOKEN \}\}/);
    assert.match(workflow, /MODULE_SELECTION_TOKEN_EXPIRES_AT: \$\{\{ vars\.MODULE_SELECTION_TOKEN_EXPIRES_AT \}\}/);
  }
  assert.doesNotMatch(await readFile(".github/workflows/upgrade-web.yml", "utf8"), /MODULE_SELECTION_TOKEN/, "the upgrade workflow never receives the selection credential");
});

test("the --validate step needs no secrets, while every mutating run requires the scoped credentials", () => {
  const withoutSecrets = { ...env }; delete withoutSecrets.CLOUDFLARE_API_TOKEN; delete withoutSecrets.CLOUDFLARE_ACCOUNT_ID;
  assert.equal(validateUpgradeEnvironment(withoutSecrets, { credentials: false }).tag, "v1.0.0");
  assert.throws(() => validateUpgradeEnvironment(withoutSecrets), /scoped_account_credential_required/);
  assert.throws(() => validateUpgradeEnvironment({ ...withoutSecrets, API_URL: "https://another-api.account.workers.dev" }, { credentials: false }), /fixed_api_origin_required/);
});

test("post-deployment health requires exactly the composed modules and this run's deployment marker", async () => {
  const { deployedHealthMatches, assertNewPagesDeployment } = await import("../scripts/run-web-upgrade.mjs");
  const marker = "33333333-3333-4333-8333-333333333333";
  const healthy = { api: { ok: true, mode: "ready", releaseVersion: "2.0.0", modules: ["attendance", "hour-tracking"], deployment: marker }, pages: { releaseVersion: "2.0.0" }, proxy: { ok: true, releaseVersion: "2.0.0" }, version: "2.0.0", expectedModules: ["attendance", "hour-tracking"], marker };
  assert.equal(deployedHealthMatches(healthy), true);
  // A plugin removed by a same-release plugin change: the old Worker still reports it.
  assert.equal(deployedHealthMatches({ ...healthy, api: { ...healthy.api, modules: ["attendance", "hour-tracking", "carpool"] } }), false);
  assert.equal(deployedHealthMatches({ ...healthy, api: { ...healthy.api, modules: ["attendance"] } }), false);
  assert.equal(deployedHealthMatches({ ...healthy, api: { ...healthy.api, modules: ["attendance", "attendance"] }, expectedModules: ["attendance", "hour-tracking"] }), false);
  // Same modules and version, but the previous deployment (another marker, or none).
  assert.equal(deployedHealthMatches({ ...healthy, api: { ...healthy.api, deployment: "44444444-4444-4444-8444-444444444444" } }), false);
  assert.equal(deployedHealthMatches({ ...healthy, api: { ...healthy.api, deployment: null }, marker: undefined }), false);
  assert.equal(deployedHealthMatches({ ...healthy, pages: { releaseVersion: "1.9.0" } }), false);
  const project = (id) => ({ canonical_deployment: { id, deployment_trigger: { metadata: { commit_hash: "b".repeat(40) } } } });
  assertNewPagesDeployment(project("new-pages"), { pagesDeploymentId: "old-pages" }, "b".repeat(40));
  assert.throws(() => assertNewPagesDeployment(project("old-pages"), { pagesDeploymentId: "old-pages" }, "b".repeat(40)), /pages_deployment_unchanged/);
  assert.throws(() => assertNewPagesDeployment(project("new-pages"), undefined, "b".repeat(40)), /pages_deployment_unchanged/);
  assert.throws(() => assertNewPagesDeployment(project("new-pages"), { pagesDeploymentId: "old-pages" }, "c".repeat(40)), /pages_commit_mismatch/);
});

// Steps are split the way GitHub lists them; job-level env is everything before the first step.
const stepsOf = (workflow) => workflow.replace(/\r\n/g, "\n").split(/\n(?= {6}- )/);
test("installation and update workflows give secrets only to the steps that use them", async () => {
  for (const name of ["upgrade-web", "refresh-web-update-credential", "provision-template"]) {
    const [job, ...steps] = stepsOf(await readFile(`.github/workflows/${name}.yml`, "utf8"));
    assert.doesNotMatch(job, /\$\{\{\s*secrets\./, `${name} sets no secret at job level`);
    for (const step of steps) {
      if (/\bnpm ci\b|run-web-upgrade\.mjs --validate|npm --workspace @lancerlogin\/dashboard run build|wrangler deploy --dry-run|compose-modules\.mjs/.test(step)) {
        const secrets = [...step.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
        // Composition receives only the optional read-only plugin token, which it needs to fetch private plugins.
        assert.deepEqual(secrets.filter((secret) => !(secret === "LANCERLOGIN_PLUGIN_TOKEN" && /compose-modules\.mjs/.test(step))), [], `${name}: ${step.split("\n")[0].trim()}`);
      }
    }
  }
  const upgrade = await readFile(".github/workflows/upgrade-web.yml", "utf8");
  const final = stepsOf(upgrade).find((step) => /node lancerlogin-source\/scripts\/run-web-upgrade\.mjs\s*$/m.test(step));
  assert.match(final, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(final, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
});

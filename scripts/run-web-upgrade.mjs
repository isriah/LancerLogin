import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { buildProvisionConfig } from "./prepare-cloudflare-provision.mjs";
import { buildPagesProxy } from "./prepare-pages-proxy.mjs";

const stable = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?![\s\S])/;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{40}$/;
export function validateUpgradeEnvironment(env) {
  if (env.REPOSITORY_PRIVATE !== "true") throw new Error("private_repository_required");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.UPDATE_REPOSITORY ?? "") || env.UPDATE_REPOSITORY.toLowerCase() === "isriah/lancerlogin") throw new Error("private_repository_required");
  if (!idPattern.test(env.REQUEST_ID ?? "") || !stable.test(env.RELEASE_TAG ?? "") || !shaPattern.test(env.RELEASE_SHA ?? "") || !/^[1-9][0-9]*$/.test(env.EXECUTOR_RUN_ID ?? "")) throw new Error("invalid_request");
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(env.INSTALLATION_SLUG ?? "") || !idPattern.test(env.DATABASE_ID ?? "")) throw new Error("fixed_resources_required");
  const api = new URL(env.API_URL);
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || api.pathname !== "/" || !api.hostname.startsWith(`${env.INSTALLATION_SLUG}-api.`) || !api.hostname.endsWith(".workers.dev")) throw new Error("fixed_api_origin_required");
  if (!/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") || !env.CLOUDFLARE_API_TOKEN?.startsWith("cfat_")) throw new Error("scoped_account_credential_required");
  if (!(Date.parse(env.WEB_UPDATE_TOKEN_EXPIRES_AT ?? "") > Date.now())) throw new Error("dispatch_credential_expiry_required");
  return { requestId: env.REQUEST_ID, tag: env.RELEASE_TAG, sha: env.RELEASE_SHA, runId: env.EXECUTOR_RUN_ID,
    slug: env.INSTALLATION_SLUG, databaseId: env.DATABASE_ID, apiUrl: api.origin,
    dashboardUrl: `https://${env.INSTALLATION_SLUG}-dashboard.pages.dev`, repository: env.UPDATE_REPOSITORY };
}
export async function validateOfficialSource(context, get) {
  const release = await get(`https://api.github.com/repos/isriah/LancerLogin/releases/tags/${context.tag}`);
  if (release.tag_name !== context.tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error("official_release_required");
  const version = context.tag.slice(1); const names = new Set(release.assets.map((asset) => asset.name));
  const required = ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => [`lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz.sha256`])];
  if (!required.every((name) => names.has(name))) throw new Error("complete_release_required");
  const commit = await get(`https://api.github.com/repos/isriah/LancerLogin/commits/${context.tag}`);
  if (commit.sha !== context.sha) throw new Error("release_commit_mismatch");
}
export async function validateMigrationPolicy(policy, files, applied, previousVersion, targetTag) {
  const compare = (left, right) => { const a = left.split(".").map(BigInt); const b = right.split(".").map(BigInt); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; return 0; };
  if (policy.format !== 1 || policy.automaticCodeRollback !== false || !stable.test(`v${previousVersion}`) || !stable.test(`v${policy.minimumInstalledVersion}`) || compare(previousVersion, policy.minimumInstalledVersion) < 0 || compare(targetTag.slice(1), previousVersion) <= 0) throw new Error("migration_compatibility_review_required");
  const reviewed = policy.reviewedMigrations;
  if (!Array.isArray(reviewed) || reviewed.length !== files.length || applied.some((name, index) => files[index]?.name !== name)) throw new Error("migration_path_review_required");
  for (const [index, file] of files.entries()) {
    if (reviewed[index]?.name !== file.name || reviewed[index]?.sha256 !== createHash("sha256").update(file.content.replaceAll("\r\n", "\n")).digest("hex") || reviewed[index]?.forwardCompatible !== true) throw new Error("migration_hash_review_required");
  }
}

/** IO abstraction is also used by the no-cloud synthetic failure/recovery rehearsal. */
export async function executeWebUpgrade(context, io) {
  let claimed = false; let maintenance = false; let mutation = false; let stage = "preflight";
  try {
    await io.preflight(context);
    if (!await io.claim(context)) return { duplicate: true }; // Includes same-run reruns; no lease expiry.
    claimed = true;
    await io.state("running", "building", 0);
    stage = "build"; await io.build(context); // API bundle and Pages assets before data/code mutation.
    stage = "maintenance"; await io.state("running", "maintenance", 1); maintenance = true;
    await io.drain();
    stage = "checkpoint"; const recovery = await io.checkpoint(context);
    if (!recovery?.databaseBookmark || !recovery?.workerVersionIds?.length || !recovery?.pagesDeploymentId) throw new Error("checkpoint_required");
    await io.saveRecovery(recovery);
    stage = "migrations"; await io.state("running", stage, 1); mutation = true;
    await io.migrate(context); // Compatible forward-only migrations. Never restore D1.
    stage = "api_deployment"; await io.state("running", stage, 1); await io.deployApi(context);
    stage = "pages_deployment"; await io.state("running", stage, 1); await io.deployPages(context);
    stage = "health"; await io.state("verifying", stage, 1); await io.health(context);
    await io.state("succeeded", "complete", 0);
    return { succeeded: true };
  } catch {
    if (claimed) await io.state(mutation ? "recovery_required" : "failed", stage, mutation && maintenance ? 1 : 0, `${stage}_failed`);
    // Sanitized stage only; subprocess/provider errors may contain sensitive data.
    throw new Error(`${stage}_failed`);
  }
}

async function jsonGet(url, headers = {}) {
  const response = await fetch(url, { headers: { "user-agent": "LancerLogin", accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("provider_request_failed");
  return response.json();
}
function command(program, args, cwd, env, { json = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", () => {}); // Never print credentials, SQL, personal data or provider bodies.
    child.on("error", () => reject(new Error("command_failed")));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error("command_failed"));
      try { done(json ? JSON.parse(stdout) : stdout.trim()); } catch { reject(new Error("command_output_invalid")); }
    });
  });
}

export async function createLiveUpgradeIO(context, environment, sourceDirectory) {
  const source = resolve(sourceDirectory); const configPath = resolve(source, ".provision/wrangler.json");
  const config = buildProvisionConfig(context.slug, [{ name: `${context.slug}-data`, uuid: context.databaseId }], context.tag.slice(1)).config;
  config.vars.UPDATE_REPOSITORY = context.repository;
  config.vars.UPDATE_WORKFLOW_URL = `https://github.com/${context.repository}/actions/workflows/upgrade-web.yml`;
  await mkdir(resolve(source, ".provision"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const processEnvironment = { ...environment, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true" };
  const wrangler = (args, options) => command(process.execPath, [resolve(source, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", configPath], source, processEnvironment, options);
  const accountOrigin = `https://api.cloudflare.com/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}`;
  const cfHeaders = { authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}` };
  const cf = async (path) => {
    const document = await jsonGet(`${accountOrigin}${path}`, cfHeaders);
    if (document.success !== true) throw new Error("cloudflare_request_failed");
    return document.result;
  };
  // D1 SQL sent over HTTPS as a JSON body, never shell text, argv or runner logs.
  const sql = async (query, params = []) => {
    const response = await fetch(`${accountOrigin}/d1/database/${context.databaseId}/query`, { method: "POST", headers: { ...cfHeaders, "content-type": "application/json" }, body: JSON.stringify({ sql: query, params }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("database_request_failed");
    const document = await response.json();
    if (!document.success || document.result?.some((entry) => entry.success === false)) throw new Error("database_query_failed");
    return document.result;
  };
  const owned = "installation_id = 'primary' AND id = ? AND executor_run_id = ?";
  const updateState = async (state, stage, maintenance, error = null) => {
    const result = await sql(`UPDATE web_update_requests SET state = ?, stage = ?, maintenance = ?, error_code = ?, updated_at = ? WHERE ${owned} AND state NOT IN ('succeeded','failed','expired')`, [state, stage, maintenance, error, new Date().toISOString(), context.requestId, context.runId]);
    if (result[0]?.meta?.changes !== 1) throw new Error("request_state_conflict");
    console.log(`Web update stage: ${stage}; state: ${state}`);
  };
  return {
    async preflight() {
      await validateOfficialSource(context, jsonGet);
      const version = JSON.parse(await readFile(resolve(source, "package.json"), "utf8")).version;
      if (`v${version}` !== context.tag || await command("git", ["rev-parse", "HEAD"], source, processEnvironment) !== context.sha) throw new Error("source_identity_mismatch");
      const token = await cf("/tokens/verify"); if (token.status !== "active") throw new Error("account_token_invalid");
      const database = await cf(`/d1/database/${context.databaseId}`);
      if (database.uuid !== context.databaseId || database.name !== `${context.slug}-data`) throw new Error("database_identity_mismatch");
      const settings = await cf(`/workers/scripts/${context.slug}-api/settings`);
      if (!settings.bindings?.some((binding) => binding.type === "d1" && binding.name === "DB" && binding.id === context.databaseId)) throw new Error("worker_database_mismatch");
      const secretNames = new Set((await wrangler(["secret", "list", "--format", "json"], { json: true })).map((entry) => entry.name));
      if (!["SESSION_KEY", "INTEGRATION_KEY", "BOOTSTRAP_CODE_HASH", "WEB_UPDATE_TOKEN", "WEB_UPDATE_TOKEN_EXPIRES_AT"].every((name) => secretNames.has(name))) throw new Error("retained_secrets_required");
      const pages = await cf(`/pages/projects/${context.slug}-dashboard`);
      if (pages.name !== `${context.slug}-dashboard` || pages.production_branch !== "main" || pages.subdomain !== `${context.slug}-dashboard.pages.dev`) throw new Error("pages_identity_mismatch");
      const request = (await sql("SELECT previous_version FROM web_update_requests WHERE installation_id = 'primary' AND id = ? AND release_tag = ? AND release_sha = ?", [context.requestId, context.tag, context.sha]))[0]?.results?.[0];
      const health = await jsonGet(`${context.apiUrl}/health`);
      if (!request || health.releaseVersion !== request.previous_version || health.ok !== true) throw new Error("installed_release_mismatch");
      const currentPages = await jsonGet(`${context.dashboardUrl}/__lancerlogin-release`);
      const currentProxy = await jsonGet(`${context.dashboardUrl}/api/health`);
      if (currentPages.releaseVersion !== health.releaseVersion || currentProxy.releaseVersion !== health.releaseVersion || currentProxy.ok !== true) throw new Error("installed_pages_release_mismatch");
      const applied = (await sql("SELECT name FROM d1_migrations ORDER BY id"))[0]?.results?.map((row) => row.name) ?? [];
      const policy = JSON.parse(await readFile(resolve(source, "scripts/web-upgrade-policy.json"), "utf8"));
      const directory = resolve(source, "apps/api/migrations");
      const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
      const files = await Promise.all(names.map(async (name) => ({ name, content: await readFile(resolve(directory, name), "utf8") })));
      await validateMigrationPolicy(policy, files, applied, health.releaseVersion, context.tag);
    },
    async claim() {
      const result = await sql("UPDATE web_update_requests SET executor_run_id = ?, run_id = ?, state = 'running', stage = 'preflight', updated_at = ? WHERE installation_id = 'primary' AND id = ? AND release_tag = ? AND release_sha = ? AND backup_exported_at IS NOT NULL AND executor_run_id IS NULL AND state IN ('dispatching','queued','awaiting_approval','running') AND (run_id IS NULL OR run_id = ?)", [context.runId, context.runId, new Date().toISOString(), context.requestId, context.tag, context.sha, context.runId]);
      return result[0]?.meta?.changes === 1;
    },
    state: updateState,
    async build() {
      await wrangler(["deploy", "--dry-run", "--outdir", ".provision/api-build"]);
      await command(process.platform === "win32" ? "npm.cmd" : "npm", ["--workspace", "@lancerlogin/dashboard", "run", "build"], source, { ...processEnvironment, VITE_API_BASE_URL: "/api" });
      await writeFile(resolve(source, "apps/dashboard/dist/_worker.js"), buildPagesProxy(context.apiUrl, context.tag.slice(1)), { mode: 0o600 });
    },
    async drain() { await new Promise((done) => setTimeout(done, 60_000)); },
    async checkpoint() {
      const bookmark = await wrangler(["d1", "time-travel", "info", `${context.slug}-data`, "--json"], { json: true });
      const deployments = await cf(`/workers/scripts/${context.slug}-api/deployments`);
      const active = deployments.deployments?.[0];
      const pages = await cf(`/pages/projects/${context.slug}-dashboard`);
      return { databaseBookmark: bookmark.bookmark, checkpointAt: new Date().toISOString(), databaseId: context.databaseId,
        previousVersion: (await jsonGet(`${context.apiUrl}/health`)).releaseVersion,
        workerDeploymentId: active?.id, workerVersionIds: active?.versions?.map((entry) => entry.version_id),
        pagesDeploymentId: pages.canonical_deployment?.id, resultingSchemaCompatibility: "requires_review", automaticDatabaseRestore: false };
    },
    async saveRecovery(recovery) {
      const result = await sql(`UPDATE web_update_requests SET recovery_json = ?, updated_at = ? WHERE ${owned}`, [JSON.stringify(recovery), new Date().toISOString(), context.requestId, context.runId]);
      if (result[0]?.meta?.changes !== 1) throw new Error("checkpoint_save_failed");
    },
    async migrate() { await wrangler(["d1", "migrations", "apply", `${context.slug}-data`, "--remote"]); },
    async deployApi() { await wrangler(["deploy", "--message", `Web update ${context.requestId}`]); },
    async deployPages() { await wrangler(["pages", "deploy", "apps/dashboard/dist", `--project-name=${context.slug}-dashboard`, "--branch=main", `--commit-hash=${context.sha}`, "--commit-dirty=false"]); },
    async health() {
      let healthy = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          const api = await jsonGet(`${context.apiUrl}/health?update=${context.requestId}`);
          const pages = await jsonGet(`${context.dashboardUrl}/__lancerlogin-release?update=${context.requestId}`);
          const proxy = await jsonGet(`${context.dashboardUrl}/api/health?update=${context.requestId}`);
          if (api.ok === true && api.mode === "ready" && api.releaseVersion === context.tag.slice(1) && pages.releaseVersion === context.tag.slice(1) && proxy.ok === true && proxy.releaseVersion === context.tag.slice(1)) { healthy = true; break; }
        } catch { /* Bounded propagation retry. Never finalizes from dispatch/run success. */ }
        await new Promise((done) => setTimeout(done, 5_000));
      }
      if (!healthy) throw new Error("health_mismatch");
      const pages = await cf(`/pages/projects/${context.slug}-dashboard`);
      if (pages.canonical_deployment?.deployment_trigger?.metadata?.commit_hash !== context.sha) throw new Error("pages_commit_mismatch");
      const settings = await cf(`/workers/scripts/${context.slug}-api/settings`);
      if (!settings.bindings?.some((binding) => binding.name === "DB" && binding.id === context.databaseId)) throw new Error("postdeploy_database_mismatch");
      const secrets = new Set((await wrangler(["secret", "list", "--format", "json"], { json: true })).map((entry) => entry.name));
      if (!["SESSION_KEY", "INTEGRATION_KEY", "BOOTSTRAP_CODE_HASH", "WEB_UPDATE_TOKEN", "WEB_UPDATE_TOKEN_EXPIRES_AT"].every((name) => secrets.has(name))) throw new Error("postdeploy_secret_missing");
    },
  };
}

async function main() {
  const context = validateUpgradeEnvironment(process.env);
  await validateOfficialSource(context, jsonGet);
  if (process.argv.includes("--validate")) return;
  const io = await createLiveUpgradeIO(context, process.env, "lancerlogin-source");
  const result = await executeWebUpgrade(context, io);
  if (result.duplicate) console.log("Request already claimed; deployment mutation skipped.");
}
if (process.argv[1]?.endsWith("run-web-upgrade.mjs")) main().catch(() => { console.error("Web upgrade stopped. Inspect the durable request stage and recovery record; no automatic D1 restore was attempted."); process.exitCode = 1; });

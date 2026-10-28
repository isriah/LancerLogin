import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { buildProvisionConfig } from "./prepare-cloudflare-provision.mjs";
import { buildPagesProxy } from "./prepare-pages-proxy.mjs";

import { resolveDatabaseName } from "./database-identity.mjs";
import { ensureFingerprintVaultKey, fingerprintVaultSecretName, fingerprintVaultStateSql } from "./ensure-fingerprint-vault-key.mjs";
import { parseReleaseVersion, releaseAllowed, compareReleaseVersions } from "../packages/shared/src/release-policy.mjs";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{40}$/;
export const controllerCredentialMinimumValidityMs = 2 * 60 * 60_000;
/**
 * credentials: false is the workflow's --validate step, which runs from the controller checkout with no secrets in its
 * environment; it checks the request and fixed resources only. Every mutating run requires the scoped credentials.
 */
export function validateUpgradeEnvironment(env, { credentials = true } = {}) {
  if (env.REPOSITORY_PRIVATE !== "true") throw new Error("private_repository_required");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.UPDATE_REPOSITORY ?? "") || env.UPDATE_REPOSITORY.toLowerCase() === "isriah/lancerlogin") throw new Error("private_repository_required");
  if (!idPattern.test(env.REQUEST_ID ?? "") || !env.RELEASE_TAG?.startsWith("v") || !parseReleaseVersion(env.RELEASE_TAG) || !shaPattern.test(env.RELEASE_SHA ?? "") || !/^[1-9][0-9]*$/.test(env.EXECUTOR_RUN_ID ?? "")) throw new Error("invalid_request");
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(env.INSTALLATION_SLUG ?? "") || !idPattern.test(env.DATABASE_ID ?? "")) throw new Error("fixed_resources_required");
  const api = new URL(env.API_URL);
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || api.pathname !== "/" || !api.hostname.startsWith(`${env.INSTALLATION_SLUG}-api.`) || !api.hostname.endsWith(".workers.dev")) throw new Error("fixed_api_origin_required");
  if (credentials && (!/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") || !env.CLOUDFLARE_API_TOKEN?.startsWith("cfat_"))) throw new Error("scoped_account_credential_required");
  if (!(Date.parse(env.WEB_UPDATE_TOKEN_EXPIRES_AT ?? "") - Date.now() >= controllerCredentialMinimumValidityMs)) throw new Error("dispatch_credential_expiry_required");
  return { requestId: env.REQUEST_ID, tag: env.RELEASE_TAG, sha: env.RELEASE_SHA, runId: env.EXECUTOR_RUN_ID,
    slug: env.INSTALLATION_SLUG, databaseName: resolveDatabaseName(env.INSTALLATION_SLUG, env.DATABASE_NAME), databaseId: env.DATABASE_ID, apiUrl: api.origin,
    dashboardUrl: `https://${env.INSTALLATION_SLUG}-dashboard.pages.dev`, repository: env.UPDATE_REPOSITORY };
}
export async function validateOfficialSource(context, get) {
  const release = await get(`https://api.github.com/repos/isriah/LancerLogin/releases/tags/${context.tag}`);
  if (release.tag_name !== context.tag || release.draft !== false || !releaseAllowed(context.tag, "beta", release.prerelease) || release.prerelease === true && release.immutable !== true || !Array.isArray(release.assets)) throw new Error("official_release_required");
  const version = context.tag.slice(1); const names = new Set(release.assets.map((asset) => asset.name));
  const required = ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => [`lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz.sha256`])];
  if (!required.every((name) => names.has(name))) throw new Error("complete_release_required");
  const commit = await get(`https://api.github.com/repos/isriah/LancerLogin/commits/${context.tag}`);
  if (commit.sha !== context.sha) throw new Error("release_commit_mismatch");
}
/**
 * sameRelease: a plugin-changes request redeploys the installed release, so the target equals the installed version.
 * Every other request must move forward.
 */
export async function validateMigrationPolicy(policy, files, applied, previousVersion, targetTag, { sameRelease = false } = {}) {
  if (policy.format !== 1 || policy.automaticCodeRollback !== false || !parseReleaseVersion(previousVersion) || !parseReleaseVersion(policy.minimumInstalledVersion) || !targetTag.startsWith("v") || compareReleaseVersions(previousVersion, policy.minimumInstalledVersion) === undefined || compareReleaseVersions(previousVersion, policy.minimumInstalledVersion) < 0 || compareReleaseVersions(targetTag, previousVersion) !== (sameRelease ? 0 : 1)) throw new Error("migration_compatibility_review_required");
  const reviewed = policy.reviewedMigrations;
  // Only an explicitly reviewed, independent bridge can have been applied before
  // Modular's existing sequence. All other migrations retain exact-prefix order.
  const bridges = policy.independentBridgeMigrations ?? [];
  if (!Array.isArray(bridges) || bridges.some((name) => name !== "0061_update_channels.sql") || new Set(bridges).size !== bridges.length) throw new Error("migration_path_review_required");
  const ordinary = files.filter((file) => !bridges.includes(file.name));
  const installed = applied.filter((name) => !bridges.includes(name));
  if (!Array.isArray(reviewed) || reviewed.length !== files.length || new Set(applied).size !== applied.length || bridges.some((name) => !files.some((file) => file.name === name)) || installed.some((name, index) => ordinary[index]?.name !== name)) throw new Error("migration_path_review_required");
  for (const [index, file] of files.entries()) {
    if (reviewed[index]?.name !== file.name || reviewed[index]?.sha256 !== createHash("sha256").update(file.content.replaceAll("\r\n", "\n")).digest("hex") || reviewed[index]?.forwardCompatible !== true) throw new Error("migration_hash_review_required");
  }
}

/** Git's blob SHA-1 for file content, as GitHub reports it for lancerlogin.modules.json. */
export function gitBlobSha(content) {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
export const absentSelectionSha = "0".repeat(40);
/**
 * A request records the selection blob it was prepared with (forty zeros when the file was absent). The checked-out
 * controller must hold exactly that selection; any other selection is refused before claim or maintenance.
 */
export async function verifyPinnedSelection(expected, selectionPath, read = readFile) {
  if (expected === null || expected === undefined) return;
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error("module_selection_invalid");
  let content;
  try { content = await read(selectionPath); } catch (error) { if (error?.code !== "ENOENT") throw new Error("module_selection_unreadable"); }
  const actual = content === undefined ? absentSelectionSha : gitBlobSha(content);
  if (actual !== expected) throw new Error("module_selection_changed");
}

/**
 * Stop before claim when this build would drop a module that moved out of LancerLogin into a plugin while the installation
 * still uses it. The sanitized code names only fixed module IDs, so the dashboard can explain how to keep or remove it.
 */
export async function preflightModuleGuard({ query, composed, record }) {
  const { extractedModulesInUse } = await import("../apps/api/src/extracted-modules.ts");
  const inUse = await extractedModulesInUse(query, new Set(composed));
  if (!inUse.length) return;
  await record(`module_migration_required:${inUse.map((module) => module.id).join(",")}`);
  throw new Error("module_migration_required");
}

/**
 * A refusal before claim that names its reason fails the unclaimed request with that code. An installed Worker from an
 * older release replaces the code of a request it fails itself with a generic one, but it never touches a failed request.
 * Only a request this run could still claim is affected: never one that is claimed, finished or bound to another run.
 */
export const preflightRefusalSql = "UPDATE web_update_requests SET state = 'failed', stage = 'preflight', error_code = ?, run_id = COALESCE(run_id, ?), updated_at = ? WHERE installation_id = 'primary' AND id = ? AND release_tag = ? AND release_sha = ? AND executor_run_id IS NULL AND state IN ('dispatching','queued','awaiting_approval','running') AND (run_id IS NULL OR run_id = ?)";
export async function refuseUnclaimedRequest(sql, context, code) {
  await sql(preflightRefusalSql, [code, context.runId, new Date().toISOString(), context.requestId, context.tag, context.sha, context.runId]);
  // Fixed codes and module IDs only, so the diagnostic run explains the refusal to dashboards that cannot.
  console.error(`Web update refused before claim: ${code}. Nothing changed.`);
  if (code.startsWith("module_migration_required:")) console.error("Add the module's plugin to lancerlogin.modules.json in the private deployment repository, or disable the module, then prepare the update again.");
}

/**
 * The selection and module checks that end preflight. Only the two refusals the dashboard can explain fail the request
 * here; every other error leaves it for the Worker to reconcile, as before.
 */
export async function preflightModules({ pinnedSelectionSha, selectionPath, compose, query, refuse }) {
  try { await verifyPinnedSelection(pinnedSelectionSha, selectionPath); }
  catch (error) { if (error.message === "module_selection_changed") await refuse("module_selection_preflight"); throw error; }
  const composed = await compose();
  await preflightModuleGuard({ query, composed, record: refuse });
  return composed;
}

/**
 * IO abstraction is also used by the no-cloud synthetic failure/recovery rehearsal.
 * progress is shared with the cancellation handler (interruptUnchanged): it records whether the request is claimed and
 * whether a mutation may have started. Once interrupted, the run never starts a mutation.
 */
export async function executeWebUpgrade(context, io, progress = {}) {
  let claimed = false; let maintenance = false; let mutation = false; let stage = "preflight";
  const at = (value) => { stage = value; progress.stage = value; };
  try {
    await io.preflight(context);
    if (!await io.claim(context)) return { duplicate: true }; // Includes same-run reruns; no lease expiry.
    claimed = true; progress.claimed = true;
    await io.state("running", "building", 0);
    at("build"); await io.build(context); // API bundle and Pages assets before data/code mutation.
    at("maintenance"); await io.state("running", "maintenance", 1); maintenance = true;
    await io.drain();
    at("checkpoint"); const recovery = await io.checkpoint(context);
    if (!recovery?.databaseBookmark || !recovery?.workerVersionIds?.length || !recovery?.pagesDeploymentId) throw new Error("checkpoint_required");
    await io.saveRecovery(recovery);
    // Checked and set with no await in between, so a cancellation either stops the run here or sees that a mutation
    // may be starting and leaves the request for recovery.
    if (progress.interrupted) throw new Error("interrupted");
    progress.mutationStarting = true;
    at("migrations"); await io.state("running", stage, 1); mutation = true;
    await io.migrate(context); // Compatible forward-only migrations. Never restore D1.
    at("api_deployment"); await io.state("running", stage, 1); await io.deployApi(context);
    at("pages_deployment"); await io.state("running", stage, 1); await io.deployPages(context);
    at("health"); await io.state("verifying", stage, 1); await io.health(context);
    await io.state("succeeded", "complete", 0);
    return { succeeded: true };
  } catch {
    if (claimed) await io.state(mutation ? "recovery_required" : "failed", stage, mutation && maintenance ? 1 : 0, `${stage}_failed`);
    // Sanitized stage only; subprocess/provider errors may contain sensitive data.
    throw new Error(`${stage}_failed`);
  }
}

/** Request stages written before any migration or deployment: a run stopped in one of them changed nothing. */
export const unchangedStages = Object.freeze(["preflight", "building", "maintenance"]);
/**
 * A cancelled or timed-out run (GitHub sends SIGINT, then SIGTERM) never reaches executeWebUpgrade's catch block. If the
 * request is claimed and no mutation can have started, clear maintenance and fail the request instead of leaving the
 * installation paused for recovery although nothing changed. Returns "not_claimed" (nothing to release), "released",
 * or "mutation_possible": the run is left to continue until it is killed, and then to recovery.
 */
export async function interruptUnchanged(io, progress) {
  progress.interrupted = true;
  if (!progress.claimed) return "not_claimed";
  if (progress.mutationStarting) return "mutation_possible";
  await io.releaseUnchanged(progress.stage ?? "preflight");
  return "released";
}

/** Post-deployment health of exactly this deployment: the composed module set and this run's deployment marker. */
export function deployedHealthMatches({ api, pages, proxy, version, expectedModules, marker }) {
  const modules = Array.isArray(api?.modules) ? api.modules : [];
  const sameModules = modules.length === new Set(modules).size && modules.length === expectedModules.length && expectedModules.every((id) => modules.includes(id));
  return api?.ok === true && api.mode === "ready" && api.releaseVersion === version && sameModules && typeof marker === "string" && api.deployment === marker
    && pages?.releaseVersion === version && proxy?.ok === true && proxy.releaseVersion === version;
}
/** Pages serves this run's deployment: its commit, and a canonical deployment other than the checkpointed one. */
export function assertNewPagesDeployment(project, checkpoint, sha) {
  const canonical = project?.canonical_deployment;
  if (canonical?.deployment_trigger?.metadata?.commit_hash !== sha) throw new Error("pages_commit_mismatch");
  if (!canonical?.id || !checkpoint?.pagesDeploymentId || canonical.id === checkpoint.pagesDeploymentId) throw new Error("pages_deployment_unchanged");
}

/**
 * First-party module IDs of this checkout, read before composition writes plugin manifests, so plugin code is never
 * imported into the controller process. Refuses a checkout whose generated manifests are not the committed defaults.
 */
export async function firstPartyModuleIds(source) {
  const { defaultGeneratedContent, generatedFiles } = await import("./compose-modules.mjs");
  const manifests = (await readFile(resolve(source, generatedFiles.manifests.path), "utf8")).replaceAll("\r\n", "\n");
  if (manifests !== defaultGeneratedContent("manifests")) throw new Error("module_defaults_required");
  const { firstPartyModules } = await import("../packages/shared/src/module-platform.ts");
  return firstPartyModules.map((module) => module.id);
}

async function jsonGet(url, headers = {}) {
  const response = await fetch(url, { headers: { "user-agent": "LancerLogin", accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("provider_request_failed");
  return response.json();
}
function command(program, args, cwd, env, { json = false, input } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd, env, shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (value) => { if (input === undefined) stdout += value; });
    child.stderr.on("data", () => {}); // Never print credentials, SQL, personal data or provider bodies.
    child.on("error", () => reject(new Error("command_failed")));
    const timeout = input === undefined ? undefined : setTimeout(() => { child.kill(); reject(new Error("command_failed")); }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error("command_failed"));
      try { done(json ? JSON.parse(stdout) : stdout.trim()); } catch { reject(new Error("command_output_invalid")); }
    });
    if (input !== undefined) {
      child.stdin.on("error", () => { clearTimeout(timeout); child.kill(); reject(new Error("command_failed")); });
      child.stdin.end(`${input}\n`);
    }
  });
}

export function retainedDashboardOrigin(settings, pages) {
  const bindings = settings.bindings?.filter((binding) => binding.name === "ALLOWED_ORIGIN") ?? [];
  if (bindings.length !== 1 || bindings[0].type !== "plain_text") throw new Error("dashboard_origin_required");
  const value = bindings[0].text;
  let origin;
  try { origin = new URL(value); } catch { throw new Error("dashboard_origin_invalid"); }
  if (origin.protocol !== "https:" || origin.origin !== value || origin.port || ![pages.subdomain, ...(pages.domains ?? [])].includes(origin.hostname)) throw new Error("dashboard_origin_invalid");
  return value;
}

/** Plugin fetching and installation never see deployment or update credentials; only the optional plugin token passes. */
export function pluginCompositionEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name === "LANCERLOGIN_PLUGIN_TOKEN" || !/(CLOUDFLARE|TOKEN|SECRET|PASSWORD|_KEY$|_CODE$|^GITHUB_)/i.test(name)));
}

/**
 * Compose the official modules and the controller's plugin selection into this release checkout, as installation does.
 * Returns the composed module IDs, which post-deployment health must report. Any incompatible plugin throws before claim.
 */
export async function composeUpdateModules({ selectionPath, environment, compose }) {
  const composeModules = compose ?? (await import("./compose-modules.mjs")).composeModules;
  // Without a selection file (null), only the official modules are composed.
  const result = await composeModules({ selectionPath: selectionPath ?? null, officialModules: true, env: pluginCompositionEnvironment(environment), log: () => {} });
  return result.modules ?? [];
}

export async function createLiveUpgradeIO(context, environment, sourceDirectory, controllerDirectory = "deployment-control") {
  let composedModules = []; let firstPartyModules = []; let checkpointed;
  // A fresh value per run, deployed as a Worker variable and reported by /health, so health can tell this deployment
  // from a previous one that is still propagating. Plugin changes keep the release version, so the version cannot.
  const deploymentMarker = randomUUID();
  const source = resolve(sourceDirectory); const configPath = resolve(source, ".provision/wrangler.json");
  const databaseName = resolveDatabaseName(context.slug, context.databaseName);
  const config = buildProvisionConfig(context.slug, [{ name: databaseName, uuid: context.databaseId }], context.tag.slice(1), databaseName).config;
  config.vars.UPDATE_REPOSITORY = context.repository;
  config.vars.UPDATE_WORKFLOW_URL = `https://github.com/${context.repository}/actions/workflows/upgrade-web.yml`;
  config.vars.DEPLOYMENT_MARKER = deploymentMarker;
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
  let dashboardOrigin;
  let channelPolicyInstalled = false;
  const updateState = async (state, stage, maintenance, error = null) => {
    const result = await sql(`UPDATE web_update_requests SET state = ?, stage = ?, maintenance = ?, error_code = ?, updated_at = ? WHERE ${owned} AND state NOT IN ('succeeded','failed','expired')`, [state, stage, maintenance, error, new Date().toISOString(), context.requestId, context.runId]);
    if (result[0]?.meta?.changes !== 1) throw new Error("request_state_conflict");
    console.log(`Web update stage: ${stage}; state: ${state}`);
  };
  // Only while the stored stage proves nothing was migrated or deployed. Never touches a request in a later stage.
  const releaseUnchanged = async (stage) => {
    const placeholders = unchangedStages.map(() => "?").join(",");
    const result = await sql(`UPDATE web_update_requests SET state = 'failed', maintenance = 0, error_code = ?, updated_at = ? WHERE ${owned} AND state NOT IN ('succeeded','failed','expired','recovery_required') AND stage IN (${placeholders})`, [`${stage}_cancelled`, new Date().toISOString(), context.requestId, context.runId, ...unchangedStages]);
    if (result[0]?.meta?.changes !== 1) throw new Error("request_state_conflict");
  };
  return {
    async preflight() {
      await validateOfficialSource(context, jsonGet);
      const version = JSON.parse(await readFile(resolve(source, "package.json"), "utf8")).version;
      if (`v${version}` !== context.tag || await command("git", ["rev-parse", "HEAD"], source, processEnvironment) !== context.sha) throw new Error("source_identity_mismatch");
      const token = await cf("/tokens/verify"); if (token.status !== "active") throw new Error("account_token_invalid");
      const database = await cf(`/d1/database/${context.databaseId}`);
      if (database.uuid !== context.databaseId || database.name !== databaseName) throw new Error("database_identity_mismatch");
      const settings = await cf(`/workers/scripts/${context.slug}-api/settings`);
      if (!settings.bindings?.some((binding) => binding.type === "d1" && binding.name === "DB" && binding.id === context.databaseId)) throw new Error("worker_database_mismatch");
      const secretNames = new Set((await wrangler(["secret", "list", "--format", "json"], { json: true })).map((entry) => entry.name));
      if (!["SESSION_KEY", "INTEGRATION_KEY", "BOOTSTRAP_CODE_HASH", "WEB_UPDATE_TOKEN", "WEB_UPDATE_TOKEN_EXPIRES_AT"].every((name) => secretNames.has(name))) throw new Error("retained_secrets_required");
      const pages = await cf(`/pages/projects/${context.slug}-dashboard`);
      if (pages.name !== `${context.slug}-dashboard` || pages.production_branch !== "main" || pages.subdomain !== `${context.slug}-dashboard.pages.dev`) throw new Error("pages_identity_mismatch");
      dashboardOrigin = retainedDashboardOrigin(settings, pages);
      config.vars.ALLOWED_ORIGIN = dashboardOrigin;
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const columns = (await sql("PRAGMA table_info(web_update_requests)"))[0]?.results ?? [];
      channelPolicyInstalled = columns.some((column) => column.name === "update_channel");
      const modesInstalled = columns.some((column) => column.name === "mode");
      const request = (await sql(`SELECT previous_version${channelPolicyInstalled ? ", update_channel" : ""}${modesInstalled ? ", mode, module_selection_sha" : ""} FROM web_update_requests WHERE installation_id = 'primary' AND id = ? AND release_tag = ? AND release_sha = ?`, [context.requestId, context.tag, context.sha]))[0]?.results?.[0];
      // A plugin-changes request redeploys exactly the installed release.
      const sameRelease = request?.mode === "modules";
      if (sameRelease && context.tag !== `v${request.previous_version}`) throw new Error("installed_release_mismatch");
      const setting = channelPolicyInstalled ? (await sql("SELECT update_channel FROM installation_update_settings WHERE installation_id = 'primary'"))[0]?.results?.[0] : { update_channel: "stable" };
      const channel = channelPolicyInstalled ? request?.update_channel : "stable";
      if (!request || channel !== setting?.update_channel || !releaseAllowed(context.tag, channel, parseReleaseVersion(context.tag)?.beta !== undefined)) throw new Error("update_channel_consent_required");
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
      await validateMigrationPolicy(policy, files, applied, health.releaseVersion, context.tag, { sameRelease });
      // The release's official modules and the plugins selected in the private controller are fetched, checked and composed
      // before claim or maintenance. Without a selection file, the official modules alone are composed; a selection can opt
      // out of them with "officialModules": false. lancerlogin.plugin-sources.json beside the selection in the controller
      // checkout limits the selected sources; a forbidden source or an invalid file refuses the update here.
      const selection = resolve(controllerDirectory, "lancerlogin.modules.json");
      firstPartyModules = await firstPartyModuleIds(source);
      composedModules = await preflightModules({ pinnedSelectionSha: request.module_selection_sha, selectionPath: selection,
        compose: () => composeUpdateModules({ selectionPath: existsSync(selection) ? selection : undefined, environment }),
        query: async (query, params = []) => (await sql(query, params))[0]?.results ?? [],
        refuse: (code) => refuseUnclaimedRequest(sql, context, code) });
    },
    async claim() {
      const result = await sql(`UPDATE web_update_requests SET executor_run_id = ?, run_id = ?, state = 'running', stage = 'preflight', updated_at = ? WHERE installation_id = 'primary' AND id = ? AND release_tag = ? AND release_sha = ? AND backup_exported_at IS NOT NULL AND executor_run_id IS NULL AND state IN ('dispatching','queued','awaiting_approval','running') AND (run_id IS NULL OR run_id = ?)${channelPolicyInstalled ? " AND update_channel = (SELECT update_channel FROM installation_update_settings WHERE installation_id = 'primary')" : ""}`, [context.runId, context.runId, new Date().toISOString(), context.requestId, context.tag, context.sha, context.runId]);
      return result[0]?.meta?.changes === 1;
    },
    state: updateState,
    releaseUnchanged,
    async build() {
      await wrangler(["deploy", "--dry-run", "--outdir", ".provision/api-build"]);
      await command(process.platform === "win32" ? "npm.cmd" : "npm", ["--workspace", "@lancerlogin/dashboard", "run", "build"], source, { ...processEnvironment, VITE_API_BASE_URL: "/api" });
      await writeFile(resolve(source, "apps/dashboard/dist/_worker.js"), buildPagesProxy(context.apiUrl, context.tag.slice(1)), { mode: 0o600 });
    },
    async drain() { await new Promise((done) => setTimeout(done, 60_000)); },
    async checkpoint() {
      const bookmark = await wrangler(["d1", "time-travel", "info", databaseName, "--json"], { json: true });
      const deployments = await cf(`/workers/scripts/${context.slug}-api/deployments`);
      const active = deployments.deployments?.[0];
      const pages = await cf(`/pages/projects/${context.slug}-dashboard`);
      return { databaseBookmark: bookmark.bookmark, checkpointAt: new Date().toISOString(), databaseId: context.databaseId,
        previousVersion: (await jsonGet(`${context.apiUrl}/health`)).releaseVersion,
        workerDeploymentId: active?.id, workerVersionIds: active?.versions?.map((entry) => entry.version_id),
        pagesDeploymentId: pages.canonical_deployment?.id, resultingSchemaCompatibility: "requires_review", automaticDatabaseRestore: false };
    },
    async saveRecovery(recovery) {
      checkpointed = recovery;
      const result = await sql(`UPDATE web_update_requests SET recovery_json = ?, updated_at = ? WHERE ${owned}`, [JSON.stringify(recovery), new Date().toISOString(), context.requestId, context.runId]);
      if (result[0]?.meta?.changes !== 1) throw new Error("checkpoint_save_failed");
    },
    async migrate() {
      await wrangler(["d1", "migrations", "apply", databaseName, "--remote"]);
      await ensureFingerprintVaultKey({
        listSecretNames: async () => (await wrangler(["secret", "list", "--format", "json"], { json: true })).map((entry) => entry.name),
        readVaultState: async () => (await sql(fingerprintVaultStateSql))[0]?.results?.[0],
        putSecret: (name, value) => wrangler(["secret", "put", name], { input: value }),
      });
    },
    async deployApi() { await wrangler(["deploy", "--message", `Web update ${context.requestId}`]); },
    async deployPages() {
      // Pages rejects custom --config paths; the generated configuration belongs to the Worker only.
      await command(process.execPath, [resolve(source, "node_modules/wrangler/bin/wrangler.js"), "pages", "deploy", "apps/dashboard/dist", `--project-name=${context.slug}-dashboard`, "--branch=main", `--commit-hash=${context.sha}`, "--commit-dirty=false"], source, processEnvironment);
    },
    async health() {
      let healthy = false;
      for (let attempt = 0; attempt < 36; attempt++) {
        try {
          const api = await jsonGet(`${context.apiUrl}/health?update=${context.requestId}`);
          const pages = await jsonGet(`${context.dashboardUrl}/__lancerlogin-release?update=${context.requestId}`);
          const proxy = await jsonGet(`${context.dashboardUrl}/api/health?update=${context.requestId}`);
          // Exactly the composed set: a removed plugin must be gone too, which a still-propagating old Worker would fail.
          if (deployedHealthMatches({ api, pages, proxy, version: context.tag.slice(1), expectedModules: [...firstPartyModules, ...composedModules], marker: deploymentMarker })) { healthy = true; break; }
        } catch { /* Bounded propagation retry. Never finalizes from dispatch/run success. */ }
        await new Promise((done) => setTimeout(done, 5_000));
      }
      if (!healthy) throw new Error("health_mismatch");
      const pages = await cf(`/pages/projects/${context.slug}-dashboard`);
      // A plugin-changes deploy keeps the commit, so the canonical deployment must also differ from the checkpointed one.
      assertNewPagesDeployment(pages, checkpointed, context.sha);
      const settings = await cf(`/workers/scripts/${context.slug}-api/settings`);
      if (!settings.bindings?.some((binding) => binding.name === "DB" && binding.id === context.databaseId)) throw new Error("postdeploy_database_mismatch");
      if (!dashboardOrigin || retainedDashboardOrigin(settings, pages) !== dashboardOrigin) throw new Error("postdeploy_origin_mismatch");
      if (dashboardOrigin !== context.dashboardUrl) {
        const customPages = await jsonGet(`${dashboardOrigin}/__lancerlogin-release?update=${context.requestId}`);
        const customProxy = await jsonGet(`${dashboardOrigin}/api/health?update=${context.requestId}`);
        if (customPages.releaseVersion !== context.tag.slice(1) || customProxy.ok !== true || customProxy.releaseVersion !== context.tag.slice(1)) throw new Error("custom_dashboard_health_mismatch");
      }
      const secrets = new Set((await wrangler(["secret", "list", "--format", "json"], { json: true })).map((entry) => entry.name));
      if (!["SESSION_KEY", "INTEGRATION_KEY", "BOOTSTRAP_CODE_HASH", "WEB_UPDATE_TOKEN", "WEB_UPDATE_TOKEN_EXPIRES_AT", fingerprintVaultSecretName].every((name) => secrets.has(name))) throw new Error("postdeploy_secret_missing");
    },
  };
}

async function main() {
  const validateOnly = process.argv.includes("--validate");
  const context = validateUpgradeEnvironment(process.env, { credentials: !validateOnly });
  await validateOfficialSource(context, jsonGet);
  if (validateOnly) return;
  const io = await createLiveUpgradeIO(context, process.env, "lancerlogin-source");
  const progress = {};
  // GitHub cancellation and timeout-minutes send SIGINT, then SIGTERM, and kill the job seconds later.
  let interruption;
  const interrupted = () => {
    interruption ??= interruptUnchanged(io, progress).then((outcome) => {
      // A deployment step may be running: keep going until GitHub kills the job, then leave it to recovery.
      if (outcome === "mutation_possible") { console.error("Web update interrupted after a deployment step may have started; the request is left for recovery."); return; }
      console.error(outcome === "released" ? "Web update cancelled before any change. Maintenance was cleared and the request marked failed." : "Web update cancelled before it claimed the installation. Nothing changed.");
      process.exit(1);
    }, () => { console.error("Web update cancelled; the request state could not be updated and is left for reconciliation."); process.exit(1); });
  };
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  const result = await executeWebUpgrade(context, io, progress);
  if (result.duplicate) console.log("Request already claimed; deployment mutation skipped.");
}
if (process.argv[1]?.endsWith("run-web-upgrade.mjs")) main().catch(() => { console.error("Web upgrade stopped. Inspect the durable request stage and recovery record; no automatic D1 restore was attempted."); process.exitCode = 1; });

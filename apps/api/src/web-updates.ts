/** Only fixed server configuration reaches GitHub. Operational D1 state contains no token. */
import { completeOfficialRelease, compareReleaseVersions, parseReleaseVersion, type UpdateChannel } from "../../../packages/shared/src/release-policy.mjs";
import { readUpdateChannel } from "./update-channel.ts";
import { resolveOfficialRelease } from "./release-discovery.ts";
type Result<T = unknown> = { results?: T[]; meta?: { changes?: number } };
interface Statement { bind(...values: unknown[]): Statement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<Result<T>>; run(): Promise<Result>; }
interface Database { prepare(sql: string): Statement; batch?(statements: Statement[]): Promise<unknown[]>; }
export interface WebUpdateEnv {
  DB?: Database; ALLOWED_ORIGIN: string; RELEASE_VERSION?: string;
  UPDATE_REPOSITORY?: string; UPDATE_WORKFLOW_URL?: string; WEB_UPDATE_TOKEN?: string;
  WEB_UPDATE_TOKEN_EXPIRES_AT?: string;
}
export class WebUpdateError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export type UpdateRow = {
  id: string; release_tag: string; release_sha: string; release_notes: string; previous_version: string;
  state: string; stage: string; created_at: string; expires_at: string; updated_at: string;
  backup_exported_at?: string; started_at?: string; last_poll_at?: string; run_id?: string;
  executor_run_id?: string; maintenance: number; error_code?: string; recovery_json?: string; update_channel?: UpdateChannel;
  mode?: WebUpdateMode; module_selection_sha?: string | null;
};
/** release: install a newer official release. modules: redeploy the installed release with the changed plugin selection. */
export type WebUpdateMode = "release" | "modules";
/** Recorded selection blob for an installation without lancerlogin.modules.json. */
export const absentSelectionSha = "0".repeat(40);
export type PrepareOptions = {
  mode?: WebUpdateMode;
  /** Current git blob SHA of lancerlogin.modules.json (absentSelectionSha when missing), or undefined without a selection credential. */
  selectionSha?: () => Promise<string | undefined>;
  /** Refuses preparation when the build would drop a module the installation still uses. */
  guard?: () => Promise<void>;
};
export const WEB_UPDATE_WORKFLOW = "upgrade-web.yml";
export function fixedWorkflowPath(path: unknown): boolean { return path === `.github/workflows/${WEB_UPDATE_WORKFLOW}` || path === `.github/workflows/${WEB_UPDATE_WORKFLOW}@main`; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const terminal = new Set(["succeeded", "failed", "expired"]);
/** Stages the update controller records before any migration or deployment (scripts/run-web-upgrade.mjs unchangedStages). */
export const unchangedStages: readonly string[] = ["preflight", "building", "maintenance"];
export const updateCredentialMinimumValidityMs = 24 * 60 * 60_000;
function fail(status: number, code: string, message: string): never { throw new WebUpdateError(status, code, message); }
function db(env: WebUpdateEnv): Database { return env.DB ?? fail(503, "not_configured", "D1 is not linked."); }
function repository(env: WebUpdateEnv): string {
  if (!env.UPDATE_REPOSITORY || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.UPDATE_REPOSITORY) || env.UPDATE_REPOSITORY.toLowerCase() === "isriah/lancerlogin") fail(503, "not_configured", "The private web update workflow is not configured.");
  return env.UPDATE_REPOSITORY;
}
function credential(env: WebUpdateEnv, minimumValidityMs = 0): string {
  if (!env.WEB_UPDATE_TOKEN) fail(503, "credential_required", "Renew the private deployment credential through GitHub and Cloudflare.");
  const expiry = Date.parse(env.WEB_UPDATE_TOKEN_EXPIRES_AT ?? "");
  if (!Number.isFinite(expiry) || expiry <= Date.now()) fail(503, "credential_expired", "The private deployment credential has expired. Renew it through GitHub and Cloudflare.");
  if (expiry - Date.now() < minimumValidityMs) fail(503, "credential_expiring", "The private deployment credential expires too soon to start a safe update. Renew it first.");
  return env.WEB_UPDATE_TOKEN;
}
type GitHubRequestKind = "public" | "private" | "dispatch";
async function github(path: string, env?: WebUpdateEnv, init: RequestInit = {}, kind: GitHubRequestKind = "public"): Promise<Response> {
  const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "LancerLogin", "x-github-api-version": "2026-03-10", "content-type": "application/json" });
  if (env) headers.set("authorization", `Bearer ${credential(env)}`);
  let result: Response;
  // Workers supports manual/follow only. Inspect manual responses to keep credentials on the fixed host.
  try { result = await fetch(`https://api.github.com${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(4_000) }); }
  catch { return fail(503, "provider_unavailable", "GitHub is unavailable. The update request has been retained."); }
  if (result.status >= 300 && result.status < 400) fail(503, "provider_unavailable", "GitHub returned an unexpected redirect. The request was not forwarded.");
  if (result.status === 401 || result.status === 404 && kind !== "public") fail(503, "credential_required", "The deployment credential cannot access the fixed private workflow.");
  if (result.status === 429 || result.status === 403 && (result.headers.get("x-ratelimit-remaining") === "0" || result.headers.has("retry-after"))) fail(429, "cooldown", "GitHub requires a cooldown. Try again later.");
  if (result.status === 403) fail(503, "credential_permission", "The deployment credential is missing a required repository permission.");
  if (result.status === 422 && kind === "dispatch") fail(503, "workflow_invalid", "GitHub rejected the fixed update workflow dispatch. The workflow or its main branch must be repaired before retrying.");
  return result;
}
export const officialWebRelease = completeOfficialRelease;
export function newerRelease(tag: string, current: string): boolean {
  return compareReleaseVersions(tag, current) === 1;
}
export async function latestUpdate(env: WebUpdateEnv): Promise<UpdateRow | null> {
  return db(env).prepare("SELECT * FROM web_update_requests WHERE installation_id = 'primary' ORDER BY created_at DESC, rowid DESC LIMIT 1").first<UpdateRow>();
}
async function requestRow(env: WebUpdateEnv, id: unknown): Promise<UpdateRow> {
  if (typeof id !== "string" || !uuid.test(id)) fail(400, "invalid_request", "Choose the prepared update request.");
  return await db(env).prepare("SELECT * FROM web_update_requests WHERE installation_id = 'primary' AND id = ?").bind(id).first<UpdateRow>() ?? fail(404, "request_missing", "The update request is unavailable.");
}
export function updateView(row: UpdateRow | null, env: WebUpdateEnv) {
  const request = row ? { requestId: row.id, mode: row.mode ?? "release", targetTag: row.release_tag, targetCommit: row.release_sha, releaseNotes: row.release_notes, channel: row.update_channel ?? "stable",
    releaseUrl: `https://github.com/isriah/LancerLogin/releases/tag/${row.release_tag}`, previousVersion: row.previous_version,
    state: row.state, stage: row.stage, createdAt: row.created_at, expiresAt: row.expires_at, updatedAt: row.updated_at,
    backupExported: Boolean(row.backup_exported_at), maintenance: Boolean(row.maintenance), errorCode: row.error_code ?? null,
    runUrl: row.run_id ? `https://github.com/${repository(env)}/actions/runs/${row.run_id}` : null,
    reloadReady: row.state === "succeeded" } : null;
  return {
    releaseVersion: env.RELEASE_VERSION ?? "development",
    workflowUrl: env.UPDATE_REPOSITORY ? `https://github.com/${repository(env)}/actions/workflows/${WEB_UPDATE_WORKFLOW}` : env.UPDATE_WORKFLOW_URL,
    request,
    activeRequest: request && !terminal.has(row!.state) ? request : null,
    latestCompletedRequest: request && terminal.has(row!.state) ? request : null,
  };
}
export const moduleUpdateNotes = "Apply the plugin selection committed in the private deployment repository. The installed LancerLogin release is redeployed unchanged.";
export async function prepareWebUpdate(env: WebUpdateEnv, actorId?: string, options: PrepareOptions = {}) {
  const mode = options.mode ?? "release";
  const repo = repository(env); credential(env, updateCredentialMinimumValidityMs); const now = new Date().toISOString();
  await db(env).prepare("UPDATE web_update_requests SET state = 'expired', updated_at = ? WHERE installation_id = 'primary' AND state = 'prepared' AND expires_at <= ?").bind(now, now).run();
  const prior = await latestUpdate(env);
  if (prior && !terminal.has(prior.state)) return updateView(prior, env);
  if (prior?.started_at && Date.now() - Date.parse(prior.started_at) < 120_000) fail(429, "cooldown", "Wait two minutes before preparing another update.");
  await options.guard?.();
  const metadata = await github(`/repos/${repo}`, env, {}, "private");
  if (!metadata.ok || (await metadata.json() as { private?: boolean }).private !== true) fail(503, "not_private", "Web updates require the configured private deployment repository.");
  const workflow = await github(`/repos/${repo}/actions/workflows/${WEB_UPDATE_WORKFLOW}`, env, {}, "private");
  const info = workflow.ok ? await workflow.json() as { state?: string; path?: string; name?: string } : undefined;
  if (info?.state !== "active" || info.path !== `.github/workflows/${WEB_UPDATE_WORKFLOW}`) fail(503, "workflow_required", "Install the reviewed private web upgrade workflow before updating.");
  const setting = await readUpdateChannel(env);
  let target: { tag: string; notes: string; prerelease: boolean };
  if (mode === "modules") {
    // The installed official release is redeployed; only the plugin selection changes.
    const installed = env.RELEASE_VERSION ?? "";
    if (!parseReleaseVersion(installed)) fail(503, "release_unavailable", "Plugin changes need an installed official release.");
    target = { tag: `v${installed}`, notes: moduleUpdateNotes, prerelease: parseReleaseVersion(installed)?.beta !== undefined };
  } else {
    const release = await resolveOfficialRelease(setting.channel, (path) => github(path, env));
    if (!release) fail(503, "release_unavailable", "A complete official release on this track is unavailable.");
    target = release!;
  }
  if (target.prerelease && info?.name !== "Upgrade LancerLogin web (update channels v2)") fail(503, "controller_upgrade_required", "The maintainer must install the reviewed update-channel controller in the private deployment repository before this beta can be prepared.");
  if (mode === "release" && !newerRelease(target.tag, env.RELEASE_VERSION ?? "")) fail(409, "already_current", "No newer release is available on this track. Switching tracks never downgrades an installation.");
  const commitResponse = await github(`/repos/isriah/LancerLogin/commits/${target.tag}`, env);
  const commit = commitResponse.ok ? await commitResponse.json() as { sha?: string } : undefined;
  if (!commit?.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) fail(503, "release_unavailable", "The official release commit could not be pinned.");
  // Pin the plugin selection this request deploys, so a later selection change cannot reach an already prepared update.
  const selectionSha = await options.selectionSha?.();
  if (selectionSha !== undefined && !/^[0-9a-f]{40}$/.test(selectionSha)) fail(503, "selection_unavailable", "The plugin selection could not be read.");
  if (mode === "modules" && selectionSha === undefined) fail(503, "selection_credential_required", "Plugin changes need the plugin selection credential.");
  const id = crypto.randomUUID(); const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  // INSERT OR IGNORE respects the partial unique index under simultaneous Admin requests.
  await db(env).prepare("INSERT OR IGNORE INTO web_update_requests (id, installation_id, release_tag, release_sha, release_notes, previous_version, prepared_by, state, created_at, expires_at, updated_at, update_channel, mode, module_selection_sha) SELECT ?, 'primary', ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM installation_update_settings WHERE installation_id = 'primary' AND update_channel = ? AND update_channel_revision = ?)")
    .bind(id, target.tag, commit!.sha, target.notes, env.RELEASE_VERSION, actorId ?? null, now, expires, now, setting.channel, mode, selectionSha ?? null, setting.channel, setting.revision).run();
  const prepared = await latestUpdate(env);
  if (!prepared || terminal.has(prepared.state)) fail(409, "channel_changed", "The update track changed during release preparation. Prepare again.");
  return updateView(prepared, env);
}
/** Active requests that are past preparation: plugin selection changes are refused until they finish. */
export async function startedUpdate(env: WebUpdateEnv): Promise<UpdateRow | null> {
  return db(env).prepare("SELECT * FROM web_update_requests WHERE installation_id = 'primary' AND state NOT IN ('prepared','succeeded','failed','expired') LIMIT 1").first<UpdateRow>();
}
export async function recordUpdateBackup(env: WebUpdateEnv, id: string): Promise<void> {
  const row = await requestRow(env, id);
  if (row.state !== "prepared" || Date.parse(row.expires_at) <= Date.now()) fail(409, "request_expired", "Prepare a fresh update before downloading its backup.");
  await db(env).prepare("UPDATE web_update_requests SET backup_exported_at = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'prepared'")
    .bind(new Date().toISOString(), new Date().toISOString(), id).run();
}
export async function startWebUpdate(env: WebUpdateEnv, input: Record<string, unknown>, actorId?: string) {
  if (Object.keys(input).some((key) => !["requestId", "backupSaved"].includes(key))) fail(400, "invalid_request", "Only the prepared request and saved-backup confirmation are accepted.");
  const row = await requestRow(env, input.requestId);
  if (row.state !== "prepared") return updateView(row, env); // Never redispatch, even after failure or lost response.
  if (Date.parse(row.expires_at) <= Date.now()) fail(409, "request_expired", "The prepared update expired. Prepare it again.");
  if (input.backupSaved !== true || !row.backup_exported_at) fail(409, "backup_required", "Download this update's entire-installation backup and confirm it was saved.");
  credential(env, updateCredentialMinimumValidityMs); const repo = repository(env); const now = new Date().toISOString();
  // RETURNING identifies the atomic winner; D1 meta.changes also counts the started audit trigger.
  const claim = await db(env).prepare("UPDATE web_update_requests SET state = 'dispatching', stage = 'dispatching', started_at = ?, started_by = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'prepared' AND update_channel = (SELECT update_channel FROM installation_update_settings WHERE installation_id = 'primary') RETURNING id").bind(now, actorId ?? null, now, row.id).first<{ id: string }>();
  if (claim?.id !== row.id) return updateView(await requestRow(env, row.id), env);
  try {
    const response = await github(`/repos/${repo}/actions/workflows/${WEB_UPDATE_WORKFLOW}/dispatches`, env, { method: "POST", body: JSON.stringify({ ref: "main", inputs: { request_id: row.id, release_tag: row.release_tag, release_sha: row.release_sha } }) }, "dispatch");
    const data = response.status === 200 ? await response.json() as { workflow_run_id?: number } : undefined;
    if (data?.workflow_run_id && Number.isSafeInteger(data.workflow_run_id) && data.workflow_run_id > 0) {
      await db(env).prepare("UPDATE web_update_requests SET run_id = ?, state = CASE WHEN state = 'dispatching' THEN 'queued' ELSE state END, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND run_id IS NULL").bind(String(data.workflow_run_id), now, row.id).run();
    } else {
      await db(env).prepare("UPDATE web_update_requests SET error_code = 'dispatch_ambiguous', updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'dispatching'").bind(now, row.id).run();
    }
  } catch (error) {
    // Timeouts, rejection and crashes all retain the one-way dispatch claim. Reconcile only.
    const definiteRejection = error instanceof WebUpdateError && ["credential_required", "credential_expired", "credential_expiring", "credential_permission", "workflow_invalid", "cooldown"].includes(error.code);
    const code = definiteRejection ? (error as WebUpdateError).code : "dispatch_ambiguous";
    await db(env).prepare("UPDATE web_update_requests SET state = ?, error_code = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'dispatching'").bind(definiteRejection ? "failed" : "dispatching", code, now, row.id).run();
  }
  return updateView(await requestRow(env, row.id), env);
}
export async function webUpdateMaintenance(env: WebUpdateEnv): Promise<boolean> {
  if (!env.DB) return false;
  return Boolean(await db(env).prepare("SELECT id FROM web_update_requests WHERE installation_id = 'primary' AND maintenance = 1 LIMIT 1").first());
}
export async function webUpdateStatus(env: WebUpdateEnv) {
  let row = await latestUpdate(env);
  if (!row || row.state === "prepared" || terminal.has(row.state) || row.state === "recovery_required") return updateView(row, env);
  // Persisted CAS bounds provider polling across tabs and concurrent Worker instances.
  const now = new Date().toISOString(); const cutoff = new Date(Date.now() - 10_000).toISOString();
  const poll = await db(env).prepare("UPDATE web_update_requests SET last_poll_at = ? WHERE installation_id = 'primary' AND id = ? AND (last_poll_at IS NULL OR last_poll_at <= ?)").bind(now, row.id, cutoff).run();
  if (poll.meta?.changes !== 1) return updateView(row, env);
  const repo = repository(env);
  if (!row.run_id) {
    const runs: Array<{ id: number; display_title?: string; path?: string }> = [];
    for (let page = 1; page <= 5; page++) {
      const result = await github(`/repos/${repo}/actions/workflows/${WEB_UPDATE_WORKFLOW}/runs?event=workflow_dispatch&per_page=100&page=${page}&created=${encodeURIComponent(`>=${row.started_at ?? row.created_at}`)}`, env, {}, "private");
      if (!result.ok) fail(503, "provider_unavailable", "GitHub update status is unavailable.");
      const batch = (await result.json() as { workflow_runs?: Array<{ id: number; display_title?: string; path?: string }> }).workflow_runs ?? [];
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    const matches = runs.filter((run) => run.display_title === `LancerLogin web update ${row!.id}` && fixedWorkflowPath(run.path));
    if (matches.length === 1 && Number.isSafeInteger(matches[0]!.id) && matches[0]!.id > 0) {
      await db(env).prepare("UPDATE web_update_requests SET run_id = ?, error_code = NULL, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND run_id IS NULL").bind(String(matches[0]!.id), now, row.id).run();
      row = await requestRow(env, row.id);
    } else if (matches.length > 1 || Date.now() - Date.parse(row.started_at ?? row.created_at) > 15 * 60_000) {
      await db(env).prepare("UPDATE web_update_requests SET state = 'recovery_required', error_code = 'dispatch_unresolved', updated_at = ? WHERE installation_id = 'primary' AND id = ? AND executor_run_id IS NULL").bind(now, row.id).run();
      return updateView(await requestRow(env, row.id), env);
    }
  }
  if (row.run_id) {
    const result = await github(`/repos/${repo}/actions/runs/${row.run_id}`, env, {}, "private");
    if (!result.ok) fail(503, "provider_unavailable", "GitHub update status is unavailable.");
    const run = await result.json() as { status?: string; conclusion?: string; path?: string; display_title?: string; event?: string };
    if (!fixedWorkflowPath(run.path) || run.display_title !== `LancerLogin web update ${row.id}` || run.event !== "workflow_dispatch") fail(503, "run_mismatch", "The workflow run identity could not be verified.");
    const latest = await requestRow(env, row.id);
    // A claimed run that stopped (cancelled, timed out or crashed) while the request was still in a stage written before
    // any migration or deployment changed nothing. Clear maintenance and fail it rather than requiring recovery.
    const stoppedUnchanged = run.status === "completed" && run.conclusion !== "success" && Boolean(latest.executor_run_id) && unchangedStages.includes(latest.stage);
    if (stoppedUnchanged && !terminal.has(latest.state) && latest.state !== "recovery_required") {
      await db(env).prepare(`UPDATE web_update_requests SET state = 'failed', maintenance = 0, error_code = 'workflow_stopped_unchanged', updated_at = ? WHERE installation_id = 'primary' AND id = ? AND executor_run_id IS NOT NULL AND stage IN (${unchangedStages.map(() => "?").join(",")}) AND state NOT IN ('succeeded','failed','expired','recovery_required')`)
        .bind(now, row.id, ...unchangedStages).run();
    } else if (!terminal.has(latest.state) && latest.state !== "recovery_required") {
      const state = run.status === "completed" ? !latest.executor_run_id && run.conclusion !== "success" ? "failed" : "recovery_required" : run.status === "waiting" ? "awaiting_approval" : run.status === "in_progress" ? "running" : "queued";
      // Workflow success alone never proves app health. Only its verified D1 finalization succeeds.
      // A current controller fails the request itself when it refuses before claim. An earlier one only recorded the
      // specific diagnostic; keep it in place of the generic code.
      const code = state === "recovery_required" ? "workflow_incomplete" : state === "failed" ? "preflight_failed" : null;
      await db(env).prepare("UPDATE web_update_requests SET state = ?, error_code = CASE WHEN ? = 'preflight_failed' AND executor_run_id IS NULL AND (error_code LIKE 'module_migration_required:%' OR error_code = 'module_selection_preflight') THEN error_code ELSE ? END, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state NOT IN ('succeeded','failed','expired','recovery_required')" + (run.status === "completed" ? "" : " AND state != 'verifying'"))
        .bind(state, code, code, now, row.id).run();
    }
  }
  return updateView(await requestRow(env, row.id), env);
}

/** Only fixed server configuration reaches GitHub. Operational D1 state contains no token. */
type Result<T = unknown> = { results?: T[]; meta?: { changes?: number } };
interface Statement { bind(...values: unknown[]): Statement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<Result<T>>; run(): Promise<Result>; }
interface Database { prepare(sql: string): Statement; }
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
  executor_run_id?: string; maintenance: number; error_code?: string; recovery_json?: string;
};
export const WEB_UPDATE_WORKFLOW = "upgrade-web.yml";
export function fixedWorkflowPath(path: unknown): boolean { return path === `.github/workflows/${WEB_UPDATE_WORKFLOW}` || path === `.github/workflows/${WEB_UPDATE_WORKFLOW}@main`; }
const stable = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?![\s\S])/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const terminal = new Set(["succeeded", "failed", "expired"]);
function fail(status: number, code: string, message: string): never { throw new WebUpdateError(status, code, message); }
function db(env: WebUpdateEnv): Database { return env.DB ?? fail(503, "not_configured", "D1 is not linked."); }
function repository(env: WebUpdateEnv): string {
  if (!env.UPDATE_REPOSITORY || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.UPDATE_REPOSITORY) || env.UPDATE_REPOSITORY.toLowerCase() === "isriah/lancerlogin") fail(503, "not_configured", "The private web update workflow is not configured.");
  return env.UPDATE_REPOSITORY;
}
function credential(env: WebUpdateEnv): string {
  if (!env.WEB_UPDATE_TOKEN) fail(503, "credential_required", "Renew the private deployment credential through GitHub and Cloudflare.");
  const expiry = Date.parse(env.WEB_UPDATE_TOKEN_EXPIRES_AT ?? "");
  if (!Number.isFinite(expiry) || expiry <= Date.now()) fail(503, "credential_expired", "The private deployment credential has expired. Renew it through GitHub and Cloudflare.");
  return env.WEB_UPDATE_TOKEN;
}
async function github(path: string, env?: WebUpdateEnv, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "LancerLogin", "x-github-api-version": "2026-03-10", "content-type": "application/json" });
  if (env) headers.set("authorization", `Bearer ${credential(env)}`);
  let result: Response;
  // Workers supports manual/follow only. Inspect manual responses to keep credentials on the fixed host.
  try { result = await fetch(`https://api.github.com${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(4_000) }); }
  catch { return fail(503, "provider_unavailable", "GitHub is unavailable. The update request has been retained."); }
  if (result.status >= 300 && result.status < 400) fail(503, "provider_unavailable", "GitHub returned an unexpected redirect. The request was not forwarded.");
  if (result.status === 401 || env && result.status === 404) fail(503, "credential_required", "The deployment credential cannot access the fixed private workflow.");
  if (result.status === 403 || result.status === 429) fail(429, "cooldown", "GitHub requires a cooldown or credential approval. Try again later.");
  return result;
}
export function officialWebRelease(value: unknown): { tag: string; notes: string } | undefined {
  if (!value || typeof value !== "object") return;
  const release = value as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: Array<{ name?: string }>; body?: unknown };
  if (typeof release.tag_name !== "string" || !stable.test(release.tag_name) || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) return;
  const version = release.tag_name.slice(1); const names = new Set(release.assets.map((entry) => entry?.name));
  const required = ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => [`lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz.sha256`])];
  if (!required.every((name) => names.has(name))) return;
  return { tag: release.tag_name, notes: typeof release.body === "string" ? release.body.slice(0, 32_000) : "" };
}
export function newerRelease(tag: string, current: string): boolean {
  if (!stable.test(tag) || !stable.test(`v${current}`)) return false;
  const left = tag.slice(1).split(".").map(BigInt); const right = current.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! > right[index]!;
  return false;
}
export async function latestUpdate(env: WebUpdateEnv): Promise<UpdateRow | null> {
  return db(env).prepare("SELECT * FROM web_update_requests WHERE installation_id = 'primary' ORDER BY created_at DESC LIMIT 1").first<UpdateRow>();
}
async function requestRow(env: WebUpdateEnv, id: unknown): Promise<UpdateRow> {
  if (typeof id !== "string" || !uuid.test(id)) fail(400, "invalid_request", "Choose the prepared update request.");
  return await db(env).prepare("SELECT * FROM web_update_requests WHERE installation_id = 'primary' AND id = ?").bind(id).first<UpdateRow>() ?? fail(404, "request_missing", "The update request is unavailable.");
}
export function updateView(row: UpdateRow | null, env: WebUpdateEnv) {
  return {
    releaseVersion: env.RELEASE_VERSION ?? "development",
    workflowUrl: env.UPDATE_REPOSITORY ? `https://github.com/${repository(env)}/actions/workflows/${WEB_UPDATE_WORKFLOW}` : env.UPDATE_WORKFLOW_URL,
    request: row ? { requestId: row.id, targetTag: row.release_tag, targetCommit: row.release_sha, releaseNotes: row.release_notes,
      releaseUrl: `https://github.com/isriah/LancerLogin/releases/tag/${row.release_tag}`, previousVersion: row.previous_version,
      state: row.state, stage: row.stage, createdAt: row.created_at, expiresAt: row.expires_at, updatedAt: row.updated_at,
      backupExported: Boolean(row.backup_exported_at), maintenance: Boolean(row.maintenance), errorCode: row.error_code ?? null,
      runUrl: row.run_id ? `https://github.com/${repository(env)}/actions/runs/${row.run_id}` : null,
      reloadReady: row.state === "succeeded" } : null,
  };
}
export async function prepareWebUpdate(env: WebUpdateEnv, actorId?: string) {
  const repo = repository(env); credential(env); const now = new Date().toISOString();
  await db(env).prepare("UPDATE web_update_requests SET state = 'expired', updated_at = ? WHERE installation_id = 'primary' AND state = 'prepared' AND expires_at <= ?").bind(now, now).run();
  const prior = await latestUpdate(env);
  if (prior && !terminal.has(prior.state)) return updateView(prior, env);
  if (prior?.started_at && Date.now() - Date.parse(prior.started_at) < 120_000) fail(429, "cooldown", "Wait two minutes before preparing another update.");
  const metadata = await github(`/repos/${repo}`, env);
  if (!metadata.ok || (await metadata.json() as { private?: boolean }).private !== true) fail(503, "not_private", "Web updates require the configured private deployment repository.");
  const workflow = await github(`/repos/${repo}/actions/workflows/${WEB_UPDATE_WORKFLOW}`, env);
  const info = workflow.ok ? await workflow.json() as { state?: string; path?: string } : undefined;
  if (info?.state !== "active" || info.path !== `.github/workflows/${WEB_UPDATE_WORKFLOW}`) fail(503, "workflow_required", "Install the reviewed private web upgrade workflow before updating.");
  const response = await github("/repos/isriah/LancerLogin/releases/latest");
  const target = response.ok ? officialWebRelease(await response.json()) : undefined;
  if (!target) fail(503, "release_unavailable", "A complete stable official release is unavailable.");
  if (!newerRelease(target.tag, env.RELEASE_VERSION ?? "")) fail(409, "already_current", "This installation already has the latest stable release.");
  const commitResponse = await github(`/repos/isriah/LancerLogin/commits/${target.tag}`);
  const commit = commitResponse.ok ? await commitResponse.json() as { sha?: string } : undefined;
  if (!commit?.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) fail(503, "release_unavailable", "The official release commit could not be pinned.");
  const id = crypto.randomUUID(); const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  // INSERT OR IGNORE respects the partial unique index under simultaneous Admin requests.
  await db(env).prepare("INSERT OR IGNORE INTO web_update_requests (id, installation_id, release_tag, release_sha, release_notes, previous_version, prepared_by, state, created_at, expires_at, updated_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)")
    .bind(id, target.tag, commit.sha, target.notes, env.RELEASE_VERSION, actorId ?? null, now, expires, now).run();
  return updateView(await latestUpdate(env), env);
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
  credential(env); const repo = repository(env); const now = new Date().toISOString();
  // RETURNING identifies the atomic winner; D1 meta.changes also counts the started audit trigger.
  const claim = await db(env).prepare("UPDATE web_update_requests SET state = 'dispatching', stage = 'dispatching', started_at = ?, started_by = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'prepared' RETURNING id").bind(now, actorId ?? null, now, row.id).first<{ id: string }>();
  if (claim?.id !== row.id) return updateView(await requestRow(env, row.id), env);
  try {
    const response = await github(`/repos/${repo}/actions/workflows/${WEB_UPDATE_WORKFLOW}/dispatches`, env, { method: "POST", body: JSON.stringify({ ref: "main", inputs: { request_id: row.id, release_tag: row.release_tag, release_sha: row.release_sha } }) });
    const data = response.status === 200 ? await response.json() as { workflow_run_id?: number } : undefined;
    if (data?.workflow_run_id && Number.isSafeInteger(data.workflow_run_id) && data.workflow_run_id > 0) {
      await db(env).prepare("UPDATE web_update_requests SET run_id = ?, state = CASE WHEN state = 'dispatching' THEN 'queued' ELSE state END, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND run_id IS NULL").bind(String(data.workflow_run_id), now, row.id).run();
    } else {
      await db(env).prepare("UPDATE web_update_requests SET error_code = 'dispatch_ambiguous', updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'dispatching'").bind(now, row.id).run();
    }
  } catch (error) {
    // Timeouts, rejection and crashes all retain the one-way dispatch claim. Reconcile only.
    const definiteRejection = error instanceof WebUpdateError && ["credential_required", "credential_expired", "cooldown"].includes(error.code);
    const code = definiteRejection ? (error as WebUpdateError).code : "dispatch_ambiguous";
    await db(env).prepare("UPDATE web_update_requests SET state = ?, error_code = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state = 'dispatching'").bind(definiteRejection ? "failed" : "dispatching", code, now, row.id).run();
  }
  return updateView(await requestRow(env, row.id), env);
}
export async function webUpdateMaintenance(env: WebUpdateEnv): Promise<boolean> {
  if (!env.UPDATE_REPOSITORY || !env.DB) return false;
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
    const result = await github(`/repos/${repo}/actions/workflows/${WEB_UPDATE_WORKFLOW}/runs?event=workflow_dispatch&per_page=100&created=${encodeURIComponent(`>=${row.started_at ?? row.created_at}`)}`, env);
    if (!result.ok) fail(503, "provider_unavailable", "GitHub update status is unavailable.");
    const runs = (await result.json() as { workflow_runs?: Array<{ id: number; display_title?: string; path?: string }> }).workflow_runs ?? [];
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
    const result = await github(`/repos/${repo}/actions/runs/${row.run_id}`, env);
    if (!result.ok) fail(503, "provider_unavailable", "GitHub update status is unavailable.");
    const run = await result.json() as { status?: string; conclusion?: string; path?: string; display_title?: string; event?: string };
    if (!fixedWorkflowPath(run.path) || run.display_title !== `LancerLogin web update ${row.id}` || run.event !== "workflow_dispatch") fail(503, "run_mismatch", "The workflow run identity could not be verified.");
    const latest = await requestRow(env, row.id);
    if (!terminal.has(latest.state) && latest.state !== "recovery_required") {
      const state = run.status === "completed" ? !latest.executor_run_id && run.conclusion !== "success" ? "failed" : "recovery_required" : run.status === "waiting" ? "awaiting_approval" : run.status === "in_progress" ? "running" : "queued";
      // Workflow success alone never proves app health. Only its verified D1 finalization succeeds.
      await db(env).prepare("UPDATE web_update_requests SET state = ?, error_code = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state NOT IN ('succeeded','failed','expired','recovery_required')" + (run.status === "completed" ? "" : " AND state != 'verifying'"))
        .bind(state, state === "recovery_required" ? "workflow_incomplete" : state === "failed" ? "preflight_failed" : null, now, row.id).run();
    }
  }
  return updateView(await requestRow(env, row.id), env);
}

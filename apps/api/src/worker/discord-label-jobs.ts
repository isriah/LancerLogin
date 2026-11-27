import { type D1Database } from "../d1-usage.ts";
import { type PassCost } from "../scheduler-budget.ts";
import { HttpError } from "../http-error.ts";
import { DiscordRateLimitError } from "../discord-rate-limit.ts";
import { confirmTwoWay, disableTwoWay, pollTwoWayLabels, previewTwoWay, twoWayLabelsToCheck, unmatchedRoleMembers, type TwoWayDependencies, type TwoWayServer } from "../discord-label-two-way.ts";
import { type Env, type ProviderConfiguration, type WorkerContext, parseJson, passAllows, passMore, previewResponse, requireDatabase, requireRole, response, writeAudit } from "./core.ts";
import { deliveryPausedUntil } from "./delivery.ts";
import { discordConfiguration, discordRequest } from "./discord-core.ts";
import { discordAccessibleRole, discordAllGuildMembers, discordLabelMapping, discordLabelSource, discordManageableRole, discordRoleAccess, discordRoleSnapshot } from "./discord-label-roles.ts";

export async function discordLabelJobStatus(request: Request, env: Env, jobId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const job = await db.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, status, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt FROM discord_label_role_jobs WHERE installation_id = 'primary' AND id = ?").bind(jobId).first<{ id: string; labelId: string; guildId: string; roleId: string; status: string; createdAt: string; updatedAt: string; completedAt?: string }>();
  if (!job) throw new HttpError(404, "Role sync job not found");
  const items = await db.prepare("SELECT discord_user_id AS discordUserId, action, status, attempts, last_error AS lastError FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ? ORDER BY action, discord_user_id").bind(jobId).all<{ discordUserId: string; action: string; status: string; attempts: number; lastError?: string }>();
  return response({ ...job, items: items.results ?? [] });
}
// Per pass: one Discord role request and 2 D1 queries per member, plus about 10 D1 queries and 2 Discord requests for
// the job itself. A rate limit ends the pass early. The job stays pending until its last member is done.
const DISCORD_LABEL_ROLE_ITEMS_PER_PASS = 8;
// One member's request and update, with room left for the job's closing count, update and audit.
const DISCORD_LABEL_ROLE_ITEM_COST: PassCost = { d1: 5, external: 1 };
// What a found job needs before its first member: the claim, the Discord settings, the mapping, the label's roster (2),
// the role check (3 Discord requests) and the members read. A job is claimed only when this and one member fit.
const DISCORD_LABEL_ROLE_JOB_START_COST: PassCost = { d1: 6 + (DISCORD_LABEL_ROLE_ITEM_COST.d1 ?? 0), external: 3 + (DISCORD_LABEL_ROLE_ITEM_COST.external ?? 0) };
// The pass a request starts for the jobs it just created runs in that request's invocation, so the two share the Workers
// Free limit of 50 subrequests. There a member costs 3 (the provider authority check, the Discord request and the update)
// on top of about 15 for the job, so that pass does fewer members; the dashboard's polling and the scheduler do the rest.
export const DISCORD_LABEL_ROLE_ITEMS_AFTER_REQUEST = 4;
// The one-label routes cost more before their pass starts, so their passes do fewer members. Sync to Discord and Retry
// failed use 18 subrequests themselves (42 with a pass of 3 members). Turning on two-way sync uses about 24 by itself
// and runs no pass of its own: with one it reached about 46 of 50, and a single rate-limited retry put it over. The
// role changes it queues are the label job's, which its response pokes (a Durable Object runs it within seconds; on
// the cron fallback the dashboard's polling and the next tick do).
export const DISCORD_LABEL_ROLE_ITEMS_AFTER_SINGLE_SYNC = 3;
/**
 * Runs the oldest due role sync job for up to `itemLimit` members. In a scheduled pass the job is claimed only when the
 * pass can still afford its checks and at least one member; otherwise it is left untouched and the pass reports more
 * work, so a slice never claims a job, changes nobody and releases it. Resolves "ran" when it claimed a job, "deferred"
 * when one was due but did not fit, and "none" when nothing was due.
 */
export async function processDiscordLabelRoleJobs(env: Env, targetJobId?: string, itemLimit = DISCORD_LABEL_ROLE_ITEMS_PER_PASS): Promise<"ran" | "deferred" | "none"> {
  if (await deliveryPausedUntil(env) !== null) return "none";
  const db = requireDatabase(env); const now = new Date().toISOString();
  const job = await db.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, source_fingerprint AS sourceFingerprint, actor_user_id AS actorUserId FROM discord_label_role_jobs WHERE installation_id = 'primary' AND status IN ('pending', 'running') AND next_attempt_at <= ? AND (lease_token IS NULL OR lease_expires_at <= ?) AND (? IS NULL OR id = ?) ORDER BY created_at LIMIT 1").bind(now, now, targetJobId ?? null, targetJobId ?? null).first<{ id: string; labelId: string; guildId: string; roleId: string; sourceFingerprint: string; actorUserId?: string }>();
  if (!job) return "none";
  // A failed check marks the pass as having more work, so the scheduler brings this job back in a fresh slice.
  if (!passAllows(env, DISCORD_LABEL_ROLE_JOB_START_COST)) return "deferred";
  const lease = crypto.randomUUID(); const leaseExpires = new Date(Date.now() + 90_000).toISOString();
  const claim = await db.prepare("UPDATE discord_label_role_jobs SET status = 'running', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND status IN ('pending', 'running') AND (lease_token IS NULL OR lease_expires_at <= ?)").bind(lease, leaseExpires, now, job.id, now).run();
  if ((claim.meta?.changes ?? 0) !== 1) return "none";
  let nextAttempt = new Date().toISOString();
  try {
    const config = await discordConfiguration(env); const mapping = await discordLabelMapping(db, job.labelId);
    if (config.guildId !== job.guildId || mapping.roleId !== job.roleId || (await discordLabelSource(db, mapping, config.guildId)).sourceFingerprint !== job.sourceFingerprint) {
      await db.prepare("UPDATE discord_label_role_jobs SET status = 'stale', lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE installation_id = 'primary' AND id = ? AND lease_token = ?").bind(new Date().toISOString(), new Date().toISOString(), job.id, lease).run();
      if (job.actorUserId) await writeAudit(db, { userId: job.actorUserId, role: "admin", expiresAt: 0 }, "discord.label_role_sync_stale", "member_label", job.labelId, { jobId: job.id, roleId: job.roleId });
      return "ran";
    }
    await discordManageableRole(config, job.roleId);
    const rows = await db.prepare("SELECT discord_user_id AS discordUserId, action, attempts FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ? AND status = 'pending' ORDER BY discord_user_id LIMIT ?").bind(job.id, itemLimit).all<{ discordUserId: string; action: "add" | "remove"; attempts: number }>();
    for (const item of rows.results ?? []) {
      if (!passAllows(env, DISCORD_LABEL_ROLE_ITEM_COST)) break;
      const path = `/guilds/${job.guildId}/members/${item.discordUserId}/roles/${job.roleId}`;
      try {
        await discordRequest(config, path, { method: item.action === "add" ? "PUT" : "DELETE", headers: { "x-audit-log-reason": encodeURIComponent(`LancerLogin label sync ${job.id}`) } });
        await db.prepare("UPDATE discord_label_role_job_items SET status = 'completed', attempts = attempts + 1, last_error = NULL WHERE installation_id = 'primary' AND job_id = ? AND discord_user_id = ? AND status = 'pending'").bind(job.id, item.discordUserId).run();
      } catch (error) {
        if (error instanceof DiscordRateLimitError) { nextAttempt = new Date(Date.now() + error.retryAfterMs).toISOString(); break; }
        await db.prepare("UPDATE discord_label_role_job_items SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE installation_id = 'primary' AND job_id = ? AND discord_user_id = ? AND status = 'pending'").bind((error as Error).message.slice(0, 300), job.id, item.discordUserId).run();
      }
    }
  } catch (error) {
    if (error instanceof DiscordRateLimitError) nextAttempt = new Date(Date.now() + error.retryAfterMs).toISOString();
    else {
      await db.prepare("UPDATE discord_label_role_jobs SET status = 'partial', lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE installation_id = 'primary' AND id = ? AND lease_token = ?").bind(new Date().toISOString(), new Date().toISOString(), job.id, lease).run();
      await db.prepare("UPDATE discord_label_role_job_items SET status = 'failed', last_error = ? WHERE installation_id = 'primary' AND job_id = ? AND status = 'pending'").bind((error as Error).message.slice(0, 300), job.id).run();
      if (job.actorUserId) await writeAudit(db, { userId: job.actorUserId, role: "admin", expiresAt: 0 }, "discord.label_role_sync_partial", "member_label", job.labelId, { jobId: job.id, roleId: job.roleId, error: (error as Error).message.slice(0, 300) });
      return "ran";
    }
  }
  const counts = await db.prepare("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ?").bind(job.id).first<{ pending: number; failed: number }>();
  const status = counts?.pending ? "pending" : counts?.failed ? "partial" : "completed"; const finished = new Date().toISOString();
  if (status === "pending" && nextAttempt <= finished) passMore(env);
  await db.prepare("UPDATE discord_label_role_jobs SET status = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?, completed_at = ? WHERE installation_id = 'primary' AND id = ? AND lease_token = ?").bind(status, nextAttempt, finished, status === "pending" ? null : finished, job.id, lease).run();
  if (status !== "pending" && job.actorUserId) await writeAudit(db, { userId: job.actorUserId, role: "admin", expiresAt: 0 }, "discord.label_role_sync_finished", "member_label", job.labelId, { jobId: job.id, roleId: job.roleId, status, failed: counts?.failed ?? 0 });
  return "ran";
}
/**
 * The scheduled label job: queued role changes first, then the two-way check.
 *
 * Role changes come first so the check can never use up the budget a queued job needs. With several two-way labels the
 * check used to take most of a Durable Object slice before the job ran, leaving it no room for one member, so every
 * slice claimed the job, changed nobody and asked for another slice. On the Durable Object a slice that runs a role job
 * does nothing else and asks for another slice, where the check runs; a job the check queues runs in the slice after.
 * The cron fallback's larger pass does all three in one go.
 */
export async function processDiscordLabelRoles(env: Env): Promise<void> {
  const steps = env.schedulerPass?.steps === true;
  const roleJob = await processDiscordLabelRoleJobs(env);
  if (roleJob === "deferred" || (roleJob === "ran" && steps)) { passMore(env); return; }
  const queued = await processDiscordTwoWayLabels(env);
  if (!queued) return;
  if (steps) passMore(env); else await processDiscordLabelRoleJobs(env);
}
export async function discordLabelAdvance(request: Request, env: Env, jobId: string): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const job = await requireDatabase(env).prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND id = ?").bind(jobId).first();
  if (!job) throw new HttpError(404, "Role sync job not found");
  await processDiscordLabelRoleJobs(env, jobId);
  return discordLabelJobStatus(request, env, jobId);
}
export async function discordLabelRetry(request: Request, env: Env, jobId: string, context?: WorkerContext): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const old = await db.prepare("SELECT id, label_id AS labelId, role_id AS roleId, status FROM discord_label_role_jobs WHERE installation_id = 'primary' AND id = ?").bind(jobId).first<{ id: string; labelId: string; roleId: string; status: string }>();
  if (!old || old.status !== "partial") throw new HttpError(409, "Only a partially failed role sync can be retried");
  if (await db.prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running')").bind(old.labelId).first()) throw new HttpError(409, "A sync for this label is already in progress");
  const config = await discordConfiguration(env); const snapshot = await discordRoleSnapshot(db, config, old.labelId);
  if (snapshot.mapping.roleId !== old.roleId) throw new HttpError(409, "The role association changed. Preview a new sync.");
  const failed = await db.prepare("SELECT discord_user_id AS discordUserId, action FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ? AND status = 'failed'").bind(jobId).all<{ discordUserId: string; action: string }>();
  const wanted = new Map([...snapshot.additions.map((item) => [item.discordUserId, "add"] as const), ...snapshot.removals.map((item) => [item.discordUserId, "remove"] as const)]);
  const changes = (failed.results ?? []).filter((item) => wanted.get(item.discordUserId) === item.action);
  if (!changes.length) return response({ retried: 0, resolved: (failed.results ?? []).length });
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO discord_label_role_jobs (id, installation_id, label_id, guild_id, role_id, status, source_fingerprint, actor_user_id, next_attempt_at, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").bind(id, old.labelId, config.guildId, old.roleId, snapshot.sourceFingerprint, principal.userId, now, now, now),
    ...changes.map((item) => db.prepare("INSERT INTO discord_label_role_job_items (installation_id, job_id, discord_user_id, action, status) VALUES ('primary', ?, ?, ?, 'pending')").bind(id, item.discordUserId, item.action)),
  ]);
  await writeAudit(db, principal, "discord.label_role_sync_retried", "member_label", old.labelId, { fromJobId: jobId, jobId: id, retried: changes.length });
  if (context) context.waitUntil(processDiscordLabelRoleJobs(env, undefined, DISCORD_LABEL_ROLE_ITEMS_AFTER_SINGLE_SYNC));
  return response({ jobId: id, retried: changes.length, resolved: (failed.results ?? []).length - changes.length }, 202);
}
/** The server as two-way sync needs it: its roles and members loaded once. */
async function discordTwoWayServer(db: D1Database, config: ProviderConfiguration): Promise<{ server: TwoWayServer; deps: TwoWayDependencies }> {
  const [access, guildMembers] = await Promise.all([discordRoleAccess(config), discordAllGuildMembers(config)]);
  const server: TwoWayServer = { guildId: config.guildId, guildMembers, roleName: (roleId) => access.roles.find((role) => role.id === roleId)?.name, roleProblem: (roleId) => { try { discordAccessibleRole(access, config, roleId); return undefined; } catch (error) { return (error as Error).message; } } };
  return { server, deps: { sourceFingerprint: async (labelId) => (await discordLabelSource(db, await discordLabelMapping(db, labelId), config.guildId)).sourceFingerprint } };
}
/**
 * The scheduled two-way check. Discord is called only when an active two-way label has no role sync pending or
 * running: such a label is left out by the one query that lists the labels, and when every two-way label is syncing
 * the server is not loaded at all. Resolves whether the check queued role changes.
 */
// Per pass: one load of the server's roles and members, then about 10 D1 queries for each label checked.
const DISCORD_TWO_WAY_LABELS_PER_PASS = 2;
const DISCORD_TWO_WAY_LABEL_COST: PassCost = { d1: 12 };
// The Discord settings, the role check and one page of members (4 requests), with room for the first label.
const DISCORD_TWO_WAY_START_COST: PassCost = { d1: 1 + (DISCORD_TWO_WAY_LABEL_COST.d1 ?? 0), external: 4 };
async function processDiscordTwoWayLabels(env: Env): Promise<boolean> {
  if (await deliveryPausedUntil(env) !== null) return false;
  const db = requireDatabase(env);
  const labelIds = await twoWayLabelsToCheck(db);
  if (!labelIds.length || !passAllows(env, DISCORD_TWO_WAY_START_COST)) return false;
  let config: ProviderConfiguration;
  // Disabled or unverified Discord pauses two-way checks until it is verified again.
  try { config = await discordConfiguration(env); } catch (error) { if (error instanceof HttpError && error.status === 503) return false; throw error; }
  const { server, deps } = await discordTwoWayServer(db, config);
  // The cron fallback runs the role job a check queues later in the same pass, and D1 queries and Discord requests
  // share one limit, so there a further label is checked only while that job could still start afterwards. On the
  // Durable Object the job has the next slice to itself.
  const labelCost: PassCost = env.schedulerPass?.steps ? DISCORD_TWO_WAY_LABEL_COST : { d1: (DISCORD_TWO_WAY_LABEL_COST.d1 ?? 0) + (DISCORD_LABEL_ROLE_JOB_START_COST.d1 ?? 0), external: DISCORD_LABEL_ROLE_JOB_START_COST.external ?? 0 };
  let first = true;
  const results = await pollTwoWayLabels(db, server, deps, DISCORD_TWO_WAY_LABELS_PER_PASS, () => { const cost = first ? DISCORD_TWO_WAY_LABEL_COST : labelCost; first = false; return passAllows(env, cost); }, labelIds);
  return results.some((result) => Boolean(result.jobId));
}
export async function discordTwoWayPreview(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ labelId?: string }>(request);
  if (typeof input.labelId !== "string" || !input.labelId) throw new HttpError(400, "Choose a label to review");
  const db = requireDatabase(env); const { server, deps } = await discordTwoWayServer(db, await discordConfiguration(env));
  return previewResponse(await previewTwoWay(db, principal.userId, input.labelId, server, deps));
}
export async function discordTwoWayConfirm(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<Record<string, unknown>>(request);
  const db = requireDatabase(env); const { server, deps } = await discordTwoWayServer(db, await discordConfiguration(env));
  // The queued role changes run in the scheduler, not here: see DISCORD_LABEL_ROLE_ITEMS_AFTER_SINGLE_SYNC.
  return response(await confirmTwoWay(db, principal.userId, input, server, deps));
}
/** Turning two-way sync on needs a reviewed reconciliation, so this only switches a label back to Dashboard to Discord. */
export async function discordLabelDirection(request: Request, env: Env, labelId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ direction?: string }>(request);
  if (input.direction === "two_way") throw new HttpError(409, "Review the members whose label and role disagree before turning on two-way sync", undefined, "two_way_review_required");
  if (input.direction !== "to_discord") throw new HttpError(400, "Sync direction must be to_discord or two_way");
  return response(await disableTwoWay(requireDatabase(env), principal.userId, labelId));
}
export async function discordUnmatchedRoleMembers(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  return response(await unmatchedRoleMembers(requireDatabase(env)));
}

import { localDate as policyLocalDate } from "../attendance-policy.ts";
import { type D1Database, type D1Statement } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { coalescingDatabase } from "../d1-coalesce.ts";
import { forgetTwoWayStatements, isTwoWayPaused, sortRolesByName } from "../discord-label-two-way.ts";
import { type Env, type Principal, type WorkerContext, parseJson, previewResponse, requireDatabase, requireRole, response, writeAudit } from "./core.ts";
import { discordConfiguration } from "./discord-core.ts";
import { DISCORD_LABEL_ROLE_ITEMS_AFTER_REQUEST, DISCORD_LABEL_ROLE_ITEMS_AFTER_SINGLE_SYNC, processDiscordLabelRoleJobs } from "./discord-label-jobs.ts";
import { type DiscordGuildRole, type DiscordLabelMapping, type DiscordLabelSet, type DiscordRoleAccess, type DiscordRoleSnapshot, discordAccessibleRole, discordAllGuildMembers, discordLabelMapping, discordLabelSources, discordManageableRole, discordRoleAccess, discordRoleSnapshot, discordRoleSnapshotFrom, discordSnowflake } from "./discord-label-roles.ts";
import { integrationRecord } from "./integration-support.ts";

export async function discordLabelMappings(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const rows = await db.prepare("SELECT x.label_id AS labelId, l.name AS labelName, l.active, x.guild_id AS guildId, x.role_id AS roleId, x.role_name AS roleName, x.created_at AS createdAt, x.sync_direction AS syncDirection, x.two_way_enabled_at AS twoWayEnabledAt, x.two_way_checked_at AS twoWayCheckedAt, x.two_way_error AS twoWayError FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' ORDER BY l.name COLLATE NOCASE").all<DiscordLabelMapping>();
  const integration = await integrationRecord(env, "discord"); const available = Boolean(integration && integration.enabled !== 0 && integration.verifiedAt);
  let config: Record<string, string> | undefined; let access: DiscordRoleAccess | undefined; let accessError = "";
  if (available) config = await discordConfiguration(env);
  if (config && rows.results?.length) try { access = await discordRoleAccess(config); } catch (error) { accessError = (error as Error).message; }
  const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string }>(); const timeZone = settings?.timeZone ?? "UTC"; const today = policyLocalDate(new Date().toISOString(), timeZone);
  // Each label's latest role sync job with its progress, for every label in one query. The page shows a job the
  // scheduler queued (a two-way check) as syncing, and one that makes no progress as stuck.
  const latestJobs = await db.prepare("SELECT latest.labelId, latest.id, latest.status, latest.createdAt, latest.updatedAt, latest.completedAt, (SELECT COUNT(*) FROM discord_label_role_job_items i WHERE i.installation_id = 'primary' AND i.job_id = latest.id) AS total, (SELECT COUNT(*) FROM discord_label_role_job_items i WHERE i.installation_id = 'primary' AND i.job_id = latest.id AND i.status = 'completed') AS completed, (SELECT COUNT(*) FROM discord_label_role_job_items i WHERE i.installation_id = 'primary' AND i.job_id = latest.id AND i.status = 'failed') AS failed FROM (SELECT j.label_id AS labelId, j.id, j.status, j.created_at AS createdAt, j.updated_at AS updatedAt, j.completed_at AS completedAt, ROW_NUMBER() OVER (PARTITION BY j.label_id ORDER BY j.created_at DESC) AS position FROM discord_label_role_jobs j WHERE j.installation_id = 'primary') latest WHERE latest.position = 1").all<{ labelId: string; id: string; status: string; createdAt: string; updatedAt: string; completedAt?: string; total: number; completed: number; failed: number }>();
  const latestByLabel = new Map((latestJobs.results ?? []).map(({ labelId, ...job }) => [labelId, { ...job, total: Number(job.total), completed: Number(job.completed), failed: Number(job.failed) }]));
  const mappings = await Promise.all((rows.results ?? []).map(async (stored) => {
    // A label paused after a restore is reported as paused; its reserved marker is not a check failure.
    const mapping = isTwoWayPaused(stored) ? { ...stored, twoWayPaused: true, twoWayError: null } : stored;
    const latest = latestByLabel.get(mapping.labelId);
    // Label changes recorded after the last sync, or dated changes that took effect since then. Pairing changes are not tracked here.
    const changed = latest && await db.prepare("SELECT 1 FROM member_label_changes WHERE installation_id = 'primary' AND label_id = ? AND (created_at > ? OR (effective_date > ? AND effective_date <= ?)) LIMIT 1").bind(mapping.labelId, latest.createdAt, policyLocalDate(latest.createdAt, timeZone), today).first();
    const syncState = !latest || mapping.createdAt > latest.createdAt ? "never_synced" : changed ? "label_changes" : "no_label_changes";
    if (!config || !mapping.active) return { ...mapping, health: !mapping.active ? "retired" : "integration_unavailable", syncState, latestJob: latest };
    if (mapping.guildId !== config.guildId) return { ...mapping, health: "different_server", syncState, latestJob: latest };
    try { if (!access) throw new HttpError(502, accessError || "Discord roles are unavailable"); const role = discordAccessibleRole(access, config, mapping.roleId); return { ...mapping, roleName: role.name, health: "ready", syncState, latestJob: latest }; }
    catch (error) { return { ...mapping, health: "unavailable", healthDetail: (error as Error).message, syncState, latestJob: latest }; }
  }));
  return response({ mappings, integrationAvailable: available });
}
export async function discordLabelUnlink(request: Request, env: Env, labelId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const mapping = await discordLabelMapping(db, labelId, false);
  const active = await db.prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running')").bind(labelId).first();
  if (active) throw new HttpError(409, "Wait for this role sync to finish before unlinking the role");
  await db.batch([db.prepare("DELETE FROM discord_label_role_mappings WHERE installation_id = 'primary' AND label_id = ?").bind(labelId), ...forgetTwoWayStatements(db, labelId)]);
  await writeAudit(db, principal, "discord.label_role_unlinked", "member_label", labelId, { guildId: mapping.guildId, roleId: mapping.roleId });
  return response({ unlinked: true, roleAssignmentsUnchanged: true });
}
/** A reviewed snapshot as the preview the dashboard shows, with the statement that stores it for ten minutes. */
function discordLabelPreviewRecord(db: D1Database, principal: Principal, config: Record<string, string>, snapshot: DiscordRoleSnapshot) {
  const id = crypto.randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const statement = db.prepare("INSERT INTO discord_label_role_previews (id, installation_id, label_id, guild_id, role_id, fingerprint, actor_user_id, expires_at, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)").bind(id, snapshot.mapping.labelId, config.guildId, snapshot.mapping.roleId, snapshot.fingerprint, principal.userId, expiresAt, now.toISOString());
  return { statement, preview: { previewId: id, expiresAt, labelId: snapshot.mapping.labelId, labelName: snapshot.mapping.labelName, roleId: snapshot.mapping.roleId, roleName: snapshot.roleName, memberCount: snapshot.memberCount, additions: snapshot.additions, removals: snapshot.removals, unpaired: snapshot.unpaired, absent: snapshot.absent, inactive: snapshot.inactive } };
}
async function saveDiscordLabelPreview(db: D1Database, principal: Principal, config: Record<string, string>, snapshot: DiscordRoleSnapshot) {
  const { statement, preview } = discordLabelPreviewRecord(db, principal, config, snapshot);
  await statement.run();
  return preview;
}
export async function discordLabelPreview(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ labelId?: string }>(request);
  if (!input.labelId) throw new HttpError(400, "Choose a label to preview");
  const db = requireDatabase(env); const config = await discordConfiguration(env); const snapshot = await discordRoleSnapshot(db, config, input.labelId);
  if (snapshot.mapping.syncDirection === "two_way") throw new HttpError(409, `${snapshot.mapping.labelName} syncs both ways, so Discord is checked every 5 minutes. A full-server sync would also remove the role from Discord users who aren't on the roster.`);
  return previewResponse(await saveDiscordLabelPreview(db, principal, config, snapshot));
}
/**
 * Previews every active linked label from one load of the server's roles and members. D1 use does not grow with the
 * number of labels: one read lists them, one batch reads their rosters and one batch stores every preview, or none.
 */
export async function discordLabelPreviewAll(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const config = await discordConfiguration(env);
  const rows = await db.prepare("SELECT x.label_id AS labelId, l.name AS labelName FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND l.active = 1 AND x.guild_id = ? AND x.sync_direction = 'to_discord' ORDER BY l.name COLLATE NOCASE").bind(config.guildId).all<{ labelId: string; labelName: string }>();
  if (!rows.results?.length) throw new HttpError(409, "No active Dashboard to Discord labels are linked to roles in this Discord server");
  const labels: DiscordLabelSet = { sql: "SELECT value FROM json_each(?)", values: [JSON.stringify(rows.results.map((row) => row.labelId))] };
  const [sources, access, guildMembers] = await Promise.all([discordLabelSources(coalescingDatabase(db), labels), discordRoleAccess(config), discordAllGuildMembers(config)]);
  const records = []; const skipped: { labelId: string; labelName: string; reason: string }[] = [];
  for (const row of rows.results) {
    try { records.push(discordLabelPreviewRecord(db, principal, config, await discordRoleSnapshotFrom(sources, config, row.labelId, { access, guildMembers }))); }
    catch (error) { if (!(error instanceof HttpError)) throw error; skipped.push({ ...row, reason: error.message }); }
  }
  if (records.length) await db.batch(records.map((record) => record.statement));
  return previewResponse({ previews: records.map((record) => record.preview), skipped });
}
export async function discordLabelApply(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ previewId?: string }>(request);
  if (!input.previewId) throw new HttpError(400, "A current role sync preview is required");
  const db = requireDatabase(env); const config = await discordConfiguration(env);
  const result = await applyDiscordLabelPreview(db, principal, config, input.previewId);
  if (result.status === "pending" && context) context.waitUntil(processDiscordLabelRoleJobs(env, undefined, DISCORD_LABEL_ROLE_ITEMS_AFTER_SINGLE_SYNC));
  return response(result, 202);
}
/**
 * Starts sync jobs for several reviewed previews. Each preview is checked against the server as it is now. D1 use does not
 * grow with the number of previews: one batch reads them with their labels' rosters, and one batch claims every accepted
 * preview and writes its job, members and audit entry, so a failure leaves no preview used and no job started.
 */
export async function discordLabelApplyAll(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ previewIds?: string[] }>(request);
  if (!Array.isArray(input.previewIds) || input.previewIds.length < 1 || input.previewIds.length > 100 || input.previewIds.some((id) => typeof id !== "string") || new Set(input.previewIds).size !== input.previewIds.length) throw new HttpError(400, "Current role sync previews are required");
  const db = requireDatabase(env); const config = await discordConfiguration(env); const reads = coalescingDatabase(db);
  const previewIds = JSON.stringify(input.previewIds);
  const labels: DiscordLabelSet = { sql: "SELECT p.label_id FROM discord_label_role_previews p WHERE p.installation_id = 'primary' AND p.id IN (SELECT value FROM json_each(?))", values: [previewIds] };
  type StoredPreview = { id: string; labelId: string; guildId: string; roleId: string; fingerprint: string; actorUserId: string; expiresAt: string; usedAt?: string };
  const [previewRows, activeRows, sources, access, guildMembers] = await Promise.all([
    reads.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, fingerprint, actor_user_id AS actorUserId, expires_at AS expiresAt, used_at AS usedAt FROM discord_label_role_previews WHERE installation_id = 'primary' AND id IN (SELECT value FROM json_each(?))").bind(previewIds).all<StoredPreview>(),
    reads.prepare(`SELECT label_id AS labelId FROM discord_label_role_jobs WHERE installation_id = 'primary' AND status IN ('pending', 'running') AND label_id IN (${labels.sql})`).bind(...labels.values).all<{ labelId: string }>(),
    discordLabelSources(reads, labels), discordRoleAccess(config), discordAllGuildMembers(config),
  ]);
  const stored = new Map((previewRows.results ?? []).map((preview) => [preview.id, preview]));
  const syncing = new Set((activeRows.results ?? []).map((job) => job.labelId));
  const snapshots = new Map<string, Promise<DiscordRoleSnapshot>>();
  const now = new Date().toISOString(); const jobExists = "EXISTS (SELECT 1 FROM discord_label_role_jobs WHERE installation_id = 'primary' AND id = ?)";
  const accepted: { previewId: string; claim: number; job: { jobId: string; labelId: string; status: string; additions: number; removals: number } }[] = [];
  const failed: { previewId: string; error: string }[] = []; const statements: D1Statement[] = [];
  for (const previewId of input.previewIds) {
    try {
      const preview = stored.get(previewId);
      if (!preview || preview.actorUserId !== principal.userId || preview.usedAt || preview.expiresAt <= now) throw new HttpError(409, "This role sync preview expired or was already used. Preview again.");
      let pending = snapshots.get(preview.labelId); if (!pending) snapshots.set(preview.labelId, pending = discordRoleSnapshotFrom(sources, config, preview.labelId, { access, guildMembers }));
      const snapshot = await pending;
      if (preview.guildId !== config.guildId || preview.roleId !== snapshot.mapping.roleId || preview.fingerprint !== snapshot.fingerprint) throw new HttpError(409, "Roster or Discord roles changed since the preview. Preview again before syncing.");
      if (syncing.has(preview.labelId)) throw new HttpError(409, "A sync for this label is already in progress");
      const id = crypto.randomUUID(); const changes = [...snapshot.additions.map((item) => [item.discordUserId, "add"]), ...snapshot.removals.map((item) => [item.discordUserId, "remove"])];
      const status = changes.length ? "pending" : "completed"; if (changes.length) syncing.add(preview.labelId);
      // The job is written only while the preview is unused and the label has no running sync, and everything after it only
      // when the job exists, so a preview another request used first, or a sync it started, changes nothing here.
      statements.push(db.prepare("INSERT INTO discord_label_role_jobs (id, installation_id, label_id, guild_id, role_id, status, source_fingerprint, actor_user_id, next_attempt_at, created_at, updated_at, completed_at) SELECT ?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM discord_label_role_previews WHERE installation_id = 'primary' AND id = ? AND used_at IS NULL AND expires_at > ?) AND NOT EXISTS (SELECT 1 FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running'))").bind(id, preview.labelId, config.guildId, preview.roleId, status, snapshot.sourceFingerprint, principal.userId, now, now, now, changes.length ? null : now, preview.id, now, preview.labelId));
      accepted.push({ previewId, claim: statements.length, job: { jobId: id, labelId: preview.labelId, status, additions: snapshot.additions.length, removals: snapshot.removals.length } });
      statements.push(db.prepare(`UPDATE discord_label_role_previews SET used_at = ? WHERE installation_id = 'primary' AND id = ? AND used_at IS NULL AND ${jobExists}`).bind(now, preview.id, id));
      // One statement per job, whatever its number of members.
      if (changes.length) statements.push(db.prepare(`INSERT INTO discord_label_role_job_items (installation_id, job_id, discord_user_id, action, status) SELECT 'primary', ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), 'pending' FROM json_each(?) WHERE ${jobExists}`).bind(id, JSON.stringify(changes), id));
      statements.push(db.prepare(`INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'discord.label_role_sync_requested', 'member_label', ?, ?, ? WHERE ${jobExists}`).bind(crypto.randomUUID(), principal.userId, preview.labelId, JSON.stringify({ jobId: id, roleId: preview.roleId, adds: snapshot.additions.length, removals: snapshot.removals.length }), now, id));
    } catch (error) { if (!(error instanceof HttpError)) throw error; failed.push({ previewId, error: error.message }); }
  }
  const results = statements.length ? await db.batch(statements) : [];
  const jobs = [];
  for (const item of accepted) {
    if ((results[item.claim]?.meta?.changes ?? 0) === 1) jobs.push(item.job);
    else failed.push({ previewId: item.previewId, error: "This role sync preview was already used, or a sync for this label just started. Preview again." });
  }
  if (jobs.some((job) => job.status === "pending") && context) context.waitUntil(processDiscordLabelRoleJobs(env, undefined, DISCORD_LABEL_ROLE_ITEMS_AFTER_REQUEST));
  return response({ jobs, failed }, 202);
}
async function applyDiscordLabelPreview(db: D1Database, principal: Principal, config: Record<string, string>, previewId: string) {
  const preview = await db.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, fingerprint, actor_user_id AS actorUserId, expires_at AS expiresAt, used_at AS usedAt FROM discord_label_role_previews WHERE installation_id = 'primary' AND id = ?").bind(previewId).first<{ id: string; labelId: string; guildId: string; roleId: string; fingerprint: string; actorUserId: string; expiresAt: string; usedAt?: string }>();
  if (!preview || preview.actorUserId !== principal.userId || preview.usedAt || preview.expiresAt <= new Date().toISOString()) throw new HttpError(409, "This role sync preview expired or was already used. Preview again.");
  const snapshot = await discordRoleSnapshot(db, config, preview.labelId);
  if (preview.guildId !== config.guildId || preview.roleId !== snapshot.mapping.roleId || preview.fingerprint !== snapshot.fingerprint) throw new HttpError(409, "Roster or Discord roles changed since the preview. Preview again before syncing.");
  const active = await db.prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running')").bind(preview.labelId).first();
  if (active) throw new HttpError(409, "A sync for this label is already in progress");
  const now = new Date().toISOString(); const id = crypto.randomUUID(); const changes = [...snapshot.additions.map((item) => ({ ...item, action: "add" })), ...snapshot.removals.map((item) => ({ ...item, action: "remove" }))];
  const claimed = await db.prepare("UPDATE discord_label_role_previews SET used_at = ? WHERE installation_id = 'primary' AND id = ? AND used_at IS NULL AND expires_at > ?").bind(now, preview.id, now).run();
  if ((claimed.meta?.changes ?? 0) !== 1) throw new HttpError(409, "This role sync preview was already used");
  await db.batch([
    db.prepare("INSERT INTO discord_label_role_jobs (id, installation_id, label_id, guild_id, role_id, status, source_fingerprint, actor_user_id, next_attempt_at, created_at, updated_at, completed_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, preview.labelId, config.guildId, preview.roleId, changes.length ? "pending" : "completed", snapshot.sourceFingerprint, principal.userId, now, now, now, changes.length ? null : now),
    ...changes.map((item) => db.prepare("INSERT INTO discord_label_role_job_items (installation_id, job_id, discord_user_id, action, status) VALUES ('primary', ?, ?, ?, 'pending')").bind(id, item.discordUserId, item.action)),
  ]);
  await writeAudit(db, principal, "discord.label_role_sync_requested", "member_label", preview.labelId, { jobId: id, roleId: preview.roleId, adds: snapshot.additions.length, removals: snapshot.removals.length });
  return { jobId: id, labelId: preview.labelId, status: changes.length ? "pending" : "completed", additions: snapshot.additions.length, removals: snapshot.removals.length };
}
/** Lists the server's roles for the dashboard role pickers by name, with the reason any role cannot be linked. */
export async function discordGuildRoles(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const config = await discordConfiguration(env);
  const [access, links] = await Promise.all([discordRoleAccess(config), db.prepare("SELECT x.role_id AS roleId, x.label_id AS labelId, l.name AS labelName FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.guild_id = ?").bind(config.guildId).all<{ roleId: string; labelId: string; labelName: string }>()]);
  const linked = new Map((links.results ?? []).map((link) => [link.roleId, link]));
  const roles = sortRolesByName(access.roles.filter((role) => role.id !== config.guildId)).map((role) => {
    const problem = access.canManageRoles ? access.problem(role) : "The bot needs the Manage Roles permission";
    const link = linked.get(role.id);
    return { id: role.id, name: role.name, manageable: !problem, ...(problem ? { problem } : {}), ...(link ? { labelId: link.labelId, labelName: link.labelName } : {}) };
  });
  return response({ roles, canManageRoles: access.canManageRoles });
}
async function saveDiscordLabelMapping(db: D1Database, principal: Principal, label: { id: string; name: string }, role: DiscordGuildRole, guildId: string) {
  const conflict = await db.prepare("SELECT label_id AS labelId FROM discord_label_role_mappings WHERE installation_id = 'primary' AND (label_id = ? OR (guild_id = ? AND role_id = ?))").bind(label.id, guildId, role.id).first<{ labelId: string }>();
  if (conflict) throw new HttpError(409, conflict.labelId === label.id ? `${label.name} is already linked to a Discord role. Unlink it first.` : `${role.name} is already linked to another label. Unlink it first.`);
  const now = new Date().toISOString();
  try { await db.prepare("INSERT INTO discord_label_role_mappings (installation_id, label_id, guild_id, role_id, role_name, created_by, created_at) VALUES ('primary', ?, ?, ?, ?, ?, ?)").bind(label.id, guildId, role.id, role.name, principal.userId, now).run(); }
  catch (error) { if (/unique|constraint/i.test(String(error))) throw new HttpError(409, "That label or role was just linked by another Admin. Reload and review it."); throw error; }
  await writeAudit(db, principal, "discord.label_role_associated", "member_label", label.id, { guildId, roleId: role.id, source: "dashboard" });
  return { labelId: label.id, labelName: label.name, roleId: role.id, roleName: role.name };
}
/** Links an active label to a role the bot can manage. Linking alone changes nobody's roles. */
export async function discordLabelLink(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ labelId?: string; roleId?: string }>(request);
  if (typeof input.labelId !== "string" || !discordSnowflake(input.roleId)) throw new HttpError(400, "Choose a label and a Discord role");
  const db = requireDatabase(env); const config = await discordConfiguration(env);
  const label = await db.prepare("SELECT id, name FROM member_labels WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(input.labelId).first<{ id: string; name: string }>();
  if (!label) throw new HttpError(404, "Choose an active label");
  const role = await discordManageableRole(config, input.roleId);
  return response({ mapping: await saveDiscordLabelMapping(db, principal, label, role, config.guildId), roleAssignmentsUnchanged: true }, 201);
}
/**
 * Creates a label named after each chosen role, or reuses an unlinked active label with that name, and links them. Every
 * role is checked from one batch of reads and every label, link and audit entry is written in one batch, so D1 use does
 * not grow with the number of roles and a refused or failed import links nothing.
 */
export async function discordLabelsFromRoles(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ roleIds?: string[] }>(request);
  if (!Array.isArray(input.roleIds) || input.roleIds.length < 1 || input.roleIds.length > 25 || !input.roleIds.every(discordSnowflake) || new Set(input.roleIds).size !== input.roleIds.length) throw new HttpError(400, "Choose 1 to 25 Discord roles");
  const db = requireDatabase(env); const config = await discordConfiguration(env); const access = await discordRoleAccess(config);
  // Label names are unique ignoring ASCII case (SQLite NOCASE), so roles and labels are matched the same way here.
  const nameKey = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const chosen = input.roleIds.map((roleId) => {
    const role = discordAccessibleRole(access, config, roleId); const name = role.name.trim();
    if (!name || name.length > 80) throw new HttpError(400, `${role.name} cannot be a label name. Label names are 1 to 80 characters.`);
    return { role, name, key: nameKey(name) };
  });
  const repeated = chosen.find((item, index) => chosen.findIndex((other) => other.key === item.key) !== index);
  if (repeated) throw new HttpError(409, `More than one chosen role is named ${repeated.name}. Choose only one of them.`);
  // Check every role before writing so a bad choice leaves nothing half-linked.
  const names = JSON.stringify(chosen.map((item) => item.name)); const reads = coalescingDatabase(db);
  const namedLabels = "FROM json_each(?) j JOIN member_labels l ON l.installation_id = 'primary' AND l.name = j.value COLLATE NOCASE";
  const [labelRows, linkRows] = await Promise.all([
    reads.prepare(`SELECT l.id, l.name, l.active ${namedLabels}`).bind(names).all<{ id: string; name: string; active: number }>(),
    reads.prepare(`SELECT x.label_id AS labelId, x.guild_id AS guildId, x.role_id AS roleId FROM discord_label_role_mappings x WHERE x.installation_id = 'primary' AND ((x.guild_id = ? AND x.role_id IN (SELECT value FROM json_each(?))) OR x.label_id IN (SELECT l.id ${namedLabels}))`).bind(config.guildId, JSON.stringify(input.roleIds), names).all<{ labelId: string; guildId: string; roleId: string }>(),
  ]);
  const labels = new Map((labelRows.results ?? []).map((label) => [nameKey(label.name), label])); const links = linkRows.results ?? [];
  const now = new Date().toISOString(); const statements: D1Statement[] = []; const linked = [];
  const audit = (action: string, labelId: string, metadata: unknown) => db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, ?, 'member_label', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, action, labelId, JSON.stringify(metadata), now);
  for (const { role, name, key } of chosen) {
    const existing = labels.get(key);
    if (existing && !existing.active) throw new HttpError(409, `Restore the retired label ${existing.name} before linking it.`);
    if (links.some((link) => (link.guildId === config.guildId && link.roleId === role.id) || (existing && link.labelId === existing.id))) throw new HttpError(409, `${role.name} or its label is already linked. Unlink it first.`);
    const label = existing ?? { id: crypto.randomUUID(), name };
    if (!existing) statements.push(db.prepare("INSERT INTO member_labels (id, installation_id, name, formula_enabled, created_by, created_at) VALUES (?, 'primary', ?, 0, ?, ?)").bind(label.id, name, principal.userId, now), audit("label.created", label.id, { name, formulaEnabled: false, discordRoleId: role.id }));
    statements.push(db.prepare("INSERT INTO discord_label_role_mappings (installation_id, label_id, guild_id, role_id, role_name, created_by, created_at) VALUES ('primary', ?, ?, ?, ?, ?, ?)").bind(label.id, config.guildId, role.id, role.name, principal.userId, now), audit("discord.label_role_associated", label.id, { guildId: config.guildId, roleId: role.id, source: "dashboard" }));
    linked.push({ labelId: label.id, labelName: label.name, roleId: role.id, roleName: role.name, created: !existing });
  }
  try { await db.batch(statements); }
  catch (error) { if (/unique|constraint/i.test(String(error))) throw new HttpError(409, "One of these labels or roles was just created or linked by another Admin, so nothing was linked. Reload and review it."); throw error; }
  return response({ linked, roleAssignmentsUnchanged: true }, 201);
}

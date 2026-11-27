import { localDate as policyLocalDate } from "../attendance-policy.ts";
import { type D1Database } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { isTwoWayPaused, twoWayPausedMessage } from "../discord-label-two-way.ts";
import { DiscordPermissionError, type Principal, type Role, sha256 } from "./core.ts";
import { discordRequest } from "./discord-core.ts";

export type DiscordLabelMapping = { labelId: string; labelName: string; active: number; guildId: string; roleId: string; roleName: string; createdAt: string; syncDirection?: "to_discord" | "two_way"; twoWayEnabledAt?: string | null; twoWayCheckedAt?: string | null; twoWayError?: string | null; twoWayPaused?: boolean };
export type DiscordGuildRole = { id: string; name: string; position: number; permissions: string; managed?: boolean };
type DiscordGuildMember = { user?: { id?: string; username?: string }; nick?: string | null; roles?: string[] };
type DiscordRoleChange = { discordUserId: string; displayName: string; memberId?: string };
export type DiscordRoleSnapshot = { mapping: DiscordLabelMapping; sourceFingerprint: string; fingerprint: string; additions: DiscordRoleChange[]; removals: DiscordRoleChange[]; unpaired: { memberId: string; name: string }[]; absent: { memberId: string; name: string; discordUserId: string }[]; inactive: { memberId: string; name: string; discordUserId?: string }[]; roleName: string; memberCount: number };
export const discordSnowflake = (value: unknown): value is string => typeof value === "string" && /^\d{10,24}$/.test(value);
export async function discordLabelAdmin(db: D1Database, discordUserId: string): Promise<Principal> {
  const admin = await db.prepare("SELECT u.id AS userId, u.role FROM users u JOIN members m ON m.id = u.member_id AND m.installation_id = u.installation_id WHERE u.installation_id = 'primary' AND u.active = 1 AND u.role = 'admin' AND m.active = 1 AND m.discord_user_id = ?").bind(discordUserId).first<{ userId: string; role: Role }>();
  if (!admin) throw new HttpError(403, "Pair a roster member linked to an active LancerLogin Admin account before using /label.");
  return { ...admin, expiresAt: 0 };
}
export async function discordLabelMapping(db: D1Database, labelId: string, requireActive = true): Promise<DiscordLabelMapping> {
  const mapping = await db.prepare("SELECT x.label_id AS labelId, l.name AS labelName, l.active, x.guild_id AS guildId, x.role_id AS roleId, x.role_name AS roleName, x.created_at AS createdAt, x.sync_direction AS syncDirection, x.two_way_enabled_at AS twoWayEnabledAt, x.two_way_checked_at AS twoWayCheckedAt, x.two_way_error AS twoWayError FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.label_id = ?").bind(labelId).first<DiscordLabelMapping>();
  if (!mapping) throw new HttpError(404, "This label has no Discord role association");
  if (requireActive && !mapping.active) throw new HttpError(409, "Restore the retired label before syncing its Discord role");
  return mapping;
}
export type DiscordRoleAccess = { roles: DiscordGuildRole[]; canManageRoles: boolean; problem: (role: DiscordGuildRole) => string | undefined };
/** Loads the server's roles once and explains why the bot could not manage any one of them. */
export async function discordRoleAccess(config: Record<string, string>): Promise<DiscordRoleAccess> {
  const [rolesResult, botResult] = await Promise.all([
    discordRequest<DiscordGuildRole[]>(config, `/guilds/${config.guildId}/roles`, { method: "GET" }),
    discordRequest<{ id?: string }>(config, "/users/@me", { method: "GET" }),
  ]);
  if (!Array.isArray(rolesResult.body) || !discordSnowflake(botResult.body.id)) throw new HttpError(502, "Discord did not return valid role and bot identities");
  const roles = rolesResult.body;
  const bot = await discordRequest<DiscordGuildMember>(config, `/guilds/${config.guildId}/members/${botResult.body.id}`, { method: "GET" });
  const botRoles = roles.filter((item) => bot.body.roles?.includes(item.id));
  const highest = Math.max(0, ...botRoles.map((item) => item.position));
  const permissions = botRoles.reduce((value, item) => value | BigInt(item.permissions || "0"), BigInt(roles.find((item) => item.id === config.guildId)?.permissions || "0"));
  const canManageRoles = Boolean(permissions & (1n << 28n)) || Boolean(permissions & 8n);
  return { roles, canManageRoles, problem: (role) => role.id === config.guildId ? "This is the @everyone role" : role.managed ? "Managed by a bot or integration" : BigInt(role.permissions || "0") & (8n | 1n << 28n) ? "Has Administrator or Manage Roles permission" : !Number.isInteger(role.position) || role.position >= highest ? "Above the bot's highest role" : undefined };
}
const discordRoleProblemFixes: Record<string, string> = {
  "Managed by a bot or integration": "Choose a role that no bot or integration controls.",
  "Has Administrator or Manage Roles permission": "Remove Administrator and Manage Roles from it, or choose another role.",
  "Above the bot's highest role": "In Server Settings > Roles, drag the LancerLogin bot's role above it.",
};
export function discordAccessibleRole(access: DiscordRoleAccess, config: Record<string, string>, roleId: string): DiscordGuildRole {
  if (!discordSnowflake(roleId) || roleId === config.guildId) throw new HttpError(400, "Choose a manageable Discord role, not @everyone");
  const role = access.roles.find((item) => item.id === roleId);
  if (!role) throw new HttpError(409, "The mapped Discord role no longer exists");
  if (!access.canManageRoles) throw new DiscordPermissionError("roles");
  const problem = access.problem(role);
  if (problem) throw new HttpError(409, `LancerLogin can't manage the ${role.name} role: ${problem}. ${discordRoleProblemFixes[problem] ?? "Choose another role."}`);
  return role;
}
export async function discordManageableRole(config: Record<string, string>, roleId: string): Promise<DiscordGuildRole> {
  if (!discordSnowflake(roleId) || roleId === config.guildId) throw new HttpError(400, "Choose a manageable Discord role, not @everyone");
  return discordAccessibleRole(await discordRoleAccess(config), config, roleId);
}
export async function discordAllGuildMembers(config: Record<string, string>): Promise<DiscordGuildMember[]> {
  const members: DiscordGuildMember[] = []; let after = "0"; const seen = new Set<string>();
  for (let page = 0; page < 1000; page += 1) {
    const result = await discordRequest<DiscordGuildMember[]>(config, `/guilds/${config.guildId}/members?limit=1000&after=${after}`, { method: "GET" });
    if (!Array.isArray(result.body) || result.body.length > 1000) throw new HttpError(502, "Discord did not return a complete server member page");
    for (const member of result.body) {
      const id = member.user?.id;
      if (!discordSnowflake(id) || seen.has(id) || !Array.isArray(member.roles)) throw new HttpError(502, "Discord returned an incomplete or duplicate server member page");
      if (BigInt(id) <= BigInt(after)) throw new HttpError(502, "Discord returned a non-advancing server member page");
      seen.add(id); members.push(member); if (BigInt(id) > BigInt(after)) after = id;
    }
    if (result.body.length < 1000) return members;
  }
  throw new HttpError(502, "The Discord server member list exceeded the supported sync size. No role changes were made.");
}
export async function discordLabelSource(db: D1Database, mapping: DiscordLabelMapping, guildId: string) {
  if (mapping.guildId !== guildId) throw new HttpError(409, "This mapping belongs to a different Discord server. Unlink it before continuing.");
  const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string }>();
  const today = policyLocalDate(new Date().toISOString(), settings?.timeZone ?? "UTC");
  const result = await db.prepare("SELECT m.id, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id AS discordUserId, m.active, (SELECT c.action FROM member_label_changes c WHERE c.installation_id = m.installation_id AND c.member_id = m.id AND c.label_id = ? AND c.effective_date <= ? ORDER BY c.effective_date DESC, c.created_at DESC, c.id DESC LIMIT 1) AS labelAction FROM members m WHERE m.installation_id = 'primary' ORDER BY m.id").bind(mapping.labelId, today).all<DiscordLabelRosterRow>();
  const roster = result.results ?? [];
  return { roster, sourceFingerprint: await discordLabelSourceFingerprint(mapping, guildId, today, roster) };
}
type DiscordLabelRosterRow = { id: string; memberId: string; firstName: string; lastName: string; discordUserId?: string; active: number; labelAction?: string | null };
type DiscordLabelSourceState = { roster: DiscordLabelRosterRow[]; sourceFingerprint: string };
/** A job is stale once this differs, so every path that builds a label's roster must produce the same rows in the same order. */
const discordLabelSourceFingerprint = (mapping: DiscordLabelMapping, guildId: string, today: string, roster: DiscordLabelRosterRow[]) => sha256(JSON.stringify({ labelId: mapping.labelId, roleId: mapping.roleId, guildId, today, active: mapping.active, roster }));
type DiscordServerState = { access: DiscordRoleAccess; guildMembers: DiscordGuildMember[] };
/** A subquery that selects label IDs, with its bound values: the labels a bulk route works on. */
export type DiscordLabelSet = { sql: string; values: unknown[] };
type DiscordLabelSources = { mappings: Map<string, DiscordLabelMapping>; today: string; members: Omit<DiscordLabelRosterRow, "labelAction">[]; actions: Map<string, Map<string, string>> };
/**
 * The mapping and roster of every label in a set from four reads, however many labels it holds. Pass a coalescing
 * database so they share one D1 batch, which the Workers Free plan counts as one of its 50 subrequests per invocation.
 * discordLabelSource reads one label at a time; both must give the same roster and fingerprint.
 */
export async function discordLabelSources(reads: D1Database, labels: DiscordLabelSet): Promise<DiscordLabelSources> {
  // Label changes are read up to the latest date any time zone can be on, then cut to the installation's own date below.
  const latestLocalDate = new Date(Date.now() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const [mappingRows, settings, memberRows, changeRows] = await Promise.all([
    reads.prepare(`SELECT x.label_id AS labelId, l.name AS labelName, l.active, x.guild_id AS guildId, x.role_id AS roleId, x.role_name AS roleName, x.created_at AS createdAt, x.sync_direction AS syncDirection, x.two_way_enabled_at AS twoWayEnabledAt, x.two_way_checked_at AS twoWayCheckedAt, x.two_way_error AS twoWayError FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.label_id IN (${labels.sql})`).bind(...labels.values).all<DiscordLabelMapping>(),
    reads.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string }>(),
    reads.prepare("SELECT m.id, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id AS discordUserId, m.active FROM members m WHERE m.installation_id = 'primary' ORDER BY m.id").all<Omit<DiscordLabelRosterRow, "labelAction">>(),
    reads.prepare(`SELECT c.label_id AS labelId, c.member_id AS memberId, c.action, c.effective_date AS effectiveDate FROM member_label_changes c WHERE c.installation_id = 'primary' AND c.effective_date <= ? AND c.label_id IN (${labels.sql}) ORDER BY c.effective_date DESC, c.created_at DESC, c.id DESC`).bind(latestLocalDate, ...labels.values).all<{ labelId: string; memberId: string; action: string; effectiveDate: string }>(),
  ]);
  const today = policyLocalDate(new Date().toISOString(), settings?.timeZone ?? "UTC");
  // Rows arrive newest first, so the first one per label and member that is in effect today is the member's current action.
  const actions = new Map<string, Map<string, string>>();
  for (const change of changeRows.results ?? []) {
    if (change.effectiveDate > today) continue;
    let byMember = actions.get(change.labelId); if (!byMember) actions.set(change.labelId, byMember = new Map());
    if (!byMember.has(change.memberId)) byMember.set(change.memberId, change.action);
  }
  return { mappings: new Map((mappingRows.results ?? []).map((mapping) => [mapping.labelId, mapping])), today, members: memberRows.results ?? [], actions };
}
/** One label's snapshot from the bulk reads and one load of the server, refusing a label for the reasons discordRoleSnapshot does. */
export async function discordRoleSnapshotFrom(sources: DiscordLabelSources, config: Record<string, string>, labelId: string, server: DiscordServerState): Promise<DiscordRoleSnapshot> {
  const mapping = sources.mappings.get(labelId);
  if (!mapping) throw new HttpError(404, "This label has no Discord role association");
  if (!mapping.active) throw new HttpError(409, "Restore the retired label before syncing its Discord role");
  assertDiscordLabelNotPaused(mapping);
  const role = discordAccessibleRole(server.access, config, mapping.roleId);
  if (mapping.guildId !== config.guildId) throw new HttpError(409, "This mapping belongs to a different Discord server. Unlink it before continuing.");
  const labelActions = sources.actions.get(labelId);
  // The same columns in the same order as discordLabelSource's rows, so both paths fingerprint a roster identically.
  const roster = sources.members.map((member) => ({ id: member.id, memberId: member.memberId, firstName: member.firstName, lastName: member.lastName, discordUserId: member.discordUserId, active: member.active, labelAction: labelActions?.get(member.id) ?? null }));
  return discordRoleSnapshotOf(mapping, { roster, sourceFingerprint: await discordLabelSourceFingerprint(mapping, config.guildId, sources.today, roster) }, role, server.guildMembers);
}
function assertDiscordLabelNotPaused(mapping: DiscordLabelMapping): void {
  // A label paused after a restore changes nobody's role until an Admin reviews it again or switches it to Dashboard to Discord.
  if (isTwoWayPaused(mapping)) throw new HttpError(409, `${mapping.labelName}: ${twoWayPausedMessage} Or switch it to Dashboard to Discord.`, undefined, "two_way_review_required");
}
export async function discordRoleSnapshot(db: D1Database, config: Record<string, string>, labelId: string): Promise<DiscordRoleSnapshot> {
  const mapping = await discordLabelMapping(db, labelId);
  assertDiscordLabelNotPaused(mapping);
  const role = await discordManageableRole(config, mapping.roleId);
  const [source, guildMembers] = await Promise.all([discordLabelSource(db, mapping, config.guildId), discordAllGuildMembers(config)]);
  return discordRoleSnapshotOf(mapping, source, role, guildMembers);
}
/** What a sync would change: the label's roster compared with who holds the role in the server. */
async function discordRoleSnapshotOf(mapping: DiscordLabelMapping, source: DiscordLabelSourceState, role: DiscordGuildRole, guildMembers: DiscordGuildMember[]): Promise<DiscordRoleSnapshot> {
  const guild = new Map(guildMembers.map((member) => [member.user!.id!, member]));
  const qualified = new Map(source.roster.filter((member) => member.active && member.labelAction === "add" && member.discordUserId).map((member) => [member.discordUserId!, member]));
  const additions: DiscordRoleChange[] = []; const removals: DiscordRoleChange[] = [];
  for (const member of guildMembers) {
    const id = member.user!.id!; const hasRole = member.roles!.includes(mapping.roleId); const shouldHaveRole = qualified.has(id);
    const change = { discordUserId: id, displayName: member.nick || member.user?.username || id, ...(qualified.get(id) ? { memberId: qualified.get(id)!.memberId } : {}) };
    if (shouldHaveRole && !hasRole) additions.push(change);
    if (!shouldHaveRole && hasRole) removals.push(change);
  }
  const labeled = source.roster.filter((member) => member.labelAction === "add");
  const display = (member: typeof labeled[number]) => ({ memberId: member.memberId, name: `${member.firstName} ${member.lastName}`.trim() });
  const unpaired = labeled.filter((member) => member.active && !member.discordUserId).map(display);
  const absent = labeled.filter((member) => member.active && member.discordUserId && !guild.has(member.discordUserId)).map((member) => ({ ...display(member), discordUserId: member.discordUserId! }));
  const inactive = labeled.filter((member) => !member.active).map((member) => ({ ...display(member), discordUserId: member.discordUserId }));
  const fingerprint = await sha256(JSON.stringify({ source: source.sourceFingerprint, roleName: role.name, guild: guildMembers.map((member) => [member.user!.id, member.roles!.includes(mapping.roleId)]) }));
  return { mapping, sourceFingerprint: source.sourceFingerprint, fingerprint, additions, removals, unpaired, absent, inactive, roleName: role.name, memberCount: guildMembers.length };
}

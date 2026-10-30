// Two-way sync between a member label and its linked Discord role.
//
// A Dashboard to Discord label (the default) only pushes: an Admin previews and syncs. A two-way label is also checked by
// the scheduled pass. Each paired member has a last agreed state; whichever side differs from it changed since:
// - only Discord changed: the label follows the role, recorded as a label change from Discord dated today;
// - the dashboard changed (including both): the role follows the label through the existing role sync job.
// While a role sync job for the label is pending or running the label is skipped, so a push in flight is never read back
// as a Discord change. Discord users holding the role who are not on the roster are recorded and never changed.
// The Discord calls themselves stay in the Worker; this module receives the server's state already loaded.
//
// A restore brings a two-way label back paused: its stored direction is Dashboard to Discord and `two_way_error` holds
// `twoWayRestorePaused`. The scheduled pass, and a Worker deployed before this marker existed, check only labels stored as
// two-way, so a paused label is never read or pushed. Nothing changes in Discord or labels until an Admin reviews it again
// through the reconciliation preview and confirm (which re-creates the baseline and resumes) or switches it to Dashboard
// to Discord. A backup records a paused label as two-way, so restoring that backup pauses it again.
import type { D1Database, D1Statement } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { localDate } from "./attendance-policy.ts";

export type SyncDirection = "to_discord" | "two_way";
export type TwoWayChoice = "dashboard" | "discord";
export type TwoWayGuildMember = { user?: { id?: string; username?: string; global_name?: string | null }; nick?: string | null; roles?: string[] };
/** The Discord server as loaded once for a request or scheduled pass. */
export type TwoWayServer = {
  guildId: string;
  guildMembers: TwoWayGuildMember[];
  /** A message saying why the bot cannot manage this role, or undefined when it can. */
  roleProblem: (roleId: string) => string | undefined;
  roleName?: (roleId: string) => string | undefined;
};
export type TwoWayDependencies = {
  /** The role sync job fingerprint for the label as it is now, checked again before the job changes anyone's role. */
  sourceFingerprint: (labelId: string) => Promise<string>;
  now?: () => Date;
};
/** The reserved `two_way_error` of a label restored as two-way that waits for an Admin to review it again. */
export const twoWayRestorePaused = "restore_review_required";
export const twoWayPausedMessage = "Two-way sync paused after a restore. Review differences to turn it back on.";
export type TwoWayAction = "none" | "add_label" | "remove_label" | "add_role" | "remove_role";

/**
 * Which side wins for one paired member. `syncedState` is the last state both sides agreed on (undefined when the member
 * has none yet), and `dashboardChanged` reports a label change recorded or taking effect since then, even when it left
 * the label where it was. The dashboard wins whenever it changed; Discord wins only when it alone changed.
 */
export function decideTwoWay(input: { hasLabel: boolean; hasRole: boolean; syncedState?: boolean; dashboardChanged?: boolean }): TwoWayAction {
  if (input.hasLabel === input.hasRole) return "none";
  if (input.syncedState === undefined || input.dashboardChanged || input.hasLabel !== input.syncedState) return input.hasLabel ? "add_role" : "remove_role";
  return input.hasRole ? "add_label" : "remove_label";
}

/** Sorts Discord roles by name for every role picker, ignoring case and accents. */
export function sortRolesByName<T extends { name: string }>(roles: readonly T[]): T[] {
  return [...roles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
}

type TwoWayMapping = { labelId: string; labelName: string; active: number; guildId: string; roleId: string; roleName: string; syncDirection: SyncDirection; twoWayError?: string | null };
type LabelChangeRow = { id: string; memberId: string; action: "add" | "remove"; effectiveDate: string; createdAt: string };
export type TwoWayPair = { memberRowId: string; memberId: string; name: string; discordUserId: string; displayName: string; hasLabel: boolean; hasRole: boolean; changes: LabelChangeRow[] };
export type TwoWayUnmatched = { discordUserId: string; displayName: string };
type LabelState = { mapping: TwoWayMapping; timeZone: string; today: string; pairs: TwoWayPair[]; unmatched: TwoWayUnmatched[] };

const snowflake = (value: unknown): value is string => typeof value === "string" && /^\d{10,24}$/.test(value);
const displayName = (member: TwoWayGuildMember) => member.nick || member.user?.global_name || member.user?.username || member.user?.id || "";
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
const latestFirst = (a: LabelChangeRow, b: LabelChangeRow) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

async function readMapping(db: D1Database, labelId: string): Promise<TwoWayMapping> {
  const mapping = await db.prepare("SELECT x.label_id AS labelId, l.name AS labelName, l.active, x.guild_id AS guildId, x.role_id AS roleId, x.role_name AS roleName, x.sync_direction AS syncDirection, x.two_way_error AS twoWayError FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.label_id = ?").bind(labelId).first<TwoWayMapping>();
  if (!mapping) throw new HttpError(404, "This label has no Discord role association");
  return mapping;
}
function requireUsable(mapping: TwoWayMapping, server: TwoWayServer) {
  if (!mapping.active) throw new HttpError(409, "Restore the retired label before syncing its Discord role");
  if (mapping.guildId !== server.guildId) throw new HttpError(409, "This mapping belongs to a different Discord server. Unlink it before continuing.");
  const problem = server.roleProblem(mapping.roleId);
  if (problem) throw new HttpError(409, problem);
}
async function activeJob(db: D1Database, labelId: string) {
  return Boolean(await db.prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running')").bind(labelId).first());
}

/**
 * Pairs each active roster member linked to exactly one Discord account in the server with their label and role state.
 * Inactive members, members absent from the server and Discord accounts linked to several members are left out.
 */
async function labelState(db: D1Database, mapping: TwoWayMapping, server: TwoWayServer, now: Date): Promise<LabelState> {
  const [settings, members, changes] = await Promise.all([
    db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string }>(),
    db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, discord_user_id AS discordUserId, active FROM members WHERE installation_id = 'primary' ORDER BY id").all<{ id: string; memberId: string; firstName: string; lastName: string; discordUserId?: string | null; active: number }>(),
    db.prepare("SELECT id, member_id AS memberId, action, effective_date AS effectiveDate, created_at AS createdAt FROM member_label_changes WHERE installation_id = 'primary' AND label_id = ?").bind(mapping.labelId).all<LabelChangeRow>(),
  ]);
  const timeZone = settings?.timeZone ?? "UTC"; const today = localDate(now.toISOString(), timeZone);
  const byMember = new Map<string, LabelChangeRow[]>();
  for (const change of changes.results ?? []) byMember.set(change.memberId, [...(byMember.get(change.memberId) ?? []), change]);
  const roster = members.results ?? [];
  const linked = new Map<string, number>();
  for (const member of roster) if (member.discordUserId) linked.set(member.discordUserId, (linked.get(member.discordUserId) ?? 0) + 1);
  const guild = new Map<string, TwoWayGuildMember>();
  for (const member of server.guildMembers) if (snowflake(member.user?.id)) guild.set(member.user.id, member);
  const pairs: TwoWayPair[] = [];
  for (const member of roster) {
    const discord = member.discordUserId ? guild.get(member.discordUserId) : undefined;
    if (!member.active || !member.discordUserId || linked.get(member.discordUserId) !== 1 || !discord) continue;
    const own = (byMember.get(member.id) ?? []).sort(latestFirst);
    const current = own.find((change) => change.effectiveDate <= today);
    pairs.push({ memberRowId: member.id, memberId: member.memberId, name: `${member.firstName} ${member.lastName}`.trim(), discordUserId: member.discordUserId, displayName: displayName(discord), hasLabel: current?.action === "add", hasRole: Boolean(discord.roles?.includes(mapping.roleId)), changes: own });
  }
  const unmatched = server.guildMembers.filter((member) => snowflake(member.user?.id) && member.roles?.includes(mapping.roleId) && !linked.has(member.user!.id!)).map((member) => ({ discordUserId: member.user!.id!, displayName: displayName(member) }));
  return { mapping, timeZone, today, pairs, unmatched };
}
const changedSince = (pair: TwoWayPair, syncedAt: string, syncedOn: string, today: string) => pair.changes.some((change) => change.createdAt > syncedAt || (change.effectiveDate > syncedOn && change.effectiveDate <= today));

const labelChangeStatement = (db: D1Database, pair: TwoWayPair, labelId: string, action: "add" | "remove", today: string, at: string) =>
  // One dated change per member, label and day: a same-day change is replaced so the label ends where Discord is.
  db.prepare("INSERT INTO member_label_changes (id, installation_id, member_id, label_id, action, effective_date, created_by, created_at, source) VALUES (?, 'primary', ?, ?, ?, ?, NULL, ?, 'discord') ON CONFLICT (installation_id, member_id, label_id, effective_date) DO UPDATE SET action = excluded.action, created_by = NULL, created_at = excluded.created_at, source = 'discord'").bind(crypto.randomUUID(), pair.memberRowId, labelId, action, today, at);
const snapshotStatement = (db: D1Database, labelId: string, pair: TwoWayPair, state: boolean, at: string) =>
  db.prepare("INSERT INTO discord_label_two_way_members (installation_id, label_id, member_id, discord_user_id, synced_state, synced_at) VALUES ('primary', ?, ?, ?, ?, ?) ON CONFLICT (installation_id, label_id, member_id) DO UPDATE SET discord_user_id = excluded.discord_user_id, synced_state = excluded.synced_state, synced_at = excluded.synced_at").bind(labelId, pair.memberRowId, pair.discordUserId, state ? 1 : 0, at);
const unmatchedStatements = (db: D1Database, labelId: string, unmatched: TwoWayUnmatched[], at: string) => [
  db.prepare("DELETE FROM discord_label_unmatched_role_members WHERE installation_id = 'primary' AND label_id = ?").bind(labelId),
  ...unmatched.map((user) => db.prepare("INSERT INTO discord_label_unmatched_role_members (installation_id, label_id, discord_user_id, display_name, seen_at) VALUES ('primary', ?, ?, ?, ?)").bind(labelId, user.discordUserId, user.displayName.slice(0, 100), at)),
];
const auditStatement = (db: D1Database, actorUserId: string | null, action: string, labelId: string, metadata: unknown, at: string) =>
  db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, ?, 'member_label', ?, ?, ?)").bind(crypto.randomUUID(), actorUserId, action, labelId, JSON.stringify(metadata), at);

/** Queues role changes through the existing role sync job, which rechecks the label's fingerprint before each change. */
async function queueRoleChanges(db: D1Database, mapping: TwoWayMapping, guildId: string, changes: { discordUserId: string; action: "add" | "remove" }[], actorUserId: string | null, deps: TwoWayDependencies, at: string): Promise<string | undefined> {
  if (!changes.length) return;
  const id = crypto.randomUUID(); const fingerprint = await deps.sourceFingerprint(mapping.labelId);
  try {
    await db.batch([
      db.prepare("INSERT INTO discord_label_role_jobs (id, installation_id, label_id, guild_id, role_id, status, source_fingerprint, actor_user_id, next_attempt_at, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").bind(id, mapping.labelId, guildId, mapping.roleId, fingerprint, actorUserId, at, at, at),
      ...changes.map((item) => db.prepare("INSERT INTO discord_label_role_job_items (installation_id, job_id, discord_user_id, action, status) VALUES ('primary', ?, ?, ?, 'pending')").bind(id, item.discordUserId, item.action)),
    ]);
  } catch (error) {
    // Another sync for this label started first. The next scheduled pass pushes whatever is still needed.
    if (/unique|constraint/i.test(String(error))) return;
    throw error;
  }
  return id;
}

export type TwoWayPollResult = { labelId: string; status: "checked" | "busy" | "syncing" | "error"; labelsAdded: number; labelsRemoved: number; rolesAdded: number; rolesRemoved: number; unmatched: number; jobId?: string; error?: string };

export async function hasTwoWayLabels(db: D1Database): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.sync_direction = 'two_way' AND l.active = 1 LIMIT 1").first());
}

/** Checks every active two-way label against one load of the server's members. */
export async function pollTwoWayLabels(db: D1Database, server: TwoWayServer, deps: TwoWayDependencies): Promise<TwoWayPollResult[]> {
  const rows = await db.prepare("SELECT x.label_id AS labelId FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.sync_direction = 'two_way' AND l.active = 1 ORDER BY l.name COLLATE NOCASE").all<{ labelId: string }>();
  const results: TwoWayPollResult[] = [];
  for (const row of rows.results ?? []) results.push(await pollTwoWayLabel(db, row.labelId, server, deps));
  return results;
}

export async function pollTwoWayLabel(db: D1Database, labelId: string, server: TwoWayServer, deps: TwoWayDependencies): Promise<TwoWayPollResult> {
  const now = deps.now?.() ?? new Date(); const at = now.toISOString();
  const result: TwoWayPollResult = { labelId, status: "checked", labelsAdded: 0, labelsRemoved: 0, rolesAdded: 0, rolesRemoved: 0, unmatched: 0 };
  // An overlapping pass that finds the lease held leaves this label alone.
  const claim = await db.prepare("UPDATE discord_label_role_mappings SET two_way_lease_expires_at = ? WHERE installation_id = 'primary' AND label_id = ? AND sync_direction = 'two_way' AND (two_way_lease_expires_at IS NULL OR two_way_lease_expires_at <= ?)").bind(new Date(now.getTime() + 120_000).toISOString(), labelId, at).run();
  if ((claim.meta?.changes ?? 0) !== 1) return { ...result, status: "busy" };
  try {
    const mapping = await readMapping(db, labelId); requireUsable(mapping, server);
    if (await activeJob(db, labelId)) {
      await db.prepare("UPDATE discord_label_role_mappings SET two_way_lease_expires_at = NULL WHERE installation_id = 'primary' AND label_id = ?").bind(labelId).run();
      return { ...result, status: "syncing" };
    }
    const state = await labelState(db, mapping, server, now);
    const snapshots = new Map(((await db.prepare("SELECT member_id AS memberId, discord_user_id AS discordUserId, synced_state AS syncedState, synced_at AS syncedAt FROM discord_label_two_way_members WHERE installation_id = 'primary' AND label_id = ?").bind(labelId).all<{ memberId: string; discordUserId: string; syncedState: number; syncedAt: string }>()).results ?? []).map((row) => [row.memberId, row]));
    const statements: D1Statement[] = []; const roleChanges: { discordUserId: string; action: "add" | "remove" }[] = [];
    const paired = new Set<string>();
    for (const pair of state.pairs) {
      paired.add(pair.memberRowId);
      const stored = snapshots.get(pair.memberRowId);
      // A snapshot taken for another Discord account says nothing about this one.
      const snapshot = stored && stored.discordUserId === pair.discordUserId ? stored : undefined;
      const dashboardChanged = snapshot ? changedSince(pair, snapshot.syncedAt, localDate(snapshot.syncedAt, state.timeZone), state.today) : false;
      const action = decideTwoWay({ hasLabel: pair.hasLabel, hasRole: pair.hasRole, syncedState: snapshot ? Boolean(snapshot.syncedState) : undefined, dashboardChanged });
      if (action === "none") { if (!snapshot || Boolean(snapshot.syncedState) !== pair.hasLabel || dashboardChanged) statements.push(snapshotStatement(db, labelId, pair, pair.hasLabel, at)); }
      else if (action === "add_label" || action === "remove_label") {
        statements.push(labelChangeStatement(db, pair, labelId, action === "add_label" ? "add" : "remove", state.today, at), snapshotStatement(db, labelId, pair, pair.hasRole, at));
        if (action === "add_label") result.labelsAdded += 1; else result.labelsRemoved += 1;
      } else {
        roleChanges.push({ discordUserId: pair.discordUserId, action: action === "add_role" ? "add" : "remove" });
        if (action === "add_role") result.rolesAdded += 1; else result.rolesRemoved += 1;
      }
    }
    for (const memberId of snapshots.keys()) if (!paired.has(memberId)) statements.push(db.prepare("DELETE FROM discord_label_two_way_members WHERE installation_id = 'primary' AND label_id = ? AND member_id = ?").bind(labelId, memberId));
    statements.push(...unmatchedStatements(db, labelId, state.unmatched, at));
    if (result.labelsAdded + result.labelsRemoved) statements.push(auditStatement(db, null, "discord.label_two_way_applied", labelId, { roleId: mapping.roleId, labelsAdded: result.labelsAdded, labelsRemoved: result.labelsRemoved }, at));
    await db.batch(statements);
    result.unmatched = state.unmatched.length;
    result.jobId = await queueRoleChanges(db, mapping, server.guildId, roleChanges, null, deps, at);
    await db.prepare("UPDATE discord_label_role_mappings SET two_way_checked_at = ?, two_way_error = NULL, two_way_lease_expires_at = NULL WHERE installation_id = 'primary' AND label_id = ?").bind(at, labelId).run();
    return result;
  } catch (error) {
    const message = (error as Error).message.slice(0, 300);
    await db.prepare("UPDATE discord_label_role_mappings SET two_way_error = ?, two_way_checked_at = ?, two_way_lease_expires_at = NULL WHERE installation_id = 'primary' AND label_id = ?").bind(message, at, labelId).run();
    return { ...result, status: "error", error: message };
  }
}

export type AttendanceUsage = { affectsAttendance: boolean; attendanceRules: number; weeklyTargets: number; meetingAudiences: number };
/** How the label drives attendance: rules, weekly targets and meeting audiences that name it. */
export async function labelAttendanceUsage(db: D1Database, labelId: string): Promise<AttendanceUsage> {
  const [rules, audiences] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(CASE WHEN rule_type = 'weekly_count' THEN 0 ELSE 1 END), 0) AS attendanceRules, COALESCE(SUM(CASE WHEN rule_type = 'weekly_count' THEN 1 ELSE 0 END), 0) AS weeklyTargets FROM label_attendance_rules WHERE installation_id = 'primary' AND label_id = ?").bind(labelId).first<{ attendanceRules: number; weeklyTargets: number }>(),
    db.prepare("SELECT COUNT(*) AS meetingAudiences FROM meeting_audience_labels a JOIN meetings m ON m.id = a.meeting_id AND m.installation_id = a.installation_id WHERE a.installation_id = 'primary' AND a.label_id = ? AND m.deleted_at IS NULL").bind(labelId).first<{ meetingAudiences: number }>(),
  ]);
  const usage = { attendanceRules: Number(rules?.attendanceRules ?? 0), weeklyTargets: Number(rules?.weeklyTargets ?? 0), meetingAudiences: Number(audiences?.meetingAudiences ?? 0) };
  return { affectsAttendance: usage.attendanceRules + usage.weeklyTargets + usage.meetingAudiences > 0, ...usage };
}

export type TwoWayMismatch = { memberId: string; name: string; discordUserId: string; displayName: string; hasLabel: boolean; hasRole: boolean };
export type TwoWayPreview = { previewId: string; expiresAt: string; labelId: string; labelName: string; roleId: string; roleName: string; pairedCount: number; mismatches: TwoWayMismatch[]; unmatchedCount: number; attendance: AttendanceUsage };

async function reconciliationSnapshot(db: D1Database, labelId: string, server: TwoWayServer, deps: TwoWayDependencies, now: Date) {
  const mapping = await readMapping(db, labelId); requireUsable(mapping, server);
  if (mapping.syncDirection === "two_way") throw new HttpError(409, `${mapping.labelName} already syncs both ways`);
  if (await activeJob(db, labelId)) throw new HttpError(409, "Wait for this label's role sync to finish before turning on two-way sync");
  const state = await labelState(db, mapping, server, now);
  const fingerprint = await sha256(JSON.stringify({ source: await deps.sourceFingerprint(labelId), guildId: server.guildId, roleId: mapping.roleId, pairs: state.pairs.map((pair) => [pair.memberRowId, pair.discordUserId, pair.hasLabel, pair.hasRole]), unmatched: state.unmatched.map((user) => user.discordUserId) }));
  return { mapping, state, fingerprint };
}

/** Lists every paired member whose label and role disagree, and saves a preview the confirm step must match. */
export async function previewTwoWay(db: D1Database, actorUserId: string, labelId: string, server: TwoWayServer, deps: TwoWayDependencies): Promise<TwoWayPreview> {
  const now = deps.now?.() ?? new Date();
  const { mapping, state, fingerprint } = await reconciliationSnapshot(db, labelId, server, deps, now);
  const id = crypto.randomUUID(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await db.prepare("INSERT INTO discord_label_two_way_previews (id, installation_id, label_id, guild_id, role_id, fingerprint, actor_user_id, expires_at, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)").bind(id, labelId, server.guildId, mapping.roleId, fingerprint, actorUserId, expiresAt, now.toISOString()).run();
  const mismatches = state.pairs.filter((pair) => pair.hasLabel !== pair.hasRole).map((pair) => ({ memberId: pair.memberId, name: pair.name, discordUserId: pair.discordUserId, displayName: pair.displayName, hasLabel: pair.hasLabel, hasRole: pair.hasRole }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.memberId.localeCompare(b.memberId));
  return { previewId: id, expiresAt, labelId, labelName: mapping.labelName, roleId: mapping.roleId, roleName: server.roleName?.(mapping.roleId) ?? mapping.roleName, pairedCount: state.pairs.length, mismatches, unmatchedCount: state.unmatched.length, attendance: await labelAttendanceUsage(db, labelId) };
}

export type TwoWayConfirmInput = { previewId?: unknown; choices?: unknown; all?: unknown; acknowledgeAttendance?: unknown };
export type TwoWayConfirmResult = { enabled: true; labelId: string; syncDirection: "two_way"; labelsAdded: number; labelsRemoved: number; rolesAdded: number; rolesRemoved: number; jobId?: string };
const isChoice = (value: unknown): value is TwoWayChoice => value === "dashboard" || value === "discord";

/**
 * Applies the Admin's choice for each mismatch, stores the agreed baseline and turns on two-way sync. Label changes where
 * Discord was chosen are recorded as from Discord; roles where the dashboard was chosen change through a role sync job.
 */
export async function confirmTwoWay(db: D1Database, actorUserId: string, input: TwoWayConfirmInput, server: TwoWayServer, deps: TwoWayDependencies): Promise<TwoWayConfirmResult> {
  if (typeof input.previewId !== "string" || !input.previewId) throw new HttpError(400, "A current two-way sync preview is required");
  if (input.all !== undefined && !isChoice(input.all)) throw new HttpError(400, "For everyone must be dashboard or discord");
  const choices = input.choices ?? {};
  if (!choices || typeof choices !== "object" || Array.isArray(choices) || !Object.values(choices).every(isChoice)) throw new HttpError(400, "Each choice must be dashboard or discord");
  const now = deps.now?.() ?? new Date(); const at = now.toISOString();
  const preview = await db.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, fingerprint, actor_user_id AS actorUserId, expires_at AS expiresAt, used_at AS usedAt FROM discord_label_two_way_previews WHERE installation_id = 'primary' AND id = ?").bind(input.previewId).first<{ id: string; labelId: string; guildId: string; roleId: string; fingerprint: string; actorUserId: string; expiresAt: string; usedAt?: string | null }>();
  if (!preview || preview.actorUserId !== actorUserId || preview.usedAt || preview.expiresAt <= at) throw new HttpError(409, "This two-way sync review expired or was already used. Review again.");
  const { mapping, state, fingerprint } = await reconciliationSnapshot(db, preview.labelId, server, deps, now);
  if (preview.guildId !== server.guildId || preview.roleId !== mapping.roleId || preview.fingerprint !== fingerprint) throw new HttpError(409, "The roster, labels or Discord roles changed since this review. Review again before turning on two-way sync.");
  const mismatches = state.pairs.filter((pair) => pair.hasLabel !== pair.hasRole);
  const chosen = new Map(mismatches.map((pair) => [pair.memberRowId, (choices as Record<string, TwoWayChoice>)[pair.memberId] ?? (input.all as TwoWayChoice | undefined)]));
  const missing = mismatches.filter((pair) => !chosen.get(pair.memberRowId));
  if (missing.length) throw new HttpError(400, `Choose the correct side for ${missing.length} ${missing.length === 1 ? "person" : "people"}`);
  const attendance = await labelAttendanceUsage(db, mapping.labelId);
  if (attendance.affectsAttendance && input.acknowledgeAttendance !== true) throw new HttpError(409, `${mapping.labelName} affects attendance. Confirm that Discord role changes will change attendance requirements.`, undefined, "attendance_acknowledgement_required");
  const claimed = await db.prepare("UPDATE discord_label_two_way_previews SET used_at = ? WHERE installation_id = 'primary' AND id = ? AND used_at IS NULL AND expires_at > ?").bind(at, preview.id, at).run();
  if ((claimed.meta?.changes ?? 0) !== 1) throw new HttpError(409, "This two-way sync review was already used");
  const result: TwoWayConfirmResult = { enabled: true, labelId: mapping.labelId, syncDirection: "two_way", labelsAdded: 0, labelsRemoved: 0, rolesAdded: 0, rolesRemoved: 0 };
  const statements: D1Statement[] = [db.prepare("DELETE FROM discord_label_two_way_members WHERE installation_id = 'primary' AND label_id = ?").bind(mapping.labelId)];
  const roleChanges: { discordUserId: string; action: "add" | "remove" }[] = [];
  for (const pair of state.pairs) {
    const choice = chosen.get(pair.memberRowId);
    if (choice === "discord") {
      statements.push(labelChangeStatement(db, pair, mapping.labelId, pair.hasRole ? "add" : "remove", state.today, at), snapshotStatement(db, mapping.labelId, pair, pair.hasRole, at));
      if (pair.hasRole) result.labelsAdded += 1; else result.labelsRemoved += 1;
    } else if (choice === "dashboard") {
      // The baseline is Discord's current state, so until the role matches the label the dashboard reads as the side
      // that changed and later passes keep pushing it, never pulling the old role back into the label.
      statements.push(snapshotStatement(db, mapping.labelId, pair, pair.hasRole, at));
      roleChanges.push({ discordUserId: pair.discordUserId, action: pair.hasLabel ? "add" : "remove" });
      if (pair.hasLabel) result.rolesAdded += 1; else result.rolesRemoved += 1;
    } else statements.push(snapshotStatement(db, mapping.labelId, pair, pair.hasLabel, at));
  }
  statements.push(...unmatchedStatements(db, mapping.labelId, state.unmatched, at));
  statements.push(db.prepare("UPDATE discord_label_role_mappings SET sync_direction = 'two_way', two_way_enabled_at = ?, two_way_checked_at = ?, two_way_error = NULL, two_way_lease_expires_at = NULL WHERE installation_id = 'primary' AND label_id = ?").bind(at, at, mapping.labelId));
  statements.push(auditStatement(db, actorUserId, "discord.label_two_way_enabled", mapping.labelId, { roleId: mapping.roleId, previewId: preview.id, labelsAdded: result.labelsAdded, labelsRemoved: result.labelsRemoved, rolesAdded: result.rolesAdded, rolesRemoved: result.rolesRemoved, attendance }, at));
  await db.batch(statements);
  const jobId = await queueRoleChanges(db, mapping, server.guildId, roleChanges, actorUserId, deps, at);
  return jobId ? { ...result, jobId } : result;
}

/** Returns a label, two-way or paused after a restore, to Dashboard to Discord. Nobody's label or role changes. */
export async function disableTwoWay(db: D1Database, actorUserId: string, labelId: string): Promise<{ syncDirection: "to_discord" }> {
  const mapping = await readMapping(db, labelId); const at = new Date().toISOString();
  if (mapping.syncDirection !== "two_way" && !isTwoWayPaused(mapping)) return { syncDirection: "to_discord" };
  await db.batch([
    db.prepare("UPDATE discord_label_role_mappings SET sync_direction = 'to_discord', two_way_enabled_at = NULL, two_way_error = NULL, two_way_lease_expires_at = NULL WHERE installation_id = 'primary' AND label_id = ?").bind(labelId),
    db.prepare("DELETE FROM discord_label_two_way_members WHERE installation_id = 'primary' AND label_id = ?").bind(labelId),
    db.prepare("DELETE FROM discord_label_unmatched_role_members WHERE installation_id = 'primary' AND label_id = ?").bind(labelId),
    auditStatement(db, actorUserId, "discord.label_two_way_disabled", labelId, { roleId: mapping.roleId }, at),
  ]);
  return { syncDirection: "to_discord" };
}

/** Whether a mapping is a two-way label paused after a restore, waiting for an Admin to review it again. */
export const isTwoWayPaused = (mapping: { syncDirection?: string | null; twoWayError?: string | null }) => mapping.syncDirection === "to_discord" && mapping.twoWayError === twoWayRestorePaused;

/**
 * Statements, run in the restore's batch, that pause every label stored as two-way and forget the two-way state of every
 * label: a baseline, unmatched list or review from before the restore says nothing about the restored labels.
 */
export const pauseRestoredTwoWayStatements = (db: D1Database) => [
  db.prepare("UPDATE discord_label_role_mappings SET sync_direction = 'to_discord', two_way_enabled_at = NULL, two_way_checked_at = NULL, two_way_error = ?, two_way_lease_expires_at = NULL WHERE installation_id = 'primary' AND sync_direction = 'two_way'").bind(twoWayRestorePaused),
  db.prepare("DELETE FROM discord_label_two_way_members WHERE installation_id = 'primary'"),
  db.prepare("DELETE FROM discord_label_unmatched_role_members WHERE installation_id = 'primary'"),
  db.prepare("DELETE FROM discord_label_two_way_previews WHERE installation_id = 'primary'"),
];

/** Statements that forget a label's two-way state, for unlinking its role. */
export const forgetTwoWayStatements = (db: D1Database, labelId: string) => [
  db.prepare("DELETE FROM discord_label_two_way_members WHERE installation_id = 'primary' AND label_id = ?").bind(labelId),
  db.prepare("DELETE FROM discord_label_unmatched_role_members WHERE installation_id = 'primary' AND label_id = ?").bind(labelId),
];

export type UnmatchedRoleLabel = { labelId: string; labelName: string; roleId: string; roleName: string; checkedAt?: string; users: { discordUserId: string; displayName: string; seenAt: string }[] };
/** Discord users holding a two-way label's role without being on the roster, as of each label's last check. */
export async function unmatchedRoleMembers(db: D1Database): Promise<{ labels: UnmatchedRoleLabel[] }> {
  const rows = await db.prepare("SELECT x.label_id AS labelId, l.name AS labelName, x.role_id AS roleId, x.role_name AS roleName, x.two_way_checked_at AS checkedAt, u.discord_user_id AS discordUserId, u.display_name AS displayName, u.seen_at AS seenAt FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id LEFT JOIN discord_label_unmatched_role_members u ON u.installation_id = x.installation_id AND u.label_id = x.label_id WHERE x.installation_id = 'primary' AND x.sync_direction = 'two_way' ORDER BY l.name COLLATE NOCASE, u.display_name COLLATE NOCASE").all<{ labelId: string; labelName: string; roleId: string; roleName: string; checkedAt?: string | null; discordUserId?: string | null; displayName?: string | null; seenAt?: string | null }>();
  const labels = new Map<string, UnmatchedRoleLabel>();
  for (const row of rows.results ?? []) {
    const label = labels.get(row.labelId) ?? { labelId: row.labelId, labelName: row.labelName, roleId: row.roleId, roleName: row.roleName, ...(row.checkedAt ? { checkedAt: row.checkedAt } : {}), users: [] };
    if (row.discordUserId) label.users.push({ discordUserId: row.discordUserId, displayName: row.displayName ?? row.discordUserId, seenAt: row.seenAt ?? "" });
    labels.set(row.labelId, label);
  }
  return { labels: [...labels.values()] };
}

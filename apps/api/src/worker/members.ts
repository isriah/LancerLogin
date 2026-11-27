import { inactiveAt, inactivePeriodsUpdateSql } from "../member-participation.ts";
import { attendanceDisposition, DEFAULT_ANOMALY_THRESHOLD_MINUTES, meanAnomalousMinutes } from "../attendance-lifecycle.ts";
import { localDate as policyLocalDate, participationStartDate, type PolicyLabel } from "../attendance-policy.ts";
import { type D1Statement } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { type Env, type MemberInput, allInOrder, auditStatement, authorizedRead, parseJson, requireDatabase, requireRole, response, sha256Hex, validEmail, withSession } from "./core.ts";
import { integrationRecord } from "./integration-support.ts";
import { labels } from "./labels.ts";
import { moduleRosterReferences } from "./module-runtime.ts";
import { policyReport } from "./policy-data.ts";

export async function members(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const [, [result, discord]] = await authorizedRead(request, env, ["admin", "operator"], () => allInOrder(
      () => requireDatabase(env).prepare("SELECT m.id, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, m.email, m.discord_user_id AS discordUserId, m.active, m.created_at AS rosterAddedAt, EXISTS(SELECT 1 FROM users u WHERE u.installation_id = m.installation_id AND u.member_id = m.id AND u.active = 1) AS hasDashboardAccess FROM members m WHERE m.installation_id = 'primary' ORDER BY m.last_name, m.first_name").all(),
      () => integrationRecord(env, "discord"),
    ));
    const discordConfigured = Boolean(discord?.verifiedAt && discord.enabled !== 0); return response({ members: result.results ?? [], discordConfigured });
  }
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ members?: MemberInput[]; mode?: "merge" | "replace" }>(request); const mode = input.mode ?? "merge";
  if (!["merge", "replace"].includes(mode)) throw new HttpError(400, "Roster import mode must be merge or replace");
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 500) throw new HttpError(400, "Provide between 1 and 500 roster members");
  const seen = new Set<string>(); const errors: string[] = []; const warnings: string[] = [];
  input.members.forEach((member, index) => { const prefix = `Member ${index + 1}`; if (!member.memberId?.trim() || !member.firstName?.trim() || !member.lastName?.trim()) errors.push(`${prefix} requires memberId, firstName, and lastName`); if (member.memberId && seen.has(member.memberId.trim())) errors.push(`${prefix} duplicates memberId ${member.memberId.trim()}`); if (member.memberId) seen.add(member.memberId.trim()); if (member.email && !validEmail(member.email)) errors.push(`${prefix} has an invalid email`); if (member.discordUserId && !/^\d{10,24}$/.test(member.discordUserId)) warnings.push(`${prefix} Discord user ID was ignored; link Discord later from Optional integrations.`); });
  if (errors.length) throw new HttpError(400, "Invalid roster", errors);
  const now = new Date().toISOString();
  const importedIds = input.members.map((member) => member.memberId!.trim());
  const existing = await db.prepare("SELECT external_id AS memberId, active FROM members WHERE installation_id = 'primary'").all<{ memberId: string; active: number }>();
  const incoming = new Set(importedIds); const deactivated = mode === "replace" ? (existing.results ?? []).filter((member) => member.active && !incoming.has(member.memberId)).length : 0;
  const statements: D1Statement[] = mode === "replace" ? [db.prepare(`UPDATE members SET inactive_periods_json = ${inactivePeriodsUpdateSql("0")}, active = 0 WHERE installation_id = 'primary' AND external_id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(importedIds))] : [];
  // Email and Discord user ID change only to a value the file gives: a missing column, a blank cell or an ignored Discord ID
  // keeps the stored value (the dashboard preview's rosterImportPreviewRow applies the same rule), so a file without them never unlinks anyone.
  statements.push(...input.members.map((member) => db.prepare(`INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, active, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = COALESCE(excluded.email, members.email), discord_user_id = COALESCE(excluded.discord_user_id, members.discord_user_id), inactive_periods_json = ${inactivePeriodsUpdateSql("1")}, active = 1`).bind(crypto.randomUUID(), member.memberId!.trim(), member.firstName!.trim(), member.lastName!.trim(), member.email?.trim().toLowerCase() || null, member.discordUserId && /^\d{10,24}$/.test(member.discordUserId) ? member.discordUserId.trim() : null, now)));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'roster.imported', 'member', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ count: input.members.length, mode, deactivated }), now));
  await db.batch(statements); return response({ imported: input.members.length, deactivated, mode, warnings }, 201);
}
export async function manageMember(request: Request, env: Env, memberId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const member = await db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, active, created_at AS rosterAddedAt FROM members WHERE installation_id = 'primary' AND id = ?").bind(memberId).first<{ id: string; memberId: string; firstName: string; lastName: string; email?: string; active: number; rosterAddedAt?: string }>();
  if (!member) throw new HttpError(404, "Member not found");
  if (request.method === "DELETE") {
    const input = await parseJson<{ confirmation?: string }>(request);
    if (input.confirmation !== `DELETE MEMBER ${member.memberId}`) throw new HttpError(400, `Type DELETE MEMBER ${member.memberId} exactly to continue`);
    const modules = moduleRosterReferences();
    const references = await db.prepare(`SELECT (SELECT COUNT(*) FROM attendance_events WHERE member_id = ?) + (SELECT COUNT(*) FROM attendance_corrections WHERE member_id = ?)${modules.columns.map(({ table, column }) => ` + (SELECT COUNT(*) FROM ${table} WHERE installation_id='primary' AND ${column} = ?)`).join("")} AS count`).bind(member.id, member.id, ...modules.columns.map(() => member.id)).first<{ count: number }>();
    if (references?.count) throw new HttpError(409, `This member has ${["Attendance", ...modules.labels].join(" or ")} history. Deactivate them instead to preserve the record.`);
    await db.batch([db.prepare("UPDATE users SET member_id = NULL WHERE installation_id = 'primary' AND member_id = ?").bind(member.id), db.prepare("DELETE FROM members WHERE installation_id = 'primary' AND id = ?").bind(member.id), auditStatement(db, principal, "roster.member_deleted", "member", member.id, { memberId: member.memberId })]);
    return response({ deleted: true, memberId: member.id });
  }
  const input = await parseJson<{ firstName?: string; lastName?: string; email?: string | null; active?: boolean }>(request);
  if (input.active !== undefined && typeof input.active !== "boolean") throw new HttpError(400, "Active must be a boolean");
  if (input.firstName !== undefined && (!input.firstName.trim() || input.firstName.length > 100)) throw new HttpError(400, "First name must be 1 to 100 characters");
  if (input.lastName !== undefined && (!input.lastName.trim() || input.lastName.length > 100)) throw new HttpError(400, "Last name must be 1 to 100 characters");
  if (input.email !== undefined && input.email !== null && !validEmail(input.email.trim())) throw new HttpError(400, "Email must be valid");
  const next = { firstName: input.firstName?.trim() ?? member.firstName, lastName: input.lastName?.trim() ?? member.lastName, email: input.email === undefined ? member.email ?? null : input.email?.trim().toLowerCase() || null, active: input.active === undefined ? member.active : input.active ? 1 : 0 };
  await db.batch([
    db.prepare(`UPDATE members SET first_name = ?, last_name = ?, email = ?, inactive_periods_json = ${inactivePeriodsUpdateSql("COALESCE(?, active)")}, active = COALESCE(?, active) WHERE installation_id = 'primary' AND id = ?`).bind(next.firstName, next.lastName, next.email, input.active === undefined ? null : Number(input.active), input.active === undefined ? null : Number(input.active), input.active === undefined ? null : Number(input.active), member.id),
    auditStatement(db, principal, "roster.member_updated", "member", member.id, { active: Boolean(next.active) }),
  ]); return response({ member: { ...member, ...next, active: Boolean(next.active) } });
}
export async function bulkMemberStatus(request: Request, env: Env, apply: boolean): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ memberIds?: string[]; active?: boolean; previewToken?: string }>(request);
  if (!Array.isArray(input.memberIds) || input.memberIds.length < 1 || input.memberIds.length > 500 || new Set(input.memberIds).size !== input.memberIds.length || input.memberIds.some((id) => typeof id !== "string") || typeof input.active !== "boolean") throw new HttpError(400, "Select 1 to 500 distinct members and an active state");
  const result = await db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, active FROM members WHERE installation_id = 'primary' ORDER BY id").all<{ id: string; memberId: string; firstName: string; lastName: string; active: number }>();
  const byId = new Map((result.results ?? []).map((member) => [member.id, member]));
  const selected = input.memberIds.map((id) => byId.get(id));
  if (selected.some((member) => !member)) throw new HttpError(409, "The roster changed. Select members again before applying.");
  const members = selected as NonNullable<(typeof selected)[number]>[];
  const previewToken = await sha256Hex(JSON.stringify({ selected: members, active: input.active }));
  const changed = members.filter((member) => Boolean(member.active) !== input.active);
  if (!apply) return response({ members: members.map((member) => ({ memberId: member.memberId, name: `${member.firstName} ${member.lastName}`, active: Boolean(member.active), willChange: Boolean(member.active) !== input.active })), changed: changed.length, previewToken });
  if (input.previewToken !== previewToken) throw new HttpError(409, "The roster changed since the preview. Preview again before applying.");
  const now = new Date().toISOString();
  await db.batch([...changed.map((member) => db.prepare(`UPDATE members SET inactive_periods_json = ${inactivePeriodsUpdateSql("?")}, active = ? WHERE installation_id = 'primary' AND id = ? AND active = ?`).bind(Number(input.active), Number(input.active), Number(input.active), member.id, member.active)), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'roster.bulk_status_changed', 'member', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ memberIds: members.map((member) => member.memberId), active: input.active, changed: changed.length }), now)]);
  return response({ applied: changed.length, selected: members.length, active: input.active });
}
export async function memberHistory(request: Request, env: Env, externalId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const [member, settings] = await Promise.all([
    db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active, inactive_periods_json AS inactivePeriodsJson, created_at AS rosterAddedAt, attendance_required_from AS attendanceRequiredFrom FROM members WHERE installation_id = 'primary' AND external_id = ?").bind(externalId).first<{ id: string; memberId: string; firstName: string; lastName: string; email?: string; discordUserId?: string; active: number; inactivePeriodsJson?: string; rosterAddedAt?: string; attendanceRequiredFrom?: string }>(),
    db.prepare("SELECT anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ anomalyLateThresholdMinutes?: number; anomalyEarlyThresholdMinutes?: number; timeZone?: string | null }>(),
  ]);
  if (!member) throw new HttpError(404, "Member not found");
  // Meetings saved before times were stored canonically may hold an offset or no milliseconds; julianday compares them by time.
  const rows = await db.prepare("SELECT meeting.id AS meetingId, meeting.title, meeting.starts_at AS startsAt, meeting.ends_at AS endsAt, (SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = ? AND c.meeting_id = meeting.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS correction, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = ? AND c.meeting_id = meeting.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = ? AND e.meeting_id = meeting.id AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = ? AND e.meeting_id = meeting.id AND e.action = 'check_out') AS checkedOutAt FROM meetings meeting WHERE meeting.installation_id = 'primary' AND meeting.deleted_at IS NULL AND julianday(meeting.ends_at) <= julianday(?) ORDER BY meeting.starts_at DESC").bind(member.id, member.id, member.id, member.id, new Date().toISOString()).all<{ meetingId: string; title: string; startsAt: string; endsAt: string; correction?: "present" | "absent" | "excused"; reason?: string; checkedInAt?: string; checkedOutAt?: string }>();
  // Organization-local dates on both sides, as the attendance policy compares them.
  const timeZone = settings?.timeZone || "UTC"; const participationStartsOn = participationStartDate(member, timeZone);
  const history = (rows.results ?? []).filter((row) => policyLocalDate(row.startsAt, timeZone) >= participationStartsOn).map((row) => {
    const events = [{ action: "check_in" as const, occurredAt: row.checkedInAt }, ...(row.checkedOutAt ? [{ action: "check_out" as const, occurredAt: row.checkedOutAt }] : [])].filter((event) => event.occurredAt);
    const derived = attendanceDisposition(events, row.correction);
    return { ...row, disposition: inactiveAt(member.inactivePeriodsJson, row.startsAt) ? "not_required" : derived === "active" ? "absent" : derived };
  });
  const meanAnomalyMinutes = meanAnomalousMinutes(history, settings?.anomalyLateThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES, settings?.anomalyEarlyThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES);
  const { inactivePeriodsJson: _inactivePeriodsJson, ...memberResponse } = member;
  const [labelResult, policy] = await Promise.all([labels(withSession(request, new Request(request.url, { headers: request.headers })), env), policyReport(db, { meetingType: "all", roster: "all", membership: "current", memberId: member.id, useBaseline: true })]);
  const labelData = await labelResult.json() as { labels: PolicyLabel[]; history: ({ memberId: string; labelId: string; action: string; effectiveDate: string; createdAt: string })[] };
  const ownHistory = labelData.history.filter((item) => item.memberId === member.id);
  const summary = policy.members[0]; const policyRows = new Map(summary?.rows.map((row) => [row.meetingId, row]) ?? []);
  return response({ member: { ...memberResponse, active: Boolean(member.active) }, history: history.map((row) => ({ ...row, eligibility: policyRows.get(row.meetingId)?.eligibility ?? "before_start", audience: policyRows.get(row.meetingId)?.audience ?? "All", policy: policyRows.get(row.meetingId)?.policy ?? "standard" })), meanAnomalyMinutes, labels: labelData.labels, labelHistory: ownHistory, attendancePolicy: summary ?? null });
}

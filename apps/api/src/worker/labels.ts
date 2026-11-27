import { evaluateAttendance, localDate as policyLocalDate, validDate, type AttendanceRule } from "../attendance-policy.ts";
import { type D1Database, type D1Statement } from "../d1-usage.ts";
import { policyChangeImpact } from "../attendance-impact.ts";
import { HttpError } from "../http-error.ts";
import { type Env, auditStatement, authorizedRead, parseJson, previewResponse, requireDatabase, requireRole, response, sha256Hex, writeAudit } from "./core.ts";
import { policyData, policyStateDigest } from "./policy-data.ts";

type LabelMutation = { memberId: string; label: string; action?: "add" | "remove"; effectiveDate?: string };
export async function labels(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const [, [catalog, history, periods, rules, settings, audiences]] = await authorizedRead(request, env, ["admin", "operator"], async () => { const db = requireDatabase(env); return Promise.all([
      db.prepare("SELECT l.id, l.name, l.active, l.formula_enabled AS formulaEnabled, EXISTS (SELECT 1 FROM discord_label_role_mappings x WHERE x.installation_id = l.installation_id AND x.label_id = l.id) AS discordLinked FROM member_labels l WHERE l.installation_id = 'primary' ORDER BY l.name COLLATE NOCASE").all(),
      db.prepare("SELECT c.id, c.member_id AS memberId, m.external_id AS externalMemberId, c.label_id AS labelId, c.action, c.effective_date AS effectiveDate, c.created_at AS createdAt, c.source FROM member_label_changes c JOIN members m ON m.id = c.member_id AND m.installation_id = c.installation_id WHERE c.installation_id = 'primary' ORDER BY c.effective_date, c.created_at, c.id").all(),
      db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, meetings_per_week AS meetingsPerWeek FROM label_attendance_rules WHERE installation_id = 'primary' AND rule_type = 'weekly_count' AND starts_on IS NOT NULL AND ends_on IS NOT NULL ORDER BY starts_on").all(),
      db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, rule_type AS ruleType, threshold_percent AS thresholdPercent, meetings_per_week AS meetingsPerWeek, excused_handling AS excusedHandling FROM label_attendance_rules WHERE installation_id = 'primary' ORDER BY label_id, starts_on").all(),
      db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string }>(),
      db.prepare("SELECT label_id AS labelId, COUNT(*) AS meetings FROM meeting_audience_labels WHERE installation_id = 'primary' GROUP BY label_id").all<{ labelId: string; meetings: number }>(),
    ]); });
    return response({ labels: catalog.results ?? [], history: history.results ?? [], periods: periods.results ?? [], rules: rules.results ?? [], meetingCounts: Object.fromEntries((audiences.results ?? []).map((row) => [row.labelId, row.meetings])), today: policyLocalDate(new Date().toISOString(), settings?.timeZone ?? "UTC") });
  }
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ name?: string; formulaEnabled?: boolean }>(request);
  const name = input.name?.trim(); if (!name || name.length > 80 || typeof input.formulaEnabled !== "undefined" && typeof input.formulaEnabled !== "boolean") throw new HttpError(400, "Label name must be 1 to 80 characters");
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const existing = await db.prepare("SELECT id FROM member_labels WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE").bind(name).first();
  if (existing) throw new HttpError(409, "A label with that name already exists");
  await db.batch([db.prepare("INSERT INTO member_labels (id, installation_id, name, formula_enabled, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?)").bind(id, name, input.formulaEnabled ? 1 : 0, principal.userId, now), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'label.created', 'member_label', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ name, formulaEnabled: Boolean(input.formulaEnabled) }), now)]);
  return response({ label: { id, name, active: true, formulaEnabled: Boolean(input.formulaEnabled) } }, 201);
}
export async function updateLabel(request: Request, env: Env, labelId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const current = await db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' AND id = ?").bind(labelId).first<{ id: string; name: string; active: number; formulaEnabled: number }>();
  if (!current) throw new HttpError(404, "Label not found");
  const input = await parseJson<{ name?: string; active?: boolean }>(request);
  const name = input.name === undefined ? current.name : input.name.trim(); const active = input.active === undefined ? Boolean(current.active) : input.active;
  if (!name || name.length > 80 || typeof active !== "boolean") throw new HttpError(400, "Invalid label update");
  const duplicate = await db.prepare("SELECT id FROM member_labels WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE AND id != ?").bind(name, labelId).first();
  if (duplicate) throw new HttpError(409, "A label with that name already exists");
  await db.batch([
    db.prepare("UPDATE member_labels SET name = ?, active = ? WHERE installation_id = 'primary' AND id = ?").bind(name, active ? 1 : 0, labelId),
    auditStatement(db, principal, "label.updated", "member_label", labelId, { before: current, after: { name, active } }),
  ]);
  return response({ label: { ...current, name, active } });
}
export async function labelTarget(request: Request, env: Env, targetId?: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "DELETE") {
    const target = await db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn FROM label_attendance_rules WHERE installation_id = 'primary' AND id = ? AND rule_type = 'weekly_count'").bind(targetId).first();
    if (!target) throw new HttpError(404, "Weekly target not found");
    await db.batch([db.prepare("DELETE FROM label_attendance_rules WHERE installation_id = 'primary' AND id = ?").bind(targetId), db.prepare("DELETE FROM label_weekly_targets WHERE installation_id = 'primary' AND (id = ? OR 'legacy:' || id = ?)").bind(targetId, targetId)]); await writeAudit(db, principal, "label.target_removed", "weekly_target", targetId!, target); return response({ removed: true });
  }
  const input = await parseJson<{ labelId?: string; startsOn?: string; endsOn?: string; meetingsPerWeek?: number }>(request);
  if (!input.labelId || !validDate(input.startsOn) || !validDate(input.endsOn) || input.endsOn < input.startsOn || !Number.isSafeInteger(input.meetingsPerWeek) || Number(input.meetingsPerWeek) < 1 || Number(input.meetingsPerWeek) > 100) throw new HttpError(400, "Choose a label, valid period, and positive weekly target");
  const label = await db.prepare("SELECT id, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' AND id = ?").bind(input.labelId).first<{ id: string; active: number; formulaEnabled: number }>();
  if (!label || !label.active) throw new HttpError(400, "Choose an active label");
  const overlap = await db.prepare("SELECT id FROM label_attendance_rules WHERE installation_id = 'primary' AND label_id = ? AND starts_on <= ? AND COALESCE(ends_on, '9999-12-31') >= ?").bind(input.labelId, input.endsOn, input.startsOn).first();
  if (overlap) throw new HttpError(409, "Weekly target periods cannot overlap");
  await previewPolicyMutation(db, { rule: { id: "", labelId: input.labelId, startsOn: input.startsOn, endsOn: input.endsOn, ruleType: "weekly_count", meetingsPerWeek: input.meetingsPerWeek } });
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await refuseRuleOverlap(db.batch([db.prepare("INSERT INTO label_attendance_rules (id, installation_id, label_id, starts_on, ends_on, rule_type, meetings_per_week, created_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, 'weekly_count', ?, ?, ?, ?)").bind(id, input.labelId, input.startsOn, input.endsOn, input.meetingsPerWeek, principal.userId, now, now), db.prepare("INSERT INTO label_weekly_targets (id, installation_id, label_id, starts_on, ends_on, meetings_per_week, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, input.labelId, input.startsOn, input.endsOn, input.meetingsPerWeek, principal.userId, now), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'label.target_added', 'weekly_target', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify(input), now)]), "Weekly target periods cannot overlap");
  return response({ target: { id, ...input } }, 201);
}
/**
 * Migration 0031's triggers (dated periods) and unique indexes (one default rule per label) refuse an overlapping rule
 * inside the write, so two requests at once can never both save one. The request that loses gets the 409 its route's own
 * check gives a sequential request, not a 500.
 */
async function refuseRuleOverlap<T>(write: Promise<T>, message: string): Promise<T> {
  try { return await write; }
  catch (error) {
    if (error instanceof Error && /Attendance rule periods cannot overlap|UNIQUE constraint failed: label_attendance_rules\./.test(error.message)) throw new HttpError(409, message);
    throw error;
  }
}
async function previewLabelChanges(db: D1Database, raw: LabelMutation[]) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) throw new HttpError(400, "Provide 1 to 500 label changes");
  const data = await policyData(db); const members = new Map(data.members.map((member) => [member.memberId, member])); const labels = new Map(data.labels.flatMap((label) => [[label.id.toLowerCase(), label], [label.name.toLowerCase(), label]]));
  const errors: string[] = []; const seen = new Set<string>();
  const today = policyLocalDate(new Date().toISOString(), data.timeZone);
  const normalized = raw.map((item, index) => {
    const member = members.get(item.memberId?.trim()); const label = labels.get(item.label?.trim().toLowerCase()); const date = item.effectiveDate?.trim() || today; const action = item.action?.trim() || "add";
    if (!member) errors.push(`Row ${index + 1}: member ID was not found`);
    if (!label) errors.push(`Row ${index + 1}: label was not found`);
    if (action !== "add" && action !== "remove") errors.push(`Row ${index + 1}: action must be add or remove`);
    if (!validDate(date)) errors.push(`Row ${index + 1}: effectiveDate must be a valid YYYY-MM-DD date`);
    if (label && action === "add" && !label.active) errors.push(`Row ${index + 1}: retired labels cannot receive new assignments`);
    const key = `${member?.id}:${label?.id}:${date}`; if (seen.has(key) || data.changes.some((change) => `${change.memberId}:${change.labelId}:${change.effectiveDate}` === key)) errors.push(`Row ${index + 1}: a change already exists for this member, label, and date`); seen.add(key);
    return { member, label, action: action as "add" | "remove", effectiveDate: date, externalMemberId: item.memberId };
  });
  if (errors.length) throw new HttpError(400, "Invalid label changes", errors);
  const newChanges = normalized.map((item) => ({ memberId: item.member!.id, labelId: item.label!.id, action: item.action, effectiveDate: item.effectiveDate }));
  const combined = [...data.changes, ...newChanges];
  const affected = data.members.filter((member) => newChanges.some((change) => change.memberId === member.id));
  const before = evaluateAttendance({ ...data, members: affected }); const after = evaluateAttendance({ ...data, members: affected, changes: combined });
  const impact = before.map((item, index) => ({ memberId: item.member.memberId, beforeRate: item.rate, afterRate: after[index].rate, beforePolicy: item.policy, afterPolicy: after[index].policy, beforePolicies: item.currentCompliances, afterPolicies: after[index].currentCompliances, affectedCompletedMeetings: after[index].rows.filter((row, rowIndex) => row.eligibility !== item.rows[rowIndex]?.eligibility).length }));
  const token = await sha256Hex(JSON.stringify({ raw: newChanges, state: await policyStateDigest(data) }));
  return { normalized, changes: newChanges, impact, token };
}
export async function labelMembership(request: Request, env: Env, apply: boolean): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ changes?: LabelMutation[]; previewToken?: string }>(request);
  const preview = await previewLabelChanges(db, input.changes ?? []);
  if (!apply) return previewResponse({ changes: preview.normalized.map((item) => ({ memberId: item.externalMemberId, label: item.label!.name, action: item.action, effectiveDate: item.effectiveDate })), impact: preview.impact, previewToken: preview.token });
  if (input.previewToken !== preview.token) throw new HttpError(409, "Label history changed since the preview. Preview again before applying.");
  const now = new Date().toISOString();
  const statements = preview.changes.map((item) => db.prepare("INSERT INTO member_label_changes (id, installation_id, member_id, label_id, action, effective_date, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), item.memberId, item.labelId, item.action, item.effectiveDate, principal.userId, now));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'label.membership_changed', 'member_label', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ changes: preview.changes, impact: preview.impact }), now));
  await db.batch(statements); return response({ applied: preview.changes.length, impact: preview.impact });
}
type PolicyMutation = { rule?: AttendanceRule; removeRuleId?: string; recentDays?: number; previewToken?: string };
async function previewPolicyMutation(db: D1Database, input: PolicyMutation) {
  const data = await policyData(db);
  if (input.rule && input.removeRuleId || !input.rule && !input.removeRuleId && input.recentDays === undefined) throw new HttpError(400, "Choose one attendance policy change");
  if (input.recentDays !== undefined && (!Number.isSafeInteger(input.recentDays) || input.recentDays < 1 || input.recentDays > 365)) throw new HttpError(400, "Recent window must be 1 to 365 days");
  let rules = [...data.rules];
  let change: AttendanceRule | undefined;
  if (input.removeRuleId) {
    if (!rules.some((rule) => rule.id === input.removeRuleId)) throw new HttpError(404, "Attendance rule not found");
    rules = rules.filter((rule) => rule.id !== input.removeRuleId);
  }
  if (input.rule) {
    const supplied = input.rule;
    const label = data.labels.find((item) => item.id === supplied.labelId);
    if (!label || !label.active) throw new HttpError(400, "Choose an active label");
    if (supplied.id && !rules.some((rule) => rule.id === supplied.id && rule.labelId === supplied.labelId)) throw new HttpError(404, "Attendance rule not found for this label");
    const startsOn = supplied.startsOn || null, endsOn = supplied.endsOn || null;
    if (startsOn && !validDate(startsOn) || endsOn && (!validDate(endsOn) || !startsOn || endsOn < startsOn)) throw new HttpError(400, "Invalid rule dates");
    if (supplied.ruleType === "weighted_percentage") {
      if (typeof supplied.thresholdPercent !== "number" || !Number.isFinite(supplied.thresholdPercent) || supplied.thresholdPercent <= 0 || supplied.thresholdPercent > 100) throw new HttpError(400, "Percentage threshold must be greater than 0 and at most 100");
      if (supplied.excusedHandling !== undefined && supplied.excusedHandling !== null && !["exclude", "count_missed"].includes(supplied.excusedHandling)) throw new HttpError(400, "Choose how excused meetings affect the percentage");
    } else if (supplied.ruleType === "weekly_count") {
      if (!Number.isSafeInteger(supplied.meetingsPerWeek) || Number(supplied.meetingsPerWeek) < 1 || Number(supplied.meetingsPerWeek) > 100) throw new HttpError(400, "Weekly target must be 1 to 100 meetings");
    } else throw new HttpError(400, "Choose a supported attendance rule");
    change = { id: supplied.id || "preview-new-rule", labelId: supplied.labelId, startsOn, endsOn, ruleType: supplied.ruleType, thresholdPercent: supplied.ruleType === "weighted_percentage" ? Number(supplied.thresholdPercent) : null, meetingsPerWeek: supplied.ruleType === "weekly_count" ? Number(supplied.meetingsPerWeek) : null, excusedHandling: supplied.ruleType === "weighted_percentage" ? supplied.excusedHandling ?? "exclude" : "exclude" };
    rules = rules.filter((rule) => rule.id !== supplied.id);
    for (const other of rules.filter((rule) => rule.labelId === supplied.labelId)) {
      if (!startsOn && !other.startsOn || startsOn && other.startsOn && startsOn <= (other.endsOn ?? "9999-12-31") && other.startsOn <= (endsOn ?? "9999-12-31")) throw new HttpError(409, "Attendance rule periods cannot overlap");
    }
    rules.push(change);
  }
  const recentDays = input.recentDays ?? data.recentDays;
  const impact = policyChangeImpact(data, rules, recentDays);
  const token = await sha256Hex(JSON.stringify({ input: { rule: input.rule, removeRuleId: input.removeRuleId, recentDays: input.recentDays }, state: await policyStateDigest(data) }));
  return { data, change, rules, recentDays, impact, previewToken: token };
}
export async function attendancePolicies(request: Request, env: Env, apply?: boolean): Promise<Response> {
  const principal = await requireRole(request, env, request.method === "GET" ? ["admin", "operator"] : ["admin"]);
  const db = requireDatabase(env);
  if (request.method === "GET") {
    const data = await policyData(db);
    return response({ labels: data.labels, rules: data.rules, recentDays: data.recentDays });
  }
  const input = await parseJson<PolicyMutation>(request);
  const preview = await previewPolicyMutation(db, input);
  if (!apply) return response({ rule: preview.change, removeRuleId: input.removeRuleId, recentDays: preview.recentDays, impact: preview.impact, previewToken: preview.previewToken });
  if (input.previewToken !== preview.previewToken) throw new HttpError(409, "Attendance policy changed since the preview. Preview again before applying.");
  const now = new Date().toISOString();
  const statements: D1Statement[] = [];
  if (input.removeRuleId) statements.push(db.prepare("DELETE FROM label_attendance_rules WHERE installation_id = 'primary' AND id = ?").bind(input.removeRuleId));
  if (preview.change) {
    const rule = preview.change;
    if (input.rule?.id) statements.push(db.prepare("UPDATE label_attendance_rules SET starts_on = ?, ends_on = ?, rule_type = ?, threshold_percent = ?, meetings_per_week = ?, excused_handling = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ?").bind(rule.startsOn, rule.endsOn, rule.ruleType, rule.thresholdPercent, rule.meetingsPerWeek, rule.excusedHandling ?? "exclude", now, rule.id));
    else statements.push(db.prepare("INSERT INTO label_attendance_rules (id, installation_id, label_id, starts_on, ends_on, rule_type, threshold_percent, meetings_per_week, excused_handling, created_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), rule.labelId, rule.startsOn, rule.endsOn, rule.ruleType, rule.thresholdPercent, rule.meetingsPerWeek, rule.excusedHandling ?? "exclude", principal.userId, now, now));
  }
  if (input.recentDays !== undefined) statements.push(db.prepare("UPDATE organization_settings SET attendance_recent_days = ? WHERE installation_id = 'primary'").bind(preview.recentDays));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'attendance_policy.changed', 'member_label', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, preview.change?.labelId ?? input.removeRuleId ?? "settings", JSON.stringify({ rule: preview.change, removeRuleId: input.removeRuleId, recentDays: input.recentDays, impact: preview.impact }), now));
  await refuseRuleOverlap(db.batch(statements), "Attendance rule periods cannot overlap");
  return response({ applied: true, impact: preview.impact });
}

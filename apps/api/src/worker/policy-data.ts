import { attendanceStatusText } from "../../../../packages/shared/src/attendance-terms.ts";
import { type LabelPolicySummary } from "../../../../packages/shared/src/attendance-label-sets.ts";
import { attendanceClosesAt, attendanceDisposition } from "../attendance-lifecycle.ts";
import { evaluateAttendanceKept, localDate as policyLocalDate, ruleOn as policyRuleOn, validDate, type AttendanceRule, type LabelChange, type Observation, type PolicyLabel, type PolicyMeeting, type PolicyMember, type PolicyMemberResult } from "../attendance-policy.ts";
import { labelSetResult } from "../report-builder.ts";
import { databaseIdentity, type D1Database } from "../d1-usage.ts";
import { ReportDataCache } from "../report-data-cache.ts";
import { HttpError } from "../http-error.ts";
import { sha256Hex } from "./core.ts";

export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
async function loadPolicyData(db: D1Database, memberId?: string, meetingId?: string): Promise<{ members: PolicyMember[]; labels: PolicyLabel[]; changes: LabelChange[]; rules: AttendanceRule[]; meetings: PolicyMeeting[]; observations: Observation[]; timeZone: string; baseline: string | null; recentDays: number; policyActivatedOn: string | null }> {
  const scoped = (sql: string, column: string, value?: string) => value ? db.prepare(sql.replace(" ORDER BY", ` AND ${column} = ? ORDER BY`)).bind(value) : db.prepare(sql);
  const [memberResult, labelResult, changeResult, ruleResult, meetingResult, audienceResult, eventResult, correctionResult, settings] = await Promise.all([
    scoped("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active, inactive_periods_json AS inactivePeriodsJson, attendance_required_from AS attendanceRequiredFrom, created_at AS rosterAddedAt FROM members WHERE installation_id = 'primary' ORDER BY last_name, first_name", "id", memberId).all<PolicyMember>(),
    db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' ORDER BY name COLLATE NOCASE").all<PolicyLabel>(),
    scoped("SELECT member_id AS memberId, label_id AS labelId, action, effective_date AS effectiveDate, created_at AS createdAt FROM member_label_changes WHERE installation_id = 'primary' ORDER BY effective_date, created_at, id", "member_id", memberId).all<LabelChange>(),
    db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, rule_type AS ruleType, threshold_percent AS thresholdPercent, meetings_per_week AS meetingsPerWeek, excused_handling AS excusedHandling FROM label_attendance_rules WHERE installation_id = 'primary' ORDER BY label_id, starts_on").all<AttendanceRule>(),
    scoped("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, attendance_weight AS attendanceWeight, audience_mode AS audienceMode, is_test AS isTest FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL ORDER BY starts_at DESC", "id", meetingId).all<Omit<PolicyMeeting, "attendanceClosesAt" | "audienceLabelIds">>(),
    db.prepare("SELECT meeting_id AS meetingId, label_id AS labelId FROM meeting_audience_labels WHERE installation_id = 'primary'").all<{ meetingId: string; labelId: string }>(),
    scoped("SELECT e.meeting_id AS meetingId, e.member_id AS memberId, e.action, e.occurred_at AS occurredAt FROM attendance_events e JOIN meetings mt ON mt.id = e.meeting_id AND mt.installation_id = e.installation_id WHERE e.installation_id = 'primary' AND mt.deleted_at IS NULL ORDER BY e.occurred_at, e.id", memberId ? "e.member_id" : "e.meeting_id", memberId ?? meetingId).all<{ meetingId: string; memberId: string; action: "check_in" | "check_out"; occurredAt: string }>(),
    scoped("SELECT c.meeting_id AS meetingId, c.member_id AS memberId, c.disposition, c.reason FROM attendance_corrections c JOIN meetings mt ON mt.id = c.meeting_id AND mt.installation_id = c.installation_id WHERE c.installation_id = 'primary' AND mt.deleted_at IS NULL ORDER BY c.created_at, c.id", memberId ? "c.member_id" : "c.meeting_id", memberId ?? meetingId).all<{ meetingId: string; memberId: string; disposition: "present" | "absent" | "excused"; reason: string }>(),
    db.prepare("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on AS baseline, attendance_recent_days AS recentDays, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string; lateScanMinutes: number; baseline: string | null; recentDays: number; policyActivatedOn: string | null }>(),
  ]);
  const audienceLabels = new Map<string, string[]>();
  for (const item of audienceResult.results ?? []) audienceLabels.set(item.meetingId, [...(audienceLabels.get(item.meetingId) ?? []), item.labelId]);
  const events = new Map<string, { action: "check_in" | "check_out"; occurredAt: string }[]>();
  for (const event of eventResult.results ?? []) { const key = `${event.meetingId}:${event.memberId}`; events.set(key, [...(events.get(key) ?? []), event]); }
  const corrections = new Map<string, { disposition: "present" | "absent" | "excused"; reason: string }>();
  for (const correction of correctionResult.results ?? []) corrections.set(`${correction.meetingId}:${correction.memberId}`, correction);
  const observations: Observation[] = [...new Set([...events.keys(), ...corrections.keys()])].map((key) => {
    const eventRows = events.get(key) ?? []; const correction = corrections.get(key); const split = key.indexOf(":");
    return { meetingId: key.slice(0, split), memberId: key.slice(split + 1), disposition: attendanceDisposition(eventRows, correction?.disposition), checkedInAt: eventRows.find((event) => event.action === "check_in")?.occurredAt, checkedOutAt: eventRows.find((event) => event.action === "check_out")?.occurredAt, reason: correction?.reason };
  });
  return { members: memberResult.results ?? [], labels: labelResult.results ?? [], changes: changeResult.results ?? [], rules: ruleResult.results ?? [], meetings: (meetingResult.results ?? []).map((meeting) => ({ ...meeting, attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30), audienceLabelIds: audienceLabels.get(meeting.id) ?? [] })), observations, timeZone: settings?.timeZone ?? "UTC", baseline: settings?.baseline ?? null, recentDays: settings?.recentDays ?? 30, policyActivatedOn: settings?.policyActivatedOn ?? null };
}
type PolicyData = Awaited<ReturnType<typeof loadPolicyData>>;
const reportDataCache = new ReportDataCache<PolicyData>();
/**
 * A digest of everything attendance is calculated from, for preview tokens: a token made with it stops matching as soon as
 * any of that data changes. Writing out a whole team's attendance to hash it costs more CPU than Workers Free allows a
 * request, so it is done once for each loaded copy of the data, not once for each preview and again when it is applied.
 */
// Finished digests only: a digest still being computed belongs to its request and could never settle for another one.
const policyStateDigests = new WeakMap<PolicyData, string>();
export async function policyStateDigest(data: PolicyData): Promise<string> {
  let digest = policyStateDigests.get(data);
  if (digest === undefined) { digest = await sha256Hex(JSON.stringify(data)); policyStateDigests.set(data, digest); }
  return digest;
}
export async function policyData(db: D1Database, scope: { memberId?: string; meetingId?: string } = {}): Promise<PolicyData> {
  return reportDataCache.read(databaseIdentity(db), JSON.stringify(scope), async () => {
    const row = await db.prepare("SELECT revision FROM report_data_revision WHERE installation_id = 'primary'").first<{ revision: number }>();
    return row?.revision;
  }, () => loadPolicyData(db, scope.memberId, scope.meetingId));
}

type ReportFilters = { from?: string; to?: string; meetingType: "all" | "required" | "optional"; roster: "active" | "all"; labelId?: string; membership: "current" | "historical"; memberId?: string; useBaseline?: boolean };
export function reportFilters(url: URL): ReportFilters {
  const from = url.searchParams.get("from") || undefined; const to = url.searchParams.get("to") || undefined;
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) throw new HttpError(400, "Report dates must be valid and in order");
  const meetingType = url.searchParams.get("meetingType") ?? "all"; const roster = url.searchParams.get("roster") ?? "active"; const membership = url.searchParams.get("membership") ?? "current";
  if (!["all", "required", "optional"].includes(meetingType) || !["active", "all"].includes(roster) || !["current", "historical"].includes(membership)) throw new HttpError(400, "Invalid report filter");
  const useBaseline = url.searchParams.get("useBaseline");
  if (useBaseline !== null && useBaseline !== "true" && useBaseline !== "false") throw new HttpError(400, "Invalid report baseline option");
  return { from, to, meetingType: meetingType as ReportFilters["meetingType"], roster: roster as ReportFilters["roster"], labelId: url.searchParams.get("labelId") || undefined, membership: membership as ReportFilters["membership"], memberId: url.searchParams.get("memberId") || undefined, useBaseline: useBaseline === "true" };
}
/** With `rankLabelId`, each member also carries `labelResult`: their result under that label's policy for the period. */
export async function policyReport(db: D1Database, filters: ReportFilters, { rankLabelId }: { rankLabelId?: string } = {}): Promise<{ meetings: PolicyMeeting[]; members: (PolicyMemberResult & { labelResult?: ReturnType<typeof labelSetResult> })[]; labels: PolicyLabel[]; baseline: string | null; timeZone: string }> {
  const data = await policyData(db, filters.memberId ? { memberId: filters.memberId } : {});
  if (filters.labelId && !data.labels.some((label) => label.id === filters.labelId)) throw new HttpError(400, "Unknown label filter");
  const meetings = data.meetings.filter((meeting) => filters.meetingType === "all" || Boolean(meeting.required) === (filters.meetingType === "required"));
  const from = filters.from ?? (filters.useBaseline ? data.baseline ?? undefined : undefined);
  // Both evaluations are kept with the loaded data (evaluateAttendanceKept), so the next report on the same data reuses them.
  const historicalLabelId = filters.labelId && filters.membership === "historical" ? filters.labelId : undefined;
  const official = evaluateAttendanceKept(data, "official");
  const full = new Map(official.map((item) => [item.member.id, item]));
  const samePeriod = filters.meetingType === "all" && !from && !filters.to && !historicalLabelId && !rankLabelId;
  const period = samePeriod ? official : evaluateAttendanceKept(data, JSON.stringify(["report", filters.meetingType, from ?? null, filters.to ?? null, historicalLabelId ?? null, rankLabelId ?? null]), (source) => ({ ...source, meetings, from, to: filters.to, historicalLabelId, ...(rankLabelId ? { summaryLabelIds: [rankLabelId] } : {}) }));
  const members = period.map((item) => ({ ...item, ...(rankLabelId ? { labelResult: labelSetResult(item, rankLabelId) } : {}), currentCompliances: full.get(item.member.id)?.currentCompliances ?? item.currentCompliances, currentCompliance: full.get(item.member.id)?.currentCompliance ?? item.currentCompliance, historySummaries: full.get(item.member.id)?.historySummaries ?? item.historySummaries })).filter((item) => (filters.roster === "all" || Boolean(item.member.active)) && (!filters.memberId || item.member.id === filters.memberId) && (!filters.labelId || (filters.membership === "historical" ? item.rows.length > 0 : item.currentLabelIds.includes(filters.labelId))));
  return { meetings: meetings.filter((meeting) => !meeting.isTest && Date.parse(meeting.attendanceClosesAt) <= Date.now() && (!from || policyLocalDate(meeting.startsAt, data.timeZone) >= from) && (!filters.to || policyLocalDate(meeting.startsAt, data.timeZone) <= filters.to)), members, labels: data.labels, baseline: data.baseline, timeZone: data.timeZone };
}
/**
 * Each label's attendance policy in effect today, in one query. A percentage policy is "weighted" when a required meeting
 * its label can attend has a weight other than 1, so the label's counts and rate can differ.
 */
export async function labelPolicySummaries(db: D1Database, today: string): Promise<LabelPolicySummary[]> {
  const result = await db.prepare("SELECT r.id, r.label_id AS labelId, r.starts_on AS startsOn, r.ends_on AS endsOn, r.rule_type AS ruleType, r.threshold_percent AS thresholdPercent, r.meetings_per_week AS meetingsPerWeek, r.excused_handling AS excusedHandling, EXISTS (SELECT 1 FROM meetings m WHERE m.installation_id = r.installation_id AND m.deleted_at IS NULL AND m.required = 1 AND COALESCE(m.is_test, 0) = 0 AND m.attendance_weight <> 1 AND (m.audience_mode = 'all' OR EXISTS (SELECT 1 FROM meeting_audience_labels a WHERE a.installation_id = m.installation_id AND a.meeting_id = m.id AND a.label_id = r.label_id))) AS weighted FROM label_attendance_rules r WHERE r.installation_id = 'primary' ORDER BY r.label_id, r.starts_on").all<AttendanceRule & { weighted: number }>();
  const rules = result.results ?? [];
  return [...new Set(rules.map((rule) => rule.labelId))].flatMap((labelId) => {
    const rule = policyRuleOn(rules, labelId, today) as (AttendanceRule & { weighted: number }) | undefined;
    if (!rule) return [];
    const weekly = rule.ruleType === "weekly_count";
    return [{ labelId, ruleType: rule.ruleType, target: Number(weekly ? rule.meetingsPerWeek : rule.thresholdPercent), excusedHandling: weekly ? null : rule.excusedHandling ?? "exclude", weighted: !weekly && Boolean(rule.weighted) }];
  });
}
export function policySummaryText(summary?: PolicyMemberResult): string {
  if (!summary) return "No attendance record is available.";
  const regular = "Overall rate: " + (summary.regularAttendance.rate === null ? "N/A" : String(summary.regularAttendance.rate) + "%") + " from " + (summary.regularAttendance.from ?? "the first eligible meeting") + " to " + summary.regularAttendance.to + ".";
  if (!summary.currentCompliances.length) return regular + " No assigned attendance policy.";
  const results = summary.currentCompliances.map((current) => {
    const status = attendanceStatusText(current.status);
    if (current.status === "no_rule") return (current.labelName ?? "Attendance policy") + ": " + status;
    const result = current.ruleType === "weekly_count"
      ? String(current.attended) + " of " + String(current.threshold) + " meetings, " + status
      : (current.rate === null ? "N/A" : String(current.rate) + "%") + " against " + String(current.threshold) + "% required, " + status + "; excused meetings " + (current.excusedHandling === "count_missed" ? "count as missed" : "are excluded");
    return (current.labelName ?? "Attendance policy") + ": " + result + " from " + current.from + " to " + current.to;
  }).join(". ");
  const history = summary.historySummaries.map((item) => item.ruleType === "weekly_count" ? item.labelName + ": " + String(item.weeksMet) + "/" + String(item.weeksDue) + " weeks met" : item.labelName + ": " + (item.rate === null ? "N/A" : String(item.rate) + "% weighted") + ", excused meetings " + (item.excusedHandling === "count_missed" ? "count as missed" : "excluded")).join("; ");
  return regular + " " + results + ". Policy history: " + (history || "None") + ".";
}
export function calendarAttendanceDetails(meeting: { required: number | boolean; attendanceWeight: number; notes?: string | null }, audience: string): string {
  const status = meeting.required ? "Required" : "Optional";
  const weight = meeting.required ? " (weight " + String(meeting.attendanceWeight) + ")" : "";
  return "Audience: " + audience + "\nAttendance: " + status + weight + (meeting.notes ? "\n\n" + meeting.notes : "");
}

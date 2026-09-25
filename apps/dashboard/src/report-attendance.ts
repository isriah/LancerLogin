export type Meeting = { id: string; title: string; startsAt: string; endsAt: string; attendanceClosesAt: string; required: boolean | number; isTest?: boolean | number; attendanceWeight: number; audienceMode: "all" | "labels"; audienceLabelIds: string[] };
export type Label = { id: string; name: string; active: boolean | number; formulaEnabled: boolean | number };
export type ReportRow = { meetingId: string; memberId: string; disposition: "present" | "active" | "absent" | "excused"; eligibility: "required" | "optional" | "outside_audience" | "before_start" | "weekly" | "no_target"; policy: "standard" | "weekly"; rateEligible: boolean; regularEligible: boolean; attended: boolean; weight: number; regularWeight: number; audience: string; memberLabelIds: string[]; checkedInAt?: string; checkedOutAt?: string; reason?: string };
export type ReportWeek = { weekStartsOn: string; weekEndsOn: string; segmentStartsOn: string; segmentEndsOn: string; labelId: string; ruleId: string; target: number; opportunities: number; attended: number; excused: number; rate: number | null; adjustedRate: number | null; belowTarget: boolean; status: "met" | "below" | "pending" | "not_applicable" };
export type RegularAttendance = { rate: number | null; attended: number; required: number; from: string | null; to: string };
export type ReportCompliance = { labelId: string | null; labelName: string | null; ruleId: string | null; ruleType: "weighted_percentage" | "weekly_count" | null; excusedHandling: "exclude" | "count_missed" | null; status: "met" | "below" | "pending" | "not_applicable" | "no_rule"; threshold: number | null; from: string; to: string; rate: number | null; unadjustedRate: number | null; attended: number; required: number };
export type ReportHistory = { ruleId: string; labelId: string; labelName: string; ruleType: "weighted_percentage" | "weekly_count"; excusedHandling: "exclude" | "count_missed" | null; startsOn: string | null; endsOn: string | null; rate: number | null; unadjustedRate: number | null; threshold: number; attended: number; required: number; weeksMet: number; weeksDue: number; status: "met" | "below" | "not_applicable" };
export type ReportMember = { member: { id: string; memberId: string; firstName: string; lastName: string; active: number | boolean }; currentLabelIds: string[]; rows: ReportRow[]; regularAttendance: RegularAttendance; policy: "standard" | "weekly" | "mixed"; present: number; primaryTotal: number; adjustedTotal: number; rate: number | null; adjustedRate: number | null; pooledRate: number | null; weeks: ReportWeek[]; belowTargetWeeks: ReportWeek[]; currentCompliances: ReportCompliance[]; currentCompliance: ReportCompliance; historySummaries: ReportHistory[] };
export type AttendanceReport = { meetings: Meeting[]; members: ReportMember[]; labels: Label[]; baseline: string | null; timeZone: string };
export type ReportFilters = { from?: string; to?: string; meetingType?: "all" | "required" | "optional"; roster?: "active" | "all"; labelId?: string; membership?: "current" | "historical"; memberId?: string };

export const percent = (top: number, bottom: number) => bottom ? Math.round(top / bottom * 100) : 0;
export const completedReportMeetings = (meetings: Meeting[], now = Date.now()) => meetings.filter((meeting) => !meeting.isTest && Date.parse(meeting.attendanceClosesAt) <= now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
export const reportingPeriodMeetings = (meetings: Meeting[], from = "", to = "") => meetings.filter((meeting) => (!from || meeting.startsAt.slice(0, 10) >= from) && (!to || meeting.startsAt.slice(0, 10) <= to));
export function reportQuery(filters: ReportFilters = {}): string { const query = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value); return query.toString(); }
export async function loadReportAttendance(request: <T>(path: string) => Promise<T>, filters: ReportFilters = {}): Promise<AttendanceReport> { const query = reportQuery(filters); return request<AttendanceReport>(`/reports/attendance${query ? `?${query}` : ""}`); }
export const attendanceRateText = (rate: number | null) => rate === null ? "N/A" : `${rate}%`;
export function policyResultText(compliance: ReportCompliance): string {
  if (compliance.status === "no_rule") return compliance.labelName ? `${compliance.labelName}: no active rule` : "No assigned policy";
  const name = compliance.labelName ?? "Attendance policy"; const status = compliance.status === "not_applicable" ? "N/A" : compliance.status.replaceAll("_", " ");
  if (compliance.ruleType === "weekly_count") return `${name}: ${compliance.attended} of ${compliance.threshold ?? 0} meetings · ${status}`;
  return `${name}: ${attendanceRateText(compliance.rate)} of ${compliance.threshold ?? 0}% · ${status}`;
}
export function policyHistoryText(summary: ReportHistory): string {
  if (summary.ruleType === "weekly_count") return `${summary.labelName}: ${summary.weeksMet}/${summary.weeksDue} weeks`;
  const result = summary.rate === null ? "N/A" : `${summary.rate}%`;
  return `${summary.labelName}: ${result} · excused ${summary.excusedHandling === "count_missed" ? "count as missed" : "excluded"}`;
}
export function defaultRosterRates(report: AttendanceReport) { return { meetingCount: report.meetings.length, rates: Object.fromEntries(report.members.map((item) => [item.member.id, { regularAttendance: item.regularAttendance, currentCompliances: item.currentCompliances ?? [item.currentCompliance], currentCompliance: item.currentCompliance, complete: true }])) }; }

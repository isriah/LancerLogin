// User-facing attendance terms. The dashboard, report builder, Discord and email
// all read these so every surface names, words and explains attendance rates the same way.

/** A label policy's status as the attendance calculation reports it. */
export type AttendancePolicyStatus = "met" | "below" | "pending" | "not_applicable" | "no_rule";

/** Status words shown to people: always capitalised words, never raw identifiers or "N/A". */
export const attendanceStatusLabels = Object.freeze<Record<AttendancePolicyStatus, string>>({
  met: "Met",
  below: "Below target",
  pending: "In progress",
  not_applicable: "Not enough meetings yet",
  no_rule: "No policy",
});

/** A policy status as words; an unknown status reads in sentence case rather than as its identifier. */
export function attendanceStatusText(status: string): string {
  const known = (attendanceStatusLabels as Record<string, string>)[status];
  if (known) return known;
  const words = status.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Placeholder in static report field labels for the current-standing window. The report catalog is static,
 * so the API fills in the configured number of days (`attendance_recent_days`) when it serves labels.
 */
export const recentWindowPlaceholder = "Last N days";
/** The current-standing window's name, such as "Last 30 days". */
export const recentWindowName = (days: number): string => days === 1 ? "Last 1 day" : `Last ${days} days`;
/** A label with its "Last N days" placeholder filled in; other labels are returned unchanged. */
export const withRecentWindow = (label: string, days: number | undefined): string => days ? label.replace(recentWindowPlaceholder, recentWindowName(days)) : label;

export const attendanceTerms = Object.freeze({
  overallRate: { term: "Overall rate", definition: "Share of all required meetings attended. Excused meetings count as missed. The same for everyone." },
  attendanceRate: { term: "Attendance rate", definition: "The rate this label's attendance policy uses. Depending on the policy, excused meetings may be left out." },
  attendancePolicy: { term: "Attendance policy", definition: "A label's attendance target: a weighted percentage or a number of meetings each week, with its own handling of excused meetings." },
  recentWindow: { term: recentWindowPlaceholder, definition: "Measured over the last N days, ending today, regardless of the report's dates." },
});

/** The "Last N days" definition with N filled in when the window is known. */
export function recentWindowDefinition(days?: number): string {
  const definition = attendanceTerms.recentWindow.definition;
  return days ? definition.replace("the last N days", `the ${recentWindowName(days).toLowerCase()}`) : definition;
}

/** The info-tip text for a report field's column header, or undefined when the field needs none. */
export function attendanceFieldDefinition(fieldId: string, recentDays?: number): string | undefined {
  const recent = `${recentWindowDefinition(recentDays)} Weekly-count policies show the current week.`;
  if (fieldId === "attendance.member.regular-rate") return attendanceTerms.overallRate.definition;
  if (fieldId === "attendance.policy.report-result") return attendanceTerms.attendanceRate.definition;
  if (fieldId === "attendance.policy.official-result") return `${attendanceTerms.attendanceRate.definition} ${recent}`;
  if (fieldId === "attendance.member.assigned-policies" || fieldId.startsWith("attendance.policy.official-")) return recent;
  return undefined;
}

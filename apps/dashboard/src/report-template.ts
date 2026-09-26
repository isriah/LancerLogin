import type { ReportDefinition } from "./saved-reports";

export const exampleReportName = "Monthly attendance example";
export function exampleReportDefinition(): ReportDefinition {
  return {
    version: 1, period: { type: "current_month" }, roster: "active", meetingType: "all",
    labelIds: [], labelMatch: "any", membership: "current",
    columns: ["member", "member_id", "current_labels", "present_count", "absent_count", "excused_count", "report_policy_summary"].map((key) => ({ key })),
    sort: { column: { key: "member" }, direction: "asc" },
  };
}

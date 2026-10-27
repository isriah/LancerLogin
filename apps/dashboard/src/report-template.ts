import { bundledModuleRegistry } from "../../../packages/shared/src/module-platform.ts";
import { emptyModuleFilterSelections, type ReportDefinition } from "./saved-reports.ts";

export const exampleReportName = "Monthly attendance example";
export function exampleReportDefinition(): ReportDefinition {
  return {
    version: 2, dataset: "attendance.members", groupBy: ["core.member.identity"], period: { type: "current_month" }, roster: "active", meetingType: "all",
    labelIds: [], labelMatch: "any", ...emptyModuleFilterSelections(bundledModuleRegistry.reportFilters), membership: "current",
    columns: ["core.member.name", "core.member.id", "core.member.labels", "attendance.detail.present-count", "attendance.detail.absent-count", "attendance.detail.excused-count", "attendance.policy.report-summary"].map((key) => ({ key })),
    sort: { column: { key: "core.member.name" }, direction: "asc" },
  };
}

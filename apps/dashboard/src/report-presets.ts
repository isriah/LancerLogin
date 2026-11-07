// Report presets on /reports/new. A preset only fills in an ordinary report definition: every column and filter it adds
// can be changed afterwards like any other.
import { bundledModuleRegistry } from "../../../packages/shared/src/module-platform.ts";
import { labelSetFieldLabels, labelSetFields, labelSetKeys, maxLabelSets, type LabelPolicySummary } from "../../../packages/shared/src/attendance-label-sets.ts";
import { emptyModuleFilterSelections, type ReportDefinition, type ReportPeriod } from "./saved-reports.ts";

export const attendanceByLabelPreset = Object.freeze({
  name: "Attendance by label",
  description: "One row per member. Overall rate, then a column set for each label you choose.",
  defaultReportName: "Attendance by label",
  /** Member, Overall rate and five sets of six columns fill a report's 32 columns. */
  maxLabels: maxLabelSets,
});

/** The periods the preset offers, most useful first. */
export const presetPeriodOptions: readonly (readonly [string, string])[] = [["last_90", "Last 90 days"], ["current_month", "This month"], ["last_month", "Last month"], ["baseline", "Attendance baseline"], ["all", "All history"]];

/**
 * The preset's report: Member, Overall rate, then each chosen label's column set in the order given, filtered to members
 * with any of those labels and ranked by Overall rate. Labels without a policy add nothing.
 */
export function attendanceByLabelDefinition(labels: readonly LabelPolicySummary[], period: ReportPeriod): ReportDefinition {
  const chosen = labels.slice(0, attendanceByLabelPreset.maxLabels);
  return {
    version: 2, dataset: "attendance.members", groupBy: ["core.member.identity"], period, roster: "active", meetingType: "all",
    labelIds: chosen.map((label) => label.labelId), labelMatch: "any", ...emptyModuleFilterSelections(bundledModuleRegistry.reportFilters), membership: "current",
    columns: [{ key: "core.member.name" }, { key: "attendance.member.regular-rate" }, ...chosen.flatMap((label) => labelSetKeys(label.ruleType).map((key) => ({ key, labelId: label.labelId })))],
    columnFilters: [], sort: { column: { key: "attendance.member.regular-rate" }, direction: "desc" },
  };
}

/** What the preset will add, so the report it creates is no surprise. */
export function attendanceByLabelSummary(labels: readonly { name: string; policy: Pick<LabelPolicySummary, "ruleType"> }[]): { heading: string; columns: string; filter: string } {
  const count = 2 + labels.length * 6;
  const weekly = labels.some((label) => label.policy.ruleType === "weekly_count");
  const set = labelSetKeys("weighted_percentage").map((key) => labelSetFieldLabels[key]).join(", ");
  return {
    heading: `Adds ${count} columns`,
    columns: `Member · Overall rate · then for each label: ${set}${weekly ? ` (${labelSetFieldLabels[labelSetFields.weeksMet]} in place of ${labelSetFieldLabels[labelSetFields.counted]} for a meetings-per-week label)` : ""}`,
    filter: labels.length ? `Also adds the filter "Labels: ${labels.map((label) => label.name).join(" or ")}" and sorts by Overall rate.` : "Choose at least one label.",
  };
}

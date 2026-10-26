import { localDate, type AttendanceRule, type PolicyCompliance, type PolicyHistory, type PolicyLabel, type PolicyMeeting, type PolicyMemberResult } from "./attendance-policy.ts";
import { bundledModuleRegistry, coreReportDatasets, type ReportDatasetDefinition, type ReportDurationUnit, type ReportFieldDefinition, type ReportFilterOperator } from "../../../packages/shared/src/module-platform.ts";

export type ReportScope = "personal" | "shared";
export type ReportPeriod =
  | { type: "all" }
  | { type: "baseline" }
  | { type: "last_days"; days: 7 | 30 | 60 | 90 }
  | { type: "current_month" }
  | { type: "current_year" }
  | { type: "fixed"; from: string; to: string };
export type LegacyReportColumnKey =
  | "member" | "member_id" | "email" | "discord_id" | "active_status" | "current_labels" | "attendance_required_from"
  | "regular_attendance" | "regular_weighted_present" | "regular_weighted_eligible" | "regular_period"
  | "assigned_policies" | "official_policy_result" | "official_policy_status" | "official_policy_target" | "official_policy_type" | "official_policy_excused" | "official_policy_period"
  | "report_policy_summary" | "report_policy_result" | "report_policy_status" | "report_policy_target" | "report_policy_period" | "policy_history"
  | "present_count" | "present_dates" | "absent_count" | "absent_dates" | "excused_count" | "excused_dates";
export type ReportColumn = { key: string; labelId?: string; unit?: ReportDurationUnit };
export type ReportColumnFilter = { column: ReportColumn; operator: ReportFilterOperator; value: string; upperValue?: string };
type ReportDefinitionBase = {
  period: ReportPeriod;
  roster: "active" | "all";
  meetingType: "all" | "required" | "optional";
  labelIds: string[];
  labelMatch: "any" | "all";
  outreachLabelIds: string[];
  outreachLabelMatch: "any" | "all";
  membership: "current" | "historical";
  columns: ReportColumn[];
  columnFilters?: ReportColumnFilter[];
  sort: { column: ReportColumn; direction: "asc" | "desc" };
};
export type ReportDefinitionV1 = ReportDefinitionBase & {
  version: 1;
};
export type ReportDefinitionV2 = ReportDefinitionBase & { version: 2; dataset: string; groupBy: string[] };
export type ReportDefinition = ReportDefinitionV1 | ReportDefinitionV2;
export type NormalizedReportDefinition = ReportDefinitionV2;
export type ReportCell = { text: string; sortValue: string | number | null; dates?: string[]; empty?: boolean; unavailable?: boolean; explanation?: string };
export type ReportResultRow = { id: string; label: string; href?: string; member?: { id: string; memberId: string; name: string }; cells: Record<string, ReportCell> };
export type ReportColumnCatalogItem = { key: string; label: string; group: string; sortable: boolean; filterKind: "text" | "number"; requiresLabel?: boolean; durationUnits?: readonly ReportDurationUnit[]; defaultDurationUnit?: ReportDurationUnit; datasets: string[] };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const contributedReportDatasets = Object.freeze<readonly ReportDatasetDefinition[]>([
  ...coreReportDatasets,
  ...bundledModuleRegistry.modules.flatMap((module) => module.reportDatasets ?? []),
]);
const memberReportDatasets = contributedReportDatasets.filter((dataset) => dataset.rowIdentity === "core.member.identity");
const combinedMemberFields = [...new Map(memberReportDatasets.flatMap((dataset) => dataset.fields).map((field) => [field.id, field])).values()];
const combinedMemberMeasures = memberReportDatasets.filter((dataset) => dataset.id !== "core.members").flatMap((dataset) => {
  const preferred = dataset.defaultColumns.find((id) => dataset.fields.find((field) => field.id === id)?.kind === "measure");
  return preferred ? [preferred] : [];
});
export const combinedMemberDataset: ReportDatasetDefinition = Object.freeze({
  id: "core.combined-members",
  label: "Members - combined",
  description: "Community roster members with side-by-side measures from the modules you can access.",
  rowIdentity: "core.member.identity",
  capability: "core.roster",
  fields: Object.freeze(combinedMemberFields),
  filters: Object.freeze(["period", "roster", "meeting-type", "labels", "membership", "outreach-labels"] as const),
  groupBy: Object.freeze(["core.member.identity"]),
  defaultColumns: Object.freeze(["core.member.name", ...combinedMemberMeasures]),
  defaultSort: Object.freeze({ field: "core.member.name", direction: "asc" }),
  relationships: Object.freeze(memberReportDatasets.map((dataset) => ({ dataset: dataset.id, localField: "core.member.identity", foreignField: dataset.rowIdentity }))),
});
export const reportDatasetCatalog = Object.freeze<readonly ReportDatasetDefinition[]>([
  ...coreReportDatasets,
  combinedMemberDataset,
  ...contributedReportDatasets.filter((dataset) => !coreReportDatasets.some((core) => core.id === dataset.id)),
]);
const datasets = new Map(reportDatasetCatalog.map((dataset) => [dataset.id, dataset]));
const fields = new Map<string, ReportFieldDefinition>();
const fieldDatasets = new Map<string, string[]>();
for (const dataset of reportDatasetCatalog) for (const field of dataset.fields) {
  fields.set(field.id, field);
  fieldDatasets.set(field.id, [...(fieldDatasets.get(field.id) ?? []), dataset.id]);
}
export const reportColumnCatalog: ReportColumnCatalogItem[] = [...fields.values()].map((field) => ({ key: field.id, label: field.label, group: field.group, sortable: field.sortable, filterKind: field.valueType === "number" ? "number" : "text", requiresLabel: field.requiresLabel, durationUnits: field.durationUnits, defaultDurationUnit: field.defaultDurationUnit, datasets: fieldDatasets.get(field.id) ?? [] }));
export function reportDatasetDefinition(datasetId: string) { return datasets.get(datasetId); }
export function reportFieldSourceDataset(datasetId: string, fieldId: string): string | undefined {
  if (datasetId !== combinedMemberDataset.id) return datasets.get(datasetId)?.fields.some((field) => field.id === fieldId) ? datasetId : undefined;
  if (coreReportDatasets.some((dataset) => dataset.fields.some((field) => field.id === fieldId))) return "core.members";
  return memberReportDatasets.find((dataset) => dataset.id !== "core.members" && dataset.fields.some((field) => field.id === fieldId))?.id;
}
export function reportFilterSourceDataset(datasetId: string, filter: ReportDatasetDefinition["filters"][number]): string | undefined {
  const dataset = datasets.get(datasetId); if (!dataset) return;
  if (datasetId !== combinedMemberDataset.id) return dataset.filters.includes(filter) ? datasetId : undefined;
  const related = dataset.relationships.map((relationship) => datasets.get(relationship.dataset)).filter((candidate): candidate is ReportDatasetDefinition => Boolean(candidate?.filters.includes(filter)));
  const core = related.find((candidate) => candidate.id === "core.members");
  if (core) return core.id;
  return related.length === 1 ? related[0]!.id : undefined;
}
const legacyFields: Record<LegacyReportColumnKey, string> = {
  member: "core.member.name", member_id: "core.member.id", email: "core.member.email", discord_id: "core.member.discord-id", active_status: "core.member.status", current_labels: "core.member.labels", attendance_required_from: "attendance.member.required-from",
  regular_attendance: "attendance.member.regular-rate", regular_weighted_present: "attendance.member.weighted-present", regular_weighted_eligible: "attendance.member.weighted-eligible", regular_period: "attendance.member.regular-period",
  assigned_policies: "attendance.member.assigned-policies", official_policy_result: "attendance.policy.official-result", official_policy_status: "attendance.policy.official-status", official_policy_target: "attendance.policy.official-target", official_policy_type: "attendance.policy.official-type", official_policy_excused: "attendance.policy.official-excused", official_policy_period: "attendance.policy.official-period",
  report_policy_summary: "attendance.policy.report-summary", report_policy_result: "attendance.policy.report-result", report_policy_status: "attendance.policy.report-status", report_policy_target: "attendance.policy.report-target", report_policy_period: "attendance.policy.report-period", policy_history: "attendance.policy.history",
  present_count: "attendance.detail.present-count", present_dates: "attendance.detail.present-dates", absent_count: "attendance.detail.absent-count", absent_dates: "attendance.detail.absent-dates", excused_count: "attendance.detail.excused-count", excused_dates: "attendance.detail.excused-dates",
};
const canonicalField = (key: string) => legacyFields[key as LegacyReportColumnKey] ?? (key === "outreach.activity.category" ? "outreach.activity.labels" : key);

export function defaultReportDefinition(hasBaseline: boolean, datasetId = "attendance.members"): NormalizedReportDefinition {
  const dataset = datasets.get(datasetId) ?? datasets.get("core.members")!;
  const column = (key: string): ReportColumn => { const unit = fields.get(key)?.defaultDurationUnit; return unit ? { key, unit } : { key }; };
  return { version: 2, dataset: dataset.id, groupBy: [...dataset.groupBy], period: dataset.filters.includes("period") && hasBaseline ? { type: "baseline" } : { type: "all" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", outreachLabelIds: [], outreachLabelMatch: "any", membership: "current", columns: dataset.defaultColumns.map(column), columnFilters: [], sort: { column: column(dataset.defaultSort.field), direction: dataset.defaultSort.direction } };
}

const isDate = (value: unknown): value is string => typeof value === "string" && datePattern.test(value) && new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value;
const columnId = (column: ReportColumn) => `${column.key}${column.labelId ? `:${column.labelId}` : ""}`;
export { columnId as reportColumnId };

function parseColumn(value: unknown, dataset: ReportDatasetDefinition, legacy: boolean, knownLabels: Set<string>, allowMissingLabels: boolean, warnings: string[]): ReportColumn | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as { key?: unknown; labelId?: unknown; unit?: unknown };
  if (typeof candidate.key !== "string") return;
  const key = canonicalField(candidate.key);
  const item = dataset.fields.find((field) => field.id === key);
  if (!item) return;
  if (candidate.unit !== undefined && (typeof candidate.unit !== "string" || !item.durationUnits?.includes(candidate.unit as ReportDurationUnit))) return;
  const unit = (candidate.unit ?? item.defaultDurationUnit) as ReportDurationUnit | undefined;
  if (item.requiresLabel) {
    if (typeof candidate.labelId !== "string" || !candidate.labelId) return;
    if (!knownLabels.has(candidate.labelId)) {
      if (!allowMissingLabels) return;
      warnings.push("A policy column references a label that is no longer available.");
    }
    return { key, labelId: candidate.labelId, ...(unit ? { unit } : {}) };
  }
  return { key, ...(unit ? { unit } : {}) };
}

export function validateReportDefinition(value: unknown, labels: PolicyLabel[], { allowMissingLabels = false, outreachLabels = [] }: { allowMissingLabels?: boolean; outreachLabels?: Array<{ id: string }> } = {}): { definition?: NormalizedReportDefinition; warnings: string[]; errors: string[] } {
  const warnings: string[] = [], errors: string[] = [];
  if (!value || typeof value !== "object") return { warnings, errors: ["Report definition is required."] };
  const input = value as Partial<ReportDefinition> & Record<string, unknown>; const knownLabels = new Set(labels.map((label) => label.id));
  const legacy = input.version === 1; const dataset = datasets.get(legacy ? "attendance.members" : String(input.dataset));
  if (!dataset) errors.push("Choose an available report dataset.");
  let period: ReportPeriod | undefined;
  if (input.period?.type === "all" || input.period?.type === "baseline" || input.period?.type === "current_month" || input.period?.type === "current_year") period = { type: input.period.type };
  else if (input.period?.type === "last_days" && [7, 30, 60, 90].includes(Number(input.period.days))) period = { type: "last_days", days: Number(input.period.days) as 7 | 30 | 60 | 90 };
  else if (input.period?.type === "fixed" && isDate(input.period.from) && isDate(input.period.to) && input.period.from <= input.period.to) period = { type: "fixed", from: input.period.from, to: input.period.to };
  else errors.push("Choose a valid report period.");
  const roster = input.roster === "all" || input.roster === "active" ? input.roster : undefined;
  const meetingType = ["all", "required", "optional"].includes(String(input.meetingType)) ? input.meetingType as ReportDefinition["meetingType"] : undefined;
  const labelMatch = input.labelMatch === "all" || input.labelMatch === "any" ? input.labelMatch : undefined;
  const membership = input.membership === "current" || input.membership === "historical" ? input.membership : undefined;
  if (!roster || !meetingType || !labelMatch || !membership) errors.push("Report filters are invalid.");
  const labelIds = Array.isArray(input.labelIds) && input.labelIds.length <= 25 && input.labelIds.every((id) => typeof id === "string") ? [...new Set(input.labelIds)] : [];
  if (!Array.isArray(input.labelIds) || labelIds.length !== input.labelIds.length) errors.push("Report label filters are invalid.");
  for (const id of labelIds) if (!knownLabels.has(id)) { if (allowMissingLabels) warnings.push("A report filter references a label that is no longer available."); else errors.push("A report filter references an unknown label."); }
  const knownOutreachLabels = new Set(outreachLabels.map((label) => label.id));
  const rawOutreachLabelIds = input.outreachLabelIds ?? [];
  const outreachLabelIds = Array.isArray(rawOutreachLabelIds) && rawOutreachLabelIds.length <= 25 && rawOutreachLabelIds.every((id) => typeof id === "string") ? [...new Set(rawOutreachLabelIds)] : [];
  const outreachLabelMatch = input.outreachLabelMatch === undefined ? "any" : input.outreachLabelMatch === "all" || input.outreachLabelMatch === "any" ? input.outreachLabelMatch : undefined;
  if (!Array.isArray(rawOutreachLabelIds) || outreachLabelIds.length !== rawOutreachLabelIds.length || !outreachLabelMatch || outreachLabelIds.length && !dataset?.filters.includes("outreach-labels")) errors.push("Report Outreach label filters are invalid.");
  for (const id of outreachLabelIds) if (!knownOutreachLabels.has(id)) { if (allowMissingLabels) warnings.push("A report filter references an Outreach label that is no longer available."); else errors.push("A report filter references an unknown Outreach label."); }
  const columns = dataset && Array.isArray(input.columns) ? input.columns.map((item) => parseColumn(item, dataset, legacy, knownLabels, allowMissingLabels, warnings)).filter((item): item is ReportColumn => Boolean(item)) : [];
  if (!dataset || !Array.isArray(input.columns) || columns.length !== input.columns.length || columns.length < 1 || columns.length > 32 || columns[0]?.key !== dataset.defaultColumns[0] || columns.slice(1).some((column) => column.key === dataset.defaultColumns[0]) || new Set(columns.map(columnId)).size !== columns.length) errors.push(`Report columns are invalid and must begin with ${dataset?.fields.find((field) => field.id === dataset.defaultColumns[0])?.label ?? "the dataset identity"}.`);
  const requestedSortColumn = dataset ? parseColumn(input.sort?.column, dataset, legacy, knownLabels, allowMissingLabels, warnings) : undefined; const sortColumn = requestedSortColumn ? columns.find((column) => columnId(column) === columnId(requestedSortColumn)) : undefined; const direction = input.sort?.direction;
  if (!sortColumn || !["asc", "desc"].includes(String(direction)) || !fields.get(sortColumn.key)?.sortable) errors.push("Choose a visible sortable report column.");
  const rawColumnFilters = input.columnFilters ?? [];
  const columnFilters = Array.isArray(rawColumnFilters) ? rawColumnFilters.flatMap((value): ReportColumnFilter[] => {
    if (!value || typeof value !== "object") return [];
    const candidate = value as Partial<ReportColumnFilter>;
    const column = dataset ? parseColumn(candidate.column, dataset, legacy, knownLabels, allowMissingLabels, warnings) : undefined;
    const visibleColumn = column ? columns.find((visible) => columnId(visible) === columnId(column)) : undefined;
    const item = visibleColumn ? fields.get(visibleColumn.key) : undefined;
    const operator = candidate.operator;
    const filterValue = typeof candidate.value === "string" ? candidate.value.trim() : "";
    const upperValue = typeof candidate.upperValue === "string" ? candidate.upperValue.trim() : "";
    if (!visibleColumn || !item || !operator || !item.filterOperators.includes(operator)) return [];
    if (operator === "empty" || operator === "not_empty") return [{ column: visibleColumn, operator, value: "" }];
    const validValue = (value: string) => Boolean(value) && value.length <= 100 && (item.valueType === "number" ? Number.isFinite(Number(value)) : item.valueType === "date" && operator !== "contains" ? /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value : true);
    if (!validValue(filterValue)) return [];
    if (operator === "between" && (!validValue(upperValue) || (item.valueType === "number" ? Number(filterValue) > Number(upperValue) : filterValue > upperValue))) return [];
    return [{ column: visibleColumn, operator, value: filterValue, ...(operator === "between" ? { upperValue } : {}) }];
  }) : [];
  if (!Array.isArray(rawColumnFilters) || rawColumnFilters.length > 16 || columnFilters.length !== rawColumnFilters.length || new Set(columnFilters.map((filter) => columnId(filter.column))).size !== columnFilters.length) errors.push("Report column filters are invalid.");
  const requestedGroupBy = legacy ? dataset?.groupBy : Array.isArray(input.groupBy) ? input.groupBy.map((field) => typeof field === "string" ? canonicalField(field) : field) : input.groupBy;
  const groupBy = dataset && Array.isArray(requestedGroupBy) && requestedGroupBy.every((field) => typeof field === "string" && dataset.groupBy.includes(field)) ? [...new Set(requestedGroupBy as string[])] : [];
  if (!dataset || !groupBy.length || groupBy.length !== (requestedGroupBy as unknown[] | undefined)?.length) errors.push("Report grouping is invalid.");
  if (errors.length || !dataset || !period || !roster || !meetingType || !labelMatch || !outreachLabelMatch || !membership || !sortColumn) return { warnings: [...new Set(warnings)], errors };
  return { definition: { version: 2, dataset: dataset.id, groupBy, period, roster, meetingType, labelIds, labelMatch, outreachLabelIds, outreachLabelMatch, membership, columns, columnFilters, sort: { column: sortColumn, direction: direction as "asc" | "desc" } }, warnings: [...new Set(warnings)], errors };
}

function shiftDate(date: string, days: number): string { const value = new Date(date + "T12:00:00.000Z"); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export function resolveReportPeriod(period: ReportPeriod, today: string, baseline: string | null): { from?: string; to?: string; warning?: string } {
  if (period.type === "all") return {};
  if (period.type === "baseline") return baseline ? { from: baseline, to: today } : { warning: "The operational reporting baseline is not configured." };
  if (period.type === "last_days") return { from: shiftDate(today, 1 - period.days), to: today };
  if (period.type === "current_month") return { from: today.slice(0, 7) + "-01", to: today };
  if (period.type === "current_year") return { from: today.slice(0, 4) + "-01-01", to: today };
  return { from: period.from, to: period.to };
}

export function reportLabelsMatch(current: string[], selected: string[], mode: "any" | "all"): boolean {
  if (!selected.length) return true; const values = new Set(current);
  return mode === "all" ? selected.every((id) => values.has(id)) : selected.some((id) => values.has(id));
}

const percentage = (value: number | null) => value === null ? "N/A" : `${value}%`;
const statusText = (value: string) => value === "not_applicable" || value === "no_rule" ? "N/A" : value.replaceAll("_", " ");
const policyResult = (policy?: PolicyCompliance) => !policy ? "N/A" : policy.status === "no_rule" ? `${policy.labelName ?? "Attendance policy"}: no active rule` : policy.status === "not_applicable" ? `${policy.labelName ?? "Attendance policy"}: N/A` : policy.ruleType === "weekly_count" ? `${policy.attended} of ${policy.threshold ?? 0} meetings · ${statusText(policy.status)}` : `${percentage(policy.rate)} of ${policy.threshold ?? 0}% · ${statusText(policy.status)}`;
const historyResult = (history: PolicyHistory) => history.status === "not_applicable" ? `${history.labelName}: N/A` : history.ruleType === "weekly_count" ? `${history.labelName}: ${history.weeksMet}/${history.weeksDue} weeks · ${statusText(history.status)}` : `${history.labelName}: ${percentage(history.rate)} · ${statusText(history.status)}`;
const ruleTarget = (rule?: AttendanceRule) => !rule ? null : rule.ruleType === "weekly_count" ? Number(rule.meetingsPerWeek) : Number(rule.thresholdPercent);
const historyPeriod = (history: PolicyHistory, from?: string, to?: string) => `${[history.startsOn, from].filter((value): value is string => Boolean(value)).sort().at(-1) ?? "First eligible meeting"} to ${[history.endsOn, to].filter((value): value is string => Boolean(value)).sort()[0] ?? "today"}`;

export function reportColumnLabel(column: ReportColumn, labels: Map<string, string>): string {
  const field = fields.get(canonicalField(column.key)); const base = field?.label ?? column.key;
  const unitLabel = field?.durationUnits && column.unit === "hours" ? base === "Minutes" ? "Hours" : base.endsWith(" minutes") ? `${base.slice(0, -8)} hours` : `${base} (hours)` : base;
  return column.labelId ? `${labels.get(column.labelId) ?? "Unavailable label"} - ${unitLabel}` : unitLabel;
}

export function formatReportCellForColumn(column: ReportColumn, cell: ReportCell): ReportCell {
  const field = fields.get(canonicalField(column.key));
  if (!field?.durationUnits || column.unit !== "hours" || typeof cell.sortValue !== "number") return cell;
  const roundedHours = Math.round(cell.sortValue / 60 * 100) / 100;
  return { ...cell, text: roundedHours.toFixed(2), sortValue: roundedHours };
}

export function buildReportRows(input: { definition: ReportDefinition; official: PolicyMemberResult[]; period: PolicyMemberResult[]; meetings: PolicyMeeting[]; labels: PolicyLabel[]; rules: AttendanceRule[]; timeZone: string; from?: string; to?: string }): ReportResultRow[] {
  const official = new Map(input.official.map((item) => [item.member.id, item])); const labelNames = new Map(input.labels.map((label) => [label.id, label.name])); const meetings = new Map(input.meetings.map((meeting) => [meeting.id, meeting])); const rules = new Map(input.rules.map((rule) => [rule.id, rule]));
  const rows = input.period.map((item) => {
    const full = official.get(item.member.id) ?? item; const memberName = `${item.member.firstName} ${item.member.lastName}`; const dates = { present: [] as string[], absent: [] as string[], excused: [] as string[] };
    for (const row of item.rows) {
      const meeting = meetings.get(row.meetingId); const date = meeting ? localDate(meeting.startsAt, input.timeZone) : undefined; if (!date) continue;
      if (row.disposition === "present" && ["required", "weekly", "optional"].includes(row.eligibility)) dates.present.push(date);
      else if (row.disposition === "absent" && row.rateEligible) dates.absent.push(date);
      else if (row.disposition === "excused" && row.rateEligible) dates.excused.push(date);
    }
    for (const values of Object.values(dates)) values.sort();
    const cells: Record<string, ReportCell> = {};
    for (const column of input.definition.columns) {
      const id = columnId(column); const officialPolicy = column.labelId ? full.currentCompliances.find((policy) => policy.labelId === column.labelId) : undefined; const periodPolicies = column.labelId ? item.historySummaries.filter((summary) => summary.labelId === column.labelId) : []; const periodRule = periodPolicies.length === 1 ? rules.get(periodPolicies[0].ruleId) : undefined;
      let cell: ReportCell = { text: "N/A", sortValue: null };
      switch (canonicalField(column.key)) {
        case "core.member.identity": cell = { text: item.member.id, sortValue: item.member.id }; break;
        case "core.member.name": cell = { text: memberName, sortValue: `${item.member.lastName}\u0000${item.member.firstName}\u0000${item.member.memberId}` }; break;
        case "core.member.id": cell = { text: item.member.memberId, sortValue: item.member.memberId }; break;
        case "core.member.email": cell = { text: item.member.email ?? "", sortValue: item.member.email?.toLowerCase() ?? null }; break;
        case "core.member.discord-id": cell = { text: item.member.discordUserId ?? "", sortValue: item.member.discordUserId ?? null }; break;
        case "core.member.status": cell = { text: item.member.active ? "Active" : "Inactive", sortValue: item.member.active ? 1 : 0 }; break;
        case "core.member.labels": { const names = full.currentLabelIds.map((labelId) => labelNames.get(labelId) ?? "Unavailable label").sort(); cell = { text: names.join("; ") || "None", sortValue: null, empty: !names.length }; break; }
        case "attendance.member.required-from": cell = { text: item.member.attendanceRequiredFrom ?? "", sortValue: item.member.attendanceRequiredFrom ?? null }; break;
        case "attendance.member.regular-rate": cell = { text: percentage(item.regularAttendance.rate), sortValue: item.regularAttendance.rate }; break;
        case "attendance.member.weighted-present": cell = { text: String(item.regularAttendance.attended), sortValue: item.regularAttendance.attended }; break;
        case "attendance.member.weighted-eligible": cell = { text: String(item.regularAttendance.required), sortValue: item.regularAttendance.required }; break;
        case "attendance.member.regular-period": cell = { text: `${item.regularAttendance.from ?? "First eligible meeting"} to ${item.regularAttendance.to}`, sortValue: null }; break;
        case "attendance.member.assigned-policies": cell = { text: full.currentCompliances.length ? full.currentCompliances.map(policyResult).join("; ") : "No assigned policy", sortValue: null, empty: !full.currentCompliances.length }; break;
        case "attendance.policy.official-result": cell = { text: policyResult(officialPolicy), sortValue: officialPolicy?.ruleType === "weekly_count" ? officialPolicy.attended : officialPolicy?.rate ?? null }; break;
        case "attendance.policy.official-status": cell = { text: officialPolicy ? statusText(officialPolicy.status) : "N/A", sortValue: officialPolicy?.status ?? null }; break;
        case "attendance.policy.official-target": cell = { text: officialPolicy?.threshold == null ? "N/A" : String(officialPolicy.threshold), sortValue: officialPolicy?.threshold ?? null }; break;
        case "attendance.policy.official-type": cell = { text: officialPolicy?.ruleType === "weekly_count" ? "Weekly count" : officialPolicy?.ruleType === "weighted_percentage" ? "Weighted percentage" : "N/A", sortValue: officialPolicy?.ruleType ?? null }; break;
        case "attendance.policy.official-excused": cell = { text: officialPolicy?.excusedHandling === "count_missed" ? "Count as missed" : officialPolicy?.excusedHandling === "exclude" ? "Exclude" : "N/A", sortValue: officialPolicy?.excusedHandling ?? null }; break;
        case "attendance.policy.official-period": cell = { text: officialPolicy && officialPolicy.status !== "no_rule" ? `${officialPolicy.from} to ${officialPolicy.to}` : "N/A", sortValue: null }; break;
        case "attendance.policy.report-summary": cell = { text: item.historySummaries.length ? item.historySummaries.map(historyResult).join("; ") : "No policy results", sortValue: null, empty: !item.historySummaries.length }; break;
        case "attendance.policy.report-result": cell = { text: periodPolicies.length ? periodPolicies.map(historyResult).join("; ") : "N/A", sortValue: periodPolicies.length === 1 ? periodPolicies[0].rate : null }; break;
        case "attendance.policy.report-status": cell = { text: periodPolicies.length === 1 ? statusText(periodPolicies[0].status) : periodPolicies.length ? "Multiple periods" : "N/A", sortValue: periodPolicies.length === 1 ? periodPolicies[0].status : null }; break;
        case "attendance.policy.report-target": { const target = ruleTarget(periodRule); cell = { text: target === null ? "N/A" : String(target), sortValue: target }; break; }
        case "attendance.policy.report-period": cell = { text: periodPolicies.length ? periodPolicies.map((summary) => historyPeriod(summary, input.from, input.to)).join("; ") : "N/A", sortValue: null }; break;
        case "attendance.policy.history": cell = { text: full.historySummaries.length ? full.historySummaries.map(historyResult).join("; ") : "No policy history", sortValue: null, empty: !full.historySummaries.length }; break;
        case "attendance.detail.present-count": cell = { text: String(dates.present.length), sortValue: dates.present.length }; break;
        case "attendance.detail.present-dates": cell = { text: dates.present.join("; ") || "None", sortValue: null, dates: dates.present }; break;
        case "attendance.detail.absent-count": cell = { text: String(dates.absent.length), sortValue: dates.absent.length }; break;
        case "attendance.detail.absent-dates": cell = { text: dates.absent.join("; ") || "None", sortValue: null, dates: dates.absent }; break;
        case "attendance.detail.excused-count": cell = { text: String(dates.excused.length), sortValue: dates.excused.length }; break;
        case "attendance.detail.excused-dates": cell = { text: dates.excused.join("; ") || "None", sortValue: null, dates: dates.excused }; break;
      }
      cells[id] = cell;
    }
    return { id: item.member.id, label: memberName, href: `/roster/${encodeURIComponent(item.member.memberId)}`, member: { id: item.member.id, memberId: item.member.memberId, name: memberName }, cells };
  });
  return filterAndSortReportRows(input.definition, rows);
}

export function filterAndSortReportRows(definition: ReportDefinition, rows: ReportResultRow[]): ReportResultRow[] {
  const filteredRows = rows.filter((row) => (definition.columnFilters ?? []).every((filter) => {
    const cell = row.cells[columnId(filter.column)];
    if (!cell || cell.unavailable) return false;
    const numeric = fields.get(canonicalField(filter.column.key))?.valueType === "number";
    const empty = cell.empty ?? (cell.dates ? !cell.dates.length : numeric ? cell.sortValue === null : !cell.text.trim() || cell.sortValue === null && cell.text === "N/A");
    if (filter.operator === "empty") return empty;
    if (filter.operator === "not_empty") return !empty;
    if (filter.operator === "contains") return cell.text.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
    if (empty) return false;
    const value = numeric ? Number(cell.sortValue) : cell.text.toLocaleLowerCase();
    const lower = typeof value === "number" ? Number(filter.value) : filter.value.toLocaleLowerCase();
    const upper = typeof value === "number" ? Number(filter.upperValue) : (filter.upperValue ?? "").toLocaleLowerCase();
    if (filter.operator === "equals") return value === lower;
    if (filter.operator === "minimum") return value >= lower;
    if (filter.operator === "maximum") return value <= lower;
    return value >= lower && value <= upper;
  }));
  const sortId = columnId(definition.sort.column), direction = definition.sort.direction === "asc" ? 1 : -1;
  return filteredRows.sort((left, right) => { const a = left.cells[sortId]?.sortValue ?? null, b = right.cells[sortId]?.sortValue ?? null; if (a === null && b !== null) return 1; if (a !== null && b === null) return -1; if (a === null && b === null) return left.label.localeCompare(right.label) || left.id.localeCompare(right.id); const compared = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)); return compared * direction || left.label.localeCompare(right.label) || left.id.localeCompare(right.id); });
}

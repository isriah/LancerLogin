import { localDate, type AttendanceRule, type PolicyCompliance, type PolicyHistory, type PolicyLabel, type PolicyMeeting, type PolicyMemberResult } from "./attendance-policy.ts";

export type ReportScope = "personal" | "shared";
export type ReportPeriod =
  | { type: "all" }
  | { type: "baseline" }
  | { type: "last_days"; days: 7 | 30 | 60 | 90 }
  | { type: "current_month" }
  | { type: "current_year" }
  | { type: "fixed"; from: string; to: string };
export type ReportColumnKey =
  | "member" | "member_id" | "email" | "discord_id" | "active_status" | "current_labels" | "attendance_required_from"
  | "regular_attendance" | "regular_weighted_present" | "regular_weighted_eligible" | "regular_period"
  | "assigned_policies" | "official_policy_result" | "official_policy_status" | "official_policy_target" | "official_policy_type" | "official_policy_excused" | "official_policy_period"
  | "report_policy_summary" | "report_policy_result" | "report_policy_status" | "report_policy_target" | "report_policy_period" | "policy_history"
  | "present_count" | "present_dates" | "absent_count" | "absent_dates" | "excused_count" | "excused_dates";
export type ReportColumn = { key: ReportColumnKey; labelId?: string };
export type ReportColumnFilter = { column: ReportColumn; operator: "contains" | "minimum"; value: string };
export type ReportDefinition = {
  version: 1;
  period: ReportPeriod;
  roster: "active" | "all";
  meetingType: "all" | "required" | "optional";
  labelIds: string[];
  labelMatch: "any" | "all";
  membership: "current" | "historical";
  columns: ReportColumn[];
  columnFilters?: ReportColumnFilter[];
  sort: { column: ReportColumn; direction: "asc" | "desc" };
};
export type ReportCell = { text: string; sortValue: string | number | null; dates?: string[] };
export type ReportResultRow = { member: { id: string; memberId: string; name: string }; cells: Record<string, ReportCell> };
export type ReportColumnCatalogItem = { key: ReportColumnKey; label: string; group: "Roster" | "Regular attendance" | "Policies" | "Attendance detail"; sortable: boolean; filterKind: "text" | "number"; requiresLabel?: boolean };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const labelKeys = new Set<ReportColumnKey>(["official_policy_result", "official_policy_status", "official_policy_target", "official_policy_type", "official_policy_excused", "official_policy_period", "report_policy_result", "report_policy_status", "report_policy_target", "report_policy_period"]);
export const reportColumnCatalog: ReportColumnCatalogItem[] = [
  { key: "member", label: "Member", group: "Roster", sortable: true, filterKind: "text" },
  { key: "member_id", label: "Member ID", group: "Roster", sortable: true, filterKind: "text" },
  { key: "email", label: "Email", group: "Roster", sortable: true, filterKind: "text" },
  { key: "discord_id", label: "Discord ID", group: "Roster", sortable: true, filterKind: "text" },
  { key: "active_status", label: "Roster status", group: "Roster", sortable: true, filterKind: "text" },
  { key: "current_labels", label: "Current labels", group: "Roster", sortable: false, filterKind: "text" },
  { key: "attendance_required_from", label: "Attendance starts", group: "Roster", sortable: true, filterKind: "text" },
  { key: "regular_attendance", label: "Regular attendance", group: "Regular attendance", sortable: true, filterKind: "number" },
  { key: "regular_weighted_present", label: "Regular weighted present", group: "Regular attendance", sortable: true, filterKind: "number" },
  { key: "regular_weighted_eligible", label: "Regular weighted eligible", group: "Regular attendance", sortable: true, filterKind: "number" },
  { key: "regular_period", label: "Regular reporting period", group: "Regular attendance", sortable: false, filterKind: "text" },
  { key: "assigned_policies", label: "Assigned policies", group: "Policies", sortable: false, filterKind: "text" },
  { key: "official_policy_result", label: "Official policy result", group: "Policies", sortable: true, filterKind: "number", requiresLabel: true },
  { key: "official_policy_status", label: "Official policy status", group: "Policies", sortable: true, filterKind: "text", requiresLabel: true },
  { key: "official_policy_target", label: "Official policy target", group: "Policies", sortable: true, filterKind: "number", requiresLabel: true },
  { key: "official_policy_type", label: "Official policy type", group: "Policies", sortable: true, filterKind: "text", requiresLabel: true },
  { key: "official_policy_excused", label: "Official excuse handling", group: "Policies", sortable: true, filterKind: "text", requiresLabel: true },
  { key: "official_policy_period", label: "Official policy period", group: "Policies", sortable: false, filterKind: "text", requiresLabel: true },
  { key: "report_policy_summary", label: "Report-period policies", group: "Policies", sortable: false, filterKind: "text" },
  { key: "report_policy_result", label: "Report-period policy result", group: "Policies", sortable: true, filterKind: "number", requiresLabel: true },
  { key: "report_policy_status", label: "Report-period policy status", group: "Policies", sortable: true, filterKind: "text", requiresLabel: true },
  { key: "report_policy_target", label: "Report-period policy target", group: "Policies", sortable: true, filterKind: "number", requiresLabel: true },
  { key: "report_policy_period", label: "Report-period policy period", group: "Policies", sortable: false, filterKind: "text", requiresLabel: true },
  { key: "policy_history", label: "Policy history", group: "Policies", sortable: false, filterKind: "text" },
  { key: "present_count", label: "Present count", group: "Attendance detail", sortable: true, filterKind: "number" },
  { key: "present_dates", label: "Present dates", group: "Attendance detail", sortable: false, filterKind: "text" },
  { key: "absent_count", label: "Absent count", group: "Attendance detail", sortable: true, filterKind: "number" },
  { key: "absent_dates", label: "Absent dates", group: "Attendance detail", sortable: false, filterKind: "text" },
  { key: "excused_count", label: "Excused count", group: "Attendance detail", sortable: true, filterKind: "number" },
  { key: "excused_dates", label: "Excused dates", group: "Attendance detail", sortable: false, filterKind: "text" },
];
const catalog = new Map(reportColumnCatalog.map((item) => [item.key, item]));

export function defaultReportDefinition(hasBaseline: boolean): ReportDefinition {
  return { version: 1, period: hasBaseline ? { type: "baseline" } : { type: "all" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "member" }, { key: "regular_attendance" }, { key: "assigned_policies" }], columnFilters: [], sort: { column: { key: "member" }, direction: "asc" } };
}

const isDate = (value: unknown): value is string => typeof value === "string" && datePattern.test(value) && new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value;
const columnId = (column: ReportColumn) => `${column.key}${column.labelId ? `:${column.labelId}` : ""}`;
export { columnId as reportColumnId };

function parseColumn(value: unknown, knownLabels: Set<string>, allowMissingLabels: boolean, warnings: string[]): ReportColumn | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as { key?: unknown; labelId?: unknown };
  if (typeof candidate.key !== "string" || !catalog.has(candidate.key as ReportColumnKey)) return;
  const key = candidate.key as ReportColumnKey;
  if (labelKeys.has(key)) {
    if (typeof candidate.labelId !== "string" || !candidate.labelId) return;
    if (!knownLabels.has(candidate.labelId)) {
      if (!allowMissingLabels) return;
      warnings.push("A policy column references a label that is no longer available.");
    }
    return { key, labelId: candidate.labelId };
  }
  return { key };
}

export function validateReportDefinition(value: unknown, labels: PolicyLabel[], { allowMissingLabels = false }: { allowMissingLabels?: boolean } = {}): { definition?: ReportDefinition; warnings: string[]; errors: string[] } {
  const warnings: string[] = [], errors: string[] = [];
  if (!value || typeof value !== "object") return { warnings, errors: ["Report definition is required."] };
  const input = value as Partial<ReportDefinition>; const knownLabels = new Set(labels.map((label) => label.id));
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
  const columns = Array.isArray(input.columns) ? input.columns.map((item) => parseColumn(item, knownLabels, allowMissingLabels, warnings)).filter((item): item is ReportColumn => Boolean(item)) : [];
  if (!Array.isArray(input.columns) || columns.length !== input.columns.length || columns.length < 1 || columns.length > 32 || columns[0]?.key !== "member" || columns.slice(1).some((column) => column.key === "member") || new Set(columns.map(columnId)).size !== columns.length) errors.push("Report columns are invalid and must begin with Member.");
  const sortColumn = parseColumn(input.sort?.column, knownLabels, allowMissingLabels, warnings); const direction = input.sort?.direction;
  if (!sortColumn || !["asc", "desc"].includes(String(direction)) || !columns.some((column) => columnId(column) === columnId(sortColumn)) || !catalog.get(sortColumn.key)?.sortable) errors.push("Choose a visible sortable report column.");
  const rawColumnFilters = input.columnFilters ?? [];
  const columnFilters = Array.isArray(rawColumnFilters) ? rawColumnFilters.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const candidate = value as Partial<ReportColumnFilter>;
    const column = parseColumn(candidate.column, knownLabels, allowMissingLabels, warnings);
    const item = column ? catalog.get(column.key) : undefined;
    const operator = candidate.operator;
    const filterValue = typeof candidate.value === "string" ? candidate.value.trim() : "";
    if (!column || !item || !columns.some((visible) => columnId(visible) === columnId(column)) || !filterValue || filterValue.length > 100 || operator !== (item.filterKind === "number" ? "minimum" : "contains") || item.filterKind === "number" && !Number.isFinite(Number(filterValue))) return [];
    return [{ column, operator, value: filterValue } as ReportColumnFilter];
  }) : [];
  if (!Array.isArray(rawColumnFilters) || rawColumnFilters.length > 16 || columnFilters.length !== rawColumnFilters.length || new Set(columnFilters.map((filter) => columnId(filter.column))).size !== columnFilters.length) errors.push("Report column filters are invalid.");
  if (errors.length || !period || !roster || !meetingType || !labelMatch || !membership || !sortColumn) return { warnings: [...new Set(warnings)], errors };
  return { definition: { version: 1, period, roster, meetingType, labelIds, labelMatch, membership, columns, columnFilters, sort: { column: sortColumn, direction: direction as "asc" | "desc" } }, warnings: [...new Set(warnings)], errors };
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
  const base = catalog.get(column.key)?.label ?? column.key; return column.labelId ? `${labels.get(column.labelId) ?? "Unavailable label"} - ${base}` : base;
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
      switch (column.key) {
        case "member": cell = { text: memberName, sortValue: `${item.member.lastName}\u0000${item.member.firstName}\u0000${item.member.memberId}` }; break;
        case "member_id": cell = { text: item.member.memberId, sortValue: item.member.memberId }; break;
        case "email": cell = { text: item.member.email ?? "", sortValue: item.member.email?.toLowerCase() ?? null }; break;
        case "discord_id": cell = { text: item.member.discordUserId ?? "", sortValue: item.member.discordUserId ?? null }; break;
        case "active_status": cell = { text: item.member.active ? "Active" : "Inactive", sortValue: item.member.active ? 1 : 0 }; break;
        case "current_labels": { const names = full.currentLabelIds.map((labelId) => labelNames.get(labelId) ?? "Unavailable label").sort(); cell = { text: names.join("; ") || "None", sortValue: null }; break; }
        case "attendance_required_from": cell = { text: item.member.attendanceRequiredFrom ?? "", sortValue: item.member.attendanceRequiredFrom ?? null }; break;
        case "regular_attendance": cell = { text: percentage(item.regularAttendance.rate), sortValue: item.regularAttendance.rate }; break;
        case "regular_weighted_present": cell = { text: String(item.regularAttendance.attended), sortValue: item.regularAttendance.attended }; break;
        case "regular_weighted_eligible": cell = { text: String(item.regularAttendance.required), sortValue: item.regularAttendance.required }; break;
        case "regular_period": cell = { text: `${item.regularAttendance.from ?? "First eligible meeting"} to ${item.regularAttendance.to}`, sortValue: null }; break;
        case "assigned_policies": cell = { text: full.currentCompliances.length ? full.currentCompliances.map(policyResult).join("; ") : "No assigned policy", sortValue: null }; break;
        case "official_policy_result": cell = { text: policyResult(officialPolicy), sortValue: officialPolicy?.ruleType === "weekly_count" ? officialPolicy.attended : officialPolicy?.rate ?? null }; break;
        case "official_policy_status": cell = { text: officialPolicy ? statusText(officialPolicy.status) : "N/A", sortValue: officialPolicy?.status ?? null }; break;
        case "official_policy_target": cell = { text: officialPolicy?.threshold == null ? "N/A" : String(officialPolicy.threshold), sortValue: officialPolicy?.threshold ?? null }; break;
        case "official_policy_type": cell = { text: officialPolicy?.ruleType === "weekly_count" ? "Weekly count" : officialPolicy?.ruleType === "weighted_percentage" ? "Weighted percentage" : "N/A", sortValue: officialPolicy?.ruleType ?? null }; break;
        case "official_policy_excused": cell = { text: officialPolicy?.excusedHandling === "count_missed" ? "Count as missed" : officialPolicy?.excusedHandling === "exclude" ? "Exclude" : "N/A", sortValue: officialPolicy?.excusedHandling ?? null }; break;
        case "official_policy_period": cell = { text: officialPolicy && officialPolicy.status !== "no_rule" ? `${officialPolicy.from} to ${officialPolicy.to}` : "N/A", sortValue: null }; break;
        case "report_policy_summary": cell = { text: item.historySummaries.length ? item.historySummaries.map(historyResult).join("; ") : "No policy results", sortValue: null }; break;
        case "report_policy_result": cell = { text: periodPolicies.length ? periodPolicies.map(historyResult).join("; ") : "N/A", sortValue: periodPolicies.length === 1 ? periodPolicies[0].rate : null }; break;
        case "report_policy_status": cell = { text: periodPolicies.length === 1 ? statusText(periodPolicies[0].status) : periodPolicies.length ? "Multiple periods" : "N/A", sortValue: periodPolicies.length === 1 ? periodPolicies[0].status : null }; break;
        case "report_policy_target": { const target = ruleTarget(periodRule); cell = { text: target === null ? "N/A" : String(target), sortValue: target }; break; }
        case "report_policy_period": cell = { text: periodPolicies.length ? periodPolicies.map((summary) => historyPeriod(summary, input.from, input.to)).join("; ") : "N/A", sortValue: null }; break;
        case "policy_history": cell = { text: full.historySummaries.length ? full.historySummaries.map(historyResult).join("; ") : "No policy history", sortValue: null }; break;
        case "present_count": cell = { text: String(dates.present.length), sortValue: dates.present.length }; break;
        case "present_dates": cell = { text: dates.present.join("; ") || "None", sortValue: null, dates: dates.present }; break;
        case "absent_count": cell = { text: String(dates.absent.length), sortValue: dates.absent.length }; break;
        case "absent_dates": cell = { text: dates.absent.join("; ") || "None", sortValue: null, dates: dates.absent }; break;
        case "excused_count": cell = { text: String(dates.excused.length), sortValue: dates.excused.length }; break;
        case "excused_dates": cell = { text: dates.excused.join("; ") || "None", sortValue: null, dates: dates.excused }; break;
      }
      cells[id] = cell;
    }
    return { member: { id: item.member.id, memberId: item.member.memberId, name: memberName }, cells };
  });
  const filteredRows = rows.filter((row) => (input.definition.columnFilters ?? []).every((filter) => {
    const cell = row.cells[columnId(filter.column)];
    if (!cell) return false;
    if (filter.operator === "minimum") return typeof cell.sortValue === "number" && cell.sortValue >= Number(filter.value);
    return cell.text.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
  }));
  const sortId = columnId(input.definition.sort.column), direction = input.definition.sort.direction === "asc" ? 1 : -1;
  return filteredRows.sort((left, right) => { const a = left.cells[sortId]?.sortValue ?? null, b = right.cells[sortId]?.sortValue ?? null; if (a === null && b !== null) return 1; if (a !== null && b === null) return -1; if (a === null && b === null) return left.member.name.localeCompare(right.member.name); const compared = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)); return compared * direction || left.member.name.localeCompare(right.member.name); });
}

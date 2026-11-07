import { type ReportFilterOperator } from "../../../packages/shared/src/module-platform.ts";
import type { LabelPolicySummary } from "../../../packages/shared/src/attendance-label-sets.ts";
export type ReportScope = "personal" | "shared";
export type ReportPeriod = { type: "all" | "current_month" | "last_month" | "current_year" } | { type: "baseline"; module?: string } | { type: "last_days"; days: 7 | 30 | 60 | 90 } | { type: "fixed"; from: string; to: string };
export type ReportDurationUnit = "minutes" | "hours" | "hours_minutes";
export type ReportColumn = { key: string; labelId?: string; unit?: ReportDurationUnit };
export type ReportColumnFilter = { column: ReportColumn; operator: ReportFilterOperator; value: string; upperValue?: string };
export type ReportDefinition = { version: 2; dataset: string; groupBy: string[]; period: ReportPeriod; roster: "active" | "all"; meetingType: "all" | "required" | "optional"; labelIds: string[]; labelMatch: "any" | "all"; membership: "current" | "historical"; columns: ReportColumn[]; columnFilters?: ReportColumnFilter[]; sort: { column: ReportColumn; direction: "asc" | "desc" }; [moduleFilterKey: string]: unknown };
/** A report filter an installed module contributes, with the options the signed-in User may choose. */
export type ReportModuleFilter = { id: string; kind: "option-set"; label: string; optionLabel: string; optionNoun: string; selectionKey: string; matchKey: string; options: { id: string; name: string; archived: boolean }[] };
export type ReportColumnCatalogItem = { key: string; label: string; group: string; sortable: boolean; filterKind: "text" | "number"; requiresLabel?: boolean; durationUnits?: ReportDurationUnit[]; defaultDurationUnit?: ReportDurationUnit; datasets: string[] };
export type ReportDataset = { id: string; label: string; baselineModule?: string; description: string; available: boolean; rowIdentity: string; capability: string; fields: { id: string; label: string; group: string; kind: "dimension" | "measure"; valueType: "text" | "number" | "date"; sortable: boolean; filterOperators: ReportFilterOperator[]; requiresLabel?: boolean; durationUnits?: ReportDurationUnit[]; defaultDurationUnit?: ReportDurationUnit; sourceDataset: string; available: boolean; explanation?: string }[]; filters: string[]; groupBy: string[]; defaultColumns: string[]; defaultSort: { field: string; direction: "asc" | "desc" }; relationships: { dataset: string; localField: string; foreignField: string }[] };
export type ReportCatalog = { datasets: ReportDataset[]; columns: ReportColumnCatalogItem[]; labels: { id: string; name: string; active: boolean | number }[]; reportFilters: ReportModuleFilter[]; baseline: string | null; baselines?: { moduleId: string; label: string; startsOn: string | null }[]; today?: string; timeZone: string; defaultDefinition: ReportDefinition; role: "admin" | "operator"; attendanceAvailable: boolean; /** Days in the current-standing window that fills "Last N days" labels. */ recentDays?: number; /** Each label's attendance policy today; labels without one are absent. */ labelPolicies?: LabelPolicySummary[] };
export type SavedReport = { id: string; ownerUserId: string; scope: ReportScope; name: string; definition: ReportDefinition; revision: number; createdAt: string; updatedAt: string; pinnedPosition: number | null; warnings: string[]; errors: string[] };
/** `empty`: no value (shown as a dash); `status`: a policy status, shown as a pill; `exportText`: the CSV value. */
export type ReportCell = { text: string; sortValue: string | number | null; dates?: string[]; unavailable?: boolean; explanation?: string; empty?: boolean; status?: string; exportText?: string };
export type ReportQueryResult = { state: "ready" | "paused"; pausedReasons: string[]; definition: ReportDefinition; warnings: string[]; resolvedPeriod: { from?: string; to: string; baselineModule?: string }; columns: { id: string; key: string; label: string; labelId?: string; unit?: ReportDurationUnit; available: boolean; sourceDataset: string; explanation?: string }[]; rows: { id: string; label: string; href?: string; cells: Record<string, ReportCell> }[]; pagination: { page: number; pageSize: 25 | 50 | 100 | "all"; totalRows: number; totalPages: number; rangeStart: number; rangeEnd: number } };

/** Empty selections for each module filter, in the order saved definitions keep them. */
export const emptyModuleFilterSelections = (filters: readonly Pick<ReportModuleFilter, "selectionKey" | "matchKey">[]) => Object.fromEntries(filters.flatMap((filter) => [[filter.selectionKey, [] as string[]], [filter.matchKey, "any"]]));
/** A module filter's selected option IDs and match mode in a definition. */
export function moduleFilterSelection(definition: ReportDefinition, filter: Pick<ReportModuleFilter, "selectionKey" | "matchKey">): { ids: string[]; match: "any" | "all" } {
  const ids = definition[filter.selectionKey];
  return { ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [], match: definition[filter.matchKey] === "all" ? "all" : "any" };
}
export const reportColumnId = (column: ReportColumn) => `${column.key}${column.labelId ? `:${column.labelId}` : ""}`;
export function reportColumnLabel(column: ReportColumn, base: string): string {
  if (column.unit !== "hours" && column.unit !== "hours_minutes") return base;
  const hours = base === "Minutes" ? "Hours" : base.endsWith(" minutes") ? `${base.slice(0, -8)} hours` : `${base} (hours)`;
  return column.unit === "hours" ? hours : hours.endsWith(")") ? `${hours.slice(0, -1)}, H:MM)` : `${hours} (H:MM)`;
}
export const durationUnitLabel = (unit: ReportDurationUnit) => unit === "hours" ? "Hours" : unit === "hours_minutes" ? "Hours and minutes (H:MM)" : "Minutes";
/** The unit a duration column's filter values use: H:MM columns filter on their minutes. */
export const durationFilterUnit = (unit: ReportDurationUnit | undefined): "minutes" | "hours" => unit === "hours" ? "hours" : "minutes";
export const sameReportDefinition = (left: ReportDefinition, right: ReportDefinition) => JSON.stringify(left) === JSON.stringify(right);
export const cloneReportDefinition = (definition: ReportDefinition): ReportDefinition => JSON.parse(JSON.stringify(definition)) as ReportDefinition;

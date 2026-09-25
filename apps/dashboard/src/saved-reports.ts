export type ReportScope = "personal" | "shared";
export type ReportPeriod = { type: "all" | "baseline" | "current_month" | "current_year" } | { type: "last_days"; days: 7 | 30 | 60 | 90 } | { type: "fixed"; from: string; to: string };
export type ReportColumn = { key: string; labelId?: string };
export type ReportColumnFilter = { column: ReportColumn; operator: "contains" | "minimum"; value: string };
export type ReportDefinition = { version: 1; period: ReportPeriod; roster: "active" | "all"; meetingType: "all" | "required" | "optional"; labelIds: string[]; labelMatch: "any" | "all"; membership: "current" | "historical"; columns: ReportColumn[]; columnFilters?: ReportColumnFilter[]; sort: { column: ReportColumn; direction: "asc" | "desc" } };
export type ReportColumnCatalogItem = { key: string; label: string; group: string; sortable: boolean; filterKind: "text" | "number"; requiresLabel?: boolean };
export type ReportCatalog = { columns: ReportColumnCatalogItem[]; labels: { id: string; name: string; active: boolean | number }[]; baseline: string | null; timeZone: string; defaultDefinition: ReportDefinition; role: "admin" | "operator" };
export type SavedReport = { id: string; ownerUserId: string; scope: ReportScope; name: string; definition: ReportDefinition; revision: number; createdAt: string; updatedAt: string; pinnedPosition: number | null; warnings: string[]; errors: string[] };
export type ReportCell = { text: string; sortValue: string | number | null; dates?: string[] };
export type ReportQueryResult = { definition: ReportDefinition; warnings: string[]; resolvedPeriod: { from?: string; to: string }; columns: { id: string; key: string; label: string; labelId?: string }[]; rows: { member: { id: string; memberId: string; name: string }; cells: Record<string, ReportCell> }[]; pagination: { page: number; pageSize: 25 | 50 | 100 | "all"; totalRows: number; totalPages: number; rangeStart: number; rangeEnd: number } };

export const reportColumnId = (column: ReportColumn) => `${column.key}${column.labelId ? `:${column.labelId}` : ""}`;
export const sameReportDefinition = (left: ReportDefinition, right: ReportDefinition) => JSON.stringify(left) === JSON.stringify(right);
export const cloneReportDefinition = (definition: ReportDefinition): ReportDefinition => JSON.parse(JSON.stringify(definition)) as ReportDefinition;

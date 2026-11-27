import { withRecentWindow } from "../../../../packages/shared/src/attendance-terms.ts";
import { localDate as policyLocalDate, validDate, type AttendanceRule, type PolicyWeek, type PolicyLabel, type PolicyMeeting, type PolicyMemberResult } from "../attendance-policy.ts";
import { reportColumnCsvLabel, reportHasLabelSets, combinedMemberDataset, defaultReportDefinition, displayedReportRows, reportComputationDefinition, reportBaselineFor, reportBaselineModuleIds, reportBaselineModuleLabel, reportBaselineStarted, type ReportBaselines, filterAndSortReportRows, reportColumnCatalog, reportColumnId, reportColumnLabel, reportDatasetCatalog, reportDatasetDefinition, reportFieldSourceDataset, reportFilterSourceDataset, reportModuleFilters, resolveReportPeriod, validateReportDefinition, type NormalizedReportDefinition, type ReportResultRow, type ReportScope } from "../report-builder.ts";
import { projectCoreMembers, type ReportProjectionContext } from "../module-reporting.ts";
import { type D1Database } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { requireModuleWorkspace } from "../module-platform.ts";
import { coalescingDatabase } from "../d1-coalesce.ts";
import { type ModuleReportFilterOption } from "../module-contributions.ts";
import { type Env, type Principal, isObject, parseJson, requireDatabase, requireRole, response, writeAudit } from "./core.ts";
import { activeModuleFilterSources, apiModules, attendanceReportProjection, moduleReportDatabase, moduleReportDispatcher, projectModuleReport } from "./module-runtime.ts";
import { csvCell, labelPolicySummaries, policyReport, reportFilters } from "./policy-data.ts";

/**
 * `detail=summary` leaves each member's per-meeting rows out of the answer. The rows are most of a report (about 30 KB a
 * member for a 60-meeting season), and the Roster rates and the Leaderboard never show them.
 */
function reportDetail(url: URL): "full" | "summary" {
  const detail = url.searchParams.get("detail") ?? "full";
  if (detail !== "full" && detail !== "summary") throw new HttpError(400, "Invalid report detail");
  return detail;
}
const withoutRows = <T extends { rows: unknown }>(members: T[]): Omit<T, "rows">[] => members.map(({ rows: _rows, ...summary }) => summary);
export async function attendanceReport(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const url = new URL(request.url); const detail = reportDetail(url);
  const report = await policyReport(requireDatabase(env), reportFilters(url));
  return response(detail === "summary" ? { ...report, members: withoutRows(report.members) } : report);
}
type SavedReportRow = { id: string; ownerUserId: string; scope: ReportScope; name: string; definitionJson: string; revision: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string; pinnedPosition?: number | null };
type ReportQueryInput = { definition?: unknown; page?: unknown; pageSize?: unknown };
type ReportRun = { state: "ready" | "paused"; pausedReasons: string[]; definition: NormalizedReportDefinition; warnings: string[]; resolvedPeriod: { from?: string; to: string; baselineModule?: string }; columns: { id: string; key: string; label: string; labelId?: string; available: boolean; sourceDataset: string; explanation?: string }[]; rows: ReportResultRow[]; periodMembers: PolicyMemberResult[]; officialMembers: PolicyMemberResult[]; meetings: PolicyMeeting[]; labels: PolicyLabel[]; rules: AttendanceRule[]; timeZone: string };
function reportName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, "Report name is required and must be at most 80 characters");
  return value.trim();
}
function reportScope(value: unknown): ReportScope {
  if (value !== "personal" && value !== "shared") throw new HttpError(400, "Report scope must be personal (private) or shared");
  return value;
}
export function parseStoredReportDefinition(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
async function ensureUniqueReportName(db: D1Database, scope: ReportScope, name: string, ownerUserId: string, exceptId?: string): Promise<void> {
  const existing = scope === "shared"
    ? await db.prepare("SELECT id FROM saved_report_views WHERE installation_id = 'primary' AND scope = 'shared' AND name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?)").bind(name, exceptId ?? null, exceptId ?? null).first<{ id: string }>()
    : await db.prepare("SELECT id FROM saved_report_views WHERE installation_id = 'primary' AND scope = 'personal' AND owner_user_id = ? AND name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?)").bind(ownerUserId, name, exceptId ?? null, exceptId ?? null).first<{ id: string }>();
  if (existing) throw new HttpError(409, scope === "shared" ? "A shared report already uses that name" : "You already have a private report with that name");
}
async function accessibleReport(db: D1Database, principal: Principal, id: string): Promise<SavedReportRow> {
  const item = await db.prepare("SELECT id, owner_user_id AS ownerUserId, scope, name, definition_json AS definitionJson, revision, created_by AS createdBy, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM saved_report_views WHERE installation_id = 'primary' AND id = ? AND (scope = 'shared' OR owner_user_id = ?)").bind(id, principal.userId).first<SavedReportRow>();
  if (!item) throw new HttpError(404, "Report not found");
  return item;
}
/**
 * Options of every installed module report filter, read through the owning module's handler. A module whose tables are
 * unavailable contributes no options, so its saved selections read as no longer available instead of failing the request.
 */
async function moduleReportFilterOptions(db: D1Database): Promise<Record<string, readonly ModuleReportFilterOption[]>> {
  const entries = await Promise.all(reportModuleFilters.map(async (filter) => {
    const owner = bundledModuleRegistry.reportFilterOwner(filter.id); const handler = owner ? apiModules.get(owner.id)?.reportFilters?.[filter.id] : undefined;
    try { return handler ? [[filter.id, await handler.options(db)] as const] : []; } catch { return []; }
  }));
  return Object.fromEntries(entries.flat());
}
/** Every module's reporting start date, Attendance's from organization_settings and the others' from module_report_baselines. */
function reportBaselines(attendance: string | null, moduleBaselines: unknown): ReportBaselines {
  let stored: Record<string, unknown> = {};
  try { const parsed = typeof moduleBaselines === "string" ? JSON.parse(moduleBaselines) as unknown : undefined; if (isObject(parsed)) stored = parsed; } catch { /* No module rows. */ }
  return Object.fromEntries(reportBaselineModuleIds.map((id) => [id, id === "attendance" ? attendance : typeof stored[id] === "string" ? stored[id] as string : null]));
}
async function reportMetadata(db: D1Database): Promise<{ labels: PolicyLabel[]; moduleFilterOptions: Record<string, readonly ModuleReportFilterOption[]>; baseline: string | null; baselines: ReportBaselines; timeZone: string; recentDays: number }> {
  const [labels, moduleFilterOptions, settings] = await Promise.all([
    db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' ORDER BY name COLLATE NOCASE").all<PolicyLabel>(),
    moduleReportFilterOptions(db),
    // One query for every baseline and the current-standing window keeps report runs within the Free plan's per-request query budget.
    db.prepare("SELECT attendance_reporting_starts_on AS baseline, time_zone AS timeZone, (SELECT json_group_object(module_id, starts_on) FROM module_report_baselines WHERE installation_id = 'primary') AS moduleBaselines, attendance_recent_days AS recentDays FROM organization_settings WHERE installation_id = 'primary'").first<{ baseline: string | null; timeZone: string; moduleBaselines?: string | null; recentDays?: number | null }>(),
  ]);
  const baseline = settings?.baseline ?? null;
  return { labels: labels.results ?? [], moduleFilterOptions, baseline, baselines: reportBaselines(baseline, settings?.moduleBaselines), timeZone: settings?.timeZone ?? "UTC", recentDays: Number(settings?.recentDays) || 30 };
}
/** The report datasets a user can open, and each accessible module's generation for moduleReportDatabase to reuse. */
export type ReportAccess = Set<string> & { readonly generations?: ReadonlyMap<string, number> };
async function accessibleReportDatasets(db: D1Database, principal: Principal): Promise<ReportAccess> {
  const accessible = new Set(["core.members", combinedMemberDataset.id]); const generations = new Map<string, number>();
  // Every module's check starts at once, so a coalescing database sends them as one batch.
  const checks = await Promise.all(bundledModuleRegistry.modules.map(async (module) => {
    try { return { module, generation: await requireModuleWorkspace(db, principal.userId, module.id) }; }
    catch (error) { if (!(error instanceof HttpError) || ![403, 409, 503].includes(error.status)) throw error; return { module, generation: undefined }; }
  }));
  for (const { module, generation } of checks) if (generation !== undefined) { generations.set(module.id, generation); for (const dataset of module.reportDatasets ?? []) accessible.add(dataset.id); }
  return Object.assign(accessible, { generations });
}
function reportSourceExplanation(datasetId: string): string {
  const owner = bundledModuleRegistry.reportDatasetOwner(datasetId);
  return `${owner?.label ?? reportDatasetDefinition(datasetId)?.label ?? "This report source"} is unavailable for your current module access. It will return when access is restored.`;
}
/**
 * A module's reporting start date (operational baseline), for the SDK's ReportingStartDateField on its settings page. Admins
 * only. Attendance keeps its date in Meeting configuration. GET is one query; PUT is one batch whose revision check refuses
 * a stale edit, so each request stays well inside the Free plan's limits.
 */
export async function moduleReportBaseline(request: Request, env: Env, moduleId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (moduleId === "attendance" || !reportBaselineModuleIds.includes(moduleId)) throw new HttpError(404, "This module has no reporting start date");
  const read = async () => {
    const row = await db.prepare("SELECT s.time_zone AS timeZone, b.starts_on AS startsOn, COALESCE(b.revision, 0) AS revision FROM organization_settings s LEFT JOIN module_report_baselines b ON b.installation_id = s.installation_id AND b.module_id = ? WHERE s.installation_id = 'primary'").bind(moduleId).first<{ timeZone: string | null; startsOn: string | null; revision: number }>();
    if (!row) throw new HttpError(409, "Save organization setup before choosing a reporting start date");
    const timeZone = row.timeZone ?? "UTC";
    return { moduleId, label: reportBaselineModuleLabel(moduleId), startsOn: row.startsOn ?? null, revision: Number(row.revision), timeZone, today: policyLocalDate(new Date().toISOString(), timeZone) };
  };
  if (request.method === "GET") return response(await read());
  if (request.method !== "PUT") throw new HttpError(405, "Use GET or PUT for a reporting start date");
  const input = await parseJson<{ startsOn?: unknown; revision?: unknown }>(request, 1024);
  const startsOn = input.startsOn === null || input.startsOn === "" ? null : input.startsOn;
  if (startsOn !== null && (typeof startsOn !== "string" || !validDate(startsOn))) throw new HttpError(400, "Reporting start date must be YYYY-MM-DD");
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new HttpError(400, "Provide the reporting start date's revision");
  const now = new Date().toISOString();
  const [, audit] = await db.batch([
    db.prepare(`INSERT INTO module_report_baselines (installation_id, module_id, starts_on, revision, updated_at) VALUES ('primary', ?, ?, 1, ?)
      ON CONFLICT(installation_id, module_id) DO UPDATE SET starts_on = excluded.starts_on, revision = module_report_baselines.revision + 1, updated_at = excluded.updated_at
      WHERE module_report_baselines.revision = ?`).bind(moduleId, startsOn, now, Number(input.revision)),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'reports.baseline_updated', 'platform_module', ?, ?, ? WHERE changes() = 1")
      .bind(crypto.randomUUID(), principal.userId, moduleId, JSON.stringify({ startsOn }), now),
  ]);
  if (audit?.meta?.changes !== 1) throw new HttpError(409, "The reporting start date changed; reload before saving again");
  return response(await read());
}
export async function reportCatalog(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = coalescingDatabase(requireDatabase(env)); const [data, accessible] = await Promise.all([reportMetadata(db), accessibleReportDatasets(db, principal)]);
  const today = policyLocalDate(new Date().toISOString(), data.timeZone);
  const baselineModule = (datasetId: string) => datasetId === combinedMemberDataset.id ? undefined : reportBaselineFor({ dataset: datasetId, columns: [], period: { type: "all" } }, data.baselines, today).moduleId;
  const datasets = reportDatasetCatalog.map((dataset) => ({ ...dataset, baselineModule: baselineModule(dataset.id), available: accessible.has(dataset.id), fields: dataset.fields.map((field) => { const sourceDataset = reportFieldSourceDataset(dataset.id, field.id) ?? dataset.id; const available = accessible.has(sourceDataset); return { ...field, label: withRecentWindow(field.label, data.recentDays), sourceDataset, available, explanation: available ? undefined : reportSourceExplanation(sourceDataset) }; }) })); // Attendance members first, then the first accessible member-level module dataset, then Core members.
  const defaultDataset = accessible.has("attendance.members") ? "attendance.members" : reportDatasetCatalog.find((dataset) => dataset.rowIdentity === "core.member.identity" && bundledModuleRegistry.reportDatasetOwner(dataset.id) && accessible.has(dataset.id))?.id ?? "core.members";
  // Module filter options are listed only for Users who can open one of the owning module's datasets.
  const reportFilters = reportModuleFilters.map((filter) => { const owner = bundledModuleRegistry.reportFilterOwner(filter.id); const visible = Boolean(owner?.reportDatasets?.some((dataset) => accessible.has(dataset.id))); return { ...filter, options: visible ? data.moduleFilterOptions[filter.id] ?? [] : [] }; });
  // baseline stays Attendance's for older dashboards; baselines lists each module's reporting start date.
  const baselines = reportBaselineModuleIds.map((moduleId) => ({ moduleId, label: reportBaselineModuleLabel(moduleId), startsOn: data.baselines[moduleId] ?? null }));
  const defaultBaseline = reportBaselineFor({ dataset: defaultDataset, columns: [], period: { type: "all" } }, data.baselines, today).baseline;
  // Each label's policy today, for label column sets, the Attendance by label preset and the Leaderboard's label ranking.
  const labelPolicies = accessible.has("attendance.members") ? await labelPolicySummaries(db, today) : [];
  return response({ datasets, labelPolicies, columns: reportColumnCatalog.map((column) => ({ ...column, label: withRecentWindow(column.label, data.recentDays) })), recentDays: data.recentDays, labels: data.labels, reportFilters, baseline: data.baseline, baselines, today, timeZone: data.timeZone, defaultDefinition: defaultReportDefinition(reportBaselineStarted(defaultBaseline, today), defaultDataset), role: principal.role, attendanceAvailable: accessible.has("attendance.members") });
}
function savedReportResponse(item: SavedReportRow, labels: PolicyLabel[], moduleFilterOptions: Readonly<Record<string, readonly { id: string }[]>>) {
  const validation = validateReportDefinition(parseStoredReportDefinition(item.definitionJson), labels, { allowMissingLabels: true, moduleFilterOptions });
  return { id: item.id, ownerUserId: item.ownerUserId, scope: item.scope, name: item.name, definition: validation.definition ?? parseStoredReportDefinition(item.definitionJson), revision: Number(item.revision), createdBy: item.createdBy, updatedBy: item.updatedBy, createdAt: item.createdAt, updatedAt: item.updatedAt, pinnedPosition: item.pinnedPosition ?? null, warnings: validation.warnings, errors: validation.errors };
}
export async function savedReports(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const data = await reportMetadata(db);
  if (request.method === "GET") {
    const result = await db.prepare("SELECT v.id, v.owner_user_id AS ownerUserId, v.scope, v.name, v.definition_json AS definitionJson, v.revision, v.created_by AS createdBy, v.updated_by AS updatedBy, v.created_at AS createdAt, v.updated_at AS updatedAt, t.position AS pinnedPosition FROM saved_report_views v LEFT JOIN saved_report_tabs t ON t.installation_id = v.installation_id AND t.report_view_id = v.id AND t.user_id = ? WHERE v.installation_id = 'primary' AND (v.scope = 'shared' OR v.owner_user_id = ?) ORDER BY CASE WHEN t.position IS NULL THEN 1 ELSE 0 END, t.position, v.name COLLATE NOCASE, v.id").bind(principal.userId, principal.userId).all<SavedReportRow>();
    return response({ reports: (result.results ?? []).map((item) => savedReportResponse(item, data.labels, data.moduleFilterOptions)) });
  }
  const input = await parseJson<{ name?: unknown; scope?: unknown; definition?: unknown }>(request); const name = reportName(input.name); const scope = reportScope(input.scope);
  const validation = validateReportDefinition(input.definition, data.labels, { moduleFilterOptions: data.moduleFilterOptions }); if (!validation.definition || validation.errors.length) throw new HttpError(400, "Invalid report definition", validation.errors);
  await ensureUniqueReportName(db, scope, name, principal.userId);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const position = await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM saved_report_tabs WHERE installation_id = 'primary' AND user_id = ?").bind(principal.userId).first<{ position: number }>();
  await db.batch([
    db.prepare("INSERT INTO saved_report_views (id, installation_id, owner_user_id, scope, name, definition_json, revision, created_by, updated_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, ?, 1, ?, ?, ?, ?)").bind(id, principal.userId, scope, name, JSON.stringify(validation.definition), principal.userId, principal.userId, now, now),
    db.prepare("INSERT INTO saved_report_tabs (installation_id, user_id, report_view_id, position, pinned_at) VALUES ('primary', ?, ?, ?, ?)").bind(principal.userId, id, Number(position?.position ?? 0), now),
  ]);
  await writeAudit(db, principal, "report.created", "saved_report", id, { name, scope });
  const created = await accessibleReport(db, principal, id); return response({ report: savedReportResponse({ ...created, pinnedPosition: Number(position?.position ?? 0) }, data.labels, data.moduleFilterOptions) }, 201);
}
export async function manageSavedReport(request: Request, env: Env, id: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const current = await accessibleReport(db, principal, id);
  if (request.method === "DELETE") {
    const revisionText = new URL(request.url).searchParams.get("revision");
    if (revisionText && Number(revisionText) !== Number(current.revision)) throw new HttpError(409, "This report changed after you opened it. Reload before deleting it.");
    await db.prepare("DELETE FROM saved_report_views WHERE installation_id = 'primary' AND id = ?").bind(id).run();
    await writeAudit(db, principal, "report.deleted", "saved_report", id, { name: current.name, scope: current.scope, revision: current.revision }); return response({ deleted: true });
  }
  const input = await parseJson<{ name?: unknown; scope?: unknown; definition?: unknown; revision?: unknown }>(request); const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision !== Number(current.revision)) throw new HttpError(409, "This report changed after you opened it. Reload and reapply your changes.");
  const name = reportName(input.name); const scope = reportScope(input.scope);
  if (current.scope === "shared" && scope === "personal" && current.ownerUserId !== principal.userId) throw new HttpError(403, "Save a private copy instead of converting another user's shared report");
  const data = await reportMetadata(db); const validation = validateReportDefinition(input.definition, data.labels, { moduleFilterOptions: data.moduleFilterOptions });
  if (!validation.definition || validation.errors.length) throw new HttpError(400, "Invalid report definition", validation.errors);
  await ensureUniqueReportName(db, scope, name, current.ownerUserId, id); const now = new Date().toISOString();
  const result = await db.prepare("UPDATE saved_report_views SET scope = ?, name = ?, definition_json = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND revision = ?").bind(scope, name, JSON.stringify(validation.definition), principal.userId, now, id, revision).run();
  if (!result.meta?.changes) throw new HttpError(409, "This report changed after you opened it. Reload and reapply your changes.");
  await writeAudit(db, principal, "report.updated", "saved_report", id, { name, scope, revision: revision + 1 }); const updated = await accessibleReport(db, principal, id);
  return response({ report: savedReportResponse(updated, data.labels, data.moduleFilterOptions) });
}
export async function savedReportTabs(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ reportIds?: unknown }>(request);
  if (!Array.isArray(input.reportIds) || input.reportIds.length > 50 || input.reportIds.some((id) => typeof id !== "string") || new Set(input.reportIds).size !== input.reportIds.length) throw new HttpError(400, "Pinned reports must be a unique ordered list");
  const reportIds = input.reportIds as string[];
  if (reportIds.length) {
    const accessible = await db.prepare(`SELECT id FROM saved_report_views WHERE installation_id = 'primary' AND id IN (${reportIds.map(() => "?").join(",")}) AND (scope = 'shared' OR owner_user_id = ?)` ).bind(...reportIds, principal.userId).all<{ id: string }>();
    if ((accessible.results ?? []).length !== reportIds.length) throw new HttpError(400, "One or more pinned reports are unavailable");
  }
  const now = new Date().toISOString(); await db.batch([
    db.prepare("DELETE FROM saved_report_tabs WHERE installation_id = 'primary' AND user_id = ?").bind(principal.userId),
    ...reportIds.map((id, position) => db.prepare("INSERT INTO saved_report_tabs (installation_id, user_id, report_view_id, position, pinned_at) VALUES ('primary', ?, ?, ?, ?)").bind(principal.userId, id, position, now)),
  ]);
  return response({ reportIds });
}
function reportPagination(pageValue: unknown, pageSizeValue: unknown, total: number): { page: number; pageSize: 25 | 50 | 100 | "all"; from: number; to: number; totalPages: number } {
  const pageSize = pageSizeValue === "all" ? "all" : Number(pageSizeValue ?? 25);
  if (pageSize !== "all" && ![25, 50, 100].includes(pageSize)) throw new HttpError(400, "Page size must be 25, 50, 100, or all");
  const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(total / pageSize)); const page = Math.max(1, Number(pageValue ?? 1));
  if (!Number.isInteger(page)) throw new HttpError(400, "Page must be a positive integer");
  const safePage = Math.min(page, totalPages); const from = pageSize === "all" ? 0 : (safePage - 1) * pageSize; const to = pageSize === "all" ? total : Math.min(total, from + pageSize);
  return { page: safePage, pageSize: pageSize as 25 | 50 | 100 | "all", from, to, totalPages };
}

function projectionDefinition(definition: NormalizedReportDefinition, datasetId: string): NormalizedReportDefinition {
  const dataset = reportDatasetDefinition(datasetId)!;
  const requested = definition.columns.filter((column) => reportFieldSourceDataset(definition.dataset, column.key) === datasetId);
  const columns = [{ key: dataset.defaultColumns[0]! }, ...requested].filter((column, index, values) => values.findIndex((candidate) => reportColumnId(candidate) === reportColumnId(column)) === index);
  if (!columns.some((column) => column.key === dataset.defaultSort.field)) columns.push({ key: dataset.defaultSort.field });
  return { ...definition, dataset: dataset.id, groupBy: [...dataset.groupBy], columns, columnFilters: [], sort: { column: { key: dataset.defaultSort.field }, direction: dataset.defaultSort.direction } };
}

async function combinedMemberRows(db: D1Database, principal: Principal, definition: NormalizedReportDefinition, context: ReportProjectionContext, accessible: ReportAccess): Promise<ReportResultRow[]> {
  const coreDefinition = projectionDefinition(definition, "core.members");
  if (definition.membership === "historical") coreDefinition.labelIds = [];
  let rows = await projectCoreMembers(db, coreDefinition, context); const indexed = new Map(rows.map((row) => [row.id, row]));
  const historicalSource = definition.membership === "historical" && definition.labelIds.length ? reportFilterSourceDataset(definition.dataset, "membership") : undefined;
  const moduleFilterSources = activeModuleFilterSources(definition);
  const sources = [...new Set([...definition.columns.map((column) => reportFieldSourceDataset(definition.dataset, column.key)), historicalSource, ...moduleFilterSources].filter((source): source is string => Boolean(source) && source !== "core.members"))];
  let historicalMemberIds: Set<string> | undefined;
  for (const source of sources) {
    if (!accessible.has(source)) continue;
    const scoped = await moduleReportDatabase(db, principal, source, accessible);
    if (!scoped) { accessible.delete(source); continue; }
    const sourceDefinition = projectionDefinition(definition, source);
    if (definition.membership === "historical" && source !== "attendance.members") sourceDefinition.labelIds = [];
    const projected = await projectModuleReport(async () => source === "attendance.members" ? (await attendanceReportProjection(scoped, sourceDefinition, context)).rows : await moduleReportDispatcher.run(source, scoped, sourceDefinition, context));
    if (!projected) { accessible.delete(source); continue; }
    if (source === "attendance.members" && definition.membership === "historical" && definition.labelIds.length) historicalMemberIds = new Set(projected.map((row) => row.id));
    for (const sourceRow of projected) {
      const target = indexed.get(sourceRow.id);
      if (target) Object.assign(target.cells, sourceRow.cells);
    }
  }
  if (historicalMemberIds) rows = rows.filter((row) => historicalMemberIds!.has(row.id));
  for (const row of rows) for (const column of definition.columns) {
    const id = reportColumnId(column); const source = reportFieldSourceDataset(definition.dataset, column.key);
    if (source && !accessible.has(source)) row.cells[id] = { text: "Unavailable", sortValue: null, unavailable: true, explanation: reportSourceExplanation(source) };
  }
  return filterAndSortReportRows(definition, rows);
}

async function runReportDefinition(database: D1Database, principal: Principal, value: unknown): Promise<ReportRun> {
  // Reads started together share one D1 batch, which the Free plan counts as one of its 50 queries per invocation.
  const db = coalescingDatabase(database);
  const [metadata, accessible] = await Promise.all([reportMetadata(db), accessibleReportDatasets(db, principal)]); const validation = validateReportDefinition(value, metadata.labels, { allowMissingLabels: true, moduleFilterOptions: metadata.moduleFilterOptions });
  if (!validation.definition || validation.definition.version !== 2 || validation.errors.length) throw new HttpError(400, "Invalid report definition", validation.errors);
  const definition = validation.definition; const today = policyLocalDate(new Date().toISOString(), metadata.timeZone); const baseline = reportBaselineFor(definition, metadata.baselines, today); const resolved = resolveReportPeriod(definition.period, today, baseline.baseline, baseline.moduleId ? reportBaselineModuleLabel(baseline.moduleId) : undefined); const warnings = [...validation.warnings];
  if (resolved.warning) warnings.push(resolved.warning);
  const context = { from: resolved.from, to: resolved.to ?? today, today };
  const controllingFields = [...definition.groupBy, definition.sort.column.key, ...(definition.columnFilters ?? []).map((filter) => filter.column.key)];
  const filterControls = [
    ...(definition.meetingType !== "all" ? [reportFilterSourceDataset(definition.dataset, "meeting-type")] : []),
    ...(definition.membership === "historical" && definition.labelIds.length ? [reportFilterSourceDataset(definition.dataset, "membership")] : []),
    ...(definition.labelIds.length ? [reportFilterSourceDataset(definition.dataset, "labels")] : []),
    ...activeModuleFilterSources(definition),
  ];
  const unavailableControls = [...new Set([...controllingFields.map((field) => reportFieldSourceDataset(definition.dataset, field)), ...filterControls].filter((source): source is string => typeof source === "string" && !accessible.has(source)))];
  const pausedReasons = !accessible.has(definition.dataset) ? [reportSourceExplanation(definition.dataset)] : unavailableControls.map((source) => `${reportSourceExplanation(source)} Results are paused because this source controls grouping, filtering, or sorting.`);
  let rows: ReportResultRow[] = []; let detail = { periodMembers: [] as PolicyMemberResult[], officialMembers: [] as PolicyMemberResult[], meetings: [] as PolicyMeeting[], labels: metadata.labels, rules: [] as AttendanceRule[], timeZone: metadata.timeZone };
  // Projections also compute the cells of filtered fields that aren't displayed; the response keeps only displayed cells.
  const computed = reportComputationDefinition(definition);
  if (!pausedReasons.length) {
    if (definition.dataset === "core.members") rows = await projectCoreMembers(db, computed, context);
    else if (definition.dataset === combinedMemberDataset.id) {
      rows = await combinedMemberRows(db, principal, computed, context, accessible);
      const revokedControls = [...new Set([...controllingFields.map((field) => reportFieldSourceDataset(definition.dataset, field)), ...filterControls].filter((source): source is string => typeof source === "string" && !accessible.has(source)))];
      if (revokedControls.length) { rows = []; for (const source of revokedControls) pausedReasons.push(`${reportSourceExplanation(source)} Results are paused because this source controls grouping, filtering, or sorting.`); }
    }
    else {
      const scoped = await moduleReportDatabase(db, principal, definition.dataset, accessible);
      const projected = scoped && await projectModuleReport(async () => definition.dataset === "attendance.members" ? await attendanceReportProjection(scoped, computed, context) : { rows: await moduleReportDispatcher.run(definition.dataset, scoped, computed, context) });
      if (!projected) pausedReasons.push(reportSourceExplanation(definition.dataset));
      else if ("officialMembers" in projected) { const { rows: projectedRows, ...projection } = projected; rows = projectedRows; detail = projection; }
      else rows = projected.rows;
    }
    rows = displayedReportRows(definition, rows);
  }
  const labelNames = new Map(metadata.labels.map((label) => [label.id, label.name]));
  const columns = definition.columns.map((column) => { const sourceDataset = reportFieldSourceDataset(definition.dataset, column.key) ?? definition.dataset; const available = accessible.has(sourceDataset); return { id: reportColumnId(column), key: column.key, label: reportColumnLabel(column, labelNames, metadata.recentDays), labelId: column.labelId, unit: column.unit, sourceDataset, available, explanation: available ? undefined : reportSourceExplanation(sourceDataset) }; });
  const mutedSources = [...new Set(columns.filter((column) => !column.available).map((column) => column.sourceDataset))];
  if (!pausedReasons.length) for (const source of mutedSources) warnings.push(`${reportSourceExplanation(source)} Affected columns are muted without cached or zero values.`);
  return { state: pausedReasons.length ? "paused" : "ready", pausedReasons: [...new Set(pausedReasons)], definition, warnings: [...new Set(warnings)], resolvedPeriod: { from: resolved.from, to: resolved.to ?? today, ...(definition.period.type === "baseline" && baseline.moduleId ? { baselineModule: baseline.moduleId } : {}) }, columns, rows, ...detail };
}
export async function customReportQuery(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const input = await parseJson<ReportQueryInput>(request); const run = await runReportDefinition(requireDatabase(env), principal, input.definition); const pagination = reportPagination(input.page, input.pageSize, run.rows.length);
  return response({ state: run.state, pausedReasons: run.pausedReasons, definition: run.definition, warnings: run.warnings, resolvedPeriod: run.resolvedPeriod, columns: run.columns, rows: run.rows.slice(pagination.from, pagination.to), pagination: { page: pagination.page, pageSize: pagination.pageSize, totalRows: run.rows.length, totalPages: pagination.totalPages, rangeStart: run.rows.length ? pagination.from + 1 : 0, rangeEnd: pagination.to } });
}
export async function leaderboardReport(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const url = new URL(request.url); const filters = reportFilters(url); const detail = reportDetail(url); const sort = url.searchParams.get("sort") ?? "regular-desc";
  if (!["regular-desc", "label-rate", "first-name", "last-name"].includes(sort)) throw new HttpError(400, "Invalid leaderboard sort");
  // One label chosen: rank by that label's Attendance rate for the period, from the same evaluation (no extra queries).
  if (sort === "label-rate" && !filters.labelId) throw new HttpError(400, "Choose one label to rank by its attendance rate");
  const report = await policyReport(requireDatabase(env), filters, { rankLabelId: sort === "label-rate" ? filters.labelId : undefined });
  report.members.sort((left, right) => {
    const ranked = sort === "regular-desc" ? [left.regularAttendance.preciseRate, right.regularAttendance.preciseRate] : sort === "label-rate" ? [left.labelResult?.rate ?? null, right.labelResult?.rate ?? null] : undefined;
    if (ranked) { const [a, b] = ranked; if (a === null && b !== null) return 1; if (a !== null && b === null) return -1; if (a !== null && b !== null && a !== b) return b - a; }
    const first = sort === "first-name" ? left.member.firstName.localeCompare(right.member.firstName) : left.member.lastName.localeCompare(right.member.lastName);
    return first || (sort === "first-name" ? left.member.lastName.localeCompare(right.member.lastName) : left.member.firstName.localeCompare(right.member.firstName)) || left.member.memberId.localeCompare(right.member.memberId);
  });
  const policyAlerts = report.members.flatMap((item) => item.currentCompliances.flatMap((policy, index) => policy.status === "below" ? [{ key: `${item.member.id}:${policy.labelId ?? index}`, memberId: item.member.memberId, name: `${item.member.firstName} ${item.member.lastName}`, policy }] : []));
  // One pass over the rows, in member order, so each meeting's sums add up in the order they always have.
  const trendSums = new Map<string, { attended: number; eligible: number }>(report.meetings.map((meeting) => [meeting.id, { attended: 0, eligible: 0 }]));
  for (const member of report.members) for (const row of member.rows) { if (!row.regularEligible) continue; const sums = trendSums.get(row.meetingId); if (!sums) continue; sums.eligible += row.regularWeight; if (row.attended) sums.attended += row.regularWeight; }
  const trend = report.meetings.map((meeting) => { const { attended, eligible } = trendSums.get(meeting.id)!; return { meetingId: meeting.id, title: meeting.title, startsAt: meeting.startsAt, rate: eligible > 0 ? Math.round(attended / eligible * 100) : null }; }).filter((point) => point.rate !== null);
  const pagination = reportPagination(url.searchParams.get("page") ?? 1, url.searchParams.get("pageSize") ?? 25, report.members.length); const shown = report.members.slice(pagination.from, pagination.to); return response({ ...report, today: policyLocalDate(new Date().toISOString(), report.timeZone), members: detail === "summary" ? withoutRows(shown) : shown, insights: { policyAlerts, trend }, pagination: { page: pagination.page, pageSize: pagination.pageSize, totalRows: report.members.length, totalPages: pagination.totalPages, rangeStart: report.members.length ? pagination.from + 1 : 0, rangeEnd: pagination.to } });
}
export async function reportCsvExport(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<ReportQueryInput>(request); const run = await runReportDefinition(db, principal, input.definition);
  if (run.state === "paused") throw new HttpError(409, "Report export is paused until its unavailable source returns or the report is edited", run.pausedReasons);
  // Rates and counts export as plain numbers (exportText). A report with label column sets also gets Member ID after Member.
  const labelSets = reportHasLabelSets(run.definition);
  const policyTypes = new Map(labelSets ? (await labelPolicySummaries(db, policyLocalDate(new Date().toISOString(), run.timeZone))).map((policy) => [policy.labelId, policy.ruleType] as const) : []);
  const memberId = (row: ReportResultRow) => row.member?.memberId ?? (row.href?.startsWith("/roster/") ? decodeURIComponent(row.href.slice("/roster/".length)) : "");
  const exportColumns: { header: string; value: (row: ReportResultRow) => string }[] = run.columns.map((column) => ({ header: reportColumnCsvLabel({ key: column.key, labelId: column.labelId }, column.label, policyTypes), value: (row) => { const cell = row.cells[column.id]; return cell?.unavailable ? cell.text : cell?.exportText ?? cell?.text ?? ""; } }));
  if (labelSets && reportDatasetDefinition(run.definition.dataset)?.rowIdentity === "core.member.identity" && !run.columns.some((column) => column.key === "core.member.id")) exportColumns.splice(1, 0, { header: "Member ID", value: memberId });
  const csv = [exportColumns.map((column) => csvCell(column.header)).join(","), ...run.rows.map((row) => exportColumns.map((column) => csvCell(column.value(row))).join(","))].join("\r\n") + "\r\n";
  await writeAudit(db, principal, "report.exported", "saved_report", null, { format: "summary", rows: run.rows.length, columns: run.columns.map((column) => column.id) });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lancerlogin-report-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}
export async function reportDetailCsvExport(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<ReportQueryInput>(request); let run = await runReportDefinition(db, principal, input.definition);
  if (reportDatasetDefinition(run.definition.dataset)?.rowIdentity !== "core.member.identity") throw new HttpError(400, "Detailed attendance export requires a Members report");
  if (run.state === "paused") throw new HttpError(409, "Detailed attendance export is paused until its unavailable source returns or the report is edited", run.pausedReasons);
  if (run.definition.dataset !== "attendance.members") {
    const scoped = await moduleReportDatabase(db, principal, "attendance.members");
    if (!scoped) throw new HttpError(403, "Detailed attendance export requires Attendance workspace access");
    const attendanceDefinition = projectionDefinition(run.definition, "attendance.members");
    const projection = await attendanceReportProjection(scoped, attendanceDefinition, { from: run.resolvedPeriod.from, to: run.resolvedPeriod.to, today: policyLocalDate(new Date().toISOString(), run.timeZone) });
    const members = new Map(projection.periodMembers.map((member) => [member.member.id, member]));
    // Keep the complete report's member selection and order, including filters
    // on other modules, while expanding each matching member into meeting rows.
    run = { ...run, ...projection, rows: run.rows, periodMembers: run.rows.flatMap((row) => { const member = members.get(row.id); return member ? [member] : []; }) };
  }
  const meetingMap = new Map(run.meetings.map((meeting) => [meeting.id, meeting])); const official = new Map(run.officialMembers.map((item) => [item.member.id, item])); const labelNames = new Map(run.labels.map((label) => [label.id, label.name]));
  const headers = ["meeting", "meetingStart", "meetingEnd", "audience", "required", "attendanceWeight", "memberId", "firstName", "lastName", "memberLabels", "disposition", "eligibility", "regularEligible", "regularWeight", "regularWeightedPresent", "regularRate", "regularAttended", "regularRequired", "regularFrom", "regularTo", "policyEligible", "policyWeight", "policyWeightedPresent", "policyLabel", "policyRuleType", "policyExcusedHandling", "policyStatus", "policyTarget", "policyAttended", "policyRequired", "policyRate", "policyFrom", "policyTo", "policyResults", "policyHistory", "weeklyTarget", "weekStartsOn", "weekSegmentStartsOn", "weekSegmentEndsOn", "checkedInAt", "checkedOutAt", "reason"];
  const rows: Record<string, unknown>[] = run.periodMembers.flatMap((period) => { const item = official.get(period.member.id) ?? period; return period.rows.flatMap((row) => { const meeting = meetingMap.get(row.meetingId); if (!meeting) return []; const date = policyLocalDate(meeting.startsAt, run.timeZone); const week = period.weeks.find((candidate) => candidate.segmentStartsOn <= date && date <= candidate.segmentEndsOn); const policy = item.currentCompliance; return [{ meeting: meeting.title, meetingStart: meeting.startsAt, meetingEnd: meeting.endsAt, audience: row.audience, required: Boolean(meeting.required), attendanceWeight: meeting.attendanceWeight, memberId: period.member.memberId, firstName: period.member.firstName, lastName: period.member.lastName, memberLabels: row.memberLabelIds.map((labelId) => labelNames.get(labelId) ?? "Retired label").join("; "), disposition: row.disposition, eligibility: row.eligibility, regularEligible: row.regularEligible, regularWeight: row.regularWeight, regularWeightedPresent: row.regularEligible && row.attended ? row.regularWeight : 0, regularRate: period.regularAttendance.rate ?? "", regularAttended: period.regularAttendance.attended, regularRequired: period.regularAttendance.required, regularFrom: period.regularAttendance.from ?? "", regularTo: period.regularAttendance.to, policyEligible: row.rateEligible, policyWeight: row.weight, policyWeightedPresent: row.rateEligible && row.attended ? row.weight : 0, policyLabel: policy.labelName ?? "", policyRuleType: policy.ruleType ?? "", policyExcusedHandling: policy.excusedHandling ?? "", policyStatus: policy.status, policyTarget: policy.threshold ?? "", policyAttended: policy.attended, policyRequired: policy.required, policyRate: policy.rate ?? "", policyFrom: policy.status === "no_rule" ? "" : policy.from, policyTo: policy.status === "no_rule" ? "" : policy.to, policyResults: JSON.stringify(item.currentCompliances), policyHistory: JSON.stringify(item.historySummaries), weeklyTarget: week?.target ?? "", weekStartsOn: week?.weekStartsOn ?? "", weekSegmentStartsOn: week?.segmentStartsOn ?? "", weekSegmentEndsOn: week?.segmentEndsOn ?? "", checkedInAt: row.checkedInAt, checkedOutAt: row.checkedOutAt, reason: row.reason }]; }); });
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n") + "\r\n"; await writeAudit(db, principal, "report.exported", "saved_report", null, { format: "detail", rows: rows.length });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lancerlogin-report-detail-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}
export async function attendanceExport(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const report = await policyReport(db, reportFilters(new URL(request.url))); const meetings = new Map(report.meetings.map((meeting) => [meeting.id, meeting]));
  const headers = ["meeting", "meetingStart", "meetingEnd", "audience", "required", "attendanceWeight", "memberId", "firstName", "lastName", "memberLabels", "disposition", "eligibility", "regularEligible", "regularWeight", "regularWeightedPresent", "regularRate", "regularAttended", "regularRequired", "regularFrom", "regularTo", "policyEligible", "policyWeight", "policyWeightedPresent", "policyLabel", "policyRuleType", "policyExcusedHandling", "policyStatus", "policyTarget", "policyAttended", "policyRequired", "policyRate", "policyFrom", "policyTo", "policyResults", "policyHistory", "weeklyTarget", "weekStartsOn", "weekSegmentStartsOn", "weekSegmentEndsOn", "checkedInAt", "checkedOutAt", "reason"];
  const labels = new Map(report.labels.map((label) => [label.id, label.name]));
  // A row's cells are joined from parts that are the same for a whole meeting, member or week, each written out once.
  // The member's policy results and history alone are most of every row; writing them per row was most of an export's CPU.
  const cells = (values: unknown[]) => values.map(csvCell).join(",");
  const meetingParts = new Map<string, { names: string; terms: string; date: string }>();
  const lines: string[] = [headers.join(",")];
  for (const item of report.members) {
    const policy = item.currentCompliance;
    const identity = cells([item.member.memberId, item.member.firstName, item.member.lastName]);
    const regular = cells([item.regularAttendance.rate ?? "", item.regularAttendance.attended, item.regularAttendance.required, item.regularAttendance.from ?? "", item.regularAttendance.to]);
    const standing = cells([policy.labelName ?? "", policy.ruleType ?? "", policy.excusedHandling ?? "", policy.status, policy.threshold ?? "", policy.attended, policy.required, policy.rate ?? "", policy.status === "no_rule" ? "" : policy.from, policy.status === "no_rule" ? "" : policy.to, JSON.stringify(item.currentCompliances), JSON.stringify(item.historySummaries)]);
    const weekParts = new Map<PolicyWeek | undefined, string>();
    for (const row of item.rows) {
      const meeting = meetings.get(row.meetingId); if (!meeting) continue;
      let parts = meetingParts.get(meeting.id);
      if (!parts) { parts = { names: cells([meeting.title, meeting.startsAt, meeting.endsAt]), terms: cells([Boolean(meeting.required), meeting.attendanceWeight]), date: policyLocalDate(meeting.startsAt, report.timeZone) }; meetingParts.set(meeting.id, parts); }
      const date = parts.date; const week = item.weeks.find((week) => week.segmentStartsOn <= date && date <= week.segmentEndsOn);
      let weekly = weekParts.get(week);
      if (weekly === undefined) { weekly = cells([week?.target ?? "", week?.weekStartsOn ?? "", week?.segmentStartsOn ?? "", week?.segmentEndsOn ?? ""]); weekParts.set(week, weekly); }
      lines.push([
        parts.names, csvCell(row.audience), parts.terms, identity,
        cells([row.memberLabelIds.map((id) => labels.get(id) ?? "Retired label").join("; "), row.disposition, row.eligibility, row.regularEligible, row.regularWeight, row.regularEligible && row.attended ? row.regularWeight : 0]),
        regular,
        cells([row.rateEligible, row.weight, row.rateEligible && row.attended ? row.weight : 0]),
        standing, weekly,
        cells([row.checkedInAt, row.checkedOutAt, row.reason]),
      ].join(","));
    }
  }
  const rows = { length: lines.length - 1 };
  const csv = lines.join("\r\n") + "\r\n";
  await writeAudit(db, principal, "attendance.exported", "attendance", "csv", { filters: reportFilters(new URL(request.url)), rows: rows.length });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lancerlogin-attendance-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}

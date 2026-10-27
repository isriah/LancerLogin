import type { ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";
import type { D1Database } from "./d1-usage.ts";
import { filterAndSortReportRows, formatReportCellForColumn, reportColumnId, type NormalizedReportDefinition, type ReportCell, type ReportResultRow } from "./report-builder.ts";

export type ReportProjectionContext = { from?: string; to: string; today: string };
export type ReportProjectionHandler = (db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) => Promise<ReportResultRow[]>;
type Registry = { modules: readonly ModuleDefinition[]; reportDatasetOwner(datasetId: string): ModuleDefinition | undefined };
type Contribution = { moduleId: string; handlers: Readonly<Record<string, ReportProjectionHandler>> };

export function createModuleReportDispatcher(registry: Registry, contributions: readonly Contribution[]) {
  const byModule = new Map(contributions.map((contribution) => [contribution.moduleId, contribution]));
  if (byModule.size !== contributions.length) throw new Error("Duplicate module report projection contribution");
  for (const module of registry.modules) {
    const declared = (module.reportDatasets ?? []).map((dataset) => dataset.id).sort();
    const handled = Object.keys(byModule.get(module.id)?.handlers ?? {}).sort();
    if (declared.join("\u0000") !== handled.join("\u0000")) throw new Error(`${module.label} report projection handlers do not match declared datasets`);
  }
  for (const contribution of contributions) if (!registry.modules.some((module) => module.id === contribution.moduleId)) throw new Error("Report projection contribution has no registered module");
  return Object.freeze({
    owner(datasetId: string) { return registry.reportDatasetOwner(datasetId); },
    async run(datasetId: string, db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
      const owner = registry.reportDatasetOwner(datasetId); const handler = owner ? byModule.get(owner.id)?.handlers[datasetId] : undefined;
      if (!owner || !handler) throw new Error("Registered report dataset projection is unavailable");
      return handler(db, definition, context);
    },
  });
}

export type ReportRosterMember = { id: string; memberId: string; firstName: string; lastName: string; email: string | null; discordUserId: string | null; active: number };
type LabelChange = { memberId: string; labelId: string; labelName: string; action: "add" | "remove"; effectiveDate: string };

/** Roster members with their label membership as of `today`, for member-level report projections. Reads Core roster tables. */
export async function reportRosterData(db: D1Database, today: string) {
  const [membersResult, changesResult] = await Promise.all([
    db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active FROM members WHERE installation_id = 'primary' ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, external_id").all<ReportRosterMember>(),
    db.prepare("SELECT c.member_id AS memberId, c.label_id AS labelId, l.name AS labelName, c.action, c.effective_date AS effectiveDate FROM member_label_changes c JOIN member_labels l ON l.installation_id=c.installation_id AND l.id=c.label_id WHERE c.installation_id='primary' AND c.effective_date<=? ORDER BY c.effective_date,c.created_at,c.id").bind(today).all<LabelChange>(),
  ]);
  const labels = new Map<string, Map<string, string>>();
  for (const change of changesResult.results ?? []) {
    const current = labels.get(change.memberId) ?? new Map<string, string>();
    if (change.action === "add") current.set(change.labelId, change.labelName); else current.delete(change.labelId);
    labels.set(change.memberId, current);
  }
  return { members: membersResult.results ?? [], labels };
}

/** Cells of the shared roster fields (`coreMemberReportFields`) for one member. */
export function reportMemberValues(member: ReportRosterMember, labels: Map<string, string>): Record<string, ReportCell> {
  const name = `${member.firstName} ${member.lastName}`; const labelText = [...labels.values()].sort().join("; ") || "None";
  return {
    "core.member.identity": { text: member.id, sortValue: member.id },
    "core.member.name": { text: name, sortValue: `${member.lastName}\u0000${member.firstName}\u0000${member.memberId}` },
    "core.member.id": { text: member.memberId, sortValue: member.memberId },
    "core.member.email": { text: member.email ?? "", sortValue: member.email?.toLowerCase() ?? null },
    "core.member.discord-id": { text: member.discordUserId ?? "", sortValue: member.discordUserId ?? null },
    "core.member.status": { text: member.active ? "Active" : "Inactive", sortValue: member.active ? 1 : 0 },
    "core.member.labels": { text: labelText, sortValue: labelText.toLocaleLowerCase(), empty: !labels.size },
  };
}

/** A result row with one formatted cell per requested column; columns without a value read "N/A". */
export function reportRow(definition: NormalizedReportDefinition, id: string, label: string, values: Record<string, ReportCell>, href?: string): ReportResultRow {
  return { id, label, href, cells: Object.fromEntries(definition.columns.map((column) => [reportColumnId(column), formatReportCellForColumn(column, values[column.key] ?? { text: "N/A", sortValue: null })])) };
}

/** Whether a member passes the definition's roster status and current label filters. */
export function reportMemberIncluded(definition: NormalizedReportDefinition, member: ReportRosterMember, labels: Map<string, string>) {
  if (definition.roster === "active" && !member.active) return false;
  if (!definition.labelIds.length) return true;
  const current = new Set(labels.keys());
  return definition.labelMatch === "all" ? definition.labelIds.every((id) => current.has(id)) : definition.labelIds.some((id) => current.has(id));
}

export async function projectCoreMembers(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const data = await reportRosterData(db, context.today);
  const rows = data.members.flatMap((member) => {
    const labels = data.labels.get(member.id) ?? new Map<string, string>();
    if (!reportMemberIncluded(definition, member, labels)) return [];
    const name = `${member.firstName} ${member.lastName}`;
    return [reportRow(definition, member.id, name, reportMemberValues(member, labels), `/roster/${encodeURIComponent(member.memberId)}`)];
  });
  return filterAndSortReportRows(definition, rows);
}

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

type MemberRow = { id: string; memberId: string; firstName: string; lastName: string; email: string | null; discordUserId: string | null; active: number };
type LabelChange = { memberId: string; labelId: string; labelName: string; action: "add" | "remove"; effectiveDate: string };

async function rosterData(db: D1Database, today: string) {
  const [membersResult, changesResult] = await Promise.all([
    db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active FROM members WHERE installation_id = 'primary' ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, external_id").all<MemberRow>(),
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

function memberValues(member: MemberRow, labels: Map<string, string>): Record<string, ReportCell> {
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

function reportRow(definition: NormalizedReportDefinition, id: string, label: string, values: Record<string, ReportCell>, href?: string): ReportResultRow {
  return { id, label, href, cells: Object.fromEntries(definition.columns.map((column) => [reportColumnId(column), formatReportCellForColumn(column, values[column.key] ?? { text: "N/A", sortValue: null })])) };
}

function memberIncluded(definition: NormalizedReportDefinition, member: MemberRow, labels: Map<string, string>) {
  if (definition.roster === "active" && !member.active) return false;
  if (!definition.labelIds.length) return true;
  const current = new Set(labels.keys());
  return definition.labelMatch === "all" ? definition.labelIds.every((id) => current.has(id)) : definition.labelIds.some((id) => current.has(id));
}

export async function projectCoreMembers(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const data = await rosterData(db, context.today);
  const rows = data.members.flatMap((member) => {
    const labels = data.labels.get(member.id) ?? new Map<string, string>();
    if (!memberIncluded(definition, member, labels)) return [];
    const name = `${member.firstName} ${member.lastName}`;
    return [reportRow(definition, member.id, name, memberValues(member, labels), `/roster/${encodeURIComponent(member.memberId)}`)];
  });
  return filterAndSortReportRows(definition, rows);
}

type OutreachActivityLabel = { id: string; name: string };
type OutreachEntry = { id: string; memberId: string; activityId: string; activityTitle: string; serviceDate: string; startLocal: string; endLocal: string; durationMinutes: number; channel: string; status: string; activityMode: string; teamId: string | null; activityLabels: OutreachActivityLabel[] };

function parseOutreachLabels(value: string) { return JSON.parse(value) as OutreachActivityLabel[]; }
function outreachLabelsMatch(definition: NormalizedReportDefinition, labels: OutreachActivityLabel[]) {
  if (!definition.outreachLabelIds.length) return true;
  const current = new Set(labels.map((label) => label.id));
  return definition.outreachLabelMatch === "all" ? definition.outreachLabelIds.every((id) => current.has(id)) : definition.outreachLabelIds.some((id) => current.has(id));
}
function outreachLabelText(labels: OutreachActivityLabel[]) { return labels.map((label) => label.name).sort((a, b) => a.localeCompare(b)).join("; ") || "None"; }

async function outreachEntries(db: D1Database, context: ReportProjectionContext, includeVoided = false) {
  const result = await db.prepare(`SELECT e.id,e.member_id AS memberId,e.activity_id AS activityId,a.title AS activityTitle,e.service_date AS serviceDate,e.start_local AS startLocal,e.end_local AS endLocal,e.duration_minutes AS durationMinutes,e.channel,e.status,a.mode AS activityMode,a.team_id AS teamId,
    COALESCE((SELECT json_group_array(json_object('id',labels.id,'name',labels.name)) FROM (SELECT l.id,l.name FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id WHERE al.installation_id=a.installation_id AND al.activity_id=a.id ORDER BY l.name,l.id) labels),'[]') AS activityLabels
    FROM hours_entries e JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id
    WHERE e.installation_id='primary' AND (? IS NULL OR e.service_date>=?) AND e.service_date<=? ${includeVoided ? "" : "AND e.status='counted'"} ORDER BY e.service_date,e.id`).bind(context.from ?? null, context.from ?? null, context.to).all<Omit<OutreachEntry, "activityLabels"> & { activityLabels: string }>();
  return (result.results ?? []).map((entry) => ({ ...entry, activityLabels: parseOutreachLabels(entry.activityLabels) }));
}

async function projectOutreachMembers(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const [data, entries] = await Promise.all([rosterData(db, context.today), outreachEntries(db, context)]);
  const totals = new Map<string, { minutes: number; entries: number; activities: Set<string>; teams: Set<string>; last: string | null }>();
  for (const entry of entries.filter((item) => outreachLabelsMatch(definition, item.activityLabels))) {
    const total = totals.get(entry.memberId) ?? { minutes: 0, entries: 0, activities: new Set<string>(), teams: new Set<string>(), last: null };
    total.minutes += entry.durationMinutes; total.entries += 1; total.activities.add(entry.activityId); if (entry.activityMode === "team" && entry.teamId) total.teams.add(entry.teamId); if (!total.last || entry.serviceDate > total.last) total.last = entry.serviceDate; totals.set(entry.memberId, total);
  }
  const rows = data.members.flatMap((member) => {
    const labels = data.labels.get(member.id) ?? new Map<string, string>(); if (!memberIncluded(definition, member, labels)) return [];
    const total = totals.get(member.id) ?? { minutes: 0, entries: 0, activities: new Set<string>(), teams: new Set<string>(), last: null };
    const name = `${member.firstName} ${member.lastName}`; const values = { ...memberValues(member, labels),
      "outreach.member.minutes": { text: String(total.minutes), sortValue: total.minutes }, "outreach.member.entries": { text: String(total.entries), sortValue: total.entries },
      "outreach.member.activities": { text: String(total.activities.size), sortValue: total.activities.size }, "outreach.member.supported-teams": { text: String(total.teams.size), sortValue: total.teams.size },
      "outreach.member.last-service-date": { text: total.last ?? "N/A", sortValue: total.last },
    } satisfies Record<string, ReportCell>;
    return [reportRow(definition, member.id, name, values, `/roster/${encodeURIComponent(member.memberId)}`)];
  });
  return filterAndSortReportRows(definition, rows);
}

async function projectOutreachActivities(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  type Activity = { id: string; title: string; serviceDate: string; mode: string; teamId: string | null; team: string | null; participants: number; entries: number; minutes: number; labels: string };
  const result = await db.prepare(`SELECT a.id,a.title,a.service_date AS serviceDate,a.mode,a.team_id AS teamId,t.name AS team,
      COALESCE((SELECT json_group_array(json_object('id',labels.id,'name',labels.name)) FROM (SELECT l.id,l.name FROM hours_activity_labels al JOIN hours_labels l ON l.installation_id=al.installation_id AND l.id=al.label_id WHERE al.installation_id=a.installation_id AND al.activity_id=a.id ORDER BY l.name,l.id) labels),'[]') AS labels,
      COUNT(DISTINCT CASE WHEN e.status='counted' THEN e.member_id END) AS participants,COUNT(CASE WHEN e.status='counted' THEN 1 END) AS entries,COALESCE(SUM(CASE WHEN e.status='counted' THEN e.duration_minutes ELSE 0 END),0) AS minutes
    FROM hours_activities a LEFT JOIN hours_teams t ON t.installation_id=a.installation_id AND t.id=a.team_id LEFT JOIN hours_entries e ON e.installation_id=a.installation_id AND e.activity_id=a.id
    WHERE a.installation_id='primary' AND (? IS NULL OR a.service_date>=?) AND a.service_date<=? GROUP BY a.id,a.title,a.service_date,a.mode,a.team_id,t.name ORDER BY a.service_date,a.id`).bind(context.from ?? null, context.from ?? null, context.to).all<Activity>();
  return filterAndSortReportRows(definition, (result.results ?? []).flatMap((activity) => {
    const labels = parseOutreachLabels(activity.labels); if (!outreachLabelsMatch(definition, labels)) return [];
    return [reportRow(definition, activity.id, activity.title, {
    "outreach.activity.id": { text: activity.id, sortValue: activity.id }, "outreach.activity.title": { text: activity.title, sortValue: activity.title.toLocaleLowerCase() }, "outreach.activity.date": { text: activity.serviceDate, sortValue: activity.serviceDate },
    "outreach.activity.labels": { text: outreachLabelText(labels), sortValue: outreachLabelText(labels).toLocaleLowerCase(), empty: !labels.length }, "outreach.activity.mode": { text: activity.mode === "event" ? "Event" : activity.mode === "team" ? "Team support" : "Other service", sortValue: activity.mode },
    "outreach.activity.team-id": { text: activity.teamId ?? "", sortValue: activity.teamId }, "outreach.activity.team": { text: activity.team ?? "N/A", sortValue: activity.team?.toLocaleLowerCase() ?? null },
    "outreach.activity.participants": { text: String(Number(activity.participants)), sortValue: Number(activity.participants) }, "outreach.activity.entries": { text: String(Number(activity.entries)), sortValue: Number(activity.entries) }, "outreach.activity.minutes": { text: String(Number(activity.minutes)), sortValue: Number(activity.minutes) },
    })];
  }));
}

async function projectOutreachEntries(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const [entries, roster] = await Promise.all([outreachEntries(db, context, true), rosterData(db, context.today)]); const members = new Map(roster.members.map((member) => [member.id, `${member.firstName} ${member.lastName}`]));
  return filterAndSortReportRows(definition, entries.filter((entry) => outreachLabelsMatch(definition, entry.activityLabels)).map((entry) => reportRow(definition, entry.id, entry.activityTitle, {
    "outreach.entry.id": { text: entry.id, sortValue: entry.id }, "outreach.entry.member": { text: members.get(entry.memberId) ?? "Unavailable member", sortValue: (members.get(entry.memberId) ?? "").toLocaleLowerCase() },
    "outreach.entry.activity-id": { text: entry.activityId, sortValue: entry.activityId }, "outreach.entry.activity": { text: entry.activityTitle, sortValue: entry.activityTitle.toLocaleLowerCase() }, "outreach.entry.date": { text: entry.serviceDate, sortValue: entry.serviceDate },
    "outreach.entry.labels": { text: outreachLabelText(entry.activityLabels), sortValue: outreachLabelText(entry.activityLabels).toLocaleLowerCase(), empty: !entry.activityLabels.length },
    "outreach.entry.start": { text: entry.startLocal, sortValue: entry.startLocal }, "outreach.entry.end": { text: entry.endLocal, sortValue: entry.endLocal }, "outreach.entry.minutes": { text: String(entry.durationMinutes), sortValue: entry.durationMinutes },
    "outreach.entry.channel": { text: entry.channel, sortValue: entry.channel }, "outreach.entry.status": { text: entry.status, sortValue: entry.status },
  })));
}

async function projectOutreachTeams(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  type Team = { id: string; number: string; name: string; program: string };
  const [result, entries] = await Promise.all([
    db.prepare("SELECT id,number,name,program FROM hours_teams WHERE installation_id='primary' ORDER BY name COLLATE NOCASE,id").all<Team>(),
    outreachEntries(db, context),
  ]);
  const matching = entries.filter((entry) => entry.activityMode === "team" && entry.teamId && outreachLabelsMatch(definition, entry.activityLabels));
  return filterAndSortReportRows(definition, (result.results ?? []).map((team) => {
    const current = matching.filter((entry) => entry.teamId === team.id); const participants = new Set(current.map((entry) => entry.memberId)).size; const activities = new Set(current.map((entry) => entry.activityId)).size; const minutes = current.reduce((sum, entry) => sum + entry.durationMinutes, 0);
    return reportRow(definition, team.id, team.name, {
    "outreach.team.id": { text: team.id, sortValue: team.id }, "outreach.team.name": { text: team.name, sortValue: team.name.toLocaleLowerCase() }, "outreach.team.number": { text: team.number, sortValue: team.number }, "outreach.team.program": { text: team.program, sortValue: team.program.toLocaleLowerCase() },
    "outreach.team.participants": { text: String(participants), sortValue: participants }, "outreach.team.activities": { text: String(activities), sortValue: activities }, "outreach.team.entries": { text: String(current.length), sortValue: current.length }, "outreach.team.minutes": { text: String(minutes), sortValue: minutes },
    });
  }));
}

export const outreachReportHandlers: Readonly<Record<string, ReportProjectionHandler>> = Object.freeze({
  "outreach.members": projectOutreachMembers,
  "outreach.activities": projectOutreachActivities,
  "outreach.entries": projectOutreachEntries,
  "outreach.teams": projectOutreachTeams,
});

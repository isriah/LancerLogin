import { type D1Database } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import type { MeetingInput } from "./core.ts";

// `catalog`, when given, is every label already read (CSV import reads them once for all rows) instead of a read per call.
export async function resolveAudience(db: D1Database, input: MeetingInput, currentIds: string[] = [], catalog?: { id: string; active: number }[]): Promise<{ mode: "all" | "labels"; labelIds: string[] }> {
  const mode = input.audienceMode ?? (input.audienceLabelIds?.length ? "labels" : "all");
  if (mode !== "all" && mode !== "labels") throw new HttpError(400, "Meeting audience must be All or selected labels");
  if (mode === "all") return { mode, labelIds: [] };
  const ids = input.audienceLabelIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30 || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new HttpError(400, "Select 1 to 30 distinct audience labels");
  const result = catalog ? { results: catalog.filter((label) => ids.includes(label.id)) } : await db.prepare(`SELECT id, active FROM member_labels WHERE installation_id = 'primary' AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string; active: number }>();
  if ((result.results ?? []).length !== ids.length || (result.results ?? []).some((label) => !label.active && !currentIds.includes(label.id))) throw new HttpError(400, "Meeting audience contains an unknown or retired label");
  return { mode, labelIds: ids };
}
export async function meetingAudienceIds(db: D1Database, meetingIds?: string[]): Promise<Map<string, string[]>> {
  const result = await db.prepare("SELECT meeting_id AS meetingId, label_id AS labelId FROM meeting_audience_labels WHERE installation_id = 'primary'").all<{ meetingId: string; labelId: string }>();
  const selected = meetingIds ? new Set(meetingIds) : undefined; const map = new Map<string, string[]>();
  for (const row of result.results ?? []) if (!selected || selected.has(row.meetingId)) map.set(row.meetingId, [...(map.get(row.meetingId) ?? []), row.labelId]);
  return map;
}
export async function meetingAudienceText(db: D1Database, meetingId: string): Promise<string> {
  const meeting = await db.prepare("SELECT audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(meetingId).first<{ audienceMode: "all" | "labels" }>();
  if (meeting?.audienceMode !== "labels") return "All";
  const result = await db.prepare("SELECT l.name FROM meeting_audience_labels a JOIN member_labels l ON l.id = a.label_id AND l.installation_id = a.installation_id WHERE a.installation_id = 'primary' AND a.meeting_id = ? ORDER BY l.name COLLATE NOCASE").bind(meetingId).all<{ name: string }>();
  return (result.results ?? []).map((row) => row.name).join(", ") || "Selected labels";
}

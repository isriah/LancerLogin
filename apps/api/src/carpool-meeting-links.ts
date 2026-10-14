import { HttpError } from "./http-error.ts";
import type { D1Database } from "./d1-usage.ts";
import type { MeetingReferenceAccess } from "./attendance-meeting-reference.ts";

export function carpoolMeetingId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 128) throw new HttpError(400, "Choose an available meeting or leave the Carpool unlinked.");
  return value;
}

export async function withCarpoolMeetingLink<T>(db: D1Database, previous: string | null, next: string | null, access: MeetingReferenceAccess | undefined, operation: (db: D1Database) => Promise<T>) {
  if (next !== null && next !== previous) {
    if (!access) throw new HttpError(403, "Linking a meeting requires current Attendance and Carpool access.");
    return access.withTarget(next, operation);
  }
  return operation(db);
}

/** Carpool-owned navigation projection. Never reads attendance tables. */
export async function readCarpoolMeetingLinks(db: D1Database, access?: MeetingReferenceAccess) {
  if (!access) return { available: false, links: [] };
  return access.read(async (authorized) => ({ available: true, links: (await authorized.prepare("SELECT meeting_id AS meetingId,id,title FROM carpool_plans WHERE installation_id='primary' AND archived=0 AND meeting_id IS NOT NULL ORDER BY title,id").all<{ meetingId: string; id: string; title: string }>()).results ?? [] }));
}

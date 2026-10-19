import { HttpError } from "./http-error.ts";
import type { D1Database } from "./d1-usage.ts";

export type MeetingDeletion = { meetingIds: string[]; deletedAt: string };

export function meetingDeletion(value: unknown, anchorId: string): MeetingDeletion {
  const deletion = value as Partial<MeetingDeletion> | null;
  if (!deletion || !Array.isArray(deletion.meetingIds) || deletion.meetingIds.length < 1 || deletion.meetingIds.length > 500
    || deletion.meetingIds.some((id) => typeof id !== "string" || !id || id.length > 128)
    || new Set(deletion.meetingIds).size !== deletion.meetingIds.length || !deletion.meetingIds.includes(anchorId)
    || typeof deletion.deletedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deletion.deletedAt) || !Number.isFinite(Date.parse(deletion.deletedAt))) {
    throw new HttpError(400, "Undo requires the exact meeting deletion returned by the server");
  }
  return deletion as MeetingDeletion;
}

/** Restore existing rows together, leaving attendance, audiences and module links intact. */
export async function restoreMeetingDeletion(db: D1Database, deletion: MeetingDeletion): Promise<void> {
  const ids = JSON.stringify(deletion.meetingIds);
  const marker = "meeting-undo-conflict";
  // A D1 batch is transactional. Recheck both the deletion revision and current
  // attendance windows inside that transaction, including late-scan settings.
  const guard = db.prepare(`SELECT CASE WHEN
    (SELECT COUNT(*) FROM meetings WHERE installation_id='primary' AND deleted_at=? AND id IN (SELECT value FROM json_each(?)))=?
    AND NOT EXISTS (
      SELECT 1 FROM meetings target JOIN meetings other ON other.installation_id=target.installation_id AND other.id<>target.id
      WHERE target.installation_id='primary' AND target.id IN (SELECT value FROM json_each(?))
        AND (other.deleted_at IS NULL OR other.id IN (SELECT value FROM json_each(?)))
        AND julianday(target.starts_at)<=julianday(other.ends_at)+COALESCE((SELECT late_scan_minutes FROM organization_settings WHERE installation_id='primary'),30)/1440.0
        AND julianday(other.starts_at)<=julianday(target.ends_at)+COALESCE((SELECT late_scan_minutes FROM organization_settings WHERE installation_id='primary'),30)/1440.0
    ) THEN 1 ELSE json_extract('{}','${marker}') END AS meeting_undo_available`).bind(deletion.deletedAt, ids, deletion.meetingIds.length, ids, ids);
  try {
    await db.batch([guard, db.prepare("UPDATE meetings SET deleted_at = NULL WHERE installation_id='primary' AND deleted_at=? AND id IN (SELECT value FROM json_each(?))").bind(deletion.deletedAt, ids)]);
  } catch (error) {
    if (error instanceof Error && error.message.includes(marker)) throw new HttpError(409, "Meetings changed or their attendance windows now overlap. Nothing was restored. Refresh the meeting list before continuing.");
    throw error;
  }
}

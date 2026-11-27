import type { D1Database, D1Statement } from "./d1-usage.ts";
import { allowanceChangeGuard, isAllowanceOverlapAbort } from "./meeting-overlap-guard.ts";
import { HttpError } from "./http-error.ts";
import { attendanceClosesAt, DEFAULT_EARLY_SCAN_MINUTES, DEFAULT_LATE_SCAN_MINUTES, MAX_EARLY_SCAN_MINUTES, MAX_LATE_SCAN_MINUTES, newlyOverlappingMeetingWindows, type MeetingWindowLike } from "./attendance-lifecycle.ts";

/** The organization's attendance window allowances: minutes before a meeting starts and after it ends that scans count. */
export type AttendanceAllowances = { lateScanMinutes: number; earlyScanMinutes: number };

/** The allowances from a settings row read with `late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes`. */
export const attendanceAllowances = (row: { lateScanMinutes?: number | null; earlyScanMinutes?: number | null } | null | undefined): AttendanceAllowances => ({
  lateScanMinutes: row?.lateScanMinutes ?? DEFAULT_LATE_SCAN_MINUTES,
  earlyScanMinutes: row?.earlyScanMinutes ?? DEFAULT_EARLY_SCAN_MINUTES,
});

export const validLateScanMinutes = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_LATE_SCAN_MINUTES;
export const validEarlyScanMinutes = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_EARLY_SCAN_MINUTES;

/** "Build session (2026-09-01T18:00:00.000Z)", as meeting overlap errors name a meeting. */
export const meetingWindowLabel = (meeting: MeetingWindowLike) => `${meeting.title?.trim() || "Meeting"} (${new Date(meeting.startsAt).toISOString()})`;

const dayMs = 24 * 60 * 60_000;

/**
 * Refuses a longer early arrival or late scan allowance that would make the attendance windows of two meetings that have not
 * closed yet overlap, naming them. Shorter allowances never create an overlap and skip the read. Meetings that already
 * overlap (saved before the early arrival allowance existed) are left alone; scans resolve to the earlier of them.
 */
export async function assertAllowanceChangeKeepsMeetingsApart(db: D1Database, before: AttendanceAllowances, after: AttendanceAllowances, now = Date.now()): Promise<void> {
  if (after.lateScanMinutes <= before.lateScanMinutes && after.earlyScanMinutes <= before.earlyScanMinutes) return;
  // Stored timestamps are ISO 8601 text, possibly with an offset, so the SQL bound keeps a day of margin and the exact
  // closing time is compared below.
  const result = await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL AND ends_at >= ?")
    .bind(new Date(now - after.lateScanMinutes * 60_000 - dayMs).toISOString()).all<MeetingWindowLike>();
  const notClosed = (result.results ?? []).filter((meeting) => meeting.endsAt && Number.isFinite(Date.parse(meeting.startsAt)) && Date.parse(attendanceClosesAt(meeting.endsAt, after.lateScanMinutes)) >= now);
  const conflict = newlyOverlappingMeetingWindows(notClosed, before, after);
  if (conflict) throw new HttpError(409, `Meeting attendance windows cannot overlap. With these allowances, ${meetingWindowLabel(conflict[0])} conflicts with ${meetingWindowLabel(conflict[1])}. Move one of them or choose a shorter allowance.`);
}

/** The allowances saved now. A meeting write whose overlap guard aborted reads them again: a change to them may be why. */
export const savedAttendanceAllowances = async (db: D1Database) => attendanceAllowances(await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<Partial<AttendanceAllowances>>());

/**
 * Runs the batch that saves allowances, led by a guard that repeats assertAllowanceChangeKeepsMeetingsApart inside it:
 * a meeting saved or moved since that check, which the new allowances would make overlap another, aborts the batch and
 * nothing is saved. The check then runs again against the meetings now saved and throws the error a save sent after
 * that meeting gets. `earlyScanMinutes` null keeps the saved allowance. Returns the results of `statements`.
 */
export async function saveAllowancesKeepingMeetingsApart(db: D1Database, after: { lateScanMinutes: number; earlyScanMinutes: number | null }, statements: D1Statement[]) {
  try { return (await db.batch([allowanceChangeGuard(db, after), ...statements])).slice(1); }
  catch (error) {
    if (!isAllowanceOverlapAbort(error)) throw error;
    const saved = await savedAttendanceAllowances(db);
    await assertAllowanceChangeKeepsMeetingsApart(db, saved, { lateScanMinutes: after.lateScanMinutes, earlyScanMinutes: after.earlyScanMinutes ?? saved.earlyScanMinutes });
    throw new HttpError(409, "Meeting attendance windows cannot overlap. A meeting was saved while these allowances were being changed; reload and try again.");
  }
}

// The overlap check of a meeting write, repeated inside the write's own batch. Routes read the meetings near a proposed
// window, compare windows in JavaScript, then write in a later batch; two requests at once could both pass that read
// (audit finding 16). The guard statement leads the write batch and aborts it when a live meeting now overlaps a proposed
// window, so the second of two such writes changes nothing. The route then repeats its own check, which finds the
// meeting the first write saved and answers with the error a sequential request gets.
import type { D1Database, D1Statement } from "./d1-usage.ts";

const marker = "meeting-window-overlap";
/** Julian day number of the Unix epoch in milliseconds: SQLite's julianday() × 86 400 000 less this is Date.parse(). */
const julianEpochMs = 210_866_760_000_000;
// Stored times are ISO 8601 text, possibly with an offset (meetings saved before validateMeetingInput made them
// canonical), so the text bound keeps a day of margin around the window, as the routes' reads do, and the exact
// comparison is on julianday(), which reads offsets and Z alike. A time julianday() cannot read compares as NULL and
// never aborts the write; the route's own check still compared it with Date.parse().
const marginMs = 24 * 60 * 60_000;
const exactMs = (column: string) => `(CAST(round(julianday(${column}) * 86400000.0) AS INTEGER) - ${julianEpochMs})`;

export type ProposedMeetingWindow = { readonly startsAt: string; readonly endsAt: string };

/**
 * A statement that aborts its batch when a live meeting other than `excludedIds` has an attendance window (start less
 * `earlyScanMinutes` through end plus `lateScanMinutes`) that meets one of `proposed`. Windows meet as
 * overlappingMeetingWindows decides: each opens no later than the other closes. Returns undefined when there is nothing
 * to check. One statement and three bound values however many meetings are proposed.
 */
export function meetingOverlapGuard(db: D1Database, proposed: readonly ProposedMeetingWindow[], allowances: { readonly lateScanMinutes: number; readonly earlyScanMinutes: number }, excludedIds: readonly string[] = []): D1Statement | undefined {
  const windows = proposed.map((meeting) => [Date.parse(meeting.startsAt), Date.parse(meeting.endsAt)] as const);
  if (!windows.length || windows.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end))) return undefined;
  // Two windows meet when existing.start - early <= proposed.end + late and proposed.start - early <= existing.end + late.
  const gapMs = (allowances.lateScanMinutes + allowances.earlyScanMinutes) * 60_000;
  const upper = new Date(Math.max(...windows.map(([, end]) => end)) + gapMs + marginMs).toISOString();
  const lower = new Date(Math.min(...windows.map(([start]) => start)) - gapMs - marginMs).toISOString();
  return db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM meetings m, json_each(json_extract(?1, '$.windows')) p
      WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL AND m.starts_at <= json_extract(?1, '$.upper') AND m.ends_at >= json_extract(?1, '$.lower')
        AND m.id NOT IN (SELECT value FROM json_each(json_extract(?1, '$.excluded')))
        AND ${exactMs("m.starts_at")} <= json_extract(p.value, '$[1]') + ?2 AND json_extract(p.value, '$[0]') <= ${exactMs("m.ends_at")} + ?2)
    THEN json_extract('{}', '${marker}') ELSE 1 END AS meeting_window_guard`)
    .bind(JSON.stringify({ windows, upper, lower, excluded: excludedIds }), gapMs);
}

/** Whether a batch failed because its meetingOverlapGuard found an overlapping meeting. */
export const isMeetingOverlapAbort = (error: unknown) => error instanceof Error && error.message.includes(marker);

/**
 * Runs a write batch led by `guard`. When the guard aborts it, `recheck` repeats the route's own overlap check, which
 * throws the route's error now that the other write is visible; if it finds nothing (that write was undone in the
 * meantime), `fallback` is thrown.
 */
export async function guardedMeetingBatch<T>(run: () => Promise<T>, recheck: () => Promise<void>, fallback: () => Error): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!isMeetingOverlapAbort(error)) throw error;
    await recheck();
    throw fallback();
  }
}

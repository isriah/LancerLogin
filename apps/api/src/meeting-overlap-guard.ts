// The overlap check of a meeting write, repeated inside the write's own batch. Routes read the meetings near a proposed
// window, compare windows in JavaScript, then write in a later batch; two requests at once could both pass that read
// (audit finding 16). The guard statement leads the write batch and aborts it when a live meeting now overlaps a proposed
// window, so the second of two such writes changes nothing. The route then repeats its own check, which finds the
// meeting the first write saved and answers with the error a sequential request gets.
//
// The scan allowances are part of that check, and they can change between a route's read and its write too. So the guard
// reads them from organization_settings inside its own statement, never from the route's earlier read, and a write that
// lengthens them leads its batch with allowanceChangeGuard, which looks for the meetings the longer allowances would newly
// make overlap. D1 runs batches one after the other, so whichever of a meeting write and an allowance write commits second
// sees the first and is refused.
import type { D1Database, D1Statement } from "./d1-usage.ts";
import { DEFAULT_EARLY_SCAN_MINUTES, DEFAULT_LATE_SCAN_MINUTES, MAX_EARLY_SCAN_MINUTES, MAX_LATE_SCAN_MINUTES } from "./attendance-lifecycle.ts";

const marker = "meeting-window-overlap";
/** Julian day number of the Unix epoch in milliseconds: SQLite's julianday() × 86 400 000 less this is Date.parse(). */
const julianEpochMs = 210_866_760_000_000;
// Stored times are ISO 8601 text, possibly with an offset (meetings saved before validateMeetingInput made them
// canonical), so the text bound keeps a day of margin around the window, as the routes' reads do, and the exact
// comparison is on julianday(), which reads offsets and Z alike. A time julianday() cannot read compares as NULL and
// never aborts the write; the route's own check still compared it with Date.parse().
const marginMs = 24 * 60 * 60_000;
/** The saved late scan and early arrival allowances together, in milliseconds, as a scalar subquery read when the statement runs. */
export const savedAllowanceGapMsSql = `COALESCE((SELECT (COALESCE(late_scan_minutes, ${DEFAULT_LATE_SCAN_MINUTES}) + COALESCE(early_scan_minutes, ${DEFAULT_EARLY_SCAN_MINUTES})) * 60000 FROM organization_settings WHERE installation_id = 'primary'), ${(DEFAULT_LATE_SCAN_MINUTES + DEFAULT_EARLY_SCAN_MINUTES) * 60_000})`;
const maxGapMs = (MAX_LATE_SCAN_MINUTES + MAX_EARLY_SCAN_MINUTES) * 60_000;
const exactMs = (column: string) => `(CAST(round(julianday(${column}) * 86400000.0) AS INTEGER) - ${julianEpochMs})`;

export type ProposedMeetingWindow = { readonly startsAt: string; readonly endsAt: string };

/**
 * A statement that aborts its batch when a live meeting other than `excludedIds` has an attendance window (start less
 * the early arrival allowance through end plus the late scan allowance) that meets one of `proposed`. The allowances are
 * the ones saved when the statement runs. Windows meet as overlappingMeetingWindows decides: each opens no later than the
 * other closes. Returns undefined when there is nothing to check. One statement and one bound value however many
 * meetings are proposed.
 */
export function meetingOverlapGuard(db: D1Database, proposed: readonly ProposedMeetingWindow[], excludedIds: readonly string[] = []): D1Statement | undefined {
  const windows = proposed.map((meeting) => [Date.parse(meeting.startsAt), Date.parse(meeting.endsAt)] as const);
  if (!windows.length || windows.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end))) return undefined;
  // Two windows meet when existing.start - early <= proposed.end + late and proposed.start - early <= existing.end + late.
  // The text bound allows for the longest allowances that can be saved, whatever they are when the statement runs.
  const upper = new Date(Math.max(...windows.map(([, end]) => end)) + maxGapMs + marginMs).toISOString();
  const lower = new Date(Math.min(...windows.map(([start]) => start)) - maxGapMs - marginMs).toISOString();
  return db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM meetings m, json_each(json_extract(?1, '$.windows')) p
      WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL AND m.starts_at <= json_extract(?1, '$.upper') AND m.ends_at >= json_extract(?1, '$.lower')
        AND m.id NOT IN (SELECT value FROM json_each(json_extract(?1, '$.excluded')))
        AND ${exactMs("m.starts_at")} <= json_extract(p.value, '$[1]') + ${savedAllowanceGapMsSql} AND json_extract(p.value, '$[0]') <= ${exactMs("m.ends_at")} + ${savedAllowanceGapMsSql})
    THEN json_extract('{}', '${marker}') ELSE 1 END AS meeting_window_guard`)
    .bind(JSON.stringify({ windows, upper, lower, excluded: excludedIds }));
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

const allowanceMarker = "meeting-allowance-overlap";
const utcText = (column: string, shift: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}, '${shift}')`;

/**
 * A statement that aborts its batch when saving these allowances would make the attendance windows of two meetings that
 * have not closed yet overlap, where they do not under the allowances saved when the statement runs: the decision of
 * assertAllowanceChangeKeepsMeetingsApart, repeated inside the write. `earlyScanMinutes` null keeps the saved one, as the
 * writes that pass it do. Two windows overlap by the sum of both allowances, so nothing is read unless that sum grows.
 */
export function allowanceChangeGuard(db: D1Database, after: { readonly lateScanMinutes: number; readonly earlyScanMinutes: number | null }, now = Date.now()): D1Statement {
  const pairOverlaps = (gap: string) => `${exactMs("a.starts_at")} <= ${exactMs("b.ends_at")} + ${gap} AND ${exactMs("b.starts_at")} <= ${exactMs("a.ends_at")} + ${gap}`;
  // Text bounds keep the starts_at index and a margin for stored offsets; the exact comparisons are on julianday(), as
  // above. Each overlapping pair is found with `a` the meeting that starts first: `b` starts no earlier than a day before
  // it (the margin) and no later than two days after it ends, so only a meeting's neighbours are read for it.
  return db.prepare(`WITH saved AS (SELECT COALESCE(late_scan_minutes, ${DEFAULT_LATE_SCAN_MINUTES}) AS late, COALESCE(early_scan_minutes, ${DEFAULT_EARLY_SCAN_MINUTES}) AS early FROM organization_settings WHERE installation_id = 'primary'),
      gap AS (SELECT (?1 + COALESCE(?2, early)) * 60000 AS after, (late + early) * 60000 AS before FROM saved)
    SELECT CASE WHEN (SELECT after > before FROM gap) AND EXISTS (SELECT 1 FROM gap, meetings a JOIN meetings b ON b.installation_id = 'primary' AND b.deleted_at IS NULL AND b.ends_at IS NOT NULL AND b.id <> a.id
          AND b.starts_at >= ${utcText("a.starts_at", "-1 day")} AND b.starts_at <= ${utcText("a.ends_at", "+2 days")}
        WHERE a.installation_id = 'primary' AND a.deleted_at IS NULL AND a.ends_at >= ?3
          AND ${exactMs("a.ends_at")} + ?1 * 60000 >= ?4 AND ${exactMs("b.ends_at")} + ?1 * 60000 >= ?4
          AND ${pairOverlaps("gap.after")} AND NOT (${pairOverlaps("gap.before")}))
    THEN json_extract('{}', '${allowanceMarker}') ELSE 1 END AS meeting_allowance_guard`)
    .bind(after.lateScanMinutes, after.earlyScanMinutes, new Date(now - after.lateScanMinutes * 60_000 - marginMs).toISOString(), now);
}

/** Whether a batch failed because its allowanceChangeGuard found meetings the new allowances would make overlap. */
export const isAllowanceOverlapAbort = (error: unknown) => error instanceof Error && error.message.includes(allowanceMarker);

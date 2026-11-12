export const DEFAULT_LATE_SCAN_MINUTES = 30;
export const MAX_LATE_SCAN_MINUTES = 180;
// Scans this many minutes before a meeting starts count as arrivals for it (migration 0099).
export const DEFAULT_EARLY_SCAN_MINUTES = 15;
export const MAX_EARLY_SCAN_MINUTES = 180;
export const DEFAULT_ANOMALY_THRESHOLD_MINUTES = 10;
export const MAX_ANOMALY_THRESHOLD_MINUTES = 1_440;
export const DUPLICATE_SCAN_WINDOW_MS = 90_000;

export type AttendanceAction = "check_in" | "check_out";
export type AttendanceDisposition = "absent" | "active" | "present" | "excused";
export type AttendanceEventLike = { id?: string; action: AttendanceAction; occurredAt?: string };
export type MeetingWindowLike = { id?: string; title?: string; startsAt: string; endsAt: string };
export type AnomalyScanLike = MeetingWindowLike & { checkedInAt?: string; checkedOutAt?: string };

function validateAnomalyThresholds(lateThresholdMinutes: number, earlyThresholdMinutes: number): void {
  for (const threshold of [lateThresholdMinutes, earlyThresholdMinutes]) {
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > MAX_ANOMALY_THRESHOLD_MINUTES) throw new Error("Anomaly thresholds must be from 0 to 1440 minutes");
  }
}

export function attendanceAnomalyMinutes(row: AnomalyScanLike, lateThresholdMinutes = DEFAULT_ANOMALY_THRESHOLD_MINUTES, earlyThresholdMinutes = DEFAULT_ANOMALY_THRESHOLD_MINUTES): { lateMinutes?: number; earlyMinutes?: number } {
  validateAnomalyThresholds(lateThresholdMinutes, earlyThresholdMinutes);
  const start = Date.parse(row.startsAt); const end = Date.parse(row.endsAt);
  const checkIn = row.checkedInAt ? Date.parse(row.checkedInAt) : NaN;
  const checkOut = row.checkedOutAt ? Date.parse(row.checkedOutAt) : NaN;
  const lateMinutes = (checkIn - start) / 60_000;
  const earlyMinutes = (end - checkOut) / 60_000;
  return {
    ...(Number.isFinite(lateMinutes) && lateMinutes > lateThresholdMinutes ? { lateMinutes } : {}),
    ...(Number.isFinite(earlyMinutes) && earlyMinutes > earlyThresholdMinutes ? { earlyMinutes } : {}),
  };
}

export function meanAnomalousMinutes(rows: AnomalyScanLike[], lateThresholdMinutes = DEFAULT_ANOMALY_THRESHOLD_MINUTES, earlyThresholdMinutes = DEFAULT_ANOMALY_THRESHOLD_MINUTES): number | null {
  validateAnomalyThresholds(lateThresholdMinutes, earlyThresholdMinutes);
  const values: number[] = [];
  for (const row of rows) {
    const { lateMinutes, earlyMinutes } = attendanceAnomalyMinutes(row, lateThresholdMinutes, earlyThresholdMinutes);
    if (lateMinutes !== undefined) values.push(lateMinutes);
    if (earlyMinutes !== undefined) values.push(earlyMinutes);
  }
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export function attendanceClosesAt(endsAt: string, lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES): string {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) throw new Error("A valid meeting end time is required");
  const minutes = Number(lateScanMinutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_LATE_SCAN_MINUTES) throw new Error("Late scan window must be from 0 to 180 minutes");
  return new Date(end + minutes * 60_000).toISOString();
}

/** When a meeting starts accepting arrivals: its start less the organization's early arrival allowance. */
export function attendanceOpensAt(startsAt: string, earlyScanMinutes = DEFAULT_EARLY_SCAN_MINUTES): string {
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) throw new Error("A valid meeting start time is required");
  const minutes = Number(earlyScanMinutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_EARLY_SCAN_MINUTES) throw new Error("Early arrival allowance must be from 0 to 180 minutes");
  return new Date(start - minutes * 60_000).toISOString();
}

/** A meeting's attendance window in milliseconds: its start less the early arrival allowance to its end plus the late scan allowance. */
export function attendanceWindow(meeting: { startsAt: string; endsAt: string }, lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES, earlyScanMinutes = DEFAULT_EARLY_SCAN_MINUTES): { opens: number; closes: number } {
  return { opens: Date.parse(attendanceOpensAt(meeting.startsAt, earlyScanMinutes)), closes: Date.parse(attendanceClosesAt(meeting.endsAt, lateScanMinutes)) };
}

// A scan in the early arrival window is accepted for the meeting at the scan's own time (5:50 PM for a 6:00 PM meeting).
// It is never moved to the meeting start, so an early arrival never counts as a late one.
export function scanWindowState(meeting: { startsAt: string; endsAt: string }, occurredAt: string, lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES, earlyScanMinutes = DEFAULT_EARLY_SCAN_MINUTES): { accepted: true; closesAt: string } | { accepted: false; reason: string } {
  const scan = Date.parse(occurredAt);
  const opens = Date.parse(attendanceOpensAt(meeting.startsAt, earlyScanMinutes));
  const closesAt = attendanceClosesAt(meeting.endsAt, lateScanMinutes);
  const close = Date.parse(closesAt);
  if (!Number.isFinite(scan)) return { accepted: false, reason: "Scan time is invalid" };
  if (scan < opens) return { accepted: false, reason: "This meeting has not started" };
  if (scan > close) return { accepted: false, reason: "Attendance is closed for this meeting" };
  return { accepted: true, closesAt };
}

/**
 * The meeting a scan without a chosen meeting belongs to. `candidates` holds the latest meeting that started at or before
 * the scan and the earliest one that starts after it; either may be missing.
 *
 * Meetings saved before the early arrival allowance existed (migration 0099) may overlap by it: the earlier meeting's late
 * scan window can reach into the next meeting's early arrival window. A scan that falls in both goes to the earlier meeting,
 * the one in progress or in its late scan window, so the next meeting never takes its departures. Otherwise a scan in the
 * next meeting's early arrival window is an arrival for that meeting. With neither, the earlier meeting is returned so the
 * caller refuses the scan as it did before.
 */
export function scanMeetingFor<T extends { startsAt: string; endsAt: string }>(candidates: T[], occurredAt: string, lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES, earlyScanMinutes = DEFAULT_EARLY_SCAN_MINUTES): T | undefined {
  const scan = Date.parse(occurredAt);
  let previous: T | undefined; let next: T | undefined;
  for (const meeting of candidates) {
    const start = Date.parse(meeting.startsAt);
    if (start <= scan) { if (!previous || start > Date.parse(previous.startsAt)) previous = meeting; }
    else if (!next || start < Date.parse(next.startsAt)) next = meeting;
  }
  if (previous && scanWindowState(previous, occurredAt, lateScanMinutes, earlyScanMinutes).accepted) return previous;
  if (next && scanWindowState(next, occurredAt, lateScanMinutes, earlyScanMinutes).accepted) return next;
  return previous;
}

type TimedWindow<T> = { meeting: T; opens: number; closes: number };
function orderedWindows<T extends MeetingWindowLike>(meetings: T[], lateScanMinutes: number, earlyScanMinutes: number): TimedWindow<T>[] {
  return meetings.map((meeting) => ({ meeting, ...attendanceWindow(meeting, lateScanMinutes, earlyScanMinutes) }))
    .sort((left, right) => left.opens - right.opens || left.closes - right.closes);
}

/**
 * The first two meetings whose attendance windows (early arrival allowance through late scan allowance) overlap. With
 * `involves`, only a pair that includes at least one meeting it accepts counts, so meetings that already overlap (saved
 * before the early arrival allowance existed) do not block saving an unrelated meeting.
 */
export function overlappingMeetingWindows<T extends MeetingWindowLike>(meetings: T[], lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES, earlyScanMinutes = DEFAULT_EARLY_SCAN_MINUTES, involves?: (meeting: T) => boolean): [T, T] | undefined {
  // Sweep by opening time, keeping the latest-closing window so far and the latest-closing one `involves` accepts.
  let latest: TimedWindow<T> | undefined; let latestInvolved: TimedWindow<T> | undefined;
  for (const current of orderedWindows(meetings, lateScanMinutes, earlyScanMinutes)) {
    const involved = !involves || involves(current.meeting);
    if (involved && latest && current.opens <= latest.closes) return [latest.meeting, current.meeting];
    if (!involved && latestInvolved && current.opens <= latestInvolved.closes) return [latestInvolved.meeting, current.meeting];
    if (!latest || current.closes > latest.closes) latest = current;
    if (involved && (!latestInvolved || current.closes > latestInvolved.closes)) latestInvolved = current;
  }
  return undefined;
}

/**
 * The first two meetings whose windows overlap under the `after` allowances but not under the `before` ones: the overlap a
 * longer early arrival or late scan allowance would create. Pairs that already overlap are left alone.
 */
export function newlyOverlappingMeetingWindows<T extends MeetingWindowLike>(meetings: T[], before: { lateScanMinutes: number; earlyScanMinutes: number }, after: { lateScanMinutes: number; earlyScanMinutes: number }): [T, T] | undefined {
  const ordered = orderedWindows(meetings, after.lateScanMinutes, after.earlyScanMinutes);
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    // Windows are ordered by opening time, so each later one that opens before this one closes overlaps it.
    for (let later = index + 1; later < ordered.length && ordered[later].opens <= current.closes; later += 1) {
      const pair: [T, T] = [current.meeting, ordered[later].meeting];
      if (!overlappingMeetingWindows(pair, before.lateScanMinutes, before.earlyScanMinutes)) return pair;
    }
  }
  return undefined;
}

export function nextAttendanceAction(events: AttendanceEventLike[], occurredAt: string, duplicateWindowMs = DUPLICATE_SCAN_WINDOW_MS): { status: "complete" } | { status: "duplicate"; action: AttendanceAction } | { status: "accepted"; action: AttendanceAction } {
  const ordered = [...events].sort((a, b) => Date.parse(a.occurredAt ?? "") - Date.parse(b.occurredAt ?? "") || String(a.id).localeCompare(String(b.id)));
  if (ordered.some((event) => event.action === "check_in") && ordered.some((event) => event.action === "check_out")) return { status: "complete" };
  const last = ordered.at(-1);
  if (last?.occurredAt && Math.abs(Date.parse(occurredAt) - Date.parse(last.occurredAt)) <= duplicateWindowMs) return { status: "duplicate", action: last.action };
  return { status: "accepted", action: ordered.some((event) => event.action === "check_in") ? "check_out" : "check_in" };
}

export function attendanceDisposition(events: AttendanceEventLike[], correction?: Exclude<AttendanceDisposition, "active"> | null): AttendanceDisposition {
  if (correction) return correction;
  const checkedIn = events.some((event) => event.action === "check_in");
  const checkedOut = events.some((event) => event.action === "check_out");
  if (checkedIn && checkedOut) return "present";
  if (checkedIn) return "active";
  return "absent";
}

export const DEFAULT_LATE_SCAN_MINUTES = 30;
export const MAX_LATE_SCAN_MINUTES = 180;
export const DUPLICATE_SCAN_WINDOW_MS = 90_000;

export type AttendanceAction = "check_in" | "check_out";
export type AttendanceDisposition = "absent" | "active" | "present" | "excused";
export type AttendanceEventLike = { id?: string; action: AttendanceAction; occurredAt?: string };
export type MeetingWindowLike = { id?: string; title?: string; startsAt: string; endsAt: string };

export function attendanceClosesAt(endsAt: string, lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES): string {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) throw new Error("A valid meeting end time is required");
  const minutes = Number(lateScanMinutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_LATE_SCAN_MINUTES) throw new Error("Late scan window must be from 0 to 180 minutes");
  return new Date(end + minutes * 60_000).toISOString();
}

export function scanWindowState(meeting: { startsAt: string; endsAt: string }, occurredAt: string, lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES): { accepted: true; closesAt: string } | { accepted: false; reason: string } {
  const scan = Date.parse(occurredAt);
  const start = Date.parse(meeting.startsAt);
  const closesAt = attendanceClosesAt(meeting.endsAt, lateScanMinutes);
  const close = Date.parse(closesAt);
  if (!Number.isFinite(scan)) return { accepted: false, reason: "Scan time is invalid" };
  if (scan < start) return { accepted: false, reason: "This meeting has not started" };
  if (scan > close) return { accepted: false, reason: "Attendance is closed for this meeting" };
  return { accepted: true, closesAt };
}

export function overlappingMeetingWindows(meetings: MeetingWindowLike[], lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES): [MeetingWindowLike, MeetingWindowLike] | undefined {
  const ordered = meetings.map((meeting) => ({ meeting, start: Date.parse(meeting.startsAt), close: Date.parse(attendanceClosesAt(meeting.endsAt, lateScanMinutes)) }))
    .sort((left, right) => left.start - right.start || left.close - right.close);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]; const current = ordered[index];
    if (current.start <= previous.close) return [previous.meeting, current.meeting];
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

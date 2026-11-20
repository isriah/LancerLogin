// Why a kiosk scan was refused when nothing is wrong with the scan itself: no meeting is open for it, or the member's
// attendance for the meeting is settled. The fields ride on the refusal's JSON body beside the unchanged `error` text
// and `code`, so a kiosk that knows them shows what happened and an older kiosk shows what it always has.
import { attendanceWindow, DEFAULT_EARLY_SCAN_MINUTES, DEFAULT_LATE_SCAN_MINUTES } from "./attendance-lifecycle.ts";
import { localDate } from "./attendance-policy.ts";

export type ScanRefusalReason = "too_early" | "meeting_ended" | "no_meeting_today" | "already_done" | "not_started_yet";
/**
 * `at` is the instant the meeting opens for scans (too_early) or closed for them (meeting_ended); `time` is that
 * instant ready to show, in the installation's time zone ("5:45 PM"). `date` is the day a member's attendance
 * begins, ready to show ("Dec 1, 2026"), and `startsOn` the same day as YYYY-MM-DD.
 */
export type ScanRefusal =
  | { reason: "too_early" | "meeting_ended"; meetingTitle: string; at: string; time: string }
  | { reason: "no_meeting_today" }
  | { reason: "already_done" }
  | { reason: "not_started_yet"; startsOn: string; date: string };

type ScanMeetingLike = { title: string; startsAt: string; endsAt: string };

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
/** "5:45 PM" in the installation's time zone: the hour and minute style the kiosks use for times. */
export function scanRefusalTime(instant: string, timeZone: string): string {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    timeFormatters.set(timeZone, formatter);
  }
  // Newer ICU data separates the time from AM/PM with a narrow no-break space; kiosks get a plain one.
  return formatter.format(new Date(instant)).replace(/[  ]/g, " ");
}

const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" });
/** "Dec 1, 2026" for a YYYY-MM-DD day, or the day as given when it is not one. */
export function scanRefusalDate(day: string): string {
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : NaN;
  return Number.isFinite(instant) ? dayFormatter.format(new Date(instant)) : day;
}

/** A time zone Intl accepts, or UTC: organization settings saved before validation must not break a refusal. */
function usableTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return timeZone; } catch { return "UTC"; }
}

/**
 * Why no meeting takes a scan sent without a chosen meeting. `candidates` are the meetings the scan lookup already
 * read: the latest one that started at or before the scan and the next one to start. "Today" is the installation's
 * local day of the scan (organization time zone, as attendance policy dates are).
 *
 * A meeting that starts later today and has not opened wins over one that ended today: the member can still scan in.
 * A meeting counts as ended today when it started or ended on the scan's local day.
 */
export function scanWindowRefusal(candidates: readonly ScanMeetingLike[], occurredAt: string, timeZone: string | null | undefined, lateScanMinutes = DEFAULT_LATE_SCAN_MINUTES, earlyScanMinutes = DEFAULT_EARLY_SCAN_MINUTES): ScanRefusal {
  const scan = Date.parse(occurredAt); const zone = usableTimeZone(timeZone);
  const today = localDate(occurredAt, zone);
  let previous: ScanMeetingLike | undefined; let next: ScanMeetingLike | undefined;
  for (const meeting of candidates) {
    const start = Date.parse(meeting.startsAt);
    if (start <= scan) { if (!previous || start > Date.parse(previous.startsAt)) previous = meeting; }
    else if (!next || start < Date.parse(next.startsAt)) next = meeting;
  }
  if (next && localDate(next.startsAt, zone) === today) {
    const { opens } = attendanceWindow(next, lateScanMinutes, earlyScanMinutes);
    if (scan < opens) { const at = new Date(opens).toISOString(); return { reason: "too_early", meetingTitle: next.title, at, time: scanRefusalTime(at, zone) }; }
  }
  if (previous && (localDate(previous.startsAt, zone) === today || localDate(previous.endsAt, zone) === today)) {
    const { closes } = attendanceWindow(previous, lateScanMinutes, earlyScanMinutes);
    if (scan > closes) { const at = new Date(closes).toISOString(); return { reason: "meeting_ended", meetingTitle: previous.title, at, time: scanRefusalTime(at, zone) }; }
  }
  return { reason: "no_meeting_today" };
}

export const alreadyDoneRefusal = (): ScanRefusal => ({ reason: "already_done" });
export const notStartedYetRefusal = (startsOn: string): ScanRefusal => ({ reason: "not_started_yet", startsOn, date: scanRefusalDate(startsOn) });

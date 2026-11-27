import { HttpError } from "./http-error.ts";
import type { D1Database } from "./d1-usage.ts";
import { requireModuleService } from "./module-platform.ts";
import { captureModuleServiceDatabase } from "./module-database-scope.ts";
import { installationTimeZone } from "./core-installation-projection.ts";
import { localDate as policyLocalDate, meetingEligibility, participationStartDate, validDate } from "./attendance-policy.ts";
import { inactiveAt } from "./member-participation.ts";
import { activeMemberLabelChangesStatement, foldMemberLabels, type NamedLabelChange } from "./core-roster-projection.ts";

/** A non-test, non-deleted meeting that starts on the organization-local date asked for. */
export type DayMeeting = { id: string; title: string; startsAt: string; endsAt: string; required: boolean; audienceMode: "all" | "labels"; audienceLabelIds: string[] };
/** A member's first kiosk, Discord or dashboard check-in for one of the day's meetings. */
export type DayPresence = { memberId: string; meetingId: string; firstCheckInAt: string; checkedOut: boolean };
export type DayExpectationReason = "expected" | "inactive" | "before_start" | "outside_audience";
export type DayExpectation = { memberId: string; expected: boolean; reason: DayExpectationReason };
/** `requiredOnly` considers only the day's required meetings, as attendance rates do. */
export type AttendanceDayOptions = { readonly requiredOnly?: boolean };

const meetingLimit = 100;
const presenceLimit = 5000;
const memberLimit = 500;

// Attendance's service database for each caller database, so the projections one job or request calls together check
// Attendance once. A context database lives for one request or job; the short expiry covers a caller that passes a
// longer-lived database, so a cached "unavailable" never outlives a few seconds.
const attendanceDatabases = new WeakMap<D1Database, { readonly at: number; readonly scoped: Promise<D1Database | undefined> }>();
const attendanceDatabaseReuseMs = 10_000;

/**
 * Attendance's service-scoped database composed over the caller's own module-scoped database, or undefined while Attendance
 * is disabled or not set up. Every later batch rechecks both guards: the caller's module and Attendance at the captured
 * generation. If Attendance is disabled while a call runs, its next read fails with Core's 403 "Module authority changed".
 */
function attendanceDatabase(db: D1Database): Promise<D1Database | undefined> {
  const now = Date.now(); const cached = attendanceDatabases.get(db);
  if (cached && now - cached.at < attendanceDatabaseReuseMs) return cached.scoped;
  const scoped = (async () => {
    let generation: number;
    try { generation = await requireModuleService(db, "attendance"); }
    catch (error) { if (error instanceof HttpError && (error.status === 409 || error.status === 503)) return undefined; throw error; }
    return captureModuleServiceDatabase(db, "attendance", generation);
  })();
  attendanceDatabases.set(db, { at: now, scoped });
  scoped.catch(() => { if (attendanceDatabases.get(db)?.scoped === scoped) attendanceDatabases.delete(db); });
  return scoped;
}

function requireLocalDate(localDate: string) {
  if (!validDate(localDate)) throw new HttpError(400, "localDate must be a YYYY-MM-DD date");
}

function shiftDate(date: string, days: number) {
  const value = new Date(date + "T12:00:00.000Z"); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}

/**
 * A UTC window that holds every instant of `localDate` in any time zone (UTC-12 to UTC+14), as bare dates. Stored ISO
 * timestamps compare as text with them, so the range uses idx_meetings_installation_starts; each row is then kept only
 * when its local date matches, which is DST-safe because the local date comes from the IANA zone.
 */
function paddedRange(localDate: string): [string, string] { return [shiftDate(localDate, -1), shiftDate(localDate, 2)]; }

const dayMeetingsWhere = "installation_id=? AND deleted_at IS NULL AND is_test=0 AND starts_at>=? AND starts_at<?";

type MeetingRow = { id: string; title: string; startsAt: string; endsAt: string; required: number; audienceMode: "all" | "labels" };

function readDayMeetings(scoped: D1Database, installationId: string, range: [string, string]) {
  return Promise.all([
    installationTimeZone(scoped, installationId),
    scoped.prepare(`SELECT id,title,starts_at AS startsAt,ends_at AS endsAt,required,audience_mode AS audienceMode FROM meetings WHERE ${dayMeetingsWhere} ORDER BY starts_at,id LIMIT ${meetingLimit}`).bind(installationId, ...range).all<MeetingRow>(),
    scoped.prepare(`SELECT a.meeting_id AS meetingId,a.label_id AS labelId FROM meeting_audience_labels a WHERE a.installation_id=? AND a.meeting_id IN (SELECT id FROM meetings WHERE ${dayMeetingsWhere}) ORDER BY a.meeting_id,a.label_id`).bind(installationId, installationId, ...range).all<{ meetingId: string; labelId: string }>(),
  ]);
}

function dayMeetings(localDate: string, timeZone: string, meetings: MeetingRow[], audience: { meetingId: string; labelId: string }[], options: AttendanceDayOptions = {}): DayMeeting[] {
  const audienceByMeeting = new Map<string, string[]>();
  for (const row of audience) audienceByMeeting.set(row.meetingId, [...(audienceByMeeting.get(row.meetingId) ?? []), row.labelId]);
  return meetings
    .filter((meeting) => policyLocalDate(meeting.startsAt, timeZone) === localDate && (!options.requiredOnly || Boolean(meeting.required)))
    .map((meeting) => ({ id: meeting.id, title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt, required: Boolean(meeting.required), audienceMode: meeting.audienceMode ?? "all", audienceLabelIds: audienceByMeeting.get(meeting.id) ?? [] }));
}

/** An installation without a configured time zone has not finished Attendance setup. */
async function unlessUnconfigured<T>(read: Promise<T>): Promise<T | undefined> {
  try { return await read; }
  catch (error) { if (error instanceof HttpError && error.status === 409 && error.message === "The installation time zone is not configured") return undefined; throw error; }
}

/**
 * Attendance meetings (at most 100) that start on the organization-local date `localDate` (YYYY-MM-DD), oldest first,
 * excluding deleted and test meetings. Undefined while Attendance is disabled or not set up. Pass the module's own context
 * database (`db` from a route, job or interface handler); Attendance's enablement is rechecked with every read.
 */
export async function meetingsOnLocalDate(db: D1Database, installationId: string, localDate: string, options: AttendanceDayOptions = {}): Promise<DayMeeting[] | undefined> {
  requireLocalDate(localDate);
  const scoped = await attendanceDatabase(db); if (!scoped) return undefined;
  const read = await unlessUnconfigured(readDayMeetings(scoped, installationId, paddedRange(localDate))); if (!read) return undefined;
  const [timeZone, meetings, audience] = read;
  return dayMeetings(localDate, timeZone, meetings.results ?? [], audience.results ?? [], options);
}

/**
 * Who checked in to the day's meetings: each member's first check-in per meeting, and whether a check-out was recorded at or
 * after it. Read from attendance events only (kiosk, Discord code and dashboard check-ins); Admin and Operator attendance
 * corrections, which live in `attendance_corrections`, are not counted, so a member marked present by correction without a
 * check-in is absent here and one corrected to absent or excused after checking in is still present. Visible to any enabled
 * module that calls it: say so in the module's capability label. Undefined while Attendance is unavailable.
 */
export async function presentMembersForDay(db: D1Database, installationId: string, localDate: string, options: AttendanceDayOptions = {}): Promise<DayPresence[] | undefined> {
  requireLocalDate(localDate);
  const scoped = await attendanceDatabase(db); if (!scoped) return undefined;
  const range = paddedRange(localDate);
  const read = await unlessUnconfigured(Promise.all([
    readDayMeetings(scoped, installationId, range),
    // CROSS JOIN keeps the day's few meetings as the outer loop, so events are read through idx_events_installation_meeting.
    scoped.prepare(`WITH first AS (SELECT e.member_id,e.meeting_id,MIN(e.occurred_at) AS first_at FROM meetings m CROSS JOIN attendance_events e
        WHERE m.installation_id=? AND m.deleted_at IS NULL AND m.is_test=0 AND m.starts_at>=? AND m.starts_at<?
        AND e.installation_id=m.installation_id AND e.meeting_id=m.id AND e.action='check_in'
        GROUP BY e.member_id,e.meeting_id)
      SELECT f.member_id AS memberId,f.meeting_id AS meetingId,f.first_at AS firstCheckInAt,
        EXISTS(SELECT 1 FROM attendance_events o WHERE o.installation_id=? AND o.meeting_id=f.meeting_id AND o.member_id=f.member_id
          AND o.action='check_out' AND julianday(o.occurred_at)>=julianday(f.first_at)) AS checkedOut
      FROM first f ORDER BY f.meeting_id,f.first_at,f.member_id LIMIT ${presenceLimit}`).bind(installationId, ...range, installationId).all<{ memberId: string; meetingId: string; firstCheckInAt: string; checkedOut: number }>(),
  ]));
  if (!read) return undefined;
  const [[timeZone, meetings, audience], presence] = read;
  const day = new Set(dayMeetings(localDate, timeZone, meetings.results ?? [], audience.results ?? [], options).map((meeting) => meeting.id));
  return (presence.results ?? []).filter((row) => day.has(row.meetingId)).map((row) => ({ memberId: row.memberId, meetingId: row.meetingId, firstCheckInAt: row.firstCheckInAt, checkedOut: Boolean(row.checkedOut) }));
}

type ExpectationMember = { id: string; inactivePeriodsJson: string; attendanceRequiredFrom: string | null; rosterAddedAt: string | null };

/**
 * Whether each active member (at most 500) was expected at the day's meetings, by Core's attendance rules: not inactive at
 * the meeting's start (`inactiveAt`), on or after the member's participation start (`participationStartDate`), and in the
 * meeting's audience by the labels in effect that day (`meetingEligibility`), for at least one of the day's meetings. When
 * a member is expected at none, `reason` is the first that applies to any meeting: inactive, before_start, then
 * outside_audience. An empty list when no meeting starts that day; undefined while Attendance is unavailable.
 */
export async function expectedMembersForDay(db: D1Database, installationId: string, localDate: string, options: AttendanceDayOptions = {}): Promise<DayExpectation[] | undefined> {
  requireLocalDate(localDate);
  const scoped = await attendanceDatabase(db); if (!scoped) return undefined;
  const read = await unlessUnconfigured(Promise.all([
    readDayMeetings(scoped, installationId, paddedRange(localDate)),
    scoped.prepare(`SELECT id,inactive_periods_json AS inactivePeriodsJson,attendance_required_from AS attendanceRequiredFrom,created_at AS rosterAddedAt FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name,id LIMIT ${memberLimit}`).bind(installationId).all<ExpectationMember>(),
    activeMemberLabelChangesStatement(scoped, installationId, localDate).all<NamedLabelChange>(),
  ]));
  if (!read) return undefined;
  const [[timeZone, meetingRows, audience], members, changes] = read;
  const meetings = dayMeetings(localDate, timeZone, meetingRows.results ?? [], audience.results ?? [], options);
  if (!meetings.length) return [];
  const labels = foldMemberLabels(changes.results ?? []);
  return (members.results ?? []).map((member) => {
    const participationStart = participationStartDate(member, timeZone);
    const activeLabels = new Set((labels.get(member.id) ?? new Map<string, string>()).keys());
    const reasons = new Set<DayExpectationReason>();
    for (const meeting of meetings) {
      if (inactiveAt(member.inactivePeriodsJson, meeting.startsAt)) { reasons.add("inactive"); continue; }
      const eligibility = meetingEligibility({ date: localDate, participationStart, activeLabels, hasWeeklyTarget: false, meeting });
      reasons.add(eligibility === "before_start" || eligibility === "outside_audience" ? eligibility : "expected");
    }
    const reason = (["expected", "inactive", "before_start", "outside_audience"] as const).find((item) => reasons.has(item))!;
    return { memberId: member.id, expected: reason === "expected", reason };
  });
}

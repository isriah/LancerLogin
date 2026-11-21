// One-time correction of participation start dates stored as the UTC date of the member's roster-added instant.
//
// A member's participation start (members.attendance_required_from) decides which meetings count for them. Members
// added today have no stored date: the start is derived on every read as the organization-local date of created_at
// (participationStartDate). Older code stored a date instead, and computed it in UTC:
// - migration 0019: substr(created_at, 1, 10) for every member that existed;
// - roster imports until 2026-09-28 (04c9bcbe): now.slice(0, 10) with created_at = now, for a member without a typed date;
// - the dashboard's Add roster member dialog until then, which filled its date field with the browser's
//   new Date().toISOString().slice(0, 10), also the UTC date, and sent it with the new member;
// - member edits until then: created_at.slice(0, 10) when no date was stored, on any edit of the member;
// - restores of backups older than the column, until PR 237: created_at.slice(0, 10).
// West of UTC an evening add got the next day's date, so that evening's meeting was excluded; east of UTC a morning add
// got the previous day's.
//
// Which dates are candidates: a stored date that equals the UTC date of the row's own created_at, where the
// organization-local date of that instant differs. The two dates are always one day apart.
// What is left alone:
// - a date that differs from the UTC date of created_at (typed, imported with a date, or edited to something else);
// - a member whose audit history shows an Admin changed the start date. Two entries can show that:
//   attendance.member_setting_updated { attendanceRequiredFrom }, which the member settings route writes only when the
//   date changes; and roster.member_updated { active, attendanceRequiredFrom }, which the member edit route wrote until
//   2026-09-28 on every edit with the date it stored, changed or not. That one records no previous date, so it counts
//   as a change only when its date differs from the UTC date of created_at. A rename or deactivation that carried the
//   automatic date along is not a choice of date and does not stop the correction. Those members are listed, not changed.
//   A date typed to equal the UTC date of the add cannot be told from the automatic one and is treated as automatic;
//   the audit entry below can put it back;
// - a created_at that is not a full timestamp, so no instant is known;
// - everything when the organization has no time zone; and nothing can differ when the zone is UTC;
// - a member whose record the correction would not improve (startCorrectionEffect). The stored date is what the
//   kiosk enforced and what the Admin saw: a meeting before it refused the member's scan. West of UTC the local date
//   is a day earlier and that day's meetings would newly count, so the member is corrected only when they were present
//   at every one that counts; one that would be a miss leaves them alone. East of UTC the local date is a day later and
//   that day's meetings would stop counting, so the member is corrected only when none of those is a counted presence.
//   A member for whom no meeting would start or stop counting is left alone as well. "Counts" and "present" are the
//   attendance policy's own: both dates are run through evaluateAttendance over the weeks around the day in question.
// The time zone is the one configured now, with its daylight saving rules on the date in question. Nothing in the
// dashboard or API changes an organization's time zone after it is created, and every read of a derived start uses
// the same zone.
//
// How it runs: from scheduled housekeeping, START_CORRECTION_BATCH candidates a pass, at most five D1 subrequests:
// state and time zone; candidates; one batch that reads the policy and, for each candidate, their label changes and the
// meetings, scans and corrections of the weeks around their day; one batch that changes the rows, writes the audit
// entry and moves the cursor; and, only if a row changed between the read and the write, one batch to record what was
// really changed. Housekeeping reads the state in the clean-up batch it already makes, so once the job is complete it
// costs no subrequest at all.
//
// Record and reversal: one audit_log entry, attendance.participation_starts_corrected, written in the batch that changes
// the rows and rewritten by each later pass, holds { timeZone, corrected, changes: [{ id, memberId, from, to, gained,
// dropped }], leftAlone: [...], wouldWorsen, noEffect, complete }: gained and dropped are the ids of the meetings that
// started or stopped counting, wouldWorsen and noEffect count the members left alone for those reasons. A run that
// corrects nobody writes no entry and only sets the marker. To reverse, for each change set attendance_required_from
// back to `from` where the member's id matches and the date is still `to`. Updating members fires the report revision
// triggers (migration 0037), as a manual edit does, so reports and policy evaluation read the new dates.
//
// Restores: the state row is not in backups. A roster or entire-installation restore replaces it, in its own
// transaction, with a fresh one under a new run id (startCorrectionReset), so the job runs again over the restored
// members: an older backup's dates are assessed again, a newer backup's corrected dates no longer match the rule and
// stay. Every write of a pass checks the run id and cursor it read, so a pass that started before a restore changes
// nothing after it and cannot mark the new run complete. The audit entry travels in entire-installation backups.
import { evaluateAttendance, localDate, participationStartDate, type AttendanceRule, type LabelChange, type Observation, type PolicyLabel, type PolicyMeeting, type PolicyMember } from "./attendance-policy.ts";
import { attendanceClosesAt, attendanceDisposition } from "./attendance-lifecycle.ts";
import type { D1Database, D1Statement } from "./d1-usage.ts";

/** Members with a stored date equal to their created_at date that one pass examines. */
export const START_CORRECTION_BATCH = 20;
/** D1 subrequests a pass needs after its state read: candidates, their attendance, the write batch, and a rare second write. */
export const START_CORRECTION_WORK_QUERIES = 4;
export const START_CORRECTION_ACTION = "attendance.participation_starts_corrected";

export type StartCorrectionChange = { id: string; memberId: string; from: string; to: string; gained?: string[]; dropped?: string[] };
export type StartCorrectionResult = { status: "complete" | "waiting" | "progress" | "raced"; more: boolean; corrected: number; leftAlone: number; wouldWorsen: number; noEffect: number };

/**
 * The organization-local start date for a stored date that was written as the UTC date of the roster-added instant, or
 * null when the stored date is anything else or the two dates agree.
 */
export function correctedParticipationStart(member: { attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null }, timeZone: string): string | null {
  const stored = member.attendanceRequiredFrom; const added = member.rosterAddedAt;
  // A bare date carries no instant, so its local date is unknown.
  if (!stored || !added || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(added)) return null;
  if (participationStartDate({ rosterAddedAt: added }, "UTC") !== stored) return null;
  const local = participationStartDate({ rosterAddedAt: added }, timeZone);
  return /^\d{4}-\d{2}-\d{2}$/.test(local) && local !== stored ? local : null;
}

const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00.000Z") + days * 86_400_000).toISOString().slice(0, 10);
const monday = (date: string) => { const day = new Date(date + "T12:00:00.000Z").getUTCDay(); return shift(date, -(day === 0 ? 6 : day - 1)); };
/** The Monday-to-Sunday weeks that hold the stored and the corrected date: the only weeks whose results can differ. */
export function startCorrectionWeeks(from: string, to: string): { first: string; last: string } {
  const earlier = from < to ? from : to; const later = from < to ? to : from;
  return { first: monday(earlier), last: shift(monday(later), 6) };
}

export type StartCorrectionPolicy = { labels: PolicyLabel[]; changes: LabelChange[]; rules: AttendanceRule[]; meetings: PolicyMeeting[]; observations: Observation[]; timeZone: string; recentDays?: number; policyActivatedOn?: string | null; now?: string };
export type StartCorrectionEffect = { correct: boolean; reason: "improves" | "would_worsen" | "no_effect"; gained: string[]; dropped: string[] };
/**
 * What moving `member`'s start from the stored date to `to` does to their record, by the attendance policy itself:
 * both dates are evaluated over the meetings of the weeks around them. A meeting counts when its row is rate-eligible
 * or regular-eligible (a completed meeting on or after the start, in the member's audience, required or under a weekly
 * policy, outside their inactive periods); it is a presence when attended and a miss otherwise, excused included.
 * The correction is made only when it adds or drops a counted meeting, and the member has no fewer presences, no more
 * misses and no more weeks below a weekly target than before.
 */
export function startCorrectionEffect(member: PolicyMember, to: string, policy: StartCorrectionPolicy): StartCorrectionEffect {
  const from = member.attendanceRequiredFrom!; const weeks = startCorrectionWeeks(from, to);
  const meetings = policy.meetings.filter((meeting) => { const date = localDate(meeting.startsAt, policy.timeZone); return weeks.first <= date && date <= weeks.last; });
  const ids = new Set(meetings.map((meeting) => meeting.id));
  const shared = { labels: policy.labels, changes: policy.changes.filter((change) => change.memberId === member.id), rules: policy.rules, meetings, observations: policy.observations.filter((item) => item.memberId === member.id && ids.has(item.meetingId)), timeZone: policy.timeZone, recentDays: policy.recentDays, policyActivatedOn: policy.policyActivatedOn, ...(policy.now ? { now: policy.now } : {}) };
  const record = (start: string) => {
    const result = evaluateAttendance({ ...shared, members: [{ ...member, attendanceRequiredFrom: start }] })[0];
    const counted = new Map((result?.rows ?? []).filter((row) => row.rateEligible || row.regularEligible).map((row) => [row.meetingId, row.attended]));
    return { counted, present: [...counted.values()].filter(Boolean).length, missed: [...counted.values()].filter((attended) => !attended).length, below: (result?.weeks ?? []).filter((week) => week.belowTarget).length };
  };
  const before = record(from); const after = record(to);
  const gained = [...after.counted.keys()].filter((id) => !before.counted.has(id)).sort(); const dropped = [...before.counted.keys()].filter((id) => !after.counted.has(id)).sort();
  if (!gained.length && !dropped.length) return { correct: false, reason: "no_effect", gained, dropped };
  const worse = after.present < before.present || after.missed > before.missed || after.below > before.below;
  return { correct: !worse, reason: worse ? "would_worsen" : "improves", gained, dropped };
}

type State = { runId: string; cursor: string; examined: number; changesJson: string; leftAloneJson: string; worsened: number; noEffect: number; auditId: string | null; completedAt: string | null };
type Candidate = { id: string; memberId: string; firstName: string; lastName: string; active: number; inactivePeriodsJson: string; rosterAddedAt: string; attendanceRequiredFrom: string; edited: number };
const installation = "primary";
const list = (json: string): StartCorrectionChange[] => { try { const value = JSON.parse(json); return Array.isArray(value) ? value : []; } catch { return []; } };

/**
 * The job's state and the organization's time zone in one statement: no row before an installation exists. Housekeeping
 * sends it in the clean-up batch it already makes, so a completed job costs no D1 subrequest of its own.
 */
export function startCorrectionStateRead(db: D1Database): D1Statement {
  return db.prepare(`SELECT o.time_zone AS timeZone, c.run_id AS runId, c.cursor, c.examined, c.changes_json AS changesJson, c.left_alone_json AS leftAloneJson, c.worsened, c.no_effect AS noEffect, c.audit_id AS auditId, c.completed_at AS completedAt
    FROM installations i LEFT JOIN organization_settings o ON o.installation_id = i.id LEFT JOIN participation_start_correction c ON c.installation_id = i.id WHERE i.id = ?`).bind(installation);
}

/**
 * Start the job again under a new run id, for the batch of a restore that replaces members. A pass that read the
 * previous run, or no run at all, then finds another run id and writes nothing.
 */
export function startCorrectionReset(db: D1Database, now = new Date().toISOString()): D1Statement {
  return db.prepare(`INSERT INTO participation_start_correction (installation_id, run_id, started_at) VALUES (?, ?, ?)
    ON CONFLICT(installation_id) DO UPDATE SET run_id = excluded.run_id, started_at = excluded.started_at, cursor = '', examined = 0, changes_json = '[]', left_alone_json = '[]', worsened = 0, no_effect = 0, audit_id = NULL, completed_at = NULL`)
    .bind(installation, crypto.randomUUID(), now);
}

/** The policy, and each candidate's label changes and the meetings, scans and corrections of their weeks, in one batch. */
async function candidatePolicies(db: D1Database, timeZone: string, candidates: { row: Candidate; to: string }[], now: string | undefined): Promise<Map<string, StartCorrectionPolicy>> {
  // A week's local days lie within these UTC instants in every zone; startCorrectionEffect keeps the week's own.
  const windows = new Map<string, { from: string; to: string }>();
  const windowOf = (item: { row: Candidate; to: string }) => { const weeks = startCorrectionWeeks(item.row.attendanceRequiredFrom, item.to); const window = { from: shift(weeks.first, -1) + "T00:00:00Z", to: shift(weeks.last, 2) + "T00:00:00Z" }; windows.set(window.from + window.to, window); return window; };
  const perCandidate = candidates.map((item) => ({ item, window: windowOf(item) }));
  const windowList = [...windows.entries()];
  const inWindow = "datetime(mt.starts_at) >= datetime(?) AND datetime(mt.starts_at) < datetime(?)";
  const results = await db.batch([
    db.prepare("SELECT late_scan_minutes AS lateScanMinutes, attendance_recent_days AS recentDays, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = ?").bind(installation),
    db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = ? ORDER BY name COLLATE NOCASE").bind(installation),
    db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, rule_type AS ruleType, threshold_percent AS thresholdPercent, meetings_per_week AS meetingsPerWeek, excused_handling AS excusedHandling FROM label_attendance_rules WHERE installation_id = ? ORDER BY label_id, starts_on").bind(installation),
    ...windowList.map(([, window]) => db.prepare(`SELECT mt.id, mt.title, mt.starts_at AS startsAt, mt.ends_at AS endsAt, mt.required, mt.attendance_weight AS attendanceWeight, mt.audience_mode AS audienceMode, mt.is_test AS isTest,
        (SELECT json_group_array(a.label_id) FROM meeting_audience_labels a WHERE a.installation_id = mt.installation_id AND a.meeting_id = mt.id) AS audienceJson
      FROM meetings mt WHERE mt.installation_id = ? AND mt.deleted_at IS NULL AND ${inWindow} ORDER BY mt.starts_at DESC`).bind(installation, window.from, window.to)),
    ...perCandidate.flatMap(({ item, window }) => [
      db.prepare("SELECT member_id AS memberId, label_id AS labelId, action, effective_date AS effectiveDate, created_at AS createdAt FROM member_label_changes WHERE installation_id = ? AND member_id = ? ORDER BY effective_date, created_at, id").bind(installation, item.row.id),
      db.prepare(`SELECT e.meeting_id AS meetingId, e.action, e.occurred_at AS occurredAt FROM attendance_events e JOIN meetings mt ON mt.id = e.meeting_id AND mt.installation_id = e.installation_id
        WHERE e.installation_id = ? AND e.member_id = ? AND mt.deleted_at IS NULL AND ${inWindow} ORDER BY e.occurred_at, e.id`).bind(installation, item.row.id, window.from, window.to),
      db.prepare(`SELECT c.meeting_id AS meetingId, c.disposition, c.reason FROM attendance_corrections c JOIN meetings mt ON mt.id = c.meeting_id AND mt.installation_id = c.installation_id
        WHERE c.installation_id = ? AND c.member_id = ? AND mt.deleted_at IS NULL AND ${inWindow} ORDER BY c.created_at, c.id`).bind(installation, item.row.id, window.from, window.to),
    ]),
  ]);
  const rows = <T>(index: number) => (results[index]?.results ?? []) as T[];
  const settings = rows<{ lateScanMinutes?: number; recentDays?: number; policyActivatedOn?: string | null }>(0)[0];
  const labels = rows<PolicyLabel>(1); const rules = rows<AttendanceRule>(2);
  const meetingsByWindow = new Map(windowList.map(([key], index) => [key, rows<Omit<PolicyMeeting, "attendanceClosesAt" | "audienceLabelIds"> & { audienceJson: string | null }>(3 + index)
    .map(({ audienceJson, ...meeting }) => ({ ...meeting, attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30), audienceLabelIds: audienceJson ? JSON.parse(audienceJson) as string[] : [] }))]));
  const policies = new Map<string, StartCorrectionPolicy>();
  perCandidate.forEach(({ item, window }, index) => {
    const base = 3 + windowList.length + index * 3; const memberId = item.row.id;
    type Event = { meetingId: string; action: "check_in" | "check_out"; occurredAt: string };
    const events = new Map<string, Event[]>(); for (const event of rows<Event>(base + 1)) events.set(event.meetingId, [...(events.get(event.meetingId) ?? []), event]);
    // The newest correction of a meeting decides, as loadPolicyData reads them.
    const corrections = new Map<string, { disposition: "present" | "absent" | "excused"; reason: string }>(); for (const correction of rows<{ meetingId: string; disposition: "present" | "absent" | "excused"; reason: string }>(base + 2)) corrections.set(correction.meetingId, correction);
    const observations: Observation[] = [...new Set([...events.keys(), ...corrections.keys()])].map((meetingId) => {
      const own = events.get(meetingId) ?? []; const correction = corrections.get(meetingId);
      return { meetingId, memberId, disposition: attendanceDisposition(own, correction?.disposition), checkedInAt: own.find((event) => event.action === "check_in")?.occurredAt, checkedOutAt: own.find((event) => event.action === "check_out")?.occurredAt, reason: correction?.reason };
    });
    policies.set(memberId, { labels, rules, changes: rows<LabelChange>(base), meetings: meetingsByWindow.get(window.from + window.to) ?? [], observations, timeZone, recentDays: settings?.recentDays ?? 30, policyActivatedOn: settings?.policyActivatedOn ?? null, ...(now ? { now } : {}) });
  });
  return policies;
}

/**
 * One pass of the correction. See the header for the rule, the cost and what is recorded. `read` is the row of
 * startCorrectionStateRead when the caller already has it; `fits` says whether the pass may make this many more queries.
 */
export async function correctParticipationStarts(db: D1Database, options: { now?: () => string; limit?: number; fits?: (queries: number) => boolean; read?: unknown } = {}): Promise<StartCorrectionResult> {
  const now = options.now ?? (() => new Date().toISOString()); const limit = options.limit ?? START_CORRECTION_BATCH;
  const read = ("read" in options ? options.read ?? null : await startCorrectionStateRead(db).first()) as (Partial<State> & { timeZone?: string | null }) | null;
  const state = typeof read?.runId === "string" ? read as State : null;
  const previous = { corrected: state ? list(state.changesJson).length : 0, leftAlone: state ? list(state.leftAloneJson).length : 0, wouldWorsen: state?.worsened ?? 0, noEffect: state?.noEffect ?? 0 };
  if (state?.completedAt) return { status: "complete", more: false, ...previous };
  const timeZone = read?.timeZone;
  // No organization yet, or a zone this runtime does not know: nothing is decided, and the next pass looks again.
  if (!timeZone) return { status: "waiting", more: false, ...previous };
  try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { return { status: "waiting", more: false, ...previous }; }
  if (options.fits && !options.fits(START_CORRECTION_WORK_QUERIES)) return { status: "progress", more: true, ...previous };

  const cursor = state?.cursor ?? ""; const runId = state?.runId ?? crypto.randomUUID();
  // In UTC the two dates are the same for every member, so there is nothing to examine.
  const candidates = timeZone === "UTC" ? [] : (await db.prepare(`SELECT m.id, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, m.active, m.inactive_periods_json AS inactivePeriodsJson, m.created_at AS rosterAddedAt, m.attendance_required_from AS attendanceRequiredFrom,
      m.id IN (SELECT a.target_id FROM audit_log a JOIN members e ON e.id = a.target_id WHERE a.installation_id = ?1 AND a.target_type = 'member'
        AND (a.action = 'attendance.member_setting_updated' OR (a.action = 'roster.member_updated' AND json_valid(a.metadata_json) AND json_type(a.metadata_json, '$.attendanceRequiredFrom') IS NOT NULL
          AND json_extract(a.metadata_json, '$.attendanceRequiredFrom') IS NOT substr(e.created_at, 1, 10)))) AS edited
    FROM members m WHERE m.installation_id = ?1 AND m.id > ?2 AND m.attendance_required_from = substr(m.created_at, 1, 10) ORDER BY m.id LIMIT ?3`).bind(installation, cursor, limit).all<Candidate>()).results ?? [];
  const changes: StartCorrectionChange[] = []; const leftAlone: StartCorrectionChange[] = []; const instants = new Map<string, string>(); let worsened = 0, noEffect = 0;
  const assess: { row: Candidate; to: string }[] = [];
  for (const row of candidates) {
    const to = correctedParticipationStart(row, timeZone);
    if (!to) continue;
    if (row.edited) leftAlone.push({ id: row.id, memberId: row.memberId, from: row.attendanceRequiredFrom, to }); else assess.push({ row, to });
  }
  if (assess.length) {
    const policies = await candidatePolicies(db, timeZone, assess, options.now ? now() : undefined);
    for (const { row, to } of assess) {
      const effect = startCorrectionEffect({ id: row.id, memberId: row.memberId, firstName: row.firstName, lastName: row.lastName, active: row.active, inactivePeriodsJson: row.inactivePeriodsJson, attendanceRequiredFrom: row.attendanceRequiredFrom, rosterAddedAt: row.rosterAddedAt }, to, policies.get(row.id)!);
      if (effect.reason === "would_worsen") worsened += 1; else if (effect.reason === "no_effect") noEffect += 1;
      else { changes.push({ id: row.id, memberId: row.memberId, from: row.attendanceRequiredFrom, to, gained: effect.gained, dropped: effect.dropped }); instants.set(row.id, row.rosterAddedAt); }
    }
  }
  const complete = candidates.length < limit; const nextCursor = complete ? cursor : candidates[candidates.length - 1]!.id;
  const at = now(); const auditId = state?.auditId ?? crypto.randomUUID();
  const earlier = state ? list(state.changesJson) : [];
  const allChanges = [...earlier, ...changes]; const allLeftAlone = [...(state ? list(state.leftAloneJson) : []), ...leftAlone];
  const totals = { wouldWorsen: previous.wouldWorsen + worsened, noEffect: previous.noEffect + noEffect };
  // Every statement checks that the job is where this pass read it: the same run, at the same cursor. A second runner
  // on the same rows, or a pass that started before a restore began a new run, changes nothing.
  const here = "EXISTS (SELECT 1 FROM participation_start_correction s WHERE s.installation_id = ? AND s.run_id = ? AND s.cursor = ? AND s.completed_at IS NULL)";
  const position = [installation, runId, cursor];
  const audit = (changed: StartCorrectionChange[]): D1Statement[] => changed.length ? [db.prepare(`INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ?, ?, NULL, ?, 'installation', ?, ?, ? WHERE EXISTS (SELECT 1 FROM participation_start_correction s WHERE s.installation_id = ? AND s.run_id = ?) ON CONFLICT(id) DO UPDATE SET metadata_json = excluded.metadata_json`)
    .bind(auditId, installation, START_CORRECTION_ACTION, installation, JSON.stringify({ timeZone, corrected: changed.length, changes: changed, leftAlone: allLeftAlone, ...totals, complete }), at, installation, runId)] : [];
  const updates = changes.map((change) => db.prepare(`UPDATE members SET attendance_required_from = ? WHERE installation_id = ? AND id = ? AND attendance_required_from = ? AND created_at = ? AND ${here}`)
    .bind(change.to, installation, change.id, change.from, instants.get(change.id), ...position));
  const results = await db.batch([
    // Only a pass that found no run starts one; a restore that started one in between keeps its own run id.
    db.prepare("INSERT OR IGNORE INTO participation_start_correction (installation_id, run_id, started_at) VALUES (?, ?, ?)").bind(installation, runId, at),
    ...updates,
    // The entry is written before the cursor moves, so its own check still finds the job where the pass read it.
    ...(allChanges.length ? [db.prepare(`INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ?, ?, NULL, ?, 'installation', ?, ?, ? WHERE ${here} ON CONFLICT(id) DO UPDATE SET metadata_json = excluded.metadata_json`)
      .bind(auditId, installation, START_CORRECTION_ACTION, installation, JSON.stringify({ timeZone, corrected: allChanges.length, changes: allChanges, leftAlone: allLeftAlone, ...totals, complete }), at, ...position)] : []),
    db.prepare("UPDATE participation_start_correction SET cursor = ?, examined = examined + ?, changes_json = ?, left_alone_json = ?, worsened = ?, no_effect = ?, audit_id = ?, completed_at = ? WHERE installation_id = ? AND run_id = ? AND cursor = ? AND completed_at IS NULL")
      .bind(nextCursor, candidates.length, JSON.stringify(allChanges), JSON.stringify(allLeftAlone), totals.wouldWorsen, totals.noEffect, allChanges.length ? auditId : null, complete ? at : null, ...position),
  ]);
  const outcome = (corrected: number): StartCorrectionResult => ({ status: complete ? "complete" : "progress", more: !complete, corrected, leftAlone: allLeftAlone.length, ...totals });
  // Another runner moved the job first, or a restore began a new run: every statement above did nothing.
  if (results[results.length - 1]?.meta?.changes !== 1) return { status: "raced", more: true, ...previous };
  // A start date edited between this pass's read and its write was not changed; record what was.
  const applied = changes.filter((_, index) => results[1 + index]?.meta?.changes === 1);
  if (applied.length !== changes.length) {
    const really = [...earlier, ...applied];
    const entry = really.length ? audit(really) : [db.prepare("DELETE FROM audit_log WHERE id = ? AND action = ?").bind(auditId, START_CORRECTION_ACTION)];
    await db.batch([...entry, db.prepare("UPDATE participation_start_correction SET changes_json = ?, audit_id = ? WHERE installation_id = ? AND run_id = ?").bind(JSON.stringify(really), really.length ? auditId : null, installation, runId)]);
    return outcome(really.length);
  }
  return outcome(allChanges.length);
}

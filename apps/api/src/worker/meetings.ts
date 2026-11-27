import { meetingDeletion, restoreMeetingDeletion } from "../meeting-deletion.ts";
import { runMeetingImport } from "../meeting-import.ts";
import { calendarLifecycleQueue, calendarTargets } from "../calendar-queue.ts";
import { attendanceClosesAt, attendanceWindow, DEFAULT_EARLY_SCAN_MINUTES, overlappingMeetingWindows, type MeetingWindowLike } from "../attendance-lifecycle.ts";
import { attendanceAllowances, meetingWindowLabel, savedAttendanceAllowances, type AttendanceAllowances } from "../attendance-allowances.ts";
import { guardedMeetingBatch, meetingOverlapGuard } from "../meeting-overlap-guard.ts";
import { type D1Database, type D1Result, type D1Statement } from "../d1-usage.ts";
import { meetingChangeImpact } from "../attendance-impact.ts";
import { HttpError } from "../http-error.ts";
import { type Env, type MeetingInput, type RecurrenceFrequency, authorizedRead, parseJson, previewResponse, requireDatabase, requireRole, response, sha256Hex, validTimeZone, validTimestamp, writeAudit } from "./core.ts";
import { discordCalendarIsReady } from "./discord-calendar.ts";
import { retractDiscordAttendanceNotices } from "./discord-notifications.ts";
import { googleCalendarEventId, googleCalendarIsReady } from "./google-calendar.ts";
import { meetingAudienceIds, resolveAudience } from "./meeting-audience.ts";
import { type MeetingWeightAssignment, resolveMeetingWeightAssignment } from "./meeting-weights.ts";
import { policyData, policyStateDigest } from "./policy-data.ts";

function validateMeetingInput(input: MeetingInput): asserts input is MeetingInput & { title: string; startsAt: string; endsAt: string } {
  if (!input.title?.trim() || input.title.length > 120 || (input.notes?.length ?? 0) > 2_000 || !validTimestamp(input.startsAt) || !validTimestamp(input.endsAt ?? undefined) || Date.parse(input.endsAt!) <= Date.parse(input.startsAt!)) throw new HttpError(400, "Meeting needs a title, valid start and end times, an end after its start, and optional notes under 2,000 characters");
  // Any time Date.parse accepts is stored in one canonical form (UTC with milliseconds, as toISOString writes it), so SQL
  // text comparisons and ORDER BY on starts_at and ends_at follow time. An offset or a missing ".000" would not.
  input.startsAt = new Date(input.startsAt!).toISOString(); input.endsAt = new Date(input.endsAt!).toISOString();
}
type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number };
function localParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: value.year, month: value.month, day: value.day, hour: value.hour, minute: value.minute, second: value.second, millisecond: date.getUTCMilliseconds() };
}
function localDate(parts: DateParts, timeZone: string): Date {
  const intended = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond); let candidate = intended;
  for (let iteration = 0; iteration < 3; iteration += 1) { const actual = localParts(new Date(candidate), timeZone); const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, actual.millisecond); candidate += intended - represented; }
  return new Date(candidate);
}
function nextOccurrence(current: Date, frequency: RecurrenceFrequency, anchorDay: number, timeZone: string): Date {
  const parts = localParts(current, timeZone); const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond));
  if (frequency === "monthly") { calendar.setUTCDate(1); calendar.setUTCMonth(calendar.getUTCMonth() + 1); const lastDay = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, 0)).getUTCDate(); calendar.setUTCDate(Math.min(anchorDay, lastDay)); }
  else calendar.setUTCDate(calendar.getUTCDate() + (frequency === "daily" ? 1 : frequency === "weekly" ? 7 : 14));
  return localDate({ year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(), hour: calendar.getUTCHours(), minute: calendar.getUTCMinutes(), second: calendar.getUTCSeconds(), millisecond: calendar.getUTCMilliseconds() }, timeZone);
}
function meetingOccurrences(input: MeetingInput & { startsAt: string; endsAt: string }, timeZone = "UTC") {
  if (!input.recurrence) return [{ startsAt: input.startsAt, endsAt: input.endsAt, sequence: null as number | null }];
  const frequency = input.recurrence.frequency; const until = input.recurrence.until;
  if (!frequency || !["daily", "weekly", "biweekly", "monthly"].includes(frequency) || !validTimestamp(until) || Date.parse(until) < Date.parse(input.startsAt)) throw new HttpError(400, "Recurring meetings need a valid frequency and series end date after the first meeting");
  // Every occurrence keeps the first meeting's clock times, so an overnight meeting still ends at the same local time after a daylight-saving change.
  // A clock end that would land at or before its start (inside a repeated hour) keeps the first meeting's elapsed length instead.
  const clock = (date: Date) => { const parts = localParts(date, timeZone); return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond); };
  const span = clock(new Date(input.endsAt)) - clock(new Date(input.startsAt));
  const endFor = (start: Date) => { if (start.getTime() === Date.parse(input.startsAt)) return new Date(input.endsAt); const end = new Date(clock(start) + span); const local = localDate({ year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, day: end.getUTCDate(), hour: end.getUTCHours(), minute: end.getUTCMinutes(), second: end.getUTCSeconds(), millisecond: end.getUTCMilliseconds() }, timeZone); return local > start ? local : new Date(start.getTime() + Date.parse(input.endsAt) - Date.parse(input.startsAt)); };
  const limit = Date.parse(until); const anchorDay = localParts(new Date(input.startsAt), timeZone).day; const occurrences = []; let start = new Date(input.startsAt);
  while (start.getTime() <= limit && occurrences.length < 500) { occurrences.push({ startsAt: start.toISOString(), endsAt: endFor(start).toISOString(), sequence: occurrences.length + 1 }); start = nextOccurrence(start, frequency, anchorDay, timeZone); }
  if (start.getTime() <= limit) throw new HttpError(400, "Recurring series is too large; shorten the date range to 500 meetings or fewer");
  return occurrences;
}
// Meeting times are saved canonically (validateMeetingInput), but meetings saved earlier may hold an offset or no milliseconds,
// so the SQL bound compares text with a day of margin on each side (keeping the starts_at index) and the exact window
// comparison stays in overlappingMeetingWindows.
const meetingOverlapMarginMs = 24 * 60 * 60_000;
async function assertNoMeetingOverlap(db: D1Database, proposed: MeetingWindowLike[], allowances: AttendanceAllowances, excludedIds: string[] = []): Promise<void> {
  // Only existing meetings whose attendance window (early arrival through late scans) can reach the proposed range are read.
  const windows = proposed.map((meeting) => attendanceWindow(meeting, allowances.lateScanMinutes, allowances.earlyScanMinutes));
  const bounded = windows.length > 0 && windows.every((window) => Number.isFinite(window.opens) && Number.isFinite(window.closes));
  const existing = bounded
    ? await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL AND starts_at <= ? AND (ends_at IS NULL OR ends_at >= ?)")
      .bind(new Date(Math.max(...windows.map((window) => window.closes)) + allowances.earlyScanMinutes * 60_000 + meetingOverlapMarginMs).toISOString(), new Date(Math.min(...windows.map((window) => window.opens)) - allowances.lateScanMinutes * 60_000 - meetingOverlapMarginMs).toISOString()).all<MeetingWindowLike>()
    : await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL").all<MeetingWindowLike>();
  // Only a conflict with a proposed meeting refuses the save: existing meetings saved before the early arrival allowance
  // existed may already overlap each other, and editing an unrelated meeting must not be blocked by them.
  const excluded = new Set(excludedIds); const proposedSet = new Set<MeetingWindowLike>(proposed);
  const conflict = overlappingMeetingWindows([...(existing.results ?? []).filter((meeting) => meeting.endsAt && !excluded.has(meeting.id ?? "")), ...proposed], allowances.lateScanMinutes, allowances.earlyScanMinutes, (meeting) => proposedSet.has(meeting));
  if (!conflict) return;
  throw new HttpError(409, `Meeting attendance windows cannot overlap. ${meetingWindowLabel(conflict[0])} conflicts with ${meetingWindowLabel(conflict[1])}.`);
}
/** A write's overlap guard aborted it, yet the route's check found no conflict again: the meeting it met was moved or deleted since. */
const meetingOverlapRaced = () => new HttpError(409, "Meeting attendance windows cannot overlap. Another change to the meetings was saved at the same time; reload and try again.");
export async function meetings(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") { const [, [result, settings, audiences]] = await authorizedRead(request, env, ["admin", "operator"], async () => { const db = requireDatabase(env); return Promise.all([db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, notes, is_test AS isTest, series_id AS seriesId, recurrence_frequency AS recurrenceFrequency, recurrence_until AS recurrenceUntil, recurrence_sequence AS recurrenceSequence, weight_category_id AS weightCategoryId, weight_category_name AS weightCategoryName, attendance_weight AS attendanceWeight, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL ORDER BY starts_at DESC LIMIT 1000").all<{ id: string; title: string; startsAt: string; endsAt: string; required: number; notes?: string; isTest: number; seriesId?: string; recurrenceFrequency?: RecurrenceFrequency; recurrenceUntil?: string; recurrenceSequence?: number; weightCategoryId?: string; weightCategoryName?: string; attendanceWeight: number; audienceMode: "all" | "labels" }>(), db.prepare("SELECT late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes, attendance_reporting_starts_on AS attendanceReportingStartsOn, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number; earlyScanMinutes?: number; attendanceReportingStartsOn?: string; timeZone?: string }>(), meetingAudienceIds(db)]); }); return response({ meetings: (result.results ?? []).map((meeting) => ({ ...meeting, attendanceWeight: Number(meeting.attendanceWeight ?? 1), audienceLabelIds: audiences.get(meeting.id) ?? [], attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30) })), lateScanMinutes: settings?.lateScanMinutes ?? 30, earlyScanMinutes: settings?.earlyScanMinutes ?? DEFAULT_EARLY_SCAN_MINUTES, attendanceReportingStartsOn: settings?.attendanceReportingStartsOn ?? null, timeZone: settings?.timeZone ?? "UTC" }); }
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<MeetingInput>(request); validateMeetingInput(input); const settings = await db.prepare("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone?: string; lateScanMinutes?: number; earlyScanMinutes?: number }>(); const occurrences = meetingOccurrences(input, settings?.timeZone && validTimeZone(settings.timeZone) ? settings.timeZone : "UTC"); await assertNoMeetingOverlap(db, occurrences.map((occurrence) => ({ ...occurrence, title: input.title })), attendanceAllowances(settings)); const assignment = await resolveMeetingWeightAssignment(db, input.weightCategoryId, input.startsAt, input.endsAt); const seriesId = input.recurrence ? crypto.randomUUID() : null; const now = new Date().toISOString(); const ids = occurrences.map(() => crypto.randomUUID());
  const audience = await resolveAudience(db, input);
  const statements = occurrences.map((occurrence, index) => db.prepare("INSERT INTO meetings (id, installation_id, title, starts_at, ends_at, required, notes, created_by, created_at, is_test, series_id, recurrence_frequency, recurrence_until, recurrence_sequence, weight_category_id, weight_category_name, attendance_weight, audience_mode) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)").bind(ids[index], input.title.trim(), occurrence.startsAt, occurrence.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, principal.userId, now, seriesId, input.recurrence?.frequency ?? null, input.recurrence?.until ?? null, occurrence.sequence, assignment?.id ?? null, assignment?.name ?? null, assignment?.weight ?? 1, audience.mode));
  for (const id of ids) for (const labelId of audience.labelIds) statements.push(db.prepare("INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) VALUES ('primary', ?, ?)").bind(id, labelId));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting.created', 'meeting', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, ids[0], JSON.stringify({ seriesId, occurrences: occurrences.length, frequency: input.recurrence?.frequency ?? null, weightCategoryId: assignment?.id ?? null, attendanceWeight: assignment?.weight ?? 1, audience }), now));
  // Calendar work is queued in the same batch as the meetings, for the scheduled calendar jobs to deliver.
  const calendar = calendarLifecycleQueue(db, "sync", calendarTargets.ids(ids), principal.userId, now);
  // The overlap check is repeated in the batch, with the allowances saved then, so a meeting another request saved since the
  // check, or longer allowances saved since it, refuses this one.
  const proposed = occurrences.map((occurrence) => ({ ...occurrence, title: input.title })); const guard = meetingOverlapGuard(db, proposed);
  const batch = [...guard ? [guard] : [], ...statements, ...calendar.statements]; const calendarOffset = batch.length - calendar.statements.length;
  const calendarDelivery = calendar.summary(await guardedMeetingBatch(() => db.batch(batch), async () => assertNoMeetingOverlap(db, proposed, await savedAttendanceAllowances(db)), meetingOverlapRaced), calendarOffset);
  const created = occurrences.map((occurrence, index) => ({ id: ids[index], title: input.title!.trim(), ...occurrence, required: input.required !== false, notes: input.notes?.trim() || null, seriesId, recurrenceFrequency: input.recurrence?.frequency ?? null, recurrenceUntil: input.recurrence?.until ?? null, recurrenceSequence: occurrence.sequence, weightCategoryId: assignment?.id ?? null, weightCategoryName: assignment?.name ?? null, attendanceWeight: assignment?.weight ?? 1, audienceMode: audience.mode, audienceLabelIds: audience.labelIds }));
  return response({ meeting: created[0], meetings: created, seriesId, calendarSync: calendarDelivery.google_calendar, calendarDelivery }, 201);
}
export async function meetingDetail(request: Request, env: Env, meetingId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const [meeting, settings, audiences] = await Promise.all([
    db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, notes, is_test AS isTest, series_id AS seriesId, recurrence_frequency AS recurrenceFrequency, recurrence_until AS recurrenceUntil, recurrence_sequence AS recurrenceSequence, weight_category_id AS weightCategoryId, weight_category_name AS weightCategoryName, attendance_weight AS attendanceWeight, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ id: string; title: string; startsAt: string; endsAt: string; required: number; notes?: string; isTest: number; seriesId?: string; recurrenceFrequency?: RecurrenceFrequency; recurrenceUntil?: string; recurrenceSequence?: number; weightCategoryId?: string; weightCategoryName?: string; attendanceWeight: number; audienceMode: "all" | "labels" }>(),
    db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number }>(),
    meetingAudienceIds(db, [meetingId]),
  ]);
  if (!meeting) throw new HttpError(404, "Meeting not found");
  return response({ meeting: { ...meeting, audienceLabelIds: audiences.get(meetingId) ?? [], attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30) } });
}
export async function meetingTemplates(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const result = await db.prepare("SELECT id, name, title, start_time AS startTime, duration_minutes AS durationMinutes, required, notes, recurrence_frequency AS recurrenceFrequency, recurrence_duration_days AS recurrenceDurationDays, created_at AS createdAt, updated_at AS updatedAt FROM meeting_templates WHERE installation_id = 'primary' ORDER BY name COLLATE NOCASE LIMIT 200").all();
  return response({ templates: result.results ?? [] });
}
async function meetingImpactPreview(db: D1Database, meetingId: string, required: boolean, audience: { mode: "all" | "labels"; labelIds: string[] }) {
  const data = await policyData(db); const original = data.meetings.find((meeting) => meeting.id === meetingId);
  if (!original) throw new HttpError(404, "Meeting not found");
  const changed = Boolean(original.required) !== required || original.audienceMode !== audience.mode || [...original.audienceLabelIds].sort().join(",") !== [...audience.labelIds].sort().join(",");
  const completed = Date.parse(original.attendanceClosesAt) <= Date.now();
  const impact = changed && completed ? meetingChangeImpact(data, { ...original, required, audienceMode: audience.mode, audienceLabelIds: audience.labelIds }) : [];
  return { changed, completed, impact, previewToken: await sha256Hex(JSON.stringify({ state: await policyStateDigest(data), meetingId, required, audience })) };
}
export async function meetingImpact(request: Request, env: Env, meetingId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<MeetingInput>(request);
  const current = await db.prepare("SELECT required, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ required: number; audienceMode: "all" | "labels" }>();
  if (!current) throw new HttpError(404, "Meeting not found");
  const currentIds = (await meetingAudienceIds(db, [meetingId])).get(meetingId) ?? [];
  const audience = await resolveAudience(db, { audienceMode: input.audienceMode ?? current.audienceMode, audienceLabelIds: input.audienceLabelIds ?? currentIds }, currentIds);
  return previewResponse(await meetingImpactPreview(db, meetingId, input.required === undefined ? Boolean(current.required) : input.required, audience));
}
/**
 * The writes that save one meeting edit, shared by the meeting editor and CSV import so both store the same row, audience
 * and audit. `assignment` undefined keeps the current weight. Callers then retract stale Discord notices and sync calendars.
 */
function meetingUpdateStatements(db: D1Database, actorUserId: string, meetingId: string, input: MeetingInput & { title: string; startsAt: string; endsAt: string }, audience: { mode: "all" | "labels"; labelIds: string[] }, assignment: MeetingWeightAssignment | null | undefined, audit: Record<string, unknown>): D1Statement[] {
  const update = assignment === undefined
    ? db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0 WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title.trim(), input.startsAt, input.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, meetingId)
    : db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0, weight_category_id = ?, weight_category_name = ?, attendance_weight = ? WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title.trim(), input.startsAt, input.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, assignment?.id ?? null, assignment?.name ?? null, assignment?.weight ?? 1, meetingId);
  // The audience and audit writes apply only while the meeting is still live in this batch: a delete that lands between the
  // caller's read and this batch leaves the deleted meeting's audience (which a restore brings back) and the audit log alone.
  const live = "EXISTS (SELECT 1 FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL)";
  return [update, db.prepare(`DELETE FROM meeting_audience_labels WHERE installation_id = 'primary' AND meeting_id = ? AND ${live}`).bind(meetingId, meetingId), ...audience.labelIds.map((labelId) => db.prepare(`INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) SELECT 'primary', ?, ? WHERE ${live}`).bind(meetingId, labelId, meetingId)), db.prepare(`INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'meeting.updated', 'meeting', ?, ?, ? WHERE ${live}`).bind(crypto.randomUUID(), actorUserId, meetingId, JSON.stringify({ audience, ...audit, ...(assignment === undefined ? {} : { weightCategoryId: assignment?.id ?? null, attendanceWeight: assignment?.weight ?? 1 }) }), new Date().toISOString(), meetingId)];
}
export async function updateMeeting(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<MeetingInput>(request); validateMeetingInput(input);
  const current = await db.prepare("SELECT required, audience_mode AS audienceMode, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ required: number; audienceMode: "all" | "labels"; startsAt: string; endsAt: string }>();
  if (!current) throw new HttpError(404, "Meeting not found");
  const currentIds = (await meetingAudienceIds(db, [meetingId])).get(meetingId) ?? [];
  const audience = await resolveAudience(db, { ...input, audienceMode: input.audienceMode ?? current.audienceMode, audienceLabelIds: input.audienceLabelIds ?? currentIds }, currentIds);
  const historicalChange = Boolean(current.required) !== (input.required !== false) || current.audienceMode !== audience.mode || [...currentIds].sort().join(",") !== [...audience.labelIds].sort().join(",");
  const impact = historicalChange ? await meetingImpactPreview(db, meetingId, input.required !== false, audience) : { changed: false, completed: false, impact: [], previewToken: "" };
  if (impact.changed && impact.completed && input.impactToken !== impact.previewToken) throw new HttpError(409, "Preview and confirm the historical attendance impact before saving this meeting");
  // Only a meeting whose times change is checked for overlap. Meetings saved before the early arrival allowance existed may
  // already overlap a neighbour, and editing their title, notes, requirement or audience must still save.
  const rescheduled = Date.parse(current.startsAt) !== Date.parse(input.startsAt) || Date.parse(current.endsAt) !== Date.parse(input.endsAt);
  const moved = [{ id: meetingId, title: input.title, startsAt: input.startsAt, endsAt: input.endsAt }]; let allowances: AttendanceAllowances | undefined;
  if (rescheduled) {
    allowances = attendanceAllowances(await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<Partial<AttendanceAllowances>>());
    await assertNoMeetingOverlap(db, moved, allowances, [meetingId]);
  }
  const assignment = input.weightCategoryId === undefined ? undefined : await resolveMeetingWeightAssignment(db, input.weightCategoryId, input.startsAt, input.endsAt);
  // The calendar update is queued in the same batch as the edit, so it cannot be lost to whatever the request does next.
  // A reschedule repeats its overlap check in the batch, so a meeting another request moved there since refuses this one.
  const guard = allowances && meetingOverlapGuard(db, moved, [meetingId]);
  const statements = [...guard ? [guard] : [], ...meetingUpdateStatements(db, principal.userId, meetingId, input, audience, assignment, { historicalImpact: impact.completed && impact.changed ? impact.impact : [] })]; const calendar = calendarLifecycleQueue(db, "sync", calendarTargets.ids([meetingId]), principal.userId);
  const calendarDelivery = calendar.summary(await guardedMeetingBatch(() => db.batch([...statements, ...calendar.statements]), async () => assertNoMeetingOverlap(db, moved, await savedAttendanceAllowances(db), [meetingId]), meetingOverlapRaced), statements.length);
  const discordNotices = historicalChange || rescheduled ? await retractDiscordAttendanceNotices(env, principal, [meetingId], 1) : [];
  return response({ discordNotices, meeting: { id: meetingId, title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt, required: input.required !== false, notes: input.notes?.trim() || null, audienceMode: audience.mode, audienceLabelIds: audience.labelIds, ...(assignment === undefined ? {} : { weightCategoryId: assignment?.id ?? null, weightCategoryName: assignment?.name ?? null, attendanceWeight: assignment?.weight ?? 1 }) }, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
// CSV import (meeting-import.ts) with the editor's validation, audience, weight and update helpers.
export async function meetingImport(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const result = await runMeetingImport(await parseJson(request), {
    db, actorUserId: principal.userId, validateMeeting: validateMeetingInput, validTimeZone,
    resolveAudience: (input, currentIds, catalog) => resolveAudience(db, input, currentIds, catalog),
    resolveWeight: (categoryId, startsAt, endsAt, categories) => resolveMeetingWeightAssignment(db, categoryId, startsAt, endsAt, categories),
    updateStatements: (meetingId, input, audience, assignment) => meetingUpdateStatements(db, principal.userId, meetingId, input, audience, assignment, { import: true }),
    calendarReady: async () => ({ google: await googleCalendarIsReady(env), discord: await discordCalendarIsReady(env) }), googleEventId: googleCalendarEventId,
    retractNotices: (meetingIds) => retractDiscordAttendanceNotices(env, principal, meetingIds),
  });
  // A dry run (the default) only checks the file, so it queues nothing for the scheduler.
  return result.dryRun ? previewResponse(result) : response(result);
}
export async function updateMeetingSeries(request: Request, env: Env, seriesId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<MeetingInput & { meetingId?: string }>(request); validateMeetingInput(input);
  if (!input.meetingId) throw new HttpError(400, "Choose the first occurrence to update");
  const anchor = await db.prepare("SELECT starts_at AS startsAt, ends_at AS endsAt, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND id = ? AND deleted_at IS NULL").bind(seriesId, input.meetingId).first<{ startsAt: string; endsAt: string; audienceMode: "all" | "labels" }>();
  if (!anchor) throw new HttpError(404, "Recurring series occurrence not found");
  if (Date.parse(anchor.endsAt) <= Date.now()) throw new HttpError(409, "Edit a completed occurrence individually to preview its historical impact");
  const anchorIds = (await meetingAudienceIds(db, [input.meetingId])).get(input.meetingId) ?? [];
  const audience = await resolveAudience(db, { ...input, audienceMode: input.audienceMode ?? anchor.audienceMode, audienceLabelIds: input.audienceLabelIds ?? anchorIds }, anchorIds);
  const future = await db.prepare("SELECT id, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? AND deleted_at IS NULL ORDER BY starts_at").bind(seriesId, anchor.startsAt).all<{ id: string; startsAt: string; endsAt: string }>();
  const duration = Date.parse(input.endsAt) - Date.parse(input.startsAt); const shift = Date.parse(input.startsAt) - Date.parse(anchor.startsAt); const proposed = (future.results ?? []).map((meeting) => { const start = new Date(Date.parse(meeting.startsAt) + shift); return { id: meeting.id, title: input.title, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duration).toISOString() }; });
  // Only occurrences whose times change are checked for overlap, as in updateMeeting; the others stay where they already were.
  const rescheduled = proposed.filter((meeting, index) => { const current = future.results![index]; return Date.parse(current.startsAt) !== Date.parse(meeting.startsAt) || Date.parse(current.endsAt) !== Date.parse(meeting.endsAt); });
  let allowances: AttendanceAllowances | undefined;
  if (rescheduled.length) {
    allowances = attendanceAllowances(await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<Partial<AttendanceAllowances>>());
    await assertNoMeetingOverlap(db, rescheduled, allowances, rescheduled.map((meeting) => meeting.id));
  }
  const assignment = input.weightCategoryId === undefined ? undefined : await resolveMeetingWeightAssignment(db, input.weightCategoryId, input.startsAt, input.endsAt);
  const statements = proposed.map((meeting) => assignment === undefined
    ? db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0 WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title!.trim(), meeting.startsAt, meeting.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, meeting.id)
    : db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0, weight_category_id = ?, weight_category_name = ?, attendance_weight = ? WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title!.trim(), meeting.startsAt, meeting.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, assignment?.id ?? null, assignment?.name ?? null, assignment?.weight ?? 1, meeting.id));
  if (!statements.length) throw new HttpError(404, "No future series occurrences were found");
  const updatedCount = statements.length;
  for (const meeting of proposed) { statements.push(db.prepare("DELETE FROM meeting_audience_labels WHERE installation_id = 'primary' AND meeting_id = ?").bind(meeting.id)); for (const labelId of audience.labelIds) statements.push(db.prepare("INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) VALUES ('primary', ?, ?)").bind(meeting.id, labelId)); }
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting.series_updated', 'meeting_series', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, seriesId, JSON.stringify({ fromMeetingId: input.meetingId, updated: updatedCount, audience, ...(assignment === undefined ? {} : { weightCategoryId: assignment?.id ?? null, attendanceWeight: assignment?.weight ?? 1 }) }), new Date().toISOString()));
  const calendar = calendarLifecycleQueue(db, "sync", calendarTargets.ids(proposed.map((meeting) => meeting.id)), principal.userId);
  // Rescheduled occurrences repeat their overlap check in the batch, as a single meeting's reschedule does.
  const guard = allowances && meetingOverlapGuard(db, rescheduled, rescheduled.map((meeting) => meeting.id));
  const batch = [...guard ? [guard] : [], ...statements, ...calendar.statements]; const calendarOffset = batch.length - calendar.statements.length;
  const calendarDelivery = calendar.summary(await guardedMeetingBatch(() => db.batch(batch), async () => assertNoMeetingOverlap(db, rescheduled, await savedAttendanceAllowances(db), rescheduled.map((meeting) => meeting.id)), meetingOverlapRaced), calendarOffset);
  const discordNotices = await retractDiscordAttendanceNotices(env, principal, proposed.map((meeting) => meeting.id), 1);
  return response({ seriesId, updated: updatedCount, discordNotices, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
export async function deleteMeetings(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ scope?: "occurrence" | "future" }>(request);
  const meeting = await db.prepare("SELECT id, series_id AS seriesId, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ id: string; seriesId?: string | null; startsAt: string }>();
  if (!meeting) throw new HttpError(404, "Meeting not found");
  const now = new Date().toISOString();
  if (input.scope === "future" && meeting.seriesId) {
    // The occurrences this statement deletes are the ones carrying this deletion time, which is how the calendar statements find them.
    const calendar = calendarLifecycleQueue(db, "delete", calendarTargets.seriesDeletedAt(meeting.seriesId, now), principal.userId, now);
    const results = await db.batch([db.prepare("UPDATE meetings SET deleted_at = ? WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? AND deleted_at IS NULL RETURNING id").bind(now, meeting.seriesId, meeting.startsAt), ...calendar.statements]);
    const updated = results[0] as D1Result<{ id: string }>; const calendarDelivery = calendar.summary(results, 1);
    const count = updated.results?.length ?? 0; if (count < 1) throw new HttpError(404, "No future series occurrences were found");
    await writeAudit(db, principal, "meeting.series_deleted", "meeting_series", meeting.seriesId, { fromMeetingId: meeting.id, deleted: count });
    const meetingIds = (updated.results ?? []).map((item) => item.id);
    return response({ deleted: count, scope: "future", deletion: { meetingIds, deletedAt: now }, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
  }
  const calendar = calendarLifecycleQueue(db, "delete", calendarTargets.deletedAt([meeting.id], now), principal.userId, now);
  const results = await db.batch([db.prepare("UPDATE meetings SET deleted_at = ? WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(now, meeting.id), ...calendar.statements]);
  if ((results[0]?.meta?.changes ?? 1) < 1) throw new HttpError(404, "Meeting not found");
  const calendarDelivery = calendar.summary(results, 1);
  await writeAudit(db, principal, "meeting.deleted", "meeting", meeting.id);
  return response({ deleted: 1, scope: "occurrence", deletion: { meetingIds: [meeting.id], deletedAt: now }, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
export async function bulkDeleteMeetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingIds?: string[]; confirmation?: string }>(request);
  const ids = [...new Set((input.meetingIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (!ids.length || ids.length > 100) throw new HttpError(400, "Select between 1 and 100 meetings");
  if (input.confirmation !== "DELETE SELECTED MEETINGS") throw new HttpError(400, "Type DELETE SELECTED MEETINGS exactly to continue");
  // One set-based delete with its calendar work, whatever the number of meetings selected.
  const now = new Date().toISOString(); const calendar = calendarLifecycleQueue(db, "delete", calendarTargets.deletedAt(ids, now), principal.userId, now);
  const results = await db.batch([db.prepare("UPDATE meetings SET deleted_at = ? WHERE installation_id = 'primary' AND deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) RETURNING id").bind(now, JSON.stringify(ids)), ...calendar.statements]);
  const changed = new Set(((results[0] as D1Result<{ id: string }>).results ?? []).map((row) => row.id)); const deletedIds = ids.filter((id) => changed.has(id)); const deleted = deletedIds.length; const calendarDelivery = calendar.summary(results, 1);
  await writeAudit(db, principal, "meetings.bulk_deleted", "meeting", null, { selected: ids.length, deleted }); return response({ deleted, deletion: deleted ? { meetingIds: deletedIds, deletedAt: now } : undefined, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
export async function rosterHistory(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]); const result = await requireDatabase(env).prepare("SELECT created_at AS createdAt, metadata_json AS metadata FROM audit_log WHERE installation_id = 'primary' AND action = 'roster.imported' ORDER BY created_at DESC LIMIT 20").all<{ createdAt: string; metadata: string }>();
  return response({ imports: (result.results ?? []).map((item) => { let metadata: { count?: number; mode?: string; deactivated?: number } = {}; try { metadata = JSON.parse(item.metadata); } catch { /* Historical audit metadata is optional. */ } return { createdAt: item.createdAt, count: metadata.count ?? 0, mode: metadata.mode ?? "merge", deactivated: metadata.deactivated ?? 0 }; }) });
}
export async function restoreMeetings(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ deletion?: unknown; scope?: "occurrence" | "future" | "selection" }>(request);
  const deletion = meetingDeletion(input.deletion, meetingId);
  // The restore and its calendar work are one batch: mappings are reactivated and upserts queued, or nothing is restored.
  const calendar = calendarLifecycleQueue(db, "restore", calendarTargets.ids(deletion.meetingIds), principal.userId);
  const calendarDelivery = calendar.summary(await restoreMeetingDeletion(db, deletion, calendar.statements), 0);
  await writeAudit(db, principal, input.scope === "future" ? "meeting.series_restored" : "meeting.restored", "meeting", meetingId, { restored: deletion.meetingIds.length, meetingIds: deletion.meetingIds });
  return response({ restored: deletion.meetingIds.length, scope: input.scope ?? "occurrence", calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
// Kiosk scans keep working on a schema from before migration 0099 (an upgrade that has not applied it yet): the early
// arrival allowance then takes its 15-minute default. Migrated schemas read both allowances in one query, as before.
// The same read carries the installation's time zone, which only a refused scan uses (scan-refusal.ts).
export async function scanAllowances(db: D1Database): Promise<AttendanceAllowances & { timeZone: string }> {
  type Row = Partial<AttendanceAllowances> & { timeZone?: string | null };
  const settings = (row: Row | null) => ({ ...attendanceAllowances(row), timeZone: row?.timeZone || "UTC" });
  try {
    return settings(await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<Row>());
  } catch (error) {
    if (!/no such column: early_scan_minutes/.test(error instanceof Error ? error.message : String(error))) throw error;
    return settings(await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<Row>());
  }
}

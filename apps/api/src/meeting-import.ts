// POST /meetings/import: CSV rows of attendance meetings, checked again here whatever the dashboard preview showed. A dry run
// classifies each row as add, update (a matching meeting, when the caller chose Update), skip or error; a commit writes every
// row that is not an error in one D1 batch with its calendar operations and one audit row.
//
// Budget (Workers Free: 10 ms CPU, 50 D1 queries with a batch counting once, 100 bound parameters per statement): rows are
// placed with one memoised zone clock, catalogs and the existing meetings in the file's date range are read once (with their
// audience, calendar mappings and Discord notice state), and calendar delivery is queued in the batch for the scheduled jobs
// rather than run inline; the jobs deliver a few per pass (5 Google, 3 Discord every five minutes) within their own budget. A commit makes about ten queries and at most one inline Discord notice retraction;
// a commit whose overlap guard finds another write got there first runs once more, about twenty in all.
import { attendanceClosesAt, DEFAULT_EARLY_SCAN_MINUTES } from "./attendance-lifecycle.ts";
import type { D1Database, D1Statement } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { discordCalendarDueSql } from "./calendar-queue.ts";
import { isMeetingOverlapAbort, meetingOverlapGuard } from "./meeting-overlap-guard.ts";
import { formatCsvDate, formatCsvTimeRange } from "../../../packages/shared/src/csv-import.ts";
import { meetingCsvCellLimit, meetingCsvClock, meetingCsvFields, meetingCsvRowLimit, resolveMeetingCsvRow, type MeetingCsvMeeting, type MeetingCsvRow } from "../../../packages/shared/src/meeting-csv.ts";

type Audience = { mode: "all" | "labels"; labelIds: string[] };
type Assignment = { id: string; name: string; weight: number };
type Category = Assignment & { active: number; minimumDurationMinutes: number | null; position: number };
type Label = { id: string; name: string; active: number };
type MeetingInput = { title: string; startsAt: string; endsAt: string; required?: boolean; notes?: string | null; audienceMode?: "all" | "labels"; audienceLabelIds?: string[] };
export type MeetingImportDeps = {
  db: D1Database; actorUserId: string; now?: number;
  validateMeeting: (input: MeetingInput) => void; validTimeZone: (timeZone: string) => boolean;
  resolveAudience: (input: MeetingInput, currentIds: string[], catalog: Label[]) => Promise<Audience>;
  resolveWeight: (categoryId: string | null | undefined, startsAt: string, endsAt: string, categories: Category[]) => Promise<Assignment | null>;
  updateStatements: (meetingId: string, input: MeetingInput, audience: Audience, assignment: Assignment | null | undefined) => D1Statement[];
  calendarReady: () => Promise<{ google: boolean; discord: boolean }>;
  googleEventId: (meetingId: string, generation: number) => Promise<string>;
  retractNotices: (meetingIds: string[]) => Promise<{ meetingId: string; outcome: string }[]>;
};
export type MeetingImportChange = "title" | "end time" | "attendance" | "audience" | "weight category" | "notes";
type Local = { title: string; date: string; startTime: string; endDate: string; endTime: string; required: boolean; audience: string[] };
export type MeetingImportRowResult = { rowNumber: number; action: "add" | "update" | "skip" | "error"; past: boolean; meeting?: Local; existing?: Local & { meetingId: string }; changes?: MeetingImportChange[]; error?: string };
type Existing = { id: string; title: string; startsAt: string; endsAt: string; required: number; notes: string | null; audienceMode: "all" | "labels"; weightCategoryId: string | null; audienceJson: string; googleEventId: string | null; googleActive: number | null; discordGeneration: number | null; discordActive: number | null; noticeStatus: string | null; noticeLive: number };
type Planned = { result: MeetingImportRowResult; meeting?: MeetingCsvMeeting; match?: Existing; input?: MeetingInput; audience?: Audience; assignment?: Assignment | null; historicalChange?: boolean };

const marginMs = 24 * 60 * 60_000 + 2 * 180 * 60_000;
const sameIds = (left: string[], right: string[]) => [...left].sort().join(",") === [...right].sort().join(",");

function requestRows(value: unknown): { rows: MeetingCsvRow[]; dryRun: boolean; actions: Record<string, "skip" | "update"> } {
  const input = value as { rows?: unknown; dryRun?: unknown; actions?: unknown } | null;
  const rows = input?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "Add at least one meeting row");
  if (rows.length > meetingCsvRowLimit) throw new HttpError(400, `Import no more than ${meetingCsvRowLimit} meetings at a time`);
  const numbers = new Set<number>();
  for (const row of rows as MeetingCsvRow[]) {
    const keys = row && typeof row.values === "object" && row.values ? Object.keys(row.values) : undefined;
    if (!Number.isInteger(row?.rowNumber) || row.rowNumber < 1 || row.rowNumber > 100_000 || numbers.has(row.rowNumber) || !keys || keys.some((key) => !meetingCsvFields.includes(key as never) || typeof (row.values as Record<string, unknown>)[key] !== "string" || ((row.values as Record<string, string>)[key]).length > meetingCsvCellLimit)) throw new HttpError(400, "Each meeting row needs a distinct row number and text cells for known columns");
    numbers.add(row.rowNumber);
  }
  const actions = (input?.actions ?? {}) as Record<string, unknown>;
  if (typeof actions !== "object" || Array.isArray(actions) || Object.values(actions).some((action) => action !== "skip" && action !== "update")) throw new HttpError(400, "Matching row actions must be skip or update");
  if (input?.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new HttpError(400, "dryRun must be true or false");
  return { rows: rows as MeetingCsvRow[], dryRun: input?.dryRun !== false, actions: actions as Record<string, "skip" | "update"> };
}

type MeetingImportResult = { dryRun: true; timeZone: string; rows: MeetingImportRowResult[]; summary: Record<string, number> } | Awaited<ReturnType<typeof commit>>;
export async function runMeetingImport(body: unknown, deps: MeetingImportDeps, retried = false): Promise<MeetingImportResult> {
  const { rows, dryRun, actions } = requestRows(body); const { db } = deps; const now = deps.now ?? Date.now();
  const settings = await db.prepare("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone?: string; lateScanMinutes?: number; earlyScanMinutes?: number }>();
  const timeZone = settings?.timeZone && deps.validTimeZone(settings.timeZone) ? settings.timeZone : "UTC"; const lateScanMs = (settings?.lateScanMinutes ?? 30) * 60_000; const earlyScanMs = (settings?.earlyScanMinutes ?? DEFAULT_EARLY_SCAN_MINUTES) * 60_000;
  const clock = meetingCsvClock(timeZone);
  const planned: Planned[] = rows.map((row) => { const resolved = resolveMeetingCsvRow(row.values, clock); return resolved.meeting ? { result: { rowNumber: row.rowNumber, action: "add", past: Date.parse(resolved.meeting.endsAt) <= now }, meeting: resolved.meeting } : { result: { rowNumber: row.rowNumber, action: "error", past: false, error: resolved.errors.join(". ") } }; });
  const placed = planned.filter((plan) => plan.meeting);
  const starts = placed.map((plan) => Date.parse(plan.meeting!.startsAt)); const ends = placed.map((plan) => Date.parse(plan.meeting!.endsAt));
  // One read each: the existing meetings whose attendance window can reach the file's range, with what an update needs, and both catalogs.
  const [existingRows, labelRows, categoryRows] = await Promise.all([
    placed.length ? db.prepare(`SELECT m.id, m.title, m.starts_at AS startsAt, m.ends_at AS endsAt, m.required, m.notes, m.audience_mode AS audienceMode, m.weight_category_id AS weightCategoryId,
      (SELECT json_group_array(a.label_id) FROM meeting_audience_labels a WHERE a.installation_id = m.installation_id AND a.meeting_id = m.id) AS audienceJson,
      g.event_id AS googleEventId, g.active AS googleActive, d.generation AS discordGeneration, d.active AS discordActive, n.status AS noticeStatus,
      CASE WHEN n.status = 'delivered' AND n.message_id IS NOT NULL AND n.deleted_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?) THEN 1 ELSE 0 END AS noticeLive
      FROM meetings m LEFT JOIN google_calendar_event_mappings g ON g.installation_id = m.installation_id AND g.meeting_id = m.id LEFT JOIN discord_calendar_event_mappings d ON d.installation_id = m.installation_id AND d.meeting_id = m.id
      LEFT JOIN discord_attendance_notifications n ON n.installation_id = m.installation_id AND n.meeting_id = m.id
      WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.starts_at <= ? AND (m.ends_at IS NULL OR m.ends_at >= ?)`).bind(new Date(now).toISOString(), new Date(Math.max(...ends) + marginMs).toISOString(), new Date(Math.min(...starts) - marginMs).toISOString()).all<Existing>() : { results: [] as Existing[] },
    db.prepare("SELECT id, name, active FROM member_labels WHERE installation_id = 'primary'").all<Label>(),
    db.prepare("SELECT id, name, weight, active, minimum_duration_minutes AS minimumDurationMinutes, position FROM meeting_weight_categories WHERE installation_id = 'primary'").all<Category>(),
  ]);
  const existing = (existingRows.results ?? []).filter((meeting) => meeting.endsAt); const labels = labelRows.results ?? []; const categories = categoryRows.results ?? [];
  const labelName = new Map(labels.map((label) => [label.id, label.name]));
  const byName = <T extends { name: string; active: number }>(items: T[], name: string) => items.filter((item) => item.name.toLowerCase() === name.toLowerCase()).sort((left, right) => right.active - left.active)[0];
  const local = (title: string, startsAt: string, endsAt: string, required: boolean, audience: string[]): Local => { const start = clock.civil(Date.parse(startsAt)); const end = clock.civil(Date.parse(endsAt)); return { title, date: start.date, startTime: start.time, endDate: end.date, endTime: end.time, required, audience }; };
  const existingByKey = new Map<string, Existing>();
  for (const meeting of existing) { const start = clock.civil(Date.parse(meeting.startsAt)); existingByKey.set(`${start.date}|${start.time}|${meeting.title.trim().toLowerCase()}`, meeting); }
  const firstRow = new Map<string, number>();

  for (const plan of placed) {
    const meeting = plan.meeting!; const result = plan.result; const key = `${meeting.date}|${meeting.startTime}|${meeting.title.toLowerCase()}`;
    const fail = (error: string) => { result.action = "error"; result.error = error; };
    const audienceNames = meeting.audienceNames ?? []; const repeated = firstRow.get(key);
    const match = existingByKey.get(key); plan.match = match;
    const currentIds = match ? JSON.parse(match.audienceJson) as string[] : [];
    result.meeting = local(meeting.title, meeting.startsAt, meeting.endsAt, meeting.required ?? (match ? Boolean(match.required) : true), meeting.audienceNames ?? (match ? currentIds.map((id) => labelName.get(id) ?? "Unknown label") : []));
    if (match) result.existing = { meetingId: match.id, ...local(match.title, match.startsAt, match.endsAt, Boolean(match.required), currentIds.map((id) => labelName.get(id) ?? "Unknown label")) };
    if (repeated !== undefined) { fail(`Repeats row ${repeated}`); continue; }
    firstRow.set(key, result.rowNumber);
    const chosen: Label[] = [];
    for (const name of audienceNames) { const label = byName(labels, name); if (!label) { fail(`Unknown audience label ${name}`); break; } if (!label.active && !currentIds.includes(label.id)) { fail(`Audience label ${label.name} is retired`); break; } chosen.push(label); }
    if (result.action === "error") continue;
    if (meeting.audienceNames !== undefined) result.meeting.audience = chosen.map((label) => label.name);
    let categoryId: string | null | undefined;
    if (meeting.weightName) { const category = byName(categories, meeting.weightName); if (!category) { fail(`Unknown weight category ${meeting.weightName}`); continue; } if (!category.active) { fail(`Weight category ${category.name} is retired`); continue; } categoryId = category.id; }
    // A blank weight cell means automatic (by duration); an absent column keeps an existing meeting's weight.
    const input: MeetingInput = { title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt, required: meeting.required ?? (match ? Boolean(match.required) : true), notes: meeting.notes === undefined ? match?.notes ?? null : meeting.notes };
    if (meeting.audienceNames !== undefined) { input.audienceMode = chosen.length ? "labels" : "all"; input.audienceLabelIds = chosen.map((label) => label.id); }
    else if (match) { input.audienceMode = match.audienceMode; input.audienceLabelIds = currentIds; }
    try {
      deps.validateMeeting(input);
      plan.audience = await deps.resolveAudience(input, currentIds, labels);
      plan.assignment = match && meeting.weightName === undefined ? undefined : await deps.resolveWeight(categoryId, meeting.startsAt, meeting.endsAt, categories);
    } catch (error) { fail((error as Error).message); continue; }
    plan.input = input;
    if (!match) continue;
    const changes: MeetingImportChange[] = [];
    if (match.title !== meeting.title) changes.push("title");
    if (Date.parse(match.endsAt) !== Date.parse(meeting.endsAt)) changes.push("end time");
    if (Boolean(match.required) !== input.required) changes.push("attendance");
    if (match.audienceMode !== plan.audience.mode || !sameIds(currentIds, plan.audience.labelIds)) changes.push("audience");
    if (plan.assignment !== undefined && (plan.assignment?.id ?? null) !== match.weightCategoryId) changes.push("weight category");
    if ((match.notes ?? null) !== (input.notes ?? null)) changes.push("notes");
    result.changes = changes;
    plan.historicalChange = changes.includes("attendance") || changes.includes("audience");
    if (actions[String(result.rowNumber)] !== "update" || !changes.length) { result.action = "skip"; continue; }
    result.action = "update";
    // The editor previews attendance changes to a completed meeting before saving them; an import cannot, so it refuses them.
    if (plan.historicalChange && Date.parse(attendanceClosesAt(match.endsAt, settings?.lateScanMinutes ?? 30)) <= now) fail("Changes attendance or audience for a completed meeting. Edit it on its meeting page to review the impact");
  }

  // Attendance windows (start less the early arrival allowance to end plus late scans) may not overlap. As in the meeting
  // editor, only a row that adds a meeting or changes a meeting's times is checked: an update that leaves the times alone
  // keeps the window its meeting already has, even where that window overlaps a neighbour saved before the early arrival
  // allowance existed. Existing meetings are only compared with rows, never with each other, and an earlier row wins over
  // a later one.
  //
  // Every row is judged against the meetings and rows that will exist once the import is applied. A matched row keeps its
  // meeting's start, so the old and new windows of an update share their opening and one contains the other. The smaller
  // one is occupied whether or not the update is applied, so it always counts. An update that shortens its meeting only
  // frees time when it is applied, and it can only be refused by meetings that are already there; those are settled first,
  // each refusal returning the old window, until no further one is refused. Adds and updates that lengthen a meeting are
  // then placed in row order, and refusing one of those changes nothing for any other row.
  type Window = readonly [number, number];
  const windowOf = (startsAt: string, endsAt: string): Window => [Date.parse(startsAt) - earlyScanMs, Date.parse(endsAt) + lateScanMs];
  const hits = (left: Window, right: Window) => left[0] <= right[1] && right[0] <= left[1];
  // "Test Build Session (6:00–8:30 PM)", with the date when it is not the row's own.
  const describe = (title: string, startsAt: string, endsAt: string, rowDate: string) => { const start = clock.civil(Date.parse(startsAt)); const end = clock.civil(Date.parse(endsAt)); return `${title} (${start.date === rowDate ? "" : `${formatCsvDate(start.date)}, `}${formatCsvTimeRange(start.time, end.time)})`; };
  type Occupied = { window: Window; title: string; startsAt: string; endsAt: string; plan?: Planned };
  const refuse = (plan: Planned, other: Occupied) => { plan.result.action = "error"; plan.result.error = `Overlaps ${describe(other.title, other.startsAt, other.endsAt, plan.meeting!.date)}`; };
  const rescheduled = (plan: Planned) => plan.result.action === "update" && (Date.parse(plan.match!.startsAt) !== Date.parse(plan.meeting!.startsAt) || Date.parse(plan.match!.endsAt) !== Date.parse(plan.meeting!.endsAt));
  const moving = new Map(planned.filter(rescheduled).map((plan) => [plan.match!.id, plan]));
  const stays = (meeting: Existing): Occupied => ({ window: windowOf(meeting.startsAt, meeting.endsAt), title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt });
  const moves = (plan: Planned): Occupied => ({ window: windowOf(plan.meeting!.startsAt, plan.meeting!.endsAt), title: plan.meeting!.title, startsAt: plan.meeting!.startsAt, endsAt: plan.meeting!.endsAt, plan });
  const shortens = (plan: Planned) => { const before = windowOf(plan.match!.startsAt, plan.match!.endsAt); const after = windowOf(plan.meeting!.startsAt, plan.meeting!.endsAt); return before[0] <= after[0] && after[1] <= before[1]; };
  // What each existing meeting occupies: its new window while a shortening update stands, otherwise the window it has now.
  const slots = existing.map((meeting) => { const plan = moving.get(meeting.id); return { id: meeting.id, item: plan && shortens(plan) ? moves(plan) : stays(meeting) }; });
  const slotOf = new Map(slots.map((slot) => [slot.id, slot]));
  const occupant = (window: Window, ownId?: string) => slots.find((slot) => slot.id !== ownId && hits(window, slot.item.window))?.item;
  const shortening = slots.filter((slot) => slot.item.plan);
  for (let changed = true; changed;) {
    changed = false;
    for (const slot of shortening) {
      const plan = slot.item.plan; const other = plan && occupant(slot.item.window, slot.id);
      if (!plan || !other) continue;
      refuse(plan, other); slot.item = stays(plan.match!); changed = true;
    }
  }
  const accepted: Occupied[] = [];
  for (const plan of planned) {
    const lengthens = plan.result.action === "update" && moving.get(plan.match!.id) === plan && !shortens(plan);
    if (plan.result.action !== "add" && !lengthens) continue;
    const item = moves(plan);
    const other = occupant(item.window, plan.match?.id) ?? accepted.find((candidate) => hits(item.window, candidate.window));
    if (other) refuse(plan, other);
    else if (lengthens) slotOf.get(plan.match!.id)!.item = item;
    else accepted.push(item);
  }

  const results = planned.map((plan) => plan.result);
  const summary = { add: 0, update: 0, skip: 0, error: 0, past: results.filter((row) => row.past && (row.action === "add" || row.action === "update")).length };
  for (const row of results) summary[row.action] += 1;
  if (dryRun) return { dryRun: true, timeZone, rows: results, summary };
  const apply = planned.filter((plan) => plan.result.action === "add" || plan.result.action === "update");
  if (!apply.length) throw new HttpError(400, "No rows can be imported. Fix the file and preview again");
  // The commit repeats the overlap check for the windows it adds or moves (meetingOverlapGuard). When another write got
  // there first, such as the same file committed twice at once, nothing was written: the import runs once more against
  // the meetings now saved and answers as a commit sent after that write would, matching rows rather than adding them again.
  const guard = meetingOverlapGuard(db, apply.filter((plan) => !plan.match || rescheduled(plan)).map((plan) => plan.meeting!), [...moving.keys()]);
  try { return await commit(deps, apply, results, summary, now, guard); }
  catch (error) {
    if (!isMeetingOverlapAbort(error)) throw error;
    if (retried) throw new HttpError(409, "Meetings changed while this import was saved. Preview the file again");
    return runMeetingImport(body, deps, true);
  }
}

async function commit(deps: MeetingImportDeps, apply: Planned[], results: MeetingImportRowResult[], summary: Record<string, number>, now: number, guard: D1Statement | undefined) {
  const { db } = deps; const at = new Date(now).toISOString(); const statements: D1Statement[] = guard ? [guard] : []; const ready = await deps.calendarReady();
  const ids = new Map(apply.map((plan) => [plan, plan.match?.id ?? crypto.randomUUID()]));
  const google: { meetingId: string; eventId: string; startsAt: string; endsAt: string }[] = []; const googleMappings: { meetingId: string; eventId: string }[] = [];
  const discord: { meetingId: string; generation: number; startsAt: string }[] = []; const discordNew: string[] = []; const discordRegenerated: string[] = [];
  const retract: string[] = []; const expire: string[] = []; const skippedNotices: string[] = [];
  for (const plan of apply) {
    const id = ids.get(plan)!; const input = plan.input!; const audience = plan.audience!; const match = plan.match; const past = Date.parse(input.endsAt) <= now;
    if (!match) {
      const assignment = plan.assignment ?? null;
      statements.push(db.prepare("INSERT INTO meetings (id, installation_id, title, starts_at, ends_at, required, notes, created_by, created_at, is_test, series_id, recurrence_frequency, recurrence_until, recurrence_sequence, weight_category_id, weight_category_name, attendance_weight, audience_mode) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?)").bind(id, input.title.trim(), input.startsAt, input.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, deps.actorUserId, at, assignment?.id ?? null, assignment?.name ?? null, assignment?.weight ?? 1, audience.mode));
      for (const labelId of audience.labelIds) statements.push(db.prepare("INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) VALUES ('primary', ?, ?)").bind(id, labelId));
      if (past) skippedNotices.push(id);
    } else {
      statements.push(...deps.updateStatements(id, input, audience, plan.assignment));
      // As the editor does, a reschedule or an attendance change withdraws a live absence notice. One is withdrawn inline;
      // the rest expire now, so the scheduled cleanup deletes them and no new notice is posted.
      if (match.noticeLive && (plan.historicalChange || Date.parse(match.endsAt) !== Date.parse(input.endsAt))) (retract.length ? expire : retract).push(id);
      else if (past && !match.noticeStatus) skippedNotices.push(id);
    }
    if (match?.googleActive) google.push({ meetingId: id, eventId: match.googleEventId!, startsAt: input.startsAt, endsAt: input.endsAt });
    else if (!match?.googleEventId && ready.google) { const eventId = await deps.googleEventId(id, 1); googleMappings.push({ meetingId: id, eventId }); google.push({ meetingId: id, eventId, startsAt: input.startsAt, endsAt: input.endsAt }); }
    // Discord skips meetings that have ended, as its delivery job would.
    if (!past && match?.discordActive) discord.push({ meetingId: id, generation: Number(match.discordGeneration), startsAt: input.startsAt });
    else if (!past && ready.discord && match?.discordGeneration == null) { discordNew.push(id); discord.push({ meetingId: id, generation: 1, startsAt: input.startsAt }); }
    else if (!past && ready.discord) { discordRegenerated.push(id); discord.push({ meetingId: id, generation: Number(match!.discordGeneration) + 1, startsAt: input.startsAt }); }
  }
  // Imported meetings that have ended never get an automatic Discord absence notice.
  if (skippedNotices.length) statements.push(db.prepare("INSERT INTO discord_attendance_notifications (installation_id, meeting_id, status, attempts, updated_at, processed_at) SELECT 'primary', value, 'skipped', 0, ?, ? FROM json_each(?) WHERE true ON CONFLICT(installation_id, meeting_id) DO NOTHING").bind(at, at, JSON.stringify(skippedNotices)));
  if (expire.length) statements.push(db.prepare("UPDATE discord_attendance_notifications SET expires_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id IN (SELECT value FROM json_each(?)) AND status = 'delivered'").bind(at, at, JSON.stringify(expire)));
  // Calendar delivery is queued as the meeting editor queues it (calendar-queue.ts); the scheduled Google and Discord jobs deliver it.
  // A Discord upsert for a meeting beyond the 60-day horizon falls due when the meeting comes within range.
  if (googleMappings.length) statements.push(db.prepare("INSERT OR IGNORE INTO google_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) SELECT 'primary', json_extract(value, '$.meetingId'), json_extract(value, '$.eventId'), 1, 1, ? FROM json_each(?)").bind(at, JSON.stringify(googleMappings)));
  if (google.length) statements.push(db.prepare("INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) SELECT 'primary', json_extract(value, '$.meetingId'), json_extract(value, '$.eventId'), 'upsert', json_extract(value, '$.startsAt'), json_extract(value, '$.endsAt'), 'pending', 0, ?, ? FROM json_each(?) WHERE true ON CONFLICT(installation_id, event_id) DO UPDATE SET action = 'upsert', starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = 'pending', next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at").bind(at, at, JSON.stringify(google)));
  // Rows that only update a meeting are not covered by the overlap guard, so the same file committed twice at once writes
  // them twice. The meeting, Google and operation statements give the same result both times; these two are written, as
  // calendar-queue.ts writes them, so that they do as well: a mapping is added once and regenerated only while inactive.
  if (discordNew.length) statements.push(db.prepare("INSERT OR IGNORE INTO discord_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) SELECT 'primary', value, NULL, 1, 1, ? FROM json_each(?)").bind(at, JSON.stringify(discordNew)));
  if (discordRegenerated.length) statements.push(db.prepare("UPDATE discord_calendar_event_mappings SET event_id = NULL, generation = generation + 1, active = 1, synced_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND active = 0 AND meeting_id IN (SELECT value FROM json_each(?))").bind(at, JSON.stringify(discordRegenerated)));
  if (discord.length) statements.push(db.prepare("INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, starts_at, next_attempt_at, actor_user_id, updated_at) SELECT 'primary', json_extract(value, '$.meetingId'), json_extract(value, '$.generation'), 'upsert', NULL, 'pending', 0, json_extract(value, '$.startsAt'), " + discordCalendarDueSql("json_extract(value, '$.startsAt')", "(SELECT d.event_id FROM discord_calendar_event_mappings d WHERE d.installation_id = 'primary' AND d.meeting_id = json_extract(value, '$.meetingId') AND d.generation = json_extract(value, '$.generation'))") + ", ?, ? FROM json_each(?) WHERE true ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET revision = discord_calendar_operations.revision + 1, status = CASE WHEN discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > excluded.updated_at THEN 'processing' ELSE 'pending' END, next_attempt_at = CASE WHEN discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > excluded.updated_at THEN discord_calendar_operations.next_attempt_at ELSE excluded.next_attempt_at END, starts_at = excluded.starts_at, last_error = NULL, actor_user_id = COALESCE(excluded.actor_user_id, discord_calendar_operations.actor_user_id), updated_at = excluded.updated_at").bind(at, deps.actorUserId, at, JSON.stringify(discord)));
  const added = apply.filter((plan) => !plan.match).map((plan) => ids.get(plan)!); const updated = apply.filter((plan) => plan.match).map((plan) => ids.get(plan)!);
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meetings.imported', 'meeting', NULL, ?, ?)").bind(crypto.randomUUID(), deps.actorUserId, JSON.stringify({ ...summary, addedIds: added, updatedIds: updated, skippedNotices: skippedNotices.length, googleQueued: google.length, discordQueued: discord.length }), at));
  await db.batch(statements);
  const discordNotices = retract.length ? await deps.retractNotices(retract) : [];
  // A withdrawn notice for a meeting that has ended is replaced by a skipped one, so the absence job posts nothing new.
  const ended = discordNotices.filter((notice) => notice.outcome === "retracted" && Date.parse(apply.find((plan) => ids.get(plan) === notice.meetingId)!.input!.endsAt) <= now).map((notice) => notice.meetingId);
  if (ended.length) await db.prepare("INSERT INTO discord_attendance_notifications (installation_id, meeting_id, status, attempts, updated_at, processed_at) SELECT 'primary', value, 'skipped', 0, ?, ? FROM json_each(?) WHERE true ON CONFLICT(installation_id, meeting_id) DO NOTHING").bind(at, at, JSON.stringify(ended)).run();
  for (const plan of apply) if (!plan.match) plan.result.existing = undefined;
  return { dryRun: false, rows: results, summary, imported: { added: added.length, updated: updated.length, meetingIds: [...added, ...updated] }, calendar: { googleQueued: google.length, discordQueued: discord.length }, discordNotices: [...discordNotices, ...expire.map((meetingId) => ({ meetingId, outcome: "pending_deletion" }))] };
}

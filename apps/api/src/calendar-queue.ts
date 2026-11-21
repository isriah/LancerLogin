// Queues Google Calendar and Discord scheduled-event work for meetings as D1 statements, for the caller to run in the
// same db.batch as the meeting change: the change and its calendar work commit or fail together, and the request spends
// no subrequest on calendars however many meetings it touches. The scheduled jobs attendance.google-calendar and
// attendance.discord-calendar deliver what is queued here, a few operations per slice.
//
// Every statement is set-based over a target (a subquery that yields meeting ids) and checks in SQL whether the
// integration is enabled and verified, so a route runs the same statements with or without integrations and reads
// nothing first. A meeting's operations always take their event id and generation from its mapping row.
//
// Nothing is queued for an integration that is switched off or not verified, and its mappings are left as they are, so
// that Sync all can catch up once it is back: it queues every current and upcoming meeting, and the delete of every
// deleted meeting whose mapping still says its event is live. Operations already queued when an integration is switched
// off are settled by housekeeping as failed with a reason (calendarQueueUpkeep), not left pending.
//
// Delivery order: an operation queued by a meeting change is due at once (CALENDAR_DUE_NOW). Among those, deletes go
// first (they have no meeting start, and for Discord they free one of the server's 100 events), then upserts by meeting
// start, soonest first, whenever they were queued. Operations with a time of their own (a retry after a failure, a
// Discord upsert waiting for its meeting to come within 60 days, a delivery whose lease ran out) follow in the order
// they fall due, so a failing operation never holds back new work.
//
// How operations collapse before delivery:
// - Google keeps one operation per event id. A later upsert or delete of the same event overwrites the pending one, so
//   several edits deliver once, and a create followed by a delete delivers one delete (a 404 from Google counts as done).
// - Discord keeps one operation per meeting, generation and action. A later upsert bumps the pending one's revision. A
//   delete marks the meeting's undelivered upserts delivered, and queues a delete only when the mapping has an event id;
//   an upsert already in flight queues that delete itself when it finishes and finds the mapping inactive.
// - Restoring a deleted meeting gives its mapping a new generation, and for Google a new event id, so the delete of the
//   old event and the upsert of the new one never race for one remote event.
import type { D1Database, D1Result, D1Statement } from "./d1-usage.ts";

/** Discord caps a server at 100 scheduled events, so LancerLogin only creates events for meetings starting within 60 days. */
export const DISCORD_CALENDAR_HORIZON_DAYS = 60;
/** Delivered calendar operations, and failed ones nothing will retry for a meeting that is over, are removed after this long. */
export const CALENDAR_OPERATION_RETENTION_DAYS = 30;
/** A remote event removal the provider keeps refusing is tried this many times, spaced over about three days, then set aside. */
export const CALENDAR_REMOVAL_ATTEMPTS = 10;
/** The next_attempt_at of work that is due at once. Sorting before every real time, it puts new work ahead of retries. */
export const CALENDAR_DUE_NOW = "1970-01-01T00:00:00.000Z";

export type CalendarProvider = "google_calendar" | "discord";
export type CalendarQueueSummary = {
  google_calendar: { synced: number; queued: number; failed: number };
  discord: { synced: number; queued: number; skipped: number; failed: number; outcomes: { meetingId: string; title: string; status: "synced" | "queued" | "skipped" | "failed"; reason?: string }[] };
};
/** Statements for a batch, and how many operations they queued once the batch has run. */
export type CalendarQueue = { statements: D1Statement[]; queued: (results: readonly D1Result[], offset: number) => number };

type Fragment = { readonly sql: string; readonly values: readonly unknown[] };
/** A subquery that yields the ids of the meetings to queue work for. */
export type CalendarTarget = Fragment;
const bound = (value: unknown): Fragment => ({ sql: "?", values: [value] });
function statement(db: D1Database, ...parts: (string | Fragment)[]): D1Statement {
  let sql = ""; const values: unknown[] = [];
  for (const part of parts) { if (typeof part === "string") sql += part; else { sql += part.sql; values.push(...part.values); } }
  return db.prepare(sql).bind(...values);
}

export const calendarTargets = {
  /** These meetings. */
  ids: (meetingIds: readonly string[]): CalendarTarget => ({ sql: "SELECT value FROM json_each(?)", values: [JSON.stringify(meetingIds)] }),
  /** Those of these meetings that the batch deleted at `deletedAt`. */
  deletedAt: (meetingIds: readonly string[], deletedAt: string): CalendarTarget => ({ sql: "SELECT id FROM meetings WHERE installation_id = 'primary' AND deleted_at = ? AND id IN (SELECT value FROM json_each(?))", values: [deletedAt, JSON.stringify(meetingIds)] }),
  /** The occurrences of a series that the batch deleted at `deletedAt`. */
  seriesDeletedAt: (seriesId: string, deletedAt: string): CalendarTarget => ({ sql: "SELECT id FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND deleted_at = ?", values: [seriesId, deletedAt] }),
  /** Every meeting that is not deleted and has not ended: the current and upcoming ones. */
  upcoming: (now: string): CalendarTarget => ({ sql: "SELECT id FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL AND ends_at IS NOT NULL AND julianday(ends_at) >= julianday(?)", values: [now] }),
  /** Deleted meetings whose mapping still says their remote event is live (a delete that was never queued). */
  deletedButMapped: (provider: CalendarProvider): CalendarTarget => ({ sql: `SELECT x.meeting_id FROM ${provider === "discord" ? "discord" : "google"}_calendar_event_mappings x JOIN meetings xm ON xm.installation_id = x.installation_id AND xm.id = x.meeting_id WHERE x.installation_id = 'primary' AND x.active = 1 AND xm.deleted_at IS NOT NULL`, values: [] }),
};

const googleReady = "EXISTS (SELECT 1 FROM installations rx JOIN google_calendar_authorizations ra ON ra.installation_id = rx.id WHERE rx.id = 'primary' AND rx.google_calendar_enabled = 1 AND ra.verified_at IS NOT NULL)";
const discordReady = "EXISTS (SELECT 1 FROM encrypted_integrations ri JOIN installations rx ON rx.id = ri.installation_id WHERE ri.installation_id = 'primary' AND ri.provider = 'discord' AND rx.discord_enabled = 1 AND ri.verified_at IS NOT NULL)";
/** A new Google event id: `ll` and 48 hex digits, the shape googleCalendarEventId gives, valid as a Google event id. */
const newGoogleEventId = "'ll' || lower(hex(randomblob(24)))";
const sqlTimestamp = (julianDay: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${julianDay})`;

/**
 * When a queued Discord upsert is first due: at once, except that a meeting further out than the horizon with no event
 * yet waits until it comes within range, so the delivery job's scan of due operations does not read it. Binds `now` once.
 */
export const discordCalendarDueSql = (startsAt: string, eventId: string) => `CASE WHEN ${eventId} IS NULL AND julianday(${startsAt}) > julianday(?) + ${DISCORD_CALENDAR_HORIZON_DAYS} THEN ${sqlTimestamp(`julianday(${startsAt}) - ${DISCORD_CALENDAR_HORIZON_DAYS}`)} ELSE '${CALENDAR_DUE_NOW}' END`;
const discordLeased = (now: Fragment): Fragment => ({ sql: `discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > ${now.sql}`, values: now.values });
/**
 * What a queued Discord operation does to one already there: a newer revision, pending unless a delivery holds its lease.
 * lease_token is deliberately left: a row that still carries one was claimed by a delivery that never settled it (its
 * closing write did not run), so the event may already exist and the next delivery must look for it before creating one.
 */
export const discordRequeue = "revision = discord_calendar_operations.revision + 1, status = CASE WHEN discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > excluded.updated_at THEN 'processing' ELSE 'pending' END, next_attempt_at = CASE WHEN discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > excluded.updated_at THEN discord_calendar_operations.next_attempt_at ELSE excluded.next_attempt_at END, starts_at = excluded.starts_at, last_error = NULL, actor_user_id = COALESCE(excluded.actor_user_id, discord_calendar_operations.actor_user_id), updated_at = excluded.updated_at";

/**
 * Create or update the Google event of each target meeting that is not deleted, while Google Calendar is enabled and
 * verified. A meeting with no mapping gets one. A mapping left inactive on a meeting that is not deleted (a restore, or
 * an earlier restore that never finished) gets a new generation and event id. A re-queued operation starts its retry
 * count again.
 */
export function googleCalendarSyncStatements(db: D1Database, target: CalendarTarget, now: string): CalendarQueue {
  const at = bound(now);
  const statements = [
    statement(db, `UPDATE google_calendar_event_mappings SET event_id = ${newGoogleEventId}, generation = generation + 1, active = 1, synced_at = NULL, last_error = NULL, updated_at = `, at,
      " WHERE installation_id = 'primary' AND active = 0 AND meeting_id IN (", target, `) AND EXISTS (SELECT 1 FROM meetings m WHERE m.installation_id = 'primary' AND m.id = google_calendar_event_mappings.meeting_id AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL) AND ${googleReady}`),
    statement(db, `INSERT OR IGNORE INTO google_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) SELECT 'primary', m.id, ${newGoogleEventId}, 1, 1, `, at,
      " FROM meetings m WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL AND m.id IN (", target, `) AND NOT EXISTS (SELECT 1 FROM google_calendar_event_mappings g WHERE g.installation_id = 'primary' AND g.meeting_id = m.id) AND ${googleReady}`),
    statement(db, `INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) SELECT 'primary', g.meeting_id, g.event_id, 'upsert', m.starts_at, m.ends_at, 'pending', 0, '${CALENDAR_DUE_NOW}', `, at,
      " FROM google_calendar_event_mappings g JOIN meetings m ON m.installation_id = g.installation_id AND m.id = g.meeting_id WHERE g.installation_id = 'primary' AND g.active = 1 AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL AND g.meeting_id IN (", target,
      `) AND ${googleReady} ON CONFLICT(installation_id, event_id) DO UPDATE SET action = 'upsert', starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at`),
  ];
  return { statements, queued: (results, offset) => results[offset + 2]?.meta?.changes ?? 0 };
}

/**
 * Delete the Google event of each target meeting that has a mapping, and mark the mapping inactive. While Google
 * Calendar is off neither happens: the mapping stays active on its deleted meeting, which is how Sync all finds it later.
 */
export function googleCalendarDeleteStatements(db: D1Database, target: CalendarTarget, now: string): CalendarQueue {
  const at = bound(now);
  const statements = [
    statement(db, `INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) SELECT 'primary', g.meeting_id, g.event_id, 'delete', NULL, NULL, 'pending', 0, '${CALENDAR_DUE_NOW}', `, at,
      " FROM google_calendar_event_mappings g WHERE g.installation_id = 'primary' AND g.meeting_id IN (", target,
      `) AND ${googleReady} ON CONFLICT(installation_id, event_id) DO UPDATE SET action = 'delete', starts_at = NULL, ends_at = NULL, status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at`),
    statement(db, "UPDATE google_calendar_event_mappings SET active = 0, updated_at = ", at, " WHERE installation_id = 'primary' AND meeting_id IN (", target, `) AND ${googleReady}`),
  ];
  return { statements, queued: (results, offset) => results[offset]?.meta?.changes ?? 0 };
}

/**
 * Create or update the Discord event of each target meeting that is not deleted and has not ended, while Discord is
 * enabled and verified. Mappings are created and reactivated as for Google. A meeting that has already started and has
 * no event is not queued: Discord cannot schedule an event in the past. An upsert for a meeting beyond the 60-day
 * horizon with no event yet is queued to fall due when the meeting comes within range. A target meeting that has ended
 * (it was edited into the past) and still has an event gets that event deleted, since Discord would otherwise keep
 * showing it at its old time.
 */
export function discordCalendarSyncStatements(db: D1Database, target: CalendarTarget, now: string, actorUserId: string | null): CalendarQueue {
  const at = bound(now); const ready = ` AND ${discordReady}`;
  const current: Fragment = { sql: "m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL AND julianday(m.ends_at) >= julianday(?)", values: [now] };
  const currentMeeting: Fragment = { sql: `EXISTS (SELECT 1 FROM meetings m WHERE m.id = discord_calendar_event_mappings.meeting_id AND ${current.sql})`, values: current.values };
  const ended: CalendarTarget = { sql: `SELECT pm.id FROM meetings pm JOIN discord_calendar_event_mappings pd ON pd.installation_id = pm.installation_id AND pd.meeting_id = pm.id WHERE pm.installation_id = 'primary' AND pm.deleted_at IS NULL AND pm.ends_at IS NOT NULL AND julianday(pm.ends_at) < julianday(?) AND pd.active = 1 AND pd.event_id IS NOT NULL AND pm.id IN (${target.sql})`, values: [now, ...target.values] };
  const past = discordCalendarDeleteStatements(db, ended, now, actorUserId);
  const statements = [
    statement(db, "INSERT OR IGNORE INTO discord_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) SELECT 'primary', m.id, NULL, 1, 1, ", at, " FROM meetings m WHERE ", current, " AND m.id IN (", target, ")", ready),
    // A mapping about to be reactivated that still names an event keeps that event's delete queued.
    statement(db, `INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, actor_user_id, updated_at) SELECT 'primary', meeting_id, generation, 'delete', event_id, 'pending', 0, '${CALENDAR_DUE_NOW}', `, bound(actorUserId), ", ", at,
      " FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND active = 0 AND event_id IS NOT NULL AND meeting_id IN (", target, ") AND ", currentMeeting, ready,
      " ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET revision = discord_calendar_operations.revision + 1, status = 'pending', next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at WHERE discord_calendar_operations.status = 'failed'"),
    statement(db, "UPDATE discord_calendar_event_mappings SET event_id = NULL, generation = generation + 1, active = 1, synced_at = NULL, last_error = NULL, updated_at = ", at, " WHERE installation_id = 'primary' AND active = 0 AND meeting_id IN (", target, ") AND ", currentMeeting, ready),
    statement(db, `INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, starts_at, actor_user_id, updated_at) SELECT 'primary', d.meeting_id, d.generation, 'upsert', NULL, 'pending', 0, ${discordCalendarDueSql("m.starts_at", "d.event_id")}, m.starts_at, `, { sql: "", values: [now] }, bound(actorUserId), ", ", at,
      " FROM discord_calendar_event_mappings d JOIN meetings m ON m.id = d.meeting_id WHERE d.installation_id = 'primary' AND d.active = 1 AND (d.event_id IS NOT NULL OR julianday(m.starts_at) > julianday(?)) AND ", { sql: "", values: [now] }, current, " AND d.meeting_id IN (", target, `)${ready} ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET ${discordRequeue}`),
    ...past.statements,
  ];
  return { statements, queued: (results, offset) => (results[offset + 3]?.meta?.changes ?? 0) + past.queued(results, offset + 4) };
}

/**
 * Delete the Discord event of each target meeting, supersede its undelivered upserts and mark its mapping inactive.
 * While Discord is off none of it happens, as for Google.
 */
export function discordCalendarDeleteStatements(db: D1Database, target: CalendarTarget, now: string, actorUserId: string | null): CalendarQueue {
  const at = bound(now); const leased = discordLeased(at); const ready = ` AND ${discordReady}`;
  const statements = [
    statement(db, "UPDATE discord_calendar_operations SET revision = revision + 1, status = CASE WHEN ", leased, " THEN 'processing' ELSE 'delivered' END, next_attempt_at = CASE WHEN ", leased, " THEN next_attempt_at ELSE NULL END, last_error = NULL, updated_at = ", at,
      " WHERE installation_id = 'primary' AND action = 'upsert' AND status != 'delivered' AND meeting_id IN (", target, ")", ready),
    statement(db, `INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, starts_at, actor_user_id, updated_at) SELECT 'primary', d.meeting_id, d.generation, 'delete', d.event_id, 'pending', 0, '${CALENDAR_DUE_NOW}', NULL, `, bound(actorUserId), ", ", at,
      " FROM discord_calendar_event_mappings d WHERE d.installation_id = 'primary' AND d.event_id IS NOT NULL AND d.meeting_id IN (", target, `)${ready} ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET event_id = excluded.event_id, ${discordRequeue}`),
    statement(db, "UPDATE discord_calendar_event_mappings SET active = 0, updated_at = ", at, " WHERE installation_id = 'primary' AND meeting_id IN (", target, ")", ready),
  ];
  return { statements, queued: (results, offset) => results[offset + 1]?.meta?.changes ?? 0 };
}

/**
 * For Sync all: failed deletes are made due again (their events may still exist), so that with the two repairs the
 * routes already make, one Sync all catches up everything an outage or a switched-off integration left behind.
 */
export function calendarFailedDeleteRetry(db: D1Database, provider: CalendarProvider, now: string): D1Statement {
  return db.prepare(`UPDATE ${provider === "discord" ? "discord" : "google"}_calendar_operations SET status = 'pending', next_attempt_at = '${CALENDAR_DUE_NOW}', last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND action = 'delete' AND status = 'failed' AND ${provider === "discord" ? discordReady : googleReady}`).bind(now);
}
/** How many of a provider's operations are due now, for telling the user what is waiting. Returns one row, `waiting`. */
export function calendarWaitingCount(db: D1Database, provider: CalendarProvider, now: string): D1Statement {
  return db.prepare(`SELECT COUNT(*) AS waiting FROM ${provider === "discord" ? "discord" : "google"}_calendar_operations WHERE installation_id = 'primary' AND status != 'delivered' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?`).bind(now);
}

export type CalendarLifecycleAction = "sync" | "delete" | "restore";
/**
 * The calendar statements for one meeting change, for both providers, to append to the batch that makes the change.
 * `summary` reads the batch's results (the statements start at `offset`) and reports what was queued: nothing is
 * delivered by the request, so `synced` and `failed` are always 0. A restore queues what a sync does: its mappings are
 * inactive, and a sync reactivates those.
 */
export function calendarLifecycleQueue(db: D1Database, action: CalendarLifecycleAction, target: CalendarTarget, actorUserId: string | null, now = new Date().toISOString()): { statements: D1Statement[]; summary: (results: readonly D1Result[], offset: number) => CalendarQueueSummary } {
  const google = action === "delete" ? googleCalendarDeleteStatements(db, target, now) : googleCalendarSyncStatements(db, target, now);
  const discord = action === "delete" ? discordCalendarDeleteStatements(db, target, now, actorUserId) : discordCalendarSyncStatements(db, target, now, actorUserId);
  return {
    statements: [...google.statements, ...discord.statements],
    summary: (results, offset) => calendarQueueSummary(google.queued(results, offset), discord.queued(results, offset + google.statements.length)),
  };
}
export const calendarQueueSummary = (google: number, discord: number): CalendarQueueSummary => ({ google_calendar: { synced: 0, queued: google, failed: 0 }, discord: { synced: 0, queued: discord, skipped: 0, failed: 0, outcomes: [] } });

/**
 * Before meetings are deleted outright (Delete attendance data, restoring a meetings backup), record every remote event
 * that may still exist, because mappings and operations go with their meetings. One row per event in
 * calendar_event_removals (migration 0103), which has no meeting; the delivery jobs delete those events and then the
 * rows. Covers each provider's active mappings and its delete operations not yet delivered. `targets` names the calendar
 * and the server the events are on (as the caller identifies them), so a removal is never sent to a different one.
 * With `only: "pendingDeletes"` only the undelivered deletes are recorded: what disabling Attendance would otherwise
 * strand. `keep`, when given, is a JSON array of meeting ids whose mapped events are not removed. Run these in the batch
 * that deletes the meetings, before that statement. Migration 0103 must be applied, as for everything in this file.
 */
export function calendarRemovalStatements(db: D1Database, now: string, targets: { google_calendar?: string | null; discord?: string | null } = {}, options: { only?: "pendingDeletes"; keep?: string } = {}): D1Statement[] {
  const kept = options.keep === undefined ? "" : " AND meeting_id NOT IN (SELECT value FROM json_each(?))";
  const removal = (provider: CalendarProvider, source: string) => db.prepare(`INSERT OR IGNORE INTO calendar_event_removals (installation_id, provider, event_id, target, attempts, next_attempt_at, updated_at) SELECT 'primary', '${provider}', event_id, ?, 0, ?, ? FROM ${source}${kept}`).bind(targets[provider] ?? null, now, now, ...(options.keep !== undefined ? [options.keep] : []));
  return [
    ...(options.only ? [] : [removal("google_calendar", "google_calendar_event_mappings WHERE installation_id = 'primary' AND active = 1")]),
    removal("google_calendar", "google_calendar_operations WHERE installation_id = 'primary' AND action = 'delete' AND status != 'delivered'"),
    ...(options.only ? [] : [removal("discord", "discord_calendar_event_mappings WHERE installation_id = 'primary' AND event_id IS NOT NULL")]),
    removal("discord", "discord_calendar_operations WHERE installation_id = 'primary' AND action = 'delete' AND status != 'delivered' AND event_id IS NOT NULL"),
  ];
}
export type CalendarRemoval = { eventId: string; attempts: number; target: string | null };
/**
 * A delivery job's one read: its due operations and, in the same query, the provider's due event removals, so an idle
 * pass costs one D1 query per provider as before. `operationsSql` is the job's own query, complete with ORDER BY and
 * LIMIT, whose last columns must be `NULL AS removalAttempts, NULL AS removalTarget`; `removalColumns` lists a removal
 * row's values for the columns before those (alias `r`). Removals fill what the operations leave of `limit`.
 */
export async function dueCalendarWork<T extends { eventId?: string | null }>(db: D1Database, provider: CalendarProvider, operationsSql: string, values: readonly unknown[], removalColumns: string, limit: number, now: string): Promise<{ operations: T[]; removals: CalendarRemoval[] }> {
  type Row = T & { removalAttempts?: number | null; removalTarget?: string | null };
  const combined = `SELECT * FROM (${operationsSql}) UNION ALL SELECT * FROM (SELECT ${removalColumns}, r.attempts, r.target FROM calendar_event_removals r WHERE r.installation_id = 'primary' AND r.provider = '${provider}' AND r.next_attempt_at IS NOT NULL AND r.next_attempt_at <= ? ORDER BY r.next_attempt_at LIMIT ${limit})`;
  const rows = (await db.prepare(combined).bind(...values, now).all<Row>()).results ?? [];
  const operations = rows.filter((row) => row.removalAttempts == null);
  const removals = rows.filter((row) => row.removalAttempts != null).slice(0, Math.max(0, limit - operations.length)).map((row) => ({ eventId: String(row.eventId), attempts: Number(row.removalAttempts), target: row.removalTarget ?? null }));
  return { operations, removals };
}
/** The remote event is gone (deleted now, or already missing). */
export async function completeCalendarRemoval(db: D1Database, provider: CalendarProvider, removal: CalendarRemoval): Promise<void> {
  await db.prepare("DELETE FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = ? AND event_id = ?").bind(provider, removal.eventId).run();
}
const removalAudit = (db: D1Database, action: string, provider: CalendarProvider, metadata: unknown, now: string) => db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', NULL, ?, 'integration', ?, ?, ?)").bind(crypto.randomUUID(), action, provider, JSON.stringify(metadata), now);
/** When a refused removal is tried again: 15 minutes, doubling to a day at most, or later if the provider asks. */
export const calendarRemovalRetryAt = (attempts: number, retryAfterMs = 0, now = Date.now()) => new Date(now + Math.max(retryAfterMs, Math.min(86_400_000, 900_000 * 2 ** Math.max(0, attempts - 1)))).toISOString();
/**
 * The provider refused or could not be reached, whatever the reason: a missing permission or an expired authorization is
 * something an Admin can fix, so every failure is retried, CALENDAR_REMOVAL_ATTEMPTS times over about three days. After
 * the last attempt the removal is set aside, not deleted: it stays in the table with no next attempt and its error, the
 * integration card counts it as needing another attempt, a retry from the card makes it due again, and the audit log
 * records it. (An event that is already gone is not a failure: the caller completes the removal.)
 */
export async function failCalendarRemoval(db: D1Database, provider: CalendarProvider, removal: CalendarRemoval, message: string, retryAfterMs = 0): Promise<void> {
  const attempts = Number(removal.attempts ?? 0) + 1; const now = new Date().toISOString(); const error = message.slice(0, 300);
  const update = (retryAt: string | null) => db.prepare("UPDATE calendar_event_removals SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND provider = ? AND event_id = ?").bind(attempts, retryAt, error, now, provider, removal.eventId);
  if (attempts < CALENDAR_REMOVAL_ATTEMPTS) { await update(calendarRemovalRetryAt(attempts, retryAfterMs)).run(); return; }
  await db.batch([update(null), removalAudit(db, "calendar.event_removal_abandoned", provider, { eventId: removal.eventId, attempts, error }, now)]);
}
/** The removal was recorded for another calendar or server than the one now configured: it cannot be sent, so it is dropped and recorded. */
export async function dropCalendarRemoval(db: D1Database, provider: CalendarProvider, removal: CalendarRemoval): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([db.prepare("DELETE FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = ? AND event_id = ?").bind(provider, removal.eventId), removalAudit(db, "calendar.event_removal_abandoned", provider, { eventId: removal.eventId, attempts: removal.attempts, error: "The calendar or server this event is on is no longer the one configured" }, now)]);
}
/** A statement that makes every removal the card reports as needing another attempt due again, with a fresh allowance. */
export function calendarRemovalRetry(db: D1Database, provider: CalendarProvider, now: string): D1Statement {
  return db.prepare("UPDATE calendar_event_removals SET attempts = 0, next_attempt_at = ?, updated_at = ? WHERE installation_id = 'primary' AND provider = ? AND next_attempt_at IS NULL").bind(now, now, provider);
}
/**
 * When a provider is disconnected its events can no longer be reached, so its waiting removals are set aside (they no
 * longer count as waiting) with one audit entry for all of them. Reconnecting the same calendar or server and choosing
 * Sync all makes them due again. Run both statements in the batch that removes the connection.
 */
export function calendarRemovalDisconnectStatements(db: D1Database, provider: CalendarProvider, now: string): D1Statement[] {
  const reason = `${provider === "discord" ? "Discord" : "Google Calendar"} was disconnected before these events could be removed.`;
  return [
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', NULL, 'calendar.event_removal_abandoned', 'integration', ?, json_object('events', COUNT(*), 'error', ?), ? FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = ? AND next_attempt_at IS NOT NULL HAVING COUNT(*) > 0").bind(crypto.randomUUID(), provider, reason, now, provider),
    db.prepare("UPDATE calendar_event_removals SET next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND provider = ? AND next_attempt_at IS NOT NULL").bind(reason, now, provider),
  ];
}
/** The failed operations of a provider made due again: at once, or for a Discord upsert beyond the horizon when its meeting comes within range. */
export function calendarFailedRetry(db: D1Database, provider: CalendarProvider, now: string): D1Statement {
  return provider === "google_calendar"
    ? db.prepare(`UPDATE google_calendar_operations SET status = 'pending', next_attempt_at = '${CALENDAR_DUE_NOW}', last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND (status = 'failed' OR (status = 'pending' AND next_attempt_at IS NULL))`).bind(now)
    : db.prepare(`UPDATE discord_calendar_operations SET status = 'pending', next_attempt_at = CASE WHEN action = 'upsert' THEN ${discordCalendarDueSql("discord_calendar_operations.starts_at", "(SELECT d.event_id FROM discord_calendar_event_mappings d WHERE d.installation_id = 'primary' AND d.meeting_id = discord_calendar_operations.meeting_id AND d.generation = discord_calendar_operations.generation)")} ELSE '${CALENDAR_DUE_NOW}' END, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND status = 'failed'`).bind(now, now);
}
/**
 * What Sync all queues for one provider, for the batch that enables or verifies it as well: the delete of every deleted
 * meeting still mapped as live, failed deletes made due again, and an upsert for every current and upcoming meeting.
 * Run after the statement that turns the integration on, in the same batch: until it is on and verified they queue nothing.
 */
export function calendarCatchUp(db: D1Database, provider: CalendarProvider, now: string, actorUserId: string | null): { statements: D1Statement[]; queued: (results: readonly D1Result[], offset: number) => number; deletesQueued: (results: readonly D1Result[], offset: number) => number } {
  const repair = provider === "discord" ? discordCalendarDeleteStatements(db, calendarTargets.deletedButMapped("discord"), now, actorUserId) : googleCalendarDeleteStatements(db, calendarTargets.deletedButMapped("google_calendar"), now);
  const sync = provider === "discord" ? discordCalendarSyncStatements(db, calendarTargets.upcoming(now), now, actorUserId) : googleCalendarSyncStatements(db, calendarTargets.upcoming(now), now);
  const retryAt = repair.statements.length;
  return { statements: [...repair.statements, calendarFailedDeleteRetry(db, provider, now), ...sync.statements], queued: (results, offset) => sync.queued(results, offset + retryAt + 1), deletesQueued: (results, offset) => repair.queued(results, offset) + (results[offset + retryAt]?.meta?.changes ?? 0) };
}
/** Columns for a provider's queue status read: removals waiting, removals set aside, and the newest error among those. */
export const calendarRemovalStatusSql = (provider: CalendarProvider) => `(SELECT COUNT(*) FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = '${provider}' AND next_attempt_at IS NOT NULL) AS pendingRemovals, (SELECT COUNT(*) FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = '${provider}' AND next_attempt_at IS NULL) AS failedRemovals, (SELECT last_error FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = '${provider}' AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1) AS removalError`;

/**
 * Housekeeping statements that remove calendar operations nothing reads again, at most `limit` rows each:
 * - delivered operations whose last change is before `before` (30 days back);
 * - failed upserts with no retry scheduled, unchanged since `before`, whose meeting is deleted or ended before `before`.
 * Failed deletes stay until an Admin retries them, since their remote event may still exist. Mappings are kept: a
 * restored meeting needs its generation. Both use the (installation_id, status, next_attempt_at, updated_at) index.
 */
export function calendarOperationPruning(db: D1Database, before: string, limit: number): D1Statement[] {
  const delivered = (table: string) => db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE installation_id = 'primary' AND status = 'delivered' AND next_attempt_at IS NULL AND updated_at < ? ORDER BY updated_at LIMIT ?)`).bind(before, limit);
  const abandoned = (table: string) => db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT o.rowid FROM ${table} o WHERE o.installation_id = 'primary' AND o.status = 'failed' AND o.next_attempt_at IS NULL AND o.updated_at < ? AND o.action = 'upsert' AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.installation_id = o.installation_id AND m.id = o.meeting_id AND m.deleted_at IS NULL AND (m.ends_at IS NULL OR julianday(m.ends_at) >= julianday(?))) ORDER BY o.updated_at LIMIT ?)`).bind(before, before, limit);
  return [delivered("google_calendar_operations"), delivered("discord_calendar_operations"), abandoned("google_calendar_operations"), abandoned("discord_calendar_operations")];
}
export const CALENDAR_OFF_REASON = { google_calendar: "Google Calendar was switched off or is not verified. Turn it on, then choose Sync all meetings.", discord: "Discord was switched off or is not verified. Turn it on, then choose Sync all meetings." } as const;
/**
 * Housekeeping statements that keep the queues honest, in the same batch as the pruning:
 * - an operation that is due on an integration that is switched off or unverified is settled as failed with the reason
 *   above, so nothing stays due for a provider that will not take it (a Discord operation being delivered is left to
 *   finish, and one that is only waiting, for the 60-day horizon or for a retry time, is left until it falls due);
 * - a Discord operation left `processing` with no next attempt (the previous Worker claimed it after migration 0103
 *   ran) becomes due when its lease ends, so a delivery that died is picked up.
 */
export function calendarQueueUpkeep(db: D1Database, now: string): D1Statement[] {
  const settle = (table: string, provider: CalendarProvider, ready: string, extra = "") => db.prepare(`UPDATE ${table} SET status = 'failed', next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND status != 'delivered' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?${extra} AND NOT ${ready}`).bind(CALENDAR_OFF_REASON[provider], now, now);
  return [
    settle("google_calendar_operations", "google_calendar", googleReady),
    settle("discord_calendar_operations", "discord", discordReady, " AND status != 'processing'"),
    db.prepare("UPDATE discord_calendar_operations SET next_attempt_at = COALESCE(lease_expires_at, updated_at) WHERE installation_id = 'primary' AND status = 'processing' AND next_attempt_at IS NULL"),
  ];
}

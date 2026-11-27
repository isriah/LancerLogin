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
//   several edits deliver once. A delete is queued only for an event that may exist: one Google confirmed (the mapping's
//   synced_at), or one whose create last failed with an error that is retried. A meeting deleted before its create went
//   out, or after Google refused it for good, marks that create delivered and queues nothing; a create in flight queues
//   the delete itself when it finishes, or fails in a way that is retried, and finds the mapping inactive. A 404 from
//   Google on a delete counts as done.
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
 * Delete the Google event of each target meeting that may exist, and mark the mapping inactive. An event may exist when
 * Google confirmed it (synced_at), or when its create last failed with an error that is retried (status failed with a
 * next attempt: a 5xx, a network error or 429, after which Google may have made the event anyway); a 404 on the delete
 * then counts as done. Any other meeting whose event was never created (its create is still queued, or Google refused
 * it for good, as with an expired authorization) queues no delete, which could only fail while the create's problem
 * lasts and then wait for an Admin; its undelivered upsert is marked delivered instead, so it never creates an event for
 * a deleted meeting. An upsert already in flight queues the delete itself when it finishes, or fails in a way that is
 * retried, and finds the mapping inactive, as for Discord. While Google Calendar is off none
 * of it happens: the mapping stays active on its deleted meeting, which is how Sync all finds it later.
 */
export function googleCalendarDeleteStatements(db: D1Database, target: CalendarTarget, now: string): CalendarQueue {
  const at = bound(now);
  const statements = [
    statement(db, `INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) SELECT 'primary', g.meeting_id, g.event_id, 'delete', NULL, NULL, 'pending', 0, '${CALENDAR_DUE_NOW}', `, at,
      " FROM google_calendar_event_mappings g WHERE g.installation_id = 'primary' AND (g.synced_at IS NOT NULL OR EXISTS (SELECT 1 FROM google_calendar_operations fo WHERE fo.installation_id = 'primary' AND fo.event_id = g.event_id AND fo.action = 'upsert' AND fo.status = 'failed' AND fo.next_attempt_at IS NOT NULL)) AND g.meeting_id IN (", target,
      `) AND ${googleReady} ON CONFLICT(installation_id, event_id) DO UPDATE SET action = 'delete', starts_at = NULL, ends_at = NULL, status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at`),
    // Runs after the insert above, which has already turned a retried create into its delete (action is no longer upsert).
    statement(db, "UPDATE google_calendar_operations SET status = 'delivered', next_attempt_at = NULL, last_error = NULL, updated_at = ", at,
      " WHERE installation_id = 'primary' AND action = 'upsert' AND status != 'delivered' AND event_id IN (SELECT g.event_id FROM google_calendar_event_mappings g WHERE g.installation_id = 'primary' AND g.synced_at IS NULL AND g.meeting_id IN (", target, `)) AND ${googleReady}`),
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
/**
 * A condition for the statements of one save of the Discord credentials: true while the stored credentials are still the
 * ones that save read (`ciphertext`, or null when it found none). Every statement of the save carries it, so of two saves
 * that read the same credentials only the first changes anything, and the second finds out from its own write.
 */
export const discordCredentialsStill = (ciphertext: string | null): CalendarTarget => ({ sql: "(SELECT ciphertext FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = 'discord') IS ?", values: [ciphertext] });
/**
 * Where LancerLogin remembers the calendar of a Discord server it is not connected to any more: one integration_state
 * row per meeting, keyed by the server and the meeting, holding the event id (external_id, empty when the meeting had
 * no event yet) and the mapping's generation (content_hash). `calendar-server` holds the id of the server the stored
 * credentials are for, so SQL can tell which server is connected without reading the encrypted credentials. The table is
 * Core's key-value state for integrations, so neither needs a migration. (`calendar:%` rows are the connected server's.)
 */
const LEFT_PREFIX = "calendar-left:";
const SERVER_KEY = "calendar-server";
const leftKey = (guildId: string) => `${LEFT_PREFIX}${guildId}:`;
/** The meeting id in a remembered row's key: what follows the server id and its colon. */
const leftMeetingSql = (key: string) => `substr(${key}, ${LEFT_PREFIX.length + 1} + instr(substr(${key}, ${LEFT_PREFIX.length + 1}), ':'))`;
const notEnded = (alias: string) => `(${alias}.ends_at IS NULL OR julianday(${alias}.ends_at) >= julianday(?))`;
const discordState = "integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND ";
/** The server the stored Discord credentials are for, as the last save recorded it; NULL before any save recorded one. */
export const discordCalendarServerSql = `(SELECT external_id FROM ${discordState}state_key = '${SERVER_KEY}')`;
const always: CalendarTarget = { sql: "1 = 1", values: [] };
/** The reason on removals that were set aside because Discord was disconnected; connecting a server again makes those due. */
export const DISCORD_DISCONNECTED_REASON = "Discord was disconnected before these events could be removed.";
/** A statement that drops remembered rows of meetings that have ended or no longer exist. */
export function discordCalendarLeftPruning(db: D1Database, now: string, when: CalendarTarget = always): D1Statement {
  return statement(db, `DELETE FROM ${discordState}state_key LIKE '${LEFT_PREFIX}%' AND NOT EXISTS (SELECT 1 FROM meetings lm WHERE lm.installation_id = 'primary' AND lm.id = ${leftMeetingSql("integration_state.state_key")} AND ${notEnded("lm")}) AND `, { sql: "", values: [now] }, when);
}
/**
 * Statements for leaving a Discord server: its credentials are being replaced with ones for another server, or the
 * connection is being removed. The mappings and operations belong to that server's events, so they cannot stay, but
 * nothing about them is forgotten:
 *
 * 1. Every event that may still be on the server is recorded in calendar_event_removals under the server's id: the
 *    event of each meeting that has not ended (an ended meeting's event is over), and each delete not yet delivered.
 *    Removals already waiting with no server recorded are given it too, so none is later sent to another server.
 * 2. Each active mapping of a meeting that has not ended is remembered with its event and generation (LEFT_PREFIX),
 *    with or without an event, so that a meeting keeps its generation if the server comes back.
 * 3. The mappings, operations and `calendar:%` state go.
 *
 * `guildId` is the server being left when the caller could read it from the credentials; when it could not (null), the
 * server the last save recorded is used, and when there is none either, nothing can be recorded or remembered: the
 * events stay on a server nobody can name. `when` is discordCredentialsStill for a save and omitted for a removal. `recorded` counts
 * the events recorded in step 1. Run before the statement that stores or removes the credentials, in the same batch.
 */
export function discordCalendarLeave(db: D1Database, now: string, guildId: string | null, when: CalendarTarget = always): { statements: D1Statement[]; recorded: (results: readonly D1Result[], offset: number) => number } {
  const server: Fragment = { sql: `COALESCE(?, ${discordCalendarServerSql})`, values: [guildId] };
  const removal = (source: string, ...values: unknown[]) => statement(db, "INSERT OR IGNORE INTO calendar_event_removals (installation_id, provider, event_id, target, attempts, next_attempt_at, updated_at) SELECT 'primary', 'discord', x.event_id, ", server, `, 0, ?, ? FROM ${source} AND `, { sql: "", values: [now, now, ...values] }, server, " IS NOT NULL AND ", when);
  const live = `discord_calendar_event_mappings x JOIN meetings xm ON xm.installation_id = x.installation_id AND xm.id = x.meeting_id WHERE x.installation_id = 'primary' AND ${notEnded("xm")}`;
  return {
    statements: [
      removal(`${live} AND x.event_id IS NOT NULL`, now),
      removal("discord_calendar_operations x WHERE x.installation_id = 'primary' AND x.action = 'delete' AND x.status != 'delivered' AND x.event_id IS NOT NULL"),
      statement(db, "UPDATE calendar_event_removals SET target = ", server, " WHERE installation_id = 'primary' AND provider = 'discord' AND target IS NULL AND ", server, " IS NOT NULL AND ", when),
      statement(db, `INSERT OR REPLACE INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) SELECT 'primary', 'discord', '${LEFT_PREFIX}' || `, server, ` || ':' || x.meeting_id, COALESCE(x.event_id, ''), CAST(x.generation AS TEXT), ? FROM ${live} AND x.active = 1 AND `, { sql: "", values: [now, now] }, server, " IS NOT NULL AND ", when),
      statement(db, "DELETE FROM discord_calendar_operations WHERE installation_id = 'primary' AND ", when),
      statement(db, "DELETE FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND ", when),
      statement(db, `DELETE FROM ${discordState}state_key LIKE 'calendar:%' AND `, when),
    ],
    recorded: (results, offset) => (results[offset]?.meta?.changes ?? 0) + (results[offset + 1]?.meta?.changes ?? 0),
  };
}
/**
 * Statements for connecting a Discord server (`guildId`) that was not the connected one: after discordCalendarLeave
 * when credentials are replaced with ones for another server, and on their own when credentials are saved with none
 * stored (the first set-up, or setting Discord up again after the connection was removed).
 *
 * - What is remembered for this server comes back: each meeting that has not ended gets its mapping again, with its
 *   event and generation, and the removal recorded for that event is cancelled. Verifying then updates those events
 *   where they are; none is deleted and none is created a second time. An event that has been removed meanwhile is
 *   found gone by its update and created again, as for any event deleted on Discord.
 * - Removals that were set aside when Discord was disconnected are due again. Those of another server are removed there
 *   if the bot now saved can reach it, and recorded if it cannot (the removal loop of processDiscordCalendarOperations):
 *   setting up a different server after removing the connection is a change of server like any other.
 * - The server is recorded as the connected one.
 *
 * `restored` counts the mappings that came back, `elsewhere` the removals made due for other servers.
 */
export function discordCalendarConnect(db: D1Database, now: string, guildId: string, when: CalendarTarget): { statements: D1Statement[]; restored: (results: readonly D1Result[], offset: number) => number; elsewhere: (results: readonly D1Result[], offset: number) => number } {
  const returning = `${leftKey(guildId)}%`;
  const revive = (target: string) => statement(db, `UPDATE calendar_event_removals SET attempts = 0, next_attempt_at = ?, updated_at = ? WHERE installation_id = 'primary' AND provider = 'discord' AND next_attempt_at IS NULL AND last_error = ? AND ${target} AND `, { sql: "", values: [now, now, DISCORD_DISCONNECTED_REASON, guildId] }, when);
  return {
    statements: [
      discordCalendarLeftPruning(db, now, when),
      statement(db, `INSERT OR IGNORE INTO discord_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) SELECT 'primary', lm.id, NULLIF(s.external_id, ''), MAX(1, CAST(s.content_hash AS INTEGER)), 1, ? FROM integration_state s JOIN meetings lm ON lm.installation_id = s.installation_id AND lm.id = ${leftMeetingSql("s.state_key")} WHERE s.installation_id = 'primary' AND s.provider = 'discord' AND s.state_key LIKE ? AND `, { sql: "", values: [now, returning] }, when),
      statement(db, "DELETE FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = 'discord' AND (target = ", bound(guildId), " OR target IS NULL) AND event_id IN (SELECT event_id FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND event_id IS NOT NULL AND active = 1) AND ", when),
      statement(db, `DELETE FROM ${discordState}state_key LIKE `, bound(returning), " AND ", when),
      revive("target IS NOT NULL AND target != ?"), revive("(target IS NULL OR target = ?)"),
      discordCalendarServerRecord(db, now, guildId, when),
    ],
    restored: (results, offset) => results[offset + 1]?.meta?.changes ?? 0,
    elsewhere: (results, offset) => results[offset + 4]?.meta?.changes ?? 0,
  };
}
/** A statement that records `guildId` as the server the stored Discord credentials are for. Every save runs it. */
export function discordCalendarServerRecord(db: D1Database, now: string, guildId: string, when: CalendarTarget): D1Statement {
  return statement(db, `INSERT INTO integration_state (installation_id, provider, state_key, external_id, updated_at) SELECT 'primary', 'discord', '${SERVER_KEY}', ?, ? WHERE `, { sql: "", values: [guildId, now] }, when, " ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, updated_at = excluded.updated_at");
}
/** A statement for the batch that removes the Discord connection: no server is the connected one any more. */
export function discordCalendarServerForget(db: D1Database, when: CalendarTarget = always): D1Statement {
  return statement(db, `DELETE FROM ${discordState}state_key = '${SERVER_KEY}' AND `, when);
}
/**
 * Statements for an event that was created on `guildId` by a delivery whose operation row is gone when it finishes, so
 * that the delivery cannot link the event the usual way. In order:
 *
 * - That server is the connected one and the meeting is live: the connection was changed and changed back while
 *   Discord was answering. The event is the meeting's: its mapping is created, or completed if it has no event yet.
 * - Otherwise the event is recorded for removal under that server. With no Discord credentials stored the removal is
 *   set aside, as a disconnect sets removals aside, and connecting a server makes it due.
 * - And if the meeting is live it is remembered with it, as discordCalendarLeave remembers the events it knows of: when
 *   that server is connected again the event is linked again, not removed and created a second time.
 *
 * The meeting is gone when Delete attendance data or a meetings restore removed it meanwhile; then only the removal applies.
 */
export function discordCalendarUnlinkedEvent(db: D1Database, guildId: string | null, meetingId: string, generation: number, eventId: string, now: string): D1Statement[] {
  const noOperation: Fragment = { sql: "NOT EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert')", values: [meetingId, generation] };
  const liveMeeting: Fragment = { sql: "EXISTS (SELECT 1 FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL)", values: [meetingId] };
  const unmapped: Fragment = { sql: "NOT EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND event_id = ?)", values: [eventId] };
  const connected = "EXISTS (SELECT 1 FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = 'discord')";
  return [
    ...(guildId ? [statement(db, "INSERT INTO discord_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, synced_at, updated_at) SELECT 'primary', ?, ?, ?, 1, ?, ? WHERE ", { sql: "", values: [meetingId, eventId, generation, now, now] }, noOperation, " AND ", liveMeeting, ` AND ${connected} AND ${discordCalendarServerSql} = `, bound(guildId), " ON CONFLICT(installation_id, meeting_id) DO UPDATE SET event_id = excluded.event_id, synced_at = excluded.synced_at, last_error = NULL, updated_at = excluded.updated_at WHERE discord_calendar_event_mappings.event_id IS NULL AND discord_calendar_event_mappings.active = 1")] : []),
    statement(db, `INSERT OR IGNORE INTO calendar_event_removals (installation_id, provider, event_id, target, attempts, next_attempt_at, last_error, updated_at) SELECT 'primary', 'discord', ?, ?, 0, CASE WHEN ${connected} THEN ? ELSE NULL END, CASE WHEN ${connected} THEN NULL ELSE ? END, ? WHERE `, { sql: "", values: [eventId, guildId, now, DISCORD_DISCONNECTED_REASON, now] }, noOperation, " AND ", unmapped),
    ...(guildId ? [statement(db, "INSERT OR REPLACE INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) SELECT 'primary', 'discord', ?, ?, ?, ? WHERE ", { sql: "", values: [`${leftKey(guildId)}${meetingId}`, eventId, String(generation), now] }, noOperation, " AND ", liveMeeting, " AND ", unmapped)] : []),
  ];
}
/** How long a Discord event removal is leased to the delivery that is sending it; if that delivery never settles it, it is due again then. */
export const DISCORD_REMOVAL_LEASE_MS = 5 * 60_000;
/**
 * A statement that leases a due Discord event removal to the delivery about to send it, as operations are leased: the
 * row stays, due again when the lease ends (`leasedUntil`), so a delivery that stops before settling it (the scheduler's
 * budget, a D1 error, the Worker itself) loses nothing. It returns the row with whether an active mapping holds its
 * event (`mapped`). Nothing returned means the removal is not there or not due any more: it was cancelled since the job
 * read it (the server came back and the event is its meeting's again), or another delivery has it. `mapped` means the
 * event is a meeting's again and the removal is obsolete: the caller deletes the row. In neither case is the event removed.
 */
export function leaseDiscordCalendarRemoval(db: D1Database, eventId: string, now: string, leasedUntil: string): D1Statement {
  return db.prepare("UPDATE calendar_event_removals SET next_attempt_at = ?, updated_at = ? WHERE installation_id = 'primary' AND provider = 'discord' AND event_id = ? AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? RETURNING (SELECT COUNT(*) FROM discord_calendar_event_mappings m WHERE m.installation_id = 'primary' AND m.event_id = calendar_event_removals.event_id AND m.active = 1) AS mapped").bind(leasedUntil, now, eventId, now);
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
/**
 * The removal was recorded for another calendar or server than the one now configured and cannot be made there (for a
 * Discord server, the bot now configured was refused or is not in it): it is dropped and recorded, with the server or
 * calendar it was for (`target`), so an Admin can find the event and remove it by hand.
 */
export async function dropCalendarRemoval(db: D1Database, provider: CalendarProvider, removal: CalendarRemoval): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([db.prepare("DELETE FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = ? AND event_id = ?").bind(provider, removal.eventId), removalAudit(db, "calendar.event_removal_abandoned", provider, { eventId: removal.eventId, attempts: removal.attempts, ...(provider === "discord" && removal.target ? { serverId: removal.target } : {}), error: "The calendar or server this event is on is no longer the one configured" }, now)]);
}
/** A statement that makes every removal the card reports as needing another attempt due again, with a fresh allowance. */
export function calendarRemovalRetry(db: D1Database, provider: CalendarProvider, now: string): D1Statement {
  return db.prepare("UPDATE calendar_event_removals SET attempts = 0, next_attempt_at = ?, updated_at = ? WHERE installation_id = 'primary' AND provider = ? AND next_attempt_at IS NULL").bind(now, now, provider);
}
/**
 * When a provider is disconnected its events can no longer be reached, so its waiting removals are set aside (they no
 * longer count as waiting) with one audit entry for all of them. Reconnecting the same calendar and choosing
 * Sync all makes them due again; for Discord, saving credentials with none stored does (discordCalendarConnect). Run both statements in the batch that removes the connection.
 */
export function calendarRemovalDisconnectStatements(db: D1Database, provider: CalendarProvider, now: string, when: CalendarTarget = always): D1Statement[] {
  const reason = provider === "discord" ? DISCORD_DISCONNECTED_REASON : "Google Calendar was disconnected before these events could be removed.";
  return [
    statement(db, "INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', NULL, 'calendar.event_removal_abandoned', 'integration', ?, json_object('events', COUNT(*), 'error', ?), ? FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = ? AND next_attempt_at IS NOT NULL AND ", { sql: "", values: [crypto.randomUUID(), provider, reason, now, provider] }, when, " HAVING COUNT(*) > 0"),
    statement(db, "UPDATE calendar_event_removals SET next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND provider = ? AND next_attempt_at IS NOT NULL AND ", { sql: "", values: [reason, now, provider] }, when),
  ];
}
/**
 * How long everything of Discord's that is due waits after a refusal every other request would meet too: a
 * configuration that cannot be read, a rejected bot token, a missing permission or a server the bot is no longer in.
 */
export const DISCORD_CALENDAR_HOLD_MS = 15 * 60_000;
/**
 * Statements that hold Discord's due operations and due event removals until `until`. They were not sent, so their
 * status, attempts and errors stay as they are; an operation being delivered keeps its lease, and one that failed for
 * good (no next attempt) stays failed. Work queued after this is due at once, as always, and is what next finds out
 * whether Discord accepts requests again. `scope` narrows the hold to what the refusal covers: Discord grants creating
 * and removing events separately, so a permission refused for an upsert holds upserts, and one refused for a delete or a
 * removal holds deletes and removals. Run the statements in one batch.
 */
export type DiscordCalendarHoldScope = "all" | "upsert" | "delete";
export function discordCalendarHold(db: D1Database, until: string, now: string, scope: DiscordCalendarHoldScope = "all"): D1Statement[] {
  return [
    db.prepare("UPDATE discord_calendar_operations SET next_attempt_at = ?1 WHERE installation_id = 'primary' AND status IN ('pending', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?2 AND (?3 = 'all' OR action = ?3)").bind(until, now, scope),
    ...(scope === "upsert" ? [] : [db.prepare("UPDATE calendar_event_removals SET next_attempt_at = ? WHERE installation_id = 'primary' AND provider = 'discord' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?").bind(until, now)]),
  ];
}
/**
 * Statements that end a hold, for the Discord card's retry: held operations become due as when they were queued and
 * held removals due now. Attempts are kept. Only rows whose time changes are written, so each statement's `changes` is
 * the work it made due: an upsert that is waiting for its meeting to come within the horizon is not touched.
 */
export function discordCalendarHoldRelease(db: D1Database, now: string): D1Statement[] {
  return [
    db.prepare(`UPDATE discord_calendar_operations SET next_attempt_at = CASE WHEN action = 'upsert' THEN ${discordCalendarDueSql("discord_calendar_operations.starts_at", "(SELECT d.event_id FROM discord_calendar_event_mappings d WHERE d.installation_id = 'primary' AND d.meeting_id = discord_calendar_operations.meeting_id AND d.generation = discord_calendar_operations.generation)")} ELSE '${CALENDAR_DUE_NOW}' END WHERE installation_id = 'primary' AND status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at > ? AND next_attempt_at != CASE WHEN action = 'upsert' THEN ${discordCalendarDueSql("discord_calendar_operations.starts_at", "(SELECT d.event_id FROM discord_calendar_event_mappings d WHERE d.installation_id = 'primary' AND d.meeting_id = discord_calendar_operations.meeting_id AND d.generation = discord_calendar_operations.generation)")} ELSE '${CALENDAR_DUE_NOW}' END`).bind(now, now, now),
    db.prepare("UPDATE calendar_event_removals SET next_attempt_at = ? WHERE installation_id = 'primary' AND provider = 'discord' AND next_attempt_at IS NOT NULL AND next_attempt_at > ?").bind(now, now),
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

/** What disabling Attendance would leave on one provider's calendar: removals that would wait, and events left with none queued. */
export type AttendanceDisableCalendarCounts = { waitingRemovals: number; upcomingEvents: number };
/** Per provider, only for a provider with a saved connection: the confirmation names no provider that is not set up. */
export type AttendanceDisableCalendar = Partial<Record<CalendarProvider, AttendanceDisableCalendarCounts>>;
export type AttendanceDisableCalendarRow = { googleSaved: number; discordSaved: number; googleWaiting: number; discordWaiting: number; googleUpcoming: number; discordUpcoming: number };
/**
 * For the Attendance disable confirmation in Settings > Modules: what disabling now would leave on each calendar, while
 * nothing is sent (see configureModulePlatform). One read, binding `now` twice.
 * - Waiting removals: the removals waiting now, and the deletes not yet delivered, which disabling records as removals
 *   (calendarRemovalStatements with only: "pendingDeletes"), each event once. Removals set aside are left out, as are
 *   deletes of events whose removal is set aside (recording one leaves it set aside): only Retry failed delivery or
 *   Sync all sends those, so enabling Attendance again would not remove them.
 * - Upcoming events: the events of current and upcoming meetings, which disabling leaves where they are with no removal
 *   queued. Google counts an event once Google has confirmed it; Discord once it has an event id.
 */
export function attendanceDisableCalendarStatement(db: D1Database, now: string): D1Statement {
  const waiting = (provider: CalendarProvider) => `(SELECT COUNT(*) FROM (SELECT event_id FROM calendar_event_removals WHERE installation_id = 'primary' AND provider = '${provider}' AND next_attempt_at IS NOT NULL UNION SELECT o.event_id FROM ${provider === "discord" ? "discord" : "google"}_calendar_operations o WHERE o.installation_id = 'primary' AND o.action = 'delete' AND o.status != 'delivered' AND o.event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calendar_event_removals s WHERE s.installation_id = 'primary' AND s.provider = '${provider}' AND s.event_id = o.event_id AND s.next_attempt_at IS NULL)))`;
  const upcoming = (mappings: string, exists: string) => `(SELECT COUNT(*) FROM ${mappings} x JOIN meetings m ON m.installation_id = x.installation_id AND m.id = x.meeting_id WHERE x.installation_id = 'primary' AND x.active = 1 AND ${exists} AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL AND julianday(m.ends_at) >= julianday(?))`;
  return db.prepare(`SELECT EXISTS (SELECT 1 FROM google_calendar_authorizations WHERE installation_id = 'primary' AND ciphertext IS NOT NULL) AS googleSaved, EXISTS (SELECT 1 FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = 'discord') AS discordSaved, ${waiting("google_calendar")} AS googleWaiting, ${waiting("discord")} AS discordWaiting, ${upcoming("google_calendar_event_mappings", "x.synced_at IS NOT NULL")} AS googleUpcoming, ${upcoming("discord_calendar_event_mappings", "x.event_id IS NOT NULL")} AS discordUpcoming`).bind(now, now);
}
/** The counts the statement above read, by provider. */
export function attendanceDisableCalendar(row: AttendanceDisableCalendarRow | null | undefined): AttendanceDisableCalendar {
  if (!row) return {};
  return {
    ...(row.googleSaved ? { google_calendar: { waitingRemovals: Number(row.googleWaiting), upcomingEvents: Number(row.googleUpcoming) } } : {}),
    ...(row.discordSaved ? { discord: { waitingRemovals: Number(row.discordWaiting), upcomingEvents: Number(row.discordUpcoming) } } : {}),
  };
}

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
    // What is remembered of servers that were left, for meetings that have ended or are gone, is of no use any more.
    discordCalendarLeftPruning(db, now),
  ];
}

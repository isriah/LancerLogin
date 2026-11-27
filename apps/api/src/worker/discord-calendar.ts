import { DISCORD_CALENDAR_HORIZON_DAYS, calendarLifecycleQueue, calendarTargets, completeCalendarRemoval, discordCalendarSyncStatements, dueCalendarWork, failCalendarRemoval, calendarCatchUp, calendarFailedRetry, calendarRemovalRetry, calendarWaitingCount, discordCalendarHold, discordCalendarHoldRelease, discordCalendarUnlinkedEvent, leaseDiscordCalendarRemoval, DISCORD_REMOVAL_LEASE_MS, DISCORD_CALENDAR_HOLD_MS, dropCalendarRemoval, type DiscordCalendarHoldScope, type CalendarQueueSummary, type CalendarRemoval } from "../calendar-queue.ts";
import { type D1Database, type D1Result } from "../d1-usage.ts";
import { SchedulerBudgetError, type PassCost } from "../scheduler-budget.ts";
import { HttpError } from "../http-error.ts";
import { DiscordRateLimitError } from "../discord-rate-limit.ts";
import { DiscordPermissionError, DiscordResponseError, DiscordTokenError, type Env, type Principal, parseJson, passAllows, passMore, requireDatabase, requireRole, response, sha256, writeAudit } from "./core.ts";
import { deliveryPausedUntil } from "./delivery.ts";
import { discordConfiguration, discordRequest } from "./discord-core.ts";
import { CALENDAR_SYNC_ALL_RULE, calendarPerPass, calendarSchedulerMode, googleCalendarIsReady } from "./google-calendar.ts";
import { integrationRecord, requireIntegrationConfigured } from "./integration-support.ts";
import { meetingAudienceText } from "./meeting-audience.ts";
import { calendarAttendanceDetails } from "./policy-data.ts";

type DiscordCalendarSyncSummary = CalendarQueueSummary["discord"];
type DiscordCalendarOutcome = DiscordCalendarSyncSummary["outcomes"][number];
type DiscordCalendarOperation = { meetingId: string; generation: number; action: "upsert" | "delete"; eventId?: string | null; status: "pending" | "processing" | "delivered" | "failed"; attempts: number; revision: number; actorUserId?: string | null; leaseToken?: string; claimedBefore?: string | null };
// Per pass: up to 2 Discord requests per operation (3 attempts each on a short 429) and about 8 D1 queries, plus one
// scheduled-event list shared by the batch. An event removal left by Delete attendance data takes an operation's place.
const DISCORD_CALENDAR_OPERATION_BATCH_LIMIT = 3;
const DISCORD_CALENDAR_OPERATION_COST: PassCost = { d1: 10, external: 3 };
// A Discord event removal: its lease and the write that settles it (done, failed, dropped or obsolete), and one request
// that discordRequest may send up to three times on a short rate limit, each one counted.
const DISCORD_CALENDAR_REMOVAL_COST: PassCost = { d1: 2, external: 3 };
const discordCalendarHorizon = (now: number) => new Date(now + DISCORD_CALENDAR_HORIZON_DAYS * 86_400_000).toISOString();
const discordCalendarEmptySummary = (): DiscordCalendarSyncSummary => ({ synced: 0, queued: 0, skipped: 0, failed: 0, outcomes: [] });
export async function discordCalendarIsReady(env: Env): Promise<boolean> { const record = await integrationRecord(env, "discord"); return Boolean(record?.enabled && record.verifiedAt); }
function discordCalendarRetryAt(attempts: number, error: unknown): string | null {
  if (error instanceof DiscordPermissionError) return null;
  if (error instanceof DiscordResponseError && error.discordStatus < 500) return null;
  const requested = error instanceof DiscordRateLimitError ? error.retryAfterMs : 0;
  return new Date(Date.now() + Math.min(3_600_000, Math.max(60_000, 2 ** Math.min(attempts, 12) * 1_000, requested))).toISOString();
}
/**
 * `heldUntil` is the end of the hold this failure starts, when it is a refusal the rest of the queue would meet too. The
 * refused operation then waits out the hold with the others (or its own retry time, when that is later) instead of
 * failing for good: what was refused is the bot's access, not this operation. It still counts as failed, with its
 * reason, so the card can show why.
 */
async function markDiscordCalendarFailure(db: D1Database, operation: DiscordCalendarOperation, error: unknown, heldUntil?: string): Promise<string> {
  const message = (error instanceof Error ? error.message : "Discord calendar delivery failed. LancerLogin will retry automatically.").slice(0, 300); const attempts = Number(operation.attempts ?? 0) + 1; const now = new Date().toISOString(); const own = discordCalendarRetryAt(attempts, error);
  const retryAt = heldUntil && (!own || own < heldUntil) ? heldUntil : own;
  await db.batch([
    db.prepare("UPDATE discord_calendar_event_mappings SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = ? AND lease_token = ?)").bind(message, now, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.action, operation.leaseToken),
    // A meeting change queued while this was in flight (a newer revision) keeps its operation pending and due now.
    db.prepare("UPDATE discord_calendar_operations SET status = CASE WHEN revision = ? THEN 'failed' ELSE 'pending' END, attempts = ?, next_attempt_at = CASE WHEN revision = ? THEN ? ELSE COALESCE(?, ?) END, lease_token = NULL, lease_expires_at = NULL, last_error = CASE WHEN revision = ? THEN ? ELSE NULL END, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = ? AND lease_token = ?").bind(operation.revision, attempts, operation.revision, retryAt, retryAt, now, operation.revision, message, now, operation.meetingId, operation.generation, operation.action, operation.leaseToken),
  ]);
  return message;
}
/** Discord's error code for a server it does not know, or one the bot cannot see. */
const DISCORD_UNKNOWN_GUILD = 10004;
/**
 * Discord answered 404 for a scheduled event because the event is gone. A 404 for the server itself (Unknown Guild)
 * says nothing about the event, which is still there for anyone who can see the server, so it never counts as gone.
 */
const discordCalendarEventGone = (error: unknown) => error instanceof DiscordResponseError && error.discordStatus === 404 && error.discordCode !== DISCORD_UNKNOWN_GUILD;
type DiscordCalendarQueueHold = { ms: number; scope: DiscordCalendarHoldScope };
/**
 * What a refusal holds of Discord's calendar queue and for how long, or null when the failure is the operation's own (a
 * title Discord will not take, an outage). A rate limit, a rejected token and a server the bot is not in would refuse
 * every other request the same way, so nothing else is sent until the hold ends. A missing permission holds the work of
 * the kind that was refused (`action`): Discord grants creating events and removing them separately.
 */
function discordCalendarQueueHold(error: unknown, action: "upsert" | "delete"): DiscordCalendarQueueHold | null {
  if (error instanceof DiscordRateLimitError) return { ms: Math.min(3_600_000, Math.max(60_000, error.retryAfterMs)), scope: "all" };
  if (error instanceof DiscordTokenError || (error instanceof DiscordResponseError && error.discordCode === DISCORD_UNKNOWN_GUILD)) return { ms: DISCORD_CALENDAR_HOLD_MS, scope: "all" };
  if (error instanceof DiscordPermissionError) return { ms: DISCORD_CALENDAR_HOLD_MS, scope: action };
  return null;
}
const DISCORD_EVENT_LOST_IN_PROGRESS = "This meeting's Discord event was removed on Discord after the meeting started. Discord cannot be given a new event for a meeting in progress, so it has none.";
type DiscordScheduledEvent = { id?: string; entity_metadata?: { location?: string } };
async function discordCalendarCorrelationLocation(meetingId: string, generation: number): Promise<string> { return `LancerLogin · ${(await sha256(`discord-calendar:primary:${meetingId}:${generation}`)).slice(0, 24)}`; }
async function reconcileDiscordCalendarEvent(config: Record<string, string>, correlationLocation: string, listEvents: () => Promise<DiscordScheduledEvent[]>): Promise<string | undefined> {
  return (await listEvents()).find((event) => event.entity_metadata?.location === correlationLocation && typeof event.id === "string" && event.id.length > 0)?.id;
}
/**
 * The scheduled Discord calendar delivery: the oldest due operations, then due event removals. Nothing else delivers to
 * Discord's scheduled events; meeting routes only queue. An operation is due once its next_attempt_at has passed: a
 * pending one from when it was queued (or from when its meeting comes within the horizon), a failed one from its retry
 * time, and one being delivered from the end of its lease, so a delivery that died is picked up again.
 */
export async function processDiscordCalendarOperations(env: Env): Promise<DiscordCalendarSyncSummary> {
  if (!await discordCalendarIsReady(env)) return discordCalendarEmptySummary();
  // A Stop holds first attempts too: the operations stay pending and go out when delivery resumes.
  if (await deliveryPausedUntil(env) !== null) return discordCalendarEmptySummary();
  const db = requireDatabase(env); const now = new Date().toISOString();
  // Discord allows a server 100 scheduled events, so only meetings starting within the horizon get a new event. An upsert
  // for a later meeting with no event yet is queued to fall due when its meeting comes within range (calendar-queue.ts);
  // the horizon is checked here as well, for operations queued before that and meetings moved since. A meeting that
  // already has an event keeps it in sync. Work due at once goes deletes first, then by meeting start (calendar-queue.ts).
  const horizon = discordCalendarHorizon(Date.now());
  const { operations, removals } = await dueCalendarWork<DiscordCalendarOperation>(db, "discord", `SELECT o.meeting_id AS meetingId, o.generation, o.action, o.event_id AS eventId, o.status, o.attempts, o.revision, o.actor_user_id AS actorUserId, o.lease_token AS claimedBefore, NULL AS removalAttempts, NULL AS removalTarget FROM discord_calendar_operations o WHERE o.installation_id = 'primary' AND o.status != 'delivered' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at <= ? AND (o.status != 'processing' OR o.lease_expires_at <= ?) AND NOT (o.action = 'upsert' AND EXISTS (SELECT 1 FROM meetings hm WHERE hm.installation_id = o.installation_id AND hm.id = o.meeting_id AND hm.starts_at > ?) AND NOT EXISTS (SELECT 1 FROM discord_calendar_event_mappings hx WHERE hx.installation_id = o.installation_id AND hx.meeting_id = o.meeting_id AND hx.generation = o.generation AND hx.event_id IS NOT NULL)) ORDER BY o.next_attempt_at, o.starts_at LIMIT ${DISCORD_CALENDAR_OPERATION_BATCH_LIMIT}`, [now, now, horizon], "NULL, 0, 'delete', r.event_id, 'pending', 0, 0, NULL, NULL", DISCORD_CALENDAR_OPERATION_BATCH_LIMIT, now);
  if (!operations.length && !removals.length) return discordCalendarEmptySummary();
  // Without its configuration nothing here can proceed: everything due is held, so the job neither asks to run again at
  // once nor reads the same work on every round.
  // One end time for a hold, so the refused operation and the work held behind it fall due together.
  let heldUntil: string | undefined; const holdEnd = (held: DiscordCalendarQueueHold) => heldUntil ??= new Date(Date.now() + held.ms).toISOString();
  const hold = (held: DiscordCalendarQueueHold) => db.batch(discordCalendarHold(db, holdEnd(held), now, held.scope));
  let config: Record<string, string>; try { config = await discordConfiguration(env); } catch (error) { if (error instanceof SchedulerBudgetError) throw error; await hold({ ms: DISCORD_CALENDAR_HOLD_MS, scope: "all" }); return { ...discordCalendarEmptySummary(), queued: operations.length }; }
  const full = operations.length + removals.length === DISCORD_CALENDAR_OPERATION_BATCH_LIMIT;
  const summary = discordCalendarEmptySummary();
  // One list per batch: each meeting's correlation location is unique, so events this batch creates are never looked up.
  let guildEvents: Promise<DiscordScheduledEvent[]> | undefined;
  const listEvents = () => guildEvents ??= discordRequest<DiscordScheduledEvent[]>(config, `/guilds/${config.guildId}/scheduled-events`, { method: "GET" }).then((listed) => {
    if (!Array.isArray(listed.body)) throw new DiscordResponseError(502, "Discord did not return a scheduled event list");
    return listed.body;
  }).catch((error) => { guildEvents = undefined; throw error; });
  let stopped = false; let held: DiscordCalendarQueueHold | null = null;
  for (const operation of operations) {
    // Operations the pass cannot afford stay pending and count as queued below.
    if (!passAllows(env, DISCORD_CALENDAR_OPERATION_COST)) { stopped = true; break; }
    operation.leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    // While it is being delivered an operation is due again when its lease ends.
    const claimed = await db.prepare("UPDATE discord_calendar_operations SET status = 'processing', lease_token = ?, lease_expires_at = ?, next_attempt_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = ? AND revision = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND lease_expires_at <= ?))").bind(operation.leaseToken, leaseExpiresAt, leaseExpiresAt, operation.meetingId, operation.generation, operation.action, operation.revision, now).run();
    if ((claimed.meta?.changes ?? 0) < 1) continue;
    let title = "Meeting";
    try {
      if (operation.action === "delete") {
        try { await discordRequest(config, `/guilds/${config.guildId}/scheduled-events/${operation.eventId}`, { method: "DELETE" }); }
        catch (error) { if (!discordCalendarEventGone(error)) throw error; }
        const completedAt = new Date().toISOString(); await db.batch([
          db.prepare("UPDATE discord_calendar_event_mappings SET event_id = NULL, synced_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 0 AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'delete' AND lease_token = ?)").bind(completedAt, completedAt, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("DELETE FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = ? AND external_id = ? AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'delete' AND lease_token = ?)").bind(`calendar:${operation.meetingId}`, operation.eventId, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("UPDATE discord_calendar_operations SET status = CASE WHEN revision = ? THEN 'delivered' ELSE 'pending' END, attempts = attempts + 1, next_attempt_at = CASE WHEN revision = ? THEN NULL ELSE ? END, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'delete' AND lease_token = ?").bind(operation.revision, operation.revision, completedAt, completedAt, operation.meetingId, operation.generation, operation.leaseToken),
        ]);
      } else {
        const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, notes, required, attendance_weight AS attendanceWeight FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(operation.meetingId).first<{ id: string; title: string; startsAt: string; endsAt: string; notes?: string | null; required: number; attendanceWeight: number }>();
        const mapping = await db.prepare("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ?").bind(operation.meetingId, operation.generation).first<{ eventId?: string | null; active: number }>();
        if (!meeting || !mapping?.active) { await db.prepare("UPDATE discord_calendar_operations SET status = 'delivered', next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?").bind(now, operation.meetingId, operation.generation, operation.leaseToken).run(); summary.skipped += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "skipped", reason: "Meeting is no longer active" }); continue; }
        title = meeting.title;
        if (Date.parse(meeting.endsAt) < Date.now()) { await db.prepare("UPDATE discord_calendar_operations SET status = 'delivered', next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?").bind(now, operation.meetingId, operation.generation, operation.leaseToken).run(); summary.skipped += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "skipped", reason: "Meeting has already ended" }); continue; }
        if (meeting.title.length > 100) throw new DiscordResponseError(400, "Discord event names are limited to 100 characters");
        const description = calendarAttendanceDetails(meeting, await meetingAudienceText(db, operation.meetingId));
        if (description.length > 1_000) throw new DiscordResponseError(400, "Discord event descriptions are limited to 1,000 characters");
        const correlationLocation = await discordCalendarCorrelationLocation(operation.meetingId, operation.generation);
        const started = Date.parse(meeting.startsAt) <= Date.now();
        const payload = { name: meeting.title, description, privacy_level: 2, entity_type: 3, ...(started ? {} : { scheduled_start_time: meeting.startsAt }), scheduled_end_time: meeting.endsAt, entity_metadata: { location: correlationLocation } };
        let eventId = mapping.eventId ?? undefined;
        // A row that still carries a lease token was claimed by a delivery whose closing write never ran (the slice was
        // stopped, or the budget refused the write): Discord may already have the event, whatever the row says now.
        let needsReconciliation = started || operation.status === "processing" || Number(operation.attempts) > 0 || Boolean(operation.claimedBefore);
        if (eventId) try { await discordRequest(config, `/guilds/${config.guildId}/scheduled-events/${eventId}`, { method: "PATCH", body: JSON.stringify(payload) }); needsReconciliation = false; } catch (error) { if (discordCalendarEventGone(error)) { eventId = undefined; needsReconciliation = true; } else throw error; }
        if (!eventId && needsReconciliation) eventId = await reconcileDiscordCalendarEvent(config, correlationLocation, listEvents);
        if (eventId && needsReconciliation) await discordRequest(config, `/guilds/${config.guildId}/scheduled-events/${eventId}`, { method: "PATCH", body: JSON.stringify(payload) });
        if (!eventId && started) {
          // The mapping named an event that Discord no longer has (it was deleted there). Discord cannot be given a new
          // event for a meeting that has started, so the meeting has none: the mapping says so, with the reason, instead
          // of keeping the id of an event that is gone.
          const lost = Boolean(mapping.eventId); const settled = db.prepare("UPDATE discord_calendar_operations SET status = CASE WHEN revision = ? THEN 'delivered' ELSE 'pending' END, next_attempt_at = CASE WHEN revision = ? THEN NULL ELSE ? END, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?").bind(operation.revision, operation.revision, now, now, operation.meetingId, operation.generation, operation.leaseToken);
          if (lost) await db.batch([db.prepare("UPDATE discord_calendar_event_mappings SET event_id = NULL, synced_at = NULL, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND event_id = ? AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?)").bind(DISCORD_EVENT_LOST_IN_PROGRESS, now, operation.meetingId, operation.generation, mapping.eventId, operation.meetingId, operation.generation, operation.leaseToken), db.prepare("DELETE FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = ? AND external_id = ?").bind(`calendar:${operation.meetingId}`, mapping.eventId), settled]);
          else await settled.run();
          summary.skipped += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "skipped", reason: lost ? DISCORD_EVENT_LOST_IN_PROGRESS : "Meeting has already started and has no Discord event. Sync upcoming meetings before their start time." }); continue;
        }
        if (!eventId) { const created = await discordRequest(config, `/guilds/${config.guildId}/scheduled-events`, { method: "POST", body: JSON.stringify(payload) }); eventId = String(created.body.id ?? ""); if (!eventId) throw new DiscordResponseError(502, "Discord did not return a scheduled event ID"); }
        const completedAt = new Date().toISOString(); const completion = await db.batch([
          db.prepare("UPDATE discord_calendar_event_mappings SET event_id = ?, synced_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1 AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?)").bind(eventId, completedAt, completedAt, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, updated_at) SELECT 'primary', 'discord', ?, ?, ? WHERE EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, updated_at = excluded.updated_at").bind(`calendar:${operation.meetingId}`, eventId, completedAt, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, actor_user_id, updated_at) SELECT 'primary', ?, ?, 'delete', ?, 'pending', 0, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?) ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET event_id = excluded.event_id, revision = discord_calendar_operations.revision + 1, status = 'pending', next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at").bind(operation.meetingId, operation.generation, eventId, completedAt, operation.actorUserId ?? null, completedAt, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("UPDATE discord_calendar_operations SET event_id = ?, status = CASE WHEN revision != ? AND EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) THEN 'pending' ELSE 'delivered' END, attempts = attempts + 1, next_attempt_at = CASE WHEN revision != ? AND EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) THEN ? ELSE NULL END, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?").bind(eventId, operation.revision, operation.meetingId, operation.generation, operation.revision, operation.meetingId, operation.generation, completedAt, completedAt, operation.meetingId, operation.generation, operation.leaseToken),
          // The operation's row is gone, so this delivery cannot link its event the usual way: the meeting was deleted
          // outright, or the Discord connection was replaced for another server or removed, while Discord was answering.
          // (A row that another delivery claimed since is still there, and that delivery finds the event by its location.)
          ...discordCalendarUnlinkedEvent(db, config.guildId || null, operation.meetingId, operation.generation, eventId, completedAt),
        ]);
        if ((completion[3]?.meta?.changes ?? 1) > 0) await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'discord.calendar_synced', 'meeting', ?, ?, ?)").bind(crypto.randomUUID(), operation.actorUserId ?? null, operation.meetingId, JSON.stringify({ eventId }), completedAt).run();
      }
      summary.synced += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "synced" });
    } catch (error) { if (error instanceof SchedulerBudgetError) throw error; held = discordCalendarQueueHold(error, operation.action === "delete" ? "delete" : "upsert"); const reason = await markDiscordCalendarFailure(db, operation, error, held ? holdEnd(held) : undefined); summary.failed += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "failed", reason }); if (held) { stopped = true; break; } }
  }
  summary.queued = Math.max(0, operations.length - summary.synced - summary.skipped - summary.failed);
  // Once Discord has refused for want of a permission or a valid token, or rate limited the bot, the rest of the queue
  // would be refused the same way: this batch's removals are not sent and keep their attempts (only an attempt that was
  // made counts), the due work the refusal covers is held (discordCalendarHold), and the job does not ask to run again at once.
  const refused = (removal: CalendarRemoval, error: unknown) => failCalendarRemoval(db, "discord", removal, error instanceof Error ? error.message : "Discord calendar delivery failed", error instanceof DiscordRateLimitError ? error.retryAfterMs : 0);
  for (const removal of removals) {
    if (stopped) break;
    if (!passAllows(env, DISCORD_CALENDAR_REMOVAL_COST)) break;
    // An event recorded for another server than the one now configured is not on this one. It is removed from its own
    // server when the bot now configured can still do that there (the same bot moved to another server, say), and
    // never sent to the configured server. A target that is not a server id cannot be asked at all.
    const elsewhere = Boolean(removal.target && removal.target !== config.guildId);
    if (elsewhere && !/^\d{10,24}$/.test(removal.target!)) { await dropCalendarRemoval(db, "discord", removal); continue; }
    // The removal is leased before it is sent (leaseDiscordCalendarRemoval): one that was cancelled since this job
    // read it, or whose event an active mapping holds, belongs to a server that came back and must not be removed. The
    // row stays until the event is known to be gone, so whatever stops this delivery, the removal is due again when
    // its lease ends.
    const leased = (await leaseDiscordCalendarRemoval(db, removal.eventId, now, new Date(Date.now() + DISCORD_REMOVAL_LEASE_MS).toISOString()).all<{ mapped: number }>()).results?.[0];
    if (!leased) continue;
    if (Number(leased.mapped) > 0) { await completeCalendarRemoval(db, "discord", removal); continue; }
    try {
      try { await discordRequest(config, `/guilds/${elsewhere ? removal.target : config.guildId}/scheduled-events/${removal.eventId}`, { method: "DELETE" }); }
      catch (error) { if (!discordCalendarEventGone(error)) throw error; }
      await completeCalendarRemoval(db, "discord", removal);
    } catch (error) {
      if (error instanceof SchedulerBudgetError) throw error;
      // The other server refused this bot or does not know it: that says nothing about the configured server, so the
      // queue is not held; the removal is given up and recorded with the server it was for. A rejected token, a rate
      // limit or an outage is the bot's own trouble and is handled as for any removal.
      if (elsewhere && (error instanceof DiscordPermissionError || (error instanceof DiscordResponseError && error.discordStatus < 500))) { await dropCalendarRemoval(db, "discord", removal); continue; }
      await refused(removal, error);
      held = discordCalendarQueueHold(error, "delete"); if (held) stopped = true;
    }
  }
  if (held) await hold(held);
  if (full && !stopped) passMore(env);
  return summary;
}
/**
 * Queues every current and upcoming meeting for Discord in one batch (see CALENDAR_SYNC_ALL_RULE), with the same repairs
 * as the Google route. `deferred` counts the meetings further out than the 60-day horizon: their operations are queued
 * but only fall due when the meeting comes within range, because Discord allows a server 100 scheduled events.
 */
async function queueAllDiscordCalendarMeetings(db: D1Database, principal: Principal, env: Env) {
  const now = new Date().toISOString(); const upcoming = calendarTargets.upcoming(now);
  const catchUp = calendarCatchUp(db, "discord", now, principal.userId);
  const results = await db.batch([...catchUp.statements, calendarRemovalRetry(db, "discord", now), calendarWaitingCount(db, "discord", now),
    db.prepare(`SELECT COUNT(*) AS selected, COALESCE(SUM(CASE WHEN julianday(m.starts_at) > julianday(?) + ${DISCORD_CALENDAR_HORIZON_DAYS} AND NOT EXISTS (SELECT 1 FROM discord_calendar_event_mappings d WHERE d.installation_id = 'primary' AND d.meeting_id = m.id AND d.event_id IS NOT NULL) THEN 1 ELSE 0 END), 0) AS deferred FROM meetings m WHERE m.id IN (${upcoming.sql})`).bind(now, ...upcoming.values)]);
  const counts = (results.at(-1) as D1Result<{ selected: number; deferred: number }>).results?.[0];
  return { ...discordCalendarEmptySummary(), queued: catchUp.queued(results, 0), selected: Number(counts?.selected ?? 0), deferred: Number(counts?.deferred ?? 0), deletesQueued: catchUp.deletesQueued(results, 0), remaining: 0, waiting: Number((results.at(-2) as D1Result<{ waiting: number }>).results?.[0]?.waiting ?? 0), perPass: calendarPerPass.discord };
}
/**
 * The Discord card's Retry failed delivery, as the Google card's: failed operations and set-aside removals become due
 * again in one batch, and the scheduler delivers them (the route pokes it). It also ends a hold, so work that was
 * waiting out a refusal goes with them once an Admin has fixed its cause, and `queued` counts that work too.
 */
export async function retryDiscordCalendarOperations(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await requireIntegrationConfigured(env, "discord"); const db = requireDatabase(env); const now = new Date().toISOString();
  const results = await db.batch([calendarFailedRetry(db, "discord", now), calendarRemovalRetry(db, "discord", now), ...discordCalendarHoldRelease(db, now), calendarWaitingCount(db, "discord", now)]);
  // Everything the request made due again: failed operations, set-aside removals, and the work a hold was keeping back.
  const result = { synced: 0, queued: results.slice(0, -1).reduce((total, made) => total + (made.meta?.changes ?? 0), 0), failed: 0 };
  await writeAudit(db, principal, "discord.calendar_retry_requested", "integration", "discord", result);
  return response({ ...result, waiting: Number((results.at(-1) as D1Result<{ waiting: number }>).results?.[0]?.waiting ?? 0), scheduler: calendarSchedulerMode(env), perPass: calendarPerPass.discord });
}
export async function syncAllDiscordCalendarMeetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await requireIntegrationConfigured(env, "discord"); const db = requireDatabase(env);
  const result = await queueAllDiscordCalendarMeetings(db, principal, env);
  await writeAudit(db, principal, "discord.calendar_sync_all_requested", "integration", "discord", { ...result, outcomes: undefined, waiting: undefined, perPass: undefined });
  // nextCursor stays in the response for dashboards that page: one request now covers every meeting.
  return response({ ...result, scheduler: calendarSchedulerMode(env), nextCursor: null, rule: CALENDAR_SYNC_ALL_RULE });
}
export async function discordCalendar(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string; all?: boolean }>(request);
  if (input.all) return response({ ...await queueAllDiscordCalendarMeetings(db, principal, env), scheduler: calendarSchedulerMode(env), rule: CALENDAR_SYNC_ALL_RULE });
  if (!input.meetingId) throw new HttpError(400, "Meeting is required");
  const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<{ id: string; title: string; startsAt: string; endsAt: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found");
  if (Date.parse(meeting.endsAt) < Date.now()) throw new HttpError(409, "Discord calendar sync is unavailable after the scheduled meeting end");
  const sync = discordCalendarSyncStatements(db, calendarTargets.ids([meeting.id]), new Date().toISOString(), principal.userId); const queued = sync.queued(await db.batch(sync.statements), 0);
  // Nothing is queued for a meeting that has started and has no event (Discord cannot schedule one in the past), or while Discord is not verified and the meeting was never synced.
  const skipped = !queued && Date.parse(meeting.startsAt) <= Date.now();
  return response({ ...discordCalendarEmptySummary(), queued, skipped: skipped ? 1 : 0, outcomes: queued ? [{ meetingId: meeting.id, title: meeting.title, status: "queued", reason: "Queued for the scheduled Discord calendar delivery" } satisfies DiscordCalendarOutcome] : skipped ? [{ meetingId: meeting.id, title: meeting.title, status: "skipped", reason: "Meeting has already started and has no Discord event. Sync upcoming meetings before their start time." } satisfies DiscordCalendarOutcome] : [] });
}
type CalendarDeliveryResult = CalendarQueueSummary;
/**
 * Sync now for one meeting. It queues like every other meeting change and the scheduler delivers within seconds on a
 * Durable Object deployment (the route pokes it), or on the next five-minute pass. Delivering inline would cost about 40
 * subrequests with both calendars, too close to the 50 a Workers Free invocation is allowed.
 */
export async function syncMeetingCalendars(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const input = await parseJson<{ meetingId?: string }>(request); const meetingId = input.meetingId?.trim();
  if (!meetingId) throw new HttpError(400, "Meeting is required"); const db = requireDatabase(env);
  const meeting = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ id: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found");
  const [googleReady, discordReady] = await Promise.all([googleCalendarIsReady(env), discordCalendarIsReady(env)]); if (!googleReady && !discordReady) throw new HttpError(409, "Configure and verify at least one calendar integration before syncing this meeting");
  const calendar = calendarLifecycleQueue(db, "sync", calendarTargets.ids([meeting.id]), principal.userId); const providerNames = [...(googleReady ? ["google_calendar" as const] : []), ...(discordReady ? ["discord" as const] : [])];
  const results = await db.batch([...calendar.statements, db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'calendar.meeting_sync_requested', 'meeting', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, meeting.id, JSON.stringify({ providers: providerNames }), new Date().toISOString()), calendarWaitingCount(db, "google_calendar", new Date().toISOString()), calendarWaitingCount(db, "discord", new Date().toISOString())]);
  const delivery: CalendarDeliveryResult = calendar.summary(results, 0); const waiting = (index: number) => Number((results.at(index) as D1Result<{ waiting: number }>).results?.[0]?.waiting ?? 0);
  // `waiting` and `perPass` let the dashboard say how long a backlog will take where the cron delivers it.
  return response({ meetingId: meeting.id, scheduler: calendarSchedulerMode(env), providers: providerNames.map((provider) => ({ provider, ...delivery[provider], waiting: waiting(provider === "google_calendar" ? -2 : -1), perPass: calendarPerPass[provider] })) });
}

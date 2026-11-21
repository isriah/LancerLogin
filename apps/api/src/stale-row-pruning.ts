import type { D1Database, D1Statement } from "./d1-usage.ts";
import { discordKioskCodePruning } from "./discord-kiosk-codes.ts";
import { dataTransferPruning } from "./data-transfer.ts";
import { CALENDAR_OPERATION_RETENTION_DAYS, calendarOperationPruning, calendarQueueUpkeep } from "./calendar-queue.ts";

/** Rows of the tables below are removed this long after they stop mattering. */
export const STALE_ROW_DAYS = 30;
/** The most rows of each table one pass removes, so a pass stays a small write however long rows have piled up. */
export const STALE_ROW_BATCH = 200;
/**
 * An attendance email send still pending this long after it started was cut off (the Worker stopped between claiming the
 * delivery and recording Resend's answer): a send takes seconds, and a dashboard request is cut off well within this. Such
 * a send may be retried, and housekeeping marks it failed so it stops blocking Attendance disablement and cleanup.
 */
export const STALE_EMAIL_DELIVERY_MINUTES = 15;

/**
 * Removes short-lived rows that nothing else deletes, from the scheduled housekeeping pass:
 * - pin_setup_requests: a request 30 days past its expiry. expires_at is the end of a pending request's ten minutes, or
 *   of an approval's five, and a declined request keeps the expiry it had; so every request this removes was resolved or
 *   ran out at least 30 days ago, and a pending request that has not run out is never removed.
 * - discord_label_two_way_previews: a preview 30 days past its expiry, confirmed or not.
 * - kiosk_pin_failure_reports: a report id applied 30 days ago. A report with an id removes these too; this covers a
 *   kiosk that stopped reporting.
 *
 * - google_calendar_operations and discord_calendar_operations: an operation delivered 30 days ago, and a failed upsert
 *   nothing will retry, 30 days old, whose meeting is deleted or ended 30 days ago (calendar-queue.ts). Until migration
 *   0103 nothing removed these. The same batch settles operations waiting on an integration that is switched off and
 *   makes a Discord delivery that died due again (calendarQueueUpkeep).
 *
 * - Finished rows of the tables in retainedRowPruning, below, a few a pass.
 *
 * The batch also removes used and expired Discord kiosk codes, which the pass removed in a query of its own before:
 * one D1 subrequest for all of it, so the pass costs what it did. It also marks failed any email delivery left pending
 * past STALE_EMAIL_DELIVERY_MINUTES, which would otherwise block disabling or cleaning up Attendance forever.
 *
 * The last statement removes backup and restore sessions nobody finished, two hours after they started, with the parts
 * staged for them (data-transfer.ts). It is not counted in the result.
 *
 * Queries: one batch. Each statement changes at most STALE_ROW_BATCH rows; what is left goes on a later pass, five
 * minutes on. Returns how many rows of each table were removed or marked failed.
 */
export async function pruneStaleRows(db: D1Database, now = Date.now(), limit = STALE_ROW_BATCH, retainedLimit = RETAINED_ROW_BATCH) {
  return (await pruneStaleRowsWith(db, [], now, limit, retainedLimit)).removed;
}
/**
 * pruneStaleRows with other statements of the housekeeping pass at the end of the same batch, so they cost no D1
 * subrequest of their own. `alongside` holds their results, in order.
 */
export async function pruneStaleRowsWith(db: D1Database, statements: D1Statement[], now = Date.now(), limit = STALE_ROW_BATCH, retainedLimit = RETAINED_ROW_BATCH) {
  const before = new Date(now - STALE_ROW_DAYS * 86_400_000).toISOString();
  const remove = (table: string, column: string) => db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE installation_id = 'primary' AND ${column} < ? ORDER BY ${column} LIMIT ?)`).bind(before, limit);
  const failStaleDeliveries = db.prepare(`UPDATE integration_deliveries SET status = 'failed', updated_at = ? WHERE rowid IN (SELECT rowid FROM integration_deliveries
    WHERE installation_id = 'primary' AND status = 'pending' AND updated_at < ? ORDER BY updated_at LIMIT ?)`).bind(new Date(now).toISOString(), new Date(now - STALE_EMAIL_DELIVERY_MINUTES * 60_000).toISOString(), limit);
  const calendarBefore = new Date(now - CALENDAR_OPERATION_RETENTION_DAYS * 86_400_000).toISOString();
  const results = await db.batch([remove("pin_setup_requests", "expires_at"), remove("discord_label_two_way_previews", "expires_at"), remove("kiosk_pin_failure_reports", "applied_at"), discordKioskCodePruning(db, now), failStaleDeliveries, ...calendarOperationPruning(db, calendarBefore, limit), ...calendarQueueUpkeep(db, new Date(now).toISOString()), dataTransferPruning(db, now), ...retainedRowPruning(db, now, retainedLimit), ...statements]);
  const removed = (index: number) => results[index]?.meta?.changes ?? 0;
  const retained = results.length - statements.length - RETAINED_ROW_STATEMENTS;
  const counts = { pinSetupRequests: removed(0), discordLabelPreviews: removed(1), pinFailureReports: removed(2), discordKioskCodes: removed(3), staleEmailDeliveries: removed(4), googleCalendarOperations: removed(5) + removed(7), discordCalendarOperations: removed(6) + removed(8),
    discordAttendanceRecipients: removed(retained), emailDeliveries: removed(retained + 1), discordLabelRoleJobs: removed(retained + 2), discordLabelRolePreviews: removed(retained + 3), discordLabelRoleChallenges: removed(retained + 4), kioskCommands: removed(retained + 5) };
  return { removed: counts, alongside: results.slice(results.length - statements.length) };
}

/** How many rows of each table below one pass removes: few, so a backlog drains over days within D1's daily row writes. */
export const RETAINED_ROW_BATCH = 10;
/** Label role sync jobs removed per pass. Each takes its items with it (one per member synced), so one a pass. */
export const LABEL_ROLE_JOB_BATCH = 1;
/** Kiosk commands are kept 90 days, and each kiosk's newest KIOSK_COMMAND_HISTORY always, as its Kiosks card lists them. */
export const KIOSK_COMMAND_RETENTION_DAYS = 90;
export const KIOSK_COMMAND_HISTORY = 12;
const RETAINED_ROW_STATEMENTS = 6;

/**
 * Finished rows of tables nothing else pruned (audit finding 25), each a bounded DELETE in the housekeeping batch, so the
 * pass still costs one D1 subrequest. Migration 0104 indexes what each one searches. Each removes only rows that nothing
 * reads again:
 * - discord_attendance_recipients: delivered 30 days ago, and no longer part of a live notice (the notice's messages were
 *   deleted, or a newer delivery replaced it). A live notice's recipients stay: deleting its messages and resuming a
 *   delivery read them. The contest button reads them for at most the 168-hour contest window.
 * - integration_deliveries: Resend sends that failed (a failed key may be sent again anyway) or delivered `report:` keys
 *   (the key carries its day), 30 days after their last change. A delivered `missed:` key is what stops a missed-meeting
 *   email being sent twice, so it stays; whether to expire it is for the maintainer to decide.
 * - discord_label_role_jobs: finished 30 days ago and not their label's latest job, which the Labels page shows and a
 *   retry starts from. Their items go with them by the foreign key cascade.
 * - discord_label_role_previews and discord_label_role_challenges: 30 days past their expiry (minutes after creation).
 * - kiosk_commands: created 90 days ago, beyond the kiosk's newest 12, and not a successful kiosk update still waiting
 *   for the kiosk to report its new release. A command not delivered within 15 minutes is never delivered.
 */
export function retainedRowPruning(db: D1Database, now: number, limit = RETAINED_ROW_BATCH) {
  const before = new Date(now - STALE_ROW_DAYS * 86_400_000).toISOString();
  const kioskBefore = new Date(now - KIOSK_COMMAND_RETENTION_DAYS * 86_400_000).toISOString();
  const remove = (table: string) => db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE installation_id = 'primary' AND expires_at < ? ORDER BY expires_at LIMIT ?)`).bind(before, limit);
  return [
    db.prepare(`DELETE FROM discord_attendance_recipients WHERE rowid IN (SELECT r.rowid FROM discord_attendance_recipients r WHERE r.installation_id = 'primary' AND r.delivered_at < ?
      AND NOT EXISTS (SELECT 1 FROM discord_attendance_notifications n WHERE n.installation_id = r.installation_id AND n.meeting_id = r.meeting_id AND n.delivery_id IS r.delivery_id AND n.deleted_at IS NULL)
      ORDER BY r.delivered_at LIMIT ?)`).bind(before, limit),
    db.prepare(`DELETE FROM integration_deliveries WHERE rowid IN (SELECT rowid FROM integration_deliveries WHERE installation_id = 'primary' AND status IN ('failed', 'delivered') AND updated_at < ?
      AND provider = 'resend' AND (status = 'failed' OR delivery_key LIKE 'report:%') ORDER BY updated_at LIMIT ?)`).bind(before, limit),
    db.prepare(`DELETE FROM discord_label_role_jobs WHERE rowid IN (SELECT j.rowid FROM discord_label_role_jobs j WHERE j.installation_id = 'primary' AND j.completed_at < ? AND j.status IN ('completed', 'partial', 'stale')
      AND EXISTS (SELECT 1 FROM discord_label_role_jobs n WHERE n.installation_id = j.installation_id AND n.label_id = j.label_id AND n.created_at > j.created_at)
      ORDER BY j.completed_at LIMIT ?)`).bind(before, Math.min(limit, LABEL_ROLE_JOB_BATCH)),
    remove("discord_label_role_previews"),
    remove("discord_label_role_challenges"),
    db.prepare(`DELETE FROM kiosk_commands WHERE rowid IN (SELECT c.rowid FROM kiosk_commands c WHERE c.installation_id = 'primary' AND c.created_at < ?
      AND NOT (c.command_type = 'install_latest' AND c.completed_at IS NOT NULL AND COALESCE(c.success, 0) = 1 AND c.resolution_status IS NULL)
      AND (SELECT COUNT(*) FROM (SELECT 1 FROM kiosk_commands n WHERE n.kiosk_id = c.kiosk_id AND n.created_at > c.created_at LIMIT ${KIOSK_COMMAND_HISTORY})) = ${KIOSK_COMMAND_HISTORY}
      ORDER BY c.created_at LIMIT ?)`).bind(kioskBefore, limit),
  ];
}

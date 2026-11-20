import type { D1Database } from "./d1-usage.ts";
import { discordKioskCodePruning } from "./discord-kiosk-codes.ts";

/** Rows of the tables below are removed this long after they stop mattering. */
export const STALE_ROW_DAYS = 30;
/** The most rows of each table one pass removes, so a pass stays a small write however long rows have piled up. */
export const STALE_ROW_BATCH = 200;

/**
 * Removes short-lived rows that nothing else deletes, from the scheduled housekeeping pass:
 * - pin_setup_requests: a request 30 days past its expiry. expires_at is the end of a pending request's ten minutes, or
 *   of an approval's five, and a declined request keeps the expiry it had; so every request this removes was resolved or
 *   ran out at least 30 days ago, and a pending request that has not run out is never removed.
 * - discord_label_two_way_previews: a preview 30 days past its expiry, confirmed or not.
 * - kiosk_pin_failure_reports: a report id applied 30 days ago. A report with an id removes these too; this covers a
 *   kiosk that stopped reporting.
 *
 * The batch also removes used and expired Discord kiosk codes, which the pass removed in a query of its own before:
 * one D1 subrequest for all four, so the pass costs what it did.
 *
 * Queries: one batch. Each of the three statements above removes at most STALE_ROW_BATCH rows; what is left goes on a
 * later pass, five minutes on. Returns how many rows of each table were removed.
 */
export async function pruneStaleRows(db: D1Database, now = Date.now(), limit = STALE_ROW_BATCH) {
  const before = new Date(now - STALE_ROW_DAYS * 86_400_000).toISOString();
  const remove = (table: string, column: string) => db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE installation_id = 'primary' AND ${column} < ? ORDER BY ${column} LIMIT ?)`).bind(before, limit);
  const results = await db.batch([remove("pin_setup_requests", "expires_at"), remove("discord_label_two_way_previews", "expires_at"), remove("kiosk_pin_failure_reports", "applied_at"), discordKioskCodePruning(db, now)]);
  const removed = (index: number) => results[index]?.meta?.changes ?? 0;
  return { pinSetupRequests: removed(0), discordLabelPreviews: removed(1), pinFailureReports: removed(2), discordKioskCodes: removed(3) };
}

import { type PassCost } from "../scheduler-budget.ts";
import { type JobRunResult } from "../platform-scheduler.ts";
import { type Env, passAllows, requireDatabase, requireRole, response, writeAudit } from "./core.ts";
import { deliveryPausedUntil } from "./delivery.ts";
import { discordConfiguration } from "./discord-core.ts";
import { discordAttendanceReportComponents, upsertTrackedDiscordMessage } from "./discord-notifications.ts";
import type { PairedKiosk } from "./kiosks.ts";

/** A kiosk counts as online in the status message while its last heartbeat is newer than this. */
const KIOSK_STATUS_ONLINE_MS = 2 * 60_000;
/**
 * How often an unchanged tracked Discord message (the kiosk status, the help message) is checked against Discord: that
 * it still exists and, where it should be, is still pinned. Between checks an unchanged message costs no request.
 */
const DISCORD_TRACKED_MESSAGE_REFRESH_MS = 60 * 60_000;
/**
 * Whether a heartbeat changes this kiosk's line in the status message, decided from the row the heartbeat's
 * authentication already read: the kiosk was not online before, or its reader state or release differs.
 */
export function kioskStatusLineChanged(before: Pick<PairedKiosk, "lastSeenAt" | "readerOnline" | "releaseVersion">, reported: { readerOnline: boolean; releaseVersion: string }, now: number): boolean {
  const seen = Date.parse(before.lastSeenAt ?? "");
  return !Number.isFinite(seen) || now - seen >= KIOSK_STATUS_ONLINE_MS || Boolean(before.readerOnline) !== reported.readerOnline || (before.releaseVersion ?? null) !== reported.releaseVersion;
}
/**
 * Posts or edits the kiosk status message when what it shows has changed. `verify` also checks an unchanged message
 * against Discord now (the Update status button); the scheduled job leaves that to the hourly refresh.
 */
async function syncDiscordKioskStatus(env: Env, pin?: boolean, verify = false): Promise<{ changed: boolean; messageId?: string; online?: boolean; kioskId?: string }> {
  // While delivery is stopped the status message is left as it is; the channel job refreshes it once delivery resumes.
  if (await deliveryPausedUntil(env) !== null) return { changed: false };
  const db = requireDatabase(env); const config = await discordConfiguration(env);
  if (pin === undefined) {
    const settings = await db.prepare("SELECT discord_channel_manager_enabled AS enabled FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number }>();
    pin = Boolean(settings?.enabled);
  }
  const result = await db.prepare("SELECT id, name, last_seen_at AS lastSeenAt, reader_online AS readerOnline, release_version AS releaseVersion FROM kiosks WHERE installation_id = 'primary' AND active = 1 ORDER BY lower(name), created_at").all<{ id: string; name: string; lastSeenAt?: string; readerOnline?: number; releaseVersion?: string }>();
  const kiosks = result.results ?? [];
  const states = kiosks.map((kiosk) => ({ kiosk, online: Boolean(kiosk.lastSeenAt && Date.now() - Date.parse(kiosk.lastSeenAt) < KIOSK_STATUS_ONLINE_MS) }));
  const onlineCount = states.filter((state) => state.online).length;
  const online = kiosks.length > 0 && onlineCount === kiosks.length;
  const visible = states.slice(0, 10);
  const content = kiosks.length
    ? [`**Kiosk status** · ${onlineCount} of ${kiosks.length} online`, ...visible.map(({ kiosk, online: kioskOnline }) => `• **${kiosk.name}** · ${kioskOnline ? "online" : "offline"} · reader ${kiosk.readerOnline ? "online" : "offline"} · release ${kiosk.releaseVersion ?? "unknown"}${kioskOnline ? "" : ` · last seen ${kiosk.lastSeenAt ?? "never"}`}`), ...(kiosks.length > visible.length ? [`• ${kiosks.length - visible.length} more active kiosks are available in the dashboard.`] : [])].join("\n")
    : "No kiosk is paired.";
  const kioskId = kiosks.length === 1 ? kiosks[0]!.id : undefined;
  // Pinned (the channel manager) or not, the message is tracked the same way: one row holding its id and content hash.
  const tracked = await upsertTrackedDiscordMessage(db, config, "kiosk-status", content, pin, undefined, verify ? 0 : DISCORD_TRACKED_MESSAGE_REFRESH_MS);
  return { changed: tracked.changed, ...(tracked.messageId ? { messageId: tracked.messageId } : {}), online, kioskId };
}
// One tracked message: its row, the kiosks (for the status), a claim and the write; and up to 4 Discord requests when it
// has to be re-posted and pinned (the check, the edit that finds it gone, the new message, the pin).
const DISCORD_TRACKED_MESSAGE_COST: PassCost = { d1: 5, external: 4 };
export async function syncDiscordManagedSurface(env: Env): Promise<JobRunResult> {
  if (await deliveryPausedUntil(env) !== null) return;
  const db = requireDatabase(env);
  // The job's first step is due again whenever the budget cannot cover a message; the failed check asks for that slice.
  if (!passAllows(env, DISCORD_TRACKED_MESSAGE_COST)) return;
  const settings = await db.prepare("SELECT discord_channel_manager_enabled AS enabled FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number }>();
  if (!settings?.enabled) { await syncDiscordKioskStatus(env, false); return; }
  // On the Durable Object the pinned kiosk status and the help message are separate slices, one Discord message each.
  const step = env.schedulerPass?.steps ? env.schedulerPass.cursor ?? "kiosk-status" : undefined;
  if (step !== "howto") {
    await syncDiscordKioskStatus(env, true);
    if (step) return { more: true, cursor: "howto" };
  }
  if (!passAllows(env, DISCORD_TRACKED_MESSAGE_COST)) return step ? { more: true, cursor: "howto" } : undefined;
  const config = await discordConfiguration(env);
  const guidance = "**LancerLogin attendance help**\nUse `/pair` with your LancerLogin member ID to link your Discord account. Use **View my attendance report** below or `/attendance-report` to receive your private report. Ask general questions in the thread under each absence notice. Only a mentioned linked member can use **Contest absence** during the configured contest window. A contest requests private review; it does not change attendance until an Operator or Admin approves it.";
  await upsertTrackedDiscordMessage(db, config, "channel-manager-howto", guidance, false, discordAttendanceReportComponents, DISCORD_TRACKED_MESSAGE_REFRESH_MS);
}
export async function discordKioskStatus(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]);
  // The button always checks the message against Discord, so one deleted by hand is posted again at once.
  const result = await syncDiscordKioskStatus(env, undefined, true);
  await writeAudit(requireDatabase(env), principal, "discord.kiosk_status_updated", "kiosk", result.kioskId ?? null, { online: result.online, messageId: result.messageId, changed: result.changed });
  const config = await discordConfiguration(env);
  const messageUrl = result.messageId ? `https://discord.com/channels/${config.guildId}/${config.channelId}/${result.messageId}` : undefined;
  return response({ changed: result.changed, messageId: result.messageId, online: result.online, messageUrl });
}

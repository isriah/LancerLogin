import { WebUpdateError, type WebUpdateEnv } from "./web-updates.ts";
import type { UpdateChannel } from "../../../packages/shared/src/release-policy.mjs";
export type ChannelSetting = { channel: UpdateChannel; revision: number };
export async function readUpdateChannel(env: WebUpdateEnv): Promise<ChannelSetting> {
  if (!env.DB) throw new WebUpdateError(503, "not_configured", "D1 is not linked.");
  const value = await env.DB.prepare("SELECT update_channel AS channel, update_channel_revision AS revision FROM installation_update_settings WHERE installation_id = 'primary'").first<ChannelSetting>();
  if (!value || !["stable", "beta"].includes(value.channel) || !Number.isSafeInteger(value.revision)) throw new WebUpdateError(503, "not_configured", "Update channel configuration is unavailable.");
  return { channel: value.channel, revision: value.revision };
}
export async function changeUpdateChannel(env: WebUpdateEnv, input: Record<string, unknown>, actorId: string) {
  if (Object.keys(input).some((key) => !["channel", "revision", "betaConfirmed"].includes(key)) || !["stable", "beta"].includes(String(input.channel)) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
    throw new WebUpdateError(400, "invalid_request", "Choose Stable or Beta using the current setting.");
  if (input.channel === "beta" && input.betaConfirmed !== true) throw new WebUpdateError(400, "beta_confirmation_required", "Confirm that beta releases may be unstable and cannot be automatically downgraded.");
  const current = await readUpdateChannel(env);
  if (current.revision !== input.revision) throw new WebUpdateError(409, "channel_changed", "The update channel changed in another session. Reload its setting.");
  if (current.channel === input.channel) return current;
  const now = new Date().toISOString(); const auditId = crypto.randomUUID(); const database = env.DB!;
  if (!database.batch) throw new WebUpdateError(503, "not_configured", "Atomic update settings are unavailable.");
  // One D1 transaction serializes channel changes against prepared/started requests.
  // The immutable audit marker gates follow-up statements even when the CAS loses.
  await database.batch([
    database.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'update_channel.changed', 'installation', 'primary', ?, ? WHERE EXISTS (SELECT 1 FROM installation_update_settings WHERE installation_id = 'primary' AND update_channel_revision = ?) AND NOT EXISTS (SELECT 1 FROM web_update_requests WHERE installation_id = 'primary' AND state NOT IN ('prepared','succeeded','failed','expired')) AND NOT EXISTS (SELECT 1 FROM kiosk_commands WHERE installation_id = 'primary' AND command_type = 'install_latest' AND (completed_at IS NULL OR success = 1 AND resolution_status IS NULL) AND created_at >= ?)")
      .bind(auditId, actorId, JSON.stringify({ previousChannel: current.channel, channel: input.channel }), now, input.revision, new Date(Date.now() - 15 * 60_000).toISOString()),
    database.prepare("UPDATE installation_update_settings SET update_channel = ?, update_channel_revision = update_channel_revision + 1 WHERE installation_id = 'primary' AND update_channel_revision = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND installation_id = 'primary')").bind(input.channel, input.revision, auditId),
    database.prepare("UPDATE web_update_requests SET state = 'expired', error_code = 'channel_changed', updated_at = ? WHERE installation_id = 'primary' AND state = 'prepared' AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND installation_id = 'primary')").bind(now, auditId),
  ]);
  const accepted = await database.prepare("SELECT id FROM audit_log WHERE installation_id = 'primary' AND id = ?").bind(auditId).first();
  if (!accepted) throw new WebUpdateError(409, "channel_locked", "Finish the active update before changing tracks, or reload a setting changed by another Admin.");
  return readUpdateChannel(env);
}

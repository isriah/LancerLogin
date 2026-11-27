import { integrationKeyUsable } from "../integration-crypto.ts";
import { type D1Database } from "../d1-usage.ts";
import { SchedulerBudgetError, type PassCost } from "../scheduler-budget.ts";
import { HttpError } from "../http-error.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { type Env, IntegrationUnreadableError, type ProviderConfiguration, passAllows, randomToken, requireDatabase, requireRole, response, sha256, sha256Hex, writeAudit } from "./core.ts";
import { deliveryPausedUntil } from "./delivery.ts";
import { discordConfiguration, discordRequest } from "./discord-core.ts";
import { integrationRecord } from "./integration-support.ts";

type DiscordApplicationCommand = { id?: string; application_id?: string; guild_id?: string; name?: string; type?: number; description?: string; options?: readonly { name?: string; description?: string; type?: number; required?: boolean }[] };
const coreDiscordManagedCommands: DiscordApplicationCommand[] = [
  { name: "pair", type: 1, description: "Link your Discord account to your LancerLogin member ID", options: [{ name: "member-id", description: "Your LancerLogin member ID", type: 3, required: true }] },
  { name: "attendance-report", type: 1, description: "Privately view your current LancerLogin attendance report" },
  { name: "code", type: 1, description: "Get a one-time code to sign in at a kiosk" },
  { name: "label", type: 1, description: "Associate a Discord role with a matching LancerLogin label", options: [{ name: "role", description: "Discord role to associate", type: 8, required: true }] },
];
const discordManagedCommands: DiscordApplicationCommand[] = [...coreDiscordManagedCommands, ...bundledModuleRegistry.modules.flatMap((module) => module.discordCommands)];
if (new Set(discordManagedCommands.map((command) => command.name)).size !== discordManagedCommands.length) throw new Error("Discord command registration collision");
function discordCommandMatches(actual: DiscordApplicationCommand, expected: DiscordApplicationCommand, config: Record<string, string>): boolean {
  const optionShape = (option: NonNullable<DiscordApplicationCommand["options"]>[number]) => ({ name: option.name, description: option.description, type: option.type, required: Boolean(option.required) });
  return actual.application_id === config.applicationId && actual.guild_id === config.guildId && actual.name === expected.name && actual.type === expected.type && actual.description === expected.description && JSON.stringify((actual.options ?? []).map(optionShape)) === JSON.stringify((expected.options ?? []).map(optionShape));
}
async function reconcileDiscordApplicationCommands(config: Record<string, string>): Promise<{ applicationId: string; commands: string[] }> {
  const application = await discordRequest<{ id?: string }>(config, "/oauth2/applications/@me", { method: "GET" });
  const applicationId = String(application.body.id ?? "");
  if (!/^\d{10,24}$/.test(applicationId)) throw new HttpError(502, "Discord did not return the bot application's identity. Confirm the saved bot token and try command reconciliation again.");
  if (config.applicationId && applicationId !== config.applicationId) throw new HttpError(400, "The saved Application ID does not belong to this bot token. Copy the Application ID from the same Discord application and replace the saved credentials.");
  const resolvedConfig = { ...config, applicationId };
  const guild = await discordRequest<{ id?: string }>(config, `/guilds/${encodeURIComponent(config.guildId)}`, { method: "GET" });
  if (String(guild.body.id ?? "") !== config.guildId) throw new HttpError(400, "Discord returned a different server than the saved Server ID. Copy the intended server ID and replace the saved credentials.");
  const channel = await discordRequest<{ guild_id?: string; type?: number }>(config, `/channels/${encodeURIComponent(config.channelId)}`, { method: "GET" });
  if (String(channel.body.guild_id ?? "") !== config.guildId || Number(channel.body.type) !== 0) throw new HttpError(400, "The attendance channel must be a text channel in the saved Discord server. Copy the intended channel and server IDs, then replace the saved credentials.");
  const path = `/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(config.guildId)}/commands`;
  const existing = await discordRequest<DiscordApplicationCommand[]>(config, path, { method: "GET" });
  if (!Array.isArray(existing.body)) throw new HttpError(502, "Discord did not return the server command list.");
  for (const expected of discordManagedCommands) {
    if (existing.body.some((actual) => discordCommandMatches(actual, expected, resolvedConfig))) continue;
    await discordRequest(config, path, { method: "POST", body: JSON.stringify(expected) });
  }
  const result = await discordRequest<DiscordApplicationCommand[]>(config, path, { method: "GET" });
  if (!Array.isArray(result.body) || discordManagedCommands.some((expected) => !result.body.some((actual) => discordCommandMatches(actual, expected, resolvedConfig)))) {
    throw new HttpError(502, "Discord did not confirm the managed commands. Wait briefly and try command setup again.");
  }
  return { applicationId, commands: discordManagedCommands.map((command) => String(command.name)) };
}
async function discordCommandFingerprint(config: Record<string, string>): Promise<string> {
  return sha256Hex(JSON.stringify({ applicationId: config.applicationId, guildId: config.guildId, commands: discordManagedCommands }));
}
export async function discordCommandStatus(env: Env): Promise<{ commandStatus: "unavailable" | "pending" | "ready" | "failed"; commandError?: string; commandsUpdatedAt?: string }> {
  const record = await integrationRecord(env, "discord");
  if (!record || !record.enabled || !record.verifiedAt || !integrationKeyUsable(env.INTEGRATION_KEY)) return { commandStatus: "unavailable" };
  // Credentials that cannot be read have no commands to report; the card says so through the integration's own state.
  let config: ProviderConfiguration; try { config = await discordConfiguration(env); } catch (error) { if (error instanceof IntegrationUnreadableError) return { commandStatus: "unavailable" }; throw error; }
  const fingerprint = await discordCommandFingerprint(config);
  const result = await requireDatabase(env).prepare("SELECT state_key AS stateKey, external_id AS externalId, content_hash AS contentHash, updated_at AS updatedAt FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key IN ('managed-commands', 'managed-commands-error')").all<{ stateKey: string; externalId?: string; contentHash?: string; updatedAt: string }>();
  const rows = new Map((result.results ?? []).map((row) => [row.stateKey, row]));
  const success = rows.get("managed-commands");
  if (success?.contentHash === fingerprint) return { commandStatus: "ready", commandsUpdatedAt: success.updatedAt };
  const failure = rows.get("managed-commands-error");
  return failure?.externalId === fingerprint ? { commandStatus: "failed", commandError: failure.contentHash ?? "Command setup failed", commandsUpdatedAt: failure.updatedAt } : { commandStatus: "pending" };
}
async function saveDiscordCommandSuccess(db: D1Database, config: Record<string, string>): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', 'managed-commands', ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(config.guildId, await discordCommandFingerprint(config), now), db.prepare("DELETE FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'managed-commands-error'")]);
}
const DISCORD_COMMAND_RECONCILE_COST: PassCost = { d1: 4, external: 8 };
export async function autoReconcileDiscordCommands(env: Env): Promise<void> {
  if (await deliveryPausedUntil(env) !== null) return;
  const db = requireDatabase(env);
  const record = await integrationRecord(env, "discord");
  if (!record || !record.enabled || !record.verifiedAt || !env.INTEGRATION_KEY) return;
  const config = await discordConfiguration(env);
  const fingerprint = await discordCommandFingerprint(config);
  const success = await db.prepare("SELECT content_hash AS fingerprint FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'managed-commands'").first<{ fingerprint?: string }>();
  if (success?.fingerprint === fingerprint) return;
  // Reconciling costs up to 8 Discord requests (the application, the server, the channel, the command list and a write
  // for each managed command that differs) and 4 D1 queries (the claim, the result, its audit entry). The attempt is
  // claimed only when the pass can cover all of it; otherwise the failed check brings the job back in a fresh slice.
  if (!passAllows(env, DISCORD_COMMAND_RECONCILE_COST)) return;
  const now = new Date(); const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const claim = await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, updated_at) VALUES ('primary', 'discord', 'managed-commands-attempt', ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, updated_at = excluded.updated_at WHERE integration_state.external_id != excluded.external_id OR integration_state.updated_at < ?").bind(fingerprint, now.toISOString(), cutoff).run();
  if (!claim.meta?.changes) return;
  try {
    await reconcileDiscordApplicationCommands(config);
    await saveDiscordCommandSuccess(db, config);
    await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', NULL, 'discord.commands_auto_reconciled', 'integration', 'discord', ?, ?)").bind(crypto.randomUUID(), JSON.stringify({ guildId: config.guildId, commands: discordManagedCommands.map((command) => command.name) }), new Date().toISOString()).run();
  } catch (error) {
    // The budget's refusal is not Discord's answer: nothing is recorded as a command failure.
    if (error instanceof SchedulerBudgetError) throw error;
    const detail = error instanceof HttpError ? error.message.slice(0, 180) : "Discord command setup could not complete. Retry in Settings or check the saved bot connection.";
    await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', 'managed-commands-error', ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(fingerprint, detail, new Date().toISOString()).run();
  }
}
export async function startDiscordVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const config = await discordConfiguration(env, true);
  await db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'discord'").run();
  await discordRequest(config, "/users/@me", { method: "GET" });
  await reconcileDiscordApplicationCommands(config);
  const challenge = randomToken(24); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const payload = { content: "LancerLogin is ready to verify this server and attendance channel. An Admin should click the button below within 10 minutes.", allowed_mentions: { parse: [] }, components: [{ type: 1, components: [{ type: 2, style: 1, label: "Verify LancerLogin", custom_id: `lancerlogin-verify:${challenge}` }] }] };
  const { body } = await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages`, { method: "POST", body: JSON.stringify(payload) }); const messageId = String(body.id ?? "");
  if (!messageId) throw new HttpError(502, "Discord did not return a verification message identifier");
  await db.prepare("INSERT INTO integration_verification_challenges (installation_id, provider, challenge_hash, target, external_id, expires_at, created_by, created_at) VALUES ('primary', 'discord', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET challenge_hash = excluded.challenge_hash, target = excluded.target, external_id = excluded.external_id, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = excluded.created_at").bind(await sha256(challenge), config.guildId, messageId, expiresAt, principal.userId, now.toISOString()).run();
  await writeAudit(db, principal, "integration.verification_started", "integration", "discord", { guildId: config.guildId, channelId: config.channelId, messageId });
  return response({ provider: "discord", verificationPending: true, expiresAt, messageId }, 202);
}
// Opening Settings > Integrations runs the maintenance pass's own guarded reconcile while commands are pending, so the
// status settles in seconds instead of at the next pass. The attempt claim keeps it from overlapping a maintenance run.
export async function checkDiscordCommands(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  if ((await discordCommandStatus(env)).commandStatus === "pending") await autoReconcileDiscordCommands(env);
  return response(await discordCommandStatus(env));
}
export async function reconcileDiscordCommands(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const config = await discordConfiguration(env);
  const reconciled = await reconcileDiscordApplicationCommands(config);
  await saveDiscordCommandSuccess(db, config);
  await writeAudit(db, principal, "discord.commands_reconciled", "integration", "discord", { applicationId: reconciled.applicationId, guildId: config.guildId, commands: reconciled.commands });
  return response({ provider: "discord", reconciled: true, commands: reconciled.commands });
}

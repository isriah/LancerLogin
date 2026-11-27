import { calendarCatchUp, calendarRemovalDisconnectStatements, calendarRemovalStatusSql, discordCalendarConnect, discordCalendarLeave, discordCalendarServerForget, discordCalendarServerRecord, discordCredentialsStill, type CalendarProvider } from "../calendar-queue.ts";
import { decryptIntegration } from "../integration-crypto.ts";
import { clearFirstCache, firstDataService, firstIntegrationStatus, removeFirstCredential, saveFirstCredential } from "../first-data.ts";
import { notionIntegrationStatus, removeNotionBinding, removeNotionConnection, saveNotionConnection, setNotionBinding } from "../module-notion.ts";
import { type D1Database, type D1Result } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { type DiscordAnomalyReportsInput, type DiscordChannelManagerInput, EmailProviderError, type Env, type GoogleCalendarSecret, IntegrationUnreadableError, type Principal, allInOrder, authorizedRead, googleCalendarReauthorizationRequired, integrationSecretUnreadable, parseJson, readIntegrationSecret, requireDatabase, requireProviderAuthority, requireRole, resendErrorMessage, response, sealIntegrationSecret, sha256, validEmail, writeAudit } from "./core.ts";
import { discordCommandStatus } from "./discord-commands.ts";
import { discordConfiguration, discordRequest } from "./discord-core.ts";
import { type IntegrationProvider, type IntegrationRecord, discordInteractionsUrl, googleCalendarAuthorizationRecord, googleCalendarRedirectUri, googleRedirectUri, integrationFlagColumns, integrationFlagSqlColumns, integrationFlags, integrationIsEnabled, integrationProviders, integrationRecord, markIntegrationVerified, optionalPublicUrl, requireIntegrationConfigured, requireIntegrationEnabled, validateIntegration } from "./integration-support.ts";
import { firstDataDeps, notionDeps } from "./module-runtime.ts";

async function googleCalendarIntegrationStatus(env: Env) {
  const db = requireDatabase(env); const [record, queue] = await Promise.all([
    googleCalendarAuthorizationRecord(env),
    calendarQueueCounts(db, "google_calendar"),
  ]);
  let calendarName: string | undefined; let reauthorizationRequired = false;
  // A refresh token Google refused clears authorized_at but stays stored, which marks the saved setup as needing
  // re-authorization; so does a refresh token past the lifetime Google gave it, before any delivery has tried it.
  // Saved credentials that cannot be read are reported as such: the card then asks for them again instead of showing a
  // calendar that nothing can reach. Status must not expose or depend on secret values.
  let unreadable = false;
  if (record?.ciphertext && env.INTEGRATION_KEY) try { const stored = await readIntegrationSecret(env, "google_calendar", record.ciphertext, record.iv) as GoogleCalendarSecret; calendarName = stored.calendarLabel; reauthorizationRequired = googleCalendarReauthorizationRequired(record, stored); } catch (error) { unreadable = error instanceof IntegrationUnreadableError; }
  const enabled = Boolean(record?.enabled); const saved = Boolean(record?.ciphertext); const configured = enabled && Boolean(record?.verifiedAt) && !unreadable;
  return { provider: "google_calendar" as const, enabled, saved, authorized: Boolean(record?.authorizedAt) && !reauthorizationRequired, reauthorizationRequired, configured, state: !enabled ? "disabled" as const : !saved ? "not_configured" as const : unreadable ? "unreadable" as const : configured ? "configured" as const : "verification_required" as const, ...(unreadable ? { unreadable } : {}), updatedAt: record?.updatedAt ?? undefined, verifiedAt: record?.verifiedAt ?? undefined, calendarName, ...queue };
}
/**
 * What an integration card shows of a provider's queue: operations waiting and failed, together with the event removals
 * left by deleted data (waiting, and set aside after their last attempt), and one error to explain a failure.
 */
async function calendarQueueCounts(db: D1Database, provider: CalendarProvider) {
  type Counts = { pending?: number; failed?: number; lastError?: string | null; pendingRemovals?: number; failedRemovals?: number; removalError?: string | null };
  const operations = `SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, MAX(CASE WHEN status = 'failed' THEN last_error ELSE NULL END) AS lastError`; const table = `${provider === "discord" ? "discord" : "google"}_calendar_operations WHERE installation_id = 'primary'`;
  const queue = await db.prepare(`SELECT ${operations}, ${calendarRemovalStatusSql(provider)} FROM ${table}`).first<Counts>();
  const removalNote = queue?.failedRemovals ? `${queue.failedRemovals} calendar event${queue.failedRemovals === 1 ? "" : "s"} of deleted meetings could not be removed: ${queue.removalError ?? "the provider refused"}` : undefined;
  return { pendingOperations: Number(queue?.pending ?? 0) + Number(queue?.pendingRemovals ?? 0), failedOperations: Number(queue?.failed ?? 0) + Number(queue?.failedRemovals ?? 0), lastError: queue?.lastError ?? removalNote ?? undefined };
}
const discordCalendarQueueStatus = (env: Env) => calendarQueueCounts(requireDatabase(env), "discord");
export async function integrationsStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const [result, flags, calendar, discordCalendar, discordCommands] = await Promise.all([requireDatabase(env).prepare("SELECT i.provider, i.ciphertext, i.iv, i.updated_at AS updatedAt, i.verified_at AS verifiedAt, EXISTS(SELECT 1 FROM integration_verification_challenges c WHERE c.installation_id = i.installation_id AND c.provider = i.provider AND c.expires_at > ?) AS verificationPending FROM encrypted_integrations i WHERE i.installation_id = 'primary' ORDER BY i.provider").bind(new Date().toISOString()).all<{ provider: IntegrationProvider; ciphertext?: string | null; iv?: string | null; updatedAt: string; verifiedAt?: string | null; verificationPending: number }>(), integrationFlags(env), googleCalendarIntegrationStatus(env), discordCalendarQueueStatus(env), discordCommandStatus(env)]);
  const saved = new Map((result.results ?? []).map((item) => [item.provider, item]));
  // Each saved provider's credentials are tried once (a small AES-GCM decrypt, no query): the ones that cannot be read
  // are reported as unreadable, never as configured, so the card asks for them again. No credential leaves this function.
  const unreadable = new Set<IntegrationProvider>();
  for (const item of saved.values()) if (await integrationSecretUnreadable(env, item.provider, item.ciphertext, item.iv)) unreadable.add(item.provider);
  return response({ integrations: [...[...integrationProviders].map((provider) => { const item = saved.get(provider); const enabled = Boolean(flags[integrationFlagColumns[provider]]); const unread = unreadable.has(provider); return { provider, enabled, saved: Boolean(item), configured: enabled && Boolean(item?.verifiedAt) && !unread, state: !enabled ? "disabled" : !item ? "not_configured" : unread ? "unreadable" : item.verifiedAt ? "configured" : "verification_required", ...(unread ? { unreadable: true } : {}), updatedAt: item?.updatedAt, verifiedAt: item?.verifiedAt ?? undefined, verificationPending: enabled && Boolean(item?.verificationPending), ...(provider === "google" ? { redirectUri: optionalPublicUrl(() => googleRedirectUri(env)) } : {}), ...(provider === "discord" ? { ...discordCalendar, ...discordCommands, interactionsUrl: optionalPublicUrl(() => discordInteractionsUrl(env)) } : {}) }; }), { ...calendar, redirectUri: optionalPublicUrl(() => googleCalendarRedirectUri(env)) }] });
}
/**
 * Settings > Integrations > FIRST (first-data.ts): status, check-and-save and remove a program's credential, test a team
 * and clear cached answers. Admin only; tokens never return. A test lookup counts only toward the installation limit.
 */
export async function firstIntegration(request: Request, env: Env, url: URL): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const deps = firstDataDeps(env);
  if (url.pathname.endsWith("/lookup")) { const input = await parseJson<Record<string, unknown>>(request, 1024); return response(await firstDataService(deps, { moduleId: "core", visitor: async () => null }).lookupTeam({ program: input?.program as never, number: input?.number as string })); }
  if (url.pathname.endsWith("/clear-cache")) { await clearFirstCache(deps); await writeAudit(deps.db, principal, "integration.first_cache_cleared", "integration", "first"); return response(await firstIntegrationStatus(deps)); }
  if (request.method === "PUT") { const program = await saveFirstCredential(deps, await parseJson(request, 2048)); await writeAudit(deps.db, principal, "integration.saved", "integration", `first:${program}`); return response(await firstIntegrationStatus(deps)); }
  if (request.method === "DELETE") { const program = await removeFirstCredential(deps, url.searchParams.get("program")); await writeAudit(deps.db, principal, "integration.removed", "integration", `first:${program}`); return response(await firstIntegrationStatus(deps)); }
  return response(await firstIntegrationStatus(deps));
}
/**
 * Settings > Integrations > Notion (module-notion.ts): status, save or check the token, turn the connection on or off,
 * remove it, and choose or clear the database for a binding a module declared. Admin only, changes from the dashboard
 * origin only, each audited. The token never returns.
 */
export async function notionIntegration(request: Request, env: Env, url: URL): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const deps = notionDeps(env);
  if (request.method !== "GET" && request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Notion changes require the dashboard origin");
  const modules = bundledModuleRegistry.modules;
  const binding = /^\/admin\/integrations\/notion\/bindings\/([a-z0-9-]{1,64})\/([a-z0-9-]{1,40})$/.exec(url.pathname);
  if (url.pathname !== "/admin/integrations/notion" && !binding) throw new HttpError(404, "Not found");
  if (binding) {
    const moduleId = binding[1]!, bindingId = binding[2]!; const target = `notion:${moduleId}:${bindingId}`;
    if (request.method === "DELETE") {
      if (await removeNotionBinding(deps, moduleId, bindingId)) await writeAudit(deps.db, principal, "integration.notion_binding_removed", "integration", target);
      return response({ bound: false, dataSources: [], integration: await notionIntegrationStatus(deps, modules) });
    }
    const result = await setNotionBinding(deps, modules, moduleId, bindingId, await parseJson(request, 4096));
    if (result.bound) await writeAudit(deps.db, principal, "integration.notion_binding_set", "integration", target);
    return response({ bound: result.bound, dataSources: result.bound ? [] : result.dataSources, integration: await notionIntegrationStatus(deps, modules) });
  }
  if (request.method === "PUT") { const change = await saveNotionConnection(deps, await parseJson(request, 4096)); await writeAudit(deps.db, principal, change === "saved" ? "integration.saved" : `integration.notion_${change}`, "integration", "notion"); }
  if (request.method === "DELETE") { await removeNotionConnection(deps); await writeAudit(deps.db, principal, "integration.removed", "integration", "notion"); }
  return response(await notionIntegrationStatus(deps, modules));
}
export async function discordChannelManagerSettings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") {
    const settings = await db.prepare("SELECT discord_channel_manager_enabled AS enabled, discord_contest_window_hours AS contestWindowHours, discord_block_recontests_after_rejection AS blockRecontestsAfterRejection FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number; contestWindowHours?: number; blockRecontestsAfterRejection?: number }>();
    return response({ enabled: Boolean(settings?.enabled), contestWindowHours: settings?.contestWindowHours ?? 24, blockRecontestsAfterRejection: Boolean(settings?.blockRecontestsAfterRejection) });
  }
  const input = await parseJson<DiscordChannelManagerInput>(request); const errors: string[] = [];
  if (typeof input.enabled !== "boolean") errors.push("Channel manager enabled must be true or false");
  if (input.blockRecontestsAfterRejection !== undefined && typeof input.blockRecontestsAfterRejection !== "boolean") errors.push("Block re-contests after rejection must be a boolean");
  if (!Number.isInteger(input.contestWindowHours) || input.contestWindowHours! < 1 || input.contestWindowHours! > 168) errors.push("Discord contest window must be from 1 to 168 hours");
  if (errors.length) throw new HttpError(400, "Invalid Discord channel manager settings", errors);
  await db.prepare("UPDATE organization_settings SET discord_channel_manager_enabled = ?, discord_contest_window_hours = ?, discord_block_recontests_after_rejection = COALESCE(?, discord_block_recontests_after_rejection) WHERE installation_id = 'primary'").bind(input.enabled ? 1 : 0, input.contestWindowHours, input.blockRecontestsAfterRejection === undefined ? null : input.blockRecontestsAfterRejection ? 1 : 0).run();
  await writeAudit(db, principal, "discord.channel_manager_updated", "integration", "discord", { enabled: input.enabled, contestWindowHours: input.contestWindowHours, ...(input.blockRecontestsAfterRejection !== undefined ? { blockRecontestsAfterRejection: input.blockRecontestsAfterRejection } : {}) });
  return response({ enabled: input.enabled, contestWindowHours: input.contestWindowHours, ...(input.blockRecontestsAfterRejection !== undefined ? { blockRecontestsAfterRejection: input.blockRecontestsAfterRejection } : {}) });
}
export async function discordAnomalyReportSettings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const existing = await db.prepare("SELECT discord_anomaly_reports_enabled AS enabled, discord_anomaly_report_channel_id AS channelId, discord_anomaly_reports_enabled_at AS enabledAt FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number; channelId?: string | null; enabledAt?: string | null }>();
  if (request.method === "GET") return response({ enabled: Boolean(existing?.enabled), channelId: existing?.channelId ?? "" });
  const input = await parseJson<DiscordAnomalyReportsInput>(request); const errors: string[] = [];
  if (typeof input.enabled !== "boolean") errors.push("Anomaly reports enabled must be true or false");
  const channelId = input.channelId === undefined ? existing?.channelId ?? null : input.channelId?.trim() || null;
  if (channelId && !/^\d{10,24}$/.test(channelId)) errors.push("Private report channel ID must contain 10 to 24 digits");
  if (input.enabled && !channelId) errors.push("A private report channel ID is required when anomaly reports are enabled");
  if (errors.length) throw new HttpError(400, "Invalid Discord anomaly report settings", errors);
  if (input.enabled && channelId) {
    await requireIntegrationConfigured(env, "discord");
    const config = await discordConfiguration(env);
    if (channelId === config.channelId) throw new HttpError(400, "Choose a separate private channel, not the member-facing attendance channel");
    const { body } = await discordRequest(config, `/channels/${encodeURIComponent(channelId)}`, { method: "GET" });
    if (String(body.guild_id ?? "") !== config.guildId || Number(body.type) !== 0) throw new HttpError(400, "The private report channel must be a text channel in the verified Discord server");
  }
  const now = new Date().toISOString();
  const enabledAt = input.enabled ? (!existing?.enabled || existing.channelId !== channelId ? now : existing.enabledAt ?? now) : null;
  await db.prepare("UPDATE organization_settings SET discord_anomaly_reports_enabled = ?, discord_anomaly_report_channel_id = ?, discord_anomaly_reports_enabled_at = ? WHERE installation_id = 'primary'").bind(input.enabled ? 1 : 0, channelId, enabledAt).run();
  await writeAudit(db, principal, "discord.anomaly_reports_updated", "integration", "discord", { enabled: input.enabled, channelId });
  return response({ enabled: input.enabled, channelId: channelId ?? "" });
}
export async function integrationCapabilities(request: Request, env: Env): Promise<Response> {
  const [, [flags, records, calendar]] = await authorizedRead(request, env, ["admin", "operator"], () => allInOrder(
    () => integrationFlags(env),
    () => requireDatabase(env).prepare("SELECT provider, verified_at AS verifiedAt FROM encrypted_integrations WHERE installation_id = 'primary'").all<{ provider: IntegrationProvider; verifiedAt?: string | null }>(),
    () => googleCalendarAuthorizationRecord(env),
  ));
  const verified = new Map((records.results ?? []).map((item) => [item.provider, Boolean(item.verifiedAt)]));
  const googleCalendarEnabled = Boolean(calendar?.enabled);
  return response({ integrations: { ...Object.fromEntries([...integrationProviders].map((provider) => [provider, { enabled: Boolean(flags[integrationFlagColumns[provider]]), configured: Boolean(flags[integrationFlagColumns[provider]]) && Boolean(verified.get(provider)) }])), google_calendar: { enabled: googleCalendarEnabled, configured: googleCalendarEnabled && Boolean(calendar?.verifiedAt) } } });
}
async function requireLocalAdminSignIn(db: D1Database): Promise<void> {
  const localAdmin = await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND role = 'admin' AND active = 1 AND password_hash IS NOT NULL LIMIT 1").first();
  if (!localAdmin) throw new HttpError(409, "Google OAuth cannot be disabled because no active Admin has a usable local sign-in");
}
export async function integrationConfiguration(request: Request, env: Env, provider: IntegrationProvider): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "PATCH") {
    const input = await parseJson<{ enabled?: boolean }>(request); if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    if (provider === "google" && !input.enabled) await requireLocalAdminSignIn(db);
    const column = integrationFlagSqlColumns[provider]; const statements = [db.prepare(`UPDATE installations SET ${column} = ? WHERE id = 'primary'`).bind(input.enabled ? 1 : 0)];
    if (!input.enabled) statements.push(db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider));
    if (provider === "discord" && !input.enabled) statements.push(db.prepare("UPDATE organization_settings SET discord_anomaly_reports_enabled = 0, discord_anomaly_reports_enabled_at = NULL WHERE installation_id = 'primary'"));
    if (provider === "google") statements.push(db.prepare(`UPDATE installations SET auth_mode = CASE WHEN ? = 1 AND auth_mode = 'local' THEN 'both' WHEN ? = 0 AND auth_mode = 'both' THEN 'local' ELSE auth_mode END WHERE id = 'primary'`).bind(input.enabled ? 1 : 0, input.enabled ? 1 : 0));
    // Turning Discord back on queues what Sync all would, in this batch: nothing was queued for it while it was off.
    if (provider === "discord" && input.enabled) statements.push(...calendarCatchUp(db, "discord", new Date().toISOString(), principal.userId).statements);
    await db.batch(statements); await writeAudit(db, principal, input.enabled ? "integration.enabled" : "integration.disabled", "integration", provider);
    return response({ provider, enabled: input.enabled });
  }
  if (request.method === "DELETE") {
    if (provider === "google") await requireLocalAdminSignIn(db);
    if (provider === "discord") {
      // Removing Discord leaves its events on the server but forgets none of them: each is recorded and remembered under
      // its server (discordCalendarLeave) and the removals are set aside, so setting the same server up again links the
      // events to their meetings again, and setting up another one removes them like any change of server. The server
      // is read before the batch, so every statement applies only while the stored credentials are the ones read, as
      // for a save: credentials replaced meanwhile may be for another server, and nothing is removed under a wrong one.
      const record = await integrationRecord(env, "discord"); const still = discordCredentialsStill(record?.ciphertext ?? null); const leftAt = new Date().toISOString(); const held = `AND ${still.sql}`;
      const results = await db.batch([
        db.prepare(`SELECT ${still.sql} AS held`).bind(...still.values),
        db.prepare(`DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'discord' ${held}`).bind(...still.values),
        db.prepare(`UPDATE installations SET discord_enabled = 0 WHERE id = 'primary' ${held}`).bind(...still.values),
        db.prepare(`UPDATE organization_settings SET discord_anomaly_reports_enabled = 0, discord_anomaly_reports_enabled_at = NULL WHERE installation_id = 'primary' ${held}`).bind(...still.values),
        ...discordCalendarLeave(db, leftAt, await storedDiscordServer(env, record), still).statements, discordCalendarServerForget(db, still), ...calendarRemovalDisconnectStatements(db, "discord", leftAt, still),
        // The credentials go last: until then every statement above still sees the ones this request read.
        db.prepare("DELETE FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = 'discord' AND ciphertext IS ?").bind(record?.ciphertext ?? null),
      ]);
      if ((results[0] as D1Result<{ held?: number }> | undefined)?.results?.[0]?.held === 0) throw new HttpError(409, "The Discord credentials were changed by another request while the integration was being removed. Nothing was changed by this request. Reload the page and try again.");
    } else await db.batch([db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider), db.prepare("DELETE FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = ?").bind(provider), db.prepare(`UPDATE installations SET ${integrationFlagSqlColumns[provider]} = 0 WHERE id = 'primary'`), ...(provider === "google" ? [db.prepare("UPDATE installations SET auth_mode = 'local' WHERE id = 'primary'")] : [])]);
    await writeAudit(db, principal, "integration.removed", "integration", provider); return response({ configured: false, provider });
  }
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const existing = await integrationRecord(env, provider); const secret = validateIntegration(provider, await parseJson<Record<string, unknown>>(request)); const encrypted = await sealIntegrationSecret(env, secret); const now = new Date().toISOString();
  if (provider === "discord") return saveDiscordCredentials(env, db, principal, existing, secret, encrypted, now);
  await db.batch([
    db.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES (?, 'primary', ?, ?, ?, NULL, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, verified_at = NULL, key_version = key_version + 1, updated_at = excluded.updated_at").bind(crypto.randomUUID(), provider, encrypted.ciphertext, encrypted.iv, now),
    db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider),
  ]);
  if (provider === "google" && await integrationIsEnabled(env, "google")) await db.prepare("UPDATE installations SET auth_mode = CASE WHEN auth_mode = 'local' THEN 'both' ELSE auth_mode END WHERE id = 'primary'").run();
  await writeAudit(db, principal, existing ? "integration.rotated" : "integration.saved", "integration", provider); return response({ saved: true, configured: false, created: !existing, provider, state: "verification_required", updatedAt: now });
}
/** The server id in stored Discord credentials, or null when there are none or they cannot be read. Never throws: unreadable credentials must stay replaceable and removable. */
async function storedDiscordServer(env: Env, record: IntegrationRecord | null): Promise<string | null> {
  if (!record || !env.INTEGRATION_KEY) return null;
  try { const guildId = (await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY)).guildId; return typeof guildId === "string" && guildId ? guildId : null; } catch { return null; }
}
/**
 * Stores new Discord credentials. What happens to the calendar mappings and queued operations depends on the server:
 *
 * - The same server as before (a reset bot token, another channel, a corrected key): they are kept. The connection is
 *   unverified until an Admin verifies it again, so nothing is delivered meanwhile; verifying makes the queue due again
 *   and updates the events that are there. Nothing is created twice and nothing is forgotten.
 * - Another server: they belong to the server being left. Every event that may still be on it is recorded for removal
 *   under that server's id and remembered with its meeting, then they go (discordCalendarLeave); and what is remembered
 *   for the new server, if it was connected before, comes back (discordCalendarConnect).
 * - No credentials stored (the first set-up, or setting Discord up again after the connection was removed, which
 *   leaves the server like a change does): only discordCalendarConnect runs. The same server gets its events back; for
 *   another one, the events of the server that was removed become due for removal, as after a change of server.
 * - Saved credentials that cannot be read name no server. They are replaced as for the same server, which is what
 *   entering the credentials again after a changed encryption key is; the audit entry says the server was not known.
 *   If the server is in fact another one, its events are created there as the old ones are found missing, and the
 *   events on the server nobody could name stay where they are.
 *
 * Every statement applies only while the stored credentials are the ones this request read, so two saves at once cannot
 * each act on what the other replaced: the second changes nothing and is asked to try again. Credentials removed
 * meanwhile leave nothing to replace: this request then stores its own as a first save.
 */
async function saveDiscordCredentials(env: Env, db: D1Database, principal: Principal, existing: IntegrationRecord | null, secret: Record<string, string>, encrypted: { ciphertext: string; iv: string }, now: string): Promise<Response> {
  // Read inside a catch-all (storedDiscordServer): credentials that cannot be read must still be replaceable, so nothing thrown by the read may leave this function.
  const previousGuildId = await storedDiscordServer(env, existing);
  const still = discordCredentialsStill(existing?.ciphertext ?? null);
  const leave = previousGuildId !== null && previousGuildId !== secret.guildId ? discordCalendarLeave(db, now, previousGuildId, still) : null;
  const connect = leave || !existing ? discordCalendarConnect(db, now, secret.guildId, still) : null;
  const guarded = [
    // Whether the statements below apply, as the batch itself saw it.
    db.prepare(`SELECT ${still.sql} AS held`).bind(...still.values),
    db.prepare(`UPDATE organization_settings SET discord_anomaly_reports_enabled = 0, discord_anomaly_reports_enabled_at = NULL WHERE installation_id = 'primary' AND ${still.sql}`).bind(...still.values),
    db.prepare(`DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'discord' AND ${still.sql}`).bind(...still.values),
  ];
  const calendar = [...(leave?.statements ?? []), ...(connect ? connect.statements : [discordCalendarServerRecord(db, now, secret.guildId, still)])];
  // The credentials go last: until then every statement above still sees the ones this request read.
  const results = await db.batch([...guarded, ...calendar, db.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES (?, 'primary', 'discord', ?, ?, NULL, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, verified_at = NULL, key_version = key_version + 1, updated_at = excluded.updated_at WHERE encrypted_integrations.ciphertext IS ?").bind(crypto.randomUUID(), encrypted.ciphertext, encrypted.iv, now, existing?.ciphertext ?? null)]);
  if ((results.at(-1)?.meta?.changes ?? 1) === 0) throw new HttpError(409, "The Discord credentials were changed by another request while this one was being saved. Nothing was changed by this request. Reload the page and save again.");
  // `held` is 0 when the credentials this request read were removed before its batch ran: nothing was kept, recorded or replaced, and it stored a first set.
  const held = (results[0] as D1Result<{ held?: number }> | undefined)?.results?.[0]?.held !== 0; const replaced = Boolean(existing) && held;
  const connectAt = guarded.length + (leave?.statements.length ?? 0);
  const recorded = leave && held ? leave.recorded(results, guarded.length) : 0; let restored = connect && held ? connect.restored(results, connectAt) : 0; let elsewhere = connect && held ? connect.elsewhere(results, connectAt) : 0;
  // The credentials read were removed meanwhile, which left their server (the Remove route): this save turned out to be
  // a first set-up, so it connects its server as one, for as long as the credentials it just stored are still there.
  if (existing && !held) { const first = discordCalendarConnect(db, now, secret.guildId, discordCredentialsStill(encrypted.ciphertext)); const connected = await db.batch(first.statements); restored = first.restored(connected, 0); elsewhere = first.elsewhere(connected, 0); }
  // Events left on a server that is no longer the connected one, which the delivery job will try to remove there.
  const previousServerEvents = recorded + elsewhere; const serverChanged = Boolean(leave && held) || elsewhere > 0;
  await writeAudit(db, principal, replaced ? "integration.rotated" : "integration.saved", "integration", "discord", replaced ? { calendar: leave ? "server_changed" : previousGuildId ? "kept" : "kept_server_unknown", ...(leave ? { eventsRecordedForRemoval: previousServerEvents, eventsRestored: restored } : {}) } : restored || elsewhere ? { calendar: "server_connected", eventsRecordedForRemoval: elsewhere, eventsRestored: restored } : {});
  return response({ saved: true, configured: false, created: !replaced, provider: "discord", state: "verification_required", updatedAt: now, ...(serverChanged ? { serverChanged: true, previousServerEvents } : {}) });
}
export async function startResendVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await requireIntegrationEnabled(env, "resend"); const db = requireDatabase(env); const input = await parseJson<{ email?: string }>(request); const target = input.email?.trim().toLowerCase();
  if (!target || !validEmail(target)) throw new HttpError(400, "Enter a valid email address that you can open now");
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured"); const record = await integrationRecord(env, "resend"); if (!record) throw new HttpError(404, "Save Resend credentials before verification"); const secret = await readIntegrationSecret(env, "resend", record.ciphertext, record.iv);
  const digits = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000; const code = digits.toString().padStart(6, "0"); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await requireProviderAuthority(env);
  const result = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${secret.apiKey}`, "content-type": "application/json", "idempotency-key": `lancerlogin-verify-${crypto.randomUUID()}` }, body: JSON.stringify({ from: secret.fromEmail, to: [target], subject: "Your LancerLogin verification code", text: `Your LancerLogin verification code is ${code}. It expires in 10 minutes.`, html: `<p>Your LancerLogin verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p>` }) });
  if (!result.ok) throw new EmailProviderError(result.status, await resendErrorMessage(result), "Resend could not deliver the verification email"); const body = await result.json().catch(() => ({})) as { id?: string };
  await db.prepare("INSERT INTO integration_verification_challenges (installation_id, provider, challenge_hash, target, external_id, expires_at, created_by, created_at) VALUES ('primary', 'resend', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET challenge_hash = excluded.challenge_hash, target = excluded.target, external_id = excluded.external_id, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = excluded.created_at").bind(await sha256(code), target, body.id ?? null, expiresAt, principal.userId, now.toISOString()).run();
  await writeAudit(db, principal, "integration.verification_started", "integration", "resend", { target, deliveryId: body.id ?? null }); return response({ provider: "resend", verificationPending: true, expiresAt, target }, 202);
}
export async function completeResendVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await requireIntegrationEnabled(env, "resend"); const db = requireDatabase(env); const input = await parseJson<{ code?: string }>(request); const code = input.code?.trim();
  if (!code || !/^\d{6}$/.test(code)) throw new HttpError(400, "Enter the six-digit code from the verification email");
  const challenge = await db.prepare("SELECT challenge_hash AS challengeHash, target, expires_at AS expiresAt FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'resend'").first<{ challengeHash: string; target: string; expiresAt: string }>();
  if (!challenge || challenge.expiresAt <= new Date().toISOString() || challenge.challengeHash !== await sha256(code)) throw new HttpError(400, "The verification code is invalid or expired");
  const verifiedAt = await markIntegrationVerified(db, "resend", principal.userId, { target: challenge.target }); return response({ provider: "resend", configured: true, state: "configured", verifiedAt });
}

import { calendarCatchUp, calendarFailedRetry } from "../calendar-queue.ts";
import { type D1Database } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { type Env, readIntegrationSecret, requireDatabase, validEmail } from "./core.ts";

export type IntegrationProvider = "google" | "resend" | "discord";
export const integrationProviders = new Set<IntegrationProvider>(["google", "resend", "discord"]);
export function providerFrom(pathname: string): IntegrationProvider {
  const provider = pathname.split("/")[3] as IntegrationProvider;
  if (!integrationProviders.has(provider)) throw new HttpError(404, "Integration provider not found");
  return provider;
}
export function validateIntegration(provider: IntegrationProvider, input: Record<string, unknown>): Record<string, string> {
  const fields = provider === "google" ? ["clientId", "clientSecret"] : provider === "resend" ? ["apiKey", "fromEmail"] : ["botToken", "applicationId", "guildId", "channelId", "publicKey"];
  const output: Record<string, string> = {};
  for (const field of fields) { const value = input[field]; if (typeof value !== "string" || !value.trim() || value.length > 500) throw new HttpError(400, `${field} is required`); output[field] = value.trim(); }
  if (provider === "resend" && !validEmail(output.fromEmail)) throw new HttpError(400, "fromEmail must be a valid email address");
  if (provider === "discord") {
    if (!/^[0-9a-f]{64}$/i.test(output.publicKey)) throw new HttpError(400, "Discord public key must contain 64 hexadecimal characters");
    for (const field of ["applicationId", "guildId", "channelId"]) if (!/^\d{10,24}$/.test(output[field])) throw new HttpError(400, `${field} must contain 10 to 24 digits`);
  }
  return output;
}
export type IntegrationRecord = { id: string; ciphertext: string; iv: string; updatedAt: string; verifiedAt?: string | null; enabled?: number };
type IntegrationFlags = { googleEnabled?: number; resendEnabled?: number; discordEnabled?: number };
export const integrationFlagColumns: Record<IntegrationProvider, keyof IntegrationFlags> = { google: "googleEnabled", resend: "resendEnabled", discord: "discordEnabled" };
export const integrationFlagSqlColumns: Record<IntegrationProvider, string> = { google: "google_enabled", resend: "resend_enabled", discord: "discord_enabled" };
export async function integrationFlags(env: Env): Promise<IntegrationFlags> {
  return await requireDatabase(env).prepare("SELECT google_enabled AS googleEnabled, resend_enabled AS resendEnabled, discord_enabled AS discordEnabled FROM installations WHERE id = 'primary'").first<IntegrationFlags>() ?? {};
}
export async function integrationIsEnabled(env: Env, provider: IntegrationProvider): Promise<boolean> {
  const flags = await integrationFlags(env); return Boolean(flags[integrationFlagColumns[provider]]);
}
export async function requireIntegrationEnabled(env: Env, provider: IntegrationProvider): Promise<void> {
  if (!await integrationIsEnabled(env, provider)) throw new HttpError(409, `${provider === "google" ? "Google OAuth" : provider === "resend" ? "Resend" : "Discord"} is disabled`);
}
export async function integrationRecord(env: Env, provider: IntegrationProvider): Promise<IntegrationRecord | null> {
  const read = () => requireDatabase(env).prepare(`SELECT i.id, i.ciphertext, i.iv, i.updated_at AS updatedAt, i.verified_at AS verifiedAt, x.${integrationFlagSqlColumns[provider]} AS enabled FROM encrypted_integrations i JOIN installations x ON x.id = i.installation_id WHERE i.installation_id = 'primary' AND i.provider = ?`).bind(provider).first<IntegrationRecord>();
  // A scheduled pass reads each provider's record once for all its jobs; no job changes these records.
  const cache = env.schedulerPass?.integrations; if (!cache) return read();
  let record = cache.get(provider);
  if (!record) { record = read(); cache.set(provider, record); record.catch(() => cache.delete(provider)); }
  return record;
}
export async function requireIntegrationConfigured(env: Env, provider: IntegrationProvider): Promise<void> {
  const record = await integrationRecord(env, provider);
  if (!record?.enabled || !record.verifiedAt) throw new HttpError(409, `${provider === "google" ? "Google OAuth" : provider === "resend" ? "Resend" : "Discord"} must be enabled and verified`);
}
export type GoogleCalendarAuthorizationRecord = { ciphertext?: string | null; iv?: string | null; keyVersion?: number; authorizedAt?: string | null; verifiedAt?: string | null; updatedAt?: string | null; enabled?: number };
export async function googleCalendarAuthorizationRecord(env: Env): Promise<GoogleCalendarAuthorizationRecord | null> {
  return requireDatabase(env).prepare("SELECT a.ciphertext, a.iv, a.key_version AS keyVersion, a.authorized_at AS authorizedAt, a.verified_at AS verifiedAt, a.updated_at AS updatedAt, x.google_calendar_enabled AS enabled FROM installations x LEFT JOIN google_calendar_authorizations a ON a.installation_id = x.id WHERE x.id = 'primary'").first<GoogleCalendarAuthorizationRecord>();
}
export async function markIntegrationVerified(db: D1Database, provider: IntegrationProvider, actorUserId: string | null, metadata: Record<string, unknown> = {}) {
  const now = new Date().toISOString(); await db.batch([
    db.prepare("UPDATE encrypted_integrations SET verified_at = ? WHERE installation_id = 'primary' AND provider = ?").bind(now, provider),
    db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider),
    // Verified: failed operations are due again (a Discord upsert beyond the 60-day horizon when its meeting comes within
    // range), and what Sync all would queue is queued here, for edits and deletes made while Discord could not take them.
    ...(provider === "discord" ? [calendarFailedRetry(db, "discord", now), ...calendarCatchUp(db, "discord", now, actorUserId).statements] : []),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'integration.verified', 'integration', ?, ?, ?)").bind(crypto.randomUUID(), actorUserId, provider, JSON.stringify(metadata), now),
  ]); return now;
}
export async function googleCredentials(env: Env): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "google"); if (!record || record.enabled === 0) throw new HttpError(503, "Google OAuth is not enabled");
  return readIntegrationSecret(env, "google", record.ciphertext, record.iv);
}
// Google accepts http only for loopback redirect URIs, so a local preview may use http://localhost; every other origin needs https.
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
function oauthPublicOrigin(env: Env): string {
  const origin = new URL(env.ALLOWED_ORIGIN);
  if (!(origin.protocol === "https:" || (origin.protocol === "http:" && loopbackHostnames.has(origin.hostname))) || origin.origin !== env.ALLOWED_ORIGIN) throw new HttpError(503, "Public dashboard origin is invalid");
  return origin.origin;
}
export function googleRedirectUri(env: Env): string { return `${oauthPublicOrigin(env)}/api/auth/google/callback`; }
/** Status must still load when the origin is misconfigured, so an unusable URL is left out instead of failing the call. */
export function optionalPublicUrl(build: () => string): string | undefined { try { return build(); } catch { return undefined; } }
/** Browser-facing OAuth flows return to Integrations with a short, non-sensitive message instead of raw JSON. */
export function integrationErrorRedirect(env: Env, provider: "google" | "google_calendar", message: string, clearCookies: string[]): Response {
  const headers = new Headers({ location: `${env.ALLOWED_ORIGIN}/settings/integrations?integrationError=${provider}&message=${encodeURIComponent(message)}`, "cache-control": "no-store" });
  for (const name of clearCookies) headers.append("set-cookie", `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

export function googleCalendarRedirectUri(env: Env): string { return `${oauthPublicOrigin(env)}/api/admin/integrations/google-calendar/callback`; }
// Pages forwards /api/* to the Worker with the /api prefix removed, so Discord reaches the Worker's /discord/interactions route.
export function discordInteractionsUrl(env: Env): string { return `${oauthPublicOrigin(env)}/api/discord/interactions`; }

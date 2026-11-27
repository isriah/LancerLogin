import { calendarTargets, completeCalendarRemoval, dueCalendarWork, failCalendarRemoval, CALENDAR_DUE_NOW, calendarCatchUp, calendarFailedRetry, calendarRemovalDisconnectStatements, calendarRemovalRetry, calendarWaitingCount, dropCalendarRemoval, type CalendarQueueSummary } from "../calendar-queue.ts";
import { createSignedStateCodec } from "../runtime-security.ts";
import { decryptIntegration, encryptIntegration } from "../integration-crypto.ts";
import { type D1Database, type D1Result } from "../d1-usage.ts";
import { SchedulerBudgetError, type PassCost } from "../scheduler-budget.ts";
import { HttpError } from "../http-error.ts";
import { type Env, GoogleCalendarProviderError, type GoogleCalendarSecret, type ModuleProviderAuthority, type Role, cookie, googleCalendarReauthorizationRequired, googleRefreshTokenExpiresAt, parseJson, passAllows, passMore, readIntegrationSecret, requireDatabase, requireProviderAuthority, requireRole, response, sealIntegrationSecret, sha256Hex, writeAudit } from "./core.ts";
import { deliveryPausedUntil, durableScheduler } from "./delivery.ts";
import { discordConfiguration } from "./discord-core.ts";
import { type GoogleCalendarAuthorizationRecord, googleCalendarAuthorizationRecord, googleCalendarRedirectUri, integrationErrorRedirect } from "./integration-support.ts";
import { meetingAudienceText } from "./meeting-audience.ts";
import { calendarAttendanceDetails } from "./policy-data.ts";

async function googleCalendarSecret(env: Env, requireVerified = false): Promise<{ record: GoogleCalendarAuthorizationRecord; secret: GoogleCalendarSecret }> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await googleCalendarAuthorizationRecord(env);
  if (!record?.enabled) throw new HttpError(409, "Google Calendar is disabled");
  if (!record.ciphertext || !record.iv) throw new HttpError(409, "Save Google Calendar OAuth credentials first");
  if (requireVerified && !record.verifiedAt) throw new HttpError(409, "Google Calendar must be authorized and a writable calendar selected");
  return { record, secret: await readIntegrationSecret(env, "google_calendar", record.ciphertext, record.iv) as GoogleCalendarSecret };
}
function googleCalendarRetryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 3_600_000) : undefined;
}
export async function googleCalendarProviderRequest(accessToken: string, path: string, init: RequestInit = {}, current?: ModuleProviderAuthority): Promise<{ response: Response; body: Record<string, unknown> }> {
  await current?.();
  const result = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { ...init, headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  const body = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (result.ok) return { response: result, body };
  throw googleCalendarProviderFailure(result, body, path);
}
/** Google's machine-readable reasons (errors[].reason, status, details[].reason) and its short message; only used to classify, never shown. */
function googleCalendarErrorReasons(body: Record<string, unknown>): { reasons: Set<string>; message: string } {
  const error = body.error && typeof body.error === "object" ? body.error as { status?: unknown; message?: unknown; errors?: unknown; details?: unknown } : {}; const reasonsOf = (list: unknown) => Array.isArray(list) ? list.map((item) => item && typeof item === "object" ? (item as { reason?: unknown }).reason : undefined) : [];
  return { reasons: new Set([error.status, ...reasonsOf(error.errors), ...reasonsOf(error.details)].filter((value): value is string => typeof value === "string")), message: typeof error.message === "string" ? error.message.slice(0, 1_000) : "" };
}
/** One short, token-free message per Google refusal. `retryable` drives the operation queue, so a refusal that needs an Admin never retries forever. */
function googleCalendarProviderFailure(result: Response, body: Record<string, unknown>, path: string): GoogleCalendarProviderError {
  const { reasons, message } = googleCalendarErrorReasons(body); const has = (...codes: string[]) => codes.some((code) => reasons.has(code)); const status = result.status;
  if (status === 401) return new GoogleCalendarProviderError(401, "Google Calendar authorization needs to be renewed.", false, undefined, true);
  if (status === 429 || (status === 403 && has("rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED"))) return new GoogleCalendarProviderError(status, "Google Calendar is rate limiting requests. LancerLogin will retry automatically.", true, googleCalendarRetryAfter(result));
  if (status === 403 && (has("accessNotConfigured", "SERVICE_DISABLED") || /has not been used in project|is disabled/i.test(message))) return new GoogleCalendarProviderError(403, "The Google Calendar API is not enabled in this Google Cloud project. Enable it in the Google Cloud console, wait a minute, then try again.", false);
  if (status === 403 && has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return new GoogleCalendarProviderError(403, "Google Calendar access was not fully granted. Authorize Google Calendar again and approve both permissions.", false, undefined, true);
  if ((status === 403 && has("forbidden", "requiredAccessLevel")) || (status === 404 && path.startsWith("/users/me/calendarList/"))) return new GoogleCalendarProviderError(status, "This Google account can no longer write to the selected calendar. Choose another calendar or restore access.", false);
  if (status === 403) return new GoogleCalendarProviderError(403, "Google Calendar refused this request (403). Check the Calendar connection.", false);
  if (status >= 500) return new GoogleCalendarProviderError(status, "Google Calendar is temporarily unavailable. LancerLogin will retry automatically.", true, googleCalendarRetryAfter(result));
  return new GoogleCalendarProviderError(status, `Google Calendar rejected the request (${status}). Check the Calendar connection.`, false);
}
/** Admin routes that call Google Calendar directly report its refusal as a handled error (409 re-authorize, 503 retryable, 502 otherwise) instead of a generic 500. The operation queue records the original error itself. */
async function withCalendarProviderErrors<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { if (error instanceof GoogleCalendarProviderError) throw new HttpError(error.reauthorize ? 409 : error.retryable ? 503 : 502, error.message); throw error; }
}
export async function googleCalendarAccessToken(env: Env, requireVerified = false): Promise<{ accessToken: string; secret: GoogleCalendarSecret }> {
  const { record, secret } = await googleCalendarSecret(env, requireVerified);
  if (!secret.refreshToken) throw new HttpError(409, "Authorize Google Calendar before selecting a calendar");
  await requireProviderAuthority(env);
  const result = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: secret.clientId, client_secret: secret.clientSecret, refresh_token: secret.refreshToken, grant_type: "refresh_token" }) });
  const body = await result.json().catch(() => ({})) as { access_token?: string; error?: unknown };
  if (!result.ok || !body.access_token) {
    if (result.status >= 500 || result.status === 429) throw new GoogleCalendarProviderError(result.status, "Google authorization is temporarily unavailable. LancerLogin will retry automatically.", true, googleCalendarRetryAfter(result));
    // A disabled or blocked OAuth client is fixed in the Google Cloud console, not by re-authorizing, so authorized_at stays.
    if (result.status === 403 || body.error === "disabled_client") throw new GoogleCalendarProviderError(result.status, `Google refused the Calendar OAuth client (${result.status}). Check that the OAuth client is enabled in the Google Cloud console, then try again.`, false);
    // A revoked or expired refresh token never recovers on retry. Clearing authorized_at (only for the credentials that failed) marks re-authorization as required; the calendar choice stays.
    if (body.error === "invalid_grant" || result.status === 400 || result.status === 401) await requireDatabase(env).prepare("UPDATE google_calendar_authorizations SET authorized_at = NULL, updated_at = ? WHERE installation_id = 'primary' AND ciphertext = ? AND authorized_at IS NOT NULL").bind(new Date().toISOString(), record.ciphertext).run();
    throw new GoogleCalendarProviderError(result.status, "Google Calendar authorization needs to be renewed. An Admin must authorize Google Calendar again.", false, undefined, true);
  }
  return { accessToken: body.access_token, secret };
}
export async function googleCalendarConfiguration(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "PATCH") {
    const input = await parseJson<{ enabled?: boolean }>(request);
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    // Turning Google Calendar back on queues what Sync all would, in the same batch: nothing was queued while it was off.
    await db.batch([db.prepare("UPDATE installations SET google_calendar_enabled = ? WHERE id = 'primary'").bind(input.enabled ? 1 : 0), ...(input.enabled ? calendarCatchUp(db, "google_calendar", new Date().toISOString(), principal.userId).statements : [])]);
    await writeAudit(db, principal, input.enabled ? "google_calendar.enabled" : "google_calendar.disabled", "integration", "google_calendar");
    return response({ provider: "google_calendar", enabled: input.enabled });
  }
  if (request.method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM google_calendar_operations WHERE installation_id = 'primary'"),
      db.prepare("DELETE FROM google_calendar_event_mappings WHERE installation_id = 'primary'"),
      db.prepare("DELETE FROM google_calendar_authorizations WHERE installation_id = 'primary'"),
      ...calendarRemovalDisconnectStatements(db, "google_calendar", new Date().toISOString()),
      db.prepare("UPDATE installations SET google_calendar_enabled = 0 WHERE id = 'primary'"),
    ]);
    await writeAudit(db, principal, "google_calendar.removed", "integration", "google_calendar");
    return response({ provider: "google_calendar", configured: false, enabled: false });
  }
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const input = await parseJson<{ clientId?: string; clientSecret?: string }>(request);
  if (!input.clientId?.trim() || !input.clientSecret?.trim() || input.clientId.length > 500 || input.clientSecret.length > 500) throw new HttpError(400, "Google Calendar requires an OAuth client ID and client secret");
  const existing = await googleCalendarAuthorizationRecord(env); let prior: GoogleCalendarSecret | undefined;
  if (existing?.ciphertext && existing.iv) try { prior = await decryptIntegration(existing.ciphertext, existing.iv, env.INTEGRATION_KEY) as GoogleCalendarSecret; } catch { /* Replacing unreadable credentials is allowed. */ }
  const encrypted = await sealIntegrationSecret(env, { clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim(), ...(prior?.calendarId ? { calendarId: prior.calendarId, calendarLabel: prior.calendarLabel } : {}) }); const now = new Date().toISOString();
  await db.prepare("INSERT INTO google_calendar_authorizations (installation_id, ciphertext, iv, key_version, authorized_at, verified_at, updated_at) VALUES ('primary', ?, ?, 1, NULL, NULL, ?) ON CONFLICT(installation_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = google_calendar_authorizations.key_version + 1, authorized_at = NULL, verified_at = NULL, updated_at = excluded.updated_at").bind(encrypted.ciphertext, encrypted.iv, now).run();
  await writeAudit(db, principal, existing?.ciphertext ? "google_calendar.rotated" : "google_calendar.saved", "integration", "google_calendar");
  return response({ provider: "google_calendar", saved: true, configured: false, created: !existing?.ciphertext, state: "verification_required", updatedAt: now });
}
export async function googleCalendarStart(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const principal = await requireRole(request, env, ["admin"]); const { secret } = await googleCalendarSecret(env); const state = await createSignedStateCodec(env.SESSION_KEY, "google_calendar_oauth").issue({ userId: principal.userId }); const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({ client_id: secret.clientId, redirect_uri: googleCalendarRedirectUri(env), response_type: "code", scope: googleCalendarScopes.join(" "), access_type: "offline", include_granted_scopes: "true", prompt: "consent select_account", state }).toString();
  const headers = new Headers({ location: target.toString(), "cache-control": "no-store" }); headers.append("set-cookie", `lancerlogin_calendar_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  return new Response(null, { status: 302, headers });
}
const writableCalendarRole = (value: unknown) => value === "writer" || value === "owner";
const googleCalendarScopes = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"];
export async function googleCalendarCallback(request: Request, env: Env): Promise<Response> {
  try { return await completeGoogleCalendarAuthorization(request, env); }
  catch (error) { if (error instanceof HttpError) return integrationErrorRedirect(env, "google_calendar", error.message, ["lancerlogin_calendar_oauth_state"]); throw error; }
}
async function completeGoogleCalendarAuthorization(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY || !env.INTEGRATION_KEY) throw new HttpError(503, "Google Calendar authorization is not configured");
  const url = new URL(request.url); if (url.searchParams.get("error")) throw new HttpError(400, "Google Calendar authorization was cancelled or denied. Authorize again and approve Calendar access.");
  const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); const savedState = cookie(request, "lancerlogin_calendar_oauth_state"); const signed = state ? await createSignedStateCodec(env.SESSION_KEY, "google_calendar_oauth").verify(state) : undefined;
  if (!code || !state || state !== savedState || !signed?.userId) throw new HttpError(400, "Google Calendar authorization state is invalid or expired");
  const principal = await requireDatabase(env).prepare("SELECT id AS userId, role FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1 AND role = 'admin'").bind(signed.userId).first<{ userId: string; role: Role }>();
  if (!principal) throw new HttpError(403, "Only an active Admin can authorize Google Calendar");
  const { record, secret } = await googleCalendarSecret(env); await requireProviderAuthority(env); const result = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: secret.clientId, client_secret: secret.clientSecret, redirect_uri: googleCalendarRedirectUri(env), grant_type: "authorization_code" }) });
  const tokens = await result.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; refresh_token_expires_in?: unknown; scope?: unknown };
  // A refresh token Google refused, or one past the lifetime Google gave it, cannot be reused, so re-authorization must return a new one.
  const reauthorizing = googleCalendarReauthorizationRequired(record, secret);
  if (!result.ok || !tokens.access_token || !(tokens.refresh_token || (!reauthorizing && secret.refreshToken))) throw new HttpError(401, "Google did not return durable Calendar access. Try authorizing again and approve Calendar access.");
  // Google lets the user untick a scope on the consent screen; OAuth omits scope only when every requested scope was granted.
  const granted = typeof tokens.scope === "string" ? new Set(tokens.scope.split(/\s+/)) : undefined;
  if (granted && !googleCalendarScopes.every((scope) => granted.has(scope))) throw new HttpError(403, "Approve both Google Calendar permissions on Google's consent screen, then authorize again.");
  const next: GoogleCalendarSecret = { ...secret, refreshToken: tokens.refresh_token ?? secret.refreshToken, refreshTokenExpiresAt: tokens.refresh_token ? googleRefreshTokenExpiresAt(tokens.refresh_token_expires_in) : secret.refreshTokenExpiresAt }; let verifiedAt: string | null = null;
  if (next.calendarId) try { const { body } = await googleCalendarProviderRequest(tokens.access_token, `/users/me/calendarList/${encodeURIComponent(next.calendarId)}`, {}, env.moduleProviderAuthority); if (writableCalendarRole(body.accessRole)) { next.calendarLabel = String(body.summary ?? next.calendarLabel ?? "Selected calendar").slice(0, 200); verifiedAt = new Date().toISOString(); } } catch { /* The Admin can choose another writable calendar after return. */ }
  const encrypted = await encryptIntegration(next, env.INTEGRATION_KEY); const now = new Date().toISOString(); const db = requireDatabase(env);
  await db.batch([
    db.prepare("UPDATE google_calendar_authorizations SET ciphertext = ?, iv = ?, authorized_at = ?, verified_at = ?, updated_at = ? WHERE installation_id = 'primary'").bind(encrypted.ciphertext, encrypted.iv, now, verifiedAt, now),
    ...(verifiedAt ? [calendarFailedRetry(db, "google_calendar", now), ...calendarCatchUp(db, "google_calendar", now, principal.userId).statements] : []),
  ]);
  await writeAudit(db, { userId: principal.userId, role: "admin", expiresAt: signed.expiresAt }, "google_calendar.authorized", "integration", "google_calendar", { calendarReverified: Boolean(verifiedAt), reauthorized: reauthorizing });
  const headers = new Headers({ location: `${env.ALLOWED_ORIGIN}/settings/integrations?${verifiedAt ? "verified" : "authorized"}=google-calendar`, "cache-control": "no-store" }); headers.append("set-cookie", "lancerlogin_calendar_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
export async function listGoogleCalendars(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]); const { body } = await withCalendarProviderErrors(async () => googleCalendarProviderRequest((await googleCalendarAccessToken(env)).accessToken, "/users/me/calendarList?minAccessRole=writer&showHidden=false&maxResults=250", {}, env.moduleProviderAuthority));
  const items = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
  return response({ calendars: items.filter((item) => writableCalendarRole(item.accessRole) && typeof item.id === "string").map((item) => ({ id: String(item.id), name: String(item.summary ?? "Writable calendar").slice(0, 200), primary: Boolean(item.primary), accessRole: item.accessRole })) });
}
export async function selectGoogleCalendar(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ calendarId?: string }>(request); const calendarId = input.calendarId?.trim();
  if (!calendarId || calendarId.length > 1_024) throw new HttpError(400, "Choose one writable Google Calendar");
  const { secret, body } = await withCalendarProviderErrors(async () => { const { accessToken, secret } = await googleCalendarAccessToken(env); return { secret, ...await googleCalendarProviderRequest(accessToken, `/users/me/calendarList/${encodeURIComponent(calendarId)}`, {}, env.moduleProviderAuthority) }; });
  if (!writableCalendarRole(body.accessRole)) throw new HttpError(400, "Choose a Google Calendar where this account can edit events");
  const changed = Boolean(secret.calendarId && secret.calendarId !== calendarId); const next = { ...secret, calendarId, calendarLabel: String(body.summary ?? "Selected calendar").slice(0, 200) }; const encrypted = await encryptIntegration(next, env.INTEGRATION_KEY!); const now = new Date().toISOString(); const db = requireDatabase(env);
  await db.batch([
    ...(changed ? [db.prepare("DELETE FROM google_calendar_operations WHERE installation_id = 'primary'"), db.prepare("DELETE FROM google_calendar_event_mappings WHERE installation_id = 'primary'")] : []),
    db.prepare("UPDATE google_calendar_authorizations SET ciphertext = ?, iv = ?, verified_at = ?, updated_at = ? WHERE installation_id = 'primary'").bind(encrypted.ciphertext, encrypted.iv, now, now),
    calendarFailedRetry(db, "google_calendar", now), ...calendarCatchUp(db, "google_calendar", now, principal.userId).statements,
  ]);
  await writeAudit(db, principal, "google_calendar.selected", "integration", "google_calendar", { calendarChanged: changed });
  return response({ provider: "google_calendar", configured: true, calendarName: next.calendarLabel, verifiedAt: now });
}
type GoogleCalendarSyncSummary = CalendarQueueSummary["google_calendar"];
type GoogleCalendarOperation = { meetingId: string; eventId: string; action: "upsert" | "delete"; startsAt?: string | null; endsAt?: string | null; status: "pending" | "delivered" | "failed"; attempts: number; updatedAt: string; syncedAt?: string | null; generation?: number | null };
export async function googleCalendarEventId(meetingId: string, generation: number): Promise<string> { return `ll${(await sha256Hex(`google-calendar:primary:${meetingId}:${generation}`)).slice(0, 48)}`; }
export async function googleCalendarIsReady(env: Env): Promise<boolean> { const record = await googleCalendarAuthorizationRecord(env); return Boolean(record?.enabled && record.verifiedAt); }
const googleCalendarEmptySummary = (): GoogleCalendarSyncSummary => ({ synced: 0, queued: 0, failed: 0 });
export function googleCalendarOperationPath(calendarId: string, eventId?: string): string { return `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`; }
function googleCalendarRetryAt(attempts: number, error: GoogleCalendarProviderError): string | null {
  if (!error.retryable) return null;
  const backoff = Math.min(3_600_000, Math.max(60_000, 2 ** Math.min(attempts, 12) * 1_000, error.retryAfterMs ?? 0));
  return new Date(Date.now() + backoff).toISOString();
}
const googleCalendarFailure = (error: unknown) => error instanceof GoogleCalendarProviderError ? error : new GoogleCalendarProviderError(503, "Google Calendar is temporarily unavailable. LancerLogin will retry automatically.", true);
// Operations are queued by meeting routes (calendar-queue.ts) while a delivery may be in flight. Every write that settles
// an operation names the updated_at the delivery read: a meeting change queued since then keeps its pending operation.
/**
 * `sent` is false when nothing reached Google (the token refresh failed). Returns whether the failed upsert was turned
 * into the delete of its event (see googleCalendarInFlightDelete), which is then due at once.
 */
async function markGoogleCalendarOperationFailure(db: D1Database, operation: GoogleCalendarOperation, error: unknown, sent = true): Promise<boolean> {
  const providerError = googleCalendarFailure(error); const now = new Date().toISOString(); const attempts = Number(operation.attempts ?? 0) + 1; const nextAttemptAt = googleCalendarRetryAt(attempts, providerError);
  // A create that failed with an error that is retried may still have made the event, as for one that succeeded.
  const maybeCreated = sent && operation.action !== "delete" && nextAttemptAt !== null;
  const results = await db.batch([
    db.prepare("UPDATE google_calendar_operations SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND event_id = ? AND updated_at = ?").bind(attempts, nextAttemptAt, providerError.message.slice(0, 300), now, operation.eventId, operation.updatedAt),
    db.prepare("UPDATE google_calendar_event_mappings SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND event_id = ?").bind(providerError.message.slice(0, 300), now, operation.meetingId, operation.eventId),
    ...(maybeCreated ? [googleCalendarInFlightDelete(db, operation, now)] : []),
  ]);
  return maybeCreated && (results[2]?.meta?.changes ?? 0) > 0;
}
/**
 * The meeting was deleted (or deleted and restored, which gives it a new event id) while this upsert was in flight. Its
 * delete queued nothing for an event it could not know existed, so the event the upsert may have made is deleted now:
 * the operation becomes a delete, due at once, unless the meeting's mapping still names this event as live.
 */
const googleCalendarInFlightDelete = (db: D1Database, operation: GoogleCalendarOperation, at: string) => db.prepare(`UPDATE google_calendar_operations SET action = 'delete', starts_at = NULL, ends_at = NULL, status = 'pending', attempts = 0, next_attempt_at = '${CALENDAR_DUE_NOW}', last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND event_id = ? AND NOT EXISTS (SELECT 1 FROM google_calendar_event_mappings g WHERE g.installation_id = 'primary' AND g.meeting_id = ? AND g.event_id = ? AND g.active = 1)`).bind(at, operation.eventId, operation.meetingId, operation.eventId);
// Google no longer has the event, so whatever operation is stored for that event id is finished, including one a meeting
// change queued while this delivery was in flight: that is why this one write does not name the updated_at it read.
async function replaceMissingGoogleCalendarEvent(db: D1Database, operation: GoogleCalendarOperation): Promise<string> {
  const generation = Number(operation.generation ?? 1) + 1; const eventId = await googleCalendarEventId(operation.meetingId, generation); const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE google_calendar_operations SET status = 'delivered', next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND event_id = ?").bind(now, operation.eventId),
    // The mapping keeps the state a meeting change may have given it meanwhile (a deleted meeting's stays inactive), and
    // the new event's operation is written from the meeting and mapping as they are now, not from what this delivery read.
    db.prepare("UPDATE google_calendar_event_mappings SET event_id = ?, generation = ?, synced_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND event_id = ?").bind(eventId, generation, now, operation.meetingId, operation.eventId),
    db.prepare(`INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) SELECT 'primary', g.meeting_id, g.event_id, 'upsert', m.starts_at, m.ends_at, 'pending', 0, '${CALENDAR_DUE_NOW}', ? FROM google_calendar_event_mappings g JOIN meetings m ON m.installation_id = g.installation_id AND m.id = g.meeting_id WHERE g.installation_id = 'primary' AND g.meeting_id = ? AND g.event_id = ? AND g.active = 1 AND m.deleted_at IS NULL AND m.ends_at IS NOT NULL`).bind(now, operation.meetingId, eventId),
  ]);
  return eventId;
}
// Per pass: about 2 Google requests and 5 D1 queries per operation, plus the token refresh. An event removal left by
// Delete attendance data (calendar_event_removals) is one Google request and one D1 query, and takes an operation's place.
const GOOGLE_CALENDAR_OPERATION_BATCH_LIMIT = 5;
const GOOGLE_CALENDAR_OPERATION_COST: PassCost = { d1: 6, external: 2 };
const CALENDAR_REMOVAL_COST: PassCost = { d1: 2, external: 1 };
/** How a removal names the Google calendar its event is on, without storing the calendar's id in the clear. */
const googleCalendarRemovalTarget = async (calendarId: string) => (await sha256Hex(`google-calendar-removal-target:${calendarId}`)).slice(0, 32);
/** The calendar and the server that events recorded for removal now are on; null where the integration cannot say. */
export async function calendarRemovalTargets(env: Env): Promise<{ google_calendar: string | null; discord: string | null }> {
  const [google, discord] = await Promise.all([
    googleCalendarSecret(env).then(({ secret }) => secret.calendarId ? googleCalendarRemovalTarget(secret.calendarId) : null).catch(() => null),
    discordConfiguration(env, true).then((config) => config.guildId || null).catch(() => null),
  ]);
  return { google_calendar: google, discord };
}
/** Whether queued work goes out within seconds (the Durable Object alarm) or a few events every five minutes (the cron). */
export const calendarSchedulerMode = (env: Env) => durableScheduler(env) ? "alarm" as const : "cron" as const;
export const calendarPerPass = { google_calendar: 5, discord: 3 } as const;
/**
 * The scheduled Google Calendar delivery: the oldest due operations, then due event removals. Nothing else delivers to
 * Google; meeting routes only queue. An operation is due once its next_attempt_at has passed, whether pending or failed
 * (a failure Google will never accept has none), which is what the queue index of migration 0103 holds.
 */
export async function processGoogleCalendarOperations(env: Env): Promise<GoogleCalendarSyncSummary> {
  if (!await googleCalendarIsReady(env)) return googleCalendarEmptySummary();
  // A Stop holds first attempts too: the operations stay pending and go out when delivery resumes.
  if (await deliveryPausedUntil(env) !== null) return googleCalendarEmptySummary();
  const db = requireDatabase(env); const now = new Date().toISOString();
  const { operations, removals } = await dueCalendarWork<GoogleCalendarOperation>(db, "google_calendar", `SELECT o.meeting_id AS meetingId, o.event_id AS eventId, o.action, o.starts_at AS startsAt, o.ends_at AS endsAt, o.status, o.attempts, o.updated_at AS updatedAt, m.synced_at AS syncedAt, m.generation, NULL AS removalAttempts, NULL AS removalTarget FROM google_calendar_operations o LEFT JOIN google_calendar_event_mappings m ON m.installation_id = o.installation_id AND m.meeting_id = o.meeting_id AND m.event_id = o.event_id WHERE o.installation_id = 'primary' AND o.status != 'delivered' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at <= ? ORDER BY o.next_attempt_at, o.starts_at LIMIT ${GOOGLE_CALENDAR_OPERATION_BATCH_LIMIT}`, [now], "NULL, r.event_id, 'delete', NULL, NULL, 'pending', 0, r.updated_at, NULL, NULL", GOOGLE_CALENDAR_OPERATION_BATCH_LIMIT, now);
  if (!operations.length && !removals.length) return googleCalendarEmptySummary();
  let accessToken: string; let secret: GoogleCalendarSecret;
  try { ({ accessToken, secret } = await googleCalendarAccessToken(env, true)); }
  catch (error) {
    // A refusal by the scheduler's budget is not a provider failure: nothing is marked, and the slice ends.
    if (error instanceof SchedulerBudgetError) throw error; 
    // Without a token nothing here can proceed: everything read backs off, and the job does not ask to run again at once.
    const providerError = googleCalendarFailure(error);
    for (const operation of operations) await markGoogleCalendarOperationFailure(db, operation, error, false);
    for (const removal of removals) await failCalendarRemoval(db, "google_calendar", removal, providerError.message, providerError.retryAfterMs ?? 0);
    return { synced: 0, queued: 0, failed: operations.length };
  }
  if (!secret.calendarId) return { synced: 0, queued: operations.length, failed: 0 };
  // A full batch means there may be more: only now that the work can proceed is another slice asked for.
  if (operations.length + removals.length === GOOGLE_CALENDAR_OPERATION_BATCH_LIMIT) passMore(env);
  const removalTarget = removals.some((removal) => removal.target) ? await googleCalendarRemovalTarget(secret.calendarId) : null;
  let synced = 0; let queued = 0; let failed = 0;
  for (const [index, operation] of operations.entries()) {
    if (!passAllows(env, GOOGLE_CALENDAR_OPERATION_COST)) { queued += operations.length - index; break; }
    try {
      if (operation.action === "delete") {
        try { await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId, operation.eventId), { method: "DELETE" }, env.moduleProviderAuthority); }
        catch (error) { if (!(error instanceof GoogleCalendarProviderError) || ![404, 410].includes(error.providerStatus)) throw error; }
      } else {
        const meeting = await db.prepare("SELECT title, notes, required, attendance_weight AS attendanceWeight FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(operation.meetingId).first<{ title: string; notes: string | null; required: number; attendanceWeight: number }>();
        if (!meeting) throw new GoogleCalendarProviderError(409, "The meeting is no longer available for calendar sync", false);
        const timing = { summary: meeting.title, description: calendarAttendanceDetails(meeting, await meetingAudienceText(db, operation.meetingId)), start: { dateTime: operation.startsAt }, end: { dateTime: operation.endsAt } };
        if (operation.syncedAt) {
          try { await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId, operation.eventId), { method: "PATCH", body: JSON.stringify(timing) }, env.moduleProviderAuthority); }
          catch (error) { if (error instanceof GoogleCalendarProviderError && [404, 410].includes(error.providerStatus)) { await replaceMissingGoogleCalendarEvent(db, operation); queued += 1; continue; } throw error; }
        } else {
          try { await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId), { method: "POST", body: JSON.stringify({ id: operation.eventId, ...timing }) }, env.moduleProviderAuthority); }
          catch (error) { if (error instanceof GoogleCalendarProviderError && error.providerStatus === 409) await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId, operation.eventId), { method: "PATCH", body: JSON.stringify(timing) }, env.moduleProviderAuthority); else throw error; }
        }
      }
      // A meeting changed while this was being sent keeps its newer pending operation; only the one read above is settled.
      const completedAt = new Date().toISOString(); const completion = await db.batch([
        db.prepare("UPDATE google_calendar_operations SET status = 'delivered', attempts = attempts + 1, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND event_id = ? AND updated_at = ?").bind(completedAt, operation.eventId, operation.updatedAt),
        db.prepare("UPDATE google_calendar_event_mappings SET synced_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND event_id = ?").bind(completedAt, completedAt, operation.meetingId, operation.eventId),
        ...(operation.action === "delete" ? [] : [googleCalendarInFlightDelete(db, operation, completedAt)]),
      ]);
      if ((completion[0]?.meta?.changes ?? 1) > 0) synced += 1; else queued += 1;
      // A delete made from this upsert is due now: the job asks to run again rather than wait for its next interval.
      if ((completion[2]?.meta?.changes ?? 0) > 0) passMore(env);
    } catch (error) { if (error instanceof SchedulerBudgetError) throw error; if (await markGoogleCalendarOperationFailure(db, operation, error)) passMore(env); failed += 1; }
  }
  for (const removal of removals) {
    if (!passAllows(env, CALENDAR_REMOVAL_COST)) break;
    // An event recorded for another calendar than the one now selected is not on this one.
    if (removal.target && removal.target !== removalTarget) { await dropCalendarRemoval(db, "google_calendar", removal); continue; }
    try {
      try { await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId, removal.eventId), { method: "DELETE" }, env.moduleProviderAuthority); }
      catch (error) { if (!(error instanceof GoogleCalendarProviderError) || ![404, 410].includes(error.providerStatus)) throw error; }
      await completeCalendarRemoval(db, "google_calendar", removal);
    } catch (error) { if (error instanceof SchedulerBudgetError) throw error; const providerError = googleCalendarFailure(error); await failCalendarRemoval(db, "google_calendar", removal, providerError.message, providerError.retryAfterMs ?? 0); }
  }
  return { synced, queued, failed };
}
export async function retryGoogleCalendarOperations(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await googleCalendarSecret(env, true); const db = requireDatabase(env); const now = new Date().toISOString();
  // Retry makes failed operations and set-aside removals due again, in one batch, and the scheduler delivers them (the
  // route pokes it). Delivering here cost 43 subrequests for five operations, 53 when each needed a second request. It
  // also makes due any pending operation stored without a time, which the delivery job would otherwise never read.
  const results = await db.batch([calendarFailedRetry(db, "google_calendar", now), calendarRemovalRetry(db, "google_calendar", now), calendarWaitingCount(db, "google_calendar", now)]);
  const result = { synced: 0, queued: (results[0]?.meta?.changes ?? 0) + (results[1]?.meta?.changes ?? 0), failed: 0 };
  await writeAudit(db, principal, "google_calendar.retry_requested", "integration", "google_calendar", result);
  return response({ ...result, waiting: Number((results[2] as D1Result<{ waiting: number }>).results?.[0]?.waiting ?? 0), scheduler: calendarSchedulerMode(env), perPass: calendarPerPass.google_calendar });
}
/** What both Sync all routes select, stated in their responses. */
export const CALENDAR_SYNC_ALL_RULE = "Every meeting that is not deleted and has not ended is queued, current and upcoming alike, in one request with no limit. Meetings that have ended are left as they are. A deleted meeting whose event was never removed has that removal queued, and failed removals are tried again. Delivery is in the background: deletes first, then the soonest meeting first.";
/**
 * Sync all: queues an upsert for every current and upcoming meeting and creates missing mappings, set-based in one batch,
 * so 300 meetings cost what one does. It also repairs what an interrupted request left behind: a deleted meeting whose
 * event is still mapped as live gets its delete queued, and a mapping left inactive on a live meeting is reactivated. The
 * scheduled job delivers the queue, earliest meeting first; nothing is sent to Google by this request.
 */
export async function syncAllGoogleCalendarMeetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await googleCalendarSecret(env, true); const db = requireDatabase(env); const now = new Date().toISOString();
  const catchUp = calendarCatchUp(db, "google_calendar", now, principal.userId);
  const upcoming = calendarTargets.upcoming(now);
  // Event removals set aside after their last attempt get a fresh allowance too.
  const results = await db.batch([...catchUp.statements, calendarRemovalRetry(db, "google_calendar", now), db.prepare(`SELECT COUNT(*) AS selected FROM (${upcoming.sql})`).bind(...upcoming.values), calendarWaitingCount(db, "google_calendar", now)]);
  const selected = Number((results.at(-2) as D1Result<{ selected: number }>).results?.[0]?.selected ?? 0); const waiting = Number((results.at(-1) as D1Result<{ waiting: number }>).results?.[0]?.waiting ?? 0);
  const result = { synced: 0, queued: catchUp.queued(results, 0), failed: 0, selected, deletesQueued: catchUp.deletesQueued(results, 0), remaining: 0 };
  await writeAudit(db, principal, "google_calendar.sync_all_requested", "integration", "google_calendar", result);
  return response({ ...result, waiting, scheduler: calendarSchedulerMode(env), perPass: calendarPerPass.google_calendar, rule: CALENDAR_SYNC_ALL_RULE });
}

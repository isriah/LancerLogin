import { createSessionCodec } from "../runtime-security.ts";
import { decryptIntegration, encryptIntegration, integrationKeyUsable } from "../integration-crypto.ts";
import { kioskReleaseLookup } from "../release-discovery.ts";
import { type D1Database, type D1Statement } from "../d1-usage.ts";
import { SchedulerBudget, type PassCost } from "../scheduler-budget.ts";
import { HttpError } from "../http-error.ts";
import { type SchedulerNamespace } from "../platform-scheduler.ts";
import type { IntegrationProvider, IntegrationRecord } from "./integration-support.ts";

export type ModuleProviderAuthority = () => Promise<void>;
export const moduleProviderAuthority = Symbol("module-provider-authority");
export type ProviderConfiguration = Record<string, string> & { [moduleProviderAuthority]?: ModuleProviderAuthority };
export interface Env { APP_MODE: "unconfigured" | "configured"; ALLOWED_ORIGIN: string; SESSION_KEY?: string; INTEGRATION_KEY?: string; FINGERPRINT_VAULT_KEY?: string; BOOTSTRAP_CODE_HASH?: string; UPDATE_WORKFLOW_URL?: string; UPDATE_REPOSITORY?: string; WEB_UPDATE_TOKEN?: string; WEB_UPDATE_TOKEN_EXPIRES_AT?: string; MODULE_SELECTION_TOKEN?: string; MODULE_SELECTION_TOKEN_EXPIRES_AT?: string; RELEASE_VERSION?: string; DEPLOYMENT_MARKER?: string; DEFAULT_THEME?: string; DB?: D1Database; PLATFORM_SCHEDULER_MODE?: string; PLATFORM_SCHEDULER?: SchedulerNamespace; moduleProviderAuthority?: ModuleProviderAuthority; schedulerPass?: SchedulerPass; }
/** What a scheduled pass reads once and shares with every job: its budget, which modules may run, and integration records. */
export type SchedulerPass = { readonly budget: SchedulerBudget; readonly moduleGenerations: ReadonlyMap<string, number>; readonly integrations: Map<IntegrationProvider, Promise<IntegrationRecord | null>>; readonly pausedUntil: number | null;
  /** Whether jobs may split their work into one step per slice (Durable Object slices); the cron fallback runs every step at once. */
  readonly steps?: boolean;
  /** The step the running job asked to continue from. */
  cursor?: string };
/** Whether a scheduled pass can afford one more item of a job's batch. Outside a pass there is no shared budget. */
export const passAllows = (env: Env, cost: PassCost) => env.schedulerPass?.budget.allows(cost) ?? true;
/**
 * The same check for work that must not bring the job back early: a retry of something that already failed. When it
 * does not fit it simply waits for the job's next regular run.
 */
export const passFits = (env: Env, cost: PassCost) => env.schedulerPass?.budget.fits(cost) ?? true;
/** A scheduler job stopped at its own per-slice cap with new work left, so the scheduler runs it again within seconds. */
export const passMore = (env: Env) => env.schedulerPass?.budget.more();
export type WorkerContext = { waitUntil(promise: Promise<unknown>): void };
export type ScheduledController = { cron?: string; scheduledTime?: number };

export type Role = "admin" | "operator";
export type Principal = { userId: string; role: Role; expiresAt: number; authenticatedAt?: number; epoch?: number };
export type AuthMode = "google" | "local" | "both";
export type BootstrapInput = { setupCode?: string; organizationName?: string; timeZone?: string; authMode?: AuthMode; adminEmail?: string; localUsername?: string; localPasswordKey?: unknown; localPassword?: unknown; googleClientId?: string; googleClientSecret?: string; telemetryAccepted?: boolean };
export type BrandingInput = { organizationName?: string; subtitle?: string | null; logoData?: string | null; primaryColor?: string; secondaryColor?: string; appearance?: "system" | "themed" | "light" | "dark"; logoBackdrop?: "auto" | "light" | "dark" | "none"; lateScanMinutes?: number; earlyScanMinutes?: number; discordContestWindowHours?: number; attendanceReportingStartsOn?: string | null; anomalyLateThresholdMinutes?: number; anomalyEarlyThresholdMinutes?: number };
export type DiscordChannelManagerInput = { enabled?: boolean; contestWindowHours?: number; blockRecontestsAfterRejection?: boolean };
export type DiscordAnomalyReportsInput = { enabled?: boolean; channelId?: string | null };
/**
 * `refreshTokenExpiresAt` is when the refresh token stops working, from the refresh_token_expires_in Google returns
 * with a time-limited grant (for example an OAuth app still in Testing, whose tokens last seven days). Absent when
 * Google gave no lifetime: such a token works until it is revoked, which only a request to Google can find out.
 */
export type GoogleCalendarSecret = { clientId: string; clientSecret: string; refreshToken?: string; refreshTokenExpiresAt?: string; calendarId?: string; calendarLabel?: string };
export const googleRefreshTokenExpiresAt = (seconds: unknown): string | undefined => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1_000).toISOString() : undefined;
/**
 * Whether the stored Google Calendar authorization can no longer be used, from what the Worker already knows without
 * asking Google: a refresh Google refused (it clears authorized_at) or a refresh token past its lifetime.
 */
export function googleCalendarReauthorizationRequired(record: { authorizedAt?: string | null }, secret: Pick<GoogleCalendarSecret, "refreshToken" | "refreshTokenExpiresAt">, now = Date.now()): boolean {
  if (!secret.refreshToken) return false;
  const expiresAt = secret.refreshTokenExpiresAt ? Date.parse(secret.refreshTokenExpiresAt) : NaN;
  return !record.authorizedAt || (Number.isFinite(expiresAt) && expiresAt <= now);
}
export type MemberInput = { memberId?: string; firstName?: string; lastName?: string; email?: string | null; discordUserId?: string | null };
export type RecurrenceFrequency = "daily" | "weekly" | "biweekly" | "monthly";
export type MeetingInput = { meetingId?: string; title?: string; startsAt?: string; endsAt?: string | null; required?: boolean; notes?: string | null; weightCategoryId?: string | null; audienceMode?: "all" | "labels"; audienceLabelIds?: string[]; impactToken?: string; recurrence?: { frequency?: RecurrenceFrequency; until?: string } };
export type MeetingWeightCategory = { id: string; name: string; weight: number; minimumDurationMinutes?: number | null; position: number; active: number | boolean };
export type MeetingWeightCategoryInput = { name?: string; weight?: number; minimumDurationMinutes?: number | null; active?: boolean };
export type KioskCommandType = "reload_display" | "restart_service" | "reboot" | "reset_network_pin" | "install_latest" | "erase_unlinked_fingerprints";
export type KioskAuthenticationMethod = "fingerprint" | "rfid" | "nfc" | "member_id" | "qr";
export const kioskAuthenticationMethods = new Set<KioskAuthenticationMethod>(["fingerprint", "rfid", "nfc", "member_id", "qr"]);
export type KioskKind = "pi" | "web";
export type KioskMemberLookup = "entry" | "search";
export const kioskKinds = new Set<unknown>(["pi", "web"]);
 export const kioskMemberLookups = new Set<unknown>(["entry", "search"]);
// A kiosk that has not checked in for this long can be retired and replaced under its name from Add kiosk.
export const KIOSK_REPLACEABLE_AFTER_MS = 10 * 60_000;
// The release and exact commit an Update kiosk command is pinned to. Failures are specific 503s (see kioskReleaseError):
// a GitHub rate limit or outage is never reported as "no release".
export const latestCompatibleKioskRelease = (env: Env, channel: "stable" | "beta") => kioskReleaseLookup.lookup(env, channel);

export const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
export const validTimeZone = (value: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } };
export const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
export const validLogoData = (value: string) => value.length <= 180_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);

export function response(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(baseHeaders);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}
/**
 * Responses from a POST that only previews (an impact check, a dry-run import, a Discord role preview): they queue no
 * scheduler work, so the router does not poke the scheduler for them even though their path is one whose writes do.
 * A poke wakes the Durable Object, which then runs alarm slices with nothing to deliver.
 */
export const previewResponses = new WeakSet<Response>();
export function previewResponse(body: unknown): Response { const result = response(body); previewResponses.add(result); return result; }
export function withCors(result: Response, request: Request, env: Env): Response {
  const headers = new Headers(result.headers);
  const origin = request.headers.get("origin");
  if (origin && origin === env.ALLOWED_ORIGIN) { headers.set("access-control-allow-origin", origin); headers.set("access-control-allow-credentials", "true"); headers.set("vary", "origin"); }
  return new Response(result.body, { status: result.status, headers });
}
export class DiscordPermissionError extends HttpError {
  constructor(kind: "calendar" | "pin" | "commands" | "channel" | "roles" | "members" = "channel") { super(502, kind === "calendar" ? "Discord denied this request because the bot is missing a required permission. Confirm it is in the selected server and has the Create Events permission, which Discord requires to create scheduled events, before syncing the calendar." : kind === "pin" ? "Discord denied this request because the bot is missing Pin Messages permission in the configured attendance channel." : kind === "commands" ? "Discord denied command management. Confirm the saved application ID belongs to this bot and install the bot in the selected server before trying command setup again." : kind === "roles" ? "Discord denied a role change. Confirm the bot has Manage Roles and its highest role is above the mapped role." : kind === "members" ? "Discord denied the full server member list. Enable the privileged Server Members Intent for this bot in the Discord Developer Portal before syncing roles." : "Discord denied this request because the bot is missing a required permission. Confirm the bot can access the selected server and channel."); }
}
/** Discord answered 401: the saved bot token is no longer valid, so no request with it can succeed. */
export class DiscordTokenError extends HttpError {
  constructor() { super(502, "Discord rejected the saved bot token. Reset the token in Discord, replace the saved credentials, and try verification again."); }
}
export class DiscordResponseError extends HttpError {
  readonly discordStatus: number;
  readonly discordCode?: number;
  constructor(status: number, message: string, code?: number) { super(502, `Discord rejected the request (${status})${message ? `: ${message}` : ""}`); this.discordStatus = status; this.discordCode = code; }
}
export class EmailProviderError extends HttpError {
  readonly emailStatus: number;
  constructor(status: number, message: string, prefix = "Resend rejected the email") { super(502, `${prefix} (${status})${message ? `: ${message}` : ""}`); this.emailStatus = status; }
}
/** Resend's own error text, reduced to one short line so it is safe to show an Admin. */
export async function resendErrorMessage(result: Response): Promise<string> { const body = await result.json().catch(() => ({})) as { message?: unknown }; return typeof body.message === "string" ? body.message.replace(/\s+/g, " ").trim().slice(0, 180) : ""; }
export class GoogleCalendarProviderError extends Error {
  readonly providerStatus: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** True when only a new Google Calendar authorization by an Admin can fix the failure. */
  readonly reauthorize: boolean;
  constructor(providerStatus: number, message: string, retryable: boolean, retryAfterMs?: number, reauthorize = false) { super(message); this.providerStatus = providerStatus; this.retryable = retryable; this.retryAfterMs = retryAfterMs; this.reauthorize = reauthorize; }
}
const integrationTitles = { google: "Google OAuth", resend: "Resend", discord: "Discord", google_calendar: "Google Calendar" } as const;
/**
 * Saved credentials that this installation's integration key cannot decrypt (the key was replaced, or the data came from
 * an installation with another key), or whose stored value is damaged. Nothing can use them until an Admin saves them
 * again, which every save route allows without reading the old value. The message names no secret and nothing is logged.
 */
export class IntegrationUnreadableError extends HttpError {
  constructor(provider: keyof typeof integrationTitles) { super(503, `The saved ${integrationTitles[provider]} credentials can't be read. Enter them again under Settings > Integrations.`, undefined, "integration_unreadable"); }
}
const INTEGRATION_KEY_INVALID = "Integration encryption is not configured correctly: INTEGRATION_KEY must be 32 random bytes";
/** The one place saved integration credentials are decrypted for use: a failure is an IntegrationUnreadableError, never a raw crypto error. */
export async function readIntegrationSecret(env: Env, provider: keyof typeof integrationTitles, ciphertext: string | null | undefined, iv: string | null | undefined): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  if (!integrationKeyUsable(env.INTEGRATION_KEY)) throw new HttpError(503, INTEGRATION_KEY_INVALID);
  let value: unknown;
  try { value = await decryptIntegration(String(ciphertext ?? ""), String(iv ?? ""), env.INTEGRATION_KEY); } catch { throw new IntegrationUnreadableError(provider); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntegrationUnreadableError(provider);
  return value as Record<string, string>;
}
/** Whether saved credentials are there but cannot be read, for a status card. False when there is no usable key to try with. */
export async function integrationSecretUnreadable(env: Env, provider: keyof typeof integrationTitles, ciphertext: string | null | undefined, iv: string | null | undefined): Promise<boolean> {
  if (!integrationKeyUsable(env.INTEGRATION_KEY)) return false;
  try { await readIntegrationSecret(env, provider, ciphertext, iv); return false; } catch (error) { return error instanceof IntegrationUnreadableError; }
}
/** Encrypts credentials for saving; a key of the wrong size is a configuration error with its own message, not a 500. */
export async function sealIntegrationSecret(env: Env, value: Record<string, string>): Promise<{ ciphertext: string; iv: string }> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  if (!integrationKeyUsable(env.INTEGRATION_KEY)) throw new HttpError(503, INTEGRATION_KEY_INVALID);
  return encryptIntegration(value, env.INTEGRATION_KEY);
}
export async function parseJson<T>(request: Request, maxBytes = 262_144): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new HttpError(413, "Request body is too large");
  // Measure the bytes as received and decode them once; encoding the decoded text again only to count its bytes was a
  // second pass over a body that can be a 10 MiB backup.
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new HttpError(413, "Request body is too large");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { throw new HttpError(400, "Request body must be valid JSON"); }
}
export function requireDatabase(env: Env): D1Database { if (!env.DB) throw new HttpError(503, "D1 is not linked"); return env.DB; }
export async function requireProviderAuthority(env: Env): Promise<void> { await env.moduleProviderAuthority?.(); }
export function providerConfiguration(value: Record<string, string>, env: Env): ProviderConfiguration {
  const config = { ...value } as ProviderConfiguration;
  if (env.moduleProviderAuthority) Object.defineProperty(config, moduleProviderAuthority, { value: env.moduleProviderAuthority });
  return config;
}
// Attendance setup's Verified attendance input step is pairing a kiosk, so while Attendance is enabled, before its setup is
// finished, an Admin can create a pairing code and a kiosk can pair and check in. Everything else a kiosk or the Kiosks
// page does waits for setup to finish.
export const attendanceSetupPairingPaths: ReadonlySet<string> = new Set(["/admin/pairing-codes", "/kiosk/pair", "/kiosk/heartbeat"]);
export function moduleScopedEnvironment(env: Env, db: D1Database): Env {
  return { ...env, DB: db, moduleProviderAuthority: async () => { env.schedulerPass?.budget.chargeExternal(); await db.prepare("SELECT 1").first(); } };
}
export function cookie(request: Request, name: string): string | undefined { return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
type SessionUser = { id: string; role: Role; email?: string | null; localUsername?: string | null };
type SessionLookup = { claims: Promise<Principal>; current: Promise<{ principal: Principal; user: SessionUser }> };
/**
 * One session check per Request: the cookie's signature is verified once and the user row read once, however often the
 * module-route pre-check, the route handler and a module's ctx.requireRole ask. worker.fetch drops the entry when a
 * request starts, so a reused Request object never carries a principal into a later request.
 */
export const sessionLookups = new WeakMap<Request, SessionLookup>();
export function sessionLookup(request: Request, env: Env): SessionLookup {
  const existing = sessionLookups.get(request);
  if (existing) return existing;
  const claims = (async () => {
    if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
    const token = cookie(request, "lancerlogin_session");
    const principal = token ? await createSessionCodec(env.SESSION_KEY).verify(token) : undefined;
    if (!principal) throw new HttpError(401, "Sign in required");
    return principal;
  })();
  const current = claims.then(async (principal) => {
    // A token issued under an older session epoch was revoked by logout, password reset or deactivation. The profile
    // columns are what /auth/session returns, so it needs no second read.
    const user = await requireDatabase(env).prepare("SELECT id, role, email, local_username AS localUsername FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1 AND session_epoch = ?").bind(principal.userId, principal.epoch ?? 0).first<SessionUser>();
    if (!user) throw new HttpError(401, "Session user is unavailable");
    return { principal: { ...principal, role: user.role }, user };
  });
  // Every caller still sees a failure through its own await; this only keeps an unawaited copy from being reported.
  claims.catch(() => undefined); current.catch(() => undefined);
  const lookup = { claims, current };
  sessionLookups.set(request, lookup);
  return lookup;
}
/** A Request built from an authenticated one for an internal handler call shares its session check. */
export function withSession(source: Request, derived: Request): Request {
  const lookup = sessionLookups.get(source);
  if (lookup) sessionLookups.set(derived, lookup);
  return derived;
}
export async function principalFor(request: Request, env: Env): Promise<Principal> {
  return { ...(await sessionLookup(request, env).current).principal };
}
export async function requireRole(request: Request, env: Env, roles: Role[]): Promise<Principal> {
  const principal = await principalFor(request, env);
  if (!roles.includes(principal.role)) throw new HttpError(403, "Your role cannot perform this action");
  return principal;
}
/**
 * Start independent reads together and settle them all, then rethrow the first failure in argument order, so the error
 * a caller sees is the one sequential awaits would have produced. Each read is a thunk so a synchronous throw cannot
 * leave the others unobserved.
 */
export async function allInOrder<T extends readonly (() => unknown)[]>(...reads: T): Promise<{ -readonly [K in keyof T]: T[K] extends () => infer R ? Awaited<R> : never }> {
  const settled = await Promise.allSettled(reads.map(async (read) => read()));
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as never;
}
/**
 * requireRole and a read for the signed-in user in one D1 round trip: the read starts once the cookie's signature is
 * verified, beside the user lookup that checks revocation and role. The role check still decides first, so a signed-out,
 * revoked or unauthorized caller gets requireRole's 401 or 403 and the read's result or error is discarded. Use only for
 * reads without side effects that need nothing from the check except the token's user ID.
 */
export async function authorizedRead<T>(request: Request, env: Env, roles: Role[], read: (userId: string) => Promise<T>): Promise<[Principal, Awaited<T>]> {
  const { claims } = sessionLookup(request, env);
  return allInOrder(() => requireRole(request, env, roles), async () => read((await claims).userId));
}
export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
export function randomToken(bytes = 32): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
/** The audit row writeAudit inserts, as a statement to put in the same batch as the change it records. */
export function auditStatement(db: D1Database, principal: Principal, action: string, targetType: string, targetId: string | null, metadata: unknown = {}): D1Statement {
  return db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), principal.userId, action, targetType, targetId, JSON.stringify(metadata), new Date().toISOString());
}
export async function writeAudit(db: D1Database, principal: Principal, action: string, targetType: string, targetId: string | null, metadata: unknown = {}): Promise<void> {
  await auditStatement(db, principal, action, targetType, targetId, metadata).run();
}
export const sessionCookie = (token: string, maxAgeSeconds = 28800) => `lancerlogin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
/** The dashboard session cookie for a user who just proved a local password: local sign-in and first-Admin setup. */
export async function localSessionCookie(sessionKey: string, user: { id: string; role: Role; sessionEpoch?: number }): Promise<string> {
  return sessionCookie(await createSessionCodec(sessionKey).issue({ userId: user.id, role: user.role, epoch: Number(user.sessionEpoch ?? 0) }));
}
export function validTimestamp(value: string | undefined): value is string { return Boolean(value && Number.isFinite(Date.parse(value))); }
export const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

import { createSessionCodec, hashPassword, verifyPassword } from "./runtime-security.ts";
import { decryptIntegration, encryptIntegration } from "./integration-crypto.ts";
import { WebUpdateError, prepareWebUpdate, startWebUpdate, webUpdateStatus, recordUpdateBackup, webUpdateMaintenance } from "./web-updates.ts";
import { releaseDiscovery, releaseRequestHeaders } from "./release-discovery.ts";
import { attendanceAnomalyMinutes, attendanceClosesAt, attendanceDisposition, DEFAULT_ANOMALY_THRESHOLD_MINUTES, MAX_ANOMALY_THRESHOLD_MINUTES, meanAnomalousMinutes, nextAttendanceAction, overlappingMeetingWindows, scanWindowState, type AttendanceAction, type MeetingWindowLike } from "./attendance-lifecycle.ts";
import { evaluateAttendance, meetingEligibility, localDate as policyLocalDate, validDate, type AttendanceRule, type LabelChange, type Observation, type PolicyLabel, type PolicyMeeting, type PolicyMember, type PolicyMemberResult } from "./attendance-policy.ts";
import { buildReportRows, defaultReportDefinition, reportColumnCatalog, reportColumnId, reportColumnLabel, reportLabelsMatch, resolveReportPeriod, validateReportDefinition, type ReportDefinition, type ReportResultRow, type ReportScope } from "./report-builder.ts";

import { databaseIdentity, measureD1, usageCategory, type D1Database, type D1Statement } from "./d1-usage.ts";
import { ReportDataCache } from "./report-data-cache.ts";
export interface Env { APP_MODE: "unconfigured" | "configured"; ALLOWED_ORIGIN: string; SESSION_KEY?: string; INTEGRATION_KEY?: string; BOOTSTRAP_CODE_HASH?: string; UPDATE_WORKFLOW_URL?: string; UPDATE_REPOSITORY?: string; WEB_UPDATE_TOKEN?: string; WEB_UPDATE_TOKEN_EXPIRES_AT?: string; RELEASE_VERSION?: string; DB?: D1Database; }
type WorkerContext = { waitUntil(promise: Promise<unknown>): void };
type ScheduledController = { cron?: string };

type Role = "admin" | "operator";
type Principal = { userId: string; role: Role; expiresAt: number };
type AuthMode = "google" | "local" | "both";
type SetupStep = "branding" | "roster" | "pair-kiosk" | "fingerprint-test" | "confirm-attendance";
type BootstrapInput = { setupCode?: string; organizationName?: string; timeZone?: string; authMode?: AuthMode; adminEmail?: string; localUsername?: string; localPassword?: string; googleClientId?: string; googleClientSecret?: string; telemetryAccepted?: boolean };
type BrandingInput = { organizationName?: string; subtitle?: string | null; logoData?: string | null; primaryColor?: string; secondaryColor?: string; appearance?: "system" | "themed" | "light" | "dark"; logoBackdrop?: "auto" | "light" | "dark" | "none"; lateScanMinutes?: number; discordContestWindowHours?: number; attendanceReportingStartsOn?: string | null; anomalyLateThresholdMinutes?: number; anomalyEarlyThresholdMinutes?: number };
type DiscordChannelManagerInput = { enabled?: boolean; contestWindowHours?: number };
type DiscordAnomalyReportsInput = { enabled?: boolean; channelId?: string | null };
type GoogleCalendarSecret = { clientId: string; clientSecret: string; refreshToken?: string; calendarId?: string; calendarLabel?: string };
type MemberInput = { memberId?: string; firstName?: string; lastName?: string; email?: string | null; discordUserId?: string | null; attendanceRequiredFrom?: string | null };
type RecurrenceFrequency = "daily" | "weekly" | "biweekly" | "monthly";
type MeetingInput = { meetingId?: string; title?: string; startsAt?: string; endsAt?: string | null; required?: boolean; notes?: string | null; weightCategoryId?: string | null; audienceMode?: "all" | "labels"; audienceLabelIds?: string[]; impactToken?: string; recurrence?: { frequency?: RecurrenceFrequency; until?: string } };
type MeetingWeightCategory = { id: string; name: string; weight: number; minimumDurationMinutes?: number | null; position: number; active: number | boolean };
type MeetingWeightCategoryInput = { name?: string; weight?: number; minimumDurationMinutes?: number | null; active?: boolean };
type KioskCommandType = "reload_display" | "restart_service" | "reboot" | "reset_network_pin" | "install_latest";
const latestKioskReleaseUrl = "https://api.github.com/repos/isriah/LancerLogin/releases/latest";
const compatibleKioskRelease = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?![\s\S])/;
type GitHubRelease = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
function compatibleReleaseTag(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const release = value as GitHubRelease;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") return undefined;
  if (!compatibleKioskRelease.test(release.tag_name) || !Array.isArray(release.assets)) return undefined;
  const names = new Set(release.assets.map((asset) => asset?.name));
  const version = release.tag_name.slice(1);
  const required = ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => {
    const archive = `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`;
    return [archive, `${archive}.sha256`];
  })];
  return required.every((name) => names.has(name)) ? release.tag_name : undefined;
}
async function latestCompatibleKioskRelease(env: Env): Promise<string> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const request = { headers: releaseRequestHeaders(env), redirect: "manual" as const, signal: controller.signal };
    const latest = await fetch(latestKioskReleaseUrl, request);
    if (!latest.ok) throw new Error("Latest release feed unavailable");
    const latestTag = compatibleReleaseTag(await latest.json().catch(() => undefined));
    if (latestTag) return latestTag;

    // Match the no-argument root helper: one latest resolution, no fallback
    // to a different release and no dashboard-supplied tag or response URL.
    throw new Error("No compatible release");
  } catch {
    throw new HttpError(503, "No compatible official kiosk release is currently available. Try again after checking the release feed.");
  } finally { clearTimeout(timer); }
}

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const setupSteps = new Set<SetupStep>(["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"]);
const validTimeZone = (value: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } };
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
const validLogoData = (value: string) => value.length <= 180_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
let dummyPasswordHash: Promise<string> | undefined;
const timingEqualizerHash = () => dummyPasswordHash ??= hashPassword("LancerLogin timing equalizer", new Uint8Array(16));

function response(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(baseHeaders);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}
function withCors(result: Response, request: Request, env: Env): Response {
  const headers = new Headers(result.headers);
  const origin = request.headers.get("origin");
  if (origin && origin === env.ALLOWED_ORIGIN) { headers.set("access-control-allow-origin", origin); headers.set("access-control-allow-credentials", "true"); headers.set("vary", "origin"); }
  return new Response(result.body, { status: result.status, headers });
}
class HttpError extends Error {
  readonly status: number;
  readonly details?: string[];
  constructor(status: number, message: string, details?: string[]) { super(message); this.status = status; this.details = details; }
}
class DiscordPermissionError extends HttpError {
  constructor(kind: "calendar" | "pin" | "commands" | "channel" | "roles" | "members" = "channel") { super(502, kind === "calendar" ? "Discord denied this request because the bot is missing a required permission. Confirm it is in the selected server and has Manage Events permission before syncing the calendar." : kind === "pin" ? "Discord denied this request because the bot is missing Pin Messages permission in the configured attendance channel." : kind === "commands" ? "Discord denied command management. Confirm the saved application ID belongs to this bot and install the bot in the selected server before trying command setup again." : kind === "roles" ? "Discord denied a role change. Confirm the bot has Manage Roles and its highest role is above the mapped role." : kind === "members" ? "Discord denied the full server member list. Enable the privileged Guild Members intent for this bot before syncing roles." : "Discord denied this request because the bot is missing a required permission. Confirm the bot can access the selected server and channel."); }
}
class DiscordRateLimitError extends HttpError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, operation = "calendar sync") { super(503, `Discord is rate limiting ${operation}. Wait ${Math.ceil(retryAfterMs / 1000)} seconds before trying again.`); this.retryAfterMs = retryAfterMs; }
}
class DiscordResponseError extends HttpError {
  readonly discordStatus: number;
  readonly discordCode?: number;
  constructor(status: number, message: string, code?: number) { super(502, `Discord rejected the request (${status})${message ? `: ${message}` : ""}`); this.discordStatus = status; this.discordCode = code; }
}
class GoogleCalendarProviderError extends Error {
  readonly providerStatus: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(providerStatus: number, message: string, retryable: boolean, retryAfterMs?: number) { super(message); this.providerStatus = providerStatus; this.retryable = retryable; this.retryAfterMs = retryAfterMs; }
}
async function parseJson<T>(request: Request, maxBytes = 262_144): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new HttpError(413, "Request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new HttpError(413, "Request body is too large");
  try { return JSON.parse(text) as T; } catch { throw new HttpError(400, "Request body must be valid JSON"); }
}
function requireDatabase(env: Env): D1Database { if (!env.DB) throw new HttpError(503, "D1 is not linked"); return env.DB; }
function cookie(request: Request, name: string): string | undefined { return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
async function principalFor(request: Request, env: Env): Promise<Principal> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const token = cookie(request, "lancerlogin_session");
  const principal = token ? await createSessionCodec(env.SESSION_KEY).verify(token) : undefined;
  if (!principal) throw new HttpError(401, "Sign in required");
  const current = await requireDatabase(env).prepare("SELECT id, role FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(principal.userId).first<{ id: string; role: Role }>();
  if (!current) throw new HttpError(401, "Session user is unavailable");
  return { ...principal, role: current.role };
}
async function requireRole(request: Request, env: Env, roles: Role[]): Promise<Principal> {
  const principal = await principalFor(request, env);
  if (!roles.includes(principal.role)) throw new HttpError(403, "Your role cannot perform this action");
  return principal;
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
function randomToken(bytes = 32): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function writeAudit(db: D1Database, principal: Principal, action: string, targetType: string, targetId: string | null, metadata: unknown = {}): Promise<void> {
  await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), principal.userId, action, targetType, targetId, JSON.stringify(metadata), new Date().toISOString()).run();
}

async function setupStatus(env: Env): Promise<Response> {
  const db = requireDatabase(env);
  const installation = await db.prepare("SELECT id, auth_mode AS authMode, telemetry_accepted_at AS telemetryAcceptedAt FROM installations WHERE id = ?").bind("primary").first<{ id: string; authMode: AuthMode; telemetryAcceptedAt?: string }>();
  if (!installation) return response({ configured: false });
  const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone, logo_backdrop AS logoBackdrop, late_scan_minutes AS lateScanMinutes, discord_contest_window_hours AS discordContestWindowHours, attendance_reporting_starts_on AS attendanceReportingStartsOn, anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes FROM organization_settings WHERE installation_id = ?").bind(installation.id).first();
  return response({ configured: true, installation: { id: installation.id, authMode: installation.authMode, telemetryAccepted: false }, settings });
}
function validateBootstrap(input: BootstrapInput): string[] {
  const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (!input.timeZone || !validTimeZone(input.timeZone)) errors.push("A valid IANA time zone is required");
  if (!input.authMode || !["google", "local", "both"].includes(input.authMode)) errors.push("Authentication mode must be google, local, or both");
  if ((input.authMode === "google" || input.authMode === "both") && (!input.adminEmail || !validEmail(input.adminEmail))) errors.push("A valid first-Admin email is required for Google sign-in");
  if ((input.authMode === "google" || input.authMode === "both") && (!input.googleClientId?.trim() || !input.googleClientSecret?.trim() || input.googleClientId.length > 500 || input.googleClientSecret.length > 500)) errors.push("Google sign-in requires an OAuth client ID and client secret");
  if ((input.authMode === "local" || input.authMode === "both") && (!input.localUsername?.trim() || (input.localPassword?.length ?? 0) < 12)) errors.push("Local sign-in requires a username and a password of at least 12 characters");
  return errors;
}
async function bootstrap(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env);
  if (await db.prepare("SELECT id FROM installations WHERE id = ?").bind("primary").first()) throw new HttpError(409, "Installation is already configured");
  const input = await parseJson<BootstrapInput>(request);
  if (!env.BOOTSTRAP_CODE_HASH) throw new HttpError(503, "First-Admin setup protection is not configured");
  const suppliedCodeHash = await sha256(input.setupCode ?? "");
  if (!constantTimeEqual(suppliedCodeHash, env.BOOTSTRAP_CODE_HASH)) throw new HttpError(403, "The one-time setup code is invalid");
  const errors = validateBootstrap(input);
  if (errors.length) throw new HttpError(400, "Invalid setup", errors);
  if ((input.authMode === "google" || input.authMode === "both") && !env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const now = new Date().toISOString(); const adminId = crypto.randomUUID(); const mode = input.authMode!;
  const passwordHash = mode === "local" || mode === "both" ? await hashPassword(input.localPassword!) : null;
  const telemetryAcceptedAt = null; // Historical columns remain inert for backup compatibility.
  const statements = [
    db.prepare("INSERT INTO installations (id, created_at, auth_mode, telemetry_accepted_at, telemetry_install_id, google_enabled) VALUES (?, ?, ?, ?, ?, ?)").bind("primary", now, mode, telemetryAcceptedAt, null, mode === "google" || mode === "both" ? 1 : 0),
    db.prepare("INSERT INTO organization_settings (installation_id, organization_name, time_zone) VALUES (?, ?, ?)").bind("primary", input.organizationName!.trim(), input.timeZone),
    db.prepare("INSERT INTO users (id, installation_id, email, local_username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)").bind(adminId, "primary", input.adminEmail?.toLowerCase() ?? null, input.localUsername?.trim().toLowerCase() ?? null, passwordHash, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), "primary", adminId, "installation.created", "installation", "primary", now),
  ];
  if (mode === "google" || mode === "both") {
    const encrypted = await encryptIntegration({ clientId: input.googleClientId!.trim(), clientSecret: input.googleClientSecret!.trim() }, env.INTEGRATION_KEY!);
    statements.push(
      db.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, updated_at) VALUES (?, 'primary', 'google', ?, ?, ?)").bind(crypto.randomUUID(), encrypted.ciphertext, encrypted.iv, now),
      db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, 'primary', ?, 'integration.saved', 'integration', 'google', ?)").bind(crypto.randomUUID(), adminId, now),
    );
  }
  await db.batch(statements);
  return response({ configured: true, admin: { id: adminId, email: input.adminEmail?.toLowerCase(), localUsername: input.localUsername?.trim().toLowerCase(), role: "admin" }, telemetryAccepted: false }, 201);
}
async function updateInfo(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  if (!env.UPDATE_WORKFLOW_URL) throw new HttpError(503, "The private deployment workflow is not configured");
  return response({ releaseVersion: env.RELEASE_VERSION ?? "development", workflowUrl: env.UPDATE_WORKFLOW_URL });
}
async function discoverRelease(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const result = await releaseDiscovery.check(env);
  return response(result, result.fresh ? 200 : result.code === "rate_limited" ? 429 : 503,
    result.retryAt ? { "retry-after": String(Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000))) } : undefined);
}
async function webUpdates(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]);
  if (request.method === "GET") return response(await webUpdateStatus(env));
  if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Web updates require the dashboard origin");
  const input = await parseJson<Record<string, unknown>>(request, 2_048);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Invalid web update request");
  if (new URL(request.url).pathname.endsWith("/prepare")) {
    if (Object.keys(input).length) throw new HttpError(400, "Prepare accepts no release or deployment parameters");
    return response(await prepareWebUpdate(env, principal.userId));
  }
  return response(await startWebUpdate(env, input, principal.userId), 202);
}
async function localLogin(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); if (!env.SESSION_KEY) throw new HttpError(503, "Local authentication is not configured");
  const input = await parseJson<{ username?: string; password?: string }>(request);
  if (!input.username || !input.password) throw new HttpError(400, "Username and password are required");
  const user = await db.prepare("SELECT id, role, debug_mode AS debugMode, password_hash AS passwordHash, failed_login_count AS failedLoginCount, locked_until AS lockedUntil FROM users WHERE installation_id = ? AND local_username = ? AND active = 1").bind("primary", input.username.trim().toLowerCase()).first<{ id: string; role: Role; debugMode: number; passwordHash: string | null; failedLoginCount: number; lockedUntil?: string }>();
  const passwordValid = await verifyPassword(input.password, user?.passwordHash ?? await timingEqualizerHash());
  const locked = Boolean(user?.lockedUntil && Date.parse(user.lockedUntil) > Date.now());
  if (!user?.passwordHash || !passwordValid || locked) {
    if (user && !locked) { const failures = Number(user.failedLoginCount ?? 0) + 1; const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null; await db.prepare("UPDATE users SET failed_login_count = ?, locked_until = ? WHERE installation_id = 'primary' AND id = ?").bind(failures, lockedUntil, user.id).run(); }
    throw new HttpError(401, "Invalid username or password");
  }
  if (user.failedLoginCount || user.lockedUntil) await db.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE installation_id = 'primary' AND id = ?").bind(user.id).run();
  const token = await createSessionCodec(env.SESSION_KEY).issue({ userId: user.id, role: user.role });
  return response({ ok: true, user: { id: user.id, role: user.role, debugMode: Boolean(user.debugMode) } }, 200, { "set-cookie": `lancerlogin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
}
async function authSession(request: Request, env: Env): Promise<Response> {
  const principal = await principalFor(request, env);
  const user = await requireDatabase(env).prepare("SELECT id, email, local_username AS localUsername, role, debug_mode AS debugMode FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(principal.userId).first<{ id: string; email?: string; localUsername?: string; role: Role; debugMode: number }>();
  if (!user) throw new HttpError(401, "Session user is unavailable");
  return response({ authenticated: true, user: { ...user, debugMode: Boolean(user.debugMode) } });
}
async function authPreferences(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<{ debugMode?: boolean }>(request);
  if (typeof input.debugMode !== "boolean") throw new HttpError(400, "Debug mode must be true or false");
  await db.prepare("UPDATE users SET debug_mode = ? WHERE installation_id = 'primary' AND id = ?").bind(input.debugMode ? 1 : 0, principal.userId).run();
  await writeAudit(db, principal, "user.preferences_updated", "user", principal.userId, { debugMode: input.debugMode });
  return response({ debugMode: input.debugMode });
}

async function branding(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") {
    const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone, logo_backdrop AS logoBackdrop, late_scan_minutes AS lateScanMinutes, discord_contest_window_hours AS discordContestWindowHours, attendance_reporting_starts_on AS attendanceReportingStartsOn, anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes FROM organization_settings WHERE installation_id = 'primary'").first();
    return response({ settings });
  }
  const input = await parseJson<BrandingInput>(request); const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (input.subtitle && input.subtitle.length > 140) errors.push("Subtitle must be at most 140 characters");
  if (input.logoData && !validLogoData(input.logoData)) errors.push("Logo must be a PNG, JPEG, or WebP image no larger than 128 KiB");
  if (!input.primaryColor || !validColor(input.primaryColor) || !input.secondaryColor || !validColor(input.secondaryColor)) errors.push("Brand colors must use six-digit hex values");
  if (!input.appearance || !["system", "themed", "light", "dark"].includes(input.appearance)) errors.push("Appearance must be themed, light, dark, or follow the device");
  if (!input.logoBackdrop || !["auto", "light", "dark", "none"].includes(input.logoBackdrop)) errors.push("Logo background must be automatic, light, dark, or none");
  if (!Number.isInteger(input.lateScanMinutes) || input.lateScanMinutes! < 0 || input.lateScanMinutes! > 180) errors.push("Late scan window must be from 0 to 180 minutes");
  if (!Number.isInteger(input.discordContestWindowHours) || input.discordContestWindowHours! < 1 || input.discordContestWindowHours! > 168) errors.push("Discord contest window must be from 1 to 168 hours");
  if (input.anomalyLateThresholdMinutes !== undefined && (!Number.isInteger(input.anomalyLateThresholdMinutes) || input.anomalyLateThresholdMinutes < 0 || input.anomalyLateThresholdMinutes > MAX_ANOMALY_THRESHOLD_MINUTES)) errors.push("Late-arrival threshold must be from 0 to 1440 minutes");
  if (input.anomalyEarlyThresholdMinutes !== undefined && (!Number.isInteger(input.anomalyEarlyThresholdMinutes) || input.anomalyEarlyThresholdMinutes < 0 || input.anomalyEarlyThresholdMinutes > MAX_ANOMALY_THRESHOLD_MINUTES)) errors.push("Early-departure threshold must be from 0 to 1440 minutes");
  if (input.attendanceReportingStartsOn !== undefined && input.attendanceReportingStartsOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.attendanceReportingStartsOn)) errors.push("Attendance reporting baseline must be YYYY-MM-DD");
  if (errors.length) throw new HttpError(400, "Invalid branding", errors);
  await assertNoMeetingOverlap(db, [], input.lateScanMinutes!);
  await db.prepare("UPDATE organization_settings SET organization_name = ?, subtitle = ?, logo_data = ?, primary_color = ?, secondary_color = ?, appearance = ?, logo_backdrop = ?, late_scan_minutes = ?, discord_contest_window_hours = ?, attendance_reporting_starts_on = ?, anomaly_late_threshold_minutes = COALESCE(?, anomaly_late_threshold_minutes), anomaly_early_threshold_minutes = COALESCE(?, anomaly_early_threshold_minutes) WHERE installation_id = 'primary'")
    .bind(input.organizationName!.trim(), input.subtitle?.trim() || null, input.logoData || null, input.primaryColor!.toLowerCase(), input.secondaryColor!.toLowerCase(), input.appearance === "themed" ? "system" : input.appearance, input.logoBackdrop, input.lateScanMinutes, input.discordContestWindowHours, input.attendanceReportingStartsOn || null, input.anomalyLateThresholdMinutes ?? null, input.anomalyEarlyThresholdMinutes ?? null).run();
  await writeAudit(db, principal, "branding.updated", "organization_settings", "primary", { attendanceReportingStartsOn: input.attendanceReportingStartsOn || null, anomalyLateThresholdMinutes: input.anomalyLateThresholdMinutes, anomalyEarlyThresholdMinutes: input.anomalyEarlyThresholdMinutes }); return response({ ok: true });
}
function validateMeetingWeightCategory(input: MeetingWeightCategoryInput, partial = false): string[] {
  const errors: string[] = [];
  if ((!partial || input.name !== undefined) && (!input.name?.trim() || input.name.trim().length > 80)) errors.push("Category name is required and must be at most 80 characters");
  if ((!partial || input.weight !== undefined) && (typeof input.weight !== "number" || !Number.isFinite(input.weight) || input.weight < 0.1 || input.weight > 100)) errors.push("Weight must be from 0.1 to 100");
  if (input.minimumDurationMinutes !== undefined && input.minimumDurationMinutes !== null && (!Number.isInteger(input.minimumDurationMinutes) || input.minimumDurationMinutes < 1 || input.minimumDurationMinutes > 10_080)) errors.push("Minimum duration must be from 1 to 10080 minutes");
  if (input.active !== undefined && typeof input.active !== "boolean") errors.push("Active must be true or false");
  return errors;
}
async function listMeetingWeightCategories(request: Request, env: Env, includeRetired: boolean): Promise<Response> {
  await requireRole(request, env, includeRetired ? ["admin"] : ["admin", "operator"]);
  const result = await requireDatabase(env).prepare(`SELECT id, name, weight, minimum_duration_minutes AS minimumDurationMinutes, position, active FROM meeting_weight_categories WHERE installation_id = 'primary'${includeRetired ? "" : " AND active = 1"} ORDER BY active DESC, position, name COLLATE NOCASE`).all<MeetingWeightCategory>();
  return response({ categories: (result.results ?? []).map((category) => ({ ...category, active: Boolean(category.active) })) });
}
async function createMeetingWeightCategory(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<MeetingWeightCategoryInput>(request); const errors = validateMeetingWeightCategory(input);
  if (errors.length) throw new HttpError(400, "Invalid meeting weight category", errors);
  const duplicate = await db.prepare("SELECT id FROM meeting_weight_categories WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE").bind(input.name!.trim()).first();
  if (duplicate) throw new HttpError(409, "A meeting weight category with that name already exists");
  const last = await db.prepare("SELECT COALESCE(MAX(position), -1) AS position, COUNT(*) AS count FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1").first<{ position?: number; count?: number }>();
  if (Number(last?.count ?? 0) >= 100) throw new HttpError(409, "Retire an active meeting weight category before adding another");
  const id = crypto.randomUUID(); const now = new Date().toISOString(); const position = Number(last?.position ?? -1) + 1;
  await db.batch([
    db.prepare("INSERT INTO meeting_weight_categories (id, installation_id, name, weight, minimum_duration_minutes, position, active, created_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, ?, 1, ?, ?, ?)").bind(id, input.name!.trim(), input.weight, input.minimumDurationMinutes ?? null, position, principal.userId, now, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting_weight_category.created', 'meeting_weight_category', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ name: input.name!.trim(), weight: input.weight, minimumDurationMinutes: input.minimumDurationMinutes ?? null, position }), now),
  ]);
  return response({ category: { id, name: input.name!.trim(), weight: input.weight!, minimumDurationMinutes: input.minimumDurationMinutes ?? null, position, active: true } }, 201);
}
async function updateMeetingWeightCategory(request: Request, env: Env, categoryId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<MeetingWeightCategoryInput>(request); const errors = validateMeetingWeightCategory(input, true);
  if (errors.length || !Object.keys(input).some((key) => ["name", "weight", "minimumDurationMinutes", "active"].includes(key))) throw new HttpError(400, "Invalid meeting weight category", errors.length ? errors : ["Provide at least one category change"]);
  const current = await db.prepare("SELECT id, name, weight, minimum_duration_minutes AS minimumDurationMinutes, position, active FROM meeting_weight_categories WHERE installation_id = 'primary' AND id = ?").bind(categoryId).first<MeetingWeightCategory>();
  if (!current) throw new HttpError(404, "Meeting weight category not found");
  const name = input.name?.trim() ?? current.name; const weight = input.weight ?? current.weight; const minimumDurationMinutes = input.minimumDurationMinutes === undefined ? current.minimumDurationMinutes ?? null : input.minimumDurationMinutes; const active = input.active ?? Boolean(current.active);
  const duplicate = await db.prepare("SELECT id FROM meeting_weight_categories WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE AND id <> ?").bind(name, categoryId).first();
  if (duplicate) throw new HttpError(409, "A meeting weight category with that name already exists");
  const now = new Date().toISOString(); let position = current.position;
  if (active && !current.active) { const last = await db.prepare("SELECT COALESCE(MAX(position), -1) AS position FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1").first<{ position?: number }>(); position = Number(last?.position ?? -1) + 1; }
  await db.prepare("UPDATE meeting_weight_categories SET name = ?, weight = ?, minimum_duration_minutes = ?, position = ?, active = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ?").bind(name, weight, minimumDurationMinutes, position, active ? 1 : 0, now, categoryId).run();
  await writeAudit(db, principal, active ? "meeting_weight_category.updated" : "meeting_weight_category.retired", "meeting_weight_category", categoryId, { name, weight, minimumDurationMinutes, active });
  return response({ category: { id: categoryId, name, weight, minimumDurationMinutes, position, active } });
}
async function reorderMeetingWeightCategories(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ orderedIds?: string[] }>(request); const orderedIds = input.orderedIds;
  if (!Array.isArray(orderedIds) || orderedIds.length > 100 || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => typeof id !== "string" || !id)) throw new HttpError(400, "Provide each active category exactly once in the desired order");
  const current = await db.prepare("SELECT id FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1 ORDER BY position, name COLLATE NOCASE").all<{ id: string }>(); const currentIds = (current.results ?? []).map((item) => item.id);
  if (currentIds.length !== orderedIds.length || currentIds.some((id) => !orderedIds.includes(id))) throw new HttpError(409, "The category list changed; refresh and try again");
  const now = new Date().toISOString(); const statements = orderedIds.map((id, position) => db.prepare("UPDATE meeting_weight_categories SET position = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(position, now, id));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting_weight_category.reordered', 'meeting_weight_category', NULL, ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ orderedIds }), now));
  await db.batch(statements); return response({ orderedIds });
}
type MeetingWeightAssignment = { id: string; name: string; weight: number };
async function resolveMeetingWeightAssignment(db: D1Database, categoryId: string | null | undefined, startsAt: string, endsAt: string): Promise<MeetingWeightAssignment | null> {
  if (categoryId === null) return null;
  if (categoryId !== undefined) {
    const category = await db.prepare("SELECT id, name, weight FROM meeting_weight_categories WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(categoryId).first<MeetingWeightAssignment>();
    if (!category) throw new HttpError(400, "Choose an active meeting weight category or the default weight");
    return category;
  }
  const durationMinutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  return await db.prepare("SELECT id, name, weight FROM meeting_weight_categories WHERE installation_id = 'primary' AND active = 1 AND minimum_duration_minutes IS NOT NULL AND minimum_duration_minutes <= ? ORDER BY position, name COLLATE NOCASE LIMIT 1").bind(durationMinutes).first<MeetingWeightAssignment>();
}
async function setupProgress(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT step, completed_at AS completedAt, completed_by AS completedBy FROM setup_progress WHERE installation_id = 'primary' ORDER BY completed_at").all<{ step: SetupStep; completedAt: string; completedBy: string }>(); return response({ completedSteps: (result.results ?? []).filter((item) => setupSteps.has(item.step)) }); }
  const input = await parseJson<{ step?: SetupStep; completed?: boolean }>(request);
  if (!input.step || !setupSteps.has(input.step) || typeof input.completed !== "boolean") throw new HttpError(400, "A valid setup step and completed flag are required");
  if (input.completed) await db.prepare("INSERT INTO setup_progress (installation_id, step, completed_at, completed_by) VALUES ('primary', ?, ?, ?) ON CONFLICT(installation_id, step) DO UPDATE SET completed_at = excluded.completed_at, completed_by = excluded.completed_by").bind(input.step, new Date().toISOString(), principal.userId).run();
  else await db.prepare("DELETE FROM setup_progress WHERE installation_id = 'primary' AND step = ?").bind(input.step).run();
  await writeAudit(db, principal, input.completed ? "setup.step_completed" : "setup.step_reopened", "setup_step", input.step); return response({ ok: true, step: input.step, completed: input.completed });
}
type LabelMutation = { memberId: string; label: string; action?: "add" | "remove"; effectiveDate?: string };
async function labels(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, request.method === "GET" ? ["admin", "operator"] : ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") {
    const [catalog, history, periods, rules, settings] = await Promise.all([
      db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' ORDER BY name COLLATE NOCASE").all(),
      db.prepare("SELECT c.id, c.member_id AS memberId, m.external_id AS externalMemberId, c.label_id AS labelId, c.action, c.effective_date AS effectiveDate, c.created_at AS createdAt FROM member_label_changes c JOIN members m ON m.id = c.member_id AND m.installation_id = c.installation_id WHERE c.installation_id = 'primary' ORDER BY c.effective_date, c.created_at, c.id").all(),
      db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, meetings_per_week AS meetingsPerWeek FROM label_attendance_rules WHERE installation_id = 'primary' AND rule_type = 'weekly_count' AND starts_on IS NOT NULL AND ends_on IS NOT NULL ORDER BY starts_on").all(),
      db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, rule_type AS ruleType, threshold_percent AS thresholdPercent, meetings_per_week AS meetingsPerWeek, excused_handling AS excusedHandling FROM label_attendance_rules WHERE installation_id = 'primary' ORDER BY label_id, starts_on").all(),
      db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string }>(),
    ]);
    return response({ labels: catalog.results ?? [], history: history.results ?? [], periods: periods.results ?? [], rules: rules.results ?? [], today: policyLocalDate(new Date().toISOString(), settings?.timeZone ?? "UTC") });
  }
  const input = await parseJson<{ name?: string; formulaEnabled?: boolean }>(request);
  const name = input.name?.trim(); if (!name || name.length > 80 || typeof input.formulaEnabled !== "undefined" && typeof input.formulaEnabled !== "boolean") throw new HttpError(400, "Label name must be 1 to 80 characters");
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const existing = await db.prepare("SELECT id FROM member_labels WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE").bind(name).first();
  if (existing) throw new HttpError(409, "A label with that name already exists");
  await db.batch([db.prepare("INSERT INTO member_labels (id, installation_id, name, formula_enabled, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?)").bind(id, name, input.formulaEnabled ? 1 : 0, principal.userId, now), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'label.created', 'member_label', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ name, formulaEnabled: Boolean(input.formulaEnabled) }), now)]);
  return response({ label: { id, name, active: true, formulaEnabled: Boolean(input.formulaEnabled) } }, 201);
}
async function updateLabel(request: Request, env: Env, labelId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const current = await db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' AND id = ?").bind(labelId).first<{ id: string; name: string; active: number; formulaEnabled: number }>();
  if (!current) throw new HttpError(404, "Label not found");
  const input = await parseJson<{ name?: string; active?: boolean }>(request);
  const name = input.name === undefined ? current.name : input.name.trim(); const active = input.active === undefined ? Boolean(current.active) : input.active;
  if (!name || name.length > 80 || typeof active !== "boolean") throw new HttpError(400, "Invalid label update");
  const duplicate = await db.prepare("SELECT id FROM member_labels WHERE installation_id = 'primary' AND name = ? COLLATE NOCASE AND id != ?").bind(name, labelId).first();
  if (duplicate) throw new HttpError(409, "A label with that name already exists");
  await db.prepare("UPDATE member_labels SET name = ?, active = ? WHERE installation_id = 'primary' AND id = ?").bind(name, active ? 1 : 0, labelId).run();
  await writeAudit(db, principal, "label.updated", "member_label", labelId, { before: current, after: { name, active } });
  return response({ label: { ...current, name, active } });
}
async function labelTarget(request: Request, env: Env, targetId?: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "DELETE") {
    const target = await db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn FROM label_attendance_rules WHERE installation_id = 'primary' AND id = ? AND rule_type = 'weekly_count'").bind(targetId).first();
    if (!target) throw new HttpError(404, "Weekly target not found");
    await db.batch([db.prepare("DELETE FROM label_attendance_rules WHERE installation_id = 'primary' AND id = ?").bind(targetId), db.prepare("DELETE FROM label_weekly_targets WHERE installation_id = 'primary' AND (id = ? OR 'legacy:' || id = ?)").bind(targetId, targetId)]); await writeAudit(db, principal, "label.target_removed", "weekly_target", targetId!, target); return response({ removed: true });
  }
  const input = await parseJson<{ labelId?: string; startsOn?: string; endsOn?: string; meetingsPerWeek?: number }>(request);
  if (!input.labelId || !validDate(input.startsOn) || !validDate(input.endsOn) || input.endsOn < input.startsOn || !Number.isSafeInteger(input.meetingsPerWeek) || Number(input.meetingsPerWeek) < 1 || Number(input.meetingsPerWeek) > 100) throw new HttpError(400, "Choose a label, valid period, and positive weekly target");
  const label = await db.prepare("SELECT id, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' AND id = ?").bind(input.labelId).first<{ id: string; active: number; formulaEnabled: number }>();
  if (!label || !label.active) throw new HttpError(400, "Choose an active label");
  const overlap = await db.prepare("SELECT id FROM label_attendance_rules WHERE installation_id = 'primary' AND label_id = ? AND starts_on <= ? AND COALESCE(ends_on, '9999-12-31') >= ?").bind(input.labelId, input.endsOn, input.startsOn).first();
  if (overlap) throw new HttpError(409, "Weekly target periods cannot overlap");
  await previewPolicyMutation(db, { rule: { id: "", labelId: input.labelId, startsOn: input.startsOn, endsOn: input.endsOn, ruleType: "weekly_count", meetingsPerWeek: input.meetingsPerWeek } });
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([db.prepare("INSERT INTO label_attendance_rules (id, installation_id, label_id, starts_on, ends_on, rule_type, meetings_per_week, created_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, 'weekly_count', ?, ?, ?, ?)").bind(id, input.labelId, input.startsOn, input.endsOn, input.meetingsPerWeek, principal.userId, now, now), db.prepare("INSERT INTO label_weekly_targets (id, installation_id, label_id, starts_on, ends_on, meetings_per_week, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, input.labelId, input.startsOn, input.endsOn, input.meetingsPerWeek, principal.userId, now), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'label.target_added', 'weekly_target', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify(input), now)]);
  return response({ target: { id, ...input } }, 201);
}
async function previewLabelChanges(db: D1Database, raw: LabelMutation[]) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) throw new HttpError(400, "Provide 1 to 500 label changes");
  const data = await policyData(db); const members = new Map(data.members.map((member) => [member.memberId, member])); const labels = new Map(data.labels.flatMap((label) => [[label.id.toLowerCase(), label], [label.name.toLowerCase(), label]]));
  const errors: string[] = []; const seen = new Set<string>();
  const today = policyLocalDate(new Date().toISOString(), data.timeZone);
  const normalized = raw.map((item, index) => {
    const member = members.get(item.memberId?.trim()); const label = labels.get(item.label?.trim().toLowerCase()); const date = item.effectiveDate?.trim() || today; const action = item.action?.trim() || "add";
    if (!member) errors.push(`Row ${index + 1}: member ID was not found`);
    if (!label) errors.push(`Row ${index + 1}: label was not found`);
    if (action !== "add" && action !== "remove") errors.push(`Row ${index + 1}: action must be add or remove`);
    if (!validDate(date)) errors.push(`Row ${index + 1}: effectiveDate must be a valid YYYY-MM-DD date`);
    if (label && action === "add" && !label.active) errors.push(`Row ${index + 1}: retired labels cannot receive new assignments`);
    const key = `${member?.id}:${label?.id}:${date}`; if (seen.has(key) || data.changes.some((change) => `${change.memberId}:${change.labelId}:${change.effectiveDate}` === key)) errors.push(`Row ${index + 1}: a change already exists for this member, label, and date`); seen.add(key);
    return { member, label, action: action as "add" | "remove", effectiveDate: date, externalMemberId: item.memberId };
  });
  if (errors.length) throw new HttpError(400, "Invalid label changes", errors);
  const newChanges = normalized.map((item) => ({ memberId: item.member!.id, labelId: item.label!.id, action: item.action, effectiveDate: item.effectiveDate }));
  const combined = [...data.changes, ...newChanges];
  const affected = data.members.filter((member) => newChanges.some((change) => change.memberId === member.id));
  const before = evaluateAttendance({ ...data, members: affected }); const after = evaluateAttendance({ ...data, members: affected, changes: combined });
  const impact = before.map((item, index) => ({ memberId: item.member.memberId, beforeRate: item.rate, afterRate: after[index].rate, beforePolicy: item.policy, afterPolicy: after[index].policy, beforePolicies: item.currentCompliances, afterPolicies: after[index].currentCompliances, affectedCompletedMeetings: after[index].rows.filter((row, rowIndex) => row.eligibility !== item.rows[rowIndex]?.eligibility).length }));
  const token = await sha256Hex(JSON.stringify({ raw: newChanges, state: data }));
  return { normalized, changes: newChanges, impact, token };
}
async function labelMembership(request: Request, env: Env, apply: boolean): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ changes?: LabelMutation[]; previewToken?: string }>(request);
  const preview = await previewLabelChanges(db, input.changes ?? []);
  if (!apply) return response({ changes: preview.normalized.map((item) => ({ memberId: item.externalMemberId, label: item.label!.name, action: item.action, effectiveDate: item.effectiveDate })), impact: preview.impact, previewToken: preview.token });
  if (input.previewToken !== preview.token) throw new HttpError(409, "Label history changed since the preview. Preview again before applying.");
  const now = new Date().toISOString();
  const statements = preview.changes.map((item) => db.prepare("INSERT INTO member_label_changes (id, installation_id, member_id, label_id, action, effective_date, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), item.memberId, item.labelId, item.action, item.effectiveDate, principal.userId, now));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'label.membership_changed', 'member_label', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ changes: preview.changes, impact: preview.impact }), now));
  await db.batch(statements); return response({ applied: preview.changes.length, impact: preview.impact });
}
type PolicyMutation = { rule?: AttendanceRule; removeRuleId?: string; recentDays?: number; previewToken?: string };
async function previewPolicyMutation(db: D1Database, input: PolicyMutation) {
  const data = await policyData(db);
  if (input.rule && input.removeRuleId || !input.rule && !input.removeRuleId && input.recentDays === undefined) throw new HttpError(400, "Choose one attendance policy change");
  if (input.recentDays !== undefined && (!Number.isSafeInteger(input.recentDays) || input.recentDays < 1 || input.recentDays > 365)) throw new HttpError(400, "Recent window must be 1 to 365 days");
  let rules = [...data.rules];
  let change: AttendanceRule | undefined;
  if (input.removeRuleId) {
    if (!rules.some((rule) => rule.id === input.removeRuleId)) throw new HttpError(404, "Attendance rule not found");
    rules = rules.filter((rule) => rule.id !== input.removeRuleId);
  }
  if (input.rule) {
    const supplied = input.rule;
    const label = data.labels.find((item) => item.id === supplied.labelId);
    if (!label || !label.active) throw new HttpError(400, "Choose an active label");
    if (supplied.id && !rules.some((rule) => rule.id === supplied.id && rule.labelId === supplied.labelId)) throw new HttpError(404, "Attendance rule not found for this label");
    const startsOn = supplied.startsOn || null, endsOn = supplied.endsOn || null;
    if (startsOn && !validDate(startsOn) || endsOn && (!validDate(endsOn) || !startsOn || endsOn < startsOn)) throw new HttpError(400, "Invalid rule dates");
    if (supplied.ruleType === "weighted_percentage") {
      if (typeof supplied.thresholdPercent !== "number" || !Number.isFinite(supplied.thresholdPercent) || supplied.thresholdPercent <= 0 || supplied.thresholdPercent > 100) throw new HttpError(400, "Percentage threshold must be greater than 0 and at most 100");
      if (supplied.excusedHandling !== undefined && supplied.excusedHandling !== null && !["exclude", "count_missed"].includes(supplied.excusedHandling)) throw new HttpError(400, "Choose how excused meetings affect the percentage");
    } else if (supplied.ruleType === "weekly_count") {
      if (!Number.isSafeInteger(supplied.meetingsPerWeek) || Number(supplied.meetingsPerWeek) < 1 || Number(supplied.meetingsPerWeek) > 100) throw new HttpError(400, "Weekly target must be 1 to 100 meetings");
    } else throw new HttpError(400, "Choose a supported attendance rule");
    change = { id: supplied.id || "preview-new-rule", labelId: supplied.labelId, startsOn, endsOn, ruleType: supplied.ruleType, thresholdPercent: supplied.ruleType === "weighted_percentage" ? Number(supplied.thresholdPercent) : null, meetingsPerWeek: supplied.ruleType === "weekly_count" ? Number(supplied.meetingsPerWeek) : null, excusedHandling: supplied.ruleType === "weighted_percentage" ? supplied.excusedHandling ?? "exclude" : "exclude" };
    rules = rules.filter((rule) => rule.id !== supplied.id);
    for (const other of rules.filter((rule) => rule.labelId === supplied.labelId)) {
      if (!startsOn && !other.startsOn || startsOn && other.startsOn && startsOn <= (other.endsOn ?? "9999-12-31") && other.startsOn <= (endsOn ?? "9999-12-31")) throw new HttpError(409, "Attendance rule periods cannot overlap");
    }
    rules.push(change);
  }
  const recentDays = input.recentDays ?? data.recentDays;
  const before = evaluateAttendance(data);
  const after = evaluateAttendance({ ...data, rules, recentDays });
  const impact = before.flatMap((item, index) => {
    const next = after[index];
    if (JSON.stringify(item.currentCompliances) === JSON.stringify(next.currentCompliances) && JSON.stringify(item.historySummaries) === JSON.stringify(next.historySummaries) && item.rate === next.rate && item.policy === next.policy && item.rows.every((row, rowIndex) => row.eligibility === next.rows[rowIndex]?.eligibility && row.ruleId === next.rows[rowIndex]?.ruleId)) return [];
    return [{ memberId: item.member.memberId, before: item.currentCompliance, after: next.currentCompliance, beforePolicies: item.currentCompliances, afterPolicies: next.currentCompliances, beforeHistory: item.historySummaries, afterHistory: next.historySummaries, beforeHistoricalRate: item.rate, afterHistoricalRate: next.rate }];
  });
  const token = await sha256Hex(JSON.stringify({ input: { rule: input.rule, removeRuleId: input.removeRuleId, recentDays: input.recentDays }, data }));
  return { data, change, rules, recentDays, impact, previewToken: token };
}
async function attendancePolicies(request: Request, env: Env, apply?: boolean): Promise<Response> {
  const principal = await requireRole(request, env, request.method === "GET" ? ["admin", "operator"] : ["admin"]);
  const db = requireDatabase(env);
  if (request.method === "GET") {
    const data = await policyData(db);
    return response({ labels: data.labels, rules: data.rules, recentDays: data.recentDays });
  }
  const input = await parseJson<PolicyMutation>(request);
  const preview = await previewPolicyMutation(db, input);
  if (!apply) return response({ rule: preview.change, removeRuleId: input.removeRuleId, recentDays: preview.recentDays, impact: preview.impact, previewToken: preview.previewToken });
  if (input.previewToken !== preview.previewToken) throw new HttpError(409, "Attendance policy changed since the preview. Preview again before applying.");
  const now = new Date().toISOString();
  const statements: D1Statement[] = [];
  if (input.removeRuleId) statements.push(db.prepare("DELETE FROM label_attendance_rules WHERE installation_id = 'primary' AND id = ?").bind(input.removeRuleId));
  if (preview.change) {
    const rule = preview.change;
    if (input.rule?.id) statements.push(db.prepare("UPDATE label_attendance_rules SET starts_on = ?, ends_on = ?, rule_type = ?, threshold_percent = ?, meetings_per_week = ?, excused_handling = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ?").bind(rule.startsOn, rule.endsOn, rule.ruleType, rule.thresholdPercent, rule.meetingsPerWeek, rule.excusedHandling ?? "exclude", now, rule.id));
    else statements.push(db.prepare("INSERT INTO label_attendance_rules (id, installation_id, label_id, starts_on, ends_on, rule_type, threshold_percent, meetings_per_week, excused_handling, created_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), rule.labelId, rule.startsOn, rule.endsOn, rule.ruleType, rule.thresholdPercent, rule.meetingsPerWeek, rule.excusedHandling ?? "exclude", principal.userId, now, now));
  }
  if (input.recentDays !== undefined) statements.push(db.prepare("UPDATE organization_settings SET attendance_recent_days = ? WHERE installation_id = 'primary'").bind(preview.recentDays));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'attendance_policy.changed', 'member_label', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, preview.change?.labelId ?? input.removeRuleId ?? "settings", JSON.stringify({ rule: preview.change, removeRuleId: input.removeRuleId, recentDays: input.recentDays, impact: preview.impact }), now));
  await db.batch(statements);
  return response({ applied: true, impact: preview.impact });
}
async function members(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, request.method === "GET" ? ["admin", "operator"] : ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT m.id, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, m.email, m.discord_user_id AS discordUserId, m.active, m.created_at AS rosterAddedAt, m.attendance_required_from AS attendanceRequiredFrom, EXISTS(SELECT 1 FROM users u WHERE u.installation_id = m.installation_id AND u.member_id = m.id AND u.active = 1) AS hasDashboardAccess FROM members m WHERE m.installation_id = 'primary' ORDER BY m.last_name, m.first_name").all(); const discord = await integrationRecord(env, "discord"); const discordConfigured = Boolean(discord?.verifiedAt && discord.enabled !== 0); return response({ members: result.results ?? [], discordConfigured }); }
  const input = await parseJson<{ members?: MemberInput[]; mode?: "merge" | "replace" }>(request); const mode = input.mode ?? "merge";
  if (!["merge", "replace"].includes(mode)) throw new HttpError(400, "Roster import mode must be merge or replace");
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 500) throw new HttpError(400, "Provide between 1 and 500 roster members");
  const seen = new Set<string>(); const errors: string[] = []; const warnings: string[] = [];
  input.members.forEach((member, index) => { const prefix = `Member ${index + 1}`; if (!member.memberId?.trim() || !member.firstName?.trim() || !member.lastName?.trim()) errors.push(`${prefix} requires memberId, firstName, and lastName`); if (member.memberId && seen.has(member.memberId.trim())) errors.push(`${prefix} duplicates memberId ${member.memberId.trim()}`); if (member.memberId) seen.add(member.memberId.trim()); if (member.email && !validEmail(member.email)) errors.push(`${prefix} has an invalid email`); if (member.discordUserId && !/^\d{10,24}$/.test(member.discordUserId)) warnings.push(`${prefix} Discord user ID was ignored; link Discord later from Optional integrations.`); if (member.attendanceRequiredFrom !== undefined && member.attendanceRequiredFrom !== null && !/^\d{4}-\d{2}-\d{2}$/.test(member.attendanceRequiredFrom)) errors.push(`${prefix} has an invalid participation start date`); });
  if (errors.length) throw new HttpError(400, "Invalid roster", errors);
  const now = new Date().toISOString();
  const importedIds = input.members.map((member) => member.memberId!.trim());
  const existing = await db.prepare("SELECT external_id AS memberId, active FROM members WHERE installation_id = 'primary'").all<{ memberId: string; active: number }>();
  const incoming = new Set(importedIds); const deactivated = mode === "replace" ? (existing.results ?? []).filter((member) => member.active && !incoming.has(member.memberId)).length : 0;
  const statements: D1Statement[] = mode === "replace" ? [db.prepare("UPDATE members SET active = 0 WHERE installation_id = 'primary'")] : [];
  statements.push(...input.members.map((member) => db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, active, created_at, attendance_required_from) VALUES (?, 'primary', ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, discord_user_id = excluded.discord_user_id, active = 1, attendance_required_from = COALESCE(excluded.attendance_required_from, members.attendance_required_from)").bind(crypto.randomUUID(), member.memberId!.trim(), member.firstName!.trim(), member.lastName!.trim(), member.email?.trim().toLowerCase() || null, member.discordUserId && /^\d{10,24}$/.test(member.discordUserId) ? member.discordUserId.trim() : null, now, member.attendanceRequiredFrom ?? now.slice(0, 10))));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'roster.imported', 'member', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ count: input.members.length, mode, deactivated }), now));
  await db.batch(statements); return response({ imported: input.members.length, deactivated, mode, warnings }, 201);
}
async function manageMember(request: Request, env: Env, memberId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const member = await db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, active, created_at AS rosterAddedAt, attendance_required_from AS attendanceRequiredFrom FROM members WHERE installation_id = 'primary' AND id = ?").bind(memberId).first<{ id: string; memberId: string; firstName: string; lastName: string; email?: string; active: number; rosterAddedAt?: string; attendanceRequiredFrom?: string }>();
  if (!member) throw new HttpError(404, "Member not found");
  if (request.method === "DELETE") {
    const input = await parseJson<{ confirmation?: string }>(request);
    if (input.confirmation !== `DELETE MEMBER ${member.memberId}`) throw new HttpError(400, `Type DELETE MEMBER ${member.memberId} exactly to continue`);
    const references = await db.prepare("SELECT (SELECT COUNT(*) FROM attendance_events WHERE member_id = ?) + (SELECT COUNT(*) FROM attendance_corrections WHERE member_id = ?) AS count").bind(member.id, member.id).first<{ count: number }>();
    if (references?.count) throw new HttpError(409, "This member has attendance history. Deactivate them instead to preserve the record.");
    await db.batch([db.prepare("UPDATE users SET member_id = NULL WHERE installation_id = 'primary' AND member_id = ?").bind(member.id), db.prepare("DELETE FROM members WHERE installation_id = 'primary' AND id = ?").bind(member.id)]);
    await writeAudit(db, principal, "roster.member_deleted", "member", member.id, { memberId: member.memberId }); return response({ deleted: true, memberId: member.id });
  }
  const input = await parseJson<{ firstName?: string; lastName?: string; email?: string | null; active?: boolean; attendanceRequiredFrom?: string | null }>(request);
  if (input.firstName !== undefined && (!input.firstName.trim() || input.firstName.length > 100)) throw new HttpError(400, "First name must be 1 to 100 characters");
  if (input.lastName !== undefined && (!input.lastName.trim() || input.lastName.length > 100)) throw new HttpError(400, "Last name must be 1 to 100 characters");
  if (input.email !== undefined && input.email !== null && !validEmail(input.email.trim())) throw new HttpError(400, "Email must be valid");
  if (input.attendanceRequiredFrom !== undefined && (input.attendanceRequiredFrom === null || !/^\d{4}-\d{2}-\d{2}$/.test(input.attendanceRequiredFrom))) throw new HttpError(400, "Participation start date must be YYYY-MM-DD");
  const next = { firstName: input.firstName?.trim() ?? member.firstName, lastName: input.lastName?.trim() ?? member.lastName, email: input.email === undefined ? member.email ?? null : input.email?.trim().toLowerCase() || null, active: input.active === undefined ? member.active : input.active ? 1 : 0, attendanceRequiredFrom: input.attendanceRequiredFrom === undefined ? member.attendanceRequiredFrom ?? member.rosterAddedAt?.slice(0, 10) ?? null : input.attendanceRequiredFrom };
  await db.prepare("UPDATE members SET first_name = ?, last_name = ?, email = ?, active = ?, attendance_required_from = ? WHERE installation_id = 'primary' AND id = ?").bind(next.firstName, next.lastName, next.email, next.active, next.attendanceRequiredFrom, member.id).run();
  await writeAudit(db, principal, "roster.member_updated", "member", member.id, { active: Boolean(next.active), attendanceRequiredFrom: next.attendanceRequiredFrom }); return response({ member: { ...member, ...next, active: Boolean(next.active) } });
}
async function bulkMemberStatus(request: Request, env: Env, apply: boolean): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ memberIds?: string[]; active?: boolean; previewToken?: string }>(request);
  if (!Array.isArray(input.memberIds) || input.memberIds.length < 1 || input.memberIds.length > 500 || new Set(input.memberIds).size !== input.memberIds.length || input.memberIds.some((id) => typeof id !== "string") || typeof input.active !== "boolean") throw new HttpError(400, "Select 1 to 500 distinct members and an active state");
  const result = await db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, active FROM members WHERE installation_id = 'primary' ORDER BY id").all<{ id: string; memberId: string; firstName: string; lastName: string; active: number }>();
  const byId = new Map((result.results ?? []).map((member) => [member.id, member]));
  const selected = input.memberIds.map((id) => byId.get(id));
  if (selected.some((member) => !member)) throw new HttpError(409, "The roster changed. Select members again before applying.");
  const members = selected as NonNullable<(typeof selected)[number]>[];
  const previewToken = await sha256Hex(JSON.stringify({ selected: members, active: input.active }));
  const changed = members.filter((member) => Boolean(member.active) !== input.active);
  if (!apply) return response({ members: members.map((member) => ({ memberId: member.memberId, name: `${member.firstName} ${member.lastName}`, active: Boolean(member.active), willChange: Boolean(member.active) !== input.active })), changed: changed.length, previewToken });
  if (input.previewToken !== previewToken) throw new HttpError(409, "The roster changed since the preview. Preview again before applying.");
  const now = new Date().toISOString();
  await db.batch([...changed.map((member) => db.prepare("UPDATE members SET active = ? WHERE installation_id = 'primary' AND id = ? AND active = ?").bind(input.active ? 1 : 0, member.id, member.active)), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'roster.bulk_status_changed', 'member', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ memberIds: members.map((member) => member.memberId), active: input.active, changed: changed.length }), now)]);
  return response({ applied: changed.length, selected: members.length, active: input.active });
}
async function memberHistory(request: Request, env: Env, externalId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const [member, settings] = await Promise.all([
    db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active, created_at AS rosterAddedAt, attendance_required_from AS attendanceRequiredFrom FROM members WHERE installation_id = 'primary' AND external_id = ?").bind(externalId).first<{ id: string; memberId: string; firstName: string; lastName: string; email?: string; discordUserId?: string; active: number; rosterAddedAt?: string; attendanceRequiredFrom?: string }>(),
    db.prepare("SELECT anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ anomalyLateThresholdMinutes?: number; anomalyEarlyThresholdMinutes?: number }>(),
  ]);
  if (!member) throw new HttpError(404, "Member not found");
  const rows = await db.prepare("SELECT meeting.id AS meetingId, meeting.title, meeting.starts_at AS startsAt, meeting.ends_at AS endsAt, (SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = ? AND c.meeting_id = meeting.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS correction, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = ? AND c.meeting_id = meeting.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = ? AND e.meeting_id = meeting.id AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = ? AND e.meeting_id = meeting.id AND e.action = 'check_out') AS checkedOutAt FROM meetings meeting WHERE meeting.installation_id = 'primary' AND meeting.deleted_at IS NULL AND meeting.ends_at <= ? ORDER BY meeting.starts_at DESC").bind(member.id, member.id, member.id, member.id, new Date().toISOString()).all<{ meetingId: string; title: string; startsAt: string; endsAt: string; correction?: "present" | "absent" | "excused"; reason?: string; checkedInAt?: string; checkedOutAt?: string }>();
  const participationStartsOn = member.attendanceRequiredFrom ?? member.rosterAddedAt?.slice(0, 10) ?? "";
  const history = (rows.results ?? []).filter((row) => row.startsAt.slice(0, 10) >= participationStartsOn).map((row) => {
    const events = [{ action: "check_in" as const, occurredAt: row.checkedInAt }, ...(row.checkedOutAt ? [{ action: "check_out" as const, occurredAt: row.checkedOutAt }] : [])].filter((event) => event.occurredAt);
    const derived = attendanceDisposition(events, row.correction);
    return { ...row, disposition: derived === "active" ? "absent" : derived };
  });
  const meanAnomalyMinutes = meanAnomalousMinutes(history, settings?.anomalyLateThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES, settings?.anomalyEarlyThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES);
  const { rosterAddedAt: _rosterAddedAt, ...memberResponse } = member;
  const [labelResult, policy] = await Promise.all([labels(new Request(request.url, { headers: request.headers }), env), policyReport(db, { meetingType: "all", roster: "all", membership: "current", memberId: member.id, useBaseline: true })]);
  const labelData = await labelResult.json() as { labels: PolicyLabel[]; history: ({ memberId: string; labelId: string; action: string; effectiveDate: string; createdAt: string })[] };
  const ownHistory = labelData.history.filter((item) => item.memberId === member.id);
  const summary = policy.members[0]; const policyRows = new Map(summary?.rows.map((row) => [row.meetingId, row]) ?? []);
  return response({ member: { ...memberResponse, active: Boolean(member.active) }, history: history.map((row) => ({ ...row, eligibility: policyRows.get(row.meetingId)?.eligibility ?? "before_start", audience: policyRows.get(row.meetingId)?.audience ?? "All", policy: policyRows.get(row.meetingId)?.policy ?? "standard" })), meanAnomalyMinutes, labels: labelData.labels, labelHistory: ownHistory, attendancePolicy: summary ?? null });
}
async function pairingCodes(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const active = await db.prepare("SELECT id, expires_at AS expiresAt FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(new Date().toISOString()).first(); return response({ active }); }
  const input = await parseJson<{ kioskName?: string; replaceExisting?: boolean; purpose?: "hardware" | "simulator" }>(request); const kioskName = input.kioskName?.trim(); const purpose = input.purpose ?? "hardware";
  if (!kioskName || kioskName.length > 80) throw new HttpError(400, "Kiosk name is required and must be at most 80 characters");
  if (!["hardware", "simulator"].includes(purpose)) throw new HttpError(400, "Pairing purpose must be hardware or simulator");
  const activeKiosk = purpose === "hardware" ? await db.prepare("SELECT id, name FROM kiosks WHERE installation_id = 'primary' AND active = 1 LIMIT 1").first<{ id: string; name: string }>() : null;
  if (activeKiosk && input.replaceExisting !== true) throw new HttpError(409, `This single-kiosk installation is already paired to ${activeKiosk.name}. Confirm replacement to continue.`);
  const code = randomToken(9).slice(0, 12).toUpperCase(); const id = crypto.randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL AND purpose = ?").bind(purpose),
    db.prepare("INSERT INTO pairing_codes (id, installation_id, code_hash, expires_at, created_by, created_at, purpose) VALUES (?, 'primary', ?, ?, ?, ?, ?)").bind(id, await sha256(code), expiresAt, principal.userId, now.toISOString(), purpose),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'pairing_code.created', 'pairing_code', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ kioskName, purpose, replacesKioskId: activeKiosk?.id ?? null }), now.toISOString()),
  ]);
  return response({ code, expiresAt, kioskName, workerApiUrl: new URL(request.url).origin }, 201);
}
async function redeemPairingCode(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); const input = await parseJson<{ code?: string; kioskName?: string }>(request); const code = input.code?.trim().toUpperCase(); const kioskName = input.kioskName?.trim();
  if (!code || !kioskName || kioskName.length > 80) throw new HttpError(400, "Pairing code and kiosk name are required");
  const now = new Date().toISOString(); const pairing = await db.prepare("SELECT id FROM pairing_codes WHERE installation_id = 'primary' AND purpose = 'hardware' AND code_hash = ? AND redeemed_at IS NULL AND expires_at > ?").bind(await sha256(code), now).first<{ id: string }>();
  if (!pairing) throw new HttpError(401, "Pairing code is invalid or expired");
  const kioskId = crypto.randomUUID(); const kioskToken = randomToken();
  const results = await db.batch([
    db.prepare("UPDATE pairing_codes SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL AND expires_at > ?").bind(now, pairing.id, now),
    db.prepare("UPDATE kiosks SET active = 0 WHERE installation_id = 'primary' AND active = 1 AND EXISTS (SELECT 1 FROM pairing_codes WHERE id = ? AND redeemed_at = ?)").bind(pairing.id, now),
    db.prepare("INSERT INTO kiosks (id, installation_id, pairing_code_id, name, token_hash, created_at) SELECT ?, 'primary', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE id = ? AND redeemed_at = ?)").bind(kioskId, pairing.id, kioskName, await sha256(kioskToken), now, pairing.id, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, action, target_type, target_id, created_at) SELECT ?, 'primary', 'kiosk.paired', 'kiosk', ?, ? WHERE EXISTS (SELECT 1 FROM kiosks WHERE id = ?)").bind(crypto.randomUUID(), kioskId, now, kioskId),
  ]);
  if ((results[2]?.meta?.changes ?? 1) < 1) throw new HttpError(409, "Pairing code was already used");
  return response({ kioskId, kioskToken, name: kioskName }, 201);
}
async function kioskFor(request: Request, env: Env): Promise<{ id: string; name: string }> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Kiosk authentication required");
  const kiosk = await requireDatabase(env).prepare("SELECT id, name FROM kiosks WHERE installation_id = 'primary' AND token_hash = ? AND active = 1").bind(await sha256(authorization.slice(7))).first<{ id: string; name: string }>();
  if (!kiosk) throw new HttpError(401, "Kiosk credential is invalid");
  return kiosk;
}
async function kioskHeartbeat(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const kiosk = await kioskFor(request, env); const input = await parseJson<{ readerOnline?: boolean; releaseVersion?: string; uptimeSeconds?: number; networkType?: "wifi" | "ethernet" | "offline"; networkSignal?: number | null; lastWifiScanAt?: string | null; pendingEvents?: number; lastSyncAt?: string | null; errorCategory?: "cloud_sync" | "reader" | "offline_queue" | null }>(request);
  const pendingEvents = input.pendingEvents ?? 0;
  if (typeof input.readerOnline !== "boolean" || !input.releaseVersion?.trim() || input.releaseVersion.length > 40 || input.uptimeSeconds !== undefined && (!Number.isInteger(input.uptimeSeconds) || input.uptimeSeconds < 0 || input.uptimeSeconds > 2_147_483_647) || input.networkType !== undefined && !["wifi", "ethernet", "offline"].includes(input.networkType) || input.networkSignal !== undefined && input.networkSignal !== null && (!Number.isInteger(input.networkSignal) || input.networkSignal < 0 || input.networkSignal > 100) || input.lastWifiScanAt && !validTimestamp(input.lastWifiScanAt) || !Number.isInteger(pendingEvents) || pendingEvents < 0 || pendingEvents > 100_000 || input.lastSyncAt && !validTimestamp(input.lastSyncAt) || input.errorCategory && !["cloud_sync", "reader", "offline_queue"].includes(input.errorCategory)) throw new HttpError(400, "Reader status and approved operational diagnostics are required");
  const now = new Date().toISOString();
  const db = requireDatabase(env); const reportedRelease = input.releaseVersion.trim();
  await db.prepare("UPDATE kiosks SET last_seen_at = ?, reader_online = ?, release_version = ?, uptime_seconds = ?, network_type = ?, network_signal = ?, last_wifi_scan_at = COALESCE(?, last_wifi_scan_at), pending_events = ?, last_sync_at = ?, error_category = ? WHERE installation_id = 'primary' AND id = ?").bind(now, input.readerOnline ? 1 : 0, reportedRelease, input.uptimeSeconds ?? null, input.networkType ?? null, input.networkSignal ?? null, input.lastWifiScanAt || null, pendingEvents, input.lastSyncAt || null, input.errorCategory || null, kiosk.id).run();
  const update = await db.prepare("SELECT id, completed_at AS completedAt, requested_release_version AS requestedReleaseVersion, release_version_before AS releaseVersionBefore FROM kiosk_commands WHERE installation_id = 'primary' AND kiosk_id = ? AND command_type = 'install_latest' AND completed_at IS NOT NULL AND success = 1 AND resolution_status IS NULL ORDER BY created_at DESC LIMIT 1").bind(kiosk.id).first<{ id: string; completedAt: string; requestedReleaseVersion?: string; releaseVersionBefore?: string }>();
  if (update?.requestedReleaseVersion) {
    const normalizedReported = reportedRelease.replace(/^v/, ""); const normalizedRequested = update.requestedReleaseVersion.replace(/^v/, ""); const normalizedBefore = update.releaseVersionBefore?.replace(/^v/, "");
    const elapsed = Date.now() - Date.parse(update.completedAt); let resolution: "succeeded" | "unchanged" | "mismatch" | undefined;
    if (normalizedReported === normalizedRequested) resolution = "succeeded";
    else if (normalizedBefore && normalizedReported !== normalizedBefore) resolution = "mismatch";
    else if (elapsed >= 5 * 60_000) resolution = normalizedBefore === normalizedReported ? "unchanged" : "mismatch";
    if (resolution) await db.prepare("UPDATE kiosk_commands SET resolution_status = ?, resolved_release_version = ?, resolved_at = ? WHERE installation_id = 'primary' AND kiosk_id = ? AND id = ? AND resolution_status IS NULL").bind(resolution, reportedRelease, now, kiosk.id, update.id).run();
  }
  const statusUpdate = syncDiscordKioskStatus(env).catch(() => undefined);
  if (context) context.waitUntil(statusUpdate); else await statusUpdate;
  return response({ ok: true, kioskId: kiosk.id, receivedAt: now });
}
async function kioskStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]);
  const result = await requireDatabase(env).prepare("SELECT id, name, active, last_seen_at AS lastSeenAt, reader_online AS readerOnline, release_version AS releaseVersion, uptime_seconds AS uptimeSeconds, network_type AS networkType, network_signal AS networkSignal, last_wifi_scan_at AS lastWifiScanAt, pending_events AS pendingEvents, last_sync_at AS lastSyncAt, error_category AS errorCategory, created_at AS pairedAt FROM kiosks WHERE installation_id = 'primary' ORDER BY created_at DESC").all();
  return response({ kiosks: result.results ?? [] });
}
async function kioskConfiguration(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env); const settings = await requireDatabase(env).prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, logo_backdrop AS logoBackdrop FROM organization_settings WHERE installation_id = 'primary'").first();
  return response({ kiosk: { id: kiosk.id, name: kiosk.name }, settings });
}
async function kioskRoster(request: Request, env: Env): Promise<Response> {
  await kioskFor(request, env); const result = await requireDatabase(env).prepare("SELECT external_id AS memberId, first_name AS firstName, last_name AS lastName FROM members WHERE installation_id = 'primary' AND active = 1 ORDER BY last_name, first_name").all();
  return response({ members: result.results ?? [] });
}
async function manageKiosk(request: Request, env: Env, kioskId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const kiosk = await db.prepare("SELECT id, name, active FROM kiosks WHERE installation_id = 'primary' AND id = ?").bind(kioskId).first<{ id: string; name: string; active: number }>();
  if (!kiosk) throw new HttpError(404, "Kiosk not found");
  if (request.method === "PATCH") {
    const input = await parseJson<{ name?: string }>(request); const name = input.name?.trim();
    if (!name || name.length > 80) throw new HttpError(400, "Kiosk name is required and must be at most 80 characters");
    await db.prepare("UPDATE kiosks SET name = ? WHERE installation_id = 'primary' AND id = ?").bind(name, kioskId).run();
    await writeAudit(db, principal, "kiosk.renamed", "kiosk", kioskId, { previousName: kiosk.name, name });
    return response({ kiosk: { ...kiosk, name } });
  }
  const input = await parseJson<{ confirmation?: string }>(request);
  if (input.confirmation !== "RETIRE KIOSK") throw new HttpError(400, "Type RETIRE KIOSK exactly to continue");
  await db.prepare("UPDATE kiosks SET active = 0 WHERE installation_id = 'primary' AND id = ?").bind(kioskId).run();
  await writeAudit(db, principal, "kiosk.retired", "kiosk", kioskId, { name: kiosk.name });
  return response({ retired: true, kioskId });
}
async function queueKioskCommand(request: Request, env: Env, kioskId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ command?: KioskCommandType }>(request);
  const supported: KioskCommandType[] = ["reload_display", "restart_service", "reboot", "reset_network_pin", "install_latest"];
  if (!input.command || !supported.includes(input.command)) throw new HttpError(400, "Choose a supported kiosk command");
  const kiosk = await db.prepare("SELECT id, name, release_version AS releaseVersion FROM kiosks WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(kioskId).first<{ id: string; name: string; releaseVersion?: string }>();
  if (!kiosk) throw new HttpError(404, "Active kiosk not found");
  let requestedReleaseVersion: string | null = null;
  if (input.command === "install_latest") requestedReleaseVersion = await latestCompatibleKioskRelease(env);
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO kiosk_commands (id, installation_id, kiosk_id, command_type, created_by, created_at, requested_release_version, release_version_before) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, kioskId, input.command, principal.userId, now, requestedReleaseVersion, input.command === "install_latest" ? kiosk.releaseVersion ?? null : null),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'kiosk.command_queued', 'kiosk', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, kioskId, JSON.stringify({ commandId: id, command: input.command, requestedReleaseVersion }), now),
  ]);
  return response({ command: { id, type: input.command, kioskId, queuedAt: now, ...(requestedReleaseVersion ? { requestedReleaseVersion } : {}) } }, 202);
}
async function kioskCommandStatus(request: Request, env: Env, kioskId: string): Promise<Response> {
  await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const kiosk = await db.prepare("SELECT id FROM kiosks WHERE installation_id = 'primary' AND id = ?").bind(kioskId).first<{ id: string }>();
  if (!kiosk) throw new HttpError(404, "Kiosk not found");
  const commands = await db.prepare("SELECT id, command_type AS type, created_at AS createdAt, completed_at AS completedAt, success, result_message AS resultMessage, requested_release_version AS requestedReleaseVersion, release_version_before AS releaseVersionBefore, resolution_status AS resolutionStatus, resolved_release_version AS resolvedReleaseVersion, resolved_at AS resolvedAt FROM kiosk_commands WHERE installation_id = 'primary' AND kiosk_id = ? ORDER BY created_at DESC LIMIT 12").bind(kioskId).all();
  return response({ commands: commands.results ?? [] });
}
async function pendingKioskCommand(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env); const notBefore = new Date(Date.now() - 15 * 60_000).toISOString(); const command = await requireDatabase(env).prepare("SELECT id, command_type AS type, created_at AS createdAt FROM kiosk_commands WHERE installation_id = 'primary' AND kiosk_id = ? AND completed_at IS NULL AND created_at >= ? ORDER BY created_at LIMIT 1").bind(kiosk.id, notBefore).first();
  return response({ command: command ?? null });
}
async function completeKioskCommand(request: Request, env: Env, commandId: string): Promise<Response> {
  const kiosk = await kioskFor(request, env); const input = await parseJson<{ success?: boolean; message?: string }>(request); if (typeof input.success !== "boolean" || (input.message?.length ?? 0) > 200) throw new HttpError(400, "Command result needs a success flag and optional short message");
  const result = await requireDatabase(env).prepare("UPDATE kiosk_commands SET completed_at = ?, success = ?, result_message = ? WHERE installation_id = 'primary' AND kiosk_id = ? AND id = ? AND (completed_at IS NULL OR (command_type = 'install_latest' AND success = 1 AND resolution_status IS NULL AND ? = 0))").bind(new Date().toISOString(), input.success ? 1 : 0, input.message?.trim() || null, kiosk.id, commandId, input.success ? 1 : 0).run();
  if ((result.meta?.changes ?? 1) < 1) throw new HttpError(404, "Pending kiosk command not found");
  return response({ completed: true, commandId });
}
function validTimestamp(value: string | undefined): value is string { return Boolean(value && Number.isFinite(Date.parse(value))); }
function validateMeetingInput(input: MeetingInput): asserts input is MeetingInput & { title: string; startsAt: string; endsAt: string } {
  if (!input.title?.trim() || input.title.length > 120 || (input.notes?.length ?? 0) > 2_000 || !validTimestamp(input.startsAt) || !validTimestamp(input.endsAt ?? undefined) || Date.parse(input.endsAt!) <= Date.parse(input.startsAt!)) throw new HttpError(400, "Meeting needs a title, valid start and end times, an end after its start, and optional notes under 2,000 characters");
}
type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number };
function localParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: value.year, month: value.month, day: value.day, hour: value.hour, minute: value.minute, second: value.second, millisecond: date.getUTCMilliseconds() };
}
function localDate(parts: DateParts, timeZone: string): Date {
  const intended = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond); let candidate = intended;
  for (let iteration = 0; iteration < 3; iteration += 1) { const actual = localParts(new Date(candidate), timeZone); const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, actual.millisecond); candidate += intended - represented; }
  return new Date(candidate);
}
function nextOccurrence(current: Date, frequency: RecurrenceFrequency, anchorDay: number, timeZone: string): Date {
  const parts = localParts(current, timeZone); const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond));
  if (frequency === "monthly") { calendar.setUTCDate(1); calendar.setUTCMonth(calendar.getUTCMonth() + 1); const lastDay = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, 0)).getUTCDate(); calendar.setUTCDate(Math.min(anchorDay, lastDay)); }
  else calendar.setUTCDate(calendar.getUTCDate() + (frequency === "daily" ? 1 : frequency === "weekly" ? 7 : 14));
  return localDate({ year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(), hour: calendar.getUTCHours(), minute: calendar.getUTCMinutes(), second: calendar.getUTCSeconds(), millisecond: calendar.getUTCMilliseconds() }, timeZone);
}
function meetingOccurrences(input: MeetingInput & { startsAt: string; endsAt: string }, timeZone = "UTC") {
  if (!input.recurrence) return [{ startsAt: input.startsAt, endsAt: input.endsAt, sequence: null as number | null }];
  const frequency = input.recurrence.frequency; const until = input.recurrence.until;
  if (!frequency || !["daily", "weekly", "biweekly", "monthly"].includes(frequency) || !validTimestamp(until) || Date.parse(until) < Date.parse(input.startsAt)) throw new HttpError(400, "Recurring meetings need a valid frequency and series end date after the first meeting");
  const duration = Date.parse(input.endsAt) - Date.parse(input.startsAt); const limit = Date.parse(until); const anchorDay = localParts(new Date(input.startsAt), timeZone).day; const occurrences = []; let start = new Date(input.startsAt);
  while (start.getTime() <= limit && occurrences.length < 500) { occurrences.push({ startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duration).toISOString(), sequence: occurrences.length + 1 }); start = nextOccurrence(start, frequency, anchorDay, timeZone); }
  if (start.getTime() <= limit) throw new HttpError(400, "Recurring series is too large; shorten the date range to 500 meetings or fewer");
  return occurrences;
}
async function assertNoMeetingOverlap(db: D1Database, proposed: MeetingWindowLike[], lateScanMinutes: number, excludedIds: string[] = []): Promise<void> {
  const existing = await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL").all<MeetingWindowLike>();
  const excluded = new Set(excludedIds); const conflict = overlappingMeetingWindows([...(existing.results ?? []).filter((meeting) => !excluded.has(meeting.id ?? "")), ...proposed], lateScanMinutes);
  if (!conflict) return;
  const label = (meeting: MeetingWindowLike) => `${meeting.title?.trim() || "Meeting"} (${new Date(meeting.startsAt).toISOString()})`;
  throw new HttpError(409, `Meeting attendance windows cannot overlap. ${label(conflict[0])} conflicts with ${label(conflict[1])}.`);
}
async function resolveAudience(db: D1Database, input: MeetingInput, currentIds: string[] = []): Promise<{ mode: "all" | "labels"; labelIds: string[] }> {
  const mode = input.audienceMode ?? (input.audienceLabelIds?.length ? "labels" : "all");
  if (mode !== "all" && mode !== "labels") throw new HttpError(400, "Meeting audience must be All or selected labels");
  if (mode === "all") return { mode, labelIds: [] };
  const ids = input.audienceLabelIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30 || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new HttpError(400, "Select 1 to 30 distinct audience labels");
  const result = await db.prepare(`SELECT id, active FROM member_labels WHERE installation_id = 'primary' AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string; active: number }>();
  if ((result.results ?? []).length !== ids.length || (result.results ?? []).some((label) => !label.active && !currentIds.includes(label.id))) throw new HttpError(400, "Meeting audience contains an unknown or retired label");
  return { mode, labelIds: ids };
}
async function meetingAudienceIds(db: D1Database, meetingIds?: string[]): Promise<Map<string, string[]>> {
  const result = await db.prepare("SELECT meeting_id AS meetingId, label_id AS labelId FROM meeting_audience_labels WHERE installation_id = 'primary'").all<{ meetingId: string; labelId: string }>();
  const selected = meetingIds ? new Set(meetingIds) : undefined; const map = new Map<string, string[]>();
  for (const row of result.results ?? []) if (!selected || selected.has(row.meetingId)) map.set(row.meetingId, [...(map.get(row.meetingId) ?? []), row.labelId]);
  return map;
}
async function meetingAudienceText(db: D1Database, meetingId: string): Promise<string> {
  const meeting = await db.prepare("SELECT audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(meetingId).first<{ audienceMode: "all" | "labels" }>();
  if (meeting?.audienceMode !== "labels") return "All";
  const result = await db.prepare("SELECT l.name FROM meeting_audience_labels a JOIN member_labels l ON l.id = a.label_id AND l.installation_id = a.installation_id WHERE a.installation_id = 'primary' AND a.meeting_id = ? ORDER BY l.name COLLATE NOCASE").bind(meetingId).all<{ name: string }>();
  return (result.results ?? []).map((row) => row.name).join(", ") || "Selected labels";
}
async function meetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  if (request.method === "GET") { const [result, settings, audiences] = await Promise.all([db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, notes, is_test AS isTest, series_id AS seriesId, recurrence_frequency AS recurrenceFrequency, recurrence_until AS recurrenceUntil, recurrence_sequence AS recurrenceSequence, weight_category_id AS weightCategoryId, weight_category_name AS weightCategoryName, attendance_weight AS attendanceWeight, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL ORDER BY starts_at DESC LIMIT 1000").all<{ id: string; title: string; startsAt: string; endsAt: string; required: number; notes?: string; isTest: number; seriesId?: string; recurrenceFrequency?: RecurrenceFrequency; recurrenceUntil?: string; recurrenceSequence?: number; weightCategoryId?: string; weightCategoryName?: string; attendanceWeight: number; audienceMode: "all" | "labels" }>(), db.prepare("SELECT late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on AS attendanceReportingStartsOn, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number; attendanceReportingStartsOn?: string; timeZone?: string }>(), meetingAudienceIds(db)]); return response({ meetings: (result.results ?? []).map((meeting) => ({ ...meeting, attendanceWeight: Number(meeting.attendanceWeight ?? 1), audienceLabelIds: audiences.get(meeting.id) ?? [], attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30) })), lateScanMinutes: settings?.lateScanMinutes ?? 30, attendanceReportingStartsOn: settings?.attendanceReportingStartsOn ?? null, timeZone: settings?.timeZone ?? "UTC" }); }
  const input = await parseJson<MeetingInput>(request); validateMeetingInput(input); const settings = await db.prepare("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone?: string; lateScanMinutes?: number }>(); const occurrences = meetingOccurrences(input, settings?.timeZone && validTimeZone(settings.timeZone) ? settings.timeZone : "UTC"); await assertNoMeetingOverlap(db, occurrences.map((occurrence) => ({ ...occurrence, title: input.title })), settings?.lateScanMinutes ?? 30); const assignment = await resolveMeetingWeightAssignment(db, input.weightCategoryId, input.startsAt, input.endsAt); const seriesId = input.recurrence ? crypto.randomUUID() : null; const now = new Date().toISOString(); const ids = occurrences.map(() => crypto.randomUUID());
  const audience = await resolveAudience(db, input);
  const statements = occurrences.map((occurrence, index) => db.prepare("INSERT INTO meetings (id, installation_id, title, starts_at, ends_at, required, notes, created_by, created_at, is_test, series_id, recurrence_frequency, recurrence_until, recurrence_sequence, weight_category_id, weight_category_name, attendance_weight, audience_mode) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)").bind(ids[index], input.title.trim(), occurrence.startsAt, occurrence.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, principal.userId, now, seriesId, input.recurrence?.frequency ?? null, input.recurrence?.until ?? null, occurrence.sequence, assignment?.id ?? null, assignment?.name ?? null, assignment?.weight ?? 1, audience.mode));
  for (const id of ids) for (const labelId of audience.labelIds) statements.push(db.prepare("INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) VALUES ('primary', ?, ?)").bind(id, labelId));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting.created', 'meeting', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, ids[0], JSON.stringify({ seriesId, occurrences: occurrences.length, frequency: input.recurrence?.frequency ?? null, weightCategoryId: assignment?.id ?? null, attendanceWeight: assignment?.weight ?? 1, audience }), now));
  await db.batch(statements);
  const created = occurrences.map((occurrence, index) => ({ id: ids[index], title: input.title!.trim(), ...occurrence, required: input.required !== false, notes: input.notes?.trim() || null, seriesId, recurrenceFrequency: input.recurrence?.frequency ?? null, recurrenceUntil: input.recurrence?.until ?? null, recurrenceSequence: occurrence.sequence, weightCategoryId: assignment?.id ?? null, weightCategoryName: assignment?.name ?? null, attendanceWeight: assignment?.weight ?? 1, audienceMode: audience.mode, audienceLabelIds: audience.labelIds }));
  const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "sync", ids);
  return response({ meeting: created[0], meetings: created, seriesId, calendarSync: calendarDelivery.google_calendar, calendarDelivery }, 201);
}
async function meetingDetail(request: Request, env: Env, meetingId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const [meeting, settings, audiences] = await Promise.all([
    db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, notes, is_test AS isTest, series_id AS seriesId, recurrence_frequency AS recurrenceFrequency, recurrence_until AS recurrenceUntil, recurrence_sequence AS recurrenceSequence, weight_category_id AS weightCategoryId, weight_category_name AS weightCategoryName, attendance_weight AS attendanceWeight, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ id: string; title: string; startsAt: string; endsAt: string; required: number; notes?: string; isTest: number; seriesId?: string; recurrenceFrequency?: RecurrenceFrequency; recurrenceUntil?: string; recurrenceSequence?: number; weightCategoryId?: string; weightCategoryName?: string; attendanceWeight: number; audienceMode: "all" | "labels" }>(),
    db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number }>(),
    meetingAudienceIds(db, [meetingId]),
  ]);
  if (!meeting) throw new HttpError(404, "Meeting not found");
  return response({ meeting: { ...meeting, audienceLabelIds: audiences.get(meetingId) ?? [], attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30) } });
}
async function meetingTemplates(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const result = await db.prepare("SELECT id, name, title, start_time AS startTime, duration_minutes AS durationMinutes, required, notes, recurrence_frequency AS recurrenceFrequency, recurrence_duration_days AS recurrenceDurationDays, created_at AS createdAt, updated_at AS updatedAt FROM meeting_templates WHERE installation_id = 'primary' ORDER BY name COLLATE NOCASE LIMIT 200").all();
  return response({ templates: result.results ?? [] });
}
async function meetingImpactPreview(db: D1Database, meetingId: string, required: boolean, audience: { mode: "all" | "labels"; labelIds: string[] }) {
  const data = await policyData(db); const original = data.meetings.find((meeting) => meeting.id === meetingId);
  if (!original) throw new HttpError(404, "Meeting not found");
  const changed = Boolean(original.required) !== required || original.audienceMode !== audience.mode || [...original.audienceLabelIds].sort().join(",") !== [...audience.labelIds].sort().join(",");
  const completed = Date.parse(original.attendanceClosesAt) <= Date.now();
  const before = changed && completed ? evaluateAttendance(data) : [];
  const afterMeeting = { ...original, required, audienceMode: audience.mode, audienceLabelIds: audience.labelIds };
  const after = changed && completed ? evaluateAttendance({ ...data, meetings: data.meetings.map((meeting) => meeting.id === meetingId ? afterMeeting : meeting) }) : [];
  const impact = before.map((item, index) => ({ memberId: item.member.memberId, beforeRate: item.rate, afterRate: after[index].rate, affectedCompletedMeetings: item.rows.filter((row, rowIndex) => row.eligibility !== after[index].rows[rowIndex]?.eligibility).length })).filter((item) => item.beforeRate !== item.afterRate || item.affectedCompletedMeetings > 0);
  return { changed, completed, impact, previewToken: await sha256Hex(JSON.stringify({ state: data, meetingId, required, audience })) };
}
async function meetingImpact(request: Request, env: Env, meetingId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<MeetingInput>(request);
  const current = await db.prepare("SELECT required, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ required: number; audienceMode: "all" | "labels" }>();
  if (!current) throw new HttpError(404, "Meeting not found");
  const currentIds = (await meetingAudienceIds(db, [meetingId])).get(meetingId) ?? [];
  const audience = await resolveAudience(db, { audienceMode: input.audienceMode ?? current.audienceMode, audienceLabelIds: input.audienceLabelIds ?? currentIds }, currentIds);
  return response(await meetingImpactPreview(db, meetingId, input.required === undefined ? Boolean(current.required) : input.required, audience));
}
async function updateMeeting(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<MeetingInput>(request); validateMeetingInput(input);
  const current = await db.prepare("SELECT required, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ required: number; audienceMode: "all" | "labels" }>();
  if (!current) throw new HttpError(404, "Meeting not found");
  const currentIds = (await meetingAudienceIds(db, [meetingId])).get(meetingId) ?? [];
  const audience = await resolveAudience(db, { ...input, audienceMode: input.audienceMode ?? current.audienceMode, audienceLabelIds: input.audienceLabelIds ?? currentIds }, currentIds);
  const historicalChange = Boolean(current.required) !== (input.required !== false) || current.audienceMode !== audience.mode || [...currentIds].sort().join(",") !== [...audience.labelIds].sort().join(",");
  const impact = historicalChange ? await meetingImpactPreview(db, meetingId, input.required !== false, audience) : { changed: false, completed: false, impact: [], previewToken: "" };
  if (impact.changed && impact.completed && input.impactToken !== impact.previewToken) throw new HttpError(409, "Preview and confirm the historical attendance impact before saving this meeting");
  const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes?: number }>();
  await assertNoMeetingOverlap(db, [{ id: meetingId, title: input.title, startsAt: input.startsAt, endsAt: input.endsAt }], settings?.lateScanMinutes ?? 30, [meetingId]);
  const assignment = input.weightCategoryId === undefined ? undefined : await resolveMeetingWeightAssignment(db, input.weightCategoryId, input.startsAt, input.endsAt);
  const update = assignment === undefined
    ? db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0 WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title.trim(), input.startsAt, input.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, meetingId)
    : db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0, weight_category_id = ?, weight_category_name = ?, attendance_weight = ? WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title.trim(), input.startsAt, input.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, assignment?.id ?? null, assignment?.name ?? null, assignment?.weight ?? 1, meetingId);
  const now = new Date().toISOString(); const statements = [update, db.prepare("DELETE FROM meeting_audience_labels WHERE installation_id = 'primary' AND meeting_id = ?").bind(meetingId), ...audience.labelIds.map((labelId) => db.prepare("INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) VALUES ('primary', ?, ?)").bind(meetingId, labelId)), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting.updated', 'meeting', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, meetingId, JSON.stringify({ audience, historicalImpact: impact.completed && impact.changed ? impact.impact : [], ...(assignment === undefined ? {} : { weightCategoryId: assignment?.id ?? null, attendanceWeight: assignment?.weight ?? 1 }) }), now)];
  await db.batch(statements);
  const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "sync", [meetingId]);
  return response({ meeting: { id: meetingId, title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt, required: input.required !== false, notes: input.notes?.trim() || null, audienceMode: audience.mode, audienceLabelIds: audience.labelIds, ...(assignment === undefined ? {} : { weightCategoryId: assignment?.id ?? null, weightCategoryName: assignment?.name ?? null, attendanceWeight: assignment?.weight ?? 1 }) }, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
async function updateMeetingSeries(request: Request, env: Env, seriesId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<MeetingInput & { meetingId?: string }>(request); validateMeetingInput(input);
  if (!input.meetingId) throw new HttpError(400, "Choose the first occurrence to update");
  const anchor = await db.prepare("SELECT starts_at AS startsAt, ends_at AS endsAt, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND id = ? AND deleted_at IS NULL").bind(seriesId, input.meetingId).first<{ startsAt: string; endsAt: string; audienceMode: "all" | "labels" }>();
  if (!anchor) throw new HttpError(404, "Recurring series occurrence not found");
  if (Date.parse(anchor.endsAt) <= Date.now()) throw new HttpError(409, "Edit a completed occurrence individually to preview its historical impact");
  const anchorIds = (await meetingAudienceIds(db, [input.meetingId])).get(input.meetingId) ?? [];
  const audience = await resolveAudience(db, { ...input, audienceMode: input.audienceMode ?? anchor.audienceMode, audienceLabelIds: input.audienceLabelIds ?? anchorIds }, anchorIds);
  const future = await db.prepare("SELECT id, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? AND deleted_at IS NULL ORDER BY starts_at").bind(seriesId, anchor.startsAt).all<{ id: string; startsAt: string }>();
  const duration = Date.parse(input.endsAt) - Date.parse(input.startsAt); const shift = Date.parse(input.startsAt) - Date.parse(anchor.startsAt); const proposed = (future.results ?? []).map((meeting) => { const start = new Date(Date.parse(meeting.startsAt) + shift); return { id: meeting.id, title: input.title, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duration).toISOString() }; });
  const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes?: number }>();
  await assertNoMeetingOverlap(db, proposed, settings?.lateScanMinutes ?? 30, proposed.map((meeting) => meeting.id));
  const assignment = input.weightCategoryId === undefined ? undefined : await resolveMeetingWeightAssignment(db, input.weightCategoryId, input.startsAt, input.endsAt);
  const statements = proposed.map((meeting) => assignment === undefined
    ? db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0 WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title!.trim(), meeting.startsAt, meeting.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, meeting.id)
    : db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, audience_mode = ?, is_test = 0, weight_category_id = ?, weight_category_name = ?, attendance_weight = ? WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.title!.trim(), meeting.startsAt, meeting.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, audience.mode, assignment?.id ?? null, assignment?.name ?? null, assignment?.weight ?? 1, meeting.id));
  if (!statements.length) throw new HttpError(404, "No future series occurrences were found");
  const updatedCount = statements.length;
  for (const meeting of proposed) { statements.push(db.prepare("DELETE FROM meeting_audience_labels WHERE installation_id = 'primary' AND meeting_id = ?").bind(meeting.id)); for (const labelId of audience.labelIds) statements.push(db.prepare("INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) VALUES ('primary', ?, ?)").bind(meeting.id, labelId)); }
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting.series_updated', 'meeting_series', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, seriesId, JSON.stringify({ fromMeetingId: input.meetingId, updated: updatedCount, audience, ...(assignment === undefined ? {} : { weightCategoryId: assignment?.id ?? null, attendanceWeight: assignment?.weight ?? 1 }) }), new Date().toISOString()));
  await db.batch(statements); const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "sync", proposed.map((meeting) => meeting.id)); return response({ seriesId, updated: updatedCount, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
async function deleteMeetings(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ scope?: "occurrence" | "future" }>(request);
  const meeting = await db.prepare("SELECT id, series_id AS seriesId, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ id: string; seriesId?: string | null; startsAt: string }>();
  if (!meeting) throw new HttpError(404, "Meeting not found");
  const now = new Date().toISOString();
  if (input.scope === "future" && meeting.seriesId) {
    const affected = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? AND deleted_at IS NULL").bind(meeting.seriesId, meeting.startsAt).all<{ id: string }>();
    const updated = await db.prepare("UPDATE meetings SET deleted_at = ? WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? AND deleted_at IS NULL RETURNING id").bind(now, meeting.seriesId, meeting.startsAt).all<{ id: string }>();
    const count = updated.results?.length ?? 0; if (count < 1) throw new HttpError(404, "No future series occurrences were found");
    await writeAudit(db, principal, "meeting.series_deleted", "meeting_series", meeting.seriesId, { fromMeetingId: meeting.id, deleted: count });
    const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "delete", (affected.results ?? []).map((item) => item.id));
    return response({ deleted: count, scope: "future", calendarSync: calendarDelivery.google_calendar, calendarDelivery });
  }
  const updated = await db.prepare("UPDATE meetings SET deleted_at = ? WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(now, meeting.id).run();
  if ((updated.meta?.changes ?? 1) < 1) throw new HttpError(404, "Meeting not found");
  await writeAudit(db, principal, "meeting.deleted", "meeting", meeting.id);
  const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "delete", [meeting.id]);
  return response({ deleted: 1, scope: "occurrence", calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
async function bulkDeleteMeetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingIds?: string[]; confirmation?: string }>(request);
  const ids = [...new Set((input.meetingIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (!ids.length || ids.length > 100) throw new HttpError(400, "Select between 1 and 100 meetings");
  if (input.confirmation !== "DELETE SELECTED MEETINGS") throw new HttpError(400, "Type DELETE SELECTED MEETINGS exactly to continue");
  const now = new Date().toISOString(); const statements = ids.map((id) => db.prepare("UPDATE meetings SET deleted_at = ? WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(now, id)); const results = await db.batch(statements); const deletedIds = ids.filter((_id, index) => (results[index]?.meta?.changes ?? 0) > 0); const deleted = deletedIds.length;
  await writeAudit(db, principal, "meetings.bulk_deleted", "meeting", null, { selected: ids.length, deleted }); const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "delete", deletedIds); return response({ deleted, calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
async function rosterHistory(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]); const result = await requireDatabase(env).prepare("SELECT created_at AS createdAt, metadata_json AS metadata FROM audit_log WHERE installation_id = 'primary' AND action = 'roster.imported' ORDER BY created_at DESC LIMIT 20").all<{ createdAt: string; metadata: string }>();
  return response({ imports: (result.results ?? []).map((item) => { let metadata: { count?: number; mode?: string; deactivated?: number } = {}; try { metadata = JSON.parse(item.metadata); } catch { /* Historical audit metadata is optional. */ } return { createdAt: item.createdAt, count: metadata.count ?? 0, mode: metadata.mode ?? "merge", deactivated: metadata.deactivated ?? 0 }; }) });
}
async function restoreMeetings(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ scope?: "occurrence" | "future" }>(request);
  const meeting = await db.prepare("SELECT id, series_id AS seriesId, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NOT NULL").bind(meetingId).first<{ id: string; seriesId?: string | null; startsAt: string }>();
  if (!meeting) throw new HttpError(404, "Deleted meeting not found");
  if (input.scope === "future" && meeting.seriesId) {
    const affected = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? AND deleted_at IS NOT NULL").bind(meeting.seriesId, meeting.startsAt).all<{ id: string }>();
    const updated = await db.prepare("UPDATE meetings SET deleted_at = NULL WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? AND deleted_at IS NOT NULL RETURNING id").bind(meeting.seriesId, meeting.startsAt).all<{ id: string }>();
    const count = updated.results?.length ?? 0; if (count < 1) throw new HttpError(404, "No deleted future series occurrences were found");
    await writeAudit(db, principal, "meeting.series_restored", "meeting_series", meeting.seriesId, { fromMeetingId: meeting.id, restored: count });
    const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "restore", (affected.results ?? []).map((item) => item.id));
    return response({ restored: count, scope: "future", calendarSync: calendarDelivery.google_calendar, calendarDelivery });
  }
  const updated = await db.prepare("UPDATE meetings SET deleted_at = NULL WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NOT NULL").bind(meeting.id).run();
  if ((updated.meta?.changes ?? 1) < 1) throw new HttpError(404, "Deleted meeting not found");
  await writeAudit(db, principal, "meeting.restored", "meeting", meeting.id);
  const calendarDelivery = await deliverCalendarLifecycle(db, env, principal, "restore", [meeting.id]);
  return response({ restored: 1, scope: "occurrence", calendarSync: calendarDelivery.google_calendar, calendarDelivery });
}
async function recordAttendance(db: D1Database, input: { eventId?: string; memberId?: string; meetingId?: string; occurredAt?: string; desiredAction?: AttendanceAction }, source: "kiosk" | "manual" | "simulator", actorId?: string): Promise<Response> {
  if (!input.eventId?.trim() || input.eventId.length > 100 || !input.memberId || !validTimestamp(input.occurredAt)) throw new HttpError(400, "eventId, memberId, and a valid occurredAt timestamp are required");
  const existing = await db.prepare("SELECT action FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ?").bind(input.eventId.trim()).first<{ action: AttendanceAction }>();
  if (existing) return response({ accepted: false, duplicate: true, eventId: input.eventId, action: existing.action }, 200);
  const [member, settings] = await Promise.all([
    db.prepare("SELECT id, external_id AS externalId, first_name AS firstName, last_name AS lastName, attendance_required_from AS attendanceRequiredFrom FROM members WHERE installation_id = 'primary' AND (id = ? OR external_id = ?) AND active = 1").bind(input.memberId, input.memberId).first<{ id: string; externalId: string; firstName: string; lastName: string; attendanceRequiredFrom?: string }>(),
    db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number }>(),
  ]);
  const meeting = input.meetingId
    ? await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<{ id: string; title: string; startsAt: string; endsAt: string }>()
    : await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL AND starts_at <= ? ORDER BY starts_at DESC LIMIT 1").bind(input.occurredAt).first<{ id: string; title: string; startsAt: string; endsAt: string }>();
  if (!member) throw new HttpError(404, "This fingerprint is not linked to an active roster member");
  if (!meeting) throw new HttpError(409, "No meeting is accepting attendance scans at this time");
  if (member.attendanceRequiredFrom && meeting.startsAt.slice(0, 10) < member.attendanceRequiredFrom) throw new HttpError(409, `Attendance for ${member.firstName} begins on ${member.attendanceRequiredFrom}`);
  const window = scanWindowState(meeting, input.occurredAt, settings?.lateScanMinutes ?? 30);
  if (!window.accepted) throw new HttpError(409, input.meetingId ? window.reason : "No meeting is accepting attendance scans at this time");
  const prior = await db.prepare("SELECT id, action, occurred_at AS occurredAt FROM attendance_events WHERE installation_id = 'primary' AND member_id = ? AND meeting_id = ? ORDER BY occurred_at, id").bind(member.id, meeting.id).all<{ id: string; action: AttendanceAction; occurredAt: string }>();
  const priorEvents = prior.results ?? [];
  const transition = input.desiredAction
    ? priorEvents.some((event) => event.action === input.desiredAction) ? { status: "duplicate" as const, action: input.desiredAction } : input.desiredAction === "check_out" && !priorEvents.some((event) => event.action === "check_in") ? { status: "complete" as const } : { status: "accepted" as const, action: input.desiredAction }
    : nextAttendanceAction(priorEvents, input.occurredAt);
  if (transition.status === "duplicate") return response({ accepted: false, duplicate: true, eventId: input.eventId, action: transition.action, attendanceClosesAt: window.closesAt }, 200);
  if (transition.status === "complete") throw new HttpError(409, "Attendance is already complete for this member and meeting");
  const id = crypto.randomUUID();
  const result = await db.prepare("INSERT OR IGNORE INTO attendance_events (id, installation_id, member_id, meeting_id, source, occurred_at, kiosk_event_id, created_by, action) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)").bind(id, member.id, meeting.id, source, input.occurredAt, input.eventId.trim(), actorId ?? null, transition.action).run();
  return response({ accepted: (result.meta?.changes ?? 1) > 0, duplicate: (result.meta?.changes ?? 1) === 0, eventId: input.eventId, action: transition.action, attendanceClosesAt: window.closesAt, meeting: { id: meeting.id, title: meeting.title }, member: { id: member.id, externalId: member.externalId, displayName: `${member.firstName} ${member.lastName}`.trim() } }, 202);
}
async function kioskAttendance(request: Request, env: Env): Promise<Response> { await kioskFor(request, env); return recordAttendance(requireDatabase(env), await parseJson(request), "kiosk"); }
async function simulatedKiosk(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") {
    const simulator = await db.prepare("SELECT name, active, online, last_seen_at AS lastSeenAt, created_at AS pairedAt FROM simulated_kiosk_sessions WHERE installation_id = 'primary'").first();
    return response({ simulator: simulator ? { ...simulator, readerOnline: false, releaseVersion: "browser simulator" } : null });
  }
  const input = await parseJson<{ action?: "pair" | "heartbeat" | "check-in" | "scan" | "stop"; scanAction?: AttendanceAction; code?: string; kioskName?: string; online?: boolean; memberId?: string; meetingId?: string; eventId?: string }>(request);
  if (input.action === "pair") {
    const code = input.code?.trim().toUpperCase(); const kioskName = input.kioskName?.trim();
    if (!code || !kioskName || kioskName.length > 80) throw new HttpError(400, "Simulator pairing code and name are required");
    const now = new Date().toISOString(); const pairing = await db.prepare("SELECT id FROM pairing_codes WHERE installation_id = 'primary' AND purpose = 'simulator' AND code_hash = ? AND redeemed_at IS NULL AND expires_at > ?").bind(await sha256(code), now).first<{ id: string }>();
    if (!pairing) throw new HttpError(401, "Simulator pairing code is invalid or expired");
    const results = await db.batch([
      db.prepare("UPDATE pairing_codes SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL AND expires_at > ?").bind(now, pairing.id, now),
      db.prepare("INSERT INTO simulated_kiosk_sessions (installation_id, pairing_code_id, name, active, online, last_seen_at, created_by, created_at) SELECT 'primary', ?, ?, 1, 1, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE id = ? AND redeemed_at = ?) ON CONFLICT(installation_id) DO UPDATE SET pairing_code_id = excluded.pairing_code_id, name = excluded.name, active = 1, online = 1, last_seen_at = excluded.last_seen_at, created_by = excluded.created_by, created_at = excluded.created_at").bind(pairing.id, kioskName, now, principal.userId, now, pairing.id, now),
      db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) SELECT ?, 'primary', ?, 'simulator.paired', 'simulated_kiosk', 'browser', ? WHERE EXISTS (SELECT 1 FROM simulated_kiosk_sessions WHERE installation_id = 'primary' AND pairing_code_id = ?)").bind(crypto.randomUUID(), principal.userId, now, pairing.id),
    ]);
    if ((results[1]?.meta?.changes ?? 1) < 1) throw new HttpError(409, "Simulator pairing code was already used");
    return response({ paired: true, name: kioskName, online: true, readerOnline: false }, 201);
  }
  const simulator = await db.prepare("SELECT name, active, online FROM simulated_kiosk_sessions WHERE installation_id = 'primary'").first<{ name: string; active: number; online: number }>();
  if (!simulator?.active) throw new HttpError(409, "Pair the browser simulator before using it");
  if (input.action === "heartbeat") {
    if (typeof input.online !== "boolean") throw new HttpError(400, "Simulator online status is required");
    const now = new Date().toISOString(); await db.prepare("UPDATE simulated_kiosk_sessions SET online = ?, last_seen_at = CASE WHEN ? = 1 THEN ? ELSE last_seen_at END WHERE installation_id = 'primary'").bind(input.online ? 1 : 0, input.online ? 1 : 0, now).run();
    await writeAudit(db, principal, "simulator.status_changed", "simulated_kiosk", "browser", { online: input.online });
    return response({ online: input.online, lastSeenAt: input.online ? now : undefined, readerOnline: false });
  }
  if (input.action === "stop") {
    await db.prepare("UPDATE simulated_kiosk_sessions SET active = 0, online = 0 WHERE installation_id = 'primary'").run();
    await writeAudit(db, principal, "simulator.stopped", "simulated_kiosk", "browser"); return response({ active: false });
  }
  if (input.action === "check-in" || input.action === "scan") {
    if (!simulator.online) throw new HttpError(409, "Bring the simulated kiosk online before checking in");
    const meeting = input.meetingId ? await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first() : null;
    if (!meeting) throw new HttpError(400, "Choose an active meeting for the simulator scan");
    if (input.action === "scan" && input.scanAction !== undefined && !["check_in", "check_out"].includes(input.scanAction)) throw new HttpError(400, "Simulator scanAction must be check_in or check_out");
    const result = await recordAttendance(db, { eventId: input.eventId ?? `simulator-${crypto.randomUUID()}`, memberId: input.memberId, meetingId: input.meetingId, occurredAt: new Date().toISOString(), desiredAction: input.action === "scan" ? input.scanAction : undefined }, "simulator", principal.userId);
    const outcome = await result.clone().json() as { action: AttendanceAction; duplicate?: boolean };
    await writeAudit(db, principal, outcome.action === "check_out" ? "simulator.check_out" : "simulator.check_in", "meeting", input.meetingId!, { memberId: input.memberId, origin: "browser_simulator", duplicate: Boolean(outcome.duplicate) }); return result;
  }
  throw new HttpError(400, "Simulator action must be pair, heartbeat, scan, or stop");
}
async function attendance(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const url = new URL(request.url);
  if (request.method === "GET") {
    const meetingId = url.searchParams.get("meetingId"); const includeInactive = url.searchParams.get("includeInactive") === "1"; if (!meetingId) throw new HttpError(400, "meetingId is required");
    const [rows, meeting, settings, audiences, labelResult, changeResult, targetResult] = await Promise.all([
      db.prepare("SELECT m.id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id AS discordUserId, m.attendance_required_from AS attendanceRequiredFrom, m.created_at AS rosterAddedAt, (SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS correction, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_out') AS checkedOutAt FROM members m WHERE m.installation_id = 'primary' AND (m.active = 1 OR ? = 1) ORDER BY m.last_name, m.first_name").bind(meetingId, meetingId, meetingId, meetingId, includeInactive ? 1 : 0).all<{ memberId: string; externalId: string; firstName: string; lastName: string; discordUserId?: string; attendanceRequiredFrom?: string; rosterAddedAt?: string; correction?: "present" | "absent" | "excused"; reason?: string; checkedInAt?: string; checkedOutAt?: string }>(),
      db.prepare("SELECT starts_at AS startsAt, ends_at AS endsAt, required, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ startsAt: string; endsAt: string; required: number; audienceMode: "all" | "labels" }>(),
      db.prepare("SELECT late_scan_minutes AS lateScanMinutes, time_zone AS timeZone, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number; timeZone: string; policyActivatedOn: string | null }>(),
      meetingAudienceIds(db, [meetingId]),
      db.prepare("SELECT id, name, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary'").all<{ id: string; name: string; formulaEnabled: number }>(),
      db.prepare("SELECT member_id AS memberId, label_id AS labelId, action, effective_date AS effectiveDate FROM member_label_changes WHERE installation_id = 'primary' ORDER BY effective_date, created_at, id").all<LabelChange>(),
      db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, rule_type AS ruleType FROM label_attendance_rules WHERE installation_id = 'primary'").all<Pick<AttendanceRule, "id" | "labelId" | "startsOn" | "endsOn" | "ruleType">>(),
    ]);
    if (!meeting) throw new HttpError(404, "Meeting not found");
    const closesAt = attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30); const finalized = Date.now() > Date.parse(closesAt);
    const meetingDate = policyLocalDate(meeting.startsAt, settings?.timeZone ?? "UTC"); const audienceIds = audiences.get(meetingId) ?? []; const labelsById = new Map((labelResult.results ?? []).map((label) => [label.id, label]));
    const audience = meeting.audienceMode === "all" ? "All" : audienceIds.map((id) => labelsById.get(id)?.name ?? "Retired label").join(", ");
    return response({ attendance: (rows.results ?? []).map((row) => {
      const events = [{ action: "check_in" as const, occurredAt: row.checkedInAt }, ...(row.checkedOutAt ? [{ action: "check_out" as const, occurredAt: row.checkedOutAt }] : [])].filter((event) => event.occurredAt); const derived = attendanceDisposition(events, row.correction);
      const activeLabels = new Set<string>(); for (const change of changeResult.results ?? []) if (change.memberId === row.memberId && change.effectiveDate <= meetingDate) { if (change.action === "add") activeLabels.add(change.labelId); else activeLabels.delete(change.labelId); }
      const policyLabel = [...activeLabels].find((id) => (targetResult.results ?? []).some((rule) => rule.labelId === id)) ?? (settings?.policyActivatedOn && meetingDate < settings.policyActivatedOn ? [...activeLabels].find((id) => labelsById.get(id)?.formulaEnabled) : undefined);
      const selected = (targetResult.results ?? []).find((rule) => rule.labelId === policyLabel && rule.startsOn && rule.startsOn <= meetingDate && (!rule.endsOn || meetingDate <= rule.endsOn)) ?? (targetResult.results ?? []).find((rule) => rule.labelId === policyLabel && !rule.startsOn);
      const weekly = selected?.ruleType === "weekly_count";
      const legacy = Boolean(selected?.id.startsWith("legacy:") && settings?.policyActivatedOn && meetingDate < settings.policyActivatedOn);
      const eligibility = meetingEligibility({ date: meetingDate, participationStart: row.attendanceRequiredFrom ?? row.rosterAddedAt?.slice(0, 10), activeLabels: legacy && policyLabel ? new Set([policyLabel]) : activeLabels, formulaLabel: weekly || !selected ? policyLabel : undefined, hasWeeklyTarget: weekly, meeting: { required: meeting.required, audienceMode: meeting.audienceMode ?? "all", audienceLabelIds: audienceIds } });
      return { ...row, disposition: Date.now() < Date.parse(meeting.startsAt) && derived === "absent" ? "upcoming" : finalized && derived === "active" ? "absent" : derived, eligibility, rateEligible: eligibility === "required" || eligibility === "weekly", policy: weekly ? "weekly" : "standard", audience };
    }), audience, attendanceClosesAt: closesAt, finalized });
  }
  return recordAttendance(db, await parseJson(request), "manual", principal.userId);
}
async function correction(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<{ memberId?: string; meetingId?: string; disposition?: "present" | "absent" | "excused"; reason?: string }>(request);
  const reason = input.reason?.trim() ?? "";
  if (!input.memberId || !input.meetingId || !input.disposition || !["present", "absent", "excused"].includes(input.disposition) || (input.disposition !== "present" && !reason) || reason.length > 300) throw new HttpError(400, "Member, meeting, disposition, and a reason are required for absence or excuse corrections");
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO attendance_corrections (id, installation_id, member_id, meeting_id, disposition, reason, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, input.memberId, input.meetingId, input.disposition, reason, principal.userId, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'attendance.corrected', 'attendance_correction', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ memberId: input.memberId, meetingId: input.meetingId, disposition: input.disposition }), now),
  ]);
  return response({ correction: { id, ...input, reason, createdAt: now } }, 201);
}
async function cleanupAttendance(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ memberId?: string; meetingId?: string; confirmation?: string }>(request);
  if (!input.memberId || !input.meetingId) throw new HttpError(400, "Member and meeting are required");
  if (input.confirmation !== "CLEAR ATTENDANCE") throw new HttpError(400, "Type CLEAR ATTENDANCE exactly to continue");
  const member = await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND id = ?").bind(input.memberId).first<{ id: string }>();
  const meeting = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first<{ id: string }>();
  if (!member || !meeting) throw new HttpError(404, "Member or meeting not found");
  const results = await db.batch([db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary' AND member_id = ? AND meeting_id = ? RETURNING id").bind(member.id, meeting.id), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary' AND member_id = ? AND meeting_id = ? RETURNING id").bind(member.id, meeting.id)]);
  const cleared = (results[0]?.results?.length ?? 0) + (results[1]?.results?.length ?? 0); await writeAudit(db, principal, "attendance.member_meeting_cleared", "meeting", meeting.id, { memberId: member.id, cleared }); return response({ cleared });
}
function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
async function loadPolicyData(db: D1Database, memberId?: string, meetingId?: string): Promise<{ members: PolicyMember[]; labels: PolicyLabel[]; changes: LabelChange[]; rules: AttendanceRule[]; meetings: PolicyMeeting[]; observations: Observation[]; timeZone: string; baseline: string | null; recentDays: number; policyActivatedOn: string | null }> {
  const scoped = (sql: string, column: string, value?: string) => value ? db.prepare(sql.replace(" ORDER BY", ` AND ${column} = ? ORDER BY`)).bind(value) : db.prepare(sql);
  const [memberResult, labelResult, changeResult, ruleResult, meetingResult, audienceResult, eventResult, correctionResult, settings] = await Promise.all([
    scoped("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active, attendance_required_from AS attendanceRequiredFrom, created_at AS rosterAddedAt FROM members WHERE installation_id = 'primary' ORDER BY last_name, first_name", "id", memberId).all<PolicyMember>(),
    db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' ORDER BY name COLLATE NOCASE").all<PolicyLabel>(),
    scoped("SELECT member_id AS memberId, label_id AS labelId, action, effective_date AS effectiveDate, created_at AS createdAt FROM member_label_changes WHERE installation_id = 'primary' ORDER BY effective_date, created_at, id", "member_id", memberId).all<LabelChange>(),
    db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, rule_type AS ruleType, threshold_percent AS thresholdPercent, meetings_per_week AS meetingsPerWeek, excused_handling AS excusedHandling FROM label_attendance_rules WHERE installation_id = 'primary' ORDER BY label_id, starts_on").all<AttendanceRule>(),
    scoped("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, attendance_weight AS attendanceWeight, audience_mode AS audienceMode, is_test AS isTest FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL ORDER BY starts_at DESC", "id", meetingId).all<Omit<PolicyMeeting, "attendanceClosesAt" | "audienceLabelIds">>(),
    db.prepare("SELECT meeting_id AS meetingId, label_id AS labelId FROM meeting_audience_labels WHERE installation_id = 'primary'").all<{ meetingId: string; labelId: string }>(),
    scoped("SELECT e.meeting_id AS meetingId, e.member_id AS memberId, e.action, e.occurred_at AS occurredAt FROM attendance_events e JOIN meetings mt ON mt.id = e.meeting_id AND mt.installation_id = e.installation_id WHERE e.installation_id = 'primary' AND mt.deleted_at IS NULL ORDER BY e.occurred_at, e.id", memberId ? "e.member_id" : "e.meeting_id", memberId ?? meetingId).all<{ meetingId: string; memberId: string; action: "check_in" | "check_out"; occurredAt: string }>(),
    scoped("SELECT c.meeting_id AS meetingId, c.member_id AS memberId, c.disposition, c.reason FROM attendance_corrections c JOIN meetings mt ON mt.id = c.meeting_id AND mt.installation_id = c.installation_id WHERE c.installation_id = 'primary' AND mt.deleted_at IS NULL ORDER BY c.created_at, c.id", memberId ? "c.member_id" : "c.meeting_id", memberId ?? meetingId).all<{ meetingId: string; memberId: string; disposition: "present" | "absent" | "excused"; reason: string }>(),
    db.prepare("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on AS baseline, attendance_recent_days AS recentDays, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string; lateScanMinutes: number; baseline: string | null; recentDays: number; policyActivatedOn: string | null }>(),
  ]);
  const audienceLabels = new Map<string, string[]>();
  for (const item of audienceResult.results ?? []) audienceLabels.set(item.meetingId, [...(audienceLabels.get(item.meetingId) ?? []), item.labelId]);
  const events = new Map<string, { action: "check_in" | "check_out"; occurredAt: string }[]>();
  for (const event of eventResult.results ?? []) { const key = `${event.meetingId}:${event.memberId}`; events.set(key, [...(events.get(key) ?? []), event]); }
  const corrections = new Map<string, { disposition: "present" | "absent" | "excused"; reason: string }>();
  for (const correction of correctionResult.results ?? []) corrections.set(`${correction.meetingId}:${correction.memberId}`, correction);
  const observations: Observation[] = [...new Set([...events.keys(), ...corrections.keys()])].map((key) => {
    const eventRows = events.get(key) ?? []; const correction = corrections.get(key); const split = key.indexOf(":");
    return { meetingId: key.slice(0, split), memberId: key.slice(split + 1), disposition: attendanceDisposition(eventRows, correction?.disposition), checkedInAt: eventRows.find((event) => event.action === "check_in")?.occurredAt, checkedOutAt: eventRows.find((event) => event.action === "check_out")?.occurredAt, reason: correction?.reason };
  });
  return { members: memberResult.results ?? [], labels: labelResult.results ?? [], changes: changeResult.results ?? [], rules: ruleResult.results ?? [], meetings: (meetingResult.results ?? []).map((meeting) => ({ ...meeting, attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30), audienceLabelIds: audienceLabels.get(meeting.id) ?? [] })), observations, timeZone: settings?.timeZone ?? "UTC", baseline: settings?.baseline ?? null, recentDays: settings?.recentDays ?? 30, policyActivatedOn: settings?.policyActivatedOn ?? null };
}
type PolicyData = Awaited<ReturnType<typeof loadPolicyData>>;
const reportDataCache = new ReportDataCache<PolicyData>();
async function policyData(db: D1Database, scope: { memberId?: string; meetingId?: string } = {}): Promise<PolicyData> {
  return reportDataCache.read(databaseIdentity(db), JSON.stringify(scope), async () => {
    const row = await db.prepare("SELECT revision FROM report_data_revision WHERE installation_id = 'primary'").first<{ revision: number }>();
    return row?.revision;
  }, () => loadPolicyData(db, scope.memberId, scope.meetingId));
}

type ReportFilters = { from?: string; to?: string; meetingType: "all" | "required" | "optional"; roster: "active" | "all"; labelId?: string; membership: "current" | "historical"; memberId?: string; useBaseline?: boolean };
function reportFilters(url: URL): ReportFilters {
  const from = url.searchParams.get("from") || undefined; const to = url.searchParams.get("to") || undefined;
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) throw new HttpError(400, "Report dates must be valid and in order");
  const meetingType = url.searchParams.get("meetingType") ?? "all"; const roster = url.searchParams.get("roster") ?? "active"; const membership = url.searchParams.get("membership") ?? "current";
  if (!["all", "required", "optional"].includes(meetingType) || !["active", "all"].includes(roster) || !["current", "historical"].includes(membership)) throw new HttpError(400, "Invalid report filter");
  return { from, to, meetingType: meetingType as ReportFilters["meetingType"], roster: roster as ReportFilters["roster"], labelId: url.searchParams.get("labelId") || undefined, membership: membership as ReportFilters["membership"], memberId: url.searchParams.get("memberId") || undefined };
}
async function policyReport(db: D1Database, filters: ReportFilters): Promise<{ meetings: PolicyMeeting[]; members: PolicyMemberResult[]; labels: PolicyLabel[]; baseline: string | null; timeZone: string }> {
  const data = await policyData(db, filters.memberId ? { memberId: filters.memberId } : {});
  if (filters.labelId && !data.labels.some((label) => label.id === filters.labelId)) throw new HttpError(400, "Unknown label filter");
  const meetings = data.meetings.filter((meeting) => filters.meetingType === "all" || Boolean(meeting.required) === (filters.meetingType === "required"));
  const from = filters.from ?? (filters.useBaseline ? data.baseline ?? undefined : undefined);
  const full = new Map(evaluateAttendance(data).map((item) => [item.member.id, item]));
  const members = evaluateAttendance({ ...data, meetings, from, to: filters.to, historicalLabelId: filters.labelId && filters.membership === "historical" ? filters.labelId : undefined }).map((item) => ({ ...item, currentCompliances: full.get(item.member.id)?.currentCompliances ?? item.currentCompliances, currentCompliance: full.get(item.member.id)?.currentCompliance ?? item.currentCompliance, historySummaries: full.get(item.member.id)?.historySummaries ?? item.historySummaries })).filter((item) => (filters.roster === "all" || Boolean(item.member.active)) && (!filters.memberId || item.member.id === filters.memberId) && (!filters.labelId || (filters.membership === "historical" ? item.rows.length > 0 : item.currentLabelIds.includes(filters.labelId))));
  return { meetings: meetings.filter((meeting) => !meeting.isTest && Date.parse(meeting.attendanceClosesAt) <= Date.now() && (!from || policyLocalDate(meeting.startsAt, data.timeZone) >= from) && (!filters.to || policyLocalDate(meeting.startsAt, data.timeZone) <= filters.to)), members, labels: data.labels, baseline: data.baseline, timeZone: data.timeZone };
}
async function attendanceReport(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]);
  return response(await policyReport(requireDatabase(env), reportFilters(new URL(request.url))));
}
type SavedReportRow = { id: string; ownerUserId: string; scope: ReportScope; name: string; definitionJson: string; revision: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string; pinnedPosition?: number | null };
type ReportQueryInput = { definition?: unknown; page?: unknown; pageSize?: unknown };
type ReportRun = { definition: ReportDefinition; warnings: string[]; resolvedPeriod: { from?: string; to: string }; columns: { id: string; key: string; label: string; labelId?: string }[]; rows: ReportResultRow[]; periodMembers: PolicyMemberResult[]; officialMembers: PolicyMemberResult[]; meetings: PolicyMeeting[]; labels: PolicyLabel[]; rules: AttendanceRule[]; timeZone: string };
function reportName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, "Report name is required and must be at most 80 characters");
  return value.trim();
}
function reportScope(value: unknown): ReportScope {
  if (value !== "personal" && value !== "shared") throw new HttpError(400, "Report scope must be personal or shared");
  return value;
}
function parseStoredReportDefinition(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
async function ensureUniqueReportName(db: D1Database, scope: ReportScope, name: string, ownerUserId: string, exceptId?: string): Promise<void> {
  const existing = scope === "shared"
    ? await db.prepare("SELECT id FROM saved_report_views WHERE installation_id = 'primary' AND scope = 'shared' AND name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?)").bind(name, exceptId ?? null, exceptId ?? null).first<{ id: string }>()
    : await db.prepare("SELECT id FROM saved_report_views WHERE installation_id = 'primary' AND scope = 'personal' AND owner_user_id = ? AND name = ? COLLATE NOCASE AND (? IS NULL OR id <> ?)").bind(ownerUserId, name, exceptId ?? null, exceptId ?? null).first<{ id: string }>();
  if (existing) throw new HttpError(409, scope === "shared" ? "A shared report already uses that name" : "You already have a personal report with that name");
}
async function accessibleReport(db: D1Database, principal: Principal, id: string): Promise<SavedReportRow> {
  const item = await db.prepare("SELECT id, owner_user_id AS ownerUserId, scope, name, definition_json AS definitionJson, revision, created_by AS createdBy, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt FROM saved_report_views WHERE installation_id = 'primary' AND id = ? AND (scope = 'shared' OR owner_user_id = ?)").bind(id, principal.userId).first<SavedReportRow>();
  if (!item) throw new HttpError(404, "Report not found");
  return item;
}
async function reportMetadata(db: D1Database): Promise<{ labels: PolicyLabel[]; baseline: string | null; timeZone: string }> {
  const [labels, settings] = await Promise.all([
    db.prepare("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary' ORDER BY name COLLATE NOCASE").all<PolicyLabel>(),
    db.prepare("SELECT attendance_reporting_starts_on AS baseline, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ baseline: string | null; timeZone: string }>(),
  ]);
  return { labels: labels.results ?? [], baseline: settings?.baseline ?? null, timeZone: settings?.timeZone ?? "UTC" };
}
async function reportCatalog(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const data = await reportMetadata(requireDatabase(env));
  return response({ columns: reportColumnCatalog, labels: data.labels, baseline: data.baseline, timeZone: data.timeZone, defaultDefinition: defaultReportDefinition(Boolean(data.baseline)), role: principal.role });
}
function savedReportResponse(item: SavedReportRow, labels: PolicyLabel[]) {
  const validation = validateReportDefinition(parseStoredReportDefinition(item.definitionJson), labels, { allowMissingLabels: true });
  return { id: item.id, ownerUserId: item.ownerUserId, scope: item.scope, name: item.name, definition: validation.definition ?? parseStoredReportDefinition(item.definitionJson), revision: Number(item.revision), createdBy: item.createdBy, updatedBy: item.updatedBy, createdAt: item.createdAt, updatedAt: item.updatedAt, pinnedPosition: item.pinnedPosition ?? null, warnings: validation.warnings, errors: validation.errors };
}
async function savedReports(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const data = await reportMetadata(db);
  if (request.method === "GET") {
    const result = await db.prepare("SELECT v.id, v.owner_user_id AS ownerUserId, v.scope, v.name, v.definition_json AS definitionJson, v.revision, v.created_by AS createdBy, v.updated_by AS updatedBy, v.created_at AS createdAt, v.updated_at AS updatedAt, t.position AS pinnedPosition FROM saved_report_views v LEFT JOIN saved_report_tabs t ON t.installation_id = v.installation_id AND t.report_view_id = v.id AND t.user_id = ? WHERE v.installation_id = 'primary' AND (v.scope = 'shared' OR v.owner_user_id = ?) ORDER BY CASE WHEN t.position IS NULL THEN 1 ELSE 0 END, t.position, v.name COLLATE NOCASE, v.id").bind(principal.userId, principal.userId).all<SavedReportRow>();
    return response({ reports: (result.results ?? []).map((item) => savedReportResponse(item, data.labels)) });
  }
  const input = await parseJson<{ name?: unknown; scope?: unknown; definition?: unknown }>(request); const name = reportName(input.name); const scope = reportScope(input.scope);
  const validation = validateReportDefinition(input.definition, data.labels); if (!validation.definition || validation.errors.length) throw new HttpError(400, "Invalid report definition", validation.errors);
  await ensureUniqueReportName(db, scope, name, principal.userId);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  const position = await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM saved_report_tabs WHERE installation_id = 'primary' AND user_id = ?").bind(principal.userId).first<{ position: number }>();
  await db.batch([
    db.prepare("INSERT INTO saved_report_views (id, installation_id, owner_user_id, scope, name, definition_json, revision, created_by, updated_by, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, ?, 1, ?, ?, ?, ?)").bind(id, principal.userId, scope, name, JSON.stringify(validation.definition), principal.userId, principal.userId, now, now),
    db.prepare("INSERT INTO saved_report_tabs (installation_id, user_id, report_view_id, position, pinned_at) VALUES ('primary', ?, ?, ?, ?)").bind(principal.userId, id, Number(position?.position ?? 0), now),
  ]);
  await writeAudit(db, principal, "report.created", "saved_report", id, { name, scope });
  const created = await accessibleReport(db, principal, id); return response({ report: savedReportResponse({ ...created, pinnedPosition: Number(position?.position ?? 0) }, data.labels) }, 201);
}
async function manageSavedReport(request: Request, env: Env, id: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const current = await accessibleReport(db, principal, id);
  if (request.method === "DELETE") {
    const revisionText = new URL(request.url).searchParams.get("revision");
    if (revisionText && Number(revisionText) !== Number(current.revision)) throw new HttpError(409, "This report changed after you opened it. Reload before deleting it.");
    await db.prepare("DELETE FROM saved_report_views WHERE installation_id = 'primary' AND id = ?").bind(id).run();
    await writeAudit(db, principal, "report.deleted", "saved_report", id, { name: current.name, scope: current.scope, revision: current.revision }); return response({ deleted: true });
  }
  const input = await parseJson<{ name?: unknown; scope?: unknown; definition?: unknown; revision?: unknown }>(request); const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision !== Number(current.revision)) throw new HttpError(409, "This report changed after you opened it. Reload and reapply your changes.");
  const name = reportName(input.name); const scope = reportScope(input.scope);
  if (current.scope === "shared" && scope === "personal" && current.ownerUserId !== principal.userId) throw new HttpError(403, "Save a personal copy instead of converting another user's shared report");
  const data = await reportMetadata(db); const validation = validateReportDefinition(input.definition, data.labels);
  if (!validation.definition || validation.errors.length) throw new HttpError(400, "Invalid report definition", validation.errors);
  await ensureUniqueReportName(db, scope, name, current.ownerUserId, id); const now = new Date().toISOString();
  const result = await db.prepare("UPDATE saved_report_views SET scope = ?, name = ?, definition_json = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND revision = ?").bind(scope, name, JSON.stringify(validation.definition), principal.userId, now, id, revision).run();
  if (!result.meta?.changes) throw new HttpError(409, "This report changed after you opened it. Reload and reapply your changes.");
  await writeAudit(db, principal, "report.updated", "saved_report", id, { name, scope, revision: revision + 1 }); const updated = await accessibleReport(db, principal, id);
  return response({ report: savedReportResponse(updated, data.labels) });
}
async function savedReportTabs(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ reportIds?: unknown }>(request);
  if (!Array.isArray(input.reportIds) || input.reportIds.length > 50 || input.reportIds.some((id) => typeof id !== "string") || new Set(input.reportIds).size !== input.reportIds.length) throw new HttpError(400, "Pinned reports must be a unique ordered list");
  const reportIds = input.reportIds as string[];
  if (reportIds.length) {
    const accessible = await db.prepare(`SELECT id FROM saved_report_views WHERE installation_id = 'primary' AND id IN (${reportIds.map(() => "?").join(",")}) AND (scope = 'shared' OR owner_user_id = ?)` ).bind(...reportIds, principal.userId).all<{ id: string }>();
    if ((accessible.results ?? []).length !== reportIds.length) throw new HttpError(400, "One or more pinned reports are unavailable");
  }
  const now = new Date().toISOString(); await db.batch([
    db.prepare("DELETE FROM saved_report_tabs WHERE installation_id = 'primary' AND user_id = ?").bind(principal.userId),
    ...reportIds.map((id, position) => db.prepare("INSERT INTO saved_report_tabs (installation_id, user_id, report_view_id, position, pinned_at) VALUES ('primary', ?, ?, ?, ?)").bind(principal.userId, id, position, now)),
  ]);
  return response({ reportIds });
}
function reportPagination(pageValue: unknown, pageSizeValue: unknown, total: number): { page: number; pageSize: 25 | 50 | 100 | "all"; from: number; to: number; totalPages: number } {
  const pageSize = pageSizeValue === "all" ? "all" : Number(pageSizeValue ?? 25);
  if (pageSize !== "all" && ![25, 50, 100].includes(pageSize)) throw new HttpError(400, "Page size must be 25, 50, 100, or all");
  const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(total / pageSize)); const page = Math.max(1, Number(pageValue ?? 1));
  if (!Number.isInteger(page)) throw new HttpError(400, "Page must be a positive integer");
  const safePage = Math.min(page, totalPages); const from = pageSize === "all" ? 0 : (safePage - 1) * pageSize; const to = pageSize === "all" ? total : Math.min(total, from + pageSize);
  return { page: safePage, pageSize: pageSize as 25 | 50 | 100 | "all", from, to, totalPages };
}
async function runReportDefinition(db: D1Database, value: unknown): Promise<ReportRun> {
  const data = await policyData(db); const validation = validateReportDefinition(value, data.labels, { allowMissingLabels: true });
  if (!validation.definition || validation.errors.length) throw new HttpError(400, "Invalid report definition", validation.errors);
  const definition = validation.definition; const today = policyLocalDate(new Date().toISOString(), data.timeZone); const resolved = resolveReportPeriod(definition.period, today, data.baseline); const warnings = [...validation.warnings];
  if (resolved.warning) warnings.push(resolved.warning);
  const meetings = data.meetings.filter((meeting) => definition.meetingType === "all" || Boolean(meeting.required) === (definition.meetingType === "required"));
  const officialMembers = evaluateAttendance(data); const columnLabelIds = definition.columns.flatMap((column) => column.labelId ? [column.labelId] : []); const summaryLabelIds = [...new Set([...definition.labelIds, ...columnLabelIds])];
  const periodMembers = evaluateAttendance({ ...data, meetings, from: resolved.from, to: resolved.to ?? today, historicalLabelIds: definition.membership === "historical" ? definition.labelIds : [], historicalLabelMatch: definition.labelMatch, summaryLabelIds })
    .filter((item) => (definition.roster === "all" || Boolean(item.member.active)) && (definition.membership === "historical" ? !definition.labelIds.length || item.rows.length > 0 : reportLabelsMatch(item.currentLabelIds, definition.labelIds, definition.labelMatch)));
  const rows = buildReportRows({ definition, official: officialMembers, period: periodMembers, meetings, labels: data.labels, rules: data.rules, timeZone: data.timeZone, from: resolved.from, to: resolved.to ?? today }); const labelNames = new Map(data.labels.map((label) => [label.id, label.name]));
  const matchingMemberIds = new Set(rows.map((row) => row.member.id));
  return { definition, warnings: [...new Set(warnings)], resolvedPeriod: { from: resolved.from, to: resolved.to ?? today }, columns: definition.columns.map((column) => ({ id: reportColumnId(column), key: column.key, label: reportColumnLabel(column, labelNames), labelId: column.labelId })), rows, periodMembers: periodMembers.filter((member) => matchingMemberIds.has(member.member.id)), officialMembers, meetings, labels: data.labels, rules: data.rules, timeZone: data.timeZone };
}
async function customReportQuery(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const input = await parseJson<ReportQueryInput>(request); const run = await runReportDefinition(requireDatabase(env), input.definition); const pagination = reportPagination(input.page, input.pageSize, run.rows.length);
  return response({ definition: run.definition, warnings: run.warnings, resolvedPeriod: run.resolvedPeriod, columns: run.columns, rows: run.rows.slice(pagination.from, pagination.to), pagination: { page: pagination.page, pageSize: pagination.pageSize, totalRows: run.rows.length, totalPages: pagination.totalPages, rangeStart: run.rows.length ? pagination.from + 1 : 0, rangeEnd: pagination.to } });
}
async function leaderboardReport(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const url = new URL(request.url); const report = await policyReport(requireDatabase(env), reportFilters(url)); const sort = url.searchParams.get("sort") ?? "regular-desc";
  if (!["regular-desc", "first-name", "last-name"].includes(sort)) throw new HttpError(400, "Invalid leaderboard sort");
  report.members.sort((left, right) => {
    if (sort === "regular-desc") { const a = left.regularAttendance.rate, b = right.regularAttendance.rate; if (a === null && b !== null) return 1; if (a !== null && b === null) return -1; if (a !== null && b !== null && a !== b) return b - a; }
    const first = sort === "first-name" ? left.member.firstName.localeCompare(right.member.firstName) : left.member.lastName.localeCompare(right.member.lastName);
    return first || (sort === "first-name" ? left.member.lastName.localeCompare(right.member.lastName) : left.member.firstName.localeCompare(right.member.firstName)) || left.member.memberId.localeCompare(right.member.memberId);
  });
  const policyAlerts = report.members.flatMap((item) => item.currentCompliances.flatMap((policy, index) => policy.status === "below" ? [{ key: `${item.member.id}:${policy.labelId ?? index}`, memberId: item.member.memberId, name: `${item.member.firstName} ${item.member.lastName}`, policy }] : []));
  const trend = report.meetings.map((meeting) => { const rows = report.members.flatMap((member) => member.rows.filter((row) => row.meetingId === meeting.id && row.regularEligible)); const attended = rows.reduce((sum, row) => sum + (row.attended ? row.regularWeight : 0), 0); const eligible = rows.reduce((sum, row) => sum + row.regularWeight, 0); return { meetingId: meeting.id, title: meeting.title, startsAt: meeting.startsAt, rate: eligible > 0 ? Math.round(attended / eligible * 100) : null }; }).filter((point) => point.rate !== null);
  const pagination = reportPagination(url.searchParams.get("page") ?? 1, url.searchParams.get("pageSize") ?? 25, report.members.length); return response({ ...report, members: report.members.slice(pagination.from, pagination.to), insights: { policyAlerts, trend }, pagination: { page: pagination.page, pageSize: pagination.pageSize, totalRows: report.members.length, totalPages: pagination.totalPages, rangeStart: report.members.length ? pagination.from + 1 : 0, rangeEnd: pagination.to } });
}
async function reportCsvExport(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<ReportQueryInput>(request); const run = await runReportDefinition(db, input.definition);
  const csv = [run.columns.map((column) => csvCell(column.label)).join(","), ...run.rows.map((row) => run.columns.map((column) => csvCell(row.cells[column.id]?.text ?? "")).join(","))].join("\r\n") + "\r\n";
  await writeAudit(db, principal, "report.exported", "saved_report", null, { format: "summary", rows: run.rows.length, columns: run.columns.map((column) => column.id) });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lancerlogin-report-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}
async function reportDetailCsvExport(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<ReportQueryInput>(request); const run = await runReportDefinition(db, input.definition); const meetingMap = new Map(run.meetings.map((meeting) => [meeting.id, meeting])); const official = new Map(run.officialMembers.map((item) => [item.member.id, item])); const labelNames = new Map(run.labels.map((label) => [label.id, label.name]));
  const headers = ["meeting", "meetingStart", "meetingEnd", "audience", "required", "attendanceWeight", "memberId", "firstName", "lastName", "memberLabels", "disposition", "eligibility", "regularEligible", "regularWeight", "regularWeightedPresent", "regularRate", "regularAttended", "regularRequired", "regularFrom", "regularTo", "policyEligible", "policyWeight", "policyWeightedPresent", "policyLabel", "policyRuleType", "policyExcusedHandling", "policyStatus", "policyTarget", "policyAttended", "policyRequired", "policyRate", "policyFrom", "policyTo", "policyResults", "policyHistory", "weeklyTarget", "weekStartsOn", "weekSegmentStartsOn", "weekSegmentEndsOn", "checkedInAt", "checkedOutAt", "reason"];
  const rows: Record<string, unknown>[] = run.periodMembers.flatMap((period) => { const item = official.get(period.member.id) ?? period; return period.rows.flatMap((row) => { const meeting = meetingMap.get(row.meetingId); if (!meeting) return []; const date = policyLocalDate(meeting.startsAt, run.timeZone); const week = period.weeks.find((candidate) => candidate.segmentStartsOn <= date && date <= candidate.segmentEndsOn); const policy = item.currentCompliance; return [{ meeting: meeting.title, meetingStart: meeting.startsAt, meetingEnd: meeting.endsAt, audience: row.audience, required: Boolean(meeting.required), attendanceWeight: meeting.attendanceWeight, memberId: period.member.memberId, firstName: period.member.firstName, lastName: period.member.lastName, memberLabels: row.memberLabelIds.map((labelId) => labelNames.get(labelId) ?? "Retired label").join("; "), disposition: row.disposition, eligibility: row.eligibility, regularEligible: row.regularEligible, regularWeight: row.regularWeight, regularWeightedPresent: row.regularEligible && row.attended ? row.regularWeight : 0, regularRate: period.regularAttendance.rate ?? "", regularAttended: period.regularAttendance.attended, regularRequired: period.regularAttendance.required, regularFrom: period.regularAttendance.from ?? "", regularTo: period.regularAttendance.to, policyEligible: row.rateEligible, policyWeight: row.weight, policyWeightedPresent: row.rateEligible && row.attended ? row.weight : 0, policyLabel: policy.labelName ?? "", policyRuleType: policy.ruleType ?? "", policyExcusedHandling: policy.excusedHandling ?? "", policyStatus: policy.status, policyTarget: policy.threshold ?? "", policyAttended: policy.attended, policyRequired: policy.required, policyRate: policy.rate ?? "", policyFrom: policy.status === "no_rule" ? "" : policy.from, policyTo: policy.status === "no_rule" ? "" : policy.to, policyResults: JSON.stringify(item.currentCompliances), policyHistory: JSON.stringify(item.historySummaries), weeklyTarget: week?.target ?? "", weekStartsOn: week?.weekStartsOn ?? "", weekSegmentStartsOn: week?.segmentStartsOn ?? "", weekSegmentEndsOn: week?.segmentEndsOn ?? "", checkedInAt: row.checkedInAt, checkedOutAt: row.checkedOutAt, reason: row.reason }]; }); });
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n") + "\r\n"; await writeAudit(db, principal, "report.exported", "saved_report", null, { format: "detail", rows: rows.length });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lancerlogin-report-detail-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}
function policySummaryText(summary?: PolicyMemberResult): string {
  if (!summary) return "No attendance record is available.";
  const regular = "Regular attendance: " + (summary.regularAttendance.rate === null ? "N/A" : String(summary.regularAttendance.rate) + "%") + " from " + (summary.regularAttendance.from ?? "the first eligible meeting") + " to " + summary.regularAttendance.to + ".";
  if (!summary.currentCompliances.length) return regular + " No assigned attendance policy.";
  const results = summary.currentCompliances.map((current) => {
    if (current.status === "no_rule") return (current.labelName ?? "Attendance policy") + ": no active attendance rule";
    const status = current.status === "not_applicable" ? "N/A" : current.status.replaceAll("_", " ");
    const result = current.ruleType === "weekly_count"
      ? String(current.attended) + " of " + String(current.threshold) + " meetings, " + status
      : (current.rate === null ? "N/A" : String(current.rate) + "%") + " against " + String(current.threshold) + "% required, " + status + "; excused meetings " + (current.excusedHandling === "count_missed" ? "count as missed" : "are excluded");
    return (current.labelName ?? "Attendance policy") + ": " + result + " from " + current.from + " to " + current.to;
  }).join(". ");
  const history = summary.historySummaries.map((item) => item.ruleType === "weekly_count" ? item.labelName + ": " + String(item.weeksMet) + "/" + String(item.weeksDue) + " weeks met" : item.labelName + ": " + (item.rate === null ? "N/A" : String(item.rate) + "% weighted") + ", excused meetings " + (item.excusedHandling === "count_missed" ? "count as missed" : "excluded")).join("; ");
  return regular + " " + results + ". Policy history: " + (history || "None") + ".";
}
function calendarAttendanceDetails(meeting: { required: number | boolean; attendanceWeight: number; notes?: string | null }, audience: string): string {
  const status = meeting.required ? "Required" : "Optional";
  const weight = meeting.required ? " (weight " + String(meeting.attendanceWeight) + ")" : "";
  return "Audience: " + audience + "\nAttendance: " + status + weight + (meeting.notes ? "\n\n" + meeting.notes : "");
}
async function attendanceExport(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const report = await policyReport(db, reportFilters(new URL(request.url))); const meetings = new Map(report.meetings.map((meeting) => [meeting.id, meeting]));
  const headers = ["meeting", "meetingStart", "meetingEnd", "audience", "required", "attendanceWeight", "memberId", "firstName", "lastName", "memberLabels", "disposition", "eligibility", "regularEligible", "regularWeight", "regularWeightedPresent", "regularRate", "regularAttended", "regularRequired", "regularFrom", "regularTo", "policyEligible", "policyWeight", "policyWeightedPresent", "policyLabel", "policyRuleType", "policyExcusedHandling", "policyStatus", "policyTarget", "policyAttended", "policyRequired", "policyRate", "policyFrom", "policyTo", "policyResults", "policyHistory", "weeklyTarget", "weekStartsOn", "weekSegmentStartsOn", "weekSegmentEndsOn", "checkedInAt", "checkedOutAt", "reason"];
  const labels = new Map(report.labels.map((label) => [label.id, label.name]));
  const rows: Record<string, unknown>[] = report.members.flatMap((item) => item.rows.flatMap((row) => { const meeting = meetings.get(row.meetingId); if (!meeting) return []; const date = policyLocalDate(meeting.startsAt, report.timeZone); const week = item.weeks.find((week) => week.segmentStartsOn <= date && date <= week.segmentEndsOn); const policy = item.currentCompliance; return [{ meeting: meeting.title, meetingStart: meeting.startsAt, meetingEnd: meeting.endsAt, audience: row.audience, required: Boolean(meeting.required), attendanceWeight: meeting.attendanceWeight, memberId: item.member.memberId, firstName: item.member.firstName, lastName: item.member.lastName, memberLabels: row.memberLabelIds.map((id) => labels.get(id) ?? "Retired label").join("; "), disposition: row.disposition, eligibility: row.eligibility, regularEligible: row.regularEligible, regularWeight: row.regularWeight, regularWeightedPresent: row.regularEligible && row.attended ? row.regularWeight : 0, regularRate: item.regularAttendance.rate ?? "", regularAttended: item.regularAttendance.attended, regularRequired: item.regularAttendance.required, regularFrom: item.regularAttendance.from ?? "", regularTo: item.regularAttendance.to, policyEligible: row.rateEligible, policyWeight: row.weight, policyWeightedPresent: row.rateEligible && row.attended ? row.weight : 0, policyLabel: policy.labelName ?? "", policyRuleType: policy.ruleType ?? "", policyExcusedHandling: policy.excusedHandling ?? "", policyStatus: policy.status, policyTarget: policy.threshold ?? "", policyAttended: policy.attended, policyRequired: policy.required, policyRate: policy.rate ?? "", policyFrom: policy.status === "no_rule" ? "" : policy.from, policyTo: policy.status === "no_rule" ? "" : policy.to, policyResults: JSON.stringify(item.currentCompliances), policyHistory: JSON.stringify(item.historySummaries), weeklyTarget: week?.target ?? "", weekStartsOn: week?.weekStartsOn ?? "", weekSegmentStartsOn: week?.segmentStartsOn ?? "", weekSegmentEndsOn: week?.segmentEndsOn ?? "", checkedInAt: row.checkedInAt, checkedOutAt: row.checkedOutAt, reason: row.reason }]; }));
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n") + "\r\n";
  await writeAudit(db, principal, "attendance.exported", "attendance", "csv", { filters: reportFilters(new URL(request.url)), rows: rows.length });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lancerlogin-attendance-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}
type IntegrationProvider = "google" | "resend" | "discord";
const integrationProviders = new Set<IntegrationProvider>(["google", "resend", "discord"]);
function providerFrom(pathname: string): IntegrationProvider {
  const provider = pathname.split("/")[3] as IntegrationProvider;
  if (!integrationProviders.has(provider)) throw new HttpError(404, "Integration provider not found");
  return provider;
}
function validateIntegration(provider: IntegrationProvider, input: Record<string, unknown>): Record<string, string> {
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
type IntegrationRecord = { id: string; ciphertext: string; iv: string; updatedAt: string; verifiedAt?: string | null; enabled?: number };
type IntegrationFlags = { googleEnabled?: number; resendEnabled?: number; discordEnabled?: number };
const integrationFlagColumns: Record<IntegrationProvider, keyof IntegrationFlags> = { google: "googleEnabled", resend: "resendEnabled", discord: "discordEnabled" };
const integrationFlagSqlColumns: Record<IntegrationProvider, string> = { google: "google_enabled", resend: "resend_enabled", discord: "discord_enabled" };
async function integrationFlags(env: Env): Promise<IntegrationFlags> {
  return await requireDatabase(env).prepare("SELECT google_enabled AS googleEnabled, resend_enabled AS resendEnabled, discord_enabled AS discordEnabled FROM installations WHERE id = 'primary'").first<IntegrationFlags>() ?? {};
}
async function integrationIsEnabled(env: Env, provider: IntegrationProvider): Promise<boolean> {
  const flags = await integrationFlags(env); return Boolean(flags[integrationFlagColumns[provider]]);
}
async function requireIntegrationEnabled(env: Env, provider: IntegrationProvider): Promise<void> {
  if (!await integrationIsEnabled(env, provider)) throw new HttpError(409, `${provider === "google" ? "Google OAuth" : provider === "resend" ? "Resend" : "Discord"} is disabled`);
}
async function integrationRecord(env: Env, provider: IntegrationProvider): Promise<IntegrationRecord | null> {
  return requireDatabase(env).prepare(`SELECT i.id, i.ciphertext, i.iv, i.updated_at AS updatedAt, i.verified_at AS verifiedAt, x.${integrationFlagSqlColumns[provider]} AS enabled FROM encrypted_integrations i JOIN installations x ON x.id = i.installation_id WHERE i.installation_id = 'primary' AND i.provider = ?`).bind(provider).first();
}
async function requireIntegrationConfigured(env: Env, provider: IntegrationProvider): Promise<void> {
  const record = await integrationRecord(env, provider);
  if (!record?.enabled || !record.verifiedAt) throw new HttpError(409, `${provider === "google" ? "Google OAuth" : provider === "resend" ? "Resend" : "Discord"} must be enabled and verified`);
}
type GoogleCalendarAuthorizationRecord = { ciphertext?: string | null; iv?: string | null; keyVersion?: number; authorizedAt?: string | null; verifiedAt?: string | null; updatedAt?: string | null; enabled?: number };
async function googleCalendarAuthorizationRecord(env: Env): Promise<GoogleCalendarAuthorizationRecord | null> {
  return requireDatabase(env).prepare("SELECT a.ciphertext, a.iv, a.key_version AS keyVersion, a.authorized_at AS authorizedAt, a.verified_at AS verifiedAt, a.updated_at AS updatedAt, x.google_calendar_enabled AS enabled FROM installations x LEFT JOIN google_calendar_authorizations a ON a.installation_id = x.id WHERE x.id = 'primary'").first<GoogleCalendarAuthorizationRecord>();
}
async function googleCalendarIntegrationStatus(env: Env) {
  const db = requireDatabase(env); const [record, queue] = await Promise.all([
    googleCalendarAuthorizationRecord(env),
    db.prepare("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, MAX(CASE WHEN status = 'failed' THEN last_error ELSE NULL END) AS lastError FROM google_calendar_operations WHERE installation_id = 'primary'").first<{ pending?: number; failed?: number; lastError?: string | null }>(),
  ]);
  let calendarName: string | undefined;
  if (record?.ciphertext && record.iv && env.INTEGRATION_KEY) try { calendarName = (await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY) as GoogleCalendarSecret).calendarLabel; } catch { /* Status must not expose or depend on secret values. */ }
  const enabled = Boolean(record?.enabled); const saved = Boolean(record?.ciphertext); const configured = enabled && Boolean(record?.verifiedAt);
  return { provider: "google_calendar" as const, enabled, saved, authorized: Boolean(record?.authorizedAt), configured, state: !enabled ? "disabled" as const : !saved ? "not_configured" as const : configured ? "configured" as const : "verification_required" as const, updatedAt: record?.updatedAt ?? undefined, verifiedAt: record?.verifiedAt ?? undefined, calendarName, pendingOperations: Number(queue?.pending ?? 0), failedOperations: Number(queue?.failed ?? 0), lastError: queue?.lastError ?? undefined };
}
async function discordCalendarQueueStatus(env: Env) {
  const queue = await requireDatabase(env).prepare("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, MAX(CASE WHEN status = 'failed' THEN last_error ELSE NULL END) AS lastError FROM discord_calendar_operations WHERE installation_id = 'primary'").first<{ pending?: number; failed?: number; lastError?: string | null }>();
  return { pendingOperations: Number(queue?.pending ?? 0), failedOperations: Number(queue?.failed ?? 0), lastError: queue?.lastError ?? undefined };
}
async function integrationsStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const [result, flags, calendar, discordCalendar, discordCommands] = await Promise.all([requireDatabase(env).prepare("SELECT i.provider, i.updated_at AS updatedAt, i.verified_at AS verifiedAt, EXISTS(SELECT 1 FROM integration_verification_challenges c WHERE c.installation_id = i.installation_id AND c.provider = i.provider AND c.expires_at > ?) AS verificationPending FROM encrypted_integrations i WHERE i.installation_id = 'primary' ORDER BY i.provider").bind(new Date().toISOString()).all<{ provider: IntegrationProvider; updatedAt: string; verifiedAt?: string | null; verificationPending: number }>(), integrationFlags(env), googleCalendarIntegrationStatus(env), discordCalendarQueueStatus(env), discordCommandStatus(env)]);
  const saved = new Map((result.results ?? []).map((item) => [item.provider, item]));
  return response({ integrations: [...[...integrationProviders].map((provider) => { const item = saved.get(provider); const enabled = Boolean(flags[integrationFlagColumns[provider]]); return { provider, enabled, saved: Boolean(item), configured: enabled && Boolean(item?.verifiedAt), state: !enabled ? "disabled" : !item ? "not_configured" : item.verifiedAt ? "configured" : "verification_required", updatedAt: item?.updatedAt, verifiedAt: item?.verifiedAt ?? undefined, verificationPending: enabled && Boolean(item?.verificationPending), ...(provider === "discord" ? { ...discordCalendar, ...discordCommands } : {}) }; }), calendar] });
}
async function discordChannelManagerSettings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") {
    const settings = await db.prepare("SELECT discord_channel_manager_enabled AS enabled, discord_contest_window_hours AS contestWindowHours FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number; contestWindowHours?: number }>();
    return response({ enabled: Boolean(settings?.enabled), contestWindowHours: settings?.contestWindowHours ?? 24 });
  }
  const input = await parseJson<DiscordChannelManagerInput>(request); const errors: string[] = [];
  if (typeof input.enabled !== "boolean") errors.push("Channel manager enabled must be true or false");
  if (!Number.isInteger(input.contestWindowHours) || input.contestWindowHours! < 1 || input.contestWindowHours! > 168) errors.push("Discord contest window must be from 1 to 168 hours");
  if (errors.length) throw new HttpError(400, "Invalid Discord channel manager settings", errors);
  await db.prepare("UPDATE organization_settings SET discord_channel_manager_enabled = ?, discord_contest_window_hours = ? WHERE installation_id = 'primary'").bind(input.enabled ? 1 : 0, input.contestWindowHours).run();
  await writeAudit(db, principal, "discord.channel_manager_updated", "integration", "discord", { enabled: input.enabled, contestWindowHours: input.contestWindowHours });
  return response({ enabled: input.enabled, contestWindowHours: input.contestWindowHours });
}
async function discordAnomalyReportSettings(request: Request, env: Env): Promise<Response> {
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
async function integrationCapabilities(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const flags = await integrationFlags(env);
  const records = await requireDatabase(env).prepare("SELECT provider, verified_at AS verifiedAt FROM encrypted_integrations WHERE installation_id = 'primary'").all<{ provider: IntegrationProvider; verifiedAt?: string | null }>();
  const verified = new Map((records.results ?? []).map((item) => [item.provider, Boolean(item.verifiedAt)]));
  const calendar = await googleCalendarAuthorizationRecord(env); const googleCalendarEnabled = Boolean(calendar?.enabled);
  return response({ integrations: { ...Object.fromEntries([...integrationProviders].map((provider) => [provider, { enabled: Boolean(flags[integrationFlagColumns[provider]]), configured: Boolean(flags[integrationFlagColumns[provider]]) && Boolean(verified.get(provider)) }])), google_calendar: { enabled: googleCalendarEnabled, configured: googleCalendarEnabled && Boolean(calendar?.verifiedAt) } } });
}
async function requireLocalAdminSignIn(db: D1Database): Promise<void> {
  const localAdmin = await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND role = 'admin' AND active = 1 AND password_hash IS NOT NULL LIMIT 1").first();
  if (!localAdmin) throw new HttpError(409, "Google OAuth cannot be disabled because no active Admin has a usable local sign-in");
}
async function integrationConfiguration(request: Request, env: Env, provider: IntegrationProvider): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "PATCH") {
    const input = await parseJson<{ enabled?: boolean }>(request); if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    if (provider === "google" && !input.enabled) await requireLocalAdminSignIn(db);
    const column = integrationFlagSqlColumns[provider]; const statements = [db.prepare(`UPDATE installations SET ${column} = ? WHERE id = 'primary'`).bind(input.enabled ? 1 : 0)];
    if (!input.enabled) statements.push(db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider));
    if (provider === "discord" && !input.enabled) statements.push(db.prepare("UPDATE organization_settings SET discord_anomaly_reports_enabled = 0, discord_anomaly_reports_enabled_at = NULL WHERE installation_id = 'primary'"));
    if (provider === "google") statements.push(db.prepare(`UPDATE installations SET auth_mode = CASE WHEN ? = 1 AND auth_mode = 'local' THEN 'both' WHEN ? = 0 AND auth_mode = 'both' THEN 'local' ELSE auth_mode END WHERE id = 'primary'`).bind(input.enabled ? 1 : 0, input.enabled ? 1 : 0));
    await db.batch(statements); await writeAudit(db, principal, input.enabled ? "integration.enabled" : "integration.disabled", "integration", provider);
    return response({ provider, enabled: input.enabled });
  }
  if (request.method === "DELETE") {
    if (provider === "google") await requireLocalAdminSignIn(db);
    await db.batch([db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider), db.prepare("DELETE FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = ?").bind(provider), db.prepare(`UPDATE installations SET ${integrationFlagSqlColumns[provider]} = 0 WHERE id = 'primary'`), ...(provider === "google" ? [db.prepare("UPDATE installations SET auth_mode = 'local' WHERE id = 'primary'")] : []), ...(provider === "discord" ? [db.prepare("UPDATE organization_settings SET discord_anomaly_reports_enabled = 0, discord_anomaly_reports_enabled_at = NULL WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_calendar_operations WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_calendar_event_mappings WHERE installation_id = 'primary'"), db.prepare("DELETE FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key LIKE 'calendar:%'")] : [])]);
    await writeAudit(db, principal, "integration.removed", "integration", provider); return response({ configured: false, provider });
  }
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const existing = await integrationRecord(env, provider); const secret = validateIntegration(provider, await parseJson<Record<string, unknown>>(request)); const encrypted = await encryptIntegration(secret, env.INTEGRATION_KEY); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES (?, 'primary', ?, ?, ?, NULL, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, verified_at = NULL, key_version = key_version + 1, updated_at = excluded.updated_at").bind(crypto.randomUUID(), provider, encrypted.ciphertext, encrypted.iv, now),
    db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider),
    ...(provider === "discord" ? [db.prepare("UPDATE organization_settings SET discord_anomaly_reports_enabled = 0, discord_anomaly_reports_enabled_at = NULL WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_calendar_operations WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_calendar_event_mappings WHERE installation_id = 'primary'"), db.prepare("DELETE FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key LIKE 'calendar:%'")] : []),
  ]);
  if (provider === "google" && await integrationIsEnabled(env, "google")) await db.prepare("UPDATE installations SET auth_mode = CASE WHEN auth_mode = 'local' THEN 'both' ELSE auth_mode END WHERE id = 'primary'").run();
  await writeAudit(db, principal, existing ? "integration.rotated" : "integration.saved", "integration", provider); return response({ saved: true, configured: false, created: !existing, provider, state: "verification_required", updatedAt: now });
}
async function markIntegrationVerified(db: D1Database, provider: IntegrationProvider, actorUserId: string | null, metadata: Record<string, unknown> = {}) {
  const now = new Date().toISOString(); await db.batch([
    db.prepare("UPDATE encrypted_integrations SET verified_at = ? WHERE installation_id = 'primary' AND provider = ?").bind(now, provider),
    db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider),
    ...(provider === "discord" ? [db.prepare("UPDATE discord_calendar_operations SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND status = 'failed'").bind(now, now)] : []),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'integration.verified', 'integration', ?, ?, ?)").bind(crypto.randomUUID(), actorUserId, provider, JSON.stringify(metadata), now),
  ]); return now;
}
async function startResendVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await requireIntegrationEnabled(env, "resend"); const db = requireDatabase(env); const input = await parseJson<{ email?: string }>(request); const target = input.email?.trim().toLowerCase();
  if (!target || !validEmail(target)) throw new HttpError(400, "Enter a valid email address that you can open now");
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured"); const record = await integrationRecord(env, "resend"); if (!record) throw new HttpError(404, "Save Resend credentials before verification"); const secret = await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
  const digits = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000; const code = digits.toString().padStart(6, "0"); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const result = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${secret.apiKey}`, "content-type": "application/json", "idempotency-key": `lancerlogin-verify-${crypto.randomUUID()}` }, body: JSON.stringify({ from: secret.fromEmail, to: [target], subject: "Your LancerLogin verification code", text: `Your LancerLogin verification code is ${code}. It expires in 10 minutes.`, html: `<p>Your LancerLogin verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p>` }) });
  if (!result.ok) throw new HttpError(502, "Resend could not deliver the verification email"); const body = await result.json().catch(() => ({})) as { id?: string };
  await db.prepare("INSERT INTO integration_verification_challenges (installation_id, provider, challenge_hash, target, external_id, expires_at, created_by, created_at) VALUES ('primary', 'resend', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET challenge_hash = excluded.challenge_hash, target = excluded.target, external_id = excluded.external_id, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = excluded.created_at").bind(await sha256(code), target, body.id ?? null, expiresAt, principal.userId, now.toISOString()).run();
  await writeAudit(db, principal, "integration.verification_started", "integration", "resend", { target, deliveryId: body.id ?? null }); return response({ provider: "resend", verificationPending: true, expiresAt, target }, 202);
}
async function completeResendVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await requireIntegrationEnabled(env, "resend"); const db = requireDatabase(env); const input = await parseJson<{ code?: string }>(request); const code = input.code?.trim();
  if (!code || !/^\d{6}$/.test(code)) throw new HttpError(400, "Enter the six-digit code from the verification email");
  const challenge = await db.prepare("SELECT challenge_hash AS challengeHash, target, expires_at AS expiresAt FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'resend'").first<{ challengeHash: string; target: string; expiresAt: string }>();
  if (!challenge || challenge.expiresAt <= new Date().toISOString() || challenge.challengeHash !== await sha256(code)) throw new HttpError(400, "The verification code is invalid or expired");
  const verifiedAt = await markIntegrationVerified(db, "resend", principal.userId, { target: challenge.target }); return response({ provider: "resend", configured: true, state: "configured", verifiedAt });
}
async function googleCredentials(env: Env): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "google"); if (!record || record.enabled === 0) throw new HttpError(503, "Google OAuth is not enabled");
  return decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
}
function googleRedirectUri(env: Env): string {
  const origin = new URL(env.ALLOWED_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.ALLOWED_ORIGIN) throw new HttpError(503, "Public dashboard origin is invalid");
  return `${origin.origin}/api/auth/google/callback`;
}
async function googleStart(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const verification = new URL(request.url).searchParams.get("verify") === "1";
  if (verification) await requireRole(request, env, ["admin"]);
  const installation = await requireDatabase(env).prepare("SELECT auth_mode AS authMode FROM installations WHERE id = 'primary'").first<{ authMode: AuthMode }>();
  if (!installation || !["google", "both"].includes(installation.authMode)) throw new HttpError(404, "Google sign-in is not enabled");
  const credentials = await googleCredentials(env); const redirectUri = googleRedirectUri(env);
  const state = await createSessionCodec(env.SESSION_KEY).issue({ userId: crypto.randomUUID(), role: "operator" }, 10 * 60_000);
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" }).toString();
  const headers = new Headers({ location: target.toString(), "cache-control": "no-store" });
  headers.append("set-cookie", `lancerlogin_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  if (verification) headers.append("set-cookie", "lancerlogin_oauth_verify=1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600");
  return new Response(null, { status: 302, headers });
}
async function googleCallback(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const url = new URL(request.url); const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); const savedState = cookie(request, "lancerlogin_oauth_state");
  if (!code || !state || state !== savedState || !await createSessionCodec(env.SESSION_KEY).verify(state)) throw new HttpError(400, "Google sign-in state is invalid or expired");
  const credentials = await googleCredentials(env); const redirectUri = googleRedirectUri(env);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: credentials.clientId, client_secret: credentials.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
  const tokens = await tokenResponse.json() as { id_token?: string }; if (!tokenResponse.ok || !tokens.id_token) throw new HttpError(401, "Google did not accept the sign-in response");
  const validationResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`, { headers: { accept: "application/json" } });
  const profile = await validationResponse.json() as { aud?: string; email?: string; email_verified?: string; iss?: string };
  if (!validationResponse.ok || profile.aud !== credentials.clientId || profile.email_verified !== "true" || !profile.email || !["https://accounts.google.com", "accounts.google.com"].includes(profile.iss ?? "")) throw new HttpError(401, "Google identity validation failed");
  const user = await requireDatabase(env).prepare("SELECT id, role FROM users WHERE installation_id = 'primary' AND email = ? AND active = 1").bind(profile.email.toLowerCase()).first<{ id: string; role: Role }>();
  if (!user) throw new HttpError(403, "This Google account is not an active LancerLogin user");
  await markIntegrationVerified(requireDatabase(env), "google", user.id, { email: profile.email.toLowerCase() });
  const session = await createSessionCodec(env.SESSION_KEY).issue({ userId: user.id, role: user.role });
  const verification = cookie(request, "lancerlogin_oauth_verify") === "1";
  const headers = new Headers({ location: verification ? `${env.ALLOWED_ORIGIN}/settings/integrations?verified=google` : env.ALLOWED_ORIGIN, "cache-control": "no-store" });
  headers.append("set-cookie", `lancerlogin_session=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
  headers.append("set-cookie", "lancerlogin_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  headers.append("set-cookie", "lancerlogin_oauth_verify=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}

function googleCalendarRedirectUri(env: Env): string {
  const origin = new URL(env.ALLOWED_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.ALLOWED_ORIGIN) throw new HttpError(503, "Public dashboard origin is invalid");
  return `${origin.origin}/api/admin/integrations/google-calendar/callback`;
}
async function googleCalendarSecret(env: Env, requireVerified = false): Promise<{ record: GoogleCalendarAuthorizationRecord; secret: GoogleCalendarSecret }> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await googleCalendarAuthorizationRecord(env);
  if (!record?.enabled) throw new HttpError(409, "Google Calendar is disabled");
  if (!record.ciphertext || !record.iv) throw new HttpError(409, "Save Google Calendar OAuth credentials first");
  if (requireVerified && !record.verifiedAt) throw new HttpError(409, "Google Calendar must be authorized and a writable calendar selected");
  return { record, secret: await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY) as GoogleCalendarSecret };
}
function googleCalendarRetryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 3_600_000) : undefined;
}
async function googleCalendarProviderRequest(accessToken: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> }> {
  const result = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { ...init, headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  const body = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (result.ok) return { response: result, body };
  if (result.status === 401) throw new GoogleCalendarProviderError(401, "Google Calendar authorization needs to be renewed.", false);
  if (result.status === 403 || result.status === 429) throw new GoogleCalendarProviderError(result.status, "Google Calendar is rate limiting or denying this request. Check the selected calendar and try again.", true, googleCalendarRetryAfter(result));
  if (result.status >= 500) throw new GoogleCalendarProviderError(result.status, "Google Calendar is temporarily unavailable. LancerLogin will retry automatically.", true, googleCalendarRetryAfter(result));
  throw new GoogleCalendarProviderError(result.status, `Google Calendar rejected the request (${result.status}). Check the Calendar connection.`, false);
}
async function googleCalendarAccessToken(env: Env, requireVerified = false): Promise<{ accessToken: string; secret: GoogleCalendarSecret }> {
  const { secret } = await googleCalendarSecret(env, requireVerified);
  if (!secret.refreshToken) throw new HttpError(409, "Authorize Google Calendar before selecting a calendar");
  const result = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: secret.clientId, client_secret: secret.clientSecret, refresh_token: secret.refreshToken, grant_type: "refresh_token" }) });
  const body = await result.json().catch(() => ({})) as { access_token?: string };
  if (!result.ok || !body.access_token) {
    if (result.status >= 500 || result.status === 429) throw new GoogleCalendarProviderError(result.status, "Google authorization is temporarily unavailable. LancerLogin will retry automatically.", true, googleCalendarRetryAfter(result));
    throw new GoogleCalendarProviderError(result.status, "Google Calendar authorization needs to be renewed.", false);
  }
  return { accessToken: body.access_token, secret };
}
async function googleCalendarConfiguration(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "PATCH") {
    const input = await parseJson<{ enabled?: boolean }>(request);
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    await db.prepare("UPDATE installations SET google_calendar_enabled = ? WHERE id = 'primary'").bind(input.enabled ? 1 : 0).run();
    await writeAudit(db, principal, input.enabled ? "google_calendar.enabled" : "google_calendar.disabled", "integration", "google_calendar");
    return response({ provider: "google_calendar", enabled: input.enabled });
  }
  if (request.method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM google_calendar_operations WHERE installation_id = 'primary'"),
      db.prepare("DELETE FROM google_calendar_event_mappings WHERE installation_id = 'primary'"),
      db.prepare("DELETE FROM google_calendar_authorizations WHERE installation_id = 'primary'"),
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
  const encrypted = await encryptIntegration({ clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim(), ...(prior?.calendarId ? { calendarId: prior.calendarId, calendarLabel: prior.calendarLabel } : {}) }, env.INTEGRATION_KEY); const now = new Date().toISOString();
  await db.prepare("INSERT INTO google_calendar_authorizations (installation_id, ciphertext, iv, key_version, authorized_at, verified_at, updated_at) VALUES ('primary', ?, ?, 1, NULL, NULL, ?) ON CONFLICT(installation_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = google_calendar_authorizations.key_version + 1, authorized_at = NULL, verified_at = NULL, updated_at = excluded.updated_at").bind(encrypted.ciphertext, encrypted.iv, now).run();
  await writeAudit(db, principal, existing?.ciphertext ? "google_calendar.rotated" : "google_calendar.saved", "integration", "google_calendar");
  return response({ provider: "google_calendar", saved: true, configured: false, created: !existing?.ciphertext, state: "verification_required", updatedAt: now });
}
async function googleCalendarStart(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const principal = await requireRole(request, env, ["admin"]); const { secret } = await googleCalendarSecret(env); const state = await createSessionCodec(env.SESSION_KEY).issue(principal, 10 * 60_000); const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({ client_id: secret.clientId, redirect_uri: googleCalendarRedirectUri(env), response_type: "code", scope: "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events", access_type: "offline", include_granted_scopes: "true", prompt: "consent select_account", state }).toString();
  const headers = new Headers({ location: target.toString(), "cache-control": "no-store" }); headers.append("set-cookie", `lancerlogin_calendar_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  return new Response(null, { status: 302, headers });
}
const writableCalendarRole = (value: unknown) => value === "writer" || value === "owner";
async function googleCalendarCallback(request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY || !env.INTEGRATION_KEY) throw new HttpError(503, "Google Calendar authorization is not configured");
  const url = new URL(request.url); const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); const savedState = cookie(request, "lancerlogin_calendar_oauth_state"); const signed = state ? await createSessionCodec(env.SESSION_KEY).verify(state) : undefined;
  if (!code || !state || state !== savedState || !signed) throw new HttpError(400, "Google Calendar authorization state is invalid or expired");
  const principal = await requireDatabase(env).prepare("SELECT id AS userId, role FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1 AND role = 'admin'").bind(signed.userId).first<{ userId: string; role: Role }>();
  if (!principal) throw new HttpError(403, "Only an active Admin can authorize Google Calendar");
  const { secret } = await googleCalendarSecret(env); const result = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: secret.clientId, client_secret: secret.clientSecret, redirect_uri: googleCalendarRedirectUri(env), grant_type: "authorization_code" }) });
  const tokens = await result.json().catch(() => ({})) as { access_token?: string; refresh_token?: string };
  if (!result.ok || !tokens.access_token || !(tokens.refresh_token || secret.refreshToken)) throw new HttpError(401, "Google did not return durable Calendar access. Try authorizing again and approve Calendar access.");
  const next: GoogleCalendarSecret = { ...secret, refreshToken: tokens.refresh_token ?? secret.refreshToken }; let verifiedAt: string | null = null;
  if (next.calendarId) try { const { body } = await googleCalendarProviderRequest(tokens.access_token, `/users/me/calendarList/${encodeURIComponent(next.calendarId)}`); if (writableCalendarRole(body.accessRole)) { next.calendarLabel = String(body.summary ?? next.calendarLabel ?? "Selected calendar").slice(0, 200); verifiedAt = new Date().toISOString(); } } catch { /* The Admin can choose another writable calendar after return. */ }
  const encrypted = await encryptIntegration(next, env.INTEGRATION_KEY); const now = new Date().toISOString(); const db = requireDatabase(env);
  await db.batch([
    db.prepare("UPDATE google_calendar_authorizations SET ciphertext = ?, iv = ?, authorized_at = ?, verified_at = ?, updated_at = ? WHERE installation_id = 'primary'").bind(encrypted.ciphertext, encrypted.iv, now, verifiedAt, now),
    ...(verifiedAt ? [db.prepare("UPDATE google_calendar_operations SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND status = 'failed'").bind(now, now)] : []),
  ]);
  await writeAudit(db, { ...signed, role: "admin" }, "google_calendar.authorized", "integration", "google_calendar", { calendarReverified: Boolean(verifiedAt) });
  const headers = new Headers({ location: `${env.ALLOWED_ORIGIN}/settings/integrations?${verifiedAt ? "verified" : "authorized"}=google-calendar`, "cache-control": "no-store" }); headers.append("set-cookie", "lancerlogin_calendar_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
async function listGoogleCalendars(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]); const { accessToken } = await googleCalendarAccessToken(env); const { body } = await googleCalendarProviderRequest(accessToken, "/users/me/calendarList?minAccessRole=writer&showHidden=false&maxResults=250");
  const items = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
  return response({ calendars: items.filter((item) => writableCalendarRole(item.accessRole) && typeof item.id === "string").map((item) => ({ id: String(item.id), name: String(item.summary ?? "Writable calendar").slice(0, 200), primary: Boolean(item.primary), accessRole: item.accessRole })) });
}
async function selectGoogleCalendar(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ calendarId?: string }>(request); const calendarId = input.calendarId?.trim();
  if (!calendarId || calendarId.length > 1_024) throw new HttpError(400, "Choose one writable Google Calendar");
  const { accessToken, secret } = await googleCalendarAccessToken(env); const { body } = await googleCalendarProviderRequest(accessToken, `/users/me/calendarList/${encodeURIComponent(calendarId)}`);
  if (!writableCalendarRole(body.accessRole)) throw new HttpError(400, "Choose a Google Calendar where this account can edit events");
  const changed = Boolean(secret.calendarId && secret.calendarId !== calendarId); const next = { ...secret, calendarId, calendarLabel: String(body.summary ?? "Selected calendar").slice(0, 200) }; const encrypted = await encryptIntegration(next, env.INTEGRATION_KEY!); const now = new Date().toISOString(); const db = requireDatabase(env);
  await db.batch([
    ...(changed ? [db.prepare("DELETE FROM google_calendar_operations WHERE installation_id = 'primary'"), db.prepare("DELETE FROM google_calendar_event_mappings WHERE installation_id = 'primary'")] : []),
    db.prepare("UPDATE google_calendar_authorizations SET ciphertext = ?, iv = ?, verified_at = ?, updated_at = ? WHERE installation_id = 'primary'").bind(encrypted.ciphertext, encrypted.iv, now, now),
    db.prepare("UPDATE google_calendar_operations SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND status = 'failed'").bind(now, now),
  ]);
  await writeAudit(db, principal, "google_calendar.selected", "integration", "google_calendar", { calendarChanged: changed });
  return response({ provider: "google_calendar", configured: true, calendarName: next.calendarLabel, verifiedAt: now });
}
type GoogleCalendarSyncSummary = { synced: number; queued: number; failed: number };
type GoogleCalendarOperation = { meetingId: string; eventId: string; action: "upsert" | "delete"; startsAt?: string | null; endsAt?: string | null; status: "pending" | "delivered" | "failed"; attempts: number; syncedAt?: string | null; generation?: number | null };
async function googleCalendarEventId(meetingId: string, generation: number): Promise<string> { return `ll${(await sha256Hex(`google-calendar:primary:${meetingId}:${generation}`)).slice(0, 48)}`; }
async function googleCalendarIsReady(env: Env): Promise<boolean> { const record = await googleCalendarAuthorizationRecord(env); return Boolean(record?.enabled && record.verifiedAt); }
const googleCalendarEmptySummary = (): GoogleCalendarSyncSummary => ({ synced: 0, queued: 0, failed: 0 });
async function bestEffortGoogleCalendar(action: () => Promise<GoogleCalendarSyncSummary>): Promise<GoogleCalendarSyncSummary> {
  try { return await action(); } catch { return { synced: 0, queued: 0, failed: 1 }; }
}
async function enqueueGoogleCalendarCreate(db: D1Database, env: Env, meetingIds: string[]): Promise<GoogleCalendarSyncSummary> {
  if (!meetingIds.length || !await googleCalendarIsReady(env)) return googleCalendarEmptySummary();
  const now = new Date().toISOString(); const eventIds: string[] = [];
  for (const meetingId of meetingIds) {
    const meeting = await db.prepare("SELECT id, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ id: string; startsAt: string; endsAt: string }>();
    if (!meeting) continue;
    const eventId = await googleCalendarEventId(meeting.id, 1); eventIds.push(eventId);
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO google_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) VALUES ('primary', ?, ?, 1, 1, ?)").bind(meeting.id, eventId, now),
      db.prepare("INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) VALUES ('primary', ?, ?, 'upsert', ?, ?, 'pending', 0, ?, ?) ON CONFLICT(installation_id, event_id) DO UPDATE SET action = 'upsert', starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = 'pending', next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at").bind(meeting.id, eventId, meeting.startsAt, meeting.endsAt, now, now),
    ]);
  }
  return eventIds.length ? processGoogleCalendarOperations(env, eventIds) : googleCalendarEmptySummary();
}
async function enqueueGoogleCalendarUpdate(db: D1Database, env: Env, meetingIds: string[]): Promise<GoogleCalendarSyncSummary> {
  const now = new Date().toISOString(); const eventIds: string[] = [];
  for (const meetingId of meetingIds) {
    const mapped = await db.prepare("SELECT m.event_id AS eventId, mt.starts_at AS startsAt, mt.ends_at AS endsAt FROM google_calendar_event_mappings m JOIN meetings mt ON mt.installation_id = m.installation_id AND mt.id = m.meeting_id WHERE m.installation_id = 'primary' AND m.meeting_id = ? AND m.active = 1 AND mt.deleted_at IS NULL").bind(meetingId).first<{ eventId: string; startsAt: string; endsAt: string }>();
    if (!mapped) continue; eventIds.push(mapped.eventId);
    await db.prepare("INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) VALUES ('primary', ?, ?, 'upsert', ?, ?, 'pending', 0, ?, ?) ON CONFLICT(installation_id, event_id) DO UPDATE SET action = 'upsert', starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = 'pending', next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at").bind(meetingId, mapped.eventId, mapped.startsAt, mapped.endsAt, now, now).run();
  }
  return eventIds.length && await googleCalendarIsReady(env) ? processGoogleCalendarOperations(env, eventIds) : { synced: 0, queued: eventIds.length, failed: 0 };
}
async function enqueueGoogleCalendarDelete(db: D1Database, env: Env, meetingIds: string[]): Promise<GoogleCalendarSyncSummary> {
  const now = new Date().toISOString(); const eventIds: string[] = [];
  for (const meetingId of meetingIds) {
    const mapped = await db.prepare("SELECT event_id AS eventId FROM google_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ?").bind(meetingId).first<{ eventId: string }>();
    if (!mapped) continue; eventIds.push(mapped.eventId);
    await db.batch([
      db.prepare("UPDATE google_calendar_event_mappings SET active = 0, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(now, meetingId),
      db.prepare("INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) VALUES ('primary', ?, ?, 'delete', NULL, NULL, 'pending', 0, ?, ?) ON CONFLICT(installation_id, event_id) DO UPDATE SET action = 'delete', starts_at = NULL, ends_at = NULL, status = 'pending', next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at").bind(meetingId, mapped.eventId, now, now),
    ]);
  }
  return eventIds.length && await googleCalendarIsReady(env) ? processGoogleCalendarOperations(env, eventIds) : { synced: 0, queued: eventIds.length, failed: 0 };
}
async function enqueueGoogleCalendarRestore(db: D1Database, env: Env, meetingIds: string[]): Promise<GoogleCalendarSyncSummary> {
  const now = new Date().toISOString(); const eventIds: string[] = [];
  for (const meetingId of meetingIds) {
    const mapped = await db.prepare("SELECT m.generation, mt.starts_at AS startsAt, mt.ends_at AS endsAt FROM google_calendar_event_mappings m JOIN meetings mt ON mt.installation_id = m.installation_id AND mt.id = m.meeting_id WHERE m.installation_id = 'primary' AND m.meeting_id = ? AND mt.deleted_at IS NULL").bind(meetingId).first<{ generation: number; startsAt: string; endsAt: string }>();
    if (!mapped) continue; const generation = Number(mapped.generation) + 1; const eventId = await googleCalendarEventId(meetingId, generation); eventIds.push(eventId);
    await db.batch([
      db.prepare("UPDATE google_calendar_event_mappings SET event_id = ?, generation = ?, active = 1, synced_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(eventId, generation, now, meetingId),
      db.prepare("INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) VALUES ('primary', ?, ?, 'upsert', ?, ?, 'pending', 0, ?, ?)").bind(meetingId, eventId, mapped.startsAt, mapped.endsAt, now, now),
    ]);
  }
  return eventIds.length && await googleCalendarIsReady(env) ? processGoogleCalendarOperations(env, eventIds) : { synced: 0, queued: eventIds.length, failed: 0 };
}
function googleCalendarOperationPath(calendarId: string, eventId?: string): string { return `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`; }
function googleCalendarRetryAt(attempts: number, error: GoogleCalendarProviderError): string | null {
  if (!error.retryable) return null;
  const backoff = Math.min(3_600_000, Math.max(60_000, 2 ** Math.min(attempts, 12) * 1_000, error.retryAfterMs ?? 0));
  return new Date(Date.now() + backoff).toISOString();
}
async function markGoogleCalendarOperationFailure(db: D1Database, operation: GoogleCalendarOperation, error: unknown): Promise<void> {
  const providerError = error instanceof GoogleCalendarProviderError ? error : new GoogleCalendarProviderError(503, "Google Calendar is temporarily unavailable. LancerLogin will retry automatically.", true); const now = new Date().toISOString(); const attempts = Number(operation.attempts ?? 0) + 1; const nextAttemptAt = googleCalendarRetryAt(attempts, providerError);
  await db.batch([
    db.prepare("UPDATE google_calendar_operations SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND event_id = ?").bind(attempts, nextAttemptAt, providerError.message.slice(0, 300), now, operation.eventId),
    db.prepare("UPDATE google_calendar_event_mappings SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND event_id = ?").bind(providerError.message.slice(0, 300), now, operation.meetingId, operation.eventId),
  ]);
}
async function replaceMissingGoogleCalendarEvent(db: D1Database, operation: GoogleCalendarOperation): Promise<string> {
  const generation = Number(operation.generation ?? 1) + 1; const eventId = await googleCalendarEventId(operation.meetingId, generation); const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE google_calendar_operations SET status = 'delivered', next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND event_id = ?").bind(now, operation.eventId),
    db.prepare("UPDATE google_calendar_event_mappings SET event_id = ?, generation = ?, synced_at = NULL, last_error = NULL, active = 1, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND event_id = ?").bind(eventId, generation, now, operation.meetingId, operation.eventId),
    db.prepare("INSERT INTO google_calendar_operations (installation_id, meeting_id, event_id, action, starts_at, ends_at, status, attempts, next_attempt_at, updated_at) VALUES ('primary', ?, ?, 'upsert', ?, ?, 'pending', 0, ?, ?)").bind(operation.meetingId, eventId, operation.startsAt, operation.endsAt, now, now),
  ]);
  return eventId;
}
async function processGoogleCalendarOperations(env: Env, eventIds?: string[]): Promise<GoogleCalendarSyncSummary> {
  if (!await googleCalendarIsReady(env)) return googleCalendarEmptySummary();
  const db = requireDatabase(env); const now = new Date().toISOString(); const filter = eventIds?.length ? `AND o.event_id IN (${eventIds.map(() => "?").join(",")})` : "AND (o.status = 'pending' OR (o.status = 'failed' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at <= ?))"; const values = eventIds?.length ? eventIds : [now];
  const result = await db.prepare(`SELECT o.meeting_id AS meetingId, o.event_id AS eventId, o.action, o.starts_at AS startsAt, o.ends_at AS endsAt, o.status, o.attempts, m.synced_at AS syncedAt, m.generation FROM google_calendar_operations o LEFT JOIN google_calendar_event_mappings m ON m.installation_id = o.installation_id AND m.meeting_id = o.meeting_id AND m.event_id = o.event_id WHERE o.installation_id = 'primary' ${filter} ORDER BY o.updated_at LIMIT 50`).bind(...values).all<GoogleCalendarOperation>();
  const operations = result.results ?? []; if (!operations.length) return googleCalendarEmptySummary();
  let accessToken: string; let secret: GoogleCalendarSecret;
  try { ({ accessToken, secret } = await googleCalendarAccessToken(env, true)); }
  catch (error) { for (const operation of operations) await markGoogleCalendarOperationFailure(db, operation, error); return { synced: 0, queued: 0, failed: operations.length }; }
  if (!secret.calendarId) return { synced: 0, queued: operations.length, failed: 0 };
  let synced = 0; let queued = 0; let failed = 0;
  for (const operation of operations) {
    try {
      if (operation.action === "delete") {
        try { await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId, operation.eventId), { method: "DELETE" }); }
        catch (error) { if (!(error instanceof GoogleCalendarProviderError) || ![404, 410].includes(error.providerStatus)) throw error; }
      } else {
        const meeting = await db.prepare("SELECT title, notes, required, attendance_weight AS attendanceWeight FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(operation.meetingId).first<{ title: string; notes: string | null; required: number; attendanceWeight: number }>();
        if (!meeting) throw new GoogleCalendarProviderError(409, "The meeting is no longer available for calendar sync", false);
        const timing = { summary: meeting.title, description: calendarAttendanceDetails(meeting, await meetingAudienceText(db, operation.meetingId)), start: { dateTime: operation.startsAt }, end: { dateTime: operation.endsAt } };
        if (operation.syncedAt) {
          try { await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId, operation.eventId), { method: "PATCH", body: JSON.stringify(timing) }); }
          catch (error) { if (error instanceof GoogleCalendarProviderError && [404, 410].includes(error.providerStatus)) { await replaceMissingGoogleCalendarEvent(db, operation); queued += 1; continue; } throw error; }
        } else {
          try { await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId), { method: "POST", body: JSON.stringify({ id: operation.eventId, ...timing }) }); }
          catch (error) { if (error instanceof GoogleCalendarProviderError && error.providerStatus === 409) await googleCalendarProviderRequest(accessToken, googleCalendarOperationPath(secret.calendarId, operation.eventId), { method: "PATCH", body: JSON.stringify(timing) }); else throw error; }
        }
      }
      const completedAt = new Date().toISOString(); await db.batch([
        db.prepare("UPDATE google_calendar_operations SET status = 'delivered', attempts = attempts + 1, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND event_id = ?").bind(completedAt, operation.eventId),
        db.prepare("UPDATE google_calendar_event_mappings SET synced_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND event_id = ?").bind(completedAt, completedAt, operation.meetingId, operation.eventId),
      ]); synced += 1;
    } catch (error) { await markGoogleCalendarOperationFailure(db, operation, error); failed += 1; }
  }
  return { synced, queued, failed };
}
async function retryGoogleCalendarOperations(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await googleCalendarSecret(env, true); const db = requireDatabase(env); const now = new Date().toISOString();
  await db.prepare("UPDATE google_calendar_operations SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND status = 'failed'").bind(now, now).run();
  const result = await processGoogleCalendarOperations(env); await writeAudit(db, principal, "google_calendar.retry_requested", "integration", "google_calendar", result); return response(result);
}
const addCalendarSummaries = (...summaries: GoogleCalendarSyncSummary[]): GoogleCalendarSyncSummary => summaries.reduce((total, item) => ({ synced: total.synced + item.synced, queued: total.queued + item.queued, failed: total.failed + item.failed }), googleCalendarEmptySummary());
async function syncGoogleCalendarMeetings(db: D1Database, env: Env, meetingIds: string[]): Promise<GoogleCalendarSyncSummary> {
  const updates: string[] = []; const creates: string[] = []; const ready = await googleCalendarIsReady(env);
  for (const meetingId of meetingIds) {
    const mapping = await db.prepare("SELECT active FROM google_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ?").bind(meetingId).first<{ active?: number }>();
    if (mapping?.active) updates.push(meetingId); else if (!mapping && ready) creates.push(meetingId);
  }
  const updateSummary = await enqueueGoogleCalendarUpdate(db, env, updates);
  const createSummary = await enqueueGoogleCalendarCreate(db, env, creates);
  return addCalendarSummaries(updateSummary, createSummary);
}
async function restoreGoogleCalendarMeetings(db: D1Database, env: Env, meetingIds: string[]): Promise<GoogleCalendarSyncSummary> {
  const restored = await enqueueGoogleCalendarRestore(db, env, meetingIds); if (!await googleCalendarIsReady(env)) return restored;
  const unmapped: string[] = [];
  for (const meetingId of meetingIds) if (!await db.prepare("SELECT generation FROM google_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ?").bind(meetingId).first()) unmapped.push(meetingId);
  return addCalendarSummaries(restored, await enqueueGoogleCalendarCreate(db, env, unmapped));
}
async function syncAllGoogleCalendarMeetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await googleCalendarSecret(env, true); const db = requireDatabase(env);
  const meetings = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL ORDER BY starts_at ASC LIMIT 100").all<{ id: string }>();
  const result = await syncGoogleCalendarMeetings(db, env, (meetings.results ?? []).map((meeting) => meeting.id));
  await writeAudit(db, principal, "google_calendar.sync_all_requested", "integration", "google_calendar", { selected: meetings.results?.length ?? 0, ...result });
  return response({ ...result, selected: meetings.results?.length ?? 0, limit: 100 });
}
async function users(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT u.id, u.email, u.local_username AS localUsername, u.member_id AS memberId, u.role, u.active, u.created_at AS createdAt, m.external_id AS memberExternalId, m.first_name AS memberFirstName, m.last_name AS memberLastName FROM users u LEFT JOIN members m ON m.installation_id = u.installation_id AND m.id = u.member_id WHERE u.installation_id = 'primary' ORDER BY u.created_at").all(); return response({ users: result.results ?? [] }); }
  const input = await parseJson<{ email?: string | null; localUsername?: string | null; localPassword?: string; role?: Role; memberId?: string | null }>(request);
  const email = input.email?.trim().toLowerCase() || null; const username = input.localUsername?.trim().toLowerCase() || null;
  if (!email && !username) throw new HttpError(400, "An email or local username is required");
  if (email && !validEmail(email)) throw new HttpError(400, "Email is invalid");
  if (username && !/^[a-z0-9._-]{3,64}$/.test(username)) throw new HttpError(400, "Local username must be 3–64 letters, numbers, dots, underscores, or hyphens");
  if (!input.role || !["admin", "operator"].includes(input.role)) throw new HttpError(400, "Role must be admin or operator");
  if (username && (input.localPassword?.length ?? 0) < 12) throw new HttpError(400, "A local user needs a password of at least 12 characters");
  const memberId = input.memberId?.trim() || null;
  if (memberId && !await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND id = ?").bind(memberId).first()) throw new HttpError(400, "Linked roster member was not found");
  if (memberId && await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND member_id = ?").bind(memberId).first()) throw new HttpError(409, "That roster member already has dashboard access");
  const duplicate = await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND ((email IS NOT NULL AND email = ?) OR (local_username IS NOT NULL AND local_username = ?))").bind(email, username).first();
  if (duplicate) throw new HttpError(409, "That email or username is already in use");
  const id = crypto.randomUUID(); const now = new Date().toISOString(); const passwordHash = username ? await hashPassword(input.localPassword!) : null;
  await db.batch([
    db.prepare("INSERT INTO users (id, installation_id, email, local_username, password_hash, member_id, role, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, email, username, passwordHash, memberId, input.role, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'user.created', 'user', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ role: input.role, hasGoogle: Boolean(email), hasLocal: Boolean(username), memberId }), now),
  ]);
  return response({ user: { id, email, localUsername: username, memberId, role: input.role, active: true, createdAt: now } }, 201);
}
async function updateUser(request: Request, env: Env, userId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ role?: Role; active?: boolean; localPassword?: string; memberId?: string | null }>(request);
  const target = await db.prepare("SELECT id, role, active, local_username AS localUsername FROM users WHERE installation_id = 'primary' AND id = ?").bind(userId).first<{ id: string; role: Role; active: number; localUsername?: string }>();
  if (!target) throw new HttpError(404, "User not found");
  if (userId === principal.userId && ((input.role && input.role !== "admin") || input.active === false)) throw new HttpError(409, "You cannot demote or deactivate your current Admin account");
  if (input.role && !["admin", "operator"].includes(input.role)) throw new HttpError(400, "Role must be admin or operator");
  if (input.localPassword && (!target.localUsername || input.localPassword.length < 12)) throw new HttpError(400, "Password reset requires a local username and at least 12 characters");
  if (input.memberId !== undefined && input.memberId !== null && (!input.memberId.trim() || !await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND id = ?").bind(input.memberId.trim()).first())) throw new HttpError(400, "Linked roster member was not found");
  if (input.memberId && await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND member_id = ? AND id <> ?").bind(input.memberId.trim(), userId).first()) throw new HttpError(409, "That roster member already has dashboard access");
  if (input.role === undefined && input.active === undefined && input.localPassword === undefined && input.memberId === undefined) throw new HttpError(400, "Provide a role, active status, roster link, or new local password");
  const passwordHash = input.localPassword ? await hashPassword(input.localPassword) : null; const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE users SET role = COALESCE(?, role), active = COALESCE(?, active), password_hash = COALESCE(?, password_hash), member_id = CASE WHEN ? = 1 THEN ? ELSE member_id END WHERE installation_id = 'primary' AND id = ?").bind(input.role ?? null, input.active === undefined ? null : input.active ? 1 : 0, passwordHash, input.memberId === undefined ? 0 : 1, input.memberId?.trim() || null, userId),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'user.updated', 'user', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, userId, JSON.stringify({ role: input.role, active: input.active, passwordReset: Boolean(input.localPassword), memberId: input.memberId }), now),
  ]);
  return response({ ok: true });
}
function html(value: unknown): string { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
async function resendConfiguration(env: Env): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "resend"); if (!record || record.enabled === 0) throw new HttpError(503, "Resend is not enabled");
  if (!record.verifiedAt) throw new HttpError(503, "Resend verification is required before sending attendance email");
  return decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
}
async function sendAttendanceEmail(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<{ kind?: "missed-meeting" | "individual-report"; memberId?: string; meetingId?: string }>(request);
  if (!input.kind || !input.memberId || (input.kind === "missed-meeting" && !input.meetingId)) throw new HttpError(400, "Email kind, member, and meeting are required");
  const member = await db.prepare("SELECT id, first_name AS firstName, last_name AS lastName, email FROM members WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(input.memberId).first<{ id: string; firstName: string; lastName: string; email?: string }>();
  if (!member?.email) throw new HttpError(400, "This member does not have an email address");
  let subject: string; let content: string; let deliveryKey: string;
  if (input.kind === "missed-meeting") {
    const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<{ id: string; title: string; startsAt: string }>();
    if (!meeting) throw new HttpError(404, "Meeting not found");
    const data = await policyData(db); const target = data.meetings.find((item) => item.id === meeting.id);
    const result = target ? evaluateAttendance({ ...data, members: data.members.filter((item) => item.id === member.id), meetings: [target], now: new Date(Math.max(Date.now(), Date.parse(target.attendanceClosesAt) + 1)).toISOString() })[0] : undefined;
    if (!result?.rows.some((row) => row.meetingId === meeting.id && row.eligibility === "required" && row.disposition === "absent")) throw new HttpError(409, "This member is not currently marked absent from a required meeting in their audience");
    subject = `Missed meeting: ${meeting.title}`; content = `<p>Hello ${html(member.firstName)},</p><p>Our records show you missed <strong>${html(meeting.title)}</strong> on ${html(new Date(meeting.startsAt).toISOString().slice(0, 10))}.</p><p>Please contact your organization if this should be corrected or excused.</p>`; deliveryKey = `missed:${meeting.id}:${member.id}`;
  } else {
    const report = await policyReport(db, { meetingType: "all", roster: "all", membership: "current", memberId: member.id, useBaseline: true }); const summary = report.members[0]; const meetings = new Map(report.meetings.map((item) => [item.id, item]));
    subject = "Your attendance report"; content = `<p>Hello ${html(member.firstName)},</p><p>Here is your current attendance report.</p><p>${html(policySummaryText(summary))}</p><table><thead><tr><th>Meeting</th><th>Date</th><th>Audience</th><th>Status</th><th>Eligibility</th></tr></thead><tbody>${(summary?.rows ?? []).slice(-100).map((row) => { const meeting = meetings.get(row.meetingId); return `<tr><td>${html(meeting?.title)}</td><td>${html(meeting?.startsAt.slice(0, 10))}</td><td>${html(row.audience)}</td><td>${html(row.disposition)}</td><td>${html(row.eligibility)}</td></tr>`; }).join("")}</tbody></table>`; deliveryKey = `report:${member.id}:${new Date().toISOString().slice(0, 10)}`;
  }
  if (await db.prepare("SELECT id FROM integration_deliveries WHERE installation_id = 'primary' AND provider = 'resend' AND delivery_key = ? AND status IN ('pending', 'delivered')").bind(deliveryKey).first()) throw new HttpError(409, "This email was already sent or is currently sending");
  const config = await resendConfiguration(env); const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.prepare("INSERT INTO integration_deliveries (id, installation_id, provider, delivery_key, status, created_at, updated_at) VALUES (?, 'primary', 'resend', ?, 'pending', ?, ?)").bind(id, deliveryKey, now, now).run();
  const delivery = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", "idempotency-key": deliveryKey }, body: JSON.stringify({ from: config.fromEmail, to: [member.email], subject, html: content }) });
  const deliveryBody = await delivery.json().catch(() => ({})) as { id?: string };
  await db.prepare("UPDATE integration_deliveries SET status = ?, external_id = ?, updated_at = ? WHERE id = ?").bind(delivery.ok ? "delivered" : "failed", deliveryBody.id ?? null, new Date().toISOString(), id).run();
  await writeAudit(db, principal, "resend.email_sent", "member", member.id, { kind: input.kind, ok: delivery.ok, meetingId: input.meetingId });
  if (!delivery.ok) throw new HttpError(502, "Resend rejected the email");
  return response({ sent: true, kind: input.kind, memberId: member.id }, 202);
}
async function discordConfiguration(env: Env, allowUnverified = false): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "discord"); if (!record || record.enabled === 0) throw new HttpError(503, "Discord is not enabled");
  if (!allowUnverified && !record.verifiedAt) throw new HttpError(503, "Discord verification is required before using attendance workflows");
  return decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
}
async function discordInteractionConfiguration(env: Env): Promise<{ config: Record<string, string>; record: IntegrationRecord }> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "discord");
  if (!record) throw new HttpError(503, "Discord credentials are not configured");
  return { config: await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY), record };
}
const discordRetryDelay = (response: Response, body: Record<string, unknown>) => {
  const bodyValue = body.retry_after;
  const retryAfter = typeof bodyValue === "number" ? bodyValue : Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter * 1_000) : 1_000;
};
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function discordRequest<T = Record<string, unknown>>(config: Record<string, string>, path: string, init: RequestInit): Promise<{ response: globalThis.Response; body: T }> {
  const managesCommands = path.includes("/commands");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await fetch(`https://discord.com/api/v10${path}`, { ...init, headers: { authorization: `Bot ${config.botToken}`, "content-type": "application/json", ...init.headers } });
    const body = await result.json().catch(() => ({})) as T;
    if (result.ok) return { response: result, body };
    const errorBody = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (result.status === 401) throw new HttpError(502, "Discord rejected the saved bot token. Reset the token in Discord, replace the saved credentials, and try verification again.");
    if (result.status === 403) throw new DiscordPermissionError(path.includes("/scheduled-events") ? "calendar" : path.includes("/messages/pins/") ? "pin" : managesCommands ? "commands" : path.includes("/members/") && /\/roles\//.test(path) ? "roles" : /\/members(?:\?|$)/.test(path) ? "members" : "channel");
    if (result.status === 429) {
      const retryAfterMs = discordRetryDelay(result, errorBody);
      if (path.includes("/members/") && path.includes("/roles/") || path.includes("/members?") || retryAfterMs > 2_000) throw new DiscordRateLimitError(retryAfterMs, "role sync");
      if (attempt === 2) throw new DiscordRateLimitError(retryAfterMs, managesCommands ? "command setup" : path.includes("/scheduled-events") ? "calendar sync" : "this request");
      await wait(retryAfterMs);
      continue;
    }
    if (managesCommands && result.status === 404) throw new HttpError(502, "Discord could not find that application in the selected server. Confirm the Application ID and Server ID, reinstall the bot if needed, and try verification again.");
    if (managesCommands && result.status === 400) throw new HttpError(502, "Discord rejected the managed command configuration. Confirm the Application ID and Server ID, then try verification again.");
    const message = typeof errorBody.message === "string" ? errorBody.message.replace(/\s+/g, " ").slice(0, 180) : "";
    const code = Number(errorBody.code);
    throw new DiscordResponseError(result.status, message, Number.isFinite(code) ? code : undefined);
  }
  throw new HttpError(502, "Discord request did not complete");
}
type DiscordApplicationCommand = { id?: string; application_id?: string; guild_id?: string; name?: string; type?: number; description?: string; options?: { name?: string; description?: string; type?: number; required?: boolean }[] };
const discordManagedCommands: DiscordApplicationCommand[] = [
  { name: "pair", type: 1, description: "Link your Discord account to your LancerLogin member ID", options: [{ name: "member-id", description: "Your LancerLogin member ID", type: 3, required: true }] },
  { name: "attendance-report", type: 1, description: "Privately view your current LancerLogin attendance report" },
  { name: "label", type: 1, description: "Associate a Discord role with a matching LancerLogin label", options: [{ name: "role", description: "Discord role to associate", type: 8, required: true }] },
];
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
async function discordCommandStatus(env: Env): Promise<{ commandStatus: "unavailable" | "pending" | "ready" | "failed"; commandError?: string; commandsUpdatedAt?: string }> {
  const record = await integrationRecord(env, "discord");
  if (!record || !record.enabled || !record.verifiedAt || !env.INTEGRATION_KEY) return { commandStatus: "unavailable" };
  const fingerprint = await discordCommandFingerprint(await discordConfiguration(env));
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
async function autoReconcileDiscordCommands(env: Env): Promise<void> {
  const db = requireDatabase(env);
  const record = await integrationRecord(env, "discord");
  if (!record || !record.enabled || !record.verifiedAt || !env.INTEGRATION_KEY) return;
  const config = await discordConfiguration(env);
  const fingerprint = await discordCommandFingerprint(config);
  const success = await db.prepare("SELECT content_hash AS fingerprint FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'managed-commands'").first<{ fingerprint?: string }>();
  if (success?.fingerprint === fingerprint) return;
  const now = new Date(); const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const claim = await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, updated_at) VALUES ('primary', 'discord', 'managed-commands-attempt', ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, updated_at = excluded.updated_at WHERE integration_state.external_id != excluded.external_id OR integration_state.updated_at < ?").bind(fingerprint, now.toISOString(), cutoff).run();
  if (!claim.meta?.changes) return;
  try {
    await reconcileDiscordApplicationCommands(config);
    await saveDiscordCommandSuccess(db, config);
    await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', NULL, 'discord.commands_auto_reconciled', 'integration', 'discord', ?, ?)").bind(crypto.randomUUID(), JSON.stringify({ guildId: config.guildId, commands: discordManagedCommands.map((command) => command.name) }), new Date().toISOString()).run();
  } catch (error) {
    const detail = error instanceof HttpError ? error.message.slice(0, 180) : "Discord command setup could not complete. Retry in Settings or check the saved bot connection.";
    await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', 'managed-commands-error', ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(fingerprint, detail, new Date().toISOString()).run();
  }
}
const discordMessageMissing = (error: unknown): error is DiscordResponseError => error instanceof DiscordResponseError && error.discordStatus === 404 && error.discordCode === 10_008;
type DiscordMessageComponents = { type: number; components: { type: number; style: number; label: string; custom_id: string }[] }[];
const discordAttendanceReportComponents: DiscordMessageComponents = [{ type: 1, components: [{ type: 2, style: 1, label: "View my attendance report", custom_id: "lancerlogin-attendance-report" }] }];
async function upsertTrackedDiscordMessage(db: D1Database, config: Record<string, string>, stateKey: string, content: string, pin = false, components?: DiscordMessageComponents): Promise<{ changed: boolean; messageId: string }> {
  const payload = { content, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) };
  const contentHash = await sha256(components ? JSON.stringify({ content, components }) : content); const messagesPath = `/channels/${encodeURIComponent(config.channelId)}/messages`;
  const existing = await db.prepare("SELECT external_id AS externalId, content_hash AS contentHash FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = ?").bind(stateKey).first<{ externalId?: string; contentHash?: string }>();
  let messageId = existing?.externalId ?? ""; let changed = false;
  if (messageId) {
    try {
      if (existing?.contentHash === contentHash) await discordRequest(config, `${messagesPath}/${encodeURIComponent(messageId)}`, { method: "GET" });
      else {
        const { body } = await discordRequest(config, `${messagesPath}/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify(payload) });
        messageId = String(body.id ?? messageId); changed = true;
      }
    } catch (error) {
      if (!discordMessageMissing(error)) throw error;
      messageId = "";
    }
  }
  if (!messageId) {
    const { body } = await discordRequest(config, messagesPath, { method: "POST", body: JSON.stringify(payload) });
    messageId = String(body.id ?? ""); changed = true;
    if (!messageId) throw new HttpError(502, "Discord did not return a managed message identifier");
  }
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', ?, ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(stateKey, messageId, contentHash, now).run();
  if (pin) await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages/pins/${encodeURIComponent(messageId)}`, { method: "PUT" });
  return { changed, messageId };
}
async function startDiscordVerification(request: Request, env: Env): Promise<Response> {
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
async function reconcileDiscordCommands(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const config = await discordConfiguration(env);
  const reconciled = await reconcileDiscordApplicationCommands(config);
  await saveDiscordCommandSuccess(db, config);
  await writeAudit(db, principal, "discord.commands_reconciled", "integration", "discord", { applicationId: reconciled.applicationId, guildId: config.guildId, commands: reconciled.commands });
  return response({ provider: "discord", reconciled: true, commands: reconciled.commands });
}
async function linkDiscordMember(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); await requireIntegrationEnabled(env, "discord"); const db = requireDatabase(env); const input = await parseJson<{ memberId?: string; discordUserId?: string | null }>(request);
  if (!input.memberId || (input.discordUserId !== null && !/^\d{10,24}$/.test(input.discordUserId ?? ""))) throw new HttpError(400, "Member and a valid Discord user ID are required");
  await db.prepare("UPDATE members SET discord_user_id = ? WHERE installation_id = 'primary' AND id = ?").bind(input.discordUserId, input.memberId).run();
  await writeAudit(db, principal, input.discordUserId ? "discord.member_linked" : "discord.member_unlinked", "member", input.memberId);
  return response({ linked: Boolean(input.discordUserId), memberId: input.memberId });
}
async function linkedAbsentMembers(db: D1Database, meetingId: string): Promise<{ id: string; discordUserId: string }[]> {
  const data = await policyData(db, { meetingId }); const meeting = data.meetings.find((item) => item.id === meetingId);
  if (!meeting || !meeting.required) return [];
  const expected = new Set(evaluateAttendance({ ...data, meetings: [meeting], now: new Date(Math.max(Date.now(), Date.parse(meeting.attendanceClosesAt) + 1)).toISOString() }).filter((item) => item.member.active && item.rows.some((row) => row.meetingId === meetingId && row.eligibility === "required" && (row.disposition === "absent" || Date.now() >= Date.parse(meeting.attendanceClosesAt) && row.disposition === "active"))).map((item) => item.member.id));
  if (!expected.size) return [];
  const linked = await db.prepare("SELECT id, discord_user_id AS discordUserId FROM members WHERE installation_id = 'primary' AND active = 1 AND discord_user_id IS NOT NULL").all<{ id: string; discordUserId: string }>();
  return (linked.results ?? []).filter((member) => expected.has(member.id));
}
async function sendDiscordAttendanceNotification(env: Env, meeting: { id: string; title: string }, options: { force?: boolean; actor?: Principal } = {}): Promise<{ posted: boolean; duplicate?: boolean; linkedMissingCount: number; messageId?: string }> {
  const config = await discordConfiguration(env); const db = requireDatabase(env); const now = new Date().toISOString();
  const existing = await db.prepare("SELECT status, message_id AS messageId, attempts FROM discord_attendance_notifications WHERE installation_id = 'primary' AND meeting_id = ?").bind(meeting.id).first<{ status: string; messageId?: string; attempts: number }>();
  if (!options.force && ["delivered", "no_recipients"].includes(existing?.status ?? "")) return { posted: existing?.status === "delivered", duplicate: true, linkedMissingCount: 0, messageId: existing?.messageId };
  if (!existing) await db.prepare("INSERT INTO discord_attendance_notifications (installation_id, meeting_id, status, attempts, updated_at) VALUES ('primary', ?, 'pending', 1, ?)").bind(meeting.id, now).run();
  else await db.prepare("UPDATE discord_attendance_notifications SET status = 'pending', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(now, meeting.id).run();
  const members = await linkedAbsentMembers(db, meeting.id);
  if (!members.length) {
    await db.prepare("UPDATE discord_attendance_notifications SET status = 'no_recipients', processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(now, now, meeting.id).run();
    return { posted: false, linkedMissingCount: 0 };
  }
  try {
    const userIds = members.map((member) => member.discordUserId); const mentions = userIds.map((id) => `<@${id}>`).join(" ");
    const payload = { content: `Attendance has closed for **${meeting.title}**. The following members are marked absent: ${mentions}\nIf you attended, use the button below to request a private review. Your attendance will not change until an Operator or Admin approves it. Ask general questions in the thread under this notice.`, allowed_mentions: { parse: [], users: userIds }, components: [{ type: 1, components: [{ type: 2, style: 2, label: "Contest absence", custom_id: `lancerlogin-attendance:${meeting.id}` }] }] };
    const { body } = await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages`, { method: "POST", body: JSON.stringify(payload) }); const messageId = String(body.id ?? "");
    if (!messageId) throw new HttpError(502, "Discord did not return a message identifier");
    const contestWindow = await db.prepare("SELECT discord_contest_window_hours AS contestWindowHours FROM organization_settings WHERE installation_id = 'primary'").first<{ contestWindowHours?: number }>();
    const expiresAt = new Date(Date.parse(now) + (contestWindow?.contestWindowHours ?? 24) * 3_600_000).toISOString();
    await db.batch([
      ...members.map((member) => db.prepare("INSERT OR IGNORE INTO discord_attendance_recipients (installation_id, meeting_id, member_id, discord_user_id, message_id, delivered_at) VALUES ('primary', ?, ?, ?, ?, ?)").bind(meeting.id, member.id, member.discordUserId, messageId, now)),
      db.prepare("UPDATE discord_attendance_notifications SET status = 'delivered', message_id = ?, channel_id = ?, expires_at = ?, deleted_at = NULL, thread_created_at = NULL, processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(messageId, config.channelId, expiresAt, now, now, meeting.id),
    ]);
    try { await createDiscordAttendanceThread(db, config, { meetingId: meeting.id, messageId, channelId: config.channelId, title: meeting.title }); } catch { /* The delivered notice remains tracked for a scheduled thread retry. */ }
    if (options.actor) await writeAudit(db, options.actor, "discord.missing_notified", "meeting", meeting.id, { linkedMissingCount: members.length, messageId, manual: true });
    return { posted: true, linkedMissingCount: members.length, messageId };
  } catch (error) {
    await db.prepare("UPDATE discord_attendance_notifications SET status = 'failed', last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord delivery failed", new Date().toISOString(), meeting.id).run();
    throw error;
  }
}
async function createDiscordAttendanceThread(db: D1Database, config: Record<string, string>, notice: { meetingId: string; messageId: string; channelId: string; title: string }): Promise<void> {
  const path = `/channels/${encodeURIComponent(notice.channelId)}/messages/${encodeURIComponent(notice.messageId)}/threads`;
  try {
    await discordRequest(config, path, { method: "POST", body: JSON.stringify({ name: `Attendance questions - ${discordReportText(notice.title, 70) || "meeting"}` }) });
  } catch (error) {
    // Discord may have created the thread even if the response was lost. Its ID is the starter message ID.
    let exists = false;
    try {
      const { body } = await discordRequest<{ id?: string; parent_id?: string }>(config, `/channels/${encodeURIComponent(notice.messageId)}`, { method: "GET" });
      exists = body.id === notice.messageId && body.parent_id === notice.channelId;
    } catch { /* Retry creation on the next scheduled pass. */ }
    if (!exists) {
      await db.prepare("UPDATE discord_attendance_notifications SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord thread creation failed", new Date().toISOString(), notice.meetingId, notice.messageId).run();
      return;
    }
  }
  const createdAt = new Date().toISOString();
  await db.prepare("UPDATE discord_attendance_notifications SET thread_created_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(createdAt, createdAt, notice.meetingId, notice.messageId).run();
}
async function retryDiscordAttendanceThreads(env: Env, config: Record<string, string>, now: number): Promise<void> {
  const db = requireDatabase(env);
  const notices = await db.prepare("SELECT n.meeting_id AS meetingId, n.message_id AS messageId, n.channel_id AS channelId, m.title FROM discord_attendance_notifications n JOIN meetings m ON m.installation_id = n.installation_id AND m.id = n.meeting_id WHERE n.installation_id = 'primary' AND n.status = 'delivered' AND n.message_id IS NOT NULL AND n.thread_created_at IS NULL AND n.deleted_at IS NULL AND n.expires_at > ? LIMIT 100").bind(new Date(now).toISOString()).all<{ meetingId: string; messageId: string; channelId: string; title: string }>();
  for (const notice of notices.results ?? []) if (notice.channelId === config.channelId) await createDiscordAttendanceThread(db, config, notice);
}
async function expireDiscordAttendanceNotifications(env: Env, config: Record<string, string>, contestWindowHours: number, now: number): Promise<void> {
  const db = requireDatabase(env);
  const delivered = await db.prepare("SELECT meeting_id AS meetingId, message_id AS messageId, channel_id AS channelId, processed_at AS processedAt, expires_at AS expiresAt FROM discord_attendance_notifications WHERE installation_id = 'primary' AND status = 'delivered' AND message_id IS NOT NULL AND deleted_at IS NULL").all<{ meetingId: string; messageId: string; channelId?: string; processedAt?: string; expiresAt?: string }>();
  for (const notice of delivered.results ?? []) {
    const expiry = notice.expiresAt ? Date.parse(notice.expiresAt) : Date.parse(notice.processedAt ?? "") + contestWindowHours * 3_600_000;
    if (!Number.isFinite(expiry) || expiry > now || notice.channelId && notice.channelId !== config.channelId) continue;
    try {
      await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages/${encodeURIComponent(notice.messageId)}`, { method: "DELETE" });
    } catch (error) {
      if (!discordMessageMissing(error)) {
        await db.prepare("UPDATE discord_attendance_notifications SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord deletion failed", new Date().toISOString(), notice.meetingId).run();
        continue;
      }
    }
    const deletedAt = new Date(now).toISOString();
    await db.prepare("UPDATE discord_attendance_notifications SET deleted_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(deletedAt, deletedAt, notice.meetingId, notice.messageId).run();
  }
}
async function processDiscordAttendanceNotifications(env: Env, now = Date.now()): Promise<void> {
  const discord = await integrationRecord(env, "discord"); if (!discord || discord.enabled === 0 || !discord.verifiedAt) return;
  const db = requireDatabase(env); const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, discord_contest_window_hours AS contestWindowHours FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number; contestWindowHours?: number }>();
  const config = await discordConfiguration(env);
  await expireDiscordAttendanceNotifications(env, config, settings?.contestWindowHours ?? 24, now);
  await retryDiscordAttendanceThreads(env, config, now);
  const meetings = await db.prepare("SELECT m.id, m.title, m.ends_at AS endsAt, n.status AS notificationStatus, n.updated_at AS notificationUpdatedAt FROM meetings m LEFT JOIN discord_attendance_notifications n ON n.installation_id = m.installation_id AND n.meeting_id = m.id WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.required = 1 AND m.is_test = 0 AND m.ends_at IS NOT NULL ORDER BY m.ends_at DESC LIMIT 100").all<{ id: string; title: string; endsAt: string; notificationStatus?: string; notificationUpdatedAt?: string }>();
  for (const meeting of meetings.results ?? []) {
    const cutoff = Date.parse(attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30)); const newlyEligible = cutoff <= now; const retry = meeting.notificationStatus === "failed";
    if ((!meeting.notificationStatus && newlyEligible) || retry) await sendDiscordAttendanceNotification(env, meeting);
  }
}
type DiscordAnomalyRow = { memberId: string; firstName: string; lastName: string; checkedInAt?: string; checkedOutAt?: string; lateMinutes?: number; earlyMinutes?: number };
const discordReportText = (value: string, limit: number) => value.replace(/[\r\n\t]+/g, " ").replace(/[\\`*_~|<>@]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
const discordReportMinutes = (minutes: number) => Number(minutes.toFixed(1)).toString();
function discordAnomalyReportContent(meeting: { title: string; startsAt: string }, rows: DiscordAnomalyRow[]): string {
  const header = `**Attendance anomalies · ${discordReportText(meeting.title, 120)}**\nMeeting date: ${meeting.startsAt.slice(0, 10)}`;
  const lines = rows.map((row) => {
    const values = [row.lateMinutes !== undefined ? `arrived ${discordReportMinutes(row.lateMinutes)} min late` : "", row.earlyMinutes !== undefined ? `left ${discordReportMinutes(row.earlyMinutes)} min early` : ""].filter(Boolean).join("; ");
    return `• ${discordReportText(`${row.firstName} ${row.lastName}`, 120)} (${discordReportText(row.memberId, 80)}) — ${values}`;
  });
  const included: string[] = [];
  for (const line of lines) {
    if (`${header}\n${[...included, line].join("\n")}`.length > 1_900) break;
    included.push(line);
  }
  const omitted = lines.length - included.length;
  return `${header}\n${included.join("\n")}${omitted ? `\n… ${omitted} more anomalous member${omitted === 1 ? "" : "s"} omitted.` : ""}`;
}
async function sendDiscordAnomalyReport(env: Env, config: Record<string, string>, channelId: string, meeting: { id: string; title: string; startsAt: string; endsAt: string }, thresholds: { late: number; early: number }): Promise<void> {
  const db = requireDatabase(env); const now = new Date().toISOString();
  const existing = await db.prepare("SELECT status, nonce, message_id AS messageId, attempts FROM discord_anomaly_reports WHERE installation_id = 'primary' AND meeting_id = ?").bind(meeting.id).first<{ status: string; nonce?: string; messageId?: string; attempts: number }>();
  if (["delivered", "no_anomalies"].includes(existing?.status ?? "")) return;
  const nonce = existing?.nonce ?? (await sha256(`discord-anomaly-report:primary:${meeting.id}`)).slice(0, 25);
  if (!existing) await db.prepare("INSERT INTO discord_anomaly_reports (installation_id, meeting_id, channel_id, status, nonce, attempts, updated_at) VALUES ('primary', ?, ?, 'pending', ?, 1, ?)").bind(meeting.id, channelId, nonce, now).run();
  else await db.prepare("UPDATE discord_anomaly_reports SET channel_id = ?, status = 'pending', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(channelId, now, meeting.id).run();
  const raw = await db.prepare("SELECT m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_out') AS checkedOutAt FROM members m WHERE m.installation_id = 'primary' AND COALESCE(m.attendance_required_from, substr(m.created_at, 1, 10)) <= substr(?, 1, 10) AND (EXISTS (SELECT 1 FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ?) OR EXISTS (SELECT 1 FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ?)) ORDER BY m.last_name, m.first_name, m.external_id").bind(meeting.id, meeting.id, meeting.startsAt, meeting.id, meeting.id).all<Omit<DiscordAnomalyRow, "lateMinutes" | "earlyMinutes">>();
  const anomalies = (raw.results ?? []).flatMap((row) => {
    const values = attendanceAnomalyMinutes({ ...meeting, ...row }, thresholds.late, thresholds.early);
    return values.lateMinutes === undefined && values.earlyMinutes === undefined ? [] : [{ ...row, ...values }];
  });
  if (!anomalies.length) {
    await db.prepare("UPDATE discord_anomaly_reports SET status = 'no_anomalies', processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(now, now, meeting.id).run();
    return;
  }
  try {
    const payload = { content: discordAnomalyReportContent(meeting, anomalies), allowed_mentions: { parse: [] }, nonce, enforce_nonce: true };
    const { body } = await discordRequest(config, `/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", body: JSON.stringify(payload) });
    const messageId = String(body.id ?? "");
    if (!messageId) throw new HttpError(502, "Discord did not return an anomaly-report message identifier");
    const processedAt = new Date().toISOString();
    await db.prepare("UPDATE discord_anomaly_reports SET status = 'delivered', message_id = ?, last_error = NULL, processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(messageId, processedAt, processedAt, meeting.id).run();
  } catch (error) {
    await db.prepare("UPDATE discord_anomaly_reports SET status = 'failed', last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord delivery failed", new Date().toISOString(), meeting.id).run();
    throw error;
  }
}
async function processDiscordAnomalyReports(env: Env, now = Date.now()): Promise<void> {
  const discord = await integrationRecord(env, "discord"); if (!discord || discord.enabled === 0 || !discord.verifiedAt) return;
  const db = requireDatabase(env);
  const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes, discord_anomaly_reports_enabled AS enabled, discord_anomaly_report_channel_id AS channelId, discord_anomaly_reports_enabled_at AS enabledAt FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes?: number; anomalyLateThresholdMinutes?: number; anomalyEarlyThresholdMinutes?: number; enabled?: number; channelId?: string; enabledAt?: string }>();
  if (!settings?.enabled || !settings.channelId || !settings.enabledAt) return;
  const lateScanMinutes = settings.lateScanMinutes ?? 30; const enabledAt = Date.parse(settings.enabledAt);
  if (!Number.isFinite(enabledAt)) return;
  const earliestEnd = new Date(enabledAt - lateScanMinutes * 60_000).toISOString();
  const meetings = await db.prepare("SELECT m.id, m.title, m.starts_at AS startsAt, m.ends_at AS endsAt, r.status AS reportStatus FROM meetings m LEFT JOIN discord_anomaly_reports r ON r.installation_id = m.installation_id AND r.meeting_id = m.id WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.is_test = 0 AND m.ends_at IS NOT NULL AND m.ends_at >= ? AND (r.status IS NULL OR r.status IN ('pending', 'failed')) ORDER BY m.ends_at ASC LIMIT 100").bind(earliestEnd).all<{ id: string; title: string; startsAt: string; endsAt: string; reportStatus?: string }>();
  const config = await discordConfiguration(env);
  for (const meeting of meetings.results ?? []) {
    const cutoff = Date.parse(attendanceClosesAt(meeting.endsAt, lateScanMinutes));
    if (cutoff < enabledAt || cutoff > now) continue;
    try { await sendDiscordAnomalyReport(env, config, settings.channelId, meeting, { late: settings.anomalyLateThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES, early: settings.anomalyEarlyThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES }); } catch { /* One failed report must not delay other eligible meetings. */ }
  }
}
async function discordMissing(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string }>(request);
  if (!input.meetingId) throw new HttpError(400, "Meeting is required");
  const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<{ id: string; title: string; startsAt: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found"); if (Date.now() < Date.parse(meeting.startsAt)) throw new HttpError(409, "Attendance has not started for this meeting");
  return response(await sendDiscordAttendanceNotification(env, meeting, { force: true, actor: principal }), 202);
}
async function discordContests(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); await requireIntegrationConfigured(env, "discord"); const meetingId = new URL(request.url).searchParams.get("meetingId"); const where = meetingId ? "AND c.meeting_id = ?" : "";
  const statement = requireDatabase(env).prepare(`SELECT c.meeting_id AS meetingId, mt.title AS meetingTitle, mt.starts_at AS meetingStartsAt, c.member_id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, c.status, c.created_at AS createdAt, c.resolved_at AS resolvedAt, c.review_note AS reviewNote, (SELECT COUNT(*) FROM discord_attendance_contests history WHERE history.installation_id = c.installation_id AND history.member_id = c.member_id) AS lifetimeContestCount, EXISTS (SELECT 1 FROM attendance_events check_in WHERE check_in.installation_id = c.installation_id AND check_in.meeting_id = c.meeting_id AND check_in.member_id = c.member_id AND check_in.action = 'check_in') AS hasRawCheckIn, EXISTS (SELECT 1 FROM attendance_events check_out WHERE check_out.installation_id = c.installation_id AND check_out.meeting_id = c.meeting_id AND check_out.member_id = c.member_id AND check_out.action = 'check_out') AS hasRawCheckOut FROM discord_attendance_contests c JOIN members m ON m.id = c.member_id AND m.installation_id = c.installation_id JOIN meetings mt ON mt.id = c.meeting_id AND mt.installation_id = c.installation_id WHERE c.installation_id = 'primary' ${where} ORDER BY CASE WHEN c.status = 'open' THEN 0 ELSE 1 END, c.created_at DESC`);
  type ContestRow = Record<string, unknown> & { lifetimeContestCount?: number; hasRawCheckIn?: number; hasRawCheckOut?: number };
  const result = meetingId ? await statement.bind(meetingId).all<ContestRow>() : await statement.all<ContestRow>();
  const contests = (result.results ?? []).map(({ hasRawCheckIn, hasRawCheckOut, ...contest }) => ({
    ...contest,
    lifetimeContestCount: Number(contest.lifetimeContestCount ?? 0),
    hasPartialScan: Boolean(hasRawCheckIn) && !Boolean(hasRawCheckOut),
    rawScanStatus: hasRawCheckIn ? (hasRawCheckOut ? "complete" : "partial") : "none",
  }));
  return response({ contests });
}
async function resolveDiscordContest(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); await requireIntegrationConfigured(env, "discord"); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string; memberId?: string; resolution?: "approved" | "rejected" | "reviewed"; reviewNote?: string }>(request);
  if (!input.meetingId || !input.memberId || !input.resolution || !["approved", "rejected", "reviewed"].includes(input.resolution)) throw new HttpError(400, "Meeting, member, and a valid resolution are required");
  if (typeof input.reviewNote !== "string" || !input.reviewNote.trim()) throw new HttpError(400, "A review reason is required before resolving this contest");
  if (input.reviewNote.length > 500) throw new HttpError(400, "Review reasons must be 500 characters or fewer");
  const now = new Date().toISOString(); const statements: D1Statement[] = [];
  if (input.resolution === "approved") statements.push(db.prepare("INSERT INTO attendance_corrections (id, installation_id, member_id, meeting_id, disposition, reason, created_by, created_at) SELECT ?, 'primary', ?, ?, 'present', ?, ?, ? WHERE EXISTS (SELECT 1 FROM discord_attendance_contests WHERE installation_id = 'primary' AND meeting_id = ? AND member_id = ? AND status = 'open')").bind(crypto.randomUUID(), input.memberId, input.meetingId, `Discord contest approved: ${input.reviewNote.trim()}`, principal.userId, now, input.meetingId, input.memberId));
  statements.push(db.prepare("UPDATE discord_attendance_contests SET status = ?, resolved_by = ?, resolved_at = ?, review_note = ? WHERE installation_id = 'primary' AND meeting_id = ? AND member_id = ? AND status = 'open'").bind(input.resolution, principal.userId, now, input.reviewNote.trim(), input.meetingId, input.memberId));
  const results = await db.batch(statements); const result = results.at(-1)!;
  if ((result.meta?.changes ?? 1) < 1) throw new HttpError(404, "Open contest not found");
  await writeAudit(db, principal, "discord.contest_resolved", "member", input.memberId, { meetingId: input.meetingId, resolution: input.resolution, reviewNote: input.reviewNote.trim() }); return response({ resolved: true, attendanceChanged: input.resolution === "approved" });
}
function hexBytes(value: string): Uint8Array { if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) throw new Error("Invalid hexadecimal value"); return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)); }
const byteBuffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
async function verifyDiscordInteraction(request: Request, config: Record<string, string>, body: string): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519"); const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60_000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", byteBuffer(hexBytes(config.publicKey)), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, byteBuffer(hexBytes(signature)), byteBuffer(new TextEncoder().encode(timestamp + body)));
  } catch { return false; }
}
const discordEphemeral = (content: string) => response({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
async function discordAttendanceReport(db: D1Database, discordUserId: string): Promise<string> {
  const linked = await db.prepare("SELECT id, active FROM members WHERE installation_id = 'primary' AND discord_user_id = ?").bind(discordUserId).all<{ id: string; active: number }>();
  const members = linked.results ?? [];
  if (members.length !== 1 || !members[0].active) return "Your Discord account is not linked to exactly one active LancerLogin roster member. Ask an Operator to check your roster link.";
  const report = await policyReport(db, { meetingType: "all", roster: "all", membership: "current", memberId: members[0].id, useBaseline: true });
  const summary = report.members[0]; if (!summary) return "No roster record was found for this Discord account.";
  const meetings = new Map(report.meetings.map((meeting) => [meeting.id, meeting]));
  const heading = "**Your attendance report**\n" + policySummaryText(summary);
  const absent = summary.rows.filter((row) => row.regularEligible && row.disposition === "absent");
  let content = `${heading}\n\n${absent.length ? "**Missed required meetings**" : "No missed required meetings in the current reporting period."}`;
  for (const row of absent) { const meeting = meetings.get(row.meetingId); const line = `\n• ${meeting?.startsAt.slice(0, 10) ?? ""} - ${meeting?.title ?? "Meeting"} (${row.audience})`; if ((content + line).length > 1850) { content += "\nMore meetings omitted to fit Discord."; break; } content += line; }
  if (summary.belowTargetWeeks.length) { const line = `\n\nBelow-target weeks: ${summary.belowTargetWeeks.map((week) => week.weekStartsOn).join(", ")}`; if ((content + line).length <= 2000) content += line; }
  return content;
}
type DiscordLabelMapping = { labelId: string; labelName: string; active: number; guildId: string; roleId: string; roleName: string; createdAt: string };
type DiscordGuildRole = { id: string; name: string; position: number; permissions: string; managed?: boolean };
type DiscordGuildMember = { user?: { id?: string; username?: string }; nick?: string | null; roles?: string[] };
type DiscordRoleChange = { discordUserId: string; displayName: string; memberId?: string };
type DiscordRoleSnapshot = { mapping: DiscordLabelMapping; sourceFingerprint: string; fingerprint: string; additions: DiscordRoleChange[]; removals: DiscordRoleChange[]; unpaired: { memberId: string; name: string }[]; absent: { memberId: string; name: string; discordUserId: string }[]; inactive: { memberId: string; name: string; discordUserId?: string }[]; roleName: string; memberCount: number };
const discordSnowflake = (value: unknown): value is string => typeof value === "string" && /^\d{10,24}$/.test(value);
async function discordLabelAdmin(db: D1Database, discordUserId: string): Promise<Principal> {
  const admin = await db.prepare("SELECT u.id AS userId, u.role FROM users u JOIN members m ON m.id = u.member_id AND m.installation_id = u.installation_id WHERE u.installation_id = 'primary' AND u.active = 1 AND u.role = 'admin' AND m.active = 1 AND m.discord_user_id = ?").bind(discordUserId).first<{ userId: string; role: Role }>();
  if (!admin) throw new HttpError(403, "Pair a roster member linked to an active LancerLogin Admin account before using /label.");
  return { ...admin, expiresAt: 0 };
}
async function discordLabelMapping(db: D1Database, labelId: string, requireActive = true): Promise<DiscordLabelMapping> {
  const mapping = await db.prepare("SELECT x.label_id AS labelId, l.name AS labelName, l.active, x.guild_id AS guildId, x.role_id AS roleId, x.role_name AS roleName, x.created_at AS createdAt FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.label_id = ?").bind(labelId).first<DiscordLabelMapping>();
  if (!mapping) throw new HttpError(404, "This label has no Discord role association");
  if (requireActive && !mapping.active) throw new HttpError(409, "Restore the retired label before syncing its Discord role");
  return mapping;
}
async function discordManageableRole(config: Record<string, string>, roleId: string): Promise<DiscordGuildRole> {
  if (!discordSnowflake(roleId) || roleId === config.guildId) throw new HttpError(400, "Choose a manageable Discord role, not @everyone");
  const [rolesResult, botResult] = await Promise.all([
    discordRequest<DiscordGuildRole[]>(config, `/guilds/${config.guildId}/roles`, { method: "GET" }),
    discordRequest<{ id?: string }>(config, "/users/@me", { method: "GET" }),
  ]);
  if (!Array.isArray(rolesResult.body) || !discordSnowflake(botResult.body.id)) throw new HttpError(502, "Discord did not return valid role and bot identities");
  const roles = rolesResult.body; const role = roles.find((item) => item.id === roleId);
  if (!role) throw new HttpError(409, "The mapped Discord role no longer exists");
  const bot = await discordRequest<DiscordGuildMember>(config, `/guilds/${config.guildId}/members/${botResult.body.id}`, { method: "GET" });
  const botRoles = roles.filter((item) => bot.body.roles?.includes(item.id));
  const highest = Math.max(0, ...botRoles.map((item) => item.position));
  const permissions = botRoles.reduce((value, item) => value | BigInt(item.permissions || "0"), BigInt(roles.find((item) => item.id === config.guildId)?.permissions || "0"));
  if (!(permissions & (1n << 28n)) && !(permissions & 8n)) throw new DiscordPermissionError("roles");
  if (role.managed || !Number.isInteger(role.position) || role.position >= highest || BigInt(role.permissions || "0") & (8n | 1n << 28n)) throw new HttpError(409, "This Discord role is managed, privileged, or above the bot's highest role");
  return role;
}
async function discordAllGuildMembers(config: Record<string, string>): Promise<DiscordGuildMember[]> {
  const members: DiscordGuildMember[] = []; let after = "0"; const seen = new Set<string>();
  for (let page = 0; page < 1000; page += 1) {
    const result = await discordRequest<DiscordGuildMember[]>(config, `/guilds/${config.guildId}/members?limit=1000&after=${after}`, { method: "GET" });
    if (!Array.isArray(result.body) || result.body.length > 1000) throw new HttpError(502, "Discord did not return a complete server member page");
    for (const member of result.body) {
      const id = member.user?.id;
      if (!discordSnowflake(id) || seen.has(id) || !Array.isArray(member.roles)) throw new HttpError(502, "Discord returned an incomplete or duplicate server member page");
      if (BigInt(id) <= BigInt(after)) throw new HttpError(502, "Discord returned a non-advancing server member page");
      seen.add(id); members.push(member); if (BigInt(id) > BigInt(after)) after = id;
    }
    if (result.body.length < 1000) return members;
  }
  throw new HttpError(502, "The Discord server member list exceeded the supported sync size. No role changes were made.");
}
async function discordLabelSource(db: D1Database, mapping: DiscordLabelMapping, guildId: string) {
  if (mapping.guildId !== guildId) throw new HttpError(409, "This mapping belongs to a different Discord server. Unlink it before continuing.");
  const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone: string }>();
  const today = policyLocalDate(new Date().toISOString(), settings?.timeZone ?? "UTC");
  const result = await db.prepare("SELECT m.id, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id AS discordUserId, m.active, (SELECT c.action FROM member_label_changes c WHERE c.installation_id = m.installation_id AND c.member_id = m.id AND c.label_id = ? AND c.effective_date <= ? ORDER BY c.effective_date DESC, c.created_at DESC, c.id DESC LIMIT 1) AS labelAction FROM members m WHERE m.installation_id = 'primary' ORDER BY m.id").bind(mapping.labelId, today).all<{ id: string; memberId: string; firstName: string; lastName: string; discordUserId?: string; active: number; labelAction?: string }>();
  const roster = result.results ?? [];
  const sourceFingerprint = await sha256(JSON.stringify({ labelId: mapping.labelId, roleId: mapping.roleId, guildId, today, active: mapping.active, roster }));
  return { roster, sourceFingerprint };
}
async function discordRoleSnapshot(db: D1Database, config: Record<string, string>, labelId: string): Promise<DiscordRoleSnapshot> {
  const mapping = await discordLabelMapping(db, labelId);
  const role = await discordManageableRole(config, mapping.roleId);
  const [source, guildMembers] = await Promise.all([discordLabelSource(db, mapping, config.guildId), discordAllGuildMembers(config)]);
  const guild = new Map(guildMembers.map((member) => [member.user!.id!, member]));
  const qualified = new Map(source.roster.filter((member) => member.active && member.labelAction === "add" && member.discordUserId).map((member) => [member.discordUserId!, member]));
  const additions: DiscordRoleChange[] = []; const removals: DiscordRoleChange[] = [];
  for (const member of guildMembers) {
    const id = member.user!.id!; const hasRole = member.roles!.includes(mapping.roleId); const shouldHaveRole = qualified.has(id);
    const change = { discordUserId: id, displayName: member.nick || member.user?.username || id, ...(qualified.get(id) ? { memberId: qualified.get(id)!.memberId } : {}) };
    if (shouldHaveRole && !hasRole) additions.push(change);
    if (!shouldHaveRole && hasRole) removals.push(change);
  }
  const labeled = source.roster.filter((member) => member.labelAction === "add");
  const display = (member: typeof labeled[number]) => ({ memberId: member.memberId, name: `${member.firstName} ${member.lastName}`.trim() });
  const unpaired = labeled.filter((member) => member.active && !member.discordUserId).map(display);
  const absent = labeled.filter((member) => member.active && member.discordUserId && !guild.has(member.discordUserId)).map((member) => ({ ...display(member), discordUserId: member.discordUserId! }));
  const inactive = labeled.filter((member) => !member.active).map((member) => ({ ...display(member), discordUserId: member.discordUserId }));
  const fingerprint = await sha256(JSON.stringify({ source: source.sourceFingerprint, roleName: role.name, guild: guildMembers.map((member) => [member.user!.id, member.roles!.includes(mapping.roleId)]) }));
  return { mapping, sourceFingerprint: source.sourceFingerprint, fingerprint, additions, removals, unpaired, absent, inactive, roleName: role.name, memberCount: guildMembers.length };
}
async function discordLabelMappings(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const rows = await db.prepare("SELECT x.label_id AS labelId, l.name AS labelName, l.active, x.guild_id AS guildId, x.role_id AS roleId, x.role_name AS roleName, x.created_at AS createdAt FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' ORDER BY l.name COLLATE NOCASE").all<DiscordLabelMapping>();
  const integration = await integrationRecord(env, "discord"); const available = Boolean(integration && integration.enabled !== 0 && integration.verifiedAt);
  let config: Record<string, string> | undefined;
  if (available) config = await discordConfiguration(env);
  const mappings = await Promise.all((rows.results ?? []).map(async (mapping) => {
    const latest = await db.prepare("SELECT id, status, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? ORDER BY created_at DESC LIMIT 1").bind(mapping.labelId).first<{ id: string; status: string; createdAt: string; updatedAt: string; completedAt?: string }>();
    if (!config || !mapping.active) return { ...mapping, health: !mapping.active ? "retired" : "integration_unavailable", latestJob: latest };
    if (mapping.guildId !== config.guildId) return { ...mapping, health: "different_server", latestJob: latest };
    try { const role = await discordManageableRole(config, mapping.roleId); return { ...mapping, roleName: role.name, health: "ready", latestJob: latest }; }
    catch (error) { return { ...mapping, health: "unavailable", healthDetail: (error as Error).message, latestJob: latest }; }
  }));
  return response({ mappings, integrationAvailable: available });
}
async function discordLabelUnlink(request: Request, env: Env, labelId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const mapping = await discordLabelMapping(db, labelId, false);
  const active = await db.prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running')").bind(labelId).first();
  if (active) throw new HttpError(409, "Wait for this role sync to finish before unlinking the role");
  await db.prepare("DELETE FROM discord_label_role_mappings WHERE installation_id = 'primary' AND label_id = ?").bind(labelId).run();
  await writeAudit(db, principal, "discord.label_role_unlinked", "member_label", labelId, { guildId: mapping.guildId, roleId: mapping.roleId });
  return response({ unlinked: true, roleAssignmentsUnchanged: true });
}
async function discordLabelPreview(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ labelId?: string }>(request);
  if (!input.labelId) throw new HttpError(400, "Choose a label to preview");
  const db = requireDatabase(env); const config = await discordConfiguration(env); const snapshot = await discordRoleSnapshot(db, config, input.labelId);
  const id = crypto.randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await db.prepare("INSERT INTO discord_label_role_previews (id, installation_id, label_id, guild_id, role_id, fingerprint, actor_user_id, expires_at, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)").bind(id, snapshot.mapping.labelId, config.guildId, snapshot.mapping.roleId, snapshot.fingerprint, principal.userId, expiresAt, now.toISOString()).run();
  return response({ previewId: id, expiresAt, labelId: snapshot.mapping.labelId, roleId: snapshot.mapping.roleId, roleName: snapshot.roleName, memberCount: snapshot.memberCount, additions: snapshot.additions, removals: snapshot.removals, unpaired: snapshot.unpaired, absent: snapshot.absent, inactive: snapshot.inactive });
}
async function discordLabelApply(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const input = await parseJson<{ previewId?: string }>(request);
  if (!input.previewId) throw new HttpError(400, "A current role sync preview is required");
  const db = requireDatabase(env); const preview = await db.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, fingerprint, actor_user_id AS actorUserId, expires_at AS expiresAt, used_at AS usedAt FROM discord_label_role_previews WHERE installation_id = 'primary' AND id = ?").bind(input.previewId).first<{ id: string; labelId: string; guildId: string; roleId: string; fingerprint: string; actorUserId: string; expiresAt: string; usedAt?: string }>();
  if (!preview || preview.actorUserId !== principal.userId || preview.usedAt || preview.expiresAt <= new Date().toISOString()) throw new HttpError(409, "This role sync preview expired or was already used. Preview again.");
  const config = await discordConfiguration(env); const snapshot = await discordRoleSnapshot(db, config, preview.labelId);
  if (preview.guildId !== config.guildId || preview.roleId !== snapshot.mapping.roleId || preview.fingerprint !== snapshot.fingerprint) throw new HttpError(409, "Roster or Discord roles changed since the preview. Preview again before syncing.");
  const active = await db.prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running')").bind(preview.labelId).first();
  if (active) throw new HttpError(409, "A sync for this label is already in progress");
  const now = new Date().toISOString(); const id = crypto.randomUUID(); const changes = [...snapshot.additions.map((item) => ({ ...item, action: "add" })), ...snapshot.removals.map((item) => ({ ...item, action: "remove" }))];
  const claimed = await db.prepare("UPDATE discord_label_role_previews SET used_at = ? WHERE installation_id = 'primary' AND id = ? AND used_at IS NULL AND expires_at > ?").bind(now, preview.id, now).run();
  if ((claimed.meta?.changes ?? 0) !== 1) throw new HttpError(409, "This role sync preview was already used");
  await db.batch([
    db.prepare("INSERT INTO discord_label_role_jobs (id, installation_id, label_id, guild_id, role_id, status, source_fingerprint, actor_user_id, next_attempt_at, created_at, updated_at, completed_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, preview.labelId, config.guildId, preview.roleId, changes.length ? "pending" : "completed", snapshot.sourceFingerprint, principal.userId, now, now, now, changes.length ? null : now),
    ...changes.map((item) => db.prepare("INSERT INTO discord_label_role_job_items (installation_id, job_id, discord_user_id, action, status) VALUES ('primary', ?, ?, ?, 'pending')").bind(id, item.discordUserId, item.action)),
  ]);
  await writeAudit(db, principal, "discord.label_role_sync_requested", "member_label", preview.labelId, { jobId: id, roleId: preview.roleId, adds: snapshot.additions.length, removals: snapshot.removals.length });
  if (changes.length && context) context.waitUntil(processDiscordLabelRoleJobs(env));
  return response({ jobId: id, status: changes.length ? "pending" : "completed", additions: snapshot.additions.length, removals: snapshot.removals.length }, 202);
}
async function discordLabelJobStatus(request: Request, env: Env, jobId: string): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const job = await db.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, status, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt FROM discord_label_role_jobs WHERE installation_id = 'primary' AND id = ?").bind(jobId).first<{ id: string; labelId: string; guildId: string; roleId: string; status: string; createdAt: string; updatedAt: string; completedAt?: string }>();
  if (!job) throw new HttpError(404, "Role sync job not found");
  const items = await db.prepare("SELECT discord_user_id AS discordUserId, action, status, attempts, last_error AS lastError FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ? ORDER BY action, discord_user_id").bind(jobId).all<{ discordUserId: string; action: string; status: string; attempts: number; lastError?: string }>();
  return response({ ...job, items: items.results ?? [] });
}
async function processDiscordLabelRoleJobs(env: Env, targetJobId?: string): Promise<void> {
  const db = requireDatabase(env); const now = new Date().toISOString();
  const job = await db.prepare("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, source_fingerprint AS sourceFingerprint, actor_user_id AS actorUserId FROM discord_label_role_jobs WHERE installation_id = 'primary' AND status IN ('pending', 'running') AND next_attempt_at <= ? AND (lease_token IS NULL OR lease_expires_at <= ?) AND (? IS NULL OR id = ?) ORDER BY created_at LIMIT 1").bind(now, now, targetJobId ?? null, targetJobId ?? null).first<{ id: string; labelId: string; guildId: string; roleId: string; sourceFingerprint: string; actorUserId?: string }>();
  if (!job) return;
  const lease = crypto.randomUUID(); const leaseExpires = new Date(Date.now() + 90_000).toISOString();
  const claim = await db.prepare("UPDATE discord_label_role_jobs SET status = 'running', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND status IN ('pending', 'running') AND (lease_token IS NULL OR lease_expires_at <= ?)").bind(lease, leaseExpires, now, job.id, now).run();
  if ((claim.meta?.changes ?? 0) !== 1) return;
  let nextAttempt = new Date().toISOString();
  try {
    const config = await discordConfiguration(env); const mapping = await discordLabelMapping(db, job.labelId);
    if (config.guildId !== job.guildId || mapping.roleId !== job.roleId || (await discordLabelSource(db, mapping, config.guildId)).sourceFingerprint !== job.sourceFingerprint) {
      await db.prepare("UPDATE discord_label_role_jobs SET status = 'stale', lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE installation_id = 'primary' AND id = ? AND lease_token = ?").bind(new Date().toISOString(), new Date().toISOString(), job.id, lease).run();
      if (job.actorUserId) await writeAudit(db, { userId: job.actorUserId, role: "admin", expiresAt: 0 }, "discord.label_role_sync_stale", "member_label", job.labelId, { jobId: job.id, roleId: job.roleId });
      return;
    }
    await discordManageableRole(config, job.roleId);
    const rows = await db.prepare("SELECT discord_user_id AS discordUserId, action, attempts FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ? AND status = 'pending' ORDER BY discord_user_id LIMIT 20").bind(job.id).all<{ discordUserId: string; action: "add" | "remove"; attempts: number }>();
    for (const item of rows.results ?? []) {
      const path = `/guilds/${job.guildId}/members/${item.discordUserId}/roles/${job.roleId}`;
      try {
        await discordRequest(config, path, { method: item.action === "add" ? "PUT" : "DELETE", headers: { "x-audit-log-reason": encodeURIComponent(`LancerLogin label sync ${job.id}`) } });
        await db.prepare("UPDATE discord_label_role_job_items SET status = 'completed', attempts = attempts + 1, last_error = NULL WHERE installation_id = 'primary' AND job_id = ? AND discord_user_id = ? AND status = 'pending'").bind(job.id, item.discordUserId).run();
      } catch (error) {
        if (error instanceof DiscordRateLimitError) { nextAttempt = new Date(Date.now() + error.retryAfterMs).toISOString(); break; }
        await db.prepare("UPDATE discord_label_role_job_items SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE installation_id = 'primary' AND job_id = ? AND discord_user_id = ? AND status = 'pending'").bind((error as Error).message.slice(0, 300), job.id, item.discordUserId).run();
      }
    }
  } catch (error) {
    if (error instanceof DiscordRateLimitError) nextAttempt = new Date(Date.now() + error.retryAfterMs).toISOString();
    else {
      await db.prepare("UPDATE discord_label_role_jobs SET status = 'partial', lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE installation_id = 'primary' AND id = ? AND lease_token = ?").bind(new Date().toISOString(), new Date().toISOString(), job.id, lease).run();
      await db.prepare("UPDATE discord_label_role_job_items SET status = 'failed', last_error = ? WHERE installation_id = 'primary' AND job_id = ? AND status = 'pending'").bind((error as Error).message.slice(0, 300), job.id).run();
      if (job.actorUserId) await writeAudit(db, { userId: job.actorUserId, role: "admin", expiresAt: 0 }, "discord.label_role_sync_partial", "member_label", job.labelId, { jobId: job.id, roleId: job.roleId, error: (error as Error).message.slice(0, 300) });
      return;
    }
  }
  const counts = await db.prepare("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ?").bind(job.id).first<{ pending: number; failed: number }>();
  const status = counts?.pending ? "pending" : counts?.failed ? "partial" : "completed"; const finished = new Date().toISOString();
  await db.prepare("UPDATE discord_label_role_jobs SET status = ?, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?, completed_at = ? WHERE installation_id = 'primary' AND id = ? AND lease_token = ?").bind(status, nextAttempt, finished, status === "pending" ? null : finished, job.id, lease).run();
  if (status !== "pending" && job.actorUserId) await writeAudit(db, { userId: job.actorUserId, role: "admin", expiresAt: 0 }, "discord.label_role_sync_finished", "member_label", job.labelId, { jobId: job.id, roleId: job.roleId, status, failed: counts?.failed ?? 0 });
}
async function discordLabelAdvance(request: Request, env: Env, jobId: string): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const job = await requireDatabase(env).prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND id = ?").bind(jobId).first();
  if (!job) throw new HttpError(404, "Role sync job not found");
  await processDiscordLabelRoleJobs(env, jobId);
  return discordLabelJobStatus(request, env, jobId);
}
async function discordLabelRetry(request: Request, env: Env, jobId: string, context?: WorkerContext): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const old = await db.prepare("SELECT id, label_id AS labelId, role_id AS roleId, status FROM discord_label_role_jobs WHERE installation_id = 'primary' AND id = ?").bind(jobId).first<{ id: string; labelId: string; roleId: string; status: string }>();
  if (!old || old.status !== "partial") throw new HttpError(409, "Only a partially failed role sync can be retried");
  if (await db.prepare("SELECT id FROM discord_label_role_jobs WHERE installation_id = 'primary' AND label_id = ? AND status IN ('pending', 'running')").bind(old.labelId).first()) throw new HttpError(409, "A sync for this label is already in progress");
  const config = await discordConfiguration(env); const snapshot = await discordRoleSnapshot(db, config, old.labelId);
  if (snapshot.mapping.roleId !== old.roleId) throw new HttpError(409, "The role association changed. Preview a new sync.");
  const failed = await db.prepare("SELECT discord_user_id AS discordUserId, action FROM discord_label_role_job_items WHERE installation_id = 'primary' AND job_id = ? AND status = 'failed'").bind(jobId).all<{ discordUserId: string; action: string }>();
  const wanted = new Map([...snapshot.additions.map((item) => [item.discordUserId, "add"] as const), ...snapshot.removals.map((item) => [item.discordUserId, "remove"] as const)]);
  const changes = (failed.results ?? []).filter((item) => wanted.get(item.discordUserId) === item.action);
  if (!changes.length) return response({ retried: 0, resolved: (failed.results ?? []).length });
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO discord_label_role_jobs (id, installation_id, label_id, guild_id, role_id, status, source_fingerprint, actor_user_id, next_attempt_at, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").bind(id, old.labelId, config.guildId, old.roleId, snapshot.sourceFingerprint, principal.userId, now, now, now),
    ...changes.map((item) => db.prepare("INSERT INTO discord_label_role_job_items (installation_id, job_id, discord_user_id, action, status) VALUES ('primary', ?, ?, ?, 'pending')").bind(id, item.discordUserId, item.action)),
  ]);
  await writeAudit(db, principal, "discord.label_role_sync_retried", "member_label", old.labelId, { fromJobId: jobId, jobId: id, retried: changes.length });
  if (context) context.waitUntil(processDiscordLabelRoleJobs(env));
  return response({ jobId: id, retried: changes.length, resolved: (failed.results ?? []).length - changes.length }, 202);
}
async function discordInteraction(request: Request, env: Env): Promise<Response> {
  const { config, record } = await discordInteractionConfiguration(env); const raw = await request.text();
  if (!await verifyDiscordInteraction(request, config, raw)) throw new HttpError(401, "Discord interaction signature is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return discordEphemeral("This Discord request is malformed. Try the command again, or ask an Operator for help."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return discordEphemeral("This Discord request is malformed. Try the command again, or ask an Operator for help.");
  const interaction = parsed as { type?: number; guild_id?: string; channel_id?: string; data?: { custom_id?: string; name?: string; options?: { name?: string; value?: string }[] }; member?: { user?: { id?: string } }; user?: { id?: string }; message?: { id?: string } };
  if (interaction.type === 1) return response({ type: 1 });
  const customId = interaction.data?.custom_id ?? ""; const rawDiscordUserId = interaction.member?.user?.id ?? interaction.user?.id; const discordUserId = typeof rawDiscordUserId === "string" && /^\d{10,24}$/.test(rawDiscordUserId) ? rawDiscordUserId : undefined; const messageId = interaction.message?.id; const db = requireDatabase(env);
  if (record.enabled === 0) return discordEphemeral("LancerLogin's Discord integration is disabled. Ask an Admin to enable and verify it before trying again.");
  if (interaction.type === 3 && customId.startsWith("lancerlogin-verify:") && discordUserId && messageId) {
    const token = customId.slice("lancerlogin-verify:".length);
    const challenge = await db.prepare("SELECT challenge_hash AS challengeHash, target, external_id AS externalId, expires_at AS expiresAt FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'discord'").first<{ challengeHash: string; target: string; externalId: string; expiresAt: string }>();
    if (!challenge || challenge.expiresAt <= new Date().toISOString() || challenge.challengeHash !== await sha256(token) || challenge.externalId !== messageId || challenge.target !== interaction.guild_id) return discordEphemeral("This LancerLogin verification request is invalid or expired. Start verification again from the dashboard.");
    await markIntegrationVerified(db, "discord", null, { discordUserId, guildId: interaction.guild_id, messageId });
    return discordEphemeral("LancerLogin is verified. You can return to the dashboard.");
  }
  if (!record?.verifiedAt) return discordEphemeral("This LancerLogin Discord integration has not been verified by an Admin.");
  if (interaction.type === 2 && interaction.data?.name === "label") {
    if (interaction.guild_id !== config.guildId || !discordUserId) return discordEphemeral("Use /label in the configured Discord server with a paired Admin account.");
    try {
      const admin = await discordLabelAdmin(db, discordUserId);
      const roleId = interaction.data.options?.find((option) => option.name === "role")?.value;
      if (!discordSnowflake(roleId)) return discordEphemeral("Choose a Discord role with /label @ROLE.");
      const role = await discordManageableRole(config, roleId);
      const label = await db.prepare("SELECT id, name FROM member_labels WHERE installation_id = 'primary' AND active = 1 AND name = ? COLLATE NOCASE").bind(role.name).first<{ id: string; name: string }>();
      if (!label) return discordEphemeral(`No active LancerLogin label exactly matches the role ${role.name}. No association was made.`);
      const conflict = await db.prepare("SELECT label_id AS labelId, role_id AS roleId FROM discord_label_role_mappings WHERE installation_id = 'primary' AND (label_id = ? OR (guild_id = ? AND role_id = ?))").bind(label.id, config.guildId, roleId).first<{ labelId: string; roleId: string }>();
      if (conflict) return discordEphemeral(conflict.labelId === label.id && conflict.roleId === roleId ? "That label and Discord role are already associated." : "That label or Discord role is already associated with a different counterpart. Unlink it in Settings first.");
      const token = crypto.randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      await db.prepare("INSERT INTO discord_label_role_challenges (id_hash, installation_id, label_id, guild_id, role_id, discord_user_id, expires_at, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(await sha256(token), label.id, config.guildId, roleId, discordUserId, expiresAt, now.toISOString()).run();
      await writeAudit(db, admin, "discord.label_role_association_offered", "member_label", label.id, { roleId, guildId: config.guildId });
      return response({ type: 4, data: { content: `Associate Discord role **${role.name}** with LancerLogin label **${label.name}**? This saves the mapping. Role assignments change only when an Admin runs Sync to Discord in the dashboard.`, flags: 64, allowed_mentions: { parse: [] }, components: [{ type: 1, components: [{ type: 2, style: 1, label: "Confirm association", custom_id: `lancerlogin-label:${token}` }] }] } });
    } catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "The label association could not be prepared. Try again or ask an Admin to check the integration."); }
  }
  if (interaction.type === 3 && customId.startsWith("lancerlogin-label:")) {
    if (interaction.guild_id !== config.guildId || !discordUserId) return discordEphemeral("This label confirmation is invalid for this server.");
    try {
      const admin = await discordLabelAdmin(db, discordUserId);
      const token = customId.slice("lancerlogin-label:".length);
      if (!/^[0-9a-f-]{36}$/.test(token)) return discordEphemeral("This label confirmation is invalid or expired. Run /label again.");
      const hash = await sha256(token); const challenge = await db.prepare("SELECT label_id AS labelId, guild_id AS guildId, role_id AS roleId, discord_user_id AS discordUserId, expires_at AS expiresAt, used_at AS usedAt FROM discord_label_role_challenges WHERE installation_id = 'primary' AND id_hash = ?").bind(hash).first<{ labelId: string; guildId: string; roleId: string; discordUserId: string; expiresAt: string; usedAt?: string }>();
      if (!challenge || challenge.discordUserId !== discordUserId || challenge.guildId !== config.guildId || challenge.usedAt || challenge.expiresAt <= new Date().toISOString()) return discordEphemeral("This label confirmation is invalid or expired. Run /label again.");
      const role = await discordManageableRole(config, challenge.roleId);
      const label = await db.prepare("SELECT id, name FROM member_labels WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(challenge.labelId).first<{ id: string; name: string }>();
      if (!label || label.name.toLocaleLowerCase() !== role.name.toLocaleLowerCase()) return discordEphemeral("The label or Discord role changed. Run /label again.");
      const conflict = await db.prepare("SELECT label_id FROM discord_label_role_mappings WHERE installation_id = 'primary' AND (label_id = ? OR (guild_id = ? AND role_id = ?))").bind(label.id, config.guildId, role.id).first();
      if (conflict) return discordEphemeral("That label or role is already associated. Review it in Settings.");
      const now = new Date().toISOString(); const claimed = await db.prepare("UPDATE discord_label_role_challenges SET used_at = ? WHERE installation_id = 'primary' AND id_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, hash, now).run();
      if ((claimed.meta?.changes ?? 0) !== 1) return discordEphemeral("This confirmation was already used. Run /label again.");
      try { await db.prepare("INSERT INTO discord_label_role_mappings (installation_id, label_id, guild_id, role_id, role_name, created_by, created_at) VALUES ('primary', ?, ?, ?, ?, ?, ?)").bind(label.id, config.guildId, role.id, role.name, admin.userId, now).run(); }
      catch (error) { if (/unique|constraint/i.test(String(error))) return discordEphemeral("That label or role was associated by another Admin. Review it in Settings."); throw error; }
      await writeAudit(db, admin, "discord.label_role_associated", "member_label", label.id, { guildId: config.guildId, roleId: role.id });
      return discordEphemeral(`Associated **${label.name}** with **${role.name}**. Review and run Sync to Discord in Settings when ready.`);
    } catch (error) { return discordEphemeral(error instanceof HttpError ? error.message : "The label association could not be saved. Try again or ask an Admin to check the integration."); }
  }
  if (interaction.type === 2 && interaction.data?.name === "attendance-report") {
    if (interaction.guild_id !== config.guildId) return discordEphemeral("Use this command in the Discord server configured for this LancerLogin installation.");
    if (!discordUserId || interaction.data.options !== undefined && (!Array.isArray(interaction.data.options) || interaction.data.options.length > 0)) return discordEphemeral("This attendance-report request is malformed. Try /attendance-report again, or ask an Operator for help.");
    return discordEphemeral(await discordAttendanceReport(db, discordUserId));
  }
  if (interaction.type === 3 && customId === "lancerlogin-attendance-report") {
    if (interaction.guild_id !== config.guildId) return discordEphemeral("Use this button in the Discord server configured for this LancerLogin installation.");
    if (!discordUserId || !messageId || interaction.channel_id !== config.channelId) return discordEphemeral("This attendance-report button is invalid or expired. Ask an Operator for help.");
    const manager = await db.prepare("SELECT discord_channel_manager_enabled AS enabled FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number }>();
    const tracked = await db.prepare("SELECT external_id AS externalId FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'channel-manager-howto'").first<{ externalId?: string }>();
    if (!manager?.enabled || !tracked?.externalId || tracked.externalId !== messageId) return discordEphemeral("This attendance-report button is invalid or expired. Ask an Operator for help.");
    return discordEphemeral(await discordAttendanceReport(db, discordUserId));
  }
  if (interaction.type === 2 && interaction.data?.name === "pair" && discordUserId && interaction.guild_id === config.guildId) {
    const memberId = interaction.data.options?.find((option) => option.name === "member-id")?.value?.trim();
    if (!memberId || memberId.length > 80) return discordEphemeral("Provide your LancerLogin member ID with /pair. Ask an Operator for help if you need it.");
    const member = await db.prepare("SELECT id, discord_user_id AS discordUserId, active FROM members WHERE installation_id = 'primary' AND external_id = ?").bind(memberId).first<{ id: string; discordUserId?: string; active: number }>();
    if (!member || !member.active || member.discordUserId) return discordEphemeral("That member ID cannot be paired. Ask an Operator for help.");
    const existing = await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND discord_user_id = ?").bind(discordUserId).first<{ id: string }>();
    if (existing) return discordEphemeral("This Discord account is already paired. Ask an Operator for help.");
    await db.batch([
      db.prepare("UPDATE members SET discord_user_id = ? WHERE installation_id = 'primary' AND id = ? AND active = 1 AND discord_user_id IS NULL").bind(discordUserId, member.id),
      db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', NULL, 'discord.member_self_paired', 'member', ?, ?, ?)").bind(crypto.randomUUID(), member.id, JSON.stringify({ discordUserId }), new Date().toISOString()),
    ]);
    return discordEphemeral("Your Discord account is now paired with your LancerLogin roster entry.");
  }
  const meetingId = customId.startsWith("lancerlogin-attendance:") ? customId.slice("lancerlogin-attendance:".length) : "";
  if (interaction.type !== 3 || !meetingId || !discordUserId || !messageId) return discordEphemeral("This attendance contest button is invalid or expired. Ask an Operator for help.");
  const recipient = await db.prepare("SELECT r.member_id AS memberId, r.delivered_at AS deliveredAt FROM discord_attendance_recipients r JOIN members m ON m.installation_id = r.installation_id AND m.id = r.member_id WHERE r.installation_id = 'primary' AND r.meeting_id = ? AND r.message_id = ? AND r.discord_user_id = ? AND m.discord_user_id = ? AND m.active = 1").bind(meetingId, messageId, discordUserId, discordUserId).first<{ memberId: string; deliveredAt: string }>();
  if (!recipient) return discordEphemeral("This notice does not match your current linked roster account. Use a notice sent after your Discord link was saved, or ask an Operator for help.");
  const contestWindow = await db.prepare("SELECT discord_contest_window_hours AS discordContestWindowHours FROM organization_settings WHERE installation_id = 'primary'").first<{ discordContestWindowHours?: number }>();
  if (Date.now() > Date.parse(recipient.deliveredAt) + (contestWindow?.discordContestWindowHours ?? 24) * 3_600_000) return discordEphemeral("This absence notice has expired. Ask an Operator to review your attendance.");
  if (!(await linkedAbsentMembers(db, meetingId)).some((member) => member.id === recipient.memberId)) return discordEphemeral("Attendance no longer shows you as absent, so no contest was created.");
  const now = new Date().toISOString(); await db.prepare("INSERT OR IGNORE INTO discord_attendance_contests (installation_id, meeting_id, member_id, message_id, status, created_at, submitted_by_discord_user_id) VALUES ('primary', ?, ?, ?, 'open', ?, ?)").bind(meetingId, recipient.memberId, messageId, now, discordUserId).run();
  const contest = await db.prepare("SELECT status FROM discord_attendance_contests WHERE installation_id = 'primary' AND meeting_id = ? AND member_id = ?").bind(meetingId, recipient.memberId).first<{ status: string }>();
  return contest?.status === "open" ? discordEphemeral("Your attendance contest was recorded for review. Your attendance has not been changed.") : discordEphemeral(`Your attendance contest was already reviewed with status ${contest?.status ?? "unknown"}.`);
}
type DiscordCalendarOutcome = { meetingId: string; title: string; status: "synced" | "queued" | "skipped" | "failed"; reason?: string };
type DiscordCalendarSyncSummary = { synced: number; queued: number; skipped: number; failed: number; outcomes: DiscordCalendarOutcome[] };
type DiscordCalendarOperation = { meetingId: string; generation: number; action: "upsert" | "delete"; eventId?: string | null; status: "pending" | "processing" | "delivered" | "failed"; attempts: number; revision: number; actorUserId?: string | null; leaseToken?: string };
type DiscordCalendarSyncCursor = { startsAt: string; id: string };
const DISCORD_CALENDAR_OPERATION_BATCH_LIMIT = 10;
const DISCORD_CALENDAR_SYNC_ALL_LIMIT = 100;
const discordCalendarEmptySummary = (): DiscordCalendarSyncSummary => ({ synced: 0, queued: 0, skipped: 0, failed: 0, outcomes: [] });
async function discordCalendarIsReady(env: Env): Promise<boolean> { const record = await integrationRecord(env, "discord"); return Boolean(record?.enabled && record.verifiedAt); }
function discordCalendarRetryAt(attempts: number, error: unknown): string | null {
  if (error instanceof DiscordPermissionError) return null;
  if (error instanceof DiscordResponseError && error.discordStatus < 500) return null;
  const requested = error instanceof DiscordRateLimitError ? error.retryAfterMs : 0;
  return new Date(Date.now() + Math.min(3_600_000, Math.max(60_000, 2 ** Math.min(attempts, 12) * 1_000, requested))).toISOString();
}
async function markDiscordCalendarFailure(db: D1Database, operation: DiscordCalendarOperation, error: unknown): Promise<string> {
  const message = (error instanceof Error ? error.message : "Discord calendar delivery failed. LancerLogin will retry automatically.").slice(0, 300); const attempts = Number(operation.attempts ?? 0) + 1; const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE discord_calendar_event_mappings SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = ? AND lease_token = ?)").bind(message, now, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.action, operation.leaseToken),
    db.prepare("UPDATE discord_calendar_operations SET status = 'failed', attempts = ?, next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = ? AND lease_token = ?").bind(attempts, discordCalendarRetryAt(attempts, error), message, now, operation.meetingId, operation.generation, operation.action, operation.leaseToken),
  ]);
  return message;
}
async function enqueueDiscordCalendarUpsert(db: D1Database, env: Env, principal: Principal | null, ids: string[]): Promise<DiscordCalendarSyncSummary> {
  const ready = await discordCalendarIsReady(env); const now = new Date().toISOString(); const queuedIds: string[] = [];
  for (const id of ids) {
    const meeting = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(id).first<{ id: string }>();
    if (!meeting) continue;
    let mapping = await db.prepare("SELECT generation, active FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ?").bind(id).first<{ generation: number; active: number }>();
    if ((!mapping || !mapping.active) && !ready) continue;
    if (!mapping) {
      await db.prepare("INSERT INTO discord_calendar_event_mappings (installation_id, meeting_id, event_id, generation, active, updated_at) VALUES ('primary', ?, NULL, 1, 1, ?)").bind(id, now).run();
      mapping = { generation: 1, active: 1 };
    } else if (!mapping.active) {
      const generation = Number(mapping.generation) + 1;
      await db.prepare("UPDATE discord_calendar_event_mappings SET event_id = NULL, generation = ?, active = 1, synced_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(generation, now, id).run();
      mapping = { generation, active: 1 };
    }
    await db.prepare("INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, actor_user_id, updated_at) VALUES ('primary', ?, ?, 'upsert', NULL, 'pending', 0, ?, ?, ?) ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET revision = discord_calendar_operations.revision + 1, status = CASE WHEN discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > excluded.updated_at THEN 'processing' ELSE 'pending' END, next_attempt_at = excluded.next_attempt_at, last_error = NULL, actor_user_id = COALESCE(excluded.actor_user_id, discord_calendar_operations.actor_user_id), updated_at = excluded.updated_at").bind(id, mapping.generation, now, principal?.userId ?? null, now).run();
    queuedIds.push(id);
  }
  return ready && queuedIds.length ? processDiscordCalendarOperations(env, queuedIds) : { ...discordCalendarEmptySummary(), queued: queuedIds.length, outcomes: queuedIds.map((meetingId) => ({ meetingId, title: "Meeting", status: "queued", reason: "Discord delivery is paused until the integration is enabled and verified" })) };
}
async function enqueueDiscordCalendarDelete(db: D1Database, env: Env, principal: Principal | null, ids: string[]): Promise<DiscordCalendarSyncSummary> {
  const now = new Date().toISOString(); const queuedIds: string[] = [];
  for (const id of ids) {
    const mapping = await db.prepare("SELECT event_id AS eventId, generation FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ?").bind(id).first<{ eventId?: string | null; generation: number }>();
    if (!mapping) continue;
    await db.prepare("UPDATE discord_calendar_operations SET revision = revision + 1, status = CASE WHEN status = 'processing' AND lease_expires_at > ? THEN 'processing' ELSE 'delivered' END, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND status != 'delivered'").bind(now, now, id, mapping.generation).run();
    await db.prepare("UPDATE discord_calendar_event_mappings SET active = 0, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(now, id).run();
    if (!mapping.eventId) continue;
    await db.prepare("INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, actor_user_id, updated_at) VALUES ('primary', ?, ?, 'delete', ?, 'pending', 0, ?, ?, ?) ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET event_id = excluded.event_id, revision = discord_calendar_operations.revision + 1, status = CASE WHEN discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > excluded.updated_at THEN 'processing' ELSE 'pending' END, next_attempt_at = excluded.next_attempt_at, last_error = NULL, actor_user_id = COALESCE(excluded.actor_user_id, discord_calendar_operations.actor_user_id), updated_at = excluded.updated_at").bind(id, mapping.generation, mapping.eventId, now, principal?.userId ?? null, now).run();
    queuedIds.push(id);
  }
  return queuedIds.length && await discordCalendarIsReady(env) ? processDiscordCalendarOperations(env, queuedIds) : { ...discordCalendarEmptySummary(), queued: queuedIds.length };
}
async function enqueueDiscordCalendarRestore(db: D1Database, env: Env, principal: Principal | null, ids: string[]): Promise<DiscordCalendarSyncSummary> {
  const now = new Date().toISOString(); const ready = await discordCalendarIsReady(env); const queuedIds: string[] = []; const missingIds: string[] = [];
  for (const id of ids) {
    const mapping = await db.prepare("SELECT event_id AS eventId, generation FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ?").bind(id).first<{ eventId?: string | null; generation: number }>();
    if (!mapping) { if (ready) missingIds.push(id); continue; }
    await db.prepare("UPDATE discord_calendar_operations SET revision = revision + 1, status = CASE WHEN status = 'processing' AND lease_expires_at > ? THEN 'processing' ELSE 'delivered' END, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND status != 'delivered'").bind(now, now, id, mapping.generation).run();
    if (mapping.eventId) await db.prepare("INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, actor_user_id, updated_at) VALUES ('primary', ?, ?, 'delete', ?, 'pending', 0, ?, ?, ?) ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET revision = discord_calendar_operations.revision + 1, status = CASE WHEN discord_calendar_operations.status = 'processing' AND discord_calendar_operations.lease_expires_at > excluded.updated_at THEN 'processing' ELSE 'pending' END, next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at").bind(id, mapping.generation, mapping.eventId, now, principal?.userId ?? null, now).run();
    const generation = Number(mapping.generation) + 1;
    await db.batch([
      db.prepare("UPDATE discord_calendar_event_mappings SET event_id = NULL, generation = ?, active = 1, synced_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(generation, now, id),
      db.prepare("INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, actor_user_id, updated_at) VALUES ('primary', ?, ?, 'upsert', NULL, 'pending', 0, ?, ?, ?)").bind(id, generation, now, principal?.userId ?? null, now),
    ]);
    queuedIds.push(id);
  }
  if (ready) {
    const created = await enqueueDiscordCalendarUpsert(db, env, principal, missingIds);
    return addDiscordCalendarSummaries(queuedIds.length ? await processDiscordCalendarOperations(env, queuedIds) : discordCalendarEmptySummary(), created);
  }
  return { ...discordCalendarEmptySummary(), queued: queuedIds.length };
}
function addDiscordCalendarSummaries(...summaries: DiscordCalendarSyncSummary[]): DiscordCalendarSyncSummary { return summaries.reduce((total, item) => ({ synced: total.synced + item.synced, queued: total.queued + item.queued, skipped: total.skipped + item.skipped, failed: total.failed + item.failed, outcomes: [...total.outcomes, ...item.outcomes] }), discordCalendarEmptySummary()); }
type DiscordScheduledEvent = { id?: string; entity_metadata?: { location?: string } };
async function discordCalendarCorrelationLocation(meetingId: string, generation: number): Promise<string> { return `LancerLogin · ${(await sha256(`discord-calendar:primary:${meetingId}:${generation}`)).slice(0, 24)}`; }
async function reconcileDiscordCalendarEvent(config: Record<string, string>, correlationLocation: string): Promise<string | undefined> {
  const listed = await discordRequest<DiscordScheduledEvent[]>(config, `/guilds/${config.guildId}/scheduled-events`, { method: "GET" });
  if (!Array.isArray(listed.body)) throw new DiscordResponseError(502, "Discord did not return a scheduled event list");
  return listed.body.find((event) => event.entity_metadata?.location === correlationLocation && typeof event.id === "string" && event.id.length > 0)?.id;
}
async function processDiscordCalendarOperations(env: Env, meetingIds?: string[]): Promise<DiscordCalendarSyncSummary> {
  if (!await discordCalendarIsReady(env)) return discordCalendarEmptySummary();
  const db = requireDatabase(env); const now = new Date().toISOString(); const filter = meetingIds?.length ? `AND o.meeting_id IN (${meetingIds.map(() => "?").join(",")}) AND (o.status IN ('pending', 'failed') OR (o.status = 'processing' AND o.lease_expires_at <= ?))` : "AND (o.status = 'pending' OR (o.status = 'failed' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at <= ?) OR (o.status = 'processing' AND o.lease_expires_at <= ?))"; const values = meetingIds?.length ? [...meetingIds, now] : [now, now];
  const result = await db.prepare(`SELECT o.meeting_id AS meetingId, o.generation, o.action, o.event_id AS eventId, o.status, o.attempts, o.revision, o.actor_user_id AS actorUserId FROM discord_calendar_operations o WHERE o.installation_id = 'primary' ${filter} ORDER BY o.generation, CASE o.action WHEN 'delete' THEN 0 ELSE 1 END, o.updated_at LIMIT ${DISCORD_CALENDAR_OPERATION_BATCH_LIMIT}`).bind(...values).all<DiscordCalendarOperation>();
  const operations = result.results ?? []; if (!operations.length) return discordCalendarEmptySummary();
  let config: Record<string, string>; try { config = await discordConfiguration(env); } catch { return { ...discordCalendarEmptySummary(), queued: operations.length }; }
  const summary = discordCalendarEmptySummary();
  for (const operation of operations) {
    operation.leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const claimed = await db.prepare("UPDATE discord_calendar_operations SET status = 'processing', lease_token = ?, lease_expires_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = ? AND revision = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND lease_expires_at <= ?))").bind(operation.leaseToken, leaseExpiresAt, operation.meetingId, operation.generation, operation.action, operation.revision, now).run();
    if ((claimed.meta?.changes ?? 0) < 1) continue;
    let title = "Meeting";
    try {
      if (operation.action === "delete") {
        try { await discordRequest(config, `/guilds/${config.guildId}/scheduled-events/${operation.eventId}`, { method: "DELETE" }); }
        catch (error) { if (!(error instanceof DiscordResponseError) || error.discordStatus !== 404) throw error; }
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
        let needsReconciliation = started || operation.status === "processing" || Number(operation.attempts) > 0;
        if (eventId) try { await discordRequest(config, `/guilds/${config.guildId}/scheduled-events/${eventId}`, { method: "PATCH", body: JSON.stringify(payload) }); needsReconciliation = false; } catch (error) { if (error instanceof DiscordResponseError && error.discordStatus === 404) { eventId = undefined; needsReconciliation = true; } else throw error; }
        if (!eventId && needsReconciliation) eventId = await reconcileDiscordCalendarEvent(config, correlationLocation);
        if (eventId && needsReconciliation) await discordRequest(config, `/guilds/${config.guildId}/scheduled-events/${eventId}`, { method: "PATCH", body: JSON.stringify(payload) });
        if (!eventId && started) {
          await db.prepare("UPDATE discord_calendar_operations SET status = CASE WHEN revision = ? THEN 'delivered' ELSE 'pending' END, next_attempt_at = CASE WHEN revision = ? THEN NULL ELSE ? END, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?").bind(operation.revision, operation.revision, now, now, operation.meetingId, operation.generation, operation.leaseToken).run();
          summary.skipped += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "skipped", reason: "Meeting has already started and has no Discord event. Sync upcoming meetings before their start time." }); continue;
        }
        if (!eventId) { const created = await discordRequest(config, `/guilds/${config.guildId}/scheduled-events`, { method: "POST", body: JSON.stringify(payload) }); eventId = String(created.body.id ?? ""); if (!eventId) throw new DiscordResponseError(502, "Discord did not return a scheduled event ID"); }
        const completedAt = new Date().toISOString(); const completion = await db.batch([
          db.prepare("UPDATE discord_calendar_event_mappings SET event_id = ?, synced_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1 AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?)").bind(eventId, completedAt, completedAt, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, updated_at) SELECT 'primary', 'discord', ?, ?, ? WHERE EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, updated_at = excluded.updated_at").bind(`calendar:${operation.meetingId}`, eventId, completedAt, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("INSERT INTO discord_calendar_operations (installation_id, meeting_id, generation, action, event_id, status, attempts, next_attempt_at, actor_user_id, updated_at) SELECT 'primary', ?, ?, 'delete', ?, 'pending', 0, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) AND EXISTS (SELECT 1 FROM discord_calendar_operations WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?) ON CONFLICT(installation_id, meeting_id, generation, action) DO UPDATE SET event_id = excluded.event_id, revision = discord_calendar_operations.revision + 1, status = 'pending', next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at").bind(operation.meetingId, operation.generation, eventId, completedAt, operation.actorUserId ?? null, completedAt, operation.meetingId, operation.generation, operation.meetingId, operation.generation, operation.leaseToken),
          db.prepare("UPDATE discord_calendar_operations SET event_id = ?, status = CASE WHEN revision != ? AND EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) THEN 'pending' ELSE 'delivered' END, attempts = attempts + 1, next_attempt_at = CASE WHEN revision != ? AND EXISTS (SELECT 1 FROM discord_calendar_event_mappings WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND active = 1) THEN ? ELSE NULL END, lease_token = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND generation = ? AND action = 'upsert' AND lease_token = ?").bind(eventId, operation.revision, operation.meetingId, operation.generation, operation.revision, operation.meetingId, operation.generation, completedAt, completedAt, operation.meetingId, operation.generation, operation.leaseToken),
        ]);
        if ((completion[3]?.meta?.changes ?? 1) > 0) await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'discord.calendar_synced', 'meeting', ?, ?, ?)").bind(crypto.randomUUID(), operation.actorUserId ?? null, operation.meetingId, JSON.stringify({ eventId }), completedAt).run();
      }
      summary.synced += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "synced" });
    } catch (error) { const reason = await markDiscordCalendarFailure(db, operation, error); summary.failed += 1; summary.outcomes.push({ meetingId: operation.meetingId, title, status: "failed", reason }); if (error instanceof DiscordPermissionError || error instanceof DiscordRateLimitError) break; }
  }
  const processedMeetings = new Set(summary.outcomes.map((outcome) => outcome.meetingId));
  summary.queued = meetingIds?.length
    ? Math.max(0, new Set(meetingIds).size - processedMeetings.size)
    : Math.max(0, operations.length - summary.synced - summary.skipped - summary.failed);
  return summary;
}
function encodeDiscordCalendarSyncCursor(cursor: DiscordCalendarSyncCursor): string { return btoa(JSON.stringify([cursor.startsAt, cursor.id])); }
function decodeDiscordCalendarSyncCursor(value: string | null): DiscordCalendarSyncCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || !parsed[0] || !parsed[1]) throw new Error("invalid");
    return { startsAt: parsed[0], id: parsed[1] };
  } catch { throw new HttpError(400, "Discord calendar sync cursor is invalid"); }
}
async function syncAllDiscordCalendarMeetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); await requireIntegrationConfigured(env, "discord"); const db = requireDatabase(env);
  const cursor = decodeDiscordCalendarSyncCursor(new URL(request.url).searchParams.get("after"));
  const page = await db.prepare("SELECT id, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL AND (? IS NULL OR starts_at > ? OR (starts_at = ? AND id > ?)) ORDER BY starts_at ASC, id ASC LIMIT ?").bind(cursor?.startsAt ?? null, cursor?.startsAt ?? null, cursor?.startsAt ?? null, cursor?.id ?? null, DISCORD_CALENDAR_OPERATION_BATCH_LIMIT + 1).all<DiscordCalendarSyncCursor>();
  const available = page.results ?? []; const meetings = available.slice(0, DISCORD_CALENDAR_OPERATION_BATCH_LIMIT);
  const result = await enqueueDiscordCalendarUpsert(db, env, principal, meetings.map((meeting) => meeting.id));
  const nextCursor = available.length > DISCORD_CALENDAR_OPERATION_BATCH_LIMIT && meetings.length ? encodeDiscordCalendarSyncCursor(meetings.at(-1)!) : null;
  await writeAudit(db, principal, "discord.calendar_sync_all_requested", "integration", "discord", { selected: meetings.length, continued: Boolean(cursor), hasMore: Boolean(nextCursor), ...result });
  return response({ ...result, selected: meetings.length, nextCursor, limit: DISCORD_CALENDAR_SYNC_ALL_LIMIT, batchLimit: DISCORD_CALENDAR_OPERATION_BATCH_LIMIT });
}
async function discordCalendar(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string; all?: boolean }>(request);
  if (input.all) { const result = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL ORDER BY starts_at ASC LIMIT 100").all<{ id: string }>(); return response(await enqueueDiscordCalendarUpsert(db, env, principal, (result.results ?? []).map((meeting) => meeting.id))); }
  if (!input.meetingId) throw new HttpError(400, "Meeting is required");
  const meeting = await db.prepare("SELECT id, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<{ id: string; endsAt: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found");
  if (Date.parse(meeting.endsAt) < Date.now()) throw new HttpError(409, "Discord calendar sync is unavailable after the scheduled meeting end");
  return response(await enqueueDiscordCalendarUpsert(db, env, principal, [meeting.id]));
}
type CalendarLifecycleAction = "sync" | "delete" | "restore";
type CalendarDeliveryResult = { google_calendar: GoogleCalendarSyncSummary; discord: DiscordCalendarSyncSummary };
async function deliverCalendarLifecycle(db: D1Database, env: Env, principal: Principal, action: CalendarLifecycleAction, meetingIds: string[]): Promise<CalendarDeliveryResult> {
  const google = await bestEffortGoogleCalendar(() => action === "delete" ? enqueueGoogleCalendarDelete(db, env, meetingIds) : action === "restore" ? restoreGoogleCalendarMeetings(db, env, meetingIds) : syncGoogleCalendarMeetings(db, env, meetingIds));
  let discord: DiscordCalendarSyncSummary;
  try { discord = action === "delete" ? await enqueueDiscordCalendarDelete(db, env, principal, meetingIds) : action === "restore" ? await enqueueDiscordCalendarRestore(db, env, principal, meetingIds) : await enqueueDiscordCalendarUpsert(db, env, principal, meetingIds); }
  catch (error) { discord = { ...discordCalendarEmptySummary(), failed: 1, outcomes: [{ meetingId: meetingIds[0] ?? "meeting", title: "Meeting", status: "failed", reason: error instanceof Error ? error.message : "Discord calendar delivery failed" }] }; }
  return { google_calendar: google, discord };
}
async function syncMeetingCalendars(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const input = await parseJson<{ meetingId?: string }>(request); const meetingId = input.meetingId?.trim();
  if (!meetingId) throw new HttpError(400, "Meeting is required"); const db = requireDatabase(env);
  const meeting = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ id: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found");
  const [googleReady, discordReady] = await Promise.all([googleCalendarIsReady(env), discordCalendarIsReady(env)]); if (!googleReady && !discordReady) throw new HttpError(409, "Configure and verify at least one calendar integration before syncing this meeting");
  const delivery = await deliverCalendarLifecycle(db, env, principal, "sync", [meeting.id]);
  const providers = [
    ...(googleReady ? [{ provider: "google_calendar" as const, ...delivery.google_calendar }] : []),
    ...(discordReady ? [{ provider: "discord" as const, ...delivery.discord }] : []),
  ];
  await writeAudit(db, principal, "calendar.meeting_sync_requested", "meeting", meeting.id, { providers: providers.map((item) => item.provider) });
  return response({ meetingId: meeting.id, providers });
}
async function syncDiscordKioskStatus(env: Env, pin?: boolean): Promise<{ changed: boolean; messageId?: string; online?: boolean; kioskId?: string }> {
  const db = requireDatabase(env); const config = await discordConfiguration(env);
  if (pin === undefined) {
    const settings = await db.prepare("SELECT discord_channel_manager_enabled AS enabled FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number }>();
    pin = Boolean(settings?.enabled);
  }
  const kiosk = await db.prepare("SELECT id, name, last_seen_at AS lastSeenAt, reader_online AS readerOnline, release_version AS releaseVersion FROM kiosks WHERE installation_id = 'primary' AND active = 1 ORDER BY created_at DESC LIMIT 1").first<{ id: string; name: string; lastSeenAt?: string; readerOnline?: number; releaseVersion?: string }>();
  const online = Boolean(kiosk?.lastSeenAt && Date.now() - Date.parse(kiosk.lastSeenAt) < 2 * 60_000);
  const content = kiosk
    ? `**${kiosk.name}** · ${online ? "online" : "offline"} · reader ${kiosk.readerOnline ? "online" : "offline"} · release ${kiosk.releaseVersion ?? "unknown"}${online ? "" : ` · last seen ${kiosk.lastSeenAt ?? "never"}`}`
    : "No kiosk is paired.";
  if (pin) {
    const tracked = await upsertTrackedDiscordMessage(db, config, "kiosk-status", content, true);
    return { changed: tracked.changed, messageId: tracked.messageId, online, kioskId: kiosk?.id };
  }
  const contentHash = await sha256(content);
  const existing = await db.prepare("SELECT external_id AS externalId, content_hash AS contentHash FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'kiosk-status'").first<{ externalId?: string; contentHash?: string }>();
  if (existing?.externalId && existing.contentHash === contentHash) {
    try {
      await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages/${encodeURIComponent(existing.externalId)}`, { method: "GET" });
      return { changed: false, messageId: existing.externalId, online, kioskId: kiosk?.id };
    } catch (error) { if (!discordMessageMissing(error)) throw error; existing.externalId = undefined; }
  }
  const messagesPath = `/channels/${encodeURIComponent(config.channelId)}/messages`;
  const payload = { method: existing?.externalId ? "PATCH" : "POST", body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) };
  let messageId: string;
  try {
    const { body } = await discordRequest(config, existing?.externalId ? `${messagesPath}/${encodeURIComponent(existing.externalId)}` : messagesPath, payload);
    messageId = String(body.id ?? existing?.externalId ?? "");
  } catch (error) {
    if (!(error instanceof DiscordResponseError) || error.discordStatus !== 404 || error.discordCode !== 10_008 || !existing?.externalId) throw error;
    const { body } = await discordRequest(config, messagesPath, { ...payload, method: "POST" });
    messageId = String(body.id ?? "");
  }
  if (!messageId) throw new HttpError(502, "Discord did not return a kiosk-status message identifier");
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', 'kiosk-status', ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(messageId, contentHash, now).run();
  return { changed: true, messageId, online, kioskId: kiosk?.id };
}
async function syncDiscordManagedSurface(env: Env): Promise<void> {
  const db = requireDatabase(env);
  const settings = await db.prepare("SELECT discord_channel_manager_enabled AS enabled FROM organization_settings WHERE installation_id = 'primary'").first<{ enabled?: number }>();
  if (!settings?.enabled) { await syncDiscordKioskStatus(env); return; }
  const config = await discordConfiguration(env);
  await syncDiscordKioskStatus(env, true);
  const guidance = "**LancerLogin attendance help**\nUse `/pair` with your LancerLogin member ID to link your Discord account. Use **View my attendance report** below or `/attendance-report` to receive your private report. Ask general questions in the thread under each absence notice. Only a mentioned linked member can use **Contest absence** during the configured contest window. A contest requests private review; it does not change attendance until an Operator or Admin approves it.";
  await upsertTrackedDiscordMessage(db, config, "channel-manager-howto", guidance, false, discordAttendanceReportComponents);
}
async function discordKioskStatus(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]);
  const result = await syncDiscordKioskStatus(env);
  await writeAudit(requireDatabase(env), principal, "discord.kiosk_status_updated", "kiosk", result.kioskId ?? null, { online: result.online, messageId: result.messageId, changed: result.changed });
  const config = await discordConfiguration(env);
  const messageUrl = result.messageId ? `https://discord.com/channels/${config.guildId}/${config.channelId}/${result.messageId}` : undefined;
  return response({ changed: result.changed, messageId: result.messageId, online: result.online, messageUrl });
}

// Compatibility endpoint for older authenticated clients. No consent writes or reports.
async function privacySettings(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  if (request.method === "PATCH") await parseJson<{ telemetryAccepted?: boolean }>(request);
  return response({ telemetryAccepted: false, acceptedAt: null, notice: "Anonymous usage reporting has been retired. No telemetry is collected or transmitted." });
}

type BackupScope = "meetings" | "roster" | "installation";
const tableColumns = {
  installations: ["id", "created_at", "auth_mode", "telemetry_accepted_at", "telemetry_install_id", "google_enabled", "resend_enabled", "discord_enabled", "google_calendar_enabled"],
  organization_settings: ["installation_id", "organization_name", "subtitle", "logo_data", "primary_color", "secondary_color", "appearance", "time_zone", "late_scan_minutes", "logo_backdrop", "discord_contest_window_hours", "discord_channel_manager_enabled", "attendance_reporting_starts_on", "anomaly_late_threshold_minutes", "anomaly_early_threshold_minutes", "discord_anomaly_reports_enabled", "discord_anomaly_report_channel_id", "discord_anomaly_reports_enabled_at", "attendance_recent_days", "attendance_policy_activated_on"],
  users: ["id", "installation_id", "email", "local_username", "password_hash", "failed_login_count", "locked_until", "role", "active", "created_at", "member_id", "debug_mode"],
  members: ["id", "installation_id", "external_id", "first_name", "last_name", "email", "discord_user_id", "active", "created_at", "attendance_required_from"],
  member_labels: ["id", "installation_id", "name", "active", "formula_enabled", "created_by", "created_at"],
  member_label_changes: ["id", "installation_id", "member_id", "label_id", "action", "effective_date", "created_by", "created_at"],
  discord_label_role_mappings: ["installation_id", "label_id", "guild_id", "role_id", "role_name", "created_by", "created_at"],
  label_weekly_targets: ["id", "installation_id", "label_id", "starts_on", "ends_on", "meetings_per_week", "created_by", "created_at"],
  label_attendance_rules: ["id", "installation_id", "label_id", "starts_on", "ends_on", "rule_type", "threshold_percent", "meetings_per_week", "created_by", "created_at", "updated_at", "excused_handling"],
  saved_report_views: ["id", "installation_id", "owner_user_id", "scope", "name", "definition_json", "revision", "created_by", "updated_by", "created_at", "updated_at"],
  saved_report_tabs: ["installation_id", "user_id", "report_view_id", "position", "pinned_at"],
  meeting_weight_categories: ["id", "installation_id", "name", "weight", "minimum_duration_minutes", "position", "active", "created_by", "created_at", "updated_at"],
  meetings: ["id", "installation_id", "title", "starts_at", "ends_at", "required", "notes", "created_by", "created_at", "is_test", "series_id", "recurrence_frequency", "recurrence_until", "recurrence_sequence", "deleted_at", "weight_category_id", "weight_category_name", "attendance_weight", "audience_mode"],
  meeting_audience_labels: ["installation_id", "meeting_id", "label_id"],
  meeting_templates: ["id", "installation_id", "name", "title", "start_time", "duration_minutes", "required", "notes", "recurrence_frequency", "recurrence_duration_days", "created_by", "created_at", "updated_at"],
  attendance_events: ["id", "installation_id", "member_id", "meeting_id", "source", "occurred_at", "kiosk_event_id", "created_by", "action"],
  attendance_corrections: ["id", "installation_id", "member_id", "meeting_id", "disposition", "reason", "created_by", "created_at"],
  setup_progress: ["installation_id", "step", "completed_at", "completed_by"],
  pairing_codes: ["id", "installation_id", "code_hash", "expires_at", "redeemed_at", "created_by", "created_at", "purpose"],
  kiosks: ["id", "installation_id", "pairing_code_id", "name", "token_hash", "active", "last_seen_at", "created_at", "reader_online", "release_version", "pending_events", "last_sync_at", "error_category"],
  simulated_kiosk_sessions: ["installation_id", "pairing_code_id", "name", "active", "online", "last_seen_at", "created_by", "created_at"],
  encrypted_integrations: ["id", "installation_id", "provider", "ciphertext", "iv", "key_version", "updated_at", "verified_at"],
  google_calendar_authorizations: ["installation_id", "ciphertext", "iv", "key_version", "authorized_at", "verified_at", "updated_at"],
  google_calendar_event_mappings: ["installation_id", "meeting_id", "event_id", "generation", "active", "synced_at", "last_error", "updated_at"],
  google_calendar_operations: ["installation_id", "meeting_id", "event_id", "action", "starts_at", "ends_at", "status", "attempts", "next_attempt_at", "last_error", "updated_at"],
  discord_calendar_event_mappings: ["installation_id", "meeting_id", "event_id", "generation", "active", "synced_at", "last_error", "updated_at"],
  discord_calendar_operations: ["installation_id", "meeting_id", "generation", "action", "event_id", "status", "attempts", "revision", "next_attempt_at", "lease_token", "lease_expires_at", "last_error", "actor_user_id", "updated_at"],
  integration_deliveries: ["id", "installation_id", "provider", "delivery_key", "status", "external_id", "created_at", "updated_at"],
  integration_state: ["installation_id", "provider", "state_key", "external_id", "content_hash", "updated_at"],
  discord_attendance_notifications: ["installation_id", "meeting_id", "status", "message_id", "attempts", "last_error", "processed_at", "updated_at", "channel_id", "expires_at", "deleted_at", "thread_created_at"],
  discord_attendance_recipients: ["installation_id", "meeting_id", "member_id", "discord_user_id", "message_id", "delivered_at"],
  discord_attendance_contests: ["installation_id", "meeting_id", "member_id", "message_id", "status", "resolved_by", "resolved_at", "created_at", "submitted_by_discord_user_id", "review_note"],
  discord_anomaly_reports: ["installation_id", "meeting_id", "channel_id", "status", "nonce", "message_id", "attempts", "last_error", "processed_at", "updated_at"],
  audit_log: ["id", "installation_id", "actor_user_id", "action", "target_type", "target_id", "metadata_json", "created_at"],
  telemetry_diagnostics: ["installation_id", "error_category", "last_seen_at"],
} as const;
type BackupTable = keyof typeof tableColumns;
// Restore parents before children so SQLite's immediate foreign-key checks remain valid.
const installationTables: BackupTable[] = [
  "installations", "organization_settings", "members", "users", "member_labels", "member_label_changes", "discord_label_role_mappings", "label_weekly_targets", "label_attendance_rules", "saved_report_views", "saved_report_tabs", "meeting_weight_categories", "meetings", "meeting_audience_labels", "meeting_templates",
  "attendance_events", "attendance_corrections", "setup_progress", "pairing_codes",
  "kiosks", "simulated_kiosk_sessions", "encrypted_integrations", "google_calendar_authorizations", "integration_deliveries",
  "integration_state", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports", "audit_log", "telemetry_diagnostics",
  "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations",
];
const meetingTables: BackupTable[] = ["meeting_weight_categories", "meetings", "meeting_audience_labels", "meeting_templates", "attendance_events", "attendance_corrections", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports"];
const rosterTables: BackupTable[] = ["members", "member_labels", "member_label_changes", "label_weekly_targets", "label_attendance_rules"];
const tablesForScope = (scope: BackupScope) => scope === "installation" ? installationTables : scope === "meetings" ? meetingTables : rosterTables;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeBackupValue = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

async function backupData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const scope = new URL(request.url).searchParams.get("scope") as BackupScope;
  if (!["meetings", "roster", "installation"].includes(scope)) throw new HttpError(400, "Backup scope must be meetings, roster, or installation");
  const entries = await Promise.all(tablesForScope(scope).map(async (table) => {
    const where = table === "installations" ? "id = 'primary'" : "installation_id = 'primary'"; const result = await db.prepare(`SELECT ${tableColumns[table].join(", ")} FROM ${table} WHERE ${where}`).all<Record<string, unknown>>(); return [table, result.results ?? []] as const;
  }));
  const exportedAt = new Date().toISOString(); const policySettings = scope === "roster" ? await db.prepare("SELECT attendance_recent_days AS recentDays, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = 'primary'").first<{ recentDays: number; policyActivatedOn: string | null }>() : null; const backup = { product: "LancerLogin", schemaVersion: 20, scope, exportedAt, tables: Object.fromEntries(entries), ...(policySettings ? { attendanceRecentDays: policySettings.recentDays, attendancePolicyActivatedOn: policySettings.policyActivatedOn } : {}) };
  const updateRequestId = new URL(request.url).searchParams.get("updateRequestId");
  if (updateRequestId) {
    if (scope !== "installation") throw new HttpError(400, "Web updates require an entire-installation backup");
    await recordUpdateBackup(env, updateRequestId);
  }
  await writeAudit(db, principal, "data.backup_exported", "installation", "primary", { scope, schemaVersion: 20 });
  return response(backup, 200, { "content-disposition": `attachment; filename="lancerlogin-${scope}-backup-${exportedAt.slice(0, 10)}.json"` });
}

type NormalizedBackup = { product: "LancerLogin"; schemaVersion: number; scope: BackupScope; exportedAt: string; attendanceRecentDays: number; attendancePolicyActivatedOn: string | null; tables: Record<BackupTable, Record<string, unknown>[]> };
const legacyTableColumns: Partial<Record<BackupTable, readonly string[]>> = {
  organization_settings: tableColumns.organization_settings.slice(0, -11),
  attendance_events: tableColumns.attendance_events.slice(0, -1),
  discord_attendance_contests: tableColumns.discord_attendance_contests.slice(0, -2),
};
const legacyInstallationTables = installationTables.filter((table) => !["member_labels", "member_label_changes", "discord_label_role_mappings", "label_weekly_targets", "label_attendance_rules", "saved_report_views", "saved_report_tabs", "meeting_audience_labels", "meeting_weight_categories", "meeting_templates", "discord_attendance_notifications", "discord_attendance_recipients", "discord_anomaly_reports", "google_calendar_authorizations", "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations"].includes(table));
const legacyMeetingTables = meetingTables.filter((table) => !["meeting_audience_labels", "meeting_weight_categories", "meeting_templates", "discord_attendance_notifications", "discord_attendance_recipients", "discord_anomaly_reports"].includes(table));
const legacyTablesForScope = (scope: BackupScope) => scope === "installation" ? legacyInstallationTables : scope === "meetings" ? legacyMeetingTables : rosterTables;

function normalizeBackup(value: unknown, scope: BackupScope): NormalizedBackup {
  if (!isObject(value) || value.product !== "LancerLogin" || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(Number(value.schemaVersion)) || value.scope !== scope || typeof value.exportedAt !== "string" || !isObject(value.tables)) throw new HttpError(400, "The selected file is not a matching current LancerLogin backup");
  const schemaVersion = Number(value.schemaVersion);
  const sourceTables = value.tables;
  const requiredTables = (schemaVersion < 6 ? legacyTablesForScope(scope) : tablesForScope(scope)).filter((table) => !(schemaVersion < 10 && table === "discord_anomaly_reports") && !(schemaVersion < 11 && table === "meeting_weight_categories") && !(schemaVersion < 12 && ["google_calendar_authorizations", "google_calendar_event_mappings", "google_calendar_operations"].includes(table)) && !(schemaVersion < 13 && ["discord_calendar_event_mappings", "discord_calendar_operations"].includes(table)) && !(schemaVersion < 14 && ["member_labels", "member_label_changes", "label_weekly_targets", "meeting_audience_labels"].includes(table)) && !(schemaVersion < 15 && table === "label_attendance_rules") && !(schemaVersion < 16 && table === "discord_label_role_mappings") && !(schemaVersion < 20 && ["saved_report_views", "saved_report_tabs"].includes(table)));
  let rows = 0;
  for (const table of requiredTables) {
    const tableRows = sourceTables[table]; if (!Array.isArray(tableRows)) throw new HttpError(400, `Backup table ${table} is missing`); rows += tableRows.length;
    const columns = schemaVersion < 7 && table === "installations" ? tableColumns.installations.slice(0, -4) : schemaVersion < 12 && table === "installations" ? tableColumns.installations.slice(0, -1) : schemaVersion < 14 && table === "members" ? tableColumns.members.slice(0, -1) : schemaVersion < 19 && table === "users" ? tableColumns.users.slice(0, -1) : schemaVersion === 1 ? legacyTableColumns[table] ?? (table === "meetings" ? tableColumns.meetings.slice(0, -9) : table === "encrypted_integrations" ? tableColumns.encrypted_integrations.slice(0, -1) : tableColumns[table]) : schemaVersion === 2 && table === "meetings" ? tableColumns.meetings.slice(0, -9) : schemaVersion < 4 && table === "encrypted_integrations" ? tableColumns.encrypted_integrations.slice(0, -1) : schemaVersion < 5 && table === "meetings" ? tableColumns.meetings.slice(0, -5) : schemaVersion < 11 && table === "meetings" ? tableColumns.meetings.slice(0, -4) : schemaVersion < 14 && table === "meetings" ? tableColumns.meetings.slice(0, -1) : schemaVersion < 8 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -9) : schemaVersion < 9 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -7) : schemaVersion < 10 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -5) : schemaVersion < 15 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -2) : schemaVersion < 8 && table === "discord_attendance_notifications" ? tableColumns.discord_attendance_notifications.slice(0, -4) : schemaVersion < 19 && table === "discord_attendance_notifications" ? tableColumns.discord_attendance_notifications.slice(0, -1) : schemaVersion < 18 && table === "label_attendance_rules" ? tableColumns.label_attendance_rules.slice(0, -1) : tableColumns[table];
    for (const row of tableRows) { if (!isObject(row) || columns.some((column) => !safeBackupValue(row[column]))) throw new HttpError(400, `Backup table ${table} contains an invalid row`); }
  }
  if (rows > 150_000) throw new HttpError(400, "Backup contains too many records for dashboard restore; use the documented D1 restore workflow");

  const tables = Object.fromEntries((Object.keys(tableColumns) as BackupTable[]).map((table) => [table, [] as Record<string, unknown>[]])) as Record<BackupTable, Record<string, unknown>[]>;
  for (const table of requiredTables) tables[table] = (sourceTables[table] as Record<string, unknown>[]).map((row) => ({ ...row }));
  if (tables.organization_settings) tables.organization_settings = tables.organization_settings.map((row) => ({ late_scan_minutes: 30, logo_backdrop: "auto", discord_contest_window_hours: 24, discord_channel_manager_enabled: 0, attendance_reporting_starts_on: null, anomaly_late_threshold_minutes: DEFAULT_ANOMALY_THRESHOLD_MINUTES, anomaly_early_threshold_minutes: DEFAULT_ANOMALY_THRESHOLD_MINUTES, discord_anomaly_reports_enabled: 0, discord_anomaly_report_channel_id: null, discord_anomaly_reports_enabled_at: null, attendance_recent_days: 30, attendance_policy_activated_on: null, ...row }));
  if (tables.discord_attendance_notifications) tables.discord_attendance_notifications = tables.discord_attendance_notifications.map((row) => ({ channel_id: null, expires_at: null, deleted_at: null, thread_created_at: null, ...row }));
  if (tables.encrypted_integrations) tables.encrypted_integrations = tables.encrypted_integrations.map((row) => ({ verified_at: null, ...row }));
  if (schemaVersion < 7 && tables.installations) { const providers = new Set(tables.encrypted_integrations.map((row) => row.provider)); tables.installations = tables.installations.map((row) => ({ ...row, google_enabled: providers.has("google") ? 1 : 0, resend_enabled: providers.has("resend") ? 1 : 0, discord_enabled: providers.has("discord") ? 1 : 0 })); }
  if (schemaVersion < 12 && tables.installations) tables.installations = tables.installations.map((row) => ({ google_calendar_enabled: 0, ...row }));
  if (tables.members) tables.members = tables.members.map((row) => ({ attendance_required_from: String(row.created_at ?? "").slice(0, 10), ...row }));
  if (tables.users) tables.users = tables.users.map((row) => ({ debug_mode: 0, ...row }));
  if (tables.meetings) tables.meetings = tables.meetings.map((row) => {
    const normalized: Record<string, unknown> = { series_id: null, recurrence_frequency: null, recurrence_until: null, recurrence_sequence: null, deleted_at: null, weight_category_id: null, weight_category_name: null, attendance_weight: 1, audience_mode: "all", ...row };
    if (normalized.ends_at !== null) return normalized;
    const start = Date.parse(String(row.starts_at));
    return { ...normalized, ends_at: Number.isFinite(start) ? new Date(start + 60 * 60_000).toISOString() : row.starts_at };
  });
  if (schemaVersion === 1 && tables.attendance_events) {
    tables.attendance_events = tables.attendance_events.map((row) => ({ ...row, action: "check_in" }));
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of tables.attendance_events) {
      if (row.meeting_id === null) continue;
      const key = `${row.installation_id}:${row.member_id}:${row.meeting_id}`;
      const saved = latest.get(key);
      if (!saved || String(row.occurred_at) > String(saved.occurred_at)) latest.set(key, row);
    }
    for (const row of latest.values()) tables.attendance_events.push({ ...row, id: `legacy-restore-checkout:${row.member_id}:${row.meeting_id}`, source: "manual", kiosk_event_id: null, action: "check_out" });
  }
  if (tables.discord_attendance_contests) tables.discord_attendance_contests = tables.discord_attendance_contests.map((row) => ({ submitted_by_discord_user_id: null, review_note: null, ...row }));
  if (schemaVersion < 15) {
    tables.label_attendance_rules = tables.label_weekly_targets.map((row) => ({ id: "legacy:" + row.id, installation_id: row.installation_id, label_id: row.label_id, starts_on: row.starts_on, ends_on: row.ends_on, rule_type: "weekly_count", threshold_percent: null, meetings_per_week: row.meetings_per_week, created_by: row.created_by, created_at: row.created_at, updated_at: row.created_at }));
    if (tables.member_labels.some((row) => row.formula_enabled === 1) || tables.label_attendance_rules.length) tables.organization_settings = tables.organization_settings.map((row) => ({ ...row, attendance_policy_activated_on: new Date().toISOString().slice(0, 10) }));
  }
  tables.label_attendance_rules = tables.label_attendance_rules.map((row) => ({ excused_handling: "exclude", ...row }));
  if (tables.label_attendance_rules.some((row) => !["exclude", "count_missed"].includes(String(row.excused_handling)))) throw new HttpError(400, "Backup attendance rule has invalid excused-meeting handling");
  if (scope === "installation" && schemaVersion >= 20) {
    const restoredLabels = tables.member_labels.map((row) => ({ id: String(row.id), name: String(row.name), active: Boolean(row.active), formulaEnabled: Boolean(row.formula_enabled) }));
    for (const row of tables.saved_report_views) {
      const validation = validateReportDefinition(parseStoredReportDefinition(String(row.definition_json)), restoredLabels, { allowMissingLabels: true });
      if (!validation.definition || validation.errors.length) throw new HttpError(400, "Backup contains an invalid saved report definition", validation.errors);
    }
  }
  const attendanceRecentDays = scope === "roster" && schemaVersion >= 15 ? Number(value.attendanceRecentDays) : 30;
  if (!Number.isSafeInteger(attendanceRecentDays) || attendanceRecentDays < 1 || attendanceRecentDays > 365) throw new HttpError(400, "Backup attendance window is invalid");
  const attendancePolicyActivatedOn = scope === "roster" && schemaVersion >= 15 ? value.attendancePolicyActivatedOn ?? null : schemaVersion < 15 && (tables.member_labels.some((row) => row.formula_enabled === 1) || tables.label_attendance_rules.length) ? new Date().toISOString().slice(0, 10) : null;
  if (attendancePolicyActivatedOn !== null && !validDate(attendancePolicyActivatedOn)) throw new HttpError(400, "Backup attendance policy activation date is invalid");
  return { product: "LancerLogin", schemaVersion, scope, exportedAt: value.exportedAt, attendanceRecentDays, attendancePolicyActivatedOn, tables };
}

const insertBackupRows = (db: D1Database, table: BackupTable, rows: Record<string, unknown>[]) => rows.map((row) => {
  const columns = tableColumns[table]; return db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...columns.map((column) => row[column]));
});

async function restoreData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ scope?: BackupScope; confirmation?: string; backup?: unknown }>(request, 10_485_760); const scope = input.scope;
  if (!scope || !["meetings", "roster", "installation"].includes(scope)) throw new HttpError(400, "Restore scope must be meetings, roster, or installation");
  const expected = `RESTORE ${scope.toUpperCase()}`; if (input.confirmation !== expected) throw new HttpError(400, `Type ${expected} exactly to continue`); const backup = normalizeBackup(input.backup, scope); const tables = backup.tables;
  let statements: D1Statement[];
  if (scope === "meetings") statements = [
    db.prepare("DELETE FROM discord_anomaly_reports WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_recipients WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_notifications WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_audience_labels WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meetings WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_templates WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_weight_categories WHERE installation_id = 'primary'"),
    ...insertBackupRows(db, "meeting_weight_categories", tables.meeting_weight_categories), ...insertBackupRows(db, "meetings", tables.meetings), ...insertBackupRows(db, "meeting_audience_labels", tables.meeting_audience_labels), ...insertBackupRows(db, "meeting_templates", tables.meeting_templates), ...insertBackupRows(db, "attendance_events", tables.attendance_events), ...insertBackupRows(db, "attendance_corrections", tables.attendance_corrections), ...insertBackupRows(db, "discord_attendance_notifications", tables.discord_attendance_notifications), ...insertBackupRows(db, "discord_attendance_recipients", tables.discord_attendance_recipients), ...insertBackupRows(db, "discord_attendance_contests", tables.discord_attendance_contests), ...insertBackupRows(db, "discord_anomaly_reports", tables.discord_anomaly_reports),
  ];
  else if (scope === "roster") statements = [
    db.prepare("UPDATE members SET active = 0 WHERE installation_id = 'primary'"),
    ...tables.members.map((row) => db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, active, created_at, attendance_required_from) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, discord_user_id = excluded.discord_user_id, active = excluded.active, attendance_required_from = excluded.attendance_required_from").bind(row.id, row.external_id, row.first_name, row.last_name, row.email, row.discord_user_id, row.active, row.created_at, row.attendance_required_from)),
    db.prepare("DELETE FROM member_label_changes WHERE installation_id = 'primary'"), db.prepare("DELETE FROM label_attendance_rules WHERE installation_id = 'primary'"), db.prepare("DELETE FROM label_weekly_targets WHERE installation_id = 'primary'"), db.prepare("UPDATE member_labels SET active = 0 WHERE installation_id = 'primary'"),
    ...tables.member_labels.map((row) => db.prepare("INSERT INTO member_labels (id, installation_id, name, active, formula_enabled, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = excluded.active, formula_enabled = excluded.formula_enabled").bind(row.id, row.name, row.active, row.formula_enabled, row.created_by, row.created_at)),
    ...insertBackupRows(db, "member_label_changes", tables.member_label_changes), ...insertBackupRows(db, "label_weekly_targets", tables.label_weekly_targets), ...insertBackupRows(db, "label_attendance_rules", tables.label_attendance_rules), db.prepare("DELETE FROM discord_label_role_mappings WHERE installation_id = 'primary' AND label_id IN (SELECT id FROM member_labels WHERE installation_id = 'primary' AND active = 0)"), db.prepare("UPDATE discord_label_role_jobs SET status = 'stale', lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND status IN ('pending', 'running')").bind(new Date().toISOString(), new Date().toISOString()), db.prepare("UPDATE organization_settings SET attendance_recent_days = ?, attendance_policy_activated_on = ? WHERE installation_id = 'primary'").bind(backup.attendanceRecentDays, backup.attendancePolicyActivatedOn),
  ];
  else {
    statements = [db.prepare("DELETE FROM installations WHERE id = 'primary'")];
    for (const table of installationTables) { if (table === "member_labels" && backup.schemaVersion >= 14) statements.push(db.prepare("DELETE FROM member_labels WHERE installation_id = 'primary'")); statements.push(...insertBackupRows(db, table, tables[table])); }
  }
  const actorRestored = scope !== "installation" || tables.users.some((row) => row.id === principal.userId); const now = new Date().toISOString(); statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'data.backup_restored', 'installation', 'primary', ?, ?)").bind(crypto.randomUUID(), actorRestored ? principal.userId : null, JSON.stringify({ scope, schemaVersion: backup.schemaVersion, exportedAt: backup.exportedAt }), now));
  await db.batch(statements); return response({ restored: true, scope });
}

async function resetOnboarding(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ confirmation?: string }>(request);
  if (input.confirmation !== "RESET ONBOARDING") throw new HttpError(400, "Type RESET ONBOARDING exactly to continue");
  await db.batch([db.prepare("DELETE FROM setup_progress WHERE installation_id = 'primary'"), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, created_at) VALUES (?, 'primary', ?, 'setup.reset', 'installation', ?)").bind(crypto.randomUUID(), principal.userId, new Date().toISOString())]); return response({ reset: true });
}

async function deleteData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ scope?: "attendance" | "roster" | "installation"; confirmation?: string }>(request);
  const expected = input.scope === "attendance" ? "DELETE ATTENDANCE" : input.scope === "roster" ? "DELETE ROSTER" : input.scope === "installation" ? "DELETE INSTALLATION" : undefined;
  if (!expected || input.confirmation !== expected) throw new HttpError(400, `Type ${expected ?? "a valid confirmation"} exactly to continue`);
  if (input.scope === "attendance") await db.batch([
    db.prepare("DELETE FROM discord_anomaly_reports WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_recipients WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_notifications WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meetings WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_templates WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meeting_weight_categories WHERE installation_id = 'primary'"),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, created_at) VALUES (?, 'primary', ?, 'data.attendance_deleted', 'installation', ?)").bind(crypto.randomUUID(), principal.userId, new Date().toISOString()),
  ]);
  else if (input.scope === "roster") {
    const references = await db.prepare("SELECT COUNT(*) AS count FROM members m WHERE m.installation_id = 'primary' AND (EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id) OR EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.member_id = m.id) OR EXISTS (SELECT 1 FROM discord_attendance_contests d WHERE d.member_id = m.id))").first<{ count: number }>();
    if (Number(references?.count ?? 0) > 0) throw new HttpError(409, "Delete meetings and attendance first so historical records do not lose their roster references");
    await db.batch([db.prepare("UPDATE users SET member_id = NULL WHERE installation_id = 'primary' AND member_id IS NOT NULL"), db.prepare("DELETE FROM members WHERE installation_id = 'primary'"), db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, created_at) VALUES (?, 'primary', ?, 'data.roster_deleted', 'installation', ?)").bind(crypto.randomUUID(), principal.userId, new Date().toISOString())]);
  }
  else await db.prepare("DELETE FROM installations WHERE id = 'primary'").run();
  return response({ deleted: true, scope: input.scope });
}

const worker = { async fetch(request: Request, env: Env, context?: WorkerContext): Promise<Response> {
  const url = new URL(request.url); let result: Response;
  const usage = env.DB ? measureD1(env.DB) : undefined;
  if (usage) env = { ...env, DB: usage.database };
  try {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !["/auth/local", "/auth/logout", "/auth/google/callback"].includes(url.pathname) && await webUpdateMaintenance(env)) return withCors(response({ error: "An installation update requires temporary write suspension. Retry after recovery or completion.", code: "update_maintenance" }, 503, { "retry-after": "30" }), request, env);
    if (request.method === "OPTIONS") result = new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-allow-credentials": "true" } });
    else if (url.pathname === "/health" && request.method === "GET") result = response({ ok: true, service: "lancerlogin-api", mode: env.DB ? "ready" : "unconfigured", releaseVersion: env.RELEASE_VERSION ?? "development" });
    else if (url.pathname === "/setup/status" && request.method === "GET") result = await setupStatus(env);
    else if (url.pathname === "/setup/bootstrap" && request.method === "POST") result = await bootstrap(request, env);
    else if (url.pathname === "/admin/update-info" && request.method === "GET") result = await updateInfo(request, env);
    else if (url.pathname === "/admin/releases/latest" && request.method === "GET") result = await discoverRelease(request, env);
    else if (url.pathname === "/admin/web-updates/status" && request.method === "GET" || ["/admin/web-updates/prepare", "/admin/web-updates/start"].includes(url.pathname) && request.method === "POST") result = await webUpdates(request, env);
    else if (url.pathname === "/auth/local" && request.method === "POST") result = await localLogin(request, env);
    else if (url.pathname === "/auth/session" && request.method === "GET") result = await authSession(request, env);
    else if (url.pathname === "/auth/preferences" && request.method === "PATCH") result = await authPreferences(request, env);
    else if (url.pathname === "/auth/logout" && request.method === "POST") result = response({ ok: true }, 200, { "set-cookie": "lancerlogin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
    else if (url.pathname === "/auth/google/start" && request.method === "GET") result = await googleStart(request, env);
    else if (url.pathname === "/auth/google/callback" && request.method === "GET") result = await googleCallback(request, env);
    else if (url.pathname === "/admin/branding" && ["GET", "PATCH"].includes(request.method)) result = await branding(request, env);
    else if (url.pathname === "/meeting-weight-categories" && request.method === "GET") result = await listMeetingWeightCategories(request, env, false);
    else if (url.pathname === "/admin/meeting-weight-categories" && request.method === "GET") result = await listMeetingWeightCategories(request, env, true);
    else if (url.pathname === "/admin/meeting-weight-categories" && request.method === "POST") result = await createMeetingWeightCategory(request, env);
    else if (url.pathname === "/admin/meeting-weight-categories/order" && request.method === "PATCH") result = await reorderMeetingWeightCategories(request, env);
    else if (/^\/admin\/meeting-weight-categories\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeetingWeightCategory(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/admin/setup/progress" && ["GET", "PATCH"].includes(request.method)) result = await setupProgress(request, env);
    else if (url.pathname === "/labels" && ["GET", "POST"].includes(request.method)) result = await labels(request, env);
    else if (url.pathname === "/attendance/policy" && request.method === "GET") result = await attendancePolicies(request, env);
    else if (url.pathname === "/attendance/policy/preview" && request.method === "POST") result = await attendancePolicies(request, env, false);
    else if (url.pathname === "/attendance/policy/apply" && request.method === "POST") result = await attendancePolicies(request, env, true);
    else if (url.pathname === "/labels/membership/preview" && request.method === "POST") result = await labelMembership(request, env, false);
    else if (url.pathname === "/labels/membership/apply" && request.method === "POST") result = await labelMembership(request, env, true);
    else if (url.pathname === "/labels/targets" && request.method === "POST") result = await labelTarget(request, env);
    else if (/^\/labels\/targets\/[^/]+$/.test(url.pathname) && request.method === "DELETE") result = await labelTarget(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/labels\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateLabel(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (url.pathname === "/admin/members" && ["GET", "POST"].includes(request.method)) result = await members(request, env);
    else if (url.pathname === "/admin/members/bulk/preview" && request.method === "POST") result = await bulkMemberStatus(request, env, false);
    else if (url.pathname === "/admin/members/bulk/apply" && request.method === "POST") result = await bulkMemberStatus(request, env, true);
    else if (/^\/admin\/members\/[^/]+\/history$/.test(url.pathname) && request.method === "GET") result = await memberHistory(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/members\/[^/]+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(request.method)) result = await manageMember(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/admin/pairing-codes" && ["GET", "POST"].includes(request.method)) result = await pairingCodes(request, env);
    else if (url.pathname === "/admin/kiosks" && request.method === "GET") result = await kioskStatus(request, env);
    else if (/^\/admin\/kiosks\/[^/]+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(request.method)) result = await manageKiosk(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/kiosks\/[^/]+\/commands$/.test(url.pathname) && request.method === "POST") result = await queueKioskCommand(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (/^\/admin\/kiosks\/[^/]+\/commands$/.test(url.pathname) && request.method === "GET") result = await kioskCommandStatus(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/admin/simulator" && ["GET", "POST"].includes(request.method)) result = await simulatedKiosk(request, env);
    else if (url.pathname === "/meetings" && ["GET", "POST"].includes(request.method)) result = await meetings(request, env);
    else if (url.pathname === "/meeting-templates" && request.method === "GET") result = await meetingTemplates(request, env);
    else if (url.pathname === "/meetings/bulk-delete" && request.method === "POST") result = await bulkDeleteMeetings(request, env);
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "GET") result = await meetingDetail(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+\/impact$/.test(url.pathname) && request.method === "POST") result = await meetingImpact(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeeting(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "DELETE") result = await deleteMeetings(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meetings\/[^/]+\/restore$/.test(url.pathname) && request.method === "POST") result = await restoreMeetings(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meeting-series\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeetingSeries(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (url.pathname === "/attendance" && ["GET", "POST"].includes(request.method)) result = await attendance(request, env);
    else if (url.pathname === "/attendance/corrections" && request.method === "POST") result = await correction(request, env);
    else if (url.pathname === "/attendance/cleanup" && request.method === "POST") result = await cleanupAttendance(request, env);
    else if (url.pathname === "/reports/catalog" && request.method === "GET") result = await reportCatalog(request, env);
    else if (url.pathname === "/reports/views" && ["GET", "POST"].includes(request.method)) result = await savedReports(request, env);
    else if (/^\/reports\/views\/[^/]+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(request.method)) result = await manageSavedReport(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/reports/tabs" && request.method === "PUT") result = await savedReportTabs(request, env);
    else if (url.pathname === "/reports/leaderboard" && request.method === "GET") result = await leaderboardReport(request, env);
    else if (url.pathname === "/reports/query" && request.method === "POST") result = await customReportQuery(request, env);
    else if (url.pathname === "/reports/attendance" && request.method === "GET") result = await attendanceReport(request, env);
    else if (url.pathname === "/exports/report.csv" && request.method === "POST") result = await reportCsvExport(request, env);
    else if (url.pathname === "/exports/report-detail.csv" && request.method === "POST") result = await reportDetailCsvExport(request, env);
    else if (url.pathname === "/exports/attendance.csv" && request.method === "GET") result = await attendanceExport(request, env);
    else if (url.pathname === "/admin/integrations" && request.method === "GET") result = await integrationsStatus(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar" && ["PUT", "PATCH", "DELETE"].includes(request.method)) result = await googleCalendarConfiguration(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/authorize" && request.method === "GET") result = await googleCalendarStart(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/callback" && request.method === "GET") result = await googleCalendarCallback(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/calendars" && request.method === "GET") result = await listGoogleCalendars(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/select" && ["PUT", "PATCH"].includes(request.method)) result = await selectGoogleCalendar(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/retry" && request.method === "POST") result = await retryGoogleCalendarOperations(request, env);
    else if (url.pathname === "/admin/integrations/google-calendar/sync-all" && request.method === "POST") result = await syncAllGoogleCalendarMeetings(request, env);
    else if (url.pathname === "/admin/integrations/discord/calendar/sync-all" && request.method === "POST") result = await syncAllDiscordCalendarMeetings(request, env);
    else if (url.pathname === "/admin/integrations/discord/channel-manager" && ["GET", "PATCH"].includes(request.method)) result = await discordChannelManagerSettings(request, env);
    else if (url.pathname === "/admin/integrations/discord/anomaly-reports" && ["GET", "PATCH"].includes(request.method)) result = await discordAnomalyReportSettings(request, env);
    else if (url.pathname === "/integrations/capabilities" && request.method === "GET") result = await integrationCapabilities(request, env);
    else if (/^\/admin\/integrations\/(google|resend|discord)$/.test(url.pathname) && ["PUT", "PATCH", "DELETE"].includes(request.method)) result = await integrationConfiguration(request, env, providerFrom(url.pathname));
    else if (url.pathname === "/admin/integrations/resend/verify/start" && request.method === "POST") result = await startResendVerification(request, env);
    else if (url.pathname === "/admin/integrations/resend/verify/complete" && request.method === "POST") result = await completeResendVerification(request, env);
    else if (url.pathname === "/admin/integrations/discord/verify/start" && request.method === "POST") result = await startDiscordVerification(request, env);
    else if (url.pathname === "/admin/integrations/discord/commands/reconcile" && request.method === "POST") result = await reconcileDiscordCommands(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles" && request.method === "GET") result = await discordLabelMappings(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/preview" && request.method === "POST") result = await discordLabelPreview(request, env);
    else if (url.pathname === "/admin/integrations/discord/label-roles/apply" && request.method === "POST") result = await discordLabelApply(request, env, context);
    else if (/^\/admin\/integrations\/discord\/label-roles\/[^/]+$/.test(url.pathname) && request.method === "DELETE") result = await discordLabelUnlink(request, env, decodeURIComponent(url.pathname.split("/")[5]));
    else if (/^\/admin\/integrations\/discord\/label-role-jobs\/[^/]+$/.test(url.pathname) && request.method === "GET") result = await discordLabelJobStatus(request, env, decodeURIComponent(url.pathname.split("/")[5]));
    else if (/^\/admin\/integrations\/discord\/label-role-jobs\/[^/]+\/advance$/.test(url.pathname) && request.method === "POST") result = await discordLabelAdvance(request, env, decodeURIComponent(url.pathname.split("/")[5]));
    else if (/^\/admin\/integrations\/discord\/label-role-jobs\/[^/]+\/retry$/.test(url.pathname) && request.method === "POST") result = await discordLabelRetry(request, env, decodeURIComponent(url.pathname.split("/")[5]), context);
    else if (url.pathname === "/admin/users" && ["GET", "POST"].includes(request.method)) result = await users(request, env);
    else if (/^\/admin\/users\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateUser(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/communications/email" && request.method === "POST") result = await sendAttendanceEmail(request, env);
    else if (url.pathname === "/discord/interactions" && request.method === "POST") result = await discordInteraction(request, env);
    else if (url.pathname === "/discord/link" && request.method === "POST") result = await linkDiscordMember(request, env);
    else if (url.pathname === "/discord/missing" && request.method === "POST") result = await discordMissing(request, env);
    else if (url.pathname === "/discord/contests" && request.method === "GET") result = await discordContests(request, env);
    else if (url.pathname === "/discord/contests/resolve" && request.method === "POST") result = await resolveDiscordContest(request, env);
    else if (url.pathname === "/discord/calendar" && request.method === "POST") result = await discordCalendar(request, env);
    else if (url.pathname === "/calendars/sync" && request.method === "POST") result = await syncMeetingCalendars(request, env);
    else if (url.pathname === "/discord/kiosk-status" && request.method === "POST") result = await discordKioskStatus(request, env);
    else if (url.pathname === "/admin/privacy" && ["GET", "PATCH"].includes(request.method)) result = await privacySettings(request, env);
    else if (url.pathname === "/admin/roster/history" && request.method === "GET") result = await rosterHistory(request, env);
    else if (url.pathname === "/admin/data/backup" && request.method === "GET") result = await backupData(request, env);
    else if (url.pathname === "/admin/data/restore" && request.method === "POST") result = await restoreData(request, env);
    else if (url.pathname === "/admin/setup/reset" && request.method === "POST") result = await resetOnboarding(request, env);
    else if (url.pathname === "/admin/data" && request.method === "DELETE") result = await deleteData(request, env);
    else if (url.pathname === "/kiosk/pair" && request.method === "POST") result = await redeemPairingCode(request, env);
    else if (url.pathname === "/kiosk/heartbeat" && request.method === "POST") result = await kioskHeartbeat(request, env, context);
    else if (url.pathname === "/kiosk/config" && request.method === "GET") result = await kioskConfiguration(request, env);
    else if (url.pathname === "/kiosk/roster" && request.method === "GET") result = await kioskRoster(request, env);
    else if (url.pathname === "/kiosk/commands" && request.method === "GET") result = await pendingKioskCommand(request, env);
    else if (/^\/kiosk\/commands\/[^/]+\/result$/.test(url.pathname) && request.method === "POST") result = await completeKioskCommand(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/kiosk/attendance" && request.method === "POST") result = await kioskAttendance(request, env);
    else result = response({ error: "Not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError || error instanceof WebUpdateError ? error.status : 500;
    const detail = error instanceof HttpError ? error.details : env.APP_MODE === "unconfigured" && error instanceof Error ? [error.message] : undefined;
    result = response({ error: error instanceof HttpError || error instanceof WebUpdateError ? error.message : "Request failed", details: detail, ...(error instanceof WebUpdateError ? { code: error.code } : {}) }, status);
  }
  const measured = usage?.snapshot();
  if (measured && (measured.measuredRowsRead >= 100 || usageCategory(url.pathname) === "/reports")) console.log(JSON.stringify({ event: "d1_usage", category: usageCategory(url.pathname), status: result.status, ...measured }));
  return withCors(result, request, env);
}, async scheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (await webUpdateMaintenance(env)) return;
  if (controller.cron === "*/5 * * * *") {
    try { await autoReconcileDiscordCommands(env); } catch { /* Command registration is retried without blocking attendance work. */ }
    try { await processGoogleCalendarOperations(env); } catch { /* Google Calendar delivery retries safely on the next scheduled pass. */ }
    try { await processDiscordCalendarOperations(env); } catch { /* Discord Calendar delivery retries safely on the next scheduled pass. */ }
    try { await syncDiscordManagedSurface(env); } catch { /* Discord channel management is best-effort and retries on the next scheduled pass. */ }
    try { await processDiscordAttendanceNotifications(env); } catch { /* Discord attendance delivery retries safely on the next scheduled pass. */ }
    try { await processDiscordAnomalyReports(env); } catch { /* Discord anomaly reports retry safely on the next scheduled pass. */ }
    try { await processDiscordLabelRoleJobs(env); } catch { /* Manual role sync jobs resume on the next scheduled pass. */ }
  } else try { await syncDiscordManagedSurface(env); } catch { /* Discord status is best-effort and cannot affect kiosk operation. */ }
} };
export default worker;

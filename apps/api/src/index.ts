import { createSessionCodec, hashPassword, verifyPassword } from "./runtime-security.ts";
import { decryptIntegration, encryptIntegration } from "./integration-crypto.ts";
import { attendanceClosesAt, attendanceDisposition, nextAttendanceAction, overlappingMeetingWindows, scanWindowState, type AttendanceAction, type MeetingWindowLike } from "./attendance-lifecycle.ts";

type D1Result<T = unknown> = { results?: T[]; success?: boolean; meta?: { changes?: number } };
interface D1Statement { bind(...values: unknown[]): D1Statement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
interface D1Database { prepare(query: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]>; }
export interface Env { APP_MODE: "unconfigured" | "configured"; ALLOWED_ORIGIN: string; SESSION_KEY?: string; INTEGRATION_KEY?: string; BOOTSTRAP_CODE_HASH?: string; UPDATE_WORKFLOW_URL?: string; TELEMETRY_ENDPOINT?: string; RELEASE_VERSION?: string; DB?: D1Database; }
type WorkerContext = { waitUntil(promise: Promise<unknown>): void };
type ScheduledController = { cron?: string };

type Role = "admin" | "operator";
type Principal = { userId: string; role: Role; expiresAt: number };
type AuthMode = "google" | "local" | "both";
type SetupStep = "branding" | "roster" | "pair-kiosk" | "fingerprint-test" | "test-meeting" | "confirm-attendance";
type BootstrapInput = { setupCode?: string; organizationName?: string; timeZone?: string; authMode?: AuthMode; adminEmail?: string; localUsername?: string; localPassword?: string; googleClientId?: string; googleClientSecret?: string; telemetryAccepted?: boolean };
type BrandingInput = { organizationName?: string; subtitle?: string | null; logoData?: string | null; primaryColor?: string; secondaryColor?: string; appearance?: "system" | "themed" | "light" | "dark"; logoBackdrop?: "auto" | "light" | "dark" | "none"; lateScanMinutes?: number };
type MemberInput = { memberId?: string; firstName?: string; lastName?: string; email?: string | null; discordUserId?: string | null };
type RecurrenceFrequency = "daily" | "weekly" | "biweekly" | "monthly";
type MeetingInput = { meetingId?: string; title?: string; startsAt?: string; endsAt?: string | null; required?: boolean; notes?: string | null; isTest?: boolean; recurrence?: { frequency?: RecurrenceFrequency; until?: string } };

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const setupSteps = new Set<SetupStep>(["branding", "roster", "pair-kiosk", "fingerprint-test", "test-meeting", "confirm-attendance"]);
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
  const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone, logo_backdrop AS logoBackdrop, late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = ?").bind(installation.id).first();
  return response({ configured: true, installation: { ...installation, telemetryAccepted: Boolean(installation.telemetryAcceptedAt) }, settings });
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
  const telemetryAcceptedAt = input.telemetryAccepted ? now : null;
  const statements = [
    db.prepare("INSERT INTO installations (id, created_at, auth_mode, telemetry_accepted_at, telemetry_install_id) VALUES (?, ?, ?, ?, ?)").bind("primary", now, mode, telemetryAcceptedAt, input.telemetryAccepted ? crypto.randomUUID() : null),
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
  if (telemetryAcceptedAt) { const cf = (request as Request & { cf?: { city?: string; metroCode?: string } }).cf; try { await transmitTelemetry(env, cf?.city || cf?.metroCode); } catch { /* Setup must survive best-effort telemetry failure. */ } }
  return response({ configured: true, admin: { id: adminId, email: input.adminEmail?.toLowerCase(), localUsername: input.localUsername?.trim().toLowerCase(), role: "admin" }, telemetryAccepted: Boolean(telemetryAcceptedAt) }, 201);
}
async function updateInfo(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  if (!env.UPDATE_WORKFLOW_URL) throw new HttpError(503, "The private deployment workflow is not configured");
  return response({ releaseVersion: env.RELEASE_VERSION ?? "development", workflowUrl: env.UPDATE_WORKFLOW_URL });
}
async function localLogin(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); if (!env.SESSION_KEY) throw new HttpError(503, "Local authentication is not configured");
  const input = await parseJson<{ username?: string; password?: string }>(request);
  if (!input.username || !input.password) throw new HttpError(400, "Username and password are required");
  const user = await db.prepare("SELECT id, role, password_hash AS passwordHash, failed_login_count AS failedLoginCount, locked_until AS lockedUntil FROM users WHERE installation_id = ? AND local_username = ? AND active = 1").bind("primary", input.username.trim().toLowerCase()).first<{ id: string; role: Role; passwordHash: string | null; failedLoginCount: number; lockedUntil?: string }>();
  const passwordValid = await verifyPassword(input.password, user?.passwordHash ?? await timingEqualizerHash());
  const locked = Boolean(user?.lockedUntil && Date.parse(user.lockedUntil) > Date.now());
  if (!user?.passwordHash || !passwordValid || locked) {
    if (user && !locked) { const failures = Number(user.failedLoginCount ?? 0) + 1; const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null; await db.prepare("UPDATE users SET failed_login_count = ?, locked_until = ? WHERE installation_id = 'primary' AND id = ?").bind(failures, lockedUntil, user.id).run(); }
    throw new HttpError(401, "Invalid username or password");
  }
  if (user.failedLoginCount || user.lockedUntil) await db.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE installation_id = 'primary' AND id = ?").bind(user.id).run();
  const token = await createSessionCodec(env.SESSION_KEY).issue({ userId: user.id, role: user.role });
  return response({ ok: true, user: { id: user.id, role: user.role } }, 200, { "set-cookie": `lancerlogin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
}
async function authSession(request: Request, env: Env): Promise<Response> {
  const principal = await principalFor(request, env);
  const user = await requireDatabase(env).prepare("SELECT id, email, local_username AS localUsername, role FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(principal.userId).first();
  if (!user) throw new HttpError(401, "Session user is unavailable");
  return response({ authenticated: true, user });
}

async function branding(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") {
    const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone, logo_backdrop AS logoBackdrop, late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first();
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
  if (errors.length) throw new HttpError(400, "Invalid branding", errors);
  await assertNoMeetingOverlap(db, [], input.lateScanMinutes!);
  await db.prepare("UPDATE organization_settings SET organization_name = ?, subtitle = ?, logo_data = ?, primary_color = ?, secondary_color = ?, appearance = ?, logo_backdrop = ?, late_scan_minutes = ? WHERE installation_id = 'primary'")
    .bind(input.organizationName!.trim(), input.subtitle?.trim() || null, input.logoData || null, input.primaryColor!.toLowerCase(), input.secondaryColor!.toLowerCase(), input.appearance === "themed" ? "system" : input.appearance, input.logoBackdrop, input.lateScanMinutes).run();
  await writeAudit(db, principal, "branding.updated", "organization_settings", "primary"); return response({ ok: true });
}
async function setupProgress(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT step, completed_at AS completedAt, completed_by AS completedBy FROM setup_progress WHERE installation_id = 'primary' ORDER BY completed_at").all(); return response({ completedSteps: result.results ?? [] }); }
  const input = await parseJson<{ step?: SetupStep; completed?: boolean }>(request);
  if (!input.step || !setupSteps.has(input.step) || typeof input.completed !== "boolean") throw new HttpError(400, "A valid setup step and completed flag are required");
  if (input.completed) await db.prepare("INSERT INTO setup_progress (installation_id, step, completed_at, completed_by) VALUES ('primary', ?, ?, ?) ON CONFLICT(installation_id, step) DO UPDATE SET completed_at = excluded.completed_at, completed_by = excluded.completed_by").bind(input.step, new Date().toISOString(), principal.userId).run();
  else await db.prepare("DELETE FROM setup_progress WHERE installation_id = 'primary' AND step = ?").bind(input.step).run();
  await writeAudit(db, principal, input.completed ? "setup.step_completed" : "setup.step_reopened", "setup_step", input.step); return response({ ok: true, step: input.step, completed: input.completed });
}
async function members(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, request.method === "GET" ? ["admin", "operator"] : ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT m.id, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, m.email, m.discord_user_id AS discordUserId, m.active, EXISTS(SELECT 1 FROM users u WHERE u.installation_id = m.installation_id AND u.member_id = m.id AND u.active = 1) AS hasDashboardAccess FROM members m WHERE m.installation_id = 'primary' ORDER BY m.last_name, m.first_name").all(); return response({ members: result.results ?? [] }); }
  const input = await parseJson<{ members?: MemberInput[]; mode?: "merge" | "replace" }>(request); const mode = input.mode ?? "merge";
  if (!["merge", "replace"].includes(mode)) throw new HttpError(400, "Roster import mode must be merge or replace");
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 500) throw new HttpError(400, "Provide between 1 and 500 roster members");
  const seen = new Set<string>(); const errors: string[] = []; const warnings: string[] = [];
  input.members.forEach((member, index) => { const prefix = `Member ${index + 1}`; if (!member.memberId?.trim() || !member.firstName?.trim() || !member.lastName?.trim()) errors.push(`${prefix} requires memberId, firstName, and lastName`); if (member.memberId && seen.has(member.memberId.trim())) errors.push(`${prefix} duplicates memberId ${member.memberId.trim()}`); if (member.memberId) seen.add(member.memberId.trim()); if (member.email && !validEmail(member.email)) errors.push(`${prefix} has an invalid email`); if (member.discordUserId && !/^\d{10,24}$/.test(member.discordUserId)) warnings.push(`${prefix} Discord user ID was ignored; link Discord later from Optional integrations.`); });
  if (errors.length) throw new HttpError(400, "Invalid roster", errors);
  const now = new Date().toISOString();
  const importedIds = input.members.map((member) => member.memberId!.trim());
  const existing = await db.prepare("SELECT external_id AS memberId, active FROM members WHERE installation_id = 'primary'").all<{ memberId: string; active: number }>();
  const incoming = new Set(importedIds); const deactivated = mode === "replace" ? (existing.results ?? []).filter((member) => member.active && !incoming.has(member.memberId)).length : 0;
  const statements: D1Statement[] = mode === "replace" ? [db.prepare("UPDATE members SET active = 0 WHERE installation_id = 'primary'")] : [];
  statements.push(...input.members.map((member) => db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, discord_user_id = excluded.discord_user_id, active = 1").bind(crypto.randomUUID(), member.memberId!.trim(), member.firstName!.trim(), member.lastName!.trim(), member.email?.trim().toLowerCase() || null, member.discordUserId && /^\d{10,24}$/.test(member.discordUserId) ? member.discordUserId.trim() : null, now)));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'roster.imported', 'member', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ count: input.members.length, mode, deactivated }), now));
  await db.batch(statements); return response({ imported: input.members.length, deactivated, mode, warnings }, 201);
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
  const kiosk = await kioskFor(request, env); const input = await parseJson<{ readerOnline?: boolean; releaseVersion?: string; pendingEvents?: number; lastSyncAt?: string | null; errorCategory?: "cloud_sync" | "reader" | "offline_queue" | null }>(request);
  if (typeof input.readerOnline !== "boolean" || !input.releaseVersion || input.releaseVersion.length > 40 || !Number.isInteger(input.pendingEvents) || input.pendingEvents! < 0 || input.pendingEvents! > 100_000 || input.lastSyncAt && !validTimestamp(input.lastSyncAt) || input.errorCategory && !["cloud_sync", "reader", "offline_queue"].includes(input.errorCategory)) throw new HttpError(400, "Reader status, release version, pending scan count, and valid operational health are required");
  const now = new Date().toISOString();
  await requireDatabase(env).prepare("UPDATE kiosks SET last_seen_at = ?, reader_online = ?, release_version = ?, pending_events = ?, last_sync_at = ?, error_category = ? WHERE installation_id = 'primary' AND id = ?").bind(now, input.readerOnline ? 1 : 0, input.releaseVersion.trim(), input.pendingEvents, input.lastSyncAt || null, input.errorCategory || null, kiosk.id).run();
  const statusUpdate = syncDiscordKioskStatus(env).catch(() => undefined);
  if (context) context.waitUntil(statusUpdate); else await statusUpdate;
  return response({ ok: true, kioskId: kiosk.id, receivedAt: now });
}
async function kioskStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]);
  const result = await requireDatabase(env).prepare("SELECT id, name, active, last_seen_at AS lastSeenAt, reader_online AS readerOnline, release_version AS releaseVersion, pending_events AS pendingEvents, last_sync_at AS lastSyncAt, error_category AS errorCategory, created_at AS pairedAt FROM kiosks WHERE installation_id = 'primary' ORDER BY created_at DESC").all();
  return response({ kiosks: result.results ?? [] });
}
async function kioskConfiguration(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env); const settings = await requireDatabase(env).prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, logo_backdrop AS logoBackdrop FROM organization_settings WHERE installation_id = 'primary'").first();
  return response({ kiosk: { id: kiosk.id, name: kiosk.name }, settings });
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
  const existing = await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary'").all<MeetingWindowLike>();
  const excluded = new Set(excludedIds); const conflict = overlappingMeetingWindows([...(existing.results ?? []).filter((meeting) => !excluded.has(meeting.id ?? "")), ...proposed], lateScanMinutes);
  if (!conflict) return;
  const label = (meeting: MeetingWindowLike) => `${meeting.title?.trim() || "Meeting"} (${new Date(meeting.startsAt).toISOString()})`;
  throw new HttpError(409, `Meeting attendance windows cannot overlap. ${label(conflict[0])} conflicts with ${label(conflict[1])}.`);
}
async function meetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  if (request.method === "GET") { const [result, settings] = await Promise.all([db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, notes, is_test AS isTest, series_id AS seriesId, recurrence_frequency AS recurrenceFrequency, recurrence_until AS recurrenceUntil, recurrence_sequence AS recurrenceSequence FROM meetings WHERE installation_id = 'primary' ORDER BY starts_at DESC LIMIT 1000").all<{ id: string; title: string; startsAt: string; endsAt: string; required: number; notes?: string; isTest: number; seriesId?: string; recurrenceFrequency?: RecurrenceFrequency; recurrenceUntil?: string; recurrenceSequence?: number }>(), db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number }>()]); return response({ meetings: (result.results ?? []).map((meeting) => ({ ...meeting, attendanceClosesAt: attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30) })), lateScanMinutes: settings?.lateScanMinutes ?? 30 }); }
  const input = await parseJson<MeetingInput>(request); validateMeetingInput(input); const settings = await db.prepare("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ timeZone?: string; lateScanMinutes?: number }>(); const occurrences = meetingOccurrences(input, settings?.timeZone && validTimeZone(settings.timeZone) ? settings.timeZone : "UTC"); await assertNoMeetingOverlap(db, occurrences.map((occurrence) => ({ ...occurrence, title: input.title })), settings?.lateScanMinutes ?? 30); const seriesId = input.recurrence ? crypto.randomUUID() : null; const now = new Date().toISOString(); const ids = occurrences.map(() => crypto.randomUUID());
  const statements = occurrences.map((occurrence, index) => db.prepare("INSERT INTO meetings (id, installation_id, title, starts_at, ends_at, required, notes, created_by, created_at, is_test, series_id, recurrence_frequency, recurrence_until, recurrence_sequence) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(ids[index], input.title.trim(), occurrence.startsAt, occurrence.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, principal.userId, now, input.isTest === true ? 1 : 0, seriesId, input.recurrence?.frequency ?? null, input.recurrence?.until ?? null, occurrence.sequence));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting.created', 'meeting', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, ids[0], JSON.stringify({ seriesId, occurrences: occurrences.length, frequency: input.recurrence?.frequency ?? null }), now));
  await db.batch(statements);
  const created = occurrences.map((occurrence, index) => ({ id: ids[index], title: input.title!.trim(), ...occurrence, required: input.required !== false, notes: input.notes?.trim() || null, isTest: input.isTest === true, seriesId, recurrenceFrequency: input.recurrence?.frequency ?? null, recurrenceUntil: input.recurrence?.until ?? null, recurrenceSequence: occurrence.sequence }));
  return response({ meeting: created[0], meetings: created, seriesId }, 201);
}
async function updateMeeting(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<MeetingInput>(request); validateMeetingInput(input);
  const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes?: number }>();
  await assertNoMeetingOverlap(db, [{ id: meetingId, title: input.title, startsAt: input.startsAt, endsAt: input.endsAt }], settings?.lateScanMinutes ?? 30, [meetingId]);
  const updated = await db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, is_test = ? WHERE installation_id = 'primary' AND id = ?").bind(input.title.trim(), input.startsAt, input.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, input.isTest === true ? 1 : 0, meetingId).run();
  if ((updated.meta?.changes ?? 1) < 1) throw new HttpError(404, "Meeting not found");
  await writeAudit(db, principal, "meeting.updated", "meeting", meetingId);
  return response({ meeting: { id: meetingId, title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt, required: input.required !== false, notes: input.notes?.trim() || null, isTest: input.isTest === true } });
}
async function updateMeetingSeries(request: Request, env: Env, seriesId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<MeetingInput & { meetingId?: string }>(request); validateMeetingInput(input);
  if (!input.meetingId) throw new HttpError(400, "Choose the first occurrence to update");
  const anchor = await db.prepare("SELECT starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND id = ?").bind(seriesId, input.meetingId).first<{ startsAt: string }>();
  if (!anchor) throw new HttpError(404, "Recurring series occurrence not found");
  const future = await db.prepare("SELECT id, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND series_id = ? AND starts_at >= ? ORDER BY starts_at").bind(seriesId, anchor.startsAt).all<{ id: string; startsAt: string }>();
  const duration = Date.parse(input.endsAt) - Date.parse(input.startsAt); const shift = Date.parse(input.startsAt) - Date.parse(anchor.startsAt); const proposed = (future.results ?? []).map((meeting) => { const start = new Date(Date.parse(meeting.startsAt) + shift); return { id: meeting.id, title: input.title, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duration).toISOString() }; });
  const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes?: number }>();
  await assertNoMeetingOverlap(db, proposed, settings?.lateScanMinutes ?? 30, proposed.map((meeting) => meeting.id));
  const statements = proposed.map((meeting) => db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ?, is_test = ? WHERE installation_id = 'primary' AND id = ?").bind(input.title!.trim(), meeting.startsAt, meeting.endsAt, input.required === false ? 0 : 1, input.notes?.trim() || null, input.isTest === true ? 1 : 0, meeting.id));
  if (!statements.length) throw new HttpError(404, "No future series occurrences were found");
  const updatedCount = statements.length; statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'meeting.series_updated', 'meeting_series', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, seriesId, JSON.stringify({ fromMeetingId: input.meetingId, updated: updatedCount }), new Date().toISOString()));
  await db.batch(statements); return response({ seriesId, updated: updatedCount });
}
async function recordAttendance(db: D1Database, input: { eventId?: string; memberId?: string; meetingId?: string; occurredAt?: string; desiredAction?: AttendanceAction }, source: "kiosk" | "manual", actorId?: string): Promise<Response> {
  if (!input.eventId?.trim() || input.eventId.length > 100 || !input.memberId || !validTimestamp(input.occurredAt)) throw new HttpError(400, "eventId, memberId, and a valid occurredAt timestamp are required");
  const existing = await db.prepare("SELECT action FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ?").bind(input.eventId.trim()).first<{ action: AttendanceAction }>();
  if (existing) return response({ accepted: false, duplicate: true, eventId: input.eventId, action: existing.action }, 200);
  const [member, settings] = await Promise.all([
    db.prepare("SELECT id, external_id AS externalId, first_name AS firstName, last_name AS lastName FROM members WHERE installation_id = 'primary' AND (id = ? OR external_id = ?) AND active = 1").bind(input.memberId, input.memberId).first<{ id: string; externalId: string; firstName: string; lastName: string }>(),
    db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number }>(),
  ]);
  const meeting = input.meetingId
    ? await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first<{ id: string; title: string; startsAt: string; endsAt: string }>()
    : await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND starts_at <= ? ORDER BY starts_at DESC LIMIT 1").bind(input.occurredAt).first<{ id: string; title: string; startsAt: string; endsAt: string }>();
  if (!member) throw new HttpError(404, "This fingerprint is not linked to an active roster member");
  if (!meeting) throw new HttpError(409, "No meeting is accepting attendance scans at this time");
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
    const meeting = input.meetingId ? await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ? AND is_test = 1").bind(input.meetingId).first() : null;
    if (!meeting) throw new HttpError(400, "The simulator can check in only to a meeting marked as a test");
    if (input.action === "scan" && !["check_in", "check_out"].includes(input.scanAction ?? "")) throw new HttpError(400, "Simulator scanAction must be check_in or check_out");
    const result = await recordAttendance(db, { eventId: input.eventId ?? `simulator-${crypto.randomUUID()}`, memberId: input.memberId, meetingId: input.meetingId, occurredAt: new Date().toISOString(), desiredAction: input.action === "scan" ? input.scanAction : undefined }, "manual", principal.userId);
    await writeAudit(db, principal, input.scanAction === "check_out" ? "simulator.check_out" : "simulator.check_in", "meeting", input.meetingId!, { memberId: input.memberId }); return result;
  }
  throw new HttpError(400, "Simulator action must be pair, heartbeat, scan, or stop");
}
async function attendance(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const url = new URL(request.url);
  if (request.method === "GET") {
    const meetingId = url.searchParams.get("meetingId"); if (!meetingId) throw new HttpError(400, "meetingId is required");
    const [rows, meeting, settings] = await Promise.all([
      db.prepare("SELECT m.id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id AS discordUserId, (SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS correction, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_out') AS checkedOutAt FROM members m WHERE m.installation_id = 'primary' AND m.active = 1 ORDER BY m.last_name, m.first_name").bind(meetingId, meetingId, meetingId, meetingId).all<{ memberId: string; externalId: string; firstName: string; lastName: string; discordUserId?: string; correction?: "present" | "absent" | "excused"; reason?: string; checkedInAt?: string; checkedOutAt?: string }>(),
      db.prepare("SELECT starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(meetingId).first<{ startsAt: string; endsAt: string }>(),
      db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number }>(),
    ]);
    if (!meeting) throw new HttpError(404, "Meeting not found");
    const closesAt = attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30); const finalized = Date.now() > Date.parse(closesAt);
    return response({ attendance: (rows.results ?? []).map((row) => { const events = [{ action: "check_in" as const, occurredAt: row.checkedInAt }, ...(row.checkedOutAt ? [{ action: "check_out" as const, occurredAt: row.checkedOutAt }] : [])].filter((event) => event.occurredAt); const derived = attendanceDisposition(events, row.correction); return { ...row, disposition: finalized && derived === "active" ? "absent" : derived }; }), attendanceClosesAt: closesAt, finalized });
  }
  return recordAttendance(db, await parseJson(request), "manual", principal.userId);
}
async function correction(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<{ memberId?: string; meetingId?: string; disposition?: "present" | "absent" | "excused"; reason?: string }>(request);
  if (!input.memberId || !input.meetingId || !input.disposition || !["present", "absent", "excused"].includes(input.disposition) || !input.reason?.trim() || input.reason.length > 300) throw new HttpError(400, "Member, meeting, disposition, and a correction reason are required");
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO attendance_corrections (id, installation_id, member_id, meeting_id, disposition, reason, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, input.memberId, input.meetingId, input.disposition, input.reason.trim(), principal.userId, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'attendance.corrected', 'attendance_correction', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ memberId: input.memberId, meetingId: input.meetingId, disposition: input.disposition }), now),
  ]);
  return response({ correction: { id, ...input, reason: input.reason.trim(), createdAt: now } }, 201);
}
function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
async function attendanceExport(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const result = await db.prepare("SELECT mt.title AS meeting, CASE WHEN mt.is_test = 1 THEN 'test' ELSE 'normal' END AS meetingType, mt.starts_at AS meetingStart, mt.ends_at AS meetingEnd, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, COALESCE((SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = mt.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1), CASE WHEN EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = mt.id AND e.action = 'check_in') AND EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = mt.id AND e.action = 'check_out') THEN 'present' ELSE 'absent' END) AS disposition, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = mt.id AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = mt.id AND e.action = 'check_out') AS checkedOutAt, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = mt.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason FROM meetings mt CROSS JOIN members m WHERE mt.installation_id = 'primary' AND m.installation_id = 'primary' AND m.active = 1 ORDER BY mt.starts_at, m.last_name, m.first_name").all<Record<string, unknown>>();
  const headers = ["meeting", "meetingType", "meetingStart", "meetingEnd", "memberId", "firstName", "lastName", "disposition", "checkedInAt", "checkedOutAt", "reason"];
  const csv = [headers.join(","), ...(result.results ?? []).map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n") + "\r\n";
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
  const fields = provider === "google" ? ["clientId", "clientSecret"] : provider === "resend" ? ["apiKey", "fromEmail"] : ["botToken", "guildId", "channelId", "publicKey"];
  const output: Record<string, string> = {};
  for (const field of fields) { const value = input[field]; if (typeof value !== "string" || !value.trim() || value.length > 500) throw new HttpError(400, `${field} is required`); output[field] = value.trim(); }
  if (provider === "resend" && !validEmail(output.fromEmail)) throw new HttpError(400, "fromEmail must be a valid email address");
  if (provider === "discord" && !/^[0-9a-f]{64}$/i.test(output.publicKey)) throw new HttpError(400, "Discord public key must contain 64 hexadecimal characters");
  return output;
}
type IntegrationRecord = { id: string; ciphertext: string; iv: string; updatedAt: string; verifiedAt?: string | null };
async function integrationRecord(env: Env, provider: IntegrationProvider): Promise<IntegrationRecord | null> {
  return requireDatabase(env).prepare("SELECT id, ciphertext, iv, updated_at AS updatedAt, verified_at AS verifiedAt FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = ?").bind(provider).first();
}
async function integrationsStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const result = await requireDatabase(env).prepare("SELECT i.provider, i.updated_at AS updatedAt, i.verified_at AS verifiedAt, EXISTS(SELECT 1 FROM integration_verification_challenges c WHERE c.installation_id = i.installation_id AND c.provider = i.provider AND c.expires_at > ?) AS verificationPending FROM encrypted_integrations i WHERE i.installation_id = 'primary' ORDER BY i.provider").bind(new Date().toISOString()).all<{ provider: IntegrationProvider; updatedAt: string; verifiedAt?: string | null; verificationPending: number }>();
  const saved = new Map((result.results ?? []).map((item) => [item.provider, item]));
  return response({ integrations: [...integrationProviders].map((provider) => { const item = saved.get(provider); return { provider, saved: Boolean(item), configured: Boolean(item?.verifiedAt), state: !item ? "not_configured" : item.verifiedAt ? "configured" : "verification_required", updatedAt: item?.updatedAt, verifiedAt: item?.verifiedAt ?? undefined, verificationPending: Boolean(item?.verificationPending) }; }) });
}
async function integrationConfiguration(request: Request, env: Env, provider: IntegrationProvider): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "DELETE") {
    if (provider === "google") {
      const installation = await db.prepare("SELECT auth_mode AS authMode FROM installations WHERE id = 'primary'").first<{ authMode: AuthMode }>();
      if (installation?.authMode === "google") throw new HttpError(409, "Google OAuth is the only enabled sign-in method and cannot be removed");
    }
    await db.batch([db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider), db.prepare("DELETE FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = ?").bind(provider), ...(provider === "google" ? [db.prepare("UPDATE installations SET auth_mode = 'local' WHERE id = 'primary' AND auth_mode = 'both'")] : [])]);
    await writeAudit(db, principal, "integration.removed", "integration", provider); return response({ configured: false, provider });
  }
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const existing = await integrationRecord(env, provider); const secret = validateIntegration(provider, await parseJson<Record<string, unknown>>(request)); const encrypted = await encryptIntegration(secret, env.INTEGRATION_KEY); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES (?, 'primary', ?, ?, ?, NULL, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, verified_at = NULL, key_version = key_version + 1, updated_at = excluded.updated_at").bind(crypto.randomUUID(), provider, encrypted.ciphertext, encrypted.iv, now),
    db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider),
  ]);
  if (provider === "google") await db.prepare("UPDATE installations SET auth_mode = CASE WHEN auth_mode = 'local' THEN 'both' ELSE auth_mode END WHERE id = 'primary'").run();
  await writeAudit(db, principal, existing ? "integration.rotated" : "integration.saved", "integration", provider); return response({ saved: true, configured: false, created: !existing, provider, state: "verification_required", updatedAt: now });
}
async function markIntegrationVerified(db: D1Database, provider: IntegrationProvider, actorUserId: string | null, metadata: Record<string, unknown> = {}) {
  const now = new Date().toISOString(); await db.batch([
    db.prepare("UPDATE encrypted_integrations SET verified_at = ? WHERE installation_id = 'primary' AND provider = ?").bind(now, provider),
    db.prepare("DELETE FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = ?").bind(provider),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'integration.verified', 'integration', ?, ?, ?)").bind(crypto.randomUUID(), actorUserId, provider, JSON.stringify(metadata), now),
  ]); return now;
}
async function startResendVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ email?: string }>(request); const target = input.email?.trim().toLowerCase();
  if (!target || !validEmail(target)) throw new HttpError(400, "Enter a valid email address that you can open now");
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured"); const record = await integrationRecord(env, "resend"); if (!record) throw new HttpError(404, "Save Resend credentials before verification"); const secret = await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
  const digits = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000; const code = digits.toString().padStart(6, "0"); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const result = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${secret.apiKey}`, "content-type": "application/json", "idempotency-key": `lancerlogin-verify-${crypto.randomUUID()}` }, body: JSON.stringify({ from: secret.fromEmail, to: [target], subject: "Your LancerLogin verification code", text: `Your LancerLogin verification code is ${code}. It expires in 10 minutes.`, html: `<p>Your LancerLogin verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p>` }) });
  if (!result.ok) throw new HttpError(502, "Resend could not deliver the verification email"); const body = await result.json().catch(() => ({})) as { id?: string };
  await db.prepare("INSERT INTO integration_verification_challenges (installation_id, provider, challenge_hash, target, external_id, expires_at, created_by, created_at) VALUES ('primary', 'resend', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET challenge_hash = excluded.challenge_hash, target = excluded.target, external_id = excluded.external_id, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = excluded.created_at").bind(await sha256(code), target, body.id ?? null, expiresAt, principal.userId, now.toISOString()).run();
  await writeAudit(db, principal, "integration.verification_started", "integration", "resend", { target, deliveryId: body.id ?? null }); return response({ provider: "resend", verificationPending: true, expiresAt, target }, 202);
}
async function completeResendVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ code?: string }>(request); const code = input.code?.trim();
  if (!code || !/^\d{6}$/.test(code)) throw new HttpError(400, "Enter the six-digit code from the verification email");
  const challenge = await db.prepare("SELECT challenge_hash AS challengeHash, target, expires_at AS expiresAt FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'resend'").first<{ challengeHash: string; target: string; expiresAt: string }>();
  if (!challenge || challenge.expiresAt <= new Date().toISOString() || challenge.challengeHash !== await sha256(code)) throw new HttpError(400, "The verification code is invalid or expired");
  const verifiedAt = await markIntegrationVerified(db, "resend", principal.userId, { target: challenge.target }); return response({ provider: "resend", configured: true, state: "configured", verifiedAt });
}
async function googleCredentials(env: Env): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "google"); if (!record) throw new HttpError(503, "Google OAuth is not configured");
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
  const record = await integrationRecord(env, "resend"); if (!record) throw new HttpError(503, "Resend is not configured");
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
    const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first<{ id: string; title: string; startsAt: string }>();
    if (!meeting) throw new HttpError(404, "Meeting not found");
    subject = `Missed meeting: ${meeting.title}`; content = `<p>Hello ${html(member.firstName)},</p><p>Our records show you missed <strong>${html(meeting.title)}</strong> on ${html(new Date(meeting.startsAt).toISOString().slice(0, 10))}.</p><p>Please contact your organization if this should be corrected or excused.</p>`; deliveryKey = `missed:${meeting.id}:${member.id}`;
  } else {
    const records = await db.prepare("SELECT mt.title, mt.starts_at AS startsAt, COALESCE((SELECT c.disposition FROM attendance_corrections c WHERE c.meeting_id = mt.id AND c.member_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1), CASE WHEN EXISTS (SELECT 1 FROM attendance_events e WHERE e.meeting_id = mt.id AND e.member_id = ? AND e.action = 'check_in') AND EXISTS (SELECT 1 FROM attendance_events e WHERE e.meeting_id = mt.id AND e.member_id = ? AND e.action = 'check_out') THEN 'present' ELSE 'absent' END) AS disposition FROM meetings mt WHERE mt.installation_id = 'primary' ORDER BY mt.starts_at DESC LIMIT 100").bind(member.id, member.id, member.id).all<{ title: string; startsAt: string; disposition: string }>();
    subject = "Your attendance report"; content = `<p>Hello ${html(member.firstName)},</p><p>Here is your current attendance report.</p><table><thead><tr><th>Meeting</th><th>Date</th><th>Status</th></tr></thead><tbody>${(records.results ?? []).map((row) => `<tr><td>${html(row.title)}</td><td>${html(row.startsAt.slice(0, 10))}</td><td>${html(row.disposition)}</td></tr>`).join("")}</tbody></table>`; deliveryKey = `report:${member.id}:${new Date().toISOString().slice(0, 10)}`;
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
  const record = await integrationRecord(env, "discord"); if (!record) throw new HttpError(503, "Discord is not configured");
  if (!allowUnverified && !record.verifiedAt) throw new HttpError(503, "Discord verification is required before using attendance workflows");
  return decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
}
async function discordRequest(config: Record<string, string>, path: string, init: RequestInit): Promise<{ response: globalThis.Response; body: Record<string, unknown> }> {
  const result = await fetch(`https://discord.com/api/v10${path}`, { ...init, headers: { authorization: `Bot ${config.botToken}`, "content-type": "application/json", ...init.headers } });
  const body = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (!result.ok) throw new HttpError(502, `Discord rejected the request (${result.status})`);
  return { response: result, body };
}
async function startDiscordVerification(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const config = await discordConfiguration(env, true);
  await discordRequest(config, "/users/@me", { method: "GET" });
  await discordRequest(config, `/guilds/${encodeURIComponent(config.guildId)}`, { method: "GET" });
  const challenge = randomToken(24); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const payload = { content: "LancerLogin is ready to verify this server and attendance channel. An Admin should click the button below within 10 minutes.", allowed_mentions: { parse: [] }, components: [{ type: 1, components: [{ type: 2, style: 1, label: "Verify LancerLogin", custom_id: `lancerlogin-verify:${challenge}` }] }] };
  const { body } = await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages`, { method: "POST", body: JSON.stringify(payload) }); const messageId = String(body.id ?? "");
  if (!messageId) throw new HttpError(502, "Discord did not return a verification message identifier");
  await db.prepare("INSERT INTO integration_verification_challenges (installation_id, provider, challenge_hash, target, external_id, expires_at, created_by, created_at) VALUES ('primary', 'discord', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET challenge_hash = excluded.challenge_hash, target = excluded.target, external_id = excluded.external_id, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = excluded.created_at").bind(await sha256(challenge), config.guildId, messageId, expiresAt, principal.userId, now.toISOString()).run();
  await writeAudit(db, principal, "integration.verification_started", "integration", "discord", { guildId: config.guildId, channelId: config.channelId, messageId });
  return response({ provider: "discord", verificationPending: true, expiresAt, messageId }, 202);
}
async function linkDiscordMember(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ memberId?: string; discordUserId?: string | null }>(request);
  if (!input.memberId || (input.discordUserId !== null && !/^\d{10,24}$/.test(input.discordUserId ?? ""))) throw new HttpError(400, "Member and a valid Discord user ID are required");
  await db.prepare("UPDATE members SET discord_user_id = ? WHERE installation_id = 'primary' AND id = ?").bind(input.discordUserId, input.memberId).run();
  await writeAudit(db, principal, input.discordUserId ? "discord.member_linked" : "discord.member_unlinked", "member", input.memberId);
  return response({ linked: Boolean(input.discordUserId), memberId: input.memberId });
}
async function linkedAbsentMembers(db: D1Database, meetingId: string): Promise<{ id: string; discordUserId: string }[]> {
  const missing = await db.prepare("SELECT m.id, m.discord_user_id AS discordUserId FROM members m WHERE m.installation_id = 'primary' AND m.active = 1 AND m.discord_user_id IS NOT NULL AND COALESCE((SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1), CASE WHEN EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_in') AND EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_out') THEN 'present' ELSE 'absent' END) = 'absent'").bind(meetingId, meetingId, meetingId).all<{ id: string; discordUserId: string }>();
  return missing.results ?? [];
}
async function sendDiscordAttendanceNotification(env: Env, meeting: { id: string; title: string }, options: { force?: boolean; actor?: Principal } = {}): Promise<{ posted: boolean; duplicate?: boolean; linkedMissingCount: number; messageId?: string }> {
  const db = requireDatabase(env); const now = new Date().toISOString();
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
    const config = await discordConfiguration(env); const userIds = members.map((member) => member.discordUserId); const mentions = userIds.map((id) => `<@${id}>`).join(" ");
    const payload = { content: `Attendance has closed for **${meeting.title}**. The following members are marked absent: ${mentions}\nIf you attended, use the button below to request a private review. Your attendance will not change until an Operator or Admin approves it.`, allowed_mentions: { parse: [], users: userIds }, components: [{ type: 1, components: [{ type: 2, style: 2, label: "Contest absence", custom_id: `lancerlogin-attendance:${meeting.id}` }] }] };
    const { body } = await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages`, { method: "POST", body: JSON.stringify(payload) }); const messageId = String(body.id ?? "");
    if (!messageId) throw new HttpError(502, "Discord did not return a message identifier");
    await db.batch([
      db.prepare("DELETE FROM discord_attendance_recipients WHERE installation_id = 'primary' AND meeting_id = ?").bind(meeting.id),
      ...members.map((member) => db.prepare("INSERT INTO discord_attendance_recipients (installation_id, meeting_id, member_id, discord_user_id, message_id, delivered_at) VALUES ('primary', ?, ?, ?, ?, ?)").bind(meeting.id, member.id, member.discordUserId, messageId, now)),
      db.prepare("UPDATE discord_attendance_notifications SET status = 'delivered', message_id = ?, processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(messageId, now, now, meeting.id),
    ]);
    if (options.actor) await writeAudit(db, options.actor, "discord.missing_notified", "meeting", meeting.id, { linkedMissingCount: members.length, messageId, manual: true });
    return { posted: true, linkedMissingCount: members.length, messageId };
  } catch (error) {
    await db.prepare("UPDATE discord_attendance_notifications SET status = 'failed', last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord delivery failed", new Date().toISOString(), meeting.id).run();
    throw error;
  }
}
async function processDiscordAttendanceNotifications(env: Env, now = Date.now()): Promise<void> {
  const db = requireDatabase(env); const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number }>();
  const meetings = await db.prepare("SELECT m.id, m.title, m.ends_at AS endsAt, n.status AS notificationStatus, n.updated_at AS notificationUpdatedAt FROM meetings m LEFT JOIN discord_attendance_notifications n ON n.installation_id = m.installation_id AND n.meeting_id = m.id WHERE m.installation_id = 'primary' AND m.required = 1 AND m.is_test = 0 AND m.ends_at IS NOT NULL ORDER BY m.ends_at DESC LIMIT 100").all<{ id: string; title: string; endsAt: string; notificationStatus?: string; notificationUpdatedAt?: string }>();
  for (const meeting of meetings.results ?? []) {
    const cutoff = Date.parse(attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30)); const newlyEligible = cutoff <= now && cutoff >= now - 15 * 60_000; const retry = meeting.notificationStatus === "failed";
    if ((!meeting.notificationStatus && newlyEligible) || retry) await sendDiscordAttendanceNotification(env, meeting);
  }
}
async function discordMissing(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string }>(request);
  if (!input.meetingId) throw new HttpError(400, "Meeting is required");
  const meeting = await db.prepare("SELECT id, title FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first<{ id: string; title: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found");
  return response(await sendDiscordAttendanceNotification(env, meeting, { force: true, actor: principal }), 202);
}
async function discordContests(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const meetingId = new URL(request.url).searchParams.get("meetingId"); const where = meetingId ? "AND c.meeting_id = ?" : "";
  const statement = requireDatabase(env).prepare(`SELECT c.meeting_id AS meetingId, mt.title AS meetingTitle, c.member_id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, c.status, c.created_at AS createdAt, c.resolved_at AS resolvedAt, c.review_note AS reviewNote FROM discord_attendance_contests c JOIN members m ON m.id = c.member_id AND m.installation_id = c.installation_id JOIN meetings mt ON mt.id = c.meeting_id AND mt.installation_id = c.installation_id WHERE c.installation_id = 'primary' ${where} ORDER BY CASE WHEN c.status = 'open' THEN 0 ELSE 1 END, c.created_at DESC`); const result = meetingId ? await statement.bind(meetingId).all() : await statement.all();
  return response({ contests: result.results ?? [] });
}
async function resolveDiscordContest(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string; memberId?: string; resolution?: "approved" | "rejected" | "reviewed"; reviewNote?: string }>(request);
  if (!input.meetingId || !input.memberId || !input.resolution || !["approved", "rejected", "reviewed"].includes(input.resolution) || !input.reviewNote?.trim() || input.reviewNote.length > 500) throw new HttpError(400, "Meeting, member, valid resolution, and a review note are required");
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
const discordEphemeral = (content: string) => response({ type: 4, data: { content, flags: 64 } });
async function discordInteraction(request: Request, env: Env): Promise<Response> {
  const config = await discordConfiguration(env, true); const raw = await request.text();
  if (!await verifyDiscordInteraction(request, config, raw)) throw new HttpError(401, "Discord interaction signature is invalid");
  let interaction: { type?: number; guild_id?: string; data?: { custom_id?: string }; member?: { user?: { id?: string } }; user?: { id?: string }; message?: { id?: string } };
  try { interaction = JSON.parse(raw); } catch { throw new HttpError(400, "Discord interaction body is invalid"); }
  if (interaction.type === 1) return response({ type: 1 });
  const customId = interaction.data?.custom_id ?? ""; const discordUserId = interaction.member?.user?.id ?? interaction.user?.id; const messageId = interaction.message?.id; const db = requireDatabase(env);
  if (interaction.type === 3 && customId.startsWith("lancerlogin-verify:") && discordUserId && messageId) {
    const token = customId.slice("lancerlogin-verify:".length);
    const challenge = await db.prepare("SELECT challenge_hash AS challengeHash, target, external_id AS externalId, expires_at AS expiresAt FROM integration_verification_challenges WHERE installation_id = 'primary' AND provider = 'discord'").first<{ challengeHash: string; target: string; externalId: string; expiresAt: string }>();
    if (!challenge || challenge.expiresAt <= new Date().toISOString() || challenge.challengeHash !== await sha256(token) || challenge.externalId !== messageId || challenge.target !== interaction.guild_id) return discordEphemeral("This LancerLogin verification request is invalid or expired. Start verification again from the dashboard.");
    await markIntegrationVerified(db, "discord", null, { discordUserId, guildId: interaction.guild_id, messageId });
    return discordEphemeral("LancerLogin is verified. You can return to the dashboard.");
  }
  const record = await integrationRecord(env, "discord");
  if (!record?.verifiedAt) return discordEphemeral("This LancerLogin Discord integration has not been verified by an Admin.");
  const meetingId = customId.startsWith("lancerlogin-attendance:") ? customId.slice("lancerlogin-attendance:".length) : "";
  if (interaction.type !== 3 || !meetingId || !discordUserId || !messageId) return discordEphemeral("This attendance contest button is invalid or expired. Ask an Operator for help.");
  const recipient = await db.prepare("SELECT r.member_id AS memberId FROM discord_attendance_recipients r JOIN members m ON m.installation_id = r.installation_id AND m.id = r.member_id WHERE r.installation_id = 'primary' AND r.meeting_id = ? AND r.message_id = ? AND r.discord_user_id = ? AND m.discord_user_id = ? AND m.active = 1").bind(meetingId, messageId, discordUserId, discordUserId).first<{ memberId: string }>();
  if (!recipient) return discordEphemeral("This absence notice was not delivered for your linked roster account. Ask an Operator for help.");
  if (!(await linkedAbsentMembers(db, meetingId)).some((member) => member.id === recipient.memberId)) return discordEphemeral("Attendance no longer shows you as absent, so no contest was created.");
  const now = new Date().toISOString(); await db.prepare("INSERT OR IGNORE INTO discord_attendance_contests (installation_id, meeting_id, member_id, message_id, status, created_at, submitted_by_discord_user_id) VALUES ('primary', ?, ?, ?, 'open', ?, ?)").bind(meetingId, recipient.memberId, messageId, now, discordUserId).run();
  const contest = await db.prepare("SELECT status FROM discord_attendance_contests WHERE installation_id = 'primary' AND meeting_id = ? AND member_id = ?").bind(meetingId, recipient.memberId).first<{ status: string }>();
  return contest?.status === "open" ? discordEphemeral("Your attendance contest was recorded for review. Your attendance has not been changed.") : discordEphemeral(`Your attendance contest was already reviewed with status ${contest?.status ?? "unknown"}.`);
}
async function discordCalendar(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string }>(request); if (!input.meetingId) throw new HttpError(400, "Meeting is required");
  const config = await discordConfiguration(env); const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, notes FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first<{ id: string; title: string; startsAt: string; endsAt?: string; notes?: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found");
  const stateKey = `calendar:${meeting.id}`; const existing = await db.prepare("SELECT external_id AS externalId FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = ?").bind(stateKey).first<{ externalId?: string }>();
  const payload = { name: meeting.title, description: meeting.notes || "LancerLogin meeting", privacy_level: 2, entity_type: 3, scheduled_start_time: meeting.startsAt, scheduled_end_time: meeting.endsAt || new Date(Date.parse(meeting.startsAt) + 3_600_000).toISOString(), entity_metadata: { location: "LancerLogin" } };
  const path = existing?.externalId ? `/guilds/${config.guildId}/scheduled-events/${existing.externalId}` : `/guilds/${config.guildId}/scheduled-events`; const { body } = await discordRequest(config, path, { method: existing?.externalId ? "PATCH" : "POST", body: JSON.stringify(payload) }); const eventId = String(body.id ?? existing?.externalId ?? ""); const now = new Date().toISOString();
  await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, updated_at) VALUES ('primary', 'discord', ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, updated_at = excluded.updated_at").bind(stateKey, eventId, now).run();
  await writeAudit(db, principal, "discord.calendar_synced", "meeting", meeting.id, { eventId }); return response({ synced: true, eventId });
}
async function syncDiscordKioskStatus(env: Env): Promise<{ changed: boolean; messageId?: string; online?: boolean; kioskId?: string }> {
  const db = requireDatabase(env); const config = await discordConfiguration(env);
  const kiosk = await db.prepare("SELECT id, name, last_seen_at AS lastSeenAt, reader_online AS readerOnline, release_version AS releaseVersion FROM kiosks WHERE installation_id = 'primary' AND active = 1 ORDER BY created_at DESC LIMIT 1").first<{ id: string; name: string; lastSeenAt?: string; readerOnline?: number; releaseVersion?: string }>();
  const online = Boolean(kiosk?.lastSeenAt && Date.now() - Date.parse(kiosk.lastSeenAt) < 2 * 60_000);
  const content = kiosk
    ? `**${kiosk.name}** · ${online ? "online" : "offline"} · reader ${kiosk.readerOnline ? "online" : "offline"} · release ${kiosk.releaseVersion ?? "unknown"}${online ? "" : ` · last seen ${kiosk.lastSeenAt ?? "never"}`}`
    : "No kiosk is paired.";
  const contentHash = await sha256(content);
  const existing = await db.prepare("SELECT external_id AS externalId, content_hash AS contentHash FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'kiosk-status'").first<{ externalId?: string; contentHash?: string }>();
  if (existing?.externalId && existing.contentHash === contentHash) return { changed: false, messageId: existing.externalId, online, kioskId: kiosk?.id };
  const path = existing?.externalId ? `/channels/${config.channelId}/messages/${existing.externalId}` : `/channels/${config.channelId}/messages`; const { body } = await discordRequest(config, path, { method: existing?.externalId ? "PATCH" : "POST", body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) }); const messageId = String(body.id ?? existing?.externalId ?? ""); const now = new Date().toISOString();
  await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', 'kiosk-status', ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(messageId, contentHash, now).run();
  return { changed: true, messageId, online, kioskId: kiosk?.id };
}
async function discordKioskStatus(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]);
  const result = await syncDiscordKioskStatus(env);
  await writeAudit(requireDatabase(env), principal, "discord.kiosk_status_updated", "kiosk", result.kioskId ?? null, { online: result.online, messageId: result.messageId, changed: result.changed });
  return response({ changed: result.changed, messageId: result.messageId, online: result.online });
}

async function transmitTelemetry(env: Env, metro?: string): Promise<boolean> {
  if (!env.TELEMETRY_ENDPOINT || !env.RELEASE_VERSION || !env.DB) return false;
  const endpoint = new URL(env.TELEMETRY_ENDPOINT); if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
  const installation = await env.DB.prepare("SELECT telemetry_accepted_at AS acceptedAt, telemetry_install_id AS installId FROM installations WHERE id = 'primary'").first<{ acceptedAt?: string; installId?: string }>();
  if (!installation?.acceptedAt || !installation.installId) return false;
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM kiosks WHERE installation_id = 'primary' AND active = 1").first<{ count: number }>();
  const diagnostic = await env.DB.prepare("SELECT error_category AS errorCategory FROM telemetry_diagnostics WHERE installation_id = 'primary'").first<{ errorCategory?: "worker-internal" | "integration-upstream" }>();
  const payload: Record<string, unknown> = { installId: installation.installId, releaseVersion: env.RELEASE_VERSION, activeKioskCount: Number(count?.count ?? 0) };
  if (metro) payload.metro = String(metro).slice(0, 100);
  if (diagnostic?.errorCategory) payload.errorCategory = diagnostic.errorCategory;
  const sent = (await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).ok;
  if (sent && diagnostic?.errorCategory) await env.DB.prepare("DELETE FROM telemetry_diagnostics WHERE installation_id = 'primary' AND error_category = ?").bind(diagnostic.errorCategory).run();
  return sent;
}
async function recordTelemetryDiagnostic(env: Env, errorCategory: "worker-internal" | "integration-upstream"): Promise<void> {
  if (!env.DB) return;
  try {
    const consent = await env.DB.prepare("SELECT telemetry_accepted_at AS acceptedAt FROM installations WHERE id = 'primary'").first<{ acceptedAt?: string }>();
    if (!consent?.acceptedAt) return;
    await env.DB.prepare("INSERT INTO telemetry_diagnostics (installation_id, error_category, last_seen_at) VALUES ('primary', ?, ?) ON CONFLICT(installation_id) DO UPDATE SET error_category = excluded.error_category, last_seen_at = excluded.last_seen_at").bind(errorCategory, new Date().toISOString()).run();
  } catch { /* Diagnostics are best-effort and never alter the request response. */ }
}
async function privacySettings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const installation = await db.prepare("SELECT telemetry_accepted_at AS acceptedAt, telemetry_install_id AS installationReference FROM installations WHERE id = 'primary'").first<{ acceptedAt?: string; installationReference?: string }>(); return response({ telemetryAccepted: Boolean(installation?.acceptedAt), acceptedAt: installation?.acceptedAt, installationReference: installation?.acceptedAt ? installation.installationReference : undefined, notice: "Anonymous usage data only. No roster or user data is ever shared." }); }
  const input = await parseJson<{ telemetryAccepted?: boolean }>(request); if (typeof input.telemetryAccepted !== "boolean") throw new HttpError(400, "telemetryAccepted must be true or false"); const now = new Date().toISOString();
  await db.prepare("UPDATE installations SET telemetry_accepted_at = ?, telemetry_install_id = ? WHERE id = 'primary'").bind(input.telemetryAccepted ? now : null, input.telemetryAccepted ? crypto.randomUUID() : null).run();
  await writeAudit(db, principal, input.telemetryAccepted ? "telemetry.accepted" : "telemetry.declined", "installation", "primary");
  if (input.telemetryAccepted) { const cf = (request as Request & { cf?: { city?: string; metroCode?: string } }).cf; try { await transmitTelemetry(env, cf?.city || cf?.metroCode); } catch { /* Consent remains saved if reporting is unavailable. */ } }
  return response({ telemetryAccepted: input.telemetryAccepted, acceptedAt: input.telemetryAccepted ? now : null });
}

type BackupScope = "meetings" | "roster" | "installation";
const tableColumns = {
  installations: ["id", "created_at", "auth_mode", "telemetry_accepted_at", "telemetry_install_id"],
  organization_settings: ["installation_id", "organization_name", "subtitle", "logo_data", "primary_color", "secondary_color", "appearance", "time_zone", "late_scan_minutes", "logo_backdrop"],
  users: ["id", "installation_id", "email", "local_username", "password_hash", "failed_login_count", "locked_until", "role", "active", "created_at", "member_id"],
  members: ["id", "installation_id", "external_id", "first_name", "last_name", "email", "discord_user_id", "active", "created_at"],
  meetings: ["id", "installation_id", "title", "starts_at", "ends_at", "required", "notes", "created_by", "created_at", "is_test", "series_id", "recurrence_frequency", "recurrence_until", "recurrence_sequence"],
  attendance_events: ["id", "installation_id", "member_id", "meeting_id", "source", "occurred_at", "kiosk_event_id", "created_by", "action"],
  attendance_corrections: ["id", "installation_id", "member_id", "meeting_id", "disposition", "reason", "created_by", "created_at"],
  setup_progress: ["installation_id", "step", "completed_at", "completed_by"],
  pairing_codes: ["id", "installation_id", "code_hash", "expires_at", "redeemed_at", "created_by", "created_at", "purpose"],
  kiosks: ["id", "installation_id", "pairing_code_id", "name", "token_hash", "active", "last_seen_at", "created_at", "reader_online", "release_version", "pending_events", "last_sync_at", "error_category"],
  simulated_kiosk_sessions: ["installation_id", "pairing_code_id", "name", "active", "online", "last_seen_at", "created_by", "created_at"],
  encrypted_integrations: ["id", "installation_id", "provider", "ciphertext", "iv", "key_version", "updated_at", "verified_at"],
  integration_deliveries: ["id", "installation_id", "provider", "delivery_key", "status", "external_id", "created_at", "updated_at"],
  integration_state: ["installation_id", "provider", "state_key", "external_id", "content_hash", "updated_at"],
  discord_attendance_notifications: ["installation_id", "meeting_id", "status", "message_id", "attempts", "last_error", "processed_at", "updated_at"],
  discord_attendance_recipients: ["installation_id", "meeting_id", "member_id", "discord_user_id", "message_id", "delivered_at"],
  discord_attendance_contests: ["installation_id", "meeting_id", "member_id", "message_id", "status", "resolved_by", "resolved_at", "created_at", "submitted_by_discord_user_id", "review_note"],
  audit_log: ["id", "installation_id", "actor_user_id", "action", "target_type", "target_id", "metadata_json", "created_at"],
  telemetry_diagnostics: ["installation_id", "error_category", "last_seen_at"],
} as const;
type BackupTable = keyof typeof tableColumns;
// Restore parents before children so SQLite's immediate foreign-key checks remain valid.
const installationTables: BackupTable[] = [
  "installations", "organization_settings", "members", "users", "meetings",
  "attendance_events", "attendance_corrections", "setup_progress", "pairing_codes",
  "kiosks", "simulated_kiosk_sessions", "encrypted_integrations", "integration_deliveries",
  "integration_state", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "audit_log", "telemetry_diagnostics",
];
const meetingTables: BackupTable[] = ["meetings", "attendance_events", "attendance_corrections", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests"];
const rosterTables: BackupTable[] = ["members"];
const tablesForScope = (scope: BackupScope) => scope === "installation" ? installationTables : scope === "meetings" ? meetingTables : rosterTables;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeBackupValue = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

async function backupData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const scope = new URL(request.url).searchParams.get("scope") as BackupScope;
  if (!["meetings", "roster", "installation"].includes(scope)) throw new HttpError(400, "Backup scope must be meetings, roster, or installation");
  const entries = await Promise.all(tablesForScope(scope).map(async (table) => {
    const where = table === "installations" ? "id = 'primary'" : "installation_id = 'primary'"; const result = await db.prepare(`SELECT ${tableColumns[table].join(", ")} FROM ${table} WHERE ${where}`).all<Record<string, unknown>>(); return [table, result.results ?? []] as const;
  }));
  const exportedAt = new Date().toISOString(); const backup = { product: "LancerLogin", schemaVersion: 4, scope, exportedAt, tables: Object.fromEntries(entries) };
  await writeAudit(db, principal, "data.backup_exported", "installation", "primary", { scope, schemaVersion: 4 });
  return response(backup, 200, { "content-disposition": `attachment; filename="lancerlogin-${scope}-backup-${exportedAt.slice(0, 10)}.json"` });
}

type NormalizedBackup = { product: "LancerLogin"; schemaVersion: 1 | 2 | 3 | 4; scope: BackupScope; exportedAt: string; tables: Record<BackupTable, Record<string, unknown>[]> };
const legacyTableColumns: Partial<Record<BackupTable, readonly string[]>> = {
  organization_settings: tableColumns.organization_settings.slice(0, -2),
  attendance_events: tableColumns.attendance_events.slice(0, -1),
  discord_attendance_contests: tableColumns.discord_attendance_contests.slice(0, -2),
};
const legacyInstallationTables = installationTables.filter((table) => table !== "discord_attendance_notifications" && table !== "discord_attendance_recipients");
const legacyMeetingTables = meetingTables.filter((table) => table !== "discord_attendance_notifications" && table !== "discord_attendance_recipients");
const legacyTablesForScope = (scope: BackupScope) => scope === "installation" ? legacyInstallationTables : scope === "meetings" ? legacyMeetingTables : rosterTables;

function normalizeBackup(value: unknown, scope: BackupScope): NormalizedBackup {
  if (!isObject(value) || value.product !== "LancerLogin" || ![1, 2, 3, 4].includes(Number(value.schemaVersion)) || value.scope !== scope || typeof value.exportedAt !== "string" || !isObject(value.tables)) throw new HttpError(400, "The selected file is not a matching current LancerLogin backup");
  const schemaVersion = Number(value.schemaVersion) as 1 | 2 | 3 | 4;
  const sourceTables = value.tables;
  const requiredTables = schemaVersion === 1 ? legacyTablesForScope(scope) : tablesForScope(scope);
  let rows = 0;
  for (const table of requiredTables) {
    const tableRows = sourceTables[table]; if (!Array.isArray(tableRows)) throw new HttpError(400, `Backup table ${table} is missing`); rows += tableRows.length;
    const columns = schemaVersion === 1 ? legacyTableColumns[table] ?? (table === "meetings" ? tableColumns.meetings.slice(0, -4) : table === "encrypted_integrations" ? tableColumns.encrypted_integrations.slice(0, -1) : tableColumns[table]) : schemaVersion === 2 && table === "meetings" ? tableColumns.meetings.slice(0, -4) : schemaVersion < 4 && table === "encrypted_integrations" ? tableColumns.encrypted_integrations.slice(0, -1) : tableColumns[table];
    for (const row of tableRows) { if (!isObject(row) || columns.some((column) => !safeBackupValue(row[column]))) throw new HttpError(400, `Backup table ${table} contains an invalid row`); }
  }
  if (rows > 150_000) throw new HttpError(400, "Backup contains too many records for dashboard restore; use the documented D1 restore workflow");

  const tables = Object.fromEntries((Object.keys(tableColumns) as BackupTable[]).map((table) => [table, [] as Record<string, unknown>[]])) as Record<BackupTable, Record<string, unknown>[]>;
  for (const table of requiredTables) tables[table] = (sourceTables[table] as Record<string, unknown>[]).map((row) => ({ ...row }));
  if (tables.organization_settings) tables.organization_settings = tables.organization_settings.map((row) => ({ late_scan_minutes: 30, logo_backdrop: "auto", ...row }));
  if (tables.encrypted_integrations) tables.encrypted_integrations = tables.encrypted_integrations.map((row) => ({ verified_at: null, ...row }));
  if (tables.meetings) tables.meetings = tables.meetings.map((row) => {
    const normalized: Record<string, unknown> = { series_id: null, recurrence_frequency: null, recurrence_until: null, recurrence_sequence: null, ...row };
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
  return { product: "LancerLogin", schemaVersion, scope, exportedAt: value.exportedAt, tables };
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
    db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_recipients WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_notifications WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meetings WHERE installation_id = 'primary'"),
    ...insertBackupRows(db, "meetings", tables.meetings), ...insertBackupRows(db, "attendance_events", tables.attendance_events), ...insertBackupRows(db, "attendance_corrections", tables.attendance_corrections), ...insertBackupRows(db, "discord_attendance_notifications", tables.discord_attendance_notifications), ...insertBackupRows(db, "discord_attendance_recipients", tables.discord_attendance_recipients), ...insertBackupRows(db, "discord_attendance_contests", tables.discord_attendance_contests),
  ];
  else if (scope === "roster") statements = [
    db.prepare("UPDATE members SET active = 0 WHERE installation_id = 'primary'"),
    ...tables.members.map((row) => db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, active, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, discord_user_id = excluded.discord_user_id, active = excluded.active").bind(row.id, row.external_id, row.first_name, row.last_name, row.email, row.discord_user_id, row.active, row.created_at)),
  ];
  else {
    statements = [db.prepare("DELETE FROM installations WHERE id = 'primary'")];
    for (const table of installationTables) statements.push(...insertBackupRows(db, table, tables[table]));
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
    db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_recipients WHERE installation_id = 'primary'"), db.prepare("DELETE FROM discord_attendance_notifications WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meetings WHERE installation_id = 'primary'"),
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
  try {
    if (request.method === "OPTIONS") result = new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-allow-credentials": "true" } });
    else if (url.pathname === "/health" && request.method === "GET") result = response({ ok: true, service: "lancerlogin-api", mode: env.DB ? "ready" : "unconfigured", releaseVersion: env.RELEASE_VERSION ?? "development" });
    else if (url.pathname === "/setup/status" && request.method === "GET") result = await setupStatus(env);
    else if (url.pathname === "/setup/bootstrap" && request.method === "POST") result = await bootstrap(request, env);
    else if (url.pathname === "/admin/update-info" && request.method === "GET") result = await updateInfo(request, env);
    else if (url.pathname === "/auth/local" && request.method === "POST") result = await localLogin(request, env);
    else if (url.pathname === "/auth/session" && request.method === "GET") result = await authSession(request, env);
    else if (url.pathname === "/auth/logout" && request.method === "POST") result = response({ ok: true }, 200, { "set-cookie": "lancerlogin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
    else if (url.pathname === "/auth/google/start" && request.method === "GET") result = await googleStart(request, env);
    else if (url.pathname === "/auth/google/callback" && request.method === "GET") result = await googleCallback(request, env);
    else if (url.pathname === "/admin/branding" && ["GET", "PATCH"].includes(request.method)) result = await branding(request, env);
    else if (url.pathname === "/admin/setup/progress" && ["GET", "PATCH"].includes(request.method)) result = await setupProgress(request, env);
    else if (url.pathname === "/admin/members" && ["GET", "POST"].includes(request.method)) result = await members(request, env);
    else if (url.pathname === "/admin/pairing-codes" && ["GET", "POST"].includes(request.method)) result = await pairingCodes(request, env);
    else if (url.pathname === "/admin/kiosks" && request.method === "GET") result = await kioskStatus(request, env);
    else if (/^\/admin\/kiosks\/[^/]+$/.test(url.pathname) && ["PATCH", "DELETE"].includes(request.method)) result = await manageKiosk(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/admin/simulator" && ["GET", "POST"].includes(request.method)) result = await simulatedKiosk(request, env);
    else if (url.pathname === "/meetings" && ["GET", "POST"].includes(request.method)) result = await meetings(request, env);
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeeting(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (/^\/meeting-series\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeetingSeries(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (url.pathname === "/attendance" && ["GET", "POST"].includes(request.method)) result = await attendance(request, env);
    else if (url.pathname === "/attendance/corrections" && request.method === "POST") result = await correction(request, env);
    else if (url.pathname === "/exports/attendance.csv" && request.method === "GET") result = await attendanceExport(request, env);
    else if (url.pathname === "/admin/integrations" && request.method === "GET") result = await integrationsStatus(request, env);
    else if (/^\/admin\/integrations\/(google|resend|discord)$/.test(url.pathname) && ["PUT", "DELETE"].includes(request.method)) result = await integrationConfiguration(request, env, providerFrom(url.pathname));
    else if (url.pathname === "/admin/integrations/resend/verify/start" && request.method === "POST") result = await startResendVerification(request, env);
    else if (url.pathname === "/admin/integrations/resend/verify/complete" && request.method === "POST") result = await completeResendVerification(request, env);
    else if (url.pathname === "/admin/integrations/discord/verify/start" && request.method === "POST") result = await startDiscordVerification(request, env);
    else if (url.pathname === "/admin/users" && ["GET", "POST"].includes(request.method)) result = await users(request, env);
    else if (/^\/admin\/users\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateUser(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/communications/email" && request.method === "POST") result = await sendAttendanceEmail(request, env);
    else if (url.pathname === "/discord/interactions" && request.method === "POST") result = await discordInteraction(request, env);
    else if (url.pathname === "/discord/link" && request.method === "POST") result = await linkDiscordMember(request, env);
    else if (url.pathname === "/discord/missing" && request.method === "POST") result = await discordMissing(request, env);
    else if (url.pathname === "/discord/contests" && request.method === "GET") result = await discordContests(request, env);
    else if (url.pathname === "/discord/contests/resolve" && request.method === "POST") result = await resolveDiscordContest(request, env);
    else if (url.pathname === "/discord/calendar" && request.method === "POST") result = await discordCalendar(request, env);
    else if (url.pathname === "/discord/kiosk-status" && request.method === "POST") result = await discordKioskStatus(request, env);
    else if (url.pathname === "/admin/privacy" && ["GET", "PATCH"].includes(request.method)) result = await privacySettings(request, env);
    else if (url.pathname === "/admin/data/backup" && request.method === "GET") result = await backupData(request, env);
    else if (url.pathname === "/admin/data/restore" && request.method === "POST") result = await restoreData(request, env);
    else if (url.pathname === "/admin/setup/reset" && request.method === "POST") result = await resetOnboarding(request, env);
    else if (url.pathname === "/admin/data" && request.method === "DELETE") result = await deleteData(request, env);
    else if (url.pathname === "/kiosk/pair" && request.method === "POST") result = await redeemPairingCode(request, env);
    else if (url.pathname === "/kiosk/heartbeat" && request.method === "POST") result = await kioskHeartbeat(request, env, context);
    else if (url.pathname === "/kiosk/config" && request.method === "GET") result = await kioskConfiguration(request, env);
    else if (url.pathname === "/kiosk/attendance" && request.method === "POST") result = await kioskAttendance(request, env);
    else result = response({ error: "Not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500 || status === 502) await recordTelemetryDiagnostic(env, status === 502 ? "integration-upstream" : "worker-internal");
    const detail = error instanceof HttpError ? error.details : env.APP_MODE === "unconfigured" && error instanceof Error ? [error.message] : undefined;
    result = response({ error: error instanceof HttpError ? error.message : "Request failed", details: detail }, status);
  }
  return withCors(result, request, env);
}, async scheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === "0 3 * * *") { try { await transmitTelemetry(env); } catch { /* Telemetry is best-effort and cannot affect attendance. */ } }
  if (controller.cron === "*/5 * * * *") { try { await processDiscordAttendanceNotifications(env); } catch { /* Discord attendance delivery retries safely on the next scheduled pass. */ } }
  try { await syncDiscordKioskStatus(env); } catch { /* Discord status is best-effort and cannot affect kiosk operation. */ }
} };
export default worker;

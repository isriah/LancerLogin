import { createSessionCodec, hashPassword, verifyPassword } from "./runtime-security.ts";
import { decryptIntegration, encryptIntegration } from "./integration-crypto.ts";

type D1Result<T = unknown> = { results?: T[]; success?: boolean; meta?: { changes?: number } };
interface D1Statement { bind(...values: unknown[]): D1Statement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
interface D1Database { prepare(query: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]>; }
export interface Env { APP_MODE: "unconfigured" | "configured"; ALLOWED_ORIGIN: string; SESSION_KEY?: string; INTEGRATION_KEY?: string; TELEMETRY_ENDPOINT?: string; RELEASE_VERSION?: string; DB?: D1Database; }

type Role = "admin" | "operator";
type Principal = { userId: string; role: Role; expiresAt: number };
type AuthMode = "google" | "local" | "both";
type SetupStep = "branding" | "roster" | "pair-kiosk" | "fingerprint-test" | "test-meeting" | "confirm-attendance";
type BootstrapInput = { organizationName?: string; timeZone?: string; authMode?: AuthMode; adminEmail?: string; localUsername?: string; localPassword?: string; googleClientId?: string; googleClientSecret?: string; telemetryAccepted?: boolean };
type BrandingInput = { organizationName?: string; subtitle?: string | null; logoData?: string | null; primaryColor?: string; secondaryColor?: string; appearance?: "system" | "light" | "dark" };
type MemberInput = { memberId?: string; firstName?: string; lastName?: string; email?: string | null; discordUserId?: string | null };

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const setupSteps = new Set<SetupStep>(["branding", "roster", "pair-kiosk", "fingerprint-test", "test-meeting", "confirm-attendance"]);
const validTimeZone = (value: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } };
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
const validLogoData = (value: string) => value.length <= 180_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);

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
async function parseJson<T>(request: Request): Promise<T> {
  if (Number(request.headers.get("content-length") ?? 0) > 262_144) throw new HttpError(413, "Request body is too large");
  try { return await request.json() as T; } catch { throw new HttpError(400, "Request body must be valid JSON"); }
}
function requireDatabase(env: Env): D1Database { if (!env.DB) throw new HttpError(503, "D1 is not linked"); return env.DB; }
function cookie(request: Request, name: string): string | undefined { return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
async function principalFor(request: Request, env: Env): Promise<Principal> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const token = cookie(request, "lancerlogin_session");
  const principal = token ? await createSessionCodec(env.SESSION_KEY).verify(token) : undefined;
  if (!principal) throw new HttpError(401, "Sign in required");
  return principal;
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
function randomToken(bytes = 32): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function writeAudit(db: D1Database, principal: Principal, action: string, targetType: string, targetId: string | null, metadata: unknown = {}): Promise<void> {
  await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), principal.userId, action, targetType, targetId, JSON.stringify(metadata), new Date().toISOString()).run();
}

async function setupStatus(env: Env): Promise<Response> {
  const db = requireDatabase(env);
  const installation = await db.prepare("SELECT id, auth_mode AS authMode, telemetry_accepted_at AS telemetryAcceptedAt FROM installations WHERE id = ?").bind("primary").first<{ id: string; authMode: AuthMode; telemetryAcceptedAt?: string }>();
  if (!installation) return response({ configured: false });
  const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone FROM organization_settings WHERE installation_id = ?").bind(installation.id).first();
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
      db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, 'primary', ?, 'integration.configured', 'integration', 'google', ?)").bind(crypto.randomUUID(), adminId, now),
    );
  }
  await db.batch(statements);
  if (telemetryAcceptedAt) { const cf = (request as Request & { cf?: { city?: string; metroCode?: string } }).cf; try { await transmitTelemetry(env, cf?.city || cf?.metroCode); } catch { /* Setup must survive best-effort telemetry failure. */ } }
  return response({ configured: true, admin: { id: adminId, email: input.adminEmail?.toLowerCase(), localUsername: input.localUsername?.trim().toLowerCase(), role: "admin" }, telemetryAccepted: Boolean(telemetryAcceptedAt) }, 201);
}
async function localLogin(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); if (!env.SESSION_KEY) throw new HttpError(503, "Local authentication is not configured");
  const input = await parseJson<{ username?: string; password?: string }>(request);
  if (!input.username || !input.password) throw new HttpError(400, "Username and password are required");
  const user = await db.prepare("SELECT id, role, password_hash AS passwordHash FROM users WHERE installation_id = ? AND local_username = ? AND active = 1").bind("primary", input.username.trim().toLowerCase()).first<{ id: string; role: Role; passwordHash: string | null }>();
  if (!user?.passwordHash || !await verifyPassword(input.password, user.passwordHash)) throw new HttpError(401, "Invalid username or password");
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
    const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_data AS logoData, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first();
    return response({ settings });
  }
  const input = await parseJson<BrandingInput>(request); const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (input.subtitle && input.subtitle.length > 140) errors.push("Subtitle must be at most 140 characters");
  if (input.logoData && !validLogoData(input.logoData)) errors.push("Logo must be a PNG, JPEG, or WebP image no larger than 128 KiB");
  if (!input.primaryColor || !validColor(input.primaryColor) || !input.secondaryColor || !validColor(input.secondaryColor)) errors.push("Brand colors must use six-digit hex values");
  if (!input.appearance || !["system", "light", "dark"].includes(input.appearance)) errors.push("Appearance must be system, light, or dark");
  if (errors.length) throw new HttpError(400, "Invalid branding", errors);
  await db.prepare("UPDATE organization_settings SET organization_name = ?, subtitle = ?, logo_data = ?, primary_color = ?, secondary_color = ?, appearance = ? WHERE installation_id = 'primary'")
    .bind(input.organizationName!.trim(), input.subtitle?.trim() || null, input.logoData || null, input.primaryColor!.toLowerCase(), input.secondaryColor!.toLowerCase(), input.appearance).run();
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
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, email, discord_user_id AS discordUserId, active FROM members WHERE installation_id = 'primary' ORDER BY last_name, first_name").all(); return response({ members: result.results ?? [] }); }
  const input = await parseJson<{ members?: MemberInput[] }>(request);
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > 500) throw new HttpError(400, "Provide between 1 and 500 roster members");
  const seen = new Set<string>(); const errors: string[] = [];
  input.members.forEach((member, index) => { const prefix = `Member ${index + 1}`; if (!member.memberId?.trim() || !member.firstName?.trim() || !member.lastName?.trim()) errors.push(`${prefix} requires memberId, firstName, and lastName`); if (member.memberId && seen.has(member.memberId.trim())) errors.push(`${prefix} duplicates memberId ${member.memberId.trim()}`); if (member.memberId) seen.add(member.memberId.trim()); if (member.email && !validEmail(member.email)) errors.push(`${prefix} has an invalid email`); if (member.discordUserId && !/^\d{10,24}$/.test(member.discordUserId)) errors.push(`${prefix} has an invalid Discord user ID`); });
  if (errors.length) throw new HttpError(400, "Invalid roster", errors);
  const now = new Date().toISOString();
  const statements = input.members.map((member) => db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, discord_user_id = excluded.discord_user_id, active = 1").bind(crypto.randomUUID(), member.memberId!.trim(), member.firstName!.trim(), member.lastName!.trim(), member.email?.trim().toLowerCase() || null, member.discordUserId?.trim() || null, now));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'roster.imported', 'member', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ count: input.members.length }), now));
  await db.batch(statements); return response({ imported: input.members.length }, 201);
}
async function pairingCodes(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const active = await db.prepare("SELECT id, expires_at AS expiresAt FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(new Date().toISOString()).first(); return response({ active }); }
  const input = await parseJson<{ kioskName?: string; replaceExisting?: boolean }>(request); const kioskName = input.kioskName?.trim();
  if (!kioskName || kioskName.length > 80) throw new HttpError(400, "Kiosk name is required and must be at most 80 characters");
  const activeKiosk = await db.prepare("SELECT id, name FROM kiosks WHERE installation_id = 'primary' AND active = 1 LIMIT 1").first<{ id: string; name: string }>();
  if (activeKiosk && input.replaceExisting !== true) throw new HttpError(409, `This single-kiosk installation is already paired to ${activeKiosk.name}. Confirm replacement to continue.`);
  const code = randomToken(9).slice(0, 12).toUpperCase(); const id = crypto.randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL"),
    db.prepare("INSERT INTO pairing_codes (id, installation_id, code_hash, expires_at, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?)").bind(id, await sha256(code), expiresAt, principal.userId, now.toISOString()),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'pairing_code.created', 'pairing_code', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ kioskName, replacesKioskId: activeKiosk?.id ?? null }), now.toISOString()),
  ]);
  return response({ code, expiresAt, kioskName }, 201);
}
async function redeemPairingCode(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); const input = await parseJson<{ code?: string; kioskName?: string }>(request); const code = input.code?.trim().toUpperCase(); const kioskName = input.kioskName?.trim();
  if (!code || !kioskName || kioskName.length > 80) throw new HttpError(400, "Pairing code and kiosk name are required");
  const now = new Date().toISOString(); const pairing = await db.prepare("SELECT id FROM pairing_codes WHERE installation_id = 'primary' AND code_hash = ? AND redeemed_at IS NULL AND expires_at > ?").bind(await sha256(code), now).first<{ id: string }>();
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
async function kioskHeartbeat(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env); const input = await parseJson<{ readerOnline?: boolean; releaseVersion?: string }>(request);
  if (typeof input.readerOnline !== "boolean" || !input.releaseVersion || input.releaseVersion.length > 40) throw new HttpError(400, "Reader status and release version are required");
  const now = new Date().toISOString();
  await requireDatabase(env).prepare("UPDATE kiosks SET last_seen_at = ? WHERE id = ?").bind(now, kiosk.id).run();
  return response({ ok: true, kioskId: kiosk.id, receivedAt: now });
}
async function kioskStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]);
  const result = await requireDatabase(env).prepare("SELECT id, name, active, last_seen_at AS lastSeenAt, created_at AS pairedAt FROM kiosks WHERE installation_id = 'primary' ORDER BY created_at DESC").all();
  return response({ kiosks: result.results ?? [] });
}
function validTimestamp(value: string | undefined): value is string { return Boolean(value && Number.isFinite(Date.parse(value))); }
async function meetings(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, notes FROM meetings WHERE installation_id = 'primary' ORDER BY starts_at DESC LIMIT 250").all(); return response({ meetings: result.results ?? [] }); }
  const input = await parseJson<{ title?: string; startsAt?: string; endsAt?: string | null; required?: boolean; notes?: string | null }>(request);
  if (!input.title?.trim() || input.title.length > 120 || (input.notes?.length ?? 0) > 2_000 || !validTimestamp(input.startsAt) || (input.endsAt && !validTimestamp(input.endsAt)) || (input.endsAt && Date.parse(input.endsAt) <= Date.parse(input.startsAt!))) throw new HttpError(400, "Meeting needs a title, valid start, optional notes under 2,000 characters, and an optional end after its start");
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO meetings (id, installation_id, title, starts_at, ends_at, required, notes, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)").bind(id, input.title.trim(), input.startsAt, input.endsAt || null, input.required === false ? 0 : 1, input.notes?.trim() || null, principal.userId, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, 'primary', ?, 'meeting.created', 'meeting', ?, ?)").bind(crypto.randomUUID(), principal.userId, id, now),
  ]);
  return response({ meeting: { id, title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt || null, required: input.required !== false } }, 201);
}
async function updateMeeting(request: Request, env: Env, meetingId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<{ title?: string; startsAt?: string; endsAt?: string | null; required?: boolean; notes?: string | null }>(request);
  if (!input.title?.trim() || input.title.length > 120 || !validTimestamp(input.startsAt) || (input.endsAt && !validTimestamp(input.endsAt)) || (input.endsAt && Date.parse(input.endsAt) <= Date.parse(input.startsAt!))) throw new HttpError(400, "Meeting needs a title, valid start, and an optional end after its start");
  const updated = await db.prepare("UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, required = ?, notes = ? WHERE installation_id = 'primary' AND id = ?").bind(input.title.trim(), input.startsAt, input.endsAt || null, input.required === false ? 0 : 1, input.notes?.trim() || null, meetingId).run();
  if ((updated.meta?.changes ?? 1) < 1) throw new HttpError(404, "Meeting not found");
  await writeAudit(db, principal, "meeting.updated", "meeting", meetingId);
  return response({ meeting: { id: meetingId, title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt || null, required: input.required !== false, notes: input.notes?.trim() || null } });
}
async function recordAttendance(db: D1Database, input: { eventId?: string; memberId?: string; meetingId?: string; occurredAt?: string }, source: "kiosk" | "manual", actorId?: string): Promise<Response> {
  if (!input.eventId?.trim() || input.eventId.length > 100 || !input.memberId || !input.meetingId || !validTimestamp(input.occurredAt)) throw new HttpError(400, "eventId, memberId, meetingId, and a valid occurredAt timestamp are required");
  const [member, meeting] = await Promise.all([
    db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(input.memberId).first(),
    db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first(),
  ]);
  if (!member || !meeting) throw new HttpError(404, "Member or meeting was not found in this installation");
  const id = crypto.randomUUID();
  const result = await db.prepare("INSERT OR IGNORE INTO attendance_events (id, installation_id, member_id, meeting_id, source, occurred_at, kiosk_event_id, created_by) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)").bind(id, input.memberId, input.meetingId, source, input.occurredAt, input.eventId.trim(), actorId ?? null).run();
  return response({ accepted: (result.meta?.changes ?? 1) > 0, duplicate: (result.meta?.changes ?? 1) === 0, eventId: input.eventId }, 202);
}
async function kioskAttendance(request: Request, env: Env): Promise<Response> { await kioskFor(request, env); return recordAttendance(requireDatabase(env), await parseJson(request), "kiosk"); }
async function attendance(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const url = new URL(request.url);
  if (request.method === "GET") {
    const meetingId = url.searchParams.get("meetingId"); if (!meetingId) throw new HttpError(400, "meetingId is required");
    const rows = await db.prepare("SELECT m.id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id AS discordUserId, COALESCE((SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1), CASE WHEN EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ?) THEN 'present' ELSE 'absent' END) AS disposition, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ?) AS occurredAt, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason FROM members m WHERE m.installation_id = 'primary' AND m.active = 1 ORDER BY m.last_name, m.first_name").bind(meetingId, meetingId, meetingId, meetingId).all();
    return response({ attendance: rows.results ?? [] });
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
function csvCell(value: unknown): string { const text = value == null ? "" : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
async function attendanceExport(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const result = await db.prepare("SELECT mt.title AS meeting, mt.starts_at AS meetingStart, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, COALESCE((SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = mt.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1), CASE WHEN EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = mt.id) THEN 'present' ELSE 'absent' END) AS disposition, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = mt.id) AS occurredAt, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = mt.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason FROM meetings mt CROSS JOIN members m WHERE mt.installation_id = 'primary' AND m.installation_id = 'primary' AND m.active = 1 ORDER BY mt.starts_at, m.last_name, m.first_name").all<Record<string, unknown>>();
  const headers = ["meeting", "meetingStart", "memberId", "firstName", "lastName", "disposition", "occurredAt", "reason"];
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
  const fields = provider === "google" ? ["clientId", "clientSecret"] : provider === "resend" ? ["apiKey", "fromEmail"] : ["botToken", "guildId", "channelId"];
  const output: Record<string, string> = {};
  for (const field of fields) { const value = input[field]; if (typeof value !== "string" || !value.trim() || value.length > 500) throw new HttpError(400, `${field} is required`); output[field] = value.trim(); }
  if (provider === "resend" && !validEmail(output.fromEmail)) throw new HttpError(400, "fromEmail must be a valid email address");
  return output;
}
async function integrationRecord(env: Env, provider: IntegrationProvider): Promise<{ id: string; ciphertext: string; iv: string; updatedAt: string } | null> {
  return requireDatabase(env).prepare("SELECT id, ciphertext, iv, updated_at AS updatedAt FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = ?").bind(provider).first();
}
async function integrationsStatus(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin"]);
  const result = await requireDatabase(env).prepare("SELECT provider, updated_at AS updatedAt FROM encrypted_integrations WHERE installation_id = 'primary' ORDER BY provider").all<{ provider: IntegrationProvider; updatedAt: string }>();
  const configured = new Map((result.results ?? []).map((item) => [item.provider, item.updatedAt]));
  return response({ integrations: [...integrationProviders].map((provider) => ({ provider, configured: configured.has(provider), updatedAt: configured.get(provider) })) });
}
async function integrationConfiguration(request: Request, env: Env, provider: IntegrationProvider): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "DELETE") {
    await db.prepare("DELETE FROM encrypted_integrations WHERE installation_id = 'primary' AND provider = ?").bind(provider).run();
    await writeAudit(db, principal, "integration.removed", "integration", provider); return response({ configured: false, provider });
  }
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const secret = validateIntegration(provider, await parseJson<Record<string, unknown>>(request)); const encrypted = await encryptIntegration(secret, env.INTEGRATION_KEY); const now = new Date().toISOString();
  await db.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, updated_at) VALUES (?, 'primary', ?, ?, ?, ?) ON CONFLICT(installation_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = key_version + 1, updated_at = excluded.updated_at")
    .bind(crypto.randomUUID(), provider, encrypted.ciphertext, encrypted.iv, now).run();
  await writeAudit(db, principal, "integration.rotated", "integration", provider); return response({ configured: true, provider, updatedAt: now });
}
async function testIntegration(request: Request, env: Env, provider: IntegrationProvider): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, provider); if (!record) throw new HttpError(404, "Integration is not configured");
  const secret = await decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY); let result: globalThis.Response;
  if (provider === "google") result = await fetch("https://accounts.google.com/.well-known/openid-configuration", { headers: { accept: "application/json" } });
  else if (provider === "resend") result = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${secret.apiKey}`, accept: "application/json" } });
  else result = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bot ${secret.botToken}`, accept: "application/json" } });
  const ok = result.ok; await writeAudit(requireDatabase(env), principal, "integration.tested", "integration", provider, { ok, status: result.status });
  if (!ok) throw new HttpError(502, `${provider} rejected the saved configuration`);
  return response({ provider, ok: true, testedAt: new Date().toISOString() });
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
async function googleStart(_request: Request, env: Env): Promise<Response> {
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const installation = await requireDatabase(env).prepare("SELECT auth_mode AS authMode FROM installations WHERE id = 'primary'").first<{ authMode: AuthMode }>();
  if (!installation || !["google", "both"].includes(installation.authMode)) throw new HttpError(404, "Google sign-in is not enabled");
  const credentials = await googleCredentials(env); const redirectUri = googleRedirectUri(env);
  const state = await createSessionCodec(env.SESSION_KEY).issue({ userId: crypto.randomUUID(), role: "operator" }, 10 * 60_000);
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" }).toString();
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store", "set-cookie": `lancerlogin_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` } });
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
  const session = await createSessionCodec(env.SESSION_KEY).issue({ userId: user.id, role: user.role });
  const headers = new Headers({ location: env.ALLOWED_ORIGIN, "cache-control": "no-store" });
  headers.append("set-cookie", `lancerlogin_session=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
  headers.append("set-cookie", "lancerlogin_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers });
}
async function users(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const result = await db.prepare("SELECT id, email, local_username AS localUsername, role, active, created_at AS createdAt FROM users WHERE installation_id = 'primary' ORDER BY created_at").all(); return response({ users: result.results ?? [] }); }
  const input = await parseJson<{ email?: string | null; localUsername?: string | null; localPassword?: string; role?: Role }>(request);
  const email = input.email?.trim().toLowerCase() || null; const username = input.localUsername?.trim().toLowerCase() || null;
  if (!email && !username) throw new HttpError(400, "An email or local username is required");
  if (email && !validEmail(email)) throw new HttpError(400, "Email is invalid");
  if (username && !/^[a-z0-9._-]{3,64}$/.test(username)) throw new HttpError(400, "Local username must be 3–64 letters, numbers, dots, underscores, or hyphens");
  if (!input.role || !["admin", "operator"].includes(input.role)) throw new HttpError(400, "Role must be admin or operator");
  if (username && (input.localPassword?.length ?? 0) < 12) throw new HttpError(400, "A local user needs a password of at least 12 characters");
  const duplicate = await db.prepare("SELECT id FROM users WHERE installation_id = 'primary' AND ((email IS NOT NULL AND email = ?) OR (local_username IS NOT NULL AND local_username = ?))").bind(email, username).first();
  if (duplicate) throw new HttpError(409, "That email or username is already in use");
  const id = crypto.randomUUID(); const now = new Date().toISOString(); const passwordHash = username ? await hashPassword(input.localPassword!) : null;
  await db.batch([
    db.prepare("INSERT INTO users (id, installation_id, email, local_username, password_hash, role, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?)").bind(id, email, username, passwordHash, input.role, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'user.created', 'user', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ role: input.role, hasGoogle: Boolean(email), hasLocal: Boolean(username) }), now),
  ]);
  return response({ user: { id, email, localUsername: username, role: input.role, active: true, createdAt: now } }, 201);
}
async function updateUser(request: Request, env: Env, userId: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ role?: Role; active?: boolean; localPassword?: string }>(request);
  const target = await db.prepare("SELECT id, role, active, local_username AS localUsername FROM users WHERE installation_id = 'primary' AND id = ?").bind(userId).first<{ id: string; role: Role; active: number; localUsername?: string }>();
  if (!target) throw new HttpError(404, "User not found");
  if (userId === principal.userId && ((input.role && input.role !== "admin") || input.active === false)) throw new HttpError(409, "You cannot demote or deactivate your current Admin account");
  if (input.role && !["admin", "operator"].includes(input.role)) throw new HttpError(400, "Role must be admin or operator");
  if (input.localPassword && (!target.localUsername || input.localPassword.length < 12)) throw new HttpError(400, "Password reset requires a local username and at least 12 characters");
  if (input.role === undefined && input.active === undefined && input.localPassword === undefined) throw new HttpError(400, "Provide a role, active status, or new local password");
  const passwordHash = input.localPassword ? await hashPassword(input.localPassword) : null; const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE users SET role = COALESCE(?, role), active = COALESCE(?, active), password_hash = COALESCE(?, password_hash) WHERE installation_id = 'primary' AND id = ?").bind(input.role ?? null, input.active === undefined ? null : input.active ? 1 : 0, passwordHash, userId),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'user.updated', 'user', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, userId, JSON.stringify({ role: input.role, active: input.active, passwordReset: Boolean(input.localPassword) }), now),
  ]);
  return response({ ok: true });
}
function html(value: unknown): string { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
async function resendConfiguration(env: Env): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "resend"); if (!record) throw new HttpError(503, "Resend is not configured");
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
    const records = await db.prepare("SELECT mt.title, mt.starts_at AS startsAt, COALESCE((SELECT c.disposition FROM attendance_corrections c WHERE c.meeting_id = mt.id AND c.member_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1), CASE WHEN EXISTS (SELECT 1 FROM attendance_events e WHERE e.meeting_id = mt.id AND e.member_id = ?) THEN 'present' ELSE 'absent' END) AS disposition FROM meetings mt WHERE mt.installation_id = 'primary' ORDER BY mt.starts_at DESC LIMIT 100").bind(member.id, member.id).all<{ title: string; startsAt: string; disposition: string }>();
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
async function discordConfiguration(env: Env): Promise<Record<string, string>> {
  if (!env.INTEGRATION_KEY) throw new HttpError(503, "Integration encryption is not configured");
  const record = await integrationRecord(env, "discord"); if (!record) throw new HttpError(503, "Discord is not configured");
  return decryptIntegration(record.ciphertext, record.iv, env.INTEGRATION_KEY);
}
async function discordRequest(config: Record<string, string>, path: string, init: RequestInit): Promise<{ response: globalThis.Response; body: Record<string, unknown> }> {
  const result = await fetch(`https://discord.com/api/v10${path}`, { ...init, headers: { authorization: `Bot ${config.botToken}`, "content-type": "application/json", ...init.headers } });
  const body = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (!result.ok) throw new HttpError(502, `Discord rejected the request (${result.status})`);
  return { response: result, body };
}
async function linkDiscordMember(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ memberId?: string; discordUserId?: string | null }>(request);
  if (!input.memberId || (input.discordUserId !== null && !/^\d{10,24}$/.test(input.discordUserId ?? ""))) throw new HttpError(400, "Member and a valid Discord user ID are required");
  await db.prepare("UPDATE members SET discord_user_id = ? WHERE installation_id = 'primary' AND id = ?").bind(input.discordUserId, input.memberId).run();
  await writeAudit(db, principal, input.discordUserId ? "discord.member_linked" : "discord.member_unlinked", "member", input.memberId);
  return response({ linked: Boolean(input.discordUserId), memberId: input.memberId });
}
async function discordMissing(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string }>(request);
  if (!input.meetingId) throw new HttpError(400, "Meeting is required"); const config = await discordConfiguration(env);
  const meeting = await db.prepare("SELECT id, title FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first<{ id: string; title: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found");
  const missing = await db.prepare("SELECT m.id, m.discord_user_id AS discordUserId FROM members m WHERE m.installation_id = 'primary' AND m.active = 1 AND m.discord_user_id IS NOT NULL AND COALESCE((SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1), CASE WHEN EXISTS (SELECT 1 FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ?) THEN 'present' ELSE 'absent' END) = 'absent'").bind(meeting.id, meeting.id).all<{ id: string; discordUserId: string }>();
  const members = missing.results ?? []; const mentions = members.map((member) => `<@${member.discordUserId}>`).join(" ");
  const { body } = await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages`, { method: "POST", body: JSON.stringify({ content: members.length ? `Missing from **${meeting.title}**: ${mentions}\nReply to your organization if this attendance should be reviewed.` : `Everyone with a linked Discord account is accounted for at **${meeting.title}**.`, allowed_mentions: { users: members.map((member) => member.discordUserId) } }) });
  const messageId = String(body.id ?? ""); const now = new Date().toISOString();
  if (members.length) await db.batch(members.map((member) => db.prepare("INSERT INTO discord_attendance_contests (installation_id, meeting_id, member_id, message_id, status, created_at) VALUES ('primary', ?, ?, ?, 'open', ?) ON CONFLICT(installation_id, meeting_id, member_id) DO UPDATE SET message_id = excluded.message_id, status = 'open', resolved_by = NULL, resolved_at = NULL, created_at = excluded.created_at").bind(meeting.id, member.id, messageId, now)));
  await writeAudit(db, principal, "discord.missing_notified", "meeting", meeting.id, { linkedMissingCount: members.length, messageId });
  return response({ posted: true, linkedMissingCount: members.length, messageId }, 202);
}
async function discordContests(request: Request, env: Env): Promise<Response> {
  await requireRole(request, env, ["admin", "operator"]); const meetingId = new URL(request.url).searchParams.get("meetingId");
  if (!meetingId) throw new HttpError(400, "Meeting is required");
  const result = await requireDatabase(env).prepare("SELECT c.meeting_id AS meetingId, c.member_id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, c.status, c.created_at AS createdAt, c.resolved_at AS resolvedAt FROM discord_attendance_contests c JOIN members m ON m.id = c.member_id AND m.installation_id = c.installation_id WHERE c.installation_id = 'primary' AND c.meeting_id = ? ORDER BY m.last_name, m.first_name").bind(meetingId).all();
  return response({ contests: result.results ?? [] });
}
async function resolveDiscordContest(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string; memberId?: string; resolution?: "approved" | "rejected" | "reviewed" }>(request);
  if (!input.meetingId || !input.memberId || !input.resolution || !["approved", "rejected", "reviewed"].includes(input.resolution)) throw new HttpError(400, "Meeting, member, and a valid resolution are required");
  const result = await db.prepare("UPDATE discord_attendance_contests SET status = ?, resolved_by = ?, resolved_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND member_id = ? AND status = 'open'").bind(input.resolution, principal.userId, new Date().toISOString(), input.meetingId, input.memberId).run();
  if ((result.meta?.changes ?? 1) < 1) throw new HttpError(404, "Open contest not found");
  await writeAudit(db, principal, "discord.contest_resolved", "member", input.memberId, { meetingId: input.meetingId, resolution: input.resolution }); return response({ resolved: true });
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
async function discordKioskStatus(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const config = await discordConfiguration(env);
  const kiosk = await db.prepare("SELECT id, name, last_seen_at AS lastSeenAt FROM kiosks WHERE installation_id = 'primary' AND active = 1 ORDER BY created_at DESC LIMIT 1").first<{ id: string; name: string; lastSeenAt?: string }>();
  const online = Boolean(kiosk?.lastSeenAt && Date.now() - Date.parse(kiosk.lastSeenAt) < 2 * 60_000); const content = kiosk ? `**${kiosk.name}** · ${online ? "online" : "offline"} · last seen ${kiosk.lastSeenAt ?? "never"}` : "No kiosk is paired."; const contentHash = await sha256(content);
  const existing = await db.prepare("SELECT external_id AS externalId, content_hash AS contentHash FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = 'kiosk-status'").first<{ externalId?: string; contentHash?: string }>();
  if (existing?.externalId && existing.contentHash === contentHash) return response({ changed: false, messageId: existing.externalId });
  const path = existing?.externalId ? `/channels/${config.channelId}/messages/${existing.externalId}` : `/channels/${config.channelId}/messages`; const { body } = await discordRequest(config, path, { method: existing?.externalId ? "PATCH" : "POST", body: JSON.stringify({ content }) }); const messageId = String(body.id ?? existing?.externalId ?? ""); const now = new Date().toISOString();
  await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', 'kiosk-status', ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(messageId, contentHash, now).run();
  await writeAudit(db, principal, "discord.kiosk_status_updated", "kiosk", kiosk?.id ?? null, { online, messageId }); return response({ changed: true, messageId, online });
}

async function transmitTelemetry(env: Env, metro?: string): Promise<boolean> {
  if (!env.TELEMETRY_ENDPOINT || !env.RELEASE_VERSION || !env.DB) return false;
  const endpoint = new URL(env.TELEMETRY_ENDPOINT); if (endpoint.protocol !== "https:") return false;
  const installation = await env.DB.prepare("SELECT telemetry_accepted_at AS acceptedAt, telemetry_install_id AS installId FROM installations WHERE id = 'primary'").first<{ acceptedAt?: string; installId?: string }>();
  if (!installation?.acceptedAt || !installation.installId) return false;
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM kiosks WHERE installation_id = 'primary' AND active = 1").first<{ count: number }>();
  const diagnostic = await env.DB.prepare("SELECT error_category AS errorCategory FROM telemetry_diagnostics WHERE installation_id = 'primary'").first<{ errorCategory?: "worker-internal" | "integration-upstream" }>();
  const payload: Record<string, unknown> = { installId: installation.installId, releaseVersion: env.RELEASE_VERSION, activeKioskCount: Number(count?.count ?? 0) };
  if (metro) payload.metro = String(metro).slice(0, 100);
  if (diagnostic?.errorCategory) payload.errorCategory = diagnostic.errorCategory;
  const sent = (await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })).ok;
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
  if (request.method === "GET") { const installation = await db.prepare("SELECT telemetry_accepted_at AS acceptedAt FROM installations WHERE id = 'primary'").first<{ acceptedAt?: string }>(); return response({ telemetryAccepted: Boolean(installation?.acceptedAt), acceptedAt: installation?.acceptedAt, notice: "Telemetry sends only a random installation ID, release version, active kiosk count, scrubbed diagnostics, and best-effort metro. It never sends organization, roster, attendance, fingerprint, or raw IP data." }); }
  const input = await parseJson<{ telemetryAccepted?: boolean }>(request); if (typeof input.telemetryAccepted !== "boolean") throw new HttpError(400, "telemetryAccepted must be true or false"); const now = new Date().toISOString();
  await db.prepare("UPDATE installations SET telemetry_accepted_at = ?, telemetry_install_id = ? WHERE id = 'primary'").bind(input.telemetryAccepted ? now : null, input.telemetryAccepted ? crypto.randomUUID() : null).run();
  await writeAudit(db, principal, input.telemetryAccepted ? "telemetry.accepted" : "telemetry.declined", "installation", "primary");
  if (input.telemetryAccepted) { const cf = (request as Request & { cf?: { city?: string; metroCode?: string } }).cf; try { await transmitTelemetry(env, cf?.city || cf?.metroCode); } catch { /* Consent remains saved if reporting is unavailable. */ } }
  return response({ telemetryAccepted: input.telemetryAccepted, acceptedAt: input.telemetryAccepted ? now : null });
}
async function deleteData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const input = await parseJson<{ scope?: "attendance" | "roster" | "installation"; confirmation?: string }>(request);
  const expected = input.scope === "attendance" ? "DELETE ATTENDANCE" : input.scope === "roster" ? "DELETE ROSTER" : input.scope === "installation" ? "DELETE INSTALLATION" : undefined;
  if (!expected || input.confirmation !== expected) throw new HttpError(400, `Type ${expected ?? "a valid confirmation"} exactly to continue`);
  if (input.scope === "attendance") await db.batch([
    db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meetings WHERE installation_id = 'primary'"),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, created_at) VALUES (?, 'primary', ?, 'data.attendance_deleted', 'installation', ?)").bind(crypto.randomUUID(), principal.userId, new Date().toISOString()),
  ]);
  else if (input.scope === "roster") await db.batch([
    db.prepare("DELETE FROM discord_attendance_contests WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary'"), db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary'"), db.prepare("DELETE FROM meetings WHERE installation_id = 'primary'"), db.prepare("DELETE FROM members WHERE installation_id = 'primary'"),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, created_at) VALUES (?, 'primary', ?, 'data.roster_deleted', 'installation', ?)").bind(crypto.randomUUID(), principal.userId, new Date().toISOString()),
  ]);
  else await db.prepare("DELETE FROM installations WHERE id = 'primary'").run();
  return response({ deleted: true, scope: input.scope });
}

const worker = { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); let result: Response;
  try {
    if (request.method === "OPTIONS") result = new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-allow-credentials": "true" } });
    else if (url.pathname === "/health" && request.method === "GET") result = response({ ok: true, service: "lancerlogin-api", mode: env.DB ? "ready" : "unconfigured" });
    else if (url.pathname === "/setup/status" && request.method === "GET") result = await setupStatus(env);
    else if (url.pathname === "/setup/bootstrap" && request.method === "POST") result = await bootstrap(request, env);
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
    else if (url.pathname === "/meetings" && ["GET", "POST"].includes(request.method)) result = await meetings(request, env);
    else if (/^\/meetings\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateMeeting(request, env, decodeURIComponent(url.pathname.split("/")[2]));
    else if (url.pathname === "/attendance" && ["GET", "POST"].includes(request.method)) result = await attendance(request, env);
    else if (url.pathname === "/attendance/corrections" && request.method === "POST") result = await correction(request, env);
    else if (url.pathname === "/exports/attendance.csv" && request.method === "GET") result = await attendanceExport(request, env);
    else if (url.pathname === "/admin/integrations" && request.method === "GET") result = await integrationsStatus(request, env);
    else if (/^\/admin\/integrations\/(google|resend|discord)$/.test(url.pathname) && ["PUT", "DELETE"].includes(request.method)) result = await integrationConfiguration(request, env, providerFrom(url.pathname));
    else if (/^\/admin\/integrations\/(google|resend|discord)\/test$/.test(url.pathname) && request.method === "POST") result = await testIntegration(request, env, providerFrom(url.pathname));
    else if (url.pathname === "/admin/users" && ["GET", "POST"].includes(request.method)) result = await users(request, env);
    else if (/^\/admin\/users\/[^/]+$/.test(url.pathname) && request.method === "PATCH") result = await updateUser(request, env, decodeURIComponent(url.pathname.split("/")[3]));
    else if (url.pathname === "/communications/email" && request.method === "POST") result = await sendAttendanceEmail(request, env);
    else if (url.pathname === "/discord/link" && request.method === "POST") result = await linkDiscordMember(request, env);
    else if (url.pathname === "/discord/missing" && request.method === "POST") result = await discordMissing(request, env);
    else if (url.pathname === "/discord/contests" && request.method === "GET") result = await discordContests(request, env);
    else if (url.pathname === "/discord/contests/resolve" && request.method === "POST") result = await resolveDiscordContest(request, env);
    else if (url.pathname === "/discord/calendar" && request.method === "POST") result = await discordCalendar(request, env);
    else if (url.pathname === "/discord/kiosk-status" && request.method === "POST") result = await discordKioskStatus(request, env);
    else if (url.pathname === "/admin/privacy" && ["GET", "PATCH"].includes(request.method)) result = await privacySettings(request, env);
    else if (url.pathname === "/admin/data" && request.method === "DELETE") result = await deleteData(request, env);
    else if (url.pathname === "/kiosk/pair" && request.method === "POST") result = await redeemPairingCode(request, env);
    else if (url.pathname === "/kiosk/heartbeat" && request.method === "POST") result = await kioskHeartbeat(request, env);
    else if (url.pathname === "/kiosk/attendance" && request.method === "POST") result = await kioskAttendance(request, env);
    else result = response({ error: "Not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500 || status === 502) await recordTelemetryDiagnostic(env, status === 502 ? "integration-upstream" : "worker-internal");
    const detail = error instanceof HttpError ? error.details : env.APP_MODE === "unconfigured" && error instanceof Error ? [error.message] : undefined;
    result = response({ error: error instanceof HttpError ? error.message : "Request failed", details: detail }, status);
  }
  return withCors(result, request, env);
}, async scheduled(_controller: unknown, env: Env): Promise<void> { try { await transmitTelemetry(env); } catch { /* Telemetry is best-effort and cannot affect attendance. */ } } };
export default worker;

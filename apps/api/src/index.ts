import { createSessionCodec, hashPassword, verifyPassword } from "./runtime-security.ts";

type D1Result<T = unknown> = { results?: T[]; success?: boolean; meta?: { changes?: number } };
interface D1Statement { bind(...values: unknown[]): D1Statement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
interface D1Database { prepare(query: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]>; }
export interface Env { APP_MODE: "unconfigured" | "configured"; ALLOWED_ORIGIN: string; SESSION_KEY?: string; DB?: D1Database; }

type Role = "admin" | "operator";
type Principal = { userId: string; role: Role; expiresAt: number };
type AuthMode = "google" | "local" | "both";
type SetupStep = "branding" | "roster" | "pair-kiosk" | "fingerprint-test" | "test-meeting" | "confirm-attendance";
type BootstrapInput = { organizationName?: string; timeZone?: string; authMode?: AuthMode; adminEmail?: string; localUsername?: string; localPassword?: string; telemetryAccepted?: boolean };
type BrandingInput = { organizationName?: string; subtitle?: string | null; logoUrl?: string | null; primaryColor?: string; secondaryColor?: string; appearance?: "system" | "light" | "dark" };
type MemberInput = { memberId?: string; firstName?: string; lastName?: string; email?: string | null; discordUserId?: string | null };

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const setupSteps = new Set<SetupStep>(["branding", "roster", "pair-kiosk", "fingerprint-test", "test-meeting", "confirm-attendance"]);
const validTimeZone = (value: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } };
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

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
  const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_url AS logoUrl, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone FROM organization_settings WHERE installation_id = ?").bind(installation.id).first();
  return response({ configured: true, installation: { ...installation, telemetryAccepted: Boolean(installation.telemetryAcceptedAt) }, settings });
}
function validateBootstrap(input: BootstrapInput): string[] {
  const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (!input.timeZone || !validTimeZone(input.timeZone)) errors.push("A valid IANA time zone is required");
  if (!input.authMode || !["google", "local", "both"].includes(input.authMode)) errors.push("Authentication mode must be google, local, or both");
  if ((input.authMode === "google" || input.authMode === "both") && (!input.adminEmail || !validEmail(input.adminEmail))) errors.push("A valid first-Admin email is required for Google sign-in");
  if ((input.authMode === "local" || input.authMode === "both") && (!input.localUsername?.trim() || (input.localPassword?.length ?? 0) < 12)) errors.push("Local sign-in requires a username and a password of at least 12 characters");
  return errors;
}
async function bootstrap(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env);
  if (await db.prepare("SELECT id FROM installations WHERE id = ?").bind("primary").first()) throw new HttpError(409, "Installation is already configured");
  const input = await parseJson<BootstrapInput>(request);
  const errors = validateBootstrap(input);
  if (errors.length) throw new HttpError(400, "Invalid setup", errors);
  const now = new Date().toISOString(); const adminId = crypto.randomUUID(); const mode = input.authMode!;
  const passwordHash = mode === "local" || mode === "both" ? await hashPassword(input.localPassword!) : null;
  const telemetryAcceptedAt = input.telemetryAccepted ? now : null;
  await db.batch([
    db.prepare("INSERT INTO installations (id, created_at, auth_mode, telemetry_accepted_at, telemetry_install_id) VALUES (?, ?, ?, ?, ?)").bind("primary", now, mode, telemetryAcceptedAt, input.telemetryAccepted ? crypto.randomUUID() : null),
    db.prepare("INSERT INTO organization_settings (installation_id, organization_name, time_zone) VALUES (?, ?, ?)").bind("primary", input.organizationName!.trim(), input.timeZone),
    db.prepare("INSERT INTO users (id, installation_id, email, local_username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)").bind(adminId, "primary", input.adminEmail?.toLowerCase() ?? null, input.localUsername?.trim().toLowerCase() ?? null, passwordHash, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), "primary", adminId, "installation.created", "installation", "primary", now),
  ]);
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
    const settings = await db.prepare("SELECT organization_name AS organizationName, subtitle, logo_url AS logoUrl, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first();
    return response({ settings });
  }
  const input = await parseJson<BrandingInput>(request); const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (input.subtitle && input.subtitle.length > 140) errors.push("Subtitle must be at most 140 characters");
  if (input.logoUrl && (!input.logoUrl.startsWith("https://") || input.logoUrl.length > 500)) errors.push("Logo URL must be a secure HTTPS URL");
  if (!input.primaryColor || !validColor(input.primaryColor) || !input.secondaryColor || !validColor(input.secondaryColor)) errors.push("Brand colors must use six-digit hex values");
  if (!input.appearance || !["system", "light", "dark"].includes(input.appearance)) errors.push("Appearance must be system, light, or dark");
  if (errors.length) throw new HttpError(400, "Invalid branding", errors);
  await db.prepare("UPDATE organization_settings SET organization_name = ?, subtitle = ?, logo_url = ?, primary_color = ?, secondary_color = ?, appearance = ? WHERE installation_id = 'primary'")
    .bind(input.organizationName!.trim(), input.subtitle?.trim() || null, input.logoUrl?.trim() || null, input.primaryColor!.toLowerCase(), input.secondaryColor!.toLowerCase(), input.appearance).run();
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
  input.members.forEach((member, index) => { const prefix = `Member ${index + 1}`; if (!member.memberId?.trim() || !member.firstName?.trim() || !member.lastName?.trim()) errors.push(`${prefix} requires memberId, firstName, and lastName`); if (member.memberId && seen.has(member.memberId.trim())) errors.push(`${prefix} duplicates memberId ${member.memberId.trim()}`); if (member.memberId) seen.add(member.memberId.trim()); if (member.email && !validEmail(member.email)) errors.push(`${prefix} has an invalid email`); });
  if (errors.length) throw new HttpError(400, "Invalid roster", errors);
  const now = new Date().toISOString();
  const statements = input.members.map((member) => db.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, email, discord_user_id, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, external_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email, discord_user_id = excluded.discord_user_id, active = 1").bind(crypto.randomUUID(), member.memberId!.trim(), member.firstName!.trim(), member.lastName!.trim(), member.email?.trim().toLowerCase() || null, member.discordUserId?.trim() || null, now));
  statements.push(db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, metadata_json, created_at) VALUES (?, 'primary', ?, 'roster.imported', 'member', ?, ?)").bind(crypto.randomUUID(), principal.userId, JSON.stringify({ count: input.members.length }), now));
  await db.batch(statements); return response({ imported: input.members.length }, 201);
}
async function pairingCodes(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  if (request.method === "GET") { const active = await db.prepare("SELECT id, expires_at AS expiresAt FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(new Date().toISOString()).first(); return response({ active }); }
  const input = await parseJson<{ kioskName?: string }>(request); const kioskName = input.kioskName?.trim();
  if (!kioskName || kioskName.length > 80) throw new HttpError(400, "Kiosk name is required and must be at most 80 characters");
  const code = randomToken(9).slice(0, 12).toUpperCase(); const id = crypto.randomUUID(); const now = new Date(); const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM pairing_codes WHERE installation_id = 'primary' AND redeemed_at IS NULL"),
    db.prepare("INSERT INTO pairing_codes (id, installation_id, code_hash, expires_at, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?)").bind(id, await sha256(code), expiresAt, principal.userId, now.toISOString()),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'pairing_code.created', 'pairing_code', ?, ?, ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ kioskName }), now.toISOString()),
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
    db.prepare("INSERT INTO kiosks (id, installation_id, pairing_code_id, name, token_hash, created_at) SELECT ?, 'primary', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE id = ? AND redeemed_at = ?)").bind(kioskId, pairing.id, kioskName, await sha256(kioskToken), now, pairing.id, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, action, target_type, target_id, created_at) VALUES (?, 'primary', 'kiosk.paired', 'kiosk', ?, ?)").bind(crypto.randomUUID(), kioskId, now),
  ]);
  if ((results[1]?.meta?.changes ?? 1) < 1) throw new HttpError(409, "Pairing code was already used");
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
  if (!input.title?.trim() || input.title.length > 120 || !validTimestamp(input.startsAt) || (input.endsAt && !validTimestamp(input.endsAt)) || (input.endsAt && Date.parse(input.endsAt) <= Date.parse(input.startsAt!))) throw new HttpError(400, "Meeting needs a title, valid start, and an optional end after its start");
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO meetings (id, installation_id, title, starts_at, ends_at, required, notes, created_by, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)").bind(id, input.title.trim(), input.startsAt, input.endsAt || null, input.required === false ? 0 : 1, input.notes?.trim() || null, principal.userId, now),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, 'primary', ?, 'meeting.created', 'meeting', ?, ?)").bind(crypto.randomUUID(), principal.userId, id, now),
  ]);
  return response({ meeting: { id, title: input.title.trim(), startsAt: input.startsAt, endsAt: input.endsAt || null, required: input.required !== false } }, 201);
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
    const rows = await db.prepare("SELECT m.id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, COALESCE(c.disposition, CASE WHEN e.id IS NOT NULL THEN 'present' ELSE 'absent' END) AS disposition, e.occurred_at AS occurredAt, c.reason FROM members m LEFT JOIN attendance_events e ON e.member_id = m.id AND e.meeting_id = ? LEFT JOIN attendance_corrections c ON c.member_id = m.id AND c.meeting_id = ? WHERE m.installation_id = 'primary' AND m.active = 1 ORDER BY m.last_name, m.first_name").bind(meetingId, meetingId).all();
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
  const result = await db.prepare("SELECT mt.title AS meeting, mt.starts_at AS meetingStart, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, COALESCE(c.disposition, CASE WHEN e.id IS NOT NULL THEN 'present' ELSE 'absent' END) AS disposition, e.occurred_at AS occurredAt, c.reason FROM meetings mt CROSS JOIN members m LEFT JOIN attendance_events e ON e.member_id = m.id AND e.meeting_id = mt.id LEFT JOIN attendance_corrections c ON c.member_id = m.id AND c.meeting_id = mt.id WHERE mt.installation_id = 'primary' AND m.installation_id = 'primary' AND m.active = 1 ORDER BY mt.starts_at, m.last_name, m.first_name").all<Record<string, unknown>>();
  const headers = ["meeting", "meetingStart", "memberId", "firstName", "lastName", "disposition", "occurredAt", "reason"];
  const csv = [headers.join(","), ...(result.results ?? []).map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n") + "\r\n";
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lancerlogin-attendance-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
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
    else if (url.pathname === "/admin/branding" && ["GET", "PATCH"].includes(request.method)) result = await branding(request, env);
    else if (url.pathname === "/admin/setup/progress" && ["GET", "PATCH"].includes(request.method)) result = await setupProgress(request, env);
    else if (url.pathname === "/admin/members" && ["GET", "POST"].includes(request.method)) result = await members(request, env);
    else if (url.pathname === "/admin/pairing-codes" && ["GET", "POST"].includes(request.method)) result = await pairingCodes(request, env);
    else if (url.pathname === "/admin/kiosks" && request.method === "GET") result = await kioskStatus(request, env);
    else if (url.pathname === "/meetings" && ["GET", "POST"].includes(request.method)) result = await meetings(request, env);
    else if (url.pathname === "/attendance" && ["GET", "POST"].includes(request.method)) result = await attendance(request, env);
    else if (url.pathname === "/attendance/corrections" && request.method === "POST") result = await correction(request, env);
    else if (url.pathname === "/exports/attendance.csv" && request.method === "GET") result = await attendanceExport(request, env);
    else if (url.pathname === "/kiosk/pair" && request.method === "POST") result = await redeemPairingCode(request, env);
    else if (url.pathname === "/kiosk/heartbeat" && request.method === "POST") result = await kioskHeartbeat(request, env);
    else if (url.pathname === "/kiosk/attendance" && request.method === "POST") result = await kioskAttendance(request, env);
    else result = response({ error: "Not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const detail = error instanceof HttpError ? error.details : env.APP_MODE === "unconfigured" && error instanceof Error ? [error.message] : undefined;
    result = response({ error: error instanceof HttpError ? error.message : "Request failed", details: detail }, status);
  }
  return withCors(result, request, env);
} };
export default worker;

import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

/**
 * Member PINs for kiosks that require one (web kiosk phase 3). The server keeps only a salted PBKDF2-SHA256 hash. A PIN
 * is never stored, logged, audited or returned: audit rows name the member and how the PIN changed, nothing more.
 */
// The Workers PBKDF2 limit. Kiosks derive the same 256-bit key from the cached salt and iterations to check offline.
export const PIN_ITERATIONS = 100_000;
const PIN_KEY_BITS = 256;
const PIN_SALT_BYTES = 16;
const PIN_REQUEST_MS = 10 * 60_000;
const PIN_APPROVAL_MS = 5 * 60_000;
const MAX_FAILED_ATTEMPTS = 1_000_000;

export type PinLockout = { enabled: boolean; attempts: number; minutes: number };
export const defaultPinLockout: PinLockout = Object.freeze({ enabled: false, attempts: 5, minutes: 15 });
export type PinKiosk = { id: string; name: string; requirePin: boolean };
export type PinActor = { userId: string };
type Json = (body: unknown, status?: number) => Response;
type ReadJson = <T>(request: Request, maxBytes?: number) => Promise<T>;
type PinRow = { rosterId: string; memberId: string; firstName: string; lastName: string; pinHash?: string | null; pinSalt?: string | null; pinIterations?: number | null; setAt?: string | null; setKioskId?: string | null; failedAttempts?: number | null; lockedUntil?: string | null };
type RequestRow = { id: string; kioskId: string; memberRosterId: string; status: string; createdAt: string; expiresAt: string; decidedAt?: string | null };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

export const validPin = (value: unknown): value is string => typeof value === "string" && /^\d{4,6}$/.test(value);
function requirePinValue(value: unknown): string {
  if (!validPin(value)) throw new HttpError(400, "A PIN is 4 to 6 digits.", undefined, "invalid_pin");
  return value;
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, PIN_KEY_BITS));
}
export async function hashPin(pin: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(PIN_SALT_BYTES));
  return { hash: base64(await derive(pin, salt, PIN_ITERATIONS)), salt: base64(salt), iterations: PIN_ITERATIONS };
}
/** Compares the whole derived key in constant time; a malformed stored hash never matches. */
export async function verifyPin(pin: string, stored: { hash: string; salt: string; iterations: number }): Promise<boolean> {
  if (!Number.isSafeInteger(stored.iterations) || stored.iterations < 1 || stored.iterations > PIN_ITERATIONS) return false;
  let expected: Uint8Array, salt: Uint8Array<ArrayBuffer>;
  try { expected = fromBase64(stored.hash); salt = fromBase64(stored.salt); } catch { return false; }
  const actual = await derive(pin, salt, stored.iterations);
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}

export function normalizePinLockout(row: { enabled?: unknown; attempts?: unknown; minutes?: unknown } | null | undefined): PinLockout {
  const attempts = Number(row?.attempts), minutes = Number(row?.minutes);
  return {
    enabled: Number(row?.enabled) === 1,
    attempts: Number.isInteger(attempts) && attempts >= 3 && attempts <= 20 ? attempts : defaultPinLockout.attempts,
    minutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : defaultPinLockout.minutes,
  };
}
export async function readPinLockout(db: D1Database): Promise<PinLockout> {
  return normalizePinLockout(await db.prepare("SELECT pin_lockout_enabled AS enabled, pin_lockout_attempts AS attempts, pin_lockout_minutes AS minutes FROM organization_settings WHERE installation_id = 'primary'").first());
}

const pinColumns = "m.id AS rosterId, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, p.pin_hash AS pinHash, p.pin_salt AS pinSalt, p.pin_iterations AS pinIterations, p.set_at AS setAt, p.set_kiosk_id AS setKioskId, p.failed_attempts AS failedAttempts, p.locked_until AS lockedUntil";
/** A roster member by roster id or member ID (the roster id wins), with their PIN row if any. */
async function memberPin(db: D1Database, memberId: unknown, activeOnly: boolean): Promise<PinRow> {
  if (!identifier(memberId)) throw new HttpError(400, "Choose a roster member.", undefined, "invalid_member");
  const row = await db.prepare(`SELECT ${pinColumns} FROM members m LEFT JOIN member_pins p ON p.installation_id = m.installation_id AND p.member_id = m.id WHERE m.installation_id = 'primary' AND (m.id = ? OR m.external_id = ?)${activeOnly ? " AND m.active = 1" : ""} ORDER BY m.id = ? DESC LIMIT 1`).bind(memberId, memberId, memberId).first<PinRow>();
  if (!row) throw new HttpError(404, activeOnly ? "This member is not an active roster member." : "Roster member not found.", undefined, "member_not_found");
  return row;
}
const hasPin = (row: PinRow) => typeof row.pinHash === "string" && typeof row.pinSalt === "string";
const activeLock = (row: { lockedUntil?: string | null }, now: string) => typeof row.lockedUntil === "string" && row.lockedUntil > now ? row.lockedUntil : null;

function auditStatement(db: D1Database, action: string, actorUserId: string | null, targetType: string, targetId: string, metadata: Record<string, unknown>, now: string) {
  return db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorUserId, action, targetType, targetId, JSON.stringify(metadata), now);
}

/**
 * Adds wrong tries to a member's count. A lock that has run out starts a fresh count. With lockout on, reaching the
 * limit locks for the configured minutes (an active lock is never extended); with it off, tries are only counted.
 * Audits member_pin.locked when this call started the lock.
 */
async function recordFailedTries(db: D1Database, rosterId: string, count: number, lockout: PinLockout, metadata: Record<string, unknown>, notBefore?: string) {
  const now = new Date(); const nowText = now.toISOString(); const lockUntil = new Date(now.getTime() + lockout.minutes * 60_000).toISOString();
  const nextCount = "MIN(CASE WHEN locked_until IS NOT NULL AND locked_until <= ?1 THEN ?2 ELSE failed_attempts + ?2 END, ?6)";
  const row = await db.prepare(`UPDATE member_pins SET
      locked_until = CASE WHEN locked_until IS NOT NULL AND locked_until > ?1 THEN locked_until WHEN ?3 = 1 AND ${nextCount} >= ?4 THEN ?5 ELSE NULL END,
      failed_attempts = ${nextCount}, updated_at = ?1
    WHERE installation_id = 'primary' AND member_id = ?7 AND (?8 IS NULL OR set_at <= ?8)
    RETURNING failed_attempts AS failedAttempts, locked_until AS lockedUntil`)
    .bind(nowText, count, lockout.enabled ? 1 : 0, lockout.attempts, lockUntil, MAX_FAILED_ATTEMPTS, rosterId, notBefore ?? null).first<{ failedAttempts: number; lockedUntil: string | null }>();
  if (!row) return null;
  if (row.lockedUntil === lockUntil) await auditStatement(db, "member_pin.locked", null, "member", rosterId, { ...metadata, failedAttempts: row.failedAttempts, lockedUntil: lockUntil, minutes: lockout.minutes }, nowText).run();
  return row;
}

/**
 * The PIN step of a scan at a kiosk with Require PIN. Online, the kiosk sends the PIN and the server checks it. A scan
 * queued offline after the kiosk checked its cached hash says pinCheck "offline" and is recorded without one, even when
 * the member has been locked since: the device already accepted it.
 */
export async function checkScanPin(db: D1Database, kiosk: PinKiosk, input: { memberId?: unknown; pin?: unknown; pinCheck?: unknown }): Promise<void> {
  if (!kiosk.requirePin) return;
  if (input.pinCheck !== undefined && input.pinCheck !== "offline") throw new HttpError(400, "pinCheck must be offline", undefined, "invalid_pin_check");
  if (input.pinCheck === "offline") return;
  if (input.pin === undefined || input.pin === null || input.pin === "") throw new HttpError(400, "This kiosk requires a PIN.", undefined, "pin_required");
  const pin = requirePinValue(input.pin);
  let member: PinRow;
  // A scan for someone who is not an active member fails in the attendance step with its usual reason.
  try { member = await memberPin(db, input.memberId, true); } catch (error) { if (error instanceof HttpError && error.status === 404) return; throw error; }
  const now = new Date().toISOString();
  if (!hasPin(member)) throw new HttpError(409, "This member has no PIN yet.", undefined, "pin_not_set");
  const locked = activeLock(member, now);
  if (locked) throw new HttpError(423, "This PIN is locked after too many wrong tries.", undefined, "pin_locked", { lockedUntil: locked });
  if (await verifyPin(pin, { hash: member.pinHash!, salt: member.pinSalt!, iterations: Number(member.pinIterations) })) {
    if (Number(member.failedAttempts ?? 0) !== 0 || member.lockedUntil) await db.prepare("UPDATE member_pins SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE installation_id = 'primary' AND member_id = ?").bind(now, member.rosterId).run();
    return;
  }
  const lockout = await readPinLockout(db);
  const counted = await recordFailedTries(db, member.rosterId, 1, lockout, { kioskId: kiosk.id, via: "kiosk" });
  const lockedUntil = counted ? activeLock(counted, now) : null;
  const extra: Record<string, string | number> = {};
  if (lockout.enabled) extra.attemptsLeft = lockedUntil ? 0 : Math.max(0, lockout.attempts - Number(counted?.failedAttempts ?? 0));
  if (lockedUntil) extra.lockedUntil = lockedUntil;
  throw new HttpError(403, "Wrong PIN.", undefined, "pin_incorrect", extra); // Not 401: kiosks treat a 401 as a revoked credential.
}

/** Roster PIN data, keyed by roster id, for kiosks that require a PIN only. */
export async function rosterPins(db: D1Database): Promise<Map<string, { pin: { hash: string; salt: string; iterations: number }; lockedUntil: string | null }>> {
  const rows = (await db.prepare("SELECT member_id AS rosterId, pin_hash AS hash, pin_salt AS salt, pin_iterations AS iterations, locked_until AS lockedUntil FROM member_pins WHERE installation_id = 'primary'").all<{ rosterId: string; hash: string; salt: string; iterations: number; lockedUntil?: string | null }>()).results ?? [];
  return new Map(rows.map((row) => [row.rosterId, { pin: { hash: row.hash, salt: row.salt, iterations: Number(row.iterations) }, lockedUntil: row.lockedUntil ?? null }]));
}

function requirePinKiosk(kiosk: PinKiosk) {
  if (!kiosk.requirePin) throw new HttpError(409, "This kiosk does not require a PIN.", undefined, "pin_not_required");
}
const requestStatus = (row: RequestRow, now: string) => (row.status === "pending" || row.status === "approved") && row.expiresAt <= now ? "expired" : row.status;
const kioskRequestView = (row: RequestRow, now: string) => ({ id: row.id, status: requestStatus(row, now), expiresAt: row.expiresAt });
const requestColumns = "r.id, r.kiosk_id AS kioskId, r.member_id AS memberRosterId, r.status, r.created_at AS createdAt, r.expires_at AS expiresAt, r.decided_at AS decidedAt";

async function insertPin(db: D1Database, member: PinRow, pin: string, kioskId: string | null) {
  const hashed = await hashPin(pin); const now = new Date().toISOString();
  return { hashed, now, statement: db.prepare("INSERT INTO member_pins (installation_id, member_id, pin_hash, pin_salt, pin_iterations, set_at, set_kiosk_id, failed_attempts, locked_until, updated_at) VALUES ('primary', ?, ?, ?, ?, ?, ?, 0, NULL, ?) ON CONFLICT(installation_id, member_id) DO NOTHING").bind(member.rosterId, hashed.hash, hashed.salt, hashed.iterations, now, kioskId, now) };
}

/** Kiosk routes under /kiosk/pin-requests, /kiosk/pins and /kiosk/pin-failures. Returns undefined for other paths. */
export async function kioskPinRoute(request: Request, path: string, context: { db: D1Database; kiosk: PinKiosk; readJson: ReadJson; respond: Json }): Promise<Response | undefined> {
  const { db, kiosk, readJson, respond } = context; const method = request.method;
  if (path === "/kiosk/pin-failures" && method === "POST") {
    const input = await readJson<{ failures?: unknown }>(request, 65_536);
    if (!object(input) || !Array.isArray(input.failures) || input.failures.length > 200 || input.failures.some((item) => !object(item) || !identifier(item.memberId) || !Number.isInteger(item.count) || Number(item.count) < 1 || Number(item.count) > 1000 || typeof item.lastAt !== "string" || item.lastAt.length > 64 || !Number.isFinite(Date.parse(item.lastAt)))) throw new HttpError(400, "Report up to 200 failures as { memberId, count, lastAt }", undefined, "invalid_pin_failures");
    // Tries reported after Require PIN was turned off are dropped, so the kiosk can clear its queue.
    if (!kiosk.requirePin) return respond({ recorded: 0 });
    const lockout = await readPinLockout(db); let recorded = 0;
    for (const failure of input.failures as { memberId: string; count: number; lastAt: string }[]) {
      let member: PinRow;
      try { member = await memberPin(db, failure.memberId, false); } catch (error) { if (error instanceof HttpError && error.status === 404) continue; throw error; }
      if (!hasPin(member)) continue;
      // Tries made before the member's current PIN was set were against an older PIN, and do not count.
      if (await recordFailedTries(db, member.rosterId, failure.count, lockout, { kioskId: kiosk.id, via: "offline_report" }, new Date(failure.lastAt).toISOString())) recorded += failure.count;
    }
    return respond({ recorded });
  }
  if (path === "/kiosk/pin-requests" && method === "POST") {
    requirePinKiosk(kiosk);
    const input = await readJson<{ memberId?: unknown }>(request, 4096); const member = await memberPin(db, object(input) ? input.memberId : undefined, true);
    if (hasPin(member)) throw new HttpError(409, "This member already has a PIN.", undefined, "pin_already_set");
    const now = new Date(); const nowText = now.toISOString();
    const existing = await db.prepare(`SELECT ${requestColumns} FROM pin_setup_requests r WHERE r.installation_id = 'primary' AND r.kiosk_id = ? AND r.member_id = ? AND r.status = 'pending' AND r.expires_at > ? ORDER BY r.created_at DESC LIMIT 1`).bind(kiosk.id, member.rosterId, nowText).first<RequestRow>();
    if (existing) return respond({ request: kioskRequestView(existing, nowText) }, 201);
    const row: RequestRow = { id: crypto.randomUUID(), kioskId: kiosk.id, memberRosterId: member.rosterId, status: "pending", createdAt: nowText, expiresAt: new Date(now.getTime() + PIN_REQUEST_MS).toISOString() };
    await db.prepare("INSERT INTO pin_setup_requests (id, installation_id, kiosk_id, member_id, status, created_at, expires_at) VALUES (?, 'primary', ?, ?, 'pending', ?, ?)").bind(row.id, kiosk.id, member.rosterId, row.createdAt, row.expiresAt).run();
    return respond({ request: kioskRequestView(row, nowText) }, 201);
  }
  const requestMatch = /^\/kiosk\/pin-requests\/([^/]+)(\/pin)?$/.exec(path);
  if (requestMatch && (method === "GET" && !requestMatch[2] || method === "POST" && requestMatch[2])) {
    const id = decodeURIComponent(requestMatch[1]!); const now = new Date().toISOString();
    const row = await db.prepare(`SELECT ${requestColumns} FROM pin_setup_requests r WHERE r.installation_id = 'primary' AND r.id = ? AND r.kiosk_id = ?`).bind(id, kiosk.id).first<RequestRow>();
    if (!row) throw new HttpError(404, "PIN request not found", undefined, "pin_request_not_found");
    if (!requestMatch[2]) return respond({ request: kioskRequestView(row, now) });
    requirePinKiosk(kiosk);
    const input = await readJson<{ pin?: unknown }>(request, 4096); const pin = requirePinValue(object(input) ? input.pin : undefined);
    if (requestStatus(row, now) !== "approved") throw new HttpError(409, "This PIN request has not been approved, or its approval ran out.", undefined, "pin_request_not_approved");
    const member = await memberPin(db, row.memberRosterId, true);
    if (hasPin(member)) throw new HttpError(409, "This member already has a PIN.", undefined, "pin_already_set");
    const created = await insertPin(db, member, pin, kiosk.id);
    // The PIN is stored only while the approval still holds, and the request is used only by the PIN this call stored.
    const stored = "EXISTS (SELECT 1 FROM member_pins WHERE installation_id = 'primary' AND member_id = ? AND pin_hash = ?)";
    const results = await db.batch([
      db.prepare("INSERT INTO member_pins (installation_id, member_id, pin_hash, pin_salt, pin_iterations, set_at, set_kiosk_id, failed_attempts, locked_until, updated_at) SELECT 'primary', ?, ?, ?, ?, ?, ?, 0, NULL, ? WHERE EXISTS (SELECT 1 FROM pin_setup_requests WHERE installation_id = 'primary' AND id = ? AND kiosk_id = ? AND status = 'approved' AND expires_at > ?) ON CONFLICT(installation_id, member_id) DO NOTHING")
        .bind(member.rosterId, created.hashed.hash, created.hashed.salt, created.hashed.iterations, created.now, kiosk.id, created.now, row.id, kiosk.id, created.now),
      db.prepare(`UPDATE pin_setup_requests SET status = 'used' WHERE installation_id = 'primary' AND id = ? AND status = 'approved' AND ${stored}`).bind(row.id, member.rosterId, created.hashed.hash),
      db.prepare(`INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', NULL, 'member_pin.set', 'member', ?, ?, ? WHERE ${stored}`)
        .bind(crypto.randomUUID(), member.rosterId, JSON.stringify({ via: "pin_request", requestId: row.id, kioskId: kiosk.id, kioskName: kiosk.name }), created.now, member.rosterId, created.hashed.hash),
    ]);
    if ((results[0]?.meta?.changes ?? 0) < 1) throw new HttpError(409, "This PIN request has not been approved, or its approval ran out.", undefined, "pin_request_not_approved");
    return respond({ request: { id: row.id, status: "used", expiresAt: row.expiresAt } }, 201);
  }
  if (path === "/kiosk/pins" && method === "POST") {
    requirePinKiosk(kiosk);
    const input = await readJson<{ memberId?: unknown; pin?: unknown }>(request, 4096); if (!object(input)) throw new HttpError(400, "Choose a roster member and a PIN.");
    const pin = requirePinValue(input.pin); const member = await memberPin(db, input.memberId, true);
    if (hasPin(member)) throw new HttpError(409, "This member already has a PIN. Reset it first.", undefined, "pin_already_set");
    const created = await insertPin(db, member, pin, kiosk.id);
    const results = await db.batch([
      created.statement,
      db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', NULL, 'member_pin.set', 'member', ?, ?, ? WHERE EXISTS (SELECT 1 FROM member_pins WHERE installation_id = 'primary' AND member_id = ? AND pin_hash = ?)")
        .bind(crypto.randomUUID(), member.rosterId, JSON.stringify({ via: "kiosk_maintenance", kioskId: kiosk.id, kioskName: kiosk.name }), created.now, member.rosterId, created.hashed.hash),
    ]);
    if ((results[0]?.meta?.changes ?? 0) < 1) throw new HttpError(409, "This member already has a PIN. Reset it first.", undefined, "pin_already_set");
    return respond({ pin: { set: true, setAt: created.now } }, 201);
  }
  const resetMatch = /^\/kiosk\/pins\/([^/]+)\/reset$/.exec(path);
  if (resetMatch && method === "POST") {
    requirePinKiosk(kiosk);
    const member = await memberPin(db, decodeURIComponent(resetMatch[1]!), false);
    const reset = await removePin(db, member, null, { via: "kiosk_maintenance", kioskId: kiosk.id, kioskName: kiosk.name });
    return respond({ reset });
  }
  return undefined;
}

async function removePin(db: D1Database, member: PinRow, actorUserId: string | null, metadata: Record<string, unknown>): Promise<boolean> {
  if (!hasPin(member)) return false;
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare("DELETE FROM member_pins WHERE installation_id = 'primary' AND member_id = ?").bind(member.rosterId),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'member_pin.reset', 'member', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM member_pins WHERE installation_id = 'primary' AND member_id = ?)")
      .bind(crypto.randomUUID(), actorUserId, member.rosterId, JSON.stringify(metadata), now, member.rosterId),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

async function memberPinView(db: D1Database, member: PinRow) {
  const now = new Date().toISOString();
  if (!hasPin(member)) return { set: false, setAt: null, setKioskName: null, failedAttempts: 0, lockedUntil: null };
  const kiosk = member.setKioskId ? await db.prepare("SELECT name FROM kiosks WHERE installation_id = 'primary' AND id = ?").bind(member.setKioskId).first<{ name: string }>() : null;
  return { set: true, setAt: member.setAt ?? null, setKioskName: kiosk?.name ?? null, failedAttempts: Number(member.failedAttempts ?? 0), lockedUntil: activeLock(member, now) };
}

/** Dashboard member PIN routes: GET and DELETE /admin/members/:id/pin, POST /admin/members/:id/pin/unlock. */
export async function dashboardMemberPin(request: Request, memberId: string, unlock: boolean, context: { db: D1Database; actor: PinActor; respond: Json }): Promise<Response> {
  const { db, actor, respond } = context;
  let member = await memberPin(db, memberId, false);
  if (request.method === "GET" && !unlock) return respond({ pin: await memberPinView(db, member) });
  if (request.method === "DELETE" && !unlock) {
    await removePin(db, member, actor.userId, { via: "dashboard" });
    return respond({ pin: await memberPinView(db, { ...member, pinHash: null, pinSalt: null }) });
  }
  if (!hasPin(member)) throw new HttpError(409, "This member has no PIN.", undefined, "pin_not_set");
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE member_pins SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE installation_id = 'primary' AND member_id = ?").bind(now, member.rosterId),
    auditStatement(db, "member_pin.unlocked", actor.userId, "member", member.rosterId, { previousFailedAttempts: Number(member.failedAttempts ?? 0), wasLocked: Boolean(activeLock(member, now)) }, now),
  ]);
  member = { ...member, failedAttempts: 0, lockedUntil: null };
  return respond({ pin: await memberPinView(db, member) });
}

type DashboardRequestRow = RequestRow & { memberId: string; firstName: string; lastName: string; decidedBy?: string | null };
const dashboardRequestColumns = `${requestColumns}, r.decided_by AS decidedBy, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName`;
const dashboardRequestView = (row: DashboardRequestRow, now: string) => ({ id: row.id, kioskId: row.kioskId, status: requestStatus(row, now), member: { rosterId: row.memberRosterId, memberId: row.memberId, firstName: row.firstName, lastName: row.lastName }, createdAt: row.createdAt, expiresAt: row.expiresAt, decidedAt: row.decidedAt ?? null });

/** GET /admin/kiosks/:id/pin-requests: the kiosk's pending requests that have not run out, oldest first. */
export async function dashboardKioskPinRequests(kioskId: string, context: { db: D1Database; respond: Json }): Promise<Response> {
  const { db, respond } = context; const now = new Date().toISOString();
  const kiosk = await db.prepare("SELECT id FROM kiosks WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(kioskId).first<{ id: string }>();
  if (!kiosk) throw new HttpError(404, "Active kiosk not found");
  const rows = (await db.prepare(`SELECT ${dashboardRequestColumns} FROM pin_setup_requests r JOIN members m ON m.installation_id = r.installation_id AND m.id = r.member_id WHERE r.installation_id = 'primary' AND r.kiosk_id = ? AND r.status = 'pending' AND r.expires_at > ? ORDER BY r.created_at, r.id LIMIT 100`).bind(kioskId, now).all<DashboardRequestRow>()).results ?? [];
  return respond({ requests: rows.map((row) => { const { id, member, createdAt, expiresAt } = dashboardRequestView(row, now); return { id, member, createdAt, expiresAt }; }) });
}

/** POST /admin/pin-requests/:id/approve or /decline. Only a pending request that has not run out can be decided. */
export async function decidePinRequest(requestId: string, decision: "approve" | "decline", context: { db: D1Database; actor: PinActor; respond: Json }): Promise<Response> {
  const { db, actor, respond } = context; const now = new Date(); const nowText = now.toISOString();
  const read = () => db.prepare(`SELECT ${dashboardRequestColumns} FROM pin_setup_requests r JOIN members m ON m.installation_id = r.installation_id AND m.id = r.member_id WHERE r.installation_id = 'primary' AND r.id = ?`).bind(requestId).first<DashboardRequestRow>();
  const row = await read();
  if (!row) throw new HttpError(404, "PIN request not found", undefined, "pin_request_not_found");
  if (requestStatus(row, nowText) !== "pending") throw new HttpError(409, "This PIN request is no longer waiting for a decision.", undefined, "pin_request_not_pending");
  const approve = decision === "approve"; const status = approve ? "approved" : "declined";
  if (approve && await db.prepare("SELECT 1 AS found FROM member_pins WHERE installation_id = 'primary' AND member_id = ?").bind(row.memberRosterId).first()) throw new HttpError(409, "This member already has a PIN.", undefined, "pin_already_set");
  // An approval needs the kiosk still active and requiring a PIN, and is good for 5 minutes from now.
  const expiresAt = approve ? new Date(now.getTime() + PIN_APPROVAL_MS).toISOString() : row.expiresAt;
  const results = await db.batch([
    db.prepare(`UPDATE pin_setup_requests SET status = ?, decided_at = ?, decided_by = ?, expires_at = ? WHERE installation_id = 'primary' AND id = ? AND status = 'pending' AND expires_at > ?${approve ? " AND EXISTS (SELECT 1 FROM kiosks k WHERE k.installation_id = 'primary' AND k.id = pin_setup_requests.kiosk_id AND k.active = 1 AND k.require_pin = 1)" : ""}`)
      .bind(status, nowText, actor.userId, expiresAt, requestId, nowText),
    db.prepare(`INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, ?, 'pin_request', ?, ?, ? WHERE EXISTS (SELECT 1 FROM pin_setup_requests WHERE installation_id = 'primary' AND id = ? AND status = ? AND decided_at = ?)`)
      .bind(crypto.randomUUID(), actor.userId, `pin_request.${status}`, requestId, JSON.stringify({ kioskId: row.kioskId, memberId: row.memberRosterId }), nowText, requestId, status, nowText),
  ]);
  if ((results[0]?.meta?.changes ?? 0) < 1) throw new HttpError(409, "This PIN request is no longer waiting for a decision.", undefined, "pin_request_not_pending");
  return respond({ request: dashboardRequestView({ ...row, status, decidedAt: nowText, expiresAt }, nowText) });
}

/** GET and PUT /admin/settings/pin-lockout. Turning lockout off also ends every current lock; tries keep counting. */
export async function pinLockoutSettings(request: Request, context: { db: D1Database; actor: PinActor; readJson: ReadJson; respond: Json }): Promise<Response> {
  const { db, actor, readJson, respond } = context;
  const current = await readPinLockout(db);
  if (request.method === "GET") return respond(current);
  const input = await readJson<Record<string, unknown>>(request, 4096);
  if (!object(input) || Object.keys(input).some((key) => !["enabled", "attempts", "minutes"].includes(key)) || typeof input.enabled !== "boolean"
    || !Number.isInteger(input.attempts) || Number(input.attempts) < 3 || Number(input.attempts) > 20
    || !Number.isInteger(input.minutes) || Number(input.minutes) < 1 || Number(input.minutes) > 1440) throw new HttpError(400, "Choose whether lockout is on, 3 to 20 wrong tries, and 1 to 1440 minutes.", undefined, "invalid_pin_lockout");
  const next: PinLockout = { enabled: input.enabled, attempts: Number(input.attempts), minutes: Number(input.minutes) }; const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare("UPDATE organization_settings SET pin_lockout_enabled = ?, pin_lockout_attempts = ?, pin_lockout_minutes = ? WHERE installation_id = 'primary'").bind(next.enabled ? 1 : 0, next.attempts, next.minutes),
    ...(next.enabled ? [] : [db.prepare("UPDATE member_pins SET locked_until = NULL, updated_at = ? WHERE installation_id = 'primary' AND locked_until IS NOT NULL").bind(now)]),
    auditStatement(db, "settings.pin_lockout_updated", actor.userId, "organization_settings", "primary", { previous: current, ...next }, now),
  ]);
  if ((results[0]?.meta?.changes ?? 0) < 1) throw new HttpError(409, "Organization settings are not set up yet.");
  return respond(next);
}

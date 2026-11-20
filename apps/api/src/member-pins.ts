import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

/**
 * Member PINs for kiosks that require one (web kiosk phase 3). The server keeps only a salted PBKDF2-SHA256 hash. A PIN
 * is never stored, logged, audited or returned: audit rows name the member and how the PIN changed, nothing more.
 */
// New PINs use 2,000 iterations so an online check fits the Workers Free plan's 10 ms of CPU. A 4 to 6 digit PIN whose
// hash is cached on kiosks is never protected by iteration count; kiosk custody and the online throttle protect it.
// Kiosks derive the same 256-bit key from the cached salt and iterations to check offline.
export const PIN_ITERATIONS = 2_000;
// The most iterations any stored hash may use: older PINs were set at 100,000. The database, both kiosk verifiers and
// backup restore enforce the same bound.
export const MAX_PIN_ITERATIONS = 100_000;
const PIN_KEY_BITS = 256;
const PIN_SALT_BYTES = 16;
const PIN_REQUEST_MS = 10 * 60_000;
const PIN_APPROVAL_MS = 5 * 60_000;
const MAX_FAILED_ATTEMPTS = 1_000_000;
/**
 * The online PIN throttle, per member and separate from the optional lockout. The first PIN_FREE_TRIES wrong PINs in a
 * row are free; each wrong PIN after that makes the next try wait PIN_THROTTLE_SECONDS, longest last and repeated. A
 * correct PIN, an Operator unlock or a new PIN starts over. A try made while waiting is refused before any hashing.
 */
export const PIN_FREE_TRIES = 5;
export const PIN_THROTTLE_SECONDS: readonly number[] = Object.freeze([30, 60, 300]);

export type PinLockout = { enabled: boolean; attempts: number; minutes: number };
export const defaultPinLockout: PinLockout = Object.freeze({ enabled: false, attempts: 5, minutes: 15 });
export type PinKiosk = { id: string; name: string; requirePin: boolean };
export type PinActor = { userId: string };
type Json = (body: unknown, status?: number) => Response;
type ReadJson = <T>(request: Request, maxBytes?: number) => Promise<T>;
type PinRow = { rosterId: string; memberId: string; firstName: string; lastName: string; pinHash?: string | null; pinSalt?: string | null; pinIterations?: number | null; setAt?: string | null; setKioskId?: string | null; failedAttempts?: number | null; lockedUntil?: string | null; throttleFailures?: number | null; throttleUntil?: string | null };
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
  if (!Number.isSafeInteger(stored.iterations) || stored.iterations < 1 || stored.iterations > MAX_PIN_ITERATIONS) return false;
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

const pinColumns = "m.id AS rosterId, m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, p.pin_hash AS pinHash, p.pin_salt AS pinSalt, p.pin_iterations AS pinIterations, p.set_at AS setAt, p.set_kiosk_id AS setKioskId, p.failed_attempts AS failedAttempts, p.locked_until AS lockedUntil, p.throttle_failures AS throttleFailures, p.throttle_until AS throttleUntil";
/** A roster member by roster id or member ID (the roster id wins), with their PIN row if any. */
async function memberPin(db: D1Database, memberId: unknown, activeOnly: boolean): Promise<PinRow> {
  if (!identifier(memberId)) throw new HttpError(400, "Choose a roster member.", undefined, "invalid_member");
  const row = await db.prepare(`SELECT ${pinColumns} FROM members m LEFT JOIN member_pins p ON p.installation_id = m.installation_id AND p.member_id = m.id WHERE m.installation_id = 'primary' AND (m.id = ? OR m.external_id = ?)${activeOnly ? " AND m.active = 1" : ""} ORDER BY m.id = ? DESC LIMIT 1`).bind(memberId, memberId, memberId).first<PinRow>();
  if (!row) throw new HttpError(404, activeOnly ? "This member is not an active roster member." : "Roster member not found.", undefined, "member_not_found");
  return row;
}
const hasPin = (row: PinRow) => typeof row.pinHash === "string" && typeof row.pinSalt === "string";
const activeLock = (row: { lockedUntil?: string | null }, now: string) => typeof row.lockedUntil === "string" && row.lockedUntil > now ? row.lockedUntil : null;
const activeThrottle = (row: { throttleUntil?: string | null }, now: string) => typeof row.throttleUntil === "string" && row.throttleUntil > now ? row.throttleUntil : null;
/**
 * SQL that is true while a member's PIN row takes an online try: no lock and no throttle wait is running at the time in
 * the given parameter. The write that claims a try carries it, so the row as it is when that write runs decides.
 */
const takesOnlineTry = (nowParameter: number) => `(locked_until IS NULL OR locked_until <= ?${nowParameter}) AND (throttle_until IS NULL OR throttle_until <= ?${nowParameter})`;

/** "Too many wrong PINs. Try again in 30 seconds.": whole seconds under a minute, then whole minutes, rounded up. */
export function pinThrottleMessage(seconds: number) {
  return `Too many wrong PINs. Try again in ${throttleWaitText(seconds)}.`;
}
/** "30 seconds", "2 minutes": the wait in a throttle message. Shared with the Discord code throttle. */
export function throttleWaitText(seconds: number) {
  const whole = Math.max(1, Math.ceil(seconds)), minutes = Math.ceil(whole / 60);
  return whole < 60 ? `${whole} ${whole === 1 ? "second" : "seconds"}` : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
/** The refusal for a try made while the throttle's wait runs. It says nothing about whether the PIN was right. */
function throttled(retryAt: string, now: number) {
  const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(retryAt) - now) / 1000));
  return new HttpError(429, pinThrottleMessage(retryAfterSeconds), undefined, "pin_throttled", { retryAt, retryAfterSeconds });
}
/** SQL for the wait after a wrong online try: NULL while tries are free, then each delay in turn, the last repeating. */
function throttleUntilSql(firstParameter: number) {
  const next = "throttle_failures + 1";
  const steps = PIN_THROTTLE_SECONDS.slice(0, -1).map((_, index) => `WHEN ${next} = ${PIN_FREE_TRIES + index} THEN ?${firstParameter + index} `).join("");
  return `CASE WHEN ${next} < ${PIN_FREE_TRIES} THEN NULL ${steps}ELSE ?${firstParameter + PIN_THROTTLE_SECONDS.length - 1} END`;
}

function auditStatement(db: D1Database, action: string, actorUserId: string | null, targetType: string, targetId: string, metadata: Record<string, unknown>, now: string) {
  return db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorUserId, action, targetType, targetId, JSON.stringify(metadata), now);
}

/**
 * SQL for the lockout step of the claim in checkScanPin, which counts an online try toward the lockout before its PIN
 * is checked. The lockout setting is read by the claim itself, as it is when the claim runs, so the claim costs no
 * query more: `enabled`, `attempts` and `minutes` are its columns, with the defaults for an installation whose settings
 * are not set up. `nextCount` is the count after this try: a lock that has run out starts a fresh count, as in
 * recordReportedTries. `lockUntil` is NULL unless lockout is on and this try reaches the limit; then it is the
 * configured minutes after the time in ?1, in the format of Date.toISOString(). The claim only runs on a row with no
 * lock running, so it never extends one. ?3 is the cap on the count.
 */
const lockoutClaimSql = (() => {
  const setting = (column: string, fallback: number) => `COALESCE((SELECT ${column} FROM organization_settings WHERE installation_id = 'primary'), ${fallback})`;
  const enabled = setting("pin_lockout_enabled", 0), attempts = setting("pin_lockout_attempts", defaultPinLockout.attempts), minutes = setting("pin_lockout_minutes", defaultPinLockout.minutes);
  const nextCount = "MIN(CASE WHEN locked_until IS NOT NULL AND locked_until <= ?1 THEN 1 ELSE failed_attempts + 1 END, ?3)";
  return { enabled, attempts, minutes, nextCount, lockUntil: `CASE WHEN ${enabled} = 1 AND ${nextCount} >= ${attempts} THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '+' || ${minutes} || ' minutes') ELSE NULL END` };
})();

type ReportedTries = { memberId: string; count: number; lastAt: string };
/** How long a kiosk report id is remembered. A kiosk resends a report whose answer it lost as soon as it is next online. */
const REPORT_ID_DAYS = 30;
/**
 * A subquery over one JSON parameter, [[memberId, count, lastAt], ...]: the tries that count, added up per roster member.
 * memberId is a roster id or a member ID (the roster id wins). Entries for no one on the roster, for a member with no
 * PIN, or last made before the member's current PIN was set (against an older PIN) are left out.
 */
const reportedTriesSql = (parameter: number) => `SELECT p.member_id AS memberId, SUM(r.tries) AS tries
  FROM (SELECT (SELECT m.id FROM members m WHERE m.installation_id = 'primary' AND (m.id = json_extract(j.value, '$[0]') OR m.external_id = json_extract(j.value, '$[0]')) ORDER BY m.id = json_extract(j.value, '$[0]') DESC LIMIT 1) AS rosterId,
      json_extract(j.value, '$[1]') AS tries, json_extract(j.value, '$[2]') AS lastAt FROM json_each(?${parameter}) j) r
  CROSS JOIN member_pins p ON p.installation_id = 'primary' AND p.member_id = r.rosterId AND p.set_at <= r.lastAt
  GROUP BY p.member_id`;

/**
 * Adds a kiosk's report of wrong tries made offline to each member's count. A lock that has run out starts a fresh count.
 * With lockout on, reaching the limit locks for the configured minutes (an active lock is never extended); with it off,
 * tries are only counted. The tries never count toward the online throttle.
 *
 * Queries: the lockout read, then one batch, whatever the size of the report, so 200 entries fit the Workers Free
 * plan's 50 subrequests. The batch is one transaction: a report is applied whole or not at all, so a kiosk that got an
 * error and sends the report again cannot have part of it counted twice. Returns the number of tries counted.
 *
 * A report that was applied but whose answer never reached the kiosk is sent again too. A kiosk that names its report
 * (`reportId`, the same on every resend) is protected from that: the batch also records the id for this kiosk
 * (kiosk_pin_failure_reports, migration 0101) with the number of tries counted, and counts nothing when the id is
 * already there. A repeat is answered with the number recorded the first time. A kiosk from before report ids sends
 * none, and its report is applied exactly as before, with the same three statements.
 *
 * The same batch removes ids older than REPORT_ID_DAYS, so the table stays a few rows per kiosk. Still one batch: two
 * D1 subrequests with or without an id, whatever the size of the report.
 */
async function recordReportedTries(db: D1Database, kiosk: PinKiosk, failures: ReportedTries[], reportId?: string): Promise<number> {
  if (!failures.length) return 0;
  const lockout = await readPinLockout(db);
  const now = new Date(); const nowText = now.toISOString(); const lockUntil = new Date(now.getTime() + lockout.minutes * 60_000).toISOString();
  const report = JSON.stringify(failures.map((failure) => [failure.memberId, failure.count, new Date(failure.lastAt).toISOString()]));
  // `pins` names the member's row as it is before this report; `t` is reportedTriesSql.
  const nextCount = (pins: string) => `MIN(CASE WHEN ${pins}.locked_until IS NOT NULL AND ${pins}.locked_until <= ?1 THEN t.tries ELSE ${pins}.failed_attempts + t.tries END, ?5)`;
  const lockStarts = (pins: string) => `NOT (${pins}.locked_until IS NOT NULL AND ${pins}.locked_until > ?1) AND ?2 = 1 AND ${nextCount(pins)} >= ?3`;
  const uuid = "lower(printf('%s-%s-%s-%s-%s', hex(randomblob(4)), hex(randomblob(2)), hex(randomblob(2)), hex(randomblob(2)), hex(randomblob(6))))";
  // With a report id, the two writes do nothing when this kiosk's report was applied before. Without one, no condition
  // and no extra parameter: the statements are the ones kiosks have always been answered with.
  const firstTime = (kioskParameter: number, idParameter: number) => reportId === undefined ? "" : ` AND NOT EXISTS (SELECT 1 FROM kiosk_pin_failure_reports a WHERE a.installation_id = 'primary' AND a.kiosk_id = ?${kioskParameter} AND a.report_id = ?${idParameter})`;
  const named = <T>(...values: T[]) => reportId === undefined ? [] : values;
  const results = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(t.tries), 0) AS recorded FROM (${reportedTriesSql(1)}) t`).bind(report),
    // Audits member_pin.locked for each lock this report starts. It reads the rows before the next statement changes them.
    db.prepare(`INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ${uuid}, 'primary', NULL, 'member_pin.locked', 'member', p.member_id, json_object('kioskId', ?7, 'via', 'offline_report', 'failedAttempts', ${nextCount("p")}, 'lockedUntil', ?4, 'minutes', ?8), ?1
      FROM (${reportedTriesSql(6)}) t CROSS JOIN member_pins p ON p.installation_id = 'primary' AND p.member_id = t.memberId WHERE ${lockStarts("p")}${firstTime(7, 9)}`)
      .bind(nowText, lockout.enabled ? 1 : 0, lockout.attempts, lockUntil, MAX_FAILED_ATTEMPTS, report, kiosk.id, lockout.minutes, ...named(reportId)),
    db.prepare(`UPDATE member_pins SET
        locked_until = CASE WHEN member_pins.locked_until IS NOT NULL AND member_pins.locked_until > ?1 THEN member_pins.locked_until WHEN ${lockStarts("member_pins")} THEN ?4 ELSE NULL END,
        failed_attempts = ${nextCount("member_pins")}, updated_at = ?1
      FROM (${reportedTriesSql(6)}) t WHERE member_pins.installation_id = 'primary' AND member_pins.member_id = t.memberId${firstTime(7, 8)}`)
      .bind(nowText, lockout.enabled ? 1 : 0, lockout.attempts, lockUntil, MAX_FAILED_ATTEMPTS, report, ...named(kiosk.id, reportId)),
    ...(reportId === undefined ? [] : [
      // After the writes above, which look for the id: records it with what was counted. A repeat keeps the first row.
      db.prepare(`INSERT OR IGNORE INTO kiosk_pin_failure_reports (installation_id, kiosk_id, report_id, recorded, applied_at)
        SELECT 'primary', ?2, ?3, COALESCE(SUM(t.tries), 0), ?4 FROM (${reportedTriesSql(1)}) t`).bind(report, kiosk.id, reportId, nowText),
      db.prepare("SELECT recorded FROM kiosk_pin_failure_reports WHERE installation_id = 'primary' AND kiosk_id = ? AND report_id = ?").bind(kiosk.id, reportId),
      db.prepare("DELETE FROM kiosk_pin_failure_reports WHERE installation_id = 'primary' AND applied_at < ?").bind(new Date(now.getTime() - REPORT_ID_DAYS * 86_400_000).toISOString()),
    ]),
  ]);
  // With an id, the row's count: this report's when it was just applied, the first one's when it is a repeat.
  const recorded = (index: number) => (results[index]?.results?.[0] as { recorded?: number } | undefined)?.recorded;
  return Number((reportId === undefined ? undefined : recorded(4)) ?? recorded(0) ?? 0);
}

/**
 * Whether a scan sent with no PIN was made before Require PIN was last turned on for its kiosk. Such a scan waited in
 * the kiosk's queue while an Admin changed the setting: the kiosk could not have asked for a PIN, so it is recorded as
 * a normal scan instead of being refused, which older kiosks would resend forever. The kiosk credential may already
 * skip the check with pinCheck "offline", so this trusts it with nothing new.
 *
 * The time comes from the audit of the kiosk's method change, the only record of it. It is written just after the
 * setting, so a scan made between the two is also let through. With no such audit the scan is refused as before.
 * Queries: one read, made only for a scan with neither pin nor pinCheck at a Require PIN kiosk.
 */
async function scanPredatesRequirePin(db: D1Database, kioskId: string, occurredAt: unknown): Promise<boolean> {
  const scannedAt = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
  if (!Number.isFinite(scannedAt)) return false;
  const row = await db.prepare("SELECT MAX(created_at) AS turnedOnAt FROM audit_log WHERE installation_id = 'primary' AND action = 'kiosk.authentication_method_updated' AND target_type = 'kiosk' AND target_id = ? AND json_extract(metadata_json, '$.requirePin') = 1 AND json_extract(metadata_json, '$.previousRequirePin') = 0").bind(kioskId).first<{ turnedOnAt?: string | null }>();
  const turnedOnAt = typeof row?.turnedOnAt === "string" ? Date.parse(row.turnedOnAt) : Number.NaN;
  return Number.isFinite(turnedOnAt) && scannedAt < turnedOnAt;
}

/**
 * The PIN step of a scan at a kiosk with Require PIN. Online, the kiosk sends the PIN and the server checks it. A scan
 * queued offline after the kiosk checked its cached hash says pinCheck "offline" and is recorded without one, even when
 * the member has been locked since: the device already accepted it. Offline checks are not throttled. A scan with
 * neither is refused with pin_required, unless it was made before Require PIN was turned on (scanPredatesRequirePin).
 *
 * The throttle and the lockout hold for tries sent at the same time. Before the PIN is checked, one write claims the
 * try: it counts the try toward the throttle and toward the lockout as if it were wrong, sets the wait that follows it,
 * and, with lockout on, starts the lock when the try reaches the configured number. It does so only on a row with no
 * lock and no wait running when the write runs, and it reads the lockout setting itself. A try that cannot claim is
 * refused without its PIN being checked, and says nothing about the PIN. A correct PIN then clears the counts, and a
 * lock its own claim started; a wrong one leaves them. So of any number of tries sent at once, no more are checked
 * than would be one after another: the free tries, then one for each wait, and with lockout on never more than the
 * configured number before the lock.
 *
 * Queries: the claim, which also reads the member's PIN and the lockout setting. Then, on a correct PIN, one write,
 * which also rehashes a PIN stored at another iteration count; on a wrong PIN nothing, or one write that audits the
 * lock when this try started it. A try that could not claim makes one read, for its reason (no such member, no PIN,
 * locked, waiting), and hashes nothing.
 */
export async function checkScanPin(db: D1Database, kiosk: PinKiosk, input: { memberId?: unknown; pin?: unknown; pinCheck?: unknown; occurredAt?: unknown }): Promise<void> {
  if (!kiosk.requirePin) return;
  if (input.pinCheck !== undefined && input.pinCheck !== "offline") throw new HttpError(400, "pinCheck must be offline", undefined, "invalid_pin_check");
  if (input.pinCheck === "offline") return;
  if (input.pin === undefined || input.pin === null || input.pin === "") {
    if (await scanPredatesRequirePin(db, kiosk.id, input.occurredAt)) return;
    throw new HttpError(400, "This kiosk requires a PIN.", undefined, "pin_required");
  }
  const pin = requirePinValue(input.pin);
  if (!identifier(input.memberId)) throw new HttpError(400, "Choose a roster member.", undefined, "invalid_member");
  const nowMs = Date.now(); const now = new Date(nowMs).toISOString();
  const waits = PIN_THROTTLE_SECONDS.map((seconds) => new Date(nowMs + seconds * 1000).toISOString());
  // The claim. The member is found as memberPin finds them: active, by roster id or member ID, the roster id winning.
  const claimed = await db.prepare(`UPDATE member_pins SET throttle_until = ${throttleUntilSql(4)}, throttle_failures = MIN(throttle_failures + 1, ?3),
      failed_attempts = ${lockoutClaimSql.nextCount}, locked_until = ${lockoutClaimSql.lockUntil}, updated_at = ?1
    WHERE installation_id = 'primary' AND member_id = (SELECT m.id FROM members m WHERE m.installation_id = 'primary' AND (m.id = ?2 OR m.external_id = ?2) AND m.active = 1 ORDER BY m.id = ?2 DESC LIMIT 1) AND ${takesOnlineTry(1)}
    RETURNING member_id AS rosterId, pin_hash AS pinHash, pin_salt AS pinSalt, pin_iterations AS pinIterations, throttle_until AS throttleUntil, failed_attempts AS failedAttempts, locked_until AS lockedUntil,
      ${lockoutClaimSql.enabled} AS lockoutEnabled, ${lockoutClaimSql.attempts} AS lockoutAttempts, ${lockoutClaimSql.minutes} AS lockoutMinutes`)
    .bind(now, input.memberId, MAX_FAILED_ATTEMPTS, ...waits).first<{ rosterId: string; pinHash: string; pinSalt: string; pinIterations: number; throttleUntil: string | null; failedAttempts: number; lockedUntil: string | null; lockoutEnabled: number; lockoutAttempts: number; lockoutMinutes: number }>();
  if (!claimed) {
    let member: PinRow;
    // A scan for someone who is not an active member fails in the attendance step with its usual reason.
    try { member = await memberPin(db, input.memberId, true); } catch (error) { if (error instanceof HttpError && error.status === 404) return; throw error; }
    if (!hasPin(member)) throw new HttpError(409, "This member has no PIN yet.", undefined, "pin_not_set");
    const locked = activeLock(member, now);
    if (locked) throw new HttpError(423, "This PIN is locked after too many wrong tries.", undefined, "pin_locked", { lockedUntil: locked });
    // Neither is running now only when one ran out, or the PIN was set, between the two statements: try again at once.
    throw throttled(activeThrottle(member, now) ?? new Date(nowMs + 1000).toISOString(), nowMs);
  }
  const iterations = Number(claimed.pinIterations);
  if (await verifyPin(pin, { hash: claimed.pinHash, salt: claimed.pinSalt, iterations })) {
    // Clears the claim with the rest. A PIN reset or set since the claim (another hash) is left alone.
    const clear = "failed_attempts = 0, locked_until = NULL, throttle_failures = 0, throttle_until = NULL, updated_at = ?1 WHERE installation_id = 'primary' AND member_id = ?2 AND pin_hash = ?3";
    if (iterations !== PIN_ITERATIONS) {
      // The same PIN at the current cost, with a new salt. set_at stays: the member did not set a PIN. The hash change
      // bumps the kiosk roster revision, so kiosks fetch the new hash; until then their cached one still matches this PIN.
      const fresh = await hashPin(pin);
      await db.prepare(`UPDATE member_pins SET pin_hash = ?4, pin_salt = ?5, pin_iterations = ?6, ${clear}`).bind(now, claimed.rosterId, claimed.pinHash, fresh.hash, fresh.salt, fresh.iterations).run();
    } else await db.prepare(`UPDATE member_pins SET ${clear}`).bind(now, claimed.rosterId, claimed.pinHash).run();
    return;
  }
  // The claim counted this try and, at the limit, started the lock: only the audit of a new lock is left to write. It is
  // written while that lock still stands, so not after an Operator's unlock or a new PIN.
  const lockout = normalizePinLockout({ enabled: claimed.lockoutEnabled, attempts: claimed.lockoutAttempts, minutes: claimed.lockoutMinutes });
  const lockedUntil = activeLock(claimed, now);
  if (lockedUntil) await db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', NULL, 'member_pin.locked', 'member', ?, ?, ? WHERE EXISTS (SELECT 1 FROM member_pins WHERE installation_id = 'primary' AND member_id = ? AND pin_hash = ? AND locked_until = ?)")
    .bind(crypto.randomUUID(), claimed.rosterId, JSON.stringify({ kioskId: kiosk.id, via: "kiosk", failedAttempts: Number(claimed.failedAttempts), lockedUntil, minutes: lockout.minutes }), now, claimed.rosterId, claimed.pinHash, lockedUntil).run();
  const extra: Record<string, string | number> = {};
  if (lockout.enabled) extra.attemptsLeft = lockedUntil ? 0 : Math.max(0, lockout.attempts - Number(claimed.failedAttempts));
  if (lockedUntil) extra.lockedUntil = lockedUntil;
  // The next try has to wait: say until when, so a kiosk can tell the member.
  const retryAt = activeThrottle(claimed, now);
  if (retryAt) extra.retryAt = retryAt;
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

/** A new PIN hashed, and the time it is set at. Each route writes it with its own guarded INSERT. */
async function newPin(pin: string) {
  return { hashed: await hashPin(pin), now: new Date().toISOString() };
}

/** Kiosk routes under /kiosk/pin-requests, /kiosk/pins and /kiosk/pin-failures. Returns undefined for other paths. */
export async function kioskPinRoute(request: Request, path: string, context: { db: D1Database; kiosk: PinKiosk; readJson: ReadJson; respond: Json }): Promise<Response | undefined> {
  const { db, kiosk, readJson, respond } = context; const method = request.method;
  if (path === "/kiosk/pin-failures" && method === "POST") {
    const input = await readJson<{ failures?: unknown; reportId?: unknown }>(request, 65_536);
    // reportId is optional: kiosks from before report ids send none. One that is sent must be usable as a key.
    if (object(input) && input.reportId !== undefined && input.reportId !== null && !identifier(input.reportId)) throw new HttpError(400, "reportId is 1 to 128 characters", undefined, "invalid_pin_failures");
    if (!object(input) || !Array.isArray(input.failures) || input.failures.length > 200 || input.failures.some((item) => !object(item) || !identifier(item.memberId) || !Number.isInteger(item.count) || Number(item.count) < 1 || Number(item.count) > 1000 || typeof item.lastAt !== "string" || item.lastAt.length > 64 || !Number.isFinite(Date.parse(item.lastAt)))) throw new HttpError(400, "Report up to 200 failures as { memberId, count, lastAt }", undefined, "invalid_pin_failures");
    // Tries reported after Require PIN was turned off are dropped, so the kiosk can clear its queue.
    if (!kiosk.requirePin) return respond({ recorded: 0 });
    return respond({ recorded: await recordReportedTries(db, kiosk, input.failures as ReportedTries[], identifier(input.reportId) ? input.reportId : undefined) });
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
    const created = await newPin(pin);
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
    const created = await newPin(pin);
    const results = await db.batch([
      db.prepare("INSERT INTO member_pins (installation_id, member_id, pin_hash, pin_salt, pin_iterations, set_at, set_kiosk_id, failed_attempts, locked_until, updated_at) VALUES ('primary', ?, ?, ?, ?, ?, ?, 0, NULL, ?) ON CONFLICT(installation_id, member_id) DO NOTHING").bind(member.rosterId, created.hashed.hash, created.hashed.salt, created.hashed.iterations, created.now, kiosk.id, created.now),
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
    // Unlock also ends the online throttle's wait, so the member can try again at once.
    db.prepare("UPDATE member_pins SET failed_attempts = 0, locked_until = NULL, throttle_failures = 0, throttle_until = NULL, updated_at = ? WHERE installation_id = 'primary' AND member_id = ?").bind(now, member.rosterId),
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

/** How many PIN requests are waiting at each kiosk, for the dashboard's top bar and Kiosks list. */
export type PinRequestCounts = { total: number; kiosks: { kioskId: string; count: number }[] };

/**
 * The count of pending PIN requests that have not run out, per active kiosk: what GET /admin/kiosks/:id/pin-requests
 * would list for each. It rides on the dashboard's module refresh (GET /platform/modules), so it adds no request.
 *
 * Queries: one read. It walks the kiosks and, for each active one, seeks its pending unexpired rows in the
 * pin_setup_requests_kiosk index (installation_id, kiosk_id, status, expires_at), without touching the table. Written
 * as a subquery per kiosk so the rows read are the kiosks plus the waiting requests, never the answered or expired ones
 * kept for 30 days.
 */
export async function pinRequestCounts(db: D1Database): Promise<PinRequestCounts> {
  const now = new Date().toISOString();
  const rows = (await db.prepare("SELECT k.id AS kioskId, (SELECT COUNT(*) FROM pin_setup_requests r WHERE r.installation_id = k.installation_id AND r.kiosk_id = k.id AND r.status = 'pending' AND r.expires_at > ?) AS count FROM kiosks k WHERE k.installation_id = 'primary' AND k.active = 1 ORDER BY k.id").bind(now).all<{ kioskId: string; count: number }>()).results ?? [];
  const kiosks = rows.map((row) => ({ kioskId: row.kioskId, count: Number(row.count) })).filter((row) => row.count > 0);
  return { total: kiosks.reduce((sum, row) => sum + row.count, 0), kiosks };
}

/**
 * GET /admin/kiosks/pin-requests: every active kiosk's pending requests that have not run out, by kiosk name and then oldest
 * first, each with its kiosk. The top bar's PIN requests dialog reads it while it is open. Being under /admin/kiosks, it needs
 * the Attendance workspace, as each kiosk's own list does. Queries: one read, kiosks first (CROSS JOIN keeps that order) so
 * each kiosk's waiting rows are sought in the index, as in pinRequestCounts.
 */
export async function dashboardPinRequests(context: { db: D1Database; respond: Json }): Promise<Response> {
  const { db, respond } = context; const now = new Date().toISOString();
  const rows = (await db.prepare(`SELECT ${dashboardRequestColumns}, k.name AS kioskName FROM kiosks k CROSS JOIN pin_setup_requests r ON r.installation_id = k.installation_id AND r.kiosk_id = k.id AND r.status = 'pending' AND r.expires_at > ? JOIN members m ON m.installation_id = r.installation_id AND m.id = r.member_id WHERE k.installation_id = 'primary' AND k.active = 1 ORDER BY k.name COLLATE NOCASE, r.kiosk_id, r.created_at, r.id LIMIT 200`).bind(now).all<DashboardRequestRow & { kioskName: string }>()).results ?? [];
  return respond({ requests: rows.map((row) => { const { id, kioskId, member, createdAt, expiresAt } = dashboardRequestView(row, now); return { id, kioskId, kioskName: row.kioskName, member, createdAt, expiresAt }; }) });
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

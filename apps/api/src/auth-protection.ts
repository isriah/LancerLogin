// Authentication abuse protection that needs no extra Cloudflare bindings: per-client D1 throttles for public
// authentication routes, atomic failed-login counting, and one-time first-Admin setup codes.
import type { D1Database } from "./d1-usage.ts";

export const loginLockThreshold = 5;
export const loginLockMs = 15 * 60_000;

/** Public routes that accept guesses. Each client address gets its own fixed window per route. */
export const authRateLimits: Readonly<Record<string, { limit: number; windowMs: number }>> = Object.freeze({
  "/auth/local": { limit: 30, windowMs: 10 * 60_000 },
  "/setup/bootstrap": { limit: 10, windowMs: 10 * 60_000 },
  "/kiosk/pair": { limit: 20, windowMs: 10 * 60_000 },
});
/** Rows older than this are pruned by the scheduled pass; every window above is shorter. */
const rateLimitRetentionMs = 24 * 60 * 60_000;
/** A DELETE INSTALLATION grant lets the same browser run first-Admin setup again with the original setup code. */
export const setupResetGrantMs = 60 * 60_000;
export const setupResetCookie = "lancerlogin_setup_reset";

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Counts one attempt for this client and route in a single D1 write. The bucket is a keyed hash of the route and the
 * client address, so no raw address is stored. Returns the seconds to wait when the window is exhausted.
 * A D1 failure (for example a Worker deployed ahead of its migration) does not block sign-in; the per-account
 * lock still applies.
 */
export async function consumeAuthRateLimit(db: D1Database, request: Request, route: string, salt: string, now = Date.now()): Promise<number | undefined> {
  const policy = authRateLimits[route];
  if (!policy) return undefined;
  const address = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const bucket = await sha256Hex(`lancerlogin:auth-rate-limit:${salt}:${route}:${address}`);
  const expired = now - policy.windowMs;
  let row: { attempts: number; windowStartMs: number } | null;
  try {
    row = await db.prepare(`INSERT INTO auth_rate_limits (bucket, window_start_ms, attempts) VALUES (?, ?, 1)
      ON CONFLICT(bucket) DO UPDATE SET
        attempts = CASE WHEN auth_rate_limits.window_start_ms <= ? THEN 1 ELSE MIN(auth_rate_limits.attempts + 1, 1000000) END,
        window_start_ms = CASE WHEN auth_rate_limits.window_start_ms <= ? THEN excluded.window_start_ms ELSE auth_rate_limits.window_start_ms END
      RETURNING attempts, window_start_ms AS windowStartMs`).bind(bucket, now, expired, expired).first<{ attempts: number; windowStartMs: number }>();
  } catch { return undefined; }
  if (!row || Number(row.attempts) <= policy.limit) return undefined;
  return Math.max(1, Math.ceil((Number(row.windowStartMs) + policy.windowMs - now) / 1000));
}

/** Prunes expired throttle rows and setup reset grants. Runs from the scheduled pass so request paths stay one write. */
export function pruneAuthProtection(db: D1Database, now = Date.now()) {
  return db.batch([
    db.prepare("DELETE FROM auth_rate_limits WHERE window_start_ms < ?").bind(now - rateLimitRetentionMs),
    db.prepare("DELETE FROM bootstrap_reset_grants WHERE expires_at < ?").bind(new Date(now).toISOString()),
  ]);
}

export const lockActive = (lockedUntil?: string | null, now = Date.now()) => Boolean(lockedUntil && Date.parse(lockedUntil) > now);

/**
 * Atomically counts one failed password. Concurrent guesses each add one, so the fifth failure locks the account no
 * matter how the requests interleave. A lock blocks new sign-ins only. It deliberately leaves existing sessions alone,
 * so nobody can sign a user (or the only Admin) out just by sending wrong passwords.
 * A locked account is not counted again until its lock expires.
 */
export async function recordFailedLogin(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE users SET failed_login_count = failed_login_count + 1,
      locked_until = CASE WHEN failed_login_count + 1 >= ${loginLockThreshold} THEN ? ELSE locked_until END
    WHERE installation_id = 'primary' AND id = ? AND (locked_until IS NULL OR locked_until <= ?)`)
    .bind(new Date(now + loginLockMs).toISOString(), userId, new Date(now).toISOString()).run();
}

/**
 * Clears failed-login state after a correct password, only while the account is still unlocked. Returns false when a
 * concurrent failure locked the account first, in which case the sign-in must be refused.
 */
export async function clearFailedLogins(db: D1Database, userId: string, now = Date.now()): Promise<boolean> {
  const result = await db.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE installation_id = 'primary' AND id = ? AND active = 1 AND (locked_until IS NULL OR locked_until <= ?)")
    .bind(userId, new Date(now).toISOString()).run();
  return Number(result.meta?.changes ?? 1) > 0;
}

/** The stored claim is a further hash of BOOTSTRAP_CODE_HASH, so D1 never holds the Worker secret value itself. */
export const bootstrapClaimKey = (codeHash: string) => sha256Hex(`lancerlogin:bootstrap-claim:${codeHash}`);
export const setupResetGrantKey = (grant: string) => sha256Hex(`lancerlogin:setup-reset-grant:${grant}`);

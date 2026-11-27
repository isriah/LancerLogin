import { initialWalkthroughProgress, validWalkthroughProgress, walkthroughs, type WalkthroughPage, type WalkthroughProgress } from "../../../../packages/shared/src/walkthrough.ts";
import { createSessionCodec, fakePasswordSalt, parsePasswordKey, parsePasswordSalt, passwordFormat, passwordHashFromCredential, passwordSaltBytes, passwordScrypt, storedPasswordSalt, verifyLegacyPassword, verifyPasswordKey } from "../runtime-security.ts";
import { encodeBase64Url as encodeBytes } from "../../../../packages/shared/src/password-hash.mjs";
import { clearFailedLogins, lockActive, recordFailedLogin } from "../auth-protection.ts";
import { WebUpdateError } from "../web-updates.ts";
import { type D1Database } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { type Env, type Role, authorizedRead, cookie, isObject, localSessionCookie, parseJson, requireDatabase, requireRole, response, sessionLookup } from "./core.ts";

/**
 * A dashboard tab loaded before server relief posts the plain password. The Worker no longer hashes passwords, so rather
 * than run scrypt on it, it asks for a reload, which loads the dashboard that sends K.
 */
export const reloadRequired = () => new HttpError(409, "This page is out of date. Reload the page and try again.", undefined, "reload_required");
/** `{ salt, key }` from setup, account creation or a reset, with nothing else in it (the same check the stored row is built with). */
export const validPasswordCredential = (value: unknown) => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => key === "salt" || key === "key") && parsePasswordSalt((value as { salt?: unknown }).salt) && parsePasswordKey((value as { key?: unknown }).key));
type PasswordProofInput = { key?: unknown; salt?: unknown; password?: unknown };
/** K from a sign-in or identity confirmation body. A body with a password but no K comes from an outdated tab. */
export function passwordProofKey(input: PasswordProofInput, invalidMessage: string): Uint8Array {
  if (input.key === undefined && input.password !== undefined) throw reloadRequired();
  const key = parsePasswordKey(input.key);
  if (!key) throw new HttpError(400, invalidMessage);
  return key;
}
/**
 * Checks a sign-in or identity confirmation proof against the stored row.
 * - A `scrypt-c` row compares SHA-256(label + K) in constant time: well under 1 ms of CPU.
 * - A legacy `scrypt$` row needs the password too. It is checked with server-side scrypt once, then the client's new K
 *   under its new salt becomes the row's value. The password check is what authenticates the new K, so a client that
 *   sends a wrong K with the right password only locks itself out. A legacy row is never converted without the password.
 * - Any other row (none, Google-only, malformed) runs the same cheap comparison and fails.
 */
export async function checkPasswordProof(stored: string | null | undefined, input: PasswordProofInput, key: Uint8Array): Promise<{ valid: boolean; upgradedHash?: string }> {
  const format = passwordFormat(stored);
  if (format === "scrypt-c") return { valid: await verifyPasswordKey(key, stored) };
  if (format === "legacy" && typeof input.password === "string" && input.password && input.password.length <= 1_024 && parsePasswordSalt(input.salt)) {
    if (!await verifyLegacyPassword(input.password, stored!)) return { valid: false };
    return { valid: true, upgradedHash: await passwordHashFromCredential({ salt: input.salt, key: input.key }) };
  }
  await verifyPasswordKey(key, undefined);
  return { valid: false };
}
/** Re-salts a legacy row after its password was checked. Only the row that was checked is replaced, so a concurrent reset wins. */
export async function storeUpgradedPassword(db: D1Database, userId: string, previous: string, upgraded: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE installation_id = 'primary' AND id = ? AND password_hash = ?").bind(upgraded, userId, previous).run();
}
/**
 * The salt and scrypt parameters for a stored row. Every answer has the same shape. A `scrypt-c` row gives its stored salt;
 * a username with no usable password (unknown, inactive or Google-only) gives a deterministic fake salt, so the answer
 * doesn't reveal which usernames exist.
 * Migration leak, accepted: until every row is migrated, a legacy row answers `legacy: true` with a fresh salt for its new
 * K. That reveals that the account exists and hasn't signed in since the update. It ends once the row is re-salted.
 */
async function passwordParams(sessionKey: string, stored: string | null | undefined, username: string) {
  const format = passwordFormat(stored);
  const salt = format === "scrypt-c" ? storedPasswordSalt(stored!)! : format === "legacy" ? encodeBytes(crypto.getRandomValues(new Uint8Array(passwordSaltBytes))) : await fakePasswordSalt(sessionKey, username);
  return { algorithm: "scrypt" as const, ...passwordScrypt, salt, legacy: format === "legacy" };
}
/** POST /auth/local/params {username}: the salt and parameters the browser needs to compute K before POST /auth/local. */
export async function localPasswordParams(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); if (!env.SESSION_KEY) throw new HttpError(503, "Local authentication is not configured");
  const input = await parseJson<{ username?: unknown }>(request, 4_096);
  if (!input || typeof input !== "object" || typeof input.username !== "string" || !input.username.trim() || input.username.length > 256) throw new HttpError(400, "Username and password are required");
  const username = input.username.trim().toLowerCase();
  const user = await db.prepare("SELECT password_hash AS passwordHash FROM users WHERE installation_id = 'primary' AND local_username = ? AND active = 1").bind(username).first<{ passwordHash: string | null }>();
  return response(await passwordParams(env.SESSION_KEY, user?.passwordHash, username));
}
/** POST /admin/plugins/reauthenticate/params: the signed-in Admin's own salt, for identity confirmation. */
export async function reauthenticationParams(env: Env, userId: string, input: Record<string, unknown>) {
  if (Object.keys(input).length) throw new HttpError(400, "Invalid plugin request");
  if (!env.SESSION_KEY) throw new HttpError(503, "Authentication is not configured");
  const user = await requireDatabase(env).prepare("SELECT password_hash AS passwordHash FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1").bind(userId).first<{ passwordHash: string | null }>();
  if (!passwordFormat(user?.passwordHash)) throw new WebUpdateError(409, "password_unavailable", "This account has no LancerLogin password. Sign in with Google again instead.");
  return passwordParams(env.SESSION_KEY, user!.passwordHash, userId);
}
export async function localLogin(request: Request, env: Env): Promise<Response> {
  const db = requireDatabase(env); if (!env.SESSION_KEY) throw new HttpError(503, "Local authentication is not configured");
  const input = await parseJson<{ username?: string } & PasswordProofInput>(request);
  if (typeof input.username !== "string" || !input.username) throw new HttpError(400, "Username and password are required");
  const key = passwordProofKey(input, "Username and password are required");
  const user = await db.prepare("SELECT id, role, password_hash AS passwordHash, locked_until AS lockedUntil, session_epoch AS sessionEpoch FROM users WHERE installation_id = ? AND local_username = ? AND active = 1").bind("primary", input.username.trim().toLowerCase()).first<{ id: string; role: Role; passwordHash: string | null; lockedUntil?: string; sessionEpoch?: number }>();
  // A locked account is refused before any work, including a legacy row's one server-side scrypt. Failures are counted
  // atomically in D1, so parallel guesses cannot all read the same count; a concurrent lock also refuses a correct
  // password that was still being checked. Unknown usernames need no timing equalizer: every check is one cheap SHA-256.
  if (lockActive(user?.lockedUntil)) throw new HttpError(401, "Invalid username or password");
  const checked = await checkPasswordProof(user?.passwordHash, input, key);
  if (!user?.passwordHash || !checked.valid) {
    if (user) await recordFailedLogin(db, user.id);
    throw new HttpError(401, "Invalid username or password");
  }
  if (!await clearFailedLogins(db, user.id)) throw new HttpError(401, "Invalid username or password");
  if (checked.upgradedHash) await storeUpgradedPassword(db, user.id, user.passwordHash, checked.upgradedHash);
  return response({ ok: true, user: { id: user.id, role: user.role } }, 200, { "set-cookie": await localSessionCookie(env.SESSION_KEY, user) });
}
export async function authSession(request: Request, env: Env): Promise<Response> {
  // The session lookup read this profile together with its revocation check.
  const { user } = await sessionLookup(request, env).current;
  return response({ authenticated: true, user: { id: user.id, email: user.email, localUsername: user.localUsername, role: user.role } });
}
export async function logout(request: Request, env: Env): Promise<Response> {
  // Bump the session epoch so this token, and any copy of it, stops working everywhere, not only in this browser.
  try {
    const token = cookie(request, "lancerlogin_session");
    const principal = token && env.SESSION_KEY ? await createSessionCodec(env.SESSION_KEY).verify(token) : undefined;
    if (principal && env.DB) await env.DB.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE installation_id = 'primary' AND id = ? AND session_epoch = ?").bind(principal.userId, principal.epoch ?? 0).run();
  } catch { /* Clearing the cookie still signs this browser out. */ }
  return response({ ok: true }, 200, { "set-cookie": "lancerlogin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
}
// Debug mode is a per-browser dashboard setting and the Background scheduler follows it, so neither has a server preference.
// The users.debug_mode column and user_preferences table remain for backup compatibility and are no longer read.

export async function authWalkthrough(request: Request, env: Env, pageId: string): Promise<Response> {
  const known = Object.hasOwn(walkthroughs, pageId);
  if (request.method === "GET") {
    const [, progress] = await authorizedRead(request, env, ["admin", "operator"], async (userId) => known ? requireDatabase(env).prepare("SELECT page_id AS pageId, content_version AS version, status, step_id AS stepId FROM user_walkthroughs WHERE installation_id = 'primary' AND user_id = ? AND page_id = ?").bind(userId, pageId).first<WalkthroughProgress>() : null);
    if (!known) throw new HttpError(404, "Page walkthrough is unavailable");
    return response({ progress: progress ?? initialWalkthroughProgress(pageId as WalkthroughPage) });
  }
  const principal = await requireRole(request, env, ["admin", "operator"]);
  if (!known) throw new HttpError(404, "Page walkthrough is unavailable");
  const db = requireDatabase(env);
  const origin = request.headers.get("origin");
  if (origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, "Walkthrough preferences require the dashboard origin");
  const input = await parseJson<unknown>(request, 2048);
  if (!isObject(input) || Object.keys(input).some((key) => !["version", "status", "stepId"].includes(key))) throw new HttpError(400, "Invalid walkthrough progress");
  const progress = { ...input, pageId };
  if (!validWalkthroughProgress(progress)) throw new HttpError(400, "Invalid walkthrough progress");
  await db.prepare("INSERT INTO user_walkthroughs (installation_id, user_id, page_id, content_version, status, step_id, updated_at) VALUES ('primary', ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, user_id, page_id) DO UPDATE SET content_version = excluded.content_version, status = excluded.status, step_id = excluded.step_id, updated_at = excluded.updated_at")
    .bind(principal.userId, pageId, progress.version, progress.status, progress.stepId, new Date().toISOString()).run();
  return response({ progress });
}

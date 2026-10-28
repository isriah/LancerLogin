// Authentication hardening through the real Worker and real SQLite: the Google Calendar OAuth callback, purpose-bound
// OAuth state, atomic login lockout, public route throttling, one-time setup codes, session revocation and error hygiene.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec, createSignedStateCodec, hashPassword } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import type { D1Database, D1Result, D1Statement } from "../apps/api/src/d1-usage.ts";

class Statement implements D1Statement {
  readonly db: Database; readonly sql: string; readonly values: unknown[];
  constructor(db: Database, sql: string, values: unknown[] = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  result(): D1Result {
    const native = this.db.sqlite.prepare(this.sql);
    return /^\s*SELECT\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)
      ? { results: native.all(...this.values as []), meta: { changes: 0 } }
      : { success: true, meta: { changes: Number(native.run(...this.values as []).changes) } };
  }
  async first<T>() { return (this.result().results?.[0] as T | undefined) ?? null; }
  async all<T>() { return this.result() as D1Result<T>; }
  async run() { return this.result(); }
}
class Database implements D1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor(installation = true) {
    for (const file of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    if (!installation) return;
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled) VALUES('primary','2026-10-18','local',1);
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-10-18'),('operator','primary','operator','operator','2026-10-18');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','operator',0); INSERT INTO platform_module_assignment_revisions VALUES('primary','operator',0);
      INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','["attendance.manage"]');`);
  }
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(input: D1Statement[]) {
    const statements = input as Statement[];
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const results = statements.map(item => item.result()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  value<T>(sql: string, ...values: unknown[]) { return this.sqlite.prepare(sql).get(...values as []) as T | undefined; }
}

const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const origin = "https://dashboard.example.test";
const setupCode = "synthetic setup code 0001";
const setupCodeHash = createHash("sha256").update(setupCode).digest("base64url");
const environment = (db: D1Database, extra: Partial<Env> = {}) => ({ APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, INTEGRATION_KEY: secret, BOOTSTRAP_CODE_HASH: setupCodeHash, DB: db, ...extra }) as Env;
const sessionFor = async (userId: string, role: "admin" | "operator", epoch?: number) => `lancerlogin_session=${await createSessionCodec(secret).issue({ userId, role, ...(epoch === undefined ? {} : { epoch }) })}`;
function call(env: Env, path: string, options: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { origin };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.ip) headers["cf-connecting-ip"] = options.ip;
  return worker.fetch(new Request(`https://api.example.test${path}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), env);
}
const setCookie = (response: Response, name: string) => response.headers.getSetCookie().map((value) => value.split(";")[0]!).find((value) => value.startsWith(`${name}=`));
const quietErrors = (context: TestContext) => context.mock.method(console, "error", (...values: unknown[]) => { if (process.env.AUTH_TEST_DEBUG) console.log(...values); });

test("the Google Calendar callback completes without a session cookie, authenticated only by its signed state", async (context) => {
  const db = new Database(); const env = environment(db);
  const encrypted = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret" }, secret);
  db.sqlite.prepare("INSERT INTO google_calendar_authorizations(installation_id,ciphertext,iv,updated_at) VALUES('primary',?,?,'2026-10-18')").run(encrypted.ciphertext, encrypted.iv);
  const authorize = await call(env, "/admin/integrations/google-calendar/authorize", { cookie: await sessionFor("admin", "admin") });
  assert.equal(authorize.status, 302);
  const state = new URL(authorize.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = setCookie(authorize, "lancerlogin_calendar_oauth_state")!;
  assert.equal(stateCookie, `lancerlogin_calendar_oauth_state=${state}`);

  const tokenRequests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    tokenRequests.push(String(init?.body));
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
  });
  // Google's cross-site redirect carries the Lax state cookie but never the Strict session cookie.
  const callback = await call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(state)}`, { cookie: stateCookie });
  assert.equal(callback.status, 302, await callback.clone().text());
  assert.equal(callback.headers.get("location"), `${origin}/settings/integrations?authorized=google-calendar`);
  assert.equal(tokenRequests.length, 1);
  assert.equal(new URLSearchParams(tokenRequests[0]).get("redirect_uri"), `${origin}/api/admin/integrations/google-calendar/callback`);
  assert.ok(db.value<{ authorizedAt: string }>("SELECT authorized_at AS authorizedAt FROM google_calendar_authorizations")?.authorizedAt);
  assert.equal(db.value<{ actor: string }>("SELECT actor_user_id AS actor FROM audit_log WHERE action = 'google_calendar.authorized'")?.actor, "admin");
  assert.ok(callback.headers.getSetCookie().some((value) => value.startsWith("lancerlogin_calendar_oauth_state=;")));

  // The exemption covers the callback only; its siblings still require the workspace session.
  assert.equal((await call(env, "/admin/integrations/google-calendar/calendars")).status, 401);
  assert.equal((await call(env, "/admin/integrations/google-calendar/authorize")).status, 401);
  // Without a valid state the callback refuses before contacting Google.
  assert.equal((await call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(state)}`)).status, 400);
  const session = (await sessionFor("admin", "admin")).slice("lancerlogin_session=".length);
  assert.equal((await call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(session)}`, { cookie: `lancerlogin_calendar_oauth_state=${session}` })).status, 400, "a session token is not a Calendar state");
  const operatorState = await createSignedStateCodec(secret, "google_calendar_oauth").issue({ userId: "operator" });
  assert.equal((await call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(operatorState)}`, { cookie: `lancerlogin_calendar_oauth_state=${operatorState}` })).status, 403);
  assert.equal(tokenRequests.length, 1);
});

test("the Calendar OAuth state can never be used as a session, and a session can never be used as a state", async () => {
  const db = new Database(); const env = environment(db);
  const calendar = createSignedStateCodec(secret, "google_calendar_oauth");
  const state = await calendar.issue({ userId: "admin" });
  assert.equal(await createSessionCodec(secret).verify(state), undefined);
  assert.equal((await call(env, "/auth/session", { cookie: `lancerlogin_session=${state}` })).status, 401);
  assert.equal((await call(env, "/admin/users", { cookie: `lancerlogin_session=${state}` })).status, 401);
  assert.equal(await createSignedStateCodec(secret, "google_sign_in").verify(state), undefined, "purposes do not cross");
  const session = await createSessionCodec(secret).issue({ userId: "admin", role: "admin" });
  assert.equal(await calendar.verify(session), undefined);
  assert.equal((await call(env, "/auth/session", { cookie: `lancerlogin_session=${session}` })).status, 200);
});

test("parallel wrong passwords lock the account after exactly five failures and refuse further guesses", async () => {
  const db = new Database(); const env = environment(db);
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'admin'").run(await hashPassword("correct horse battery staple"));
  const existing = await sessionFor("admin", "admin");
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => call(env, "/auth/local", { body: { username: "admin", password: `wrong password ${index}` } })));
  assert.deepEqual(results.map((result) => result.status), Array(8).fill(401));
  const state = db.value<{ failures: number; lockedUntil: string | null; epoch: number }>("SELECT failed_login_count AS failures, locked_until AS lockedUntil, session_epoch AS epoch FROM users WHERE id = 'admin'")!;
  assert.equal(state.failures, 5, "every concurrent failure is counted, and none after the lock");
  assert.ok(state.lockedUntil && Date.parse(state.lockedUntil) > Date.now());
  assert.equal(state.epoch, 0, "a lock blocks new sign-ins but never revokes sessions, so guessing cannot sign the owner out");
  assert.equal((await call(env, "/auth/session", { cookie: existing })).status, 200);
  const correct = await call(env, "/auth/local", { body: { username: "admin", password: "correct horse battery staple" } });
  assert.equal(correct.status, 401);
  assert.equal(setCookie(correct, "lancerlogin_session"), undefined);

  // An Admin password reset clears the lock and revokes the account's sessions.
  db.sqlite.exec("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin-2','primary','second','admin','2026-10-18')");
  const reset = await call(env, "/admin/users/admin", { method: "PATCH", body: { localPassword: "a new correct horse battery" }, cookie: await sessionFor("admin-2", "admin") });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.deepEqual({ ...db.value("SELECT failed_login_count AS failures, locked_until AS lockedUntil, session_epoch AS epoch FROM users WHERE id = 'admin'") }, { failures: 0, lockedUntil: null, epoch: 1 });
  assert.equal((await call(env, "/auth/session", { cookie: existing })).status, 401, "the reset revokes the session the lock left alone");
  const login = await call(env, "/auth/local", { body: { username: "admin", password: "a new correct horse battery" } });
  assert.equal(login.status, 200);
  assert.equal((await call(env, "/auth/session", { cookie: setCookie(login, "lancerlogin_session") })).status, 200);
});

test("public authentication routes are throttled per client address without new bindings", async (context) => {
  quietErrors(context);
  const db = new Database(); const env = environment(db);
  const bootstrap = (ip: string) => call(env, "/setup/bootstrap", { body: { setupCode }, ip });
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await bootstrap("192.0.2.10")).status, 409);
  const limited = await bootstrap("192.0.2.10");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { code: string }).code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await bootstrap("192.0.2.11")).status, 409, "another client is unaffected");
  for (let attempt = 0; attempt < 20; attempt += 1) assert.notEqual((await call(env, "/kiosk/pair", { body: { code: "WRONG", kioskName: "Entrance" }, ip: "192.0.2.10" })).status, 429);
  assert.equal((await call(env, "/kiosk/pair", { body: { code: "WRONG", kioskName: "Entrance" }, ip: "192.0.2.10" })).status, 429);
  const rows = db.sqlite.prepare("SELECT bucket FROM auth_rate_limits").all() as Array<{ bucket: string }>;
  assert.equal(rows.length, 3);
  assert.equal(rows.some((row) => row.bucket.includes("192.0.2")), false, "no raw client address is stored");

  // The window resets, and the scheduled pass prunes old buckets.
  db.sqlite.exec("UPDATE auth_rate_limits SET window_start_ms = window_start_ms - 11 * 60000");
  assert.equal((await bootstrap("192.0.2.10")).status, 409);
  db.sqlite.exec("UPDATE auth_rate_limits SET window_start_ms = 0");
  await worker.scheduled({}, env);
  assert.equal(db.value<{ n: number }>("SELECT COUNT(*) AS n FROM auth_rate_limits")?.n, 0);
});

test("a setup code cannot claim the installation again after DELETE INSTALLATION, except from the deleting browser", async (context) => {
  quietErrors(context);
  const db = new Database(false); const env = environment(db, { APP_MODE: "unconfigured" });
  const input = { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "local", localUsername: "director", localPassword: "correct horse battery staple" };
  const first = await call(env, "/setup/bootstrap", { body: input });
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(db.value<{ n: number }>("SELECT COUNT(*) AS n FROM bootstrap_code_claims")?.n, 1);
  assert.equal(JSON.stringify(db.sqlite.prepare("SELECT * FROM bootstrap_code_claims").all()).includes(setupCodeHash), false, "the Worker secret value is not stored");
  const login = await call(env, "/auth/local", { body: { username: "director", password: "correct horse battery staple" } });
  const adminCookie = setCookie(login, "lancerlogin_session")!;

  const deleted = await call(env, "/admin/data", { method: "DELETE", body: { scope: "installation", confirmation: "DELETE INSTALLATION" }, cookie: adminCookie });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(db.value("SELECT id FROM installations"), undefined);
  const grant = setCookie(deleted, "lancerlogin_setup_reset")!;
  assert.ok(grant && grant.length > "lancerlogin_setup_reset=".length);
  assert.match(deleted.headers.getSetCookie().join("\n"), /lancerlogin_setup_reset=[^;]+; HttpOnly; Secure; SameSite=Strict/);

  // Someone else who still knows the original setup code cannot take the empty installation.
  const reused = await call(env, "/setup/bootstrap", { body: { ...input, localUsername: "intruder" } });
  assert.equal(reused.status, 409);
  assert.match((await reused.json() as { error: string }).error, /already used/);
  assert.equal(db.value("SELECT id FROM installations"), undefined);
  assert.equal((await call(env, "/setup/bootstrap", { body: input, cookie: "lancerlogin_setup_reset=forged" })).status, 409);

  // The deleting Admin's browser can run first-Admin setup again once, as the dashboard flow expects.
  const again = await call(env, "/setup/bootstrap", { body: input, cookie: grant });
  assert.equal(again.status, 201, await again.clone().text());
  assert.ok(again.headers.getSetCookie().some((value) => value.startsWith("lancerlogin_setup_reset=;")));
  assert.equal(db.value<{ n: number }>("SELECT COUNT(*) AS n FROM bootstrap_reset_grants")?.n, 0, "the grant is one-time");
  // Authority epochs survive deletion by design; the new installation continues them and its module platform works.
  assert.deepEqual({ ...db.value("SELECT a.revision AS administration, e.revision AS epoch FROM platform_module_administration a JOIN platform_module_administration_epochs e USING(installation_id)") }, { administration: 1, epoch: 1 });
  assert.equal(db.value<{ generation: number }>("SELECT m.generation FROM platform_modules m JOIN platform_module_epochs e USING(installation_id, module_id) WHERE m.module_id = 'attendance' AND e.generation = m.generation")?.generation, 2);
  const secondAdmin = setCookie(await call(env, "/auth/local", { body: { username: "director", password: "correct horse battery staple" } }), "lancerlogin_session");
  assert.equal((await call(env, "/platform/modules", { cookie: secondAdmin })).status, 200);

  // A rotated setup code works for anyone, and an installation created before claims existed is recorded on deletion.
  const rotated = "rotated synthetic setup code";
  const rotatedEnv = environment(db, { APP_MODE: "unconfigured", BOOTSTRAP_CODE_HASH: createHash("sha256").update(rotated).digest("base64url") });
  const relogin = await call(env, "/auth/local", { body: { username: "director", password: "correct horse battery staple" } });
  db.sqlite.exec("DELETE FROM bootstrap_code_claims");
  assert.equal((await call(rotatedEnv, "/admin/data", { method: "DELETE", body: { scope: "installation", confirmation: "DELETE INSTALLATION" }, cookie: setCookie(relogin, "lancerlogin_session") })).status, 200);
  assert.equal((await call(rotatedEnv, "/setup/bootstrap", { body: { ...input, setupCode: rotated } })).status, 409, "the code in use at deletion is now claimed");
  db.sqlite.exec("DELETE FROM bootstrap_code_claims");
  assert.equal((await call(env, "/setup/bootstrap", { body: input })).status, 201, "first install with an unused code still works");
});

test("logout, password reset and deactivation revoke sessions; tokens from before epochs stay valid", async () => {
  const db = new Database(); const env = environment(db);
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'operator'").run(await hashPassword("operator horse battery staple"));
  const legacy = await sessionFor("operator", "operator");
  assert.equal((await call(env, "/auth/session", { cookie: legacy })).status, 200, "a deploy does not sign anyone out");

  const login = await call(env, "/auth/local", { body: { username: "operator", password: "operator horse battery staple" } });
  const current = setCookie(login, "lancerlogin_session")!;
  const logout = await call(env, "/auth/logout", { method: "POST", body: {}, cookie: current });
  assert.equal(logout.status, 200);
  assert.equal(setCookie(logout, "lancerlogin_session"), "lancerlogin_session=");
  assert.equal((await call(env, "/auth/session", { cookie: current })).status, 401, "a copied token stops working after logout");
  assert.equal((await call(env, "/auth/session", { cookie: legacy })).status, 401);
  assert.equal(db.value<{ epoch: number }>("SELECT session_epoch AS epoch FROM users WHERE id = 'operator'")?.epoch, 1);
  assert.equal((await call(env, "/auth/logout", { method: "POST", body: {}, cookie: current })).status, 200, "logging out a revoked token is harmless");
  assert.equal(db.value<{ epoch: number }>("SELECT session_epoch AS epoch FROM users WHERE id = 'operator'")?.epoch, 1);

  const admin = await sessionFor("admin", "admin");
  const fresh = setCookie(await call(env, "/auth/local", { body: { username: "operator", password: "operator horse battery staple" } }), "lancerlogin_session")!;
  assert.equal((await call(env, "/auth/session", { cookie: fresh })).status, 200);
  assert.equal((await call(env, "/admin/users/operator", { method: "PATCH", body: { role: "operator" }, cookie: admin })).status, 200);
  assert.equal((await call(env, "/auth/session", { cookie: fresh })).status, 200, "an ordinary edit keeps sessions");
  assert.equal((await call(env, "/admin/users/operator", { method: "PATCH", body: { localPassword: "reset horse battery staple" }, cookie: admin })).status, 200);
  assert.equal((await call(env, "/auth/session", { cookie: fresh })).status, 401);

  const afterReset = setCookie(await call(env, "/auth/local", { body: { username: "operator", password: "reset horse battery staple" } }), "lancerlogin_session")!;
  assert.equal((await call(env, "/admin/users/operator", { method: "PATCH", body: { active: false }, cookie: admin })).status, 200);
  assert.equal((await call(env, "/admin/users/operator", { method: "PATCH", body: { active: true }, cookie: admin })).status, 200);
  assert.equal((await call(env, "/auth/session", { cookie: afterReset })).status, 401, "reactivation does not revive old sessions");
});

test("unexpected errors reach unauthenticated callers only as a correlation ID", async (context) => {
  const logged: string[] = [];
  context.mock.method(console, "error", (value: string) => { logged.push(value); });
  const failing = { prepare() { throw new Error("D1_ERROR: no such table: synthetic_internal_table"); }, async batch() { throw new Error("unreachable"); } } as unknown as D1Database;
  for (const mode of ["unconfigured", "configured"] as const) {
    const result = await call(environment(failing, { APP_MODE: mode }), "/setup/status");
    assert.equal(result.status, 500);
    const body = await result.json() as { error: string; details?: string[]; errorId?: string };
    assert.equal(body.error, "Request failed");
    assert.equal(body.details, undefined);
    assert.match(body.errorId ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(body).includes("synthetic_internal_table"), false);
    assert.ok(logged.some((line) => line.includes(body.errorId!) && line.includes("synthetic_internal_table")), "the message stays in Worker logs");
  }
});

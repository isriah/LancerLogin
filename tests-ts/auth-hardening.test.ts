// quick-check: covers apps/api/migrations/**
// Authentication hardening through the real Worker and real SQLite: the Google Calendar OAuth callback, purpose-bound
// OAuth state, atomic login lockout, public route throttling, one-time setup codes, session revocation and error hygiene.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec, createSignedStateCodec } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import type { D1Database } from "../apps/api/src/d1-usage.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";
import { legacyPassword, localSignIn, passwordCredential, randomKey, storedPassword } from "./fixtures/passwords.ts";

class Database extends TestD1Database {
  constructor(installation = true) {
    super({ seed: installation ? `INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled) VALUES('primary','2026-10-18','local',1);
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-10-18'),('operator','primary','operator','operator','2026-10-18');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','operator',0); INSERT INTO platform_module_assignment_revisions VALUES('primary','operator',0);
      INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','["attendance.manage"]');` : undefined });
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
/** Signs in the way the dashboard does: the salt endpoint, then K. */
const signIn = (env: Env, username: string, password: string, ip?: string) => localSignIn((path, body) => call(env, path, { body, ip }), username, password);
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
  assert.equal((await call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(state)}`)).headers.get("location"), `${origin}/settings/integrations?integrationError=google_calendar&message=${encodeURIComponent("Google Calendar authorization state is invalid or expired")}`);
  const session = (await sessionFor("admin", "admin")).slice("lancerlogin_session=".length);
  assert.equal((await call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(session)}`, { cookie: `lancerlogin_calendar_oauth_state=${session}` })).headers.get("location"), `${origin}/settings/integrations?integrationError=google_calendar&message=${encodeURIComponent("Google Calendar authorization state is invalid or expired")}`, "a session token is not a Calendar state");
  const operatorState = await createSignedStateCodec(secret, "google_calendar_oauth").issue({ userId: "operator" });
  assert.equal((await call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(operatorState)}`, { cookie: `lancerlogin_calendar_oauth_state=${operatorState}` })).headers.get("location"), `${origin}/settings/integrations?integrationError=google_calendar&message=${encodeURIComponent("Only an active Admin can authorize Google Calendar")}`);
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
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'admin'").run(await storedPassword("correct horse battery staple"));
  const existing = await sessionFor("admin", "admin");
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => call(env, "/auth/local", { body: { username: "admin", key: randomKey() } })));
  assert.deepEqual(results.map((result) => result.status), Array(8).fill(401));
  const state = db.value<{ failures: number; lockedUntil: string | null; epoch: number }>("SELECT failed_login_count AS failures, locked_until AS lockedUntil, session_epoch AS epoch FROM users WHERE id = 'admin'")!;
  assert.equal(state.failures, 5, "every concurrent failure is counted, and none after the lock");
  assert.ok(state.lockedUntil && Date.parse(state.lockedUntil) > Date.now());
  assert.equal(state.epoch, 0, "a lock blocks new sign-ins but never revokes sessions, so guessing cannot sign the owner out");
  assert.equal((await call(env, "/auth/session", { cookie: existing })).status, 200);
  const correct = await signIn(env, "admin", "correct horse battery staple");
  assert.equal(correct.status, 401);
  assert.equal(setCookie(correct, "lancerlogin_session"), undefined);

  // An Admin password reset clears the lock and revokes the account's sessions.
  db.sqlite.exec("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin-2','primary','second','admin','2026-10-18')");
  const reset = await call(env, "/admin/users/admin", { method: "PATCH", body: { localPasswordKey: await passwordCredential("a new correct horse battery") }, cookie: await sessionFor("admin-2", "admin") });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.deepEqual({ ...db.value("SELECT failed_login_count AS failures, locked_until AS lockedUntil, session_epoch AS epoch FROM users WHERE id = 'admin'") }, { failures: 0, lockedUntil: null, epoch: 1 });
  assert.equal((await call(env, "/auth/session", { cookie: existing })).status, 401, "the reset revokes the session the lock left alone");
  const login = await signIn(env, "admin", "a new correct horse battery");
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
  const input = { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "local", localUsername: "director", localPasswordKey: await passwordCredential("correct horse battery staple") };
  const first = await call(env, "/setup/bootstrap", { body: input });
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(db.value<{ n: number }>("SELECT COUNT(*) AS n FROM bootstrap_code_claims")?.n, 1);
  assert.equal(JSON.stringify(db.sqlite.prepare("SELECT * FROM bootstrap_code_claims").all()).includes(setupCodeHash), false, "the Worker secret value is not stored");
  const login = await signIn(env, "director", "correct horse battery staple");
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
  assert.ok(setCookie(again, "lancerlogin_session"), "clearing the reset grant does not replace the new Admin's session cookie");
  assert.equal(db.value<{ n: number }>("SELECT COUNT(*) AS n FROM bootstrap_reset_grants")?.n, 0, "the grant is one-time");
  // Authority epochs survive deletion by design; the new installation continues them and its module platform works.
  assert.deepEqual({ ...db.value("SELECT a.revision AS administration, e.revision AS epoch FROM platform_module_administration a JOIN platform_module_administration_epochs e USING(installation_id)") }, { administration: 1, epoch: 1 });
  assert.equal(db.value<{ generation: number }>("SELECT m.generation FROM platform_modules m JOIN platform_module_epochs e USING(installation_id, module_id) WHERE m.module_id = 'attendance' AND e.generation = m.generation")?.generation, 2);
  const secondAdmin = setCookie(await signIn(env, "director", "correct horse battery staple"), "lancerlogin_session");
  assert.equal((await call(env, "/platform/modules", { cookie: secondAdmin })).status, 200);

  // A rotated setup code works for anyone, and an installation created before claims existed is recorded on deletion.
  const rotated = "rotated synthetic setup code";
  const rotatedEnv = environment(db, { APP_MODE: "unconfigured", BOOTSTRAP_CODE_HASH: createHash("sha256").update(rotated).digest("base64url") });
  const relogin = await signIn(env, "director", "correct horse battery staple");
  db.sqlite.exec("DELETE FROM bootstrap_code_claims");
  assert.equal((await call(rotatedEnv, "/admin/data", { method: "DELETE", body: { scope: "installation", confirmation: "DELETE INSTALLATION" }, cookie: setCookie(relogin, "lancerlogin_session") })).status, 200);
  assert.equal((await call(rotatedEnv, "/setup/bootstrap", { body: { ...input, setupCode: rotated } })).status, 409, "the code in use at deletion is now claimed");
  db.sqlite.exec("DELETE FROM bootstrap_code_claims");
  assert.equal((await call(env, "/setup/bootstrap", { body: input })).status, 201, "first install with an unused code still works");
});

test("first-Admin setup with a local password signs the Admin in with the local sign-in session cookie", async (context) => {
  quietErrors(context);
  const db = new Database(false); const env = environment(db, { APP_MODE: "unconfigured" });
  const input = { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "local", localUsername: "director", localPasswordKey: await passwordCredential("correct horse battery staple") };
  const created = await call(env, "/setup/bootstrap", { body: input });
  assert.equal(created.status, 201, await created.clone().text());
  const body = await created.json() as { signedIn: boolean; user?: { id: string; role: string }; admin: { id: string } };
  assert.equal(body.signedIn, true);
  assert.deepEqual(body.user, { id: body.admin.id, role: "admin" });
  const [issued, ...others] = created.headers.getSetCookie();
  assert.equal(others.length, 0, "a first setup without a reset grant sets only the session cookie");
  assert.match(issued!, /^lancerlogin_session=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
  // The same cookie attributes as /auth/local, so first setup grants no weaker or longer-lived session than signing in.
  const login = await signIn(env, "director", "correct horse battery staple");
  assert.equal(login.status, 200);
  const attributes = (value: string) => value.split(";").slice(1).map((part) => part.trim());
  assert.deepEqual(attributes(issued!), attributes(login.headers.getSetCookie()[0]!));
  const session = await call(env, "/auth/session", { cookie: setCookie(created, "lancerlogin_session") });
  assert.equal(session.status, 200);
  assert.equal((await session.json() as { user: { id: string; role: string } }).user.role, "admin");
  // The setup session follows the same revocation as a sign-in session.
  assert.equal((await call(env, "/auth/logout", { body: {}, cookie: setCookie(created, "lancerlogin_session") })).status, 200);
  assert.equal((await call(env, "/auth/session", { cookie: setCookie(created, "lancerlogin_session") })).status, 401);
});

test("first-Admin setup stores the release colors, or the development colors when DEFAULT_THEME is development", async (context) => {
  quietErrors(context);
  const input = { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "local", localUsername: "director", localPasswordKey: await passwordCredential("correct horse battery staple") };
  for (const [extra, expected] of [
    [{}, { primaryColor: "#b80100", secondaryColor: "#eeb822" }],
    [{ DEFAULT_THEME: "production" }, { primaryColor: "#b80100", secondaryColor: "#eeb822" }],
    [{ DEFAULT_THEME: "development" }, { primaryColor: "#7c3aed", secondaryColor: "#0f766e" }],
  ] as const) {
    const db = new Database(false); const env = environment(db, { APP_MODE: "unconfigured", ...extra });
    const before = await (await call(env, "/setup/status")).json() as { configured: boolean; defaultTheme: { primary: string; secondary: string } };
    assert.deepEqual(before, { configured: false, defaultTheme: { primary: expected.primaryColor, secondary: expected.secondaryColor } });
    const created = await call(env, "/setup/bootstrap", { body: input });
    assert.equal(created.status, 201, await created.clone().text());
    assert.deepEqual({ ...db.value<{ primaryColor: string; secondaryColor: string }>("SELECT primary_color AS primaryColor, secondary_color AS secondaryColor FROM organization_settings WHERE installation_id = 'primary'") }, expected);
    const status = await (await call(env, "/setup/status")).json() as { settings: { primaryColor: string; secondaryColor: string }; defaultTheme: { primary: string } };
    assert.equal(status.settings.primaryColor, expected.primaryColor);
    assert.equal(status.settings.secondaryColor, expected.secondaryColor);
    assert.equal(status.defaultTheme.primary, expected.primaryColor);
  }
});

test("first-Admin setup issues no session for Google-only setup or a Worker without a session key", async (context) => {
  quietErrors(context);
  const google = new Database(false);
  const googleSetup = await call(environment(google, { APP_MODE: "unconfigured" }), "/setup/bootstrap", { body: { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "google", adminEmail: "admin@example.test", googleClientId: "synthetic-client", googleClientSecret: "synthetic-secret" } });
  assert.equal(googleSetup.status, 201, await googleSetup.clone().text());
  assert.equal((await googleSetup.json() as { signedIn: boolean }).signedIn, false);
  assert.equal(setCookie(googleSetup, "lancerlogin_session"), undefined);

  const keyless = new Database(false);
  const keylessSetup = await call(environment(keyless, { APP_MODE: "unconfigured", SESSION_KEY: undefined }), "/setup/bootstrap", { body: { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "local", localUsername: "director", localPasswordKey: await passwordCredential("correct horse battery staple") } });
  assert.equal(keylessSetup.status, 201, await keylessSetup.clone().text());
  assert.equal((await keylessSetup.json() as { signedIn: boolean }).signedIn, false);
  assert.equal(setCookie(keylessSetup, "lancerlogin_session"), undefined);
});

test("logout, password reset and deactivation revoke sessions; tokens from before epochs stay valid", async () => {
  const db = new Database(); const env = environment(db);
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'operator'").run(await storedPassword("operator horse battery staple"));
  const legacy = await sessionFor("operator", "operator");
  assert.equal((await call(env, "/auth/session", { cookie: legacy })).status, 200, "a deploy does not sign anyone out");

  const login = await signIn(env, "operator", "operator horse battery staple");
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
  const fresh = setCookie(await signIn(env, "operator", "operator horse battery staple"), "lancerlogin_session")!;
  assert.equal((await call(env, "/auth/session", { cookie: fresh })).status, 200);
  assert.equal((await call(env, "/admin/users/operator", { method: "PATCH", body: { role: "operator" }, cookie: admin })).status, 200);
  assert.equal((await call(env, "/auth/session", { cookie: fresh })).status, 200, "an ordinary edit keeps sessions");
  assert.equal((await call(env, "/admin/users/operator", { method: "PATCH", body: { localPasswordKey: await passwordCredential("reset horse battery staple") }, cookie: admin })).status, 200);
  assert.equal((await call(env, "/auth/session", { cookie: fresh })).status, 401);

  const afterReset = setCookie(await signIn(env, "operator", "reset horse battery staple"), "lancerlogin_session")!;
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

// Server relief: the browser runs scrypt and the Worker stores and compares only SHA-256(label + K).

test("sign-in end to end stores scrypt-c, never sees the password, and refuses an outdated tab's plain password", async (context) => {
  quietErrors(context);
  const db = new Database(false); const env = environment(db, { APP_MODE: "unconfigured" });
  const created = await call(env, "/setup/bootstrap", { body: { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "local", localUsername: "director", localPasswordKey: await passwordCredential("correct horse battery staple") } });
  assert.equal(created.status, 201, await created.clone().text());
  const stored = db.value<{ hash: string }>("SELECT password_hash AS hash FROM users WHERE local_username = 'director'")!.hash;
  assert.match(stored, /^scrypt-c\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);

  const posted: string[] = [];
  const recordingSignIn = (username: string, password: string) => localSignIn(async (path, body) => { posted.push(JSON.stringify(body)); return call(env, path, { body }); }, username, password);
  const login = await recordingSignIn("Director", "correct horse battery staple");
  assert.equal(login.status, 200, await login.clone().text());
  assert.ok(setCookie(login, "lancerlogin_session"));
  assert.equal(posted.some((body) => body.includes("correct horse battery staple")), false, "a scrypt-c account never sends its password");
  assert.equal((await recordingSignIn("director", "incorrect horse battery staple")).status, 401);
  assert.equal(db.value<{ hash: string }>("SELECT password_hash AS hash FROM users WHERE local_username = 'director'")!.hash, stored, "sign-in never rewrites a scrypt-c row");

  // A tab loaded before the update posts the plain password. The Worker asks for a reload and runs no scrypt on it.
  for (const [path, body] of [["/auth/local", { username: "director", password: "correct horse battery staple" }]] as const) {
    const stale = await call(env, path, { body });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, "reload_required");
  }
  assert.equal(db.value<{ failures: number }>("SELECT failed_login_count AS failures FROM users WHERE local_username = 'director'")?.failures, 1, "only the wrong K counted, not the outdated request");
  for (const body of [{ username: "director" }, { username: "director", key: "short" }, { username: "director", key: randomKey().slice(0, -1) }])
    assert.equal((await call(env, "/auth/local", { body })).status, 400, JSON.stringify(body));
});

test("the salt endpoint answers unknown, inactive and Google-only usernames with the same shape and a deterministic fake salt", async () => {
  const db = new Database(); const env = environment(db);
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'admin'").run(await storedPassword("correct horse battery staple"));
  db.sqlite.exec(`INSERT INTO users(id,installation_id,email,local_username,role,created_at) VALUES('google','primary','google@example.test','googleonly','operator','2026-10-18');
    INSERT INTO users(id,installation_id,local_username,role,active,created_at) VALUES('gone','primary','gone','operator',0,'2026-10-18')`);
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'gone'").run(await storedPassword("inactive horse battery staple"));
  const params = async (username: string) => { const result = await call(env, "/auth/local/params", { body: { username } }); assert.equal(result.status, 200, username); return result.json() as Promise<Record<string, unknown>>; };
  const real = await params("admin");
  const stored = db.value<{ hash: string }>("SELECT password_hash AS hash FROM users WHERE id = 'admin'")!.hash;
  assert.deepEqual(real, { algorithm: "scrypt", N: 32768, r: 8, p: 1, dkLen: 32, salt: stored.split("$")[4], legacy: false });
  for (const username of ["nobody", "googleonly", "gone"]) {
    const fake = await params(username);
    assert.deepEqual(Object.keys(fake), Object.keys(real), username);
    assert.deepEqual({ ...fake, salt: "" }, { ...real, salt: "" }, username);
    assert.match(String(fake.salt), /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(await params(username), fake, "the fake salt is the same on every request");
    assert.notEqual(fake.salt, real.salt);
  }
  assert.notEqual((await params("nobody")).salt, (await params("somebody")).salt);
  assert.deepEqual(await params("  NoBody "), await params("nobody"), "usernames are normalized as sign-in normalizes them");
  // An unknown username's sign-in fails the same way a wrong K does, and counts against nobody.
  assert.equal((await signIn(env, "nobody", "correct horse battery staple")).status, 401);
  assert.equal((await signIn(env, "googleonly", "correct horse battery staple")).status, 401);
  assert.equal(db.value<{ failures: number }>("SELECT failed_login_count AS failures FROM users WHERE id = 'google'")?.failures, 1);
  for (const body of [{}, { username: "" }, { username: 7 }, { username: "x".repeat(257) }]) assert.equal((await call(env, "/auth/local/params", { body })).status, 400, JSON.stringify(body));
  // The salt endpoint shares the sign-in throttle's limits, per client address.
  for (let attempt = 0; attempt < 30; attempt += 1) await call(env, "/auth/local/params", { body: { username: "nobody" }, ip: "192.0.2.50" });
  assert.equal((await call(env, "/auth/local/params", { body: { username: "nobody" }, ip: "192.0.2.50" })).status, 429);
  assert.equal((await call(env, "/auth/local/params", { body: { username: "nobody" }, ip: "192.0.2.51" })).status, 200);
});

test("a legacy scrypt$ row is checked with the password once, re-salted to scrypt-c, and never converted without it", async () => {
  const db = new Database(); const env = environment(db);
  const legacy = await legacyPassword("legacy horse battery staple");
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'admin'").run(legacy);
  const row = () => db.value<{ hash: string; failures: number }>("SELECT password_hash AS hash, failed_login_count AS failures FROM users WHERE id = 'admin'")!;
  const params = await (await call(env, "/auth/local/params", { body: { username: "admin" } })).json() as { salt: string; legacy: boolean };
  assert.equal(params.legacy, true, "the accepted migration leak: a legacy row says so");
  assert.notEqual(params.salt, legacy.split("$")[4], "a legacy row gets a fresh salt for its new K");
  // The old K alone, as a leaked pre-update backup would hold it, never signs in, and the row stays legacy.
  const oldKey = legacy.split("$")[5];
  assert.equal((await call(env, "/auth/local", { body: { username: "admin", key: oldKey } })).status, 401);
  assert.equal((await call(env, "/auth/local", { body: { username: "admin", key: oldKey, salt: legacy.split("$")[4] } })).status, 401);
  assert.equal(row().hash, legacy);
  // A wrong password with a legacy proof is a normal failure and converts nothing.
  assert.equal((await signIn(env, "admin", "wrong horse battery staple")).status, 401);
  assert.deepEqual({ ...row() }, { hash: legacy, failures: 3 });
  // The right password converts the row to scrypt-c under the new salt and clears the failures.
  const upgraded = await signIn(env, "admin", "legacy horse battery staple");
  assert.equal(upgraded.status, 200, await upgraded.clone().text());
  assert.match(row().hash, /^scrypt-c\$32768\$8\$1\$/);
  assert.equal(row().failures, 0);
  const after = await (await call(env, "/auth/local/params", { body: { username: "admin" } })).json() as { salt: string; legacy: boolean };
  assert.deepEqual([after.legacy, after.salt], [false, row().hash.split("$")[4]]);
  // From now on the old K is worthless and the password is never sent again.
  assert.equal((await call(env, "/auth/local", { body: { username: "admin", key: oldKey } })).status, 401);
  assert.equal((await signIn(env, "admin", "legacy horse battery staple")).status, 200);
});

test("a wrong new K sent with the right legacy password locks out only that account", async () => {
  const db = new Database(); const env = environment(db);
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'admin'").run(await legacyPassword("legacy horse battery staple"));
  db.sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = 'operator'").run(await legacyPassword("operator horse battery staple"));
  const params = await (await call(env, "/auth/local/params", { body: { username: "admin" } })).json() as { salt: string };
  const forged = await call(env, "/auth/local", { body: { username: "admin", key: randomKey(), salt: params.salt, password: "legacy horse battery staple" } });
  assert.equal(forged.status, 200, "the password check is what authenticates, so the request itself succeeds");
  assert.equal((await signIn(env, "admin", "legacy horse battery staple")).status, 401, "the account now holds a K nobody can derive");
  assert.equal((await signIn(env, "operator", "operator horse battery staple")).status, 200, "other accounts are unaffected");
});

test("the account lock is checked before any work, including a legacy row's server-side scrypt", async (context) => {
  const db = new Database(); const env = environment(db);
  const legacy = await legacyPassword("legacy horse battery staple");
  db.sqlite.prepare("UPDATE users SET password_hash = ?, locked_until = ? WHERE id = 'admin'").run(legacy, new Date(Date.now() + 60_000).toISOString());
  const params = await (await call(env, "/auth/local/params", { body: { username: "admin" } })).json() as { salt: string };
  const digest = context.mock.method(crypto.subtle, "digest");
  const locked = await call(env, "/auth/local", { body: { username: "admin", key: randomKey(), salt: params.salt, password: "legacy horse battery staple" } });
  assert.equal(locked.status, 401);
  assert.equal(db.value<{ hash: string }>("SELECT password_hash AS hash FROM users WHERE id = 'admin'")!.hash, legacy);
  const comparisons = () => digest.mock.calls.filter((call) => new Uint8Array(call.arguments[1] as ArrayBuffer).length === "lancerlogin:password:v2".length + 32).length;
  assert.equal(comparisons(), 0, "no password work ran");
  // The same request once the lock has expired does the work, which shows the probe above would have seen it.
  db.sqlite.exec("UPDATE users SET locked_until = NULL WHERE id = 'admin'");
  assert.equal((await call(env, "/auth/local", { body: { username: "admin", key: randomKey(), salt: params.salt, password: "legacy horse battery staple" } })).status, 200);
  assert.ok(comparisons() > 0);
});

test("every password setter stores scrypt-c and refuses a plain password", async (context) => {
  quietErrors(context);
  const db = new Database(); const env = environment(db);
  const admin = await sessionFor("admin", "admin");
  const hash = (id: string) => db.value<{ hash: string | null }>("SELECT password_hash AS hash FROM users WHERE id = ?", id)?.hash;
  const created = await call(env, "/admin/users", { body: { localUsername: "front-desk", localPasswordKey: await passwordCredential("front desk horse battery"), role: "operator" }, cookie: admin });
  assert.equal(created.status, 201, await created.clone().text());
  const createdId = (await created.json() as { user: { id: string } }).user.id;
  assert.match(hash(createdId)!, /^scrypt-c\$/);
  assert.equal((await signIn(env, "front-desk", "front desk horse battery")).status, 200);
  const reset = await call(env, `/admin/users/${createdId}`, { method: "PATCH", body: { localPasswordKey: await passwordCredential("reset desk horse battery") }, cookie: admin });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.match(hash(createdId)!, /^scrypt-c\$/);
  assert.equal((await signIn(env, "front-desk", "reset desk horse battery")).status, 200);
  assert.equal(db.value<{ metadata: string }>("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'user.updated' ORDER BY created_at DESC LIMIT 1")?.metadata.includes('"passwordReset":true'), true);

  // Outdated tabs that post localPassword get a reload request; malformed credentials are refused with the old messages.
  for (const [path, method, body] of [
    ["/admin/users", "POST", { localUsername: "stale-desk", localPassword: "stale desk horse battery", role: "operator" }],
    [`/admin/users/${createdId}`, "PATCH", { localPassword: "stale desk horse battery" }],
  ] as const) {
    const stale = await call(env, path, { method, body, cookie: admin });
    assert.equal(stale.status, 409, path);
    assert.equal((await stale.json() as { code: string }).code, "reload_required");
  }
  for (const localPasswordKey of [{}, { salt: "AAAA", key: randomKey() }, { salt: "AAAAAAAAAAAAAAAAAAAAAA", key: randomKey(), password: "extra" }, "text"]) {
    const result = await call(env, "/admin/users", { body: { localUsername: "bad-desk", localPasswordKey, role: "operator" }, cookie: admin });
    assert.equal(result.status, 400);
    assert.match((await result.json() as { error: string }).error, /at least 12 characters/);
    assert.equal((await call(env, `/admin/users/${createdId}`, { method: "PATCH", body: { localPasswordKey }, cookie: admin })).status, 400);
  }
  assert.match(hash(createdId)!, /^scrypt-c\$/);

  // First-Admin setup: the same format, and the same reload request for an outdated setup page.
  const fresh = new Database(false); const setupEnv = environment(fresh, { APP_MODE: "unconfigured" });
  const base = { setupCode, organizationName: "Synthetic Club", timeZone: "UTC", authMode: "local", localUsername: "director" };
  const staleSetup = await call(setupEnv, "/setup/bootstrap", { body: { ...base, localPassword: "correct horse battery staple" } });
  assert.equal(staleSetup.status, 409);
  assert.equal((await staleSetup.json() as { code: string }).code, "reload_required");
  const badSetup = await call(setupEnv, "/setup/bootstrap", { body: { ...base, localPasswordKey: { salt: "AAAAAAAAAAAAAAAAAAAAAA" } } });
  assert.equal(badSetup.status, 400);
  assert.equal((await call(setupEnv, "/setup/bootstrap", { body: { ...base, localPasswordKey: await passwordCredential("correct horse battery staple") } })).status, 201);
  assert.match(fresh.value<{ hash: string }>("SELECT password_hash AS hash FROM users WHERE local_username = 'director'")!.hash, /^scrypt-c\$/);
});

// Integration setup through the real Worker and real SQLite: Google emails on users, the exact URLs status reports, loopback
// previews, Admin-only Google verification, friendly OAuth errors, Calendar scopes and re-authorization, and Resend error text.
// Every person, address and credential here is synthetic.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration, decryptIntegration } from "../apps/api/src/integration-crypto.ts";
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
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled) VALUES('primary','2026-10-18','both',1);
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,email,local_username,role,created_at) VALUES('admin','primary','test.admin.a@example.test','admin','admin','2026-10-18'),('operator','primary','test.operator.b@example.test',NULL,'operator','2026-10-18'),('local','primary',NULL,'local-op','operator','2026-10-18');
      INSERT INTO platform_module_administration VALUES('primary',0,1); INSERT INTO platform_module_administration_epochs VALUES('primary',0);
      INSERT INTO platform_module_epochs VALUES('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete,deletion_cursor) VALUES('primary','attendance',1,1,'enabled',2,1,0);`);
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
const environment = (db: D1Database, allowedOrigin = origin) => ({ APP_MODE: "configured", ALLOWED_ORIGIN: allowedOrigin, SESSION_KEY: secret, INTEGRATION_KEY: secret, DB: db }) as Env;
const sessionFor = async (userId: string, role: "admin" | "operator") => `lancerlogin_session=${await createSessionCodec(secret).issue({ userId, role })}`;
function call(env: Env, path: string, options: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: env.ALLOWED_ORIGIN };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  return worker.fetch(new Request(`https://api.example.test${path}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), env);
}
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]!).filter((value) => !value.endsWith("=")).join("; ");
const errorLocation = (allowedOrigin: string, provider: string, message: string) => `${allowedOrigin}/settings/integrations?integrationError=${provider}&message=${encodeURIComponent(message)}`;
const quietErrors = (context: TestContext) => context.mock.method(console, "error", () => {});
async function saveIntegration(db: Database, provider: "google" | "resend" | "discord", value: Record<string, string>, verified = false) {
  const encrypted = await encryptIntegration(value, secret);
  db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES(?, 'primary', ?, ?, ?, ?, '2026-10-18')").run(`${provider}-1`, provider, encrypted.ciphertext, encrypted.iv, verified ? "2026-10-18" : null);
  db.sqlite.exec(`UPDATE installations SET ${provider}_enabled = 1 WHERE id = 'primary'`);
}
async function saveCalendar(db: Database, value: Record<string, string>, authorized = false, verified = false) {
  const encrypted = await encryptIntegration(value, secret);
  db.sqlite.prepare("INSERT INTO google_calendar_authorizations(installation_id,ciphertext,iv,authorized_at,verified_at,updated_at) VALUES('primary',?,?,?,?,'2026-10-18')").run(encrypted.ciphertext, encrypted.iv, authorized ? "2026-10-18" : null, verified ? "2026-10-18" : null);
}
async function status(env: Env) {
  const result = await call(env, "/admin/integrations", { cookie: await sessionFor("admin", "admin") });
  assert.equal(result.status, 200, await result.clone().text());
  const body = await result.json() as { integrations: Array<Record<string, unknown>> };
  return Object.fromEntries(body.integrations.map((item) => [item.provider as string, item]));
}

test("an Admin can add, change and remove a user's Google email with duplicate and sign-in guards", async () => {
  const db = new Database(); const env = environment(db); const admin = await sessionFor("admin", "admin");
  const added = await call(env, "/admin/users/local", { method: "PATCH", body: { email: "  Test.Student.A@Example.TEST " }, cookie: admin });
  assert.equal(added.status, 200, await added.clone().text());
  const body = await added.json() as { ok: boolean; user: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.deepEqual({ id: body.user.id, email: body.user.email, localUsername: body.user.localUsername, role: body.user.role, active: body.user.active }, { id: "local", email: "test.student.a@example.test", localUsername: "local-op", role: "operator", active: true });
  const audit = JSON.parse(db.value<{ metadata: string }>("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'user.updated' AND target_id = 'local'")!.metadata);
  assert.equal(audit.emailChanged, true); assert.equal(audit.hasGoogle, true); assert.equal(JSON.stringify(audit).includes("example.test"), false, "the audit records the change, not the address");

  const duplicate = await call(env, "/admin/users/local", { method: "PATCH", body: { email: "TEST.OPERATOR.B@example.test" }, cookie: admin });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json() as { error: string }).error, "That email is already in use");
  assert.equal((await call(env, "/admin/users/local", { method: "PATCH", body: { email: "not-an-email" }, cookie: admin })).status, 400);
  assert.equal((await call(env, "/admin/users/local", { method: "PATCH", body: { email: 42 }, cookie: admin })).status, 400);
  // Re-saving the user's own address is not a duplicate.
  assert.equal((await call(env, "/admin/users/local", { method: "PATCH", body: { email: "test.student.a@example.test" }, cookie: admin })).status, 200);

  const googleOnly = await call(env, "/admin/users/operator", { method: "PATCH", body: { email: null }, cookie: admin });
  assert.equal(googleOnly.status, 400); assert.equal((await googleOnly.json() as { error: string }).error, "A user needs a Google email or a local username");
  assert.equal((await call(env, "/admin/users/operator", { method: "PATCH", body: { email: "" }, cookie: admin })).status, 400);
  assert.equal(db.value<{ email: string }>("SELECT email FROM users WHERE id = 'operator'")?.email, "test.operator.b@example.test");

  const removed = await call(env, "/admin/users/local", { method: "PATCH", body: { email: null }, cookie: admin });
  assert.equal(removed.status, 200); assert.equal((await removed.json() as { user: { email: unknown } }).user.email, null);
  assert.equal(db.value<{ email: string | null }>("SELECT email FROM users WHERE id = 'local'")?.email, null);
  assert.equal((await call(env, "/admin/users/local", { method: "PATCH", body: { email: "x@example.test" }, cookie: await sessionFor("operator", "operator") })).status, 403);
});

test("integration status reports the exact redirect and interactions URLs, and omits them for an unusable origin", async () => {
  const db = new Database(); await saveIntegration(db, "discord", { applicationId: "1", botToken: "synthetic", publicKey: "0".repeat(64), guildId: "1".repeat(18), channelId: "2".repeat(18) });
  const configured = await status(environment(db));
  assert.equal(configured.google!.redirectUri, `${origin}/api/auth/google/callback`);
  assert.equal(configured.google_calendar!.redirectUri, `${origin}/api/admin/integrations/google-calendar/callback`);
  assert.equal(configured.discord!.interactionsUrl, `${origin}/api/discord/interactions`);
  assert.equal(configured.resend!.redirectUri, undefined);

  const local = await status(environment(db, "http://localhost:5183"));
  assert.equal(local.google!.redirectUri, "http://localhost:5183/api/auth/google/callback");
  assert.equal(local.google_calendar!.redirectUri, "http://localhost:5183/api/admin/integrations/google-calendar/callback");

  for (const invalid of ["http://dashboard.example.test", "https://dashboard.example.test/path"]) {
    const unusable = await status(environment(db, invalid));
    assert.equal("redirectUri" in unusable.google!, false, invalid); assert.equal("redirectUri" in unusable.google_calendar!, false, invalid); assert.equal("interactionsUrl" in unusable.discord!, false, invalid);
  }
});

test("OAuth redirect URIs accept http only for loopback previews", async (context) => {
  quietErrors(context);
  const db = new Database(); await saveCalendar(db, { clientId: "calendar-client", clientSecret: "calendar-secret" });
  for (const allowed of ["http://localhost:5183", "http://127.0.0.1:8787", "http://[::1]:5173", "https://dashboard.example.test"]) {
    const started = await call(environment(db, allowed), "/admin/integrations/google-calendar/authorize", { cookie: await sessionFor("admin", "admin") });
    assert.equal(started.status, 302, allowed);
    assert.equal(new URL(started.headers.get("location")!).searchParams.get("redirect_uri"), `${allowed}/api/admin/integrations/google-calendar/callback`);
  }
  for (const refused of ["http://dashboard.example.test", "http://localhost.example.test", "http://192.168.1.20:5183"]) {
    const started = await call(environment(db, refused), "/admin/integrations/google-calendar/authorize", { cookie: await sessionFor("admin", "admin") });
    assert.equal(started.status, 503, refused);
  }
});

function mockGoogleSignIn(context: TestContext, email: string) {
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) === "https://oauth2.googleapis.com/token") return Response.json({ id_token: "synthetic-id-token" });
    return Response.json({ aud: "google-client", email, email_verified: "true", iss: "https://accounts.google.com" });
  });
}
async function startGoogle(env: Env, cookie: string, verify: boolean) {
  const started = await call(env, `/auth/google/start${verify ? "?verify=1" : ""}`, { cookie });
  assert.equal(started.status, 302, await started.clone().text());
  return { state: new URL(started.headers.get("location")!).searchParams.get("state")!, cookie: cookies(started) };
}

test("only an Admin can verify Google, an Operator still signs in, and verification errors return to Integrations", async (context) => {
  const db = new Database(); const env = environment(db); await saveIntegration(db, "google", { clientId: "google-client", clientSecret: "google-secret" });
  const verifiedAt = () => db.value<{ verifiedAt: string | null }>("SELECT verified_at AS verifiedAt FROM encrypted_integrations WHERE provider = 'google'")?.verifiedAt;

  // An Admin starts verification but returns with the Operator's Google account.
  const operatorVerify = await startGoogle(env, await sessionFor("admin", "admin"), true);
  mockGoogleSignIn(context, "test.operator.b@example.test");
  const refused = await call(env, `/auth/google/callback?code=one-time&state=${encodeURIComponent(operatorVerify.state)}`, { cookie: operatorVerify.cookie });
  assert.equal(refused.status, 302);
  assert.equal(refused.headers.get("location"), errorLocation(origin, "google", "Verify Google with an active Admin account whose LancerLogin email matches this Google account."));
  assert.equal(refused.headers.getSetCookie().some((value) => value.startsWith("lancerlogin_session=")), false, "a refused verification issues no session");
  assert.equal(verifiedAt(), null);

  // An unknown Google account in the verification flow gets the same Admin guidance.
  const unknownVerify = await startGoogle(env, await sessionFor("admin", "admin"), true);
  context.mock.restoreAll(); mockGoogleSignIn(context, "test.stranger.c@example.test");
  const unknown = await call(env, `/auth/google/callback?code=one-time&state=${encodeURIComponent(unknownVerify.state)}`, { cookie: unknownVerify.cookie });
  assert.equal(unknown.headers.get("location"), errorLocation(origin, "google", "Verify Google with an active Admin account whose LancerLogin email matches this Google account."));

  // A cancelled consent screen and a bad state are friendly too.
  const cancelled = await call(env, "/auth/google/callback?error=access_denied", { cookie: "lancerlogin_oauth_verify=1" });
  assert.equal(cancelled.headers.get("location"), errorLocation(origin, "google", "Google sign-in was cancelled or denied. Try verifying Google again."));
  const badState = await call(env, "/auth/google/callback?code=one-time&state=forged", { cookie: "lancerlogin_oauth_verify=1; lancerlogin_oauth_state=forged" });
  assert.equal(badState.headers.get("location"), errorLocation(origin, "google", "Google sign-in state is invalid or expired"));

  // Normal sign-in keeps JSON errors and still lets an Operator in, without verifying the integration.
  assert.equal((await call(env, "/auth/google/callback?code=one-time&state=forged", { cookie: "lancerlogin_oauth_state=forged" })).status, 400);
  const operatorSignIn = await startGoogle(env, "", false);
  context.mock.restoreAll(); mockGoogleSignIn(context, "test.operator.b@example.test");
  const signedIn = await call(env, `/auth/google/callback?code=one-time&state=${encodeURIComponent(operatorSignIn.state)}`, { cookie: operatorSignIn.cookie });
  assert.equal(signedIn.status, 302); assert.equal(signedIn.headers.get("location"), origin);
  assert.ok(signedIn.headers.getSetCookie().some((value) => value.startsWith("lancerlogin_session=") && !value.startsWith("lancerlogin_session=;")));
  assert.equal(verifiedAt(), null, "an Operator's sign-in does not verify the Google setup");

  const adminVerify = await startGoogle(env, await sessionFor("admin", "admin"), true);
  context.mock.restoreAll(); mockGoogleSignIn(context, "test.admin.a@example.test");
  const verified = await call(env, `/auth/google/callback?code=one-time&state=${encodeURIComponent(adminVerify.state)}`, { cookie: adminVerify.cookie });
  assert.equal(verified.headers.get("location"), `${origin}/settings/integrations?verified=google`);
  assert.ok(verifiedAt());
});

async function authorizeCalendar(context: TestContext, env: Env, token: Record<string, unknown>, calendar?: Record<string, unknown>) {
  const started = await call(env, "/admin/integrations/google-calendar/authorize", { cookie: await sessionFor("admin", "admin") });
  assert.equal(started.status, 302, await started.clone().text());
  const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
  context.mock.restoreAll();
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => String(input) === "https://oauth2.googleapis.com/token" ? Response.json(token) : Response.json(calendar ?? {}, { status: calendar ? 200 : 404 }));
  return call(env, `/admin/integrations/google-calendar/callback?code=one-time&state=${encodeURIComponent(state)}`, { cookie: cookies(started) });
}
const bothScopes = "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events";

test("Calendar authorization requires both requested scopes and reports a cancelled consent screen", async (context) => {
  const db = new Database(); const env = environment(db); await saveCalendar(db, { clientId: "calendar-client", clientSecret: "calendar-secret" });
  const partial = await authorizeCalendar(context, env, { access_token: "synthetic-access", refresh_token: "synthetic-refresh", scope: "https://www.googleapis.com/auth/calendar.events" });
  assert.equal(partial.status, 302);
  assert.equal(partial.headers.get("location"), errorLocation(origin, "google_calendar", "Approve both Google Calendar permissions on Google's consent screen, then authorize again."));
  assert.ok(partial.headers.getSetCookie().some((value) => value.startsWith("lancerlogin_calendar_oauth_state=;")));
  assert.equal(db.value<{ authorizedAt: string | null }>("SELECT authorized_at AS authorizedAt FROM google_calendar_authorizations")?.authorizedAt, null);

  const cancelled = await call(env, "/admin/integrations/google-calendar/callback?error=access_denied");
  assert.equal(cancelled.headers.get("location"), errorLocation(origin, "google_calendar", "Google Calendar authorization was cancelled or denied. Authorize again and approve Calendar access."));

  const granted = await authorizeCalendar(context, env, { access_token: "synthetic-access", refresh_token: "synthetic-refresh", scope: `openid ${bothScopes}` });
  assert.equal(granted.headers.get("location"), `${origin}/settings/integrations?authorized=google-calendar`);
  assert.ok(db.value<{ authorizedAt: string | null }>("SELECT authorized_at AS authorizedAt FROM google_calendar_authorizations")?.authorizedAt);
});

test("a refused Calendar refresh token requires re-authorization, which keeps the chosen calendar and clears the flag", async (context) => {
  quietErrors(context);
  const db = new Database(); const env = environment(db);
  await saveCalendar(db, { clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "revoked-refresh", calendarId: "test-calendar@example.test", calendarLabel: "Test Calendar A" }, true, true);
  assert.equal((await status(env)).google_calendar!.reauthorizationRequired, false);

  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
  const listed = await call(env, "/admin/integrations/google-calendar/calendars", { cookie: await sessionFor("admin", "admin") });
  assert.ok(listed.status >= 400);
  const needed = (await status(env)).google_calendar!;
  assert.equal(needed.reauthorizationRequired, true); assert.equal(needed.authorized, false); assert.equal(needed.calendarName, "Test Calendar A");

  // A transient Google failure never marks re-authorization.
  const transientDb = new Database(); const transientEnv = environment(transientDb);
  await saveCalendar(transientDb, { clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "live-refresh", calendarId: "test-calendar@example.test" }, true, true);
  context.mock.restoreAll(); quietErrors(context); context.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 503 }));
  await call(transientEnv, "/admin/integrations/google-calendar/calendars", { cookie: await sessionFor("admin", "admin") });
  assert.equal((await status(transientEnv)).google_calendar!.reauthorizationRequired, false);

  // Re-authorization must bring a new refresh token; the dead one is never reused.
  const noRefresh = await authorizeCalendar(context, env, { access_token: "synthetic-access", scope: bothScopes });
  assert.equal(noRefresh.headers.get("location"), errorLocation(origin, "google_calendar", "Google did not return durable Calendar access. Try authorizing again and approve Calendar access."));

  // The authorize route works while the Calendar is still configured, without re-entering the client credentials.
  const renewed = await authorizeCalendar(context, env, { access_token: "synthetic-access", refresh_token: "renewed-refresh", scope: bothScopes }, { accessRole: "owner", summary: "Test Calendar A" });
  assert.equal(renewed.headers.get("location"), `${origin}/settings/integrations?verified=google-calendar`);
  const after = (await status(env)).google_calendar!;
  assert.equal(after.reauthorizationRequired, false); assert.equal(after.authorized, true); assert.equal(after.configured, true); assert.equal(after.calendarName, "Test Calendar A");
  const stored = db.value<{ ciphertext: string; iv: string }>("SELECT ciphertext, iv FROM google_calendar_authorizations")!;
  const saved = await decryptIntegration(stored.ciphertext, stored.iv, secret) as Record<string, string>;
  assert.deepEqual({ refreshToken: saved.refreshToken, calendarId: saved.calendarId, clientId: saved.clientId }, { refreshToken: "renewed-refresh", calendarId: "test-calendar@example.test", clientId: "calendar-client" });
});

test("Resend errors carry Resend's status and a sanitised one-line message", async (context) => {
  quietErrors(context);
  const db = new Database(); const env = environment(db); await saveIntegration(db, "resend", { apiKey: "re_synthetic", fromEmail: "attendance@example.test" });
  context.mock.method(globalThis, "fetch", async () => Response.json({ name: "validation_error", message: "The example.org domain\n is not verified.   Add it first." + " x".repeat(200) }, { status: 403 }));
  const started = await call(env, "/admin/integrations/resend/verify/start", { body: { email: "test.admin.a@example.test" }, cookie: await sessionFor("admin", "admin") });
  assert.equal(started.status, 502);
  const message = (await started.json() as { error: string }).error;
  assert.ok(message.startsWith("Resend could not deliver the verification email (403): The example.org domain is not verified. Add it first."), message);
  assert.equal(message.includes("\n"), false); assert.ok(message.length <= "Resend could not deliver the verification email (403): ".length + 180);
  assert.equal(message.includes("re_synthetic"), false);

  context.mock.restoreAll(); quietErrors(context); context.mock.method(globalThis, "fetch", async () => new Response("not json", { status: 500 }));
  const plain = await call(env, "/admin/integrations/resend/verify/start", { body: { email: "test.admin.a@example.test" }, cookie: await sessionFor("admin", "admin") });
  assert.equal((await plain.json() as { error: string }).error, "Resend could not deliver the verification email (500)");
});

test("a member email Resend rejects reports Resend's status and message", async (context) => {
  quietErrors(context);
  const db = new Database(); const env = environment(db); await saveIntegration(db, "resend", { apiKey: "re_synthetic", fromEmail: "attendance@example.test" }, true);
  db.sqlite.exec("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,active,created_at) VALUES('member-a','primary','T-A','Test Student','A','test.student.a@example.test',1,'2026-10-18')");
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "The example.org domain is not verified." }, { status: 403 }));
  const sent = await call(env, "/communications/email", { body: { kind: "individual-report", memberId: "member-a" }, cookie: await sessionFor("admin", "admin") });
  assert.equal(sent.status, 502, await sent.clone().text());
  assert.equal((await sent.json() as { error: string }).error, "Resend rejected the email (403): The example.org domain is not verified.");
  assert.equal(db.value<{ status: string }>("SELECT status FROM integration_deliveries")?.status, "failed");
});

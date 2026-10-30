// Google Calendar refusals through the real Worker and real SQLite: Admin routes report a specific, handled error instead of a
// generic 500, 403 causes are told apart from rate limiting, and the operation queue never retries a refusal that needs an Admin.
// Every person, calendar and credential here is synthetic.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
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
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode,google_calendar_enabled) VALUES('primary','2026-10-18','both',1);
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');
      INSERT INTO users(id,installation_id,email,local_username,role,created_at) VALUES('admin','primary','test.admin.a@example.test','admin','admin','2026-10-18'),('operator','primary','test.operator.b@example.test',NULL,'operator','2026-10-18');
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
const environment = (db: D1Database) => ({ APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, INTEGRATION_KEY: secret, DB: db }) as Env;
const admin = async () => `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
async function call(env: Env, path: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin, cookie: await admin() };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return worker.fetch(new Request(`https://api.example.test${path}`, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), env);
}
async function calendarDatabase() {
  const db = new Database(); const encrypted = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "synthetic-refresh", calendarId: "test-calendar@example.test", calendarLabel: "Test Calendar A" }, secret);
  db.sqlite.prepare("INSERT INTO google_calendar_authorizations(installation_id,ciphertext,iv,authorized_at,verified_at,updated_at) VALUES('primary',?,?,'2026-10-18','2026-10-18','2026-10-18')").run(encrypted.ciphertext, encrypted.iv);
  return db;
}
const googleError = (status: number, reason: string, extra: Record<string, unknown> = {}) => ({ error: { code: status, message: "Synthetic Google message with synthetic-access-token", errors: [{ reason, domain: "global", message: "Synthetic" }], status: "PERMISSION_DENIED", ...extra } });
/** The token refresh succeeds; every Calendar API call gets the given refusal. */
function mockCalendar(context: TestContext, status: number, body: unknown, headers: Record<string, string> = {}) {
  context.mock.restoreAll(); context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => String(input) === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "synthetic-access-token" }) : Response.json(body, { status, headers }));
}
async function failure(result: Response) { const body = await result.json() as { error: string; errorId?: string }; assert.equal(body.errorId, undefined, "a provider refusal is a handled error"); assert.equal(body.error.includes("synthetic-access-token"), false); return body.error; }

const apiDisabled = "The Google Calendar API is not enabled in this Google Cloud project. Enable it in the Google Cloud console, wait a minute, then try again.";
const scopes = "Google Calendar access was not fully granted. Authorize Google Calendar again and approve both permissions.";
const rateLimited = "Google Calendar is rate limiting requests. LancerLogin will retry automatically.";
const noAccess = "This Google account can no longer write to the selected calendar. Choose another calendar or restore access.";

test("listing calendars reports a disabled Calendar API as a 502 with the specific message", async (context) => {
  const env = environment(await calendarDatabase());
  mockCalendar(context, 403, googleError(403, "accessNotConfigured", { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] }));
  const listed = await call(env, "/admin/integrations/google-calendar/calendars");
  assert.equal(listed.status, 502); assert.equal(await failure(listed), apiDisabled);

  // The details reason or Google's own wording are enough on their own.
  mockCalendar(context, 403, { error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } });
  assert.equal(await failure(await call(env, "/admin/integrations/google-calendar/calendars")), apiDisabled);
  mockCalendar(context, 403, { error: { code: 403, message: "Google Calendar API has not been used in project 123 before or it is disabled." } });
  assert.equal(await failure(await call(env, "/admin/integrations/google-calendar/calendars")), apiDisabled);
});

test("403 causes are told apart from rate limiting", async (context) => {
  const env = environment(await calendarDatabase()); const path = "/admin/integrations/google-calendar/calendars";
  mockCalendar(context, 403, googleError(403, "insufficientPermissions", { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] }));
  const insufficient = await call(env, path); assert.equal(insufficient.status, 409); assert.equal(await failure(insufficient), scopes);

  mockCalendar(context, 429, googleError(429, "rateLimitExceeded", { status: "RESOURCE_EXHAUSTED" }), { "retry-after": "30" });
  const limited = await call(env, path); assert.equal(limited.status, 503); assert.equal(await failure(limited), rateLimited);
  mockCalendar(context, 403, googleError(403, "userRateLimitExceeded"));
  const limited403 = await call(env, path); assert.equal(limited403.status, 503); assert.equal(await failure(limited403), rateLimited);

  mockCalendar(context, 403, googleError(403, "somethingElse"));
  const other = await call(env, path); assert.equal(other.status, 502); assert.equal(await failure(other), "Google Calendar refused this request (403). Check the Calendar connection.");

  mockCalendar(context, 500, {});
  assert.equal((await call(env, path)).status, 503);
});

test("selecting a calendar converts provider refusals into handled errors", async (context) => {
  const db = await calendarDatabase(); const env = environment(db); const select = { method: "PUT", body: { calendarId: "other-calendar@example.test" } };
  mockCalendar(context, 404, { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } });
  const missing = await call(env, "/admin/integrations/google-calendar/select", select);
  assert.equal(missing.status, 502); assert.equal(await failure(missing), noAccess);

  mockCalendar(context, 403, googleError(403, "requiredAccessLevel"));
  assert.equal(await failure(await call(env, "/admin/integrations/google-calendar/select", select)), noAccess);
  mockCalendar(context, 403, googleError(403, "accessNotConfigured"));
  const disabled = await call(env, "/admin/integrations/google-calendar/select", select);
  assert.equal(disabled.status, 502); assert.equal(await failure(disabled), apiDisabled);
  assert.equal(db.value<{ verifiedAt: string }>("SELECT verified_at AS verifiedAt FROM google_calendar_authorizations")?.verifiedAt, "2026-10-18", "a refused selection changes nothing");
});

test("token refresh refusals: a refused client is specific and keeps authorization; invalid_grant still requires re-authorization", async (context) => {
  const db = await calendarDatabase(); const env = environment(db); const authorizedAt = () => db.value<{ authorizedAt: string | null }>("SELECT authorized_at AS authorizedAt FROM google_calendar_authorizations")?.authorizedAt;
  context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "access_denied", error_description: "Synthetic" }, { status: 403 }));
  const refused = await call(env, "/admin/integrations/google-calendar/calendars");
  assert.equal(refused.status, 502); assert.match(await failure(refused), /^Google refused the Calendar OAuth client \(403\)\. Check that the OAuth client is enabled/);
  assert.equal(authorizedAt(), "2026-10-18");

  context.mock.restoreAll(); context.mock.method(console, "error", () => {});
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
  const expired = await call(env, "/admin/integrations/google-calendar/calendars");
  assert.equal(expired.status, 409); assert.equal(await failure(expired), "Google Calendar authorization needs to be renewed. An Admin must authorize Google Calendar again.");
  assert.equal(authorizedAt(), null);
});

test("the operation queue records a disabled Calendar API as not retryable and a rate limit as retryable", async (context) => {
  const db = await calendarDatabase(); const env = environment(db);
  db.sqlite.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES('meeting-a','primary','Test Meeting A','2026-11-02T17:00:00Z','2026-11-02T19:00:00Z','admin','2026-10-18');
    INSERT INTO google_calendar_operations(installation_id,meeting_id,event_id,action,status,attempts,next_attempt_at,updated_at) VALUES('primary','meeting-a','llsyntheticevent','delete','pending',0,NULL,'2026-10-18');`);
  const operation = () => ({ ...db.value<{ status: string; nextAttemptAt: string | null; lastError: string }>("SELECT status, next_attempt_at AS nextAttemptAt, last_error AS lastError FROM google_calendar_operations")! });

  mockCalendar(context, 403, googleError(403, "accessNotConfigured"));
  const retried = await call(env, "/admin/integrations/google-calendar/retry", { method: "POST", body: {} });
  assert.equal(retried.status, 200, await retried.clone().text()); assert.deepEqual(await retried.json(), { synced: 0, queued: 0, failed: 1 });
  assert.deepEqual(operation(), { status: "failed", nextAttemptAt: null, lastError: apiDisabled });

  mockCalendar(context, 429, googleError(429, "rateLimitExceeded"));
  await call(env, "/admin/integrations/google-calendar/retry", { method: "POST", body: {} });
  const limited = operation(); assert.equal(limited.status, "failed"); assert.equal(limited.lastError, rateLimited); assert.ok(limited.nextAttemptAt, "a rate limit is retried later");
});

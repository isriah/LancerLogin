import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec, hashPassword } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";

class FakeStatement {
  values: unknown[] = [];
  readonly sql: string;
  readonly database: FakeDatabase;
  constructor(sql: string, database: FakeDatabase) { this.sql = sql; this.database = database; }
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { this.database.calls.push(this); return (this.database.firstResult(this.sql, this.values) ?? null) as T | null; }
  async all<T>() { this.database.calls.push(this); return { results: (this.database.allResult(this.sql, this.values) ?? []) as T[] }; }
  async run() { this.database.calls.push(this); return { success: true, meta: { changes: 1 } }; }
}

class FakeDatabase {
  calls: FakeStatement[] = [];
  batches: FakeStatement[][] = [];
  user?: { id: string; role: "admin" | "operator"; passwordHash: string | null; failedLoginCount?: number; lockedUntil?: string };
  rows = new Map<string, unknown>();
  lists = new Map<string, unknown[]>();
  prepare(sql: string) { return new FakeStatement(sql, this); }
  async batch(statements: FakeStatement[]) { this.batches.push(statements); return statements.map(() => ({ success: true })); }
  firstResult(sql: string, values: unknown[]) {
    for (const [fragment, value] of this.rows) if (sql.includes(fragment)) return value;
    if (sql.includes("SELECT id, role FROM users") && sql.includes("active = 1")) {
      const id = String(values[0]);
      return { id, role: id.startsWith("operator") ? "operator" : "admin" };
    }
    if (sql.includes("FROM users")) return this.user;
    return undefined;
  }
  allResult(sql: string, _values: unknown[]) { for (const [fragment, value] of this.lists) if (sql.includes(fragment)) return value; return undefined; }
}

const setupCode = "private setup code 1234";
const setupCodeHash = createHash("sha256").update(setupCode).digest("base64url");
const request = (path: string, body?: unknown, options: { method?: string; cookie?: string } = {}) => new Request(`https://api.example.test${path}`, {
  method: options.method ?? (body ? "POST" : "GET"),
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(options.cookie ? { cookie: options.cookie } : {}) },
  body: body ? JSON.stringify(path === "/setup/bootstrap" && typeof body === "object" ? { setupCode, ...body } : body) : undefined,
});
const sessionSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sessionCookie = async (role: "admin" | "operator") => `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: `${role}-1`, role })}`;

test("Worker bootstrap validates input before writing D1", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example" }), env);
  assert.equal(result.status, 400);
  assert.equal(database.batches.length, 0);
});

test("Worker rejects an oversized body even without a content-length header", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env;
  const oversized = new Request("https://api.example.test/setup/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationName: "x".repeat(262_145) }) });
  assert.equal(oversized.headers.has("content-length"), false);
  assert.equal((await worker.fetch(oversized, env)).status, 413);
  assert.equal(database.batches.length, 0);
});

test("first setup rejects simple cross-origin media types before any D1 write", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env;
  const hostile = new Request("https://api.example.test/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://hostile.example.test" },
    body: JSON.stringify({ organizationName: "Taken over", timeZone: "UTC", authMode: "local", localUsername: "attacker", localPassword: "attacker password long enough" }),
  });
  const result = await worker.fetch(hostile, env);
  assert.equal(result.status, 415);
  assert.equal(result.headers.get("access-control-allow-origin"), null);
  assert.equal(database.batches.length, 0);
});

test("local Worker bootstrap creates the first Admin with a salted password hash", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example Arts Club", timeZone: "America/New_York", authMode: "local", localUsername: "director", localPassword: "correct horse battery staple", telemetryAccepted: false }), env);
  assert.equal(result.status, 201);
  assert.equal(database.batches.length, 1);
  assert.equal(database.batches[0].length, 4);
  const userInsert = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO users"));
  assert.match(String(userInsert?.values[4]), /^scrypt\$/);
  assert.equal((await result.json() as { telemetryAccepted: boolean }).telemetryAccepted, false);
});

test("first-Admin bootstrap requires the private one-time setup code", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env;
  const input = { setupCode: "incorrect setup code", organizationName: "Example Club", timeZone: "UTC", authMode: "local", localUsername: "admin", localPassword: "correct horse battery staple" };
  const result = await worker.fetch(request("/setup/bootstrap", input), env);
  assert.equal(result.status, 403);
  assert.equal(database.batches.length, 0);
});

test("local login applies generic constant-work failure and temporary account locking", async () => {
  const database = new FakeDatabase();
  database.user = { id: "admin-1", role: "admin", passwordHash: await hashPassword("correct horse battery staple"), failedLoginCount: 4 };
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const failed = await worker.fetch(request("/auth/local", { username: "director", password: "incorrect password" }), env);
  assert.equal(failed.status, 401);
  assert.equal((await failed.json() as { error: string }).error, "Invalid username or password");
  const lock = database.calls.find((call) => call.sql.includes("UPDATE users SET failed_login_count"));
  assert.ok(lock);
  assert.equal(lock.values[0], 5);
  assert.ok(Date.parse(String(lock.values[1])) > Date.now());

  const unknownDatabase = new FakeDatabase();
  const unknown = await worker.fetch(request("/auth/local", { username: "unknown", password: "incorrect password" }), { ...env, DB: unknownDatabase } as unknown as Env);
  assert.equal(unknown.status, 401);
  assert.equal(unknownDatabase.calls.some((call) => call.sql.includes("UPDATE users SET failed_login_count")), false);
});

test("successful local login clears prior failed-login state", async () => {
  const database = new FakeDatabase();
  database.user = { id: "admin-1", role: "admin", passwordHash: await hashPassword("correct horse battery staple"), failedLoginCount: 2 };
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/auth/local", { username: "director", password: "correct horse battery staple" }), env);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("set-cookie") ?? "", /lancerlogin_session=/);
  assert.ok(database.calls.some((call) => call.sql.includes("failed_login_count = 0")));
});

test("Google-only bootstrap encrypts OAuth credentials before the first sign-in", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example Classroom", timeZone: "America/New_York", authMode: "google", adminEmail: "teacher@example.test", googleClientId: "google-client-id", googleClientSecret: "google-client-secret", telemetryAccepted: false }), env);
  assert.equal(result.status, 201);
  const integration = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO encrypted_integrations"));
  assert.ok(integration);
  assert.equal(integration.values.some((value) => String(value).includes("google-client-secret")), false);
  assert.ok(database.batches[0].some((statement) => statement.sql.includes("integration.saved")));
  assert.equal((await result.text()).includes("google-client-secret"), false);
});

test("Google bootstrap fails before writes when encryption or credentials are unavailable", async () => {
  const database = new FakeDatabase();
  const base = { organizationName: "Example Classroom", timeZone: "America/New_York", authMode: "google", adminEmail: "teacher@example.test", googleClientId: "google-client-id", googleClientSecret: "google-client-secret" };
  const missingKey = await worker.fetch(request("/setup/bootstrap", base), { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env);
  assert.equal(missingKey.status, 503);
  const missingCredentials = await worker.fetch(request("/setup/bootstrap", { ...base, googleClientSecret: "" }), { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env);
  assert.equal(missingCredentials.status, 400);
  assert.equal(database.batches.length, 0);
});

test("protected setup routes reject anonymous and Operator access", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/admin/branding"), env)).status, 401);
  assert.equal((await worker.fetch(request("/admin/branding", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
});

test("only an Admin can discover the private deployment updater", async () => {
  const database = new FakeDatabase();
  const workflowUrl = "https://github.com/example/private-deployment/actions/workflows/provision-template.yml";
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, UPDATE_WORKFLOW_URL: workflowUrl, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/admin/update-info"), env)).status, 401);
  assert.equal((await worker.fetch(request("/admin/update-info", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
  const result = await worker.fetch(request("/admin/update-info", undefined, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { releaseVersion: "development", workflowUrl });
});

test("protected routes immediately honor account deactivation and role changes", async () => {
  const deactivated = new FakeDatabase();
  deactivated.rows.set("SELECT id, role FROM users", null);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: deactivated } as unknown as Env;
  assert.equal((await worker.fetch(request("/meetings", undefined, { cookie: await sessionCookie("operator") }), env)).status, 401);

  const changed = new FakeDatabase();
  changed.rows.set("SELECT id, role FROM users", { id: "admin-1", role: "operator" });
  const staleAdmin = await sessionCookie("admin");
  assert.equal((await worker.fetch(request("/admin/branding", undefined, { cookie: staleAdmin }), { ...env, DB: changed } as unknown as Env)).status, 403);
  assert.equal((await worker.fetch(request("/meetings", undefined, { cookie: staleAdmin }), { ...env, DB: changed } as unknown as Env)).status, 200);
});

test("branding stores a bounded image asset in D1 and rejects remote logo URLs", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const base = { organizationName: "Example Arts Club", subtitle: "Create together", primaryColor: "#123456", secondaryColor: "#abcdef", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30 };
  const remote = await worker.fetch(request("/admin/branding", { ...base, logoData: "https://example.test/logo.png" }, { method: "PATCH", cookie }), env);
  assert.equal(remote.status, 400);
  const logoData = `data:image/png;base64,${Buffer.from("small-logo").toString("base64")}`;
  const saved = await worker.fetch(request("/admin/branding", { ...base, logoData }, { method: "PATCH", cookie }), env);
  assert.equal(saved.status, 200);
  const update = database.calls.find((call) => call.sql.includes("UPDATE organization_settings SET"));
  assert.ok(update?.sql.includes("logo_data"));
  assert.ok(update?.values.includes(logoData));
});

test("Admin can persist shared checklist progress with an audit record", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/setup/progress", { step: "branding", completed: true }, { method: "PATCH", cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200);
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT INTO setup_progress")));
  assert.ok(database.calls.some((call) => call.values.includes("setup.step_completed")));
});

test("Admin roster import is bounded, installation-scoped, and audited", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/members", { members: [{ memberId: "A-1", firstName: "Avery", lastName: "Stone", email: "avery@example.test" }] }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 201);
  assert.equal(database.batches.at(-1)?.length, 2);
  assert.ok(database.batches.at(-1)?.[0].sql.includes("installation_id"));
  assert.ok(database.batches.at(-1)?.[1].sql.includes("roster.imported"));
});

test("pairing returns a one-time code while D1 receives only its hash", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/pairing-codes", { kioskName: "Front desk" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 201);
  const body = await result.json() as { code: string; workerApiUrl: string };
  assert.equal(body.workerApiUrl, "https://api.example.test");
  const insert = database.batches.at(-1)?.find((statement) => statement.sql.includes("INSERT INTO pairing_codes"));
  assert.ok(insert);
  assert.notEqual(insert.values[1], body.code);
  assert.match(String(insert.values[1]), /^[A-Za-z0-9_-]{43}$/);
});

test("single-kiosk pairing requires explicit replacement and disables the prior credential on redemption", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks WHERE installation_id", { id: "kiosk-old", name: "Existing kiosk" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const blocked = await worker.fetch(request("/admin/pairing-codes", { kioskName: "Replacement" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(blocked.status, 409);
  const approved = await worker.fetch(request("/admin/pairing-codes", { kioskName: "Replacement", replaceExisting: true }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(approved.status, 201);

  const code = (await approved.json() as { code: string }).code;
  database.rows.delete("FROM kiosks WHERE installation_id");
  database.rows.set("FROM pairing_codes", { id: "pairing-1" });
  const redeemed = await worker.fetch(request("/kiosk/pair", { code, kioskName: "Replacement" }), env);
  assert.equal(redeemed.status, 201);
  const batch = database.batches.at(-1) ?? [];
  const deactivateIndex = batch.findIndex((statement) => statement.sql.includes("UPDATE kiosks SET active = 0"));
  const insertIndex = batch.findIndex((statement) => statement.sql.includes("INSERT INTO kiosks"));
  assert.ok(deactivateIndex >= 0 && insertIndex > deactivateIndex);
});

test("browser simulator uses a distinct one-time code and never creates a hardware kiosk credential", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const created = await worker.fetch(request("/admin/pairing-codes", { kioskName: "Browser test", purpose: "simulator" }, { cookie }), env);
  assert.equal(created.status, 201);
  const code = (await created.json() as { code: string }).code;
  const pairingWrite = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO pairing_codes"));
  assert.ok(pairingWrite?.values.includes("simulator"));
  assert.equal(database.calls.some((call) => call.sql.includes("FROM kiosks WHERE")), false);

  database.rows.set("purpose = 'simulator'", { id: "simulator-code" });
  const paired = await worker.fetch(request("/admin/simulator", { action: "pair", code, kioskName: "Browser test" }, { cookie }), env);
  assert.equal(paired.status, 201);
  const batch = database.batches.at(-1) ?? [];
  assert.ok(batch.some((call) => call.sql.includes("INSERT INTO simulated_kiosk_sessions")));
  assert.equal(batch.some((call) => call.sql.includes("INSERT INTO kiosks")), false);
  assert.equal((await paired.text()).includes("kioskToken"), false);
});

test("browser simulator check-ins are Admin-only and restricted to test meetings", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM simulated_kiosk_sessions", { name: "Browser test", active: 1, online: 1 });
  database.rows.set("AND is_test = 1", { id: "test-meeting" });
  database.rows.set("FROM members", { id: "member-1" });
  database.rows.set("FROM meetings", { id: "test-meeting", startsAt: "2020-01-01T00:00:00.000Z", endsAt: "2030-01-01T00:00:00.000Z" });
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("FROM attendance_events", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const body = { action: "check-in", memberId: "ROSTER-001", meetingId: "test-meeting" };
  assert.equal((await worker.fetch(request("/admin/simulator", body, { cookie: await sessionCookie("operator") }), env)).status, 403);
  const accepted = await worker.fetch(request("/admin/simulator", body, { cookie: await sessionCookie("admin") }), env);
  assert.equal(accepted.status, 202);
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events") && call.values.includes("manual")));
  assert.ok(database.calls.some((call) => call.values.includes("simulator.check_in")));

  const normalDatabase = new FakeDatabase();
  normalDatabase.rows.set("FROM simulated_kiosk_sessions", { name: "Browser test", active: 1, online: 1 });
  const normalEnv = { ...env, DB: normalDatabase } as unknown as Env;
  const rejected = await worker.fetch(request("/admin/simulator", { ...body, meetingId: "normal-meeting" }, { cookie: await sessionCookie("admin") }), normalEnv);
  assert.equal(rejected.status, 400);
  assert.equal(normalDatabase.calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events")), false);
});

test("invalid optional Discord IDs do not block core roster import", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/members", { members: [{ memberId: "1", firstName: "Ada", lastName: "Lovelace", discordUserId: "bad" }] }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 201);
  const body = await result.json() as { warnings: string[] };
  assert.match(body.warnings[0], /ignored/);
  const insert = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO members"));
  assert.equal(insert?.values[5], null);
});

test("Admin can rename and retire a kiosk without returning to onboarding", async () => {
  const database = new FakeDatabase(); database.rows.set("SELECT id, name, active FROM kiosks", { id: "kiosk-1", name: "Front desk", active: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const renamed = await worker.fetch(request("/admin/kiosks/kiosk-1", { name: "Event entrance" }, { method: "PATCH", cookie }), env);
  assert.equal(renamed.status, 200);
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosks SET name") && call.values.includes("Event entrance")));
  const retired = await worker.fetch(request("/admin/kiosks/kiosk-1", { confirmation: "RETIRE KIOSK" }, { method: "DELETE", cookie }), env);
  assert.equal(retired.status, 200);
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosks SET active = 0") && call.values.includes("kiosk-1")));
});

test("replace roster deactivates omitted members without changing dashboard users", async () => {
  const database = new FakeDatabase();
  database.lists.set("SELECT external_id AS memberId", [{ memberId: "OLD", active: 1 }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/members", { mode: "replace", members: [{ memberId: "NEW", firstName: "New", lastName: "Member" }] }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 201);
  const body = await result.json() as { deactivated: number; mode: string };
  assert.equal(body.deactivated, 1);
  assert.equal(body.mode, "replace");
  const batch = database.batches.at(-1) ?? [];
  assert.ok(batch.some((call) => call.sql.includes("UPDATE members SET active = 0")));
  assert.equal(batch.some((call) => call.sql.includes("UPDATE users")), false);
});

test("kiosk heartbeat hashes bearer credentials before D1 lookup", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const heartbeat = new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, releaseVersion: "0.1.0", pendingEvents: 2, lastSyncAt: "2026-09-01T20:00:00.000Z", errorCategory: null }) });
  const result = await worker.fetch(heartbeat, env);
  assert.equal(result.status, 200);
  const lookup = database.calls.find((call) => call.sql.includes("FROM kiosks"));
  assert.ok(lookup);
  assert.notEqual(lookup.values[0], "very-secret");
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosks SET last_seen_at")));
  const healthUpdate = database.calls.find((call) => call.sql.includes("reader_online"));
  assert.deepEqual(healthUpdate?.values.slice(1, 3), [1, "0.1.0"]);
});

test("kiosk heartbeats maintain one idempotent Discord status message and scheduled reconciliation marks it offline", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.1.3" });
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => { outbound.push({ input: String(input), init }); return new Response(JSON.stringify({ id: "message-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    const background: Promise<unknown>[] = [];
    const heartbeat = new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, releaseVersion: "0.1.3", pendingEvents: 0, lastSyncAt: "2026-09-01T20:00:00.000Z", errorCategory: null }) });
    const result = await worker.fetch(heartbeat, env, { waitUntil: (promise) => background.push(promise) });
    assert.equal(result.status, 200);
    assert.equal(background.length, 1);
    await Promise.all(background);
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].input, /channels\/223456789012345678\/messages$/);
    assert.equal(outbound[0].init?.method, "POST");
    assert.match(String(outbound[0].init?.body), /Front desk.*online.*reader online.*release 0\.1\.3/);
    assert.deepEqual(JSON.parse(String(outbound[0].init?.body)).allowed_mentions, { parse: [] });
    const stateWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_state") && call.values.includes("message-1"));
    assert.ok(stateWrite);

    database.rows.set("FROM integration_state", { externalId: "message-1", contentHash: stateWrite.values[1] });
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.length, 1, "unchanged online state should not edit Discord");

    database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: "2026-08-29T00:00:00Z", readerOnline: 1, releaseVersion: "0.1.3" });
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.length, 2);
    assert.equal(outbound[1].init?.method, "PATCH");
    assert.match(String(outbound[1].init?.body), /Front desk.*offline.*last seen 2026-08-29/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Operator can create meetings and reasoned attendance corrections", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const operator = await sessionCookie("operator");
  const meeting = await worker.fetch(request("/meetings", { title: "Rehearsal", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z", required: true }, { cookie: operator }), env);
  assert.equal(meeting.status, 201);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("meeting.created")));
  const corrected = await worker.fetch(request("/attendance/corrections", { memberId: "member-1", meetingId: "meeting-1", disposition: "excused", reason: "School event" }, { cookie: operator }), env);
  assert.equal(corrected.status, 201);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("attendance.corrected")));
});

test("authenticated kiosk configuration returns current display branding", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  database.rows.set("organization_name AS organizationName", { organizationName: "Example Arts", subtitle: "Studio", logoData: null, primaryColor: "#123456", secondaryColor: "#abcdef", logoBackdrop: "auto" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(new Request("https://api.example.test/kiosk/config", { headers: { authorization: "Bearer very-secret" } }), env);
  assert.equal(result.status, 200);
  assert.equal((await result.json() as { settings: { organizationName: string } }).settings.organizationName, "Example Arts");
});

test("Operator can create a bounded recurring meeting series", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/meetings", { title: "Weekly rehearsal", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z", required: true, recurrence: { frequency: "weekly", until: "2026-09-22T23:59:59.000Z" } }, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 201);
  const body = await result.json() as { meetings: unknown[]; seriesId: string };
  assert.equal(body.meetings.length, 4);
  assert.ok(body.seriesId);
  const batch = database.batches.at(-1) ?? [];
  assert.equal(batch.filter((call) => call.sql.includes("INSERT INTO meetings")).length, 4);
  assert.ok(batch.some((call) => call.values.includes("weekly")));
});

test("meeting creation rejects overlap with an existing attendance window before writing", async () => {
  const database = new FakeDatabase();
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings", [{ id: "existing", title: "Build", startsAt: "2026-09-01T18:00:00.000Z", endsAt: "2026-09-01T20:00:00.000Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/meetings", { title: "Rehearsal", startsAt: "2026-09-01T20:15:00.000Z", endsAt: "2026-09-01T22:00:00.000Z", required: true }, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 409);
  assert.match((await result.json() as { error: string }).error, /cannot overlap.*Build.*Rehearsal/i);
  assert.equal(database.batches.length, 0);
});

test("recurring meetings preserve organization-local time across daylight saving changes", async () => {
  const database = new FakeDatabase(); database.rows.set("time_zone AS timeZone", { timeZone: "America/New_York" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/meetings", { title: "Sunday rehearsal", startsAt: "2026-10-25T18:00:00.000Z", endsAt: "2026-10-25T20:00:00.000Z", required: true, recurrence: { frequency: "weekly", until: "2026-11-08T23:59:59.000Z" } }, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 201);
  const body = await result.json() as { meetings: { startsAt: string }[] };
  assert.deepEqual(body.meetings.map((meeting) => meeting.startsAt), ["2026-10-25T18:00:00.000Z", "2026-11-01T19:00:00.000Z", "2026-11-08T19:00:00.000Z"]);
});

test("Operator can update meeting details without destructive access", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/meetings/meeting-1", { title: "Updated rehearsal", startsAt: "2026-09-02T20:00:00.000Z", endsAt: "2026-09-02T22:00:00.000Z", required: true, notes: "Bring supplies" }, { method: "PATCH", cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE meetings SET") && call.values.includes("meeting-1") && call.values.includes("Bring supplies")));
  assert.ok(database.calls.some((call) => call.values.includes("meeting.updated")));
  assert.equal((await worker.fetch(request("/meetings/meeting-1", { title: "Too much", startsAt: "2026-09-02T20:00:00.000Z", endsAt: "2026-09-02T22:00:00.000Z", notes: "x".repeat(2_001) }, { method: "PATCH", cookie: await sessionCookie("operator") }), env)).status, 400);
  assert.equal((await worker.fetch(request("/admin/data", { scope: "attendance", confirmation: "DELETE ATTENDANCE" }, { method: "DELETE", cookie: await sessionCookie("operator") }), env)).status, 403);
});

test("kiosk attendance is installation-scoped and idempotent by event ID", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  database.rows.set("FROM members", { id: "member-1" });
  database.rows.set("FROM meetings", { id: "meeting-1", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" });
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("FROM attendance_events", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const attendanceRequest = new Request("https://api.example.test/kiosk/attendance", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ eventId: "offline-event-1", memberId: "ROSTER-001", meetingId: "meeting-1", occurredAt: "2026-09-01T20:02:00.000Z" }) });
  const result = await worker.fetch(attendanceRequest, env);
  assert.equal(result.status, 202);
  const insert = database.calls.find((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events"));
  assert.ok(insert);
  assert.ok(insert.sql.includes("installation_id"));
  assert.ok(database.calls.some((call) => call.sql.includes("external_id = ?") && call.values.filter((value) => value === "ROSTER-001").length === 2));
  assert.ok(insert.values.includes("member-1"));
  assert.equal(insert.values.includes("ROSTER-001"), false);
  assert.ok(insert.values.includes("offline-event-1"));
});

test("attendance export is authenticated, quoted, and safe to open in spreadsheet software", async () => {
  const database = new FakeDatabase();
  database.lists.set("FROM meetings mt", [{ meeting: "Studio, weekly", meetingStart: "2026-09-01T20:00:00Z", meetingEnd: "2026-09-01T22:00:00Z", memberId: "=HYPERLINK(\"https://example.test\")", firstName: "+Avery", lastName: "Stone", disposition: "present", checkedInAt: "2026-09-01T20:02:00Z", checkedOutAt: "2026-09-01T21:58:00Z", reason: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/exports/attendance.csv"), env)).status, 401);
  const result = await worker.fetch(request("/exports/attendance.csv", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await result.text();
  assert.match(csv, /"Studio, weekly"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /'\+Avery/);
  const exportQuery = database.calls.find((call) => call.sql.includes("FROM meetings mt"));
  assert.match(exportQuery?.sql ?? "", /ORDER BY c\.created_at DESC/);
  assert.match(exportQuery?.sql ?? "", /e\.action = 'check_in'/);
  assert.match(exportQuery?.sql ?? "", /e\.action = 'check_out'/);
});

test("first integration save encrypts secrets and requires verification", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/integrations/resend", { apiKey: "re_super_secret", fromEmail: "attendance@example.test" }, { method: "PUT", cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.equal(text.includes("re_super_secret"), false);
  const saved = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO encrypted_integrations"));
  assert.ok(saved);
  assert.equal(saved.values.some((value) => String(value).includes("re_super_secret")), false);
  assert.deepEqual(await new Response(text).json(), { saved: true, configured: false, created: true, provider: "resend", state: "verification_required", updatedAt: JSON.parse(text).updatedAt });
  assert.ok(database.calls.some((call) => call.values.includes("integration.saved")));
});

test("kiosk attendance automatically resolves the one eligible meeting from the scan time", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  database.rows.set("FROM members", { id: "member-1", externalId: "ROSTER-001", firstName: "Avery", lastName: "Stone" });
  database.rows.set("starts_at <= ?", { id: "meeting-1", title: "Build session", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" });
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("FROM attendance_events", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(new Request("https://api.example.test/kiosk/attendance", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ eventId: "automatic-1", memberId: "ROSTER-001", occurredAt: "2026-09-01T20:02:00.000Z" }) }), env);
  assert.equal(result.status, 202);
  const payload = await result.json() as { action: string; meeting: { id: string; title: string }; member: { displayName: string } };
  assert.equal(payload.action, "check_in");
  assert.deepEqual(payload.meeting, { id: "meeting-1", title: "Build session" });
  assert.equal(payload.member.displayName, "Avery Stone");
  assert.ok(database.calls.find((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events"))?.values.includes("meeting-1"));
});

test("Resend becomes configured only after an actual email and one-time code", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ apiKey: "resend-secret", fromEmail: "attendance@example.test" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "resend-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let outbound: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { outbound = init; return new Response(JSON.stringify({ id: "verification-email-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    const started = await worker.fetch(request("/admin/integrations/resend/verify/start", { email: "admin@example.test" }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(started.status, 202);
    const publicResult = JSON.stringify(await started.json());
    const email = JSON.parse(String(outbound?.body)); const code = String(email.text).match(/\b\d{6}\b/)?.[0];
    assert.ok(code); assert.equal(publicResult.includes(code), false); assert.deepEqual(email.to, ["admin@example.test"]);
    const challengeWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_verification_challenges"));
    assert.ok(challengeWrite); assert.equal(challengeWrite.values[0], createHash("sha256").update(code).digest("base64url")); assert.equal(challengeWrite.values.includes(code), false);
    database.rows.set("FROM integration_verification_challenges", { challengeHash: challengeWrite.values[0], target: "admin@example.test", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const completed = await worker.fetch(request("/admin/integrations/resend/verify/complete", { code }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(completed.status, 200); assert.equal((await completed.json() as { configured: boolean }).configured, true);
    assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE encrypted_integrations SET verified_at")));
  } finally { globalThis.fetch = originalFetch; }
});

test("saved but unverified Resend credentials cannot send attendance email", async () => {
  const database = new FakeDatabase(); const encrypted = await encryptIntegration({ apiKey: "resend-secret", fromEmail: "attendance@example.test" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "resend-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null });
  database.rows.set("FROM members", { id: "member-1", firstName: "Avery", lastName: "Stone", email: "avery@example.test" }); database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/communications/email", { kind: "missed-meeting", memberId: "member-1", meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 503); assert.match((await result.json() as { error: string }).error, /verification is required/);
});

test("Discord verification checks the bot, server, channel, and signed user click", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => { outbound.push({ input: String(input), init }); const id = String(input).includes("/channels/") ? "verification-message-1" : "validated"; return new Response(JSON.stringify({ id }), { headers: { "content-type": "application/json" } }); };
  try {
    const started = await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
    assert.equal(started.status, 202); assert.match(outbound[0].input, /users\/@me$/); assert.match(outbound[1].input, /guilds\/123456789012345678$/); assert.match(outbound[2].input, /channels\/223456789012345678\/messages$/);
    const payload = JSON.parse(String(outbound[2].init?.body)); const customId = payload.components[0].components[0].custom_id as string; const token = customId.slice("lancerlogin-verify:".length);
    const challengeWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_verification_challenges")); assert.ok(challengeWrite); assert.equal(challengeWrite.values[0], createHash("sha256").update(token).digest("base64url")); assert.equal(challengeWrite.values.includes(token), false);
    database.rows.set("FROM integration_verification_challenges", { challengeHash: challengeWrite.values[0], target: "123456789012345678", externalId: "verification-message-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const body = JSON.stringify({ type: 3, guild_id: "123456789012345678", data: { custom_id: customId }, member: { user: { id: "323456789012345678" } }, message: { id: "verification-message-1" } }); const timestamp = String(Math.floor(Date.now() / 1000)); const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
    const interaction = new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
    const verified = await worker.fetch(interaction, env); assert.equal(verified.status, 200); assert.match(JSON.stringify(await verified.json()), /LancerLogin is verified/); assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE encrypted_integrations SET verified_at")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Google-only installations cannot remove their sole sign-in integration", async () => {
  const database = new FakeDatabase();
  database.rows.set("auth_mode AS authMode", { authMode: "google" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/integrations/google", {}, { method: "DELETE", cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 409);
  assert.equal(database.calls.some((call) => call.sql.includes("DELETE FROM encrypted_integrations")), false);
});

test("removing Google from a dual-auth installation retains local sign-in", async () => {
  const database = new FakeDatabase(); database.rows.set("auth_mode AS authMode", { authMode: "both" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/integrations/google", {}, { method: "DELETE", cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200); assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("SET auth_mode = 'local'")));
});

test("Google OAuth uses signed state and validates identity before issuing a session", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ clientId: "client-id", clientSecret: "client-secret" }, sessionSecret);
  database.rows.set("FROM installations", { authMode: "google" });
  database.rows.set("FROM encrypted_integrations", { id: "google-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z" });
  database.user = { id: "admin-1", role: "admin", passwordHash: null };
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const started = await worker.fetch(request("/auth/google/start"), env);
  assert.equal(started.status, 302);
  const location = new URL(started.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  assert.equal(location.searchParams.get("client_id"), "client-id");
  assert.equal(location.searchParams.get("redirect_uri"), "https://dashboard.example.test/api/auth/google/callback");
  assert.equal(location.toString().includes("client-secret"), false);
  assert.match(started.headers.get("set-cookie") ?? "", /Path=\/;/);
  const oauthCookie = started.headers.get("set-cookie")!.split(";")[0];
  assert.ok(await createSessionCodec(sessionSecret).verify(state));

  const originalFetch = globalThis.fetch;
  let calls = 0; let tokenRequestBody = "";
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) { tokenRequestBody = String(init?.body); return new Response(JSON.stringify({ id_token: "google-token" }), { headers: { "content-type": "application/json" } }); }
    return new Response(JSON.stringify({ aud: "client-id", email: "admin@example.test", email_verified: "true", iss: "https://accounts.google.com" }), { headers: { "content-type": "application/json" } });
  };
  try {
    const callback = await worker.fetch(request(`/auth/google/callback?code=one-time&state=${encodeURIComponent(state)}`, undefined, { cookie: oauthCookie }), env);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "https://dashboard.example.test");
    assert.match(callback.headers.get("set-cookie") ?? "", /lancerlogin_session=/);
    assert.equal(new URLSearchParams(tokenRequestBody).get("redirect_uri"), "https://dashboard.example.test/api/auth/google/callback");
    assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE encrypted_integrations SET verified_at")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Admin can create a least-privilege local Operator without exposing its hash", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/users", { localUsername: "front-desk", localPassword: "correct horse battery staple", role: "operator" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 201);
  assert.equal((await result.text()).includes("scrypt$"), false);
  const insert = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO users"));
  assert.match(String(insert?.values[3]), /^scrypt\$/);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("user.created")));
});

test("Admin cannot deactivate the current account", async () => {
  const database = new FakeDatabase();
  database.user = { id: "admin-1", role: "admin", passwordHash: null };
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const ownCookie = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin-1", role: "admin" })}`;
  const result = await worker.fetch(request("/admin/users/admin-1", { active: false }, { method: "PATCH", cookie: ownCookie }), env);
  assert.equal(result.status, 409);
  assert.equal(database.batches.length, 0);
});

test("missed-meeting email is D1-sourced, escaped, and idempotency keyed", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ apiKey: "resend-secret", fromEmail: "attendance@example.test" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "resend-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM members", { id: "member-1", firstName: "<Avery>", lastName: "Stone", email: "avery@example.test" });
  database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio & Safety", startsAt: "2026-09-01T20:00:00Z" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let outbound: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { outbound = init; return new Response(JSON.stringify({ id: "email-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    const result = await worker.fetch(request("/communications/email", { kind: "missed-meeting", memberId: "member-1", meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 202);
    assert.equal(JSON.stringify(await result.json()).includes("resend-secret"), false);
    assert.equal((outbound?.headers as Record<string, string>)["idempotency-key"], "missed:meeting-1:member-1");
    const body = JSON.parse(String(outbound?.body));
    assert.match(body.html, /&lt;Avery&gt;/);
    assert.doesNotMatch(body.html, /<Avery>/);
    assert.ok(database.calls.some((call) => call.sql.includes("integration_deliveries")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord missing-member workflow mentions only linked absent members and records recipients", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio" });
  database.lists.set("FROM members m WHERE", [{ id: "member-1", discordUserId: "323456789012345678" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let outbound: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { outbound = init; return new Response(JSON.stringify({ id: "message-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    const result = await worker.fetch(request("/discord/missing", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 202);
    const payload = JSON.parse(String(outbound?.body));
    assert.match(payload.content, /<@323456789012345678>/);
    assert.deepEqual(payload.allowed_mentions, { parse: [], users: ["323456789012345678"] });
    assert.equal(payload.components[0].components[0].custom_id, "lancerlogin-attendance:meeting-1");
    assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("discord_attendance_recipients")));
    assert.equal(database.batches.at(-1)?.some((call) => call.sql.includes("discord_attendance_contests")), false);
    assert.equal(JSON.stringify(await result.json()).includes("discord-secret"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Operators can list and resolve Discord attendance contests", async () => {
  const database = new FakeDatabase();
  database.lists.set("FROM discord_attendance_contests c", [{ meetingId: "meeting-1", memberId: "member-1", externalId: "A-1", firstName: "Avery", lastName: "Stone", status: "open", createdAt: "2026-08-30T00:00:00Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator");
  const listed = await worker.fetch(request("/discord/contests?meetingId=meeting-1", undefined, { cookie }), env);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json() as { contests: unknown[] }).contests.length, 1);
  const resolved = await worker.fetch(request("/discord/contests/resolve", { meetingId: "meeting-1", memberId: "member-1", resolution: "approved", reviewNote: "Member showed the Operator a kiosk error." }, { cookie }), env);
  assert.equal(resolved.status, 200);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE discord_attendance_contests")));
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("INSERT INTO attendance_corrections")));
  assert.ok(database.calls.some((call) => call.values.includes("discord.contest_resolved")));
});

test("a signed Discord button creates a contest only for the delivered linked member", async () => {
  const database = new FakeDatabase();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM discord_attendance_recipients", { memberId: "member-1" });
  database.rows.set("FROM discord_attendance_contests WHERE", { status: "open" });
  database.lists.set("FROM members m WHERE", [{ id: "member-1", discordUserId: "323456789012345678" }]);
  const body = JSON.stringify({ type: 3, data: { custom_id: "lancerlogin-attendance:meeting-1" }, member: { user: { id: "323456789012345678" } }, message: { id: "message-1" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const interaction = new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(interaction, env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { type: 4, data: { content: "Your attendance contest was recorded for review. Your attendance has not been changed.", flags: 64 } });
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO discord_attendance_contests") && call.values.includes("323456789012345678")));
});

test("telemetry transmits only after acceptance and strictly allowlists its payload", async () => {
  const database = new FakeDatabase();
  database.rows.set("telemetry_accepted_at AS acceptedAt", { acceptedAt: "2026-08-30T00:00:00Z", installId: "2f1c7d4a-81cb-4cef-934e-4c23181933fd" });
  database.rows.set("COUNT(*) AS count", { count: 1 });
  database.rows.set("FROM telemetry_diagnostics", { errorCategory: "worker-internal" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, TELEMETRY_ENDPOINT: "https://telemetry.example.test/v1", RELEASE_VERSION: "0.1.0", DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let payload: Record<string, unknown> | undefined; let fetchOptions: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => { fetchOptions = init; payload = JSON.parse(String(init?.body)); return new Response(null, { status: 202 }); };
  try {
    const telemetryRequest = request("/admin/privacy", { telemetryAccepted: true }, { method: "PATCH", cookie: await sessionCookie("admin") });
    Object.defineProperty(telemetryRequest, "cf", { value: { city: "Example Metro", ip: "192.0.2.1" } });
    const result = await worker.fetch(telemetryRequest, env);
    assert.equal(result.status, 200);
    assert.deepEqual(payload, { installId: "2f1c7d4a-81cb-4cef-934e-4c23181933fd", releaseVersion: "0.1.0", activeKioskCount: 1, metro: "Example Metro", errorCategory: "worker-internal" });
    assert.equal(fetchOptions?.redirect, "error");
    assert.equal(JSON.stringify(payload).includes("192.0.2.1"), false);
    assert.equal(JSON.stringify(payload).includes("organization"), false);
    assert.ok(database.calls.some((call) => call.sql.includes("DELETE FROM telemetry_diagnostics")));
  } finally { globalThis.fetch = originalFetch; }
});

test("privacy settings expose the opaque deletion reference only while telemetry is accepted", async () => {
  const accepted = new FakeDatabase();
  accepted.rows.set("telemetry_accepted_at AS acceptedAt, telemetry_install_id AS installationReference", { acceptedAt: "2026-08-30T00:00:00Z", installationReference: "2f1c7d4a-81cb-4cef-934e-4c23181933fd" });
  const acceptedEnv = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: accepted } as unknown as Env;
  const acceptedResult = await worker.fetch(request("/admin/privacy", undefined, { cookie: await sessionCookie("admin") }), acceptedEnv);
  assert.equal(acceptedResult.status, 200);
  assert.equal((await acceptedResult.json() as { installationReference?: string }).installationReference, "2f1c7d4a-81cb-4cef-934e-4c23181933fd");

  const declined = new FakeDatabase();
  declined.rows.set("telemetry_accepted_at AS acceptedAt, telemetry_install_id AS installationReference", { installationReference: "must-not-be-returned" });
  const declinedEnv = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: declined } as unknown as Env;
  const declinedResult = await worker.fetch(request("/admin/privacy", undefined, { cookie: await sessionCookie("admin") }), declinedEnv);
  assert.equal("installationReference" in await declinedResult.json(), false);
});

test("five-minute Discord reconciliation does not increase the daily telemetry cadence", async () => {
  const database = new FakeDatabase();
  database.rows.set("telemetry_accepted_at AS acceptedAt", { acceptedAt: "2026-08-30T00:00:00Z", installId: "2f1c7d4a-81cb-4cef-934e-4c23181933fd" });
  database.rows.set("COUNT(*) AS count", { count: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, TELEMETRY_ENDPOINT: "https://telemetry.example.test/v1/report", RELEASE_VERSION: "0.1.3", DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let reports = 0;
  globalThis.fetch = async () => { reports += 1; return new Response(null, { status: 204 }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(reports, 0);
    await worker.scheduled({ cron: "0 3 * * *" }, env);
    assert.equal(reports, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("telemetry refuses endpoint credentials, query strings, and URL fragments", async () => {
  const database = new FakeDatabase();
  database.rows.set("telemetry_accepted_at AS acceptedAt", { acceptedAt: "2026-08-30T00:00:00Z", installId: "2f1c7d4a-81cb-4cef-934e-4c23181933fd" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, TELEMETRY_ENDPOINT: "https://user:secret@telemetry.example.test/v1?token=secret#fragment", RELEASE_VERSION: "0.1.0", DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let called = false;
  globalThis.fetch = async () => { called = true; return new Response(null, { status: 202 }); };
  try {
    const result = await worker.fetch(request("/admin/privacy", { telemetryAccepted: true }, { method: "PATCH", cookie: await sessionCookie("admin") }), env);
    assert.equal(result.status, 200);
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("scrubbed diagnostics are recorded only after telemetry consent", async () => {
  const encrypted = await encryptIntegration({ clientId: "client-id", clientSecret: "client-secret" }, sessionSecret);
  const accepted = new FakeDatabase();
  accepted.rows.set("auth_mode AS authMode", { authMode: "google" });
  accepted.rows.set("FROM encrypted_integrations", { id: "google-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z" });
  accepted.rows.set("telemetry_accepted_at AS acceptedAt", { acceptedAt: "2026-08-30T00:00:00Z" });
  const acceptedEnv = { APP_MODE: "configured", ALLOWED_ORIGIN: "not-a-valid-origin", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: accepted } as unknown as Env;
  assert.equal((await worker.fetch(request("/auth/google/start"), acceptedEnv)).status, 500);
  assert.ok(accepted.calls.some((call) => call.sql.includes("INSERT INTO telemetry_diagnostics") && call.values.includes("worker-internal")));

  const declined = new FakeDatabase();
  declined.rows.set("auth_mode AS authMode", { authMode: "google" });
  declined.rows.set("FROM encrypted_integrations", { id: "google-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z" });
  const declinedEnv = { APP_MODE: "configured", ALLOWED_ORIGIN: "not-a-valid-origin", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: declined } as unknown as Env;
  assert.equal((await worker.fetch(request("/auth/google/start"), declinedEnv)).status, 500);
  assert.equal(declined.calls.some((call) => call.sql.includes("INSERT INTO telemetry_diagnostics")), false);
});

test("destructive data operations are scoped and require exact confirmation", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const admin = await sessionCookie("admin");
  assert.equal((await worker.fetch(request("/admin/data", { scope: "roster", confirmation: "delete roster" }, { method: "DELETE", cookie: admin }), env)).status, 400);
  const result = await worker.fetch(request("/admin/data", { scope: "roster", confirmation: "DELETE ROSTER" }, { method: "DELETE", cookie: admin }), env);
  assert.equal(result.status, 200);
  const statements = database.batches.at(-1) ?? [];
  assert.ok(statements.some((call) => call.sql.includes("DELETE FROM members")));
  assert.equal(statements.some((call) => call.sql.includes("DELETE FROM meetings")), false);
  assert.ok(statements.some((call) => call.sql.includes("UPDATE users SET member_id = NULL")));
  assert.ok(statements.some((call) => call.sql.includes("data.roster_deleted")));
});

test("Admin can link roster members to dashboard accounts while non-rostered accounts remain supported", async () => {
  const database = new FakeDatabase(); database.rows.set("SELECT id FROM members", { id: "member-1" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/users", { localUsername: "member.operator", localPassword: "temporary password", memberId: "member-1", role: "operator" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 201); const statements = database.batches.at(-1) ?? []; const insert = statements.find((call) => call.sql.includes("INSERT INTO users")); assert.ok(insert?.sql.includes("member_id")); assert.ok(insert?.values.includes("member-1"));
  const unlinked = await worker.fetch(request("/admin/users", { email: "staff@example.test", memberId: null, role: "admin" }, { cookie: await sessionCookie("admin") }), env); assert.equal(unlinked.status, 201);
});

test("category backups are scope-labelled and never mix unrelated tables", async () => {
  const database = new FakeDatabase(); database.lists.set("FROM meetings", [{ id: "meeting-1" }]); database.lists.set("FROM attendance_events", []); database.lists.set("FROM attendance_corrections", []); database.lists.set("FROM discord_attendance_notifications", []); database.lists.set("FROM discord_attendance_recipients", []); database.lists.set("FROM discord_attendance_contests", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/data/backup?scope=meetings", undefined, { cookie: await sessionCookie("admin") }), env); assert.equal(result.status, 200); const backup = await result.json() as { scope: string; tables: Record<string, unknown> }; assert.equal(backup.scope, "meetings"); assert.deepEqual(Object.keys(backup.tables).sort(), ["attendance_corrections", "attendance_events", "discord_attendance_contests", "discord_attendance_notifications", "discord_attendance_recipients", "meetings"]); assert.equal("members" in backup.tables, false); assert.match(result.headers.get("content-disposition") ?? "", /meetings-backup/);
});

test("restore rejects a backup from another category before executing a batch", async () => {
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const backup = { product: "LancerLogin", schemaVersion: 2, scope: "roster", exportedAt: "2026-09-01T00:00:00.000Z", tables: { members: [] } };
  const result = await worker.fetch(request("/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup }, { cookie: await sessionCookie("admin") }), env); assert.equal(result.status, 400); assert.equal(database.batches.length, 0);
});

test("onboarding reset clears progress without deleting organization data", async () => {
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const admin = await sessionCookie("admin");
  assert.equal((await worker.fetch(request("/admin/setup/reset", { confirmation: "reset onboarding" }, { cookie: admin }), env)).status, 400);
  assert.equal((await worker.fetch(request("/admin/setup/reset", { confirmation: "RESET ONBOARDING" }, { cookie: admin }), env)).status, 200); const statements = database.batches.at(-1) ?? []; assert.ok(statements.some((call) => call.sql.includes("DELETE FROM setup_progress"))); assert.equal(statements.some((call) => /DELETE FROM members|DELETE FROM meetings|DELETE FROM installations/.test(call.sql)), false);
});

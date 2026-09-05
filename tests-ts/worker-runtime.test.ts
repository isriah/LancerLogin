import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
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
  async run() { this.database.calls.push(this); return { success: true, meta: { changes: this.database.runChanges(this.sql, this.values) } }; }
}

class FakeDatabase {
  calls: FakeStatement[] = [];
  batches: FakeStatement[][] = [];
  user?: { id: string; role: "admin" | "operator"; passwordHash: string | null; failedLoginCount?: number; lockedUntil?: string };
  rows = new Map<string, unknown>();
  lists = new Map<string, unknown[]>();
  runChangeHandler?: (sql: string, values: unknown[]) => number;
  prepare(sql: string) { return new FakeStatement(sql, this); }
  async batch(statements: FakeStatement[]) { this.batches.push(statements); return statements.map(() => ({ success: true })); }
  firstResult(sql: string, values: unknown[]) {
    for (const [fragment, value] of this.rows) if (sql.includes(fragment)) return typeof value === "function" ? (value as (sql: string, values: unknown[]) => unknown)(sql, values) : value;
    if (sql.includes("SELECT id, role FROM users") && sql.includes("active = 1")) {
      const id = String(values[0]);
      return { id, role: id.startsWith("operator") ? "operator" : "admin" };
    }
    if (sql.includes("FROM users")) return this.user;
    return undefined;
  }
  allResult(sql: string, values: unknown[]) { for (const [fragment, value] of this.lists) if (sql.includes(fragment)) return typeof value === "function" ? (value as (sql: string, values: unknown[]) => unknown[])(sql, values) : value; return undefined; }
  runChanges(sql: string, values: unknown[]) { return this.runChangeHandler?.(sql, values) ?? 1; }
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
const signedDiscordInteraction = (payload: unknown, privateKey: KeyObject, rawBody?: string) => {
  const body = rawBody ?? JSON.stringify(payload); const timestamp = String(Math.floor(Date.now() / 1000)); const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  return new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
};

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
  const installation = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO installations"));
  assert.equal(installation?.values.at(-1), 1);
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

test("only an Admin can change settings, dashboard access, or queue kiosk updates", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator");
  const branding = { organizationName: "Example Arts Club", primaryColor: "#123456", secondaryColor: "#abcdef", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 };
  assert.equal((await worker.fetch(request("/admin/branding", branding, { method: "PATCH", cookie }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/users", undefined, { cookie }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "install_latest" }, { cookie }), env)).status, 403);
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

test("stored meeting templates remain readable but template mutations are unavailable", async () => {
  const database = new FakeDatabase();
  database.lists.set("FROM meeting_templates", [{ id: "template-1", name: "Practice", title: "Practice meeting" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator");
  const stored = await worker.fetch(request("/meeting-templates", undefined, { cookie }), env);
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), { templates: [{ id: "template-1", name: "Practice", title: "Practice meeting" }] });
  assert.equal((await worker.fetch(request("/meeting-templates", { name: "New template" }, { cookie }), env)).status, 404);
  assert.equal((await worker.fetch(request("/meeting-templates/template-1", undefined, { method: "DELETE", cookie }), env)).status, 404);
  assert.equal(database.calls.some((call) => /(?:INSERT INTO|UPDATE|DELETE FROM) meeting_templates/.test(call.sql)), false);
});

test("branding stores a bounded image asset in D1 and rejects remote logo URLs", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const base = { organizationName: "Example Arts Club", subtitle: "Create together", primaryColor: "#123456", secondaryColor: "#abcdef", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 };
  const remote = await worker.fetch(request("/admin/branding", { ...base, logoData: "https://example.test/logo.png" }, { method: "PATCH", cookie }), env);
  assert.equal(remote.status, 400);
  const logoData = `data:image/png;base64,${Buffer.from("small-logo").toString("base64")}`;
  const saved = await worker.fetch(request("/admin/branding", { ...base, logoData }, { method: "PATCH", cookie }), env);
  assert.equal(saved.status, 200);
  const update = database.calls.find((call) => call.sql.includes("UPDATE organization_settings SET"));
  assert.ok(update?.sql.includes("logo_data"));
  assert.ok(update?.values.includes(logoData));
});

test("Admin can set a dated attendance reporting baseline and it is returned with meetings", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const base = { organizationName: "Example Arts Club", primaryColor: "#123456", secondaryColor: "#abcdef", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 };
  const invalid = await worker.fetch(request("/admin/branding", { ...base, attendanceReportingStartsOn: "08/26/2026" }, { method: "PATCH", cookie }), env);
  assert.equal(invalid.status, 400);
  const saved = await worker.fetch(request("/admin/branding", { ...base, attendanceReportingStartsOn: "2026-08-26" }, { method: "PATCH", cookie }), env);
  assert.equal(saved.status, 200);
  assert.ok(database.calls.some((call) => call.values.includes("2026-08-26")));
  assert.ok(database.calls.some((call) => call.values.includes("branding.updated")));
  const meetings = await worker.fetch(request("/meetings", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(meetings.status, 200);
  assert.ok(database.calls.some((call) => call.sql.includes("attendance_reporting_starts_on")));
});

test("Admin can configure bounded attendance anomaly thresholds with audit history", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const base = { organizationName: "Example Arts Club", primaryColor: "#123456", secondaryColor: "#abcdef", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 };
  assert.equal((await worker.fetch(request("/admin/branding", { ...base, anomalyLateThresholdMinutes: -1, anomalyEarlyThresholdMinutes: 10 }, { method: "PATCH", cookie }), env)).status, 400);
  assert.equal((await worker.fetch(request("/admin/branding", { ...base, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 1441 }, { method: "PATCH", cookie }), env)).status, 400);
  const saved = await worker.fetch(request("/admin/branding", { ...base, anomalyLateThresholdMinutes: 12, anomalyEarlyThresholdMinutes: 18 }, { method: "PATCH", cookie }), env);
  assert.equal(saved.status, 200);
  const update = database.calls.find((call) => call.sql.includes("anomaly_late_threshold_minutes = COALESCE"));
  assert.ok(update?.values.includes(12));
  assert.ok(update?.values.includes(18));
  const audit = database.calls.find((call) => call.values.includes("branding.updated"));
  assert.match(String(audit?.values.find((value) => typeof value === "string" && value.includes("anomalyLateThresholdMinutes"))), /"anomalyLateThresholdMinutes":12/);
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
  const memberInsert = database.batches.flat().find((call) => call.sql.includes("INSERT INTO members"));
  assert.ok(memberInsert?.values.some((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)), "new members receive a participation start date");
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

test("browser simulator check-ins are Admin-only and restricted to active meetings", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM simulated_kiosk_sessions", { name: "Browser test", active: 1, online: 1 });
  database.rows.set("FROM members", { id: "member-1" });
  database.rows.set("FROM meetings", { id: "meeting-1", startsAt: "2020-01-01T00:00:00.000Z", endsAt: "2030-01-01T00:00:00.000Z" });
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("FROM attendance_events", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const body = { action: "check-in", memberId: "ROSTER-001", meetingId: "meeting-1" };
  assert.equal((await worker.fetch(request("/admin/simulator", body, { cookie: await sessionCookie("operator") }), env)).status, 403);
  const accepted = await worker.fetch(request("/admin/simulator", body, { cookie: await sessionCookie("admin") }), env);
  assert.equal(accepted.status, 202);
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events") && call.values.includes("simulator")));
  assert.ok(database.calls.some((call) => call.values.includes("simulator.check_in")));

  const normalDatabase = new FakeDatabase();
  normalDatabase.rows.set("FROM simulated_kiosk_sessions", { name: "Browser test", active: 1, online: 1 });
  const normalEnv = { ...env, DB: normalDatabase } as unknown as Env;
  const rejected = await worker.fetch(request("/admin/simulator", { ...body, meetingId: "deleted-meeting" }, { cookie: await sessionCookie("admin") }), normalEnv);
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

test("Admin queues only fixed recovery and latest-stable update commands", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", active: 1, releaseVersion: "0.21.0", lastSeenAt: "2026-09-05T12:00:00.000Z" });
  database.rows.set("FROM kiosk_commands", { id: "command-1", type: "reload_display", createdAt: "2026-09-01T20:00:00.000Z" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const operator = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "reboot" }, { cookie: await sessionCookie("operator") }), env);
  assert.equal(operator.status, 403);
  const unsupported = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "run_shell" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(unsupported.status, 400);
  const queued = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "reload_display" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(queued.status, 202);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("INSERT INTO kiosk_commands") && call.values.includes("reload_display")));
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("'kiosk.command_queued'")));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://api.github.com/repos/isriah/LancerLogin/releases/latest");
    return new Response(JSON.stringify({ tag_name: "v0.22.0" }), { headers: { "content-type": "application/json" } });
  };
  try {
    const update = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "install_latest", targetVersion: "v9.9.9", shell: "must-not-store" }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(update.status, 202);
    const insert = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO kiosk_commands"));
    assert.ok(insert?.values.includes("install_latest"));
    assert.ok(insert?.values.includes("v0.22.0"));
    assert.ok(insert?.values.includes("0.21.0"));
    assert.equal(insert?.values.includes("v9.9.9"), false);
    assert.equal(insert?.values.includes("must-not-store"), false);
  } finally { globalThis.fetch = originalFetch; }

  const headers = { authorization: "Bearer paired-secret" };
  const pending = await worker.fetch(new Request("https://api.example.test/kiosk/commands", { headers }), env);
  assert.deepEqual(await pending.json(), { command: { id: "command-1", type: "reload_display", createdAt: "2026-09-01T20:00:00.000Z" } });
  const completed = await worker.fetch(new Request("https://api.example.test/kiosk/commands/command-1/result", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ success: true, message: "Display reload requested" }) }), env);
  assert.equal(completed.status, 200);
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosk_commands SET completed_at") && call.values.includes("kiosk-1") && call.values.includes("command-1")));
});

test("kiosk heartbeats durably reconcile requested update releases", async () => {
  const cases = [
    { reported: "0.22.0", before: "0.21.0", requested: "v0.22.0", completedAt: new Date().toISOString(), expected: "succeeded" },
    { reported: "0.23.0", before: "0.21.0", requested: "v0.22.0", completedAt: new Date().toISOString(), expected: "mismatch" },
    { reported: "0.21.0", before: "0.21.0", requested: "v0.22.0", completedAt: new Date(Date.now() - 6 * 60_000).toISOString(), expected: "unchanged" },
  ];
  for (const item of cases) {
    const database = new FakeDatabase();
    database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
    database.rows.set("command_type = 'install_latest'", { id: `update-${item.expected}`, completedAt: item.completedAt, requestedReleaseVersion: item.requested, releaseVersionBefore: item.before });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
    const heartbeat = new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, releaseVersion: item.reported, pendingEvents: 0, errorCategory: null }) });
    assert.equal((await worker.fetch(heartbeat, env)).status, 200);
    const resolution = database.calls.find((call) => call.sql.includes("SET resolution_status"));
    assert.equal(resolution?.values[0], item.expected);
    assert.equal(resolution?.values[1], item.reported);
  }
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
  const heartbeat = new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, releaseVersion: "0.1.0", uptimeSeconds: 3600, networkType: "wifi", networkSignal: 71, lastWifiScanAt: "2026-09-01T19:00:00.000Z", pendingEvents: 2, lastSyncAt: "2026-09-01T20:00:00.000Z", errorCategory: null, rawScan: "must-not-store", credential: "must-not-store" }) });
  const result = await worker.fetch(heartbeat, env);
  assert.equal(result.status, 200);
  const lookup = database.calls.find((call) => call.sql.includes("FROM kiosks"));
  assert.ok(lookup);
  assert.notEqual(lookup.values[0], "very-secret");
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosks SET last_seen_at")));
  assert.equal(database.calls.some((call) => call.values.includes("must-not-store")), false);
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
    const manual = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
    assert.equal(manual.status, 200);
    assert.deepEqual(await manual.json(), { changed: false, messageId: "message-1", online: true });
    assert.ok(database.calls.some((call) => call.values.includes("discord.kiosk_status_updated")));
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.length, 1, "unchanged online state should not edit Discord");

    database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: "2026-08-29T00:00:00Z", readerOnline: 1, releaseVersion: "0.1.3" });
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.length, 2);
    assert.equal(outbound[1].init?.method, "PATCH");
    assert.match(String(outbound[1].init?.body), /Front desk.*offline.*last seen 2026-08-29/);
  } finally { globalThis.fetch = originalFetch; }
});

test("missing tracked Discord kiosk status messages are replaced and the new mapping is idempotent", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: "2026-08-29T00:00:00Z", readerOnline: 1, releaseVersion: "0.1.3" });
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM integration_state", { externalId: "deleted-message", contentHash: "stale-content" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = []; let replacements = 0;
  globalThis.fetch = async (input, init) => {
    outbound.push({ input: String(input), init });
    if (init?.method === "PATCH") return new Response(JSON.stringify({ code: 10_008, message: "Unknown Message" }), { status: 404, headers: { "content-type": "application/json" } });
    replacements += 1;
    return new Response(JSON.stringify({ id: `replacement-message-${replacements}` }), { headers: { "content-type": "application/json" } });
  };
  try {
    const recovered = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { changed: true, messageId: "replacement-message-1", online: false });
    assert.equal(outbound.length, 2);
    assert.match(outbound[0].input, /channels\/223456789012345678\/messages\/deleted-message$/);
    assert.equal(outbound[0].init?.method, "PATCH");
    assert.match(outbound[1].input, /channels\/223456789012345678\/messages$/);
    assert.equal(outbound[1].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(outbound[1].init?.body)).allowed_mentions, { parse: [] });

    const replacementWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_state") && call.values.includes("replacement-message-1"));
    assert.ok(replacementWrite);
    database.rows.set("FROM integration_state", { externalId: "replacement-message-1", contentHash: replacementWrite.values[1] });
    const unchanged = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
    assert.equal(unchanged.status, 200);
    assert.deepEqual(await unchanged.json(), { changed: false, messageId: "replacement-message-1", online: false });
    assert.equal(outbound.length, 2, "the persisted replacement mapping should prevent a follow-up Discord request");

    database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.1.3" });
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.length, 4, "scheduled reconciliation should also replace one missing tracked message");
    assert.equal(outbound[2].init?.method, "PATCH");
    assert.equal(outbound[3].init?.method, "POST");
    assert.ok(database.calls.some((call) => call.sql.includes("INSERT INTO integration_state") && call.values.includes("replacement-message-2")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord kiosk status does not recreate a message for unrelated Discord failures", async () => {
  for (const failure of [
    { status: 404, body: { code: 10_003, message: "Unknown Channel" } },
    { status: 500, body: { message: "Internal Server Error" } },
  ]) {
    const database = new FakeDatabase();
    const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
    database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: "2026-08-29T00:00:00Z", readerOnline: 1, releaseVersion: "0.1.3" });
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
    database.rows.set("FROM integration_state", { externalId: "tracked-message", contentHash: "stale-content" });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; let outbound = 0;
    globalThis.fetch = async () => { outbound += 1; return new Response(JSON.stringify(failure.body), { status: failure.status, headers: { "content-type": "application/json" } }); };
    try {
      const result = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
      assert.equal(result.status, 502);
      assert.match((await result.json() as { error: string }).error, new RegExp(`\\(${failure.status}\\)`));
      assert.equal(outbound, 1);
      assert.equal(database.calls.some((call) => call.sql.includes("INSERT INTO integration_state")), false);
    } finally { globalThis.fetch = originalFetch; }
  }
});

test("Admins manage ordered meeting-weight categories while Operators receive only active choices", async () => {
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const admin = await sessionCookie("admin"); const operator = await sessionCookie("operator");
  database.lists.set("SELECT id, name, weight, minimum_duration_minutes AS minimumDurationMinutes", [{ id: "weight-2", name: "Long", weight: 2, minimumDurationMinutes: 180, position: 0, active: 1 }]);
  assert.equal((await worker.fetch(request("/meeting-weight-categories", undefined, { cookie: operator }), env)).status, 200);
  assert.equal((await worker.fetch(request("/admin/meeting-weight-categories", { name: "Blocked", weight: 2 }, { cookie: operator }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/meeting-weight-categories", { name: "Invalid", weight: 0 }, { cookie: admin }), env)).status, 400);
  database.rows.set("COALESCE(MAX(position)", { position: 0 });
  const created = await worker.fetch(request("/admin/meeting-weight-categories", { name: "Extended rehearsal", weight: 2.5, minimumDurationMinutes: 180 }, { cookie: admin }), env);
  assert.equal(created.status, 201); const createBatch = database.batches.at(-1) ?? []; const insert = createBatch.find((call) => call.sql.includes("INSERT INTO meeting_weight_categories")); assert.ok(insert); assert.deepEqual(insert.values.slice(1, 5), ["Extended rehearsal", 2.5, 180, 1]); assert.ok(createBatch.some((call) => call.sql.includes("meeting_weight_category.created")));
  database.lists.set("SELECT id FROM meeting_weight_categories", [{ id: "weight-2" }, { id: "weight-3" }]);
  const reordered = await worker.fetch(request("/admin/meeting-weight-categories/order", { orderedIds: ["weight-3", "weight-2"] }, { method: "PATCH", cookie: admin }), env); assert.equal(reordered.status, 200); assert.equal(database.batches.at(-1)?.filter((call) => call.sql.includes("UPDATE meeting_weight_categories SET position")).length, 2);
});

test("category edits and retirement do not rewrite historical meeting snapshots", async () => {
  const database = new FakeDatabase(); database.rows.set("SELECT id, name, weight, minimum_duration_minutes AS minimumDurationMinutes, position, active FROM meeting_weight_categories", { id: "weight-2", name: "Long", weight: 2, minimumDurationMinutes: 180, position: 0, active: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const admin = await sessionCookie("admin");
  const edited = await worker.fetch(request("/admin/meeting-weight-categories/weight-2", { name: "Extended", weight: 3, minimumDurationMinutes: 240 }, { method: "PATCH", cookie: admin }), env); assert.equal(edited.status, 200);
  const update = database.calls.find((call) => call.sql.includes("UPDATE meeting_weight_categories SET name")); assert.deepEqual(update?.values.slice(0, 3), ["Extended", 3, 240]); assert.equal(database.calls.some((call) => call.sql.includes("UPDATE meetings")), false);
  const retired = await worker.fetch(request("/admin/meeting-weight-categories/weight-2", { active: false }, { method: "PATCH", cookie: admin }), env); assert.equal(retired.status, 200); assert.ok(database.calls.some((call) => call.values.includes("meeting_weight_category.retired"))); assert.equal(database.calls.some((call) => call.sql.includes("UPDATE meetings")), false);
});

test("meeting creation uses the first matching weight rule and permits an explicit default", async () => {
  const database = new FakeDatabase(); database.rows.set("time_zone AS timeZone", { timeZone: "UTC", lateScanMinutes: 30 }); database.rows.set("SELECT id, name, weight FROM meeting_weight_categories", { id: "weight-long", name: "Long meeting", weight: 2 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const cookie = await sessionCookie("operator");
  const automatic = await worker.fetch(request("/meetings", { title: "Long rehearsal", startsAt: "2026-09-10T18:00:00.000Z", endsAt: "2026-09-10T22:00:00.000Z", required: true }, { cookie }), env); assert.equal(automatic.status, 201);
  const weightedInsert = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO meetings")); assert.deepEqual(weightedInsert?.values.slice(-3), ["weight-long", "Long meeting", 2]);
  const explicitDefault = await worker.fetch(request("/meetings", { title: "Manual default", startsAt: "2026-09-11T18:00:00.000Z", endsAt: "2026-09-11T22:00:00.000Z", required: true, weightCategoryId: null }, { cookie }), env); assert.equal(explicitDefault.status, 201);
  const defaultInsert = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO meetings")); assert.deepEqual(defaultInsert?.values.slice(-3), [null, null, 1]);
  assert.ok(database.calls.find((call) => call.sql.includes("minimum_duration_minutes <= ?"))?.values.includes(240));
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

test("canonical meeting detail is role-protected, durable, and reports its attendance close", async () => {
  const database = new FakeDatabase();
  database.rows.set("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, notes, is_test AS isTest", { id: "meeting-older-than-list", title: "Archived rehearsal", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z", required: 1, notes: "Historical context", recurrenceFrequency: "monthly", recurrenceSequence: 12 });
  database.rows.set("SELECT late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 45 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/meetings/meeting-older-than-list", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { meeting: { id: string; attendanceClosesAt: string } };
  assert.equal(body.meeting.id, "meeting-older-than-list");
  assert.equal(body.meeting.attendanceClosesAt, "2026-09-01T22:45:00.000Z");
  assert.ok(database.calls.some((call) => call.sql.includes("id = ? AND deleted_at IS NULL") && call.values.includes("meeting-older-than-list")));

  const missing = await worker.fetch(request("/meetings/missing", undefined, { cookie: await sessionCookie("operator") }), { ...env, DB: new FakeDatabase() } as unknown as Env);
  assert.equal(missing.status, 404);
  assert.equal((await worker.fetch(request("/meetings/meeting-older-than-list"), env)).status, 401);
});

test("Reports may request inactive roster history without changing the default attendance roster", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM meetings WHERE installation_id = 'primary' AND id = ?", { startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" });
  database.rows.set("SELECT late_scan_minutes", { lateScanMinutes: 30 });
  database.lists.set("SELECT m.id AS memberId", [{ memberId: "inactive-member", externalId: "OLD-1", firstName: "Former", lastName: "Member" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/attendance?meetingId=meeting-1&includeInactive=1", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  const attendanceQuery = database.calls.find((call) => call.sql.includes("SELECT m.id AS memberId"));
  assert.ok(attendanceQuery?.sql.includes("m.active = 1 OR ? = 1"));
  assert.equal(attendanceQuery?.values.at(-1), 1);
});

test("member history is stable by roster ID and available to Operators", async () => {
  const database = new FakeDatabase();
  database.rows.set("external_id = ?", { id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", discordUserId: "123456789012", active: 0, attendanceRequiredFrom: "2026-09-02" });
  database.rows.set("anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes", { lateScanMinutes: 30, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 10 });
  database.lists.set("FROM meetings meeting", [{ meetingId: "meeting-1", title: "Pre-start meeting", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z", checkedInAt: "2026-09-01T20:05:00.000Z", checkedOutAt: "2026-09-01T21:10:00.000Z" }, { meetingId: "meeting-2", title: "Practice", startsAt: "2026-09-02T20:00:00.000Z", endsAt: "2026-09-02T22:00:00.000Z", correction: "excused", reason: "Medical appointment" }, { meetingId: "meeting-3", title: "Build", startsAt: "2026-09-03T20:00:00.000Z", endsAt: "2026-09-03T22:00:00.000Z", checkedInAt: "2026-09-03T20:12:00.000Z", checkedOutAt: "2026-09-03T21:42:00.000Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/members/A-101/history", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { member: { active: boolean; memberId: string; discordUserId?: string; attendanceRequiredFrom?: string }; history: Array<{ disposition: string; checkedInAt?: string; checkedOutAt?: string; reason?: string }>; meanAnomalyMinutes: number|null };
  assert.deepEqual(body.member, { id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", discordUserId: "123456789012", active: false, attendanceRequiredFrom: "2026-09-02" });
  assert.doesNotMatch(JSON.stringify(body), /token|ciphertext|publicKey|guildId|channelId/i);
  assert.equal(body.history.length, 2);
  assert.equal(body.history[0].disposition, "excused");
  assert.equal(body.history[0].reason, "Medical appointment");
  assert.equal(body.meanAnomalyMinutes, 15);
  const settingsQuery = database.calls.find((call) => call.sql.includes("anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes"));
  assert.doesNotMatch(settingsQuery?.sql ?? "", /attendance_reporting_starts_on/);

  const unauthorized = await worker.fetch(request("/admin/members/A-101/history"), env);
  assert.equal(unauthorized.status, 401);
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

test("authenticated kiosk can fetch active roster labels without biometric data", async () => {
  const database = new FakeDatabase(); database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" }); database.lists.set("SELECT external_id AS memberId", [{ memberId: "R-1", firstName: "Avery", lastName: "Stone" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(new Request("https://api.example.test/kiosk/roster", { headers: { authorization: "Bearer very-secret" } }), env);
  assert.equal(result.status, 200); const text = await result.text(); assert.match(text, /Avery/); assert.doesNotMatch(text, /fingerprint|template|biometric/i);
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

test("Operator can update only an occurrence or this and future series occurrences", async () => {
  const future = new FakeDatabase();
  future.rows.set("series_id = ? AND id = ?", { startsAt: "2026-09-08T20:00:00.000Z" });
  future.lists.set("series_id = ? AND starts_at >= ?", [
    { id: "meeting-2", startsAt: "2026-09-08T20:00:00.000Z" },
    { id: "meeting-3", startsAt: "2026-09-15T20:00:00.000Z" },
  ]);
  future.rows.set("SELECT id, name, weight FROM meeting_weight_categories", { id: "weight-3", name: "Major event", weight: 3 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: future } as unknown as Env;
  const result = await worker.fetch(request("/meeting-series/series-1", { meetingId: "meeting-2", title: "Updated series", startsAt: "2026-09-08T21:00:00.000Z", endsAt: "2026-09-08T23:00:00.000Z", required: false, notes: "Shifted", weightCategoryId: "weight-3" }, { method: "PATCH", cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  const updates = future.batches.at(-1)?.filter((call) => call.sql.includes("UPDATE meetings SET")) ?? [];
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map((call) => call.values.at(-1)), ["meeting-2", "meeting-3"]);
  assert.ok(updates.every((call) => call.sql.includes("weight_category_id") && call.values.includes("weight-3") && call.values.includes(3)));
  assert.ok(future.batches.at(-1)?.some((call) => call.sql.includes("meeting.series_updated")));
});

test("Operator can hide one meeting or this and future series occurrences", async () => {
  const single = new FakeDatabase();
  single.rows.set("series_id AS seriesId", { id: "meeting-1", seriesId: null, startsAt: "2026-09-01T20:00:00.000Z" });
  single.rows.set("SELECT event_id AS eventId", { eventId: "ll0123456789abcdef0123456789abcdef0123456789abcdef" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: single } as unknown as Env;
  const occurrence = await worker.fetch(request("/meetings/meeting-1", { scope: "occurrence" }, { method: "DELETE", cookie: await sessionCookie("operator") }), env);
  assert.equal(occurrence.status, 200);
  assert.ok(single.calls.some((call) => call.sql.includes("UPDATE meetings SET deleted_at") && call.values.includes("meeting-1")));
  assert.ok(single.calls.some((call) => call.values.includes("meeting.deleted")));
  assert.deepEqual((await occurrence.json() as { calendarSync: unknown }).calendarSync, { synced: 0, queued: 1, failed: 0 });
  assert.ok(single.batches.some((batch) => batch.some((call) => call.sql.includes("google_calendar_operations") && call.sql.includes("'delete'"))));

  const future = new FakeDatabase();
  future.rows.set("series_id AS seriesId", { id: "meeting-3", seriesId: "series-1", startsAt: "2026-09-15T20:00:00.000Z" });
  const futureResult = await worker.fetch(request("/meetings/meeting-3", { scope: "future" }, { method: "DELETE", cookie: await sessionCookie("operator") }), { ...env, DB: future } as unknown as Env);
  assert.equal(futureResult.status, 200);
  assert.ok(future.calls.some((call) => call.sql.includes("series_id = ?") && call.sql.includes("starts_at >= ?") && call.values.includes("series-1")));
  assert.ok(future.calls.some((call) => call.values.includes("meeting.series_deleted")));
});

test("Operator can immediately restore a soft-deleted meeting or future series occurrences", async () => {
  const single = new FakeDatabase();
  single.rows.set("deleted_at IS NOT NULL", { id: "meeting-1", seriesId: null, startsAt: "2026-09-01T20:00:00.000Z" });
  single.rows.set("SELECT m.generation", { generation: 1, startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: single } as unknown as Env;
  const occurrence = await worker.fetch(request("/meetings/meeting-1/restore", { scope: "occurrence" }, { method: "POST", cookie: await sessionCookie("operator") }), env);
  assert.equal(occurrence.status, 200);
  assert.ok(single.calls.some((call) => call.sql.includes("SET deleted_at = NULL") && call.values.includes("meeting-1")));
  assert.ok(single.calls.some((call) => call.values.includes("meeting.restored")));
  assert.deepEqual((await occurrence.json() as { calendarSync: unknown }).calendarSync, { synced: 0, queued: 1, failed: 0 });
  assert.ok(single.batches.some((batch) => batch.some((call) => call.sql.includes("google_calendar_operations") && call.sql.includes("'upsert'"))));

  const future = new FakeDatabase();
  future.rows.set("deleted_at IS NOT NULL", { id: "meeting-3", seriesId: "series-1", startsAt: "2026-09-15T20:00:00.000Z" });
  const restored = await worker.fetch(request("/meetings/meeting-3/restore", { scope: "future" }, { method: "POST", cookie: await sessionCookie("operator") }), { ...env, DB: future } as unknown as Env);
  assert.equal(restored.status, 200);
  assert.ok(future.calls.some((call) => call.sql.includes("SET deleted_at = NULL") && call.values.includes("series-1")));
  assert.ok(future.calls.some((call) => call.values.includes("meeting.series_restored")));
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
  database.lists.set("FROM meetings mt", [{ meeting: "Studio, weekly", meetingStart: "2026-09-01T20:00:00Z", meetingEnd: "2026-09-01T22:00:00Z", weightCategory: "Extended", attendanceWeight: 2.5, memberId: "=HYPERLINK(\"https://example.test\")", firstName: "+Avery", lastName: "Stone", disposition: "present", checkedInAt: "2026-09-01T20:02:00Z", checkedOutAt: "2026-09-01T21:58:00Z", reason: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/exports/attendance.csv"), env)).status, 401);
  const result = await worker.fetch(request("/exports/attendance.csv", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await result.text();
  assert.match(csv, /"Studio, weekly"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /'\+Avery/);
  assert.match(csv, /weightCategory,attendanceWeight/); assert.match(csv, /Extended,2\.5/); assert.match(csv, /present,2\.5,2\.5,2\.5/);
  const exportQuery = database.calls.find((call) => call.sql.includes("FROM meetings mt"));
  assert.match(exportQuery?.sql ?? "", /ORDER BY c\.created_at DESC/);
  assert.match(exportQuery?.sql ?? "", /e\.action = 'check_in'/);
  assert.match(exportQuery?.sql ?? "", /e\.action = 'check_out'/);
  assert.match(exportQuery?.sql ?? "", /mt\.attendance_weight AS attendanceWeight/);
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

test("integration status exposes enablement without credentials and capabilities are role-safe", async () => {
  const database = new FakeDatabase();
  database.rows.set("google_enabled AS googleEnabled", { googleEnabled: 1, resendEnabled: 0, discordEnabled: 1 });
  database.lists.set("SELECT i.provider", [{ provider: "google", updatedAt: "2026-09-03T00:00:00Z", verifiedAt: "2026-09-03T00:01:00Z", verificationPending: 0 }]);
  database.lists.set("SELECT provider, verified_at AS verifiedAt", [{ provider: "google", verifiedAt: "2026-09-03T00:01:00Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const status = await worker.fetch(request("/admin/integrations", undefined, { cookie: await sessionCookie("admin") }), env);
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json() as { integrations: Array<{ provider: string; enabled: boolean; configured: boolean; state: string }> }).integrations.map(({ provider, enabled, configured, state }) => ({ provider, enabled, configured, state })), [
    { provider: "google", enabled: true, configured: true, state: "configured" },
    { provider: "resend", enabled: false, configured: false, state: "disabled" },
    { provider: "discord", enabled: true, configured: false, state: "not_configured" },
    { provider: "google_calendar", enabled: false, configured: false, state: "disabled" },
  ]);
  assert.equal((await worker.fetch(request("/integrations/capabilities"), env)).status, 401);
  const capabilities = await worker.fetch(request("/integrations/capabilities", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), { integrations: { google: { enabled: true, configured: true }, resend: { enabled: false, configured: false }, discord: { enabled: true, configured: false }, google_calendar: { enabled: false, configured: false } } });
});

test("Admins can persist enablement and disabled providers cannot start workflows", async () => {
  const database = new FakeDatabase();
  database.rows.set("google_enabled AS googleEnabled", { googleEnabled: 0, resendEnabled: 0, discordEnabled: 0 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const enabled = await worker.fetch(request("/admin/integrations/discord", { enabled: true }, { method: "PATCH", cookie: await sessionCookie("admin") }), env);
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { provider: "discord", enabled: true });
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("discord_enabled = ?") && call.values[0] === 1));
  assert.ok(database.calls.some((call) => call.values.includes("integration.enabled")));
  const resend = await worker.fetch(request("/admin/integrations/resend/verify/start", { email: "admin@example.test" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(resend.status, 409);
  const discord = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
  assert.equal(discord.status, 503);
  assert.equal((await worker.fetch(request("/discord/kiosk-status", {}), env)).status, 401);
});

test("Google disablement requires an active Admin local credential and updates sign-in mode", async () => {
  const blockedDatabase = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: blockedDatabase } as unknown as Env;
  const blocked = await worker.fetch(request("/admin/integrations/google", { enabled: false }, { method: "PATCH", cookie: await sessionCookie("admin") }), env);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json() as { error: string }).error, /no active Admin has a usable local sign-in/);
  assert.equal(blockedDatabase.batches.length, 0);

  const database = new FakeDatabase();
  database.rows.set("password_hash IS NOT NULL", { id: "admin-1" });
  const allowed = await worker.fetch(request("/admin/integrations/google", { enabled: false }, { method: "PATCH", cookie: await sessionCookie("admin") }), { ...env, DB: database } as unknown as Env);
  assert.equal(allowed.status, 200);
  assert.ok(database.batches[0].some((call) => call.sql.includes("google_enabled = ?") && call.values[0] === 0));
  assert.ok(database.batches[0].some((call) => call.sql.includes("auth_mode = CASE")));
  assert.ok(database.calls.some((call) => call.values.includes("integration.disabled")));
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
  database.rows.set("google_enabled AS googleEnabled", { googleEnabled: 0, resendEnabled: 1, discordEnabled: 0 });
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

test("Discord verification reconciles the two managed guild commands before its signed user click", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); outbound.push({ input: url, init });
    if (url.endsWith("/users/@me")) return Response.json({ id: "bot-1" });
    if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: "103456789012345678" });
    if (url.endsWith("/guilds/123456789012345678")) return Response.json({ id: "123456789012345678" });
    if (url.endsWith("/channels/223456789012345678")) return Response.json({ guild_id: "123456789012345678", type: 0 });
    if (url.endsWith("/commands")) return Response.json((JSON.parse(String(init?.body)) as Record<string, unknown>[]).map((command, index) => ({ ...command, id: `command-${index + 1}`, application_id: "103456789012345678", guild_id: "123456789012345678", options: Array.isArray(command.options) ? command.options.map((option) => ({ ...option, name_localizations: null, description_localizations: null, autocomplete: false })) : undefined })));
    if (url.endsWith("/channels/223456789012345678/messages")) return Response.json({ id: "verification-message-1" });
    throw new Error(`Unexpected live request: ${url}`);
  };
  try {
    const started = await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
    assert.equal(started.status, 202); assert.match(outbound[0].input, /users\/@me$/); assert.match(outbound[1].input, /oauth2\/applications\/@me$/); assert.match(outbound[2].input, /guilds\/123456789012345678$/); assert.match(outbound[3].input, /channels\/223456789012345678$/); assert.match(outbound[4].input, /applications\/103456789012345678\/guilds\/123456789012345678\/commands$/); assert.equal(outbound[4].init?.method, "PUT"); assert.match(outbound[5].input, /channels\/223456789012345678\/messages$/);
    assert.equal(outbound.every(({ input }) => input.startsWith("https://discord.com/api/v10/")), true); assert.equal(outbound.some(({ input }) => /\/applications\/103456789012345678\/commands$/.test(input)), false);
    assert.deepEqual(JSON.parse(String(outbound[4].init?.body)), [{ name: "pair", type: 1, description: "Link your Discord account to your LancerLogin member ID", options: [{ name: "member-id", description: "Your LancerLogin member ID", type: 3, required: true }] }, { name: "attendance-report", type: 1, description: "Privately view your current LancerLogin attendance report" }]);
    const payload = JSON.parse(String(outbound[5].init?.body)); const customId = payload.components[0].components[0].custom_id as string; const token = customId.slice("lancerlogin-verify:".length);
    const challengeWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_verification_challenges")); assert.ok(challengeWrite); assert.equal(challengeWrite.values[0], createHash("sha256").update(token).digest("base64url")); assert.equal(challengeWrite.values.includes(token), false);
    database.rows.set("FROM integration_verification_challenges", { challengeHash: challengeWrite.values[0], target: "123456789012345678", externalId: "verification-message-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const body = JSON.stringify({ type: 3, guild_id: "123456789012345678", data: { custom_id: customId }, member: { user: { id: "323456789012345678" } }, message: { id: "verification-message-1" } }); const timestamp = String(Math.floor(Date.now() / 1000)); const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
    const interaction = new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
    const verified = await worker.fetch(interaction, env); assert.equal(verified.status, 200); assert.match(JSON.stringify(await verified.json()), /LancerLogin is verified/); assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE encrypted_integrations SET verified_at")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord configuration requires and encrypts its application and guild identifiers", async () => {
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const config = { botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) };
  assert.equal((await worker.fetch(request("/admin/integrations/discord", config, { method: "PUT", cookie: await sessionCookie("operator") }), env)).status, 403);
  for (const invalid of [{ ...config, applicationId: "" }, { ...config, applicationId: "not-a-snowflake" }, { ...config, guildId: "123" }, { ...config, channelId: "channel" }]) assert.equal((await worker.fetch(request("/admin/integrations/discord", invalid, { method: "PUT", cookie: await sessionCookie("admin") }), env)).status, 400);
  const saved = await worker.fetch(request("/admin/integrations/discord", config, { method: "PUT", cookie: await sessionCookie("admin") }), env); assert.equal(saved.status, 200); const publicBody = await saved.text();
  for (const secret of Object.values(config)) assert.equal(publicBody.includes(secret), false);
  const write = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO encrypted_integrations")); assert.ok(write); for (const secret of Object.values(config)) assert.equal(write.values.some((value) => String(value).includes(secret)), false);
});

test("Discord command setup is repeat-safe across reruns and credential rotation", async () => {
  const database = new FakeDatabase(); const config = { botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) };
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(config, sessionSecret), verifiedAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const commandBodies: unknown[] = []; const authorizations: string[] = [];
  globalThis.fetch = async (input, init) => { const url = String(input); authorizations.push(String((init?.headers as Record<string, string>).authorization)); if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: config.applicationId }); if (url.endsWith(`/guilds/${config.guildId}`)) return Response.json({ id: config.guildId }); if (url.endsWith(`/channels/${config.channelId}`)) return Response.json({ guild_id: config.guildId, type: 0 }); if (url.endsWith("/commands")) { const body = JSON.parse(String(init?.body)) as Record<string, unknown>[]; commandBodies.push(body); return Response.json(body.map((item, index) => ({ ...item, id: `command-${index}`, application_id: config.applicationId, guild_id: config.guildId }))); } if (url.includes("/channels/")) return Response.json({ id: crypto.randomUUID() }); return Response.json({ id: "bot-1" }); };
  try {
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    const rotated = { ...config, botToken: "rotated-discord-secret" }; database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(rotated, sessionSecret), verifiedAt: null });
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    assert.equal(commandBodies.length, 3); assert.deepEqual(commandBodies[0], commandBodies[1]); assert.deepEqual(commandBodies[1], commandBodies[2]); assert.ok(authorizations.includes("Bot rotated-discord-secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord command setup reports identity, credential, permission, rate-limit, validation, and partial failures safely", async () => {
  const base = { botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) };
  const run = async (failure: "application" | "guild" | "channel" | "credential" | "permission" | "rate" | "validation" | "partial" | "message") => {
    const database = new FakeDatabase(); database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(base, sessionSecret), verifiedAt: null }); const calls: string[] = [];
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; globalThis.fetch = async (input, init) => { const url = String(input); calls.push(url); if (failure === "credential" && url.endsWith("/users/@me")) return Response.json({ message: "401: Unauthorized" }, { status: 401 }); if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: failure === "application" ? "999999999999999999" : base.applicationId }); if (url.endsWith(`/guilds/${base.guildId}`)) return Response.json({ id: failure === "guild" ? "999999999999999999" : base.guildId }); if (url.endsWith(`/channels/${base.channelId}`)) return Response.json({ guild_id: failure === "channel" ? "999999999999999999" : base.guildId, type: 0 }); if (url.endsWith("/commands")) { if (failure === "permission") return Response.json({ message: "Missing Access" }, { status: 403 }); if (failure === "rate") return Response.json({ message: "rate limited", retry_after: 0 }, { status: 429 }); if (failure === "validation") return Response.json({ message: "Invalid Form Body" }, { status: 400 }); const body = JSON.parse(String(init?.body)) as Record<string, unknown>[]; const confirmed = body.map((item, index) => ({ ...item, id: `command-${index}`, application_id: base.applicationId, guild_id: base.guildId })); return Response.json(failure === "partial" ? confirmed.slice(0, 1) : confirmed); } if (url.endsWith(`/channels/${base.channelId}/messages`) && failure === "message") return Response.json({ message: "Missing Access" }, { status: 403 }); if (url.includes("/channels/")) return Response.json({ id: "verification-message-1" }); return Response.json({ id: "bot-1" }); };
    try { const result = await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env); return { result, database, calls }; } finally { globalThis.fetch = originalFetch; }
  };
  const expectations = { application: /does not belong to this bot token/, guild: /different server/, channel: /attendance channel must be a text channel/, credential: /rejected the saved bot token/, permission: /denied command management/, rate: /rate limiting command setup/, validation: /rejected the managed command configuration/, partial: /did not confirm both managed commands/, message: /missing a required permission/ } as const;
  for (const [failure, pattern] of Object.entries(expectations) as [keyof typeof expectations, RegExp][]) {
    const { result, database, calls } = await run(failure); assert.ok([400, 502, 503].includes(result.status), failure); const payload = JSON.stringify(await result.json()); assert.match(payload, pattern, failure); assert.doesNotMatch(payload, /discord-secret/, failure); assert.equal(database.calls.some((call) => call.sql.includes("INSERT INTO integration_verification_challenges")), false, failure); if (failure !== "message") assert.equal(calls.some((url) => url.includes(`/channels/${base.channelId}/messages`)), false, failure);
  }
});

test("signed Discord attendance reports match canonical reporting and attendance semantics", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-09-04T00:00:00Z", verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 });
  database.lists.set("discord_user_id = ?", [{ id: "member-1", active: 1, rosterAddedAt: "2026-08-01T00:00:00Z", attendanceRequiredFrom: "2026-08-15" }]);
  database.rows.set("late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on", { lateScanMinutes: 30, attendanceReportingStartsOn: "2026-09-01" });
  database.lists.set("SELECT mt.title", [
    { title: "Complete attendance", startsAt: "2026-09-07T20:00:00Z", endsAt: "2026-09-07T21:00:00Z", attendanceWeight: 2, checkedInAt: "2026-09-07T20:01:00Z", checkedOutAt: "2026-09-07T20:59:00Z" },
    { title: "No scan", startsAt: "2026-09-06T20:00:00Z", endsAt: "2026-09-06T21:00:00Z", attendanceWeight: 3 },
    { title: "Corrected present", startsAt: "2026-09-05T20:00:00Z", endsAt: "2026-09-05T21:00:00Z", correction: "present" },
    { title: "Excused meeting", startsAt: "2026-09-04T20:00:00Z", endsAt: "2026-09-04T21:00:00Z", correction: "excused" },
    { title: "Optional meetup", startsAt: "2026-09-03T20:00:00Z", endsAt: "2026-09-03T21:00:00Z" },
    { title: "Corrected absent", startsAt: "2026-09-02T20:00:00Z", endsAt: "2026-09-02T21:00:00Z", checkedInAt: "2026-09-02T20:01:00Z", checkedOutAt: "2026-09-02T20:59:00Z", correction: "absent" },
    { title: "Partial scan", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T21:00:00Z", checkedInAt: "2026-09-01T20:01:00Z" },
  ]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(signedDiscordInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: "323456789012345678" } } }, privateKey), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { type: number; data: { content: string; flags: number; allowed_mentions: { parse: string[] } } };
  assert.equal(body.type, 4); assert.equal(body.data.flags, 64); assert.deepEqual(body.data.allowed_mentions, { parse: [] });
  assert.match(body.data.content, /Attendance: \*\*30%\*\* \(3 of 10 weighted meeting points across 7 completed meetings\)/);
  for (const expected of ["No scan", "Optional meetup", "Corrected absent", "Partial scan"]) assert.match(body.data.content, new RegExp(expected));
  assert.doesNotMatch(body.data.content, /Complete attendance|Corrected present|Excused meeting/);
  const reportQuery = database.calls.find((call) => call.sql.includes("SELECT mt.title"));
  assert.match(reportQuery?.sql ?? "", /mt\.deleted_at IS NULL/); assert.match(reportQuery?.sql ?? "", /mt\.is_test = 0/); assert.match(reportQuery?.sql ?? "", /mt\.ends_at <= \?/);
  assert.match(reportQuery?.sql ?? "", /mt\.attendance_weight AS attendanceWeight/); assert.match(reportQuery?.sql ?? "", /ORDER BY c\.created_at DESC, c\.id DESC/); assert.doesNotMatch(reportQuery?.sql ?? "", /mt\.required = 1/);
  assert.deepEqual(reportQuery?.values.slice(-2), ["2026-08-15", "2026-09-01"]);
});

test("Discord attendance reports handle empty and provider-bounded histories", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  const run = async (rows: unknown[]) => {
    const database = new FakeDatabase(); database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 }); database.lists.set("discord_user_id = ?", [{ id: "member-1", active: 1, rosterAddedAt: "2026-01-01T00:00:00Z" }]); database.rows.set("late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on", { lateScanMinutes: 30 }); database.lists.set("SELECT mt.title", rows);
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(signedDiscordInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: "323456789012345678" } } }, privateKey), env);
    return (await result.json() as { data: { content: string } }).data.content;
  };
  const empty = await run([]); assert.match(empty, /Attendance: \*\*0%\*\* \(0 of 0 weighted meeting points across 0 completed meetings\)/); assert.match(empty, /No absent meetings/);
  const long = await run(Array.from({ length: 80 }, (_, index) => ({ title: `Very long required or optional meeting ${index + 1} ${"x".repeat(90)}`, startsAt: `2026-08-${String(index % 28 + 1).padStart(2, "0")}T20:00:00Z`, endsAt: "2020-01-01T21:00:00Z" })));
  assert.ok(long.length <= 2_000); assert.match(long, /additional absent meetings omitted to fit Discord's response limit/); assert.ok((long.match(/^• /gm) ?? []).length < 80);
});

test("managed attendance-report button uses the canonical private slash-command response", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  database.rows.set("state_key = 'channel-manager-howto'", { externalId: "attendance-help-1" });
  database.rows.set("late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on", { lateScanMinutes: 30, attendanceReportingStartsOn: "2026-09-01" });
  database.lists.set("discord_user_id = ?", [{ id: "member-1", active: 1, rosterAddedAt: "2026-08-01T00:00:00Z" }]);
  database.lists.set("SELECT mt.title", [{ title: "Missed rehearsal", startsAt: "2026-09-03T20:00:00Z", endsAt: "2026-09-03T21:00:00Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const slash = await worker.fetch(signedDiscordInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: "323456789012345678" } } }, privateKey), env);
  const button = await worker.fetch(signedDiscordInteraction({ type: 3, guild_id: "123456789012345678", channel_id: "223456789012345678", data: { custom_id: "lancerlogin-attendance-report" }, member: { user: { id: "323456789012345678" } }, message: { id: "attendance-help-1" } }, privateKey), env);
  assert.deepEqual(await button.json(), await slash.json());
});

test("managed attendance-report button rejects unavailable, unlinked, stale, and tampered requests privately", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  const base = { type: 3, guild_id: "123456789012345678", channel_id: "223456789012345678", data: { custom_id: "lancerlogin-attendance-report" }, member: { user: { id: "323456789012345678" } }, message: { id: "attendance-help-1" } };
  const run = async (record: Record<string, unknown>, members: unknown[], payload: unknown, managerEnabled = 1, trackedMessageId = "attendance-help-1") => {
    const database = new FakeDatabase();
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, ...record });
    database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: managerEnabled });
    database.rows.set("state_key = 'channel-manager-howto'", trackedMessageId ? { externalId: trackedMessageId } : undefined);
    database.lists.set("discord_user_id = ?", members);
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(signedDiscordInteraction(payload, privateKey), env); const body = await result.json() as { data?: { content?: string; flags?: number; allowed_mentions?: { parse: string[] } } };
    assert.equal(body.data?.flags, 64); assert.deepEqual(body.data?.allowed_mentions, { parse: [] }); assert.doesNotMatch(body.data?.content ?? "", /Attendance:|Absent meetings|%/);
    return { content: body.data?.content ?? "", database, env };
  };
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], base)).content, /not linked to exactly one active/);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [{ id: "member-1", active: 0 }], base)).content, /active LancerLogin roster member/);
  const wrongServer = await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [{ id: "member-1", active: 1 }], { ...base, guild_id: "999999999999999999" }); assert.match(wrongServer.content, /server configured/); assert.equal(wrongServer.database.calls.some((call) => call.sql.includes("discord_user_id = ?")), false);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], { ...base, channel_id: "999999999999999999" })).content, /invalid or expired/);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], { ...base, message: { id: "stale-help" } })).content, /invalid or expired/);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], base, 0)).content, /invalid or expired/);
  assert.match((await run({ enabled: 0, verifiedAt: "2026-09-04T00:01:00Z" }, [], base)).content, /disabled/);
  assert.match((await run({ enabled: 1, verifiedAt: null }, [], base)).content, /not been verified/);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], { ...base, member: undefined })).content, /invalid or expired/);

  const valid = await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], base);
  const unsigned = await worker.fetch(new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base) }), valid.env); assert.equal(unsigned.status, 401);
  const signed = signedDiscordInteraction(base, privateKey); const tampered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ ...base, message: { id: "tampered" } }) }); const rejected = await worker.fetch(tampered, valid.env); assert.equal(rejected.status, 401); assert.doesNotMatch(await rejected.text(), /Attendance:|Absent meetings|%/);
});

test("Discord attendance-report failures stay private, actionable, and non-disclosing", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  const run = async (record: Record<string, unknown>, members: unknown[], payload: unknown) => {
    const database = new FakeDatabase(); database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, ...record }); database.lists.set("discord_user_id = ?", members);
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(signedDiscordInteraction(payload, privateKey), env); const body = await result.json() as { data?: { content?: string; flags?: number; allowed_mentions?: { parse: string[] } } };
    assert.equal(body.data?.flags, 64); assert.deepEqual(body.data?.allowed_mentions, { parse: [] }); assert.doesNotMatch(body.data?.content ?? "", /Attendance:|Absent meetings|%/);
    return { content: body.data?.content ?? "", database };
  };
  const base = { type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: "323456789012345678" } } };
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], base)).content, /not linked to exactly one active/);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [{ id: "member-1", active: 0 }], base)).content, /active LancerLogin roster member/);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [{ id: "member-1", active: 1 }, { id: "member-2", active: 1 }], base)).content, /exactly one active/);
  const wrongServer = await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [{ id: "member-1", active: 1 }], { ...base, guild_id: "999999999999999999" }); assert.match(wrongServer.content, /server configured/); assert.equal(wrongServer.database.calls.some((call) => call.sql.includes("discord_user_id = ?")), false);
  assert.match((await run({ enabled: 0, verifiedAt: "2026-09-04T00:01:00Z" }, [], base)).content, /disabled/);
  assert.match((await run({ enabled: 1, verifiedAt: null }, [], base)).content, /not been verified/);
  assert.match((await run({ enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }, [], { ...base, data: { name: "attendance-report", options: [{ name: "member-id", value: "someone-else" }] } })).content, /malformed/);

  const malformedDatabase = new FakeDatabase(); malformedDatabase.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" }); const malformedEnv = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: malformedDatabase } as unknown as Env;
  const malformed = await worker.fetch(signedDiscordInteraction({}, privateKey, "{not-json"), malformedEnv); assert.equal(malformed.status, 200); assert.match(JSON.stringify(await malformed.json()), /malformed/);
  const nullBody = await worker.fetch(signedDiscordInteraction({}, privateKey, "null"), malformedEnv); assert.equal(nullBody.status, 200); assert.match(JSON.stringify(await nullBody.json()), /malformed/);
  const unsigned = await worker.fetch(new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base) }), malformedEnv); assert.equal(unsigned.status, 401); assert.deepEqual(await unsigned.json(), { error: "Discord interaction signature is invalid" });
  const signed = signedDiscordInteraction(base, privateKey); const tampered = new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ ...base, guild_id: "tampered" }) }); const rejected = await worker.fetch(tampered, malformedEnv); assert.equal(rejected.status, 401); assert.doesNotMatch(await rejected.text(), /Attendance:|Absent meetings|%/);
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
  const database = new FakeDatabase(); database.rows.set("password_hash IS NOT NULL", { id: "admin-1" });
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
  assert.equal(database.batches.at(-1)?.some((call) => call.sql.includes("DELETE FROM discord_attendance_recipients")), false);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("INSERT OR IGNORE INTO discord_attendance_recipients")));
    assert.equal(database.batches.at(-1)?.some((call) => call.sql.includes("discord_attendance_contests")), false);
    assert.equal(JSON.stringify(await result.json()).includes("discord-secret"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord absence notices remain unavailable before the scheduled meeting start", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio", startsAt: new Date(Date.now() + 60_000).toISOString() });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/discord/missing", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: "Attendance has not started for this meeting" });
  assert.equal(database.calls.some((call) => call.sql.includes("discord_attendance_notifications")), false);
});

test("Discord channel manager settings are Admin-only and audited", async () => {
  const database = new FakeDatabase();
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1, contestWindowHours: 36 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const adminCookie = await sessionCookie("admin");
  const read = await worker.fetch(request("/admin/integrations/discord/channel-manager", undefined, { cookie: adminCookie }), env);
  assert.deepEqual(await read.json(), { enabled: true, contestWindowHours: 36 });
  const saved = await worker.fetch(request("/admin/integrations/discord/channel-manager", { enabled: false, contestWindowHours: 48 }, { method: "PATCH", cookie: adminCookie }), env);
  assert.deepEqual(await saved.json(), { enabled: false, contestWindowHours: 48 });
  assert.ok(database.calls.some((call) => call.sql.includes("SET discord_channel_manager_enabled = ?") && call.values[0] === 0 && call.values[1] === 48));
  assert.ok(database.calls.some((call) => call.values.includes("discord.channel_manager_updated")));
  assert.equal((await worker.fetch(request("/admin/integrations/discord/channel-manager", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
});

test("Google Calendar stays separate from sign-in and requests only Calendar access", async () => {
  const database = new FakeDatabase();
  database.rows.set("google_calendar_enabled AS enabled", { enabled: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const saved = await worker.fetch(request("/admin/integrations/google-calendar", { clientId: "calendar-client", clientSecret: "calendar-secret" }, { method: "PUT", cookie: await sessionCookie("admin") }), env);
  assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes("calendar-secret"), false);
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT INTO google_calendar_authorizations")));
  assert.equal(database.calls.some((call) => call.sql.includes("encrypted_integrations") && call.values.includes("google")), false);

  const encrypted = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret" }, sessionSecret);
  database.rows.set("google_calendar_enabled AS enabled", { ...encrypted, enabled: 1 });
  const authorize = await worker.fetch(request("/admin/integrations/google-calendar/authorize", undefined, { cookie: await sessionCookie("admin") }), env);
  assert.equal(authorize.status, 302);
  const location = new URL(authorize.headers.get("location")!);
  assert.equal(location.origin, "https://accounts.google.com");
  assert.match(location.searchParams.get("scope") ?? "", /calendar\.calendarlist\.readonly/);
  assert.match(location.searchParams.get("scope") ?? "", /calendar\.events/);
  assert.doesNotMatch(location.searchParams.get("scope") ?? "", /openid|profile/);
  assert.equal(location.searchParams.get("access_type"), "offline");
  assert.equal(location.searchParams.get("redirect_uri"), "https://dashboard.example.test/api/admin/integrations/google-calendar/callback");
});

test("Google Calendar enablement is independently audited", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const enabled = await worker.fetch(request("/admin/integrations/google-calendar", { enabled: true }, { method: "PATCH", cookie: await sessionCookie("admin") }), env);
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { provider: "google_calendar", enabled: true });
  assert.ok(database.calls.some((call) => call.sql.includes("google_calendar_enabled = ?") && call.values[0] === 1));
  assert.ok(database.calls.some((call) => call.values.includes("google_calendar.enabled")));
});

test("meeting creation sends only stable generic Google Calendar event data", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "calendar-refresh", calendarId: "calendar@example.test", calendarLabel: "Operations" }, sessionSecret);
  database.rows.set("google_calendar_enabled AS enabled", { ...encrypted, enabled: 1, authorizedAt: "2026-09-05T00:00:00.000Z", verifiedAt: "2026-09-05T00:00:00.000Z" });
  database.rows.set("SELECT id, starts_at AS startsAt", (_sql, values) => ({ id: String(values[0]), startsAt: "2026-09-10T20:00:00.000Z", endsAt: "2026-09-10T22:00:00.000Z" }));
  database.lists.set("FROM google_calendar_operations o", ((_sql: string, values: unknown[]) => [{ meetingId: String(database.batches[0].find((call) => call.sql.includes("INSERT INTO meetings"))?.values[0]), eventId: String(values[0]), action: "upsert", startsAt: "2026-09-10T20:00:00.000Z", endsAt: "2026-09-10T22:00:00.000Z", status: "pending", attempts: 0, generation: 1 }]) as unknown as unknown[]);
  const providerCalls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); providerCalls.push({ url, body: init?.body && url.startsWith("https://www.googleapis.com/calendar/") ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "short-access-token" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "created" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(request("/meetings", { title: "Private planning title", notes: "Sensitive roster details", startsAt: "2026-09-10T20:00:00.000Z", endsAt: "2026-09-10T22:00:00.000Z", required: true }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 201);
    assert.deepEqual((await result.json() as { calendarSync: unknown }).calendarSync, { synced: 1, queued: 0, failed: 0 });
    const calendarCall = providerCalls.find((call) => call.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/"));
    assert.ok(calendarCall);
    assert.deepEqual(Object.keys(calendarCall.body ?? {}).sort(), ["end", "id", "start", "summary"]);
    assert.equal(calendarCall.body?.summary, "LancerLogin meeting");
    assert.match(String(calendarCall.body?.id), /^ll[0-9a-f]{48}$/);
    assert.equal(JSON.stringify(calendarCall.body).includes("Private planning title"), false);
    assert.equal(JSON.stringify(calendarCall.body).includes("Sensitive roster details"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord anomaly reports require an Admin-selected separate text channel in the verified server", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_anomaly_reports_enabled AS enabled", { enabled: 0, channelId: null, enabledAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const adminCookie = await sessionCookie("admin"); const originalFetch = globalThis.fetch; let channelGuildId = "123456789012345678";
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "323456789012345678", guild_id: channelGuildId, type: 0 }), { headers: { "content-type": "application/json" } });
  try {
    const read = await worker.fetch(request("/admin/integrations/discord/anomaly-reports", undefined, { cookie: adminCookie }), env);
    assert.deepEqual(await read.json(), { enabled: false, channelId: "" });
    const saved = await worker.fetch(request("/admin/integrations/discord/anomaly-reports", { enabled: true, channelId: "323456789012345678" }, { method: "PATCH", cookie: adminCookie }), env);
    assert.deepEqual(await saved.json(), { enabled: true, channelId: "323456789012345678" });
    const update = database.calls.find((call) => call.sql.includes("SET discord_anomaly_reports_enabled = ?"));
    assert.equal(update?.values[0], 1); assert.equal(update?.values[1], "323456789012345678"); assert.ok(Date.parse(String(update?.values[2])) > 0);
    assert.ok(database.calls.some((call) => call.values.includes("discord.anomaly_reports_updated")));
    const sameChannel = await worker.fetch(request("/admin/integrations/discord/anomaly-reports", { enabled: true, channelId: "223456789012345678" }, { method: "PATCH", cookie: adminCookie }), env);
    assert.equal(sameChannel.status, 400);
    assert.match(String((await sameChannel.json() as { error: string }).error), /separate private channel/);
    channelGuildId = "999999999999999999";
    const wrongServer = await worker.fetch(request("/admin/integrations/discord/anomaly-reports", { enabled: true, channelId: "423456789012345678" }, { method: "PATCH", cookie: adminCookie }), env);
    assert.equal(wrongServer.status, 400);
    assert.match(String((await wrongServer.json() as { error: string }).error), /verified Discord server/);
    const disabled = await worker.fetch(request("/admin/integrations/discord", { enabled: false }, { method: "PATCH", cookie: adminCookie }), env);
    assert.equal(disabled.status, 200);
    assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("discord_anomaly_reports_enabled = 0")));
    assert.equal((await worker.fetch(request("/admin/integrations/discord/anomaly-reports", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
  } finally { globalThis.fetch = originalFetch; }
});

test("enabled Discord channel manager creates status before guidance and pins only the tracked status", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 1 });
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.19.0" });
  database.lists.set("FROM meetings m LEFT JOIN", []);
  database.lists.set("FROM discord_attendance_notifications WHERE", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ url: string; method: string; payload?: Record<string, unknown> }> = []; let created = 0;
  globalThis.fetch = async (input, init) => {
    const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined; outbound.push({ url: String(input), method: String(init?.method), payload });
    if (init?.method === "POST") created += 1;
    return new Response(JSON.stringify({ id: `managed-${created}` }), { headers: { "content-type": "application/json" } });
  };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    const posts = outbound.filter((call) => call.method === "POST");
    assert.equal(posts.length, 2);
    assert.match(String(posts[0].payload?.content), /Front desk/);
    assert.match(String(posts[1].payload?.content), /\/pair/);
    assert.deepEqual(posts.map((call) => call.payload?.allowed_mentions), [{ parse: [] }, { parse: [] }]);
    assert.equal(posts[0].payload?.components, undefined);
    assert.deepEqual(posts[1].payload?.components, [{ type: 1, components: [{ type: 2, style: 1, label: "View my attendance report", custom_id: "lancerlogin-attendance-report" }] }]);
    assert.equal(JSON.stringify(posts[1].payload).match(/lancerlogin-attendance-report/g)?.length, 1);
    assert.deepEqual(outbound.filter((call) => call.method === "PUT").map((call) => call.url), ["https://discord.com/api/v10/channels/223456789012345678/messages/pins/managed-1"]);
    assert.ok(database.calls.some((call) => call.values[0] === "kiosk-status" && call.values[1] === "managed-1"));
    assert.ok(database.calls.some((call) => call.values[0] === "channel-manager-howto" && call.values[1] === "managed-2"));
  } finally { globalThis.fetch = originalFetch; }
});

test("channel manager reuses its two tracked messages and stays inactive until Discord is verified", async () => {
  const kioskContent = "**Front desk** · online · reader online · release 0.19.0";
  const guidance = "**LancerLogin attendance help**\nUse `/pair` with your LancerLogin member ID to link your Discord account. Use **View my attendance report** below or `/attendance-report` to receive your private report. After an absence notice appears, only a mentioned linked member can use **Contest absence** during the configured contest window. A contest requests private review; it does not change attendance until an Operator or Admin approves it.";
  const reportComponents = [{ type: 1, components: [{ type: 2, style: 1, label: "View my attendance report", custom_id: "lancerlogin-attendance-report" }] }];
  const verified = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  verified.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  verified.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  verified.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 1 });
  verified.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.19.0" });
  verified.rows.set("FROM integration_state", (_sql: string, values: unknown[]) => values[0] === "kiosk-status" ? { externalId: "status-1", contentHash: createHash("sha256").update(kioskContent).digest("base64url") } : { externalId: "howto-1", contentHash: createHash("sha256").update(JSON.stringify({ content: guidance, components: reportComponents })).digest("base64url") });
  verified.lists.set("FROM meetings m LEFT JOIN", []); verified.lists.set("FROM discord_attendance_notifications WHERE", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: verified } as unknown as Env;
  const originalFetch = globalThis.fetch; const methods: string[] = [];
  globalThis.fetch = async (_input, init) => { methods.push(String(init?.method)); return new Response(JSON.stringify({ id: "existing" }), { headers: { "content-type": "application/json" } }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(methods.filter((method) => method === "POST" || method === "PATCH" || method === "DELETE").length, 0);
    assert.deepEqual(methods, ["GET", "PUT", "GET"]);
  } finally { globalThis.fetch = originalFetch; }

  for (const record of [{ ...encrypted, verifiedAt: null, enabled: 1 }, { ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 0 }]) {
    const unavailable = new FakeDatabase(); unavailable.rows.set("FROM encrypted_integrations", { id: "discord-1", updatedAt: "2026-08-30T00:00:00Z", ...record }); unavailable.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
    let called = false; globalThis.fetch = async () => { called = true; return new Response(); };
    try { await worker.scheduled({ cron: "*/5 * * * *" }, { ...env, DB: unavailable } as unknown as Env); assert.equal(called, false); } finally { globalThis.fetch = originalFetch; }
  }
});

test("channel manager upgrades an existing attendance-help message with one report button and then reuses it", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  const kioskContent = "**Front desk** · online · reader online · release 0.19.0";
  let guideHash = createHash("sha256").update("legacy attendance guide without controls").digest("base64url");
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 1 });
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.19.0" });
  database.rows.set("FROM integration_state", (_sql: string, values: unknown[]) => values[0] === "kiosk-status" ? { externalId: "status-1", contentHash: createHash("sha256").update(kioskContent).digest("base64url") } : { externalId: "howto-1", contentHash: guideHash });
  database.lists.set("FROM meetings m LEFT JOIN", []); database.lists.set("FROM discord_attendance_notifications WHERE", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ method: string; payload?: Record<string, unknown> }> = [];
  globalThis.fetch = async (_input, init) => { outbound.push({ method: String(init?.method), payload: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined }); return new Response(JSON.stringify({ id: "howto-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    const update = outbound.find((call) => call.method === "PATCH");
    assert.deepEqual(update?.payload?.components, [{ type: 1, components: [{ type: 2, style: 1, label: "View my attendance report", custom_id: "lancerlogin-attendance-report" }] }]);
    assert.equal(JSON.stringify(update?.payload).match(/lancerlogin-attendance-report/g)?.length, 1);
    const stateWrite = database.calls.filter((call) => call.sql.includes("INSERT INTO integration_state") && call.values[0] === "channel-manager-howto").at(-1);
    assert.ok(stateWrite); guideHash = String(stateWrite.values[2]); outbound.length = 0;
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.some((call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("channel manager recreates deleted tracked messages with exactly one report button without touching unrelated content", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 1 });
  database.rows.set("FROM integration_state", { externalId: "deleted-managed", contentHash: "stale" });
  database.lists.set("FROM meetings m LEFT JOIN", []);
  database.lists.set("FROM discord_attendance_notifications WHERE", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ url: string; method: string; payload?: Record<string, unknown> }> = []; let created = 0;
  globalThis.fetch = async (input, init) => {
    outbound.push({ url: String(input), method: String(init?.method), payload: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (init?.method === "PATCH") return new Response(JSON.stringify({ code: 10_008, message: "Unknown Message" }), { status: 404, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") created += 1;
    return new Response(JSON.stringify({ id: `replacement-${created}` }), { headers: { "content-type": "application/json" } });
  };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.filter((call) => call.method === "PATCH" && call.url.endsWith("/messages/deleted-managed")).length, 2);
    assert.equal(outbound.filter((call) => call.method === "POST").length, 2);
    const recreatedGuide = outbound.filter((call) => call.method === "POST")[1].payload;
    assert.deepEqual(recreatedGuide?.components, [{ type: 1, components: [{ type: 2, style: 1, label: "View my attendance report", custom_id: "lancerlogin-attendance-report" }] }]);
    assert.equal(JSON.stringify(recreatedGuide).match(/lancerlogin-attendance-report/g)?.length, 1);
    assert.deepEqual(outbound.filter((call) => call.method === "PUT").map((call) => call.url), ["https://discord.com/api/v10/channels/223456789012345678/messages/pins/replacement-1"]);
    assert.equal(outbound.some((call) => call.method === "DELETE" || call.url.includes("unrelated")), false);
    assert.ok(database.calls.some((call) => call.values[0] === "kiosk-status" && call.values[1] === "replacement-1"));
    assert.ok(database.calls.some((call) => call.values[0] === "channel-manager-howto" && call.values[1] === "replacement-2"));
  } finally { globalThis.fetch = originalFetch; }
});

test("scheduled Discord absence delivery waits for the late-scan cutoff and retries failed delivery", async () => {
  async function run(endsAt: string, notificationStatus?: string) {
    const database = new FakeDatabase();
    const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
    database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 0 });
    database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 0 });
    database.rows.set("FROM discord_attendance_notifications WHERE installation_id", notificationStatus ? { status: notificationStatus, attempts: 1 } : undefined);
    database.lists.set("FROM meetings m LEFT JOIN", [{ id: "meeting-1", title: "Studio", endsAt, notificationStatus }]);
    database.lists.set("FROM members m WHERE", [{ id: "member-1", discordUserId: "323456789012345678" }]);
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; const payloads: Record<string, unknown>[] = []; let created = 0;
    globalThis.fetch = async (_input, init) => { if (init?.method === "POST") { created += 1; payloads.push(JSON.parse(String(init.body))); } return new Response(JSON.stringify({ id: `message-${created}` }), { headers: { "content-type": "application/json" } }); };
    try { await worker.scheduled({ cron: "*/5 * * * *" }, env); } finally { globalThis.fetch = originalFetch; }
    return { database, payloads };
  }
  const beforeCutoff = await run(new Date(Date.now() - 20 * 60_000).toISOString());
  assert.equal(beforeCutoff.payloads.some((payload) => String(payload.content).includes("Attendance has closed")), false);
  const afterCutoff = await run(new Date(Date.now() - 31 * 60_000).toISOString());
  assert.equal(afterCutoff.payloads.filter((payload) => String(payload.content).includes("Attendance has closed")).length, 1);
  const retry = await run(new Date(Date.now() - 20 * 60_000).toISOString(), "failed");
  assert.equal(retry.payloads.filter((payload) => String(payload.content).includes("Attendance has closed")).length, 1);
  assert.ok(retry.database.calls.some((call) => call.sql.includes("attempts = attempts + 1")));
});

test("scheduled Discord anomaly delivery uses the private channel, separate values, and an enforced retry nonce", async () => {
  const now = Date.now();
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 0 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 0 });
  database.rows.set("anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes", { lateScanMinutes: 30, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 10, enabled: 1, channelId: "323456789012345678", enabledAt: new Date(now - 90 * 60_000).toISOString() });
  database.lists.set("LEFT JOIN discord_anomaly_reports", [{ id: "meeting-1", title: "Studio @everyone", startsAt: new Date(now - 150 * 60_000).toISOString(), endsAt: new Date(now - 31 * 60_000).toISOString() }]);
  database.lists.set("LEFT JOIN discord_attendance_notifications", []);
  const anomalyRows = Array.from({ length: 40 }, (_, index) => ({ memberId: index ? `MEMBER-${index.toString().padStart(3, "0")}` : "A-101", firstName: index ? `Member${index}` : "Avery", lastName: index ? "With a deliberately long display name for Discord provider limits" : "Stone", checkedInAt: new Date(now - 137.5 * 60_000).toISOString(), checkedOutAt: new Date(now - 48.25 * 60_000).toISOString() }));
  database.lists.set("SELECT m.external_id AS memberId", anomalyRows);
  database.lists.set("FROM discord_attendance_notifications WHERE", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ url: string; method: string; payload?: Record<string, unknown> }> = []; let created = 0;
  globalThis.fetch = async (input, init) => { const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined; outbound.push({ url: String(input), method: String(init?.method), payload }); if (init?.method === "POST") created += 1; return new Response(JSON.stringify({ id: `message-${created}` }), { headers: { "content-type": "application/json" } }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    const report = outbound.find((call) => call.method === "POST" && call.url.includes("/channels/323456789012345678/messages"));
    assert.ok(report);
    assert.match(String(report.payload?.content), /Avery Stone \(A-101\).*arrived 12\.5 min late.*left 17\.3 min early/);
    assert.match(String(report.payload?.content), /more anomalous members omitted/);
    assert.ok(String(report.payload?.content).length <= 2_000);
    assert.doesNotMatch(String(report.payload?.content), /@everyone/);
    assert.deepEqual(report.payload?.allowed_mentions, { parse: [] });
    assert.equal(report.payload?.enforce_nonce, true); assert.equal(String(report.payload?.nonce).length, 25);
    assert.ok(database.calls.some((call) => call.sql.includes("SET status = 'delivered'") && call.values.includes("meeting-1")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord anomaly scheduling waits for enablement and records empty meetings without posting", async () => {
  async function run(enabledAt: string, verifiedAt: string | null, anomalies: unknown[], integrationEnabled = 1) {
    const database = new FakeDatabase();
    const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt, enabled: integrationEnabled });
    database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 0 });
    database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 0 });
    database.rows.set("anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes", { lateScanMinutes: 30, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 10, enabled: 1, channelId: "323456789012345678", enabledAt });
    database.lists.set("LEFT JOIN discord_anomaly_reports", [{ id: "meeting-1", title: "Studio", startsAt: new Date(Date.now() - 120 * 60_000).toISOString(), endsAt: new Date(Date.now() - 31 * 60_000).toISOString() }]);
    database.lists.set("LEFT JOIN discord_attendance_notifications", []); database.lists.set("SELECT m.external_id AS memberId", anomalies); database.lists.set("FROM discord_attendance_notifications WHERE", []);
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; const urls: string[] = [];
    globalThis.fetch = async (input, init) => { if (init?.method === "POST") urls.push(String(input)); return new Response(JSON.stringify({ id: "message" }), { headers: { "content-type": "application/json" } }); };
    try { await worker.scheduled({ cron: "*/5 * * * *" }, env); } finally { globalThis.fetch = originalFetch; }
    return { database, urls };
  }
  const beforeEnablement = await run(new Date().toISOString(), "2026-08-30T00:01:00Z", [{ memberId: "A-101", firstName: "Avery", lastName: "Stone", checkedInAt: new Date().toISOString() }]);
  assert.equal(beforeEnablement.urls.some((url) => url.includes("323456789012345678")), false);
  const empty = await run(new Date(Date.now() - 90 * 60_000).toISOString(), "2026-08-30T00:01:00Z", []);
  assert.equal(empty.urls.some((url) => url.includes("323456789012345678")), false);
  assert.ok(empty.database.calls.some((call) => call.sql.includes("SET status = 'no_anomalies'") && call.values.includes("meeting-1")));
  const unverified = await run(new Date(Date.now() - 90 * 60_000).toISOString(), null, []);
  assert.equal(unverified.database.calls.some((call) => call.sql.includes("discord_anomaly_reports_enabled AS enabled")), false);
  assert.equal(unverified.urls.some((url) => url.includes("323456789012345678")), false);
  const disabled = await run(new Date(Date.now() - 90 * 60_000).toISOString(), "2026-08-30T00:01:00Z", [], 0);
  assert.equal(disabled.database.calls.some((call) => call.sql.includes("discord_anomaly_reports_enabled AS enabled")), false);
  assert.equal(disabled.urls.some((url) => url.includes("323456789012345678")), false);
});

test("channel manager deletes only an expired tracked absence message and records completion", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 1 });
  database.lists.set("FROM meetings m LEFT JOIN", []);
  database.lists.set("FROM discord_attendance_notifications WHERE", [{ meetingId: "meeting-1", messageId: "absence-1", channelId: "223456789012345678", processedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), expiresAt: new Date(Date.now() - 3_600_000).toISOString() }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const deletes: string[] = []; let created = 0;
  globalThis.fetch = async (input, init) => { if (init?.method === "DELETE") deletes.push(String(input)); if (init?.method === "POST") created += 1; return new Response(init?.method === "DELETE" ? null : JSON.stringify({ id: `managed-${created}` }), { status: init?.method === "DELETE" ? 204 : 200, headers: init?.method === "DELETE" ? undefined : { "content-type": "application/json" } }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.deepEqual(deletes, ["https://discord.com/api/v10/channels/223456789012345678/messages/absence-1"]);
    assert.ok(database.calls.some((call) => call.sql.includes("SET deleted_at = ?") && call.values.includes("meeting-1") && call.values.includes("absence-1")));
    assert.equal(deletes.some((url) => url.includes("unrelated")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord calendar sync explains missing scheduled-event permission without exposing credentials", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Studio", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", notes: null });
  database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", { eventId: null, active: 1 });
  database.lists.set("FROM discord_calendar_operations o", [{ meetingId: "meeting-1", generation: 1, action: "upsert", eventId: null, status: "pending", attempts: 0, actorUserId: "operator-1" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Missing Permissions" }), { status: 403, headers: { "content-type": "application/json" } });
  try {
    const result = await worker.fetch(request("/discord/calendar", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 200);
    const body = await result.json() as { failed: number; outcomes: Array<{ reason?: string }> };
    assert.equal(body.failed, 1);
    assert.match(body.outcomes[0].reason ?? "", /Manage Events permission/);
    assert.doesNotMatch(JSON.stringify(body), /discord-secret/);
    assert.ok(database.batches.some((batch) => batch.some((call) => call.sql.includes("discord_calendar_operations SET status = 'failed'") && call.values.includes(null))));
  } finally { globalThis.fetch = originalFetch; }
});

test("individual Discord calendar sync stops after the scheduled meeting end", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Studio", startsAt: "2020-01-01T20:00:00Z", endsAt: "2020-01-01T21:00:00Z", notes: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let called = false;
  globalThis.fetch = async () => { called = true; return new Response(); };
  try {
    const result = await worker.fetch(request("/discord/calendar", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), { error: "Discord calendar sync is unavailable after the scheduled meeting end" });
    assert.equal(called, false);
    assert.equal(database.calls.some((call) => call.sql.includes("discord.calendar_synced")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("bulk Discord calendar sync stops after a permission failure instead of repeating denied requests", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Studio", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", notes: null });
  database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", { eventId: null, active: 1 });
  database.lists.set("SELECT id FROM meetings", [{ id: "meeting-1" }, { id: "meeting-2" }]);
  database.lists.set("FROM discord_calendar_operations o", [
    { meetingId: "meeting-1", generation: 1, action: "upsert", eventId: null, status: "pending", attempts: 0, actorUserId: "operator-1" },
    { meetingId: "meeting-2", generation: 1, action: "upsert", eventId: null, status: "pending", attempts: 0, actorUserId: "operator-1" },
  ]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ message: "Missing Permissions" }), { status: 403, headers: { "content-type": "application/json" } }); };
  try {
    const result = await worker.fetch(request("/discord/calendar", { all: true }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(calls, 1);
    assert.deepEqual(await result.json(), {
      synced: 0,
      queued: 1,
      skipped: 0,
      failed: 1,
      outcomes: [
        { meetingId: "meeting-1", title: "Studio", status: "failed", reason: "Discord denied this request because the bot is missing a required permission. Confirm it is in the selected server and has Manage Events permission before syncing the calendar." },
      ],
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord calendar sync retries a rate limit only after Discord's retry delay", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Studio", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", notes: null });
  database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", { eventId: null, active: 1 });
  database.lists.set("FROM discord_calendar_operations o", [{ meetingId: "meeting-1", generation: 1, action: "upsert", eventId: null, status: "pending", attempts: 0, actorUserId: "operator-1" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const originalSetTimeout = globalThis.setTimeout; let calls = 0; let waited: number | undefined;
  globalThis.setTimeout = ((callback: () => void, milliseconds?: number) => { waited = milliseconds; callback(); return 0; }) as typeof setTimeout;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ retry_after: 1.25 }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } })
      : new Response(JSON.stringify({ id: "event-1" }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await worker.fetch(request("/discord/calendar", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
    assert.equal(waited, 1_250);
    assert.deepEqual(await result.json(), { synced: 1, queued: 0, skipped: 0, failed: 0, outcomes: [{ meetingId: "meeting-1", title: "Studio", status: "synced" }] });
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout; }
});

test("Discord calendar recovery reconciles an ambiguously created event without another POST", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Studio", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", notes: null });
  database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", { eventId: null, active: 1 });
  database.lists.set("FROM discord_calendar_operations o", [{ meetingId: "meeting-1", generation: 1, action: "upsert", eventId: null, status: "processing", attempts: 0, revision: 2, actorUserId: "operator-1" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let posts = 0; let patches = 0; let correlationLocation = "";
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "GET") return new Response(JSON.stringify([{ id: "ambiguous-event-1", entity_metadata: { location: correlationLocation } }]), { headers: { "content-type": "application/json" } });
    const body = JSON.parse(String(init?.body)) as { entity_metadata?: { location?: string } };
    correlationLocation ||= body.entity_metadata?.location ?? "";
    if (init?.method === "POST") posts += 1;
    if (init?.method === "PATCH") patches += 1;
    return new Response(JSON.stringify({ id: "ambiguous-event-1" }), { headers: { "content-type": "application/json" } });
  };
  try {
    // This models a prior successful provider create whose response or D1 persistence was lost.
    correlationLocation = `LancerLogin · ${(await createHash("sha256").update("discord-calendar:primary:meeting-1:1").digest("base64url")).slice(0, 24)}`;
    const result = await worker.fetch(request("/discord/calendar", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 200);
    assert.equal(posts, 0);
    assert.equal(patches, 1);
    assert.ok(database.batches.some((batch) => batch.some((call) => call.sql.includes("SET event_id = ?") && call.values.includes("ambiguous-event-1"))));
  } finally { globalThis.fetch = originalFetch; }
});

test("concurrent Discord calendar processors claim one create operation", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Studio", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", notes: null });
  database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", { eventId: null, active: 1 });
  database.lists.set("FROM discord_calendar_operations o", [{ meetingId: "meeting-1", generation: 1, action: "upsert", eventId: null, status: "pending", attempts: 0, revision: 1, actorUserId: "operator-1" }]);
  let claimed = false;
  database.runChangeHandler = (sql) => {
    if (!sql.includes("SET status = 'processing'")) return 1;
    if (claimed) return 0;
    claimed = true;
    return 1;
  };
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let posts = 0;
  globalThis.fetch = async (_input, init) => { if (init?.method === "POST") posts += 1; return new Response(JSON.stringify({ id: "event-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    const calls = await Promise.all([
      worker.fetch(request("/discord/calendar", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env),
      worker.fetch(request("/discord/calendar", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env),
    ]);
    assert.deepEqual(calls.map((result) => result.status), [200, 200]);
    assert.equal(posts, 1);
    assert.equal(database.calls.filter((call) => call.sql.includes("SET status = 'processing'")).length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("meeting deletion and restore retain tracked Discord delete work and create a new generation", async () => {
  const deleted = new FakeDatabase();
  deleted.rows.set("FROM meetings WHERE", { id: "meeting-1", seriesId: null, startsAt: "2026-10-01T20:00:00Z" });
  deleted.rows.set("SELECT event_id AS eventId, generation FROM discord_calendar_event_mappings", { eventId: "tracked-event-1", generation: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: deleted } as unknown as Env;
  const deletion = await worker.fetch(request("/meetings/meeting-1", { scope: "occurrence" }, { method: "DELETE", cookie: await sessionCookie("operator") }), env);
  assert.equal(deletion.status, 200);
  assert.deepEqual((await deletion.json() as { calendarDelivery: { discord: unknown } }).calendarDelivery.discord, { synced: 0, queued: 1, skipped: 0, failed: 0, outcomes: [] });
  assert.ok(deleted.calls.some((call) => call.sql.includes("discord_calendar_operations") && call.sql.includes("'delete'") && call.values.includes("tracked-event-1")));
  assert.equal(deleted.calls.some((call) => call.sql.includes("DELETE FROM integration_state")), false);

  const restored = new FakeDatabase();
  restored.rows.set("deleted_at IS NOT NULL", { id: "meeting-1", seriesId: null, startsAt: "2026-10-01T20:00:00Z" });
  restored.rows.set("SELECT event_id AS eventId, generation FROM discord_calendar_event_mappings", { eventId: "tracked-event-1", generation: 1 });
  const restoration = await worker.fetch(request("/meetings/meeting-1/restore", { scope: "occurrence" }, { method: "POST", cookie: await sessionCookie("operator") }), { ...env, DB: restored } as unknown as Env);
  assert.equal(restoration.status, 200);
  assert.ok(restored.batches.some((batch) => batch.some((call) => call.sql.includes("generation = ?") && call.values[0] === 2)));
  assert.ok(restored.batches.some((batch) => batch.some((call) => call.sql.includes("discord_calendar_operations") && call.sql.includes("'upsert'") && call.values.includes(2))));
  assert.ok(restored.calls.some((call) => call.sql.includes("discord_calendar_operations") && call.sql.includes("'delete'") && call.values.includes("tracked-event-1")));
});

test("one meeting calendar action reports configured providers separately and preserves Discord fields", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("SELECT id FROM meetings", { id: "meeting-1" });
  database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Studio night", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", notes: "Bring tools" });
  database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", { eventId: null, active: 1 });
  database.lists.set("FROM discord_calendar_operations o", [{ meetingId: "meeting-1", generation: 1, action: "upsert", eventId: null, status: "pending", attempts: 0, actorUserId: "operator-1" }]);
  const providerBodies: Record<string, unknown>[] = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { assert.match(String(input), /^https:\/\/discord\.com\/api\/v10\/guilds\//); providerBodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: "event-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(request("/calendars/sync", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 200);
    const body = await result.json() as { providers: Array<{ provider: string; synced: number }> };
    assert.deepEqual(body.providers.map(({ provider, synced }) => ({ provider, synced })), [{ provider: "discord", synced: 1 }]);
    const location = (providerBodies[0].entity_metadata as { location: string }).location;
    assert.match(location, /^LancerLogin · [A-Za-z0-9_-]{24}$/);
    assert.deepEqual(providerBodies[0], { name: "Studio night", description: "Bring tools", privacy_level: 2, entity_type: 3, scheduled_start_time: "2026-10-01T20:00:00Z", scheduled_end_time: "2026-10-01T21:00:00Z", entity_metadata: { location } });
  } finally { globalThis.fetch = originalFetch; }
});

test("provider sync-all controls are Admin-only and unverified calendars cannot be manually backfilled", async () => {
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/admin/integrations/discord/calendar/sync-all", {}, { cookie: await sessionCookie("operator") }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/integrations/google-calendar/sync-all", {}, { cookie: await sessionCookie("operator") }), env)).status, 403);
  database.rows.set("SELECT id FROM meetings", { id: "meeting-1" });
  assert.equal((await worker.fetch(request("/calendars/sync", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env)).status, 409);
});

test("Operators and Admins can list contest lifetime counts and raw partial, no-scan, and complete context", async () => {
  const database = new FakeDatabase();
  database.rows.set("google_enabled AS googleEnabled", { googleEnabled: 0, resendEnabled: 0, discordEnabled: 1 });
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ciphertext: "unused", iv: "unused", updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.lists.set("FROM discord_attendance_contests c", [
    { meetingId: "meeting-1", meetingTitle: "Studio", meetingStartsAt: "2026-08-30T20:00:00Z", memberId: "member-1", externalId: "A-1", firstName: "Avery", lastName: "Stone", status: "open", createdAt: "2026-08-30T00:00:00Z", lifetimeContestCount: 4, hasRawCheckIn: 1, hasRawCheckOut: 0 },
    { meetingId: "meeting-1", meetingTitle: "Studio", meetingStartsAt: "2026-08-30T20:00:00Z", memberId: "member-2", externalId: "A-2", firstName: "Morgan", lastName: "Diaz", status: "reviewed", createdAt: "2026-08-29T00:00:00Z", lifetimeContestCount: 2, hasRawCheckIn: 0, hasRawCheckOut: 0 },
    { meetingId: "meeting-1", meetingTitle: "Studio", meetingStartsAt: "2026-08-30T20:00:00Z", memberId: "member-3", externalId: "A-3", firstName: "Jordan", lastName: "Lee", status: "rejected", createdAt: "2026-08-28T00:00:00Z", lifetimeContestCount: 1, hasRawCheckIn: 1, hasRawCheckOut: 1 },
  ]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator");
  const listed = await worker.fetch(request("/discord/contests?meetingId=meeting-1", undefined, { cookie }), env);
  assert.equal(listed.status, 200);
  const contests = (await listed.json() as { contests: { meetingTitle: string; meetingStartsAt: string; status: string; lifetimeContestCount: number; hasPartialScan: boolean; rawScanStatus: string }[] }).contests;
  assert.deepEqual(contests.map(({ status, lifetimeContestCount, hasPartialScan, rawScanStatus }) => ({ status, lifetimeContestCount, hasPartialScan, rawScanStatus })), [
    { status: "open", lifetimeContestCount: 4, hasPartialScan: true, rawScanStatus: "partial" },
    { status: "reviewed", lifetimeContestCount: 2, hasPartialScan: false, rawScanStatus: "none" },
    { status: "rejected", lifetimeContestCount: 1, hasPartialScan: false, rawScanStatus: "complete" },
  ]);
  const listQuery = database.calls.find((call) => call.sql.includes("FROM discord_attendance_contests c"));
  assert.ok(listQuery?.sql.includes("mt.starts_at AS meetingStartsAt"));
  assert.match(listQuery?.sql ?? "", /SELECT COUNT\(\*\) FROM discord_attendance_contests history WHERE history\.installation_id = c\.installation_id AND history\.member_id = c\.member_id/);
  assert.doesNotMatch(listQuery?.sql ?? "", /history\.status/);
  assert.match(listQuery?.sql ?? "", /FROM attendance_events check_in/);
  assert.match(listQuery?.sql ?? "", /FROM attendance_events check_out/);
  assert.doesNotMatch(listQuery?.sql ?? "", /attendance_corrections/);
  assert.equal((await worker.fetch(request("/discord/contests", undefined, { cookie: await sessionCookie("admin") }), env)).status, 200);
  const missingReason = await worker.fetch(request("/discord/contests/resolve", { meetingId: "meeting-1", memberId: "member-1", resolution: "approved", reviewNote: "   " }, { cookie }), env);
  assert.equal(missingReason.status, 400);
  assert.deepEqual(await missingReason.json(), { error: "A review reason is required before resolving this contest" });
  assert.equal(database.batches.length, 0);
  const resolved = await worker.fetch(request("/discord/contests/resolve", { meetingId: "meeting-1", memberId: "member-1", resolution: "approved", reviewNote: "Member showed the Operator a kiosk error." }, { cookie }), env);
  assert.equal(resolved.status, 200);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE discord_attendance_contests")));
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("INSERT INTO attendance_corrections")));
  assert.ok(database.calls.some((call) => call.values.includes("discord.contest_resolved")));
});

test("unverified Discord exposes no contest list or resolution operation", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ciphertext: "unused", iv: "unused", updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null, enabled: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const unsigned = await worker.fetch(request("/discord/contests"), env);
  assert.equal(unsigned.status, 401);
  const cookie = await sessionCookie("operator");
  const listed = await worker.fetch(request("/discord/contests", undefined, { cookie }), env);
  assert.equal(listed.status, 409);
  assert.deepEqual(await listed.json(), { error: "Discord must be enabled and verified" });
  const resolved = await worker.fetch(request("/discord/contests/resolve", { meetingId: "meeting-1", memberId: "member-1", resolution: "approved", reviewNote: "Verified in person." }, { cookie }), env);
  assert.equal(resolved.status, 409);
  assert.equal(database.batches.length, 0);
});

test("a signed Discord button creates a contest only for the delivered linked member", async () => {
  const database = new FakeDatabase();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
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
  assert.deepEqual(await result.json(), { type: 4, data: { content: "Your attendance contest was recorded for review. Your attendance has not been changed.", flags: 64, allowed_mentions: { parse: [] } } });
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

test("category backups include reusable meeting templates and weight definitions without mixing unrelated tables", async () => {
  const database = new FakeDatabase(); database.lists.set("FROM meeting_weight_categories", [{ id: "weight-1" }]); database.lists.set("FROM meetings", [{ id: "meeting-1" }]); database.lists.set("FROM meeting_templates", [{ id: "template-1" }]); database.lists.set("FROM attendance_events", []); database.lists.set("FROM attendance_corrections", []); database.lists.set("FROM discord_attendance_notifications", []); database.lists.set("FROM discord_attendance_recipients", []); database.lists.set("FROM discord_attendance_contests", []); database.lists.set("FROM discord_anomaly_reports", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/data/backup?scope=meetings", undefined, { cookie: await sessionCookie("admin") }), env); assert.equal(result.status, 200); const backup = await result.json() as { scope: string; tables: Record<string, unknown> }; assert.equal(backup.scope, "meetings"); assert.deepEqual(Object.keys(backup.tables).sort(), ["attendance_corrections", "attendance_events", "discord_anomaly_reports", "discord_attendance_contests", "discord_attendance_notifications", "discord_attendance_recipients", "meeting_templates", "meeting_weight_categories", "meetings"]); assert.equal("members" in backup.tables, false); assert.match(result.headers.get("content-disposition") ?? "", /meetings-backup/);
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

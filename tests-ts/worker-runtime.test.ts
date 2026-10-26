import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec, hashPassword } from "../apps/api/src/runtime-security.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { defaultReportDefinition } from "../apps/api/src/report-builder.ts";

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
  denyProviderPreflight = false;
  user?: { id: string; role: "admin" | "operator"; passwordHash: string | null; failedLoginCount?: number; lockedUntil?: string };
  rows = new Map<string, unknown>();
  lists = new Map<string, unknown[]>();
  runChangeHandler?: (sql: string, values: unknown[]) => number;
  prepare(sql: string) { return new FakeStatement(sql, this); }
  async batch(statements: FakeStatement[]) {
    const product = statements.filter((statement) => !statement.sql.includes("AS module_authority"));
    if (this.denyProviderPreflight && product.some((statement) => statement.sql.trim() === "SELECT 1")) throw new Error("module-authority-denied");
    if (product.length === 1) this.calls.push(product[0]!);
    else if (product.length > 1) this.batches.push(product);
    return statements.map((statement) => {
      const readsRows = /^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(statement.sql);
      if (readsRows || /\bRETURNING\b/i.test(statement.sql)) {
        const listed = this.allResult(statement.sql, statement.values);
        if (listed !== undefined) return { success: true, results: listed };
      }
      if (readsRows) {
        const first = this.firstResult(statement.sql, statement.values);
        return { success: true, results: first === undefined ? [] : [first] };
      }
      return { success: true, meta: { changes: this.runChanges(statement.sql, statement.values) } };
    });
  }
  firstResult(sql: string, values: unknown[]) {
    for (const [fragment, value] of this.rows) if (sql.includes(fragment)) return typeof value === "function" ? (value as (sql: string, values: unknown[]) => unknown)(sql, values) : value;
    if (sql.includes("AS module_authority")) return { module_authority: 1 };
    if (sql.includes("SELECT m.generation FROM users u") && sql.includes("JOIN platform_module_administration")) return { generation: 1 };
    if (sql.includes("SELECT m.generation FROM platform_modules m") && sql.includes("JOIN platform_module_administration")) return { generation: 1 };
    if (sql.includes("FROM installation_update_settings")) return { channel: "stable", revision: 0 };
    if (sql.includes("SELECT id FROM kiosk_commands") && sql.includes("AND id = ?")) {
      const insert = this.batches.flat().find((call) => call.sql.includes("INSERT INTO kiosk_commands") && call.values[0] === values[0]);
      return insert ? { id: values[0] } : undefined;
    }
    if (sql.includes("SELECT id, role FROM users") && sql.includes("active = 1")) {
      const id = String(values[0]);
      return { id, role: id.startsWith("operator") ? "operator" : "admin" };
    }
    if (sql.includes("FROM users")) return this.user;
    return undefined;
  }
  allResult(sql: string, values: unknown[]) {
    if (/^\s*SELECT\s+SUM\b/i.test(sql)) return undefined;
    for (const [fragment, value] of this.lists) {
      if (fragment === "FROM attendance_events" && sql.includes("kiosk_event_id = ?")) continue;
      if (sql.includes(fragment)) return typeof value === "function" ? (value as (sql: string, values: unknown[]) => unknown[])(sql, values) : value;
    }
    if (sql.includes("JOIN platform_module_administration") && sql.includes("ORDER BY m.module_id")) {
      const userId = String(values[1]); const role = userId.startsWith("operator") ? "operator" : "admin";
      return [{ role, revision: 0, selectionCompleted: 1, administrationEpoch: 0, moduleId: "attendance", contractVersion: 1, generation: 1, moduleEpoch: 1, phase: "enabled", setupVersion: 2, setupComplete: 1, disabledAt: null, deleteAfter: null, deletionCursor: 0, cleanupFailure: null, assignmentRevision: 0, assignmentEpoch: 0, capabilitiesJson: role === "operator" ? '["attendance.manage"]' : null }];
    }
    return undefined;
  }
  runChanges(sql: string, values: unknown[]) { return this.runChangeHandler?.(sql, values) ?? 1; }
}

function seedPolicy(database: FakeDatabase, options: {
  members?: Record<string, unknown>[]; meetings?: Record<string, unknown>[]; labels?: Record<string, unknown>[];
  changes?: Record<string, unknown>[]; targets?: Record<string, unknown>[]; rules?: Record<string, unknown>[]; audience?: Record<string, unknown>[];
  events?: Record<string, unknown>[]; corrections?: Record<string, unknown>[]; baseline?: string | null;
} = {}) {
  database.lists.set("SELECT id, external_id AS memberId, first_name AS firstName", options.members ?? []);
  database.lists.set("SELECT id, name, active, formula_enabled AS formulaEnabled FROM member_labels", options.labels ?? []);
  database.lists.set("SELECT member_id AS memberId, label_id AS labelId, action, effective_date AS effectiveDate", options.changes ?? []);
  database.lists.set("rule_type AS ruleType, threshold_percent AS thresholdPercent", options.rules ?? []);
  database.lists.set("SELECT id, label_id AS labelId, starts_on AS startsOn", options.targets ?? []);
  database.lists.set("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, required, attendance_weight AS attendanceWeight", options.meetings ?? []);
  database.lists.set("SELECT meeting_id AS meetingId, label_id AS labelId FROM meeting_audience_labels", options.audience ?? []);
  database.lists.set("SELECT e.meeting_id AS meetingId, e.member_id AS memberId", options.events ?? []);
  database.lists.set("SELECT c.meeting_id AS meetingId, c.member_id AS memberId", options.corrections ?? []);
  database.rows.set("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on AS baseline", { timeZone: "UTC", lateScanMinutes: 30, baseline: options.baseline ?? null });
  database.rows.set("SELECT attendance_reporting_starts_on AS baseline, time_zone AS timeZone", { timeZone: "UTC", baseline: options.baseline ?? null });
}

function seedInstallationBackupFoundation(database: FakeDatabase, users: Record<string, unknown>[] = [{ id: "admin-1", installation_id: "primary", email: null, local_username: "admin", password_hash: "hash", failed_login_count: 0, locked_until: null, role: "admin", active: 1, created_at: "2026-09-01T00:00:00Z", member_id: null, debug_mode: 0 }]) {
  database.lists.set("FROM installations WHERE", [{ id: "primary", created_at: "2026-09-01T00:00:00Z", auth_mode: "local", telemetry_accepted_at: null, telemetry_install_id: null, google_enabled: 0, resend_enabled: 0, discord_enabled: 0, google_calendar_enabled: 0 }]);
  database.lists.set("FROM platform_module_administration WHERE", [{ installation_id: "primary", revision: 0, selection_completed: 1 }]);
  database.lists.set("FROM platform_module_administration_epochs WHERE", [{ installation_id: "primary", revision: 0 }]);
  database.lists.set("FROM platform_module_epochs WHERE", [{ installation_id: "primary", module_id: "attendance", generation: 1 }, { installation_id: "primary", module_id: "hour-tracking", generation: 1 }, { installation_id: "primary", module_id: "carpool", generation: 1 }]);
  database.lists.set("FROM platform_modules WHERE", [
    { installation_id: "primary", module_id: "attendance", contract_version: 1, generation: 1, phase: "enabled", setup_version: 2, setup_complete: 1, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null },
    { installation_id: "primary", module_id: "hour-tracking", contract_version: 1, generation: 1, phase: "disabled", setup_version: 1, setup_complete: 0, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null },
    { installation_id: "primary", module_id: "carpool", contract_version: 1, generation: 1, phase: "disabled", setup_version: 1, setup_complete: 0, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null },
  ]);
  database.lists.set("FROM users WHERE", users);
  database.lists.set("FROM platform_module_assignment_epochs WHERE", users.map((user) => ({ installation_id: "primary", user_id: user.id, revision: 0 })));
  database.lists.set("FROM platform_module_assignment_revisions WHERE", users.map((user) => ({ installation_id: "primary", user_id: user.id, revision: 0 })));
  database.lists.set("FROM platform_module_assignments WHERE", users.filter((user) => user.role === "operator").map((user) => ({ installation_id: "primary", user_id: user.id, module_id: "attendance", capabilities_json: '["attendance.manage"]' })));
  database.lists.set("FROM platform_module_setup_progress WHERE", ["rules", "meeting", "input", "calendar", "discord"].map((stepId) => ({ installation_id: "primary", module_id: "attendance", step_id: stepId, setup_version: 2, outcome: ["calendar", "discord"].includes(stepId) ? "skipped" : "completed", completed_at: "2026-09-01T00:00:00Z", completed_by: "admin-1" })));
}

const setupCode = "private setup code 1234";
const setupCodeHash = createHash("sha256").update(setupCode).digest("base64url");
const request = (path: string, body?: unknown, options: { method?: string; cookie?: string } = {}) => new Request(`https://api.example.test${path}`, {
  method: options.method ?? (body ? "POST" : "GET"),
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(options.cookie ? { cookie: options.cookie } : {}), ...((/^\/admin\/kiosks\/[^/]+\/commands$/.test(path) || ["/discord/contests/accept", "/discord/contests/reject"].includes(path)) && body ? { origin: "https://dashboard.example.test" } : {}) },
  body: body ? JSON.stringify(path === "/setup/bootstrap" && typeof body === "object" ? { setupCode, ...body } : body) : undefined,
});
const sessionSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sessionCookie = async (role: "admin" | "operator") => `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: `${role}-1`, role })}`;

test("public form privacy is Admin-only and HTTP lookup responses are noncacheable exact projections", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/admin/hours/public-form-settings"), env)).status, 401);
  assert.equal((await worker.fetch(request("/admin/hours/public-form-settings", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
  database.rows.set("SELECT COALESCE(s.member_validation", { memberValidation: "off", revision: 0 });
  assert.equal((await worker.fetch(request("/admin/hours/public-form-settings", undefined, { cookie: await sessionCookie("admin") }), env)).status, 200);
  const lookup = (origin = "https://dashboard.example.test") => worker.fetch(new Request("https://api.example.test/public/hours/member-validation", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ memberExternalId: "SYN-001" }) }), env);
  let result = await lookup();
  assert.deepEqual(await result.json(), { mode: "off" });
  assert.match(result.headers.get("cache-control") ?? "", /no-store/); assert.equal(result.headers.get("pragma"), "no-cache");
  assert.equal(database.calls.some(call => call.sql.includes("FROM members")), false);
  database.rows.set("FROM hours_public_form_settings WHERE", { memberValidation: "validity", revision: 1 });
  database.rows.set("SELECT generation FROM platform_modules WHERE", { generation: 1 });
  database.lists.set("RETURNING attempts", [{ attempts: 1 }]);
  database.rows.set("SELECT 1 AS valid FROM members", { valid: 1 });
  result = await lookup(); assert.deepEqual(await result.json(), { mode: "validity", valid: true });
  assert.equal(database.calls.some(call => /first_name|last_name/.test(call.sql)), false);
  assert.equal((await lookup("https://other.example.test")).status, 403);
  database.rows.set("FROM hours_public_form_settings WHERE", { memberValidation: "name", revision: 2 });
  database.rows.set("SELECT trim(first_name||' '||last_name) AS name", { name: "Synthetic Avery Member", email: "must-not-leak@example.test", externalId: "must-not-leak" });
  result = await lookup(); assert.deepEqual(await result.json(), { mode: "name", valid: true, name: "Synthetic Avery Member" });
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
});
const calendarClock = (context: TestContext) => context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
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

test("local Worker bootstrap creates a salted Admin and ignores legacy telemetry consent", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", BOOTSTRAP_CODE_HASH: setupCodeHash, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example Arts Club", timeZone: "America/New_York", authMode: "local", localUsername: "director", localPassword: "correct horse battery staple", telemetryAccepted: true }), env);
  assert.equal(result.status, 201);
  assert.equal(database.batches.length, 1);
  assert.equal(database.batches[0].length, 19);
  assert.equal(database.batches[0].filter((statement) => statement.sql.includes("INSERT INTO hours_categories")).length, 3);
  assert.ok(database.batches[0].some((statement) => statement.sql.includes("INSERT INTO hours_publication_settings") && statement.values[0] === statement.values[1]));
  assert.ok(database.batches[0].some((statement) => statement.sql.includes("'hour-tracking'")));
  assert.ok(database.batches[0].some((statement) => statement.sql.includes("'carpool'")));
  const userInsert = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO users"));
  assert.match(String(userInsert?.values[4]), /^scrypt\$/);
  const installationInsert = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO installations"));
  assert.equal(installationInsert?.values[3], null);
  assert.equal(installationInsert?.values[4], null);
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

test("Admin and Operator users can persist their own Debug mode preference", async () => {
  for (const role of ["admin", "operator"] as const) {
    const database = new FakeDatabase();
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
    assert.equal((await worker.fetch(request("/auth/preferences", { debugMode: "yes" }, { method: "PATCH", cookie: await sessionCookie(role) }), env)).status, 400);
    const result = await worker.fetch(request("/auth/preferences", { debugMode: true }, { method: "PATCH", cookie: await sessionCookie(role) }), env);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { debugMode: true });
    const update = database.calls.find((call) => call.sql.includes("UPDATE users SET debug_mode"));
    assert.deepEqual(update?.values, [1, `${role}-1`]);
    assert.ok(database.calls.some((call) => call.sql.includes("INSERT INTO audit_log") && call.values.includes("user.preferences_updated")));
  }
});

test("developer scheduler visibility is a revision-protected per-Admin preference", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM user_preferences", { developerSchedulerEnabled: 0, revision: 4 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const admin = await sessionCookie("admin");
  const current = await worker.fetch(request("/admin/preferences", undefined, { cookie: admin }), env);
  assert.equal(current.status, 200); assert.deepEqual(await current.json(), { developerSchedulerEnabled: false, revision: 4 });
  assert.equal((await worker.fetch(request("/admin/preferences", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/preferences", { developerSchedulerEnabled: true, expectedRevision: "4" }, { method: "PUT", cookie: admin }), env)).status, 400);
  const saved = await worker.fetch(request("/admin/preferences", { developerSchedulerEnabled: true, expectedRevision: 4 }, { method: "PUT", cookie: admin }), env);
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { developerSchedulerEnabled: true, revision: 5 });
  const batch = database.batches.at(-1) ?? [];
  assert.ok(batch.some((call) => call.sql.includes("INSERT INTO user_preferences") && call.values.includes(1) && call.values.includes(4)));
  assert.ok(batch.some((call) => call.sql.includes("user.developer_preferences_updated")));
});

test("durable scheduler controls are Admin-only, fixed, and unavailable without an explicit binding", async () => {
  const database = new FakeDatabase();
  const base = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const admin = await sessionCookie("admin");
  assert.equal((await worker.fetch(request("/admin/scheduler", undefined, { cookie: admin }), base)).status, 503);
  assert.equal((await worker.fetch(request("/admin/scheduler", undefined, { cookie: await sessionCookie("operator") }), { ...base, PLATFORM_SCHEDULER_MODE: "durable" } as Env)).status, 403);
  const seen: string[] = [];
  const env = { ...base, PLATFORM_SCHEDULER_MODE: "durable", PLATFORM_SCHEDULER: { idFromName(name: string) { assert.equal(name, "primary"); return name; }, get() { return { fetch: async (input: Request) => { seen.push(`${input.method} ${new URL(input.url).pathname}`); return Response.json({ enabled: input.url.endsWith("/start"), jobs: {} }); } }; } } } as Env;
  assert.equal((await worker.fetch(request("/admin/scheduler/start", { interval: 1 }, { method: "POST", cookie: admin }), env)).status, 400);
  const started = await worker.fetch(request("/admin/scheduler/start", {}, { method: "POST", cookie: admin }), env);
  assert.equal(started.status, 200); assert.deepEqual(await started.json(), { enabled: true, jobs: {} });
  const status = await worker.fetch(request("/admin/scheduler", undefined, { cookie: admin }), env);
  assert.equal(status.status, 200); assert.deepEqual(seen, ["POST /start", "GET /status"]);
  assert.ok(database.calls.some((call) => call.values.includes("scheduler.start")));
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
  assert.ok(memberInsert);
  assert.equal(memberInsert.sql.includes("attendance_required_from"), false, "Core roster imports do not own Attendance participation dates");
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

test("multi-kiosk pairing preserves existing credentials and rejects duplicate active names", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const created = await worker.fetch(request("/admin/pairing-codes", { kioskName: "Workshop entrance" }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(created.status, 201);

  const code = (await created.json() as { code: string }).code;
  database.rows.set("FROM pairing_codes", { id: "pairing-1" });
  const redeemed = await worker.fetch(request("/kiosk/pair", { code, kioskName: "Workshop entrance" }), env);
  assert.equal(redeemed.status, 201);
  assert.equal((await redeemed.clone().json() as { pairingId: string }).pairingId, "pairing-1");
  const batch = database.batches.at(-1) ?? [];
  assert.equal(batch.some((statement) => statement.sql.includes("UPDATE kiosks SET active = 0")), false);
  const insertIndex = batch.findIndex((statement) => statement.sql.includes("INSERT INTO kiosks"));
  assert.ok(insertIndex >= 0);
  assert.match(batch[insertIndex]!.sql, /pairing_bound/); assert.ok(batch[insertIndex]!.sql.includes(", 1 WHERE"));

  const duplicateDatabase = new FakeDatabase();
  duplicateDatabase.rows.set("active = 1 AND lower(name) = lower(?)", { id: "kiosk-existing" });
  const duplicateEnv = { ...env, DB: duplicateDatabase } as unknown as Env;
  const duplicate = await worker.fetch(request("/admin/pairing-codes", { kioskName: "Workshop entrance" }, { cookie: await sessionCookie("admin") }), duplicateEnv);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "An active kiosk already uses that name. Choose a distinct device name." });
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

  const duplicateDatabase = new FakeDatabase();
  duplicateDatabase.rows.set("SELECT id, name, active FROM kiosks", { id: "kiosk-1", name: "Front desk", active: 1 });
  duplicateDatabase.rows.set("active = 1 AND id <> ? AND lower(name) = lower(?)", { id: "kiosk-2" });
  const duplicateEnv = { ...env, DB: duplicateDatabase } as unknown as Env;
  const duplicate = await worker.fetch(request("/admin/kiosks/kiosk-1", { name: "Workshop" }, { method: "PATCH", cookie }), duplicateEnv);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicateDatabase.calls.some((call) => call.sql.includes("UPDATE kiosks SET name")), false);
});

test("kiosk authentication configuration is Admin-only, validated, audited, and reported separately from the applied method", async () => {
  const database = new FakeDatabase();
  database.rows.set("SELECT id, configured_authentication_method AS authenticationMethod", { id: "kiosk-1", authenticationMethod: "qr" });
  database.lists.set("SELECT id, name, active, last_seen_at AS lastSeenAt", [{ id: "kiosk-1", name: "Front desk", active: 1, authenticationMethod: "fingerprint", configuredAuthenticationMethod: "qr", pairedAt: "2026-09-01T00:00:00.000Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const status = await worker.fetch(request("/admin/kiosks", undefined, { cookie: await sessionCookie("admin") }), env);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1, authenticationMethod: "fingerprint", configuredAuthenticationMethod: "qr", pairedAt: "2026-09-01T00:00:00.000Z" }] });
  assert.equal((await worker.fetch(request("/admin/kiosks/kiosk-1/authentication-method", { authenticationMethod: "nfc" }, { method: "PATCH", cookie: await sessionCookie("operator") }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/kiosks/kiosk-1/authentication-method", { authenticationMethod: "camera" }, { method: "PATCH", cookie: await sessionCookie("admin") }), env)).status, 400);
  const updated = await worker.fetch(request("/admin/kiosks/kiosk-1/authentication-method", { authenticationMethod: "nfc" }, { method: "PATCH", cookie: await sessionCookie("admin") }), env);
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { kioskId: "kiosk-1", authenticationMethod: "nfc" });
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosks SET configured_authentication_method") && call.values[0] === "nfc"));
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT INTO audit_log") && call.values.includes("kiosk.authentication_method_updated") && call.values.every((value) => value !== "raw-private-token")));
});

test("paired kiosk receives configured authentication method without credential material", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", pairingId: "pairing-1", pairingBound: 1, configuredAuthenticationMethod: "member_id" });
  database.rows.set("SELECT organization_name AS organizationName", { organizationName: "Example" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(new Request("https://api.example.test/kiosk/config", { headers: { authorization: "Bearer very-secret" } }), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { settings: Record<string, unknown> };
  assert.equal(body.settings.authenticationMethod, "member_id");
  assert.equal("credential" in body.settings, false);
  assert.equal("token" in body.settings, false);
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
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.github.com/repos/isriah/LancerLogin/commits/v0.22.0") return Response.json({ sha: "b".repeat(40) });
    assert.equal(String(input), "https://api.github.com/repos/isriah/LancerLogin/releases/latest");
    // GitHub rejects requests without an application User-Agent before returning releases.
    if (!new Headers(init?.headers).get("user-agent")) return new Response("User-Agent required", { status: 403 });
    return new Response(JSON.stringify({ tag_name: "v0.22.0", draft: false, prerelease: false, assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", "lancerlogin-kiosk-0.22.0-linux-arm64.tar.gz", "lancerlogin-kiosk-0.22.0-linux-arm64.tar.gz.sha256", "lancerlogin-kiosk-0.22.0-linux-armv7.tar.gz", "lancerlogin-kiosk-0.22.0-linux-armv7.tar.gz.sha256"].map(name => ({ name })) }), { headers: { "content-type": "application/json" } });
  };
  try {
    const rejected = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "install_latest", targetVersion: "v9.9.9", shell: "must-not-store" }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(rejected.status, 400);
    const update = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "install_latest" }, { cookie: await sessionCookie("admin") }), env);
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

test("latest kiosk update accepts strict stable majors and rejects incomplete releases without fallback", async () => {
  const cookie = await sessionCookie("admin");
  const originalFetch = globalThis.fetch;
  const release = (tag: string) => ({ tag_name: tag, draft: false, prerelease: false, assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap(arch => {
    const archive = `lancerlogin-kiosk-${tag.slice(1)}-linux-${arch}.tar.gz`;
    return [archive, `${archive}.sha256`];
  })].map(name => ({ name })) });
  const cases = [
    ...["v0.24.0", "v1.0.0", "v12.3.45"].map(tag => ({ payload: release(tag), status: 202 })),
    ...["v01.0.0", "v1.00.0", "v1.0.00", "v1.0", "1.0.0", "v1.0.0-beta", "v1.0.0+build", "v1.0.0\n", "v1.0.0/evil"].map(tag => ({ payload: release(tag), status: 503 })),
    { payload: { ...release("v1.0.0"), draft: true }, status: 503 },
    { payload: { ...release("v1.0.0"), prerelease: true }, status: 503 },
    { payload: { ...release("v1.0.0"), draft: undefined }, status: 503 },
    { payload: { ...release("v1.0.0"), prerelease: "false" }, status: 503 },
    { payload: { ...release("v1.0.0"), assets: [] }, status: 503 },
    ...release("v1.0.0").assets.map(missing => ({ payload: { ...release("v1.0.0"), assets: release("v1.0.0").assets.filter(asset => asset.name !== missing.name) }, status: 503 })),
  ];
  try {
    for (const item of cases) {
      const database = new FakeDatabase();
      database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", active: 1, releaseVersion: "0.23.2" });
      const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, WEB_UPDATE_TOKEN: "synthetic-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString(), DB: database } as unknown as Env;
      let calls = 0;
      globalThis.fetch = async (input, init) => { calls++; assert.equal(String(input), calls === 1 ? "https://api.github.com/repos/isriah/LancerLogin/releases/latest" : `https://api.github.com/repos/isriah/LancerLogin/commits/${item.payload.tag_name}`); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token"); assert.equal(init?.redirect, "manual"); return Response.json(calls === 1 ? item.payload : { sha: "b".repeat(40) }); };
      const result = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "install_latest" }, { cookie }), env);
      assert.equal(result.status, item.status, JSON.stringify(item.payload));
      assert.equal(calls, item.status === 202 ? 2 : 1);
      const insert = database.batches.at(-1)?.find(call => call.sql.includes("INSERT INTO kiosk_commands"));
      if (item.status === 202) assert.ok(insert?.values.includes(item.payload.tag_name));
      else assert.equal(insert, undefined);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("latest kiosk update keeps malformed or rate-limited release feeds unavailable", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", active: 1, releaseVersion: "0.21.0" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  try {
    const result = await worker.fetch(request("/admin/kiosks/kiosk-1/commands", { command: "install_latest" }, { cookie }), env);
    assert.equal(result.status, 503);
    assert.match(await result.text(), /No compatible official kiosk release/);
  } finally { globalThis.fetch = originalFetch; }
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
  assert.ok(batch.some((call) => call.sql.includes("UPDATE members SET inactive_periods_json") && call.sql.includes("active = 0")));
  assert.equal(batch.some((call) => call.sql.includes("UPDATE users")), false);
});

test("kiosk heartbeat hashes bearer credentials before D1 lookup", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const heartbeat = new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, authenticationMethod: "rfid", releaseVersion: "0.1.0", uptimeSeconds: 3600, networkType: "wifi", networkSignal: 71, lastWifiScanAt: "2026-09-01T19:00:00.000Z", pendingEvents: 2, lastSyncAt: "2026-09-01T20:00:00.000Z", errorCategory: null, rawScan: "must-not-store", credential: "must-not-store" }) });
  const result = await worker.fetch(heartbeat, env);
  assert.equal(result.status, 200);
  const lookup = database.calls.find((call) => call.sql.includes("FROM kiosks"));
  assert.ok(lookup);
  assert.notEqual(lookup.values[0], "very-secret");
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosks SET last_seen_at")));
  assert.equal(database.calls.some((call) => call.values.includes("must-not-store")), false);
  const healthUpdate = database.calls.find((call) => call.sql.includes("reader_online"));
  assert.deepEqual(healthUpdate?.values.slice(1, 4), [1, "rfid", "0.1.0"]);
  const invalid = new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, authenticationMethod: "camera", releaseVersion: "0.1.0" }) });
  assert.equal((await worker.fetch(invalid, env)).status, 400);
});

test("kiosk heartbeats maintain one multi-device Discord status message and scheduled reconciliation marks devices offline", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.1.3" });
  database.lists.set("FROM kiosks WHERE installation_id", [
    { id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.1.3" },
    { id: "kiosk-2", name: "Workshop", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.1.3" },
  ]);
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
    assert.match(String(outbound[0].init?.body), /2 of 2 online.*Front desk.*online.*Workshop.*online/s);
    assert.deepEqual(JSON.parse(String(outbound[0].init?.body)).allowed_mentions, { parse: [] });
    const stateWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_state") && call.values.includes("message-1"));
    assert.ok(stateWrite);

    database.rows.set("FROM integration_state", { externalId: "message-1", contentHash: stateWrite.values[1] });
    const manual = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
    assert.equal(manual.status, 200);
    assert.deepEqual(await manual.json(), { changed: false, messageId: "message-1", online: true, messageUrl: "https://discord.com/channels/123456789012345678/223456789012345678/message-1" });
    assert.ok(database.calls.some((call) => call.values.includes("discord.kiosk_status_updated")));
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.filter(call => call.init?.method !== "GET").length, 1, "unchanged online state should not edit Discord");

    database.lists.set("FROM kiosks WHERE installation_id", [
      { id: "kiosk-1", name: "Front desk", lastSeenAt: "2026-08-29T00:00:00Z", readerOnline: 1, releaseVersion: "0.1.3" },
      { id: "kiosk-2", name: "Workshop", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.1.3" },
    ]);
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.filter(call => call.init?.method !== "GET").length, 2);
    assert.equal(outbound.at(-1)?.init?.method, "PATCH");
    assert.match(String(outbound.at(-1)?.init?.body), /1 of 2 online.*Front desk.*offline.*last seen 2026-08-29.*Workshop.*online/s);
  } finally { globalThis.fetch = originalFetch; }
});

test("missing tracked Discord kiosk status messages are replaced and the new mapping is idempotent", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.lists.set("FROM kiosks WHERE installation_id", [{ id: "kiosk-1", name: "Front desk", lastSeenAt: "2026-08-29T00:00:00Z", readerOnline: 1, releaseVersion: "0.1.3" }]);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM integration_state", { externalId: "deleted-message", contentHash: "stale-content" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = []; let replacements = 0;
  globalThis.fetch = async (input, init) => {
    outbound.push({ input: String(input), init });
    if (init?.method === "GET") return new Response(JSON.stringify({ id: "replacement-message-1" }), { headers: { "content-type": "application/json" } });
    if (init?.method === "PATCH") return new Response(JSON.stringify({ code: 10_008, message: "Unknown Message" }), { status: 404, headers: { "content-type": "application/json" } });
    replacements += 1;
    return new Response(JSON.stringify({ id: `replacement-message-${replacements}` }), { headers: { "content-type": "application/json" } });
  };
  try {
    const recovered = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { changed: true, messageId: "replacement-message-1", online: false, messageUrl: "https://discord.com/channels/123456789012345678/223456789012345678/replacement-message-1" });
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
    assert.deepEqual(await unchanged.json(), { changed: false, messageId: "replacement-message-1", online: false, messageUrl: "https://discord.com/channels/123456789012345678/223456789012345678/replacement-message-1" });
    assert.equal(outbound.length, 3, "the persisted replacement should be verified without another write");
    assert.equal(outbound[2].init?.method, "GET");

    database.lists.set("FROM kiosks WHERE installation_id", [{ id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.1.3" }]);
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.length, 5, "scheduled reconciliation should also replace one missing tracked message");
    assert.equal(outbound[3].init?.method, "PATCH");
    assert.equal(outbound[4].init?.method, "POST");
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
    database.lists.set("FROM kiosks WHERE installation_id", [{ id: "kiosk-1", name: "Front desk", lastSeenAt: "2026-08-29T00:00:00Z", readerOnline: 1, releaseVersion: "0.1.3" }]);
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
  const weightedInsert = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO meetings")); assert.deepEqual(weightedInsert?.values.slice(-4), ["weight-long", "Long meeting", 2, "all"]);
  const explicitDefault = await worker.fetch(request("/meetings", { title: "Manual default", startsAt: "2026-09-11T18:00:00.000Z", endsAt: "2026-09-11T22:00:00.000Z", required: true, weightCategoryId: null }, { cookie }), env); assert.equal(explicitDefault.status, 201);
  const defaultInsert = database.batches.at(-1)?.find((call) => call.sql.includes("INSERT INTO meetings")); assert.deepEqual(defaultInsert?.values.slice(-4), [null, null, 1, "all"]);
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

test("report catalog and paginated queries are authenticated for both dashboard roles", async () => {
  for (const role of ["admin", "operator"] as const) {
    const database = new FakeDatabase(); seedPolicy(database, { baseline: "2026-09-01" });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const cookie = await sessionCookie(role);
    const catalog = await worker.fetch(request("/reports/catalog", undefined, { cookie }), env); assert.equal(catalog.status, 200); assert.equal((await catalog.json() as { defaultDefinition: { period: { type: string } } }).defaultDefinition.period.type, "baseline");
    const queried = await worker.fetch(request("/reports/query", { definition: defaultReportDefinition(true), page: 1, pageSize: 25 }, { cookie }), env); assert.equal(queried.status, 200); assert.deepEqual((await queried.json() as { pagination: { totalRows: number; pageSize: number } }).pagination, { page: 1, pageSize: 25, totalRows: 0, totalPages: 1, rangeStart: 0, rangeEnd: 0 });
  }
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: new FakeDatabase() } as unknown as Env;
  assert.equal((await worker.fetch(request("/reports/catalog"), env)).status, 401); assert.equal((await worker.fetch(request("/reports/query", { definition: defaultReportDefinition(false) }), env)).status, 401);
});

test("shared report visibility does not grant access to an unavailable module dataset", async () => {
  const database = new FakeDatabase(); seedPolicy(database);
  database.lists.set("SELECT id,name,archived FROM hours_labels", [{ id: "private-outreach-label", name: "Private Outreach label", archived: 0 }]);
  const definition = defaultReportDefinition(false, "outreach.activities");
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "attendance" ? { generation: 1 } : undefined);
  database.lists.set("FROM saved_report_views v", [{ id: "shared-outreach", ownerUserId: "admin-1", scope: "shared", name: "Outreach activities", definitionJson: JSON.stringify(definition), revision: 1, createdBy: "admin-1", updatedBy: "admin-1", createdAt: "2026-09-28", updatedAt: "2026-09-28", pinnedPosition: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator");
  const catalog = await (await worker.fetch(request("/reports/catalog", undefined, { cookie }), env)).json() as { datasets: Array<{ id: string; available: boolean }>; outreachLabels: Array<{ id: string }> };
  assert.equal(catalog.datasets.find((dataset) => dataset.id === "outreach.activities")?.available, false);
  assert.equal(catalog.datasets.find((dataset) => dataset.id === "attendance.members")?.available, true);
  assert.deepEqual(catalog.outreachLabels, []);
  const library = await (await worker.fetch(request("/reports/views", undefined, { cookie }), env)).json() as { reports: Array<{ id: string; definition: { dataset: string } }> };
  assert.deepEqual(library.reports.map((report) => [report.id, report.definition.dataset]), [["shared-outreach", "outreach.activities"]]);
  const result = await worker.fetch(request("/reports/query", { definition }, { cookie }), env);
  assert.equal(result.status, 200);
  const paused = await result.json() as { state: string; pausedReasons: string[]; rows: unknown[] };
  assert.equal(paused.state, "paused");
  assert.match(paused.pausedReasons.join(" "), /Outreach Participation is unavailable/);
  assert.deepEqual(paused.rows, []);
  const exported = await worker.fetch(request("/exports/report.csv", { definition }, { cookie }), env);
  assert.equal(exported.status, 409);
  assert.equal(database.calls.some((call) => call.sql.includes("FROM hours_activities")), false);
});

test("combined member reports mute unavailable measures and pause unavailable controls and exports", async () => {
  const member = { id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: null, discordUserId: null, active: 1, attendanceRequiredFrom: "2026-09-01" };
  const meeting = { id: "meeting-1", title: "Build", startsAt: "2026-09-02T20:00:00.000Z", endsAt: "2026-09-02T21:00:00.000Z", attendanceClosesAt: "2026-09-02T21:30:00.000Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 };
  const database = new FakeDatabase(); seedPolicy(database, { members: [member], meetings: [meeting], corrections: [{ meetingId: "meeting-1", memberId: "member-1", disposition: "present", reason: "Synthetic" }] });
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "attendance" ? { generation: 1 } : undefined);
  database.lists.set("SELECT c.member_id AS memberId, c.label_id AS labelId", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator"); const definition = defaultReportDefinition(false, "core.combined-members");
  const result = await worker.fetch(request("/reports/query", { definition }, { cookie }), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { state: string; warnings: string[]; columns: Array<{ key: string; available: boolean }>; rows: Array<{ cells: Record<string, { text: string; unavailable?: boolean }> }> };
  assert.equal(body.state, "ready");
  assert.equal(body.rows[0]?.cells["attendance.member.regular-rate"]?.text, "100%");
  assert.deepEqual(body.rows[0]?.cells["outreach.member.minutes"], { text: "Unavailable", sortValue: null, unavailable: true, explanation: "Outreach Participation is unavailable for your current module access. It will return when access is restored." });
  assert.equal(body.columns.find((column) => column.key === "outreach.member.minutes")?.available, false);
  assert.match(body.warnings.join(" "), /muted without cached or zero values/);
  assert.equal(database.calls.some((call) => call.sql.includes("FROM hours_entries")), false);

  const csv = await worker.fetch(request("/exports/report.csv", { definition }, { cookie }), env);
  assert.equal(csv.status, 200); assert.match(await csv.text(), /Unavailable/);
  const controlled = { ...definition, sort: { column: { key: "outreach.member.minutes" }, direction: "desc" as const } };
  const paused = await worker.fetch(request("/reports/query", { definition: controlled }, { cookie }), env);
  assert.equal(paused.status, 200); assert.equal((await paused.json() as { state: string }).state, "paused");
  assert.equal((await worker.fetch(request("/exports/report.csv", { definition: controlled }, { cookie }), env)).status, 409);
  const historical = { ...definition, membership: "historical" as const };
  const historicalResult = await worker.fetch(request("/reports/query", { definition: historical }, { cookie }), env);
  assert.equal((await historicalResult.json() as { state: string }).state, "ready");
});

test("Members detailed exports preserve cross-module filters, order and period with permission-scoped attendance", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, {
    members: ["Avery", "Blair", "Casey"].map((firstName, index) => ({ id: `member-${index}`, memberId: `M-${index}`, firstName, lastName: "Member", email: null, discordUserId: null, active: 1, attendanceRequiredFrom: "2026-09-01" })),
    meetings: [1, 2].map((day) => ({ id: `meeting-${day}`, title: `Meeting ${day}`, startsAt: `2026-09-0${day}T20:00:00Z`, endsAt: `2026-09-0${day}T21:00:00Z`, required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 })),
  });
  database.lists.set("SELECT c.member_id AS memberId, c.label_id AS labelId", []);
  database.lists.set("FROM hours_entries e JOIN hours_activities", [30, 90, 120].map((durationMinutes, index) => ({ id: `entry-${index}`, memberId: `member-${index}`, activityId: "activity-1", activityTitle: "Community event", serviceDate: "2026-09-02", durationMinutes, channel: "staff", status: "counted", activityMode: "event", teamId: null, activityLabels: "[]" })));
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const definition = { ...defaultReportDefinition(false, "core.combined-members"), period: { type: "fixed", from: "2026-09-02", to: "2026-09-02" }, columnFilters: [{ column: { key: "outreach.member.minutes", unit: "hours" }, operator: "minimum", value: "1" }], sort: { column: { key: "outreach.member.minutes", unit: "hours" }, direction: "desc" } };
  for (const role of ["admin", "operator"] as const) {
    const cookie = await sessionCookie(role);
    const detail = await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie }), env);
    assert.equal(detail.status, 200, await detail.clone().text());
    const csv = await detail.text();
    assert.equal(csv.trim().split("\r\n").length, 3);
    assert.ok(csv.indexOf("Casey") < csv.indexOf("Blair"));
    assert.doesNotMatch(csv, /Avery|Meeting 1/);
    assert.match(csv, /Meeting 2/);
  }
  const rangeDefinition = { ...definition, columnFilters: [{ column: { key: "outreach.member.minutes", unit: "hours" }, operator: "between", value: "0.5", upperValue: "1.5" }] };
  const rangeExport = await worker.fetch(request("/exports/report-detail.csv", { definition: rangeDefinition }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(rangeExport.status, 200);
  const rangeCsv = await rangeExport.text();
  assert.match(rangeCsv, /Avery/); assert.match(rangeCsv, /Blair/); assert.doesNotMatch(rangeCsv, /Casey/);
  const cookie = await sessionCookie("operator");
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "hour-tracking" ? { generation: 1 } : undefined);
  const forbidden = await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie }), env);
  assert.equal(forbidden.status, 403);
  database.rows.set("SELECT m.generation FROM users u", (_sql, values) => values[0] === "attendance" ? { generation: 1 } : undefined);
  assert.equal((await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie }), env)).status, 409);
  assert.equal((await worker.fetch(request("/exports/report-detail.csv", { definition: defaultReportDefinition(false, "outreach.activities") }, { cookie }), env)).status, 400);
});

test("Admins and Operators can create shared reports with duration units and creation pins the new tab", async () => {
  for (const role of ["admin", "operator"] as const) {
    const definition = defaultReportDefinition(false, "outreach.members");
    definition.columnFilters = [{ column: { key: "outreach.member.minutes", unit: "hours" }, operator: "between", value: "0", upperValue: "2.5" }];
    const database = new FakeDatabase(); seedPolicy(database); database.rows.set("COALESCE(MAX(position)", { position: 2 }); database.rows.set("SELECT id, owner_user_id AS ownerUserId", { id: "report-1", ownerUserId: `${role}-1`, scope: "shared", name: "Outreach ranked members", definitionJson: JSON.stringify(definition), revision: 1, createdBy: `${role}-1`, updatedBy: `${role}-1`, createdAt: "2026-09-25", updatedAt: "2026-09-25" });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(request("/reports/views", { name: "Outreach ranked members", scope: "shared", definition }, { cookie: await sessionCookie(role) }), env); assert.equal(result.status, 201);
    const reportInsert = database.batches[0].find((call) => call.sql.includes("INSERT INTO saved_report_views"));
    assert.ok(reportInsert?.values.includes("shared"));
    const stored = reportInsert?.values.find((value) => typeof value === "string" && value.startsWith('{"version"'));
    assert.equal((JSON.parse(String(stored)) as { columns: Array<{ key: string; unit?: string }> }).columns.find((column) => column.key === "outreach.member.minutes")?.unit, "hours");
    assert.deepEqual(JSON.parse(String(stored)).columnFilters, definition.columnFilters);
    assert.ok(database.batches[0].some((call) => call.sql.includes("INSERT INTO saved_report_tabs") && call.values.includes(2))); assert.ok(database.calls.some((call) => call.values.includes("report.created")));
  }
});

test("existing Outreach member reports without a unit normalize to hours in the saved library", async () => {
  const database = new FakeDatabase(); seedPolicy(database);
  const definition = defaultReportDefinition(false, "outreach.members");
  delete definition.columns.find((column) => column.key === "outreach.member.minutes")!.unit;
  database.lists.set("FROM saved_report_views v", [{ id: "outreach-ranked", ownerUserId: "admin-1", scope: "shared", name: "Outreach-ranked members", definitionJson: JSON.stringify(definition), revision: 1, createdBy: "admin-1", updatedBy: "admin-1", createdAt: "2026-09-25", updatedAt: "2026-09-25", pinnedPosition: 0 }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/reports/views", undefined, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { reports: Array<{ definition: { columns: Array<{ key: string; unit?: string }> } }> };
  assert.equal(body.reports[0]?.definition.columns.find((column) => column.key === "outreach.member.minutes")?.unit, "hours");
});

test("personal report isolation and revision checks reject unauthorized or stale edits", async () => {
  const personal = new FakeDatabase(); personal.rows.set("SELECT id, owner_user_id AS ownerUserId", (_sql, values) => values[1] === "admin-1" ? { id: "private-1", ownerUserId: "admin-1", scope: "personal", name: "Private", definitionJson: JSON.stringify(defaultReportDefinition(false)), revision: 1, createdBy: "admin-1", updatedBy: "admin-1", createdAt: "2026-09-25", updatedAt: "2026-09-25" } : undefined);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: personal } as unknown as Env;
  assert.equal((await worker.fetch(request("/reports/views/private-1", { name: "Changed", scope: "personal", definition: defaultReportDefinition(false), revision: 1 }, { method: "PATCH", cookie: await sessionCookie("operator") }), env)).status, 404);
  const shared = new FakeDatabase(); shared.rows.set("SELECT id, owner_user_id AS ownerUserId", { id: "shared-1", ownerUserId: "admin-1", scope: "shared", name: "Shared", definitionJson: JSON.stringify(defaultReportDefinition(false)), revision: 5, createdBy: "admin-1", updatedBy: "admin-1", createdAt: "2026-09-25", updatedAt: "2026-09-25" });
  assert.equal((await worker.fetch(request("/reports/views/shared-1", { name: "Changed", scope: "shared", definition: defaultReportDefinition(false), revision: 4 }, { method: "PATCH", cookie: await sessionCookie("operator") }), { ...env, DB: shared } as unknown as Env)).status, 409);
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
  const database = new FakeDatabase(); database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" }); database.lists.set("SELECT id AS rosterId, external_id AS memberId", [{ rosterId: "member-1", memberId: "R-1", firstName: "Avery", lastName: "Stone" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(new Request("https://api.example.test/kiosk/roster", { headers: { authorization: "Bearer very-secret" } }), env);
  assert.equal(result.status, 200); const text = await result.text(); assert.match(text, /Avery/); assert.match(text, /"rosterId":"member-1"/); assert.doesNotMatch(text, /fingerprint|template|biometric/i);
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
  database.rows.set("SELECT required, audience_mode AS audienceMode FROM meetings", { required: 1, audienceMode: "all" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/meetings/meeting-1", { title: "Updated rehearsal", startsAt: "2026-09-02T20:00:00.000Z", endsAt: "2026-09-02T22:00:00.000Z", required: true, notes: "Bring supplies" }, { method: "PATCH", cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  assert.ok(database.batches.some((batch) => batch.some((call) => call.sql.includes("UPDATE meetings SET") && call.values.includes("meeting-1") && call.values.includes("Bring supplies"))));
  assert.ok(database.batches.some((batch) => batch.some((call) => call.sql.includes("'meeting.updated'"))));
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
  future.lists.set("UPDATE meetings SET deleted_at", [{ id: "meeting-3" }]);
  const futureResult = await worker.fetch(request("/meetings/meeting-3", { scope: "future" }, { method: "DELETE", cookie: await sessionCookie("operator") }), { ...env, DB: future } as unknown as Env);
  assert.equal(futureResult.status, 200, await futureResult.clone().text());
  assert.ok(future.calls.some((call) => call.sql.includes("series_id = ?") && call.sql.includes("starts_at >= ?") && call.values.includes("series-1")));
  assert.ok(future.calls.some((call) => call.values.includes("meeting.series_deleted")));
});

test("Operator can immediately restore a soft-deleted meeting or future series occurrences", async () => {
  const single = new FakeDatabase();
  single.rows.set("deleted_at IS NOT NULL", { id: "meeting-1", seriesId: null, startsAt: "2026-09-01T20:00:00.000Z" });
  single.rows.set("SELECT m.generation", { generation: 1, startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: single } as unknown as Env;
  const occurrence = await worker.fetch(request("/meetings/meeting-1/restore", { scope: "occurrence", deletion: { meetingIds: ["meeting-1"], deletedAt: "2026-10-01T12:00:00.000Z" } }, { method: "POST", cookie: await sessionCookie("operator") }), env);
  assert.equal(occurrence.status, 200);
  assert.ok(single.batches.flat().some((call) => call.sql.includes("SET deleted_at = NULL") && call.values.includes('["meeting-1"]')));
  assert.ok(single.calls.some((call) => call.values.includes("meeting.restored")));
  assert.deepEqual((await occurrence.json() as { calendarSync: unknown }).calendarSync, { synced: 0, queued: 1, failed: 0 });
  assert.ok(single.batches.some((batch) => batch.some((call) => call.sql.includes("google_calendar_operations") && call.sql.includes("'upsert'"))));

  const future = new FakeDatabase();
  future.rows.set("deleted_at IS NOT NULL", { id: "meeting-3", seriesId: "series-1", startsAt: "2026-09-15T20:00:00.000Z" });
  future.lists.set("UPDATE meetings SET deleted_at", [{ id: "meeting-3" }]);
  const restored = await worker.fetch(request("/meetings/meeting-3/restore", { scope: "future", deletion: { meetingIds: ["meeting-3"], deletedAt: "2026-10-01T12:00:00.000Z" } }, { method: "POST", cookie: await sessionCookie("operator") }), { ...env, DB: future } as unknown as Env);
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok(future.batches.flat().some((call) => call.sql.includes("SET deleted_at = NULL") && call.values.includes('["meeting-3"]')));
  assert.ok(future.calls.some((call) => call.values.includes("meeting.series_restored")));
});

test("kiosk attendance is installation-scoped and idempotent by event ID", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk", pairingId: "legacy-pairing", pairingBound: 0 });
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

test("new kiosk credentials accept only scans captured under their exact pairing", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-2", name: "Replacement", pairingId: "pairing-2", pairingBound: 1 });
  database.rows.set("FROM members", { id: "member-1" });
  database.rows.set("FROM meetings", { id: "meeting-1", startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" });
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("FROM attendance_events", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const scan = (eventId: string, pairingId?: string) => new Request("https://api.example.test/kiosk/attendance", { method: "POST", headers: { authorization: "Bearer new-secret", "content-type": "application/json" }, body: JSON.stringify({ eventId, memberId: "ROSTER-001", meetingId: "meeting-1", occurredAt: "2026-09-01T20:02:00.000Z", ...(pairingId ? { pairingId } : {}) }) });
  const stale = await worker.fetch(scan("stale-queue-event"), env); assert.equal(stale.status, 409); assert.match(await stale.text(), /different kiosk pairing/i);
  assert.equal(database.calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events")), false);
  const accepted = await worker.fetch(scan("current-queue-event", "pairing-2"), env); assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events") && call.values.includes("current-queue-event")));
});

test("attendance export is authenticated, quoted, and safe to open in spreadsheet software", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, { members: [{ id: "member-1", memberId: "=HYPERLINK(\"https://example.test\")", firstName: "+Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio, weekly", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 2.5, audienceMode: "all", isTest: 0 }], events: [{ meetingId: "meeting-1", memberId: "member-1", action: "check_in", occurredAt: "2026-09-01T20:02:00Z" }, { meetingId: "meeting-1", memberId: "member-1", action: "check_out", occurredAt: "2026-09-01T21:58:00Z" }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/exports/attendance.csv"), env)).status, 401);
  const result = await worker.fetch(request("/exports/attendance.csv", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await result.text();
  assert.match(csv, /"Studio, weekly"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /'\+Avery/);
  assert.match(csv, /audience,required,attendanceWeight/); assert.match(csv, /regularEligible,regularWeight,regularWeightedPresent,regularRate,regularAttended,regularRequired,regularFrom,regularTo/); assert.match(csv, /policyLabel,policyRuleType,policyExcusedHandling,policyStatus/); assert.match(csv, /All,true,2\.5/); assert.match(csv, /present,required,true,2\.5,2\.5,100,2\.5,2\.5/);
  assert.ok(database.calls.some((call) => call.sql.includes("FROM attendance_events e JOIN meetings mt")));
  assert.ok(database.calls.some((call) => call.sql.includes("FROM attendance_corrections c JOIN meetings mt")));
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
  assert.ok([...database.calls, ...database.batches.flat()].some((call) => call.sql.includes("discord_enabled = ?") && call.values[0] === 1));
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

test("kiosk accepts a delayed scan using its original time after the meeting has ended", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  database.rows.set("FROM members", { id: "member-1", externalId: "SYNTHETIC-001", firstName: "Avery", lastName: "Stone" });
  database.rows.set("starts_at <= ?", { id: "meeting-1", title: "Synthetic meeting", startsAt: "2026-09-19T12:00:00.000Z", endsAt: "2026-09-19T22:00:00.000Z" });
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("FROM attendance_events", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(new Request("https://api.example.test/kiosk/attendance", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ eventId: "delayed-scan-1", memberId: "SYNTHETIC-001", occurredAt: "2026-09-19T14:00:00.000Z" }) }), env);
  assert.equal(result.status, 202);
  const payload = await result.json() as { accepted: boolean; member: { displayName: string }; meeting: { id: string } };
  assert.equal(payload.accepted, true);
  assert.equal(payload.member.displayName, "Avery Stone");
  assert.equal(payload.meeting.id, "meeting-1");
  assert.ok(database.calls.find((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events"))?.values.includes("2026-09-19T14:00:00.000Z"));
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
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/communications/email", { kind: "missed-meeting", memberId: "member-1", meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 503); assert.match((await result.json() as { error: string }).error, /verification is required/);
});

test("Discord verification reconciles the five managed guild commands before its signed user click", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = []; const guildCommands: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); outbound.push({ input: url, init });
    if (url.endsWith("/users/@me")) return Response.json({ id: "bot-1" });
    if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: "103456789012345678" });
    if (url.endsWith("/guilds/123456789012345678")) return Response.json({ id: "123456789012345678" });
    if (url.endsWith("/channels/223456789012345678")) return Response.json({ guild_id: "123456789012345678", type: 0 });
    if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const command = JSON.parse(String(init?.body)) as Record<string, unknown>; guildCommands.push({ ...command, id: `command-${guildCommands.length + 1}`, application_id: "103456789012345678", guild_id: "123456789012345678" }); return Response.json(guildCommands.at(-1)); }
    if (url.endsWith("/channels/223456789012345678/messages")) return Response.json({ id: "verification-message-1" });
    throw new Error(`Unexpected live request: ${url}`);
  };
  try {
    const started = await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
    assert.equal(started.status, 202); assert.match(outbound[0].input, /users\/@me$/); assert.match(outbound[1].input, /oauth2\/applications\/@me$/); assert.match(outbound[2].input, /guilds\/123456789012345678$/); assert.match(outbound[3].input, /channels\/223456789012345678$/); assert.match(outbound[4].input, /applications\/103456789012345678\/guilds\/123456789012345678\/commands$/); assert.equal(outbound[4].init?.method, "GET"); assert.deepEqual(outbound.slice(5, 10).map((call) => call.init?.method), ["POST", "POST", "POST", "POST", "POST"]); assert.match(outbound[11].input, /channels\/223456789012345678\/messages$/);
    assert.equal(outbound.every(({ input }) => input.startsWith("https://discord.com/api/v10/")), true); assert.equal(outbound.some(({ input }) => /\/applications\/103456789012345678\/commands$/.test(input)), false);
    assert.deepEqual(outbound.slice(5, 10).map((call) => JSON.parse(String(call.init?.body))), [{ name: "pair", type: 1, description: "Link your Discord account to your LancerLogin member ID", options: [{ name: "member-id", description: "Your LancerLogin member ID", type: 3, required: true }] }, { name: "attendance-report", type: 1, description: "Privately view your current LancerLogin attendance report" }, { name: "label", type: 1, description: "Associate a Discord role with a matching LancerLogin label", options: [{ name: "role", description: "Discord role to associate", type: 8, required: true }] }, { name: "outreach-submit", type: 1, description: "Record completed Outreach participation for your linked member", options: [{ name: "activity", description: "Dated Outreach activity reference or exact title", type: 3, required: true }, { name: "start", description: "Local start time in HH:MM format", type: 3, required: true }, { name: "end", description: "Local end time in HH:MM format", type: 3, required: true }, { name: "notes", description: "Private task notes for Staff", type: 3 }] }, { name: "outreach-correction", type: 1, description: "Ask Staff to review linked Outreach participation", options: [{ name: "message", description: "What Staff should review", type: 3, required: true }, { name: "receipt", description: "Participation receipt reference", type: 3 }, { name: "date", description: "Service date in YYYY-MM-DD format", type: 3 }] }]);
    const payload = JSON.parse(String(outbound[11].init?.body)); const customId = payload.components[0].components[0].custom_id as string; const token = customId.slice("lancerlogin-verify:".length);
    const challengeWrite = database.calls.find((call) => call.sql.includes("INSERT INTO integration_verification_challenges")); assert.ok(challengeWrite); assert.equal(challengeWrite.values[0], createHash("sha256").update(token).digest("base64url")); assert.equal(challengeWrite.values.includes(token), false);
    database.rows.set("FROM integration_verification_challenges", { challengeHash: challengeWrite.values[0], target: "123456789012345678", externalId: "verification-message-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const body = JSON.stringify({ type: 3, guild_id: "123456789012345678", data: { custom_id: customId }, member: { user: { id: "323456789012345678" } }, message: { id: "verification-message-1" } }); const timestamp = String(Math.floor(Date.now() / 1000)); const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
    const interaction = new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
    const verified = await worker.fetch(interaction, env); assert.equal(verified.status, 200); assert.match(JSON.stringify(await verified.json()), /LancerLogin is verified/); assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE encrypted_integrations SET verified_at")));
  } finally { globalThis.fetch = originalFetch; }
});

test("signed /label offers an exact active match only to a paired Admin and confirms once", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const guildId = "123456789012345678", roleId = "423456789012345678", botId = "523456789012345678", botRoleId = "623456789012345678", adminId = "723456789012345678";
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration({ botToken: "secret", guildId, publicKey: publicKeyHex }, sessionSecret), verifiedAt: new Date().toISOString(), enabled: 1 });
  database.rows.set("u.id AS userId, u.role", { userId: "admin-1", role: "admin" });
  database.rows.set("SELECT id, name FROM member_labels", (_sql: string, values: unknown[]) => String(values[0]).toLowerCase() === "frc 321" || values[0] === "label-1" ? { id: "label-1", name: "FRC 321" } : null);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  let roleName = "frc 321", roleManaged = false; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/roles")) return Response.json([{ id: guildId, name: "@everyone", position: 0, permissions: "0" }, { id: botRoleId, name: "Bot", position: 10, permissions: String(1 << 28) }, { id: roleId, name: roleName, position: 2, permissions: "0", managed: roleManaged }]);
    if (url.endsWith("/users/@me")) return Response.json({ id: botId });
    if (url.endsWith(`/members/${botId}`)) return Response.json({ user: { id: botId }, roles: [botRoleId] });
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  try {
    const command = { type: 2, guild_id: guildId, member: { user: { id: adminId } }, data: { name: "label", options: [{ name: "role", value: roleId }] } };
    const offered = await worker.fetch(signedDiscordInteraction(command, privateKey), env);
    const body = await offered.json() as { data: { flags: number; components: { components: { custom_id: string }[] }[] } };
    assert.equal(body.data.flags, 64); const customId = body.data.components[0].components[0].custom_id;
    assert.match(customId, /^lancerlogin-label:/);
    const challengeWrite = database.calls.find((call) => call.sql.includes("INSERT INTO discord_label_role_challenges")); assert.ok(challengeWrite);
    assert.equal(challengeWrite.values[0], createHash("sha256").update(customId.slice("lancerlogin-label:".length)).digest("base64url"));
    database.rows.set("FROM discord_label_role_challenges", { labelId: "label-1", guildId, roleId, discordUserId: adminId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const confirmation = { type: 3, guild_id: guildId, member: { user: { id: adminId } }, data: { custom_id: customId } };
    assert.match(JSON.stringify(await (await worker.fetch(signedDiscordInteraction(confirmation, privateKey), env)).json()), /Associated/);
    assert.ok(database.calls.some((call) => call.sql.includes("INSERT INTO discord_label_role_mappings") && call.values.includes(roleId)));
    database.runChangeHandler = (sql) => sql.includes("UPDATE discord_label_role_challenges") ? 0 : 1;
    assert.match(JSON.stringify(await (await worker.fetch(signedDiscordInteraction(confirmation, privateKey), env)).json()), /already used/);
    roleName = "Unmatched";
    assert.match(JSON.stringify(await (await worker.fetch(signedDiscordInteraction(command, privateKey), env)).json()), /No active LancerLogin label/);
    roleName = "FRC 321"; roleManaged = true;
    assert.match(JSON.stringify(await (await worker.fetch(signedDiscordInteraction(command, privateKey), env)).json()), /managed, privileged/);
    database.rows.set("u.id AS userId, u.role", null);
    assert.match(JSON.stringify(await (await worker.fetch(signedDiscordInteraction(command, privateKey), env)).json()), /Pair a roster member/);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord role preview reconciles the whole server and rejects a stale apply", async () => {
  const database = new FakeDatabase(); const guildId = "123456789012345678", roleId = "423456789012345678", botId = "523456789012345678", botRoleId = "623456789012345678";
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration({ botToken: "secret", guildId }, sessionSecret), verifiedAt: new Date().toISOString(), enabled: 1 });
  database.rows.set("FROM discord_label_role_mappings x JOIN", { labelId: "label-1", labelName: "FRC 321", active: 1, guildId, roleId, roleName: "FRC 321", createdAt: new Date().toISOString() });
  database.rows.set("SELECT time_zone AS timeZone", { timeZone: "UTC" });
  const roster = [
    { id: "m1", memberId: "A1", firstName: "Ada", lastName: "One", discordUserId: "111111111111111111", active: 1, labelAction: "add" },
    { id: "m2", memberId: "A2", firstName: "Bo", lastName: "Two", active: 1, labelAction: "add" },
    { id: "m3", memberId: "A3", firstName: "Cy", lastName: "Three", discordUserId: "555555555555555555", active: 1, labelAction: "add" },
    { id: "m4", memberId: "A4", firstName: "Di", lastName: "Four", discordUserId: "333333333333333333", active: 0, labelAction: "add" },
    { id: "m5", memberId: "A5", firstName: "Ed", lastName: "Five", discordUserId: "444444444444444444", active: 1, labelAction: null },
  ];
  database.lists.set("FROM members m WHERE m.installation_id", roster);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let denyMemberList = false, paginate = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/roles")) return Response.json([{ id: guildId, name: "@everyone", position: 0, permissions: "0" }, { id: botRoleId, name: "Bot", position: 10, permissions: String(1 << 28) }, { id: roleId, name: "FRC 321", position: 2, permissions: "0" }]);
    if (url.endsWith("/users/@me")) return Response.json({ id: botId });
    if (url.endsWith(`/members/${botId}`)) return Response.json({ user: { id: botId }, roles: [botRoleId] });
    if (url.includes("/members?limit=1000")) {
      if (denyMemberList) return Response.json({ message: "Missing intent" }, { status: 403 });
      if (paginate) return Response.json(url.endsWith("after=0") ? Array.from({ length: 1000 }, (_, index) => ({ user: { id: String(100000000000000000n + BigInt(index)) }, roles: [] })) : [{ user: { id: "100000000000001000" }, roles: [roleId] }]);
      return Response.json([{ user: { id: "111111111111111111", username: "Ada" }, roles: [] }, { user: { id: "222222222222222222", username: "Unpaired" }, roles: [roleId] }, { user: { id: "333333333333333333", username: "Di" }, roles: [roleId] }, { user: { id: "444444444444444444", username: "Ed" }, roles: [roleId] }]);
    }
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  try {
    assert.equal((await worker.fetch(request("/admin/integrations/discord/label-roles/preview", { labelId: "label-1" }, { cookie: await sessionCookie("operator") }), env)).status, 403);
    const result = await worker.fetch(request("/admin/integrations/discord/label-roles/preview", { labelId: "label-1" }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(result.status, 200);
    const body = await result.json() as { previewId: string; additions: unknown[]; removals: unknown[]; unpaired: unknown[]; absent: unknown[]; inactive: unknown[] };
    assert.equal(body.additions.length, 1); assert.equal(body.removals.length, 3); assert.equal(body.unpaired.length, 1); assert.equal(body.absent.length, 1); assert.equal(body.inactive.length, 1);
    const previewWrite = database.calls.find((call) => call.sql.includes("INSERT INTO discord_label_role_previews")); assert.ok(previewWrite);
    database.rows.set("FROM discord_label_role_previews", { id: body.previewId, labelId: "label-1", guildId, roleId, fingerprint: previewWrite.values[4], actorUserId: "admin-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const applied = await worker.fetch(request("/admin/integrations/discord/label-roles/apply", { previewId: body.previewId }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(applied.status, 202, await applied.clone().text());
    assert.equal(database.batches.at(-1)?.filter((call) => call.sql.includes("INSERT INTO discord_label_role_job_items")).length, 4);
    const batchesBeforeStale = database.batches.length;
    database.rows.set("FROM discord_label_role_previews", { id: "preview-stale", labelId: "label-1", guildId, roleId, fingerprint: previewWrite.values[4], actorUserId: "admin-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    roster[0].discordUserId = "666666666666666666";
    const stale = await worker.fetch(request("/admin/integrations/discord/label-roles/apply", { previewId: "preview-stale" }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(stale.status, 409); assert.equal(database.batches.length, batchesBeforeStale);
    denyMemberList = true;
    const unavailable = await worker.fetch(request("/admin/integrations/discord/label-roles/preview", { labelId: "label-1" }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(unavailable.status, 502); assert.match((await unavailable.json() as { error: string }).error, /Guild Members intent/);
    denyMemberList = false; paginate = true;
    const multiPage = await worker.fetch(request("/admin/integrations/discord/label-roles/preview", { labelId: "label-1" }, { cookie: await sessionCookie("admin") }), env);
    assert.equal(multiPage.status, 200);
    const large = await multiPage.json() as { memberCount: number; removals: unknown[] };
    assert.equal(large.memberCount, 1001); assert.equal(large.removals.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("manual Discord role job applies only its mapped role and reports completed outcomes", async () => {
  const database = new FakeDatabase(); const guildId = "123456789012345678", roleId = "423456789012345678", botId = "523456789012345678", botRoleId = "623456789012345678";
  const roster = [{ id: "m1", memberId: "A1", firstName: "Ada", lastName: "One", discordUserId: "111111111111111111", active: 1, labelAction: "add" }];
  const today = new Date().toISOString().slice(0, 10);
  const sourceFingerprint = createHash("sha256").update(JSON.stringify({ labelId: "label-1", roleId, guildId, today, active: 1, roster })).digest("base64url");
  const job = { id: "job-1", labelId: "label-1", guildId, roleId, status: "pending", sourceFingerprint, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const items = [{ discordUserId: "111111111111111111", action: "add", status: "pending", attempts: 0 }, { discordUserId: "222222222222222222", action: "remove", status: "pending", attempts: 0 }];
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration({ botToken: "secret", guildId }, sessionSecret), verifiedAt: new Date().toISOString(), enabled: 1 });
  database.rows.set("SELECT id FROM discord_label_role_jobs", (sql: string) => sql.includes("label_id =") ? null : { id: job.id });
  database.rows.set("source_fingerprint AS sourceFingerprint", () => ["pending", "running"].includes(job.status) ? job : null);
  database.rows.set("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, status", job);
  database.rows.set("FROM discord_label_role_mappings x JOIN", { labelId: "label-1", labelName: "FRC 321", active: 1, guildId, roleId, roleName: "FRC 321", createdAt: new Date().toISOString() });
  database.rows.set("SELECT time_zone AS timeZone", { timeZone: "UTC" });
  database.rows.set("SUM(CASE WHEN status = 'pending'", () => ({ pending: items.filter((item) => item.status === "pending").length, failed: 0 }));
  database.lists.set("FROM members m WHERE m.installation_id", roster);
  database.lists.set("status = 'pending' ORDER BY discord_user_id", () => items.filter((item) => item.status === "pending"));
  database.lists.set("ORDER BY action, discord_user_id", items);
  database.runChangeHandler = (sql, values) => { if (sql.includes("UPDATE discord_label_role_job_items SET status = 'completed'")) items.find((item) => item.discordUserId === values[1])!.status = "completed"; if (sql.includes("UPDATE discord_label_role_jobs SET status = ?")) job.status = String(values[0]); return 1; };
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/roles")) return Response.json([{ id: guildId, name: "@everyone", position: 0, permissions: "0" }, { id: botRoleId, name: "Bot", position: 10, permissions: String(1 << 28) }, { id: roleId, name: "FRC 321", position: 2, permissions: "0" }]);
    if (url.endsWith("/users/@me")) return Response.json({ id: botId });
    if (url.endsWith(`/members/${botId}`)) return Response.json({ user: { id: botId }, roles: [botRoleId] });
    if (url.includes(`/roles/${roleId}`)) { writes.push(`${init?.method} ${url}`); return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  try {
    assert.equal((await worker.fetch(request(`/admin/integrations/discord/label-role-jobs/${job.id}/advance`, {}, { method: "POST", cookie: await sessionCookie("operator") }), env)).status, 403);
    const advanced = await worker.fetch(request(`/admin/integrations/discord/label-role-jobs/${job.id}/advance`, {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
    assert.equal(advanced.status, 200, await advanced.clone().text()); assert.equal((await advanced.json() as { status: string }).status, "completed");
    assert.deepEqual(writes.map((entry) => entry.split(" ")[0]).sort(), ["DELETE", "PUT"]);
    await worker.fetch(request(`/admin/integrations/discord/label-role-jobs/${job.id}/advance`, {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
    assert.equal(writes.length, 2, "repeated advance must not resend completed changes");
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord role jobs defer rate limits and retry only unresolved failed changes", async () => {
  const database = new FakeDatabase(); const guildId = "123456789012345678", roleId = "423456789012345678", botId = "523456789012345678", botRoleId = "623456789012345678", userId = "111111111111111111";
  const roster = [{ id: "m1", memberId: "A1", firstName: "Ada", lastName: "One", discordUserId: userId, active: 1, labelAction: "add" }];
  const sourceFingerprint = createHash("sha256").update(JSON.stringify({ labelId: "label-1", roleId, guildId, today: new Date().toISOString().slice(0, 10), active: 1, roster })).digest("base64url");
  const job = { id: "job-1", labelId: "label-1", guildId, roleId, status: "pending", sourceFingerprint, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const item = { discordUserId: userId, action: "add", status: "pending", attempts: 0, lastError: "" };
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration({ botToken: "secret", guildId }, sessionSecret), verifiedAt: new Date().toISOString(), enabled: 1 });
  database.rows.set("SELECT id FROM discord_label_role_jobs", (sql: string) => sql.includes("label_id =") ? null : { id: job.id });
  database.rows.set("source_fingerprint AS sourceFingerprint", () => ["pending", "running"].includes(job.status) ? job : null);
  database.rows.set("SELECT id, label_id AS labelId, guild_id AS guildId, role_id AS roleId, status", job);
  database.rows.set("SELECT id, label_id AS labelId, role_id AS roleId, status", job);
  database.rows.set("FROM discord_label_role_mappings x JOIN", { labelId: "label-1", labelName: "FRC 321", active: 1, guildId, roleId, roleName: "FRC 321", createdAt: new Date().toISOString() });
  database.rows.set("SELECT time_zone AS timeZone", { timeZone: "UTC" });
  database.rows.set("SUM(CASE WHEN status = 'pending'", () => ({ pending: item.status === "pending" ? 1 : 0, failed: item.status === "failed" ? 1 : 0 }));
  database.lists.set("FROM members m WHERE m.installation_id", roster);
  database.lists.set("status = 'pending' ORDER BY discord_user_id", () => item.status === "pending" ? [item] : []);
  database.lists.set("ORDER BY action, discord_user_id", [item]);
  database.lists.set("status = 'failed'", () => item.status === "failed" ? [item] : []);
  database.runChangeHandler = (sql, values) => { if (sql.includes("UPDATE discord_label_role_job_items SET status = 'failed'")) { item.status = "failed"; item.lastError = String(values[0]); } if (sql.includes("UPDATE discord_label_role_jobs SET status = ?")) job.status = String(values[0]); return 1; };
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let mutationCount = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/roles")) return Response.json([{ id: guildId, name: "@everyone", position: 0, permissions: "0" }, { id: botRoleId, name: "Bot", position: 10, permissions: String(1 << 28) }, { id: roleId, name: "FRC 321", position: 2, permissions: "0" }]);
    if (url.endsWith("/users/@me")) return Response.json({ id: botId });
    if (url.endsWith(`/members/${botId}`)) return Response.json({ user: { id: botId }, roles: [botRoleId] });
    if (url.includes("/members?limit=1000")) return Response.json([{ user: { id: userId, username: "Ada" }, roles: [] }]);
    if (url.includes(`/members/${userId}/roles/${roleId}`)) return ++mutationCount === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : Response.json({ message: "Missing permissions" }, { status: 403 });
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  try {
    const admin = await sessionCookie("admin");
    const first = await worker.fetch(request(`/admin/integrations/discord/label-role-jobs/${job.id}/advance`, {}, { method: "POST", cookie: admin }), env);
    assert.equal((await first.json() as { status: string }).status, "pending"); assert.equal(item.status, "pending");
    assert.ok(database.calls.some((call) => call.sql.includes("next_attempt_at = ?") && String(call.values[1]) > new Date(Date.now() - 1000).toISOString()));
    const second = await worker.fetch(request(`/admin/integrations/discord/label-role-jobs/${job.id}/advance`, {}, { method: "POST", cookie: admin }), env);
    assert.equal((await second.json() as { status: string }).status, "partial"); assert.equal(item.status, "failed");
    const retried = await worker.fetch(request(`/admin/integrations/discord/label-role-jobs/${job.id}/retry`, {}, { method: "POST", cookie: admin }), env);
    assert.equal(retried.status, 202, await retried.clone().text()); assert.equal((await retried.json() as { retried: number }).retried, 1);
    assert.equal(database.batches.at(-1)?.filter((call) => call.sql.includes("INSERT INTO discord_label_role_job_items")).length, 1);
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
  const originalFetch = globalThis.fetch; const commandBodies: unknown[] = []; const guildCommands: Record<string, unknown>[] = []; const authorizations: string[] = [];
  globalThis.fetch = async (input, init) => { const url = String(input); authorizations.push(String((init?.headers as Record<string, string>).authorization)); if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: config.applicationId }); if (url.endsWith(`/guilds/${config.guildId}`)) return Response.json({ id: config.guildId }); if (url.endsWith(`/channels/${config.channelId}`)) return Response.json({ guild_id: config.guildId, type: 0 }); if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const body = JSON.parse(String(init?.body)) as Record<string, unknown>; commandBodies.push(body); const command = { ...body, id: `command-${guildCommands.length}`, application_id: config.applicationId, guild_id: config.guildId }; guildCommands.push(command); return Response.json(command); } if (url.includes("/channels/")) return Response.json({ id: crypto.randomUUID() }); return Response.json({ id: "bot-1" }); };
  try {
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    const rotated = { ...config, botToken: "rotated-discord-secret" }; database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(rotated, sessionSecret), verifiedAt: null });
    assert.equal((await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env)).status, 202);
    assert.equal(commandBodies.length, 5); assert.deepEqual(commandBodies.map((item) => (item as { name: string }).name), ["pair", "attendance-report", "label", "outreach-submit", "outreach-correction"]); assert.ok(authorizations.includes("Bot rotated-discord-secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("configured Discord integrations reconcile commands without resetting legacy or operational state", async () => {
  const applicationId = "103456789012345678"; const guildId = "123456789012345678"; const channelId = "223456789012345678";
  const run = async (savedApplicationId?: string) => {
    const database = new FakeDatabase(); const config = { botToken: "discord-secret", guildId, channelId, publicKey: "a".repeat(64), ...(savedApplicationId ? { applicationId: savedApplicationId } : {}) };
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(config, sessionSecret), verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; const outbound: Array<{ input: string; init?: RequestInit }> = []; const guildCommands: Record<string, unknown>[] = [{ name: "unrelated", type: 1, description: "Preserve me", application_id: applicationId, guild_id: guildId }];
    globalThis.fetch = async (input, init) => {
      const url = String(input); outbound.push({ input: url, init });
      if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: applicationId });
      if (url.endsWith(`/guilds/${guildId}`)) return Response.json({ id: guildId });
      if (url.endsWith(`/channels/${channelId}`)) return Response.json({ guild_id: guildId, type: 0 });
      if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const command = JSON.parse(String(init?.body)) as Record<string, unknown>; const saved = { ...command, id: `command-${guildCommands.length}`, application_id: applicationId, guild_id: guildId }; guildCommands.push(saved); return Response.json(saved); }
      throw new Error(`Unexpected live request: ${url}`);
    };
    try {
      assert.equal((await worker.fetch(request("/admin/integrations/discord/commands/reconcile", {}, { method: "POST", cookie: await sessionCookie("operator") }), env)).status, 403);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await worker.fetch(request("/admin/integrations/discord/commands/reconcile", {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
        assert.equal(result.status, 200); assert.deepEqual(await result.json(), { provider: "discord", reconciled: true, commands: ["pair", "attendance-report", "label", "outreach-submit", "outreach-correction"] });
      }
      assert.equal(outbound.filter(({ input }) => input.endsWith("/commands")).length, 9);
      assert.equal(outbound.filter(({ input, init }) => input.endsWith("/commands") && init?.method === "POST").length, 5);
      assert.equal(guildCommands[0].name, "unrelated");
      assert.ok(outbound.filter(({ input }) => input.endsWith("/commands")).every(({ input }) => input.endsWith(`/applications/${applicationId}/guilds/${guildId}/commands`)));
      assert.equal(database.batches.length, 2);
      assert.equal(database.calls.some((call) => /UPDATE encrypted_integrations|integration_verification_challenges|discord_calendar_|UPDATE organization_settings/.test(call.sql)), false);
      assert.equal(database.calls.filter((call) => call.values.includes("discord.commands_reconciled")).length, 2);
    } finally { globalThis.fetch = originalFetch; }
  };
  await run();
  await run(applicationId);
});

test("verified Discord commands register automatically once for each command definition", async () => {
  const applicationId = "103456789012345678", guildId = "123456789012345678", channelId = "223456789012345678";
  const database = new FakeDatabase();
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration({ botToken: "discord-secret", applicationId, guildId, channelId }, sessionSecret), verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: string[] = []; const guildCommands: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); outbound.push(url);
    if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: applicationId });
    if (url.endsWith(`/guilds/${guildId}`)) return Response.json({ id: guildId });
    if (url.endsWith(`/channels/${channelId}`)) return Response.json({ guild_id: guildId, type: 0 });
    if (url.endsWith("/commands")) { if (init?.method === "GET") return Response.json(guildCommands); const command = { ...(JSON.parse(String(init?.body)) as Record<string, unknown>), application_id: applicationId, guild_id: guildId }; guildCommands.push(command); return Response.json(command); }
    throw new Error(`Unexpected Discord request: ${url}`);
  };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.filter((url) => url.endsWith("/commands")).length, 7);
    const saved = database.batches.flat().find((item) => item.sql.includes("'managed-commands'"));
    assert.ok(saved);
    database.rows.set("SELECT content_hash AS fingerprint FROM integration_state", { fingerprint: saved.values[1] });
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(outbound.filter((url) => url.endsWith("/commands")).length, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord command repair preserves configured state on identity and verification failures", async () => {
  const config = { botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) };
  const run = async (verifiedAt: string | null, returnedApplicationId = "999999999999999999") => {
    const database = new FakeDatabase(); database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(config, sessionSecret), verifiedAt, enabled: 1 });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; const outbound: string[] = [];
    globalThis.fetch = async (input) => { outbound.push(String(input)); return Response.json({ id: returnedApplicationId }); };
    try {
      const result = await worker.fetch(request("/admin/integrations/discord/commands/reconcile", {}, { method: "POST", cookie: await sessionCookie("admin") }), env);
      const malformedIdentity = returnedApplicationId === "not-an-application-id";
      assert.equal(result.status, verifiedAt ? malformedIdentity ? 502 : 400 : 503); assert.match(JSON.stringify(await result.json()), !verifiedAt ? /verification is required/ : malformedIdentity ? /did not return the bot application's identity/ : /does not belong to this bot token/);
      assert.equal(outbound.some((url) => url.endsWith("/commands")), false);
      assert.equal(database.batches.length, 0);
      assert.equal(database.calls.some((call) => /UPDATE encrypted_integrations|integration_verification_challenges|discord_calendar_|UPDATE organization_settings|DELETE FROM integration_state/.test(call.sql)), false);
      assert.equal(database.calls.some((call) => call.values.includes("discord.commands_reconciled")), false);
    } finally { globalThis.fetch = originalFetch; }
  };
  await run("2026-09-04T00:01:00Z");
  await run("2026-09-04T00:01:00Z", "not-an-application-id");
  await run(null);
});

test("Discord command setup reports identity, credential, permission, rate-limit, validation, and partial failures safely", async () => {
  const base = { botToken: "discord-secret", applicationId: "103456789012345678", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) };
  const run = async (failure: "application" | "guild" | "channel" | "credential" | "permission" | "rate" | "validation" | "partial" | "message") => {
    const database = new FakeDatabase(); database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...await encryptIntegration(base, sessionSecret), verifiedAt: null }); const calls: string[] = []; const guildCommands: Record<string, unknown>[] = [];
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const originalFetch = globalThis.fetch; globalThis.fetch = async (input, init) => { const url = String(input); calls.push(url); if (failure === "credential" && url.endsWith("/users/@me")) return Response.json({ message: "401: Unauthorized" }, { status: 401 }); if (url.endsWith("/oauth2/applications/@me")) return Response.json({ id: failure === "application" ? "999999999999999999" : base.applicationId }); if (url.endsWith(`/guilds/${base.guildId}`)) return Response.json({ id: failure === "guild" ? "999999999999999999" : base.guildId }); if (url.endsWith(`/channels/${base.channelId}`)) return Response.json({ guild_id: failure === "channel" ? "999999999999999999" : base.guildId, type: 0 }); if (url.endsWith("/commands")) { if (failure === "permission") return Response.json({ message: "Missing Access" }, { status: 403 }); if (failure === "rate") return Response.json({ message: "rate limited", retry_after: 0 }, { status: 429 }); if (failure === "validation") return Response.json({ message: "Invalid Form Body" }, { status: 400 }); if (init?.method === "GET") return Response.json(guildCommands); const item = JSON.parse(String(init?.body)) as Record<string, unknown>; const confirmed = { ...item, id: `command-${guildCommands.length}`, application_id: base.applicationId, guild_id: base.guildId }; if (failure !== "partial" || guildCommands.length === 0) guildCommands.push(confirmed); return Response.json(confirmed); } if (url.endsWith(`/channels/${base.channelId}/messages`) && failure === "message") return Response.json({ message: "Missing Access" }, { status: 403 }); if (url.includes("/channels/")) return Response.json({ id: "verification-message-1" }); return Response.json({ id: "bot-1" }); };
    try { const result = await worker.fetch(request("/admin/integrations/discord/verify/start", {}, { method: "POST", cookie: await sessionCookie("admin") }), env); return { result, database, calls }; } finally { globalThis.fetch = originalFetch; }
  };
  const expectations = { application: /does not belong to this bot token/, guild: /different server/, channel: /attendance channel must be a text channel/, credential: /rejected the saved bot token/, permission: /denied command management/, rate: /rate limiting command setup/, validation: /rejected the managed command configuration/, partial: /did not confirm the managed commands/, message: /missing a required permission/ } as const;
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
  const reportMeetings = [
    ["complete", "Complete attendance", "2026-09-07", 2, 1], ["no-scan", "No scan", "2026-09-06", 3, 1],
    ["corrected-present", "Corrected present", "2026-09-05", 1, 1], ["excused", "Excused meeting", "2026-09-04", 1, 1],
    ["optional", "Optional meetup", "2026-09-03", 1, 0], ["corrected-absent", "Corrected absent", "2026-09-02", 1, 1],
    ["partial", "Partial scan", "2026-09-01", 1, 1],
  ] as const;
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-08-15" }], meetings: reportMeetings.map(([id, title, day, attendanceWeight, required]) => ({ id, title, startsAt: `${day}T20:00:00Z`, endsAt: `${day}T21:00:00Z`, required, attendanceWeight, audienceMode: "all", isTest: 0 })), events: [{ meetingId: "complete", memberId: "member-1", action: "check_in", occurredAt: "2026-09-07T20:01:00Z" }, { meetingId: "complete", memberId: "member-1", action: "check_out", occurredAt: "2026-09-07T20:59:00Z" }, { meetingId: "partial", memberId: "member-1", action: "check_in", occurredAt: "2026-09-01T20:01:00Z" }], corrections: [{ meetingId: "corrected-present", memberId: "member-1", disposition: "present", reason: "Verified" }, { meetingId: "excused", memberId: "member-1", disposition: "excused", reason: "School" }, { meetingId: "corrected-absent", memberId: "member-1", disposition: "absent", reason: "Reviewed" }], baseline: "2026-09-01" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(signedDiscordInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: "323456789012345678" } } }, privateKey), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { type: number; data: { content: string; flags: number; allowed_mentions: { parse: string[] } } };
  assert.equal(body.type, 4); assert.equal(body.data.flags, 64); assert.deepEqual(body.data.allowed_mentions, { parse: [] });
  assert.match(body.data.content, /Regular attendance: 33% from 2026-08-15 to \d{4}-\d{2}-\d{2}\. No assigned attendance policy\./);
  for (const expected of ["No scan", "Corrected absent", "Partial scan"]) assert.match(body.data.content, new RegExp(expected));
  assert.doesNotMatch(body.data.content, /Optional meetup|Complete attendance|Corrected present|Excused meeting/);
  assert.ok(database.calls.some((call) => call.sql.includes("FROM attendance_events e JOIN meetings mt")));
});

test("Discord attendance reports handle empty and provider-bounded histories", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  const run = async (rows: unknown[]) => {
    const database = new FakeDatabase(); database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-09-04T00:01:00Z", enabled: 1 }); database.lists.set("discord_user_id = ?", [{ id: "member-1", active: 1, rosterAddedAt: "2026-01-01T00:00:00Z" }]); database.rows.set("late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on", { lateScanMinutes: 30 }); database.lists.set("SELECT mt.title", rows);
    seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: rows.map((row, index) => { const item = row as { title: string; startsAt: string }; return { id: `meeting-${index}`, title: item.title, startsAt: item.startsAt, endsAt: new Date(Date.parse(item.startsAt) + 3_600_000).toISOString(), required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }; }) });
    const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
    const result = await worker.fetch(signedDiscordInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: "323456789012345678" } } }, privateKey), env);
    return (await result.json() as { data: { content: string } }).data.content;
  };
  const empty = await run([]); assert.match(empty, /Regular attendance: N\/A from 2026-01-01 to \d{4}-\d{2}-\d{2}\. No assigned attendance policy\./); assert.match(empty, /No missed required meetings/);
  const long = await run(Array.from({ length: 80 }, (_, index) => ({ title: `Very long required or optional meeting ${index + 1} ${"x".repeat(90)}`, startsAt: `2026-08-${String(index % 28 + 1).padStart(2, "0")}T20:00:00Z`, endsAt: "2020-01-01T21:00:00Z" })));
  assert.ok(long.length <= 2_000); assert.match(long, /More meetings omitted to fit Discord/); assert.ok((long.match(/^• /gm) ?? []).length < 80);
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

test("Core Discord pairing remains available while disabled Attendance commands fail closed", async () => {
  const database = new FakeDatabase(); const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, enabled: 1, verifiedAt: "2026-09-04T00:01:00Z" });
  database.rows.set("SELECT m.generation FROM platform_modules m", () => undefined);
  database.rows.set("external_id = ?", { id: "member-1", active: 1, discordUserId: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const unavailable = await worker.fetch(signedDiscordInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "attendance-report" }, member: { user: { id: "323456789012345678" } } }, privateKey), env);
  assert.match(JSON.stringify(await unavailable.json()), /Attendance is disabled/);
  assert.equal(database.calls.some((call) => call.sql.includes("attendance_events")), false);
  const paired = await worker.fetch(signedDiscordInteraction({ type: 2, guild_id: "123456789012345678", data: { name: "pair", options: [{ name: "member-id", value: "A-101" }] }, member: { user: { id: "323456789012345678" } } }, privateKey), env);
  assert.match(JSON.stringify(await paired.json()), /now paired/);
  assert.ok(database.batches.some((batch) => batch.some((call) => call.sql.includes("UPDATE members SET discord_user_id"))));
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
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "<Avery>", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio & Safety", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
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

test("Attendance email rechecks module authority immediately before provider delivery", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ apiKey: "resend-secret", fromEmail: "attendance@example.test" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "resend-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM members", { id: "member-1", firstName: "Avery", lastName: "Stone", email: "avery@example.test" });
  database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z" });
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  database.denyProviderPreflight = true;
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = async () => { outbound += 1; return Response.json({ id: "must-not-send" }); };
  try {
    const result = await worker.fetch(request("/communications/email", { kind: "missed-meeting", memberId: "member-1", meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 403);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord rechecks module authority immediately before provider delivery", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM integration_state", { externalId: "managed-status", contentHash: createHash("sha256").update("No kiosk is paired.").digest("base64url") });
  database.denyProviderPreflight = true;
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = async () => { outbound += 1; return Response.json({ id: "must-not-send" }); };
  try {
    const result = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 403);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("Google Calendar rechecks module authority before token and provider delivery", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "calendar-refresh", calendarId: "calendar@example.test" }, sessionSecret);
  database.rows.set("google_calendar_enabled AS enabled", { ...encrypted, enabled: 1, authorizedAt: "2026-09-05", verifiedAt: "2026-09-05" });
  database.lists.set("FROM google_calendar_operations o", [{ meetingId: "meeting-1", eventId: "ll1234", action: "upsert", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", status: "pending", attempts: 0, generation: 1 }]);
  database.denyProviderPreflight = true;
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = async () => { outbound += 1; return Response.json({ access_token: "must-not-use" }); };
  try {
    const result = await worker.fetch(request("/admin/integrations/google-calendar/retry", {}, { cookie: await sessionCookie("admin") }), env);
    assert.equal(result.status, 200);
    assert.equal(outbound, 0);
    assert.equal((await result.json() as { failed: number }).failed, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord missing-member workflow mentions only linked absent members and records recipients", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio" });
  database.lists.set("FROM members m WHERE", [{ id: "member-1", discordUserId: "323456789012345678" }]);
  database.lists.set("SELECT id, discord_user_id AS discordUserId FROM members", [{ id: "member-1", discordUserId: "323456789012345678" }]);
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const outbound: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => { outbound.push({ url: String(input), init }); return new Response(JSON.stringify({ id: "message-1" }), { headers: { "content-type": "application/json" } }); };
  try {
    const result = await worker.fetch(request("/discord/missing", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 202);
    const payload = JSON.parse(String(outbound.find((call) => call.url.endsWith("/messages"))?.init?.body));
    assert.match(payload.content, /<@323456789012345678>/);
    assert.deepEqual(payload.allowed_mentions, { parse: [], users: ["323456789012345678"] });
    assert.equal(payload.components[0].components[0].custom_id, "lancerlogin-attendance:meeting-1");
    assert.match(payload.content, /Ask general questions in the thread/);
    const thread = outbound.find((call) => call.url.endsWith("/messages/message-1/threads"));
    assert.equal(thread?.init?.method, "POST");
    assert.match(JSON.parse(String(thread?.init?.body)).name, /Attendance questions - Studio/);
    assert.ok(database.calls.some((call) => call.sql.includes("SET thread_created_at = ?")));
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("discord_attendance_recipients")));
  assert.equal(database.batches.at(-1)?.some((call) => call.sql.includes("DELETE FROM discord_attendance_recipients")), false);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("INSERT OR IGNORE INTO discord_attendance_recipients")));
    assert.equal(database.batches.at(-1)?.some((call) => call.sql.includes("discord_attendance_contests")), false);
    assert.equal(JSON.stringify(await result.json()).includes("discord-secret"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord absence notices split large recipient lists within provider limits", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio" });
  const members = Array.from({ length: 90 }, (_, index) => ({ id: `member-${index + 1}`, memberId: `A-${index + 1}`, firstName: "Member", lastName: String(index + 1), active: 1, attendanceRequiredFrom: "2026-01-01", discordUserId: String(323456789012345000n + BigInt(index)) }));
  database.lists.set("SELECT id, discord_user_id AS discordUserId FROM members", members.map(({ id, discordUserId }) => ({ id, discordUserId })));
  seedPolicy(database, { members, meetings: [{ id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const payloads: Array<{ content: string; allowed_mentions: { users: string[] } }> = []; let messages = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/channels/223456789012345678/messages")) {
      payloads.push(JSON.parse(String(init.body))); messages += 1;
      return new Response(JSON.stringify({ id: `message-${messages}` }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "thread-1" }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await worker.fetch(request("/discord/missing", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 202);
    assert.equal(payloads.length, 2);
    assert.ok(payloads.every((payload) => payload.content.length <= 2_000));
    assert.ok(payloads.every((payload) => payload.allowed_mentions.users.length <= 100));
    assert.deepEqual(payloads.flatMap((payload) => payload.allowed_mentions.users).sort(), members.map((member) => member.discordUserId).sort());
    const recipientBatches = database.batches.filter((batch) => batch.some((call) => call.sql.includes("INSERT OR IGNORE INTO discord_attendance_recipients")));
    assert.equal(recipientBatches.length, 2);
    assert.equal(recipientBatches.flatMap((batch) => batch.filter((call) => call.sql.includes("INSERT OR IGNORE INTO discord_attendance_recipients"))).length, 90);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord absence notice retries resume after the last successful chunk", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z" });
  database.rows.set("FROM meetings", { id: "meeting-1", title: "Studio" });
  let notification: { status: string; messageId?: string; attempts: number; deliveryId?: string } | undefined;
  database.rows.set("SELECT status, message_id AS messageId", () => notification);
  const members = Array.from({ length: 90 }, (_, index) => ({ id: `member-${index + 1}`, memberId: `A-${index + 1}`, firstName: "Member", lastName: String(index + 1), active: 1, attendanceRequiredFrom: "2026-01-01", discordUserId: String(423456789012345000n + BigInt(index)) }));
  database.lists.set("SELECT id, discord_user_id AS discordUserId FROM members", members.map(({ id, discordUserId }) => ({ id, discordUserId })));
  seedPolicy(database, { members, meetings: [{ id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const payloads: Array<{ users: string[]; accepted: boolean }> = []; let posts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/channels/223456789012345678/messages")) {
      posts += 1; const payload = JSON.parse(String(init.body)) as { allowed_mentions: { users: string[] } };
      const accepted = posts !== 2; payloads.push({ users: payload.allowed_mentions.users, accepted });
      if (!accepted) return new Response(JSON.stringify({ code: 50_035, message: "Invalid Form Body" }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: `message-${posts}` }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "thread-1" }), { headers: { "content-type": "application/json" } });
  };
  try {
    const first = await worker.fetch(request("/discord/missing", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(first.status, 502);
    const initial = database.calls.find((call) => call.sql.startsWith("INSERT INTO discord_attendance_notifications"));
    const deliveryId = String(initial?.values[3]);
    const successfulRecipients = database.batches[0].filter((call) => call.sql.includes("INSERT OR IGNORE INTO discord_attendance_recipients")).map((call) => ({ memberId: String(call.values[1]), messageId: "message-1" }));
    assert.ok(successfulRecipients.length > 0 && successfulRecipients.length < members.length);
    notification = { status: "failed", messageId: "message-1", attempts: 1, deliveryId };
    database.lists.set("SELECT member_id AS memberId, message_id AS messageId", successfulRecipients);

    const retry = await worker.fetch(request("/discord/missing", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(retry.status, 202);
    assert.equal(payloads.length, 3);
    assert.deepEqual(payloads[2].users, payloads[1].users);
    assert.equal(payloads[2].users.some((id) => payloads[0].users.includes(id)), false);
    assert.equal(new Set([...payloads[0].users, ...payloads[2].users]).size, members.length);
    assert.ok(database.calls.some((call) => call.sql.includes("status = 'delivered'") && call.values.includes(deliveryId)));
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
  assert.deepEqual(await read.json(), { enabled: true, contestWindowHours: 36, blockRecontestsAfterRejection: false });
  const saved = await worker.fetch(request("/admin/integrations/discord/channel-manager", { enabled: false, contestWindowHours: 48 }, { method: "PATCH", cookie: adminCookie }), env);
  assert.deepEqual(await saved.json(), { enabled: false, contestWindowHours: 48 });
  assert.ok(database.calls.some((call) => call.sql.includes("SET discord_channel_manager_enabled = ?") && call.values[0] === 0 && call.values[1] === 48));
  assert.ok(database.calls.some((call) => call.values.includes("discord.channel_manager_updated")));
  const blocked = await worker.fetch(request("/admin/integrations/discord/channel-manager", { enabled: true, contestWindowHours: 48, blockRecontestsAfterRejection: true }, { method: "PATCH", cookie: adminCookie }), env);
  assert.equal(blocked.status, 200); assert.equal((await blocked.json() as { blockRecontestsAfterRejection: boolean }).blockRecontestsAfterRejection, true);
  assert.ok(database.calls.some(call => call.sql.includes("SET discord_channel_manager_enabled") && call.values[2] === 1));
  assert.equal((await worker.fetch(request("/admin/integrations/discord/channel-manager", { enabled: true, contestWindowHours: 48, blockRecontestsAfterRejection: "yes" }, { method: "PATCH", cookie: adminCookie }), env)).status, 400);
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

test("meeting creation sends dashboard titles and notes to Google Calendar", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "calendar-refresh", calendarId: "calendar@example.test", calendarLabel: "Operations" }, sessionSecret);
  database.rows.set("google_calendar_enabled AS enabled", { ...encrypted, enabled: 1, authorizedAt: "2026-09-05T00:00:00.000Z", verifiedAt: "2026-09-05T00:00:00.000Z" });
  database.rows.set("SELECT id, starts_at AS startsAt", (_sql, values) => ({ id: String(values[0]), startsAt: "2026-09-10T20:00:00.000Z", endsAt: "2026-09-10T22:00:00.000Z" }));
  database.rows.set("SELECT title, notes, required, attendance_weight AS attendanceWeight FROM meetings", { title: "Build planning", notes: "Bring supplies", required: 1, attendanceWeight: 1 });
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
    const result = await worker.fetch(request("/meetings", { title: "Build planning", notes: "Bring supplies", startsAt: "2026-09-10T20:00:00.000Z", endsAt: "2026-09-10T22:00:00.000Z", required: true }, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 201);
    assert.deepEqual((await result.json() as { calendarSync: unknown }).calendarSync, { synced: 1, queued: 0, failed: 0 });
    const calendarCall = providerCalls.find((call) => call.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/"));
    assert.ok(calendarCall);
    assert.deepEqual(Object.keys(calendarCall.body ?? {}).sort(), ["description", "end", "id", "start", "summary"]);
    assert.equal(calendarCall.body?.summary, "Build planning");
    assert.equal(calendarCall.body?.description, "Audience: All\nAttendance: Required (weight 1)\n\nBring supplies");
    assert.match(String(calendarCall.body?.id), /^ll[0-9a-f]{48}$/);

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
  const kioskContent = "**Kiosk status** · 1 of 1 online\n• **Front desk** · online · reader online · release 0.19.0";
  const guidance = "**LancerLogin attendance help**\nUse `/pair` with your LancerLogin member ID to link your Discord account. Use **View my attendance report** below or `/attendance-report` to receive your private report. Ask general questions in the thread under each absence notice. Only a mentioned linked member can use **Contest absence** during the configured contest window. A contest requests private review; it does not change attendance until an Operator or Admin approves it.";
  const reportComponents = [{ type: 1, components: [{ type: 2, style: 1, label: "View my attendance report", custom_id: "lancerlogin-attendance-report" }] }];
  const verified = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  verified.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  verified.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  verified.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 1 });
  verified.lists.set("FROM kiosks", [{ id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.19.0" }]);
  verified.rows.set("FROM integration_state", (_sql: string, values: unknown[]) => values[0] === "kiosk-status" ? { externalId: "status-1", contentHash: createHash("sha256").update(kioskContent).digest("base64url") } : { externalId: "howto-1", contentHash: createHash("sha256").update(JSON.stringify({ content: guidance, components: reportComponents })).digest("base64url") });
  verified.lists.set("FROM meetings m LEFT JOIN", []); verified.lists.set("FROM discord_attendance_notifications WHERE", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: verified } as unknown as Env;
  const originalFetch = globalThis.fetch; const methods: string[] = [];
  globalThis.fetch = async (_input, init) => { methods.push(String(init?.method)); return new Response(JSON.stringify({ id: "existing" }), { headers: { "content-type": "application/json" } }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(methods.filter((method) => method === "POST" || method === "PATCH" || method === "DELETE").length, 0);
    assert.deepEqual(methods, ["GET", "GET", "PUT", "GET"]);
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
  const kioskContent = "**Kiosk status** · 1 of 1 online\n• **Front desk** · online · reader online · release 0.19.0";
  let guideHash = createHash("sha256").update("legacy attendance guide without controls").digest("base64url");
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 1 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24, channelManagerEnabled: 1 });
  database.lists.set("FROM kiosks", [{ id: "kiosk-1", name: "Front desk", lastSeenAt: new Date().toISOString(), readerOnline: 1, releaseVersion: "0.19.0" }]);
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
    database.lists.set("SELECT id, discord_user_id AS discordUserId FROM members", [{ id: "member-1", discordUserId: "323456789012345678" }]);
    seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio", startsAt: new Date(Date.parse(endsAt) - 3_600_000).toISOString(), endsAt, required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
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
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24 });
  database.lists.set("FROM meetings m LEFT JOIN", []);
  database.lists.set("FROM discord_attendance_notifications WHERE", [{ meetingId: "meeting-1", messageId: "absence-1", channelId: "223456789012345678", processedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), expiresAt: new Date(Date.now() - 3_600_000).toISOString(), deliveryId: "delivery-1" }]);
  database.lists.set("SELECT DISTINCT message_id AS messageId FROM discord_attendance_recipients", [{ messageId: "absence-1" }, { messageId: "absence-2" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const deletes: string[] = []; let created = 0;
  globalThis.fetch = async (input, init) => { if (init?.method === "DELETE") deletes.push(String(input)); if (init?.method === "POST") created += 1; return new Response(init?.method === "DELETE" ? null : JSON.stringify({ id: `managed-${created}` }), { status: init?.method === "DELETE" ? 204 : 200, headers: init?.method === "DELETE" ? undefined : { "content-type": "application/json" } }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.deepEqual(deletes, ["https://discord.com/api/v10/channels/223456789012345678/messages/absence-1", "https://discord.com/api/v10/channels/223456789012345678/messages/absence-2"]);
    assert.ok(database.calls.some((call) => call.sql.includes("SET deleted_at = ?") && call.values.includes("meeting-1") && call.values.includes("absence-1")));
    assert.equal(deletes.some((url) => url.includes("unrelated")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("expired tracked notices are removed without the optional channel manager", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 0 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24 });
  database.lists.set("FROM meetings m LEFT JOIN", []);
  database.lists.set("FROM discord_attendance_notifications WHERE", [{ meetingId: "meeting-1", messageId: "absence-1", channelId: "223456789012345678", expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const deletes: string[] = [];
  globalThis.fetch = async (input, init) => { if (init?.method === "DELETE") deletes.push(String(input)); return new Response(init?.method === "DELETE" ? null : JSON.stringify({ id: "managed-1" }), { status: init?.method === "DELETE" ? 204 : 200, headers: init?.method === "DELETE" ? undefined : { "content-type": "application/json" } }); };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.deepEqual(deletes, ["https://discord.com/api/v10/channels/223456789012345678/messages/absence-1"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("scheduled attendance thread retry recovers an already created thread", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 0 });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24 });
  database.lists.set("FROM meetings m LEFT JOIN", []);
  database.lists.set("FROM discord_attendance_notifications n JOIN", [{ meetingId: "meeting-1", messageId: "absence-1", channelId: "223456789012345678", title: "Studio" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method} ${String(input)}`);
    return new Response(JSON.stringify(init?.method === "POST" && String(input).endsWith("/threads") ? { code: 160004, message: "A thread has already been created" } : { id: "absence-1", parent_id: "223456789012345678" }), { status: init?.method === "POST" && String(input).endsWith("/threads") ? 400 : 200, headers: { "content-type": "application/json" } });
  };
  try {
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.ok(calls.some((call) => call.includes("POST https://discord.com/api/v10/channels/223456789012345678/messages/absence-1/threads")));
    assert.ok(calls.some((call) => call.includes("GET https://discord.com/api/v10/channels/absence-1")));
    assert.ok(database.calls.some((call) => call.sql.includes("SET thread_created_at = ?")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord calendar sync explains missing scheduled-event permission without exposing credentials", async (context) => {
  calendarClock(context);
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

test("bulk Discord calendar sync stops after a permission failure instead of repeating denied requests", async (context) => {
  calendarClock(context);
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

test("Discord calendar sync retries a rate limit only after Discord's retry delay", async (context) => {
  calendarClock(context);
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

test("Discord calendar recovery reconciles an ambiguously created event without another POST", async (context) => {
  calendarClock(context);
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

test("concurrent Discord calendar processors claim one create operation", async (context) => {
  calendarClock(context);
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
  const restoration = await worker.fetch(request("/meetings/meeting-1/restore", { scope: "occurrence", deletion: { meetingIds: ["meeting-1"], deletedAt: "2026-10-01T12:00:00.000Z" } }, { method: "POST", cookie: await sessionCookie("operator") }), { ...env, DB: restored } as unknown as Env);
  assert.equal(restoration.status, 200);
  assert.ok(restored.batches.some((batch) => batch.some((call) => call.sql.includes("generation = ?") && call.values[0] === 2)));
  assert.ok(restored.batches.some((batch) => batch.some((call) => call.sql.includes("discord_calendar_operations") && call.sql.includes("'upsert'") && call.values.includes(2))));
  assert.ok(restored.calls.some((call) => call.sql.includes("discord_calendar_operations") && call.sql.includes("'delete'") && call.values.includes("tracked-event-1")));
});

test("one meeting calendar action reports configured providers separately and preserves Discord fields", async (context) => {
  calendarClock(context);
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
    assert.deepEqual(providerBodies[0], { name: "Studio night", description: "Audience: All\nAttendance: Optional\n\nBring tools", privacy_level: 2, entity_type: 3, scheduled_start_time: "2026-10-01T20:00:00Z", scheduled_end_time: "2026-10-01T21:00:00Z", entity_metadata: { location } });
  } finally { globalThis.fetch = originalFetch; }
});

test("provider sync-all controls are Admin-only and unverified calendars cannot be manually backfilled", async () => {
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/admin/integrations/discord/calendar/sync-all", {}, { cookie: await sessionCookie("operator") }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/integrations/google-calendar/sync-all", {}, { cookie: await sessionCookie("operator") }), env)).status, 403);
  database.rows.set("SELECT id FROM meetings", { id: "meeting-1" });
  assert.equal((await worker.fetch(request("/calendars/sync", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env)).status, 409);
});

test("Discord sync-all pages a large meeting set across bounded provider batches", async (context) => {
  calendarClock(context);
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("SELECT generation, active FROM discord_calendar_event_mappings", { generation: 1, active: 1 });
  database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", (_sql: string, values: unknown[]) => ({ eventId: `event-${values[0]}`, active: 1 }));
  database.rows.set("FROM meetings WHERE", (_sql: string, values: unknown[]) => ({ id: String(values[0]), title: `Meeting ${values[0]}`, startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", notes: null }));
  const meetings = Array.from({ length: 23 }, (_, index) => ({ id: `meeting-${String(index + 1).padStart(2, "0")}`, startsAt: `2026-10-${String(index + 1).padStart(2, "0")}T20:00:00Z` }));
  database.lists.set("SELECT id, starts_at AS startsAt FROM meetings", (_sql: string, values: unknown[]) => {
    const afterId = typeof values[3] === "string" ? values[3] : undefined;
    const start = afterId ? meetings.findIndex((meeting) => meeting.id === afterId) + 1 : 0;
    return meetings.slice(start, start + Number(values[4]));
  });
  database.lists.set("FROM discord_calendar_operations o", (_sql: string, values: unknown[]) => values.slice(0, -1).map((meetingId) => ({ meetingId, generation: 1, action: "upsert", eventId: `event-${meetingId}`, status: "pending", attempts: 0, revision: 1, actorUserId: "admin-1" })));
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; return new Response(JSON.stringify({ id: "event" }), { headers: { "content-type": "application/json" } }); };
  try {
    const pageSizes: number[] = []; const providerBatchSizes: number[] = []; const seen = new Set<string>(); let cursor: string | null | undefined; let selected = 0; let synced = 0;
    do {
      const before = providerCalls;
      const result = await worker.fetch(request(`/admin/integrations/discord/calendar/sync-all${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, {}, { cookie: await sessionCookie("admin") }), env);
      assert.equal(result.status, 200);
      const body = await result.json() as { selected: number; synced: number; nextCursor?: string | null; batchLimit: number; limit: number };
      assert.equal(body.batchLimit, 10);
      assert.equal(body.limit, 100);
      pageSizes.push(body.selected); providerBatchSizes.push(providerCalls - before); selected += body.selected; synced += body.synced;
      if (body.nextCursor) assert.equal(seen.has(body.nextCursor), false);
      if (body.nextCursor) seen.add(body.nextCursor);
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(pageSizes, [10, 10, 3]);
    assert.deepEqual(providerBatchSizes, [10, 10, 3]);
    assert.equal(selected, 23);
    assert.equal(synced, 23);
    assert.ok(database.calls.filter((call) => call.sql.includes("FROM discord_calendar_operations o")).every((call) => call.sql.includes("LIMIT 10")));
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord sync-all rejects a malformed continuation cursor before provider work", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/admin/integrations/discord/calendar/sync-all?after=not-a-cursor", {}, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { error: "Discord calendar sync cursor is invalid" });
  assert.equal(database.calls.some((call) => call.sql.includes("FROM discord_calendar_operations o")), false);
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
  assert.match(listQuery?.sql ?? "", /SELECT SUM\(1 \+ json_array_length\(history\.prior_reviews_json\)\) FROM discord_attendance_contests history WHERE history\.installation_id = c\.installation_id AND history\.member_id = c\.member_id/);
  assert.doesNotMatch(listQuery?.sql ?? "", /history\.status/);
  assert.match(listQuery?.sql ?? "", /FROM attendance_events check_in/);
  assert.match(listQuery?.sql ?? "", /FROM attendance_events check_out/);
  assert.doesNotMatch(listQuery?.sql ?? "", /attendance_corrections/);
  assert.equal((await worker.fetch(request("/discord/contests", undefined, { cookie: await sessionCookie("admin") }), env)).status, 200);
  const missingReason = await worker.fetch(request("/discord/contests/resolve", { meetingId: "meeting-1", memberId: "member-1", createdAt: "2026-10-15T10:00:00Z", resolution: "approved", reviewNote: "   " }, { cookie }), env);
  assert.equal(missingReason.status, 400);
  assert.deepEqual(await missingReason.json(), { error: "A review reason is required before resolving this contest" });
  assert.equal(database.batches.length, 0);
  database.lists.set("AS resolved FROM json_each", [{ meetingId: "meeting-1", memberId: "member-1", resolved: 1 }]);
  const resolved = await worker.fetch(request("/discord/contests/resolve", { meetingId: "meeting-1", memberId: "member-1", createdAt: "2026-10-15T10:00:00Z", resolution: "approved", reviewNote: "Member showed the Operator a kiosk error." }, { cookie }), env);
  assert.equal(resolved.status, 200);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("UPDATE discord_attendance_contests")));
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("INSERT INTO attendance_corrections")));
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("discord.contest_resolved")));
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
  const resolved = await worker.fetch(request("/discord/contests/resolve", { meetingId: "meeting-1", memberId: "member-1", createdAt: "2026-10-15T10:00:00Z", resolution: "approved", reviewNote: "Verified in person." }, { cookie }), env);
  assert.equal(resolved.status, 409);
  assert.equal(database.batches.length, 0);
});

for (const action of ["accept", "reject"]) test(`bulk contest ${action} retains authenticated staff, origin and verified Discord boundaries`, async () => {
  const database = new FakeDatabase();
  database.rows.set("google_enabled AS googleEnabled", { googleEnabled: 0, resendEnabled: 0, discordEnabled: 1 });
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ciphertext: "unused", iv: "unused", updatedAt: "2026-08-30T00:00:00Z", verifiedAt: null, enabled: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const input = { contests: [{ meetingId: "meeting-1", memberId: "member-1", createdAt: "2026-10-15T10:00:00Z" }], reviewNote: "Verified synthetic attendance" };
  assert.equal((await worker.fetch(request(`/discord/contests/${action}`, input), env)).status, 401);
  const cookie = await sessionCookie("operator");
  assert.equal((await worker.fetch(request(`/discord/contests/${action}`, input, { cookie }), env)).status, 409);
  assert.equal(database.batches.length, 0);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ciphertext: "unused", iv: "unused", updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  assert.equal((await worker.fetch(new Request(`https://worker.example.test/discord/contests/${action}`, { method: "POST", headers: { cookie, origin: "https://untrusted.example.test", "content-type": "application/json" }, body: JSON.stringify(input) }), env)).status, 403);
  assert.equal(database.batches.length, 0);
  const accepted = await worker.fetch(request(`/discord/contests/${action}`, input, { cookie }), env);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(database.batches.some(batch => batch.some(statement => statement.sql.includes("INSERT INTO attendance_corrections"))), action === "accept");
  assert.ok(database.batches.some(batch => batch.some(statement => statement.sql.includes("discord.contest_resolved") && statement.values.includes(action === "accept" ? "approved" : "rejected"))));
});

test("a signed Discord button creates a contest only for the delivered linked member", async () => {
  const database = new FakeDatabase();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: publicKeyHex }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM discord_attendance_recipients", { memberId: "member-1", deliveredAt: new Date().toISOString() });
  database.rows.set("FROM discord_attendance_contests WHERE", { status: "open" });
  database.lists.set("FROM members m WHERE", [{ id: "member-1", discordUserId: "323456789012345678" }]);
  database.lists.set("SELECT id, discord_user_id AS discordUserId FROM members", [{ id: "member-1", discordUserId: "323456789012345678" }]);
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  const body = JSON.stringify({ type: 3, data: { custom_id: "lancerlogin-attendance:meeting-1" }, member: { user: { id: "323456789012345678" } }, message: { id: "message-1" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const interaction = new Request("https://api.example.test/discord/interactions", { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(interaction, env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { type: 4, data: { content: "Your attendance contest was recorded for review. Your attendance has not been changed.", flags: 64, allowed_mentions: { parse: [] } } });
  assert.ok(database.calls.some((call) => call.sql.includes("INSERT INTO discord_attendance_contests") && call.values.includes("323456789012345678")));
});

test("retired privacy compatibility stays disabled with historical consent and never writes or transmits", async () => {
  const database = new FakeDatabase();
  database.rows.set("telemetry_accepted_at AS acceptedAt", { acceptedAt: "2026-08-30T00:00:00Z", installId: "legacy-reference" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, TELEMETRY_ENDPOINT: "https://telemetry.example.test/v1", DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; let reports = 0;
  globalThis.fetch = async () => { reports += 1; throw new Error("Reporting must never run"); };
  try {
    for (const method of ["GET", "PATCH"]) {
      const result = await worker.fetch(request("/admin/privacy", method === "PATCH" ? { telemetryAccepted: true } : undefined, { method, cookie: await sessionCookie("admin") }), env);
      assert.equal(result.status, 200);
      const body = await result.json() as { telemetryAccepted: boolean; acceptedAt: unknown; installationReference?: string };
      assert.equal(body.telemetryAccepted, false);
      assert.equal(body.acceptedAt, null);
      assert.equal("installationReference" in body, false);
    }
    assert.equal((await worker.fetch(request("/admin/privacy"), env)).status, 401);
    assert.equal((await worker.fetch(request("/admin/privacy", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
    await worker.scheduled({ cron: "0 3 * * *" }, env);
    await worker.scheduled({ cron: "*/5 * * * *" }, env);
    assert.equal(reports, 0);
    assert.equal(database.calls.some((call) => /telemetry|audit_log/.test(call.sql)), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("error paths never record retired telemetry diagnostics", async () => {
  const encrypted = await encryptIntegration({ clientId: "client-id", clientSecret: "client-secret" }, sessionSecret);
  const accepted = new FakeDatabase();
  accepted.rows.set("auth_mode AS authMode", { authMode: "google" });
  accepted.rows.set("FROM encrypted_integrations", { id: "google-1", ...encrypted, updatedAt: "2026-08-30T00:00:00Z" });
  accepted.rows.set("telemetry_accepted_at AS acceptedAt", { acceptedAt: "2026-08-30T00:00:00Z" });
  const acceptedEnv = { APP_MODE: "configured", ALLOWED_ORIGIN: "not-a-valid-origin", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: accepted } as unknown as Env;
  assert.equal((await worker.fetch(request("/auth/google/start"), acceptedEnv)).status, 500);
  assert.equal(accepted.calls.some((call) => call.sql.includes("INSERT INTO telemetry_diagnostics")), false);

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
  const result = await worker.fetch(request("/admin/data/backup?scope=meetings", undefined, { cookie: await sessionCookie("admin") }), env); assert.equal(result.status, 200); const backup = await result.json() as { scope: string; tables: Record<string, unknown> }; assert.equal(backup.scope, "meetings"); assert.deepEqual(Object.keys(backup.tables).sort(), ["attendance_corrections", "attendance_events", "discord_anomaly_reports", "discord_attendance_contests", "discord_attendance_notifications", "discord_attendance_recipients", "meeting_audience_labels", "meeting_templates", "meeting_weight_categories", "meetings"]); assert.equal("members" in backup.tables, false); assert.match(result.headers.get("content-disposition") ?? "", /meetings-backup/);
});

test("dated label changes require Admin preview and are applied with an audited impact", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], labels: [{ id: "drive", name: "Drive Team", active: 1, formulaEnabled: 0 }], meetings: [{ id: "meeting-1", title: "Drive meeting", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "labels", isTest: 0 }], audience: [{ meetingId: "meeting-1", labelId: "drive" }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const changes = [{ memberId: "A-101", label: "Drive Team", action: "add", effectiveDate: "2026-08-01" }];
  assert.equal((await worker.fetch(request("/labels/membership/preview", { changes }, { cookie: await sessionCookie("operator") }), env)).status, 403);
  const preview = await worker.fetch(request("/labels/membership/preview", { changes }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(preview.status, 200); const body = await preview.json() as { previewToken: string; impact: Array<{ memberId: string; beforeRate: number | null; afterRate: number | null; affectedCompletedMeetings: number }> };
  assert.deepEqual(body.impact, [{ memberId: "A-101", beforeRate: null, afterRate: 0, beforePolicy: "standard", afterPolicy: "standard", beforePolicies: [], afterPolicies: [], affectedCompletedMeetings: 1 }]);
  assert.equal(database.batches.length, 0);
  assert.equal((await worker.fetch(request("/labels/membership/apply", { changes, previewToken: "wrong" }, { cookie: await sessionCookie("admin") }), env)).status, 409);
  const applied = await worker.fetch(request("/labels/membership/apply", { changes, previewToken: body.previewToken }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(applied.status, 200);
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO member_label_changes") && item.values.includes("2026-08-01")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("'label.membership_changed'")));
});

test("label changes default blank action and date in the organization time zone", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], labels: [{ id: "drive", name: "Drive Team", active: 1, formulaEnabled: 0 }] });
  database.rows.set("SELECT time_zone AS timeZone, late_scan_minutes AS lateScanMinutes, attendance_reporting_starts_on AS baseline", { timeZone: "Pacific/Honolulu", lateScanMinutes: 30, baseline: null });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const changes = [{ memberId: "A-101", label: "Drive Team", action: "", effectiveDate: "" }];
  const preview = await worker.fetch(request("/labels/membership/preview", { changes }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(preview.status, 200);
  const body = await preview.json() as { changes: { action: string; effectiveDate: string }[]; previewToken: string };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Honolulu", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  assert.equal(body.changes[0].action, "add"); assert.equal(body.changes[0].effectiveDate, today);
  const applied = await worker.fetch(request("/labels/membership/apply", { changes: body.changes, previewToken: body.previewToken }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(applied.status, 200); assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO member_label_changes") && item.values.includes(today)));
});

test("bulk roster status requires Admin preview and rejects a changed roster", async () => {
  const database = new FakeDatabase(); const people = [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1 }, { id: "member-2", memberId: "A-102", firstName: "Jordan", lastName: "Lee", active: 0 }];
  database.lists.set("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, active FROM members", people);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const input = { memberIds: ["member-1", "member-2"], active: false };
  assert.equal((await worker.fetch(request("/admin/members/bulk/preview", input, { cookie: await sessionCookie("operator") }), env)).status, 403);
  assert.equal((await worker.fetch(request("/admin/members/bulk/preview", { memberIds: ["member-1", "member-1"], active: false }, { cookie: await sessionCookie("admin") }), env)).status, 400);
  const preview = await worker.fetch(request("/admin/members/bulk/preview", input, { cookie: await sessionCookie("admin") }), env);
  assert.equal(preview.status, 200); const body = await preview.json() as { changed: number; previewToken: string };
  assert.equal(body.changed, 1);
  database.lists.set("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, active FROM members", [{ ...people[0], active: 0 }, people[1]]);
  assert.equal((await worker.fetch(request("/admin/members/bulk/apply", { ...input, previewToken: body.previewToken }, { cookie: await sessionCookie("admin") }), env)).status, 409);
  database.lists.set("SELECT id, external_id AS memberId, first_name AS firstName, last_name AS lastName, active FROM members", people);
  const applied = await worker.fetch(request("/admin/members/bulk/apply", { ...input, previewToken: body.previewToken }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(applied.status, 200); assert.equal((await applied.json() as { applied: number }).applied, 1);
  assert.equal(database.batches.at(-1)?.filter((item) => item.sql.startsWith("UPDATE members SET inactive_periods_json")).length, 1);
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("roster.bulk_status_changed")));
});

test("weekly label targets require Admin and reject overlapping periods", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, { labels: [{ id: "mentor:primary", name: "Mentor", active: 1, formulaEnabled: 1 }] });
  database.rows.set("SELECT id, active, formula_enabled AS formulaEnabled FROM member_labels", { id: "mentor:primary", active: 1, formulaEnabled: 1 });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const target = { labelId: "mentor:primary", startsOn: "2026-09-01", endsOn: "2026-09-30", meetingsPerWeek: 2 };
  assert.equal((await worker.fetch(request("/labels/targets", target, { cookie: await sessionCookie("operator") }), env)).status, 403);
  assert.equal((await worker.fetch(request("/labels/targets", target, { cookie: await sessionCookie("admin") }), env)).status, 201);
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO label_weekly_targets") && item.values.includes(2)));
  database.rows.set("SELECT id FROM label_attendance_rules", { id: "existing-target" });
  assert.equal((await worker.fetch(request("/labels/targets", { ...target, startsOn: "2026-09-15", endsOn: "2026-10-15" }, { cookie: await sessionCookie("admin") }), env)).status, 409);
});

test("policy changes require Admin preview, audit the apply, and reject stale previews", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, { labels: [{ id: "student", name: "Student", active: 1, formulaEnabled: 0 }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const change = { rule: { labelId: "student", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 80, excusedHandling: "exclude" } };
  assert.equal((await worker.fetch(request("/attendance/policy/preview", change, { cookie: await sessionCookie("operator") }), env)).status, 403);
  const preview = await worker.fetch(request("/attendance/policy/preview", change, { cookie: await sessionCookie("admin") }), env);
  assert.equal(preview.status, 200, await preview.clone().text());
  const body = await preview.json() as { previewToken: string };
  assert.equal(database.batches.length, 0);
  assert.equal((await worker.fetch(request("/attendance/policy/apply", { ...change, previewToken: "wrong" }, { cookie: await sessionCookie("admin") }), env)).status, 409);
  const applied = await worker.fetch(request("/attendance/policy/apply", { ...change, previewToken: body.previewToken }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(applied.status, 200, await applied.clone().text());
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO label_attendance_rules") && item.values.includes(80)));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO label_attendance_rules") && item.values.includes("exclude")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("'attendance_policy.changed'")));
  database.lists.set("rule_type AS ruleType, threshold_percent AS thresholdPercent", [{ id: "other", labelId: "student", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 90 }]);
  assert.equal((await worker.fetch(request("/attendance/policy/apply", { ...change, previewToken: body.previewToken }, { cookie: await sessionCookie("admin") }), env)).status, 409);
});

test("policy previews include historical-only percentage changes", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, {
    members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }],
    labels: [{ id: "class", name: "Class", active: 1, formulaEnabled: 0 }],
    changes: [{ memberId: "member-1", labelId: "class", action: "add", effectiveDate: "2026-01-01", createdAt: "2026-01-01T00:00:00Z" }],
    rules: [
      { id: "class-standing", labelId: "class", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 75, meetingsPerWeek: null, excusedHandling: "exclude" },
      { id: "class-summer", labelId: "class", startsOn: "2026-07-01", endsOn: "2026-07-31", ruleType: "weighted_percentage", thresholdPercent: 75, meetingsPerWeek: null, excusedHandling: "exclude" },
    ],
    meetings: [
      { id: "summer-present", title: "Summer present", startsAt: "2026-07-10T20:00:00Z", endsAt: "2026-07-10T21:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 },
      { id: "summer-excused", title: "Summer excused", startsAt: "2026-07-11T20:00:00Z", endsAt: "2026-07-11T21:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 },
    ],
    corrections: [
      { meetingId: "summer-present", memberId: "member-1", disposition: "present", reason: "Verified" },
      { meetingId: "summer-excused", memberId: "member-1", disposition: "excused", reason: "School" },
    ],
  });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/attendance/policy/preview", { rule: { id: "class-summer", labelId: "class", startsOn: "2026-07-01", endsOn: "2026-07-31", ruleType: "weighted_percentage", thresholdPercent: 75, excusedHandling: "count_missed" } }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200, await result.clone().text());
  const body = await result.json() as { impact: Array<{ before: { status: string; rate: number | null }; after: { status: string; rate: number | null }; beforeHistory: Array<{ ruleId: string; rate: number | null }>; afterHistory: Array<{ ruleId: string; rate: number | null }> }> };
  assert.equal(body.impact.length, 1);
  assert.deepEqual(body.impact[0].before, body.impact[0].after);
  assert.equal(body.impact[0].beforeHistory.find((item) => item.ruleId === "class-summer")?.rate, 100);
  assert.equal(body.impact[0].afterHistory.find((item) => item.ruleId === "class-summer")?.rate, 50);
});

test("new policy supports members already holding another policy label", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, {
    members: [{ id: "m", memberId: "A-101", firstName: "A", lastName: "B", active: 1, attendanceRequiredFrom: "2026-09-01" }],
    labels: [{ id: "student", name: "Student", active: 1, formulaEnabled: 0 }, { id: "mentor", name: "Mentor", active: 1, formulaEnabled: 0 }],
    changes: [{ memberId: "m", labelId: "student", action: "add", effectiveDate: "2026-09-01" }, { memberId: "m", labelId: "mentor", action: "add", effectiveDate: "2026-09-01" }],
    rules: [{ id: "student-rule", labelId: "student", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 80 }],
  });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const result = await worker.fetch(request("/attendance/policy/preview", { rule: { labelId: "mentor", startsOn: null, endsOn: null, ruleType: "weekly_count", meetingsPerWeek: 1 } }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(database.batches.length, 0);
});

test("label change previews show every resulting attendance policy", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, {
    members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }],
    labels: [{ id: "team", name: "FRC 321", active: 1, formulaEnabled: 0 }, { id: "class", name: "Class", active: 1, formulaEnabled: 0 }],
    changes: [{ memberId: "member-1", labelId: "team", action: "add", effectiveDate: "2026-01-01", createdAt: "2026-01-01T00:00:00Z" }],
    rules: [
      { id: "team-rule", labelId: "team", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 80, meetingsPerWeek: null, excusedHandling: "count_missed" },
      { id: "class-rule", labelId: "class", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 75, meetingsPerWeek: null, excusedHandling: "exclude" },
    ],
  });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const changes = [{ memberId: "A-101", label: "Class", action: "add", effectiveDate: "2026-01-01" }];
  const result = await worker.fetch(request("/labels/membership/preview", { changes }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200, await result.clone().text());
  const body = await result.json() as { impact: Array<{ beforePolicies: Array<{ labelName: string }>; afterPolicies: Array<{ labelName: string }> }> };
  assert.deepEqual(body.impact[0].beforePolicies.map((item) => item.labelName), ["FRC 321"]);
  assert.deepEqual(body.impact[0].afterPolicies.map((item) => item.labelName).sort(), ["Class", "FRC 321"]);
});

test("completed meeting audience edits require a matching impact preview", async () => {
  const database = new FakeDatabase(); database.rows.set("SELECT required, audience_mode AS audienceMode FROM meetings", { required: 1, audienceMode: "all" });
  database.lists.set("SELECT id, active FROM member_labels", [{ id: "drive", active: 1 }]);
  seedPolicy(database, { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2026-01-01" }], labels: [{ id: "drive", name: "Drive Team", active: 1, formulaEnabled: 0 }], meetings: [{ id: "meeting-1", title: "Build", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const cookie = await sessionCookie("operator");
  const change = { title: "Build", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: true, audienceMode: "labels", audienceLabelIds: ["drive"] };
  assert.equal((await worker.fetch(request("/meetings/meeting-1", change, { method: "PATCH", cookie }), env)).status, 409);
  const preview = await worker.fetch(request("/meetings/meeting-1/impact", change, { cookie }), env); assert.equal(preview.status, 200);
  const impact = await preview.json() as { previewToken: string; impact: Array<{ beforeRate: number | null; afterRate: number | null }> };
  assert.deepEqual(impact.impact, [{ memberId: "A-101", beforeRate: 0, afterRate: null, affectedCompletedMeetings: 1 }]);
  const saved = await worker.fetch(request("/meetings/meeting-1", { ...change, impactToken: impact.previewToken }, { method: "PATCH", cookie }), env);
  assert.equal(saved.status, 200, await saved.text());
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO meeting_audience_labels") && item.values.includes("drive")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("'meeting.updated'")));
});

test("roster backup and restore retain label definitions, dated history, and attendance rules", async () => {
  const database = new FakeDatabase();
  database.lists.set("FROM members WHERE", []);
  database.lists.set("FROM member_labels WHERE", [{ id: "mentor:primary", installation_id: "primary", name: "Mentor", active: 1, formula_enabled: 1, created_by: null, created_at: "2026-01-01T00:00:00Z" }]);
  database.lists.set("FROM member_label_changes WHERE", []);
  database.lists.set("FROM label_weekly_targets WHERE", []);
  database.lists.set("FROM label_attendance_rules WHERE", [{ id: "class-rule", installation_id: "primary", label_id: "mentor:primary", starts_on: null, ends_on: null, rule_type: "weighted_percentage", threshold_percent: 75, meetings_per_week: null, created_by: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", excused_handling: "count_missed" }]);
  database.rows.set("SELECT attendance_recent_days AS recentDays", { recentDays: 30, policyActivatedOn: "2026-09-22" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const cookie = await sessionCookie("admin");
  const exported = await worker.fetch(request("/admin/data/backup?scope=roster", undefined, { cookie }), env); assert.equal(exported.status, 200);
  const backup = await exported.json() as { format: string; formatVersion: number; schemaVersion: number; ownership: unknown; tables: Record<string, unknown[]>; attendanceRecentDays: number; attendancePolicyActivatedOn: string }; assert.equal(backup.schemaVersion, 41); assert.equal(backup.format, "lancerlogin-community-modular"); assert.equal(backup.formatVersion, 1); assert.ok(backup.ownership); assert.equal(backup.attendanceRecentDays, 30); assert.equal(backup.attendancePolicyActivatedOn, "2026-09-22");
  assert.deepEqual(Object.keys(backup.tables).sort(), ["label_attendance_rules", "label_weekly_targets", "member_label_changes", "member_labels", "members"]);
  assert.deepEqual(backup.tables.label_attendance_rules, [{ id: "class-rule", installation_id: "primary", label_id: "mentor:primary", starts_on: null, ends_on: null, rule_type: "weighted_percentage", threshold_percent: 75, meetings_per_week: null, created_by: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", excused_handling: "count_missed" }]);
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "roster", confirmation: "RESTORE ROSTER", backup }, { cookie }), env)).status, 200);
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO member_labels") && item.values.includes("Mentor")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO label_attendance_rules") && item.values.includes("count_missed")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("attendance_policy_activated_on = ?") && item.values.includes("2026-09-22")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("DELETE FROM discord_label_role_mappings") && item.sql.includes("active = 0")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("'data.backup_restored'")));
});

test("installation backup retains Discord role mappings while roster backup omits provider role IDs", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin");
  seedInstallationBackupFoundation(database);
  database.lists.set("FROM discord_label_role_mappings WHERE", [{ installation_id: "primary", label_id: "label-1", guild_id: "123456789012345678", role_id: "423456789012345678", role_name: "FRC 321", created_by: null, created_at: "2026-09-23T00:00:00Z" }]);
  database.lists.set("FROM saved_report_views WHERE", [{ id: "report-1", installation_id: "primary", owner_user_id: "admin-1", scope: "shared", name: "Class attendance", definition_json: JSON.stringify(defaultReportDefinition(false)), revision: 1, created_by: "admin-1", updated_by: "admin-1", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" }]);
  database.lists.set("FROM saved_report_tabs WHERE", [{ installation_id: "primary", user_id: "admin-1", report_view_id: "report-1", position: 0, pinned_at: "2026-09-25T00:00:00Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const installation = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as { schemaVersion: number; tables: Record<string, unknown[]> };
  const roster = await (await worker.fetch(request("/admin/data/backup?scope=roster", undefined, { cookie }), env)).json() as { tables: Record<string, unknown[]> };
  assert.equal(installation.schemaVersion, 41); assert.equal(installation.tables.discord_label_role_mappings.length, 1);
  assert.equal(installation.tables.saved_report_views.length, 1); assert.equal(installation.tables.saved_report_tabs.length, 1);
  assert.equal(Object.hasOwn(roster.tables, "discord_label_role_mappings"), false);
  assert.equal(Object.hasOwn(roster.tables, "saved_report_views"), false);
  const tampered = structuredClone(installation) as { tables: Record<string, Record<string, unknown>[]> };
  const savedAt = "2026-09-29T00:00:00Z";
  tampered.tables.carpool_plans = [{ installation_id: "primary", id: "plan-1", title: "Tampered", destination: "Arena", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "both", group_settings_json: "[]", last_rebuild_json: null, time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }];
  tampered.tables.carpool_people = [
    { installation_id: "primary", plan_id: "plan-1", id: "driver", member_id: null, display_name: "Driver", contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: "offer", outbound_address: "One", outbound_lat: 40, outbound_lon: -74, outbound_seats: 1, return_status: "offer", return_address: "One", return_lat: 40, return_lon: -74, return_seats: 1, return_same_as_outbound: 1, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: null, outbound_location_label: null, return_location_source: null, return_location_label: null },
    { installation_id: "primary", plan_id: "plan-1", id: "rider", member_id: null, display_name: "Rider", contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: "needs-ride", outbound_address: "Two", outbound_lat: 40.1, outbound_lon: -74.1, outbound_seats: null, return_status: "needs-ride", return_address: "Two", return_lat: 40.1, return_lon: -74.1, return_seats: null, return_same_as_outbound: 1, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: null, outbound_location_label: null, return_location_source: null, return_location_label: null },
  ];
  tampered.tables.carpool_assignments = [{ installation_id: "primary", plan_id: "plan-1", direction: "outbound", rider_id: "rider", vehicle_person_id: "driver", distance_miles: 1, locked: 0, manual: 0, created_at: savedAt, updated_at: savedAt }];
  tampered.tables.carpool_unresolved = [{ installation_id: "primary", plan_id: "plan-1", direction: "outbound", rider_id: "rider", reason: "needs-review", detail: "Conflicting state", created_at: savedAt }];
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: tampered }, { cookie }), env)).status, 400); assert.equal(database.batches.length, 0);
  const schema29 = structuredClone(installation) as { schemaVersion: number; tables: Record<string, Record<string, unknown>[]> }; schema29.schemaVersion = 29; omitContestResubmissionFields(schema29);
  for (const table of Object.keys(schema29.tables).filter((name) => name.startsWith("carpool_"))) delete schema29.tables[table];
  schema29.tables.platform_module_epochs = schema29.tables.platform_module_epochs.filter((row) => row.module_id !== "carpool"); schema29.tables.platform_modules = schema29.tables.platform_modules.filter((row) => row.module_id !== "carpool");
  const restored29 = await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: schema29 }, { cookie }), env); assert.equal(restored29.status, 200, await restored29.clone().text()); assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO platform_modules") && item.values.includes("carpool")));
  const restored = await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: installation }, { cookie }), env);
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO discord_label_role_mappings") && item.values.includes("423456789012345678")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO saved_report_views") && item.values.includes("Class attendance")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO saved_report_tabs") && item.values.includes("report-1")));
});

test("Worker composition exposes Carpool navigation only with both current module permissions", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("operator"); let attendance = true; let carpool = true;
  database.rows.set("SELECT m.generation FROM users u", (_sql: string, values: unknown[]) => (values[0] === "attendance" ? attendance : carpool) ? { generation: 1 } : undefined);
  database.lists.set("SELECT meeting_id AS meetingId,id,title FROM carpool_plans", [{ meetingId: "meeting-1", id: "plan-1", title: "Synthetic plan" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const read = () => worker.fetch(request("/admin/carpool/meeting-links", undefined, { cookie }), env);
  const visible = await read(); assert.equal(visible.status, 200); assert.deepEqual(await visible.json(), { available: true, links: [{ meetingId: "meeting-1", id: "plan-1", title: "Synthetic plan" }] });
  attendance = false; database.calls = []; const unavailable = await read(); assert.equal(unavailable.status, 200); assert.deepEqual(await unavailable.json(), { available: false, links: [] });
  assert.equal(database.calls.some(call => call.sql.includes("FROM carpool_plans") || call.sql.includes("FROM meetings")), false);
  carpool = false; assert.equal((await read()).status, 403);
});

test("Carpool meeting links survive strict schema33 recovery and older archives default to standalone", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database);
  const savedAt = "2026-10-10T00:00:00Z";
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic navigation", destination: "", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: "unavailable-meeting", trip_scope: "both", group_settings_json: "[]", last_rebuild_json: null, time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>;
  assert.equal(current.schemaVersion, 41); assert.equal(current.tables.carpool_plans[0].meeting_id, "unavailable-meeting");
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  const missing = structuredClone(current); delete missing.tables.carpool_plans[0].meeting_id;
  assert.equal((await restore(missing)).status, 400);
  for (const invalid of [123, "", " ", " padded "]) { const changed = structuredClone(current); changed.tables.carpool_plans[0].meeting_id = invalid; assert.equal((await restore(changed)).status, 400); }
  assert.equal(database.batches.length, 0);
  const restored = await restore(current); assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok(database.batches.at(-1)!.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.includes("unavailable-meeting")), "Optional opaque links do not require an Attendance table foreign key");
  const previous = structuredClone(current); previous.schemaVersion = 32; omitContestResubmissionFields(previous); delete previous.tables.carpool_settings; previous.ownership.modules.find((module: { id: string }) => module.id === "carpool").tables = previous.ownership.modules.find((module: { id: string }) => module.id === "carpool").tables.filter((table: string) => table !== "carpool_settings");
  delete previous.tables.hours_public_form_settings;
  const outreachOwner = previous.ownership.modules.find((module: Record<string, unknown>) => module.id === "hour-tracking");
  outreachOwner.tables = outreachOwner.tables.filter((table: string) => table !== "hours_public_form_settings");
  for (const row of previous.tables.hours_correction_requests) delete row.activity_id;
  for (const row of previous.tables.carpool_plans) { delete row.meeting_id; delete row.trip_scope; delete row.group_settings_json; delete row.last_rebuild_json; delete row.time_zone; delete row.outbound_departure_at; delete row.return_departure_at; }
  const migrated = await restore(previous); assert.equal(migrated.status, 200, await migrated.clone().text());
  assert.ok(database.batches.at(-1)!.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.sql.includes("meeting_id") && item.values.includes(null) && item.values.at(-6) === "both"));
});

test("Carpool schema37 preserves trip scope and pin provenance and defaults schema36 archives", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database); const savedAt = "2026-10-14T00:00:00Z";
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic return plan", destination: "Synthetic venue", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "return", group_settings_json: "[]", last_rebuild_json: null, time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }]);
  database.lists.set("FROM carpool_people WHERE", [{ installation_id: "primary", plan_id: "plan-1", id: "person-1", member_id: null, display_name: "Synthetic rider", contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: "unknown", outbound_address: "", outbound_lat: null, outbound_lon: null, outbound_seats: null, return_status: "needs-ride", return_address: "Synthetic address", return_lat: 40, return_lon: -74, return_seats: null, return_same_as_outbound: 0, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: null, outbound_location_label: null, return_location_source: "lookup", return_location_label: "Synthetic matched address" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>; assert.equal(current.schemaVersion, 41);
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  for (const mutate of [(backup: Record<string, any>) => { delete backup.tables.carpool_plans[0].trip_scope; }, (backup: Record<string, any>) => { backup.tables.carpool_plans[0].trip_scope = "unexpected"; }, (backup: Record<string, any>) => { backup.tables.carpool_people[0].return_location_source = "no-match"; }, (backup: Record<string, any>) => { delete backup.tables.carpool_people[0].return_location_label; }]) { const bad = structuredClone(current); mutate(bad); assert.equal((await restore(bad)).status, 400); }
  assert.equal(database.batches.length, 0); const result = await restore(current); assert.equal(result.status, 200, await result.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_people") && item.values.includes("lookup") && item.values.includes("Synthetic matched address"))); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-6) === "return"));
  const older = structuredClone(current); older.schemaVersion = 36; omitContestResubmissionFields(older); delete older.tables.carpool_plans[0].trip_scope; delete older.tables.carpool_plans[0].group_settings_json; delete older.tables.carpool_plans[0].last_rebuild_json; delete older.tables.carpool_plans[0].time_zone; delete older.tables.carpool_plans[0].outbound_departure_at; delete older.tables.carpool_plans[0].return_departure_at; for (const row of older.tables.carpool_people) for (const key of ["outbound_location_source", "outbound_location_label", "return_location_source", "return_location_label"]) delete row[key];
  const migrated = await restore(older); assert.equal(migrated.status, 200, await migrated.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-6) === "both")); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_people") && item.values.slice(-4).every(value => value === null)));
});

test("Carpool schema38 validates group labels and complete rebuild recovery while schema37 defaults them", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database); const savedAt = "2026-10-14T00:00:00Z";
  const settings = JSON.stringify([{ direction: "outbound", vehiclePersonId: "driver", label: "Synthetic east group", color: "teal" }]); const snapshot = { version: 1, revision: 3, directions: ["outbound"], radiusMiles: 12, preferredRadiusMiles: 4, assignments: [{ direction: "outbound", riderId: "rider", vehiclePersonId: "driver", distanceMiles: 1, locked: true, manual: true }], unresolved: [] };
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic groups", destination: "Synthetic venue", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 20, preferred_radius_miles: 6, notes: "", archived: 0, revision: 3, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "both", group_settings_json: settings, last_rebuild_json: JSON.stringify(snapshot), time_zone: "UTC", outbound_departure_at: null, return_departure_at: null }]);
  database.lists.set("FROM carpool_people WHERE", ["driver", "rider"].map(id => ({ installation_id: "primary", plan_id: "plan-1", id, member_id: null, display_name: "Synthetic " + id, contact: "", source_row: null, import_identity: null, import_snapshot_json: null, outbound_status: id === "driver" ? "offer" : "needs-ride", outbound_address: "Synthetic pickup", outbound_lat: 40, outbound_lon: -74, outbound_seats: id === "driver" ? 1 : null, return_status: "transit", return_address: "", return_lat: null, return_lon: null, return_seats: null, return_same_as_outbound: 0, notes: "", revision: 0, created_at: savedAt, updated_at: savedAt, outbound_location_source: "manual", outbound_location_label: null, return_location_source: null, return_location_label: null })));
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>; assert.equal(current.schemaVersion, 41);
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  for (const mutate of [(backup: Record<string, any>) => { delete backup.tables.carpool_plans[0].group_settings_json; }, (backup: Record<string, any>) => { backup.tables.carpool_plans[0].group_settings_json = JSON.stringify([{ direction: "outbound", vehiclePersonId: "missing", label: "Group", color: "blue" }]); }, (backup: Record<string, any>) => { backup.tables.carpool_plans[0].last_rebuild_json = JSON.stringify({ ...snapshot, revision: 4 }); }, (backup: Record<string, any>) => { backup.tables.carpool_plans[0].last_rebuild_json = JSON.stringify({ ...snapshot, assignments: [...snapshot.assignments, ...snapshot.assignments] }); }, (backup: Record<string, any>) => { backup.tables.carpool_people[0].outbound_seats = 0; }]) { const bad = structuredClone(current); mutate(bad); assert.equal((await restore(bad)).status, 400); }
  assert.equal(database.batches.length, 0); const restored = await restore(current); assert.equal(restored.status, 200, await restored.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.includes(settings) && item.values.includes(JSON.stringify(snapshot))));
  const older = structuredClone(current); older.schemaVersion = 37; omitContestResubmissionFields(older); delete older.tables.carpool_plans[0].group_settings_json; delete older.tables.carpool_plans[0].last_rebuild_json; delete older.tables.carpool_plans[0].time_zone; delete older.tables.carpool_plans[0].outbound_departure_at; delete older.tables.carpool_plans[0].return_departure_at; const migrated = await restore(older); assert.equal(migrated.status, 200, await migrated.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-5) === "[]" && item.values.at(-4) === null));
});

test("Carpool schema39 validates trip timing before writes and defaults schema38 timing", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database); const savedAt = "2026-10-14T00:00:00Z";
  database.lists.set("FROM carpool_plans WHERE", [{ installation_id: "primary", id: "plan-1", title: "Synthetic timed event", destination: "Synthetic venue", event_reference: null, event_title_snapshot: null, event_starts_at_snapshot: null, radius_miles: 12, preferred_radius_miles: 4, notes: "", archived: 0, revision: 0, created_by: "admin-1", created_at: savedAt, updated_at: savedAt, meeting_id: null, trip_scope: "both", group_settings_json: "[]", last_rebuild_json: null, time_zone: "America/New_York", outbound_departure_at: "2026-10-14T12:00:00.000Z", return_departure_at: "2026-10-14T22:00:00.000Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>; assert.equal(current.schemaVersion, 41);
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  for (const mutate of [(row: Record<string, any>) => { delete row.time_zone; }, (row: Record<string, any>) => { row.time_zone = null; }, (row: Record<string, any>) => { row.time_zone = "Invalid/Zone"; }, (row: Record<string, any>) => { row.outbound_departure_at = "2026-02-30T12:00:00.000Z"; }, (row: Record<string, any>) => { row.outbound_departure_at = ""; }, (row: Record<string, any>) => { row.return_departure_at = row.outbound_departure_at; }]) { const bad = structuredClone(current); mutate(bad.tables.carpool_plans[0]); assert.equal((await restore(bad)).status, 400); }
  assert.equal(database.batches.length, 0); const restored = await restore(current); assert.equal(restored.status, 200, await restored.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-3) === "America/New_York" && item.values.at(-2) === "2026-10-14T12:00:00.000Z"));
  const older = structuredClone(current); older.schemaVersion = 38; omitContestResubmissionFields(older); for (const key of ["time_zone", "outbound_departure_at", "return_departure_at"]) delete older.tables.carpool_plans[0][key]; const migrated = await restore(older); assert.equal(migrated.status, 200, await migrated.clone().text()); assert.ok(database.batches.at(-1)?.some(item => item.sql.includes("INSERT INTO carpool_plans") && item.values.at(-3) === "UTC" && item.values.at(-2) === null && item.values.at(-1) === null));
});

test("installation restore validates ownership before writes and replaces transient authority", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database);
  database.lists.set("FROM pairing_codes WHERE", [{ id: "pairing-1", installation_id: "primary", code_hash: "old-code-hash", expires_at: "2026-10-01T00:00:00Z", redeemed_at: "2026-09-01T00:00:00Z", created_by: "admin-1", created_at: "2026-09-01T00:00:00Z", purpose: "hardware" }]);
  database.lists.set("FROM kiosks WHERE", [{ id: "kiosk-1", installation_id: "primary", pairing_code_id: "pairing-1", name: "Front desk", token_hash: "old-token-hash", active: 1, last_seen_at: "2026-09-27T12:00:00Z", created_at: "2026-09-01T00:00:00Z", reader_online: 1, release_version: "1.2.4", pending_events: 2, last_sync_at: "2026-09-27T12:00:00Z", error_category: null, pairing_bound: 1, authentication_method: "fingerprint", configured_authentication_method: "qr" }]);
  database.lists.set("FROM simulated_kiosk_sessions WHERE", [{ installation_id: "primary", pairing_code_id: "pairing-1", name: "Browser", active: 1, online: 1, last_seen_at: "2026-09-27T12:00:00Z", created_by: "admin-1", created_at: "2026-09-01T00:00:00Z" }]);
  database.lists.set("FROM integration_deliveries WHERE", [{ id: "delivery-1", installation_id: "primary", provider: "resend", delivery_key: "report:one", status: "pending", external_id: null, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z" }]);
  database.lists.set("FROM google_calendar_operations WHERE", [{ installation_id: "primary", meeting_id: "meeting-1", event_id: "event-1", action: "upsert", starts_at: "2026-10-01T20:00:00Z", ends_at: "2026-10-01T21:00:00Z", status: "pending", attempts: 0, next_attempt_at: "2026-09-28T00:00:00Z", last_error: null, updated_at: "2026-09-27T00:00:00Z" }]);
  database.lists.set("FROM discord_calendar_operations WHERE", [{ installation_id: "primary", meeting_id: "meeting-1", generation: 1, action: "upsert", event_id: null, status: "processing", attempts: 1, revision: 1, next_attempt_at: "2026-09-28T00:00:00Z", lease_token: "old-lease", lease_expires_at: "2026-09-28T00:05:00Z", last_error: null, actor_user_id: "admin-1", updated_at: "2026-09-27T00:00:00Z" }]);
  database.lists.set("FROM hours_publication_operations WHERE", [
    { installation_id: "primary", activity_id: "activity-1", publication_revision: 1, provider: "discord", status: "pending", attempts: 0, next_attempt_at: "2026-09-28T00:00:00Z", external_id: null, last_error: null, lease_token: null, lease_expires_at: null, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z", action: "publish", event_snapshot_json: null },
    { installation_id: "primary", activity_id: "activity-complete", publication_revision: 1, provider: "discord", status: "succeeded", attempts: 1, next_attempt_at: null, external_id: "message-1", last_error: null, lease_token: null, lease_expires_at: null, created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:01:00Z", action: "publish", event_snapshot_json: null },
  ]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const backup = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>;
  const attendanceOwnership = backup.ownership.modules.find((module: Record<string, unknown>) => module.id === "attendance");
  assert.ok(attendanceOwnership.sharedFields.some((field: { table: string }) => field.table === "members")); assert.ok(attendanceOwnership.transientAuthority.some((field: { table: string }) => field.table === "kiosks"));

  const wrongOwnership = structuredClone(backup); wrongOwnership.ownership.modules[0].tables = [];
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: wrongOwnership }, { cookie }), env)).status, 400);
  const oldModular = structuredClone(backup); oldModular.schemaVersion = 27; omitContestResubmissionFields(oldModular); oldModular.tables.platform_module_configuration = [];
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: oldModular }, { cookie }), env)).status, 400);
  const invalidLifecycle = structuredClone(backup); invalidLifecycle.tables.platform_modules.find((row: Record<string, unknown>) => row.module_id === "hour-tracking").delete_after = "2026-10-01T00:00:00Z";
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: invalidLifecycle }, { cookie }), env)).status, 400);
  const exhaustedAuthority = structuredClone(backup); exhaustedAuthority.tables.platform_module_administration[0].revision = Number.MAX_SAFE_INTEGER - 1; exhaustedAuthority.tables.platform_module_administration_epochs[0].revision = Number.MAX_SAFE_INTEGER - 1;
  assert.equal((await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: exhaustedAuthority }, { cookie }), env)).status, 400);
  assert.equal(database.batches.length, 0, "invalid archives must fail before destructive statements");

  const restored = await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  assert.equal(restored.status, 200, await restored.clone().text());
  const body = await restored.json() as { recovery: { revokedKiosks: number; invalidatedPairingCodes: number; pausedProviderOperations: number } };
  assert.deepEqual(body.recovery, { revokedKiosks: 1, invalidatedPairingCodes: 1, pausedProviderOperations: 4 });
  const batch = database.batches.at(-1) ?? [];
  const kiosk = batch.find((item) => item.sql.startsWith("INSERT INTO kiosks")); assert.equal(kiosk?.values[5], 0); assert.notEqual(kiosk?.values[4], "old-token-hash");
  const pairing = batch.find((item) => item.sql.startsWith("INSERT INTO pairing_codes")); assert.notEqual(pairing?.values[2], "old-code-hash");
  const google = batch.find((item) => item.sql.startsWith("INSERT INTO google_calendar_operations")); assert.equal(google?.values[6], "failed"); assert.equal(google?.values[8], null);
  const discord = batch.find((item) => item.sql.startsWith("INSERT INTO discord_calendar_operations")); assert.equal(discord?.values[5], "failed"); assert.equal(discord?.values[9], null); assert.equal(discord?.values[10], null);
  const publication = batch.find((item) => item.sql.startsWith("INSERT INTO hours_publication_operations")); assert.equal(publication?.values[4], "failed"); assert.equal(publication?.values[9], null);
  const completedPublication = batch.find((item) => item.sql.startsWith("INSERT INTO hours_publication_operations") && item.values[1] === "activity-complete"); assert.equal(completedPublication?.values[4], "succeeded"); assert.equal(completedPublication?.values[7], "message-1");
  assert.ok(batch.some((item) => item.sql.includes("ON CONFLICT(installation_id,module_id) DO UPDATE SET generation")));
  assert.ok(batch.some((item) => item.sql.includes("SELECT 'primary',?,?,generation") && item.sql.includes("FROM platform_module_epochs")));
});

test("Community 1.2.5 backups and previous Modular archives preserve explicit format boundaries", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin"); seedInstallationBackupFoundation(database);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const current = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as Record<string, any>;
  const restore = (backup: unknown) => worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  const previous = structuredClone(current); previous.schemaVersion = 31; omitContestResubmissionFields(previous); for (const row of previous.tables.kiosks) delete row.configured_authentication_method; delete previous.tables.carpool_settings; previous.ownership.modules.find((module: { id: string }) => module.id === "carpool").tables = previous.ownership.modules.find((module: { id: string }) => module.id === "carpool").tables.filter((table: string) => table !== "carpool_settings");
  delete previous.tables.hours_public_form_settings;
  previous.ownership.modules.find((module: Record<string, unknown>) => module.id === "hour-tracking").tables = previous.ownership.modules.find((module: Record<string, unknown>) => module.id === "hour-tracking").tables.filter((table: string) => table !== "hours_public_form_settings");
  for (const row of previous.tables.hours_correction_requests) delete row.activity_id;
  for (const name of ["discord_attendance_notifications", "discord_attendance_recipients"]) for (const row of previous.tables[name]) delete row.delivery_id;
  const wrongOwner = structuredClone(previous); wrongOwner.ownership.modules[0].tables = [];
  assert.equal((await restore(wrongOwner)).status, 400);
  const extraColumn = structuredClone(previous); extraColumn.tables.installations[0].unexpected = "no";
  assert.equal((await restore(extraColumn)).status, 400);
  assert.equal(database.batches.length, 0);
  assert.equal((await restore(previous)).status, 200);
  const community = structuredClone(current); community.schemaVersion = 22; omitContestResubmissionFields(community);
  delete community.format; delete community.formatVersion; delete community.ownership;
  for (const name of Object.keys(community.tables)) if (/^(platform_module|hours_|carpool_)/.test(name) || name === "user_preferences") delete community.tables[name];
  for (const row of community.tables.organization_settings) delete row.kiosk_authentication_method;
  for (const row of community.tables.kiosks) { delete row.pairing_bound; delete row.authentication_method; delete row.configured_authentication_method; }
  const malformed = structuredClone(community); malformed.tables.platform_modules = [];
  const before = database.batches.length;
  assert.equal((await restore(malformed)).status, 400);
  assert.equal(database.batches.length, before);
  const result = await restore(community);
  assert.equal(result.status, 200, await result.clone().text());
  const batch = database.batches.at(-1)!;
  assert.ok(batch.some(item => item.sql.includes("platform_modules") && item.values.includes("attendance")), "Community restore initializes Attendance authority");
});

test("custom report queries and exports apply current membership to past periods without label writes", async () => {
  const database = new FakeDatabase();
  seedPolicy(database, {
    members: [{ id: "member-1", memberId: "A-1", firstName: "Avery", lastName: "Stone", active: 1, attendanceRequiredFrom: "2020-09-01" }],
    labels: [{ id: "class", name: "Class", active: 1, formulaEnabled: 0 }],
    changes: [{ memberId: "member-1", labelId: "class", action: "add", effectiveDate: new Date().toISOString().slice(0, 10) }],
    rules: [{ id: "class-rule", labelId: "class", ruleType: "weighted_percentage", thresholdPercent: 75, excusedHandling: "exclude" }],
    meetings: [1, 2, 3].map((day) => ({ id: `meeting-${day}`, title: `Class ${day}`, startsAt: `2020-09-0${day}T18:00:00Z`, endsAt: `2020-09-0${day}T20:00:00Z`, required: 1, attendanceWeight: day === 1 ? 3 : day === 3 ? 2 : 1, audienceMode: "labels", isTest: 0 })),
    audience: [1, 2, 3].map((day) => ({ meetingId: `meeting-${day}`, labelId: "class" })),
    corrections: [{ meetingId: "meeting-1", memberId: "member-1", disposition: "present" }, { meetingId: "meeting-3", memberId: "member-1", disposition: "excused" }],
  });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("operator");
  const definition = { ...defaultReportDefinition(false), period: { type: "fixed", from: "2020-09-01", to: "2020-09-30" }, labelIds: ["class"], columns: [{ key: "core.member.name" }, { key: "attendance.member.regular-rate" }, { key: "attendance.policy.report-result", labelId: "class" }, { key: "attendance.policy.official-result", labelId: "class" }] };
  const query = async (overrides = {}) => {
    const result = await worker.fetch(request("/reports/query", { definition: { ...definition, ...overrides } }, { cookie }), env);
    assert.equal(result.status, 200, await result.clone().text());
    return await result.json() as { rows: { cells: Record<string, { text: string }> }[] };
  };
  const current = await query();
  assert.equal(current.rows[0].cells["attendance.member.regular-rate"].text, "50%");
  assert.equal(current.rows[0].cells["attendance.policy.report-result:class"].text, "Class: 75% · met");
  assert.equal(current.rows[0].cells["attendance.policy.official-result:class"].text, "Class: N/A");
  assert.deepEqual((await query({ membership: "historical" })).rows, []);
  assert.equal((await query({ membership: "historical", labelIds: [] })).rows[0].cells["attendance.policy.report-result:class"].text, "Class: N/A");
  const summary = await worker.fetch(request("/exports/report.csv", { definition }, { cookie }), env);
  assert.equal(summary.status, 200);
  assert.match(await summary.text(), /Avery Stone,50%,Class: 75% · met,Class: N\/A/);
  const detail = await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie }), env);
  assert.equal(detail.status, 200);
  const lines = (await detail.text()).trim().split("\r\n");
  const headers = lines[0].split(","), first = lines[1].split(",");
  assert.equal(lines.length, 4);
  assert.equal(first[headers.indexOf("memberLabels")], "Class");
  assert.equal(first[headers.indexOf("regularEligible")], "true");
  assert.equal(first[headers.indexOf("regularRate")], "50");
  assert.equal(database.batches.length, 0);
  assert.ok(database.calls.every((call) => !/INSERT INTO member_label_changes|UPDATE member_label_changes|DELETE FROM member_label_changes/.test(call.sql)));
});

test("custom report exports include every filtered row and neutralize selected values", async () => {
  const database = new FakeDatabase(); seedPolicy(database, { members: [{ id: "member-1", memberId: "=MEMBER()", firstName: "+Avery", lastName: "Stone", email: "=EMAIL()", active: 1, attendanceRequiredFrom: "2026-01-01" }, { id: "member-2", memberId: "B-2", firstName: "Blair", lastName: "Baker", email: "blair@example.test", active: 1, attendanceRequiredFrom: "2026-01-01" }], meetings: [{ id: "meeting-1", title: "Studio, weekly", startsAt: "2026-09-01T20:00:00Z", endsAt: "2026-09-01T22:00:00Z", required: 1, attendanceWeight: 1, audienceMode: "all", isTest: 0 }] });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env; const definition = { ...defaultReportDefinition(false), columns: [{ key: "core.member.name" }, { key: "core.member.id" }, { key: "core.member.email" }], columnFilters: [{ column: { key: "core.member.name" as const }, operator: "contains" as const, value: "Avery" }], sort: { column: { key: "core.member.name" }, direction: "asc" as const } };
  assert.equal((await worker.fetch(request("/exports/report.csv", { definition }), env)).status, 401);
  const summary = await worker.fetch(request("/exports/report.csv", { definition }, { cookie: await sessionCookie("operator") }), env); assert.equal(summary.status, 200); const summaryCsv = await summary.text(); assert.match(summaryCsv, /Member,Member ID,Email/); assert.match(summaryCsv, /'\+Avery Stone,'=MEMBER\(\),'=EMAIL\(\)/); assert.doesNotMatch(summaryCsv, /Blair/);
  const detail = await worker.fetch(request("/exports/report-detail.csv", { definition }, { cookie: await sessionCookie("operator") }), env); assert.equal(detail.status, 200); const detailCsv = await detail.text(); assert.match(detailCsv, /"Studio, weekly"/); assert.doesNotMatch(detailCsv, /Blair/);
  assert.equal(database.calls.filter((call) => call.values.includes("report.exported")).length, 2);
});

test("schema 17 installation backups default fields added by parallel attendance and Discord upgrades", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin");
  seedInstallationBackupFoundation(database, [{ id: "admin-1", installation_id: "primary", email: null, local_username: "admin", password_hash: "hash", failed_login_count: 0, locked_until: null, role: "admin", active: 1, created_at: "2026-09-01T00:00:00Z", member_id: null, debug_mode: 1 }]);
  database.lists.set("FROM label_attendance_rules WHERE", [{ id: "class-rule", installation_id: "primary", label_id: "class", starts_on: null, ends_on: null, rule_type: "weighted_percentage", threshold_percent: 80, meetings_per_week: null, created_by: "admin-1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", excused_handling: "count_missed" }]);
  database.lists.set("FROM discord_attendance_notifications WHERE", [{ installation_id: "primary", meeting_id: "meeting-1", status: "delivered", message_id: "notice-1", attempts: 1, last_error: null, processed_at: "2026-09-01T22:00:00Z", updated_at: "2026-09-01T22:00:00Z", channel_id: "223456789012345678", expires_at: "2026-09-02T22:00:00Z", deleted_at: null, thread_created_at: "2026-09-01T22:01:00Z" }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const backup = await (await worker.fetch(request("/admin/data/backup?scope=installation", undefined, { cookie }), env)).json() as { schemaVersion: number; tables: Record<string, Record<string, unknown>[]> };
  backup.schemaVersion = 17; omitContestResubmissionFields(backup); delete backup.tables.carpool_settings;
  delete backup.tables.users[0].debug_mode;
  delete backup.tables.label_attendance_rules[0].excused_handling;
  delete backup.tables.discord_attendance_notifications[0].thread_created_at;
  const restored = await worker.fetch(request("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup }, { cookie }), env);
  assert.equal(restored.status, 200, await restored.clone().text());
  const batch = database.batches.at(-1) ?? [];
  assert.equal(batch.find((item) => item.sql.startsWith("INSERT INTO users"))?.values.at(-1), 0);
  assert.equal(batch.find((item) => item.sql.startsWith("INSERT INTO label_attendance_rules"))?.values.at(-1), "exclude");
  assert.equal(batch.find((item) => item.sql.startsWith("INSERT INTO discord_attendance_notifications"))?.values.at(-1), null);
});

test("schema 16 meeting restore defaults Discord thread tracking", async () => {
  const database = new FakeDatabase(); const cookie = await sessionCookie("admin");
  database.lists.set("FROM discord_attendance_notifications WHERE", [{ installation_id: "primary", meeting_id: "meeting-1", status: "delivered", message_id: "notice-1", attempts: 1, last_error: null, processed_at: "2026-09-01T22:00:00Z", updated_at: "2026-09-01T22:00:00Z", channel_id: "223456789012345678", expires_at: "2026-09-02T22:00:00Z", deleted_at: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const backup = await (await worker.fetch(request("/admin/data/backup?scope=meetings", undefined, { cookie }), env)).json() as { schemaVersion: number; tables: Record<string, unknown[]> };
  backup.schemaVersion = 16; omitContestResubmissionFields(backup);
  const restored = await worker.fetch(request("/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup }, { cookie }), env);
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO discord_attendance_notifications") && item.values.at(-1) === null));
});

test("schema 14 roster restore converts prior weekly targets into current rules", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const backup = { product: "LancerLogin", schemaVersion: 14, scope: "roster", exportedAt: "2026-09-01T00:00:00Z", tables: {
    members: [],
    member_labels: [{ id: "mentor", installation_id: "primary", name: "Mentor", active: 1, formula_enabled: 1, created_by: null, created_at: "2026-09-01T00:00:00Z" }],
    member_label_changes: [],
    label_weekly_targets: [{ id: "old-target", installation_id: "primary", label_id: "mentor", starts_on: "2026-09-01", ends_on: "2026-09-30", meetings_per_week: 1, created_by: null, created_at: "2026-09-01T00:00:00Z" }],
  } };
  const result = await worker.fetch(request("/admin/data/restore", { scope: "roster", confirmation: "RESTORE ROSTER", backup }, { cookie: await sessionCookie("admin") }), env);
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("INSERT INTO label_attendance_rules") && item.values.includes("legacy:old-target") && item.values.includes("exclude")));
  assert.ok(database.batches.at(-1)?.some((item) => item.sql.includes("attendance_policy_activated_on = ?") && item.values.includes(new Date().toISOString().slice(0, 10))));
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

for (const scenario of ["update", "conflict", "retry"] as const) {
  test(`Google Calendar ${scenario} sends current title and clears removed notes`, async () => {
    const database = new FakeDatabase();
    const encrypted = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "calendar-refresh", calendarId: "calendar@example.test" }, sessionSecret);
    database.rows.set("google_calendar_enabled AS enabled", { ...encrypted, enabled: 1, authorizedAt: "2026-09-05", verifiedAt: "2026-09-05" });
    database.rows.set("SELECT title, notes, required, attendance_weight AS attendanceWeight FROM meetings", { title: "Renamed build meeting", notes: null, required: 1, attendanceWeight: 1 });
    database.lists.set("FROM google_calendar_operations o", [{ meetingId: "meeting-1", eventId: "ll1234", action: "upsert", startsAt: "2026-10-01T20:00:00Z", endsAt: "2026-10-01T21:00:00Z", status: "failed", attempts: 1, generation: 1, syncedAt: scenario === "update" ? "2026-09-05" : null }]);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "short-access-token" }));
      calls.push({ method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "ll1234" }), { status: scenario === "conflict" && init?.method === "POST" ? 409 : 200 });
    }) as typeof fetch;
    try {
      const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
      const result = await worker.fetch(request("/admin/integrations/google-calendar/retry", {}, { cookie: await sessionCookie("admin") }), env);
      assert.equal(result.status, 200);
      assert.equal((await result.json() as { synced: number }).synced, 1);
      assert.deepEqual(calls.map(call => call.method), scenario === "conflict" ? ["POST", "PATCH"] : [scenario === "update" ? "PATCH" : "POST"]);
      for (const call of calls) {
        assert.equal(call.body.summary, "Renamed build meeting");
        assert.equal(call.body.description, "Audience: All\nAttendance: Required (weight 1)");
        assert.deepEqual(call.body.start, { dateTime: "2026-10-01T20:00:00Z" });
        assert.equal("attendees" in call.body, false);
      }
    } finally { globalThis.fetch = original; }
  });
}

test("normal simulator scans use kiosk attendance sequencing and audit the actual result", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM simulated_kiosk_sessions", { name: "Browser test", active: 1, online: 1 });
  database.rows.set("FROM members", { id: "member-1", firstName: "Avery", lastName: "Stone" });
  database.rows.set("FROM meetings", { id: "meeting-1", startsAt: new Date(Date.now() - 600_000).toISOString(), endsAt: new Date(Date.now() + 600_000).toISOString() });
  database.rows.set("late_scan_minutes AS lateScanMinutes", { lateScanMinutes: 30 });
  database.lists.set("FROM attendance_events", []);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const cookie = await sessionCookie("admin");
  const body = { action: "scan", memberId: "member-1", meetingId: "meeting-1" };
  const arrival = await worker.fetch(request("/admin/simulator", body, { cookie }), env);
  assert.equal(arrival.status, 202); assert.equal((await arrival.json() as { action: string }).action, "check_in");
  database.lists.set("FROM attendance_events", [{ action: "check_in", occurredAt: new Date(Date.now() - 1_000).toISOString() }]);
  const debounce = await worker.fetch(request("/admin/simulator", body, { cookie }), env);
  assert.equal(debounce.status, 200); assert.equal((await debounce.json() as { duplicate: boolean }).duplicate, true);
  database.lists.set("FROM attendance_events", [{ action: "check_in", occurredAt: new Date(Date.now() - 120_000).toISOString() }]);
  const departure = await worker.fetch(request("/admin/simulator", body, { cookie }), env);
  assert.equal(departure.status, 202); assert.equal((await departure.json() as { action: string }).action, "check_out");
  assert.ok(database.calls.some(call => call.values.includes("simulator.check_out")));
  const invalid = await worker.fetch(request("/admin/simulator", { ...body, scanAction: "invalid" }, { cookie }), env);
  assert.equal(invalid.status, 400);
  assert.equal((await worker.fetch(request("/admin/simulator", body, { cookie: await sessionCookie("operator") }), env)).status, 403);
});

test("unchanged but deleted Discord status is recreated only after verifying its tracked ID", async () => {
  const database = new FakeDatabase();
  const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("FROM integration_state", { externalId: "deleted-status", contentHash: createHash("sha256").update("No kiosk is paired.").digest("base64url") });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
  const originalFetch = globalThis.fetch; const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    methods.push(String(init?.method));
    if (init?.method === "GET") {
      assert.match(String(input), /\/messages\/deleted-status$/);
      return new Response(JSON.stringify({ code: 10_008, message: "Unknown Message" }), { status: 404 });
    }
    assert.equal(init?.method, "POST"); assert.match(String(input), /\/channels\/223456789012345678\/messages$/);
    return new Response(JSON.stringify({ id: "replacement-status" }));
  };
  try {
    const result = await worker.fetch(request("/discord/kiosk-status", {}, { cookie: await sessionCookie("operator") }), env);
    assert.equal(result.status, 200); const body = await result.json() as { changed: boolean; messageUrl: string };
    assert.equal(body.changed, true); assert.match(body.messageUrl, /\/replacement-status$/); assert.deepEqual(methods, ["GET", "POST"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("Discord calendar explains an unsynced started meeting and updates a tracked active event without changing its start", async () => {
  for (const eventId of [null, "event-1"]) {
    const database = new FakeDatabase();
    const encrypted = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678" }, sessionSecret);
    database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...encrypted, verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
    database.rows.set("FROM meetings WHERE", { id: "meeting-1", title: "Current studio", startsAt: new Date(Date.now() - 600_000).toISOString(), endsAt: new Date(Date.now() + 600_000).toISOString(), notes: "Bring tools" });
    database.rows.set("SELECT event_id AS eventId, active FROM discord_calendar_event_mappings", { eventId, active: 1 });
    database.lists.set("FROM discord_calendar_operations o", [{ meetingId: "meeting-1", generation: 1, action: "upsert", status: "failed", attempts: 1, actorUserId: "operator-1" }]);
    const originalFetch = globalThis.fetch; const methods: string[] = [];
    globalThis.fetch = async (_input, init) => {
      methods.push(String(init?.method));
      if (init?.method === "GET") return new Response(JSON.stringify([]));
      assert.equal(init?.method, "PATCH"); const payload = JSON.parse(String(init?.body));
      assert.equal(payload.scheduled_start_time, undefined); assert.equal(payload.name, "Current studio"); assert.equal(payload.description, "Audience: All\nAttendance: Optional\n\nBring tools");
      return new Response(JSON.stringify({ id: eventId }));
    };
    try {
      const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database } as unknown as Env;
      const result = await worker.fetch(request("/discord/calendar", { meetingId: "meeting-1" }, { cookie: await sessionCookie("operator") }), env);
      const body = await result.json() as { synced: number; skipped: number; failed: number; outcomes: Array<{ reason?: string }> };
      assert.equal(result.status, 200); assert.equal(body.failed, 0);
      if (eventId) { assert.equal(body.synced, 1); assert.deepEqual(methods, ["PATCH"]); }
      else { assert.equal(body.skipped, 1); assert.match(body.outcomes[0].reason ?? "", /already started.*Sync upcoming meetings/); assert.deepEqual(methods, ["GET"]); }
      assert.ok(database.calls.some(call => call.sql.includes("last_error = NULL")) || database.batches.some(batch => batch.some(call => call.sql.includes("last_error = NULL"))));
    } finally { globalThis.fetch = originalFetch; }
  }
});

test("Carpool settings require current Admin authorization and never expose credentials", async () => {
  const database = new FakeDatabase(); const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: "A".repeat(43), DB: database } as unknown as Env;
  const operator = await worker.fetch(request("/admin/carpool/settings", undefined, { cookie: await sessionCookie("operator") }), env); assert.equal(operator.status, 403);
  assert.equal(database.calls.some(call => call.sql.includes("carpool_settings") || call.sql.includes("carpool_geocoding_credentials")), false);
  const admin = await worker.fetch(request("/admin/carpool/settings", undefined, { cookie: await sessionCookie("admin") }), env); assert.equal(admin.status, 200, await admin.clone().text());
  assert.deepEqual(await admin.json(), { radiusMiles: 12, preferredRadiusMiles: 4, revision: 0, geocodingConfigured: false, canSaveApiKey: true });
});

test("contest backups retain rejected submission history, default schema40 and reject malformed history before writes", async () => {
  const database = new FakeDatabase(); seedInstallationBackupFoundation(database);
  const cookie = await sessionCookie("admin");
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const history = JSON.stringify([{ messageId: "original-message", createdAt: "2026-10-15T10:00:00Z", status: "rejected", resolvedBy: "admin-1", resolvedAt: "2026-10-15T11:00:00Z", reviewNote: "Original review", submittedByDiscordUserId: "synthetic-discord" }]);
  database.lists.set("FROM discord_attendance_contests WHERE", [{ installation_id: "primary", meeting_id: "meeting", member_id: "member", message_id: "new-message", status: "open", resolved_by: null, resolved_at: null, created_at: "2026-10-15T12:00:00Z", submitted_by_discord_user_id: "synthetic-discord", review_note: null, prior_reviews_json: history }]);
  const backup = await (await worker.fetch(request("/admin/data/backup?scope=meetings", undefined, { cookie }), env)).json() as any;
  assert.equal(backup.schemaVersion, 41); assert.equal(backup.tables.discord_attendance_contests[0].prior_reviews_json, history);
  const restore = (value: unknown) => worker.fetch(request("/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup: value }, { cookie }), env);
  const restored = await restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.ok(database.batches.at(-1)?.some(call => call.sql.includes("INSERT INTO discord_attendance_contests") && call.values.includes(history)));
  const legacy = structuredClone(backup); legacy.schemaVersion = 40; omitContestResubmissionFields(legacy);
  const old = await restore(legacy); assert.equal(old.status, 200, await old.clone().text());
  assert.ok(database.batches.at(-1)?.some(call => call.sql.includes("INSERT INTO discord_attendance_contests") && call.values.at(-1) === "[]"));
  for (const invalid of ["{}", "[null]", '[{"status":"rejected","reviewNote":{}}]']) {
    const bad = structuredClone(backup); bad.tables.discord_attendance_contests[0].prior_reviews_json = invalid;
    const before = database.batches.length; assert.equal((await restore(bad)).status, 400); assert.equal(database.batches.length, before);
  }
});

test("retained scan review routes require an active Admin, dashboard origin and enabled Attendance", async () => {
  const database = new FakeDatabase(), admin = await sessionCookie("admin"), operator = await sessionCookie("operator");
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const listing = "/admin/kiosks/scan-reviews", review = "/admin/kiosks/kiosk-a/scan-reviews/synthetic-scan/review";
  database.lists.set("FROM kiosk_scan_reviews r JOIN kiosks", [{ kioskId: "kiosk-a", kioskName: "Synthetic kiosk", evidence: JSON.stringify({ eventId: "synthetic-scan", memberId: "synthetic-member", occurredAt: "2020-01-01T07:00:00Z", reasonCode: "clock_unverified", httpStatus: null }), reviewStatus: "open", reviewedAt: null, reviewNote: null, receivedAt: "2026-10-25T10:00:00Z" }]);
  database.lists.set("SELECT review_status AS status FROM kiosk_scan_reviews", [{ status: "reviewed" }]);
  assert.equal((await worker.fetch(request(listing), env)).status, 401);
  assert.equal((await worker.fetch(request(listing, undefined, { cookie: operator }), env)).status, 403);
  const listed = await worker.fetch(request(listing, undefined, { cookie: admin }), env);
  assert.equal(listed.status, 200); assert.equal(listed.headers.get("cache-control"), "no-store");
  assert.equal((await listed.json() as any).records[0].reasonCode, "clock_unverified");
  assert.equal((await worker.fetch(request(listing + "?offset=-1", undefined, { cookie: admin }), env)).status, 400);
  assert.equal((await worker.fetch(request(listing + "?status=invalid", undefined, { cookie: admin }), env)).status, 400);
  const mutation = (cookie: string, origin?: string, note = "Corrected attendance separately") => new Request("https://api.example.test" + review, { method: "POST", headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ note }) });
  const readBatches = database.batches.length;
  assert.equal((await worker.fetch(mutation(operator, env.ALLOWED_ORIGIN), env)).status, 403);
  assert.equal((await worker.fetch(mutation(admin), env)).status, 403);
  assert.equal((await worker.fetch(mutation(admin, "https://untrusted.example.test"), env)).status, 403);
  assert.equal((await worker.fetch(mutation(admin, env.ALLOWED_ORIGIN, " "), env)).status, 400);
  assert.equal(database.batches.length, readBatches);
  const note = "Checked the retained scan.\nAttendance corrected separately.";
  const saved = await worker.fetch(mutation(admin, env.ALLOWED_ORIGIN, note), env); assert.equal(saved.status, 200, await saved.clone().text());
  assert.ok(database.batches.at(-1)?.some(call => call.sql.includes("UPDATE kiosk_scan_reviews") && call.values.includes(note)));
  assert.ok(database.batches.at(-1)?.some(call => call.sql.includes("kiosk.scan_reviewed")));
  assert.equal(database.batches.at(-1)?.some(call => /attendance_events|attendance_corrections/.test(call.sql)), false);
  const before = database.batches.length;
  database.rows.set("SELECT m.generation FROM users u", null);
  assert.equal((await worker.fetch(request(listing, undefined, { cookie: admin }), env)).status, 403);
  assert.equal((await worker.fetch(mutation(admin, env.ALLOWED_ORIGIN), env)).status, 403);
  assert.equal(database.batches.length, before);
});

test("bulk scan dismissal requires Admin authority, exact origin and enabled Attendance", async () => {
  const database = new FakeDatabase(), admin = await sessionCookie("admin"), operator = await sessionCookie("operator");
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const post = (cookie: string, origin?: string, records: unknown = [{ kioskId: "kiosk-a", eventId: "scan-a" }]) => new Request("https://api.example.test/admin/kiosks/scan-reviews/review", { method: "POST", headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ records, note: "Checked retained evidence.\nAttendance unchanged." }) });
  assert.equal((await worker.fetch(post("", env.ALLOWED_ORIGIN), env)).status, 401);
  assert.equal((await worker.fetch(post(operator, env.ALLOWED_ORIGIN), env)).status, 403);
  assert.equal((await worker.fetch(post(admin), env)).status, 403);
  assert.equal((await worker.fetch(post(admin, "https://untrusted.example.test"), env)).status, 403);
  assert.equal((await worker.fetch(post(admin, env.ALLOWED_ORIGIN, []), env)).status, 400);
  assert.equal(database.batches.length, 0);
  const response = await worker.fetch(post(admin, env.ALLOWED_ORIGIN), env);
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(database.batches.at(-1)?.some(call => call.sql.includes("scan-review-admin")));
  assert.equal(database.batches.at(-1)?.some(call => /attendance_events|attendance_corrections/.test(call.sql)), false);
  const before = database.batches.length;
  database.rows.set("SELECT m.generation FROM users u", null);
  assert.equal((await worker.fetch(post(admin, env.ALLOWED_ORIGIN), env)).status, 403);
  assert.equal(database.batches.length, before);
});

test("retained scan upload binds authority to the authenticated kiosk and rejects disabled or malformed requests", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const record = { eventId: "synthetic-scan", memberId: "synthetic-member", occurredAt: "2020-01-01T07:00:00Z", reasonCode: "clock_unverified", httpStatus: null, reviewStatus: "open" };
  const upload = (body: unknown = { records: [record] }, token?: string) => new Request("https://api.example.test/kiosk/scan-reviews", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(upload(), env)).status, 401);
  assert.equal((await worker.fetch(upload(undefined, "invalid"), env)).status, 401);
  database.rows.set("FROM kiosks WHERE", { id: "kiosk-a", name: "Synthetic kiosk", pairingId: "pair-a", pairingBound: 1 });
  assert.equal((await worker.fetch(upload({ records: [{ ...record, fingerprint: "forbidden" }] }, "paired-token"), env)).status, 400);
  assert.equal((await worker.fetch(upload({ records: [record], kioskId: "other-kiosk" }, "paired-token"), env)).status, 400);
  assert.equal(database.batches.length, 0);
  database.lists.set("SELECT r.event_id AS eventId,r.review_status AS reviewStatus", [{ eventId: "synthetic-scan", reviewStatus: "reviewed" }]);
  const result = await worker.fetch(upload(undefined, "paired-token"), env); assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(await result.json(), { reviews: [{ eventId: "synthetic-scan", reviewStatus: "reviewed" }] });
  const transaction = database.batches.at(-1)!;
  assert.ok(transaction.some(call => call.sql.includes("token_hash=?") && call.values.includes(createHash("sha256").update("paired-token").digest("base64url"))));
  assert.ok(transaction.some(call => call.sql.includes("INSERT INTO kiosk_scan_reviews") && call.values[0] === "kiosk-a"));
  assert.equal(transaction.some(call => /attendance_events|attendance_corrections/.test(call.sql)), false);
  database.rows.set("SELECT m.generation FROM platform_modules m", null);
  const before = database.batches.length;
  assert.equal((await worker.fetch(upload(undefined, "paired-token"), env)).status, 409);
  assert.equal(database.batches.length, before);
});

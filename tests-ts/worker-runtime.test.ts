import test from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";

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
  user?: { id: string; role: "admin" | "operator"; passwordHash: string | null };
  rows = new Map<string, unknown>();
  lists = new Map<string, unknown[]>();
  prepare(sql: string) { return new FakeStatement(sql, this); }
  async batch(statements: FakeStatement[]) { this.batches.push(statements); return statements.map(() => ({ success: true })); }
  firstResult(sql: string, _values: unknown[]) {
    if (sql.includes("FROM users")) return this.user;
    for (const [fragment, value] of this.rows) if (sql.includes(fragment)) return value;
    return undefined;
  }
  allResult(sql: string, _values: unknown[]) { for (const [fragment, value] of this.lists) if (sql.includes(fragment)) return value; return undefined; }
}

const request = (path: string, body?: unknown, options: { method?: string; cookie?: string } = {}) => new Request(`https://api.example.test${path}`, {
  method: options.method ?? (body ? "POST" : "GET"),
  headers: { ...(body ? { "content-type": "application/json" } : {}), ...(options.cookie ? { cookie: options.cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const sessionSecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sessionCookie = async (role: "admin" | "operator") => `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: `${role}-1`, role })}`;

test("Worker bootstrap validates input before writing D1", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example" }), env);
  assert.equal(result.status, 400);
  assert.equal(database.batches.length, 0);
});

test("Worker bootstrap creates one Admin and four audited records", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example Arts Club", timeZone: "America/New_York", authMode: "local", localUsername: "director", localPassword: "correct horse battery staple", telemetryAccepted: false }), env);
  assert.equal(result.status, 201);
  assert.equal(database.batches.length, 1);
  assert.equal(database.batches[0].length, 4);
  const userInsert = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO users"));
  assert.match(String(userInsert?.values[4]), /^scrypt\$/);
  assert.equal((await result.json() as { telemetryAccepted: boolean }).telemetryAccepted, false);
});

test("protected setup routes reject anonymous and Operator access", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/admin/branding"), env)).status, 401);
  assert.equal((await worker.fetch(request("/admin/branding", undefined, { cookie: await sessionCookie("operator") }), env)).status, 403);
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
  const body = await result.json() as { code: string };
  const insert = database.batches.at(-1)?.find((statement) => statement.sql.includes("INSERT INTO pairing_codes"));
  assert.ok(insert);
  assert.notEqual(insert.values[1], body.code);
  assert.match(String(insert.values[1]), /^[A-Za-z0-9_-]{43}$/);
});

test("kiosk heartbeat hashes bearer credentials before D1 lookup", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const heartbeat = new Request("https://api.example.test/kiosk/heartbeat", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ readerOnline: true, releaseVersion: "0.1.0" }) });
  const result = await worker.fetch(heartbeat, env);
  assert.equal(result.status, 200);
  const lookup = database.calls.find((call) => call.sql.includes("FROM kiosks"));
  assert.ok(lookup);
  assert.notEqual(lookup.values[0], "very-secret");
  assert.ok(database.calls.some((call) => call.sql.includes("UPDATE kiosks SET last_seen_at")));
});

test("Operator can create meetings and reasoned attendance corrections", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const operator = await sessionCookie("operator");
  const meeting = await worker.fetch(request("/meetings", { title: "Rehearsal", startsAt: "2026-09-01T20:00:00.000Z", required: true }, { cookie: operator }), env);
  assert.equal(meeting.status, 201);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("meeting.created")));
  const corrected = await worker.fetch(request("/attendance/corrections", { memberId: "member-1", meetingId: "meeting-1", disposition: "excused", reason: "School event" }, { cookie: operator }), env);
  assert.equal(corrected.status, 201);
  assert.ok(database.batches.at(-1)?.some((call) => call.sql.includes("attendance.corrected")));
});

test("kiosk attendance is installation-scoped and idempotent by event ID", async () => {
  const database = new FakeDatabase();
  database.rows.set("FROM kiosks", { id: "kiosk-1", name: "Front desk" });
  database.rows.set("FROM members", { id: "member-1" });
  database.rows.set("FROM meetings", { id: "meeting-1" });
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  const attendanceRequest = new Request("https://api.example.test/kiosk/attendance", { method: "POST", headers: { authorization: "Bearer very-secret", "content-type": "application/json" }, body: JSON.stringify({ eventId: "offline-event-1", memberId: "member-1", meetingId: "meeting-1", occurredAt: "2026-09-01T20:02:00.000Z" }) });
  const result = await worker.fetch(attendanceRequest, env);
  assert.equal(result.status, 202);
  const insert = database.calls.find((call) => call.sql.includes("INSERT OR IGNORE INTO attendance_events"));
  assert.ok(insert);
  assert.ok(insert.sql.includes("installation_id"));
  assert.ok(insert.values.includes("offline-event-1"));
});

test("attendance export is an authenticated CSV download", async () => {
  const database = new FakeDatabase();
  database.lists.set("FROM meetings mt", [{ meeting: "Studio, weekly", meetingStart: "2026-09-01T20:00:00Z", memberId: "A-1", firstName: "Avery", lastName: "Stone", disposition: "present", occurredAt: "2026-09-01T20:02:00Z", reason: null }]);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, DB: database } as unknown as Env;
  assert.equal((await worker.fetch(request("/exports/attendance.csv"), env)).status, 401);
  const result = await worker.fetch(request("/exports/attendance.csv", undefined, { cookie: await sessionCookie("operator") }), env);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(await result.text(), /"Studio, weekly"/);
});

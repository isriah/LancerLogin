// quick-check: covers apps/api/src/scan-refusal.ts
// Why a kiosk scan is refused when nothing is wrong with the scan: the reason the Worker adds to its refusal body, the
// installation's local day that decides "today", and the unchanged status, error text and code older kiosks rely on.
// The Worker cases run on a real migrated SQLite database. All data is synthetic.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { notStartedYetRefusal, scanRefusalDate, scanRefusalTime, scanWindowRefusal } from "../apps/api/src/scan-refusal.ts";
import { applyCoreMigrations } from "./fixtures/d1-database.ts";

const secret = "A".repeat(43);
const newYork = "America/New_York";
// 6:00 PM to 8:00 PM on 18 November in New York (UTC-5): scans open at 5:45 PM and close at 8:30 PM.
const evening = { title: "Test Evening Build", startsAt: "2026-11-18T23:00:00.000Z", endsAt: "2026-11-19T01:00:00.000Z" };

test("a meeting later today that has not opened is too early, with the time scans open in the installation's time zone", () => {
  assert.deepEqual(scanWindowRefusal([evening], "2026-11-18T20:00:00.000Z", newYork, 30, 15), { reason: "too_early", meetingTitle: "Test Evening Build", at: "2026-11-18T22:45:00.000Z", time: "5:45 PM" });
  assert.deepEqual(scanWindowRefusal([evening], "2026-11-18T22:44:59.000Z", newYork, 30, 15).reason, "too_early", "one second before the window opens");
  assert.equal(scanWindowRefusal([evening], "2026-11-18T20:00:00.000Z", "UTC", 30, 15).reason === "too_early" && scanRefusalTime("2026-11-18T22:45:00.000Z", "UTC"), "10:45 PM", "the same instant reads differently in another zone");
  assert.equal(scanWindowRefusal([evening], "2026-11-18T20:00:00.000Z", newYork, 30, 0).reason === "too_early" && scanRefusalTime(evening.startsAt, newYork), "6:00 PM", "no early allowance: scans open at the start");
});

test("a meeting that ended today with its late window closed is ended, with the time scans closed", () => {
  // 9:00 PM in New York is already 19 November in UTC: the local day decides.
  assert.deepEqual(scanWindowRefusal([evening], "2026-11-19T02:00:00.000Z", newYork, 30, 15), { reason: "meeting_ended", meetingTitle: "Test Evening Build", at: "2026-11-19T01:30:00.000Z", time: "8:30 PM" });
  assert.equal(scanWindowRefusal([evening], "2026-11-19T04:59:59.000Z", newYork, 30, 15).reason, "meeting_ended", "11:59 PM, the last second of the local day");
  assert.deepEqual(scanWindowRefusal([evening], "2026-11-19T05:00:00.000Z", newYork, 30, 15), { reason: "no_meeting_today" }, "local midnight: yesterday's meeting is no longer today");
});

test("an upcoming meeting today wins over one that ended today", () => {
  const morning = { title: "Test Morning Build", startsAt: "2026-11-18T14:00:00.000Z", endsAt: "2026-11-18T16:00:00.000Z" };
  assert.deepEqual(scanWindowRefusal([morning, evening], "2026-11-18T19:00:00.000Z", newYork, 30, 15), { reason: "too_early", meetingTitle: "Test Evening Build", at: "2026-11-18T22:45:00.000Z", time: "5:45 PM" });
  assert.equal(scanWindowRefusal([evening, morning], "2026-11-18T19:00:00.000Z", newYork, 30, 15).reason, "too_early", "whatever order the meetings come in");
  assert.equal(scanWindowRefusal([morning], "2026-11-18T19:00:00.000Z", newYork, 30, 15).reason, "meeting_ended");
});

test("meetings on other local days mean no meeting today, on either side of local midnight", () => {
  // Starts at 12:30 AM on 19 November in New York; scans open at 12:15 AM.
  const afterMidnight = { title: "Test Late Build", startsAt: "2026-11-19T05:30:00.000Z", endsAt: "2026-11-19T07:00:00.000Z" };
  assert.deepEqual(scanWindowRefusal([afterMidnight], "2026-11-19T04:55:00.000Z", newYork, 30, 15), { reason: "no_meeting_today" }, "11:55 PM the day before: tomorrow's meeting");
  assert.deepEqual(scanWindowRefusal([afterMidnight], "2026-11-19T05:05:00.000Z", newYork, 30, 15), { reason: "too_early", meetingTitle: "Test Late Build", at: "2026-11-19T05:15:00.000Z", time: "12:15 AM" }, "12:05 AM: now it is today's");
  // The same instants in UTC are all 19 November, so UTC installations call both scans too early.
  assert.equal(scanWindowRefusal([afterMidnight], "2026-11-19T04:55:00.000Z", "UTC", 30, 15).reason, "too_early");
  // A meeting that runs past midnight ended today even though it started yesterday.
  const overnight = { title: "Test Overnight Build", startsAt: "2026-11-19T03:00:00.000Z", endsAt: "2026-11-19T05:30:00.000Z" };
  assert.deepEqual(scanWindowRefusal([overnight], "2026-11-19T06:30:00.000Z", newYork, 30, 15), { reason: "meeting_ended", meetingTitle: "Test Overnight Build", at: "2026-11-19T06:00:00.000Z", time: "1:00 AM" });
  assert.deepEqual(scanWindowRefusal([], "2026-11-18T20:00:00.000Z", newYork), { reason: "no_meeting_today" });
  const nextWeek = { title: "Test Next Week", startsAt: "2026-11-25T23:00:00.000Z", endsAt: "2026-11-26T01:00:00.000Z" };
  const lastWeek = { title: "Test Last Week", startsAt: "2026-11-11T23:00:00.000Z", endsAt: "2026-11-12T01:00:00.000Z" };
  assert.deepEqual(scanWindowRefusal([lastWeek, nextWeek], "2026-11-18T20:00:00.000Z", newYork), { reason: "no_meeting_today" });
});

test("times and dates are display ready, and a time zone Intl refuses falls back to UTC", () => {
  assert.equal(scanRefusalTime("2026-11-18T17:05:00.000Z", "America/Los_Angeles"), "9:05 AM");
  assert.doesNotMatch(scanRefusalTime("2026-11-18T17:05:00.000Z", "UTC"), /[  ]/, "a plain space before AM or PM");
  assert.equal(scanRefusalDate("2026-12-01"), "Dec 1, 2026");
  assert.equal(scanRefusalDate("soon"), "soon");
  assert.deepEqual(notStartedYetRefusal("2026-12-01"), { reason: "not_started_yet", startsOn: "2026-12-01", date: "Dec 1, 2026" });
  assert.deepEqual(scanWindowRefusal([evening], "2026-11-18T20:00:00.000Z", "Not/AZone", 30, 15), { reason: "too_early", meetingTitle: "Test Evening Build", at: "2026-11-18T22:45:00.000Z", time: "10:45 PM" });
  assert.equal(scanWindowRefusal([evening], "2026-11-18T20:00:00.000Z", null, 30, 15).reason, "too_early");
});

test("the Worker adds the reason to a refused kiosk scan and keeps its status, error text and code", async (context) => {
  const { scan, database } = await fixture(context);
  const body = async (response: Response) => { assert.equal(response.status, 409, await response.clone().text()); return response.json(); };

  // 3:00 PM in New York: the evening meeting has not opened.
  assert.deepEqual(await body(await scan("SYN-001", "early", "2026-11-18T20:00:00.000Z")), {
    error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting",
    reason: "too_early", meetingTitle: "Test Evening Build", at: "2026-11-18T22:45:00.000Z", time: "5:45 PM",
  });
  // 9:00 PM: scans closed at 8:30 PM.
  assert.deepEqual(await body(await scan("SYN-001", "closed", "2026-11-19T02:00:00.000Z")), {
    error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting",
    reason: "meeting_ended", meetingTitle: "Test Evening Build", at: "2026-11-19T01:30:00.000Z", time: "8:30 PM",
  });
  // 12:10 AM the next local day, and a day with nothing before the first meeting.
  const none = { error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting", reason: "no_meeting_today" };
  assert.deepEqual(await body(await scan("SYN-001", "next-day", "2026-11-19T05:10:00.000Z")), none);
  assert.deepEqual(await body(await scan("SYN-001", "before-any", "2026-11-10T20:00:00.000Z")), none);

  // A member whose attendance starts later: the existing text, with the day ready to show.
  assert.deepEqual(await body(await scan("SYN-003", "not-yet", "2026-11-18T23:10:00.000Z")), {
    error: "Attendance for Test Student begins on 2026-12-01", code: "participation_not_started",
    reason: "not_started_yet", startsOn: "2026-12-01", date: "Dec 1, 2026",
  });

  // Arrived and left: a third scan is refused as already done.
  assert.equal((await scan("SYN-001", "arrive", "2026-11-18T23:00:00.000Z")).status, 202);
  assert.equal((await scan("SYN-001", "leave", "2026-11-19T00:30:00.000Z")).status, 202);
  assert.deepEqual(await body(await scan("SYN-001", "again", "2026-11-19T00:40:00.000Z")), {
    error: "Attendance is already complete for this member and meeting", code: "attendance_complete", reason: "already_done",
  });

  // A scan with a chosen meeting reads that meeting only, so it gets no window reason.
  assert.deepEqual(await body(await scan("SYN-002", "chosen", "2026-11-18T20:00:00.000Z", "evening")), { error: "This meeting has not started", code: "scan_window_closed" });
  // A member the roster does not have is a scan problem: no reason.
  const unknown = await scan("SYN-404", "unknown", "2026-11-18T23:10:00.000Z");
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "This identity is not linked to an active roster member", code: "roster_inactive" });
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM attendance_events").get()?.n, 2, "refused scans record nothing");
});

test("a refused scan reads nothing an accepted scan does not: the reason comes from rows already loaded", async (context) => {
  const { scan, database } = await fixture(context);
  const statements = async (run: () => Promise<Response>, status: number) => {
    const before = database.executed.length; const response = await run();
    assert.equal(response.status, status, await response.clone().text());
    return database.executed.slice(before);
  };
  const accepted = await statements(() => scan("SYN-001", "arrive", "2026-11-18T23:00:00.000Z"), 202);
  for (const occurredAt of ["2026-11-18T20:00:00.000Z", "2026-11-19T02:00:00.000Z", "2026-11-19T05:10:00.000Z"]) {
    const refused = await statements(() => scan("SYN-002", `refused-${occurredAt}`, occurredAt), 409);
    assert.ok(refused.length < accepted.length, `${refused.length} statements for a refusal, ${accepted.length} for an accepted scan`);
    assert.deepEqual(refused.filter((sql) => !accepted.includes(sql)), [], "no statement of its own");
    assert.equal(refused.filter((sql) => /FROM organization_settings/.test(sql)).length, 1, "one settings read: allowances and time zone together");
    assert.equal(refused.filter((sql) => /FROM \(SELECT id, title, starts_at/.test(sql)).length, 1, "one meeting read");
  }
});

async function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-19T06:00:00Z") });
  context.mock.method(globalThis, "fetch", () => { throw new Error("No live provider access is permitted in this fixture"); });
  const database = new Database(); context.after(() => database.sqlite.close());
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database } as unknown as Env;
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const call = (path: string, body?: unknown, method?: string, token?: string) => worker.fetch(new Request(`https://api.example.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }), ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const created = await call("/admin/pairing-codes", { kioskName: "Test Front Kiosk" }); assert.equal(created.status, 201);
  const paired = await call("/kiosk/pair", { code: (await created.json() as { code: string }).code, kioskName: "Test Front Kiosk" }); assert.equal(paired.status, 201);
  const kiosk = await paired.json() as { kioskToken: string; pairingId: string };
  const scan = (memberId: string, eventId: string, occurredAt: string, meetingId?: string) => call("/kiosk/attendance", { memberId, eventId, occurredAt, pairingId: kiosk.pairingId, ...(meetingId ? { meetingId } : {}) }, "POST", kiosk.kioskToken);
  return { database, call, scan };
}

// Real SQLite with D1's atomic batch semantics, migrated from apps/api/migrations. `executed` lists every statement run.
type Statement = { execute(): unknown };
class Database {
  sqlite = new DatabaseSync(":memory:");
  executed: string[] = [];
  constructor() {
    applyCoreMigrations(this.sqlite);
    this.sqlite.exec(`
      INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','America/New_York');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('member','primary','SYN-001','Test Student','A','student.a@example.test','2026-01-01');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('member-b','primary','SYN-002','Test Student','B','student.b@example.test','2026-01-01');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at,attendance_required_from) VALUES ('member-c','primary','SYN-003','Test Student','C','student.c@example.test','2026-01-01','2026-12-01');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('evening','primary','Test Evening Build','2026-11-18T23:00:00.000Z','2026-11-19T01:00:00.000Z','admin','2026-01-01');
    `);
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    return {
      bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { database.executed.push(sql); return (database.sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { database.executed.push(sql); return { results: database.sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() { return this.execute(); },
      execute() {
        database.executed.push(sql);
        const query = database.sqlite.prepare(sql);
        const before = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        const results = query.columns().length ? query.all(...params as []) : (query.run(...params as []), []);
        const after = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        return { success: true, results, meta: { changes: after - before } };
      },
    };
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec("COMMIT"); return result; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}

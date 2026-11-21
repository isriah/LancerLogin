// quick-check: covers apps/api/migrations/**
// Check-then-act races (database-access audit finding 16): a route reads, decides, then writes in a later statement, so two
// requests at once can both pass the check. Each test holds the write of both requests until both have reached it, the
// interleaving two concurrent requests can take on D1, and expects what two requests one after the other give: the loser
// gets the answer a sequential replay of its request gets. All data is synthetic.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { BackupDatabase, sessionSecret } from "./fixtures/backup-database.ts";
import { Statement } from "./fixtures/d1-database.ts";
import { overlappingMeetingWindows } from "../apps/api/src/attendance-lifecycle.ts";
import { isMeetingOverlapAbort, meetingOverlapGuard } from "../apps/api/src/meeting-overlap-guard.ts";

type Hold = { pattern: RegExp; size: number; waiting: (() => void)[]; arrived: number };

/** A statement whose run() waits at the database's hold, like a batch does. */
class HeldStatement extends Statement {
  readonly owner: RacingDatabase;
  constructor(owner: RacingDatabase, sql: string, values: unknown[] = []) { super(owner.sqlite, sql, values, () => { owner.reads += 1; }); this.owner = owner; }
  override bind(...values: unknown[]) { return new HeldStatement(this.owner, this.sql, values); }
  override async run() { await this.owner.gate([this.sql]); return super.run(); }
}

/**
 * The backup tests' installation, where every write matching a held pattern waits until `size` of them have arrived (or a
 * second has passed) and then runs in arrival order. Both requests have then made every read their check needs.
 */
class RacingDatabase extends BackupDatabase {
  private hold: Hold | undefined;
  holdWrites(pattern: RegExp, size = 2): Hold { this.hold = { pattern, size, waiting: [], arrived: 0 }; return this.hold; }
  async gate(sqls: string[]) {
    const hold = this.hold;
    if (!hold || !sqls.some((sql) => hold.pattern.test(sql))) return;
    hold.arrived += 1;
    await new Promise<void>((resolve) => {
      hold.waiting.push(resolve);
      const release = () => { if (this.hold === hold) this.hold = undefined; for (const next of hold.waiting.splice(0)) next(); };
      if (hold.waiting.length >= hold.size) release(); else setTimeout(release, 5000);
    });
  }
  override prepare(sql: string) { return new HeldStatement(this, sql); }
  override async batch(statements: Parameters<BackupDatabase["batch"]>[0]) { await this.gate(statements.map((statement) => (statement as Statement).sql)); return super.batch(statements); }
}

async function fixture(context: TestContext) {
  context.mock.method(globalThis, "fetch", () => { throw new Error("No live provider access is permitted in this fixture"); });
  const db = new RacingDatabase(); context.after(() => db.close());
  db.raw.exec(`UPDATE organization_settings SET time_zone = 'UTC', late_scan_minutes = 30, early_scan_minutes = 15;
    INSERT INTO member_labels(id,installation_id,name,active,created_at) VALUES ('test-label-a','primary','Test Label A',1,'2026-01-01');`);
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" } as unknown as Env;
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  await worker.fetch(new Request("https://fixture.test/health"), env);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token?: string) => worker.fetch(new Request(`https://fixture.test${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : { cookie }), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  /**
   * Both requests at once, their matching writes held until both arrive. Either may reach the write first, so the result
   * names the one that lost (the one refused, or the second when neither is) with the response each got.
   */
  const race = async (pattern: RegExp, first: () => Promise<Response>, second: () => Promise<Response>) => {
    const hold = db.holdWrites(pattern);
    const responses = await Promise.all([first(), second()]);
    assert.equal(hold.arrived, 2, "both requests passed their check and reached the write before either wrote");
    const results = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() as Record<string, unknown> })));
    const refused = results.findIndex((result) => result.status >= 300); const loser = refused === -1 ? 1 : refused;
    return { loser, won: results[1 - loser]!, lost: results[loser]! };
  };
  const answer = async (response: Promise<Response>) => { const result = await response; return { status: result.status, body: await result.json() as Record<string, unknown> }; };
  return { db, call, race, answer };
}

const day = 86_400_000;
const at = (days: number, hour: number, minute = 0) => { const date = new Date(Date.now() + days * day); date.setUTCHours(hour, minute, 0, 0); return date.toISOString(); };
const live = (db: RacingDatabase) => db.rows<{ title: string; startsAt: string }>("SELECT title, starts_at AS startsAt FROM meetings WHERE deleted_at IS NULL ORDER BY starts_at, title");

test("a. two overlapping meetings created at once: one is saved, the other gets the editor's overlap error", async (context) => {
  const { db, call, race, answer } = await fixture(context);
  const build = { title: "Test Build Session", startsAt: at(10, 18), endsAt: at(10, 20) };
  const drive = { title: "Test Drive Practice", startsAt: at(10, 19), endsAt: at(10, 21) };
  const bodies = [build, drive]; const { loser, won, lost } = await race(/^INSERT INTO meetings /, () => call("/meetings", build), () => call("/meetings", drive));
  assert.equal(won.status, 201, JSON.stringify(won.body));
  assert.deepEqual(live(db).map((meeting) => meeting.title), [bodies[1 - loser]!.title], "the other meeting was not saved over the first one's window");
  assert.deepEqual(lost, await answer(call("/meetings", bodies[loser])), "the loser gets what a sequential request gets");
  assert.equal(lost.status, 409); assert.match(String(lost.body.error), /^Meeting attendance windows cannot overlap\. /);
});

test("a. two meetings rescheduled at once into each other's window: one move is saved, the other is refused", async (context) => {
  const { db, call, race, answer } = await fixture(context);
  const created = await Promise.all([{ title: "Test Meeting X", startsAt: at(10, 10), endsAt: at(10, 11) }, { title: "Test Meeting Y", startsAt: at(12, 10), endsAt: at(12, 11) }].map(async (meeting) => ((await answer(call("/meetings", meeting))).body.meeting as { id: string }).id));
  const moveX = { title: "Test Meeting X", startsAt: at(11, 10), endsAt: at(11, 11) };
  const moveY = { title: "Test Meeting Y", startsAt: at(11, 10, 30), endsAt: at(11, 11, 30) };
  const moves = [moveX, moveY]; const { loser, won, lost } = await race(/^UPDATE meetings SET/, () => call(`/meetings/${created[0]}`, moveX, "PATCH"), () => call(`/meetings/${created[1]}`, moveY, "PATCH"));
  assert.equal(won.status, 200, JSON.stringify(won.body));
  const stayed = loser === 0 ? { title: "Test Meeting X", startsAt: at(10, 10) } : { title: "Test Meeting Y", startsAt: at(12, 10) };
  assert.deepEqual(live(db), [stayed, { title: moves[1 - loser]!.title, startsAt: moves[1 - loser]!.startsAt }].sort((left, right) => left.startsAt.localeCompare(right.startsAt)), "the refused meeting stays where it was");
  assert.deepEqual(lost, await answer(call(`/meetings/${created[loser]}`, moves[loser], "PATCH")));
  assert.equal(lost.status, 409); assert.match(String(lost.body.error), /^Meeting attendance windows cannot overlap\. /);
});

test("a. the write's overlap guard decides as the routes' check does, to the millisecond and across stored offsets", async (context) => {
  const db = new RacingDatabase(); context.after(() => db.close());
  const allowances = { lateScanMinutes: 30, earlyScanMinutes: 15 };
  // Stored before times were canonical: 18:00–19:00 UTC written with an offset. Its window closes at 19:30.
  db.raw.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('test-offset','primary','Test Offset Meeting','2026-12-01T13:00:00-05:00','2026-12-01T14:00:00-05:00','admin','2026-01-01'),
    ('test-deleted','primary','Test Deleted Meeting','2026-12-02T18:00:00.000Z','2026-12-02T19:00:00.000Z','admin','2026-01-01'), ('test-open','primary','Test Open Meeting','2026-12-03T18:00:00.000Z',NULL,'admin','2026-01-01');
    UPDATE meetings SET deleted_at = '2026-11-01' WHERE id = 'test-deleted';`);
  const existing = db.rows<{ id: string; title: string; startsAt: string; endsAt: string }>("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE deleted_at IS NULL AND ends_at IS NOT NULL");
  const cases: [string, string, string, string[]][] = [
    ["opens as the other closes", "2026-12-01T19:45:00.000Z", "2026-12-01T21:00:00.000Z", []],
    ["opens a millisecond after", "2026-12-01T19:45:00.001Z", "2026-12-01T21:00:00.000Z", []],
    ["closes as the other opens", "2026-12-01T16:00:00.000Z", "2026-12-01T17:15:00.000Z", []],
    ["closes a millisecond before", "2026-12-01T16:00:00.000Z", "2026-12-01T17:14:59.999Z", []],
    ["inside, the meeting itself excluded", "2026-12-01T18:10:00.000Z", "2026-12-01T18:50:00.000Z", ["test-offset"]],
    ["over a deleted meeting", "2026-12-02T18:00:00.000Z", "2026-12-02T19:00:00.000Z", []],
    ["over a meeting with no end", "2026-12-03T18:00:00.000Z", "2026-12-03T19:00:00.000Z", []],
  ];
  const refused: boolean[] = [];
  for (const [name, startsAt, endsAt, excluded] of cases) {
    const proposed = { id: "proposed", title: "Test Proposed", startsAt, endsAt };
    const routeRefuses = Boolean(overlappingMeetingWindows([...existing.filter((meeting) => !excluded.includes(meeting.id)), proposed], allowances.lateScanMinutes, allowances.earlyScanMinutes, (meeting) => meeting === proposed));
    const guardRefuses = await db.batch([meetingOverlapGuard(db, [proposed], allowances, excluded)!]).then(() => false, (error) => { assert.ok(isMeetingOverlapAbort(error), String(error)); return true; });
    assert.equal(guardRefuses, routeRefuses, name); refused.push(guardRefuses);
  }
  assert.deepEqual(refused, [true, false, true, false, false, false, false], "windows that touch overlap, as overlappingMeetingWindows decides");
});

test("b. the same CSV import committed twice at once adds its meetings once", async (context) => {
  const { db, call, race, answer } = await fixture(context);
  const date = at(9, 0).slice(0, 10); const usDate = `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
  const body = { dryRun: false, rows: [
    { rowNumber: 2, values: { title: "Test Imported Build", date: usDate, startTime: "18:00", endTime: "20:00", audience: "" } },
    { rowNumber: 3, values: { title: "Test Imported Review", date: usDate, startTime: "08:00", endTime: "09:00", audience: "" } },
  ] };
  const { won, lost } = await race(/^INSERT INTO meetings /, () => call("/meetings/import", body), () => call("/meetings/import", body));
  assert.equal(won.status, 200, JSON.stringify(won.body));
  assert.deepEqual(live(db).map((meeting) => meeting.title), ["Test Imported Review", "Test Imported Build"], "each row's meeting exists once");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'meetings.imported'"), 1);
  assert.deepEqual(lost, await answer(call("/meetings/import", body)), "the second commit answers as a commit sent after the first does");
  assert.equal(lost.status, 400); assert.equal(lost.body.error, "No rows can be imported. Fix the file and preview again");
});

test("c. a kiosk asking twice at once for the same member's PIN setup gets one pending request", async (context) => {
  const { db, call, race, answer } = await fixture(context);
  const code = await answer(call("/admin/pairing-codes", { kioskName: "Test Kiosk A" })); assert.equal(code.status, 201);
  const paired = await answer(call("/kiosk/pair", { code: code.body.code, kioskName: "Test Kiosk A" })); assert.equal(paired.status, 201);
  const { kioskId, kioskToken } = paired.body as { kioskId: string; kioskToken: string };
  assert.equal((await call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.1.0-beta.3" }, "POST", kioskToken)).status, 200);
  assert.equal((await call(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", requirePin: true }, "PATCH")).status, 200);
  const ask = () => call("/kiosk/pin-requests", { memberId: "001" }, "POST", kioskToken);
  const { won: first, lost: second } = await race(/^INSERT INTO pin_setup_requests /, ask, ask);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(db.count("SELECT COUNT(*) AS n FROM pin_setup_requests WHERE status = 'pending'"), 1, "one request for an Operator to approve");
  assert.deepEqual(second, first, "both asks are answered with the one pending request");
  assert.deepEqual(await answer(ask()), first, "as a sequential ask is");
});

test("d. two overlapping weekly targets for a label at once: one is saved, the other gets the route's 409", async (context) => {
  const { db, call, race, answer } = await fixture(context);
  const winter = { labelId: "test-label-a", startsOn: "2027-01-01", endsOn: "2027-02-01", meetingsPerWeek: 2 };
  const spring = { labelId: "test-label-a", startsOn: "2027-01-15", endsOn: "2027-03-01", meetingsPerWeek: 3 };
  const periods = [winter, spring]; const { loser, won, lost } = await race(/^INSERT INTO label_attendance_rules /, () => call("/labels/targets", winter), () => call("/labels/targets", spring));
  assert.equal(won.status, 201, JSON.stringify(won.body));
  assert.equal(db.count("SELECT COUNT(*) AS n FROM label_attendance_rules"), 1, "migration 0031's trigger never let the second period in");
  assert.deepEqual(lost, await answer(call("/labels/targets", periods[loser])));
  assert.equal(lost.status, 409); assert.equal(lost.body.error, "Weekly target periods cannot overlap");
});

test("d. two default attendance rules for a label applied at once: one is saved, the other gets the policy's 409", async (context) => {
  const { db, call, race, answer } = await fixture(context);
  const rule = (thresholdPercent: number) => ({ labelId: "test-label-a", ruleType: "weighted_percentage", thresholdPercent });
  const preview = async (thresholdPercent: number) => { const result = await answer(call("/attendance/policy/preview", { rule: rule(thresholdPercent) })); assert.equal(result.status, 200, JSON.stringify(result.body)); return { rule: rule(thresholdPercent), previewToken: result.body.previewToken }; };
  const [sixty, seventy] = [await preview(60), await preview(70)];
  const applies = [sixty, seventy]; const { loser, won, lost } = await race(/^INSERT INTO label_attendance_rules /, () => call("/attendance/policy/apply", sixty), () => call("/attendance/policy/apply", seventy));
  assert.equal(won.status, 200, JSON.stringify(won.body));
  assert.equal(db.count("SELECT COUNT(*) AS n FROM label_attendance_rules"), 1, "the partial unique index keeps one default rule per label");
  assert.deepEqual(lost, await answer(call("/attendance/policy/apply", applies[loser])));
  assert.equal(lost.status, 409); assert.equal(lost.body.error, "Attendance rule periods cannot overlap");
});

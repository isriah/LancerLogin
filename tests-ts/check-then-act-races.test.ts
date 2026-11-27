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
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { newlyOverlappingMeetingWindows, overlappingMeetingWindows } from "../apps/api/src/attendance-lifecycle.ts";
import { allowanceChangeGuard, isAllowanceOverlapAbort, isMeetingOverlapAbort, meetingOverlapGuard } from "../apps/api/src/meeting-overlap-guard.ts";

type Hold = { pattern: RegExp; size: number; waiting: (() => void)[]; arrived: number; release: () => void };

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
  /** With `size` Infinity the matching write waits until the test calls the hold's release(). */
  holdWrites(pattern: RegExp, size = 2): Hold {
    const hold: Hold = { pattern, size, waiting: [], arrived: 0, release: () => { if (this.hold === hold) this.hold = undefined; for (const next of hold.waiting.splice(0)) next(); } };
    return this.hold = hold;
  }
  async gate(sqls: string[]) {
    const hold = this.hold;
    if (!hold || !sqls.some((sql) => hold.pattern.test(sql))) return;
    hold.arrived += 1;
    await new Promise<void>((resolve) => {
      hold.waiting.push(resolve);
      if (hold.waiting.length >= hold.size) hold.release(); else if (Number.isFinite(hold.size)) setTimeout(hold.release, 5000);
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
  /**
   * `held` passes its check and waits at its matching write; `between` then runs from start to finish; `held` is let go.
   * The order a slow request and a quick one take when the quick one's write lands between the slow one's read and write.
   */
  const interleave = async (pattern: RegExp, held: () => Promise<Response>, between: () => Promise<Response>) => {
    const hold = db.holdWrites(pattern, Infinity); const pending = answer(held());
    for (let turn = 0; hold.arrived < 1 && turn < 2000; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hold.arrived, 1, "the held request passed its check and reached its write");
    const quick = await answer(between()); hold.release();
    return { quick, slow: await pending };
  };
  return { db, call, race, answer, interleave };
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
    const guardRefuses = await db.batch([meetingOverlapGuard(db, [proposed], excluded)!]).then(() => false, (error) => { assert.ok(isMeetingOverlapAbort(error), String(error)); return true; });
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

// e. Scan allowances changed while a meeting is saved (pre-stable ledger N8). The meeting routes read the allowances, then
// check, then write; the allowance routes read the meetings, then check, then write. Whichever write lands between the
// other's check and write used to be invisible to it, leaving two meetings whose attendance windows overlap under the saved
// allowances. Test Build Session ends at 19:00 and Test Drive Practice starts at 20:00: an hour apart, clear of each other
// with the fixture's 30 + 15 minutes, overlapping once late scans run for 60.
const buildSession = () => ({ title: "Test Build Session", startsAt: at(10, 18), endsAt: at(10, 19) });
const drivePractice = () => ({ title: "Test Drive Practice", startsAt: at(10, 20), endsAt: at(10, 21) });
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
type Racing = Awaited<ReturnType<typeof fixture>>;
const savedAllowances = (db: RacingDatabase) => db.rows<{ lateScanMinutes: number; earlyScanMinutes: number }>("SELECT late_scan_minutes AS lateScanMinutes, early_scan_minutes AS earlyScanMinutes FROM organization_settings")[0]!;
/** No two live meetings' windows overlap under the allowances now saved: what both routes exist to keep true. */
const assertWindowsApart = (db: RacingDatabase) => {
  const { lateScanMinutes, earlyScanMinutes } = savedAllowances(db);
  const pair = overlappingMeetingWindows(db.rows<{ id: string; title: string; startsAt: string; endsAt: string }>("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE deleted_at IS NULL"), lateScanMinutes, earlyScanMinutes);
  assert.equal(pair, undefined, `with ${lateScanMinutes} + ${earlyScanMinutes} minutes saved, ${pair?.[0].title} and ${pair?.[1].title} overlap`);
};
const brandingSave = async ({ call }: Racing, allowances: { lateScanMinutes: number; earlyScanMinutes?: number }) => {
  const current = await (await call("/admin/branding")).json() as { settings: Record<string, unknown> };
  return () => call("/admin/branding", { ...current.settings, organizationName: "Test Club", primaryColor: "#123456", secondaryColor: "#654321", appearance: "system", logoBackdrop: "auto", discordContestWindowHours: 24, ...allowances }, "PATCH");
};
const setupRulesSave = async ({ call }: Racing, lateScanMinutes: number) => {
  const current = await (await call("/module-setup/attendance/rules")).json() as { values: Record<string, unknown> };
  return () => call("/module-setup/attendance/rules", { values: { ...current.values, lateScanMinutes }, expected: current.values }, "PUT");
};
const allowanceWrite = /^UPDATE organization_settings SET (organization_name|late_scan_minutes)/;

/** Each way a meeting's window is added or moved next to Test Build Session, with the write its batch carries. */
const meetingWrites: { name: string; write: RegExp; prepare: (racing: Racing) => Promise<() => Promise<Response>> }[] = [
  { name: "a meeting created", write: /^INSERT INTO meetings /, prepare: async ({ call }) => () => call("/meetings", drivePractice()) },
  { name: "a meeting rescheduled", write: /^UPDATE meetings SET/, prepare: async ({ call, answer }) => {
    const id = ((await answer(call("/meetings", { ...drivePractice(), startsAt: at(12, 20), endsAt: at(12, 21) }))).body.meeting as { id: string }).id;
    return () => call(`/meetings/${id}`, drivePractice(), "PATCH");
  } },
  { name: "a series rescheduled", write: /^UPDATE meetings SET/, prepare: async ({ call, answer }) => {
    const created = await answer(call("/meetings", { ...drivePractice(), startsAt: at(10, 22), endsAt: at(10, 23), recurrence: { frequency: "weekly", until: at(24, 0).slice(0, 10) } }));
    assert.equal(created.status, 201, JSON.stringify(created.body)); const first = (created.body.meetings as { id: string; seriesId: string }[])[0]!;
    return () => call(`/meeting-series/${first.seriesId}`, { ...drivePractice(), meetingId: first.id }, "PATCH");
  } },
  { name: "a meeting imported", write: /^INSERT INTO meetings /, prepare: async ({ call }) => () => call("/meetings/import", { dryRun: false, rows: [{ rowNumber: 2, values: { title: "Test Drive Practice", date: usDate(at(10, 20)), startTime: "20:00", endTime: "21:00", audience: "" } }] }) },
  { name: "a meeting created in Attendance setup", write: /^INSERT INTO meetings\(/, prepare: async ({ call }) => () => call("/module-setup/attendance/meeting", drivePractice()) },
];
const allowanceWrites: { name: string; prepare: (racing: Racing) => Promise<() => Promise<Response>> }[] = [
  { name: "late scans lengthened in Settings", prepare: (racing) => brandingSave(racing, { lateScanMinutes: 60 }) },
  { name: "early arrival lengthened in Settings", prepare: (racing) => brandingSave(racing, { lateScanMinutes: 30, earlyScanMinutes: 45 }) },
  { name: "late scans lengthened in Attendance setup", prepare: (racing) => setupRulesSave(racing, 60) },
];

for (const meetingWrite of meetingWrites) for (const allowance of allowanceWrites) {
  test(`e. ${allowance.name} between the check and the write of ${meetingWrite.name}: the meeting is refused`, async (context) => {
    const racing = await fixture(context); const { db, call, answer, interleave } = racing;
    assert.equal((await call("/meetings", buildSession())).status, 201);
    const [saveMeeting, saveAllowances] = [await meetingWrite.prepare(racing), await allowance.prepare(racing)];
    const before = live(db);
    const { quick, slow } = await interleave(meetingWrite.write, saveMeeting, saveAllowances);
    assert.equal(quick.status, 200, JSON.stringify(quick.body));
    assertWindowsApart(db);
    assert.deepEqual(live(db), before, "the meeting was not added or moved beside Test Build Session");
    assert.deepEqual(slow, await answer(saveMeeting()), "the meeting write answers as one sent after the allowances were saved");
    // An import whose only row now overlaps has nothing left to import; every other write names the overlap.
    if (meetingWrite.name === "a meeting imported") assert.deepEqual(slow, { status: 400, body: { error: "No rows can be imported. Fix the file and preview again" } });
    else { assert.equal(slow.status, 409, JSON.stringify(slow.body)); assert.match(String(slow.body.error), /overlap/); }
  });

  test(`e. ${meetingWrite.name} between the check and the write of ${allowance.name}: the allowances are refused`, async (context) => {
    const racing = await fixture(context); const { db, call, answer, interleave } = racing;
    assert.equal((await call("/meetings", buildSession())).status, 201);
    const [saveMeeting, saveAllowances] = [await meetingWrite.prepare(racing), await allowance.prepare(racing)];
    const { quick, slow } = await interleave(allowanceWrite, saveAllowances, saveMeeting);
    assert.ok(quick.status === 200 || quick.status === 201, JSON.stringify(quick.body));
    assert.ok(live(db).some((meeting) => meeting.title === "Test Drive Practice" && meeting.startsAt === drivePractice().startsAt), "the meeting was saved");
    assertWindowsApart(db);
    assert.deepEqual(savedAllowances(db), { lateScanMinutes: 30, earlyScanMinutes: 15 }, "the allowances stay as they were");
    assert.equal(slow.status, 409, JSON.stringify(slow.body));
    assert.deepEqual(slow, await answer((await allowance.prepare(racing))()), "the save answers as one sent after the meeting was saved");
    assert.match(String(slow.body.error), /^Meeting attendance windows cannot overlap\. With these allowances, Test Build Session .* conflicts with Test Drive Practice /);
  });
}

test("e. a meeting created and late scans lengthened at once: one is saved, the other is refused as a sequential request is", async (context) => {
  const racing = await fixture(context); const { db, call, race, answer } = racing;
  assert.equal((await call("/meetings", buildSession())).status, 201);
  const saveAllowances = await brandingSave(racing, { lateScanMinutes: 60 }); const saveMeeting = () => call("/meetings", drivePractice());
  const { loser, won, lost } = await race(/^INSERT INTO meetings |^UPDATE organization_settings SET organization_name/, saveMeeting, saveAllowances);
  assert.ok(won.status < 300, JSON.stringify(won.body)); assert.equal(lost.status, 409, JSON.stringify(lost.body));
  assertWindowsApart(db);
  assert.deepEqual(lost, await answer(loser === 0 ? saveMeeting() : saveAllowances()));
});

test("e. shorter or unchanged allowances and unrelated settings still save beside meetings that already overlap", async (context) => {
  const racing = await fixture(context); const { db, call } = racing;
  // Saved before the early arrival allowance: windows 17:45–19:30 and 19:20–21:30 already overlap.
  db.raw.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('test-old-a','primary','Test Old A','${at(10, 18)}','${at(10, 19)}','admin','2026-01-01'), ('test-old-b','primary','Test Old B','${at(10, 19, 35)}','${at(10, 21)}','admin','2026-01-01')`);
  for (const allowances of [{ lateScanMinutes: 30 }, { lateScanMinutes: 60, earlyScanMinutes: 60 }, { lateScanMinutes: 10, earlyScanMinutes: 5 }]) {
    const saved = await (await brandingSave(racing, allowances))(); assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
  }
  assert.deepEqual(savedAllowances(db), { lateScanMinutes: 10, earlyScanMinutes: 5 }, "a pair that already overlapped refuses neither longer nor shorter allowances");
  assert.equal((await call("/meetings", { title: "Test Far Meeting", startsAt: at(20, 18), endsAt: at(20, 19) })).status, 201, "and a meeting clear of every other still saves");
});

test("e. the allowance write's guard decides as the routes' check does, across stored offsets, closed and deleted meetings", async (context) => {
  const db = new RacingDatabase(); context.after(() => db.close());
  const now = Date.parse("2026-12-01T12:00:00.000Z");
  const insert = (id: string, startsAt: string, endsAt: string | null, deleted = false) => db.raw.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at,deleted_at) VALUES (?,'primary',?,?,?,'admin','2026-01-01',?)").run(id, `Test ${id}`, startsAt, endsAt, deleted ? "2026-11-01" : null);
  const decide = async (before: { lateScanMinutes: number; earlyScanMinutes: number }, after: { lateScanMinutes: number; earlyScanMinutes: number | null }) => {
    db.raw.prepare("UPDATE organization_settings SET late_scan_minutes = ?, early_scan_minutes = ?").run(before.lateScanMinutes, before.earlyScanMinutes);
    const meetings = db.rows<{ id: string; title: string; startsAt: string; endsAt: string }>("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE deleted_at IS NULL AND ends_at IS NOT NULL")
      .filter((meeting) => Date.parse(meeting.endsAt) + after.lateScanMinutes * 60_000 >= now);
    const routeRefuses = Boolean(newlyOverlappingMeetingWindows(meetings, before, { lateScanMinutes: after.lateScanMinutes, earlyScanMinutes: after.earlyScanMinutes ?? before.earlyScanMinutes }));
    const guardRefuses = await db.batch([allowanceChangeGuard(db, after, now)]).then(() => false, (error) => { assert.ok(isAllowanceOverlapAbort(error), String(error)); return true; });
    assert.equal(guardRefuses, routeRefuses, JSON.stringify({ before, after })); return guardRefuses;
  };
  const base = { lateScanMinutes: 30, earlyScanMinutes: 15 };
  // 18:00–19:00 UTC stored with an offset, and a meeting exactly 60 minutes after it ends.
  insert("offset", "2026-12-05T13:00:00-05:00", "2026-12-05T14:00:00-05:00"); insert("next", "2026-12-05T20:00:00.000Z", "2026-12-05T21:00:00.000Z");
  assert.equal(await decide(base, { lateScanMinutes: 44, earlyScanMinutes: null }), false, "a minute short of touching");
  assert.equal(await decide(base, { lateScanMinutes: 45, earlyScanMinutes: null }), true, "windows that touch overlap");
  assert.equal(await decide(base, { lateScanMinutes: 30, earlyScanMinutes: 30 }), true, "a longer early arrival allowance alone");
  assert.equal(await decide(base, { lateScanMinutes: 45, earlyScanMinutes: 0 }), false, "the same total reach creates no overlap");
  assert.equal(await decide({ lateScanMinutes: 60, earlyScanMinutes: 15 }, { lateScanMinutes: 120, earlyScanMinutes: null }), false, "a pair that already overlaps is left alone");
  db.raw.exec("DELETE FROM meetings");
  // Ended yesterday, an hour apart: closed under any allowance, so never compared.
  insert("closed-a", "2026-11-30T01:00:00.000Z", "2026-11-30T02:00:00.000Z"); insert("closed-b", "2026-11-30T03:00:00.000Z", "2026-11-30T04:00:00.000Z");
  insert("deleted", "2026-12-05T20:00:00.000Z", "2026-12-05T21:00:00.000Z", true); insert("open", "2026-12-05T18:00:00.000Z", null); insert("alone", "2026-12-05T18:00:00.000Z", "2026-12-05T19:00:00.000Z");
  assert.equal(await decide(base, { lateScanMinutes: 180, earlyScanMinutes: 180 }), false, "closed, deleted and unfinished meetings are not compared");
  // Still inside its late scan window with the longer allowance only: it counts, as the route's check counts it.
  insert("just-ended", "2026-12-01T09:00:00.000Z", "2026-12-01T10:30:00.000Z"); insert("upcoming", "2026-12-01T13:15:00.000Z", "2026-12-01T14:00:00.000Z");
  assert.equal(await decide(base, { lateScanMinutes: 150, earlyScanMinutes: null }), true, "a meeting the longer late window reopens");
  // Each meeting is compared with its neighbours only: the second read of meetings is a search on starts_at, both ends bound.
  const guard = allowanceChangeGuard(db, { lateScanMinutes: 150, earlyScanMinutes: null }, now) as unknown as { sql: string; values: unknown[] };
  const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${guard.sql}`).all(...guard.values as never[]).map((row) => String((row as { detail: string }).detail));
  assert.ok(plan.some((step) => /^SEARCH b USING INDEX \S+ \(.*starts_at>\? AND starts_at<\?\)$/.test(step)), plan.join("; "));
  assert.ok(!plan.some((step) => /^SCAN (a|b)\b/.test(step)), plan.join("; "));
});

// f. Import rows that only update a meeting (notes, attendance, audience: its times stay) add or move no window, so the overlap
// guard does not cover them (a row matches its meeting by title, date and start) and the same file committed twice at once applies them twice (ledger N8). That is harmless
// only if every statement gives the same result the second time.
for (const mapping of ["no Discord event yet", "a removed Discord event"] as const) {
  test(`f. an update-only import committed twice at once for a meeting with ${mapping} leaves one consistent calendar operation`, async (context) => {
    const { db, call, race } = await fixture(context);
    const encrypted = await encryptIntegration({ botToken: "synthetic-token", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
    db.raw.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES ('discord-1','primary','discord',?,?,'2026-01-01','2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
    db.raw.exec(`UPDATE installations SET discord_enabled = 1;
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('test-meeting','primary','Test Build Session','${at(10, 18)}','${at(10, 19)}','admin','2026-01-01');`);
    if (mapping === "a removed Discord event") db.raw.exec("INSERT INTO discord_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,updated_at) VALUES ('primary','test-meeting',NULL,1,0,'2026-01-01')");
    const body = { dryRun: false, actions: { 2: "update" }, rows: [{ rowNumber: 2, values: { title: "Test Build Session", date: usDate(at(10, 18)), startTime: "18:00", endTime: "19:00", audience: "", notes: "Test note: bring safety glasses" } }] };
    const { won, lost } = await race(/^UPDATE meetings SET/, () => call("/meetings/import", body), () => call("/meetings/import", body));
    assert.deepEqual([won.status, lost.status], [200, 200], JSON.stringify([won.body, lost.body]));
    assert.deepEqual(db.rows("SELECT title, notes FROM meetings WHERE deleted_at IS NULL"), [{ title: "Test Build Session", notes: "Test note: bring safety glasses" }]);
    const generation = mapping === "a removed Discord event" ? 2 : 1;
    assert.deepEqual(db.rows("SELECT generation, active FROM discord_calendar_event_mappings WHERE meeting_id = 'test-meeting'"), [{ generation, active: 1 }], "the mapping was added or regenerated once");
    assert.deepEqual(db.rows("SELECT generation, action, status FROM discord_calendar_operations WHERE meeting_id = 'test-meeting'"), [{ generation, action: "upsert", status: "pending" }], "and its one pending operation is for that generation, so the event is delivered");
  });
}

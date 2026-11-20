// quick-check: covers apps/api/migrations/**
// Require PIN and scans queued without a PIN, offline wrong-PIN reports within the Workers Free subrequest limit and
// counted once, and the online PIN throttle under tries sent at the same time.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { PIN_FREE_TRIES } from "../apps/api/src/member-pins.ts";
import type { D1Database, D1Statement } from "../apps/api/src/d1-usage.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";

const secret = "A".repeat(43);
// Cloudflare Workers Free allows 50 subrequests per invocation; each D1 query, or one batch, is one.
const FREE_PLAN_SUBREQUESTS = 50;

/** Real SQLite behind a D1 adapter that counts subrequests as D1 does: one per first(), all() or run(), one per batch. */
function countingDatabase(inner: TestD1Database) {
  const counts = { subrequests: 0, batches: [] as number[] };
  const originals = new WeakMap<D1Statement, D1Statement>();
  const wrap = (statement: D1Statement): D1Statement => {
    const wrapped: D1Statement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: <T>() => { counts.subrequests += 1; return statement.first<T>(); },
      all: <T>() => { counts.subrequests += 1; return statement.all<T>(); },
      run: () => { counts.subrequests += 1; return statement.run(); },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const database: D1Database = {
    prepare: (sql) => wrap(inner.prepare(sql)),
    batch: (statements) => { counts.subrequests += 1; counts.batches.push(statements.length); return inner.batch(statements.map((statement) => originals.get(statement) ?? statement)); },
  };
  return { database, counts };
}

async function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
  context.mock.method(globalThis, "fetch", () => { throw new Error("No live provider access is permitted in this fixture"); });
  const inner = new TestD1Database({ seed: `
    INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
    INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
    INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
    INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
    INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
    INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<230)
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) SELECT 'test-member-'||x,'primary','TEST-'||x,'Test Student',CAST(x AS TEXT),'2026-01-01' FROM n;
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('test-meeting','primary','Test meeting','2026-09-30T11:00:00Z','2026-09-30T13:00:00Z','admin','2026-01-01');` });
  context.after(() => inner.close());
  const { database, counts } = countingDatabase(inner);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database } as unknown as Env;
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const call = (path: string, body?: unknown, token?: string, method?: string) => worker.fetch(new Request(`https://api.example.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }), ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const pair = async (name: string) => {
    const created = await call("/admin/pairing-codes", { kioskName: name }); assert.equal(created.status, 201);
    const paired = await call("/kiosk/pair", { code: (await created.json() as { code: string }).code, kioskName: name }); assert.equal(paired.status, 201);
    const kiosk = await paired.json() as { kioskId: string; kioskToken: string; pairingId: string };
    // Require PIN can be turned on only at a Pi kiosk that reports a release with member PINs.
    assert.equal((await call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.1.0-beta.3" }, kiosk.kioskToken)).status, 200);
    return kiosk;
  };
  const requirePin = async (kioskId: string, on: boolean) => assert.equal((await call(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", requirePin: on }, undefined, "PATCH")).status, 200);
  /** Subrequests one call makes. */
  const counted = async (run: () => Promise<Response>) => { const before = counts.subrequests; const result = await run(); return { result, subrequests: counts.subrequests - before }; };
  return { sqlite: inner.sqlite, database, counts, call, pair, requirePin, counted };
}
const at = (minutes: number, seconds = 0) => new Date(Date.parse("2026-09-30T12:00:00Z") + minutes * 60_000 + seconds * 1000).toISOString();
const code = async (result: Response) => (await result.json() as { code?: string }).code;

test("a scan queued without a PIN before Require PIN was turned on is recorded; one made after is refused", async context => {
  const { sqlite, call, pair, requirePin, counted } = await fixture(context);
  const a = await pair("Test Kiosk A"), b = await pair("Test Kiosk B");
  let event = 0;
  // A plain scan as a Pi queues it, and as a Pi on 2.0.1 always sends it: no pin, no pinCheck.
  const scan = (member: number, occurredAt: string, kiosk = a, extra: Record<string, unknown> = {}) => call("/kiosk/attendance", { eventId: `test-queued-${++event}`, memberId: `TEST-${member}`, occurredAt, pairingId: kiosk.pairingId, ...extra }, kiosk.kioskToken);
  const recorded = (member: number) => sqlite.prepare("SELECT COUNT(*) AS n FROM attendance_events WHERE member_id = ?").get(`test-member-${member}`)!.n;

  // An Admin turns on Require PIN for kiosk A at 12:10, while scans made at 12:01 and 12:02 are still in its queue.
  context.mock.timers.tick(10 * 60_000);
  await requirePin(a.kioskId, true);
  context.mock.timers.tick(5 * 60_000);
  const queued = await counted(() => scan(1, at(1)));
  assert.equal(queued.result.status, 202, await queued.result.clone().text()); assert.equal(recorded(1), 1);
  assert.equal((await scan(2, at(2))).status, 202, "the scan behind it syncs too"); assert.equal(recorded(2), 1);
  assert.equal((await scan(3, at(9, 59))).status, 202);
  assert.ok(queued.subrequests < FREE_PLAN_SUBREQUESTS, `${queued.subrequests} subrequests`);

  // A scan made at or after the change needed a PIN, and still does.
  for (const occurredAt of [at(10), at(10, 1), at(14)]) {
    const refused = await scan(4, occurredAt); assert.equal(refused.status, 400); assert.equal(await code(refused), "pin_required");
  }
  assert.equal(recorded(4), 0);
  // The rule is for scans with no PIN at all: a PIN sent with an old time is still checked, and pinCheck is still validated.
  assert.equal(await code(await scan(5, at(1), a, { pin: "2468" })), "pin_not_set");
  assert.equal(await code(await scan(5, at(1), a, { pin: "12a4" })), "invalid_pin");
  assert.equal(await code(await scan(5, at(1), a, { pinCheck: "trusted" })), "invalid_pin_check");
  assert.equal(recorded(5), 0);
  // A malformed time never passes.
  assert.equal((await scan(6, "long ago")).status, 400); assert.equal(recorded(6), 0);

  // Each kiosk goes by its own change: B turns Require PIN on at 12:20, so its 12:14 scan is recorded while A's is not.
  context.mock.timers.tick(5 * 60_000);
  await requirePin(b.kioskId, true);
  assert.equal((await scan(7, at(14), b)).status, 202);
  assert.equal(await code(await scan(7, at(14), a)), "pin_required");

  // Off and on again: the last time it was turned on counts. Saving the setting again while on changes nothing.
  await requirePin(a.kioskId, false);
  assert.equal((await scan(8, at(19))).status, 202, "no PIN is needed while Require PIN is off");
  context.mock.timers.tick(5 * 60_000);
  await requirePin(a.kioskId, true);
  context.mock.timers.tick(5 * 60_000);
  await requirePin(a.kioskId, true);
  assert.equal((await scan(9, at(24))).status, 202, "made before 12:25, when it was last turned on");
  assert.equal(await code(await scan(10, at(26))), "pin_required");

  // Without the audit of the change there is no time to go by, and the scan is refused as before.
  sqlite.prepare("DELETE FROM audit_log WHERE action = 'kiosk.authentication_method_updated' AND target_id = ?").run(a.kioskId);
  assert.equal(await code(await scan(11, at(1))), "pin_required");
});

test("200 offline wrong-PIN entries are applied in a bounded number of D1 subrequests, with lockout rules unchanged", async context => {
  const { sqlite, counts, call, pair, requirePin, counted } = await fixture(context);
  const kiosk = await pair("Test Kiosk A");
  await requirePin(kiosk.kioskId, true);
  assert.equal((await call("/admin/settings/pin-lockout", { enabled: true, attempts: 3, minutes: 10 }, undefined, "PUT")).status, 200);
  // Members 1 to 220 have a PIN set on 1 September; 221 to 230 have none.
  sqlite.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<220)
    INSERT INTO member_pins(installation_id,member_id,pin_hash,pin_salt,pin_iterations,set_at,failed_attempts,locked_until,updated_at) SELECT 'primary','test-member-'||x,'synthetic-hash-'||x,'synthetic-salt',2000,'2026-09-01T00:00:00.000Z',0,NULL,'2026-09-01T00:00:00.000Z' FROM n;
    UPDATE member_pins SET failed_attempts = 2 WHERE member_id = 'test-member-181';
    UPDATE member_pins SET failed_attempts = 5, locked_until = '2026-09-30T12:30:00.000Z' WHERE member_id = 'test-member-182';
    UPDATE member_pins SET failed_attempts = 7, locked_until = '2026-09-30T11:00:00.000Z' WHERE member_id = 'test-member-183';
    UPDATE member_pins SET failed_attempts = 999999 WHERE member_id = 'test-member-184';`);
  const now = new Date().toISOString(), lockUntil = new Date(Date.now() + 600_000).toISOString();
  const pin = (member: number) => ({ ...sqlite.prepare("SELECT failed_attempts AS failedAttempts, locked_until AS lockedUntil, updated_at AS updatedAt FROM member_pins WHERE member_id = ?").get(`test-member-${member}`) });
  const lockAudits = () => sqlite.prepare("SELECT id, target_id AS member, actor_user_id AS actor, metadata_json AS metadata, created_at AS createdAt FROM audit_log WHERE action = 'member_pin.locked' ORDER BY target_id").all().map(row => ({ ...row, metadata: JSON.parse(String(row.metadata)) }));
  const report = (failures: unknown[]) => counted(() => call("/kiosk/pin-failures", { failures }, kiosk.kioskToken));

  const failures: { memberId: string; count: number; lastAt: string }[] = [];
  // 1 to 100: two tries by member ID (below the limit). 101 to 180: three tries by roster id (at the limit).
  for (let member = 1; member <= 100; member += 1) failures.push({ memberId: `TEST-${member}`, count: 2, lastAt: now });
  for (let member = 101; member <= 180; member += 1) failures.push({ memberId: `test-member-${member}`, count: 3, lastAt: now });
  failures.push({ memberId: "TEST-181", count: 1, lastAt: now }); // two earlier tries, so this one locks
  failures.push({ memberId: "TEST-182", count: 4, lastAt: now }); // locked already: counted, the lock is not extended
  failures.push({ memberId: "TEST-183", count: 1, lastAt: now }); // an old lock ran out: a fresh count
  failures.push({ memberId: "TEST-184", count: 1000, lastAt: now }); // the count is capped
  // The same member twice, by member ID and by roster id, in an offset time: the tries add up.
  failures.push({ memberId: "TEST-185", count: 1, lastAt: now }, { memberId: "test-member-185", count: 2, lastAt: "2026-09-30T08:00:00-04:00" });
  // Not counted: tries before the current PIN was set, members with no PIN, and people not on the roster.
  for (let member = 186; member <= 190; member += 1) failures.push({ memberId: `TEST-${member}`, count: 9, lastAt: "2026-08-31T23:59:59.000Z" });
  failures.push({ memberId: "TEST-191", count: 2, lastAt: now }, { memberId: "TEST-191", count: 9, lastAt: "2026-08-01T00:00:00.000Z" }); // only the newer entry counts
  for (let member = 221; member <= 225; member += 1) failures.push({ memberId: `TEST-${member}`, count: 3, lastAt: now });
  while (failures.length < 200) failures.push({ memberId: `TEST-NOBODY-${failures.length}`, count: 3, lastAt: now });
  assert.equal(failures.length, 200);
  const counted200 = 100 * 2 + 80 * 3 + 1 + 4 + 1 + 1000 + 3 + 2;

  // Nothing is applied when the report fails part-way, so sending it again cannot count anything twice.
  sqlite.exec("CREATE TRIGGER test_fail_report BEFORE UPDATE ON member_pins WHEN OLD.member_id = 'test-member-150' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  const failed = await report(failures);
  assert.equal(failed.result.status, 500);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM member_pins WHERE updated_at <> '2026-09-01T00:00:00.000Z'").get()!.n, 0);
  assert.deepEqual(lockAudits(), []);
  sqlite.exec("DROP TRIGGER test_fail_report");

  context.mock.timers.tick(1000); // the retry, a second later
  const retryNow = new Date().toISOString(), retryLockUntil = new Date(Date.now() + 600_000).toISOString();
  counts.batches.length = 0;
  const full = await report(failures);
  assert.equal(full.result.status, 200, await full.result.clone().text());
  assert.deepEqual(await full.result.json(), { recorded: counted200 });
  // The whole request: the kiosk credential and module reads, the lockout read, and one batch for the report.
  assert.ok(full.subrequests <= 10, `${full.subrequests} subrequests for 200 entries`);
  assert.ok(full.subrequests < FREE_PLAN_SUBREQUESTS);
  const fullBatches = counts.batches.splice(0);
  const single = await report([{ memberId: "TEST-200", count: 1, lastAt: retryNow }]);
  assert.deepEqual(await single.result.json(), { recorded: 1 });
  assert.equal(full.subrequests, single.subrequests, "200 entries cost what one entry costs");
  assert.deepEqual(fullBatches, counts.batches, "and its batches are no larger");

  // Below the limit: counted, not locked.
  for (const member of [1, 50, 100]) assert.deepEqual(pin(member), { failedAttempts: 2, lockedUntil: null, updatedAt: retryNow });
  // At the limit: locked for the configured minutes.
  for (const member of [101, 140, 180]) assert.deepEqual(pin(member), { failedAttempts: 3, lockedUntil: retryLockUntil, updatedAt: retryNow });
  assert.deepEqual(pin(181), { failedAttempts: 3, lockedUntil: retryLockUntil, updatedAt: retryNow });
  assert.deepEqual(pin(182), { failedAttempts: 9, lockedUntil: "2026-09-30T12:30:00.000Z", updatedAt: retryNow });
  assert.deepEqual(pin(183), { failedAttempts: 1, lockedUntil: null, updatedAt: retryNow });
  assert.deepEqual(pin(184), { failedAttempts: 1_000_000, lockedUntil: retryLockUntil, updatedAt: retryNow });
  assert.deepEqual(pin(185), { failedAttempts: 3, lockedUntil: retryLockUntil, updatedAt: retryNow });
  for (const member of [186, 190, 201, 220]) assert.deepEqual(pin(member), { failedAttempts: 0, lockedUntil: null, updatedAt: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(pin(191), { failedAttempts: 2, lockedUntil: null, updatedAt: retryNow });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM member_pins").get()!.n, 220, "no PIN row was created for anyone");
  // The tries never count toward the online throttle.
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM member_pins WHERE throttle_failures <> 0 OR throttle_until IS NOT NULL").get()!.n, 0);

  // One member_pin.locked audit for each lock this report started, and none for the member who was locked already.
  const audits = lockAudits();
  assert.deepEqual(audits.map(audit => audit.member), [...Array.from({ length: 80 }, (_, index) => `test-member-${101 + index}`), "test-member-181", "test-member-184", "test-member-185"].sort());
  assert.deepEqual(audits.find(audit => audit.member === "test-member-181"), { id: audits.find(audit => audit.member === "test-member-181")!.id, member: "test-member-181", actor: null, createdAt: retryNow, metadata: { kioskId: kiosk.kioskId, via: "offline_report", failedAttempts: 3, lockedUntil: retryLockUntil, minutes: 10 } });
  assert.equal(audits.find(audit => audit.member === "test-member-184")!.metadata.failedAttempts, 1_000_000);
  assert.equal(new Set(audits.map(audit => audit.id)).size, audits.length);
  for (const audit of audits) assert.match(String(audit.id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(lockUntil, retryLockUntil);

  // With lockout off, tries are only counted; an empty report costs no more than the credential read.
  assert.equal((await call("/admin/settings/pin-lockout", { enabled: false, attempts: 3, minutes: 10 }, undefined, "PUT")).status, 200);
  assert.deepEqual(await (await report([{ memberId: "TEST-1", count: 40, lastAt: retryNow }])).result.json(), { recorded: 40 });
  assert.deepEqual(pin(1), { failedAttempts: 42, lockedUntil: null, updatedAt: retryNow });
  assert.equal(lockAudits().length, audits.length);
  const empty = await report([]);
  assert.deepEqual(await empty.result.json(), { recorded: 0 }); assert.ok(empty.subrequests < single.subrequests);
  assert.equal((await report(Array.from({ length: 201 }, () => ({ memberId: "TEST-1", count: 1, lastAt: retryNow })))).result.status, 400);
});

test("the Require PIN lookup for a scan without a PIN is served by the audit_log index of migration 0101", async context => {
  const { sqlite, database, call, pair, requirePin } = await fixture(context);
  const kiosk = await pair("Test Kiosk A");
  await requirePin(kiosk.kioskId, true);
  // The statement the Worker runs, as it prepares it.
  let lookup = ""; const prepare = database.prepare; database.prepare = (sql) => { if (sql.includes("kiosk.authentication_method_updated") && sql.includes("MAX(created_at)")) lookup = sql; return prepare(sql); };
  assert.equal(await code(await call("/kiosk/attendance", { eventId: "test-no-pin", memberId: "TEST-1", occurredAt: at(5), pairingId: kiosk.pairingId }, kiosk.kioskToken)), "pin_required");
  assert.ok(lookup, "the lookup ran");
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all(kiosk.kioskId).map(row => String(row.detail)).join("; ");
  assert.match(plan, /SEARCH audit_log USING INDEX audit_log_kiosk_method_updates \(installation_id=\? AND target_id=\?\)/, plan);
  assert.doesNotMatch(plan, /SCAN audit_log/);
  // Partial: only kiosk method changes are in the index, so no other audit row pays for it.
  assert.match(String(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_log_kiosk_method_updates'").get()!.sql), /WHERE action = 'kiosk\.authentication_method_updated' AND target_type = 'kiosk'/);
});

test("PIN tries sent at the same time pass the throttle and the lock no more often than one after another", async context => {
  const { sqlite, call, pair, requirePin, counted } = await fixture(context);
  const kiosk = await pair("Test Kiosk A");
  await requirePin(kiosk.kioskId, true);
  for (const member of [1, 2, 3]) assert.equal((await call("/kiosk/pins", { memberId: `TEST-${member}`, pin: "2468" }, kiosk.kioskToken)).status, 201);
  let event = 0;
  const scan = (member: number, pin: string) => call("/kiosk/attendance", { eventId: `test-burst-${++event}`, memberId: `TEST-${member}`, occurredAt: new Date().toISOString(), pairingId: kiosk.pairingId, pin }, kiosk.kioskToken);
  const burst = async (member: number, pins: string[]) => { const results = await Promise.all(pins.map(pin => scan(member, pin))); return Promise.all(results.map(async result => ({ status: result.status, code: await code(result) }))); };
  const pin = (member: number) => ({ ...sqlite.prepare("SELECT failed_attempts AS failed, locked_until AS lockedUntil, throttle_failures AS throttle, throttle_until AS throttleUntil FROM member_pins WHERE member_id = ?").get(`test-member-${member}`) });
  const wrongPins = (count: number, from: number) => Array.from({ length: count }, (_, index) => String(1000 + from + index));
  const answered = (results: { status: number; code?: string }[]) => results.filter(result => result.code !== "pin_throttled" && result.code !== "pin_locked");

  // Twenty wrong PINs at once. Every request claims its try before its PIN is checked, so only the five free tries are
  // checked and answered; the other fifteen are refused without a PIN being compared.
  const first = await burst(1, wrongPins(20, 0));
  assert.equal(first.filter(result => result.status === 403 && result.code === "pin_incorrect").length, 5);
  assert.equal(first.filter(result => result.status === 429 && result.code === "pin_throttled").length, 15);
  assert.deepEqual(pin(1), { failed: 5, lockedUntil: null, throttle: 5, throttleUntil: new Date(Date.now() + 30_000).toISOString() });

  // After the wait, one try of a burst is checked.
  context.mock.timers.tick(30_000);
  const second = await burst(1, wrongPins(10, 100));
  assert.equal(second.filter(result => result.status === 403 && result.code === "pin_incorrect").length, 1, "one try per wait");
  assert.equal(second.filter(result => result.code === "pin_throttled").length, 9);
  assert.deepEqual(pin(1), { failed: 6, lockedUntil: null, throttle: 6, throttleUntil: new Date(Date.now() + 60_000).toISOString() });

  // The correct PIN in a burst with nine wrong ones, after the next wait. The try that reaches the database first is the
  // one checked, and which that is is not promised: each request authenticates on its own before it claims. So this
  // goes by what was checked, not by the order the tries were sent in.
  context.mock.timers.tick(60_000);
  const third = await burst(1, ["2468", ...wrongPins(9, 200)]);
  const correct = third[0]!, wrongChecked = third.slice(1).filter(result => result.code === "pin_incorrect").length;
  assert.equal(third.slice(1).every(result => result.code === "pin_incorrect" || result.code === "pin_throttled"), true, JSON.stringify(third));
  if (correct.code === "pin_throttled") {
    // A wrong PIN was the one try of this wait. The correct PIN was refused unchecked, and the next wait is the longest.
    assert.equal(correct.status, 429);
    assert.equal(wrongChecked, 1, "one try per wait");
    assert.deepEqual(pin(1), { failed: 7, lockedUntil: null, throttle: 7, throttleUntil: new Date(Date.now() + 300_000).toISOString() });
    // After it, the correct PIN alone is the try that is checked: it is accepted, and the count starts over.
    context.mock.timers.tick(300_000);
    const alone = await scan(1, "2468"); assert.equal(alone.status, 202, await alone.clone().text());
    assert.deepEqual(pin(1), { failed: 0, lockedUntil: null, throttle: 0, throttleUntil: null });
  } else {
    // The correct PIN was the one try of this wait: it is accepted, and the count starts over. The wrong PINs checked
    // are the free tries of that new count, no more, and are all that is counted.
    assert.equal(correct.status, 202, JSON.stringify(third));
    assert.ok(wrongChecked <= PIN_FREE_TRIES, `${wrongChecked} wrong PINs checked behind the correct one`);
    assert.deepEqual(pin(1), { failed: wrongChecked, lockedUntil: null, throttle: wrongChecked, throttleUntil: wrongChecked === PIN_FREE_TRIES ? new Date(Date.now() + 30_000).toISOString() : null });
  }

  // With lockout on at three tries, three tries of a burst are checked, and the PIN is locked.
  assert.equal((await call("/admin/settings/pin-lockout", { enabled: true, attempts: 3, minutes: 10 }, undefined, "PUT")).status, 200);
  const locking = await burst(2, wrongPins(20, 300));
  assert.equal(answered(locking).length, 3, `${answered(locking).length} tries checked`);
  assert.equal(answered(locking).every(result => result.code === "pin_incorrect"), true);
  assert.equal(pin(2).lockedUntil, new Date(Date.now() + 600_000).toISOString());
  assert.equal((await scan(2, "2468")).status, 423, "locked, whatever the PIN");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_pin.locked' AND target_id = 'test-member-2'").get()!.n, 1);

  // One at a time nothing changed: a correct PIN is two writes (the claim, and clearing it), a refused try one write and one read.
  const good = await counted(() => scan(3, "2468")); assert.equal(good.result.status, 202, await good.result.clone().text());
  assert.deepEqual(pin(3), { failed: 0, lockedUntil: null, throttle: 0, throttleUntil: null });
  const plain = await counted(() => call("/kiosk/attendance", { eventId: "test-plain", memberId: "TEST-9", occurredAt: new Date().toISOString(), pairingId: kiosk.pairingId, pinCheck: "offline" }, kiosk.kioskToken));
  assert.equal(plain.result.status, 202);
  assert.equal(good.subrequests - plain.subrequests, 2, "the PIN step of a correct PIN is two D1 subrequests");
  assert.ok(good.subrequests < FREE_PLAN_SUBREQUESTS);
});

test("with lockout on, PIN tries sent at the same time are checked no more often than the configured number before the lock", async context => {
  const { sqlite, call, pair, requirePin, counted } = await fixture(context);
  const kiosk = await pair("Test Kiosk A");
  await requirePin(kiosk.kioskId, true);
  for (let member = 1; member <= 12; member += 1) assert.equal((await call("/kiosk/pins", { memberId: `TEST-${member}`, pin: "2468" }, kiosk.kioskToken)).status, 201);
  let event = 0;
  const scan = (member: number, pin: string) => call("/kiosk/attendance", { eventId: `test-lock-burst-${++event}`, memberId: `TEST-${member}`, occurredAt: new Date().toISOString(), pairingId: kiosk.pairingId, pin }, kiosk.kioskToken);
  const burst = async (member: number, pins: string[]) => { const results = await Promise.all(pins.map(pin => scan(member, pin))); return Promise.all(results.map(async result => ({ status: result.status, ...(await result.json() as { code?: string; attemptsLeft?: number; lockedUntil?: string }) }))); };
  const pin = (member: number) => ({ ...sqlite.prepare("SELECT failed_attempts AS failed, locked_until AS lockedUntil, throttle_failures AS throttle, throttle_until AS throttleUntil FROM member_pins WHERE member_id = ?").get(`test-member-${member}`) });
  const lockAudits = (member: number) => sqlite.prepare("SELECT metadata_json AS metadata, actor_user_id AS actor FROM audit_log WHERE action = 'member_pin.locked' AND target_id = ?").all(`test-member-${member}`).map(row => ({ actor: row.actor, metadata: JSON.parse(String(row.metadata)) }));
  const wrongPins = (count: number, from: number) => Array.from({ length: count }, (_, index) => String(1000 + from + index));
  const lockout = async (enabled: boolean, attempts: number) => assert.equal((await call("/admin/settings/pin-lockout", { enabled, attempts, minutes: 10 }, undefined, "PUT")).status, 200);
  const count = (results: { code?: string }[], code: string) => results.filter(result => result.code === code).length;

  // Lockout at 3, 4 and 5 wrong tries: of twenty wrong PINs sent at once, exactly that many are checked. The claim of
  // the last one starts the lock, so every other try is refused as locked, without its PIN being compared.
  for (const [member, attempts] of [[1, 3], [2, 4], [3, 5]] as const) {
    await lockout(true, attempts);
    const results = await burst(member, wrongPins(20, member * 100));
    const lockedUntil = new Date(Date.now() + 600_000).toISOString();
    assert.equal(count(results, "pin_incorrect"), attempts, `lockout ${attempts}: ${JSON.stringify(results.map(result => result.code))}`);
    assert.equal(results.filter(result => result.status === 423 && result.code === "pin_locked").length, 20 - attempts, `lockout ${attempts}`);
    // Each checked try says how many are left; the one that reached the limit says the PIN is locked.
    assert.deepEqual(results.filter(result => result.code === "pin_incorrect").map(result => result.attemptsLeft).sort(), Array.from({ length: attempts }, (_, index) => index));
    assert.deepEqual(results.filter(result => result.code === "pin_incorrect" && result.lockedUntil !== undefined).map(result => [result.attemptsLeft, result.lockedUntil]), [[0, lockedUntil]]);
    assert.deepEqual({ failed: pin(member).failed, lockedUntil: pin(member).lockedUntil }, { failed: attempts, lockedUntil });
    assert.deepEqual(lockAudits(member), [{ actor: null, metadata: { kioskId: kiosk.kioskId, via: "kiosk", failedAttempts: attempts, lockedUntil, minutes: 10 } }]);
    assert.equal((await scan(member, "2468")).status, 423, "locked, whatever the PIN");
  }

  // Lockout above the free tries: the throttle holds the burst at its five free tries, and nothing is locked yet.
  await lockout(true, 8);
  const throttledFirst = await burst(4, wrongPins(20, 400));
  assert.equal(count(throttledFirst, "pin_incorrect"), 5); assert.equal(count(throttledFirst, "pin_throttled"), 15);
  assert.deepEqual(pin(4), { failed: 5, lockedUntil: null, throttle: 5, throttleUntil: new Date(Date.now() + 30_000).toISOString() });
  assert.deepEqual(lockAudits(4), []);

  // Lockout off: the five free tries, then the throttle. Tries are counted and never lock.
  await lockout(false, 3);
  const unlocked = await burst(5, wrongPins(20, 500));
  assert.equal(count(unlocked, "pin_incorrect"), 5); assert.equal(count(unlocked, "pin_throttled"), 15); assert.equal(count(unlocked, "pin_locked"), 0);
  assert.equal(unlocked.some(result => result.attemptsLeft !== undefined || result.lockedUntil !== undefined), false);
  assert.deepEqual(pin(5), { failed: 5, lockedUntil: null, throttle: 5, throttleUntil: new Date(Date.now() + 30_000).toISOString() });
  assert.deepEqual(lockAudits(5), []);

  // Tries made offline count toward the same number: two reported, then a burst, and one online try is checked.
  await lockout(true, 3);
  assert.deepEqual(await (await call("/kiosk/pin-failures", { failures: [{ memberId: "TEST-6", count: 2, lastAt: new Date().toISOString() }] }, kiosk.kioskToken)).json(), { recorded: 2 });
  const afterOffline = await burst(6, wrongPins(20, 600));
  assert.equal(count(afterOffline, "pin_incorrect"), 1); assert.equal(count(afterOffline, "pin_locked"), 19);
  assert.equal(lockAudits(6).length, 1);

  // A correct PIN on the try that reaches the limit is not a lock: the counts start over and nothing is audited.
  assert.equal(count(await burst(7, wrongPins(2, 700)), "pin_incorrect"), 2);
  const atLimit = await scan(7, "2468"); assert.equal(atLimit.status, 202, await atLimit.clone().text());
  assert.deepEqual(pin(7), { failed: 0, lockedUntil: null, throttle: 0, throttleUntil: null });
  assert.deepEqual(lockAudits(7), []);
  // The correct PIN among wrong ones sent at once: never more than three tries checked.
  const mixed = await burst(8, [...wrongPins(10, 800), "2468", ...wrongPins(9, 820)]);
  assert.ok(mixed.filter(result => result.code !== "pin_locked" && result.code !== "pin_throttled").length <= 3, JSON.stringify(mixed.map(result => result.code)));

  // A lock that has run out starts a fresh count: three more tries, not one.
  context.mock.timers.tick(10 * 60_000 + 1000);
  const again = await burst(6, wrongPins(20, 900));
  assert.equal(count(again, "pin_incorrect"), 3); assert.equal(count(again, "pin_locked"), 17);
  assert.equal(lockAudits(6).length, 2);

  // What the PIN step costs, over a scan refused before it (a malformed PIN): a wrong PIN is the claim alone, the wrong
  // PIN that starts a lock adds its audit, a correct PIN is the claim and clearing it (the test above), and a try
  // refused as locked is the claim that changed nothing and the read for its reason.
  const before = (await counted(() => scan(9, "12"))).subrequests;
  const step = async (member: number, value: string, status: number) => { const made = await counted(() => scan(member, value)); assert.equal(made.result.status, status, await made.result.clone().text()); return made.subrequests - before; };
  assert.equal(await step(9, "1111", 403), 1, "a wrong PIN");
  assert.equal(await step(9, "1112", 403), 1, "a second wrong PIN");
  assert.equal(await step(9, "1113", 403), 2, "the wrong PIN that locks");
  assert.equal(await step(9, "2468", 423), 2, "a try while locked");
  await lockout(false, 3);
  assert.equal(await step(10, "1111", 403), 1, "a wrong PIN with lockout off");
});

test("a wrong-PIN report with a report id is counted once, however often the kiosk sends it", async context => {
  const { sqlite, counts, call, pair, requirePin, counted } = await fixture(context);
  const a = await pair("Test Kiosk A"), b = await pair("Test Kiosk B");
  await requirePin(a.kioskId, true); await requirePin(b.kioskId, true);
  assert.equal((await call("/admin/settings/pin-lockout", { enabled: true, attempts: 3, minutes: 10 }, undefined, "PUT")).status, 200);
  sqlite.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<220)
    INSERT INTO member_pins(installation_id,member_id,pin_hash,pin_salt,pin_iterations,set_at,failed_attempts,locked_until,updated_at) SELECT 'primary','test-member-'||x,'synthetic-hash-'||x,'synthetic-salt',2000,'2026-09-01T00:00:00.000Z',0,NULL,'2026-09-01T00:00:00.000Z' FROM n;`);
  const now = new Date().toISOString();
  const tries = (member: number) => sqlite.prepare("SELECT failed_attempts AS n FROM member_pins WHERE member_id = ?").get(`test-member-${member}`)!.n;
  const lockAudits = () => sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_pin.locked'").get()!.n;
  const ids = () => sqlite.prepare("SELECT kiosk_id AS kiosk, report_id AS id, recorded, applied_at AS appliedAt FROM kiosk_pin_failure_reports ORDER BY applied_at, report_id").all().map(row => ({ ...row }));
  const report = (body: unknown, kiosk = a) => counted(() => call("/kiosk/pin-failures", body, kiosk.kioskToken));
  const failures = [{ memberId: "TEST-1", count: 2, lastAt: now }, { memberId: "test-member-2", count: 3, lastAt: now }, { memberId: "TEST-NOBODY", count: 4, lastAt: now }];

  // The report is applied, and its answer is lost on the way back. The kiosk sends it again, twice.
  const first = await report({ reportId: "test-report-1", failures });
  assert.deepEqual(await first.result.json(), { recorded: 5 });
  const withIdBatch = counts.batches.at(-1)!;
  assert.deepEqual([tries(1), tries(2), lockAudits()], [2, 3, 1]);
  assert.deepEqual(ids(), [{ kiosk: a.kioskId, id: "test-report-1", recorded: 5, appliedAt: now }]);
  context.mock.timers.tick(60_000);
  for (let resend = 0; resend < 2; resend += 1) {
    const again = await report({ reportId: "test-report-1", failures });
    assert.equal(again.result.status, 200); assert.deepEqual(await again.result.json(), { recorded: 5 }, "answered with the first result");
    assert.equal(again.subrequests, first.subrequests, "a repeat costs what the report cost");
  }
  assert.deepEqual([tries(1), tries(2), lockAudits()], [2, 3, 1], "nothing was counted or audited again");
  assert.equal(sqlite.prepare("SELECT updated_at AS at FROM member_pins WHERE member_id = 'test-member-1'").get()!.at, now, "and no row was touched");
  assert.deepEqual(ids(), [{ kiosk: a.kioskId, id: "test-report-1", recorded: 5, appliedAt: now }]);
  // The id stands for the report as first applied: other tries sent under it are not counted, and get its answer.
  assert.deepEqual(await (await report({ reportId: "test-report-1", failures: [{ memberId: "TEST-3", count: 9, lastAt: now }] })).result.json(), { recorded: 5 });
  assert.equal(tries(3), 0);

  // The tries made since go in the next report, under a new id, and are counted.
  assert.deepEqual(await (await report({ reportId: "test-report-2", failures: [{ memberId: "TEST-1", count: 1, lastAt: new Date().toISOString() }] })).result.json(), { recorded: 1 });
  assert.equal(tries(1), 3);
  // Ids are per kiosk: another kiosk's report with the same id is its own report.
  assert.deepEqual(await (await report({ reportId: "test-report-1", failures: [{ memberId: "TEST-4", count: 2, lastAt: new Date().toISOString() }] }, b)).result.json(), { recorded: 2 });
  assert.equal(tries(4), 2);
  assert.equal(ids().length, 3);
  // A report that counts nothing is remembered too, and a failed one is not: its retry is applied.
  assert.deepEqual(await (await report({ reportId: "test-report-3", failures: [{ memberId: "TEST-NOBODY", count: 4, lastAt: now }] })).result.json(), { recorded: 0 });
  sqlite.exec("CREATE TRIGGER test_fail_report BEFORE UPDATE ON member_pins WHEN OLD.member_id = 'test-member-5' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.equal((await report({ reportId: "test-report-4", failures: [{ memberId: "TEST-5", count: 1, lastAt: new Date().toISOString() }] })).result.status, 500);
  sqlite.exec("DROP TRIGGER test_fail_report");
  assert.equal(ids().some(row => row.id === "test-report-4"), false); assert.equal(tries(5), 0);
  assert.deepEqual(await (await report({ reportId: "test-report-4", failures: [{ memberId: "TEST-5", count: 1, lastAt: new Date().toISOString() }] })).result.json(), { recorded: 1 });
  assert.equal(tries(5), 1);

  // A kiosk from before report ids sends none: applied as before, every time, in the same three statements, and it
  // records no id. The request costs the same with or without an id.
  const before = ids().length; counts.batches.length = 0;
  for (let send = 1; send <= 2; send += 1) {
    const old = await report({ failures: [{ memberId: "TEST-6", count: 1, lastAt: new Date().toISOString() }] });
    assert.deepEqual(await old.result.json(), { recorded: 1 }); assert.equal(tries(6), send);
    assert.equal(old.subrequests, first.subrequests);
  }
  // Its batch is the three statements it always was: the id adds three (its row, the answer, and the pruning).
  assert.equal(counts.batches.at(-1), withIdBatch - 3); assert.equal(ids().length, before);
  assert.deepEqual(await (await report({ reportId: null, failures: [{ memberId: "TEST-6", count: 1, lastAt: new Date().toISOString() }] })).result.json(), { recorded: 1 }, "null reads as no id");

  // 200 entries with an id cost what one does.
  const many = Array.from({ length: 200 }, (_, index) => ({ memberId: `TEST-${index + 10}`, count: 1, lastAt: new Date().toISOString() }));
  const full = await report({ reportId: "test-report-200", failures: many });
  assert.deepEqual(await full.result.json(), { recorded: 200 }); assert.equal(full.subrequests, first.subrequests, "200 entries cost what three cost");
  assert.ok(full.subrequests < FREE_PLAN_SUBREQUESTS);
  assert.deepEqual(await (await report({ reportId: "test-report-200", failures: many })).result.json(), { recorded: 200 });
  assert.equal(tries(10), 1); assert.equal(tries(209), 1);

  // An id that cannot be a key is refused, and nothing is counted.
  for (const reportId of ["", "x".repeat(129), 7, { id: "a" }, "bad\u0000id"]) assert.equal((await report({ reportId, failures: [{ memberId: "TEST-7", count: 1, lastAt: now }] })).result.status, 400, JSON.stringify(reportId));
  assert.equal(tries(7), 0);
  // With Require PIN off the report is dropped and its id is not kept.
  await requirePin(b.kioskId, false);
  assert.deepEqual(await (await report({ reportId: "test-report-off", failures: [{ memberId: "TEST-8", count: 1, lastAt: now }] }, b)).result.json(), { recorded: 0 });
  assert.equal(ids().some(row => row.id === "test-report-off"), false);

  // Ids older than 30 days go when the next report with an id arrives; newer ones stay.
  const total = ids().length;
  context.mock.timers.tick(29 * 86_400_000);
  await report({ reportId: "test-report-later", failures: [{ memberId: "TEST-8", count: 1, lastAt: new Date().toISOString() }] });
  assert.equal(ids().length, total + 1, "29 days on, every id is kept");
  context.mock.timers.tick(2 * 86_400_000);
  await report({ reportId: "test-report-last", failures: [{ memberId: "TEST-8", count: 1, lastAt: new Date().toISOString() }] });
  assert.deepEqual(ids().map(row => row.id), ["test-report-later", "test-report-last"]);
});

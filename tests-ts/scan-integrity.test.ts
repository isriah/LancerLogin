import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { reenrollThreshold } from "../apps/api/src/scan-integrity.ts";

const secret = "A".repeat(43);

type Scan = { eventId: string; memberId?: string; occurredAt: string; matchScore?: number; rescanSupported?: boolean };
type WrongMatches = { windowSeconds: number; matches: Array<{ eventId: string; member: { id: string; memberId: string; displayName: string }; scan: { kioskName: string; occurredAt: string; matchScore: number | null }; acceptedScan: { kioskName: string; occurredAt: string; matchScore: number | null } }> };
type Suggestions = { threshold: number; scans: number; members: Array<{ rosterId: string; memberId: string; medianScore: number; lowestScore: number }> };

test("a scan matching a member who scanned on another kiosk within 30 seconds is refused and asked to rescan", async context => {
  const { database, call, pair } = await fixture(context);
  const front = await pair("Test Front Kiosk"), side = await pair("Test Side Kiosk");
  const scan = (device: typeof front, input: Scan) => call("/kiosk/attendance", { memberId: "SYN-001", pairingId: device.pairingId, rescanSupported: true, ...input }, device.kioskToken);
  const events = () => Number(database.sqlite.prepare("SELECT COUNT(*) AS n FROM attendance_events").get()?.n);

  const accepted = await scan(front, { eventId: "front-1", occurredAt: "2026-09-30T12:00:00.000Z", matchScore: 180 });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  // The incident: someone else on the other kiosk matched the same member seconds later with a weak score.
  for (const [eventId, occurredAt] of [["side-4s", "2026-09-30T12:00:04.000Z"], ["side-20s", "2026-09-30T12:00:20Z"], ["side-29s", "2026-09-30T12:00:29.900Z"]]) {
    const refused = await scan(side, { eventId, occurredAt, matchScore: 46 });
    assert.equal(refused.status, 409, eventId);
    assert.deepEqual(await refused.json(), { error: "Scan again", code: "possible_wrong_match" });
  }
  assert.equal(events(), 1, "a refused scan is not attendance");
  const retry = await scan(side, { eventId: "side-20s", occurredAt: "2026-09-30T12:00:20Z", matchScore: 46 });
  assert.equal(retry.status, 409, "a resent refused scan is refused again");
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_possible_wrong_matches").get()?.n, 3, "each refused scan is recorded once");

  // Same-kiosk repeats keep today's duplicate handling.
  const repeat = await scan(front, { eventId: "front-2", occurredAt: "2026-09-30T12:00:10Z", matchScore: 175 });
  assert.equal(repeat.status, 200); assert.equal((await repeat.json() as { duplicate: boolean }).duplicate, true);

  // Thirty seconds or more apart is physically possible again.
  const later = await scan(side, { eventId: "side-31s", occurredAt: "2026-09-30T12:00:31Z", matchScore: 160 });
  assert.equal(later.status, 200, "not refused; still a duplicate within the 90-second window");
  const checkOut = await scan(side, { eventId: "side-5m", occurredAt: "2026-09-30T12:05:00Z", matchScore: 160 });
  assert.equal(checkOut.status, 202); assert.equal((await checkOut.json() as { action: string }).action, "check_out");

  const listed = await (await call("/admin/kiosks/possible-wrong-matches")).json() as WrongMatches;
  assert.equal(listed.windowSeconds, 30);
  assert.equal(listed.matches.length, 3);
  const incident = listed.matches.find(match => match.eventId === "side-20s")!;
  assert.deepEqual(incident.member, { id: "member", memberId: "SYN-001", displayName: "Test Student A" });
  assert.deepEqual(incident.scan, { kioskId: side.kioskId, kioskName: "Test Side Kiosk", occurredAt: "2026-09-30T12:00:20.000Z", matchScore: 46 });
  assert.deepEqual(incident.acceptedScan, { eventId: "front-1", kioskId: front.kioskId, kioskName: "Test Front Kiosk", occurredAt: "2026-09-30T12:00:00.000Z", matchScore: 180 });
  assert.equal((await call("/admin/kiosks/possible-wrong-matches", undefined, undefined, undefined, "operator")).status, 403, "Admins only");
});

test("queued uploads are judged by when they happened, before or after the accepted scan", async context => {
  const { call, pair } = await fixture(context);
  const front = await pair("Test Front Kiosk"), side = await pair("Test Side Kiosk");
  const scan = (device: typeof front, input: Scan) => call("/kiosk/attendance", { memberId: "SYN-001", pairingId: device.pairingId, rescanSupported: true, ...input }, device.kioskToken);
  const refused = async (response: Response) => response.status === 409 && (await response.json() as { code?: string }).code === "possible_wrong_match";
  assert.equal((await scan(front, { eventId: "front-1", occurredAt: "2026-09-30T11:30:00Z" })).status, 202);
  // The side kiosk was offline and uploads its queue half an hour later.
  assert.equal(await refused(await scan(side, { eventId: "queued-before", occurredAt: "2026-09-30T11:29:45Z", matchScore: 60 })), true, "15 seconds before the accepted scan");
  // Timestamps are compared as instants, not as text, whatever their precision.
  assert.equal(await refused(await scan(side, { eventId: "queued-after", occurredAt: "2026-09-30T11:30:10.500Z", matchScore: 60 })), true);
  assert.equal(await refused(await scan(side, { eventId: "queued-far", occurredAt: "2026-09-30T11:28:00Z", matchScore: 60 })), false, "two minutes apart is not refused");
  // A late upload that was accepted first still makes the live scan on the other kiosk impossible.
  const other = (device: typeof front, input: Scan) => scan(device, { memberId: "SYN-002", ...input });
  assert.equal((await other(side, { eventId: "side-queued", occurredAt: "2026-09-30T11:50:00Z" })).status, 202);
  assert.equal(await refused(await other(front, { eventId: "front-live", occurredAt: "2026-09-30T11:50:12Z" })), true);
});

test("kiosks that cannot ask for a rescan keep today's behavior", async context => {
  const { database, call, pair } = await fixture(context);
  const front = await pair("Test Front Kiosk"), side = await pair("Test Side Kiosk");
  assert.equal((await call("/kiosk/attendance", { eventId: "front-1", memberId: "SYN-001", occurredAt: "2026-09-30T12:00:00Z", pairingId: front.pairingId }, front.kioskToken)).status, 202);
  const legacy = await call("/kiosk/attendance", { eventId: "side-1", memberId: "SYN-001", occurredAt: "2026-09-30T12:00:20Z", pairingId: side.pairingId, matchScore: 46 }, side.kioskToken);
  assert.equal(legacy.status, 200, "an older kiosk would retry an unknown refusal forever");
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_accepted_scans").get()?.n, 1, "older kiosks' accepted scans still guard newer kiosks");
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_possible_wrong_matches").get()?.n, 0);
});

test("re-enrollment is suggested when the median of the last five scored accepted scans is below the threshold", async context => {
  const { database, call, insertScan } = await fixture(context);
  const suggestions = async (role?: "operator") => { const result = await call("/admin/kiosks/reenroll-suggestions", undefined, undefined, undefined, role); assert.equal(result.status, 200, await result.clone().text()); return await result.json() as Suggestions; };
  assert.equal(reenrollThreshold(0), 70); assert.equal(reenrollThreshold(40), 60);
  const scores = [30, 90, 40, 95];
  scores.forEach((score, index) => insertScan("member", `score-${index}`, `2026-09-2${index}T12:00:00Z`, score));
  assert.deepEqual((await suggestions()).members, [], "four scored scans are not enough");
  insertScan("member", "score-4", "2026-09-24T12:00:00Z", 50);
  insertScan("member", "unscored", "2026-09-25T12:00:00Z");
  insertScan("member", "score-old", "2026-09-01T12:00:00Z", 10);
  insertScan("member-b", "b-strong", "2026-09-24T12:00:00Z", 200);
  const flagged = await suggestions("operator");
  assert.equal(flagged.threshold, 70);
  assert.deepEqual(flagged.members.map(item => [item.rosterId, item.memberId, item.medianScore, item.lowestScore]), [["member", "SYN-001", 50, 30]], "median 50 of the last five; the older score of 10 is not counted");
  database.sqlite.exec("INSERT INTO kiosk_fingerprint_match_settings(installation_id,minimum_score,updated_at) VALUES ('primary',30,'2026-09-01')");
  assert.deepEqual((await suggestions()).members, [], "median 50 is not below 30 + 20");
  database.sqlite.exec("UPDATE kiosk_fingerprint_match_settings SET minimum_score=40");
  assert.equal((await suggestions()).members.length, 1, "median 50 is below 40 + 20");
  // Refused or rejected scans are not accepted attendance and never count.
  database.sqlite.exec("INSERT INTO kiosk_scan_matches(installation_id,kiosk_event_id,kiosk_id,match_score,recorded_at) VALUES ('primary','refused','kiosk',1,'2026-09-30')");
  assert.equal((await suggestions()).members[0].lowestScore, 30);
});

test("an Admin dismissal lasts until five new scans after it are weak again", async context => {
  const { call, insertScan } = await fixture(context);
  const suggestions = async () => (await (await call("/admin/kiosks/reenroll-suggestions")).json() as Suggestions).members.map(item => item.rosterId);
  [30, 40, 50, 60, 20].forEach((score, index) => insertScan("member", `before-${index}`, `2026-09-2${index}T12:00:00Z`, score));
  assert.deepEqual(await suggestions(), ["member"]);
  assert.equal((await call("/admin/kiosks/reenroll-suggestions/member/dismissal", {}, undefined, undefined, "operator")).status, 403, "only Admins dismiss");
  assert.equal((await call("/admin/kiosks/reenroll-suggestions/missing/dismissal", {})).status, 404);
  const dismissed = await call("/admin/kiosks/reenroll-suggestions/member/dismissal", {});
  assert.equal(dismissed.status, 200, await dismissed.clone().text());
  assert.deepEqual((await dismissed.json() as Suggestions).members, []);
  for (let index = 0; index < 4; index++) insertScan("member", `after-${index}`, `2026-09-30T12:0${index + 1}:00Z`, 30);
  assert.deepEqual(await suggestions(), [], "four weak scans after the dismissal are not enough");
  insertScan("member", "after-4", "2026-09-30T12:05:00Z", 30);
  assert.deepEqual(await suggestions(), ["member"], "five new weak scans flag the member again");
});

test("a completed dashboard re-enrollment starts the score history over, and kiosks receive the threshold", async context => {
  const { database, call, pair, insertScan } = await fixture(context);
  const suggestions = async () => (await (await call("/admin/kiosks/reenroll-suggestions")).json() as Suggestions).members.map(item => item.rosterId);
  [30, 40, 50, 60, 20].forEach((score, index) => insertScan("member", `before-${index}`, `2026-09-2${index}T12:00:00Z`, score));
  assert.deepEqual(await suggestions(), ["member"]);
  const device = await pair("Test Enrollment Kiosk");
  const polled = async () => (await (await call("/kiosk/poll?v=1&config=1", undefined, device.kioskToken)).json() as { configuration: { settings: { fingerprintMinimumScore: number; fingerprintReenrollScore: number } } }).configuration.settings;
  assert.deepEqual([(await polled()).fingerprintMinimumScore, (await polled()).fingerprintReenrollScore], [0, 70]);
  assert.equal((await call("/admin/kiosks/fingerprint-match", { minimumScore: 120 }, undefined, "PUT")).status, 200);
  assert.equal((await polled()).fingerprintReenrollScore, 140);
  assert.equal((await (await call("/kiosk/config", undefined, device.kioskToken)).json() as { settings: { fingerprintReenrollScore: number } }).settings.fingerprintReenrollScore, 140);

  database.sqlite.prepare("UPDATE kiosks SET last_seen_at=?,reader_online=1,authentication_method='fingerprint' WHERE id=?").run(new Date().toISOString(), device.kioskId);
  const path = `/admin/kiosks/${device.kioskId}/enrollment`;
  const { session } = await (await call(path, {})).json() as { session: { id: string } };
  assert.equal((await call(`${path}/${session.id}`, { memberId: "member" }, undefined, "PATCH")).status, 200);
  for (const status of ["awaiting_confirmation", "enroll_wait_first", "enroll_remove", "enroll_wait_second"]) assert.equal((await call(`/kiosk/enrollment/${session.id}/progress`, { status }, device.kioskToken)).status, 200);
  assert.deepEqual(await suggestions(), ["member"], "the flag stays until enrollment succeeds");
  assert.equal((await call(`/kiosk/enrollment/${session.id}/progress`, { status: "enroll_success" }, device.kioskToken)).status, 200);
  assert.deepEqual(await suggestions(), [], "re-enrolling clears the flag");
  for (let index = 0; index < 5; index++) insertScan("member", `after-${index}`, `2026-09-30T12:0${index + 1}:00Z`, 30);
  assert.deepEqual(await suggestions(), ["member"], "five weak scans after re-enrollment flag again");
});

test("a fingerprint enrolled on the kiosk's maintenance screen starts the score history over, once per kiosk event", async context => {
  const { database, call, pair, insertScan } = await fixture(context);
  const suggestions = async () => (await (await call("/admin/kiosks/reenroll-suggestions")).json() as Suggestions).members.map(item => item.rosterId);
  const reenrolledAt = (memberId: string) => database.sqlite.prepare("SELECT reenrolled_at AS at FROM kiosk_fingerprint_reenrollment WHERE member_id=?").get(memberId)?.at;
  const audits = () => database.sqlite.prepare("SELECT actor_user_id AS actor,target_type AS targetType,target_id AS targetId,metadata_json AS metadata FROM audit_log WHERE action='kiosk.fingerprint_enrolled_locally' ORDER BY created_at,id").all() as Array<{ actor: string | null; targetType: string; targetId: string; metadata: string }>;
  [30, 40, 50, 60, 20].forEach((score, index) => insertScan("member", `before-${index}`, `2026-09-2${index}T12:00:00Z`, score));
  assert.deepEqual(await suggestions(), ["member"]);
  const device = await pair("Test Maintenance Kiosk");
  const report = (input: Record<string, unknown>, token = device.kioskToken) => call("/kiosk/fingerprint-enrollments", { pairingId: device.pairingId, ...input }, token);

  const recorded = await report({ eventId: "local-1", rosterId: "member", enrolledAt: "2026-09-30T11:00:00Z" });
  assert.equal(recorded.status, 200, await recorded.clone().text());
  assert.deepEqual(await recorded.json(), { eventId: "local-1", accepted: true, duplicate: false, reenrolledAt: "2026-09-30T11:00:00.000Z" });
  assert.deepEqual(await suggestions(), [], "a maintenance-screen enrollment clears the flag");
  assert.deepEqual(audits().map(row => [row.actor, row.targetType, row.targetId, JSON.parse(row.metadata)]),
    [[null, "kiosk", device.kioskId, { eventId: "local-1", rosterId: "member", enrolledAt: "2026-09-30T11:00:00.000Z" }]], "audited as a kiosk event, with no biometric data");

  const resent = await report({ eventId: "local-1", rosterId: "member", enrolledAt: "2026-09-30T11:00:00Z" });
  assert.equal(resent.status, 200);
  assert.deepEqual(await resent.json(), { eventId: "local-1", accepted: false, duplicate: true, reenrolledAt: "2026-09-30T11:00:00.000Z" });
  assert.equal(audits().length, 1, "the same kiosk event is recorded once");
  const older = await report({ eventId: "local-0", rosterId: "member", enrolledAt: "2026-09-29T08:00:00Z" });
  assert.equal(older.status, 200);
  assert.equal(reenrolledAt("member"), "2026-09-30T11:00:00.000Z", "a late, older report never moves the re-enrollment back");

  // The median window restarts from the enrollment: only scans after it count.
  insertScan("member", "just-before", "2026-09-30T10:59:00Z", 10);
  for (let index = 0; index < 4; index++) insertScan("member", `after-${index}`, `2026-09-30T11:0${index + 1}:00Z`, 30);
  assert.deepEqual(await suggestions(), [], "four weak scans after the enrollment are not enough, and earlier ones never count");
  insertScan("member", "after-4", "2026-09-30T11:05:00Z", 30);
  assert.deepEqual(await suggestions(), ["member"], "five weak scans after the enrollment flag again");

  const ahead = await report({ eventId: "local-ahead", rosterId: "member-b", enrolledAt: "2026-10-30T12:00:00Z" });
  assert.equal((await ahead.json() as { reenrolledAt: string }).reenrolledAt, "2026-09-30T12:00:00.000Z", "a kiosk clock running ahead counts as now");

  // Reports the kiosk drops instead of retrying.
  const refused = async (response: Response) => [response.status, (await response.json() as { code?: string }).code];
  assert.deepEqual(await refused(await report({ eventId: "local-missing", rosterId: "missing", enrolledAt: "2026-09-30T11:00:00Z" })), [404, "roster_inactive"]);
  database.sqlite.exec("UPDATE members SET active=0 WHERE id='member-b'");
  assert.deepEqual(await refused(await report({ eventId: "local-inactive", rosterId: "member-b", enrolledAt: "2026-09-30T12:00:00Z" })), [404, "roster_inactive"]);
  assert.deepEqual(await refused(await report({ eventId: "local-pairing", rosterId: "member", enrolledAt: "2026-09-30T11:30:00Z", pairingId: "another-pairing" })), [409, "pairing_mismatch"]);
  assert.deepEqual(await refused(await report({ eventId: "local-bad", rosterId: "member", enrolledAt: "yesterday" })), [400, "invalid_enrollment"]);
  assert.deepEqual(await refused(await report({ eventId: "local-template", rosterId: "member", enrolledAt: "2026-09-30T11:30:00Z", template: "AAAA" })), [400, "invalid_enrollment"], "nothing but the fact and time is accepted");
  assert.equal((await report({ eventId: "local-anonymous", rosterId: "member", enrolledAt: "2026-09-30T11:30:00Z" }, "not-a-kiosk-token")).status, 401);
  assert.equal(reenrolledAt("member"), "2026-09-30T11:00:00.000Z", "refused reports change nothing");
  assert.equal(audits().length, 3);
});

type Statement = { execute(): unknown };

async function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
  context.mock.method(globalThis, "fetch", () => { throw new Error("No live provider access is permitted in this fixture"); });
  const database = new Database(); context.after(() => database.sqlite.close());
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database } as unknown as Env;
  const codec = createSessionCodec(secret);
  const cookies = { admin: `lancerlogin_session=${await codec.issue({ userId: "admin", role: "admin" })}`, operator: `lancerlogin_session=${await codec.issue({ userId: "operator", role: "operator" })}` };
  const call = (path: string, body?: unknown, token?: string, method?: string, role: "admin" | "operator" = "admin") => worker.fetch(new Request(`https://api.example.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }), ...(token ? { authorization: `Bearer ${token}` } : { cookie: cookies[role] }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const pair = async (name: string) => {
    const created = await call("/admin/pairing-codes", { kioskName: name }); assert.equal(created.status, 201);
    const result = await call("/kiosk/pair", { code: (await created.json() as { code: string }).code, kioskName: name }); assert.equal(result.status, 201);
    return await result.json() as { kioskId: string; kioskToken: string; pairingId: string };
  };
  /** A synthetic accepted kiosk scan with an optional match score, outside any meeting's attendance rules. */
  const insertScan = (memberId: string, eventId: string, occurredAt: string, score?: number) => {
    database.sqlite.prepare("INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,kiosk_event_id,action) VALUES (?,'primary',?,NULL,'kiosk',?,?,'check_in')").run(`event-${eventId}`, memberId, occurredAt, eventId);
    if (score !== undefined) database.sqlite.prepare("INSERT INTO kiosk_scan_matches(installation_id,kiosk_event_id,kiosk_id,match_score,recorded_at) VALUES ('primary',?,'kiosk',?,?)").run(eventId, score, occurredAt);
  };
  return { database, call, pair, insertScan };
}

// Real SQLite with D1's atomic batch semantics, migrated from apps/api/migrations. All data is synthetic.
class Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    for (const name of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
    this.sqlite.exec(`
      INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('operator','primary','operator','operator','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
      INSERT INTO platform_module_assignment_epochs VALUES('primary','operator',0); INSERT INTO platform_module_assignment_revisions VALUES('primary','operator',0);
      INSERT INTO platform_module_assignments VALUES('primary','operator','attendance','["attendance.manage"]');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('member','primary','SYN-001','Test Student','A','student.a@example.test','2026-01-01');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('member-b','primary','SYN-002','Test Student','B','student.b@example.test','2026-01-01');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('meeting','primary','Test Meeting','2026-09-30T11:00:00Z','2026-09-30T13:00:00Z','admin','2026-01-01');
    `);
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    return {
      bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { return (database.sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { return { results: database.sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() { return this.execute(); },
      execute() {
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

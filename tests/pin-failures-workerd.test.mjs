// quick-check: covers apps/api/migrations/**
// Real D1 (workerd): a full offline wrong-PIN report fits the Workers Free plan's subrequests, and a scan queued without
// a PIN before Require PIN was turned on passes the PIN step. D1's own SQL engine runs the set-based statements.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { createMiniflareD1 } from "./fixtures/miniflare-d1.mjs";

// Cloudflare Workers Free allows 50 subrequests per invocation; each D1 query, or one batch, is one.
const FREE_PLAN_SUBREQUESTS = 50;

test("real D1 applies 200 offline wrong-PIN entries atomically within the Free plan's subrequests", { timeout: 120_000 }, async () => {
  // The wrapper counts D1 subrequests as Cloudflare does: one per first(), all() or run(), and one per batch.
  const bundled = await build({ stdin: { contents: `import worker from './apps/api/src/index.ts';
    function counting(database, count) {
      const originals = new WeakMap();
      const wrap = statement => { const wrapped = { bind: (...values) => wrap(statement.bind(...values)), first: (...args) => { count(); return statement.first(...args); }, all: () => { count(); return statement.all(); }, run: () => { count(); return statement.run(); }, raw: (...args) => { count(); return statement.raw(...args); } }; originals.set(wrapped, statement); return wrapped; };
      return { prepare: sql => wrap(database.prepare(sql)), batch: statements => { count(); return database.batch(statements.map(statement => originals.get(statement) ?? statement)); }, exec: sql => { count(); return database.exec(sql); } };
    }
    export default { async fetch(request, env) { let subrequests = 0; const result = await worker.fetch(request, { ...env, DB: counting(env.DB, () => { subrequests += 1; }) }); const response = new Response(result.body, result); response.headers.set('x-test-d1-subrequests', String(subrequests)); return response; } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
  const secret = "A".repeat(43), origin = "https://example.test";
  const { runtime, database } = await createMiniflareD1({ script: bundled.outputFiles[0].text, bindings: { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret } });
  try {
    await database.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
      INSERT INTO organization_settings(installation_id,time_zone,pin_lockout_enabled,pin_lockout_attempts,pin_lockout_minutes) VALUES ('primary','UTC',1,3,10);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<210) INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) SELECT 'test-member-'||x,'primary','TEST-'||x,'Test Student',CAST(x AS TEXT),'2026-01-01' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO member_pins(installation_id,member_id,pin_hash,pin_salt,pin_iterations,set_at,failed_attempts,locked_until,updated_at) SELECT 'primary','test-member-'||x,'synthetic-hash-'||x,'synthetic-salt',2000,'2026-09-01T00:00:00.000Z',0,NULL,'2026-09-01T00:00:00.000Z' FROM n;`.replace(/\n/g, " "));
    const payload = Buffer.from(JSON.stringify({ userId: "admin", role: "admin", expiresAt: Date.now() + 60_000 })).toString("base64url");
    const cookie = `lancerlogin_session=${payload}.${createHmac("sha256", Buffer.from(secret, "base64url")).update(payload).digest("base64url")}`;
    const call = (path, body, token, method = "POST") => runtime.dispatchFetch(`https://example.test${path}`, { method, headers: { "content-type": "application/json", origin, ...(token ? { authorization: `Bearer ${token}` } : { cookie }) }, body: JSON.stringify(body) });
    const created = await call("/admin/pairing-codes", { kioskName: "Test Kiosk A" }); assert.equal(created.status, 201, await created.clone().text());
    const paired = await call("/kiosk/pair", { code: (await created.json()).code, kioskName: "Test Kiosk A" }); assert.equal(paired.status, 201);
    const kiosk = await paired.json();
    // Require PIN can be turned on only at a Pi kiosk that reports a release with member PINs.
    assert.equal((await call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.1.0-beta.3" }, kiosk.kioskToken)).status, 200);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString(), hourAhead = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal((await call(`/admin/kiosks/${kiosk.kioskId}/authentication-method`, { authenticationMethod: "member_id", requirePin: true }, undefined, "PATCH")).status, 200);

    // No meeting is open, so a scan that passes the PIN step is refused for that instead: the PIN step let it through.
    const scan = (eventId, occurredAt) => call("/kiosk/attendance", { eventId, memberId: "TEST-1", occurredAt, pairingId: kiosk.pairingId }, kiosk.kioskToken);
    const before = await scan("test-scan-before", hourAgo); assert.equal((await before.json()).code, "no_eligible_meeting");
    assert.ok(Number(before.headers.get("x-test-d1-subrequests")) < FREE_PLAN_SUBREQUESTS);
    const after = await scan("test-scan-after", hourAhead); assert.equal(after.status, 400); assert.equal((await after.json()).code, "pin_required");

    const now = new Date().toISOString();
    // 1 to 150 by member ID with two tries, 151 to 195 by roster id with three; then no PIN, and not on the roster.
    const failures = Array.from({ length: 200 }, (_, index) => { const member = index + 1; return member <= 150 ? { memberId: `TEST-${member}`, count: 2, lastAt: now } : member <= 195 ? { memberId: `test-member-${member}`, count: 3, lastAt: now } : member <= 198 ? { memberId: `TEST-${member + 5}`, count: 3, lastAt: now } : { memberId: `TEST-NOBODY-${member}`, count: 3, lastAt: now }; });
    failures[0] = { memberId: "TEST-1", count: 5, lastAt: "2026-08-31T00:00:00.000Z" }; // before the current PIN was set
    const state = () => database.prepare("SELECT COUNT(*) AS changed, COALESCE(SUM(failed_attempts), 0) AS tries, COALESCE(SUM(locked_until IS NOT NULL), 0) AS locked, (SELECT COUNT(*) FROM audit_log WHERE action = 'member_pin.locked') AS audits FROM member_pins WHERE updated_at <> '2026-09-01T00:00:00.000Z'").first();

    // A report that fails part-way leaves nothing behind, so the kiosk's retry cannot count anything twice.
    await database.exec("CREATE TRIGGER test_fail_report BEFORE UPDATE ON member_pins WHEN OLD.member_id = 'test-member-190' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    assert.equal((await call("/kiosk/pin-failures", { failures }, kiosk.kioskToken)).status, 500);
    assert.deepEqual(await state(), { changed: 0, tries: 0, locked: 0, audits: 0 });
    await database.exec("DROP TRIGGER test_fail_report");

    const full = await call("/kiosk/pin-failures", { failures }, kiosk.kioskToken);
    assert.equal(full.status, 200, await full.clone().text());
    assert.deepEqual(await full.json(), { recorded: 149 * 2 + 45 * 3 });
    const fullSubrequests = Number(full.headers.get("x-test-d1-subrequests"));
    assert.ok(fullSubrequests > 0 && fullSubrequests <= 10, `${fullSubrequests} subrequests for 200 entries`);
    assert.ok(fullSubrequests < FREE_PLAN_SUBREQUESTS);
    assert.deepEqual(await state(), { changed: 194, tries: 149 * 2 + 45 * 3, locked: 45, audits: 45 });
    const audit = await database.prepare("SELECT id, metadata_json AS metadata FROM audit_log WHERE action = 'member_pin.locked' AND target_id = 'test-member-151'").first();
    assert.match(audit.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const metadata = JSON.parse(audit.metadata);
    assert.deepEqual({ ...metadata, lockedUntil: typeof metadata.lockedUntil }, { kioskId: kiosk.kioskId, via: "offline_report", failedAttempts: 3, lockedUntil: "string", minutes: 10 });
    assert.equal((await database.prepare("SELECT locked_until AS lockedUntil FROM member_pins WHERE member_id = 'test-member-151'").first()).lockedUntil, metadata.lockedUntil);

    const single = await call("/kiosk/pin-failures", { failures: [{ memberId: "TEST-2", count: 1, lastAt: new Date().toISOString() }] }, kiosk.kioskToken);
    assert.deepEqual(await single.json(), { recorded: 1 });
    assert.equal(Number(single.headers.get("x-test-d1-subrequests")), fullSubrequests, "200 entries cost what one entry costs");

    // With a report id (kiosks from 2.1.0-beta.9), on D1's own engine: the id is recorded in the same batch, a resend
    // is answered with the first result and counts nothing, and the request costs what it does without an id.
    await database.exec("UPDATE member_pins SET failed_attempts = 0, locked_until = NULL, updated_at = '2026-09-01T00:00:00.000Z'; DELETE FROM audit_log WHERE action = 'member_pin.locked'");
    const named = await call("/kiosk/pin-failures", { reportId: "test-report-1", failures }, kiosk.kioskToken);
    assert.equal(named.status, 200, await named.clone().text());
    assert.deepEqual(await named.json(), { recorded: 149 * 2 + 45 * 3 });
    assert.equal(Number(named.headers.get("x-test-d1-subrequests")), fullSubrequests, "a report id adds no D1 subrequest");
    const applied = { changed: 194, tries: 149 * 2 + 45 * 3, locked: 45, audits: 45 };
    assert.deepEqual(await state(), applied);
    for (let resend = 0; resend < 2; resend += 1) {
      const again = await call("/kiosk/pin-failures", { reportId: "test-report-1", failures }, kiosk.kioskToken);
      assert.deepEqual(await again.json(), { recorded: 149 * 2 + 45 * 3 }, "a resend gets the first answer");
      assert.equal(Number(again.headers.get("x-test-d1-subrequests")), fullSubrequests, "and costs the same");
      assert.deepEqual(await state(), applied, "and counts, locks and audits nothing again");
    }
    assert.deepEqual(await database.prepare("SELECT kiosk_id AS kiosk, report_id AS id, recorded FROM kiosk_pin_failure_reports").all().then(result => result.results), [{ kiosk: kiosk.kioskId, id: "test-report-1", recorded: 149 * 2 + 45 * 3 }]);
    // An id older than 30 days is removed by the next report with an id, in that report's batch.
    await database.exec("UPDATE kiosk_pin_failure_reports SET applied_at = '2026-01-01T00:00:00.000Z'");
    const next = await call("/kiosk/pin-failures", { reportId: "test-report-2", failures: [{ memberId: "TEST-200", count: 1, lastAt: new Date().toISOString() }] }, kiosk.kioskToken);
    assert.deepEqual(await next.json(), { recorded: 1 });
    assert.equal(Number(next.headers.get("x-test-d1-subrequests")), fullSubrequests);
    assert.deepEqual((await database.prepare("SELECT report_id AS id FROM kiosk_pin_failure_reports").all()).results, [{ id: "test-report-2" }]);
    // The Require PIN lookup uses the index of migration 0101 on D1's engine too.
    const plan = (await database.prepare("EXPLAIN QUERY PLAN SELECT MAX(created_at) AS turnedOnAt FROM audit_log WHERE installation_id = 'primary' AND action = 'kiosk.authentication_method_updated' AND target_type = 'kiosk' AND target_id = ? AND json_extract(metadata_json, '$.requirePin') = 1 AND json_extract(metadata_json, '$.previousRequirePin') = 0").bind(kiosk.kioskId).all()).results.map(row => row.detail).join("; ");
    assert.match(plan, /USING INDEX audit_log_kiosk_method_updates/, plan);

    // The online claim on D1's own engine: with lockout at three tries (the seed), twelve wrong PINs sent at once have
    // exactly three checked. The claim reads the lockout setting and starts the lock in its one statement.
    assert.equal((await call("/kiosk/pins", { memberId: "TEST-205", pin: "2468" }, kiosk.kioskToken)).status, 201);
    const startedAt = Date.now();
    const tries = await Promise.all(Array.from({ length: 12 }, (_, index) => call("/kiosk/attendance", { eventId: `test-burst-${index}`, memberId: "TEST-205", occurredAt: new Date().toISOString(), pairingId: kiosk.pairingId, pin: String(1000 + index) }, kiosk.kioskToken)));
    const answers = await Promise.all(tries.map(async result => ({ status: result.status, subrequests: Number(result.headers.get("x-test-d1-subrequests")), ...await result.json() })));
    assert.equal(answers.filter(answer => answer.status === 403 && answer.code === "pin_incorrect").length, 3, JSON.stringify(answers));
    assert.equal(answers.filter(answer => answer.status === 423 && answer.code === "pin_locked").length, 9, JSON.stringify(answers));
    assert.deepEqual(answers.filter(answer => answer.code === "pin_incorrect").map(answer => answer.attemptsLeft).sort(), [0, 1, 2]);
    const burstPin = await database.prepare("SELECT failed_attempts AS failed, locked_until AS lockedUntil, throttle_failures AS throttle FROM member_pins WHERE member_id = 'test-member-205'").first();
    assert.deepEqual({ failed: burstPin.failed, throttle: burstPin.throttle }, { failed: 3, throttle: 3 });
    // The lock's end is written by SQLite in the format of Date.toISOString(), ten minutes after the try.
    assert.match(burstPin.lockedUntil, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); assert.equal(new Date(burstPin.lockedUntil).toISOString(), burstPin.lockedUntil);
    assert.ok(Date.parse(burstPin.lockedUntil) >= startedAt + 600_000 && Date.parse(burstPin.lockedUntil) <= Date.now() + 600_000, burstPin.lockedUntil);
    const burstAudits = (await database.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'member_pin.locked' AND target_id = 'test-member-205'").all()).results.map(row => JSON.parse(row.metadata));
    assert.deepEqual(burstAudits, [{ kioskId: kiosk.kioskId, via: "kiosk", failedAttempts: 3, lockedUntil: burstPin.lockedUntil, minutes: 10 }]);
    assert.ok(answers.every(answer => answer.subrequests < FREE_PLAN_SUBREQUESTS));
    console.log(JSON.stringify({ benchmark: "synthetic_pin_failure_report", entries: 200, d1Subrequests: fullSubrequests, d1SubrequestsWithReportId: Number(named.headers.get("x-test-d1-subrequests")), d1SubrequestsResend: fullSubrequests, freePlanLimit: FREE_PLAN_SUBREQUESTS }));
  } finally { await runtime.dispose(); }
});

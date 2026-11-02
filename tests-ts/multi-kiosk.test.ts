// quick-check: covers apps/api/migrations/**
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";

const secret = "A".repeat(43);
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

test("dashboard enrollment is kiosk-bound, confirms a current member and accepts only ordered progress", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Synthetic enrollment"), other = await pair("Synthetic other");
  database.sqlite.prepare("UPDATE kiosks SET last_seen_at=?,reader_online=1,authentication_method='fingerprint' WHERE id=?").run(new Date().toISOString(), device.kioskId);
  const path = `/admin/kiosks/${device.kioskId}/enrollment`;
  const started = await call(path, {}); assert.equal(started.status, 201, await started.clone().text());
  const { session } = await started.json() as { session: { id: string; state: string; expiresAt: string } };
  assert.equal(session.state, "waiting_member");
  assert.ok(Date.parse(session.expiresAt) - Date.now() <= 300_000);
  assert.equal((await call(path, {})).status, 409);
  const poll = await call("/kiosk/poll?v=1&enrollment=1", undefined, device.kioskToken);
  assert.equal((await poll.json() as { enrollment: { id: string } }).enrollment.id, session.id);
  assert.equal((await (await call("/kiosk/enrollment", undefined, other.kioskToken)).json() as { enrollment: unknown }).enrollment, null);
  const progress = `/kiosk/enrollment/${session.id}/progress`;
  assert.equal((await call(progress, { status: "enroll_wait_first" }, device.kioskToken)).status, 409);
  assert.equal((await call(`${path}/${session.id}`, { memberId: "member" }, undefined, "PATCH")).status, 200);
  assert.equal((await call(`${path}/${session.id}`, { memberId: "member" }, undefined, "PATCH")).status, 409);
  assert.equal((await call(progress, { status: "enroll_success" }, device.kioskToken)).status, 409);
  assert.equal((await call(progress, { status: "awaiting_confirmation" }, other.kioskToken)).status, 409);
  for (const status of ["awaiting_confirmation", "enroll_wait_first", "enroll_remove", "enroll_wait_second", "enroll_success"]) {
    const result = await call(progress, { status }, device.kioskToken); assert.equal(result.status, 200, await result.clone().text());
  }
  assert.equal((await call(progress, { status: "enroll_wait_first" }, device.kioskToken)).status, 409);
  assert.equal((await call(path, {})).status, 201);
});

test("enrollment authority expires and follows member, creator, pairing and kiosk revocation", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Synthetic enrollment revocation");
  database.sqlite.prepare("UPDATE kiosks SET last_seen_at=?,reader_online=1,authentication_method='fingerprint' WHERE id=?").run(new Date().toISOString(), device.kioskId);
  const path = `/admin/kiosks/${device.kioskId}/enrollment`;
  const { session } = await (await call(path, {})).json() as { session: { id: string } };
  await call(`${path}/${session.id}`, { memberId: "member" }, undefined, "PATCH");
  for (const [revoke, restore] of [
    ["UPDATE members SET active=0 WHERE id='member'", "UPDATE members SET active=1 WHERE id='member'"],
    ["UPDATE users SET role='operator' WHERE id='admin'", "UPDATE users SET role='admin' WHERE id='admin'"],
    ["UPDATE kiosks SET configured_authentication_method='member_id'", "UPDATE kiosks SET configured_authentication_method='fingerprint'"],
  ]) {
    database.sqlite.exec(revoke);
    assert.equal((await (await call("/kiosk/enrollment", undefined, device.kioskToken)).json() as { enrollment: unknown }).enrollment, null);
    assert.equal((await call(`/kiosk/enrollment/${session.id}/progress`, { status: "enroll_wait_first" }, device.kioskToken)).status, 409);
    database.sqlite.exec(restore);
  }
  database.sqlite.prepare("UPDATE kiosk_enrollment_sessions SET expires_at=?").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await (await call("/kiosk/enrollment", undefined, device.kioskToken)).json() as { enrollment: unknown }).enrollment, null);
  assert.equal((await (await call(path)).json() as { session: { progress: string } }).session.progress, "expired");
  database.sqlite.exec("UPDATE kiosks SET active=0");
  assert.equal((await call("/kiosk/enrollment", undefined, device.kioskToken)).status, 401);
});

test("a revoked member grant does not block a fresh enrollment session", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Synthetic enrollment recovery"), path = `/admin/kiosks/${device.kioskId}/enrollment`;
  database.sqlite.prepare("UPDATE kiosks SET last_seen_at=?,reader_online=1,authentication_method='fingerprint' WHERE id=?").run(new Date().toISOString(), device.kioskId);
  const { session } = await (await call(path, {})).json() as { session: { id: string } };
  await call(`${path}/${session.id}`, { memberId: "member" }, undefined, "PATCH");
  database.sqlite.exec("UPDATE members SET active=0 WHERE id='member'");
  const replacement = await call(path, {}); assert.equal(replacement.status, 201);
  assert.notEqual((await replacement.json() as { session: { id: string } }).session.id, session.id);
  assert.equal((await call(`/kiosk/enrollment/${session.id}/progress`, { status: "enroll_wait_first" }, device.kioskToken)).status, 409);
});

test("cancelled remote enrollment cannot resume and offline kiosks cannot start it", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Synthetic enrollment cancel"), path = `/admin/kiosks/${device.kioskId}/enrollment`;
  assert.equal((await call(path, {})).status, 409);
  database.sqlite.prepare("UPDATE kiosks SET last_seen_at=?,reader_online=1,authentication_method='fingerprint' WHERE id=?").run(new Date().toISOString(), device.kioskId);
  const { session } = await (await call(path, {})).json() as { session: { id: string } };
  assert.equal((await call(`${path}/${session.id}`, undefined, undefined, "DELETE")).status, 403);
  assert.equal((await call(`${path}/${session.id}`, {}, undefined, "DELETE")).status, 200);
  assert.equal((await call(`${path}/${session.id}`, { memberId: "member" }, undefined, "PATCH")).status, 409);
  assert.equal((await call(`/kiosk/enrollment/${session.id}/progress`, { status: "enroll_wait_first" }, device.kioskToken)).status, 409);
});

type Statement = { sql: string; execute(): unknown };
const pairingRead = (sql: string) => sql.includes("SELECT id, kiosk_name AS kioskName FROM pairing_codes WHERE") && sql.includes("purpose = 'hardware'");

// Real SQLite with D1's atomic batch semantics. The optional read barrier makes
// both requests observe an unredeemed code before either transaction starts.
// The pairing route reads through the module-scoped database, which sends every
// read as a guarded batch, so the barrier applies to batches as well as first().
class Database {
  sqlite = new DatabaseSync(":memory:");
  pairingRace?: { reads: number; ready: Promise<void>; release(): void };
  constructor(legacySchema = false) {
    for (const name of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql") && (!legacySchema || (Number.parseInt(name, 10) <= 53 || name.startsWith("0073_") || name.startsWith("0081_") || name.startsWith("0090_") || name.startsWith("0091_")))).sort()) {
      this.sqlite.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
    }
    this.sqlite.exec(`
      INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES ('member','primary','SYN-001','Synthetic','Member','2026-01-01');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('meeting','primary','Synthetic meeting','2026-09-30T11:00:00Z','2026-09-30T13:00:00Z','admin','2026-01-01');
    `);
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    const statement = {
      sql,
      bind(...values: unknown[]) { params = values; return this; },
      async first<T>() {
        const row = database.sqlite.prepare(sql).get(...params as []) ?? null;
        if (pairingRead(sql)) await database.awaitPairingRace();
        return row as T | null;
      },
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
    return statement;
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    let result: unknown[];
    try { result = statements.map(statement => statement.execute()); this.sqlite.exec("COMMIT"); }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    if (statements.some(statement => pairingRead(statement.sql))) await this.awaitPairingRace();
    return result;
  }
  // Called after a pairing read has run: the first read waits until the second has also run.
  async awaitPairingRace() {
    const race = this.pairingRace;
    if (!race) return;
    if (++race.reads === 2) race.release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([race.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Pairing race did not reach both reads")), 2_000); })]); }
    finally { clearTimeout(timer); }
  }
  racePairingReads() {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    this.pairingRace = { reads: 0, ready, release };
  }
}

async function fixture(context: TestContext, legacySchema = false) {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
  context.mock.method(globalThis, "fetch", () => { throw new Error("No live provider access is permitted in this fixture"); });
  const database = new Database(legacySchema); context.after(() => database.sqlite.close());
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database } as unknown as Env;
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const call = (path: string, body?: unknown, token?: string, method?: string) => worker.fetch(new Request(`https://api.example.test${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }), ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const code = async (name: string) => {
    const result = await call("/admin/pairing-codes", { kioskName: name }); assert.equal(result.status, 201);
    return (await result.json() as { code: string }).code;
  };
  const pair = async (name: string) => {
    const result = await call("/kiosk/pair", { code: await code(name), kioskName: name }); assert.equal(result.status, 201);
    return await result.json() as { kioskId: string; kioskToken: string; pairingId: string };
  };
  return { database, call, code, pair };
}

test("retired peer endpoints fail closed while old clients receive disabled metadata", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Synthetic entrance");
  database.sqlite.prepare("INSERT INTO kiosk_fingerprint_sync(installation_id,sync_id,enabled) VALUES('primary',?,1)").run("a".repeat(64));
  const snapshot = database.sqlite.prepare("SELECT * FROM kiosk_fingerprint_sync").all();
  assert.equal((await call("/admin/kiosks/fingerprint-sync")).status, 410);
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).status, 410);
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync", undefined, device.kioskToken)).json(), { enabled: false, syncId: null });
  for (const path of ["identity", "peers", "deliveries", "deliveries/obsolete/result"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) assert.equal((await call(`/kiosk/fingerprint-sync/${path}`, undefined, device.kioskToken, method)).status, 410);
  }
  const poll = await (await call("/kiosk/poll?v=1&fingerprints=1", undefined, device.kioskToken)).json() as { fingerprints: { peer: unknown } };
  assert.deepEqual(poll.fingerprints.peer, { status: "ok", enabled: false, syncId: null, deliveries: [] });
  assert.deepEqual(database.sqlite.prepare("SELECT * FROM kiosk_fingerprint_sync").all(), snapshot);
  assert.equal((await call("/kiosk/fingerprint-sync", undefined, "invalid-token")).status, 401);
});

test("real SQLite concurrent redemption consumes one code even at an identical timestamp", async (context) => {
  const { database, call, code } = await fixture(context);
  const key = await code("First entrance"); database.racePairingReads();
  const results = await Promise.all([call("/kiosk/pair", { code: key, kioskName: "First entrance" }), call("/kiosk/pair", { code: key, kioskName: "Second entrance" })]);
  // Both requests read the unredeemed code before either redeemed it.
  assert.equal(database.pairingRace?.reads, 2);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosks WHERE active = 1").get()?.n, 1);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kiosk.paired'").get()?.n, 1);
  database.pairingRace = undefined;
  assert.equal((await call("/kiosk/pair", { code: key, kioskName: "Third entrance" })).status, 401);
});

test("real SQLite web kiosks pair by code alone and replace only a kiosk that stopped checking in", async (context) => {
  const { database, call } = await fixture(context);
  const webCode = async (input: Record<string, unknown>) => call("/admin/pairing-codes", { kind: "web", ...input });
  const created = await webCode({ kioskName: "Test Web Kiosk A" }); assert.equal(created.status, 201);
  const { code, displayCode } = await created.json() as { code: string; displayCode: string };
  assert.equal(database.sqlite.prepare("SELECT kiosk_kind AS kind, kiosk_name AS name FROM pairing_codes WHERE code_hash = ?").get(hash(code))?.name, "Test Web Kiosk A");
  assert.equal((await call("/kiosk/pair", { code, kioskName: "Test Pi Kiosk B" })).status, 401);
  const paired = await call("/kiosk/pair", { code: displayCode.toLowerCase() }); assert.equal(paired.status, 201, await paired.clone().text());
  const web = await paired.json() as { kioskId: string; kioskToken: string; name: string; kind: string };
  assert.equal(web.name, "Test Web Kiosk A"); assert.equal(web.kind, "web");
  assert.deepEqual({ ...database.sqlite.prepare("SELECT kind, member_lookup, configured_authentication_method, authentication_method FROM kiosks WHERE id = ?").get(web.kioskId) }, { kind: "web", member_lookup: "entry", configured_authentication_method: "member_id", authentication_method: "member_id" });
  assert.equal((await call("/kiosk/pair", { code })).status, 401);
  const piCode = (await (await call("/admin/pairing-codes", { kioskName: "Test Pi Kiosk B" })).json() as { code: string; kind: string }).code;
  assert.equal((await call("/kiosk/pair", { code: piCode })).status, 401);
  assert.equal((await call(`/admin/kiosks/${web.kioskId}/commands`, { command: "reboot" })).status, 409);

  const heartbeat = await call("/kiosk/heartbeat", { readerOnline: true, authenticationMethod: "member_id", releaseVersion: "2.0.0-beta.20", pendingEvents: 0 }, web.kioskToken); assert.equal(heartbeat.status, 200);
  const live = await webCode({ kioskName: "test web kiosk a" }); assert.equal(live.status, 409);
  assert.deepEqual(await live.json(), { error: "An active kiosk already uses that name. Choose a distinct device name.", code: "kiosk_name_in_use" });
  assert.equal((await webCode({ kioskName: "Test Web Kiosk A", replaceKioskId: web.kioskId })).status, 409);
  assert.equal(database.sqlite.prepare("SELECT active FROM kiosks WHERE id = ?").get(web.kioskId)?.active, 1);

  context.mock.timers.tick(11 * 60_000);
  const offered = await webCode({ kioskName: "Test Web Kiosk A" }); assert.equal(offered.status, 409);
  assert.equal((await offered.json() as { replaceableKioskId?: string }).replaceableKioskId, web.kioskId);
  const replacement = await webCode({ kioskName: "Test Web Kiosk A", replaceKioskId: web.kioskId }); assert.equal(replacement.status, 201, await replacement.clone().text());
  assert.equal(database.sqlite.prepare("SELECT active FROM kiosks WHERE id = ?").get(web.kioskId)?.active, 0);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kiosk.replaced' AND target_id = ?").get(web.kioskId)?.n, 1);
  assert.equal((await call("/kiosk/config", undefined, web.kioskToken)).status, 401);
  const next = await call("/kiosk/pair", { code: (await replacement.json() as { code: string }).code }); assert.equal(next.status, 201);
  assert.notEqual((await next.json() as { kioskId: string }).kioskId, web.kioskId);
  // A new web code cancels only earlier unused web codes, never a Pi code.
  const piLater = (await (await call("/admin/pairing-codes", { kioskName: "Test Pi Kiosk C" })).json() as { code: string }).code;
  const earlierWeb = (await (await webCode({ kioskName: "Test Web Kiosk D" })).json() as { code: string }).code;
  assert.equal((await webCode({ kioskName: "Test Web Kiosk E" })).status, 201);
  assert.equal((await call("/kiosk/pair", { code: earlierWeb })).status, 401);
  assert.equal((await call("/kiosk/pair", { code: piLater, kioskName: "Test Pi Kiosk C" })).status, 201);
});

test("real SQLite duplicate names fail without consuming the losing pairing code", async (context) => {
  const { database, call, pair } = await fixture(context);
  await pair("Front entrance");
  assert.equal((await call("/admin/pairing-codes", { kioskName: "FRONT ENTRANCE" })).status, 409);
  const key = randomUUID(); const id = randomUUID();
  database.sqlite.prepare("INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at,purpose) VALUES (?,'primary',?,'2026-09-30T12:10:00Z','admin','2026-09-30T12:00:00Z','hardware')").run(id, hash(key.toUpperCase()));
  assert.equal((await call("/kiosk/pair", { code: key, kioskName: "front entrance" })).status, 409);
  assert.equal(database.sqlite.prepare("SELECT redeemed_at FROM pairing_codes WHERE id = ?").get(id)?.redeemed_at, null);
  assert.equal((await call("/kiosk/pair", { code: key, kioskName: "Side entrance" })).status, 201);
});

test("real SQLite kiosks retain independent health, commands, scan bindings and retirement", async (context) => {
  const { database, call, pair } = await fixture(context);
  const first = await pair("Front entrance"); const second = await pair("Side entrance");
  assert.notEqual(first.kioskToken, second.kioskToken); assert.notEqual(first.pairingId, second.pairingId);
  const heartbeat = (device: typeof first, pendingEvents: number) => call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "1.2.4", pendingEvents }, device.kioskToken);
  assert.equal((await heartbeat(first, 2)).status, 200); assert.equal((await heartbeat(second, 5)).status, 200);
  const status = await call("/admin/kiosks"); assert.equal(status.status, 200);
  const devices = (await status.json() as { kiosks: Array<{ id: string; pendingEvents: number; active: number }> }).kiosks;
  assert.equal(devices.length, 2); assert.equal(devices.find(device => device.id === first.kioskId)?.pendingEvents, 2);
  assert.equal(devices.find(device => device.id === second.kioskId)?.pendingEvents, 5);
  const queued = await call(`/admin/kiosks/${first.kioskId}/commands`, { command: "reload_display" }); assert.equal(queued.status, 202);
  const command = (await queued.json() as { command: { id: string } }).command;
  assert.equal((await (await call("/kiosk/commands", undefined, second.kioskToken)).json() as { command: unknown }).command, null);
  assert.equal((await call(`/kiosk/commands/${command.id}/result`, { success: true }, second.kioskToken)).status, 404);
  assert.equal((await call(`/kiosk/commands/${command.id}/result`, { success: true }, first.kioskToken)).status, 200);
  const event = { eventId: "synthetic-scan", memberId: "SYN-001", occurredAt: "2026-09-30T12:00:00Z", pairingId: first.pairingId };
  const mismatch = await call("/kiosk/attendance", event, second.kioskToken);
  assert.equal(mismatch.status, 409);
  // Kiosks key permanent rejection on this stable code, not on the message text.
  assert.equal((await mismatch.json() as { code?: string }).code, "pairing_mismatch");
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM attendance_events").get()?.n, 0);
  assert.equal((await call("/kiosk/attendance", event, first.kioskToken)).status, 202);
  assert.equal((await call("/kiosk/attendance", event, first.kioskToken)).status, 200);
  assert.equal((await call(`/admin/kiosks/${first.kioskId}`, { confirmation: "RETIRE KIOSK" }, undefined, "DELETE")).status, 200);
  assert.equal((await heartbeat(first, 0)).status, 401); assert.equal((await heartbeat(second, 0)).status, 200);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosks WHERE active = 1").get()?.n, 1);
});

test("heartbeat attention details reach the Kiosks page and report open cloud reviews only when the kiosk has some", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Front entrance");
  const heartbeat = (attention?: unknown) => call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.0.0-beta.14", errorCategory: "offline_queue", ...(attention === undefined ? {} : { attention }) }, device.kioskToken);
  const insert = database.sqlite.prepare("INSERT INTO kiosk_scan_reviews(installation_id,kiosk_id,event_id,record_json,received_at,review_status) VALUES ('primary',?,?,'{}','2026-10-27T00:00:00Z',?)");
  for (const [eventId, status] of [["synthetic-a", "reviewed"], ["synthetic-b", "open"], ["synthetic-c", "reviewed"]]) insert.run(device.kioskId, eventId, status);
  const attention = { scansNeedReview: 3, clockConfirmed: false, clockPendingScans: 2, reviewSyncFailing: false };
  const reply = await heartbeat(attention); assert.equal(reply.status, 200, await reply.clone().text());
  assert.equal((await reply.json() as { openScanReviews?: number }).openScanReviews, 1, "two of the kiosk's three were reviewed in the dashboard");
  const listed = (await (await call("/admin/kiosks")).json() as { kiosks: Array<Record<string, unknown>> }).kiosks[0];
  assert.deepEqual([listed.scansNeedReview, listed.clockConfirmed, listed.clockPendingScans, listed.reviewSyncFailing], [3, 0, 2, 0]);
  const clear = await heartbeat({ ...attention, scansNeedReview: 0 });
  assert.equal("openScanReviews" in (await clear.json() as object), false, "nothing to review costs no cloud read");
  const legacy = await heartbeat(); assert.equal(legacy.status, 200);
  assert.equal("openScanReviews" in (await legacy.json() as object), false);
  const unknown = (await (await call("/admin/kiosks")).json() as { kiosks: Array<Record<string, unknown>> }).kiosks[0];
  assert.deepEqual([unknown.scansNeedReview, unknown.clockConfirmed, unknown.clockPendingScans, unknown.reviewSyncFailing], [null, null, null, null], "older kiosks report no details");
  for (const invalid of [{ ...attention, scansNeedReview: -1 }, { ...attention, clockConfirmed: "no" }, { ...attention, extra: 1 }, [attention]]) assert.equal((await heartbeat(invalid)).status, 400);
});

test("rejected scans never degrade a kiosk while attendance stuck on it still does", async context => {
  const { call, pair } = await fixture(context);
  const device = await pair("Front entrance");
  const ok = { scansNeedReview: 0, clockConfirmed: true, clockPendingScans: 0, reviewSyncFailing: false };
  const category = async (errorCategory: string, attention?: Record<string, unknown>, pendingEvents = 0) => {
    const reply = await call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.0.0-beta.14", errorCategory, pendingEvents, ...(attention ? { attention: { ...ok, ...attention } } : {}) }, device.kioskToken);
    assert.equal(reply.status, 200, await reply.clone().text());
    return ((await (await call("/admin/kiosks")).json()) as { kiosks: Array<{ errorCategory: string | null; reviewSyncFailing: number | null }> }).kiosks[0]!;
  };
  assert.equal((await category("offline_queue", { scansNeedReview: 4 })).errorCategory, null, "unreviewed rejected scans alone");
  const failing = await category("cloud_sync", { scansNeedReview: 2, reviewSyncFailing: true });
  assert.equal(failing.errorCategory, null, "a failed review upload alone"); assert.equal(failing.reviewSyncFailing, 1, "the failure stays visible to Debug tools");
  assert.equal((await category("offline_queue", { scansNeedReview: 4, clockConfirmed: false })).errorCategory, "offline_queue", "an unconfirmed clock holds attendance");
  assert.equal((await category("offline_queue", { clockPendingScans: 3 })).errorCategory, "offline_queue", "scans saved while the clock was unconfirmed");
  assert.equal((await category("cloud_sync", { reviewSyncFailing: true }, 5)).errorCategory, "cloud_sync", "attendance waiting to upload behind a review failure");
  assert.equal((await category("reader", { scansNeedReview: 1 })).errorCategory, "reader");
  assert.equal((await category("offline_queue")).errorCategory, "offline_queue", "older kiosks report no causes and keep their category");
});

test("fingerprint match scores are recorded for every uploaded scan and the minimum score reaches kiosks", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Front entrance");
  const match = async () => await (await call("/admin/kiosks/fingerprint-match")).json() as { minimumScore: number; recent: { scans: number; lowest: number | null; below150: number } };
  assert.equal((await match()).minimumScore, 0, "every reader match is accepted until an Admin sets a minimum");
  for (const invalid of [{ minimumScore: -1 }, { minimumScore: 1001 }, { minimumScore: 1.5 }, { minimumScore: 120, extra: 1 }, {}]) assert.equal((await call("/admin/kiosks/fingerprint-match", invalid, undefined, "PUT")).status, 400);
  const saved = await call("/admin/kiosks/fingerprint-match", { minimumScore: 120 }, undefined, "PUT"); assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await match()).minimumScore, 120);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='kiosk.fingerprint_minimum_score_changed'").get()?.n, 1);
  const polled = await (await call("/kiosk/poll?v=1&config=1", undefined, device.kioskToken)).json() as { configuration: { settings: { fingerprintMinimumScore: number } } };
  assert.equal(polled.configuration.settings.fingerprintMinimumScore, 120);
  const legacy = await (await call("/kiosk/config", undefined, device.kioskToken)).json() as { settings: { fingerprintMinimumScore: number } };
  assert.equal(legacy.settings.fingerprintMinimumScore, 120);
  const scan = (eventId: string, memberId: string, matchScore?: unknown) => call("/kiosk/attendance", { eventId, memberId, occurredAt: "2026-09-30T12:00:00Z", pairingId: device.pairingId, ...(matchScore === undefined ? {} : { matchScore }) }, device.kioskToken);
  assert.equal((await scan("synthetic-accepted", "SYN-001", 143)).status, 202);
  assert.equal((await scan("synthetic-unknown", "SYN-NOT-ON-ROSTER", 61)).status, 404, "a rejected scan keeps its rejection");
  assert.equal((await scan("synthetic-invalid-score", "SYN-001", "high")).status, 200, "an invalid score never refuses the scan");
  assert.equal((await scan("synthetic-no-score", "SYN-001")).status, 200);
  assert.deepEqual(database.sqlite.prepare("SELECT kiosk_event_id AS eventId,match_score AS score,kiosk_id AS kioskId FROM kiosk_scan_matches ORDER BY kiosk_event_id").all().map(row => ({ ...row })),
    [{ eventId: "synthetic-accepted", score: 143, kioskId: device.kioskId }, { eventId: "synthetic-unknown", score: 61, kioskId: device.kioskId }]);
  const recent = (await match()).recent; assert.deepEqual([recent.scans, recent.lowest, recent.below150], [2, 61, 2]);
  const attention = { scansNeedReview: 0, clockConfirmed: true, clockPendingScans: 0, reviewSyncFailing: false };
  assert.equal((await call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.0.0-beta.14", attention: { ...attention, weakMatches: 3 } }, device.kioskToken)).status, 200);
  const listed = await (await call("/admin/kiosks")).json() as { kiosks: Array<{ weakMatches: number | null }> };
  assert.equal(listed.kiosks[0].weakMatches, 3);
  assert.equal((await call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.0.0-beta.14", attention: { ...attention, weakMatches: -1 } }, device.kioskToken)).status, 400);
});

test("the reader cleanup command is queued only for kiosks that report reader counts", async context => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Front entrance");
  const erase = () => call(`/admin/kiosks/${device.kioskId}/commands`, { command: "erase_unlinked_fingerprints" });
  const refused = await erase(); assert.equal(refused.status, 409, "a kiosk before 2.0.0-beta.14 would reject the unknown command");
  assert.match((await refused.json() as { error: string }).error, /2.0.0-beta.14/);
  const attention = { scansNeedReview: 0, clockConfirmed: true, clockPendingScans: 0, reviewSyncFailing: false, weakMatches: 0 };
  const heartbeat = (extra: Record<string, unknown>) => call("/kiosk/heartbeat", { readerOnline: true, releaseVersion: "2.0.0-beta.14", attention: { ...attention, ...extra } }, device.kioskToken);
  for (const invalid of [{ readerTemplates: 190 }, { readerTemplates: 190, linkedTemplates: -1 }, { readerTemplates: 2000, linkedTemplates: 1 }]) assert.equal((await heartbeat(invalid)).status, 400);
  assert.equal((await heartbeat({ readerTemplates: 190, linkedTemplates: 113 })).status, 200);
  const listed = await (await call("/admin/kiosks")).json() as { kiosks: Array<{ readerTemplates: number; linkedTemplates: number }> };
  assert.deepEqual([listed.kiosks[0].readerTemplates, listed.kiosks[0].linkedTemplates], [190, 113]);
  const queued = await erase(); assert.equal(queued.status, 202, await queued.clone().text());
  const polled = await (await call("/kiosk/poll?v=1", undefined, device.kioskToken)).json() as { command: { type: string } };
  assert.equal(polled.command.type, "erase_unlinked_fingerprints");
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_commands WHERE command_type='erase_unlinked_fingerprints'").get()?.n, 1);
});

test("migration 0085 keeps kiosk command history while allowing the reader cleanup command", () => {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of files.filter(name => name < "0085")) sqlite.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
  sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
    INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
    INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at,purpose) VALUES ('code','primary','code-hash','2026-01-02','admin','2026-01-01','hardware');
    INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,active,created_at) VALUES ('kiosk','primary','code','Front','hash',1,'2026-01-01');
    INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at,completed_at,success,result_message,requested_release_version,update_channel,requested_release_sha)
      VALUES ('history','primary','kiosk','install_latest','admin','2026-10-01','2026-10-01',1,'Verified kiosk update started','v2.0.0-beta.13','beta','synthetic-sha');`);
  assert.throws(() => sqlite.exec("INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at) VALUES ('early','primary','kiosk','erase_unlinked_fingerprints','admin','2026-10-02')"));
  for (const name of files.filter(name => name >= "0085")) sqlite.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
  assert.deepEqual({ ...sqlite.prepare("SELECT command_type,result_message,requested_release_version,update_channel,requested_release_sha FROM kiosk_commands WHERE id='history'").get() },
    { command_type: "install_latest", result_message: "Verified kiosk update started", requested_release_version: "v2.0.0-beta.13", update_channel: "beta", requested_release_sha: "synthetic-sha" });
  sqlite.exec("INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at) VALUES ('erase','primary','kiosk','erase_unlinked_fingerprints','admin','2026-10-02')");
  assert.throws(() => sqlite.exec("INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at) VALUES ('bad','primary','kiosk','format_disk','admin','2026-10-02')"));
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='idx_kiosk_commands_pending'").get());
  sqlite.close();
});

test("migration 0087 dismisses open rejected-scan reviews and keeps their evidence and existing notes", () => {
  const sqlite = new DatabaseSync(":memory:");
  const files = readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of files.filter(name => name < "0087")) sqlite.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
  sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
    INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
    INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at,purpose) VALUES ('code','primary','code-hash','2026-01-02','admin','2026-01-01','hardware');
    INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,active,created_at) VALUES ('kiosk','primary','code','Test Kiosk A','hash',1,'2026-01-01');
    INSERT INTO kiosk_scan_reviews(installation_id,kiosk_id,event_id,record_json,received_at,review_status,reviewed_at,review_note) VALUES
      ('primary','kiosk','synthetic-open','{"memberId":"SYN-001"}','2026-10-27T00:00:00Z','open',NULL,NULL),
      ('primary','kiosk','synthetic-reviewed','{"memberId":"SYN-002"}','2026-10-27T00:00:00Z','reviewed','2026-10-28T00:00:00Z','Checked by Test Admin');`);
  for (const name of files.filter(name => name >= "0087")) sqlite.exec(readFileSync(join("apps/api/migrations", name), "utf8"));
  const rows = sqlite.prepare("SELECT event_id AS eventId,record_json AS record,review_status AS status,reviewed_at AS reviewedAt,review_note AS note FROM kiosk_scan_reviews ORDER BY event_id").all().map(row => ({ ...row })) as Array<Record<string, string>>;
  assert.deepEqual(rows.map(row => [row.eventId, row.status, row.record]), [["synthetic-open", "reviewed", '{"memberId":"SYN-001"}'], ["synthetic-reviewed", "reviewed", '{"memberId":"SYN-002"}']]);
  assert.match(rows[0]!.reviewedAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(rows[0]!.note, "Dismissed automatically when rejected-scan review moved to Debug tools");
  assert.deepEqual([rows[1]!.reviewedAt, rows[1]!.note], ["2026-10-28T00:00:00Z", "Checked by Test Admin"], "earlier reviews keep their notes");
  sqlite.close();
});

test("append-only upgrade retains the legacy kiosk credential and its queued scan compatibility", async (context) => {
  const { database, call, pair } = await fixture(context, true);
  const first = await pair("Existing entrance");
  database.sqlite.prepare("UPDATE kiosks SET pairing_bound = 0 WHERE id = ?").run(first.kioskId);
  const before = database.sqlite.prepare("SELECT * FROM kiosks WHERE id = ?").get(first.kioskId);
  assert.ok(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_one_active_kiosk'").get());
  database.sqlite.exec(readFileSync("apps/api/migrations/0054_multi_kiosk_authority.sql", "utf8"));
  assert.equal(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_one_active_kiosk'").get(), undefined);
  assert.deepEqual(database.sqlite.prepare("SELECT * FROM kiosks WHERE id = ?").get(first.kioskId), before);
  const second = await pair("Additional entrance");
  assert.equal((await call("/kiosk/config", undefined, first.kioskToken)).status, 200);
  assert.equal((await call("/kiosk/config", undefined, second.kioskToken)).status, 200);
  const event = { eventId: "legacy-queued-scan", memberId: "SYN-001", occurredAt: "2026-09-30T12:00:00Z" };
  assert.equal((await call("/kiosk/attendance", { ...event, eventId: "foreign-bound-scan", pairingId: second.pairingId }, first.kioskToken)).status, 409);
  assert.equal((await call("/kiosk/attendance", event, first.kioskToken)).status, 202);
  assert.equal((await call("/kiosk/attendance", { ...event, eventId: "unbound-new-scan" }, second.kioskToken)).status, 409);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosks WHERE active = 1").get()?.n, 2);
});

test("authentication choices are isolated per kiosk across configuration, combined polling and heartbeats", async context => {
  const { database, call, pair } = await fixture(context);
  const first = await pair("Fingerprint entrance"), second = await pair("Badge entrance");
  const update = (id: string, authenticationMethod: string) => call(`/admin/kiosks/${id}/authentication-method`, { authenticationMethod }, undefined, "PATCH");
  assert.equal((await update(second.kioskId, "nfc")).status, 200);
  assert.equal((await update(first.kioskId, "camera")).status, 400);
  assert.equal((await update("missing", "qr")).status, 404);
  assert.equal((await call("/admin/kiosks/authentication-method", { authenticationMethod: "qr" }, undefined, "PATCH")).status, 400);
  database.sqlite.exec("UPDATE organization_settings SET kiosk_authentication_method='qr'");
  for (const [device, expected] of [[first, "fingerprint"], [second, "nfc"]] as const) {
    const config = await (await call("/kiosk/config", undefined, device.kioskToken)).json() as any;
    const poll = await (await call("/kiosk/poll?v=1&config=1", undefined, device.kioskToken)).json() as any;
    assert.equal(config.settings.authenticationMethod, expected);
    assert.equal(poll.configuration.settings.authenticationMethod, expected);
    assert.equal(config.settings.token, undefined);
  }
  assert.equal((await call("/kiosk/heartbeat", { readerOnline: true, authenticationMethod: "rfid", releaseVersion: "1.2.6", pendingEvents: 0 }, second.kioskToken)).status, 200);
  const kiosks = (await (await call("/admin/kiosks")).json() as any).kiosks;
  assert.equal(kiosks.find((item: any) => item.id === first.kioskId).configuredAuthenticationMethod, "fingerprint");
  const badge = kiosks.find((item: any) => item.id === second.kioskId);
  assert.equal(badge.configuredAuthenticationMethod, "nfc"); assert.equal(badge.authenticationMethod, "rfid");
  const audit = database.sqlite.prepare("SELECT target_id, metadata_json FROM audit_log WHERE action='kiosk.authentication_method_updated'").get();
  assert.equal(audit?.target_id, second.kioskId); assert.deepEqual(JSON.parse(String(audit?.metadata_json)), { previousMethod: "fingerprint", authenticationMethod: "nfc", previousMemberLookup: "entry", memberLookup: "entry", previousRequirePin: false, requirePin: false });
  assert.equal((await call(`/admin/kiosks/${second.kioskId}`, { confirmation: "RETIRE KIOSK" }, undefined, "DELETE")).status, 200);
  assert.equal((await update(second.kioskId, "qr")).status, 404);
  database.sqlite.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='attendance'");
  assert.equal((await update(first.kioskId, "qr")).status, 403);
  assert.equal(database.sqlite.prepare("SELECT configured_authentication_method AS method FROM kiosks WHERE id=?").get(first.kioskId)?.method, "fingerprint");
  database.sqlite.exec("UPDATE platform_modules SET phase='enabled' WHERE module_id='attendance'");
  assert.equal((await call("/kiosk/poll?v=1&config=1", undefined, second.kioskToken)).status, 401);
});

test("additive per-kiosk migration preserves the effective configured method and separate reported state", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync("apps/api/migrations").filter(name => Number.parseInt(name, 10) < 73).sort()) database.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    database.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01');
      INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES('pair-one','primary','code-one','2026-01-02','admin','2026-01-01'),('pair-two','primary','code-two','2026-01-02','admin','2026-01-01'),('pair-new','primary','code-new','2026-01-02','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,kiosk_authentication_method,time_zone) VALUES('primary','qr','UTC');
      INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,active,created_at,authentication_method) VALUES
      ('online','primary','pair-one','Online','hash-one',1,'2026-01-01','rfid'),
      ('retired','primary','pair-two','Retired','hash-two',0,'2026-01-01','fingerprint');`);
    const before = database.prepare("SELECT id,token_hash,active,authentication_method FROM kiosks ORDER BY id").all();
    database.exec(readFileSync("apps/api/migrations/0073_per_kiosk_authentication.sql", "utf8"));
    assert.deepEqual(database.prepare("SELECT id,token_hash,active,authentication_method FROM kiosks ORDER BY id").all(), before);
    assert.deepEqual(database.prepare("SELECT configured_authentication_method AS method FROM kiosks").all().map(row => row.method), ["qr", "qr"]);
    database.exec("INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,active,created_at) VALUES('new','primary','pair-new','New','hash-new',1,'2026-01-01')");
    assert.equal(database.prepare("SELECT configured_authentication_method AS method FROM kiosks WHERE id='new'").get()?.method, "fingerprint");
    assert.throws(() => database.exec("UPDATE kiosks SET configured_authentication_method='camera'"), /CHECK constraint/);
  } finally { database.close(); }
});

test("manual attendance treats a blank participation start as the roster-added date and an explicit date still wins", async context => {
  const { database, call } = await fixture(context);
  database.sqlite.exec(`INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at,attendance_required_from) VALUES
      ('test-a','primary','TEST-A','Test Student','A','student-a@example.test','2026-09-15T08:00:00Z',NULL),
      ('test-b','primary','TEST-B','Test Student','B','student-b@example.test','2026-09-15T08:00:00Z','2026-09-05');
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES
      ('test-before','primary','Test meeting before roster','2026-09-10T18:00:00Z','2026-09-10T20:00:00Z','admin','2026-09-01'),
      ('test-after','primary','Test meeting after roster','2026-09-20T18:00:00Z','2026-09-20T20:00:00Z','admin','2026-09-01');`);
  const record = (eventId: string, memberId: string, meetingId: string, day: string) => call("/attendance", { eventId, memberId, meetingId, occurredAt: `${day}T18:05:00Z` });
  const before = await record("test-blank-before", "TEST-A", "test-before", "2026-09-10"); assert.equal(before.status, 409);
  assert.deepEqual(await before.json().then((body: { code?: string; error?: string }) => [body.code, body.error]), ["participation_not_started", "Attendance for Test Student begins on 2026-09-15"]);
  assert.equal((await record("test-blank-after", "TEST-A", "test-after", "2026-09-20")).status, 202);
  assert.equal((await record("test-explicit-before", "TEST-B", "test-before", "2026-09-10")).status, 202, "an explicit earlier date overrides the roster-added date");
  assert.deepEqual(database.sqlite.prepare("SELECT member_id AS memberId,meeting_id AS meetingId FROM attendance_events WHERE kiosk_event_id LIKE 'test-%' ORDER BY kiosk_event_id").all().map(row => ({ ...row })), [{ memberId: "test-a", meetingId: "test-after" }, { memberId: "test-b", meetingId: "test-before" }]);
});

test("real SQLite member PINs: Require PIN, setup by approval and at the kiosk, wrong tries, lockout, offline checks and resets", async context => {
  const { database, call } = await fixture(context);
  database.sqlite.exec(`INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('operator','primary','operator','operator','2026-01-01');
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('test-b','primary','TEST-B','Test Student','B','test-student-b@example.test','2026-01-01');`);
  const operatorCookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "operator", role: "operator" })}`;
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database } as unknown as Env;
  const operator = (path: string, method: string, body?: unknown, origin = env.ALLOWED_ORIGIN) => worker.fetch(new Request(`https://api.example.test${path}`, { method, headers: { cookie: operatorCookie, ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const pairWeb = async (name: string) => {
    const { code } = await (await call("/admin/pairing-codes", { kioskName: name, kind: "web" })).json() as { code: string };
    const paired = await call("/kiosk/pair", { code }); assert.equal(paired.status, 201);
    return await paired.json() as { kioskId: string; kioskToken: string; pairingId: string };
  };
  const a = await pairWeb("Test Web Kiosk A"), b = await pairWeb("Test Web Kiosk B");
  const json = async (result: Response) => await result.json() as any;
  const audits = (action: string) => database.sqlite.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = ? ORDER BY created_at, rowid").all(action).map(row => JSON.parse(String(row.metadata)));
  const pinRow = () => ({ ...database.sqlite.prepare("SELECT failed_attempts, locked_until FROM member_pins WHERE member_id = 'member'").get() });
  const pinCode = async (result: Response) => { const body = await json(result); return typeof body.code === "string" && body.code.startsWith("pin_") ? body.code : undefined; };
  const rosterMember = async (result: Response, memberId = "SYN-001") => (await json(result)).members.find((member: { memberId: string }) => member.memberId === memberId);
  let event = 0;
  const scan = (body: Record<string, unknown>, token = a.kioskToken) => call("/kiosk/attendance", { eventId: `test-pin-${++event}`, memberId: "SYN-001", occurredAt: new Date().toISOString(), pairingId: token === a.kioskToken ? a.pairingId : b.pairingId, ...body }, token);

  // Require PIN only with the member ID method; it is reported to the dashboard and the kiosk.
  const required = await call(`/admin/kiosks/${a.kioskId}/authentication-method`, { authenticationMethod: "member_id", requirePin: true }, undefined, "PATCH");
  assert.equal(required.status, 200); assert.equal((await json(required)).requirePin, true);
  assert.equal((await call(`/admin/kiosks/${a.kioskId}/authentication-method`, { authenticationMethod: "member_id", requirePin: "yes" }, undefined, "PATCH")).status, 400);
  assert.equal((await json(await call("/admin/kiosks"))).kiosks.find((kiosk: { id: string }) => kiosk.id === a.kioskId).requirePin, true);
  const config = (await json(await call("/kiosk/config", undefined, a.kioskToken))).settings;
  assert.equal(config.requirePin, true); assert.deepEqual(config.pinLockout, { enabled: false, attempts: 5, minutes: 15 });
  assert.deepEqual((await json(await call("/kiosk/poll?v=1&config=1", undefined, a.kioskToken))).configuration.settings, config);
  assert.equal((await json(await call("/kiosk/config", undefined, b.kioskToken))).settings.requirePin, false);

  // Only a Require PIN kiosk receives PIN data, under its own ETag.
  const firstRoster = await call("/kiosk/roster", undefined, a.kioskToken); const firstEtag = firstRoster.headers.get("etag")!;
  assert.match(firstEtag, /^"kiosk-roster-v1-pin-\d+"$/);
  assert.deepEqual(await rosterMember(firstRoster), { rosterId: "member", memberId: "SYN-001", firstName: "Synthetic", lastName: "Member", pin: null, pinLockedUntil: null });
  const otherRoster = await call("/kiosk/roster", undefined, b.kioskToken);
  assert.doesNotMatch(otherRoster.headers.get("etag")!, /pin/); assert.equal((await json(otherRoster)).members.some((member: object) => "pin" in member || "pinLockedUntil" in member), false);

  // Scans need a PIN, and a member without one is told so.
  const missing = await scan({}); assert.equal(missing.status, 400); assert.equal(await pinCode(missing), "pin_required");
  const malformed = await scan({ pin: "12a4" }); assert.equal(malformed.status, 400); assert.equal((await json(malformed)).code, "invalid_pin");
  const notSet = await scan({ pin: "2468" }); assert.equal(notSet.status, 409); assert.equal(await pinCode(notSet), "pin_not_set");
  assert.equal((await scan({ memberId: "TEST-B", pin: "2468" }, b.kioskToken)).status, 202, "a kiosk without Require PIN ignores pin");

  // Setup by approval: only this kiosk sees its request, and only an approved one sets a PIN.
  const asked = await call("/kiosk/pin-requests", { memberId: "SYN-001" }, a.kioskToken); assert.equal(asked.status, 201);
  const { request } = await json(asked); assert.equal(request.status, "pending"); assert.equal(Date.parse(request.expiresAt) - Date.now(), 600_000);
  assert.equal((await json(await call("/kiosk/pin-requests", { memberId: "member" }, a.kioskToken))).request.id, request.id);
  const wrongKiosk = await call("/kiosk/pin-requests", { memberId: "SYN-001" }, b.kioskToken); assert.equal(wrongKiosk.status, 409); assert.equal(await pinCode(wrongKiosk), "pin_not_required");
  assert.equal((await call(`/kiosk/pin-requests/${request.id}`, undefined, b.kioskToken)).status, 404);
  const early = await call(`/kiosk/pin-requests/${request.id}/pin`, { pin: "2468" }, a.kioskToken); assert.equal(early.status, 409); assert.equal(await pinCode(early), "pin_request_not_approved");
  const listed = await json(await call(`/admin/kiosks/${a.kioskId}/pin-requests`));
  assert.deepEqual(listed.requests, [{ id: request.id, member: { rosterId: "member", memberId: "SYN-001", firstName: "Synthetic", lastName: "Member" }, createdAt: new Date().toISOString(), expiresAt: request.expiresAt }]);
  assert.equal((await operator(`/admin/pin-requests/${request.id}/approve`, "POST", {}, "")).status, 403, "approval requires the dashboard origin");
  const approved = await operator(`/admin/pin-requests/${request.id}/approve`, "POST", {}); assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal((await json(approved)).request.status, "approved");
  assert.equal(await pinCode(await operator(`/admin/pin-requests/${request.id}/approve`, "POST", {})), "pin_request_not_pending");
  assert.equal((await json(await call(`/kiosk/pin-requests/${request.id}`, undefined, a.kioskToken))).request.status, "approved");
  assert.equal((await call(`/kiosk/pin-requests/${request.id}/pin`, { pin: "246" }, a.kioskToken)).status, 400);
  const chosen = await call(`/kiosk/pin-requests/${request.id}/pin`, { pin: "2468" }, a.kioskToken); assert.equal(chosen.status, 201, await chosen.clone().text());
  assert.equal((await json(await call(`/kiosk/pin-requests/${request.id}`, undefined, a.kioskToken))).request.status, "used");
  const stored = database.sqlite.prepare("SELECT * FROM member_pins WHERE member_id = 'member'").get()!;
  assert.equal(stored.pin_iterations, 100_000); assert.equal(stored.set_kiosk_id, a.kioskId); assert.equal(stored.failed_attempts, 0);
  assert.equal(Buffer.from(String(stored.pin_salt), "base64").length, 16);
  assert.equal(pbkdf2Sync("2468", Buffer.from(String(stored.pin_salt), "base64"), 100_000, 32, "sha256").toString("base64"), stored.pin_hash, "kiosks can check the cached hash with the same PBKDF2 parameters");
  assert.deepEqual(audits("pin_request.approved"), [{ kioskId: a.kioskId, memberId: "member" }]);
  assert.deepEqual(audits("member_pin.set"), [{ via: "pin_request", requestId: request.id, kioskId: a.kioskId, kioskName: "Test Web Kiosk A" }]);

  // The roster carries the hash once it is set, under a new ETag.
  const pinRoster = await call("/kiosk/roster", undefined, a.kioskToken); const pinEtag = pinRoster.headers.get("etag");
  assert.notEqual(pinEtag, firstEtag);
  assert.deepEqual((await rosterMember(pinRoster)).pin, { hash: stored.pin_hash, salt: stored.pin_salt, iterations: 100_000 });
  assert.equal(await pinCode(await call("/kiosk/pin-requests", { memberId: "SYN-001" }, a.kioskToken)), "pin_already_set");

  // A correct PIN records the scan. With lockout off, wrong tries count but never lock, and a correct PIN clears them.
  const recorded = await scan({ pin: "2468" }); assert.ok(recorded.status === 202 || recorded.status === 200, String(recorded.status)); assert.equal(await pinCode(recorded), undefined);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wrong = await scan({ pin: "1111" }); assert.equal(wrong.status, 403);
    assert.deepEqual(await json(wrong), { error: "Wrong PIN.", code: "pin_incorrect" });
  }
  assert.deepEqual(pinRow(), { failed_attempts: 6, locked_until: null });
  assert.equal((await json(await call("/admin/members/member/pin"))).pin.failedAttempts, 6);
  assert.equal(await pinCode(await scan({ pin: "2468" })), undefined);
  assert.equal(pinRow().failed_attempts, 0);

  // Lockout settings are Admin-only and validated.
  assert.equal((await operator("/admin/settings/pin-lockout", "PUT", { enabled: true, attempts: 3, minutes: 10 })).status, 403);
  for (const invalid of [{ enabled: true, attempts: 2, minutes: 10 }, { enabled: true, attempts: 21, minutes: 10 }, { enabled: true, attempts: 3, minutes: 0 }, { enabled: true, attempts: 3, minutes: 1441 }, { enabled: "on", attempts: 3, minutes: 10 }, { enabled: true, attempts: 3, minutes: 10, extra: 1 }, { enabled: true, attempts: 3.5, minutes: 10 }]) {
    assert.equal((await call("/admin/settings/pin-lockout", invalid, undefined, "PUT")).status, 400, JSON.stringify(invalid));
  }
  const saved = await call("/admin/settings/pin-lockout", { enabled: true, attempts: 3, minutes: 10 }, undefined, "PUT");
  assert.equal(saved.status, 200); assert.deepEqual(await json(saved), { enabled: true, attempts: 3, minutes: 10 });
  assert.deepEqual(await json(await call("/admin/settings/pin-lockout")), { enabled: true, attempts: 3, minutes: 10 });
  assert.deepEqual((await json(await call("/kiosk/config", undefined, a.kioskToken))).settings.pinLockout, { enabled: true, attempts: 3, minutes: 10 });
  assert.equal(audits("settings.pin_lockout_updated").length, 1);

  // With lockout on, the third wrong try locks for 10 minutes; even the right PIN is then refused.
  assert.deepEqual(await json(await scan({ pin: "1111" })), { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 2 });
  assert.deepEqual(await json(await scan({ pin: "1111" })), { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 1 });
  const lockedUntil = new Date(Date.now() + 600_000).toISOString();
  assert.deepEqual(await json(await scan({ pin: "1111" })), { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 0, lockedUntil });
  const locked = await scan({ pin: "2468" }); assert.equal(locked.status, 423); assert.deepEqual(await json(locked), { error: "This PIN is locked after too many wrong tries.", code: "pin_locked", lockedUntil });
  assert.equal(audits("member_pin.locked").length, 1); assert.equal(audits("member_pin.locked")[0].lockedUntil, lockedUntil);
  const lockedRoster = await call("/kiosk/roster", undefined, a.kioskToken);
  assert.notEqual(lockedRoster.headers.get("etag"), pinEtag);
  assert.equal((await rosterMember(lockedRoster)).pinLockedUntil, lockedUntil);
  assert.deepEqual((await json(await operator("/admin/members/member/pin", "GET"))).pin, { set: true, setAt: stored.set_at, setKioskName: "Test Web Kiosk A", failedAttempts: 3, lockedUntil });

  // A scan the kiosk checked offline against its cached hash is recorded even while locked: the device accepted it.
  assert.equal(await pinCode(await scan({ pinCheck: "offline" })), undefined);
  assert.equal((await scan({ pinCheck: "online" })).status, 400);

  // Unlock clears the lock and the count.
  assert.equal((await operator("/admin/members/member/pin/unlock", "POST", {}, "")).status, 403);
  const unlocked = await operator("/admin/members/member/pin/unlock", "POST", {}); assert.equal(unlocked.status, 200);
  assert.deepEqual((await json(unlocked)).pin, { set: true, setAt: stored.set_at, setKioskName: "Test Web Kiosk A", failedAttempts: 0, lockedUntil: null });
  assert.equal(audits("member_pin.unlocked").length, 1);

  // Wrong tries made offline count once the kiosk syncs, and can lock; tries against an older PIN do not.
  assert.equal((await call("/kiosk/pin-failures", { failures: [{ memberId: "SYN-001", count: 0, lastAt: new Date().toISOString() }] }, a.kioskToken)).status, 400);
  assert.deepEqual(await json(await call("/kiosk/pin-failures", { failures: [{ memberId: "SYN-001", count: 3, lastAt: new Date().toISOString() }] }, b.kioskToken)), { recorded: 0 });
  assert.deepEqual(await json(await call("/kiosk/pin-failures", { failures: [{ memberId: "SYN-001", count: 2, lastAt: "2026-01-01T00:00:00.000Z" }, { memberId: "NOBODY", count: 2, lastAt: new Date().toISOString() }] }, a.kioskToken)), { recorded: 0 });
  assert.deepEqual(await json(await call("/kiosk/pin-failures", { failures: [{ memberId: "SYN-001", count: 3, lastAt: new Date().toISOString() }] }, a.kioskToken)), { recorded: 3 });
  assert.deepEqual(pinRow(), { failed_attempts: 3, locked_until: lockedUntil });
  assert.equal(audits("member_pin.locked").length, 2); assert.equal(audits("member_pin.locked")[1].via, "offline_report");
  // After the lock runs out, the member starts a fresh count.
  context.mock.timers.tick(600_000);
  assert.deepEqual(await json(await scan({ pin: "1111" })), { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 2 });
  // Turning lockout off ends every lock.
  await call("/kiosk/pin-failures", { failures: [{ memberId: "SYN-001", count: 5, lastAt: new Date().toISOString() }] }, a.kioskToken);
  assert.notEqual(pinRow().locked_until, null);
  assert.equal((await call("/admin/settings/pin-lockout", { enabled: false, attempts: 3, minutes: 10 }, undefined, "PUT")).status, 200);
  assert.equal(pinRow().locked_until, null);

  // Kiosk maintenance sets a PIN for a member without one, and resets it.
  const set = await call("/kiosk/pins", { memberId: "TEST-B", pin: "1357" }, a.kioskToken); assert.equal(set.status, 201, await set.clone().text());
  assert.equal(await pinCode(await call("/kiosk/pins", { memberId: "TEST-B", pin: "9753" }, a.kioskToken)), "pin_already_set");
  assert.equal(await pinCode(await call("/kiosk/pins", { memberId: "TEST-B", pin: "9753" }, b.kioskToken)), "pin_not_required");
  assert.equal((await json(await call("/kiosk/pins", { memberId: "test-b", pin: "97" }, a.kioskToken))).code, "invalid_pin");
  assert.deepEqual(audits("member_pin.set").at(-1), { via: "kiosk_maintenance", kioskId: a.kioskId, kioskName: "Test Web Kiosk A" });
  assert.equal((await scan({ memberId: "TEST-B", pinCheck: "offline" })).status, 202);
  assert.deepEqual(await json(await call("/kiosk/pins/TEST-B/reset", {}, a.kioskToken)), { reset: true });
  assert.deepEqual(await json(await call("/kiosk/pins/TEST-B/reset", {}, a.kioskToken)), { reset: false });
  assert.deepEqual(audits("member_pin.reset"), [{ via: "kiosk_maintenance", kioskId: a.kioskId, kioskName: "Test Web Kiosk A" }]);

  // A dashboard reset removes the PIN; the member then asks again.
  assert.equal((await operator("/admin/members/member/pin", "DELETE", undefined, "")).status, 403);
  const reset = await operator("/admin/members/member/pin", "DELETE"); assert.equal(reset.status, 200);
  assert.deepEqual((await json(reset)).pin, { set: false, setAt: null, setKioskName: null, failedAttempts: 0, lockedUntil: null });
  assert.equal(audits("member_pin.reset").length, 2); assert.equal(audits("member_pin.reset")[1].via, "dashboard");
  assert.equal(await pinCode(await scan({ pin: "2468" })), "pin_not_set");

  // Declined and expired requests never set a PIN; an approval is good for 5 minutes.
  const declineId = (await json(await call("/kiosk/pin-requests", { memberId: "SYN-001" }, a.kioskToken))).request.id;
  assert.equal((await json(await operator(`/admin/pin-requests/${declineId}/decline`, "POST", {}))).request.status, "declined");
  assert.equal(audits("pin_request.declined").length, 1);
  assert.equal(await pinCode(await call(`/kiosk/pin-requests/${declineId}/pin`, { pin: "2468" }, a.kioskToken)), "pin_request_not_approved");
  const staleId = (await json(await call("/kiosk/pin-requests", { memberId: "SYN-001" }, a.kioskToken))).request.id;
  assert.notEqual(staleId, declineId);
  context.mock.timers.tick(600_001);
  assert.equal((await json(await call(`/kiosk/pin-requests/${staleId}`, undefined, a.kioskToken))).request.status, "expired");
  assert.equal((await json(await call(`/admin/kiosks/${a.kioskId}/pin-requests`))).requests.length, 0);
  assert.equal(await pinCode(await operator(`/admin/pin-requests/${staleId}/approve`, "POST", {})), "pin_request_not_pending");
  const lateId = (await json(await call("/kiosk/pin-requests", { memberId: "SYN-001" }, a.kioskToken))).request.id;
  const lateApproval = await json(await operator(`/admin/pin-requests/${lateId}/approve`, "POST", {}));
  assert.equal(Date.parse(lateApproval.request.expiresAt) - Date.now(), 300_000);
  context.mock.timers.tick(300_001);
  assert.equal(await pinCode(await call(`/kiosk/pin-requests/${lateId}/pin`, { pin: "2468" }, a.kioskToken)), "pin_request_not_approved");
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM member_pins WHERE member_id = 'member'").get()?.n, 0);
  // Audit metadata carries random kiosk and request UUIDs, which contain a 4-digit PIN by chance roughly once in 200 runs.
  const audited = database.sqlite.prepare("SELECT metadata_json AS metadata FROM audit_log").all().map(row => String(row.metadata ?? "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")).join("\n");
  assert.doesNotMatch(audited, /2468|1357|1111/, "a PIN is never audited");

  // A save that leaves Require PIN out keeps it; turning it off stops PIN data at once.
  assert.equal((await json(await call(`/admin/kiosks/${a.kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "search" }, undefined, "PATCH"))).requirePin, true);
  assert.equal((await json(await call(`/admin/kiosks/${a.kioskId}/authentication-method`, { authenticationMethod: "member_id", requirePin: false }, undefined, "PATCH"))).requirePin, false);
  const plain = await call("/kiosk/roster", undefined, a.kioskToken);
  assert.doesNotMatch(plain.headers.get("etag")!, /pin/); assert.equal((await json(plain)).members.some((member: object) => "pin" in member), false);
  assert.equal(await pinCode(await scan({})), undefined, "without Require PIN the scan goes straight to attendance");
});

test("real SQLite installation backups carry member PINs, Require PIN and lockout, and schema 46 backups restore without them", async context => {
  const { database, call } = await fixture(context);
  database.sqlite.exec(`INSERT INTO platform_module_assignment_epochs VALUES ('primary', 'admin', 0);
    INSERT INTO platform_module_assignment_revisions VALUES ('primary', 'admin', 0);
    INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES
      ('primary','attendance','rules',2,'completed','2026-01-01','admin'), ('primary','attendance','meeting',2,'completed','2026-01-01','admin'),
      ('primary','attendance','input',2,'completed','2026-01-01','admin'), ('primary','attendance','calendar',2,'skipped','2026-01-01','admin'),
      ('primary','attendance','discord',2,'skipped','2026-01-01','admin');
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at) VALUES ('test-b','primary','TEST-B','Test Student','B','test-student-b@example.test','2026-01-01');`);
  const { code } = await (await call("/admin/pairing-codes", { kioskName: "Test Web Kiosk A", kind: "web" })).json() as { code: string };
  const kiosk = await (await call("/kiosk/pair", { code })).json() as { kioskId: string; kioskToken: string };
  assert.equal((await call(`/admin/kiosks/${kiosk.kioskId}/authentication-method`, { authenticationMethod: "member_id", requirePin: true }, undefined, "PATCH")).status, 200);
  assert.equal((await call("/kiosk/pins", { memberId: "SYN-001", pin: "2468" }, kiosk.kioskToken)).status, 201);
  assert.equal((await call("/kiosk/pin-requests", { memberId: "TEST-B" }, kiosk.kioskToken)).status, 201);
  assert.equal((await call("/admin/settings/pin-lockout", { enabled: true, attempts: 4, minutes: 30 }, undefined, "PUT")).status, 200);
  const pin = { ...database.sqlite.prepare("SELECT * FROM member_pins").get() };

  const exported = await call("/admin/data/backup?scope=installation"); assert.equal(exported.status, 200, await exported.clone().text());
  const backup = await exported.json() as any;
  assert.equal(backup.schemaVersion, 49);
  assert.deepEqual(backup.tables.member_pins, [pin]);
  assert.equal(backup.tables.kiosks[0].require_pin, 1);
  assert.deepEqual([backup.tables.organization_settings[0].pin_lockout_enabled, backup.tables.organization_settings[0].pin_lockout_attempts, backup.tables.organization_settings[0].pin_lockout_minutes], [1, 4, 30]);
  assert.equal("pin_setup_requests" in backup.tables, false, "PIN requests are short-lived and never travel");
  assert.ok(backup.ownership.core.tables.includes("member_pins"));
  const roster = await (await call("/admin/data/backup?scope=roster")).json() as any;
  assert.equal("member_pins" in roster.tables, false, "roster backups never carry PIN hashes");

  const restore = (source: unknown) => call("/admin/data/restore", { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: source });
  for (const corrupt of [
    (copy: any) => { copy.tables.member_pins[0].member_id = "missing-member"; },
    (copy: any) => { copy.tables.member_pins[0].pin_iterations = 200_000; },
    (copy: any) => { copy.tables.kiosks[0].require_pin = 2; },
    (copy: any) => { copy.tables.organization_settings[0].pin_lockout_attempts = 50; },
  ]) {
    const copy = structuredClone(backup); corrupt(copy);
    const refused = await restore(copy); assert.equal(refused.status, 400);
    assert.match((await refused.json() as { error: string }).error, /invalid member PIN|Require PIN setting|PIN lockout setting is invalid/);
  }
  database.sqlite.exec("DELETE FROM member_pins; UPDATE organization_settings SET pin_lockout_enabled = 0");
  const restored = await restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual({ ...database.sqlite.prepare("SELECT * FROM member_pins").get() }, pin);
  assert.equal(database.sqlite.prepare("SELECT require_pin AS requirePin FROM kiosks").get()?.requirePin, 1);
  assert.deepEqual({ ...database.sqlite.prepare("SELECT pin_lockout_enabled AS enabled, pin_lockout_attempts AS attempts, pin_lockout_minutes AS minutes FROM organization_settings").get() }, { enabled: 1, attempts: 4, minutes: 30 });
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM pin_setup_requests").get()?.n, 0);

  // A schema 46 backup restores with no PINs, Require PIN off and lockout at its defaults.
  const legacy = structuredClone(backup); legacy.schemaVersion = 46; omitContestResubmissionFields(legacy);
  assert.equal("member_pins" in legacy.tables, false); assert.equal("require_pin" in legacy.tables.kiosks[0], false);
  const older = await restore(legacy); assert.equal(older.status, 200, await older.clone().text());
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM member_pins").get()?.n, 0);
  assert.equal(database.sqlite.prepare("SELECT require_pin AS requirePin FROM kiosks").get()?.requirePin, 0);
  assert.deepEqual({ ...database.sqlite.prepare("SELECT pin_lockout_enabled AS enabled, pin_lockout_attempts AS attempts, pin_lockout_minutes AS minutes FROM organization_settings").get() }, { enabled: 0, attempts: 5, minutes: 15 });
  // A schema 46 backup that names the new table is refused.
  const mislabeled = structuredClone(backup); mislabeled.schemaVersion = 46;
  assert.equal((await restore(mislabeled)).status, 400);
});

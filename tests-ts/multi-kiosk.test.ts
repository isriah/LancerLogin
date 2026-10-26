import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";

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

type Statement = { execute(): unknown };

// Real SQLite with D1's atomic batch semantics. The optional read barrier makes
// both requests observe an unredeemed code before either transaction starts.
class Database {
  sqlite = new DatabaseSync(":memory:");
  pairingRace?: { reads: number; ready: Promise<void>; release(): void };
  constructor(legacySchema = false) {
    for (const name of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql") && (!legacySchema || (Number.parseInt(name, 10) <= 53 || name.startsWith("0073_")))).sort()) {
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
      bind(...values: unknown[]) { params = values; return this; },
      async first<T>() {
        const row = database.sqlite.prepare(sql).get(...params as []) ?? null;
        const race = database.pairingRace;
        if (race && sql.includes("SELECT id FROM pairing_codes WHERE") && sql.includes("purpose = 'hardware'")) {
          if (++race.reads === 2) race.release();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([race.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Pairing race did not reach both reads")), 2_000); })]); }
          finally { clearTimeout(timer); }
        }
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
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec("COMMIT"); return result; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
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
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosks WHERE active = 1").get()?.n, 1);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kiosk.paired'").get()?.n, 1);
  database.pairingRace = undefined;
  assert.equal((await call("/kiosk/pair", { code: key, kioskName: "Third entrance" })).status, 401);
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
  assert.equal((await call("/kiosk/attendance", event, second.kioskToken)).status, 409);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM attendance_events").get()?.n, 0);
  assert.equal((await call("/kiosk/attendance", event, first.kioskToken)).status, 202);
  assert.equal((await call("/kiosk/attendance", event, first.kioskToken)).status, 200);
  assert.equal((await call(`/admin/kiosks/${first.kioskId}`, { confirmation: "RETIRE KIOSK" }, undefined, "DELETE")).status, 200);
  assert.equal((await heartbeat(first, 0)).status, 401); assert.equal((await heartbeat(second, 0)).status, 200);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosks WHERE active = 1").get()?.n, 1);
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
  assert.equal(audit?.target_id, second.kioskId); assert.deepEqual(JSON.parse(String(audit?.metadata_json)), { previousMethod: "fingerprint", authenticationMethod: "nfc" });
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

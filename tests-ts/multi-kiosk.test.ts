import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { createFingerprintSync } from "../apps/kiosk/src/fingerprint-sync.mjs";
import { createFingerprintCloudClient } from "../apps/kiosk/src/fingerprint-cloud-client.mjs";
import { generateFingerprintIdentity, fingerprintPublicIdentity, fingerprintIdentityId, sealFingerprintTemplate, openFingerprintTemplate } from "../apps/kiosk/src/fingerprint-envelope.mjs";

const secret = "A".repeat(43);
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
function publicSyncIdentity() {
  const encryption = generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const signing = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { publicIdentity: { encryption, signing }, fingerprint: createHash("sha256").update(JSON.stringify(["LancerLogin fingerprint sync v1", encryption, signing])).digest("hex") };
}
type Statement = { execute(): unknown };

// Real SQLite with D1's atomic batch semantics. The optional read barrier makes
// both requests observe an unredeemed code before either transaction starts.
class Database {
  sqlite = new DatabaseSync(":memory:");
  pairingRace?: { reads: number; ready: Promise<void>; release(): void };
  constructor(legacySchema = false) {
    for (const name of readdirSync("apps/api/migrations").filter(name => name.endsWith(".sql") && (!legacySchema || Number.parseInt(name, 10) <= 53)).sort()) {
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

test("fingerprint relay paginates blocked deliveries without skipping after deletion or exposing another recipient", async (context) => {
  const { database, call, pair } = await fixture(context);
  const source = await pair("Source"), destination = await pair("Destination"), other = await pair("Other");
  const sender = await generateFingerprintIdentity(), recipient = await generateFingerprintIdentity();
  const senderPublic = fingerprintPublicIdentity(sender), recipientPublic = fingerprintPublicIdentity(recipient);
  const { syncId } = await (await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).json() as { syncId: string };
  for (const [device, publicIdentity] of [[source, senderPublic], [destination, recipientPublic]] as const) {
    assert.equal((await call("/kiosk/fingerprint-sync/identity", { publicIdentity, fingerprint: fingerprintIdentityId(publicIdentity) }, device.kioskToken, "PUT")).status, 200);
  }
  const synthetic = Buffer.alloc(1536, 42);
  for (let index = 0; index < 10; index++) {
    const envelope = sealFingerprintTemplate(synthetic, { sender, recipient: recipientPublic, context: {
      installationId: syncId, senderId: source.kioskId, recipientId: destination.kioskId, senderPairingId: source.pairingId, recipientPairingId: destination.pairingId,
      senderKeyId: fingerprintIdentityId(senderPublic), recipientKeyId: fingerprintIdentityId(recipientPublic), memberId: "SYN-001", enrollmentId: `enrollment-${index}`,
      transferId: `delivery-${String(index).padStart(2, "0")}`, revision: 1, issuedAt: Date.now(), expiresAt: Date.now() + 600000,
    } });
    assert.equal((await call("/kiosk/fingerprint-sync/deliveries", envelope, source.kioskToken)).status, 202);
  }
  synthetic.fill(0);
  const page = async (after?: string, token = destination.kioskToken) => {
    const response = await call(`/kiosk/fingerprint-sync/deliveries${after ? `?after=${encodeURIComponent(after)}` : ""}`, undefined, token);
    assert.equal(response.status, 200);
    return (await response.json() as { deliveries: Array<{ context: { transferId: string } }> }).deliveries.map(item => item.context.transferId);
  };
  assert.deepEqual(await page(), Array.from({ length: 8 }, (_, index) => `delivery-0${index}`));
  // The cursor remains valid even if its row or earlier rows disappear.
  database.sqlite.exec("DELETE FROM kiosk_fingerprint_deliveries WHERE transfer_id IN ('delivery-00','delivery-07')");
  assert.deepEqual(await page("delivery-07"), ["delivery-08", "delivery-09"]);
  assert.deepEqual(await page("delivery-09"), []);
  assert.deepEqual(await page("delivery-07", other.kioskToken), []);
  assert.equal((await page()).length, 8);
  for (const query of ["after=", "after=..%2Fidentity", "after=one&after=two"]) {
    assert.equal((await call(`/kiosk/fingerprint-sync/deliveries?${query}`, undefined, destination.kioskToken)).status, 400);
  }
});

test("fingerprint relay requires explicit enablement and immutable paired public identities", async (context) => {
  const { database, call, pair } = await fixture(context);
  const first = await pair("Front entrance"), second = await pair("Side entrance");
  const firstIdentity = publicSyncIdentity(), secondIdentity = publicSyncIdentity();
  assert.deepEqual(await (await call("/admin/kiosks/fingerprint-sync")).json(), { enabled: false, syncId: null });
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync", undefined, first.kioskToken)).json(), { enabled: false, syncId: null });
  const register = (device: typeof first, identity = firstIdentity) => call("/kiosk/fingerprint-sync/identity", identity, device.kioskToken, "PUT");
  assert.equal((await register(first)).status, 409);
  const enabled = await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH");
  assert.equal(enabled.status, 200);
  const state = await enabled.json() as { enabled: boolean; syncId: string };
  assert.equal(state.enabled, true); assert.match(state.syncId, /^[a-f0-9]{64}$/);
  assert.equal((await register(first)).status, 200);
  assert.equal((await register(first)).status, 200);
  assert.equal((await register(first, secondIdentity)).status, 409);
  assert.equal((await register(second, secondIdentity)).status, 200);
  const peers = await (await call("/kiosk/fingerprint-sync/peers", undefined, first.kioskToken)).json() as { peers: Array<Record<string, unknown>> };
  assert.deepEqual(peers.peers, [{ kioskId: second.kioskId, pairingId: second.pairingId, fingerprint: secondIdentity.fingerprint, name: "Side entrance", installationId: state.syncId, publicIdentity: secondIdentity.publicIdentity }]);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_deliveries").get()?.n, 0);
  assert.equal((await call("/kiosk/fingerprint-sync/identity", undefined, second.kioskToken, "DELETE")).status, 200);
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync/peers", undefined, first.kioskToken)).json(), { peers: [] });
  assert.equal((await register(second, secondIdentity)).status, 200);
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: false }, undefined, "PATCH")).status, 200);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_keys").get()?.n, 0);
  assert.equal((await call("/kiosk/fingerprint-sync/peers", undefined, first.kioskToken)).status, 409);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='kiosk.fingerprint_sync_configured'").get()?.n, 2);
});

test("fingerprint relay rejects malformed identity, legacy pairing and retired credentials", async (context) => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Front entrance"), identity = publicSyncIdentity();
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: "yes" }, undefined, "PATCH")).status, 400);
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).status, 200);
  for (const malformed of [{ ...identity, fingerprint: "0".repeat(64) }, { ...identity, privateKey: "not permitted" }, { ...identity, publicIdentity: { ...identity.publicIdentity, signing: "invalid" } }]) {
    assert.equal((await call("/kiosk/fingerprint-sync/identity", malformed, device.kioskToken, "PUT")).status, 400);
  }
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_keys").get()?.n, 0);
  database.sqlite.prepare("UPDATE kiosks SET pairing_bound=0 WHERE id=?").run(device.kioskId);
  assert.equal((await call("/kiosk/fingerprint-sync", undefined, device.kioskToken)).status, 409);
  database.sqlite.prepare("UPDATE kiosks SET pairing_bound=1 WHERE id=?").run(device.kioskId);
  assert.equal((await call("/kiosk/fingerprint-sync/identity", identity, device.kioskToken, "PUT")).status, 200);
  assert.equal((await call(`/admin/kiosks/${device.kioskId}`, { confirmation: "RETIRE KIOSK" }, undefined, "DELETE")).status, 200);
  assert.equal((await call("/kiosk/fingerprint-sync/peers", undefined, device.kioskToken)).status, 401);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_keys").get()?.n, 0);
});

test("fingerprint registration closes retirement races and configuration remains Admin-only", async (context) => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Front entrance"), identity = publicSyncIdentity();
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).status, 200);
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  let retired = false;
  const interception = context.mock.method(crypto.subtle, "importKey", async (...args: Parameters<typeof crypto.subtle.importKey>) => {
    const key = await importKey(...args);
    if (!retired) {
      retired = true;
      database.sqlite.prepare("UPDATE kiosks SET active=0 WHERE id=?").run(device.kioskId);
    }
    return key;
  });
  assert.equal((await call("/kiosk/fingerprint-sync/identity", identity, device.kioskToken, "PUT")).status, 409);
  interception.mock.restore();
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_keys").get()?.n, 0);
  database.sqlite.exec("UPDATE users SET role='operator' WHERE id='admin'");
  assert.equal((await call("/admin/kiosks/fingerprint-sync")).status, 403);
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: false }, undefined, "PATCH")).status, 403);
  assert.equal(database.sqlite.prepare("SELECT enabled FROM kiosk_fingerprint_sync").get()?.enabled, 1);
});

test("encrypted relay delivers only to its recipient and erases ciphertext after an idempotent result", async (context) => {
  const { database, call, pair } = await fixture(context);
  database.sqlite.prepare("UPDATE members SET external_id=? WHERE id='member'").run("Équipe / 007");
  const first = await pair("Front entrance"), second = await pair("Side entrance"), stranger = await pair("Other entrance");
  const sender = await generateFingerprintIdentity(), recipient = await generateFingerprintIdentity();
  const senderPublic = fingerprintPublicIdentity(sender), recipientPublic = fingerprintPublicIdentity(recipient);
  const enabled = await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH");
  const { syncId } = await enabled.json() as { syncId: string };
  for (const [device, publicIdentity] of [[first, senderPublic], [second, recipientPublic]] as const) {
    assert.equal((await call("/kiosk/fingerprint-sync/identity", { publicIdentity, fingerprint: fingerprintIdentityId(publicIdentity) }, device.kioskToken, "PUT")).status, 200);
  }
  const transferContext = { installationId: syncId, senderId: first.kioskId, recipientId: second.kioskId, senderPairingId: first.pairingId, recipientPairingId: second.pairingId,
    memberId: "Équipe / 007", enrollmentId: "synthetic-enrollment", transferId: "synthetic-transfer", senderKeyId: fingerprintIdentityId(senderPublic), recipientKeyId: fingerprintIdentityId(recipientPublic), revision: 1, issuedAt: Date.now(), expiresAt: Date.now() + 600000 };
  const syntheticTemplate = Buffer.alloc(1536, 42);
  const envelope = sealFingerprintTemplate(syntheticTemplate, { sender, recipient: recipientPublic, context: transferContext });
  const enqueue = (value = envelope, token = first.kioskToken) => call("/kiosk/fingerprint-sync/deliveries", value, token);
  assert.equal((await enqueue(envelope, stranger.kioskToken)).status, 403);
  assert.equal((await enqueue({ ...envelope, ciphertext: Buffer.alloc(1536, 1).toString("base64") })).status, 400);
  assert.equal((await enqueue()).status, 202); assert.equal((await enqueue()).status, 202);
  const different = sealFingerprintTemplate(syntheticTemplate, { sender, recipient: recipientPublic, context: transferContext });
  assert.equal((await enqueue(different)).status, 409);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_deliveries").get()?.n, 1);
  for (const device of [first, stranger]) assert.deepEqual(await (await call("/kiosk/fingerprint-sync/deliveries", undefined, device.kioskToken)).json(), { deliveries: [] });
  const received = await (await call("/kiosk/fingerprint-sync/deliveries", undefined, second.kioskToken)).json() as { deliveries: unknown[] };
  assert.equal(received.deliveries.length, 1);
  const clear = openFingerprintTemplate(received.deliveries[0], { recipient, sender: senderPublic, expected: transferContext });
  assert.deepEqual(clear, syntheticTemplate); clear.fill(0); syntheticTemplate.fill(0);
  const resultPath = `/kiosk/fingerprint-sync/deliveries/${transferContext.transferId}/result`;
  const result = { status: "complete", digest: createHash("sha256").update(Buffer.from(envelope.signature, "base64")).digest("hex") };
  assert.equal((await call(resultPath, result, first.kioskToken)).status, 404);
  assert.equal((await call(resultPath, { ...result, digest: "0".repeat(64) }, second.kioskToken)).status, 404);
  assert.equal((await call(resultPath, result, second.kioskToken)).status, 200);
  assert.equal((await call(resultPath, result, second.kioskToken)).status, 200);
  assert.equal((await call(resultPath, { ...result, status: "rejected" }, second.kioskToken)).status, 409);
  assert.equal(database.sqlite.prepare("SELECT envelope_json FROM kiosk_fingerprint_deliveries").get()?.envelope_json, null);
  assert.equal((await enqueue()).status, 200);
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync/deliveries", undefined, second.kioskToken)).json(), { deliveries: [] });
  assert.deepEqual(await (await call(`/kiosk/fingerprint-sync/deliveries/${transferContext.transferId}`, undefined, first.kioskToken)).json(), { transferId: transferContext.transferId, status: "complete" });
  assert.equal((await call(`/kiosk/fingerprint-sync/deliveries/${transferContext.transferId}`, undefined, stranger.kioskToken)).status, 404);
  context.mock.timers.tick(600001);
  assert.equal((await enqueue()).status, 400);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_deliveries").get()?.n, 0);
});

test("encrypted relay refuses authority revoked while signature verification is in flight", async (context) => {
  for (const change of ["recipient retirement", "member deactivation", "sync disablement", "sender key revocation"]) {
    await context.test(change, async (scope) => {
      const { database, call, pair } = await fixture(scope);
      const first = await pair("Front entrance"), second = await pair("Side entrance");
      const sender = await generateFingerprintIdentity(), recipient = await generateFingerprintIdentity();
      const senderPublic = fingerprintPublicIdentity(sender), recipientPublic = fingerprintPublicIdentity(recipient);
      const { syncId } = await (await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).json() as { syncId: string };
      for (const [device, publicIdentity] of [[first, senderPublic], [second, recipientPublic]] as const) {
        assert.equal((await call("/kiosk/fingerprint-sync/identity", { publicIdentity, fingerprint: fingerprintIdentityId(publicIdentity) }, device.kioskToken, "PUT")).status, 200);
      }
      const transferContext = { installationId: syncId, senderId: first.kioskId, recipientId: second.kioskId, senderPairingId: first.pairingId, recipientPairingId: second.pairingId,
        memberId: "SYN-001", enrollmentId: "synthetic-enrollment", transferId: "race-transfer", senderKeyId: fingerprintIdentityId(senderPublic), recipientKeyId: fingerprintIdentityId(recipientPublic), revision: 1, issuedAt: Date.now(), expiresAt: Date.now() + 600000 };
      const envelope = sealFingerprintTemplate(Buffer.alloc(1536, 3), { sender, recipient: recipientPublic, context: transferContext });
      const verify = crypto.subtle.verify.bind(crypto.subtle);
      const interception = scope.mock.method(crypto.subtle, "verify", async (...args: Parameters<typeof crypto.subtle.verify>) => {
        const valid = await verify(...args);
        if (change === "recipient retirement") database.sqlite.prepare("UPDATE kiosks SET active=0 WHERE id=?").run(second.kioskId);
        if (change === "member deactivation") database.sqlite.exec("UPDATE members SET active=0 WHERE id='member'");
        if (change === "sync disablement") database.sqlite.exec("UPDATE kiosk_fingerprint_sync SET enabled=0");
        if (change === "sender key revocation") database.sqlite.prepare("DELETE FROM kiosk_fingerprint_keys WHERE kiosk_id=?").run(first.kioskId);
        return valid;
      });
      assert.equal((await call("/kiosk/fingerprint-sync/deliveries", envelope, first.kioskToken)).status, 409);
      interception.mock.restore();
      assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_fingerprint_deliveries").get()?.n, 0);
    });
  }
});

test("two kiosk controllers interoperate with real Worker relay and recover a lost committed acknowledgement", async (context) => {
  const { database, call, pair } = await fixture(context);
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-worker-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDevice = await pair("Source"), targetDevice = await pair("Destination");
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).status, 200);
  const original = Buffer.alloc(1536, 7), enrolled = Buffer.alloc(1536, 42);
  const destinationSlots = new Map([[0, original]]);
  let loseAck = true, imports = 0;
  function device(device: typeof sourceDevice, slots: Map<number, Buffer>, destination = false) {
    const folder = join(directory, device.kioskId);
    const mappings = createMappingStore(join(folder, "mappings.json"));
    const client = createFingerprintCloudClient({ ...device, apiUrl: "https://api.example.test" }, { fetchImpl: async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      const response = await call(path, options.body ? JSON.parse(String(options.body)) : undefined, device.kioskToken, options.method);
      if (destination && loseAck && path.endsWith("/result") && response.ok) { loseAck = false; throw new Error("Synthetic lost response after commit"); }
      return response;
    } });
    const sensor = { occupiedSlots: async () => [...slots.keys()], enroll: async (slot: number) => { assert.equal(slots.has(slot), false); slots.set(slot, Buffer.from(enrolled)); } };
    const controller = createFingerprintSync({ directory: join(folder, "sync"), config: device, client, sensor, mappings, withSensor: (operation: () => unknown) => operation(),
      templates: { exportTemplate: async (slot: number) => { assert.ok(slots.has(slot)); return Buffer.from(slots.get(slot)!); },
        importTemplate: async (slot: number, template: Uint8Array) => { assert.equal(slots.has(slot), false); slots.set(slot, Buffer.from(template)); imports++; return { slot, verified: true }; } },
      fetchRoster: async () => { const response = await call("/kiosk/roster", undefined, device.kioskToken); assert.equal(response.status, 200); return response.json(); },
    });
    return { controller, mappings, sensor };
  }
  const source = device(sourceDevice, new Map()), target = device(targetDevice, destinationSlots, true);
  await source.controller.setEnabled(true); await target.controller.setEnabled(true);
  const sourceIdentity = await source.controller.status(), targetIdentity = await target.controller.status();
  await source.controller.approvePeer(targetDevice.kioskId, targetIdentity.fingerprint);
  await target.controller.approvePeer(sourceDevice.kioskId, sourceIdentity.fingerprint);
  await enrollFingerprint({ sensor: source.sensor, mappings: source.mappings, withSensor: (operation: () => unknown) => operation(), slot: 5, memberId: "SYN-001", rosterId: "member", finger: "right index" });
  assert.equal((await source.mappings.read())["5"].rosterId, "member");
  assert.equal((await source.controller.tick()).captured, 1);
  assert.equal(database.sqlite.prepare("SELECT status FROM kiosk_fingerprint_deliveries").get()?.status, "pending");
  assert.equal((await target.controller.tick()).status, "needs_attention");
  assert.equal(imports, 1);
  assert.equal(await target.mappings.memberForSlot(1), "SYN-001");
  assert.deepEqual(destinationSlots.get(0), original); assert.deepEqual(destinationSlots.get(1), enrolled);
  assert.equal(database.sqlite.prepare("SELECT status FROM kiosk_fingerprint_deliveries").get()?.status, "complete");
  assert.equal(database.sqlite.prepare("SELECT envelope_json FROM kiosk_fingerprint_deliveries").get()?.envelope_json, null);
  assert.equal((await source.controller.tick()).completed, 1);
  assert.equal((await target.controller.tick()).status, "ready");
  assert.equal(imports, 1);
  // The transferred fingerprint uses the same member identity for attendance.
  const scan = await call("/kiosk/attendance", { eventId: "transferred-finger-scan", memberId: await target.mappings.memberForSlot(1), pairingId: targetDevice.pairingId, occurredAt: new Date().toISOString() }, targetDevice.kioskToken);
  assert.equal(scan.status, 202);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM attendance_events WHERE member_id='member'").get()?.n, 1);
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

test("pending fingerprint resets block both relay endpoints without exposing stale delivery data", async (context) => {
  const { database, call, pair } = await fixture(context);
  const source = await pair("Synthetic source"), destination = await pair("Synthetic destination");
  const sender = await generateFingerprintIdentity(), recipient = await generateFingerprintIdentity();
  const senderPublic = fingerprintPublicIdentity(sender), recipientPublic = fingerprintPublicIdentity(recipient);
  const { syncId } = await (await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).json() as { syncId: string };
  const register = (device: typeof source, publicIdentity: typeof senderPublic) => call("/kiosk/fingerprint-sync/identity", { publicIdentity, fingerprint: fingerprintIdentityId(publicIdentity) }, device.kioskToken, "PUT");
  assert.equal((await register(source, senderPublic)).status, 200);
  assert.equal((await register(destination, recipientPublic)).status, 200);
  const model = Buffer.alloc(1536, 37);
  const envelope = sealFingerprintTemplate(model, { sender, recipient: recipientPublic, context: {
    installationId: syncId, senderId: source.kioskId, recipientId: destination.kioskId, senderPairingId: source.pairingId, recipientPairingId: destination.pairingId,
    senderKeyId: fingerprintIdentityId(senderPublic), recipientKeyId: fingerprintIdentityId(recipientPublic), memberId: "SYN-001", enrollmentId: "synthetic-reset-enrollment",
    transferId: "synthetic-reset-transfer", revision: 1, issuedAt: Date.now(), expiresAt: Date.now() + 600000,
  } });
  model.fill(0);
  assert.equal((await call("/kiosk/fingerprint-sync/deliveries", envelope, source.kioskToken)).status, 202);
  const pending = (device: typeof source, id: string) => {
    database.sqlite.prepare("INSERT INTO kiosk_fingerprint_reset_batches(id,installation_id,actor_user_id,created_at,processed_at) VALUES(?,'primary','admin',?,?)").run(id, Date.now(), Date.now());
    database.sqlite.prepare("INSERT INTO kiosk_fingerprint_reset_commands(id,batch_id,installation_id,kiosk_id,pairing_id,created_at) VALUES(?,?,'primary',?,?,?)").run(id, id, device.kioskId, device.pairingId, Date.now());
  };
  // Inject only the per-pair command boundary to exercise query-time races.
  // The actual reset transaction additionally rotates authority and clears rows.
  pending(destination, "synthetic-recipient-reset");
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync", undefined, destination.kioskToken)).json(), { enabled: false, syncId: null });
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync/peers", undefined, source.kioskToken)).json(), { peers: [] });
  assert.equal((await register(destination, recipientPublic)).status, 409);
  assert.equal((await call("/kiosk/fingerprint-sync/deliveries", undefined, destination.kioskToken)).status, 409);
  assert.equal((await call("/kiosk/fingerprint-sync/deliveries/synthetic-reset-transfer", undefined, source.kioskToken)).status, 404);
  const proof = createHash("sha256").update(Buffer.from(envelope.signature, "base64")).digest("hex");
  assert.equal((await call("/kiosk/fingerprint-sync/deliveries/synthetic-reset-transfer/result", { status: "complete", digest: proof }, destination.kioskToken)).status, 409);
  assert.equal((await call("/kiosk/fingerprint-sync/deliveries", envelope, source.kioskToken)).status, 409);
  assert.equal(database.sqlite.prepare("SELECT status FROM kiosk_fingerprint_deliveries").get()?.status, "pending");
  database.sqlite.prepare("UPDATE kiosk_fingerprint_reset_commands SET acknowledged_at=? WHERE id='synthetic-recipient-reset'").run(Date.now());
  pending(source, "synthetic-source-reset");
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync", undefined, source.kioskToken)).json(), { enabled: false, syncId: null });
  assert.equal((await call("/kiosk/fingerprint-sync/deliveries", envelope, source.kioskToken)).status, 409);
  assert.deepEqual(await (await call("/kiosk/fingerprint-sync/deliveries", undefined, destination.kioskToken)).json(), { deliveries: [] });
  assert.equal((await call("/kiosk/fingerprint-sync/deliveries/synthetic-reset-transfer/result", { status: "complete", digest: proof }, destination.kioskToken)).status, 404);
  assert.equal(database.sqlite.prepare("SELECT status FROM kiosk_fingerprint_deliveries").get()?.status, "pending");
});

test("fingerprint registration rechecks reset commands after asynchronous key validation", async (context) => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Synthetic reset-race kiosk"), identity = publicSyncIdentity();
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).status, 200);
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  let queued = false;
  const interception = context.mock.method(crypto.subtle, "importKey", async (...args: Parameters<typeof crypto.subtle.importKey>) => {
    const key = await importKey(...args);
    if (!queued) {
      queued = true;
      database.sqlite.prepare("INSERT INTO kiosk_fingerprint_reset_batches(id,installation_id,actor_user_id,created_at,processed_at) VALUES('synthetic-race-reset','primary','admin',?,?)").run(Date.now(), Date.now());
      database.sqlite.prepare("INSERT INTO kiosk_fingerprint_reset_commands(id,batch_id,installation_id,kiosk_id,pairing_id,created_at) VALUES('synthetic-race-command','synthetic-race-reset','primary',?,?,?)").run(device.kioskId, device.pairingId, Date.now());
    }
    return key;
  });
  assert.equal((await call("/kiosk/fingerprint-sync/identity", identity, device.kioskToken, "PUT")).status, 409);
  interception.mock.restore();
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM kiosk_fingerprint_keys").get()?.count, 0);
});


test("fingerprint registration rechecks kiosk credentials after asynchronous key validation", async (context) => {
  const { database, call, pair } = await fixture(context);
  const device = await pair("Synthetic credential-race kiosk"), identity = publicSyncIdentity();
  assert.equal((await call("/admin/kiosks/fingerprint-sync", { enabled: true }, undefined, "PATCH")).status, 200);
  const importKey = crypto.subtle.importKey.bind(crypto.subtle);
  let rotated = false;
  const interception = context.mock.method(crypto.subtle, "importKey", async (...args: Parameters<typeof crypto.subtle.importKey>) => {
    const key = await importKey(...args);
    if (!rotated) {
      rotated = true;
      database.sqlite.prepare("UPDATE kiosks SET token_hash=? WHERE id=?").run(hash("synthetic-replaced-credential"), device.kioskId);
    }
    return key;
  });
  assert.equal((await call("/kiosk/fingerprint-sync/identity", identity, device.kioskToken, "PUT")).status, 409);
  interception.mock.restore();
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM kiosk_fingerprint_keys").get()?.count, 0);
  assert.equal((await call("/kiosk/fingerprint-sync", undefined, device.kioskToken)).status, 401);
});

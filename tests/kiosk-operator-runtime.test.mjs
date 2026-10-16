import assert from "node:assert/strict";
import test from "node:test";
import { createOperatorPresence } from "../apps/kiosk/src/operator-presence.mjs";
import { createIdentityScanner } from "../apps/kiosk/src/scanner.mjs";
import { createPairingCache } from "../apps/kiosk/src/pairing-cache.mjs";
import { verifyEnrollmentMember } from "../apps/kiosk/src/verified-enrollment.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { createR503 } from "../apps/kiosk/src/r503.mjs";

const pageA = "synthetic-page-aaaaaaaa", pageB = "synthetic-page-bbbbbbbb";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("operator pages dominate attendance and transitions release only their owner", () => {
  const presence = createOperatorPresence();
  assert.equal(presence.status().captureSuspended, true);
  let a = presence.update({ action: "enter", pageId: pageA, mode: "attendance" });
  assert.equal(a.captureSuspended, false);
  let b = presence.update({ action: "enter", pageId: pageB, mode: "maintenance" });
  assert.equal(b.captureSuspended, true);
  a = presence.update({ action: "renew", pageId: pageA, generation: a.generation, mode: "attendance" });
  assert.equal(a.captureSuspended, true);
  const previous = b.generation;
  b = presence.update({ action: "transition", pageId: pageB, generation: previous, mode: "review" });
  assert.throws(() => presence.update({ action: "transition", pageId: pageB, generation: previous, mode: "attendance" }), /expired/);
  assert.throws(() => presence.update({ action: "renew", pageId: pageB, generation: b.generation, mode: "attendance" }), /cannot change/);
  b = presence.update({ action: "transition", pageId: pageB, generation: b.generation, mode: "attendance" });
  assert.equal(b.captureSuspended, false);
});

test("expired operator presence latches pause until deliberate local attendance recovery", () => {
  let now = 0; const presence = createOperatorPresence({ now: () => now, leaseMs: 15 });
  presence.update({ action: "enter", pageId: pageB, mode: "maintenance" });
  let a = presence.update({ action: "enter", pageId: pageA, mode: "attendance" });
  now = 10; a = presence.update({ action: "renew", pageId: pageA, generation: a.generation, mode: "attendance" });
  now = 16;
  assert.equal(presence.update({ action: "renew", pageId: pageA, generation: a.generation, mode: "attendance" }).reason, "presence_lost");
  assert.equal(presence.update({ action: "enter", pageId: pageA, mode: "attendance" }).captureSuspended, false);
});

test("acknowledged navigation leaves no phantom operator and never releases another page", () => {
  const presence = createOperatorPresence();
  let page = presence.update({ action: "enter", pageId: pageA, mode: "maintenance" });
  assert.equal(presence.update({ action: "leave", pageId: pageA, generation: page.generation, mode: page.mode }).captureSuspended, true);
  page = presence.update({ action: "enter", pageId: pageB, mode: "review" });
  presence.update({ action: "leave", pageId: pageB, generation: page.generation, mode: page.mode });
  assert.equal(presence.update({ action: "enter", pageId: pageA, mode: "attendance" }).captureSuspended, false);
  page = presence.update({ action: "enter", pageId: pageB, mode: "maintenance" });
  const attendance = presence.update({ action: "enter", pageId: pageA, mode: "attendance" });
  presence.update({ action: "leave", pageId: pageA, generation: attendance.generation, mode: attendance.mode });
  assert.equal(presence.update({ action: "enter", pageId: pageA, mode: "attendance" }).reason, "operator_active");
  assert.throws(() => presence.update({ action: "leave", pageId: pageB, generation: page.generation - 1, mode: page.mode }), /expired/);
});

test("an old attendance document expiry cannot pause its replacement", () => {
  let now = 0; const presence = createOperatorPresence({ now: () => now, leaseMs: 15 });
  presence.update({ action: "enter", pageId: pageA, mode: "attendance" });
  now = 10; const b = presence.update({ action: "enter", pageId: pageB, mode: "attendance" });
  now = 16;
  assert.equal(presence.update({ action: "renew", pageId: pageB, generation: b.generation, mode: "attendance" }).captureSuspended, false);
});

test("presence validates input and bounds open instances", () => {
  const presence = createOperatorPresence();
  for (const input of [null, [], {}, { action: "enter", pageId: pageA, mode: "shell" }, { action: "enter", pageId: pageA, mode: "attendance", command: "bad" }]) assert.throws(() => presence.update(input));
  for (let index = 0; index < 32; index++) presence.update({ action: "enter", pageId: `synthetic-page-${String(index).padStart(8,"0")}`, mode: "attendance" });
  assert.throws(() => presence.update({ action: "enter", pageId: pageA, mode: "attendance" }), /Too many/);
});

function scannerFixture(overrides = {}) {
  const events = [];
  const scanner = createIdentityScanner({ captureIdentity: async () => ({ status: "identified", memberId: "synthetic-member" }),
    queue: { pending: async () => [], enqueue: async event => { events.push(event); return true; } }, loadPairing: async () => ({ pairingId: "synthetic-pairing" }),
    flushAttendance: async () => { throw new Error("offline"); }, onDisplay: async () => {}, onCloud: () => {}, delay: async () => {}, ...overrides });
  return { scanner, events };
}

test("strict suspension discards an in-flight capture while graceful drainage still commits", async () => {
  for (const strict of [true, false]) {
    const capture = deferred(); const { scanner, events } = scannerFixture({ captureIdentity: () => capture.promise });
    const tick = scanner.tick(); await Promise.resolve();
    const paused = strict ? scanner.suspend("operator") : scanner.pauseAndDrain();
    capture.resolve({ status: "identified", memberId: "synthetic-member" });
    await Promise.all([tick, paused]);
    assert.equal(events.length, strict ? 0 : 1);
  }
});

test("strict suspension cancels pending queue inspection and waits only for a started commit", async () => {
  for (const blockAt of ["pending", "enqueue"]) {
    const started = deferred(), held = deferred(); let writes = 0;
    const { scanner } = scannerFixture({ queue: {
      pending: async () => { if (blockAt === "pending") { started.resolve(); await held.promise; } return []; },
      enqueue: async () => { writes++; started.resolve(); await held.promise; return true; },
    } });
    const tick = scanner.tick(); await started.promise;
    let acknowledged = false;
    const paused = scanner.suspend("operator").then(() => { acknowledged = true; });
    await Promise.resolve();
    assert.equal(acknowledged, blockAt === "pending");
    held.resolve(); await Promise.all([tick, paused]);
    assert.equal(writes, blockAt === "pending" ? 0 : 1);
  }
});

test("one suspension cannot release another", async () => {
  const { scanner, events } = scannerFixture();
  await scanner.suspend("operator"); await scanner.suspend("enrollment");
  scanner.release("enrollment"); await scanner.tick(); assert.equal(events.length, 0);
  scanner.release("operator"); await scanner.tick(); assert.equal(events.length, 1);
});

test("fresh enrollment roster verification rejects every unavailable or ambiguous identity", async () => {
  for (const fetchRoster of [async () => { throw new Error("503 secret"); }, async () => { throw new Error("timeout"); }, async () => ({}), async () => ({ members: [] }), async () => ({ members: [{ memberId: "m" }] }), async () => ({ members: [{ memberId: "m", rosterId: "bad id" }] }), async () => ({ members: [{ memberId: "m", rosterId: "valid", active: false }] }), async () => ({ members: [{ memberId: "m", rosterId: "one" }, { memberId: "m", rosterId: "two" }] })]) {
    await assert.rejects(() => verifyEnrollmentMember("m", fetchRoster), error => Boolean(error.code) && !error.message.includes("secret"));
  }
  assert.equal(await verifyEnrollmentMember("m", async () => ({ members: [{ memberId: "m", rosterId: "valid" }] })), "valid");
});

test("missing immutable identity cannot remove replacement mapping or touch sensor", async () => {
  let writes = 0;
  await assert.rejects(() => enrollFingerprint({ sensor: { enroll: async () => { writes++; } }, mappings: { read: async () => { writes++; } }, withSensor: operation => operation(), memberId: "m", slot: 2, replaceExisting: true }), /verified roster identity/);
  assert.equal(writes, 0);
});

test("pairing load is shared and does not expose undefined during asynchronous startup", async () => {
  const read = deferred(); let reads = 0;
  const cache = createPairingCache({ read: () => { reads++; return read.promise; }, write: async () => {} });
  const one = cache.load(), two = cache.load(); await Promise.resolve();
  assert.equal(reads, 1); read.resolve({ pairingId: "one" });
  assert.deepEqual(await Promise.all([one, two]), [{ pairingId: "one" }, { pairingId: "one" }]);
});

test("invalidated pairing read cannot resurrect old credentials and updates preserve credentials", async () => {
  const held = deferred(); let reads = 0; const written = [];
  const cache = createPairingCache({ read: () => ++reads === 1 ? held.promise : Promise.resolve({ pairingId: "new", kioskToken: "synthetic" }), write: async next => written.push(next) });
  const old = cache.load(); await Promise.resolve(); cache.invalidate();
  await cache.load(); held.resolve({ pairingId: "old" }); await old;
  await cache.update(current => ({ ...current, kioskName: "Dashboard name" }));
  assert.deepEqual(await cache.load(), { pairingId: "new", kioskToken: "synthetic", kioskName: "Dashboard name" });
  assert.equal(written.length, 1);
});

function ack(code, parameters = []) {
  const payload = [7, 0, parameters.length + 3, code, ...parameters];
  const checksum = payload.reduce((sum, value) => sum + value, 0);
  return Uint8Array.from([239, 1, 255, 255, 255, 255, ...payload, checksum >> 8, checksum & 255]);
}
test("reader removal observation distinguishes absence, presence and failure without a match search", async () => {
  for (const code of [0, 2, 1]) {
    const commands = []; const reader = createR503(async packet => { commands.push(packet[9]); return ack(code); });
    if (code === 1) await assert.rejects(reader.fingerPresent());
    else assert.equal(await reader.fingerPresent(), code === 0);
    assert.deepEqual(commands, [1]);
  }
});
test("held first enrollment finger cannot be treated as the second capture", async () => {
  const commands = [];
  const reader = createR503(async packet => { commands.push(packet[9]); return packet[9] === 0x1f ? ack(0, Array(32).fill(0)) : ack(0); });
  await assert.rejects(reader.enroll(1, { attempts: 2, delayMs: 0 }), /removed/);
  assert.equal(commands.filter(command => command === 2).length, 1);
  assert.equal(commands.includes(6), false);
});

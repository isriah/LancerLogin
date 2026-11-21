import test from "node:test";
import assert from "node:assert/strict";
import { commandPacket, createR503, createReaderHealth, r503CapacityFromParameters, r503DriverCapacity, r503FallbackCapacity, r503MaximumCapacity } from "../apps/kiosk/src/r503.mjs";
import { createR503TemplateTransfer } from "../apps/kiosk/src/r503-template-transfer.mjs";
import { createSerialExchange, takeR503Packet } from "../apps/kiosk/src/serial-transport.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { acknowledgement, createVirtualR503 } from "../scripts/virtual-kiosk/virtual-r503.mjs";

// The kiosk's real R503 driver and its real serial transport, on the virtual reader's serial port.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function bench({ timeoutMs = 60, ...reader } = {}) {
  const virtual = createVirtualR503({ timeoutMs: 10, ...reader });
  const exchange = createSerialExchange("virtual-r503", { openHandle: virtual.openHandle, timeoutMs });
  return { virtual, exchange, reader: createR503(exchange) };
}
async function enroll(reader, virtual, slot, finger, options = {}) {
  return reader.enroll(slot, { delayMs: 0, ...options, onProgress: async (step) => {
    if (step === "enroll_wait_first" || step === "enroll_wait_second") virtual.present(finger);
    if (step === "enroll_scan_accepted") virtual.lift();
    await options.onProgress?.(step);
  } });
}

// Item 22: the serial exchange.
test("a reply that arrives after the timeout is never taken as the next command's answer", async () => {
  const { virtual, reader } = bench({ timeoutMs: 60 });
  await enroll(reader, virtual, 0, "member:1001:1");
  virtual.present("member:1001:1");
  // "Finger present" is answered 90 ms later, after the kiosk stopped waiting.
  virtual.setFaults({ lateReplies: 1, lateMs: 90 });
  await assert.rejects(reader.fingerPresent(), /timed out/);
  virtual.lift();
  await sleep(60);
  // The late "finger present" answer is now waiting on the port. The reader has no finger on it.
  assert.equal(await reader.fingerPresent(), false, "the stale answer said a finger was present");
  assert.deepEqual(await reader.scan(), { status: "no_finger" });
});

test("a late reply that arrives while the next command waits is discarded, not matched to it", async () => {
  const { virtual, reader } = bench({ timeoutMs: 60 });
  await enroll(reader, virtual, 0, "member:1001:1");
  virtual.present("member:1001:1");
  // Every answer takes 30 ms; the first is 50 ms later still, so it lands while the following command is waiting.
  virtual.setFaults({ delayMs: 30, lateReplies: 1, lateMs: 50 });
  await assert.rejects(reader.fingerPresent(), /timed out/);
  virtual.lift();
  assert.equal(await reader.fingerPresent(), false, "the stale answer said a finger was present");
  virtual.setFaults({ delayMs: 0 });
  assert.deepEqual(await reader.status(), { connected: true, templateCount: 1 });
});

test("stray bytes before a reply are skipped up to the next valid packet", async () => {
  const { virtual, reader } = bench();
  virtual.setFaults({ noiseReplies: 2 });
  assert.deepEqual(await reader.status(), { connected: true, templateCount: 0 });
});

test("an unplugged reader times out, and the first command after it is plugged back in is answered correctly", async () => {
  const { virtual, reader } = bench({ timeoutMs: 40 });
  virtual.setFaults({ unplugged: true });
  await assert.rejects(reader.status(), /timed out/);
  await assert.rejects(reader.scan(), /timed out/);
  virtual.setFaults({ unplugged: false });
  assert.deepEqual(await reader.status(), { connected: true, templateCount: 0 });
});

test("in step, an acknowledgement of an unexpected length is logged and still returned, as before", async () => {
  // Two parameter bytes where the manual gives none. Only a bad header, address or checksum makes the exchange skip a packet.
  const odd = acknowledgement(0, [0, 7]), logged = [];
  const inbox = [];
  const exchange = createSerialExchange("synthetic", { timeoutMs: 60, log: (message) => logged.push(message), openHandle: async () => ({
    write: async () => { inbox.push(...odd); }, close: async () => {},
    read: async (target) => { if (!inbox.length) throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" }); const chunk = inbox.splice(0, 5); target.set(chunk); return { bytesRead: chunk.length }; },
  }) });
  assert.deepEqual([...await exchange(commandPacket(0x01), { accepts: (packet) => packet.length === 12 })], [...odd]);
  assert.deepEqual(logged, ["R503 answer to instruction 0x01 has an unexpected length (14 bytes); used as received"]);
  assert.deepEqual([...await exchange(commandPacket(0x1d), { accepts: (packet) => packet.length === 14 })], [...odd]);
  assert.equal(logged.length, 1, "an answer of the expected length is not logged");
});

test("packets are framed by header, address, length and checksum", () => {
  const packet = [...acknowledgement(0, [1, 2])];
  assert.deepEqual(takeR503Packet([0x00, 0xef, 0x01, 0x07, ...packet, 0xaa]), { packet: Uint8Array.from(packet), rest: [0xaa] });
  const corrupt = [...packet]; corrupt[corrupt.length - 1] ^= 0xff;
  assert.deepEqual(takeR503Packet([...corrupt, ...packet]), { packet: Uint8Array.from(packet), rest: [] }, "a bad checksum is not a packet");
  assert.equal(takeR503Packet(packet.slice(0, 10)).packet, undefined, "an incomplete packet waits for the rest");
  assert.deepEqual(takeR503Packet(packet.slice(0, 10)).rest, packet.slice(0, 10));
  const elsewhere = [...packet]; elsewhere[2] = 0x12;
  assert.equal(takeR503Packet(elsewhere).packet, undefined, "another address is not this reader");
  assert.deepEqual(takeR503Packet([1, 2, 3]).rest, [], "bytes with no header are dropped");
});

// Item 23: the capacity the reader reports.
test("the driver uses the capacity the reader reports", async () => {
  const { virtual, reader } = bench({ capacity: 1000 });
  assert.equal(await reader.capacity(), 1000);
  await enroll(reader, virtual, 300, "member:1001:1");
  virtual.lift();
  assert.deepEqual(await reader.occupiedSlots(), [300]);
  virtual.present("member:1001:1");
  assert.deepEqual(await reader.scan(), { status: "match", slot: 300, score: 180 });
  await assert.rejects(reader.deleteTemplate(1000), /between 0 and 999/);
  await reader.deleteTemplate(300);
  assert.deepEqual(await reader.occupiedSlots(), []);
  assert.equal(virtual.instructions().filter((instruction) => instruction === 0x0f).length, 1, "the capacity is read once");
});

test("a reader that does not report a usable capacity keeps the 200-slot fallback", async () => {
  const { virtual, reader } = bench({ reportsCapacity: false });
  assert.equal(await reader.capacity(), r503FallbackCapacity);
  await assert.rejects(reader.deleteTemplate(200), /between 0 and 199/);
  await assert.rejects(reader.enroll(200), /between 0 and 199/);
  await enroll(reader, virtual, 199, "member:1001:1");
  assert.equal(r503FallbackCapacity, 200); assert.equal(r503MaximumCapacity, 1024);
  for (const [size, expected] of [[200, 200], [1, 1], [1024, 1024], [0, undefined], [1025, undefined], [1500, undefined]]) {
    assert.equal(r503CapacityFromParameters(Uint8Array.from([0, 0, 0, 0, size >> 8, size & 0xff, 0, 3, 0xff, 0xff, 0xff, 0xff, 0, 2, 0, 6])), expected);
  }
  assert.equal(r503CapacityFromParameters(Uint8Array.from([0, 200])), undefined, "a short answer reports nothing");
});

test("an idle scan does not ask for the capacity, and a configured capacity is not read from the reader", async () => {
  const { virtual, reader } = bench({ timeoutMs: 40 });
  assert.deepEqual(await reader.scan(), { status: "no_finger" });
  assert.deepEqual(virtual.instructions(), [0x01]);
  assert.equal(await createR503(async () => { throw new Error("must not ask"); }, { capacity: 50 }).capacity(), 50);
});

test("template transfer and the driver read the capacity the same way", async () => {
  const commands = [];
  const transaction = async (operation) => operation({
    writePacket: async (kind, payload) => { commands.push([...payload]); },
    readPacket: async () => {
      const instruction = commands.at(-1)[0];
      if (instruction === 0x0f) return { kind: 7, payload: Uint8Array.from([0, 0, 0, 0, 0, 0, 100, 0, 3, 0xff, 0xff, 0xff, 0xff, 0, 2, 0, 6]) };
      return { kind: 7, payload: Uint8Array.from([0]) };
    },
  });
  const transfer = createR503TemplateTransfer(transaction);
  await assert.rejects(transfer.exportTemplate(100), /Unsupported reader parameters/, "slot 100 is outside a 100-slot reader");
  await assert.rejects(transfer.exportTemplate(r503MaximumCapacity), /Invalid template slot/);
});

test("automatic enrollment picks a slot inside the capacity the sensor reports", async () => {
  let stored = {}; const enrolled = [];
  const mappings = { read: async () => ({ ...stored }), replace: async (next) => { stored = next; }, assignIfUnmapped: async (slot, memberId) => { stored[String(slot)] = { memberId }; } };
  const sensor = { capacity: async () => 2, occupiedSlots: async () => enrolled.slice(), enroll: async (slot) => { enrolled.push(slot); return { slot }; } };
  const run = (memberId) => enrollFingerprint({ sensor, mappings, withSensor: (operation) => operation(), autoSlot: true, memberId, rosterId: "synthetic-roster-1", finger: "unspecified" });
  assert.equal((await run("1001")).slot, 0);
  assert.equal((await run("1002")).slot, 1);
  await assert.rejects(run("1003"), /No verified free fingerprint slot/);
});

test("a reported capacity that is zero, below 200, garbage or above 1024 is treated as 200", async () => {
  for (const [reported, used] of [[0, 200], [1, 200], [127, 200], [199, 200], [200, 200], [201, 201], [1000, 1000], [1024, 1024], [1025, 200], [65535, 200], [undefined, 200], [NaN, 200]]) assert.equal(r503DriverCapacity(reported), used, String(reported));
  for (const reportedCapacity of [0, 127, 1500]) {
    const { virtual, reader } = bench({ reportedCapacity });
    assert.equal(await reader.capacity(), 200);
    await enroll(reader, virtual, 199, "member:1001:1");
    await assert.rejects(reader.deleteTemplate(200), /between 0 and 199/);
    virtual.present("member:1001:1");
    assert.deepEqual(await reader.scan(), { status: "match", slot: 199, score: 180 });
  }
});

// Readers that do not answer the system-parameters question as the manual says. The kiosk has only asked it since
// this change, so with each of them it must enroll, scan and erase exactly as it did before.
for (const [name, options] of [
  ["answers the system parameters with 14 bytes", { systemParameterBytes: 14 }],
  ["answers the system parameters with 20 bytes", { systemParameterBytes: 20 }],
  ["reports system id 0 and capacity 0", { reportedCapacity: 0 }],
  ["refuses the system parameters", { reportsCapacity: false }],
  ["puts extra bytes after every acknowledgement", { trailingBytes: [0x00, 0xff, 0xef] }],
  ["never answers the system parameters", { ignoresSystemParameters: true }],
]) {
  test(`a reader that ${name} enrolls, scans and recovers from a late reply as a 200-slot reader`, async () => {
    const logged = [];
    const virtual = createVirtualR503({ timeoutMs: 10, ...options });
    const reader = createR503(createSerialExchange("virtual-r503", { openHandle: virtual.openHandle, timeoutMs: 60, log: (message) => logged.push(message) }));
    // The first thing a kiosk does with a finger after it starts is scan it.
    virtual.present("unknown:first");
    assert.deepEqual(await reader.scan(), { status: "not_found" }, "the first scan after the service starts is not a reader fault");
    assert.deepEqual(await reader.scan(), { status: "not_found" });
    assert.ok(virtual.instructions().filter((instruction) => instruction === 0x0f).length <= 1, "a scan asks for the capacity at most once");
    virtual.lift();
    assert.equal(await reader.capacity(), 200);
    assert.deepEqual(await enroll(reader, virtual, 7, "member:1001:1"), { slot: 7 });
    virtual.lift();
    assert.deepEqual(await reader.occupiedSlots(), [7]);
    virtual.present("member:1001:1");
    assert.deepEqual(await reader.scan(), { status: "match", slot: 7, score: 180 });
    await assert.rejects(reader.enroll(200), /between 0 and 199/);
    // One answer arrives after the kiosk stopped waiting. At most the next two commands fail; then it works again.
    virtual.setFaults({ lateReplies: 1, lateMs: 90 });
    await assert.rejects(reader.scan(), /timed out/);
    await sleep(60);
    const afterwards = [];
    for (let attempt = 0; attempt < 3; attempt += 1) afterwards.push(await reader.scan().then((result) => result.status, () => "failed"));
    assert.equal(afterwards.at(-1), "match", afterwards.join(", "));
    assert.ok(afterwards.filter((status) => status === "failed").length <= 1, afterwards.join(", "));
    assert.deepEqual(await reader.status(), { connected: true, templateCount: 1 });
    await reader.deleteTemplate(7);
    assert.deepEqual(await reader.occupiedSlots(), []);
    if (options.systemParameterBytes) assert.ok(logged.some((message) => /instruction 0x0f has an unexpected length/.test(message)));
  });
}

test("a reader that is gone fails every command, and one probe failure does not hide it", async () => {
  const { virtual, reader } = bench({ timeoutMs: 30 });
  assert.equal(await reader.capacity(), 200);
  virtual.setFaults({ unplugged: true });
  for (let attempt = 0; attempt < 4; attempt += 1) await assert.rejects(reader.status(), /timed out/);
  virtual.setFaults({ unplugged: false });
  assert.deepEqual(await reader.status(), { connected: true, templateCount: 0 });
});

// Item 21: momentary imaging failures.
for (const fault of ["faint", "garbled"]) {
  test(`enrollment keeps going after a momentary ${fault} image in either capture`, async () => {
    const { virtual, reader } = bench();
    const result = await enroll(reader, virtual, 5, "member:1001:1", { onProgress: async (step) => { if (step === "enroll_wait_first" || step === "enroll_wait_second") virtual.setFaults({ image: fault, imageReads: 2 }); } });
    assert.deepEqual(result, { slot: 5 });
    virtual.present("member:1001:1");
    assert.deepEqual(await reader.scan(), { status: "match", slot: 5, score: 180 });
  });
}

test("enrollment keeps going when the image fails while it waits for the finger to lift", async () => {
  const { virtual, reader } = bench();
  const result = await reader.enroll(6, { delayMs: 5, onProgress: async (step) => {
    if (step === "enroll_wait_first" || step === "enroll_wait_second") virtual.present("member:1001:1");
    // The finger stays on for two failed reads, then lifts.
    if (step === "enroll_scan_accepted") { virtual.setFaults({ image: "faint", imageReads: 2 }); virtual.present("member:1001:1", 15); }
  } });
  assert.deepEqual(result, { slot: 6 });
});

test("enrollment still stops when the image keeps failing", async () => {
  const { virtual, reader } = bench();
  await assert.rejects(enroll(reader, virtual, 7, "member:1001:1", { onProgress: async (step) => { if (step === "enroll_wait_first") virtual.setFaults({ image: "faint", imageReads: 20 }); } }), /too faint/);
  virtual.setFaults({ image: null });
  assert.deepEqual(await reader.occupiedSlots(), []);
});

test("a failed image during the finger-removal check counts as a finger still on the reader, not a fault", async () => {
  const { virtual, reader } = bench();
  virtual.present("member:1001:1");
  virtual.setFaults({ image: "faint" });
  assert.equal(await reader.fingerPresent(), true);
  // A garbled request is still an error, but one that carries the reader's own answer: the service retries it.
  virtual.setFaults({ image: "garbled" });
  await assert.rejects(reader.fingerPresent(), (error) => error.code === 0x01 && createReaderHealth().failure(error) === "retry");
  virtual.lift();
  assert.equal(await reader.fingerPresent(), false);
});

test("the reader is reported offline for a transport error at once, and for refusals only after three in a row", () => {
  const health = createReaderHealth();
  const refusal = Object.assign(new Error("The fingerprint reader could not receive the request. Try again."), { code: 0x01 });
  assert.equal(health.failure(refusal), "retry");
  assert.equal(health.failure(refusal), "retry");
  assert.equal(health.failure(refusal), "offline", "three refusals in a row");
  health.success();
  assert.equal(health.failure(refusal), "retry", "a good read starts the count again");
  assert.equal(health.failure(new Error("R503 response timed out")), "offline", "no answer at all");
  assert.equal(createReaderHealth().failure(Object.assign(new Error("ENOENT"), { code: "ENOENT" })), "offline", "a missing serial port is not a reader answer");
});

test("a reader that keeps refusing stays offline until a good read", () => {
  const health = createReaderHealth();
  const refusal = Object.assign(new Error("refused"), { code: 0x01 });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => health.failure(refusal)), ["retry", "retry", "offline", "offline", "offline"]);
  health.success();
  assert.equal(health.failure(refusal), "retry");
});

test("a reader that refuses the re-synchronising probe is back in step once it has answered", async () => {
  // This reader does not report its parameters at all: the probe after a timeout is refused, not ignored.
  const { virtual, reader } = bench({ timeoutMs: 40, reportsCapacity: false });
  virtual.setFaults({ lateReplies: 1, lateMs: 70 });
  await assert.rejects(reader.fingerPresent(), /timed out/);
  assert.equal(await reader.fingerPresent(), false);
  assert.deepEqual(await reader.status(), { connected: true, templateCount: 0 });
});

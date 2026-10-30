import test from "node:test";
import assert from "node:assert/strict";
import { createHash, sign as signBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOfflineQueue, createSensorAdapter, issuePairingCode, redeemPairingCode } from "../apps/kiosk/src/local-runtime.mjs";
import { completeKioskCommand, createDeliveryBackoff, fetchKioskCommand, fetchKioskConfiguration, normalizeApiUrl, pairInstallation, sendAttendance, sendHeartbeat } from "../apps/kiosk/src/cloud-client.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { createCredentialStore } from "../apps/kiosk/src/credential-store.mjs";
import { createIdentityInput } from "../apps/kiosk/src/identity-input.mjs";
import { identityReadyState, identityUnknownState, normalizeIdentityMethod } from "../apps/kiosk/src/identity-methods.mjs";
import { resolveIdentityObservation } from "../apps/kiosk/src/identity-resolver.mjs";
import { createRosterCache } from "../apps/kiosk/src/roster-cache.mjs";
import { commandPacket, createR503, parseAcknowledgement } from "../apps/kiosk/src/r503.mjs";
import { createR503PacketDecoder, encodeR503Packet } from "../apps/kiosk/src/r503-packets.mjs";
import { createR503Transaction } from "../apps/kiosk/src/r503-transaction.mjs";
import { createR503TemplateTransfer, r503TemplateBytes } from "../apps/kiosk/src/r503-template-transfer.mjs";
import { generateFingerprintIdentity, fingerprintPublicIdentity, fingerprintIdentityId, sealFingerprintTemplate, openFingerprintTemplate, fingerprintEnvelopeDigest } from "../apps/kiosk/src/fingerprint-envelope.mjs";
import { createFingerprintIdentityStore } from "../apps/kiosk/src/fingerprint-identity-store.mjs";
import { acquireFingerprintStateLock } from "../apps/kiosk/src/fingerprint-state-lock.mjs";
import { createFingerprintJournal } from "../apps/kiosk/src/fingerprint-journal.mjs";
import { createFingerprintReceiver } from "../apps/kiosk/src/fingerprint-receiver.mjs";
import { createFingerprintOutbox } from "../apps/kiosk/src/fingerprint-outbox.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { createFingerprintSender } from "../apps/kiosk/src/fingerprint-sender.mjs";
import { createFingerprintCloudClient } from "../apps/kiosk/src/fingerprint-cloud-client.mjs";
import { createFingerprintSync } from "../apps/kiosk/src/fingerprint-sync.mjs";
import { kioskApp, kioskHtml, kioskIdentityStyles, kioskReaderStatus, kioskStatusStyles, kioskStyles } from "../apps/kiosk/src/ui.mjs";
import { decodePairingKey } from "../apps/kiosk/src/pairing-key.mjs";
import { createIdentityScanner, createScanner } from "../apps/kiosk/src/scanner.mjs";
import { kioskStates as presentationStates } from "../apps/kiosk/src/kiosk-presentation.mjs";
import { kioskStates as deviceStates } from "../apps/kiosk/src/kiosk-states.mjs";
import { createNetworkManager } from "../apps/kiosk/src/network-manager.mjs";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";
import { prepareLegacyFingerprintImport } from "../apps/kiosk/scripts/prepare-legacy-fingerprint-import.mjs";
import { networkApp, networkStyles } from "../apps/kiosk/src/network-ui.mjs";
import { maintenanceApp, maintenanceHtml, maintenanceLayoutStyles, maintenanceStyles } from "../apps/kiosk/src/maintenance-ui.mjs";
import { recoveryApp } from "../apps/kiosk/src/recovery-ui.mjs";
import { startVerifiedKioskUpdate } from "../apps/kiosk/src/update-command.mjs";
import { kioskScrollbarStyles, maintenanceScrollbarStyles } from "../apps/kiosk/src/scrollbar-styles.mjs";
import { resolveKioskRelease } from "../apps/kiosk/src/resolve-kiosk-release.mjs";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";

test("R503 packet stream preserves fragmented and coalesced synthetic packets", () => {
  const command = encodeR503Packet(1, Uint8Array.of(0x1d));
  assert.deepEqual(command, commandPacket(0x1d));
  const expected = [
    { kind: 7, payload: Uint8Array.of(0) },
    { kind: 2, payload: Uint8Array.from({ length: 256 }, (_, index) => index) },
    { kind: 8, payload: Uint8Array.of(3, 2, 1) },
  ];
  const stream = Uint8Array.from(expected.flatMap(({ kind, payload }) => [...encodeR503Packet(kind, payload)]));
  for (let split = 0; split <= stream.length; split += 1) {
    const decoder = createR503PacketDecoder();
    assert.deepEqual([...decoder.push(stream.slice(0, split)), ...decoder.push(stream.slice(split))], expected);
    decoder.finish();
  }
  const decoder = createR503PacketDecoder();
  assert.deepEqual([...stream].flatMap((byte) => decoder.push(Uint8Array.of(byte))), expected);
  decoder.finish();
});

test("R503 packet stream rejects malformed frames without including payloads in errors", () => {
  const original = encodeR503Packet(8, new TextEncoder().encode("synthetic-private-payload"));
  for (const [index, value] of [[0, 0], [2, 0], [6, 3], [7, 255], [8, 2], [original.length - 1, original.at(-1) ^ 1]]) {
    const bytes = original.slice(); bytes[index] = value;
    const decoder = createR503PacketDecoder();
    assert.throws(() => decoder.push(bytes), (error) => {
      assert.equal(error.message, "Invalid or incomplete R503 packet stream");
      return true;
    });
    assert.throws(() => decoder.push(original), /Invalid or incomplete/);
  }
  for (let length = 1; length < original.length; length += 1) {
    const decoder = createR503PacketDecoder();
    decoder.push(original.slice(0, length));
    assert.throws(() => decoder.finish(), /Invalid or incomplete/);
  }
});

test("R503 packet stream enforces byte limits, expected address and transaction disposal", () => {
  for (const invalid of [0, 266, 65537, NaN]) assert.throws(() => createR503PacketDecoder({ maxBufferedBytes: invalid }), /limits/);
  for (const address of [-1, 0x100000000, 1.5]) assert.throws(() => createR503PacketDecoder({ address }), /limits/);
  for (const payload of [[], new Uint8Array(), new Uint8Array(257)]) assert.throws(() => encodeR503Packet(2, payload), /parameters/);
  assert.throws(() => encodeR503Packet(3, Uint8Array.of(0)), /parameters/);
  const decoder = createR503PacketDecoder({ maxBufferedBytes: 267 });
  assert.throws(() => decoder.push(new Uint8Array(268)), /Invalid or incomplete/);
  const addressed = createR503PacketDecoder({ address: 0x12345678 });
  assert.deepEqual(addressed.push(encodeR503Packet(7, Uint8Array.of(0), 0x12345678)), [{ kind: 7, payload: Uint8Array.of(0) }]);
  addressed.finish();
  assert.throws(() => addressed.push(new Uint8Array()), /Invalid or incomplete/);
  const abandoned = createR503PacketDecoder();
  abandoned.push(Uint8Array.of(0xef));
  abandoned.dispose();
  assert.throws(() => abandoned.push(encodeR503Packet(7, Uint8Array.of(0))), /Invalid or incomplete/);
});

test("R503 transaction preserves packets on one descriptor and retries partial I/O", async () => {
  const stream = [...encodeR503Packet(7, Uint8Array.of(0)), ...encodeR503Packet(8, Uint8Array.of(1, 2, 3))];
  const written = [];
  let opened = 0, closed = 0, writes = 0, reads = 0, clock = 0;
  const transaction = createR503Transaction("synthetic", {
    now: () => clock, wait: async (ms) => { clock += ms; },
    openHandle: async () => {
      opened += 1;
      return {
        write: async (bytes, offset, length) => {
          if (writes++ === 0) throw Object.assign(new Error("temporary"), { code: "EAGAIN" });
          const count = Math.min(3, length); written.push(...bytes.subarray(offset, offset + count));
          return { bytesWritten: count };
        },
        read: async (target) => {
          if (reads++ === 0) throw Object.assign(new Error("temporary"), { code: "EWOULDBLOCK" });
          const bytes = stream.splice(0, reads === 2 ? 4 : 512); target.set(bytes); return { bytesRead: bytes.length };
        },
        close: async () => { closed += 1; },
      };
    },
  });
  const packets = await transaction(async ({ writePacket, readPacket }) => {
    await writePacket(1, Uint8Array.of(8, 1));
    return [await readPacket(), await readPacket()];
  });
  assert.deepEqual(written, [...encodeR503Packet(1, Uint8Array.of(8, 1))]);
  assert.deepEqual(packets, [{ kind: 7, payload: Uint8Array.of(0) }, { kind: 8, payload: Uint8Array.of(1, 2, 3) }]);
  assert.equal(opened, 1); assert.equal(closed, 1);
});

test("R503 transaction times out, cancels and closes without exposing transport errors", async () => {
  for (const mode of ["timeout", "cancel", "error", "truncated", "trailing", "limit"]) {
    let clock = 0, closed = 0;
    const controller = new AbortController();
    const transaction = createR503Transaction("synthetic", {
      timeoutMs: 20, maxBytes: 267, now: () => clock, wait: async (ms) => { clock += ms; },
      openHandle: async () => ({
        read: async (target) => {
          if (mode === "error") throw new Error("synthetic-private-payload");
          if (mode === "cancel") controller.abort();
          const bytes = mode === "truncated" ? Uint8Array.of(0xef) : mode === "trailing"
            ? Uint8Array.from([...encodeR503Packet(7, Uint8Array.of(0)), ...encodeR503Packet(8, Uint8Array.of(1))])
            : mode === "limit" ? new Uint8Array(268) : new Uint8Array();
          target.set(bytes); return { bytesRead: bytes.length };
        },
        close: async () => { closed += 1; },
      }),
    });
    await assert.rejects(transaction(async ({ readPacket }) => { await readPacket(); }, { signal: controller.signal }), (error) => {
      assert.doesNotMatch(error.message, /synthetic-private-payload/);
      assert.equal(error.cause, undefined);
      assert.match(error.message, mode === "cancel" ? /cancelled/ : mode === "timeout" || mode === "truncated" ? /timed out/ : /failed/);
      return true;
    });
    assert.equal(closed, 1);
  }
  const cancelled = new AbortController(); cancelled.abort();
  const transaction = createR503Transaction("synthetic", { openHandle: async () => { assert.fail("Must not open a cancelled transaction"); } });
  await assert.rejects(transaction(async () => {}, { signal: cancelled.signal }), /cancelled/);
});

test("R503 transactions serialize connections and recover after a failed operation", async () => {
  let active = 0, opens = 0, closes = 0;
  const transaction = createR503Transaction("synthetic", { openHandle: async () => {
    opens += 1; active += 1; assert.equal(active, 1);
    return { close: async () => { closes += 1; active -= 1; } };
  } });
  const failed = transaction(async () => { throw new Error("synthetic-private-payload"); });
  let escaped;
  const next = transaction(async (io) => { escaped = io; return "complete"; });
  await assert.rejects(failed, { message: "R503 serial transaction failed" });
  assert.equal(await next, "complete");
  assert.equal(opens, 2); assert.equal(closes, 2);
  await assert.rejects(escaped.readPacket(), /closed/);
});

test("R503 transaction cannot report success after a caught I/O failure", async () => {
  let closed = 0;
  const transaction = createR503Transaction("synthetic", { openHandle: async () => ({
    write: async () => { throw new Error("synthetic-private-payload"); },
    close: async () => { closed += 1; },
  }) });
  await assert.rejects(transaction(async ({ writePacket }) => {
    await assert.rejects(writePacket(1, Uint8Array.of(8, 1)));
    return "must-not-succeed";
  }), { message: "R503 serial transaction failed" });
  assert.equal(closed, 1);
});

function syntheticTemplateReader({ packetCode = 2, occupied = [false, false], corruptReadback = false, earlyEnd = false, failStore = false } = {}) {
  const template = Uint8Array.from({ length: r503TemplateBytes }, (_, index) => index % 251);
  const commands = [], uploaded = [], responses = [], waits = [];
  let awaitingPacketPace = false;
  let indexReads = 0;
  const transaction = async (operation) => operation({
    writePacket: async (kind, data) => {
      assert.equal(awaitingPacketPace, false, "Pace each data frame before the next packet or command");
      if (kind !== 1) { uploaded.push({ kind, payload: Uint8Array.from(data) }); awaitingPacketPace = true; return; }
      const instruction = data[0]; commands.push([...data]);
      const ack = Uint8Array.of(instruction === 6 && failStore ? 0x18 : 0);
      if (instruction === 0x0f) {
        const parameters = new Uint8Array(17); parameters[6] = 200; parameters[14] = packetCode;
        responses.push({ kind: 7, payload: parameters }); return;
      }
      if (instruction === 0x1f) {
        const index = new Uint8Array(33); if (occupied[Math.min(indexReads++, occupied.length - 1)]) index[2] = 1 << 4;
        responses.push({ kind: 7, payload: index }); return;
      }
      responses.push({ kind: 7, payload: ack });
      if (instruction === 8) {
        const packetBytes = 32 * (2 ** packetCode);
        for (let offset = 0; offset < template.length; offset += packetBytes) {
          const payload = template.slice(offset, offset + packetBytes);
          if (corruptReadback && offset === 0) payload[0] ^= 1;
          responses.push({ kind: earlyEnd || offset + packetBytes === template.length ? 8 : 2, payload });
        }
      }
    },
    readPacket: async () => {
      assert.ok(responses.length, "Unexpected synthetic reader read"); return responses.shift();
    },
  });
  const wait = async ms => { assert.equal(awaitingPacketPace, true); waits.push(ms); awaitingPacketPace = false; };
  return { adapter: createR503TemplateTransfer(transaction, { wait }), template, commands, uploaded, waits };
}

test("R503 template transfer exports exact bounded synthetic templates at every packet size", async () => {
  for (const packetCode of [0, 1, 2, 3]) {
    const fake = syntheticTemplateReader({ packetCode, occupied: [true] });
    const result = await fake.adapter.exportTemplate(12);
    assert.deepEqual(result, fake.template);
    assert.deepEqual(fake.commands.map((command) => command[0]), [0x13, 0x0f, 0x1f, 0x07, 0x08]);
    result.fill(0);
  }
});

test("R503 template transfer imports only into an empty slot and verifies stored bytes", async () => {
  for (const packetCode of [0, 1, 2, 3]) {
    const fake = syntheticTemplateReader({ packetCode });
    assert.deepEqual(await fake.adapter.importTemplate(12, fake.template), { slot: 12, verified: true });
    assert.deepEqual(fake.commands.map((command) => command[0]), [0x13, 0x0f, 0x1f, 0x09, 0x1f, 0x06, 0x07, 0x08]);
    assert.deepEqual(Uint8Array.from(fake.uploaded.flatMap((packet) => [...packet.payload])), fake.template);
    assert.equal(fake.uploaded.at(-1).kind, 8);
    assert.ok(fake.uploaded.slice(0, -1).every((packet) => packet.kind === 2));
    assert.equal(fake.waits.length, fake.uploaded.length);
    assert.ok(fake.waits.every(ms => ms >= Math.ceil((32 * (2 ** packetCode) + 11) * 10000 / 57600) + 15));
  }
});

test("R503 template transfer never overwrites occupied slots, including a late collision", async () => {
  for (const occupied of [[true], [false, true]]) {
    const fake = syntheticTemplateReader({ occupied });
    await assert.rejects(fake.adapter.importTemplate(12, fake.template), /occupied/);
    assert.ok(fake.commands.every((command) => command[0] !== 6));
    assert.ok(fake.commands.every((command) => ![0x0c, 0x0d].includes(command[0])));
  }
  const empty = syntheticTemplateReader();
  await assert.rejects(empty.adapter.exportTemplate(12), /empty/);
  assert.ok(empty.commands.every((command) => command[0] !== 8));
});

test("R503 template transfer rejects malformed sizes, unsupported parameters and incomplete data", async () => {
  const fake = syntheticTemplateReader();
  for (const input of [new Uint8Array(512), new Uint8Array(1535), new Uint8Array(1537), []]) {
    await assert.rejects(fake.adapter.importTemplate(12, input), /size/);
  }
  assert.equal(fake.commands.length, 0);
  await assert.rejects(fake.adapter.exportTemplate(-1), /slot/);
  assert.equal(fake.commands.length, 0);
  const unsupported = syntheticTemplateReader({ packetCode: 4, occupied: [true] });
  await assert.rejects(unsupported.adapter.exportTemplate(12), /parameters/);
  const incomplete = syntheticTemplateReader({ earlyEnd: true, occupied: [true] });
  await assert.rejects(incomplete.adapter.exportTemplate(12), /sequence/);
});

test("R503 template transfer reports failed storage and mismatched readback without deleting", async () => {
  for (const options of [{ failStore: true }, { corruptReadback: true }]) {
    const fake = syntheticTemplateReader(options);
    await assert.rejects(fake.adapter.importTemplate(12, fake.template), /failed/);
    assert.equal(fake.commands.filter((command) => command[0] === 6).length, 1);
    assert.ok(fake.commands.every((command) => ![0x0c, 0x0d].includes(command[0])));
  }
});

let envelopeIdentities;
async function syntheticFingerprintEnvelope() {
  envelopeIdentities ??= Promise.all([generateFingerprintIdentity(), generateFingerprintIdentity(), generateFingerprintIdentity()]);
  const [sender, recipient, stranger] = await envelopeIdentities;
  const source = fingerprintPublicIdentity(sender), target = fingerprintPublicIdentity(recipient);
  const now = 1700000000000;
  const context = {
    installationId: "synthetic-installation", senderId: "kiosk-a", recipientId: "kiosk-b",
    senderPairingId: "pairing-a", recipientPairingId: "pairing-b", memberId: "synthetic-member",
    enrollmentId: "synthetic-enrollment", transferId: "synthetic-transfer",
    senderKeyId: fingerprintIdentityId(source), recipientKeyId: fingerprintIdentityId(target),
    revision: 1, issuedAt: now, expiresAt: now + 86400000,
  };
  const template = Uint8Array.from({ length: r503TemplateBytes }, (_, index) => (index * 7) % 251);
  const envelope = sealFingerprintTemplate(template, { sender, recipient: target, context, now });
  return { sender, recipient, stranger, source, target, now, context, template, envelope };
}

test("fingerprint outbox persists exact encrypted retries and cannot revive terminal deliveries", async () => {
  const data = await syntheticFingerprintEnvelope();
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-outbox-"));
  const path = join(directory, "outbox.json"); let now = data.now;
  const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const create = () => createFingerprintOutbox(path, binding, { publicIdentity: data.source, now: () => now });
  try {
    const digest = fingerprintEnvelopeDigest(data.envelope, { sender: data.source, expected: data.context, now });
    assert.equal(digest, createHash("sha256").update(Buffer.from(data.envelope.signature, "base64")).digest("hex"));
    await create().enqueue(data.envelope);
    assert.deepEqual((await create().pending())[0].envelope, data.envelope);
    assert.equal((await create().pending())[0].digest, digest);
    await create().enqueue(data.envelope);
    assert.equal((await create().pending()).length, 1);
    const stored = await readFile(path, "utf8");
    assert.equal(stored.includes(Buffer.from(data.template).toString("base64")), false);
    assert.equal(stored.includes("PRIVATE KEY"), false);
    const other = sealFingerprintTemplate(data.template, { sender: data.sender, recipient: data.target, context: data.context, now });
    await assert.rejects(create().enqueue(other), /local review/);
    await assert.rejects(create().finish(data.context.transferId, "0".repeat(64), "complete"), /local review/);
    await create().finish(data.context.transferId, digest, "complete");
    await create().finish(data.context.transferId, digest, "complete");
    assert.equal((await create().pending()).length, 0);
    assert.equal((await readFile(path, "utf8")).includes(data.envelope.ciphertext), false);
    assert.deepEqual(await create().enqueue(data.envelope), { transferId: data.context.transferId, status: "complete" });
    await assert.rejects(create().finish(data.context.transferId, digest, "rejected"), /local review/);
    const expiring = sealFingerprintTemplate(data.template, { sender: data.sender, recipient: data.target, context: { ...data.context, transferId: "expiring" }, now });
    await create().enqueue(expiring); now = data.context.expiresAt;
    assert.equal((await create().pending()).length, 0);
    assert.equal((await create().status()).find(record => record.transferId === "expiring").status, "expired");
    assert.equal((await readFile(path, "utf8")).includes(expiring.ciphertext), false);
    await assert.rejects(create().enqueue(expiring), /authenticated/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint outbox rejects tampering, pairing substitution, corrupt storage and stale locks", async () => {
  const data = await syntheticFingerprintEnvelope();
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-outbox-invalid-"));
  const path = join(directory, "outbox.json");
  const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const create = (bound = binding) => createFingerprintOutbox(path, bound, { publicIdentity: data.source, now: () => data.now });
  try {
    await assert.rejects(create().enqueue({ ...data.envelope, privateKey: "forbidden" }), /authenticated/);
    await assert.rejects(create().enqueue({ ...data.envelope, signature: Buffer.alloc(64).toString("base64") }), /authenticated/);
    await create().enqueue(data.envelope);
    await assert.rejects(create({ ...binding, pairingId: "new-pairing" }).pending(), /local review/);
    if (process.platform === "linux") await rm(`${path}.lock`, { recursive: true });
    await writeFile(`${path}.lock`, "", { mode: 0o600 });
    await assert.rejects(create().pending(), error => error.reasonCode === "local_state_review");
    await rm(`${path}.lock`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.records[0].envelope.context.memberId = "substituted";
    await writeFile(path, JSON.stringify(stored), { mode: 0o600 });
    await assert.rejects(create().pending(), /local review/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint outbox enforces owner-only files and rejects symlinks", { skip: process.platform === "win32" }, async () => {
  const data = await syntheticFingerprintEnvelope();
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-outbox-mode-"));
  const path = join(directory, "outbox.json"), alias = join(directory, "alias.json");
  const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const create = target => createFingerprintOutbox(target, binding, { publicIdentity: data.source, now: () => data.now });
  try {
    await create(path).enqueue(data.envelope);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await symlink(path, alias); await assert.rejects(create(alias).pending(), /local review/);
    await chmod(path, 0o644); await assert.rejects(create(path).pending(), /local review/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint enrollment reads mappings under the sensor lock and preserves concurrent additions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-enrollment-"));
  const mappings = createMappingStore(join(directory, "mappings.json"));
  let locked = false, enrolled = false;
  try {
    await enrollFingerprint({ mappings, slot: 3, memberId: "new-member", rosterId: "stable-new", finger: "right index",
      withSensor: async operation => { await mappings.assignIfUnmapped(2, "synced-member"); locked = true; try { return await operation(); } finally { locked = false; } },
      sensor: { enroll: async () => { assert.equal(locked, true); enrolled = true; } } });
    assert.equal(enrolled, true);
    assert.equal(await mappings.memberForSlot(2), "synced-member");
    assert.equal(await mappings.memberForSlot(3), "new-member");
    await assert.rejects(enrollFingerprint({ mappings, slot: 3, memberId: "other", rosterId: "stable-other", finger: "left index", withSensor: operation => operation(), sensor: { enroll: () => assert.fail("occupied mapping must stop enrollment") } }), /already mapped/);
    await assert.rejects(enrollFingerprint({ mappings, slot: 3, memberId: "other", rosterId: "stable-other", finger: "left index", replaceExisting: true, withSensor: operation => operation(),
      sensor: { enroll: async () => { assert.equal(await mappings.memberForSlot(3), undefined); throw new Error("Synthetic reader interruption"); } } }), /interruption/);
    assert.equal(await mappings.memberForSlot(3), undefined);
    assert.equal(await mappings.memberForSlot(2), "synced-member");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint sync supports roster IDs with spaces and Unicode but rejects control characters", async () => {
  const data = await syntheticFingerprintEnvelope();
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-member-id-"));
  try {
    const context = { ...data.context, memberId: "Équipe / 007" };
    const envelope = sealFingerprintTemplate(data.template, { sender: data.sender, recipient: data.target, context, now: data.now });
    const clear = openFingerprintTemplate(envelope, { recipient: data.recipient, sender: data.source, expected: context, now: data.now });
    clear.fill(0);
    const journal = createFingerprintJournal(join(directory, "journal.json"), { installationId: context.installationId, kioskId: context.recipientId, pairingId: context.recipientPairingId });
    assert.equal((await journal.reserve(context, "a".repeat(64), { capacity: 200, occupiedSlots: [], mappedSlots: [] })).memberId, context.memberId);
    for (const memberId of ["bad\nmember", " padded", "", "a".repeat(101)]) assert.throws(() => sealFingerprintTemplate(data.template, { sender: data.sender, recipient: data.target, context: { ...context, memberId }, now: data.now }), /authenticated/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint sender exports new enrollments once and retries exact ciphertext through restart", async () => {
  const data = await syntheticFingerprintEnvelope();
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-sender-"));
  const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const peer = { installationId: binding.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId, fingerprint: data.context.recipientKeyId, publicIdentity: data.target };
  const mappings = createMappingStore(join(directory, "mappings.json"));
  const outbox = createFingerprintOutbox(join(directory, "outbox.json"), binding, { publicIdentity: data.source, now: () => data.now });
  let exports = 0, outcome = "offline", enabled = true, sent = [], exported;
  const identities = { status: async () => ({ enabled, binding, fingerprint: data.context.senderKeyId, peers: [peer] }), withApprovedPeer: async (id, pairing, operation) => {
    assert.equal(enabled, true); assert.equal(id, peer.kioskId); assert.equal(pairing, peer.pairingId); return operation({ identity: data.sender, peer, binding });
  } };
  const create = () => createFingerprintSender({ identities, mappings, outbox, now: () => data.now, withSensor: operation => operation(), isMemberActive: async () => true,
    templates: { exportTemplate: async slot => { assert.equal(slot, 3); exports++; exported = Buffer.from(data.template); return exported; } },
    send: async envelope => { sent.push(structuredClone(envelope)); if (outcome === "offline") throw new Error("Synthetic network loss"); return { transferId: envelope.context.transferId, status: outcome }; } });
  try {
    await mappings.assignIfUnmapped(1, "legacy-member", "right index");
    await mappings.assignIfUnmapped(2, "received-member");
    await mappings.assignIfUnmapped(3, "synthetic-member", "left index", { id: "11111111-1111-4111-8111-111111111111", occurredAt: data.now }, "stable-member");
    const sender = create();
    const [first, concurrent] = await Promise.all([sender.tick(), sender.tick()]);
    assert.deepEqual(first, concurrent); assert.equal(first.captured, 1); assert.equal(first.errors, 1);
    assert.equal(exports, 1); assert.equal(exported.every(byte => byte === 0), true);
    outcome = "pending"; await create().tick(); assert.equal(exports, 1);
    assert.deepEqual(sent[1], sent[0]);
    const clear = openFingerprintTemplate(sent[0], { recipient: data.recipient, sender: data.source, expected: sent[0].context, now: data.now });
    assert.deepEqual([...clear], [...data.template]); clear.fill(0);
    outcome = "complete"; assert.equal((await create().tick()).completed, 1);
    await create().tick(); assert.equal(exports, 1); assert.equal(sent.length, 3);
    assert.equal((await outbox.pending()).length, 0);
    enabled = false; assert.equal((await create().tick()).enabled, false); assert.equal(sent.length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint sender refuses a changed slot and cancels queued data after peer revocation", async () => {
  const data = await syntheticFingerprintEnvelope();
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-sender-revoke-"));
  const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const peer = { kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId, fingerprint: data.context.recipientKeyId, publicIdentity: data.target };
  const mappings = createMappingStore(join(directory, "mappings.json"));
  const outbox = createFingerprintOutbox(join(directory, "outbox.json"), binding, { publicIdentity: data.source, now: () => data.now });
  let trusted = true, changed = true, exports = 0, sends = 0;
  const identities = { status: async () => ({ enabled: true, binding, fingerprint: data.context.senderKeyId, peers: trusted ? [peer] : [] }), withApprovedPeer: async (id, pairing, operation) => {
    if (!trusted) throw new Error("Not approved"); return operation({ identity: data.sender, peer, binding });
  } };
  const sender = createFingerprintSender({ identities, mappings, outbox, now: () => data.now, isMemberActive: async () => true,
    withSensor: async operation => { if (changed) await mappings.replace({ 3: { memberId: "different-member", finger: "other" } }); return operation(); },
    templates: { exportTemplate: async () => { exports++; return Buffer.from(data.template); } },
    send: async () => { sends++; throw new Error("Synthetic offline"); } });
  try {
    const enrollment = { id: "11111111-1111-4111-8111-111111111111", occurredAt: data.now };
    await mappings.assignIfUnmapped(3, "synthetic-member", "left index", enrollment, "stable-member");
    assert.equal((await sender.tick()).errors, 1); assert.equal(exports, 0); assert.equal(sends, 0);
    changed = false; await mappings.replace({ 3: { memberId: "synthetic-member", rosterId: "stable-member", finger: "left index", enrollment } });
    await sender.tick(); assert.equal(exports, 1); assert.equal(sends, 1);
    trusted = false; await sender.tick();
    assert.equal(exports, 1); assert.equal(sends, 1); assert.equal((await outbox.status())[0].status, "revoked");
    assert.equal((await outbox.pending()).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint sender requires fresh immutable enrollment and revokes a queued retired association without reader access", async () => {
  const data = await syntheticFingerprintEnvelope(), directory = await mkdtemp(join(tmpdir(), "fingerprint-fresh-source-"));
  const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const peer = { kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId, fingerprint: data.context.recipientKeyId, publicIdentity: data.target };
  const mappings = createMappingStore(join(directory, "mappings.json"));
  const outbox = createFingerprintOutbox(join(directory, "outbox.json"), binding, { publicIdentity: data.source, now: () => data.now });
  let reads = 0, sends = 0, rosterId = "stable-member";
  const identities = { status: async () => ({ enabled: true, binding, fingerprint: data.context.senderKeyId, peers: [peer] }), withApprovedPeer: async (_id, _pairing, operation) => operation({ identity: data.sender, peer, binding }) };
  const factory = () => createFingerprintSender({ identities, mappings, outbox, now: () => data.now, withSensor: operation => operation(),
    isMemberActive: async (_memberId, identity) => identity === rosterId,
    templates: { exportTemplate: async () => { reads++; return Buffer.from(data.template); } }, send: async () => { sends++; throw new Error("Synthetic offline"); } });
  const enrollment = { id: "11111111-1111-4111-8111-111111111111", occurredAt: data.now };
  try {
    await mappings.replace({ 3: { memberId: "synthetic-member", finger: "legacy", enrollment } });
    assert.equal((await factory().tick()).captured, 0); assert.equal(reads, 0);
    await mappings.replace({ 3: { memberId: "synthetic-member", rosterId: "stable-member", finger: "index", enrollment } });
    rosterId = "recycled-row"; assert.equal((await factory().tick()).captured, 0); assert.equal(reads, 0);
    rosterId = "stable-member"; assert.equal((await factory().tick()).captured, 1); assert.equal(reads, 1); assert.equal(sends, 1);
    const review = { manifestId: "a".repeat(64), revision: 1, vaultId: null, reviewGrantId: "retired-grant", mappingDigest: "b".repeat(64), slotProof: "c".repeat(64), originalMemberId: "old", approvedMemberId: "synthetic-member", rosterId: "stable-member", sourceSlot: 3 };
    await mappings.replace({ 3: { memberId: "synthetic-member", rosterId: "stable-member", finger: "index", enrollment, review } });
    assert.equal((await factory().tick()).captured, 0); assert.equal(reads, 1); assert.equal(sends, 1); assert.equal((await outbox.status())[0].status, "revoked");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint cloud client bounds replies, forbids redirects and redacts failures", async () => {
  const config = { apiUrl: "https://example.test", kioskToken: "synthetic-token" };
  let response = Response.json({ enabled: false }), calls = [];
  const client = createFingerprintCloudClient(config, { fetchImpl: async (url, options) => { calls.push({ url, options }); return response; } });
  assert.deepEqual(await client.configuration(), { enabled: false });
  assert.equal(calls[0].url, "https://example.test/kiosk/fingerprint-sync");
  assert.equal(calls[0].options.redirect, "error"); assert.ok(calls[0].options.signal instanceof AbortSignal);
  response = Response.json({ transferId: "delivery", status: "complete" });
  await client.acknowledge("delivery", { status: "complete", digest: "a".repeat(64), slot: 5, ignored: "must not transmit" });
  assert.deepEqual(JSON.parse(calls[1].options.body), { status: "complete", digest: "a".repeat(64) });
  assert.throws(() => client.status("../identity"), /Invalid/);
  assert.throws(() => client.pending("../identity"), /Invalid/);
  response = Response.json({ deliveries: [] }); await client.pending("delivery:008");
  assert.equal(calls.at(-1).url, "https://example.test/kiosk/fingerprint-sync/deliveries?after=delivery%3A008");
  response = new Response("private provider detail", { status: 409 });
  await assert.rejects(client.configuration(), error => error.status === 409 && !error.message.includes("private provider"));
  response = new Response("x".repeat(65537)); await assert.rejects(client.configuration(), /saved deliveries will retry/);
  response = new Response("not JSON"); await assert.rejects(client.configuration(), /saved deliveries will retry/);
});

test("fingerprint controllers sync one enrollment only after mutual approval and preserve occupied destination slots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-controller-"));
  const now = 1700000000000, registrations = new Map(), deliveries = new Map();
  let installationEnabled = true, rosterAvailable = true, exports = 0;
  const syncId = "a".repeat(64), original = Buffer.alloc(1536, 7), enrolled = Buffer.alloc(1536, 42);
  function device(id, slots) {
    const mappings = createMappingStore(join(directory, id, "mappings.json"));
    const config = { kioskId: id, pairingId: `pair-${id}` };
    const client = {
      configuration: async () => ({ enabled: installationEnabled, syncId }),
      register: async identity => { registrations.set(id, { ...identity, kioskId: id, pairingId: config.pairingId, installationId: syncId, name: id }); return { registered: true, fingerprint: identity.fingerprint }; },
      revoke: async () => { registrations.delete(id); return { revoked: true }; },
      peers: async () => ({ peers: [...registrations.values()].filter(peer => peer.kioskId !== id) }),
      send: async envelope => {
        const previous = deliveries.get(envelope.context.transferId);
        if (!previous) deliveries.set(envelope.context.transferId, { envelope: structuredClone(envelope), status: "pending" });
        return { transferId: envelope.context.transferId, status: deliveries.get(envelope.context.transferId).status };
      },
      pending: async after => ({ deliveries: [...deliveries.values()].filter(delivery => delivery.status === "pending" && delivery.envelope.context.recipientId === id && delivery.envelope.context.transferId > (after ?? "")).map(delivery => structuredClone(delivery.envelope)).sort((a, b) => a.context.transferId < b.context.transferId ? -1 : 1).slice(0, 8) }),
      acknowledge: async (transferId, result) => {
        const delivery = deliveries.get(transferId);
        assert.equal(delivery.envelope.context.recipientId, id);
        assert.equal(result.digest, createHash("sha256").update(Buffer.from(delivery.envelope.signature, "base64")).digest("hex"));
        delivery.status = "complete"; delivery.envelope = null;
        return { transferId, status: "complete" };
      },
    };
    const controller = createFingerprintSync({ directory: join(directory, id, "sync"), config, client, mappings, now: () => now,
      withSensor: operation => operation(), sensor: { occupiedSlots: async () => [...slots.keys()] },
      templates: { exportTemplate: async slot => { exports++; if (!slots.has(slot)) throw new Error("Missing slot"); return Buffer.from(slots.get(slot)); },
        importTemplate: async (slot, bytes) => { assert.equal(slots.has(slot), false); slots.set(slot, Buffer.from(bytes)); return { slot, verified: true }; } },
      fetchRoster: async () => { if (!rosterAvailable) throw new Error("Synthetic offline"); return { members: [{ memberId: "member / 1", rosterId: "stable-member" }] }; },
    });
    return { controller, mappings };
  }
  try {
    const source = device("source", new Map([[5, enrolled]]));
    const destinationSlots = new Map([[0, original]]), destination = device("destination", destinationSlots);
    await source.mappings.assignIfUnmapped(5, "member / 1", "right index", { id: "11111111-1111-4111-8111-111111111111", occurredAt: now }, "stable-member");
    assert.equal((await source.controller.tick()).status, "disabled"); assert.equal(exports, 0);
    await source.controller.setEnabled(true); await destination.controller.setEnabled(true);
    await source.controller.tick(); assert.equal(exports, 0);
    const sourceState = await source.controller.status(), destinationState = await destination.controller.status();
    await assert.rejects(source.controller.approvePeer("destination", "0".repeat(64)), /compare fingerprints/);
    await source.controller.approvePeer("destination", destinationState.fingerprint);
    await destination.controller.approvePeer("source", sourceState.fingerprint);
    rosterAvailable = false; assert.equal((await source.controller.tick()).status, "unavailable"); assert.equal(exports, 0);
    rosterAvailable = true;
    assert.equal((await source.controller.tick()).captured, 1);
    const valid = [...deliveries.values()][0].envelope;
    for (let index = 0; index < 8; index++) {
      const transferId = `-blocked-${index}`;
      deliveries.set(transferId, { status: "pending", envelope: { ...valid, context: { ...valid.context, transferId, senderId: "unapproved-source" } } });
    }
    const blockedPage = await destination.controller.tick();
    assert.equal(blockedPage.errors, 8); assert.equal(blockedPage.received, 0);
    assert.equal(destinationSlots.size, 1);
    assert.equal((await destination.controller.tick()).received, 1);
    assert.deepEqual(destinationSlots.get(0), original); assert.deepEqual(destinationSlots.get(1), enrolled);
    assert.equal(await destination.mappings.memberForSlot(1), "member / 1");
    assert.equal((await destination.mappings.read())[1].enrollment, undefined);
    assert.equal((await source.controller.tick()).completed, 1);
    assert.equal(deliveries.size, 9); assert.equal([...deliveries.values()][0].envelope, null);
    assert.equal((await destination.controller.tick()).errors, 8);
    assert.equal([...deliveries.values()].filter(delivery => delivery.status === "pending").length, 8);
    const count = exports; installationEnabled = false;
    assert.equal((await source.controller.tick()).status, "installation_disabled"); assert.equal(exports, count);
    await source.controller.setEnabled(false); assert.equal((await source.controller.diagnostics()).status, "installation_disabled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint sender rotates capture attempts past unavailable reader slots", async () => {
  const data = await syntheticFingerprintEnvelope();
  const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const peer = { kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId, fingerprint: data.context.recipientKeyId, publicIdentity: data.target };
  const entries = Object.fromEntries(Array.from({ length: 9 }, (_, slot) => [slot, { memberId: "synthetic-member", rosterId: "stable-member", enrollment: { id: `11111111-1111-4111-8111-${String(slot).padStart(12, "0")}`, occurredAt: data.now } }]));
  const attempted = [], saved = [];
  const sender = createFingerprintSender({
    identities: { status: async () => ({ enabled: true, binding, fingerprint: data.context.senderKeyId, peers: [peer] }), withApprovedPeer: async (_id, _pairing, operation) => operation({ identity: data.sender, peer, binding }) },
    mappings: { read: async () => entries }, outbox: { status: async () => saved.map(envelope => ({ transferId: envelope.context.transferId })), enqueue: async envelope => saved.push(envelope), pending: async () => [] },
    templates: { exportTemplate: async slot => { attempted.push(slot); if (slot < 8) throw new Error("Synthetic unavailable slot"); return Buffer.from(data.template); } },
    withSensor: operation => operation(), isMemberActive: async () => true, send: async () => assert.fail("No pending fixture deliveries"), now: () => data.now,
  });
  assert.equal((await sender.tick()).errors, 8); assert.deepEqual(attempted, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal((await sender.tick()).captured, 1); assert.equal(attempted[8], 8); assert.equal(saved.length, 1);
  await sender.tick(); assert.equal(attempted.filter(slot => slot === 8).length, 1);
});

test("fingerprint sync can be disabled after an offline restart without accepting another pairing", async () => {
  const data = await syntheticFingerprintEnvelope();
  const directory = await mkdtemp(join(tmpdir(), "fingerprint-offline-disable-"));
  const config = { kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
  const binding = { installationId: data.context.installationId, ...config };
  const identities = createFingerprintIdentityStore(join(directory, "identity.json"), binding);
  const peer = { installationId: binding.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId, fingerprint: data.context.recipientKeyId, publicIdentity: data.target };
  const client = { configuration: async () => { throw new Error("Offline"); }, revoke: async () => { throw new Error("Offline"); } };
  const create = (pairing = config) => createFingerprintSync({ directory, config: pairing, client, mappings: {}, sensor: {}, templates: {}, withSensor: () => assert.fail("No reader operation during offline disable"), fetchRoster: () => assert.fail("No roster fetch during offline disable"), now: () => data.now });
  try {
    const identity = await identities.setEnabled(true); await identities.approvePeer(peer, peer.fingerprint);
    const outbox = createFingerprintOutbox(join(directory, "outbox.json"), binding, { publicIdentity: identity.publicIdentity, now: () => data.now });
    const envelope = await identities.withApprovedPeer(peer.kioskId, peer.pairingId, ({ identity: sender }) => sealFingerprintTemplate(data.template, { sender, recipient: data.target, context: { ...data.context, senderKeyId: identity.fingerprint }, now: data.now }));
    await outbox.enqueue(envelope);
    const restarted = create(), status = await restarted.status();
    assert.equal(status.offline, true); assert.equal(status.enabled, true); assert.equal(status.installationEnabled, false);
    await restarted.revokePeer(peer.kioskId);
    assert.equal((await identities.status()).peers.length, 0);
    await assert.rejects(create({ ...config, pairingId: "unrelated-pairing" }).setEnabled(false), /local review/);
    assert.equal((await identities.status()).enabled, true);
    assert.equal((await restarted.setEnabled(false)).enabled, false);
    assert.equal((await identities.status()).enabled, false);
    assert.equal((await outbox.pending()).length, 0);
    assert.equal((await outbox.status())[0].status, "revoked");
    assert.equal((await create().status()).enabled, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprint envelope round trips only for approved identities without exposing plaintext", async () => {
  const data = await syntheticFingerprintEnvelope();
  const opened = openFingerprintTemplate(data.envelope, { recipient: data.recipient, sender: data.source, expected: data.context, now: data.now });
  assert.deepEqual([...opened], [...data.template]); opened.fill(0);
  const second = sealFingerprintTemplate(data.template, { sender: data.sender, recipient: data.target, context: data.context, now: data.now });
  assert.notEqual(data.envelope.ciphertext, second.ciphertext);
  assert.notEqual(data.envelope.wrappedKey, second.wrappedKey);
  assert.equal(JSON.stringify(data.envelope).includes(Buffer.from(data.template).toString("base64")), false);
  assert.deepEqual(Object.keys(data.source).sort(), ["encryption", "signing"]);
});

test("fingerprint envelope rejects tampering, key substitution and mismatched trusted context", async () => {
  const data = await syntheticFingerprintEnvelope();
  const options = { recipient: data.recipient, sender: data.source, expected: data.context, now: data.now };
  for (const field of ["ciphertext", "wrappedKey", "nonce", "tag", "signature"]) {
    const bytes = Buffer.from(data.envelope[field], "base64"); bytes[0] ^= 1;
    assert.throws(() => openFingerprintTemplate({ ...data.envelope, [field]: bytes.toString("base64") }, options), /could not be authenticated/);
  }
  for (const field of Object.keys(data.context)) {
    const altered = { ...data.context, [field]: typeof data.context[field] === "number" ? data.context[field] + 1 : `${data.context[field]}x` };
    assert.throws(() => openFingerprintTemplate({ ...data.envelope, context: altered }, options), /could not be authenticated/);
    assert.throws(() => openFingerprintTemplate(data.envelope, { ...options, expected: altered }), /could not be authenticated/);
  }
  assert.throws(() => openFingerprintTemplate(data.envelope, { ...options, recipient: data.stranger }), /could not be authenticated/);
  assert.throws(() => openFingerprintTemplate(data.envelope, { ...options, sender: fingerprintPublicIdentity(data.stranger) }), /could not be authenticated/);
  assert.throws(() => sealFingerprintTemplate(data.template, { sender: data.sender, recipient: fingerprintPublicIdentity(data.stranger), context: data.context, now: data.now }), /could not be authenticated/);
});

test("fingerprint envelope rejects expiry, unbounded input, unknown fields and ambiguous encoding", async () => {
  const data = await syntheticFingerprintEnvelope();
  const options = { recipient: data.recipient, sender: data.source, expected: data.context, now: data.now };
  assert.throws(() => openFingerprintTemplate(data.envelope, { ...options, now: data.context.expiresAt }), /could not be authenticated/);
  assert.throws(() => openFingerprintTemplate(data.envelope, { ...options, now: data.now - 300001 }), /could not be authenticated/);
  for (const altered of [
    { ...data.envelope, version: 2 }, { ...data.envelope, extra: true },
    { ...data.envelope, ciphertext: "a".repeat(100000) },
    { ...data.envelope, nonce: data.envelope.nonce + "\n" },
    { ...data.envelope, context: { ...data.context, memberId: "unsafe\nmember" } },
  ]) assert.throws(() => openFingerprintTemplate(altered, options), /could not be authenticated/);
  for (const context of [
    { ...data.context, revision: 0 }, { ...data.context, expiresAt: data.now + 8 * 86400000 },
    { ...data.context, issuedAt: NaN }, { ...data.context, recipientId: data.context.senderId },
  ]) assert.throws(() => sealFingerprintTemplate(data.template, { sender: data.sender, recipient: data.target, context, now: data.now }), /could not be authenticated/);
});

test("fingerprint envelope does not release plaintext when a signed message has an invalid GCM tag", async () => {
  const data = await syntheticFingerprintEnvelope();
  const tag = Buffer.from(data.envelope.tag, "base64"); tag[0] ^= 1;
  const envelope = { ...data.envelope, tag: tag.toString("base64") };
  const fields = ["installationId", "senderId", "recipientId", "senderPairingId", "recipientPairingId", "memberId", "enrollmentId", "transferId", "senderKeyId", "recipientKeyId", "revision", "issuedAt", "expiresAt"];
  const aad = Buffer.from(JSON.stringify(["LancerLogin fingerprint sync v1", "r503-model-1536", ...fields.map((field) => data.context[field])]));
  envelope.signature = signBytes(null, Buffer.from(JSON.stringify([aad.toString("base64"), envelope.wrappedKey, envelope.nonce, envelope.ciphertext, envelope.tag])), data.sender.signing.privateKey).toString("base64");
  assert.throws(() => openFingerprintTemplate(envelope, { recipient: data.recipient, sender: data.source, expected: data.context, now: data.now }), { message: "Fingerprint transfer could not be authenticated" });
});

test("fingerprint identity store defaults off, persists keys privately and binds to one pairing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-identity-"));
  try {
    const path = join(root, "identity.json");
    const binding = { installationId: "synthetic-installation", kioskId: "kiosk-a", pairingId: "pairing-a" };
    const store = createFingerprintIdentityStore(path, binding);
    assert.deepEqual(await store.status(), { enabled: false, binding, publicIdentity: null, fingerprint: null, peers: [] });
    await assert.rejects(readFile(path), { code: "ENOENT" });
    const enabled = await store.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.doesNotMatch(JSON.stringify(enabled), /PRIVATE KEY|"keys"/);
    assert.deepEqual(await createFingerprintIdentityStore(path, binding).status(), enabled);
    const disabled = await store.setEnabled(false);
    assert.equal(disabled.enabled, false); assert.equal(disabled.fingerprint, enabled.fingerprint);
    await assert.rejects(createFingerprintIdentityStore(path, { ...binding, pairingId: "replacement" }).setEnabled(true), /local review/);
    assert.equal((await store.status()).fingerprint, enabled.fingerprint);
    const raw = await readFile(path, "utf8");
    assert.match(raw, /PRIVATE KEY/);
    await writeFile(path, "corrupt", { mode: 0o600 });
    await assert.rejects(store.setEnabled(true), /local review/);
    assert.equal(await readFile(path, "utf8"), "corrupt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint identity trust requires explicit confirmation and cannot silently replace a peer", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-trust-"));
  try {
    const data = await syntheticFingerprintEnvelope();
    const binding = { installationId: data.context.installationId, kioskId: data.context.senderId, pairingId: data.context.senderPairingId };
    const path = join(root, "identity.json");
    const store = createFingerprintIdentityStore(path, binding);
    const candidate = { installationId: binding.installationId, kioskId: "kiosk-b", pairingId: "pairing-b", publicIdentity: data.target, fingerprint: fingerprintIdentityId(data.target) };
    await assert.rejects(store.approvePeer(candidate, candidate.fingerprint), /local review/);
    await store.setEnabled(true);
    await assert.rejects(store.approvePeer(candidate, "unconfirmed"), /local review/);
    await assert.rejects(store.approvePeer({ ...candidate, installationId: "other-installation" }, candidate.fingerprint), /local review/);
    await store.approvePeer(candidate, candidate.fingerprint);
    const restarted = createFingerprintIdentityStore(path, binding);
    assert.equal((await restarted.status()).peers.length, 1);
    assert.equal(await restarted.withApprovedPeer("kiosk-b", "pairing-b", ({ peer }) => peer.fingerprint), candidate.fingerprint);
    await assert.rejects(restarted.withApprovedPeer("kiosk-b", "replacement", () => assert.fail("Must not use unapproved pairing")), /local review/);
    const changedIdentity = fingerprintPublicIdentity(data.stranger);
    const replacement = { ...candidate, publicIdentity: changedIdentity, fingerprint: fingerprintIdentityId(changedIdentity) };
    await assert.rejects(restarted.approvePeer(replacement, replacement.fingerprint), /local review/);
    await restarted.setEnabled(false);
    await assert.rejects(restarted.withApprovedPeer("kiosk-b", "pairing-b", () => assert.fail("Must not use disabled sync")), /local review/);
    await restarted.setEnabled(true);
    await restarted.revokePeer("kiosk-b");
    await assert.rejects(restarted.withApprovedPeer("kiosk-b", "pairing-b", () => assert.fail("Must not use revoked peer")), /local review/);
    await restarted.approvePeer(replacement, replacement.fingerprint);
    assert.equal((await restarted.status()).peers[0].fingerprint, replacement.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint identity store preserves state when another writer holds its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-lock-"));
  try {
    const path = join(root, "identity.json");
    const store = createFingerprintIdentityStore(path, { installationId: "synthetic-installation", kioskId: "kiosk-a", pairingId: "pairing-a" });
    const original = await store.setEnabled(true);
    const lock = await acquireFingerprintStateLock(`${path}.lock`);
    try {
      const lockInode = (await stat(`${path}.lock`)).ino;
      await assert.rejects(store.setEnabled(false), /local review/);
      assert.deepEqual(await store.status(), original);
      assert.equal((await stat(`${path}.lock`)).ino, lockInode);
    } finally { await lock.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint identity storage enforces Linux ownership permissions and refuses symlinks", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-permissions-"));
  try {
    const path = join(root, "identity.json");
    const binding = { installationId: "synthetic-installation", kioskId: "kiosk-a", pairingId: "pairing-a" };
    const store = createFingerprintIdentityStore(path, binding);
    await store.setEnabled(true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await assert.rejects(store.status(), /local review/);
    await chmod(path, 0o600);
    const linkPath = join(root, "linked.json");
    await symlink(path, linkPath);
    await assert.rejects(createFingerprintIdentityStore(linkPath, binding).setEnabled(true), /local review/);
    await chmod(root, 0o755);
    await assert.rejects(store.status(), /local review/);
    await chmod(root, 0o700);
    assert.equal((await store.status()).enabled, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint journal reserves around real occupancy and resumes one slot across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-journal-"));
  try {
    const data = await syntheticFingerprintEnvelope();
    const binding = { installationId: data.context.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId };
    const path = join(root, "journal.json");
    let journal = createFingerprintJournal(path, binding);
    const request = [data.context, "a".repeat(64), { capacity: 200, occupiedSlots: [0, 1, 3], mappedSlots: [2] }];
    const reserved = await journal.reserve(...request);
    assert.equal(reserved.slot, 4); assert.equal(reserved.phase, "reserved");
    journal = createFingerprintJournal(path, binding);
    assert.deepEqual(await journal.reserve(...request), reserved);
    await assert.rejects(journal.advance(reserved.transferId, "reserved", "complete"), /local review/);
    for (const [from, to] of [["reserved", "stored"], ["stored", "mapped"], ["mapped", "complete"]]) {
      await journal.advance(reserved.transferId, from, to);
      journal = createFingerprintJournal(path, binding);
      assert.equal((await journal.reserve(...request)).phase, to);
      assert.equal((await journal.advance(reserved.transferId, from, to)).phase, to);
    }
    assert.equal((await journal.list()).length, 1);
    const saved = await readFile(path, "utf8");
    assert.doesNotMatch(saved, /ciphertext|PRIVATE KEY|template/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint journal rejects replay variants, stale revisions and re-paired destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-replay-"));
  try {
    const data = await syntheticFingerprintEnvelope();
    const binding = { installationId: data.context.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId };
    const path = join(root, "journal.json"); const journal = createFingerprintJournal(path, binding);
    const slots = { capacity: 200, occupiedSlots: [], mappedSlots: [] };
    await journal.reserve(data.context, "a".repeat(64), slots);
    await assert.rejects(journal.reserve(data.context, "b".repeat(64), slots), /local review/);
    await assert.rejects(journal.reserve({ ...data.context, transferId: "different-transfer" }, "a".repeat(64), slots), /local review/);
    await assert.rejects(journal.reserve({ ...data.context, transferId: "new-revision", revision: 2 }, "b".repeat(64), slots), /local review/);
    for (const [from, to] of [["reserved", "stored"], ["stored", "mapped"], ["mapped", "complete"]]) await journal.advance(data.context.transferId, from, to);
    await assert.rejects(journal.reserve({ ...data.context, transferId: "other-member", memberId: "another-member", revision: 2 }, "b".repeat(64), slots), /local review/);
    const next = await journal.reserve({ ...data.context, transferId: "new-revision", revision: 2 }, "b".repeat(64), slots);
    assert.equal(next.slot, 1);
    await assert.rejects(createFingerprintJournal(path, { ...binding, pairingId: "new-pairing" }).list(), /local review/);
    await assert.rejects(journal.reserve({ ...data.context, recipientId: "wrong-kiosk" }, "a".repeat(64), slots), /local review/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint journal fails closed on full readers, unreadable occupancy and corrupt history", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-journal-failure-"));
  try {
    const data = await syntheticFingerprintEnvelope();
    const binding = { installationId: data.context.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId };
    const path = join(root, "journal.json"); const journal = createFingerprintJournal(path, binding);
    await assert.rejects(journal.reserve(data.context, "a".repeat(64), { capacity: 2, occupiedSlots: [0, 1], mappedSlots: [] }), /no available slot/);
    await assert.rejects(journal.reserve(data.context, "a".repeat(64), { capacity: 2, occupiedSlots: undefined, mappedSlots: [] }), /local review/);
    const reserved = await journal.reserve(data.context, "a".repeat(64), { capacity: 2, occupiedSlots: [], mappedSlots: [] });
    await journal.advance(reserved.transferId, "reserved", "needs_review");
    await assert.rejects(journal.advance(reserved.transferId, "reserved", "stored"), /local review/);
    await writeFile(path, "corrupt", { mode: 0o600 });
    await assert.rejects(journal.reserve(data.context, "a".repeat(64), { capacity: 2, occupiedSlots: [], mappedSlots: [] }), /local review/);
    assert.equal(await readFile(path, "utf8"), "corrupt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint journal serializes concurrent reservations without reusing a slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-journal-concurrent-"));
  try {
    const data = await syntheticFingerprintEnvelope();
    const binding = { installationId: data.context.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId };
    const path = join(root, "journal.json"); const journal = createFingerprintJournal(path, binding);
    const requests = Array.from({ length: 4 }, (_, index) => journal.reserve({ ...data.context, transferId: `transfer-${index}`, enrollmentId: `enrollment-${index}` }, "a".repeat(64), { capacity: 8, occupiedSlots: [0], mappedSlots: [1] }));
    assert.deepEqual((await Promise.all(requests)).map((record) => record.slot), [2, 3, 4, 5]);
    assert.equal((await createFingerprintJournal(path, binding).list()).length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint journal enforces Linux file and directory permissions", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-journal-mode-"));
  try {
    const data = await syntheticFingerprintEnvelope();
    const binding = { installationId: data.context.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId };
    const path = join(root, "journal.json"); const journal = createFingerprintJournal(path, binding);
    await journal.reserve(data.context, "a".repeat(64), { capacity: 200, occupiedSlots: [], mappedSlots: [] });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644); await assert.rejects(journal.list(), /local review/); await chmod(path, 0o600);
    const alias = join(root, "linked.json"); await symlink(path, alias);
    await assert.rejects(createFingerprintJournal(alias, binding).list(), /local review/);
    await chmod(root, 0o755); await assert.rejects(journal.list(), /local review/); await chmod(root, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint receiver resumes safely after interruption at each durable boundary", async () => {
  for (const crashAt of ["before-import", "after-import", "stored", "after-mapping", "mapped", "complete"]) {
    const root = await mkdtemp(join(tmpdir(), "kiosk-sync-receive-"));
    try {
      const data = await syntheticFingerprintEnvelope();
      const binding = { installationId: data.context.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId };
      const slots = new Map([[0, Uint8Array.from({ length: r503TemplateBytes }, () => 42)]]);
      const mappingPath = join(root, "mappings.json"), journalPath = join(root, "journal.json");
      await createMappingStore(mappingPath).replace({ 99: { memberId: "preserved-member", finger: "right index" } });
      let crashed = false, imports = 0, sensorLocked = false;
      const trip = (point) => { if (!crashed && point === crashAt) { crashed = true; throw new Error("Synthetic interruption"); } };
      function receiver() {
        const journal = createFingerprintJournal(journalPath, binding), mappings = createMappingStore(mappingPath);
        return createFingerprintReceiver({
          identities: { withApprovedPeer: async (_id, _pairing, operation) => operation({ identity: data.recipient, binding, peer: { kioskId: data.context.senderId, pairingId: data.context.senderPairingId, fingerprint: data.context.senderKeyId, publicIdentity: data.source } }) },
          journal: { reserve: (...args) => journal.reserve(...args), advance: async (...args) => { const result = await journal.advance(...args); trip(args[2]); return result; } },
          mappings: { ...mappings, assignIfUnmapped: async (...args) => { const result = await mappings.assignIfUnmapped(...args); trip("after-mapping"); return result; } },
          sensor: { occupiedSlots: async () => { assert.equal(sensorLocked, true); return [...slots.keys()]; } },
          templates: {
            exportTemplate: async (slot) => { assert.equal(sensorLocked, true); return slots.get(slot).slice(); },
            importTemplate: async (slot, template) => {
              assert.equal(sensorLocked, true); trip("before-import"); assert.equal(slots.has(slot), false);
              imports += 1; slots.set(slot, Uint8Array.from(template)); trip("after-import"); return { slot, verified: true };
            },
          },
          isMemberActive: async (memberId) => memberId === data.context.memberId,
          withSensor: async (operation) => { assert.equal(sensorLocked, false); sensorLocked = true; try { return await operation(); } finally { sensorLocked = false; } },
          now: () => data.now,
        });
      }
      await assert.rejects(receiver().receive(data.envelope), /Synthetic interruption/);
      const completed = await receiver().receive(data.envelope);
      assert.deepEqual(completed, { transferId: data.context.transferId, slot: 1, status: "complete", digest: createHash("sha256").update(Buffer.from(data.envelope.signature, "base64")).digest("hex") });
      assert.deepEqual(await receiver().receive(data.envelope), completed);
      assert.equal(imports, 1);
      assert.deepEqual([...slots.get(1)], [...data.template]);
      assert.ok(slots.get(0).every((byte) => byte === 42));
      assert.equal(await createMappingStore(mappingPath).memberForSlot(99), "preserved-member");
      assert.equal(await createMappingStore(mappingPath).memberForSlot(1), data.context.memberId);
      assert.equal((await createFingerprintJournal(journalPath, binding).list())[0].phase, "complete");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("slot mapping assignment preserves unrelated entries and fails closed on corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-sync-map-"));
  try {
    const path = join(root, "mappings.json"), mappings = createMappingStore(path);
    await mappings.replace({ 0: "legacy-member" });
    await Promise.all([mappings.assignIfUnmapped(1, "member-1"), mappings.assignIfUnmapped(2, "member-2")]);
    assert.equal(await mappings.memberForSlot(0), "legacy-member");
    assert.equal(await mappings.memberForSlot(2), "member-2");
    await assert.rejects(mappings.assignIfUnmapped(1, "another-member"), /already mapped/);
    await writeFile(path, "[]", { mode: 0o600 });
    await assert.rejects(mappings.assignIfUnmapped(3, "member-3"), /Invalid/);
    assert.equal(await readFile(path, "utf8"), "[]");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint receiver refuses tampering, inactive members and ambiguous stored slots", async () => {
  for (const mode of ["tampered", "inactive", "unapproved", "collision", "missing", "other-member"]) {
    const root = await mkdtemp(join(tmpdir(), "kiosk-sync-receive-refusal-"));
    try {
      const data = await syntheticFingerprintEnvelope();
      const binding = { installationId: data.context.installationId, kioskId: data.context.recipientId, pairingId: data.context.recipientPairingId };
      const journal = createFingerprintJournal(join(root, "journal.json"), binding), mappings = createMappingStore(join(root, "mappings.json"));
      if (["collision", "missing", "other-member"].includes(mode)) {
        await journal.reserve(data.context, createHash("sha256").update(Buffer.from(data.envelope.signature, "base64")).digest("hex"), { capacity: 200, occupiedSlots: [], mappedSlots: [] });
        if (mode === "missing") await journal.advance(data.context.transferId, "reserved", "stored");
        if (mode === "other-member") await mappings.assignIfUnmapped(0, "other-member");
      }
      let accesses = 0;
      const receiver = createFingerprintReceiver({
        identities: { withApprovedPeer: async (_id, _pairing, operation) => {
          if (mode === "unapproved") throw new Error("Peer not approved");
          return operation({ identity: data.recipient, binding, peer: { kioskId: data.context.senderId, pairingId: data.context.senderPairingId, fingerprint: data.context.senderKeyId, publicIdentity: data.source } });
        } }, journal, mappings,
        sensor: { occupiedSlots: async () => { accesses += 1; return mode === "missing" ? [] : [0]; } },
        templates: { exportTemplate: async () => new Uint8Array(r503TemplateBytes), importTemplate: async () => assert.fail("Refused delivery must not write a template") },
        isMemberActive: async () => mode !== "inactive", withSensor: async (operation) => operation(), now: () => data.now,
      });
      const envelope = mode === "tampered" ? { ...data.envelope, tag: Buffer.alloc(16).toString("base64") } : data.envelope;
      await assert.rejects(receiver.receive(envelope), /authenticated|not active|not approved|local slot review/);
      if (["tampered", "inactive", "unapproved"].includes(mode)) { assert.equal(accesses, 0); assert.equal((await journal.list()).length, 0); }
      else assert.equal((await journal.list())[0].phase, "needs_review");
      if (mode === "other-member") assert.equal(await mappings.memberForSlot(0), "other-member");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("pairing code is hashed, single-use, and expires", () => {
  const issued = issuePairingCode({ now: () => 0, random: () => Buffer.from("123456") });
  assert.equal("code" in issued, true);
  assert.notEqual(issued.codeHash, issued.code);
  const redeemed = redeemPairingCode(issued, issued.code, new Date(1));
  assert.equal(redeemed.ok, true);
  assert.equal(redeemPairingCode(redeemed.record, issued.code, new Date(2)).ok, false);
  assert.equal(redeemPairingCode(issued, issued.code, new Date(999999999)).ok, false);
});

test("offline queue preserves order and retries without losing an event", async () => {
  const queue = createOfflineQueue();
  assert.equal(queue.enqueue({ id: "first" }), true);
  assert.equal(queue.enqueue({ id: "second" }), true);
  assert.equal(queue.enqueue({ id: "first" }), false);
  let calls = 0;
  assert.deepEqual(await queue.flush(async () => { calls += 1; if (calls === 2) throw new Error("offline"); }), ["first"]);
  assert.deepEqual(queue.pending().map((item) => item.id), ["second"]);
});

test("sensor adapter exposes slot matches, never a template", async () => {
  const adapter = createSensorAdapter({ status: async () => ({ connected: true, templateCount: 3 }), match: async () => ({ slot: 12, template: "must-not-leak" }) });
  assert.deepEqual(await adapter.test(), { readerOnline: true, templateCount: 3 });
  assert.deepEqual(await adapter.match(), { matched: true, slot: 12 });
});

test("guided installer previews safely and installs fixed, digest-verified releases without Git", async () => {
  const installer = (await readFile("apps/kiosk/scripts/install-lancerlogin.sh", "utf8")).replaceAll("\r\n", "\n");
  assert.match(installer, /--dry-run/);
  assert.match(installer, /--install/);
  assert.match(installer, /--no-fingerprint-reader/);
  // The archive is trusted only through the immutable release's GitHub asset digest, never a same-release .sha256 file.
  assert.match(installer, /sha256sum --check --strict/);
  assert.match(installer, /release\.immutable !== true/);
  assert.match(installer, /LANCERLOGIN_ARCHIVE_SHA256_ARM64/);
  assert.doesNotMatch(installer, /\$archive\.sha256" --output|RELEASE_ROOT\/\$archive\.sha256/);
  for (const download of installer.match(/^\s*curl --fail --location.*$/gm) ?? []) assert.match(download, /--connect-timeout \d+ --max-time \d+/);
  assert.match(installer, /releases\/download\/v\$\{VERSION\}/);
  assert.match(installer, /Environment=LANCERLOGIN_VERSION=%s/);
  assert.match(installer, /Environment=LANCERLOGIN_SENSOR_PATH=%s/);
  assert.match(installer, /SENSOR_PATH.*disabled/s);
  assert.match(installer, /SENSOR_OPTION.*--no-fingerprint-reader/s);
  assert.match(installer, /Port 8788 is already used by another service/);
  assert.match(installer, /HEALTH_URL=http:\/\/127\.0\.0\.1:8788\/health/);
  assert.match(installer, /curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "\$HEALTH_URL"/);
  assert.match(installer, /systemctl restart lancerlogin-kiosk\.service/);
  assert.match(installer, /49-lancerlogin-network\.rules/);
  assert.match(installer, /49-lancerlogin-recovery\.rules/);
  assert.match(installer, /lancerlogin-update\.service/);
  assert.match(installer, /lancerlogin-install-release/);
  assert.match(installer, /same network.*one-time pairing key/);
  assert.match(installer, /lancerlogin-open-kiosk/);
  assert.match(installer, /LancerLogin Kiosk\.desktop/);
  assert.match(installer, /application_file="\/usr\/local\/share\/applications\/lancerlogin-kiosk\.desktop"/);
  assert.match(installer, /'Type=Link'.*"URL=\$application_file"/);
  assert.match(installer, /chown root:root "\$application_file"/);
  assert.match(installer, /chmod 0644 "\$desktop_file"/);
  assert.doesNotMatch(installer, /quick_exec|metadata::trusted/);
  assert.match(installer, /SUDO_USER/);
  assert.doesNotMatch(installer, /Worker API URL from the GitHub workflow summary/);
  assert.match(installer, /node_major.*-ge 18/s);
  assert.match(installer, /normalize_tree_permissions\(\)/);
  assert.match(installer, /find "\$tree" -xdev -type d -exec chmod 0755/);
  assert.match(installer, /find "\$tree" -xdev -type f -exec chmod 0644/);
  assert.ok(installer.indexOf('chmod 0755 "$staging"\n  normalize_tree_permissions "$staging"') > 0);
  // Versioned releases: staged and checked while the old release runs, then switched with an atomic rename.
  assert.ok(installer.indexOf("\nstage_release ") > 0 && installer.indexOf("\nstage_release ") < installer.indexOf("\nsystemctl stop lancerlogin-kiosk.service"));
  assert.ok(installer.indexOf("\nsystemctl stop lancerlogin-kiosk.service") < installer.indexOf('\npoint_link current "releases/$new_release"'));
  assert.match(installer, /mv -T -f -- "\$temporary_link" "\$RUNTIME_ROOT\/\$name"/);
  assert.ok(installer.indexOf("wait_until_healthy || exit 1") < installer.indexOf("\nphase=done"));
  const updater = await readFile("apps/kiosk/scripts/lancerlogin-install-release.sh", "utf8");
  assert.match(updater, /\/usr\/bin\/bash "\$temporary\/install-lancerlogin\.sh" --install/);
  assert.doesNotMatch(installer, /sudo -u/);
  assert.doesNotMatch(installer, /git clone/i);
});

test("systemd configures an enabled R503 and permits non-fingerprint startup", async () => {
  const unit = await readFile("apps/kiosk/systemd/lancerlogin-kiosk.service", "utf8");
  assert.match(unit, /SupplementaryGroups=dialout/);
  assert.match(unit, /LANCERLOGIN_SENSOR_PATH.*!= disabled.*-e.*LANCERLOGIN_SENSOR_PATH.*\/bin\/stty -F.*LANCERLOGIN_SENSOR_PATH.*57600/);
  assert.ok(unit.indexOf("ExecStartPre=") < unit.indexOf("ExecStart=/usr/bin/node"));
  // An offline boot must not wait for network-online.target before serving the local screen.
  assert.doesNotMatch(unit.replace(/^#.*$/gm, ""), /network-online\.target/);
  assert.match(unit, /^After=network\.target$/m);
});

test("kiosk update unit permits only a digest-verified official target and no arbitrary arguments", async () => {
  const [helper, unit, policy] = await Promise.all([
    readFile("apps/kiosk/scripts/lancerlogin-install-release.sh", "utf8"),
    readFile("apps/kiosk/systemd/lancerlogin-update.service", "utf8"),
    readFile("apps/kiosk/polkit/49-lancerlogin-update.rules", "utf8"),
  ]);
  assert.match(helper, /\/usr\/bin\/node \/opt\/lancerlogin\/src\/resolve-kiosk-release\.mjs/);
  assert.match(helper, /accepts no arguments/);
  // The installer is checked against the resolver's GitHub asset digest, not a downloaded .sha256 file.
  assert.doesNotMatch(helper, /install-lancerlogin\.sh\.sha256" --output|\$release_root\/install-lancerlogin\.sh\.sha256/);
  assert.match(helper, /printf '%s  %s\\n' "\$installer_sha256" install-lancerlogin\.sh/);
  assert.match(helper, /sha256sum --check --strict --quiet install-lancerlogin\.sh\.sha256/);
  assert.match(helper, /--connect-timeout 15 --max-time 120/);
  assert.match(helper, /^\{ main "\$@"; exit \$\?; \}$/m);
  assert.doesNotMatch(helper, /\$1|VERSION:-|GITHUB_API=.*\$/);
  assert.match(unit, /ExecStart=\/usr\/local\/sbin\/lancerlogin-install-release/);
  assert.match(unit, /^TimeoutStartSec=20min$/m);
  assert.match(unit, /^StateDirectory=lancerlogin-update$/m);
  assert.match(policy, /subject\.user === "lancerlogin"/);
  assert.match(policy, /action\.lookup\("unit"\) === "lancerlogin-update\.service" && action\.lookup\("verb"\) === "start"/);
  assert.equal(policy.match(/polkit\.Result\.YES/g)?.length, 1);
});

test("kiosk update handoff reports a failed verified systemd unit without changing its fixed target", async () => {
  const child = new EventEmitter(); child.unref = () => undefined;
  let invocation; let failure;
  startVerifiedKioskUpdate({
    spawnImpl: (...args) => { invocation = args; return child; },
    onFailure: (message) => { failure = message; },
  });
  assert.deepEqual(invocation, ["/usr/bin/systemctl", ["start", "lancerlogin-update.service"], { stdio: "ignore" }]);
  child.emit("exit", 1);
  await Promise.resolve();
  assert.equal(failure, "The verified kiosk update service failed with status 1");
});

test("one-time pairing key carries self-hosted routing without central discovery", () => {
  const value = { apiUrl: "https://example-api.example.workers.dev", code: "ABC123", kioskName: "Main kiosk" };
  const key = `LL1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  assert.deepEqual(decodePairingKey(key), value);
  assert.throws(() => decodePairingKey("ABC123"), /valid LancerLogin/);
});

test("network settings PIN is salted locally and rate limits repeated failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-network-pin-")); const path = join(directory, "pin.json"); let time = 1_000;
  try { const store = createNetworkPinStore(path, { now: () => time }); await store.set("123456"); const saved = await readFile(path, "utf8"); assert.doesNotMatch(saved, /123456/); store.close(); for (let attempt = 0; attempt < 5; attempt += 1) await store.verify("654321"); const locked = await store.verify("123456"); assert.equal(locked.authorized, false); assert.ok(locked.lockedUntil); time += 31_000; assert.equal((await store.verify("123456")).authorized, true); } finally { await rm(directory, { recursive: true }); }
});

test("dashboard recovery can clear the local settings PIN without retaining a credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-network-reset-")); const path = join(directory, "pin.json");
  try { const store = createNetworkPinStore(path); await store.set("123456"); assert.equal((await store.status()).configured, true); await store.reset(); assert.deepEqual(await store.status(), { configured: false, authorized: false, lockedUntil: null }); }
  finally { await rm(directory, { recursive: true }); }
});

test("NetworkManager adapter lists Wi-Fi without retaining passwords", async () => {
  const calls = [];
  const manager = createNetworkManager({ run: async (args) => {
    calls.push(args);
    if (args.includes("status")) return "wlan0:wifi:connected:Studio WiFi\neth0:ethernet:disconnected:\n";
    if (args.includes("IN-USE,SIGNAL")) return "*:82\n";
    // A requested scan can return before new access points reach the cache.
    if (args.includes("list")) return args[args.indexOf("--rescan") + 1] === "yes"
      ? "*:Studio WiFi:82:WPA2\n:Guest:55:--\n"
      : "*:Studio WiFi:82:WPA2\n";
    return "";
  } });
  assert.deepEqual((await manager.status()).connection, "Studio WiFi");
  const networks = await manager.wifi();
  assert.deepEqual(networks.map((item) => ({ ssid: item.ssid, secured: item.secured })), [{ ssid: "Studio WiFi", secured: true }, { ssid: "Guest", secured: false }]);
  assert.deepEqual(calls.at(-1), ["-t", "--escape", "yes", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes", "ifname", "wlan0"]);
  assert.equal(calls.filter((args) => args.includes("rescan")).length, 0);
  assert.deepEqual(await manager.diagnostics(), { type: "wifi", signal: 82 });
  assert.deepEqual(calls.at(-1), ["-t", "-f", "IN-USE,SIGNAL", "device", "wifi", "list", "--rescan", "no"]);
});

test("network policy grants only narrow NetworkManager actions to the kiosk account", async () => {
  const policy = await readFile("apps/kiosk/polkit/49-lancerlogin-network.rules", "utf8");
  const allowed = [...policy.matchAll(/"(org\.freedesktop\.NetworkManager\.[^"]+)"/g)].map(([, action]) => action);
  assert.deepEqual(allowed, [
    "org.freedesktop.NetworkManager.enable-disable-wifi",
    "org.freedesktop.NetworkManager.network-control",
    "org.freedesktop.NetworkManager.settings.modify.system",
    "org.freedesktop.NetworkManager.wifi.scan",
  ]);
  assert.match(policy, /subject\.user === "lancerlogin"/);
  assert.doesNotMatch(policy, /polkit\.Result\.YES[\s\S]*return polkit\.Result\.YES/);
});

test("loopback display state exposes only a safe release version and local Wi-Fi remains PIN-protected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-network-service-"));
  const isolatedPaths = { CONFIG: "pairing.json", MAPPINGS: "slot-mappings.json", BRANDING: "branding.json", AUTHENTICATION: "authentication.json", CREDENTIAL_MAPPINGS: "credential-mappings.json", ROSTER_CACHE: "roster-cache.json", FINGERPRINT_SYNC: "fingerprint-sync", FINGERPRINT_VAULT: "fingerprint-vault", FINGERPRINT_RESET: "fingerprint-reset", FINGERPRINT_REVIEW: "fingerprint-review" };
  const previousPaths = {};
  for (const [key, name] of Object.entries(isolatedPaths)) {
    previousPaths[key] = process.env[`LANCERLOGIN_${key}`];
    process.env[`LANCERLOGIN_${key}`] = join(directory, name);
  }
  const previousPinPath = process.env.LANCERLOGIN_NETWORK_PIN;
  const previousQueuePath = process.env.LANCERLOGIN_QUEUE;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousReleaseVersion = process.env.LANCERLOGIN_VERSION;
  const previousSensorPath = process.env.LANCERLOGIN_SENSOR_PATH;
  process.env.LANCERLOGIN_SENSOR_PATH = "disabled";
  process.env.LANCERLOGIN_NETWORK_PIN = join(directory, "network-pin.json");
  process.env.LANCERLOGIN_QUEUE = join(directory, "attendance-queue.json");
  const seedQueue = createFileQueue(process.env.LANCERLOGIN_QUEUE);
  await seedQueue.enqueue({ eventId: "review-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" });
  await seedQueue.flush(async () => ({ rejected: true, status: 409, code: "no_eligible_meeting" }));
  process.env.NODE_ENV = "test";
  delete process.env.LANCERLOGIN_VERSION;
  let service;
  try {
    service = await import("../apps/kiosk/src/service.mjs");
    service.network.wifi = async () => [{ ssid: "Workshop WiFi", signal: 91, secured: true, active: false }];
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const { port } = service.server.address();
    const request = (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options);

    assert.equal(service.localReleaseVersion("0.17.0"), "0.17.0");
    assert.equal(service.localReleaseVersion("development"), "development");
    assert.equal(service.localReleaseVersion(undefined), "development");
    assert.equal(service.localReleaseVersion("private host detail"), "development");
    const displayState = await (await request("/display-state")).json();
    assert.equal(displayState.releaseVersion, "development");
    assert.equal("credential" in displayState, false);
    assert.equal("sensorPath" in displayState, false);
    const health = await (await request("/health")).json();
    assert.equal("releaseVersion" in health, false);
    assert.deepEqual(health.attendance, { saved: 1, pending: 0, accepted: 0, duplicate: 0, rejected: 1, needsReview: 1, clockPending: 0, historyComplete: true });

    assert.equal((await request("/network/wifi")).status, 403);
    assert.equal((await request("/sensor/slots")).status, 403);
    for (const [path, method] of [["/fingerprint-sync", "GET"], ["/fingerprint-sync", "PATCH"], ["/fingerprint-sync/peers", "POST"], ["/fingerprint-sync/peers/other", "DELETE"]]) {
      assert.equal((await request(path, { method })).status, 403);
    }
    assert.equal((await request("/attendance/rejections")).status, 403);
    assert.equal((await request("/maintenance/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentTime: "2026-10-24T11:00:00.000Z" }) })).status, 403);
    assert.equal((await request("/network/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }) })).status, 201);
    const unavailableSlots = await request("/sensor/slots");
    assert.equal(unavailableSlots.status, 503);
    assert.deepEqual(await unavailableSlots.json(), { error: "Cannot verify occupied sensor slots. Test the reader before enrolling." });
    const unavailableSync = await request("/fingerprint-sync");
    assert.equal(unavailableSync.status, 410);
    assert.match((await unavailableSync.json()).error, /retired/);
    assert.equal((await (await request("/maintenance/session")).json()).authorized, true);
    assert.equal((await request("/maintenance/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentTime: "not-a-date" }) })).status, 400);
    assert.equal((await request("/maintenance/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentTime: "2026-10-24T11:00:00.000Z" }) })).status, 200);
    assert.equal((await (await request("/display-state")).json()).clock.source, "operator");
    assert.equal((await request("/fingerprint-sync", { headers: { origin: "https://untrusted.example.test" } })).status, 403);
    const scan = await request("/network/wifi");
    assert.equal(scan.status, 200);
    assert.deepEqual((await scan.json()).networks, [{ ssid: "Workshop WiFi", signal: 91, secured: true, active: false }]);
    const reviews = await (await request("/attendance/rejections")).json();
    assert.equal(reviews.rejections.length, 1);
    assert.equal(reviews.rejections[0].reasonCode, "no_eligible_meeting");
    assert.equal((await request("/attendance/rejections/review-1/review", { method: "POST" })).status, 200);
    assert.equal((await (await request("/attendance/rejections")).json()).rejections[0].reviewStatus, "reviewed");

    await request("/network/session", { method: "DELETE" });
    for (let attempt = 0; attempt < 5; attempt += 1) await request("/network/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "654321" }) });
    assert.equal((await request("/network/wifi")).status, 403);
    assert.equal((await request("/attendance/rejections")).status, 403);
  } finally {
    if (service?.server.listening) await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
    if (previousPinPath === undefined) delete process.env.LANCERLOGIN_NETWORK_PIN; else process.env.LANCERLOGIN_NETWORK_PIN = previousPinPath;
    if (previousQueuePath === undefined) delete process.env.LANCERLOGIN_QUEUE; else process.env.LANCERLOGIN_QUEUE = previousQueuePath;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousReleaseVersion === undefined) delete process.env.LANCERLOGIN_VERSION; else process.env.LANCERLOGIN_VERSION = previousReleaseVersion;
    if (previousSensorPath === undefined) delete process.env.LANCERLOGIN_SENSOR_PATH; else process.env.LANCERLOGIN_SENSOR_PATH = previousSensorPath;
    for (const [key, value] of Object.entries(previousPaths)) {
      if (value === undefined) delete process.env[`LANCERLOGIN_${key}`]; else process.env[`LANCERLOGIN_${key}`] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("network diagnostics exposes only connection type and active Wi-Fi signal", async () => {
  const manager = createNetworkManager({ run: async (args) => {
    if (args.includes("status")) return "wlan0:wifi:connected:Private WiFi\n";
    if (args.includes("IN-USE,SIGNAL")) return "*:73\n:41\n";
    return "";
  } });
  assert.deepEqual(await manager.diagnostics(), { type: "wifi", signal: 73 });
});

test("pairing client requires HTTPS and does not persist the one-time code", async () => {
  assert.throws(() => normalizeApiUrl("http://example.test"), /HTTPS/);
  let sent;
  const config = await pairInstallation({ apiUrl: "https://api.example.test/", code: "ab-cd", kioskName: "Front desk", fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ kioskId: "kiosk-1", kioskToken: "secret-token", pairingId: "pairing-1", name: "Front desk" }), { status: 201, headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { code: "AB-CD", kioskName: "Front desk" });
  assert.equal(config.apiUrl, "https://api.example.test");
  assert.equal("code" in config, false);
  assert.equal(config.kioskToken, "secret-token");
  assert.equal(config.pairingId, "pairing-1");
});

test("heartbeat authenticates with the kiosk token and reports only operational state", async () => {
  let request;
  await sendHeartbeat({ apiUrl: "https://api.example.test", kioskToken: "secret", kioskId: "kiosk-1" }, { readerOnline: true, authenticationMethod: "nfc", releaseVersion: "1.0.0", uptimeSeconds: 3_600, networkType: "wifi", networkSignal: 82, lastWifiScanAt: "2026-09-02T20:00:00.000Z", credential: "must-not-send", rawScan: "must-not-send", wifiNetworks: ["must-not-send"], fetchImpl: async (_url, init) => { request = init; return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(request.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.body), { readerOnline: true, authenticationMethod: "nfc", releaseVersion: "1.0.0", uptimeSeconds: 3_600, networkType: "wifi", networkSignal: 82, lastWifiScanAt: "2026-09-02T20:00:00.000Z", pendingEvents: 0, lastSyncAt: null, errorCategory: null });
});

test("attendance upload carries the reader's match score only when the scan has one", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); bodies.push(body); return new Response(JSON.stringify({ accepted: true, eventId: body.eventId }), { status: 202, headers: { "content-type": "application/json" } }); };
  const config = { apiUrl: "https://api.example.test", kioskToken: "secret" };
  for (const matchScore of [143, undefined, "143", 1.5]) await sendAttendance(config, { eventId: "event-1", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z", matchScore }, { fetchImpl });
  assert.deepEqual(bodies.map(body => body.matchScore), [143, undefined, undefined, undefined]);
});

test("heartbeat reports the installed update policy and omits unrecognized values", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); };
  const config = { apiUrl: "https://api.example.test", kioskToken: "secret" };
  for (const updatePolicyVersion of [2, 1, 3, "2", undefined]) await sendHeartbeat(config, { readerOnline: true, releaseVersion: "2.0.0-beta.8", updatePolicyVersion, fetchImpl });
  assert.deepEqual(bodies.map((body) => body.updatePolicyVersion), [2, 1, undefined, undefined, undefined]);
  assert.deepEqual(bodies.slice(2).map((body) => "updatePolicyVersion" in body), [false, false, false]);
});

test("kiosk configuration fetch is authenticated and contains no biometric request data", async () => {
  let request;
  const result = await fetchKioskConfiguration({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { fetchImpl: async (url, init) => { request = { url, init }; return new Response(JSON.stringify({ settings: { organizationName: "Example" } }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(request.url, "https://api.example.test/kiosk/config");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(result.settings, { organizationName: "Example" });
});

test("kiosk recovery client polls and completes fixed commands with its device credential", async () => {
  const calls = [];
  const config = { apiUrl: "https://api.example.test", kioskToken: "secret" };
  const pending = await fetchKioskCommand(config, { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ command: { id: "one", type: "reload_display" } }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(pending.command.type, "reload_display");
  await completeKioskCommand(config, "one", { success: true, message: "done" }, { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ completed: true }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.match(calls[1].url, /\/kiosk\/commands\/one\/result$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { success: true, message: "done" });
});

test("file queue survives restart, preserves order, and removes only delivered events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-")); const path = join(directory, "queue.json");
  try {
    const first = createFileQueue(path); await first.enqueue({ eventId: "one", memberId: "m1" }); await first.enqueue({ eventId: "two", memberId: "m2" });
    const restarted = createFileQueue(path); let calls = 0; assert.deepEqual(await restarted.flush(async () => { calls += 1; if (calls === 2) throw new Error("offline"); }), ["one"]);
    assert.deepEqual((await createFileQueue(path).pending()).map((event) => event.eventId), ["two"]);
  } finally { await rm(directory, { recursive: true }); }
});

test("local attendance acknowledges durable offline saves without waiting for cloud delivery", async () => {
  for (const mode of ["offline", "slow", "corrupt"]) {
    const directory = await mkdtemp(join(tmpdir(), "lancerlogin-local-save-"));
    const queuePath = join(directory, "queue.json");
    try {
      const configPath = join(directory, "pairing.json");
      await writeFile(configPath, JSON.stringify({ apiUrl: "https://api.example.test", kioskToken: "synthetic", pairingId: "synthetic-pairing" }));
      if (mode === "corrupt") await writeFile(queuePath, "{broken");
      const program = `
        import assert from 'node:assert/strict';
        import {readFile} from 'node:fs/promises';
        const {createFileQueue}=await import(new URL('./file-queue.mjs',process.argv[1]).href);
        const mode=process.argv[2];const originalFetch=globalThis.fetch;let release;
        const held=new Promise(resolve=>{release=resolve});
        globalThis.fetch=async(url,options)=>{
          if(String(url).startsWith('https://api.example.test/')){
            if(mode==='slow')await held;
            throw new Error('Synthetic cloud unavailable');
          }
          return originalFetch(url,options);
        };
        const {server}=await import(process.argv[1]);
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const base='http://127.0.0.1:'+server.address().port;
        await fetch(base+'/operator-presence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'enter',pageId:'synthetic-offline-page',mode:'attendance'})});
        const event={eventId:'offline-fixed-id',memberId:'synthetic-member',occurredAt:'2026-09-19T12:00:00.000Z'};
        const submit=()=>fetch(base+'/attendance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(2000)});
        try {
          const response=await submit();
          if(mode==='corrupt'){
            assert.equal(response.status,400);
            assert.equal(await readFile(process.env.LANCERLOGIN_QUEUE,'utf8'),'{broken');
          }else{
            assert.equal(response.status,202);
            assert.deepEqual(await response.json(),{accepted:true,queued:1});
            const retry=await submit();assert.equal(retry.status,200);
            assert.deepEqual(await retry.json(),{accepted:false,queued:1});
            const saved=await createFileQueue(process.env.LANCERLOGIN_QUEUE).pending();
            assert.equal(saved.length,1);assert.equal(saved[0].eventId,event.eventId);assert.equal(saved[0].memberId,event.memberId);assert.equal(saved[0].pairingId,'synthetic-pairing');
            assert.equal(saved[0].clock.version,1);assert.equal(saved[0].clock.verified,false);
            assert.ok(Number.isFinite(Date.parse(saved[0].occurredAt)));assert.notEqual(saved[0].occurredAt,event.occurredAt);
          }
        }finally{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, new URL("../apps/kiosk/src/service.mjs", import.meta.url).href, mode], {
        encoding: "utf8", timeout: 10_000,
        env: { ...process.env, NODE_ENV: "test", LANCERLOGIN_SENSOR_PATH: "disabled", LANCERLOGIN_CONFIG: configPath, LANCERLOGIN_QUEUE: queuePath },
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stdout + child.stderr);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("concurrent replay sends each event once and keeps accepting new scans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-concurrent-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    await queue.enqueue({ eventId: "one", memberId: "m1" });
    await queue.enqueue({ eventId: "two", memberId: "m2" });
    let startFirst;
    const firstStarted = new Promise((resolve) => { startFirst = resolve; });
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    const sent = [];
    const first = queue.flush(async (event) => {
      sent.push(event.eventId);
      if (event.eventId === "one") { startFirst(); await firstHeld; }
    });
    await firstStarted;
    const second = queue.flush(async () => assert.fail("A second replay must join the active replay"));
    assert.equal(await queue.enqueue({ eventId: "three", memberId: "m3" }), true);
    releaseFirst();
    assert.deepEqual(await first, ["one", "two", "three"]);
    assert.deepEqual(await second, ["one", "two", "three"]);
    assert.deepEqual(sent, ["one", "two", "three"]);
    assert.deepEqual(await createFileQueue(path).pending(), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("an invalid queue file fails closed instead of discarding pending attendance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-invalid-")); const path = join(directory, "queue.json");
  try {
    await writeFile(path, "{broken");
    await assert.rejects(() => createFileQueue(path).enqueue({ eventId: "new", memberId: "m1" }));
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally { await rm(directory, { recursive: true }); }
});

test("a saved Saturday scan keeps its original time after restart and Wednesday replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-delayed-")); const path = join(directory, "queue.json");
  try {
    const occurredAt = "2026-09-19T12:00:00.000Z";
    await createFileQueue(path).enqueue({ eventId: "saturday-scan", memberId: "synthetic-member", occurredAt });
    const restarted = createFileQueue(path);
    const requests = [];
    const delivered = await restarted.flush(async (event) => {
      const result = await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "synthetic-token" }, event, {
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ accepted: true, eventId: event.eventId }), { status: 202, headers: { "content-type": "application/json" } });
        },
      });
      assert.equal(result.accepted, true);
    });
    assert.deepEqual(delivered, ["saturday-scan"]);
    assert.deepEqual(requests, [{ eventId: "saturday-scan", memberId: "synthetic-member", occurredAt, rescanSupported: true }]);
    assert.deepEqual(await createFileQueue(path).pending(), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("interrupted replay leaves the original event for idempotent recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-interrupted-")); const path = join(directory, "queue.json");
  let child;
  try {
    await createFileQueue(path).enqueue({ eventId: "interrupted-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" });
    const source = "const {createFileQueue}=await import(process.argv[1]);const queue=createFileQueue(process.argv[2]);await queue.flush(async()=>{process.stdout.write('server-accepted\\n');await new Promise(()=>{})});";
    child = spawn(process.execPath, ["--input-type=module", "-e", source, new URL("../apps/kiosk/src/file-queue.mjs", import.meta.url).href, path], { stdio: ["ignore", "pipe", "pipe"] });
    let timeout;
    try { await Promise.race([once(child.stdout, "data"), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Replay child did not reach the send boundary")), 5_000); })]); }
    finally { clearTimeout(timeout); }
    child.kill();
    await once(child, "exit");
    assert.deepEqual((await createFileQueue(path).pending()).map((event) => event.eventId), ["interrupted-1"]);
    const restarted = createFileQueue(path);
    assert.deepEqual(await restarted.flush(async () => ({ duplicate: true })), ["interrupted-1"]);
    assert.deepEqual(await restarted.diagnostics(), { saved: 1, pending: 0, accepted: 0, duplicate: 1, rejected: 0, needsReview: 0, clockPending: 0, historyComplete: true });
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(directory, { recursive: true });
  }
});

test("rejected scans and safe reasons survive replay without blocking later valid scans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-rejected-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    await queue.enqueue({ eventId: "rejected-1", memberId: "synthetic-a", occurredAt: "2026-09-19T12:00:00.000Z" });
    await queue.enqueue({ eventId: "accepted-2", memberId: "synthetic-b", occurredAt: "2026-09-19T12:01:00.000Z" });
    await queue.enqueue({ eventId: "duplicate-3", memberId: "synthetic-c", occurredAt: "2026-09-19T12:02:00.000Z" });
    const sent = [];
    await queue.flush(async (event) => {
      sent.push(event.eventId);
      if (event.eventId === "rejected-1") return { rejected: true, status: 409, code: "no_eligible_meeting", error: "Do not store this raw message" };
      if (event.eventId === "duplicate-3") return { duplicate: true };
      return { accepted: true };
    });
    assert.deepEqual(sent, ["rejected-1", "accepted-2", "duplicate-3"]);
    const restarted = createFileQueue(path);
    assert.deepEqual(await restarted.diagnostics(), { saved: 3, pending: 0, accepted: 1, duplicate: 1, rejected: 1, needsReview: 1, clockPending: 0, historyComplete: true });
    assert.deepEqual(await restarted.rejections(), [{ eventId: "rejected-1", memberId: "synthetic-a", occurredAt: "2026-09-19T12:00:00.000Z", httpStatus: 409, reasonCode: "no_eligible_meeting", reviewStatus: "open" }]);
    assert.deepEqual(await createFileQueue(path).pending(), []);
    assert.equal(await restarted.markReviewed("missing-event"), false);
    assert.equal(await restarted.markReviewed("rejected-1"), true);
    assert.equal((await createFileQueue(path).rejections())[0].reviewStatus, "reviewed");
    assert.deepEqual(await restarted.diagnostics(), { saved: 3, pending: 0, accepted: 1, duplicate: 1, rejected: 1, needsReview: 0, clockPending: 0, historyComplete: true });
    await restarted.compact();
    for (const file of await readdir(directory)) assert.equal((await readFile(join(directory, file), "utf8")).includes("Do not store this raw message"), false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("the release 1.0.6 array queue upgrades without losing its pending scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-legacy-")); const path = join(directory, "queue.json");
  try {
    await writeFile(path, JSON.stringify([{ eventId: "legacy-1", memberId: "synthetic-a", occurredAt: "2026-09-19T12:00:00.000Z" }]));
    const queue = createFileQueue(path);
    assert.deepEqual(await queue.diagnostics(), { saved: 1, pending: 1, accepted: 0, duplicate: 0, rejected: 0, needsReview: 0, clockPending: 0, historyComplete: false });
    await queue.flush(async () => ({ rejected: true, status: 404, code: "roster_inactive" }));
    const restarted = createFileQueue(path);
    assert.deepEqual(await restarted.diagnostics(), { saved: 1, pending: 0, accepted: 0, duplicate: 0, rejected: 1, needsReview: 1, clockPending: 0, historyComplete: false });
    assert.equal((await restarted.rejections())[0].eventId, "legacy-1");
    assert.deepEqual(await createFileQueue(path).pending(), []);
    await restarted.compact();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("recovery finishes a saved rejection after interruption between outcome and queue writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-recover-outcome-")); const path = join(directory, "queue.json");
  try {
    const event = { eventId: "saved-rejection-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" };
    await writeFile(path, `${JSON.stringify([event])}\n`);
    await writeFile(`${path}.outcomes.json`, `${JSON.stringify({ version: 1, accepted: 0, duplicate: 0,
      rejected: [{ ...event, httpStatus: 409, reasonCode: "no_eligible_meeting", reviewStatus: "open" }],
      pendingAck: { eventId: event.eventId }, historyComplete: false })}\n`);
    const queue = createFileQueue(path);
    assert.deepEqual(await queue.pending(), []);
    assert.deepEqual(await queue.flush(async () => assert.fail("A terminal rejection must not be sent again")), []);
    assert.deepEqual(await createFileQueue(path).diagnostics(), { saved: 1, pending: 0, accepted: 0, duplicate: 0, rejected: 1, needsReview: 1, clockPending: 0, historyComplete: false });
  } finally { await rm(directory, { recursive: true }); }
});

test("slot mappings remain local and reject malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-mapping-")); const path = join(directory, "mappings.json");
  try { const store = createMappingStore(path); const saved = await store.replace({ "12": { memberId: "member-1", finger: "right index" } }); assert.deepEqual(saved["12"], { memberId: "member-1", finger: "right index" }); assert.equal(await createMappingStore(path).memberForSlot(12), "member-1"); await assert.rejects(() => store.replace({ invalid: "member-2" }), /Invalid/); } finally { await rm(directory, { recursive: true }); }
});

test("authentication method normalization keeps fingerprint as the upgrade default", () => {
  assert.equal(normalizeIdentityMethod(undefined), "fingerprint");
  assert.equal(normalizeIdentityMethod("unsupported"), "fingerprint");
  assert.deepEqual(identityReadyState("member_id"), { message: "Enter member ID", detail: "Use the touch keyboard below" });
  assert.deepEqual(identityUnknownState("qr"), { message: "Credential not recognized", detail: "This qr code is not registered" });
});

test("bounded identity input uses one normalized observation contract", async () => {
  const input = createIdentityInput();
  assert.equal(input.submit({ status: "unknown", message: "Credential not recognized" }), true);
  assert.equal(input.submit({ status: "identified", memberId: "Member.Case", identityKey: "rfid:one" }), true);
  assert.deepEqual(await input.next(), { status: "unknown", message: "Credential not recognized" });
  assert.deepEqual(await input.next(), { status: "identified", memberId: "Member.Case", identityKey: "rfid:one" });
  assert.deepEqual(await input.next(), { status: "idle" });
  assert.throws(() => input.submit({ status: "not_found" }), /Invalid identity observation/);
  for (let index = 0; index < 4; index += 1) assert.equal(input.submit({ status: "unknown" }), true);
  assert.equal(input.submit({ status: "unknown" }), false);
});

test("RFID, NFC, and QR mappings retain only keyed digests in owner-local storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-credentials-")); const path = join(directory, "credential-mappings.json");
  try {
    const store = createCredentialStore(path, { secretBytes: () => Buffer.alloc(32, 7), id: (() => { let value = 0; return () => `mapping-${++value}`; })(), now: () => "2026-09-29T12:00:00.000Z" });
    const credentialValues = [];
    for (const method of ["rfid", "nfc", "qr"]) {
      const credential = crypto.randomUUID();
      credentialValues.push(credential);
      const saved = await store.add({ method, credential, memberId: `member-${method}`, label: `${method} label` });
      assert.deepEqual(saved, { id: `mapping-${["rfid", "nfc", "qr"].indexOf(method) + 1}`, method, memberId: `member-${method}`, label: `${method} label`, createdAt: "2026-09-29T12:00:00.000Z" });
      assert.equal((await store.resolve(method, credential))?.memberId, `member-${method}`);
      assert.equal(await store.resolve(method, `${credential}-unknown`), undefined);
    }
    const persisted = await readFile(path, "utf8");
    for (const credential of credentialValues) assert.equal(persisted.includes(credential), false);
    assert.equal((await store.list()).some((mapping) => "digest" in mapping || "secret" in mapping), false);
    const replacementCredential = credentialValues[0];
    await assert.rejects(() => store.add({ method: "rfid", credential: replacementCredential, memberId: "replacement" }), /confirm replacement/i);
    const replaced = await store.add({ method: "rfid", credential: replacementCredential, memberId: "replacement", replaceExisting: true });
    assert.equal(replaced.memberId, "replacement");
    assert.equal((await store.list()).length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("member ID and mapped credentials resolve only against the active local roster cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-identity-resolution-"));
  try {
    const rosterCache = createRosterCache(join(directory, "roster.json"));
    const credentials = createCredentialStore(join(directory, "credentials.json"), { secretBytes: () => Buffer.alloc(32, 9), id: () => "badge-one" });
    const credential = crypto.randomUUID();
    await rosterCache.replace([{ memberId: "Case-Sensitive.id", firstName: "A", lastName: "Member" }]);
    await credentials.add({ method: "rfid", credential, memberId: "Case-Sensitive.id" });
    assert.deepEqual(await resolveIdentityObservation({ method: "member_id", input: { memberId: "Case-Sensitive.id" }, credentials, rosterCache }), { status: "identified", memberId: "Case-Sensitive.id", identityKey: "member:Case-Sensitive.id" });
    assert.equal((await resolveIdentityObservation({ method: "member_id", input: { memberId: "case-sensitive.id" }, credentials, rosterCache })).status, "unknown");
    assert.deepEqual(await resolveIdentityObservation({ method: "rfid", input: { credential }, credentials, rosterCache }), { status: "identified", memberId: "Case-Sensitive.id", identityKey: "rfid:badge-one" });
    await rosterCache.replace([]);
    assert.equal((await resolveIdentityObservation({ method: "rfid", input: { credential }, credentials, rosterCache })).status, "unknown");
    assert.equal((await resolveIdentityObservation({ method: "rfid", input: { credential: crypto.randomUUID() }, credentials, rosterCache })).status, "unknown");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the shared identity scanner preserves queue privacy, debounce, offline replay, and pairing capture", async () => {
  for (const method of ["fingerprint", "rfid", "nfc", "member_id", "qr"]) {
    const events = []; const displays = []; let time = Date.parse("2026-09-29T12:00:00.000Z"); let pairingId = "pairing-one";
    const observation = { status: "identified", memberId: `member-${method}`, identityKey: `${method}:private-local-key` };
    const scanner = createIdentityScanner({
      captureIdentity: async () => observation,
      queue: { pending: async () => [...events], enqueue: async (event) => { events.push(event); return true; } },
      loadPairing: async () => ({ pairingId }), flushAttendance: async () => { throw new Error("offline"); },
      onDisplay: async (state, values) => displays.push({ state, ...values }), onInput: () => undefined, onCloud: () => undefined,
      now: () => time, delay: async () => undefined, eventId: () => `${method}-${events.length + 1}`,
    });
    await scanner.tick();
    time += 100; await scanner.tick();
    pairingId = "pairing-two"; time += 8_001; await scanner.tick();
    assert.equal(events.length, 2);
    assert.equal(events[0].pairingId, "pairing-one");
    assert.equal(events[1].pairingId, "pairing-two");
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ["eventId", "memberId", "occurredAt", "pairingId"]);
      assert.equal(JSON.stringify(event).includes("private-local-key"), false);
    }
    assert.equal(displays.some((entry) => entry.state === "welcome" && /Saved for sync/.test(entry.detail)), true);
  }
});

test("unknown normalized identities fail closed with method-specific feedback", async () => {
  const displays = []; let enqueued = false;
  const scanner = createIdentityScanner({
    captureIdentity: async () => ({ status: "unknown", ...identityUnknownState("nfc") }),
    queue: { pending: async () => [], enqueue: async () => { enqueued = true; return true; } }, loadPairing: async () => ({ pairingId: "one" }),
    flushAttendance: async () => assert.fail("Unknown identity must not reach the Worker"), onDisplay: async (state, values) => displays.push({ state, ...values }), onInput: () => undefined, onCloud: () => undefined,
    now: () => Date.parse("2026-09-29T12:00:00.000Z"), delay: async () => undefined,
  });
  await scanner.tick();
  assert.equal(enqueued, false);
  assert.deepEqual(displays, [{ state: "unknown", message: "Credential not recognized", detail: "This nfc badge is not registered" }]);
});

test("legacy fingerprint import prepares roster and slot mappings without templates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-legacy-import-"));
  try {
    const rosterPath = join(directory, "old-roster.csv");
    const mappingsPath = join(directory, "old-mappings.json");
    const outDir = join(directory, "out");
    await writeFile(rosterPath, "student id,first,last,email\n321,Ada,Lovelace,ada@example.test\n322,Grace,Hopper,\n", "utf8");
    await writeFile(mappingsPath, JSON.stringify([{ slot: 12, memberId: "321", finger: "right index", template: "must-not-copy" }, { slot: 13, memberId: "missing", finger: "left thumb" }]), "utf8");
    const result = await prepareLegacyFingerprintImport({ rosterPath, mappingsPath, outDir });
    assert.equal(result.rosterCount, 2);
    assert.equal(result.mappingCount, 2);
    assert.deepEqual(result.unmapped, [{ slot: "13", memberId: "missing" }]);
    assert.match(await readFile(result.rosterOut, "utf8"), /memberId,firstName,lastName,email,discordUserId\n321,Ada,Lovelace,ada@example.test,/);
    assert.deepEqual(JSON.parse(await readFile(result.mappingsOut, "utf8")), { "12": { memberId: "321", finger: "right index" }, "13": { memberId: "missing", finger: "left thumb" } });
    assert.doesNotMatch(await readFile(result.mappingsOut, "utf8"), /must-not-copy/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("attendance client sends only identifiers and operational timestamps", async () => {
  let sent;
  await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { eventId: "event-1", memberId: "member-1", meetingId: "meeting-1", occurredAt: "2026-09-01T20:00:00Z", fingerprint: "must-not-send" }, { fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ accepted: true, eventId: "event-1" }), { headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { eventId: "event-1", memberId: "member-1", meetingId: "meeting-1", occurredAt: "2026-09-01T20:00:00Z", rescanSupported: true });
});

test("attendance client lets the Worker resolve a meeting and treats a rejected scan as delivered", async () => {
  let sent;
  const result = await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { eventId: "event-2", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z" }, { fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ error: "No meeting is accepting attendance scans at this time" }), { status: 409, headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { eventId: "event-2", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z", rescanSupported: true });
  assert.deepEqual(result, { accepted: false, rejected: true, status: 409, code: "no_eligible_meeting", error: "No meeting is accepting attendance scans at this time" });
});

test("a possible wrong match asks for a rescan and a late queued one is delivered without a review record", async () => {
  const reply = () => new Response(JSON.stringify({ error: "Scan again", code: "possible_wrong_match" }), { status: 409, headers: { "content-type": "application/json" } });
  const config = { apiUrl: "https://api.example.test", kioskToken: "secret" };
  const result = await sendAttendance(config, { eventId: "event-3", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z" }, { fetchImpl: async () => reply() });
  assert.deepEqual(result, { accepted: false, duplicate: false, rescan: true, status: 409, code: "possible_wrong_match", error: "Scan again", eventId: "event-3" });
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-wrong-match-"));
  try {
    const queue = createFileQueue(join(directory, "queue.json"));
    await queue.enqueue({ eventId: "queued-1", memberId: "member-1", occurredAt: "2026-09-01T19:00:00Z" });
    assert.deepEqual(await queue.flush(event => sendAttendance(config, event, { fetchImpl: async () => reply() })), ["queued-1"]);
    const diagnostics = await queue.diagnostics();
    assert.deepEqual([diagnostics.pending, diagnostics.rejected, diagnostics.needsReview], [0, 0, 0]);
    assert.deepEqual(await queue.rejections(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the scan surface shows Scan again for a possible wrong match and a weak-reading note only on accepted weak scans", async () => {
  for (const [reply, score, expected] of [
    [{ rescan: true, code: "possible_wrong_match" }, 40, { state: "rescan", notice: undefined }],
    [{ accepted: true, action: "check_in", member: { displayName: "Test Student A" } }, 79, { state: "welcome", notice: "Your fingerprint is reading weakly. Ask a mentor to re-enroll it." }],
    [{ accepted: true, action: "check_out", member: { displayName: "Test Student A" } }, 80, { state: "goodbye", notice: undefined }],
    [{ duplicate: true, action: "check_in", member: { displayName: "Test Student A" } }, 10, { state: "duplicate", notice: undefined }],
  ]) {
    const displays = [], events = [];
    const scanner = createIdentityScanner({
      captureIdentity: async () => ({ status: "identified", memberId: "synthetic-member", identityKey: "fingerprint:1", matchScore: score }),
      queue: { pending: async () => [...events], enqueue: async event => { events.push(event); return true; } },
      loadPairing: async () => ({ pairingId: "synthetic-pairing" }), flushAttendance: async () => ({ acknowledgements: [{ eventId: events.at(-1).eventId, ...reply }] }),
      onDisplay: async (state, values) => displays.push({ state, ...values }), onCloud: () => undefined, delay: async () => undefined,
      weakReading: value => value < 80,
    });
    await scanner.tick();
    const last = displays.at(-1);
    assert.deepEqual({ state: last.state, notice: last.notice }, expected);
  }
  assert.equal(deviceStates.rescan.tone, "notice", "a rescan prompt is not an error state");
  assert.ok(deviceStates.rescan.led);
});

test("attendance transport preserves the pairing captured with a queued scan", async () => {
  let sent;
  const event = { eventId: "bound-1", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z", pairingId: "pairing-1" };
  const result = await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret", pairingId: "pairing-2" }, event, { fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ accepted: true, eventId: "bound-1" }), { status: 202, headers: { "content-type": "application/json" } }); } });
  assert.equal(result.accepted, true);
  assert.equal(sent.pairingId, "pairing-1");
  const rejected = await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret", pairingId: "pairing-2" }, event, { fetchImpl: async () => new Response(JSON.stringify({ error: "This queued scan belongs to a different kiosk pairing and was not attached to the current kiosk" }), { status: 409, headers: { "content-type": "application/json" } }) });
  assert.deepEqual(rejected, { accepted: false, rejected: true, status: 409, code: "pairing_mismatch", error: "This queued scan belongs to a different kiosk pairing and was not attached to the current kiosk" });
});

test("temporary HTTP client failures stay pending for replay", async () => {
  const event = { eventId: "retry-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" };
  for (const status of [401, 403, 408, 425, 429]) {
    await assert.rejects(() => sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, event, {
      fetchImpl: async () => new Response(JSON.stringify({ error: "Try again" }), { status, headers: { "content-type": "application/json" } }),
    }), /Try again/);
  }
});

test("unknown 4xx responses keep scans queued; only explicit API rejection reasons are permanent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-unknown-4xx-")); const path = join(directory, "queue.json");
  const config = { apiUrl: "https://api.example.test", kioskToken: "secret" };
  const event = { eventId: "deploy-window-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" };
  const reply = (status, body, type = "application/json") => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
  try {
    // A misrouted deploy, proxy or path change must not turn every scan into a review item.
    for (const [status, body, type] of [[404, { error: "Not found" }], [405, { error: "Method not allowed" }], [410, { error: "Gone" }], [413, { error: "Too large" }], [404, "<html>Not found</html>", "text/html"], [409, { error: "Unexpected conflict" }], [400, { error: "Bad request" }], [404, { error: "Not found", code: "made_up_reason" }]]) {
      await assert.rejects(sendAttendance(config, event, { fetchImpl: reply(status, body, type) }), error => error.transient === true && error.status === status);
    }
    const queue = createFileQueue(path); await queue.enqueue(event);
    assert.deepEqual(await queue.flush(item => sendAttendance(config, item, { fetchImpl: reply(404, { error: "Not found" }) })), []);
    assert.deepEqual((await createFileQueue(path).pending()).map(item => item.eventId), ["deploy-window-1"]);
    assert.equal((await createFileQueue(path).rejections()).length, 0);
    // Explicit codes from the API are permanent, whatever the message says.
    for (const [status, code] of [[404, "roster_inactive"], [409, "no_eligible_meeting"], [409, "attendance_complete"], [409, "participation_not_started"], [409, "pairing_mismatch"], [409, "scan_window_closed"], [400, "invalid_scan"]]) {
      const result = await sendAttendance(config, event, { fetchImpl: reply(status, { error: "Reworded message", code }) });
      assert.deepEqual([result.rejected, result.code, result.status], [true, code, status]);
    }
    // Older APIs without codes are recognized only by their exact semantic messages.
    for (const [status, message, code] of [[404, "This identity is not linked to an active roster member", "roster_inactive"], [409, "Attendance is closed for this meeting", "scan_window_closed"], [400, "eventId, memberId, and a valid occurredAt timestamp are required", "invalid_scan"]]) {
      assert.equal((await sendAttendance(config, event, { fetchImpl: reply(status, { error: message }) })).code, code);
    }
  } finally { await rm(directory, { recursive: true }); }
});

test("delivery backoff grows on unexpected HTTP rejections, ignores connectivity loss and resets on success", () => {
  let clock = 0; const backoff = createDeliveryBackoff({ now: () => clock, baseMs: 1000, maxMs: 8000 });
  backoff.failed(new Error("offline")); assert.equal(backoff.blocked(), false);
  const delays = [];
  for (let index = 0; index < 6; index++) { backoff.failed(Object.assign(new Error("404"), { transient: true })); delays.push(backoff.retryAt() - clock); }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(backoff.blocked(), true); clock += 8000; assert.equal(backoff.blocked(), false);
  backoff.succeeded(); backoff.failed(Object.assign(new Error("404"), { transient: true })); assert.equal(backoff.retryAt() - clock, 1000);
});

test("an ambiguous success response cannot remove a queued scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-ambiguous-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    const event = { eventId: "ambiguous-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" };
    await queue.enqueue(event);
    const delivered = await queue.flush((item) => sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, item, {
      fetchImpl: async () => new Response(JSON.stringify({ accepted: true, eventId: "different-event" }), { status: 202, headers: { "content-type": "application/json" } }),
    }));
    assert.deepEqual(delivered, []);
    assert.deepEqual((await createFileQueue(path).pending()).map((item) => item.eventId), ["ambiguous-1"]);
  } finally { await rm(directory, { recursive: true }); }
});

function acknowledgement(confirmation, parameters = []) {
  const length = parameters.length + 3; const content = [0x07, length >> 8, length & 0xff, confirmation, ...parameters]; const checksum = content.reduce((sum, value) => (sum + value) & 0xffff, 0);
  return Uint8Array.from([0xef, 0x01, 0xff, 0xff, 0xff, 0xff, ...content, checksum >> 8, checksum & 0xff]);
}

test("R503 packets are checksummed and expose only slot matches", async () => {
  assert.deepEqual([...commandPacket(0x1d)], [0xef, 0x01, 0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x03, 0x1d, 0x00, 0x21]);
  assert.deepEqual(parseAcknowledgement(acknowledgement(0, [0, 3])).parameters, Uint8Array.from([0, 3]));
  const replies = [acknowledgement(0), acknowledgement(0, [0, 3]), acknowledgement(0), acknowledgement(0), acknowledgement(0, [0, 12, 0, 80])];
  const sensor = createR503(async () => replies.shift());
  assert.deepEqual(await sensor.status(), { connected: true, templateCount: 3 });
  const match = await sensor.match();
  assert.deepEqual(match, { slot: 12, score: 80 });
  assert.equal(JSON.stringify(match).includes("template"), false);
});

test("R503 no-finger response is a normal unmatched scan", async () => {
  const sensor = createR503(async () => acknowledgement(0x02));
  assert.equal(await sensor.match(), undefined);
});

test("R503 semantic display states control only the reader aura LED", async () => {
  let packet;
  const sensor = createR503(async (value) => { packet = value; return acknowledgement(0); });
  await sensor.led({ color: 2, mode: 1, speed: 128, cycles: 0 });
  assert.equal(packet[9], 0x35);
  assert.deepEqual([...packet.slice(10, 14)], [1, 128, 2, 0]);
});

test("R503 erases exactly one requested template slot and reports reader failures", async () => {
  let packet;
  const sensor = createR503(async (value) => { packet = value; return acknowledgement(0); });
  await sensor.deleteTemplate(130);
  assert.equal(packet[9], 0x0c);
  assert.deepEqual([...packet.slice(10, 14)], [0, 130, 0, 1], "page 130, one template");
  for (const slot of [-1, 200, 1.5]) await assert.rejects(sensor.deleteTemplate(slot), /slot must be between/);
  await assert.rejects(createR503(async () => acknowledgement(0x10)).deleteTemplate(3));
});

test("continuous scanner records a mapped match without a meeting ID", async () => {
  const displays = []; const queued = []; const led = [];
  const scanner = createScanner({
    scanSensor: async () => ({ status: "match", slot: 12, score: 80 }), setLed: async (state) => led.push(state), mappings: { memberForSlot: async () => "ROSTER-001" },
    queue: { pending: async () => [...queued], enqueue: async (event) => { queued.push(event); return true; } }, loadPairing: async () => ({ kioskToken: "secret", pairingId: "pairing-1" }),
    flushAttendance: async () => ({ acknowledgements: [{ eventId: "scan-1", action: "check_in", member: { displayName: "Avery Stone" }, meeting: { title: "Build" } }] }),
    onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined, onCloud: () => undefined,
    now: () => Date.parse("2026-09-01T20:00:00.000Z"), delay: async () => undefined, eventId: () => "scan-1",
  });
  await scanner.tick();
  assert.deepEqual(queued, [{ eventId: "scan-1", memberId: "ROSTER-001", occurredAt: "2026-09-01T20:00:00.000Z", pairingId: "pairing-1" }]);
  assert.deepEqual(displays.map((item) => item.state), ["processing", "welcome"]);
  assert.equal(displays.at(-1).name, "Avery Stone");
  assert.deepEqual(led, ["processing", "welcome"]);
});

test("a second member can scan while the first network replay is still waiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-rapid-scans-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    const sent = []; const displays = [];
    let activeFlush; let sequence = 0;
    const scanner = createScanner({
      scanSensor: async () => ({ status: "match", slot: ++sequence === 1 ? 12 : 14 }),
      setLed: async () => undefined, mappings: { memberForSlot: async (slot) => slot === 12 ? "member-a" : "member-b" }, queue,
      loadPairing: async () => ({ kioskToken: "synthetic" }),
      flushAttendance: () => {
        if (!activeFlush) activeFlush = (async () => {
          const acknowledgements = [];
          const delivered = await queue.flush(async (event) => {
            sent.push(event.eventId);
            if (event.eventId === "rapid-1") await firstHeld;
            const result = { accepted: true, member: { displayName: event.memberId } };
            acknowledgements.push({ eventId: event.eventId, ...result });
            return result;
          });
          return { delivered, acknowledgements };
        })();
        return activeFlush;
      },
      onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined, onCloud: () => undefined,
      now: () => Date.parse("2026-09-19T12:00:00.000Z") + sequence * 1000,
      delay: async () => undefined, eventId: () => `rapid-${sequence}`, flushWaitMs: 5,
    });
    await scanner.tick();
    await scanner.tick();
    assert.deepEqual((await queue.pending()).map((event) => event.memberId), ["member-a", "member-b"]);
    assert.deepEqual(displays.map((entry) => entry.state), ["processing", "welcome", "processing", "welcome"]);
    assert.equal(displays.some((entry) => entry.name), false);
    releaseFirst();
    await activeFlush;
    assert.deepEqual(sent, ["rapid-1", "rapid-2"]);
    assert.deepEqual(await queue.pending(), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("scan feedback preserves semantic states, copy, durations, and reader aura behavior", () => {
  assert.deepEqual(
    Object.fromEntries(["processing", "duplicate", "offline", "unknown", "rejected"].map((id) => [id, presentationStates[id]])),
    {
      processing: { message: "Checking scan", detail: "Hold still", tone: "processing" },
      duplicate: { message: "Already recorded", detail: "Attendance was not changed", tone: "notice", durationMs: 2200 },
      offline: { message: "Saved for sync", detail: "This scan is stored on the kiosk and will sync automatically", tone: "offline", durationMs: 2600 },
      unknown: { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help", tone: "error", durationMs: 2600 },
      rejected: { message: "Scan needs help", detail: "Ask an operator for help", tone: "error", durationMs: 2800 },
    },
  );
  assert.deepEqual(deviceStates.processing.led, { color: 3, mode: 3, speed: 64, cycles: 0 });
  assert.deepEqual(deviceStates.duplicate.led, { color: 3, mode: 2, speed: 56, cycles: 2 });
  assert.deepEqual(deviceStates.offline.led, { color: 1, mode: 2, speed: 64, cycles: 1 });
});

test("scanner keeps offline saved, rejected, and unknown outcomes textually distinct", async () => {
  async function displaysFor(scanSensor, flushAttendance) {
    const displays = [];
    const scanner = createScanner({
      scanSensor, setLed: async () => undefined, mappings: { memberForSlot: async () => "ROSTER-001" },
      queue: { pending: async () => [], enqueue: async () => true }, loadPairing: async () => ({ kioskToken: "secret" }), flushAttendance,
      onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined, onCloud: () => undefined,
      now: () => Date.parse("2026-09-01T20:00:00.000Z"), delay: async () => undefined, eventId: () => "scan-1",
    });
    await scanner.tick();
    return displays;
  }

  assert.deepEqual(await displaysFor(async () => ({ status: "match", slot: 12 }), async () => { throw new Error("offline"); }), [{ state: "processing" }, { state: "welcome", detail: "Saved for sync | Welcome" }]);
  const rejected = await displaysFor(async () => ({ status: "match", slot: 12 }), async () => ({ acknowledgements: [{ eventId: "scan-1", rejected: true, error: "No eligible meeting" }] }));
  assert.deepEqual(rejected, [{ state: "processing" }, { state: "rejected", detail: "No eligible meeting" }]);
  assert.deepEqual(await displaysFor(async () => ({ status: "not_found" }), async () => ({ acknowledgements: [] })), [{ state: "unknown" }]);
});

let syntheticRuntimeId = 0;
function queuedScanner(queue, flushAttendance = async () => { throw new Error("offline"); }) {
  const runtimeId = ++syntheticRuntimeId;
  let time = Date.parse("2026-09-01T20:00:00.000Z"); let sequence = 0; let observation;
  const displays = []; const leds = []; const clouds = [];
  const scanner = createScanner({
    queue, flushAttendance, scanSensor: async () => observation,
    mappings: { memberForSlot: async (slot) => ({ 12: "m1", 13: "m1", 14: "m2" })[slot] },
    setLed: async (id) => leds.push(id), loadPairing: async () => ({ kioskId: "synthetic-kiosk" }),
    onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined,
    onCloud: (online) => clouds.push(online), now: () => time, delay: async () => undefined,
    eventId: () => `synthetic-${runtimeId}-${time}-${++sequence}`,
  });
  return { displays, leds, clouds, async scan(slot, elapsed = 8_001) {
    time += elapsed; observation = typeof slot === "number" ? { status: "match", slot } : { status: slot };
    await scanner.tick(); return displays.at(-1);
  } };
}

test("offline direction is independent per member and shared by mapped fingers; held and unknown scans do not advance it", async () => {
  const events = [];
  const queue = { pending: async () => [...events], enqueue: async (event) => { events.push(event); return true; } };
  const runtime = queuedScanner(queue);
  assert.deepEqual(await runtime.scan(12), { state: "welcome", detail: "Saved for sync | Welcome" });
  const displayCount = runtime.displays.length;
  await runtime.scan(12, 100);
  assert.equal(runtime.displays.length, displayCount);
  assert.equal(events.length, 1);
  assert.equal((await runtime.scan("not_found")).state, "unknown");
  assert.equal((await runtime.scan(99)).state, "unknown");
  assert.equal((await runtime.scan("no_finger")).state, "unknown");
  assert.deepEqual(await runtime.scan(14), { state: "welcome", detail: "Saved for sync | Welcome" });
  assert.deepEqual(await runtime.scan(13), { state: "goodbye", detail: "Saved for sync | Goodbye" });
  assert.deepEqual(await runtime.scan(12), { state: "welcome", detail: "Saved for sync | Welcome" });
  assert.deepEqual(await runtime.scan(14), { state: "goodbye", detail: "Saved for sync | Goodbye" });
  assert.deepEqual(runtime.leds.filter((id) => id === "welcome" || id === "goodbye"), ["welcome", "welcome", "goodbye", "welcome", "goodbye"]);
  assert.deepEqual(runtime.clouds, [false, false, false, false, false]);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["eventId", "memberId", "occurredAt"]);
});

test("offline estimates survive restart using durable events and conservatively recalculate after partial/background replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-offline-direction-")); const path = join(directory, "queue.json");
  try {
    const first = queuedScanner(createFileQueue(path));
    await first.scan(12); await first.scan(14);
    const queue = createFileQueue(path); const restarted = queuedScanner(queue);
    assert.deepEqual(await restarted.scan(13), { state: "goodbye", detail: "Saved for sync | Goodbye" });
    const beforeReplay = await queue.pending(); const sent = [];
    await queue.flush(async (event) => { if (sent.length === 1) throw new Error("offline"); sent.push(event.eventId); });
    assert.deepEqual(sent, [beforeReplay[0].eventId]);
    assert.deepEqual(await restarted.scan(12), { state: "goodbye", detail: "Saved for sync | Goodbye" });
    await queue.flush(async (event) => sent.push(event.eventId));
    assert.equal(new Set(sent).size, sent.length);
    assert.deepEqual(await createFileQueue(path).pending(), []);
    assert.deepEqual(await restarted.scan(13), { state: "welcome", detail: "Saved for sync | Welcome" });
    const persisted = await createFileQueue(path).pending();
    assert.equal(persisted.length, 1);
    assert.deepEqual(Object.keys(persisted[0]).sort(), ["eventId", "memberId", "occurredAt"]);
  } finally { await rm(directory, { recursive: true }); }
});

test("Worker acknowledgements override estimates; confirmed, duplicate and rejected events reset pending history", async () => {
  for (const result of [{ action: "check_out" }, { action: "check_in" }, { duplicate: true }, { rejected: true, error: "No eligible meeting" }]) {
    const events = []; let connected = true;
    const queue = { pending: async () => [...events], enqueue: async (event) => { events.push(event); return true; } };
    const runtime = queuedScanner(queue, async () => {
      if (!connected) throw new Error("offline");
      return { acknowledgements: events.splice(0).map((event) => ({ eventId: event.eventId, ...result, member: { displayName: "Synthetic Member" }, meeting: { title: "Synthetic Meeting" } })) };
    });
    const display = await runtime.scan(12);
    assert.equal(display.state, result.rejected ? "rejected" : result.duplicate ? "duplicate" : result.action === "check_out" ? "goodbye" : "welcome");
    assert.equal(display.detail?.includes("Saved for sync") ?? false, false);
    assert.deepEqual(await queue.pending(), []);
    assert.deepEqual(runtime.clouds, [true]);
    connected = false;
    assert.deepEqual(await runtime.scan(13), { state: "welcome", detail: "Saved for sync | Welcome" });
  }
});

test("failed local save, queue read and duplicate enqueue never claim saved feedback or contact cloud", async () => {
  for (const queue of [
    { pending: async () => [], enqueue: async () => { throw new Error("disk full"); } },
    { pending: async () => { throw new Error("queue unreadable"); }, enqueue: async () => true },
    { pending: async () => [], enqueue: async () => false },
  ]) {
    const runtime = queuedScanner(queue, async () => assert.fail("An unsaved scan must not flush attendance"));
    assert.deepEqual(await runtime.scan(12), { state: "rejected", detail: "This scan could not be saved. Ask an operator for help." });
    assert.deepEqual(runtime.clouds, []);
    assert.deepEqual(runtime.leds, ["processing", "rejected"]);
  }
});

test("R503 enrollment creates and stores a template without returning biometric data", async () => {
  const replies = [acknowledgement(0, Array(32).fill(0)), acknowledgement(0), acknowledgement(0), acknowledgement(0x02), acknowledgement(0), acknowledgement(0), acknowledgement(0), acknowledgement(0)];
  const instructions = [];
  const progress = [];
  const sensor = createR503(async (packet) => { instructions.push(packet[9]); return replies.shift(); });
  const enrolled = await sensor.enroll(12, { attempts: 2, delayMs: 0, onProgress: async (state) => progress.push(state) });
  assert.deepEqual(enrolled, { slot: 12 });
  assert.deepEqual(instructions, [0x1f, 0x01, 0x02, 0x01, 0x01, 0x02, 0x05, 0x06]);
  assert.deepEqual(progress, ["enroll_wait_first", "enroll_scan_accepted", "enroll_wait_second", "enroll_success"]);
  assert.equal(JSON.stringify(enrolled).includes("template"), false);
});

test("R503 remote enrollment cannot create or store a template after authority is revoked", async () => {
  const replies = [acknowledgement(0, Array(32).fill(0)), acknowledgement(0), acknowledgement(0), acknowledgement(2), acknowledgement(0), acknowledgement(0)];
  const instructions = [];
  const sensor = createR503(async packet => { instructions.push(packet[9]); return replies.shift(); });
  await assert.rejects(sensor.enroll(3, { delayMs: 0, attempts: 2, beforeStore: async () => { throw new Error("Session cancelled"); } }), /Session cancelled/);
  assert.deepEqual(instructions, [0x1f, 0x01, 0x02, 0x01, 0x01, 0x02]);
  assert.equal(instructions.includes(0x05), false); assert.equal(instructions.includes(0x06), false);
});

test("R503 slot index reads bitmap pages without downloading fingerprint templates", async () => {
  const commands = [];
  const sensor = createR503(async (packet) => {
    commands.push([packet[9], packet[10]]);
    const index = Array(32).fill(0);
    index[0] = 1; index[31] = 128;
    return acknowledgement(0, index);
  }, { capacity: 512 });
  assert.deepEqual(await sensor.occupiedSlots(), [0, 255, 256, 511]);
  assert.deepEqual(commands, [[0x1f, 0], [0x1f, 1]]);
});

test("R503 refuses an occupied sensor slot even without a local mapping", async () => {
  const commands = [];
  const index = Array(32).fill(0); index[1] = 16;
  const sensor = createR503(async (packet) => { commands.push(packet[9]); return acknowledgement(0, index); });
  await assert.rejects(() => sensor.enroll(12), /already contains a fingerprint/);
  assert.deepEqual(commands, [0x1f]);
});

test("R503 enrollment fails closed when slot availability is unreadable", async () => {
  for (const reply of [acknowledgement(0, [0]), acknowledgement(1)]) {
    const commands = [];
    const sensor = createR503(async (packet) => { commands.push(packet[9]); return reply; });
    await assert.rejects(() => sensor.enroll(12, { replaceExisting: true }));
    assert.deepEqual(commands, [0x1f]);
  }
});

test("R503 permits explicitly confirmed replacement after checking the occupied slot", async () => {
  const index = Array(32).fill(0); index[1] = 16;
  const replies = [acknowledgement(0,index), acknowledgement(0), acknowledgement(0), acknowledgement(2), acknowledgement(0), acknowledgement(0), acknowledgement(0), acknowledgement(0)];
  const sensor = createR503(async () => replies.shift());
  assert.deepEqual(await sensor.enroll(12,{replaceExisting:true,attempts:2,delayMs:0}),{slot:12});
  assert.equal(replies.length,0);
});

test("R503 enrollment errors are plain language for touch users", async () => {
  const sensor = createR503(async () => acknowledgement(0x0a));
  await assert.rejects(() => sensor.enroll(12, { attempts: 1, delayMs: 0 }), (error) => {
    assert.match(error.message, /finger may already be stored|same finger/i);
    assert.doesNotMatch(error.message, /0x0a|R503/);
    return true;
  });
});

test("local kiosk UI is touch-sized, accessible, and self-contained", () => {
  assert.match(kioskHtml, /<main id="kiosk"/);
  assert.match(kioskHtml, /aria-live="polite"/);
  assert.match(kioskHtml, /Starting attendance/);
  assert.equal(presentationStates.ready.message, "Place finger on reader");
  assert.doesNotMatch(kioskHtml, /maintenance-status|>FP</);
  assert.match(kioskHtml, /One-time pairing key/);
  assert.doesNotMatch(kioskHtml, /Roster member ID|Meeting ID|Enroll fingerprint/);
  assert.match(kioskStyles, /max-height:520px/);
  assert.match(kioskIdentityStyles, /\[hidden\]\{display:none!important\}/);
  assert.match(kioskIdentityStyles, /member-id-keyboard button\{min-height:44px/);
  assert.match(kioskStyles, /adaptive-logo/);
  assert.match(kioskStyles, /\.kiosk-brand\.holding/);
  assert.match(kioskApp, /\/display-state/);
  assert.match(kioskApp, /\/pair/);
  assert.match(kioskApp, /adaptLogo/);
  assert.match(kioskApp, /brand-logo-frame/);
  assert.match(kioskHtml, /\/network\.js/);
  assert.match(kioskHtml, /id="uptime"/);
  assert.match(kioskApp, /uptimeSeconds/);
  assert.match(kioskApp, /networkType === "ethernet"/);
  assert.match(kioskStatusStyles, /network-status\.ethernet/);
  assert.match(kioskStyles, /processing-sweep 900ms ease-out 1/);
  assert.match(kioskStyles, /duplicate-flash 420ms ease-in-out 3/);
  assert.match(kioskStyles, /kiosk-shell-offline[^}]*success-pulse/);
  assert.match(kioskStyles, /network-status\.offline[^}]*network-offline-pulse/);
  assert.match(kioskStyles, /prefers-reduced-motion:reduce/);
  assert.match(kioskStyles, /kiosk-shell-processing\{box-shadow:[^}]*processing-sweep-color/);
  assert.match(kioskStyles, /network-status\.offline\{opacity:1;transform:none\}/);
  assert.match(kioskHtml, /\/recovery\.js/);
  assert.match(networkApp, /installHoldGesture\(trigger,openNetwork\)/);
  assert.match(networkApp, /touch-keyboard/);
  assert.match(networkApp, /network-create-keypad/);
  assert.match(networkApp, /appendPinDigit/);
  assert.match(networkStyles, /pin-keypad/);
  assert.match(kioskApp, /\/maintenance/);
  assert.match(maintenanceHtml, /Authentication maintenance/);
  assert.match(maintenanceHtml, /pin-keypad/);
  assert.match(maintenanceHtml, /member-picker/);
  assert.match(maintenanceHtml, /slot-keypad/);
  // Rejected scans upload in the background and are reviewed from the dashboard's Debug tools, not on the kiosk.
  assert.doesNotMatch(maintenanceHtml + maintenanceApp, /attendance-review|Review scans|Review rejected scans/);
  assert.match(maintenanceStyles, /100vh/);
  assert.match(maintenanceStyles, /\[hidden\]\{display:none!important\}/);
  assert.match(maintenanceStyles, /option-list/);
  assert.match(maintenanceStyles, /stage-enroll_wait_first/);
  assert.match(maintenanceLayoutStyles, /calc\(100vw - 16px\)/);
  assert.match(maintenanceApp, /Begin two-scan enrollment|\/enroll/);
  assert.match(maintenanceApp, /startStagePolling/);
  assert.match(maintenanceApp, /friendlyError/);
  assert.match(maintenanceApp, /buildSlotKeypad/);
  assert.match(maintenanceApp, /byId\("credential-value"\)\.value = ""/);
  assert.match(kioskApp, /if \(method !== "member_id"\) input\.value = ""/);
  assert.match(kioskScrollbarStyles, /scrollbar-color:[^;]+;scrollbar-width:thin/);
  assert.match(kioskScrollbarStyles, /::-webkit-scrollbar-thumb/);
  assert.match(maintenanceScrollbarStyles, /scrollbar-color:[^;]+;scrollbar-width:thin/);
  assert.match(maintenanceScrollbarStyles, /::-webkit-scrollbar-thumb/);
  assert.match(recoveryApp, /displayReloadToken/);
  assert.doesNotMatch(kioskHtml, /https?:\/\//);
});

test("every scrollable kiosk surface receives themed scrollbar rules", async () => {
  const service = await readFile("apps/kiosk/src/service.mjs", "utf8");
  assert.match(service, /attendanceReviewStyles \+ maintenanceScrollbarStyles/);
  assert.match(service, /kioskStyles \+ kioskStatusStyles \+ kioskIdentityStyles \+ kioskScrollbarStyles/);
  assert.match(service, /maintenanceStyles \+ maintenanceLayoutStyles \+ maintenanceScrollbarStyles/);
});

test("kiosk footer shows the release version without masking reader failures", () => {
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "0.17.0" }), "LancerLogin 0.17.0");
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "development" }), "LancerLogin development");
  assert.equal(kioskReaderStatus({ readerOnline: true }), "LancerLogin development");
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "  " }), "LancerLogin development");
  assert.equal(kioskReaderStatus({ readerOnline: false, releaseVersion: "0.17.0" }), "Fingerprint reader offline");
  assert.match(kioskApp, /kioskReaderStatus\(value\)/);
  assert.doesNotMatch(kioskApp, /Fingerprint reader online/);
});

test("root helper executes strict release validation before any download", async () => {
  const helper = await readFile("apps/kiosk/scripts/lancerlogin-install-release.sh", "utf8");
  const release = tag => ({ tag_name: tag, draft: false, prerelease: false, immutable: true, assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap(arch => {
    const archive = `lancerlogin-kiosk-${tag.slice(1)}-linux-${arch}.tar.gz`;
    return [archive, `${archive}.sha256`];
  })].map((name, index) => ({ name, digest: `sha256:${index.toString(16).repeat(64)}` })) });
  {
    // Stable releases also need immutability and GitHub asset digests for the installer and both archives.
    const good = release("v1.0.0"); const installed = { installedVersion: "0.1.0", fetcher: async (url) => Response.json(url.includes("/commits/") ? { sha: "b".repeat(40) } : good) };
    assert.deepEqual((await resolveKioskRelease(installed)).digests, { installer: "0".repeat(64), arm64: "2".repeat(64), armv7: "4".repeat(64) });
    for (const payload of [{ ...good, immutable: false }, { ...good, immutable: undefined }, { ...good, assets: good.assets.map((asset, index) => index === 2 ? { name: asset.name } : asset) }, { ...good, assets: good.assets.map((asset, index) => index === 0 ? { ...asset, digest: "sha512:" + "a".repeat(128) } : asset) }, { ...good, assets: [...good.assets, good.assets[0]] }]) {
      await assert.rejects(resolveKioskRelease({ ...installed, fetcher: async (url) => Response.json(url.includes("/commits/") ? { sha: "b".repeat(40) } : payload) }), /newer_official_release_required/);
    }
  }
  const resolve = async (payload) => resolveKioskRelease({ installedVersion: "0.1.0", fetcher: async (url) => Response.json(url.includes("/commits/") ? { sha: "b".repeat(40) } : payload) });
  for (const tag of ["v0.24.0", "v1.0.0", "v12.3.45", "v01.0.0", "v1.00.0", "v1.0.00", "v1.0.0-beta", "v1.0.0+build", "v1.0.0\n", "v1.0.0/evil"]) {
    if (["v0.24.0", "v1.0.0", "v12.3.45"].includes(tag)) assert.equal((await resolve(release(tag))).version, tag.slice(1));
    else await assert.rejects(resolve(release(tag)), /newer_official_release_required/);
  }
  const good = release("v1.0.0");
  for (const payload of [{ ...good, draft: true }, { ...good, prerelease: true }, { ...good, draft: undefined }, { ...good, prerelease: "false" }, { ...good, assets: undefined }, ...good.assets.map(missing => ({ ...good, assets: good.assets.filter(asset => asset !== missing) }))]) await assert.rejects(resolve(payload), /newer_official_release_required/);
  assert.ok(helper.indexOf("/opt/lancerlogin/src/resolve-kiosk-release.mjs") < helper.indexOf('curl --fail'));
});

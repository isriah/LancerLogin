import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseUnlinkedTemplates } from "../apps/kiosk/src/reader-cleanup.mjs";
import { createFingerprintJournal } from "../apps/kiosk/src/fingerprint-journal.mjs";
import { createFingerprintReset } from "../apps/kiosk/src/fingerprint-reset.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { createR503 } from "../apps/kiosk/src/r503.mjs";
import { createSerialExchange } from "../apps/kiosk/src/serial-transport.mjs";
import { createVirtualR503 } from "../scripts/virtual-kiosk/virtual-r503.mjs";

const hex = (character) => character.repeat(64);
const binding = { installationId: hex("a"), kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing" };
const record = (slot, phase, n) => ({ transferId: `synthetic-transfer-${n}`, senderId: "cloud-vault", senderPairingId: hex("a"), senderKeyId: hex("a"), memberId: `synthetic-member-${n}`,
  enrollmentId: `synthetic-enrollment-${n}`, revision: 1, envelopeDigest: hex("b"), slot, phase });

async function fixture(t, { occupied, mapped, ownRecords = [], otherRecords = [], syncRecords = [], mappingsFile = true }) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-reader-cleanup-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultRoot = join(root, "fingerprint-vault"), syncRoot = join(root, "fingerprint-sync");
  const write = async (directory, journalBinding, records) => { await mkdir(directory, { recursive: true, mode: 0o700 }); const path = join(directory, "received.json"); await writeFile(path, JSON.stringify({ version: 1, binding: journalBinding, records }), { mode: 0o600 }); return path; };
  const own = await write(join(vaultRoot, "synthetic-kiosk-synthetic-pairing", hex("a")), binding, ownRecords);
  const other = await write(join(vaultRoot, "synthetic-kiosk-earlier-pairing", hex("a")), { ...binding, pairingId: "earlier-pairing" }, otherRecords);
  await write(syncRoot, { installationId: "synthetic-sync", kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing" }, syncRecords);
  const stored = new Set(occupied), erased = [];
  const sensor = { occupiedSlots: async () => [...stored].sort((a, b) => a - b), deleteTemplate: async slot => { erased.push(slot); stored.delete(slot); } };
  const mappings = { present: async () => mappingsFile, read: async () => mappingsFile ? Object.fromEntries(mapped.map(slot => [String(slot), { memberId: `synthetic-member-${slot}`, finger: "unspecified" }])) : {} };
  const run = (options = {}) => eraseUnlinkedTemplates({ sensor, mappings, journalRoots: [vaultRoot, syncRoot], vaultRoot, binding, ...options });
  return { run, erased, stored, own, other };
}

test("reader cleanup erases only unlinked templates no import owns, and frees their slots for cloud imports", async t => {
  const f = await fixture(t, {
    occupied: [0, 1, 2, 3, 4, 5, 6], mapped: [0, 6],
    // 1: retired cloud copy; 2: import in progress; 6: replaced in place, superseded but linked again.
    ownRecords: [record(1, "superseded", 1), record(2, "reserved", 2), record(6, "superseded", 3), record(6, "complete", 4)],
    // 4: retired under an earlier pairing. 5: a legacy peer copy still owned by its journal.
    otherRecords: [record(4, "superseded", 5)], syncRecords: [record(5, "complete", 6)],
  });
  const result = await f.run();
  assert.deepEqual(f.erased, [1, 3, 4], "slot 3 is a leftover with no journal record at all");
  assert.deepEqual([...f.stored].sort(), [0, 2, 5, 6]);
  assert.deepEqual(result, { erased: 3, stored: 4, linked: 2, forgotten: 1, capacity: 200 });
  const own = JSON.parse(await readFile(f.own, "utf8")).records.map(item => [item.slot, item.phase]);
  assert.deepEqual(own, [[2, "reserved"], [6, "superseded"], [6, "complete"]], "only the superseded record for the erased slot is forgotten");
  assert.equal(JSON.parse(await readFile(f.other, "utf8")).records.length, 1, "journals of other pairings are never rewritten");
  assert.deepEqual(await f.run(), { erased: 0, stored: 4, linked: 2, forgotten: 0, capacity: 200 }, "a second run has nothing left to erase");
});

test("reader cleanup fails closed before erasing anything when local fingerprint state cannot be read", async t => {
  const f = await fixture(t, { occupied: [0, 1], mapped: [0] });
  await writeFile(f.own, "{not json", { mode: 0o600 });
  await assert.rejects(f.run());
  assert.deepEqual(f.erased, []);
});

test("reader cleanup reports a template the reader did not erase", async t => {
  const f = await fixture(t, { occupied: [0, 1], mapped: [0] });
  const sensor = { occupiedSlots: async () => [0, 1], deleteTemplate: async () => undefined };
  await assert.rejects(eraseUnlinkedTemplates({ sensor, mappings: { read: async () => ({ 0: { memberId: "synthetic-member-0", finger: "unspecified" } }) }, journalRoots: [], vaultRoot: "unused", binding }), /still reports an erased fingerprint/);
  assert.deepEqual(f.erased, []);
});

// Item 20: shared templates a fingerprint reset left behind.
test("after a completed reset, cleanup erases the shared templates the reset unlinked and nothing an import still owns", async t => {
  const f = await fixture(t, {
    occupied: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], mapped: [0, 9],
    // Before the reset: 1 and 2 were saved to or received from cloud storage. Since the reset: 0 was shared again and
    // is linked, 3 is being imported, 4 is stored but not linked yet, 5 was linked while its record was not finished,
    // 6 needs review and 7 is being retired.
    ownRecords: [record(0, "complete", 1), record(1, "complete", 2), record(2, "complete", 3), record(3, "reserved", 4), record(4, "stored", 5), record(5, "mapped", 6), record(6, "needs_review", 7), record(7, "retiring", 8)],
    // 8: a copy from the earlier kiosk-to-kiosk sharing under this pairing. 10: completed under an earlier pairing.
    syncRecords: [record(8, "complete", 9)], otherRecords: [record(10, "complete", 10)],
  });
  assert.deepEqual((await f.run()).erased, 0, "without a completed reset every record still holds its slot");
  assert.deepEqual(f.erased, []);
  const result = await f.run({ resetCompleted: true });
  assert.deepEqual(f.erased, [1, 2, 8]);
  assert.deepEqual([...f.stored].sort((a, b) => a - b), [0, 3, 4, 5, 6, 7, 9, 10], "linked templates, unfinished imports and other pairings are untouched");
  assert.deepEqual(result, { erased: 3, stored: 8, linked: 2, forgotten: 2, capacity: 200 });
  // The released records are gone from this pairing's cloud journal, so a member who later enrolls into slot 1 or 2
  // can be unlinked again; every other record is as it was.
  assert.deepEqual(JSON.parse(await readFile(f.own, "utf8")).records.map(item => [item.slot, item.phase]), [[0, "complete"], [3, "reserved"], [4, "stored"], [5, "mapped"], [6, "needs_review"], [7, "retiring"]]);
  assert.deepEqual(await createFingerprintJournal(f.own, binding, { allowSuperseded: true }).suppressSlot(1, "synthetic-member-new"), { suppressed: 0 });
  assert.equal(JSON.parse(await readFile(f.other, "utf8")).records.length, 1, "journals of other pairings are never rewritten");
  assert.deepEqual((await f.run({ resetCompleted: true })).erased, 0, "a second run has nothing left to erase");
});

test("cleanup never erases a linked template, whatever the journals say", async t => {
  // Many combinations of reader, mapping and journal state for six slots, drawn from a fixed sequence.
  let seed = 20261120; const random = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  const phases = ["complete", "superseded", "reserved", "stored", "mapped", "needs_review", "retiring"];
  let erasedInAll = 0;
  for (let round = 0; round < 60; round += 1) {
    const slots = [0, 1, 2, 3, 4, 5];
    const occupied = slots.filter(() => random(4) > 0), mapped = slots.filter(() => random(2) === 0);
    const ownRecords = [];
    for (const slot of slots) { if (random(3) > 0) ownRecords.push(record(slot, phases[random(phases.length)], slot + 1)); }
    const f = await fixture(t, { occupied, mapped, ownRecords });
    await f.run({ resetCompleted: round % 2 === 0 });
    const held = new Set(ownRecords.filter(item => !["complete", "superseded"].includes(item.phase)).map(item => item.slot));
    for (const slot of f.erased) {
      assert.equal(mapped.includes(slot), false, `round ${round}: linked slot ${slot} was erased`);
      assert.equal(held.has(slot), false, `round ${round}: slot ${slot} is held by an unfinished import`);
      assert.equal(occupied.includes(slot), true);
    }
    for (const slot of mapped) if (occupied.includes(slot)) assert.equal(f.stored.has(slot), true, `round ${round}: linked slot ${slot} must stay on the reader`);
    erasedInAll += f.erased.length;
  }
  assert.ok(erasedInAll > 20, "the rounds do erase unlinked templates");
});

test("reset, then Erase unlinked, on the virtual reader: a re-enrolled member keeps scanning and the old templates are gone", async t => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-reset-cleanup-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { kioskId: binding.kioskId, pairingId: binding.pairingId };
  const virtual = createVirtualR503(), reader = createR503(createSerialExchange("virtual-r503", { openHandle: virtual.openHandle, timeoutMs: 200 }));
  const mappings = createMappingStore(join(root, "slot-mappings.json"));
  let tail = Promise.resolve(); const withSensor = operation => { const running = tail.then(operation); tail = running.then(() => undefined, () => undefined); return running; };
  const enroll = (memberId, finger) => enrollFingerprint({ sensor: { ...reader, enroll: (slot, options) => reader.enroll(slot, { ...options, delayMs: 0, onProgress: async step => {
    if (step === "enroll_wait_first" || step === "enroll_wait_second") virtual.present(finger); if (step === "enroll_scan_accepted") virtual.lift(); } }) },
    mappings, withSensor, autoSlot: true, memberId, rosterId: `synthetic-roster-${memberId}`, finger: "unspecified" });
  // Three members enroll; two of the templates are saved to cloud storage, which the journal records as complete.
  for (const member of ["1001", "1002", "1003"]) await enroll(member, `member:${member}:1`);
  virtual.lift();
  const vaultRoot = join(root, "fingerprint-vault"), journalPath = join(vaultRoot, `${config.kioskId}-${config.pairingId}`, hex("a"), "received.json");
  const journal = createFingerprintJournal(journalPath, binding, { allowSuperseded: true });
  for (const [slot, member] of [[0, "1001"], [1, "1002"]]) {
    const context = { installationId: binding.installationId, recipientId: config.kioskId, recipientPairingId: config.pairingId, transferId: `synthetic-transfer-${slot}`, senderId: "cloud-vault", senderPairingId: hex("a"), senderKeyId: hex("a"), memberId: member, enrollmentId: `synthetic-enrollment-${slot}`, revision: 1 };
    let saved = await journal.reserve(context, hex("b"), { capacity: 200, occupiedSlots: [0, 1, 2], mappedSlots: [0, 1, 2], existingSlot: slot, supersedeExisting: true });
    for (const [from, to] of [["reserved", "stored"], ["stored", "mapped"], ["mapped", "complete"]]) saved = await journal.advance(saved.transferId, from, to);
  }
  let commands = [];
  const reset = createFingerprintReset({ directory: join(root, "fingerprint-reset"), config, mappings, withSensor,
    client: { commands: async () => ({ commands }), complete: async () => { commands = []; return { acknowledged: true }; } } });
  const erase = async () => withSensor(async () => eraseUnlinkedTemplates({ sensor: reader, mappings, journalRoots: [vaultRoot], vaultRoot, binding, resetCompleted: await reset.resetCompleted() }));

  assert.equal(await reset.resetCompleted(), false);
  assert.equal((await erase()).erased, 0, "before a reset nothing is unlinked");
  commands = [{ id: "synthetic-reset-1", kind: "reset_fingerprint_mappings" }];
  assert.equal((await reset.tick()).status, "reset");
  assert.deepEqual(await mappings.read(), {});
  assert.equal(await reset.resetCompleted(), true);
  // Member 1003 enrolls again after the reset; the new template takes the next free slot.
  assert.equal((await enroll("1003", "member:1003:2")).slot, 3);
  virtual.lift();

  const result = await erase();
  assert.deepEqual({ erased: result.erased, stored: result.stored, linked: result.linked }, { erased: 3, stored: 1, linked: 1 });
  assert.deepEqual(Object.keys(virtual.status().slots), ["3"], "only the linked template is left on the reader");
  virtual.present("member:1003:2");
  assert.deepEqual(await reader.scan(), { status: "match", slot: 3, score: 180 });
  assert.equal(await mappings.memberForSlot(3), "1003");
  for (const finger of ["member:1001:1", "member:1002:1", "member:1003:1"]) { virtual.present(finger); assert.deepEqual(await reader.scan(), { status: "not_found" }, `${finger} is no longer stored`); }
});

test("with the mappings file missing, a completed reset releases nothing and cleanup erases what it always did", async t => {
  // A missing file reads as no mappings. Every template that was shared stays; only slot 3, which no journal names, goes.
  const state = { occupied: [0, 1, 2, 3], mapped: [0], ownRecords: [record(0, "complete", 1), record(1, "complete", 2)], syncRecords: [record(2, "complete", 3)] };
  const missing = await fixture(t, { ...state, mappingsFile: false });
  const before = await fixture(t, { ...state, mappingsFile: false });
  assert.deepEqual(await missing.run({ resetCompleted: true }), await before.run(), "the same result as without the reset rule");
  assert.deepEqual(missing.erased, [3]);
  assert.deepEqual(missing.erased, before.erased);
  assert.deepEqual(JSON.parse(await readFile(missing.own, "utf8")).records.map(item => item.phase), ["complete", "complete"], "no record is released");
  // The real mapping store: no file is not the same as an empty one.
  const root = await mkdtemp(join(tmpdir(), "kiosk-mapping-present-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMappingStore(join(root, "slot-mappings.json"));
  assert.equal(await store.present(), false); assert.deepEqual(await store.read(), {});
  await store.replace({});
  assert.equal(await store.present(), true);
  await writeFile(join(root, "slot-mappings.json"), "{not json");
  assert.equal(await store.present(), false);
});

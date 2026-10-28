import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseUnlinkedTemplates } from "../apps/kiosk/src/reader-cleanup.mjs";

const hex = (character) => character.repeat(64);
const binding = { installationId: hex("a"), kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing" };
const record = (slot, phase, n) => ({ transferId: `synthetic-transfer-${n}`, senderId: "cloud-vault", senderPairingId: hex("a"), senderKeyId: hex("a"), memberId: `synthetic-member-${n}`,
  enrollmentId: `synthetic-enrollment-${n}`, revision: 1, envelopeDigest: hex("b"), slot, phase });

async function fixture(t, { occupied, mapped, ownRecords = [], otherRecords = [], syncRecords = [] }) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-reader-cleanup-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultRoot = join(root, "fingerprint-vault"), syncRoot = join(root, "fingerprint-sync");
  const write = async (directory, journalBinding, records) => { await mkdir(directory, { recursive: true, mode: 0o700 }); const path = join(directory, "received.json"); await writeFile(path, JSON.stringify({ version: 1, binding: journalBinding, records }), { mode: 0o600 }); return path; };
  const own = await write(join(vaultRoot, "synthetic-kiosk-synthetic-pairing", hex("a")), binding, ownRecords);
  const other = await write(join(vaultRoot, "synthetic-kiosk-earlier-pairing", hex("a")), { ...binding, pairingId: "earlier-pairing" }, otherRecords);
  await write(syncRoot, { installationId: "synthetic-sync", kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing" }, syncRecords);
  const stored = new Set(occupied), erased = [];
  const sensor = { occupiedSlots: async () => [...stored].sort((a, b) => a - b), deleteTemplate: async slot => { erased.push(slot); stored.delete(slot); } };
  const mappings = { read: async () => Object.fromEntries(mapped.map(slot => [String(slot), { memberId: `synthetic-member-${slot}`, finger: "unspecified" }])) };
  const run = () => eraseUnlinkedTemplates({ sensor, mappings, journalRoots: [vaultRoot, syncRoot], vaultRoot, binding });
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
  assert.deepEqual(result, { erased: 3, stored: 4, linked: 2, forgotten: 1 });
  const own = JSON.parse(await readFile(f.own, "utf8")).records.map(item => [item.slot, item.phase]);
  assert.deepEqual(own, [[2, "reserved"], [6, "superseded"], [6, "complete"]], "only the superseded record for the erased slot is forgotten");
  assert.equal(JSON.parse(await readFile(f.other, "utf8")).records.length, 1, "journals of other pairings are never rewritten");
  assert.deepEqual(await f.run(), { erased: 0, stored: 4, linked: 2, forgotten: 0 }, "a second run has nothing left to erase");
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

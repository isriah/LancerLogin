import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFingerprintJournal } from "./fingerprint-journal.mjs";
import { r503FallbackCapacity } from "./r503.mjs";

const journalName = "received.json";

// Every fingerprint journal under the given roots, from any pairing or reset generation: all of them protect their slots.
async function journalPaths(root, depth = 4) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const found = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === journalName) found.push(path);
    else if (entry.isDirectory() && depth > 0) found.push(...await journalPaths(path, depth - 1));
  }
  return found;
}

async function readJournal(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > 1048576) throw new Error("Fingerprint journal requires local review before reader cleanup");
  const state = JSON.parse(await readFile(path, "utf8"));
  if (state?.version !== 1 || !Array.isArray(state.records) || state.records.some(record => !Number.isInteger(record?.slot) || typeof record.phase !== "string")) throw new Error("Fingerprint journal requires local review before reader cleanup");
  return state;
}

/**
 * Erases reader templates that no member is linked to: retired or replaced fingerprints the reader still stores.
 *
 * A slot is erased (DeletChar, one slot at a time) only when all of these hold:
 * 1. the reader reports a template in it;
 * 2. no slot mapping names it, so no member can be identified by it. Nothing below can override this;
 * 3. no journal record still owns it. A record owns its slot unless it is superseded, or it was released by a reset.
 *
 * Released by a reset: a fingerprint reset removes every member link but leaves the journals as they were, so the
 * record of a template this pairing had saved to or received from cloud storage (or the earlier kiosk-to-kiosk
 * sharing) would hold its slot for ever. Once a reset has completed on this pairing (`resetCompleted`: the reset store
 * has a finished reset and none pending) and the mappings file is present, a record no longer owns its slot when it is this pairing's, its phase is
 * "complete" and its slot has no mapping. "complete" is only ever written after the mapping was, so a complete record
 * without a mapping is one whose link was removed. Records of an import that is still under way (reserved, stored,
 * mapped), of one that needs review or is being retired, and every record of another pairing keep their slots.
 *
 * Fails closed on any unreadable state. The caller holds the sensor lock and keeps enrollment, cloud import and reset
 * recovery from running meanwhile.
 */
export async function eraseUnlinkedTemplates({ sensor, mappings, journalRoots, vaultRoot, binding, resetCompleted = false, capacity }) {
  const linked = new Set(Object.keys(await mappings.read()).map(Number));
  const journals = [];
  for (const root of journalRoots) for (const path of await journalPaths(root)) journals.push({ path, state: await readJournal(path) });
  const thisPairing = state => state.binding?.kioskId === binding.kioskId && state.binding?.pairingId === binding.pairingId;
  // A missing mappings file reads as no mappings at all. That is not knowledge that nothing is linked, so the reset
  // rule applies only when the file is there and readable; otherwise this behaves exactly as it did before the rule.
  const releasing = resetCompleted === true && await mappings.present?.() === true;
  const owns = (state, record) => record.phase !== "superseded" && !(releasing && thisPairing(state) && record.phase === "complete" && !linked.has(record.slot));
  const owned = new Set(journals.flatMap(({ state }) => state.records.filter(record => owns(state, record)).map(record => record.slot)));
  const slots = capacity ?? await sensor.capacity?.() ?? r503FallbackCapacity;
  const before = await sensor.occupiedSlots();
  const unlinked = before.filter(slot => !linked.has(slot) && !owned.has(slot));
  for (const slot of unlinked) {
    if (linked.has(slot)) throw new Error("Reader cleanup stopped before erasing a linked fingerprint.");
    await sensor.deleteTemplate(slot);
  }
  const after = await sensor.occupiedSlots();
  if (after.some(slot => unlinked.includes(slot))) throw new Error("The reader still reports an erased fingerprint. Test the reader and try again.");
  // Cloud imports skip every slot a journal record names. Forget superseded records for slots that are now empty, in
  // this pairing's cloud journals only, so new fingerprints can be imported into the freed slots. Records a reset
  // released are marked superseded first, so they are forgotten too and cannot refuse a later unlink of a member who
  // enrolls into the freed slot. Journals of the earlier kiosk-to-kiosk sharing and of other pairings are never rewritten.
  const occupied = new Set(after), empty = Array.from({ length: slots }, (_, slot) => slot).filter(slot => !occupied.has(slot));
  let forgotten = 0;
  for (const { path, state } of journals) {
    const ownJournal = path.startsWith(join(vaultRoot, `${binding.kioskId}-${binding.pairingId}`)) && state.binding?.kioskId === binding.kioskId && state.binding?.pairingId === binding.pairingId;
    if (!ownJournal) continue;
    const released = state.records.filter(record => record.phase !== "superseded" && !owns(state, record)).map(record => record.slot);
    if (!released.length && !state.records.some(record => record.phase === "superseded" && !occupied.has(record.slot))) continue;
    const journal = createFingerprintJournal(path, state.binding, { allowSuperseded: true });
    if (released.length) await journal.releaseAfterReset(released);
    forgotten += (await journal.forgetSuperseded(empty)).forgotten;
  }
  return { erased: unlinked.length, stored: after.length, linked: linked.size, forgotten, capacity: slots };
}

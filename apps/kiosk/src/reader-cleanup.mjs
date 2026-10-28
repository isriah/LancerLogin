import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFingerprintJournal } from "./fingerprint-journal.mjs";

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
 * A slot is erased only when the reader holds a template, no slot mapping names it, and no journal record other than a
 * superseded one owns it (an import that reserved or stored a template keeps it). Fails closed on any unreadable state.
 * The caller holds the sensor lock and keeps enrollment, cloud import and reset recovery from running meanwhile.
 */
export async function eraseUnlinkedTemplates({ sensor, mappings, journalRoots, vaultRoot, binding, capacity = 200 }) {
  const linked = new Set(Object.keys(await mappings.read()).map(Number));
  const journals = [];
  for (const root of journalRoots) for (const path of await journalPaths(root)) journals.push({ path, state: await readJournal(path) });
  const owned = new Set(journals.flatMap(({ state }) => state.records.filter(record => record.phase !== "superseded").map(record => record.slot)));
  const before = await sensor.occupiedSlots();
  const unlinked = before.filter(slot => !linked.has(slot) && !owned.has(slot));
  for (const slot of unlinked) await sensor.deleteTemplate(slot);
  const after = await sensor.occupiedSlots();
  if (after.some(slot => unlinked.includes(slot))) throw new Error("The reader still reports an erased fingerprint. Test the reader and try again.");
  // Cloud imports skip every slot a journal record names. Forget superseded records for slots that are now empty, in
  // this pairing's cloud journals only, so new fingerprints can be imported into the freed slots.
  const occupied = new Set(after), empty = Array.from({ length: capacity }, (_, slot) => slot).filter(slot => !occupied.has(slot));
  let forgotten = 0;
  for (const { path, state } of journals) {
    const ownJournal = path.startsWith(join(vaultRoot, `${binding.kioskId}-${binding.pairingId}`)) && state.binding?.kioskId === binding.kioskId && state.binding?.pairingId === binding.pairingId;
    if (!ownJournal || !state.records.some(record => record.phase === "superseded" && !occupied.has(record.slot))) continue;
    const journal = createFingerprintJournal(path, state.binding, { allowSuperseded: true });
    forgotten += (await journal.forgetSuperseded(empty)).forgotten;
  }
  return { erased: unlinked.length, stored: after.length, linked: linked.size, forgotten };
}

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const id = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const memberId = value => typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const phases = ["reserved", "stored", "mapped", "complete"];
const safeMode = (stat) => process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid());
const fail = () => { throw new Error("Fingerprint delivery journal requires local review"); };
const fields = ["transferId", "senderId", "senderPairingId", "senderKeyId", "memberId", "enrollmentId", "revision", "envelopeDigest"];

// Contains delivery metadata only, never a template or private key. Call reserve
// only after authenticating the envelope, checking current roster membership and
// reading actual sensor occupancy under the shared sensor operation lock.
export function createFingerprintJournal(path, binding, { allowSuperseded = false } = {}) {
  if (![binding?.installationId, binding?.kioskId, binding?.pairingId].every(id)) return fail();
  const bound = { installationId: binding.installationId, kioskId: binding.kioskId, pairingId: binding.pairingId };
  let tail = Promise.resolve();
  const exclusive = (operation) => {
    const result = tail.then(operation, operation); tail = result.then(() => undefined, () => undefined); return result;
  };
  const validRecord = (record) => record && fields.slice(0, 6).every((field) => field === "memberId" ? memberId(record[field]) : id(record[field])) && digest(record.senderKeyId) && digest(record.envelopeDigest)
    && Number.isSafeInteger(record.revision) && record.revision > 0 && Number.isInteger(record.slot) && record.slot >= 0 && record.slot < 1024
    && [...phases, "needs_review", ...(allowSuperseded ? ["superseded"] : [])].includes(record.phase) && Object.keys(record).length === fields.length + 2;
  async function directory() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const stat = await lstat(dirname(path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || !safeMode(stat)) return fail();
  }
  async function load() {
    let file;
    let existed = false;
    try {
      const entry = await lstat(path);
      existed = true;
      if (!entry.isFile() || entry.isSymbolicLink() || !safeMode(entry)) return fail();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || !safeMode(stat) || stat.size > 1048576 || stat.ino !== entry.ino || stat.dev !== entry.dev) return fail();
      const state = JSON.parse(await file.readFile("utf8"));
      if (state?.version !== 1 || !Object.keys(bound).every((key) => state.binding?.[key] === bound[key]) || !Array.isArray(state.records) || state.records.length > 1024 || !state.records.every(validRecord)) return fail();
      const current = state.records.filter(record => record.phase !== "superseded");
      if (new Set(state.records.map((record) => record.transferId)).size !== state.records.length || new Set(current.map((record) => record.slot)).size !== current.length) return fail();
      return state;
    } catch (error) {
      if (!existed && error?.code === "ENOENT") return { version: 1, binding: { ...bound }, records: [] };
      return fail();
    } finally { await file?.close(); }
  }
  async function save(state) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); file = undefined;
      await chmod(temporary, 0o600); await rename(temporary, path);
      if (process.platform !== "win32") {
        const parent = await open(dirname(path), constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await file?.close(); await unlink(temporary).catch(() => undefined); }
  }
  const mutate = (operation) => exclusive(async () => {
    await directory(); let lock;
    try {
      lock = await open(`${path}.lock`, "wx", 0o600);
      const state = await load();
      const result = operation(state);
      await save(state);
      return { ...result };
    } finally { if (lock) { await lock.close(); await unlink(`${path}.lock`); } }
  });
  return {
    list: () => exclusive(async () => { await directory(); return (await load()).records.map((record) => ({ ...record })); }),
    reserve: (context, envelopeDigest, { capacity, occupiedSlots, mappedSlots, existingSlot, supersedeExisting = false }) => mutate((state) => {
      if (context?.installationId !== bound.installationId || context?.recipientId !== bound.kioskId || context?.recipientPairingId !== bound.pairingId || context.senderId === bound.kioskId) return fail();
      const request = Object.fromEntries(fields.map((field) => [field, field === "envelopeDigest" ? envelopeDigest : context[field]]));
      if (!validRecord({ ...request, slot: 0, phase: "reserved" })) return fail();
      const existing = state.records.find((record) => record.transferId === request.transferId);
      if (existing) {
        if (!fields.every((field) => existing[field] === request[field])) return fail();
        if (existing.phase === "superseded") {
          // A source may explicitly re-enroll a previously superseded model in
          // this same slot. Incoming manifests never request this permission.
          if (!allowSuperseded || !supersedeExisting || existingSlot !== existing.slot || !Number.isInteger(capacity) || capacity < 1 || capacity > 1024 || existingSlot >= capacity || !Array.isArray(occupiedSlots) || !occupiedSlots.includes(existingSlot) || !Array.isArray(mappedSlots) || !mappedSlots.includes(existingSlot)) return fail();
          const owners = state.records.filter(record => record.slot === existingSlot && record.phase !== "superseded");
          if (owners.some(record => record.phase !== "complete")) return fail();
          for (const record of owners) record.phase = "superseded";
          existing.phase = "complete";
        }
        return existing;
      }
      const history = state.records.filter((record) => record.senderId === request.senderId && record.enrollmentId === request.enrollmentId);
      if (history.some((record) => record.memberId !== request.memberId || record.revision >= request.revision || record.phase !== "complete")) return fail();
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024 || state.records.length >= 1024) return fail();
      for (const slots of [occupiedSlots, mappedSlots]) if (!Array.isArray(slots) || slots.length > 1024 || !slots.every((slot) => Number.isInteger(slot) && slot >= 0 && slot < capacity)) return fail();
      const unavailable = new Set([...occupiedSlots, ...mappedSlots, ...state.records.map((record) => record.slot)]);
      let slot = 0; while (unavailable.has(slot) && slot < capacity) slot += 1;
      if (existingSlot !== undefined) {
        if (!Number.isInteger(existingSlot) || existingSlot < 0 || existingSlot >= capacity || !occupiedSlots.includes(existingSlot) || !mappedSlots.includes(existingSlot)) return fail();
        const owners = state.records.filter(record => record.slot === existingSlot && record.phase !== "superseded");
        if (owners.length && (!allowSuperseded || !supersedeExisting || owners.some(record => record.phase !== "complete"))) return fail();
        for (const record of owners) record.phase = "superseded";
        slot = existingSlot;
      }
      if (slot >= capacity) throw new Error("Fingerprint reader has no available slot");
      const record = { ...request, slot, phase: "reserved" }; state.records.push(record); return record;
    }),
    advance: (transferId, expectedPhase, nextPhase) => mutate((state) => {
      const record = state.records.find((item) => item.transferId === transferId);
      if (!record || !phases.includes(expectedPhase) || (nextPhase !== "needs_review" && phases.indexOf(nextPhase) !== phases.indexOf(expectedPhase) + 1)) return fail();
      if (record.phase === nextPhase) return record;
      if (record.phase !== expectedPhase) return fail();
      record.phase = nextPhase; return record;
    }),
  };
}

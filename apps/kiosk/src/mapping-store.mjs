import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

function normalize(mappings) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) throw new Error("Invalid slot mappings");
  const clean = {};
  for (const [slot, value] of Object.entries(mappings)) {
    const mapping = typeof value === "string" ? { memberId: value, finger: "unspecified" } : value;
    if (!/^\d{1,4}$/.test(slot) || !mapping || typeof mapping.memberId !== "string" || !mapping.memberId.length || mapping.memberId.length > 100 || typeof mapping.finger !== "string" || mapping.finger.length > 40) throw new Error("Invalid slot mapping");
    clean[slot] = { memberId: mapping.memberId, finger: mapping.finger || "unspecified" };
    if (mapping.rosterId !== undefined) {
      if (typeof mapping.rosterId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(mapping.rosterId)) throw new Error("Invalid immutable roster identity");
      clean[slot].rosterId = mapping.rosterId;
    }
    if (mapping.enrollment !== undefined) {
      const enrollment = mapping.enrollment;
      if (!enrollment || Object.keys(enrollment).length !== 2 || typeof enrollment.id !== "string" || !/^[a-f0-9-]{36}$/.test(enrollment.id) || !Number.isSafeInteger(enrollment.occurredAt) || enrollment.occurredAt < 0) throw new Error("Invalid fingerprint enrollment identity");
      clean[slot].enrollment = { id: enrollment.id, occurredAt: enrollment.occurredAt };
    }
    if (mapping.cloud !== undefined) {
      const cloud = mapping.cloud;
      if (!cloud || Object.keys(cloud).length !== 3 || !/^[a-f0-9]{64}$/.test(cloud.vaultId) || !/^[a-f0-9]{64}$/.test(cloud.fingerprintId)
        || cloud.enrollmentId !== mapping.enrollment?.id) throw new Error("Invalid fingerprint upload receipt");
      clean[slot].cloud = { vaultId: cloud.vaultId, fingerprintId: cloud.fingerprintId, enrollmentId: cloud.enrollmentId };
    }
    if (mapping.review !== undefined) {
      // Preserve retired provenance rather than silently promoting an old
      // reviewed association into a new enrollment. Sharing rejects it.
      const review = mapping.review, hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
      const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
      if (!review || Object.keys(review).length !== 10 || !hex(review.manifestId) || !Number.isSafeInteger(review.revision) || review.revision < 1
        || review.vaultId !== null && !hex(review.vaultId) || !identifier(review.reviewGrantId) || !hex(review.mappingDigest) || !hex(review.slotProof)
        || typeof review.originalMemberId !== "string" || !review.originalMemberId.length || review.originalMemberId.length > 100
        || review.approvedMemberId !== mapping.memberId || review.rosterId !== mapping.rosterId || !Number.isInteger(review.sourceSlot) || review.sourceSlot !== Number(slot)) throw new Error("Invalid fingerprint review provenance");
      clean[slot].review = { manifestId: review.manifestId, revision: review.revision, vaultId: review.vaultId, reviewGrantId: review.reviewGrantId,
        mappingDigest: review.mappingDigest, slotProof: review.slotProof, originalMemberId: review.originalMemberId, approvedMemberId: review.approvedMemberId, rosterId: review.rosterId, sourceSlot: review.sourceSlot };
    }
  }
  return clean;
}

export function createMappingStore(path) {
  let tail = Promise.resolve();
  const exclusive = (operation) => { const result = tail.then(operation, operation); tail = result.then(() => undefined, () => undefined); return result; };
  async function read() {
    try { return normalize(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
  }
  async function persist(mappings) {
    const clean = normalize(mappings);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(clean, null, 2)}\n`); await file.sync(); await file.close(); file = undefined;
      await chmod(temporary, 0o600); await rename(temporary, path);
      if (process.platform !== "win32") {
        const directory = await open(dirname(path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return clean;
    } finally { await file?.close(); await unlink(temporary).catch(() => undefined); }
  }
  return {
    read: () => exclusive(read),
    memberForSlot: (slot) => exclusive(async () => (await read())[String(slot)]?.memberId),
    replace: (mappings) => exclusive(() => persist(mappings)),
    replaceFromMaintenance: (input, { beforeRemove = async () => {} } = {}) => exclusive(async () => {
      const proposed = normalize(input), current = await read(), next = {};
      for (const [slot, previous] of Object.entries(current)) {
        const replacement = proposed[slot];
        if (!replacement || replacement.memberId !== previous.memberId || replacement.finger !== previous.finger) await beforeRemove(Number(slot), previous);
      }
      for (const [slot, mapping] of Object.entries(proposed)) {
        const previous = current[slot];
        // A local mapping editor may preserve an unchanged association, but
        // cannot fabricate immutable enrollment or review provenance. Changed
        // associations remain unverified until explicit new enrollment.
        next[slot] = previous && previous.memberId === mapping.memberId && previous.finger === mapping.finger
          ? previous : { memberId: mapping.memberId, finger: mapping.finger };
      }
      return persist(next);
    }),
    confirmCloudUpload: (slot, expected, cloud) => exclusive(async () => {
      const current = await read(), mapping = current[String(slot)];
      if (!mapping || mapping.memberId !== expected.memberId || mapping.rosterId !== expected.rosterId || mapping.enrollment?.id !== expected.enrollment?.id)
        throw new Error("Fingerprint source changed before upload receipt");
      return persist({ ...current, [String(slot)]: { ...mapping, cloud } });
    }),
    assignIfUnmapped: (slot, memberId, finger = "synced fingerprint", enrollment, rosterId) => exclusive(async () => {
      const addition = normalize({ [String(slot)]: { memberId, finger, ...(enrollment ? { enrollment } : {}), ...(rosterId ? { rosterId } : {}) } });
      const current = await read(); const previous = current[String(slot)];
      if (previous) {
        if (previous.memberId !== memberId || rosterId && previous.rosterId !== rosterId) throw new Error("Sensor slot is already mapped to another member or roster identity");
        return previous;
      }
      return (await persist({ ...current, ...addition }))[String(slot)];
    }),
  };
}

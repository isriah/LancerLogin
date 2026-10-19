import { timingSafeEqual } from "node:crypto";

// Reusable local storage kernel. Callers must authenticate the source and bind
// installation, recipient, member and immutable template identity before calling.
// Only metadata is journaled. All flash and mapping work shares the sensor lock.
export function createFingerprintImporter({ journal, sensor, templates, mappings, isMemberActive, withSensor, capacity = 200, reuseExisting = false }) {
  return {
    async receive(context, template, envelopeDigest) {
      if (!(template instanceof Uint8Array) || template.length !== 1536 || !await isMemberActive(context.memberId, context.rosterId)) throw new Error("Fingerprint member is not active or its template is unavailable");
      return withSensor(async () => {
        const occupiedSlots = await sensor.occupiedSlots(), current = await mappings.read();
        let existingSlot;
        // Vault backfill can encounter a manually enrolled copy. Reuse only a
        // byte-identical occupied slot already bound to this same active member.
        if (reuseExisting && typeof journal.list === "function" && !(await journal.list()).some(record => record.transferId === context.transferId)) {
          for (const [slot, mapping] of Object.entries(current)) {
            if (mapping.memberId !== context.memberId || context.rosterId && mapping.rosterId !== context.rosterId || !occupiedSlots.includes(Number(slot))) continue;
            const stored = await templates.exportTemplate(Number(slot));
            try { if (stored.length === template.length && timingSafeEqual(stored, template)) { existingSlot = Number(slot); break; } }
            finally { stored.fill(0); }
          }
        }
        let record = await journal.reserve(context, envelopeDigest, { capacity, occupiedSlots, mappedSlots: Object.keys(current).map(Number), ...(existingSlot === undefined ? {} : { existingSlot }) });
        const review = async () => {
          if (record.phase !== "needs_review") await journal.advance(record.transferId, record.phase, "needs_review");
          throw new Error("Fingerprint delivery requires local slot review");
        };
        if (record.phase === "superseded") throw new Error("Historical fingerprint delivery is no longer authorized");
        if (record.phase === "needs_review") return review();
        const previousMapping = current[String(record.slot)], previous = previousMapping?.memberId;
        if (previous && (previous !== record.memberId || context.rosterId && previousMapping.rosterId !== context.rosterId)) return review();
        if (record.phase === "complete") {
          if (!previousMapping || previousMapping.memberId !== record.memberId || context.rosterId && previousMapping.rosterId !== context.rosterId || !occupiedSlots.includes(record.slot)) return review();
          return { transferId: record.transferId, slot: record.slot, status: "complete", digest: envelopeDigest };
        }
        if (occupiedSlots.includes(record.slot)) {
          const stored = await templates.exportTemplate(record.slot);
          try { if (stored.length !== template.length || !timingSafeEqual(stored, template)) return await review(); }
          finally { stored.fill(0); }
        } else {
          if (record.phase !== "reserved" || previous) return review();
          const result = await templates.importTemplate(record.slot, template);
          if (result?.slot !== record.slot || result?.verified !== true) throw new Error("Fingerprint reader did not verify storage");
        }
        if (record.phase === "reserved") record = await journal.advance(record.transferId, "reserved", "stored");
        if (!await isMemberActive(record.memberId, context.rosterId)) throw new Error("Fingerprint member is not active");
        const mappedMember = await mappings.memberForSlot(record.slot);
        if (mappedMember && mappedMember !== record.memberId) return review();
        if (record.phase === "stored") {
          await mappings.assignIfUnmapped(record.slot, record.memberId, "synced fingerprint", undefined, context.rosterId);
          record = await journal.advance(record.transferId, "stored", "mapped");
        }
        if (await mappings.memberForSlot(record.slot) !== record.memberId) return review();
        if (record.phase === "mapped") record = await journal.advance(record.transferId, "mapped", "complete");
        return { transferId: record.transferId, slot: record.slot, status: "complete", digest: envelopeDigest };
      });
    },
  };
}

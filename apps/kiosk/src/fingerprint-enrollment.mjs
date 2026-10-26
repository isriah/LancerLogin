import { randomUUID } from "node:crypto";
import { requireRosterIdentity } from "./verified-enrollment.mjs";

// Enrollment, mapping edits and incoming template transfers must share the same
// reader lock. Read the latest mappings inside it, never before waiting for it.
export async function enrollFingerprint({ sensor, mappings, withSensor, slot, autoSlot = false, memberId, rosterId, finger, replaceExisting = false, beforeReplace = async () => {}, onProgress, checkActive = () => {}, beforeStore = async () => {}, isEnrollmentAllowed = async () => true }) {
  return withSensor(async () => {
    if (!await isEnrollmentAllowed()) throw new Error("Finish fingerprint mapping reset recovery before enrolling. Existing reader templates are unchanged.");
    requireRosterIdentity(rosterId);
    const current = await mappings.read();
    if (autoSlot) {
      if (replaceExisting) throw new Error("Dashboard enrollment cannot replace reader slots.");
      const occupied = new Set(await sensor.occupiedSlots());
      slot = Array.from({ length: 200 }, (_, index) => index).find(candidate => !occupied.has(candidate) && !current[String(candidate)]);
      if (slot === undefined) throw new Error("No verified free fingerprint slot is available. Review local mappings and reader slots.");
    }
    if (current[String(slot)] && !replaceExisting) throw new Error(`Sensor slot ${slot} is already mapped; confirm replacement to continue`);
    // Confirmed replacement can change flash even if the reader later reports
    // failure. Remove the old association first so it cannot identify a new
    // template as the previous member after interruption or failed enrollment.
    if (current[String(slot)] && replaceExisting) {
      await beforeReplace(slot, current[String(slot)]);
      delete current[String(slot)];
      await mappings.replace(current);
    }
    checkActive();
    await sensor.enroll(slot, { onProgress, replaceExisting, checkActive, beforeStore });
    checkActive();
    await mappings.assignIfUnmapped(slot, memberId, finger, { id: randomUUID(), occurredAt: Date.now() }, rosterId);
    return { enrolled: true, slot, memberId, finger };
  });
}

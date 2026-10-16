import { randomUUID } from "node:crypto";
import { requireRosterIdentity } from "./verified-enrollment.mjs";

// Enrollment, mapping edits and incoming template transfers must share the same
// reader lock. Read the latest mappings inside it, never before waiting for it.
export async function enrollFingerprint({ sensor, mappings, withSensor, slot, memberId, rosterId, finger, replaceExisting = false, onProgress, isEnrollmentAllowed = async () => true }) {
  return withSensor(async () => {
    if (!await isEnrollmentAllowed()) throw new Error("Finish fingerprint mapping reset recovery before enrolling. Existing reader templates are unchanged.");
    requireRosterIdentity(rosterId);
    const current = await mappings.read();
    if (current[String(slot)] && !replaceExisting) throw new Error(`Sensor slot ${slot} is already mapped; confirm replacement to continue`);
    // Confirmed replacement can change flash even if the reader later reports
    // failure. Remove the old association first so it cannot identify a new
    // template as the previous member after interruption or failed enrollment.
    if (current[String(slot)] && replaceExisting) {
      delete current[String(slot)];
      await mappings.replace(current);
    }
    await sensor.enroll(slot, { onProgress, replaceExisting });
    await mappings.assignIfUnmapped(slot, memberId, finger, { id: randomUUID(), occurredAt: Date.now() }, rosterId);
    return { enrolled: true, slot, memberId, finger };
  });
}

import { randomUUID } from "node:crypto";
import { createDeliveryBackoff } from "./cloud-client.mjs";
import { createFileQueue } from "./file-queue.mjs";

// Fingerprints enrolled on this kiosk's own maintenance screen are reported to the Worker, so they start the member's
// match-score history over and clear a re-enrollment suggestion, as a dashboard enrollment does. Only the member, the
// time and the pairing leave the kiosk, never templates or other biometric data.
//
// Reports wait in their own durable queue: the attendance queue's snapshot and journal format, in separate files next
// to it. The attendance journal therefore keeps only attendance records (older releases read it unchanged), and a
// report the Worker cannot take never holds up attendance delivery. Delivery has its own backoff for the same reason.
//
// - Accepted or duplicate (the Worker already has this event): the report leaves the queue.
// - Refused on its merits (member left the roster, kiosk paired again, malformed): dropped and logged, since resending
//   cannot change the answer.
// - A Worker older than the kiosk (404 or 405 with no reason): parked. The report stays queued and is retried with a
//   long backoff, so it is delivered once the Worker is updated. Logged once per parking.
// - Anything else: retried with the usual capped backoff.
export const missingEndpointBackoff = Object.freeze({ baseMs: 30 * 60_000, maxMs: 6 * 60 * 60_000 });

export function createEnrollmentReports({ path, queue = createFileQueue(path), send, now = Date.now, log = message => console.warn(message),
  backoff = createDeliveryBackoff({ now }), parkedBackoff = createDeliveryBackoff({ now, ...missingEndpointBackoff }) } = {}) {
  let flushing, parked = false;
  async function drain(config) {
    if (backoff.blocked() || parkedBackoff.blocked()) return { delivered: [], deferred: true };
    const dropped = [];
    const delivered = await queue.flush(async report => {
      let result;
      try { result = await send(config, report); }
      catch (error) {
        if (error?.missing) {
          parkedBackoff.failed(error);
          if (!parked) log(`Local enrollment reports are parked: the Worker has no /kiosk/fingerprint-enrollments endpoint (HTTP ${error.status}). They stay queued until it is updated.`);
          parked = true;
        } else backoff.failed(error);
        throw error;
      }
      backoff.succeeded(); parkedBackoff.succeeded(); parked = false;
      if (result?.dropped) {
        dropped.push(report.eventId);
        log(`Dropped local enrollment report ${report.eventId}: the Worker refused it (${result.code}).`);
      }
      // The queue journals only accepted and duplicate results for delivered items. A dropped report needs no review.
      return { duplicate: Boolean(result?.duplicate || result?.dropped) };
    });
    return { delivered: delivered.filter(eventId => !dropped.includes(eventId)), dropped };
  }
  return {
    /** Durably queue the fact that a member's fingerprint was enrolled here. Resolves once it is on disk. */
    async record({ rosterId, pairingId, enrolledAt = new Date(now()).toISOString() }) {
      if (typeof rosterId !== "string" || !rosterId) throw new Error("A roster id is required to report an enrollment");
      const report = { eventId: `local-enrollment-${randomUUID()}`, rosterId, enrolledAt, ...(pairingId ? { pairingId } : {}) };
      await queue.enqueue(report);
      return report;
    },
    flush(config) {
      if (!flushing) flushing = drain(config).finally(() => { flushing = undefined; });
      return flushing;
    },
    pending: () => queue.pending(),
    compact: () => queue.compact(),
  };
}

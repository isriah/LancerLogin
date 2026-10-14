import { createHash } from "node:crypto";
import { fingerprintIdentityId, fingerprintPublicIdentity, openFingerprintTemplate } from "./fingerprint-envelope.mjs";
import { createFingerprintImporter } from "./fingerprint-importer.mjs";

// All sensor operations share the service's lock with scanning and enrollment.
// The relay sees a completion only after the local durable mapping is verified.
export function createFingerprintReceiver({ identities, journal, sensor, templates, mappings, isMemberActive, withSensor, capacity = 200, now = Date.now }) {
  const importer = createFingerprintImporter({ journal, sensor, templates, mappings, isMemberActive, withSensor, capacity, reuseExisting: true });
  let tail = Promise.resolve();
  async function receive(envelope) {
    const context = envelope?.context;
    if (!context || typeof context.senderId !== "string" || typeof context.senderPairingId !== "string") throw new Error("Invalid fingerprint delivery");
    return identities.withApprovedPeer(context.senderId, context.senderPairingId, async ({ identity, peer, binding }) => {
      // Identity/pairing expectations are pinned locally. Enrollment metadata is
      // accepted only after signature verification and active roster validation.
      const expected = { ...context, installationId: binding.installationId, senderId: peer.kioskId, senderPairingId: peer.pairingId,
        senderKeyId: peer.fingerprint, recipientId: binding.kioskId, recipientPairingId: binding.pairingId,
        recipientKeyId: fingerprintIdentityId(fingerprintPublicIdentity(identity)) };
      const template = openFingerprintTemplate(envelope, { recipient: identity, sender: peer.publicIdentity, expected, now: now() });
      try {
        const envelopeDigest = createHash("sha256").update(Buffer.from(envelope.signature, "base64")).digest("hex");
        return await importer.receive(context, template, envelopeDigest);
      } finally { template.fill(0); }
    });
  }
  return { receive(envelope) { const result = tail.then(() => receive(envelope), () => receive(envelope)); tail = result.then(() => undefined, () => undefined); return result; } };
}

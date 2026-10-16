import { createHash } from "node:crypto";
import { fingerprintIdentityId, fingerprintPublicIdentity, sealFingerprintTemplate } from "./fingerprint-envelope.mjs";
import { freshFingerprintSource } from "./fingerprint-source.mjs";

const lifetime = 7 * 86400000;
const deliveryId = (binding, keyId, enrollment, peer) => createHash("sha256").update(JSON.stringify([
  "LancerLogin fingerprint delivery v1", binding.installationId, binding.kioskId, binding.pairingId, keyId,
  enrollment.id, peer.kioskId, peer.pairingId, peer.fingerprint,
])).digest("hex");

// Enrollment metadata is persisted atomically with its local mapping. Legacy
// and received mappings have none and must never be automatically bulk-exported.
export function createFingerprintSender({ identities, outbox, mappings, templates, withSensor, isMemberActive, send, now = Date.now }) {
  let running, cursor = 0, captureCursor = 0;
  async function run() {
    const state = await identities.status();
    if (!state.enabled) return { enabled: false, captured: 0, completed: 0, errors: 0 };
    const summary = { enabled: true, captured: 0, completed: 0, errors: 0 };
    const known = new Set((await outbox.status()).map(record => record.transferId));
    const entries = Object.entries(await mappings.read());
    const captures = [];
    for (const [slot, mapping] of entries) {
      const enrollment = mapping.enrollment;
      if (!freshFingerprintSource(mapping, now()) || enrollment.occurredAt + lifetime <= now()) continue;
      if (!await isMemberActive(mapping.memberId, mapping.rosterId)) continue;
      for (const candidate of state.peers) {
        const transferId = deliveryId(state.binding, state.fingerprint, enrollment, candidate);
        if (!known.has(transferId)) captures.push({ slot, mapping, enrollment, candidate, transferId });
      }
    }
    const captureBatch = captures.length ? Array.from({ length: Math.min(8, captures.length) }, (_, offset) => captures[(captureCursor + offset) % captures.length]) : [];
    captureCursor = captures.length ? (captureCursor + captureBatch.length) % captures.length : 0;
    for (const { slot, mapping, enrollment, candidate, transferId } of captureBatch) {
        try {
          await identities.withApprovedPeer(candidate.kioskId, candidate.pairingId, async ({ identity, peer, binding }) => {
            const senderKeyId = fingerprintIdentityId(fingerprintPublicIdentity(identity));
            if (deliveryId(binding, senderKeyId, enrollment, peer) !== transferId) throw new Error("Fingerprint sync identity changed");
            await withSensor(async () => {
              const current = (await mappings.read())[slot];
              if (!freshFingerprintSource(current, now()) || current.memberId !== mapping.memberId || current.rosterId !== mapping.rosterId || current.enrollment.id !== enrollment.id || current.enrollment.occurredAt !== enrollment.occurredAt) throw new Error("Fingerprint enrollment changed");
              if (!await isMemberActive(current.memberId, current.rosterId)) throw new Error("Fingerprint member is not active");
              const template = await templates.exportTemplate(Number(slot));
              try {
                const context = { installationId: binding.installationId, senderId: binding.kioskId, senderPairingId: binding.pairingId,
                  recipientId: peer.kioskId, recipientPairingId: peer.pairingId, senderKeyId, recipientKeyId: peer.fingerprint,
                  memberId: current.memberId, enrollmentId: enrollment.id, transferId, revision: 1,
                  issuedAt: enrollment.occurredAt, expiresAt: enrollment.occurredAt + lifetime };
                const envelope = sealFingerprintTemplate(template, { sender: identity, recipient: peer.publicIdentity, context, now: now() });
                await outbox.enqueue(envelope); known.add(transferId); summary.captured++;
              } finally { template.fill(0); }
            });
          });
        } catch (error) { if (error?.reasonCode === "local_state_review") throw error; summary.errors++; }
    }
    const pending = await outbox.pending();
    const batch = pending.length ? Array.from({ length: Math.min(8, pending.length) }, (_, offset) => pending[(cursor + offset) % pending.length]) : [];
    cursor = pending.length ? (cursor + batch.length) % pending.length : 0;
    for (const record of batch) {
      const c = record.envelope.context;
      try {
        const currentState = await identities.status();
        if (!currentState.enabled) break;
        if (!currentState.peers.some(peer => peer.kioskId === c.recipientId && peer.pairingId === c.recipientPairingId && peer.fingerprint === c.recipientKeyId)) {
          await outbox.finish(record.transferId, record.digest, "revoked"); continue;
        }
        await identities.withApprovedPeer(c.recipientId, c.recipientPairingId, async ({ identity, peer, binding }) => {
          if (peer.fingerprint !== c.recipientKeyId || fingerprintIdentityId(fingerprintPublicIdentity(identity)) !== c.senderKeyId || binding.installationId !== c.installationId || binding.pairingId !== c.senderPairingId) throw new Error("Fingerprint sync authority changed");
          // A removed/replaced source enrollment must not dispatch queued data.
          const current = Object.values(await mappings.read()).find(mapping => freshFingerprintSource(mapping, now()) && mapping.memberId === c.memberId && mapping.enrollment.id === c.enrollmentId && mapping.enrollment.occurredAt === c.issuedAt);
          if (!current || !await isMemberActive(current.memberId, current.rosterId)) { await outbox.finish(record.transferId, record.digest, "revoked"); return; }
          const result = await send(record.envelope);
          if (result?.transferId !== record.transferId || !["pending", "complete", "needs_review", "rejected"].includes(result.status)) throw new Error("Fingerprint relay result is uncertain");
          if (result.status !== "pending") {
            await outbox.finish(record.transferId, record.digest, result.status);
            if (result.status === "complete") summary.completed++;
          }
        });
      } catch (error) { if (error?.reasonCode === "local_state_review") throw error; summary.errors++; }
    }
    return summary;
  }
  return { tick() { if (!running) running = run().finally(() => { running = undefined; }); return running; } };
}

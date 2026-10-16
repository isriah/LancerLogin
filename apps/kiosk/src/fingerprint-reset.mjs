import { fingerprintDiagnostic, fingerprintFailureReason } from "./fingerprint-diagnostics.mjs";
import { join } from "node:path";
import { createFingerprintResetStore } from "./fingerprint-reset-store.mjs";

const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

// Poll regardless of either sharing setting. This controller never reads,
// deletes or overwrites reader templates and never assigns member identities.
export function createFingerprintReset({ directory, legacyDirectory, config, client, mappings, withSensor, stopTransfers = async () => {}, now = Date.now }) {
  const pairing = `${config.kioskId}-${config.pairingId}`;
  const store = createFingerprintResetStore(join(directory, pairing, "reset.json"), config,
    { legacyPath: legacyDirectory ? join(legacyDirectory, pairing, "associations.json") : undefined });
  let running, diagnostics = { status: "starting", reasonCode: "starting", blocked: false, resetEpoch: null, errors: 0, lastAttemptAt: null, lastSuccessAt: null };
  const snapshot = () => ({ ...fingerprintDiagnostic("reset", diagnostics, now()), blocked: diagnostics.blocked, resetEpoch: diagnostics.resetEpoch });
  async function run(metadata) {
    let stage = "local_state_review";
    diagnostics.lastAttemptAt = new Date(now()).toISOString();
    try {
      diagnostics.resetEpoch = await store.resetEpoch();
      stage = "network_unavailable";
      const reply = await (metadata?.commands ?? (() => client.commands()))();
      stage = "invalid_response";
      if (!Array.isArray(reply?.commands) || reply.commands.length > 1 || reply.commands.some(command => !identifier(command?.id) || command.kind !== "reset_fingerprint_mappings")) throw new Error("Invalid fingerprint reset command");
      const reset = reply.commands[0];
      stage = "reset_recovery";
      if (reset) {
        diagnostics.blocked = true;
        if (!await store.commandCompleted(reset.id)) {
          // Durable intent precedes clearing. Enrollment/mapping mutations use
          // this same lock and fail closed until completion has been persisted.
          await withSensor(() => store.beginReset(reset.id));
          await stopTransfers(diagnostics.resetEpoch);
          await withSensor(async () => { await mappings.replace({}); await store.completeCommand(reset.id); });
        } else await stopTransfers(diagnostics.resetEpoch);
        diagnostics.resetEpoch = await store.resetEpoch();
        stage = "network_unavailable";
        const acknowledgement = await client.complete(reset.id);
        stage = "invalid_response";
        if (acknowledgement?.acknowledged !== true) throw new Error("Fingerprint reset acknowledgement is uncertain");
        diagnostics = { ...diagnostics, status: "reset", reasonCode: "ready", blocked: false, lastSuccessAt: new Date(now()).toISOString() };
      } else {
        if (await store.pendingReset()) throw new Error("Fingerprint mapping reset recovery is pending");
        diagnostics = { ...diagnostics, status: "idle", reasonCode: "ready", blocked: false, lastSuccessAt: new Date(now()).toISOString() };
      }
    } catch (error) { diagnostics = { ...diagnostics, status: "unavailable", reasonCode: fingerprintFailureReason(error, stage), blocked: true, errors: diagnostics.errors + 1 }; }
    return snapshot();
  }
  return {
    tick(metadata) { if (!running) running = run(metadata).finally(() => { running = undefined; }); return running; },
    resetEpoch: () => store.resetEpoch(),
    enrollmentAllowed: async () => !await store.pendingReset(),
    diagnostics: snapshot,
  };
}

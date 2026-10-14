import { join } from "node:path";
import { createFingerprintResetStore } from "./fingerprint-reset-store.mjs";

const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

// Poll regardless of either sharing setting. This controller never reads,
// deletes or overwrites reader templates and never assigns member identities.
export function createFingerprintReset({ directory, legacyDirectory, config, client, mappings, withSensor, stopTransfers = async () => {} }) {
  const pairing = `${config.kioskId}-${config.pairingId}`;
  const store = createFingerprintResetStore(join(directory, pairing, "reset.json"), config,
    { legacyPath: legacyDirectory ? join(legacyDirectory, pairing, "associations.json") : undefined });
  let running, diagnostics = { status: "idle", blocked: false, resetEpoch: null, errors: 0 };
  async function run() {
    try {
      diagnostics.resetEpoch = await store.resetEpoch();
      const reply = await client.commands();
      if (!Array.isArray(reply?.commands) || reply.commands.length > 1 || reply.commands.some(command => !identifier(command?.id) || command.kind !== "reset_fingerprint_mappings")) throw new Error("Invalid fingerprint reset command");
      const reset = reply.commands[0];
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
        if ((await client.complete(reset.id))?.acknowledged !== true) throw new Error("Fingerprint reset acknowledgement is uncertain");
        diagnostics = { ...diagnostics, status: "reset", blocked: false };
      } else {
        if (await store.pendingReset()) throw new Error("Fingerprint mapping reset recovery is pending");
        diagnostics = { ...diagnostics, status: "idle", blocked: false };
      }
    } catch { diagnostics = { ...diagnostics, status: "unavailable", blocked: true, errors: diagnostics.errors + 1 }; }
    return { ...diagnostics };
  }
  return {
    tick() { if (!running) running = run().finally(() => { running = undefined; }); return running; },
    resetEpoch: () => store.resetEpoch(),
    enrollmentAllowed: async () => !await store.pendingReset(),
    diagnostics: () => ({ ...diagnostics }),
  };
}

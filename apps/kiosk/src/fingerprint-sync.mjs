import { fingerprintDiagnostic, fingerprintDiagnosticError, fingerprintDiagnosticOperation, fingerprintFailureReason } from "./fingerprint-diagnostics.mjs";
import { join } from "node:path";
import { createFingerprintIdentityStore, readFingerprintBinding } from "./fingerprint-identity-store.mjs";
import { createFingerprintJournal } from "./fingerprint-journal.mjs";
import { createFingerprintOutbox } from "./fingerprint-outbox.mjs";
import { createFingerprintSender } from "./fingerprint-sender.mjs";
import { createFingerprintReceiver } from "./fingerprint-receiver.mjs";
import { fingerprintIdentityId } from "./fingerprint-envelope.mjs";

export function createFingerprintSync({ directory, config, client, sensor, templates, mappings, withSensor, fetchRoster, now = Date.now }) {
  let stores, boundSyncId, preparing, running, members = new Map(), rosterUntil = 0, resetPaused = false;
  let diagnostics = { status: "starting", reasonCode: "starting", received: 0, errors: 0, lastAttemptAt: null, lastSuccessAt: null };
  const snapshot = () => fingerprintDiagnostic("peer", resetPaused ? { ...diagnostics, status: "reset", reasonCode: "reset_recovery" } : diagnostics, now());
  let recovering, incomingCursor, registered, registeredUntil = 0;
  async function localStores() {
    if (stores) return stores;
    if (!recovering) recovering = (async () => {
      const path = join(directory, "identity.json");
      const binding = await readFingerprintBinding(path, config);
      if (!binding) return null;
      const identities = createFingerprintIdentityStore(path, binding);
      await fingerprintDiagnosticOperation("local_state_review", () => identities.status());
      stores = { identities, binding }; boundSyncId = binding.installationId;
      return stores;
    })().finally(() => { recovering = undefined; });
    return recovering;
  }
  async function prepare(configuration = () => client.configuration()) {
    if (preparing) return preparing;
    preparing = (async () => {
      const remote = await configuration();
      if (typeof remote?.enabled !== "boolean" || (remote.syncId !== null && !/^[a-f0-9]{64}$/.test(remote.syncId ?? ""))) throw fingerprintDiagnosticError("invalid_response");
      if (!remote.enabled) { registered = undefined; diagnostics.status = "installation_disabled"; diagnostics.reasonCode = "installation_disabled"; return null; }
      if (!remote.syncId) throw fingerprintDiagnosticError("invalid_response");
      await fingerprintDiagnosticOperation("local_state_review", localStores);
      if (boundSyncId && boundSyncId !== remote.syncId) throw fingerprintDiagnosticError("identity_mismatch");
      if (!stores) {
        const binding = { installationId: remote.syncId, kioskId: config.kioskId, pairingId: config.pairingId };
        const identities = createFingerprintIdentityStore(join(directory, "identity.json"), binding);
        await fingerprintDiagnosticOperation("local_state_review", () => identities.status());
        stores = { identities, binding }; boundSyncId = remote.syncId;
      }
      return stores;
    })().finally(() => { preparing = undefined; });
    return preparing;
  }
  function deliveryStores(current, identity) {
    if (!current.outbox) {
      current.outbox = createFingerprintOutbox(join(directory, "outbox.json"), current.binding, { publicIdentity: identity.publicIdentity, now });
      current.journal = createFingerprintJournal(join(directory, "received.json"), current.binding);
      const isMemberActive = async (memberId, rosterId) => !resetPaused && now() < rosterUntil && members.has(memberId) && (!rosterId || members.get(memberId) === rosterId);
      current.sender = createFingerprintSender({ identities: current.identities, outbox: current.outbox, mappings, templates, withSensor, isMemberActive, now, send: envelope => client.send(envelope) });
      current.receiver = createFingerprintReceiver({ identities: current.identities, journal: current.journal, sensor, templates, mappings, withSensor, isMemberActive, now });
    }
    return current;
  }
  async function peers(current) {
    const result = await client.peers();
    if (!Array.isArray(result?.peers) || result.peers.length > 32) throw fingerprintDiagnosticError("invalid_response");
    return result.peers.map(peer => {
      if (peer.installationId !== current.binding.installationId || typeof peer.kioskId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(peer.kioskId) || typeof peer.pairingId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(peer.pairingId) || peer.fingerprint !== fingerprintIdentityId(peer.publicIdentity)) throw new Error("Fingerprint peer identity is invalid");
      return { ...peer, name: String(peer.name ?? "Kiosk").slice(0, 100) };
    });
  }
  async function register(current, identity) {
    const key = `${current.binding.installationId}:${identity.fingerprint}`;
    if (registered === key && now() < registeredUntil) return;
    const result = await client.register({ publicIdentity: identity.publicIdentity, fingerprint: identity.fingerprint });
    if (result?.registered !== true || result.fingerprint !== identity.fingerprint) throw fingerprintDiagnosticError("invalid_response");
    registered = key; registeredUntil = now() + 300000;
  }
  async function tick(metadata) {
    let stage = "network_unavailable";
    diagnostics.lastAttemptAt = new Date(now()).toISOString();
    try {
      let incoming, current;
      if (registered && stores) {
        stage = "local_state_review";
        const localIdentity = await fingerprintDiagnosticOperation(stage, () => stores.identities.status());
        deliveryStores(stores, localIdentity);
        await fingerprintDiagnosticOperation(stage, () => stores.outbox.status());
        // The delivery read rechecks current pairing, module and installation
        // enablement. Its generation replaces a second configuration request.
        stage = "network_unavailable";
        incoming = await (metadata?.pending ?? (after => client.pending(after)))(incomingCursor);
        if (incoming?.syncId !== undefined) {
          if (incoming.syncId !== stores.binding.installationId) throw fingerprintDiagnosticError("identity_mismatch");
          current = stores;
        }
      }
      current ??= await prepare(metadata?.configuration); if (!current) return snapshot();
      if (resetPaused) return snapshot();
      stage = "local_state_review";
      const identity = await current.identities.status();
      if (!identity.enabled) { diagnostics.status = "disabled"; diagnostics.reasonCode = "local_disabled"; return snapshot(); }
      stage = "network_unavailable";
      await register(current, identity);
      stage = "roster_unavailable";
      const roster = await (metadata?.roster ?? fetchRoster)();
      if (!Array.isArray(roster?.members) || roster.members.length > 10000 || roster.members.some(member => typeof member?.memberId !== "string" || !member.memberId || member.memberId.length > 100 || member.memberId !== member.memberId.trim() || /[\u0000-\u001f\u007f]/.test(member.memberId) || typeof member.rosterId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(member.rosterId))) throw new Error("Fresh roster is unavailable");
      members = new Map(roster.members.map(member => [member.memberId, member.rosterId])); rosterUntil = Math.min(now() + 60000, roster.freshUntil ?? Infinity);
      if (!(rosterUntil > now())) throw new Error("Fresh roster is unavailable");
      stage = "local_state_review";
      deliveryStores(current, identity);
      const receipts = await current.journal.list();
      // Peer imports intentionally do not acquire fresh source-enrollment
      // authority. Their completed local receipt is evidence of a recipient
      // copy, not a reason to ask the member to enroll again.
      const mappingEntries = Object.entries(await mappings.read()).filter(([slot, mapping]) => !(
        mapping.rosterId === undefined && mapping.enrollment === undefined && mapping.review === undefined
        && members.has(mapping.memberId)
        && receipts.some(record => record.phase === "complete" && record.slot === Number(slot) && record.memberId === mapping.memberId)
      )).map(([, mapping]) => mapping);
      const missingIdentityMappings = mappingEntries.filter(mapping => !mapping.rosterId).length;
      const unshareableMappings = mappingEntries.filter(mapping => !mapping.rosterId || !members.has(mapping.memberId) || members.get(mapping.memberId) !== mapping.rosterId || mapping.review !== undefined).length;
      stage = "transfer_retry";
      const outgoing = await current.sender.tick();
      stage = "network_unavailable";
      incoming ??= await (metadata?.pending ?? (after => client.pending(after)))(incomingCursor);
      stage = "invalid_response";
      if (!Array.isArray(incoming?.deliveries) || incoming.deliveries.length > 8) throw new Error("Fingerprint delivery list is invalid");
      let previousId = incomingCursor ?? "";
      for (const envelope of incoming.deliveries) {
        const id = envelope?.context?.transferId;
        if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(id) || id <= previousId) throw new Error("Fingerprint delivery cursor is invalid");
        previousId = id;
      }
      let received = 0, errors = outgoing.errors, failureReason;
      for (const envelope of incoming.deliveries) {
        try {
          const result = await current.receiver.receive(envelope);
          const ack = await client.acknowledge(result.transferId, result);
          if (ack?.transferId !== result.transferId || ack.status !== "complete") throw new Error("Fingerprint acknowledgement is uncertain");
          received++;
        } catch (error) { errors++; const reason = fingerprintFailureReason(error, "transfer_retry"); if (!failureReason || reason === "local_state_review") failureReason = reason; }
      }
      // Failures remain pending for a later sweep, without hiding later pages.
      // Restart starts a new sweep. No transfer is acknowledged by advancing.
      incomingCursor = incoming.deliveries.length === 8 ? previousId : undefined;
      diagnostics = { ...diagnostics, status: errors || unshareableMappings ? "needs_attention" : identity.peers.length ? "ready" : "waiting",
        reasonCode: errors ? failureReason ?? "transfer_retry" : missingIdentityMappings ? "enrollment_identity_missing" : unshareableMappings ? "mapping_review" : identity.peers.length ? "ready" : "no_approved_peer",
        received, errors, captured: outgoing.captured, completed: outgoing.completed, missingIdentityMappings, unshareableMappings,
        lastSuccessAt: errors ? diagnostics.lastSuccessAt : new Date(now()).toISOString() };
    } catch (error) { registered = undefined; rosterUntil = 0; diagnostics = { ...diagnostics, status: "unavailable", reasonCode: fingerprintFailureReason(error, stage), errors: diagnostics.errors + 1 }; }
    return snapshot();
  }
  return {
    pollCursor: () => incomingCursor,
    invalidateAuthority() { rosterUntil = 0; registered = undefined; },
    tick(metadata) { if (resetPaused) return Promise.resolve(snapshot()); if (!running) running = tick(metadata).finally(() => { running = undefined; }); return running; },
    async stopForReset() {
      resetPaused = true; registered = undefined; rosterUntil = 0; await running; await preparing;
      const current = await localStores();
      if (current) {
        const identity = await current.identities.setEnabled(false);
        if (identity.publicIdentity) deliveryStores(current, identity);
        if (current.outbox) for (const record of await current.outbox.pending()) await current.outbox.finish(record.transferId, record.digest, "revoked");
      }
      incomingCursor = undefined; diagnostics.status = "reset"; diagnostics.reasonCode = "reset_recovery";
    },
    diagnostics: snapshot,
    async status() {
      let stage = "network_unavailable";
      try {
        let current, offline = false;
        try { current = await prepare(); } catch (error) { offline = true; diagnostics.status = "unavailable"; diagnostics.reasonCode = fingerprintFailureReason(error, "network_unavailable"); }
        if (!current) {
          stage = "local_state_review";
          const local = await localStores();
          if (local) return { installationEnabled: false, offline, ...await local.identities.status(), candidates: [], diagnostics: fingerprintDiagnostic("peer", { ...diagnostics, status: offline ? "unavailable" : "installation_disabled" }, now()) };
          if (offline) throw fingerprintDiagnosticError(diagnostics.reasonCode);
          return { installationEnabled: false, enabled: false, peers: [], candidates: [], diagnostics: snapshot() };
        }
        stage = "local_state_review";
        const identity = await current.identities.status();
        stage = "network_unavailable";
        if (identity.enabled) await register(current, identity);
        return { installationEnabled: true, ...identity, candidates: identity.enabled ? await peers(current) : [], diagnostics: snapshot() };
      } catch (error) {
        diagnostics.status = "unavailable"; diagnostics.reasonCode = fingerprintFailureReason(error, stage);
        throw error;
      }
    },
    async setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Choose whether fingerprint sync is enabled");
      // Local disablement must still work when the cloud is unreachable.
      const current = enabled ? await prepare() : await localStores();
      if (!current) throw new Error("Enable fingerprint sync in installation settings first");
      const identity = await current.identities.setEnabled(enabled);
      if (enabled) await register(current, identity);
      else {
        registered = undefined; rosterUntil = 0;
        if (identity.publicIdentity) deliveryStores(current, identity);
        if (current.outbox) for (const record of await current.outbox.pending()) await current.outbox.finish(record.transferId, record.digest, "revoked");
        try { await client.revoke(); } catch { /* Local authorization is already disabled. */ }
      }
      return { enabled: identity.enabled, fingerprint: identity.fingerprint };
    },
    async approvePeer(kioskId, confirmedFingerprint) {
      const current = await prepare(); if (!current) throw new Error("Fingerprint sync is disabled");
      const candidate = (await peers(current)).find(peer => peer.kioskId === kioskId && peer.fingerprint === confirmedFingerprint);
      if (!candidate) throw new Error("The kiosk identity changed; compare fingerprints again");
      await current.identities.approvePeer(candidate, confirmedFingerprint);
      return { approved: true };
    },
    async revokePeer(kioskId) {
      const current = await localStores(); if (!current) throw new Error("Fingerprint sync is disabled");
      await current.identities.revokePeer(kioskId); return { revoked: true };
    },
  };
}

import { join } from "node:path";
import { createFingerprintIdentityStore, readFingerprintBinding } from "./fingerprint-identity-store.mjs";
import { createFingerprintJournal } from "./fingerprint-journal.mjs";
import { createFingerprintOutbox } from "./fingerprint-outbox.mjs";
import { createFingerprintSender } from "./fingerprint-sender.mjs";
import { createFingerprintReceiver } from "./fingerprint-receiver.mjs";
import { fingerprintIdentityId } from "./fingerprint-envelope.mjs";

export function createFingerprintSync({ directory, config, client, sensor, templates, mappings, withSensor, fetchRoster, now = Date.now }) {
  let stores, boundSyncId, preparing, running, members = new Map(), rosterUntil = 0, resetPaused = false;
  let diagnostics = { status: "disabled", received: 0, errors: 0 };
  let recovering, incomingCursor;
  async function localStores() {
    if (stores) return stores;
    if (!recovering) recovering = (async () => {
      const path = join(directory, "identity.json");
      const binding = await readFingerprintBinding(path, config);
      if (!binding) return null;
      const identities = createFingerprintIdentityStore(path, binding);
      await identities.status();
      stores = { identities, binding }; boundSyncId = binding.installationId;
      return stores;
    })().finally(() => { recovering = undefined; });
    return recovering;
  }
  async function prepare() {
    if (preparing) return preparing;
    preparing = (async () => {
      const remote = await client.configuration();
      if (typeof remote?.enabled !== "boolean" || (remote.syncId !== null && !/^[a-f0-9]{64}$/.test(remote.syncId ?? ""))) throw new Error("Fingerprint sync configuration is invalid");
      if (!remote.enabled) { diagnostics.status = "installation_disabled"; return null; }
      if (!remote.syncId) throw new Error("Fingerprint sync configuration is incomplete");
      await localStores();
      if (boundSyncId && boundSyncId !== remote.syncId) throw new Error("Installation identity changed; local sync review is required");
      if (!stores) {
        const binding = { installationId: remote.syncId, kioskId: config.kioskId, pairingId: config.pairingId };
        const identities = createFingerprintIdentityStore(join(directory, "identity.json"), binding);
        await identities.status();
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
    if (!Array.isArray(result?.peers) || result.peers.length > 32) throw new Error("Fingerprint peer list is invalid");
    return result.peers.map(peer => {
      if (peer.installationId !== current.binding.installationId || typeof peer.kioskId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(peer.kioskId) || typeof peer.pairingId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(peer.pairingId) || peer.fingerprint !== fingerprintIdentityId(peer.publicIdentity)) throw new Error("Fingerprint peer identity is invalid");
      return { ...peer, name: String(peer.name ?? "Kiosk").slice(0, 100) };
    });
  }
  async function register(current, identity) {
    const result = await client.register({ publicIdentity: identity.publicIdentity, fingerprint: identity.fingerprint });
    if (result?.registered !== true || result.fingerprint !== identity.fingerprint) throw new Error("Fingerprint identity registration is uncertain");
  }
  async function tick() {
    try {
      const current = await prepare(); if (!current) return { ...diagnostics };
      if (resetPaused) return { ...diagnostics, status: "reset" };
      const identity = await current.identities.status();
      if (!identity.enabled) { diagnostics.status = "disabled"; return { ...diagnostics }; }
      await register(current, identity);
      const roster = await fetchRoster();
      if (!Array.isArray(roster?.members) || roster.members.length > 10000 || roster.members.some(member => typeof member?.memberId !== "string" || !member.memberId || member.memberId.length > 100 || member.memberId !== member.memberId.trim() || /[\u0000-\u001f\u007f]/.test(member.memberId) || typeof member.rosterId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(member.rosterId))) throw new Error("Fresh roster is unavailable");
      members = new Map(roster.members.map(member => [member.memberId, member.rosterId])); rosterUntil = now() + 60000;
      deliveryStores(current, identity);
      const outgoing = await current.sender.tick();
      const incoming = await client.pending(incomingCursor);
      if (!Array.isArray(incoming?.deliveries) || incoming.deliveries.length > 8) throw new Error("Fingerprint delivery list is invalid");
      let previousId = incomingCursor ?? "";
      for (const envelope of incoming.deliveries) {
        const id = envelope?.context?.transferId;
        if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(id) || id <= previousId) throw new Error("Fingerprint delivery cursor is invalid");
        previousId = id;
      }
      let received = 0, errors = outgoing.errors;
      for (const envelope of incoming.deliveries) {
        try {
          const result = await current.receiver.receive(envelope);
          const ack = await client.acknowledge(result.transferId, result);
          if (ack?.transferId !== result.transferId || ack.status !== "complete") throw new Error("Fingerprint acknowledgement is uncertain");
          received++;
        } catch { errors++; }
      }
      // Failures remain pending for a later sweep, without hiding later pages.
      // Restart starts a new sweep. No transfer is acknowledged by advancing.
      incomingCursor = incoming.deliveries.length === 8 ? previousId : undefined;
      diagnostics = { status: errors ? "needs_attention" : "ready", received, errors, captured: outgoing.captured, completed: outgoing.completed };
    } catch { rosterUntil = 0; diagnostics = { ...diagnostics, status: "unavailable", errors: diagnostics.errors + 1 }; }
    return { ...diagnostics };
  }
  return {
    tick() { if (resetPaused) return Promise.resolve({ ...diagnostics, status: "reset" }); if (!running) running = tick().finally(() => { running = undefined; }); return running; },
    async stopForReset() {
      resetPaused = true; rosterUntil = 0; await running; await preparing;
      const current = await localStores();
      if (current) {
        const identity = await current.identities.setEnabled(false);
        if (identity.publicIdentity) deliveryStores(current, identity);
        if (current.outbox) for (const record of await current.outbox.pending()) await current.outbox.finish(record.transferId, record.digest, "revoked");
      }
      incomingCursor = undefined; diagnostics.status = "reset";
    },
    diagnostics: () => ({ ...diagnostics }),
    async status() {
      let current, offline = false;
      try { current = await prepare(); } catch { offline = true; }
      if (!current) {
        const local = await localStores();
        if (local) return { installationEnabled: false, offline, ...await local.identities.status(), candidates: [], diagnostics: { ...diagnostics, status: offline ? "unavailable" : "installation_disabled" } };
        if (offline) throw new Error("Fingerprint relay is unavailable");
        return { installationEnabled: false, enabled: false, peers: [], candidates: [], diagnostics: { ...diagnostics } };
      }
      const identity = await current.identities.status();
      if (identity.enabled) await register(current, identity);
      return { installationEnabled: true, ...identity, candidates: identity.enabled ? await peers(current) : [], diagnostics: { ...diagnostics } };
    },
    async setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Choose whether fingerprint sync is enabled");
      // Local disablement must still work when the cloud is unreachable.
      const current = enabled ? await prepare() : await localStores();
      if (!current) throw new Error("Enable fingerprint sync in installation settings first");
      const identity = await current.identities.setEnabled(enabled);
      if (enabled) await register(current, identity);
      else {
        rosterUntil = 0;
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

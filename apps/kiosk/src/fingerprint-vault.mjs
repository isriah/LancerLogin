import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { createFingerprintJournal } from "./fingerprint-journal.mjs";
import { createFingerprintImporter } from "./fingerprint-importer.mjs";
import { freshFingerprintSource } from "./fingerprint-source.mjs";

const id = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const memberId = value => typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const rosterId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const digest = value => createHash("sha256").update(value).digest("hex");
const signature = (slot, mapping) => digest(JSON.stringify([slot, mapping.memberId, mapping.rosterId, mapping.finger, mapping.enrollment?.id ?? "legacy"]));

// Installation enablement authorizes new local enrollment export and import for paired
// R503 kiosks. No model is written to local files: only the existing safe import
// journal records delivery/member/slot metadata. Attendance delivery is separate.
export function createFingerprintVault({ directory, config, client, sensor, templates, mappings, withSensor, fetchRoster, capacity = 200, now = Date.now }) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(config?.kioskId ?? "") || !/^[A-Za-z0-9._:-]{1,128}$/.test(config?.pairingId ?? "")) throw new Error("Fingerprint cloud storage requires a bound kiosk pairing");
  let running, vaultId, journal, importer, cursor, captureCursor = 0, resetPaused = false;
  let members = new Map(), rosterUntil = 0, captured = new Set(), knownIds = new Set();
  let diagnostics = { status: "disabled", uploaded: 0, received: 0, errors: 0, legacyMappings: 0 };
  const active = (value, identity) => !resetPaused && now() < rosterUntil && members.has(value) && (!identity || members.get(value) === identity);
  const importContext = (fingerprintId, member, identity) => ({ installationId: vaultId, senderId: "cloud-vault", senderPairingId: vaultId, senderKeyId: vaultId, rosterId: identity,
    recipientId: config.kioskId, recipientPairingId: config.pairingId, memberId: member, enrollmentId: fingerprintId,
    transferId: digest(JSON.stringify(["LancerLogin vault import v1", vaultId, config.kioskId, config.pairingId, fingerprintId])), revision: 1 });
  async function run() {
    try {
      const remote = await client.configuration();
      if (resetPaused) return { ...diagnostics, status: "reset" };
      if (typeof remote?.enabled !== "boolean" || remote.enabled && (!id(remote.vaultId) || remote.format !== "r503-model-1536")) throw new Error("Invalid fingerprint cloud configuration");
      if (!remote.enabled) { rosterUntil = 0; captured.clear(); knownIds.clear(); diagnostics = { status: "disabled", uploaded: 0, received: 0, errors: 0, legacyMappings: 0 }; return diagnostics; }
      if (remote.vaultId !== vaultId) {
        vaultId = remote.vaultId; captured.clear(); knownIds.clear(); cursor = undefined;
        journal = createFingerprintJournal(join(directory, `${config.kioskId}-${config.pairingId}`, vaultId, "received.json"), { installationId: vaultId, kioskId: config.kioskId, pairingId: config.pairingId }, { allowSuperseded: true });
        importer = createFingerprintImporter({ journal, sensor, templates, mappings, withSensor, isMemberActive: active, capacity, reuseExisting: true });
      }
      const roster = await fetchRoster();
      if (!Array.isArray(roster?.members) || roster.members.length > 10000 || roster.members.some(member => !memberId(member?.memberId) || !rosterId(member?.rosterId))) throw new Error("Fresh active roster is unavailable");
      members = new Map(roster.members.map(member => [member.memberId, member.rosterId])); rosterUntil = now() + 60000;
      const entries = Object.entries(await mappings.read());
      if (entries.length > capacity || entries.some(([slot, mapping]) => !/^\d{1,4}$/.test(slot) || Number(slot) >= capacity || !memberId(mapping.memberId))) throw new Error("Fingerprint mappings require local review");
      const currentSignatures = new Set(entries.map(([slot, mapping]) => signature(slot, mapping)));
      captured = new Set([...captured].filter(value => currentSignatures.has(value)));
      const legacyMappings = entries.filter(([, mapping]) => !mapping.rosterId || !active(mapping.memberId, mapping.rosterId) || mapping.review !== undefined).length;
      const candidates = entries.filter(([slot, mapping]) => freshFingerprintSource(mapping, now()) && active(mapping.memberId, mapping.rosterId) && !captured.has(signature(slot, mapping)));
      const batch = candidates.length ? Array.from({ length: Math.min(2, candidates.length) }, (_, offset) => candidates[(captureCursor + offset) % candidates.length]) : [];
      captureCursor = candidates.length ? (captureCursor + batch.length) % candidates.length : 0;
      let uploaded = 0, received = 0, errors = 0;
      for (const [slot, mapping] of batch) {
        try {
          await withSensor(async () => {
            const current = (await mappings.read())[slot];
            if (!freshFingerprintSource(current, now()) || signature(slot, current) !== signature(slot, mapping) || !active(current.memberId, current.rosterId)) throw new Error("Fingerprint source mapping changed");
            // Unmapped occupied slots are never considered. The template reader
            // independently verifies that this mapped source slot is occupied.
            const template = await templates.exportTemplate(Number(slot));
            try {
              const result = await client.store({ vaultId, memberId: current.memberId, rosterId: current.rosterId, enrollmentId: current.enrollment.id, template: Buffer.from(template.buffer, template.byteOffset, template.byteLength).toString("base64") });
              if (result?.stored !== true || !id(result.fingerprintId)) throw new Error("Fingerprint cloud upload was not confirmed");
              // Persist ownership of a source copy too. If its mapping is later
              // removed, a restart must not silently download and remap it.
              const context = importContext(result.fingerprintId, current.memberId, current.rosterId);
              const occupiedSlots = await sensor.occupiedSlots();
              let record = await journal.reserve(context, digest(template), { capacity, occupiedSlots, mappedSlots: Object.keys(await mappings.read()).map(Number), existingSlot: Number(slot), supersedeExisting: true });
              if (record.phase === "needs_review" || await mappings.memberForSlot(record.slot) !== current.memberId || !occupiedSlots.includes(record.slot)) throw new Error("Fingerprint source journal requires local review");
              if (record.slot !== Number(slot)) {
                const existing = await templates.exportTemplate(record.slot);
                try { if (existing.length !== template.length || !timingSafeEqual(existing, template)) throw new Error("Fingerprint source copy requires local review"); }
                finally { existing.fill(0); }
              }
              for (const [from, to] of [["reserved", "stored"], ["stored", "mapped"], ["mapped", "complete"]]) if (record.phase === from) record = await journal.advance(record.transferId, from, to);
              captured.add(signature(slot, current)); knownIds.add(result.fingerprintId); uploaded++;
            } finally { template.fill(0); }
          });
        } catch { errors++; }
      }
      const pending = await client.list(cursor);
      if (pending?.vaultId !== vaultId || !Array.isArray(pending.fingerprints) || pending.fingerprints.length > 8) throw new Error("Invalid fingerprint cloud manifest");
      let previous = cursor ?? "";
      const records = await journal.list();
      for (const fingerprint of pending.fingerprints) {
        if (!id(fingerprint?.fingerprintId) || fingerprint.fingerprintId <= previous || !memberId(fingerprint.memberId) || !rosterId(fingerprint.rosterId)) throw new Error("Invalid fingerprint cloud cursor");
        previous = fingerprint.fingerprintId;
        const transferId = importContext(fingerprint.fingerprintId, fingerprint.memberId, fingerprint.rosterId).transferId;
        const record = records.find(record => record.transferId === transferId);
        try {
          if (!active(fingerprint.memberId, fingerprint.rosterId)) throw new Error("Fingerprint member is not active or its identity changed");
          // An explicitly replaced local source copy is historical metadata, not
          // permission to download the old model into another free reader slot.
          if (record?.phase === "superseded") continue;
          if (knownIds.has(fingerprint.fingerprintId)) continue;
          if (record?.phase === "complete") {
            const mapping = (await mappings.read())[String(record.slot)];
            if (mapping?.memberId !== fingerprint.memberId || mapping.rosterId !== fingerprint.rosterId) throw new Error("Completed fingerprint mapping requires review");
            continue;
          }
          const result = await client.template(fingerprint.fingerprintId);
          if (result?.vaultId !== vaultId || result.fingerprintId !== fingerprint.fingerprintId || result.memberId !== fingerprint.memberId || result.rosterId !== fingerprint.rosterId || result.format !== "r503-model-1536" || typeof result.template !== "string" || result.template.length !== 2048) throw new Error("Invalid fingerprint cloud model");
          const template = Buffer.from(result.template, "base64");
          const canonical = template.toString("base64") === result.template; result.template = undefined;
          try {
            if (template.length !== 1536 || !canonical) throw new Error("Invalid fingerprint cloud model");
            const context = importContext(fingerprint.fingerprintId, fingerprint.memberId, fingerprint.rosterId);
            await importer.receive(context, template, digest(template)); received++;
          } finally { template.fill(0); }
        } catch { errors++; }
      }
      cursor = pending.fingerprints.length === 8 ? previous : undefined;
      diagnostics = { status: errors || legacyMappings ? "needs_attention" : "ready", uploaded, received, errors, legacyMappings };
    } catch { rosterUntil = 0; diagnostics = { ...diagnostics, status: "unavailable", errors: diagnostics.errors + 1 }; }
    return { ...diagnostics };
  }
  return {
    tick() { if (resetPaused) return Promise.resolve({ ...diagnostics, status: "reset" }); if (!running) running = run().finally(() => { running = undefined; }); return running; },
    async stopForReset() { resetPaused = true; rosterUntil = 0; await running; diagnostics.status = "reset"; },
    diagnostics: () => ({ ...diagnostics }),
  };
}

import { fingerprintDiagnostic, fingerprintDiagnosticOperation, fingerprintFailureReason, fingerprintDiagnosticError } from "./fingerprint-diagnostics.mjs";
import { readdir } from "node:fs/promises";
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
  let running, vaultId, journal, importer, cursor, downloadCursor = 0, captureCursor = 0, resetPaused = false;
  let members = new Map(), rosterUntil = 0, captured = new Set();
  let diagnostics = { status: "starting", reasonCode: "starting", uploaded: 0, received: 0, errors: 0, legacyMappings: 0, lastAttemptAt: null, lastSuccessAt: null };
  const snapshot = () => fingerprintDiagnostic("vault", resetPaused ? { ...diagnostics, status: "reset", reasonCode: "reset_recovery" } : diagnostics, now());
  const active = (value, identity) => !resetPaused && now() < rosterUntil && members.has(value) && (!identity || members.get(value) === identity);
  const importContext = (fingerprintId, member, identity) => ({ installationId: vaultId, senderId: "cloud-vault", senderPairingId: vaultId, senderKeyId: vaultId, rosterId: identity,
    recipientId: config.kioskId, recipientPairingId: config.pairingId, memberId: member, enrollmentId: fingerprintId,
    transferId: digest(JSON.stringify(["LancerLogin vault import v1", vaultId, config.kioskId, config.pairingId, fingerprintId])), revision: 1 });
  async function run(metadata) {
    let stage = "network_unavailable";
    diagnostics.lastAttemptAt = new Date(now()).toISOString();
    try {
      const remote = await (metadata?.configuration ?? (() => client.configuration()))();
      if (resetPaused) return snapshot();
      stage = "invalid_response";
      if (typeof remote?.enabled !== "boolean" || remote.enabled && (!id(remote.vaultId) || remote.format !== "r503-model-1536")) throw new Error("Invalid fingerprint cloud configuration");
      if (!remote.enabled) { rosterUntil = 0; captured.clear(); diagnostics = { ...diagnostics, status: "disabled", reasonCode: "installation_disabled", uploaded: 0, received: 0, errors: 0, legacyMappings: 0, missingIdentityMappings: 0, unshareableMappings: 0 }; return snapshot(); }
      if (remote.vaultId !== vaultId) {
        vaultId = remote.vaultId; captured.clear(); cursor = undefined;
        journal = createFingerprintJournal(join(directory, `${config.kioskId}-${config.pairingId}`, vaultId, "received.json"), { installationId: vaultId, kioskId: config.kioskId, pairingId: config.pairingId }, { allowSuperseded: true });
        importer = createFingerprintImporter({ journal, sensor, templates, mappings, withSensor, isMemberActive: active, capacity, reuseExisting: true });
      }
      stage = "roster_unavailable";
      const roster = await (metadata?.roster ?? fetchRoster)();
      if (!Array.isArray(roster?.members) || roster.members.length > 10000 || roster.members.some(member => !memberId(member?.memberId) || !rosterId(member?.rosterId))) throw new Error("Fresh active roster is unavailable");
      members = new Map(roster.members.map(member => [member.memberId, member.rosterId])); rosterUntil = Math.min(now() + 60000, roster.freshUntil ?? Infinity);
      if (!(rosterUntil > now())) throw new Error("Fresh active roster is unavailable");
      stage = "local_state_review";
      const entries = Object.entries(await mappings.read());
      if (entries.length > capacity || entries.some(([slot, mapping]) => !/^\d{1,4}$/.test(slot) || Number(slot) >= capacity || !memberId(mapping.memberId))) throw new Error("Fingerprint mappings require local review");
      const currentSignatures = new Set(entries.map(([slot, mapping]) => signature(slot, mapping)));
      captured = new Set([...captured].filter(value => currentSignatures.has(value)));
      const missingIdentityMappings = entries.filter(([, mapping]) => !mapping.rosterId).length;
      // Recipient peer copies have no source roster binding. This controller
      // cannot distinguish those from legacy mappings, so missing identities
      // describe upload eligibility without declaring a transfer failure.
      const reviewMappings = entries.filter(([, mapping]) => !members.has(mapping.memberId) || (mapping.rosterId && members.get(mapping.memberId) !== mapping.rosterId) || mapping.review !== undefined).length;
      const legacyMappings = entries.filter(([, mapping]) => !mapping.rosterId || !active(mapping.memberId, mapping.rosterId) || mapping.review !== undefined).length;
      const candidates = entries.filter(([slot, mapping]) => freshFingerprintSource(mapping, now()) && active(mapping.memberId, mapping.rosterId) && !captured.has(signature(slot, mapping)) && !(mapping.cloud?.vaultId === vaultId && mapping.cloud.enrollmentId === mapping.enrollment.id));
      const batch = candidates.length ? Array.from({ length: Math.min(2, candidates.length) }, (_, offset) => candidates[(captureCursor + offset) % candidates.length]) : [];
      captureCursor = candidates.length ? (captureCursor + batch.length) % candidates.length : 0;
      let uploaded = 0, received = 0, errors = 0, retired = 0, pendingDownloads = 0, failureReason;
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
              if (result.templateMatches !== false) {
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
              }
              if (typeof mappings.confirmCloudUpload !== "function") throw new Error("Durable upload receipts are unavailable");
              await mappings.confirmCloudUpload(Number(slot), current, { vaultId, fingerprintId: result.fingerprintId, enrollmentId: current.enrollment.id });
              captured.add(signature(slot, current)); uploaded++;
            } finally { template.fill(0); }
          });
        } catch (error) { errors++; const reason = fingerprintFailureReason(error, "transfer_retry"); if (!failureReason || reason === "local_state_review") failureReason = reason; }
      }
      stage = "network_unavailable";
      const fullCatalog = Boolean(metadata?.catalog && client.catalog && client.batch);
      const pending = fullCatalog ? await metadata.catalog(revision => client.catalog(revision)) : await (metadata?.list ? metadata.list(cursor, after => client.list(after)) : client.list(cursor));
      stage = "invalid_response";
      if (pending?.vaultId !== vaultId || !Array.isArray(pending.fingerprints) || pending.fingerprints.length > (fullCatalog ? 10000 : 8)) throw new Error("Invalid fingerprint cloud manifest");
      let previous = fullCatalog ? "" : cursor ?? "";
      for (const fingerprint of pending.fingerprints) {
        if (!id(fingerprint?.fingerprintId) || fingerprint.fingerprintId <= previous || !memberId(fingerprint.memberId) || !rosterId(fingerprint.rosterId) || fingerprint.retired !== undefined && fingerprint.retired !== true) throw new Error("Invalid fingerprint cloud cursor");
        previous = fingerprint.fingerprintId;
      }
      const downloads = [];
      const occupied = pending.fingerprints.length ? await withSensor(() => sensor.occupiedSlots()) : [];
      let localMappings = await mappings.read();
      const records = await fingerprintDiagnosticOperation("local_state_review", () => journal.list());
      for (const fingerprint of pending.fingerprints) {
        const transferId = importContext(fingerprint.fingerprintId, fingerprint.memberId, fingerprint.rosterId).transferId;
        const record = records.find(record => record.transferId === transferId);
        try {
          if (!active(fingerprint.memberId, fingerprint.rosterId)) throw new Error("Fingerprint member is not active or its identity changed");
          if (fingerprint.retired === true) {
            await withSensor(async () => {
              const current = await mappings.read();
              const sourceIds = fingerprint.sourceEnrollmentIds ?? [];
              if (!Array.isArray(sourceIds) || sourceIds.length > 1024 || sourceIds.some(value => typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))) throw fingerprintDiagnosticError("invalid_response");
              const sources = Object.entries(current).filter(([, mapping]) => mapping.memberId === fingerprint.memberId && mapping.rosterId === fingerprint.rosterId
                && (mapping.cloud?.vaultId === vaultId && mapping.cloud.fingerprintId === fingerprint.fingerprintId || sourceIds.includes(mapping.enrollment?.id)));
              const slot = record?.slot ?? (sources.length ? Number(sources[0][0]) : undefined);
              if (slot === undefined) return;
              const mapping = current[String(slot)];
              const imported = mapping && mapping.memberId === fingerprint.memberId && mapping.rosterId === fingerprint.rosterId && ["complete", "retiring"].includes(record?.phase) && !mapping.enrollment;
              const isSource = sources.some(([key]) => Number(key) === slot);
              // A clearly newer source enrollment is preserved. Ambiguous
              // legacy mappings require review instead of guessing ownership.
              if (mapping && !imported && !isSource && !mapping.enrollment && record?.phase !== "superseded") throw fingerprintDiagnosticError("retirement_review");
              if (record?.phase === "superseded" && !sources.length) return;
              if (record?.phase !== "superseded") await journal.suppress(importContext(fingerprint.fingerprintId, fingerprint.memberId, fingerprint.rosterId), slot, { pending: true });
              if (imported) delete current[String(slot)];
              for (const [key] of sources) delete current[key];
              if (imported || sources.length) await mappings.replace(current);
              localMappings = current;
              await journal.suppress(importContext(fingerprint.fingerprintId, fingerprint.memberId, fingerprint.rosterId), slot);
              retired++;
            });
            continue;
          }
          const source = Object.entries(localMappings).find(([, mapping]) => mapping.cloud?.vaultId === vaultId && mapping.cloud.fingerprintId === fingerprint.fingerprintId);
          if (source) {
            const [slot, mapping] = source;
            if (mapping.memberId !== fingerprint.memberId || mapping.rosterId !== fingerprint.rosterId || !occupied.includes(Number(slot))) throw new Error("Confirmed source mapping requires review");
            continue;
          }
          // An explicitly replaced local source copy is historical metadata, not
          // permission to download the old model into another free reader slot.
          if (record?.phase === "superseded") continue;
          if (record?.phase === "complete") {
            const mapping = localMappings[String(record.slot)];
            if (mapping?.memberId !== fingerprint.memberId || mapping.rosterId !== fingerprint.rosterId || !occupied.includes(record.slot)) throw new Error("Completed fingerprint mapping requires review");
            continue;
          }
          downloads.push(fingerprint);
        } catch (error) { errors++; const reason = fingerprintFailureReason(error, "transfer_retry"); if (!failureReason || reason === "local_state_review") failureReason = reason; }
      }
      pendingDownloads = downloads.length;
      if (pendingDownloads) diagnostics = { ...diagnostics, status: "waiting", reasonCode: "transfer_pending", pendingDownloads };
      // Discover the complete revision immediately, but bound sensor work and
      // plaintext lifetime. Rotate failed entries so one problem cannot starve others.
      const selected = downloads.length ? Array.from({ length: Math.min(8, downloads.length) }, (_, offset) => downloads[(downloadCursor + offset) % downloads.length]) : [];
      downloadCursor = downloads.length ? (downloadCursor + selected.length) % downloads.length : 0;
      let models;
      try {
        if (fullCatalog && selected.length) {
          models = await client.batch(vaultId, pending.catalogRevision, selected.map(value => value.fingerprintId));
          if (models?.vaultId !== vaultId || models.catalogRevision !== pending.catalogRevision || !Array.isArray(models.templates) || models.templates.length !== selected.length || new Set(models.templates.map(value => value?.fingerprintId)).size !== selected.length || models.templates.some(value => !selected.some(item => item.fingerprintId === value?.fingerprintId))) throw new Error("Invalid fingerprint cloud batch");
        }
        for (const fingerprint of selected) {
          try {
            const result = fullCatalog ? models.templates.find(value => value.fingerprintId === fingerprint.fingerprintId) : await client.template(fingerprint.fingerprintId);
            if (result?.vaultId !== vaultId || result.fingerprintId !== fingerprint.fingerprintId || result.memberId !== fingerprint.memberId || result.rosterId !== fingerprint.rosterId || result.format !== "r503-model-1536" || typeof result.template !== "string" || result.template.length !== 2048) throw new Error("Invalid fingerprint cloud model");
            const template = Buffer.from(result.template, "base64");
            const canonical = template.toString("base64") === result.template; result.template = undefined;
            try {
              if (template.length !== 1536 || !canonical) throw new Error("Invalid fingerprint cloud model");
              const context = importContext(fingerprint.fingerprintId, fingerprint.memberId, fingerprint.rosterId);
              await importer.receive(context, template, digest(template)); received++; pendingDownloads--;
            } finally { template.fill(0); }
          } catch (error) { errors++; const reason = fingerprintFailureReason(error, "transfer_retry"); if (!failureReason || reason === "local_state_review") failureReason = reason; }
        }
      } catch (error) { errors++; failureReason = fingerprintFailureReason(error, "transfer_retry"); }
      finally { if (Array.isArray(models?.templates)) for (const model of models.templates) if (model && typeof model === "object") model.template = undefined; }
      cursor = !fullCatalog && pending.fingerprints.length === 8 ? previous : undefined;
      diagnostics = { ...diagnostics, status: errors || reviewMappings ? "needs_attention" : candidates.length > uploaded || pendingDownloads ? "waiting" : "ready", reasonCode: errors ? failureReason ?? "transfer_retry" : reviewMappings ? "mapping_review" : candidates.length > uploaded || pendingDownloads ? "transfer_pending" : "ready", uploaded, received, errors, pendingUploads: Math.max(0, candidates.length - uploaded), pendingDownloads, reviewRequired: errors + reviewMappings, retiredEnrollments: retired, locallyRemoved: records.filter(record => record.phase === "superseded").length, legacyMappings, missingIdentityMappings, unshareableMappings: legacyMappings, lastSuccessAt: errors ? diagnostics.lastSuccessAt : new Date(now()).toISOString() };
    } catch (error) { rosterUntil = 0; diagnostics = { ...diagnostics, status: "unavailable", reasonCode: fingerprintFailureReason(error, stage), errors: diagnostics.errors + 1 }; }
    return snapshot();
  }
  return {
    // Called under the sensor lock before the mapping is removed. This works
    // offline and before the first poll, and preserves all reader bytes.
    async suppressLocal(slot, mapping) {
      const root = join(directory, `${config.kioskId}-${config.pairingId}`);
      let generations;
      try { generations = await readdir(root, { withFileTypes: true }); }
      catch (error) { if (error?.code !== "ENOENT") throw error; generations = []; }
      const ids = new Set(generations.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && id(entry.name)).map(entry => entry.name));
      if (mapping.cloud) ids.add(mapping.cloud.vaultId);
      for (const generation of ids) {
        const local = createFingerprintJournal(join(root, generation, "received.json"), { installationId: generation, kioskId: config.kioskId, pairingId: config.pairingId }, { allowSuperseded: true });
        await local.suppressSlot(Number(slot), mapping.memberId);
        if (mapping.cloud?.vaultId === generation) {
          const transferId = digest(JSON.stringify(["LancerLogin vault import v1", generation, config.kioskId, config.pairingId, mapping.cloud.fingerprintId]));
          const existing = (await local.list()).find(record => record.transferId === transferId);
          await local.suppress({ installationId: generation, senderId: "cloud-vault", senderPairingId: generation, senderKeyId: generation,
            recipientId: config.kioskId, recipientPairingId: config.pairingId, memberId: mapping.memberId, enrollmentId: mapping.cloud.fingerprintId,
            transferId, revision: 1 }, existing?.slot ?? Number(slot));
        }
      }
    },
    invalidateAuthority() { rosterUntil = 0; },
    tick(metadata) { if (resetPaused) return Promise.resolve(snapshot()); if (!running) running = run(metadata).finally(() => { running = undefined; }); return running; },
    async stopForReset() { resetPaused = true; rosterUntil = 0; await running; diagnostics.status = "reset"; diagnostics.reasonCode = "reset_recovery"; },
    diagnostics: snapshot,
  };
}

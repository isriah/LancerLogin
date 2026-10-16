import { normalizeApiUrl } from "./cloud-client.mjs";

const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const memberId = value => typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const unavailable = () => { const error = new Error("Current kiosk poll metadata is unavailable"); error.reasonCode = "invalid_response"; return error; };

async function readBounded(response, maximum = 16 * 1024 * 1024) {
  const reader = response.body?.getReader(); if (!reader) throw unavailable();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) throw unavailable(); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

// Cache metadata only. Every reuse requires a successful current-authority poll;
// downloads, uploads and acknowledgements still use their protected endpoints.
export function createKioskPollClient(config, { fetchImpl = fetch, now = Date.now, maximumManifestPages = 128 } = {}) {
  const base = normalizeApiUrl(config.apiUrl);
  let roster, rosterRevision, vaultBinding, manifestPages = new Map(), running, generation = 0;
  function invalidate() { generation++; roster = undefined; rosterRevision = undefined; vaultBinding = undefined; manifestPages.clear(); }
  async function poll({ fingerprints = false, configuration = false, peerAfter } = {}) {
    const query = new URLSearchParams({ v: "1" });
    if (fingerprints) {
      query.set("fingerprints", "1");
      if (rosterRevision !== undefined) query.set("rosterRevision", String(rosterRevision));
      if (peerAfter !== undefined) { if (!identifier(peerAfter)) throw unavailable(); query.set("peerAfter", peerAfter); }
    }
    if (configuration) query.set("config", "1");
    const requestedAt = now(), requestGeneration = generation;
    try {
      const response = await fetchImpl(`${base}/kiosk/poll?${query}`, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${config.kioskToken}` } });
      if ([404, 405].includes(response.status)) { await response.body?.cancel(); invalidate(); return { unsupported: true }; }
      if (!response.ok) { await response.body?.cancel(); const error = unavailable(); error.status = response.status; error.reasonCode = [401, 403].includes(response.status) ? "authentication_failed" : "network_unavailable"; throw error; }
      const result = await readBounded(response);
      if (result?.protocol !== 1 || !Object.hasOwn(result, "command") || result.command !== null && (!identifier(result.command?.id) || !["reload_display", "reset_network_pin", "restart_service", "reboot", "install_latest"].includes(result.command.type))) throw unavailable();
      const output = { command: result.command };
      if (configuration) output.configuration = () => {
        if (!result.configuration?.settings || typeof result.configuration.settings !== "object" || !identifier(result.configuration.kiosk?.id) || typeof result.configuration.kiosk.name !== "string") throw unavailable();
        return structuredClone(result.configuration);
      };
      if (fingerprints) {
        const sections = result.fingerprints;
        let currentRoster;
        try {
          const value = sections?.roster;
          if (value?.status !== "ok" || !revision(value.revision) || typeof value.notModified !== "boolean") throw unavailable();
          if (value.notModified) { if (!roster || rosterRevision !== value.revision) throw unavailable(); }
          else {
            if (!Array.isArray(value.members) || value.members.length > 10000 || value.members.some(member => !memberId(member?.memberId) || !identifier(member.rosterId)) || new Set(value.members.map(member => member.memberId)).size !== value.members.length || new Set(value.members.map(member => member.rosterId)).size !== value.members.length) throw unavailable();
            roster = structuredClone(value.members); rosterRevision = value.revision;
          }
          currentRoster = { members: structuredClone(roster), freshUntil: requestedAt + 60000 };
        } catch { roster = undefined; rosterRevision = undefined; }
        const vault = sections?.vault;
        const validVault = vault?.status === "ok" && typeof vault.enabled === "boolean" && (!vault.enabled || hash(vault.vaultId) && vault.format === "r503-model-1536" && revision(vault.catalogRevision));
        const binding = validVault && vault.enabled ? `${vault.vaultId}:${vault.catalogRevision}` : undefined;
        if (binding !== vaultBinding || !binding) { manifestPages.clear(); vaultBinding = binding; }
        const fresh = () => { if (generation !== requestGeneration || now() >= requestedAt + 60000) throw unavailable(); };
        output.fingerprints = {
          reset: { commands: async () => { fresh(); const value = sections?.reset; if (value?.status !== "ok" || !Array.isArray(value.commands) || value.commands.length > 1 || value.commands.some(command => !identifier(command?.id) || command.kind !== "reset_fingerprint_mappings")) throw unavailable(); return { commands: structuredClone(value.commands) }; } },
          roster: async () => { fresh(); if (!currentRoster) throw unavailable(); return structuredClone(currentRoster); },
          peer: {
            configuration: async () => { fresh(); const value = sections?.peer; if (value?.status !== "ok" || typeof value.enabled !== "boolean" || value.enabled && !hash(value.syncId)) throw unavailable(); return { enabled: value.enabled, syncId: value.syncId ?? null }; },
            pending: async after => { fresh(); const value = sections?.peer; if (value?.status !== "ok" || value.enabled !== true || !hash(value.syncId) || after !== peerAfter || !Array.isArray(value.deliveries) || value.deliveries.length > 8) throw unavailable(); return { syncId: value.syncId, deliveries: structuredClone(value.deliveries) }; },
          },
          vault: {
            configuration: async () => { fresh(); if (!validVault) throw unavailable(); return structuredClone(vault); },
            list: async (after, read) => {
              fresh(); if (!binding || binding !== vaultBinding || !currentRoster) throw unavailable();
              const key = after ?? ""; if (key && !hash(key)) throw unavailable();
              if (manifestPages.has(key)) return structuredClone(manifestPages.get(key));
              try {
                const page = await read(after); fresh();
                if (binding !== vaultBinding || page?.vaultId !== vault.vaultId || !Array.isArray(page.fingerprints) || page.fingerprints.length > 8) throw unavailable();
                let previous = key;
                for (const item of page.fingerprints) { if (!hash(item?.fingerprintId) || item.fingerprintId <= previous || !memberId(item.memberId) || !identifier(item.rosterId)) throw unavailable(); previous = item.fingerprintId; }
                if (manifestPages.size >= maximumManifestPages) manifestPages.delete(manifestPages.keys().next().value);
                manifestPages.set(key, structuredClone(page)); return structuredClone(page);
              } catch (error) { manifestPages.clear(); throw error; }
            },
          },
        };
        if (sections?.reset?.commands?.length || sections?.reset?.status !== "ok") { manifestPages.clear(); vaultBinding = undefined; }
      }
      return output;
    } catch (error) { invalidate(); throw error; }
  }
  return { poll(options) { if (!running) running = poll(options).finally(() => { running = undefined; }); return running; }, invalidate };
}

// A slow fingerprint transfer never holds the five-second command transport.
// Failed requests do not advance due times or silently select legacy routes.
export function createKioskPollScheduler({ client, commands, configuration, fingerprints, legacy, fingerprintBusy = () => false, peerAfter = () => undefined, onError = () => {}, now = Date.now }) {
  let running, commandRunning, configurationRunning, fingerprintRunning;
  let legacyMode = false, nextFingerprint = 0, nextConfiguration = 0, configurationRetry = true;
  // Retain periodic phase across small timer jitter and off-grid manual syncs.
  // An early manual refresh never postpones the next scheduled authority check.
  const nextDeadline = (previous, started, interval) => previous === 0 ? started + interval
    : previous > started + 250 ? previous : previous + Math.max(1, Math.floor((started - previous) / interval) + 1) * interval;
  function applyCommands(operation) {
    if (!commandRunning) commandRunning = Promise.resolve().then(operation).catch(error => onError(error, "commands")).finally(() => { commandRunning = undefined; });
  }
  function applyConfiguration(operation, started) {
    if (!configurationRunning) {
      nextConfiguration = nextDeadline(nextConfiguration, started, 60000); configurationRetry = false;
      configurationRunning = Promise.resolve().then(operation).catch(error => { configurationRetry = true; onError(error, "configuration"); }).finally(() => { configurationRunning = undefined; });
    }
  }
  function applyFingerprints(operation, started) {
    nextFingerprint = nextDeadline(nextFingerprint, started, 15000);
    fingerprintRunning = Promise.resolve().then(operation).catch(error => onError(error, "fingerprints")).finally(() => { fingerprintRunning = undefined; });
  }
  async function run(forceFingerprints) {
    const started = now(), fingerprintDue = !fingerprintRunning && !fingerprintBusy() && (forceFingerprints || started + 250 >= nextFingerprint), configurationDue = !configurationRunning && (configurationRetry || started + 250 >= nextConfiguration);
    try {
      const result = legacyMode ? { unsupported: true } : await client.poll({ fingerprints: fingerprintDue, configuration: configurationDue, peerAfter: peerAfter() });
      if (result.unsupported) {
        legacyMode = true;
        applyCommands(legacy.commands);
        if (configurationDue) applyConfiguration(legacy.configuration, started);
        if (fingerprintDue) applyFingerprints(legacy.fingerprints, started);
        return;
      }
      applyCommands(() => commands(result.command));
      if (configurationDue) applyConfiguration(() => configuration(result.configuration()), started);
      if (fingerprintDue) applyFingerprints(() => fingerprints(result.fingerprints), started);
    } catch (error) { onError(error, "transport"); }
  }
  return {
    tick({ forceFingerprints = false } = {}) { if (!running) running = run(forceFingerprints).finally(() => { running = undefined; }); return running; },
    configurationSettled: () => configurationRunning,
    legacy: () => legacyMode,
  };
}

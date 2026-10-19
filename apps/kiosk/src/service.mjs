import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInstallationActivities, createUnpairingStore } from "./unpairing-store.mjs";
import { completeKioskCommand, fetchKioskCommand, fetchKioskConfiguration, fetchKioskRoster, pairInstallation, sendAttendance, sendHeartbeat } from "./cloud-client.mjs";
import { createKioskPollClient, createKioskPollScheduler } from "./kiosk-poll.mjs";
import { createFileQueue } from "./file-queue.mjs";
import { createMappingStore } from "./mapping-store.mjs";
import { enrollFingerprint } from "./fingerprint-enrollment.mjs";
import { EnrollmentError, verifyEnrollmentMember } from "./verified-enrollment.mjs";
import { createPairingCache } from "./pairing-cache.mjs";
import { createOperatorPresence } from "./operator-presence.mjs";
import { operatorPresenceApp } from "./operator-presence-ui.mjs";
import { createDesktopControl } from "./desktop-control.mjs";
import { fingerprintDiagnostic, fingerprintFailureReason } from "./fingerprint-diagnostics.mjs";
import { createCredentialStore } from "./credential-store.mjs";
import { createIdentityInput } from "./identity-input.mjs";
import { identityReadyState, identityUnknownState, normalizeIdentityMethod } from "./identity-methods.mjs";
import { resolveIdentityObservation } from "./identity-resolver.mjs";
import { createRosterCache } from "./roster-cache.mjs";
import { createFingerprintRosterReader } from "./fingerprint-roster.mjs";
import { decodePairingKey } from "./pairing-key.mjs";
import { createR503 } from "./r503.mjs";
import { createSerialExchange } from "./serial-transport.mjs";
import { createR503Transaction } from "./r503-transaction.mjs";
import { createR503TemplateTransfer } from "./r503-template-transfer.mjs";
import { createFingerprintCloudClient } from "./fingerprint-cloud-client.mjs";
import { createFingerprintSync } from "./fingerprint-sync.mjs";
import { createFingerprintVaultClient } from "./fingerprint-vault-client.mjs";
import { createFingerprintVault } from "./fingerprint-vault.mjs";
import { createFingerprintResetClient } from "./fingerprint-reset-client.mjs";
import { createFingerprintReset } from "./fingerprint-reset.mjs";
import { kioskState, kioskStates } from "./kiosk-states.mjs";
import { createIdentityScanner } from "./scanner.mjs";
import { createNetworkManager } from "./network-manager.mjs";
import { createNetworkPinStore } from "./network-pin.mjs";
import { networkApp, networkStyles } from "./network-ui.mjs";
import { maintenanceApp, maintenanceHtml, maintenanceLayoutStyles, maintenanceStyles } from "./maintenance-ui.mjs";
import { recoveryApp } from "./recovery-ui.mjs";
import { attendanceReviewApp, attendanceReviewHtml, attendanceReviewStyles } from "./attendance-review.mjs";
import { kioskScrollbarStyles, maintenanceScrollbarStyles } from "./scrollbar-styles.mjs";
import { startVerifiedKioskUpdate, prepareVerifiedKioskUpdate, kioskUpdatePolicyVersion } from "./update-command.mjs";
import { kioskApp, kioskHtml, kioskIdentityStyles, kioskStatusStyles, kioskStyles } from "./ui.mjs";

export function localReleaseVersion(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^(?:development|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(normalized) ? normalized : "development";
}

const port = Number(process.env.LANCERLOGIN_KIOSK_PORT ?? 8788);
const configPath = process.env.LANCERLOGIN_CONFIG ?? "/var/lib/lancerlogin/pairing.json";
const brandingPath = process.env.LANCERLOGIN_BRANDING ?? "/var/lib/lancerlogin/branding.json";
const networkPinPath = process.env.LANCERLOGIN_NETWORK_PIN ?? "/var/lib/lancerlogin/network-pin.json";
const authenticationPath = process.env.LANCERLOGIN_AUTHENTICATION ?? "/var/lib/lancerlogin/authentication.json";
const credentialPath = process.env.LANCERLOGIN_CREDENTIAL_MAPPINGS ?? "/var/lib/lancerlogin/credential-mappings.json";
const rosterPath = process.env.LANCERLOGIN_ROSTER_CACHE ?? "/var/lib/lancerlogin/roster-cache.json";
const queue = createFileQueue(process.env.LANCERLOGIN_QUEUE ?? "/var/lib/lancerlogin/attendance-queue.json");
const mappings = createMappingStore(process.env.LANCERLOGIN_MAPPINGS ?? "/var/lib/lancerlogin/slot-mappings.json");
const credentials = createCredentialStore(credentialPath); const rosterCache = createRosterCache(rosterPath); const identityInput = createIdentityInput();
const network = createNetworkManager(); const networkPin = createNetworkPinStore(networkPinPath);
const desktopControl = createDesktopControl();
const sensor = process.env.LANCERLOGIN_SENSOR_PATH === "disabled" ? undefined : createR503(createSerialExchange(process.env.LANCERLOGIN_SENSOR_PATH ?? "/dev/serial0"));
const serviceStartedAt = Date.now();
const releaseVersion = localReleaseVersion(process.env.LANCERLOGIN_VERSION);
const installationActivities = createInstallationActivities();
const unpairingStore = createUnpairingStore(dirname(configPath), { pinPath: networkPinPath, statePaths: [
  configPath, brandingPath, authenticationPath, credentialPath, rosterPath,
  process.env.LANCERLOGIN_QUEUE ?? "/var/lib/lancerlogin/attendance-queue.json",
  process.env.LANCERLOGIN_MAPPINGS ?? "/var/lib/lancerlogin/slot-mappings.json",
  ...["SYNC", "VAULT", "RESET", "REVIEW"].map(kind => process.env[`LANCERLOGIN_FINGERPRINT_${kind}`] ?? join(dirname(configPath), `fingerprint-${kind.toLowerCase()}`)),
] });
let unpairingBusy = false, pairingRecovery = false, enrollmentInProgress = false, commandActionPending = false, attendanceInputGeneration = 0;
const pairingBoundary = unpairingStore.inspect().then(status => {
  pairingRecovery = status.recoveryPending;
  if (pairingRecovery) installationActivities.pause();
}).catch(() => { pairingRecovery = true; installationActivities.pause(); });
let state = { paired: false, readerOnline: false, cloudOnline: false, networkType: undefined, kioskName: undefined, lastSyncAt: undefined, lastWifiScanAt: undefined, errorCategory: undefined };
let branding = { organizationName: "LancerLogin", subtitle: "", logoData: "", primaryColor: "#7c3aed", secondaryColor: "#0f766e", logoBackdrop: "auto" };
let authenticationMethod = "fingerprint";
let rosterCachedAt = 0;
let sensorOperation = Promise.resolve();
let display = kioskState("unpaired"); let displayTimer; let displayReloadToken = 0; let commandPolling = false;
let fingerRemovalRequired = true, removalGeneration = 0, removalCheck;
const directAttendanceCommits = new Set();
const pairingCache = createPairingCache({
  read: async () => { try { return JSON.parse(await readFile(configPath, "utf8")); } catch { return undefined; } },
  write: async config => { const temporary = `${configPath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, configPath); await chmod(configPath, 0o600); },
  onValue: config => { if (config) { const newlyPaired = !state.paired; state = { ...state, paired: true, kioskName: config.kioskName }; if (newlyPaired) display = readyDisplay(); } },
});

function readyDisplay() { return kioskState("ready", identityReadyState(authenticationMethod)); }
function unavailableDisplay() { return authenticationMethod === "fingerprint" ? kioskState("reader_offline") : kioskState("reader_offline", { message: "Input unavailable", detail: `${authenticationMethod === "member_id" ? "Member ID" : authenticationMethod.toUpperCase()} input is not responding` }); }
function currentDisplay() {
  if (display.id.startsWith("enroll_")) return display;
  if (operatorPresence.status().captureSuspended) return kioskState("operator_paused");
  if (fingerRemovalRequired && authenticationMethod === "fingerprint") return kioskState("finger_removal");
  return display;
}
async function loadAuthenticationMethod() { try { authenticationMethod = normalizeIdentityMethod(JSON.parse(await readFile(authenticationPath, "utf8")).authenticationMethod); } catch { authenticationMethod = "fingerprint"; } return authenticationMethod; }
async function saveAuthenticationMethod(value) { const next = normalizeIdentityMethod(value); if (next === authenticationMethod) return; attendanceInputGeneration++; await mkdir(dirname(authenticationPath), { recursive: true, mode: 0o700 }); const temporary = `${authenticationPath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify({ authenticationMethod: next })}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, authenticationPath); await chmod(authenticationPath, 0o600); authenticationMethod = next; identityInput.clear(); if (next === "fingerprint") { requireFingerRemoval(); } state.readerOnline = next === "fingerprint" ? false : true; display = readyDisplay(); }
async function loadPairing() { await pairingBoundary; if (unpairingBusy || pairingRecovery) return undefined; return pairingCache.load(); }
async function savePairing(config) { return pairingCache.save(config); }
async function saveKioskName(config, name) {
  if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return;
  return pairingCache.update(current => current?.pairingId === config.pairingId && current?.kioskId === config.kioskId && current.kioskName !== name
    ? { ...current, kioskName: name } : current);
}
async function loadBranding() { try { branding = { ...branding, ...JSON.parse(await readFile(brandingPath, "utf8")) }; } catch { /* Defaults remain available before the first cloud sync. */ } }
async function saveBranding(value) { const safe = { organizationName: String(value?.organizationName || "LancerLogin").slice(0, 100), subtitle: String(value?.subtitle || "").slice(0, 140), logoData: typeof value?.logoData === "string" ? value.logoData : "", primaryColor: /^#[0-9a-f]{6}$/i.test(value?.primaryColor) ? value.primaryColor : "#7c3aed", secondaryColor: /^#[0-9a-f]{6}$/i.test(value?.secondaryColor) ? value.secondaryColor : "#0f766e", logoBackdrop: ["auto", "light", "dark", "none"].includes(value?.logoBackdrop) ? value.logoBackdrop : "auto" }; const temporary = `${brandingPath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(safe)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, brandingPath); await chmod(brandingPath, 0o600); branding = safe; }
let attendanceFlush;
function flushAttendance(config) {
  if (!attendanceFlush) attendanceFlush = (async () => {
    const acknowledgements = [];
    const delivered = await queue.flush(async (event) => {
      const result = await sendAttendance(config, event, { fetchImpl: boundedCloudFetch });
      acknowledgements.push({ eventId: event.eventId, ...result });
      return result;
    });
    if ((await queue.pending()).length) throw new Error("Cloud attendance sync is unavailable");
    return { delivered, acknowledgements };
  })().finally(() => { attendanceFlush = undefined; });
  return attendanceFlush;
}
async function useSensor(operation) { const current = sensorOperation.then(operation, operation); sensorOperation = current.then(() => undefined, () => undefined); return current; }
let fingerprintSync, fingerprintVault, fingerprintReset, fingerprintPairing, fingerprintResetEpoch = null, fingerprintPolling, fingerprintRoster;
function fetchFingerprintRoster(config) {
  if (!fingerprintRoster || ["apiUrl", "kioskId", "pairingId", "kioskToken"].some(key => fingerprintRoster.config[key] !== config[key])) {
    fingerprintRoster = { config: { ...config }, reader: createFingerprintRosterReader(config) };
  }
  return fingerprintRoster.reader.read();
}
const fingerprintFailures = {};
let readerObserved = false;
function recordFingerprintFailure(component, error, fallback) {
  fingerprintFailures[component] = { status: "unavailable", reasonCode: fingerprintFailureReason(error, fallback), lastAttemptAt: new Date().toISOString() };
}
async function fingerprintDiagnostics() {
  const paired = Boolean((await loadPairing())?.pairingId);
  const reset = fingerprintDiagnostic("reset", !paired ? { status: "unavailable", reasonCode: "unpaired" } : fingerprintFailures.reset ?? fingerprintReset?.diagnostics());
  const components = { vault: fingerprintVault };
  return { reset, ...Object.fromEntries(Object.entries(components).map(([component, controller]) => {
    const value = !paired ? { status: "unavailable", reasonCode: "unpaired" }
      : reset.state === "blocked" ? { ...controller?.diagnostics(), status: "unavailable", state: "blocked", reasonCode: "reset_recovery" }
        : !sensor || readerObserved && !state.readerOnline ? { ...controller?.diagnostics(), status: "unavailable", state: "unavailable", reasonCode: "reader_unavailable" }
          : fingerprintFailures[component] ?? controller?.diagnostics();
    return [component, fingerprintDiagnostic(component, value)];
  })) };
}
async function resetController() {
  const config = await loadPairing(); if (!config?.pairingId) throw new Error("Pair this kiosk first");
  if (!fingerprintReset) fingerprintReset = createFingerprintReset({
    directory: process.env.LANCERLOGIN_FINGERPRINT_RESET ?? `${dirname(configPath)}/fingerprint-reset`,
    legacyDirectory: process.env.LANCERLOGIN_FINGERPRINT_REVIEW ?? `${dirname(configPath)}/fingerprint-review`, config,
    client: createFingerprintResetClient(config), mappings, withSensor: useSensor,
    stopTransfers: async localResetEpoch => {
      // Initialize local peer-state recovery too, even when sharing is off or
      // the reader is disconnected. Disabling local keys needs no reader I/O.
      if (!fingerprintSync) fingerprintSync = createFingerprintSync({
        directory: `${process.env.LANCERLOGIN_FINGERPRINT_SYNC ?? `${dirname(configPath)}/fingerprint-sync`}${localResetEpoch ? `/after-reset-${localResetEpoch}` : ""}`,
        config, client: createFingerprintCloudClient(config), sensor, mappings, withSensor: useSensor,
      });
      await fingerprintSync.stopForReset(); await fingerprintVault?.stopForReset();
    },
  });
  return fingerprintReset;
}
async function synchronizeResetEpoch(epoch) {
  if (epoch !== fingerprintResetEpoch) {
    await fingerprintSync?.stopForReset(); await fingerprintVault?.stopForReset();
    fingerprintResetEpoch = epoch; fingerprintSync = undefined; fingerprintVault = undefined;
  }
}
async function restoreResetBoundary() {
  const reset = await resetController();
  // Fresh-process local settings must use the durable new namespace before
  // network polling can run. An unfinished clear blocks local sharing too.
  await synchronizeResetEpoch(await reset.resetEpoch());
  if (!await reset.enrollmentAllowed()) throw new Error("Finish fingerprint mapping reset recovery before changing sharing settings.");
}
async function vaultController() {
  const config = await loadPairing();
  if (!config?.pairingId || !sensor) throw new Error("Pair this kiosk and connect its fingerprint reader first");
  await restoreResetBoundary();
  const binding = `${config.kioskId}:${config.pairingId}`;
  if (fingerprintPairing && fingerprintPairing !== binding) throw new Error("Kiosk pairing changed; restart and review fingerprint sync");
  if (!fingerprintVault) {
    fingerprintPairing = binding;
    fingerprintVault = createFingerprintVault({
      directory: process.env.LANCERLOGIN_FINGERPRINT_VAULT ?? `${dirname(configPath)}/fingerprint-vault`, config,
      client: createFingerprintVaultClient(config), sensor, mappings, withSensor: useSensor,
      templates: createR503TemplateTransfer(createR503Transaction(process.env.LANCERLOGIN_SENSOR_PATH ?? "/dev/serial0")),
      fetchRoster: () => fetchFingerprintRoster(config),
    });
  }
  return fingerprintVault;
}
function pollFingerprintSync() { return pollCloud({ forceFingerprints: true }); }
async function pollFingerprintSyncNow(metadata) {
  if (!fingerprintPolling) fingerprintPolling = (async () => {
    // Reset commands are checked on every paired reconnect, independently of
    // both opt-in settings and the currently selected authentication method.
    let reset;
    try { reset = await (await resetController()).tick(metadata?.reset); delete fingerprintFailures.reset; } catch (error) { recordFingerprintFailure("reset", error, "local_state_review"); return; }
    await synchronizeResetEpoch(reset.resetEpoch);
    if (reset.blocked || authenticationMethod !== "fingerprint" || !sensor) return;
    try { await (await vaultController()).tick(metadata ? { ...metadata.vault, roster: metadata.roster } : undefined); delete fingerprintFailures.vault; } catch (error) { recordFingerprintFailure("vault", error, "local_state_review"); }
  })().finally(() => { fingerprintRoster?.reader.endRound(); fingerprintPolling = undefined; });
  return fingerprintPolling;
}
async function assertFingerprintMutationAllowed() {
  if ((await loadPairing())?.pairingId && !await (await resetController()).enrollmentAllowed()) throw new Error("Finish fingerprint mapping reset recovery before editing or enrolling. Existing reader templates are unchanged.");
}
async function testSensor() { readerObserved = true; if (!sensor) { state.readerOnline = false; return { readerOnline: false, templateCount: 0 }; } try { const status = await useSensor(() => sensor.status()); state.readerOnline = status.connected; return { readerOnline: status.connected, templateCount: status.templateCount }; } catch { state.readerOnline = false; return { readerOnline: false, templateCount: 0 }; } }
async function testAuthenticator() { if (authenticationMethod === "fingerprint") return testSensor(); state.readerOnline = true; return { readerOnline: true, authenticationMethod }; }
let heartbeatRunning;
function heartbeat() {
  if (!heartbeatRunning) heartbeatRunning = installationActivities.run(heartbeatNow).catch(() => undefined).finally(() => { heartbeatRunning = undefined; });
  return heartbeatRunning;
}
const boundedCloudFetch = (url, options) => fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(8000) });
async function applyRemoteConfiguration(config, remote) {
  const previousMethod = authenticationMethod;
  if (remote.settings) { await saveBranding(remote.settings); await saveAuthenticationMethod(remote.settings.authenticationMethod); }
  await testAuthenticator();
  if (authenticationMethod !== "fingerprint" && (authenticationMethod !== previousMethod || Date.now() - rosterCachedAt >= 5 * 60_000)) {
    rosterCachedAt = Date.now();
    try { const roster = await fetchKioskRoster(config, { fetchImpl: boundedCloudFetch }); await rosterCache.replace(roster.members ?? []); }
    catch { /* Retain the owner-only cache until the bounded next refresh. */ }
  }
  if (remote.kiosk?.name) await saveKioskName(config, remote.kiosk.name);
}
async function heartbeatNow() {
  const config = await loadPairing(); if (!config) return;
  let networkDiagnostics = { type: "offline", signal: null };
  try { networkDiagnostics = await network.diagnostics(); state.networkType = networkDiagnostics.type; } catch { state.networkType = undefined; }
  try {
    await flushAttendance(config); state.lastSyncAt = new Date().toISOString(); state.errorCategory = undefined;
    await testAuthenticator();
    await sendHeartbeat(config, { fetchImpl: boundedCloudFetch, readerOnline: state.readerOnline, authenticationMethod, releaseVersion, updatePolicyVersion: await kioskUpdatePolicyVersion(), uptimeSeconds: Math.floor((Date.now() - serviceStartedAt) / 1_000), networkType: networkDiagnostics.type, networkSignal: networkDiagnostics.signal, lastWifiScanAt: state.lastWifiScanAt ?? null, pendingEvents: (await queue.pending()).length, lastSyncAt: state.lastSyncAt, errorCategory: null }); state.cloudOnline = true;
  } catch { state.cloudOnline = false; state.errorCategory = "cloud_sync"; }
}
let cloudPolling;
async function pollCloud(options) {
  return installationActivities.run(async () => {
    const config = await loadPairing(); if (!config) return;
    if (!cloudPolling || ["apiUrl", "kioskId", "pairingId", "kioskToken"].some(key => cloudPolling.config[key] !== config[key])) {
      cloudPolling?.client.invalidate();
      const client = createKioskPollClient(config);
      const scheduler = createKioskPollScheduler({ client,
        commands: command => installationActivities.run(() => pollCommandsNow(command, config)),
        configuration: remote => installationActivities.run(() => applyRemoteConfiguration(config, remote)),
        fingerprints: metadata => installationActivities.run(() => pollFingerprintSyncNow(metadata)),
        fingerprintBusy: () => Boolean(fingerprintPolling),
        legacy: { commands: () => installationActivities.run(() => pollCommandsNow(undefined, config)), configuration: () => installationActivities.run(async () => applyRemoteConfiguration(config, await fetchKioskConfiguration(config, { fetchImpl: boundedCloudFetch }))), fingerprints: () => installationActivities.run(() => pollFingerprintSyncNow()) },
        onError: (error, section) => { if (section === "transport" || section === "fingerprints") { fingerprintSync?.invalidateAuthority(); fingerprintVault?.invalidateAuthority(); recordFingerprintFailure("reset", error, "network_unavailable"); } },
      });
      cloudPolling = { config: { ...config }, client, scheduler };
    }
    return cloudPolling.scheduler.tick(options);
  }).catch(() => undefined);
}
async function runKioskCommand(command, config) {
  if (command.type === "reload_display") { displayReloadToken += 1; return { message: "Display reload requested" }; }
  if (command.type === "reset_network_pin") { await networkPin.reset(); return { message: "Local settings PIN reset" }; }
  if (command.type === "restart_service") return { message: "Service restart requested", afterComplete: () => setTimeout(() => process.exit(1), 250).unref() };
  if (command.type === "reboot") return { message: "Device reboot requested", afterComplete: () => setTimeout(() => { const child = spawn("/usr/bin/systemctl", ["reboot"], { detached: true, stdio: "ignore" }); child.unref(); }, 250).unref() };
  if (command.type === "install_latest") {
    await prepareVerifiedKioskUpdate(command);
    return { message: "Verified kiosk update started", afterComplete: () => setTimeout(() => startVerifiedKioskUpdate({ onFailure: (message) => completeKioskCommand(config, command.id, { success: false, message }) }), 250).unref() };
  }
  throw new Error("Unsupported kiosk command");
}
async function pollCommandsNow(suppliedCommand, expectedConfig) {
  if (commandPolling) return; commandPolling = true;
  try {
    const config = await loadPairing(); if (!config || expectedConfig && ["apiUrl", "kioskId", "pairingId", "kioskToken"].some(key => expectedConfig[key] !== config[key])) return;
    const command = suppliedCommand === undefined ? (await fetchKioskCommand(config, { fetchImpl: boundedCloudFetch })).command : suppliedCommand; if (!command) return;
    try { const result = await runKioskCommand(command, config); await completeKioskCommand(config, command.id, { success: true, message: result.message }, { fetchImpl: boundedCloudFetch }); if (result.afterComplete) { commandActionPending = true; result.afterComplete(); } }
    catch (error) { await completeKioskCommand(config, command.id, { success: false, message: error instanceof Error ? error.message : "Command failed" }, { fetchImpl: boundedCloudFetch }); }
  } catch { /* The heartbeat reports cloud connectivity separately. */ }
  finally { commandPolling = false; }
}
async function showDisplay(id, overrides = {}) { if (displayTimer) clearTimeout(displayTimer); display = kioskState(id, overrides); const duration = kioskStates[id]?.durationMs; if (duration) displayTimer = setTimeout(() => { display = state.readerOnline ? readyDisplay() : unavailableDisplay(); void setFeedback(display.id); }, duration); }
async function setFeedback(id) { const definition = kioskStates[id]; if (authenticationMethod === "fingerprint" && sensor && definition?.led) await useSensor(() => sensor.led(definition.led)); }
async function captureIdentity() {
  if (authenticationMethod !== "fingerprint") return identityInput.next();
  const observation = sensor ? await useSensor(() => sensor.scan()) : await Promise.reject(new Error("Reader disabled"));
  if (!observation || observation.status === "no_finger") return { status: "idle" };
  if (observation.status === "not_found") return { status: "unknown", ...identityUnknownState("fingerprint") };
  if (observation.status !== "match") return { status: "idle" };
  const memberId = await mappings.memberForSlot(observation.slot);
  if (!memberId) return { status: "unknown", detail: "This fingerprint is not linked to an active roster member" };
  return { status: "identified", memberId, identityKey: `fingerprint:${observation.slot}` };
}
const scanner = createIdentityScanner({ captureIdentity, captureAllowed: () => !operatorPresence.status().captureSuspended && !fingerRemovalRequired, setFeedback, queue, loadPairing, flushAttendance, onDisplay: showDisplay, onInput: (online) => { readerObserved = true; state.readerOnline = online; }, onCloud: (online) => { state.cloudOnline = online; if (online) { state.lastSyncAt = new Date().toISOString(); state.errorCategory = undefined; } else state.errorCategory = "cloud_sync"; } });
const operatorPresence = createOperatorPresence({ onSuspend: () => { attendanceInputGeneration++; identityInput.clear(); requireFingerRemoval(); void scanner.suspend("operator"); } });
void scanner.suspend("operator");
void scanner.suspend("finger_removal");
let captureWasAllowed = false;
function requireFingerRemoval() { fingerRemovalRequired = true; removalGeneration++; void scanner.suspend("finger_removal"); }
function attendanceAllowed() { return !operatorPresence.status().captureSuspended && !enrollmentInProgress && !unpairingBusy && !pairingRecovery; }
async function refreshCapturePermission() {
  // Unpairing owns graceful drainage; do not cancel its accepted in-flight scan.
  if (unpairingBusy) return;
  const allowed = attendanceAllowed();
  if (!allowed) { captureWasAllowed = false; await scanner.suspend("operator"); return; }
  if (!captureWasAllowed && authenticationMethod === "fingerprint") { requireFingerRemoval(); }
  captureWasAllowed = true;
  if (authenticationMethod !== "fingerprint") { fingerRemovalRequired = false; scanner.release("finger_removal"); }
  scanner.release("operator");
}
async function checkFingerRemoval() {
  if (!fingerRemovalRequired || !sensor || authenticationMethod !== "fingerprint" || enrollmentInProgress || unpairingBusy || pairingRecovery || removalCheck) return;
  const epoch = removalGeneration;
  removalCheck = useSensor(async () => {
    if (!await sensor.fingerPresent() && epoch === removalGeneration) { fingerRemovalRequired = false; scanner.release("finger_removal"); }
  }).catch(() => { state.readerOnline = false; }).finally(() => { removalCheck = undefined; });
  await removalCheck;
}
async function body(request, limit = 65_536) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error("Request body is too large"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function trusted(request) { const origin = request.headers.origin; const host = request.headers.host; return !origin || Boolean(host && origin === `http://${host}`); }
function localRequest(request) { const address = request.socket.remoteAddress ?? ""; return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"; }
async function requireNetworkSession() { const access = await networkPin.status(); if (!access.authorized) throw new Error("Unlock network settings first"); }

async function handleRequest(request, response) {
  const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  if (!trusted(request)) { response.statusCode = 403; response.end(JSON.stringify({ error: "Untrusted local origin" })); return; }
  if (!localRequest(request) && !["/", "/styles.css", "/app.js", "/network.css", "/network.js", "/operator-presence.js", "/recovery.js", "/health", "/pair"].includes(pathname)) { response.setHeader("content-type", "application/json; charset=utf-8"); response.statusCode = 403; response.end(JSON.stringify({ error: "Attendance and reader controls are available only on the kiosk" })); return; }
  await pairingBoundary;
  const changing = unpairingBusy || pairingRecovery;
  const transitionRoutes = ["/", "/health", "/display-state", "/maintenance", "/maintenance/session", "/maintenance/pairing", "/maintenance/unpair", "/network/unlock", "/network/session", "/operator-presence"];
  if (changing && !transitionRoutes.includes(pathname) && !/\.(?:css|js)$/.test(pathname)) {
    response.statusCode = 409; response.end(JSON.stringify({ error: "Kiosk pairing is changing. Unlock maintenance and finish unpairing before continuing." })); return;
  }
  if (pathname === "/" && request.method === "GET") { response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); response.end(kioskHtml); return; }
  if (pathname === "/styles.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(kioskStyles + kioskStatusStyles + kioskIdentityStyles + kioskScrollbarStyles); return; }
  if (pathname === "/app.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(kioskApp); return; }
  if (pathname === "/network.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(networkStyles); return; }
  if (pathname === "/operator-presence.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(operatorPresenceApp); return; }
  if (pathname === "/network.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(networkApp); return; }
  if (pathname === "/recovery.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(recoveryApp); return; }
  if (pathname === "/maintenance" && request.method === "GET") { response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); response.end(maintenanceHtml); return; }
  if (pathname === "/maintenance.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(maintenanceStyles + maintenanceLayoutStyles + maintenanceScrollbarStyles); return; }
  if (pathname === "/maintenance.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(maintenanceApp); return; }
  if (pathname === "/attendance-review" && request.method === "GET") { response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"); response.end(attendanceReviewHtml); return; }
  if (pathname === "/attendance-review.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(attendanceReviewStyles + maintenanceScrollbarStyles); return; }
  if (pathname === "/attendance-review.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(attendanceReviewApp); return; }
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (pathname.startsWith("/desktop/launcher/") && request.method === "POST") {
    // The desktop launcher is a local process, never a browser control surface.
    if (request.headers.origin !== undefined) { response.statusCode = 403; response.end(JSON.stringify({ error: "Launcher registration is local-process only" })); return; }
    const operation = { register: "register", poll: "poll", ack: "acknowledge", detach: "detach" }[pathname.slice("/desktop/launcher/".length)];
    if (!operation) { response.statusCode = 404; response.end(JSON.stringify({ error: "Unknown launcher action" })); return; }
    try { response.end(JSON.stringify(desktopControl[operation](await body(request, 1024), request.headers["x-lancerlogin-launcher"]))); }
    catch (error) { response.statusCode = [400, 404, 409, 410].includes(error?.status) ? error.status : 400; response.end(JSON.stringify({ error: "Kiosk launcher session unavailable", code: error?.code ?? "invalid_launcher_request" })); }
    return;
  }
  if (pathname === "/maintenance/desktop/exit" && request.method === "POST") {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock local maintenance before exiting to desktop" })); return; }
    try {
      const input = await body(request, 1024);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) { response.statusCode = 400; response.end(JSON.stringify({ error: "Desktop exit accepts no arguments" })); return; }
      const result = await desktopControl.requestExit(async () => {
        operatorPresence.suspend();
        await refreshCapturePermission();
        await Promise.all([scanner.suspend("operator"), ...directAttendanceCommits]);
      });
      response.end(JSON.stringify(result));
    } catch { response.statusCode = 503; response.end(JSON.stringify({ error: "Desktop exit is unavailable. Reopen the kiosk using its installed desktop shortcut." })); }
    return;
  }
  if (pathname === "/operator-presence" && request.method === "POST") {
    try {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("JSON required");
      const input = await body(request, 1024);
      const result = operatorPresence.update(input);
      await refreshCapturePermission();
      if (result.captureSuspended) await Promise.all([scanner.suspend("operator"), ...directAttendanceCommits]);
      response.end(JSON.stringify(result));
    } catch { response.statusCode = 409; response.end(JSON.stringify({ error: "Kiosk page session unavailable. Close unused pages, then retry attendance." })); }
    return;
  }
  if (pathname === "/health" && request.method === "GET") { await loadPairing(); const attendance = changing ? undefined : await queue.diagnostics(); response.end(JSON.stringify({ ok: true, service: "lancerlogin-kiosk", ...state, ...(changing ? { paired: false, kioskName: undefined, cloudOnline: false } : {}), setupReady: !changing, authenticationMethod, pendingEvents: attendance?.pending, attendance, fingerprintSync: changing ? undefined : await fingerprintDiagnostics() })); return; }
  if (pathname === "/display-state" && request.method === "GET") { const attendance = changing ? undefined : await queue.diagnostics(); response.end(JSON.stringify({ display: changing ? kioskState("unpaired", { message: "Finish unpairing", detail: "Open local maintenance to complete the installation switch." }) : currentDisplay(), branding, kioskName: changing ? undefined : state.kioskName, readerOnline: state.readerOnline, authenticationMethod, cloudOnline: changing ? false : state.cloudOnline, networkType: state.networkType, pendingEvents: attendance?.pending, attendance, uptimeSeconds: Math.floor((Date.now() - serviceStartedAt) / 1000), releaseVersion, displayReloadToken })); return; }
  if (pathname === "/maintenance/pairing" && request.method === "GET") {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock local settings before unpairing" })); return; }
    const config = await loadPairing();
    let installation; try { installation = config ? new URL(config.apiUrl).origin : undefined; } catch { /* A damaged pairing can still be archived locally. */ }
    response.end(JSON.stringify({ paired: Boolean(config), kioskName: config?.kioskName, installation, pendingEvents: changing ? null : (await queue.pending()).length, recoveryPending: pairingRecovery, busy: unpairingBusy })); return;
  }
  if (pathname === "/maintenance/unpair" && request.method === "POST") {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock local settings before unpairing" })); return; }
    let input;
    try { input = await body(request); } catch { response.statusCode = 400; response.end(JSON.stringify({ error: "Confirm unpairing before continuing" })); return; }
    if (input.confirmation !== "UNPAIR") { response.statusCode = 400; response.end(JSON.stringify({ error: "Confirm unpairing before continuing" })); return; }
    if (unpairingBusy || enrollmentInProgress || commandActionPending) { response.statusCode = 409; response.end(JSON.stringify({ error: "Kiosk is busy. Finish the current operation, then try unpairing again." })); return; }
    if (!pairingRecovery && !await loadPairing()) { response.statusCode = 409; response.end(JSON.stringify({ error: "This kiosk is already unpaired" })); return; }
    // Loading pairing state yields. Recheck immediately before taking ownership
    // so two confirmed requests cannot start overlapping archive transactions.
    if (unpairingBusy || enrollmentInProgress || commandActionPending) { response.statusCode = 409; response.end(JSON.stringify({ error: "Kiosk is busy. Try unpairing again after the current operation finishes." })); return; }
    unpairingBusy = true; installationActivities.pause(); scanner.pause();
    let timer;
    try {
      await Promise.race([Promise.all([scanner.pauseAndDrain(), installationActivities.drain(), attendanceFlush, sensorOperation]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Kiosk is busy. Finish the current operation, then try unpairing again.")), 20000); })]);
      await requireNetworkSession();
      if (commandActionPending) throw new Error("Kiosk is restarting or updating. Try again afterward.");
      if (!pairingRecovery && (await queue.pending()).length) throw new Error("Saved attendance scans are still pending. Reconnect and sync them before unpairing.");
      const result = await unpairingStore.unpair();
      pairingRecovery = true; cloudPolling?.client.invalidate(); cloudPolling = undefined; pairingCache.invalidate(); networkPin.close(); identityInput.clear(); clearTimeout(displayTimer);
      state = { ...state, paired: false, kioskName: undefined, cloudOnline: false }; display = kioskState("unpaired");
      response.end(JSON.stringify({ ...result, restart: true }));
      // A fresh process is required so no cached roster, queue, mapping or key
      // object can be reused by the next installation. systemd restarts on failure.
      setTimeout(() => process.exit(1), 250).unref();
    } catch (error) {
      try { pairingRecovery = (await unpairingStore.inspect()).recoveryPending; } catch { pairingRecovery = true; }
      if (!pairingRecovery) { installationActivities.resume(); scanner.resume(); }
      response.statusCode = 409; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unpairing could not finish", recoveryPending: pairingRecovery }));
    } finally { clearTimeout(timer); unpairingBusy = false; }
    return;
  }
  if (pathname === "/attendance/rejections" && request.method === "GET") {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock local settings before reviewing scans" })); return; }
    try { response.end(JSON.stringify({ rejections: await queue.rejections() })); }
    catch { response.statusCode = 500; response.end(JSON.stringify({ error: "Saved scan outcomes are unavailable" })); }
    return;
  }
  if (pathname.startsWith("/attendance/rejections/") && pathname.endsWith("/review") && request.method === "POST") {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock local settings before reviewing scans" })); return; }
    let eventId;
    try { eventId = decodeURIComponent(pathname.slice("/attendance/rejections/".length, -"/review".length)); }
    catch { response.statusCode = 400; response.end(JSON.stringify({ error: "Invalid event ID" })); return; }
    if (!eventId || eventId.length > 100) { response.statusCode = 400; response.end(JSON.stringify({ error: "Invalid event ID" })); return; }
    try { const reviewed = await queue.markReviewed(eventId); response.statusCode = reviewed ? 200 : 404; response.end(JSON.stringify({ reviewed })); }
    catch { response.statusCode = 500; response.end(JSON.stringify({ error: "Scan review could not be saved" })); }
    return;
  }
  if (pathname === "/pair" && request.method === "POST") { try { if (await loadPairing()) throw new Error("This kiosk is already paired"); const input = await body(request); const pairing = decodePairingKey(input.pairingKey); const config = await pairInstallation(pairing); await savePairing(config); response.statusCode = 201; response.end(JSON.stringify({ paired: true, kioskName: config.kioskName })); void pollCloud().then(() => cloudPolling?.scheduler.configurationSettled()).then(heartbeat); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Pairing failed" })); } return; }
  if (pathname === "/identity" && request.method === "POST") {
    const inputGeneration = attendanceInputGeneration;
    try {
      if (!await loadPairing()) throw new Error("Pair this kiosk before submitting an identity");
      const input = await body(request); const requestedMethod = normalizeIdentityMethod(input.method);
      if (requestedMethod !== authenticationMethod || authenticationMethod === "fingerprint") throw new Error("Use the authentication method selected by the Administrator");
      if (!attendanceAllowed()) throw new Error("Return to attendance before submitting an identity");
      const observation = await resolveIdentityObservation({ method: authenticationMethod, input, credentials, rosterCache });
      if (!attendanceAllowed() || inputGeneration !== attendanceInputGeneration || requestedMethod !== authenticationMethod) throw new Error("Attendance mode changed. Return to attendance and scan again.");
      if (!identityInput.submit(observation)) { response.statusCode = 429; response.end(JSON.stringify({ error: "Wait for the current identity check to finish" })); return; }
      response.statusCode = 202; response.end(JSON.stringify({ accepted: true }));
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Identity input was not accepted" })); }
    return;
  }
  if (pathname === "/attendance" && request.method === "POST") {
    const inputGeneration = attendanceInputGeneration;
    try {
      const event = await body(request); const config = await loadPairing();
      if (!config) throw new Error("Pair this kiosk before recording attendance");
      if (!attendanceAllowed() || inputGeneration !== attendanceInputGeneration) throw new Error("Attendance mode changed. Return to attendance and scan again.");
      const commit = queue.enqueue({ eventId: event.eventId || crypto.randomUUID(), memberId: event.memberId, meetingId: event.meetingId, occurredAt: event.occurredAt || new Date().toISOString(), ...(config?.pairingId ? { pairingId: config.pairingId } : {}) });
      directAttendanceCommits.add(commit);
      let accepted; try { accepted = await commit; } finally { directAttendanceCommits.delete(commit); }
      // Acknowledge durable local storage, not cloud delivery. An unavailable
      // or slow cloud must not turn a saved scan into a failed-save response.
      response.statusCode = accepted ? 202 : 200;
      response.end(JSON.stringify({ accepted, queued: (await queue.pending()).length }));
      if (config) void flushAttendance(config).catch(() => undefined);
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid attendance event" })); }
    return;
  }
  if (pathname === "/fingerprint-diagnostics" && request.method === "GET") {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock local settings before reviewing fingerprint diagnostics" })); return; }
    response.end(JSON.stringify(await fingerprintDiagnostics())); return;
  }
  if (pathname === "/fingerprint-sync" || pathname.startsWith("/fingerprint-sync/")) {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock local settings first" })); return; }
    response.statusCode = 410; response.end(JSON.stringify({ error: "Peer sharing has been retired. Use cloud sync diagnostics." })); return;
  }
  if (pathname === "/mappings" && request.method === "GET") { try { await requireNetworkSession(); response.end(JSON.stringify({ mappings: await mappings.read() })); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Mappings unavailable" })); } return; }
  if (pathname === "/mappings" && request.method === "PUT") { try { await requireNetworkSession(); const input = await body(request); const vault = (await loadPairing())?.pairingId ? await vaultController() : undefined; response.end(JSON.stringify({ mappings: await useSensor(async () => { await assertFingerprintMutationAllowed(); return mappings.replaceFromMaintenance(input.mappings ?? {}, { beforeRemove: (slot, mapping) => vault?.suppressLocal(slot, mapping) }); }) })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid mappings" })); } return; }
  if (/^\/mappings\/\d{1,3}$/.test(pathname) && request.method === "DELETE") { try { await requireNetworkSession(); const slot = pathname.split("/")[2]; const vault = (await loadPairing())?.pairingId ? await vaultController() : undefined; const updated = await useSensor(async () => { await assertFingerprintMutationAllowed(); const current = await mappings.read(); if (current[slot] && vault) await vault.suppressLocal(Number(slot), current[slot]); delete current[slot]; return mappings.replace(current); }); response.end(JSON.stringify({ mappings: updated, sensorTemplateRetained: true })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not remove mapping" })); } return; }
  if (pathname === "/sensor/test" && request.method === "POST") { try { await requireNetworkSession(); if (enrollmentInProgress) { response.statusCode = 409; response.end(JSON.stringify({ error: "Enrollment is using the reader. Wait for it to finish." })); return; } response.end(JSON.stringify(await testSensor())); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Reader test unavailable" })); } return; }
  if (pathname === "/credential-mappings" && request.method === "GET") { try { await requireNetworkSession(); response.end(JSON.stringify({ mappings: await credentials.list() })); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Credential mappings unavailable" })); } return; }
  if (pathname === "/credential-mappings" && request.method === "POST") { try { await requireNetworkSession(); const input = await body(request); if (!await rosterCache.has(input.memberId)) throw new Error("Choose an active roster member"); const mapping = await credentials.add({ method: authenticationMethod, credential: input.credential, memberId: input.memberId, label: input.label, replaceExisting: input.replaceExisting === true }); response.statusCode = 201; response.end(JSON.stringify({ mapping })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Credential mapping could not be saved" })); } return; }
  if (/^\/credential-mappings\/[^/]+$/.test(pathname) && request.method === "DELETE") { try { await requireNetworkSession(); const mappingId = decodeURIComponent(pathname.split("/")[2]); const removed = await credentials.remove(mappingId); response.statusCode = removed ? 200 : 404; response.end(JSON.stringify({ removed })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Credential mapping could not be removed" })); } return; }
  if (pathname === "/network/session" && request.method === "GET") { try { const [access, connection] = await Promise.all([networkPin.status(), network.status()]); response.end(JSON.stringify({ ...access, network: connection })); } catch (error) { response.statusCode = 503; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Network status unavailable" })); } return; }
  if (pathname === "/network/session" && request.method === "DELETE") { networkPin.close(); response.end(JSON.stringify({ closed: true })); return; }
  if (pathname === "/network/pin" && request.method === "POST") { try { const access = await networkPin.status(); if (access.configured) throw new Error("The network PIN is already configured"); const input = await body(request); response.statusCode = 201; response.end(JSON.stringify(await networkPin.set(input.pin))); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not save network PIN" })); } return; }
  if (pathname === "/network/unlock" && request.method === "POST") { try { const input = await body(request); const result = await networkPin.verify(input.pin); if (!result.authorized) { response.statusCode = result.lockedUntil ? 429 : 401; response.end(JSON.stringify({ error: result.lockedUntil ? `Too many attempts. Try again after ${new Date(result.lockedUntil).toLocaleTimeString()}.` : "Network settings PIN is incorrect", ...result })); return; } response.end(JSON.stringify(result)); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not unlock network settings" })); } return; }
  if (pathname === "/network/wifi" && request.method === "GET") { try { await requireNetworkSession(); const networks = await network.wifi(); state.lastWifiScanAt = new Date().toISOString(); response.end(JSON.stringify({ networks })); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Network settings unavailable" })); } return; }
  if (pathname === "/network/connect" && request.method === "POST") { try { await requireNetworkSession(); const input = await body(request); response.end(JSON.stringify({ connected: true, network: await network.connect(input.ssid, input.password) })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not connect to Wi-Fi" })); } return; }
  if (pathname === "/maintenance/session" && request.method === "GET") { response.end(JSON.stringify(await networkPin.status())); return; }
  if (pathname === "/maintenance/members" && request.method === "GET") {
    try { await requireNetworkSession(); } catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock network settings first" })); return; }
    try { const config = await loadPairing(); if (!config) throw new Error("Pair this kiosk before managing authentication"); try { const roster = await fetchKioskRoster(config, { fetchImpl: boundedCloudFetch }); await rosterCache.replace(roster.members ?? []); response.end(JSON.stringify(roster)); } catch { const members = await rosterCache.read(); if (!members.length) throw new Error("Roster unavailable until this kiosk completes its first sync"); response.end(JSON.stringify({ members, cached: true })); } }
    catch (error) { response.statusCode = 503; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Roster unavailable" })); } return;
  }
  if (pathname === "/sensor/slots" && request.method === "GET") {
    try { await requireNetworkSession(); }
    catch { response.statusCode = 403; response.end(JSON.stringify({ error: "Unlock network settings first" })); return; }
    try {
      if (!sensor) throw new Error("Fingerprint reader is disabled");
      response.end(JSON.stringify({ occupiedSlots: await useSensor(() => sensor.occupiedSlots()) }));
    } catch { response.statusCode = 503; response.end(JSON.stringify({ error: "Cannot verify occupied sensor slots. Test the reader before enrolling." })); }
    return;
  }
  if (pathname === "/enroll" && request.method === "POST") {
    if (enrollmentInProgress) { response.statusCode = 409; response.end(JSON.stringify({ error: "Enrollment is already in progress", code: "enrollment_busy" })); return; }
    enrollmentInProgress = true;
    requireFingerRemoval();
    await scanner.suspend("enrollment");
    try {
      await requireNetworkSession();
      if (!sensor) throw new Error("Fingerprint reader is disabled");
      const input = await body(request);
      const memberId = typeof input.memberId === "string" ? input.memberId.trim() : "";
      const slot = Number(input.slot);
      if (!memberId || memberId.length > 100 || /[\u0000-\u001f\u007f]/.test(memberId) || !Number.isInteger(slot) || slot < 0 || slot > 199) throw new Error("Choose a roster member and sensor slot from 0 to 199");
      const config = await loadPairing();
      if (!config) throw new EnrollmentError("roster_unavailable", "Pair this kiosk before enrolling.", 503);
      const rosterId = await verifyEnrollmentMember(memberId, () => fetchKioskRoster(config, { fetchImpl: (url, options) => fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(8000) }) }));
      const enrollmentVault = await vaultController();
      const result = await enrollFingerprint({ sensor, mappings, withSensor: useSensor, slot, memberId, rosterId, finger: "unspecified", replaceExisting: input.replaceExisting === true, beforeReplace: (slot, mapping) => enrollmentVault.suppressLocal(slot, mapping), onProgress: id => showDisplay(id), isEnrollmentAllowed: async () => {
        const current = await loadPairing();
        if (current?.pairingId !== config.pairingId || current?.kioskId !== config.kioskId) throw new Error("Kiosk pairing changed. Refresh and retry enrollment.");
        await assertFingerprintMutationAllowed(); return true;
      } });
      state.readerOnline = true;
      requireFingerRemoval();
      await showDisplay("enroll_success", { detail: "Lift your finger. Enrollment is saved." });
      response.statusCode = 201; response.end(JSON.stringify({ ...result, fingerRemovalRequired: true }));
      void pollFingerprintSync();
    } catch (error) {
      await showDisplay("enroll_failure", { detail: error instanceof Error ? error.message : "Try again" });
      response.statusCode = error instanceof EnrollmentError ? error.status : 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Fingerprint enrollment failed", ...(error instanceof EnrollmentError ? { code: error.code } : {}) }));
    } finally { enrollmentInProgress = false; scanner.release("enrollment"); await refreshCapturePermission(); }
    return;
  }
  response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
}

const server = createServer(async (request, response) => {
  try {
    await pairingBoundary;
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    const independent = ["/maintenance/unpair", "/maintenance/session", "/network/unlock", "/network/session", "/operator-presence"].includes(pathname)
      || (request.method === "GET" && (pathname === "/" || pathname === "/maintenance" || /\.(?:css|js)$/.test(pathname)));
    if (independent || unpairingBusy || pairingRecovery) await handleRequest(request, response);
    else await installationActivities.run(() => handleRequest(request, response));
  } catch {
    if (!response.writableEnded) { response.statusCode = 500; response.end(JSON.stringify({ error: "Local kiosk operation could not finish" })); }
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, process.env.LANCERLOGIN_KIOSK_HOST ?? "0.0.0.0", () => console.log(`LancerLogin kiosk service listening on port ${port}`));
  void pairingBoundary.then(async () => { if (pairingRecovery) { scanner.pause(); return; } await installationActivities.run(async () => { await Promise.all([loadPairing(), loadBranding(), loadAuthenticationMethod()]); display = state.paired ? readyDisplay() : kioskState("unpaired"); }); void pollCloud().then(() => cloudPolling?.scheduler.configurationSettled()).then(heartbeat); if (!unpairingBusy && !pairingRecovery) return scanner.start(); }).catch(() => undefined); setInterval(heartbeat, 60_000).unref(); setInterval(pollCloud, 5_000).unref();
  setInterval(() => { void refreshCapturePermission(); void checkFingerRemoval(); }, 250).unref();
}

export { server, network };

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { completeKioskCommand, fetchKioskCommand, fetchKioskConfiguration, fetchKioskRoster, pairInstallation, sendAttendance, sendHeartbeat } from "./cloud-client.mjs";
import { createFileQueue } from "./file-queue.mjs";
import { createMappingStore } from "./mapping-store.mjs";
import { decodePairingKey } from "./pairing-key.mjs";
import { createR503 } from "./r503.mjs";
import { createSerialExchange } from "./serial-transport.mjs";
import { kioskState, kioskStates } from "./kiosk-states.mjs";
import { createScanner } from "./scanner.mjs";
import { createNetworkManager } from "./network-manager.mjs";
import { createNetworkPinStore } from "./network-pin.mjs";
import { networkApp, networkStyles } from "./network-ui.mjs";
import { maintenanceApp, maintenanceHtml, maintenanceLayoutStyles, maintenanceStyles } from "./maintenance-ui.mjs";
import { recoveryApp } from "./recovery-ui.mjs";
import { startVerifiedKioskUpdate } from "./update-command.mjs";
import { kioskApp, kioskHtml, kioskStatusStyles, kioskStyles } from "./ui.mjs";

export function localReleaseVersion(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^(?:development|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(normalized) ? normalized : "development";
}

const port = Number(process.env.LANCERLOGIN_KIOSK_PORT ?? 8788);
const configPath = process.env.LANCERLOGIN_CONFIG ?? "/var/lib/lancerlogin/pairing.json";
const brandingPath = process.env.LANCERLOGIN_BRANDING ?? "/var/lib/lancerlogin/branding.json";
const networkPinPath = process.env.LANCERLOGIN_NETWORK_PIN ?? "/var/lib/lancerlogin/network-pin.json";
const queue = createFileQueue(process.env.LANCERLOGIN_QUEUE ?? "/var/lib/lancerlogin/attendance-queue.json");
const mappings = createMappingStore(process.env.LANCERLOGIN_MAPPINGS ?? "/var/lib/lancerlogin/slot-mappings.json");
const network = createNetworkManager(); const networkPin = createNetworkPinStore(networkPinPath);
const sensor = process.env.LANCERLOGIN_SENSOR_PATH === "disabled" ? undefined : createR503(createSerialExchange(process.env.LANCERLOGIN_SENSOR_PATH ?? "/dev/serial0"));
const serviceStartedAt = Date.now();
const releaseVersion = localReleaseVersion(process.env.LANCERLOGIN_VERSION);
let state = { paired: false, readerOnline: false, cloudOnline: false, networkType: undefined, kioskName: undefined, lastSyncAt: undefined, lastWifiScanAt: undefined, errorCategory: undefined };
let branding = { organizationName: "LancerLogin", subtitle: "", logoData: "", primaryColor: "#7c3aed", secondaryColor: "#0f766e", logoBackdrop: "auto" };
let sensorOperation = Promise.resolve();
let pairingConfig; let pairingLoaded = false; let display = kioskState("unpaired"); let displayTimer; let displayReloadToken = 0; let commandPolling = false;

async function loadPairing() { if (pairingLoaded) return pairingConfig; pairingLoaded = true; try { pairingConfig = JSON.parse(await readFile(configPath, "utf8")); state = { ...state, paired: true, kioskName: pairingConfig.kioskName }; display = kioskState("ready"); return pairingConfig; } catch { return undefined; } }
async function savePairing(config) { const temporary = `${configPath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, configPath); await chmod(configPath, 0o600); pairingConfig = config; pairingLoaded = true; state = { ...state, paired: true, kioskName: config.kioskName }; display = kioskState("ready"); }
async function loadBranding() { try { branding = { ...branding, ...JSON.parse(await readFile(brandingPath, "utf8")) }; } catch { /* Defaults remain available before the first cloud sync. */ } }
async function saveBranding(value) { const safe = { organizationName: String(value?.organizationName || "LancerLogin").slice(0, 100), subtitle: String(value?.subtitle || "").slice(0, 140), logoData: typeof value?.logoData === "string" ? value.logoData : "", primaryColor: /^#[0-9a-f]{6}$/i.test(value?.primaryColor) ? value.primaryColor : "#7c3aed", secondaryColor: /^#[0-9a-f]{6}$/i.test(value?.secondaryColor) ? value.secondaryColor : "#0f766e", logoBackdrop: ["auto", "light", "dark", "none"].includes(value?.logoBackdrop) ? value.logoBackdrop : "auto" }; const temporary = `${brandingPath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(safe)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, brandingPath); await chmod(brandingPath, 0o600); branding = safe; }
async function flushAttendance(config) { const pending = await queue.pending(); const acknowledgements = []; const delivered = await queue.flush(async (event) => { const result = await sendAttendance(config, event); acknowledgements.push({ eventId: event.eventId, ...result }); }); if (delivered.length < pending.length) throw new Error("Cloud attendance sync is unavailable"); return { delivered, acknowledgements }; }
async function useSensor(operation) { const current = sensorOperation.then(operation, operation); sensorOperation = current.then(() => undefined, () => undefined); return current; }
async function testSensor() { if (!sensor) { state.readerOnline = false; return { readerOnline: false, templateCount: 0 }; } try { const status = await useSensor(() => sensor.status()); state.readerOnline = status.connected; return { readerOnline: status.connected, templateCount: status.templateCount }; } catch { state.readerOnline = false; return { readerOnline: false, templateCount: 0 }; } }
async function heartbeat() { const config = await loadPairing(); if (!config) return; await testSensor(); let networkDiagnostics = { type: "offline", signal: null }; try { networkDiagnostics = await network.diagnostics(); state.networkType = networkDiagnostics.type; } catch { state.networkType = undefined; } try { await flushAttendance(config); state.lastSyncAt = new Date().toISOString(); state.errorCategory = undefined; const remote = await fetchKioskConfiguration(config); if (remote.settings) await saveBranding(remote.settings); if (remote.kiosk?.name) state.kioskName = remote.kiosk.name; await sendHeartbeat(config, { readerOnline: state.readerOnline, releaseVersion, uptimeSeconds: Math.floor((Date.now() - serviceStartedAt) / 1_000), networkType: networkDiagnostics.type, networkSignal: networkDiagnostics.signal, lastWifiScanAt: state.lastWifiScanAt ?? null, pendingEvents: (await queue.pending()).length, lastSyncAt: state.lastSyncAt, errorCategory: null }); state.cloudOnline = true; } catch { state.cloudOnline = false; state.errorCategory = "cloud_sync"; } }
async function runKioskCommand(command, config) {
  if (command.type === "reload_display") { displayReloadToken += 1; return { message: "Display reload requested" }; }
  if (command.type === "reset_network_pin") { await networkPin.reset(); return { message: "Local settings PIN reset" }; }
  if (command.type === "restart_service") return { message: "Service restart requested", afterComplete: () => setTimeout(() => process.exit(1), 250).unref() };
  if (command.type === "reboot") return { message: "Device reboot requested", afterComplete: () => setTimeout(() => { const child = spawn("/usr/bin/systemctl", ["reboot"], { detached: true, stdio: "ignore" }); child.unref(); }, 250).unref() };
  if (command.type === "install_latest") return { message: "Latest stable kiosk update started", afterComplete: () => setTimeout(() => startVerifiedKioskUpdate({ onFailure: (message) => completeKioskCommand(config, command.id, { success: false, message }) }), 250).unref() };
  throw new Error("Unsupported kiosk command");
}
async function pollCommands() {
  if (commandPolling) return; commandPolling = true;
  try {
    const config = await loadPairing(); if (!config) return;
    const { command } = await fetchKioskCommand(config); if (!command) return;
    try { const result = await runKioskCommand(command, config); await completeKioskCommand(config, command.id, { success: true, message: result.message }); result.afterComplete?.(); }
    catch (error) { await completeKioskCommand(config, command.id, { success: false, message: error instanceof Error ? error.message : "Command failed" }); }
  } catch { /* The heartbeat reports cloud connectivity separately. */ }
  finally { commandPolling = false; }
}
async function showDisplay(id, overrides = {}) { if (displayTimer) clearTimeout(displayTimer); display = kioskState(id, overrides); const duration = kioskStates[id]?.durationMs; if (duration) displayTimer = setTimeout(() => { display = kioskState(state.readerOnline ? "ready" : "reader_offline"); void setLed(display.id); }, duration); }
async function setLed(id) { const definition = kioskStates[id]; if (sensor && definition?.led) await useSensor(() => sensor.led(definition.led)); }
const scanner = createScanner({ scanSensor: async () => sensor ? useSensor(() => sensor.scan()) : Promise.reject(new Error("Reader disabled")), setLed, mappings, queue, loadPairing, flushAttendance, onDisplay: showDisplay, onReader: (online) => { state.readerOnline = online; }, onCloud: (online) => { state.cloudOnline = online; if (online) { state.lastSyncAt = new Date().toISOString(); state.errorCategory = undefined; } else state.errorCategory = "cloud_sync"; } });
async function body(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw new Error("Request body is too large"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function trusted(request) { const origin = request.headers.origin; const host = request.headers.host; return !origin || Boolean(host && origin === `http://${host}`); }
function localRequest(request) { const address = request.socket.remoteAddress ?? ""; return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"; }
async function requireNetworkSession() { const access = await networkPin.status(); if (!access.authorized) throw new Error("Unlock network settings first"); }

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  if (!trusted(request)) { response.statusCode = 403; response.end(JSON.stringify({ error: "Untrusted local origin" })); return; }
  if (!localRequest(request) && !["/", "/styles.css", "/app.js", "/network.css", "/network.js", "/recovery.js", "/health", "/pair"].includes(pathname)) { response.setHeader("content-type", "application/json; charset=utf-8"); response.statusCode = 403; response.end(JSON.stringify({ error: "Attendance and reader controls are available only on the kiosk" })); return; }
  if (pathname === "/" && request.method === "GET") { response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); response.end(kioskHtml); return; }
  if (pathname === "/styles.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(kioskStyles + kioskStatusStyles); return; }
  if (pathname === "/app.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(kioskApp); return; }
  if (pathname === "/network.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(networkStyles); return; }
  if (pathname === "/network.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(networkApp); return; }
  if (pathname === "/recovery.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(recoveryApp); return; }
  if (pathname === "/maintenance" && request.method === "GET") { response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); response.end(maintenanceHtml); return; }
  if (pathname === "/maintenance.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(maintenanceStyles + maintenanceLayoutStyles); return; }
  if (pathname === "/maintenance.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(maintenanceApp); return; }
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (pathname === "/health" && request.method === "GET") { await loadPairing(); response.end(JSON.stringify({ ok: true, service: "lancerlogin-kiosk", ...state, pendingEvents: (await queue.pending()).length })); return; }
  if (pathname === "/display-state" && request.method === "GET") { response.end(JSON.stringify({ display, branding, kioskName: state.kioskName, readerOnline: state.readerOnline, cloudOnline: state.cloudOnline, networkType: state.networkType, pendingEvents: (await queue.pending()).length, uptimeSeconds: Math.floor((Date.now() - serviceStartedAt) / 1000), releaseVersion, displayReloadToken })); return; }
  if (pathname === "/pair" && request.method === "POST") { try { if (await loadPairing()) throw new Error("This kiosk is already paired"); const input = await body(request); const pairing = decodePairingKey(input.pairingKey); const config = await pairInstallation(pairing); await savePairing(config); response.statusCode = 201; response.end(JSON.stringify({ paired: true, kioskName: config.kioskName })); void heartbeat(); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Pairing failed" })); } return; }
  if (pathname === "/attendance" && request.method === "POST") { try { const event = await body(request); const accepted = await queue.enqueue({ eventId: event.eventId || crypto.randomUUID(), memberId: event.memberId, meetingId: event.meetingId, occurredAt: event.occurredAt || new Date().toISOString() }); const config = await loadPairing(); if (config) await flushAttendance(config); response.statusCode = accepted ? 202 : 200; response.end(JSON.stringify({ accepted, queued: (await queue.pending()).length })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid attendance event" })); } return; }
  if (pathname === "/mappings" && request.method === "GET") { try { await requireNetworkSession(); response.end(JSON.stringify({ mappings: await mappings.read() })); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Mappings unavailable" })); } return; }
  if (pathname === "/mappings" && request.method === "PUT") { try { await requireNetworkSession(); const input = await body(request); response.end(JSON.stringify({ mappings: await mappings.replace(input.mappings ?? {}) })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid mappings" })); } return; }
  if (/^\/mappings\/\d{1,3}$/.test(pathname) && request.method === "DELETE") { try { await requireNetworkSession(); const slot = pathname.split("/")[2]; const current = await mappings.read(); delete current[slot]; response.end(JSON.stringify({ mappings: await mappings.replace(current), sensorTemplateRetained: true })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not remove mapping" })); } return; }
  if (pathname === "/sensor/test" && request.method === "POST") { try { await requireNetworkSession(); response.end(JSON.stringify(await testSensor())); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Reader test unavailable" })); } return; }
  if (pathname === "/network/session" && request.method === "GET") { try { const [access, connection] = await Promise.all([networkPin.status(), network.status()]); response.end(JSON.stringify({ ...access, network: connection })); } catch (error) { response.statusCode = 503; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Network status unavailable" })); } return; }
  if (pathname === "/network/session" && request.method === "DELETE") { networkPin.close(); response.end(JSON.stringify({ closed: true })); return; }
  if (pathname === "/network/pin" && request.method === "POST") { try { const access = await networkPin.status(); if (access.configured) throw new Error("The network PIN is already configured"); const input = await body(request); response.statusCode = 201; response.end(JSON.stringify(await networkPin.set(input.pin))); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not save network PIN" })); } return; }
  if (pathname === "/network/unlock" && request.method === "POST") { try { const input = await body(request); const result = await networkPin.verify(input.pin); if (!result.authorized) { response.statusCode = result.lockedUntil ? 429 : 401; response.end(JSON.stringify({ error: result.lockedUntil ? `Too many attempts. Try again after ${new Date(result.lockedUntil).toLocaleTimeString()}.` : "Network settings PIN is incorrect", ...result })); return; } response.end(JSON.stringify(result)); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not unlock network settings" })); } return; }
  if (pathname === "/network/wifi" && request.method === "GET") { try { await requireNetworkSession(); const networks = await network.wifi(); state.lastWifiScanAt = new Date().toISOString(); response.end(JSON.stringify({ networks })); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Network settings unavailable" })); } return; }
  if (pathname === "/network/connect" && request.method === "POST") { try { await requireNetworkSession(); const input = await body(request); response.end(JSON.stringify({ connected: true, network: await network.connect(input.ssid, input.password) })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Could not connect to Wi-Fi" })); } return; }
  if (pathname === "/maintenance/session" && request.method === "GET") { response.end(JSON.stringify(await networkPin.status())); return; }
  if (pathname === "/maintenance/members" && request.method === "GET") { try { await requireNetworkSession(); const config = await loadPairing(); if (!config) throw new Error("Pair this kiosk before managing fingerprints"); response.end(JSON.stringify(await fetchKioskRoster(config))); } catch (error) { response.statusCode = 403; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Roster unavailable" })); } return; }
  if (pathname === "/enroll" && request.method === "POST") { scanner.pause(); try { await requireNetworkSession(); if (!sensor) throw new Error("Fingerprint reader is disabled"); const input = await body(request); const memberId = input.memberId?.trim(); const finger = String(input.finger || "unspecified").trim().toLowerCase(); const allowedFingers = ["right index", "left index", "right thumb", "left thumb", "right middle", "left middle", "other"]; const slot = Number(input.slot); if (!memberId || memberId.length > 100 || !allowedFingers.includes(finger) || !Number.isInteger(slot) || slot < 0 || slot > 199) throw new Error("Choose a roster member, finger label, and sensor slot from 0 to 199"); const current = await mappings.read(); if (current[String(slot)] && input.replaceExisting !== true) throw new Error(`Sensor slot ${slot} is already mapped; confirm replacement to continue`); await useSensor(() => sensor.enroll(slot, { onProgress: (id) => showDisplay(id) })); await mappings.replace({ ...current, [String(slot)]: { memberId, finger } }); state.readerOnline = true; await showDisplay("enroll_success", { detail: `Sensor slot ${slot} is ready` }); response.statusCode = 201; response.end(JSON.stringify({ enrolled: true, slot, memberId, finger })); } catch (error) { await showDisplay("enroll_failure", { detail: error instanceof Error ? error.message : "Try again" }); response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Fingerprint enrollment failed" })); } finally { scanner.resume(); } return; }
  response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, process.env.LANCERLOGIN_KIOSK_HOST ?? "0.0.0.0", () => console.log(`LancerLogin kiosk service listening on port ${port}`));
  void Promise.all([loadPairing(), loadBranding()]).then(() => scanner.start()); heartbeat(); pollCommands(); setInterval(heartbeat, 60_000).unref(); setInterval(pollCommands, 5_000).unref();
}

export { server, network };

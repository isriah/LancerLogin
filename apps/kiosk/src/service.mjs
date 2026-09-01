import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { sendAttendance, sendHeartbeat } from "./cloud-client.mjs";
import { createFileQueue } from "./file-queue.mjs";
import { createMappingStore } from "./mapping-store.mjs";
import { createR503 } from "./r503.mjs";
import { createSerialExchange } from "./serial-transport.mjs";
import { kioskApp, kioskHtml, kioskStyles } from "./ui.mjs";

const port = Number(process.env.LANCERLOGIN_KIOSK_PORT ?? 8788);
const configPath = process.env.LANCERLOGIN_CONFIG ?? "/var/lib/lancerlogin/pairing.json";
const queue = createFileQueue(process.env.LANCERLOGIN_QUEUE ?? "/var/lib/lancerlogin/attendance-queue.json");
const mappings = createMappingStore(process.env.LANCERLOGIN_MAPPINGS ?? "/var/lib/lancerlogin/slot-mappings.json");
const sensor = process.env.LANCERLOGIN_SENSOR_PATH === "disabled" ? undefined : createR503(createSerialExchange(process.env.LANCERLOGIN_SENSOR_PATH ?? "/dev/serial0"));
let state = { paired: false, readerOnline: false, cloudOnline: false, kioskName: undefined };
let sensorOperation = Promise.resolve();

async function loadPairing() { try { const config = JSON.parse(await readFile(configPath, "utf8")); state = { ...state, paired: true, kioskName: config.kioskName }; return config; } catch { return undefined; } }
async function flushAttendance(config) { const acknowledgements = []; const delivered = await queue.flush(async (event) => { const result = await sendAttendance(config, event); acknowledgements.push({ eventId: event.eventId, ...result }); }); return { delivered, acknowledgements }; }
async function useSensor(operation) { const current = sensorOperation.then(operation, operation); sensorOperation = current.then(() => undefined, () => undefined); return current; }
async function testSensor() { if (!sensor) { state.readerOnline = false; return { readerOnline: false, templateCount: 0 }; } try { const status = await useSensor(() => sensor.status()); state.readerOnline = status.connected; return { readerOnline: status.connected, templateCount: status.templateCount }; } catch { state.readerOnline = false; return { readerOnline: false, templateCount: 0 }; } }
async function heartbeat() { const config = await loadPairing(); if (!config) return; await testSensor(); try { await flushAttendance(config); await sendHeartbeat(config, { readerOnline: state.readerOnline, releaseVersion: process.env.LANCERLOGIN_VERSION ?? "development" }); state.cloudOnline = true; } catch { state.cloudOnline = false; } }
async function body(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw new Error("Request body is too large"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function trusted(request) { const origin = request.headers.origin; return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`; }

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  if (!trusted(request)) { response.statusCode = 403; response.end(JSON.stringify({ error: "Untrusted local origin" })); return; }
  if (pathname === "/" && request.method === "GET") { response.setHeader("content-type", "text/html; charset=utf-8"); response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); response.end(kioskHtml); return; }
  if (pathname === "/styles.css" && request.method === "GET") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(kioskStyles); return; }
  if (pathname === "/app.js" && request.method === "GET") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(kioskApp); return; }
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (pathname === "/health" && request.method === "GET") { await loadPairing(); response.end(JSON.stringify({ ok: true, service: "lancerlogin-kiosk", ...state, pendingEvents: (await queue.pending()).length })); return; }
  if (pathname === "/attendance" && request.method === "POST") { try { const event = await body(request); const accepted = await queue.enqueue({ eventId: event.eventId || crypto.randomUUID(), memberId: event.memberId, meetingId: event.meetingId, occurredAt: event.occurredAt || new Date().toISOString() }); const config = await loadPairing(); if (config) await flushAttendance(config); response.statusCode = accepted ? 202 : 200; response.end(JSON.stringify({ accepted, queued: (await queue.pending()).length })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid attendance event" })); } return; }
  if (pathname === "/mappings" && request.method === "GET") { response.end(JSON.stringify({ mappings: await mappings.read() })); return; }
  if (pathname === "/mappings" && request.method === "PUT") { try { const input = await body(request); response.end(JSON.stringify({ mappings: await mappings.replace(input.mappings ?? {}) })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid mappings" })); } return; }
  if (pathname === "/sensor/test" && request.method === "POST") { response.end(JSON.stringify(await testSensor())); return; }
  if (pathname === "/enroll" && request.method === "POST") { try { if (!sensor) throw new Error("Fingerprint reader is disabled"); const input = await body(request); const memberId = input.memberId?.trim(); const slot = Number(input.slot); if (!memberId || memberId.length > 100 || !Number.isInteger(slot) || slot < 0 || slot > 199) throw new Error("memberId and a sensor slot from 0 to 199 are required"); const current = await mappings.read(); if (current[String(slot)] && input.replaceExisting !== true) throw new Error(`Sensor slot ${slot} is already mapped; confirm replacement to continue`); await useSensor(() => sensor.enroll(slot)); await mappings.replace({ ...current, [String(slot)]: memberId }); state.readerOnline = true; response.statusCode = 201; response.end(JSON.stringify({ enrolled: true, slot, memberId })); } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Fingerprint enrollment failed" })); } return; }
  if (pathname === "/scan" && request.method === "POST") { try { if (!sensor) throw new Error("Fingerprint reader is disabled"); const input = await body(request); if (!input.meetingId) throw new Error("meetingId is required"); const match = await useSensor(() => sensor.match()); if (!match) { response.statusCode = 404; response.end(JSON.stringify({ matched: false })); return; } const memberId = await mappings.memberForSlot(match.slot); if (!memberId) throw new Error(`Fingerprint slot ${match.slot} is not mapped to a roster member`); const event = { eventId: crypto.randomUUID(), memberId, meetingId: input.meetingId, occurredAt: new Date().toISOString() }; await queue.enqueue(event); const config = await loadPairing(); const sync = config ? await flushAttendance(config) : undefined; const acknowledgement = sync?.acknowledgements.find((item) => item.eventId === event.eventId); response.statusCode = 202; response.end(JSON.stringify({ matched: true, slot: match.slot, memberId, action: acknowledgement?.action, duplicate: acknowledgement?.duplicate, queued: (await queue.pending()).length })); } catch (error) { response.statusCode = 503; response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Fingerprint scan failed" })); } return; }
  response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, "127.0.0.1", () => console.log(`LancerLogin kiosk service listening on http://127.0.0.1:${port}`));
  heartbeat(); setInterval(heartbeat, 60_000).unref();
}

export { server };

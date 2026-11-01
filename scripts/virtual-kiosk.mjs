#!/usr/bin/env node
// Virtual Pi: run the real kiosk service on this computer with fake hardware, paired to a local preview.
//
//   npm run kiosk:virtual -- [--kiosks 1-4] [--reset] [--no-dashboard] [--port-base 8790] [--state <folder>]
//
// Starts, all on 127.0.0.1 or localhost:
//   - a local preview: the Worker with wrangler dev on a local D1, and the dashboard with Vite (unless --no-dashboard);
//   - a cloud link between the kiosks and the Worker that the control panel can cut, so kiosks queue scans offline;
//   - one kiosk service per virtual kiosk (scripts/virtual-kiosk/kiosk-process.mjs), restarted when it exits as
//     systemd restarts a Pi's service;
//   - the control panel, which shows each kiosk's screen beside its controls.
// The first run creates a local Admin, synthetic test members and meetings, and pairs each kiosk. State lives in
// .provision/virtual-kiosk and is kept between runs; --reset starts over. Nothing here reaches a real kiosk, the dev
// site or a live installation, and nothing in it ships in a kiosk release.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coreRoot, developmentRuntime } from "./plugin-dev.mjs";
import { defaultNetworkState, networkOnline, rebootExitCode, updateExitCode, validNetworkState } from "./virtual-kiosk/fakes.mjs";

const defaultStateRoot = join(coreRoot, ".provision/virtual-kiosk");
const panelHtml = join(dirname(fileURLToPath(import.meta.url)), "virtual-kiosk/panel.html");
// The settings PIN every virtual kiosk gets, so the panel can unlock maintenance. Synthetic; never a real kiosk's PIN.
export const virtualSettingsPin = "246810";
export const virtualKioskRelease = "2.0.0";
// Synthetic test data only. Emails use the reserved example.test domain.
export const testMembers = [
  { memberId: "1001", firstName: "Test Student", lastName: "A", email: "test.student.a@example.test" },
  { memberId: "1002", firstName: "Test Student", lastName: "B", email: "test.student.b@example.test" },
  { memberId: "1003", firstName: "Test Student", lastName: "C", email: "test.student.c@example.test" },
  { memberId: "1004", firstName: "Test Student", lastName: "D", email: "test.student.d@example.test" },
  { memberId: "1005", firstName: "Test Student", lastName: "E", email: "test.student.e@example.test" },
  { memberId: "1006", firstName: "Test Student", lastName: "F", email: "test.student.f@example.test" },
  { memberId: "1007", firstName: "Test Student", lastName: "G", email: "test.student.g@example.test" },
  { memberId: "1008", firstName: "Test Student", lastName: "H", email: "test.student.h@example.test" },
  { memberId: "1009", firstName: "Test Student", lastName: "I", email: "test.student.i@example.test" },
  { memberId: "1010", firstName: "Test Student", lastName: "J", email: "test.student.j@example.test" },
];
// Deployment and provisioning environments; the virtual kiosk runs on a developer's computer or a CI test runner only.
const refusedMarkers = ["CF_PAGES", "WORKERS_CI", "CLOUDFLARE_API_TOKEN", "LANCERLOGIN_DEPLOYMENT"];

class VirtualKioskError extends Error {}
const fail = (message) => { throw new VirtualKioskError(message); };
const pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export function parseArguments(argv) {
  const options = { kiosks: 1, reset: false, dashboard: true, portBase: 8790, state: defaultStateRoot };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => { const next = argv[++index]; if (next === undefined) fail(`${argument} needs a value`); return next; };
    if (argument === "--kiosks") { options.kiosks = Number(value()); if (!Number.isInteger(options.kiosks) || options.kiosks < 1 || options.kiosks > 4) fail("--kiosks takes 1 to 4"); }
    else if (argument === "--reset") options.reset = true;
    else if (argument === "--no-dashboard") options.dashboard = false;
    else if (argument === "--port-base") { options.portBase = Number(value()); if (!Number.isInteger(options.portBase) || options.portBase < 1024 || options.portBase > 65_500) fail("--port-base takes a port from 1024 to 65500"); }
    else if (argument === "--state") { options.state = resolve(coreRoot, value()); if (!options.state.startsWith(join(coreRoot, ".provision"))) fail("--state must be a folder under .provision"); }
    else fail(`Unknown argument ${argument}. Use --kiosks N, --reset, --no-dashboard, --port-base N or --state <folder>.`);
  }
  return options;
}

/** Ports: panel at the base, then the Worker and dashboard; per kiosk, its service from base + 10, its panel screen from base + 20 and its link to the Worker from base + 30. */
export function virtualPorts(portBase, kiosks) {
  const each = (offset) => Array.from({ length: kiosks }, (_, index) => portBase + offset + index);
  return { panel: portBase, api: portBase + 2, dashboard: portBase + 3, kiosks: each(10), screens: each(20), links: each(30) };
}

async function waitFor(url, { timeoutMs = 120_000, label = url } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const response = await fetch(url); if (response.status < 500) return; } catch { /* Not listening yet. */ }
    await pause(500);
  }
  fail(`${label} did not start within ${Math.round(timeoutMs / 1000)} s`);
}

/** A dashboard-style API client that keeps the session cookie, for the local Worker. */
function apiClient(apiUrl, dashboardOrigin) {
  const client = {
    cookie: undefined,
    async call(method, path, body, extraHeaders = {}) {
      const headers = { origin: dashboardOrigin, ...extraHeaders };
      if (client.cookie && !headers.authorization) headers.cookie = client.cookie;
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`${apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      const session = /lancerlogin_session=([^;]*)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
      if (session !== undefined) client.cookie = session ? `lancerlogin_session=${session}` : undefined;
      return { status: response.status, body: json, text };
    },
    async ok(method, path, body, extraHeaders) {
      const result = await client.call(method, path, body, extraHeaders);
      if (result.status < 200 || result.status >= 300) fail(`${method} ${path} returned ${result.status}: ${result.text.slice(0, 300)}`);
      return result.body;
    },
  };
  return client;
}

async function completeSetupStep(api, moduleId, stepId) {
  const modules = await api.ok("GET", "/platform/modules");
  const generation = modules.modules.find((module) => module.id === moduleId)?.generation;
  return api.ok("PUT", `/admin/modules/${moduleId}/setup`, { generation, stepId, outcome: "completed" });
}

/** First Admin, attendance setup, two test members and two test meetings. Runs once per state folder. */
async function seedPreview(api, { setupCode, adminPath }) {
  if (existsSync(adminPath)) {
    const admin = JSON.parse(readFileSync(adminPath, "utf8"));
    await api.ok("POST", "/auth/local", { username: admin.username, password: admin.password });
    return admin;
  }
  const admin = { username: "virtual-admin", password: randomBytes(18).toString("base64url") };
  await api.ok("POST", "/setup/bootstrap", { setupCode, organizationName: "Virtual Robotics", timeZone: "UTC", authMode: "local", localUsername: admin.username, localPassword: admin.password });
  await api.ok("POST", "/auth/local", { username: admin.username, password: admin.password });
  const modules = await api.ok("GET", "/platform/modules");
  await api.ok("PUT", "/admin/modules", { enabled: ["attendance"].filter((id) => modules.modules.some((module) => module.id === id)), revision: modules.revision });
  await api.ok("POST", "/admin/members", { members: testMembers });
  const rules = await api.ok("GET", "/module-setup/attendance/rules");
  await api.ok("PUT", "/module-setup/attendance/rules", { values: { ...rules.values, lateScanMinutes: 30 }, expected: rules.values });
  await completeSetupStep(api, "attendance", "rules");
  // Test meeting A is open for scans now and for the rest of today (UTC); Test meeting B is a week out.
  const now = Date.now(); const midnight = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const current = { startsAt: new Date(Math.max(now - 5 * 60_000, midnight)).toISOString(), endsAt: new Date(midnight + 86_400_000 - 60_000).toISOString() };
  await api.ok("POST", "/module-setup/attendance/meeting", { title: "Test meeting A", ...current, required: true });
  await completeSetupStep(api, "attendance", "meeting");
  // Verified attendance input completes once a paired kiosk has checked in. Pair a web kiosk through the API, report in
  // once, finish the step and retire it, so the virtual kiosks below pair into a ready installation.
  const setupPairing = await api.ok("POST", "/admin/pairing-codes", { kioskName: "Virtual setup kiosk", kind: "web" });
  const setupKiosk = await api.ok("POST", "/kiosk/pair", { code: setupPairing.code });
  await api.ok("POST", "/kiosk/heartbeat", { readerOnline: false, releaseVersion: "virtual-setup" }, { authorization: `Bearer ${setupKiosk.kioskToken}` });
  await completeSetupStep(api, "attendance", "input");
  await api.ok("DELETE", `/admin/kiosks/${encodeURIComponent(setupKiosk.kioskId)}`, { confirmation: "RETIRE KIOSK" });
  const nextWeek = midnight + 7 * 86_400_000 + 17 * 3_600_000;
  await api.ok("POST", "/meetings", { title: "Test meeting B", startsAt: new Date(nextWeek).toISOString(), endsAt: new Date(nextWeek + 2 * 3_600_000).toISOString(), required: true, notes: "Synthetic" });
  // Members take attendance from a month back, so past and current meetings count for them.
  for (const member of testMembers) await api.call("PATCH", `/admin/attendance/members/${encodeURIComponent(member.memberId)}`, { attendanceRequiredFrom: new Date(now - 30 * 86_400_000).toISOString().slice(0, 10), expected: null });
  await writeFile(adminPath, `${JSON.stringify(admin, null, 2)}\n`, { mode: 0o600 });
  return admin;
}

/** The pairing key the dashboard would show for a new kiosk, pointing at the cloud link instead of the Worker. */
export function pairingKey(apiUrl, code, kioskName) {
  return `LL1.${Buffer.from(JSON.stringify({ apiUrl, code, kioskName })).toString("base64url")}`;
}

/** One kiosk's way to the Worker. It drops every connection while online() is false: the Worker is set unreachable, or the kiosk has no network. */
function startCloudLink({ port, target, online }) {
  const link = {};
  const server = createServer((incoming, outgoing) => {
    if (!online()) { incoming.socket.destroy(); return; }
    const upstream = httpRequest(new URL(incoming.url ?? "/", target), { method: incoming.method, headers: { ...incoming.headers, host: new URL(target).host } }, (reply) => {
      outgoing.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(outgoing);
    });
    upstream.once("error", () => incoming.socket.destroy());
    incoming.pipe(upstream);
  });
  server.listen(port, "127.0.0.1");
  link.server = server;
  return link;
}

const kioskEnvironment = (directory, readerPath, port, kiosk) => ({
  // The release the kiosk reports. It starts old, so the dashboard offers updates as it would for a real kiosk (a
  // "development" build has none), and becomes the installed release after an update.
  LANCERLOGIN_KIOSK_PORT: String(port), LANCERLOGIN_KIOSK_HOST: "127.0.0.1", LANCERLOGIN_VERSION: kiosk.release,
  // The virtual reader keeps its library outside the kiosk's state folder: unpairing archives that folder, but a real
  // reader keeps its stored fingerprints.
  LANCERLOGIN_SENSOR_PATH: "virtual", LANCERLOGIN_VIRTUAL_READER: readerPath,
  LANCERLOGIN_CONFIG: join(directory, "pairing.json"), LANCERLOGIN_BRANDING: join(directory, "branding.json"),
  LANCERLOGIN_NETWORK_PIN: join(directory, "network-pin.json"), LANCERLOGIN_AUTHENTICATION: join(directory, "authentication.json"),
  LANCERLOGIN_CREDENTIAL_MAPPINGS: join(directory, "credential-mappings.json"), LANCERLOGIN_ROSTER_CACHE: join(directory, "roster-cache.json"),
  LANCERLOGIN_QUEUE: join(directory, "attendance-queue.json"), LANCERLOGIN_MAPPINGS: join(directory, "slot-mappings.json"),
  LANCERLOGIN_VIRTUAL_BOOT_ID: kiosk.boot.id, LANCERLOGIN_VIRTUAL_BOOT_STARTED_AT: String(kiosk.boot.startedAt),
  LANCERLOGIN_VIRTUAL_CLOCK_SYNCED: kiosk.boot.clockSynced ? "1" : "0", LANCERLOGIN_VIRTUAL_NETWORK: JSON.stringify(kiosk.network),
  LANCERLOGIN_VIRTUAL_NEXT_UPDATE: kiosk.nextUpdate,
});

/**
 * The kiosk's own pages refuse to be framed. This pass-through lets only the control panel frame one kiosk's screen; the
 * kiosk still sees a loopback client, as it does from its own display.
 */
function startScreenProxy({ port, kioskPort, panelOrigin }) {
  const server = createServer((incoming, outgoing) => {
    // The kiosk accepts a browser request only when its Origin matches its Host, so both name the kiosk.
    const headers = { ...incoming.headers, host: `127.0.0.1:${kioskPort}` };
    if (headers.origin === `http://127.0.0.1:${port}`) headers.origin = `http://127.0.0.1:${kioskPort}`;
    const upstream = httpRequest({ host: "127.0.0.1", port: kioskPort, path: incoming.url, method: incoming.method, headers }, (reply) => {
      const headers = { ...reply.headers };
      if (typeof headers["content-security-policy"] === "string") headers["content-security-policy"] = headers["content-security-policy"].replace("frame-ancestors 'none'", `frame-ancestors ${panelOrigin}`);
      outgoing.writeHead(reply.statusCode ?? 502, headers); reply.pipe(outgoing);
    });
    upstream.once("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/** Runs one virtual kiosk and restarts it the way systemd restarts the Pi's service. */
function superviseKiosk({ index, port, screenPort, linkUrl, directory, readerPath, systemPath, log }) {
  let nextMessage = 0; const waiting = new Map();
  const saved = existsSync(systemPath) ? JSON.parse(readFileSync(systemPath, "utf8")) : {};
  const kiosk = { index, port, screenPort, linkUrl, directory, name: `Virtual kiosk ${index + 1}`, starts: 0, events: [], stopping: false,
    release: typeof saved.release === "string" ? saved.release : virtualKioskRelease,
    // Kept by the supervisor so they survive restarts: the network, the next boot's clock and the next update's outcome.
    network: defaultNetworkState(), nextBootClockSynced: true, nextUpdate: "install" };
  // A boot has its own identity and either has network time or not, decided when it starts.
  kiosk.newBoot = () => { kiosk.boot = { id: randomUUID(), startedAt: Date.now(), clockSynced: kiosk.nextBootClockSynced }; };
  kiosk.newBoot();
  const note = (message) => { kiosk.events.unshift({ at: new Date().toISOString(), message }); kiosk.events.length = Math.min(kiosk.events.length, 30); log(`${kiosk.name}: ${message}`); };
  kiosk.start = () => {
    kiosk.starts += 1;
    const child = spawn(process.execPath, [join(coreRoot, "scripts/virtual-kiosk/kiosk-process.mjs")], {
      cwd: coreRoot, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "development", ...kioskEnvironment(directory, readerPath, port, kiosk) },
    });
    kiosk.child = child;
    child.on("message", (message) => {
      if (message?.event === "network" && validNetworkState(message.network)) { kiosk.network = message.network; note(`joined Wi-Fi network ${message.network.ssid} from its own screen`); return; }
      const reply = waiting.get(message?.id); if (!reply) return; waiting.delete(message.id); if (message.error) reply.reject(new Error(message.error)); else reply.resolve(message.result); });
    child.stdout.on("data", (chunk) => { for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) log(`${kiosk.name} | ${line}`); });
    child.stderr.on("data", (chunk) => { for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) log(`${kiosk.name} ! ${line}`); });
    child.once("exit", (code) => {
      kiosk.child = undefined;
      for (const [id, reply] of waiting) { waiting.delete(id); reply.reject(new Error(`${kiosk.name} restarted`)); }
      if (kiosk.stopping) return;
      // On Linux the service stops in order on SIGTERM and exits 0; a restart the panel asked for still starts it again.
      const requested = kiosk.restartRequested; kiosk.restartRequested = false;
      if (code === 0 && !requested) { note("service stopped"); return; }
      if (code === rebootExitCode) { kiosk.newBoot(); note(kiosk.boot.clockSynced ? "rebooted" : "rebooted without network time"); }
      else if (code === updateExitCode) {
        // Like a Pi after its update service runs, the kiosk now reports the release it was asked to install. It still
        // runs this checkout.
        let request; try { request = JSON.parse(readFileSync(join(directory, "update-request.json"), "utf8")); } catch { request = undefined; }
        if (/^v\d+\.\d+\.\d+/.test(request?.targetTag ?? "")) { kiosk.release = request.targetTag.slice(1); writeFileSync(systemPath, `${JSON.stringify({ release: kiosk.release })}\n`); }
        note(`update installed; reporting release ${kiosk.release}`);
      }
      else note(`service exited (${code}); restarting`);
      setTimeout(() => { if (!kiosk.stopping) kiosk.start(); }, 1000).unref();
    });
  };
  kiosk.stop = () => { kiosk.stopping = true; kiosk.child?.kill(); };
  kiosk.restart = () => { if (kiosk.child) { kiosk.restartRequested = true; kiosk.child.kill(); } else kiosk.start(); };
  kiosk.note = note;
  /** Sends one action to the kiosk's virtual hardware and returns its status. */
  kiosk.hardware = (message) => new Promise((resolveReply, rejectReply) => {
    if (!kiosk.child?.connected) { rejectReply(new Error(`${kiosk.name} is restarting`)); return; }
    const id = ++nextMessage;
    const timer = setTimeout(() => { waiting.delete(id); rejectReply(new Error(`${kiosk.name}'s virtual hardware didn't answer`)); }, 5000);
    waiting.set(id, { resolve: (value) => { clearTimeout(timer); resolveReply(value); }, reject: (error) => { clearTimeout(timer); rejectReply(error); } });
    kiosk.child.send({ id, ...message });
  });
  return kiosk;
}

async function kioskCall(kiosk, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${kiosk.port}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: response.status, body: json, text };
}

/** Pairs an unpaired kiosk as the local Admin would, and sets its settings PIN. */
async function pairKiosk(kiosk, { api }) {
  const health = await kioskCall(kiosk, "GET", "/health");
  if (!health.body?.paired) {
    // An unpaired kiosk's old record stays active until an Admin retires it, and two active kiosks can't share a name.
    for (const old of (await api.ok("GET", "/admin/kiosks")).kiosks.filter((item) => item.active && item.name === kiosk.name)) {
      await api.ok("DELETE", `/admin/kiosks/${encodeURIComponent(old.id)}`, { confirmation: "RETIRE KIOSK" });
      kiosk.note("retired its previous kiosk record");
    }
    const created = await api.ok("POST", "/admin/pairing-codes", { kioskName: kiosk.name });
    const paired = await kioskCall(kiosk, "POST", "/pair", { pairingKey: pairingKey(kiosk.linkUrl, created.code, kiosk.name) });
    if (paired.status >= 300) fail(`Pairing ${kiosk.name} failed: ${paired.text.slice(0, 300)}`);
    kiosk.note("paired");
  }
  const access = await kioskCall(kiosk, "GET", "/maintenance/session");
  if (!access.body?.configured) await kioskCall(kiosk, "POST", "/network/pin", { pin: virtualSettingsPin });
}

async function unpairKiosk(kiosk) {
  const unlocked = await kioskCall(kiosk, "POST", "/network/unlock", { pin: virtualSettingsPin });
  if (unlocked.status >= 300) fail(`Unlocking ${kiosk.name} failed: ${unlocked.text.slice(0, 300)}`);
  const result = await kioskCall(kiosk, "POST", "/maintenance/unpair", { confirmation: "UNPAIR" });
  if (result.status >= 300) fail(result.body?.error ?? `Unpairing ${kiosk.name} failed`);
  kiosk.note("unpaired");
}

async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; } }

async function kioskStatus(kiosk, api, worker) {
  let health; try { health = (await kioskCall(kiosk, "GET", "/health")).body; } catch { health = undefined; }
  const pairing = await readJson(join(kiosk.directory, "pairing.json"));
  const roster = await readJson(join(kiosk.directory, "roster-cache.json"));
  let lastSeenAt, commands = [];
  if (pairing?.kioskId) {
    const kiosks = await api.call("GET", "/admin/kiosks"); lastSeenAt = kiosks.body?.kiosks?.find((item) => item.id === pairing.kioskId)?.lastSeenAt;
    commands = ((await api.call("GET", `/admin/kiosks/${encodeURIComponent(pairing.kioskId)}/commands`)).body?.commands ?? []).slice(0, 6);
  }
  return {
    index: kiosk.index, name: kiosk.name, url: `http://127.0.0.1:${kiosk.port}/`, screenUrl: `http://127.0.0.1:${kiosk.screenPort}/`, running: Boolean(kiosk.child), starts: kiosk.starts, bootId: kiosk.boot.id,
    paired: Boolean(health?.paired), kioskId: pairing?.kioskId ?? null, cloudOnline: health?.cloudOnline ?? false,
    pendingScans: health?.attendance?.pending ?? health?.pendingEvents ?? null, rosterMembers: Array.isArray(roster?.members) ? roster.members.length : null,
    lastSeenAt: lastSeenAt ?? null, authenticationMethod: health?.authenticationMethod ?? null, readerOnline: health?.readerOnline ?? false,
    reader: await kiosk.hardware({ action: "status" }).catch(() => null), network: kiosk.network, linkOnline: worker.online && networkOnline(kiosk.network),
    nextBootClockSynced: kiosk.nextBootClockSynced, bootClockSynced: kiosk.boot.clockSynced, nextUpdate: kiosk.nextUpdate, release: kiosk.release,
    clockVerified: health?.clock?.verified ?? null, commands, events: kiosk.events,
  };
}

const kioskCommands = ["reload_display", "restart_service", "reboot", "reset_network_pin", "install_latest", "erase_unlinked_fingerprints"];

/** Queues a kiosk command as the dashboard's Manage kiosk page does. A virtual kiosk reports a development build, so an update confirms replacing it. */
async function queueCommand(kiosk, command, api) {
  const pairing = await readJson(join(kiosk.directory, "pairing.json"));
  if (!pairing?.kioskId) fail(`Pair ${kiosk.name} before sending it commands`);
  const path = `/admin/kiosks/${encodeURIComponent(pairing.kioskId)}/commands`;
  const first = await api.call("POST", path, { command });
  if (first.status === 409 && command === "install_latest" && /development build/.test(first.text)) return api.ok("POST", path, { command, replaceDevelopmentBuild: true });
  if (first.status < 200 || first.status >= 300) fail(first.body?.error ?? `Queuing ${command} returned ${first.status}`);
  return first.body;
}

async function readBody(request) { let body = ""; for await (const chunk of request) body += chunk; return JSON.parse(body || "{}"); }

function startPanel({ port, kiosks, worker, api, urls }) {
  const json = (response, status, value) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (pathname === "/" && request.method === "GET") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(await readFile(panelHtml)); return; }
      if (pathname === "/api/status" && request.method === "GET") {
        const members = ((await api.call("GET", "/admin/members")).body?.members ?? []).filter((member) => member.active !== false)
          .map((member) => ({ memberId: member.memberId, name: `${member.firstName} ${member.lastName}`.trim() }));
        return json(response, 200, { cloudOnline: worker.online, ...urls, members, kiosks: await Promise.all(kiosks.map((kiosk) => kioskStatus(kiosk, api, worker))) });
      }
      const reader = /^\/api\/kiosks\/(\d)\/reader$/.exec(pathname);
      if (reader && request.method === "POST") {
        const kiosk = kiosks[Number(reader[1])]; if (!kiosk) return json(response, 404, { error: "No such virtual kiosk" });
        const input = await readBody(request);
        if (!["present", "lift", "faults", "status"].includes(input.action)) return json(response, 400, { error: "Reader action must be present, lift, faults or status" });
        return json(response, 200, await kiosk.hardware({ action: input.action, finger: input.finger, holdMs: input.holdMs, faults: input.faults }));
      }
      const setting = /^\/api\/kiosks\/(\d)\/(network|system|command)$/.exec(pathname);
      if (setting && request.method === "POST") {
        const kiosk = kiosks[Number(setting[1])]; if (!kiosk) return json(response, 404, { error: "No such virtual kiosk" });
        const input = await readBody(request);
        if (setting[2] === "network") {
          if (!validNetworkState(input.network)) return json(response, 400, { error: "Network must be ethernet, none, or wifi with a listed network" });
          kiosk.network = input.network; await kiosk.hardware({ action: "network", network: input.network }).catch(() => undefined);
          kiosk.note(input.network.connection === "none" ? "network disconnected" : `network set to ${input.network.ssid ?? "Ethernet"}`);
          return json(response, 200, { network: kiosk.network });
        }
        if (setting[2] === "system") {
          if (input.nextUpdate !== undefined) {
            if (!["install", "fail"].includes(input.nextUpdate)) return json(response, 400, { error: "The next update must install or fail" });
            kiosk.nextUpdate = input.nextUpdate; await kiosk.hardware({ action: "next-update", outcome: input.nextUpdate }).catch(() => undefined);
          }
          if (input.nextBootClockSynced !== undefined) kiosk.nextBootClockSynced = Boolean(input.nextBootClockSynced);
          return json(response, 200, { nextUpdate: kiosk.nextUpdate, nextBootClockSynced: kiosk.nextBootClockSynced });
        }
        if (!kioskCommands.includes(input.command)) return json(response, 400, { error: `Command must be one of ${kioskCommands.join(", ")}` });
        kiosk.note(`dashboard command ${input.command} queued`);
        return json(response, 202, await queueCommand(kiosk, input.command, api));
      }
      if (pathname === "/api/cloud" && request.method === "POST") { worker.online = Boolean((await readBody(request)).online); return json(response, 200, { cloudOnline: worker.online }); }
      const route = /^\/api\/kiosks\/(\d)\/(pair|unpair|restart|reboot)$/.exec(pathname);
      if (route && request.method === "POST") {
        const kiosk = kiosks[Number(route[1])]; if (!kiosk) return json(response, 404, { error: "No such virtual kiosk" });
        if (route[2] === "pair") await pairKiosk(kiosk, { api });
        if (route[2] === "unpair") await unpairKiosk(kiosk);
        if (route[2] === "restart") { kiosk.note("restart requested from the panel"); kiosk.restart(); }
        if (route[2] === "reboot") { kiosk.newBoot(); kiosk.note(kiosk.boot.clockSynced ? "reboot requested from the panel" : "reboot without network time requested from the panel"); kiosk.restart(); }
        return json(response, 200, { ok: true });
      }
      json(response, 404, { error: "Not found" });
    } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function main() {
  const present = refusedMarkers.filter((name) => process.env[name]);
  if (present.length) fail(`The virtual kiosk runs only on a developer's computer or a CI test runner, and ${present.join(", ")} is set.`);
  const options = parseArguments(process.argv.slice(2));
  const ports = virtualPorts(options.portBase, options.kiosks); const stateRoot = options.state;
  if (options.reset) await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });

  const children = [];
  const log = (line) => console.log(line);
  const stopAll = () => { for (const kiosk of kiosksRef) kiosk.stop(); for (const child of children) child.kill(); };
  const kiosksRef = [];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { stopAll(); process.exit(130); });

  const runtime = await developmentRuntime({ stateDirectory: join(stateRoot, "preview"), apiPort: ports.api, dashboardPort: ports.dashboard });
  const wrangler = join(coreRoot, "node_modules/wrangler/bin/wrangler.js");
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  const migrate = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "lancerlogin-plugin-dev", "--local", "--config", runtime.configPath, "--persist-to", runtime.persistDirectory], { stdio: "inherit", cwd: coreRoot, env: { ...env, CI: "true" } });
  if (migrate.status !== 0) fail("Applying Core migrations to the local database failed");
  children.push(spawn(process.execPath, [wrangler, "dev", "--local", "--config", runtime.configPath, "--persist-to", runtime.persistDirectory, "--port", String(ports.api), "--ip", "localhost", "--test-scheduled"], { stdio: "inherit", cwd: coreRoot, env }));
  if (options.dashboard) children.push(spawn(process.execPath, [join(coreRoot, "node_modules/vite/bin/vite.js"), "--host", "localhost", "--port", String(ports.dashboard), "--strictPort"], { stdio: "inherit", cwd: join(coreRoot, "apps/dashboard"), env: { ...env, VITE_API_BASE_URL: runtime.apiUrl } }));
  for (const child of children) child.once("exit", (code) => { console.error(`A local preview server stopped (exit ${code}). Stopping the virtual kiosk.`); stopAll(); process.exit(1); });
  await waitFor(`${runtime.apiUrl}/setup/status`, { label: "The local Worker" });
  if (options.dashboard) await waitFor(runtime.dashboardUrl, { label: "The local dashboard" });

  const api = apiClient(runtime.apiUrl, runtime.dashboardUrl);
  const admin = await seedPreview(api, { setupCode: runtime.setupCode, adminPath: join(stateRoot, "admin.json") });
  // Whether the Worker is reachable at all; each kiosk also needs its own network to reach it.
  const worker = { online: true };

  for (const [index, port] of ports.kiosks.entries()) {
    const directory = join(stateRoot, `kiosk-${index + 1}`);
    // Owner-only, like /var/lib/lancerlogin: on Linux, unpairing refuses a state folder other users can read.
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    await mkdir(join(stateRoot, "readers"), { recursive: true });
    const kiosk = superviseKiosk({ index, port, screenPort: ports.screens[index], linkUrl: `http://127.0.0.1:${ports.links[index]}`, directory, readerPath: join(stateRoot, "readers", `kiosk-${index + 1}.json`), systemPath: join(stateRoot, "readers", `kiosk-${index + 1}.system.json`), log });
    startCloudLink({ port: ports.links[index], target: runtime.apiUrl, online: () => worker.online && networkOnline(kiosk.network) });
    startScreenProxy({ port: ports.screens[index], kioskPort: port, panelOrigin: `http://127.0.0.1:${ports.panel}` });
    kiosksRef.push(kiosk); kiosk.start();
    await waitFor(`http://127.0.0.1:${port}/health`, { label: kiosk.name, timeoutMs: 30_000 });
    await pairKiosk(kiosk, { api });
  }
  const urls = { panelUrl: `http://127.0.0.1:${ports.panel}/`, dashboardUrl: options.dashboard ? runtime.dashboardUrl : null, apiUrl: runtime.apiUrl, adminUsername: admin.username, adminFile: join(stateRoot, "admin.json") };
  startPanel({ port: ports.panel, kiosks: kiosksRef, worker, api, urls });
  console.log([
    "",
    `Virtual kiosk control panel: ${urls.panelUrl}`,
    options.dashboard ? `Local dashboard: ${runtime.dashboardUrl}  (sign in as ${admin.username}; the password is in ${urls.adminFile})` : `Local Worker: ${runtime.apiUrl}`,
    ...kiosksRef.map((kiosk) => `${kiosk.name}: http://127.0.0.1:${kiosk.port}/`),
    "Ctrl+C stops everything. State is kept in .provision/virtual-kiosk; --reset starts over.",
    "",
  ].join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Virtual kiosk failed: ${error instanceof VirtualKioskError ? error.message : error?.stack ?? String(error)}`);
    process.exit(1);
  });
}

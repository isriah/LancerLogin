import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOfflineQueue, createSensorAdapter, issuePairingCode, redeemPairingCode } from "../apps/kiosk/src/local-runtime.mjs";
import { completeKioskCommand, fetchKioskCommand, fetchKioskConfiguration, normalizeApiUrl, pairInstallation, sendAttendance, sendHeartbeat } from "../apps/kiosk/src/cloud-client.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { commandPacket, createR503, parseAcknowledgement } from "../apps/kiosk/src/r503.mjs";
import { kioskApp, kioskHtml, kioskReaderStatus, kioskStatusStyles, kioskStyles } from "../apps/kiosk/src/ui.mjs";
import { decodePairingKey } from "../apps/kiosk/src/pairing-key.mjs";
import { createScanner } from "../apps/kiosk/src/scanner.mjs";
import { kioskStates as presentationStates } from "../apps/kiosk/src/kiosk-presentation.mjs";
import { kioskStates as deviceStates } from "../apps/kiosk/src/kiosk-states.mjs";
import { createNetworkManager } from "../apps/kiosk/src/network-manager.mjs";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";
import { prepareLegacyFingerprintImport } from "../apps/kiosk/scripts/prepare-legacy-fingerprint-import.mjs";
import { networkApp, networkStyles } from "../apps/kiosk/src/network-ui.mjs";
import { maintenanceApp, maintenanceHtml, maintenanceLayoutStyles, maintenanceStyles } from "../apps/kiosk/src/maintenance-ui.mjs";
import { recoveryApp } from "../apps/kiosk/src/recovery-ui.mjs";
import { startVerifiedKioskUpdate } from "../apps/kiosk/src/update-command.mjs";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";

test("pairing code is hashed, single-use, and expires", () => {
  const issued = issuePairingCode({ now: () => 0, random: () => Buffer.from("123456") });
  assert.equal("code" in issued, true);
  assert.notEqual(issued.codeHash, issued.code);
  const redeemed = redeemPairingCode(issued, issued.code, new Date(1));
  assert.equal(redeemed.ok, true);
  assert.equal(redeemPairingCode(redeemed.record, issued.code, new Date(2)).ok, false);
  assert.equal(redeemPairingCode(issued, issued.code, new Date(999999999)).ok, false);
});

test("offline queue preserves order and retries without losing an event", async () => {
  const queue = createOfflineQueue();
  assert.equal(queue.enqueue({ id: "first" }), true);
  assert.equal(queue.enqueue({ id: "second" }), true);
  assert.equal(queue.enqueue({ id: "first" }), false);
  let calls = 0;
  assert.deepEqual(await queue.flush(async () => { calls += 1; if (calls === 2) throw new Error("offline"); }), ["first"]);
  assert.deepEqual(queue.pending().map((item) => item.id), ["second"]);
});

test("sensor adapter exposes slot matches, never a template", async () => {
  const adapter = createSensorAdapter({ status: async () => ({ connected: true, templateCount: 3 }), match: async () => ({ slot: 12, template: "must-not-leak" }) });
  assert.deepEqual(await adapter.test(), { readerOnline: true, templateCount: 3 });
  assert.deepEqual(await adapter.match(), { matched: true, slot: 12 });
});

test("guided installer previews safely and installs fixed, checksummed releases without Git", async () => {
  const installer = await readFile("apps/kiosk/scripts/install-lancerlogin.sh", "utf8");
  assert.match(installer, /--dry-run/);
  assert.match(installer, /--install/);
  assert.match(installer, /sha256sum --check/);
  assert.match(installer, /releases\/download\/v\$\{VERSION\}/);
  assert.match(installer, /Environment=LANCERLOGIN_VERSION=%s/);
  assert.match(installer, /Port 8788 is already used by another service/);
  assert.match(installer, /curl --fail --silent --show-error http:\/\/127\.0\.0\.1:8788\/health/);
  assert.match(installer, /systemctl restart lancerlogin-kiosk\.service/);
  assert.match(installer, /49-lancerlogin-network\.rules/);
  assert.match(installer, /49-lancerlogin-recovery\.rules/);
  assert.match(installer, /lancerlogin-update\.service/);
  assert.match(installer, /lancerlogin-install-release/);
  assert.match(installer, /same network.*one-time pairing key/);
  assert.match(installer, /lancerlogin-open-kiosk/);
  assert.match(installer, /LancerLogin Kiosk\.desktop/);
  assert.match(installer, /metadata::trusted/);
  assert.match(installer, /SUDO_USER/);
  assert.doesNotMatch(installer, /Worker API URL from the GitHub workflow summary/);
  assert.match(installer, /node_major.*-ge 18/s);
  assert.doesNotMatch(installer, /sudo -u/);
  assert.doesNotMatch(installer, /git clone/i);
});

test("systemd configures the R503 serial link on every service start", async () => {
  const unit = await readFile("apps/kiosk/systemd/lancerlogin-kiosk.service", "utf8");
  assert.match(unit, /SupplementaryGroups=dialout/);
  assert.match(unit, /ExecStartPre=\/bin\/stty -F \$\{LANCERLOGIN_SENSOR_PATH\} 57600/);
  assert.ok(unit.indexOf("ExecStartPre=") < unit.indexOf("ExecStart=/usr/bin/node"));
});

test("kiosk update unit permits only a checksum-verified latest stable release", async () => {
  const [helper, unit, policy] = await Promise.all([
    readFile("apps/kiosk/scripts/lancerlogin-install-release.sh", "utf8"),
    readFile("apps/kiosk/systemd/lancerlogin-update.service", "utf8"),
    readFile("apps/kiosk/polkit/49-lancerlogin-update.rules", "utf8"),
  ]);
  assert.match(helper, /repos\/isriah\/LancerLogin\/releases\/latest/);
  assert.match(helper, /release\.draft !== false/);
  assert.match(helper, /release\.prerelease !== false/);
  assert.match(helper, /accepts no arguments/);
  assert.match(helper, /install-lancerlogin\.sh\.sha256/);
  assert.match(helper, /sha256sum --check install-lancerlogin\.sh\.sha256/);
  assert.doesNotMatch(helper, /\$1|VERSION:-|GITHUB_API=.*\$/);
  assert.match(unit, /ExecStart=\/usr\/local\/sbin\/lancerlogin-install-release/);
  assert.match(policy, /subject\.user === "lancerlogin"/);
  assert.match(policy, /action\.lookup\("unit"\) === "lancerlogin-update\.service"/);
});

test("kiosk update handoff reports a failed verified systemd unit without changing its fixed target", async () => {
  const child = new EventEmitter(); child.unref = () => undefined;
  let invocation; let failure;
  startVerifiedKioskUpdate({
    spawnImpl: (...args) => { invocation = args; return child; },
    onFailure: (message) => { failure = message; },
  });
  assert.deepEqual(invocation, ["/usr/bin/systemctl", ["start", "lancerlogin-update.service"], { stdio: "ignore" }]);
  child.emit("exit", 1);
  await Promise.resolve();
  assert.equal(failure, "The verified kiosk update service failed with status 1");
});

test("one-time pairing key carries self-hosted routing without central discovery", () => {
  const value = { apiUrl: "https://example-api.example.workers.dev", code: "ABC123", kioskName: "Main kiosk" };
  const key = `LL1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  assert.deepEqual(decodePairingKey(key), value);
  assert.throws(() => decodePairingKey("ABC123"), /valid LancerLogin/);
});

test("network settings PIN is salted locally and rate limits repeated failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-network-pin-")); const path = join(directory, "pin.json"); let time = 1_000;
  try { const store = createNetworkPinStore(path, { now: () => time }); await store.set("123456"); const saved = await readFile(path, "utf8"); assert.doesNotMatch(saved, /123456/); store.close(); for (let attempt = 0; attempt < 5; attempt += 1) await store.verify("654321"); const locked = await store.verify("123456"); assert.equal(locked.authorized, false); assert.ok(locked.lockedUntil); time += 31_000; assert.equal((await store.verify("123456")).authorized, true); } finally { await rm(directory, { recursive: true }); }
});

test("dashboard recovery can clear the local settings PIN without retaining a credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-network-reset-")); const path = join(directory, "pin.json");
  try { const store = createNetworkPinStore(path); await store.set("123456"); assert.equal((await store.status()).configured, true); await store.reset(); assert.deepEqual(await store.status(), { configured: false, authorized: false, lockedUntil: null }); }
  finally { await rm(directory, { recursive: true }); }
});

test("NetworkManager adapter lists Wi-Fi without retaining passwords", async () => {
  const calls = []; const manager = createNetworkManager({ run: async (args) => { calls.push(args); if (args.includes("status")) return "wlan0:wifi:connected:Studio WiFi\neth0:ethernet:disconnected:\n"; if (args.includes("list")) return "*:Studio WiFi:82:WPA2\n:Guest:55:--\n"; return ""; } });
  assert.deepEqual((await manager.status()).connection, "Studio WiFi"); const networks = await manager.wifi(); assert.deepEqual(networks.map((item) => ({ ssid: item.ssid, secured: item.secured })), [{ ssid: "Studio WiFi", secured: true }, { ssid: "Guest", secured: false }]); assert.ok(calls.some((args) => args.includes("rescan") && args.includes("ifname") && args.includes("wlan0"))); assert.ok(calls.some((args) => args.includes("list") && args.includes("--rescan") && args.includes("no")));
});

test("network policy grants only narrow NetworkManager actions to the kiosk account", async () => {
  const policy = await readFile("apps/kiosk/polkit/49-lancerlogin-network.rules", "utf8");
  const allowed = [...policy.matchAll(/"(org\.freedesktop\.NetworkManager\.[^"]+)"/g)].map(([, action]) => action);
  assert.deepEqual(allowed, [
    "org.freedesktop.NetworkManager.enable-disable-wifi",
    "org.freedesktop.NetworkManager.network-control",
    "org.freedesktop.NetworkManager.settings.modify.system",
    "org.freedesktop.NetworkManager.wifi.scan",
  ]);
  assert.match(policy, /subject\.user === "lancerlogin"/);
  assert.doesNotMatch(policy, /polkit\.Result\.YES[\s\S]*return polkit\.Result\.YES/);
});

test("loopback display state exposes only a safe release version and local Wi-Fi remains PIN-protected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-network-service-"));
  const previousPinPath = process.env.LANCERLOGIN_NETWORK_PIN;
  const previousQueuePath = process.env.LANCERLOGIN_QUEUE;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousReleaseVersion = process.env.LANCERLOGIN_VERSION;
  process.env.LANCERLOGIN_NETWORK_PIN = join(directory, "network-pin.json");
  process.env.LANCERLOGIN_QUEUE = join(directory, "attendance-queue.json");
  const seedQueue = createFileQueue(process.env.LANCERLOGIN_QUEUE);
  await seedQueue.enqueue({ eventId: "review-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" });
  await seedQueue.flush(async () => ({ rejected: true, status: 409, code: "no_eligible_meeting" }));
  process.env.NODE_ENV = "test";
  delete process.env.LANCERLOGIN_VERSION;
  let service;
  try {
    service = await import("../apps/kiosk/src/service.mjs");
    service.network.wifi = async () => [{ ssid: "Workshop WiFi", signal: 91, secured: true, active: false }];
    await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
    const { port } = service.server.address();
    const request = (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options);

    assert.equal(service.localReleaseVersion("0.17.0"), "0.17.0");
    assert.equal(service.localReleaseVersion("development"), "development");
    assert.equal(service.localReleaseVersion(undefined), "development");
    assert.equal(service.localReleaseVersion("private host detail"), "development");
    const displayState = await (await request("/display-state")).json();
    assert.equal(displayState.releaseVersion, "development");
    assert.equal("credential" in displayState, false);
    assert.equal("sensorPath" in displayState, false);
    const health = await (await request("/health")).json();
    assert.equal("releaseVersion" in health, false);
    assert.deepEqual(health.attendance, { saved: 1, pending: 0, accepted: 0, duplicate: 0, rejected: 1, historyComplete: true });

    assert.equal((await request("/network/wifi")).status, 403);
    assert.equal((await request("/attendance/rejections")).status, 403);
    assert.equal((await request("/network/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "123456" }) })).status, 201);
    const scan = await request("/network/wifi");
    assert.equal(scan.status, 200);
    assert.deepEqual((await scan.json()).networks, [{ ssid: "Workshop WiFi", signal: 91, secured: true, active: false }]);
    const reviews = await (await request("/attendance/rejections")).json();
    assert.equal(reviews.rejections.length, 1);
    assert.equal(reviews.rejections[0].reasonCode, "no_eligible_meeting");
    assert.equal((await request("/attendance/rejections/review-1/review", { method: "POST" })).status, 200);
    assert.equal((await (await request("/attendance/rejections")).json()).rejections[0].reviewStatus, "reviewed");

    await request("/network/session", { method: "DELETE" });
    for (let attempt = 0; attempt < 5; attempt += 1) await request("/network/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "654321" }) });
    assert.equal((await request("/network/wifi")).status, 403);
    assert.equal((await request("/attendance/rejections")).status, 403);
  } finally {
    if (service?.server.listening) await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
    if (previousPinPath === undefined) delete process.env.LANCERLOGIN_NETWORK_PIN; else process.env.LANCERLOGIN_NETWORK_PIN = previousPinPath;
    if (previousQueuePath === undefined) delete process.env.LANCERLOGIN_QUEUE; else process.env.LANCERLOGIN_QUEUE = previousQueuePath;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousReleaseVersion === undefined) delete process.env.LANCERLOGIN_VERSION; else process.env.LANCERLOGIN_VERSION = previousReleaseVersion;
    await rm(directory, { recursive: true, force: true });
  }
});

test("network diagnostics exposes only connection type and active Wi-Fi signal", async () => {
  const manager = createNetworkManager({ run: async (args) => {
    if (args.includes("status")) return "wlan0:wifi:connected:Private WiFi\n";
    if (args.includes("IN-USE,SIGNAL")) return "*:73\n:41\n";
    return "";
  } });
  assert.deepEqual(await manager.diagnostics(), { type: "wifi", signal: 73 });
});

test("pairing client requires HTTPS and does not persist the one-time code", async () => {
  assert.throws(() => normalizeApiUrl("http://example.test"), /HTTPS/);
  let sent;
  const config = await pairInstallation({ apiUrl: "https://api.example.test/", code: "ab-cd", kioskName: "Front desk", fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ kioskId: "kiosk-1", kioskToken: "secret-token", name: "Front desk" }), { status: 201, headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { code: "AB-CD", kioskName: "Front desk" });
  assert.equal(config.apiUrl, "https://api.example.test");
  assert.equal("code" in config, false);
  assert.equal(config.kioskToken, "secret-token");
});

test("heartbeat authenticates with the kiosk token and reports only operational state", async () => {
  let request;
  await sendHeartbeat({ apiUrl: "https://api.example.test", kioskToken: "secret", kioskId: "kiosk-1" }, { readerOnline: true, releaseVersion: "1.0.0", uptimeSeconds: 3_600, networkType: "wifi", networkSignal: 82, lastWifiScanAt: "2026-09-02T20:00:00.000Z", credential: "must-not-send", rawScan: "must-not-send", wifiNetworks: ["must-not-send"], fetchImpl: async (_url, init) => { request = init; return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(request.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.body), { readerOnline: true, releaseVersion: "1.0.0", uptimeSeconds: 3_600, networkType: "wifi", networkSignal: 82, lastWifiScanAt: "2026-09-02T20:00:00.000Z", pendingEvents: 0, lastSyncAt: null, errorCategory: null });
});

test("kiosk configuration fetch is authenticated and contains no biometric request data", async () => {
  let request;
  const result = await fetchKioskConfiguration({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { fetchImpl: async (url, init) => { request = { url, init }; return new Response(JSON.stringify({ settings: { organizationName: "Example" } }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(request.url, "https://api.example.test/kiosk/config");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(result.settings, { organizationName: "Example" });
});

test("kiosk recovery client polls and completes fixed commands with its device credential", async () => {
  const calls = [];
  const config = { apiUrl: "https://api.example.test", kioskToken: "secret" };
  const pending = await fetchKioskCommand(config, { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ command: { id: "one", type: "reload_display" } }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(pending.command.type, "reload_display");
  await completeKioskCommand(config, "one", { success: true, message: "done" }, { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ completed: true }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.match(calls[1].url, /\/kiosk\/commands\/one\/result$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { success: true, message: "done" });
});

test("file queue survives restart, preserves order, and removes only delivered events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-")); const path = join(directory, "queue.json");
  try {
    const first = createFileQueue(path); await first.enqueue({ eventId: "one", memberId: "m1" }); await first.enqueue({ eventId: "two", memberId: "m2" });
    const restarted = createFileQueue(path); let calls = 0; assert.deepEqual(await restarted.flush(async () => { calls += 1; if (calls === 2) throw new Error("offline"); }), ["one"]);
    assert.deepEqual((await createFileQueue(path).pending()).map((event) => event.eventId), ["two"]);
  } finally { await rm(directory, { recursive: true }); }
});

test("concurrent replay sends each event once and keeps accepting new scans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-concurrent-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    await queue.enqueue({ eventId: "one", memberId: "m1" });
    await queue.enqueue({ eventId: "two", memberId: "m2" });
    let startFirst;
    const firstStarted = new Promise((resolve) => { startFirst = resolve; });
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    const sent = [];
    const first = queue.flush(async (event) => {
      sent.push(event.eventId);
      if (event.eventId === "one") { startFirst(); await firstHeld; }
    });
    await firstStarted;
    const second = queue.flush(async () => assert.fail("A second replay must join the active replay"));
    assert.equal(await queue.enqueue({ eventId: "three", memberId: "m3" }), true);
    releaseFirst();
    assert.deepEqual(await first, ["one", "two", "three"]);
    assert.deepEqual(await second, ["one", "two", "three"]);
    assert.deepEqual(sent, ["one", "two", "three"]);
    assert.deepEqual(await createFileQueue(path).pending(), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("an invalid queue file fails closed instead of discarding pending attendance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-invalid-")); const path = join(directory, "queue.json");
  try {
    await writeFile(path, "{broken");
    await assert.rejects(() => createFileQueue(path).enqueue({ eventId: "new", memberId: "m1" }));
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally { await rm(directory, { recursive: true }); }
});

test("a saved Saturday scan keeps its original time after restart and Wednesday replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-delayed-")); const path = join(directory, "queue.json");
  try {
    const occurredAt = "2026-09-19T12:00:00.000Z";
    await createFileQueue(path).enqueue({ eventId: "saturday-scan", memberId: "synthetic-member", occurredAt });
    const restarted = createFileQueue(path);
    const requests = [];
    const delivered = await restarted.flush(async (event) => {
      const result = await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "synthetic-token" }, event, {
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ accepted: true, eventId: event.eventId }), { status: 202, headers: { "content-type": "application/json" } });
        },
      });
      assert.equal(result.accepted, true);
    });
    assert.deepEqual(delivered, ["saturday-scan"]);
    assert.deepEqual(requests, [{ eventId: "saturday-scan", memberId: "synthetic-member", occurredAt }]);
    assert.deepEqual(await createFileQueue(path).pending(), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("interrupted replay leaves the original event for idempotent recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-interrupted-")); const path = join(directory, "queue.json");
  let child;
  try {
    await createFileQueue(path).enqueue({ eventId: "interrupted-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" });
    const source = "const {createFileQueue}=await import(process.argv[1]);const queue=createFileQueue(process.argv[2]);await queue.flush(async()=>{process.stdout.write('server-accepted\\n');await new Promise(()=>{})});";
    child = spawn(process.execPath, ["--input-type=module", "-e", source, new URL("../apps/kiosk/src/file-queue.mjs", import.meta.url).href, path], { stdio: ["ignore", "pipe", "pipe"] });
    let timeout;
    try { await Promise.race([once(child.stdout, "data"), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Replay child did not reach the send boundary")), 5_000); })]); }
    finally { clearTimeout(timeout); }
    child.kill();
    await once(child, "exit");
    assert.deepEqual((await createFileQueue(path).pending()).map((event) => event.eventId), ["interrupted-1"]);
    const restarted = createFileQueue(path);
    assert.deepEqual(await restarted.flush(async () => ({ duplicate: true })), ["interrupted-1"]);
    assert.deepEqual(await restarted.diagnostics(), { saved: 1, pending: 0, accepted: 0, duplicate: 1, rejected: 0, historyComplete: true });
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(directory, { recursive: true });
  }
});

test("rejected scans and safe reasons survive replay without blocking later valid scans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-rejected-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    await queue.enqueue({ eventId: "rejected-1", memberId: "synthetic-a", occurredAt: "2026-09-19T12:00:00.000Z" });
    await queue.enqueue({ eventId: "accepted-2", memberId: "synthetic-b", occurredAt: "2026-09-19T12:01:00.000Z" });
    await queue.enqueue({ eventId: "duplicate-3", memberId: "synthetic-c", occurredAt: "2026-09-19T12:02:00.000Z" });
    const sent = [];
    await queue.flush(async (event) => {
      sent.push(event.eventId);
      if (event.eventId === "rejected-1") return { rejected: true, status: 409, code: "no_eligible_meeting", error: "Do not store this raw message" };
      if (event.eventId === "duplicate-3") return { duplicate: true };
      return { accepted: true };
    });
    assert.deepEqual(sent, ["rejected-1", "accepted-2", "duplicate-3"]);
    const restarted = createFileQueue(path);
    assert.deepEqual(await restarted.diagnostics(), { saved: 3, pending: 0, accepted: 1, duplicate: 1, rejected: 1, historyComplete: true });
    assert.deepEqual(await restarted.rejections(), [{ eventId: "rejected-1", memberId: "synthetic-a", occurredAt: "2026-09-19T12:00:00.000Z", httpStatus: 409, reasonCode: "no_eligible_meeting", reviewStatus: "open" }]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
    assert.equal(await restarted.markReviewed("missing-event"), false);
    assert.equal(await restarted.markReviewed("rejected-1"), true);
    assert.equal((await createFileQueue(path).rejections())[0].reviewStatus, "reviewed");
    assert.deepEqual(await restarted.diagnostics(), { saved: 3, pending: 0, accepted: 1, duplicate: 1, rejected: 1, historyComplete: true });
    assert.equal((await readFile(path, "utf8")).includes("Do not store this raw message"), false);
  } finally { await rm(directory, { recursive: true }); }
});

test("the release 1.0.6 array queue upgrades without losing its pending scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-legacy-")); const path = join(directory, "queue.json");
  try {
    await writeFile(path, JSON.stringify([{ eventId: "legacy-1", memberId: "synthetic-a", occurredAt: "2026-09-19T12:00:00.000Z" }]));
    const queue = createFileQueue(path);
    assert.deepEqual(await queue.diagnostics(), { saved: 1, pending: 1, accepted: 0, duplicate: 0, rejected: 0, historyComplete: false });
    await queue.flush(async () => ({ rejected: true, status: 404, code: "roster_inactive" }));
    const restarted = createFileQueue(path);
    assert.deepEqual(await restarted.diagnostics(), { saved: 1, pending: 0, accepted: 0, duplicate: 0, rejected: 1, historyComplete: false });
    assert.equal((await restarted.rejections())[0].eventId, "legacy-1");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("recovery finishes a saved rejection after interruption between outcome and queue writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-recover-outcome-")); const path = join(directory, "queue.json");
  try {
    const event = { eventId: "saved-rejection-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" };
    await writeFile(path, `${JSON.stringify([event])}\n`);
    await writeFile(`${path}.outcomes.json`, `${JSON.stringify({ version: 1, accepted: 0, duplicate: 0,
      rejected: [{ ...event, httpStatus: 409, reasonCode: "no_eligible_meeting", reviewStatus: "open" }],
      pendingAck: { eventId: event.eventId }, historyComplete: false })}\n`);
    const queue = createFileQueue(path);
    assert.deepEqual(await queue.pending(), []);
    assert.deepEqual(await queue.flush(async () => assert.fail("A terminal rejection must not be sent again")), []);
    assert.deepEqual(await createFileQueue(path).diagnostics(), { saved: 1, pending: 0, accepted: 0, duplicate: 0, rejected: 1, historyComplete: false });
  } finally { await rm(directory, { recursive: true }); }
});

test("slot mappings remain local and reject malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-mapping-")); const path = join(directory, "mappings.json");
  try { const store = createMappingStore(path); const saved = await store.replace({ "12": { memberId: "member-1", finger: "right index" } }); assert.deepEqual(saved["12"], { memberId: "member-1", finger: "right index" }); assert.equal(await createMappingStore(path).memberForSlot(12), "member-1"); await assert.rejects(() => store.replace({ invalid: "member-2" }), /Invalid/); } finally { await rm(directory, { recursive: true }); }
});

test("legacy fingerprint import prepares roster and slot mappings without templates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-legacy-import-"));
  try {
    const rosterPath = join(directory, "old-roster.csv");
    const mappingsPath = join(directory, "old-mappings.json");
    const outDir = join(directory, "out");
    await writeFile(rosterPath, "student id,first,last,email\n321,Ada,Lovelace,ada@example.test\n322,Grace,Hopper,\n", "utf8");
    await writeFile(mappingsPath, JSON.stringify([{ slot: 12, memberId: "321", finger: "right index", template: "must-not-copy" }, { slot: 13, memberId: "missing", finger: "left thumb" }]), "utf8");
    const result = await prepareLegacyFingerprintImport({ rosterPath, mappingsPath, outDir });
    assert.equal(result.rosterCount, 2);
    assert.equal(result.mappingCount, 2);
    assert.deepEqual(result.unmapped, [{ slot: "13", memberId: "missing" }]);
    assert.match(await readFile(result.rosterOut, "utf8"), /memberId,firstName,lastName,email,discordUserId\n321,Ada,Lovelace,ada@example.test,/);
    assert.deepEqual(JSON.parse(await readFile(result.mappingsOut, "utf8")), { "12": { memberId: "321", finger: "right index" }, "13": { memberId: "missing", finger: "left thumb" } });
    assert.doesNotMatch(await readFile(result.mappingsOut, "utf8"), /must-not-copy/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("attendance client sends only identifiers and operational timestamps", async () => {
  let sent;
  await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { eventId: "event-1", memberId: "member-1", meetingId: "meeting-1", occurredAt: "2026-09-01T20:00:00Z", fingerprint: "must-not-send" }, { fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ accepted: true, eventId: "event-1" }), { headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { eventId: "event-1", memberId: "member-1", meetingId: "meeting-1", occurredAt: "2026-09-01T20:00:00Z" });
});

test("attendance client lets the Worker resolve a meeting and treats a rejected scan as delivered", async () => {
  let sent;
  const result = await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { eventId: "event-2", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z" }, { fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ error: "No meeting is accepting attendance scans at this time" }), { status: 409, headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { eventId: "event-2", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z" });
  assert.deepEqual(result, { accepted: false, rejected: true, status: 409, code: "no_eligible_meeting", error: "No meeting is accepting attendance scans at this time" });
});

test("temporary HTTP client failures stay pending for replay", async () => {
  const event = { eventId: "retry-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" };
  for (const status of [401, 403, 408, 425, 429]) {
    await assert.rejects(() => sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, event, {
      fetchImpl: async () => new Response(JSON.stringify({ error: "Try again" }), { status, headers: { "content-type": "application/json" } }),
    }), /Try again/);
  }
});

test("an ambiguous success response cannot remove a queued scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-ambiguous-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    const event = { eventId: "ambiguous-1", memberId: "synthetic-member", occurredAt: "2026-09-19T12:00:00.000Z" };
    await queue.enqueue(event);
    const delivered = await queue.flush((item) => sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, item, {
      fetchImpl: async () => new Response(JSON.stringify({ accepted: true, eventId: "different-event" }), { status: 202, headers: { "content-type": "application/json" } }),
    }));
    assert.deepEqual(delivered, []);
    assert.deepEqual((await createFileQueue(path).pending()).map((item) => item.eventId), ["ambiguous-1"]);
  } finally { await rm(directory, { recursive: true }); }
});

function acknowledgement(confirmation, parameters = []) {
  const length = parameters.length + 3; const content = [0x07, length >> 8, length & 0xff, confirmation, ...parameters]; const checksum = content.reduce((sum, value) => (sum + value) & 0xffff, 0);
  return Uint8Array.from([0xef, 0x01, 0xff, 0xff, 0xff, 0xff, ...content, checksum >> 8, checksum & 0xff]);
}

test("R503 packets are checksummed and expose only slot matches", async () => {
  assert.deepEqual([...commandPacket(0x1d)], [0xef, 0x01, 0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x03, 0x1d, 0x00, 0x21]);
  assert.deepEqual(parseAcknowledgement(acknowledgement(0, [0, 3])).parameters, Uint8Array.from([0, 3]));
  const replies = [acknowledgement(0), acknowledgement(0, [0, 3]), acknowledgement(0), acknowledgement(0), acknowledgement(0, [0, 12, 0, 80])];
  const sensor = createR503(async () => replies.shift());
  assert.deepEqual(await sensor.status(), { connected: true, templateCount: 3 });
  const match = await sensor.match();
  assert.deepEqual(match, { slot: 12, score: 80 });
  assert.equal(JSON.stringify(match).includes("template"), false);
});

test("R503 no-finger response is a normal unmatched scan", async () => {
  const sensor = createR503(async () => acknowledgement(0x02));
  assert.equal(await sensor.match(), undefined);
});

test("R503 semantic display states control only the reader aura LED", async () => {
  let packet;
  const sensor = createR503(async (value) => { packet = value; return acknowledgement(0); });
  await sensor.led({ color: 2, mode: 1, speed: 128, cycles: 0 });
  assert.equal(packet[9], 0x35);
  assert.deepEqual([...packet.slice(10, 14)], [1, 128, 2, 0]);
});

test("continuous scanner records a mapped match without a meeting ID", async () => {
  const displays = []; const queued = []; const led = [];
  const scanner = createScanner({
    scanSensor: async () => ({ status: "match", slot: 12, score: 80 }), setLed: async (state) => led.push(state), mappings: { memberForSlot: async () => "ROSTER-001" },
    queue: { pending: async () => [...queued], enqueue: async (event) => { queued.push(event); return true; } }, loadPairing: async () => ({ kioskToken: "secret" }),
    flushAttendance: async () => ({ acknowledgements: [{ eventId: "scan-1", action: "check_in", member: { displayName: "Avery Stone" }, meeting: { title: "Build" } }] }),
    onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined, onCloud: () => undefined,
    now: () => Date.parse("2026-09-01T20:00:00.000Z"), delay: async () => undefined, eventId: () => "scan-1",
  });
  await scanner.tick();
  assert.deepEqual(queued, [{ eventId: "scan-1", memberId: "ROSTER-001", occurredAt: "2026-09-01T20:00:00.000Z" }]);
  assert.deepEqual(displays.map((item) => item.state), ["processing", "welcome"]);
  assert.equal(displays.at(-1).name, "Avery Stone");
  assert.deepEqual(led, ["processing", "welcome"]);
});

test("a second member can scan while the first network replay is still waiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-rapid-scans-")); const path = join(directory, "queue.json");
  try {
    const queue = createFileQueue(path);
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    const sent = []; const displays = [];
    let activeFlush; let sequence = 0;
    const scanner = createScanner({
      scanSensor: async () => ({ status: "match", slot: ++sequence === 1 ? 12 : 14 }),
      setLed: async () => undefined, mappings: { memberForSlot: async (slot) => slot === 12 ? "member-a" : "member-b" }, queue,
      loadPairing: async () => ({ kioskToken: "synthetic" }),
      flushAttendance: () => {
        if (!activeFlush) activeFlush = (async () => {
          const acknowledgements = [];
          const delivered = await queue.flush(async (event) => {
            sent.push(event.eventId);
            if (event.eventId === "rapid-1") await firstHeld;
            const result = { accepted: true, member: { displayName: event.memberId } };
            acknowledgements.push({ eventId: event.eventId, ...result });
            return result;
          });
          return { delivered, acknowledgements };
        })();
        return activeFlush;
      },
      onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined, onCloud: () => undefined,
      now: () => Date.parse("2026-09-19T12:00:00.000Z") + sequence * 1000,
      delay: async () => undefined, eventId: () => `rapid-${sequence}`, flushWaitMs: 5,
    });
    await scanner.tick();
    await scanner.tick();
    assert.deepEqual((await queue.pending()).map((event) => event.memberId), ["member-a", "member-b"]);
    assert.deepEqual(displays.map((entry) => entry.state), ["processing", "welcome", "processing", "welcome"]);
    assert.equal(displays.some((entry) => entry.name), false);
    releaseFirst();
    await activeFlush;
    assert.deepEqual(sent, ["rapid-1", "rapid-2"]);
    assert.deepEqual(await queue.pending(), []);
  } finally { await rm(directory, { recursive: true }); }
});

test("scan feedback preserves semantic states, copy, durations, and reader aura behavior", () => {
  assert.deepEqual(
    Object.fromEntries(["processing", "duplicate", "offline", "unknown", "rejected"].map((id) => [id, presentationStates[id]])),
    {
      processing: { message: "Checking scan", detail: "Hold still", tone: "processing" },
      duplicate: { message: "Already recorded", detail: "Attendance was not changed", tone: "notice", durationMs: 2200 },
      offline: { message: "Saved for sync", detail: "This scan is stored on the kiosk and will sync automatically", tone: "offline", durationMs: 2600 },
      unknown: { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help", tone: "error", durationMs: 2600 },
      rejected: { message: "Scan needs help", detail: "Ask an operator for help", tone: "error", durationMs: 2800 },
    },
  );
  assert.deepEqual(deviceStates.processing.led, { color: 3, mode: 3, speed: 64, cycles: 0 });
  assert.deepEqual(deviceStates.duplicate.led, { color: 3, mode: 2, speed: 56, cycles: 2 });
  assert.deepEqual(deviceStates.offline.led, { color: 1, mode: 2, speed: 64, cycles: 1 });
});

test("scanner keeps offline saved, rejected, and unknown outcomes textually distinct", async () => {
  async function displaysFor(scanSensor, flushAttendance) {
    const displays = [];
    const scanner = createScanner({
      scanSensor, setLed: async () => undefined, mappings: { memberForSlot: async () => "ROSTER-001" },
      queue: { pending: async () => [], enqueue: async () => true }, loadPairing: async () => ({ kioskToken: "secret" }), flushAttendance,
      onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined, onCloud: () => undefined,
      now: () => Date.parse("2026-09-01T20:00:00.000Z"), delay: async () => undefined, eventId: () => "scan-1",
    });
    await scanner.tick();
    return displays;
  }

  assert.deepEqual(await displaysFor(async () => ({ status: "match", slot: 12 }), async () => { throw new Error("offline"); }), [{ state: "processing" }, { state: "welcome", detail: "Saved for sync | Welcome" }]);
  const rejected = await displaysFor(async () => ({ status: "match", slot: 12 }), async () => ({ acknowledgements: [{ eventId: "scan-1", rejected: true, error: "No eligible meeting" }] }));
  assert.deepEqual(rejected, [{ state: "processing" }, { state: "rejected", detail: "No eligible meeting" }]);
  assert.deepEqual(await displaysFor(async () => ({ status: "not_found" }), async () => ({ acknowledgements: [] })), [{ state: "unknown" }]);
});

let syntheticRuntimeId = 0;
function queuedScanner(queue, flushAttendance = async () => { throw new Error("offline"); }) {
  const runtimeId = ++syntheticRuntimeId;
  let time = Date.parse("2026-09-01T20:00:00.000Z"); let sequence = 0; let observation;
  const displays = []; const leds = []; const clouds = [];
  const scanner = createScanner({
    queue, flushAttendance, scanSensor: async () => observation,
    mappings: { memberForSlot: async (slot) => ({ 12: "m1", 13: "m1", 14: "m2" })[slot] },
    setLed: async (id) => leds.push(id), loadPairing: async () => ({ kioskId: "synthetic-kiosk" }),
    onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined,
    onCloud: (online) => clouds.push(online), now: () => time, delay: async () => undefined,
    eventId: () => `synthetic-${runtimeId}-${time}-${++sequence}`,
  });
  return { displays, leds, clouds, async scan(slot, elapsed = 8_001) {
    time += elapsed; observation = typeof slot === "number" ? { status: "match", slot } : { status: slot };
    await scanner.tick(); return displays.at(-1);
  } };
}

test("offline direction is independent per member and shared by mapped fingers; held and unknown scans do not advance it", async () => {
  const events = [];
  const queue = { pending: async () => [...events], enqueue: async (event) => { events.push(event); return true; } };
  const runtime = queuedScanner(queue);
  assert.deepEqual(await runtime.scan(12), { state: "welcome", detail: "Saved for sync | Welcome" });
  const displayCount = runtime.displays.length;
  await runtime.scan(12, 100);
  assert.equal(runtime.displays.length, displayCount);
  assert.equal(events.length, 1);
  assert.equal((await runtime.scan("not_found")).state, "unknown");
  assert.equal((await runtime.scan(99)).state, "unknown");
  assert.equal((await runtime.scan("no_finger")).state, "unknown");
  assert.deepEqual(await runtime.scan(14), { state: "welcome", detail: "Saved for sync | Welcome" });
  assert.deepEqual(await runtime.scan(13), { state: "goodbye", detail: "Saved for sync | Goodbye" });
  assert.deepEqual(await runtime.scan(12), { state: "welcome", detail: "Saved for sync | Welcome" });
  assert.deepEqual(await runtime.scan(14), { state: "goodbye", detail: "Saved for sync | Goodbye" });
  assert.deepEqual(runtime.leds.filter((id) => id === "welcome" || id === "goodbye"), ["welcome", "welcome", "goodbye", "welcome", "goodbye"]);
  assert.deepEqual(runtime.clouds, [false, false, false, false, false]);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["eventId", "memberId", "occurredAt"]);
});

test("offline estimates survive restart using durable events and conservatively recalculate after partial/background replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-offline-direction-")); const path = join(directory, "queue.json");
  try {
    const first = queuedScanner(createFileQueue(path));
    await first.scan(12); await first.scan(14);
    const queue = createFileQueue(path); const restarted = queuedScanner(queue);
    assert.deepEqual(await restarted.scan(13), { state: "goodbye", detail: "Saved for sync | Goodbye" });
    const beforeReplay = await queue.pending(); const sent = [];
    await queue.flush(async (event) => { if (sent.length === 1) throw new Error("offline"); sent.push(event.eventId); });
    assert.deepEqual(sent, [beforeReplay[0].eventId]);
    assert.deepEqual(await restarted.scan(12), { state: "goodbye", detail: "Saved for sync | Goodbye" });
    await queue.flush(async (event) => sent.push(event.eventId));
    assert.equal(new Set(sent).size, sent.length);
    assert.deepEqual(await createFileQueue(path).pending(), []);
    assert.deepEqual(await restarted.scan(13), { state: "welcome", detail: "Saved for sync | Welcome" });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.length, 1);
    assert.deepEqual(Object.keys(persisted[0]).sort(), ["eventId", "memberId", "occurredAt"]);
  } finally { await rm(directory, { recursive: true }); }
});

test("Worker acknowledgements override estimates; confirmed, duplicate and rejected events reset pending history", async () => {
  for (const result of [{ action: "check_out" }, { action: "check_in" }, { duplicate: true }, { rejected: true, error: "No eligible meeting" }]) {
    const events = []; let connected = true;
    const queue = { pending: async () => [...events], enqueue: async (event) => { events.push(event); return true; } };
    const runtime = queuedScanner(queue, async () => {
      if (!connected) throw new Error("offline");
      return { acknowledgements: events.splice(0).map((event) => ({ eventId: event.eventId, ...result, member: { displayName: "Synthetic Member" }, meeting: { title: "Synthetic Meeting" } })) };
    });
    const display = await runtime.scan(12);
    assert.equal(display.state, result.rejected ? "rejected" : result.duplicate ? "duplicate" : result.action === "check_out" ? "goodbye" : "welcome");
    assert.equal(display.detail?.includes("Saved for sync") ?? false, false);
    assert.deepEqual(await queue.pending(), []);
    assert.deepEqual(runtime.clouds, [true]);
    connected = false;
    assert.deepEqual(await runtime.scan(13), { state: "welcome", detail: "Saved for sync | Welcome" });
  }
});

test("failed local save, queue read and duplicate enqueue never claim saved feedback or contact cloud", async () => {
  for (const queue of [
    { pending: async () => [], enqueue: async () => { throw new Error("disk full"); } },
    { pending: async () => { throw new Error("queue unreadable"); }, enqueue: async () => true },
    { pending: async () => [], enqueue: async () => false },
  ]) {
    const runtime = queuedScanner(queue, async () => assert.fail("An unsaved scan must not flush attendance"));
    assert.deepEqual(await runtime.scan(12), { state: "rejected", detail: "This scan could not be saved. Ask an operator for help." });
    assert.deepEqual(runtime.clouds, []);
    assert.deepEqual(runtime.leds, ["processing", "rejected"]);
  }
});

test("R503 enrollment creates and stores a template without returning biometric data", async () => {
  const replies = [acknowledgement(0), acknowledgement(0), acknowledgement(0x02), acknowledgement(0), acknowledgement(0), acknowledgement(0), acknowledgement(0)];
  const instructions = [];
  const progress = [];
  const sensor = createR503(async (packet) => { instructions.push(packet[9]); return replies.shift(); });
  const enrolled = await sensor.enroll(12, { attempts: 2, delayMs: 0, onProgress: async (state) => progress.push(state) });
  assert.deepEqual(enrolled, { slot: 12 });
  assert.deepEqual(instructions, [0x01, 0x02, 0x01, 0x01, 0x02, 0x05, 0x06]);
  assert.deepEqual(progress, ["enroll_wait_first", "enroll_scan_accepted", "enroll_wait_second", "enroll_success"]);
  assert.equal(JSON.stringify(enrolled).includes("template"), false);
});

test("R503 enrollment errors are plain language for touch users", async () => {
  const sensor = createR503(async () => acknowledgement(0x0a));
  await assert.rejects(() => sensor.enroll(12, { attempts: 1, delayMs: 0 }), (error) => {
    assert.match(error.message, /finger may already be stored|same finger/i);
    assert.doesNotMatch(error.message, /0x0a|R503/);
    return true;
  });
});

test("local kiosk UI is touch-sized, accessible, and self-contained", () => {
  assert.match(kioskHtml, /<main id="kiosk"/);
  assert.match(kioskHtml, /aria-live="polite"/);
  assert.match(kioskHtml, /Place finger on reader/);
  assert.doesNotMatch(kioskHtml, /maintenance-status|>FP</);
  assert.match(kioskHtml, /One-time pairing key/);
  assert.doesNotMatch(kioskHtml, /Roster member ID|Meeting ID|Enroll fingerprint/);
  assert.match(kioskStyles, /max-height:520px/);
  assert.match(kioskStyles, /adaptive-logo/);
  assert.match(kioskStyles, /\.kiosk-brand\.holding/);
  assert.match(kioskApp, /\/display-state/);
  assert.match(kioskApp, /\/pair/);
  assert.match(kioskApp, /adaptLogo/);
  assert.match(kioskApp, /brand-logo-frame/);
  assert.match(kioskHtml, /\/network\.js/);
  assert.match(kioskHtml, /id="uptime"/);
  assert.match(kioskApp, /uptimeSeconds/);
  assert.match(kioskApp, /networkType === "ethernet"/);
  assert.match(kioskStatusStyles, /network-status\.ethernet/);
  assert.match(kioskStyles, /processing-sweep 900ms ease-out 1/);
  assert.match(kioskStyles, /duplicate-flash 420ms ease-in-out 3/);
  assert.match(kioskStyles, /kiosk-shell-offline[^}]*success-pulse/);
  assert.match(kioskStyles, /network-status\.offline[^}]*network-offline-pulse/);
  assert.match(kioskStyles, /prefers-reduced-motion:reduce/);
  assert.match(kioskStyles, /kiosk-shell-processing\{box-shadow:[^}]*processing-sweep-color/);
  assert.match(kioskStyles, /network-status\.offline\{opacity:1;transform:none\}/);
  assert.match(kioskHtml, /\/recovery\.js/);
  assert.match(networkApp, /setTimeout\(openNetwork,3000\)/);
  assert.match(networkApp, /touch-keyboard/);
  assert.match(networkApp, /network-create-keypad/);
  assert.match(networkApp, /appendPinDigit/);
  assert.match(networkStyles, /pin-keypad/);
  assert.match(kioskApp, /\/maintenance/);
  assert.match(maintenanceHtml, /Fingerprint maintenance/);
  assert.match(maintenanceHtml, /pin-keypad/);
  assert.match(maintenanceHtml, /member-picker/);
  assert.match(maintenanceHtml, /slot-keypad/);
  assert.match(maintenanceStyles, /100vh/);
  assert.match(maintenanceStyles, /\[hidden\]\{display:none!important\}/);
  assert.match(maintenanceStyles, /option-list/);
  assert.match(maintenanceStyles, /stage-enroll_wait_first/);
  assert.match(maintenanceLayoutStyles, /calc\(100vw - 16px\)/);
  assert.match(maintenanceApp, /Begin two-scan enrollment|\/enroll/);
  assert.match(maintenanceApp, /startStagePolling/);
  assert.match(maintenanceApp, /friendlyError/);
  assert.match(maintenanceApp, /buildSlotKeypad/);
  assert.match(recoveryApp, /displayReloadToken/);
  assert.doesNotMatch(kioskHtml, /https?:\/\//);
});

test("kiosk footer shows the release version without masking reader failures", () => {
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "0.17.0" }), "LancerLogin 0.17.0");
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "development" }), "LancerLogin development");
  assert.equal(kioskReaderStatus({ readerOnline: true }), "LancerLogin development");
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "  " }), "LancerLogin development");
  assert.equal(kioskReaderStatus({ readerOnline: false, releaseVersion: "0.17.0" }), "Fingerprint reader offline");
  assert.match(kioskApp, /kioskReaderStatus\(value\)/);
  assert.doesNotMatch(kioskApp, /Fingerprint reader online/);
});

test("root helper executes strict release validation before any download", async () => {
  const helper = await readFile("apps/kiosk/scripts/lancerlogin-install-release.sh", "utf8");
  const validator = helper.split("/usr/bin/node -e '")[1].split("' \"$temporary/release.json\"")[0];
  assert.ok(validator.includes("required.every"));
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-release-validation-"));
  const path = join(scratch, "release.json");
  const release = tag => ({ tag_name: tag, draft: false, prerelease: false, assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap(arch => {
    const archive = `lancerlogin-kiosk-${tag.slice(1)}-linux-${arch}.tar.gz`;
    return [archive, `${archive}.sha256`];
  })].map(name => ({ name })) });
  try {
    for (const tag of ["v0.24.0", "v1.0.0", "v12.3.45", "v01.0.0", "v1.00.0", "v1.0.00", "v1.0.0-beta", "v1.0.0+build", "v1.0.0\n", "v1.0.0/evil"]) {
      await writeFile(path, JSON.stringify(release(tag)));
      const result = spawnSync(process.execPath, ["-e", validator, path], { encoding: "utf8" });
      const valid = ["v0.24.0", "v1.0.0", "v12.3.45"].includes(tag);
      assert.equal(result.status, valid ? 0 : 2, tag);
      assert.equal(result.stdout, valid ? tag.slice(1) : "");
    }
    const good = release("v1.0.0");
    for (const payload of [{ ...good, draft: true }, { ...good, prerelease: true }, { ...good, draft: undefined }, { ...good, prerelease: "false" }, { ...good, assets: undefined }, ...good.assets.map(missing => ({ ...good, assets: good.assets.filter(asset => asset !== missing) }))]) {
      await writeFile(path, JSON.stringify(payload));
      assert.equal(spawnSync(process.execPath, ["-e", validator, path]).status, 2);
    }
    assert.equal((helper.match(/curl .*GITHUB_API/g) || []).length, 1);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

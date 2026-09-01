import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOfflineQueue, createSensorAdapter, issuePairingCode, redeemPairingCode } from "../apps/kiosk/src/local-runtime.mjs";
import { fetchKioskConfiguration, normalizeApiUrl, pairInstallation, sendAttendance, sendHeartbeat } from "../apps/kiosk/src/cloud-client.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { commandPacket, createR503, parseAcknowledgement } from "../apps/kiosk/src/r503.mjs";
import { kioskApp, kioskHtml, kioskStyles } from "../apps/kiosk/src/ui.mjs";
import { decodePairingKey } from "../apps/kiosk/src/pairing-key.mjs";
import { createScanner } from "../apps/kiosk/src/scanner.mjs";

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
  assert.match(installer, /same network.*one-time pairing key/);
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

test("one-time pairing key carries self-hosted routing without central discovery", () => {
  const value = { apiUrl: "https://example-api.example.workers.dev", code: "ABC123", kioskName: "Main kiosk" };
  const key = `LL1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  assert.deepEqual(decodePairingKey(key), value);
  assert.throws(() => decodePairingKey("ABC123"), /valid LancerLogin/);
});

test("tagged release archive includes every kiosk runtime module", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  for (const module of [
    "service.mjs",
    "ui.mjs",
    "cloud-client.mjs",
    "file-queue.mjs",
    "mapping-store.mjs",
    "r503.mjs",
    "serial-transport.mjs",
    "pair-cli.mjs",
    "pairing-key.mjs",
    "kiosk-states.mjs",
    "scanner.mjs",
  ]) {
    assert.match(workflow, new RegExp(`apps/kiosk/src/${module.replace(".", "\\.")}`));
  }
  assert.match(workflow, /LANCERLOGIN_VERSION:-\$\{version\}/);
  assert.match(workflow, /release\/artifacts\/install-lancerlogin\.sh/);
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$commit&status=success/);
  assert.match(workflow, /package_version=\$\(jq -r \.version package\.json\)/);
  assert.match(workflow, /GITHUB_REF_NAME.*v\$package_version/);
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
  await sendHeartbeat({ apiUrl: "https://api.example.test", kioskToken: "secret", kioskId: "kiosk-1" }, { readerOnline: true, releaseVersion: "1.0.0", fetchImpl: async (_url, init) => { request = init; return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(request.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(request.body), { readerOnline: true, releaseVersion: "1.0.0", pendingEvents: 0, lastSyncAt: null, errorCategory: null });
});

test("kiosk configuration fetch is authenticated and contains no biometric request data", async () => {
  let request;
  const result = await fetchKioskConfiguration({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { fetchImpl: async (url, init) => { request = { url, init }; return new Response(JSON.stringify({ settings: { organizationName: "Example" } }), { headers: { "content-type": "application/json" } }); } });
  assert.equal(request.url, "https://api.example.test/kiosk/config");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(result.settings, { organizationName: "Example" });
});

test("file queue survives restart, preserves order, and removes only delivered events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-")); const path = join(directory, "queue.json");
  try {
    const first = createFileQueue(path); await first.enqueue({ eventId: "one", memberId: "m1" }); await first.enqueue({ eventId: "two", memberId: "m2" });
    const restarted = createFileQueue(path); let calls = 0; assert.deepEqual(await restarted.flush(async () => { calls += 1; if (calls === 2) throw new Error("offline"); }), ["one"]);
    assert.deepEqual((await createFileQueue(path).pending()).map((event) => event.eventId), ["two"]);
  } finally { await rm(directory, { recursive: true }); }
});

test("slot mappings remain local and reject malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-mapping-")); const path = join(directory, "mappings.json");
  try { const store = createMappingStore(path); await store.replace({ "12": "member-1" }); assert.equal(await createMappingStore(path).memberForSlot(12), "member-1"); await assert.rejects(() => store.replace({ invalid: "member-2" }), /Invalid/); } finally { await rm(directory, { recursive: true }); }
});

test("attendance client sends only identifiers and operational timestamps", async () => {
  let sent;
  await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { eventId: "event-1", memberId: "member-1", meetingId: "meeting-1", occurredAt: "2026-09-01T20:00:00Z", fingerprint: "must-not-send" }, { fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ accepted: true }), { headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { eventId: "event-1", memberId: "member-1", meetingId: "meeting-1", occurredAt: "2026-09-01T20:00:00Z" });
});

test("attendance client lets the Worker resolve a meeting and treats a rejected scan as delivered", async () => {
  let sent;
  const result = await sendAttendance({ apiUrl: "https://api.example.test", kioskToken: "secret" }, { eventId: "event-2", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z" }, { fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ error: "No meeting is accepting attendance scans at this time" }), { status: 409, headers: { "content-type": "application/json" } }); } });
  assert.deepEqual(sent, { eventId: "event-2", memberId: "member-1", occurredAt: "2026-09-01T20:00:00Z" });
  assert.deepEqual(result, { accepted: false, rejected: true, error: "No meeting is accepting attendance scans at this time" });
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
    queue: { enqueue: async (event) => { queued.push(event); return true; } }, loadPairing: async () => ({ kioskToken: "secret" }),
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

test("R503 enrollment creates and stores a template without returning biometric data", async () => {
  const replies = [acknowledgement(0), acknowledgement(0), acknowledgement(0x02), acknowledgement(0), acknowledgement(0), acknowledgement(0), acknowledgement(0)];
  const instructions = [];
  const sensor = createR503(async (packet) => { instructions.push(packet[9]); return replies.shift(); });
  const enrolled = await sensor.enroll(12, { attempts: 2, delayMs: 0 });
  assert.deepEqual(enrolled, { slot: 12 });
  assert.deepEqual(instructions, [0x01, 0x02, 0x01, 0x01, 0x02, 0x05, 0x06]);
  assert.equal(JSON.stringify(enrolled).includes("template"), false);
});

test("local kiosk UI is touch-sized, accessible, and self-contained", () => {
  assert.match(kioskHtml, /<main id="kiosk"/);
  assert.match(kioskHtml, /aria-live="polite"/);
  assert.match(kioskHtml, /Place finger on reader/);
  assert.match(kioskHtml, /One-time pairing key/);
  assert.doesNotMatch(kioskHtml, /Roster member ID|Meeting ID|Enroll fingerprint/);
  assert.match(kioskStyles, /max-height:520px/);
  assert.match(kioskApp, /\/display-state/);
  assert.match(kioskApp, /\/pair/);
  assert.doesNotMatch(kioskHtml, /https?:\/\//);
});

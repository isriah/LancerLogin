import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOfflineQueue, createSensorAdapter, issuePairingCode, redeemPairingCode } from "../apps/kiosk/src/local-runtime.mjs";
import { normalizeApiUrl, pairInstallation, sendAttendance, sendHeartbeat } from "../apps/kiosk/src/cloud-client.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";

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
  assert.doesNotMatch(installer, /git clone/i);
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
  assert.deepEqual(JSON.parse(request.body), { readerOnline: true, releaseVersion: "1.0.0" });
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOfflineQueue, createSensorAdapter, issuePairingCode, redeemPairingCode } from "../apps/kiosk/src/local-runtime.mjs";
import { normalizeApiUrl, pairInstallation, sendHeartbeat } from "../apps/kiosk/src/cloud-client.mjs";

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

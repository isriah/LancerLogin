import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOfflineQueue, createSensorAdapter, issuePairingCode, redeemPairingCode } from "../apps/kiosk/src/local-runtime.mjs";

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

test("guided installer remains mock-only and does not clone source", async () => {
  const installer = await readFile("apps/kiosk/scripts/install-lancerlogin.sh", "utf8");
  assert.match(installer, /--dry-run/);
  assert.match(installer, /exit 2/);
  assert.doesNotMatch(installer, /git clone|curl |wget /i);
});

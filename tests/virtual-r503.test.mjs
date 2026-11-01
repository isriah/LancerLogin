import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createR503 } from "../apps/kiosk/src/r503.mjs";
import { createVirtualR503 } from "../scripts/virtual-kiosk/virtual-r503.mjs";

// The kiosk's real R503 driver, talking to the virtual reader.
async function enroll(reader, virtual, slot, finger) {
  return reader.enroll(slot, { delayMs: 0, onProgress: async (step) => {
    if (step === "enroll_wait_first" || step === "enroll_wait_second") virtual.present(finger);
    if (step === "enroll_scan_accepted") virtual.lift();
  } });
}

test("the real driver enrolls, finds and deletes fingers on the virtual reader, and the library survives a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "virtual-r503-"));
  try {
    const path = join(directory, "reader.json");
    const virtual = createVirtualR503({ path }); const reader = createR503(virtual.exchange);
    assert.deepEqual(await reader.status(), { connected: true, templateCount: 0 });
    assert.deepEqual(await reader.scan(), { status: "no_finger" });

    await enroll(reader, virtual, 3, "member:1001:1");
    virtual.lift();
    assert.deepEqual(await reader.occupiedSlots(), [3]);
    virtual.present("member:1001:1");
    assert.deepEqual(await reader.scan(), { status: "match", slot: 3, score: 180 });
    virtual.present("member:1002:1");
    assert.deepEqual(await reader.scan(), { status: "not_found" });

    const restarted = createR503(createVirtualR503({ path }).exchange);
    assert.deepEqual(await restarted.status(), { connected: true, templateCount: 1 });
    await reader.deleteTemplate(3);
    assert.deepEqual(await reader.occupiedSlots(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("enrollment with two different fingers fails as the reader does", async () => {
  const virtual = createVirtualR503(); const reader = createR503(virtual.exchange);
  let second = false;
  await assert.rejects(reader.enroll(0, { delayMs: 0, onProgress: async (step) => {
    if (step === "enroll_wait_first") virtual.present("member:1001:1");
    if (step === "enroll_scan_accepted") virtual.lift();
    if (step === "enroll_wait_second") { second = true; virtual.present("member:1001:2"); }
  } }), /could not combine those scans/);
  assert.equal(second, true);
});

test("faults: image errors, no match, a chosen score, a tapped finger and an unplugged reader", async () => {
  const virtual = createVirtualR503({ timeoutMs: 10 }); const reader = createR503(virtual.exchange);
  await enroll(reader, virtual, 0, "member:1001:1");
  virtual.present("member:1001:1");

  virtual.setFaults({ image: "faint" });
  await assert.rejects(reader.scan(), /too faint/);
  assert.equal((await reader.scan()).status, "match", "an image fault lasts one read by default");

  virtual.setFaults({ noMatch: true });
  assert.deepEqual(await reader.scan(), { status: "not_found" });
  virtual.setFaults({ noMatch: false, score: 40 });
  assert.deepEqual(await reader.scan(), { status: "match", slot: 0, score: 40 });

  virtual.setFaults({ unplugged: true });
  await assert.rejects(reader.status(), /timed out/);
  virtual.setFaults({ unplugged: false });
  assert.equal((await reader.status()).connected, true);

  virtual.present("member:1001:1", 20);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await reader.fingerPresent(), false);
  assert.throws(() => virtual.present("not a finger"), /Present a finger/);
  assert.throws(() => virtual.setFaults({ image: "smudged" }), /faint, messy or unusable/);
});

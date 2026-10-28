import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttendanceClock } from "../apps/kiosk/src/attendance-clock.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createIdentityScanner } from "../apps/kiosk/src/scanner.mjs";
import { kioskAttendanceNotice } from "../apps/kiosk/src/ui.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "kiosk-clock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { bootId: "synthetic-boot-a", elapsedMs: 1000, wallMs: Date.parse("2026-01-01T12:00:00Z"), synchronized: false };
  const options = { sample: async () => ({ ...state }), synchronized: async () => state.synchronized };
  const clockPath = join(directory, "clock.json"), queuePath = join(directory, "queue.json");
  const clock = createAttendanceClock(clockPath, options), queue = createFileQueue(queuePath);
  const event = async id => ({ eventId: id, memberId: "synthetic-member", pairingId: "synthetic-pair", ...await clock.capture() });
  return { state, options, clock, queue, clockPath, queuePath, event };
}

test("offline boot retains scans until same-boot sync reconstructs their scan times", async t => {
  const f = await fixture(t);
  const original = await f.event("one"); await f.queue.enqueue(original);
  await f.queue.flush(() => assert.fail("Unverified time must not be sent"), { prepare: f.clock.prepare });
  assert.equal((await f.queue.diagnostics()).pending, 1);
  f.state.elapsedMs = 61_000; f.state.wallMs = Date.parse("2026-10-24T11:01:00Z"); f.state.synchronized = true;
  await f.clock.refresh();
  const sent = [];
  await f.queue.flush(async event => { sent.push(event); return { accepted: true }; }, { prepare: f.clock.prepare });
  assert.equal(sent[0].occurredAt, "2026-10-24T11:00:00.000Z");
  assert.equal(sent[0].clock.observedAt, original.occurredAt);
  assert.equal(sent[0].pairingId, original.pairingId);
  assert.equal((await f.queue.diagnostics()).accepted, 1);
});

test("boot elapsed time protects offline capture from wall-clock jumps and service restarts", async t => {
  const f = await fixture(t); f.state.synchronized = true; await f.clock.refresh();
  f.state.elapsedMs += 3600000; f.state.wallMs -= 86400000; f.state.synchronized = false;
  const restarted = createAttendanceClock(f.clockPath, f.options);
  assert.equal((await restarted.capture()).occurredAt, "2026-01-01T13:00:00.000Z");
  assert.equal((await restarted.status()).verified, true);
});

test("reboot without a trusted anchor retains an open review record and continues later scans", async t => {
  const f = await fixture(t); const old = await f.event("old"); await f.queue.enqueue(old);
  f.state.bootId = "synthetic-boot-b"; f.state.elapsedMs = 500; f.state.wallMs = Date.parse("2026-10-24T22:00:00Z"); f.state.synchronized = true;
  await f.clock.refresh(); await f.queue.enqueue(await f.event("new"));
  const sent = [];
  await f.queue.flush(async event => { sent.push(event.eventId); return { accepted: true }; }, { prepare: f.clock.prepare });
  assert.deepEqual(sent, ["new"]);
  const restarted = createFileQueue(f.queuePath);
  assert.equal((await restarted.rejections())[0].reasonCode, "clock_unverified");
  assert.deepEqual((await restarted.rejections())[0].clock, old.clock);
  assert.equal((await restarted.diagnostics()).needsReview, 1);
  assert.equal(kioskAttendanceNotice({ attendance: await restarted.diagnostics() }), "");
  await restarted.markReviewed("old");
  assert.equal((await createFileQueue(f.queuePath).diagnostics()).needsReview, 0);
  assert.equal((await restarted.rejections()).length, 1);
});

test("a persisted prior-boot anchor can resolve saved scans after another boot synchronizes", async t => {
  const f = await fixture(t); const old = await f.event("old");
  f.state.elapsedMs = 61_000; f.state.wallMs = Date.parse("2026-10-24T11:01:00Z"); f.state.synchronized = true;
  await f.clock.refresh();
  f.state.bootId = "synthetic-boot-b"; f.state.elapsedMs = 500; f.state.wallMs += 3600000;
  const restarted = createAttendanceClock(f.clockPath, f.options); await restarted.refresh();
  assert.equal((await restarted.prepare(old)).event.occurredAt, "2026-10-24T11:00:00.000Z");
});

test("resolved time is durable before delivery and unchanged after a lost acknowledgement", async t => {
  const f = await fixture(t); await f.queue.enqueue(await f.event("retry"));
  f.state.synchronized = true; f.state.wallMs = Date.parse("2026-10-24T11:00:00Z"); await f.clock.refresh();
  let deliveredTime, durable;
  await f.queue.flush(async event => {
    // A separate reader sees only what is on disk (snapshot plus journal).
    durable = (await createFileQueue(f.queuePath).pending())[0];
    deliveredTime = event.occurredAt; throw Error("Acknowledgement lost");
  }, { prepare: f.clock.prepare });
  assert.equal(durable.clock.verified, true); assert.equal(durable.occurredAt, deliveredTime);
  f.state.bootId = "synthetic-boot-b"; f.state.wallMs += 86400000; await f.clock.refresh();
  await createFileQueue(f.queuePath).flush(async event => { assert.equal(event.occurredAt, deliveredTime); return { duplicate: true }; }, { prepare: f.clock.prepare });
});

test("legacy scans without clock evidence are retained for review instead of guessed", async t => {
  const f = await fixture(t); await f.queue.enqueue({ eventId: "legacy", memberId: "synthetic", occurredAt: "2026-01-01T12:00:00Z" });
  await f.queue.flush(() => assert.fail("Legacy time cannot be verified"), { prepare: f.clock.prepare });
  assert.equal((await f.queue.rejections())[0].reasonCode, "clock_unverified");
});

test("corrupt time evidence fails closed without removing the queue", async t => {
  const f = await fixture(t); await f.queue.enqueue(await f.event("one"));
  await writeFile(f.clockPath, "corrupt");
  const broken = createAttendanceClock(f.clockPath, f.options);
  await assert.rejects(f.queue.flush(() => assert.fail("Must not send"), { prepare: broken.prepare }));
  assert.equal((await f.queue.pending()).length, 1);
});

test("unverified scanner capture is durable and says clock sync is required", async t => {
  const f = await fixture(t); const displays = [];
  const scanner = createIdentityScanner({ captureIdentity: async () => ({ status: "identified", memberId: "synthetic-member" }), captureTime: f.clock.capture,
    queue: f.queue, loadPairing: async () => ({ pairingId: "synthetic-pair" }), flushAttendance: async () => undefined,
    onDisplay: async (id, overrides) => displays.push({ id, ...overrides }), onCloud() {}, delay: async () => {}, now: () => 10000, eventId: () => "scanner" });
  await scanner.tick();
  assert.equal((await f.queue.pending())[0].clock.verified, false);
  assert.match(displays.at(-1).detail, /Clock needs sync/);
  assert.match(kioskAttendanceNotice({ clock: { verified: false } }), /Open maintenance to confirm date and time/);
});

test("operator-confirmed time survives service restart and saved scans survive an offline reboot", async t => {
  const f = await fixture(t);
  await f.clock.confirm("2026-10-24T11:00:00.000Z");
  f.state.elapsedMs += 3600000;
  const saved = await f.event("confirmed"); await f.queue.enqueue(saved);
  assert.equal(saved.occurredAt, "2026-10-24T12:00:00.000Z");
  assert.equal(saved.clock.source, "operator");
  const restarted = createAttendanceClock(f.clockPath, f.options);
  assert.equal((await restarted.status()).verified, true);
  assert.equal((await restarted.capture()).occurredAt, saved.occurredAt);
  f.state.bootId = "synthetic-next-boot"; f.state.elapsedMs = 1000;
  assert.equal((await restarted.status()).verified, false);
  await restarted.confirm("2026-10-24T22:00:00.000Z");
  const sent = [];
  await createFileQueue(f.queuePath).flush(async event => { sent.push(event); return { accepted: true }; }, { prepare: restarted.prepare });
  assert.equal(sent[0].occurredAt, saved.occurredAt);
  assert.equal((await restarted.capture()).occurredAt, "2026-10-24T22:00:00.000Z");
});

test("later network time improves new scans without changing operator-confirmed queued timestamps", async t => {
  const f = await fixture(t); await f.clock.confirm("2026-10-24T11:00:00.000Z");
  const saved = await f.event("confirmed");
  f.state.synchronized = true; f.state.wallMs = Date.parse("2026-10-24T11:02:00Z");
  await f.clock.refresh();
  assert.equal((await f.clock.prepare(saved)).event.occurredAt, saved.occurredAt);
  assert.equal((await f.clock.capture()).occurredAt, "2026-10-24T11:02:00.000Z");
  await assert.rejects(f.clock.confirm("2026-10-24T11:00:00.000Z"), /already synchronized/);
});

test("invalid operator time cannot establish a trusted clock", async t => {
  const f = await fixture(t);
  for (const invalid of [null, "", "yesterday", "2026-02-30T11:00:00.000Z", "1900-01-01T00:00:00.000Z"]) await assert.rejects(f.clock.confirm(invalid));
  assert.equal((await f.clock.status()).verified, false);
});

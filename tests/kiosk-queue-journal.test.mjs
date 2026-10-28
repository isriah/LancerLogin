import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createScanReviewSync } from "../apps/kiosk/src/scan-review-sync.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-queue-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "attendance-queue.json");
  return { directory, path, outcomesPath: `${path}.outcomes.json`, journalPath: `${path}.journal` };
}
const scan = (id, minute = 0) => ({ eventId: id, memberId: `synthetic-${id}`, occurredAt: new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString(), pairingId: "synthetic-pairing" });
const journalRecords = async path => (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const ids = events => events.map(event => event.eventId);

test("enqueue appends one fsynced journal record instead of rewriting the whole queue", async t => {
  const f = await fixture(t);
  const queue = createFileQueue(f.path, { compactBytes: 64 * 1024 * 1024, compactRecords: 100_000 });
  for (let index = 0; index < 300; index++) assert.equal(await queue.enqueue(scan(`e${index}`)), true);
  assert.equal(await queue.enqueue(scan("e7")), false, "duplicate ids are not queued twice");
  // The pending snapshot is never rewritten per scan; each scan costs one appended line.
  await assert.rejects(stat(f.path), { code: "ENOENT" });
  const records = await journalRecords(f.journalPath);
  assert.equal(records.length, 300);
  assert.ok((await stat(f.journalPath)).size < 300 * 400, "journal grows linearly with the queued scans");
  assert.deepEqual(ids(await createFileQueue(f.path).pending()), Array.from({ length: 300 }, (_, index) => `e${index}`));
});

test("draining batches acknowledgements and compacts back into the release 1.0.6 snapshot format", async t => {
  const f = await fixture(t);
  const queue = createFileQueue(f.path, { ackBatch: 10 });
  for (let index = 0; index < 25; index++) await queue.enqueue(scan(`d${index}`));
  const delivered = await queue.flush(async event => event.eventId === "d3" ? { rejected: true, status: 409, code: "no_eligible_meeting" } : event.eventId === "d4" ? { duplicate: true } : { accepted: true });
  assert.equal(delivered.length, 25);
  const doneRecords = (await journalRecords(f.journalPath)).filter(record => record.t === "d");
  assert.deepEqual(doneRecords.map(record => record.items.length), [10, 10, 5], "acknowledgements are written in batches");
  assert.deepEqual(await createFileQueue(f.path).diagnostics(), { saved: 25, pending: 0, accepted: 23, duplicate: 1, rejected: 1, needsReview: 1, clockPending: 0, historyComplete: true });
  await queue.compact();
  await assert.rejects(stat(f.journalPath), { code: "ENOENT" });
  // An older release reads these files directly, so a downgrade after an
  // orderly shutdown still sees every saved scan and outcome.
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), []);
  const outcomes = JSON.parse(await readFile(f.outcomesPath, "utf8"));
  assert.equal(outcomes.version, 1); assert.equal(outcomes.pendingAck, null); assert.equal(outcomes.accepted, 23);
  assert.deepEqual(outcomes.rejected.map(record => record.eventId), ["d3"]);
});

test("a partial final journal line from a power loss is discarded and repaired before the next append", async t => {
  const f = await fixture(t);
  const queue = createFileQueue(f.path);
  await queue.enqueue(scan("kept-1")); await queue.enqueue(scan("kept-2"));
  await writeFile(f.journalPath, `${await readFile(f.journalPath, "utf8")}{"s":3,"t":"e","event":{"eventId":"torn`, { flag: "w" });
  const restarted = createFileQueue(f.path);
  assert.deepEqual(ids(await restarted.pending()), ["kept-1", "kept-2"]);
  await restarted.enqueue(scan("after-repair"));
  assert.deepEqual(ids(await createFileQueue(f.path).pending()), ["kept-1", "kept-2", "after-repair"]);
  // A corrupt record in the middle is not a torn tail; the queue fails closed.
  await writeFile(f.journalPath, `not-json\n${await readFile(f.journalPath, "utf8")}`);
  await assert.rejects(createFileQueue(f.path).pending());
});

test("a crash between the two compaction writes neither loses nor double counts any scan", async t => {
  const f = await fixture(t);
  const queue = createFileQueue(f.path);
  for (const id of ["c1", "c2", "c3"]) await queue.enqueue(scan(id));
  await queue.flush(async event => event.eventId === "c1" ? { rejected: true, status: 404, code: "roster_inactive" } : event.eventId === "c2" ? { accepted: true } : Promise.reject(new Error("offline")));
  await queue.enqueue(scan("c4"));
  const expected = await queue.diagnostics();
  const baseline = await readFile(f.outcomesPath, "utf8");
  // Window 1: the new queue snapshot was renamed into place, the outcomes
  // snapshot (and its watermark) was not, and the journal is still present.
  await writeFile(f.path, `${JSON.stringify([scan("c3"), scan("c4")])}\n`);
  assert.equal(JSON.parse(baseline).journalSeq, 0);
  const afterQueueWrite = createFileQueue(f.path);
  assert.deepEqual(ids(await afterQueueWrite.pending()), ["c3", "c4"]);
  assert.deepEqual(await afterQueueWrite.diagnostics(), expected);
  assert.deepEqual(ids(await afterQueueWrite.rejections()), ["c1"]);
  // Window 2: both snapshots were written with the new watermark, but the
  // journal was not removed yet. Its records are skipped, not replayed again.
  const lastSeq = (await journalRecords(f.journalPath)).at(-1).s;
  await writeFile(f.outcomesPath, `${JSON.stringify({ version: 1, accepted: 1, duplicate: 0, rejected: (await afterQueueWrite.rejections()), pendingAck: null, historyComplete: true, journalSeq: lastSeq, cloudReviews: {} })}\n`);
  const afterOutcomesWrite = createFileQueue(f.path);
  assert.deepEqual(await afterOutcomesWrite.diagnostics(), expected);
  assert.deepEqual(ids(await afterOutcomesWrite.pending()), ["c3", "c4"]);
  // New records continue after the watermark and survive another restart.
  await afterOutcomesWrite.enqueue(scan("c5"));
  assert.deepEqual(ids(await createFileQueue(f.path).pending()), ["c3", "c4", "c5"]);
});

test("acknowledgements not yet written resend the scan after a crash, with the same event id", async t => {
  const f = await fixture(t);
  const queue = createFileQueue(f.path, { ackBatch: 50 });
  for (const id of ["r1", "r2", "r3"]) await queue.enqueue(scan(id));
  // Simulate a crash after r1 and r2 were accepted by the server but before
  // their batched acknowledgement reached the journal.
  const crashed = createFileQueue(f.path, { ackBatch: 50 });
  let calls = 0;
  const writes = [];
  const original = await readFile(f.journalPath, "utf8");
  await crashed.flush(async () => { calls++; if (calls === 3) throw new Error("offline"); return { accepted: true }; });
  writes.push(await readFile(f.journalPath, "utf8"));
  await writeFile(f.journalPath, original);
  const resent = [];
  await createFileQueue(f.path).flush(async event => { resent.push(event.eventId); return { duplicate: true }; });
  assert.deepEqual(resent, ["r1", "r2", "r3"], "unacknowledged scans are resent; the server dedupes on kiosk_event_id");
  assert.ok(writes[0].length > original.length, "the batch is written when the drain stops");
});

test("existing queue files migrate on first start without losing, duplicating or renaming scans", async t => {
  const f = await fixture(t);
  const legacyEvents = [scan("legacy-acked"), scan("legacy-1"), scan("legacy-2")];
  // An older release crashed after recording legacy-acked's outcome but before
  // rewriting the queue (pendingAck set).
  await writeFile(f.path, `${JSON.stringify(legacyEvents)}\n`);
  await writeFile(f.outcomesPath, `${JSON.stringify({ version: 1, accepted: 4, duplicate: 1, rejected: [{ ...scan("old-rejected"), httpStatus: 409, reasonCode: "no_eligible_meeting", reviewStatus: "open" }], pendingAck: { eventId: "legacy-acked" }, historyComplete: true })}\n`);
  const queue = createFileQueue(f.path);
  assert.deepEqual(await queue.pending(), [scan("legacy-1"), scan("legacy-2")], "ids and payloads are unchanged");
  assert.deepEqual(await queue.diagnostics(), { saved: 8, pending: 2, accepted: 4, duplicate: 1, rejected: 1, needsReview: 1, clockPending: 0, historyComplete: true });
  // The recovery was folded into the snapshot, so an older release would also agree.
  assert.deepEqual(ids(JSON.parse(await readFile(f.path, "utf8"))), ["legacy-1", "legacy-2"]);
  assert.equal(JSON.parse(await readFile(f.outcomesPath, "utf8")).pendingAck, null);
  const sent = [];
  await queue.flush(async event => { sent.push(event.eventId); return { accepted: true }; });
  assert.deepEqual(sent, ["legacy-1", "legacy-2"]);
  assert.deepEqual(await createFileQueue(f.path).diagnostics(), { saved: 8, pending: 0, accepted: 6, duplicate: 1, rejected: 1, needsReview: 1, clockPending: 0, historyComplete: true });
  // A plain unmigrated queue (no outcomes file) and an empty state directory also load.
  const g = await fixture(t);
  await writeFile(g.path, JSON.stringify([scan("only")]));
  assert.deepEqual(ids(await createFileQueue(g.path).pending()), ["only"]);
  const h = await fixture(t);
  assert.deepEqual(await createFileQueue(h.path).pending(), []);
  assert.deepEqual(await readdir(h.directory), []);
});

test("retention removes only cloud-acknowledged rejections, keeps counts stable and bounds the history", async t => {
  const f = await fixture(t);
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const queue = createFileQueue(f.path, { now: () => clock, retention: { maxAgeMs: 30 * 24 * 60 * 60_000, maxRecords: 3 } });
  for (let index = 0; index < 6; index++) await queue.enqueue(scan(`x${index}`, index));
  await queue.flush(async () => ({ rejected: true, status: 409, code: "attendance_complete" }));
  // Only x0..x3 reached the cloud; x4 and x5 must stay however old they are.
  await queue.recordCloudReviews([{ eventId: "x0", reviewStatus: "reviewed" }, { eventId: "x1", reviewStatus: "open" }, { eventId: "x2", reviewStatus: "open" }, { eventId: "x3", reviewStatus: "open" }]);
  await queue.compact();
  // The count cap removed the oldest acknowledged records until three remain.
  assert.deepEqual(ids(await queue.rejections()), ["x3", "x4", "x5"]);
  clock += 40 * 24 * 60 * 60_000;
  await queue.compact();
  assert.deepEqual(ids(await queue.rejections()), ["x4", "x5"], "acknowledged records age out; unacknowledged evidence stays");
  const diagnostics = await createFileQueue(f.path).diagnostics();
  assert.equal(diagnostics.saved, 6); assert.equal(diagnostics.rejected, 6); assert.equal(diagnostics.needsReview, 2);
  assert.deepEqual([...(await createFileQueue(f.path).cloudReviews()).keys()], []);
});

test("review sync persists cloud acknowledgements and resends only what changed", async t => {
  const f = await fixture(t);
  let clock = 0;
  const queue = createFileQueue(f.path);
  for (let index = 0; index < 4; index++) await queue.enqueue(scan(`v${index}`));
  await queue.flush(async () => ({ rejected: true, status: 409, code: "attendance_complete" }));
  const sent = [];
  const cloud = new Map([["v0", "reviewed"]]);
  const send = async (_config, batch) => { sent.push(ids(batch)); return { reviews: batch.map(record => ({ eventId: record.eventId, reviewStatus: record.reviewStatus === "reviewed" ? "reviewed" : cloud.get(record.eventId) ?? "open" })) }; };
  await createScanReviewSync({ queue, send, now: () => clock }).tick({});
  assert.deepEqual(sent, [["v0", "v1", "v2", "v3"]]);
  assert.equal((await queue.rejections()).find(record => record.eventId === "v0").reviewStatus, "reviewed", "dashboard review reached the kiosk");
  // After a restart nothing is resent until open records are due for a refresh.
  const restarted = createFileQueue(f.path);
  const sync = createScanReviewSync({ queue: restarted, send, now: () => clock });
  await sync.tick({});
  assert.equal(sent.length, 1);
  await restarted.markReviewed("v2");
  await sync.tick({});
  assert.deepEqual(sent[1], ["v2"], "a local review is sent on the next heartbeat");
  clock += 60 * 60_000;
  cloud.set("v1", "reviewed");
  await sync.tick({});
  assert.deepEqual([...sent[2]].sort(), ["v1", "v3"], "only cloud-open records are polled again; reviewed ones are final");
  clock += 60 * 60_000;
  await sync.tick({});
  assert.deepEqual(sent[3], ["v3"]);
  assert.deepEqual(Object.fromEntries(await createFileQueue(f.path).cloudReviews()), { v0: "reviewed", v1: "reviewed", v2: "reviewed", v3: "open" });
});

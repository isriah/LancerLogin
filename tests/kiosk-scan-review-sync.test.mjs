import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createScanReviewSync } from "../apps/kiosk/src/scan-review-sync.mjs";
import { sendScanReviews } from "../apps/kiosk/src/cloud-client.mjs";

test("review sync rotates bounded retained history and retries failed batches without starving later records", async () => {
  const records = Array.from({ length: 121 }, (_, index) => ({ eventId: `synthetic-${index}`, reviewStatus: index % 2 ? "open" : "reviewed" }));
  const batches = [];
  const sync = createScanReviewSync({ queue: { rejections: async () => records, markReviewed: async () => {} }, send: async (_, batch) => {
    batches.push(batch);
    if (batches.length === 1) throw Error("Unavailable");
    return { reviews: batch.map(({ eventId, reviewStatus }) => ({ eventId, reviewStatus })) };
  } });
  await assert.rejects(sync.tick({}), /Unavailable/);
  for (let n = 0; n < 3; n++) await sync.tick({});
  // The fourth batch carries only the records still unacknowledged after the failed first batch.
  assert.deepEqual(batches.map(batch => batch.length), [50, 50, 50, 21]);
  assert.equal(new Set(batches.flat().map(record => record.eventId)).size, 121);
  assert.ok(batches[1].some(record => record.reviewStatus === "reviewed"));
  assert.equal(batches[3][0].eventId, "synthetic-29");
});

test("acknowledged history is not resent every heartbeat, but local reviews and periodic refreshes still reach the cloud", async () => {
  let clock = 0;
  const records = Array.from({ length: 85 }, (_, index) => ({ eventId: `settled-${index}`, reviewStatus: "open" }));
  const batches = [];
  const sync = createScanReviewSync({ now: () => clock, queue: { rejections: async () => records, markReviewed: async () => {} }, send: async (_, batch) => {
    batches.push(batch.map(record => record.eventId));
    return { reviews: batch.map(({ eventId, reviewStatus }) => ({ eventId, reviewStatus })) };
  } });
  await sync.tick({});
  await sync.tick({});
  assert.deepEqual(batches.map(batch => batch.length), [50, 35]);
  for (let minute = 0; minute < 30; minute++) { clock += 60_000; await sync.tick({}); }
  assert.equal(batches.length, 2, "a settled history sends nothing on ordinary heartbeats");
  records[7] = { ...records[7], reviewStatus: "reviewed" };
  await sync.tick({});
  assert.deepEqual(batches[2], ["settled-7"], "a local review is sent on the next heartbeat");
  await sync.tick({});
  assert.equal(batches.length, 3, "the reviewed acknowledgement settles it again");
  clock += 60 * 60_000;
  await sync.tick({});
  await sync.tick({});
  // The hourly refresh polls cloud-open records so dashboard reviews reach the
  // kiosk; settled-7 is reviewed in the cloud and is final.
  assert.deepEqual(batches.slice(3).map(batch => batch.length), [50, 34], "the hourly refresh polls open records");
  assert.equal(batches.slice(3).flat().includes("settled-7"), false);
  assert.equal(sync.hasFailures(), false);
});

test("a poison record in a short history cannot starve other records or clear its failure diagnostic", async () => {
  for (const status of [400, 409]) {
    const records = [{ eventId: "bad", reviewStatus: "open" }, { eventId: "good", reviewStatus: "open" }];
    let broken = true, requests = 0;
    const reviewed = [];
    const sync = createScanReviewSync({ queue: { rejections: async () => records, markReviewed: async id => reviewed.push(id) }, send: async (_, batch) => {
      requests++;
      if (requests > 1) assert.equal(batch.length, 1, "fallback never bursts multiple requests or batches");
      if (broken && batch.some(record => record.eventId === "bad")) throw Object.assign(Error("Invalid evidence"), { status });
      return { reviews: batch.map(({ eventId }) => ({ eventId, reviewStatus: "reviewed" })) };
    } });
    await assert.rejects(sync.tick({}), /Invalid evidence/);
    assert.equal(requests, 1);
    await assert.rejects(sync.tick({}), /Invalid evidence/);
    assert.equal(requests, 2);
    await sync.tick({});
    assert.equal(requests, 3);
    assert.deepEqual(reviewed, ["good"]);
    assert.equal(sync.hasFailures(), true, "one successful record must not hide the remaining failure");
    broken = false;
    await sync.tick({});
    assert.equal(requests, 4);
    assert.deepEqual(reviewed, ["good", "bad"]);
    assert.equal(sync.hasFailures(), false);
    assert.equal(records.length, 2, "failed evidence is never dropped");
  }
});

test("review transport preserves HTTP status for bounded validation fallback", async () => {
  for (const status of [400, 404, 409, 503]) await assert.rejects(sendScanReviews({ apiUrl: "https://synthetic.example.test", kioskToken: "synthetic" }, [], {
    fetchImpl: async () => Response.json({ error: "Synthetic failure" }, { status }),
  }), error => error.status === status && error.message === "Synthetic failure");
});

test("malformed, duplicate, missing and foreign acknowledgements cannot mark local records reviewed", async () => {
  for (const reviews of [undefined, [], [{ eventId: "one", reviewStatus: "reviewed" }, { eventId: "one", reviewStatus: "reviewed" }],
    [{ eventId: "one", reviewStatus: "reviewed" }, { eventId: "foreign", reviewStatus: "reviewed" }],
    [{ eventId: "one", reviewStatus: "reviewed" }, { eventId: "two", reviewStatus: "invalid" }]]) {
    const sync = createScanReviewSync({ queue: { rejections: async () => [{ eventId: "one" }, { eventId: "two" }], markReviewed: async () => assert.fail("Must validate entire batch first") }, send: async () => ({ reviews }) });
    await assert.rejects(sync.tick({}), /Invalid scan review/);
  }
});

test("cloud review persists through restart without deleting evidence, reopening review, or changing attendance", async t => {
  const root = await mkdtemp(join(tmpdir(), "scan-review-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "queue.json");
  const queue = createFileQueue(path);
  const evidence = { eventId: "synthetic-event", memberId: "synthetic-member", pairingId: "synthetic-old-pair", occurredAt: "2026-01-01T00:00:00.000Z", clock: { version: 1, verified: false } };
  await queue.enqueue(evidence);
  await queue.flush(async () => ({ rejected: true, code: "clock_unverified" }));
  await createScanReviewSync({ queue, send: async (_, batch) => {
    assert.equal(batch[0].pairingId, evidence.pairingId);
    assert.deepEqual(batch[0].clock, evidence.clock);
    return { reviews: [{ eventId: evidence.eventId, reviewStatus: "reviewed" }] };
  } }).tick({});
  const reopened = createFileQueue(path);
  const [record] = await reopened.rejections();
  assert.equal(record.reviewStatus, "reviewed");
  assert.equal(record.occurredAt, evidence.occurredAt);
  await createScanReviewSync({ queue: reopened, send: async (_, batch) => {
    assert.equal(batch[0].reviewStatus, "reviewed");
    return { reviews: [{ eventId: evidence.eventId, reviewStatus: "open" }] };
  } }).tick({});
  assert.deepEqual(await reopened.rejections(), [record]);
  const diagnostics = await reopened.diagnostics();
  assert.equal(diagnostics.needsReview, 0);
  assert.equal(diagnostics.rejected, 1);
  assert.equal(diagnostics.accepted, 0);
});

test("review sync shares in-flight work and uses only the paired authenticated endpoint", async () => {
  let resolve, requests = 0;
  const records = [{ eventId: "synthetic-event", reviewStatus: "open" }];
  const config = { apiUrl: "https://synthetic.example.test/api/", kioskToken: "synthetic-token" };
  const sync = createScanReviewSync({ queue: { rejections: async () => records, markReviewed: async () => assert.fail("Open stays open") }, send: (value, batch) => sendScanReviews(value, batch, { fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, "https://synthetic.example.test/api/kiosk/scan-reviews");
    assert.equal(options.headers.authorization, "Bearer synthetic-token");
    assert.deepEqual(JSON.parse(options.body), { records });
    await new Promise(done => { resolve = done; });
    return Response.json({ reviews: records });
  } }) });
  const first = sync.tick(config), second = sync.tick(config);
  assert.equal(first, second);
  await new Promise(done => setImmediate(done));
  resolve(); await first;
  assert.equal(requests, 1);
});

test("a dashboard review signalled by the heartbeat is polled on the next tick instead of the hourly refresh", async () => {
  let clock = 0;
  const records = [{ eventId: "open-a", reviewStatus: "open" }, { eventId: "open-b", reviewStatus: "open" }];
  const cloud = new Map([["open-a", "open"], ["open-b", "open"]]), batches = [];
  const sync = createScanReviewSync({ now: () => clock, queue: { rejections: async () => records, markReviewed: async () => {} }, send: async (_, batch) => {
    batches.push(batch.map(record => record.eventId));
    return { reviews: batch.map(({ eventId }) => ({ eventId, reviewStatus: cloud.get(eventId) })) };
  } });
  await sync.tick({});
  cloud.set("open-b", "reviewed");
  clock += 60_000; await sync.tick({});
  assert.equal(batches.length, 1, "without a signal the open record waits for the hourly refresh");
  sync.refreshOpen();
  await sync.tick({});
  assert.deepEqual(batches[1], ["open-a", "open-b"]);
  clock += 60_000; await sync.tick({});
  assert.equal(batches.length, 2, "the refresh is one poll, not a poll every heartbeat");
});

test("scans rejected on the kiosk, which the server never recorded, reach the dashboard's Rejected scans list", async t => {
  // Maintenance has no review page, so the dashboard is the only place these are seen. Two kinds exist only on the
  // kiosk: a scan the Worker refused (here for want of a PIN) and one the kiosk itself set aside for an unverified clock.
  const { validateScanReviewUpload } = await import("../apps/api/src/kiosk-scan-reviews.ts");
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-review-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queue = createFileQueue(join(directory, "attendance-queue.json"));
  await queue.enqueue({ eventId: "synthetic-no-pin", memberId: "1009", occurredAt: "2026-10-30T12:00:00.000Z", pairingId: "synthetic-pairing" });
  await queue.enqueue({ eventId: "synthetic-no-clock", memberId: "1010", occurredAt: "2026-10-30T12:01:00.000Z", pairingId: "synthetic-pairing", clock: { version: 1, verified: false, bootId: "synthetic-boot", elapsedMs: 5 } });
  await queue.enqueue({ eventId: "synthetic-fine", memberId: "1011", occurredAt: "2026-10-30T12:02:00.000Z", pairingId: "synthetic-pairing" });
  const sentToWorker = [];
  await queue.flush(async event => { sentToWorker.push(event.eventId); return event.eventId === "synthetic-no-pin" ? { accepted: false, rejected: true, status: 400, code: "pin_required", error: "This kiosk requires a PIN." } : { accepted: true }; },
    { prepare: async event => event.clock?.verified === false ? { rejected: true, code: "clock_unverified" } : { event } });
  assert.deepEqual(sentToWorker, ["synthetic-no-pin", "synthetic-fine"]);
  const uploads = [];
  const sync = createScanReviewSync({ queue, send: async (config, records) => {
    // The body the kiosk posts to /kiosk/scan-reviews must pass the Worker's own validation.
    const accepted = validateScanReviewUpload(JSON.parse(JSON.stringify({ records })));
    uploads.push(...accepted.map(upload => upload.evidence));
    return { reviews: records.map(record => ({ eventId: record.eventId, reviewStatus: "open" })) };
  } });
  await sync.tick({ apiUrl: "https://api.example.test", kioskToken: "synthetic" });
  assert.deepEqual(uploads.map(record => [record.eventId, record.memberId, record.occurredAt, record.reasonCode, record.httpStatus]), [
    ["synthetic-no-pin", "1009", "2026-10-30T12:00:00.000Z", "pin_required", 400],
    ["synthetic-no-clock", "1010", "2026-10-30T12:01:00.000Z", "clock_unverified", null],
  ]);
  assert.equal(sync.hasFailures(), false);
  // Still kept on the kiosk after the upload, and recorded as acknowledged so it is not resent every heartbeat.
  assert.deepEqual((await queue.rejections()).map(record => record.eventId), ["synthetic-no-pin", "synthetic-no-clock"]);
  assert.deepEqual([...await queue.cloudReviews()], [["synthetic-no-pin", "open"], ["synthetic-no-clock", "open"]]);
});

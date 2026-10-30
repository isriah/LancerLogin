import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingEndpointError, sendLocalEnrollment } from "../apps/kiosk/src/cloud-client.mjs";
import { createEnrollmentReports, missingEndpointBackoff } from "../apps/kiosk/src/enrollment-reports.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";

// All data is synthetic. No real kiosk, Worker or member is contacted.
const config = { apiUrl: "https://api.example.test", kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing", kioskToken: "synthetic-token" };

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-enrollment-reports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "local-enrollment-reports.json");
}
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
/** A synthetic Worker. `mode` is "modern", "missing" (older Worker), "offline" or a function returning a response. */
function worker(mode = "modern") {
  const requests = [], accepted = new Set();
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, headers: options.headers, body });
    const current = api.mode;
    if (typeof current === "function") return current(body);
    if (current === "offline") throw new TypeError("fetch failed");
    if (current === "missing") return json(404, { error: "Not found" });
    const duplicate = accepted.has(body.eventId); accepted.add(body.eventId);
    return json(200, { eventId: body.eventId, accepted: !duplicate, duplicate, reenrolledAt: body.enrolledAt });
  };
  const api = { requests, accepted, mode, send: (cfg, report) => sendLocalEnrollment(cfg, report, { fetchImpl }) };
  return api;
}

test("a local enrollment is reported with only the member, time and pairing", async t => {
  const path = await directory(t), api = worker(), logs = [];
  const reports = createEnrollmentReports({ path, send: api.send, log: message => logs.push(message) });
  const report = await reports.record({ rosterId: "synthetic-roster", pairingId: config.pairingId, enrolledAt: "2026-09-30T11:00:00.000Z" });
  assert.match(report.eventId, /^local-enrollment-[0-9a-f-]{36}$/);
  const result = await reports.flush(config);
  assert.deepEqual(result, { delivered: [report.eventId], dropped: [] });
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, "https://api.example.test/kiosk/fingerprint-enrollments");
  assert.equal(api.requests[0].headers.authorization, "Bearer synthetic-token");
  assert.deepEqual(api.requests[0].body, { eventId: report.eventId, rosterId: "synthetic-roster", enrolledAt: "2026-09-30T11:00:00.000Z", pairingId: "synthetic-pairing" });
  assert.deepEqual(await reports.pending(), []);
  assert.deepEqual(logs, []);
});

test("a report made offline survives a restart and is delivered once the Worker is reachable", async t => {
  const path = await directory(t), api = worker("offline");
  const first = createEnrollmentReports({ path, send: api.send, log: () => undefined });
  const report = await first.record({ rosterId: "synthetic-roster", pairingId: config.pairingId });
  assert.deepEqual(await first.flush(config), { delivered: [], dropped: [] });
  assert.equal((await first.pending()).length, 1, "still queued after a connectivity failure");
  // Restart: a new service instance reads the same durable queue.
  api.mode = "modern";
  const second = createEnrollmentReports({ path, send: api.send, log: () => undefined });
  assert.deepEqual((await second.pending()).map(item => item.eventId), [report.eventId]);
  assert.deepEqual((await second.flush(config)).delivered, [report.eventId]);
  assert.deepEqual(await second.pending(), []);
  await second.compact();
  // The files use the attendance queue's own format, so any release's queue reader can open them.
  assert.ok(Array.isArray(JSON.parse(await readFile(path, "utf8"))));
  assert.deepEqual(await createFileQueue(path).pending(), []);
});

test("a resent report that the Worker already has leaves the queue", async t => {
  const path = await directory(t), api = worker();
  const reports = createEnrollmentReports({ path, send: api.send, log: () => undefined });
  const report = await reports.record({ rosterId: "synthetic-roster", pairingId: config.pairingId });
  api.accepted.add(report.eventId); // Delivered before a crash, but the acknowledgement was never journaled.
  assert.deepEqual((await reports.flush(config)).delivered, [report.eventId]);
  assert.deepEqual(await reports.pending(), []);
});

test("a report for a member who left the roster is dropped and logged, and the next report still goes", async t => {
  const path = await directory(t), logs = [];
  const api = worker(body => body.rosterId === "synthetic-removed" ? json(404, { error: "This fingerprint is not linked to an active roster member", code: "roster_inactive" })
    : json(200, { eventId: body.eventId, accepted: true, duplicate: false, reenrolledAt: body.enrolledAt }));
  const reports = createEnrollmentReports({ path, send: api.send, log: message => logs.push(message) });
  const removed = await reports.record({ rosterId: "synthetic-removed", pairingId: config.pairingId });
  const kept = await reports.record({ rosterId: "synthetic-roster", pairingId: config.pairingId });
  assert.deepEqual(await reports.flush(config), { delivered: [kept.eventId], dropped: [removed.eventId] });
  assert.deepEqual(await reports.pending(), [], "never retried forever");
  assert.equal(logs.length, 1); assert.match(logs[0], /roster_inactive/);
  for (const code of ["pairing_mismatch", "invalid_enrollment"]) {
    const result = await sendLocalEnrollment(config, { eventId: "synthetic-event", rosterId: "synthetic-roster", enrolledAt: "2026-09-30T11:00:00.000Z" }, { fetchImpl: async () => json(code === "pairing_mismatch" ? 409 : 400, { error: "Synthetic", code }) });
    assert.equal(result.dropped, true, code);
  }
});

test("an older Worker parks reports with a long backoff, logs once, and delivers them after it is updated", async t => {
  const path = await directory(t), logs = [];
  let now = Date.parse("2026-09-30T12:00:00Z");
  const api = worker("missing");
  const reports = createEnrollmentReports({ path, send: api.send, now: () => now, log: message => logs.push(message) });
  const first = await reports.record({ rosterId: "synthetic-roster", pairingId: config.pairingId });
  const second = await reports.record({ rosterId: "synthetic-roster-b", pairingId: config.pairingId });
  assert.deepEqual(await reports.flush(config), { delivered: [], dropped: [] });
  assert.equal(api.requests.length, 1, "parking stops at the first report instead of trying every one");
  assert.equal((await reports.pending()).length, 2, "parked, not dropped");
  assert.equal(logs.length, 1); assert.match(logs[0], /parked/);
  // Deferred during the backoff: nothing is sent, nothing is lost.
  now += missingEndpointBackoff.baseMs - 1;
  assert.deepEqual(await reports.flush(config), { delivered: [], deferred: true });
  assert.equal(api.requests.length, 1);
  now += 1;
  await reports.flush(config);
  assert.equal(api.requests.length, 2); assert.equal(logs.length, 1, "logged once per parking");
  now += 2 * missingEndpointBackoff.baseMs; api.mode = "modern";
  assert.deepEqual((await reports.flush(config)).delivered, [first.eventId, second.eventId]);
  assert.deepEqual(await reports.pending(), []);
  // A non-JSON 404 or a 405 is an older Worker or proxy too; a recognized refusal is not.
  await assert.rejects(sendLocalEnrollment(config, first, { fetchImpl: async () => new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } }) }), MissingEndpointError);
  await assert.rejects(sendLocalEnrollment(config, first, { fetchImpl: async () => json(405, { error: "Method not allowed" }) }), MissingEndpointError);
});

test("an unconfirmed or failed response keeps the report queued", async t => {
  const path = await directory(t);
  for (const response of [() => json(200, {}), () => json(503, { error: "Synthetic outage" }), () => json(429, { error: "Slow down" })]) {
    const api = worker(() => response());
    const reports = createEnrollmentReports({ path, send: api.send, log: () => undefined });
    await reports.record({ rosterId: "synthetic-roster", pairingId: config.pairingId });
    assert.deepEqual((await reports.flush(config)).delivered, []);
  }
  assert.equal((await createFileQueue(path).pending()).length, 3);
  await assert.rejects(createEnrollmentReports({ path, send: async () => ({}) }).record({ rosterId: "" }), /roster id/);
});

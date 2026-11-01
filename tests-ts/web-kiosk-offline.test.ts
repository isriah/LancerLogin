import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createKioskApi, deliverScan, type AttendanceScan, type ScanReviewRecord, type SendOutcome } from "../apps/dashboard/src/web-kiosk/kiosk-api.ts";
import { clockOffsetFrom, createKioskClock, maxClockRoundTripMs, usableClockOffset } from "../apps/dashboard/src/web-kiosk/kiosk-clock.ts";
import { connectionStatus, displayForQueuedScan, displayForScanFate } from "../apps/dashboard/src/web-kiosk/kiosk-flow.ts";
import { kioskResourceUrls, kioskServiceWorkerUrl } from "../apps/dashboard/src/web-kiosk/kiosk-install.ts";
import { createIndexedDbStore, createMemoryQueue, createMemoryStore, kioskDatabaseVersion, kioskStorageBlockedEvent, stateKeys, upgradeKioskDatabase, usableQueuedScan, type QueuedScan } from "../apps/dashboard/src/web-kiosk/kiosk-store.ts";
import { createMemoryRefusedStore, createScanSync, maxRefusedScans, scanReviewRecordFor, syncBackoffMs } from "../apps/dashboard/src/web-kiosk/kiosk-sync.ts";
import { buildPagesProxy } from "../scripts/prepare-pages-proxy.mjs";

// Synthetic scans for Test Students A to C.
const scan = (n: number, memberId = `100${n}`): QueuedScan => ({ eventId: `event-${n}`, memberId, occurredAt: `2026-10-30T18:0${n}:00.000Z`, pairingId: "pairing-1", queuedAt: `2026-10-30T18:0${n}:00.000Z` });
const accepted = (eventId: string): SendOutcome => ({ kind: "accepted", result: { accepted: true, eventId, action: "check_in" } });

/** A fake transport: answers from a script, by event ID, and records what was sent in order. */
function fakeTransport(script: (scan: QueuedScan, attempt: number) => SendOutcome) {
  const sent: string[] = [];
  return { sent, send: async (item: QueuedScan) => { sent.push(item.eventId); return script(item, sent.length); } };
}

test("queued scans are sent in order, one at a time, and leave the queue once the server has them", async () => {
  const queue = createMemoryQueue();
  const transport = fakeTransport((item) => accepted(item.eventId));
  let changes = 0;
  const sync = createScanSync({ queue, refused: createMemoryRefusedStore(), send: transport.send, onChange: () => { changes += 1; } });
  for (const n of [1, 2, 3]) await sync.enqueue(scan(n));
  assert.equal(await sync.pending(), 3);
  const report = await sync.sync();
  assert.deepEqual(transport.sent, ["event-1", "event-2", "event-3"]);
  assert.deepEqual(report, { delivered: 3, pending: 0 });
  assert.equal(await queue.count(), 0);
  assert.equal(sync.fate("event-2")?.kind, "accepted");
  assert.ok(changes >= 6);
});

test("a scan is queued once per event ID, and the server's duplicate answer counts as delivered", async () => {
  const queue = createMemoryQueue();
  const transport = fakeTransport((item) => ({ kind: "accepted", result: { duplicate: true, eventId: item.eventId } }));
  const sync = createScanSync({ queue, refused: createMemoryRefusedStore(), send: transport.send });
  await sync.enqueue(scan(1)); await sync.enqueue(scan(1)); await sync.enqueue({ ...scan(1), memberId: "1002" });
  assert.equal(await queue.count(), 1);
  assert.deepEqual(await sync.sync(), { delivered: 1, pending: 0 });
  assert.deepEqual(transport.sent, ["event-1"]);
});

test("no answer keeps the scan and everything after it queued, and waits longer after each failure, up to 5 minutes", async () => {
  let now = 1_000_000;
  const queue = createMemoryQueue();
  let reachable = false;
  const transport = fakeTransport((item) => reachable ? accepted(item.eventId) : { kind: "unreachable" });
  const sync = createScanSync({ queue, refused: createMemoryRefusedStore(), send: transport.send, now: () => now });
  await sync.enqueue(scan(1)); await sync.enqueue(scan(2));

  assert.deepEqual(await sync.sync(), { delivered: 0, pending: 2, stopped: "unreachable" });
  assert.deepEqual(transport.sent, ["event-1"]);
  assert.equal(sync.retryAt(), now + 5_000);
  // During the wait an ordinary sync (a heartbeat) sends nothing...
  assert.deepEqual(await sync.sync(), { delivered: 0, pending: 2, stopped: "backoff" });
  assert.equal(transport.sent.length, 1);
  // ...but a new scan tries at once, and the wait doubles.
  assert.equal((await sync.sync({ force: true })).stopped, "unreachable");
  assert.equal(sync.retryAt(), now + 10_000);
  now += 10_000;
  assert.equal((await sync.sync({ force: false })).stopped, "unreachable");
  assert.equal(sync.retryAt(), now + 20_000);
  assert.equal(sync.failures(), 3);

  // A server error is no answer either; the same scan is retried with the same event ID.
  const retrying = fakeTransport(() => ({ kind: "retry", status: 503 }));
  const other = createScanSync({ queue: createMemoryQueue([scan(5)]), refused: createMemoryRefusedStore(), send: retrying.send, now: () => now });
  for (let attempt = 0; attempt < 3; attempt++) await other.sync({ force: true });
  assert.deepEqual(retrying.sent, ["event-5", "event-5", "event-5"]);

  // Back online: the wait is forgotten and the queue drains in order.
  reachable = true;
  assert.deepEqual(await sync.online(), { delivered: 2, pending: 0 });
  assert.deepEqual(transport.sent.slice(-2), ["event-1", "event-2"]);
  assert.equal(sync.failures(), 0);
  assert.equal(sync.retryAt(), undefined);
});

test("the wait between tries doubles from 5 seconds and stops at 5 minutes", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 40].map((failures) => syncBackoffMs(failures)), [0, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
});

test("a refusal removes the scan, keeps it in the refused list, and the scans after it still go", async () => {
  const queue = createMemoryQueue();
  const refused = createMemoryRefusedStore();
  const transport = fakeTransport((item) => item.eventId === "event-1"
    ? { kind: "rejected", status: 409, code: "no_eligible_meeting", message: "No meeting is accepting attendance scans at this time" }
    : item.eventId === "event-2" ? { kind: "rejected", status: 400, message: "Bad scan" } : accepted(item.eventId));
  const sync = createScanSync({ queue, refused, send: transport.send, now: () => Date.parse("2026-10-30T19:00:00.000Z") });
  for (const n of [1, 2, 3]) await sync.enqueue(scan(n));
  assert.deepEqual(await sync.sync(), { delivered: 1, pending: 0 });
  assert.deepEqual(transport.sent, ["event-1", "event-2", "event-3"]);
  const kept = await refused.list();
  assert.deepEqual(kept.map((item) => [item.eventId, item.reasonCode, item.httpStatus]), [["event-1", "no_eligible_meeting", 409], ["event-2", "unclassified", 400]]);
  assert.equal(kept[0]!.refusedAt, "2026-10-30T19:00:00.000Z");
  assert.equal(sync.fate("event-1")?.kind, "rejected");
  assert.equal(displayForScanFate(sync.fate("event-1")!).message, "No meeting right now");
});

test("the refused list keeps the last 50 scans and one record per event ID", async () => {
  const refused = createMemoryRefusedStore();
  const queue = createMemoryQueue(Array.from({ length: 60 }, (_, index) => ({ ...scan(1), eventId: `event-${index}` })));
  const sync = createScanSync({ queue, refused, send: async () => ({ kind: "rejected", status: 409, code: "scan_window_closed", message: "Closed" }) });
  await sync.sync();
  const kept = await refused.list();
  assert.equal(kept.length, maxRefusedScans);
  assert.equal(kept[0]!.eventId, "event-10");
  assert.equal(kept.at(-1)!.eventId, "event-59");
});

test("a member who scanned on another kiosk moments apart is dropped without a review; a refused credential stops the queue", async () => {
  const queue = createMemoryQueue([scan(1), scan(2)]);
  const refused = createMemoryRefusedStore();
  let paired = true;
  const transport = fakeTransport((item) => item.eventId === "event-1" ? { kind: "rescan", status: 409, code: "possible_wrong_match", message: "Scan again" } : { kind: "credential" });
  const sync = createScanSync({ queue, refused, send: transport.send, onCredentialRejected: () => { paired = false; } });
  assert.deepEqual(await sync.sync(), { delivered: 0, pending: 1, stopped: "credential" });
  assert.equal(paired, false);
  assert.deepEqual(await refused.list(), []);
  assert.deepEqual((await queue.list()).map((item) => item.eventId), ["event-2"]);
});

test("a sync asked for during a pass makes that pass pick up the new scan", async () => {
  const queue = createMemoryQueue([scan(1)]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transport = { sent: [] as string[], async send(item: QueuedScan) { this.sent.push(item.eventId); if (item.eventId === "event-1") await gate; return accepted(item.eventId); } };
  const sync = createScanSync({ queue, refused: createMemoryRefusedStore(), send: (item) => transport.send(item) });
  const first = sync.sync();
  await new Promise((resolve) => setImmediate(resolve));
  await sync.enqueue(scan(2));
  const second = sync.sync({ force: true });
  release();
  assert.deepEqual(await first, { delivered: 2, pending: 0 });
  assert.equal(await second, await first);
  assert.deepEqual(transport.sent, ["event-1", "event-2"]);
});

test("refused scans upload to /kiosk/scan-reviews as the Pi uploads them, and only until the server has them", async () => {
  const refused = createMemoryRefusedStore();
  const uploads: ScanReviewRecord[][] = [];
  let answer: (records: ScanReviewRecord[]) => { eventId: string; reviewStatus: "open" | "reviewed" }[] = (records) => records.map(({ eventId }) => ({ eventId, reviewStatus: "open" }));
  const sync = createScanSync({
    queue: createMemoryQueue([scan(1), scan(2)]), refused,
    send: async () => ({ kind: "rejected", status: 409, code: "no_eligible_meeting", message: "No meeting is accepting attendance scans at this time" }),
    sendReviews: async (records) => { uploads.push(records); return answer(records); },
  });
  await sync.sync();
  // A wrong acknowledgement records nothing.
  const correct = answer; answer = () => [{ eventId: "event-1", reviewStatus: "open" }];
  await assert.rejects(sync.uploadRefused(), /Invalid scan review acknowledgement/);
  assert.equal((await refused.list()).filter((item) => item.cloud).length, 0);
  answer = correct;
  await sync.uploadRefused();
  assert.deepEqual(uploads.at(-1), [
    { eventId: "event-1", memberId: "1001", occurredAt: "2026-10-30T18:01:00.000Z", pairingId: "pairing-1", reasonCode: "no_eligible_meeting", httpStatus: 409, reviewStatus: "open" },
    { eventId: "event-2", memberId: "1002", occurredAt: "2026-10-30T18:02:00.000Z", pairingId: "pairing-1", reasonCode: "no_eligible_meeting", httpStatus: 409, reviewStatus: "open" },
  ]);
  assert.deepEqual((await refused.list()).map((item) => item.cloud), ["open", "open"]);
  const count = uploads.length;
  await sync.uploadRefused();
  assert.equal(uploads.length, count);
  // Only the fields /kiosk/scan-reviews accepts.
  const allowed = ["eventId", "memberId", "occurredAt", "reasonCode", "httpStatus", "meetingId", "pairingId", "clock", "reviewStatus", "reviewedAt"];
  for (const key of Object.keys(scanReviewRecordFor((await refused.list())[0]!))) assert.ok(allowed.includes(key), key);
});

test("each answer to a scan maps to a queue outcome", async () => {
  const scanBody: AttendanceScan = { eventId: "e1", memberId: "1001", occurredAt: "2026-10-30T18:00:00.000Z", pairingId: "p1", rescanSupported: true };
  const answer = (reply: Response | Error | "hang") => deliverScan({ baseUrl: "/api", token: "test-token", timeoutMs: 50, fetchImpl: (async () => {
    if (reply === "hang") return new Promise(() => undefined);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as typeof fetch }, scanBody);
  assert.equal((await answer(Response.json({ accepted: true, eventId: "e1", action: "check_in" }, { status: 202 }))).kind, "accepted");
  assert.deepEqual(await answer(Response.json({ accepted: false, duplicate: true, eventId: "e1" })), { kind: "accepted", result: { accepted: false, duplicate: true, eventId: "e1" } });
  assert.deepEqual(await answer(Response.json({ accepted: true, eventId: "another" })), { kind: "retry", status: 200 });
  assert.deepEqual(await answer(Response.json({ error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting" }, { status: 409 })), { kind: "rejected", status: 409, code: "no_eligible_meeting", message: "No meeting is accepting attendance scans at this time" });
  assert.deepEqual(await answer(Response.json({ error: "Invalid" }, { status: 400 })), { kind: "rejected", status: 400, message: "Invalid" });
  assert.equal((await answer(Response.json({ error: "Scan again", code: "possible_wrong_match" }, { status: 409 }))).kind, "rescan");
  assert.deepEqual(await answer(Response.json({ error: "Kiosk credential is invalid" }, { status: 401 })), { kind: "credential" });
  assert.deepEqual(await answer(Response.json({ error: "Slow down" }, { status: 429 })), { kind: "retry", status: 429 });
  assert.deepEqual(await answer(Response.json({ error: "Down" }, { status: 503 })), { kind: "retry", status: 503 });
  assert.deepEqual(await answer(new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } })), { kind: "retry", status: 404 });
  assert.deepEqual(await answer(new TypeError("Failed to fetch")), { kind: "unreachable" });
  assert.deepEqual(await answer("hang"), { kind: "unreachable" });
});

test("the heartbeat reports the queue length and returns the server's time", async () => {
  const bodies: unknown[] = [];
  const api = createKioskApi({ baseUrl: "/api", token: "test-token", fetchImpl: (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ ok: true, receivedAt: "2026-10-30T18:00:00.000Z" }); }) as unknown as typeof fetch });
  assert.equal((await api.heartbeat("2.1.0-beta.1", 2)).receivedAt, "2026-10-30T18:00:00.000Z");
  await api.heartbeat("2.1.0-beta.1", 0, "2026-10-30T17:59:00.000Z");
  assert.deepEqual(bodies, [
    { readerOnline: true, authenticationMethod: "member_id", releaseVersion: "2.1.0-beta.1", pendingEvents: 2 },
    { readerOnline: true, authenticationMethod: "member_id", releaseVersion: "2.1.0-beta.1", pendingEvents: 0, lastSyncAt: "2026-10-30T17:59:00.000Z" },
  ]);
});

test("the clock offset is the server time minus the midpoint of the device's send and answer times", () => {
  const sent = Date.parse("2026-10-30T18:00:00.000Z");
  // The device is 90 seconds slow; the request took 400 ms and the server stamped it halfway.
  assert.deepEqual(clockOffsetFrom(sent, sent + 400, "2026-10-30T18:01:30.200Z"), { offsetMs: 90_000, measuredAt: sent + 400, roundTripMs: 400 });
  // A fast device gets a negative offset.
  assert.equal(clockOffsetFrom(sent, sent + 100, "2026-10-30T17:58:00.050Z")?.offsetMs, -120_000);
  assert.equal(clockOffsetFrom(sent, sent + 100, undefined), undefined);
  assert.equal(clockOffsetFrom(sent, sent + 100, "not a time"), undefined);
  assert.equal(clockOffsetFrom(sent, sent - 1, "2026-10-30T18:00:00.000Z"), undefined);
  assert.equal(clockOffsetFrom(sent, sent + maxClockRoundTripMs + 1, "2026-10-30T18:00:00.000Z"), undefined);
});

test("scans are stamped with the device time plus the offset, or the device time before a first heartbeat", () => {
  let now = Date.parse("2026-10-30T18:00:00.000Z");
  const clock = createKioskClock({ now: () => now });
  assert.equal(clock.occurredAt(), "2026-10-30T18:00:00.000Z");
  const offset = clock.update(now - 200, now, "2026-10-30T18:05:00.000Z");
  assert.equal(offset?.offsetMs, 300_100);
  now += 1_000;
  assert.equal(clock.occurredAt(), "2026-10-30T18:05:01.100Z");
  // An unusable measurement keeps the last offset.
  assert.equal(clock.update(now, now + 10, undefined), undefined);
  assert.equal(clock.offset()?.offsetMs, 300_100);
  // The saved offset is used after a restart without a network.
  const restarted = createKioskClock({ now: () => now, initial: usableClockOffset(JSON.parse(JSON.stringify(offset))) });
  assert.equal(restarted.occurredAt(), "2026-10-30T18:05:01.100Z");
  assert.equal(usableClockOffset({ offsetMs: "1" }), undefined);
});

test("the queued display says Welcome or Goodbye from the member's waiting scans, and Saved for sync", () => {
  const member = { memberId: "1001", firstName: "Test Student", lastName: "A" };
  const first = displayForQueuedScan(member, [scan(2)]);
  assert.deepEqual([first.id, first.message, first.detail, first.name], ["welcome", "Welcome", "Saved for sync", "Test Student A"]);
  const second = displayForQueuedScan(member, [scan(1)]);
  assert.deepEqual([second.id, second.message, second.detail], ["goodbye", "Goodbye", "Saved for sync"]);
  assert.equal(connectionStatus(false, 2), "Offline · 2 waiting");
  assert.equal(connectionStatus(false, 0), "Offline · couldn't reach the server");
  assert.equal(connectionStatus(true, 1), "Online · 1 waiting");
  assert.equal(connectionStatus(true, 0), "Online");
});

test("the store keeps the queue in order without duplicates, and clearing it forgets everything", async () => {
  const store = createMemoryStore({ kioskId: "k1", kioskToken: "test-token", pairingId: "pairing-1", name: "Test web kiosk C" });
  await store.queue.add(scan(2)); await store.queue.add(scan(1)); await store.queue.add(scan(2));
  assert.deepEqual((await store.queue.list()).map((item) => item.eventId), ["event-2", "event-1"]);
  await store.write(stateKeys.roster, { members: [{ memberId: "1001", firstName: "Test Student", lastName: "A", email: "test.student.a@example.test" }] });
  await store.write(stateKeys.clock, { offsetMs: 5, measuredAt: 1, roundTripMs: 1 });
  await store.queue.remove("event-2");
  assert.equal(await store.queue.count(), 1);
  await store.clear();
  assert.equal(await store.load(), undefined);
  assert.equal(await store.queue.count(), 0);
  assert.equal(await store.read(stateKeys.roster), undefined);
  assert.equal(usableQueuedScan({ eventId: "e", memberId: "1001" }), undefined);
  assert.equal(usableQueuedScan({ ...scan(1), queuedAt: undefined })?.queuedAt, scan(1).occurredAt);
});

test("upgrading the database to version 2 adds the queue and keeps the pairing store", () => {
  assert.equal(kioskDatabaseVersion, 2);
  const created: { name: string; options?: IDBObjectStoreParameters; indexes: [string, string, IDBIndexParameters | undefined][] }[] = [];
  const fakeDatabase = (existing: string[]) => ({
    objectStoreNames: { contains: (name: string) => existing.includes(name) },
    createObjectStore(name: string, options?: IDBObjectStoreParameters) {
      const record = { name, options, indexes: [] as [string, string, IDBIndexParameters | undefined][] };
      created.push(record);
      return { createIndex: (index: string, keyPath: string, parameters?: IDBIndexParameters) => { record.indexes.push([index, keyPath, parameters]); } };
    },
  }) as unknown as IDBDatabase;
  upgradeKioskDatabase(fakeDatabase(["state"]));
  assert.deepEqual(created, [{ name: "queue", options: { keyPath: "seq", autoIncrement: true }, indexes: [["eventId", "eventId", { unique: true }]] }]);
  created.length = 0;
  upgradeKioskDatabase(fakeDatabase([]));
  assert.deepEqual(created.map((item) => item.name), ["state", "queue"]);
});

/** Loads public/kiosk-sw.js with a fake worker scope and returns its routing function. */
async function serviceWorker(location = "https://dashboard.example.test/kiosk-sw.js?v=2.1.0-beta.1") {
  const source = await readFile("apps/dashboard/public/kiosk-sw.js", "utf8");
  const listeners: Record<string, unknown> = {};
  const self = { location: new URL(location), addEventListener: (type: string, listener: unknown) => { listeners[type] = listener; } };
  const exported = runInNewContext(`${source}\n;({ kioskSwRoute, cacheName, cacheable })`, { self, URL, Request, Response, setTimeout, clearTimeout }) as {
    kioskSwRoute: (request: { method: string; url: string; mode?: string; destination?: string; headers?: Headers | Record<string, string> }, origin: string) => string;
    cacheName: string; cacheable: (response: Response, route: string) => boolean;
  };
  return { ...exported, listeners };
}

test("the service worker caches the kiosk page and its files, and never API calls or authorized requests", async () => {
  const { kioskSwRoute, cacheName, cacheable, listeners } = await serviceWorker();
  const origin = "https://dashboard.example.test";
  const route = (url: string, extra: { method?: string; mode?: string; destination?: string; headers?: Record<string, string> } = {}) =>
    kioskSwRoute({ method: extra.method ?? "GET", url, mode: extra.mode ?? "no-cors", destination: extra.destination ?? "script", headers: new Headers(extra.headers ?? {}) }, origin);
  assert.equal(route(`${origin}/kiosk`, { mode: "navigate", destination: "document" }), "page");
  assert.equal(route(`${origin}/kiosk/`, { mode: "navigate", destination: "document" }), "page");
  // The dashboard's Kiosks page shares the prefix but is never served from the kiosk's cache.
  assert.equal(route(`${origin}/kiosks`, { mode: "navigate", destination: "document" }), "pass");
  assert.equal(route(`${origin}/settings`, { mode: "navigate", destination: "document" }), "pass");
  assert.equal(route(`${origin}/assets/web-kiosk-page-AbC123.js`), "asset");
  assert.equal(route(`${origin}/assets/index-AbC123.css`, { destination: "style" }), "asset");
  assert.equal(route(`${origin}/kiosk-icon-192.png`, { destination: "image" }), "static");
  assert.equal(route(`${origin}/kiosk.webmanifest`, { destination: "manifest" }), "static");
  // API calls: same-origin /api, another origin, fetch() with no destination, an Authorization header, or not GET.
  assert.equal(route(`${origin}/api/kiosk/config`, { destination: "" }), "pass");
  assert.equal(route(`${origin}/api/kiosk/roster`), "pass");
  assert.equal(route("https://api.example.test/kiosk/config", { destination: "" }), "pass");
  assert.equal(route("https://cdn.example.test/assets/x.js"), "pass");
  assert.equal(route(`${origin}/kiosk/config`, { destination: "" }), "pass");
  assert.equal(route(`${origin}/assets/x.js`, { headers: { authorization: "Bearer test-token" } }), "pass");
  assert.equal(route(`${origin}/assets/x.js`, { method: "POST" }), "pass");
  assert.equal(route(`${origin}/kiosk-sw.js`), "pass");
  assert.equal(route(`${origin}/__lancerlogin-release`), "pass");
  // The cache is named for the release, so a new deploy replaces it.
  assert.equal(cacheName, "lancerlogin-kiosk-v1-2.1.0-beta.1");
  assert.equal((await serviceWorker("https://dashboard.example.test/kiosk-sw.js")).cacheName, "lancerlogin-kiosk-v1-development");
  // The HTML fallback for a missing asset, and incomplete answers, are never kept.
  assert.equal(cacheable(new Response("<html>", { headers: { "content-type": "text/html" } }), "asset"), false);
  assert.equal(cacheable(new Response("x", { status: 404, headers: { "content-type": "text/javascript" } }), "asset"), false);
  assert.equal(cacheable(new Response("x", { headers: { "content-type": "text/javascript" } }), "asset"), true);
  assert.equal(cacheable(new Response("<html>", { headers: { "content-type": "text/html; charset=utf-8" } }), "page"), true);
  assert.deepEqual(Object.keys(listeners).sort(), ["activate", "fetch", "install", "message"]);
});

test("the page registers the worker for its release and lists only its own files for the cache", () => {
  assert.equal(kioskServiceWorkerUrl("2.1.0-beta.1"), "/kiosk-sw.js?v=2.1.0-beta.1");
  const origin = "https://dashboard.example.test";
  assert.deepEqual(kioskResourceUrls(origin, [
    `${origin}/assets/index-AbC.js`, `${origin}/assets/index-AbC.css`, `${origin}/kiosk`, `${origin}/api/kiosk/config`, "https://api.example.test/kiosk/roster",
    `${origin}/kiosk-sw.js?v=1`, `${origin}/kiosk-icon-192.png#x`, `${origin}/src/main.tsx?t=1`,
  ]), ["/kiosk", "/assets/index-AbC.js", "/assets/index-AbC.css", "/kiosk-icon-192.png", "/src/main.tsx?t=1"]);
});

test("the manifest installs the kiosk page full screen, and the Pages proxy has browsers check the worker on every load", async () => {
  const manifest = JSON.parse(await readFile("apps/dashboard/public/kiosk.webmanifest", "utf8"));
  assert.deepEqual([manifest.name, manifest.short_name, manifest.start_url, manifest.scope, manifest.display], ["LancerLogin kiosk", "Kiosk", "/kiosk", "/kiosk", "fullscreen"]);
  assert.deepEqual(manifest.display_override, ["fullscreen", "standalone"]);
  assert.deepEqual(manifest.icons.map((icon: { sizes: string }) => icon.sizes), ["192x192", "512x512", "512x512"]);
  for (const icon of manifest.icons) assert.ok((await readFile(`apps/dashboard/public${icon.src}`)).subarray(1, 4).equals(Buffer.from("PNG")));

  const module = await import(`data:text/javascript,${encodeURIComponent(buildPagesProxy("https://api.example.test"))}`);
  const serve = async (path: string, type: string) => (await module.default.fetch(new Request(`https://dash.example.test${path}`), { ASSETS: { fetch: async () => new Response("x", { headers: { "content-type": type } }) } })) as Response;
  assert.equal((await serve("/kiosk-sw.js", "text/javascript")).headers.get("cache-control"), "no-cache");
  assert.equal((await serve("/kiosk.webmanifest", "application/manifest+json")).headers.get("cache-control"), "no-cache");
  assert.equal((await serve("/assets/index-AbC.js", "text/javascript")).headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await serve("/kiosk-icon-192.png", "image/png")).headers.get("cache-control"), null);
});

test("only the kiosk page links the manifest, registers the worker and asks to keep its storage", async () => {
  const page = await readFile("apps/dashboard/src/web-kiosk/web-kiosk-page.tsx", "utf8");
  assert.match(page, /installKioskApp\(dashboardReleaseVersion\)/);
  const index = await readFile("apps/dashboard/index.html", "utf8");
  assert.doesNotMatch(index, /manifest|kiosk-sw/);
  const install = await readFile("apps/dashboard/src/web-kiosk/kiosk-install.ts", "utf8");
  assert.match(install, /register\(kioskServiceWorkerUrl\(releaseVersion\), \{ scope: kioskServiceWorkerScope \}\)/);
  assert.match(install, /navigator\.storage\?\.persist\?\.\(\)/);
});

test("a database upgrade blocked by another tab's older kiosk page is announced, so the page can say to close it", async () => {
  const request: Record<string, unknown> = {};
  const factory = { open: () => request } as unknown as IDBFactory;
  const announced: string[] = []; const original = (globalThis as { dispatchEvent?: unknown }).dispatchEvent;
  // A browser window is an event target; Node's global object isn't, so capture the event instead.
  (globalThis as { dispatchEvent?: unknown }).dispatchEvent = (event: Event) => { announced.push(event.type); return true; };
  try {
    void createIndexedDbStore(factory).load().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(typeof request.onblocked, "function");
    (request.onblocked as () => void)();
    assert.deepEqual(announced, [kioskStorageBlockedEvent]);
  } finally { (globalThis as { dispatchEvent?: unknown }).dispatchEvent = original; }
});

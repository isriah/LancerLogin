import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, chmod, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, randomBytes, webcrypto } from "node:crypto";
import { createPinFailureStore, normalizeMemberSettings, normalizePinLockout, pinLockedUntil, reportPinFailures, validPin, verifyCachedPin } from "../apps/kiosk/src/member-pins.mjs";
import { createRosterCache, visibleMember } from "../apps/kiosk/src/roster-cache.mjs";
import { identityReadyState } from "../apps/kiosk/src/identity-methods.mjs";
import { sendAttendance } from "../apps/kiosk/src/cloud-client.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { searchMembers } from "../packages/shared/src/member-lookup.mjs";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = "Synthetic kiosk condition did not become true") { for (let n = 0; n < 200; n++) { if (await check()) return; await wait(40); } assert.fail(message); }
async function scratch(t) { const root = await mkdtemp(join(tmpdir(), "kiosk-pin-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
/** A PIN hash as the server stores it: PBKDF2-SHA256, 32-byte key, base64. */
function serverHash(pin, iterations = 100_000, salt = randomBytes(16)) { return { hash: pbkdf2Sync(pin, salt, iterations, 32, "sha256").toString("base64"), salt: salt.toString("base64"), iterations }; }

test("cached PIN hashes verify like the server's PBKDF2-SHA256 and malformed ones never match", async () => {
  // A vector made with WebCrypto, as the Worker hashes PINs, checks with Node's pbkdf2 on the kiosk.
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode("482913"), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  const stored = { hash: Buffer.from(bits).toString("base64"), salt: Buffer.from(salt).toString("base64"), iterations: 100_000 };
  assert.equal(await verifyCachedPin("482913", stored), true);
  assert.equal(await verifyCachedPin("482914", stored), false);
  assert.equal(await verifyCachedPin("4829", serverHash("4829", 1000)), true);
  // The server hashes new PINs at 2,000 iterations and rehashes older ones to it.
  assert.equal(await verifyCachedPin("4829", serverHash("4829", 2_000)), true);
  assert.equal(await verifyCachedPin("4828", serverHash("4829", 2_000)), false);
  for (const bad of [{ ...stored, iterations: 100_001 }, { ...stored, iterations: 0 }, { ...stored, hash: Buffer.alloc(16).toString("base64") }, { ...stored, hash: "not base64!" }, { ...stored, salt: "" }, null, undefined])
    assert.equal(await verifyCachedPin("482913", bad), false);
  for (const pin of ["123", "1234567", "12a4", 1234, ""]) { assert.equal(validPin(pin), false); assert.equal(await verifyCachedPin(pin, stored), false); }
  assert.equal(validPin("0000"), true); assert.equal(validPin("999999"), true);
});

test("member lookup and Require PIN apply only to member ID kiosks, with the server's lockout defaults", () => {
  assert.deepEqual(normalizeMemberSettings({ authenticationMethod: "member_id", memberLookup: "search", requirePin: true, pinLockout: { enabled: true, attempts: 4, minutes: 30 } }), { memberLookup: "search", requirePin: true, pinLockout: { enabled: true, attempts: 4, minutes: 30 }, discordCode: false, discordCodeBackup: "offline" });
  assert.deepEqual(normalizeMemberSettings({ authenticationMethod: "fingerprint", memberLookup: "search", requirePin: true }), { memberLookup: "entry", requirePin: false, pinLockout: { enabled: false, attempts: 5, minutes: 15 }, discordCode: false, discordCodeBackup: "offline" });
  assert.deepEqual(normalizeMemberSettings(undefined), { memberLookup: "entry", requirePin: false, pinLockout: { enabled: false, attempts: 5, minutes: 15 }, discordCode: false, discordCodeBackup: "offline" });
  assert.deepEqual(normalizePinLockout({ enabled: true, attempts: 2, minutes: 2000 }), { enabled: true, attempts: 5, minutes: 15 });
  assert.deepEqual(identityReadyState("member_id", { memberLookup: "search" }), { message: "Find your name", detail: "Search by name, member ID or email" });
  assert.deepEqual(identityReadyState("member_id", { memberLookup: "entry" }), { message: "Enter member ID", detail: "Use the touch keyboard below" });
});

test("wrong PIN tries made offline are counted owner-only, lock at the limit, and are reported once", async t => {
  const root = await scratch(t); const path = join(root, "pin-failures.json"); let clock = Date.parse("2026-10-30T12:00:00.000Z");
  const store = createPinFailureStore(path, { now: () => clock }); const lockout = { enabled: true, attempts: 3, minutes: 10 };
  assert.deepEqual(await store.recordFailure("1009", lockout), { attemptsLeft: 2 });
  assert.deepEqual(await store.recordFailure("1009", lockout), { attemptsLeft: 1 });
  assert.deepEqual(await store.recordFailure("1009", lockout), { attemptsLeft: 0, lockedUntil: "2026-10-30T12:10:00.000Z" });
  assert.equal(await store.lockedUntil("1009"), "2026-10-30T12:10:00.000Z");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal((await readFile(path, "utf8")).includes("pin\""), false, "no PIN or hash is stored with the tries");
  // A new process reads the same count and lock.
  const reopened = createPinFailureStore(path, { now: () => clock });
  assert.equal(await reopened.lockedUntil("1009"), "2026-10-30T12:10:00.000Z");
  assert.deepEqual(await reopened.pending(), [{ memberId: "1009", count: 3, lastAt: "2026-10-30T12:00:00.000Z" }]);
  // A lock that ran out starts a fresh count; lockout off only counts.
  clock += 11 * 60_000;
  assert.equal(await reopened.lockedUntil("1009"), null);
  assert.deepEqual(await reopened.recordFailure("1009", lockout), { attemptsLeft: 2 });
  assert.deepEqual(await reopened.recordFailure("1010", { enabled: false }), {});
  // Tries counted while a report is on its way stay for the next one.
  // They follow in a report of their own, under another id, in the same call.
  const sent = [], ids = [];
  assert.equal(await reportPinFailures(reopened, async (failures, reportId) => { sent.push(failures); ids.push(reportId); if (sent.length === 1) await reopened.recordFailure("1010", { enabled: false }); }), 3);
  assert.deepEqual(sent.map(failures => failures.map(item => [item.memberId, item.count])), [[["1009", 4], ["1010", 1]], [["1010", 1]]]);
  assert.equal(new Set(ids).size, 2); for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await reopened.pending(), []);
  await reopened.recordFailure("1010", { enabled: false });
  await assert.rejects(reportPinFailures(reopened, async () => { throw new Error("offline"); }));
  assert.deepEqual((await reopened.pending()).map(item => [item.memberId, item.count]), [["1010", 1]], "a failed report keeps the tries");
  // A right PIN ends the run of wrong tries; setting or resetting a PIN forgets the member.
  await reopened.recordSuccess("1009"); assert.equal(await reopened.lockedUntil("1009"), null);
  await reopened.recordLock("1009", "2026-10-30T13:00:00.000Z"); assert.equal(await reopened.lockedUntil("1009"), "2026-10-30T13:00:00.000Z");
  await reopened.forget("1009"); assert.equal(await reopened.lockedUntil("1009"), null);
  await reopened.clear();
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.deepEqual(await reopened.pending(), []);
});

test("a member is refused locally while the roster's or the kiosk's lock is in the future", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  assert.equal(pinLockedUntil({ pinLockedUntil: "2026-10-30T12:05:00.000Z" }, null, now), "2026-10-30T12:05:00.000Z");
  assert.equal(pinLockedUntil({ pinLockedUntil: "2026-10-30T11:55:00.000Z" }, null, now), null);
  assert.equal(pinLockedUntil({ pinLockedUntil: "2026-10-30T12:05:00.000Z" }, "2026-10-30T12:20:00.000Z", now), "2026-10-30T12:20:00.000Z");
  assert.equal(pinLockedUntil({}, "garbage", now), null);
});

test("the roster cache keeps emails only for search and PIN hashes only with Require PIN, and never shows either", async t => {
  const root = await scratch(t); const path = join(root, "roster-cache.json"); const cache = createRosterCache(path);
  const pin = serverHash("4321", 1000);
  const members = [
    { memberId: "1009", firstName: "Test Student", lastName: "I", email: "test.student.i@example.test", pin, pinLockedUntil: null },
    { memberId: "1010", firstName: "Test Student", lastName: "J", email: "test.student.j@example.test", pin: null, pinLockedUntil: null },
  ];
  await cache.replace(members, { email: false, pins: false });
  assert.equal(await readFile(path, "utf8").then(text => /example\.test|"pin"/.test(text)), false);
  await cache.replace(members, { email: true, pins: true });
  assert.deepEqual(await cache.find(" 1009 "), { memberId: "1009", firstName: "Test Student", lastName: "I", email: "test.student.i@example.test", pin });
  assert.equal(await cache.numericIds(), true);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
  // Search matches the email but returns name and member ID only.
  const results = searchMembers(await cache.read(), "test.student.j");
  assert.deepEqual(results, [{ memberId: "1010", firstName: "Test Student", lastName: "J" }]);
  assert.deepEqual(searchMembers(await cache.read(), "example.test"), [], "a shared domain matches no one");
  assert.deepEqual(searchMembers(await cache.read(), "student i"), [{ memberId: "1009", firstName: "Test Student", lastName: "I" }]);
  assert.deepEqual(visibleMember((await cache.read())[0]), { memberId: "1009", firstName: "Test Student", lastName: "I" });
  // Turning off Require PIN (and search) drops what is cached, in memory and on disk.
  await cache.retain({ email: true, pins: false });
  assert.equal((await readFile(path, "utf8")).includes("\"pin\""), false);
  assert.equal((await cache.find("1009")).email, "test.student.i@example.test");
  await cache.retain({ email: false, pins: false });
  assert.equal((await readFile(path, "utf8")).includes("example.test"), false);
  assert.deepEqual(await createRosterCache(path).find("1009"), { memberId: "1009", firstName: "Test Student", lastName: "I" });
  await cache.replace([{ memberId: "TS-1" }]); assert.equal(await cache.numericIds(), false);
});

test("a scan sent with a PIN carries it, PIN refusals come back to the screen, and queued scans say pinCheck offline", async () => {
  const bodies = []; let reply;
  const fetchImpl = async (url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }); };
  const config = { apiUrl: "http://127.0.0.1:9", kioskToken: "synthetic-token" };
  const event = { eventId: "synthetic-event", memberId: "1009", occurredAt: "2026-10-30T12:00:00.000Z", pairingId: "synthetic-pairing" };
  // The Worker answers a wrong PIN with 403; the kiosk goes by the code, so an older 401 reads the same, and a PIN
  // answer is never mistaken for a revoked kiosk credential.
  reply = { status: 403, body: { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 2 } };
  assert.deepEqual(await sendAttendance(config, { ...event, pin: "1111" }, { fetchImpl }), { accepted: false, duplicate: false, pinRefused: true, status: 403, code: "pin_incorrect", error: "Wrong PIN.", attemptsLeft: 2 });
  assert.equal(bodies[0].pin, "1111");
  reply = { status: 401, body: { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 0, lockedUntil: "2026-10-30T12:15:00.000Z" } };
  assert.deepEqual([(await sendAttendance(config, { ...event, pin: "1111" }, { fetchImpl })).code, "pinRefused"], ["pin_incorrect", "pinRefused"]);
  reply = { status: 401, body: { error: "Kiosk credential is invalid" } };
  await assert.rejects(sendAttendance(config, { ...event, pin: "1111" }, { fetchImpl }), error => error.transient === true, "a credential refusal is not a PIN answer");
  reply = { status: 423, body: { error: "Locked", code: "pin_locked", lockedUntil: "2026-10-30T12:15:00.000Z" } };
  assert.equal((await sendAttendance(config, { ...event, pin: "1111" }, { fetchImpl })).lockedUntil, "2026-10-30T12:15:00.000Z");
  // A throttled try is a PIN answer too, so the kiosk never falls back to its cached hash for it.
  reply = { status: 429, body: { error: "Too many wrong PINs. Try again in 30 seconds.", code: "pin_throttled", retryAt: "2026-10-30T12:00:30.000Z", retryAfterSeconds: 30 } };
  assert.deepEqual(await sendAttendance(config, { ...event, pin: "1111" }, { fetchImpl }), { accepted: false, duplicate: false, pinRefused: true, status: 429, code: "pin_throttled", error: "Too many wrong PINs. Try again in 30 seconds." });
  reply = { status: 409, body: { error: "No PIN", code: "pin_not_set" } };
  assert.equal((await sendAttendance(config, { ...event, pin: "1111" }, { fetchImpl })).code, "pin_not_set");
  // A queued scan never has a PIN.
  reply = { status: 200, body: { eventId: "synthetic-event", accepted: true } };
  await sendAttendance(config, { ...event, pinCheck: "offline" }, { fetchImpl });
  assert.equal(bodies.at(-1).pinCheck, "offline"); assert.equal("pin" in bodies.at(-1), false);
  // A PIN refusal for a scan without a PIN is no PIN answer for the screen, and is never retried: it is a rejection.
  reply = { status: 400, body: { error: "This kiosk requires a PIN.", code: "pin_required" } };
  for (const scan of [event, { ...event, pinCheck: "offline" }])
    assert.deepEqual(await sendAttendance(config, scan, { fetchImpl }), { accepted: false, rejected: true, status: 400, code: "pin_required", error: "This kiosk requires a PIN." });
  reply = { status: 423, body: { error: "Locked", code: "pin_locked", lockedUntil: "2026-10-30T12:15:00.000Z" } };
  assert.deepEqual(await sendAttendance(config, event, { fetchImpl }), { accepted: false, rejected: true, status: 423, code: "pin_locked", error: "Locked" });
  // Other refusals the kiosk does not know still stay queued.
  reply = { status: 400, body: { error: "Bad request", code: "made_up_reason" } };
  await assert.rejects(sendAttendance(config, event, { fetchImpl }), error => error.transient === true);
});

test("a queued scan the Worker refuses for want of a PIN never holds up the queue: it is kept for review and later scans sync", async t => {
  const root = await scratch(t); const path = join(root, "attendance-queue.json"); const sent = [];
  // A Worker that requires a PIN: it refuses a scan with neither pin nor pinCheck, as it does for one made after the change.
  const fetchImpl = async (url, options) => {
    const input = JSON.parse(options.body); sent.push(input.eventId);
    const refused = input.pin === undefined && input.pinCheck !== "offline";
    return new Response(JSON.stringify(refused ? { error: "This kiosk requires a PIN.", code: "pin_required" } : { eventId: input.eventId, accepted: true }), { status: refused ? 400 : 202, headers: { "content-type": "application/json" } });
  };
  const config = { apiUrl: "http://127.0.0.1:9", kioskToken: "synthetic-token" };
  const queue = createFileQueue(path);
  await queue.enqueue({ eventId: "synthetic-plain-1", memberId: "1009", occurredAt: "2026-10-30T12:00:00.000Z", pairingId: "synthetic-pairing" });
  await queue.enqueue({ eventId: "synthetic-plain-2", memberId: "1010", occurredAt: "2026-10-30T12:01:00.000Z", pairingId: "synthetic-pairing" });
  await queue.enqueue({ eventId: "synthetic-checked", memberId: "1011", occurredAt: "2026-10-30T12:02:00.000Z", pairingId: "synthetic-pairing", pinCheck: "offline" });
  assert.deepEqual(await queue.flush(item => sendAttendance(config, item, { fetchImpl })), ["synthetic-plain-1", "synthetic-plain-2", "synthetic-checked"]);
  assert.deepEqual(sent, ["synthetic-plain-1", "synthetic-plain-2", "synthetic-checked"], "each scan was sent once");
  const reopened = createFileQueue(path);
  assert.deepEqual(await reopened.pending(), []);
  assert.deepEqual((await reopened.rejections()).map(record => [record.eventId, record.memberId, record.occurredAt, record.reasonCode, record.httpStatus, record.reviewStatus]), [
    ["synthetic-plain-1", "1009", "2026-10-30T12:00:00.000Z", "pin_required", 400, "open"],
    ["synthetic-plain-2", "1010", "2026-10-30T12:01:00.000Z", "pin_required", 400, "open"],
  ]);
});

/**
 * True when a saved kiosk file holds `pin`. The files also hold random ids (a queued scan's eventId and bootId, a
 * wrong-try report's id) and clock readings, and a plain search for a four-digit PIN finds it in one of those about once
 * in every few thousand runs. So ids and times are left out, and the PIN counts only as a whole run of digits in a
 * name or a text value. A PIN is always text: the kiosk never handles one as a number.
 */
function holdsPin(text, pin) {
  const whole = new RegExp(`(?<!\\d)${pin}(?!\\d)`);
  const inText = value => whole.test(value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>"));
  const found = value => typeof value === "string" ? inText(value) : value !== null && typeof value === "object" && Object.entries(value).some(([name, item]) => inText(name) || found(item));
  // A file that is not one JSON document, such as a journal of lines, is searched as text.
  try { return found(JSON.parse(text)); } catch { return inText(text); }
}

test("the saved-file PIN check finds a PIN and is not fooled by ids, times or longer numbers", () => {
  assert.equal(holdsPin('{"members":{"1009":{"pin":"1111"}}}', "1111"), true);
  assert.equal(holdsPin('{"note":"PIN 1111 entered"}', "1111"), true);
  assert.equal(holdsPin('{"1111":{"unreported":1}}', "1111"), true, "a PIN used as a key is found too");
  // What failed once: a report id with the wrong PIN's digits in it.
  assert.equal(holdsPin('{"version":1,"members":{"1009":{"unreported":3,"lastAt":"2026-11-11T11:11:11.111Z","streak":0,"lockedUntil":null}},"report":{"id":"3f1111a2-7c1e-4b1d-9111-1c2d3e41111f","failures":[]}}', "1111"), false);
  assert.equal(holdsPin('{"eventId":"a2468b00-0000-4000-8000-000000002468","clock":{"elapsedMs":124681,"bootId":"02468ace-2468-4246-8246-246802468ace"}}', "2468"), false);
});

// ---- The real kiosk service, with a synthetic Worker ----

async function pinRuntime(t, { settings }) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-pin-runtime-")); await chmod(root, 0o700);
  const pins = new Map([["1009", serverHash("4321", 1000)], ["1011", serverHash("2468", 1000)]]);
  const world = { online: true, settings, attendance: [], failures: [], reportIds: [] };
  const roster = [["1009", "I"], ["1010", "J"], ["1011", "K"]].map(([memberId, letter]) => ({ memberId, rosterId: `roster-${memberId}`, firstName: "Test Student", lastName: letter, email: `test.student.${letter.toLowerCase()}@example.test` }));
  const cloud = createServer(async (request, response) => {
    if (!world.online) { request.socket.destroy(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    response.setHeader("content-type", "application/json");
    const search = world.settings.memberLookup === "search", requirePin = world.settings.requirePin === true;
    let status = 200, data = {};
    if (request.url?.startsWith("/kiosk/poll")) { status = 404; data = { error: "Not found" }; }
    else if (request.url === "/kiosk/config") data = { kiosk: { id: "synthetic-kiosk", name: "Synthetic PIN kiosk" }, settings: { organizationName: "Synthetic Club", ...world.settings } };
    else if (request.url === "/kiosk/roster") data = { members: roster.map(({ email, ...member }) => ({ ...member, ...(search ? { email } : {}), ...(requirePin ? { pin: pins.get(member.memberId) ?? null, pinLockedUntil: null } : {}) })) };
    else if (request.url === "/kiosk/attendance") {
      if (requirePin && input.pinCheck !== "offline") {
        if (input.pin === undefined) { status = 400; data = { error: "This kiosk requires a PIN.", code: "pin_required" }; }
        else if (!pins.has(input.memberId)) { status = 409; data = { error: "This member has no PIN yet.", code: "pin_not_set" }; }
        else if (world.throttled) { status = 429; data = { error: "Too many wrong PINs. Try again in 1 minute.", code: "pin_throttled", retryAt: new Date(Date.now() + 60_000).toISOString(), retryAfterSeconds: 60 }; }
        else if (!await verifyCachedPin(input.pin, pins.get(input.memberId))) { status = 403; data = { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 4 }; }
      }
      if (status === 200) { world.attendance.push(input); data = { eventId: input.eventId, accepted: true, action: "check_in", member: { displayName: "Test Student" } }; }
    } else if (request.url === "/kiosk/pin-failures") world.failures.push(...input.failures), world.reportIds.push(input.reportId), data = { recorded: input.failures.length };
    else if (request.url === "/kiosk/commands") data = { command: null };
    else if (request.url === "/kiosk/enrollment") data = { enrollment: null };
    response.statusCode = status; response.end(JSON.stringify(data));
  });
  await new Promise(resolve => cloud.listen(0, "127.0.0.1", resolve));
  const children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill(); await done; } cloud.closeAllConnections(); await new Promise(resolve => cloud.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const env = { ...process.env, NODE_ENV: "development", LANCERLOGIN_KIOSK_PORT: "0", LANCERLOGIN_KIOSK_HOST: "127.0.0.1", LANCERLOGIN_SENSOR_PATH: "synthetic" };
  for (const [key, name] of Object.entries({ CONFIG: "pairing.json", NETWORK_PIN: "network-pin.json", QUEUE: "attendance-queue.json", MAPPINGS: "slot-mappings.json", BRANDING: "branding.json", AUTHENTICATION: "authentication.json", CREDENTIAL_MAPPINGS: "credential-mappings.json", ROSTER_CACHE: "roster-cache.json", FINGERPRINT_SYNC: "fingerprint-sync", FINGERPRINT_VAULT: "fingerprint-vault", FINGERPRINT_RESET: "fingerprint-reset", FINGERPRINT_REVIEW: "fingerprint-review" })) env[`LANCERLOGIN_${key}`] = join(root, name);
  await writeFile(env.LANCERLOGIN_CONFIG, JSON.stringify({ apiUrl: `http://127.0.0.1:${cloud.address().port}`, kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing", kioskToken: "synthetic-token", kioskName: "Synthetic PIN kiosk" }), { mode: 0o600 });
  await createNetworkPinStore(env.LANCERLOGIN_NETWORK_PIN).set("123456");
  async function start() {
    const child = fork(new URL("./fixtures/kiosk-operator-runtime-child.mjs", import.meta.url), [], { env, execArgv: ["--experimental-test-module-mocks"], stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(child);
    let diagnostics = ""; child.stderr.on("data", chunk => { diagnostics += chunk; }); child.stdout.resume();
    const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Child startup timed out: " + diagnostics)), 8000); child.on("message", message => { if (message.ready) { clearTimeout(timer); resolve(message.port); } }); child.once("exit", () => { clearTimeout(timer); reject(new Error("Child failed: " + diagnostics)); }); });
    const request = (path, input, method) => fetch(`http://127.0.0.1:${port}${path}`, { method: method ?? (input === undefined ? "GET" : "POST"), headers: { "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
    const json = async (path, input) => { const response = await request(path, input); return { status: response.status, body: await response.json() }; };
    if (!(await (await request("/health")).json()).clock.verified) {
      assert.equal((await request("/network/unlock", { pin: "123456" })).status, 200);
      await request("/maintenance/clock", { currentTime: new Date().toISOString() });
      await request("/network/session", undefined, "DELETE");
    }
    const page = await json("/operator-presence", { action: "enter", pageId: "synthetic-pin-page", mode: "attendance" }); assert.equal(page.status, 200);
    async function stop() { const done = once(child, "exit"); child.send({ orderlyStop: true }); await done; }
    return { request, json, stop, child };
  }
  const cached = async () => JSON.parse(await readFile(join(root, "roster-cache.json"), "utf8").catch(() => "{\"members\":[]}")).members;
  return { root, world, start, cached };
}

test("a Require PIN kiosk confirms, checks PINs online and offline, counts offline tries, and wipes hashes when Require PIN turns off", { timeout: 60000 }, async t => {
  const f = await pinRuntime(t, { settings: { authenticationMethod: "member_id", memberLookup: "search", requirePin: true, pinLockout: { enabled: true, attempts: 3, minutes: 15 } } });
  let kiosk = await f.start();
  await until(async () => (await f.cached()).some(member => member.pin), "the roster with PIN hashes was cached");
  const display = (await kiosk.json("/display-state")).body;
  assert.equal(display.memberLookup, "search"); assert.equal(display.requirePin, true); assert.equal(display.memberIdKeypad, true);
  assert.equal(display.display.message, "Find your name");
  const saved = JSON.parse(await readFile(join(f.root, "authentication.json"), "utf8"));
  assert.deepEqual(saved, { authenticationMethod: "member_id", memberLookup: "search", requirePin: true, pinLockout: { enabled: true, attempts: 3, minutes: 15 }, discordCode: false, discordCodeBackup: "offline" });

  // Search matches emails but shows only names and member IDs; the display never carries emails or hashes.
  const found = await kiosk.json("/identity/search", { query: "test.student.j" });
  assert.deepEqual(found.body.members, [{ memberId: "1010", firstName: "Test Student", lastName: "J" }]);
  assert.equal(JSON.stringify(display).includes("example.test"), false);
  // Confirm first: nothing is recorded until the member confirms, and a Require PIN kiosk wants the PIN.
  assert.deepEqual((await kiosk.json("/identity", { method: "member_id", memberId: "1009" })).body, { confirm: { memberId: "1009", firstName: "Test Student", lastName: "I" } });
  assert.equal((await kiosk.json("/identity", { method: "member_id", memberId: "1009", confirmed: true })).body.code, "pin_required");
  const none = await kiosk.json("/identity", { method: "member_id", memberId: "1010", confirmed: true });
  assert.deepEqual([none.status, none.body.code], [409, "pin_not_set"], "a member without a PIN goes straight to PIN setup");
  // Online, the server checks the PIN it is sent.
  const wrong = await kiosk.json("/identity", { method: "member_id", memberId: "1009", confirmed: true, pin: "1111" });
  assert.equal(wrong.status, 403); assert.equal(wrong.body.code, "pin_incorrect"); assert.equal(wrong.body.attemptsLeft, 4); assert.equal(wrong.body.offline, undefined);
  const right = await kiosk.json("/identity", { method: "member_id", memberId: "1009", confirmed: true, pin: "4321" });
  assert.equal(right.status, 200); assert.equal(right.body.recorded, true);
  assert.equal(f.world.attendance.length, 1); assert.equal(f.world.attendance[0].pin, "4321");
  assert.equal((await kiosk.json("/display-state")).body.display.id, "welcome");
  assert.equal((await kiosk.json("/identity", { method: "member_id", memberId: "1010", confirmed: true, pin: "1234" })).body.code, "pin_not_set");
  // A throttled try comes back with the server's message; even the right PIN is not checked against the cached hash.
  f.world.throttled = true;
  const waiting = await kiosk.json("/identity", { method: "member_id", memberId: "1009", confirmed: true, pin: "4321" });
  assert.deepEqual([waiting.status, waiting.body.code, waiting.body.error, waiting.body.offline], [429, "pin_throttled", "Too many wrong PINs. Try again in 1 minute.", undefined]);
  assert.equal(f.world.attendance.length, 1, "nothing was recorded or queued");
  f.world.throttled = false;

  // Offline, the cached hash decides and wrong tries are counted here until the cached lockout locks the member.
  f.world.online = false;
  for (const attemptsLeft of [2, 1]) {
    const miss = await kiosk.json("/identity", { method: "member_id", memberId: "1009", confirmed: true, pin: "1111" });
    assert.equal(miss.status, 403); assert.deepEqual([miss.body.code, miss.body.attemptsLeft, miss.body.offline], ["pin_incorrect", attemptsLeft, true]);
  }
  const locking = await kiosk.json("/identity", { method: "member_id", memberId: "1009", confirmed: true, pin: "1111" });
  assert.equal(locking.body.attemptsLeft, 0); assert.ok(Date.parse(locking.body.lockedUntil) > Date.now());
  const locked = await kiosk.json("/identity", { method: "member_id", memberId: "1009", confirmed: true, pin: "4321" });
  assert.equal(locked.status, 423); assert.equal(locked.body.code, "pin_locked");
  assert.equal((await kiosk.json("/identity", { method: "member_id", memberId: "1010", confirmed: true, pin: "1234" })).body.code, "pin_not_set");
  const queued = await kiosk.json("/identity", { method: "member_id", memberId: "1011", confirmed: true, pin: "2468" });
  assert.equal(queued.status, 202); assert.equal(queued.body.queued, true);
  for (const name of await readdir(f.root)) if (name.startsWith("attendance-queue")) assert.equal(holdsPin(await readFile(join(f.root, name), "utf8").catch(() => ""), "2468"), false, `${name} never holds a PIN`);
  assert.equal(holdsPin(await readFile(join(f.root, "pin-failures.json"), "utf8"), "1111"), false, "pin-failures.json never holds a PIN");
  if (process.platform !== "win32") assert.equal((await stat(join(f.root, "pin-failures.json"))).mode & 0o077, 0);

  // Back online after a restart: the queued scan syncs with pinCheck "offline" and the tries are reported.
  f.world.online = true; await kiosk.stop(); kiosk = await f.start();
  await until(() => f.world.attendance.some(event => event.memberId === "1011") && f.world.failures.length > 0, "the offline scan and tries reached the server");
  const offlineScan = f.world.attendance.find(event => event.memberId === "1011");
  assert.equal(offlineScan.pinCheck, "offline"); assert.equal("pin" in offlineScan, false);
  // The first try was frozen into a report when the kiosk tried to send it while offline; the two tries made after
  // that follow in the next report. Each try reaches the server once.
  await until(() => f.world.failures.reduce((sum, item) => sum + item.count, 0) >= 3, "every offline try reached the server");
  assert.deepEqual([...new Set(f.world.failures.map(item => item.memberId))], ["1009"]);
  assert.equal(f.world.failures.reduce((sum, item) => sum + item.count, 0), 3);
  assert.equal(new Set(f.world.reportIds).size, f.world.reportIds.length, "one id for each report"); assert.ok(f.world.reportIds.every(id => typeof id === "string" && id.length === 36));

  // Turning off Require PIN and search wipes the cached hashes, the offline tries and the emails.
  f.world.settings = { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, pinLockout: { enabled: true, attempts: 3, minutes: 15 } };
  await kiosk.stop(); kiosk = await f.start();
  await until(async () => { const members = await f.cached(); return members.length === 3 && members.every(member => !("pin" in member) && !("email" in member)); }, "hashes and emails were removed");
  // The kiosk removes the offline tries right after the hashes, so this waits for the file to go instead of racing it.
  await until(() => stat(join(f.root, "pin-failures.json")).then(() => false, (error) => error?.code === "ENOENT"), "the offline tries were removed");
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "authentication.json"), "utf8")).requirePin, false);
  assert.equal((await kiosk.json("/display-state")).body.display.message, "Enter member ID");
  assert.equal((await kiosk.json("/identity/search", { query: "test" })).status, 400);
  assert.equal((await kiosk.json("/identity/pin-requests", { memberId: "1009" })).status, 409);
});

test("unpairing wipes cached PIN hashes instead of archiving them", { timeout: 30000 }, async t => {
  const f = await pinRuntime(t, { settings: { authenticationMethod: "member_id", memberLookup: "entry", requirePin: true, pinLockout: { enabled: false, attempts: 5, minutes: 15 } } });
  const kiosk = await f.start();
  await until(async () => (await f.cached()).some(member => member.pin), "the roster with PIN hashes was cached");
  assert.equal((await kiosk.request("/network/unlock", { pin: "123456" })).status, 200);
  // Maintenance never receives emails or PIN data either.
  const members = (await kiosk.json("/maintenance/members")).body.members;
  assert.equal(members.length, 3); assert.equal(JSON.stringify(members).includes("hash"), false);
  const exit = once(kiosk.child, "exit");
  assert.equal((await kiosk.request("/maintenance/unpair", { confirmation: "UNPAIR" })).status, 200);
  await exit;
  const archives = (await readdir(join(f.root, "reassociation"))).filter(name => /^[0-9a-f-]{36}$/.test(name));
  assert.equal(archives.length, 1);
  const archived = await readFile(join(f.root, "reassociation", archives[0], "roster-cache.json"), "utf8");
  assert.match(archived, /Test Student/); assert.equal(archived.includes("\"pin\""), false);
});

test("a wrong-PIN report keeps its id and its tries until the server answers it, across resends and restarts", async t => {
  const root = await scratch(t); const path = join(root, "pin-failures.json"); let clock = Date.parse("2026-10-30T12:00:00.000Z");
  let made = 0; const newId = () => `test-report-${made += 1}`;
  const store = createPinFailureStore(path, { now: () => clock, newId }); const off = { enabled: false };
  assert.equal(await store.report(), null, "nothing to report");
  await store.recordFailure("1009", off); await store.recordFailure("1009", off); await store.recordFailure("1010", off);
  const sends = [];
  // The report reaches the server, but its answer is lost: to the kiosk the send failed.
  const lost = async (failures, reportId) => { sends.push({ reportId, failures }); throw new Error("the answer was lost"); };
  await assert.rejects(reportPinFailures(store, lost));
  assert.deepEqual(sends[0], { reportId: "test-report-1", failures: [{ memberId: "1009", count: 2, lastAt: "2026-10-30T12:00:00.000Z" }, { memberId: "1010", count: 1, lastAt: "2026-10-30T12:00:00.000Z" }] });
  assert.equal(JSON.parse(await readFile(path, "utf8")).report.id, "test-report-1", "the report is saved with its id before it is sent");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);

  // More wrong tries while it waits, for a member in the report and for a new one: the report does not change.
  clock += 60_000;
  await store.recordFailure("1009", off); await store.recordFailure("1011", off);
  await assert.rejects(reportPinFailures(store, lost));
  assert.deepEqual(sends[1], sends[0], "the resend is the same report: same id, same tries");
  // Still the same after a restart.
  const restarted = createPinFailureStore(path, { now: () => clock, newId });
  await assert.rejects(reportPinFailures(restarted, lost));
  assert.deepEqual(sends[2], sends[0]);
  assert.equal(made, 1, "no new id while the report is unanswered");
  assert.deepEqual((await restarted.pending()).map(item => [item.memberId, item.count]), [["1009", 3], ["1010", 1], ["1011", 1]], "nothing is dropped meanwhile");

  // The server answers. The tries made since go in the next report, under a new id, and nothing is sent twice.
  const answered = [];
  assert.equal(await reportPinFailures(restarted, async (failures, reportId) => { answered.push({ reportId, failures }); }), 4);
  assert.deepEqual(answered.map(report => [report.reportId, report.failures.map(item => [item.memberId, item.count])]), [["test-report-1", [["1009", 2], ["1010", 1]]], ["test-report-2", [["1009", 1], ["1011", 1]]]]);
  assert.deepEqual(await restarted.pending(), []); assert.equal(await restarted.report(), null);
  assert.equal("report" in JSON.parse(await readFile(path, "utf8")), false);
  // Every try was sent in exactly one answered report.
  const total = {}; for (const report of answered) for (const item of report.failures) total[item.memberId] = (total[item.memberId] ?? 0) + item.count;
  assert.deepEqual(total, { 1009: 3, 1010: 1, 1011: 1 });

  // A PIN set or reset forgets the member's tries; a report already on its way is left as it was sent (the server leaves
  // out tries older than the member's PIN). Its answer then has nothing left to remove for that member.
  await restarted.recordFailure("1012", off);
  await assert.rejects(reportPinFailures(restarted, lost));
  await restarted.forget("1012");
  const afterForget = [];
  assert.equal(await reportPinFailures(restarted, async (failures, reportId) => { afterForget.push([reportId, failures.length]); }), 1);
  assert.deepEqual(afterForget, [["test-report-3", 1]]); assert.equal(await restarted.report(), null);
  // Turning Require PIN off clears a waiting report with the tries.
  await restarted.recordFailure("1013", off); await assert.rejects(reportPinFailures(restarted, lost));
  await restarted.clear(); assert.equal(await restarted.report(), null);
  // A file from before report ids, and one with a malformed report, load without one.
  await writeFile(path, JSON.stringify({ version: 1, members: { 1014: { unreported: 2, lastAt: "2026-10-30T12:00:00.000Z", streak: 2, lockedUntil: null } }, report: { id: "", failures: "none" } }));
  const older = createPinFailureStore(path, { now: () => clock, newId });
  assert.deepEqual(await older.report(), { id: "test-report-5", failures: [{ memberId: "1014", count: 2, lastAt: "2026-10-30T12:00:00.000Z" }] });
});

// ---- Maintenance: Set member PIN sheet ----

// Runs the sheet's own code from the maintenance script against a minimal page: only the elements it touches.
async function memberPinSheet({ save }) {
  const { maintenanceApp } = await import("../apps/kiosk/src/maintenance-ui.mjs");
  const start = maintenanceApp.indexOf("function showMemberPinStep("), end = maintenanceApp.indexOf('byId("reset-member-pin")');
  assert.ok(start > 0 && end > start, "the Set member PIN code is where this test expects it");
  const elements = new Map(), messages = [];
  const byId = id => { if (!elements.has(id)) { const handlers = {}; elements.set(id, { id, value: "", textContent: "", hidden: true, disabled: false, handlers, addEventListener: (type, handler) => { handlers[type] = handler; } }); } return elements.get(id); };
  const member = { memberId: "1010", firstName: "Test Student", lastName: "J" };
  new Function("byId", "call", "pinMember", "memberLabel", "message", "friendlyError",
    `let memberPinStep, memberPinFirst = "";\n${maintenanceApp.slice(start, end)}`)(byId, save, () => member, () => "J, Test Student · 1010", (text, error = false) => messages.push([text, error]), error => error.message);
  const enter = async pin => { byId("member-pin-display").value = pin; await byId("member-pin-next").handlers.click(); };
  return { byId, enter, messages, open: () => byId("set-member-pin").handlers.click() };
}

test("after Set member PIN fails, the operator starts again at the first entry instead of seeing a false mismatch", async () => {
  const saved = []; let fail = true;
  const sheet = await memberPinSheet({ save: async (path, options) => {
    if (fail) throw new Error("The PIN could not be saved");
    saved.push([path, JSON.parse(options.body)]); return { pinSet: true };
  } });
  const text = id => sheet.byId(id).textContent;
  sheet.open();
  assert.equal(text("member-pin-title"), "Choose a PIN");
  await sheet.enter("1357");
  assert.equal(text("member-pin-title"), "Type the PIN again");
  await sheet.enter("1357");
  // The save failed: the sheet stays open, says why, and is back at the first entry with nothing typed.
  assert.equal(sheet.byId("member-pin-sheet").hidden, false);
  assert.equal(text("member-pin-error"), "The PIN could not be saved");
  assert.equal(text("member-pin-title"), "Choose a PIN");
  assert.equal(text("member-pin-next"), "Next");
  assert.equal(sheet.byId("member-pin-display").value, "");
  assert.equal(sheet.byId("member-pin-next").disabled, false);
  // Typing the PIN again is a first entry, not a comparison with the cleared one.
  fail = false;
  await sheet.enter("1357");
  assert.equal(text("member-pin-error"), "");
  assert.equal(text("member-pin-title"), "Type the PIN again");
  await sheet.enter("1357");
  assert.deepEqual(saved, [["/maintenance/member-pins", { memberId: "1010", pin: "1357" }]]);
  assert.equal(sheet.byId("member-pin-sheet").hidden, true);
  assert.deepEqual(sheet.messages, [["PIN set for Test Student J.", false]]);
  // A real mismatch still says so.
  sheet.open(); await sheet.enter("1357"); await sheet.enter("2468");
  assert.equal(text("member-pin-error"), "The two PINs don't match. Choose a PIN again.");
  assert.equal(text("member-pin-title"), "Choose a PIN");
  assert.equal(saved.length, 1);
});

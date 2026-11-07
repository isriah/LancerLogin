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
  assert.deepEqual(normalizeMemberSettings({ authenticationMethod: "member_id", memberLookup: "search", requirePin: true, pinLockout: { enabled: true, attempts: 4, minutes: 30 } }), { memberLookup: "search", requirePin: true, pinLockout: { enabled: true, attempts: 4, minutes: 30 } });
  assert.deepEqual(normalizeMemberSettings({ authenticationMethod: "fingerprint", memberLookup: "search", requirePin: true }), { memberLookup: "entry", requirePin: false, pinLockout: { enabled: false, attempts: 5, minutes: 15 } });
  assert.deepEqual(normalizeMemberSettings(undefined), { memberLookup: "entry", requirePin: false, pinLockout: { enabled: false, attempts: 5, minutes: 15 } });
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
  const sent = [];
  assert.equal(await reportPinFailures(reopened, async failures => { sent.push(failures); await reopened.recordFailure("1010", { enabled: false }); }), 2);
  assert.deepEqual(sent[0].map(item => [item.memberId, item.count]), [["1009", 4], ["1010", 1]]);
  assert.deepEqual((await reopened.pending()).map(item => [item.memberId, item.count]), [["1010", 1]]);
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
  // A queued scan never has a PIN; a PIN refusal for one is not treated as a PIN answer.
  reply = { status: 200, body: { eventId: "synthetic-event", accepted: true } };
  await sendAttendance(config, { ...event, pinCheck: "offline" }, { fetchImpl });
  assert.equal(bodies.at(-1).pinCheck, "offline"); assert.equal("pin" in bodies.at(-1), false);
  reply = { status: 400, body: { error: "This kiosk requires a PIN.", code: "pin_required" } };
  await assert.rejects(sendAttendance(config, event, { fetchImpl }), error => error.transient === true);
});

// ---- The real kiosk service, with a synthetic Worker ----

async function pinRuntime(t, { settings }) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-pin-runtime-")); await chmod(root, 0o700);
  const pins = new Map([["1009", serverHash("4321", 1000)], ["1011", serverHash("2468", 1000)]]);
  const world = { online: true, settings, attendance: [], failures: [] };
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
    } else if (request.url === "/kiosk/pin-failures") world.failures.push(...input.failures), data = { recorded: input.failures.length };
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
  assert.deepEqual(saved, { authenticationMethod: "member_id", memberLookup: "search", requirePin: true, pinLockout: { enabled: true, attempts: 3, minutes: 15 } });

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
  for (const name of await readdir(f.root)) if (name.startsWith("attendance-queue")) assert.equal((await readFile(join(f.root, name), "utf8").catch(() => "")).includes("2468"), false, `${name} never holds a PIN`);
  assert.equal((await readFile(join(f.root, "pin-failures.json"), "utf8")).includes("1111"), false);
  if (process.platform !== "win32") assert.equal((await stat(join(f.root, "pin-failures.json"))).mode & 0o077, 0);

  // Back online after a restart: the queued scan syncs with pinCheck "offline" and the tries are reported.
  f.world.online = true; await kiosk.stop(); kiosk = await f.start();
  await until(() => f.world.attendance.some(event => event.memberId === "1011") && f.world.failures.length > 0, "the offline scan and tries reached the server");
  const offlineScan = f.world.attendance.find(event => event.memberId === "1011");
  assert.equal(offlineScan.pinCheck, "offline"); assert.equal("pin" in offlineScan, false);
  assert.deepEqual(f.world.failures.map(item => [item.memberId, item.count]), [["1009", 3]]);

  // Turning off Require PIN and search wipes the cached hashes, the offline tries and the emails.
  f.world.settings = { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, pinLockout: { enabled: true, attempts: 3, minutes: 15 } };
  await kiosk.stop(); kiosk = await f.start();
  await until(async () => { const members = await f.cached(); return members.length === 3 && members.every(member => !("pin" in member) && !("email" in member)); }, "hashes and emails were removed");
  await assert.rejects(stat(join(f.root, "pin-failures.json")), { code: "ENOENT" });
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

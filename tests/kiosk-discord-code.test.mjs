import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMemberSettings } from "../apps/kiosk/src/member-pins.mjs";
import { discordCodeBackupLabel, discordCodeOfflineNote, identityReadyState, memberModeLabel, normalizeDiscordCode } from "../apps/kiosk/src/identity-methods.mjs";
import { sendAttendance } from "../apps/kiosk/src/cloud-client.mjs";
import { kioskApp, kioskReaderStatus } from "../apps/kiosk/src/ui.mjs";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";
import { cloudRecheckMs, createCloudRecheck, workerReachable } from "../apps/kiosk/src/cloud-recheck.mjs";
import { pollIntervals } from "../apps/kiosk/src/kiosk-poll.mjs";

// Discord codes on the Pi kiosk: a member types the six digits from /code and the kiosk sends them straight to the
// server. Synthetic data only: Test Student L (1012) and codes nobody was given.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = "Synthetic kiosk condition did not become true") { for (let n = 0; n < 200; n++) { if (await check()) return; await wait(40); } assert.fail(message); }
const lockout = { enabled: false, attempts: 5, minutes: 15 };

test("Discord code settings apply only to member ID kiosks, and an older Worker's settings read as off", () => {
  assert.deepEqual(normalizeMemberSettings({ authenticationMethod: "member_id", memberLookup: "search", requirePin: true, discordCode: true, discordCodeBackup: "always" }), { memberLookup: "search", requirePin: true, pinLockout: lockout, discordCode: true, discordCodeBackup: "always" });
  // A Worker from before Discord codes sends neither field.
  assert.deepEqual(normalizeMemberSettings({ authenticationMethod: "member_id" }), { memberLookup: "entry", requirePin: false, pinLockout: lockout, discordCode: false, discordCodeBackup: "offline" });
  assert.deepEqual(normalizeMemberSettings({ authenticationMethod: "member_id", discordCode: true }), { memberLookup: "entry", requirePin: false, pinLockout: lockout, discordCode: true, discordCodeBackup: "offline" });
  for (const method of ["fingerprint", "rfid", "nfc", "qr"]) {
    const settings = normalizeMemberSettings({ authenticationMethod: method, discordCode: true, discordCodeBackup: "always" });
    assert.deepEqual([settings.discordCode, settings.discordCodeBackup], [false, "offline"], `${method} kiosks never take Discord codes`);
  }
  for (const value of [1, "true", null, undefined]) assert.equal(normalizeMemberSettings({ authenticationMethod: "member_id", discordCode: value }).discordCode, false);
  for (const value of ["sometimes", true, null]) assert.equal(normalizeMemberSettings({ authenticationMethod: "member_id", discordCode: true, discordCodeBackup: value }).discordCodeBackup, "offline");
});

test("the start screen is the code entry while the server answers, and the backup method with a note while it does not", () => {
  const code = { message: "Enter your Discord code", detail: "Run /code in the team Discord to get one." };
  assert.deepEqual(identityReadyState("member_id", { discordCode: true, cloudOnline: true }), code);
  assert.deepEqual(identityReadyState("member_id", { discordCode: true }), code);
  assert.deepEqual(identityReadyState("member_id", { memberLookup: "entry", discordCode: true, cloudOnline: false }), { message: "Enter member ID", detail: "Use the touch keyboard below", notice: "Discord codes need a network connection. Sign in with your member ID instead." });
  assert.deepEqual(identityReadyState("member_id", { memberLookup: "search", discordCode: true, cloudOnline: false }), { message: "Find your name", detail: "Search by name, member ID or email", notice: "Discord codes need a network connection. Search for your name instead." });
  // The server answers but earlier scans wait to sync: the backup method, with a note that does not blame the network.
  assert.deepEqual(identityReadyState("member_id", { memberLookup: "entry", discordCode: true, cloudOnline: true, codesHeld: true }), { message: "Enter member ID", detail: "Use the touch keyboard below", notice: "Discord codes are paused while earlier scans sync. Sign in with your member ID instead." });
  assert.deepEqual(identityReadyState("member_id", { memberLookup: "search", discordCode: true, codesHeld: true }), { message: "Find your name", detail: "Search by name, member ID or email", notice: "Discord codes are paused while earlier scans sync. Search for your name instead." });
  assert.equal(identityReadyState("member_id", { discordCode: true, cloudOnline: false, codesHeld: true }).notice, discordCodeOfflineNote("entry"));
  assert.equal(identityReadyState("member_id", { discordCode: false, codesHeld: true }).notice, undefined);
  assert.deepEqual(identityReadyState("member_id", { memberLookup: "entry", discordCode: false, cloudOnline: false }), { message: "Enter member ID", detail: "Use the touch keyboard below" });
  assert.deepEqual(identityReadyState("fingerprint", { discordCode: true, cloudOnline: true }), { message: "Place finger on reader", detail: "Attendance kiosk ready" });
  assert.deepEqual(identityReadyState("qr", { discordCode: true }), { message: "Scan QR code", detail: "Present a registered code to the scanner" });
  assert.equal(discordCodeOfflineNote("entry"), "Discord codes need a network connection. Sign in with your member ID instead.");
  assert.equal(discordCodeBackupLabel("entry"), "No code? Use member ID"); assert.equal(discordCodeBackupLabel("search"), "No code? Search for your name");
  assert.equal(memberModeLabel({ discordCode: true }), "Discord code"); assert.equal(memberModeLabel({ discordCode: false }), "Member ID"); assert.equal(memberModeLabel(), "Member ID");
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "1.2.3", authenticationMethod: "member_id", discordCode: true }), "LancerLogin 1.2.3 · Discord code input selected");
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "1.2.3", authenticationMethod: "member_id" }), "LancerLogin 1.2.3 · Member ID input selected");
  assert.equal(kioskReaderStatus({ readerOnline: true, releaseVersion: "1.2.3", authenticationMethod: "fingerprint", discordCode: true }), "LancerLogin 1.2.3");
  assert.equal(normalizeDiscordCode("482916"), "482916"); assert.equal(normalizeDiscordCode("482 916"), "482916");
  for (const bad of ["48291", "4829167", "48291a", "", 482916, null, undefined, "4".repeat(17)]) assert.equal(normalizeDiscordCode(bad), undefined);
  // The screen's own words, as the web kiosk says them.
  for (const text of ["Enter your Discord code", "Run /code in the team Discord to get one.", "Code not recognized", "Codes work once and expire after 2 minutes. Run /code again for a new one.", "Try again", "Too many wrong codes", "No code? Use member ID", "No code? Search for your name"]) assert.ok(kioskApp.includes(text), text);
});

test("a scan sent with a Discord code carries it in place of a member ID, and code refusals come back to the screen", async () => {
  const bodies = []; let reply;
  const fetchImpl = async (url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }); };
  const config = { apiUrl: "http://127.0.0.1:9", kioskToken: "synthetic-token" };
  const event = { eventId: "synthetic-code-event", occurredAt: "2026-11-18T12:00:00.000Z", pairingId: "synthetic-pairing", discordCode: "804615" };
  reply = { status: 202, body: { eventId: "synthetic-code-event", accepted: true, action: "check_in", member: { id: "roster-1012", externalId: "1012", displayName: "Test Student L" } } };
  assert.equal((await sendAttendance(config, event, { fetchImpl })).member.displayName, "Test Student L");
  assert.equal(bodies[0].discordCode, "804615"); assert.equal("memberId" in bodies[0], false); assert.equal("pin" in bodies[0], false);
  reply = { status: 403, body: { error: "That code is wrong or has expired. Run /code in Discord for a new one.", code: "code_invalid", retryAt: "2026-11-18T12:00:30.000Z", retryAfterSeconds: 30 } };
  assert.deepEqual(await sendAttendance(config, event, { fetchImpl }), { accepted: false, duplicate: false, codeRefused: true, status: 403, code: "code_invalid", error: "That code is wrong or has expired. Run /code in Discord for a new one.", retryAt: "2026-11-18T12:00:30.000Z", retryAfterSeconds: 30 });
  reply = { status: 429, body: { error: "Too many wrong codes. Try again in 30 seconds.", code: "code_throttled", retryAt: "2026-11-18T12:00:30.000Z", retryAfterSeconds: 30 } };
  assert.deepEqual([(await sendAttendance(config, event, { fetchImpl })).code, (await sendAttendance(config, event, { fetchImpl })).codeRefused], ["code_throttled", true]);
  reply = { status: 409, body: { error: "This kiosk does not take Discord codes.", code: "code_not_enabled" } };
  assert.equal((await sendAttendance(config, event, { fetchImpl })).code, "code_not_enabled");
  reply = { status: 400, body: { error: "A Discord code is 6 digits.", code: "invalid_code" } };
  assert.equal((await sendAttendance(config, event, { fetchImpl })).code, "invalid_code");
  // A resent scan the server already recorded is a duplicate, not a refusal.
  reply = { status: 200, body: { eventId: "synthetic-code-event", accepted: false, duplicate: true, action: "check_in" } };
  assert.equal((await sendAttendance(config, event, { fetchImpl })).duplicate, true);
  // A scan without a code is never given a code answer: the same refusal stays a transient delivery failure.
  reply = { status: 403, body: { error: "Wrong", code: "code_invalid" } };
  await assert.rejects(sendAttendance(config, { ...event, discordCode: undefined, memberId: "1012" }, { fetchImpl }), error => error.transient === true);
  assert.equal(bodies.at(-1).memberId, "1012"); assert.equal("discordCode" in bodies.at(-1), false);
  // No answer worth reading is thrown, so the service can call the server unreachable.
  reply = { status: 503, body: { error: "Unavailable" } };
  await assert.rejects(sendAttendance(config, event, { fetchImpl }), error => error.transient !== true);
});

// ---- The real kiosk service, with a synthetic Worker ----

async function codeRuntime(t, { settings }) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-code-runtime-")); await chmod(root, 0o700);
  // codes: what /code gave out, by code. A code works once.
  // stuck: what happens to scans sent without a code. "refused" is an answer the kiosk does not know (the scan stays
  // queued and replay backs off); "error" is a server error (the scan stays queued and the server counts as unreachable).
  const world = { online: true, failing: false, stuck: false, throttled: false, settings, codes: new Map(), attendance: [], requests: [] };
  const roster = [{ memberId: "1012", rosterId: "roster-1012", firstName: "Test Student", lastName: "L" }, { memberId: "1013", rosterId: "roster-1013", firstName: "Test Student", lastName: "M" }];
  const cloud = createServer(async (request, response) => {
    if (!world.online) { request.socket.destroy(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    response.setHeader("content-type", "application/json");
    let status = 200, data = {};
    if (request.url?.startsWith("/kiosk/poll")) { status = 404; data = { error: "Not found" }; }
    else if (request.url === "/kiosk/config") data = { kiosk: { id: "synthetic-kiosk", name: "Synthetic code kiosk" }, settings: { organizationName: "Synthetic Club", ...world.settings } };
    else if (request.url === "/kiosk/roster") data = { members: roster };
    else if (request.url === "/kiosk/attendance") {
      world.requests.push(input);
      if (world.failing) { status = 503; data = { error: "Service unavailable" }; }
      else if (input.discordCode === undefined && world.stuck === "refused") { status = 404; data = { error: "Not found" }; }
      else if (input.discordCode === undefined && world.stuck === "error") { status = 503; data = { error: "Service unavailable" }; }
      else if (input.discordCode === undefined) { world.attendance.push(input); data = { eventId: input.eventId, accepted: true, action: "check_in" }; }
      else if (world.settings.discordCode !== true) { status = 409; data = { error: "This kiosk does not take Discord codes.", code: "code_not_enabled" }; }
      else if (world.throttled) { status = 429; data = { error: "Too many wrong codes. Try again in 1 minute.", code: "code_throttled", retryAt: new Date(Date.now() + 60_000).toISOString(), retryAfterSeconds: 60 }; }
      else if (!world.codes.has(input.discordCode)) { status = 403; data = { error: "That code is wrong or has expired. Run /code in Discord for a new one.", code: "code_invalid" }; }
      else { const member = world.codes.get(input.discordCode); world.codes.delete(input.discordCode); world.attendance.push(input); status = 202; data = { eventId: input.eventId, accepted: true, action: "check_in", member: { id: member.rosterId, externalId: member.memberId, displayName: `${member.firstName} ${member.lastName}` }, meeting: { title: "Test meeting A" } }; }
    } else if (request.url === "/kiosk/commands") data = { command: null };
    else if (request.url === "/kiosk/enrollment") data = { enrollment: null };
    response.statusCode = status; response.end(JSON.stringify(data));
  });
  await new Promise(resolve => cloud.listen(0, "127.0.0.1", resolve));
  const children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill(); await done; } cloud.closeAllConnections(); await new Promise(resolve => cloud.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const env = { ...process.env, NODE_ENV: "development", LANCERLOGIN_KIOSK_PORT: "0", LANCERLOGIN_KIOSK_HOST: "127.0.0.1", LANCERLOGIN_SENSOR_PATH: "synthetic" };
  for (const [key, name] of Object.entries({ CONFIG: "pairing.json", NETWORK_PIN: "network-pin.json", QUEUE: "attendance-queue.json", MAPPINGS: "slot-mappings.json", BRANDING: "branding.json", AUTHENTICATION: "authentication.json", CREDENTIAL_MAPPINGS: "credential-mappings.json", ROSTER_CACHE: "roster-cache.json", FINGERPRINT_SYNC: "fingerprint-sync", FINGERPRINT_VAULT: "fingerprint-vault", FINGERPRINT_RESET: "fingerprint-reset", FINGERPRINT_REVIEW: "fingerprint-review" })) env[`LANCERLOGIN_${key}`] = join(root, name);
  await writeFile(env.LANCERLOGIN_CONFIG, JSON.stringify({ apiUrl: `http://127.0.0.1:${cloud.address().port}`, kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing", kioskToken: "synthetic-token", kioskName: "Synthetic code kiosk" }), { mode: 0o600 });
  await createNetworkPinStore(env.LANCERLOGIN_NETWORK_PIN).set("123456");
  async function start() {
    const child = fork(new URL("./fixtures/kiosk-operator-runtime-child.mjs", import.meta.url), [], { env, execArgv: ["--experimental-test-module-mocks"], stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(child);
    let diagnostics = "", output = ""; child.stderr.on("data", chunk => { diagnostics += chunk; }); child.stdout.on("data", chunk => { output += chunk; });
    const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Child startup timed out: " + diagnostics)), 8000); child.on("message", message => { if (message.ready) { clearTimeout(timer); resolve(message.port); } }); child.once("exit", () => { clearTimeout(timer); reject(new Error("Child failed: " + diagnostics)); }); });
    const request = (path, input, method) => fetch(`http://127.0.0.1:${port}${path}`, { method: method ?? (input === undefined ? "GET" : "POST"), headers: { "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20000) });
    const json = async (path, input) => { const response = await request(path, input); return { status: response.status, body: await response.json() }; };
    if (!(await (await request("/health")).json()).clock.verified) {
      assert.equal((await request("/network/unlock", { pin: "123456" })).status, 200);
      await request("/maintenance/clock", { currentTime: new Date().toISOString() });
      await request("/network/session", undefined, "DELETE");
    }
    const page = await json("/operator-presence", { action: "enter", pageId: "synthetic-code-page", mode: "attendance" }); assert.equal(page.status, 200);
    return { request, json, child, logs: () => diagnostics + output };
  }
  /** Every file the kiosk keeps, as text, to prove a code never reaches the disk. */
  async function stored(directory = root) {
    let text = "";
    for (const entry of await readdir(directory, { withFileTypes: true })) text += entry.isDirectory() ? await stored(join(directory, entry.name)) : await readFile(join(directory, entry.name), "utf8").catch(() => "");
    return text;
  }
  return { root, world, start, stored };
}

test("a Discord code kiosk sends the code straight to the server and maps each answer for the screen, never queueing a code", { timeout: 90000 }, async t => {
  const f = await codeRuntime(t, { settings: { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, pinLockout: lockout, discordCode: true, discordCodeBackup: "always" } });
  const kiosk = await f.start();
  const state = async () => (await kiosk.json("/display-state")).body;
  await until(async () => { const value = await state(); return value.discordCode === true && value.cloudOnline === true; }, "the kiosk loaded Discord code mode and reached the cloud");
  const first = await state();
  assert.deepEqual([first.authenticationMethod, first.discordCode, first.discordCodeBackup, first.memberLookup, first.requirePin], ["member_id", true, "always", "entry", false]);
  assert.deepEqual([first.display.id, first.display.message, first.display.detail, first.display.notice], ["ready", "Enter your Discord code", "Run /code in the team Discord to get one.", undefined]);
  assert.deepEqual(first.backupReady, { message: "Enter member ID", detail: "Use the touch keyboard below" });
  const health = await (await kiosk.request("/health")).json();
  assert.deepEqual([health.authenticationMethod, health.discordCode, health.discordCodeBackup], ["member_id", true, "always"]);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "authentication.json"), "utf8")), { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, pinLockout: lockout, discordCode: true, discordCodeBackup: "always" });

  // Not six digits: refused here, and nothing is sent.
  for (const code of ["12345", "1234567", "12345a", 123456, undefined]) {
    const malformed = await kiosk.json("/identity/code", { code });
    assert.deepEqual([malformed.status, malformed.body.code], [400, "invalid_code"]);
  }
  assert.equal(f.world.requests.length, 0);

  // A code nobody was given.
  const wrong = await kiosk.json("/identity/code", { code: "135790" });
  assert.deepEqual([wrong.status, wrong.body.code], [403, "code_invalid"]);
  assert.equal((await state()).display.id, "ready");

  // A live code records the scan for the member it belongs to, with no member ID and no PIN.
  f.world.codes.set("804615", { memberId: "1012", rosterId: "roster-1012", firstName: "Test Student", lastName: "L" });
  const right = await kiosk.json("/identity/code", { code: "804 615" });
  assert.deepEqual([right.status, right.body], [200, { recorded: true }]);
  assert.equal(f.world.attendance.length, 1);
  const sent = f.world.attendance[0];
  assert.equal(sent.discordCode, "804615"); assert.equal("memberId" in sent, false); assert.equal("pin" in sent, false); assert.equal(sent.pairingId, "synthetic-pairing");
  const welcome = (await state()).display;
  assert.deepEqual([welcome.id, welcome.name, welcome.meetingTitle], ["welcome", "Test Student L", "Test meeting A"]);

  // The same code does not work twice.
  const reused = await kiosk.json("/identity/code", { code: "804615" });
  assert.deepEqual([reused.status, reused.body.code], [403, "code_invalid"]);
  assert.equal(f.world.attendance.length, 1);

  // Too many wrong codes: the server's wait comes back for the screen.
  f.world.throttled = true;
  const throttled = await kiosk.json("/identity/code", { code: "135790" });
  assert.deepEqual([throttled.status, throttled.body.code, throttled.body.error, throttled.body.retryAfterSeconds], [429, "code_throttled", "Too many wrong codes. Try again in 1 minute.", 60]);
  assert.ok(Date.parse(throttled.body.retryAt) > Date.now());
  f.world.throttled = false;

  // The backup method is the member lookup, unchanged.
  assert.deepEqual((await kiosk.json("/identity", { method: "member_id", memberId: "1012" })).body, { confirm: { memberId: "1012", firstName: "Test Student", lastName: "L" } });

  // A server error, then no answer at all: the kiosk reports unreachable, marks the cloud offline and shows the backup method.
  await until(async () => (await state()).display.id === "ready", "the welcome screen ended");
  f.world.codes.set("917253", { memberId: "1012", rosterId: "roster-1012", firstName: "Test Student", lastName: "L" });
  f.world.failing = true;
  const failed = await kiosk.json("/identity/code", { code: "917253" });
  assert.deepEqual([failed.status, failed.body.code], [503, "unreachable"]);
  const offline = await state();
  assert.equal(offline.cloudOnline, false);
  assert.deepEqual([offline.display.id, offline.display.message, offline.display.notice], ["ready", "Enter member ID", "Discord codes need a network connection. Sign in with your member ID instead."]);
  f.world.failing = false; f.world.online = false;
  const sentBefore = f.world.requests.length;
  const unreachable = await kiosk.json("/identity/code", { code: "917253" });
  assert.deepEqual([unreachable.status, unreachable.body.code], [503, "unreachable"]);

  // Never queued, stored, logged or sent again.
  assert.equal((await (await kiosk.request("/health")).json()).pendingEvents, 0);
  const disk = await f.stored();
  for (const code of ["917253", "804615", "135790"]) { assert.equal(disk.includes(code), false, "no code is written to disk"); assert.equal(kiosk.logs().includes(code), false, "no code is logged"); }
  f.world.online = true;
  await wait(1500);
  assert.equal(f.world.requests.length, sentBefore, "a code scan is not retried in the background");
  assert.equal(f.world.attendance.length, 1);
  assert.ok(f.world.codes.has("917253"), "the unanswered code was never used");

  // A code that reaches the server again marks the cloud reachable, and the start screen is the code entry again.
  const again = await kiosk.json("/identity/code", { code: "917253" });
  assert.deepEqual([again.status, again.body], [200, { recorded: true }]);
  assert.equal((await state()).cloudOnline, true);
  await until(async () => (await state()).display.id === "ready", "the welcome screen ended");
  assert.equal((await state()).display.message, "Enter your Discord code");

  // Discord codes turned off on the dashboard since the last poll: the kiosk loads the new settings before answering.
  f.world.settings = { ...f.world.settings, discordCode: false };
  const disabled = await kiosk.json("/identity/code", { code: "135790" });
  assert.deepEqual([disabled.status, disabled.body.code], [409, "code_not_enabled"]);
  const after = await state();
  assert.deepEqual([after.discordCode, after.display.message, after.display.notice, after.backupReady], [false, "Enter member ID", undefined, undefined]);
  assert.equal(JSON.parse(await readFile(join(f.root, "authentication.json"), "utf8")).discordCode, false);
  // With the mode off the kiosk refuses a code itself.
  const before = f.world.requests.length;
  const refused = await kiosk.json("/identity/code", { code: "135790" });
  assert.deepEqual([refused.status, refused.body.code], [409, "code_not_enabled"]);
  assert.equal(f.world.requests.length, before);
});

test("a fingerprint kiosk ignores Discord code settings", { timeout: 30000 }, async t => {
  const f = await codeRuntime(t, { settings: { authenticationMethod: "fingerprint", discordCode: true, discordCodeBackup: "always" } });
  const kiosk = await f.start();
  await until(async () => (await kiosk.json("/display-state")).body.cloudOnline === true, "the kiosk reached the cloud");
  const value = (await kiosk.json("/display-state")).body;
  assert.deepEqual([value.authenticationMethod, value.discordCode, value.discordCodeBackup, value.backupReady], ["fingerprint", false, "offline", undefined]);
  const refused = await kiosk.json("/identity/code", { code: "135790" });
  assert.deepEqual([refused.status, refused.body.code], [409, "code_not_enabled"]);
  assert.equal(f.world.requests.length, 0);
});

// ---- Scans waiting in the queue at a Discord code kiosk ----
const codeSettings = { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, pinLockout: lockout, discordCode: true, discordCodeBackup: "always" };
const studentL = { memberId: "1012", rosterId: "roster-1012", firstName: "Test Student", lastName: "L" };
const sentWith = world => world.requests.map(input => input.discordCode === undefined ? input.memberId : "code");

test("a backup scan stuck behind a refusal leaves the code entry up, and a code waits for it instead of jumping the queue", { timeout: 120000 }, async t => {
  const f = await codeRuntime(t, { settings: codeSettings });
  const kiosk = await f.start();
  const state = async () => (await kiosk.json("/display-state")).body;
  await until(async () => { const value = await state(); return value.discordCode === true && value.cloudOnline === true; }, "the kiosk loaded Discord code mode and reached the cloud");

  // The server answers the backup scan with a refusal the kiosk does not know, so the scan stays queued.
  f.world.stuck = "refused";
  const stuckAt = Date.now();
  assert.equal((await kiosk.json("/identity", { method: "member_id", memberId: "1012", confirmed: true })).status, 202);
  await until(async () => (await state()).display.detail === "Saved for sync | Welcome", "the backup scan was saved on the kiosk");
  // The server did answer: the kiosk is still online, and the start screen is still the code entry.
  assert.equal((await state()).cloudOnline, true);
  await until(async () => (await state()).display.id === "ready", "the saved-scan screen ended");
  const waiting = await state();
  assert.deepEqual([waiting.cloudOnline, waiting.pendingEvents, waiting.display.message, waiting.display.notice], [true, 1, "Enter your Discord code", undefined]);

  // A live code is not sent while the earlier scan waits: it would reach the server first.
  f.world.codes.set("246813", studentL);
  const held = await kiosk.json("/identity/code", { code: "246813" });
  assert.deepEqual([held.status, held.body], [503, { error: "Earlier scans are still waiting to sync, so your code was not used.", code: "scans_waiting" }]);
  assert.deepEqual(sentWith(f.world), ["1012"], "the code never left the kiosk");
  assert.ok(f.world.codes.has("246813"), "the code is still unused");
  // The kiosk is online, and the start screen is the backup method with a note that says why.
  const paused = await state();
  assert.deepEqual([paused.cloudOnline, paused.discordCodeHeld, paused.display.id, paused.display.message, paused.display.notice], [true, true, "ready", "Enter member ID", "Discord codes are paused while earlier scans sync. Sign in with your member ID instead."]);
  assert.deepEqual(sentWith(f.world), ["1012"]);

  // The server takes scans again. Once the retry delay ends, the next backup scan empties the queue in order and the code entry returns.
  f.world.stuck = false;
  await wait(Math.max(0, stuckAt + 31_000 - Date.now()));
  // The attendance page's 15-second lease ran out during the wait, as it would with the screen closed.
  assert.equal((await kiosk.json("/operator-presence", { action: "enter", pageId: "synthetic-code-page-2", mode: "attendance" })).status, 200);
  assert.equal((await kiosk.json("/identity", { method: "member_id", memberId: "1013", confirmed: true })).status, 202);
  await until(async () => f.world.attendance.length === 2, "both waiting scans reached the server");
  assert.deepEqual(f.world.attendance.map(input => input.memberId), ["1012", "1013"]);
  await until(async () => { const value = await state(); return value.display.id === "ready" && value.discordCodeHeld === false; }, "codes are taken again");
  assert.deepEqual([(await state()).display.message, (await state()).display.notice], ["Enter your Discord code", undefined]);
  const recorded = await kiosk.json("/identity/code", { code: "246813" });
  assert.deepEqual([recorded.status, recorded.body], [200, { recorded: true }]);
  assert.deepEqual(f.world.attendance.map(input => input.discordCode === undefined ? input.memberId : "code"), ["1012", "1013", "code"]);
  const disk = await f.stored();
  assert.equal(disk.includes("246813"), false, "no code is written to disk"); assert.equal(kiosk.logs().includes("246813"), false, "no code is logged");
});

test("a code is not sent past a scan the server could not take, and goes after it once the server answers", { timeout: 60000 }, async t => {
  const f = await codeRuntime(t, { settings: codeSettings });
  const kiosk = await f.start();
  const state = async () => (await kiosk.json("/display-state")).body;
  await until(async () => { const value = await state(); return value.discordCode === true && value.cloudOnline === true; }, "the kiosk loaded Discord code mode and reached the cloud");

  // A server error for the backup scan: it stays queued, and this time the server really is unreachable.
  f.world.stuck = "error";
  assert.equal((await kiosk.json("/identity", { method: "member_id", memberId: "1012", confirmed: true })).status, 202);
  await until(async () => (await state()).display.detail === "Saved for sync | Welcome", "the backup scan was saved on the kiosk");
  await until(async () => (await state()).display.id === "ready", "the saved-scan screen ended");
  const offline = await state();
  assert.deepEqual([offline.cloudOnline, offline.discordCodeHeld, offline.display.message, offline.display.notice], [false, false, "Enter member ID", "Discord codes need a network connection. Sign in with your member ID instead."]);

  // The synthetic server would take a code, but the earlier scan has not been delivered, so the code is not sent.
  f.world.codes.set("571390", studentL);
  const refused = await kiosk.json("/identity/code", { code: "571390" });
  assert.deepEqual([refused.status, refused.body.code], [503, "unreachable"]);
  assert.equal(sentWith(f.world).includes("code"), false, "the code never left the kiosk");
  assert.ok(f.world.codes.has("571390"), "the code is still unused");
  assert.equal((await state()).cloudOnline, false);

  // The server answers again: the waiting scan goes first, then the code.
  f.world.stuck = false;
  const recorded = await kiosk.json("/identity/code", { code: "571390" });
  assert.deepEqual([recorded.status, recorded.body], [200, { recorded: true }]);
  assert.deepEqual(f.world.attendance.map(input => input.discordCode === undefined ? input.memberId : "code"), ["1012", "code"]);
  assert.equal((await state()).cloudOnline, true);
});

// ---- The check between heartbeats on an offline Discord code kiosk ----

test("an offline Discord code kiosk only asks whether the server answers between heartbeats, and runs the heartbeat once when it does", async () => {
  assert.equal(cloudRecheckMs, 15_000); assert.equal(pollIntervals.heartbeatMs, 60_000);
  let offline = true, answers = false, checks = 0, heartbeats = 0, heartbeatWorks = true;
  const recheck = createCloudRecheck({ wanted: () => offline, reachable: async () => { checks++; return answers; }, heartbeat: async () => { heartbeats++; if (heartbeatWorks) offline = false; } });
  // Offline for an hour: 240 light checks and no heartbeat from this timer.
  for (let n = 0; n < 240; n++) await recheck.tick();
  assert.deepEqual([checks, heartbeats], [240, 0]);
  // The server answers: the heartbeat runs straight away, and the kiosk is online again.
  answers = true; await recheck.tick();
  assert.deepEqual([checks, heartbeats, offline], [241, 1, false]);
  // Online: nothing is asked.
  for (let n = 0; n < 4; n++) await recheck.tick();
  assert.deepEqual([checks, heartbeats], [241, 1]);
  // Lost again while the server already answers the check: one heartbeat, at the first tick.
  offline = true; heartbeatWorks = false;
  for (let n = 0; n < 8; n++) await recheck.tick();
  // The check keeps answering but the heartbeat keeps failing: it is not repeated every tick.
  assert.deepEqual([checks, heartbeats], [249, 2]);
  // Lost and found again: one more.
  answers = false; await recheck.tick(); answers = true; await recheck.tick(); await recheck.tick();
  assert.deepEqual([checks, heartbeats], [252, 3]);

  // A check that throws is no answer, and a slow check is not started twice.
  let release; const slow = createCloudRecheck({ wanted: () => true, reachable: () => { checks++; return new Promise((resolve, reject) => { release = { resolve, reject }; }); }, heartbeat: async () => { heartbeats++; } });
  const first = slow.tick(); await slow.tick(); await slow.tick();
  assert.equal(checks, 253);
  release.reject(new Error("synthetic network failure")); await first;
  assert.equal(heartbeats, 3);
  const second = slow.tick(); release.resolve(true); await second;
  assert.deepEqual([checks, heartbeats], [254, 4]);
});

test("the reachability check is one unauthenticated request for the Worker's health, and only the Worker counts", async () => {
  const calls = []; let reply;
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return reply(); };
  const config = { apiUrl: "http://127.0.0.1:9", kioskToken: "synthetic-token" };
  const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  reply = json(200, { ok: true, service: "lancerlogin-api" });
  assert.equal(await workerReachable(config, { fetchImpl }), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "http://127.0.0.1:9/health");
  assert.equal(calls[0].options?.method ?? "GET", "GET"); assert.equal(calls[0].options?.body, undefined);
  assert.equal(JSON.stringify(calls[0]).includes("synthetic-token"), false, "the kiosk credential is not sent");
  // A captive portal page, another service, a server error and no answer are all "not reachable".
  reply = () => new Response("<html>Sign in to Wi-Fi</html>", { status: 200, headers: { "content-type": "text/html" } });
  assert.equal(await workerReachable(config, { fetchImpl }), false);
  reply = json(200, { ok: true, service: "something-else" }); assert.equal(await workerReachable(config, { fetchImpl }), false);
  reply = json(503, { ok: true, service: "lancerlogin-api" }); assert.equal(await workerReachable(config, { fetchImpl }), false);
  reply = () => { throw new TypeError("fetch failed"); }; assert.equal(await workerReachable(config, { fetchImpl }), false);
});

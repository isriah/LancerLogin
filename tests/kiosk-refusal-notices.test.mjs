import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kioskDisplayForRefusal, kioskStates as presentationStates, scanRefusalFrom } from "../apps/kiosk/src/kiosk-presentation.mjs";
import { kioskStates as deviceStates } from "../apps/kiosk/src/kiosk-states.mjs";
import { sendAttendance } from "../apps/kiosk/src/cloud-client.mjs";
import { createScanner } from "../apps/kiosk/src/scanner.mjs";
import { kioskStatusStyles, kioskStyles } from "../apps/kiosk/src/ui.mjs";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";

// What the Pi kiosk shows when the Worker refuses a scan that has nothing wrong with it: the reason as a headline, in
// the notice colour, for five seconds. A Worker that sends no reason keeps "Scan needs help". Synthetic data only.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = "Synthetic kiosk condition did not become true") { for (let n = 0; n < 200; n++) { if (await check()) return; await wait(40); } assert.fail(message); }

const noMeeting = { error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting" };
// Each refusal body as the Worker sends it, and the screen it leads to.
const refusals = [
  [{ ...noMeeting, reason: "too_early", meetingTitle: "Test meeting A", at: "2026-11-18T22:45:00.000Z", time: "5:45 PM" }, "Too early", "Test meeting A opens for scans at 5:45 PM"],
  [{ ...noMeeting, reason: "meeting_ended", meetingTitle: "Test meeting A", at: "2026-11-19T01:30:00.000Z", time: "8:30 PM" }, "Meeting ended", "Scans for Test meeting A closed at 8:30 PM"],
  [{ ...noMeeting, reason: "no_meeting_today" }, "No meeting today", "Nothing to scan in for right now"],
  [{ error: "Attendance is already complete for this member and meeting", code: "attendance_complete", reason: "already_done" }, "Already done", "You've already checked in and out of this meeting"],
  [{ error: "Attendance for Test Student begins on 2026-12-01", code: "participation_not_started", reason: "not_started_yet", startsOn: "2026-12-01", date: "Dec 1, 2026" }, "Not started yet", "Your attendance begins on Dec 1, 2026"],
];
const reply = (body, status = 409) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("each refusal reason has its headline and second line, in the notice tone for five seconds", () => {
  assert.deepEqual(presentationStates.scan_notice, { message: "No meeting today", detail: "Nothing to scan in for right now", tone: "notice", durationMs: 5000 });
  for (const [body, message, detail] of refusals) {
    const display = kioskDisplayForRefusal(scanRefusalFrom(body));
    assert.deepEqual([display.id, display.message, display.detail, display.tone, display.durationMs], ["scan_notice", message, detail, "notice", 5000], body.reason);
  }
  // Genuine scan problems keep their red screens and their durations.
  assert.deepEqual(presentationStates.rejected, { message: "Scan needs help", detail: "Ask an operator for help", tone: "error", durationMs: 2800 });
  assert.deepEqual(presentationStates.unknown, { message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help", tone: "error", durationMs: 2600 });
  // The reader's light matches "Scan again", the kiosk's other notice, not the red of a failed scan.
  assert.deepEqual(deviceStates.scan_notice.led, deviceStates.rescan.led);
  assert.notDeepEqual(deviceStates.scan_notice.led, deviceStates.rejected.led);
  // The screen frames the notice in a fixed amber, whatever the team's branding colours are, and never flashes it as a failure.
  assert.match(kioskStyles, /--scan-notice-color:#f2c14e;/);
  assert.match(kioskStatusStyles, /\.kiosk-shell-scan_notice\{box-shadow:inset 0 0 0 12px var\(--scan-notice-color\)\}/);
  assert.match(kioskStatusStyles, /\.scan-panel-scan_notice \.reader-mark\{border-color:var\(--scan-notice-color\)/);
});

test("a refusal without a known, complete reason has no notice screen", () => {
  for (const body of [undefined, null, "too_early", {}, noMeeting, { ...noMeeting, reason: "something_new" }, { ...noMeeting, reason: 5 },
    { ...noMeeting, reason: "too_early" }, { ...noMeeting, reason: "too_early", meetingTitle: "Test meeting A" }, { ...noMeeting, reason: "meeting_ended", time: "8:30 PM" },
    { ...noMeeting, reason: "too_early", meetingTitle: "  ", time: "5:45 PM" }, { reason: "not_started_yet" }, { reason: "not_started_yet", date: 20261201 }]) {
    assert.equal(scanRefusalFrom(body), undefined, JSON.stringify(body));
  }
  assert.equal(kioskDisplayForRefusal(undefined), undefined);
  assert.equal(kioskDisplayForRefusal({ reason: "something_new" }), undefined);
  // Only what the wording needs is kept, and a runaway title is cut.
  assert.deepEqual(scanRefusalFrom({ ...refusals[0][0], extra: "ignored" }), { reason: "too_early", meetingTitle: "Test meeting A", time: "5:45 PM" });
  assert.equal(scanRefusalFrom({ reason: "too_early", meetingTitle: "T".repeat(500), time: "5:45 PM" }).meetingTitle.length, 120);
});

test("the attendance client passes the Worker's reason on, and an older Worker's refusal reads as before", async () => {
  const config = { apiUrl: "https://api.example.test", kioskToken: "secret" }; const event = { eventId: "event-1", memberId: "1001", occurredAt: "2026-11-18T20:00:00Z" };
  const early = await sendAttendance(config, event, { fetchImpl: async () => reply(refusals[0][0]) });
  assert.deepEqual(early, { accepted: false, rejected: true, status: 409, code: "no_eligible_meeting", error: noMeeting.error, refusal: { reason: "too_early", meetingTitle: "Test meeting A", time: "5:45 PM" } });
  const done = await sendAttendance(config, event, { fetchImpl: async () => reply(refusals[3][0]) });
  assert.deepEqual(done, { accepted: false, rejected: true, status: 409, code: "attendance_complete", error: "Attendance is already complete for this member and meeting", refusal: { reason: "already_done" } });
  // Older Workers: a code without a reason, and before codes, the message alone.
  assert.deepEqual(await sendAttendance(config, event, { fetchImpl: async () => reply(noMeeting) }), { accepted: false, rejected: true, status: 409, code: "no_eligible_meeting", error: noMeeting.error });
  assert.deepEqual(await sendAttendance(config, event, { fetchImpl: async () => reply({ error: noMeeting.error }) }), { accepted: false, rejected: true, status: 409, code: "no_eligible_meeting", error: noMeeting.error });
  // A reason never turns an answer the kiosk does not know into a settled scan.
  await assert.rejects(sendAttendance(config, event, { fetchImpl: async () => reply({ error: "Something new", code: "something_new", reason: "no_meeting_today" }) }), error => error.transient === true);
});

test("the scanner shows the reason for a refused scan, and the generic screen when the Worker gives none", async () => {
  async function displaysFor(acknowledgement) {
    const displays = [], leds = [];
    const scanner = createScanner({
      scanSensor: async () => ({ status: "match", slot: 12 }), setLed: async id => { leds.push(id); }, mappings: { memberForSlot: async () => "1001" },
      queue: { pending: async () => [], enqueue: async () => true }, loadPairing: async () => ({ kioskToken: "secret" }),
      flushAttendance: async () => ({ acknowledgements: [{ eventId: "scan-1", ...acknowledgement }] }),
      onDisplay: async (state, values) => displays.push({ state, ...values }), onReader: () => undefined, onCloud: () => undefined,
      now: () => Date.parse("2026-11-18T20:00:00.000Z"), delay: async () => undefined, eventId: () => "scan-1",
    });
    await scanner.tick();
    return { displays, leds };
  }
  for (const [body, message, detail] of refusals) {
    const { displays, leds } = await displaysFor({ rejected: true, status: 409, code: body.code, error: body.error, refusal: scanRefusalFrom(body) });
    assert.deepEqual(displays, [{ state: "processing" }, { state: "scan_notice", message, detail }], body.reason);
    assert.deepEqual(leds, ["processing", "scan_notice"]);
  }
  const generic = await displaysFor({ rejected: true, status: 409, code: "no_eligible_meeting", error: noMeeting.error });
  assert.deepEqual(generic.displays, [{ state: "processing" }, { state: "rejected", detail: noMeeting.error }]);
  assert.deepEqual(generic.leds, ["processing", "rejected"]);
  // The clock check refuses a scan on the kiosk itself: still a scan that needs help.
  const clock = await displaysFor({ rejected: true, code: "clock_unverified", error: "Scan time could not be verified. Ask an operator to review attendance." });
  assert.deepEqual(clock.displays.at(-1), { state: "rejected", detail: "Scan time could not be verified. Ask an operator to review attendance." });
});

// A running kiosk service with a synthetic Worker whose answer to every scan is `world.answer`.
async function runtime(t) {
  const root = await mkdtemp(join(tmpdir(), "kiosk-refusal-runtime-")); await chmod(root, 0o700);
  const world = { answer: { status: 409, body: noMeeting }, requests: [] };
  const lockout = { enabled: false, attempts: 5, minutes: 15 };
  const cloud = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    response.setHeader("content-type", "application/json");
    let status = 200, data = {};
    if (request.url?.startsWith("/kiosk/poll")) { status = 404; data = { error: "Not found" }; }
    else if (request.url === "/kiosk/config") data = { kiosk: { id: "synthetic-kiosk", name: "Synthetic refusal kiosk" }, settings: { organizationName: "Synthetic Club", authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, pinLockout: lockout, discordCode: true, discordCodeBackup: "always" } };
    else if (request.url === "/kiosk/roster") data = { members: [{ memberId: "1001", rosterId: "roster-1001", firstName: "Test Student", lastName: "A" }] };
    else if (request.url === "/kiosk/attendance") { world.requests.push(input); status = world.answer.status; data = world.answer.body; }
    else if (request.url === "/kiosk/commands") data = { command: null };
    else if (request.url === "/kiosk/enrollment") data = { enrollment: null };
    response.statusCode = status; response.end(JSON.stringify(data));
  });
  await new Promise(resolve => cloud.listen(0, "127.0.0.1", resolve));
  let child;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill(); await done; } cloud.closeAllConnections(); await new Promise(resolve => cloud.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const env = { ...process.env, NODE_ENV: "development", LANCERLOGIN_KIOSK_PORT: "0", LANCERLOGIN_KIOSK_HOST: "127.0.0.1", LANCERLOGIN_SENSOR_PATH: "synthetic" };
  for (const [key, name] of Object.entries({ CONFIG: "pairing.json", NETWORK_PIN: "network-pin.json", QUEUE: "attendance-queue.json", MAPPINGS: "slot-mappings.json", BRANDING: "branding.json", AUTHENTICATION: "authentication.json", CREDENTIAL_MAPPINGS: "credential-mappings.json", ROSTER_CACHE: "roster-cache.json", FINGERPRINT_SYNC: "fingerprint-sync", FINGERPRINT_VAULT: "fingerprint-vault", FINGERPRINT_RESET: "fingerprint-reset", FINGERPRINT_REVIEW: "fingerprint-review" })) env[`LANCERLOGIN_${key}`] = join(root, name);
  await writeFile(env.LANCERLOGIN_CONFIG, JSON.stringify({ apiUrl: `http://127.0.0.1:${cloud.address().port}`, kioskId: "synthetic-kiosk", pairingId: "synthetic-pairing", kioskToken: "synthetic-token", kioskName: "Synthetic refusal kiosk" }), { mode: 0o600 });
  await createNetworkPinStore(env.LANCERLOGIN_NETWORK_PIN).set("123456");
  child = fork(new URL("./fixtures/kiosk-operator-runtime-child.mjs", import.meta.url), [], { env, execArgv: ["--experimental-test-module-mocks"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let diagnostics = ""; child.stderr.on("data", chunk => { diagnostics += chunk; });
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Child startup timed out: " + diagnostics)), 8000); child.on("message", message => { if (message.ready) { clearTimeout(timer); resolve(message.port); } }); child.once("exit", () => { clearTimeout(timer); reject(new Error("Child failed: " + diagnostics)); }); });
  const request = (path, input, method) => fetch(`http://127.0.0.1:${port}${path}`, { method: method ?? (input === undefined ? "GET" : "POST"), headers: { "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20000) });
  const json = async (path, input) => { const response = await request(path, input); return { status: response.status, body: await response.json() }; };
  if (!(await (await request("/health")).json()).clock.verified) {
    assert.equal((await request("/network/unlock", { pin: "123456" })).status, 200);
    await request("/maintenance/clock", { currentTime: new Date().toISOString() });
    await request("/network/session", undefined, "DELETE");
  }
  assert.equal((await json("/operator-presence", { action: "enter", pageId: "synthetic-refusal-page", mode: "attendance" })).status, 200);
  const state = async () => (await json("/display-state")).body;
  await until(async () => { const value = await state(); return value.discordCode === true && value.cloudOnline === true; }, "the kiosk loaded its settings and reached the cloud");
  return { world, json, state };
}

test("the kiosk service keeps a refusal notice up for five seconds, and an older Worker's refusal on the generic screen for 2.8", { timeout: 90000 }, async t => {
  const kiosk = await runtime(t);
  const shown = async () => { const { display } = await kiosk.state(); return [display.id, display.message, display.detail, display.tone, display.durationMs]; };
  const idle = () => until(async () => (await kiosk.state()).display.id === "ready", "the result screen ended");

  for (const [body, message, detail] of refusals) {
    kiosk.world.answer = { status: 409, body };
    const answer = await kiosk.json("/identity/code", { code: "804615" });
    assert.deepEqual([answer.status, answer.body], [200, { recorded: false, rejected: true }], body.reason);
    assert.deepEqual(await shown(), ["scan_notice", message, detail, "notice", 5000], body.reason);
    // Another scan can take the screen over at once, as with any result.
  }
  // The last notice is still up after four seconds and gone soon after five.
  const shownAt = Date.now();
  await wait(4000);
  assert.equal((await kiosk.state()).display.id, "scan_notice", "still showing after 4 seconds");
  await idle();
  assert.ok(Date.now() - shownAt >= 4900 && Date.now() - shownAt < 7000, `the notice lasted ${Date.now() - shownAt} ms`);

  // An older Worker sends no reason: the generic screen, with the server's text, for its usual 2.8 seconds.
  kiosk.world.answer = { status: 409, body: noMeeting };
  const older = await kiosk.json("/identity/code", { code: "804615" });
  assert.deepEqual([older.status, older.body], [200, { recorded: false, rejected: true }]);
  assert.deepEqual(await shown(), ["rejected", "Scan needs help", noMeeting.error, "error", 2800]);
  const genericAt = Date.now();
  await idle();
  assert.ok(Date.now() - genericAt < 4000, `the generic screen lasted ${Date.now() - genericAt} ms`);
  assert.equal((await kiosk.json("/health")).body.pendingEvents, 0, "refused scans are never queued");
});

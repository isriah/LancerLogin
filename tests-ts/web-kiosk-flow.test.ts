import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  backupButtonLabel, codeFlow, codeIdleSteps, codeOutcomeFor, commandActionFor, credentialRejected, discordCodeBackupFor, discordCodeFor, displayForAttendance, displayForAttendanceError, displayForCodeScan,
  entryInputFor, flowReducer, idleModeFor, initialFlow, kioskBrandStyle, maintenanceIdleTimeoutMs, maintenanceReturnFor, maintenanceReturnLabel, memberLookupFor, offlineCodeNote,
  pairingCodeCharacters, pairingCodeFromHash, pairingCodeProblem, pairingErrorMessage, physicalKeyFor, rosterChanged, settingsPinProblem, wrongPairingCodeMessage, type Flow, type FlowAction, type IdleMode,
} from "../apps/dashboard/src/web-kiosk/kiosk-flow.ts";
import { KioskApiError, KioskNetworkError, createKioskApi, credentialRevoked, deliverScan, pairWebKiosk, revokedCredentialMessage, type DiscordCodeScan, type KioskConfig, type KioskSettings } from "../apps/dashboard/src/web-kiosk/kiosk-api.ts";
import { createMemoryStore, usablePairing, usableQueuedScan } from "../apps/dashboard/src/web-kiosk/kiosk-store.ts";
import { isWebKioskPath } from "../apps/dashboard/src/web-kiosk/route.ts";

const roster = [
  { memberId: "1024", firstName: "Test", lastName: "Student A", email: "student.a@example.test" },
  { memberId: "1025", firstName: "Test", lastName: "Student B", email: "student.b@example.test" },
];

test("the pairing code comes from a #code= fragment, normalized", () => {
  assert.equal(pairingCodeFromHash("#code=K7Q2M9XD"), "K7Q2M9XD");
  assert.equal(pairingCodeFromHash("#code=k7q2-m9xd"), "K7Q2M9XD");
  assert.equal(pairingCodeFromHash(""), undefined);
  assert.equal(pairingCodeFromHash("#other=1"), undefined);
  assert.equal(pairingCodeProblem("k7q2m9xd"), undefined);
  assert.equal(pairingCodeProblem("K7Q2-M9XD"), undefined);
  assert.equal(pairingCodeProblem("K7Q2-M9X0"), wrongPairingCodeMessage);
  assert.match(pairingCodeProblem("") ?? "", /8-character code/);
});

test("pairing code characters leave out 0, O, 1 and I", () => {
  assert.equal(pairingCodeCharacters("k7q2-m9xd"), "K7Q2M9XD");
  assert.equal(pairingCodeCharacters("O0I1 K7Q2"), "K7Q2");
  assert.equal(pairingCodeCharacters(""), "");
});

test("physical keys map to kiosk actions for each kind of field", () => {
  for (const charset of ["digits", "pairing", "text"] as const) {
    assert.deepEqual(physicalKeyFor({ key: "Backspace" }, charset), { type: "backspace" });
    assert.deepEqual(physicalKeyFor({ key: "Enter" }, charset), { type: "enter" });
    assert.deepEqual(physicalKeyFor({ key: "Escape" }, charset), { type: "escape" });
    for (const key of ["Tab", "ArrowLeft", "Shift", "F5", "Dead", "Delete"]) assert.equal(physicalKeyFor({ key }, charset), undefined, key);
    // Shortcuts belong to the browser, not the field.
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) {
      assert.equal(physicalKeyFor({ key: "7", [modifier]: true }, charset), undefined);
      assert.equal(physicalKeyFor({ key: "Enter", [modifier]: true }, charset), undefined);
    }
    assert.equal(physicalKeyFor({ key: "7", isComposing: true }, charset), undefined);
  }
  // PINs and numeric member IDs take digits only.
  assert.deepEqual(physicalKeyFor({ key: "7" }, "digits"), { type: "character", character: "7" });
  for (const key of ["a", "A", " ", "-", "."]) assert.equal(physicalKeyFor({ key }, "digits"), undefined, key);
  // Pairing codes take only the characters a code can contain, uppercase.
  assert.deepEqual(physicalKeyFor({ key: "k" }, "pairing"), { type: "character", character: "K" });
  assert.deepEqual(physicalKeyFor({ key: "7" }, "pairing"), { type: "character", character: "7" });
  for (const key of ["0", "o", "O", "1", "i", "I", "-", " "]) assert.equal(physicalKeyFor({ key }, "pairing"), undefined, key);
  // Text fields take letters, digits, spaces and symbols as typed.
  for (const key of ["a", "Z", "0", " ", "@", ".", "-", "é"]) assert.deepEqual(physicalKeyFor({ key }, "text"), { type: "character", character: key });
});

test("pairing failures explain what to do", () => {
  assert.equal(pairingErrorMessage(new KioskApiError("Pairing code is invalid or expired", 401)), wrongPairingCodeMessage);
  assert.equal(pairingErrorMessage(new KioskApiError("Already used", 409)), wrongPairingCodeMessage);
  assert.match(pairingErrorMessage(new KioskApiError("Too many", 429)), /Too many tries/);
  assert.match(pairingErrorMessage(new KioskNetworkError()), /Couldn't reach the server/);
});

test("the settings PIN is 6 to 12 digits, typed the same twice", () => {
  assert.equal(settingsPinProblem("123456", "123456"), undefined);
  assert.equal(settingsPinProblem("123456789012", "123456789012"), undefined);
  assert.match(settingsPinProblem("12345", "12345") ?? "", /6 to 12 digits/);
  assert.match(settingsPinProblem("1234567890123", "1234567890123") ?? "", /6 to 12 digits/);
  assert.match(settingsPinProblem("123456", "654321") ?? "", /don't match/);
});

test("numeric rosters get the keypad, others the keyboard; the lookup comes from the config", () => {
  assert.equal(entryInputFor(roster), "keypad");
  assert.equal(entryInputFor([...roster, { memberId: "T-7", firstName: "Test", lastName: "Student C" }]), "keyboard");
  assert.equal(entryInputFor([]), "keyboard");
  const config = (memberLookup?: "entry" | "search"): KioskConfig => ({ kiosk: { id: "k1", name: "Test kiosk" }, settings: { authenticationMethod: "member_id", memberLookup } });
  assert.equal(memberLookupFor(undefined), "entry");
  assert.equal(memberLookupFor(config("search")), "search");
  assert.equal(memberLookupFor(config()), "entry");
  assert.equal(rosterChanged(config("entry"), config("search")), true);
  assert.equal(rosterChanged(config("entry"), config("entry")), false);
});

test("member ID entry goes to confirm, then sending, then the result and back to the start", () => {
  let flow: Flow = initialFlow;
  for (const key of "1024") flow = flowReducer(flow, { type: "key", key });
  assert.deepEqual(flow, { step: "entry", text: "1024" });
  flow = flowReducer(flow, { type: "submit", roster });
  assert.deepEqual(flow, { step: "confirm", member: { memberId: "1024", firstName: "Test", lastName: "Student A" }, back: "" });
  assert.equal("email" in (flow.step === "confirm" ? flow.member : {}), false);
  assert.equal(flowReducer(flow, { type: "key", key: "9" }), flow, "typing is ignored on the confirm screen");
  flow = flowReducer(flow, { type: "confirm" });
  assert.equal(flow.step, "sending");
  assert.equal(flowReducer(flow, { type: "confirm" }), flow, "a second tap doesn't send again");
  flow = flowReducer(flow, { type: "sent", display: displayForAttendance({ action: "check_in", meeting: { id: "m1", title: "Test Build Night" }, member: { id: "r1", displayName: "Test Student A" } }) });
  assert.equal(flow.step, "result");
  if (flow.step === "result") { assert.equal(flow.display.id, "welcome"); assert.equal(flow.display.name, "Test Student A"); assert.equal(flow.display.meetingTitle, "Test Build Night"); }
  assert.deepEqual(flowReducer(flow, { type: "done" }), initialFlow);
});

test("Not me and the 15-second timeout go back; unknown IDs show Member ID not recognized", () => {
  const confirm = flowReducer({ step: "entry", text: " 1025 " }, { type: "submit", roster });
  assert.equal(confirm.step, "confirm");
  assert.deepEqual(flowReducer(confirm, { type: "not_me" }), { step: "entry", text: "" });
  assert.deepEqual(flowReducer(confirm, { type: "timeout" }), initialFlow);
  const unknown = flowReducer({ step: "entry", text: "9999" }, { type: "submit", roster });
  assert.equal(unknown.step, "result");
  if (unknown.step === "result") { assert.equal(unknown.display.message, "Member ID not recognized"); assert.equal(unknown.display.tone, "error"); assert.ok(unknown.display.durationMs); }
  assert.equal(flowReducer(initialFlow, { type: "submit", roster }), initialFlow, "an empty entry does nothing");
  assert.deepEqual(flowReducer({ step: "entry", text: "102" }, { type: "backspace" }), { step: "entry", text: "10" });
  assert.deepEqual(flowReducer({ step: "entry", text: "102" }, { type: "clear" }), initialFlow);
  assert.deepEqual(flowReducer(initialFlow, { type: "set", text: "x".repeat(100) }), { step: "entry", text: "x".repeat(40) });
});

test("member search picks a result and Back to search keeps the query", () => {
  const flow = flowReducer({ step: "entry", text: "test st" }, { type: "pick", member: { memberId: "1024", firstName: "Test", lastName: "Student A" } });
  assert.deepEqual(flow, { step: "confirm", member: { memberId: "1024", firstName: "Test", lastName: "Student A" }, back: "test st" });
  assert.deepEqual(flowReducer(flow, { type: "not_me" }), { step: "entry", text: "test st" });
});

test("attendance answers map to the Pi kiosk's result states", () => {
  assert.equal(displayForAttendance({ action: "check_out" }).id, "goodbye");
  assert.equal(displayForAttendance({ duplicate: true, action: "check_in" }).id, "duplicate");
  assert.equal(displayForAttendance({ action: "check_in" }, { memberId: "1024", firstName: "Test", lastName: "Student A" }).name, "Test Student A");
  const offline = displayForAttendanceError(new KioskNetworkError());
  assert.equal(`${offline.message}. ${offline.detail}`, "Couldn't reach the server. Try again.");
  assert.equal(offline.tone, "error");
  assert.equal(displayForAttendanceError(new KioskApiError("No meeting is accepting attendance scans at this time", 409, "no_eligible_meeting")).detail, "No meeting is accepting attendance scans at this time");
  assert.equal(displayForAttendanceError(new KioskApiError("Not linked", 404, "roster_inactive")).message, "Member ID not recognized");
  assert.equal(displayForAttendanceError(new KioskApiError("Complete", 409, "attendance_complete")).id, "duplicate");
  assert.equal(credentialRejected(new KioskApiError(revokedCredentialMessage, 401, undefined, undefined, true)), true);
  assert.equal(credentialRejected(new KioskApiError("Request failed", 401)), false, "a 401 alone doesn't forget the pairing");
  assert.equal(credentialRejected(new KioskApiError("Nope", 403)), false);
});

test("only the Worker's own answer to a revoked credential forgets the pairing; any other 401 is a passing failure", async () => {
  // What kioskFor in apps/api/src/index.ts sends for a retired or replaced kiosk's token: a 401, JSON, this message, no code.
  assert.equal(revokedCredentialMessage, "Kiosk credential is invalid");
  assert.match(await readFile(new URL("../apps/api/src/index.ts", import.meta.url), "utf8"), /if \(!kiosk\) throw new HttpError\(401, "Kiosk credential is invalid"\);/);
  assert.equal(credentialRevoked(401, { error: revokedCredentialMessage }), true);
  assert.equal(credentialRevoked(403, { error: revokedCredentialMessage }), false);
  for (const body of [undefined, null, {}, "Kiosk credential is invalid", { error: "Kiosk authentication required" }, { error: "Sign in required" }]) assert.equal(credentialRevoked(401, body), false);

  const html = () => new Response("<html>Sign in</html>", { status: 401, headers: { "content-type": "text/html" } });
  const replies: Response[] = [];
  const options = { baseUrl: "/api", token: "test-token", fetchImpl: (async () => replies.shift()!) as unknown as typeof fetch };
  const api = createKioskApi(options);
  const rejection = async (reply: Response) => { replies.push(reply); try { await api.config(); } catch (error) { return error; } return undefined; };
  assert.equal(credentialRejected(await rejection(Response.json({ error: revokedCredentialMessage }, { status: 401 }))), true);
  // A proxy's 401 page, an empty 401, the Worker's other 401s and the message under a non-JSON type all keep the pairing.
  for (const reply of [html(), new Response(null, { status: 401 }), Response.json({ error: "Kiosk authentication required" }, { status: 401 }), Response.json({}, { status: 401 }),
    new Response(JSON.stringify({ error: revokedCredentialMessage }), { status: 401, headers: { "content-type": "text/html" } })]) {
    const error = await rejection(reply);
    assert.ok(error instanceof KioskApiError && error.status === 401);
    assert.equal(credentialRejected(error), false);
  }

  // The same for a scan: only the revoked answer is `credential`; any other 401 keeps the scan queued to send again.
  const scan = { eventId: "event-401", memberId: "1001", occurredAt: "2026-10-27T18:00:00.000Z", pairingId: "pairing-1", rescanSupported: true } as const;
  const deliver = (reply: Response) => { replies.push(reply); return deliverScan(options, scan); };
  assert.deepEqual(await deliver(Response.json({ error: revokedCredentialMessage }, { status: 401 })), { kind: "credential" });
  assert.deepEqual(await deliver(html()), { kind: "retry", status: 401 });
  assert.deepEqual(await deliver(new Response(null, { status: 401 })), { kind: "retry", status: 401 });
  assert.deepEqual(await deliver(Response.json({ error: "Kiosk authentication required" }, { status: 401 })), { kind: "retry", status: 401 });
  assert.deepEqual(await deliver(Response.json({ error: "Sign in required", code: "sign_in_required" }, { status: 401 })), { kind: "retry", status: 401 });
});

test("Set member PIN leaves maintenance once the member holds the kiosk, and maintenance closes when idle", async () => {
  // Picking the member is the Operator's step: Cancel goes back to the menu.
  assert.equal(maintenanceReturnFor("set", false), "menu");
  // From the PIN pad on the member holds the kiosk: cancelling or finishing shows the start screen, never the menu.
  assert.equal(maintenanceReturnFor("set", true), "start");
  // The Operator resets a PIN alone, so that task always returns to the menu.
  assert.equal(maintenanceReturnFor("reset", false), "menu");
  assert.equal(maintenanceReturnFor("reset", true), "menu");
  assert.equal(maintenanceReturnLabel("start"), "Done");
  assert.equal(maintenanceReturnLabel("menu"), "Back to maintenance");

  const screens = await readFile(new URL("../apps/dashboard/src/web-kiosk/member-pin-screens.tsx", import.meta.url), "utf8");
  assert.match(screens, /const returnsTo = maintenanceReturnFor\(task, stage !== undefined\);/);
  assert.match(screens, /const leave = returnsTo === "start" \? onExit : onBack;/);
  assert.match(screens, /<ChoosePinPad [^>]*onCancel=\{leave\}/, "Cancel on the PIN pad");
  assert.match(screens, /stage\?\.name === "done"\) return <CenteredMessage [^>]*><BackButton onBack=\{leave\} label=\{leaveLabel\} primary \/>/, "the final button");
  assert.doesNotMatch(screens, />Back to maintenance</, "the button's text follows where it goes");

  const screen = await readFile(new URL("../apps/dashboard/src/web-kiosk/attendance-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /onBack=\{\(\) => setMaintenance\("menu"\)\} onExit=\{\(\) => setMaintenance\(undefined\)\}/);
  // Every maintenance screen, the menu included, goes back to the start screen after a minute with no tap or key.
  assert.equal(maintenanceIdleTimeoutMs, 60_000);
  assert.match(screen, /if \(!maintenance\) return undefined;\s+const close = \(\) => setMaintenance\(undefined\);\s+let timer = window\.setTimeout\(close, maintenanceIdleTimeoutMs\);/);
});

test("commands: reload and settings PIN reset run; others are refused", () => {
  assert.equal(commandActionFor("reload_display"), "reload");
  assert.equal(commandActionFor("reset_network_pin"), "reset_pin");
  assert.equal(commandActionFor("reboot"), "unsupported");
});

test("branding colors become CSS variables, with defaults for missing or malformed colors", () => {
  const style = kioskBrandStyle({ primaryColor: "#ffffff", secondaryColor: "red" }) as Record<string, string>;
  assert.equal(style["--primary"], "#ffffff");
  assert.equal(style["--on-primary"], "#111714");
  assert.equal(style["--secondary"], "#dba72d");
  assert.equal((kioskBrandStyle(null) as Record<string, string>)["--primary"], "#146c5b");
});

test("/kiosk is the web kiosk; /kiosks stays the dashboard page", () => {
  assert.equal(isWebKioskPath("/kiosk"), true);
  assert.equal(isWebKioskPath("/kiosk/"), true);
  assert.equal(isWebKioskPath("/kiosks"), false);
  assert.equal(isWebKioskPath("/"), false);
});

test("the API client sends the bearer token without cookies, and pairing sends no token", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies: Response[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return replies.shift()!; }) as unknown as typeof fetch;
  replies.push(Response.json({ kioskId: "k1", kioskToken: "test-token", pairingId: "p1", name: "Test kiosk", kind: "web" }, { status: 201 }));
  const paired = await pairWebKiosk({ baseUrl: "/api", token: "ignored", fetchImpl }, "K7Q2M9XD");
  assert.equal(paired.kioskToken, "test-token");
  assert.equal(calls[0]!.url, "/api/kiosk/pair");
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, undefined);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { code: "K7Q2M9XD" });

  const api = createKioskApi({ baseUrl: "/api", token: "test-token", fetchImpl });
  replies.push(Response.json({ accepted: true, action: "check_in" }, { status: 202 }));
  const scan = { eventId: "e1", memberId: "1024", occurredAt: "2026-10-30T18:00:00.000Z", pairingId: "p1", rescanSupported: true as const };
  assert.equal((await api.attendance(scan)).action, "check_in");
  assert.equal(calls[1]!.url, "/api/kiosk/attendance");
  assert.equal(calls[1]!.init.credentials, "omit");
  assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), scan);

  replies.push(Response.json({ ok: true }));
  await api.heartbeat("2.1.0-beta.1");
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { readerOnline: true, authenticationMethod: "member_id", releaseVersion: "2.1.0-beta.1", pendingEvents: 0 });

  replies.push(new Response(null, { status: 304, headers: { etag: "\"kiosk-roster-v1-3\"" } }));
  assert.deepEqual(await api.roster("\"kiosk-roster-v1-3\""), { members: undefined, etag: "\"kiosk-roster-v1-3\"" });
  assert.equal((calls[3]!.init.headers as Record<string, string>)["if-none-match"], "\"kiosk-roster-v1-3\"");

  replies.push(Response.json({ completed: true }));
  await api.completeCommand("c 1", { success: true, message: "Reloading the display" });
  assert.equal(calls[4]!.url, "/api/kiosk/commands/c%201/result");

  replies.push(Response.json({ error: "Kiosk credential is invalid" }, { status: 401 }));
  await assert.rejects(api.config(), (error: unknown) => error instanceof KioskApiError && error.status === 401);
  replies.push(Response.json({ error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting" }, { status: 409 }));
  await assert.rejects(api.attendance(scan), (error: unknown) => error instanceof KioskApiError && error.code === "no_eligible_meeting");
  const failing = createKioskApi({ baseUrl: "/api", token: "test-token", fetchImpl: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch });
  await assert.rejects(failing.command(), KioskNetworkError);
});

test("the stored pairing needs every credential field; the memory store round-trips it", async () => {
  const pairing = { kioskId: "k1", kioskToken: "test-token", pairingId: "p1", name: "Test kiosk", settingsPin: { salt: "c2FsdA==", hash: "aGFzaA==", iterations: 100000 } };
  assert.deepEqual(usablePairing(pairing), pairing);
  assert.equal(usablePairing({ ...pairing, kioskToken: "" }), undefined);
  assert.equal(usablePairing(null), undefined);
  assert.deepEqual(usablePairing({ ...pairing, settingsPin: { salt: 1 } }), { kioskId: "k1", kioskToken: "test-token", pairingId: "p1", name: "Test kiosk" });
  const store = createMemoryStore();
  assert.equal(await store.load(), undefined);
  await store.save(pairing);
  assert.deepEqual(await store.load(), pairing);
  await store.clear();
  assert.equal(await store.load(), undefined);
});

test("the dashboard routes /kiosk to the web kiosk before its own startup requests", async () => {
  const main = await readFile("apps/dashboard/src/main.tsx", "utf8");
  assert.match(main, /if \(isWebKioskPath\(window\.location\.pathname\)\) void import\("\.\/web-kiosk\/web-kiosk-page\.tsx"\)/);
  assert.match(main, /else createRoot\(document\.getElementById\("root"\)!\)\.render\(<StrictMode><ErrorBoundary/);
  const page = await readFile("apps/dashboard/src/web-kiosk/kiosk-api.ts", "utf8");
  assert.doesNotMatch(page, /credentials: "include"/);
});

// ---- Discord code mode ----

const codeConfig = (settings: KioskSettings = {}): KioskConfig => ({ kiosk: { id: "k1", name: "Test web kiosk A" }, settings: { authenticationMethod: "member_id", memberLookup: "entry", discordCode: true, ...settings } });
/** Runs actions through the reducer with the kiosk's start screen, as the attendance screen does. */
const run = (home: IdleMode, flow: Flow, ...actions: FlowAction[]) => actions.reduce((current, action) => flowReducer(current, action, home), flow);
const typed = (digits: string): Flow => ({ step: "code", digits });
const memberA = { memberId: "1024", firstName: "Test", lastName: "Student A" };
const codeScan: DiscordCodeScan = { eventId: "event-code-1", discordCode: "482913", occurredAt: "2026-11-18T18:00:00.000Z", pairingId: "pairing-1", rescanSupported: true };
const codeAnswer = (status: number, body: unknown) => deliverScan({ baseUrl: "/api", token: "test-token", fetchImpl: (async () => Response.json(body, { status })) as unknown as typeof fetch }, codeScan);

test("a Discord code kiosk starts at the code screen online and at its backup method offline", () => {
  assert.equal(discordCodeFor(codeConfig()), true);
  assert.equal(idleModeFor(codeConfig(), true), "code");
  assert.equal(idleModeFor(codeConfig(), undefined), "code", "still connecting: the code screen");
  assert.equal(idleModeFor(codeConfig(), false), "lookup", "offline: the backup method");
  assert.equal(idleModeFor(codeConfig({ discordCode: false }), true), "lookup");
  // An older Worker sends neither field: the mode is off and the backup is offered only offline.
  const older: KioskConfig = { kiosk: { id: "k1", name: "Test web kiosk A" }, settings: { authenticationMethod: "member_id", memberLookup: "search" } };
  assert.equal(discordCodeFor(older), false);
  assert.equal(discordCodeBackupFor(older), "offline");
  assert.equal(idleModeFor(older, true), "lookup");
  assert.equal(idleModeFor(undefined, true), "lookup");
  assert.equal(discordCodeFor({ kiosk: older.kiosk, settings: null }), false);
  // Discord code belongs to the member ID method only.
  assert.equal(discordCodeFor(codeConfig({ authenticationMethod: "fingerprint" })), false);
  assert.equal(discordCodeBackupFor(codeConfig({ discordCodeBackup: "always" })), "always");
  assert.equal(discordCodeBackupFor(codeConfig({ discordCodeBackup: "sometimes" as "always" })), "offline");
});

test("the code screen takes exactly six digits, shows them, and sends without a confirm or PIN step", () => {
  let flow = run("code", initialFlow, { type: "reset" });
  assert.deepEqual(flow, codeFlow);
  for (const key of "48a29") flow = run("code", flow, { type: "key", key });
  assert.deepEqual(flow, typed("4829"), "only digits are typed");
  assert.equal(run("code", flow, { type: "code_submit" }), flow, "Enter does nothing before six digits");
  assert.deepEqual(run("code", flow, { type: "backspace" }), typed("482"));
  assert.deepEqual(run("code", flow, { type: "clear" }), codeFlow);
  assert.equal(run("code", flow, { type: "set", text: "999999" }), flow, "nothing can be pasted into the code");
  flow = run("code", flow, { type: "key", key: "1" }, { type: "key", key: "3" });
  assert.deepEqual(flow, typed("482913"));
  assert.equal(run("code", flow, { type: "key", key: "7" }), flow, "a seventh digit is ignored");
  flow = run("code", flow, { type: "code_submit" });
  assert.deepEqual(flow, { step: "code_sending" });
  assert.equal(run("code", flow, { type: "code_submit" }), flow, "a second Enter doesn't send again");
  assert.equal(run("code", flow, { type: "key", key: "1" }), flow);
  assert.equal(run("code", flow, { type: "timeout" }), flow, "the answer is waited for");
  // The server names the member; the normal result screen follows, then the code screen again.
  flow = run("code", flow, { type: "sent", display: displayForCodeScan({ kind: "accepted", result: { accepted: true, action: "check_in", meeting: { id: "m1", title: "Test Build Night" }, member: { id: "r1", displayName: "Test Student A" } } }) });
  assert.equal(flow.step, "result");
  if (flow.step === "result") { assert.equal(flow.display.id, "welcome"); assert.equal(flow.display.name, "Test Student A"); assert.equal(flow.display.meetingTitle, "Test Build Night"); }
  assert.deepEqual(run("code", flow, { type: "done" }), codeFlow);
  // With the mode off nothing changes: the start is the lookup.
  assert.deepEqual(run("lookup", flow, { type: "done" }), initialFlow);
  assert.equal(flowReducer(initialFlow, { type: "code_submit" }), initialFlow);
  assert.equal(flowReducer(initialFlow, { type: "use_backup" }), initialFlow);
  assert.equal(flowReducer(initialFlow, { type: "home" }), initialFlow);
  assert.equal(flowReducer(initialFlow, { type: "cancel" }), initialFlow);
  assert.equal(flowReducer({ step: "entry", text: "10" }, { type: "timeout" }).step, "entry", "the lookup has no idle timeout outside Discord code mode");
});

test("a code scan carries the code in place of a member ID, and can never be queued", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json({ accepted: true, eventId: codeScan.eventId, action: "check_in", member: { id: "r1", displayName: "Test Student A" } }, { status: 202 }); }) as unknown as typeof fetch;
  const outcome = await createKioskApi({ baseUrl: "/api", token: "test-token", fetchImpl }).deliver(codeScan);
  assert.equal(outcome.kind, "accepted");
  assert.equal(calls[0]!.url, "/api/kiosk/attendance");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), codeScan);
  assert.equal("memberId" in JSON.parse(String(calls[0]!.init.body)), false);
  assert.doesNotMatch(calls[0]!.url, /482913/);
  // The offline queue only holds scans with a member ID, so a code scan read back from it is dropped.
  assert.equal(usableQueuedScan({ ...codeScan, queuedAt: "2026-11-18T18:00:00.000Z" }), undefined);
  // The screen sends the code straight away: no queue, no saved copy, no offline check.
  const screen = await readFile("apps/dashboard/src/web-kiosk/attendance-screen.tsx", "utf8");
  const sendCodeScan = screen.slice(screen.indexOf("async function sendCodeScan"), screen.indexOf("function enterPin"));
  assert.match(sendCodeScan, /api\.deliver\(\{ eventId: crypto\.randomUUID\(\), discordCode: code,/);
  assert.doesNotMatch(sendCodeScan, /enqueue|store\.write|store\.queue|checkPinOffline|settle|newScan/);
});

test("each answer to a code scan leads to its screen", async () => {
  // Wrong, expired or already used: "Code not recognized", then Try again.
  const invalid = await codeAnswer(403, { error: "That code is wrong or has expired. Run /code in Discord for a new one.", code: "code_invalid" });
  assert.deepEqual(codeOutcomeFor(invalid), { kind: "invalid" });
  const refused = run("code", { step: "code_sending" }, { type: "code_refused", outcome: { kind: "invalid" } });
  assert.deepEqual(refused, { step: "code_invalid" });
  assert.deepEqual(run("code", refused, { type: "try_again" }), codeFlow);
  assert.deepEqual(run("code", refused, { type: "timeout" }), codeFlow);
  assert.deepEqual(run("code", refused, { type: "cancel" }), codeFlow);

  // Too many wrong codes: a 429 that answers the scan, with the server's wait.
  const throttled = await codeAnswer(429, { error: "Too many wrong codes. Try again in 30 seconds.", code: "code_throttled", retryAt: "2026-11-18T18:00:30.000Z", retryAfterSeconds: 30 });
  assert.equal(throttled.kind, "rejected");
  assert.deepEqual(codeOutcomeFor(throttled), { kind: "throttled", message: "Try again in 30 seconds." });
  assert.deepEqual(codeOutcomeFor(await codeAnswer(429, { code: "code_throttled" })), { kind: "throttled", message: "Try again in a few minutes." });
  const waiting = run("code", { step: "code_sending" }, { type: "code_refused", outcome: { kind: "throttled", message: "Try again in 30 seconds." } });
  assert.equal(waiting.step, "result");
  const display = (waiting as Extract<Flow, { step: "result" }>).display;
  assert.deepEqual({ id: display.id, tone: display.tone, message: display.message, detail: display.detail, durationMs: display.durationMs },
    { id: "rejected", tone: "error", message: "Too many wrong codes", detail: "Try again in 30 seconds.", durationMs: 4_000 });
  assert.deepEqual(run("code", waiting, { type: "done" }), codeFlow);

  // The mode was turned off on the dashboard: the backup method, while the kiosk loads its new config.
  const off = await codeAnswer(409, { error: "This kiosk does not take Discord codes.", code: "code_not_enabled" });
  assert.deepEqual(codeOutcomeFor(off), { kind: "not_enabled" });
  assert.deepEqual(run("code", { step: "code_sending" }, { type: "code_refused", outcome: { kind: "not_enabled" } }), initialFlow);

  // No answer, a timeout or a server error: the kiosk is offline and shows the backup method.
  const unreachable = await deliverScan({ baseUrl: "/api", token: "test-token", fetchImpl: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch }, codeScan);
  assert.deepEqual(codeOutcomeFor(unreachable), { kind: "unreachable" });
  const slow = await deliverScan({ baseUrl: "/api", token: "test-token", timeoutMs: 5, fetchImpl: (() => new Promise(() => undefined)) as unknown as typeof fetch }, codeScan);
  assert.deepEqual(codeOutcomeFor(slow), { kind: "unreachable" });
  assert.deepEqual(codeOutcomeFor(await codeAnswer(503, { error: "Unavailable" })), { kind: "unreachable" });
  assert.deepEqual(run("code", { step: "code_sending" }, { type: "code_refused", outcome: { kind: "unreachable" } }), initialFlow);

  // Other answers are not about the code: a busy server's 429, a refusal on the scan's merits, a refused credential.
  const busy = await codeAnswer(429, { error: "Too many requests" });
  assert.equal(codeOutcomeFor(busy), undefined);
  assert.equal(displayForCodeScan(busy).message, "Couldn't check your code");
  const noMeeting = await codeAnswer(409, { error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting" });
  assert.equal(codeOutcomeFor(noMeeting), undefined);
  assert.equal(displayForCodeScan(noMeeting).message, "No meeting right now");
  assert.match(displayForCodeScan(await codeAnswer(409, { error: "Scanned elsewhere", code: "possible_wrong_match" })).detail ?? "", /Run \/code again/);
  assert.equal((await codeAnswer(401, { error: "Kiosk credential is invalid" })).kind, "credential");
  // A 401 that isn't the Worker's revoked answer is a passing failure: the member tries the code again.
  const passing = await codeAnswer(401, { error: "Sign in required" });
  assert.deepEqual(passing, { kind: "retry", status: 401 });
  assert.equal(codeOutcomeFor(passing), undefined);
  assert.equal(displayForCodeScan(passing).message, "Couldn't check your code");
  // A refusal that arrives after the member left the sending screen changes nothing.
  assert.equal(run("code", codeFlow, { type: "code_refused", outcome: { kind: "invalid" } }), codeFlow);
});

test("the backup method is the kiosk's own lookup, and leads back to the code screen", () => {
  // "No code?" opens the lookup; the screen shows the button only when the backup is offered at any time.
  const backup = run("code", codeFlow, { type: "use_backup" });
  assert.deepEqual(backup, initialFlow);
  assert.equal(run("code", typed("48"), { type: "use_backup" }).step, "entry");
  assert.equal(backupButtonLabel("entry"), "No code? Use member ID");
  assert.equal(backupButtonLabel("search"), "No code? Search for your name");
  const screen = readFile("apps/dashboard/src/web-kiosk/attendance-screen.tsx", "utf8");
  return screen.then((source) => {
    assert.match(source, /backupLabel=\{codeBackup === "always" \? backupButtonLabel\(lookup\) : undefined\}/);
    // Cancel, the idle timeout and the end of a result all return to the code screen.
    assert.deepEqual(run("code", backup, { type: "cancel" }), codeFlow);
    assert.deepEqual(run("code", { step: "entry", text: "10" }, { type: "cancel" }), codeFlow);
    assert.deepEqual(run("code", { step: "entry", text: "10" }, { type: "timeout" }), codeFlow);
    assert.deepEqual(run("code", backup, { type: "timeout" }), codeFlow);
    assert.deepEqual(run("code", typed("48"), { type: "timeout" }), codeFlow, "a half-typed code is cleared");
    assert.equal(run("code", codeFlow, { type: "timeout" }), codeFlow);
    for (const step of ["entry", "code", "code_invalid"] as const) assert.equal(codeIdleSteps.has(step), true);
    // The lookup works as it always does: confirm, then the PIN step when the kiosk requires one.
    const confirm = run("code", backup, { type: "key", key: "1" }, { type: "key", key: "0" }, { type: "key", key: "2" }, { type: "key", key: "4" }, { type: "submit", roster });
    assert.deepEqual(confirm, { step: "confirm", member: memberA, back: "" });
    assert.deepEqual(run("code", confirm, { type: "not_me" }), { step: "entry", text: "" }, "Not me stays in the backup method");
    assert.deepEqual(run("code", confirm, { type: "timeout" }), codeFlow);
    assert.deepEqual(run("code", confirm, { type: "confirm", pin: { kind: "entry" } }), { step: "pin", member: memberA });
    assert.deepEqual(run("code", { step: "pin", member: memberA }, { type: "cancel" }), codeFlow);
    assert.deepEqual(run("code", { step: "pin", member: memberA }, { type: "timeout" }), codeFlow);
    const result = run("code", confirm, { type: "confirm" }, { type: "sent", display: displayForAttendance({ action: "check_in" }, memberA) });
    assert.equal(result.step, "result");
    assert.deepEqual(run("code", result, { type: "done" }), codeFlow);
  });
});

test("going offline shows the backup method with a note; an idle kiosk returns to the code screen once back online", () => {
  // Offline: the code screen and "Code not recognized" give way to the lookup. A member midway keeps their step.
  assert.deepEqual(run("lookup", codeFlow, { type: "home" }), initialFlow);
  assert.deepEqual(run("lookup", typed("4829"), { type: "home" }), initialFlow);
  assert.deepEqual(run("lookup", { step: "code_invalid" }, { type: "home" }), initialFlow);
  const sending: Flow = { step: "code_sending" };
  assert.equal(run("lookup", sending, { type: "home" }), sending);
  // While offline the kiosk behaves as a lookup kiosk: everything returns to the lookup.
  assert.deepEqual(run("lookup", { step: "confirm", member: memberA, back: "" }, { type: "timeout" }), initialFlow);
  assert.deepEqual(run("lookup", { step: "result", display: displayForAttendance({ action: "check_in" }, memberA) }, { type: "done" }), initialFlow);
  assert.equal(offlineCodeNote("entry"), "Discord codes need a network connection. Sign in with your member ID instead.");
  assert.equal(offlineCodeNote("search"), "Discord codes need a network connection. Search for your name instead.");
  // Back online: an idle lookup becomes the code screen; a member who is typing or confirming finishes first.
  assert.deepEqual(run("code", initialFlow, { type: "home" }), codeFlow);
  const typing: Flow = { step: "entry", text: "10" };
  assert.equal(run("code", typing, { type: "home" }), typing);
  const confirming: Flow = { step: "confirm", member: memberA, back: "" };
  assert.equal(run("code", confirming, { type: "home" }), confirming);
  assert.deepEqual(run("code", confirming, { type: "confirm" }, { type: "sent", display: displayForAttendance({ action: "check_in" }, memberA) }, { type: "done" }), codeFlow);
  assert.equal(run("code", codeFlow, { type: "home" }), codeFlow);
});

test("turning Discord code on or off, or changing when the backup is offered, counts as a config change", () => {
  assert.equal(rosterChanged(codeConfig({ discordCode: false }), codeConfig()), true);
  assert.equal(rosterChanged(codeConfig(), codeConfig({ discordCode: false })), true);
  assert.equal(rosterChanged(codeConfig(), codeConfig({ discordCodeBackup: "always" })), true);
  assert.equal(rosterChanged(codeConfig({ discordCodeBackup: "always" }), codeConfig({ discordCodeBackup: "offline" })), true);
  assert.equal(rosterChanged(codeConfig(), codeConfig({ discordCodeBackup: "offline" })), false, "a missing backup setting is offline");
  assert.equal(rosterChanged(codeConfig(), codeConfig()), false);
  // An older Worker's config, without the fields, equals one with the mode off.
  const older: KioskConfig = { kiosk: { id: "k1", name: "Test web kiosk A" }, settings: { authenticationMethod: "member_id", memberLookup: "entry" } };
  assert.equal(rosterChanged(older, codeConfig({ discordCode: false })), false);
  // The backup method's own settings still count.
  assert.equal(rosterChanged(codeConfig(), codeConfig({ memberLookup: "search" })), true);
  assert.equal(rosterChanged(codeConfig(), codeConfig({ requirePin: true })), true);
});

test("a render error shows a reload screen instead of a blank kiosk", async () => {
  const page = await readFile(new URL("../apps/dashboard/src/web-kiosk/web-kiosk-page.tsx", import.meta.url), "utf8");
  assert.match(page, /render\(<StrictMode><ErrorBoundary fallback=\{\(\) => <KioskErrorFallback \/>\}><WebKioskPage store=\{browserStore\(\)\} \/><\/ErrorBoundary><\/StrictMode>\)/);
  assert.match(page, /onClick=\{\(\) => window\.location\.reload\(\)\}>Reload kiosk<\/button>/);
  // The fallback only reloads: it never touches the stored pairing or the queue.
  const fallback = page.slice(page.indexOf("export function KioskErrorFallback"), page.indexOf("function browserStore"));
  assert.doesNotMatch(fallback, /store\b/);
});

test("the waiting screen says who approves a PIN request and where", async () => {
  const screens = await readFile(new URL("../apps/dashboard/src/web-kiosk/member-pin-screens.tsx", import.meta.url), "utf8");
  assert.match(screens, /Waiting for an Operator or Admin to approve in the dashboard/);
  assert.doesNotMatch(screens, /approve here from maintenance/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  commandActionFor, credentialRejected, displayForAttendance, displayForAttendanceError, entryInputFor, flowReducer, initialFlow, kioskBrandStyle, memberLookupFor,
  pairingCodeCharacters, pairingCodeFromHash, pairingCodeProblem, pairingErrorMessage, physicalKeyFor, rosterChanged, settingsPinProblem, wrongPairingCodeMessage, type Flow,
} from "../apps/dashboard/src/web-kiosk/kiosk-flow.ts";
import { KioskApiError, KioskNetworkError, createKioskApi, pairWebKiosk, type KioskConfig } from "../apps/dashboard/src/web-kiosk/kiosk-api.ts";
import { createMemoryStore, usablePairing } from "../apps/dashboard/src/web-kiosk/kiosk-store.ts";
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
  assert.equal(credentialRejected(new KioskApiError("Kiosk credential is invalid", 401)), true);
  assert.equal(credentialRejected(new KioskApiError("Nope", 403)), false);
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

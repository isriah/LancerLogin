import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { KioskApiError, createKioskApi, deliverScan, type AttendanceScan, type KioskConfig, type PinRequest, type RosterMember } from "../apps/dashboard/src/web-kiosk/kiosk-api.ts";
import { displayForAttendanceError, flowReducer, initialFlow, pinIdleSteps, rosterChanged, type Flow, type KioskMember } from "../apps/dashboard/src/web-kiosk/kiosk-flow.ts";
import { createMemoryQueue, usableQueuedScan } from "../apps/dashboard/src/web-kiosk/kiosk-store.ts";
import { createMemoryRefusedStore, createScanSync } from "../apps/dashboard/src/web-kiosk/kiosk-sync.ts";
import {
  afterOfflineMatch, afterPinFailureReport, choosePinStep, lockoutLine, memberPinProblem, memberPinState, pinFailureReport, pinLockFor, pinLockoutFor, pinOutcomeFor,
  recordOfflineFailure, requirePinFor, rosterHasPinData, usablePinFailures, validMemberPin, verifyMemberPin, withoutPinData, type PinFailureLedger,
} from "../apps/dashboard/src/web-kiosk/member-pin.ts";

// Synthetic members and PINs only.
const member: KioskMember = { memberId: "1007", firstName: "Test Student", lastName: "G" };

/** A cached hash the way the server makes it: PBKDF2-SHA256, a 16-byte salt and a 32-byte key, base64. */
function serverHash(pin: string, iterations = 100_000, salt = randomBytes(16)) {
  return { hash: pbkdf2Sync(pin, salt, iterations, 32, "sha256").toString("base64"), salt: salt.toString("base64"), iterations };
}

test("member PINs are 4 to 6 digits, typed twice when chosen", () => {
  for (const pin of ["1234", "12345", "123456"]) assert.equal(validMemberPin(pin), true);
  for (const pin of ["123", "1234567", "12a4", "", " 1234"]) assert.equal(validMemberPin(pin), false);
  assert.equal(memberPinProblem("4821", "4821"), undefined);
  assert.match(memberPinProblem("482", "482") ?? "", /4 to 6 digits/);
  assert.match(memberPinProblem("4821", "4822") ?? "", /don't match/);
  assert.deepEqual(choosePinStep(undefined, "4821"), { first: "4821" });
  assert.deepEqual(choosePinStep("4821", "4821"), { pin: "4821" });
  assert.match((choosePinStep("4821", "4822") as { problem: string }).problem, /don't match/);
  assert.match((choosePinStep(undefined, "12") as { problem: string }).problem, /4 to 6 digits/);
});

test("the offline check matches the server's PBKDF2 hash (Node pbkdf2Sync vectors) and nothing else", async () => {
  const stored = serverHash("4821");
  assert.equal(Buffer.from(stored.hash, "base64").length, 32);
  assert.equal(await verifyMemberPin("4821", stored), true);
  assert.equal(await verifyMemberPin("4822", stored), false);
  assert.equal(await verifyMemberPin("48210", stored), false);
  // A fixed vector: the same PIN, salt and iterations always derive the same key.
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const fixed = serverHash("135790", 1_000, salt);
  assert.equal(fixed.hash, pbkdf2Sync("135790", salt, 1_000, 32, "sha256").toString("base64"));
  assert.equal(await verifyMemberPin("135790", fixed), true);
  assert.equal(await verifyMemberPin("135791", fixed), false);
});

test("a malformed or untrusted cached hash never matches", async () => {
  const stored = serverHash("4821", 1_000);
  assert.equal(await verifyMemberPin("4821", null), false);
  assert.equal(await verifyMemberPin("4821", undefined), false);
  assert.equal(await verifyMemberPin("482", serverHash("482", 1_000)), false, "not a valid member PIN");
  assert.equal(await verifyMemberPin("4821", { ...stored, iterations: 0 }), false);
  assert.equal(await verifyMemberPin("4821", { ...stored, iterations: 100_001 }), false, "more iterations than the server uses");
  assert.equal(await verifyMemberPin("4821", { ...stored, hash: "" }), false);
  assert.equal(await verifyMemberPin("4821", { ...stored, salt: "not base64!" }), false);
  assert.equal(await verifyMemberPin("4821", { ...stored, hash: stored.hash.slice(0, 20) }), false, "a short hash");
});

test("wrong tries made offline count locally and lock under the cached lockout setting", () => {
  const lockout = { enabled: true, attempts: 3, minutes: 15 };
  const start = Date.parse("2026-10-30T18:00:00.000Z");
  let ledger: PinFailureLedger = [];
  let result = recordOfflineFailure(ledger, "1007", start, lockout); ledger = result.ledger;
  assert.equal(result.lockedUntil, undefined);
  result = recordOfflineFailure(ledger, "1007", start + 1_000, lockout); ledger = result.ledger;
  assert.equal(result.lockedUntil, undefined);
  assert.equal(pinLockFor({ member: { ...member }, ledger, now: start + 2_000 }), undefined);
  result = recordOfflineFailure(ledger, "1007", start + 2_000, lockout); ledger = result.ledger;
  assert.equal(result.lockedUntil, "2026-10-30T18:15:02.000Z");
  assert.deepEqual(ledger, [{ memberId: "1007", count: 3, lastAt: "2026-10-30T18:00:02.000Z", streak: 3, lockedUntil: "2026-10-30T18:15:02.000Z" }]);
  assert.equal(pinLockFor({ member, ledger, now: start + 60_000 }), "2026-10-30T18:15:02.000Z");
  // Another member is not locked.
  assert.equal(pinLockFor({ member: { ...member, memberId: "1008" }, ledger, now: start + 60_000 }), undefined);
  // The lock runs out; the next wrong try starts a fresh count toward a lock, but every try is still reported.
  const later = start + 16 * 60_000;
  assert.equal(pinLockFor({ member, ledger, now: later }), undefined);
  result = recordOfflineFailure(ledger, "1007", later, lockout); ledger = result.ledger;
  assert.equal(result.lockedUntil, undefined);
  assert.deepEqual(ledger[0], { memberId: "1007", count: 4, lastAt: new Date(later).toISOString(), streak: 1 });
  assert.deepEqual(pinFailureReport(ledger), [{ memberId: "1007", count: 4, lastAt: new Date(later).toISOString() }]);
});

test("with lockout off, wrong tries are only counted; a right PIN starts the local count again", () => {
  const off = { enabled: false, attempts: 3, minutes: 15 };
  let ledger: PinFailureLedger = [];
  for (let n = 0; n < 10; n += 1) ledger = recordOfflineFailure(ledger, "1007", 1_000_000 + n, off).ledger;
  assert.equal(pinLockFor({ member, ledger, now: 2_000_000 }), undefined);
  assert.equal(ledger[0]!.count, 10);
  ledger = afterOfflineMatch(ledger, "1007");
  assert.deepEqual(ledger, [{ memberId: "1007", count: 10, lastAt: new Date(1_000_009).toISOString(), streak: 0 }]);
  assert.deepEqual(afterOfflineMatch([], "1007"), []);
});

test("reported tries leave the ledger once the server has them; tries made meanwhile stay", () => {
  const lockout = { enabled: true, attempts: 3, minutes: 15 };
  let ledger: PinFailureLedger = [];
  for (let n = 0; n < 3; n += 1) ledger = recordOfflineFailure(ledger, "1007", 1_000_000 + n, lockout).ledger;
  ledger = recordOfflineFailure(ledger, "1008", 1_000_100, lockout).ledger;
  const report = pinFailureReport(ledger);
  assert.deepEqual(report.map((item) => [item.memberId, item.count]), [["1007", 3], ["1008", 1]]);
  // One more wrong try for 1008 while the report is on its way.
  ledger = recordOfflineFailure(ledger, "1008", 1_000_200, lockout).ledger;
  ledger = afterPinFailureReport(ledger, report);
  // 1007's local lock goes with its tries: the server's lock comes back with the roster.
  assert.deepEqual(ledger, [{ memberId: "1008", count: 1, lastAt: new Date(1_000_200).toISOString(), streak: 1 }]);
  assert.deepEqual(afterPinFailureReport(ledger, pinFailureReport(ledger)), []);
});

test("the report keeps within /kiosk/pin-failures limits, and a saved ledger is checked before use", () => {
  const many: PinFailureLedger = Array.from({ length: 250 }, (_, n) => ({ memberId: `m${n}`, count: n === 0 ? 5_000 : 1, lastAt: "2026-10-30T18:00:00.000Z", streak: 1 }));
  const report = pinFailureReport(many);
  assert.equal(report.length, 200);
  assert.equal(report[0]!.count, 1_000);
  assert.deepEqual(pinFailureReport([{ memberId: "1007", count: 0, lastAt: "2026-10-30T18:00:00.000Z", streak: 0 }]), []);
  assert.deepEqual(usablePinFailures(undefined), []);
  assert.deepEqual(usablePinFailures([null, { memberId: "1007" }, { memberId: "", count: 1, lastAt: "2026-10-30T18:00:00.000Z" }, { memberId: "1008", count: 2, lastAt: "2026-10-30T18:00:00.000Z", lockedUntil: "soon" }]),
    [{ memberId: "1008", count: 2, lastAt: "2026-10-30T18:00:00.000Z", streak: 2 }]);
});

test("a member is refused before typing while the roster's lock, a server-reported lock or a local lock is in the future", () => {
  const now = Date.parse("2026-10-30T18:00:00.000Z");
  const rosterLocked: RosterMember = { ...member, pin: serverHash("4821", 1_000), pinLockedUntil: "2026-10-30T18:10:00.000Z" };
  assert.equal(pinLockFor({ member: rosterLocked, ledger: [], now }), "2026-10-30T18:10:00.000Z");
  assert.equal(pinLockFor({ member: { ...rosterLocked, pinLockedUntil: "2026-10-30T17:59:00.000Z" }, ledger: [], now }), undefined, "a lock that ran out");
  assert.equal(pinLockFor({ member: { ...rosterLocked, pinLockedUntil: null }, ledger: [], serverLock: "2026-10-30T18:20:00.000Z", now }), "2026-10-30T18:20:00.000Z");
  const ledger: PinFailureLedger = [{ memberId: "1007", count: 3, lastAt: "2026-10-30T17:59:00.000Z", streak: 3, lockedUntil: "2026-10-30T18:30:00.000Z" }];
  assert.equal(pinLockFor({ member: rosterLocked, ledger, serverLock: "2026-10-30T18:20:00.000Z", now }), "2026-10-30T18:30:00.000Z", "the latest lock wins");
  assert.equal(lockoutLine({ lockedUntil: "2026-10-30T16:15:00.000Z" }, "en-US").replace(/\s/g, " ").startsWith("PIN locked until "), true);
  assert.equal(lockoutLine({ attemptsLeft: 2 }), "2 tries left before the PIN locks");
  assert.equal(lockoutLine({ attemptsLeft: 1 }), "1 try left before the PIN locks");
  assert.equal(lockoutLine({}), undefined);
});

test("the roster says whether a member has a PIN only at a Require PIN kiosk", () => {
  assert.equal(memberPinState({ ...member, pin: serverHash("4821", 1_000), pinLockedUntil: null }), "set");
  assert.equal(memberPinState({ ...member, pin: null, pinLockedUntil: null }), "none");
  assert.equal(memberPinState({ ...member }), "unknown");
  assert.equal(memberPinState(undefined), "unknown");
});

test("turning Require PIN off removes the cached hashes and makes the kiosk load the roster again", () => {
  const withPins: RosterMember[] = [{ ...member, pin: serverHash("4821", 1_000), pinLockedUntil: "2026-10-30T18:10:00.000Z" }, { memberId: "1008", firstName: "Test Student", lastName: "H", pin: null, pinLockedUntil: null }];
  assert.equal(rosterHasPinData(withPins), true);
  const stripped = withoutPinData(withPins);
  assert.equal(rosterHasPinData(stripped), false);
  assert.deepEqual(stripped, [{ ...member }, { memberId: "1008", firstName: "Test Student", lastName: "H" }]);
  assert.doesNotMatch(JSON.stringify(stripped), /hash|salt/);
  const config = (requirePin?: boolean): KioskConfig => ({ kiosk: { id: "k", name: "Test web kiosk" }, settings: { authenticationMethod: "member_id", memberLookup: "entry", ...(requirePin === undefined ? {} : { requirePin }) } });
  assert.equal(rosterChanged(config(true), config(false)), true);
  assert.equal(rosterChanged(config(false), config(true)), true);
  assert.equal(rosterChanged(config(undefined), config(false)), false);
  assert.equal(rosterChanged(config(true), config(true)), false);
  assert.equal(requirePinFor(config(true)), true);
  assert.equal(requirePinFor(config(undefined)), false);
});

test("the cached lockout setting stays within the server's limits", () => {
  const config = (pinLockout: unknown): KioskConfig => ({ kiosk: { id: "k", name: "Test web kiosk" }, settings: { pinLockout } as KioskConfig["settings"] });
  assert.deepEqual(pinLockoutFor(config({ enabled: true, attempts: 3, minutes: 15 })), { enabled: true, attempts: 3, minutes: 15 });
  assert.deepEqual(pinLockoutFor(config({ enabled: "yes", attempts: 2, minutes: 5000 })), { enabled: false, attempts: 5, minutes: 15 });
  assert.deepEqual(pinLockoutFor(undefined), { enabled: false, attempts: 5, minutes: 15 });
});

// ---- The server's answers ----

const scan: AttendanceScan = { eventId: "event-pin-1", memberId: "1007", occurredAt: "2026-10-30T18:00:00.000Z", pairingId: "pairing-1", rescanSupported: true, pin: "4821" };
const answer = (status: number, body: unknown) => deliverScan({ baseUrl: "/api", token: "test-token", fetchImpl: (async () => Response.json(body, { status })) as unknown as typeof fetch }, scan);

test("a wrong PIN is a 401 with its own code, not a refused credential", async () => {
  const wrong = await answer(403, { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 2 });
  assert.deepEqual(wrong, { kind: "rejected", status: 403, code: "pin_incorrect", message: "Wrong PIN.", attemptsLeft: 2 });
  assert.deepEqual(pinOutcomeFor(wrong), { kind: "wrong", attemptsLeft: 2 });
  const locking = await answer(403, { error: "Wrong PIN.", code: "pin_incorrect", attemptsLeft: 0, lockedUntil: "2026-10-30T18:15:00.000Z" });
  assert.deepEqual(pinOutcomeFor(locking), { kind: "wrong", lockedUntil: "2026-10-30T18:15:00.000Z", attemptsLeft: 0 });
  assert.deepEqual(pinOutcomeFor(await answer(403, { error: "Wrong PIN.", code: "pin_incorrect" })), { kind: "wrong" }, "lockout off: no attempts left");
  assert.deepEqual(await answer(401, { error: "Kiosk credential is invalid" }), { kind: "credential" });
});

test("locked, no PIN yet and other refusals map to their screens", async () => {
  const locked = await answer(423, { error: "This PIN is locked after too many wrong tries.", code: "pin_locked", lockedUntil: "2026-10-30T18:15:00.000Z" });
  assert.deepEqual(pinOutcomeFor(locked), { kind: "locked", lockedUntil: "2026-10-30T18:15:00.000Z" });
  assert.deepEqual(pinOutcomeFor(await answer(409, { error: "This member has no PIN yet.", code: "pin_not_set" })), { kind: "not_set" });
  for (const code of ["pin_required", "invalid_pin", "invalid_member", "no_eligible_meeting"]) {
    const refused = await answer(400, { error: "Refused", code });
    assert.equal(refused.kind, "rejected");
    assert.equal(pinOutcomeFor(refused), undefined, code);
  }
  assert.equal(displayForAttendanceError(new KioskApiError("This kiosk requires a PIN.", 400, "pin_required")).message, "PIN needed");
  assert.equal(pinOutcomeFor(await answer(200, { accepted: true, eventId: scan.eventId, action: "check_in" })), undefined);
  assert.deepEqual(pinOutcomeFor(new KioskApiError("Locked", 423, "pin_locked", "2026-10-30T18:15:00.000Z")), { kind: "locked", lockedUntil: "2026-10-30T18:15:00.000Z" });
});

test("the PIN calls use the kiosk endpoints, and the PIN goes only in a request body", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const replies: unknown[] = [
    { request: { id: "req-1", status: "pending", expiresAt: "2026-10-30T18:10:00.000Z" } },
    { request: { id: "req-1", status: "approved", expiresAt: "2026-10-30T18:05:00.000Z" } },
    { request: { id: "req-1", status: "used", expiresAt: "2026-10-30T18:05:00.000Z" } },
    { pin: { set: true, setAt: "2026-10-30T18:00:00.000Z" } },
    { reset: true },
    { recorded: 3 },
  ];
  const api = createKioskApi({ baseUrl: "/api", token: "test-token", fetchImpl: (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(replies.shift(), { status: 201 });
  }) as unknown as typeof fetch });
  assert.equal((await api.requestPin("1007")).status, "pending");
  assert.equal((await api.pinRequest("req-1")).status, "approved");
  assert.equal((await api.choosePin("req-1", "4821")).status, "used");
  assert.deepEqual(await api.setMemberPin("1008", "5930"), { set: true, setAt: "2026-10-30T18:00:00.000Z" });
  assert.equal(await api.resetMemberPin("1007"), true);
  assert.deepEqual(await api.pinFailures([{ memberId: "1007", count: 3, lastAt: "2026-10-30T18:00:00.000Z" }]), { recorded: 3 });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    "POST /api/kiosk/pin-requests", "GET /api/kiosk/pin-requests/req-1", "POST /api/kiosk/pin-requests/req-1/pin", "POST /api/kiosk/pins", "POST /api/kiosk/pins/1007/reset", "POST /api/kiosk/pin-failures",
  ]);
  assert.deepEqual(calls[2]!.body, { pin: "4821" });
  assert.ok(calls.every((call) => !call.url.includes("4821") && !call.url.includes("5930")));
  await assert.rejects(createKioskApi({ baseUrl: "/api", token: "t", fetchImpl: (async () => Response.json({ error: "Locked", code: "pin_locked", lockedUntil: "2026-10-30T18:15:00.000Z" }, { status: 423 })) as unknown as typeof fetch }).requestPin("1007"),
    (error: unknown) => error instanceof KioskApiError && error.code === "pin_locked" && error.lockedUntil === "2026-10-30T18:15:00.000Z");
});

test("a queued offline PIN scan keeps pinCheck and never a PIN", async () => {
  const queued = { eventId: "e1", memberId: "1007", occurredAt: "2026-10-30T18:00:00.000Z", pairingId: "p", queuedAt: "2026-10-30T18:00:00.000Z", pinCheck: "offline", pin: "4821" };
  assert.deepEqual(usableQueuedScan(queued), { eventId: "e1", memberId: "1007", occurredAt: "2026-10-30T18:00:00.000Z", pairingId: "p", queuedAt: "2026-10-30T18:00:00.000Z", pinCheck: "offline" });
  assert.equal(usableQueuedScan({ ...queued, pinCheck: "online" })?.pinCheck, undefined);
});

test("a scan sent straight away with its PIN is settled like a queued one: refusals are kept for review", async () => {
  const refused = createMemoryRefusedStore();
  const sync = createScanSync({ queue: createMemoryQueue(), refused, send: async () => ({ kind: "unreachable" }) });
  const sent = { eventId: "e2", memberId: "1007", occurredAt: "2026-10-30T18:00:00.000Z", pairingId: "p", queuedAt: "2026-10-30T18:00:00.000Z" };
  await sync.settle(sent, { kind: "rejected", status: 409, code: "no_eligible_meeting", message: "No meeting" });
  assert.equal((await refused.list())[0]?.reasonCode, "no_eligible_meeting");
  await sync.settle({ ...sent, eventId: "e3" }, { kind: "accepted", result: { accepted: true, eventId: "e3" } });
  assert.equal(sync.fate("e3")?.kind, "accepted");
  assert.equal((await refused.list()).length, 1);
  assert.ok(sync.lastDeliveredAt());
});

// ---- The screens ----

const at = (flow: Flow, ...actions: Parameters<typeof flowReducer>[1][]) => actions.reduce(flowReducer, flow);
const confirming: Flow = { step: "confirm", member, back: "" };
const pending: PinRequest = { id: "req-1", status: "pending", expiresAt: "2026-10-30T18:10:00.000Z" };

test("Confirm leads to the PIN keypad, then the scan is sent; a wrong PIN can be tried again", () => {
  assert.deepEqual(at(confirming, { type: "confirm" }), { step: "sending", member }, "no PIN at a kiosk without Require PIN");
  const pin = at(confirming, { type: "confirm", pin: { kind: "entry" } });
  assert.deepEqual(pin, { step: "pin", member });
  assert.deepEqual(at(pin, { type: "pin_entered" }), { step: "sending", member });
  const wrong = at(pin, { type: "pin_entered" }, { type: "pin_refused", outcome: { kind: "wrong", attemptsLeft: 2 } });
  assert.deepEqual(wrong, { step: "wrong_pin", member, attemptsLeft: 2 });
  assert.deepEqual(at(wrong, { type: "try_again" }), { step: "pin", member });
  assert.deepEqual(at(pin, { type: "pin_entered" }, { type: "sent", display: { id: "welcome", message: "Welcome" } as never }).step, "result");
});

test("the try that locks, and a locked member, end at the lock", () => {
  const sending: Flow = { step: "sending", member };
  const locking = at(sending, { type: "pin_refused", outcome: { kind: "wrong", attemptsLeft: 0, lockedUntil: "2026-10-30T18:15:00.000Z" } });
  assert.deepEqual(locking, { step: "wrong_pin", member, lockedUntil: "2026-10-30T18:15:00.000Z", attemptsLeft: 0 });
  assert.equal(at(locking, { type: "try_again" }), locking, "no more tries while locked");
  assert.deepEqual(at(sending, { type: "pin_refused", outcome: { kind: "locked", lockedUntil: "2026-10-30T18:15:00.000Z" } }), { step: "pin_locked", member, lockedUntil: "2026-10-30T18:15:00.000Z" });
  assert.deepEqual(at(confirming, { type: "confirm", pin: { kind: "locked", lockedUntil: "2026-10-30T18:15:00.000Z" } }), { step: "pin_locked", member, lockedUntil: "2026-10-30T18:15:00.000Z" });
});

test("a member with no PIN asks for approval, waits, chooses a PIN twice, and the scan is sent", () => {
  const none = at(confirming, { type: "confirm", pin: { kind: "none" } });
  assert.deepEqual(none, { step: "no_pin", member });
  assert.deepEqual(at({ step: "sending", member }, { type: "pin_refused", outcome: { kind: "not_set" } }), { step: "no_pin", member }, "the server says there's no PIN");
  const asking = at(none, { type: "ask" });
  assert.deepEqual(asking, { step: "no_pin", member, asking: true });
  assert.equal(at(asking, { type: "ask" }), asking, "one request at a time");
  assert.deepEqual(at(asking, { type: "ask_failed", message: "Couldn't reach the server." }), { step: "no_pin", member, error: "Couldn't reach the server." });
  assert.deepEqual(at(asking, { type: "has_pin" }), { step: "pin", member }, "the member had a PIN after all");
  const waiting = at(asking, { type: "asked", request: pending });
  assert.deepEqual(waiting, { step: "waiting", member, requestId: "req-1", expiresAt: pending.expiresAt });
  assert.equal(at(waiting, { type: "request_status", request: pending }).step, "waiting");
  assert.equal(at(waiting, { type: "request_status", request: { ...pending, id: "other", status: "approved" } }), waiting, "another request's answer");
  const choosing = at(waiting, { type: "request_status", request: { ...pending, status: "approved", expiresAt: "2026-10-30T18:05:00.000Z" } });
  assert.deepEqual(choosing, { step: "choose_pin", member, requestId: "req-1" });
  assert.equal(at(choosing, { type: "pin_chosen" }), choosing, "the PIN is typed twice first");
  const typedOnce = at(choosing, { type: "choose_first", pin: "4821" });
  assert.deepEqual(typedOnce, { step: "choose_pin", member, requestId: "req-1", first: "4821" });
  assert.deepEqual(at(typedOnce, { type: "choose_problem", problem: "The two PINs don't match." }), { step: "choose_pin", member, requestId: "req-1", error: "The two PINs don't match." });
  assert.deepEqual(at(typedOnce, { type: "pin_chosen" }), { step: "sending", member });
  // Approved straight away (an Operator was quick).
  assert.equal(at(asking, { type: "asked", request: { ...pending, status: "approved" } }).step, "choose_pin");
});

test("a declined, expired or used request says so and returns to the start", () => {
  const waiting: Flow = { step: "waiting", member, requestId: "req-1", expiresAt: pending.expiresAt };
  const ended = (status: PinRequest["status"]) => at(waiting, { type: "request_status", request: { ...pending, status } });
  const declined = ended("declined");
  assert.equal(declined.step, "result");
  assert.equal(declined.step === "result" && declined.display.message, "Request declined");
  assert.equal(((ended("expired")) as Extract<Flow, { step: "result" }>).display.message, "Request expired");
  assert.equal(((ended("used")) as Extract<Flow, { step: "result" }>).display.message, "PIN already set");
  assert.deepEqual(at(declined, { type: "done" }), initialFlow);
});

test("Cancel and the idle timeout leave every PIN screen for the start; the waiting screen only on Cancel", () => {
  const screens: Flow[] = [
    { step: "pin", member }, { step: "wrong_pin", member }, { step: "pin_locked", member }, { step: "no_pin", member },
    { step: "choose_pin", member, requestId: "req-1", first: "4821" },
  ];
  for (const screen of screens) {
    assert.ok(pinIdleSteps.has(screen.step));
    assert.deepEqual(at(screen, { type: "cancel" }), initialFlow, screen.step);
    assert.deepEqual(at(screen, { type: "timeout" }), initialFlow, screen.step);
  }
  const waiting: Flow = { step: "waiting", member, requestId: "req-1", expiresAt: pending.expiresAt };
  assert.equal(at(waiting, { type: "timeout" }), waiting);
  assert.deepEqual(at(waiting, { type: "cancel" }), initialFlow);
  const sending: Flow = { step: "sending", member };
  assert.equal(at(sending, { type: "cancel" }), sending, "a scan on its way can't be cancelled");
});

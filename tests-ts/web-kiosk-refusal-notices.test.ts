// What the web kiosk shows when the Worker refuses a scan that has nothing wrong with it: the same headline, second
// line, notice colour and five seconds as the Pi kiosk, for a scan sent by member ID (through the queue), with a PIN
// (settled straight away) or with a Discord code. A Worker that sends no reason keeps today's screens.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deliverScan, type AttendanceScan, type DiscordCodeScan, type SendOutcome } from "../apps/dashboard/src/web-kiosk/kiosk-api.ts";
import { displayForAttendanceError, displayForCodeScan, displayForScanFate, flowReducer, type Flow } from "../apps/dashboard/src/web-kiosk/kiosk-flow.ts";
import { createMemoryQueue } from "../apps/dashboard/src/web-kiosk/kiosk-store.ts";
import { createMemoryRefusedStore, createScanSync } from "../apps/dashboard/src/web-kiosk/kiosk-sync.ts";

const noMeeting = { error: "No meeting is accepting attendance scans at this time", code: "no_eligible_meeting" };
// Each refusal body as the Worker sends it, and the screen it leads to.
const refusals: [Record<string, unknown>, string, string][] = [
  [{ ...noMeeting, reason: "too_early", meetingTitle: "Test meeting A", at: "2026-11-18T22:45:00.000Z", time: "5:45 PM" }, "Too early", "Test meeting A opens for scans at 5:45 PM"],
  [{ ...noMeeting, reason: "meeting_ended", meetingTitle: "Test meeting A", at: "2026-11-19T01:30:00.000Z", time: "8:30 PM" }, "Meeting ended", "Scans for Test meeting A closed at 8:30 PM"],
  [{ ...noMeeting, reason: "no_meeting_today" }, "No meeting today", "Nothing to scan in for right now"],
  [{ error: "Attendance is already complete for this member and meeting", code: "attendance_complete", reason: "already_done" }, "Already done", "You've already checked in and out of this meeting"],
  [{ error: "Attendance for Test Student begins on 2026-12-01", code: "participation_not_started", reason: "not_started_yet", startsOn: "2026-12-01", date: "Dec 1, 2026" }, "Not started yet", "Your attendance begins on Dec 1, 2026"],
];
const scan: AttendanceScan = { eventId: "event-1", memberId: "1001", occurredAt: "2026-11-18T20:00:00.000Z", pairingId: "pairing-1", rescanSupported: true };
const codeScan: DiscordCodeScan = { eventId: "event-1", discordCode: "804615", occurredAt: "2026-11-18T20:00:00.000Z", pairingId: "pairing-1", rescanSupported: true };
const answer = (body: unknown, status = 409, sent: AttendanceScan | DiscordCodeScan = scan) => deliverScan({ baseUrl: "/api", token: "test-token", fetchImpl: (async () => Response.json(body, { status })) as unknown as typeof fetch }, sent);
const member = { memberId: "1001", firstName: "Test Student", lastName: "A" };
const shown = (display: { id: string; message: string; detail: string; tone: string; durationMs?: number }) => [display.id, display.message, display.detail, display.tone, display.durationMs];

test("each refusal reason shows its headline and second line as a notice for five seconds", async () => {
  for (const [body, message, detail] of refusals) {
    const outcome = await answer(body);
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind !== "rejected") continue;
    assert.deepEqual([outcome.status, outcome.code, outcome.message], [409, body.code, body.error], "the status, code and text stay as they were");
    // A PIN scan and a scan the queue settled while the member waited both end at displayForScanFate.
    assert.deepEqual(shown(displayForScanFate(outcome, member)), ["scan_notice", message, detail, "notice", 5000], String(body.reason));
    // A Discord code scan.
    assert.deepEqual(shown(displayForCodeScan(await answer(body, 409, codeScan))), ["scan_notice", message, detail, "notice", 5000], String(body.reason));
    // The result step keeps the display, so the page's timer uses its five seconds.
    const result = flowReducer({ step: "sending", member }, { type: "sent", display: displayForScanFate(outcome, member) });
    assert.equal(result.step === "result" && result.display.durationMs, 5000);
    assert.deepEqual(flowReducer(result, { type: "done" }), { step: "entry", text: "" } satisfies Flow);
  }
});

test("a scan refused through the offline queue shows the reason too, and its review record is unchanged", async () => {
  const queue = createMemoryQueue(); const refused = createMemoryRefusedStore();
  const sync = createScanSync({ queue, refused, send: async () => answer(refusals[1]![0]), now: () => Date.parse("2026-11-19T02:00:00.000Z") });
  await sync.enqueue({ eventId: "event-1", memberId: "1001", occurredAt: "2026-11-19T02:00:00.000Z", pairingId: "pairing-1", queuedAt: "2026-11-19T02:00:00.000Z" });
  assert.deepEqual(await sync.sync(), { delivered: 0, pending: 0 });
  assert.deepEqual(shown(displayForScanFate(sync.fate("event-1")!, member)), ["scan_notice", "Meeting ended", "Scans for Test meeting A closed at 8:30 PM", "notice", 5000]);
  assert.deepEqual((await refused.list()).map((item) => [item.eventId, item.reasonCode, item.httpStatus, item.message]), [["event-1", "no_eligible_meeting", 409, noMeeting.error]]);
});

test("a Worker that sends no reason, or one this kiosk does not know, keeps the screens it has today", async () => {
  const older = await answer(noMeeting);
  assert.deepEqual(older, { kind: "rejected", status: 409, code: "no_eligible_meeting", message: noMeeting.error } satisfies SendOutcome);
  assert.deepEqual(shown(displayForScanFate(older)), ["rejected", "No meeting right now", noMeeting.error, "error", 3500]);
  const complete = await answer({ error: "Attendance is already complete for this member and meeting", code: "attendance_complete" });
  assert.deepEqual(shown(displayForScanFate(complete)), ["duplicate", "Already recorded", "Your attendance for this meeting is already complete.", "notice", 2200]);
  const notStarted = await answer({ error: "Attendance for Test Student begins on 2026-12-01", code: "participation_not_started" });
  assert.deepEqual(shown(displayForScanFate(notStarted)), ["rejected", "Scan needs help", "Attendance for Test Student begins on 2026-12-01", "error", 3500]);
  // A reason from a newer Worker, or one missing the details its wording needs.
  for (const body of [{ ...noMeeting, reason: "something_new" }, { ...noMeeting, reason: "too_early", meetingTitle: "Test meeting A" }]) {
    const outcome = await answer(body);
    assert.equal(outcome.kind === "rejected" && outcome.refusal, undefined);
    assert.equal(displayForScanFate(outcome).message, "No meeting right now");
  }
  // Genuine problems are not notices, whatever else the body says.
  assert.equal(displayForAttendanceError(undefined).message, "Couldn't reach the server");
  const unknown = await answer({ error: "This identity is not linked to an active roster member", code: "roster_inactive" }, 404);
  assert.deepEqual(shown(displayForScanFate(unknown)).slice(0, 2), ["unknown", "Member ID not recognized"]);
});

test("the result screen draws a notice with the warning ring, not the error one", async () => {
  const css = await readFile(new URL("../apps/dashboard/src/web-kiosk/web-kiosk.css", import.meta.url), "utf8");
  assert.match(css, /\.wk-ring-notice, \.wk-ring-offline \{ border-color: var\(--ui-warning\);/);
  assert.match(css, /\.wk-ring-error \{ border-color: var\(--ui-error\);/);
  const parts = await readFile(new URL("../apps/dashboard/src/web-kiosk/kiosk-parts.tsx", import.meta.url), "utf8");
  assert.match(parts, /data-tone=\{display\.tone\} data-state=\{display\.id\}/);
  assert.match(parts, /wk-ring-\$\{display\.tone\}/);
});

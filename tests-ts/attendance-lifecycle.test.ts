import test from "node:test";
import assert from "node:assert/strict";
import { attendanceAnomalyMinutes, attendanceClosesAt, attendanceDisposition, attendanceOpensAt, meanAnomalousMinutes, newlyOverlappingMeetingWindows, nextAttendanceAction, overlappingMeetingWindows, scanMeetingFor, scanWindowState } from "../apps/api/src/attendance-lifecycle.ts";

test("organization late-scan setting determines one meeting cutoff", () => {
  assert.equal(attendanceClosesAt("2026-09-01T22:00:00.000Z", 30), "2026-09-01T22:30:00.000Z");
  assert.deepEqual(scanWindowState({ startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" }, "2026-09-01T22:29:59.000Z", 30), { accepted: true, closesAt: "2026-09-01T22:30:00.000Z" });
  assert.match(scanWindowState({ startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" }, "2026-09-01T22:30:00.001Z", 30).reason ?? "", /closed/);
});

test("meeting attendance windows include the organization late-scan allowance and may not overlap", () => {
  const meetings = [
    { id: "first", title: "Build", startsAt: "2026-09-01T18:00:00.000Z", endsAt: "2026-09-01T20:00:00.000Z" },
    { id: "second", title: "Rehearsal", startsAt: "2026-09-01T20:15:00.000Z", endsAt: "2026-09-01T21:00:00.000Z" },
  ];
  assert.deepEqual(overlappingMeetingWindows(meetings, 30, 0)?.map((meeting) => meeting.id), ["first", "second"]);
  assert.equal(overlappingMeetingWindows(meetings, 10, 0), undefined);
});

// A 6:00-8:00 PM (UTC) meeting; the defaults allow scans 15 minutes early and 30 minutes late.
const evening = { id: "evening", title: "Build", startsAt: "2026-09-01T18:00:00.000Z", endsAt: "2026-09-01T20:00:00.000Z" };

test("the early arrival allowance opens a meeting's scans before it starts", () => {
  assert.equal(attendanceOpensAt(evening.startsAt), "2026-09-01T17:45:00.000Z", "the default allowance is 15 minutes");
  assert.equal(attendanceOpensAt(evening.startsAt, 0), evening.startsAt);
  assert.throws(() => attendanceOpensAt(evening.startsAt, 181), /Early arrival allowance must be from 0 to 180 minutes/);
  assert.throws(() => attendanceOpensAt(evening.startsAt, 1.5), /0 to 180/);
  assert.deepEqual(scanWindowState(evening, "2026-09-01T17:45:00.000Z", 30, 15), { accepted: true, closesAt: "2026-09-01T20:30:00.000Z" }, "exactly when the early window opens");
  assert.deepEqual(scanWindowState(evening, "2026-09-01T17:50:00.000Z", 30, 15), { accepted: true, closesAt: "2026-09-01T20:30:00.000Z" }, "inside the early window");
  assert.deepEqual(scanWindowState(evening, "2026-09-01T17:44:00.000Z", 30, 15), { accepted: false, reason: "This meeting has not started" }, "one minute before it opens");
  assert.deepEqual(scanWindowState(evening, "2026-09-01T17:44:59.999Z", 30, 15), { accepted: false, reason: "This meeting has not started" });
  assert.deepEqual(scanWindowState(evening, "2026-09-01T17:59:00.000Z", 30, 0), { accepted: false, reason: "This meeting has not started" }, "no allowance keeps the old rule");
  assert.equal(scanWindowState(evening, "2026-09-01T17:46:00.000Z").accepted, true, "the default allowance applies when none is given");
});

test("an early arrival keeps its own time and is never a late arrival", () => {
  const early = { ...evening, checkedInAt: "2026-09-01T17:50:00.000Z", checkedOutAt: "2026-09-01T20:00:00.000Z" };
  assert.deepEqual(attendanceAnomalyMinutes(early, 0, 0), {}, "ten minutes early is not late, even with a zero limit");
  assert.equal(meanAnomalousMinutes([early], 0, 0), null);
  assert.deepEqual(attendanceAnomalyMinutes({ ...early, checkedInAt: "2026-09-01T18:12:00.000Z" }, 10, 10), { lateMinutes: 12 });
});

test("attendance windows overlap through the early arrival allowance", () => {
  // The next meeting starts 40 minutes after the first ends: clear of a 30-minute late window, not of 15 minutes early.
  const next = { id: "next", title: "Rehearsal", startsAt: "2026-09-01T20:40:00.000Z", endsAt: "2026-09-01T21:30:00.000Z" };
  assert.equal(overlappingMeetingWindows([evening, next], 30, 0), undefined);
  assert.deepEqual(overlappingMeetingWindows([evening, next], 30, 15)?.map((meeting) => meeting.id), ["evening", "next"]);
  assert.deepEqual(overlappingMeetingWindows([next, evening])?.map((meeting) => meeting.id), ["evening", "next"], "the defaults include 15 minutes early");
  assert.deepEqual(overlappingMeetingWindows([evening, next], 30, 10)?.map((meeting) => meeting.id), ["evening", "next"], "a window opening the moment the other closes overlaps it");
  assert.equal(overlappingMeetingWindows([evening, next], 30, 9), undefined, "a window opening a minute after the other closes does not");
});

test("only conflicts with the meetings being saved refuse a save", () => {
  // Two meetings saved before the early arrival allowance existed now overlap by it; saving a third, clear one is allowed.
  const legacyA = { id: "legacy-a", title: "Legacy A", startsAt: "2026-09-01T18:00:00.000Z", endsAt: "2026-09-01T20:00:00.000Z" };
  const legacyB = { id: "legacy-b", title: "Legacy B", startsAt: "2026-09-01T20:40:00.000Z", endsAt: "2026-09-01T21:00:00.000Z" };
  const proposed = { id: "proposed", title: "Proposed", startsAt: "2026-09-01T23:00:00.000Z", endsAt: "2026-09-02T00:00:00.000Z" };
  const isProposed = (meeting: { id?: string }) => meeting.id === "proposed";
  const conflict = (candidate: typeof proposed) => overlappingMeetingWindows([legacyA, legacyB, candidate], 30, 15, isProposed)?.map((meeting) => meeting.id);
  assert.deepEqual(overlappingMeetingWindows([legacyA, legacyB, proposed])?.map((meeting) => meeting.id), ["legacy-a", "legacy-b"], "the existing pair overlaps");
  assert.equal(conflict(proposed), undefined);
  // A proposed meeting that overlaps an existing one is named with it, whichever window opens first.
  assert.deepEqual(conflict({ ...proposed, startsAt: "2026-09-01T21:30:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" }), ["legacy-b", "proposed"]);
  assert.deepEqual(conflict({ ...proposed, startsAt: "2026-09-01T18:30:00.000Z", endsAt: "2026-09-01T19:00:00.000Z" }), ["legacy-a", "proposed"]);
  assert.deepEqual(conflict({ ...proposed, startsAt: "2026-09-01T16:00:00.000Z", endsAt: "2026-09-01T17:40:00.000Z" }), ["proposed", "legacy-a"]);
  // Proposed meetings (a recurring series) still may not overlap each other.
  const second = { ...proposed, id: "proposed-2", startsAt: "2026-09-01T23:30:00.000Z", endsAt: "2026-09-02T00:30:00.000Z" };
  assert.deepEqual(overlappingMeetingWindows([legacyA, legacyB, proposed, second], 30, 15, (meeting) => meeting.id.startsWith("proposed"))?.map((meeting) => meeting.id), ["proposed", "proposed-2"]);
});

test("a longer allowance is refused only for the overlaps it creates", () => {
  const a = { id: "a", title: "A", startsAt: "2026-09-01T18:00:00.000Z", endsAt: "2026-09-01T20:00:00.000Z" };
  const b = { id: "b", title: "B", startsAt: "2026-09-01T21:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" };
  const c = { id: "c", title: "C", startsAt: "2026-09-01T22:40:00.000Z", endsAt: "2026-09-01T23:00:00.000Z" };
  const defaults = { lateScanMinutes: 30, earlyScanMinutes: 15 };
  // B and C already overlap under the defaults (saved before the early arrival allowance existed).
  assert.deepEqual(overlappingMeetingWindows([b, c])?.map((meeting) => meeting.id), ["b", "c"]);
  assert.equal(newlyOverlappingMeetingWindows([a, b, c], defaults, { lateScanMinutes: 30, earlyScanMinutes: 25 }), undefined, "only B and C overlap, as before");
  assert.deepEqual(newlyOverlappingMeetingWindows([c, b, a], defaults, { lateScanMinutes: 30, earlyScanMinutes: 30 })?.map((meeting) => meeting.id), ["a", "b"], "A's late window now reaches B's early one");
  assert.deepEqual(newlyOverlappingMeetingWindows([a, b, c], defaults, { lateScanMinutes: 45, earlyScanMinutes: 15 })?.map((meeting) => meeting.id), ["a", "b"]);
  assert.equal(newlyOverlappingMeetingWindows([a, b, c], defaults, defaults), undefined);
});

test("a scan in both an earlier meeting's late window and the next meeting's early window goes to the earlier meeting", () => {
  // Saved before the early arrival allowance: Build's scans close at 8:30 PM and Rehearsal's open at 8:25 PM.
  const build = { id: "build", title: "Build", startsAt: "2026-09-01T18:00:00.000Z", endsAt: "2026-09-01T20:00:00.000Z" };
  const rehearsal = { id: "rehearsal", title: "Rehearsal", startsAt: "2026-09-01T20:40:00.000Z", endsAt: "2026-09-01T22:00:00.000Z" };
  const resolve = (occurredAt: string, candidates = [build, rehearsal]) => scanMeetingFor(candidates, occurredAt, 30, 15)?.id;
  assert.equal(resolve("2026-09-01T20:27:00.000Z"), "build", "in both windows: the meeting in its late scan window keeps the scan");
  assert.equal(resolve("2026-09-01T20:27:00.000Z", [rehearsal, build]), "build", "whatever order the candidates come in");
  assert.equal(resolve("2026-09-01T20:30:00.000Z"), "build", "the last moment of the late window");
  assert.equal(resolve("2026-09-01T20:30:00.001Z"), "rehearsal", "after the late window, the next meeting's early window takes it");
  assert.equal(resolve("2026-09-01T19:00:00.000Z"), "build");
  assert.equal(resolve("2026-09-01T20:45:00.000Z"), "rehearsal", "after the next meeting starts");
  // Without an overlap, an early arrival goes to the next meeting; a scan between windows stays with the earlier meeting,
  // so the caller refuses it as before.
  const later = { ...rehearsal, startsAt: "2026-09-01T21:30:00.000Z" };
  assert.equal(resolve("2026-09-01T21:15:00.000Z", [build, later]), "rehearsal");
  assert.equal(resolve("2026-09-01T21:14:59.000Z", [build, later]), "build");
  assert.equal(resolve("2026-09-01T17:50:00.000Z", [build]), "build", "only a meeting yet to start, inside its early window");
  assert.equal(resolve("2026-09-01T17:40:00.000Z", [build]), undefined, "only a meeting yet to start, before its early window");
  assert.equal(resolve("2026-09-01T17:40:00.000Z", []), undefined);
});

test("one scan pair transitions from absent through active to present", () => {
  assert.deepEqual(nextAttendanceAction([], "2026-09-01T20:00:00.000Z"), { status: "accepted", action: "check_in" });
  const events = [{ id: "one", action: "check_in" as const, occurredAt: "2026-09-01T20:00:00.000Z" }];
  assert.equal(attendanceDisposition(events), "active");
  assert.equal(nextAttendanceAction(events, "2026-09-01T20:00:30.000Z").status, "duplicate");
  assert.deepEqual(nextAttendanceAction(events, "2026-09-01T20:02:00.000Z"), { status: "accepted", action: "check_out" });
  const closed = [...events, { id: "two", action: "check_out" as const, occurredAt: "2026-09-01T20:02:00.000Z" }];
  assert.equal(attendanceDisposition(closed), "present");
  assert.equal(nextAttendanceAction(closed, "2026-09-01T21:00:00.000Z").status, "complete");
});

test("audited corrections override scan-derived status", () => {
  assert.equal(attendanceDisposition([{ action: "check_in" }], "excused"), "excused");
  assert.equal(attendanceDisposition([], "present"), "present");
});

test("anomalous scan values are averaged separately above the configured thresholds", () => {
  const rows = [
    { startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T22:00:00.000Z", checkedInAt: "2026-09-01T20:12:00.000Z", checkedOutAt: "2026-09-01T21:42:00.000Z" },
    { startsAt: "2026-09-02T20:00:00.000Z", endsAt: "2026-09-02T22:00:00.000Z", checkedInAt: "2026-09-02T20:10:00.000Z" },
  ];
  assert.equal(meanAnomalousMinutes(rows, 10, 10), 15);
  assert.equal(meanAnomalousMinutes([{ ...rows[0], checkedInAt: "2026-09-01T20:10:00.000Z", checkedOutAt: undefined }], 10, 10), null);
  assert.equal(meanAnomalousMinutes([{ ...rows[0], checkedOutAt: undefined }], 10, 10), 12);
  assert.equal(meanAnomalousMinutes([], 10, 10), null);
  assert.throws(() => meanAnomalousMinutes(rows, -1, 10), /0 to 1440/);
});

test("attendance anomaly values preserve separate raw late and early durations", () => {
  const row = { startsAt: "2026-09-01T20:00:00.000Z", endsAt: "2026-09-01T21:00:00.000Z", checkedInAt: "2026-09-01T20:12:30.000Z", checkedOutAt: "2026-09-01T20:42:45.000Z" };
  assert.deepEqual(attendanceAnomalyMinutes(row, 10, 10), { lateMinutes: 12.5, earlyMinutes: 17.25 });
  assert.deepEqual(attendanceAnomalyMinutes({ ...row, checkedInAt: "2026-09-01T20:10:00.000Z", checkedOutAt: "2026-09-01T20:50:00.000Z" }, 10, 10), {});
  assert.deepEqual(attendanceAnomalyMinutes({ ...row, checkedOutAt: undefined }, 10, 10), { lateMinutes: 12.5 });
});

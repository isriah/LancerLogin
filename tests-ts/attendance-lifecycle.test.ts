import test from "node:test";
import assert from "node:assert/strict";
import { attendanceClosesAt, attendanceDisposition, nextAttendanceAction, overlappingMeetingWindows, scanWindowState } from "../apps/api/src/attendance-lifecycle.ts";

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
  assert.deepEqual(overlappingMeetingWindows(meetings, 30)?.map((meeting) => meeting.id), ["first", "second"]);
  assert.equal(overlappingMeetingWindows(meetings, 10), undefined);
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

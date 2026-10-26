import test from "node:test";
import assert from "node:assert/strict";
import { formForMeeting, initialMeetingForm, meetingDurationMinutes, meetingTimestamps, moveMeetingStart } from "../apps/dashboard/src/meeting-form.ts";
import { calendarMonth, readCalendarSelection, selectionForDate } from "../apps/dashboard/src/calendar-selection.ts";

const local = (value: string) => new Date(value).toISOString();
const meeting = (start: string, end: string) => ({ id: "synthetic-meeting", title: "Synthetic planning", startsAt: local(start), endsAt: local(end), attendanceClosesAt: local(end), required: true, notes: "Synthetic notes" });

test("title-only edits retain the complete overnight interval and timestamp precision", () => {
  const source = meeting("2026-10-20T23:31:28.123", "2026-10-21T02:32:28.123");
  const form = formForMeeting(source);
  assert.equal(form.date, "2026-10-20"); assert.equal(form.endDate, "2026-10-21");
  assert.deepEqual(meetingTimestamps({ ...form, title: "New title", notes: "New notes" }), { startsAt: source.startsAt, endsAt: source.endsAt });
  assert.equal(meetingDurationMinutes(form), 181);
});

test("date changes retain a chosen duration and start changes move both endpoints", () => {
  const source = formForMeeting(meeting("2026-10-20T13:02", "2026-10-20T14:02"));
  const nextDate = moveMeetingStart(source, { date: "2026-11-10" });
  assert.deepEqual([nextDate.date, nextDate.startTime, nextDate.endDate, nextDate.endTime], ["2026-11-10", "13:02", "2026-11-10", "14:02"]);
  const custom = { ...nextDate, endTime: "14:37" };
  const nextStart = moveMeetingStart(custom, { startTime: "23:30" });
  assert.deepEqual([nextStart.date, nextStart.startTime, nextStart.endDate, nextStart.endTime], ["2026-11-10", "23:30", "2026-11-11", "01:05"]);
  assert.equal(meetingDurationMinutes(nextStart), 95);
});

test("overnight and multi-day meetings retain duration when moved or duplicated", () => {
  for (const end of ["2026-10-21T02:32", "2026-10-22T02:32"]) {
    const source = meeting("2026-10-20T23:31", end); const form = formForMeeting(source); const duration = meetingDurationMinutes(form);
    const moved = moveMeetingStart(form, { date: "2026-12-20", startTime: "22:00" });
    assert.equal(meetingDurationMinutes(moved), duration);
    assert.equal(meetingDurationMinutes(formForMeeting(source, true)), duration);
    assert.notEqual(formForMeeting(source, true).endDate, formForMeeting(source, true).date);
  }
});

test("cleared date input can recover using the last valid duration without inventing a new duration", () => {
  const form = formForMeeting(meeting("2026-10-20T13:00", "2026-10-20T14:00")); const duration = meetingDurationMinutes(form);
  const cleared = moveMeetingStart(form, { date: "" });
  assert.equal(cleared.date, ""); assert.ok(Number.isNaN(meetingDurationMinutes(cleared)));
  const restored = moveMeetingStart(cleared, { date: "2026-10-22" }, duration);
  assert.equal(restored.endTime, "14:00"); assert.equal(restored.endDate, "2026-10-22");
  const invalidEnd = { ...form, endTime: "12:00" };
  assert.equal(meetingDurationMinutes(invalidEnd), -60);
});

test("the new meeting default spans midnight instead of truncating its 150-minute duration", context => {
  context.mock.method(Date, "now", () => Date.parse("2026-10-20T22:30:00"));
  const form = initialMeetingForm();
  assert.deepEqual([form.date, form.startTime, form.endDate, form.endTime], ["2026-10-20", "23:30", "2026-10-21", "02:00"]);
  assert.equal(meetingDurationMinutes(form), 150);
});

test("calendar selection restores the real selected month after the current month changes", () => {
  const saved = JSON.stringify({ month: "2026-09-01", selectedDate: "2026-09-20" });
  assert.deepEqual(readCalendarSelection("2026-10-19", saved), { offset: -1, selectedDate: "2026-09-20" });
  const restored = readCalendarSelection("2027-01-02", saved);
  assert.deepEqual(restored, { offset: -4, selectedDate: "2026-09-20" });
  assert.equal(calendarMonth("2027-01-02", restored.offset), "2026-09-01");
  assert.deepEqual(selectionForDate("2026-12-15", "2027-01-01"), { offset: 1, selectedDate: "2027-01-01" });
});

test("invalid stored calendar state falls back to today", () => {
  for (const saved of [null, "{", "[]", JSON.stringify({ month: "2026-09-01", selectedDate: "2026-10-20" }), JSON.stringify({ month: "2026-02-01", selectedDate: "2026-02-31" }), "x".repeat(257)]) assert.deepEqual(readCalendarSelection("2026-10-19", saved), { offset: 0, selectedDate: "2026-10-19" });
});

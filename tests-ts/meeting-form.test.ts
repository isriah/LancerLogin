import test from "node:test";
import assert from "node:assert/strict";
import { formForMeeting, initialMeetingForm, meetingClockMinutes, meetingDurationMinutes, meetingTimestamps, moveMeetingStart } from "../apps/dashboard/src/meeting-form.ts";
import { calendarMonth, readCalendarSelection, selectionForDate, selectionForMonth } from "../apps/dashboard/src/calendar-selection.ts";

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

test("overnight and multi-day meetings retain duration when moved or duplicated", context => {
  // Duplicates land on today; pin it so a run near a daylight-saving change cannot end in a repeated hour.
  context.mock.method(Date, "now", () => Date.parse("2026-10-20T12:00:00"));
  for (const end of ["2026-10-21T02:32", "2026-10-22T02:32"]) {
    const source = meeting("2026-10-20T23:31", end); const form = formForMeeting(source); const duration = meetingDurationMinutes(form);
    const moved = moveMeetingStart(form, { date: "2026-12-20", startTime: "22:00" });
    assert.equal(meetingDurationMinutes(moved), duration);
    assert.equal(meetingDurationMinutes(formForMeeting(source, true)), duration);
    assert.notEqual(formForMeeting(source, true).endDate, formForMeeting(source, true).date);
  }
});

test("moving or duplicating across a daylight-saving change keeps clock times, not elapsed hours", context => {
  const zone = process.env.TZ;
  // Synthetic overnight meeting, 7 PM to 9 AM local; New York falls back on 2026-11-01.
  const source = meeting("2026-10-24T19:00", "2026-10-25T09:00"); const form = formForMeeting(source);
  const across = moveMeetingStart(form, { date: "2026-10-31" });
  assert.deepEqual([across.date, across.startTime, across.endDate, across.endTime], ["2026-10-31", "19:00", "2026-11-01", "09:00"]);
  assert.equal(meetingClockMinutes(across), 14 * 60);
  if (zone === "America/New_York") assert.equal(meetingDurationMinutes(across), 15 * 60, "that night is an hour longer");
  context.mock.method(Date, "now", () => Date.parse("2026-10-31T12:00:00"));
  const duplicate = formForMeeting(source, true);
  assert.deepEqual([duplicate.date, duplicate.startTime, duplicate.endDate, duplicate.endTime], ["2026-10-31", "19:00", "2026-11-01", "09:00"]);
  // A meeting ending inside the repeated hour keeps that clock time; it resolves to the first 1 AM.
  const late = moveMeetingStart(formForMeeting(meeting("2026-10-24T22:00", "2026-10-25T01:30")), { date: "2026-10-31" });
  assert.deepEqual([late.endDate, late.endTime], ["2026-11-01", "01:30"]);
  assert.equal(late.endsAt, new Date("2026-11-01T01:30").toISOString());
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

test("a new meeting pre-fills the calendar's selected day at the usual next-hour start", context => {
  context.mock.method(Date, "now", () => Date.parse("2026-10-20T13:15:00"));
  const form = initialMeetingForm("2026-11-03");
  assert.deepEqual([form.date, form.startTime, form.endDate, form.endTime], ["2026-11-03", "14:15", "2026-11-03", "16:45"]);
  assert.equal(meetingDurationMinutes(form), 150);
  assert.deepEqual(initialMeetingForm("2026-10-20"), initialMeetingForm());
});

test("a selected today keeps the default that can roll a late start into tomorrow", context => {
  context.mock.method(Date, "now", () => Date.parse("2026-10-20T23:30:00"));
  const form = initialMeetingForm("2026-10-20");
  assert.deepEqual([form.date, form.startTime, form.endDate, form.endTime], ["2026-10-21", "00:30", "2026-10-21", "03:00"]);
  const later = initialMeetingForm("2026-10-24");
  assert.deepEqual([later.date, later.startTime, later.endDate, later.endTime], ["2026-10-24", "00:30", "2026-10-24", "03:00"]);
});

test("changing months selects the 1st of the new month, or today back on the current month", () => {
  assert.deepEqual(selectionForMonth("2026-10-19", 1), { offset: 1, selectedDate: "2026-11-01" });
  assert.deepEqual(selectionForMonth("2026-10-19", -1), { offset: -1, selectedDate: "2026-09-01" });
  assert.deepEqual(selectionForMonth("2026-12-31", 2), { offset: 2, selectedDate: "2027-02-01" });
  assert.deepEqual(selectionForMonth("2026-10-19", 0), { offset: 0, selectedDate: "2026-10-19" });
});

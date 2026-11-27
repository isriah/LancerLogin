import test from "node:test";
import assert from "node:assert/strict";
import { attendanceDisableCalendarText, readAttendanceDisableCalendar } from "../apps/dashboard/src/attendance-disable-calendar.ts";

// The sentences the Attendance disable confirmation in Settings > Modules adds about Google Calendar and Discord.

const counts = (google?: [number, number], discord?: [number, number]) => ({ attendanceDisableCalendar: { ...(google ? { google_calendar: { waitingRemovals: google[0], upcomingEvents: google[1] } } : {}), ...(discord ? { discord: { waitingRemovals: discord[0], upcomingEvents: discord[1] } } : {}) } });
const text = (value: unknown) => attendanceDisableCalendarText(readAttendanceDisableCalendar(value));

test("nothing left behind adds nothing, so the confirmation reads as before", () => {
  assert.deepEqual(text(counts([0, 0], [0, 0])), []);
  assert.deepEqual(text(counts()), []);
  assert.deepEqual(text({ revision: 1 }), [], "an answer without the counts");
  assert.deepEqual(text(undefined), []);
});

test("waiting removals are named per provider, with singular and plural right", () => {
  assert.deepEqual(text(counts([3, 0], [2, 0])), ["3 Google Calendar events and 2 Discord events are waiting to be removed. They are removed if Attendance is enabled again within 7 days; after that they must be deleted by hand."]);
  assert.deepEqual(text(counts([1, 0])), ["1 Google Calendar event is waiting to be removed. It is removed if Attendance is enabled again within 7 days; after that it must be deleted by hand."]);
  assert.deepEqual(text(counts([0, 0], [1, 0])), ["1 Discord event is waiting to be removed. It is removed if Attendance is enabled again within 7 days; after that it must be deleted by hand."]);
  assert.deepEqual(text(counts([1, 0], [1, 0])), ["1 Google Calendar event and 1 Discord event are waiting to be removed. They are removed if Attendance is enabled again within 7 days; after that they must be deleted by hand."]);
  assert.deepEqual(text(counts(undefined, [4, 0])), ["4 Discord events are waiting to be removed. They are removed if Attendance is enabled again within 7 days; after that they must be deleted by hand."], "a provider that is not connected is not named");
});

test("events of current and upcoming meetings that disabling leaves in place are said too", () => {
  assert.deepEqual(text(counts([0, 5], [0, 3])), ["Disabling does not remove 5 Google Calendar events and 3 Discord events for current and upcoming meetings. If Attendance is not enabled again within 7 days, LancerLogin stops tracking them, and they must be deleted by hand."]);
  assert.deepEqual(text(counts([0, 1])), ["Disabling does not remove 1 Google Calendar event for a current or upcoming meeting. If Attendance is not enabled again within 7 days, LancerLogin stops tracking it, and it must be deleted by hand."]);
  assert.deepEqual(text(counts([2, 1], [0, 0])), [
    "2 Google Calendar events are waiting to be removed. They are removed if Attendance is enabled again within 7 days; after that they must be deleted by hand.",
    "Disabling does not remove 1 Google Calendar event for a current or upcoming meeting. If Attendance is not enabled again within 7 days, LancerLogin stops tracking it, and it must be deleted by hand.",
  ]);
});

test("malformed counts are not read", () => {
  assert.equal(readAttendanceDisableCalendar({ attendanceDisableCalendar: { google_calendar: { waitingRemovals: -1, upcomingEvents: 0 } } }), undefined);
  assert.equal(readAttendanceDisableCalendar({ attendanceDisableCalendar: { discord: { waitingRemovals: "3", upcomingEvents: 0 } } }), undefined);
  assert.equal(readAttendanceDisableCalendar({ attendanceDisableCalendar: [] }), undefined);
  assert.deepEqual(readAttendanceDisableCalendar({ attendanceDisableCalendar: { other: { waitingRemovals: 9, upcomingEvents: 9 } } }), {}, "an unknown provider is ignored");
});

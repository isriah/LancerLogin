import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAttendance, evaluateAttendanceKept } from "../apps/api/src/attendance-policy.ts";
import { team } from "./fixtures/attendance-team.ts";

const now = "2026-11-20T18:00:00.000Z";
/** A small team, plus one required meeting for everyone that started an hour ago and closes in 90 minutes, which every member attended. */
const data = () => {
  const source = team({ seed: 7, members: 12, labels: 4, meetings: 40, now, irregular: true });
  const open = { ...source.meetings[0], id: "test-open-meeting", title: "Test open meeting", startsAt: "2026-11-20T17:00:00.000Z", endsAt: "2026-11-20T19:00:00.000Z", attendanceClosesAt: "2026-11-20T19:30:00.000Z", required: 1, audienceMode: "all" as const, audienceLabelIds: [], isTest: 0 };
  return { ...source, meetings: [...source.meetings, open], observations: [...source.observations, ...source.members.map((member) => ({ meetingId: open.id, memberId: member.id, disposition: "present" as const, checkedInAt: "2026-11-20T17:01:00.000Z" }))] };
};
const at = (instant: number) => new Date(instant).toISOString();

test("a kept evaluation equals a fresh one and is reused while nothing it depends on changes", () => {
  const source = data();
  const kept = evaluateAttendanceKept(source, "official", undefined, now);
  assert.deepEqual(kept, evaluateAttendance({ ...source, now }));
  assert.equal(evaluateAttendanceKept(source, "official", undefined, now), kept, "same instant");
  // A moment later, before any meeting closes and on the same local date.
  const nextClose = Math.min(...source.meetings.map((meeting) => Date.parse(meeting.attendanceClosesAt)).filter((closes) => closes > Date.parse(now)));
  const endOfDay = Date.parse("2026-11-20T23:59:59.000Z");
  const later = Math.min(nextClose - 1, endOfDay);
  assert.ok(later > Date.parse(now), "the fixture leaves time before the next change");
  assert.equal(evaluateAttendanceKept(source, "official", undefined, at(later)), kept);
  assert.deepEqual(kept, evaluateAttendance({ ...source, now: at(later) }), "and a fresh evaluation at that moment agrees");
  // Another loaded copy of the same data never shares it.
  assert.notEqual(evaluateAttendanceKept(data(), "official", undefined, now), kept);
});

test("a kept evaluation is dropped when a meeting closes, the local date changes or the clock is earlier", () => {
  const source = data();
  const open = source.meetings.map((meeting) => Date.parse(meeting.attendanceClosesAt)).filter((closes) => closes > Date.parse(now)).sort((a, b) => a - b);
  assert.ok(open.length > 0, "the fixture has a meeting still open");
  const kept = evaluateAttendanceKept(source, "official", undefined, now);
  const afterClose = evaluateAttendanceKept(source, "official", undefined, at(open[0]));
  assert.notEqual(afterClose, kept);
  assert.deepEqual(afterClose, evaluateAttendance({ ...source, now: at(open[0]) }));
  assert.notDeepEqual(afterClose, kept, "the closed meeting changes someone's result");
  assert.notEqual(evaluateAttendanceKept(source, "official", undefined, now), afterClose, "an earlier clock is not answered from a later evaluation");

  // The date alone: no meetings, so nothing closes, yet the recent window still moves with the day.
  const quiet = { ...data(), meetings: [], timeZone: "UTC" };
  const first = evaluateAttendanceKept(quiet, "official", undefined, "2026-11-20T23:59:00.000Z");
  assert.equal(evaluateAttendanceKept(quiet, "official", undefined, "2026-11-20T23:59:30.000Z"), first);
  const nextDay = evaluateAttendanceKept(quiet, "official", undefined, "2026-11-21T00:00:00.000Z");
  assert.notEqual(nextDay, first);
  assert.deepEqual(nextDay, evaluateAttendance({ ...quiet, now: "2026-11-21T00:00:00.000Z" }));
  // The organization's date, not UTC's: 23:30 UTC on the 20th is already the 21st in Auckland.
  const auckland = { ...quiet, timeZone: "Pacific/Auckland" };
  const evening = evaluateAttendanceKept(auckland, "official", undefined, "2026-11-20T10:30:00.000Z");
  assert.notEqual(evaluateAttendanceKept(auckland, "official", undefined, "2026-11-20T11:30:00.000Z"), evening, "midnight in Auckland is 11:00 UTC");
});

test("kept evaluations are separate for each key, and only a few are held", () => {
  const source = data();
  const official = evaluateAttendanceKept(source, "official", undefined, now);
  const period = evaluateAttendanceKept(source, "from", (same) => ({ ...same, from: "2026-06-01" }), now);
  assert.notEqual(period, official);
  assert.deepEqual(period, evaluateAttendance({ ...source, from: "2026-06-01", now }));
  assert.equal(evaluateAttendanceKept(source, "official", undefined, now), official);
  for (let extra = 0; extra < 3; extra += 1) evaluateAttendanceKept(source, `extra-${extra}`, (same) => ({ ...same, to: `2026-0${extra + 1}-01` }), now);
  assert.notEqual(evaluateAttendanceKept(source, "official", undefined, now), official, "the oldest entry made room");
  assert.deepEqual(evaluateAttendanceKept(source, "official", undefined, now), official);
});

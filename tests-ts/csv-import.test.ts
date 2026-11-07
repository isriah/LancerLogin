// The shared CSV import kit and the meeting CSV rules built on it. All data is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { csvText, formatCsvDate, formatCsvTime, formatCsvTimeRange, mapCsvHeader, normaliseCsvHeader, parseCsvDate, parseCsvDuration, parseCsvTime, parseDelimited } from "../apps/dashboard/src/csv-import.ts";
import { meetingCsvClock, meetingCsvTemplate, parseMeetingCsvText, resolveMeetingCsvRow } from "../packages/shared/src/meeting-csv.ts";
import { resolveCivilTime } from "../packages/shared/src/civil-time.ts";

const value = <T,>(result: { ok: true; value: T } | { ok: false; error: string }) => result.ok ? result.value : `error: ${result.error}`;

test("dates accept MM/DD/YYYY, M/D/YYYY and ISO, refuse day-first and impossible dates, and display as MM/DD/YYYY", () => {
  assert.equal(value(parseCsvDate("11/10/2026")), "2026-11-10");
  assert.equal(value(parseCsvDate("3/7/2026")), "2026-03-07");
  assert.equal(value(parseCsvDate(" 2026-11-10 ")), "2026-11-10");
  assert.equal(value(parseCsvDate("13/11/2026")), "error: 13/11/2026 looks like day/month. Use MM/DD/YYYY, such as 11/13/2026");
  assert.equal(value(parseCsvDate("02/30/2026")), "error: 02/30/2026 is not a real date");
  assert.equal(value(parseCsvDate("2026-02-30")), "error: 2026-02-30 is not a real date");
  assert.match(value(parseCsvDate("11/10/26")), /^error: 11\/10\/26 is not a date\. Use MM\/DD\/YYYY/);
  assert.match(value(parseCsvDate("")), /^error: Add a date/);
  assert.equal(formatCsvDate("2026-03-07"), "03/07/2026");
});

test("times accept 24-hour and AM/PM clocks", () => {
  for (const [input, expected] of [["18:00", "18:00"], ["9:05", "09:05"], ["18:00:00", "18:00"], ["6:00 PM", "18:00"], ["6pm", "18:00"], ["12:30 am", "00:30"], ["12 PM", "12:00"], ["6:15 p.m.", "18:15"]]) assert.equal(value(parseCsvTime(input)), expected, input);
  for (const input of ["24:00", "18:60", "13:00 PM", "0:30 AM", "18:00:30", "noon"]) assert.match(value(parseCsvTime(input)), /^error: .* is not a time/, input);
  assert.equal(formatCsvTime("00:30"), "12:30 AM"); assert.equal(formatCsvTime("18:05"), "6:05 PM");
  assert.equal(formatCsvTimeRange("18:00", "20:30"), "6:00–8:30 PM"); assert.equal(formatCsvTimeRange("10:00", "13:00"), "10:00 AM–1:00 PM");
});

test("durations accept minutes, H:MM and hour-minute units from one minute to a day", () => {
  for (const [input, expected] of [["90", 90], ["1:30", 90], ["1h30m", 90], ["1h 30m", 90], ["2h", 120], ["45m", 45], ["45 min", 45], ["1440", 1440]] as const) assert.equal(value(parseCsvDuration(input)), expected, input);
  for (const input of ["0", "1441", "25h"]) assert.equal(value(parseCsvDuration(input)), "error: Duration must be from 1 minute to 24 hours", input);
  for (const input of ["soon", "1:75", "h"]) assert.match(value(parseCsvDuration(input)), /is not a duration/, input);
});

test("headers normalise loosely and map through aliases, naming missing and duplicate columns", () => {
  assert.equal(normaliseCsvHeader("﻿ Start_Time "), "starttime");
  const spec = { aliases: { title: "title", name: "title", starttime: "start", start: "start", endtime: "end", duration: "duration" }, labels: { title: "Title", start: "Start time", end: "End time", duration: "Duration" }, required: ["title", "start", ["end", "duration"]] } as const;
  const result = mapCsvHeader(["Title", "Room", "Start time", "start", ""], spec as never);
  assert.deepEqual(result.columns, ["title", undefined, "start", undefined, undefined]);
  assert.deepEqual(result.ignored, ["Room"]);
  assert.deepEqual(result.errors, ['Columns "Start time" and "start" both match Start time. Keep only one.', "Missing column: End time or Duration"]);
  assert.deepEqual(parseDelimited('﻿a,"b, ""c"""\r\n\r\n1,2\n'), [["a", 'b, "c"'], ["1", "2"]]);
  assert.equal(csvText([["Title", "Notes"], ["Test", 'Say "hi", then go']]), 'Title,Notes\nTest,"Say ""hi"", then go"\n');
});

test("meeting CSV text maps friendly headers, keeps absent columns absent, and accepts template-order spreadsheet rows", () => {
  const parsed = parseMeetingCsvText("Meeting,Day,From,Length,Room\nTest Build Session,11/10/2026,18:00,90,Lab");
  assert.deepEqual(parsed.recognised, ["title", "date", "startTime", "duration"]); assert.deepEqual(parsed.ignored, ["Room"]); assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows, [{ rowNumber: 2, values: { title: "Test Build Session", date: "11/10/2026", startTime: "18:00", duration: "90" } }]);
  assert.deepEqual(parseMeetingCsvText("Title,Date,Start time\nTest,11/10/2026,18:00").errors, ["Missing column: End time or Duration"]);
  const pasted = parseMeetingCsvText("Test Drive Practice\t11/12/2026\t15:30\t17:30");
  assert.equal(pasted.hasHeader, false); assert.deepEqual(pasted.rows[0], { rowNumber: 1, values: { title: "Test Drive Practice", date: "11/12/2026", startTime: "15:30", endTime: "17:30" } });
});

test("meeting rows resolve in the organization time zone, overnight ends roll to the next day, and every problem is reported", () => {
  const evening = resolveMeetingCsvRow({ title: "Test Build Session", date: "11/10/2026", startTime: "6:00 PM", endTime: "20:30", attendance: "Optional", audience: "Test Label A; test label a;Test Label B", weight: "", notes: "" }, "America/Los_Angeles");
  assert.deepEqual(evening.meeting, { title: "Test Build Session", date: "2026-11-10", startTime: "18:00", endDate: "2026-11-10", endTime: "20:30", startsAt: "2026-11-11T02:00:00.000Z", endsAt: "2026-11-11T04:30:00.000Z", required: false, audienceNames: ["Test Label A", "Test Label B"], weightName: null, notes: null });
  const overnight = resolveMeetingCsvRow({ title: "Test Lock-in", date: "2026-11-10", startTime: "22:00", endTime: "02:00" }, "UTC");
  assert.equal(overnight.meeting!.endDate, "2026-11-11"); assert.equal(overnight.meeting!.endsAt, "2026-11-11T02:00:00.000Z"); assert.equal(overnight.meeting!.required, undefined, "an absent Attendance column");
  const duration = resolveMeetingCsvRow({ title: "Test Late", date: "2026-11-10", startTime: "23:30", duration: "1h" }, "UTC");
  assert.deepEqual([duration.meeting!.endDate, duration.meeting!.endTime], ["2026-11-11", "00:30"]);
  assert.deepEqual(resolveMeetingCsvRow({ title: "", date: "13/11/2026", startTime: "25:00", attendance: "maybe" }, "UTC").errors, ["Add a title", "13/11/2026 looks like day/month. Use MM/DD/YYYY, such as 11/13/2026", "25:00 is not a time. Use 24-hour HH:MM, such as 18:00, or h:mm AM/PM, such as 6:00 PM", "Add an end time or a duration", "Attendance must be Required or Optional, not maybe"]);
  assert.deepEqual(resolveMeetingCsvRow({ title: "Test", date: "2026-11-10", startTime: "18:00", endTime: "19:00", duration: "30" }, "UTC").errors, ["End time and Duration disagree. Keep one of them"]);
  assert.match(resolveMeetingCsvRow({ title: "Test", date: "03/08/2026", startTime: "02:30", duration: "30" }, "America/Los_Angeles").errors![0], /2:30 AM on 03\/08\/2026 in America\/Los_Angeles doesn't exist/);
  assert.match(resolveMeetingCsvRow({ title: "Test", date: "11/01/2026", startTime: "01:30", duration: "30" }, "America/Los_Angeles").errors![0], /happens twice/);
});

test("the memoised clock agrees with civil-time across daylight-saving changes, including half-hour zones", () => {
  for (const timeZone of ["America/Los_Angeles", "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata", "UTC"]) {
    const clock = meetingCsvClock(timeZone);
    for (let day = 0; day < 366; day += 3) for (const time of ["00:30", "01:30", "02:00", "02:15", "02:30", "03:00", "18:00"]) {
      const date = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
      const expected = resolveCivilTime({ date, time, timeZone }).map((candidate) => new Date(candidate.epochMilliseconds).toISOString());
      let actual: string[]; try { actual = [clock.instant(date, time)]; } catch (error) { actual = /twice/.test((error as Error).message) ? expected.length > 1 ? expected : ["twice"] : []; }
      assert.deepEqual(actual, expected, `${timeZone} ${date} ${time}`);
      if (expected.length === 1) assert.deepEqual(clock.civil(Date.parse(expected[0]!)), { date, time }, `${timeZone} ${date} ${time} back`);
    }
  }
});

test("the meeting template uses MM/DD/YYYY, obviously synthetic rows, and parses back without problems", () => {
  assert.equal(meetingCsvTemplate.split("\n")[0], "Title,Date,Start time,End time,Duration,Attendance,Audience labels,Weight category,Notes");
  const parsed = parseMeetingCsvText(meetingCsvTemplate);
  assert.deepEqual(parsed.errors, []);
  for (const row of parsed.rows) { assert.match(row.values.title!, /^Test /); assert.match(row.values.date!, /^\d{2}\/\d{2}\/\d{4}$/); assert.ok(resolveMeetingCsvRow(row.values, "UTC").meeting, row.values.title); }
});

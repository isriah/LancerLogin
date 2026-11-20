// Tab order inside native time fields: which Tab is ignored because typing had already moved to the next segment.
// tests-browser/meeting-time-tab.spec.ts checks the same order on the meeting form in a real browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { timeTabKey, timeTabStart, type TimeSegment, type TimeTabKey } from "../apps/dashboard/src/time-field-tab.ts";

const key = (name: string): TimeTabKey => name === "Shift+Tab" ? { key: "Tab", shiftKey: true } : { key: name };
// Press keys in a field and report the segment the field is on after each one, as the browser would have it.
function press(keys: string[], { twelveHour = true, from = "hour" as TimeSegment } = {}) {
  let state = timeTabStart(from); const ignored: number[] = []; const segments: TimeSegment[] = [];
  keys.forEach((name, index) => {
    const result = timeTabKey(state, key(name), twelveHour); state = result.state; if (result.ignore) ignored.push(index);
    segments.push(state.segment === "after-minute" ? twelveHour ? "period" : "minute" : state.segment);
  });
  return { ignored, segments };
}

test("Tab after a typed hour stays on the minutes, and after typed minutes stays on AM/PM", () => {
  // 9 completes the hour and 30 the minutes, so the field has already moved on when each Tab arrives.
  const typed = press(["9", "Tab", "3", "0", "Tab", "p", "Tab"]);
  assert.deepEqual(typed.segments, ["minute", "minute", "minute", "period", "period", "period", "picker"]);
  assert.deepEqual(typed.ignored, [1, 4]);
  // Two-digit hours move on at the second digit, and 2 to 9 complete a 12-hour hour on their own.
  assert.deepEqual(press(["1", "1", "Tab", "1", "5", "Tab", "a", "Tab"]).ignored, [2, 5]);
  assert.deepEqual(press(["0", "9", "Tab"]).segments, ["hour", "minute", "minute"]);
  for (const digit of ["2", "3", "4", "5", "6", "7", "8", "9"]) assert.deepEqual(press([digit, "Tab"]), { ignored: [1], segments: ["minute", "minute"] }, digit);
  // 6 to 9 complete the minutes on their own.
  for (const digit of ["6", "7", "8", "9"]) assert.deepEqual(press(["Tab", digit, "Tab"]), { ignored: [2], segments: ["minute", "period", "period"] }, digit);
});

test("Tab moves on when the typed digit left the segment open", () => {
  // 1 could become 10, 11 or 12 and 3 could become 30 to 39, so the field waits and Tab does the moving.
  const typed = press(["1", "Tab", "3", "Tab", "Tab"]);
  assert.deepEqual(typed.segments, ["hour", "minute", "minute", "period", "picker"]);
  assert.deepEqual(typed.ignored, []);
  assert.deepEqual(press(["0", "Tab"]), { ignored: [], segments: ["hour", "minute"] });
  for (const digit of ["0", "1", "2", "3", "4", "5"]) assert.deepEqual(press(["Tab", digit, "Tab"]).ignored, [], digit);
});

test("only the Tab directly after the completing digit is ignored", () => {
  assert.deepEqual(press(["9", "Tab", "Tab", "Tab"]).segments, ["minute", "minute", "period", "picker"]);
  assert.deepEqual(press(["9", "Tab", "Tab", "Tab"]).ignored, [1]);
  // Another key in between means the Tab is a deliberate one.
  for (const between of ["ArrowUp", "ArrowDown", "Backspace", "ArrowRight", "a"]) assert.deepEqual(press(["9", between, "Tab"]).ignored, [], between);
  // Holding Shift for a later Shift+Tab is not a key in between, and Shift+Tab itself is never ignored.
  assert.deepEqual(press(["9", "Shift", "Tab"]).ignored, [2]);
  assert.deepEqual(press(["9", "Shift+Tab"]), { ignored: [], segments: ["minute", "hour"] });
  assert.deepEqual(press(["9", "Tab", "3", "0", "Shift+Tab", "Shift+Tab"]).segments.slice(-3), ["period", "minute", "hour"]);
  // Shortcuts are left alone.
  assert.equal(timeTabKey(timeTabStart("hour"), { key: "9", ctrlKey: true }, true).state.segment, "hour");
  assert.deepEqual(timeTabKey({ segment: "minute", typed: "", advanced: true }, { key: "Tab", altKey: true }, true), { state: { segment: "minute", typed: "", advanced: false }, ignore: false });
});

test("Tab and Shift+Tab in an untouched field walk hour, minutes, AM/PM and the picker button in order", () => {
  // An empty field and a filled one are walked alike; nothing here depends on the value.
  assert.deepEqual(press(["Tab", "Tab", "Tab"]), { ignored: [], segments: ["minute", "period", "picker"] });
  assert.deepEqual(press(["Shift+Tab", "Shift+Tab", "Shift+Tab"], { from: "picker" }), { ignored: [], segments: ["period", "minute", "hour"] });
  // The arrow keys stop at AM/PM and never reach the picker button; up and down change the value, not the segment.
  assert.deepEqual(press(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft"]).segments, ["minute", "period", "period", "minute"]);
  assert.deepEqual(press(["ArrowLeft", "ArrowUp", "ArrowDown"]).segments, ["hour", "hour", "hour"]);
  assert.deepEqual(press(["ArrowLeft"], { from: "picker" }).segments, ["picker"]);
});

test("a 24-hour clock has no AM/PM segment to move on to", () => {
  // 2 waits for a second digit on a 24-hour clock and 3 does not; the minutes are the last segment.
  const typed = press(["2", "1", "Tab", "3", "0", "Tab"], { twelveHour: false });
  assert.deepEqual(typed.segments, ["hour", "minute", "minute", "minute", "minute", "picker"]);
  assert.deepEqual(typed.ignored, [2]);
  assert.deepEqual(press(["3", "Tab"], { twelveHour: false }).ignored, [1]);
  assert.deepEqual(press(["2", "Tab"], { twelveHour: false }), { ignored: [], segments: ["hour", "minute"] });
  assert.deepEqual(press(["2", "Tab"]).ignored, [1]);
  assert.deepEqual(press(["Tab", "Tab"], { twelveHour: false }).segments, ["minute", "picker"]);
  assert.deepEqual(press(["Shift+Tab", "Shift+Tab"], { twelveHour: false, from: "picker" }).segments, ["minute", "hour"]);
  assert.deepEqual(press(["ArrowRight", "ArrowRight"], { twelveHour: false }).segments, ["minute", "minute"]);
});

test("after a click, only digits that complete an hour and minutes alike are followed", () => {
  // A click can land on any segment. 6 to 9 and any second digit complete both the hour and the minutes; 2 to 5 do not.
  assert.deepEqual(press(["7", "Tab"], { from: "unknown" }).ignored, [1]);
  assert.deepEqual(press(["4", "5", "Tab"], { from: "unknown" }).ignored, [2]);
  assert.deepEqual(press(["4", "Tab"], { from: "unknown" }).ignored, []);
  assert.deepEqual(press(["1", "Tab"], { from: "unknown" }).ignored, []);
  assert.deepEqual(press(["Tab", "Shift+Tab"], { from: "unknown" }).segments, ["unknown", "unknown"]);
});

test("every Core time field uses the Tab handling and stays a native time input", async () => {
  const source = await readFile(new URL("../apps/dashboard/src/meeting-management.tsx", import.meta.url), "utf8");
  assert.match(source, /const startTab = useTimeFieldTab\(\); const endTab = useTimeFieldTab\(\);/);
  assert.match(source, /<label>Start time<input required type="time" value=\{value\.startTime\} \{\.\.\.startTab\} onChange=/);
  assert.match(source, /<label>End time<input required type="time" value=\{value\.endTime\} \{\.\.\.endTab\} onChange=/);
  assert.doesNotMatch(source, /tabIndex=\{?["']?[1-9]/);
  // A new time field elsewhere needs the same handling.
  const folder = new URL("../apps/dashboard/src/", import.meta.url);
  for (const file of (await readdir(folder)).filter((name) => name.endsWith(".tsx"))) {
    const text = await readFile(new URL(file, folder), "utf8"); const fields = text.match(/type="time"/g)?.length ?? 0;
    if (!fields) continue;
    assert.match(text, /import \{ useTimeFieldTab \} from "\.\/use-time-field-tab";/, file);
    assert.equal((text.match(/type="time"[^>]*\{\.\.\.\w+Tab\}/g) ?? []).length, fields, `${file} has ${fields} time fields; each needs useTimeFieldTab`);
  }
});

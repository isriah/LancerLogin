import test from "node:test";
import assert from "node:assert/strict";
import { countText, hoursMinutesAsMinutes, installationToday, lastMonthRange, latestTrendPoints, minutesAsHoursMinutes, reportColumnFilterText, reportExportFilename, reportFilterValueText, reportPeriodChoice, reportPeriodFromChoice } from "../apps/dashboard/src/report-view.ts";

test("a report's today is the installation's date, not the UTC date", () => {
  // Regression: 8:30 PM in New York on November 3 is already November 4 in UTC, so a new custom range started tomorrow.
  const evening = Date.parse("2026-11-04T01:30:00Z");
  assert.equal(installationToday("America/New_York", evening), "2026-11-03");
  assert.equal(installationToday("Pacific/Honolulu", evening), "2026-11-03");
  assert.equal(installationToday("UTC", evening), "2026-11-04");
  assert.equal(installationToday("Asia/Tokyo", Date.parse("2026-11-03T16:00:00Z")), "2026-11-04");
  assert.equal(installationToday("Not/AZone", evening), "2026-11-04");
});

test("Last month matches the API's whole previous calendar month, across years and month lengths", () => {
  assert.deepEqual(lastMonthRange("2026-11-04"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(lastMonthRange("2027-01-01"), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(lastMonthRange("2026-10-31"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(lastMonthRange("2027-03-31"), { from: "2027-02-01", to: "2027-02-28" });
  assert.deepEqual(lastMonthRange("2028-03-01"), { from: "2028-02-01", to: "2028-02-29" });
  // 11 PM in New York on October 31 is November 1 in UTC; the installation's last month is still September.
  assert.deepEqual(lastMonthRange(installationToday("America/New_York", Date.parse("2026-11-01T03:00:00Z"))), { from: "2026-09-01", to: "2026-09-30" });
});

test("Last 10 selects the newest eligible meetings and plots them oldest to newest", () => {
  const newestFirst = Array.from({ length: 15 }, (_, index) => ({ meetingId: String(15 - index), startsAt: `2026-09-${String(15 - index).padStart(2, "0")}T12:00:00Z` }));
  const before = structuredClone(newestFirst);
  assert.deepEqual(latestTrendPoints(newestFirst, 10).map((point) => point.meetingId), ["6", "7", "8", "9", "10", "11", "12", "13", "14", "15"]);
  assert.deepEqual(newestFirst, before);
  assert.deepEqual(latestTrendPoints([newestFirst[5], newestFirst[0], newestFirst[14]], 2).map((point) => point.meetingId), ["10", "15"]);
  assert.deepEqual(latestTrendPoints([], 10), []);
});

test("CSV filenames identify the report, export type and date without path characters", () => {
  const date = new Date("2026-10-17T18:30:00Z");
  assert.equal(reportExportFilename("Robotics Class", false, date), "lancerlogin-robotics-class-2026-10-17.csv");
  assert.equal(reportExportFilename("../Robotics: Class?", true, date), "lancerlogin-robotics-class-2026-10-17-detail.csv");
  assert.equal(reportExportFilename(" / ", false, date), "lancerlogin-report-2026-10-17.csv");
});

test("H:MM filters take hours and minutes and store minutes, as H:MM filters always have", () => {
  assert.equal(hoursMinutesAsMinutes("2:00"), "120");
  assert.equal(hoursMinutesAsMinutes(" 1:30 "), "90");
  assert.equal(hoursMinutesAsMinutes("2"), "120");
  assert.equal(hoursMinutesAsMinutes("0:05"), "5");
  for (const invalid of ["", "1:5", "1:60", "1.5", "-1:00", "abc", "1:30:00"]) assert.equal(hoursMinutesAsMinutes(invalid), undefined, invalid);
  assert.equal(minutesAsHoursMinutes("120"), "2:00");
  assert.equal(minutesAsHoursMinutes("725"), "12:05");
  assert.equal(minutesAsHoursMinutes("12.5"), "12.5");
  assert.equal(reportFilterValueText("90", "hours_minutes"), "1:30");
  assert.equal(reportFilterValueText("1.5", "hours"), "1.5");
  assert.equal(reportFilterValueText("90"), "90");
});

test("filter chips name the field, the condition and the value as the column shows it", () => {
  const hours = { unit: "hours_minutes" as const };
  assert.equal(reportColumnFilterText("Hours (H:MM)", { column: hours, operator: "minimum", value: "120" }), "Hours (H:MM) ≥ 2:00");
  assert.equal(reportColumnFilterText("Hours (H:MM)", { column: hours, operator: "between", value: "60", upperValue: "150" }), "Hours (H:MM) 1:00 to 2:30");
  assert.equal(reportColumnFilterText("Participants", { column: {}, operator: "maximum", value: "4" }), "Participants ≤ 4");
  assert.equal(reportColumnFilterText("Participants", { column: {}, operator: "equals", value: "4" }), "Participants = 4");
  assert.equal(reportColumnFilterText("Activity", { column: {}, operator: "contains", value: "Test" }), "Activity contains “Test”");
  assert.equal(reportColumnFilterText("Email", { column: {}, operator: "empty", value: "" }), "Email is empty");
  assert.equal(reportColumnFilterText("Email", { column: {}, operator: "not_empty", value: "" }), "Email is not empty");
});

test("the period chip's choices round-trip every stored period, including the last N days", () => {
  const today = "2026-11-05";
  // Regression: the old select matched "last_d+" instead of digits, so Last 30 days stored an invalid { type: "last_30" }.
  for (const days of [7, 30, 60, 90] as const) {
    assert.equal(reportPeriodChoice({ type: "last_days", days }), `last_${days}`);
    assert.deepEqual(reportPeriodFromChoice(`last_${days}`, today), { type: "last_days", days });
  }
  for (const type of ["all", "current_month", "last_month", "current_year"] as const) assert.deepEqual(reportPeriodFromChoice(reportPeriodChoice({ type }), today), { type });
  assert.deepEqual(reportPeriodFromChoice("fixed", today), { type: "fixed", from: today, to: today });
  assert.deepEqual(reportPeriodFromChoice("fixed", today, { type: "fixed", from: "2026-09-01", to: "2026-09-30" }), { type: "fixed", from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(reportPeriodFromChoice("baseline", today), { type: "baseline" });
  assert.deepEqual(reportPeriodFromChoice("baseline", today, { type: "baseline", module: "hour-tracking" }), { type: "baseline", module: "hour-tracking" });
  assert.deepEqual(reportPeriodFromChoice("last_45", today), { type: "all" });
});

test("report counts are singular only for exactly one", () => {
  assert.equal(countText(1, "matching row"), "1 matching row");
  assert.equal(countText(0, "matching row"), "0 matching rows");
  assert.equal(countText(2, "matching row"), "2 matching rows");
  assert.equal(countText(1, "member"), "1 member");
  assert.equal(countText(25, "member"), "25 members");
  assert.equal(countText(1, "person", "people"), "1 person");
  assert.equal(countText(3, "person", "people"), "3 people");
});

test("report and leaderboard counts use the shared singular-aware helper", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../apps/dashboard/src/reports-page.tsx", import.meta.url), "utf8");
  const table = await readFile(new URL("../apps/dashboard/src/report-result-table.tsx", import.meta.url), "utf8");
  assert.match(page, /countText\(visibleResult\.pagination\.totalRows, "matching row"\)/);
  assert.match(page, /countText\(report\?\.pagination\.totalRows \?\? 0, "member"\)/);
  assert.doesNotMatch(page, /" matching rows"|\} members<\/span>/);
  assert.match(table, /countText\(count, "column"\)/);
});

test("InfoTip content is always start-aligned, even inside right-aligned report headers", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../apps/dashboard/src/styles.css", import.meta.url), "utf8");
  const rule = css.match(/^\.info-tip-content \{([^}]*)\}/m)?.[1] ?? "";
  assert.match(rule, /text-align: start;/);
  assert.match(rule, /white-space: normal;/);
});

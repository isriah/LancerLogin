import test from "node:test";
import assert from "node:assert/strict";
import { latestTrendPoints, reportExportFilename } from "../apps/dashboard/src/report-view.ts";

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

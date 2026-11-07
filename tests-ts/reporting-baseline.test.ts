import test from "node:test";
import assert from "node:assert/strict";
import { futureReportingStartWarning, reportingStartHelp, reportingStartLabel } from "../apps/dashboard/src/reporting-baseline.ts";

test("a reporting start date after today warns that the module's baseline reports stay empty until then", () => {
  // Regression: an adopter saved 2026-12-31, read as a season end, so every new Outreach report began at an inverted range.
  const evening = Date.parse("2026-11-04T01:30:00Z"); // 8:30 PM on November 3 in New York
  assert.equal(futureReportingStartWarning("2026-12-31", "America/New_York", "Outreach", evening), "This date is in the future. Outreach reports that use the operational baseline will show nothing until 2026-12-31. To include records up to today, choose an earlier date or leave it blank.");
  assert.match(futureReportingStartWarning("2026-11-04", "America/New_York", "Attendance", evening) ?? "", /^This date is in the future\. Attendance reports .* until 2026-11-04\./);
  assert.equal(futureReportingStartWarning("2026-11-03", "America/New_York", "Attendance", evening), undefined);
  assert.equal(futureReportingStartWarning("2026-09-01", "America/New_York", "Attendance", evening), undefined);
  assert.equal(futureReportingStartWarning("", "America/New_York", "Attendance", evening), undefined);
  assert.equal(futureReportingStartWarning(null, "America/New_York", "Attendance", evening), undefined);
  assert.equal(futureReportingStartWarning("2026-11-04", "UTC", "Attendance", evening), undefined);
});

test("each module's reporting start date says whose reports it starts and that it is a start date", () => {
  assert.equal(reportingStartLabel("Attendance"), "Attendance reporting start date (operational baseline)");
  assert.equal(reportingStartLabel("Outreach"), "Outreach reporting start date (operational baseline)");
  assert.match(reportingStartHelp("Attendance"), /^Attendance reports and the Leaderboard that use the operational baseline count records from this date through today\./);
  assert.match(reportingStartHelp("Outreach"), /^Outreach reports that use the operational baseline count records from this date through today\..*This is a start date, not an end date\./);
});

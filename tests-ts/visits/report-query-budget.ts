import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../apps/api/src/index.ts";
import { measureReportDatasets, reportQueryBudget } from "../fixtures/report-query-budget.ts";

for (const cold of [false, true]) {
  test(`every report dataset with Outreach and Guest Visits composed stays within ${reportQueryBudget} D1 queries in a ${cold ? "new isolate's first request" : "warm isolate"}`, async (t) => {
    const results = await measureReportDatasets(worker, ["attendance", "hour-tracking", "visits"], { cold });
    for (const result of results) t.diagnostic(`${result.id}: ${result.queries} D1 queries`);
    const datasets = [...new Set(results.map((result) => result.id.replace(/ \(every column\)$/, "")))];
    for (const id of ["core.combined-members", "attendance.members", "outreach.members", "outreach.activities", "outreach.entries", "outreach.teams", "visits.bookings"]) assert.ok(datasets.includes(id), `${id} is measured`);
    for (const result of results) {
      assert.ok(result.queries <= reportQueryBudget, `${result.id} made ${result.queries} D1 queries:\n${result.log.join("\n")}`);
      assert.equal(JSON.parse(result.body).state, "ready", `${result.id} ran`);
    }
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { baselinePeriodText, catalogBaselines, combinedBaselineChoices, definitionBaseline } from "../apps/dashboard/src/report-baselines.ts";
import type { ReportCatalog, ReportDefinition } from "../apps/dashboard/src/saved-reports.ts";

const field = (id: string, sourceDataset: string) => ({ id, sourceDataset }) as ReportCatalog["datasets"][number]["fields"][number];
const catalog = (attendance: string | null, outreach: string | null) => ({
  baseline: attendance, today: "2026-11-03",
  baselines: [{ moduleId: "attendance", label: "Attendance", startsOn: attendance }, { moduleId: "hour-tracking", label: "Outreach", startsOn: outreach }],
  datasets: [
    { id: "attendance.members", baselineModule: "attendance", fields: [] },
    { id: "outreach.activities", baselineModule: "hour-tracking", fields: [] },
    { id: "outreach.members", baselineModule: "hour-tracking", fields: [] },
    { id: "core.members", fields: [] },
    { id: "core.combined-members", fields: [field("core.member.name", "core.members"), field("attendance.member.regular-rate", "attendance.members"), field("outreach.member.minutes", "outreach.members")] },
  ],
}) as unknown as ReportCatalog;
const definition = (dataset: string, columns: string[], period: ReportDefinition["period"] = { type: "baseline" }) => ({ dataset, columns: columns.map((key) => ({ key })), period }) as ReportDefinition;

test("the report editor names the baseline of the module that owns a report's data", () => {
  assert.deepEqual(definitionBaseline(catalog("2026-09-01", "2026-08-15"), definition("outreach.activities", [])), { moduleId: "hour-tracking", label: "Outreach", startsOn: "2026-08-15" });
  assert.equal(baselinePeriodText(definitionBaseline(catalog("2026-09-01", "2026-08-15"), definition("attendance.members", []))), "Attendance baseline (2026-09-01)");
  assert.equal(baselinePeriodText(definitionBaseline(catalog("2026-09-01", null), definition("outreach.activities", []))), "Outreach baseline (not set)");
  assert.equal(baselinePeriodText(definitionBaseline(catalog("2026-09-01", null), definition("core.members", []))), "Operational baseline");
  // An older API reports only Attendance's date.
  assert.deepEqual(catalogBaselines({ baseline: "2026-09-01" }), [{ moduleId: "attendance", label: "Attendance", startsOn: "2026-09-01" }]);
});

test("a combined Members report offers the baselines of the modules its columns come from and defaults to Attendance's once started", () => {
  const mixed = definition("core.combined-members", ["core.member.name", "attendance.member.regular-rate", "outreach.member.minutes"]);
  assert.deepEqual(combinedBaselineChoices(catalog("2026-09-01", "2026-08-15"), mixed).map((item) => item.moduleId), ["attendance", "hour-tracking"]);
  assert.deepEqual(combinedBaselineChoices(catalog("2026-09-01", "2026-08-15"), definition("core.combined-members", ["core.member.name", "outreach.member.minutes"])).map((item) => item.moduleId), ["hour-tracking"]);
  assert.equal(definitionBaseline(catalog("2026-09-01", "2026-08-15"), mixed)?.moduleId, "attendance");
  assert.equal(definitionBaseline(catalog("2026-12-31", "2026-08-15"), mixed)?.moduleId, "hour-tracking", "Attendance's has not started");
  assert.equal(definitionBaseline(catalog(null, "2026-08-15"), mixed)?.moduleId, "hour-tracking");
  assert.equal(definitionBaseline(catalog("2026-09-01", "2026-08-15"), { ...mixed, period: { type: "baseline", module: "hour-tracking" } })?.moduleId, "hour-tracking");
});

import test from "node:test";
import assert from "node:assert/strict";
import { attendanceByLabelDefinition, attendanceByLabelPreset, attendanceByLabelSummary, presetPeriodOptions } from "../apps/dashboard/src/report-presets.ts";
import { validateReportDefinition } from "../apps/api/src/report-builder.ts";
import type { LabelPolicySummary } from "../packages/shared/src/attendance-label-sets.ts";

const robotics: LabelPolicySummary = { labelId: "robotics", ruleType: "weighted_percentage", target: 80, excusedHandling: "exclude", weighted: false };
const build: LabelPolicySummary = { labelId: "build", ruleType: "weighted_percentage", target: 75, excusedHandling: "count_missed", weighted: true };
const outreach: LabelPolicySummary = { labelId: "outreach", ruleType: "weekly_count", target: 2, excusedHandling: null, weighted: false };
const labels = ["robotics", "build", "outreach", "a", "b", "c"].map((id) => ({ id, name: id, active: 1, formulaEnabled: 0 }));

test("the Attendance by label preset builds Member, Overall rate and a set per label, filtered to those labels and ranked by Overall rate", () => {
  const definition = attendanceByLabelDefinition([robotics, build], { type: "last_days", days: 90 });
  assert.deepEqual(definition.columns, [
    { key: "core.member.name" }, { key: "attendance.member.regular-rate" },
    ...["rate", "target", "status", "attended", "counted", "excused"].map((field) => ({ key: `attendance.label.${field}`, labelId: "robotics" })),
    ...["rate", "target", "status", "attended", "counted", "excused"].map((field) => ({ key: `attendance.label.${field}`, labelId: "build" })),
  ]);
  assert.deepEqual([definition.dataset, definition.labelIds, definition.labelMatch, definition.sort, definition.period], ["attendance.members", ["robotics", "build"], "any", { column: { key: "attendance.member.regular-rate" }, direction: "desc" }, { type: "last_days", days: 90 }]);
  // The API accepts it as an ordinary report definition.
  const validation = validateReportDefinition(definition, labels);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.definition?.columns.length, 14);
  // A weekly label's set has Weeks met in place of Meetings counted; at most five sets fit the 32-column limit.
  assert.deepEqual(attendanceByLabelDefinition([outreach], { type: "all" }).columns.map((column) => column.key).slice(-2), ["attendance.label.weeks-met", "attendance.label.excused"]);
  const many = attendanceByLabelDefinition(["robotics", "build", "outreach", "a", "b", "c"].map((labelId) => ({ ...robotics, labelId })), { type: "all" });
  assert.equal(attendanceByLabelPreset.maxLabels, 5);
  assert.equal(many.columns.length, 32);
  assert.deepEqual(validateReportDefinition(many, labels).errors, []);
});

test("the preset summary says exactly what it adds", () => {
  assert.deepEqual(attendanceByLabelSummary([{ name: "Test Robotics Class", policy: robotics }, { name: "Test Build Team", policy: build }]), {
    heading: "Adds 14 columns",
    columns: "Member · Overall rate · then for each label: Attendance rate, Target, Status, Meetings attended, Meetings counted, Excused",
    filter: 'Also adds the filter "Labels: Test Robotics Class or Test Build Team" and sorts by Overall rate.',
  });
  assert.match(attendanceByLabelSummary([{ name: "Test Outreach Crew", policy: outreach }]).columns, /\(Weeks met in place of Meetings counted for a meetings-per-week label\)$/);
  assert.equal(attendanceByLabelSummary([]).filter, "Choose at least one label.");
  assert.deepEqual(presetPeriodOptions.map(([value]) => value), ["last_90", "current_month", "last_month", "baseline", "all"]);
});

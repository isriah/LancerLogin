// Shared attendance wording: status words, the "Last N days" window and report labels read the same everywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { attendanceFieldDefinition, attendanceStatusText, attendanceTerms, recentWindowDefinition, withRecentWindow } from "../packages/shared/src/attendance-terms.ts";
import { filterAndSortReportRows, reportColumnCatalog, reportColumnLabel, type ReportDefinition, type ReportResultRow } from "../apps/api/src/report-builder.ts";
import { policyResultText } from "../apps/dashboard/src/report-attendance.ts";

test("policy statuses read as capitalised words, never identifiers or N/A", () => {
  assert.deepEqual(["met", "below", "pending", "not_applicable", "no_rule"].map(attendanceStatusText), ["Met", "Below target", "In progress", "Not enough meetings yet", "No policy"]);
  assert.equal(attendanceStatusText("some_new_state"), "Some new state");
  const base = { labelId: "class", labelName: "Class", ruleId: "r", from: "2026-09-01", to: "2026-09-30", unadjustedRate: null, attended: 1, required: 2 } as const;
  assert.equal(policyResultText({ ...base, ruleType: "weighted_percentage", excusedHandling: "exclude", status: "below", threshold: 80, rate: 50 }), "Class: 50% of 80% · Below target");
  assert.equal(policyResultText({ ...base, ruleType: "weekly_count", excusedHandling: null, status: "pending", threshold: 2, rate: null }), "Class: 1 of 2 meetings · In progress");
  assert.equal(policyResultText({ ...base, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, rate: null }), "Class: No policy");
});

test("Last N days labels are filled with the configured window and other labels are unchanged", () => {
  assert.equal(withRecentWindow("Last N days: policy result", 45), "Last 45 days: policy result");
  assert.equal(withRecentWindow("Last N days: policy result", 1), "Last 1 day: policy result");
  assert.equal(withRecentWindow("Overall rate", 45), "Overall rate");
  assert.equal(recentWindowDefinition(14), "Measured over the last 14 days, ending today, regardless of the report's dates.");
  const labels = new Map([["class", "Class"]]);
  assert.equal(reportColumnLabel({ key: "attendance.policy.official-status", labelId: "class" }, labels, 30), "Class - Last 30 days: policy status");
  assert.equal(reportColumnLabel({ key: "attendance.policy.report-status", labelId: "class" }, labels, 30), "Class - Policy status");
  assert.equal(reportColumnLabel({ key: "attendance.member.regular-rate" }, labels, 30), "Overall rate");
});

test("the Attendance catalog uses the approved names and groups with unchanged field IDs", () => {
  const label = (key: string) => reportColumnCatalog.find((item) => item.key === key);
  assert.deepEqual(["attendance.member.regular-rate", "attendance.member.weighted-present", "attendance.member.weighted-eligible", "attendance.member.regular-period"].map((key) => [label(key)?.label, label(key)?.group]), [
    ["Overall rate", "Overall attendance"], ["Overall: meetings attended (weighted)", "Overall attendance"], ["Overall: meetings counted (weighted)", "Overall attendance"], ["Overall: period", "Overall attendance"],
  ]);
  for (const id of ["official-result", "official-status", "official-target", "official-type", "official-excused", "official-period"]) assert.match(label(`attendance.policy.${id}`)!.label, /^Last N days: /, id);
  assert.deepEqual(["report-result", "report-status", "report-target", "report-period"].map((id) => label(`attendance.policy.${id}`)?.label), ["Policy result", "Policy status", "Policy target", "Policy period"]);
  assert.equal(label("attendance.detail.excused-count")?.label, "Excused meetings");
  assert.equal(label("attendance.detail.excused-count")?.group, "Meetings by outcome");
  assert.ok(reportColumnCatalog.filter((item) => item.key.startsWith("attendance.policy.") || item.key === "attendance.member.assigned-policies").every((item) => item.group === "Attendance policies (per label)"));
  assert.ok(!reportColumnCatalog.some((item) => /Regular|Official|Report-period/.test(item.label + item.group)));
});

test("column definitions explain the Overall rate, policy results and the current-standing window", () => {
  assert.equal(attendanceFieldDefinition("attendance.member.regular-rate"), attendanceTerms.overallRate.definition);
  assert.equal(attendanceFieldDefinition("attendance.policy.report-result"), attendanceTerms.attendanceRate.definition);
  assert.match(attendanceFieldDefinition("attendance.policy.official-result", 30)!, /^The rate this label's attendance policy uses\..*last 30 days, ending today/);
  assert.match(attendanceFieldDefinition("attendance.policy.official-status", 30)!, /last 30 days/);
  assert.equal(attendanceFieldDefinition("core.member.name"), undefined);
});

test("saved Equals filters on a status column still match the old lowercase status words", () => {
  const column = { key: "attendance.policy.official-status", labelId: "class" };
  const definition = { version: 2, dataset: "attendance.members", groupBy: [], period: { type: "all" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "core.member.name" }, column], columnFilters: [{ column, operator: "equals", value: "below" }], sort: { column: { key: "core.member.name" }, direction: "asc" } } as unknown as ReportDefinition;
  const row = (id: string, status: string, text: string): ReportResultRow => ({ id, label: id, cells: { "core.member.name": { text: id, sortValue: id }, "attendance.policy.official-status:class": { text, sortValue: status } } });
  const rows = [row("a", "below", "Below target"), row("b", "met", "Met")];
  assert.deepEqual(filterAndSortReportRows(definition, rows).map((item) => item.id), ["a"]);
  assert.deepEqual(filterAndSortReportRows({ ...definition, columnFilters: [{ column, operator: "equals", value: "Below target" }] }, rows).map((item) => item.id), ["a"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type PolicyLabel } from "../../apps/api/src/attendance-policy.ts";
import { filterAndSortReportRows, combinedMemberDataset, defaultReportDefinition, formatReportCellForColumn, reportColumnLabel, reportFieldSourceDataset, reportFilterSourceDataset, validateReportDefinition, type ReportDefinition } from "../../apps/api/src/report-builder.ts";

const labels: PolicyLabel[] = [{ id: "class", name: "Class", active: 1, formulaEnabled: 0 }, { id: "team", name: "Team", active: 1, formulaEnabled: 0 }];
test("Outreach duration units default and upgrade member reports to hours while other durations stay in minutes", () => {
  const current = defaultReportDefinition(false, "outreach.members");
  assert.deepEqual(current.columns.find((column) => column.key === "outreach.member.minutes"), { key: "outreach.member.minutes", unit: "hours" });
  assert.equal(reportColumnLabel(current.columns[1]!, new Map()), "Outreach hours");
  assert.deepEqual(formatReportCellForColumn(current.columns[1]!, { text: "70", sortValue: 70 }), { text: "1.17", sortValue: 1.17 });

  const existing = structuredClone(current);
  delete existing.columns[1]!.unit;
  const upgraded = validateReportDefinition(existing, labels).definition!;
  assert.deepEqual(upgraded.columns[1], { key: "outreach.member.minutes", unit: "hours" });
  assert.deepEqual(formatReportCellForColumn(upgraded.columns[1]!, { text: "70", sortValue: 70 }), { text: "1.17", sortValue: 1.17 });

  const existingActivity = defaultReportDefinition(false, "outreach.activities");
  delete existingActivity.columns.find((column) => column.key === "outreach.activity.minutes")!.unit;
  assert.equal(validateReportDefinition(existingActivity, labels).definition?.columns.find((column) => column.key === "outreach.activity.minutes")?.unit, "minutes");

  const invalidUnit = structuredClone(current); invalidUnit.columns[1]!.unit = "seconds" as "hours";
  assert.match(validateReportDefinition(invalidUnit, labels).errors.join(" "), /columns are invalid/i);
  const unsupportedUnit = defaultReportDefinition(false, "core.members"); unsupportedUnit.columns[0]!.unit = "hours";
  assert.match(validateReportDefinition(unsupportedUnit, labels).errors.join(" "), /columns are invalid/i);
});

test("Outreach report definitions normalize legacy category fields and additive label filters", () => {
  const existing = defaultReportDefinition(false, "outreach.activities") as unknown as Record<string, unknown>;
  delete existing.outreachLabelIds; delete existing.outreachLabelMatch;
  existing.columns = (existing.columns as Array<{ key: string }>).map((column) => column.key === "outreach.activity.labels" ? { key: "outreach.activity.category" } : column);
  existing.groupBy = (existing.groupBy as string[]).map((field) => field === "outreach.activity.labels" ? "outreach.activity.category" : field);
  const normalized = validateReportDefinition(existing, labels, { moduleFilterOptions: { "outreach-labels": [{ id: "food" }] } });
  assert.deepEqual(normalized.errors, []); assert.deepEqual(normalized.definition?.outreachLabelIds, []); assert.equal(normalized.definition?.outreachLabelMatch, "any");
  assert.equal(normalized.definition?.columns.some((column) => column.key === "outreach.activity.labels"), true);
  assert.equal(normalized.definition?.groupBy.includes("outreach.activity.labels"), true);

  const selected = { ...normalized.definition!, outreachLabelIds: ["food"], outreachLabelMatch: "all" as const };
  assert.deepEqual(validateReportDefinition(selected, labels, { moduleFilterOptions: { "outreach-labels": [{ id: "food" }] } }).errors, []);
  assert.match(validateReportDefinition({ ...selected, outreachLabelIds: ["removed"] }, labels, { moduleFilterOptions: { "outreach-labels": [{ id: "food" }] } }).errors.join(" "), /unknown Outreach label/);
});

test("combined member reports derive module measures through declared Core member relationships", () => {
  assert.deepEqual(combinedMemberDataset.defaultColumns, ["core.member.name", "attendance.member.regular-rate", "outreach.member.minutes"]);
  const definition = defaultReportDefinition(false, combinedMemberDataset.id);
  const validated = validateReportDefinition(definition, labels);
  assert.deepEqual(validated.errors, []);
  assert.equal(reportFieldSourceDataset(combinedMemberDataset.id, "core.member.name"), "core.members");
  assert.equal(reportFieldSourceDataset(combinedMemberDataset.id, "attendance.member.regular-rate"), "attendance.members");
  assert.equal(reportFieldSourceDataset(combinedMemberDataset.id, "outreach.member.minutes"), "outreach.members");
  assert.equal(reportFilterSourceDataset(combinedMemberDataset.id, "roster"), "core.members");
  assert.equal(reportFilterSourceDataset(combinedMemberDataset.id, "meeting-type"), "attendance.members");
  assert.equal(reportFilterSourceDataset(combinedMemberDataset.id, "membership"), "attendance.members");
  assert.equal(reportFilterSourceDataset(combinedMemberDataset.id, "period"), undefined);
  assert.equal(reportFilterSourceDataset(combinedMemberDataset.id, "outreach-labels"), "outreach.members");
});

test("expanded column filters validate types, dates, ranges and preserve old definitions", () => {
  const definition = defaultReportDefinition(false, "outreach.activities");
  const number = { key: "outreach.activity.minutes", unit: "minutes" as const };
  const date = { key: "outreach.activity.date" };
  const text = { key: "outreach.activity.title" };
  for (const filter of [
    { column: number, operator: "equals", value: "0" },
    { column: number, operator: "maximum", value: "12.5" },
    { column: number, operator: "between", value: "0", upperValue: "12.5" },
    { column: date, operator: "between", value: "2026-10-01", upperValue: "2026-10-25" },
    { column: text, operator: "equals", value: "Example" },
    { column: text, operator: "empty", value: "" },
    { column: number, operator: "not_empty", value: "" },
  ]) assert.deepEqual(validateReportDefinition({ ...definition, columnFilters: [filter] }, []).errors, [], JSON.stringify(filter));
  for (const filter of [
    { column: number, operator: "equals", value: "Infinity" },
    { column: number, operator: "between", value: "2", upperValue: "1" },
    { column: number, operator: "between", value: "2" },
    { column: date, operator: "equals", value: "2026-02-30" },
    { column: text, operator: "maximum", value: "x" },
    { column: text, operator: "equals", value: "" },
  ]) assert.match(validateReportDefinition({ ...definition, columnFilters: [filter] }, []).errors.join(" "), /column filters are invalid/i);
});

test("expanded filters use inclusive numeric and date bounds, display text and explicit emptiness", () => {
  const definition = defaultReportDefinition(false, "outreach.activities");
  const title = "outreach.activity.title", minutes = "outreach.activity.minutes", date = "outreach.activity.date";
  const rows = [
    { id: "a", label: "A", cells: { [title]: { text: "Avery Member", sortValue: "Member\u0000Avery" }, [minutes]: { text: "0", sortValue: 0 }, [date]: { text: "2026-10-01", sortValue: "2026-10-01" } } },
    { id: "b", label: "B", cells: { [title]: { text: "Other", sortValue: null }, [minutes]: { text: "10", sortValue: 10 }, [date]: { text: "2026-10-25", sortValue: "2026-10-25" } } },
    { id: "c", label: "C", cells: { [title]: { text: "", sortValue: null }, [minutes]: { text: "N/A", sortValue: null }, [date]: { text: "", sortValue: null } } },
    { id: "d", label: "D", cells: { [title]: { text: "Unavailable", sortValue: null, unavailable: true }, [minutes]: { text: "Unavailable", sortValue: null, unavailable: true }, [date]: { text: "Unavailable", sortValue: null, unavailable: true } } },
  ];
  const match = (key: string, operator: NonNullable<ReportDefinition["columnFilters"]>[number]["operator"], value = "", upperValue?: string) => filterAndSortReportRows({ ...definition, columnFilters: [{ column: { key }, operator, value, upperValue }] }, rows).map((row) => row.id).sort();
  assert.deepEqual(match(title, "equals", "AVERY MEMBER"), ["a"]);
  assert.deepEqual(match(title, "not_empty"), ["a", "b"]);
  assert.deepEqual(match(minutes, "equals", "0"), ["a"]);
  assert.deepEqual(match(minutes, "maximum", "0"), ["a"]);
  assert.deepEqual(match(minutes, "between", "0", "10"), ["a", "b"]);
  assert.deepEqual(match(minutes, "empty"), ["c"]);
  assert.deepEqual(match(minutes, "not_empty"), ["a", "b"]);
  assert.deepEqual(match(date, "between", "2026-10-01", "2026-10-25"), ["a", "b"]);
  assert.deepEqual(match(date, "maximum", "2026-10-01"), ["a"]);
});

test("saved report definitions from before Outreach became a plugin load unchanged through its module filter", () => {
  // Stored definitions and the normalized form Core produced at 75de3f2e, while Outreach and its label filter were built into Core.
  const recorded = JSON.parse(readFileSync(new URL("../fixtures/outreach-saved-report-definitions.json", import.meta.url), "utf8")) as { labels: Parameters<typeof validateReportDefinition>[1]; outreachLabels: { id: string }[]; cases: { stored: string; normalized: string; warnings: string[]; errors: string[] }[] };
  assert.equal(recorded.cases.length, 6);
  for (const item of recorded.cases) {
    const result = validateReportDefinition(JSON.parse(item.stored), recorded.labels, { allowMissingLabels: true, moduleFilterOptions: { "outreach-labels": recorded.outreachLabels } });
    assert.equal(JSON.stringify(result.definition), item.normalized, item.stored);
    assert.deepEqual(result.warnings, item.warnings); assert.deepEqual(result.errors, item.errors);
  }
});

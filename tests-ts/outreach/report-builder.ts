import { exampleReportDefinition } from "../../apps/dashboard/src/report-template.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { evaluateAttendance, type AttendanceRule, type LabelChange, type Observation, type PolicyLabel, type PolicyMeeting, type PolicyMember } from "../../apps/api/src/attendance-policy.ts";
import { filterAndSortReportRows, buildReportRows, combinedMemberDataset, defaultReportDefinition, formatReportCellForColumn, reportColumnLabel, reportFieldSourceDataset, reportFilterSourceDataset, resolveReportPeriod, validateReportDefinition, type ReportDefinition } from "../../apps/api/src/report-builder.ts";

const labels: PolicyLabel[] = [{ id: "class", name: "Class", active: 1, formulaEnabled: 0 }, { id: "team", name: "Team", active: 1, formulaEnabled: 0 }];
const members: PolicyMember[] = [
  { id: "a", memberId: "A", firstName: "Aiden", lastName: "Able", email: "a@example.test", active: 1, attendanceRequiredFrom: "2026-09-01" },
  { id: "b", memberId: "B", firstName: "Blair", lastName: "Baker", active: 1, attendanceRequiredFrom: "2026-10-01" },
];
const rules: AttendanceRule[] = [{ id: "class-rule", labelId: "class", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 80, excusedHandling: "exclude" }];
const changes: LabelChange[] = [{ memberId: "a", labelId: "class", action: "add", effectiveDate: "2026-09-01" }, { memberId: "a", labelId: "team", action: "add", effectiveDate: "2026-09-02" }];
const meetings: PolicyMeeting[] = [
  { id: "night", title: "Night meeting", startsAt: "2026-09-02T02:00:00.000Z", endsAt: "2026-09-02T03:00:00.000Z", attendanceClosesAt: "2026-09-02T03:30:00.000Z", required: 1, attendanceWeight: 2, audienceMode: "all", audienceLabelIds: [] },
  { id: "optional", title: "Optional meeting", startsAt: "2026-09-03T18:00:00.000Z", endsAt: "2026-09-03T19:00:00.000Z", attendanceClosesAt: "2026-09-03T19:30:00.000Z", required: 0, attendanceWeight: 1, audienceMode: "all", audienceLabelIds: [] },
];
const observations: Observation[] = [{ meetingId: "night", memberId: "a", disposition: "absent" }, { meetingId: "optional", memberId: "a", disposition: "present" }];
const base = { members, labels, changes, rules, meetings, observations, timeZone: "America/New_York", now: "2026-09-10T12:00:00.000Z" };

test("report definitions validate periods, selected columns, and missing label references", () => {
  const valid = defaultReportDefinition(true); assert.equal(valid.period.type, "baseline");
  const legacy = { ...valid }; delete legacy.columnFilters;
  assert.deepEqual(validateReportDefinition(legacy, labels).definition?.columnFilters, []);
  assert.deepEqual(resolveReportPeriod({ type: "last_days", days: 30 }, "2026-09-25", null), { from: "2026-08-27", to: "2026-09-25" });
  const missing = { ...valid, labelIds: ["removed"] };
  assert.match(validateReportDefinition(missing, labels).errors.join(" "), /unknown label/);
  const restored = validateReportDefinition(missing, labels, { allowMissingLabels: true });
  assert.equal(restored.definition?.labelIds[0], "removed"); assert.match(restored.warnings.join(" "), /no longer available/);
});

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

test("version 1 report definitions normalize to namespaced version 2 fields without changing semantics", () => {
  const legacy = { version: 1, period: { type: "current_month" }, roster: "all", meetingType: "required", labelIds: ["class"], labelMatch: "all", membership: "historical", columns: [{ key: "member" }, { key: "regular_attendance" }, { key: "official_policy_status", labelId: "class" }], columnFilters: [{ column: { key: "regular_attendance" }, operator: "minimum", value: "70" }], sort: { column: { key: "regular_attendance" }, direction: "desc" } };
  const normalized = validateReportDefinition(legacy, labels).definition;
  assert.equal(normalized?.version, 2); assert.equal(normalized?.dataset, "attendance.members"); assert.deepEqual(normalized?.groupBy, ["core.member.identity"]);
  assert.deepEqual(normalized?.columns, [{ key: "core.member.name" }, { key: "attendance.member.regular-rate" }, { key: "attendance.policy.official-status", labelId: "class" }]);
  assert.deepEqual(normalized?.columnFilters, [{ column: { key: "attendance.member.regular-rate" }, operator: "minimum", value: "70" }]);
  assert.deepEqual(normalized?.sort, { column: { key: "attendance.member.regular-rate" }, direction: "desc" });
  assert.equal(normalized?.roster, "all"); assert.equal(normalized?.meetingType, "required"); assert.equal(normalized?.membership, "historical");
});

test("report column filters validate against visible columns and filter before sorting", () => {
  const definition: ReportDefinition = { version: 1, period: { type: "fixed", from: "2026-09-01", to: "2026-09-09" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "member" }, { key: "regular_attendance" }], columnFilters: [{ column: { key: "regular_attendance" }, operator: "minimum", value: "0" }], sort: { column: { key: "member" }, direction: "asc" } };
  const validated = validateReportDefinition(definition, labels);
  assert.deepEqual(validated.errors, []);
  const official = evaluateAttendance(base); const period = evaluateAttendance({ ...base, from: "2026-09-01", to: "2026-09-09" });
  const rows = buildReportRows({ definition: validated.definition!, official, period, meetings, labels, rules, timeZone: "America/New_York", from: "2026-09-01", to: "2026-09-09" });
  assert.deepEqual(rows.map((row) => row.member.id), ["a"]);
  const hidden = { ...definition, columnFilters: [{ column: { key: "absent_count" }, operator: "minimum" as const, value: "1" }] };
  assert.match(validateReportDefinition(hidden, labels).errors.join(" "), /column filters are invalid/i);
});

test("report rows use organization-local ISO dates, preserve optional presence, and sort N/A last", () => {
  const definition: ReportDefinition = { version: 1, period: { type: "fixed", from: "2026-09-01", to: "2026-09-09" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "member" }, { key: "regular_attendance" }, { key: "present_dates" }, { key: "absent_dates" }, { key: "official_policy_status", labelId: "class" }], sort: { column: { key: "regular_attendance" }, direction: "desc" } };
  const official = evaluateAttendance(base); const period = evaluateAttendance({ ...base, from: "2026-09-01", to: "2026-09-09", summaryLabelIds: ["class"] });
  const rows = buildReportRows({ definition, official, period, meetings, labels, rules, timeZone: "America/New_York", from: "2026-09-01", to: "2026-09-09" });
  assert.deepEqual(rows.map((row) => row.member.id), ["a", "b"]);
  assert.equal(rows[0].cells.present_dates.text, "2026-09-03");
  assert.equal(rows[0].cells.absent_dates.text, "2026-09-01");
  assert.equal(rows[0].cells.regular_attendance.text, "0%");
  assert.equal(rows[1].cells.regular_attendance.text, "N/A");
  assert.equal(rows[0].cells["official_policy_status:class"].text, "below");
});

test("historical multi-label matching applies Any and All on each meeting date", () => {
  const any = evaluateAttendance({ ...base, members: [members[0]], historicalLabelIds: ["class", "team"], historicalLabelMatch: "any" })[0];
  const all = evaluateAttendance({ ...base, members: [members[0]], historicalLabelIds: ["class", "team"], historicalLabelMatch: "all" })[0];
  assert.deepEqual(any.rows.map((row) => row.meetingId), ["night", "optional"]);
  assert.deepEqual(all.rows.map((row) => row.meetingId), ["optional"]);
});

test("current report membership counts earlier weighted meetings and excuses without changing official history", () => {
  const lateChanges: LabelChange[] = [{ memberId: "a", labelId: "class", action: "add", effectiveDate: "2026-09-09" }];
  const reportMeetings: PolicyMeeting[] = [
    { ...meetings[0], audienceMode: "labels", audienceLabelIds: ["class"] },
    meetings[1],
    ...["04", "05"].map((day) => ({ ...meetings[0], id: day, startsAt: `2026-09-${day}T18:00:00Z`, endsAt: `2026-09-${day}T19:00:00Z`, attendanceClosesAt: `2026-09-${day}T19:30:00Z`, attendanceWeight: 1 })),
  ];
  const input = { ...base, members: [members[0]], changes: lateChanges, meetings: reportMeetings, observations: [
    { meetingId: "night", memberId: "a", disposition: "present" as const },
    { meetingId: "optional", memberId: "a", disposition: "present" as const },
    { meetingId: "05", memberId: "a", disposition: "excused" as const },
  ] };
  const definition: ReportDefinition = { ...defaultReportDefinition(false), period: { type: "fixed", from: "2026-09-01", to: "2026-09-08" }, labelIds: ["class"], columns: [{ key: "member" }, { key: "regular_attendance" }, { key: "report_policy_result", labelId: "class" }, { key: "official_policy_result", labelId: "class" }] };
  const official = evaluateAttendance(input);
  const period = evaluateAttendance({ ...input, membership: "current", from: "2026-09-01", to: "2026-09-08" });
  const historical = evaluateAttendance({ ...input, membership: "historical", from: "2026-09-01", to: "2026-09-08", historicalLabelIds: ["class"] });
  const rows = buildReportRows({ definition, official, period, meetings: reportMeetings, labels, rules, timeZone: base.timeZone });
  assert.equal(rows[0].cells.regular_attendance.text, "50%");
  assert.equal(rows[0].cells["report_policy_result:class"].text, "Class: 67% · below");
  assert.equal(rows[0].cells["official_policy_result:class"].text, "Class: N/A");
  assert.equal(period[0].rows.find((row) => row.meetingId === "night")?.eligibility, "required");
  assert.deepEqual(historical[0].rows, []);
  assert.equal(historical[0].historySummaries[0].rate, null);
  assert.deepEqual(evaluateAttendance(input), official);
  assert.deepEqual(lateChanges, [{ memberId: "a", labelId: "class", action: "add", effectiveDate: "2026-09-09" }]);
});

test("current report membership respects attendance starts, dated rules, removals, and future assignments", () => {
  const reportMeetings = ["01", "03", "05", "07"].map((day) => ({ ...meetings[0], id: day, startsAt: `2026-09-${day}T18:00:00Z`, endsAt: `2026-09-${day}T19:00:00Z`, attendanceClosesAt: `2026-09-${day}T19:30:00Z`, attendanceWeight: 1 }));
  const input = { ...base, members: [{ ...members[0], attendanceRequiredFrom: "2026-09-03" }], meetings: reportMeetings,
    changes: [{ memberId: "a", labelId: "class", action: "add" as const, effectiveDate: "2026-09-09" }],
    rules: [{ ...rules[0], startsOn: "2026-09-05", endsOn: "2026-09-06" }],
    observations: [{ meetingId: "05", memberId: "a", disposition: "excused" as const }],
    membership: "current" as const, from: "2026-09-01", to: "2026-09-08", summaryLabelIds: ["class"],
  };
  const excluded = evaluateAttendance(input)[0];
  assert.equal(excluded.rows.find((row) => row.meetingId === "01")?.eligibility, "before_start");
  assert.equal(excluded.regularAttendance.required, 3);
  assert.equal(excluded.historySummaries[0].required, 0);
  assert.equal(excluded.historySummaries[0].rate, null);
  const counted = evaluateAttendance({ ...input, rules: [{ ...input.rules[0], excusedHandling: "count_missed" }] })[0];
  assert.equal(counted.historySummaries[0].required, 1);
  assert.equal(counted.historySummaries[0].rate, 0);
  const membershipChanges: LabelChange[] = [
    { memberId: "a", labelId: "class", action: "add", effectiveDate: "2026-09-01" },
    { memberId: "a", labelId: "class", action: "remove", effectiveDate: "2026-09-09" },
    { memberId: "a", labelId: "team", action: "add", effectiveDate: "2026-09-11" },
  ];
  const removed = evaluateAttendance({ ...input, changes: membershipChanges })[0];
  assert.deepEqual(removed.currentLabelIds, []);
  assert.equal(removed.historySummaries[0].required, 0);
  assert.ok(removed.rows.every((row) => row.memberLabelIds.length === 0));
});

test("current report membership evaluates weekly rules over the report period", () => {
  const input = { ...base, members: [members[0]], membership: "current" as const,
    changes: [{ memberId: "a", labelId: "class", action: "add" as const, effectiveDate: "2026-09-09" }],
    rules: [{ id: "weekly", labelId: "class", ruleType: "weekly_count" as const, meetingsPerWeek: 1, startsOn: "2026-09-01", endsOn: "2026-09-06" }],
    meetings: [{ ...meetings[0], audienceMode: "labels" as const, audienceLabelIds: ["class"] }],
    observations: [{ meetingId: "night", memberId: "a", disposition: "present" as const }],
    from: "2026-09-01", to: "2026-09-06",
  };
  const current = evaluateAttendance(input)[0];
  assert.equal(current.historySummaries[0].weeksMet, 1);
  assert.equal(current.historySummaries[0].weeksDue, 1);
  assert.equal(current.historySummaries[0].rate, 100);
  const historical = evaluateAttendance({ ...input, membership: "historical" })[0];
  assert.equal(historical.historySummaries[0].rate, null);
});

test("saved report migration enforces library uniqueness and cascades tab pins", () => {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON; CREATE TABLE installations(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE); INSERT INTO installations VALUES ('primary'); INSERT INTO users VALUES ('u1','primary'),('u2','primary');");
  db.exec(readFileSync(new URL("../../apps/api/migrations/0036_saved_report_views.sql", import.meta.url), "utf8"));
  const definition = JSON.stringify(defaultReportDefinition(false));
  db.prepare("INSERT INTO saved_report_views VALUES (?,?,?,?,?,?,1,?,?,?,?)").run("r1", "primary", "u1", "personal", "Class", definition, "u1", "u1", "2026-09-25", "2026-09-25");
  assert.throws(() => db.prepare("INSERT INTO saved_report_views VALUES (?,?,?,?,?,?,1,?,?,?,?)").run("r2", "primary", "u1", "personal", "class", definition, "u1", "u1", "2026-09-25", "2026-09-25"));
  db.prepare("INSERT INTO saved_report_views VALUES (?,?,?,?,?,?,1,?,?,?,?)").run("r2", "primary", "u2", "personal", "class", definition, "u2", "u2", "2026-09-25", "2026-09-25");
  db.prepare("INSERT INTO saved_report_tabs VALUES (?,?,?,?,?)").run("primary", "u1", "r1", 0, "2026-09-25"); db.prepare("DELETE FROM saved_report_views WHERE id = 'r1'").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM saved_report_tabs").get()?.count, 0); db.close();
});

test("walkthrough example works with an empty label catalog and a reusable monthly period", () => {
  const definition = exampleReportDefinition();
  assert.deepEqual(validateReportDefinition(definition, []).errors, []);
  assert.deepEqual(definition.period, { type: "current_month" });
  assert.equal(definition.roster, "active");
  assert.equal(definition.membership, "current");
  assert.equal(definition.version, 2);
  assert.equal(definition.dataset, "attendance.members");
  assert.ok(definition.columns.some((column) => column.key === "attendance.policy.report-summary"));
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

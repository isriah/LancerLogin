// Report definitions and dataset catalog cases that need no plugin, run without composing one. The Outreach-dependent cases are in outreach/report-builder.ts (outreach-report-builder.test.ts).
import { exampleReportDefinition } from "../apps/dashboard/src/report-template.ts";
import { reportPeriodFromChoice, reportPeriodOptions } from "../apps/dashboard/src/report-view.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { evaluateAttendance, localDate, type AttendanceRule, type LabelChange, type Observation, type PolicyLabel, type PolicyMeeting, type PolicyMember } from "../apps/api/src/attendance-policy.ts";
import { buildReportRows, defaultReportDefinition, displayedReportRows, reportBaselineStarted, reportComputationDefinition, resolveReportPeriod, validateReportDefinition, type ReportDefinition } from "../apps/api/src/report-builder.ts";

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

test("a baseline after today is not a new report's default and its period explains why it is empty", () => {
  // Regression: a baseline set ahead of today made every new report default to the inverted range baseline..today.
  assert.equal(reportBaselineStarted("2026-09-01", "2026-11-03"), true);
  assert.equal(reportBaselineStarted("2026-11-03", "2026-11-03"), true);
  assert.equal(reportBaselineStarted("2026-11-04", "2026-11-03"), false);
  assert.equal(reportBaselineStarted(null, "2026-11-03"), false);
  assert.deepEqual(resolveReportPeriod({ type: "baseline" }, "2026-11-03", "2026-09-01"), { from: "2026-09-01", to: "2026-11-03" });
  const future = resolveReportPeriod({ type: "baseline" }, "2026-11-03", "2027-01-04");
  assert.equal(future.from, "2027-01-04"); assert.match(future.warning ?? "", /2027-01-04\) is after today/);
});

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

test("Last month resolves to the whole previous calendar month in the installation's time zone", () => {
  const lastMonth = (today: string) => resolveReportPeriod({ type: "last_month" }, today, null);
  assert.deepEqual(lastMonth("2026-11-04"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(lastMonth("2026-11-01"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(lastMonth("2026-11-30"), { from: "2026-10-01", to: "2026-10-31" });
  // January covers the whole previous December.
  assert.deepEqual(lastMonth("2027-01-01"), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(lastMonth("2027-01-31"), { from: "2026-12-01", to: "2026-12-31" });
  // Month lengths: 30 days, February in common and leap years.
  assert.deepEqual(lastMonth("2026-10-15"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(lastMonth("2027-03-15"), { from: "2027-02-01", to: "2027-02-28" });
  assert.deepEqual(lastMonth("2028-03-01"), { from: "2028-02-01", to: "2028-02-29" });
  // The API resolves periods from the installation's today. 11 PM in New York on November 1 is November 2 in UTC, and
  // 11 PM on October 31 is already November 1 in UTC, which would wrongly make October "last month".
  assert.equal(localDate("2026-11-02T04:00:00.000Z", "America/New_York"), "2026-11-01");
  assert.deepEqual(lastMonth(localDate("2026-11-02T04:00:00.000Z", "America/New_York")), { from: "2026-10-01", to: "2026-10-31" });
  assert.equal(localDate("2026-11-01T03:00:00.000Z", "America/New_York"), "2026-10-31");
  assert.deepEqual(lastMonth(localDate("2026-11-01T03:00:00.000Z", "America/New_York")), { from: "2026-09-01", to: "2026-09-30" });
});

test("saved definitions keep the Last month period, and the dashboard offers every period the API accepts", () => {
  const validated = validateReportDefinition({ ...defaultReportDefinition(false), period: { type: "last_month" } }, labels);
  assert.deepEqual(validated.errors, []); assert.deepEqual(validated.definition?.period, { type: "last_month" });
  assert.match(validateReportDefinition({ ...defaultReportDefinition(false), period: { type: "previous_month" } }, labels).errors.join(" "), /period/i);
  const page = readFileSync(new URL("../apps/dashboard/src/reports-page.tsx", import.meta.url), "utf8");
  // Every period choice the dashboard offers stores a period the API keeps as it is.
  assert.deepEqual(reportPeriodOptions.map(([value]) => value), ["all", "baseline", "last_7", "last_30", "last_60", "last_90", "current_month", "last_month", "current_year", "fixed"]);
  for (const [value] of reportPeriodOptions) {
    const period = reportPeriodFromChoice(value, "2026-10-01", value === "fixed" ? { type: "fixed", from: "2026-10-01", to: "2026-10-31" } : undefined);
    assert.notEqual(period.type === "all", value !== "all", value);
    assert.deepEqual(validateReportDefinition({ ...defaultReportDefinition(true), period }, labels).definition?.period, period, value);
  }
  const leaderboard = page.match(/<label>Reporting period<select[\s\S]*?<\/select>/)![0];
  assert.match(leaderboard, /<option value="last_month">Last month<\/option><option value="custom">/);
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

test("report column filters validate against dataset fields and filter before sorting", () => {
  const definition: ReportDefinition = { version: 1, period: { type: "fixed", from: "2026-09-01", to: "2026-09-09" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "member" }, { key: "regular_attendance" }], columnFilters: [{ column: { key: "regular_attendance" }, operator: "minimum", value: "0" }], sort: { column: { key: "member" }, direction: "asc" } };
  const validated = validateReportDefinition(definition, labels);
  assert.deepEqual(validated.errors, []);
  const official = evaluateAttendance(base); const period = evaluateAttendance({ ...base, from: "2026-09-01", to: "2026-09-09" });
  const rows = buildReportRows({ definition: validated.definition!, official, period, meetings, labels, rules, timeZone: "America/New_York", from: "2026-09-01", to: "2026-09-09" });
  assert.deepEqual(rows.map((row) => row.member.id), ["a"]);
  const unknown = { ...definition, columnFilters: [{ column: { key: "not-a-field" }, operator: "minimum" as const, value: "1" }] };
  assert.match(validateReportDefinition(unknown, labels).errors.join(" "), /column filters are invalid/i);
  const wrongOperator = { ...definition, columnFilters: [{ column: { key: "absent_count" }, operator: "contains" as const, value: "1" }] };
  assert.match(validateReportDefinition(wrongOperator, labels).errors.join(" "), /column filters are invalid/i);
});

test("a filter on a field that isn't displayed is valid, filters the rows, and leaves only displayed cells", () => {
  // Saved definitions from before hidden-field filters only filter displayed columns; they normalize and compute unchanged.
  const stored: ReportDefinition = { version: 1, period: { type: "fixed", from: "2026-09-01", to: "2026-09-09" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "member" }, { key: "regular_attendance" }], columnFilters: [{ column: { key: "regular_attendance" }, operator: "minimum", value: "0" }], sort: { column: { key: "member" }, direction: "asc" } };
  const storedDefinition = validateReportDefinition(stored, labels).definition!;
  assert.equal(reportComputationDefinition(storedDefinition), storedDefinition);
  const hidden: ReportDefinition = { ...stored, columnFilters: [{ column: { key: "absent_count" }, operator: "minimum", value: "1" }] };
  const validated = validateReportDefinition(hidden, labels);
  assert.deepEqual(validated.errors, []);
  const definition = validated.definition!;
  assert.deepEqual(definition.columns.map((column) => column.key), ["core.member.name", "attendance.member.regular-rate"]);
  assert.deepEqual(definition.columnFilters, [{ column: { key: "attendance.detail.absent-count" }, operator: "minimum", value: "1" }]);
  const computed = reportComputationDefinition(definition);
  assert.deepEqual(computed.columns.map((column) => column.key), ["core.member.name", "attendance.member.regular-rate", "attendance.detail.absent-count"]);
  const official = evaluateAttendance(base); const period = evaluateAttendance({ ...base, from: "2026-09-01", to: "2026-09-09" });
  const rows = buildReportRows({ definition: computed, official, period, meetings, labels, rules, timeZone: "America/New_York", from: "2026-09-01", to: "2026-09-09" });
  assert.deepEqual(rows.map((row) => row.member!.id), ["a"]);
  const shown = displayedReportRows(definition, rows);
  assert.deepEqual(Object.keys(shown[0].cells).sort(), ["attendance.member.regular-rate", "core.member.name"]);
  // One filter per field, as before.
  const twice: ReportDefinition = { ...stored, columnFilters: [{ column: { key: "absent_count" }, operator: "minimum", value: "1" }, { column: { key: "absent_count" }, operator: "maximum", value: "3" }] };
  assert.match(validateReportDefinition(twice, labels).errors.join(" "), /column filters are invalid/i);
});

test("report rows use organization-local ISO dates, preserve optional presence, and sort N/A last", () => {
  const definition: ReportDefinition = { version: 1, period: { type: "fixed", from: "2026-09-01", to: "2026-09-09" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "member" }, { key: "regular_attendance" }, { key: "present_dates" }, { key: "absent_dates" }, { key: "official_policy_status", labelId: "class" }], sort: { column: { key: "regular_attendance" }, direction: "desc" } };
  const official = evaluateAttendance(base); const period = evaluateAttendance({ ...base, from: "2026-09-01", to: "2026-09-09", summaryLabelIds: ["class"] });
  const rows = buildReportRows({ definition, official, period, meetings, labels, rules, timeZone: "America/New_York", from: "2026-09-01", to: "2026-09-09" });
  assert.deepEqual(rows.map((row) => row.member.id), ["a", "b"]);
  assert.equal(rows[0].cells.present_dates.text, "2026-09-03");
  assert.equal(rows[0].cells.absent_dates.text, "2026-09-01");
  assert.equal(rows[0].cells.regular_attendance.text, "0%");
  // No required meetings is no value: the dashboard shows a dash and the CSV an empty cell.
  assert.deepEqual(rows[1].cells.regular_attendance, { text: "", sortValue: null, empty: true });
  assert.equal(rows[0].cells["official_policy_status:class"].text, "Below target");
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
  assert.equal(rows[0].cells["report_policy_result:class"].text, "Class: 67% · Below target");
  assert.equal(rows[0].cells["official_policy_result:class"].text, "Class: Not enough meetings yet");
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
  db.exec(readFileSync(new URL("../apps/api/migrations/0036_saved_report_views.sql", import.meta.url), "utf8"));
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

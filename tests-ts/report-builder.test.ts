import { exampleReportDefinition } from "../apps/dashboard/src/report-template.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { evaluateAttendance, type AttendanceRule, type LabelChange, type Observation, type PolicyLabel, type PolicyMeeting, type PolicyMember } from "../apps/api/src/attendance-policy.ts";
import { buildReportRows, defaultReportDefinition, resolveReportPeriod, validateReportDefinition, type ReportDefinition } from "../apps/api/src/report-builder.ts";

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
  assert.ok(definition.columns.some((column) => column.key === "report_policy_summary"));
});

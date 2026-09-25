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

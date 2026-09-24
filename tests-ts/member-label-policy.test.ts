import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { evaluateAttendance, type AttendanceRule, type PolicyMeeting, type PolicyMember, type PolicyLabel, type LabelChange, type Observation } from "../apps/api/src/attendance-policy.ts";

const members: PolicyMember[] = [
  { id: "a", memberId: "A", firstName: "Avery", lastName: "One", active: 1, attendanceRequiredFrom: "2026-09-01" },
  { id: "b", memberId: "B", firstName: "Blair", lastName: "Two", active: 1, attendanceRequiredFrom: "2026-09-01" },
  { id: "c", memberId: "C", firstName: "Casey", lastName: "Three", active: 1, attendanceRequiredFrom: "2026-09-01" },
];
const labels: PolicyLabel[] = [
  { id: "321", name: "321", active: 1, formulaEnabled: 0 }, { id: "427", name: "427", active: 1, formulaEnabled: 0 },
  { id: "drive", name: "Drive Team", active: 1, formulaEnabled: 0 }, { id: "student", name: "Student", active: 1, formulaEnabled: 0 },
  { id: "mentor", name: "Mentor", active: 1, formulaEnabled: 0 },
];
const meeting = (id: string, date: string, audienceLabelIds: string[], required = true, attendanceWeight = 1): PolicyMeeting => ({ id, title: id, startsAt: date + "T18:00:00.000Z", endsAt: date + "T20:00:00.000Z", attendanceClosesAt: date + "T20:30:00.000Z", required, attendanceWeight, audienceMode: audienceLabelIds.length ? "labels" : "all", audienceLabelIds });
const observed = (meetingId: string, memberId: string, disposition: Observation["disposition"]): Observation => ({ meetingId, memberId, disposition });
const percentage = (id = "student-80"): AttendanceRule => ({ id, labelId: "student", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 80 });
const weekly = (id: string, start: string, end: string | null, count: number): AttendanceRule => ({ id, labelId: "mentor", startsOn: start, endsOn: end, ruleType: "weekly_count", meetingsPerWeek: count });
function evaluate(extra: Partial<Parameters<typeof evaluateAttendance>[0]>) { return evaluateAttendance({ members, labels, changes: [], rules: [], meetings: [], observations: [], timeZone: "UTC", now: "2026-10-01T00:00:00.000Z", ...extra }); }

test("321 optional, 427 weighted competition, and Drive Team audiences use required opportunities only", () => {
  const changes: LabelChange[] = [{ memberId: "a", labelId: "321", action: "add", effectiveDate: "2026-09-01" }, { memberId: "b", labelId: "427", action: "add", effectiveDate: "2026-09-01" }, { memberId: "c", labelId: "321", action: "add", effectiveDate: "2026-09-01" }, { memberId: "c", labelId: "drive", action: "add", effectiveDate: "2026-09-01" }];
  const result = evaluate({ changes, meetings: [meeting("321-long", "2026-09-07", ["321"], false), meeting("427-comp", "2026-09-08", ["427"], true, 2), meeting("drive-practice", "2026-09-09", ["drive"]), meeting("all", "2026-09-10", [])], observations: [observed("321-long", "a", "present"), observed("427-comp", "b", "present"), observed("drive-practice", "c", "present")] });
  assert.deepEqual(result.map((item) => [item.primaryTotal, item.present, item.rate]), [[1, 0, 0], [3, 2, 67], [2, 1, 50]]);
  assert.equal(result[0].rows[0].eligibility, "optional");
  assert.equal(result[0].rows[1].eligibility, "outside_audience");
  assert.equal(result[2].rows[2].eligibility, "required");
});

test("weighted percentage compares unrounded excuse-adjusted rate to threshold and excludes optional meetings", () => {
  const changes: LabelChange[] = [{ memberId: "a", labelId: "student", action: "add", effectiveDate: "2026-09-01" }];
  const meetings = [meeting("heavy", "2026-09-21", [], true, 4), meeting("light", "2026-09-22", [], true, 1), meeting("optional", "2026-09-23", [], false, 20)];
  const passing = evaluate({ members: [members[0]], changes, rules: [percentage()], meetings, observations: [observed("heavy", "a", "present"), observed("optional", "a", "present")] })[0];
  assert.equal(passing.currentCompliance.rate, 80);
  assert.equal(passing.currentCompliance.status, "met");
  assert.equal(passing.primaryTotal, 5);
  const failing = evaluate({ members: [members[0]], changes, rules: [{ ...percentage(), thresholdPercent: 80.01 }], meetings, observations: [observed("heavy", "a", "present")] })[0];
  assert.equal(failing.currentCompliance.rate, 80);
  assert.equal(failing.currentCompliance.status, "below");
  const excused = evaluate({ members: [members[0]], changes, rules: [percentage()], meetings, observations: [observed("heavy", "a", "present"), observed("light", "a", "excused")] })[0];
  assert.equal(excused.currentCompliance.rate, 100);
  assert.equal(excused.currentCompliance.unadjustedRate, 80);
  assert.equal(excused.currentCompliance.status, "met");
  assert.equal(excused.rows.find((row) => row.meetingId === "optional")?.rateEligible, false);
});

test("dated label changes and start-count dates keep historical eligibility", () => {
  const result = evaluate({ members: [{ ...members[0], attendanceRequiredFrom: "2026-09-08" }], changes: [{ memberId: "a", labelId: "student", action: "add", effectiveDate: "2026-09-07" }, { memberId: "a", labelId: "student", action: "remove", effectiveDate: "2026-09-09" }], rules: [percentage()], meetings: [meeting("early", "2026-09-07", ["student"]), meeting("during", "2026-09-08", ["student"]), meeting("later", "2026-09-09", ["student"])], observations: [observed("early", "a", "present"), observed("later", "a", "present")] })[0];
  assert.deepEqual(result.rows.map((row) => row.eligibility), ["before_start", "required", "outside_audience"]);
  assert.equal(result.primaryTotal, 1);
  assert.equal(result.historySummaries.length, 0);
});

test("weekly rule counts optional meetings reached through any held label once and ignores meeting weight", () => {
  const changes: LabelChange[] = [{ memberId: "a", labelId: "mentor", action: "add", effectiveDate: "2026-09-01" }, { memberId: "a", labelId: "drive", action: "add", effectiveDate: "2026-09-01" }];
  const result = evaluate({ members: [members[0]], changes, rules: [weekly("one", "2026-09-01", null, 1)], meetings: [meeting("drive", "2026-09-07", ["drive"], false, 5), meeting("all", "2026-09-08", [], true, 3), meeting("outside", "2026-09-09", ["427"], true, 9)], observations: [observed("drive", "a", "present"), observed("all", "a", "present")] })[0];
  assert.equal(result.weeks[0].opportunities, 2);
  assert.equal(result.weeks[0].attended, 2);
  assert.equal(result.weeks[0].denominator, 1);
  assert.equal(result.weeks[0].status, "met");
  assert.equal(result.rows.find((row) => row.meetingId === "drive")?.weight, 1);
  assert.equal(result.rows.find((row) => row.meetingId === "outside")?.eligibility, "outside_audience");
  assert.equal(result.historySummaries[0].weeksMet, 1);
  assert.equal(result.historySummaries[0].weeksDue, 1);
});

test("sparse weeks, excuses, pending current week, and no-opportunity weeks have distinct statuses", () => {
  const changes: LabelChange[] = [{ memberId: "a", labelId: "mentor", action: "add", effectiveDate: "2026-09-01" }];
  const rule = weekly("two", "2026-09-01", null, 2);
  const result = evaluate({ members: [members[0]], changes, rules: [rule], meetings: [meeting("only", "2026-09-07", []), meeting("excused", "2026-09-15", []), meeting("future", "2026-10-02", [])], observations: [observed("only", "a", "present"), observed("excused", "a", "excused")] })[0];
  assert.equal(result.weeks[0].status, "met");
  assert.equal(result.weeks[1].status, "not_applicable");
  assert.equal(result.currentCompliance.status, "pending");
  assert.equal(result.historySummaries[0].weeksDue, 1);
  const noMeeting = evaluate({ members: [members[0]], changes, rules: [rule] })[0];
  assert.equal(noMeeting.currentCompliance.status, "not_applicable");
});

test("January 9 rule change splits that Monday-Sunday week into two partial evaluations", () => {
  const changes: LabelChange[] = [{ memberId: "a", labelId: "mentor", action: "add", effectiveDate: "2026-09-28" }];
  const rules = [weekly("fall", "2026-09-28", "2027-01-08", 1), weekly("spring", "2027-01-09", null, 2)];
  const result = evaluate({ members: [members[0]], changes, rules, now: "2027-01-16T12:00:00.000Z", meetings: [meeting("fri", "2027-01-08", []), meeting("sat", "2027-01-09", []), meeting("sun", "2027-01-10", [])], observations: [observed("fri", "a", "present"), observed("sat", "a", "present")] })[0];
  const split = result.weeks.filter((week) => week.weekStartsOn === "2027-01-04");
  assert.deepEqual(split.map((week) => [week.segmentStartsOn, week.segmentEndsOn, week.target, week.status]), [["2027-01-04", "2027-01-08", 1, "met"], ["2027-01-09", "2027-01-10", 2, "below"]]);
  assert.equal(result.historySummaries.find((item) => item.ruleId === "fall")?.weeksMet, 1);
  assert.equal(result.historySummaries.find((item) => item.ruleId === "spring")?.weeksDue, 1);
});

test("a label with only dated rules has no requirement before its first period", () => {
  const result = evaluate({ members: [members[0]], changes: [{ memberId: "a", labelId: "mentor", action: "add", effectiveDate: "2026-09-01" }], rules: [weekly("fall", "2026-09-28", "2027-01-08", 1)], meetings: [meeting("before", "2026-09-21", []), meeting("during", "2026-09-28", [])] })[0];
  assert.deepEqual(result.rows.map((row) => row.eligibility), ["no_target", "weekly"]);
  assert.equal(result.primaryTotal, 1);
});

test("a legacy formula label without a target stops affecting new meetings after activation", () => {
  const result = evaluate({ members: [members[0]], labels: labels.map((label) => label.id === "mentor" ? { ...label, formulaEnabled: 1 } : label), changes: [{ memberId: "a", labelId: "mentor", action: "add", effectiveDate: "2026-09-01" }], policyActivatedOn: "2026-09-22", meetings: [meeting("old", "2026-09-21", []), meeting("new", "2026-09-23", [])] })[0];
  assert.deepEqual(result.rows.map((row) => row.eligibility), ["no_target", "required"]);
});

test("migrated weekly history keeps its prior audience and pooled week result before activation", () => {
  const changes: LabelChange[] = [{ memberId: "a", labelId: "mentor", action: "add", effectiveDate: "2027-01-01" }, { memberId: "a", labelId: "drive", action: "add", effectiveDate: "2027-01-01" }];
  const rules = [weekly("legacy:fall", "2027-01-04", "2027-01-08", 1), weekly("legacy:spring", "2027-01-09", "2027-01-10", 2)];
  const result = evaluate({ members: [members[0]], changes, rules, policyActivatedOn: "2027-01-11", to: "2027-01-10", now: "2027-01-16T12:00:00.000Z", meetings: [meeting("fri", "2027-01-08", []), meeting("sat", "2027-01-09", []), meeting("drive-only", "2027-01-10", ["drive"], false)], observations: [observed("fri", "a", "present"), observed("sat", "a", "present"), observed("drive-only", "a", "present")] })[0];
  assert.equal(result.rows.find((row) => row.meetingId === "drive-only")?.eligibility, "outside_audience");
  assert.equal(result.weeks.length, 1);
  assert.equal(result.weeks[0].target, 2);
  assert.equal(result.rate, 100);
  assert.equal(result.pooledRate, 100);
});

test("current label history separates percentage periods from weekly periods", () => {
  const changes: LabelChange[] = [{ memberId: "a", labelId: "student", action: "add", effectiveDate: "2026-09-01" }];
  const rules: AttendanceRule[] = [percentage(), { id: "weekly-override", labelId: "student", startsOn: "2026-09-14", endsOn: "2026-09-20", ruleType: "weekly_count", meetingsPerWeek: 1 }];
  const result = evaluate({ members: [members[0]], changes, rules, meetings: [meeting("pct", "2026-09-10", []), meeting("week", "2026-09-15", [])], observations: [observed("pct", "a", "present"), observed("week", "a", "present")] })[0];
  assert.deepEqual(result.historySummaries.map((summary) => [summary.ruleType, summary.rate, summary.weeksMet, summary.weeksDue]), [["weighted_percentage", 100, 0, 0], ["weekly_count", 100, 1, 1]]);
  assert.equal(result.rate, null);
});

test("additive migration backfills prior weekly targets and stops future Mentor seeding", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE installations(id TEXT PRIMARY KEY, created_at TEXT NOT NULL); CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE members(id TEXT PRIMARY KEY, installation_id TEXT); CREATE TABLE meetings(id TEXT PRIMARY KEY, installation_id TEXT); CREATE TABLE organization_settings(installation_id TEXT PRIMARY KEY);");
  db.prepare("INSERT INTO installations VALUES (?, ?)").run("existing", "2026-09-01T00:00:00Z");
  db.prepare("INSERT INTO organization_settings VALUES (?)").run("existing");
  db.exec(readFileSync(new URL("../apps/api/migrations/0030_member_labels.sql", import.meta.url), "utf8"));
  const mentor = db.prepare("SELECT id FROM member_labels WHERE installation_id = 'existing' AND name = 'Mentor'").get() as { id: string };
  db.prepare("INSERT INTO label_weekly_targets(id, installation_id, label_id, starts_on, ends_on, meetings_per_week, created_at) VALUES ('old-target', 'existing', ?, '2026-09-01', '2026-09-30', 1, '2026-09-01T00:00:00Z')").run(mentor.id);
  db.exec(readFileSync(new URL("../apps/api/migrations/0031_configurable_attendance.sql", import.meta.url), "utf8"));
  assert.deepEqual({ ...db.prepare("SELECT id, rule_type, meetings_per_week FROM label_attendance_rules").get() }, { id: "legacy:old-target", rule_type: "weekly_count", meetings_per_week: 1 });
  assert.deepEqual({ ...db.prepare("SELECT attendance_recent_days, attendance_policy_activated_on FROM organization_settings").get() }, { attendance_recent_days: 30, attendance_policy_activated_on: new Date().toISOString().slice(0, 10) });
  db.prepare("INSERT INTO installations VALUES (?, ?)").run("new", "2026-10-01T00:00:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM member_labels WHERE installation_id = 'new'").get()?.count, 0);
  db.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import { defaultRosterRates, loadReportAttendance, reportQuery, type AttendanceReport } from "../apps/dashboard/src/report-attendance.ts";

const report: AttendanceReport = {
  meetings: [{ id: "required", title: "Build", startsAt: "2026-01-05T10:00:00Z", endsAt: "2026-01-05T11:00:00Z", attendanceClosesAt: "2026-01-05T11:30:00Z", required: true, attendanceWeight: 1, audienceMode: "all", audienceLabelIds: [] }],
  members: [
    { member: { id: "one", memberId: "321", firstName: "A", lastName: "One", active: 1 }, currentLabelIds: [], rows: [], regularAttendance: { rate: 0, attended: 0, required: 1, from: "2026-01-01", to: "2026-02-01" }, currentCompliance: { labelId: null, labelName: null, ruleId: null, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, from: "2026-01-03", to: "2026-02-01", rate: null, unadjustedRate: null, attended: 0, required: 0 }, historySummaries: [], policy: "standard", present: 0, primaryTotal: 1, adjustedTotal: 1, rate: 0, adjustedRate: 0, pooledRate: null, weeks: [], belowTargetWeeks: [] },
    { member: { id: "two", memberId: "mentor", firstName: "B", lastName: "Two", active: 1 }, currentLabelIds: ["mentor"], rows: [], regularAttendance: { rate: 100, attended: 1, required: 1, from: "2026-01-01", to: "2026-02-01" }, currentCompliance: { labelId: "mentor", labelName: "Mentor", ruleId: "mentor-weekly", ruleType: "weekly_count", excusedHandling: null, status: "met", threshold: 1, from: "2026-01-26", to: "2026-02-01", rate: 100, unadjustedRate: 100, attended: 1, required: 1 }, historySummaries: [], policy: "weekly", present: 1, primaryTotal: 1, adjustedTotal: 1, rate: 100, adjustedRate: 100, pooledRate: 100, weeks: [], belowTargetWeeks: [] }
  ],
  labels: [{ id: "mentor", name: "Mentor", active: 1, formulaEnabled: 1 }], baseline: "2026-01-01", timeZone: "America/New_York"
};

test("roster renders authoritative server policy rates", () => {
  const result = defaultRosterRates(report);
  assert.equal(result.meetingCount, 1);
  assert.deepEqual(result.rates.one, { regularAttendance: report.members[0].regularAttendance, currentCompliance: report.members[0].currentCompliance, complete: true });
  assert.deepEqual(result.rates.two, { regularAttendance: report.members[1].regularAttendance, currentCompliance: report.members[1].currentCompliance, complete: true });
});

test("report loader forwards filters so the report and CSV can share scope", async () => {
  const calls: string[] = [];
  const filters = { from: "2026-01-01", to: "2026-02-01", meetingType: "optional" as const, labelId: "mentor", membership: "historical" as const };
  const result = await loadReportAttendance(async <T>(path: string): Promise<T> => { calls.push(path); return report as T; }, filters);
  assert.equal(result, report);
  assert.deepEqual(calls, [`/reports/attendance?${reportQuery(filters)}`]);
  assert.match(calls[0]!, /membership=historical/);
  await assert.rejects(loadReportAttendance(async () => { throw new Error("Failed"); }), /Failed/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { defaultRosterRates, loadReportAttendance, reportQuery, type AttendanceReport } from "../apps/dashboard/src/report-attendance.ts";

const report: AttendanceReport = {
  meetings: [{ id: "required", title: "Build", startsAt: "2026-01-05T10:00:00Z", endsAt: "2026-01-05T11:00:00Z", attendanceClosesAt: "2026-01-05T11:30:00Z", required: true, attendanceWeight: 1, audienceMode: "all", audienceLabelIds: [] }],
  members: [
    { member: { id: "one", memberId: "321", firstName: "A", lastName: "One", active: 1 }, currentLabelIds: [], rows: [], policy: "standard", present: 0, primaryTotal: 1, adjustedTotal: 1, rate: 0, adjustedRate: 0, pooledRate: null, weeks: [], belowTargetWeeks: [] },
    { member: { id: "two", memberId: "mentor", firstName: "B", lastName: "Two", active: 1 }, currentLabelIds: ["mentor"], rows: [], policy: "weekly", present: 1, primaryTotal: 1, adjustedTotal: 1, rate: 100, adjustedRate: 100, pooledRate: 100, weeks: [], belowTargetWeeks: [] }
  ],
  labels: [{ id: "mentor", name: "Mentor", active: 1, formulaEnabled: 1 }], baseline: "2026-01-01", timeZone: "America/New_York"
};

test("roster renders authoritative server policy rates", () => {
  const result = defaultRosterRates(report);
  assert.equal(result.meetingCount, 1);
  assert.deepEqual(result.rates.one, { rate: 0, eligible: 1, complete: true, policy: "standard", belowTargetWeeks: 0 });
  assert.deepEqual(result.rates.two, { rate: 100, eligible: 1, complete: true, policy: "weekly", belowTargetWeeks: 0 });
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

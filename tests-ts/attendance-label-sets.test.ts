import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAttendance, type AttendanceRule, type PolicyMeeting } from "../apps/api/src/attendance-policy.ts";
import { labelSetResult, reportColumnCsvLabel, reportHasLabelSets } from "../apps/api/src/report-builder.ts";
import { csvRate, labelPolicySentence, labelPolicyText, labelRateTip, labelSetKeys, leaderboardTip, memberOverallExplanation, memberPolicyExplanation, otherExcusedChoiceExample, overallRateTip, percentageExample, policyExampleLine, policyRuleText, preciseRate, rateText, statusTone, targetText, weeklyExample, weightNote, weightsTip } from "../packages/shared/src/attendance-label-sets.ts";

test("rates round to one decimal and read as people and spreadsheets expect", () => {
  assert.equal(preciseRate(14, 16), 87.5);
  assert.equal(preciseRate(29, 36), 80.6);
  assert.equal(preciseRate(13, 18), 72.2);
  assert.equal(preciseRate(5, 5), 100);
  assert.equal(preciseRate(0, 0), null);
  assert.deepEqual([rateText(87.5), rateText(80), rateText(null)], ["87.5%", "80%", "N/A"]);
  assert.deepEqual([csvRate(87.5), csvRate(80), csvRate(null)], ["87.5", "80.0", ""]);
  assert.deepEqual([targetText("weighted_percentage", 80), targetText("weekly_count", 2)], ["80%", "2 per week"]);
  assert.deepEqual(["met", "below", "pending", "not_applicable", "no_rule"].map(statusTone), ["success", "warning", "neutral", "neutral", "neutral"]);
});

test("a label set has six columns; a meetings-per-week label shows Weeks met in place of Meetings counted", () => {
  assert.deepEqual(labelSetKeys("weighted_percentage"), ["attendance.label.rate", "attendance.label.target", "attendance.label.status", "attendance.label.attended", "attendance.label.counted", "attendance.label.excused"]);
  assert.deepEqual(labelSetKeys("weekly_count"), ["attendance.label.rate", "attendance.label.target", "attendance.label.status", "attendance.label.attended", "attendance.label.weeks-met", "attendance.label.excused"]);
  assert.equal(reportHasLabelSets({ columns: [{ key: "core.member.name" }, { key: "attendance.policy.report-result", labelId: "x" }] }), false);
  assert.equal(reportHasLabelSets({ columns: [{ key: "core.member.name" }, { key: "attendance.label.status", labelId: "x" }] }), true);
  const types = new Map([["weekly", "weekly_count" as const]]);
  assert.deepEqual([
    reportColumnCsvLabel({ key: "attendance.member.regular-rate" }, "Overall rate", types),
    reportColumnCsvLabel({ key: "attendance.label.rate", labelId: "class" }, "Test Robotics Class - Attendance rate", types),
    reportColumnCsvLabel({ key: "attendance.label.target", labelId: "class" }, "Test Robotics Class - Target", types),
    reportColumnCsvLabel({ key: "attendance.label.target", labelId: "weekly" }, "Test Outreach Crew - Target", types),
    reportColumnCsvLabel({ key: "attendance.label.excused", labelId: "class" }, "Test Robotics Class - Excused", types),
    reportColumnCsvLabel({ key: "attendance.label.status", labelId: "class" }, "Test Robotics Class - Status", types),
  ], ["Overall rate (%)", "Test Robotics Class - Attendance rate (%)", "Test Robotics Class - Target (%)", "Test Outreach Crew - Target (meetings per week)", "Test Robotics Class - Excused meetings", "Test Robotics Class - Status"]);
});

test("policy summaries and worked examples use the policy's own target and excused-meeting choice", () => {
  const robotics = { ruleType: "weighted_percentage" as const, target: 80, excusedHandling: "exclude" as const, weighted: false };
  const build = { ruleType: "weighted_percentage" as const, target: 75, excusedHandling: "count_missed" as const, weighted: true };
  const outreach = { ruleType: "weekly_count" as const, target: 2, excusedHandling: null, weighted: false };
  assert.equal(labelPolicyText(robotics), "Target 80% · excused left out");
  assert.equal(labelPolicyText(build), "Target 75% · excused count as missed");
  assert.equal(labelPolicyText(build, { showWeighted: true }), "Target 75% · weighted · excused count as missed");
  assert.equal(labelPolicyText(outreach), "Target 2 per week");
  assert.equal(labelPolicySentence("Test Robotics Class", robotics), "Test Robotics Class: target 80%. Excused meetings are left out.");
  assert.equal(labelPolicySentence("Test Build Team", build), "Test Build Team: target 75%. Excused meetings count as missed. Uses meeting weights.");
  assert.equal(percentageExample(robotics), "Attended 14 of 16 counted meetings = 87.5%. 2 excused meetings aren't counted under this policy. Target 80% → Met.");
  assert.equal(percentageExample({ target: 80, excusedHandling: "count_missed" }), "Attended 14 of 18 counted meetings = 77.8%. 2 excused meetings count as missed under this policy. Target 80% → Below target.");
  assert.equal(percentageExample(build), "Attended 12 of 15 counted meetings, including 3 that count double, so it's 15 of 18 = 83.3%. Excused meetings count as missed under this policy. Target 75% → Met.");
  assert.equal(otherExcusedChoiceExample(robotics), 'With "Count as missed" the same member would have 14 of 18 = 77.8% → Below target.');
  assert.equal(otherExcusedChoiceExample({ target: 75, excusedHandling: "count_missed" }), 'With "Leave out of the attendance rate" the same member would have 14 of 16 = 87.5% → Met.');
  assert.equal(weeklyExample(2), "Attended 2 or more meetings in 11 of 12 weeks = 91.7% → Below target, because a week was missed. The current week shows In progress until it ends.");
  assert.equal(overallRateTip().example, "Attended 26 of 33 required meetings. 2 excused meetings count as missed. 3 meetings count double, so it's 29 of 36 = 80.6%.");
  assert.deepEqual(labelRateTip("Test Robotics Class", robotics), { title: "Attendance rate", definition: "The rate this label's attendance policy uses. Depending on the policy, excused meetings may be left out.", policy: "Test Robotics Class: target 80%. Excused meetings are left out.", example: percentageExample(robotics) });
  assert.match(labelRateTip("Test Outreach Crew", outreach).definition, /^Weeks met ÷ weeks due/);
  assert.match(weightsTip("Test Build Team").example, /12 of 15 meetings, including 3 that count double → 15 of 18 weighted = 83.3%/);
  assert.equal(weightNote(["Test Build Team"]), "Test Build Team uses meeting weights: some meetings count more than once. Counts are plain meetings; the rate uses the weights.");
  assert.equal(policyExampleLine(robotics), "Example: 14 of 16 counted meetings = 87.5% → Met.");
  assert.equal(policyExampleLine(outreach), "Example: 2 meetings attended this week → Met. Before the week ends, fewer than 2 → In progress.");
  assert.match(policyRuleText(robotics), /minus excused meetings, which this policy leaves out\. Meeting weights apply/);
  assert.match(policyRuleText(build), /including excused meetings, which this policy counts as missed/);
  assert.equal(leaderboardTip().title, "Ranked by Overall rate");
  const ranked = leaderboardTip({ name: "Test Robotics Class", policy: robotics });
  assert.equal(ranked.definition, "One label is chosen, so members are ranked by Test Robotics Class's Attendance rate: meetings attended ÷ meetings counted, with excused meetings left out under this policy.");
  assert.equal(ranked.switchHint, "Choose All labels to rank by Overall rate again.");
});

test("a member's own rates are explained step by step with plain counts and the weighted result", () => {
  const overall = memberOverallExplanation({ rate: 81, preciseRate: 80.6, attended: 29, required: 36, meetingsAttended: 26, meetingsRequired: 33, meetingsExcused: 2, from: "2026-08-07", to: "2026-11-04" });
  assert.equal(overall.summary, "All 33 required meetings since 2026-08-07, the same rule for everyone. Excused meetings count as missed. Some meetings have a weight other than 1.");
  assert.deepEqual(overall.steps, [{ label: "Required meetings", value: "33" }, { label: "Attended", value: "26" }, { label: "Excused, counted as missed", value: "2" }, { label: "With meeting weights", value: "29 of 36" }, { label: "Overall rate: 29 ÷ 36", value: "80.6%", result: true }]);
  const policy = memberPolicyExplanation({ labelName: "Test Robotics Class", ruleType: "weighted_percentage", excusedHandling: "exclude", status: "met", threshold: 80, rate: 88, preciseRate: 87.5, attended: 14, required: 16, meetingsAttended: 14, meetingsCounted: 16, meetingsExcused: 2 });
  assert.equal(policy.summary, "Attended 14 of 16 counted meetings = 87.5%. 2 excused meetings aren't counted under this policy. Target 80% → Met.");
  assert.deepEqual(policy.steps.map((step) => [step.label, step.value]), [["Required meetings for this label", "18"], ["Excused, left out", "−2"], ["Meetings counted", "16"], ["Meetings attended", "14"], ["Attendance rate: 14 ÷ 16", "87.5%"], ["Target 80%", "Met"]]);
  assert.equal(memberPolicyExplanation({ labelName: "Test Mentors", ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, rate: null, attended: 0, required: 0 }).statusLabel, "No policy");
});

const meeting = (id: string, date: string, weight = 1): PolicyMeeting => ({ id, title: id, startsAt: `${date}T18:00:00.000Z`, endsAt: `${date}T19:00:00.000Z`, attendanceClosesAt: `${date}T19:30:00.000Z`, required: 1, attendanceWeight: weight, audienceMode: "all", audienceLabelIds: [] });
const weeklyRule: AttendanceRule = { id: "weekly", labelId: "crew", startsOn: null, endsOn: null, ruleType: "weekly_count", meetingsPerWeek: 2 };
const evaluateWeek = (now: string, present: string[]) => evaluateAttendance({
  members: [{ id: "m", memberId: "TEST-001", firstName: "Test Student", lastName: "A", active: 1, attendanceRequiredFrom: "2026-10-01" }],
  labels: [{ id: "crew", name: "Test Outreach Crew", active: 1, formulaEnabled: 0 }], changes: [{ memberId: "m", labelId: "crew", action: "add", effectiveDate: "2026-10-01" }], rules: [weeklyRule],
  // Monday 2026-11-02 to Sunday 2026-11-08, with a meeting on Monday and on Friday; and the full week before it.
  meetings: [meeting("prev-1", "2026-10-26"), meeting("prev-2", "2026-10-28"), meeting("mon", "2026-11-02"), meeting("fri", "2026-11-06")],
  observations: present.map((meetingId) => ({ meetingId, memberId: "m", disposition: "present" as const })), timeZone: "UTC", now, from: "2026-10-26", to: "2026-11-08",
})[0]!;

test("a weekly label's set shows In progress until the current week is met, and Below target after a missed week", () => {
  const midWeek = labelSetResult(evaluateWeek("2026-11-04T12:00:00.000Z", ["prev-1", "prev-2", "mon"]), "crew");
  assert.deepEqual(midWeek, { status: "pending", ruleType: "weekly_count", rate: 100, target: 2, attended: 3, counted: null, weeksMet: 1, excused: 0 });
  const metEarly = labelSetResult(evaluateWeek("2026-11-07T12:00:00.000Z", ["prev-1", "prev-2", "mon", "fri"]), "crew");
  assert.equal(metEarly.status, "met");
  const missed = labelSetResult(evaluateWeek("2026-11-04T12:00:00.000Z", ["prev-1", "mon"]), "crew");
  assert.deepEqual([missed.status, missed.rate, missed.weeksMet], ["below", 0, 0]);
  // A member who doesn't hold the label has No policy and no values.
  assert.deepEqual(labelSetResult(evaluateWeek("2026-11-04T12:00:00.000Z", []), "other"), { status: "no_rule", ruleType: null, rate: null, target: null, attended: null, counted: null, weeksMet: null, excused: null });
});

test("a percentage label's set reads the policy's period result with plain counts, rounded to one decimal", () => {
  const rule: AttendanceRule = { id: "pct", labelId: "crew", startsOn: null, endsOn: null, ruleType: "weighted_percentage", thresholdPercent: 80, excusedHandling: "exclude" };
  const [member] = evaluateAttendance({
    members: [{ id: "m", memberId: "TEST-001", firstName: "Test Student", lastName: "A", active: 1, attendanceRequiredFrom: "2026-10-01" }],
    labels: [{ id: "crew", name: "Test Robotics Class", active: 1, formulaEnabled: 0 }], changes: [{ memberId: "m", labelId: "crew", action: "add", effectiveDate: "2026-10-01" }], rules: [rule],
    meetings: ["01", "02", "05", "06", "07", "08"].map((day, index) => meeting(`m${index}`, `2026-10-${day}`, index === 5 ? 2 : 1)),
    observations: [{ meetingId: "m0", memberId: "m", disposition: "present" }, { meetingId: "m1", memberId: "m", disposition: "present" }, { meetingId: "m2", memberId: "m", disposition: "excused" }, { meetingId: "m5", memberId: "m", disposition: "present" }],
    timeZone: "UTC", now: "2026-10-20T00:00:00.000Z", from: "2026-10-01", to: "2026-10-31",
  });
  // Weighted: 1 + 1 + 2 attended of 1 + 1 + 1 + 1 + 2 counted (the excused meeting left out) = 4 of 6 = 66.7%.
  assert.deepEqual(labelSetResult(member!, "crew"), { status: "below", ruleType: "weighted_percentage", rate: 66.7, target: 80, attended: 3, counted: 5, weeksMet: null, excused: 1 });
  assert.equal(member!.historySummaries[0]!.rate, 67);
});

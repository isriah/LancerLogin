// Audit finding A10: the policy and meeting impact previews evaluated every member's whole attendance twice, far over the
// Workers Free CPU limit for a full team. They now evaluate less, and the evaluator itself does less work per meeting.
// This test holds both to the results of the implementation they replaced, which is kept in
// fixtures/legacy-attendance-policy.ts and below for that purpose only. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAttendance, evaluateAttendanceOutline, evaluateRecentWindows, type AttendanceRule, type PolicyMeeting } from "../apps/api/src/attendance-policy.ts";
import { meetingChangeImpact, policyChangeImpact } from "../apps/api/src/attendance-impact.ts";
import { evaluateAttendance as legacyEvaluateAttendance } from "./fixtures/legacy-attendance-policy.ts";
import { random, referenceNow, referenceTeam, team, type TeamData } from "./fixtures/attendance-team.ts";

/** previewPolicyMutation's comparison as it was: everyone, evaluated in full, before and after. */
function legacyPolicyImpact(data: TeamData, rules: AttendanceRule[], recentDays: number, now: string) {
  const before = legacyEvaluateAttendance({ ...data, now });
  const after = legacyEvaluateAttendance({ ...data, rules, recentDays, now });
  return before.flatMap((item, index) => {
    const next = after[index];
    if (JSON.stringify(item.currentCompliances) === JSON.stringify(next.currentCompliances) && JSON.stringify(item.historySummaries) === JSON.stringify(next.historySummaries) && item.rate === next.rate && item.policy === next.policy && item.rows.every((row, rowIndex) => row.eligibility === next.rows[rowIndex]?.eligibility && row.ruleId === next.rows[rowIndex]?.ruleId)) return [];
    return [{ memberId: item.member.memberId, before: item.currentCompliance, after: next.currentCompliance, beforePolicies: item.currentCompliances, afterPolicies: next.currentCompliances, beforeHistory: item.historySummaries, afterHistory: next.historySummaries, beforeHistoricalRate: item.rate, afterHistoricalRate: next.rate }];
  });
}
/** meetingImpactPreview's comparison as it was. */
function legacyMeetingImpact(data: TeamData, afterMeeting: PolicyMeeting, now: string) {
  const before = legacyEvaluateAttendance({ ...data, now });
  const after = legacyEvaluateAttendance({ ...data, meetings: data.meetings.map((meeting) => meeting.id === afterMeeting.id ? afterMeeting : meeting), now });
  return before.map((item, index) => ({ memberId: item.member.memberId, beforeRate: item.rate, afterRate: after[index].rate, affectedCompletedMeetings: item.rows.filter((row, rowIndex) => row.eligibility !== after[index].rows[rowIndex]?.eligibility).length })).filter((item) => item.beforeRate !== item.afterRate || item.affectedCompletedMeetings > 0);
}
/** Equal as values and as the bytes a response would carry. */
function same(actual: unknown, expected: unknown, message: string) {
  assert.deepStrictEqual(actual, expected, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const timeZones = ["UTC", "America/New_York", "Pacific/Auckland", "Asia/Kolkata"];
/** A small team with every odd case the fixture knows, different for each seed. */
function randomTeam(seed: number): TeamData {
  const next = random(seed * 7919 + 1);
  return team({ seed, members: 4 + Math.floor(next() * 22), labels: 2 + Math.floor(next() * 6), meetings: 8 + Math.floor(next() * 70), now: referenceNow, irregular: true, timeZone: timeZones[seed % timeZones.length], attendance: 0.4 + next() * 0.5 });
}

/** The rule lists previewPolicyMutation builds: the saved rules without the one replaced or removed, then the new one. */
function policyMutations(data: TeamData, seed: number): { name: string; rules: AttendanceRule[]; recentDays: number }[] {
  const next = random(seed * 104729 + 7); const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)];
  const label = () => pick(data.labels).id; const existing = () => pick(data.rules);
  const weekly = (id: string, labelId: string, startsOn: string | null, endsOn: string | null): AttendanceRule => ({ id, labelId, startsOn, endsOn, ruleType: "weekly_count", thresholdPercent: null, meetingsPerWeek: 1 + Math.floor(next() * 3), excusedHandling: "exclude" });
  const percentage = (id: string, labelId: string, startsOn: string | null, endsOn: string | null): AttendanceRule => ({ id, labelId, startsOn, endsOn, ruleType: "weighted_percentage", thresholdPercent: pick([50, 66.6, 75, 80, 100]), meetingsPerWeek: null, excusedHandling: pick(["exclude", "count_missed"] as const) });
  const replacing = (rule: AttendanceRule, change: AttendanceRule) => [...data.rules.filter((item) => item.id !== rule.id), change];
  const unruled = data.labels.find((item) => !data.rules.some((rule) => rule.labelId === item.id))?.id ?? label();
  const a = existing(), b = existing(), c = existing(), d = existing();
  return [
    { name: "new default weekly rule", rules: [...data.rules, weekly("preview-new-rule", unruled, null, null)], recentDays: data.recentDays },
    { name: "new default percentage rule", rules: [...data.rules, percentage("preview-new-rule", label(), null, null)], recentDays: data.recentDays },
    { name: "new dated weekly rule", rules: [...data.rules, weekly("preview-new-rule", label(), "2026-06-10", "2026-12-31")], recentDays: data.recentDays },
    { name: "new dated percentage rule", rules: [...data.rules, percentage("preview-new-rule", label(), "2026-03-04", null)], recentDays: data.recentDays },
    { name: "rule replaced by a weekly rule", rules: replacing(a, weekly(a.id, a.labelId, a.startsOn ?? null, a.endsOn ?? null)), recentDays: data.recentDays },
    { name: "rule replaced by a percentage rule", rules: replacing(b, percentage(b.id, b.labelId, b.startsOn ?? null, b.endsOn ?? null)), recentDays: data.recentDays },
    { name: "rule given other dates", rules: replacing(c, { ...c, startsOn: "2026-08-05", endsOn: "2026-11-01" }), recentDays: data.recentDays },
    { name: "rule saved unchanged", rules: replacing(d, { ...d }), recentDays: data.recentDays },
    { name: "rule removed", rules: data.rules.filter((rule) => rule.id !== a.id), recentDays: data.recentDays },
    { name: "every rule of a label removed", rules: data.rules.filter((rule) => rule.labelId !== b.labelId), recentDays: data.recentDays },
    { name: "shorter recent window", rules: [...data.rules], recentDays: 7 },
    { name: "longer recent window", rules: [...data.rules], recentDays: 180 },
    { name: "same recent window", rules: [...data.rules], recentDays: data.recentDays },
    { name: "rule and recent window together", rules: replacing(c, percentage(c.id, c.labelId, null, null)), recentDays: 14 },
  ];
}
/** The meeting edits a preview is asked about: whether it is required, and who it is for. */
function meetingMutations(data: TeamData, seed: number): { name: string; meeting: PolicyMeeting }[] {
  const next = random(seed * 15485863 + 3); const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)];
  const labels = (count: number) => [...new Set(Array.from({ length: count }, () => pick(data.labels).id))];
  const ruled = [...new Set(data.rules.map((rule) => rule.labelId))];
  const some = () => pick(data.meetings); const open = data.meetings[0]; const forLabels = data.meetings.find((meeting) => meeting.audienceMode === "labels") ?? some(); const forAll = data.meetings.find((meeting) => meeting.audienceMode === "all" && Date.parse(meeting.attendanceClosesAt) < Date.parse(referenceNow)) ?? some();
  const flip = (meeting: PolicyMeeting): PolicyMeeting => ({ ...meeting, required: !meeting.required });
  const a = some(), b = some();
  return [
    { name: "required flipped", meeting: flip(forAll) },
    { name: "required flipped on a labelled meeting", meeting: flip(forLabels) },
    { name: "everyone narrowed to labels", meeting: { ...forAll, audienceMode: "labels", audienceLabelIds: labels(2) } },
    { name: "everyone narrowed to a label with a policy", meeting: { ...a, audienceMode: "labels", audienceLabelIds: [pick(ruled)] } },
    { name: "labels widened to everyone", meeting: { ...forLabels, audienceMode: "all", audienceLabelIds: [] } },
    { name: "labels swapped", meeting: { ...forLabels, audienceLabelIds: labels(1) } },
    { name: "required and audience together", meeting: { ...flip(b), audienceMode: "labels", audienceLabelIds: labels(3) } },
    { name: "a meeting not yet closed", meeting: flip(open) },
    { name: "nothing changed", meeting: { ...a } },
  ];
}

test("the evaluator returns what it returned before, for every report option", () => {
  let compared = 0;
  for (let seed = 1; seed <= 24; seed += 1) {
    const data = randomTeam(seed); const first = data.labels[0].id, second = data.labels[1].id;
    const options: Partial<Parameters<typeof evaluateAttendance>[0]>[] = [
      {}, { recentDays: 7 }, { from: "2026-05-01", to: "2026-09-15" }, { membership: "current" },
      { historicalLabelIds: [first, second], historicalLabelMatch: seed % 2 ? "all" : "any", summaryLabelIds: data.labels.map((label) => label.id) },
      { from: "2026-06-03", membership: "current", summaryLabelIds: [first] }, { to: "2026-03-03", historicalLabelId: second, membership: "historical" },
      { from: "2027-01-01" }, { rules: undefined, targets: [{ id: "target-1", labelId: first, startsOn: "2026-02-02", endsOn: "2026-10-30", meetingsPerWeek: 2 }] },
    ];
    for (const option of options) {
      const input = { ...data, now: referenceNow, ...option };
      const expected = legacyEvaluateAttendance(input);
      same(evaluateAttendance(input), expected, `seed ${seed} ${JSON.stringify(option)}`);
      // The outline is the same result with each row cut down to what the previews compare.
      const outline = evaluateAttendanceOutline(input);
      same(outline.map((item) => ({ ...item, rows: null })), expected.map((item) => ({ ...item, rows: null })), `seed ${seed} outline`);
      same(outline.map((item) => item.rows), expected.map((item) => item.rows.map((row) => ({ eligibility: row.eligibility, ruleId: row.ruleId }))), `seed ${seed} outline rows`);
      compared += 1;
    }
    // Several recent windows from one reading equal one evaluation each.
    const windows = [data.recentDays, 3, 90];
    same(evaluateRecentWindows({ ...data, now: referenceNow }, windows), windows.map((recentDays) => evaluateAttendanceOutline({ ...data, recentDays, now: referenceNow })), `seed ${seed} recent windows`);
  }
  assert.equal(compared, 24 * 9);
});

test("the evaluator reads rows added to the same arrays after an earlier evaluation", () => {
  const data = randomTeam(5); const input = { ...data, observations: data.observations.slice(0, -40), meetings: [...data.meetings], now: referenceNow };
  same(evaluateAttendance(input), legacyEvaluateAttendance(input), "before");
  input.observations.push(...data.observations.slice(-40));
  const edited = input.meetings.find((meeting) => Date.parse(meeting.attendanceClosesAt) < Date.parse(referenceNow))!;
  edited.startsAt = new Date(Date.parse(edited.startsAt) - 3 * 86_400_000).toISOString();
  input.members[0].attendanceRequiredFrom = "2026-07-01";
  same(evaluateAttendance(input), legacyEvaluateAttendance(input), "after");
});

test("policy impact previews match evaluating everyone twice, over random teams and every kind of change", () => {
  let compared = 0, withImpact = 0;
  for (let seed = 1; seed <= 24; seed += 1) {
    const data = randomTeam(seed);
    for (const mutation of policyMutations(data, seed)) {
      const expected = legacyPolicyImpact(data, mutation.rules, mutation.recentDays, referenceNow);
      same(policyChangeImpact(data, mutation.rules, mutation.recentDays, referenceNow), expected, `seed ${seed}: ${mutation.name}`);
      compared += 1; if (expected.length) withImpact += 1;
    }
  }
  assert.equal(compared, 24 * 14);
  // The comparison means little unless most changes change something.
  assert.ok(withImpact > compared / 2, `${withImpact} of ${compared} changes had an impact`);
});

test("a meeting change that only adds a week to a pre-activation weekly target still reaches the member", () => {
  // The member's eligibility for the meeting stays "weekly" under the first label's rule; widening the audience to the
  // second label only gives that label's legacy target a week it did not have, which moves the rate from 50% to 67%.
  const meeting = (id: string, date: string): PolicyMeeting => ({ id, title: id, startsAt: `${date}T18:00:00.000Z`, endsAt: `${date}T20:00:00.000Z`, attendanceClosesAt: `${date}T20:30:00.000Z`, required: 1, attendanceWeight: 1, audienceMode: "labels", audienceLabelIds: ["a"] });
  const data: TeamData = {
    members: [{ id: "member-1", memberId: "TEST-1", firstName: "Test Student", lastName: "A", active: 1, attendanceRequiredFrom: "2026-01-01" }, { id: "member-2", memberId: "TEST-2", firstName: "Test Student", lastName: "B", active: 1, attendanceRequiredFrom: "2026-01-01" }],
    labels: [{ id: "a", name: "Test Label A", active: 1, formulaEnabled: 0 }, { id: "b", name: "Test Label B", active: 1, formulaEnabled: 1 }],
    changes: [{ memberId: "member-1", labelId: "a", action: "add", effectiveDate: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z" }, { memberId: "member-1", labelId: "b", action: "add", effectiveDate: "2026-01-01", createdAt: "2026-01-01T00:00:01.000Z" }, { memberId: "member-2", labelId: "a", action: "add", effectiveDate: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z" }],
    rules: [{ id: "rule-a", labelId: "a", startsOn: null, endsOn: null, ruleType: "weekly_count", meetingsPerWeek: 1 }, { id: "legacy:b", labelId: "b", startsOn: "2026-01-01", endsOn: "2026-09-30", ruleType: "weekly_count", meetingsPerWeek: 1 }],
    meetings: [meeting("meeting-2", "2026-09-15"), meeting("meeting-1", "2026-09-08")],
    observations: [{ meetingId: "meeting-1", memberId: "member-1", disposition: "present" }, { meetingId: "meeting-1", memberId: "member-2", disposition: "present" }],
    timeZone: "UTC", baseline: null, recentDays: 30, policyActivatedOn: "2026-10-01",
  };
  const widened = { ...data.meetings[1], audienceLabelIds: ["a", "b"] };
  const expected = legacyMeetingImpact(data, widened, referenceNow);
  assert.deepEqual(expected, [{ memberId: "TEST-1", beforeRate: 50, afterRate: 67, affectedCompletedMeetings: 0 }]);
  same(meetingChangeImpact(data, widened, referenceNow), expected, "legacy week");
});

test("meeting impact previews match evaluating everyone twice, over random teams and every kind of change", () => {
  let compared = 0, withImpact = 0;
  for (let seed = 1; seed <= 24; seed += 1) {
    const data = randomTeam(seed);
    for (const mutation of meetingMutations(data, seed)) {
      const expected = legacyMeetingImpact(data, mutation.meeting, referenceNow);
      same(meetingChangeImpact(data, mutation.meeting, referenceNow), expected, `seed ${seed}: ${mutation.name}`);
      compared += 1; if (expected.length) withImpact += 1;
    }
  }
  assert.equal(compared, 24 * 9);
  assert.ok(withImpact > compared / 3, `${withImpact} of ${compared} changes had an impact`);
});

test("the reference team's previews match, and cost a small fraction of what they did", () => {
  const data = referenceTeam(); const now = referenceNow;
  const median = (work: () => unknown) => { const times = [0, 0, 0].map(() => { const started = performance.now(); work(); return performance.now() - started; }); return times.sort((a, b) => a - b)[1]; };
  const rule = data.rules.find((item) => item.ruleType === "weighted_percentage")!;
  const rules = [...data.rules.filter((item) => item.id !== rule.id), { ...rule, thresholdPercent: 95 }];
  const closed = data.meetings.find((meeting) => meeting.audienceMode === "all" && Date.parse(meeting.attendanceClosesAt) < Date.parse(now))!;
  const flipped = { ...closed, required: !closed.required };
  const cases: [string, () => unknown, () => unknown][] = [
    ["rule change", () => policyChangeImpact(data, rules, data.recentDays, now), () => legacyPolicyImpact(data, rules, data.recentDays, now)],
    ["recent window", () => policyChangeImpact(data, data.rules, 14, now), () => legacyPolicyImpact(data, data.rules, 14, now)],
    ["meeting made optional", () => meetingChangeImpact(data, flipped, now), () => legacyMeetingImpact(data, flipped, now)],
  ];
  for (const [name, current, legacy] of cases) {
    const expected = legacy() as unknown[];
    same(current(), expected, name);
    assert.ok(expected.length > 0, `${name} affects someone`);
    // Both are timed here, one after the other, so a busy machine slows them alike. Measured: 25 to 100 times faster.
    const was = median(legacy), is = median(current);
    assert.ok(is * 8 < was, `${name}: ${is.toFixed(1)} ms now, ${was.toFixed(1)} ms before`);
  }
});

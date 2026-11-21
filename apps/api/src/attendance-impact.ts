// What a proposed attendance policy or meeting change would do to members' results, for the confirmation previews.
//
// A preview compares every affected member's result before and after the change. On Workers Free that has to fit in
// about 10 ms of CPU with the rest of the request, so each preview evaluates only the members the change can reach, skips
// the per-meeting detail it never reads, and shares one reading of the attendance where the change allows it. The results
// are exactly those of evaluating everyone twice; tests-ts/attendance-impact-equivalence.test.ts holds them to that.
import { evaluateAttendanceOutline, evaluateRecentWindows, type AttendanceInput, type AttendanceRule, type PolicyCompliance, type PolicyHistory, type PolicyMeeting, type PolicyMemberOutline } from "./attendance-policy.ts";

export type ImpactData = Pick<AttendanceInput, "members" | "labels" | "changes" | "meetings" | "observations" | "timeZone" | "policyActivatedOn"> & { rules: AttendanceRule[]; recentDays: number };
export type PolicyImpact = { memberId: string; before: PolicyCompliance; after: PolicyCompliance; beforePolicies: PolicyCompliance[]; afterPolicies: PolicyCompliance[]; beforeHistory: PolicyHistory[]; afterHistory: PolicyHistory[]; beforeHistoricalRate: number | null; afterHistoricalRate: number | null };
export type MeetingImpact = { memberId: string; beforeRate: number | null; afterRate: number | null; affectedCompletedMeetings: number };

/** Labels whose rules, in order, are not the very same rules in both lists. */
function labelsWithChangedRules(before: AttendanceRule[], after: AttendanceRule[]): Set<string> {
  const byLabel = (rules: AttendanceRule[]) => { const grouped = new Map<string, AttendanceRule[]>(); for (const rule of rules) { const own = grouped.get(rule.labelId); if (own) own.push(rule); else grouped.set(rule.labelId, [rule]); } return grouped; };
  const was = byLabel(before), is = byLabel(after); const changed = new Set<string>();
  for (const labelId of new Set([...was.keys(), ...is.keys()])) {
    const a = was.get(labelId) ?? [], b = is.get(labelId) ?? [];
    if (a.length !== b.length || a.some((rule, index) => rule !== b[index])) changed.add(labelId);
  }
  return changed;
}

/**
 * Members whose current policies, policy history or attendance rate change when `rules` and `recentDays` replace the saved
 * ones, in roster order. `rules` must reuse the saved rule objects it keeps. `now` is for tests.
 */
export function policyChangeImpact(data: ImpactData, rules: AttendanceRule[], recentDays: number, now: string = new Date().toISOString()): PolicyImpact[] {
  const changedLabels = labelsWithChangedRules(data.rules, rules);
  let before: PolicyMemberOutline[], after: PolicyMemberOutline[];
  if (!changedLabels.size) {
    // Only the recent window can differ, and it decides nothing but which meetings a current percentage policy counts.
    if (recentDays === data.recentDays) return [];
    [before, after] = evaluateRecentWindows({ ...data, now }, [data.recentDays, recentDays]);
  } else {
    // A label's rules reach only members who have held that label: nobody else's labels ever select them. A different
    // recent window reaches everyone.
    const held = new Set<string>();
    for (const change of data.changes) if (changedLabels.has(change.labelId)) held.add(change.memberId);
    const members = recentDays === data.recentDays ? data.members.filter((member) => held.has(member.id)) : data.members;
    before = evaluateAttendanceOutline({ ...data, members, now });
    after = evaluateAttendanceOutline({ ...data, members, rules, recentDays, now });
  }
  return before.flatMap((item, index) => {
    const next = after[index];
    if (JSON.stringify(item.currentCompliances) === JSON.stringify(next.currentCompliances) && JSON.stringify(item.historySummaries) === JSON.stringify(next.historySummaries) && item.rate === next.rate && item.policy === next.policy && item.rows.every((row, rowIndex) => row.eligibility === next.rows[rowIndex]?.eligibility && row.ruleId === next.rows[rowIndex]?.ruleId)) return [];
    return [{ memberId: item.member.memberId, before: item.currentCompliance, after: next.currentCompliance, beforePolicies: item.currentCompliances, afterPolicies: next.currentCompliances, beforeHistory: item.historySummaries, afterHistory: next.historySummaries, beforeHistoricalRate: item.rate, afterHistoricalRate: next.rate }];
  });
}

/**
 * Members whose attendance rate or eligibility for the meeting changes when `replacement` takes the place of the saved
 * meeting with its id, in roster order. Only whether the meeting is required and who it is for may differ. `now` is for tests.
 */
export function meetingChangeImpact(data: ImpactData, replacement: PolicyMeeting, now: string = new Date().toISOString()): MeetingImpact[] {
  const original = data.meetings.find((meeting) => meeting.id === replacement.id);
  if (!original) return [];
  // The meeting on its own shows who the change reaches: a member's rate reads it only through their eligibility for it
  // and through what it adds to their weekly policies' weeks. A member with both unchanged has every figure unchanged.
  const alone = evaluateAttendanceOutline({ ...data, meetings: [original], now });
  const replaced = evaluateAttendanceOutline({ ...data, meetings: [replacement], now });
  const members = data.members.filter((_, index) => alone[index].rows.length !== replaced[index].rows.length || alone[index].rows[0]?.eligibility !== replaced[index].rows[0]?.eligibility || JSON.stringify(alone[index].weeks) !== JSON.stringify(replaced[index].weeks));
  if (!members.length) return [];
  const before = evaluateAttendanceOutline({ ...data, members, now });
  const after = evaluateAttendanceOutline({ ...data, members, meetings: data.meetings.map((meeting) => meeting.id === replacement.id ? replacement : meeting), now });
  return before.map((item, index) => ({ memberId: item.member.memberId, beforeRate: item.rate, afterRate: after[index].rate, affectedCompletedMeetings: item.rows.filter((row, rowIndex) => row.eligibility !== after[index].rows[rowIndex]?.eligibility).length })).filter((item) => item.beforeRate !== item.afterRate || item.affectedCompletedMeetings > 0);
}

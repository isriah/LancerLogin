// Per-label column sets ("Attendance by label") and the plain-language explanations of every attendance rate. The API,
// the report table, the Leaderboard, member profiles and Settings all read these, so a rate is worded, rounded and
// explained the same way everywhere. Rates come from the attendance calculation; this module only formats them.
import { attendanceStatusText, attendanceTerms, type AttendancePolicyStatus } from "./attendance-terms.ts";

/** Report fields that make up a label's column set. Each needs a label; the set adds them together. */
export const labelSetFields = Object.freeze({
  rate: "attendance.label.rate",
  target: "attendance.label.target",
  status: "attendance.label.status",
  attended: "attendance.label.attended",
  counted: "attendance.label.counted",
  weeksMet: "attendance.label.weeks-met",
  excused: "attendance.label.excused",
});
/** Short column names: the label's name heads the set, so the columns under it don't repeat it. */
export const labelSetFieldLabels: Readonly<Record<string, string>> = Object.freeze({
  [labelSetFields.rate]: "Attendance rate",
  [labelSetFields.target]: "Target",
  [labelSetFields.status]: "Status",
  [labelSetFields.attended]: "Meetings attended",
  [labelSetFields.counted]: "Meetings counted",
  [labelSetFields.weeksMet]: "Weeks met",
  [labelSetFields.excused]: "Excused",
});
const setFieldIds = new Set<string>(Object.values(labelSetFields));
export const isLabelSetField = (key: string): boolean => setFieldIds.has(key);

export type LabelPolicyType = "weighted_percentage" | "weekly_count";
export type ExcusedChoice = "exclude" | "count_missed";
/** A label's attendance policy in effect today, as the report catalog lists it. `weighted`: some of its meetings have a weight other than 1. */
export type LabelPolicySummary = { labelId: string; ruleType: LabelPolicyType; target: number; excusedHandling: ExcusedChoice | null; weighted: boolean };

/** The six fields of a label's set, in table order. A meetings-per-week policy shows Weeks met in place of Meetings counted. */
export function labelSetKeys(ruleType?: LabelPolicyType | null): string[] {
  const field = labelSetFields;
  return ruleType === "weekly_count" ? [field.rate, field.target, field.status, field.attended, field.weeksMet, field.excused] : [field.rate, field.target, field.status, field.attended, field.counted, field.excused];
}
/** The most labels one report's sets can hold: Member, Overall rate and five sets of six fill the 32-column limit. */
export const maxLabelSets = 5;

/** A rate to one decimal place, as reports, the Leaderboard and profiles show it; null when nothing was counted. */
export const preciseRate = (numerator: number, denominator: number): number | null => denominator > 0 ? Math.round(1000 * numerator / denominator) / 10 : null;
/** Whether a rate meets a percentage target, compared before rounding as the attendance calculation does. */
export const meetsTarget = (numerator: number, denominator: number, target: number): boolean => denominator > 0 && 100 * numerator / denominator >= target;
/** A rate for people: "87.5%", or "80%" when it is whole. */
export const rateText = (rate: number | null | undefined): string => rate === null || rate === undefined ? "N/A" : `${rate}%`;
/** A rate for CSV: a plain number with one decimal place, such as 87.5; empty when there is no rate. */
export const csvRate = (rate: number | null | undefined): string => rate === null || rate === undefined ? "" : rate.toFixed(1);
/** A policy target for people: "80%" or "2 per week". */
export const targetText = (ruleType: LabelPolicyType, target: number): string => ruleType === "weekly_count" ? `${target} per week` : `${target}%`;

/** The ui-status tone that goes with a policy status; the pill always shows the status words too. */
export function statusTone(status: string): "success" | "warning" | "neutral" {
  return status === "met" ? "success" : status === "below" ? "warning" : "neutral";
}

/** The policy in a few words, for a label set's heading and the label pickers: "Target 80% · excused left out". */
export function labelPolicyText(policy: Pick<LabelPolicySummary, "ruleType" | "target" | "excusedHandling" | "weighted">, { showWeighted = false } = {}): string {
  if (policy.ruleType === "weekly_count") return `Target ${targetText(policy.ruleType, policy.target)}`;
  return [`Target ${targetText(policy.ruleType, policy.target)}`, showWeighted && policy.weighted ? "weighted" : "", policy.excusedHandling === "count_missed" ? "excused count as missed" : "excused left out"].filter(Boolean).join(" · ");
}
/** The policy in one sentence, for tips: "Test Robotics Class: target 80%. Excused meetings are left out." */
export function labelPolicySentence(name: string, policy: Pick<LabelPolicySummary, "ruleType" | "target" | "excusedHandling" | "weighted">): string {
  if (policy.ruleType === "weekly_count") return `${name}: target ${policy.target} ${policy.target === 1 ? "meeting" : "meetings"} per week. A week is met once that many meetings are attended.`;
  return `${name}: target ${policy.target}%. ${policy.excusedHandling === "count_missed" ? "Excused meetings count as missed." : "Excused meetings are left out."}${policy.weighted ? " Uses meeting weights." : ""}`;
}

const statusOf = (numerator: number, denominator: number, target: number): AttendancePolicyStatus => denominator === 0 ? "not_applicable" : meetsTarget(numerator, denominator, target) ? "met" : "below";
const meetings = (count: number) => `${count} ${count === 1 ? "meeting" : "meetings"}`;
const excusedClause = (count: number, handling: ExcusedChoice | null) => `${count} excused ${count === 1 ? "meeting" : "meetings"} ${handling === "count_missed" ? (count === 1 ? "counts" : "count") + " as missed" : count === 1 ? "isn't counted" : "aren't counted"} under this policy.`;

/**
 * Fixed sample numbers for worked examples, so a tip reads the same whatever the table is sorted by: 18 required
 * meetings, 14 attended and 2 excused; with weights, 12 of 15 attended including 3 that count double.
 */
export const exampleSample = Object.freeze({ required: 18, attended: 14, excused: 2, weighted: { attended: 12, counted: 15, double: 3 }, overall: { required: 33, attended: 26, excused: 2, double: 3 }, weekly: { weeksDue: 12, weeksMet: 11 } });

/** A percentage policy's worked example with the sample numbers, ending in the status the target gives. */
export function percentageExample(policy: { target: number; excusedHandling: ExcusedChoice | null; weighted?: boolean }): string {
  const target = `Target ${policy.target}%`;
  if (policy.weighted) {
    const { attended, counted, double } = exampleSample.weighted;
    const numerator = attended + double, denominator = counted + double;
    return `Attended ${attended} of ${counted} counted meetings, including ${double} that count double, so it's ${numerator} of ${denominator} = ${rateText(preciseRate(numerator, denominator))}. ${policy.excusedHandling === "count_missed" ? "Excused meetings count as missed under this policy." : "Excused meetings aren't counted under this policy."} ${target} → ${attendanceStatusText(statusOf(numerator, denominator, policy.target))}.`;
  }
  const { required, attended, excused } = exampleSample;
  const counted = policy.excusedHandling === "count_missed" ? required : required - excused;
  return `Attended ${attended} of ${counted} counted meetings = ${rateText(preciseRate(attended, counted))}. ${excusedClause(excused, policy.excusedHandling)} ${target} → ${attendanceStatusText(statusOf(attended, counted, policy.target))}.`;
}
/** What the same sample member would get with the other excused-meeting choice, which people most often get wrong. */
export function otherExcusedChoiceExample(policy: { target: number; excusedHandling: ExcusedChoice | null }): string {
  const { required, attended, excused } = exampleSample;
  const other: ExcusedChoice = policy.excusedHandling === "count_missed" ? "exclude" : "count_missed";
  const counted = other === "count_missed" ? required : required - excused;
  return `With "${other === "count_missed" ? "Count as missed" : "Leave out of the attendance rate"}" the same member would have ${attended} of ${counted} = ${rateText(preciseRate(attended, counted))} → ${attendanceStatusText(statusOf(attended, counted, policy.target))}.`;
}
/** A meetings-per-week policy's worked example with the sample weeks. */
export function weeklyExample(target: number): string {
  const { weeksDue, weeksMet } = exampleSample.weekly;
  return `Attended ${target} or more meetings in ${weeksMet} of ${weeksDue} weeks = ${rateText(preciseRate(weeksMet, weeksDue))} → ${attendanceStatusText("below")}, because a week was missed. The current week shows ${attendanceStatusText("pending")} until it ends.`;
}
/** The Overall rate's worked example with the sample numbers. */
export function overallExample(): string {
  const { required, attended, excused, double } = exampleSample.overall;
  return `Attended ${attended} of ${required} required meetings. ${excused} excused meetings count as missed. ${double} meetings count double, so it's ${attended + double} of ${required + double} = ${rateText(preciseRate(attended + double, required + double))}.`;
}
/** One line under a saved policy in Settings: the sample numbers under that policy. */
export function policyExampleLine(policy: { ruleType: LabelPolicyType; target: number; excusedHandling: ExcusedChoice | null }): string {
  if (policy.ruleType === "weekly_count") return `Example: ${meetings(policy.target)} attended this week → ${attendanceStatusText("met")}. Before the week ends, fewer than ${policy.target} → ${attendanceStatusText("pending")}.`;
  const { required, attended } = exampleSample;
  const counted = policy.excusedHandling === "count_missed" ? required : required - exampleSample.excused;
  return `Example: ${attended} of ${counted} counted meetings = ${rateText(preciseRate(attended, counted))} → ${attendanceStatusText(statusOf(attended, counted, policy.target))}.`;
}
/** The rule in plain words for the policy form's "How this is calculated" box. */
export function policyRuleText(policy: { ruleType: LabelPolicyType; target: number; excusedHandling: ExcusedChoice | null }): string {
  if (policy.ruleType === "weekly_count") return `Each week is met when a member attends ${meetings(policy.target)}. Attendance rate = weeks met ÷ weeks due. The current week shows ${attendanceStatusText("pending")} until it ends; any missed week makes the status ${attendanceStatusText("below")}. Meetings count once each.`;
  return `Attendance rate = meetings attended ÷ meetings counted. Counted meetings are the required meetings for members with this label${policy.excusedHandling === "count_missed" ? ", including excused meetings, which this policy counts as missed" : ", minus excused meetings, which this policy leaves out"}. Meeting weights apply: a meeting with weight 2 counts twice.`;
}

export type RateTip = { title: string; definition: string; policy?: string; example: string };
/** A report column header tip for a label's Attendance rate: the definition, the policy in one line and a worked example. */
export function labelRateTip(name: string, policy?: Pick<LabelPolicySummary, "ruleType" | "target" | "excusedHandling" | "weighted">): RateTip {
  const definition = policy?.ruleType === "weekly_count" ? "Weeks met ÷ weeks due under this label's meetings-per-week policy." : attendanceTerms.attendanceRate.definition;
  if (!policy) return { title: attendanceTerms.attendanceRate.term, definition, example: `${name} has no attendance policy, so its set shows No policy.` };
  return { title: attendanceTerms.attendanceRate.term, definition, policy: labelPolicySentence(name, policy), example: policy.ruleType === "weekly_count" ? weeklyExample(policy.target) : percentageExample({ target: policy.target, excusedHandling: policy.excusedHandling, weighted: policy.weighted }) };
}
/** The Overall rate tip: its definition and the worked example. */
export function overallRateTip(): RateTip {
  return { title: attendanceTerms.overallRate.term, definition: attendanceTerms.overallRate.definition, example: overallExample() };
}
/** The tip on a label set's Weighted tag. */
export function weightsTip(name: string): RateTip {
  const { attended, counted, double } = exampleSample.weighted;
  return { title: "Meeting weights", definition: `${name}'s policy uses meeting weights: a meeting with weight 2 counts twice. The counts here are plain meetings, so the rate can differ from attended ÷ counted.`, example: `Attended ${attended} of ${counted} meetings, including ${double} that count double → ${attended + double} of ${counted + double} weighted = ${rateText(preciseRate(attended + double, counted + double))}.` };
}
/** The note under a table whose sets include weighted policies. */
export const weightNote = (names: readonly string[]): string => `${names.join(", ")} ${names.length === 1 ? "uses" : "use"} meeting weights: some meetings count more than once. Counts are plain meetings; the rate uses the weights.`;

/** The Leaderboard heading tip: what the ranking uses, a worked example, and how to switch. */
export function leaderboardTip(label?: { name: string; policy: Pick<LabelPolicySummary, "ruleType" | "target" | "excusedHandling" | "weighted"> }): RateTip & { switchHint: string } {
  if (!label) return { title: "Ranked by Overall rate", definition: `${attendanceTerms.overallRate.definition} Overall rate follows these filters. Below target uses each policy's current-standing window.`, example: overallExample(), switchHint: "Choose one label in Label group to rank by that label's Attendance rate." };
  const { name, policy } = label;
  const basis = policy.ruleType === "weekly_count" ? "weeks met ÷ weeks due" : `meetings attended ÷ meetings counted, with excused meetings ${policy.excusedHandling === "count_missed" ? "counted as missed" : "left out"} under this policy`;
  return { title: "Ranked by Attendance rate", definition: `One label is chosen, so members are ranked by ${name}'s Attendance rate: ${basis}.`, example: policy.ruleType === "weekly_count" ? weeklyExample(policy.target) : percentageExample({ target: policy.target, excusedHandling: policy.excusedHandling, weighted: policy.weighted }), switchHint: "Choose All labels to rank by Overall rate again." };
}

export type CalcStep = { label: string; value: string; result?: boolean };
export type CalcGroup = { title: string; summary: string; steps: CalcStep[]; status?: AttendancePolicyStatus; statusLabel?: string };
/** A member's own Overall rate, explained step by step for their profile. */
export function memberOverallExplanation(regular: { rate: number | null; preciseRate?: number | null; attended: number; required: number; from: string | null; to: string; meetingsAttended?: number; meetingsRequired?: number; meetingsExcused?: number }): CalcGroup {
  const rate = regular.preciseRate ?? preciseRate(regular.attended, regular.required);
  const plainRequired = regular.meetingsRequired ?? regular.required, plainAttended = regular.meetingsAttended ?? regular.attended, excused = regular.meetingsExcused ?? 0;
  const weighted = regular.required !== plainRequired || regular.attended !== plainAttended;
  const since = regular.from ? ` since ${regular.from}` : "";
  const steps: CalcStep[] = [{ label: "Required meetings", value: String(plainRequired) }, { label: "Attended", value: String(plainAttended) }, { label: "Excused, counted as missed", value: String(excused) }];
  if (weighted) steps.push({ label: "With meeting weights", value: `${formatCount(regular.attended)} of ${formatCount(regular.required)}` });
  steps.push({ label: `Overall rate: ${formatCount(regular.attended)} ÷ ${formatCount(regular.required)}`, value: rate === null ? "N/A" : rateText(rate), result: true });
  return { title: attendanceTerms.overallRate.term, summary: plainRequired ? `All ${plainRequired} required ${plainRequired === 1 ? "meeting" : "meetings"}${since}, the same rule for everyone. Excused meetings count as missed.${weighted ? " Some meetings have a weight other than 1." : ""}` : `No required meetings${since} yet, so there is no Overall rate.`, steps };
}
/** A member's own result under one label's policy, explained step by step for their profile. */
export function memberPolicyExplanation(policy: { labelName: string | null; ruleType: LabelPolicyType | null; excusedHandling: ExcusedChoice | null; status: AttendancePolicyStatus; threshold: number | null; rate: number | null; preciseRate?: number | null; attended: number; required: number; meetingsAttended?: number; meetingsCounted?: number; meetingsExcused?: number }): CalcGroup {
  const title = policy.labelName ?? attendanceTerms.attendancePolicy.term;
  if (!policy.ruleType || policy.threshold === null || policy.status === "no_rule") return { title, summary: "This label has no attendance policy.", steps: [], status: "no_rule", statusLabel: attendanceStatusText("no_rule") };
  const statusLabel = attendanceStatusText(policy.status);
  if (policy.ruleType === "weekly_count") {
    const attended = policy.meetingsAttended ?? policy.attended;
    return { title, summary: `This week: attended ${meetings(attended)} of the ${policy.threshold} needed. The week is ${statusLabel === attendanceStatusText("pending") ? "still in progress" : "complete"}.`, steps: [{ label: "Meetings needed each week", value: String(policy.threshold) }, { label: "Attended this week", value: String(attended) }, { label: `Target ${targetText(policy.ruleType, policy.threshold)}`, value: statusLabel, result: true }], status: policy.status, statusLabel };
  }
  const plainAttended = policy.meetingsAttended ?? policy.attended, counted = policy.meetingsCounted ?? policy.required, excused = policy.meetingsExcused ?? 0;
  const weighted = policy.required !== counted || policy.attended !== plainAttended;
  const rate = policy.preciseRate ?? preciseRate(policy.attended, policy.required);
  const exclude = policy.excusedHandling !== "count_missed";
  const steps: CalcStep[] = exclude
    ? [{ label: "Required meetings for this label", value: String(counted + excused) }, { label: "Excused, left out", value: excused ? `−${excused}` : "0" }, { label: "Meetings counted", value: String(counted) }, { label: "Meetings attended", value: String(plainAttended) }]
    : [{ label: `Meetings counted (${excused ? `${excused} excused, counted as missed` : "no excused meetings"})`, value: String(counted) }, { label: "Meetings attended", value: String(plainAttended) }];
  if (weighted) steps.push({ label: "With meeting weights", value: `${formatCount(policy.attended)} of ${formatCount(policy.required)}` });
  steps.push({ label: `Attendance rate: ${formatCount(policy.attended)} ÷ ${formatCount(policy.required)}`, value: rate === null ? "N/A" : rateText(rate), result: true });
  steps.push({ label: `Target ${targetText(policy.ruleType, policy.threshold)}`, value: statusLabel });
  const summary = counted === 0 ? `No counted meetings yet, so the status is ${statusLabel}.` : `Attended ${plainAttended} of ${counted} counted meetings${weighted ? `; with meeting weights that's ${formatCount(policy.attended)} of ${formatCount(policy.required)}` : ""} = ${rateText(rate)}. ${excused ? excusedClause(excused, policy.excusedHandling) + " " : ""}Target ${policy.threshold}% → ${statusLabel}.`;
  return { title, summary, steps, status: policy.status, statusLabel };
}
const formatCount = (value: number) => String(Math.round(value * 100) / 100);

export type PolicyMember = { id: string; memberId: string; firstName: string; lastName: string; active: number | boolean; attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null };
export type PolicyLabel = { id: string; name: string; active: number | boolean; formulaEnabled: number | boolean };
export type LabelChange = { memberId: string; labelId: string; action: "add" | "remove"; effectiveDate: string; createdAt?: string };
export type WeeklyTarget = { id: string; labelId: string; startsOn: string; endsOn: string; meetingsPerWeek: number };
export type AttendanceRule = { id: string; labelId: string; startsOn?: string | null; endsOn?: string | null; ruleType: "weighted_percentage" | "weekly_count"; thresholdPercent?: number | null; meetingsPerWeek?: number | null };
export type PolicyMeeting = { id: string; title: string; startsAt: string; endsAt: string; attendanceClosesAt: string; required: number | boolean; attendanceWeight: number; audienceMode: "all" | "labels"; audienceLabelIds: string[]; isTest?: number | boolean };
export type Observation = { meetingId: string; memberId: string; disposition: "present" | "active" | "absent" | "excused"; checkedInAt?: string | null; checkedOutAt?: string | null; reason?: string | null };
export type Eligibility = "required" | "optional" | "outside_audience" | "before_start" | "weekly" | "no_target";
export type PolicyRow = { meetingId: string; memberId: string; disposition: Observation["disposition"]; eligibility: Eligibility; policy: "standard" | "weekly"; ruleId?: string | null; rateEligible: boolean; attended: boolean; weight: number; audience: string; memberLabelIds: string[]; checkedInAt?: string | null; checkedOutAt?: string | null; reason?: string | null };
export type PolicyWeek = { weekStartsOn: string; weekEndsOn: string; segmentStartsOn: string; segmentEndsOn: string; labelId: string; ruleId: string; target: number; opportunities: number; attended: number; excused: number; numerator: number; denominator: number; adjustedDenominator: number; rate: number | null; adjustedRate: number | null; belowTarget: boolean; status: "met" | "below" | "pending" | "not_applicable" };
export type PolicyCompliance = { labelId: string | null; ruleId: string | null; ruleType: AttendanceRule["ruleType"] | null; status: "met" | "below" | "pending" | "not_applicable" | "no_rule"; threshold: number | null; from: string; to: string; rate: number | null; unadjustedRate: number | null; attended: number; required: number };
export type PolicyHistory = { ruleId: string; labelId: string; ruleType: AttendanceRule["ruleType"]; startsOn: string | null; endsOn: string | null; rate: number | null; unadjustedRate: number | null; weeksMet: number; weeksDue: number; status: string };
export type PolicyMemberResult = { member: PolicyMember; currentLabelIds: string[]; rows: PolicyRow[]; policy: "standard" | "weekly" | "mixed"; present: number; primaryTotal: number; adjustedTotal: number; rate: number | null; adjustedRate: number | null; pooledRate: number | null; weeks: PolicyWeek[]; belowTargetWeeks: PolicyWeek[]; currentCompliance: PolicyCompliance; historySummaries: PolicyHistory[] };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
export function localDate(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return field("year") + "-" + field("month") + "-" + field("day");
}
function shiftDate(date: string, days: number): string { const result = new Date(date + "T12:00:00.000Z"); result.setUTCDate(result.getUTCDate() + days); return result.toISOString().slice(0, 10); }
function weekStart(date: string): string { const day = new Date(date + "T12:00:00.000Z").getUTCDay(); return shiftDate(date, -(day === 0 ? 6 : day - 1)); }
const rate = (numerator: number, denominator: number): number | null => denominator > 0 ? Math.round(100 * numerator / denominator) : null;
const rawRate = (numerator: number, denominator: number): number | null => denominator > 0 ? 100 * numerator / denominator : null;
function ruleOn(rules: AttendanceRule[], labelId: string, date: string): AttendanceRule | undefined {
  return rules.find((rule) => rule.labelId === labelId && rule.startsOn && rule.startsOn <= date && (!rule.endsOn || date <= rule.endsOn))
    ?? rules.find((rule) => rule.labelId === labelId && !rule.startsOn);
}
export function meetingEligibility(input: { date: string; participationStart?: string | null; activeLabels: Set<string>; formulaLabel?: string; hasWeeklyTarget: boolean; meeting: Pick<PolicyMeeting, "required" | "audienceMode" | "audienceLabelIds"> }): Eligibility {
  const { date, participationStart, activeLabels, formulaLabel, hasWeeklyTarget, meeting } = input;
  if (participationStart && date < participationStart) return "before_start";
  if (meeting.audienceMode === "labels" && !meeting.audienceLabelIds.some((id) => activeLabels.has(id))) return "outside_audience";
  if (formulaLabel) return hasWeeklyTarget ? "weekly" : "no_target";
  return meeting.required ? "required" : "optional";
}
export function evaluateAttendance(input: { members: PolicyMember[]; labels: PolicyLabel[]; changes: LabelChange[]; targets?: WeeklyTarget[]; rules?: AttendanceRule[]; meetings: PolicyMeeting[]; observations: Observation[]; timeZone: string; recentDays?: number; policyActivatedOn?: string | null; from?: string; to?: string; now?: string; historicalLabelId?: string }): PolicyMemberResult[] {
  const nowText = input.now ?? new Date().toISOString();
  const now = Date.parse(nowText);
  const today = localDate(nowText, input.timeZone);
  const recentFrom = shiftDate(today, 1 - (input.recentDays ?? 30));
  const rules = input.rules ?? (input.targets ?? []).map((target) => ({ id: target.id, labelId: target.labelId, startsOn: target.startsOn, endsOn: target.endsOn, ruleType: "weekly_count" as const, meetingsPerWeek: target.meetingsPerWeek }));
  const policyLabels = new Set(rules.map((rule) => rule.labelId));
  const legacyFormulaLabels = new Set(input.labels.filter((label) => Boolean(label.formulaEnabled)).map((label) => label.id));
  const labelNames = new Map(input.labels.map((label) => [label.id, label.name]));
  const changesByMember = new Map<string, LabelChange[]>();
  for (const change of input.changes) changesByMember.set(change.memberId, [...(changesByMember.get(change.memberId) ?? []), change]);
  for (const changes of changesByMember.values()) changes.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const observations = new Map(input.observations.map((observation) => [observation.meetingId + ":" + observation.memberId, observation]));
  const meetings = input.meetings.filter((meeting) => !meeting.isTest && (!input.from || localDate(meeting.startsAt, input.timeZone) >= input.from) && (!input.to || localDate(meeting.startsAt, input.timeZone) <= input.to)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const audience = (meeting: PolicyMeeting) => meeting.audienceMode === "all" ? "All" : meeting.audienceLabelIds.map((id) => labelNames.get(id) ?? "Retired label").join(", ");
  return input.members.map((member) => {
    const changes = changesByMember.get(member.id) ?? [];
    const labelsAt = (date: string): Set<string> => { const active = new Set<string>(); for (const change of changes) { if (change.effectiveDate > date) break; if (change.action === "add") active.add(change.labelId); else active.delete(change.labelId); } return active; };
    const participationStart = member.attendanceRequiredFrom ?? member.rosterAddedAt?.slice(0, 10) ?? "";
    const currentLabelIds = [...labelsAt(today)];
    const currentLabelId = currentLabelIds.find((id) => policyLabels.has(id)) ?? null;
    const currentRule = currentLabelId ? ruleOn(rules, currentLabelId, today) : undefined;
    const rows: PolicyRow[] = [];
    const weekBuckets = new Map<string, { rule: AttendanceRule; labelId: string; weekStartsOn: string; segmentStartsOn: string; segmentEndsOn: string; target: number; legacy: boolean; opportunities: number; attended: number; excused: number; pending: boolean }>();
    for (const meeting of meetings) {
      const date = localDate(meeting.startsAt, input.timeZone);
      const activeLabels = labelsAt(date);
      if (input.historicalLabelId && !activeLabels.has(input.historicalLabelId)) continue;
      const labelId = [...activeLabels].find((id) => policyLabels.has(id)) ?? (input.policyActivatedOn && date < input.policyActivatedOn ? [...activeLabels].find((id) => legacyFormulaLabels.has(id)) : undefined);
      const rule = labelId ? ruleOn(rules, labelId, date) : undefined;
      const weekly = rule?.ruleType === "weekly_count";
      const legacy = Boolean(rule?.id.startsWith("legacy:") && input.policyActivatedOn && date < input.policyActivatedOn);
      const eligibleAudience = meeting.audienceMode === "all" || meeting.audienceLabelIds.some((id) => legacy ? id === labelId : activeLabels.has(id));
      const eligibleDate = !participationStart || date >= participationStart;
      const completed = Date.parse(meeting.attendanceClosesAt) <= now;
      const observation = observations.get(meeting.id + ":" + member.id);
      const disposition = observation?.disposition === "active" ? "absent" : observation?.disposition ?? "absent";
      const eligibility = meetingEligibility({ date, participationStart, activeLabels: legacy && labelId ? new Set([labelId]) : activeLabels, formulaLabel: weekly || !rule && labelId ? labelId : undefined, hasWeeklyTarget: weekly, meeting });
      if (weekly && labelId && eligibleDate && eligibleAudience) {
        const start = weekStart(date), end = shiftDate(start, 6);
        const segmentStartsOn = legacy ? start : [start, rule.startsOn ?? start, participationStart || start, input.from ?? start].sort().at(-1)!;
        const segmentEndsOn = legacy ? end : [end, rule.endsOn ?? end, input.to ?? end].sort()[0];
        const key = labelId + ":" + (legacy ? "legacy" : rule.id) + ":" + start;
        const bucket = weekBuckets.get(key) ?? { rule, labelId, weekStartsOn: start, segmentStartsOn, segmentEndsOn, target: Number(rule.meetingsPerWeek), legacy, opportunities: 0, attended: 0, excused: 0, pending: false };
        bucket.target = Math.max(bucket.target, Number(rule.meetingsPerWeek));
        bucket.opportunities++;
        if (completed) { if (disposition === "present") bucket.attended++; if (disposition === "excused") bucket.excused++; }
        else bucket.pending = true;
        weekBuckets.set(key, bucket);
      }
      if (!completed) continue;
      rows.push({ meetingId: meeting.id, memberId: member.id, disposition, eligibility, policy: weekly ? "weekly" : "standard", ruleId: rule?.id ?? null, rateEligible: eligibility === "required" || eligibility === "weekly", attended: disposition === "present", weight: weekly ? 1 : Number(meeting.attendanceWeight ?? 1), audience: audience(meeting), memberLabelIds: [...activeLabels], checkedInAt: observation?.checkedInAt, checkedOutAt: observation?.checkedOutAt, reason: observation?.reason });
    }
    const weeks: PolicyWeek[] = [...weekBuckets.values()].map((bucket) => {
      const target = bucket.target;
      const denominator = Math.min(bucket.opportunities, target);
      const adjustedDenominator = Math.min(bucket.opportunities - bucket.excused, target);
      const numerator = Math.min(bucket.attended, target);
      const pending = bucket.pending || bucket.segmentEndsOn >= today;
      const status: PolicyWeek["status"] = bucket.opportunities === 0 || adjustedDenominator === 0 && !pending && !bucket.legacy ? "not_applicable" : pending ? "pending" : bucket.attended >= (bucket.legacy ? denominator : adjustedDenominator) ? "met" : "below";
      return { weekStartsOn: bucket.weekStartsOn, weekEndsOn: shiftDate(bucket.weekStartsOn, 6), segmentStartsOn: bucket.segmentStartsOn, segmentEndsOn: bucket.segmentEndsOn, labelId: bucket.labelId, ruleId: bucket.rule.id, target, opportunities: bucket.opportunities, attended: bucket.attended, excused: bucket.excused, numerator, denominator, adjustedDenominator, rate: rate(numerator, denominator), adjustedRate: rate(numerator, adjustedDenominator), belowTarget: status === "below", status };
    }).sort((a, b) => a.segmentStartsOn.localeCompare(b.segmentStartsOn));
    if (currentRule?.ruleType === "weekly_count" && !weeks.some((week) => week.ruleId === currentRule.id && week.weekStartsOn === weekStart(today))) {
      const start = weekStart(today);
      weeks.push({ weekStartsOn: start, weekEndsOn: shiftDate(start, 6), segmentStartsOn: [start, currentRule.startsOn ?? start, participationStart || start].sort().at(-1)!, segmentEndsOn: [shiftDate(start, 6), currentRule.endsOn ?? "9999-12-31"].sort()[0], labelId: currentLabelId!, ruleId: currentRule.id, target: Number(currentRule.meetingsPerWeek), opportunities: 0, attended: 0, excused: 0, numerator: 0, denominator: 0, adjustedDenominator: 0, rate: null, adjustedRate: null, belowTarget: false, status: "not_applicable" });
    }
    const requiredRows = rows.filter((row) => row.eligibility === "required");
    const weightedPresent = requiredRows.reduce((sum, row) => sum + (row.attended ? row.weight : 0), 0);
    const weightedTotal = requiredRows.reduce((sum, row) => sum + row.weight, 0);
    const weightedAdjusted = requiredRows.reduce((sum, row) => sum + (row.disposition === "excused" ? 0 : row.weight), 0);
    const weeklyRows = rows.filter((row) => row.eligibility === "weekly");
    const weeklyPresent = weeks.reduce((sum, week) => sum + week.numerator, 0);
    const weeklyTotal = weeks.reduce((sum, week) => sum + week.denominator, 0);
    const weeklyAdjusted = weeks.reduce((sum, week) => sum + week.adjustedDenominator, 0);
    const hasWeekly = weeklyRows.length > 0 || currentRule?.ruleType === "weekly_count";
    const hasStandard = requiredRows.length > 0;
    const policy = hasWeekly ? hasStandard ? "mixed" : "weekly" : "standard";
    const dueWeeks = weeks.filter((week) => week.status === "met" || week.status === "below");
    const legacyOnly = Boolean(input.policyActivatedOn && weeklyRows.length && rows.every((row) => meetings.some((meeting) => meeting.id === row.meetingId && localDate(meeting.startsAt, input.timeZone) < input.policyActivatedOn!)) && weeklyRows.every((row) => row.ruleId?.startsWith("legacy:")));
    const allTimeRate = policy === "weekly" ? legacyOnly ? rate(weeklyPresent, weeklyTotal) : rate(dueWeeks.filter((week) => week.status === "met").length, dueWeeks.length) : policy === "standard" ? rate(weightedPresent, weightedTotal) : null;
    const allTimeAdjusted = policy === "weekly" ? legacyOnly ? rate(weeklyPresent, weeklyAdjusted) : allTimeRate : policy === "standard" ? rate(weightedPresent, weightedAdjusted) : null;
    const recent = rows.filter((row) => row.ruleId === currentRule?.id && row.eligibility === "required" && meetings.some((meeting) => meeting.id === row.meetingId && localDate(meeting.startsAt, input.timeZone) >= recentFrom));
    const recentPresent = recent.reduce((sum, row) => sum + (row.attended ? row.weight : 0), 0);
    const recentTotal = recent.reduce((sum, row) => sum + row.weight, 0);
    const recentAdjusted = recent.reduce((sum, row) => sum + (row.disposition === "excused" ? 0 : row.weight), 0);
    const currentWeek = currentRule ? weeks.find((week) => week.ruleId === currentRule.id && week.weekStartsOn === weekStart(today)) : undefined;
    const currentCompliance: PolicyCompliance = currentRule?.ruleType === "weighted_percentage"
      ? { labelId: currentLabelId, ruleId: currentRule.id, ruleType: currentRule.ruleType, status: recentAdjusted === 0 ? "not_applicable" : (rawRate(recentPresent, recentAdjusted)! >= Number(currentRule.thresholdPercent) ? "met" : "below"), threshold: Number(currentRule.thresholdPercent), from: recentFrom, to: today, rate: rate(recentPresent, recentAdjusted), unadjustedRate: rate(recentPresent, recentTotal), attended: recentPresent, required: recentAdjusted }
      : currentRule?.ruleType === "weekly_count"
      ? { labelId: currentLabelId, ruleId: currentRule.id, ruleType: currentRule.ruleType, status: currentWeek?.status ?? "not_applicable", threshold: Number(currentRule.meetingsPerWeek), from: currentWeek?.segmentStartsOn ?? weekStart(today), to: currentWeek?.segmentEndsOn ?? shiftDate(weekStart(today), 6), rate: currentWeek?.adjustedRate ?? null, unadjustedRate: currentWeek?.rate ?? null, attended: currentWeek?.attended ?? 0, required: currentWeek?.adjustedDenominator ?? 0 }
      : { labelId: currentLabelId, ruleId: null, ruleType: null, status: "no_rule", threshold: null, from: recentFrom, to: today, rate: null, unadjustedRate: null, attended: 0, required: 0 };
    const historySummaries: PolicyHistory[] = currentLabelId ? rules.filter((rule) => rule.labelId === currentLabelId).map((rule) => {
      const selectedRows = rows.filter((row) => row.ruleId === rule.id && row.eligibility === "required");
      const selectedWeeks = weeks.filter((week) => week.ruleId === rule.id && (week.status === "met" || week.status === "below"));
      const numerator = selectedRows.reduce((sum, row) => sum + (row.attended ? row.weight : 0), 0);
      const denominator = selectedRows.reduce((sum, row) => sum + (row.disposition === "excused" ? 0 : row.weight), 0);
      const unadjusted = selectedRows.reduce((sum, row) => sum + row.weight, 0);
      return { ruleId: rule.id, labelId: rule.labelId, ruleType: rule.ruleType, startsOn: rule.startsOn ?? null, endsOn: rule.endsOn ?? null, rate: rule.ruleType === "weighted_percentage" ? rate(numerator, denominator) : rate(selectedWeeks.filter((week) => week.status === "met").length, selectedWeeks.length), unadjustedRate: rule.ruleType === "weighted_percentage" ? rate(numerator, unadjusted) : null, weeksMet: selectedWeeks.filter((week) => week.status === "met").length, weeksDue: selectedWeeks.length, status: selectedRows.length || selectedWeeks.length ? "evaluated" : "not_applicable" };
    }) : [];
    return { member, currentLabelIds, rows, policy, present: weightedPresent + weeklyPresent, primaryTotal: weightedTotal + weeklyTotal, adjustedTotal: weightedAdjusted + weeklyAdjusted, rate: allTimeRate, adjustedRate: allTimeAdjusted, pooledRate: legacyOnly ? rate(weeklyRows.filter((row) => row.attended).length, weeklyTotal) : null, weeks, belowTargetWeeks: weeks.filter((week) => week.belowTarget), currentCompliance, historySummaries };
  });
}

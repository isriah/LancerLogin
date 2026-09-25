export type PolicyMember = { id: string; memberId: string; firstName: string; lastName: string; email?: string | null; discordUserId?: string | null; active: number | boolean; attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null };
export type PolicyLabel = { id: string; name: string; active: number | boolean; formulaEnabled: number | boolean };
export type LabelChange = { memberId: string; labelId: string; action: "add" | "remove"; effectiveDate: string; createdAt?: string };
export type WeeklyTarget = { id: string; labelId: string; startsOn: string; endsOn: string; meetingsPerWeek: number };
export type ExcusedHandling = "exclude" | "count_missed";
export type AttendanceRule = { id: string; labelId: string; startsOn?: string | null; endsOn?: string | null; ruleType: "weighted_percentage" | "weekly_count"; thresholdPercent?: number | null; meetingsPerWeek?: number | null; excusedHandling?: ExcusedHandling | null };
export type PolicyMeeting = { id: string; title: string; startsAt: string; endsAt: string; attendanceClosesAt: string; required: number | boolean; attendanceWeight: number; audienceMode: "all" | "labels"; audienceLabelIds: string[]; isTest?: number | boolean };
export type Observation = { meetingId: string; memberId: string; disposition: "present" | "active" | "absent" | "excused"; checkedInAt?: string | null; checkedOutAt?: string | null; reason?: string | null };
export type Eligibility = "required" | "optional" | "outside_audience" | "before_start" | "weekly" | "no_target";
export type PolicyRow = { meetingId: string; memberId: string; disposition: Observation["disposition"]; eligibility: Eligibility; policy: "standard" | "weekly"; ruleId?: string | null; rateEligible: boolean; regularEligible: boolean; attended: boolean; weight: number; regularWeight: number; audience: string; memberLabelIds: string[]; checkedInAt?: string | null; checkedOutAt?: string | null; reason?: string | null };
export type PolicyWeek = { weekStartsOn: string; weekEndsOn: string; segmentStartsOn: string; segmentEndsOn: string; labelId: string; ruleId: string; target: number; opportunities: number; attended: number; excused: number; numerator: number; denominator: number; adjustedDenominator: number; rate: number | null; adjustedRate: number | null; belowTarget: boolean; status: "met" | "below" | "pending" | "not_applicable" };
export type RegularAttendance = { rate: number | null; attended: number; required: number; from: string | null; to: string };
export type PolicyCompliance = { labelId: string | null; labelName: string | null; ruleId: string | null; ruleType: AttendanceRule["ruleType"] | null; excusedHandling: ExcusedHandling | null; status: "met" | "below" | "pending" | "not_applicable" | "no_rule"; threshold: number | null; from: string; to: string; rate: number | null; unadjustedRate: number | null; attended: number; required: number };
export type PolicyHistory = { ruleId: string; labelId: string; labelName: string; ruleType: AttendanceRule["ruleType"]; excusedHandling: ExcusedHandling | null; startsOn: string | null; endsOn: string | null; rate: number | null; unadjustedRate: number | null; threshold: number; attended: number; required: number; weeksMet: number; weeksDue: number; status: "met" | "below" | "not_applicable" };
export type PolicyMemberResult = { member: PolicyMember; currentLabelIds: string[]; rows: PolicyRow[]; regularAttendance: RegularAttendance; policy: "standard" | "weekly" | "mixed"; present: number; primaryTotal: number; adjustedTotal: number; rate: number | null; adjustedRate: number | null; pooledRate: number | null; weeks: PolicyWeek[]; belowTargetWeeks: PolicyWeek[]; currentCompliances: PolicyCompliance[]; currentCompliance: PolicyCompliance; historySummaries: PolicyHistory[] };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
export function localDate(timestamp: string, timeZone: string): string {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestamp));
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return field("year") + "-" + field("month") + "-" + field("day");
}
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
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
export function evaluateAttendance(input: { members: PolicyMember[]; labels: PolicyLabel[]; changes: LabelChange[]; targets?: WeeklyTarget[]; rules?: AttendanceRule[]; meetings: PolicyMeeting[]; observations: Observation[]; timeZone: string; recentDays?: number; policyActivatedOn?: string | null; from?: string; to?: string; now?: string; historicalLabelId?: string; historicalLabelIds?: string[]; historicalLabelMatch?: "any" | "all"; summaryLabelIds?: string[] }): PolicyMemberResult[] {
  const nowText = input.now ?? new Date().toISOString();
  const now = Date.parse(nowText);
  const today = localDate(nowText, input.timeZone);
  const recentFrom = shiftDate(today, 1 - (input.recentDays ?? 30));
  const rules: AttendanceRule[] = input.rules ?? (input.targets ?? []).map((target) => ({ id: target.id, labelId: target.labelId, startsOn: target.startsOn, endsOn: target.endsOn, ruleType: "weekly_count" as const, meetingsPerWeek: target.meetingsPerWeek, excusedHandling: "exclude" }));
  const policyLabels = new Set(rules.map((rule) => rule.labelId));
  const historicalLabelIds = input.historicalLabelIds ?? (input.historicalLabelId ? [input.historicalLabelId] : []);
  const legacyFormulaLabels = new Set(input.labels.filter((label) => Boolean(label.formulaEnabled)).map((label) => label.id));
  const labelNames = new Map(input.labels.map((label) => [label.id, label.name]));
  const changesByMember = new Map<string, LabelChange[]>();
  for (const change of input.changes) changesByMember.set(change.memberId, [...(changesByMember.get(change.memberId) ?? []), change]);
  for (const changes of changesByMember.values()) changes.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const observations = new Map(input.observations.map((observation) => [observation.meetingId + ":" + observation.memberId, observation]));
  const meetingDates = new Map(input.meetings.map((meeting) => [meeting.id, localDate(meeting.startsAt, input.timeZone)]));
  const completedMeetings = new Set(input.meetings.filter((meeting) => Date.parse(meeting.attendanceClosesAt) <= now).map((meeting) => meeting.id));
  const meetings = input.meetings.filter((meeting) => !meeting.isTest && (!input.from || meetingDates.get(meeting.id)! >= input.from) && (!input.to || meetingDates.get(meeting.id)! <= input.to)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const audience = (meeting: PolicyMeeting) => meeting.audienceMode === "all" ? "All" : meeting.audienceLabelIds.map((id) => labelNames.get(id) ?? "Retired label").join(", ");
  return input.members.map((member) => {
    const changes = changesByMember.get(member.id) ?? [];
    const labelsAt = (date: string): Set<string> => { const active = new Set<string>(); for (const change of changes) { if (change.effectiveDate > date) break; if (change.action === "add") active.add(change.labelId); else active.delete(change.labelId); } return active; };
    const participationStart = member.attendanceRequiredFrom ?? member.rosterAddedAt?.slice(0, 10) ?? "";
    const currentLabelIds = [...labelsAt(today)];
    const currentPolicyLabelIds = currentLabelIds.filter((id) => policyLabels.has(id));
    const currentLabelId = currentPolicyLabelIds[0] ?? null;
    const currentRule = currentLabelId ? ruleOn(rules, currentLabelId, today) : undefined;
    const rows: PolicyRow[] = [];
    const weekBuckets = new Map<string, { rule: AttendanceRule; labelId: string; weekStartsOn: string; segmentStartsOn: string; segmentEndsOn: string; target: number; legacy: boolean; opportunities: number; attended: number; excused: number; pending: boolean }>();
    for (const meeting of meetings) {
      const date = meetingDates.get(meeting.id)!;
      const activeLabels = labelsAt(date);
      if (historicalLabelIds.length && (input.historicalLabelMatch === "all" ? !historicalLabelIds.every((id) => activeLabels.has(id)) : !historicalLabelIds.some((id) => activeLabels.has(id)))) continue;
      const labelId = [...activeLabels].find((id) => policyLabels.has(id)) ?? (input.policyActivatedOn && date < input.policyActivatedOn ? [...activeLabels].find((id) => legacyFormulaLabels.has(id)) : undefined);
      const rule = labelId ? ruleOn(rules, labelId, date) : undefined;
      const weekly = rule?.ruleType === "weekly_count";
      const legacy = Boolean(rule?.id.startsWith("legacy:") && input.policyActivatedOn && date < input.policyActivatedOn);
      const eligibleAudience = meeting.audienceMode === "all" || meeting.audienceLabelIds.some((id) => legacy ? id === labelId : activeLabels.has(id));
      const regularAudience = meeting.audienceMode === "all" || meeting.audienceLabelIds.some((id) => activeLabels.has(id));
      const eligibleDate = !participationStart || date >= participationStart;
      const completed = completedMeetings.has(meeting.id);
      const observation = observations.get(meeting.id + ":" + member.id);
      const disposition = observation?.disposition === "active" ? "absent" : observation?.disposition ?? "absent";
      const eligibility = meetingEligibility({ date, participationStart, activeLabels: legacy && labelId ? new Set([labelId]) : activeLabels, formulaLabel: weekly || !rule && labelId ? labelId : undefined, hasWeeklyTarget: weekly, meeting });
      const weeklyEntries = [...activeLabels].flatMap((activeLabelId) => {
        const activeRule = ruleOn(rules, activeLabelId, date);
        return activeRule?.ruleType === "weekly_count" ? [{ labelId: activeLabelId, rule: activeRule }] : [];
      });
      if (weekly && labelId && legacy && !weeklyEntries.some((entry) => entry.labelId === labelId && entry.rule.id === rule.id)) weeklyEntries.push({ labelId, rule });
      for (const entry of weeklyEntries) {
        const entryLegacy = Boolean(entry.rule.id.startsWith("legacy:") && input.policyActivatedOn && date < input.policyActivatedOn);
        const entryAudience = meeting.audienceMode === "all" || meeting.audienceLabelIds.some((id) => entryLegacy ? id === entry.labelId : activeLabels.has(id));
        if (!eligibleDate || !entryAudience) continue;
        const start = weekStart(date), end = shiftDate(start, 6);
        const segmentStartsOn = entryLegacy ? start : [start, entry.rule.startsOn ?? start, participationStart || start, input.from ?? start].sort().at(-1)!;
        const segmentEndsOn = entryLegacy ? end : [end, entry.rule.endsOn ?? end, input.to ?? end].sort()[0];
        const key = entry.labelId + ":" + (entryLegacy ? "legacy" : entry.rule.id) + ":" + start;
        const bucket = weekBuckets.get(key) ?? { rule: entry.rule, labelId: entry.labelId, weekStartsOn: start, segmentStartsOn, segmentEndsOn, target: Number(entry.rule.meetingsPerWeek), legacy: entryLegacy, opportunities: 0, attended: 0, excused: 0, pending: false };
        bucket.target = Math.max(bucket.target, Number(entry.rule.meetingsPerWeek));
        bucket.opportunities++;
        if (completed) { if (disposition === "present") bucket.attended++; if (disposition === "excused") bucket.excused++; }
        else bucket.pending = true;
        weekBuckets.set(key, bucket);
      }
      if (!completed) continue;
      rows.push({ meetingId: meeting.id, memberId: member.id, disposition, eligibility, policy: weekly ? "weekly" : "standard", ruleId: rule?.id ?? null, rateEligible: eligibility === "required" || eligibility === "weekly", regularEligible: eligibleDate && regularAudience && Boolean(meeting.required), attended: disposition === "present", weight: weekly ? 1 : Number(meeting.attendanceWeight ?? 1), regularWeight: Number(meeting.attendanceWeight ?? 1), audience: audience(meeting), memberLabelIds: [...activeLabels], checkedInAt: observation?.checkedInAt, checkedOutAt: observation?.checkedOutAt, reason: observation?.reason });
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
    for (const activeLabelId of currentPolicyLabelIds) {
      if (input.from && input.from > today || input.to && input.to < today) continue;
      const activeRule = ruleOn(rules, activeLabelId, today);
      if (activeRule?.ruleType !== "weekly_count" || weeks.some((week) => week.ruleId === activeRule.id && week.weekStartsOn === weekStart(today))) continue;
      const start = weekStart(today);
      weeks.push({ weekStartsOn: start, weekEndsOn: shiftDate(start, 6), segmentStartsOn: [start, activeRule.startsOn ?? start, participationStart || start].sort().at(-1)!, segmentEndsOn: [shiftDate(start, 6), activeRule.endsOn ?? "9999-12-31"].sort()[0], labelId: activeLabelId, ruleId: activeRule.id, target: Number(activeRule.meetingsPerWeek), opportunities: 0, attended: 0, excused: 0, numerator: 0, denominator: 0, adjustedDenominator: 0, rate: null, adjustedRate: null, belowTarget: false, status: "not_applicable" });
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
    const legacyOnly = Boolean(input.policyActivatedOn && weeklyRows.length && rows.every((row) => meetingDates.get(row.meetingId)! < input.policyActivatedOn!) && weeklyRows.every((row) => row.ruleId?.startsWith("legacy:")));
    const allTimeRate = policy === "weekly" ? legacyOnly ? rate(weeklyPresent, weeklyTotal) : rate(dueWeeks.filter((week) => week.status === "met").length, dueWeeks.length) : policy === "standard" ? rate(weightedPresent, weightedTotal) : null;
    const allTimeAdjusted = policy === "weekly" ? legacyOnly ? rate(weeklyPresent, weeklyAdjusted) : allTimeRate : policy === "standard" ? rate(weightedPresent, weightedAdjusted) : null;
    const regularRows = rows.filter((row) => row.regularEligible);
    const regularPresent = regularRows.reduce((sum, row) => sum + (row.attended ? row.regularWeight : 0), 0);
    const regularRequired = regularRows.reduce((sum, row) => sum + row.regularWeight, 0);
    const regularAttendance: RegularAttendance = { rate: rate(regularPresent, regularRequired), attended: regularPresent, required: regularRequired, from: input.from ?? (participationStart || null), to: input.to ?? today };
    const percentageRows = (labelId: string, rule: AttendanceRule, from?: string) => meetings.flatMap((meeting) => {
      const date = localDate(meeting.startsAt, input.timeZone);
      const activeLabels = labelsAt(date);
      const historicalMatch = !historicalLabelIds.length || (input.historicalLabelMatch === "all" ? historicalLabelIds.every((id) => activeLabels.has(id)) : historicalLabelIds.some((id) => activeLabels.has(id)));
      if (!historicalMatch || from && date < from || !activeLabels.has(labelId) || ruleOn(rules, labelId, date)?.id !== rule.id || participationStart && date < participationStart || Date.parse(meeting.attendanceClosesAt) > now || !meeting.required || meeting.audienceMode === "labels" && !meeting.audienceLabelIds.some((id) => activeLabels.has(id))) return [];
      const observation = observations.get(meeting.id + ":" + member.id);
      const disposition = observation?.disposition === "active" ? "absent" : observation?.disposition ?? "absent";
      return [{ disposition, attended: disposition === "present", weight: Number(meeting.attendanceWeight ?? 1) }];
    });
    const currentCompliances: PolicyCompliance[] = currentPolicyLabelIds.map((activeLabelId) => {
      const activeRule = ruleOn(rules, activeLabelId, today);
      const labelName = labelNames.get(activeLabelId) ?? "Retired label";
      if (!activeRule) return { labelId: activeLabelId, labelName, ruleId: null, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, from: recentFrom, to: today, rate: null, unadjustedRate: null, attended: 0, required: 0 };
      if (activeRule.ruleType === "weekly_count") {
        const currentWeek = weeks.find((week) => week.ruleId === activeRule.id && week.weekStartsOn === weekStart(today));
        return { labelId: activeLabelId, labelName, ruleId: activeRule.id, ruleType: activeRule.ruleType, excusedHandling: null, status: currentWeek?.status ?? "not_applicable", threshold: Number(activeRule.meetingsPerWeek), from: currentWeek?.segmentStartsOn ?? weekStart(today), to: currentWeek?.segmentEndsOn ?? shiftDate(weekStart(today), 6), rate: currentWeek?.adjustedRate ?? null, unadjustedRate: currentWeek?.rate ?? null, attended: currentWeek?.attended ?? 0, required: currentWeek?.adjustedDenominator ?? 0 };
      }
      const recent = percentageRows(activeLabelId, activeRule, recentFrom);
      const recentPresent = recent.reduce((sum, row) => sum + (row.attended ? row.weight : 0), 0);
      const recentTotal = recent.reduce((sum, row) => sum + row.weight, 0);
      const recentAdjusted = recent.reduce((sum, row) => sum + (row.disposition === "excused" ? 0 : row.weight), 0);
      const required = activeRule.excusedHandling === "count_missed" ? recentTotal : recentAdjusted;
      return { labelId: activeLabelId, labelName, ruleId: activeRule.id, ruleType: activeRule.ruleType, excusedHandling: activeRule.excusedHandling ?? "exclude", status: required === 0 ? "not_applicable" : rawRate(recentPresent, required)! >= Number(activeRule.thresholdPercent) ? "met" : "below", threshold: Number(activeRule.thresholdPercent), from: recentFrom, to: today, rate: rate(recentPresent, required), unadjustedRate: rate(recentPresent, recentTotal), attended: recentPresent, required };
    });
    const currentCompliance: PolicyCompliance = currentCompliances[0] ?? { labelId: null, labelName: null, ruleId: null, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, from: recentFrom, to: today, rate: null, unadjustedRate: null, attended: 0, required: 0 };
    const summaryLabelIds = [...new Set([...currentPolicyLabelIds, ...(input.summaryLabelIds ?? [])])];
    const historySummaries: PolicyHistory[] = summaryLabelIds.flatMap((activeLabelId) => rules.filter((rule) => rule.labelId === activeLabelId && (!input.from || !rule.endsOn || rule.endsOn >= input.from) && (!input.to || !rule.startsOn || rule.startsOn <= input.to)).map((rule) => {
      const selectedRows = rule.ruleType === "weighted_percentage" ? percentageRows(activeLabelId, rule) : [];
      const selectedWeeks = weeks.filter((week) => week.ruleId === rule.id && (week.status === "met" || week.status === "below"));
      const numerator = selectedRows.reduce((sum, row) => sum + (row.attended ? row.weight : 0), 0);
      const denominator = selectedRows.reduce((sum, row) => sum + (row.disposition === "excused" ? 0 : row.weight), 0);
      const unadjusted = selectedRows.reduce((sum, row) => sum + row.weight, 0);
      const policyDenominator = rule.excusedHandling === "count_missed" ? unadjusted : denominator;
      const weeksMet = selectedWeeks.filter((week) => week.status === "met").length;
      const weeksDue = selectedWeeks.length;
      const threshold = Number(rule.ruleType === "weighted_percentage" ? rule.thresholdPercent : rule.meetingsPerWeek);
      const resultRate = rule.ruleType === "weighted_percentage" ? rate(numerator, policyDenominator) : rate(weeksMet, weeksDue);
      const status: PolicyHistory["status"] = rule.ruleType === "weighted_percentage"
        ? policyDenominator === 0 ? "not_applicable" : rawRate(numerator, policyDenominator)! >= threshold ? "met" : "below"
        : weeksDue === 0 ? "not_applicable" : weeksMet === weeksDue ? "met" : "below";
      return { ruleId: rule.id, labelId: rule.labelId, labelName: labelNames.get(rule.labelId) ?? "Retired label", ruleType: rule.ruleType, excusedHandling: rule.ruleType === "weighted_percentage" ? rule.excusedHandling ?? "exclude" : null, startsOn: rule.startsOn ?? null, endsOn: rule.endsOn ?? null, rate: resultRate, unadjustedRate: rule.ruleType === "weighted_percentage" ? rate(numerator, unadjusted) : null, threshold, attended: rule.ruleType === "weighted_percentage" ? numerator : weeksMet, required: rule.ruleType === "weighted_percentage" ? policyDenominator : weeksDue, weeksMet, weeksDue, status };
    }));
    return { member, currentLabelIds, rows, regularAttendance, policy, present: weightedPresent + weeklyPresent, primaryTotal: weightedTotal + weeklyTotal, adjustedTotal: weightedAdjusted + weeklyAdjusted, rate: allTimeRate, adjustedRate: allTimeAdjusted, pooledRate: legacyOnly ? rate(weeklyRows.filter((row) => row.attended).length, weeklyTotal) : null, weeks, belowTargetWeeks: weeks.filter((week) => week.belowTarget), currentCompliances, currentCompliance, historySummaries };
  });
}

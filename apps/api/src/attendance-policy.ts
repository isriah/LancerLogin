import { preciseRate } from "../../../packages/shared/src/attendance-label-sets.ts";
export type PolicyMember = { id: string; memberId: string; firstName: string; lastName: string; email?: string | null; discordUserId?: string | null; active: number | boolean; attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null; inactivePeriodsJson?: string };
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
/** `rate` is whole percent; `preciseRate` the same rate to one decimal. `attended`/`required` are weighted; the meetings* counts are plain. */
export type RegularAttendance = { rate: number | null; preciseRate: number | null; attended: number; required: number; meetingsAttended: number; meetingsRequired: number; meetingsExcused: number; from: string | null; to: string };
export type PolicyCompliance = { labelId: string | null; labelName: string | null; ruleId: string | null; ruleType: AttendanceRule["ruleType"] | null; excusedHandling: ExcusedHandling | null; status: "met" | "below" | "pending" | "not_applicable" | "no_rule"; threshold: number | null; from: string; to: string; rate: number | null; unadjustedRate: number | null; attended: number; required: number; preciseRate: number | null; meetingsAttended: number; meetingsCounted: number; meetingsExcused: number };
/** `attended`/`required` are weighted (weeks for weekly policies); the meetings* counts are plain meetings. Weekly policies count no meetings, so meetingsCounted is null. */
export type PolicyHistory = { ruleId: string; labelId: string; labelName: string; ruleType: AttendanceRule["ruleType"]; excusedHandling: ExcusedHandling | null; startsOn: string | null; endsOn: string | null; rate: number | null; unadjustedRate: number | null; threshold: number; attended: number; required: number; weeksMet: number; weeksDue: number; status: "met" | "below" | "not_applicable"; preciseRate: number | null; meetingsAttended: number; meetingsCounted: number | null; meetingsExcused: number; weeksInProgress: number; setStatus: "met" | "below" | "pending" | "not_applicable" };
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
/**
 * The organization-local date a member's participation starts, comparable with meeting dates from `localDate`: an
 * explicit start date as stored, else the local date of the roster-added instant (its UTC date can be a day off).
 */
export function participationStartDate(member: { attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null }, timeZone: string): string {
  if (member.attendanceRequiredFrom != null) return member.attendanceRequiredFrom;
  const added = member.rosterAddedAt;
  if (!added || datePattern.test(added)) return added ?? "";
  // A timestamp written without a zone (SQLite's "YYYY-MM-DD HH:MM:SS") is UTC.
  const instant = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(added) ? added : added.replace(" ", "T") + "Z";
  return Number.isFinite(Date.parse(instant)) ? localDate(instant, timeZone) : added.slice(0, 10);
}
function shiftDate(date: string, days: number): string { const result = new Date(date + "T12:00:00.000Z"); result.setUTCDate(result.getUTCDate() + days); return result.toISOString().slice(0, 10); }
function weekStart(date: string): string { const day = new Date(date + "T12:00:00.000Z").getUTCDay(); return shiftDate(date, -(day === 0 ? 6 : day - 1)); }
const rate = (numerator: number, denominator: number): number | null => denominator > 0 ? Math.round(100 * numerator / denominator) : null;
const rawRate = (numerator: number, denominator: number): number | null => denominator > 0 ? 100 * numerator / denominator : null;
const plainCounts = (rows: { disposition: Observation["disposition"]; attended: boolean }[], handling: ExcusedHandling | null | undefined) => {
  const excused = rows.filter((row) => row.disposition === "excused").length;
  return { meetingsAttended: rows.filter((row) => row.attended).length, meetingsCounted: handling === "count_missed" ? rows.length : rows.length - excused, meetingsExcused: excused };
};
export function ruleOn(rules: AttendanceRule[], labelId: string, date: string): AttendanceRule | undefined {
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
export type AttendanceInput = { members: PolicyMember[]; labels: PolicyLabel[]; changes: LabelChange[]; targets?: WeeklyTarget[]; rules?: AttendanceRule[]; meetings: PolicyMeeting[]; observations: Observation[]; timeZone: string; recentDays?: number; policyActivatedOn?: string | null; from?: string; to?: string; now?: string; membership?: "current" | "historical"; historicalLabelId?: string; historicalLabelIds?: string[]; historicalLabelMatch?: "any" | "all"; summaryLabelIds?: string[] };
/** A member's result without the per-meeting detail: each row keeps only what an impact preview compares. */
export type PolicyMemberOutline = Omit<PolicyMemberResult, "rows"> & { rows: Pick<PolicyRow, "eligibility" | "ruleId">[] };

// Facts that depend only on the source rows are kept between evaluations. One request evaluates the same data two to four
// times (a report's official and period figures, a preview's before and after), and the source data itself is reused
// across requests until it changes (ReportDataCache). Each entry is checked against the values it was derived from; the
// observation and label change lists are checked by length only, so pass a new array rather than editing a row in place.
type MeetingFacts = { timeZone: string; startsAt: string; attendanceClosesAt: string; date: string; start: number; closes: number };
const meetingFacts = new WeakMap<PolicyMeeting, MeetingFacts>();
function factsOf(meeting: PolicyMeeting, timeZone: string): MeetingFacts {
  let facts = meetingFacts.get(meeting);
  if (!facts || facts.timeZone !== timeZone || facts.startsAt !== meeting.startsAt || facts.attendanceClosesAt !== meeting.attendanceClosesAt) {
    facts = { timeZone, startsAt: meeting.startsAt, attendanceClosesAt: meeting.attendanceClosesAt, date: localDate(meeting.startsAt, timeZone), start: Date.parse(meeting.startsAt), closes: Date.parse(meeting.attendanceClosesAt) };
    meetingFacts.set(meeting, facts);
  }
  return facts;
}
/**
 * Observations by member and meeting, held as arrays so the evaluation's inner loop reads a number instead of searching.
 * `slots` numbers each meeting that has an observation; a member's `codes[slot]` is that meeting's disposition and
 * `found[slot]` the observation itself. A later observation for the same pair replaces an earlier one.
 */
type ObservationIndex = { length: number; slots: Map<string, number>; byMember: Map<string, { codes: Uint8Array; found: (Observation | undefined)[] }> };
const observationIndexes = new WeakMap<Observation[], ObservationIndex>();
const noObservation = 0, presentCode = 1, absentCode = 2, excusedCode = 3, otherCode = 4;
function indexObservations(observations: Observation[]): ObservationIndex {
  const known = observationIndexes.get(observations);
  if (known && known.length === observations.length) return known;
  const slots = new Map<string, number>();
  for (const observation of observations) if (!slots.has(observation.meetingId)) slots.set(observation.meetingId, slots.size);
  const byMember: ObservationIndex["byMember"] = new Map();
  for (const observation of observations) {
    let own = byMember.get(observation.memberId);
    if (!own) { own = { codes: new Uint8Array(slots.size), found: new Array(slots.size) }; byMember.set(observation.memberId, own); }
    const slot = slots.get(observation.meetingId)!; const disposition = observation.disposition;
    own.codes[slot] = disposition === "present" ? presentCode : disposition === "active" || disposition === "absent" ? absentCode : disposition === "excused" ? excusedCode : otherCode;
    own.found[slot] = observation;
  }
  const index = { length: observations.length, slots, byMember };
  observationIndexes.set(observations, index);
  return index;
}
type ChangeIndex = { length: number; byMember: Map<string, LabelChange[]> };
const changeIndexes = new WeakMap<LabelChange[], ChangeIndex>();
/** Each member's label changes in the order they take effect. */
function changesOf(changes: LabelChange[]): Map<string, LabelChange[]> {
  const known = changeIndexes.get(changes);
  if (known && known.length === changes.length) return known.byMember;
  const byMember = new Map<string, LabelChange[]>();
  for (const change of changes) { const own = byMember.get(change.memberId); if (own) own.push(change); else byMember.set(change.memberId, [change]); }
  for (const own of byMember.values()) own.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  changeIndexes.set(changes, { length: changes.length, byMember });
  return byMember;
}
const weekBounds = new Map<string, { start: string; end: string }>();
function weekOf(date: string): { start: string; end: string } {
  let week = weekBounds.get(date);
  if (!week) { const start = weekStart(date); week = { start, end: shiftDate(start, 6) }; if (weekBounds.size >= 4096) weekBounds.clear(); weekBounds.set(date, week); }
  return week;
}
type StartFacts = { timeZone: string; attendanceRequiredFrom: string | null | undefined; rosterAddedAt: string | null | undefined; start: string };
const participationStarts = new WeakMap<PolicyMember, StartFacts>();
function participationStartOf(member: PolicyMember, timeZone: string): string {
  let facts = participationStarts.get(member);
  if (!facts || facts.timeZone !== timeZone || facts.attendanceRequiredFrom !== member.attendanceRequiredFrom || facts.rosterAddedAt !== member.rosterAddedAt) {
    facts = { timeZone, attendanceRequiredFrom: member.attendanceRequiredFrom, rosterAddedAt: member.rosterAddedAt, start: participationStartDate(member, timeZone) };
    participationStarts.set(member, facts);
  }
  return facts.start;
}
const laterOf = (a: string, b: string) => b > a ? b : a;
const earlierOf = (a: string, b: string) => b < a ? b : a;

type WeekBucket = { rule: AttendanceRule; labelId: string; weekStartsOn: string; weekEndsOn: string; segmentStartsOn: string; segmentEndsOn: string; target: number; legacy: boolean; opportunities: number; attended: number; excused: number; pending: boolean };
type PercentageRow = { date: string; disposition: Observation["disposition"]; attended: boolean; weight: number };
/** What a member's labels and the rules in force on a date decide, shared by every meeting where both are the same. */
type Standing = { labels: Set<string>; labelIds: string[]; eligibilityLabels: Set<string>; historicalMatch: boolean; ruleId: string | null; legacyRule: boolean; weekly: boolean; formula: boolean; entries: { labelId: string; rule: AttendanceRule; legacy: boolean; target: number; weeks: (WeekBucket | undefined)[] }[]; percentage: PercentageRow[][] };

export function evaluateAttendance(input: AttendanceInput): PolicyMemberResult[] { return evaluate(input, true, [input.recentDays ?? 30])[0] as PolicyMemberResult[]; }

/**
 * Evaluations of one loaded copy of the source data, kept until the answer could change. The source data is reused
 * across requests until something is written (ReportDataCache); evaluating it is most of a report's CPU, and a report,
 * the leaderboard, the roster rates and an export all start from the same evaluations.
 *
 * An evaluation depends on the clock in two ways only: which meetings have closed, and the organization-local date. A
 * kept one is used from the instant it was made until the next meeting closes or the local date changes.
 *
 * `source` is the loaded data object itself and is never edited. `key` names what `input` adds to it (a period, a
 * meeting type, labels): the same key must always mean the same input. Callers must not edit the result.
 */
type KeptEvaluations = { madeAt: number; until: number; today: string; timeZone: string; byKey: Map<string, PolicyMemberResult[]> };
const keptEvaluations = new WeakMap<object, KeptEvaluations>();
// Each kept evaluation holds a row for every member and meeting (several megabytes for 150 members and 300 meetings),
// and a Worker has 128 MB: the official figures and two periods are enough for the pages that share them.
const keptEvaluationLimit = 3;
export function evaluateAttendanceKept<T extends AttendanceInput>(source: T, key: string, input: (source: T) => AttendanceInput = (same) => same, nowText: string = new Date().toISOString()): PolicyMemberResult[] {
  const now = Date.parse(nowText); const today = localDate(nowText, source.timeZone);
  let kept = keptEvaluations.get(source);
  if (!kept || now < kept.madeAt || now >= kept.until || kept.today !== today || kept.timeZone !== source.timeZone) {
    let until = Infinity;
    for (const meeting of source.meetings) { const closes = factsOf(meeting, source.timeZone).closes; if (closes > now && closes < until) until = closes; }
    kept = { madeAt: now, until, today, timeZone: source.timeZone, byKey: new Map() };
    keptEvaluations.set(source, kept);
  }
  let result = kept.byKey.get(key);
  if (!result) {
    // Evaluated at the instant the kept set was made, so every entry of a set describes the same moment.
    result = evaluateAttendance({ ...input(source), now: new Date(kept.madeAt).toISOString() });
    if (kept.byKey.size >= keptEvaluationLimit) kept.byKey.delete(kept.byKey.keys().next().value!);
    kept.byKey.set(key, result);
  }
  return result;
}
/**
 * The same evaluation without building each meeting row's detail, for callers that compare outcomes rather than list
 * meetings. Every other field is identical to evaluateAttendance's; rows line up one for one.
 */
export function evaluateAttendanceOutline(input: AttendanceInput): PolicyMemberOutline[] { return evaluate(input, false, [input.recentDays ?? 30])[0]; }
/**
 * evaluateAttendanceOutline once for each recent window, in order, reading the attendance only once: the window changes
 * which meetings a current percentage policy counts and nothing else. The results share everything the window leaves alone.
 */
export function evaluateRecentWindows(input: AttendanceInput, recentDays: number[]): PolicyMemberOutline[][] { return evaluate(input, false, recentDays); }

function evaluate(input: AttendanceInput, detail: boolean, recentWindows: number[]): PolicyMemberOutline[][] {
  const nowText = input.now ?? new Date().toISOString();
  const now = Date.parse(nowText);
  const today = localDate(nowText, input.timeZone);
  const recentFroms = recentWindows.map((days) => shiftDate(today, 1 - days));
  const rules: AttendanceRule[] = input.rules ?? (input.targets ?? []).map((target) => ({ id: target.id, labelId: target.labelId, startsOn: target.startsOn, endsOn: target.endsOn, ruleType: "weekly_count" as const, meetingsPerWeek: target.meetingsPerWeek, excusedHandling: "exclude" }));
  // ruleOn's answer for a label and date, without searching every label's rules each time.
  const rulesByLabel = new Map<string, { dated: AttendanceRule[]; fallback: AttendanceRule | undefined; all: AttendanceRule[] }>();
  for (const rule of rules) {
    let own = rulesByLabel.get(rule.labelId);
    if (!own) { own = { dated: [], fallback: undefined, all: [] }; rulesByLabel.set(rule.labelId, own); }
    own.all.push(rule);
    if (rule.startsOn) own.dated.push(rule); else if (!own.fallback) own.fallback = rule;
  }
  const ruleAt = (labelId: string, date: string): AttendanceRule | undefined => {
    const own = rulesByLabel.get(labelId);
    if (!own) return undefined;
    for (const rule of own.dated) if (rule.startsOn! <= date && (!rule.endsOn || date <= rule.endsOn)) return rule;
    return own.fallback;
  };
  const historicalLabelIds = input.historicalLabelIds ?? (input.historicalLabelId ? [input.historicalLabelId] : []);
  const legacyFormulaLabels = new Set(input.labels.filter((label) => Boolean(label.formulaEnabled)).map((label) => label.id));
  const labelNames = new Map(input.labels.map((label) => [label.id, label.name]));
  const changesByMember = changesOf(input.changes);
  const observations = indexObservations(input.observations);
  // Ordered by instant, not text: a meeting saved before times were stored canonically may hold an offset.
  const ordered = input.meetings.map((meeting) => ({ meeting, facts: factsOf(meeting, input.timeZone) }))
    .filter(({ meeting, facts }) => !meeting.isTest && (!input.from || facts.date >= input.from) && (!input.to || facts.date <= input.to))
    .sort((a, b) => (a.facts.start - b.facts.start) || a.meeting.startsAt.localeCompare(b.meeting.startsAt));
  const meetingCount = ordered.length;
  // One entry per meeting in order, so the loop over every member and meeting reads plain values.
  const meetings = ordered.map((item) => item.meeting);
  const dates = ordered.map((item) => item.facts.date);
  const starts = ordered.map((item) => item.facts.start);
  // The loop compares dates as their place among the meeting dates: `rankBelow(date)` meeting dates come before `date`.
  const meetingDates = [...new Set(dates)].sort();
  const rankOfDate = new Map(meetingDates.map((date, rank) => [date, rank]));
  const ranks = dates.map((date) => rankOfDate.get(date)!);
  const rankBelow = (date: string): number => { let low = 0, high = meetingDates.length; while (low < high) { const middle = (low + high) >> 1; if (meetingDates[middle] < date) low = middle + 1; else high = middle; } return low; };
  const closed = ordered.map((item) => item.facts.closes <= now);
  const stillOpen = ordered.map((item) => item.facts.closes > now);
  const weights = meetings.map((meeting) => Number(meeting.attendanceWeight ?? 1));
  const requiredMeeting = meetings.map((meeting) => Boolean(meeting.required));
  const forEveryone = meetings.map((meeting) => meeting.audienceMode === "all");
  const forLabelsOnly = meetings.map((meeting) => meeting.audienceMode === "labels");
  const slots = meetings.map((meeting) => observations.slots.get(meeting.id) ?? -1);
  const audienceNames: (string | undefined)[] = new Array(meetingCount);
  const audience = (index: number) => audienceNames[index] ??= forEveryone[index] ? "All" : meetings[index].audienceLabelIds.map((id) => labelNames.get(id) ?? "Retired label").join(", ");
  // Dates between the same rule start and end dates, and on the same side of the policy's activation, have the same rule
  // in force for every label: they share a regime.
  const regimes: { before: boolean; ruleOf: Map<string, AttendanceRule | undefined> }[] = [];
  const startCuts = [...new Set([...rules.flatMap((rule) => rule.startsOn ? [rule.startsOn] : []), ...(input.policyActivatedOn ? [input.policyActivatedOn] : [])])].sort();
  const endCuts = [...new Set(rules.flatMap((rule) => rule.endsOn ? [rule.endsOn] : []))].sort();
  const regimeNumbers = new Map<number, number>();
  let startsPassed = 0, endsPassed = 0, cutDate = "";
  const regimeOf = dates.map((date) => {
    if (date < cutDate) { startsPassed = 0; endsPassed = 0; }
    while (startsPassed < startCuts.length && startCuts[startsPassed] <= date) startsPassed += 1;
    while (endsPassed < endCuts.length && endCuts[endsPassed] < date) endsPassed += 1;
    cutDate = date;
    const key = startsPassed * (endCuts.length + 1) + endsPassed;
    let regime = regimeNumbers.get(key);
    if (regime === undefined) {
      const ruleOf = new Map<string, AttendanceRule | undefined>();
      for (const labelId of rulesByLabel.keys()) ruleOf.set(labelId, ruleAt(labelId, date));
      regime = regimes.length; regimes.push({ before: Boolean(input.policyActivatedOn && date < input.policyActivatedOn), ruleOf }); regimeNumbers.set(key, regime);
    }
    return regime;
  });
  const regimeCount = regimes.length;
  const regimeBefore = regimeOf.map((regime) => regimes[regime].before);
  const todayWeek = weekOf(today);
  // Weeks are numbered in meeting order; only weekly policies use them.
  const anyWeekly = rules.some((rule) => rule.ruleType === "weekly_count");
  const weekNumbers = new Map<string, number>(); const weeksInOrder: { start: string; end: string }[] = [];
  const weekNumberOf = anyWeekly ? dates.map((date) => { const week = weekOf(date); let number = weekNumbers.get(week.start); if (number === undefined) { number = weeksInOrder.length; weeksInOrder.push(week); weekNumbers.set(week.start, number); } return number; }) : [];
  const useCurrent = input.membership === "current";
  const evaluated = input.members.map((member) => {
    const changes = changesByMember.get(member.id) ?? [];
    // A member's labels on a date are the changes effective by then, applied in order.
    const labelSets: (Set<string> | undefined)[] = [];
    const labelsAfter = (applied: number): Set<string> => {
      let labels = labelSets[applied];
      if (!labels) { labels = new Set(); for (let index = 0; index < applied; index += 1) { const change = changes[index]; if (change.action === "add") labels.add(change.labelId); else labels.delete(change.labelId); } labelSets[applied] = labels; }
      return labels;
    };
    const appliedBy = (date: string): number => { let applied = 0; while (applied < changes.length && !(changes[applied].effectiveDate > date)) applied += 1; return applied; };
    // Read once per member, and only when there is a meeting to check, as each meeting used to read it.
    const inactivePeriods: [number, number | null][] = meetingCount ? (JSON.parse(member.inactivePeriodsJson ?? "[]") as [string, string | null][]).map(([from, to]) => [Date.parse(from), to === null ? null : Date.parse(to)]) : [];
    const everInactive = inactivePeriods.length > 0;
    const isInactive = (start: number): boolean => {
      for (const period of inactivePeriods) if (start >= period[0] && (period[1] === null || start < period[1])) return true;
      return false;
    };
    const currentApplied = appliedBy(today);
    const currentLabels = labelsAfter(currentApplied);
    const participationStart = participationStartOf(member, input.timeZone);
    // A meeting counts from the participation start: its date is not before it.
    const startRank = participationStart ? rankBelow(participationStart) : 0;
    const currentLabelIds = [...currentLabels];
    const currentPolicyLabelIds = currentLabelIds.filter((id) => rulesByLabel.has(id));
    const currentLabelId = currentPolicyLabelIds[0] ?? null;
    const currentRule = currentLabelId ? ruleAt(currentLabelId, today) : undefined;
    const summaryLabelIds = [...new Set([...currentPolicyLabelIds, ...(input.summaryLabelIds ?? [])])];
    // Percentage policies count their own meetings; those rows are gathered in the same pass as everything else.
    const percentageRowsByRule = new Map<AttendanceRule, PercentageRow[]>();
    for (const labelId of summaryLabelIds) for (const rule of rulesByLabel.get(labelId)?.all ?? []) if (rule.ruleType === "weighted_percentage") percentageRowsByRule.set(rule, []);
    const rows: PolicyMemberOutline["rows"] = [];
    const weekBuckets: WeekBucket[] = []; const weeksByKey = new Map<string, (WeekBucket | undefined)[]>();
    const standings: (Standing | undefined)[] = new Array((changes.length + 1) * regimeCount);
    const standingFor = (applied: number, regimeIndex: number): Standing => {
      const regime = regimes[regimeIndex]; const labels = labelsAfter(applied); const labelIds = [...labels];
      const labelId = labelIds.find((id) => rulesByLabel.has(id)) ?? (regime.before ? labelIds.find((id) => legacyFormulaLabels.has(id)) : undefined);
      const rule = labelId ? regime.ruleOf.get(labelId) : undefined;
      const weekly = rule?.ruleType === "weekly_count";
      const legacy = Boolean(rule?.id.startsWith("legacy:") && regime.before);
      const weeklyEntries = labelIds.flatMap((activeLabelId) => {
        const activeRule = regime.ruleOf.get(activeLabelId);
        return activeRule?.ruleType === "weekly_count" ? [{ labelId: activeLabelId, rule: activeRule }] : [];
      });
      if (weekly && labelId && legacy && !weeklyEntries.some((entry) => entry.labelId === labelId && entry.rule.id === rule!.id)) weeklyEntries.push({ labelId, rule: rule! });
      const entries = weeklyEntries.map((entry) => {
        const entryLegacy = Boolean(entry.rule.id.startsWith("legacy:") && regime.before);
        // One bucket per label, rule and week; every legacy rule of a label shares that label's legacy buckets.
        const key = entry.labelId + ":" + (entryLegacy ? "legacy" : entry.rule.id);
        let weeks = weeksByKey.get(key);
        if (!weeks) { weeks = new Array(weeksInOrder.length); weeksByKey.set(key, weeks); }
        return { labelId: entry.labelId, rule: entry.rule, legacy: entryLegacy, target: Number(entry.rule.meetingsPerWeek), weeks };
      });
      const percentage: PercentageRow[][] = [];
      for (const [wanted, list] of percentageRowsByRule) if (labels.has(wanted.labelId) && regime.ruleOf.get(wanted.labelId)?.id === wanted.id) percentage.push(list);
      const standing: Standing = {
        labels, labelIds, eligibilityLabels: legacy && labelId ? new Set([labelId]) : labels,
        historicalMatch: !historicalLabelIds.length || (input.historicalLabelMatch === "all" ? historicalLabelIds.every((id) => labels.has(id)) : historicalLabelIds.some((id) => labels.has(id))),
        ruleId: rule?.id ?? null, legacyRule: Boolean(rule?.id.startsWith("legacy:")), weekly, formula: Boolean(weekly || !rule && labelId ? labelId : undefined), entries, percentage,
      };
      standings[applied * regimeCount + regimeIndex] = standing;
      return standing;
    };
    const own = observations.byMember.get(member.id);
    // Meetings run in date order, so the count of changes effective by a meeting's date only moves forward.
    // A change is in effect on a meeting's date unless it takes effect later: unless the date ranks below it.
    const changeCount = changes.length; const changeRanks = changes.map((change) => rankBelow(change.effectiveDate)); let appliedNow = 0, appliedRank = -1;
    const codes = own?.codes;
    let requiredCount = 0, weightedPresent = 0, weightedTotal = 0, weightedAdjusted = 0;
    let weeklyCount = 0, weeklyAttended = 0, weeklyAllLegacy = true, allBeforeActivation = true;
    let regularCount = 0, regularAttended = 0, regularExcused = 0, regularPresent = 0, regularRequired = 0;
    for (let index = 0; index < meetingCount; index += 1) {
      if (everInactive && isInactive(starts[index])) continue;
      const date = dates[index];
      // Saved reports can apply today's membership across their period without rewriting label history.
      const rank = ranks[index];
      if (rank !== appliedRank) { if (rank < appliedRank) appliedNow = 0; while (appliedNow < changeCount && !(rank < changeRanks[appliedNow])) appliedNow += 1; appliedRank = rank; }
      const applied = useCurrent ? currentApplied : appliedNow;
      const regimeIndex = regimeOf[index];
      const standing = standings[applied * regimeCount + regimeIndex] ?? standingFor(applied, regimeIndex);
      if (!standing.historicalMatch) continue;
      const labels = standing.labels;
      const forAll = forEveryone[index], forLabels = forLabelsOnly[index];
      const audienceIds = meetings[index].audienceLabelIds;
      let inAudience = forAll;
      if (!forAll) for (const id of audienceIds) if (labels.has(id)) { inAudience = true; break; }
      const eligibleDate = rank >= startRank;
      const completed = closed[index];
      const slot = slots[index];
      const code = codes && slot >= 0 ? codes[slot] : noObservation;
      const observation = detail || code === otherCode ? own?.found[slot] : undefined;
      const disposition: Observation["disposition"] = code === presentCode ? "present" : code === excusedCode ? "excused" : code === otherCode ? observation!.disposition : "absent";
      // meetingEligibility, with the member's standing already worked out.
      const eligibility: Eligibility = !eligibleDate ? "before_start"
        : forLabels && !(standing.eligibilityLabels === labels ? inAudience : audienceIds.some((id) => standing.eligibilityLabels.has(id))) ? "outside_audience"
        : standing.formula ? standing.weekly ? "weekly" : "no_target"
        : requiredMeeting[index] ? "required" : "optional";
      if (eligibleDate) for (const entry of standing.entries) {
        if (!(entry.legacy ? forAll || audienceIds.some((id) => id === entry.labelId) : inAudience)) continue;
        const weekNumber = weekNumberOf[index];
        let bucket = entry.weeks[weekNumber];
        if (!bucket) {
          const { start, end } = weeksInOrder[weekNumber];
          bucket = {
            rule: entry.rule, labelId: entry.labelId, weekStartsOn: start, weekEndsOn: end,
            segmentStartsOn: entry.legacy ? start : laterOf(laterOf(laterOf(start, entry.rule.startsOn ?? start), participationStart || start), input.from ?? start),
            segmentEndsOn: entry.legacy ? end : earlierOf(earlierOf(end, entry.rule.endsOn ?? end), input.to ?? end),
            target: entry.target, legacy: entry.legacy, opportunities: 0, attended: 0, excused: 0, pending: false,
          };
          entry.weeks[weekNumber] = bucket; weekBuckets.push(bucket);
        }
        bucket.target = Math.max(bucket.target, entry.target);
        bucket.opportunities++;
        if (completed) { if (disposition === "present") bucket.attended++; if (disposition === "excused") bucket.excused++; }
        else bucket.pending = true;
      }
      const attended = disposition === "present";
      const regularWeight = weights[index];
      if (standing.percentage.length && eligibleDate && !stillOpen[index] && requiredMeeting[index] && !(forLabels && !inAudience)) {
        const row = { date, disposition, attended, weight: regularWeight };
        for (const list of standing.percentage) list.push(row);
      }
      if (!completed) continue;
      const weight = standing.weekly ? 1 : regularWeight;
      const regularEligible = eligibleDate && inAudience && requiredMeeting[index];
      if (eligibility === "required") { requiredCount++; weightedPresent += attended ? weight : 0; weightedTotal += weight; weightedAdjusted += disposition === "excused" ? 0 : weight; }
      else if (eligibility === "weekly") { weeklyCount++; if (attended) weeklyAttended++; if (!standing.legacyRule) weeklyAllLegacy = false; }
      if (!regimeBefore[index]) allBeforeActivation = false;
      if (regularEligible) { regularCount++; regularPresent += attended ? regularWeight : 0; regularRequired += regularWeight; if (attended) regularAttended++; if (disposition === "excused") regularExcused++; }
      if (detail) {
        const row: PolicyRow = { meetingId: meetings[index].id, memberId: member.id, disposition, eligibility, policy: standing.weekly ? "weekly" : "standard", ruleId: standing.ruleId, rateEligible: eligibility === "required" || eligibility === "weekly", regularEligible, attended, weight, regularWeight, audience: audience(index), memberLabelIds: standing.labelIds.slice(), checkedInAt: observation?.checkedInAt, checkedOutAt: observation?.checkedOutAt, reason: observation?.reason };
        rows.push(row);
      } else rows.push({ eligibility, ruleId: standing.ruleId });
    }
    const weeks: PolicyWeek[] = weekBuckets.map((bucket) => {
      const target = bucket.target;
      const denominator = Math.min(bucket.opportunities, target);
      const adjustedDenominator = Math.min(bucket.opportunities - bucket.excused, target);
      const numerator = Math.min(bucket.attended, target);
      const pending = bucket.pending || bucket.segmentEndsOn >= today;
      const status: PolicyWeek["status"] = bucket.opportunities === 0 || adjustedDenominator === 0 && !pending && !bucket.legacy ? "not_applicable" : pending ? "pending" : bucket.attended >= (bucket.legacy ? denominator : adjustedDenominator) ? "met" : "below";
      return { weekStartsOn: bucket.weekStartsOn, weekEndsOn: bucket.weekEndsOn, segmentStartsOn: bucket.segmentStartsOn, segmentEndsOn: bucket.segmentEndsOn, labelId: bucket.labelId, ruleId: bucket.rule.id, target, opportunities: bucket.opportunities, attended: bucket.attended, excused: bucket.excused, numerator, denominator, adjustedDenominator, rate: rate(numerator, denominator), adjustedRate: rate(numerator, adjustedDenominator), belowTarget: status === "below", status };
    }).sort((a, b) => a.segmentStartsOn.localeCompare(b.segmentStartsOn));
    for (const activeLabelId of currentPolicyLabelIds) {
      if (input.from && input.from > today || input.to && input.to < today) continue;
      const activeRule = ruleAt(activeLabelId, today);
      if (activeRule?.ruleType !== "weekly_count" || weeks.some((week) => week.ruleId === activeRule.id && week.weekStartsOn === todayWeek.start)) continue;
      const start = todayWeek.start;
      weeks.push({ weekStartsOn: start, weekEndsOn: todayWeek.end, segmentStartsOn: [start, activeRule.startsOn ?? start, participationStart || start].sort().at(-1)!, segmentEndsOn: [todayWeek.end, activeRule.endsOn ?? "9999-12-31"].sort()[0], labelId: activeLabelId, ruleId: activeRule.id, target: Number(activeRule.meetingsPerWeek), opportunities: 0, attended: 0, excused: 0, numerator: 0, denominator: 0, adjustedDenominator: 0, rate: null, adjustedRate: null, belowTarget: false, status: "not_applicable" });
    }
    const weeklyPresent = weeks.reduce((sum, week) => sum + week.numerator, 0);
    const weeklyTotal = weeks.reduce((sum, week) => sum + week.denominator, 0);
    const weeklyAdjusted = weeks.reduce((sum, week) => sum + week.adjustedDenominator, 0);
    const hasWeekly = weeklyCount > 0 || currentRule?.ruleType === "weekly_count";
    const hasStandard = requiredCount > 0;
    const policy = hasWeekly ? hasStandard ? "mixed" : "weekly" : "standard";
    const dueWeeks = weeks.filter((week) => week.status === "met" || week.status === "below");
    const legacyOnly = Boolean(input.policyActivatedOn && weeklyCount && allBeforeActivation && weeklyAllLegacy);
    const allTimeRate = policy === "weekly" ? legacyOnly ? rate(weeklyPresent, weeklyTotal) : rate(dueWeeks.filter((week) => week.status === "met").length, dueWeeks.length) : policy === "standard" ? rate(weightedPresent, weightedTotal) : null;
    const allTimeAdjusted = policy === "weekly" ? legacyOnly ? rate(weeklyPresent, weeklyAdjusted) : allTimeRate : policy === "standard" ? rate(weightedPresent, weightedAdjusted) : null;
    const regularAttendance: RegularAttendance = { rate: rate(regularPresent, regularRequired), preciseRate: preciseRate(regularPresent, regularRequired), attended: regularPresent, required: regularRequired, meetingsAttended: regularAttended, meetingsRequired: regularCount, meetingsExcused: regularExcused, from: input.from ?? (participationStart || null), to: input.to ?? today };
    const percentageRows = (rule: AttendanceRule, from?: string) => {
      const selected = percentageRowsByRule.get(rule) ?? [];
      return from ? selected.filter((row) => row.date >= from) : selected;
    };
    const historySummaries: PolicyHistory[] = summaryLabelIds.flatMap((activeLabelId) => (rulesByLabel.get(activeLabelId)?.all ?? []).filter((rule) => (!input.from || !rule.endsOn || rule.endsOn >= input.from) && (!input.to || !rule.startsOn || rule.startsOn <= input.to)).map((rule) => {
      const selectedRows = rule.ruleType === "weighted_percentage" ? percentageRows(rule) : [];
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
      const ruleWeeks = rule.ruleType === "weekly_count" ? weeks.filter((week) => week.ruleId === rule.id) : [];
      // A label set's status: a weekly policy's week that hasn't ended is In progress until it is met; any missed week is Below target.
      const pendingWeeks = ruleWeeks.filter((week) => week.status === "pending" && week.adjustedDenominator > 0);
      const pendingUnmet = pendingWeeks.filter((week) => week.attended < week.adjustedDenominator).length;
      const setStatus: PolicyHistory["setStatus"] = rule.ruleType === "weighted_percentage" || status === "below" ? status : pendingUnmet ? "pending" : weeksMet || pendingWeeks.length ? "met" : "not_applicable";
      const counts = rule.ruleType === "weighted_percentage" ? plainCounts(selectedRows, rule.excusedHandling ?? "exclude") : { meetingsAttended: ruleWeeks.reduce((sum, week) => sum + week.attended, 0), meetingsCounted: null, meetingsExcused: ruleWeeks.reduce((sum, week) => sum + week.excused, 0) };
      return { ruleId: rule.id, labelId: rule.labelId, labelName: labelNames.get(rule.labelId) ?? "Retired label", ruleType: rule.ruleType, excusedHandling: rule.ruleType === "weighted_percentage" ? rule.excusedHandling ?? "exclude" : null, startsOn: rule.startsOn ?? null, endsOn: rule.endsOn ?? null, rate: resultRate, unadjustedRate: rule.ruleType === "weighted_percentage" ? rate(numerator, unadjusted) : null, threshold, attended: rule.ruleType === "weighted_percentage" ? numerator : weeksMet, required: rule.ruleType === "weighted_percentage" ? policyDenominator : weeksDue, weeksMet, weeksDue, status, preciseRate: rule.ruleType === "weighted_percentage" ? preciseRate(numerator, policyDenominator) : preciseRate(weeksMet, weeksDue), ...counts, weeksInProgress: pendingUnmet, setStatus };
    }));
    return recentFroms.map((recentFrom): PolicyMemberOutline => {
      const currentCompliances: PolicyCompliance[] = currentPolicyLabelIds.map((activeLabelId) => {
        const activeRule = ruleAt(activeLabelId, today);
        const labelName = labelNames.get(activeLabelId) ?? "Retired label";
        if (!activeRule) return { labelId: activeLabelId, labelName, ruleId: null, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, from: recentFrom, to: today, rate: null, unadjustedRate: null, attended: 0, required: 0, preciseRate: null, meetingsAttended: 0, meetingsCounted: 0, meetingsExcused: 0 };
        if (activeRule.ruleType === "weekly_count") {
          const currentWeek = weeks.find((week) => week.ruleId === activeRule.id && week.weekStartsOn === todayWeek.start);
          return { labelId: activeLabelId, labelName, ruleId: activeRule.id, ruleType: activeRule.ruleType, excusedHandling: null, status: currentWeek?.status ?? "not_applicable", threshold: Number(activeRule.meetingsPerWeek), from: currentWeek?.segmentStartsOn ?? todayWeek.start, to: currentWeek?.segmentEndsOn ?? todayWeek.end, rate: currentWeek?.adjustedRate ?? null, unadjustedRate: currentWeek?.rate ?? null, attended: currentWeek?.attended ?? 0, required: currentWeek?.adjustedDenominator ?? 0, preciseRate: currentWeek ? preciseRate(currentWeek.numerator, currentWeek.adjustedDenominator) : null, meetingsAttended: currentWeek?.attended ?? 0, meetingsCounted: currentWeek ? currentWeek.opportunities - currentWeek.excused : 0, meetingsExcused: currentWeek?.excused ?? 0 };
        }
        const recent = percentageRows(activeRule, recentFrom);
        const recentPresent = recent.reduce((sum, row) => sum + (row.attended ? row.weight : 0), 0);
        const recentTotal = recent.reduce((sum, row) => sum + row.weight, 0);
        const recentAdjusted = recent.reduce((sum, row) => sum + (row.disposition === "excused" ? 0 : row.weight), 0);
        const required = activeRule.excusedHandling === "count_missed" ? recentTotal : recentAdjusted;
        return { labelId: activeLabelId, labelName, ruleId: activeRule.id, ruleType: activeRule.ruleType, excusedHandling: activeRule.excusedHandling ?? "exclude", status: required === 0 ? "not_applicable" : rawRate(recentPresent, required)! >= Number(activeRule.thresholdPercent) ? "met" : "below", threshold: Number(activeRule.thresholdPercent), from: recentFrom, to: today, rate: rate(recentPresent, required), unadjustedRate: rate(recentPresent, recentTotal), attended: recentPresent, required, preciseRate: preciseRate(recentPresent, required), ...plainCounts(recent, activeRule.excusedHandling) };
      });
      const currentCompliance: PolicyCompliance = currentCompliances[0] ?? { labelId: null, labelName: null, ruleId: null, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, from: recentFrom, to: today, rate: null, unadjustedRate: null, attended: 0, required: 0, preciseRate: null, meetingsAttended: 0, meetingsCounted: 0, meetingsExcused: 0 };
      return { member, currentLabelIds, rows, regularAttendance, policy, present: weightedPresent + weeklyPresent, primaryTotal: weightedTotal + weeklyTotal, adjustedTotal: weightedAdjusted + weeklyAdjusted, rate: allTimeRate, adjustedRate: allTimeAdjusted, pooledRate: legacyOnly ? rate(weeklyAttended, weeklyTotal) : null, weeks, belowTargetWeeks: weeks.filter((week) => week.belowTarget), currentCompliances, currentCompliance, historySummaries };
    });
  });
  return recentFroms.map((_, window) => evaluated.map((results) => results[window]));
}

// Synthetic attendance data shaped like what loadPolicyData returns, for tests and measurements that need a whole team.
// Deterministic for a seed. `referenceTeam()` is the size the pre-stable audit budgets against: 150 members, 12 labels,
// 300 meetings in a season, and scans for about seven in ten member-meetings.
import type { AttendanceRule, LabelChange, Observation, PolicyLabel, PolicyMeeting, PolicyMember } from "../../apps/api/src/attendance-policy.ts";

export type TeamData = { members: PolicyMember[]; labels: PolicyLabel[]; changes: LabelChange[]; rules: AttendanceRule[]; meetings: PolicyMeeting[]; observations: Observation[]; timeZone: string; baseline: string | null; recentDays: number; policyActivatedOn: string | null };
export type TeamShape = { seed: number; members: number; labels: number; meetings: number; now: string; timeZone?: string; attendance?: number; /** Odd cases: legacy rules, retired labels, inactive periods, test meetings, offset timestamps. */ irregular?: boolean };

/** mulberry32: small, fast, and the same on every runtime. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = state + 0x6D2B79F5 >>> 0; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const day = 86_400_000;
const isoDate = (instant: number) => new Date(instant).toISOString().slice(0, 10);

export function team(shape: TeamShape): TeamData {
  const next = random(shape.seed); const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]; const chance = (p: number) => next() < p;
  const irregular = shape.irregular ?? false; const now = Date.parse(shape.now);
  // The season runs from about 46 weeks before `now` to one week after it, so a few meetings are still open or ahead.
  const seasonStart = now - 46 * 7 * day; const seasonEnd = now + 7 * day;
  const labels: PolicyLabel[] = Array.from({ length: shape.labels }, (_, index) => ({ id: `label-${index + 1}`, name: `Test Label ${index + 1}`, active: irregular && chance(0.1) ? 0 : 1, formulaEnabled: irregular && chance(0.25) ? 1 : 0 }));
  const policyActivatedOn = irregular && chance(0.6) ? isoDate(seasonStart + Math.floor(next() * 30) * 7 * day) : null;
  const rules: AttendanceRule[] = [];
  for (const label of labels.slice(0, Math.max(1, Math.ceil(shape.labels * 0.6)))) {
    const kind = next();
    const percentage = (id: string, startsOn: string | null, endsOn: string | null): AttendanceRule => ({ id, labelId: label.id, startsOn, endsOn, ruleType: "weighted_percentage", thresholdPercent: pick([60, 70, 75, 80, 90]), meetingsPerWeek: null, excusedHandling: chance(0.3) ? "count_missed" : "exclude" });
    const weekly = (id: string, startsOn: string | null, endsOn: string | null): AttendanceRule => ({ id, labelId: label.id, startsOn, endsOn, ruleType: "weekly_count", thresholdPercent: null, meetingsPerWeek: pick([1, 2, 2, 3]), excusedHandling: "exclude" });
    if (kind < 0.35) rules.push(percentage(`rule-${label.id}-default`, null, null));
    else if (kind < 0.55) rules.push(weekly(`rule-${label.id}-default`, null, null));
    else {
      // Dated periods, not overlapping, sometimes on top of a default rule; periods start midweek so weeks split.
      const split = isoDate(seasonStart + Math.floor(10 + next() * 25) * 7 * day + Math.floor(next() * 7) * day);
      const before = isoDate(Date.parse(split + "T00:00:00Z") - day);
      rules.push((chance(0.5) ? weekly : percentage)(`rule-${label.id}-early`, isoDate(seasonStart - 30 * day), before));
      rules.push((chance(0.5) ? weekly : percentage)(`rule-${label.id}-late`, split, chance(0.5) ? null : isoDate(seasonEnd + 30 * day)));
      if (chance(0.3)) rules.push(percentage(`rule-${label.id}-default`, null, null));
    }
  }
  if (irregular && policyActivatedOn) for (const label of labels.filter((item) => item.formulaEnabled).slice(0, 2)) {
    if (!rules.some((rule) => rule.labelId === label.id && rule.startsOn)) rules.push({ id: `legacy:${label.id}`, labelId: label.id, startsOn: isoDate(seasonStart - 10 * day), endsOn: isoDate(Date.parse(policyActivatedOn + "T00:00:00Z") - day), ruleType: "weekly_count", thresholdPercent: null, meetingsPerWeek: pick([1, 2]), excusedHandling: "exclude" });
  }
  rules.sort((a, b) => a.labelId.localeCompare(b.labelId) || (a.startsOn ?? "").localeCompare(b.startsOn ?? ""));
  const members: PolicyMember[] = []; const changes: LabelChange[] = [];
  for (let index = 0; index < shape.members; index += 1) {
    const id = `member-${index + 1}`; const added = seasonStart - 20 * day + (chance(0.8) ? 0 : Math.floor(next() * 200) * day) + Math.floor(next() * day);
    const inactive: [string, string | null][] = [];
    if (irregular && chance(0.2)) { const from = seasonStart + Math.floor(next() * 200) * day; inactive.push([new Date(from).toISOString(), chance(0.7) ? new Date(from + Math.floor(1 + next() * 60) * day).toISOString() : null]); }
    members.push({ id, memberId: `TEST-${index + 1}`, firstName: "Test Student", lastName: String(index + 1).padStart(3, "0"), email: `student${index + 1}@example.test`, discordUserId: null, active: inactive.at(-1)?.[1] === null ? 0 : 1, inactivePeriodsJson: JSON.stringify(inactive), attendanceRequiredFrom: chance(0.5) ? isoDate(added + Math.floor(next() * 14) * day) : null, rosterAddedAt: irregular && chance(0.3) ? new Date(added).toISOString().slice(0, 19).replace("T", " ") : new Date(added).toISOString() });
    // One to three labels from the start, and for some members a label swapped mid-season.
    const own = new Set<string>(); const count = 1 + Math.floor(next() * 3);
    while (own.size < Math.min(count, labels.length)) own.add(pick(labels).id);
    for (const labelId of own) changes.push({ memberId: id, labelId, action: "add", effectiveDate: isoDate(seasonStart - 20 * day), createdAt: new Date(added).toISOString() });
    if (chance(irregular ? 0.5 : 0.2)) {
      const when = isoDate(seasonStart + Math.floor(next() * 300) * day); const removed = pick([...own]); const added2 = pick(labels).id;
      changes.push({ memberId: id, labelId: removed, action: "remove", effectiveDate: when, createdAt: new Date(now - 100 * day).toISOString() });
      if (added2 !== removed) changes.push({ memberId: id, labelId: added2, action: "add", effectiveDate: when, createdAt: new Date(now - 100 * day + 1000).toISOString() });
    }
  }
  changes.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const meetings: PolicyMeeting[] = [];
  for (let index = 0; index < shape.meetings; index += 1) {
    const start = seasonStart + Math.floor((seasonEnd - seasonStart) * index / shape.meetings / 900_000) * 900_000 + (irregular ? Math.floor(next() * 8) * 3_600_000 : 0); const end = start + pick([60, 90, 120, 180]) * 60_000;
    const stamp = (instant: number) => irregular && chance(0.1) ? new Date(instant - 5 * 3_600_000).toISOString().replace(".000Z", "-05:00") : new Date(instant).toISOString();
    const audience = chance(0.3) ? [...new Set(Array.from({ length: 1 + Math.floor(next() * 2) }, () => pick(labels).id))] : [];
    meetings.push({ id: `meeting-${index + 1}`, title: `Test Meeting ${index + 1}`, startsAt: stamp(start), endsAt: stamp(end), attendanceClosesAt: new Date(end + 30 * 60_000).toISOString(), required: chance(0.8) ? 1 : 0, attendanceWeight: pick([1, 1, 1, 1, 2, 0.5, 1.5]), audienceMode: audience.length ? "labels" : "all", audienceLabelIds: audience, isTest: irregular && chance(0.03) ? 1 : 0 });
  }
  // loadPolicyData orders meetings newest first.
  meetings.reverse();
  const observations: Observation[] = []; const attendance = shape.attendance ?? 0.7;
  for (const meeting of meetings) {
    if (Date.parse(meeting.startsAt) > now) continue;
    for (const member of members) {
      if (!chance(attendance)) continue;
      const roll = next(); const checkedInAt = new Date(Date.parse(meeting.startsAt) + Math.floor(next() * 600_000)).toISOString();
      if (roll < 0.86) observations.push({ meetingId: meeting.id, memberId: member.id, disposition: "present", checkedInAt, checkedOutAt: chance(0.8) ? new Date(Date.parse(meeting.endsAt) - Math.floor(next() * 600_000)).toISOString() : undefined, reason: undefined });
      else if (roll < 0.92) observations.push({ meetingId: meeting.id, memberId: member.id, disposition: "excused", checkedInAt: undefined, checkedOutAt: undefined, reason: "Synthetic excuse" });
      else if (roll < 0.96) observations.push({ meetingId: meeting.id, memberId: member.id, disposition: "absent", checkedInAt: undefined, checkedOutAt: undefined, reason: "Synthetic correction" });
      else observations.push({ meetingId: meeting.id, memberId: member.id, disposition: "active", checkedInAt, checkedOutAt: undefined, reason: undefined });
    }
  }
  return { members, labels, changes, rules, meetings, observations, timeZone: shape.timeZone ?? "America/New_York", baseline: null, recentDays: 30, policyActivatedOn };
}

export const referenceNow = "2026-11-20T18:00:00.000Z";
export const referenceTeam = (): TeamData => team({ seed: 20261120, members: 150, labels: 12, meetings: 300, now: referenceNow });

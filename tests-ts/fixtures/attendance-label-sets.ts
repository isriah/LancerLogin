// Synthetic installation for "Attendance by label" coverage: four labels (two percentage policies, one weekly policy and
// one without a policy), five Test Students and five required September meetings, one of them with weight 2. Expected
// values are worked out in tests-ts/attendance-label-sets.test.ts.
import { InstallationSeed } from "./d1-database.ts";

export const labelSetLabels = Object.freeze({ robotics: "Test Robotics Class", build: "Test Build Team", outreach: "Test Outreach Crew", mentors: "Test Mentors" });
export const labelSetPeriod = Object.freeze({ type: "fixed" as const, from: "2026-09-01", to: "2026-09-30" });

const meetings = [
  ["m1", "Test meeting 1", "2026-09-01", 1],
  ["m2", "Test meeting 2", "2026-09-03", 1],
  ["m3", "Test meeting 3", "2026-09-08", 1],
  ["m4", "Test build day", "2026-09-10", 2],
  ["m5", "Test meeting 5", "2026-09-15", 1],
] as const;
// P present, E excused, anything else absent; one letter per meeting above.
const outcomes: Record<string, string> = { a: "PPEPA", b: "PPPPP", c: "PAAAP", d: "PPPPP", e: "PPPAP" };

/** The seed SQL for TestD1Database or a Miniflare D1 database. */
export function labelSetSeedSql(): string {
  const seed = new InstallationSeed("2026-01-01T00:00:00.000Z").users("admin").organization("UTC")
    .members(
      { id: "a", externalId: "TEST-001", firstName: "Test Student", lastName: "A", attendanceRequiredFrom: "2026-08-01" },
      { id: "b", externalId: "TEST-002", firstName: "Test Student", lastName: "B", attendanceRequiredFrom: "2026-08-01" },
      { id: "c", externalId: "TEST-003", firstName: "Test Student", lastName: "C", attendanceRequiredFrom: "2026-08-01" },
      { id: "d", externalId: "TEST-004", firstName: "Test Student", lastName: "D", attendanceRequiredFrom: "2026-10-01" },
      { id: "e", externalId: "TEST-005", firstName: "Test Student", lastName: "E", attendanceRequiredFrom: "2026-08-01" },
    )
    .modules({ id: "attendance", phase: "enabled", setupVersion: 2, setupComplete: true })
    .setupProgress("attendance", 2, ["rules", "meeting", "input"], "2026-01-01T00:00:00.000Z", "admin");
  seed.add(`UPDATE members SET email = lower(replace(first_name || '.' || last_name, ' ', '.')) || '@example.test';`);
  seed.add(`INSERT INTO member_labels(id,installation_id,name,active,formula_enabled,created_at) VALUES ('robotics','primary','${labelSetLabels.robotics}',1,0,'2026-01-01'),('build','primary','${labelSetLabels.build}',1,0,'2026-01-01'),('outreach','primary','${labelSetLabels.outreach}',1,0,'2026-01-01'),('mentors','primary','${labelSetLabels.mentors}',1,0,'2026-01-01');`);
  seed.add(`INSERT INTO label_attendance_rules(id,installation_id,label_id,starts_on,ends_on,rule_type,threshold_percent,meetings_per_week,excused_handling,created_at,updated_at) VALUES ('rule-robotics','primary','robotics',NULL,NULL,'weighted_percentage',80,NULL,'exclude','2026-01-01','2026-01-01'),('rule-build','primary','build',NULL,NULL,'weighted_percentage',75,NULL,'count_missed','2026-01-01','2026-01-01'),('rule-outreach','primary','outreach',NULL,NULL,'weekly_count',NULL,2,'exclude','2026-01-01','2026-01-01');`);
  const holds: [string, string][] = [["a", "robotics"], ["a", "build"], ["b", "robotics"], ["b", "build"], ["c", "robotics"], ["d", "robotics"], ["d", "build"], ["e", "outreach"]];
  seed.add(`INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_at) VALUES ${holds.map(([member, label]) => `('${member}-${label}','primary','${member}','${label}','add','2026-08-01','2026-08-01')`).join(",")};`);
  seed.add(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,attendance_weight,audience_mode,created_by,created_at) VALUES ${meetings.map(([id, title, date, weight]) => `('${id}','primary','${title}','${date}T18:00:00.000Z','${date}T20:00:00.000Z',1,${weight},'all','admin','2026-08-01')`).join(",")};`);
  const corrections = Object.entries(outcomes).flatMap(([member, marks]) => [...marks].flatMap((mark, index) => mark === "P" || mark === "E" ? [`('${member}-${meetings[index]![0]}','primary','${member}','${meetings[index]![0]}','${mark === "P" ? "present" : "excused"}','Synthetic test outcome','admin','2026-09-20T00:00:00.000Z')`] : []));
  seed.add(`INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) VALUES ${corrections.join(",")};`);
  return seed.sql();
}

/** A Members - Attendance report with Overall rate and a column set for each label, ranked by Overall rate. */
export function labelSetDefinition(sets: readonly { labelId: string; weekly?: boolean }[], extra: Record<string, unknown> = {}) {
  const keys = (weekly?: boolean) => ["attendance.label.rate", "attendance.label.target", "attendance.label.status", "attendance.label.attended", weekly ? "attendance.label.weeks-met" : "attendance.label.counted", "attendance.label.excused"];
  return {
    version: 2, dataset: "attendance.members", groupBy: ["core.member.identity"], period: labelSetPeriod, roster: "active", meetingType: "all", labelIds: sets.map((set) => set.labelId), labelMatch: "any", membership: "current",
    columns: [{ key: "core.member.name" }, { key: "attendance.member.regular-rate" }, ...sets.flatMap((set) => keys(set.weekly).map((key) => ({ key, labelId: set.labelId })))],
    columnFilters: [], sort: { column: { key: "attendance.member.regular-rate" }, direction: "desc" }, ...extra,
  };
}

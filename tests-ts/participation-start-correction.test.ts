// quick-check: covers apps/api/migrations/**
// The one-time correction of participation start dates that were stored as the UTC date of the roster-added instant
// (apps/api/src/participation-start-correction.ts, migration 0107): which dates it changes, which it leaves alone, what
// it records, what a pass costs, and what a restore does to it. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, runSchedulerSlice, type Env } from "../apps/api/src/index.ts";
import { evaluateAttendance, localDate } from "../apps/api/src/attendance-policy.ts";
import { correctParticipationStarts, correctedParticipationStart, startCorrectionEffect, startCorrectionReset, START_CORRECTION_ACTION, START_CORRECTION_BATCH, START_CORRECTION_WORK_QUERIES } from "../apps/api/src/participation-start-correction.ts";
import { SchedulerBudget, scheduledSliceLimits } from "../apps/api/src/scheduler-budget.ts";
import type { D1Database } from "../apps/api/src/d1-usage.ts";
import { InstallationSeed, TestD1Database, attendanceWithOutreachDisabled } from "./fixtures/d1-database.ts";
import { BackupDatabase, backupClient, sessionSecret } from "./fixtures/backup-database.ts";
import { referenceNow, referenceTeam } from "./fixtures/attendance-team.ts";

const pacific = "America/Los_Angeles";
const start = (rosterAddedAt: string, attendanceRequiredFrom: string | null, timeZone: string) => correctedParticipationStart({ rosterAddedAt, attendanceRequiredFrom }, timeZone);

test("a stored UTC date becomes the organization-local date of the same instant, west and east of UTC", () => {
  // 6 pm Pacific on 1 September is already 2 September in UTC.
  assert.equal(start("2026-09-02T01:00:00.000Z", "2026-09-02", pacific), "2026-09-01");
  assert.equal(start("2026-09-02T03:59:00.000Z", "2026-09-02", "America/New_York"), "2026-09-01");
  // 8 am in Auckland on 2 September is still 1 September in UTC; so is 1:30 am in Kolkata.
  assert.equal(start("2026-09-01T20:00:00.000Z", "2026-09-01", "Pacific/Auckland"), "2026-09-02");
  assert.equal(start("2026-09-01T20:00:00.000Z", "2026-09-01", "Asia/Kolkata"), "2026-09-02");
  // SQLite's own timestamps carry no zone and are UTC.
  assert.equal(start("2026-09-02 01:00:00", "2026-09-02", pacific), "2026-09-01");
  // The same day in both: nothing to correct.
  assert.equal(start("2026-09-01T19:00:00.000Z", "2026-09-01", pacific), null);
  assert.equal(start("2026-09-01T02:00:00.000Z", "2026-09-01", "Pacific/Auckland"), null);
  for (const zone of ["UTC", "Etc/UTC", "Africa/Abidjan"]) assert.equal(start("2026-09-02T01:00:00.000Z", "2026-09-02", zone), null, zone);
});

test("the correction follows the zone's daylight saving rules on the date in question", () => {
  // Pacific time is UTC-8 until 8 March 2026 and from 1 November 2026, UTC-7 between. 07:30 UTC is 23:30 the day
  // before in winter and 00:30 the same day in summer.
  assert.equal(start("2026-03-07T07:30:00.000Z", "2026-03-07", pacific), "2026-03-06");
  assert.equal(start("2026-03-08T07:30:00.000Z", "2026-03-08", pacific), "2026-03-07", "two and a half hours before the clocks go forward");
  assert.equal(start("2026-03-09T07:30:00.000Z", "2026-03-09", pacific), null);
  assert.equal(start("2026-07-15T07:30:00.000Z", "2026-07-15", pacific), null);
  assert.equal(start("2026-11-01T07:30:00.000Z", "2026-11-01", pacific), null, "an hour and a half before the clocks go back");
  assert.equal(start("2026-11-02T07:30:00.000Z", "2026-11-02", pacific), "2026-11-01");
  // South of the equator the seasons are reversed: Auckland is UTC+13 in January and UTC+12 in July.
  assert.equal(start("2026-01-10T11:30:00.000Z", "2026-01-10", "Pacific/Auckland"), "2026-01-11");
  assert.equal(start("2026-07-10T11:30:00.000Z", "2026-07-10", "Pacific/Auckland"), null);
});

test("a date that is not the UTC date of the roster-added instant is never corrected", () => {
  assert.equal(start("2026-09-02T01:00:00.000Z", "2026-09-01", pacific), null, "already the local date");
  assert.equal(start("2026-09-02T01:00:00.000Z", "2026-09-03", pacific), null, "typed by an Admin");
  assert.equal(start("2026-09-02T01:00:00.000Z", "2026-08-15", pacific), null);
  assert.equal(start("2026-09-02T01:00:00.000Z", null, pacific), null, "no stored date: derived on every read");
  assert.equal(start("2026-09-02", "2026-09-02", pacific), null, "a bare date has no instant");
  assert.equal(start("not a time", "2026-09-02", pacific), null);
  // A timestamp with its own offset: the UTC date is what counts, not the date as written.
  assert.equal(start("2026-09-01T18:00:00-07:00", "2026-09-01", pacific), null);
  assert.equal(start("2026-09-01T18:00:00-07:00", "2026-09-02", pacific), "2026-09-01");
});

type Member = { id: string; added: string; stored: string | null };
type MeetingOptions = { required?: boolean; audience?: string[] };
function installation(context: { after(fn: () => void): void }, timeZone: string | null, members: Member[]) {
  const seed = new InstallationSeed("2026-01-01T00:00:00.000Z").users("admin");
  const database = new TestD1Database({ seed: timeZone ? seed.organization(timeZone) : seed }); context.after(() => database.close());
  const { sqlite } = database;
  const insert = sqlite.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) VALUES (?, 'primary', ?, 'Test Student', ?, ?, ?)");
  for (const member of members) insert.run(member.id, member.id.toUpperCase(), member.id, member.added, member.stored);
  const starts = () => Object.fromEntries(sqlite.prepare("SELECT id, attendance_required_from AS s FROM members ORDER BY id").all().map((row) => [String(row.id), row.s as string | null]));
  const audits = () => sqlite.prepare("SELECT id, actor_user_id AS actor, target_type AS targetType, target_id AS targetId, metadata_json AS metadata FROM audit_log WHERE action = ? ORDER BY created_at, id").all(START_CORRECTION_ACTION)
    .map((row) => ({ id: String(row.id), actor: row.actor, targetType: row.targetType, targetId: row.targetId, metadata: JSON.parse(String(row.metadata)) }));
  const state = () => sqlite.prepare("SELECT run_id AS runId, cursor, examined, completed_at AS completedAt, audit_id AS auditId FROM participation_start_correction").get() as { runId: string; cursor: string; examined: number; completedAt: string | null; auditId: string | null } | undefined;
  const revision = () => Number((sqlite.prepare("SELECT revision FROM report_data_revision WHERE installation_id = 'primary'").get() as { revision: number }).revision);
  const audit = (action: string, memberId: string, metadata: unknown, tag = "") => sqlite.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES (?, 'primary', 'admin', ?, 'member', ?, ?, '2026-09-10T00:00:00.000Z')").run(`audit-${action}-${memberId}-${tag}`, action, memberId, JSON.stringify(metadata));
  /** A synthetic test meeting; `audience` names the labels it is for (everyone when omitted). */
  const meeting = (id: string, startsAt: string, endsAt: string, options: MeetingOptions = {}) => {
    sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at,audience_mode) VALUES (?, 'primary', ?, ?, ?, ?, 'admin', '2026-08-01T00:00:00.000Z', ?)").run(id, `Test Meeting ${id}`, startsAt, endsAt, options.required === false ? 0 : 1, options.audience ? "labels" : "all");
    for (const label of options.audience ?? []) {
      sqlite.prepare("INSERT OR IGNORE INTO member_labels(id,installation_id,name,created_at) VALUES (?, 'primary', ?, '2026-08-01T00:00:00.000Z')").run(label, `Test Label ${label}`);
      sqlite.prepare("INSERT INTO meeting_audience_labels(installation_id,meeting_id,label_id) VALUES ('primary', ?, ?)").run(id, label);
    }
  };
  /** A check-in and check-out the kiosk accepted. */
  const scan = (memberId: string, meetingId: string) => {
    const row = sqlite.prepare("SELECT starts_at AS s, ends_at AS e FROM meetings WHERE id = ?").get(meetingId) as { s: string; e: string };
    const event = sqlite.prepare("INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) VALUES (?, 'primary', ?, ?, 'kiosk', ?, ?)");
    event.run(`in-${memberId}-${meetingId}`, memberId, meetingId, new Date(Date.parse(row.s) + 300_000).toISOString(), "check_in"); event.run(`out-${memberId}-${meetingId}`, memberId, meetingId, row.e, "check_out");
  };
  const correction = (memberId: string, meetingId: string, disposition: "present" | "absent" | "excused") => sqlite.prepare("INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) VALUES (?, 'primary', ?, ?, ?, 'Synthetic correction', 'admin', '2026-09-20T00:00:00.000Z')").run(`correction-${memberId}-${meetingId}`, memberId, meetingId, disposition);
  return { database, starts, audits, state, revision, audit, meeting, scan, correction };
}
/** Subrequests as D1 counts them: each batch and each single query is one. */
function counted(database: TestD1Database) {
  const budget = new SchedulerBudget(scheduledSliceLimits);
  return { db: budget.database(database), used: () => budget.d1 };
}
/** Run `between` just before the pass's write batch, once. */
function beforeWrite(database: TestD1Database, between: () => unknown) {
  const batch = database.batch.bind(database);
  database.batch = async (statements) => {
    if (statements.some((statement) => (statement as { sql?: string }).sql?.startsWith("UPDATE participation_start_correction SET cursor"))) { database.batch = batch; await between(); }
    return batch(statements);
  };
}
// Tuesday 1 September 2026, Pacific: a meeting from 6:30 to 8:30 pm, and a member added at 6 pm. Both are already
// 2 September in UTC, so the stored start is the 2nd, and the kiosk, which compared UTC dates, accepted the scan.
const eveningAdd = "2026-09-02T01:00:00.000Z";
const evening = ["test-evening", "2026-09-02T01:30:00.000Z", "2026-09-02T03:30:00.000Z"] as const;
const result = (corrected: number, leftAlone = 0, wouldWorsen = 0, noEffect = 0, status = "complete") => ({ status, more: status === "progress", corrected, leftAlone, wouldWorsen, noEffect });

test("only automatic UTC dates change; typed, edited and derived dates stay, and the change is recorded once", async (context) => {
  const members: Member[] = [
    { id: "test-auto", added: eveningAdd, stored: "2026-09-02" },
    { id: "test-auto-sqlite", added: "2026-09-02 01:10:00", stored: "2026-09-02" },
    { id: "test-auto-same-day", added: "2026-09-01T19:00:00.000Z", stored: "2026-09-01" },
    { id: "test-derived", added: eveningAdd, stored: null },
    { id: "test-typed", added: eveningAdd, stored: "2026-09-08" },
    { id: "test-typed-local", added: eveningAdd, stored: "2026-09-01" },
    { id: "test-set-by-admin", added: eveningAdd, stored: "2026-09-02" },
    { id: "test-date-edited-before", added: eveningAdd, stored: "2026-09-02" },
    { id: "test-renamed-before", added: eveningAdd, stored: "2026-09-02" },
    { id: "test-deactivated-before", added: eveningAdd, stored: "2026-09-02" },
    { id: "test-renamed", added: eveningAdd, stored: "2026-09-02" },
    { id: "test-bare-date", added: "2026-09-02", stored: "2026-09-02" },
  ];
  const { database, starts, audits, state, revision, audit, meeting, scan } = installation(context, pacific, members);
  meeting(...evening); for (const member of members) scan(member.id, "test-evening");
  // The member settings route records a start date only when an Admin changes it (attendance-member-settings.ts):
  // metadata { attendanceRequiredFrom: next }. This Admin moved the date away and back.
  audit("attendance.member_setting_updated", "test-set-by-admin", { attendanceRequiredFrom: "2026-09-02" });
  // Until 2026-09-28 the member edit route recorded the date it stored on every edit, with no previous value
  // (04c9bcbe^ apps/api/src/index.ts:572): metadata { active: Boolean(next.active), attendanceRequiredFrom }.
  // An entry with another date shows an Admin changed it, here to the 5th and later back.
  audit("roster.member_updated", "test-date-edited-before", { active: true, attendanceRequiredFrom: "2026-09-05" }, "first");
  audit("roster.member_updated", "test-date-edited-before", { active: true, attendanceRequiredFrom: "2026-09-02" }, "second");
  // A rename or a deactivation carried the automatic date along unchanged: nobody chose it.
  audit("roster.member_updated", "test-renamed-before", { active: true, attendanceRequiredFrom: "2026-09-02" });
  audit("roster.member_updated", "test-deactivated-before", { active: false, attendanceRequiredFrom: "2026-09-02" });
  // A rename today records no start date at all.
  audit("roster.member_updated", "test-renamed", { active: true });
  const before = starts(); const revisionBefore = revision(); const { db, used } = counted(database);

  assert.deepEqual(await correctParticipationStarts(db, { now: () => "2026-11-20T20:00:00.000Z" }), result(5, 2));
  assert.equal(used(), 4, "state and time zone, candidates, their attendance, one write batch");
  const corrected = ["test-auto", "test-auto-sqlite", "test-deactivated-before", "test-renamed", "test-renamed-before"];
  assert.deepEqual(starts(), { ...before, ...Object.fromEntries(corrected.map((id) => [id, "2026-09-01"])) });
  assert.ok(revision() > revisionBefore, "the report data revision moved, as it does for a manual edit");
  const entries = audits();
  assert.equal(entries.length, 1, "one audit entry");
  assert.deepEqual({ actor: entries[0]!.actor, targetType: entries[0]!.targetType, targetId: entries[0]!.targetId }, { actor: null, targetType: "installation", targetId: "primary" });
  assert.deepEqual(entries[0]!.metadata, {
    timeZone: pacific, corrected: 5, complete: true, wouldWorsen: 0, noEffect: 0,
    changes: corrected.map((id) => ({ id, memberId: id.toUpperCase(), from: "2026-09-02", to: "2026-09-01", gained: ["test-evening"], dropped: [] })),
    leftAlone: [
      { id: "test-date-edited-before", memberId: "TEST-DATE-EDITED-BEFORE", from: "2026-09-02", to: "2026-09-01" },
      { id: "test-set-by-admin", memberId: "TEST-SET-BY-ADMIN", from: "2026-09-02", to: "2026-09-01" },
    ],
  });
  assert.deepEqual({ ...state(), cursor: undefined, runId: undefined }, { runId: undefined, cursor: undefined, examined: 9, completedAt: "2026-11-20T20:00:00.000Z", auditId: entries[0]!.id });

  // Complete: every later pass is the one state read and changes nothing.
  const after = starts(); const revisionAfter = revision(); const again = counted(database);
  assert.deepEqual(await correctParticipationStarts(again.db), result(5, 2));
  assert.equal(again.used(), 1);
  assert.deepEqual([starts(), revision(), audits().length], [after, revisionAfter, 1]);

  // The audit entry is enough to put every date back.
  const reverse = database.sqlite.prepare("UPDATE members SET attendance_required_from = ? WHERE installation_id = 'primary' AND id = ? AND attendance_required_from = ?");
  for (const change of entries[0]!.metadata.changes) reverse.run(change.from, change.id, change.to);
  assert.deepEqual(starts(), before);
});

test("a member whose scan was refused at the time is left alone: the meeting would count as a miss", async (context) => {
  // Monday 14 September, Pacific: the meeting runs 3:30 to 5 pm and the member is added at 5:10 pm, which is Tuesday in
  // UTC. The stored start is Tuesday. Correcting it to Monday would make Monday's meeting count, with no scan.
  const { database, starts, audits, state, meeting } = installation(context, pacific, [{ id: "test-a", added: "2026-09-15T00:10:00.000Z", stored: "2026-09-15" }]);
  meeting("test-monday", "2026-09-14T22:30:00.000Z", "2026-09-15T00:00:00.000Z");
  assert.deepEqual(await correctParticipationStarts(database), result(0, 0, 1));
  assert.deepEqual([starts(), audits().length, Boolean(state()?.completedAt)], [{ "test-a": "2026-09-15" }, 0, true]);
});

test("a member who was present at the meeting they would gain is corrected", async (context) => {
  const { database, starts, audits, meeting, scan, correction } = installation(context, pacific, [{ id: "test-scanned", added: eveningAdd, stored: "2026-09-02" }, { id: "test-marked-present", added: eveningAdd, stored: "2026-09-02" },
    { id: "test-excused", added: eveningAdd, stored: "2026-09-02" }, { id: "test-one-of-two", added: eveningAdd, stored: "2026-09-02" }]);
  meeting(...evening); meeting("test-afternoon", "2026-09-01T22:00:00.000Z", "2026-09-01T23:00:00.000Z");
  for (const id of ["test-scanned", "test-marked-present", "test-excused"]) correction(id, "test-afternoon", "present");
  scan("test-scanned", "test-evening"); correction("test-marked-present", "test-evening", "present");
  // An excused absence is not a presence, and with one of two meetings missed the day would add a miss.
  correction("test-excused", "test-evening", "excused"); scan("test-one-of-two", "test-evening");
  assert.deepEqual(await correctParticipationStarts(database), result(2, 0, 2));
  assert.deepEqual(starts(), { "test-scanned": "2026-09-01", "test-marked-present": "2026-09-01", "test-excused": "2026-09-02", "test-one-of-two": "2026-09-02" });
  assert.deepEqual(audits()[0]!.metadata.changes.map((change: { id: string; gained: string[]; dropped: string[] }) => [change.id, change.gained, change.dropped]),
    [["test-marked-present", ["test-afternoon", "test-evening"], []], ["test-scanned", ["test-afternoon", "test-evening"], []]]);
  assert.equal(audits()[0]!.metadata.wouldWorsen, 2);
});

test("east of UTC a member is corrected only when the day that stops counting holds no presence", async (context) => {
  // Auckland is UTC+12 on 2 September: a member added at 8 am that day has the 1st stored. Moving the start to the
  // 2nd drops the meeting of the evening of the 1st, which counted as a miss unless someone marked them present.
  const added = "2026-09-01T20:00:00.000Z";
  const { database, starts, audits, meeting, correction } = installation(context, "Pacific/Auckland", [{ id: "test-missed", added, stored: "2026-09-01" }, { id: "test-present", added, stored: "2026-09-01" }]);
  meeting("test-first", "2026-09-01T06:00:00.000Z", "2026-09-01T08:00:00.000Z"); meeting("test-second", "2026-09-02T06:00:00.000Z", "2026-09-02T08:00:00.000Z");
  correction("test-present", "test-first", "present");
  assert.deepEqual(await correctParticipationStarts(database), result(1, 0, 1));
  assert.deepEqual(starts(), { "test-missed": "2026-09-02", "test-present": "2026-09-01" });
  assert.deepEqual(audits()[0]!.metadata.changes, [{ id: "test-missed", memberId: "TEST-MISSED", from: "2026-09-01", to: "2026-09-02", gained: [], dropped: ["test-first"] }]);
});

test("optional meetings and meetings for other labels neither block a correction nor justify one", async (context) => {
  const members = ["test-nothing-counts", "test-attended-required", "test-no-meeting"].map((id) => ({ id, added: id === "test-no-meeting" ? "2026-10-07T01:00:00.000Z" : eveningAdd, stored: id === "test-no-meeting" ? "2026-10-07" : "2026-09-02" }));
  const { database, starts, audits, meeting, scan } = installation(context, pacific, members);
  // On the gained day: an optional meeting and one for a label neither member holds, both unattended.
  meeting("test-optional", "2026-09-01T20:00:00.000Z", "2026-09-01T21:00:00.000Z", { required: false });
  meeting("test-other-label", "2026-09-01T22:00:00.000Z", "2026-09-01T23:00:00.000Z", { audience: ["test-label-drive"] });
  assert.deepEqual(await correctParticipationStarts(database), result(0, 0, 0, 3));
  assert.deepEqual(starts()["test-nothing-counts"], "2026-09-02", "no meeting starts counting, so the date the Admin saw stays");
  // With a required meeting they attended the same evening, the correction is made, and only that meeting is gained.
  database.sqlite.exec("DELETE FROM participation_start_correction");
  meeting(...evening); scan("test-attended-required", "test-evening"); scan("test-nothing-counts", "test-optional");
  assert.deepEqual(await correctParticipationStarts(database), result(1, 0, 1, 1));
  assert.deepEqual(starts(), { "test-attended-required": "2026-09-01", "test-no-meeting": "2026-10-07", "test-nothing-counts": "2026-09-02" });
  assert.deepEqual(audits().map((entry) => [entry.metadata.changes.map((change: { gained: string[] }) => change.gained), entry.metadata.wouldWorsen, entry.metadata.noEffect]), [[[["test-evening"]], 1, 1]]);
});

test("running the job again over corrected members changes nothing and writes no second entry", async (context) => {
  const { database, starts, audits, state, audit, meeting, scan } = installation(context, pacific, [{ id: "test-a", added: eveningAdd, stored: "2026-09-02" }, { id: "test-b", added: eveningAdd, stored: "2026-09-02" }]);
  meeting(...evening); scan("test-a", "test-evening"); scan("test-b", "test-evening");
  audit("attendance.member_setting_updated", "test-b", { attendanceRequiredFrom: "2026-09-02" });
  assert.deepEqual(await correctParticipationStarts(database), result(1, 1));
  assert.equal(audits().length, 1);
  // As after a restore of a backup made since: the job starts again, and Test Student A is already corrected.
  database.sqlite.exec("DELETE FROM participation_start_correction");
  assert.deepEqual(await correctParticipationStarts(database), result(0, 1));
  assert.deepEqual([starts(), audits().length, state()?.auditId, Boolean(state()?.completedAt)], [{ "test-a": "2026-09-01", "test-b": "2026-09-02" }, 1, null, true]);
});

test("nothing happens without a time zone, and UTC completes without examining anyone", async (context) => {
  const members = [{ id: "test-a", added: eveningAdd, stored: "2026-09-02" }];
  const unset = installation(context, null, members); unset.meeting(...evening); unset.scan("test-a", "test-evening");
  assert.deepEqual(await correctParticipationStarts(unset.database), result(0, 0, 0, 0, "waiting"));
  assert.equal(unset.state(), undefined, "no marker: the job looks again once the organization exists");
  assert.deepEqual(unset.starts(), { "test-a": "2026-09-02" });
  // The organization is created with its time zone, and the next pass corrects.
  unset.database.sqlite.exec(`INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','${pacific}')`);
  assert.equal((await correctParticipationStarts(unset.database)).corrected, 1);

  const utc = installation(context, "UTC", members); const reads = utc.database.reads;
  assert.deepEqual(await correctParticipationStarts(utc.database), result(0));
  assert.equal(utc.database.reads - reads, 1, "the state is read and members are not");
  assert.deepEqual([utc.starts(), utc.audits().length, Boolean(utc.state()?.completedAt)], [{ "test-a": "2026-09-02" }, 0, true]);

  // A zone the runtime does not know decides nothing either.
  const unknown = installation(context, "Test/Nowhere", members);
  assert.equal((await correctParticipationStarts(unknown.database)).status, "waiting");
  assert.deepEqual(unknown.starts(), { "test-a": "2026-09-02" });
});

test("a pass examines a bounded batch within its subrequests, and later passes add to the same audit entry", async (context) => {
  const members = Array.from({ length: 7 }, (_, index) => ({ id: `test-${index + 1}`, added: eveningAdd, stored: index === 3 ? "2026-09-15" : "2026-09-02" }));
  const { database, starts, audits, state, meeting, scan } = installation(context, pacific, members);
  meeting(...evening); for (const member of members) scan(member.id, "test-evening");
  const passes: { status: string; corrected: number; used: number }[] = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const { db, used } = counted(database);
    const outcome = await correctParticipationStarts(db, { limit: 2 });
    passes.push({ status: outcome.status, corrected: outcome.corrected, used: used() });
    assert.equal(audits().length, 1, "one entry however many passes");
    assert.equal(audits()[0]!.metadata.changes.length, outcome.corrected, "every changed row is in the entry as soon as it is changed");
    if (!outcome.more) break;
  }
  // Six members match the rule: three full batches of two, then an empty one that completes the job.
  assert.deepEqual(passes, [{ status: "progress", corrected: 2, used: 4 }, { status: "progress", corrected: 4, used: 4 }, { status: "progress", corrected: 6, used: 4 }, { status: "complete", corrected: 6, used: 3 }]);
  assert.ok(passes.every((pass) => pass.used <= 1 + START_CORRECTION_WORK_QUERIES));
  assert.deepEqual(Object.values(starts()).filter((value) => value === "2026-09-01").length, 6);
  assert.equal(starts()["test-4"], "2026-09-15");
  assert.deepEqual([audits()[0]!.metadata.corrected, audits()[0]!.metadata.complete, state()?.examined], [6, true, 6]);
  assert.equal(START_CORRECTION_BATCH, 20);
});

test("a full batch reads every candidate's attendance in one batch", async (context) => {
  // Twenty members added on four different evenings, each with that evening's meeting attended.
  const days = ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23"];
  const members = Array.from({ length: START_CORRECTION_BATCH }, (_, index) => ({ id: `test-${String(index + 1).padStart(2, "0")}`, added: `${days[index % 4]}T01:00:00.000Z`, stored: days[index % 4]! }));
  const { database, starts, meeting, scan } = installation(context, pacific, members);
  days.forEach((day, index) => meeting(`test-evening-${index}`, `${day}T01:30:00.000Z`, `${day}T03:30:00.000Z`));
  members.forEach((member, index) => scan(member.id, `test-evening-${index % 4}`));
  const first = counted(database);
  assert.deepEqual(await correctParticipationStarts(first.db), result(20, 0, 0, 0, "progress"));
  assert.equal(first.used(), 4);
  assert.ok(Object.values(starts()).every((value) => !days.includes(value!)));
  assert.deepEqual(await correctParticipationStarts(database), result(20));
});

test("a pass without room in the scheduler's budget reads its state and waits", async (context) => {
  const { database, starts, state } = installation(context, pacific, [{ id: "test-a", added: eveningAdd, stored: "2026-09-02" }]);
  const asked: number[] = [];
  assert.deepEqual(await correctParticipationStarts(database, { fits: (queries) => { asked.push(queries); return false; } }), result(0, 0, 0, 0, "progress"));
  assert.deepEqual([asked, starts(), state()], [[START_CORRECTION_WORK_QUERIES], { "test-a": "2026-09-02" }, undefined]);
});

test("a start date an Admin changes while a pass runs is not overwritten or recorded as changed", async (context) => {
  const { database, starts, audits, meeting, scan } = installation(context, pacific, [{ id: "test-a", added: eveningAdd, stored: "2026-09-02" }, { id: "test-b", added: eveningAdd, stored: "2026-09-02" }]);
  meeting(...evening); scan("test-a", "test-evening"); scan("test-b", "test-evening");
  // Between the pass's read of its candidates and its write, an Admin sets Test Student B's date.
  beforeWrite(database, () => database.sqlite.exec("UPDATE members SET attendance_required_from = '2026-09-20' WHERE id = 'test-b'"));
  const { db, used } = counted(database);
  assert.deepEqual(await correctParticipationStarts(db), result(1));
  assert.equal(used(), 1 + START_CORRECTION_WORK_QUERIES, "the second write is the pass's fifth and last subrequest");
  assert.deepEqual(starts(), { "test-a": "2026-09-01", "test-b": "2026-09-20" });
  assert.deepEqual(audits().map((entry) => entry.metadata.changes.map((change: { id: string }) => change.id)), [["test-a"]]);
});

test("two runners on the same batch change each row once", async (context) => {
  const { database, starts, audits, meeting, scan } = installation(context, pacific, [{ id: "test-a", added: eveningAdd, stored: "2026-09-02" }]);
  meeting(...evening); scan("test-a", "test-evening");
  // The second runner finishes the whole pass while the first is between its read and its write.
  let inner: unknown; beforeWrite(database, async () => { inner = await correctParticipationStarts(database); });
  const first = await correctParticipationStarts(database);
  assert.deepEqual([first.status, first.more], ["raced", true]); assert.deepEqual(inner, result(1));
  assert.deepEqual(starts(), { "test-a": "2026-09-01" });
  assert.equal(audits().length, 1); assert.equal(audits()[0]!.metadata.corrected, 1);
  assert.equal((await correctParticipationStarts(database)).status, "complete");
});

test("a pass that started before a restore neither changes the restored members nor completes the new run", async (context) => {
  for (const startedBefore of [false, true]) {
    const { database, starts, audits, state, meeting, scan } = installation(context, pacific, [{ id: "test-a", added: eveningAdd, stored: "2026-09-02" }, { id: "test-b", added: eveningAdd, stored: "2026-09-02" }]);
    meeting(...evening); scan("test-a", "test-evening");
    // With `startedBefore` the job already has a run and is part-way; without, this is its very first pass.
    if (startedBefore) assert.deepEqual(await correctParticipationStarts(database, { limit: 1 }), result(1, 0, 0, 0, "progress"));
    const before = starts();
    // The pass has read its state and candidates. A restore then replaces the members and starts a new run, in one batch.
    let restoredRun: string | undefined;
    beforeWrite(database, async () => {
      await database.batch([database.prepare("UPDATE members SET attendance_required_from = '2026-09-02' WHERE installation_id = 'primary'"), startCorrectionReset(database)]);
      restoredRun = state()!.runId; scan("test-b", "test-evening");
    });
    const raced = await correctParticipationStarts(database, { limit: 1 });
    assert.deepEqual([raced.status, raced.more], ["raced", true], `started before: ${startedBefore}`);
    assert.ok(restoredRun);
    assert.deepEqual({ ...state(), auditId: undefined }, { runId: restoredRun, cursor: "", examined: 0, completedAt: null, auditId: undefined }, "the restore's run is untouched and not complete");
    assert.deepEqual(starts(), { "test-a": "2026-09-02", "test-b": "2026-09-02" }, "nothing the old pass decided was written");
    assert.equal(audits().length, startedBefore ? 1 : 0); assert.ok(before);
    // The new run then examines every restored member.
    assert.deepEqual(await correctParticipationStarts(database), result(2));
    assert.deepEqual(starts(), { "test-a": "2026-09-01", "test-b": "2026-09-01" });
  }
});

// The scheduler: housekeeping's prune step runs the job, and extra slices only while members are left.
const jobIds = [...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs].map((job) => job.id);
function scheduled(context: { after(fn: () => void): void }, members: number) {
  const db = new TestD1Database({ seed: new InstallationSeed("2026-09-01T00:00:00Z").users("admin").organization(pacific).modules(...attendanceWithOutreachDisabled(true)) }); context.after(() => db.close());
  db.sqlite.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${members}) INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) SELECT printf('test-member-%04d',x),'primary',printf('T%04d',x),'Test Student',x,'${eveningAdd}','2026-09-02' FROM n;
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at,audience_mode) VALUES ('test-evening','primary','Test Meeting','${evening[1]}','${evening[2]}',1,'admin','2026-08-01T00:00:00.000Z','all');
    INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) SELECT 'in-' || id,'primary',id,'test-evening','kiosk','2026-09-02T01:35:00.000Z','check_in' FROM members;
    INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) SELECT 'out-' || id,'primary',id,'test-evening','kiosk','${evening[2]}','check_out' FROM members;`);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: db } as unknown as Env;
  const quiet = (due?: string) => {
    const now = Date.now(); const jobs = Object.fromEntries(jobIds.map((id) => [id, { next: id === due ? 0 : now + 3_600_000, last: now - 60_000, outcome: "ok" }]));
    db.sqlite.prepare("INSERT INTO platform_scheduler_state(installation_id,jobs_json,updated_at) VALUES ('primary',?,?) ON CONFLICT(installation_id) DO UPDATE SET jobs_json = excluded.jobs_json").run(JSON.stringify(jobs), new Date(now).toISOString());
  };
  const left = () => Number((db.sqlite.prepare("SELECT COUNT(*) AS n FROM members WHERE attendance_required_from = '2026-09-02'").get() as { n: number }).n);
  const complete = () => Boolean((db.sqlite.prepare("SELECT completed_at AS at FROM participation_start_correction").get() as { at: string | null } | undefined)?.at);
  /** One five-minute round of housekeeping on the Durable Object: its first slice, then each step it asks for. */
  const round = async () => {
    quiet(); const slices: number[] = []; let now = Date.now(); let pokes: Record<string, number> = { "core.housekeeping": now };
    for (let step = 0; step < 12; step += 1) {
      const report = await runSchedulerSlice(env, pokes, now, { started: async () => {} });
      slices.push(report.d1Queries); if (!report.more) break; pokes = {}; now = report.nextWake;
    }
    return slices;
  };
  return { db, env, quiet, left, complete, round };
}

test("on the Durable Object the job takes slices of its own only while members are left, each within a slice's budget", async (context) => {
  const { left, complete, round } = scheduled(context, 45);
  const first = await round();
  // Reconcile; prune with the first twenty; twenty more; the last five and then cleanup.
  assert.equal(first.length, 4, JSON.stringify(first));
  assert.ok(first.every((queries) => queries <= scheduledSliceLimits.total && 1.5 + 0.45 * queries <= 7), `each slice stays within an estimated 7 ms: ${JSON.stringify(first)}`);
  assert.deepEqual([left(), complete()], [0, true]);
  // Once complete, a round is the three slices it was: the state comes back in the clean-up batch.
  const steady = await round();
  assert.equal(steady.length, 3, JSON.stringify(steady));
  assert.ok(steady.every((queries) => 1.5 + 0.45 * queries <= 7), JSON.stringify(steady));
});

test("the cron fallback corrects one batch a pass", async (context) => {
  const { env, quiet, left, complete } = scheduled(context, 30);
  const tick = async () => { quiet("core.housekeeping"); await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as never, env); };
  await tick(); assert.deepEqual([left(), complete()], [10, false]);
  await tick(); assert.deepEqual([left(), complete()], [0, true]);
  await tick(); assert.deepEqual([left(), complete()], [0, true]);
});

test("a restore starts the job again, so an older backup is corrected again and a newer one is left as it is", async (context) => {
  const db = new BackupDatabase(); context.after(() => db.raw.close());
  db.raw.exec(`UPDATE organization_settings SET time_zone = '${pacific}';
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) VALUES
      ('test-a','primary','TEST-A','Test Student','A','${eveningAdd}','2026-09-02'), ('test-b','primary','TEST-B','Test Student','B','${eveningAdd}','2026-09-10');
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at,audience_mode) VALUES ('test-evening','primary','Test Meeting','${evening[1]}','${evening[2]}',1,'admin','2026-08-01T00:00:00.000Z','all');
    INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) VALUES ('in-a','primary','test-a','test-evening','kiosk','2026-09-02T01:35:00.000Z','check_in'), ('out-a','primary','test-a','test-evening','kiosk','${evening[2]}','check_out');`);
  const client = backupClient(worker, db); const d1 = db as unknown as D1Database;
  const startOf = (id: string) => db.rows<{ s: string }>("SELECT attendance_required_from AS s FROM members WHERE id = ?", id)[0]?.s;
  /** The job's runs and how many of them are complete. */
  const markers = () => [db.count("SELECT COUNT(*) AS n FROM participation_start_correction"), db.count("SELECT COUNT(*) AS n FROM participation_start_correction WHERE completed_at IS NOT NULL")];
  const runId = () => db.rows<{ id: string }>("SELECT run_id AS id FROM participation_start_correction")[0]?.id;
  const entries = () => db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?", START_CORRECTION_ACTION);

  const older = await client.backup("installation"); const olderRoster = await client.backup("roster");
  assert.equal(Object.hasOwn(older.tables, "participation_start_correction"), false, "the marker is never in a backup");
  assert.equal((await correctParticipationStarts(d1)).corrected, 1);
  assert.deepEqual([startOf("test-a"), startOf("test-b"), markers(), entries()], ["2026-09-01", "2026-09-10", [1, 1], 1]);
  const firstRun = runId();
  const newer = await client.backup("installation");
  assert.equal(newer.tables.audit_log.filter((row: { action: string }) => row.action === START_CORRECTION_ACTION).length, 1, "the record of the correction travels with the installation");

  // An older backup brings the UTC date back. The restore starts a new run, and the next pass corrects the date again.
  let restored = await client.restore(older); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual([startOf("test-a"), markers(), entries()], ["2026-09-02", [1, 0], 0]); assert.notEqual(runId(), firstRun);
  assert.deepEqual(await correctParticipationStarts(d1), result(1));
  assert.deepEqual([startOf("test-a"), startOf("test-b"), markers(), entries()], ["2026-09-01", "2026-09-10", [1, 1], 1]);

  // A backup made after the correction restores corrected dates. The job runs again, finds nothing and records nothing.
  restored = await client.restore(newer); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual([startOf("test-a"), markers(), entries()], ["2026-09-01", [1, 0], 1]);
  assert.deepEqual(await correctParticipationStarts(d1), result(0));
  assert.deepEqual([startOf("test-a"), startOf("test-b"), markers(), entries()], ["2026-09-01", "2026-09-10", [1, 1], 1]);

  // A roster restore replaces members only and starts a new run too; the earlier record stays in the audit log.
  restored = await client.call("/admin/data/restore", { scope: "roster", confirmation: "RESTORE ROSTER", backup: olderRoster }); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual([startOf("test-a"), markers(), entries()], ["2026-09-02", [1, 0], 1]);
  assert.equal((await correctParticipationStarts(d1)).corrected, 1);
  assert.deepEqual([startOf("test-a"), startOf("test-b"), markers(), entries()], ["2026-09-01", "2026-09-10", [1, 1], 2]);

  // A meetings restore leaves members, and so the completed run, alone.
  const completedRun = runId(); const meetings = await client.backup("meetings");
  restored = await client.call("/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup: meetings }); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual([runId(), markers()], [completedRun, [1, 1]]);
});

test("on the reference team no corrected member loses a presence or gains a miss, and nobody else changes", () => {
  for (const zone of ["America/New_York", "Pacific/Auckland"]) {
    const data = { ...referenceTeam(), timeZone: zone };
    const day = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00.000Z") + days * 86_400_000).toISOString().slice(0, 10);
    const dateOf = new Map(data.meetings.map((meeting) => [meeting.id, localDate(meeting.startsAt, zone)]));
    // Twenty members whose stored date is the UTC date of an add on the other side of local midnight from it, on the day
    // of a past meeting everyone was due at: half present at every meeting of the day in question, half at none of them.
    const past = data.meetings.filter((meeting) => meeting.required && meeting.audienceMode === "all" && Date.parse(meeting.endsAt) < Date.parse(referenceNow) - 30 * 86_400_000);
    const west = zone === "America/New_York"; const prepared = new Map<string, { gap: string; present: boolean }>();
    const members = data.members.map((member, index) => {
      if (index >= 20) return member;
      const gap = dateOf.get(past[index * 5]!.id)!; prepared.set(member.id, { gap, present: index % 2 === 0 });
      // West: added at 9:30 or 10:30 pm on the meeting's day, stored as the next day. East: added in the morning after it, stored as the meeting's day.
      return west ? { ...member, rosterAddedAt: day(gap, 1) + "T02:30:00.000Z", attendanceRequiredFrom: day(gap, 1) } : { ...member, rosterAddedAt: gap + "T20:30:00.000Z", attendanceRequiredFrom: gap };
    });
    const observations = [...data.observations.filter((item) => prepared.get(item.memberId)?.gap !== dateOf.get(item.meetingId)),
      ...[...prepared].flatMap(([memberId, { gap, present }]) => present ? data.meetings.filter((meeting) => dateOf.get(meeting.id) === gap).map((meeting) => ({ meetingId: meeting.id, memberId, disposition: "present" as const, checkedInAt: meeting.startsAt, checkedOutAt: meeting.endsAt, reason: undefined })) : [])];
    const team = { ...data, members, observations, now: referenceNow };

    const decisions = new Map(members.flatMap((member) => { const to = correctedParticipationStart(member, zone); return to ? [[member.id, { to, effect: startCorrectionEffect(member, to, team) }] as const] : []; }));
    const corrected = members.map((member) => decisions.get(member.id)?.effect.correct ? { ...member, attendanceRequiredFrom: decisions.get(member.id)!.to } : member);
    const before = evaluateAttendance(team); const after = evaluateAttendance({ ...team, members: corrected });
    const record = (item: (typeof before)[number]) => { const rows = item.rows.filter((row) => row.rateEligible || row.regularEligible); return { present: rows.filter((row) => row.attended).length, missed: rows.filter((row) => !row.attended).length, below: item.belowTargetWeeks.length, counted: new Set(rows.map((row) => row.meetingId)) }; };
    let correctedCount = 0, worsened = 0;
    before.forEach((item, index) => {
      const next = after[index]!; const decision = decisions.get(item.member.id); const name = `${zone} ${item.member.memberId}`;
      if (!decision?.effect.correct) { assert.equal(JSON.stringify(next), JSON.stringify(item), `${name} was not corrected, so nothing about them changes`); if (decision?.effect.reason === "would_worsen") worsened += 1; return; }
      correctedCount += 1;
      const was = record(item), now = record(next);
      assert.ok(now.present >= was.present, `${name} loses no presence: ${was.present} to ${now.present}`);
      assert.ok(now.missed <= was.missed, `${name} gains no miss: ${was.missed} to ${now.missed}`);
      assert.ok(now.below <= was.below, `${name} gains no week below target`);
      // What the audit entry lists is what really changed over the whole season, and only on the day between the two dates.
      assert.deepEqual([...now.counted].filter((id) => !was.counted.has(id)).sort(), decision.effect.gained, name);
      assert.deepEqual([...was.counted].filter((id) => !now.counted.has(id)).sort(), decision.effect.dropped, name);
      const gap = decision.to < item.member.attendanceRequiredFrom! ? decision.to : item.member.attendanceRequiredFrom!;
      for (const id of [...decision.effect.gained, ...decision.effect.dropped]) assert.equal(dateOf.get(id), gap, name);
      assert.ok(decision.effect.gained.length + decision.effect.dropped.length > 0);
      assert.equal(west ? decision.effect.dropped.length : decision.effect.gained.length, 0, name);
    });
    // West, the members present that evening are corrected and the others would gain a miss. East it is the reverse:
    // a member with nothing on the dropped day sheds its misses, and one who was present would lose presences.
    for (const [id, { present }] of prepared) assert.equal(decisions.get(id)?.effect.reason, present === west ? "improves" : "would_worsen", `${zone} ${id}`);
    assert.ok(correctedCount >= 10 && worsened >= 10, `${zone}: ${correctedCount} corrected, ${worsened} left alone`);
  }
});

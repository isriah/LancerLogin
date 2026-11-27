// Read-only day projections for module jobs: meetings on an organization-local date, who checked in, who was expected, and
// the active roster with that day's labels. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { expectedMembersForDay, meetingsOnLocalDate, presentMembersForDay } from "../apps/api/src/attendance-day-projection.ts";
import { listActiveRosterWithLabels } from "../apps/api/src/core-roster-projection.ts";
import { captureModuleServiceDatabase, isModuleAuthorityDenied } from "../apps/api/src/module-database-scope.ts";
import { HttpError } from "../apps/api/src/http-error.ts";
import type { D1Statement } from "../apps/api/src/d1-usage.ts";
import { InstallationSeed, TestD1Database } from "./fixtures/d1-database.ts";

const installationId = "primary";
const meetingRow = (id: string, startsAt: string, endsAt: string, extra: { required?: 0 | 1; isTest?: 0 | 1; deletedAt?: string; audienceMode?: "all" | "labels"; title?: string } = {}) =>
  `('${id}','primary','${extra.title ?? `Test meeting ${id}`}','${startsAt}','${endsAt}',${extra.required ?? 1},${extra.isTest ?? 0},${extra.deletedAt ? `'${extra.deletedAt}'` : "NULL"},'${extra.audienceMode ?? "all"}','admin','2026-01-01T00:00:00.000Z')`;

class Database extends TestD1Database {
  batches = 0;
  constructor(timeZone = "America/New_York") {
    super({ seed: new InstallationSeed("2026-01-01T00:00:00.000Z").users("admin").organization(timeZone)
      .members(
        { id: "member-a", externalId: "TSA", firstName: "Test Student", lastName: "A", attendanceRequiredFrom: "2026-01-01" },
        { id: "member-b", externalId: "TSB", firstName: "Test Student", lastName: "B", attendanceRequiredFrom: "2026-01-01" },
        { id: "member-c", externalId: "TSC", firstName: "Test Student", lastName: "C", attendanceRequiredFrom: "2026-11-02" },
        { id: "member-d", externalId: "TSD", firstName: "Test Student", lastName: "D", attendanceRequiredFrom: "2026-01-01" },
        { id: "member-e", externalId: "TSE", firstName: "Test Student", lastName: "E", attendanceRequiredFrom: "2026-01-01" },
      )
      .modules({ id: "attendance", phase: "enabled", setupVersion: 2, setupComplete: true }, { id: "carpool", phase: "enabled", setupVersion: 1, setupComplete: true })
      .add(`UPDATE members SET email=lower(external_id)||'@example.test', discord_user_id=CASE id WHEN 'member-a' THEN '100000000000000001' END;
        UPDATE members SET inactive_periods_json='[["2026-10-31T00:00:00.000Z","2026-11-02T12:00:00.000Z"]]' WHERE id='member-b';
        UPDATE members SET active=0, inactive_periods_json='[["2026-10-01T00:00:00.000Z",null]]' WHERE id='member-e';
        INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('label-build','primary','Test Build','2026-01-01T00:00:00.000Z'),('label-code','primary','Test Code','2026-01-01T00:00:00.000Z');
        INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_at) VALUES
          ('change-1','primary','member-a','label-build','add','2026-01-01','2026-01-01T00:00:00.000Z'),
          ('change-2','primary','member-d','label-build','add','2026-01-01','2026-01-01T00:00:00.000Z'),
          ('change-3','primary','member-d','label-build','remove','2026-10-15','2026-10-15T00:00:00.000Z'),
          ('change-4','primary','member-d','label-code','add','2026-11-02','2026-10-20T00:00:00.000Z'),
          ('change-5','primary','member-a','label-code','add','2026-10-01','2026-10-01T00:00:00.000Z'),
          ('change-6','primary','member-e','label-build','add','2026-01-01','2026-01-01T00:00:00.000Z');
        INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,is_test,deleted_at,audience_mode,created_by,created_at) VALUES
          ${meetingRow("spring-before", "2026-03-08T04:30:00.000Z", "2026-03-08T05:30:00.000Z")},
          ${meetingRow("spring-first", "2026-03-08T05:00:00.000Z", "2026-03-08T06:00:00.000Z")},
          ${meetingRow("spring-last", "2026-03-09T03:59:00.000Z", "2026-03-09T04:30:00.000Z")},
          ${meetingRow("spring-after", "2026-03-09T04:00:00.000Z", "2026-03-09T05:00:00.000Z")},
          ${meetingRow("fall-before", "2026-11-01T03:59:00.000Z", "2026-11-01T05:00:00.000Z")},
          ${meetingRow("fall-build", "2026-11-01T14:00:00.000Z", "2026-11-01T17:00:00.000Z", { audienceMode: "labels", title: "Test build session" })},
          ${meetingRow("fall-optional", "2026-11-01T18:00:00.000Z", "2026-11-01T19:00:00.000Z", { required: 0 })},
          ${meetingRow("fall-late", "2026-11-02T04:30:00.000Z", "2026-11-02T05:00:00.000Z")},
          ${meetingRow("fall-deleted", "2026-11-01T15:00:00.000Z", "2026-11-01T16:00:00.000Z", { deletedAt: "2026-10-31T00:00:00.000Z" })},
          ${meetingRow("fall-test", "2026-11-01T15:00:00.000Z", "2026-11-01T16:00:00.000Z", { isTest: 1 })},
          ${meetingRow("utc-midnight", "2026-04-15T00:30:00.000Z", "2026-04-15T01:30:00.000Z")},
          ${meetingRow("code-day", "2026-11-02T22:00:00.000Z", "2026-11-02T23:00:00.000Z", { audienceMode: "labels" })};
        INSERT INTO meeting_audience_labels(installation_id,meeting_id,label_id) VALUES ('primary','fall-build','label-build'),('primary','code-day','label-code');
        INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) VALUES
          ('event-1','primary','member-a','fall-build','kiosk','2026-11-01T14:05:00.000Z','check_in'),
          ('event-2','primary','member-a','fall-build','kiosk','2026-11-01T14:20:00.000Z','check_in'),
          ('event-3','primary','member-a','fall-build','kiosk','2026-11-01T16:55:00.000Z','check_out'),
          ('event-4','primary','member-b','fall-optional','manual','2026-11-01T18:02:00.000Z','check_in'),
          ('event-5','primary','member-d','fall-deleted','kiosk','2026-11-01T15:01:00.000Z','check_in'),
          ('event-6','primary','member-d','fall-test','kiosk','2026-11-01T15:01:00.000Z','check_in'),
          ('event-7','primary','member-d','spring-after','kiosk','2026-03-09T04:01:00.000Z','check_in'),
          ('event-8','primary','member-d','fall-optional','kiosk','2026-11-01T17:59:00.000Z','check_out'),
          ('event-9','primary','member-d','fall-optional','kiosk','2026-11-01T18:03:00.000Z','check_in');
        INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) VALUES
          ('correction-1','primary','member-c','fall-build','present','','admin','2026-11-01T20:00:00.000Z'),
          ('correction-2','primary','member-a','fall-build','absent','Test correction','admin','2026-11-01T20:00:00.000Z');`) });
  }
  override async batch(statements: D1Statement[]) { this.batches += 1; return super.batch(statements); }
}

/** A calling module's job database, as Core's scheduler captures it. */
const callerDb = (db: Database) => captureModuleServiceDatabase(db, "carpool", 1);
const ids = (rows: { id: string }[] | undefined) => rows?.map((row) => row.id);

test("meetings on a local date follow the installation time zone across both DST changes and near UTC midnight", async () => {
  const db = new Database(); try {
    assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(db), installationId, "2026-03-08")), ["spring-first", "spring-last"]);
    assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(db), installationId, "2026-03-07")), ["spring-before"]);
    assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(db), installationId, "2026-03-09")), ["spring-after"]);
    // The 25-hour day keeps its last local hour, and deleted and test meetings never appear.
    const fall = await meetingsOnLocalDate(callerDb(db), installationId, "2026-11-01");
    assert.deepEqual(ids(fall), ["fall-build", "fall-optional", "fall-late"]);
    assert.deepEqual(fall?.[0], { id: "fall-build", title: "Test build session", startsAt: "2026-11-01T14:00:00.000Z", endsAt: "2026-11-01T17:00:00.000Z", required: true, audienceMode: "labels", audienceLabelIds: ["label-build"] });
    assert.equal(fall?.[1]?.required, false);
    assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(db), installationId, "2026-11-01", { requiredOnly: true })), ["fall-build", "fall-late"]);
    assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(db), installationId, "2026-10-31")), ["fall-before"]);
    // 00:30 UTC on April 15 is the evening of April 14 in New York.
    assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(db), installationId, "2026-04-14")), ["utc-midnight"]);
    assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(db), installationId, "2026-04-15")), []);
    // The same instant is April 15 where the installation keeps UTC.
    const utc = new Database("UTC"); try { assert.deepEqual(ids(await meetingsOnLocalDate(callerDb(utc), installationId, "2026-04-15")), ["utc-midnight"]); } finally { utc.close(); }
    await assert.rejects(meetingsOnLocalDate(callerDb(db), installationId, "2026-02-30"), (error) => error instanceof HttpError && error.status === 400);
  } finally { db.close(); }
});

test("presence counts the first check-in and a later check-out from events only, ignoring corrections", async () => {
  const db = new Database(); try {
    const before = db.batches;
    const present = await presentMembersForDay(callerDb(db), installationId, "2026-11-01");
    // One read of Attendance's state, then every projection read in one batch.
    assert.equal(db.batches - before, 2);
    assert.deepEqual(present, [
      { memberId: "member-a", meetingId: "fall-build", firstCheckInAt: "2026-11-01T14:05:00.000Z", checkedOut: true },
      { memberId: "member-b", meetingId: "fall-optional", firstCheckInAt: "2026-11-01T18:02:00.000Z", checkedOut: false },
      // A check-out before the first check-in does not count.
      { memberId: "member-d", meetingId: "fall-optional", firstCheckInAt: "2026-11-01T18:03:00.000Z", checkedOut: false },
    ]);
    // Member C's "present" correction adds nothing; member A's "absent" correction removes nothing.
    assert.equal(present?.some((row) => row.memberId === "member-c"), false);
    assert.deepEqual((await presentMembersForDay(callerDb(db), installationId, "2026-11-01", { requiredOnly: true }))?.map((row) => row.memberId), ["member-a"]);
    // A check-in to a meeting just after local midnight belongs to the next day.
    assert.deepEqual((await presentMembersForDay(callerDb(db), installationId, "2026-03-08")), []);
    assert.deepEqual((await presentMembersForDay(callerDb(db), installationId, "2026-03-09"))?.map((row) => row.meetingId), ["spring-after"]);
    // Read-only: nothing was written.
    assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM attendance_events").get() as { n: number }).n, 9);
  } finally { db.close(); }
});

test("expected members reuse Core's inactivity, participation start and audience rules", async () => {
  const db = new Database(); try {
    // Nov 1: A is in the Build audience; B was inactive all day; C starts Nov 2; D left Build on Oct 15 but the optional
    // meeting is open to all. E is inactive now and not listed.
    assert.deepEqual(await expectedMembersForDay(callerDb(db), installationId, "2026-11-01"), [
      { memberId: "member-a", expected: true, reason: "expected" },
      { memberId: "member-b", expected: false, reason: "inactive" },
      { memberId: "member-c", expected: false, reason: "before_start" },
      { memberId: "member-d", expected: true, reason: "expected" },
    ]);
    // Required meetings only: the Build session and the late meeting. D is outside the Build audience but the late meeting is for everyone.
    assert.deepEqual((await expectedMembersForDay(callerDb(db), installationId, "2026-11-01", { requiredOnly: true }))?.map(({ memberId, reason }) => [memberId, reason]),
      [["member-a", "expected"], ["member-b", "inactive"], ["member-c", "before_start"], ["member-d", "expected"]]);
    // Nov 2: the Code meeting's audience uses labels effective that day. D's Code label takes effect on Nov 2, A's on Oct 1;
    // B is active again from noon UTC, before the 22:00 UTC meeting; C starts that day.
    assert.deepEqual(await expectedMembersForDay(callerDb(db), installationId, "2026-11-02"), [
      { memberId: "member-a", expected: true, reason: "expected" },
      { memberId: "member-b", expected: false, reason: "outside_audience" },
      { memberId: "member-c", expected: false, reason: "outside_audience" },
      { memberId: "member-d", expected: true, reason: "expected" },
    ]);
    // A day without meetings expects nobody.
    assert.deepEqual(await expectedMembersForDay(callerDb(db), installationId, "2026-06-01"), []);
  } finally { db.close(); }
});

test("the active roster carries the labels in effect on the date, as member-level reports fold them", async () => {
  const db = new Database(); try {
    const before = await listActiveRosterWithLabels(callerDb(db), installationId, "2026-11-01");
    assert.deepEqual(before.map((member) => [member.id, member.labels.map((label) => label.name)]), [["member-a", ["Test Build", "Test Code"]], ["member-b", []], ["member-c", []], ["member-d", []]]);
    assert.deepEqual(before[0], { id: "member-a", externalId: "TSA", firstName: "Test Student", lastName: "A", email: "tsa@example.test", discordUserId: "100000000000000001", labels: [{ id: "label-build", name: "Test Build" }, { id: "label-code", name: "Test Code" }] });
    assert.deepEqual((await listActiveRosterWithLabels(callerDb(db), installationId, "2026-11-02")).find((member) => member.id === "member-d")?.labels, [{ id: "label-code", name: "Test Code" }]);
    assert.deepEqual((await listActiveRosterWithLabels(callerDb(db), installationId, "2026-10-14")).find((member) => member.id === "member-d")?.labels, [{ id: "label-build", name: "Test Build" }]);
    await assert.rejects(listActiveRosterWithLabels(callerDb(db), installationId, "11/01/2026"), (error) => error instanceof HttpError && error.status === 400);
  } finally { db.close(); }
});

test("Attendance projections are undefined while Attendance is disabled or not set up, and stop with the caller's authority", async () => {
  const db = new Database(); try {
    db.sqlite.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='attendance'");
    assert.equal(await meetingsOnLocalDate(callerDb(db), installationId, "2026-11-01"), undefined);
    assert.equal(await presentMembersForDay(callerDb(db), installationId, "2026-11-01"), undefined);
    assert.equal(await expectedMembersForDay(callerDb(db), installationId, "2026-11-01"), undefined);
    // The roster is Core's, not Attendance's.
    assert.equal((await listActiveRosterWithLabels(callerDb(db), installationId, "2026-11-01")).length, 4);
    db.sqlite.exec("UPDATE platform_modules SET phase='enabled', setup_complete=0 WHERE module_id='attendance'");
    assert.equal(await presentMembersForDay(callerDb(db), installationId, "2026-11-01"), undefined);
    db.sqlite.exec("UPDATE platform_modules SET setup_complete=1 WHERE module_id='attendance'");
    assert.equal((await presentMembersForDay(callerDb(db), installationId, "2026-11-01"))?.length, 3);
    // Attendance disabled after its state was read: the projection's own reads are refused, not answered.
    const caller = callerDb(db);
    await meetingsOnLocalDate(caller, installationId, "2026-11-01");
    db.sqlite.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='attendance'");
    await assert.rejects(presentMembersForDay(caller, installationId, "2026-11-01"), isModuleAuthorityDenied);
    // The calling module disabled: its own guard refuses every read.
    db.sqlite.exec("UPDATE platform_modules SET phase='enabled' WHERE module_id='attendance'; UPDATE platform_modules SET phase='disabled' WHERE module_id='carpool'");
    await assert.rejects(meetingsOnLocalDate(callerDb(db), installationId, "2026-11-01"), isModuleAuthorityDenied);
    await assert.rejects(listActiveRosterWithLabels(callerDb(db), installationId, "2026-11-01"), isModuleAuthorityDenied);
  } finally { db.close(); }
});

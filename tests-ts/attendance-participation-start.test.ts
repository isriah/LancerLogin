// A blank participation start means the member's roster-added date, including for the browser setup scan.
import test from "node:test";
import assert from "node:assert/strict";
import { Database, request } from "./fixtures/lifecycle-database.ts";
import { attendanceSetupRoute } from "../apps/api/src/attendance-module-setup.ts";

test("setup scans treat a blank participation start as the roster-added date and an explicit date still wins", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-15T18:05:00Z") });
  const database = new Database();
  try {
    database.sqlite.exec(`INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at,attendance_required_from) VALUES
        ('test-a','primary','TEST-A','Test Student','A','student-a@example.test','2026-10-20T08:00:00Z',NULL),
        ('test-b','primary','TEST-B','Test Student','B','student-b@example.test','2026-10-20T08:00:00Z','2026-10-01'),
        ('test-c','primary','TEST-C','Test Student','C','student-c@example.test','2026-10-01T08:00:00Z',NULL);
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES('test-meeting','primary','Test meeting','2026-10-15T18:00:00Z','2026-10-15T20:00:00Z','admin','2026-10-01');`);
    const scan = (memberId: string) => attendanceSetupRoute(request("/module-setup/attendance/input", "POST", { action: "scan", memberId, meetingId: "test-meeting", eventId: `test-${memberId}` }), database, "admin");
    assert.equal((await attendanceSetupRoute(request("/module-setup/attendance/input", "POST", { action: "start", name: "Test simulator" }), database, "admin")).status, 200);
    await assert.rejects(scan("TEST-A"), (error: { status?: number; message?: string }) => error.status === 409 && error.message === "Attendance for Test Student begins on 2026-10-20");
    assert.equal((await scan("TEST-B")).status, 202, "an explicit earlier date overrides the roster-added date");
    assert.equal((await scan("TEST-C")).status, 202, "a blank date added before the meeting is required");
    assert.deepEqual(database.sqlite.prepare("SELECT member_id AS memberId FROM attendance_events ORDER BY member_id").all().map(row => row.memberId), ["test-b", "test-c"]);
  } finally { database.close(); }
});

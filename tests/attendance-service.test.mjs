import test from "node:test";
import assert from "node:assert/strict";
import { createAttendanceService } from "../apps/api/src/attendance-service.mjs";

const admin = { userId: "admin-1", role: "admin" };
const operator = { userId: "operator-1", role: "operator" };
const fixedNow = () => "2026-08-30T12:00:00.000Z";

function ready() {
  const service = createAttendanceService({ now: fixedNow });
  service.addMember(admin, { id: "m-1", externalId: "42", firstName: "Ada", lastName: "Lovelace" });
  service.createMeeting(operator, { id: "meeting-1", title: "Practice", startsAt: "2026-08-30T10:00:00.000Z", endsAt: "2026-08-30T13:00:00.000Z" });
  return service;
}

test("operator can run attendance but cannot manage roster", () => {
  const service = ready();
  assert.throws(() => service.addMember(operator, { id: "m-2", externalId: "43", firstName: "Grace", lastName: "Hopper" }), /Forbidden/);
  assert.deepEqual(service.recordAttendance(operator, { memberId: "m-1", meetingId: "meeting-1", kioskEventId: "scan-1" }), { duplicate: false, action: "check_in" });
});

test("attendance is idempotent by kiosk event identifier", () => {
  const service = ready();
  service.recordAttendance(operator, { memberId: "m-1", meetingId: "meeting-1", kioskEventId: "scan-1" });
  assert.deepEqual(service.recordAttendance(operator, { memberId: "m-1", meetingId: "meeting-1", kioskEventId: "scan-1" }), { duplicate: true });
});

test("corrections and excuses are reasoned and reflected in export", () => {
  const service = ready();
  assert.throws(() => service.correctAttendance(operator, { memberId: "m-1", meetingId: "meeting-1", disposition: "excused", reason: "" }), /Invalid correction/);
  service.correctAttendance(operator, { memberId: "m-1", meetingId: "meeting-1", disposition: "excused", reason: "medical appointment" });
  const csv = service.exportCsv(operator);
  assert.match(csv, /"excused"/);
  assert.equal(service.audit().at(-1).action, "attendance.exported");
});

test("participation start dates omit earlier meetings without deleting their history", () => {
  const service = createAttendanceService({ now: fixedNow });
  service.addMember(admin, { id: "m-1", externalId: "42", firstName: "Ada", lastName: "Lovelace", attendanceRequiredFrom: "2026-09-01" });
  service.createMeeting(operator, { id: "meeting-1", title: "Archived practice", startsAt: "2026-08-30T10:00:00.000Z", endsAt: "2026-08-30T13:00:00.000Z" });
  assert.equal(service.attendanceFor("meeting-1")[0].disposition, "not_required");
  assert.doesNotMatch(service.exportCsv(operator), /Archived practice/);
});

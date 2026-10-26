import test from "node:test";
import assert from "node:assert/strict";
import { attendanceSetupInterval } from "../apps/dashboard/src/attendance-setup-interval.ts";

for (const timeZone of ["UTC", "America/New_York", "Asia/Tokyo", "America/Santiago"]) {
  for (const instant of ["2026-10-25T23:59:59.900Z", "2026-10-25T00:00:00.000Z", "2026-10-25T00:02:00.000Z", "2026-10-25T03:59:59.900Z", "2026-10-25T04:02:00.000Z", "2026-10-25T14:59:59.900Z", "2026-09-06T04:02:00.000Z", "2026-11-01T06:02:00.000Z"]) {
    test(`first meeting stays open and on the organization day at ${instant} in ${timeZone}`, () => {
      const now = Date.parse(instant), interval = attendanceSetupInterval(now, timeZone);
      const start = Date.parse(interval.startsAt), end = Date.parse(interval.endsAt);
      const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
      assert.equal(day.format(start), day.format(now)); assert.equal(day.format(end), day.format(now));
      assert.ok(start <= now); assert.ok(end >= now); assert.ok(end > start); assert.ok(end - start <= 3_600_000);
    });
  }
}
test("near-midnight defaults retain sub-minute precision and never start yesterday", () => {
  assert.deepEqual(attendanceSetupInterval(Date.parse("2026-10-25T23:59:59.900Z"), "UTC"), { startsAt: "2026-10-25T23:54:00.000Z", endsAt: "2026-10-25T23:59:59.999Z" });
  assert.deepEqual(attendanceSetupInterval(Date.parse("2026-10-25T00:02:00.000Z"), "UTC"), { startsAt: "2026-10-25T00:00:00.000Z", endsAt: "2026-10-25T01:00:00.000Z" });
});

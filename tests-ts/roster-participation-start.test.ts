// The roster shows and pre-fills a member's attendance start in the organization's time zone, the date the API's
// attendance policy uses (tests-ts/participation-start-time-zone.test.ts covers the API side), not the UTC date.
import test from "node:test";
import assert from "node:assert/strict";
import { organizationDate, organizationToday, rosterAddedDate } from "../apps/dashboard/src/participation-start.ts";
import { participationStartDate } from "../apps/api/src/attendance-policy.ts";

test("a member added in the evening west of UTC starts on that evening's date, not the next UTC day", () => {
  // America/Los_Angeles is UTC-7 in September: 18:00 local on Sep 14 is 01:00Z on Sep 15.
  assert.equal(rosterAddedDate("2026-09-15T01:00:00.000Z", "America/Los_Angeles"), "2026-09-14");
  // Asia/Tokyo is UTC+9: 07:00 local on Sep 15 is 22:00Z on Sep 14.
  assert.equal(rosterAddedDate("2026-09-14T22:00:00.000Z", "Asia/Tokyo"), "2026-09-15");
  assert.equal(rosterAddedDate("2026-09-15T01:00:00.000Z", "UTC"), "2026-09-15");
});

test("stored timestamp forms read as the API reads them", () => {
  assert.equal(rosterAddedDate("2026-09-15 01:00:00", "America/Los_Angeles"), "2026-09-14", "a SQLite timestamp without a zone is UTC");
  assert.equal(rosterAddedDate("2026-09-15T03:00:00+02:00", "UTC"), "2026-09-15");
  assert.equal(rosterAddedDate("2026-09-15", "America/Los_Angeles"), "2026-09-15", "a bare date is already a date");
  assert.equal(rosterAddedDate(null, "UTC"), ""); assert.equal(rosterAddedDate(undefined, "UTC"), ""); assert.equal(rosterAddedDate("", "UTC"), "");
  assert.equal(rosterAddedDate("not a date", "UTC"), "not a date");
});

test("the roster's date matches the API's participation start for every hour of a day in several zones", () => {
  const zones = ["UTC", "America/Los_Angeles", "America/New_York", "America/St_Johns", "Europe/London", "Asia/Kolkata", "Asia/Tokyo", "Pacific/Auckland", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
  // Across the spring-forward night in the Americas, and an ordinary day.
  for (const day of ["2026-03-08", "2026-09-14"]) for (let hour = 0; hour < 24; hour++) for (const minute of [0, 59]) {
    const added = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
    for (const zone of zones) assert.equal(rosterAddedDate(added, zone), participationStartDate({ rosterAddedAt: added }, zone), `${added} in ${zone}`);
  }
});

test("today is the organization's date, and an unknown time zone falls back to UTC", () => {
  const now = Date.parse("2026-09-15T01:00:00.000Z");
  assert.equal(organizationToday("America/Los_Angeles", now), "2026-09-14");
  assert.equal(organizationToday("UTC", now), "2026-09-15");
  assert.equal(organizationDate(now, "Not/AZone"), "2026-09-15");
});

test("the roster no longer takes the attendance start from the UTC date or the browser's own date", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../apps/dashboard/src/roster-page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /rosterAddedAt\?\.slice\(0, ?10\)/);
  assert.doesNotMatch(source, /getFullYear\(\)/);
  assert.match(source, /rosterAddedDate\(member\?\.rosterAddedAt,timeZone\)/);
});

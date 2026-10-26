import { expect, test } from "@playwright/test";
import { openActiveMeetingCalendar } from "./meeting-calendar-fixture";

for (const timeZone of ["UTC", "America/New_York"]) test.describe(`calendar fixture in ${timeZone}`, () => {
  test.use({ timezoneId: timeZone });
  for (const date of ["2026-10-26", "2026-11-01"]) test(`selects yesterday's active meeting after midnight on ${date}`, async ({ page }) => {
    const now = new Date(`${date}T${timeZone === "UTC" ? "00" : "04"}:10:00Z`);
    const startsAt = new Date(now.getTime() - 30 * 60_000).toISOString();
    await page.clock.setFixedTime(now);
    await page.route("**/meetings", async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.meetings = body.meetings.map((meeting: { id: string }) => meeting.id === "active-meeting" ? { ...meeting, startsAt, endsAt: new Date(now.getTime() + 60 * 60_000).toISOString() } : meeting);
      await route.fulfill({ response, json: body });
    });
    await openActiveMeetingCalendar(page);
    await expect(page.locator('.compact-calendar-day[aria-pressed="true"]')).not.toHaveAttribute("aria-current", "date");
    await page.getByRole("button", { name: "Open meeting Build session", exact: true }).click();
    await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  });
});

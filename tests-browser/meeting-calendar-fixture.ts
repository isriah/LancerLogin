import { expect, type Page } from "@playwright/test";

// The server's active meeting starts 30 minutes before startup and can be on
// yesterday's date. Select its actual date instead of assuming it is today.
export async function openActiveMeetingCalendar(page: Page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/meetings" && value.request().method() === "GET");
  await page.goto("/dashboard");
  const { meetings } = await (await response).json();
  const active = meetings.find((meeting: { id: string }) => meeting.id === "active-meeting");
  expect(active).toBeDefined();
  const dateLabel = await page.evaluate(startsAt => new Date(startsAt).toLocaleDateString(undefined, { dateStyle: "long" }), active.startsAt);
  const selectDay = async () => {
    await expect(page.getByRole("region", { name: "Meeting calendar" })).toBeVisible();
    const day = page.getByRole("button", { name: new RegExp(`^${dateLabel}, \\d+ meetings?$`) });
    // At a month boundary yesterday may fall outside the initial grid.
    if (await day.count() === 0) await page.getByRole("button", { name: "Previous month of meetings" }).click();
    await day.click();
  };
  await selectDay();
  return selectDay;
}

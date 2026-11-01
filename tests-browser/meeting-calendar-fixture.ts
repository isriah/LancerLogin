import { expect, type Locator, type Page } from "@playwright/test";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// On desktop a day with exactly one meeting is a link that opens that meeting, and its accessible name says so; other days are buttons.
export const calendarDay = (page: Page, dateLabel: string, count?: number) => { const name = new RegExp(`^${escapeRegExp(dateLabel)}, ${count ?? "\\d+"} meetings?(, opens meeting .+)?$`); return page.getByRole("button", { name }).or(page.getByRole("link", { name })); };
// A selected button day is pressed; a selected link day (which has no pressed state) carries data-selected.
export const selectedCalendarDays = (page: Page) => page.locator(`.compact-calendar-day:is([aria-pressed="true"], [data-selected="true"])`);
export const expectCalendarDaySelected = (day: Locator) => expect(day.and(selectedCalendarDays(day.page()))).toHaveCount(1);

// Clicking a desktop one-meeting day opens the meeting, so select it the way a
// returning visitor sees it: restore the saved calendar day and reload.
export async function selectCalendarDay(page: Page, day: Locator, dateKey: string) {
  if ((await day.getAttribute("aria-label"))?.includes(", opens meeting ")) {
    await page.evaluate(selectedDate => sessionStorage.setItem("lancerlogin-dashboard-calendar", JSON.stringify({ month: `${selectedDate.slice(0, 7)}-01`, selectedDate })), dateKey);
    await page.reload();
  } else await day.click();
  await expectCalendarDaySelected(day);
}

// The server's active meeting starts 30 minutes before startup and can be on
// yesterday's date. Select its actual date instead of assuming it is today.
export async function openActiveMeetingCalendar(page: Page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/meetings" && value.request().method() === "GET");
  await page.goto("/dashboard");
  const { meetings } = await (await response).json();
  const active = meetings.find((meeting: { id: string }) => meeting.id === "active-meeting");
  expect(active).toBeDefined();
  const { dateLabel, dateKey } = await page.evaluate(startsAt => { const date = new Date(startsAt); return { dateLabel: date.toLocaleDateString(undefined, { dateStyle: "long" }), dateKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` }; }, active.startsAt);
  const selectDay = async () => {
    await expect(page.getByRole("region", { name: "Meeting calendar" })).toBeVisible();
    const day = calendarDay(page, dateLabel);
    // At a month boundary yesterday may fall outside the initial grid.
    if (await day.count() === 0) await page.getByRole("button", { name: "Previous month of meetings" }).click();
    await selectCalendarDay(page, day, dateKey);
  };
  await selectDay();
  return selectDay;
}

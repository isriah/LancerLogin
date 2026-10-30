import { expect, test, type Page } from "@playwright/test";

// Synthetic meetings: one alone on September 9, two sharing September 16 and nothing on September 23.
const meeting = (id: string, title: string, startsAt: string, endsAt: string) => ({ id, title, startsAt, endsAt, attendanceClosesAt: endsAt, required: true, notes: "", audienceMode: "all", audienceLabelIds: [] });
const meetings = [
  meeting("synthetic-solo", "Test solo planning", "2026-09-09T17:00:00Z", "2026-09-09T18:00:00Z"),
  meeting("synthetic-first", "Test first workshop", "2026-09-16T15:00:00Z", "2026-09-16T16:00:00Z"),
  meeting("synthetic-second", "Test second workshop", "2026-09-16T18:00:00Z", "2026-09-16T19:00:00Z"),
];

test.use({ timezoneId: "UTC" });
async function prepare(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install({ time: new Date("2026-09-02T16:00:00Z") });
  await page.route("**/auth/walkthroughs/*", route => route.fulfill({ json: { progress: { pageId: "dashboard", version: 1, status: "completed", stepId: null } } }));
  await page.route("**/meetings", route => route.fulfill({ json: { meetings } }));
  await page.route(/\/meetings\/synthetic-[a-z]+$/, route => route.request().resourceType() === "document" ? route.continue() : route.fulfill({ json: { meeting: meetings.find(item => route.request().url().endsWith(item.id)) } }));
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Meeting calendar" })).toBeVisible();
}
const day = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const panel = (page: Page) => page.locator(".calendar-selected-day");

test("desktop one-meeting days open their meeting by click, Enter or Space", async ({ page }) => {
  await prepare(page, 1280);
  const solo = day(page, "September 9, 2026, 1 meeting, opens meeting Test solo planning");
  await expect(solo).toBeVisible();
  // Anywhere in the cell opens it, including the date number and the entry summary.
  for (const target of [solo.locator("span").first(), solo.locator(".calendar-day-summary")]) {
    await target.click();
    await expect(page).toHaveURL(/\/meetings\/synthetic-solo$/);
    await page.goBack(); await expect(solo).toBeVisible();
  }
  for (const key of ["Enter", "Space"]) {
    await solo.focus(); await page.keyboard.press(key);
    await expect(page).toHaveURL(/\/meetings\/synthetic-solo$/);
    await page.goBack(); await expect(solo).toBeVisible();
  }
});

test("desktop days with several meetings or none still select the day", async ({ page }) => {
  await prepare(page, 1280);
  const shared = day(page, "September 16, 2026, 2 meetings");
  await shared.click();
  await expect(shared).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(panel(page)).toContainText("Test first workshop"); await expect(panel(page)).toContainText("Test second workshop");
  await page.getByRole("button", { name: "Open meeting Test second workshop", exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/synthetic-second$/);
  await page.goBack();
  const empty = day(page, "September 23, 2026, 0 meetings");
  await empty.focus(); await page.keyboard.press("Enter");
  await expect(empty).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(panel(page)).toContainText("No meetings scheduled.");
});

test("phone one-meeting days keep selecting the day and listing it below", async ({ page }) => {
  await prepare(page, 390);
  const solo = day(page, "September 9, 2026, 1 meeting");
  await solo.click();
  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(panel(page)).toContainText("Test solo planning");
  await page.getByRole("button", { name: "Open meeting Test solo planning", exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/synthetic-solo$/);
  await page.goBack();
  // Widening to desktop switches the same cell to opening its meeting; narrowing switches it back.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(day(page, "September 9, 2026, 1 meeting, opens meeting Test solo planning")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(solo).toBeVisible();
  await solo.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(solo).toHaveAttribute("aria-pressed", "true");
});

test("desktop one-meeting days also become the selected day when their meeting opens", async ({ page }) => {
  await prepare(page, 1280);
  const solo = day(page, "September 9, 2026, 1 meeting, opens meeting Test solo planning");
  await solo.click();
  await expect(page).toHaveURL(/\/meetings\/synthetic-solo$/);
  await page.goBack();
  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await expect(panel(page)).toContainText("Test solo planning");
  await page.getByRole("button", { name: "Add meeting", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create meeting" }).getByLabel("Date", { exact: true })).toHaveValue("2026-09-09");
});

for (const width of [1280, 390]) test(`a day is always selected and Add meeting starts on it at ${width}`, async ({ page }) => {
  await page.route("**/meeting-weight-categories", route => route.fulfill({ json: { categories: [] } }));
  await prepare(page, width);
  const pressed = page.locator(".compact-calendar-day[aria-pressed=true]");
  const today = page.getByRole("button", { name: "September 2, 2026, 0 meetings", exact: true });
  const dialog = page.getByRole("dialog", { name: "Create meeting" });
  const addOn = async (date: string) => {
    await page.getByRole("region", { name: "Meeting calendar" }).getByRole("button", { name: "Add meeting", exact: true }).click();
    await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue(date);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(dialog).toHaveCount(0);
  };
  // Today is selected when the page opens, and choosing it again never clears it.
  await expect(today).toHaveAttribute("aria-pressed", "true"); await expect(pressed).toHaveCount(1);
  await today.click(); await expect(today).toHaveAttribute("aria-pressed", "true");
  await addOn("2026-09-02");
  // Another month selects its 1st; coming back to the current month selects today.
  await page.getByRole("button", { name: "Next month of meetings", exact: true }).click();
  await expect(page.getByRole("button", { name: "October 1, 2026, 0 meetings", exact: true })).toHaveAttribute("aria-pressed", "true");
  await addOn("2026-10-01");
  await page.getByRole("button", { name: "Previous month of meetings", exact: true }).click();
  await expect(today).toHaveAttribute("aria-pressed", "true"); await expect(pressed).toHaveCount(1);
  await page.getByRole("button", { name: "Previous month of meetings", exact: true }).click();
  await expect(page.getByRole("button", { name: "August 1, 2026, 0 meetings", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Next month of meetings", exact: true }).click();
  const shared = day(page, "September 16, 2026, 2 meetings");
  await shared.click(); await expect(shared).toHaveAttribute("aria-pressed", "true"); await expect(pressed).toHaveCount(1);
  await addOn("2026-09-16");
  // Table view has no selected day, so its Add meeting keeps the usual default date.
  await page.getByRole("radio", { name: "Table", exact: true }).check();
  await page.getByRole("button", { name: "Add meeting", exact: true }).click();
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("2026-09-02");
});

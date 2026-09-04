import { expect, test } from "@playwright/test";

test("Dashboard owns meeting navigation and remembers the selected browser", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const primary = page.getByRole("navigation", { name: "Primary dashboard navigation" });
  await expect(primary.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Meetings" })).toHaveCount(0);
  await expect(primary.getByRole("link", { name: "Attendance" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Meeting calendar" })).toBeVisible();

  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.getByLabel("Search Meetings")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Table" })).toBeChecked();
  await expect(page.getByLabel("Search Meetings")).toBeVisible();

  await page.getByRole("radio", { name: "Calendar" }).check();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Calendar" })).toBeChecked();
  await expect(page.getByRole("region", { name: "Meeting calendar" })).toBeVisible();
});

test("calendar range controls and all meeting choices open canonical detail routes", async ({ page }) => {
  await page.goto("/dashboard");
  const range = page.locator(".calendar-heading p");
  const initialRange = await range.textContent();
  await page.getByRole("button", { name: "Show next five weeks" }).click();
  await expect(range).not.toHaveText(initialRange!);
  await page.getByRole("button", { name: "Show previous five weeks" }).click();
  await expect(range).toHaveText(initialRange!);

  await page.getByRole("combobox", { name: "Meeting" }).selectOption("active-meeting");
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.locator('.calendar-day button[title^="Build session,"]').click();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await page.goBack();
  await page.goForward();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
});

test("legacy Meetings opens the searchable Dashboard table and rows navigate independently", async ({ page }) => {
  await page.goto("/meetings");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("radio", { name: "Table" })).toBeChecked();
  const search = page.getByLabel("Search Meetings");
  await search.fill("Studio night");
  const row = page.locator(".meeting-browser-row");
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page).toHaveURL(/\/meetings\/next-week$/);
});

test("Add meeting stays available and Dashboard browsers fit a compact phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.getByRole("radio", { name: "Table" })).toBeChecked();
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  for (const control of await page.locator(".meeting-browser-controls button, .meeting-browser-controls select, .meeting-browser-controls label").all()) {
    const bounds = await control.boundingBox();
    if (bounds) expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
});

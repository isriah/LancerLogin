import { expect, test } from "@playwright/test";

test("Dashboard delegates live attendance and contest review to complete replacement paths", async ({ page }) => {
  let attendanceLoads = 0;
  await page.route(/\/attendance\?meetingId=/, async (route) => { attendanceLoads += 1; await route.continue(); });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Meetings in progress/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Attendance contests" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /attendance contest awaiting review/i })).toBeVisible();
  expect(attendanceLoads).toBe(0);

  await page.locator('.calendar-day button[title^="Build session,"]').click();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Meeting attendance" })).toContainText("Active · not checked out");
  await expect(page.locator(".meeting-contests")).toContainText("Jordan Lee");
  expect(attendanceLoads).toBeGreaterThan(0);
});

test("Reports retains attendance CSV export", async ({ page }) => {
  await page.route("**/exports/attendance.csv", (route) => route.fulfill({
    status: 200,
    contentType: "text/csv",
    headers: { "content-disposition": 'attachment; filename="attendance.csv"' },
    body: "member_id,status\nA-101,present\n",
  }));
  await page.goto("/reports");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download attendance CSV" }).click();
  await expect((await download).suggestedFilename()).toMatch(/^lancerlogin-attendance-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("Kiosks exposes verified Discord status sync beside physical health and stays responsive", async ({ page }) => {
  let syncRequests = 0;
  await page.route("**/discord/kiosk-status", async (route) => {
    syncRequests += 1;
    expect(route.request().method()).toBe("POST");
    await route.fulfill(syncRequests === 1
      ? { status: 200, contentType: "application/json", body: JSON.stringify({ changed: true, messageId: "replacement-status-1", online: true }) }
      : { status: 502, contentType: "application/json", body: JSON.stringify({ error: "Discord denied this request because the bot cannot access the selected channel." }) });
  });

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/kiosks");
    const physical = page.locator(".kiosk-grid > .task-card").filter({ has: page.getByRole("heading", { name: "Physical kiosk" }) });
    const discordStatus = physical.getByRole("region", { name: "Discord kiosk status" });
    await expect(discordStatus).toBeVisible();
    const syncButton = discordStatus.getByRole("button", { name: "Sync Discord status" });
    expect((await syncButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    const theme = page.getByRole("switch", { name: "Dark mode" });
    if (!await theme.isChecked()) await theme.click();
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
    await theme.click();
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  }

  await page.goto("/kiosks");
  await page.getByRole("button", { name: "Sync Discord status" }).click();
  await expect(page.getByRole("status")).toHaveText("Persistent Discord kiosk status updated.");
  expect(syncRequests).toBe(1);
  await page.getByRole("button", { name: "Sync Discord status" }).click();
  await expect(page.getByRole("alert")).toHaveText("Discord denied this request because the bot cannot access the selected channel.");
  expect(syncRequests).toBe(2);

  await page.route("**/integrations/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: true, configured: false } } }),
  }));
  await page.goto("/kiosks");
  await expect(page.getByRole("region", { name: "Discord kiosk status" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync Discord status" })).toHaveCount(0);

  await page.route("**/integrations/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: true, configured: true } } }),
  }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [] }) }));
  await page.goto("/kiosks");
  await expect(page.getByText("No kiosk paired", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync Discord status" })).toBeVisible();
});

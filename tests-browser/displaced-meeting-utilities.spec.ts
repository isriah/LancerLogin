import { setDashboardTheme } from "./dashboard-theme";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("Dashboard delegates live attendance and contest review to complete replacement paths", async ({ page }) => {
  let attendanceLoads = 0;
  await page.route(/\/attendance\?meetingId=/, async (route) => { attendanceLoads += 1; await route.continue(); });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Meetings in progress/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Attendance contests" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /attendance contest awaiting review/i })).toBeVisible();
  expect(attendanceLoads).toBe(0);

  await page.getByRole("button", { name: "Open meeting Build session", exact: true }).click();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Meeting actions" })).toHaveCount(0);
  await page.locator(".meeting-more-actions > summary").click();
  await expect(page.getByRole("group", { name: "Meeting actions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Calendar delivery|Discord operations/ })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Meeting attendance" })).toContainText("Active · not checked out");
  await expect(page.getByRole("link", { name: "Avery Stone" })).toHaveAttribute("href", "/roster/A-101");
  await expect(page.locator(".meeting-contests")).toContainText("Jordan Lee");
  await expect(page.locator(".meeting-contests")).toContainText("Submitted contests");
  await expect(page.locator(".meeting-contests")).toContainText("Partial — checked in, no check-out");
  expect(attendanceLoads).toBeGreaterThan(0);
});

test("meeting contest card stays hidden when that meeting has no contests", async ({ page }) => {
  await page.route("**/discord/contests?meetingId=*", (route) => route.fulfill({ json: { contests: [] } }));
  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("heading", { name: "Attendance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attendance contests" })).toHaveCount(0);
});

test("Saved reports retain summary and detailed attendance CSV exports", async ({ page }) => {
  let savedReport: Record<string, unknown> | undefined;
  await page.route("**/reports/views", async (route) => {
    if (route.request().method() === "POST") {
      savedReport = { ...route.request().postDataJSON(), id: "export-report", ownerUserId: "admin-1", revision: 1, warnings: [], errors: [] };
      return route.fulfill({ status: 201, json: { report: savedReport } });
    }
    return route.fulfill({ json: { reports: savedReport ? [savedReport] : [] } });
  });
  await page.route("**/reports/views/export-report", (route) => route.fulfill({ json: { report: savedReport } }));
  await page.route("**/exports/report.csv", (route) => route.fulfill({
    status: 200,
    contentType: "text/csv",
    headers: { "content-disposition": 'attachment; filename="report.csv"' },
    body: "Member,Regular attendance\nAvery Stone,100%\n",
  }));
  await page.route("**/exports/report-detail.csv", (route) => route.fulfill({
    status: 200,
    contentType: "text/csv",
    headers: { "content-disposition": 'attachment; filename="report-detail.csv"' },
    body: "member_id,status\nA-101,present\n",
  }));
  await page.goto("/reports/new");
  await page.getByLabel("Report name").fill("Attendance review");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/view\/export-report$/);
  const exportMenu = page.locator(".report-menu").filter({ has: page.locator("summary").filter({ hasText: /^Export$/ }) });

  await exportMenu.locator("summary").click();
  const summary = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report CSV" }).click();
  const summaryFile = await summary;
  expect(summaryFile.suggestedFilename()).toMatch(/^lancerlogin-attendance-review-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(await readFile((await summaryFile.path())!, "utf8")).toBe("Member,Regular attendance\nAvery Stone,100%\n");
  await exportMenu.locator("summary").click();
  const detail = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download detailed attendance CSV" }).click();
  const detailFile = await detail;
  expect(detailFile.suggestedFilename()).toMatch(/^lancerlogin-attendance-review-\d{4}-\d{2}-\d{2}-detail\.csv$/);
  expect(await readFile((await detailFile.path())!, "utf8")).toBe("member_id,status\nA-101,present\n");
});

test("Kiosk management exposes verified Discord status sync and stays responsive", async ({ page }) => {
  const openMaintenance = async () => {
    await page.goto("/kiosks");
    await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
    await page.locator(".kiosk-management-section > summary").filter({ hasText: /^Device maintenance$/ }).click();
  };
  let syncRequests = 0;
  await page.route("**/discord/kiosk-status", async (route) => {
    syncRequests += 1;
    expect(route.request().method()).toBe("POST");
    await route.fulfill(syncRequests === 1
      ? { status: 200, contentType: "application/json", body: JSON.stringify({ changed: true, messageId: "replacement-status-1", online: true, messageUrl: "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678" }) }
      : { status: 502, contentType: "application/json", body: JSON.stringify({ error: "Discord denied this request because the bot cannot access the selected channel." }) });
  });

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await openMaintenance();
    const physical = page.locator(".kiosk-grid > .task-card");
    await expect(physical.getByRole("region", { name: "Discord kiosk status" })).toHaveCount(0);
    const syncButton = physical.getByRole("button", { name: "Sync Discord status" });
    expect((await syncButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await setDashboardTheme(page, "dark");
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
    await setDashboardTheme(page, "light");
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  }

  await openMaintenance();
  await page.getByRole("button", { name: "Sync Discord status" }).click();
  await expect(page.locator('.kiosk-notice[role="status"]')).toHaveText("Persistent Discord kiosk status updated.");
  expect(syncRequests).toBe(1);
  const messageLink = page.getByRole("link", { name: "View Discord status message" });
  expect((await messageLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 390, height: 844 });
  await messageLink.focus();
  await expect(messageLink).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("link", { name: "View Discord status message" })).toHaveAttribute("href", "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678");
  await page.getByRole("button", { name: "Sync Discord status" }).click();
  await expect(page.locator('.kiosk-notice[role="alert"]')).toHaveText("Discord denied this request because the bot cannot access the selected channel.");
  expect(syncRequests).toBe(2);

  await page.route("**/integrations/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: true, configured: false } } }),
  }));
  await openMaintenance();
  await expect(page.getByRole("button", { name: "Sync Discord status" })).toHaveCount(0);

  await page.route("**/integrations/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: true, configured: true } } }),
  }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [] }) }));
  await page.goto("/kiosks");
  await expect(page.getByText("No kiosk paired", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync Discord status" })).toHaveCount(0);
});

import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

type Role = "admin" | "operator";

async function useReferenceContext(page: Page, role: Role = "admin", discordConfigured = true) {
  await page.route("**/setup/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      configured: true,
      installation: { authMode: "local" },
      settings: {
        organizationName: "Reference Arts Collective",
        subtitle: "Shared operations",
        logoData: "",
        primaryColor: dashboardConformanceReferences.brand.primary,
        secondaryColor: dashboardConformanceReferences.brand.secondary,
        appearance: "dark",
        logoBackdrop: "auto",
        lateScanMinutes: 30,
      },
    }),
  }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { role } }) }));
  await page.route("**/integrations/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: false, configured: false }, discord: { enabled: discordConfigured, configured: discordConfigured } } }),
  }));
}

async function expectContained(page: Page) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped: Array.from(document.querySelectorAll<HTMLElement>("main button, main input, main select, main textarea, main [role='status']")).flatMap((element) => {
      const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || bounds.width === 0 || element.closest(".responsive-table")) return [];
      return bounds.left < -1 || bounds.right > innerWidth + 1 ? [element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName] : [];
    }),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.clipped).toEqual([]);
}

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
    test(`meeting browser conforms at ${viewport.width}x${viewport.height} in ${theme} mode with reference branding`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await useReferenceContext(page);
      await page.goto("/dashboard");

      const app = page.locator(".app");
      await expect(app).toHaveAttribute("data-theme", theme);
      await expect(app).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
      await expect(app).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Meeting calendar" })).toBeVisible();
      await expect(page.locator(".dashboard-meeting-status")).toHaveCount(0);
      await expect(page.getByText("Dashboard data is current.")).toHaveCount(0);
      await expectContained(page);

      const tableChoice = page.getByRole("radio", { name: "Table" });
      await tableChoice.focus();
      await page.keyboard.press("Space");
      await expect(tableChoice).toBeChecked();
      await expect(page.getByRole("table")).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete selected (0)" })).toBeDisabled();
      await expect(page.locator(".meeting-directory-heading")).toContainText("5 of 5 shown");
      await expectContained(page);

      const add = page.getByRole("button", { name: "Add meeting" });
      await add.click();
      const dialog = page.getByRole("dialog", { name: "Create meeting" });
      await expect(dialog).toHaveAttribute("aria-describedby", "meeting-create-description");
      await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
      await expectContained(page);
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();
    });
  }
}

test("meeting browser empty, loading, error, success, and partial Discord outcomes remain explicit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useReferenceContext(page);
  await page.route(/\/meetings$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meetings: [] }) });
  });
  await page.goto("/dashboard");
  const overlay = page.locator(".dashboard-loading-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".dashboard-loading-indicator")).toHaveCSS("animation-name", "none");
  await expect(page.getByText("No meetings are scheduled in this five-week range.")).toBeVisible();
  await expect(page.locator(".dashboard-meeting-status")).toHaveCount(0);
  await expect(page.getByText("Dashboard data is current.")).toHaveCount(0);
  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.getByText("No meetings are available yet.")).toBeVisible();

  await page.unroute(/\/meetings$/);
  await page.route(/\/meetings$/, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Meeting service is unavailable." }) }));
  await page.reload();
  const error = page.locator(".dashboard-meeting-status");
  await expect(error).toHaveText("Meeting service is unavailable.");
  await expect(error).toHaveAttribute("data-tone", "error");

  await page.unroute(/\/meetings$/);
  await page.reload();
  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.getByRole("button", { name: "Sync all to Discord" })).toHaveCount(0);
  await expectContained(page);
});

for (const context of dashboardConformanceReferences.viewports.flatMap((viewport) => dashboardConformanceReferences.themes.map((theme) => ({ role: theme === "light" ? "admin" as const : "operator" as const, viewport, theme })))) {
  test(`${context.role} meeting detail conforms at ${context.viewport.width}x${context.viewport.height} in ${context.theme} mode`, async ({ page }) => {
    await page.setViewportSize(context.viewport);
    await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), context.theme);
    await useReferenceContext(page, context.role);
    await page.goto("/meetings/active-meeting");
    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Build session" })).toBeVisible();
    await expect(page.locator('[aria-label="Meeting summary"]')).not.toContainText("Attendance closes");
    await expect(page.getByRole("table", { name: "Meeting attendance" })).toBeVisible();
    await expect(page.locator('[role="columnheader"]')).toHaveCount(4);
    const scanHeader = page.locator('[role="columnheader"]').filter({ hasText: "Scan times" });
    if (context.viewport.width > 760) await expect(scanHeader).toBeVisible();
    else {
      await expect(scanHeader).toBeHidden();
      const firstAttendanceRow = page.locator(".attendance-row").filter({ hasText: "Avery Stone" });
      await expect(firstAttendanceRow.getByText("Check-in", { exact: true })).toBeVisible();
      await expect(firstAttendanceRow.getByText("Check-out", { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(context.role === "admin" ? 3 : 0);
    await expect(page.locator(".attendance-state.active")).toContainText("Active · not checked out");
    await expect(page.locator(".attendance-state.present")).toContainText("present");
    await expect(page.locator(".attendance-state.absent")).toContainText("absent");
    await expectContained(page);

    const edit = page.getByRole("button", { name: "Edit" });
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Edit meeting" });
    await expect(dialog).toHaveAttribute("aria-describedby", "edit-meeting-title-description");
    await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
  });
}

test("meeting detail distinguishes timing gates, unavailable configuration, empty attendance, and API feedback", async ({ page }) => {
  const now = Date.now(); const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const upcoming = { id: "upcoming", title: "Upcoming workshop", startsAt: iso(30), endsAt: iso(90), attendanceClosesAt: iso(120), required: 0 };
  await useReferenceContext(page);
  await page.route(/\/meetings$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meetings: [upcoming] }) }));
  await page.route(/\/meetings\/upcoming$/, (route) => route.request().resourceType() === "document"
    ? route.continue()
    : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meeting: upcoming }) }));
  await page.route(/\/attendance\?meetingId=upcoming$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ attendance: [] }) }));
  await page.route("**/calendars/sync", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [{ provider: "discord", synced: 0, queued: 0, skipped: 0, failed: 1 }] }) }));
  await page.goto("/meetings/upcoming");
  await expect(page.locator(".meeting-lifecycle")).toHaveText("Upcoming");
  await expect(page.getByRole("button", { name: "Sync configured calendars" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send Discord absence notice" })).toBeDisabled();
  await expect(page.getByText("No active roster records are available.")).toBeVisible();
  await page.getByRole("button", { name: "Sync configured calendars" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Discord: 0 updated, 1 need attention" })).toHaveAttribute("data-tone", "error");

  await page.goto("/meetings/missing-meeting");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting unavailable" })).toBeVisible();
  await expect(page.locator(".empty-page [role='status']")).toHaveAttribute("data-tone", "error");

  await page.unroute("**/integrations/capabilities");
  await useReferenceContext(page, "operator", false);
  await page.goto("/meetings/upcoming");
  await expect(page.getByRole("heading", { name: "Discord operations" })).toHaveCount(0);
  await expect(page.locator(".meeting-contests")).toHaveCount(0);
});

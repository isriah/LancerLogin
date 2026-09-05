import { expect, test } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

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

  const meetingSelector = page.getByRole("combobox", { name: "Meeting" });
  await meetingSelector.focus();
  await expect(meetingSelector).toBeFocused();
  await meetingSelector.press("End");
  await expect(page).toHaveURL(/\/meetings\/next-week$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.locator('.calendar-day button[title^="Build session,"]').click();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await page.goBack();
  await page.goForward();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
});

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
    test(`Dashboard meeting selector conforms at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
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
            appearance: theme,
            logoBackdrop: "auto",
            lateScanMinutes: 30,
            discordContestWindowHours: 24,
          },
        }),
      }));

      await page.goto("/dashboard");
      const selector = page.getByRole("combobox", { name: "Meeting" });
      await expect(selector).toBeVisible();
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);

      const appearance = await selector.evaluate((element) => {
        const select = element as HTMLSelectElement;
        const style = getComputedStyle(select);
        const bounds = select.getBoundingClientRect();
        return {
          appearance: style.appearance,
          backgroundImage: style.backgroundImage,
          borderRadius: style.borderRadius,
          fontFamily: style.fontFamily,
          height: bounds.height,
          clipped: bounds.left < 0 || bounds.right > innerWidth,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(appearance.appearance).toBe("none");
      expect(appearance.backgroundImage).not.toBe("none");
      expect(appearance.borderRadius).not.toBe("0px");
      expect(appearance.fontFamily).toContain("Roboto");
      expect(appearance.height).toBeGreaterThanOrEqual(44);
      expect(appearance.clipped).toBe(false);
      expect(appearance.pageOverflow).toBeLessThanOrEqual(0);

      await selector.focus();
      await expect(selector).toBeFocused();
      await expect(selector).toHaveCSS("outline-style", "solid");
      await selector.evaluate((element) => element.setAttribute("disabled", ""));
      await expect(selector).toBeDisabled();
      await expect(selector).toHaveCSS("cursor", "not-allowed");
      await expect(selector).toHaveCSS("opacity", "0.7");
    });
  }
}

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

test("Table search, checkbox selection, bulk delete, and Sync all stay independent from row navigation", async ({ page }) => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  await page.route(/\/(meetings\/bulk-delete|discord\/calendar)$/, async (route) => {
    requests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    const body = new URL(route.request().url()).pathname === "/meetings/bulk-delete" ? { deleted: 1 } : { synced: 1, skipped: 0, failed: 0, outcomes: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/dashboard");
  await page.getByRole("radio", { name: "Table" }).check();
  const search = page.getByLabel("Search Meetings");
  await search.fill("Build session");
  const row = page.locator(".meeting-browser-row").filter({ hasText: "Build session" });
  const checkbox = row.getByRole("checkbox", { name: "Select Build session" });
  await checkbox.check();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole("button", { name: "Delete selected (1)" })).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete selected (1)" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 selected meetings deleted." })).toBeVisible();
  await page.getByRole("button", { name: "Sync all to Discord" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Discord calendar: 1 updated" })).toBeVisible();
  expect(requests).toEqual([
    { path: "/meetings/bulk-delete", body: { meetingIds: ["active-meeting"], confirmation: "DELETE SELECTED MEETINGS" } },
    { path: "/discord/calendar", body: { all: true } },
  ]);
});

test("Add meeting opens a keyboard-contained dialog and restores focus when dismissed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  const add = page.getByRole("button", { name: "Add meeting" });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Create meeting" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(page.getByRole("radio", { name: "Calendar" })).toBeChecked();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toBeFocused();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  for (const control of await page.locator(".meeting-browser-controls button, .meeting-browser-controls select, .meeting-browser-controls label").all()) {
    const bounds = await control.boundingBox();
    if (bounds) expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
});

test("creation recovers API validation and preserves duplication, recurrence, and Discord best-effort messaging", async ({ page }) => {
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/meetings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Meeting attendance windows cannot overlap." }) });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ meetings: Array.from({ length: 4 }, (_, index) => ({ id: `copy-${index + 1}`, ...body })) }) });
  });

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Add meeting" }).click();
  const dialog = page.getByRole("dialog", { name: "Create meeting" });
  await dialog.getByLabel("Duplicate an existing meeting").selectOption("active-meeting");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("Build session");
  await expect(dialog.getByLabel("Frequency")).toHaveValue("weekly");
  await expect(dialog.getByLabel("Series end date")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Create recurring series" }).click();
  const error = dialog.getByRole("alert");
  await expect(error).toHaveText("Meeting attendance windows cannot overlap.");
  await expect(error).toBeFocused();
  await dialog.getByLabel("Title", { exact: true }).fill("Build session copy");
  await dialog.getByRole("button", { name: "Create recurring series" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "4 meetings created. Discord calendar sync was requested." })).toBeVisible();
  expect(submitted[1]).toMatchObject({ title: "Build session copy", notes: "Bring safety glasses.", recurrence: { frequency: "weekly" } });
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("meeting creation shows the first automatic weight rule and permits a manual override", async ({ page }) => {
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/meeting-weight-categories", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [
    { id: "standard", name: "Standard", weight: 2, minimumDurationMinutes: 30, position: 0, active: true },
    { id: "extended", name: "Extended", weight: 3, minimumDurationMinutes: 30, position: 1, active: true },
  ] }) }));
  await page.route("**/meetings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>; submitted.push(body);
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ meeting: { id: `weighted-${submitted.length}`, ...body }, meetings: [{ id: `weighted-${submitted.length}`, ...body }] }) });
  });

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Add meeting" }).click();
  let dialog = page.getByRole("dialog", { name: "Create meeting" });
  await expect(dialog.getByLabel("Attendance weight")).toHaveValue("automatic");
  await expect(dialog.getByLabel("Attendance weight").getByRole("option").first()).toHaveText("Automatic (Standard (2×))");
  await dialog.getByLabel("Title", { exact: true }).fill("Automatic weight");
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();

  await page.getByRole("button", { name: "Add meeting" }).click();
  dialog = page.getByRole("dialog", { name: "Create meeting" });
  await dialog.getByLabel("Title", { exact: true }).fill("Manual weight");
  await dialog.getByLabel("Attendance weight").selectOption("extended");
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
  expect(submitted[0]).not.toHaveProperty("weightCategoryId");
  expect(submitted[1]).toMatchObject({ title: "Manual weight", weightCategoryId: "extended" });
});

test("successful creation refreshes the selected calendar or table and the meeting selector", async ({ page }) => {
  const start = new Date(Date.now() + 24 * 60 * 60_000); start.setHours(18, 0, 0, 0);
  let meetings = [{ id: "starting-meeting", title: "Starting point", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 60 * 60_000).toISOString(), attendanceClosesAt: new Date(start.getTime() + 90 * 60_000).toISOString(), required: 1 }];
  await page.route("**/meetings", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meetings }) });
    const body = route.request().postDataJSON() as { title: string; startsAt: string; endsAt: string; required: boolean; notes?: string };
    const created = { id: `created-${meetings.length}`, ...body, attendanceClosesAt: new Date(Date.parse(body.endsAt) + 30 * 60_000).toISOString() };
    meetings = [...meetings, created];
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ meeting: created, meetings: [created] }) });
  });

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Add meeting" }).click();
  let dialog = page.getByRole("dialog", { name: "Create meeting" });
  await dialog.getByLabel("Title", { exact: true }).fill("Calendar planning");
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Meeting" }).getByRole("option", { name: /Calendar planning/ })).toHaveCount(1);
  await expect(page.locator('.calendar-day button[title^="Calendar planning,"]')).toBeVisible();
  await expect(page.getByRole("radio", { name: "Calendar" })).toBeChecked();

  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.locator(".meeting-browser-row").filter({ hasText: "Calendar planning" })).toBeVisible();
  await page.getByRole("button", { name: "Add meeting" }).click();
  dialog = page.getByRole("dialog", { name: "Create meeting" });
  await dialog.getByLabel("Title", { exact: true }).fill("Table planning");
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
  await expect(page.locator(".meeting-browser-row").filter({ hasText: "Table planning" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Meeting" }).getByRole("option", { name: /Table planning/ })).toHaveCount(1);
  await expect(page.getByRole("radio", { name: "Table" })).toBeChecked();
  await expect(page).toHaveURL(/\/dashboard$/);
});

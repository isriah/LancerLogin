import { expect, test, type Page, type Locator } from "@playwright/test";
import { outreachSnapshot } from "./module-fixtures";
import { pairedViews } from "./paired-views";
import { requireOutreachPlugin } from "./outreach-fixtures";

const meeting = { id: "active-meeting", title: "Synthetic planning", startsAt: "2026-09-28T14:00:00Z", endsAt: "2026-09-28T16:30:00Z", attendanceClosesAt: "2026-09-28T17:00:00Z", required: true, notes: "Bring the synthetic project plan.", audienceMode: "all", audienceLabelIds: [] };
const activity = { id: "synthetic-service", mode: "event", labelIds: [], labels: [], serviceDate: "2026-09-28", teamId: null, title: "Synthetic service day", description: "Sort practice materials", location: "Synthetic library", impactRelevant: true, archived: false, revision: 0, eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null };

async function appearance(page: Page, theme: string) {
  await page.clock.install({ time: new Date("2026-09-28T18:00:00Z") });
  await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
  await page.route("**/auth/walkthroughs/*", route => route.fulfill({ json: { progress: { pageId: "dashboard", version: 1, status: "completed", stepId: null } } }));
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Arts Collective", subtitle: "Practice workspace", logoData: "", primaryColor: "#8b2f72", secondaryColor: "#e9b949", appearance: theme, logoBackdrop: "auto", lateScanMinutes: 30 } } }));
}
async function contained(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
async function sideBySide(left: Locator, right: Locator) { const a = (await left.boundingBox())!; const b = (await right.boundingBox())!; expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1); expect(a.x + a.width).toBeLessThanOrEqual(b.x); expect(a.height).toBeGreaterThanOrEqual(44); }

for (const { viewport, theme } of pairedViews) {
  test(`month selection and meeting dialog remain usable at ${viewport.width} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport); await appearance(page, theme);
    await page.route("**/meetings", route => route.fulfill({ json: { meetings: [meeting, { ...meeting, id: "later", title: "Later synthetic planning", startsAt: "2026-09-30T14:00:00Z", endsAt: "2026-09-30T16:00:00Z" }] } }));
    await page.goto("/dashboard");
    await expect(page.getByRole("radio", { name: "Calendar", exact: true })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Meeting", exact: true })).toHaveCount(0);
    await expect(page.locator(".calendar-selected-day")).toContainText(meeting.notes);
    const day = page.getByRole("button", { name: "September 30, 2026, 1 meeting", exact: true });
    await day.focus(); await page.keyboard.press("Enter"); await expect(day).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".calendar-selected-day")).toContainText("Later synthetic planning");
    await page.getByRole("button", { name: "Next month of meetings" }).click();
    await expect(page.locator(".compact-month-navigation > strong")).toHaveText("October 2026");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator(".calendar-selected-day")).toContainText(meeting.notes);
    await page.getByRole("radio", { name: "Table", exact: true }).check();
    await expect(page.getByRole("combobox", { name: "Meeting", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select Synthetic planning", exact: true }).check();
    await expect(page).toHaveURL(/\/dashboard$/); await expect(page.getByRole("button", { name: "Delete selected (1)" })).toBeEnabled();
    await page.getByRole("button", { name: "Add meeting", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create meeting", exact: true });
    await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
    await expect(dialog.locator(".meeting-duplicate-disclosure")).not.toHaveAttribute("open");
    await sideBySide(dialog.getByLabel("Start time", { exact: true }), dialog.getByLabel("End time", { exact: true }));
    for (const label of await dialog.locator(".inline-options > label").all()) expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await contained(page); await page.screenshot({ path: test.info().outputPath("create-meeting.png") });
    await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Add meeting", exact: true })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("meeting-table.png") });
  });

  test(`Outreach calendar, original detail cards and dialog at ${viewport.width} ${theme}`, async ({ page }) => {
    requireOutreachPlugin();
    await page.setViewportSize(viewport); await appearance(page, theme);
    await page.route("**/platform/modules", route => route.fulfill({ json: outreachSnapshot() }));
    await page.route(/\/admin\/hours(?:\/.*)?(?:\?.*)?$/, route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/admin/hours/activities") return route.fulfill({ json: { items: [activity], nextCursor: null } });
      if (path === "/admin/hours/context") return route.fulfill({ json: { reportingDays: 30, reopenHours: 24, revision: 0, timeZone: "America/New_York", today: "2026-09-28" } });
      if (path === "/admin/hours/publication-providers") return route.fulfill({ json: { google_calendar: false, discord: false } });
      if (path === "/admin/hours/teams") return route.fulfill({ json: { items: [{ id: "team-1", name: "Synthetic team", number: "901", program: "Synthetic", archived: false, revision: 0 }], nextCursor: null } });
      return route.fulfill({ json: { items: [], nextCursor: null } });
    });
    await page.goto("/hours");
    await expect(page.getByRole("heading", { level: 1, name: "Outreach", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Today", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Activity", exact: true })).toHaveCount(0);
    const filters = page.locator(".outreach-activity-visibility > summary"); await filters.click();
    await expect(page.getByRole("checkbox", { name: "Scheduled events" })).toBeChecked(); await page.keyboard.press("Escape");
    await expect(filters).toBeFocused();
    const log = page.locator(".outreach-submission-disclosure"); await log.locator("summary").click();
    await expect(log.getByText("No participation submissions yet.", { exact: true })).toBeVisible(); await log.locator("summary").click();
    await page.getByRole("button", { name: "Create activity", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create Outreach activity", exact: true });
    await expect(dialog.getByText(/Leave both blank for an all-day event/)).toHaveCount(0);
    await sideBySide(dialog.getByLabel("Event start time", { exact: true }), dialog.getByLabel("Event end time", { exact: true }));
    expect((await dialog.getByLabel("Activity title", { exact: true }).boundingBox())!.y).toBeLessThan((await dialog.getByLabel("Event start time", { exact: true }).boundingBox())!.y);
    await dialog.getByRole("combobox", { name: "Activity type", exact: true }).selectOption("team"); await expect(dialog.getByRole("combobox", { name: "Supported team", exact: true })).toHaveAttribute("required", "");
    await dialog.getByRole("combobox", { name: "Activity type", exact: true }).selectOption("task"); await expect(dialog.getByRole("combobox", { name: "Supported team", exact: true })).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Activity type", exact: true }).selectOption("event"); await contained(page); await page.screenshot({ path: test.info().outputPath("create-activity.png") });
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Open activity Synthetic service day", exact: true }).click();
    await expect(page.getByRole("link", { name: "← Outreach", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit activity", exact: true })).toBeVisible();
    await expect(page.locator(".outreach-activity-summary")).toContainText(activity.description);
    const action = page.getByRole("button", { name: "Add member participation", exact: true });
    const area = page.locator(".outreach-participation-action"); expect((await action.boundingBox())!.width).toBeCloseTo((await area.boundingBox())!.width, 0);
    await contained(page); await page.screenshot({ path: test.info().outputPath("activity-detail.png") });
    await page.getByRole("link", { name: "← Outreach", exact: true }).click(); await expect(page).toHaveURL(/\/hours$/);
  });
}

test("meeting attendance adjustments are disclosed without changing correction permissions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await appearance(page, "dark"); await page.goto("/meetings/active-meeting");
  const row = page.getByRole("row").filter({ hasText: "Morgan Diaz" });
  await expect(row.getByRole("button", { name: "Present", exact: true })).toHaveCount(0);
  const pencil = row.getByRole("button", { name: "Adjust attendance for Morgan Diaz", exact: true });
  await pencil.focus(); await page.keyboard.press("Enter"); await expect(pencil).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByRole("button", { name: "Present", exact: true })).toBeDisabled(); await expect(row.getByRole("button", { name: "Clear", exact: true })).toBeVisible();
  await pencil.click(); await expect(row.getByRole("button", { name: "Present", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete meeting", exact: true })).toHaveCount(0);
  await page.locator(".meeting-more-actions > summary").click(); await page.getByRole("button", { name: "Delete meeting", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Delete meeting", exact: true })).toBeVisible(); await page.keyboard.press("Escape");
  await contained(page); await page.screenshot({ path: test.info().outputPath("meeting-detail.png") });
});


test("calendar dates and heading toggle remain readable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 }); await appearance(page, "light");
  await page.route("**/meetings", route => route.fulfill({ json: { meetings: [meeting] } }));
  await page.goto("/dashboard"); await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Calendar", exact: true })).toBeChecked();
  await contained(page);
  const geometry = await page.locator(".calendar-weekdays > span,.compact-calendar-day").evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, clipped: element.scrollWidth > element.clientWidth, fontSize: parseFloat(getComputedStyle(element).fontSize) })));
  await page.screenshot({ path: test.info().outputPath("calendar-320.png") });
  expect(geometry.every(item => item.width >= 25 && !item.clipped && item.fontSize >= 12), JSON.stringify(geometry)).toBe(true);
  for (const label of await page.locator(".compact-view-toggle label").all()) expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: test.info().outputPath("calendar-320.png") });
});

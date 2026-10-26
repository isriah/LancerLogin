import { expect, test, type Page, type Locator } from "@playwright/test";
import { setDashboardTheme } from "./dashboard-theme";
import { outreachSnapshot } from "./module-fixtures";
import { pairedViews } from "./paired-views";

test.use({ timezoneId: "America/New_York" });
async function calendarPresentation(page: Page, day: Locator, title: string, detail: string, width: number) {
  const summary = day.locator(".calendar-day-summaries"), dot = day.locator(".calendar-day-indicator");
  await expect(summary).toContainText(title); await expect(summary).toContainText(detail);
  await expect(day).toHaveAccessibleDescription(new RegExp(title));
  for (const viewport of [width, 900, 901, width]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    if (viewport > 900) { await expect(summary).toBeVisible(); await expect(dot).toBeHidden(); }
    else { await expect(summary).toBeHidden(); await expect(dot).toBeVisible(); await expect(dot).toHaveText("●"); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await day.focus(); await page.keyboard.press("Enter"); await expect(day).toHaveAttribute("aria-pressed", "true");
}

const overnight = { id: "active-meeting", title: "Synthetic overnight planning", startsAt: "2026-10-21T03:31:28.123Z", endsAt: "2026-10-21T06:32:28.123Z", attendanceClosesAt: "2026-10-21T07:02:28.123Z", required: true, notes: "Synthetic schedule fixture", audienceMode: "all", audienceLabelIds: [] };
async function prepare(page: Page) {
  await page.clock.install({ time: new Date("2026-10-19T16:00:00Z") });
  await page.route("**/auth/walkthroughs/*", route => route.fulfill({ json: { progress: { pageId: "dashboard", version: 1, status: "completed", stepId: null } } }));
}
async function meetingRoutes(page: Page, source = overnight) {
  const meeting = { ...source }; const submitted: Record<string, unknown>[] = [];
  await page.route("**/meetings", route => route.fulfill({ json: { meetings: [meeting] } }));
  await page.route("**/meetings/active-meeting/impact", route => route.fulfill({ json: { changed: false, completed: false, impact: [], previewToken: "synthetic" } }));
  await page.route(/\/meetings\/active-meeting$/, route => {
    if (route.request().resourceType() === "document") return route.continue();
    if (route.request().method() === "PATCH") { const body = route.request().postDataJSON(); submitted.push(body); Object.assign(meeting, body); return route.fulfill({ json: {} }); }
    return route.fulfill({ json: { meeting } });
  });
  return submitted;
}

test("overnight title-only edit retains the exact start and next-day end", async ({ page }) => {
  await prepare(page); const submitted = await meetingRoutes(page); await page.goto("/meetings/active-meeting");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit meeting", exact: true });
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("2026-10-20");
  await expect(dialog.getByLabel("End date", { exact: true })).toHaveValue("2026-10-21");
  await dialog.getByLabel("Title", { exact: true }).fill("Renamed synthetic planning");
  await dialog.getByRole("button", { name: "Save meeting", exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(submitted).toHaveLength(1); expect(submitted[0]).toMatchObject({ title: "Renamed synthetic planning", startsAt: overnight.startsAt, endsAt: overnight.endsAt });
});

test("date and start edits preserve the current duration, including a manually changed duration", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await prepare(page);
  const submitted = await meetingRoutes(page, { ...overnight, startsAt: "2026-10-20T17:02:00Z", endsAt: "2026-10-20T18:02:00Z" });
  await page.goto("/meetings/active-meeting"); await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit meeting", exact: true });
  await dialog.getByLabel("Date", { exact: true }).fill("2026-10-22");
  await expect(dialog.getByLabel("End date", { exact: true })).toHaveValue("2026-10-22"); await expect(dialog.getByLabel("End time", { exact: true })).toHaveValue("14:02");
  await dialog.getByLabel("End time", { exact: true }).fill("14:37"); await dialog.getByLabel("Start time", { exact: true }).fill("23:30");
  await expect(dialog.getByLabel("End date", { exact: true })).toHaveValue("2026-10-23"); await expect(dialog.getByLabel("End time", { exact: true })).toHaveValue("01:05");
  await dialog.getByRole("button", { name: "Save meeting", exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(Date.parse(String(submitted[0].endsAt)) - Date.parse(String(submitted[0].startsAt))).toBe(95 * 60_000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("meeting initial loading stays neutral and unavailable appears only after a failed lookup", async ({ page }) => {
  await prepare(page); await meetingRoutes(page);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); let fail = false;
  await page.route(/\/meetings\/active-meeting$/, async route => {
    if (route.request().resourceType() === "document") return route.continue();
    await pending; return route.fulfill(fail ? { status: 404, json: { error: "Meeting not found" } } : { json: { meeting: overnight } });
  });
  await page.goto("/meetings/active-meeting");
  await expect(page.locator("#meeting-detail-title")).toHaveText("Loading meeting");
  await expect(page.getByText(/may have been removed|incorrect link|Meeting unavailable/)).toHaveCount(0);
  release(); await expect(page.getByRole("heading", { name: overnight.title, exact: true })).toBeVisible();
  fail = true; await page.reload(); await expect(page.getByRole("heading", { name: "Meeting unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Meeting not found" })).toBeVisible();
});

for (const { theme, width } of pairedViews) test(`Dashboard selected day survives view changes, detail and reload at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await prepare(page);
  await meetingRoutes(page, { ...overnight, startsAt: "2026-09-09T17:00:00Z", endsAt: "2026-09-09T18:00:00Z" });
  await page.goto("/dashboard"); await page.getByRole("button", { name: "Previous month of meetings", exact: true }).click();
  const selected = page.getByRole("button", { name: "September 9, 2026, 1 meeting", exact: true }); await selected.click();
  await setDashboardTheme(page, theme); await calendarPresentation(page, selected, overnight.title, "1:00 PM - 2:00 PM", width);
  if (theme === "light") await page.screenshot({ path: test.info().outputPath("meeting-calendar.png"), fullPage: true });
  await page.getByRole("radio", { name: "Table", exact: true }).check(); await page.getByRole("radio", { name: "Calendar", exact: true }).check();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: `Open meeting ${overnight.title}`, exact: true }).click();
  await page.getByRole("button", { name: "Back to Dashboard", exact: true }).click(); await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page.reload(); await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".compact-month-navigation > strong")).toHaveText("September 2026");
  await page.getByRole("button", { name: "Today", exact: true }).click(); await expect(page.getByRole("button", { name: "October 19, 2026, 0 meetings", exact: true })).toHaveAttribute("aria-pressed", "true");
});

for (const { theme, width } of pairedViews) test(`Outreach retains selected day and all-day wording through detail and Table at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await prepare(page);
  const activity = { id: "synthetic-all-day", mode: "event", labelIds: [], labels: [], serviceDate: "2026-09-09", teamId: null, title: "Synthetic all-day service", description: "Practice materials", location: "Synthetic library", impactRelevant: true, archived: false, revision: 0, eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null };
  await page.route("**/platform/modules", route => route.fulfill({ json: outreachSnapshot() }));
  await page.route(/\/admin\/hours(?:\/.*)?(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/hours/activities") return route.fulfill({ json: { items: [activity], nextCursor: null } });
    if (path === "/admin/hours/context") return route.fulfill({ json: { reportingDays: 30, reopenHours: 24, revision: 0, timeZone: "America/New_York", today: "2026-10-19" } });
    if (path === "/admin/hours/publication-providers") return route.fulfill({ json: { google_calendar: false, discord: false } });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/hours"); await page.getByRole("button", { name: "Previous month of activities", exact: true }).click();
  const selected = page.getByRole("button", { name: "September 9, 2026, 1 activity", exact: true }); await selected.click();
  await setDashboardTheme(page, theme); await calendarPresentation(page, selected, activity.title, "All day", width);
  if (theme === "light") await page.screenshot({ path: test.info().outputPath("outreach-calendar.png"), fullPage: true });
  await expect(page.locator(".calendar-selected-record")).toContainText("All day");
  await page.getByRole("button", { name: `Open activity ${activity.title}`, exact: true }).click(); await expect(page.locator(".outreach-activity-summary")).toContainText("All day");
  await page.getByRole("link", { name: "← Outreach", exact: true }).click(); await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radio", { name: "Table", exact: true }).check();
  const row = page.getByRole("row").filter({ hasText: activity.title }); await expect(row).toContainText("All day"); await expect(row).not.toContainText("Not scheduled");
  if (width === 390) await expect(row.locator(".meeting-mobile-details")).toContainText("ScheduleAll day");
  await page.getByRole("radio", { name: "Calendar", exact: true }).check(); await expect(selected).toHaveAttribute("aria-pressed", "true");
  await page.reload(); await expect(selected).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".compact-month-navigation > strong")).toHaveText("September 2026");
});

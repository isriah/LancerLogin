import { expect, test, type Page } from "@playwright/test";
import { pairedViews } from "./paired-views";
import { requireOutreachPlugin } from "./outreach-fixtures";

requireOutreachPlugin();

const activity = { id: "activity-1", categoryId: "other-service", categoryName: "Other Service", title: "Community drive", serviceDate: "2026-09-28", location: "Library", reopened: false };

async function routePublicForm(page: Page) {
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Robotics", subtitle: "Member services", logoData: "", primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 } } }));
  await page.route("**/public/hours/context", (route) => route.fulfill({ json: { organizationName: "Synthetic Robotics", timeZone: "America/New_York", today: "2026-09-28", earliestServiceDate: "2026-08-30", reportingDays: 30 } }));
  await page.route(/\/public\/hours\/activities(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [activity], nextCursor: null } }));
  await page.route("**/public/hours/entries", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>; submissions.push(body);
    await route.fulfill({ status: 201, json: { id: "receipt-public-time", serviceDate: body.serviceDate, startLocal: body.startLocal, endLocal: body.endLocal, durationMinutes: 60, createdAt: "2026-09-28T16:00:00.000Z" } });
  });
  return submissions;
}

async function chooseClock(page: Page, label: string, hour: number, minute: number, period: "AM" | "PM") {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  const dialog = page.getByRole("dialog", { name: label });
  await dialog.getByRole("button", { name: `${hour} o'clock` }).click();
  await dialog.getByRole("button", { name: `${minute} minutes`, exact: true }).click();
  await dialog.getByRole("group", { name: "Choose AM or PM" }).getByRole("button", { name: period, exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^${label}:`) })).toBeFocused();
}

test.describe("clock outside dismissal", () => {
  test.use({ hasTouch: true });
  for (const { theme, width } of pairedViews) test(`clicking outside discards unfinished time selection at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), theme);
    const submissions = await routePublicForm(page);
    await page.goto("/submit-hours");
    await page.getByLabel("Dated activity").selectOption(activity.id);
    const start = page.getByRole("button", { name: /^Start time:/ });
    const picker = page.getByRole("dialog", { name: "Start time", exact: true });
    await start.click();
    await picker.getByRole("button", { name: "9 o'clock" }).click();
    await expect(picker.getByRole("group", { name: "Choose minute" })).toBeVisible();
    await page.getByRole("heading", { level: 1 }).click();
    await expect(picker).toHaveCount(0);
    await expect(start).toHaveText("Choose time");

    await chooseClock(page, "Start time", 9, 0, "AM");
    await start.click();
    await picker.getByRole("button", { name: "11 o'clock" }).click();
    const member = page.getByLabel("Roster member ID");
    if (width === 390) await page.getByRole("heading", { level: 1 }).tap();
    else await member.click({ position: { x: 4, y: 4 } });
    await expect(picker).toHaveCount(0);
    if (width === 1280) await expect(member).toBeFocused();
    await expect(start).toHaveText("9:00 AM");
    await page.getByRole("button", { name: /^End time:/ }).click();
    const end = page.getByRole("dialog", { name: "End time", exact: true });
    await expect(end.locator(".outreach-clock-readout button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(end).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^End time:/ })).toBeFocused();
    expect(submissions).toHaveLength(0);
  });
});

test("moving Start time past End time adjusts a previously selected End time", async ({ page }) => {
  const submissions = await routePublicForm(page);
  await page.goto("/submit-hours");
  await expect(page.getByText("America/New_York")).toHaveCount(0);
  await expect(page.getByText(/LancerLogin rejects overlapping time/)).toHaveCount(0);

  await page.getByLabel("Dated activity").selectOption(activity.id);
  await chooseClock(page, "Start time", 9, 0, "AM"); await chooseClock(page, "End time", 10, 0, "AM");
  await chooseClock(page, "Start time", 11, 0, "AM");

  await expect(page.getByRole("button", { name: "Start time: 11:00 AM" })).toBeVisible();
  await expect(page.getByRole("button", { name: "End time: 12:00 PM" })).toBeVisible();
  await expect(page.getByText("End time must be after start time.")).toHaveCount(0);
  await page.getByLabel("Roster member ID").fill("M-001");
  await page.getByLabel("Dated activity").selectOption(activity.id);
  await page.getByRole("button", { name: "Record completed participation" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Participation recorded" })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ startLocal: "11:00", endLocal: "12:00" });
});

test("keyboard clock selection also moves End time after Start time", async ({ page }) => {
  await routePublicForm(page);
  await page.goto("/submit-hours");

  await page.getByLabel("Dated activity").selectOption(activity.id);
  await chooseClock(page, "Start time", 9, 0, "AM"); await chooseClock(page, "End time", 10, 0, "AM");
  await page.getByRole("button", { name: /^Start time:/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Start time" }).locator(".outreach-clock-readout").getByRole("button", { name: "9", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Start time: 11:00 AM" })).toBeFocused();
  await expect(page.getByRole("button", { name: "End time: 12:00 PM" })).toBeVisible();
});

for (const dismissal of ["finish", "cancel"] as const) test(`clock ${dismissal} returns focus once without stealing a later keyboard target`, async ({ page }) => {
  await routePublicForm(page);
  await page.goto("/submit-hours");
  await page.getByLabel("Dated activity").selectOption(activity.id);
  await chooseClock(page, "Start time", 9, 0, "AM");
  const end = page.getByRole("button", { name: /^End time:/ });
  await end.click();
  const dialog = page.getByRole("dialog", { name: "End time", exact: true });
  if (dismissal === "finish") {
    await dialog.getByRole("button", { name: "10 o'clock" }).click();
    await dialog.getByRole("button", { name: "0 minutes", exact: true }).click();
  }
  await expect(dialog.locator(".outreach-clock-readout")).toBeVisible();
  // Hold deferred focus callbacks so a new keyboard target can be selected
  // between modal cleanup and the next animation frame, without a timing race.
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    const callbacks: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => { callbacks.push(callback); return callbacks.length; };
    (window as typeof window & { releaseClockFrames?: () => void }).releaseClockFrames = () => {
      window.requestAnimationFrame = original;
      for (const callback of callbacks) callback(performance.now());
    };
  });
  if (dismissal === "finish") await dialog.getByRole("group", { name: "Choose AM or PM" }).getByRole("button", { name: "AM", exact: true }).click();
  else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(end).toBeFocused();
  const start = page.getByRole("button", { name: /^Start time:/ });
  await start.focus();
  await page.evaluate(() => (window as typeof window & { releaseClockFrames: () => void }).releaseClockFrames());
  await expect(start).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Start time", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "End time", exact: true })).toHaveCount(0);
});

test("an End time before Start time shows a specific client error without submitting", async ({ page }) => {
  const submissions = await routePublicForm(page);
  await page.goto("/submit-hours");
  await page.getByLabel("Roster member ID").fill("M-001");
  await page.getByLabel("Dated activity").selectOption(activity.id);

  await chooseClock(page, "Start time", 9, 0, "AM");
  await chooseClock(page, "End time", 8, 0, "AM");

  await expect(page.getByRole("alert")).toHaveText("End time must be after start time. Choose a later end time.");
  await expect(page.getByRole("button", { name: "Record completed participation" })).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await expect(page.getByText(/Unable to record these hours/i)).toHaveCount(0);
});

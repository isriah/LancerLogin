import { expect, test, type Page } from "@playwright/test";

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
}

test("moving Start time past End time preserves the default one-hour duration", async ({ page }) => {
  const submissions = await routePublicForm(page);
  await page.goto("/submit-hours");
  await expect(page.getByText("America/New_York")).toHaveCount(0);
  await expect(page.getByText(/LancerLogin rejects overlapping time/)).toHaveCount(0);

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

  await page.getByRole("button", { name: /^Start time:/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Start time: 11:00 AM" })).toBeFocused();
  await expect(page.getByRole("button", { name: "End time: 12:00 PM" })).toBeVisible();
});

test("an End time before Start time shows a specific client error without submitting", async ({ page }) => {
  const submissions = await routePublicForm(page);
  await page.goto("/submit-hours");
  await page.getByLabel("Roster member ID").fill("M-001");
  await page.getByLabel("Dated activity").selectOption(activity.id);

  await chooseClock(page, "End time", 8, 0, "AM");

  await expect(page.getByRole("alert")).toHaveText("End time must be after start time. Choose a later end time.");
  await expect(page.getByRole("button", { name: "Record completed participation" })).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await expect(page.getByText(/Unable to record these hours/i)).toHaveCount(0);
});

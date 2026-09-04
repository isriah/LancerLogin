import { expect, test } from "@playwright/test";

test("roster stays primary and Admin actions open focused dialogs", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Roster" }).click();
  await expect(page.getByRole("heading", { name: "Roster", exact: true })).toBeVisible();
  await expect(page.getByText("Active roster")).toBeVisible();
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");

  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog", { name: "Add roster member" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Import CSV instead" }).click();
  await expect(dialog.getByRole("heading", { name: "Import roster" })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to one member" }).click();
  await page.getByRole("button", { name: "Close add member dialog" }).click();
});

test("member links share route state across Roster, Reports, direct loads, and browser history", async ({ page }) => {
  await page.goto("/roster");
  await page.getByRole("link", { name: "Avery Stone" }).click();
  await expect(page).toHaveURL(/\/roster\/A-101$/);
  await expect(page.getByRole("heading", { name: "Avery Stone" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/roster$/);
  await expect(page.getByRole("heading", { name: "Roster", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Avery Stone" })).toBeVisible();

  await page.goto("/reports");
  await page.getByRole("link", { name: /Avery Stone/ }).click();
  await expect(page).toHaveURL(/\/roster\/A-101$/);
  await expect(page.getByRole("heading", { name: "Avery Stone" })).toBeVisible();

  await page.goto("/roster/A-102");
  await expect(page.getByRole("heading", { name: "Morgan Diaz" })).toBeVisible();
});

test("branding controls and dark surfaces are themed", async ({ page }) => {
  await page.goto("/settings/organization");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Organization" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Logo contrast background" })).toBeVisible();
  await page.getByText("Primary color", { exact: true }).click();
  await expect(page.getByLabel("Hex").first()).toHaveValue("#8b2f72");
  const background = await page.locator(".app").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).toBe("rgb(17, 19, 21)");
});

test("half-width dashboard does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/roster");
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

test("Reports keeps operational filters while pending contests route through the shell", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await expect(page.getByLabel("Meeting type")).toBeVisible();
  await expect(page.getByLabel("Roster")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contests awaiting review" })).toBeHidden();
  await page.getByRole("button", { name: "1 attendance contest awaiting review. Open Home." }).click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attendance contests" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
});

test("Reports filters completed Regular and Optional meetings without hiding All meetings", async ({ page }) => {
  // The preview includes completed meetings of each type. This specifically avoids the
  // prior gap, where the smoke test had only active or future meetings to filter.
  await page.goto("/reports");
  const scope = page.locator(".report-scope");
  const meetingType = page.getByLabel("Meeting type");

  await expect(scope).toHaveText("Showing 2 completed meetings across all preserved history.");
  await meetingType.selectOption("regular");
  await expect(scope).toHaveText("Showing 1 completed meeting across all preserved history.");
  await meetingType.selectOption("optional");
  await expect(scope).toHaveText("Showing 1 completed meeting across all preserved history.");
  await meetingType.selectOption("all");
  await expect(scope).toHaveText("Showing 2 completed meetings across all preserved history.");
});

test("Attendance leaderboard sort selector stays within its card", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/reports");
  const card = page.locator(".leaderboard-card");
  const selector = card.getByLabel("Sort");
  const [cardBounds, selectorBounds] = await Promise.all([card.boundingBox(), selector.boundingBox()]);
  expect(cardBounds).not.toBeNull();
  expect(selectorBounds).not.toBeNull();
  expect(selectorBounds!.x).toBeGreaterThanOrEqual(cardBounds!.x);
  expect(selectorBounds!.x + selectorBounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width);
});

test("Kiosks hides routine refresh success and preserves action feedback", async ({ page }) => {
  await page.route("**/admin/kiosks/kiosk-1", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/kiosks");
  await expect(page.getByRole("heading", { name: "Kiosks", exact: true })).toBeVisible();
  await expect(page.getByText("Kiosk status is current.")).toHaveCount(0);
  await expect(page.locator(".setup-status")).toHaveCount(0);

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Device name").fill("Lobby kiosk");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("status")).toHaveText("Kiosk renamed.");
});

test("Kiosks keeps refresh failures visible", async ({ page }) => {
  await page.route("**/admin/kiosks", (route) => route.abort());
  await page.goto("/kiosks");
  await expect(page.getByRole("status")).toHaveText("Failed to fetch");
});

import { expect, test, type Page } from "@playwright/test";
import { attendanceSetupState, attendanceSnapshot } from "./module-fixtures";

test.use({ timezoneId: "UTC" });

// A new installation with Attendance enabled, an empty roster and no kiosk, so the required input step cannot be verified yet.
async function attendanceSetupWithoutInput(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  const state = attendanceSetupState({ rules: "completed", meeting: "completed" }, ["rules", "meeting"]);
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot({ setupReady: false }) }));
  await page.route("**/admin/modules/attendance/setup", (route) => route.fulfill({ json: state }));
  await page.route("**/module-setup/attendance/meeting", (route) => route.fulfill({ json: { meetings: [], timeZone: "UTC" } }));
  await page.route("**/module-setup/attendance/input", (route) => route.fulfill({ json: { simulator: null, members: [], meetings: [] } }));
}

test("Admin can leave unfinished Attendance setup, reach Settings, and continue setup later", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await attendanceSetupWithoutInput(page);
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Set up Attendance" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary dashboard navigation" })).toHaveCount(0);
  await page.getByRole("button", { name: "Finish setup later" }).click();

  const navigation = page.getByRole("navigation", { name: "Primary dashboard navigation" });
  await expect(navigation).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1, name: "Set up Attendance" })).toHaveCount(0);
  const notice = page.getByRole("region", { name: "Attendance setup is not finished" });
  await expect(notice).toBeVisible();

  // The choice persists in this browser, so a reload keeps the dashboard open with the notice.
  await page.reload();
  await expect(navigation).toBeVisible();
  await expect(notice).toBeVisible();

  await page.goto("/settings/updates");
  await expect(page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: "Updates" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Set up Attendance" })).toHaveCount(0);

  await notice.getByRole("button", { name: "Continue Attendance setup" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Set up Attendance" })).toBeVisible();
  await page.getByRole("button", { name: "Finish setup later" }).click();
  await expect(navigation).toBeVisible();
  await expect(notice).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
import { walkthroughs } from "../packages/shared/src/walkthrough.ts";
import { attendanceSetupState, attendanceSnapshot } from "./module-fixtures";

test.use({ timezoneId: "UTC" });

// A new installation with Attendance enabled, an empty roster and no kiosk, so the Roster card and the required input step cannot be completed yet.
async function attendanceSetupWithoutInput(page: Page) {
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  const state = attendanceSetupState({ rules: "completed", meeting: "completed" }, ["rules", "meeting"]);
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot({ setupReady: false }) }));
  await page.route("**/admin/modules/attendance/setup", (route) => route.fulfill({ json: state }));
  await page.route("**/module-setup/attendance/meeting", (route) => route.fulfill({ json: { meetings: [], timeZone: "UTC" } }));
  await page.route("**/module-setup/attendance/input", (route) => route.fulfill({ json: { simulator: null, members: [], meetings: [] } }));
  await page.route("**/admin/members", (route) => route.fulfill({ json: { members: [] } }));
}

test("Admin can leave unfinished Attendance setup, reach Settings, and continue setup later", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await attendanceSetupWithoutInput(page);
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary dashboard navigation" })).toHaveCount(0);
  await page.getByRole("button", { name: "Finish setup later" }).click();

  const navigation = page.getByRole("navigation", { name: "Primary dashboard navigation" });
  await expect(navigation).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toHaveCount(0);
  const notice = page.getByRole("region", { name: "Attendance setup is not finished" });
  await expect(notice).toBeVisible();

  // The choice persists in this browser, so a reload keeps the dashboard open with the notice.
  await page.reload();
  await expect(navigation).toBeVisible();
  await expect(notice).toBeVisible();

  await page.goto("/settings/updates");
  await expect(page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: "Updates" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toHaveCount(0);

  await notice.getByRole("button", { name: "Continue Attendance setup" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toBeVisible();
  await page.getByRole("button", { name: "Finish setup later" }).click();
  await expect(navigation).toBeVisible();
  await expect(notice).toBeVisible();
});

test("the Roster card adds the first member inline and unlocks Verified attendance input", async ({ page }) => {
  await attendanceSetupWithoutInput(page);
  let members: Array<Record<string, unknown>> = [];
  let added: unknown;
  await page.route("**/admin/members", async (route) => {
    if (route.request().method() === "POST") {
      added = route.request().postDataJSON();
      members = [{ id: "member-1", memberId: "M-001", firstName: "Ada", lastName: "Lovelace", active: true }];
      return route.fulfill({ json: { imported: 1, deactivated: 0, warnings: [] } });
    }
    await route.fulfill({ json: { members } });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toBeVisible();
  const card = page.getByRole("article", { name: "Roster" });
  await expect(card.getByText("Action needed", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Roster", exact: true })).toHaveCount(0);
  await card.getByRole("textbox", { name: "Member ID" }).fill("M-001");
  await card.getByRole("textbox", { name: "First name" }).fill("Ada");
  await card.getByRole("textbox", { name: "Last name" }).fill("Lovelace");
  await expect(card.getByRole("textbox", { name: "Email (optional)" })).toBeVisible();
  await expect(card.getByRole("textbox", { name: /Discord/ })).toHaveCount(0);
  await card.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(card.getByText("Roster member added.")).toBeVisible();
  expect(added).toEqual({ mode: "merge", members: [{ memberId: "M-001", firstName: "Ada", lastName: "Lovelace" }] });
  await expect(card.getByText("1 active member is on the roster: Ada Lovelace.")).toBeVisible();
  await expect(card.getByText("Complete", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Verified attendance input" })).toBeVisible();
  await expect(page.getByText("Pair it from Kiosks once setup is finished.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Roster" })).toBeVisible();
});

test("the Roster card imports a CSV through the shared roster import dialog", async ({ page }) => {
  await attendanceSetupWithoutInput(page);
  await page.goto("/dashboard");
  const card = page.getByRole("article", { name: "Roster" });
  await card.getByRole("button", { name: "Import CSV", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import roster" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose CSV file" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Import CSV", exact: true })).toBeFocused();
});

test("finishing Attendance setup shows next steps and keeps page tours closed for this session", async ({ page }) => {
  let snapshotReady = false;
  const valid = ["rules", "meeting", "input"];
  let state = attendanceSetupState({ rules: "completed", meeting: "completed", input: "completed", calendar: "skipped" }, valid);
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot({ setupReady: snapshotReady }) }));
  await page.route("**/admin/modules/attendance/setup", async (route) => {
    if (route.request().method() === "PUT") { state = attendanceSetupState({ rules: "completed", meeting: "completed", input: "completed", calendar: "skipped", discord: "skipped" }, valid); snapshotReady = true; }
    await route.fulfill({ json: state });
  });
  await page.route("**/auth/walkthroughs/*", (route) => {
    const pageId = new URL(route.request().url()).pathname.split("/").pop()!;
    return route.request().method() === "GET" ? route.fulfill({ json: { progress: { pageId, version: walkthroughs[pageId as keyof typeof walkthroughs]?.version ?? 1, status: "not_started", stepId: null } } }) : route.fulfill({ json: {} });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 2, name: "Discord integration" })).toBeVisible();
  await expect(page.locator(".module-setup-card-heading .ui-status")).toHaveText("Optional");
  await expect(page.getByText("Every required step is complete. Optional steps can be set up now or later.")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator(".module-setup-card-heading .ui-status")).toHaveText("Not set up");
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await page.getByRole("button", { name: "Set up later and continue" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Attendance is ready" })).toBeFocused();
  const steps = page.getByRole("list", { name: "Next steps" });
  for (const [name, href] of [["Pair a kiosk", "/kiosks"], ["Add or import members", "/roster"], ["Invite other Admins", "/settings/access"], ["Connect Google Calendar or Discord", "/settings/integrations"], ["Set up dashboard updates", "/settings/updates"]]) await expect(steps.getByRole("link", { name })).toHaveAttribute("href", href);
  await expect(page.getByRole("button", { name: "Finish setup later" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close setup" })).toHaveCount(0);
  await expect(page.locator(".walkthrough-panel")).toHaveCount(0);

  await steps.getByRole("link", { name: "Add or import members" }).click();
  await expect(page).toHaveURL(/\/roster$/);
  await expect(page.locator('[data-walkthrough-page="roster"][data-walkthrough-ready="true"]')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator(".walkthrough-panel")).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-walkthrough-page="roster"][data-walkthrough-ready="true"]')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator(".walkthrough-panel")).toHaveCount(0);
});

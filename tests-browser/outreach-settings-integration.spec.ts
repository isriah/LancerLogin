import { expect, test, type Page } from "@playwright/test";
import { outreachSnapshot } from "./module-fixtures";

async function settingsFixture(page: Page, role: "admin" | "operator" = "admin") {
  let settings = { memberValidation: "off", revision: 0 }; const writes: unknown[] = []; let reads = 0;
  await page.route("**/platform/modules", route => route.fulfill({ json: outreachSnapshot() }));
  await page.route("**/auth/session", route => route.fulfill({ json: { user: { id: "synthetic-staff", role, debugMode: false } } }));
  await page.route("**/admin/hours/public-form-settings", route => {
    reads++;
    if (route.request().method() === "PUT") { const value = route.request().postDataJSON(); writes.push(value); settings = { memberValidation: value.memberValidation, revision: settings.revision + 1 }; }
    return route.fulfill({ json: settings });
  });
  await page.route(/\/admin\/hours\/(?!public-form-settings)(?:[^?]+)(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith("/context") ? { reportingDays: 30, reopenHours: 24, revision: 0, timeZone: "UTC", today: "2026-10-10" }
      : path.endsWith("/publication-settings") ? { automatic: false, revision: 0 }
      : path.endsWith("/publication-providers") ? { google_calendar: false, discord: false }
      : { items: [], nextCursor: null };
    return route.fulfill({ json });
  });
  return { writes, readCount: () => reads };
}

test("primary module settings and Outreach settings expose the same live privacy configuration", async ({ page }) => {
  const state = await settingsFixture(page); await page.goto("/settings/outreach-setup");
  await expect(page.getByRole("heading", { name: "Public member-ID validation", level: 2 })).toBeVisible();
  const mode = page.getByLabel("Public form privacy mode"); await expect(mode).toHaveValue("off");
  await mode.selectOption("validity"); await page.getByRole("button", { name: "Save public form settings" }).click();
  await expect(page.getByText("Public form privacy settings saved.")).toBeVisible();
  expect(state.writes).toEqual([{ memberValidation: "validity", revision: 0 }]);
  await page.getByRole("link", { name: "Outreach", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await page.goto("/settings/outreach-setup");
  await expect(mode).toHaveValue("validity");
  await mode.selectOption("name"); await page.getByRole("button", { name: "Save public form settings" }).click();
  expect(state.writes[1]).toEqual({ memberValidation: "name", revision: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Operator Outreach view does not expose or request Admin privacy settings", async ({ page }) => {
  const state = await settingsFixture(page, "operator"); await page.goto("/hours");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await page.goto("/settings/outreach-setup");
  await expect(page.getByRole("heading", { name: "Supported teams" })).toBeVisible();
  await expect(page.getByLabel("Public form privacy mode")).toHaveCount(0);
  expect(state.readCount()).toBe(0); expect(state.writes).toEqual([]);
});

test("supported team program is a required FIRST dropdown", async ({ page }) => {
  await settingsFixture(page); const writes: Record<string, unknown>[] = [];
  await page.route("**/admin/hours/teams*", route => { if (route.request().method() === "POST") writes.push(route.request().postDataJSON()); return route.fulfill({ json: { items: [], nextCursor: null } }); });
  await page.goto("/settings/outreach-setup"); await page.getByRole("button", { name: /^Supported teams(?: \(|$)/ }).click(); await page.getByRole("button", { name: "Add team", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add supported team" }); await dialog.getByLabel("Team name").fill("Synthetic team");
  const program = dialog.getByRole("combobox", { name: "Program", exact: true }); await expect(program).toHaveAttribute("required", "");
  await expect(program.locator("option")).toHaveText(["Choose program", "Explore", "Challenge", "FTC", "FRC"]); await expect(dialog.getByRole("button", { name: "Add team", exact: true })).toBeDisabled();
  await program.selectOption("FTC"); await dialog.getByRole("button", { name: "Add team", exact: true }).click(); await expect(page.getByText("Team added.")).toBeVisible();
  expect(writes[0]).toMatchObject({ name: "Synthetic team", program: "FTC" });
});

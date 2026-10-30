import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences as references } from "../apps/dashboard/src/design-conformance";
import { discovered } from "./release-discovery";

const branding = { organizationName: "Reference Arts Collective", subtitle: "Shared operations", logoData: "", primaryColor: references.brand.primary, secondaryColor: references.brand.secondary, logoBackdrop: "auto", lateScanMinutes: 30 };
async function context(page: Page, role: "admin" | "operator" = "admin") {
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: branding } }));
  await page.route("**/auth/session", route => route.fulfill({ json: { user: { role } } }));
  await page.route("**/admin/releases/latest", route => route.fulfill({ json: discovered({ tag_name: "v0.19.0" }) }));
  await page.route("**/admin/update-info", route => route.fulfill({ json: { releaseVersion: "0.19.0" } }));
}

for (const viewport of references.viewports) for (const theme of references.themes) {
  test(`compact header and separate roster columns at ${viewport.width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await context(page);
    await page.route("**/admin/members", route => route.fulfill({ json: { members: [{ id: "member-1", memberId: "MEMBER-12345678901234567890", firstName: "Alexandria-Catherine", lastName: "Montgomery-Wellington", email: "member@example.test", active: 1 }] } }));
    await page.route("**/admin/attendance/members", route => route.fulfill({ json: { members: [{ memberId: "MEMBER-12345678901234567890", attendanceRequiredFrom: "2026-09-01" }] } }));
    await page.goto("/roster");
    const header = page.locator(".dashboard-toolbar");
    await expect(header.getByRole("link", { name: "Go to Dashboard" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Light mode" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    if (viewport.width <= 760) {
      expect((await header.locator(".brand-heading").boundingBox())!.width).toBeGreaterThan(80);
    }
    if (viewport.width > 760) {
      const brand = await header.locator(".dashboard-brand").boundingBox();
      const nav = await header.locator(".primary-navigation").boundingBox();
      expect(nav!.x).toBeGreaterThan(brand!.x + brand!.width);
      expect(Math.abs(nav!.y + nav!.height / 2 - brand!.y - brand!.height / 2)).toBeLessThan(2);
    }
    const row = page.locator(".roster-row").filter({ hasText: "Alexandria-Catherine" });
    const name = await row.locator(".roster-identity").boundingBox();
    const id = await row.locator(".roster-member-id").boundingBox();
    expect(id!.x - name!.x - name!.width).toBeGreaterThanOrEqual(viewport.width <= 760 ? 7 : 15);
    await expect(row.locator(".roster-member-id")).toHaveAttribute("role", "cell");
    await expect(row).not.toContainText("Required from");
    const identityLink = row.locator(".member-link");
    expect((await identityLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const title = await identityLink.locator("strong").boundingBox();
    const email = await identityLink.locator("small").first().boundingBox();
    expect(email!.y - title!.y - title!.height).toBeLessThanOrEqual(1);
    await expect(header.locator(".primary-navigation a")).toHaveText(["Meetings", "Roster", "Reports", "Kiosks", "Settings"]);
    await row.getByRole("button", { name: /^Edit / }).click();
    const editor = page.getByRole("dialog", { name: "Edit roster member" });
    await expect(editor.getByRole("group", { name: "Attendance required from" })).toContainText("Attendance required from: Sep 1, 2026");
    await expect(editor.getByLabel("New start date")).toHaveCount(0);
    await editor.getByLabel("Custom date").check();
    await expect(editor.getByLabel("New start date")).toHaveValue("2026-09-01");
    await page.keyboard.press("Escape");
    await expect(editor).not.toBeVisible();
    await expect(row.getByRole("button", { name: /^Edit / })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("roster.png"), fullPage: true });
  });

  test(`simulator matches physical display and themed controls at ${viewport.width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await context(page);
    let reads = 0;
    await page.route("**/admin/simulator", route => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({ action: "scan", memberId: "member-1", meetingId: "meeting-1" });
        return route.fulfill({ json: { action: ++reads === 1 ? "check_in" : "check_out" } });
      }
      return route.fulfill({ json: { simulator: { name: "Browser test", active: 1, online: 1 } } });
    });
    await page.route("**/admin/members", route => route.fulfill({ json: { members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", active: 1 }] } }));
    await page.route("**/meetings", route => route.fulfill({ json: { meetings: [{ id: "meeting-1", title: "Build planning", startsAt: new Date().toISOString() }] } }));
    await page.goto("/simulator");
    const preview = page.locator(".simulator-kiosk");
    await expect(preview.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
    await expect(preview.locator("#brand-name")).toHaveText(branding.organizationName);
    await expect(preview.locator(".kiosk-brand strong")).toHaveText(branding.subtitle);
    await expect(preview.locator(".network-status, .maintenance-shortcut")).toHaveCount(0);
    await expect(preview.locator(".debug-status")).toContainText("Not a physical kiosk");
    await expect(preview.locator(".scan-panel h1")).toHaveCSS("font-size", "44px");
    for (const selector of [page.getByLabel("Roster member"), page.getByLabel("Meeting", { exact: true })]) {
      await expect(selector).toHaveCSS("appearance", "none");
      expect(await selector.evaluate(el => getComputedStyle(el).backgroundImage)).not.toBe("none");
      await expect(selector).toHaveCSS("font-family", /Roboto/);
      expect((await selector.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await selector.focus();
      await expect(selector).toHaveCSS("outline-style", "solid");
      expect(await selector.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    }
    await page.getByLabel("Roster member").selectOption("member-1");
    await page.getByLabel("Meeting", { exact: true }).selectOption("meeting-1");
    const read = page.getByRole("button", { name: "Simulate member read" });
    const button = await read.boundingBox();
    const controls = await page.locator(".simulator-controls").boundingBox();
    expect(Math.abs(button!.x + button!.width / 2 - controls!.x - controls!.width / 2)).toBeLessThan(2);
    if (viewport.width <= 760) expect(button!.width).toBeCloseTo((await page.getByLabel("Roster member").boundingBox())!.width, 0);
    else expect(button!.width).toBeLessThan(controls!.width - 32);
    await read.press("Enter");
    await expect(preview.getByRole("heading", { name: "Welcome", exact: true })).toBeVisible();
    await expect(preview.locator("#display-name")).toHaveText("Avery Stone");
    await expect(preview.locator("#display-meeting")).toHaveText("Build planning");
    await page.screenshot({ path: test.info().outputPath("simulator.png"), fullPage: true });
    await expect(preview.getByRole("heading", { name: "Place finger on reader" })).toBeVisible({ timeout: 4000 });
    await read.click();
    await expect(preview.getByRole("heading", { name: "Goodbye", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("Roster attendance start date stays automatic unless Custom date is checked", async ({ page }) => {
  await context(page);
  const members = [{ id: "member-1", memberId: "TEST-A", firstName: "Test Student", lastName: "A", email: "student.a@example.test", active: 1, rosterAddedAt: "2026-09-01T15:00:00Z" }];
  const patches: { url: string; body: unknown }[] = [];
  await page.route("**/admin/members", route => route.fulfill({ json: route.request().method() === "POST" ? { ok: true } : { members } }));
  await page.route("**/admin/members/member-1", route => route.fulfill({ json: { ok: true } }));
  await page.route("**/admin/attendance/members", route => route.fulfill({ json: { members: [{ memberId: "TEST-A", attendanceRequiredFrom: null }] } }));
  await page.route("**/admin/attendance/members/*", route => { patches.push({ url: route.request().url(), body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true } }); });
  await page.goto("/roster");
  await page.getByRole("button", { name: "Add member", exact: true }).first().click();
  const adder = page.getByRole("dialog", { name: "Add roster member" });
  await expect(adder.getByRole("group", { name: "Attendance required from" })).toContainText("(today, when they're added)");
  await expect(adder.getByRole("group", { name: "Attendance required from" })).not.toContainText("(optional)");
  await expect(adder.getByLabel("New start date")).toHaveCount(0);
  await adder.getByLabel("Member ID").fill("TEST-B");
  await adder.getByLabel("First name").fill("Test Student");
  await adder.getByLabel("Last name").fill("B");
  await adder.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(adder).not.toBeVisible();
  expect(patches).toEqual([]);

  await page.getByRole("button", { name: "Edit Test Student A" }).click();
  const editor = page.getByRole("dialog", { name: "Edit roster member" });
  await expect(editor.getByRole("group", { name: "Attendance required from" })).toContainText("Sep 1, 2026 (when they were added to the roster)");
  const custom = editor.getByLabel("Custom date");
  await expect(custom).not.toBeChecked();
  await custom.check();
  await expect(editor.getByLabel("New start date")).toHaveValue("2026-09-01");
  await expect(editor.getByText("Meetings before this date won't count against them.")).toBeVisible();
  await editor.getByLabel("New start date").fill("2026-09-15");
  await custom.uncheck();
  await expect(editor.getByLabel("New start date")).toHaveCount(0);
  await custom.check();
  await expect(editor.getByLabel("New start date")).toHaveValue("2026-09-01");
  await editor.getByLabel("New start date").fill("2026-09-15");
  await editor.getByRole("button", { name: "Save member" }).click();
  await expect(editor).not.toBeVisible();
  expect(patches).toEqual([{ url: expect.stringMatching(/\/admin\/attendance\/members\/TEST-A$/), body: { attendanceRequiredFrom: "2026-09-15", expected: null } }]);
});

test("Access renders mixed-case email addresses in lowercase", async ({ page }) => {
  await context(page);
  await page.route("**/admin/users", route => route.fulfill({ json: { users: [{ id: "user-1", email: "Avery@Example.Test", role: "admin", active: 1, createdAt: "2026-09-01" }] } }));
  await page.goto("/settings/access");
  const account = page.locator(".user-list tr.settings-account");
  await expect(account.locator("strong")).toHaveText("avery@example.test");
  await expect(account.locator("td[data-label='Sign-in']")).toHaveText("avery@example.test");
  await expect(account.locator("td[data-label='Sign-in']")).toHaveCSS("text-transform", "none");
});

test("Operator can change theme and sign out through Settings without Admin access", async ({ page }) => {
  await context(page, "operator");
  await page.goto("/dashboard");
  await expect(page.getByRole("switch", { name: "Light mode" })).toHaveCount(0);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/session$/);
  const settingsNav = page.getByRole("navigation", { name: "Settings categories" });
  await expect(settingsNav.getByRole("link", { name: "Session" })).toBeVisible();
  await expect(settingsNav.getByRole("link", { name: "Attendance" })).toBeVisible();
  await expect(settingsNav.getByRole("link")).toHaveCount(2);
  const toggle = page.getByRole("switch", { name: "Light mode" });
  await toggle.press("Space");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(toggle).toBeChecked();
  let logout = false;
  await page.route("**/auth/logout", route => { logout = true; return route.fulfill({ json: {} }); });
  await page.getByRole("button", { name: "Sign out", exact: true }).press("Enter");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(logout).toBe(true);
});

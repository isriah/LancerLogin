import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences as references } from "../apps/dashboard/src/design-conformance";
import { discovered } from "./release-discovery";

async function context(page: Page) {
  const settings = { organizationName: "Reference Arts Collective", subtitle: "Shared operations", logoData: "", primaryColor: references.brand.primary, secondaryColor: references.brand.secondary, logoBackdrop: "auto", lateScanMinutes: 30 };
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings } }));
  await page.route("**/admin/branding", (route) => route.fulfill({ json: { settings } }));
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: "0.19.0" } }));
  await page.route("**/admin/releases/latest", (route) => route.fulfill({ json: discovered({ tag_name: "v0.19.0" }) }));
}

for (const viewport of references.viewports) {
  for (const theme of references.themes) {
    test(`meeting weights preserve drafts, focus and feedback at ${viewport.width}x${viewport.height} ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript((savedTheme) => {
        localStorage.setItem("lancerlogin-theme", savedTheme);
        localStorage.setItem("lancerlogin-update-dismissed:0.19.0", "true");
      }, theme);
      await context(page);
      await page.route("**/admin/meeting-weight-categories", (route) => route.fulfill({ json: { categories: [
        { id: "standard", name: "Standard", weight: 1, minimumDurationMinutes: 30, position: 0, active: true },
        { id: "extended", name: "Extended", weight: 2, minimumDurationMinutes: 120, position: 1, active: true },
      ] } }));
      let finish: (() => void) | undefined;
      await page.route("**/admin/meeting-weight-categories/standard", async (route) => {
        await new Promise<void>((resolve) => { finish = resolve; });
        await route.fulfill({ status: 503, json: { error: "Weight service unavailable. Try again." } });
      });
      await page.goto("/settings/organization");
      await expect(page.locator(".meeting-weight-settings")).toHaveCount(0);
      await page.goto("/settings/configuration");
      const card = page.locator(".meeting-weight-settings");
      const disclosure = card.locator(".meeting-weight-disclosure");
      const summary = disclosure.locator(":scope > summary");
      await expect(summary).toContainText("2 active");
      await expect(disclosure).not.toHaveAttribute("open");
      await expect(card.getByRole("button", { name: "Add category", exact: true })).toHaveCount(0);
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath("collapsed.png") });
      await summary.focus();
      await expect(summary).toBeFocused();
      await expect(summary).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("open", "");
      const add = card.locator(".meeting-weight-add");
      await page.keyboard.press("Tab");
      await expect(add.getByLabel("Name")).toBeFocused();
      await add.getByLabel("Name").fill("Unsaved category");
      await add.getByLabel("Weight").fill("3.5");
      await add.getByLabel(/Minimum duration/).fill("180");
      const standard = card.locator(".meeting-weight-list > li").first();
      await standard.getByLabel("Name").fill("Standard draft");
      await standard.getByLabel("Weight").fill("1.5");
      await standard.getByLabel(/Minimum duration/).fill("45");
      await expect(standard.getByRole("button", { name: "Move Standard draft up", exact: true })).toBeDisabled();
      await expect(card.getByRole("button", { name: "Move Extended down", exact: true })).toBeDisabled();
      const down = standard.getByRole("button", { name: "Move Standard draft down", exact: true });
      await down.focus();
      await expect(down).toBeFocused();
      await expect(down).toHaveClass("quiet-button");
      for (const height of await card.locator("button:visible, input:visible, summary:visible").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
      await summary.focus();
      await page.keyboard.press("Space");
      await expect(disclosure).not.toHaveAttribute("open");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest(".meeting-weight-content"))).toBeNull();
      await summary.click();
      await expect(add.getByLabel("Name")).toHaveValue("Unsaved category");
      await expect(add.getByLabel("Weight")).toHaveValue("3.5");
      await expect(add.getByLabel(/Minimum duration/)).toHaveValue("180");
      await expect(standard.getByLabel("Name")).toHaveValue("Standard draft");
      await expect(standard.getByLabel("Weight")).toHaveValue("1.5");
      await expect(standard.getByLabel(/Minimum duration/)).toHaveValue("45");
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath("expanded.png"), fullPage: true });
      await standard.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => Boolean(finish)).toBe(true);
      await expect(card.getByRole("button", { name: /Move/ }).first()).toBeDisabled();
      await summary.click();
      await expect(card.getByRole("status").filter({ hasText: "Updating meeting weights" })).toBeVisible();
      finish!();
      await expect(card.getByRole("alert")).toHaveText("Weight service unavailable. Try again.");
      await expect(disclosure).not.toHaveAttribute("open");
      await expect(card.getByRole("button", { name: /Move/ })).toHaveCount(0);
      await summary.click();
      await expect(standard.getByLabel("Name")).toHaveValue("Standard draft");
      await expect(standard.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(card.getByRole("heading", { level: 2, name: "Meeting weights" })).toBeVisible();
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", references.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary", references.brand.secondary);
      const clipped = await card.locator("button:visible, input:visible, summary:visible").evaluateAll((items) => items.filter((item) => {
        const bounds = item.getBoundingClientRect(); return bounds.left < 0 || bounds.right > innerWidth;
      }).map((item) => item.getAttribute("aria-label") || item.tagName));
      expect(clipped).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }
}

test("meeting weights open and close by touch with empty categories", async ({ browser }) => {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await mobile.newPage();
  await context(page);
  await page.route("**/admin/meeting-weight-categories", (route) => route.fulfill({ json: { categories: [] } }));
  await page.goto("/settings/configuration");
  const summary = page.locator(".meeting-weight-disclosure > summary");
  await expect(summary).toContainText("0 active");
  await summary.tap();
  await expect(page.getByText("No weight categories yet. Meetings use the default 1× weight.")).toBeVisible();
  await summary.tap();
  await expect(page.getByRole("button", { name: "Add category", exact: true })).toHaveCount(0);
  await mobile.close();
});

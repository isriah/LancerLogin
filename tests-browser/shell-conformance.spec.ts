import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

async function useReferenceBrand(page: Page) {
  await page.route("**/setup/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      configured: true,
      installation: { authMode: "local" },
      settings: {
        organizationName: "Reference Arts Collective",
        subtitle: "Shared operations",
        logoData: "",
        primaryColor: dashboardConformanceReferences.brand.primary,
        secondaryColor: dashboardConformanceReferences.brand.secondary,
        appearance: "dark",
        logoBackdrop: "auto",
        lateScanMinutes: 30,
      },
    }),
  }));
}

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
    test(`shared shell conforms at ${viewport.width}x${viewport.height} in ${theme} mode with reference branding`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await useReferenceBrand(page);
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);

      const geometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        clipped: Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")).flatMap((element) => {
          const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || bounds.width === 0 || element.closest(".responsive-table,.table-scroll")) return [];
          return bounds.left < -1 || bounds.right > innerWidth + 1 ? [element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName] : [];
        }),
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.clipped).toEqual([]);

      const themeSwitch = page.getByRole("switch", { name: "Dark mode" });
      await themeSwitch.focus();
      await expect(themeSwitch).toBeFocused();
      expect(await themeSwitch.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      expect((await themeSwitch.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    });
  }
}

test("mobile navigation contains keyboard focus, closes with Escape, and returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useReferenceBrand(page);
  await page.goto("/dashboard");
  const opener = page.getByRole("button", { name: "Open navigation" });
  await opener.click();
  const navigation = page.getByRole("navigation", { name: "Primary dashboard navigation" });
  await expect(navigation.getByRole("link", { name: "Dashboard" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(navigation.getByRole("link", { name: "Settings" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(opener).toBeFocused();
});

test("unavailable route has page semantics and a reachable recovery action", async ({ page }) => {
  await useReferenceBrand(page);
  await page.goto("/not-a-dashboard-route");
  await expect(page.locator("main h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "Page unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Return to Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("loading and dialog motion remain understandable with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await useReferenceBrand(page);
  await page.route("**/meetings", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto("/dashboard");
  const overlay = page.locator(".dashboard-loading-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("aria-atomic", "true");
  await expect(overlay).toContainText("Loading dashboard");
  await expect(overlay.locator(".dashboard-loading-indicator")).toHaveCSS("animation-name", "none");
  await expect(overlay).toHaveCount(0);

  const contestButton = page.getByRole("button", { name: /attendance contest.*awaiting review/i });
  await contestButton.click();
  const dialog = page.getByRole("dialog", { name: "Contests awaiting review" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close contest review dialog" })).toBeFocused();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(contestButton).toBeFocused();
});

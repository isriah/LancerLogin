import { expect, test } from "@playwright/test";
import { setDashboardTheme } from "./dashboard-theme";
import { pairedViews } from "./paired-views";

for (const { width, theme } of pairedViews) {
  test(`theme helper waits for delayed settings bootstrap at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/meetings/active-meeting?source=theme-regression");
    await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
    const originalUrl = page.url();
    let delayed = false;
    await page.route("**/setup/status", async route => {
      if (!delayed) {
        delayed = true;
        // Deliberate transport latency: document load must not imply UI readiness.
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await route.continue();
    });
    await setDashboardTheme(page, theme);
    expect(delayed).toBe(true);
    await expect(page).toHaveURL(originalUrl);
    await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
    await page.reload();
    await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
  });
}

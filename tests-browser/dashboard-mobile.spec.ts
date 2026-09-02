import { expect, test } from "@playwright/test";

const mobileViewports = [
  { name: "compact phone", width: 375, height: 667 },
  { name: "modern phone", width: 390, height: 844 },
];

const routes = [
  "/dashboard",
  "/meetings",
  "/attendance",
  "/reports",
  "/roster",
  "/kiosks",
  "/settings/organization",
  "/settings/configuration",
  "/settings/access",
  "/settings/integrations",
  "/settings/privacy",
  "/settings/data",
  "/settings/updates",
];

for (const viewport of mobileViewports) {
  test(`dashboard routes fit ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);

    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(dimensions.scrollWidth, route).toBeLessThanOrEqual(dimensions.clientWidth);
    }
  });

  test(`roster dialog fits ${viewport.name} without clipped controls`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/roster");
    await page.getByRole("button", { name: "Add member" }).click();
    const dialog = page.getByRole("dialog", { name: "Add roster member" });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  });
}

test("mobile controls retain a 44px touch target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/attendance");
  const controls = await page.locator(".dashboard-shell button, .dashboard-shell input, .dashboard-shell select").evaluateAll((elements) =>
    elements.filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    }).map((element) => ({
      label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
      height: element.getBoundingClientRect().height,
    })),
  );
  for (const control of controls) expect(control.height, control.label).toBeGreaterThanOrEqual(44);
});

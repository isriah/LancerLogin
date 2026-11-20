import { expect, test } from "@playwright/test";
import { expectKioskScreenFits, kioskScenarios, kioskViewports, mockKioskApi } from "./web-kiosk-fixtures";

// The web kiosk's main screens on phones (portrait and on their side) and a tablet: pairing, the settings PIN, member ID
// entry, member search, confirm, the member PIN pad, the Discord code, a refusal notice, maintenance and the error
// screen. Each must fit its viewport: see expectKioskScreenFits.

// The kiosk's own service worker would answer page loads from its cache; these checks need every request mocked here.
test.use({ serviceWorkers: "block" });

for (const viewport of kioskViewports) for (const scenario of kioskScenarios) {
  test(`web kiosk at ${viewport.width}x${viewport.height} (${viewport.name}): ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockKioskApi(page, scenario.options);
    const seen: string[] = [];
    await scenario.run(page, async (name) => { seen.push(name); await test.step(name, () => expectKioskScreenFits(page)); });
    expect(seen.length).toBeGreaterThan(0);
  });
}

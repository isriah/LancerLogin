import { expect, test, type Page } from "@playwright/test";

const base = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";
test.use({ viewport: { width: 800, height: 480 }, hasTouch: true });

async function maintenance(page: Page) {
  await page.route(`${base}/maintenance/session`, route => route.fulfill({ json: { configured: true, authorized: true } }));
  await page.route(`${base}/maintenance/members`, route => route.fulfill({ json: { members: [] } }));
  await page.route(`${base}/mappings`, route => route.fulfill({ json: { mappings: {} } }));
  await page.route(`${base}/sensor/test`, route => route.fulfill({ json: { readerOnline: true, templateCount: 0 } }));
  await page.route(`${base}/sensor/slots`, route => route.fulfill({ json: { occupiedSlots: [] } }));
  await page.goto(`${base}/maintenance`);
  await expect(page.locator("#workspace")).toBeVisible();
  await page.getByRole("button", { name: "Fingerprint sync", exact: true }).click();
}

test("independent fingerprint diagnostics survive unavailable sharing settings and preserve touch controls", async ({ page }) => {
  await page.route(`${base}/fingerprint-sync`, route => route.fulfill({ status: 503, json: { error: "Fingerprint sync is unavailable. Maintenance remains unlocked." } }));
  await page.route(`${base}/fingerprint-diagnostics`, route => route.fulfill({ json: {
    reset: { state: "blocked", reasonCode: "local_state_review" },
    peer: { state: "blocked", reasonCode: "reset_recovery", missingIdentityMappings: 1 },
    vault: { state: "ready", reasonCode: "ready", missingIdentityMappings: 2, unshareableMappings: 2,
      lastSuccessAt: "2026-01-01T00:00:00.000Z", error: "synthetic-secret-must-not-render" },
  } }));
  await maintenance(page);
  const diagnostics = page.getByRole("region", { name: "Fingerprint sync health" });
  await expect(diagnostics).toContainText("Protected fingerprint state needs local review");
  await expect(diagnostics).toContainText("1 enrollment(s) need fresh enrollment");
  await expect(diagnostics).toContainText("2 mapping(s) are not eligible for cloud upload");
  await expect(diagnostics).not.toContainText("2 enrollment(s) need fresh enrollment");
  await expect(diagnostics).toContainText("This does not confirm every fingerprint was delivered");
  await expect(diagnostics).not.toContainText("synthetic-secret-must-not-render");
  await expect(page.locator("#unlock")).toBeHidden();
  await expect(page.locator("#toggle-sync")).toBeDisabled();
  const close = page.locator("#close-sync"), box = await close.boundingBox();
  expect(box).not.toBeNull(); expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator("#fingerprint-sync-sheet")).toBeHidden();
});

test("diagnostic outage does not remove local offline disablement or claim ready health", async ({ page }) => {
  let enabled = true;
  await page.route(`${base}/fingerprint-sync`, async route => {
    if (route.request().method() === "PATCH") { expect(route.request().postDataJSON()).toEqual({ enabled: false }); enabled = false; }
    await route.fulfill({ json: { installationEnabled: false, offline: true, enabled, peers: [], candidates: [], fingerprint: "a".repeat(64) } });
  });
  await page.route(`${base}/fingerprint-diagnostics`, route => route.fulfill({ status: 503, json: { error: "synthetic-secret-must-not-render" } }));
  await maintenance(page);
  await expect(page.locator("#sync-diagnostics")).toContainText("Fingerprint sync could not be verified");
  await expect(page.locator("#sync-diagnostics")).not.toContainText("synthetic-secret-must-not-render");
  await expect(page.locator("#toggle-sync")).toBeEnabled();
  await page.locator("#toggle-sync").click();
  await page.locator("#accept-action").click();
  await expect(page.locator("#toggle-sync")).toBeDisabled();
  expect(enabled).toBe(false);
});

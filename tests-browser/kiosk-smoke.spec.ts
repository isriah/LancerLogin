import { expect, test } from "@playwright/test";

const kioskBaseUrl = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";

test("physical kiosk screen fits the supported 800 by 480 display", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
  await expect(page.getByText("Example Arts Club")).toBeVisible();
  await expect(page.getByText("LancerLogin 0.17.0")).toBeVisible();
  await expect(page.getByText("No scans waiting")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });
});

test("browser kiosk emulator keeps the shared display surface within 800 by 480", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto("/simulator");
  await expect(page.getByText("SIMULATED · BROWSER INPUT")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
  await expect(page.getByText("Not a physical kiosk")).toBeVisible();
  const bounds = await page.locator(".simulator-kiosk").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(800);
  expect(bounds!.height).toBeLessThanOrEqual(480);
});

test("fingerprint maintenance unlock fits the supported 800 by 480 display", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto(`${kioskBaseUrl}/maintenance`);
  await expect(page.getByText("Unlock maintenance")).toBeVisible();
  await expect(page.getByLabel("PIN keypad")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Example Arts Club fingerprints" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Reader" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Enroll fingerprint" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Mappings" })).toBeHidden();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });
});

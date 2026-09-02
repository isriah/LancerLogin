import { expect, test } from "@playwright/test";

test("physical kiosk screen fits the supported 800 by 480 display", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto("http://127.0.0.1:8792/");
  await expect(page.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
  await expect(page.getByText("Example Arts Club")).toBeVisible();
  await expect(page.getByText("Fingerprint reader online")).toBeVisible();
  await expect(page.getByText("No scans waiting")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });
});

test("fingerprint maintenance unlock fits the supported 800 by 480 display", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto("http://127.0.0.1:8792/maintenance");
  await expect(page.getByText("Unlock maintenance")).toBeVisible();
  await expect(page.getByLabel("PIN keypad")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Example Arts Club fingerprints" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Reader" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Enroll fingerprint" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Mappings" })).toBeHidden();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });
});

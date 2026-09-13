import { expect, test } from "@playwright/test";
import { kioskDisplayForQueuedScan } from "../apps/kiosk/src/kiosk-presentation.mjs";

const kioskBaseUrl = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`queued kiosk Welcome and Goodbye retain exact copy and cues with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 800, height: 480 });
    let pending: { memberId: string }[] = [];
    await page.route(`${kioskBaseUrl}/display-state`, async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      await route.fulfill({ response, json: { ...state, cloudOnline: false, pendingEvents: pending.length + 1, display: kioskDisplayForQueuedScan("synthetic-member", pending) } });
    });
    await page.goto(`${kioskBaseUrl}/`);
    const shell = page.locator("#kiosk"); const network = page.locator("#network-status");
    for (const headline of ["Welcome", "Goodbye"]) {
      if (headline === "Goodbye") pending = [{ memberId: "synthetic-member" }];
      await expect(page.getByRole("heading", { name: headline, exact: true })).toBeVisible();
      await expect(page.locator("#display-detail")).toHaveText(`Saved for sync | ${headline}`);
      await expect(shell).toHaveClass(new RegExp(`kiosk-shell-${headline.toLowerCase()}`));
      await expect(network).toHaveClass(/offline/);
      expect(await shell.evaluate((element) => getComputedStyle(element).animationName)).toBe(reducedMotion === "reduce" ? "none" : "success-pulse");
      expect(await network.evaluate((element) => getComputedStyle(element).animationName)).toBe(reducedMotion === "reduce" ? "none" : "network-offline-pulse");
      if (reducedMotion === "reduce") expect(await shell.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
      const detail = await page.locator("#display-detail").boundingBox();
      expect(detail).not.toBeNull();
      expect(detail!.x).toBeGreaterThanOrEqual(0);
      expect(detail!.x + detail!.width).toBeLessThanOrEqual(800);
      expect(detail!.y + detail!.height).toBeLessThanOrEqual(480);
      expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width: 800, height: 480 });
    }
  });
}

test("physical kiosk screen fits the supported 800 by 480 display", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
  await expect(page.getByText("Example Arts Club")).toBeVisible();
  await expect(page.getByText("LancerLogin 1.0.2")).toBeVisible();
  await expect(page.getByText("No scans waiting")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });
});

test("physical kiosk gives bounded scan and offline feedback at 800 by 480", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "processing" });
  await page.goto(`${kioskBaseUrl}/`);
  const shell = page.locator("#kiosk");
  const network = page.locator("#network-status");

  await expect(page.getByRole("heading", { name: "Checking scan" })).toBeVisible();
  await expect(shell).toHaveClass(/kiosk-shell-processing/);
  expect(await shell.evaluate((element) => getComputedStyle(element, "::before").animationName)).toBe("processing-sweep");
  expect(await page.locator(":root").evaluate((element) => [getComputedStyle(element).getPropertyValue("--primary").trim(), getComputedStyle(element).getPropertyValue("--secondary").trim()])).toEqual(["#8b2f72", "#2f8b72"]);

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "duplicate" });
  await expect(page.getByRole("heading", { name: "Already recorded" })).toBeVisible();
  await expect(page.getByText("Attendance was not changed")).toBeVisible();
  expect(await shell.evaluate((element) => getComputedStyle(element).animationName)).toBe("duplicate-flash");

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "offline", "x-lancerlogin-preview-cloud": "offline" });
  await expect(page.getByRole("heading", { name: "Saved for sync" })).toBeVisible();
  await expect(page.getByText("This scan is stored on the kiosk and will sync automatically")).toBeVisible();
  expect(await shell.evaluate((element) => getComputedStyle(element).animationName)).toBe("success-pulse");
  await expect(network).toHaveClass(/offline/);
  expect(await network.evaluate((element) => getComputedStyle(element).animationName)).toBe("network-offline-pulse");

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "unknown", "x-lancerlogin-preview-cloud": "offline" });
  await expect(page.getByRole("heading", { name: "Fingerprint not recognized" })).toBeVisible();
  expect(await shell.evaluate((element) => getComputedStyle(element).animationName)).toBe("failure-flash");

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "rejected", "x-lancerlogin-preview-cloud": "offline" });
  await expect(page.getByRole("heading", { name: "Scan needs help" })).toBeVisible();
  await expect(page.getByText("No meeting is accepting attendance scans at this time")).toBeVisible();
  expect(await shell.evaluate((element) => getComputedStyle(element).animationName)).toBe("failure-flash");

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "ready" });
  await expect(page.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
  await expect(network).toHaveClass(/online/);
  expect(await network.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });
});

test("physical kiosk replaces motion with persistent state cues", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 800, height: 480 });
  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "processing", "x-lancerlogin-preview-cloud": "offline" });
  await page.goto(`${kioskBaseUrl}/`);
  const shell = page.locator("#kiosk");
  const network = page.locator("#network-status");

  await expect(page.getByRole("heading", { name: "Checking scan" })).toBeVisible();
  expect(await shell.evaluate((element) => getComputedStyle(element, "::before").animationName)).toBe("none");
  expect(await shell.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  expect(await network.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "duplicate", "x-lancerlogin-preview-cloud": "offline" });
  await expect(page.getByRole("heading", { name: "Already recorded" })).toBeVisible();
  expect(await shell.evaluate((element) => ({ animation: getComputedStyle(element).animationName, fallback: getComputedStyle(element).boxShadow }))).toEqual(expect.objectContaining({ animation: "none" }));
  expect(await shell.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
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

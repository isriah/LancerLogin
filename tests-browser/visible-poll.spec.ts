import { expect, test } from "@playwright/test";

test("dashboard polling pauses while hidden and refreshes on return", async ({ page }) => {
  let requests = 0;
  await page.route("**/meetings", async (route) => { requests++; await route.continue(); });
  await page.clock.install();
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect.poll(() => requests).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = requests;
  await page.clock.runFor(180_000);
  expect(requests).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => requests).toBe(before + 1);
});

test("background refreshes do not overlap slow requests", async ({ page }) => {
  let requests = 0;
  let blockNext = false;
  let release: (() => void) | undefined;
  await page.route("**/meetings", async (route) => {
    requests++;
    if (blockNext) { blockNext = false; await new Promise<void>((resolve) => { release = resolve; }); }
    await route.continue();
  });
  await page.clock.install();
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.getByText("5 of 5 shown")).toBeVisible();
  const before = requests;
  blockNext = true;
  await page.clock.runFor(61_000);
  await expect.poll(() => requests).toBe(before + 1);
  await page.clock.runFor(180_000);
  expect(requests).toBe(before + 1);
  release!();
});

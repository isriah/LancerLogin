import { expect, test } from "@playwright/test";

const base = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";
test.use({ hasTouch: true, viewport: { width: 800, height: 480 } });

for (const action of ["confirm", "decline", "cancel", "expired"] as const) test(`dashboard enrollment ${action} preserves the narrow maintenance boundary`, async ({ page }) => {
  const id = "synthetic-session";
  let posts = 0, cancelled = 0, memberSelected = action !== "cancel", protectedReads = 0;
  let progress = memberSelected ? "awaiting_confirmation" : "waiting_member";
  await page.route("**/maintenance/session", async route => { protectedReads++; await route.fulfill({ json: { configured: true, authorized: false } }); });
  await page.route(`**/maintenance/enrollment/${id}**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/confirm")) { posts++; progress = "enroll_success"; }
    if (path.endsWith("/cancel")) { cancelled++; progress = "cancelled"; }
    await route.fulfill({ json: { session: { id, state: memberSelected ? "ready" : "waiting_member", progress,
      ...(memberSelected ? { member: { memberId: "synthetic-member", rosterId: "synthetic-row", firstName: "Sample", lastName: "Member" } } : {}), busy: false } } });
  });
  await page.goto(`${base}/maintenance?enrollment=${id}`);
  await expect(page.getByRole("heading", { name: "Dashboard enrollment" })).toBeVisible();
  await expect(page.locator("#unlock")).toBeHidden();
  await expect(page.locator("#maintenance-tabs")).toBeHidden();
  await expect(page.locator("#begin-enroll")).toBeHidden();
  await expect(page.locator("#test-reader")).toBeHidden();
  await expect(page.locator("#open-fingerprint-sync")).toBeHidden();
  expect(protectedReads).toBe(0);
  const readerWidth = await page.locator(".reader-card").evaluate(element => element.getBoundingClientRect().width);
  expect(readerWidth).toBeCloseTo((800 - 16 - 16) * .95 / 3.35, 0);
  expect(await page.locator("#dashboard-enrollment-card").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(500);
  if (action === "cancel") {
    await expect(page.getByText("Waiting for a dashboard selection", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel enrollment", exact: true }).tap();
  } else {
    await expect(page.locator("#confirm-title")).toHaveText("Is this you?");
    await expect(page.locator("#confirm-sheet")).toContainText("Sample Member");
    expect(posts).toBe(0);
    if (action === "expired") {
      progress = "expired";
      await expect(page.locator("#confirm-sheet")).toBeHidden();
      await expect(page.locator("#stage-title")).toHaveText("Enrollment expired");
    } else await page.locator(action === "confirm" ? "#accept-action" : "#cancel-action").tap();
  }
  if (action === "confirm") {
    await expect.poll(() => posts).toBe(1);
    await expect(page.locator("#stage-title")).toHaveText("Enrollment saved");
    await expect(page.locator("#confirm-sheet")).toBeHidden();
  } else if (action !== "expired") await expect.poll(() => cancelled).toBe(1);
  expect(posts).toBe(action === "confirm" ? 1 : 0);
  expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width: 800, height: 480 });
  await page.screenshot({ path: test.info().outputPath(`dashboard-enrollment-${action}.png`) });
});

for (const start of ["/", "/maintenance"]) test(`dashboard enrollment opens from ${start} without unlocking maintenance`, async ({ page }) => {
  await page.route("**/display-state", route => route.fulfill({ json: { enrollment: { id: "synthetic-session" }, display: { id: "ready" }, branding: {} } }));
  await page.route("**/network/session", route => route.fulfill({ json: { authorized: false } }));
  await page.route("**/maintenance/enrollment/synthetic-session", route => route.fulfill({ json: { session: { id: "synthetic-session", progress: "waiting_member", state: "waiting_member" } } }));
  await page.goto(`${base}${start}`);
  await expect(page).toHaveURL(`${base}/maintenance?enrollment=synthetic-session`);
  await expect(page.getByRole("heading", { name: "Dashboard enrollment" })).toBeVisible();
  await expect(page.locator("#unlock")).toBeHidden();
  await expect(page.locator("#open-fingerprint-sync")).toBeHidden();
});

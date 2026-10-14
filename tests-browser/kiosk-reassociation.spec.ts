import { expect, test, type Page, type Locator } from "@playwright/test";

const base = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";
test.use({ hasTouch: true });

async function fixture(page: Page, options: { pending?: number; recovery?: boolean; unavailableRoster?: boolean; method?: string } = {}) {
  let authorized = false, posts = 0, unpaired = false, pending = options.pending ?? 0;
  await page.route(`${base}/maintenance/session`, route => route.fulfill({ json: { configured: true, authorized } }));
  await page.route(`${base}/network/unlock`, route => { authorized = true; return route.fulfill({ json: { authorized: true } }); });
  await page.route(`${base}/display-state`, route => route.fulfill({ json: { branding: { organizationName: "Example Arts Club", primaryColor: "#8b2f72", secondaryColor: "#2f8b72" }, authenticationMethod: options.method ?? "member_id", display: { id: "ready" } } }));
  await page.route(`${base}/maintenance/members`, route => route.fulfill(options.unavailableRoster ? { status: 503, json: { error: "Roster unavailable until first sync" } } : { json: { members: [] } }));
  await page.route(`${base}/mappings`, route => route.fulfill({ json: { mappings: {} } }));
  await page.route(`${base}/credential-mappings`, route => route.fulfill({ json: { mappings: [] } }));
  await page.route(`${base}/sensor/slots`, route => route.fulfill({ json: { occupiedSlots: [] } }));
  await page.route(`${base}/maintenance/pairing`, route => route.fulfill({ json: { paired: !options.recovery, kioskName: "Main kiosk", installation: "https://example-installation.test", pendingEvents: pending, recoveryPending: Boolean(options.recovery), busy: false } }));
  await page.route(`${base}/maintenance/unpair`, route => {
    posts += 1; expect(route.request().postDataJSON()).toEqual({ confirmation: "UNPAIR" });
    unpaired = true; return route.fulfill({ json: { unpaired: true, restart: true } });
  });
  await page.route(`${base}/health`, route => route.fulfill({ json: { ok: true, paired: !unpaired, setupReady: unpaired } }));
  await page.goto(`${base}/maintenance`);
  await expect(page.locator("#unlock")).toBeVisible();
  return { posts: () => posts, expire: () => { authorized = false; }, clearPending: () => { pending = 0; } };
}

async function tap(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox(); expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

async function unlock(page: Page) {
  await page.locator("#pin").evaluate((input: HTMLInputElement) => { input.value = "123456"; });
  const button = page.getByRole("button", { name: "Unlock for five minutes" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await button.boundingBox();
    if (box && box.y + box.height <= page.viewportSize()!.height - 8) break;
    const card = await page.locator("#unlock").boundingBox();
    const x = card!.x + card!.width - 20;
    const bottom = Math.min(card!.y + card!.height, page.viewportSize()!.height) - 25;
    const top = Math.max(card!.y, 0) + 25;
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: bottom, id: 1 }] });
    for (let step = 1; step <= 10; step += 1) { await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: bottom + (top - bottom) * step / 10, id: 1 }] }); await page.waitForTimeout(20); }
    await page.waitForTimeout(200);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach(); await page.waitForTimeout(200);
  }
  await tap(page, button);
  await expect(page.locator("#maintenance-header")).toBeVisible();
}

for (const height of [360, 480, 600]) {
  test(`unpair confirmation is touch-sized, cancellable and returns to setup at ${height}px`, async ({ page }) => {
    await page.setViewportSize({ width: height === 600 ? 1024 : 800, height });
    const state = await fixture(page); await unlock(page);
    await tap(page, page.locator("#unpair-kiosk"));
    await expect(page.getByRole("heading", { name: "Unpair this kiosk?" })).toBeVisible();
    await expect(page.locator("#confirm-detail")).toContainText("Reader fingerprints, Wi-Fi and your local PIN stay unchanged");
    await expect(page.locator("#accept-action")).toBeDisabled();
    if (height === 480) await page.screenshot({ path: test.info().outputPath("unpair-confirmation.png") });
    await tap(page, page.locator("#cancel-action")); expect(state.posts()).toBe(0);
    await expect(page.locator("#unpair-kiosk")).toBeFocused();
    await tap(page, page.locator("#unpair-kiosk"));
    await tap(page, page.locator("#confirm-ack"));
    await expect(page.locator("#accept-action")).toBeEnabled();
    await tap(page, page.locator("#accept-action"));
    await expect(page).toHaveURL(`${base}/`); expect(state.posts()).toBe(1);
  });
}

test("pending scans block unpairing until cleared without presenting a destructive action", async ({ page }) => {
  const state = await fixture(page, { pending: 3 }); await unlock(page);
  await tap(page, page.locator("#unpair-kiosk"));
  await expect(page.locator("#message")).toContainText("3 saved attendance scans are pending");
  await expect(page.locator("#confirm-sheet")).toBeHidden(); expect(state.posts()).toBe(0);
  state.clearPending(); await tap(page, page.locator("#unpair-kiosk"));
  await expect(page.locator("#confirm-sheet")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.locator("#confirm-sheet")).toBeHidden();
  await expect(page.locator("#unpair-kiosk")).toBeFocused();
  expect(state.posts()).toBe(0);
});

test("local PIN expiry cancels an open unpair confirmation", async ({ page }) => {
  const state = await fixture(page); await unlock(page);
  await tap(page, page.locator("#unpair-kiosk"));
  state.expire(); await expect(page.locator("#confirm-sheet")).toBeHidden();
  await expect(page.locator("#maintenance-header")).toBeHidden(); expect(state.posts()).toBe(0);
});

for (const method of ["fingerprint", "member_id", "nfc"]) {
  test(`unpair stays available with an unavailable roster in ${method} mode`, async ({ page }) => {
    const state = await fixture(page, { unavailableRoster: true, method }); await unlock(page);
    await tap(page, page.locator("#unpair-kiosk"));
    await expect(page.locator("#confirm-sheet")).toBeVisible(); expect(state.posts()).toBe(0);
  });
}

test("recovery confirmation includes acknowledgement in its keyboard focus trap", async ({ page }) => {
  const state = await fixture(page, { recovery: true, unavailableRoster: true }); await unlock(page);
  await tap(page, page.locator("#unpair-kiosk"));
  await expect(page.getByRole("heading", { name: "Finish unpairing?" })).toBeVisible();
  await expect(page.locator("#cancel-action")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.locator("#confirm-ack input")).toBeFocused();
  await page.keyboard.press("Space"); await page.keyboard.press("Tab");
  await expect(page.locator("#cancel-action")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.locator("#accept-action")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.locator("#confirm-ack input")).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(page.locator("#accept-action")).toBeFocused();
  await page.keyboard.press("Escape"); expect(state.posts()).toBe(0);
});

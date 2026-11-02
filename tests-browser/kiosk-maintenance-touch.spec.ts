import { expect, test } from "@playwright/test";
import { base, fixture, pin, reachable, tap } from "./kiosk-maintenance-touch-fixtures";

test.use({ hasTouch: true });
test.setTimeout(120_000);

test("cloud sync sheet supports touch, focus containment and session expiration", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const mock = await fixture(page);
  await page.route(`${base}/fingerprint-diagnostics`, route => route.fulfill({ json: { reset: { reasonCode: "ready" }, vault: { reasonCode: "ready" } } }));
  await page.goto(`${base}/maintenance`); await pin(page);
  const open = page.getByRole("button", { name: "Fingerprint sync", exact: true });
  await tap(page, open);
  await expect(page.locator("#close-sync")).toBeFocused();
  await expect(page.locator("#refresh-sync")).toBeEnabled();
  await page.keyboard.press("Shift+Tab"); await expect(page.locator("#refresh-sync")).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.locator("#close-sync")).toBeFocused();
  await page.keyboard.press("Escape"); await expect(open).toBeFocused();
  await tap(page, open);
  await expect(page.locator("#fingerprint-sync-sheet")).toBeVisible();
  mock.expire(); await expect(page.locator("#fingerprint-sync-sheet")).toBeHidden();
  await expect(page.locator("#unlock")).toBeVisible();
});

test("suggested slot skips sensor fingerprints missing from local mappings", async ({ page }) => {
  await page.setViewportSize({width:1280,height:800});
  const mock=await fixture(page,{sensorOnlySlots:[60,61,62]});
  await page.goto(`${base}/maintenance`);
  await pin(page);
  await expect(page.locator('#slot')).toHaveValue('63');
  await expect(page.locator('#slot-help')).toHaveText('Suggested next open slot: 63');
  await expect(page.locator('#begin-enroll')).toBeEnabled();
  expect(mock.enrolled).toHaveLength(0);
});

test("unreadable sensor occupancy disables enrollment instead of suggesting slot zero", async ({ page }) => {
  await page.setViewportSize({width:1280,height:800});
  const mock=await fixture(page,{failSlotRead:true});
  await page.goto(`${base}/maintenance`);
  await pin(page);
  await expect(page.locator('#slot')).toHaveValue('');
  await expect(page.locator('#slot-help')).toContainText('Cannot verify empty slots');
  await expect(page.locator('#begin-enroll')).toBeDisabled();
  expect(mock.enrolled).toHaveLength(0);
});

for (const origin of ["row", "blank"] as const) test(`roster swipes from ${origin} also scroll when the display reports mouse input`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await fixture(page); await page.goto(`${base}/maintenance`); await pin(page);
  await tap(page, page.locator("#member-picker"));
  await tap(page, page.locator("#toggle-search-keyboard"));
  const list = page.locator("#member-options");
  const drag = async (down = false) => {
    const points = await list.evaluate((e, { origin, down }) => {
      const r = e.getBoundingClientRect();
      const rows = [...e.querySelectorAll("button")].map(b => b.getBoundingClientRect()).filter(b => b.top >= r.top && b.bottom <= r.bottom);
      const row = down ? rows[0] : rows[rows.length - 1];
      const x = origin === "blank" ? r.left + e.clientLeft + e.clientWidth - 10 : r.left + 100;
      const y = origin === "row" ? row.top + row.height / 2 : down ? r.top + 20 : r.bottom - 20;
      const hit = document.elementFromPoint(x, y);
      if (origin === "row" ? !hit?.closest("button") : hit !== e) throw new Error("Drag must start in the intended list area");
      return { x, y, end: down ? r.bottom - 20 : r.top + 20 };
    }, { origin, down });
    await page.mouse.move(points.x, points.y); await page.mouse.down();
    await page.mouse.move(points.x, points.end, { steps: 12 }); await page.mouse.up();
  };
  await drag();
  const position = await list.evaluate(e => e.scrollTop);
  expect(position).toBeGreaterThan(40);
  await expect(page.locator("#member-sheet")).toBeVisible();
  await expect(page.locator("#member")).toHaveValue("");
  await drag(true);
  expect(await list.evaluate(e => e.scrollTop)).toBeLessThan(position);
  for (let attempt = 0; attempt < 3 && await list.evaluate(e => e.scrollTop) > 0; attempt++) await drag(true);
  expect(await list.evaluate(e => e.scrollTop)).toBe(0);
  await expect(page.locator("#member")).toHaveValue("");
  await page.locator("#member-options").getByRole("button", { name: /Member 0 ·/ }).click();
  await expect(page.locator("#member")).toHaveValue("synthetic-0");
});

for (const height of [480, 360]) {
  test(`QWERTY rows and the complete roster scroll by touch at 800x${height}`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height });
    const mock = await fixture(page);
    await page.goto(`${base}/maintenance`);
    await pin(page);
    await tap(page, page.locator("#member-picker"));
    const keyboard = page.locator("#search-keyboard");
    for (const letters of ["qwertyuiop", "asdfghjkl", "zxcvbnm"]) {
      const boxes = await Promise.all([...letters].map((key) => keyboard.getByRole("button", { name: key, exact: true }).boundingBox()));
      for (let index = 0; index < boxes.length; index++) {
        expect(boxes[index]!.width).toBeGreaterThanOrEqual(48);
        expect(boxes[index]!.height).toBeGreaterThanOrEqual(48);
        expect(boxes[index]!.y).toBe(boxes[0]!.y);
        if (index) expect(boxes[index]!.x).toBeGreaterThan(boxes[index - 1]!.x);
      }
    }
    expect(await page.locator(".member-heading button").evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth))).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`qwerty-${height}.png`) });
    await tap(page, page.locator("#toggle-search-keyboard"));
    await expect(keyboard).toBeHidden();
    await expect(page.locator("#toggle-search-keyboard")).toHaveAttribute("aria-expanded", "false");
    expect(await page.locator(".member-heading button").evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth))).toBe(true);
    const list = page.locator("#member-options");
    expect((await list.boundingBox())!.width).toBeGreaterThan(700);
    await expect(list.locator("button")).toHaveCount(80);
    await reachable(page, list.getByRole("button", { name: /Member 79/ }), list, "up", "row");
    await expect(page.locator("#member-sheet")).toBeVisible();
    await expect(page.locator("#member")).toHaveValue("");
    expect(mock.enrolled).toHaveLength(0);
    await reachable(page, list.getByRole("button", { name: /Member 0 ·/ }), list, "down", "blank");
    await expect(page.locator("#member")).toHaveValue("");
    await page.screenshot({ path: test.info().outputPath(`full-roster-${height}.png`) });
    await tap(page, list.getByRole("button", { name: /Member 0 ·/ }));
    await expect(page.locator("#member")).toHaveValue("synthetic-0");
    await tap(page, page.locator("#member-picker"));
    await tap(page, page.locator("#member-search"));
    await expect(keyboard).toBeVisible();
    await expect(page.locator("#toggle-search-keyboard")).toHaveAttribute("aria-expanded", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  });
}

test("maintenance PIN failure and lockout expose only unlock controls", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 360 });
  const mock = await fixture(page);
  await page.goto(`${base}/maintenance`);
  for (let index = 0; index < 5; index++) {
    // Existing PIN value retained on rejected submission; clear through touch backspace.
    if (index) for (let digit = 0; digit < 6; digit++) await tap(page, page.locator("#pin-keypad").getByRole("button", { name: "Backspace" }));
    await pin(page, "000000");
    await expect(page.locator("#message")).toContainText(index === 4 ? "Too many attempts" : "PIN is incorrect");
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator(".sheet:visible")).toHaveCount(0);
  }
  expect(mock.attempts()).toBe(5);
  await tap(page, page.locator("#locked-return"));
  await expect(page).toHaveURL(`${base}/`);
});

for (const surface of ["search", "confirmation"]) test(`expired maintenance hides protected ${surface} controls`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const mock = await fixture(page);
  await page.goto(`${base}/maintenance`); await pin(page);
  await tap(page, page.locator("#member-picker"));
  await tap(page, page.locator("#search-keyboard").getByRole("button", { name: "a", exact: true }));
  if (surface === "confirmation") {
    await tap(page, page.locator("#search-keyboard").getByRole("button", { name: "Clear", exact: true }));
    await tap(page, page.locator("#member-options button").first());
    await reachable(page, page.locator("#begin-enroll"), page.locator(".enroll-card"));
    await tap(page, page.locator("#begin-enroll"));
    await expect(page.locator("#confirm-sheet")).toBeVisible();
  }
  mock.expire();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator(".sheet:visible")).toHaveCount(0);
  await expect(page.locator("#member-options button")).toHaveCount(0);
  await expect(page.locator("#mappings tr")).toHaveCount(0);
  await expect(page.locator("#member-search")).toHaveValue("");
  await expect(page.locator("#unlock")).toBeVisible();
  expect(mock.enrolled).toHaveLength(0);
});

test("credential maintenance clears raw input after failure and session expiry", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const mock = await fixture(page, { authenticationMethod: "rfid", rejectCredential: true });
  await page.goto(`${base}/maintenance`); await pin(page);
  await expect(page.locator("#credential-enroll-card")).toBeVisible();
  await tap(page, page.locator("#credential-member-picker"));
  await tap(page, page.locator("#member-options button").first());
  const credential = page.locator("#credential-value");
  const label = page.locator("#credential-label");
  await label.fill("Loaner badge");
  await credential.fill(crypto.randomUUID());
  const register = page.locator("#credential-form").getByRole("button", { name: "Register credential" });
  await reachable(page, register, page.locator("#credential-enroll-card"));
  await tap(page, register);
  await expect.poll(() => mock.credentialAttempts.length).toBe(1);
  await expect(credential).toHaveValue("");
  await label.fill("Abandoned badge");
  await credential.fill(crypto.randomUUID());
  mock.expire();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(credential).toHaveValue("");
  await expect(label).toHaveValue("");
  mock.resume();
  await pin(page);
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(credential).toHaveValue("");
  await expect(label).toHaveValue("");
});


test("unconfigured maintenance offers touch return without exposing tools", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 360 });
  await page.route(`${base}/maintenance/session`, (route) => route.fulfill({ json: { configured: false, authorized: false } }));
  await page.goto(`${base}/maintenance`);
  await expect(page.locator("#message")).toContainText("Create a local settings PIN");
  await expect(page.locator("#workspace")).toBeHidden();
  await tap(page, page.locator("#locked-return"));
  await expect(page).toHaveURL(`${base}/`);
});


test("reader tests automatically after unlock despite roster outage", async ({ page }) => {
  const mock = await fixture(page, { failRoster: true });
  await page.goto(`${base}/maintenance`);
  expect(mock.readerTests()).toBe(0);
  await pin(page);
  await expect(page.locator("#reader-status")).toContainText("Reader online");
  expect(mock.readerTests()).toBe(1);
  await expect(page.locator("#message")).toContainText("Roster unavailable");
  await page.locator("#test-reader").click();
  await expect.poll(mock.readerTests).toBe(2);
});

for (const failRefresh of [false, true]) test(`successful enrollment clears selection before refresh failure ${failRefresh}`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const mock = await fixture(page, { failRefresh });
  await page.goto(`${base}/maintenance`); await pin(page);
  await page.locator("#member-picker").click();
  await page.locator("#member-search").fill("member 79");
  await page.locator("#member-options button").click();
  await page.locator("#begin-enroll").click();
  const box = await page.locator(".confirmation-panel").boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(700);
  expect(Math.abs(box!.x + box!.width / 2 - 400)).toBeLessThan(2);
  expect(Math.abs(box!.y + box!.height / 2 - 240)).toBeLessThan(2);
  expect((await page.locator("#accept-action").boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await page.screenshot({ path: test.info().outputPath("enrollment-confirmation.png") });
  await page.locator("#accept-action").click();
  await expect.poll(() => mock.enrolled.length).toBe(1);
  await expect(page.locator("#member")).toHaveValue("");
  await expect(page.locator("#member-search")).toHaveValue("");
  await expect(page.locator("#member-picker")).toHaveText("Choose a member");
  await expect(page.locator("#replace")).not.toBeChecked();
  expect(mock.enrolled[0]).not.toHaveProperty("finger");
  await expect(page.locator("#finger-picker")).toHaveCount(0);
  await expect(page.locator(".mappings-card th").filter({ hasText: /^Finger$/ })).toHaveCount(0);
  if (failRefresh) await expect(page.locator("#begin-enroll")).toBeDisabled();
});

test("failed enrollment retains selected member and search for retry", async ({ page }) => {
  await fixture(page, { rejectEnrollment: true });
  await page.goto(`${base}/maintenance`); await pin(page);
  await page.locator("#member-picker").click();
  await page.locator("#member-search").fill("member 79");
  await page.locator("#member-options button").click();
  await page.locator("#begin-enroll").click(); await page.locator("#accept-action").click();
  await expect(page.locator("#message")).toContainText("Retry enrollment");
  await expect(page.locator("#member")).toHaveValue("synthetic-79");
  await expect(page.locator("#member-search")).toHaveValue("member 79");
});


test("exit to desktop is confirmed and reports a safe launcher failure", async ({ page }) => {
  await fixture(page); let attempts = 0;
  await page.route(`${base}/maintenance/desktop/exit`, route => { attempts++; return route.fulfill({ status: 503, json: { error: "Desktop launcher is unavailable. Reopen the kiosk from the desktop shortcut." } }); });
  await page.goto(`${base}/maintenance`);
  await expect(page.locator("#exit-desktop")).toBeHidden();
  await pin(page);
  await page.locator("#exit-desktop").click(); await page.locator("#cancel-action").click();
  expect(attempts).toBe(0);
  await page.locator("#exit-desktop").click(); await page.locator("#accept-action").click();
  await expect(page.locator("#message")).toContainText("Desktop launcher is unavailable");
  expect(attempts).toBe(1);
  await expect(page.locator("#exit-desktop")).toBeEnabled();
});


test("late reader response cannot restore an expired maintenance workspace", async ({ page }) => {
  const mock = await fixture(page);
  let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${base}/sensor/test`, async route => { await delayed; await route.fulfill({ json: { readerOnline: true, templateCount: 60 } }); });
  await page.goto(`${base}/maintenance`); await pin(page);
  await expect(page.locator("#reader-status")).toHaveText("Testing reader...");
  mock.expire();
  await expect(page.locator("#workspace")).toBeHidden();
  release!();
  await expect(page.locator("#unlock")).toBeVisible();
  await expect(page.locator("#reader-status")).not.toContainText("Reader online");
});

test("non-fingerprint maintenance does not test the fingerprint reader", async ({ page }) => {
  const mock = await fixture(page, { authenticationMethod: "member_id" });
  await page.goto(`${base}/maintenance`); await pin(page);
  await expect(page.locator("#member-id-card")).toBeVisible();
  expect(mock.readerTests()).toBe(0);
});


for (const height of [480, 360]) test(`mobile roster keyboard keeps digits visible and layer toggle fixed at 800x${height}`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height });
  await fixture(page); await page.goto(`${base}/maintenance`); await pin(page);
  await page.locator("#member-picker").click();
  const keyboard = page.locator("#search-keyboard"), search = page.locator("#member-search");
  for (const digit of "1234567890") await expect(keyboard.getByRole("button", { name: digit, exact: true })).toBeVisible();
  const toggle = await keyboard.getByRole("button", { name: "123", exact: true }).boundingBox();
  expect(await keyboard.locator("button").evaluateAll(buttons => buttons.every(button => {
    const r = button.getBoundingClientRect();
    return r.width >= 48 && r.height >= 48 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  }))).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`keyboard-number-row-${height}.png`) });
  await keyboard.getByRole("button", { name: "Shift", exact: true }).click();
  await expect(keyboard.getByRole("button", { name: "Shift", exact: true })).toHaveAttribute("aria-pressed", "true");
  await keyboard.getByRole("button", { name: "A", exact: true }).click();
  await keyboard.getByRole("button", { name: "123", exact: true }).click();
  expect(await keyboard.getByRole("button", { name: "ABC", exact: true }).boundingBox()).toEqual(toggle);
  for (const digit of "1234567890") await expect(keyboard.getByRole("button", { name: digit, exact: true })).toBeVisible();
  await keyboard.getByRole("button", { name: "7", exact: true }).click();
  await keyboard.getByRole("button", { name: "ABC", exact: true }).click();
  await search.evaluate(e => (e as HTMLInputElement).setSelectionRange(0, 1));
  await keyboard.getByRole("button", { name: "B", exact: true }).click();
  await expect(search).toHaveValue("B7");
});

for (const origin of ["row", "remove"] as const) test(`mapping list mouse drag from ${origin} scrolls without removing a fingerprint`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await fixture(page); await page.goto(`${base}/maintenance`); await pin(page);
  await tap(page, page.getByRole("tab", { name: "Fingerprint mappings" }));
  const list = page.locator("[data-fingerprint].mappings-card .table-wrap");
  await expect(list.locator("tbody tr").first()).toBeVisible();
  const before = await list.locator("tbody tr").count();
  const points = await list.evaluate((element, origin) => {
    const bounds = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll("tbody tr")].filter(row => { const box = row.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom; });
    const row = rows.at(-1)!;
    const box = (origin === "remove" ? row.querySelector("button")! : row).getBoundingClientRect();
    return { x: origin === "remove" ? box.x + box.width / 2 : box.x + 70, y: box.y + box.height / 2, end: bounds.top + 12 };
  }, origin);
  await page.mouse.move(points.x, points.y); await page.mouse.down();
  await page.mouse.move(points.x, points.end, { steps: 12 }); await page.mouse.up();
  expect(await list.evaluate(element => element.scrollTop)).toBeGreaterThan(20);
  await expect(list.locator("tbody tr")).toHaveCount(before);
  await expect(page.locator("#confirm-sheet")).toBeHidden();
});

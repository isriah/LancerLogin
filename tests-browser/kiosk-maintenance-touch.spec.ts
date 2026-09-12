import { expect, test, type Page, type Locator } from "@playwright/test";

const base = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";
test.use({ hasTouch: true });
test.setTimeout(120_000);

// No locator.tap(), auto-scroll, wheel, or scrollTop writes: acceptance uses visible hit targets.
const touchClicks = new WeakMap<Page, number>();
async function tap(page: Page, target: Locator, expectClick = true) {
  if (!touchClicks.has(page)) {
    touchClicks.set(page, 0);
    await page.exposeFunction("recordMaintenanceTouchClick", () => touchClicks.set(page, touchClicks.get(page)! + 1));
  }
  await expect(target).toBeVisible();
  await target.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  const size = page.viewportSize()!;
  expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(size.width);
  expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(size.height);
  expect(await target.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return !!hit && (element === hit || element.contains(hit));
  }, { x, y })).toBe(true);
  const clicks = touchClicks.get(page)!;
  if (expectClick) await target.evaluate((element) => element.addEventListener("click", () => {
    void (window as unknown as { recordMaintenanceTouchClick: () => Promise<void> }).recordMaintenanceTouchClick();
  }, { once: true, capture: true }));
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(80);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  if (expectClick) await expect.poll(() => touchClicks.get(page), { timeout: 3000, message: "Real touch tap must click its intended target" }).toBe(clicks + 1);
}

async function swipe(page: Page, scroller: Locator, direction: "up" | "down" | "left" = "up", origin?: "row" | "blank") {
  const visible = await scroller.evaluate((element) => {
    const r = element.getBoundingClientRect();
    let left = Math.max(1, r.left), right = Math.min(innerWidth - 1, r.right);
    let top = Math.max(1, r.top), bottom = Math.min(innerHeight - 1, r.bottom);
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, box.left + ancestor.clientLeft);
        right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, box.top + ancestor.clientTop);
        bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight);
      }
    }
    return { left, right, top, bottom };
  });
  const { left, right, top, bottom } = visible;
  expect(right - left).toBeGreaterThan(40); expect(bottom - top).toBeGreaterThan(40);
  const x = left + (right - left) * .45;
  const from = direction === "down" ? top + 20 : bottom - 20;
  const to = direction === "down" ? bottom - 20 : top + 20;
  const session = await page.context().newCDPSession(page);
  const startX = origin === "blank" ? right - 12 : direction === "left" ? right - 20 : x;
  const endX = direction === "left" ? left + 20 : startX;
  const startY = origin === "row" ? await scroller.locator("button").evaluateAll((buttons, bounds) => {
    const rows = buttons.map((button) => button.getBoundingClientRect()).filter((r) => Math.min(r.bottom, bounds.bottom) - Math.max(r.top, bounds.top) >= 44);
    const row = bounds.direction === "down" ? rows[0] : rows[rows.length - 1];
    if (!row) throw new Error("No visible roster row for touch swipe");
    return bounds.direction === "down" ? Math.max(row.top, bounds.top) + 12 : Math.min(row.bottom, bounds.bottom) - 12;
  }, { top, bottom, direction }) : direction === "left" ? (top + bottom) / 2 : from;
  const endY = direction === "left" ? startY : to;
  expect(await scroller.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return !!hit && (element === hit || element.contains(hit));
  }, { x: startX, y: startY, id: 1 }), "Touch swipe must start inside the intended visible scroller").toBe(true);
  if (origin) expect(await scroller.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return point.origin === "row" ? !!hit?.closest("button") : hit === element;
  }, { x: startX, y: startY, origin }), "Swipe starts on the specified roster row or blank list space").toBe(true);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y: startY, id: 1 }] });
  for (let step = 1; step <= 12; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: startX + (endX - startX) * step / 12, y: startY + (endY - startY) * step / 12, id: 1 }] });
    await page.waitForTimeout(20);
  }
  // Pause the actual finger at the end of its swipe before lifting: no fling can consume the next tap.
  await page.waitForTimeout(200);
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: endX, y: endY, id: 1 }] });
  await page.waitForTimeout(100);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
  // A tap during native fling stops scrolling; wait for real scroll settlement before actions.
  let previous = "", stable = 0;
  for (let sample = 0; sample < 40 && stable < 3; sample++) {
    await page.waitForTimeout(100);
    const position = await scroller.evaluate((e) => JSON.stringify([e.scrollTop, e.scrollLeft]));
    stable = position === previous ? stable + 1 : 0; previous = position;
  }
  expect(stable).toBe(3);
}

async function reachable(page: Page, target: Locator, scroller: Locator, direction: "up" | "down" = "up", origin?: "row" | "blank") {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await target.evaluate((element) => {
      const r = element.getBoundingClientRect();
      if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) return false;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX) && (r.left < box.left + ancestor.clientLeft || r.right > box.left + ancestor.clientLeft + ancestor.clientWidth)) return false;
        if (/auto|scroll|hidden|clip/.test(style.overflowY) && (r.top < box.top + ancestor.clientTop || r.bottom > box.top + ancestor.clientTop + ancestor.clientHeight)) return false;
      }
      return [[r.left + 8, r.top + 8], [r.right - 8, r.bottom - 8]].every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (element === hit || element.contains(hit));
      });
    })) return;
    await swipe(page, scroller, direction, origin);
  }
  throw new Error("Touch swipes could not reach target: " + JSON.stringify(await scroller.evaluate((e) => ({ top: e.scrollTop, left: e.scrollLeft, height: e.clientHeight, content: e.scrollHeight }))));
}

async function fixture(page: Page) {
  let authorized = false;
  let expired = false;
  let attempts = 0;
  const enrolled: unknown[] = [], removed: string[] = [];
  const members = Array.from({ length: 80 }, (_, index) => ({ memberId: `synthetic-${index}`, firstName: `Member ${index}`, lastName: "Synthetic" }));
  let mappings: Record<string, unknown> = Object.fromEntries(members.slice(0, 60).map((member, index) => [String(index), { memberId: member.memberId, finger: "right index" }]));
  await page.route(`${base}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/maintenance/session") return json({ configured: true, authorized: authorized && !expired });
    if (path === "/network/unlock") {
      if (route.request().postDataJSON().pin !== "123456") {
        attempts++;
        return json({ error: attempts >= 5 ? "Too many attempts. Try again later." : "Network settings PIN is incorrect" }, attempts >= 5 ? 429 : 401);
      }
      if (attempts >= 5) return json({ error: "Too many attempts. Try again later." }, 429);
      authorized = true; return json({ authorized: true });
    }
    if (path === "/network/session" && route.request().method() === "DELETE") { authorized = false; return json({ closed: true }); }
    if (path === "/maintenance/members") return authorized && !expired ? json({ members }) : json({ error: "Unlock network settings first" }, 403);
    if (path === "/mappings") return authorized && !expired ? json({ mappings }) : json({ error: "Unlock network settings first" }, 403);
    if (path.startsWith("/mappings/")) {
      removed.push(path); delete mappings[path.split("/").pop()!]; return json({ mappings });
    }
    if (path === "/display-state" && enrolled.length) {
      const response = await route.fetch(); const state = await response.json();
      return json({ ...state, display: { id: "enroll_success", message: "Enrollment saved", detail: "Synthetic recovery guidance. ".repeat(30) } });
    }
    if (path === "/sensor/test") return json({ readerOnline: true, templateCount: 60 });
    if (path === "/enroll") { const input = route.request().postDataJSON(); enrolled.push(input); mappings[String(input.slot)] = { memberId: input.memberId, finger: input.finger }; return json({ enrolled: true }); }
    return route.continue();
  });
  return { enrolled, removed, expire: () => { expired = true; }, attempts: () => attempts };
}

async function pin(page: Page, value = "123456") {
  await reachable(page, page.locator("#pin"), page.locator("#unlock"), "down");
  await tap(page, page.locator("#pin"));
  for (const digit of value) await tap(page, page.locator("#pin-keypad").getByRole("button", { name: digit, exact: true }));
  await expect(page.locator("#pin")).toHaveValue(value);
  await reachable(page, page.locator("#unlock-form").getByRole("button", { name: "Unlock for five minutes" }), page.locator("#unlock"));
  await tap(page, page.locator("#unlock-form").getByRole("button", { name: "Unlock for five minutes" }));
}

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
        expect(boxes[index]!.width).toBeGreaterThanOrEqual(44);
        expect(boxes[index]!.height).toBeGreaterThanOrEqual(44);
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

for (const viewport of [{ width: 800, height: 480 }, { width: 1024, height: 600 }, { width: 800, height: 360 }]) {
  test(`maintenance completes touch workflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const mock = await fixture(page);
    await page.goto(`${base}/maintenance`);
    await expect(page.locator("#workspace")).toBeHidden();
    await pin(page);
    await expect(page.locator("#workspace")).toBeVisible();
    await tap(page, page.locator("#test-reader"));
    await expect(page.locator("#reader-status")).toContainText("Reader online");
    if (viewport.height === 360) {
      const reader = page.locator(".reader-card");
      expect(await reader.evaluate((e) => e.scrollHeight)).toBeGreaterThan(await reader.evaluate((e) => e.clientHeight));
      await swipe(page, reader);
      expect(await reader.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
      await reachable(page, page.locator("#stage-detail"), reader);
      await tap(page, page.locator("#stage-detail"));
      await reachable(page, page.locator("#test-reader"), reader, "down");
      await tap(page, page.locator("#test-reader"));
    }
    await tap(page, page.locator("#member-picker"));
    await expect(page.locator("#member-search")).toBeFocused();
    const options = page.locator("#member-options");
    expect(await options.locator("button").evaluateAll((buttons) => buttons.every((e) => e.scrollHeight <= e.clientHeight))).toBe(true);
    await swipe(page, options);
    expect(await options.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
    // All keyboard keys must have reachable touch targets, including bottom-row controls.
    const keyboard = page.locator("#search-keyboard");
    expect(await keyboard.locator("button").evaluateAll((buttons) => buttons.every((e) => {
      const r = e.getBoundingClientRect();
      return r.height >= 44 && [[r.left + 8, r.top + 8], [r.right - 8, r.bottom - 8]].every(([x, y]) => e.contains(document.elementFromPoint(x, y)));
    }))).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`roster-keyboard-${viewport.height}.png`) });
    for (const key of "abcdefghijklmnopqrstuvwxyz0123456789-'.") {
      const target = keyboard.getByRole("button", { name: key, exact: true });
      expect(await target.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return [[r.left + 8, r.top + 8], [r.right - 8, r.bottom - 8]].every(([x, y]) => e.contains(document.elementFromPoint(x, y)));
      })).toBe(true);
      await tap(page, target);
    }
    await expect(page.locator("#member-search")).toHaveValue("abcdefghijklmnopqrstuvwxyz0123456789-'.");
    await tap(page, keyboard.getByRole("button", { name: "Space", exact: true }));
    await tap(page, keyboard.getByRole("button", { name: "Backspace" }));
    await tap(page, keyboard.getByRole("button", { name: "Clear", exact: true }));
    for (const key of "member 79") await tap(page, keyboard.getByRole("button", { name: key === " " ? "Space" : key, exact: true }));
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await tap(page, keyboard.getByRole("button", { name: "Backspace" }));
    await expect(page.locator("#member-search")).toHaveValue("member 7");
    await tap(page, keyboard.getByRole("button", { name: "9", exact: true }));
    await tap(page, page.locator("#member-search"));
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await page.locator("#member-search").evaluate((element) => (element as HTMLInputElement).setSelectionRange(0, 6));
    await tap(page, keyboard.getByRole("button", { name: "m", exact: true }));
    await expect(page.locator("#member-search")).toHaveValue("m 79");
    await tap(page, keyboard.getByRole("button", { name: "Clear", exact: true }));
    for (const key of "member 79") await tap(page, keyboard.getByRole("button", { name: key === " " ? "Space" : key, exact: true }));
    await tap(page, page.locator("#close-member-sheet"));
    await tap(page, page.locator("#member-picker"));
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await tap(page, options.getByRole("button", { name: /Member 79/ }));
    await expect(page.locator("#member")).toHaveValue("synthetic-79");
    await tap(page, page.locator("#finger-picker"));
    await tap(page, page.locator("#close-finger-sheet"));
    await expect(page.locator("#finger")).toHaveValue("right index");
    await tap(page, page.locator("#finger-picker"));
    const fingers = page.locator("#finger-options");
    await reachable(page, fingers.getByRole("button", { name: "other", exact: true }), fingers);
    await tap(page, fingers.getByRole("button", { name: "other", exact: true }));
    await expect(page.locator("#finger")).toHaveValue("other");
    await tap(page, page.locator("#slot"), false);
    await expect(page.locator("#number-display")).toHaveValue("60");
    const pad = page.locator("#slot-keypad");
    const back = pad.getByRole("button", { name: "Backspace" });
    const panel = page.locator("#number-pad .sheet-panel");
    await reachable(page, back, panel);
    await tap(page, back); await tap(page, back);
    for (const digit of "999") await tap(page, pad.getByRole("button", { name: digit, exact: true }));
    await reachable(page, page.locator("#apply-number"), panel);
    await tap(page, page.locator("#apply-number"));
    await expect(page.locator("#number-error")).toContainText("0 to 199");
    await tap(page, back); await tap(page, back); await tap(page, back);
    await tap(page, pad.getByRole("button", { name: "5", exact: true }));
    await tap(page, page.locator("#apply-number"));
    await expect(page.locator("#slot")).toHaveValue("5");
    await tap(page, page.locator("#slot"), false);
    await expect(page.locator("#number-display")).toHaveValue("5");
    await tap(page, pad.getByRole("button", { name: "0", exact: true }));
    await tap(page, page.locator("#close-number-pad"));
    await expect(page.locator("#slot")).toHaveValue("5");
    const enroll = page.locator(".enroll-card");
    await reachable(page, page.locator("#begin-enroll"), enroll);
    await tap(page, page.locator("#begin-enroll"));
    await expect(page.locator("#message")).toContainText("already has a mapping");
    expect(mock.enrolled).toHaveLength(0);
    await tap(page, page.locator("#replace"));
    await tap(page, page.locator("#begin-enroll"));
    await expect(page.locator("#confirm-title")).toHaveText("Replace occupied slot?");
    await tap(page, page.locator("#cancel-action"));
    expect(mock.enrolled).toHaveLength(0);
    await tap(page, page.locator("#begin-enroll"));
    await tap(page, page.locator("#accept-action"));
    await expect.poll(() => mock.enrolled).toEqual([{ memberId: "synthetic-79", finger: "other", slot: 5, replaceExisting: true }]);
    await expect(page.locator("#message")).toContainText("Enrollment saved");
    const reader = page.locator(".reader-card");
    await expect(page.locator("#stage-detail")).toContainText("Synthetic recovery guidance");
    await swipe(page, reader);
    expect(await reader.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
    await reachable(page, page.locator("#test-reader"), reader, "down");
    await tap(page, page.locator("#test-reader"));
    const table = page.locator(".table-wrap");
    await swipe(page, table);
    expect(await table.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
    if (await table.evaluate((e) => e.scrollWidth > e.clientWidth + 10)) {
      await swipe(page, table, "left");
      expect(await table.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    }
    const remove = page.locator("#mappings tr").last().getByRole("button", { name: "Remove" });
    await reachable(page, remove, table);
    await tap(page, remove);
    await tap(page, page.locator("#cancel-action"));
    expect(mock.removed).toHaveLength(0);
    await tap(page, remove); await tap(page, page.locator("#accept-action"));
    await expect.poll(() => mock.removed.length).toBe(1);
    await tap(page, page.locator("#refresh"));
    await expect(page.locator("#member")).toHaveValue("");
    expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual(viewport);
    await page.screenshot({ path: test.info().outputPath(`maintenance-${viewport.height}.png`) });
    await tap(page, page.locator("#maintenance-header a"));
    await expect(page).toHaveURL(`${base}/`);
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


test("unconfigured maintenance offers touch return without exposing tools", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 360 });
  await page.route(`${base}/maintenance/session`, (route) => route.fulfill({ json: { configured: false, authorized: false } }));
  await page.goto(`${base}/maintenance`);
  await expect(page.locator("#message")).toContainText("Create a local settings PIN");
  await expect(page.locator("#workspace")).toBeHidden();
  await tap(page, page.locator("#locked-return"));
  await expect(page).toHaveURL(`${base}/`);
});

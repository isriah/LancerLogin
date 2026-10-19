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

async function chooseSearchKeys(page: Page, key: string) {
  if (key === " ") return;
  const keyboard = page.locator("#search-keyboard");
  if (await keyboard.getByRole("button", { name: key, exact: true }).count()) return;
  await tap(page, keyboard.getByRole("button", { name: /^(123|ABC)$/ }));
}

async function swipe(page: Page, scroller: Locator, direction: "up" | "down" | "left" = "up", origin?: "row" | "blank") {
  const visible = await scroller.evaluate((element) => {
    const r = element.getBoundingClientRect();
    let left = Math.max(1, r.left + element.clientLeft), right = Math.min(innerWidth - 1, r.left + element.clientLeft + element.clientWidth);
    let top = Math.max(1, r.top + element.clientTop), bottom = Math.min(innerHeight - 1, r.top + element.clientTop + element.clientHeight);
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
  // Keep the gesture inside visible content, outside borders and scrollbars,
  // without losing most of a short pane to gesture margins.
  const inset = bottom - top < 100 ? 4 : 12;
  const from = direction === "down" ? top + inset : bottom - inset;
  const to = direction === "down" ? bottom - inset : top + inset;
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

async function fixture(page: Page, options: { authenticationMethod?: "fingerprint" | "rfid" | "nfc" | "qr" | "member_id"; rejectCredential?: boolean; sensorOnlySlots?: number[]; failSlotRead?: boolean; failRoster?: boolean; rejectEnrollment?: boolean; failRefresh?: boolean } = {}) {
  const authenticationMethod = options.authenticationMethod ?? "fingerprint";
  let authorized = false;
  let expired = false;
  let attempts = 0, readerTests = 0;
  const enrolled: unknown[] = [], removed: string[] = [], credentialAttempts: unknown[] = [];
  const displayState = await (await page.request.get(`${base}/display-state`)).json();
  const members = Array.from({ length: 80 }, (_, index) => ({ memberId: `synthetic-${index}`, firstName: `Member ${index}`, lastName: "Synthetic" }));
  let mappings: Record<string, unknown> = Object.fromEntries(members.slice(0, 60).map((member, index) => [String(index), { memberId: member.memberId, finger: "right index" }]));
  const sensorSlots = new Set([...Object.keys(mappings).map(Number), ...(options.sensorOnlySlots ?? [])]);
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
    if (path === "/maintenance/members" && options.failRoster) return json({ error: "Roster unavailable. Retry when connected." }, 503);
    if (path === "/maintenance/members") return authorized && !expired ? json({ members }) : json({ error: "Unlock network settings first" }, 403);
    if (path === "/credential-mappings" && route.request().method() === "GET") return authorized && !expired ? json({ mappings: [] }) : json({ error: "Unlock network settings first" }, 403);
    if (path === "/credential-mappings" && route.request().method() === "POST") {
      credentialAttempts.push(route.request().postDataJSON());
      return options.rejectCredential ? json({ error: "Credential not accepted" }, 400) : json({ mapping: { id: "local-mapping", method: authenticationMethod, memberId: "synthetic-0", label: "Local credential" } }, 201);
    }
    if (path === "/mappings" && options.failRefresh && enrolled.length) return json({ error: "Mappings refresh unavailable" }, 503);
    if (path === "/mappings") return authorized && !expired ? json({ mappings }) : json({ error: "Unlock network settings first" }, 403);
    if (path.startsWith("/mappings/")) {
      removed.push(path); delete mappings[path.split("/").pop()!]; return json({ mappings });
    }
    if (path === "/display-state" && authenticationMethod !== "fingerprint") return json({ ...displayState, authenticationMethod });
    if (path === "/display-state" && enrolled.length) {
      return json({ ...displayState, display: { id: "enroll_success", message: "Enrollment saved", detail: "Synthetic recovery guidance. ".repeat(30) } });
    }
    if (path === "/sensor/test") { readerTests++; return json({ readerOnline: true, templateCount: 60 }); }
    if (path === "/sensor/slots") return options.failSlotRead ? json({ error: "Cannot verify occupied sensor slots" }, 503) : json({ occupiedSlots: [...sensorSlots] });
    if (path === "/enroll" && options.rejectEnrollment) return json({ error: "Roster verification unavailable. Retry enrollment." }, 503);
    if (path === "/enroll") { const input = route.request().postDataJSON(); enrolled.push(input); sensorSlots.add(input.slot); mappings[String(input.slot)] = { memberId: input.memberId, finger: input.finger }; return json({ enrolled: true }); }
    return route.continue();
  });
  return { enrolled, removed, credentialAttempts, readerTests: () => readerTests, expire: () => { expired = true; }, resume: () => { expired = false; }, attempts: () => attempts };
}

async function pin(page: Page, value = "123456") {
  await reachable(page, page.locator("#pin"), page.locator("#unlock"), "down");
  await tap(page, page.locator("#pin"));
  for (const digit of value) await tap(page, page.locator("#pin-keypad").getByRole("button", { name: digit, exact: true }));
  await expect(page.locator("#pin")).toHaveValue(value);
  await reachable(page, page.locator("#unlock-form").getByRole("button", { name: "Unlock for five minutes" }), page.locator("#unlock"));
  await tap(page, page.locator("#unlock-form").getByRole("button", { name: "Unlock for five minutes" }));
}

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

for (const viewport of [{ width: 800, height: 480 }, { width: 1024, height: 600 }, { width: 800, height: 360 }]) {
  test(`maintenance completes touch workflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    if (viewport.height === 360) test.setTimeout(180_000);
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
      await chooseSearchKeys(page, key);
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
    for (const key of "member 79") { await chooseSearchKeys(page, key); await tap(page, keyboard.getByRole("button", { name: key === " " ? "Space" : key, exact: true })); }
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await tap(page, keyboard.getByRole("button", { name: "Backspace" }));
    await expect(page.locator("#member-search")).toHaveValue("member 7");
    await tap(page, keyboard.getByRole("button", { name: "9", exact: true }));
    await tap(page, page.locator("#member-search"));
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await page.locator("#member-search").evaluate((element) => (element as HTMLInputElement).setSelectionRange(0, 6));
    await chooseSearchKeys(page, "m");
    await tap(page, keyboard.getByRole("button", { name: "m", exact: true }));
    await expect(page.locator("#member-search")).toHaveValue("m 79");
    await tap(page, keyboard.getByRole("button", { name: "Clear", exact: true }));
    for (const key of "member 79") { await chooseSearchKeys(page, key); await tap(page, keyboard.getByRole("button", { name: key === " " ? "Space" : key, exact: true })); }
    await tap(page, page.locator("#close-member-sheet"));
    await tap(page, page.locator("#member-picker"));
    await expect(page.locator("#member-search")).toHaveValue("member 79");
    await tap(page, options.getByRole("button", { name: /Member 79/ }));
    await expect(page.locator("#member")).toHaveValue("synthetic-79");
    await expect(page.locator("#finger-picker")).toHaveCount(0);
    await reachable(page, page.locator("#slot"), page.locator(".enroll-card"));
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
    await expect(page.locator("#message")).toContainText("already contains a fingerprint or mapping");
    expect(mock.enrolled).toHaveLength(0);
    await tap(page, page.locator("#replace"));
    await tap(page, page.locator("#begin-enroll"));
    await expect(page.locator("#confirm-title")).toHaveText("Replace occupied slot?");
    await tap(page, page.locator("#cancel-action"));
    expect(mock.enrolled).toHaveLength(0);
    await tap(page, page.locator("#begin-enroll"));
    await tap(page, page.locator("#accept-action"));
    await expect.poll(() => mock.enrolled).toEqual([{ memberId: "synthetic-79", slot: 5, replaceExisting: true }]);
    await expect(page.locator("#message")).toContainText("Enrollment saved");
    const reader = page.locator(".reader-card");
    await expect(page.locator("#stage-detail")).toContainText("Synthetic recovery guidance");
    await swipe(page, reader);
    expect(await reader.evaluate((e) => e.scrollTop)).toBeGreaterThan(20);
    await reachable(page, page.locator("#test-reader"), reader, "down");
    await tap(page, page.locator("#test-reader"));
    const table = page.locator("[data-fingerprint].mappings-card .table-wrap");
    // Swipe the heading to expose the nested table before scrolling its rows.
    await reachable(page, table, page.locator("[data-fingerprint].mappings-card .card-heading"));
    const initialTableTop = await table.evaluate(element => element.scrollTop);
    expect(await table.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(20);
    await swipe(page, table);
    expect(await table.evaluate(element => element.scrollTop) - initialTableTop).toBeGreaterThan(20);
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
    await reachable(page, page.locator("#refresh"), page.locator("[data-fingerprint].mappings-card .card-heading"), "down");
    await tap(page, page.locator("#refresh"));
    await expect(page.locator("#member")).toHaveValue("");
    expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual(viewport);
    await page.screenshot({ path: test.info().outputPath(`maintenance-${viewport.height}.png`) });
    await tap(page, page.locator('#maintenance-header a[href="/"]'));
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

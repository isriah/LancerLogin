import { expect, type CDPSession, type Page, type Locator } from "@playwright/test";

// Shared by kiosk-maintenance-touch.spec.ts and kiosk-maintenance-touch-workflow.spec.ts.
export const base = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";

// Touch input goes through one CDP session per page, opened on first use and closed with the page.
const touchSessions = new WeakMap<Page, Promise<CDPSession>>();
function touchSession(page: Page) {
  if (!touchSessions.has(page)) touchSessions.set(page, page.context().newCDPSession(page));
  return touchSessions.get(page)!;
}

// No locator.tap(), auto-scroll, wheel, or scrollTop writes: acceptance uses visible hit targets.
const touchClicks = new WeakMap<Page, number>();
export async function tap(page: Page, target: Locator, expectClick = true) {
  if (!touchClicks.has(page)) {
    touchClicks.set(page, 0);
    await page.exposeFunction("recordMaintenanceTouchClick", () => touchClicks.set(page, touchClicks.get(page)! + 1));
  }
  await expect(target).toBeVisible();
  // One round trip reads the target's centre (getBoundingClientRect lays out the current DOM, so no frame wait is
  // needed), checks that the centre hits the target, and only then arms the one-time click recorder.
  const { x, y, hit } = await target.evaluate((element, expectClick) => {
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const hit = !!top && (element === top || element.contains(top));
    if (hit && expectClick) element.addEventListener("click", () => {
      void (window as unknown as { recordMaintenanceTouchClick: () => Promise<void> }).recordMaintenanceTouchClick();
    }, { once: true, capture: true });
    return { x, y, hit };
  }, expectClick);
  const size = page.viewportSize()!;
  expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(size.width);
  expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(size.height);
  expect(hit).toBe(true);
  const clicks = touchClicks.get(page)!;
  const session = await touchSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(80);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  if (expectClick) await expect.poll(() => touchClicks.get(page), { timeout: 3000, intervals: [10, 20, 50, 100], message: "Real touch tap must click its intended target" }).toBe(clicks + 1);
}

export async function chooseSearchKeys(page: Page, key: string) {
  if (key === " ") return;
  const keyboard = page.locator("#search-keyboard");
  if (await keyboard.getByRole("button", { name: key, exact: true }).count()) return;
  await tap(page, keyboard.getByRole("button", { name: /^(123|ABC)$/ }));
}

// Four moves per swipe: the first already clears the touch slop on all but the shortest panes, and the scroller still
// sees intermediate positions rather than a jump.
const swipeSteps = 4, swipeHoldMs = 100;

export async function swipe(page: Page, scroller: Locator, direction: "up" | "down" | "left" = "up", origin?: "row" | "blank" | "padding") {
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
  const session = await touchSession(page);
  const startX = origin === "padding" ? left + 4 : origin === "blank" ? right - 12 : direction === "left" ? right - 20 : x;
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
  }, { x: startX, y: startY, origin }), "Swipe starts on the specified row, blank list space, or outer card padding").toBe(true);
  // Chromium's own touch gesture recognizer drives native scrolling (touch-action pan-x/pan-y). It starts scrolling
  // once the finger passes its touch slop (about 15 px) and then follows the finger, so a few large moves scroll as far
  // as many small ones. Each CDP touch event is acknowledged before the next is sent, so no waits between moves.
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y: startY, id: 1 }] });
  for (let step = 1; step <= swipeSteps; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: startX + (endX - startX) * step / swipeSteps, y: startY + (endY - startY) * step / swipeSteps, id: 1 }] });
  }
  // Hold the finger still before lifting: the velocity tracker treats a pointer that has not moved for 40 ms as stopped,
  // so no fling starts that could consume the next tap.
  await page.waitForTimeout(swipeHoldMs);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // A tap during native fling stops scrolling; wait in the page for real scroll settlement before actions:
  // the position must stay unchanged for at least three rendered frames and 100 ms.
  const settled = await scroller.evaluate(async (element) => {
    const position = () => element.scrollTop + "," + element.scrollLeft;
    const deadline = performance.now() + 4000;
    let previous = position(), frames = 0, since = performance.now();
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const current = position();
      if (current !== previous) { previous = current; frames = 0; since = performance.now(); continue; }
      if (++frames >= 3 && performance.now() - since >= 100) return true;
    }
    return false;
  });
  expect(settled, "Swiped scroller must settle before the next action").toBe(true);
}

export async function reachable(page: Page, target: Locator, scroller: Locator, direction: "up" | "down" = "up", origin?: "row" | "blank" | "padding") {
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

export async function fixture(page: Page, options: { authenticationMethod?: "fingerprint" | "rfid" | "nfc" | "qr" | "member_id"; rejectCredential?: boolean; sensorOnlySlots?: number[]; failSlotRead?: boolean; failRoster?: boolean; rejectEnrollment?: boolean; failRefresh?: boolean } = {}) {
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

export async function pin(page: Page, value = "123456") {
  // The unlock card starts hidden and appears once the page has read the maintenance session.
  await expect(page.locator("#unlock")).toBeVisible();
  await reachable(page, page.locator("#pin"), page.locator("#unlock"), "down");
  await tap(page, page.locator("#pin"));
  for (const digit of value) await tap(page, page.locator("#pin-keypad").getByRole("button", { name: digit, exact: true }));
  await expect(page.locator("#pin")).toHaveValue(value);
  await reachable(page, page.locator("#unlock-form").getByRole("button", { name: "Unlock for five minutes" }), page.locator("#unlock"));
  await tap(page, page.locator("#unlock-form").getByRole("button", { name: "Unlock for five minutes" }));
}

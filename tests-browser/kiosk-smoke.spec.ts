import { expect, test } from "@playwright/test";
import { kioskDisplayForQueuedScan } from "../apps/kiosk/src/kiosk-presentation.mjs";
import { attendanceSnapshot } from "./module-fixtures";

const kioskBaseUrl = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";

// The kiosk keeps polling display-state. Let a poll already inside a route.fetch() handler finish before the
// context closes; otherwise its fetched response is disposed mid-handler and the test fails after its assertions.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("public attendance screen shows clock guidance without administrative review counts", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const needsReview = 12;
  let verified = false;
  await page.route(`${kioskBaseUrl}/display-state`, async route => {
    const response = await route.fetch(); const state = await response.json();
    await route.fulfill({ json: { ...state, pendingEvents: 0, attendance: { needsReview, clockPending: 0 }, clock: { verified } } });
  });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.locator("#queue-status")).toHaveText("0 queued");
  await expect(page.locator("body")).not.toContainText("12 scans need review");
  await expect(page.getByRole("status")).toContainText("Clock needs confirmation");
  const box = await page.locator("#attendance-warning").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(800);
  expect(box!.y + box!.height).toBeLessThanOrEqual(480);
  verified = true;
  await expect(page.locator("#attendance-warning")).not.toContainText("Clock needs confirmation");
  await expect(page.locator("body")).not.toContainText("12 scans need review");
  await expect(page.locator("#attendance-warning")).toBeHidden();
});

test.describe("offline clock confirmation", () => {
  test.use({ timezoneId: "America/New_York" });
  test("boot prompt requires the PIN, accepts date and time, then returns to attendance", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 800, height: 480 });
    let authorized = false, verified = false, submitted: unknown;
    await page.route(`${kioskBaseUrl}/display-state`, async route => {
      const response = await route.fetch(); const state = await response.json();
      await route.fulfill({ json: { ...state, clock: { verified }, display: verified ? state.display : { id: "clock_required", message: "Confirm date and time", detail: "Open maintenance and enter the local PIN to set the current date and time.", tone: "notice" } } });
    });
    await page.route(`${kioskBaseUrl}/maintenance/session`, route => route.fulfill({ json: { configured: true, authorized } }));
    await page.route(`${kioskBaseUrl}/network/unlock`, async route => { authorized = true; await route.fulfill({ json: { authorized: true } }); });
    await page.route(`${kioskBaseUrl}/maintenance/clock`, async route => { submitted = route.request().postDataJSON(); verified = true; await route.fulfill({ json: { clock: { verified: true, source: "operator" } } }); });
    await page.goto(`${kioskBaseUrl}/`);
    await expect(page.getByRole("heading", { name: "Confirm date and time" })).toBeVisible();
    await page.getByRole("button", { name: "Open maintenance", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Unlock maintenance" })).toBeVisible();
    await expect(page.getByLabel("Current date", { exact: true })).toBeHidden();
    for (const digit of ["1", "2", "3", "4", "5", "6"]) await page.getByLabel("PIN keypad").getByRole("button", { name: digit, exact: true }).click();
    await page.getByRole("button", { name: "Unlock for five minutes" }).click();
    await expect(page.getByRole("heading", { name: "Confirm current date and time" })).toBeVisible();
    await page.getByLabel("Current date", { exact: true }).fill("2026-10-24");
    await page.getByLabel("Current time", { exact: true }).fill("07:00");
    await expect(page.getByText("Time zone: America/New_York")).toBeVisible();
    const confirm = page.getByRole("button", { name: "Confirm time and return to kiosk" });
    await expect(confirm).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("clock-confirmation.png") });
    await confirm.click();
    await expect(page).toHaveURL(`${kioskBaseUrl}/`);
    expect(submitted).toEqual({ currentTime: "2026-10-24T11:00:00.000Z" });
    await expect(page.getByRole("button", { name: "Open maintenance", exact: true })).toBeHidden();
  });
});

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
  await expect(page.getByText("v1.0.2")).toBeVisible();
  await expect(page.getByText("0 queued")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });
});

test("member ID entry is touch-friendly, case-capable, and fully visible at 800 by 480", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  const submitted: unknown[] = [];
  await page.route(`${kioskBaseUrl}/display-state`, (route) => route.fulfill({ json: {
    display: { id: "ready", tone: "ready", message: "Enter member ID", detail: "Use the touch keyboard below" },
    branding: { organizationName: "Example Arts Club", subtitle: "Create together", logoData: "", primaryColor: "#8b2f72", secondaryColor: "#2f8b72", logoBackdrop: "auto" },
    kioskName: "Main kiosk", readerOnline: true, authenticationMethod: "member_id", cloudOnline: true, networkType: "wifi", pendingEvents: 0, releaseVersion: "1.0.2", uptimeSeconds: 120,
  } }));
  await page.route(`${kioskBaseUrl}/identity`, async (route) => { submitted.push(route.request().postDataJSON()); await route.fulfill({ status: 202, json: { accepted: true } }); });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.getByRole("heading", { name: "Enter member ID" })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Member ID", exact: true });
  await expect(input).toHaveAttribute("inputmode", "text");
  await expect(input).not.toHaveAttribute("readonly", "");
  await input.fill("Case-Sensitive.id");
  await page.getByRole("button", { name: "Submit member ID" }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toEqual({ method: "member_id", memberId: "Case-Sensitive.id" });
  await page.getByRole("button", { name: "a/A" }).click();
  await page.getByRole("button", { name: "a", exact: true }).click();
  await page.getByRole("button", { name: "_", exact: true }).click();
  await expect(input).toHaveValue("a_");
  const geometry = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    controls: Array.from(document.querySelectorAll<HTMLElement>("#identity-entry input, #identity-entry button")).filter((element) => !element.hidden).map((element) => {
      const bounds = element.getBoundingClientRect(); return { width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    }),
  }));
  expect(geometry.document).toEqual({ width: 800, height: 480 });
  expect(geometry.controls.length).toBeGreaterThan(30);
  for (const control of geometry.controls) {
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(control.top).toBeGreaterThanOrEqual(0); expect(control.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  }
});

test("keyboard-wedge authentication clears failed input and refocuses for consecutive scans", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  let displayId = "ready"; let attempts = 0;
  await page.route(`${kioskBaseUrl}/display-state`, (route) => route.fulfill({ json: {
    display: displayId === "ready" ? { id: "ready", tone: "ready", message: "Present RFID badge", detail: "Hold a registered badge near the reader" } : { id: "processing", tone: "processing", message: "Checking scan", detail: "Hold still" },
    branding: { organizationName: "Example Arts Club", subtitle: "", logoData: "", primaryColor: "#8b2f72", secondaryColor: "#2f8b72", logoBackdrop: "auto" },
    kioskName: "Main kiosk", readerOnline: true, authenticationMethod: "rfid", cloudOnline: true, networkType: "wifi", pendingEvents: 0, releaseVersion: "1.0.2", uptimeSeconds: 120,
  } }));
  await page.route(`${kioskBaseUrl}/identity`, async (route) => { attempts += 1; if (attempts === 1) await route.fulfill({ status: 400, json: { error: "Credential not recognized" } }); else await route.fulfill({ status: 202, json: { accepted: true } }); });
  await page.goto(`${kioskBaseUrl}/`);
  const input = page.getByLabel("RFID badge input");
  await expect(input).toBeFocused();
  await input.fill(crypto.randomUUID()); await page.getByRole("button", { name: "Read credential" }).click();
  await expect(input).toHaveValue("");
  displayId = "processing"; await expect(page.locator("#identity-entry")).toBeHidden();
  displayId = "ready"; await expect(page.locator("#identity-entry")).toBeVisible(); await expect(input).toBeFocused();
  await input.fill(crypto.randomUUID()); await page.getByRole("button", { name: "Read credential" }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(input).toHaveValue("");
});

test("a delayed display poll cannot restore the previous member name", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
  let releaseOld: () => void = () => undefined;
  const holdOld = new Promise<void>((resolve) => { releaseOld = resolve; });
  let oldStarted: () => void = () => undefined;
  const sawOld = new Promise<void>((resolve) => { oldStarted = resolve; });
  let calls = 0;
  await page.route(`${kioskBaseUrl}/display-state`, async (route) => {
    calls += 1;
    const response = await route.fetch();
    const state = await response.json();
    if (calls === 1) {
      oldStarted();
      await holdOld;
      await route.fulfill({ response, json: { ...state, display: { id: "welcome", message: "Welcome", detail: "Arrival recorded", name: "Previous Member" } } });
    } else {
      await route.fulfill({ response, json: { ...state, display: { id: "welcome", message: "Welcome", detail: "Arrival recorded", name: "Current Member" } } });
    }
  });
  await sawOld;
  await expect(page.locator("#display-name")).toHaveText("Current Member");
  releaseOld();
  await page.waitForTimeout(250);
  await expect(page.locator("#display-name")).toHaveText("Current Member");
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

test("physical kiosk asks for a rescan without an error state and notes a weak reading on an accepted scan", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "rescan" });
  await page.goto(`${kioskBaseUrl}/`);
  const shell = page.locator("#kiosk");
  await expect(page.getByRole("heading", { name: "Scan again" })).toBeVisible();
  await expect(shell).toHaveClass(/kiosk-shell-rescan/);
  expect(await shell.evaluate((element) => getComputedStyle(element).animationName)).not.toBe("failure-flash");
  await expect(page.locator("#display-notice")).toBeHidden();

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "welcome_weak" });
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.locator("#display-notice")).toHaveText("Your fingerprint is reading weakly. Ask a mentor to re-enroll it.");
  await expect(page.locator("#display-notice")).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  expect(dimensions).toEqual({ width: 800, height: 480 });

  await page.setExtraHTTPHeaders({ "x-lancerlogin-preview-state": "ready" });
  await expect(page.getByRole("heading", { name: "Place finger on reader" })).toBeVisible();
  await expect(page.locator("#display-notice")).toBeHidden();
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
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot() }));
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

test("local rejected-scan review shows safe reasons and review does not change attendance", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  let reviewed = false;
  const record = { eventId: "synthetic-event-1", memberId: "SYNTHETIC-001", occurredAt: "2026-09-19T12:00:00.000Z", reasonCode: "no_eligible_meeting", httpStatus: 409 };
  await page.route(`${kioskBaseUrl}/attendance/rejections`, async (route) => {
    await route.fulfill({ json: { rejections: [{ ...record, reviewStatus: reviewed ? "reviewed" : "open" }] } });
  });
  await page.route(`${kioskBaseUrl}/attendance/rejections/synthetic-event-1/review`, async (route) => {
    reviewed = true;
    await route.fulfill({ json: { reviewed: true } });
  });
  await page.goto(`${kioskBaseUrl}/attendance-review`);
  await expect(page.getByRole("heading", { name: "Rejected attendance scans" })).toBeVisible();
  await expect(page.getByText("No eligible meeting at scan time")).toBeVisible();
  await expect(page.getByText("SYNTHETIC-001")).toBeVisible();
  await page.getByRole("button", { name: "Mark scan synthetic-event-1 reviewed" }).click();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
  await expect(page.getByText("Marking a scan reviewed does not change attendance.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(800);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});


test("dashboard name stays readable beside separated footer sections and a full kiosk development version", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  let name = "Workshop entrance", online = true;
  await page.route(`${kioskBaseUrl}/display-state`, async route => {
    const response = await route.fetch(); const state = await response.json();
    await route.fulfill({ response, json: { ...state, kioskName: name, readerOnline: online, releaseVersion: "2.0.0-dev.kiosk-improvements.ef2e129" } });
  });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.locator("#kiosk-name")).toHaveText(name);
  expect(await page.locator("#kiosk-name").evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  name = "Renamed workshop entrance with a deliberately long dashboard name"; online = false;
  await expect(page.locator("#kiosk-name")).toHaveText(name);
  await expect(page.locator("#kiosk-name")).toHaveAttribute("title", name);
  await expect(page.locator("#reader-status")).toHaveText("Reader offline");
  await expect(page.locator("#kiosk-version")).toHaveText("Kiosk v2.0.0-dev.kiosk-improvements.ef2e129");
  await expect(page.locator("#kiosk-version")).toHaveAttribute("title", "Kiosk software version 2.0.0-dev.kiosk-improvements.ef2e129");
  const boxes = await Promise.all(["kiosk-name", "kiosk-version", "reader-status", "queue-status", "uptime"].map(id => page.locator(`#${id}`).boundingBox()));
  for (const box of boxes) {
    expect(box!.y).toBeCloseTo(boxes[0]!.y, 0);
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(800);
  }
  expect(await page.locator("#kiosk-name").evaluate(e => getComputedStyle(e).textOverflow)).toBe("ellipsis");
  expect(boxes[0]!.width).toBeGreaterThanOrEqual(128);
  for (const id of ["kiosk-version", "reader-status", "queue-status", "uptime"]) {
    expect(await page.locator(`#${id}`).evaluate(e => getComputedStyle(e).borderInlineStartWidth)).toBe("1px");
    expect(await page.locator(`#${id}`).evaluate(e => e.scrollWidth <= e.clientWidth), `${id} fits without clipping`).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("single-line-footer.png") });
});

for (const target of ["network-status", "brand"]) test(`${target} long hold accepts modest drift and cancels a larger slide`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader");
  const hold = async (drift: number) => {
    const box = await page.locator(`#${target}`).boundingBox();
    const x = box!.x + box!.width - 4, y = box!.y + box!.height / 2;
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + drift, y, id: 1 }] });
    await page.waitForTimeout(3100);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  };
  await hold(32);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.locator("#network-panel")).toBeHidden();
  await hold(12);
  if (target === "brand") await expect(page).toHaveURL(`${kioskBaseUrl}/maintenance`);
  else { await expect(page.locator("#network-panel")).toBeVisible(); await page.getByRole("button", { name: "Close network settings" }).click(); await expect(page.locator("#network-panel")).toBeHidden(); }
});

for (const input of ["mouse", "touch"] as const) test(`maintenance hold survives a wobble beginning on the logo with ${input} input`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 480 });
  await page.route(`${kioskBaseUrl}/display-state`, async route => {
    const response = await route.fetch(); const state = await response.json();
    const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>').toString("base64");
    await route.fulfill({ response, json: { ...state, branding: { ...state.branding, logoData: `data:image/svg+xml;base64,${logo}` } } });
  });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.locator("#brand-logo")).toBeVisible();
  const box = await page.locator("#brand-logo").boundingBox();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  if (input === "mouse") {
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 12, y, { steps: 4 });
    await page.waitForTimeout(3100); await page.mouse.up();
  } else {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 12, y, id: 1 }] });
    await page.waitForTimeout(3100);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach();
  }
  await expect(page).toHaveURL(`${kioskBaseUrl}/maintenance`);
});

test("cloud or wifi loss does not open network settings and interrupt attendance", async ({ page }) => {
  await page.route(`${kioskBaseUrl}/network/session`, route => route.fulfill({ json: { configured: true, authorized: false, network: { online: false } } }));
  await page.route(`${kioskBaseUrl}/display-state`, async route => {
    const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), cloudOnline: false } });
  });
  await page.goto(`${kioskBaseUrl}/`);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader");
  await expect(page.locator("#network-status")).toHaveClass(/offline/);
  await expect(page.locator("#network-panel")).toBeHidden();
});


test("LAN pairing remains usable without a local operator presence request", async ({ page }) => {
  let presenceRequests = 0, pairingRequests = 0;
  await page.route("http://kiosk.invalid/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/health") return route.fulfill({ json: { paired: false } });
    if (url.pathname === "/operator-presence") { presenceRequests++; return route.fulfill({ status: 403, json: { error: "Local display only" } }); }
    if (url.pathname === "/pair") { pairingRequests++; return route.fulfill({ status: 201, json: { kioskName: "Synthetic paired kiosk" } }); }
    const response = await route.fetch({ url: kioskBaseUrl + url.pathname });
    return route.fulfill({ response });
  });
  await page.goto("http://kiosk.invalid/");
  await expect(page.locator("#pairing-panel")).toBeVisible();
  await page.locator("#pairing-key").fill("synthetic-pairing-input");
  await page.locator("#pair-form button").click();
  await expect(page.locator("#pair-result")).toContainText("Paired Synthetic paired kiosk");
  expect(pairingRequests).toBe(1); expect(presenceRequests).toBe(0);
});


for (const authenticationMethod of ["rfid", "qr", "member_id"]) test(`${authenticationMethod} buffered identity clears when network settings suspend attendance`, async ({ page }) => {
  let displayId = "ready", submitted = 0;
  await page.route(`${kioskBaseUrl}/display-state`, async route => {
    const response = await route.fetch(); const state = await response.json();
    await route.fulfill({ response, json: { ...state, authenticationMethod, display: { id: displayId, message: "Enter identity", detail: "Synthetic input" } } });
  });
  await page.route(`${kioskBaseUrl}/identity`, route => { submitted++; return route.fulfill({ json: { accepted: true } }); });
  await page.goto(`${kioskBaseUrl}/`);
  const input = page.locator("#identity-value");
  await expect(input).toBeVisible(); await input.fill("synthetic-partial-input");
  await page.locator("#network-status").focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#network-panel")).toBeVisible();
  await expect(input).toBeHidden(); await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "Close network settings" }).click();
  await expect(input).toBeVisible(); await expect(input).toHaveValue("");
  await input.fill("another-partial-input");
  displayId = "processing";
  await expect(input).toBeHidden(); await expect(input).toHaveValue("");
  displayId = "ready";
  await expect(input).toBeVisible(); await expect(input).toHaveValue("");
  expect(submitted).toBe(0);
});

test("failed network close keeps attendance retry usable after network lease renewal", async ({ page }) => {
  const presenceRequests: { action: string; mode: string }[] = [];
  let rejectClose = true;
  await page.route(`${kioskBaseUrl}/operator-presence`, route => {
    const input = route.request().postDataJSON(); presenceRequests.push(input);
    if (input.action === "transition" && input.mode === "attendance" && rejectClose) {
      rejectClose = false;
      return route.fulfill({ status: 409, json: { error: "Page session changed. Retry attendance." } });
    }
    return route.fulfill({ json: { pageId: input.pageId, generation: input.generation ?? 1, mode: input.mode, captureSuspended: input.mode !== "attendance", reason: input.mode === "attendance" ? null : "operator_active", expiresInMs: 15000 } });
  });
  await page.goto(`${kioskBaseUrl}/`);
  await page.locator("#network-status").focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#network-panel")).toBeVisible();
  await page.getByRole("button", { name: "Close network settings" }).click();
  await expect(page.locator("#network-panel")).toBeHidden();
  await expect(page.locator("#retry-attendance")).toBeVisible();
  await expect.poll(() => presenceRequests.some(value => value.action === "renew" && value.mode === "network"), { timeout: 7000 }).toBe(true);
  await expect(page.locator("#retry-attendance")).toBeVisible();
  await page.locator("#retry-attendance").click();
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader");
  await expect(page.locator("#retry-attendance")).toBeHidden();
  expect(presenceRequests.at(-1)).toMatchObject({ action: "enter", mode: "attendance" });
});

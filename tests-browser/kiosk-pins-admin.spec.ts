import { expect, test, type Page, type Request, type Route } from "@playwright/test";

// Web kiosk phase 3 on the dashboard: Require PIN, PIN requests, the member Kiosk PIN card and the PIN lockout setting,
// against the dashboard preview API's per-scenario PIN state. Test Student A (A-101) has a PIN; Test Student B (A-102)
// has one locked after five wrong tries. Every name and value is synthetic.
const mockApi = `http://127.0.0.1:${Number(process.env.LANCERLOGIN_BROWSER_PORT_BASE ?? 43_173) + 1}`;
const students: Record<string, { rosterId: string; lastName: string }> = { "A-101": { rosterId: "member-1", lastName: "Student A" }, "A-102": { rosterId: "member-2", lastName: "Student B" } };

async function useScenario(page: Page, id: string, role: "admin" | "operator" = "admin") {
  const scenario = `kiosk-pins-admin-${id}`;
  const writes: Request[] = [];
  const tag = async (route: Route) => {
    if (route.request().method() !== "GET") writes.push(route.request());
    await route.continue({ headers: { ...route.request().headers(), "x-preview-scenario": scenario } });
  };
  for (const pattern of ["**/admin/kiosks", "**/admin/kiosks/*", "**/admin/kiosks/*/*", "**/admin/pin-requests/*/*", "**/admin/members/*/pin", "**/admin/members/*/pin/unlock", "**/admin/settings/pin-lockout"]) await page.route(pattern, tag);
  // The preview roster's members get synthetic test names on their member pages.
  for (const [memberId, student] of Object.entries(students)) await page.route(`**/admin/members/${memberId}/history`, async (route) => {
    const response = await route.fetch(); const json = await response.json();
    await route.fulfill({ response, json: { ...json, member: { ...json.member, firstName: "Test", lastName: student.lastName, email: `${student.lastName.toLowerCase().replace(" ", ".")}@example.test` } } });
  });
  if (role === "operator") await page.route("**/auth/session", (route) => route.fulfill({ json: { user: { id: "operator-1", role: "operator", debugMode: false } } }));
  /** A kiosk asking for approval, as the web kiosk does when a member without a PIN taps Ask for approval. */
  const askForPin = async (kioskId: string, memberId: keyof typeof students, minutesAgo = 0) => {
    const response = await page.request.post(`${mockApi}/preview/pin-requests`, { headers: { "x-preview-scenario": scenario }, data: { kioskId, memberId: students[memberId]!.rosterId, firstName: "Test", lastName: students[memberId]!.lastName, minutesAgo } });
    expect(response.status()).toBe(201);
  };
  return { writes, askForPin };
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("Require PIN saves with the method, hides the no-PIN warning and shows in the kiosk summary", async ({ page }, testInfo) => {
  const { writes } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await page.goto("/kiosks/web-kiosk-a/manage");
  await expect(page.locator(".kiosk-summary")).toContainText("Require PINOff");
  await page.getByText("Identification", { exact: true }).click();
  const requirePin = page.getByRole("checkbox", { name: "Require PIN", exact: true });
  await expect(requirePin).not.toBeChecked();
  await expect(requirePin).toHaveAccessibleDescription("Members enter a 4 to 6 digit PIN after confirming their name.");
  const warning = page.locator(".kiosk-authentication-form .warning-callout");
  await expect(warning).toHaveText("Without a PIN, anyone can sign in someone else. Use Require PIN or a fingerprint kiosk where that matters.");
  const save = page.getByRole("button", { name: "Save method" });
  await expect(save).toBeDisabled();

  await requirePin.check();
  await expect(warning).toHaveCount(0);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "selected for" })).toHaveText("Member ID entry with Require PIN selected for Test web kiosk A. It will use this method after its next sync.");
  await expect(page.locator(".kiosk-summary")).toContainText("Require PINOn");
  await expect(save).toBeDisabled();
  await expect(requirePin).toBeChecked();
  expect(writes.filter((request) => request.url().endsWith("/authentication-method")).map((request) => request.postDataJSON())).toEqual([{ authenticationMethod: "member_id", memberLookup: "entry", requirePin: true }]);

  // Turning it off brings the warning back and saves false.
  await requirePin.uncheck();
  await expect(warning).toBeVisible();
  await save.click();
  await expect(page.locator(".kiosk-summary")).toContainText("Require PINOff");
  expect(writes.filter((request) => request.url().endsWith("/authentication-method")).map((request) => request.postDataJSON()).at(-1)).toEqual({ authenticationMethod: "member_id", memberLookup: "entry", requirePin: false });
});

test("a Pi kiosk offers Require PIN only with Member ID entry", async ({ page }, testInfo) => {
  const { writes } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await page.goto("/kiosks/kiosk-1/manage");
  await expect(page.locator(".kiosk-summary")).not.toContainText("Require PIN");
  await page.getByText("Identification", { exact: true }).click();
  const requirePin = page.getByRole("checkbox", { name: "Require PIN", exact: true });
  await expect(requirePin).toHaveCount(0);
  await page.getByLabel("Authentication method for selected kiosk").selectOption("member_id");
  await expect(requirePin).not.toBeChecked();
  await requirePin.check();
  await expect(page.locator(".kiosk-authentication-form .warning-callout")).toHaveCount(0);
  await page.getByRole("button", { name: "Save method" }).click();
  await expect(page.getByRole("status").filter({ hasText: "selected for" })).toHaveText("Member ID entry with Require PIN selected for Front desk. It will use this method after its next sync.");
  await expect(page.locator(".kiosk-summary")).toContainText("Require PINOn");
  await page.getByLabel("Authentication method for selected kiosk").selectOption("qr");
  await expect(requirePin).toHaveCount(0);
  expect(writes.filter((request) => request.url().endsWith("/authentication-method")).map((request) => request.postDataJSON())).toEqual([{ authenticationMethod: "member_id", memberLookup: "entry", requirePin: true }]);
});

test("pending PIN requests appear on Manage kiosk, refresh while open, and leave once approved or declined", async ({ page }, testInfo) => {
  const { writes, askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await page.goto("/kiosks/web-kiosk-a/manage");
  await expect(page.getByRole("heading", { name: "Manage kiosk" })).toBeVisible();
  await expect(page.locator(".kiosk-summary")).toBeVisible();
  await expect(page.getByRole("heading", { name: "PIN requests" })).toHaveCount(0);

  await askForPin("web-kiosk-a", "A-102", 2);
  const card = page.locator(".kiosk-pin-requests");
  // The page asks again every 10 seconds.
  await expect(card.getByRole("heading", { name: "PIN requests" })).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".status-pill")).toHaveText("1 waiting");
  await expect(card.locator(".kiosk-pin-request")).toHaveText(/^Test Student B · A-102Asked to set up a PIN · 2 minutes agoDeclineApprove$/);
  await expect(card).toContainText("Approving lets the member choose a PIN on the kiosk within 5 minutes. Admins and Operators can approve.");

  await askForPin("web-kiosk-a", "A-101");
  await expect(card.locator(".status-pill")).toHaveText("2 waiting", { timeout: 15_000 });
  await expect(card.getByRole("group", { name: "PIN request from Test Student A" })).toBeVisible();
  await expect(card.locator(".kiosk-pin-request").nth(1)).toContainText("Asked to set up a PIN · less than a minute ago");

  await card.getByRole("group", { name: "PIN request from Test Student B" }).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved" })).toHaveText("Approved. Test Student B can choose a PIN on the kiosk within 5 minutes.");
  await expect(card.getByRole("group", { name: "PIN request from Test Student B" })).toHaveCount(0);
  await expect(card.locator(".status-pill")).toHaveText("1 waiting");

  await card.getByRole("group", { name: "PIN request from Test Student A" }).getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Declined" })).toHaveText("Declined Test Student A's PIN request.");
  await expect(page.getByRole("heading", { name: "PIN requests" })).toHaveCount(0);
  expect(writes.filter((request) => request.url().includes("/admin/pin-requests/")).map((request) => new URL(request.url()).pathname)).toEqual(["/admin/pin-requests/pin-request-1/approve", "/admin/pin-requests/pin-request-2/decline"]);

  // Requests belong to their kiosk.
  await askForPin("web-kiosk-a", "A-101");
  await page.goto("/kiosks/web-kiosk-b/manage");
  await expect(page.locator(".kiosk-summary")).toBeVisible();
  await expect(page.getByRole("heading", { name: "PIN requests" })).toHaveCount(0);
});

test("an answered or expired PIN request shows the error and leaves the list", async ({ page }, testInfo) => {
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await askForPin("web-kiosk-a", "A-102", 1);
  await page.goto("/kiosks/web-kiosk-a/manage");
  const group = page.getByRole("group", { name: "PIN request from Test Student B" });
  await expect(group).toBeVisible();
  // Another Operator answers it first.
  expect((await page.request.post(`${mockApi}/admin/pin-requests/pin-request-1/approve`, { headers: { "x-preview-scenario": `kiosk-pins-admin-${testInfo.testId}-${testInfo.retry}` }, data: {} })).status()).toBe(200);
  await group.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("alert")).toHaveText("That PIN request was already answered or has expired.");
  await expect(page.getByRole("heading", { name: "PIN requests" })).toHaveCount(0);
});

for (const width of [390, 1280]) test(`the member Kiosk PIN card shows its state and Reset PIN works at ${width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const { writes } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await page.goto("/roster/A-101");
  await expect(page.getByRole("heading", { name: "Test Student A", level: 1 })).toBeVisible();
  const card = page.locator(".member-kiosk-pin");
  await expect(card.getByRole("heading", { name: "Kiosk PIN" })).toBeVisible();
  await expect(card.locator(".status-pill")).toHaveText("PIN set");
  await expect(card.locator(".kiosk-pin-facts")).toHaveText(/^Set[A-Z][a-z]{2} \d{1,2} at Test web kiosk AWrong tries0$/);
  await expect(card.getByRole("button", { name: "Unlock" })).toHaveCount(0);
  expect(await noSideScroll(page)).toBeTruthy();

  page.once("dialog", (dialog) => { expect(dialog.message()).toBe("Reset Test Student A's PIN? They'll set a new one at a kiosk with an Operator's approval."); void dialog.dismiss(); });
  await card.getByRole("button", { name: "Reset PIN" }).click();
  await expect(card.locator(".status-pill")).toHaveText("PIN set");
  expect(writes).toHaveLength(0);

  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Reset PIN" }).click();
  await expect(card.getByRole("status")).toHaveText("PIN reset. Test Student A sets a new one at a kiosk with an Operator's approval.");
  await expect(card.locator(".status-pill")).toHaveText("No PIN");
  await expect(card).toContainText("No PIN yet. The member sets one at a kiosk that requires a PIN, with an Operator's approval.");
  await expect(card.getByRole("button", { name: "Reset PIN" })).toHaveCount(0);
  expect(writes.map((request) => [request.method(), new URL(request.url()).pathname])).toEqual([["DELETE", "/admin/members/member-1/pin"]]);
});

test("a locked member's PIN shows Locked until and Unlock clears it", async ({ page }, testInfo) => {
  const { writes } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await page.goto("/roster/A-102");
  const card = page.locator(".member-kiosk-pin");
  await expect(card.locator(".status-pill")).toHaveText(/^Locked until (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/); // The date is added when the lock ends on another day.
  await expect(card.locator(".status-pill")).toHaveAttribute("data-tone", "error");
  await expect(card.locator(".kiosk-pin-facts")).toContainText("at Front desk");
  await expect(card.locator(".kiosk-pin-facts")).toContainText("Wrong tries5");
  await card.getByRole("button", { name: "Unlock" }).click();
  await expect(card.getByRole("status")).toHaveText("PIN unlocked. Test Student B can try again now.");
  await expect(card.locator(".status-pill")).toHaveText("PIN set");
  await expect(card.locator(".kiosk-pin-facts")).toContainText("Wrong tries0");
  await expect(card.getByRole("button", { name: "Unlock" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Reset PIN" })).toBeVisible();
  expect(writes.map((request) => [request.method(), new URL(request.url()).pathname])).toEqual([["POST", "/admin/members/member-2/pin/unlock"]]);
});

test("Kiosk PIN lockout saves, validates its ranges and disables the numbers when off", async ({ page }, testInfo) => {
  const { writes } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await page.goto("/settings/configuration");
  const card = page.locator(".kiosk-pin-lockout");
  await expect(card.getByRole("heading", { name: "Kiosk PIN lockout" })).toBeVisible();
  await expect(card.locator(".status-pill")).toHaveText("Off");
  await expect(card).toContainText("Off by default. Applies to every kiosk that requires a PIN. Wrong tries made offline count once the kiosk syncs.");
  const enabled = card.getByRole("checkbox", { name: "Lock a member's PIN after repeated wrong tries" });
  const attempts = card.getByRole("spinbutton", { name: "Wrong tries" }), minutes = card.getByRole("spinbutton", { name: "Lock for (minutes)" });
  await expect(enabled).not.toBeChecked();
  await expect(attempts).toHaveValue("5"); await expect(attempts).toBeDisabled();
  await expect(minutes).toHaveValue("15"); await expect(minutes).toBeDisabled();

  await enabled.check();
  await expect(attempts).toBeEnabled(); await expect(minutes).toBeEnabled();
  const save = card.getByRole("button", { name: "Save", exact: true });
  for (const value of ["2", "21", "4.5"]) {
    await attempts.fill(value); await save.click();
    await expect(card.getByRole("alert")).toHaveText("Wrong tries must be a whole number from 3 to 20.");
    await expect(attempts).toHaveAttribute("aria-invalid", "true");
  }
  await attempts.fill("20");
  for (const value of ["0", "1441"]) {
    await minutes.fill(value); await save.click();
    await expect(card.getByRole("alert")).toHaveText("Lock for must be a whole number of minutes from 1 to 1440.");
    await expect(minutes).toHaveAttribute("aria-invalid", "true");
  }
  await expect(attempts).toHaveAttribute("aria-invalid", "false");
  expect(writes).toHaveLength(0);

  await minutes.fill("30"); await save.click();
  await expect(card.getByRole("status")).toHaveText("Kiosk PIN lockout saved. A PIN locks for 30 minutes after 20 wrong tries.");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card.locator(".status-pill")).toHaveText("On");

  await enabled.uncheck();
  await expect(attempts).toBeDisabled(); await expect(minutes).toBeDisabled();
  await save.click();
  await expect(card.getByRole("status")).toHaveText("Kiosk PIN lockout saved. It is off.");
  await expect(card.locator(".status-pill")).toHaveText("Off");
  expect(writes.map((request) => [request.method(), request.postDataJSON()])).toEqual([["PUT", { enabled: true, attempts: 20, minutes: 30 }], ["PUT", { enabled: false, attempts: 20, minutes: 30 }]]);

  await page.reload();
  await expect(card.locator(".status-pill")).toHaveText("Off");
  await expect(attempts).toHaveValue("20"); await expect(minutes).toHaveValue("30");
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await noSideScroll(page)).toBeTruthy();
});

test("Operators approve PIN requests and reset PINs but don't get the lockout setting", async ({ page }, testInfo) => {
  const { writes, askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`, "operator");
  await askForPin("web-kiosk-a", "A-102");
  await page.goto("/kiosks/web-kiosk-a/manage");
  await expect(page.getByText("Identification", { exact: true })).toHaveCount(0);
  await page.getByRole("group", { name: "PIN request from Test Student B" }).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved" })).toHaveText("Approved. Test Student B can choose a PIN on the kiosk within 5 minutes.");

  await page.goto("/roster/A-101");
  const card = page.locator(".member-kiosk-pin");
  await expect(card.locator(".status-pill")).toHaveText("PIN set");
  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Reset PIN" }).click();
  await expect(card.locator(".status-pill")).toHaveText("No PIN");
  expect(writes.map((request) => [request.method(), new URL(request.url()).pathname])).toEqual([["POST", "/admin/pin-requests/pin-request-1/approve"], ["DELETE", "/admin/members/member-1/pin"]]);

  await page.goto("/settings/configuration");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Kiosk PIN lockout" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Lock a member's PIN after repeated wrong tries" })).toHaveCount(0);
});

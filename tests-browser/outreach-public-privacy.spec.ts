import { expect, test, type Page } from "@playwright/test";

type Mode = "off" | "validity" | "name";
const activity = { id: "event-1", title: "Synthetic community drive", serviceDate: "2026-09-28", location: "Library", reopened: false };
async function publicPage(page: Page, initial: Mode, appearance = "light") {
  const state = { mode: initial, lookups: [] as Record<string, unknown>[], corrections: [] as Record<string, unknown>[], submissions: [] as Record<string, unknown>[], failSubmission: false, failCorrection: false };
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Robotics", primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance, timeZone: "America/New_York", logoBackdrop: "auto" } } }));
  await page.route("**/public/hours/context", route => route.fulfill({ json: { organizationName: "Synthetic Robotics", timeZone: "America/New_York", today: "2026-09-28", earliestServiceDate: "2026-08-30", reportingDays: 30, memberValidation: state.mode } }));
  await page.route(/\/public\/hours\/(?:activities|correction-activities)(?:\?.*)?$/, route => route.fulfill({ json: { items: [activity], nextCursor: null } }));
  await page.route("**/public/hours/member-validation", route => {
    const body = route.request().postDataJSON() as Record<string, unknown>; state.lookups.push(body);
    const valid = body.memberExternalId === "M-001";
    return route.fulfill({ json: state.mode === "off" ? { mode: "off" } : { mode: state.mode, valid, ...(state.mode === "name" && valid ? { name: "Synthetic Avery Member" } : {}) } });
  });
  await page.route("**/public/hours/entries", route => {
    const body = route.request().postDataJSON() as Record<string, unknown>; state.submissions.push(body);
    return state.failSubmission
      ? route.fulfill({ status: 400, json: { error: "No active roster member matches that ID. Check the member ID and try again.", code: "identity_not_verified", retryExact: false } })
      : route.fulfill({ status: 201, json: { id: "internal-receipt", serviceDate: body.serviceDate, startLocal: body.startLocal, endLocal: body.endLocal, durationMinutes: 60 } });
  });
  await page.route("**/public/hours/corrections", route => {
    const body = route.request().postDataJSON() as Record<string, unknown>; state.corrections.push(body);
    return state.failCorrection
      ? route.fulfill({ status: 503, json: { error: "The result could not be confirmed.", retryExact: true } })
      : route.fulfill({ status: 202, json: { reference: "internal-request", status: "open" } });
  });
  return state;
}

test("Off makes no lookup and the public browser never receives a roster list", async ({ page }) => {
  const state = await publicPage(page, "off"); const requests: string[] = []; const consoleMessages: string[] = [];
  page.on("request", request => { if (["fetch", "xhr"].includes(request.resourceType())) requests.push(request.url()); }); page.on("console", message => consoleMessages.push(message.text()));
  await page.goto("/submit-hours");
  await page.getByLabel("Roster member ID").fill("M-001"); await page.getByLabel("Dated activity").focus();
  expect(state.lookups).toEqual([]); await expect(page.locator("#public-member-validation")).toHaveCount(0);
  expect(requests.some(url => /\/roster|\/member-choices|\/members/.test(url))).toBe(false);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("M-001");
  expect(consoleMessages.join("\n")).not.toMatch(/M-001|Synthetic Avery Member/);
});

test("ID-only checks one entered ID on blur and exposes no hidden name", async ({ page }) => {
  const state = await publicPage(page, "validity");
  await page.goto("/submit-hours");
  const id = page.getByLabel("Roster member ID"); await id.fill("BAD-ID"); expect(state.lookups).toEqual([]);
  await page.getByLabel("Dated activity").focus();
  await expect(page.locator("#public-member-validation")).toHaveText(/No active roster member matches/);
  await expect(id).toHaveAttribute("aria-invalid", "true");
  await id.fill("M-001"); await page.keyboard.press("Tab");
  await expect(page.locator("#public-member-validation")).toHaveText("Member ID confirmed.");
  expect(state.lookups).toEqual([{ memberExternalId: "BAD-ID" }, { memberExternalId: "M-001" }]);
  expect(await page.content()).not.toContain("Synthetic Avery Member");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/BAD-ID|M-001|Synthetic Avery Member/);
});

test("name permission is cleared on editing and a server-disabled lookup returns no result", async ({ page }) => {
  const state = await publicPage(page, "name");
  await page.goto("/submit-hours"); await page.getByLabel("Roster member ID").fill("M-001"); await page.keyboard.press("Tab");
  await expect(page.locator("#public-member-validation")).toHaveText("Member: Synthetic Avery Member");
  state.mode = "off";
  await page.getByLabel("Roster member ID").focus(); await expect(page.locator("#public-member-validation")).toHaveCount(0);
  await page.keyboard.press("Tab"); await expect(page.locator("#public-member-validation")).toHaveCount(0);
  await page.getByLabel("Roster member ID").fill("OTHER"); await page.keyboard.press("Tab");
  expect(state.lookups).toHaveLength(2);
  expect(await page.content()).not.toContain("Synthetic Avery Member");
});

async function chooseClock(page: Page, label: string, hour: number) {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click(); const dialog = page.getByRole("dialog", { name: label });
  await dialog.getByRole("button", { name: `${hour} o'clock` }).click(); await dialog.getByRole("button", { name: "0 minutes", exact: true }).click(); await dialog.getByRole("group", { name: "Choose AM or PM" }).getByRole("button", { name: "AM", exact: true }).click();
}

test("known rejection permits a corrected submission instead of suggesting uncertain replay", async ({ page }) => {
  const state = await publicPage(page, "off"); state.failSubmission = true;
  await page.goto("/submit-hours"); await page.getByLabel("Roster member ID").fill("BAD-ID");
  await page.getByLabel("Dated activity").selectOption(activity.id); await chooseClock(page, "Start time", 9); await chooseClock(page, "End time", 10);
  await page.getByRole("button", { name: "Record completed participation" }).click();
  await expect(page.getByRole("alert")).toHaveText(/No active roster member matches that ID/);
  await expect(page.getByRole("button", { name: "Retry exact submission" })).toHaveCount(0);
  state.failSubmission = false; await page.getByLabel("Roster member ID").fill("M-001");
  await page.getByRole("button", { name: "Record completed participation" }).click();
  await expect(page.getByRole("heading", { name: "Participation recorded" })).toBeVisible();
  expect(state.submissions[0].idempotencyKey).not.toBe(state.submissions[1].idempotencyKey);
});

for (const appearance of ["light", "dark"]) test(`event correction uses themed controls and preserves exact retry in ${appearance}`, async ({ page }) => {
  const state = await publicPage(page, "off", appearance); state.failCorrection = true;
  await page.setViewportSize({ width: appearance === "light" ? 1280 : 390, height: appearance === "light" ? 900 : 844 });
  await page.goto("/submit-hours"); await page.getByRole("button", { name: "Request a correction instead" }).click();
  await expect(page.getByLabel("Outreach activity")).toHaveValue(""); await page.getByLabel("Outreach activity").selectOption(activity.id);
  await expect(page.getByLabel(/receipt/i)).toHaveCount(0);
  await page.getByLabel("Roster member ID").fill("M-001"); await page.getByLabel("What should Staff review?").fill("I stayed until 10:30.");
  const button = page.getByRole("button", { name: "Send correction request" });
  const dimensions = await button.evaluate(element => { const style = getComputedStyle(element); return { height: element.getBoundingClientRect().height, radius: style.borderRadius, background: style.backgroundColor, color: style.color }; });
  expect(dimensions.height).toBeGreaterThanOrEqual(44); expect(dimensions.radius).not.toBe("0px"); expect(dimensions.background).not.toBe("rgba(0, 0, 0, 0)"); expect(dimensions.color).not.toBe(dimensions.background);
  const select = page.getByLabel("Outreach activity");
  expect(await select.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(await page.getByLabel("What should Staff review?").evaluate(element => getComputedStyle(element).backgroundColor));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await button.focus(); await expect(button).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Retry exact request" })).toBeEnabled(); await expect(button).toBeDisabled();
  state.failCorrection = false; await page.getByRole("button", { name: "Retry exact request" }).click();
  await expect(page.getByRole("heading", { name: "Correction request received" })).toBeVisible();
  expect(state.corrections).toHaveLength(2); expect(state.corrections[1]).toEqual(state.corrections[0]);
  expect(state.corrections[0]).toMatchObject({ memberExternalId: "M-001", activityId: activity.id }); expect(state.corrections[0]).not.toHaveProperty("receiptId");
});

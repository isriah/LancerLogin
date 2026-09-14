import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences as refs } from "../apps/dashboard/src/design-conformance";
import type { Meeting } from "../apps/dashboard/src/meeting-management";

async function freshInputStep(page: Page, hardware = false) {
  const settings = { organizationName: "Reference Arts Collective", primaryColor: refs.brand.primary, secondaryColor: refs.brand.secondary, appearance: "system", logoBackdrop: "auto", lateScanMinutes: 30 };
  const completed = ["branding", "roster", "pair-kiosk"];
  const meetings: Meeting[] = [];
  const scans: string[] = [];
  let rejectCreate = false;
  let failRefreshAfterCreate = false;
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/setup/status", r => r.fulfill(json({ configured: true, installation: { authMode: "local" }, settings })));
  await page.route("**/auth/session", r => r.fulfill(json({ user: { role: "admin" } })));
  await page.route("**/admin/branding", r => r.fulfill(json({ settings })));
  await page.route("**/admin/setup/progress", r => {
    if (r.request().method() === "PATCH") completed.push(r.request().postDataJSON().step);
    return r.fulfill(json({ completedSteps: completed.map(step => ({ step })) }));
  });
  await page.route("**/admin/members", r => r.fulfill(json({ members: [{ memberId: "TRANS001", externalId: "TRANS001", firstName: "Rehearsal", lastName: "One", active: 1 }] })));
  await page.route("**/admin/kiosks", r => r.fulfill(json({ kiosks: hardware ? [{ id: "pi", name: "Main kiosk", active: 1 }] : [] })));
  await page.route("**/meeting-weight-categories", r => r.fulfill(json({ categories: [] })));
  await page.route("**/meetings", r => {
    if (r.request().method() === "POST") {
      if (rejectCreate) return r.fulfill(json({ error: "Meeting overlaps an existing attendance window" }, 400));
      const input = r.request().postDataJSON();
      expect(input.recurrence).toBeUndefined();
      expect(Date.parse(input.startsAt)).toBeLessThanOrEqual(Date.now());
      meetings.push({ ...input, id: `meeting-${meetings.length + 1}`, attendanceClosesAt: new Date(Date.parse(input.endsAt) + 30 * 60_000).toISOString() });
    }
    if (failRefreshAfterCreate && meetings.length && r.request().method() === "GET") return r.fulfill(json({ error: "Schedule unavailable" }, 503));
    return r.fulfill(json({ meetings: r.request().method() === "POST" ? [meetings[meetings.length - 1]] : meetings }));
  });
  await page.route("**/admin/simulator", r => {
    if (r.request().method() === "POST") {
      const input = r.request().postDataJSON();
      expect(input).toEqual({ action: "scan", scanAction: scans.length === 0 ? "check_in" : "check_out", meetingId: "meeting-1", memberId: "TRANS001" });
      expect(completed).not.toContain("confirm-attendance");
      scans.push(input.scanAction);
    }
    return r.fulfill(json({ simulator: hardware ? null : { name: "Browser rehearsal", active: 1, online: 1, readerOnline: false } }));
  });
  await page.route("**/attendance?*", r => {
    expect(new URL(r.request().url()).searchParams.get("meetingId")).toBe("meeting-1");
    return r.fulfill(json({ attendance: [{ memberId: "TRANS001", externalId: "TRANS001", firstName: "Rehearsal", lastName: "One", disposition: scans.length === 2 ? "present" : "absent" }] }));
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 2, name: "Kiosk input test", exact: true })).toBeVisible();
  return { completed, meetings, scans, rejectCreation: () => { rejectCreate = true; }, failCreationRefresh: () => { failRefreshAfterCreate = true; } };
}

async function fillCurrentMeeting(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Create meeting" });
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  await dialog.getByLabel("Title", { exact: true }).fill("Synthetic attendance rehearsal");
  await dialog.getByLabel("Date", { exact: true }).fill(date);
  await dialog.getByLabel("Start time", { exact: true }).fill("00:00");
  await dialog.getByLabel("End time", { exact: true }).fill("23:59");
  return dialog;
}

async function fit(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator("main h1").count()).toBe(1);
}

for (const viewport of refs.viewports) for (const theme of refs.themes) {
  test(`empty onboarding creates meeting and verifies simulator attendance at ${viewport.width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await page.addInitScript(t => localStorage.setItem("lancerlogin-theme", t), theme);
    const state = await freshInputStep(page);
    await expect(page.getByText(/No meetings are available yet/)).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
    const create = page.getByRole("button", { name: "Create meeting", exact: true });
    await create.focus();
    expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create meeting" });
    await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
    await fit(page);
    await page.screenshot({ path: test.info().outputPath("first-meeting-dialog.png"), fullPage: true });
    await fillCurrentMeeting(page);
    await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();
    await expect(page.getByRole("combobox", { name: "Meeting", exact: true })).toHaveValue("meeting-1");
    expect(state.completed).toEqual(["branding", "roster", "pair-kiosk"]);
    await expect(page.getByText(/Selected window:/)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("first-meeting-selected.png"), fullPage: true });
    // A different first API result must not overwrite the validated saved choice on reload.
    state.meetings.unshift({ ...state.meetings[0], id: "other", title: "Other meeting" });
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Meeting", exact: true })).toHaveValue("meeting-1");
    await page.getByRole("button", { name: "Send simulated arrival scan" }).click();
    await expect(page.getByRole("button", { name: "Send simulated departure scan" })).toBeVisible();
    expect(state.completed).not.toContain("fingerprint-test");
    await page.getByRole("button", { name: "Send simulated departure scan" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Attendance confirmation", exact: true })).toBeVisible();
    const finish = page.getByRole("button", { name: "Attendance matches — finish setup" });
    await expect(finish).toBeDisabled();
    await page.getByRole("button", { name: "Refresh attendance" }).click();
    await expect(finish).toBeEnabled();
    expect(state.scans).toEqual(["check_in", "check_out"]);
    await finish.click();
    await page.getByRole("dialog", { name: "Setup complete" }).getByRole("button", { name: "Go to Dashboard" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
  });
}

test("onboarding meeting cancel and API rejection preserve incomplete progress and return focus", async ({ page }) => {
  const state = await freshInputStep(page);
  const create = page.getByRole("button", { name: "Create meeting", exact: true });
  await create.click();
  await page.getByRole("dialog", { name: "Create meeting" }).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(create).toBeFocused();
  expect(state.meetings).toEqual([]);
  state.rejectCreation();
  await create.click();
  const dialog = await fillCurrentMeeting(page);
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("overlaps");
  await expect(dialog.getByRole("alert")).toBeFocused();
  expect(state.completed).toEqual(["branding", "roster", "pair-kiosk"]);
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
  await page.getByRole("button", { name: "Attendance confirmation: not complete" }).click();
  await expect(page.getByRole("button", { name: "Attendance matches — finish setup" })).toBeDisabled();
  await page.getByRole("button", { name: "Create meeting", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create meeting" })).toBeVisible();
});

test("hardware onboarding can create first meeting without claiming reader or attendance completion", async ({ page }) => {
  const state = await freshInputStep(page, true);
  await page.getByRole("button", { name: "Create meeting", exact: true }).click();
  const dialog = await fillCurrentMeeting(page);
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Meeting", exact: true })).toHaveValue("meeting-1");
  await expect(page.getByRole("button", { name: "The local reader test passed" })).toBeVisible();
  expect(state.completed).toEqual(["branding", "roster", "pair-kiosk"]);
  expect(state.scans).toEqual([]);
});


test("successful creation with failed schedule refresh closes dialog without inviting duplicate submission", async ({ page }) => {
  const state = await freshInputStep(page);
  state.failCreationRefresh();
  await page.getByRole("button", { name: "Create meeting", exact: true }).click();
  const dialog = await fillCurrentMeeting(page);
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Meeting creation succeeded");
  expect(state.meetings).toHaveLength(1);
  expect(state.completed).toEqual(["branding", "roster", "pair-kiosk"]);
});

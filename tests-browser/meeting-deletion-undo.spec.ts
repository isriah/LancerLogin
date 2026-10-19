import { expect, test, type Page } from "@playwright/test";

const deletion = { meetingIds: ["active-meeting"], deletedAt: "2026-10-18T12:00:00.000Z" };
async function deleteFromDetail(page: Page) {
  await page.route(/\/meetings\/active-meeting$/, async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: 1, deletion }) });
  });
  await page.goto("/meetings/active-meeting");
  await page.locator(".meeting-more-actions > summary").click(); await page.getByRole("button", { name: "Delete meeting", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete meeting" }).getByRole("button", { name: "Delete this meeting", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("status").filter({ hasText: "Build session was deleted." }).getByRole("button", { name: "Undo", exact: true })).toBeVisible();
}

test("detail Undo stays available during the current page and disappears after navigation or reload", async ({ page }) => {
  await page.clock.install();
  await deleteFromDetail(page);
  await page.clock.fastForward(31_000);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  const storage = await page.evaluate(() => ({ session: Object.keys(sessionStorage), local: Object.keys(localStorage) }));
  expect([...storage.session, ...storage.local].filter(key => /delet|undo/i.test(key))).toEqual([]);
  await page.getByRole("navigation", { name: "Primary dashboard navigation" }).getByRole("link", { name: "Roster", exact: true }).click();
  await page.getByRole("navigation", { name: "Primary dashboard navigation" }).getByRole("link", { name: "Meetings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await deleteFromDetail(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
});

test("failed Undo remains retryable and double clicks send one restoration with the exact deletion batch", async ({ page }) => {
  const bodies: unknown[] = [];
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/meetings/active-meeting/restore", async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) { await pending; await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Meeting attendance windows now overlap." }) }); }
    else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ restored: 1 }) });
  });
  await deleteFromDetail(page);
  await page.getByRole("button", { name: "Undo", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.getByRole("button", { name: "Restoring…", exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole("status").filter({ hasText: "Undo failed: Meeting attendance windows now overlap." })).toBeVisible();
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeEnabled(); await undo.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "1 meeting was restored." })).toBeVisible();
  await expect(undo).toHaveCount(0);
  expect(bodies).toEqual([{ scope: "occurrence", deletion }, { scope: "occurrence", deletion }]);
});

test("bulk deletion places Undo in its success message and restores only confirmed deleted meetings", async ({ page }) => {
  const now = Date.now(); const meeting = { id: "active-meeting", title: "Synthetic planning", startsAt: new Date(now).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(), attendanceClosesAt: new Date(now + 5_400_000).toISOString(), required: 1 };
  let meetings = [meeting]; let deletions = 0; let restorations = 0;
  await page.route("**/meetings", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meetings }) }));
  await page.route("**/meetings/bulk-delete", async route => {
    deletions += 1; meetings = [];
    expect(route.request().postDataJSON()).toEqual({ meetingIds: ["active-meeting"], confirmation: "DELETE SELECTED MEETINGS" });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: 1, deletion }) });
  });
  await page.route("**/meetings/active-meeting/restore", async route => {
    restorations += 1; meetings = [meeting];
    expect(route.request().postDataJSON()).toEqual({ scope: "selection", deletion });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ restored: 1, calendarDelivery: { google_calendar: { synced: 0, queued: 1, failed: 0 }, discord: { synced: 0, queued: 0, skipped: 0, failed: 0 } } }) });
  });
  await page.goto("/dashboard"); await page.getByRole("radio", { name: "Table", exact: true }).check();
  await page.getByLabel("Select Synthetic planning", { exact: true }).check();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete selected (1)", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole("status").filter({ hasText: "1 selected meetings deleted." }).getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await expect(page.getByLabel("Select Synthetic planning", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Select Synthetic planning", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "1 meeting was restored. Calendar delivery: Google Calendar is queued." })).toBeVisible();
  expect(deletions).toBe(1); expect(restorations).toBe(1);
});

test("a successful restore followed by a list-refresh error reports the saved outcome accurately", async ({ page }) => {
  await deleteFromDetail(page);
  await page.route("**/meetings/active-meeting/restore", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ restored: 1 }) }));
  await page.route("**/meetings", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) }));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 meeting was restored. Refresh Dashboard to see the latest meeting list." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Undo and the expanded calendar heading fit ${viewport.width}px in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport); await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme); await deleteFromDetail(page);
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      const undo = page.getByRole("button", { name: "Undo", exact: true }); await undo.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab"); await expect(undo).toBeFocused();
      expect(await undo.evaluate(button => getComputedStyle(button).outlineStyle)).not.toBe("none");
      await undo.hover();
      const rendered = await undo.evaluate(button => {
        const style = getComputedStyle(button); const bounds = button.getBoundingClientRect();
        const token = document.createElement("span"); token.style.cssText = "background:var(--ui-surface);color:var(--ui-text);border:1px solid var(--primary);border-radius:var(--radius-control)"; button.append(token);
        const expected = getComputedStyle(token); const appearance = [style.backgroundColor, style.color, style.borderTopColor, style.borderRadius]; const tokens = [expected.backgroundColor, expected.color, expected.borderTopColor, expected.borderRadius]; token.remove();
        return { appearance, tokens, height: bounds.height };
      });
      expect(rendered.appearance).toEqual(rendered.tokens); expect(rendered.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator(".calendar-heading p")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Meeting calendar", exact: true })).toBeVisible();
      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })); expect(widths.scroll).toBeLessThanOrEqual(widths.client);
      await page.screenshot({ path: test.info().outputPath("undo-calendar.png") });
    });
  }
}

import { expect, test, type Page } from "@playwright/test";

type Progress = { pageId: string; version: number; status: string; stepId: string | null };
async function account(page: Page, state: { progress: Progress; fail?: boolean }, role = "admin", debugMode = false) {
  await page.route("**/auth/session", (route) => route.fulfill({ json: { user: { id: `${role}-1`, role, debugMode } } }));
  await page.route("**/auth/walkthroughs/dashboard", async (route) => {
    if (route.request().method() === "PATCH") {
      if (state.fail) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
      state.progress = { ...route.request().postDataJSON(), pageId: "dashboard" };
    }
    await route.fulfill({ json: { progress: state.progress } });
  });
}
const fresh = () => ({ progress: { pageId: "dashboard", version: 1, status: "not_started", stepId: null } as Progress });
const panel = (page: Page) => page.locator(".walkthrough-panel");
const next = (page: Page) => panel(page).getByRole("button", { name: "Next", exact: true }).click();

test("first visit, defer, resume, and permanent dismissal follow the account", async ({ page, browser, baseURL }) => {
  const state = fresh(); await account(page, state); await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "Reset page walkthrough" })).toHaveCount(0);
  await expect(panel(page)).toContainText("Get ready for your next meeting");
  await panel(page).getByRole("button", { name: "Not now" }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole("link", { name: "Roster", exact: true }).click();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await panel(page).getByRole("button", { name: "Start walkthrough" }).click();
  await next(page); await next(page);
  await expect(panel(page)).toContainText("Step 3 of 10");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeFocused();
  await expect.poll(() => state.progress.stepId).toBe("find-meeting");
  const otherContext = await browser.newContext({ baseURL });
  const other = await otherContext.newPage(); await account(other, state); await other.goto("/dashboard");
  await panel(other).getByRole("button", { name: "Resume walkthrough" }).click();
  await expect(panel(other)).toContainText("Step 3 of 10");
  await panel(other).getByRole("button", { name: "Don't show automatically again" }).click();
  await expect.poll(() => state.progress.status).toBe("dismissed");
  await other.reload(); await expect(other.getByRole("button", { name: "Page walkthrough" })).toHaveCount(0); await expect(panel(other)).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("button", { name: "Page walkthrough" })).toHaveCount(0); await expect(panel(page)).toHaveCount(0);
  await otherContext.close();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) for (const theme of ["light", "dark"]) {
  test(`Debug mode resets the current page walkthrough at ${viewport.width} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript((selectedTheme) => localStorage.setItem("lancerlogin-theme", selectedTheme), theme);
    const state = fresh(); state.progress = { pageId: "dashboard", version: 1, status: "completed", stepId: "recurrence" };
    await account(page, state, "operator", true);
    await page.goto("/dashboard");
    const reset = page.getByRole("button", { name: "Reset page walkthrough" });
    await expect(reset).toBeVisible();
    const layout = await reset.evaluate((element) => { const style = getComputedStyle(element); const bounds = element.getBoundingClientRect(); return { position: style.position, bottom: innerHeight - bounds.bottom, left: bounds.left, right: bounds.right, height: bounds.height }; });
    expect(layout.position).toBe("fixed"); expect(layout.bottom).toBeGreaterThanOrEqual(0); expect(layout.left).toBeGreaterThanOrEqual(0); expect(layout.right).toBeLessThanOrEqual(viewport.width); expect(layout.height).toBeGreaterThanOrEqual(44);
    await reset.focus(); expect(await reset.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await reset.hover();
    const colors = await reset.evaluate((element) => { const style = getComputedStyle(element); const probe = document.createElement("button"); probe.style.cssText = "background:var(--ui-surface);color:var(--ui-text);border:1px solid var(--primary);border-radius:var(--radius-control)"; element.parentElement!.append(probe); const expected = getComputedStyle(probe); const result = { actual: [style.backgroundColor, style.color, style.borderTopColor, style.borderTopLeftRadius], expected: [expected.backgroundColor, expected.color, expected.borderTopColor, expected.borderTopLeftRadius] }; probe.remove(); return result; });
    expect(colors.actual).toEqual(colors.expected);
    await reset.click();
    await expect(panel(page)).toContainText("Get ready for your next meeting");
    await expect.poll(() => state.progress).toEqual({ pageId: "dashboard", version: 1, status: "not_started", stepId: null });
    await panel(page).getByRole("button", { name: "Not now" }).click();
    await page.reload(); await expect(panel(page)).toContainText("Get ready for your next meeting");
    await panel(page).getByRole("button", { name: "Not now" }).click();
    await page.goto("/roster");
    await expect(page.getByRole("button", { name: "Reset page walkthrough" })).toBeVisible();
  });
}

test("safe practice restores table state and completes without saving or deleting", async ({ page }) => {
  const state = fresh(); state.progress.status = "completed"; await account(page, state, "admin", true);
  const writes: string[] = [];
  page.on("request", (request) => { if (["POST", "PATCH", "DELETE"].includes(request.method()) && !request.url().includes("/auth/walkthroughs/")) writes.push(request.url()); });
  await page.goto("/dashboard");
  await page.getByRole("radio", { name: "Table", exact: true }).check();
  await page.getByRole("searchbox", { name: "Search Meetings" }).fill("Build");
  const selected = page.getByRole("checkbox", { name: "Select Build session", exact: true }); await selected.check();
  await page.getByRole("button", { name: "Reset page walkthrough" }).click(); await panel(page).getByRole("button", { name: "Start walkthrough" }).click();
  await next(page);
  await page.getByRole("button", { name: "Show next five weeks" }).click(); await page.getByRole("button", { name: "Today", exact: true }).click();
  await next(page); await next(page);
  await page.getByRole("radio", { name: "Table", exact: true }).check(); await next(page);
  await page.getByRole("searchbox", { name: "Search Meetings" }).fill("no-match");
  await expect(page.locator(".empty-state")).toContainText("No meetings match");
  await page.getByRole("searchbox", { name: "Search Meetings" }).fill(""); await next(page);
  await selected.uncheck();
  await expect(page.locator('[data-walkthrough="meeting-delete"]')).toBeDisabled();
  // Bypass the disabled presentation to verify the handler's independent guard.
  await page.locator('[data-walkthrough="meeting-delete"]').evaluate((button: HTMLButtonElement) => { button.disabled = false; button.click(); });
  await next(page); await expect(page.locator(".walkthrough-practice-note")).toBeVisible();
  await next(page); await page.getByRole("textbox", { name: "Title", exact: true }).fill("Practice only");
  await page.locator("#meeting-create-form").evaluate((form: HTMLFormElement) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await next(page); await next(page);
  await page.getByRole("combobox", { name: "Frequency", exact: true }).selectOption("weekly");
  await expect(page.getByLabel("Series end date")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create recurring series", includeHidden: true })).toBeDisabled();
  await next(page); await panel(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Table", exact: true })).toBeChecked();
  await expect(page.getByRole("searchbox", { name: "Search Meetings" })).toHaveValue("Build"); await expect(selected).toBeChecked();
  expect(writes).toEqual([]); await expect.poll(() => state.progress.status).toBe("completed");
  await page.reload(); await expect(page.getByRole("button", { name: "Page walkthrough" })).toHaveCount(0); await expect(panel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Add meeting", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Create meeting", exact: true })).toBeEnabled();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) for (const theme of ["light", "dark"]) {
  test(`empty account walkthrough, keyboard and theme at ${viewport.width} ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), theme);
    const state = fresh(); await account(page, state, "operator");
    await page.route(/\/meetings$/, (route) => route.fulfill({ json: { meetings: [] } }));
    await page.route("**/labels", (route) => route.fulfill({ json: { labels: [] } }));
    await page.goto("/dashboard"); await panel(page).getByRole("button", { name: "Start walkthrough" }).click();
    if (viewport.width === 390) await expect(page.locator(".primary-navigation.mobile-open")).toBeVisible();
    for (let index = 0; index < 10; index++) {
      await expect(panel(page)).toContainText(`Step ${index + 1} of 10`);
      await expect(panel(page).getByRole("heading")).toBeFocused();
      if (index === 0) {
        await page.keyboard.press("Shift+Tab");
        await expect(panel(page).getByRole("button", { name: "Don't show automatically again" })).toBeFocused();
      }
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !document.activeElement?.closest("[inert]"))).toBe(true);
      const bounds = await panel(page).boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
      if (index === 8) {
        await page.getByRole("radio", { name: "Selected labels", exact: true }).check();
        await expect(page.getByText("No labels are available. Create one in Settings → Attendance first.")).toBeVisible();
        await page.getByRole("radio", { name: "All members", exact: true }).check();
      }
      if (index === 0 || index === 8) await page.screenshot({ path: test.info().outputPath(`step-${index + 1}.png`) });
      const button = panel(page).getByRole("button", { name: "Next", exact: true });
      await button.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
      await expect(button).toBeFocused(); await button.hover();
      expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      const styles = await button.evaluate((element) => { const style = getComputedStyle(element); const probe = document.createElement("button"); probe.style.cssText = "background:var(--primary);color:var(--on-primary);border:1px solid var(--primary);border-radius:var(--radius-control)"; element.parentElement!.append(probe); const expected = getComputedStyle(probe); const result = { actual: [style.backgroundColor, style.color, style.borderTopColor, style.borderTopLeftRadius], expected: [expected.backgroundColor, expected.color, expected.borderTopColor, expected.borderTopLeftRadius], height: element.getBoundingClientRect().height }; probe.remove(); return result; });
      expect(styles.actual).toEqual(styles.expected); expect(styles.height).toBeGreaterThanOrEqual(44);
      await next(page);
    }
    await expect(panel(page)).toContainText("You're ready");
    await panel(page).getByRole("button", { name: "Add meeting", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Create meeting", exact: true })).toBeVisible();
  });
}

test("saving failures remain visible after exit and never trap the user", async ({ page }) => {
  const state = { ...fresh(), fail: true }; await account(page, state); await page.goto("/dashboard");
  await panel(page).getByRole("button", { name: "Start walkthrough" }).click();
  await expect(panel(page)).toContainText("Could not save walkthrough progress");
  await next(page); await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0); await expect(page.getByText(/Could not save walkthrough progress/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeFocused();
});

test("queued progress writes stop when the Dashboard unmounts", async ({ page }) => {
  const state = fresh(); await account(page, state);
  let releaseSave!: () => void;
  const pending = new Promise<void>((resolve) => { releaseSave = resolve; });
  const writes: string[] = [];
  await page.route("**/auth/walkthroughs/dashboard", async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postDataJSON().stepId);
      await pending;
    }
    await route.fulfill({ json: { progress: state.progress } });
  });
  await page.goto("/dashboard");
  await panel(page).getByRole("button", { name: "Start walkthrough" }).click();
  await expect.poll(() => writes.length).toBe(1);
  await next(page); await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Roster", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Roster", exact: true })).toBeVisible();
  const finished = page.waitForResponse((response) => response.url().endsWith("/auth/walkthroughs/dashboard") && response.request().method() === "PATCH");
  releaseSave(); await finished;
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  expect(writes).toEqual(["navigation"]);
});

test("invitation waits for a successful page load and leaves a real draft untouched", async ({ page }) => {
  const state = fresh(); await account(page, state);
  let releaseProgress!: () => void;
  const pending = new Promise<void>((resolve) => { releaseProgress = resolve; });
  await page.route("**/auth/walkthroughs/dashboard", async (route) => { await pending; await route.fulfill({ json: { progress: state.progress } }); });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Add meeting", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("My unsaved meeting");
  releaseProgress();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("My unsaved meeting");
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel(page)).toContainText("Get ready for your next meeting");
  await page.route(/\/meetings$/, (route) => route.fulfill({ status: 503, json: { error: "Meeting service is unavailable." } }));
  await page.reload(); await expect(page.getByText("Meeting service is unavailable.")).toBeVisible(); await expect(panel(page)).toHaveCount(0);
});

test("setup and a pending Undo take precedence over the invitation", async ({ page }) => {
  await account(page, fresh());
  await page.route("**/admin/setup/progress", (route) => route.fulfill({ json: { completedSteps: [] } }));
  await page.goto("/dashboard"); await expect(page.getByRole("heading", { name: "Guided setup", exact: true })).toBeVisible(); await expect(panel(page)).toHaveCount(0);
  await page.unroute("**/admin/setup/progress");
  await page.clock.install();
  await page.addInitScript(() => sessionStorage.setItem("lancerlogin-pending-meeting-deletion", JSON.stringify({ meetingId: "synthetic", title: "Sample meeting", scope: "occurrence", createdAt: Date.now() })));
  await page.goto("/dashboard"); await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible(); await expect(panel(page)).toHaveCount(0);
  await page.clock.fastForward(31_000); await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Not now" }).click();
  await page.clock.fastForward(61_000); await expect(panel(page)).toHaveCount(0);
});

test("an available update is hidden during the tour and restored afterward", async ({ page }) => {
  await account(page, fresh(), "admin", true);
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: "1.0.0" } }));
  await page.route("**/admin/releases/latest", (route) => route.fulfill({ json: { release: { tag_name: "v1.0.1", draft: false, prerelease: false, html_url: "https://github.com/isriah/LancerLogin/releases/tag/v1.0.1", body: "Sample release" }, checkedAt: Date.now(), fresh: true } }));
  await page.goto("/dashboard"); await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("status", { name: "Update available" })).toBeVisible();
  await page.getByRole("button", { name: "Reset page walkthrough" }).click();
  await expect(page.getByRole("status", { name: "Update available" })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Start walkthrough" }).click();
  await expect(panel(page)).toContainText("Update available opens the Updates page");
  await page.keyboard.press("Escape"); await expect(page.getByRole("status", { name: "Update available" })).toBeVisible();
});

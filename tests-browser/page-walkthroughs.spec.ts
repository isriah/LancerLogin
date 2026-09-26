import { expect, test, type Page } from "@playwright/test";

type PageId = "roster" | "member" | "reports" | "meeting" | "kiosks" | "simulator";
type Progress = { pageId: PageId; version: number; status: string; stepId: string | null };
type Story = { pageId: PageId; path: string; welcome: string; finish: string; steps: number; root: string };

const stories: Story[] = [
  { pageId: "roster", path: "/roster", welcome: "Get to know your roster", finish: "You're ready to work with the roster", steps: 6, root: '[data-walkthrough-page="roster"]' },
  { pageId: "member", path: "/roster/A-101", welcome: "Understand this member", finish: "You're ready to review a member", steps: 5, root: '[data-walkthrough-page="member"]' },
  { pageId: "reports", path: "/reports", welcome: "Turn attendance into answers", finish: "You're ready to explore reports", steps: 6, root: '[data-walkthrough-page="reports"]' },
  { pageId: "meeting", path: "/meetings/active-meeting", welcome: "Manage this meeting's attendance", finish: "You're ready to manage a meeting", steps: 7, root: '[data-walkthrough-page="meeting"]' },
  { pageId: "kiosks", path: "/kiosks", welcome: "Understand kiosk health", finish: "You're ready to monitor kiosks", steps: 12, root: '[data-walkthrough-page="kiosks"]' },
  { pageId: "simulator", path: "/simulator", welcome: "Practice the kiosk scan flow", finish: "You're ready to use the simulator", steps: 4, root: '[data-walkthrough-page="simulator"]' },
];

const completedSteps: Record<PageId | "dashboard", string> = { dashboard: "recurrence", roster: "bulk-tools", member: "member-actions", reports: "report-actions", meeting: "corrections", kiosks: "history", simulator: "simulate" };
const panel = (page: Page) => page.locator(".walkthrough-panel");

async function walkthroughAccount(page: Page, pageId: PageId, state: { progress: Progress }, debugMode = true) {
  await page.route("**/auth/session", (route) => route.fulfill({ json: { user: { id: "admin-1", role: "admin", debugMode } } }));
  await page.route("**/auth/walkthroughs/*", async (route) => {
    const requestedPage = new URL(route.request().url()).pathname.split("/").at(-1)! as PageId | "dashboard";
    if (requestedPage === pageId) {
      if (route.request().method() === "PATCH") state.progress = { ...route.request().postDataJSON(), pageId };
      return route.fulfill({ json: { progress: state.progress } });
    }
    await route.fulfill({ json: { progress: { pageId: requestedPage, version: 1, status: "completed", stepId: completedSteps[requestedPage] } } });
  });
}

for (const viewport of [{ width: 1280, height: 900, theme: "light" }, { width: 390, height: 844, theme: "dark" }]) {
  for (const story of stories) {
    test(`${story.pageId} walkthrough completes at ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), viewport.theme);
      const state = { progress: { pageId: story.pageId, version: 1, status: "not_started", stepId: null } as Progress };
      await walkthroughAccount(page, story.pageId, state);
      const writes: string[] = [];
      page.on("request", (request) => {
        if (["POST", "PATCH", "DELETE"].includes(request.method()) && !request.url().includes("/auth/walkthroughs/")) writes.push(request.url());
      });

      await page.goto(story.path);
      await expect(panel(page)).toContainText(story.welcome);
      await expect(panel(page)).not.toContainText(/About \d+ minutes/);
      await expect(page.getByRole("button", { name: "Page walkthrough" })).toHaveCount(0);
      await panel(page).getByRole("button", { name: "Start walkthrough" }).click();

      for (let index = 0; index < story.steps; index++) {
        await expect(panel(page)).toContainText(`Step ${index + 1} of ${story.steps}`);
        await expect(panel(page).getByRole("heading")).toBeFocused();
        await expect(page.locator(".walkthrough-highlight").first()).toBeVisible();
        const bounds = await panel(page).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
        expect(await page.evaluate(() => Boolean(document.querySelector("[data-walkthrough]:not(.walkthrough-panel *)")?.closest("[inert]")))).toBe(true);
        await panel(page).getByRole("button", { name: "Next", exact: true }).click();
      }

      await expect(panel(page)).toContainText(story.finish);
      await panel(page).getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.locator(story.root)).toBeFocused();
      await expect.poll(() => state.progress.status).toBe("completed");
      expect(writes).toEqual([]);

      const reset = page.getByRole("button", { name: "Reset page walkthrough" });
      await expect(reset).toBeVisible();
      await reset.click();
      await expect(panel(page)).toContainText(story.welcome);
      await expect.poll(() => state.progress).toEqual({ pageId: story.pageId, version: 1, status: "not_started", stepId: null });
      await panel(page).getByRole("button", { name: "Not now" }).click();
    });
  }
}

test("Settings and its subpages do not register page walkthroughs", async ({ page }) => {
  let requests = 0;
  await page.route("**/auth/session", (route) => route.fulfill({ json: { user: { id: "admin-1", role: "admin", debugMode: true } } }));
  await page.route("**/auth/walkthroughs/*", (route) => { requests += 1; return route.fulfill({ json: { error: "Unexpected walkthrough request" }, status: 500 }); });
  await page.goto("/settings/session");
  await expect(page.locator(".settings-page")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset page walkthrough" })).toHaveCount(0);
  expect(requests).toBe(0);
});

for (const view of [{ width: 1280, height: 900, theme: "light", role: "admin" }, { width: 390, height: 844, theme: "dark", role: "operator" }]) {
  test(`optional example report persists after the tour at ${view.width} for ${view.role}`, async ({ page }, testInfo) => {
    await page.setViewportSize(view);
    await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), view.theme);
    const state = { progress: { pageId: "reports", version: 1, status: "in_progress", stepId: "report-builder" } as Progress };
    await walkthroughAccount(page, "reports", state);
    await page.route("**/auth/session", (route) => route.fulfill({ json: { user: { id: "test-user", role: view.role, debugMode: true } } }));
    const reports: any[] = []; let creates = 0; let deletions = 0;
    let release: (() => void) | undefined;
    await page.route("**/reports/views", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: { reports } });
      creates++;
      const input = route.request().postDataJSON();
      expect(input.name).toBe("Monthly attendance example"); expect(input.scope).toBe("personal");
      expect(input.definition.period).toEqual({ type: "current_month" });
      expect(input.definition.columns.map((column: any) => column.key)).toEqual(["member", "member_id", "current_labels", "present_count", "absent_count", "excused_count", "report_policy_summary"]);
      await new Promise<void>((resolve) => { release = resolve; });
      const report = { ...input, id: "example-report", revision: 1, ownerUserId: "test-user", pinnedPosition: 0, warnings: [], errors: [] };
      reports.push(report); await route.fulfill({ status: 201, json: { report } });
    });
    page.on("request", (request) => { if (request.method() === "DELETE") deletions++; });
    await page.goto("/reports");
    await panel(page).getByRole("button", { name: "Resume walkthrough" }).click();
    const add = panel(page).getByRole("button", { name: "Add example report", exact: true });
    await expect(add).toBeVisible(); expect(creates).toBe(0);
    const style = await add.evaluate((button) => {
      const value = getComputedStyle(button); return { background: value.backgroundColor, color: value.color, radius: value.borderRadius, height: button.getBoundingClientRect().height };
    });
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)"); expect(style.color).not.toBe(style.background); expect(parseFloat(style.radius)).toBeGreaterThan(0); expect(style.height).toBeGreaterThanOrEqual(44);
    await add.focus(); await page.keyboard.press("Enter");
    await expect(panel(page).getByRole("button", { name: "Adding example…" })).toBeDisabled();
    await expect.poll(() => creates).toBe(1); release!();
    await expect(page).toHaveURL(/reports\/view\/example-report$/);
    await expect(panel(page)).toContainText("Example report saved.");
    await expect(page.getByRole("heading", { name: "Monthly attendance example", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const target = await page.locator('[data-walkthrough="report-builder"]').boundingBox();
      const outline = await page.locator(".walkthrough-highlight").first().boundingBox();
      return Boolean(target && outline && outline.width > target.width + 20 && outline.x < target.x);
    }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("report-example.png"), fullPage: true });
    await panel(page).getByRole("button", { name: "Next", exact: true }).click();
    await panel(page).getByRole("button", { name: "Next", exact: true }).click();
    await panel(page).getByRole("button", { name: "Done", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Monthly attendance example", exact: true })).toBeVisible();
    expect(reports).toHaveLength(1); expect(creates).toBe(1); expect(deletions).toBe(0);
  });
}

test("example report errors keep the tour usable and do not invent a saved report", async ({ page }) => {
  const state = { progress: { pageId: "reports", version: 1, status: "in_progress", stepId: "report-builder" } as Progress };
  await walkthroughAccount(page, "reports", state);
  await page.route("**/reports/views", (route) => route.request().method() === "GET" ? route.fulfill({ json: { reports: [] } }) : route.fulfill({ status: 503, json: { error: "Reports temporarily unavailable" } }));
  await page.goto("/reports"); await panel(page).getByRole("button", { name: "Resume walkthrough" }).click();
  await panel(page).getByRole("button", { name: "Add example report", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText("Reports temporarily unavailable");
  await expect(panel(page).getByRole("button", { name: "Add example report", exact: true })).toBeEnabled();
  await panel(page).getByRole("button", { name: "Exit", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
});

for (const view of [{ width: 1280, height: 900, theme: "light" }, { width: 390, height: 844, theme: "dark" }]) {
  test(`empty kiosk management tour uses a safe example at ${view.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(view); await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), view.theme);
    const state = { progress: { pageId: "kiosks", version: 1, status: "not_started", stepId: null } as Progress };
    await walkthroughAccount(page, "kiosks", state);
    await page.route("**/admin/kiosks", (route) => route.fulfill({ json: { kiosks: [] } }));
    const writes: string[] = [];
    page.on("request", (request) => { if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && !request.url().includes("/auth/walkthroughs/")) writes.push(request.url()); });
    await page.goto("/kiosks");
    await expect(page.getByText("Example kiosk", { exact: true })).toBeVisible();
    await expect(page.getByText(/Example kiosk for this walkthrough/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
    await panel(page).getByRole("button", { name: "Start walkthrough" }).click();
    for (let index = 0; index < 12; index++) {
      await expect(panel(page)).toContainText(`Step ${index + 1} of 12`);
      await expect(page.locator(".walkthrough-highlight").first()).toBeVisible();
      if (index === 4 || index === 8) await page.screenshot({ path: testInfo.outputPath(`kiosk-step-${index + 1}.png`) });
      await panel(page).getByRole("button", { name: "Next", exact: true }).click();
    }
    await panel(page).getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByText("Example kiosk", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No kiosk paired", { exact: true })).toBeVisible(); expect(writes).toEqual([]);
    await page.reload(); await expect(page.getByText("Example kiosk", { exact: true })).toHaveCount(0);
  });
}

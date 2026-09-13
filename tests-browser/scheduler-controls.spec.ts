import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences as reference } from "../apps/dashboard/src/design-conformance";
const jobs = Object.fromEntries(["attendance.google-calendar", "attendance.discord-calendar", "attendance.discord-channel", "attendance.discord-notices", "attendance.discord-expiry", "attendance.discord-anomalies"].map((id, i) => [id, { next: 1_800_000_000_000, last: i ? 1_799_999_700_000 : null, outcome: ["waiting", "running", "ok", "failed", "paused", "ok", "waiting"][i] }]));
async function context(page: Page, role = "admin", theme = "light") {
  await page.route("**/*", route => ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
  await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Scheduler Team", primaryColor: reference.brand.primary, secondaryColor: reference.brand.secondary, appearance: theme } } }));
  await page.route("**/auth/session", route => route.fulfill({ json: { user: { role } } }));
  await page.route("**/admin/setup/progress", route => route.fulfill({ json: { completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map(step => ({ step })) } }));
  await page.route("**/platform/modules", route => route.fulfill({ json: { revision: 0, capabilities: [], modules: [
    { id: "hour-tracking", enabled: false, dependencies: [], capabilities: [], navigation: { label: "Hour Tracking" } },
    { id: "activity-documentation", enabled: false, dependencies: ["hour-tracking"], capabilities: [], navigation: { label: "Activity Documentation" } },
  ] } }));
}
const area = (page: Page) => page.getByRole("region", { name: "Background scheduler" });
test("start and stop require status readback and send only empty JSON", async ({ page }) => {
  await context(page); let enabled = false; const calls: string[] = [];
  await page.route("**/admin/scheduler{,/**}", async route => {
    const path = new URL(route.request().url()).pathname; calls.push(route.request().method() + path);
    if (route.request().method() === "POST") { expect(route.request().postDataJSON()).toEqual({}); enabled = path.endsWith("start"); }
    await route.fulfill({ json: { enabled, jobs } });
  });
  await page.goto("/settings/configuration");
  await area(page).getByRole("button", { name: "Start scheduler" }).click();
  await expect(area(page).getByRole("status")).toContainText("Scheduler started.");
  await expect(area(page).getByRole("button", { name: "Stop scheduler" })).toBeFocused();
  await area(page).getByRole("button", { name: "Stop scheduler" }).click();
  await expect(area(page).getByRole("status")).toContainText("Scheduler stopped.");
  expect(calls).toEqual(["GET/admin/scheduler", "POST/admin/scheduler/start", "GET/admin/scheduler", "POST/admin/scheduler/stop", "GET/admin/scheduler"]);
  await expect(area(page).getByRole("link")).toHaveAttribute("href", "/settings/integrations");
});
for (const status of [503, 403, 500]) test(`initial ${status} is unavailable with explicit reload`, async ({ page }) => {
  await context(page); let failed = true, reads = 0;
  await page.route("**/admin/scheduler", route => { reads++; return route.fulfill({ status: failed ? status : 200, json: failed ? { error: "Internal provider detail" } : { enabled: true, jobs } }); });
  await page.goto("/settings/configuration");
  await expect(area(page).getByRole("alert")).toContainText("Scheduler status is unavailable");
  await expect(area(page).getByText("Internal provider detail")).toHaveCount(0);
  await expect(area(page).getByRole("button", { name: /Start scheduler|Stop scheduler/ })).toHaveCount(0);
  await expect(area(page).getByText(/Last loaded scheduler state/)).toHaveCount(0);
  expect(reads).toBe(1); failed = false;
  await area(page).getByRole("button", { name: "Reload scheduler status" }).click();
  await expect(area(page).getByRole("button", { name: "Stop scheduler" })).toBeEnabled();
});
for (const failure of ["mutation", "readback", "mismatch", "access-loss"]) test(`${failure} requires reload with no implicit retry`, async ({ page }) => {
  await context(page); let writes = 0, reads = 0, recovered = false;
  await page.route("**/admin/scheduler", route => { reads++; return route.fulfill({ status: writes && !recovered && failure === "readback" ? 500 : 200, json: { enabled: recovered || (!!writes && failure !== "mismatch"), jobs } }); });
  await page.route("**/admin/scheduler/start", route => { writes++; return route.fulfill({ status: failure === "mutation" ? 500 : failure === "access-loss" ? 403 : 200, json: {} }); });
  await page.goto("/settings/configuration");
  await area(page).getByRole("button", { name: "Start scheduler" }).click();
  await expect(area(page).getByRole("alert")).toContainText("could not be verified");
  await expect(area(page).getByRole("button", { name: "Reload scheduler status" })).toBeFocused();
  await expect(area(page).getByRole("button", { name: /Start scheduler|Stop scheduler/ })).toBeDisabled();
  await expect(area(page).getByText(/Scheduler started\./)).toHaveCount(0);
  expect(writes).toBe(1); expect(reads).toBe(["mutation", "access-loss"].includes(failure) ? 1 : 2);
  recovered = true;
  await area(page).getByRole("button", { name: "Reload scheduler status" }).click();
  await expect(area(page).getByRole("button", { name: "Stop scheduler" })).toBeEnabled();
  expect(writes).toBe(1);
});
test("malformed snapshots fail closed and bounded unknown labels remain escaped text", async ({ page }) => {
  await context(page); let value: unknown = null;
  await page.route("**/admin/scheduler", route => route.fulfill({ json: value }));
  await page.goto("/settings/configuration");
  for (const invalid of [null, {}, { enabled: "false", jobs }, { enabled: false, jobs: [] }, { enabled: false, jobs: {} }, { enabled: true, jobs: { bad: { next: -1, last: null, outcome: "ok" } } }, { enabled: true, jobs: { bad: { next: 2, last: null, outcome: "constructor" } } }, { enabled: true, jobs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), Object.values(jobs)[0]])) }]) {
    value = invalid;
    await area(page).getByRole("button", { name: "Reload scheduler status" }).click();
    await expect(area(page).getByRole("alert")).toBeVisible();
    await expect(area(page).getByRole("button", { name: "Start scheduler" })).toHaveCount(0);
  }
  value = { enabled: false, jobs: { ...jobs, '<img src=x onerror="alert(1)">': Object.values(jobs)[0] } };
  await area(page).getByRole("button", { name: "Reload scheduler status" }).click();
  await expect(area(page).getByText('<img src=x onerror="alert(1)">')).toBeVisible();
  await expect(area(page).locator("img")).toHaveCount(0);
});
test("busy controls prevent duplicate mutations while last loaded state remains visible", async ({ page }) => {
  await context(page); let release!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/admin/scheduler", route => route.fulfill({ json: { enabled: !!writes, jobs } }));
  await page.route("**/admin/scheduler/start", async route => { writes++; await gate; await route.fulfill({ json: {} }); });
  await page.goto("/settings/configuration");
  await area(page).getByRole("button", { name: "Start scheduler" }).click();
  await expect(area(page).getByRole("button", { name: "Start scheduler" })).toBeDisabled();
  await expect(area(page).getByRole("button", { name: "Reload scheduler status" })).toBeDisabled();
  await expect(area(page).getByText(/Last loaded scheduler state: Stopped/)).toBeVisible();
  release(); await expect(area(page).getByRole("button", { name: "Stop scheduler" })).toBeEnabled(); expect(writes).toBe(1);
});
for (const role of ["staff", "operator"]) test(`${role} cannot see or request scheduler controls`, async ({ page }) => {
  await context(page, role); let reads = 0;
  await page.route("**/admin/scheduler{,/**}", route => { reads++; return route.fulfill({ json: {} }); });
  await page.goto("/settings/configuration");
  await expect(page.getByRole("heading", { level: 1, name: role === "staff" ? "Your workspace" : "Page unavailable" })).toBeVisible();
  await expect(area(page)).toHaveCount(0); expect(reads).toBe(0);
});
for (const viewport of reference.viewports) for (const theme of reference.themes) test(`scheduler keyboard and layout at ${viewport.width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize(viewport); await context(page, "admin", theme);
  await page.route("**/admin/scheduler", route => route.fulfill({ json: { enabled: true, jobs } }));
  await page.goto("/settings/configuration");
  const button = area(page).getByRole("button", { name: "Stop scheduler" });
  await button.focus(); await expect(button).toBeFocused();
  expect(await button.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await button.press("Tab"); await expect(area(page).getByRole("button", { name: "Reload scheduler status" })).toBeFocused();
  await page.keyboard.press("Enter"); await expect(button).toBeEnabled();
  await expect(page.locator("main h1")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".app")).toHaveCSS("--primary", reference.brand.primary);
  await button.focus();
  await area(page).screenshot({ path: test.info().outputPath("scheduler.png") });
});

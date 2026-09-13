import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences as reference } from "../apps/dashboard/src/design-conformance";

const moduleSnapshot = (enabled: string[] = [], revision = 0) => ({ revision, capabilities: [], modules: [
  { id: "hour-tracking", enabled: enabled.includes("hour-tracking"), dependencies: [], capabilities: ["hours.manage"], navigation: { label: "Hour Tracking" } },
  { id: "activity-documentation", enabled: enabled.includes("activity-documentation"), dependencies: ["hour-tracking"], capabilities: ["documentation.manage"], navigation: { label: "Activity Documentation" } },
] });
const both = ["hour-tracking", "activity-documentation"];
async function context(page: Page, role = "admin", theme = "light") {
  await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Module Team", primaryColor: reference.brand.primary, secondaryColor: reference.brand.secondary, appearance: theme } } }));
  await page.route("**/auth/session", route => route.fulfill({ json: { user: { role } } }));
  await page.route("**/admin/setup/progress", route => route.fulfill({ json: { completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map(step => ({ step })) } }));
  await page.route("**/admin/users", route => route.fulfill({ json: { users: [
    { id: "admin-1", localUsername: "synthetic-admin", role: "admin", active: 1 },
    { id: "staff-1", localUsername: "synthetic-staff", role: "staff", active: 1 },
    { id: "operator-1", localUsername: "synthetic-operator", role: "operator", active: 1 },
    { id: "inactive-1", localUsername: "synthetic-inactive", role: "staff", active: 0 },
  ] } }));
  await page.route("**/platform/modules", route => route.fulfill({ json: moduleSnapshot() }));
}

test("module dependency requires explicit choices and preserves the last stored view until saved", async ({ page }) => {
  await context(page);
  let state = moduleSnapshot(); const writes: unknown[] = [];
  await page.route("**/platform/modules", route => route.fulfill({ json: state }));
  await page.route("**/admin/modules", async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    state = moduleSnapshot(body.enabled, state.revision + 1);
    await route.fulfill({ json: state });
  });
  await page.goto("/settings/configuration");
  const area = page.getByRole("region", { name: "Modules", exact: true });
  await area.getByLabel("Activity Documentation", { exact: true }).check();
  await expect(area.getByRole("button", { name: "Save modules" })).toBeDisabled();
  await expect(area.getByRole("alert")).toContainText("cannot be enabled alone");
  await area.getByLabel("Hour Tracking", { exact: true }).check();
  await expect(area.getByText("Last loaded configuration: Core only.")).toBeVisible();
  await area.getByRole("button", { name: "Save modules" }).click();
  await expect(area.getByText("Module configuration saved.", { exact: false })).toBeVisible();
  expect(writes).toEqual([{ enabled: ["activity-documentation", "hour-tracking"], revision: 0 }]);
  await area.getByLabel("Hour Tracking", { exact: true }).uncheck();
  await expect(area.getByLabel("Activity Documentation", { exact: true })).toBeChecked();
  await expect(area.getByRole("button", { name: "Save modules" })).toBeDisabled();
  await area.getByLabel("Activity Documentation", { exact: true }).uncheck();
  await area.getByRole("button", { name: "Save modules" }).click();
  await expect(area.getByText("Last loaded configuration: Core only.")).toBeVisible();
  expect(writes[1]).toEqual({ enabled: [], revision: 1 });
  await area.getByLabel("Hour Tracking", { exact: true }).check();
  await area.getByRole("button", { name: "Save modules" }).click();
  await expect(area.getByText("Last loaded configuration: Hour Tracking.")).toBeVisible();
  expect(writes[2]).toEqual({ enabled: ["hour-tracking"], revision: 2 });
  await expect(area.getByText("Disabling a module preserves", { exact: false })).toBeVisible();
});

for (const status of [409, 403, 500]) test(`module save ${status} requires explicit reload without silently retrying`, async ({ page }) => {
  await context(page); let state = moduleSnapshot(); let writes = 0;
  await page.route("**/platform/modules", route => route.fulfill({ json: state }));
  await page.route("**/admin/modules", async route => { writes++; state = moduleSnapshot(both, 3); await route.fulfill({ status, json: { error: "Configuration changed or access unavailable" } }); });
  await page.goto("/settings/configuration");
  await page.getByLabel("Hour Tracking", { exact: true }).check();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByRole("region", { name: "Modules", exact: true }).getByRole("alert")).toContainText("Reload module settings");
  await expect(page.getByText("Last loaded configuration: Core only.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save modules" })).toBeDisabled();
  await page.getByRole("button", { name: "Reload module settings" }).click();
  await expect(page.getByLabel("Activity Documentation", { exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Save modules" })).toBeDisabled();
  expect(writes).toBe(1);
});

test("module load rejection cannot become a default writable configuration", async ({ page }) => {
  await context(page);
  await page.route("**/platform/modules", route => route.fulfill({ status: 403, json: { error: "Admin session unavailable" } }));
  await page.goto("/settings/configuration");
  await expect(page.getByRole("region", { name: "Modules", exact: true }).getByRole("alert")).toContainText("Admin session unavailable");
  await expect(page.getByRole("button", { name: "Save modules" })).toHaveCount(0);
});

test("retained grants can be managed while disabled; failed mutation does not claim a save", async ({ page }) => {
  await context(page); let capabilities = ["hours.manage"]; let fail = false; let writes = 0;
  await page.route("**/admin/modules/grants/staff-1", async route => {
    if (route.request().method() === "PUT") {
      writes++;
      if (fail) { await route.fulfill({ status: 403, json: { error: "Admin access unavailable" } }); return; }
      capabilities = route.request().postDataJSON().capabilities;
    }
    await route.fulfill({ json: { userId: "staff-1", capabilities } });
  });
  await page.goto("/settings/access");
  await page.getByRole("button", { name: "Module access for synthetic-staff", exact: true }).click();
  const form = page.getByRole("form", { name: "Module access for synthetic-staff" });
  await expect(form.getByLabel("Manage Hour Tracking — module disabled", { exact: true })).toBeChecked();
  await form.getByLabel("Manage Activity Documentation — module disabled", { exact: true }).check();
  await form.getByRole("button", { name: "Save grants" }).click();
  await expect(form.getByRole("status")).toContainText("Module grants saved");
  expect(capabilities).toEqual(["hours.manage", "documentation.manage"]);
  fail = true;
  await form.getByLabel("Manage Hour Tracking — module disabled", { exact: true }).uncheck();
  await form.getByRole("button", { name: "Save grants" }).click();
  await expect(form.getByRole("alert")).toContainText("Reload grants");
  await expect(form.getByText("Last loaded grants: Manage Hour Tracking, Manage Activity Documentation.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Save grants" })).toBeDisabled();
  await expect(form.getByText("Module grants saved", { exact: false })).toHaveCount(0);
  await form.getByRole("button", { name: "Reload grants" }).click();
  await expect(form.getByLabel("Manage Hour Tracking — module disabled", { exact: true })).toBeChecked();
  expect(writes).toBe(2);
  fail = false;
  await form.getByLabel("Manage Hour Tracking — module disabled", { exact: true }).uncheck();
  await form.getByRole("button", { name: "Save grants" }).click();
  await expect(form.getByText("Last loaded grants: Manage Activity Documentation.")).toBeVisible();
  expect(capabilities).toEqual(["documentation.manage"]);
  await form.getByLabel("Manage Activity Documentation — module disabled", { exact: true }).uncheck();
  await form.getByRole("button", { name: "Save grants" }).click();
  await expect(form.getByText("Last loaded grants: None.")).toBeVisible();
  expect(capabilities).toEqual([]);
  await expect(page.getByRole("button", { name: "Module access for synthetic-admin", exact: true })).toHaveCount(0);
  await expect(page.getByText("Admins have full access", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Module access for synthetic-operator", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Module access for synthetic-inactive", exact: true })).toHaveCount(0);
});

test("successful write followed by failed readback is not presented as verified saved state", async ({ page }) => {
  await context(page); let written = false;
  await page.route("**/platform/modules", route => route.fulfill(written ? { status: 503, json: { error: "Readback unavailable" } } : { json: moduleSnapshot() }));
  await page.route("**/admin/modules", async route => { written = true; await route.fulfill({ json: moduleSnapshot(["hour-tracking"], 1) }); });
  await page.goto("/settings/configuration");
  await page.getByLabel("Hour Tracking", { exact: true }).check();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByRole("region", { name: "Modules", exact: true }).getByRole("alert")).toContainText("Readback unavailable");
  await expect(page.getByText("Last loaded configuration: Core only.")).toBeVisible();
  await expect(page.getByText("Module configuration saved", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save modules" })).toBeDisabled();
});

test("grant disclosure cannot start overlapping loads", async ({ page }) => {
  await context(page); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route("**/admin/modules/grants/staff-1", async route => { reads++; await gate; await route.fulfill({ json: { userId: "staff-1", capabilities: [] } }); });
  await page.goto("/settings/access");
  const disclosure = page.getByRole("button", { name: "Module access for synthetic-staff", exact: true });
  await disclosure.click();
  await expect(disclosure).toBeDisabled();
  release();
  await expect(disclosure).toBeEnabled();
  await expect(page.getByText("Last loaded grants: None.")).toBeVisible();
  expect(reads).toBe(1);
});

for (const role of ["staff", "operator"]) for (const path of ["/settings/configuration", "/settings/access"]) test(`${role} cannot open module controls at ${path}`, async ({ page }) => {
  await context(page, role); const calls: string[] = [];
  page.on("request", request => { if (/\/admin\/modules|\/admin\/users/.test(request.url())) calls.push(request.url()); });
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: role === "staff" ? "Your workspace" : "Page unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save modules" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save grants" })).toHaveCount(0);
  expect(calls).toEqual([]);
});

for (const viewport of reference.viewports) for (const theme of reference.themes) test(`module controls are usable at ${viewport.width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize(viewport); await context(page, "admin", theme);
  await page.route("**/admin/modules/grants/operator-1", route => route.fulfill({ json: { userId: "operator-1", capabilities: ["hours.manage"] } }));
  await page.goto("/settings/configuration");
  const checkbox = page.getByLabel("Hour Tracking", { exact: true });
  await checkbox.focus(); await expect(checkbox).toBeFocused(); await checkbox.press("Space"); await expect(checkbox).toBeChecked();
  expect(await checkbox.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  expect((await checkbox.locator("..").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator("main h1")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".app")).toHaveCSS("--primary", reference.brand.primary);
  await page.screenshot({ path: test.info().outputPath("modules.png"), fullPage: true });
  await page.goto("/settings/access");
  await page.getByRole("button", { name: "Module access for synthetic-operator", exact: true }).click();
  const form = page.getByRole("form", { name: "Module access for synthetic-operator" });
  await expect(form.getByLabel("Manage Hour Tracking — module disabled", { exact: true })).toBeChecked();
  await form.getByLabel("Manage Activity Documentation — module disabled", { exact: true }).focus();
  await expect(form.getByLabel("Manage Activity Documentation — module disabled", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("main h1")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("grants.png"), fullPage: true });
});

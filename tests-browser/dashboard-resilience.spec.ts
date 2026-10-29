import { expect, test, type Page, type Route } from "@playwright/test";
import { attendanceSetupState, attendanceSnapshot } from "./module-fixtures";

type ModuleMode = "ok" | "offline" | "server-error" | "signed-out" | "mismatch";

async function moduleRoute(page: Page) {
  const state = { mode: "ok" as ModuleMode, reads: 0 };
  await page.route("**/platform/modules", (route: Route) => {
    state.reads += 1;
    if (state.mode === "offline") return route.abort("connectionfailed");
    if (state.mode === "server-error") return route.fulfill({ status: 503, contentType: "text/html", body: "<html>Worker unavailable</html>" });
    if (state.mode === "signed-out") return route.fulfill({ status: 401, json: { error: "Sign in required" } });
    return route.fulfill({ json: state.mode === "mismatch" ? { revision: 1, selectionCompleted: true, capabilities: [], modules: [] } : attendanceSnapshot() });
  });
  return state;
}

const refresh = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
// Marks the current page element. A remounted page loses the mark, so its presence proves the page and its state survived.
const markPage = (page: Page) => page.locator("#dashboard-content > *").first().evaluate((element) => { element.setAttribute("data-test-kept", "yes"); });
const keptPage = (page: Page) => page.locator("#dashboard-content [data-test-kept=yes]");

test("a failed module refresh keeps the open page, shows a banner, and reconnects", async ({ page }) => {
  const modules = await moduleRoute(page);
  await page.goto("/roster");
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
  await markPage(page);

  for (const mode of ["offline", "server-error"] as const) {
    modules.mode = mode;
    await refresh(page);
    await expect(page.getByRole("status").filter({ hasText: "LancerLogin could not be reached" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Module access unavailable" })).toHaveCount(0);
    await expect(keptPage(page)).toHaveCount(1);
    await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
    modules.mode = "ok";
    await refresh(page);
    await expect(page.getByRole("status").filter({ hasText: "LancerLogin could not be reached" })).toHaveCount(0);
    await expect(keptPage(page)).toHaveCount(1);
  }
});

test("an expired session during a module refresh returns to sign-in", async ({ page }) => {
  const modules = await moduleRoute(page);
  await page.goto("/roster");
  await expect(page.getByRole("table", { name: "Roster members" })).toBeVisible();
  modules.mode = "signed-out";
  await refresh(page);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Module access unavailable" })).toHaveCount(0);
});

test("Updates keeps rendering while module state cannot be verified during a web update", async ({ page }) => {
  const modules = await moduleRoute(page);
  await page.goto("/settings/updates");
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
  await markPage(page);
  modules.mode = "mismatch";
  await refresh(page);
  await expect.poll(() => modules.reads).toBeGreaterThan(1);
  await expect(page.getByRole("heading", { name: "Module access unavailable" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
  await expect(keptPage(page)).toHaveCount(1);

  // Other pages fail closed, but explain the likely update and lead back to Updates.
  await page.getByRole("navigation", { name: "Primary dashboard navigation" }).getByRole("link", { name: "Roster", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Module access unavailable" })).toBeVisible();
  await expect(page.getByText("If LancerLogin was just updated")).toBeVisible();
  await expect(page.getByRole("table", { name: "Roster members" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open Updates" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
});

test("background module checks are serial, slow, and pause in hidden tabs", async ({ page }) => {
  await page.clock.install();
  const modules = await moduleRoute(page);
  await page.goto("/roster");
  await expect(page.getByRole("table", { name: "Roster members" })).toBeVisible();
  const settled = modules.reads;
  await page.clock.runFor(61_000);
  // Two 30 second intervals at most, where the previous 5 second poll made twelve.
  expect(modules.reads - settled).toBeLessThanOrEqual(2);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); });
  const hidden = modules.reads;
  await page.clock.runFor(120_000);
  expect(modules.reads).toBe(hidden);
});

test("malformed route parameters show Page unavailable instead of a blank dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  const navigation = page.getByRole("navigation", { name: "Primary dashboard navigation" });
  await expect(navigation).toBeVisible();
  for (const path of ["/roster/100%", "/meetings/%E0", "/reports/view/%", "/kiosks/%E0%A4/manage"]) {
    await page.evaluate((next) => { window.history.pushState({}, "", next); window.dispatchEvent(new Event("lancerlogin:route-change")); }, path);
    await expect(page.getByRole("heading", { level: 1, name: "Page unavailable" }), path).toBeVisible();
    await expect(navigation).toBeVisible();
  }
});

test("a page render error stays inside the page and clears on navigation", async ({ page }) => {
  await page.route("**/admin/members", (route) => route.fulfill({ json: { members: "not-a-list" } }));
  await page.goto("/settings/access");
  await expect(page.getByRole("heading", { name: "This page could not be displayed" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary dashboard navigation" })).toBeVisible();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: "Data" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Data management" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This page could not be displayed" })).toHaveCount(0);
});

test("Access reports an account list that failed to load and can retry", async ({ page }) => {
  let fail = true;
  await page.route("**/admin/members", (route) => fail ? route.fulfill({ status: 500, json: { error: "Database unavailable" } }) : route.fallback());
  await page.goto("/settings/access");
  await expect(page.getByRole("alert").filter({ hasText: "Dashboard accounts could not be loaded" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Dashboard accounts could not be loaded" })).toHaveCount(0);
});

test("reopened Attendance setup can be closed and its Integrations link opens Integrations", async ({ page }) => {
  // Every required step is complete; the optional calendar step is still open, so setup resumes there.
  const state = attendanceSetupState({ rules: "completed", meeting: "completed", input: "completed" }, ["rules", "meeting", "input"]);
  await page.route("**/admin/modules/attendance/setup", (route) => route.fulfill({ json: state }));
  await page.goto("/settings/guided-setup");
  const navigation = page.getByRole("navigation", { name: "Primary dashboard navigation" });
  await page.getByRole("button", { name: "Open Attendance setup" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toBeVisible();
  await expect(navigation).toHaveCount(0);
  await page.getByRole("button", { name: "Close setup" }).click();
  // The setup workspace and its Settings page share one name; the Settings page is the one with Open Attendance setup.
  await expect(page.getByRole("button", { name: "Close setup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Attendance setup" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toBeVisible();
  await expect(navigation).toBeVisible();

  await page.getByRole("button", { name: "Open Attendance setup" }).click();
  await page.getByRole("button", { name: "Open Integrations settings" }).click();
  await expect(page).toHaveURL(/\/settings\/integrations$/);
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  await expect(navigation).toBeVisible();
});

test("first-Admin setup reports an unreachable or failing setup service and stays usable", async ({ page }) => {
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false } }));
  let attempt = 0;
  await page.route("**/setup/bootstrap", (route) => ++attempt === 1 ? route.abort("connectionfailed") : route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" }));
  await page.goto("/dashboard");
  await page.getByLabel("One-time setup code").fill("synthetic-setup-code-0001");
  await page.getByLabel("Organization name").fill("Reference Arts Collective");
  await page.getByLabel("Admin username").fill("admin");
  await page.getByRole("textbox", { name: /^Admin password/ }).fill("correct-horse-battery");
  await page.getByLabel("Confirm Admin password").fill("correct-horse-battery");
  const submit = page.getByRole("button", { name: "Create first Admin" });
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("Setup service unavailable");
  await expect(submit).toBeEnabled();
  await expect(page.getByLabel("One-time setup code")).toHaveValue("synthetic-setup-code-0001");
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("Setup service unavailable. Try again");
  await expect(submit).toBeEnabled();
});

test("sign-in distinguishes rate limiting and outages from wrong credentials", async ({ page }) => {
  await page.route("**/auth/session", (route) => route.fulfill({ status: 401, json: { error: "Sign in required" } }));
  const statuses = [429, 503];
  await page.route("**/auth/local", (route) => route.fulfill({ status: statuses.shift() ?? 401, json: { error: "Refused" } }));
  await page.goto("/dashboard");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("synthetic-password");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await signIn.click();
  await expect(page.getByRole("alert")).toContainText("Too many sign-in attempts");
  await signIn.click();
  await expect(page.getByRole("alert")).toContainText("Sign-in service unavailable");
  await signIn.click();
  await expect(page.getByRole("alert")).toContainText("Invalid username or password");
});

test("a transient session check failure offers a retry instead of the sign-in form", async ({ page }) => {
  let available = false;
  await page.route("**/auth/session", (route) => available ? route.fallback() : route.fulfill({ status: 503, contentType: "text/html", body: "<html>Unavailable</html>" }));
  await page.goto("/roster");
  await expect(page.getByRole("heading", { name: "Session check unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Sign in/ })).toHaveCount(0);
  available = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
});

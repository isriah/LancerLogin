import { expect, test, type Page } from "@playwright/test";
import { attendanceSnapshot } from "./module-fixtures";
import { outreachComposed, outreachSkipReason } from "./outreach-fixtures";

const delayedPaths = new Set(["/setup/status", "/auth/session", "/platform/modules", "/admin/members", "/labels", "/admin/attendance/members", "/reports/attendance", "/reports/catalog", "/reports/views", "/reports/leaderboard"]);

async function measure(page: Page, routePath: "/roster" | "/reports", navigate = false) {
  const requests: { path: string; started: number; finished?: number }[] = [];
  const start = performance.now();
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!delayedPaths.has(path)) return route.continue();
    const entry = { path, started: Math.round(performance.now() - start), finished: undefined as number | undefined };
    requests.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.continue();
    entry.finished = Math.round(performance.now() - start);
  });
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  if (navigate) await page.getByRole("navigation", { name: "Primary dashboard navigation" }).getByRole("link", { name: "Reports", exact: true }).click();
  else await page.goto(routePath);
  const table = page.getByRole("table", { name: routePath === "/roster" ? "Roster members" : "Attendance leaderboard" });
  await expect(table).toContainText("Avery Stone");
  if (routePath === "/roster") await expect(page.getByText("Loading attendance rates…", { exact: true })).toHaveCount(0);
  else await expect(page.getByText("Loading leaderboard…", { exact: true })).toHaveCount(0);
  const readyMs = Math.round(performance.now() - start);
  const metrics = await client.send("Performance.getMetrics");
  console.log(JSON.stringify({ route: routePath, navigate, readyMs, requests, cpu: metrics.metrics.filter((item) => ["TaskDuration", "ScriptDuration"].includes(item.name)) }));
  await client.detach();
  if (!navigate) {
    const setup = requests.find((item) => item.path === "/setup/status")!;
    expect(requests.find((item) => item.path === "/auth/session")!.started).toBeLessThan(setup.finished!);
    expect(requests.find((item) => item.path === "/platform/modules")!.started).toBeLessThan(setup.finished!);
  }
}

test("roster initial load retains current attendance under network latency", async ({ page }) => {
  await measure(page, "/roster");
});

test("setup and session both gate protected page requests even if modules resolve first", async ({ page }) => {
  let releaseSetup!: () => void;
  const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  let memberReads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/admin/members") memberReads++; });
  await page.route("**/setup/status", async (route) => { await setupGate; await route.continue(); });
  await page.route("**/auth/session", async (route) => { await sessionGate; await route.continue(); });
  const modules = page.waitForResponse("**/platform/modules");
  await page.goto("/roster");
  await modules;
  expect(memberReads).toBe(0);
  await expect(page.getByRole("heading", { name: "Checking your installation…" })).toBeVisible();
  releaseSetup();
  await expect(page.getByRole("heading", { name: "Checking your session…" })).toBeVisible();
  expect(memberReads).toBe(0);
  releaseSession();
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
});

test("anonymous entry discards preloaded module access before a new Operator sign-in", async ({ page }) => {
  let modules = attendanceSnapshot();
  let moduleReads = 0;
  let memberReads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/admin/members") memberReads++; });
  await page.route("**/auth/session", (route) => route.fulfill({ status: 401, json: { error: "Session expired" } }));
  await page.route("**/platform/modules", (route) => { moduleReads++; return route.fulfill({ json: modules }); });
  await page.route("**/auth/local", (route) => route.fulfill({ json: { user: { id: "operator-2", role: "operator", debugMode: false } } }));
  await page.goto("/roster");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(memberReads).toBe(0);
  const beforeLogin = moduleReads;
  modules = attendanceSnapshot({ enabled: false });
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Password").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Not enabled");
  expect(moduleReads).toBeGreaterThan(beforeLogin);
  await expect(page.getByRole("button", { name: "Add member", exact: true })).toHaveCount(0);
});

test("invalid module access fails closed and recovers on a fresh focus check", async ({ page }) => {
  let valid = false;
  let memberReads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/admin/members") memberReads++; });
  await page.route("**/platform/modules", (route) => route.fulfill({ json: valid ? attendanceSnapshot() : { modules: [] } }));
  await page.goto("/roster");
  await expect(page.getByRole("heading", { name: "Module access unavailable" })).toBeVisible();
  expect(memberReads).toBe(0);
  valid = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
  valid = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Module access unavailable" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Roster members" })).toHaveCount(0);
});

test("public Outreach cannot consume preloaded protected access", async ({ page }) => {
  test.skip(!outreachComposed, outreachSkipReason);
  let protectedReads = 0;
  page.on("request", (request) => { if (["/auth/session", "/platform/modules", "/admin/members"].includes(new URL(request.url()).pathname)) protectedReads++; });
  // A public page owns every path below its base, so a direct deep load renders the same public page without signing in.
  for (const path of ["/submit-hours", "/submit-hours/", "/submit-hours/manage", "/submit-hours/a/b"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Record Outreach" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Skip to submission form" })).toBeAttached();
  }
  expect(protectedReads).toBe(0);
});

test("a public page follows in-place navigation below its base and reloads when leaving every public page", async ({ page }) => {
  test.skip(!outreachComposed, outreachSkipReason);
  const move = (path: string) => page.evaluate((next) => { history.pushState({}, "", next); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.goto("/submit-hours");
  await expect(page.getByRole("heading", { level: 1, name: "Record Outreach" })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { samePage: boolean }).samePage = true; });
  await move("/submit-hours/manage");
  await expect(page.getByRole("heading", { level: 1, name: "Record Outreach" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage)).toBe(true);
  await move("/dashboard");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeAttached();
  expect(await page.evaluate(() => (window as unknown as { samePage?: boolean }).samePage)).toBeUndefined();
});

test("first setup cannot consume preloaded protected access", async ({ page }) => {
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false } }));
  await page.goto("/roster");
  await expect(page.getByRole("heading", { name: "Create your installation" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Roster members" })).toHaveCount(0);
});

test("slow setup revalidates module access instead of consuming an expired preflight", async ({ page }) => {
  let releaseSetup!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  let reads = 0;
  await page.route("**/setup/status", async (route) => { await gate; await route.continue(); });
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot({ enabled: ++reads === 1 }) }));
  const initialModule = page.waitForResponse("**/platform/modules");
  await page.goto("/roster");
  await initialModule;
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 6_000; });
  releaseSetup();
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Not enabled");
  expect(reads).toBeGreaterThan(1);
});

test("refresh verifies an expired session and successful first setup reads a new session", async ({ page }) => {
  await page.goto("/roster");
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
  let configured = false;
  await page.route("**/auth/session", (route) => configured ? route.continue() : route.fulfill({ status: 401, json: { error: "Expired" } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Roster members" })).toHaveCount(0);
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false } }));
  await page.route("**/setup/bootstrap", (route) => { configured = true; return route.fulfill({ json: {} }); });
  await page.reload();
  await page.getByLabel("One-time setup code").fill("synthetic-setup-code");
  await page.getByLabel("Organization name").fill("Synthetic arts");
  await page.getByLabel("Admin username", { exact: true }).fill("synthetic-admin");
  await page.getByLabel(/^Admin password/).fill("synthetic-password");
  await page.getByLabel("Confirm Admin password").fill("synthetic-password");
  await page.getByRole("button", { name: "Create first Admin" }).click();
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
});

test("leaderboard starts at the catalog baseline and does not refetch for late Discord capabilities", async ({ page }) => {
  const queries: string[] = [];
  let releaseCapabilities!: () => void;
  const capabilitiesGate = new Promise<void>((resolve) => { releaseCapabilities = resolve; });
  await page.route("**/integrations/capabilities", async (route) => { await capabilitiesGate; await route.continue(); });
  await page.route("**/reports/catalog", async (route) => { const response = await route.fetch(); await route.fulfill({ json: { ...await response.json(), baseline: "2026-01-01" } }); });
  await page.route("**/reports/leaderboard*", async (route) => {
    queries.push(new URL(route.request().url()).search);
    const response = await route.fetch(); await route.fulfill({ json: { ...await response.json(), baseline: "2026-01-01" } });
  });
  await page.goto("/reports");
  await expect(page.getByRole("table", { name: "Attendance leaderboard" })).toContainText("Avery Stone");
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((query) => new URLSearchParams(query).get("from") === "2026-01-01")).toBe(true);
  const beforeCapabilities = queries.length;
  const contests = page.waitForResponse("**/discord/contests");
  releaseCapabilities();
  await contests;
  expect(queries).toHaveLength(beforeCapabilities);
});

test("contest failure keeps attendance visible and a filter change retries contest review", async ({ page }) => {
  let fail = true;
  await page.route("**/discord/contests", (route) => fail ? route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }) : route.continue());
  await page.goto("/reports");
  await expect(page.getByRole("table", { name: "Attendance leaderboard" })).toContainText("Avery Stone");
  await expect(page.getByText("Contest review unavailable: Temporarily unavailable", { exact: true })).toBeVisible();
  fail = false;
  const retry = page.waitForResponse("**/discord/contests");
  await page.getByLabel("Sort attendance leaderboard").selectOption("first-name");
  await retry;
  await expect(page.getByText("Contest review unavailable: Temporarily unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Attendance leaderboard" })).toContainText("Avery Stone");
});

test("Reports initial load retains the leaderboard under network latency", async ({ page }) => {
  await measure(page, "/reports");
});

test("warm Reports navigation retains the leaderboard under network latency", async ({ page }) => {
  await page.goto("/roster");
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");
  await measure(page, "/reports", true);
});

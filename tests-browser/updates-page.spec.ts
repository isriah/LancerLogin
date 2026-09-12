import { expect, test, type Route } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

test("Updates shows local information while the release feed stalls, then degrades and recovers", async ({ page }) => {
  await page.route("**/admin/update-info", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releaseVersion: "0.15.0", workflowUrl: "https://github.example.test/actions/workflows/deploy.yml" }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1, lastSeenAt: new Date().toISOString(), releaseVersion: "0.14.0" }] }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [] }) }));

  const stalledReleaseRoutes: Route[] = [];
  let releaseAvailable = false;
  let releaseAttempts = 0;
  let firstReleaseRequested!: () => void;
  const releaseRequested = new Promise<void>((resolve) => { firstReleaseRequested = resolve; });
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", async (route) => {
    releaseAttempts += 1;
    if (!releaseAvailable) { stalledReleaseRoutes.push(route); firstReleaseRequested(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tag_name: "v0.15.0", html_url: "https://github.example.test/releases/v0.15.0" }) });
  });

  await page.clock.install();
  await page.goto("/settings/updates");
  await releaseRequested;
  await expect(page.getByRole("heading", { name: "Updates" })).toBeVisible();
  await expect(page.getByText("0.15.0", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".dashboard-loading-overlay")).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Back up and begin update" })).toBeDisabled();
  await page.waitForTimeout(100);
  releaseAvailable = true;
  await Promise.all(stalledReleaseRoutes.map((route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" })));
  await expect(page.getByRole("status").filter({ hasText: "Installed information is available" })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Back up and begin update" })).toBeDisabled();

  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toBeDisabled();
  const attemptsBeforeCooldown = releaseAttempts;
  await page.clock.runFor(29_000);
  expect(releaseAttempts).toBe(attemptsBeforeCooldown);
  await page.clock.runFor(31_000);
  await expect(page.getByRole("status").filter({ hasText: "This installation is current" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read release notes" })).toBeVisible();
  expect(releaseAttempts).toBeGreaterThan(stalledReleaseRoutes.length);
});

test("Updates keeps a confirmed kiosk release visible across responsive branded themes", async ({ page }, testInfo) => {
  const cases = [
    { width: 1280, height: 900, theme: "light" },
    { width: 1280, height: 900, theme: "dark" },
    { width: 390, height: 844, theme: "light" },
    { width: 390, height: 844, theme: "dark" },
  ];
  let installed = "0.21.0";
  await page.route("**/admin/update-info", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releaseVersion: installed, workflowUrl: "https://github.example.test/actions/workflows/deploy.yml" }) }));
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, installation: { authMode: "local" }, settings: { organizationName: "Reference Arts Collective", subtitle: "Shared operations", primaryColor: dashboardConformanceReferences.brand.primary, secondaryColor: dashboardConformanceReferences.brand.secondary, appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30 } }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1, lastSeenAt: new Date().toISOString(), releaseVersion: "0.22.0" }] }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [{ id: "update-1", type: "install_latest", createdAt: "2026-09-05T12:00:00.000Z", completedAt: "2026-09-05T12:01:00.000Z", success: 1, requestedReleaseVersion: "v0.22.0", releaseVersionBefore: "0.21.0", resolutionStatus: "succeeded", resolvedReleaseVersion: "0.22.0", resolvedAt: "2026-09-05T12:02:00.000Z" }] }) }));
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tag_name: "v0.23.0", html_url: "https://github.example.test/releases/v0.23.0" }) }));

  for (const item of cases) {
    await page.setViewportSize({ width: item.width, height: item.height });
    await page.addInitScript(({ theme }) => localStorage.setItem("lancerlogin-theme", theme), item);
    installed = "0.21.0";
    await page.goto("/settings/updates");
    await expect(page.locator(".app")).toHaveAttribute("data-theme", item.theme);
    await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
    await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
    const action = page.getByRole("button", { name: "Back up and begin update" });
    await expect(action).toBeEnabled();
    await expect(page.locator("main h1")).toHaveCount(1);
    expect(await action.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    const checkAction = page.getByRole("button", { name: "Check for updates", exact: true });
    expect(await checkAction.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await checkAction.focus();
    expect(await checkAction.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await action.focus();
    expect(await action.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    const status = page.getByRole("status").filter({ hasText: "Installed successfully. This kiosk now reports 0.22.0." });
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute("data-tone", "success");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    installed = "0.23.0";
    await page.reload();
    await expect(action).toBeDisabled();
    await expect(page.locator(".settings-notice")).toContainText("This installation is current");
    expect(await action.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--surface-soft)";
      element.append(probe);
      const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor;
      probe.remove();
      return matches;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const dismiss = page.getByRole("button", { name: "Dismiss update notice" });
    if (await dismiss.isVisible()) await dismiss.click();
    await page.screenshot({ path: testInfo.outputPath(`current-${item.width}-${item.theme}.png`), fullPage: true });
  }
});

for (const scenario of [
  { installed: "0.23.0", latest: "v0.23.0", current: true },
  { installed: "0.24.0", latest: "v0.23.0", current: true },
  { installed: "Unknown", latest: "v0.23.0", current: false },
  { installed: "0.22.0", latest: "v0.23.0oops", current: false },
  { installed: "0.22.0", latest: "v0.23.0-beta.1", current: false },
]) {
  test(`Updates mutes dashboard action for ${scenario.installed} against ${scenario.latest}`, async ({ page }) => {
    await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: scenario.installed, workflowUrl: "https://github.example.test/actions/workflows/deploy.yml" } }));
    await page.route("**/admin/kiosks", (route) => route.fulfill({ json: { kiosks: [] } }));
    await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => route.fulfill({ json: { tag_name: scenario.latest } }));
    let backups = 0;
    await page.route("**/admin/data/backup?scope=installation", (route) => { backups++; return route.fulfill({ body: "{}" }); });
    await page.goto("/settings/updates");
    const status = page.locator(".settings-notice");
    await expect(status).toHaveAttribute("data-tone", scenario.current ? "success" : "error");
    await expect(status).toContainText(scenario.current ? "This installation is current" : "could not be confirmed");
    const action = page.getByRole("button", { name: "Back up and begin update" });
    await expect(action).toBeDisabled();
    await action.evaluate((button: HTMLButtonElement) => button.click());
    expect(backups).toBe(0);
  });
}


test("release checks share15-minute cache across reloads while local status polls, and keyboard manual checks coalesce", async ({ page }) => {
  let installedReads = 0; let releaseReads = 0; let tag = "v0.23.0"; const pending: Route[] = []; let stall = false;
  await page.route("**/admin/update-info", (route) => { installedReads++; return route.fulfill({ json: { releaseVersion: "0.22.0", workflowUrl: "https://github.example.test/deploy" } }); });
  await page.route("**/admin/kiosks", (route) => route.fulfill({ json: { kiosks: [] } }));
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => { releaseReads++; if (stall) { pending.push(route); return; } return route.fulfill({ json: { tag_name: tag } }); });
  await page.clock.install(); await page.goto("/settings/updates");
  await expect(page.locator(".settings-notice")).toContainText("newer community release"); expect(releaseReads).toBe(1);
  const initialInstalledReads = installedReads;
  await page.clock.runFor(60_000); expect(releaseReads).toBe(1); expect(installedReads).toBeGreaterThan(initialInstalledReads);
  await page.reload(); await expect(page.locator(".settings-notice")).toContainText("newer community release"); expect(releaseReads).toBe(1);
  stall = true; tag = "v0.24.0";
  const check = page.getByRole("button", { name: "Check for updates", exact: true }); await check.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => pending.length).toBe(1); await expect(page.getByRole("button", { name: "Checking for updates…", exact: true })).toBeDisabled();
  await page.keyboard.press("Enter"); expect(releaseReads).toBe(2);
  await pending[0].fulfill({ json: { tag_name: tag } }); await expect(page.locator(".version-grid").first()).toContainText("0.24.0");
  await expect(check).toBeEnabled(); await expect(page.locator("#release-check-status")).toContainText("Last checked");
  await page.clock.runFor(14 * 60_000); expect(releaseReads).toBe(2);
  stall = false; await page.clock.runFor(91_000); await expect.poll(() => releaseReads).toBe(3);
});
test("rate-limit cooldown persists on reload and stale data cannot queue an update", async ({ page }) => {
  let limited = false; let releases = 0; let commands = 0;
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: "0.22.0", workflowUrl: "https://github.example.test/deploy" } }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ json: { kiosks: [{ id: "kiosk-1", active: 1, name: "Front desk", lastSeenAt: new Date().toISOString(), releaseVersion: "0.22.0" }] } }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => { if (route.request().method() === "POST") commands++; return route.fulfill({ json: { commands: [] } }); });
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => { releases++; return limited ? route.fulfill({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600), "retry-after": "120", "access-control-expose-headers": "X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After" }, body: "{}" }) : route.fulfill({ json: { tag_name: "v0.23.0" } }); });
  await page.goto("/settings/updates"); await expect(page.getByRole("button", { name: "Update to latest stable", exact: true })).toBeEnabled();
  limited = true; await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(page.locator("#release-check-status")).toContainText("Previously checked release");
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back up and begin update" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Update to latest stable", exact: true })).toBeDisabled();
  expect(releases).toBe(2); await page.reload();
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toBeDisabled(); await expect(page.locator("#release-check-status")).toContainText("Next check after"); expect(releases).toBe(2);
  await page.getByRole("button", { name: "Update to latest stable", exact: true }).evaluate((button: HTMLButtonElement) => button.click()); expect(commands).toBe(0);
});

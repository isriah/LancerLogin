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

  await page.goto("/settings/updates");
  await releaseRequested;
  await expect(page.getByRole("heading", { name: "Updates" })).toBeVisible();
  await expect(page.getByText("0.15.0", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".dashboard-loading-overlay")).toHaveCount(0);

  await page.waitForTimeout(100);
  releaseAvailable = true;
  await Promise.all(stalledReleaseRoutes.map((route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" })));
  await expect(page.getByRole("status").filter({ hasText: "Installed information is available" })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true }).first()).toBeVisible();

  await expect(page.getByRole("status").filter({ hasText: "This installation is current" })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("link", { name: "Read release notes" })).toBeVisible();
  expect(releaseAttempts).toBeGreaterThan(stalledReleaseRoutes.length);
});

test("Updates keeps a confirmed kiosk release visible across responsive branded themes", async ({ page }) => {
  const cases = [
    { width: 1280, height: 900, theme: "light" },
    { width: 1280, height: 900, theme: "dark" },
    { width: 390, height: 844, theme: "light" },
    { width: 390, height: 844, theme: "dark" },
  ];
  await page.route("**/admin/update-info", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releaseVersion: "0.21.0", workflowUrl: "https://github.example.test/actions/workflows/deploy.yml" }) }));
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, installation: { authMode: "local" }, settings: { organizationName: "Reference Arts Collective", subtitle: "Shared operations", primaryColor: dashboardConformanceReferences.brand.primary, secondaryColor: dashboardConformanceReferences.brand.secondary, appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30 } }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1, lastSeenAt: new Date().toISOString(), releaseVersion: "0.22.0" }] }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [{ id: "update-1", type: "install_latest", createdAt: "2026-09-05T12:00:00.000Z", completedAt: "2026-09-05T12:01:00.000Z", success: 1, requestedReleaseVersion: "v0.22.0", releaseVersionBefore: "0.21.0", resolutionStatus: "succeeded", resolvedReleaseVersion: "0.22.0", resolvedAt: "2026-09-05T12:02:00.000Z" }] }) }));
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tag_name: "v0.23.0", html_url: "https://github.example.test/releases/v0.23.0" }) }));

  for (const item of cases) {
    await page.setViewportSize({ width: item.width, height: item.height });
    await page.addInitScript(({ theme }) => localStorage.setItem("lancerlogin-theme", theme), item);
    await page.goto("/settings/updates");
    await expect(page.locator(".app")).toHaveAttribute("data-theme", item.theme);
    await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
    await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
    const status = page.getByRole("status").filter({ hasText: "Installed successfully. This kiosk now reports 0.22.0." });
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute("data-tone", "success");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

import { expect, test, type Route } from "@playwright/test";

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

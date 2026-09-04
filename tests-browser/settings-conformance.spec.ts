import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

const settings = {
  organizationName: "Reference Arts Collective",
  subtitle: "Shared operations with a long adopter subtitle that must wrap without clipping",
  logoData: "",
  primaryColor: dashboardConformanceReferences.brand.primary,
  secondaryColor: dashboardConformanceReferences.brand.secondary,
  appearance: "dark",
  logoBackdrop: "auto",
  lateScanMinutes: 30,
  discordContestWindowHours: 24,
  attendanceReportingStartsOn: null,
};

const routes = [
  ["/settings/organization", "Organization"],
  ["/settings/configuration", "Configuration"],
  ["/settings/access", "Dashboard access"],
  ["/settings/integrations", "Integrations"],
  ["/settings/privacy", "Privacy"],
  ["/settings/data", "Data management"],
  ["/settings/guided-setup", "Guided Setup"],
  ["/settings/updates", "Updates"],
] as const;

async function useSettingsContext(page: Page, role: "admin" | "operator" = "admin") {
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, installation: { authMode: "local" }, settings }) }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { role } }) }));
  await page.route("**/admin/setup/progress", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map((step) => ({ step })) }) }));
  await page.route("**/integrations/capabilities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: false, configured: false } } }) }));
  await page.route("**/admin/branding", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings }) }));
  await page.route("**/admin/members", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: "avery@example.org", active: 1 }] }) }));
  await page.route("**/admin/users", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users: [{ id: "user-1", localUsername: "admin", role: "admin", active: 1, memberId: "member-1", memberExternalId: "A-101", memberFirstName: "Avery", memberLastName: "Stone", createdAt: new Date().toISOString() }] }) }));
  await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: true, saved: true, configured: true, state: "configured" }, { provider: "resend", enabled: true, saved: true, configured: false, state: "verification_required" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] }) }));
  await page.route("**/admin/privacy", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ telemetryAccepted: false, notice: "Anonymous usage reporting is off. No report will be sent.", installationReference: "installation-reference-without-personal-data" }) }));
  await page.route("**/admin/update-info", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releaseVersion: "0.18.0", workflowUrl: "https://github.example.test/actions/workflows/deploy.yml" }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [{ id: "kiosk-1", name: "North entrance attendance station", active: 1, lastSeenAt: new Date().toISOString(), releaseVersion: "0.18.0" }] }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [] }) }));
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tag_name: "v0.19.0", html_url: "https://example.test/releases/v0.19.0" }) }));
}

async function expectResponsiveFit(page: Page) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped: Array.from(document.querySelectorAll<HTMLElement>("main button, main a[href], main input, main select, main [role='status'], main [role='alert']")).flatMap((element) => {
      const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || bounds.width === 0) return [];
      return bounds.left < -1 || bounds.right > innerWidth + 1 ? [element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName] : [];
    }),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.clipped).toEqual([]);
}

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
    test(`all Settings routes conform at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await useSettingsContext(page);
      for (const [path, heading] of routes) {
        await page.goto(path);
        await expect(page.locator("main h1")).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
        await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
        await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
        await expect(page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: heading === "Dashboard access" ? "Access" : heading === "Data management" ? "Data" : heading })).toHaveAttribute("aria-current", "page");
        const controls = page.locator("main button:visible, main a.primary-button:visible, main input:not([type='radio']):not([type='checkbox']):visible, main select:visible, main label:has(input[type='radio']:visible), main label:has(input[type='checkbox']:visible)");
        for (const height of await controls.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
        await expectResponsiveFit(page);
      }
    });
  }
}

test("Settings validation, integration states, telemetry, and data dialogs remain explicit and keyboard focused", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => { localStorage.setItem("lancerlogin-theme", "dark"); localStorage.setItem("lancerlogin-update-dismissed:0.19.0", "true"); });
  await useSettingsContext(page);

  await page.goto("/settings/access");
  await page.getByLabel("Temporary password", { exact: true }).fill("long-enough-password");
  const confirmation = page.getByLabel("Confirm temporary password", { exact: true });
  await confirmation.fill("different-password");
  await expect(confirmation).toHaveAttribute("aria-invalid", "true");
  await expect(confirmation).toHaveAttribute("aria-describedby", "password-confirmation-error");

  await page.goto("/settings/integrations");
  await expect(page.getByText("Configured", { exact: true })).toHaveAttribute("data-tone", "success");
  await expect(page.getByText("Verification required", { exact: true })).toHaveAttribute("data-tone", "warning");
  await expect(page.getByText("Disabled", { exact: true })).toHaveAttribute("data-tone", "neutral");
  await expect(page.getByRole("group").filter({ hasText: "Set up Resend email" })).toBeVisible();

  await page.goto("/settings/privacy");
  const telemetry = page.getByRole("checkbox", { name: "Allow anonymous usage reporting" });
  await telemetry.focus();
  await expect(telemetry).toBeFocused();
  expect((await telemetry.locator("xpath=..").boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await page.goto("/settings/data");
  const opener = page.getByRole("button", { name: "Delete" }).last();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Delete Entire installation" });
  await expect(dialog).toHaveAttribute("aria-describedby", "data-action-description");
  await expect(dialog.getByRole("button", { name: "Close data action dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expectResponsiveFit(page);
});

test("Operator role cannot open any Settings route", async ({ page }) => {
  await useSettingsContext(page, "operator");
  for (const [path] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Page unavailable" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Settings categories" })).toHaveCount(0);
  }
});

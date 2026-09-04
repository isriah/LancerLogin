import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

type Role = "admin" | "operator";
type KioskState = "healthy" | "degraded" | "offline" | "unpaired";

const now = Date.now();
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
const longDeviceName = "North entrance attendance station with a deliberately long operations label that must wrap safely";
const retiredKiosk = { id: "retired-1", name: "Retired workshop kiosk with a long preserved history label", active: 0, lastSeenAt: iso(-50_000), releaseVersion: "0.17.2", pairedAt: iso(-90_000) };

function kioskFor(state: KioskState) {
  if (state === "unpaired") return [];
  return [{
    id: "kiosk-1",
    name: longDeviceName,
    active: 1,
    lastSeenAt: state === "offline" ? iso(-10) : iso(0),
    readerOnline: state === "degraded" ? 0 : 1,
    releaseVersion: "0.18.0",
    uptimeSeconds: 172_860,
    networkType: state === "offline" ? "offline" : "wifi",
    networkSignal: 72,
    lastWifiScanAt: iso(-2),
    pendingEvents: state === "degraded" ? 17 : 0,
    lastSyncAt: iso(-1),
    errorCategory: state === "degraded" ? "offline_queue" : undefined,
    pairedAt: iso(-20_000),
  }];
}

async function useKioskContext(page: Page, { role = "admin", state = "healthy", discordConfigured = true }: { role?: Role; state?: KioskState; discordConfigured?: boolean } = {}) {
  await page.route("**/setup/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      configured: true,
      installation: { authMode: "local" },
      settings: {
        organizationName: "Reference Arts Collective",
        subtitle: "Shared operations",
        logoData: "",
        primaryColor: dashboardConformanceReferences.brand.primary,
        secondaryColor: dashboardConformanceReferences.brand.secondary,
        appearance: "dark",
        logoBackdrop: "auto",
        lateScanMinutes: 30,
      },
    }),
  }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { role } }) }));
  await page.route("**/admin/setup/progress", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map((step) => ({ step })) }) }));
  await page.route("**/integrations/capabilities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: false, configured: false }, discord: { enabled: discordConfigured, configured: discordConfigured } } }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [...kioskFor(state), retiredKiosk] }) }));
  await page.route("**/admin/simulator", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ simulator: { name: "Browser test", active: 1, online: 1, lastSeenAt: iso(0), readerOnline: false, releaseVersion: "browser simulator" } }) }));
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tag_name: "v0.19.0", html_url: "https://example.test/release" }) }));
}

async function expectResponsiveFit(page: Page) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped: Array.from(document.querySelectorAll<HTMLElement>("main button, main a[href], main input, main [role='status'], main [role='alert']")).flatMap((element) => {
      const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || bounds.width === 0 || element.closest(".table-scroll")) return [];
      return bounds.left < -1 || bounds.right > innerWidth + 1 ? [element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName] : [];
    }),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.clipped).toEqual([]);
}

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
    test(`Kiosks conforms at ${viewport.width}x${viewport.height} in ${theme} mode with reference branding`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await useKioskContext(page);
      await page.goto("/kiosks");

      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: "Kiosks" })).toBeVisible();
      await expect(page.getByText("Healthy", { exact: true })).toHaveAttribute("data-tone", "success");
      await expect(page.getByText("Latest stable", { exact: true })).toBeVisible();
      await expect(page.getByText("Update available", { exact: true })).toBeVisible();
      await expect(page.getByRole("table", { name: "Retired kiosk history" })).toContainText("Retired workshop kiosk");
      await expect(page.getByRole("link", { name: "Open simulator" })).toHaveAttribute("href", "/simulator");
      const controls = page.locator(".kiosk-device-card button, .kiosk-simulator-card a, .kiosk-simulator-card button");
      for (const height of await controls.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: "Fingerprint maintenance" }).focus();
      expect(await page.getByRole("button", { name: "Fingerprint maintenance" }).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      await expectResponsiveFit(page);
    });
  }
}

for (const state of ["degraded", "offline", "unpaired"] as const) {
  test(`Kiosks presents the ${state} physical-device state without changing its operational contract`, async ({ page }) => {
    await useKioskContext(page, { state });
    await page.goto("/kiosks");
    const expected = state === "unpaired" ? "Not paired" : state[0].toUpperCase() + state.slice(1);
    await expect(page.getByText(expected, { exact: true }).first()).toBeVisible();
    if (state === "degraded") {
      await expect(page.getByText("offline queue", { exact: true })).toBeVisible();
      await expect(page.getByText("17", { exact: true })).toBeVisible();
    }
    if (state === "unpaired") await expect(page.getByRole("button", { name: "Add kiosk" })).toBeVisible();
  });
}

test("Admin pairing, maintenance, action feedback, and long errors remain focused and contained with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  await useKioskContext(page);
  const longError = `Pairing service rejected this request: ${"temporary upstream validation failure ".repeat(12)}`;
  await page.route("**/admin/pairing-codes", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: longError }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/kiosks");

  const replace = page.getByRole("button", { name: "Replace kiosk" });
  await replace.click();
  const dialog = page.getByRole("dialog", { name: "Replace physical kiosk" });
  await expect(dialog).toHaveAttribute("aria-describedby", "pair-kiosk-description");
  await expect(dialog.getByRole("button", { name: "Close pairing dialog" })).toBeFocused();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Create one-time pairing key" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(longError);
  await expectResponsiveFit(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(replace).toBeFocused();

  await page.getByRole("button", { name: "Fingerprint maintenance" }).click();
  await expect(page.getByText("Open maintenance on the physical kiosk", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reload display" }).click();
  await expect(page.getByRole("status")).toHaveText("Display reload queued. The kiosk normally receives it within five seconds.");
  await expect(page.getByRole("status")).toHaveAttribute("data-tone", "success");
});

test("Operator sees health and history without Admin management, simulator, or unconfigured Discord controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useKioskContext(page, { role: "operator", state: "degraded", discordConfigured: false });
  await page.goto("/kiosks");

  await expect(page.getByText("Degraded", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Retired kiosk history" })).toBeVisible();
  await expect(page.getByText("Unavailable until the Discord integration is enabled, saved, and verified.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Add kiosk|Replace kiosk|Rename|Reload display|Restart software|Reboot Pi|Reset network PIN|Retire kiosk|Sync Discord status/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Browser simulator" })).toHaveCount(0);
  await expectResponsiveFit(page);
});

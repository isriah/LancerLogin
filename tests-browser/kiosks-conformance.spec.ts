import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
import { discovered } from "./release-discovery";

type Role = "admin" | "operator";
type KioskState = "healthy" | "degraded" | "offline" | "unpaired";

const now = Date.now();
const iso = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
const longDeviceName = "North entrance attendance station with a deliberately long operations label that must wrap safely";
const retiredKiosk = { id: "retired-1", name: "Retired workshop kiosk with a long preserved history label", active: 0, lastSeenAt: iso(-50_000), releaseVersion: "0.17.2", pairedAt: iso(-90_000) };

function kioskFor(state: KioskState, authenticationMethod = "fingerprint") {
  if (state === "unpaired") return [];
  return [{
    id: "kiosk-1",
    name: longDeviceName,
    active: 1,
    lastSeenAt: state === "offline" ? iso(-10) : iso(0),
    readerOnline: state === "degraded" ? 0 : 1,
    authenticationMethod,
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

async function useKioskContext(page: Page, { role = "admin", state = "healthy", discordConfigured = true, configuredAuthenticationMethod = "fingerprint", reportedAuthenticationMethod = "fingerprint" }: { role?: Role; state?: KioskState; discordConfigured?: boolean; configuredAuthenticationMethod?: string; reportedAuthenticationMethod?: string } = {}) {
  await page.route("**/admin/kiosks/fingerprint-sync", route => route.fulfill({ json: { enabled: false } }));
  await page.route("**/admin/kiosks/fingerprint-vault", route => route.fulfill({ json: { enabled: false, keyStatus: "ready", storedFingerprints: 0, serverManagedKeys: true } }));
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
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [...kioskFor(state, reportedAuthenticationMethod), retiredKiosk], authenticationMethod: configuredAuthenticationMethod }) }));
  await page.route("**/admin/simulator", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ simulator: { name: "Browser test", active: 1, online: 1, lastSeenAt: iso(0), readerOnline: false, releaseVersion: "browser simulator" } }) }));
  await page.route("**/admin/releases/latest", (route) => route.fulfill({ json: discovered({ tag_name: "v0.19.0", html_url: "https://example.test/release" }) }));
}

test("Fingerprint sharing cards use one themed spacing interval", async ({ page }) => {
  await useKioskContext(page);
  await page.goto("/kiosks");
  for (const title of ["Fingerprint sync", "Fingerprint cloud storage"]) {
    const card = page.getByRole("article", { name: title, exact: true });
    await expect(card).toBeVisible();
    const rhythm = await card.evaluate(element => {
      const children = [...element.children];
      const paragraph = children.findIndex(child => child.tagName === "P");
      const headingBox = children[paragraph - 1]!.getBoundingClientRect();
      const paragraphBox = children[paragraph]!.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { gap: parseFloat(style.rowGap), actual: paragraphBox.top - headingBox.bottom,
        margin: getComputedStyle(children[paragraph]!).marginBlockStart };
    });
    expect(rhythm.actual).toBeCloseTo(rhythm.gap, 0);
    expect(rhythm.margin).toBe("0px");
  }
});

for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
  test(`Fingerprint cloud storage consent is themed at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await useKioskContext(page);
    let enabled = false, writes = 0;
    await page.route("**/admin/kiosks/fingerprint-vault", async route => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON(); enabled = body.enabled; writes++;
        expect(body.confirmation).toBe(enabled ? "ENABLE CLOUD FINGERPRINT STORAGE" : "DISABLE CLOUD FINGERPRINT STORAGE");
      }
      await route.fulfill({ json: { enabled, keyStatus: "ready", storedFingerprints: enabled ? 2 : 0, serverManagedKeys: true } });
    });
    await page.goto("/kiosks");
    const panel = page.getByRole("article", { name: "Fingerprint cloud storage", exact: true });
    const toggle = panel.getByRole("button", { name: "Enable cloud storage", exact: true });
    await expect(toggle).toBeEnabled(); await toggle.scrollIntoViewIfNeeded();
    await expect(panel).toContainText("server manages the key");
    const style = await toggle.evaluate(element => {
      const css = getComputedStyle(element), probe = document.createElement("span");
      probe.style.background = "var(--primary)"; element.append(probe); const primary = getComputedStyle(probe).backgroundColor; probe.remove();
      return { primary, background: css.backgroundColor, height: element.getBoundingClientRect().height, border: css.borderTopStyle, radius: parseFloat(css.borderTopLeftRadius) };
    });
    expect(style.background).toBe(style.primary); expect(style.height).toBeGreaterThanOrEqual(44); expect(style.border).toBe("solid"); expect(style.radius).toBeGreaterThan(0);
    await toggle.focus(); expect(await toggle.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
    page.once("dialog", dialog => dialog.dismiss()); await toggle.click(); expect(writes).toBe(0);
    page.once("dialog", dialog => { expect(dialog.message()).toContain("can decrypt"); void dialog.accept(); }); await toggle.click();
    await expect(panel).toContainText("Cloud storage: On · 2 stored fingerprints");
    page.once("dialog", dialog => dialog.accept()); await panel.getByRole("button", { name: "Disable cloud storage", exact: true }).click();
    await expect(panel).toContainText("cloud templates deleted"); expect(writes).toBe(2);
    await expectResponsiveFit(page);
  });
  test(`Fingerprint sync opt-in is themed and confirmed at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await useKioskContext(page);
    let enabled = false, writes = 0, finishPatch: (() => void) | undefined;
    await page.route("**/admin/kiosks/fingerprint-sync", async route => {
      if (route.request().method() === "PATCH") {
        writes++; enabled = route.request().postDataJSON().enabled;
        await new Promise<void>(resolve => { finishPatch = resolve; });
      }
      await route.fulfill({ json: { enabled } });
    });
    await page.goto("/kiosks");
    const panel = page.getByRole("article", { name: "Fingerprint sync", exact: true });
    const toggle = panel.getByRole("button", { name: "Enable fingerprint sync", exact: true });
    await expect(toggle).toBeEnabled(); await toggle.scrollIntoViewIfNeeded();
    await expect(panel).toContainText("Installation sync: Off");
    const style = await toggle.evaluate(element => {
      const css = getComputedStyle(element); const probe = document.createElement("span");
      probe.style.background = "var(--primary)"; element.append(probe);
      const primary = getComputedStyle(probe).backgroundColor; probe.remove();
      return { background: css.backgroundColor, primary, color: css.color, border: css.borderTopStyle, borderWidth: parseFloat(css.borderTopWidth), radius: parseFloat(css.borderTopLeftRadius), height: element.getBoundingClientRect().height };
    });
    expect(style.background).toBe(style.primary); expect(style.color).not.toBe(style.background);
    expect(style.border).toBe("solid"); expect(style.borderWidth).toBeGreaterThan(0); expect(style.radius).toBeGreaterThan(0); expect(style.height).toBeGreaterThanOrEqual(44);
    await toggle.focus(); await expect(toggle).toBeFocused();
    expect(await toggle.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
    await toggle.hover(); await expect(toggle).toBeEnabled();
    page.once("dialog", dialog => dialog.dismiss()); await toggle.click(); expect(writes).toBe(0);
    page.once("dialog", dialog => dialog.accept()); await toggle.click();
    await expect(panel.getByRole("button", { name: "Please wait…" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Refresh sync settings" })).toBeDisabled();
    await expect.poll(() => Boolean(finishPatch)).toBe(true); finishPatch!();
    await expect(panel.getByRole("button", { name: "Disable fingerprint sync" })).toBeEnabled();
    await expect(panel).toContainText("Installation sync: On"); expect(writes).toBe(1);
    await expectResponsiveFit(page);
  });
}

test("Missing or changed vault keys fail closed but allow cloud deletion and refresh recovery", async ({ page }) => {
  await useKioskContext(page);
  let enabled = false, keyStatus = "missing", fail = false;
  await page.route("**/admin/kiosks/fingerprint-vault", async route => {
    if (fail) { await route.fulfill({ status: 503, json: { error: "Storage temporarily unavailable" } }); return; }
    if (route.request().method() === "PATCH") enabled = route.request().postDataJSON().enabled;
    await route.fulfill({ json: { enabled, keyStatus, storedFingerprints: enabled ? 1 : 0, serverManagedKeys: true } });
  });
  await page.goto("/kiosks"); const panel = page.getByRole("article", { name: "Fingerprint cloud storage", exact: true });
  await expect(panel.getByRole("button", { name: "Enable cloud storage", exact: true })).toBeDisabled();
  await expect(panel.getByRole("alert")).toContainText("is missing");
  enabled = true; keyStatus = "changed"; await panel.getByRole("button", { name: "Refresh cloud storage" }).click();
  await expect(panel.getByRole("alert")).toContainText("recover the original");
  page.once("dialog", dialog => dialog.accept()); await panel.getByRole("button", { name: "Disable cloud storage", exact: true }).click();
  await expect(panel).toContainText("cloud templates deleted");
  fail = true; await panel.getByRole("button", { name: "Refresh cloud storage" }).click();
  await expect(panel.getByRole("button", { name: "Enable cloud storage", exact: true })).toBeDisabled();
  fail = false; keyStatus = "ready"; await panel.getByRole("button", { name: "Refresh cloud storage" }).click();
  await expect(panel.getByRole("button", { name: "Enable cloud storage", exact: true })).toBeEnabled();
});

test("Fingerprint sync settings fail closed and recover through refresh", async ({ page }) => {
  await useKioskContext(page);
  let fail = true;
  await page.route("**/admin/kiosks/fingerprint-sync", route => fail ? route.fulfill({ status: 503, json: { error: "Sync settings temporarily unavailable" } }) : route.fulfill({ json: { enabled: false } }));
  await page.goto("/kiosks");
  const panel = page.getByRole("article", { name: "Fingerprint sync", exact: true });
  await expect(panel.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(panel.getByRole("button", { name: "Enable fingerprint sync", exact: true })).toBeDisabled();
  fail = false; await panel.getByRole("button", { name: "Refresh sync settings" }).click();
  await expect(panel.getByRole("button", { name: "Enable fingerprint sync", exact: true })).toBeEnabled();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

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
      await expect(page.getByText("Available on selected track", { exact: true })).toBeVisible();
      await expect(page.getByText("Update available", { exact: true })).toBeVisible();
      await expect(page.getByRole("table", { name: "Retired kiosk history" })).toContainText("Retired workshop kiosk");
      await expect(page.getByRole("link", { name: "Open simulator" })).toHaveAttribute("href", "/simulator");
      const controls = page.locator(".kiosk-device-card button, .kiosk-simulator-card a, .kiosk-simulator-card button");
      for (const height of await controls.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: "Authentication maintenance" }).focus();
      expect(await page.getByRole("button", { name: "Authentication maintenance" }).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
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

test("multiple active kiosks remain independently selectable and manageable", async ({ page }) => {
  await useKioskContext(page);
  const frontDesk = kioskFor("healthy")[0]!;
  const workshop = { ...frontDesk, id: "kiosk-2", name: "Workshop entrance", releaseVersion: "0.17.0", networkType: "ethernet", networkSignal: null };
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [frontDesk, workshop, retiredKiosk], authenticationMethod: "fingerprint" }) }));
  await page.goto("/kiosks");

  const switcher = page.getByRole("tablist", { name: "Active physical kiosks" });
  await expect(switcher.getByRole("tab")).toHaveCount(2);
  await expect(page.getByText("2 active devices", { exact: true })).toBeVisible();
  await switcher.getByRole("tab", { name: /Workshop entrance/ }).click();
  await expect(switcher.getByRole("tab", { name: /Workshop entrance/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".kiosk-state").getByText("Workshop entrance", { exact: true })).toBeVisible();
  await expect(page.locator(".kiosk-diagnostics")).toContainText("0.17.0");

  await page.getByRole("button", { name: "Add kiosk" }).click();
  const dialog = page.getByRole("dialog", { name: "Add physical kiosk" });
  await expect(dialog.getByText("without interrupting any existing kiosk", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
});

test("Admin pairing, maintenance, action feedback, and long errors remain focused and contained with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  await useKioskContext(page);
  const longError = `Pairing service rejected this request: ${"temporary upstream validation failure ".repeat(12)}`;
  await page.route("**/admin/pairing-codes", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: longError }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/kiosks");

  const add = page.getByRole("button", { name: "Add kiosk" });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Add physical kiosk" });
  await expect(dialog).toHaveAttribute("aria-describedby", "pair-kiosk-description");
  await expect(dialog.getByRole("button", { name: "Close pairing dialog" })).toBeFocused();
  await dialog.getByRole("button", { name: "Create one-time pairing key" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(longError);
  await expectResponsiveFit(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();

  await page.getByRole("button", { name: "Authentication maintenance" }).click();
  await expect(page.getByText("Open maintenance on the physical kiosk", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reload display" }).click();
  const actionStatus = page.getByRole("status").filter({ hasText: "Display reload queued." });
  await expect(actionStatus).toHaveText("Display reload queued. The kiosk normally receives it within five seconds.");
  await expect(actionStatus).toHaveAttribute("data-tone", "success");
});

test("configured authentication stays visibly pending until the physical kiosk reports it applied", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await useKioskContext(page, { configuredAuthenticationMethod: "qr", reportedAuthenticationMethod: "fingerprint" });
  await page.goto("/kiosks");
  const authentication = page.locator(".kiosk-diagnostics > div").filter({ has: page.getByText("Authentication", { exact: true }) });
  await expect(authentication).toContainText("Fingerprint");
  await expect(authentication).toContainText("QR code configured - waiting for kiosk sync");
  const selector = page.getByLabel("Authentication method");
  await expect(selector).toHaveValue("qr");
  await expect(selector).toHaveClass(/ui-native-select/);
  const save = page.getByRole("button", { name: "Save method" });
  await expect(save).toBeDisabled();
  await selector.selectOption("nfc");
  await expect(save).toBeEnabled();
  expect((await selector.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(authentication).toContainText("Fingerprint");
  await expect(authentication).toContainText("QR code configured - waiting for kiosk sync");
});

test("Operator sees health and history without Admin management, simulator, or unconfigured Discord controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useKioskContext(page, { role: "operator", state: "degraded", discordConfigured: false });
  await page.goto("/kiosks");

  await expect(page.getByText("Degraded", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Retired kiosk history" })).toBeVisible();
  await expect(page.getByText("Unavailable until the Discord integration is enabled, saved, and verified.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add kiosk|Rename|Reload display|Restart software|Reboot Pi|Reset network PIN|Retire kiosk|Sync Discord status/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Browser simulator" })).toHaveCount(0);
  await expectResponsiveFit(page);
});

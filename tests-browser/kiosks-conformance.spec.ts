import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
import { discovered } from "./release-discovery";
import { pairedViews } from "./paired-views";

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
  await page.route("**/admin/update-channel", route => route.fulfill({ json: { channel: "stable", revision: 0 } }));
  await page.route("**/admin/kiosks/scan-reviews?**", route => route.fulfill({ json: { records: [], hasMore: false } }));
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
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [...kioskFor(state, reportedAuthenticationMethod).map(kiosk => ({ ...kiosk, configuredAuthenticationMethod })), retiredKiosk], authenticationMethod: configuredAuthenticationMethod }) }));
  await page.route("**/admin/simulator", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ simulator: { name: "Browser test", active: 1, online: 1, lastSeenAt: iso(0), readerOnline: false, releaseVersion: "browser simulator" } }) }));
  await page.route("**/admin/releases/latest", (route) => route.fulfill({ json: discovered({ tag_name: "v0.19.0", html_url: "https://example.test/release" }) }));
}

for (const width of [390, 1280]) test(`Per-kiosk enrollment popup selects a member and follows progress at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await useKioskContext(page);
  await page.route("**/admin/members", route => route.fulfill({ json: { members: [{ id: "roster-1", memberId: "SYN-001", firstName: "Synthetic", lastName: "Member", active: true }] } }));
  let session: Record<string, unknown> | null = null, starts = 0, cancellations = 0;
  await page.route("**/admin/kiosks/kiosk-1/enrollment**", async route => {
    const method = route.request().method();
    if (method === "POST") { starts++; session = { id: "session-1", expiresAt: iso(5), state: "waiting_member", progress: "waiting_member" }; }
    if (method === "PATCH") { expect(route.request().postDataJSON()).toEqual({ memberId: "roster-1" }); session = { ...session, state: "ready", progress: "awaiting_confirmation", member: { rosterId: "roster-1", memberId: "SYN-001", firstName: "Synthetic", lastName: "Member" } }; }
    if (method === "DELETE") cancellations++;
    await route.fulfill({ json: { session, cancelled: method === "DELETE" } });
  });
  await page.goto("/kiosks");
  const begin = page.getByRole("button", { name: `Begin enrollment on ${longDeviceName}` });
  await begin.click();
  const dialog = page.getByRole("dialog", { name: "Fingerprint enrollment" });
  await expect(dialog).toBeVisible(); await expect(dialog.getByText(longDeviceName, { exact: true })).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Search members" }).fill("SYN-001");
  await dialog.getByRole("button", { name: "Synthetic Member SYN-001" }).click();
  await expect(dialog.getByText("Waiting for name confirmation on the kiosk.")).toBeVisible();
  session = { ...session, progress: "enroll_wait_first" };
  await expect(dialog.getByText("Place a finger on the kiosk reader for the first scan.")).toBeVisible();
  session = { ...session, progress: "enroll_success" };
  await expect(dialog.getByText("Fingerprint enrolled successfully.")).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(cancellations).toBe(0); expect(starts).toBe(1);
  await begin.click(); await dialog.getByRole("button", { name: "Cancel enrollment", exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(cancellations).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test("Unconfigured simulator links to guided setup and operators cannot start enrollment", async ({ page }) => {
  await useKioskContext(page);
  await page.route("**/admin/simulator", route => route.fulfill({ json: { simulator: null } }));
  await page.goto("/kiosks");
  await expect(page.getByRole("link", { name: "Set up browser simulator" })).toHaveAttribute("href", "/settings/guided-setup");
  await useKioskContext(page, { role: "operator" });
  await page.reload();
  await expect(page.getByRole("button", { name: /^Begin enrollment/ })).toHaveCount(0);
});

test("Fingerprint sharing cards use one themed spacing interval", async ({ page }) => {
  await useKioskContext(page);
  await page.goto("/settings/fingerprint-sharing");
  for (const title of ["Cloud storage"]) {
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
    await page.goto("/settings/fingerprint-sharing");
    const panel = page.getByRole("article", { name: "Cloud storage", exact: true });
    const toggle = panel.getByRole("button", { name: "Enable cloud storage", exact: true });
    await expect(toggle).toBeEnabled(); await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`kiosk-sharing-${width}-${theme}.png`), fullPage: false });
    await panel.getByRole("button", { name: "About cloud storage" }).focus();
    await expect(page.getByRole("tooltip")).toContainText("server manages the key");
    await page.keyboard.press("Escape");
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
  test(`Cloud-only sync has no peer controls at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await useKioskContext(page);
    const requests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/admin/kiosks/fingerprint-sync")) requests.push(request.url()); });
    await page.goto("/settings/fingerprint-sharing");
    await expect(page.getByRole("article", { name: "Cloud storage", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Peer sync", exact: true })).toHaveCount(0);
    expect(requests).toEqual([]);
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
  await page.goto("/settings/fingerprint-sharing"); const panel = page.getByRole("article", { name: "Cloud storage", exact: true });
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
      const edit = page.getByRole("button", { name: `Rename ${longDeviceName}`, exact: true });
      await edit.focus();
      const iconOffset = await edit.evaluate(button => { const box = button.getBoundingClientRect(), icon = button.querySelector("svg")!.getBoundingClientRect(); return { x: Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2), y: Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2) }; });
      expect(iconOffset.x).toBeLessThan(1); expect(iconOffset.y).toBeLessThan(1);
      const style = await edit.evaluate(element => {
        const css = getComputedStyle(element), probe = document.createElement("span");
        probe.style.cssText = "color:var(--ui-text);background:var(--ui-surface-subtle);border:1px solid var(--ui-border);border-radius:var(--radius-control)";
        element.append(probe); const tokens = getComputedStyle(probe);
        const value = { background: css.backgroundColor, text: css.color, border: css.borderTopColor, radius: css.borderTopLeftRadius, expectedBackground: tokens.backgroundColor, expectedText: tokens.color, expectedBorder: tokens.borderTopColor, expectedRadius: tokens.borderTopLeftRadius, outline: parseFloat(css.outlineWidth), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height };
        probe.remove(); return value;
      });
      expect(style.background).toBe(style.expectedBackground); expect(style.text).toBe(style.expectedText); expect(style.border).toBe(style.expectedBorder); expect(style.radius).toBe(style.expectedRadius);
      expect(style.width).toBeGreaterThanOrEqual(44); expect(style.height).toBeGreaterThanOrEqual(44); expect(style.outline).toBeGreaterThan(0);
      await page.keyboard.press("Enter"); await expect(page.getByLabel("Device name", { exact: true })).toBeFocused();
      await page.keyboard.press("Escape"); await expect(edit).toBeFocused();
      await expect(page.getByText("Healthy", { exact: true })).toHaveAttribute("data-tone", "success");
      await expect(page.getByText("Latest stable release", { exact: true })).toBeVisible();
      await expect(page.getByText("Update available", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Device history" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Open simulator" })).toHaveAttribute("href", "/simulator");
      const controls = page.locator(".kiosk-device-card button, .kiosk-simulator-card a, .kiosk-simulator-card button");
      for (const height of await controls.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
      await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
      await page.getByText("Authentication settings", { exact: true }).click();
      await page.keyboard.press("Tab");
      await page.getByRole("button", { name: "Authentication maintenance" }).focus();
      expect(await page.getByRole("button", { name: "Authentication maintenance" }).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      await page.goto("/settings/fingerprint-sharing");
      const cloud = page.getByRole("article", { name: "Cloud storage", exact: true });
      await expect(cloud).toBeVisible();
      const actionCenters = await cloud.evaluate(element => [...element.querySelectorAll(".kiosk-actions button")].map(button => { const box = button.getBoundingClientRect(); return box.y + box.height / 2; }));
      expect(actionCenters[0]).toBeCloseTo(actionCenters[1]!, 0);
      await expectResponsiveFit(page);
      await page.screenshot({ path: test.info().outputPath(`kiosks-${viewport.width}-${theme}.png`), fullPage: true });
    });
  }
}

for (const state of ["degraded", "offline", "unpaired"] as const) {
  test(`Kiosks presents the ${state} physical-device state without changing its operational contract`, async ({ page }) => {
    await useKioskContext(page, { state });
    await page.goto("/kiosks");
    const expected = state === "unpaired" ? "No kiosk paired" : state[0].toUpperCase() + state.slice(1);
    await expect(page.getByText(expected, { exact: true }).first()).toBeVisible();
    if (state === "degraded") {
      await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
      await page.getByText("Diagnostics", { exact: true }).click();
      await expect(page.getByText("Saved scans need attention. Open maintenance on this kiosk to check its clock and review rejected scans.", { exact: true })).toBeVisible();
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

  const switcher = page.getByRole("group", { name: "Active physical kiosks" });
  await expect(switcher.locator(".kiosk-device-select")).toHaveCount(2);
  await expect(page.getByText("2 active devices", { exact: true })).toBeVisible();
  await switcher.getByRole("button", { name: /^Workshop entrance/ }).click();
  await expect(switcher.getByRole("button", { name: /^Workshop entrance/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".kiosk-device-card > .kiosk-state")).toHaveCount(0);
  await expect(page.locator(".kiosk-summary")).toContainText("0.17.0");

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

  await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
  await page.getByText("Authentication settings", { exact: true }).click();
  await page.getByRole("button", { name: "Authentication maintenance" }).click();
  await expect(page.getByText("Open maintenance on the physical kiosk", { exact: true })).toBeVisible();
  await page.getByText("Device maintenance", { exact: true }).click();
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
  await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
  await page.getByText("Authentication settings", { exact: true }).click();
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

test("selected-device authentication and inline rename leave other kiosks unchanged", async ({ page }) => {
  await useKioskContext(page);
  const devices = [{ ...kioskFor("healthy")[0]!, name: "Front entrance", configuredAuthenticationMethod: "fingerprint" }, { ...kioskFor("healthy", "rfid")[0]!, id: "kiosk-2", name: "Workshop entrance", configuredAuthenticationMethod: "nfc" }];
  const writes: string[] = [];
  await page.route("**/admin/kiosks", route => route.fulfill({ json: { kiosks: [...devices, retiredKiosk] } }));
  await page.route("**/admin/kiosks/kiosk-2/authentication-method", async route => { writes.push(route.request().url()); devices[1]!.configuredAuthenticationMethod = route.request().postDataJSON().authenticationMethod; await route.fulfill({ json: { kioskId: "kiosk-2", authenticationMethod: devices[1]!.configuredAuthenticationMethod } }); });
  await page.route("**/admin/kiosks/kiosk-2", async route => { devices[1]!.name = route.request().postDataJSON().name; await route.fulfill({ json: { kiosk: devices[1] } }); });
  await page.goto("/kiosks");
  const selector = page.getByLabel("Authentication method for selected kiosk");
  await expect(selector).toHaveCount(0);
  await page.getByRole("button", { name: /^Workshop entrance/ }).click();
  await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
  await page.getByText("Authentication settings", { exact: true }).click();
  await expect(selector).toHaveValue("nfc");
  await expect(page.locator(".kiosk-summary")).toContainText("NFC badge configured - waiting for kiosk sync");
  await selector.selectOption("qr"); await page.getByRole("button", { name: "Save method", exact: true }).click();
  await expect(page.locator(".kiosk-summary")).toContainText("QR code configured - waiting for kiosk sync");
  expect(writes).toHaveLength(1);
  await page.getByRole("link", { name: "← Kiosks", exact: true }).click();
  await page.getByRole("button", { name: "Rename Workshop entrance", exact: true }).click();
  await page.getByLabel("Device name", { exact: true }).fill("Workshop door"); await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename Workshop door", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Front entrance/ }).click();
  await expect(page.locator(".kiosk-summary")).toContainText("Fingerprint");
  expect(devices[0]!.configuredAuthenticationMethod).toBe("fingerprint");
  await expect(page.locator(".kiosk-device-card > .kiosk-state")).toHaveCount(0);
  await expect(page.getByText("Device history", { exact: true })).toHaveCount(0);
});

test("release label stays neutral until the server confirms Beta", async ({ page }) => {
  await useKioskContext(page);
  let confirm!: () => void; const ready = new Promise<void>(resolve => { confirm = resolve; });
  await page.route("**/admin/update-channel", async route => { await ready; await route.fulfill({ json: { channel: "beta", revision: 1 } }); });
  await page.route("**/admin/releases/latest?channel=beta", route => route.fulfill({ json: discovered({ tag_name: "v2.0.0-beta.4", prerelease: true }, Date.now(), "beta") }));
  await page.goto("/kiosks");
  await expect(page.getByText("Latest release", { exact: true })).toBeVisible();
  await expect(page.getByText("Latest stable release", { exact: true })).toHaveCount(0);
  confirm(); await expect(page.getByText("Latest beta release", { exact: true })).toBeVisible();
});

test("Cloud storage fills the sharing row without an empty peer column", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await useKioskContext(page);
  await page.route("**/admin/kiosks/fingerprint-vault", route => route.fulfill({ json: { enabled: false, keyStatus: "missing", storedFingerprints: 0, serverManagedKeys: true } }));
  await page.goto("/settings/fingerprint-sharing");
  const cloud = page.getByRole("article", { name: "Cloud storage", exact: true });
  await expect(cloud.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("article", { name: "Peer sync", exact: true })).toHaveCount(0);
  const fit = await cloud.evaluate(element => {
    const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect();
    return { width: box.width, available: parent.width };
  });
  expect(fit.width).toBeGreaterThanOrEqual(fit.available - 2);
  await expectResponsiveFit(page);
});

test("Operator sees health without Admin management, simulator, or unconfigured Discord controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useKioskContext(page, { role: "operator", state: "degraded", discordConfigured: false });
  await page.goto("/kiosks");

  await expect(page.getByText("Degraded", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Retired kiosk history" })).toHaveCount(0);
  await expect(page.getByText("Unavailable until the Discord integration is enabled, saved, and verified.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add kiosk|Rename|Reload display|Restart software|Reboot Pi|Reset network PIN|Retire kiosk|Sync Discord status/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Browser simulator" })).toHaveCount(0);
  await expectResponsiveFit(page);
});

for (const { theme, width } of pairedViews) {
  test(`cloud enrollment retirement is explicit and preserves other enrollments ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await useKioskContext(page);
    await page.route("**/admin/kiosks/fingerprint-vault", route => route.fulfill({ json: { enabled: true, keyStatus: "ready", storedFingerprints: 2, serverManagedKeys: true } }));
    const rows = ["a", "b"].map(letter => ({ fingerprintId: letter.repeat(64), vaultId: "c".repeat(64), rosterId: "member", memberId: "SYN-001", firstName: "Synthetic", lastName: "Member with a long display name", createdAt: Date.now() }));
    let deletes = 0;
    await page.route("**/admin/kiosks/fingerprint-vault/enrollments**", route => {
      if (route.request().method() === "DELETE") {
        deletes++; expect(route.request().postDataJSON()).toEqual({ vaultId: "c".repeat(64), rosterId: "member", confirmation: "RETIRE ENROLLMENT EVERYWHERE" });
        return route.fulfill({ json: { retired: true, readerTemplatesRetained: true } });
      }
      return route.fulfill({ json: { enrollments: rows } });
    });
    await page.goto("/settings/fingerprint-sharing"); const panel = page.getByRole("article", { name: "Cloud storage", exact: true });
    await panel.getByRole("button", { name: "Review cloud enrollments" }).click();
    const retire = panel.getByRole("button", { name: "Retire everywhere" }); await expect(retire).toHaveCount(2);
    await expect(panel).toContainText("Historical imported copies");
    await retire.first().scrollIntoViewIfNeeded();
    expect(await retire.first().evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    page.once("dialog", dialog => dialog.dismiss()); await retire.first().click(); expect(deletes).toBe(0);
    page.once("dialog", dialog => { expect(dialog.message()).toContain("Reader templates remain stored"); return dialog.accept(); });
    await retire.first().click(); await expect(retire).toHaveCount(1); expect(deletes).toBe(1);
    await expect(panel).toContainText("1 stored fingerprint"); await expect(panel).toContainText("Enrollment retired");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`enrollment-retirement-${theme}-${width}.png`), fullPage: true });
  });
}

test("development kiosk replacement requires confirmation and sends only consent", async ({ page }) => {
  await useKioskContext(page);
  const writes: unknown[] = [];
  await page.route("**/admin/kiosks", route => route.fulfill({ json: { kiosks: kioskFor("healthy").map(kiosk => ({ ...kiosk, releaseVersion: "0.18.0-dev.kiosk-list.fe4c8f2" })), authenticationMethod: "fingerprint" } }));
  await page.route("**/admin/kiosks/kiosk-1/commands", route => {
    if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { command: { id: "synthetic-update" } } });
  });
  await page.goto("/kiosks");
  const update = page.getByRole("button", { name: "Update kiosk", exact: true });
  await expect(update).toBeEnabled();
  page.once("dialog", dialog => dialog.dismiss()); await update.click();
  expect(writes).toEqual([]);
  page.once("dialog", dialog => { expect(dialog.message()).toContain("Development-only changes may be removed"); return dialog.accept(); });
  await update.click();
  await expect.poll(() => writes).toEqual([{ command: "install_latest", replaceDevelopmentBuild: true }]);
});

test("management route uses the selected kiosk and never falls back for a missing device", async ({ page }) => {
  await useKioskContext(page);
  const devices = [kioskFor("healthy")[0]!, { ...kioskFor("healthy")[0]!, id: "kiosk-2", name: "Studio kiosk", releaseVersion: "0.19.0" }];
  const commands: string[] = [];
  await page.route("**/admin/kiosks", route => route.fulfill({ json: { kiosks: [...devices, retiredKiosk] } }));
  await page.route("**/admin/kiosks/*/commands", route => { commands.push(route.request().url()); return route.fulfill({ json: {} }); });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/kiosks");
  await expect(page.getByRole("article", { name: "Cloud storage", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^Studio kiosk/ }).click();
  await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update kiosk", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Manage kiosk", exact: true }).click();
  await expect(page).toHaveURL(/\/kiosks\/kiosk-2\/manage$/);
  await expect(page.locator(".page-intro")).toContainText("Studio kiosk");
  for (const title of ["Diagnostics", "Authentication settings", "Device maintenance", "Retire kiosk"]) {
    const summary = page.locator(".kiosk-management-section > summary").filter({ hasText: title });
    await expect(summary).toBeVisible();
    const bounds = await summary.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeLessThanOrEqual(56);
  }
  await page.getByText("Device maintenance", { exact: true }).click();
  await page.getByRole("button", { name: "Reload display", exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toContain("/kiosk-2/commands");
  await expectResponsiveFit(page);
  for (const id of ["missing", "retired-1"]) {
    await page.goto("/kiosks/" + id + "/manage");
    await expect(page.locator('[data-walkthrough-page="kiosks"]')).toHaveAttribute("data-walkthrough-ready", "true");
    await expect(page.getByText("This kiosk is unavailable or retired.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reload display|Retire kiosk|Save method/ })).toHaveCount(0);
  }
  expect(commands).toHaveLength(1);
});

test("operator management remains read-only and fingerprint sharing stays Admin-only", async ({ page }) => {
  await useKioskContext(page, { role: "operator" });
  await page.goto("/kiosks/kiosk-1/manage");
  await page.getByText("Diagnostics", { exact: true }).click();
  await expect(page.getByText("Last successful sync", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Reload display|Retire kiosk|Save method|Update kiosk/ })).toHaveCount(0);
  await page.goto("/settings/fingerprint-sharing");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable cloud storage" })).toHaveCount(0);
});

for (const role of ["admin", "operator"] as const) for (const state of ["offline", "degraded"] as const) {
  test("managed kiosk retains " + state + " health for " + role, async ({ page }) => {
    await useKioskContext(page, { role, state });
    await page.goto("/kiosks/kiosk-1/manage");
    await expect(page.locator(".page-intro .status-pill")).toHaveText(state === "offline" ? "Offline" : "Degraded");
  });
}


test("Admin reviews rejected scans from retired kiosks without changing attendance", async ({ page }) => {
  await useKioskContext(page, { state: "unpaired" });
  let reviewed = false, attempts = 0, loadFailed = true;
  const writes: string[] = [];
  const record = { kioskId: "retired-1", kioskName: "Retired entrance kiosk", eventId: "event-1", memberId: "member-record-1", occurredAt: "2020-01-01T07:00:00Z", receivedAt: "2026-10-25T12:00:00Z", reasonCode: "outside_meeting_window", reviewStatus: "open", clock: { verified: false, observedAt: "2020-01-01T06:00:00Z", source: "offline" }, meetingId: "meeting-1" };
  page.on("request", (request) => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
  await page.route("**/admin/kiosks/scan-reviews?**", (route) => {
    if (loadFailed) return route.fulfill({ status: 503, json: { error: "Could not load scan evidence" } });
    const url = new URL(route.request().url()), status = url.searchParams.get("status"), offset = Number(url.searchParams.get("offset"));
    const records = status === "reviewed" ? reviewed ? [{ ...record, reviewStatus: "reviewed", reviewNote: "Presence corrected from event roster", reviewedAt: "2026-10-25T13:00:00Z" }] : [] : reviewed ? [] : offset ? [{ ...record, eventId: "event-2", memberId: "member-record-2" }] : [record];
    return route.fulfill({ json: { records, hasMore: status === "open" && !reviewed && offset === 0 } });
  });
  await page.route("**/admin/kiosks/retired-1/scan-reviews/event-1/review", (route) => {
    expect(route.request().postDataJSON()).toEqual({ note: "Presence corrected from event roster" });
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Review service unavailable. Try again." } });
    reviewed = true; return route.fulfill({ json: { reviewed: true } });
  });
  await page.goto("/kiosks");
  const panel = page.getByRole("region", { name: "Rejected scans", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText("Could not load scan evidence");
  await expect(panel).not.toContainText("No scans need review");
  loadFailed = false;
  await panel.getByRole("button", { name: "Refresh rejected scans" }).click();
  await expect(page.getByText("No kiosk paired", { exact: true })).toBeVisible();
  await panel.locator("summary").click();
  await expect(panel).toContainText("recorded scan time may be wrong");
  await expect(panel).toContainText("2020-01-01T07:00:00Z");
  await expect(panel.getByRole("link", { name: "Open associated meeting attendance" })).toHaveAttribute("href", "/meetings/meeting-1");
  await panel.getByRole("link", { name: "Open associated meeting attendance" }).click();
  await expect(page).toHaveURL(/\/meetings\/meeting-1$/);
  await page.goBack();
  await panel.locator("summary").click();
  await expect(panel.getByRole("button", { name: "Mark reviewed", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Next rejected scans" }).click();
  await expect(panel).toContainText("member-record-2");
  await panel.getByRole("button", { name: "Previous rejected scans" }).click();
  await panel.locator("summary").click();
  await panel.getByLabel("Review note", { exact: true }).fill("Presence corrected from event roster");
  await panel.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Review service unavailable");
  await expect(panel.getByLabel("Review note", { exact: true })).toHaveValue("Presence corrected from event roster");
  await panel.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(panel).toContainText("Attendance was not changed");
  await expect(panel).toContainText("No scans need review");
  await panel.getByRole("combobox", { name: "Review status", exact: true }).selectOption("reviewed");
  await panel.locator("summary").click();
  await expect(panel).toContainText("Presence corrected from event roster");
  await expect(panel.getByRole("button", { name: "Mark reviewed", exact: true })).toHaveCount(0);
  expect(writes).toEqual(["/admin/kiosks/retired-1/scan-reviews/event-1/review", "/admin/kiosks/retired-1/scan-reviews/event-1/review"]);
  for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator(".app").evaluate((element, theme) => element.setAttribute("data-theme", theme), theme);
    const refresh = panel.getByRole("button", { name: "Refresh rejected scans" });
    await refresh.scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await refresh.focus(); await expect(refresh).toBeFocused();
    const styles = await refresh.evaluate((element) => {
      const style = getComputedStyle(element), probe = document.createElement("span"); element.append(probe); probe.style.cssText = "background:var(--ui-surface-subtle);color:var(--ui-text);border:1px solid var(--ui-border);border-radius:var(--radius-control)"; const expected = getComputedStyle(probe);
      const result = { background: style.backgroundColor, expectedBackground: expected.backgroundColor, color: style.color, expectedColor: expected.color, border: style.borderTopColor, expectedBorder: expected.borderTopColor, radius: style.borderRadius, expectedRadius: expected.borderRadius, height: element.getBoundingClientRect().height }; probe.remove(); return result;
    });
    expect(styles.background).toBe(styles.expectedBackground); expect(styles.color).toBe(styles.expectedColor); expect(styles.border).toBe(styles.expectedBorder); expect(styles.radius).toBe(styles.expectedRadius); expect(styles.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("Operators cannot open rejected-scan reviews or request their records", async ({ page }) => {
  await useKioskContext(page, { role: "operator" });
  let reads = 0;
  await page.route("**/admin/kiosks/scan-reviews?**", route => { reads++; return route.fulfill({ status: 403, json: { error: "Forbidden" } }); });
  await page.goto("/kiosks");
  await expect(page.getByRole("heading", { level: 1, name: "Kiosks", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Rejected scans", exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
});

for (const { theme, width } of pairedViews) {
  test(`Admin bulk dismissal freezes matching scans and preserves retries at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await useKioskContext(page, { state: "unpaired" });
    const base = { memberId: "synthetic-member", occurredAt: "2020-01-01T07:00:00Z", receivedAt: "2026-10-25T12:00:00Z", reasonCode: "clock_unverified", reviewStatus: "open" };
    const initial = [{ ...base, kioskId: "a:b", kioskName: "Retired North", eventId: "c" }, { ...base, kioskId: "a", kioskName: "Retired South", eventId: "b:c" }, { ...base, kioskId: "a", kioskName: "Retired South", eventId: "third" }];
    let remaining = [...initial], failed = false;
    const bodies: unknown[] = [], offsets: string[] = [];
    const note = "Compared the event roster.\nNo attendance correction needed.";
    await page.route("**/admin/kiosks/scan-reviews?**", route => {
      const url = new URL(route.request().url()), kioskId = url.searchParams.get("kioskId"), reason = url.searchParams.get("reasonCode"), offset = Number(url.searchParams.get("offset"));
      offsets.push(String(offset));
      const matching = remaining.filter(row => (!kioskId || row.kioskId === kioskId) && (!reason || row.reasonCode === reason));
      return route.fulfill({ json: { records: matching.slice(offset, offset + 2), hasMore: matching.length > offset + 2, matchingCount: matching.length, selection: matching.map(({ kioskId, eventId }) => ({ kioskId, eventId })), filters: initial.map(({ kioskId, kioskName, reasonCode }) => ({ kioskId, kioskName, reasonCode })) } });
    });
    await page.route("**/admin/kiosks/scan-reviews/review", route => {
      const body = route.request().postDataJSON(); bodies.push(body);
      expect(body).toEqual({ records: initial.map(({ kioskId, eventId }) => ({ kioskId, eventId })), note });
      if (!failed) { failed = true; return route.fulfill({ status: 503, json: { error: "Dismissal temporarily unavailable. Your selection is safe to retry." } }); }
      remaining = remaining.filter(row => !initial.includes(row));
      return route.fulfill({ json: { reviewedCount: 2, alreadyReviewedCount: 1 } });
    });
    await page.goto("/kiosks");
    const panel = page.getByRole("region", { name: "Rejected scans", exact: true });
    await expect(panel).toContainText("3 matching scans");
    // These two identities used to collide when joined with a colon.
    const north = panel.getByRole("checkbox", { name: "Select scan c from Retired North" }), south = panel.getByRole("checkbox", { name: "Select scan b:c from Retired South" });
    await north.check(); await expect(south).not.toBeChecked();
    await panel.getByRole("combobox", { name: "Kiosk", exact: true }).selectOption("a");
    await expect(panel).toContainText("2 matching scans");
    await expect(panel.getByRole("form", { name: "Dismiss selected rejected scans" })).toHaveCount(0);
    await panel.getByRole("combobox", { name: "Rejection reason" }).selectOption("clock_unverified");
    await panel.getByRole("combobox", { name: "Kiosk", exact: true }).selectOption("");
    await expect(panel).toContainText("3 matching scans");
    await panel.getByRole("button", { name: "Next rejected scans" }).click();
    await expect(panel).toContainText("Select scan third");
    await panel.getByRole("button", { name: "Select all matching (3)", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Dismiss 3 scans", exact: true })).toBeDisabled();
    await panel.getByLabel("Shared review note", { exact: true }).fill(note);
    if (width === 390 && theme === "dark") await panel.screenshot({ path: testInfo.outputPath("bulk-dismissal-selection.png") });
    remaining.push({ ...base, kioskId: "a", kioskName: "Retired South", eventId: "arrived-after-confirmation" });
    await panel.getByRole("button", { name: "Dismiss 3 scans", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Dismissal temporarily unavailable");
    await expect(panel.getByLabel("Shared review note", { exact: true })).toHaveValue(note);
    await panel.getByRole("button", { name: "Dismiss 3 scans", exact: true }).click();
    await expect(panel).toContainText("2 scans dismissed. 1 was already reviewed; existing notes were preserved. Attendance was not changed.");
    await expect(panel).toContainText("Select scan arrived-after-confirmation");
    await expect(panel.getByRole("button", { name: "Previous rejected scans" })).toBeDisabled();
    expect(offsets.at(-1)).toBe("0"); expect(bodies).toHaveLength(2);
    await panel.getByRole("button", { name: "Select this page" }).focus();
    await expect(panel.getByRole("button", { name: "Select this page" })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test("bulk dismissal limits all-matching while allowing a selected page", async ({ page }) => {
  await useKioskContext(page);
  const record = { kioskId: "retired-a", kioskName: "Retired kiosk", eventId: "limited-event", memberId: "member-a", reasonCode: "clock_unverified", occurredAt: "2020-01-01T07:00:00Z", receivedAt: "2026-10-25T12:00:00Z", reviewStatus: "open" };
  let reviewed = false;
  await page.route("**/admin/kiosks/scan-reviews?**", route => route.fulfill({ json: { records: reviewed ? [] : [record], hasMore: true, matchingCount: reviewed ? 500 : 501, selection: null, filters: [] } }));
  await page.route("**/admin/kiosks/scan-reviews/review", route => {
    expect(route.request().postDataJSON()).toEqual({ records: [{ kioskId: "retired-a", eventId: "limited-event" }], note: "Reviewed selected page" });
    reviewed = true; return route.fulfill({ json: { reviewedCount: 1, alreadyReviewedCount: 0 } });
  });
  await page.goto("/kiosks");
  const panel = page.getByRole("region", { name: "Rejected scans", exact: true });
  await expect(panel.getByRole("button", { name: "Select all matching (501)", exact: true })).toBeDisabled();
  await expect(panel).toContainText("More than 500 scans match");
  await panel.getByRole("button", { name: "Select this page" }).click();
  await panel.getByLabel("Shared review note").fill("Reviewed selected page");
  await panel.getByRole("button", { name: "Dismiss 1 scan", exact: true }).click();
  await expect(panel).toContainText("1 scan dismissed");
});

import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
import { expectDashboardTypography } from "./dashboard-typography";
import { discovered } from "./release-discovery";
import { attendanceSnapshot, combinedSnapshot, outreachSnapshot } from "./module-fixtures";
import { carpoolComposed, carpoolSnapshot } from "./carpool-fixtures";
import { requireOutreachPlugin } from "./outreach-fixtures";
import { pairedViews } from "./paired-views";

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
  anomalyLateThresholdMinutes: 10,
  anomalyEarlyThresholdMinutes: 10,
};

const routes = [
  ["/settings/organization", "Organization"],
  ["/settings/configuration", "Meeting configuration"],
  ["/settings/access", "Dashboard access"],
  ["/settings/integrations", "Integrations"],
  ["/settings/data", "Data management"],
  ["/settings/guided-setup", "Attendance setup"],
  ["/settings/updates", "Updates"],
] as const;

// The settings toolbar mounts after the asynchronous session and module bootstrap. Checking the toggle before it
// mounts misses the collapsed narrow-width menu (same pattern as setDashboardTheme).
async function openSettingsNavigation(page: Page) { await expect(page.locator(".settings-toolbar")).toBeVisible(); const button = page.locator(".settings-navigation-toggle"); if (await button.isVisible() && await button.getAttribute("aria-expanded") !== "true") await button.click(); }

async function useSettingsContext(page: Page, role: "admin" | "operator" = "admin") {
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot() }));
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, installation: { authMode: "local" }, settings }) }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { id: `${role}-1`, role, debugMode: false } }) }));
  await page.route("**/admin/setup/progress", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map((step) => ({ step })) }) }));
  await page.route("**/integrations/capabilities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: false, configured: false } } }) }));
  await page.route("**/admin/branding", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings }) }));
  await page.route("**/admin/members", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: "avery@example.org", active: 1 }] }) }));
  await page.route("**/admin/users", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users: [{ id: "user-1", localUsername: "admin", role: "admin", active: 1, memberId: "member-1", memberExternalId: "A-101", memberFirstName: "Avery", memberLastName: "Stone", createdAt: new Date().toISOString() }] }) }));
  await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: true, saved: true, configured: true, state: "configured" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled", pendingOperations: 0, failedOperations: 0 }, { provider: "resend", enabled: true, saved: true, configured: false, state: "verification_required" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] }) }));
  await page.route("**/admin/integrations/discord/channel-manager", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, contestWindowHours: 24 }) }));
  await page.route("**/admin/integrations/discord/anomaly-reports", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, channelId: "" }) }));
  await page.route("**/admin/privacy", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ telemetryAccepted: false, notice: "Anonymous usage reporting is off. No report will be sent.", installationReference: "installation-reference-without-personal-data" }) }));
  await page.route("**/admin/update-info", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releaseVersion: "0.18.0", workflowUrl: "https://github.example.test/actions/workflows/deploy.yml" }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [{ id: "kiosk-1", name: "North entrance attendance station", active: 1, lastSeenAt: new Date().toISOString(), releaseVersion: "0.18.0" }] }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [] }) }));
  await page.route("**/admin/meeting-weight-categories", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [] }) }));
  await page.route("**/admin/releases/latest", (route) => route.fulfill({ json: discovered({ tag_name: "v0.19.0", html_url: "https://example.test/releases/v0.19.0" }) }));
}

for (const viewport of dashboardConformanceReferences.viewports) {
  test(`Discord channel manager stays usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
    await useSettingsContext(page);
    await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled" }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: true, saved: true, configured: true, state: "configured" }] }) }));
    await page.route("**/admin/integrations/discord/channel-manager", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: route.request().method() === "PATCH" ? route.request().postData() ?? "{}" : JSON.stringify({ enabled: true, contestWindowHours: 36 }) }));
    let anomalySettings: Record<string, unknown> | undefined;
    await page.route("**/admin/integrations/discord/anomaly-reports", async (route) => {
      if (route.request().method() === "PATCH") anomalySettings = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: route.request().method() === "PATCH" ? route.request().postData() ?? "{}" : JSON.stringify({ enabled: true, channelId: "323456789012345678" }) });
    });
    await page.goto("/settings/integrations");
    const card = page.locator(".integration-card").filter({ hasText: "Discord bot" });
    await card.getByText("Manage configuration", { exact: true }).click();
    const manager = card.locator(".discord-channel-manager");
    await expect(manager.getByRole("switch", { name: "Manage the configured attendance channel" })).toBeChecked();
    await expect(manager.getByLabel("Contest window (hours)")).toHaveValue("36");
    const blockRecontests = manager.getByRole("checkbox", { name: "Block re-contests after rejection" });
    await expect(blockRecontests).not.toBeChecked();
    await blockRecontests.focus(); await page.keyboard.press("Space");
    const savedManager = page.waitForRequest(request => request.url().endsWith("/admin/integrations/discord/channel-manager") && request.method() === "PATCH");
    await manager.getByRole("button", { name: "Save channel manager" }).click();
    expect((await savedManager).postDataJSON()).toMatchObject({ blockRecontestsAfterRejection: true });
    await expect(blockRecontests).toBeChecked();
    await expect(card.getByText("Discord channel manager settings saved.")).toBeVisible();
    const anomalyReports = card.locator(".discord-anomaly-reports");
    await expect(anomalyReports.getByRole("switch", { name: "Send private anomaly reports" })).toBeChecked();
    await expect(anomalyReports.getByLabel("Private report channel ID")).toHaveValue("323456789012345678");
    await anomalyReports.getByLabel("Private report channel ID").fill("423456789012345678");
    await anomalyReports.getByRole("button", { name: "Save anomaly reports" }).click();
    await expect(card.getByText("Private anomaly report settings saved.")).toBeVisible();
    expect(anomalySettings).toEqual({ enabled: true, channelId: "423456789012345678" });
    await expectResponsiveFit(page);
  });
}

test("Admin can save independent attendance anomaly limits", async ({ page }) => {
  await useSettingsContext(page);
  let saved: Record<string, unknown> | undefined;
  await page.route("**/admin/branding", async (route) => {
    if (route.request().method() === "PATCH") saved = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: route.request().method() === "PATCH" ? JSON.stringify({ ok: true }) : JSON.stringify({ settings }) });
  });
  await page.goto("/settings/configuration");
  await expect(page.getByLabel("Late-arrival limit (minutes)")).toHaveValue("10");
  await expect(page.getByLabel("Early-departure limit (minutes)")).toHaveValue("10");
  await page.getByLabel("Late-arrival limit (minutes)").fill("12");
  await page.getByLabel("Early-departure limit (minutes)").fill("18");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByText("Attendance configuration saved.", { exact: true })).toBeVisible();
  expect(saved?.anomalyLateThresholdMinutes).toBe(12);
  expect(saved?.anomalyEarlyThresholdMinutes).toBe(18);
});

test("Settings keeps navigation and user controls together and persists Debug mode", async ({ page }) => {
  await useSettingsContext(page);
  let preference: Record<string, unknown> | undefined;
  await page.route("**/auth/preferences", async (route) => { preference = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ json: preference }); });
  await page.goto("/settings/configuration");
  await openSettingsNavigation(page);
  const toolbar = page.locator(".settings-toolbar");
  const navigation = toolbar.getByRole("navigation", { name: "Settings categories" });
  await expect(navigation).toBeVisible();
  const containment = await Promise.all([toolbar, navigation].map((element) => element.evaluate((node) => { const style = getComputedStyle(node); return { border: style.borderTopWidth, background: style.backgroundColor }; })));
  expect(containment[0].border).not.toBe("0px");
  expect(containment[1].border).toBe("0px");
  expect(containment[1].background).toBe("rgba(0, 0, 0, 0)");
  const darkMode = toolbar.getByRole("switch", { name: "Light mode" });
  await expect(darkMode).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Sign out" })).toBeVisible();
  const debug = toolbar.getByRole("switch", { name: "Debug mode" });
  await expect(debug).toHaveAttribute("aria-checked", "false");
  await debug.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => preference).toEqual({ debugMode: true });
  await expect(debug).toHaveAttribute("aria-checked", "true");
  await expect(debug).toBeFocused();
  expect(await debug.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  const toggleAppearance = (toggle: typeof darkMode) => toggle.evaluate((element) => {
    const control = getComputedStyle(element);
    const track = getComputedStyle(element.querySelector<HTMLElement>(".theme-toggle-track")!);
    const thumb = getComputedStyle(element.querySelector<HTMLElement>(".theme-toggle-track > span")!);
    const bounds = element.getBoundingClientRect();
    const trackBounds = element.querySelector<HTMLElement>(".theme-toggle-track")!.getBoundingClientRect();
    return {
      control: [control.backgroundColor, control.color, control.borderColor, control.borderRadius],
      track: [track.backgroundColor, track.borderColor, track.borderRadius],
      thumb: [thumb.backgroundColor, thumb.borderRadius],
      bounds: [bounds.height, trackBounds.width, trackBounds.height],
    };
  });
  await darkMode.click(); await expect(darkMode).toBeChecked();
  await expect.poll(async () => JSON.stringify(await toggleAppearance(debug)) === JSON.stringify(await toggleAppearance(darkMode))).toBe(true);
  const description = page.locator(".info-tip-content").filter({ hasText: "Scans close this many minutes" });
  await expect(description).toBeHidden();
  await page.locator(".configuration-grid label").first().locator(".info-tip-glyph").hover();
  await expect(description).toBeVisible();
});

test("Settings uses one direct link per enabled module", async ({ page }) => {
  requireOutreachPlugin();
  await useSettingsContext(page);
  // Every module in this build is enabled: Attendance, official Outreach and, when its plugin is composed, Carpool.
  const snapshot = combinedSnapshot(attendanceSnapshot(), outreachSnapshot(), ...(carpoolComposed ? [carpoolSnapshot()] : []));
  await page.route("**/platform/modules", route => route.fulfill({ json: snapshot }));
  await page.goto("/settings/organization");
  const modules = page.getByRole("button", { name: "Modules", exact: true }); await openSettingsNavigation(page); await modules.click();
  const menu = page.getByRole("group", { name: "Module settings" });
  const attendance = menu.getByRole("link", { name: "Attendance", exact: true }); await expect(attendance).toHaveAttribute("href", "/settings/attendance");
  await expect(menu.getByRole("button")).toHaveCount(0);
  const outreach = menu.getByRole("link", { name: "Outreach", exact: true }); const carpool = menu.getByRole("link", { name: "Carpool", exact: true });
  await expect(outreach).toHaveAttribute("href", "/settings/outreach-setup"); if (carpoolComposed) await expect(carpool).toHaveAttribute("href", "/settings/carpool"); else await expect(carpool).toHaveCount(0);
  await attendance.focus(); await page.keyboard.press("Enter"); await expect(page).toHaveURL(/\/settings\/attendance$/);
  await expect(page.getByRole("navigation", { name: "Attendance settings sections" }).getByRole("link", { name: "Attendance rules" })).toHaveAttribute("aria-current", "page");
  await openSettingsNavigation(page); await modules.click();
  await expect(menu.getByRole("link", { name: "Kiosk Simulator" })).toHaveCount(0);
  await expect(menu.getByRole("link")).toHaveCount(carpoolComposed ? 4 : 3); await expect(outreach).toBeVisible(); if (carpoolComposed) await expect(carpool).toBeVisible();
  await page.keyboard.press("Escape"); await expect(modules).toBeFocused();
});

for (const width of [1280, 390]) test(`Modules disclosure dismisses without obscuring settings at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await useSettingsContext(page);
  await page.goto("/settings/configuration");
  await openSettingsNavigation(page);
  const modules = page.getByRole("button", { name: "Modules", exact: true });
  const menu = page.getByRole("group", { name: "Module settings" });
  await expect(modules).toHaveAttribute("aria-expanded", "false");
  await openSettingsNavigation(page); await modules.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(modules).toBeFocused();
  await openSettingsNavigation(page); await modules.click();
  await menu.getByRole("link", { name: "Attendance", exact: true }).click();
  await expect(menu).toBeHidden();
  await openSettingsNavigation(page); await modules.click();
  await page.locator(".settings-toolbar").getByRole("switch", { name: "Light mode", exact: true }).click();
  await expect(menu).toBeHidden();
  await openSettingsNavigation(page); await modules.click();
  await menu.getByRole("link", { name: "Attendance", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/attendance$/);
  await expect(menu).toBeHidden();
});

for (const { theme, width } of pairedViews) test(`Attendance sections preserve deep links and themed keyboard navigation at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(saved => localStorage.setItem("lancerlogin-theme", saved), theme);
  await useSettingsContext(page);
  await page.route("**/attendance/policy", route => route.fulfill({ json: { labels: [], rules: [], recentDays: 30 } }));
  await page.route("**/admin/integrations/discord/label-roles", route => route.fulfill({ json: { mappings: [], integrationAvailable: false } }));
  await page.goto("/settings/attendance");
  const picker = page.getByRole("combobox", { name: "Attendance section", exact: true });
  const sections = page.getByRole("navigation", { name: "Attendance settings sections" });
  if (width === 390) {
    await expect(sections).toBeHidden(); await picker.focus();
    await picker.selectOption("/settings/configuration"); await expect(picker).toHaveValue("/settings/configuration");
    expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } else {
    await expect(picker).toBeHidden(); const configuration = sections.getByRole("link", { name: "Meeting configuration", exact: true });
    await configuration.focus(); await page.keyboard.press("Enter"); await expect(configuration).toHaveAttribute("aria-current", "page");
    expect((await configuration.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page).toHaveURL(/\/settings\/configuration$/); await page.reload();
  if (width === 390) await picker.selectOption("/settings/fingerprint-recovery");
  else await sections.getByRole("link", { name: "Fingerprint recovery", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fingerprint recovery" })).toBeVisible();
  await page.goBack(); await expect(page).toHaveURL(/\/settings\/configuration$/);
  await page.goBack(); await expect(page).toHaveURL(/\/settings\/attendance$/);
  await expectResponsiveFit(page);
});

test("disabled modules and Operator-only sections retain their visibility rules", async ({ page }) => {
  await useSettingsContext(page);
  await page.goto("/settings/organization"); await openSettingsNavigation(page); await page.getByRole("button", { name: "Modules", exact: true }).click();
  const menu = page.getByRole("group", { name: "Module settings" });
  await expect(menu.getByRole("link", { name: "Outreach", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("link", { name: "Carpool", exact: true })).toHaveCount(0);
  await useSettingsContext(page, "operator"); await page.goto("/settings/attendance");
  const sections = page.getByRole("navigation", { name: "Attendance settings sections" });
  await expect(sections.getByRole("link")).toHaveText(["Attendance rules", "Labels"]);
  await expect(page.getByRole("link", { name: "Attendance setup", exact: true })).toHaveCount(0);
  await page.goto("/settings/configuration");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
});

test("information tips use hover and keyboard focus on desktop but toggle on touch", async ({ page, browser }) => {
  await useSettingsContext(page);
  await page.goto("/settings/configuration");
  const desktopTrigger = page.locator(".configuration-grid label").first().getByRole("button", { name: "More information" });
  const desktopTooltip = page.locator(".info-tip-content").filter({ hasText: "Scans close this many minutes" });
  await desktopTrigger.locator(".info-tip-glyph").hover();
  await expect(desktopTooltip).toBeVisible();
  await desktopTrigger.click();
  await page.mouse.move(0, 0);
  await expect(desktopTooltip).toBeHidden();
  await expect(desktopTrigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Tab");
  await desktopTrigger.focus();
  await expect(desktopTooltip).toBeVisible();
  await desktopTrigger.press("Enter");
  await expect(desktopTooltip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(desktopTooltip).toBeHidden();

  const origin = new URL(page.url()).origin;
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const touchPage = await touchContext.newPage();
    await useSettingsContext(touchPage);
    await touchPage.goto(`${origin}/settings/configuration`);
    const touchTrigger = touchPage.locator(".configuration-grid label").first().getByRole("button", { name: "More information" });
    const touchTooltip = touchPage.locator(".info-tip-content").filter({ hasText: "Scans close this many minutes" });
    await touchTrigger.tap();
    await expect(touchTooltip).toBeVisible();
    await expect(touchTrigger).toHaveAttribute("aria-expanded", "true");
    await touchTrigger.tap();
    await expect(touchTooltip).toBeHidden();
    await expect(touchTrigger).toHaveAttribute("aria-expanded", "false");
  } finally {
    await touchContext.close();
  }
});

test("information tips stay circular and inside the mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useSettingsContext(page);
  await page.goto("/settings/organization");
  const field = page.locator(".field-label-with-info").filter({ hasText: "Logo image" });
  const trigger = field.getByRole("button", { name: "More information" });
  const glyph = trigger.locator(".info-tip-glyph");
  const tooltip = page.getByRole("tooltip").filter({ hasText: "up to 128 KiB" });
  await expect(tooltip).toBeHidden();
  const triggerBounds = await trigger.boundingBox();
  expect(triggerBounds).not.toBeNull();
  await page.mouse.move(triggerBounds!.x + 2, triggerBounds!.y + 2);
  await expect(tooltip).toBeHidden();
  await glyph.hover();
  await expect(tooltip).toBeVisible();
  const geometry = await page.evaluate(() => {
    const tip = document.querySelector<HTMLElement>("[role='tooltip']");
    const icon = document.querySelector<HTMLElement>(".info-tip-glyph");
    const target = document.querySelector<HTMLElement>(".info-tip-button");
    if (!tip || !icon || !target) throw new Error("Information tip did not render");
    const tipBounds = tip.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    return {
      tipLeft: tipBounds.left,
      tipRight: tipBounds.right,
      viewportWidth: innerWidth,
      iconWidth: iconBounds.width,
      iconHeight: iconBounds.height,
      targetWidth: targetBounds.width,
      targetHeight: targetBounds.height,
    };
  });
  expect(geometry.tipLeft).toBeGreaterThanOrEqual(15);
  expect(geometry.tipRight).toBeLessThanOrEqual(geometry.viewportWidth - 15);
  expect(Math.abs(geometry.iconWidth - geometry.iconHeight)).toBeLessThan(0.5);
  expect(geometry.targetWidth).toBeGreaterThanOrEqual(44);
  expect(geometry.targetHeight).toBeGreaterThanOrEqual(44);
  await expect(glyph).toHaveCSS("border-radius", "50%");
});

for (const { viewport, theme } of pairedViews) {
test(`Admin can add, edit, reorder, retire, and restore meeting-weight categories at ${viewport.width}x${viewport.height} ${theme}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
  await useSettingsContext(page);
  await page.addInitScript(() => localStorage.setItem("lancerlogin-update-dismissed:0.19.0", "true"));
  let categories = [
    { id: "standard", name: "Standard", weight: 1, minimumDurationMinutes: 30, position: 0, active: true },
    { id: "extended", name: "Extended", weight: 2, minimumDurationMinutes: 120, position: 1, active: true },
  ];
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  await page.route(/\/admin\/meeting-weight-categories(?:\/[^/?]+)?$/, async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    if (method === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories }) });
    const body = request.postDataJSON() as Record<string, unknown>; requests.push({ path, method, body });
    if (method === "POST") categories = [...categories, { id: "major", name: String(body.name), weight: Number(body.weight), minimumDurationMinutes: body.minimumDurationMinutes as number | null, position: categories.filter((item) => item.active).length, active: true }];
    else if (path.endsWith("/order")) { const ids = body.orderedIds as string[]; categories = categories.map((item) => ({ ...item, position: ids.includes(item.id) ? ids.indexOf(item.id) : item.position })); }
    else { const id = decodeURIComponent(path.split("/").at(-1)!); categories = categories.map((item) => item.id === id ? { ...item, ...body } : item); }
    await route.fulfill({ status: method === "POST" ? 201 : 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/settings/attendance");
  const card = page.locator(".meeting-weight-settings");
  await card.locator(".meeting-weight-disclosure > summary").click();
  const add = card.locator(".meeting-weight-add");
  await add.getByLabel("Name").fill("Major event");
  await add.getByLabel("Weight").fill("3");
  await add.getByLabel(/Minimum duration/).fill("180");
  await add.getByRole("button", { name: "Add category" }).click();
  await expect(card.getByText("Weight category added.")).toBeVisible();

  const standard = card.locator('li:has(input[value="Standard"])');
  await standard.getByLabel("Weight").fill("1.5");
  await standard.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Standard saved. Existing meetings keep their saved weight.")).toBeVisible();
  await card.getByRole("button", { name: "Move Extended up" }).focus();
  await page.keyboard.press("Enter");
  await expect(card.getByText("Automatic rule priority updated.")).toBeVisible();
  await card.getByRole("button", { name: "Move Extended down" }).click();
  await expect(card.locator(".meeting-weight-list > li").first().getByLabel("Name")).toHaveValue("Standard");
  await card.getByRole("button", { name: "Move Standard down" }).click();
  await expect(card.locator(".meeting-weight-list > li").first().getByLabel("Name")).toHaveValue("Extended");
  await expect(card.getByRole("button", { name: "Move Extended up", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Move Major event down", exact: true })).toBeDisabled();
  await card.locator(".meeting-weight-disclosure > summary").click();
  await expect(card.getByText("Automatic rule priority updated.")).toBeVisible();
  await card.locator(".meeting-weight-disclosure > summary").click();
  await standard.getByRole("button", { name: "Retire" }).click();
  await expect(card.getByText("Standard retired. Existing meetings are unchanged.")).toBeVisible();
  await card.getByText("Retired categories (1)").click();
  await card.getByRole("button", { name: "Restore" }).click();
  await expect(card.getByText("Standard restored. Existing meetings are unchanged.")).toBeVisible();
  await expect(card.locator(".meeting-weight-disclosure > summary")).toContainText("3 active");
  await page.reload();
  await expect(card.locator(".meeting-weight-disclosure")).not.toHaveAttribute("open");
  await card.locator(".meeting-weight-disclosure > summary").click();
  await expect(card.locator(".meeting-weight-list > li").first().getByLabel("Name")).toHaveValue("Extended");
  await expect(card.locator('li:has(input[value="Standard"])').getByLabel("Weight")).toHaveValue("1.5");
  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "POST", body: { name: "Major event", weight: 3, minimumDurationMinutes: 180 } }),
    expect.objectContaining({ path: "/admin/meeting-weight-categories/order", method: "PATCH", body: { orderedIds: ["extended", "standard", "major"] } }),
    expect.objectContaining({ path: "/admin/meeting-weight-categories/standard", method: "PATCH", body: { active: false } }),
    expect.objectContaining({ path: "/admin/meeting-weight-categories/standard", method: "PATCH", body: { active: true } }),
  ]));
});
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

for (const { viewport, theme } of pairedViews) {
    test(`all Settings routes conform at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await useSettingsContext(page);
      for (const [path, heading] of routes) {
        await page.goto(path);
        await expect(page.locator("main h1")).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expectDashboardTypography(page);
        if (path === "/settings/organization") {
          const name = page.getByRole("textbox", { name: "Organization name", exact: true });
          await page.getByText("Organization name", { exact: true }).click();
          await expect(name).toBeFocused();
          await page.keyboard.press("Tab");
          await expect(page.getByRole("textbox", { name: "Subtitle (optional)", exact: true })).toBeFocused();
          await expect(page.locator(".settings-form > label").filter({ hasText: "Subtitle" }).locator("span span")).toHaveCSS("font-weight", "500");
          await page.screenshot({ path: test.info().outputPath("organization.png") });
          await test.info().attach("Organization typography", { path: test.info().outputPath("organization.png"), contentType: "image/png" });
        }
        await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
        await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
        await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
        if (["/settings/configuration", "/settings/guided-setup"].includes(path)) {
          await expect(page.locator(".settings-module-disclosure")).toHaveAttribute("data-active", "true");
          await openSettingsNavigation(page); await page.getByRole("button", { name: "Modules", exact: true }).click();
        }
        await openSettingsNavigation(page);
        await expect(page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: ["/settings/configuration", "/settings/guided-setup"].includes(path) ? "Attendance" : heading === "Dashboard access" ? "Access" : heading === "Data management" ? "Data" : heading })).toHaveAttribute("aria-current", "page");
        if (["/settings/configuration", "/settings/guided-setup"].includes(path)) await openSettingsNavigation(page); await page.getByRole("button", { name: "Modules", exact: true }).click();
        const controls = page.locator("main button:visible, main a.primary-button:visible, main input:not([type='radio']):not([type='checkbox']):visible, main select:visible, main label:has(input[type='radio']:visible), main label:has(input[type='checkbox']:visible)");
        for (const height of await controls.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
        await expectResponsiveFit(page);
      }
    });
  }

for (const viewport of dashboardConformanceReferences.viewports) {
  test(`Google Calendar delivery status stays usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await useSettingsContext(page);
    await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: true, saved: true, authorized: true, configured: true, state: "configured", calendarName: "Operations calendar", pendingOperations: 2, failedOperations: 1, lastError: "Google Calendar is temporarily unavailable." }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: true, saved: true, configured: true, state: "configured", pendingOperations: 1, failedOperations: 0 }] }) }));
    await page.route("**/admin/integrations/google-calendar/retry", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ synced: 3, queued: 0, failed: 0 }) }));
    await page.route("**/admin/integrations/google-calendar/sync-all", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ selected: 4, synced: 4, queued: 0, failed: 0 }) }));
    let discordSyncPage = 0;
    await page.route("**/admin/integrations/discord/calendar/sync-all**", (route) => {
      const pages = [
        { selected: 2, synced: 2, queued: 0, skipped: 0, failed: 0, nextCursor: "page-2", limit: 100 },
        { selected: 2, synced: 1, queued: 1, skipped: 0, failed: 0, nextCursor: "page-3", limit: 100 },
        { selected: 1, synced: 1, queued: 0, skipped: 0, failed: 0, nextCursor: null, limit: 100 },
      ];
      const expectedCursor = discordSyncPage === 0 ? null : `page-${discordSyncPage + 1}`;
      expect(new URL(route.request().url()).searchParams.get("after")).toBe(expectedCursor);
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pages[discordSyncPage++]) });
    });
    await page.goto("/settings/integrations");
    const card = page.locator(".integration-card").filter({ hasText: "Google Calendar" });
    await card.getByText("Manage configuration", { exact: true }).click();
    await expect(card.getByText("Selected calendar:")).toBeVisible();
    await expect(card.getByText("Operations calendar", { exact: true })).toBeVisible();
    await expect(card.getByText("2 waiting · 1 need another attempt", { exact: true })).toBeVisible();
    const retry = card.getByRole("button", { name: "Retry failed delivery" });
    await retry.focus();
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(card.getByText("3 Calendar events sent.")).toBeVisible();
    await card.getByRole("button", { name: "Sync all meetings" }).click();
    await expect(card.getByText(/Google Calendar: 4 updated/)).toBeVisible();
    const discordCard = page.locator(".integration-card").filter({ hasText: "Discord bot" });
    await discordCard.getByText("Manage configuration", { exact: true }).click();
    await expect(discordCard.getByText("1 waiting · 0 need another attempt", { exact: true })).toBeVisible();
    await discordCard.getByRole("button", { name: "Sync all meetings" }).click();
    await expect(discordCard.getByText(/Discord: 4 updated, 1 queued.*5 active meetings checked/)).toBeVisible();
    expect(discordSyncPage).toBe(3);
    await expectResponsiveFit(page);
  });
}

test("Discord sync-all stops requesting later pages when a provider failure leaves queued work", async ({ page }) => {
  await useSettingsContext(page);
  await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: true, saved: true, configured: true, state: "configured", pendingOperations: 0, failedOperations: 1 }] }) }));
  let requests = 0;
  await page.route("**/admin/integrations/discord/calendar/sync-all**", (route) => {
    requests += 1;
    const body = requests === 1
      ? { selected: 10, synced: 10, queued: 0, skipped: 0, failed: 0, nextCursor: "page-2", limit: 100 }
      : { selected: 10, synced: 1, queued: 8, skipped: 0, failed: 1, nextCursor: "page-3", limit: 100 };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/settings/integrations");
  const card = page.locator(".integration-card").filter({ hasText: "Discord bot" });
  await card.getByText("Manage configuration", { exact: true }).click();
  await card.getByRole("button", { name: "Sync all meetings" }).click();
  await expect(card.getByRole("alert")).toContainText("Discord: 11 updated, 8 queued, 1 need attention. 20 active meetings checked.");
  expect(requests).toBe(2);
});

test("Settings validation, integration states and data dialogs remain explicit and keyboard focused", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => { localStorage.setItem("lancerlogin-theme", "dark"); localStorage.setItem("lancerlogin-update-dismissed:0.19.0", "true"); });
  await useSettingsContext(page);

  await page.goto("/settings/access");
  await page.getByText("Grant dashboard access", { exact: true }).click();
  await page.getByLabel("Temporary password", { exact: true }).fill("long-enough-password");
  const confirmation = page.getByLabel("Confirm temporary password", { exact: true });
  await confirmation.fill("different-password");
  await expect(confirmation).toHaveAttribute("aria-invalid", "true");
  await expect(confirmation).toHaveAttribute("aria-describedby", "password-confirmation-error");

  await page.goto("/settings/integrations");
  await expect(page.getByText("Configured", { exact: true })).toHaveAttribute("data-tone", "success");
  await expect(page.getByText("Verification required", { exact: true })).toHaveAttribute("data-tone", "warning");
  await expect(page.getByText("Disabled", { exact: true }).first()).toHaveAttribute("data-tone", "neutral");
  const resend = page.locator(".integration-card").filter({ hasText: "Resend email" });
  const replaceResend = resend.getByRole("button", { name: "Replace credentials", exact: true });
  if (!await replaceResend.isVisible() && !await resend.getByLabel("Sending API key").isVisible()) await resend.locator(".integration-details > summary").click();
  if (await replaceResend.isVisible()) await replaceResend.click();
  await expect(resend.getByLabel("Sending API key")).toBeVisible();

  await page.goto("/settings/privacy");
  await expect(page).toHaveURL(/\/settings\/data$/);
  await expect(page.getByRole("heading", { level: 1, name: "Data management" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Allow anonymous usage reporting" })).toHaveCount(0);

  await page.goto("/settings/data");
  await page.locator(".data-category").last().getByText("Restore or delete data", { exact: true }).click();
  const opener = page.getByRole("button", { name: "Delete installation data", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Delete Entire installation" });
  await expect(dialog).toHaveAttribute("aria-describedby", "data-action-description");
  await expect(dialog.getByRole("button", { name: "Close data action dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expectResponsiveFit(page);
});

for (const { viewport, theme } of pairedViews) {
    test(`Google integration guidance fits at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => {
        localStorage.setItem("lancerlogin-theme", savedTheme);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
      }, theme);
      await useSettingsContext(page);
      await page.goto("/settings/integrations");

      await page.getByText("Manage configuration", { exact: true }).click();
      const googleCard = page.locator(".integration-card").filter({ hasText: "Google OAuth" });
      await googleCard.getByRole("button", { name: "Replace credentials", exact: true }).click();
      const guideLink = googleCard.getByRole("link", { name: /Open the complete Google OAuth guide/ });
      await expect(guideLink).toHaveAttribute("href", "https://isriah.github.io/LancerLogin/setup.html#google-oauth");
      await guideLink.focus();
      await expect(guideLink).toBeFocused();
      expect((await guideLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await expect(googleCard.locator(".copy-value code")).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/auth\/google\/callback$/);
      const copyCallback = googleCard.getByRole("button", { name: "Copy" });
      await copyCallback.focus();
      await expect(copyCallback).toBeFocused();
      expect((await copyCallback.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await copyCallback.click();
      await expect(googleCard.getByRole("button", { name: "Copied" })).toBeVisible();
      await expectResponsiveFit(page);
    });
  }

for (const { viewport, theme } of pairedViews) {
    test(`managed Discord command setup is keyboard usable at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => {
        localStorage.setItem("lancerlogin-theme", savedTheme);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
      }, theme);
      await useSettingsContext(page);
      await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled" }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: true, saved: true, configured: false, state: "verification_required" }] }) }));
      await page.route("**/admin/integrations/discord/verify/start", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Discord denied command management. Confirm the saved application ID belongs to this bot and install the bot in the selected server before trying verification again." }) }));
      await page.goto("/settings/integrations");

      const card = page.locator(".integration-card").filter({ hasText: "Discord bot" });
      await card.getByRole("button", { name: "Replace credentials", exact: true }).click();
      await expect(card.getByLabel("Application ID")).toBeVisible();
      await expect(card.getByText(/creates or updates only the guild-scoped/)).toBeVisible();
      await expect(card.locator(".copy-value code")).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/api\/discord\/interactions$/);
      const copyEndpoint = card.getByRole("button", { name: "Copy" });
      await copyEndpoint.focus(); await expect(copyEndpoint).toBeFocused(); expect((await copyEndpoint.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const verify = card.getByRole("button", { name: "Send Discord verification" });
      await verify.focus(); await expect(verify).toBeFocused(); expect((await verify.boundingBox())!.height).toBeGreaterThanOrEqual(44); await page.keyboard.press("Enter");
      const failure = card.getByRole("alert"); await expect(failure).toContainText("Discord denied command management"); await expect(failure).toBeFocused();
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
      await expectResponsiveFit(page);
    });
  }

test("Discord shows the Interactions Endpoint URL only after credentials are saved", async ({ page }) => {
    await useSettingsContext(page);
    await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled" }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: true, saved: false, configured: false, state: "not_configured" }] }) }));
    await page.goto("/settings/integrations");

    const card = page.locator(".integration-card").filter({ hasText: "Discord bot" });
    await expect(card.getByLabel("Bot token")).toBeVisible();
    await expect(card.getByText(/Create Public Threads/)).toBeVisible();
    await expect(card.getByText(/before you add the Interactions Endpoint URL in Discord/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Save credentials" })).toBeVisible();
    await expect(card.locator(".copy-value")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Send Discord verification" })).toHaveCount(0);
  });

for (const { viewport, theme } of pairedViews) {
    test(`configured Discord command repair is accessible at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await useSettingsContext(page);
      await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled" }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: true, saved: true, configured: true, state: "configured", pendingOperations: 0, failedOperations: 0 }] }) }));
      let attempts = 0;
      await page.route("**/admin/integrations/discord/commands/reconcile", (route) => {
        attempts += 1;
        return attempts === 1
          ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider: "discord", reconciled: true, commands: ["pair", "attendance-report", "label"] }) })
          : route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Discord denied command management. Confirm the bot permissions and try command reconciliation again." }) });
      });
      await page.goto("/settings/integrations");

      const card = page.locator(".integration-card").filter({ hasText: "Discord bot" });
      await card.getByText("Manage configuration", { exact: true }).click();
      await expect(card.getByRole("heading", { level: 3, name: "Discord commands" })).toBeVisible();
      await expect(card.getByText(/without changing verification or saved credentials/)).toBeVisible();
      const reconcile = card.getByRole("button", { name: "Reconcile Discord commands" });
      await reconcile.focus(); await expect(reconcile).toBeFocused(); expect((await reconcile.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Enter");
      await expect(card.getByRole("status").filter({ hasText: "Discord commands were reconciled" })).toContainText("Core and Outreach commands are ready in the configured server");
      await expect(reconcile).toBeEnabled();
      await reconcile.click();
      const failure = card.getByRole("alert"); await expect(failure).toContainText("Discord denied command management"); await expect(failure).toBeFocused();
      expect(attempts).toBe(2);
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
      await expectResponsiveFit(page);
    });
  }

test("pending Discord commands are checked once when Integrations opens and settle to ready", async ({ page }) => {
  await useSettingsContext(page);
  const integrations = (commandStatus?: "pending" | "ready") => JSON.stringify({ integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled" }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: true, saved: true, configured: true, state: "configured", pendingOperations: 0, failedOperations: 0, ...(commandStatus ? { commandStatus } : {}) }] });
  await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: integrations("pending") }));
  let checks = 0; let releaseCheck = () => {}; const checkHeld = new Promise<void>((resolve) => { releaseCheck = resolve; });
  await page.route("**/admin/integrations/discord/commands/check", async (route) => { checks += 1; await checkHeld; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commandStatus: "ready", commandsUpdatedAt: "2026-10-29T15:00:00Z" }) }); });
  await page.goto("/settings/integrations");
  const card = page.locator(".integration-card").filter({ hasText: "Discord bot" });
  await card.getByText("Manage configuration", { exact: true }).click();
  await expect(card.getByRole("status").filter({ hasText: "Command setup is pending. Checking the Discord commands now." })).toBeVisible();
  releaseCheck();
  await expect(card.getByRole("status").filter({ hasText: /^Commands current as of / })).toBeVisible();
  await expect(card.getByText(/Command setup is pending/)).toHaveCount(0);
  expect(checks).toBe(1);

  // A status that is not pending never triggers the check, so ready commands are not reconciled again on each visit.
  await page.unroute("**/admin/integrations");
  await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: integrations("ready") }));
  await page.reload();
  await expect(page.locator(".integration-card").filter({ hasText: "Discord bot" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(checks).toBe(1);
});

test("Operator role cannot open administrative Settings routes", async ({ page }) => {
  await useSettingsContext(page, "operator");
  for (const [path] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Page unavailable" })).toBeVisible();
    const settingsNav = page.getByRole("navigation", { name: "Settings categories" });
    await expect(settingsNav.getByRole("link", { name: "Session" })).toBeVisible();
    await expect(settingsNav.getByRole("link", { name: "Attendance" })).toBeVisible();
    await expect(settingsNav.getByRole("link")).toHaveCount(2);
  }
});

test("mobile Settings navigation collapses with keyboard access to every category and session control", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  await page.goto("/settings/organization");
  const toggle = page.getByRole("button", { name: "Settings · Organization" });
  const nav = page.getByRole("navigation", { name: "Settings categories" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false"); await expect(nav).toBeHidden();
  await toggle.focus(); await page.keyboard.press("Enter"); await expect(nav).toBeVisible();
  for (const name of ["Organization", "Access", "Integrations", "Data", "Updates"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.locator(".settings-session-actions").getByRole("switch", { name: "Light mode" })).toBeVisible();
  await expect(page.locator(".settings-session-actions").getByRole("switch", { name: "Debug mode" })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(nav).toBeHidden(); await expect(toggle).toBeFocused();
  await toggle.click(); await nav.getByRole("link", { name: "Access", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/access$/); await expect(nav).toBeHidden();
  await expectResponsiveFit(page);
});

test("mobile access disclosures preserve account updates and password validation without writes on open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  const writes: unknown[] = [];
  await page.route("**/admin/users/user-1", route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.goto("/settings/access");
  const role = page.getByRole("combobox", { name: "Role for admin", exact: true });
  await expect(role).toBeHidden();
  const edit = page.getByRole("button", { name: "Edit Avery Stone access" });
  await edit.focus(); await page.keyboard.press("Enter"); await expect(role).toBeVisible(); expect(writes).toEqual([]);
  await role.selectOption("operator"); await expect.poll(() => writes).toEqual([{ role: "operator" }]);
  await edit.click(); await expect(role).toBeHidden();
  await page.getByText("Grant dashboard access", { exact: true }).click();
  await page.getByLabel("Temporary password", { exact: true }).fill("long-enough-password");
  await page.getByLabel("Confirm temporary password", { exact: true }).fill("different-password");
  await expect(page.locator("#password-confirmation-error")).toContainText("Passwords do not match");
  await expectResponsiveFit(page);
});

test("Data disclosures retain category-specific destructive confirmation and focus return", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  let writes = 0;
  await page.route("**/admin/data", route => { writes++; return route.fulfill({ json: {} }); });
  await page.goto("/settings/data");
  const roster = page.locator(".data-category").filter({ has: page.getByRole("heading", { name: "Roster", exact: true }) });
  const remove = roster.getByRole("button", { name: "Delete roster data", exact: true });
  await expect(remove).toBeHidden(); await roster.getByText("Restore or delete data", { exact: true }).click();
  await remove.click(); const dialog = page.getByRole("dialog", { name: "Delete Roster", exact: true });
  const submit = dialog.getByRole("button", { name: "Delete roster", exact: true });
  await expect(submit).toBeDisabled(); await dialog.getByRole("textbox").fill("DELETE ATTENDANCE"); await expect(submit).toBeDisabled();
  await dialog.getByRole("textbox").fill("DELETE ROSTER"); await expect(submit).toBeEnabled(); expect(writes).toBe(0);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(remove).toBeFocused();
});

test("module switches retain draft save and disable review", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  const writes: unknown[] = [];
  await page.route("**/admin/modules", route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.goto("/settings/modules");
  const attendance = page.getByRole("switch", { name: /^Attendance/ });
  await expect(attendance).toBeChecked(); await attendance.uncheck(); expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Review module disable", exact: true }).click();
  await expect(page.getByRole("region", { name: "Confirm module disable" })).toBeFocused();
  expect(writes).toEqual([]); await page.getByRole("button", { name: "Cancel", exact: true }).click(); expect(writes).toEqual([]);
});

test("module draft and disable review survive background refreshes until confirmed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  let reads = 0; const writes: { enabled: string[]; revision: number; confirmDisable: { moduleId: string }[] }[] = [];
  await page.route("**/platform/modules", route => { reads += 1; return route.fulfill({ json: attendanceSnapshot({ revision: 4 }) }); });
  await page.route("**/admin/modules", route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.goto("/settings/modules");
  const attendance = page.getByRole("switch", { name: /^Attendance/ }); const review = page.getByRole("region", { name: "Confirm module disable" });
  await expect(attendance).toBeChecked(); await attendance.uncheck();
  await page.getByRole("button", { name: "Review module disable", exact: true }).click(); await expect(review).toBeFocused();
  for (const _ of [1, 2]) { const before = reads; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => reads).toBeGreaterThan(before); }
  await page.waitForTimeout(250);
  await expect(attendance).not.toBeChecked(); await expect(review).toBeVisible(); expect(writes).toEqual([]);
  await review.getByRole("button", { name: "Confirm disable", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ revision: 4, confirmDisable: [{ moduleId: "attendance" }] }); expect(writes[0].enabled).not.toContain("attendance");
});

test("module draft resets with a notice when the server configuration changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  let snapshot = attendanceSnapshot({ revision: 4 }); const writes: unknown[] = [];
  await page.route("**/platform/modules", route => route.fulfill({ json: snapshot }));
  await page.route("**/admin/modules", route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await page.goto("/settings/modules");
  const attendance = page.getByRole("switch", { name: /^Attendance/ });
  await expect(attendance).toBeChecked(); await attendance.uncheck();
  const choice = page.locator(".module-setting-choice").filter({ has: attendance });
  await expect(choice.getByText("Turns off when you save", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review module disable", exact: true }).click();
  snapshot = attendanceSnapshot({ revision: 5 }); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert").filter({ hasText: "Module settings changed elsewhere." })).toBeVisible();
  await expect(attendance).toBeChecked(); await expect(page.getByRole("region", { name: "Confirm module disable" })).toBeHidden(); expect(writes).toEqual([]);
});

test("module status follows the unsaved switch instead of the saved state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  await page.route("**/platform/modules", route => route.fulfill({ json: attendanceSnapshot({ enabled: false }) }));
  await page.goto("/settings/modules");
  const attendance = page.getByRole("switch", { name: /^Attendance/ });
  const choice = page.locator(".module-setting-choice").filter({ has: attendance });
  await expect(attendance).not.toBeChecked(); await expect(choice.getByText("Disabled", { exact: true })).toBeVisible();
  await attendance.check();
  await expect(choice.getByText("Turns on when you save", { exact: true })).toBeVisible();
  await expect(choice.getByText("Disabled", { exact: true })).toHaveCount(0);
});

test("scheduler job disclosures retain complete timestamps and provider-delivery distinction", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  await page.route("**/admin/preferences", route => route.fulfill({ json: { developerSchedulerEnabled: true, revision: 1 } }));
  const jobs = Object.fromEntries(["core.discord-commands", "attendance.google-calendar", "attendance.discord-calendar", "attendance.discord-channel", "attendance.discord-notices", "attendance.discord-anomalies", "attendance.discord-label-roles", "hour-tracking.publication"].map(id => [id, { next: 1_797_600_000_000, last: 1_797_599_000_000, outcome: "ok" }]));
  await page.route("**/admin/scheduler", route => route.fulfill({ json: { enabled: true, jobs } }));
  await page.goto("/settings/background-scheduler");
  await expect(page.getByText("Last loaded scheduler state:")).toContainText("Running");
  await expect(page.getByText(/Job outcomes describe one pass, not delivery to a provider/)).toBeVisible();
  const job = page.locator(".scheduler-job").first(); await expect(job.getByText("Last attempt", { exact: true })).toBeHidden();
  await job.locator("summary").click(); await expect(job.getByText("Last attempt", { exact: true })).toBeVisible();
  await expect(job.locator("dd")).toHaveCount(2); await expectResponsiveFit(page);
});

for (const theme of ["light", "dark"] as const) test(`Settings keeps approved compact pages within 320px in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
  await useSettingsContext(page);
  await page.route("**/attendance/policy", route => route.fulfill({ json: { labels: [], rules: [], recentDays: 30 } }));
  await page.route("**/admin/integrations/discord/label-roles", route => route.fulfill({ json: { mappings: [], integrationAvailable: false } }));
  await page.route("**/admin/kiosks/fingerprint-reset", route => route.fulfill({ json: { resetCommands: [] } }));
  for (const [path] of [...routes, ["/settings/modules"], ["/settings/attendance"], ["/settings/fingerprint-recovery"]]) {
    await page.goto(path); await expect(page.locator("main h1")).toBeVisible();
    await expectResponsiveFit(page);
    if (path === "/settings/modules") {
      const row = page.locator(".module-setting-choice").first();
      // Measure both boxes in one layout pass: content above the list can still settle, moving the whole row between
      // two separate boundingBox() round trips while the title and toggle stay aligned with each other.
      const [title, toggle] = await row.evaluate(element => [element.querySelector("strong")!, element.querySelector("[role=switch]")!].map(item => { const { y, height } = item.getBoundingClientRect(); return { y, height }; }));
      expect(Math.abs(title.y + title.height / 2 - toggle.y - toggle.height / 2)).toBeLessThan(2);
    }
    await page.screenshot({ path: test.info().outputPath(`${path.split("/").pop()}-${theme}-320.png`), fullPage: true });
  }
});

const unavailablePlugin = { id: "synthetic-retired", label: "Retired Synthetic Plugin", status: "missing", requiredBackupVersion: 3, installedBackupVersion: null, requiredContractVersion: 1, installedContractVersion: null, source: "https://example.test/plugins/synthetic-retired-with-a-long-repository-name.git", commit: "a".repeat(40), rows: 2 };
async function openInstallationRestore(page: Page) {
  await page.goto("/settings/data");
  const installation = page.locator(".data-category").filter({ has: page.getByRole("heading", { name: "Entire installation", exact: true }) });
  await installation.getByText("Restore or delete data", { exact: true }).click();
  await installation.getByRole("button", { name: "Restore file", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Restore Entire installation" });
  await dialog.locator("input[type='file']").setInputFiles({ name: "installation.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ product: "LancerLogin", schemaVersion: 42 })) });
  await dialog.getByRole("textbox").fill("RESTORE INSTALLATION");
  await dialog.getByRole("button", { name: "Validate and restore", exact: true }).click();
  return dialog;
}

for (const { viewport, theme } of pairedViews) {
  test(`installation restore names unavailable plugin modules and requires an explicit discard at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
    await useSettingsContext(page);
    const requests: { excludeModules?: string[] }[] = [];
    await page.route("**/admin/data/restore", (route) => {
      const body = route.request().postDataJSON() as { excludeModules?: string[] }; requests.push(body);
      return body.excludeModules
        ? route.fulfill({ json: { restored: true, scope: "installation", recovery: { revokedKiosks: 0, invalidatedPairingCodes: 0, pausedProviderOperations: 0 }, excludedModules: [{ id: unavailablePlugin.id, label: unavailablePlugin.label, status: "missing", backupVersion: 3, source: unavailablePlugin.source, commit: unavailablePlugin.commit, rows: 2 }] } })
        : route.fulfill({ status: 409, json: { error: "This backup contains module data this installation cannot restore. Install the listed modules and retry, or confirm a restore that discards their data.", code: "module-restore-refused", reason: "unavailable-modules", modules: [unavailablePlugin], dependencies: [], optOut: { available: true, excludeModules: [unavailablePlugin.id] }, details: [] } });
    });
    const dialog = await openInstallationRestore(page);
    const notice = dialog.getByRole("alert").filter({ hasText: "Retired Synthetic Plugin" });
    await expect(notice).toContainText("not installed"); await expect(notice).toContainText("holds 2 records"); await expect(notice).toContainText(unavailablePlugin.commit);
    await expect(dialog.getByRole("button", { name: "Validate and restore", exact: true })).toBeDisabled();
    const discard = dialog.getByRole("checkbox", { name: "Discard 2 records from this module and restore everything else" });
    await expect(discard).not.toBeChecked();
    const label = await dialog.locator(".module-restore-refusal .checkbox-field").boundingBox(); expect(label!.height).toBeGreaterThanOrEqual(44);
    const unchecked = await discard.evaluate((element) => { const style = getComputedStyle(element); return { appearance: style.appearance, width: style.width, height: style.height, radius: style.borderRadius, background: style.backgroundColor }; });
    expect(unchecked.appearance).toBe("none"); expect(parseFloat(unchecked.width)).toBeGreaterThanOrEqual(20); expect(unchecked.width).toBe(unchecked.height); expect(unchecked.radius).not.toBe("0px"); expect(unchecked.background).not.toBe("rgba(0, 0, 0, 0)");
    await expectResponsiveFit(page);
    await discard.focus(); await page.keyboard.press("Space"); await expect(discard).toBeChecked();
    const checked = await discard.evaluate((element) => { const probe = document.createElement("span"); probe.style.color = "var(--primary)"; element.parentElement!.append(probe); const primary = getComputedStyle(probe).color; probe.remove(); return { background: getComputedStyle(element).backgroundColor, primary }; });
    expect(checked.background).toBe(checked.primary);
    expect(requests.map((request) => request.excludeModules)).toEqual([undefined]);
    await dialog.getByRole("button", { name: "Restore without these modules", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Discarded Retired Synthetic Plugin (2 records)." })).toBeVisible();
    expect(requests.map((request) => request.excludeModules)).toEqual([undefined, [unavailablePlugin.id]]);
  });
}

test("installation restore offers no discard while an included module depends on an unavailable one", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await useSettingsContext(page);
  const requests: unknown[] = [];
  await page.route("**/admin/data/restore", (route) => { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 409, json: { error: "This backup contains module data that cannot be discarded because restored modules depend on it. Install the listed modules and retry.", code: "module-restore-refused", reason: "excluded-module-dependency", modules: [{ ...unavailablePlugin, status: "newer", installedBackupVersion: 2, source: null, commit: null }], dependencies: [{ moduleId: "synthetic-addon", label: "Synthetic Add-on", dependsOn: unavailablePlugin.id }], optOut: { available: false, excludeModules: [unavailablePlugin.id] }, details: [] } }); });
  const dialog = await openInstallationRestore(page);
  const notice = dialog.getByRole("alert").filter({ hasText: "Retired Synthetic Plugin" });
  await expect(notice).toContainText("installed version is older (module backup version 2)");
  await expect(notice).toContainText("Synthetic Add-on depends on Retired Synthetic Plugin");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Validate and restore", exact: true })).toBeDisabled();
  await dialog.locator("input[type='file']").setInputFiles({ name: "other.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await expect(notice).toHaveCount(0); await expect(dialog.getByRole("button", { name: "Validate and restore", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(1);
  await expectResponsiveFit(page);
});

test("Admin can add a Google email from Access and sees API errors inline", async ({ page }) => {
  await useSettingsContext(page);
  const writes: unknown[] = []; let fail = false;
  await page.route("**/admin/users/user-1", route => { writes.push(route.request().postDataJSON()); return fail ? route.fulfill({ status: 409, json: { error: "Another account already uses that Google email." } }) : route.fulfill({ json: {} }); });
  await page.goto("/settings/access");
  const edit = page.getByRole("button", { name: "Edit Avery Stone access" });
  await edit.focus(); await page.keyboard.press("Enter");
  const email = page.getByRole("textbox", { name: "Google email for Avery Stone", exact: true });
  await expect(email).toBeVisible(); await expect(email).toHaveValue(""); expect(writes).toEqual([]);
  await email.fill("test.student.a@example.test"); await email.press("Enter");
  await expect.poll(() => writes).toEqual([{ email: "test.student.a@example.test" }]);
  await expect(page.getByRole("status").filter({ hasText: "Google email saved and audited." })).toBeVisible();
  fail = true;
  await email.fill("test.student.b@example.test"); await page.getByRole("button", { name: "Save Google email", exact: true }).click();
  const failure = page.locator(".settings-account").getByRole("alert");
  await expect(failure).toHaveText("Another account already uses that Google email."); await expect(failure).toBeFocused();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await email.fill(""); await email.press("Enter");
  await expect.poll(() => writes.at(-1)).toEqual({ email: null });
  await expectResponsiveFit(page);
});

test("integration setup uses status URLs and guidance when the API provides them", async ({ page }) => {
  await useSettingsContext(page);
  await page.route("**/admin/integrations", (route) => route.fulfill({ json: { integrations: [{ provider: "google", enabled: true, saved: true, configured: false, state: "verification_required", redirectUri: "https://dev.example.test/api/auth/google/callback" }, { provider: "google_calendar", enabled: true, saved: false, authorized: false, configured: false, state: "not_configured", redirectUri: "https://dev.example.test/api/admin/integrations/google-calendar/callback" }, { provider: "resend", enabled: true, saved: false, configured: false, state: "not_configured" }, { provider: "discord", enabled: true, saved: true, configured: false, state: "verification_required", interactionsUrl: "https://dev.example.test/api/discord/interactions" }] } }));
  await page.goto("/settings/integrations");
  const google = page.locator(".integration-card").filter({ hasText: "Google OAuth" });
  await google.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(google.locator(".copy-value code")).toHaveText("https://dev.example.test/api/auth/google/callback");
  await expect(google.getByText(/add each staff Google account under/)).toBeVisible();
  await expect(google.locator(".verification-panel").getByText(/active Admin whose LancerLogin email matches/)).toBeVisible();
  for (const link of await google.getByRole("link", { name: "Settings > Access" }).all()) await expect(link).toHaveAttribute("href", "/settings/access");
  const calendar = page.locator(".integration-card").filter({ hasText: "Google Calendar" });
  await expect(calendar.locator(".copy-value code")).toHaveText("https://dev.example.test/api/admin/integrations/google-calendar/callback");
  await expect(calendar.getByRole("link", { name: /Google Auth Platform > Clients/ })).toHaveAttribute("href", "https://console.cloud.google.com/auth/clients");
  await expect(calendar.getByText(/Google ends the authorization after 7 days/)).toBeVisible();
  const resend = page.locator(".integration-card").filter({ hasText: "Resend email" });
  await resend.getByText("Setup instructions", { exact: true }).click();
  await expect(resend.getByText(/only delivers to your own Resend account address/)).toBeVisible();
  await expect(resend.locator(".guide-note").filter({ hasText: "with no display name" })).toBeVisible();
  const discord = page.locator(".integration-card").filter({ hasText: "Discord bot" });
  await expect(discord.locator(".copy-value code")).toHaveText("https://dev.example.test/api/discord/interactions");
  await discord.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(discord.getByText(/Create Public Threads, Create Events, Manage Events, and Manage Roles/)).toBeVisible();
  await expect(discord.getByText("Server Members Intent", { exact: true })).toBeVisible();
  await expect(discord.getByText(/Guild Members/)).toHaveCount(0);
  await expect(discord.getByText(/plus the private anomaly report channel if you use one/)).toBeVisible();
  await expectResponsiveFit(page);
});

test("integration credential fields opt out of sign-in autofill and password managers", async ({ page }) => {
  await useSettingsContext(page);
  await page.route("**/admin/integrations", (route) => route.fulfill({ json: { integrations: [{ provider: "google", enabled: true, saved: false, configured: false, state: "not_configured" }, { provider: "google_calendar", enabled: true, saved: false, authorized: false, configured: false, state: "not_configured" }, { provider: "resend", enabled: true, saved: true, configured: false, state: "verification_required" }, { provider: "discord", enabled: true, saved: false, configured: false, state: "not_configured" }] } }));
  await page.goto("/settings/integrations");
  const cards = page.locator(".integration-card");
  await cards.filter({ hasText: "Resend email" }).getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(cards.getByLabel("Calendar OAuth client ID", { exact: true })).toBeVisible();
  const passwords = cards.locator('input[type="password"]');
  await expect(passwords).toHaveCount(4);
  for (const input of await passwords.all()) {
    await expect(input).toHaveAttribute("autocomplete", "new-password");
    await expect(input).toHaveAttribute("data-1p-ignore", "");
    await expect(input).toHaveAttribute("data-lpignore", "true");
    await expect(input).toHaveAttribute("data-bwignore", "");
    await expect(input).toHaveAttribute("data-form-type", "other");
  }
  const fields = await cards.locator('input:not([type="checkbox"])').evaluateAll((inputs) => inputs.map((input) => ({ name: input.getAttribute("name") ?? "", id: input.id, type: input.getAttribute("type") ?? "text" })));
  expect(fields.length).toBeGreaterThan(10);
  for (const field of fields) {
    expect(field.name).toMatch(/^integration-/);
    expect(field.id).toBe(field.name);
    expect(field.name).not.toMatch(/^(username|password|email)$/i);
    expect(field.type).not.toBe("email");
  }
  expect(new Set(fields.map((field) => field.id)).size).toBe(fields.length);
  for (const label of ["OAuth client ID", "Calendar OAuth client ID", "From address", "Application ID", "Application public key", "Server ID", "Attendance channel ID", "Private report channel ID", "Address to receive the test code", "Six-digit code"]) {
    const input = cards.getByLabel(label, { exact: true });
    await expect(input).toHaveAttribute("type", "text");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveAttribute("data-1p-ignore", "");
  }
  for (const form of await cards.locator("form").all()) await expect(form).toHaveAttribute("autocomplete", "off");
  const from = cards.getByLabel("From address", { exact: true });
  await from.fill("Test Sender <attendance@example.test>");
  expect(await from.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await from.fill("attendance@example.test");
  expect(await from.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
});

for (const provider of ["google", "google_calendar"] as const) test(`integrationError for ${provider} shows its message on the card and leaves the URL`, async ({ page }) => {
  await useSettingsContext(page);
  await page.route("**/admin/integrations", (route) => route.fulfill({ json: { integrations: [{ provider: "google", enabled: true, saved: true, configured: false, state: "verification_required" }, { provider: "google_calendar", enabled: true, saved: true, authorized: false, configured: false, state: "verification_required" }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] } }));
  const text = provider === "google" ? "This Google account is not an active Admin." : "Google denied Calendar access.";
  await page.goto(`/settings/integrations?integrationError=${provider}&message=${encodeURIComponent(text)}&keep=1`);
  const card = page.locator(".integration-card").filter({ hasText: provider === "google" ? "Google OAuth" : "Google Calendar" });
  await expect(card.getByRole("alert")).toHaveText(text);
  await expect(page.getByRole("alert").filter({ hasText: text })).toHaveCount(1);
  await expect.poll(() => new URL(page.url()).search).toBe("?keep=1");
});

test("configured Google Calendar offers re-authorization and warns when it is required", async ({ page }) => {
  await useSettingsContext(page);
  let reauthorizationRequired = false;
  await page.route("**/admin/integrations", (route) => route.fulfill({ json: { integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: true, saved: true, authorized: true, configured: true, state: "configured", calendarName: "Test calendar", pendingOperations: 0, failedOperations: 0, reauthorizationRequired }, { provider: "resend", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] } }));
  await page.goto("/settings/integrations");
  const card = page.locator(".integration-card").filter({ hasText: "Google Calendar" });
  await card.getByText("Manage configuration", { exact: true }).click();
  const reauthorize = card.getByRole("link", { name: "Re-authorize Google Calendar", exact: true });
  await expect(reauthorize).toHaveAttribute("href", /\/admin\/integrations\/google-calendar\/authorize$/);
  expect((await reauthorize.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(card.getByText(/authorization needs renewing/)).toHaveCount(0);
  reauthorizationRequired = true; await page.reload();
  await card.getByText("Manage configuration", { exact: true }).click();
  await expect(card.getByRole("status").filter({ hasText: "Google Calendar authorization needs renewing." })).toHaveAttribute("data-tone", "warning");
  await expect(reauthorize).toHaveClass(/primary-button/);
  await expectResponsiveFit(page);
});

test("Edit roster member renders the Active roster member checkbox as a checkbox", async ({ page }) => {
  await useSettingsContext(page);
  await page.route("**/labels", (route) => route.fulfill({ json: { labels: [{ id: "label-test", name: "Test label", active: 1, formulaEnabled: 0 }], history: [], periods: [], today: "2026-10-29" } }));
  await page.goto("/roster");
  await page.getByRole("button", { name: "Edit Avery Stone", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Edit roster member" });
  const active = dialog.getByRole("checkbox", { name: "Active roster member" });
  await expect(active).toBeChecked();
  const box = await active.evaluate((element) => { const style = getComputedStyle(element); const bounds = element.getBoundingClientRect(); return { width: bounds.width, height: bounds.height, appearance: style.appearance, padding: style.paddingTop }; });
  expect(box.width).toBeLessThan(30); expect(box.width).toBeGreaterThanOrEqual(16); expect(Math.abs(box.width - box.height)).toBeLessThan(1); expect(box.padding).toBe("0px");
  const reference = await page.evaluate(() => { const probe = document.createElement("label"); probe.className = "checkbox-field"; const input = document.createElement("input"); input.type = "checkbox"; probe.append(input); document.querySelector(".app")!.append(probe); const style = getComputedStyle(input); const result = { appearance: style.appearance, radius: style.borderRadius }; probe.remove(); return result; });
  expect(box.appearance).toBe(reference.appearance);
  expect(await active.evaluate((element) => getComputedStyle(element).borderRadius)).toBe(reference.radius);
  await active.focus(); await page.keyboard.press("Space"); await expect(active).not.toBeChecked();
});

test("saved integration credentials show a saved date and open the form only to replace them", async ({ page }) => {
  await useSettingsContext(page);
  const writes: unknown[] = [];
  await page.route("**/admin/integrations", (route) => route.fulfill({ json: { integrations: [{ provider: "google", enabled: false, saved: false, configured: false, state: "disabled" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled" }, { provider: "resend", enabled: true, saved: true, configured: false, state: "verification_required", updatedAt: "2026-10-29T19:47:20.430Z" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] } }));
  await page.route("**/admin/integrations/resend", (route) => { writes.push(route.request().method()); return route.fulfill({ json: { created: false } }); });
  await page.goto("/settings/integrations");
  const resend = page.locator(".integration-card").filter({ hasText: "Resend email" });
  const saved = resend.locator(".saved-credentials");
  await expect(saved.getByRole("status")).toHaveText(/^Credentials saved on .*2026\.$/);
  await expect(resend.getByLabel("Sending API key")).toHaveCount(0);
  await expect(resend.locator("input[type=\"password\"]")).toHaveCount(0);
  const replace = saved.getByRole("button", { name: "Replace credentials", exact: true });
  expect((await replace.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await replace.click();
  await expect(resend.getByText(/replaces all of the saved credentials at once, and this integration must be verified again/)).toBeVisible();
  await resend.getByLabel("Sending API key").fill("re_test_value_for_cancel");
  await resend.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(saved.getByRole("status")).toBeVisible();
  await expect(resend.getByLabel("Sending API key")).toHaveCount(0);
  await replace.click();
  await expect(resend.getByLabel("Sending API key")).toHaveValue("");
  expect(writes).toEqual([]);
  await expectResponsiveFit(page);
});

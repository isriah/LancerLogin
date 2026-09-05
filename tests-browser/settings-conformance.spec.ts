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
  anomalyLateThresholdMinutes: 10,
  anomalyEarlyThresholdMinutes: 10,
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
  await page.route("**/admin/integrations", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [{ provider: "google", enabled: true, saved: true, configured: true, state: "configured" }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled", pendingOperations: 0, failedOperations: 0 }, { provider: "resend", enabled: true, saved: true, configured: false, state: "verification_required" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] }) }));
  await page.route("**/admin/integrations/discord/channel-manager", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, contestWindowHours: 24 }) }));
  await page.route("**/admin/integrations/discord/anomaly-reports", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, channelId: "" }) }));
  await page.route("**/admin/privacy", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ telemetryAccepted: false, notice: "Anonymous usage reporting is off. No report will be sent.", installationReference: "installation-reference-without-personal-data" }) }));
  await page.route("**/admin/update-info", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releaseVersion: "0.18.0", workflowUrl: "https://github.example.test/actions/workflows/deploy.yml" }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [{ id: "kiosk-1", name: "North entrance attendance station", active: 1, lastSeenAt: new Date().toISOString(), releaseVersion: "0.18.0" }] }) }));
  await page.route("**/admin/kiosks/kiosk-1/commands", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commands: [] }) }));
  await page.route("**/admin/meeting-weight-categories", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [] }) }));
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tag_name: "v0.19.0", html_url: "https://example.test/releases/v0.19.0" }) }));
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
    await manager.getByRole("button", { name: "Save channel manager" }).click();
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

test("Admin can add, edit, reorder, retire, and restore meeting-weight categories", async ({ page }) => {
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

  await page.goto("/settings/organization");
  const card = page.locator(".meeting-weight-settings");
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
  await card.getByRole("button", { name: "Move Extended up" }).click();
  await expect(card.getByText("Automatic rule priority updated.")).toBeVisible();
  await standard.getByRole("button", { name: "Retire" }).click();
  await expect(card.getByText("Standard retired. Existing meetings are unchanged.")).toBeVisible();
  await card.getByText("Retired categories (1)").click();
  await card.getByRole("button", { name: "Restore" }).click();
  await expect(card.getByText("Standard restored. Existing meetings are unchanged.")).toBeVisible();
  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "POST", body: { name: "Major event", weight: 3, minimumDurationMinutes: 180 } }),
    expect.objectContaining({ path: "/admin/meeting-weight-categories/order", method: "PATCH", body: { orderedIds: ["extended", "standard", "major"] } }),
    expect.objectContaining({ path: "/admin/meeting-weight-categories/standard", method: "PATCH", body: { active: false } }),
    expect.objectContaining({ path: "/admin/meeting-weight-categories/standard", method: "PATCH", body: { active: true } }),
  ]));
});

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
  await expect(page.getByText("Disabled", { exact: true }).first()).toHaveAttribute("data-tone", "neutral");
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

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
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
}

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
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
}

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
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
          ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ provider: "discord", reconciled: true, commands: ["pair", "attendance-report"] }) })
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
      await expect(card.getByRole("status")).toContainText("/pair and /attendance-report are ready");
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
}

test("Operator role cannot open any Settings route", async ({ page }) => {
  await useSettingsContext(page, "operator");
  for (const [path] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Page unavailable" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Settings categories" })).toHaveCount(0);
  }
});

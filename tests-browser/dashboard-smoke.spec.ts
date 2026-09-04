import { expect, test } from "@playwright/test";

test("roster stays primary and Admin actions open focused dialogs", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Roster" }).click();
  await expect(page.getByRole("heading", { name: "Roster", exact: true })).toBeVisible();
  await expect(page.getByText("Active roster")).toBeVisible();
  await expect(page.getByRole("table", { name: "Roster members" })).toContainText("Avery Stone");

  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog", { name: "Add roster member" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Import CSV instead" }).click();
  await expect(dialog.getByRole("heading", { name: "Import roster" })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to one member" }).click();
  await page.getByRole("button", { name: "Close add member dialog" }).click();
});

test("roster columns stay vertically centered with actions at the desktop right edge", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.route("**/admin/members", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      discordConfigured: true,
      members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: "avery@example.org", discordUserId: "123456789012", attendanceRequiredFrom: "2026-01-01", active: 1 }],
    }),
  }));
  await page.goto("/roster");

  const header = page.locator(".roster-row.header");
  const row = page.locator(".roster-row:not(.header)").first();
  const cells = row.locator(":scope > *");
  await expect(cells).toHaveCount(4);
  await expect(row.getByRole("button", { name: "Edit" })).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  const rowGeometry = await row.evaluate((element) => {
    const rowBounds = element.getBoundingClientRect();
    return {
      centerY: rowBounds.y + rowBounds.height / 2,
      cells: Array.from(element.children).map((cell) => {
        const bounds = cell.getBoundingClientRect();
        return { x: bounds.x, right: bounds.right, centerY: bounds.y + bounds.height / 2 };
      }),
    };
  });
  const headerCenters = await header.locator(":scope > *").evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.y + bounds.height / 2;
  }));
  for (const cell of rowGeometry.cells) expect(Math.abs(cell.centerY - rowGeometry.centerY)).toBeLessThanOrEqual(1);
  for (const center of headerCenters) expect(Math.abs(center - headerCenters[0])).toBeLessThanOrEqual(1);
  expect(rowGeometry.cells[3].x).toBeGreaterThan(rowGeometry.cells[2].right);
});

test("member links share route state across Roster, Reports, direct loads, and browser history", async ({ page }) => {
  await page.goto("/roster");
  await page.getByRole("link", { name: "Avery Stone" }).click();
  await expect(page).toHaveURL(/\/roster\/A-101$/);
  await expect(page.getByRole("heading", { name: "Avery Stone" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/roster$/);
  await expect(page.getByRole("heading", { name: "Roster", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Avery Stone" })).toBeVisible();

  await page.goto("/reports");
  await page.getByRole("link", { name: /Avery Stone/ }).click();
  await expect(page).toHaveURL(/\/roster\/A-101$/);
  await expect(page.getByRole("heading", { name: "Avery Stone" })).toBeVisible();

  await page.goto("/roster/A-102");
  await expect(page.getByRole("heading", { name: "Morgan Diaz" })).toBeVisible();
});

test("member detail shows Discord identity only while the integration is enabled", async ({ page }) => {
  await page.goto("/roster/A-101");
  await expect(page.getByText("Discord identity", { exact: true })).toBeVisible();
  await expect(page.getByText("123456789012", { exact: true })).toBeVisible();

  await page.goto("/roster/A-102");
  await expect(page.getByText("Discord identity", { exact: true })).toBeVisible();
  await expect(page.getByText("Not linked", { exact: true })).toBeVisible();

  await page.route("**/integrations/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: false, configured: true } } }),
  }));
  await page.goto("/roster/A-101");
  await expect(page.getByRole("heading", { name: "Avery Stone" })).toBeVisible();
  await expect(page.getByText("Discord identity", { exact: true })).toHaveCount(0);
  await expect(page.getByText("123456789012", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Not linked", { exact: true })).toHaveCount(0);
});

test("Operator can view member Discord identity without Admin member controls", async ({ page }) => {
  await page.route("**/auth/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: { role: "operator" } }),
  }));
  await page.goto("/roster/A-101");
  await expect(page.getByText("Discord identity", { exact: true })).toBeVisible();
  await expect(page.getByText("123456789012", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("branding controls and dark surfaces are themed", async ({ page }) => {
  await page.goto("/settings/organization");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Organization" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Logo contrast background" })).toBeVisible();
  await page.getByText("Primary color", { exact: true }).click();
  await expect(page.getByLabel("Hex").first()).toHaveValue("#8b2f72");
  const background = await page.locator(".app").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).toBe("rgb(17, 19, 21)");
});

test("theme switch supports keyboard, pointer, and saved state", async ({ page }) => {
  await page.goto("/dashboard");
  const toggle = page.getByRole("switch", { name: "Dark mode" });
  await expect(toggle).toBeChecked();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");

  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  await expect(toggle.locator(".theme-toggle-label")).toHaveText("Light");
  await page.reload();
  await expect(page.getByRole("switch", { name: "Dark mode" })).not.toBeChecked();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");

  await page.getByRole("switch", { name: "Dark mode" }).click();
  await expect(page.getByRole("switch", { name: "Dark mode" })).toBeChecked();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByRole("switch", { name: "Dark mode" })).toBeChecked();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
});

test("half-width dashboard does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/roster");
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

test("integration enablement is accessible, sorted, and compact when disabled", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/settings/integrations");
  const cards = page.locator(".integration-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("Google OAuth");
  await expect(cards.nth(1)).toContainText("Resend email");
  await expect(cards.nth(2)).toContainText("Discord bot");
  await expect(page.getByRole("switch", { name: "Enable Discord bot" })).not.toBeChecked();
  await expect(cards.nth(2).locator(".integration-details")).toHaveCount(0);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
});

test("contest notifier opens an accessible review popup with context and refreshes after resolution", async ({ page }) => {
  let contests = [{ meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 3, hasPartialScan: true, rawScanStatus: "partial" }];
  let failNextResolution = false;
  await page.route(/\/discord\/contests(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contests }) }));
  await page.route(/\/discord\/contests\/resolve$/, async (route) => {
    const body = route.request().postDataJSON() as { reviewNote?: string };
    if (!body.reviewNote?.trim()) { await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "A review reason is required before resolving this contest" }) }); return; }
    if (failNextResolution) { failNextResolution = false; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Review service unavailable" }) }); return; }
    contests = [];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ resolved: true, attendanceChanged: true }) });
  });
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await expect(page.getByLabel("Meeting type")).toBeVisible();
  await expect(page.getByLabel("Roster")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contests awaiting review" })).toBeHidden();
  const indicator = page.getByRole("button", { name: "1 attendance contest awaiting review. Open contest review." });
  await indicator.click();
  const dialog = page.getByRole("dialog", { name: "Contests awaiting review" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Jordan Lee")).toBeVisible();
  await expect(dialog.getByText("A-103")).toBeVisible();
  await expect(dialog.getByText("Build session · Sep 3, 2026")).toBeVisible();
  await expect(dialog.getByText("Submitted contests")).toBeVisible();
  await expect(dialog.getByText("3", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Partial — checked in, no check-out")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close contest review dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(indicator).toBeFocused();
  await indicator.click();
  await dialog.getByRole("button", { name: "Approve and mark present" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A review reason is required before resolving this contest.");
  await dialog.getByLabel("Review reason").fill("Operator confirmed the kiosk error.");
  await dialog.getByRole("button", { name: "Approve and mark present" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Contest approved.");
  await expect(dialog.getByText("No attendance contests need review.")).toBeVisible();
  await expect(indicator).toHaveCount(0);

  contests = [{ meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 3, hasPartialScan: true, rawScanStatus: "partial" }];
  failNextResolution = true;
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Attendance contests" })).toHaveCount(0);
  const refreshedIndicator = page.getByRole("button", { name: "1 attendance contest awaiting review. Open contest review." });
  await refreshedIndicator.click();
  const refreshedDialog = page.getByRole("dialog", { name: "Contests awaiting review" });
  await expect(refreshedDialog).toContainText("Jordan Lee");
  await expect(refreshedDialog).toContainText("A-103");
  await expect(refreshedDialog).toContainText("Build session · Sep 3, 2026");
  await refreshedDialog.getByLabel("Review reason").fill("Operator reviewed the original attendance.");
  await refreshedDialog.getByRole("button", { name: "Keep attendance" }).click();
  await expect(refreshedDialog.getByRole("alert")).toHaveText("Contest resolution failed: Review service unavailable");
  await refreshedDialog.getByRole("button", { name: "Keep attendance" }).click();
  await expect(refreshedDialog.getByRole("status")).toHaveText("Contest reviewed.");
  await expect(page.getByRole("button", { name: /attendance contest.*awaiting review/i })).toHaveCount(0);
});

test("global contest review distinguishes partial, missing, and complete raw scans responsively", async ({ page }) => {
  const contests = [
    { meetingId: "partial", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "member-1", externalId: "A-101", firstName: "Avery", lastName: "Stone", status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 4, hasPartialScan: true, rawScanStatus: "partial" },
    { meetingId: "none", meetingTitle: "Studio night", meetingStartsAt: "2026-09-04T20:00:00Z", memberId: "member-2", externalId: "A-102", firstName: "Morgan", lastName: "Diaz", status: "open", createdAt: "2026-09-04T20:05:00Z", lifetimeContestCount: 2, hasPartialScan: false, rawScanStatus: "none" },
    { meetingId: "complete", meetingTitle: "Open workshop", meetingStartsAt: "2026-09-05T20:00:00Z", memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", status: "open", createdAt: "2026-09-05T20:05:00Z", lifetimeContestCount: 1, hasPartialScan: false, rawScanStatus: "complete" },
  ];
  await page.route(/\/discord\/contests(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contests }) }));

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/dashboard");
    const indicator = page.getByRole("button", { name: "3 attendance contests awaiting review. Open contest review." });
    await indicator.click();
    const dialog = page.getByRole("dialog", { name: "Contests awaiting review" });
    for (const [name, count, scan] of [["Avery Stone", "4", "Partial — checked in, no check-out"], ["Morgan Diaz", "2", "No scans"], ["Jordan Lee", "1", "Complete — checked in and out"]] as const) {
      const contest = dialog.locator("article").filter({ hasText: name });
      await expect(contest.getByText(count, { exact: true })).toBeVisible();
      await expect(contest.getByText(scan, { exact: true })).toBeVisible();
    }
    const widths = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
    await page.keyboard.press("Escape");
    await expect(indicator).toBeFocused();
    const theme = page.getByRole("switch", { name: "Dark mode" });
    if (!await theme.isChecked()) await theme.click();
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
    await indicator.click();
    await expect(page.getByRole("dialog", { name: "Contests awaiting review" }).getByText("Partial — checked in, no check-out", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(indicator).toBeFocused();
    await theme.click();
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  }
});

test("Reports filters completed Regular and Optional meetings without hiding All meetings", async ({ page }) => {
  // The preview includes completed meetings of each type. This specifically avoids the
  // prior gap, where the smoke test had only active or future meetings to filter.
  await page.goto("/reports");
  const scope = page.locator(".report-scope");
  const meetingType = page.getByLabel("Meeting type");

  await expect(scope).toHaveText("Showing 2 completed meetings across all preserved history.");
  await meetingType.selectOption("regular");
  await expect(scope).toHaveText("Showing 1 completed meeting across all preserved history.");
  await meetingType.selectOption("optional");
  await expect(scope).toHaveText("Showing 1 completed meeting across all preserved history.");
  await meetingType.selectOption("all");
  await expect(scope).toHaveText("Showing 2 completed meetings across all preserved history.");
});

test("Reports identifies preserved history when no operational baseline is configured", async ({ page }) => {
  await page.goto("/reports");
  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveValue("all");
  await expect(reportingPeriod).toBeEnabled();
  await expect(reportingPeriod.locator('option[value="baseline"]')).toHaveAttribute("disabled", "");
  await expect(page.locator("#reporting-period-help")).toHaveText("No operational baseline is configured, so All preserved history is active. An Admin can configure a baseline in Configuration settings to make the operational period available.");
});

test("Reports defaults to a configured operational baseline while preserving historical access", async ({ page }) => {
  const baseline = new Date(Date.now() - 3.5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await page.route("**/meetings", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, attendanceReportingStartsOn: baseline } });
  });
  await page.goto("/reports");

  const reportingPeriod = page.getByLabel("Reporting period");
  await expect(reportingPeriod).toHaveValue("baseline");
  await expect(reportingPeriod.locator('option[value="baseline"]')).not.toHaveAttribute("disabled", "");
  await expect(page.getByLabel("From")).toBeDisabled();
  await expect(page.locator("#reporting-period-help")).toHaveText(`The operational baseline starts ${baseline} and is selected by default. Choose All preserved history to include completed meetings from before that date.`);
  await expect(page.locator(".report-scope")).toContainText(`in the operational reporting baseline (from ${baseline})`);

  await reportingPeriod.selectOption("all");
  await expect(page.getByLabel("From")).toBeEnabled();
  await expect(page.locator(".report-scope")).toHaveText("Showing 2 completed meetings across all preserved history.");
});

test("Reports selectors keep selected values and inset arrows visible at supported widths", async ({ page }) => {
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/reports");
    await page.evaluate(() => document.fonts.ready);

    const geometries = await page.locator(".reports-page select").evaluateAll((selectors) => selectors.map((selector) => {
      const element = selector as HTMLSelectElement;
      const bounds = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      context.font = styles.font;
      return {
        left: bounds.left,
        right: bounds.right,
        clientWidth: document.documentElement.clientWidth,
        paddingRight: Number.parseFloat(styles.paddingRight),
        availableTextWidth: bounds.width - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight),
        selectedTextWidth: context.measureText(element.selectedOptions[0].text).width,
        backgroundImage: styles.backgroundImage,
        backgroundPositionX: styles.backgroundPositionX,
      };
    }));

    expect(geometries).toHaveLength(5);
    for (const geometry of geometries) {
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.paddingRight).toBeGreaterThanOrEqual(48);
      expect(geometry.backgroundImage).not.toBe("none");
      expect(geometry.backgroundPositionX).toContain("calc(100% -");
      expect(geometry.availableTextWidth).toBeGreaterThanOrEqual(geometry.selectedTextWidth);
    }
  }
});

test("Kiosks hides routine refresh success and preserves action feedback", async ({ page }) => {
  await page.route("**/admin/kiosks/kiosk-1", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/kiosks");
  await expect(page.getByRole("heading", { name: "Kiosks", exact: true })).toBeVisible();
  const physicalKiosk = page.locator(".kiosk-grid > .task-card").filter({ has: page.getByRole("heading", { name: "Physical kiosk" }) });
  const replaceButton = physicalKiosk.getByRole("button", { name: "Replace kiosk" });
  await expect(replaceButton).toBeVisible();
  await expect(page.locator(".page-intro").getByRole("button", { name: "Replace kiosk" })).toHaveCount(0);
  await expect(page.getByText("Kiosk status is current.")).toHaveCount(0);
  await expect(page.locator(".setup-status")).toHaveCount(0);

  await replaceButton.click();
  const dialog = page.getByRole("dialog", { name: "Replace physical kiosk" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("redeeming this key retires Front desk")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create one-time pairing key" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(dialog.getByRole("button", { name: "Create one-time pairing key" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close pairing dialog" }).click();

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Device name").fill("Lobby kiosk");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("status")).toHaveText("Kiosk renamed.");
});

test("Kiosks keeps pairing actions Admin-only and contained on narrow screens", async ({ page }) => {
  await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { role: "operator" } }) }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/kiosks");

  const physicalKiosk = page.locator(".kiosk-grid > .task-card").filter({ has: page.getByRole("heading", { name: "Physical kiosk" }) });
  await expect(physicalKiosk).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Add|Replace) kiosk$/ })).toHaveCount(0);
  const [cardBounds, pageWidth] = await Promise.all([physicalKiosk.boundingBox(), page.evaluate(() => document.documentElement.clientWidth)]);
  expect(cardBounds).not.toBeNull();
  expect(cardBounds!.x).toBeGreaterThanOrEqual(0);
  expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(pageWidth);
});

test("Kiosks keeps refresh failures visible", async ({ page }) => {
  await page.route("**/admin/kiosks", (route) => route.abort());
  await page.goto("/kiosks");
  await expect(page.getByRole("alert")).toHaveText("Failed to fetch");
});

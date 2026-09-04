import { expect, test } from "@playwright/test";

const mobileViewports = [
  { name: "compact phone", width: 375, height: 667 },
  { name: "modern phone", width: 390, height: 844 },
];

const routes = [
  "/dashboard",
  "/meetings",
  "/attendance",
  "/reports",
  "/roster",
  "/kiosks",
  "/settings/organization",
  "/settings/configuration",
  "/settings/access",
  "/settings/integrations",
  "/settings/privacy",
  "/settings/data",
  "/settings/updates",
];

for (const viewport of mobileViewports) {
  test(`dashboard routes fit ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);

    for (const route of routes) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(dimensions.scrollWidth, route).toBeLessThanOrEqual(dimensions.clientWidth);
    }
  });

  test(`roster dialog fits ${viewport.name} without clipped controls`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/roster");
    await page.getByRole("button", { name: "Add member" }).click();
    const dialog = page.getByRole("dialog", { name: "Add roster member" });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  });
}

test("mobile controls retain a 44px touch target", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
  const controls = await page.locator(".dashboard-shell button, .dashboard-shell input, .dashboard-shell select").evaluateAll((elements) =>
    elements.filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    }).map((element) => ({
      label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
      height: element.getBoundingClientRect().height,
    })),
  );
  for (const control of controls) expect(control.height, control.label).toBeGreaterThanOrEqual(44);
});

test("mobile navigation opens as a dismissible side drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.click();
  const navigation = page.getByRole("navigation", { name: "Primary dashboard navigation" });
  await expect(navigation).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click({ force: true });
  await expect(navigation).not.toBeVisible();
  await menu.waitFor({ state: "visible" });
  await menu.click();
  await navigation.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(navigation).not.toBeVisible();
});

test("Settings keeps its parent bubble and the current subpage at desktop and mobile widths", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/settings/configuration");
    if (viewport.width < 700) await page.getByRole("button", { name: "Open navigation" }).click();
    const settings = page.getByRole("link", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await expect(settings).toHaveClass(/active/);
    await expect(settings).not.toHaveAttribute("aria-current");
    const currentCategory = page.getByRole("navigation", { name: "Settings categories" }).getByRole("link", { name: "Configuration" });
    await expect(currentCategory).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Changes apply to every meeting after you save them")).toHaveCount(0);
  }
});

test("meeting actions move below meeting data on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/meetings");
  const row = page.locator(".meeting-directory tbody tr").first();
  const title = row.locator(".meeting-title-cell");
  const actions = row.locator(".meeting-actions-cell");
  await expect(row).toBeVisible();
  await expect(row.locator(".meeting-mobile-details")).toBeVisible();
  const [titleBounds, actionsBounds] = await Promise.all([title.boundingBox(), actions.boundingBox()]);
  expect(actionsBounds!.y).toBeGreaterThan(titleBounds!.y + titleBounds!.height);
  for (const button of await actions.getByRole("button").all()) expect((await button.boundingBox())!.width).toBeGreaterThan(80);
});

test("roster actions remain available below member data on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/admin/members", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      discordConfigured: true,
      members: [{ id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: "avery@example.org", discordUserId: "123456789012", active: 1 }],
    }),
  }));
  await page.goto("/roster");

  const header = page.locator(".roster-row.header");
  const row = page.locator(".roster-row:not(.header)").first();
  const identity = row.locator(".roster-identity");
  const actions = row.locator(".roster-action-cell");
  await expect(header).toBeHidden();
  await expect(row.locator(".roster-discord-id")).toBeVisible();
  await expect(actions.getByRole("button")).toHaveCount(3);
  await expect(row.locator(".roster-member-id")).toHaveCSS("text-align", "right");
  expect(await row.locator(".roster-discord-id").evaluate((element) => getComputedStyle(element, "::before").content)).toBe('"Discord ID"');
  const [identityBounds, actionsBounds] = await Promise.all([identity.boundingBox(), actions.boundingBox()]);
  expect(actionsBounds!.y).toBeGreaterThan(identityBounds!.y + identityBounds!.height);
  for (const button of await actions.getByRole("button").all()) expect((await button.boundingBox())!.width).toBeGreaterThan(80);
});

test("data deletion requires an exact typed confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/data");
  const roster = page.locator(".data-category").filter({ has: page.getByRole("heading", { name: "Roster", exact: true }) });
  await roster.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Roster" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("permanently deletes");
  const deletion = dialog.getByRole("button", { name: "Delete roster" });
  await expect(deletion).toBeDisabled();
  await dialog.getByLabel("Type DELETE ROSTER to confirm").fill("DELETE ROSTER");
  await expect(deletion).toBeEnabled();
});

test("expanded mobile content only scrolls where data requires it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const allowedScrollerSelectors = [".responsive-table", ".table-scroll"];

  for (const route of routes) {
    await page.goto(route);
    while (await page.locator("details:not([open]) > summary").count()) await page.locator("details:not([open]) > summary").first().click();
    const unexpectedScrollers = await page.evaluate((allowed) => Array.from(document.querySelectorAll<HTMLElement>("*")).flatMap((element) => {
      const style = getComputedStyle(element);
      const isScrollable = element.scrollWidth > element.clientWidth + 1 && ["auto", "scroll"].includes(style.overflowX);
      const isAllowed = allowed.some((selector) => element.matches(selector));
      return isScrollable && !isAllowed ? [{ tag: element.tagName, className: element.className }] : [];
    }), allowedScrollerSelectors);
    expect(unexpectedScrollers, route).toEqual([]);
  }
});

test("expanded mobile controls stay within reach", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const route of routes) {
    await page.goto(route);
    while (await page.locator("details:not([open]) > summary").count()) await page.locator("details:not([open]) > summary").first().click();
    const clippedControls = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea, summary, [role='dialog']")).flatMap((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
      const inDataScroller = Boolean(element.closest(".responsive-table, .table-scroll"));
      const clipped = bounds.left < -1 || bounds.right > window.innerWidth + 1;
      return visible && clipped && !inDataScroller ? [{ label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName, left: bounds.left, right: bounds.right }] : [];
    }));
    expect(clippedControls, route).toEqual([]);
  }
});

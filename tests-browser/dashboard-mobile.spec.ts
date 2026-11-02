import { expect, test } from "@playwright/test";

const mobileViewports = [
  { name: "compact phone", width: 375, height: 667 },
  { name: "modern phone", width: 390, height: 844 },
];

for (const viewport of mobileViewports) {
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
    }).map((element) => {
      const isChoice = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type);
      const target = isChoice ? (element.labels?.[0] ?? element) : element;
      const mark = element.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label") || target.textContent?.trim() || element.tagName,
        height: target.getBoundingClientRect().height,
        squareMark: !isChoice || Math.abs(mark.width - mark.height) < 1,
        associatedLabel: !isChoice || target !== element,
      };
    }),
  );
  for (const control of controls) {
    expect(control.height, control.label).toBeGreaterThanOrEqual(44);
    expect(control.squareMark, control.label).toBe(true);
    expect(control.associatedLabel, control.label).toBe(true);
  }
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
    if (viewport.width < 700) await page.getByRole("button", { name: "Close navigation" }).click();
    await expect(page.locator(".settings-module-disclosure")).toHaveAttribute("data-active", "true");
    if (viewport.width < 700) await page.getByRole("button", { name: "Settings · Attendance", exact: true }).click();
    await page.getByRole("button", { name: "Modules", exact: true }).click();
    await expect(page.getByRole("group", { name: "Module settings" }).getByRole("link", { name: "Attendance", exact: true })).toHaveAttribute("aria-current", "page");
    if (viewport.width < 700) await expect(page.getByRole("combobox", { name: "Attendance section", exact: true })).toHaveValue("/settings/configuration");
    else {
      const currentCategory = page.getByRole("navigation", { name: "Attendance settings sections" }).getByRole("link", { name: "Meeting configuration" });
      await expect(currentCategory).toHaveAttribute("aria-current", "page");
    }
    await expect(page.getByText("Changes apply to every meeting after you save them")).toHaveCount(0);
  }
});

test("meeting selection remains reachable beside meeting data on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/meetings");
  const row = page.locator(".meeting-directory tbody tr").first();
  const selection = row.locator(".meeting-selection");
  await expect(row).toBeVisible();
  await expect(row.locator(".meeting-mobile-details")).toBeVisible();
  await expect(row.locator(".meeting-actions-cell")).toHaveCount(0);
  const bounds = await selection.boundingBox();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  const meetingDirectoryUrl = page.url();
  await selection.click();
  await expect(selection.getByRole("checkbox")).toBeChecked();
  await expect(page).toHaveURL(meetingDirectoryUrl);
});

test("roster pencil stays centered beside member data and opens member actions on a narrow screen", async ({ page }) => {
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
  await expect(actions.getByRole("button")).toHaveCount(1);
  await expect(row.locator(".roster-member-id")).toHaveCSS("text-align", "right");
  expect(await row.locator(".roster-discord-id").evaluate((element) => getComputedStyle(element, "::before").content)).toBe('"Discord ID"');
  const [identityBounds, actionsBounds] = await Promise.all([identity.boundingBox(), actions.boundingBox()]);
  const rowBounds = (await row.boundingBox())!;
  expect(Math.abs(actionsBounds!.y + actionsBounds!.height / 2 - rowBounds.y - rowBounds.height / 2)).toBeLessThan(2);
  expect(actionsBounds!.x).toBeGreaterThan(identityBounds!.x);
  const pencil = actions.getByRole("button");
  expect((await pencil.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await pencil.click();
  const editor = page.getByRole("dialog", { name: "Edit roster member" });
  await expect(editor.getByRole("button", { name: "Deactivate member", exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Delete member", exact: true })).toBeVisible();
});

test("data deletion requires an exact typed confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/data");
  const roster = page.locator(".data-category").filter({ has: page.getByRole("heading", { name: "Roster", exact: true }) });
  const opener = roster.getByRole("button", { name: "Delete roster data", exact: true });
  await expect(opener).toBeHidden();
  await roster.getByText("Restore or delete data", { exact: true }).click();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Delete Roster" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("permanently deletes");
  const deletion = dialog.getByRole("button", { name: "Delete roster" });
  await expect(deletion).toBeDisabled();
  for (const phrase of ["DELETE ATTENDANCE", "delete roster", "DELETE ROSTER EXTRA"]) {
    await dialog.getByLabel("Type DELETE ROSTER to confirm").fill(phrase);
    await expect(deletion).toBeDisabled();
  }
  await dialog.getByLabel("Type DELETE ROSTER to confirm").fill("DELETE ROSTER");
  await expect(deletion).toBeEnabled();
});

import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

const endpoint = "**/admin/kiosks/fingerprint-reset";
const panelFor = (page: Page) => page.getByRole("article", { name: "Fingerprint re-enrollment", exact: true });
const dialogFor = (page: Page) => page.getByRole("dialog", { name: "Reset all fingerprint mappings", exact: true });
const confirmation = "RESET ALL FINGERPRINT MAPPINGS";

async function context(page: Page, role = "admin") {
  await page.route("**/auth/session", route => route.fulfill({ json: { user: { id: "admin-1", role } } }));
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic organization", primaryColor: dashboardConformanceReferences.brand.primary, secondaryColor: dashboardConformanceReferences.brand.secondary, appearance: "dark", lateScanMinutes: 30 } } }));
  await page.route("**/admin/kiosks", route => route.fulfill({ json: { authenticationMethod: "fingerprint", kiosks: [{ id: "kiosk-1", name: "Synthetic kiosk", active: 1, readerOnline: 1, lastSeenAt: new Date().toISOString(), pairedAt: new Date().toISOString(), releaseVersion: "1.2.4" }] } }));
  await page.route(endpoint, route => route.fulfill({ json: { resetCommands: [] } }));
}

for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
  test(`Re-enrollment and reset are themed at ${width} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
    await context(page); await page.goto("/kiosks");
    const panel = panelFor(page), reset = panel.getByRole("button", { name: "Reset all fingerprint mappings", exact: true });
    await expect(panel).toContainText("re-enroll older fingerprints");
    await expect(reset).toBeEnabled(); await reset.scrollIntoViewIfNeeded();
    const style = await reset.evaluate(element => {
      const css = getComputedStyle(element), probe = document.createElement("span");
      probe.style.background = "var(--ui-error-surface)"; element.append(probe);
      const expected = getComputedStyle(probe).backgroundColor; probe.remove();
      return { expected, background: css.backgroundColor, height: element.getBoundingClientRect().height, border: css.borderTopStyle, radius: parseFloat(css.borderTopLeftRadius) };
    });
    expect(style.background).toBe(style.expected); expect(style.height).toBeGreaterThanOrEqual(44); expect(style.border).toBe("solid"); expect(style.radius).toBeGreaterThan(0);
    await reset.focus(); expect(await reset.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
    await reset.click(); const dialog = dialogFor(page);
    const layout = await dialog.evaluate(element => ({ width: element.getBoundingClientRect().width, rem: parseFloat(getComputedStyle(document.documentElement).fontSize), padding: parseFloat(getComputedStyle(element).paddingTop) }));
    expect(layout.width).toBeLessThanOrEqual(layout.rem * 38 + 1); expect(layout.padding).toBeGreaterThan(0);
    await expect(dialog).toContainText("Reader templates are retained"); await expect(dialog).toContainText("Offline kiosks keep their old associations");
    await expect(dialog.getByRole("button", { name: "Reset fingerprint mappings", exact: true })).toBeDisabled();
    await expect(dialog.getByLabel(`Type ${confirmation}`)).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`fingerprint-reset-${theme}-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape"); await expect(dialog).toBeHidden();
    await expect(reset).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test("No legacy review controls, slot metadata or review requests remain", async ({ page }) => {
  await context(page); let retiredCalls = 0, writes = 0;
  await page.route("**/admin/kiosks/fingerprint-review**", route => { retiredCalls++; return route.fulfill({ status: 410, json: { error: "Re-enrollment required" } }); });
  await page.route(endpoint, route => { if (route.request().method() !== "GET") writes++; return route.fulfill({ json: { resetCommands: [] } }); });
  await page.goto("/kiosks"); const panel = panelFor(page); await expect(panel).toBeVisible();
  await expect(page.getByRole("article", { name: "Fingerprint identity review", exact: true })).toHaveCount(0);
  for (const name of ["Look up member", "Confirm association", "Request mapping review", "Leave unverified"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(panel.getByRole("textbox")).toHaveCount(0); await expect(panel.getByRole("table")).toHaveCount(0);
  await expect(panel).toContainText("No fingerprint resets have been requested"); expect(retiredCalls).toBe(0); expect(writes).toBe(0);
});

test("Uncertain reset retries the same identity across cancel and reports offline acknowledgements", async ({ page }) => {
  await context(page); const resetIds: string[] = []; let queued = false;
  await page.route(endpoint, async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); expect(body.confirmation).toBe(confirmation); resetIds.push(body.resetId);
      if (resetIds.length === 1) return route.abort(); queued = true;
      return route.fulfill({ json: { queued: true, readerTemplatesErased: false } });
    }
    return route.fulfill({ json: { resetCommands: queued ? [{ id: "pending", kioskName: "Offline kiosk", acknowledgedAt: null, currentPairing: 1 }, { id: "completed", kioskName: "Online kiosk", acknowledgedAt: 0, currentPairing: 1 }, { id: "old", kioskName: "Replaced kiosk", acknowledgedAt: null, currentPairing: 0 }] : [] } });
  });
  await page.goto("/kiosks"); const panel = panelFor(page);
  for (let attempt = 0; attempt < 2; attempt++) {
    await panel.getByRole("button", { name: "Reset all fingerprint mappings", exact: true }).click(); const dialog = dialogFor(page);
    await dialog.getByLabel(`Type ${confirmation}`).fill(confirmation);
    await dialog.getByRole("button", { name: "Reset fingerprint mappings", exact: true }).click();
    if (!attempt) { await expect(dialog.getByRole("alert")).toBeVisible(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); }
    else await expect(dialog).toBeHidden();
  }
  expect(resetIds).toHaveLength(2); expect(resetIds[1]).toBe(resetIds[0]);
  await expect(panel).toContainText("Offline kiosk: Pending - waiting for kiosk"); await expect(panel).toContainText("Online kiosk: Completed");
  await expect(panel).toContainText("Replaced kiosk: Previous pairing - no longer authorized");
  await expect(panel).toContainText("Offline kiosks can continue using old associations"); await expect(panel).toContainText("Cloud storage and peer sync are disabled");
});

test("Reset requires exact typed confirmation and no automatic write", async ({ page }) => {
  await context(page); let writes = 0;
  await page.route(endpoint, route => { if (route.request().method() === "POST") writes++; return route.fulfill({ json: { resetCommands: [] } }); });
  await page.goto("/kiosks"); await panelFor(page).getByRole("button", { name: "Reset all fingerprint mappings", exact: true }).click();
  const dialog = dialogFor(page), field = dialog.getByLabel(`Type ${confirmation}`), submit = dialog.getByRole("button", { name: "Reset fingerprint mappings", exact: true });
  for (const value of ["", "reset all fingerprint mappings", `${confirmation} `, "RESET ALL FINGERPRINTS"]) { await field.fill(value); await expect(submit).toBeDisabled(); }
  await field.fill(confirmation); await expect(submit).toBeEnabled(); expect(writes).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(writes).toBe(0);
});

test("Unavailable status disables reset and confirmed dispatch survives status refresh failure", async ({ page }) => {
  await context(page); let available = false, writes = 0;
  await page.route(endpoint, route => {
    if (route.request().method() === "POST") { writes++; available = false; return route.fulfill({ json: { queued: true } }); }
    return available ? route.fulfill({ json: { resetCommands: [] } }) : route.fulfill({ status: 503, json: { error: "Reset status unavailable" } });
  });
  await page.goto("/kiosks"); const panel = panelFor(page), reset = panel.getByRole("button", { name: "Reset all fingerprint mappings", exact: true });
  await expect(panel.getByRole("alert")).toHaveText("Reset status unavailable"); await expect(reset).toBeDisabled();
  available = true; await panel.getByRole("button", { name: "Refresh status", exact: true }).click(); await expect(reset).toBeEnabled();
  await reset.click(); const dialog = dialogFor(page); await dialog.getByLabel(`Type ${confirmation}`).fill(confirmation);
  await dialog.getByRole("button", { name: "Reset fingerprint mappings", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(panel.getByRole("alert")).toContainText("Fingerprint reset queued, but its status could not be refreshed");
  await expect(reset).toBeDisabled(); expect(writes).toBe(1);
});

test("Unconfirmed reset remains uncertain and keeps its request identity", async ({ page }) => {
  await context(page); const ids: string[] = [];
  await page.route(endpoint, route => {
    if (route.request().method() === "POST") { ids.push(route.request().postDataJSON().resetId); return route.fulfill({ json: { queued: false } }); }
    return route.fulfill({ json: { resetCommands: [] } });
  });
  await page.goto("/kiosks"); await panelFor(page).getByRole("button", { name: "Reset all fingerprint mappings", exact: true }).click(); const dialog = dialogFor(page);
  await dialog.getByLabel(`Type ${confirmation}`).fill(confirmation);
  for (let attempt = 0; attempt < 2; attempt++) { await dialog.getByRole("button", { name: "Reset fingerprint mappings", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("The reset was not confirmed"); }
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
});

test("Malformed reset status cannot show completed acknowledgements or enable reset", async ({ page }) => {
  await context(page);
  const valid = { id: "command", kioskName: "Synthetic kiosk", acknowledgedAt: null, currentPairing: 1 };
  const invalid = [null, { ...valid, acknowledgedAt: undefined }, { ...valid, acknowledgedAt: "complete" }, { ...valid, acknowledgedAt: -1 }, { ...valid, acknowledgedAt: 0.5 }, { ...valid, currentPairing: 2 }, { ...valid, id: "" }];
  let commands: unknown[] = [];
  await page.route(endpoint, route => route.fulfill({ json: { resetCommands: commands } }));
  await page.goto("/kiosks"); const panel = panelFor(page), reset = panel.getByRole("button", { name: "Reset all fingerprint mappings", exact: true });
  await expect(reset).toBeEnabled();
  for (const command of invalid) {
    commands = [command]; await panel.getByRole("button", { name: "Refresh status", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("Fingerprint reset status is unavailable.");
    await expect(reset).toBeDisabled(); await expect(panel).not.toContainText("Completed");
  }
  commands = [{ ...valid, acknowledgedAt: 0 }]; await panel.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(reset).toBeEnabled(); await expect(panel).toContainText("Synthetic kiosk: Completed");
});

test("Operator has no re-enrollment reset controls or Admin reads", async ({ page }) => {
  let reads = 0; await context(page, "operator"); await page.route(endpoint, route => { reads++; return route.fulfill({ status: 403, json: { error: "Admin required" } }); });
  await page.goto("/kiosks"); await expect(page.getByRole("heading", { name: "Kiosks", exact: true })).toBeVisible();
  await expect(panelFor(page)).toHaveCount(0); expect(reads).toBe(0);
});

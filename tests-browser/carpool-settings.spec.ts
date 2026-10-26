import { expect, test } from "@playwright/test";
import { carpoolSnapshot } from "./module-fixtures";
import { pairedViews } from "./paired-views";

for (const view of pairedViews) test(`Carpool settings securely save defaults and seed editable plans at ${view.width} in ${view.theme}`, async ({ page }) => {
  await page.setViewportSize(view); await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), view.theme);
  let saved = { radiusMiles: 12, preferredRadiusMiles: 4, revision: 0, geocodingConfigured: false, canSaveApiKey: true }; const writes: Record<string, unknown>[] = [];
  await page.route("**/platform/modules", route => route.fulfill({ json: carpoolSnapshot() }));
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Robotics", primaryColor: "#6d28d9", secondaryColor: "#0f766e" } } }));
  await page.route("**/admin/carpool/settings", route => {
    if (route.request().method() === "PUT") { const body = route.request().postDataJSON(); writes.push(body); saved = { ...saved, radiusMiles: body.radiusMiles, preferredRadiusMiles: body.preferredRadiusMiles, revision: saved.revision + 1, geocodingConfigured: body.removeApiKey ? false : body.apiKey ? true : saved.geocodingConfigured }; }
    return route.fulfill({ json: saved });
  });
  await page.route("**/admin/carpool/context*", route => route.fulfill({ json: { plans: [], members: [], importProfiles: [], defaults: saved, geocodingConfigured: saved.geocodingConfigured, detail: null } }));
  await page.goto("/settings/organization");
  if (view.width === 390) await page.getByRole("button", { name: "Settings · Organization", exact: true }).click();
  await page.getByRole("button", { name: "Modules", exact: true }).click();
  await page.getByRole("group", { name: "Module settings" }).getByRole("link", { name: "Carpool", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/carpool$/);
  const preferred = page.getByLabel("Default preferred radius (miles)"); await expect(preferred).toHaveValue("4");
  await preferred.fill("6"); await page.getByLabel("Default maximum radius (miles)").fill("20");
  const save = page.getByRole("button", { name: "Save Carpool settings" }); await page.getByLabel("Default maximum radius (miles)").focus(); await page.keyboard.press("Tab"); await expect(save).toBeFocused();
  const appearance = await save.evaluate(element => { const style = getComputedStyle(element); const probe = document.createElement("span"); element.append(probe); probe.style.color = "var(--on-primary)"; const text = getComputedStyle(probe).color; probe.style.color = "var(--primary)"; const primary = getComputedStyle(probe).color; probe.remove(); return { background: style.backgroundColor, primary, border: style.borderTopStyle, text: style.color, themeText: text, borderColor: style.borderTopColor, radius: parseFloat(style.borderRadius), height: element.getBoundingClientRect().height, focus: style.outlineStyle }; });
  expect(appearance.background).toBe(appearance.primary); expect(appearance.borderColor).toBe(appearance.primary); expect(appearance.text).toBe(appearance.themeText); expect(appearance.height).toBeGreaterThanOrEqual(44); expect(appearance.radius).toBeGreaterThan(0); expect(appearance.focus).toBe("solid"); expect(appearance.border).toBe("solid");
  await page.keyboard.press("Enter"); await expect(page.getByText("Carpool settings saved.")).toBeVisible();
  expect(writes[0]).toEqual({ radiusMiles: 20, preferredRadiusMiles: 6, revision: 0 });
  const sections = page.getByRole("navigation", { name: "Carpool settings sections" });
  if (view.width === 390) {
    await expect(sections).toBeHidden();
    await page.getByRole("combobox", { name: "Carpool settings sections", exact: true }).selectOption("/settings/carpool?section=location");
  } else await sections.getByRole("link", { name: "Location lookup" }).click();
  await expect(page).toHaveURL(/section=location$/);
  await page.getByLabel("Geoapify API key").fill("synthetic-browser-key"); await save.click();
  await expect(page.getByLabel("Geoapify API key")).toHaveValue("");
  expect(writes[1]).toEqual({ radiusMiles: 20, preferredRadiusMiles: 6, revision: 1, apiKey: "synthetic-browser-key" });
  await page.goBack(); await expect(preferred).toHaveValue("6"); await page.goForward(); await expect(page.getByLabel("Geoapify API key")).toBeVisible();
  await page.reload(); await expect(page.getByLabel("Geoapify API key")).toBeVisible();
  if (view.width === 390) await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Carpool", exact: true }).click(); await page.getByRole("button", { name: "New event", exact: true }).click();
  await expect(page.getByLabel("Preferred radius (miles)", { exact: true })).toHaveValue("6"); await expect(page.getByLabel("Maximum radius (miles)", { exact: true })).toHaveValue("20");
  await page.getByText("Advanced event details", { exact: true }).click(); await page.getByLabel("Preferred radius (miles)", { exact: true }).fill("3"); await expect(page.getByLabel("Preferred radius (miles)", { exact: true })).toHaveValue("3");
  await page.goto("/settings/carpool?section=location"); await page.getByLabel("Remove the current API key and use manual coordinates").check(); await expect(page.getByLabel("Geoapify API key")).toBeDisabled();
  await page.getByRole("button", { name: "Save Carpool settings" }).click(); await expect(page.getByText("No location lookup API key is configured.")).toBeVisible();
  expect(writes[2]).toEqual({ radiusMiles: 20, preferredRadiusMiles: 6, revision: 2, removeApiKey: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("carpool-settings.png"), fullPage: true });
});

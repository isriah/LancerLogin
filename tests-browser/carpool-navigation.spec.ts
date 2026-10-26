import { mockCarpoolShare } from "./carpool-share-fixture";
import { expect, test } from "@playwright/test";
import { carpoolSnapshot } from "./module-fixtures";
import { setDashboardTheme } from "./dashboard-theme";
import { pairedViews } from "./paired-views";

for (const { theme, width } of pairedViews) test(`Carpool work areas retain URLs, settings and direction at ${width} ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const plan = { id: "navigation", title: "Synthetic competition", destination: "Synthetic venue", meetingId: null, eventReference: "reference", eventTitleSnapshot: "External title", eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0 };
  await page.route("**/platform/modules", route => route.fulfill({ json: carpoolSnapshot() }));
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#7c3aed", secondaryColor: "#0f766e", appearance: theme, logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail: { plan, people: [], assignments: [], unresolved: [] } } }));
  await mockCarpoolShare(page, () => ({ plan, people: [], assignments: [], unresolved: [] }));
  await page.goto("/carpool/plans/navigation?area=groups&direction=return&view=map"); await setDashboardTheme(page, theme);
  const nav = page.getByRole("navigation", { name: "Carpool work areas" }); await expect(nav.getByRole("button")).toHaveCount(3);
  await expect(nav.getByRole("button", { name: "Groups", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "From event", exact: true })).toHaveAttribute("aria-pressed", "true"); await expect(page.getByRole("heading", { name: "Geographic review", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Event settings", exact: true }).click(); await expect(page.getByLabel("External event reference", { exact: false })).toBeHidden(); await page.getByText("Advanced event details", { exact: true }).click(); await expect(page.getByLabel("External event reference", { exact: false })).toHaveValue("reference");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await nav.getByRole("button", { name: "Share", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(page).toHaveURL(/area=share&direction=return$/);
  await expect(page.getByRole("button", { name: "Event settings", exact: true })).toBeVisible(); await page.reload(); await expect(nav.getByRole("button", { name: "Share", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "From event", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goBack(); await expect(nav.getByRole("button", { name: "Groups", exact: true })).toHaveAttribute("aria-current", "page"); await expect(page.getByRole("heading", { name: "Geographic review", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "People", exact: true }).click(); await page.getByRole("button", { name: "Review locations", exact: true }).click(); await expect(page).toHaveURL(/area=people&direction=return&view=locations$/);
  await expect(page.getByRole("heading", { name: "Location review", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "From event", exact: true })).toHaveAttribute("aria-pressed", "true");
  const active = nav.getByRole("button", { name: "People", exact: true }); const style = await active.evaluate(element => { const computed = getComputedStyle(element); const probe = document.createElement("span"); probe.style.color = "var(--primary)"; probe.style.backgroundColor = "var(--on-primary)"; element.append(probe); const tokens = getComputedStyle(probe); const result = { height: element.getBoundingClientRect().height, background: computed.backgroundColor, foreground: computed.color, primary: tokens.color, onPrimary: tokens.backgroundColor, border: computed.borderTopStyle, radius: computed.borderRadius }; probe.remove(); return result; });
  expect(style.height).toBeGreaterThanOrEqual(44); expect(style.background).toBe(style.primary); expect(style.foreground).toBe(style.onPrimary); expect(style.border).toBe("solid"); expect(style.radius).not.toBe("0px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath("carpool-navigation.png"), fullPage: true });
});

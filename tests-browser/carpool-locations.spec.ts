import { expect, test, type Page } from "@playwright/test";
import { carpoolSnapshot } from "./module-fixtures";
import { setDashboardTheme } from "./dashboard-theme";

async function setup(page: Page, fail = false, configured = true, running = false) {
  const plan = { id: "locations", title: "Synthetic automatic locations", destination: "Synthetic venue", tripScope: "both", meetingId: null, eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0 };
  const people: any[] = Array.from({ length: 5 }, (_, index) => ({ id: `person-${index}`, memberId: null, memberActive: null, displayName: `Lookup person ${index}`, contact: "", outboundStatus: index === 0 ? "offer" : "needs-ride", outboundAddress: `${index} Synthetic St, Example, PA 19000`, outboundLatitude: null, outboundLongitude: null, outboundSeats: index === 0 ? 4 : null, outboundLocationSource: null, returnStatus: "needs-ride", returnAddress: `${index} Synthetic Return St, Example, PA 19000`, returnLatitude: null, returnLongitude: null, returnSeats: null, returnLocationSource: null, returnSameAsOutbound: false, notes: "", revision: 0 }));
  people.push({ ...people[1], id: "missing", displayName: "Missing address person", outboundAddress: "", returnAddress: "" });
  let lookup: any = { inputKey: "initial", state: configured ? running ? "running" : "queued" : "unconfigured", remaining: 10 }; let calls = 0; let contextReads = 0; let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let releaseRetry!: () => void; const retryPending = new Promise<void>(resolve => { releaseRetry = resolve; });
  const detail = () => ({ plan, people, assignments: [], unresolved: [] });
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#7c3aed", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", route => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => { contextReads++; if (running && contextReads === 3) lookup = { ...lookup, state: "queued" }; return route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: configured, locationLookup: lookup, detail: detail() } }); });
  await page.route("**/admin/carpool/plans/locations/locations/resolve", async route => {
    calls++; const body = route.request().postDataJSON(); expect(body.automatic).toBe(true); expect(body.planRevision).toBe(plan.revision);
    if (body.retry) { fail = false; await retryPending; }
    if (calls === 1) await pending;
    if (fail && !body.retry) { lookup = { ...lookup, state: "failed", errorCode: "provider" }; await route.fulfill({ json: { ...detail(), locationLookup: lookup } }); return; }
    let resolved = 0;
    for (const person of people) for (const direction of ["outbound", "return"]) if (person[`${direction}Address`] && person[`${direction}Latitude`] === null && resolved < 8) { person[`${direction}Latitude`] = 40; person[`${direction}Longitude`] = -74; person[`${direction}LocationSource`] = "lookup"; person.revision++; resolved++; }
    plan.revision++; const remaining = people.reduce((sum, person) => sum + ["outbound", "return"].filter(direction => person[`${direction}Address`] && person[`${direction}Latitude`] === null).length, 0); lookup = { inputKey: `batch-${plan.revision}`, state: remaining ? "queued" : "complete", remaining };
    await route.fulfill({ json: { ...detail(), locationLookup: lookup } });
  });
  await page.goto("/carpool/plans/locations?area=groups"); await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  return { release, releaseRetry, calls: () => calls, contextReads: () => contextReads, detail, lookup: () => lookup };
}

test("saved addresses resolve in consecutive batches while participant drafts survive", async ({ page }) => {
  const state = await setup(page); const status = page.getByRole("region", { name: "Automatic location lookup" });
  await expect(status).toContainText("Locating saved addresses"); await expect(page.locator(".carpool-group-exceptions")).toContainText("Missing address person"); await expect(page.locator(".carpool-group-exceptions")).not.toContainText("Lookup person");
  await page.getByRole("button", { name: "People", exact: true }).click(); await page.getByRole("button", { name: "Edit Lookup person 1", exact: true }).click(); const editor = page.getByRole("dialog", { name: "Edit Lookup person 1" }); await editor.getByLabel("Notes", { exact: true }).fill("Keep this local draft");
  state.release(); await expect.poll(state.calls).toBe(2); await expect(status).toHaveCount(0); await expect(editor.getByLabel("Notes", { exact: true })).toHaveValue("Keep this local draft"); await expect(editor).toContainText("changed");
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByRole("button", { name: "From event", exact: true }).click(); await expect(page.locator(".carpool-group-exceptions")).toContainText("Lookup person 4");
  await page.reload(); await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible(); expect(state.calls()).toBe(2); expect(state.detail().people[4].returnLatitude).toBe(40);
});

test("an active lookup in another view is polled until the next batch is available", async ({ page }) => {
  const state = await setup(page, false, true, true); state.release(); expect(state.calls()).toBe(0);
  await expect(page.getByRole("region", { name: "Automatic location lookup" })).toContainText("Locating saved addresses"); await expect.poll(state.calls, { timeout: 8000 }).toBe(2); expect(state.contextReads()).toBeGreaterThanOrEqual(3); await expect(page.getByRole("region", { name: "Automatic location lookup" })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) for (const width of [1280, 390]) test(`lookup failure and retry use theme controls at ${width} ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); const state = await setup(page, true); state.release(); await setDashboardTheme(page, theme);
  const status = page.getByRole("region", { name: "Automatic location lookup" }); await expect(status).toContainText("Automatic lookup paused"); const retry = status.getByRole("button", { name: "Retry location lookup" });
  await page.reload(); await setDashboardTheme(page, theme); await expect(retry).toBeVisible(); expect(state.calls()).toBe(1); await retry.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  const style = await retry.evaluate(element => { const value = getComputedStyle(element); const probe = document.createElement("span"); probe.style.backgroundColor = "var(--ui-surface-subtle)"; probe.style.color = "var(--ui-text)"; probe.style.border = "1px solid var(--ui-border)"; probe.style.borderRadius = "var(--radius-control)"; element.append(probe); const expected = getComputedStyle(probe); const result = { height: element.getBoundingClientRect().height, background: value.backgroundColor, expectedBackground: expected.backgroundColor, color: value.color, expectedColor: expected.color, border: value.borderTopColor, expectedBorder: expected.borderTopColor, radius: value.borderRadius, expectedRadius: expected.borderRadius, outline: value.outlineStyle }; probe.remove(); return result; });
  expect(style.height).toBeGreaterThanOrEqual(44); expect(style.background).toBe(style.expectedBackground); expect(style.color).toBe(style.expectedColor); expect(style.border).toBe(style.expectedBorder); expect(style.radius).toBe(style.expectedRadius); expect(style.outline).not.toBe("none");
  await page.screenshot({ path: info.outputPath("lookup-failure.png"), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await retry.hover(); const hover = await retry.evaluate(element => { const actual = getComputedStyle(element); const probe = document.createElement("span"); probe.style.backgroundColor = "var(--ui-surface)"; probe.style.borderColor = "var(--primary)"; element.append(probe); const expected = getComputedStyle(probe); const result = { background: actual.backgroundColor, expectedBackground: expected.backgroundColor, border: actual.borderTopColor, expectedBorder: expected.borderTopColor }; probe.remove(); return result; }); expect(hover.background).toBe(hover.expectedBackground); expect(hover.border).toBe(hover.expectedBorder);
  await retry.click(); await expect(retry).toBeDisabled(); state.releaseRetry(); await expect(status).toHaveCount(0); await expect.poll(state.calls).toBe(3);
});

test("unconfigured lookup requests no provider and keeps blank addresses as review exceptions", async ({ page }) => {
  const state = await setup(page, false, false); await expect(page.getByRole("region", { name: "Automatic location lookup" })).toContainText("Automatic lookup is not configured"); await expect(page.locator(".carpool-group-exceptions")).toContainText("Missing address person"); await expect(page.locator(".carpool-group-exceptions")).not.toContainText("Lookup person");
  await page.reload(); await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible(); expect(state.calls()).toBe(0);
});

import { mockCarpoolShare } from "./carpool-share-fixture";
import { expect, test, type Page } from "@playwright/test";
import { carpoolSnapshot } from "./module-fixtures";
import { setDashboardTheme } from "./dashboard-theme";

async function expectStandardCarpoolButtonHeights(page: Page) {
  const measurements = await page.locator(".carpool-workspace button.ui-button:visible").evaluateAll((buttons) => buttons.map((button) => ({ label: button.textContent?.trim(), height: Math.round(button.getBoundingClientRect().height) })));
  expect(measurements.length).toBeGreaterThan(0);
  expect(new Set(measurements.map(({ height }) => height)).size, JSON.stringify(measurements)).toBe(1);
  expect(measurements[0]!.height).toBeGreaterThanOrEqual(44);
}

async function expectCarpoolPaddingToken(page: Page, selector: string, rem: number) {
  const measurement = await page.locator(selector).evaluate((element) => ({ padding: Number.parseFloat(getComputedStyle(element).paddingTop), rootSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) }));
  expect(measurement.padding).toBeCloseTo(measurement.rootSize * rem, 1);
}


async function mockImportPreview(page: Page) {
  await page.route("**/admin/carpool/plans/plan-1/import/preview", route => route.fulfill({ json: { planRevision: 0, previewToken: "synthetic-preview", summary: { rows: 1, added: 1, updated: 0, unchanged: 0, staffEditsPreserved: 0, assignmentsNeedingReview: 0, unmatchedRosterIds: 0 }, people: [{ sourceRow: 2, displayName: "Driver", contact: "", outboundStatus: "offer", outboundAddress: "One", outboundSeats: 2, returnStatus: "arranged", returnAddress: "One", returnSeats: null, disposition: "new", memberLinked: false, staffEditsPreserved: false }] } }));
}

for (const scenario of [{ width: 1280, height: 900, appearance: "light" }, { width: 390, height: 844, appearance: "dark" }] as const) test(`Carpool staff workflow is themed and keyboard reachable at ${scenario.width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scenario.width, height: scenario.height }); await page.emulateMedia({ reducedMotion: "reduce" });
  let plan: Record<string, any> | null = null; let people: Record<string, any>[] = []; let assignments: Record<string, any>[] = []; let unresolved: Record<string, any>[] = []; let generateRequests = 0;
  const detail = () => plan ? { plan, people, assignments, unresolved } : null;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: scenario.appearance, logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: plan ? [plan] : [], members: [{ id: "member-1", externalId: "M-001", firstName: "Avery", lastName: "Member", email: "avery@example.test" }], importProfiles: [], geocodingConfigured: false, detail: detail() } }));
  await page.route("**/admin/carpool/plans", async (route) => { const body = route.request().postDataJSON() as Record<string, any>; plan = { id: "plan-1", ...body, archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" }; await route.fulfill({ status: 201, json: detail() }); });
  await page.route(/\/admin\/carpool\/plans\/plan-1\/people(?:\/[^/?]+)?$/, async (route) => {
    const body = route.request().method() === "DELETE" ? null : route.request().postDataJSON() as Record<string, any>; const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") people.push({ id: "person-1", planId: "plan-1", memberActive: null, revision: 0, ...body });
    if (route.request().method() === "PATCH") people = people.map((person) => person.id === id ? { ...person, ...body, revision: person.revision + 1 } : person);
    if (route.request().method() === "DELETE") people = people.filter((person) => person.id !== id);
    await route.fulfill({ status: route.request().method() === "POST" ? 201 : 200, json: detail() });
  });
  await page.route("**/admin/carpool/plans/plan-1/import", async (route) => { people = [{ id: "imported-driver", memberId: null, memberActive: null, displayName: "Driver", contact: "", outboundSourceStatus: "offer", outboundStatus: "offer", outboundAddress: "One", outboundLatitude: 40.2, outboundLongitude: -74.2, outboundSeats: 2, returnSourceStatus: "arranged", returnStatus: "arranged", returnAddress: "One", returnLatitude: 40.2, returnLongitude: -74.2, returnSeats: null, returnSameAsOutbound: true, notes: "", revision: 0 }]; await route.fulfill({ status: 201, json: { imported: 1, detail: detail() } }); });
  await page.route("**/admin/carpool/plans/plan-1/rebuild/preview", route => { const input = route.request().postDataJSON(); const directions = input.direction === "both" ? ["outbound", "return"] : [input.direction]; return route.fulfill({ json: { planRevision: plan!.revision, previewToken: "reviewed-groups", directions, radiusMiles: input.radiusMiles, preferredRadiusMiles: input.preferredRadiusMiles, assignments: [], unresolved: directions.flatMap(direction => people.map(person => ({ riderId: person.id, direction, reason: "no-nearby-car", detail: "No eligible car is available." }))), changes: [], summary: directions.map(direction => ({ direction, assigned: 0, exceptions: people.length, lockedPreserved: 0, added: 0, moved: 0, removed: 0, unchanged: 0 })) } }); });
  await page.route("**/admin/carpool/plans/plan-1/rebuild/apply", async route => { generateRequests++; const input = route.request().postDataJSON(); expect(input.previewToken).toBe("reviewed-groups"); unresolved = (["outbound", "return"] as const).flatMap(direction => people.map(person => ({ riderId: person.id, direction, reason: "no-nearby-car", detail: "No eligible car is available." }))); await route.fulfill({ json: detail() }); });

  await mockCarpoolShare(page, detail); await mockImportPreview(page); await page.goto("/carpool"); await setDashboardTheme(page, scenario.appearance); await expect(page.locator(".app")).toHaveAttribute("data-theme", scenario.appearance); await expect(page.getByRole("heading", { name: "Carpool Builder", exact: true })).toBeVisible();
  await expectStandardCarpoolButtonHeights(page);
  await expectCarpoolPaddingToken(page, ".carpool-empty-start", scenario.width <= 520 ? .75 : 1);
  const create = page.locator(".operational-page-intro").getByRole("button", { name: "New event" }); const standardControlHeight = Math.round((await create.boundingBox())!.height); await create.focus(); await page.keyboard.press("Enter"); await expect(create).toHaveAttribute("aria-expanded", "true");
  const eventForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "New Carpool event" }) }); await eventForm.getByLabel("Event name").fill("Regional competition"); await eventForm.getByLabel("Event destination").fill("Arena"); await eventForm.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByRole("button", { name: "Import CSV", exact: true }).click(); await page.getByLabel("CSV file").setInputFiles({ name: "synthetic-review.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status there,Address,Available seats there,Status back\nDriver,offer,One,two seats,arranged") });
  await expect(page.getByLabel("Latitude there (optional)")).toBeHidden(); await expect(page.getByLabel("Longitude there (optional)")).toBeHidden(); await expect(page.getByLabel("Latitude back (optional)")).toBeHidden(); await expect(page.getByLabel("Longitude back (optional)")).toBeHidden();
  const reviewImport = page.getByRole("button", { name: "Review mapped data" }); expect(Math.round((await reviewImport.boundingBox())!.height)).toBe(standardControlHeight); await reviewImport.click();
  const importCell = page.getByRole("textbox", { name: "Row 2, Available seats there" }); const cellStyle = await importCell.evaluate((element) => { const value = getComputedStyle(element); return { height: Math.round(element.getBoundingClientRect().height), border: value.borderTopStyle, radius: value.borderRadius }; }); expect(cellStyle.height).toBeGreaterThanOrEqual(44); expect(cellStyle.border).toBe("solid"); expect(cellStyle.radius).not.toBe("0px"); await importCell.fill("2"); await expect(page.getByText("Original: two seats")).toBeVisible(); await importCell.blur(); await expect(importCell).toHaveCount(0); await expect(page.getByText("All 1 rows are ready to import.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); const saveImport = page.getByRole("button", { name: "Preview import changes" }); await expect(saveImport).toBeEnabled(); await saveImport.click(); await page.getByRole("button", { name: "Apply import", exact: true }).click(); await page.getByRole("button", { name: "Review locations", exact: true }).click(); await expect(page.getByRole("heading", { name: "Location review" })).toBeVisible();
  const directionSizes = await page.getByRole("group", { name: "Trip direction" }).getByRole("button").evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }; }));
  expect(new Set(directionSizes.map(({ width }) => width)).size, JSON.stringify(directionSizes)).toBe(1); expect(new Set(directionSizes.map(({ height }) => height)).size, JSON.stringify(directionSizes)).toBe(1); expect(new Set(directionSizes.map(({ top }) => top)).size, JSON.stringify(directionSizes)).toBe(1); expect(directionSizes[1]!.left).toBeGreaterThan(directionSizes[0]!.left);
  const rowAlignment = await page.locator(".carpool-person-row").evaluateAll(rows => rows.map(row => getComputedStyle(row).alignItems)); expect(new Set(rowAlignment)).toEqual(new Set(["center"]));
  await page.getByRole("button", { name: "People", exact: true }).click(); await page.getByRole("button", { name: "Add participant", exact: true }).click();
  await expectStandardCarpoolButtonHeights(page);
  const add = page.getByRole("dialog", { name: "Add participant", exact: true }); await add.getByLabel("Name").fill("Ad hoc rider"); await add.getByLabel("To event transportation").selectOption("needs-ride"); await add.getByLabel("To event pickup address").fill("1 Main St"); await add.getByText("To event advanced coordinates", { exact: true }).click(); await add.getByLabel("To event latitude", { exact: true }).fill("40.1"); await add.getByLabel("To event longitude", { exact: true }).fill("-74.1"); await add.getByLabel("From event transportation").selectOption("transit"); await add.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByRole("list", { name: "Carpool participants" }).getByText("Ad hoc rider", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Review locations", exact: true }).click(); await expect(page.getByRole("button", { name: "Automatic lookup not configured" })).toBeDisabled();
  await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByLabel("Rebuild trips").selectOption("both"); await page.getByRole("button", { name: "Preview groups", exact: true }).click(); expect(generateRequests).toBe(0); await page.getByRole("button", { name: "Apply proposed groups", exact: true }).click(); await expect.poll(() => generateRequests).toBe(1); await expect(page.getByText("No eligible car is available.").first()).toBeVisible();
  await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByRole("checkbox", { name: "Show map", exact: true }).check(); const geography = page.locator(".carpool-geography"); await expect(geography.getByRole("heading", { name: "Geographic review" })).toBeVisible(); await expectCarpoolPaddingToken(page, ".carpool-selected-car", scenario.width <= 520 ? .75 : 1); await expect(geography.getByText("Straight-line positions support grouping decisions.", { exact: false })).toHaveCount(0);
  const mapControls = geography.getByRole("group", { name: "Map display" }); await expect(mapControls).toBeVisible(); const mapShell = geography.locator(".carpool-map-shell"); const showPeopleNotNeedingRide = mapControls.getByRole("checkbox", { name: "Include other participants" }); await expect(showPeopleNotNeedingRide).not.toBeChecked(); await expect(mapShell.getByText("Driver", { exact: true })).toBeVisible(); await expect(mapShell.getByText("Ad hoc rider", { exact: true })).toBeVisible(); await showPeopleNotNeedingRide.check(); await expect(mapShell.getByText("Driver", { exact: true })).toBeVisible();
  const leafletSurface = page.locator(".carpool-leaflet-map > div"); await expect(leafletSurface).toHaveClass(/leaflet-container/); const leafletId = await leafletSurface.evaluate((element) => (element as HTMLElement & { _leaflet_id?: number })._leaflet_id); await page.getByRole("button", { name: "Fit view" }).click(); await expect.poll(() => leafletSurface.evaluate((element) => (element as HTMLElement & { _leaflet_id?: number })._leaflet_id)).toBe(leafletId);
  const mapControlLabels = await mapControls.locator("label").evaluateAll((labels) => labels.map((label) => { const style = getComputedStyle(label); return { height: Math.round(label.getBoundingClientRect().height), display: style.display, alignItems: style.alignItems }; })); expect(mapControlLabels.every(({ height, display, alignItems }) => height >= 44 && display === "flex" && alignItems === "center"), JSON.stringify(mapControlLabels)).toBe(true); const legendFontSize = await geography.locator(".carpool-map-legend").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)); expect(legendFontSize).toBeGreaterThanOrEqual(14);
  const selectedCar = page.locator(".carpool-selected-car"); await selectedCar.getByRole("button", { name: "Next car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver" })).toBeVisible(); await selectedCar.getByRole("button", { name: "Previous car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver" })).toBeVisible(); await page.getByRole("button", { name: "Preview groups", exact: true }).click(); await page.getByRole("button", { name: "Apply proposed groups", exact: true }).click(); await expect.poll(() => generateRequests).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("map-and-assignment-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Share", exact: true }).click(); await expect(page.getByRole("heading", { name: "Restore event backup" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Coordinator saved preview" })).toBeVisible(); const exportBoxes = await page.locator(".carpool-share-controls .ui-button").evaluateAll(buttons => buttons.map(button => ({ height: Math.round(button.getBoundingClientRect().height) }))); expect(new Set(exportBoxes.map(box => box.height)).size).toBe(1); expect(exportBoxes[0]!.height).toBeGreaterThanOrEqual(44); await page.getByText("Advanced: portable event backup", { exact: true }).click();
  const warningStyle = await page.locator(".carpool-share-preview [aria-label='Sharing warnings']").evaluate(element => { const style = getComputedStyle(element); return { paddingTop: Number.parseFloat(style.paddingTop), border: style.borderTopStyle, radius: style.borderRadius }; }); expect(warningStyle.paddingTop).toBeGreaterThan(0); expect(warningStyle.border).toBe("solid"); expect(warningStyle.radius).not.toBe("0px");
  await expectStandardCarpoolButtonHeights(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("Carpool moves an unlocked rider between cars with drag and drop", async ({ page }) => {
  const plan = { id: "plan-1", title: "Drag review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const people = [
    { id: "driver-1", memberId: null, memberActive: null, displayName: "Driver One", contact: "", outboundStatus: "offer", outboundAddress: "One", outboundLatitude: 39.95, outboundLongitude: -75.16, outboundSeats: 2, returnStatus: "transit", returnAddress: "", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: false, notes: "", revision: 0 },
    { id: "driver-2", memberId: null, memberActive: null, displayName: "Driver Two", contact: "", outboundStatus: "offer", outboundAddress: "Two", outboundLatitude: 39.96, outboundLongitude: -75.17, outboundSeats: 2, returnStatus: "transit", returnAddress: "", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: false, notes: "", revision: 0 },
    { id: "rider-1", memberId: null, memberActive: null, displayName: "Rider One", contact: "", outboundStatus: "needs-ride", outboundAddress: "Three", outboundLatitude: 39.955, outboundLongitude: -75.165, outboundSeats: null, returnStatus: "transit", returnAddress: "", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: false, notes: "", revision: 0 },
  ];
  let assignment = { planId: "plan-1", direction: "outbound", riderId: "rider-1", vehiclePersonId: "driver-1", distanceMiles: 0.8, manual: false, locked: false };
  const detail = () => ({ plan, people, assignments: [assignment], unresolved: [] });
  let changed: Record<string, unknown> | undefined;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail: detail() } }));
  await page.route("**/admin/carpool/plans/plan-1/assignments/outbound/rider-1", async (route) => { changed = route.request().postDataJSON() as Record<string, unknown>; if (changed.action === "move") assignment = { ...assignment, vehiclePersonId: String(changed.vehiclePersonId), manual: true }; if (changed.action === "lock") assignment = { ...assignment, locked: Boolean(changed.locked) }; await route.fulfill({ json: detail() }); });

  await page.goto("/carpool");
  await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByRole("checkbox", { name: "Show map", exact: true }).check();
  const selectedCar = page.locator(".carpool-selected-car"); await expect(selectedCar.getByRole("heading", { name: "Driver One" })).toBeVisible(); await selectedCar.getByRole("button", { name: "Next car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver Two" })).toBeVisible(); await selectedCar.getByRole("button", { name: "Previous car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver One" })).toBeVisible();
  const allCars = page.locator(".carpool-group-grid:not(.carpool-group-grid--compact)"); const source = allCars.locator(".carpool-group", { has: page.getByRole("heading", { name: "Driver One" }) }); const rider = source.locator(".carpool-rider-card", { hasText: "Rider One" });
  const destination = allCars.locator(".carpool-group", { has: page.getByRole("heading", { name: "Driver Two" }) });
  await expect(rider).toHaveAttribute("draggable", "true");
  const lock = rider.getByRole("button", { name: "Lock Rider One" }); await expect(lock).toBeVisible(); await lock.click(); await expect.poll(() => changed).toEqual({ action: "lock", locked: true, planRevision: 0 }); await expect(rider).toHaveAttribute("draggable", "false"); const unlock = rider.getByRole("button", { name: "Unlock Rider One" }); await unlock.click(); await expect.poll(() => changed).toEqual({ action: "lock", locked: false, planRevision: 0 }); await expect(rider).toHaveAttribute("draggable", "true"); await expect(rider.locator("select")).toHaveCount(0); await expect(rider.getByText("Drag to another car", { exact: true })).toHaveCount(0); await expect(rider.getByText("straight-line", { exact: false })).toHaveCount(0); await expect(rider.getByText("0.8 miles", { exact: true })).toBeVisible(); await expect(source.locator(".carpool-open-seat")).toHaveCount(1); await expect(destination.locator(".carpool-open-seat")).toHaveCount(1); await expect(destination.locator(".carpool-open-seat")).toContainText("2 passenger seats available"); const display = await allCars.evaluate(element => getComputedStyle(element).display); expect(display).toBe("grid");
  await rider.dragTo(destination);
  await expect.poll(() => changed).toEqual({ action: "move", vehiclePersonId: "driver-2", planRevision: 0 });
  await expect(destination.getByText("Rider One")).toBeVisible();
  await expect(source.locator(".carpool-open-seat")).toHaveCount(1); await expect(source.locator(".carpool-open-seat")).toContainText("2 passenger seats available"); await expect(destination.locator(".carpool-open-seat")).toHaveCount(1);
});

test("Carpool saves a shared manual pin from a return-only trip", async ({ page }) => {
  const plan = { id: "plan-1", title: "Return-only review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  let person = { id: "person-1", memberId: null, memberActive: null, displayName: "Return-only rider", contact: "", outboundStatus: "transit", outboundAddress: "One", outboundLatitude: null as number | null, outboundLongitude: null as number | null, outboundSeats: null, returnStatus: "needs-ride", returnAddress: "One", returnLatitude: null as number | null, returnLongitude: null as number | null, returnSeats: null, returnSameAsOutbound: true, notes: "", revision: 0 };
  const detail = () => ({ plan, people: [person], assignments: [], unresolved: [] }); let savedBody: Record<string, any> | null = null;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail: detail() } }));
  await page.route("**/admin/carpool/plans/plan-1/people/person-1", async (route) => { savedBody = route.request().postDataJSON() as Record<string, any>; person = { ...person, ...savedBody, revision: person.revision + 1 }; await route.fulfill({ json: detail() }); });

  await page.goto("/carpool"); await page.getByRole("button", { name: "Review locations", exact: true }).click(); await page.getByRole("button", { name: "From event", exact: true }).click();
  await page.getByRole("button", { name: "Edit Return-only rider", exact: true }).click(); const editor = page.getByRole("dialog"); await editor.getByText("From event advanced coordinates", { exact: true }).click(); await editor.getByLabel("From event latitude", { exact: true }).fill("39.95"); await editor.getByLabel("From event longitude", { exact: true }).fill("-75.16"); await editor.getByRole("button", { name: "Save participant", exact: true }).click();
  await expect(page.getByText("Saved pin", { exact: true })).toBeVisible(); expect(savedBody).toMatchObject({ outboundLatitude: 39.95, outboundLongitude: -75.16, returnLatitude: 39.95, returnLongitude: -75.16, returnSameAsOutbound: true });
});

test("Carpool offers locality-biased re-resolution for short saved addresses", async ({ page }) => {
  const plan = { id: "plan-1", title: "Address review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const person = { id: "person-1", memberId: null, memberActive: null, displayName: "Short address rider", contact: "", outboundStatus: "needs-ride", outboundAddress: "123 Main Street", outboundLatitude: 34, outboundLongitude: -118, outboundSeats: null, returnStatus: "transit", returnAddress: "", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: false, notes: "", revision: 0 };
  const detail = { plan, people: [person], assignments: [], unresolved: [] }; let resolveBody: Record<string, unknown> | undefined;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: true, detail } }));
  await page.route("**/admin/carpool/plans/plan-1/locations/resolve", async (route) => { resolveBody = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ json: detail }); });

  await page.goto("/carpool"); await page.getByRole("button", { name: "Review locations", exact: true }).click();
  const improve = page.getByRole("button", { name: "Re-resolve 1 short address nearby" }); await expect(improve).toBeVisible(); await improve.click();
  await expect.poll(() => resolveBody).toEqual({ refreshAmbiguous: true, planRevision: 0 });
});

test("Carpool shows the original imported response when a transportation status needs review", async ({ page }) => {
  const plan = { id: "plan-1", title: "Response review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const person = { id: "person-1", memberId: null, memberActive: null, displayName: "Imported participant", contact: "", outboundSourceStatus: "Student Driver", outboundStatus: "unknown", outboundAddress: "One", outboundLatitude: null, outboundLongitude: null, outboundSeats: null, returnSourceStatus: "Monday Carpool", returnStatus: "unknown", returnAddress: "One", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: true, notes: "", revision: 0 };
  const detail = { plan, people: [person], assignments: [], unresolved: [] };
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail } }));

  await page.goto("/carpool"); await page.getByRole("button", { name: "Edit Imported participant", exact: true }).click();
  await expect(page.getByText('Imported response: "Student Driver". Choose the closest status.')).toBeVisible();
  await expect(page.getByText('Imported response: "Monday Carpool". Choose the closest status.')).toBeVisible();
});

test("Carpool keeps demo datasets out of ordinary planning and supports manual entry", async ({ page }) => {
  const plan = { id: "manual", title: "Synthetic manual plan", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0 };
  await page.route("**/platform/modules", route => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail: { plan, people: [], assignments: [], unresolved: [] } } }));
  await page.goto("/carpool"); await expect(page.getByLabel("Temporary test dataset")).toHaveCount(0);
  await page.getByRole("button", { name: "Add participant", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add participant", exact: true })).toBeVisible();
});

test("Carpool shows CSV import errors beside the import action", async ({ page }) => {
  const plan = { id: "plan-1", title: "Synthetic import review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const detail = { plan, people: [], assignments: [], unresolved: [] };
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail } }));
  await page.route("**/admin/carpool/plans/plan-1/import/preview", (route) => route.fulfill({ status: 422, json: { error: "Some CSV rows need attention before they can be imported.", details: ["Row 2: Outbound drivers need a whole-number seat count."] } }));

  await page.goto("/carpool");
  await page.getByRole("button", { name: "Import CSV", exact: true }).click(); await page.getByLabel("CSV file").setInputFiles({ name: "synthetic-carpool.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status there,Address,Status back\nRider,needs-ride,One,arranged") });
  await expect(page.getByText(/Required fields are associated and ready/)).toBeVisible(); await page.getByRole("button", { name: "Review mapped data" }).click();
  const actions = page.locator(".carpool-import"); const submit = actions.getByRole("button", { name: "Preview import changes" }); await submit.click();
  const alert = actions.getByRole("alert"); await expect(alert).toHaveText("Row 2: Outbound drivers need a whole-number seat count."); await expect(submit).toHaveAttribute("aria-describedby", "carpool-import-notice"); await expect(page.locator(".carpool-workspace > .settings-notice")).toHaveCount(0); await expect(submit).toBeEnabled();

});

test("Carpool edits and downloads a corrected CSV working copy before import", async ({ page }) => {
  const plan = { id: "plan-1", title: "Synthetic correction review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const detail = { plan, people: [], assignments: [], unresolved: [] }; let importedCsv = "";
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail } }));
  await page.route("**/admin/carpool/plans/plan-1/import", async (route) => { importedCsv = (route.request().postDataJSON() as { csv: string }).csv; await route.fulfill({ status: 201, json: { imported: 1, detail } }); });

  await mockImportPreview(page); await page.goto("/carpool");
  await page.getByRole("button", { name: "Import CSV", exact: true }).click(); await page.getByLabel("CSV file").setInputFiles({ name: "synthetic-carpool.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status there,Address,Available seats there,Status back,Comments\nDriver,offer,One,two seats,arranged,\"=SUM(1,1)\"") });
  await expect(page.getByText(/Required fields are associated and ready/)).toBeVisible(); await page.getByRole("button", { name: "Review mapped data" }).click();
  const seats = page.getByRole("textbox", { name: "Row 2, Available seats there" }); await expect(page.getByText("Original: two seats")).toHaveCount(0); await seats.fill("2"); await expect(page.getByText("Original: two seats")).toBeVisible(); await seats.blur(); await expect(seats).toHaveCount(0); await expect(page.getByRole("button", { name: "Reset corrections" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download corrected CSV" }).click(); const downloaded = await downloadPromise; expect(downloaded.suggestedFilename()).toBe("synthetic-carpool-corrected.csv");
  const stream = await downloaded.createReadStream(); let downloadedCsv = ""; for await (const chunk of stream) downloadedCsv += chunk.toString(); expect(downloadedCsv).toContain("Driver,offer,One,2,arranged"); expect(downloadedCsv).toContain("\"'=SUM(1,1)\"");
  await page.getByRole("button", { name: "Reset corrections" }).click(); await expect(seats).toHaveValue("two seats"); await seats.fill("2"); await seats.blur(); await page.getByRole("button", { name: "Preview import changes" }).click(); await page.getByRole("button", { name: "Apply import", exact: true }).click(); await expect(page.locator(".carpool-import")).toBeHidden(); expect(importedCsv).toContain("Driver,offer,One,2,arranged"); expect(importedCsv).toContain("=SUM(1,1)");
});

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
  await page.route("**/admin/carpool/plans/plan-1/generate/both", async (route) => { generateRequests += 1; unresolved = (["outbound", "return"] as const).flatMap((direction) => people.map((person) => ({ riderId: person.id, direction, reason: "no-nearby-car", detail: "No eligible car is available." }))); await route.fulfill({ json: detail() }); });

  await page.goto("/carpool"); await setDashboardTheme(page, scenario.appearance); await expect(page.locator(".app")).toHaveAttribute("data-theme", scenario.appearance); await expect(page.getByRole("heading", { name: "Carpool Builder", exact: true })).toBeVisible();
  await expectStandardCarpoolButtonHeights(page);
  await expectCarpoolPaddingToken(page, ".carpool-empty-start", scenario.width <= 520 ? .75 : 1);
  const create = page.locator(".operational-page-intro").getByRole("button", { name: "New event" }); const standardControlHeight = Math.round((await create.boundingBox())!.height); await create.focus(); await page.keyboard.press("Enter"); await expect(create).toHaveAttribute("aria-expanded", "true");
  const eventForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "New Carpool event" }) }); await eventForm.getByLabel("Event name").fill("Regional competition"); await eventForm.getByLabel("Event destination").fill("Arena"); await eventForm.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByLabel("CSV file").setInputFiles({ name: "synthetic-review.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status there,Address,Available seats there,Status back\nDriver,offer,One,two seats,arranged") });
  await expect(page.getByLabel("Latitude there (optional)")).toHaveCount(0); await expect(page.getByLabel("Longitude there (optional)")).toHaveCount(0); await expect(page.getByLabel("Latitude back (optional)")).toHaveCount(0); await expect(page.getByLabel("Longitude back (optional)")).toHaveCount(0);
  const reviewImport = page.getByRole("button", { name: "Review mapped data" }); expect(Math.round((await reviewImport.boundingBox())!.height)).toBe(standardControlHeight); await reviewImport.click();
  const importCell = page.getByRole("textbox", { name: "Row 2, Available seats there" }); const cellStyle = await importCell.evaluate((element) => { const value = getComputedStyle(element); return { height: Math.round(element.getBoundingClientRect().height), border: value.borderTopStyle, radius: value.borderRadius }; }); expect(cellStyle.height).toBeGreaterThanOrEqual(44); expect(cellStyle.border).toBe("solid"); expect(cellStyle.radius).not.toBe("0px"); await importCell.fill("2"); await expect(page.getByText("Original: two seats")).toBeVisible(); await importCell.blur(); await expect(importCell).toHaveCount(0); await expect(page.getByText("All 1 rows are ready to import.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); const saveImport = page.getByRole("button", { name: "Save imported data" }); await expect(saveImport).toBeEnabled(); await saveImport.click(); await expect(page.getByRole("heading", { name: "Resolve locations once" })).toBeVisible();
  const directionSizes = await page.getByRole("group", { name: "Trip direction" }).getByRole("button").evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }; }));
  expect(new Set(directionSizes.map(({ width }) => width)).size, JSON.stringify(directionSizes)).toBe(1); expect(new Set(directionSizes.map(({ height }) => height)).size, JSON.stringify(directionSizes)).toBe(1); expect(new Set(directionSizes.map(({ top }) => top)).size, JSON.stringify(directionSizes)).toBe(1); expect(directionSizes[1]!.left).toBeGreaterThan(directionSizes[0]!.left);
  const locationCellAlignment = await page.locator(".carpool-location-table tbody td").evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).verticalAlign)); expect(new Set(locationCellAlignment)).toEqual(new Set(["middle"]));
  await page.getByRole("button", { name: /Import and review/ }).click(); await page.getByText("Manage saved participants (1)").click(); await page.getByRole("button", { name: "Add person" }).click();
  await expectStandardCarpoolButtonHeights(page);
  const add = page.locator("form").filter({ has: page.getByRole("heading", { name: "Add participant" }) }); await add.getByLabel("Name").fill("Ad hoc rider"); await add.getByLabel("Outbound status").selectOption("needs-ride"); await add.getByLabel("Outbound address").fill("1 Main St"); await add.getByLabel("Latitude").first().fill("40.1"); await add.getByLabel("Longitude").first().fill("-74.1"); await add.getByLabel("Return status").selectOption("transit"); await add.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByText("Ad hoc rider")).toBeVisible(); await page.getByRole("button", { name: /Resolve locations/ }).click(); await expect(page.getByRole("button", { name: "Automatic lookup not configured" })).toBeDisabled();
  await page.getByRole("button", { name: /Generate groups/ }).click(); await page.getByRole("button", { name: "Generate both directions", exact: true }).click(); await expect.poll(() => generateRequests).toBe(1); await expect(page.getByText("No eligible car is available.").first()).toBeVisible();
  await page.getByRole("button", { name: /Map and edit/ }).click(); const geography = page.locator(".carpool-geography"); await expect(geography.getByRole("heading", { name: "Geographic review" })).toBeVisible(); await expectCarpoolPaddingToken(page, ".carpool-selected-car", scenario.width <= 520 ? .75 : 1); await expect(geography.getByText("Straight-line positions support grouping decisions.", { exact: false })).toHaveCount(0);
  const mapControls = geography.getByRole("group", { name: "Map display" }); await expect(mapControls).toBeVisible(); const mapShell = geography.locator(".carpool-map-shell"); const showPeopleNotNeedingRide = mapControls.getByRole("checkbox", { name: "Show people who do not need rides" }); await expect(showPeopleNotNeedingRide).not.toBeChecked(); await expect(mapShell.getByText("Driver", { exact: true })).toHaveCount(0); await expect(mapShell.getByText("Ad hoc rider", { exact: true })).toBeVisible(); await showPeopleNotNeedingRide.check(); await expect(mapShell.getByText("Driver", { exact: true })).toBeVisible();
  const leafletSurface = page.locator(".carpool-leaflet-map > div"); await expect(leafletSurface).toHaveClass(/leaflet-container/); const leafletId = await leafletSurface.evaluate((element) => (element as HTMLElement & { _leaflet_id?: number })._leaflet_id); await page.getByRole("button", { name: "Fit view" }).click(); await expect.poll(() => leafletSurface.evaluate((element) => (element as HTMLElement & { _leaflet_id?: number })._leaflet_id)).toBe(leafletId);
  const mapControlLabels = await mapControls.locator("label").evaluateAll((labels) => labels.map((label) => { const style = getComputedStyle(label); return { height: Math.round(label.getBoundingClientRect().height), display: style.display, alignItems: style.alignItems }; })); expect(mapControlLabels.every(({ height, display, alignItems }) => height >= 44 && display === "flex" && alignItems === "center"), JSON.stringify(mapControlLabels)).toBe(true); const legendFontSize = await geography.locator(".carpool-map-legend").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)); expect(legendFontSize).toBeGreaterThanOrEqual(14);
  const selectedCar = page.locator(".carpool-selected-car"); await selectedCar.getByRole("button", { name: "Next car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver" })).toBeVisible(); await selectedCar.getByRole("button", { name: "Previous car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver" })).toBeVisible(); await page.getByRole("button", { name: "Regenerate both directions" }).click(); await expect.poll(() => generateRequests).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("map-and-assignment-review.png"), fullPage: true });
  await page.getByRole("button", { name: /Save and export/ }).click(); await expect(page.getByRole("heading", { name: "Restore event backup" })).toHaveCount(0);
  const exportBoxes = await page.locator(".carpool-export-grid .ui-button").evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { width: Math.round(box.width), height: Math.round(box.height), top: Math.round(box.top) }; })); expect(new Set(exportBoxes.map(({ height }) => height)).size).toBe(1); expect(exportBoxes[0]!.height).toBeGreaterThanOrEqual(44); if (scenario.width > 800) expect(new Set(exportBoxes.map(({ top }) => top)).size).toBe(1); expect(await page.locator(".carpool-print-actions").getAttribute("class")).toBe("carpool-print-actions");
  const warningStyle = await page.getByText("An installation backup is the primary recovery artifact.", { exact: false }).evaluate((element) => { const style = getComputedStyle(element); return { paddingTop: Number.parseFloat(style.paddingTop), border: style.borderTopStyle, radius: style.borderRadius }; }); expect(warningStyle.paddingTop).toBeGreaterThan(0); expect(warningStyle.border).toBe("solid"); expect(warningStyle.radius).not.toBe("0px");
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
  await page.getByRole("button", { name: /Map and edit/ }).click();
  const selectedCar = page.locator(".carpool-selected-car"); await selectedCar.getByRole("button", { name: "Next car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver One" })).toBeVisible(); await selectedCar.getByRole("button", { name: "Next car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver Two" })).toBeVisible(); await selectedCar.getByRole("button", { name: "Previous car" }).click(); await expect(selectedCar.getByRole("heading", { name: "Driver One" })).toBeVisible();
  const allCars = page.locator(".carpool-group-grid:not(.carpool-group-grid--compact)"); const source = allCars.locator(".carpool-group", { has: page.getByRole("heading", { name: "Driver One" }) }); const rider = source.locator(".carpool-rider-card", { hasText: "Rider One" });
  const destination = allCars.locator(".carpool-group", { has: page.getByRole("heading", { name: "Driver Two" }) });
  await expect(rider).toHaveAttribute("draggable", "true");
  const lock = rider.getByRole("button", { name: "Lock Rider One" }); await expect(lock).toBeVisible(); await lock.click(); await expect.poll(() => changed).toEqual({ action: "lock", locked: true }); await expect(rider).toHaveAttribute("draggable", "false"); const unlock = rider.getByRole("button", { name: "Unlock Rider One" }); await unlock.click(); await expect.poll(() => changed).toEqual({ action: "lock", locked: false }); await expect(rider).toHaveAttribute("draggable", "true"); await expect(rider.locator("select")).toHaveCount(0); await expect(rider.getByText("Drag to another car", { exact: true })).toHaveCount(0); await expect(rider.getByText("straight-line", { exact: false })).toHaveCount(0); await expect(rider.getByText("0.8 miles", { exact: true })).toBeVisible(); await expect(source.locator(".carpool-open-seat")).toHaveCount(1); await expect(destination.locator(".carpool-open-seat")).toHaveCount(2); const columnWidth = await allCars.evaluate((element) => getComputedStyle(element).columnWidth); expect(columnWidth).not.toBe("auto");
  await rider.dragTo(destination);
  await expect.poll(() => changed).toEqual({ action: "move", vehiclePersonId: "driver-2" });
  await expect(destination.getByText("Rider One")).toBeVisible();
  await expect(source.locator(".carpool-open-seat")).toHaveCount(2); await expect(destination.locator(".carpool-open-seat")).toHaveCount(1);
});

test("Carpool saves a shared manual pin from a return-only trip", async ({ page }) => {
  const plan = { id: "plan-1", title: "Return-only review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  let person = { id: "person-1", memberId: null, memberActive: null, displayName: "Return-only rider", contact: "", outboundStatus: "transit", outboundAddress: "One", outboundLatitude: null as number | null, outboundLongitude: null as number | null, outboundSeats: null, returnStatus: "needs-ride", returnAddress: "One", returnLatitude: null as number | null, returnLongitude: null as number | null, returnSeats: null, returnSameAsOutbound: true, notes: "", revision: 0 };
  const detail = () => ({ plan, people: [person], assignments: [], unresolved: [] }); let savedBody: Record<string, any> | null = null;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail: detail() } }));
  await page.route("**/admin/carpool/plans/plan-1/people/person-1", async (route) => { savedBody = route.request().postDataJSON() as Record<string, any>; person = { ...person, ...savedBody, revision: person.revision + 1 }; await route.fulfill({ json: detail() }); });

  await page.goto("/carpool"); await page.getByRole("button", { name: /Resolve locations/ }).click(); await page.getByRole("button", { name: "From event", exact: true }).click();
  await page.getByLabel("Return-only rider latitude").fill("39.95"); await page.getByLabel("Return-only rider longitude").fill("-75.16"); await page.getByRole("button", { name: "Set pin" }).click();
  await expect(page.getByText("Saved or manual pin")).toBeVisible(); expect(savedBody).toMatchObject({ outboundLatitude: 39.95, outboundLongitude: -75.16, returnLatitude: 39.95, returnLongitude: -75.16, returnSameAsOutbound: true });
});

test("Carpool offers locality-biased re-resolution for short saved addresses", async ({ page }) => {
  const plan = { id: "plan-1", title: "Address review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const person = { id: "person-1", memberId: null, memberActive: null, displayName: "Short address rider", contact: "", outboundStatus: "needs-ride", outboundAddress: "123 Main Street", outboundLatitude: 34, outboundLongitude: -118, outboundSeats: null, returnStatus: "transit", returnAddress: "", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: false, notes: "", revision: 0 };
  const detail = { plan, people: [person], assignments: [], unresolved: [] }; let resolveBody: Record<string, unknown> | undefined;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: true, detail } }));
  await page.route("**/admin/carpool/plans/plan-1/locations/resolve", async (route) => { resolveBody = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ json: detail }); });

  await page.goto("/carpool"); await page.getByRole("button", { name: /Resolve locations/ }).click();
  const improve = page.getByRole("button", { name: "Re-resolve 1 short address nearby" }); await expect(improve).toBeVisible(); await improve.click();
  await expect.poll(() => resolveBody).toEqual({ refreshAmbiguous: true });
});

test("Carpool shows the original imported response when a transportation status needs review", async ({ page }) => {
  const plan = { id: "plan-1", title: "Response review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const person = { id: "person-1", memberId: null, memberActive: null, displayName: "Imported participant", contact: "", outboundSourceStatus: "Student Driver", outboundStatus: "unknown", outboundAddress: "One", outboundLatitude: null, outboundLongitude: null, outboundSeats: null, returnSourceStatus: "Monday Carpool", returnStatus: "unknown", returnAddress: "One", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: true, notes: "", revision: 0 };
  const detail = { plan, people: [person], assignments: [], unresolved: [] };
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail } }));

  await page.goto("/carpool"); await page.getByText("Manage saved participants (1)").click();
  await expect(page.getByText('Imported response: "Student Driver". Choose the closest status.')).toBeVisible();
  await page.getByRole("button", { name: "From event", exact: true }).click();
  await expect(page.getByText('Imported response: "Monday Carpool". Choose the closest status.')).toBeVisible();
});

test("Carpool loads the original guided synthetic dataset without a location provider", async ({ page }) => {
  let plan: Record<string, any> | null = null; let people: Record<string, any>[] = []; let importedRows = 0;
  const detail = () => plan ? { plan, people, assignments: [], unresolved: [] } : null;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: plan ? [plan] : [], members: [], importProfiles: [], geocodingConfigured: false, detail: detail() } }));
  await page.route("**/admin/carpool/plans", async (route) => { const body = route.request().postDataJSON() as Record<string, any>; plan = { id: "guided-plan", ...body, archived: false, revision: 0 }; await route.fulfill({ status: 201, json: detail() }); });
  await page.route("**/admin/carpool/plans/guided-plan/import", async (route) => { const body = route.request().postDataJSON() as { csv: string }; importedRows = body.csv.trim().split(/\r?\n/).length - 1; people = Array.from({ length: importedRows }, (_, index) => ({ id: `person-${index}`, displayName: `Synthetic ${index + 1}`, contact: "", memberId: null, memberActive: null, outboundStatus: "transit", outboundAddress: "", outboundLatitude: null, outboundLongitude: null, outboundSeats: null, returnStatus: "transit", returnAddress: "", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: true, notes: "", revision: 0 })); await route.fulfill({ status: 201, json: { imported: importedRows, detail: detail() } }); });
  await page.goto("/carpool"); await page.getByLabel("Temporary test dataset").selectOption("guided");
  await expect(page.getByRole("heading", { name: "Resolve locations once" })).toBeVisible(); expect(importedRows).toBe(12); await expect(page.getByText("12 people")).toBeVisible();
});

test("Carpool shows CSV import errors beside the import action", async ({ page }) => {
  const plan = { id: "plan-1", title: "Synthetic import review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const detail = { plan, people: [], assignments: [], unresolved: [] };
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail } }));
  await page.route("**/admin/carpool/plans/plan-1/import", (route) => route.fulfill({ status: 422, json: { error: "Some CSV rows need attention before they can be imported.", details: ["Row 2: Outbound drivers need a whole-number seat count."] } }));

  await page.goto("/carpool");
  await page.getByLabel("CSV file").setInputFiles({ name: "synthetic-carpool.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status there,Address,Status back\nRider,needs-ride,One,arranged") });
  await expect(page.getByText(/Required fields are associated and ready/)).toBeVisible(); await page.getByRole("button", { name: "Review mapped data" }).click();
  const actions = page.locator(".carpool-import-actions"); const submit = actions.getByRole("button", { name: "Save imported data" }); await submit.click();
  const alert = actions.getByRole("alert"); await expect(alert).toHaveText("Row 2: Outbound drivers need a whole-number seat count."); await expect(submit).toHaveAttribute("aria-describedby", "carpool-import-notice"); await expect(page.locator(".carpool-workspace > .settings-notice")).toHaveCount(0);
  const placement = await actions.evaluate((element) => { const button = element.querySelector("button")!.getBoundingClientRect(); const message = element.querySelector("[role=alert]")!.getBoundingClientRect(); return { buttonTop: Math.round(button.top), messageTop: Math.round(message.top), messageLeft: Math.round(message.left), buttonRight: Math.round(button.right) }; });
  expect(Math.abs(placement.buttonTop - placement.messageTop)).toBeLessThanOrEqual(1); expect(placement.messageLeft).toBeGreaterThanOrEqual(placement.buttonRight);
});

test("Carpool edits and downloads a corrected CSV working copy before import", async ({ page }) => {
  const plan = { id: "plan-1", title: "Synthetic correction review", destination: "Arena", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-09-29", updatedAt: "2026-09-29" };
  const detail = { plan, people: [], assignments: [], unresolved: [] }; let importedCsv = "";
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, (route) => route.fulfill({ json: { plans: [plan], members: [], importProfiles: [], geocodingConfigured: false, detail } }));
  await page.route("**/admin/carpool/plans/plan-1/import", async (route) => { importedCsv = (route.request().postDataJSON() as { csv: string }).csv; await route.fulfill({ status: 201, json: { imported: 1, detail } }); });

  await page.goto("/carpool");
  await page.getByLabel("CSV file").setInputFiles({ name: "synthetic-carpool.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status there,Address,Available seats there,Status back,Comments\nDriver,offer,One,two seats,arranged,\"=SUM(1,1)\"") });
  await expect(page.getByText(/1 of 1 rows previewed.*Required fields are associated and ready/)).toBeVisible(); await page.getByRole("button", { name: "Review mapped data" }).click();
  const seats = page.getByRole("textbox", { name: "Row 2, Available seats there" }); await expect(page.getByText("Original: two seats")).toHaveCount(0); await seats.fill("2"); await expect(page.getByText("Original: two seats")).toBeVisible(); await seats.blur(); await expect(seats).toHaveCount(0); await expect(page.getByRole("button", { name: "Reset corrections" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download corrected CSV" }).click(); const downloaded = await downloadPromise; expect(downloaded.suggestedFilename()).toBe("synthetic-carpool-corrected.csv");
  const stream = await downloaded.createReadStream(); let downloadedCsv = ""; for await (const chunk of stream) downloadedCsv += chunk.toString(); expect(downloadedCsv).toContain("Driver,offer,One,2,arranged"); expect(downloadedCsv).toContain("\"'=SUM(1,1)\"");
  await page.getByRole("button", { name: "Reset corrections" }).click(); await expect(seats).toHaveValue("two seats"); await seats.fill("2"); await seats.blur(); await page.getByRole("button", { name: "Save imported data" }).click();
  await expect(page.getByRole("heading", { name: "Resolve locations once" })).toBeVisible(); expect(importedCsv).toContain("Driver,offer,One,2,arranged"); expect(importedCsv).toContain("=SUM(1,1)");
});

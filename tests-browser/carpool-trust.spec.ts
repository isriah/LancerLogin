import { expect, test, type Page } from "@playwright/test";
import { carpoolSnapshot } from "./module-fixtures";
import { setDashboardTheme } from "./dashboard-theme";
import { pairedViews } from "./paired-views";

function fixture() {
  const plan = { id: "trust", title: "Synthetic competition", destination: "Synthetic venue", meetingId: null, eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0 };
  const people = ["Driver A", "Driver B", "Rider One", "Rider Two"].map((displayName, index) => ({ id: `person-${index}`, memberId: null, memberActive: null, displayName, contact: `person${index}@example.invalid`, outboundSourceStatus: null, outboundStatus: index < 2 ? "offer" : "needs-ride", outboundAddress: `${index + 1} Example St`, outboundLatitude: 40 + index * .001 as number | null, outboundLongitude: -74 as number | null, outboundSeats: index < 2 ? 1 : null, returnSourceStatus: null, returnStatus: "transit", returnAddress: "", returnLatitude: null, returnLongitude: null, returnSeats: null, returnSameAsOutbound: false, notes: "", revision: 0 }));
  return { plan, people, assignments: [{ riderId: "person-2", vehiclePersonId: "person-0", direction: "outbound", distanceMiles: .2, locked: false, manual: false }], unresolved: [{ riderId: "person-3", direction: "outbound", reason: "no-nearby-car", detail: "No eligible car is within 12 miles." }] };
}
async function setup(page: Page, detail: ReturnType<typeof fixture>) {
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#7c3aed", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", route => route.fulfill({ json: carpoolSnapshot() }));
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => route.fulfill({ json: { plans: [detail.plan], members: [], importProfiles: [], geocodingConfigured: false, detail } }));
  await page.goto("/carpool"); await expect(page.getByRole("heading", { name: "Carpool Builder", exact: true })).toBeVisible();
}

test("new event creation reviews existing drafts and keeps them when the switch is declined", async ({ page }) => {
  const saved = fixture(); await setup(page, saved); let created: any; let creations = 0;
  await page.route("**/admin/carpool/plans", async route => { creations++; created = { plan: { id: "created", ...route.request().postDataJSON(), archived: false, revision: 0 }, people: [], assignments: [], unresolved: [] }; await route.fulfill({ status: 201, json: created }); });
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => { const id = new URL(route.request().url()).searchParams.get("planId"); return route.fulfill({ json: { plans: [saved.plan, ...(created ? [created.plan] : [])], members: [], importProfiles: [], geocodingConfigured: false, detail: id === "created" ? created : saved } }); });
  await page.getByRole("button", { name: "Edit Driver A", exact: true }).click(); const editor = page.getByRole("dialog", { name: "Edit Driver A", exact: true }); await editor.getByLabel("Name", { exact: true }).fill("Retained draft"); await editor.getByRole("button", { name: "Close participant editor", exact: true }).click();
  await page.getByRole("button", { name: "New event", exact: true }).click(); await page.getByLabel("Event name", { exact: true }).fill("New reviewed event"); page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "Create event", exact: true }).click(); expect(creations).toBe(0); await expect(page.getByLabel("Saved event")).toHaveValue("trust");
  await page.getByRole("button", { name: "Edit Driver A", exact: true }).click(); await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Retained draft"); await editor.getByRole("button", { name: "Close participant editor", exact: true }).click(); page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "Create event", exact: true }).click(); await expect(page.getByLabel("Saved event")).toHaveValue("created"); expect(creations).toBe(1); await expect(page.getByRole("status")).not.toContainText("Unsaved form changes"); await expect(page.getByRole("button", { name: "Edit Driver A", exact: true })).toHaveCount(0);
});

async function setupClonedEvents(page: Page) {
  const original = fixture(); const events = new Map(["a", "b"].map(id => [id, { ...structuredClone(original), plan: { ...original.plan, id, title: "Event " + id.toUpperCase(), revision: id === "a" ? 1 : 0 }, people: original.people.slice(0, 1).concat(original.people.slice(2, 3)).map((person, index) => ({ ...person, id: index ? "rider" : "driver", displayName: id.toUpperCase() + (index ? " Rider" : " Driver"), outboundSeats: index ? null : 2 })), assignments: [] as any[], unresolved: [] }]));
  await setup(page, events.get("a")! as ReturnType<typeof fixture>);
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => { const id = new URL(route.request().url()).searchParams.get("planId"); return route.fulfill({ json: { plans: [...events.values()].map(value => value.plan), members: [], importProfiles: [], geocodingConfigured: false, detail: id ? events.get(id) ?? null : null } }); });
  await page.reload(); await expect(page.getByLabel("Saved event")).toHaveValue("a"); await page.getByLabel("Saved event").selectOption("b"); await expect(page.getByLabel("Saved event")).toHaveValue("b"); await page.getByRole("button", { name: "Groups", exact: true }).click(); return events;
}

test("a late assignment response cannot replace the event reached with browser Back", async ({ page }) => {
  const events = await setupClonedEvents(page); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/admin/carpool/plans/b/assignments/outbound/rider", async route => { await pending; const event = events.get("b")!; event.plan.revision++; event.assignments = [{ riderId: "rider", vehiclePersonId: "driver", direction: "outbound", distanceMiles: .2, manual: true, locked: false }]; await route.fulfill({ json: event }); });
  await page.getByRole("button", { name: "Assign to car", exact: true }).click(); await page.getByRole("dialog", { name: "Assign B Rider", exact: true }).getByLabel("Destination car").selectOption("driver"); await page.getByRole("dialog", { name: "Assign B Rider", exact: true }).getByRole("button", { name: "Save assignment", exact: true }).click();
  await page.goBack(); await page.goBack(); await expect(page.getByLabel("Saved event")).toHaveValue("a"); release(); await expect(page.getByLabel("Saved event")).toBeEnabled(); await expect(page.locator(".carpool-workspace")).toContainText("A Driver"); await expect(page.locator(".carpool-group-grid")).not.toContainText("B Driver"); await expect(page.getByRole("button", { name: "Undo assignment change", exact: true })).toHaveCount(0);
});

test("deleting an event clears its drafts and undo before opening a copied event", async ({ page }) => {
  const events = await setupClonedEvents(page);
  await page.route("**/admin/carpool/plans/b/assignments/outbound/rider", route => { const event = events.get("b")!; event.plan.revision++; event.assignments = [{ riderId: "rider", vehiclePersonId: "driver", direction: "outbound", distanceMiles: .2, manual: true, locked: false }]; return route.fulfill({ json: event }); });
  await page.route("**/admin/carpool/plans/b", route => { expect(route.request().method()).toBe("DELETE"); events.delete("b"); return route.fulfill({ json: { deleted: true } }); });
  await page.getByRole("button", { name: "Assign to car", exact: true }).click(); await page.getByRole("dialog", { name: "Assign B Rider", exact: true }).getByLabel("Destination car").selectOption("driver"); await page.getByRole("dialog", { name: "Assign B Rider", exact: true }).getByRole("button", { name: "Save assignment", exact: true }).click(); await expect(page.getByRole("button", { name: "Undo assignment change", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "People", exact: true }).click(); await page.getByRole("button", { name: "Edit B Driver", exact: true }).click(); const editor = page.getByRole("dialog", { name: "Edit B Driver", exact: true }); await editor.getByLabel("Name", { exact: true }).fill("Deleted event draft"); await editor.getByRole("button", { name: "Close participant editor", exact: true }).click(); await page.getByRole("button", { name: "Event settings", exact: true }).click(); await page.getByRole("button", { name: "Delete this event", exact: true }).click(); await page.getByRole("button", { name: "Confirm delete event", exact: true }).click();
  await expect(page.getByLabel("Saved event")).toHaveValue("a"); await page.getByRole("button", { name: "Edit A Driver", exact: true }).click(); await expect(page.getByRole("dialog", { name: "Edit A Driver", exact: true }).getByLabel("Name", { exact: true })).toHaveValue("A Driver"); await page.getByRole("button", { name: "Close participant editor", exact: true }).click(); await page.getByRole("button", { name: "Groups", exact: true }).click(); await expect(page.getByRole("button", { name: "Undo assignment change", exact: true })).toHaveCount(0); await expect(page.getByRole("status")).not.toContainText("Unsaved form changes");
});

test("an empty plan supports manual entry and does not claim completed stages", async ({ page }) => {
  const data = fixture(); data.people = []; data.assignments = []; data.unresolved = []; await setup(page, data);
  await expect(page.getByRole("navigation", { name: "Carpool work areas" }).getByRole("button")).toHaveCount(3); await expect(page.getByText("Add participants to start this plan.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Add participant", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add participant", exact: true })).toBeVisible();
});

test("participant drafts survive directions, stage changes, other saves, errors, and conflict review", async ({ page }) => {
  const data = fixture(); await setup(page, data); let fail = true; let saved: Record<string, unknown> | undefined;
  await page.route(/\/admin\/carpool\/plans\/trust\/people\/[^/?]+$/, async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1); const body = route.request().postDataJSON(); saved = body;
    if (id === "person-2" && fail) { await route.fulfill({ status: 409, json: { error: "This plan changed. Refresh the saved plan before applying your changes." } }); return; }
    data.people = data.people.map(person => person.id === id ? { ...person, ...body, revision: person.revision + 1 } : person); data.plan.revision++;
    await route.fulfill({ json: data });
  });

  const edit = async (name: string) => { await page.getByRole("button", { name: "Edit " + name, exact: true }).click(); return page.getByRole("dialog"); };
  let dialog = await edit("Rider One"); await dialog.getByLabel("To event pickup address").fill("Edited address"); await dialog.getByRole("button", { name: "Close participant editor" }).click();
  await page.getByRole("button", { name: "From event", exact: true }).click(); await page.getByRole("button", { name: "To event", exact: true }).click();
  dialog = await edit("Rider One"); await expect(dialog.getByLabel("To event pickup address")).toHaveValue("Edited address"); await dialog.getByRole("button", { name: "Close participant editor" }).click();
  await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByRole("checkbox", { name: "Show map", exact: true }).check(); await page.getByRole("button", { name: "People", exact: true }).click();
  dialog = await edit("Rider Two"); await dialog.getByLabel("To event pickup address").fill("Other edit"); await dialog.getByRole("button", { name: "Save participant", exact: true }).click(); await expect(dialog).toHaveCount(0);
  dialog = await edit("Rider One"); await expect(dialog.getByLabel("To event pickup address")).toHaveValue("Edited address"); await dialog.getByRole("button", { name: "Save participant", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("plan changed"); await expect(dialog.getByLabel("To event pickup address")).toHaveValue("Edited address"); expect(saved).toMatchObject({ outboundLatitude: null, outboundLongitude: null, planRevision: 1 });
  data.people[2] = { ...data.people[2], outboundAddress: "New saved address", revision: 4 }; data.plan.revision++;
  await dialog.getByRole("button", { name: "Refresh saved plan", exact: true }).click(); await expect(dialog).toContainText("New saved address"); await expect(dialog.getByRole("button", { name: "Save participant", exact: true })).toBeDisabled(); await dialog.getByRole("button", { name: "Keep my edits after review" }).click();
  fail = false; await dialog.getByRole("button", { name: "Save participant", exact: true }).click(); await expect(dialog).toHaveCount(0); expect(saved).toMatchObject({ outboundAddress: "Edited address", revision: 4, planRevision: 2 });
  dialog = await edit("Rider One"); await expect(dialog.getByRole("button", { name: "Save participant", exact: true })).toBeDisabled(); await dialog.getByLabel("To event pickup address").fill("Unsaved departure"); await dialog.getByRole("button", { name: "Close participant editor" }).click(); let prompted = false;
  page.once("dialog", async native => { prompted = true; await native.dismiss(); }); await page.getByRole("link", { name: "Roster", exact: true }).click(); expect(prompted).toBe(true); await expect(page).toHaveURL(/\/carpool\/plans\/trust\?area=people&direction=outbound$/);
  dialog = await edit("Rider One"); await expect(dialog.getByLabel("To event pickup address")).toHaveValue("Unsaved departure");

});

test("group previews submit displayed distances and reviewed revision before apply", async ({ page }) => {
  const data = fixture(); await setup(page, data); let body: Record<string, unknown> | undefined; let applied: Record<string, unknown> | undefined;
  await page.route("**/admin/carpool/plans/trust/rebuild/preview", async route => { body = route.request().postDataJSON(); await route.fulfill({ json: { ...body, directions: ["outbound", "return"], previewToken: "reviewed", assignments: data.assignments, unresolved: data.unresolved, changes: [], summary: [] } }); });
  await page.route("**/admin/carpool/plans/trust/rebuild/apply", async route => { applied = route.request().postDataJSON(); await route.fulfill({ json: data }); });
  await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByText("Grouping options", { exact: true }).click(); await page.getByLabel("Maximum radius (miles)").fill("25"); await page.getByLabel("Preferred radius (miles)").fill("6"); await page.getByLabel("Rebuild trips").selectOption("both");
  await page.getByRole("button", { name: "Preview groups", exact: true }).click(); await expect.poll(() => body).toEqual({ direction: "both", planRevision: 0, radiusMiles: 25, preferredRadiusMiles: 6 }); expect(applied).toBeUndefined(); await page.getByRole("button", { name: "Apply proposed groups", exact: true }).click(); expect(applied).toEqual({ direction: "both", planRevision: 0, radiusMiles: 25, preferredRadiusMiles: 6, previewToken: "reviewed" });
});

test("passengers can swap by keyboard and locked assignments cannot be moved", async ({ page }) => {
  const data = fixture(); data.assignments.push({ riderId: "person-3", vehiclePersonId: "person-1", direction: "outbound", distanceMiles: .1, locked: false, manual: false }); data.unresolved = [];
  await setup(page, data); let body: Record<string, unknown> | undefined;
  await page.route("**/admin/carpool/plans/trust/assignments/outbound/person-2", async route => {
    body = route.request().postDataJSON(); if (body!.action === "swap") data.assignments = data.assignments.map(item => ({ ...item, vehiclePersonId: item.riderId === "person-2" ? "person-1" : "person-0" }));
    if (body!.action === "lock") data.assignments = data.assignments.map(item => item.riderId === "person-2" ? { ...item, locked: true } : item);
    data.plan.revision++; await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByRole("checkbox", { name: "Show map", exact: true }).check(); const board = page.locator(".carpool-group-grid:not(.carpool-group-grid--compact)");
  const rider = board.locator(".carpool-rider-card").filter({ hasText: "Rider One" }); await rider.getByRole("button", { name: "Swap", exact: true }).focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Swap Rider One" }); await dialog.getByLabel("Passenger to swap with").selectOption("person-3"); await dialog.getByRole("button", { name: "Swap passengers" }).click();
  await expect(dialog).toHaveCount(0); expect(body).toEqual({ action: "swap", secondRiderId: "person-3", planRevision: 0 });
  await expect(board.locator(".carpool-group").filter({ has: page.getByRole("heading", { name: "Driver B", exact: true }) })).toContainText("Rider One");
  await rider.getByRole("button", { name: "Lock Rider One" }).click(); await expect(rider.getByRole("button", { name: "Move", exact: true })).toBeDisabled(); await expect(rider.getByRole("button", { name: "Swap", exact: true })).toBeDisabled();
});

for (const { theme, width } of pairedViews) test(`assignment chooser supports keyboard, capacity and rendered theme at ${width} ${theme}`, async ({ page }, info) => {
  const data = fixture(); await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await setup(page, data); await setDashboardTheme(page, theme); let body: Record<string, unknown> | undefined;
  await page.route("**/admin/carpool/plans/trust/assignments/outbound/person-3", async route => {
    body = route.request().postDataJSON(); data.assignments.push({ riderId: "person-3", vehiclePersonId: String(body!.vehiclePersonId), direction: "outbound", distanceMiles: .1, locked: false, manual: true }); data.unresolved = []; data.plan.revision++; await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "Groups", exact: true }).click(); await page.getByRole("checkbox", { name: "Show map", exact: true }).check(); const open = page.locator(".carpool-group-exceptions").getByRole("button", { name: "Assign to car" }); await open.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Assign Rider Two" }); await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  const full = dialog.getByRole("option", { name: /Driver A/ }); await expect(full).toHaveJSProperty("disabled", true);
  await dialog.getByLabel("Destination car").selectOption("person-1"); const save = dialog.getByRole("button", { name: "Save assignment" });
  const styles = await save.evaluate(element => { const css = getComputedStyle(element); const app = document.querySelector(".app")!; const expected = document.createElement("span"); expected.style.backgroundColor = "var(--primary)"; app.append(expected); const primary = getComputedStyle(expected).backgroundColor; expected.remove(); return { height: element.getBoundingClientRect().height, background: css.backgroundColor, primary, radius: css.borderRadius }; });
  expect(styles.height).toBeGreaterThanOrEqual(44); expect(styles.background).toBe(styles.primary); expect(styles.radius).not.toBe("0px");
  expect(await save.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
  await save.focus(); await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused(); await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Close assignment editor" })).toBeFocused();
  await page.screenshot({ path: info.outputPath("assignment-chooser.png"), fullPage: true }); await save.focus(); await page.keyboard.press("Enter"); await expect(dialog).toHaveCount(0);
  expect(body).toEqual({ action: "move", vehiclePersonId: "person-1", planRevision: 0 }); await expect(page.locator(".carpool-group-exceptions")).toHaveCount(0);
  await expect(page.locator(".carpool-stage-content")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

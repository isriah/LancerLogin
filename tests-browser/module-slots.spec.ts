import { expect, test, type Page } from "@playwright/test";
import { attendanceSnapshot } from "./module-fixtures";
import { carpoolComposed, carpoolSkipReason, carpoolSnapshot } from "./carpool-fixtures";
import { openActiveMeetingCalendar } from "./meeting-calendar-fixture";
import { pairedViews } from "./paired-views";

const linkPath = "/admin/carpool/meeting-links";

async function fixtures(page: Page, view: (typeof pairedViews)[number], carpool: boolean) {
  await page.setViewportSize(view.viewport); await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), view.theme);
  const modules = carpool ? carpoolSnapshot() : attendanceSnapshot();
  if (carpool) { modules.modules[0] = attendanceSnapshot().modules[0]!; modules.capabilities = [...modules.capabilities, ...modules.modules[0]!.effectiveCapabilities]; }
  await page.route("**/platform/modules", route => route.fulfill({ json: modules }));
  await page.route(`**${linkPath}`, route => route.fulfill({ json: { available: true, links: [{ meetingId: "active-meeting", id: "plan-1", title: "Outbound coordinator" }, { meetingId: "active-meeting", id: "plan-2", title: "Second coordinator" }] } }));
  // L: Carpool meeting links, M: meeting collection, D: one meeting.
  const requests: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() === "GET" && request.resourceType() === "fetch" && (path === linkPath || path === "/meetings" || path.startsWith("/meetings/"))) requests.push(path === linkPath ? "L" : path === "/meetings" ? "M" : "D"); });
  return requests;
}

const count = (requests: readonly string[], kind: string) => requests.filter(item => item === kind).length;

async function moduleRoot(page: Page, selector: string) {
  return page.locator(selector).evaluate(element => { const root = element.closest(".module-root"); return { module: root?.getAttribute("data-module"), display: root ? getComputedStyle(root).display : null, tag: root?.tagName.toLowerCase() }; });
}

// The slot contributor is the Carpool plugin. Without it composed, only the empty-slot case runs.
for (const view of pairedViews) test(`Carpool meeting slots render inside the Carpool module root with one link request per loaded collection at ${view.width} in ${view.theme}`, async ({ page }) => {
  test.skip(!carpoolComposed, carpoolSkipReason);
  const requests = await fixtures(page, view, true);
  await openActiveMeetingCalendar(page);
  await expect(page.locator(".app")).toHaveAttribute("data-theme", view.theme);
  const badge = page.locator(".calendar-selected-record").filter({ hasText: "Build session" }).locator(".carpool-meeting-marker");
  await expect(badge).toHaveAttribute("title", "2 linked carpools");
  await expect(badge).toHaveCSS("display", "inline-flex");
  expect(await moduleRoot(page, ".calendar-selected-record .carpool-meeting-marker")).toEqual({ module: "carpool", display: "contents", tag: "span" });
  await page.waitForLoadState("networkidle");
  // Links load once per loaded meeting collection (plus the development StrictMode mount replay), never once per meeting.
  const calendar = [...requests];
  expect(count(calendar, "L")).toBeGreaterThan(0);
  expect(count(calendar, "L")).toBeLessThanOrEqual(count(calendar, "M") + 2);

  await page.getByRole("radio", { name: "Table", exact: true }).check();
  const directoryBadge = page.locator(".meeting-directory .carpool-meeting-marker").first();
  await expect(directoryBadge).toHaveAttribute("title", "2 linked carpools");
  expect(await moduleRoot(page, ".meeting-directory .carpool-meeting-marker >> nth=0")).toEqual({ module: "carpool", display: "contents", tag: "span" });
  await page.waitForLoadState("networkidle");
  // Every meeting row shows a badge, but the embedded table adds only its own collection request, as its page-level hook did before slots.
  expect(await page.locator(".meeting-directory tbody tr").count()).toBeGreaterThan(2);
  expect(requests.slice(calendar.length).join("")).toMatch(/^L{1,2}$/);

  const beforeDetail = requests.length;
  await page.goto("/meetings/active-meeting");
  const panel = page.getByRole("navigation", { name: "Meeting carpools" });
  await expect(panel.getByRole("link")).toHaveCount(2);
  await page.waitForLoadState("networkidle");
  const detail = requests.slice(beforeDetail);
  expect(count(detail, "L")).toBeLessThanOrEqual(count(detail, "M") + count(detail, "D") + 2);
  expect(await moduleRoot(page, ".carpool-meeting-links")).toEqual({ module: "carpool", display: "contents", tag: "div" });
  await expect(page.locator(".carpool-meeting-links")).toHaveCSS("display", "grid");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("Carpool meeting slots stay empty and load nothing while Carpool is not ready", async ({ page }) => {
  const requests = await fixtures(page, pairedViews[0], false);
  const selectDay = await openActiveMeetingCalendar(page);
  await expect(page.locator(".calendar-selected-record").filter({ hasText: "Build session" })).toBeVisible();
  await page.getByRole("radio", { name: "Table", exact: true }).check();
  await expect(page.locator(".meeting-directory")).toBeVisible();
  await page.getByRole("radio", { name: "Calendar", exact: true }).check(); await selectDay();
  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('[data-module="carpool"]')).toHaveCount(0);
  await expect(page.locator(".carpool-meeting-marker, .carpool-meeting-links")).toHaveCount(0);
  expect(count(requests, "L")).toBe(0);
});

test("Carpool pages render inside the Carpool module root with scoped styles", async ({ page }) => {
  test.skip(!carpoolComposed, carpoolSkipReason);
  await fixtures(page, pairedViews[0], true);
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => route.fulfill({ json: { plans: [], members: [], importProfiles: [], geocodingConfigured: false, meetingChoices: [], meetingReferencesAvailable: true, relatedMeeting: null, detail: null } }));
  await page.route("**/admin/carpool/settings", route => route.fulfill({ json: { radiusMiles: 12, preferredRadiusMiles: 4, revision: 0, geocodingConfigured: false, canSaveApiKey: true } }));
  await page.goto("/carpool");
  await expect(page.locator(".carpool-workspace")).toHaveCSS("display", "grid");
  expect(await moduleRoot(page, ".carpool-workspace")).toEqual({ module: "carpool", display: "contents", tag: "div" });
  await page.goto("/settings/carpool");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await moduleRoot(page, "#carpool-settings-title")).toEqual({ module: "carpool", display: "contents", tag: "div" });
  await page.goto("/settings/organization");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('[data-module="carpool"]')).toHaveCount(0);
});

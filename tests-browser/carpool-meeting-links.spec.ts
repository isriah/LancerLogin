import { expect, test, type Page } from "@playwright/test";
import { attendanceSnapshot } from "./module-fixtures";
import { carpoolSnapshot, requireCarpoolPlugin } from "./carpool-fixtures";
import { setDashboardTheme } from "./dashboard-theme";
import { openActiveMeetingCalendar } from "./meeting-calendar-fixture";

requireCarpoolPlugin();

const meeting = { id: "active-meeting", title: "Build session", startsAt: "2026-10-10T15:00:00Z", endsAt: "2026-10-10T17:00:00Z" };
function plan(id: string, title: string) { return { id, title, meetingId: meeting.id as string | null, destination: "Synthetic venue", eventReference: null, eventTitleSnapshot: null, eventStartsAtSnapshot: null, radiusMiles: 12, preferredRadiusMiles: 4, notes: "", archived: false, revision: 0, createdAt: "2026-10-10", updatedAt: "2026-10-10" }; }
async function fixtures(page: Page, appearance: "light" | "dark", attendance = true) {
  const plans = [plan("plan-1", "Outbound coordinator"), plan("plan-2", "Second coordinator")]; let saved: Record<string, unknown> | null = null;
  const modules = carpoolSnapshot();
  if (attendance) { modules.modules[0] = attendanceSnapshot().modules[0]!; modules.capabilities = [...modules.capabilities, ...modules.modules[0]!.effectiveCapabilities]; }
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Team", subtitle: "Review", logoData: null, primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance, logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/platform/modules", route => route.fulfill({ json: modules }));
  await page.route("**/admin/carpool/meeting-links", route => route.fulfill({ json: { available: attendance, links: attendance ? plans.filter(item => item.meetingId).map(item => ({ meetingId: item.meetingId, id: item.id, title: item.title })) : [] } }));
  const detail = (id: string) => ({ plan: plans.find(item => item.id === id)!, people: [], assignments: [], unresolved: [] });
  await page.route(/\/admin\/carpool\/context(?:\?.*)?$/, route => { const id = new URL(route.request().url()).searchParams.get("planId"); const selected = id ? detail(id) : null; return route.fulfill({ json: { plans, members: [], importProfiles: [], geocodingConfigured: false, meetingChoices: attendance ? [meeting] : [], meetingReferencesAvailable: attendance, relatedMeeting: attendance && selected?.plan.meetingId ? meeting : null, detail: selected } }); });
  await page.route(/\/admin\/carpool\/plans\/plan-[12]$/, async route => { saved = route.request().postDataJSON(); const item = plans.find(value => value.id === new URL(route.request().url()).pathname.split("/").at(-1))!; item.meetingId = saved!.meetingId as string | null; item.revision += 1; await route.fulfill({ json: detail(item.id) }); });
  return { saved: () => saved };
}

for (const scenario of [{ width: 1280, height: 900, appearance: "light" }, { width: 390, height: 844, appearance: "dark" }] as const) test(`Carpool meeting selector and quicklink use the global theme at ${scenario.width}`, async ({ page }, testInfo) => {
  await page.setViewportSize(scenario); await page.emulateMedia({ reducedMotion: "reduce" }); const state = await fixtures(page, scenario.appearance);
  await page.goto("/carpool/plans/plan-2");
  await setDashboardTheme(page, scenario.appearance);
  await expect(page.locator(".app")).toHaveAttribute("data-theme", scenario.appearance);
  await expect(page.getByLabel("Saved event")).toHaveValue("plan-2");
  const quicklink = page.getByRole("link", { name: "Open meeting: Build session" }); await expect(quicklink).toHaveAttribute("href", "/meetings/active-meeting");
  const linkStyle = await quicklink.evaluate(element => { const style = getComputedStyle(element); return { height: element.getBoundingClientRect().height, border: style.borderTopStyle, background: style.backgroundColor, color: style.color }; }); expect(linkStyle.height).toBeGreaterThanOrEqual(44); expect(linkStyle.border).toBe("solid"); expect(linkStyle.background).not.toBe("rgba(0, 0, 0, 0)"); expect(linkStyle.color).not.toBe(linkStyle.background);
  await page.getByRole("button", { name: "Event settings", exact: true }).click();
  const selector = page.getByLabel(/Associated meeting/); await expect(selector).toHaveValue("active-meeting");
  await selector.focus(); await expect(selector).toBeFocused();
  const styles = await selector.evaluate(element => { const style = getComputedStyle(element); const label = getComputedStyle(element.closest("label")!); return { height: element.getBoundingClientRect().height, fontSize: style.fontSize, labelSize: label.fontSize, body: getComputedStyle(document.documentElement).fontSize, background: style.backgroundColor, color: style.color, outline: style.outlineStyle, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }; });
  expect(styles.height).toBeGreaterThanOrEqual(44); expect(styles.fontSize).toBe(styles.body); expect(styles.labelSize).toBe(styles.body); expect(styles.background).not.toBe("rgba(0, 0, 0, 0)"); expect(styles.color).not.toBe(styles.background); expect(styles.outline).not.toBe("none"); expect(styles.overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("meeting-selector.png"), fullPage: true });
  await selector.selectOption(""); await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(state.saved).toMatchObject({ meetingId: null });
  await expect(quicklink).toHaveCount(0);
  await page.getByLabel("Saved event").selectOption("plan-1"); await expect(page).toHaveURL(/\/carpool\/plans\/plan-1$/);
  await page.goBack(); await expect(page.getByLabel("Saved event")).toHaveValue("plan-2");
  await page.getByRole("button", { name: "Import CSV", exact: true }).click(); await page.getByLabel("CSV file").setInputFiles({ name: "synthetic-deep-link.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Status there,Address,Available seats there,Status back\nDriver,offer,One,2,arranged") });
  await page.getByRole("button", { name: "Review mapped data" }).click();
  const saveImport = page.getByRole("button", { name: "Preview import changes" }); await expect(saveImport).toBeEnabled();
  await page.getByRole("button", { name: "Event settings", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(saveImport).toBeEnabled(); await expect(page.getByText("All 1 rows are ready to import.")).toBeVisible();
  await expect(page).toHaveURL(/\/carpool\/plans\/plan-2$/);
});

test("Meetings show inline car icons and multiple Carpool links with stable bidirectional routes", async ({ page }) => {
  await fixtures(page, "light");
  await openActiveMeetingCalendar(page);
  const calendarMeeting = page.locator(".calendar-selected-record").filter({ hasText: "Build session" }); await expect(calendarMeeting.locator(".carpool-meeting-marker")).toHaveAttribute("title", "2 linked carpools");
  const marker = calendarMeeting.locator(".carpool-meeting-marker");
  await expect(marker).toHaveCSS("display", "inline-flex");
  // Re-resolve the live marker after asynchronous meeting-link renders.
  await expect.poll(() => marker.locator("svg").evaluate(element => element.isConnected ? element.getBoundingClientRect().height : 0)).toBeGreaterThan(15);
  await calendarMeeting.getByRole("button", { name: "Open meeting Build session", exact: true }).click();
  const links = page.getByRole("navigation", { name: "Meeting carpools" }); await expect(links.getByRole("link")).toHaveCount(2);
  await links.getByRole("link", { name: /Second coordinator/ }).click(); await expect(page).toHaveURL(/\/carpool\/plans\/plan-2$/); await expect(page.getByLabel("Saved event")).toHaveValue("plan-2");
  await page.getByRole("link", { name: "Open meeting: Build session" }).click(); await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await page.goto("/dashboard"); await page.getByRole("radio", { name: "Table", exact: true }).check();
  await expect(page.locator(".meeting-directory .carpool-meeting-marker").first()).toHaveAttribute("title", "2 linked carpools");
});

test("An unavailable meeting does not leak its title and can be unlinked with Attendance off", async ({ page }) => {
  const state = await fixtures(page, "dark", false);
  await page.goto("/carpool/plans/plan-1"); await expect(page.getByRole("link", { name: /Open meeting:/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Event settings", exact: true }).click();
  const selector = page.getByLabel(/Associated meeting/); await expect(selector.locator("option")).toHaveCount(2);
  await expect(selector.locator("option:checked")).toHaveText("Linked meeting unavailable");
  expect(await page.locator("body").textContent()).not.toContain("Build session");
  expect(await selector.innerHTML()).not.toContain("Build session");
  await selector.selectOption(""); await page.getByRole("button", { name: "Save settings", exact: true }).click(); await expect.poll(state.saved).toMatchObject({ meetingId: null });
  await page.getByRole("button", { name: "New event", exact: true }).click(); await expect(page.getByLabel(/Associated meeting/)).toHaveCount(0);
});

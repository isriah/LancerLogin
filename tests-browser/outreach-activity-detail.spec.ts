import { expect, test, type Page } from "@playwright/test";
import { outreachSnapshot } from "./module-fixtures";

const activity = { id: "synthetic-event", mode: "event", labelIds: [], labels: [], serviceDate: "2026-10-09", teamId: null, title: "Synthetic Outreach event", description: "Service at the library", location: "Library", impactRelevant: true, archived: false, revision: 0, eventStartLocal: "09:00", eventEndLocal: "12:00", eventStartOccurrence: null, eventEndOccurrence: null };
const entry = (id: string, durationMinutes: number, status = "counted") => ({ id, memberId: "member-1", activityId: activity.id, revision: 2, status, memberName: "Avery Synthetic", externalId: "SYN-001", activityTitle: activity.title, teamName: null, serviceDate: activity.serviceDate, startLocal: "09:00", endLocal: "10:00", timeZone: "America/Los_Angeles", durationMinutes, taskNotes: "Sorted donated supplies", staffReason: null, attribution: "self_asserted" });

async function fixture(page: Page, state: { failPage?: boolean; corrections?: Record<string, unknown>[]; requests?: string[]; candidateWrites?: Record<string, unknown>[]; edits?: Record<string, unknown>[] } = {}) {
  let currentActivity = { ...activity };
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot() }));
  await page.route("**/auth/walkthroughs/*", (route) => route.fulfill({ json: { progress: { pageId: "outreach", version: 1, status: "completed", stepId: null } } }));
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Robotics", subtitle: "Member services", logoData: "", primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "light", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 } } }));
  await page.route(/\/admin\/hours(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path === "/admin/hours/activities") return route.fulfill({ json: { items: [currentActivity], nextCursor: null } });
    if (path === `/admin/hours/activities/${activity.id}` && route.request().method() === "PATCH") { const body = route.request().postDataJSON(); state.edits?.push(body); currentActivity = { ...currentActivity, ...body, revision: currentActivity.revision + 1 }; return route.fulfill({ json: currentActivity }); }
    if (path === "/admin/hours/teams") return route.fulfill({ json: { items: [{ id: "team-1", name: "Synthetic FTC", program: "FTC", archived: false }], nextCursor: null } });
    if (path === "/admin/hours/member-choices") return route.fulfill({ json: { items: [{ id: "member-1", label: "Avery Synthetic", externalId: "SYN-001", active: true }], nextCursor: null } });
    if (path === "/admin/hours/publication-providers") return route.fulfill({ json: { google_calendar: false, discord: false } });
    if (path === "/admin/hours/context") return route.fulfill({ json: { reportingDays: 30, reopenHours: 24, revision: 0, timeZone: "America/New_York", today: "2026-10-10" } });
    if (path === "/admin/hours/entries") {
      if (!url.searchParams.has("activityId")) return route.fulfill({ json: { items: [entry("unrelated-entry", 600)], nextCursor: null } });
      state.requests?.push(url.search);
      if (url.searchParams.has("after")) return state.failPage ? route.fulfill({ status: 503, json: { error: "Temporary connection error" } }) : route.fulfill({ json: { items: [entry("entry-2", 90), entry("entry-3", 60, "void")], nextCursor: null } });
      return route.fulfill({ json: { items: [entry("entry-1", 60)], nextCursor: "entry-1" } });
    }
    if (path === "/admin/hours/corrections") return route.fulfill({ json: { items: state.corrections ?? [], nextCursor: null } });
    if (path === "/admin/hours/corrections/correction-1/entries") return route.fulfill({ json: { items: [entry("entry-1", 60), entry("entry-2", 90)], nextCursor: null } });
    if (path === "/admin/hours/corrections/correction-1/resolve") { state.candidateWrites?.push(route.request().postDataJSON()); state.corrections = []; return route.fulfill({ json: { status: "resolved" } }); }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
}

for (const view of [{ width: 1280, height: 900, theme: "light" }, { width: 390, height: 844, theme: "dark" }]) test(`Outreach detail presents complete grouped hours with themed controls at ${view.width}`, async ({ page }) => {
  await page.setViewportSize(view); await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), view.theme);
  const requests: string[] = []; await fixture(page, { requests }); await page.goto("/hours");
  await page.getByRole("combobox", { name: "Activity", exact: true }).selectOption(activity.id);
  await expect(page.getByRole("heading", { level: 1, name: activity.title })).toBeVisible(); await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/hours/activities/${activity.id}$`));
  await expect(page.getByRole("button", { name: "Create activity" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Outreach activity detail navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to Activities", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Switch activity", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submission Log", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close activity", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Refresh participation", exact: true })).toHaveCount(0);
  await expect(page.locator(".outreach-participation-card").getByRole("button", { name: "Add member participation" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Activity participation" })).toContainText("2.50");
  await expect(page.getByText("2.50 hours total", { exact: true })).toBeVisible();
  const cardPadding = await page.locator(".outreach-participation-card").evaluate((element) => { const probe = document.createElement("span"); probe.style.padding = "var(--card-padding)"; element.append(probe); const actual = getComputedStyle(element).paddingLeft; const expected = getComputedStyle(probe).paddingLeft; probe.remove(); return { actual, expected }; });
  expect(parseFloat(cardPadding.actual)).toBeGreaterThan(0); expect(cardPadding.actual).toBe(cardPadding.expected);
  expect(new Set(requests).size).toBe(2); expect(requests.at(-1)).toContain("activityId=synthetic-event"); expect(requests.at(-1)).toContain("status=all"); expect(requests.at(-1)).toContain("after=entry-1");
  const expand = page.getByRole("button", { name: /(?:Details|Hide details) for Avery Synthetic/ }); await expand.focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Deleted - excluded from totals")).toBeVisible(); await expect(page.getByText(/Public form submission - Revision/)).toHaveCount(3); await expect(page.getByText(/Revision 2 - America\/Los_Angeles/)).toHaveCount(3);
  const appearance = await expand.evaluate((element) => { const style = getComputedStyle(element); const app = element.closest(".app")!; const probe = document.createElement("span"); app.append(probe); const color = (token: string) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; }; const result = { background: style.backgroundColor, surface: color("--ui-surface-subtle"), border: style.borderTopColor, borderToken: color("--ui-border"), text: style.color, textToken: color("--ui-text"), height: element.getBoundingClientRect().height, radius: parseFloat(style.borderRadius), outline: style.outlineStyle }; probe.remove(); return result; });
  expect(appearance.background).toBe(appearance.surface); expect(appearance.text).toBe(appearance.textToken); expect(appearance.height).toBeGreaterThanOrEqual(44); expect(appearance.radius).toBeGreaterThan(0); expect(appearance.outline).toBe("solid");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("outreach-detail.png"), fullPage: false });
  await page.reload(); await expect(page.getByRole("heading", { level: 1, name: activity.title })).toBeVisible();
  await expect(page.getByText("2.50 hours total", { exact: true })).toBeVisible();
  await page.goBack(); await expect(page).toHaveURL(/\/hours$/); await page.getByRole("button", { name: "Create activity" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Outreach activity" }); const labels = await dialog.locator('form > label:not(.checkbox-field), .outreach-fieldset > legend').evaluateAll((elements) => elements.map((element) => ({ font: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize, weight: getComputedStyle(element).fontWeight })));
  const bodySize = await dialog.evaluate((element) => { const probe = document.createElement("span"); probe.style.fontSize = "var(--text-body)"; element.append(probe); const size = getComputedStyle(probe).fontSize; probe.remove(); return size; });
  expect(labels.length).toBeGreaterThanOrEqual(6); for (const label of labels) { expect(label.font).toContain("Roboto"); expect(label.size).toBe(bodySize); expect(label.weight).toBe("750"); }
  await expect(dialog.getByLabel("Set event times")).toHaveCount(0); await expect(dialog.getByLabel("Event start time", { exact: true })).toHaveValue(""); await page.keyboard.press("Escape");
  await page.locator(".outreach-activity-visibility > summary").click(); const menu = page.getByRole("group", { name: "Show activity types" }); await expect(menu.locator("legend")).toHaveClass("visually-hidden");
  const menuLayout = await menu.evaluate((element) => { const style = getComputedStyle(element); return { height: element.getBoundingClientRect().height, rows: [...element.querySelectorAll("label")].reduce((height, label) => height + label.getBoundingClientRect().height, 0), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) }; });
  expect(menuLayout.height).toBeLessThanOrEqual(menuLayout.rows + menuLayout.padding + 1);
  await page.screenshot({ path: test.info().outputPath("outreach-visibility.png"), fullPage: false });
});

test("failed participation paging hides incomplete totals and can be refreshed", async ({ page }) => {
  const state = { failPage: true }; await fixture(page, state); await page.goto("/hours"); await page.getByRole("combobox", { name: "Activity", exact: true }).selectOption(activity.id);
  await expect(page.getByRole("alert")).toContainText("Totals are unavailable until every page loads"); await expect(page.getByRole("table", { name: "Activity participation" })).toHaveCount(0);
  state.failPage = false; await page.reload(); await expect(page.getByText("2.50 hours total", { exact: true })).toBeVisible();
});

test("Staff selects the affected submission for an event-only correction", async ({ page }) => {
  const writes: Record<string, unknown>[] = []; const state = { corrections: [{ id: "correction-1", activityId: activity.id, channel: "public", memberName: "Avery Synthetic", externalId: "SYN-001", entryId: null, entryRevision: null, entryStatus: null, entryMemberId: null, entryActivityId: null, startLocal: null, endLocal: null, status: "open", revision: 0, activityTitle: activity.title, message: "The second submission ended at 10:30.", createdAt: "2026-10-10T12:00:00Z" }], candidateWrites: writes }; await fixture(page, state); await page.goto("/hours");
  await page.getByRole("button", { name: /Corrections 1/ }).click(); await page.getByRole("button", { name: "Review in activity" }).click();
  await page.getByLabel("Participation entry to correct").selectOption("entry-2"); await expect(page.getByLabel("Decision")).toHaveValue("corrected"); await expect(page.getByRole("combobox", { name: "Member", exact: true })).toBeDisabled();
  await page.getByLabel("Staff review note").fill("Verified the second submission with the activity lead."); await page.getByRole("button", { name: "Resolve correction" }).click();
  await expect(page.getByText("Correction applied as one immutable entry revision.")).toBeVisible(); expect(writes[0]).toMatchObject({ entryId: "entry-2", entryRevision: 2, memberId: "member-1", activityId: activity.id, action: "corrected" });
});

for (const view of ["light", "dark"].flatMap(theme => [{ width: 1280, height: 900, theme }, { width: 390, height: 844, theme }])) test(`Outreach activity edits all event details and retains logged hours at ${view.width} in ${view.theme}`, async ({ page }) => {
  await page.setViewportSize(view); await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), view.theme); const edits: Record<string, unknown>[] = []; await fixture(page, { edits }); await page.goto(`/hours/activities/${activity.id}`);
  await page.getByRole("button", { name: "Edit activity", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Edit Outreach activity" });
  await expect(dialog.getByLabel("Activity title")).toBeFocused(); await dialog.getByLabel("Activity title").fill("Updated library event"); await dialog.getByLabel("Service date").fill("2026-10-08");
  await dialog.getByLabel("Description", { exact: true }).fill("Updated description"); await dialog.getByLabel("Location", { exact: true }).fill("New location"); await dialog.getByLabel("Impact relevant").uncheck();
  await page.screenshot({ path: test.info().outputPath("outreach-edit.png"), fullPage: false });
  await dialog.getByRole("button", { name: "Save activity", exact: true }).click(); await expect(page.getByRole("heading", { level: 1, name: "Updated library event" })).toBeVisible();
  expect(edits[0]).toMatchObject({ revision: 0, title: "Updated library event", serviceDate: "2026-10-08", description: "Updated description", location: "New location", impactRelevant: false, archived: false, eventStartLocal: "09:00", eventEndLocal: "12:00", labelIds: [] });
  await expect(page.getByText("2.50 hours total", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit activity", exact: true }).click(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "Edit activity", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("staff can change activity type and choose the required supported team", async ({ page }) => {
  const edits: Record<string, unknown>[] = []; await fixture(page, { edits }); await page.goto(`/hours/activities/${activity.id}`);
  await page.getByRole("button", { name: "Edit activity", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Edit Outreach activity" });
  await dialog.getByRole("combobox", { name: "Activity type", exact: true }).selectOption("team"); const team = dialog.getByRole("combobox", { name: "Supported team", exact: true }); await expect(team).toHaveAttribute("required", "");
  await team.selectOption("team-1"); await dialog.getByRole("button", { name: "Save activity", exact: true }).click(); await expect(dialog).toHaveCount(0); expect(edits[0]).toMatchObject({ mode: "team", teamId: "team-1", eventStartLocal: null, eventEndLocal: null });
  await expect(page.getByText("2.50 hours total", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Edit activity", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Activity type", exact: true }).selectOption("task"); await expect(dialog.getByRole("combobox", { name: "Supported team", exact: true })).toHaveCount(0); await dialog.getByRole("button", { name: "Save activity", exact: true }).click(); expect(edits[1]).toMatchObject({ mode: "task", teamId: null });
});

// The Create Outreach activity dialog: Tab order inside its event time fields and the condensed label picker.
import { expect, test, type Page } from "@playwright/test";
import { outreachSnapshot } from "./module-fixtures";
import { requireOutreachPlugin } from "./outreach-fixtures";
import { mockSetupStatus } from "./api-fixtures";

requireOutreachPlugin();

const labels = ["Community", "STEM night", "Fundraising", "School visit", "Mentoring", "Demo", "Summer camp", "Sponsor event"].map((name, index) => ({ id: `label-${index}`, name, archived: false, revision: 0 }));

async function fixture(page: Page, theme: string, posts: Record<string, unknown>[] = []) {
  await page.addInitScript((value) => localStorage.setItem("lancerlogin-theme", value), theme);
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot() }));
  await page.route("**/auth/walkthroughs/*", (route) => route.fulfill({ json: { progress: { pageId: "outreach", version: 1, status: "completed", stepId: null } } }));
  await mockSetupStatus(page, { settings: { organizationName: "Synthetic Robotics", subtitle: "Member services", logoData: "", primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: theme, logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 } });
  await page.route(/\/admin\/hours(?:\/.*)?(?:\?.*)?$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/hours/activities" && route.request().method() === "POST") { posts.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); }
    if (path === "/admin/hours/labels") return route.fulfill({ json: { items: labels, nextCursor: null } });
    if (path === "/admin/hours/publication-providers") return route.fulfill({ json: { google_calendar: false, discord: false } });
    if (path === "/admin/hours/context") return route.fulfill({ json: { reportingDays: 30, reopenHours: 24, revision: 0, timeZone: "America/New_York", today: "2026-10-10" } });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/hours"); await page.getByRole("button", { name: "Create activity", exact: true }).click();
  return page.getByRole("dialog", { name: "Create Outreach activity" });
}

// A time field's segments and picker button live inside the input, so the page's active element is the input for all of
// them. The accessibility tree names the one that has focus: "Hours", "Minutes", "AM/PM" or "Show time picker".
async function focusedPart(page: Page) {
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send("Accessibility.getFullAXTree"); await client.detach();
  const focused = nodes.filter((node) => node.properties?.some((property) => property.name === "focused" && property.value.value === true)).at(-1);
  const part = /Hours|Minutes|AM\/PM|Show time picker/.exec(String(focused?.name?.value ?? ""))?.[0] ?? String(focused?.role?.value ?? "none");
  const field = await page.evaluate(() => document.activeElement?.closest("label")?.textContent?.trim() ?? document.activeElement?.tagName ?? "");
  return `${field}: ${part}`;
}

test("Tab walks an event time field's hour, minutes, AM/PM and picker button in order, typed or not", async ({ page }) => {
  const posts: Record<string, unknown>[] = []; const dialog = await fixture(page, "dark", posts);
  const start = dialog.getByLabel("Event start time", { exact: true }); const end = dialog.getByLabel("Event end time", { exact: true });
  const press = async (key: string, expected: string) => { await page.keyboard.press(key); expect(await focusedPart(page), `after ${key}`).toBe(expected); };
  await dialog.getByLabel("Activity title", { exact: true }).fill("Synthetic service day");
  // Typing 9 completes the hour and the field moves to the minutes by itself; the Tab that follows must stay there.
  await press("Tab", "Event start time: Hours"); await press("9", "Event start time: Minutes"); await press("Tab", "Event start time: Minutes");
  await press("3", "Event start time: Minutes"); await press("0", "Event start time: AM/PM"); await press("Tab", "Event start time: AM/PM");
  await press("p", "Event start time: AM/PM"); await expect(start).toHaveValue("21:30");
  // The picker button comes after AM/PM, stays reachable by keyboard and is named for screen readers.
  await press("Tab", "Event start time: Show time picker"); await press("Tab", "Event end time: Hours");
  await press("1", "Event end time: Hours"); await press("1", "Event end time: Minutes"); await press("Tab", "Event end time: Minutes");
  await press("1", "Event end time: Minutes"); await press("5", "Event end time: AM/PM"); await press("Tab", "Event end time: AM/PM"); await press("a", "Event end time: AM/PM");
  await expect(end).toHaveValue("11:15");
  // Shift+Tab reverses the order, and the arrow keys still step the focused segment.
  await press("Shift+Tab", "Event end time: Minutes"); await press("Shift+Tab", "Event end time: Hours"); await press("Shift+Tab", "Event start time: Show time picker");
  await press("Shift+Tab", "Event start time: AM/PM"); await press("Shift+Tab", "Event start time: Minutes"); await press("ArrowUp", "Event start time: Minutes"); await expect(start).toHaveValue("21:35");
  await press("Shift+Tab", "Event start time: Hours"); await press("Shift+Tab", "Activity title: textbox");
  await dialog.getByRole("button", { name: "Create activity", exact: true }).click();
  await expect.poll(() => posts.length).toBe(1); expect(posts[0]).toMatchObject({ title: "Synthetic service day", eventStartLocal: "21:35", eventEndLocal: "11:15", eventStartOccurrence: null, eventEndOccurrence: null });
});

test("Tab moves on from a time segment that typing left open or untouched", async ({ page }) => {
  const dialog = await fixture(page, "light");
  const press = async (key: string, expected: string) => { await page.keyboard.press(key); expect(await focusedPart(page), `after ${key}`).toBe(expected); };
  await dialog.getByLabel("Activity title", { exact: true }).focus();
  // 1 could still become 10, 11 or 12 and 3 could become 30 to 39, so the field waits and Tab does the moving.
  await press("Tab", "Event start time: Hours"); await press("1", "Event start time: Hours"); await press("Tab", "Event start time: Minutes");
  await press("3", "Event start time: Minutes"); await press("Tab", "Event start time: AM/PM"); await press("Tab", "Event start time: Show time picker");
  await press("Tab", "Event end time: Hours"); await press("Tab", "Event end time: Minutes"); await press("Tab", "Event end time: AM/PM"); await press("Tab", "Event end time: Show time picker");
  await press("Tab", "Description: textbox");
  // After a click on the hour, a completing digit followed by Tab stays on the minutes too.
  const box = (await dialog.getByLabel("Event end time", { exact: true }).boundingBox())!; await page.mouse.click(box.x + 18, box.y + box.height / 2);
  expect(await focusedPart(page)).toBe("Event end time: Hours"); await press("7", "Event end time: Minutes"); await press("Tab", "Event end time: Minutes");
  await press("4", "Event end time: Minutes"); await press("5", "Event end time: AM/PM"); await press("Tab", "Event end time: AM/PM"); await press("p", "Event end time: AM/PM");
  await expect(dialog.getByLabel("Event end time", { exact: true })).toHaveValue("19:45");
});

for (const view of [{ width: 1280, height: 900, theme: "dark" }, { width: 375, height: 812, theme: "light" }]) test(`Outreach label choices wrap into compact columns at ${view.width}`, async ({ page }) => {
  await page.setViewportSize(view); const dialog = await fixture(page, view.theme);
  const group = dialog.getByRole("group", { name: "Outreach labels (optional)" }); await expect(group.getByRole("checkbox")).toHaveCount(labels.length);
  await group.getByText("STEM night", { exact: true }).click(); await expect(group.getByRole("checkbox", { name: "STEM night" })).toBeChecked();
  const layout = await group.evaluate((element) => {
    const legend = element.querySelector("legend")!; const rows = [...element.querySelectorAll("label")].map((label) => label.getBoundingClientRect());
    const tops = [...new Set(rows.map((row) => Math.round(row.top)))];
    return { height: element.getBoundingClientRect().height, legend: legend.getBoundingClientRect().height + parseFloat(getComputedStyle(legend).marginBottom), rowHeights: rows.map((row) => row.height), lines: tops.length, inside: rows.every((row) => row.left >= element.getBoundingClientRect().left - 1 && row.right <= element.getBoundingClientRect().right + 1) };
  });
  // Every choice keeps the 44px touch target, several share a line, and lines stack with no gap or margin between them.
  for (const height of layout.rowHeights) expect(height).toBeGreaterThanOrEqual(44);
  expect(layout.lines).toBeLessThanOrEqual(view.width > 800 ? 2 : 4); expect(layout.inside).toBe(true);
  expect(layout.height).toBeLessThanOrEqual(layout.legend + layout.lines * Math.max(...layout.rowHeights) + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await group.screenshot({ path: test.info().outputPath("outreach-label-picker.png") });
});

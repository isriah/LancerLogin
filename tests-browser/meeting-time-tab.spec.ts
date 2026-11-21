// Tab order inside the meeting form's date and time fields (use-time-field-tab.ts).
import { expect, test, type Page } from "@playwright/test";

// A date or time field's segments and picker button live inside the input, so the page's active element is the input for
// all of them. The accessibility tree names the one that has focus: "Month", "Day", "Year", "Hours", "Minutes", "AM/PM"
// or the picker button, "Show date picker" or "Show time picker". A date field without a name for it reports its role.
async function focusedPart(page: Page) {
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send("Accessibility.getFullAXTree"); await client.detach();
  const focused = nodes.filter((node) => node.properties?.some((property) => property.name === "focused" && property.value.value === true)).at(-1);
  const part = /Month|Day|Year|Hours|Minutes|AM\/PM|Show \w+ picker/.exec(String(focused?.name?.value ?? ""))?.[0] ?? String(focused?.role?.value ?? "none");
  const field = await page.evaluate(() => document.activeElement?.closest("label")?.firstChild?.textContent?.trim() ?? document.activeElement?.tagName ?? "");
  return `${field}: ${part}`;
}

async function createDialog(page: Page, posts: Record<string, unknown>[] = []) {
  // A fixed day; the times typed below keep the meeting on it.
  await page.clock.setFixedTime(new Date("2026-10-20T12:00:00.000Z"));
  await page.route("**/meetings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, unknown>; posts.push(body);
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ meeting: { id: "synthetic-tab-order", ...body }, meetings: [{ id: "synthetic-tab-order", ...body }] }) });
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Add meeting" }).click();
  const dialog = page.getByRole("dialog", { name: "Create meeting" });
  await expect(dialog).toBeVisible();
  const press = async (key: string, expected: string) => { await page.keyboard.press(key); expect(await focusedPart(page), `after ${key}`).toBe(expected); };
  return { dialog, press };
}

test("Tab walks the meeting time fields' hour, minutes, AM/PM and picker button in order, and saves what was typed", async ({ page }) => {
  const posts: Record<string, unknown>[] = []; const { dialog, press } = await createDialog(page, posts);
  const start = dialog.getByLabel("Start time", { exact: true }); const end = dialog.getByLabel("End time", { exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill("Test meeting tab order");
  // Keyboard focus reaches Start time from End date's last part, its picker button.
  await dialog.getByLabel("End date", { exact: true }).focus();
  await press("Tab", "End date: Day"); await press("Tab", "End date: Year"); await press("Tab", "End date: Show date picker");
  // Typing 9 completes the hour and the field moves to the minutes by itself; the Tab that follows must stay there.
  await press("Tab", "Start time: Hours"); await press("9", "Start time: Minutes"); await press("Tab", "Start time: Minutes");
  await press("3", "Start time: Minutes"); await press("0", "Start time: AM/PM"); await press("Tab", "Start time: AM/PM");
  await press("a", "Start time: AM/PM"); await expect(start).toHaveValue("09:30");
  await press("Tab", "Start time: Show time picker"); await press("Tab", "End time: Hours");
  await press("1", "End time: Hours"); await press("1", "End time: Minutes"); await press("Tab", "End time: Minutes");
  await press("1", "End time: Minutes"); await press("5", "End time: AM/PM"); await press("Tab", "End time: AM/PM"); await press("a", "End time: AM/PM");
  await expect(end).toHaveValue("11:15");
  await press("Tab", "End time: Show time picker"); await press("Tab", "Notes (optional): textbox");
  // Shift+Tab reverses the order, and the arrow keys still step the focused segment.
  await press("Shift+Tab", "End time: Show time picker"); await press("Shift+Tab", "End time: AM/PM"); await press("Shift+Tab", "End time: Minutes");
  await press("ArrowUp", "End time: Minutes"); await expect(end).toHaveValue("11:16");
  await press("Shift+Tab", "End time: Hours"); await press("Shift+Tab", "Start time: Show time picker"); await press("Shift+Tab", "Start time: AM/PM");
  await press("Shift+Tab", "Start time: Minutes"); await press("Shift+Tab", "Start time: Hours"); await press("Shift+Tab", "End date: Show date picker");
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("2026-10-20"); await expect(dialog.getByLabel("End date", { exact: true })).toHaveValue("2026-10-20");
  await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  // The specs run in UTC, so the local times typed are the saved UTC times.
  expect(posts[0]).toMatchObject({ title: "Test meeting tab order", date: "2026-10-20", endDate: "2026-10-20", startTime: "09:30", endTime: "11:16", startsAt: "2026-10-20T09:30:00.000Z", endsAt: "2026-10-20T11:16:00.000Z" });
});

test("Tab moves on from a meeting time segment that typing left open or untouched, and after a click", async ({ page }) => {
  const { dialog, press } = await createDialog(page);
  const end = dialog.getByLabel("End time", { exact: true });
  await dialog.getByLabel("End date", { exact: true }).focus();
  await press("Tab", "End date: Day"); await press("Tab", "End date: Year"); await press("Tab", "End date: Show date picker");
  // 1 could still become 10, 11 or 12 and 3 could become 30 to 39, so the field waits and Tab does the moving.
  await press("Tab", "Start time: Hours"); await press("1", "Start time: Hours"); await press("Tab", "Start time: Minutes");
  await press("3", "Start time: Minutes"); await press("Tab", "Start time: AM/PM"); await press("Tab", "Start time: Show time picker");
  await press("Tab", "End time: Hours"); await press("Tab", "End time: Minutes"); await press("Tab", "End time: AM/PM"); await press("Tab", "End time: Show time picker");
  await press("Tab", "Notes (optional): textbox");
  // After a click on the hour, a completing digit followed by Tab stays on the minutes too.
  const box = (await end.boundingBox())!; await page.mouse.click(box.x + 18, box.y + box.height / 2);
  expect(await focusedPart(page)).toBe("End time: Hours"); await press("7", "End time: Minutes"); await press("Tab", "End time: Minutes");
  await press("4", "End time: Minutes"); await press("5", "End time: AM/PM"); await press("Tab", "End time: AM/PM"); await press("p", "End time: AM/PM");
  await expect(end).toHaveValue("19:45");
});

test("Tab after a digit that completes a segment of the meeting's dates stays on the segment typing moved to", async ({ page }) => {
  const { dialog, press } = await createDialog(page);
  await dialog.getByLabel("Title", { exact: true }).fill("Test meeting date tab order");
  // 0 completes the month (after 1) and 5 the day (after 2), so the field has moved on when each Tab arrives; the year
  // waits for more digits, so Tab moves on from it to the picker button.
  await press("Tab", "Date: Month"); await press("1", "Date: Month"); await press("0", "Date: Day"); await press("Tab", "Date: Day");
  await press("2", "Date: Day"); await press("5", "Date: Year"); await press("Tab", "Date: Year");
  await press("2", "Date: Year"); await press("0", "Date: Year"); await press("2", "Date: Year"); await press("6", "Date: Year");
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("2026-10-25");
  await press("Tab", "Date: Show date picker"); await press("Tab", "End date: Month");
  // 2 to 9 complete a month and 4 to 9 a day on their own.
  await press("1", "End date: Month"); await press("1", "End date: Day"); await press("Tab", "End date: Day"); await press("4", "End date: Year"); await press("Tab", "End date: Year");
  await expect(dialog.getByLabel("End date", { exact: true })).toHaveValue("2026-11-04");
  await press("Tab", "End date: Show date picker"); await press("Tab", "Start time: Hours");
  // A digit that leaves its segment open, and Shift+Tab, keep the browser's own order.
  await press("Shift+Tab", "End date: Show date picker"); await press("Shift+Tab", "End date: Year"); await press("Shift+Tab", "End date: Day"); await press("Shift+Tab", "End date: Month");
  await press("1", "End date: Month"); await press("Tab", "End date: Day"); await press("3", "End date: Day"); await press("Tab", "End date: Year");
  await expect(dialog.getByLabel("End date", { exact: true })).toHaveValue("2026-01-03");
  await press("Shift+Tab", "End date: Day"); await press("Shift+Tab", "End date: Month"); await press("9", "End date: Day"); await press("Tab", "End date: Day"); await press("3", "End date: Day"); await press("0", "End date: Year");
  await expect(dialog.getByLabel("End date", { exact: true })).toHaveValue("2026-09-30");
  // A recurring meeting's Series end date follows the same order.
  await dialog.getByRole("combobox", { name: "Frequency", exact: true }).selectOption("weekly");
  await dialog.getByRole("combobox", { name: "Frequency", exact: true }).focus();
  await press("Tab", "Series end date: Month"); await press("1", "Series end date: Month"); await press("2", "Series end date: Day"); await press("Tab", "Series end date: Day");
  await press("3", "Series end date: Day"); await press("1", "Series end date: Year"); await press("Tab", "Series end date: Year");
  await press("2", "Series end date: Year"); await press("0", "Series end date: Year"); await press("2", "Series end date: Year"); await press("6", "Series end date: Year");
  await expect(dialog.getByLabel("Series end date", { exact: true })).toHaveValue("2026-12-31");
  await press("Tab", "Series end date: Show date picker");
});

// Every other dashboard date field is the same DateInput (date-input.tsx); two of them, away from the meeting form.
test("Tab after a completing digit stays on the next segment in the Configuration and roster date fields", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-20T12:00:00.000Z"));
  const part = async () => { const value = await focusedPart(page); return value.slice(value.lastIndexOf(": ") + 2); };
  const press = async (key: string, expected: string) => { await page.keyboard.press(key); expect(await part(), `after ${key}`).toBe(expected); };
  await page.goto("/settings/configuration");
  const start = page.getByLabel("Attendance reporting start date (operational baseline)", { exact: true });
  // Keyboard focus from the field before it, past the field's info button, lands on the month.
  await page.getByLabel("Early-departure limit (minutes)", { exact: true }).focus();
  await press("Tab", "button"); await press("Tab", "Month"); await press("1", "Month"); await press("0", "Day"); await press("Tab", "Day");
  await press("2", "Day"); await press("5", "Year"); await press("Tab", "Year");
  await press("2", "Year"); await press("0", "Year"); await press("2", "Year"); await press("6", "Year");
  await expect(start).toHaveValue("2026-10-25");
  await press("Tab", "Show date picker");

  await page.route("**/admin/members", (route) => route.fulfill({ json: { members: [{ id: "member-1", memberId: "TEST-A", firstName: "Test Student", lastName: "A", email: "student.a@example.test", active: 1, rosterAddedAt: "2026-09-01T15:00:00Z" }] } }));
  await page.route("**/admin/attendance/members", (route) => route.fulfill({ json: { members: [{ memberId: "TEST-A", attendanceRequiredFrom: null }] } }));
  await page.goto("/roster");
  await page.getByRole("button", { name: "Edit Test Student A" }).click();
  const editor = page.getByRole("dialog", { name: "Edit roster member" });
  await editor.getByLabel("Custom date").check();
  await editor.getByLabel("Custom date").focus();
  await press("Tab", "Month"); await press("0", "Month"); await press("9", "Day"); await press("Tab", "Day");
  await press("1", "Day"); await press("4", "Year"); await press("Tab", "Year");
  await expect(editor.getByLabel("New start date")).toHaveValue("2026-09-14");
  await press("Tab", "Show date picker");
});

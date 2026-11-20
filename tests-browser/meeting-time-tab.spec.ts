// Tab order inside the meeting form's Start time and End time fields (use-time-field-tab.ts).
import { expect, test, type Page } from "@playwright/test";

// A time field's segments and picker button live inside the input, so the page's active element is the input for all of
// them. The accessibility tree names the one that has focus: "Hours", "Minutes", "AM/PM" or "Show time picker".
async function focusedPart(page: Page) {
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send("Accessibility.getFullAXTree"); await client.detach();
  const focused = nodes.filter((node) => node.properties?.some((property) => property.name === "focused" && property.value.value === true)).at(-1);
  const part = /Hours|Minutes|AM\/PM|Show time picker/.exec(String(focused?.name?.value ?? ""))?.[0] ?? String(focused?.role?.value ?? "none");
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
  await press("Tab", "End date: spinbutton"); await press("Tab", "End date: spinbutton"); await press("Tab", "End date: button");
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
  await press("Shift+Tab", "Start time: Minutes"); await press("Shift+Tab", "Start time: Hours"); await press("Shift+Tab", "End date: button");
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
  await press("Tab", "End date: spinbutton"); await press("Tab", "End date: spinbutton"); await press("Tab", "End date: button");
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

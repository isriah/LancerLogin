import { expect, test, type Page } from "@playwright/test";
import { expectResponsiveFit } from "./api-fixtures";

// The Dashboard's meeting CSV import, against a mocked /meetings/import that answers like the Worker. All data is synthetic.

const csv = `Title,Date,Start time,End time,Attendance,Audience labels
Test Build Session,11/10/2026,18:00,20:30,Required,
Test Drive Practice,11/12/2026,15:30,17:30,Optional,Test Label A
Test Kickoff Review,10/27/2026,18:00,20:00,Required,
Test Strategy Meeting,11/05/2026,18:00,19:30,Required,
Test Outreach Planning,11/17/2026,18:00,20:00,Required,
Test Scrimmage Prep,11/10/2026,19:00,21:00,Required,Test Label B`;
const local = (title: string, date: string, startTime: string, endTime: string, required = true, audience: string[] = []) => ({ title, date, startTime, endDate: date, endTime, required, audience });
const responsiveFit = { controls: "main button, main input, main select, main textarea", scrollers: ".table-scroll" };

/** Answers dry runs and the commit as the Worker would for `csv`; returns every request body. */
async function mockImport(page: Page) {
  const requests: { rows: { rowNumber: number; values: Record<string, string> }[]; dryRun: boolean; actions: Record<string, string> }[] = [];
  await page.route("**/meetings/import", async (route) => {
    const body = route.request().postDataJSON(); requests.push(body);
    const update = body.actions?.["6"] === "update";
    const rows = [
      { rowNumber: 2, action: "add", past: false, meeting: local("Test Build Session", "2026-11-10", "18:00", "20:30") },
      { rowNumber: 3, action: "add", past: false, meeting: local("Test Drive Practice", "2026-11-12", "15:30", "17:30", false, ["Test Label A"]) },
      { rowNumber: 4, action: "add", past: true, meeting: local("Test Kickoff Review", "2026-10-27", "18:00", "20:00") },
      { rowNumber: 5, action: "skip", past: false, meeting: local("Test Strategy Meeting", "2026-11-05", "18:00", "19:30"), existing: { meetingId: "strategy", ...local("Test Strategy Meeting", "2026-11-05", "18:00", "19:30") }, changes: [] },
      { rowNumber: 6, action: update ? "update" : "skip", past: false, meeting: local("Test Outreach Planning", "2026-11-17", "18:00", "20:00"), existing: { meetingId: "planning", ...local("Test Outreach Planning", "2026-11-17", "18:00", "19:30") }, changes: ["end time"] },
      { rowNumber: 7, action: "error", past: false, meeting: local("Test Scrimmage Prep", "2026-11-10", "19:00", "21:00", true, ["Test Label B"]), error: "Overlaps Test Build Session (6:00–8:30 PM)" },
    ];
    const summary = { add: 3, update: update ? 1 : 0, skip: update ? 1 : 2, error: 1, past: 1 };
    await route.fulfill({ json: body.dryRun ? { dryRun: true, rows, summary } : { dryRun: false, rows, summary, imported: { added: 3, updated: update ? 1 : 0, meetingIds: [] }, calendar: { googleQueued: 0, discordQueued: 3 } } });
  });
  return requests;
}

async function openImport(page: Page) {
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import meetings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("Import CSV sits just left of Add meeting in Table and Calendar views", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard");
  for (const view of ["Table", "Calendar"]) {
    await page.getByRole("radio", { name: view }).check();
    const importButton = page.getByRole("button", { name: "Import CSV", exact: true }); const add = page.getByRole("button", { name: "Add meeting", exact: true });
    await expect(importButton).toBeVisible();
    const [importBox, addBox] = [await importButton.boundingBox(), await add.boundingBox()];
    expect(importBox!.x + importBox!.width).toBeLessThanOrEqual(addBox!.x);
    expect(Math.abs(importBox!.y + importBox!.height / 2 - addBox!.y - addBox!.height / 2)).toBeLessThan(2);
    expect(importBox!.height).toBeGreaterThanOrEqual(44);
  }
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: "Close meeting import" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import CSV", exact: true })).toBeFocused();
});

test("meeting import explains the format, downloads a template and reports file problems", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard");
  const dialog = await openImport(page);
  const format = dialog.getByRole("group", { name: "CSV format" });
  const columns = format.getByRole("table", { name: "Meeting CSV columns" });
  for (const [column, required] of [["Title", "Required"], ["Date", "Required"], ["Start time", "Required"], ["End time", "Required unless Duration"], ["Duration", "Optional"], ["Notes", "Optional"]]) await expect(columns.getByRole("row", { name: new RegExp(`^${column} ${required}`) })).toBeVisible();
  await expect(format).toContainText("Dates use MM/DD/YYYY, such as 11/10/2026; 2026-11-10 also works.");
  const download = page.waitForEvent("download");
  await format.getByRole("button", { name: "Download template" }).click();
  const template = await download;
  expect(template.suggestedFilename()).toBe("meetings-template.csv");
  const chunks: Buffer[] = []; for await (const chunk of await template.createReadStream()) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  expect(text.split("\n")[0]).toBe("Title,Date,Start time,End time,Duration,Attendance,Audience labels,Weight category,Notes");
  expect(text).toMatch(/^Test Build Session,11\/10\/2026,/m);
  const paste = dialog.getByLabel("Meetings CSV or spreadsheet rows");
  await paste.fill("Title,Date,Start time\nTest,11/10/2026,18:00");
  await dialog.getByRole("button", { name: "Preview meetings" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Missing column: End time or Duration");
});

test("the preview lists every row, switches matching rows between Skip and Update, and imports the rest", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  const requests = await mockImport(page);
  await page.goto("/dashboard");
  const dialog = await openImport(page);
  await dialog.getByLabel("Meetings CSV or spreadsheet rows").fill(csv);
  await dialog.getByRole("button", { name: "Preview meetings" }).click();
  const table = dialog.getByRole("table", { name: "Processed meeting import" });
  await expect(table.getByRole("row")).toHaveCount(7);
  expect(requests[0]).toMatchObject({ dryRun: true, actions: {} });
  expect(requests[0]!.rows[0]).toEqual({ rowNumber: 2, values: { title: "Test Build Session", date: "11/10/2026", startTime: "18:00", endTime: "20:30", attendance: "Required", audience: "" } });

  await expect(table.getByRole("row", { name: /Test Build Session 11\/10\/2026 6:00–8:30 PM Required All members/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Test Kickoff Review/ }).getByText("Past", { exact: true })).toBeVisible();
  await expect(table.getByRole("row", { name: /Test Scrimmage Prep/ })).toContainText("Overlaps Test Build Session (6:00–8:30 PM)");
  await expect(dialog.getByRole("status").filter({ hasText: "Review before importing" })).toContainText("1 meeting is in the past. It counts toward attendance for its audience, and no Discord absence notice is sent for it.");
  await expect(dialog.getByRole("alert")).toContainText("1 row has a problem and won't be imported. Fix the file and preview again, or import the other rows.");
  await expect(dialog.getByRole("alert")).toContainText("Row 7, Test Scrimmage Prep: overlaps Test Build Session (6:00–8:30 PM).");
  await expect(dialog.getByText("3 to add, 2 skipped as a duplicate, 1 with a problem.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Import 3 meetings (skip 1 row with a problem)" })).toBeEnabled();

  // Skip is the default for matching rows; one row changed to Update makes the rows mixed.
  const skipAll = dialog.getByRole("radio", { name: "Skip all" }); const updateAll = dialog.getByRole("radio", { name: "Update all" });
  const strategy = dialog.getByRole("combobox", { name: "Action for Test Strategy Meeting" }); const planning = dialog.getByRole("combobox", { name: "Action for Test Outreach Planning" });
  await expect(skipAll).toBeChecked(); await expect(strategy).toHaveValue("skip"); await expect(planning).toHaveValue("skip");
  await planning.selectOption("update");
  await expect(dialog.getByText("Mixed", { exact: true })).toBeVisible();
  await expect(skipAll).not.toBeChecked(); await expect(updateAll).not.toBeChecked();
  expect(requests.at(-1)).toMatchObject({ dryRun: true, actions: { 6: "update" } });
  const planningRow = table.getByRole("row", { name: /Test Outreach Planning/ });
  await expect(planningRow.locator("del")).toHaveText("6:00–7:30 PM"); await expect(planningRow.locator("ins")).toHaveText("6:00–8:00 PM");
  await expect(planningRow).toContainText("Matches existing · changes end time");
  await expect(table.getByRole("row", { name: /Test Strategy Meeting/ })).toContainText("Matches existing · no changes");
  await expect(dialog.getByText("3 to add, 1 to update, 1 skipped as a duplicate, 1 with a problem.")).toBeVisible();

  await updateAll.check({ force: true });
  await expect(strategy).toHaveValue("update"); await expect(planning).toHaveValue("update");
  await expect(dialog.getByText("Mixed", { exact: true })).toHaveCount(0);
  await skipAll.check({ force: true });
  await expect(strategy).toHaveValue("skip"); await expect(planning).toHaveValue("skip");
  await planning.selectOption("update");

  // Badges, selects and text rows are one line at the same height.
  const heights = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(new Set(heights).size).toBe(1);
  await expectResponsiveFit(page, responsiveFit);

  await dialog.getByRole("button", { name: "Import 4 meetings (skip 1 row with a problem)" }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests.at(-1)).toMatchObject({ dryRun: false, actions: { 6: "update" } });
  await expect(page.getByRole("status").filter({ hasText: "4 meetings imported: 3 added, 1 updated." })).toBeVisible();
});

for (const width of [390, 320]) test(`on a ${width}px phone the calendar heading keeps only Add meeting and Import CSV sits below the month navigation`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/dashboard");
  await page.getByRole("radio", { name: "Calendar" }).check();
  await expect(page.locator(".dashboard-meeting-calendar .calendar-heading > button")).toHaveText(["+ Add meeting"]);
  const importButton = page.locator(".compact-calendar-secondary-action").getByRole("button", { name: "Import CSV", exact: true });
  await expect(importButton).toBeVisible();
  const [importBox, navigationBox, cardBox] = [await importButton.boundingBox(), await page.locator(".compact-month-navigation").boundingBox(), await page.locator(".dashboard-meeting-calendar").boundingBox()];
  expect(importBox!.y).toBeGreaterThanOrEqual(navigationBox!.y + navigationBox!.height);
  expect(importBox!.height).toBeGreaterThanOrEqual(44);
  expect(importBox!.width).toBeGreaterThanOrEqual(cardBox!.width - 2 * 16 - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dialog = await openImport(page);
  await dialog.getByRole("button", { name: "Close meeting import" }).click();
  await expect(importButton).toBeFocused();
});

test("the meeting import preview fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockImport(page);
  await page.goto("/dashboard");
  await page.getByRole("radio", { name: "Table" }).check();
  const dialog = await openImport(page);
  await dialog.getByLabel("Meetings CSV or spreadsheet rows").fill(csv);
  await expectResponsiveFit(page, responsiveFit);
  await dialog.getByRole("button", { name: "Preview meetings" }).click();
  await expect(dialog.getByRole("table", { name: "Processed meeting import" })).toBeVisible();
  await expectResponsiveFit(page, responsiveFit);
});

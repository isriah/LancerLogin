// "Attendance by label" against the real Worker and a Miniflare D1 database seeded with synthetic Test Students, so the
// numbers on screen come from the attendance calculation itself.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import worker from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { labelSetDefinition, labelSetSeedSql } from "../tests-ts/fixtures/attendance-label-sets.ts";
import { expectResponsiveFit } from "./api-fixtures";

type Runtime = { api: (path: string, body?: object) => Promise<Response>; exec: (sql: string) => Promise<void>; dispose: () => Promise<void> };
const secret = "A".repeat(43);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Routes the dashboard's API calls to the Worker over a fresh synthetic installation. */
async function installation(page: Page, baseURL: string): Promise<Runtime> {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: "2026-08-01", d1Databases: ["DB"] }));
  const db = await runtime.getD1Database("DB");
  const exec = async (sql: string) => { await db.exec(sql.replace(/^\s*--.*$/gm, "").replace(/\r?\n/g, " ")); };
  for (const name of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) await exec(readFileSync("apps/api/migrations/" + name, "utf8"));
  await exec(labelSetSeedSql());
  // A recent meeting everyone attends except Test Student C, so the current-standing Below target card has an alert.
  await exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,attendance_weight,audience_mode,created_by,created_at) VALUES ('recent','primary','Test recent meeting','${day(-3)}T18:00:00.000Z','${day(-3)}T19:00:00.000Z',1,1,'all','admin','2026-08-01');
    INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) SELECT id || '-recent','primary',id,'recent','present','Synthetic test outcome','admin','${day(-3)}T20:00:00.000Z' FROM members WHERE id <> 'c';
    INSERT INTO user_walkthroughs(installation_id,user_id,page_id,content_version,status,step_id,updated_at) SELECT 'primary','admin',value,1,'dismissed',NULL,'2026-01-01' FROM json_each('["dashboard","roster","member","reports"]');`);
  const origin = new URL(baseURL).origin; const apiPort = Number(new URL(baseURL).port) + 1;
  const env = { DB: db, SESSION_KEY: secret, APP_MODE: "configured", ALLOWED_ORIGIN: origin };
  const cookie = "lancerlogin_session=" + await createSessionCodec(secret).issue({ userId: "admin", role: "admin" });
  await page.route("**/*", async (route) => {
    if (Number(new URL(route.request().url()).port) !== apiPort) return route.continue();
    const request = route.request();
    const response = await worker.fetch(new Request(request.url(), { method: request.method(), headers: { ...request.headers(), cookie }, ...(request.postData() ? { body: request.postData()! } : {}) }), env as never);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const api = (path: string, body?: object) => worker.fetch(new Request(`http://127.0.0.1:${apiPort}${path}`, { method: body ? "POST" : "GET", headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env as never);
  return { api, exec, dispose: () => runtime.dispose() };
}
async function savedReport(runtime: Runtime, name: string, definition: object) {
  const response = await runtime.api("/reports/views", { name, scope: "shared", definition });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { report: { id: string } }).report.id;
}
const twoSets = labelSetDefinition([{ labelId: "robotics" }, { labelId: "build" }]);

test("a report shows a column set per label with policy headings, status pills, worked-example tips and the weight note", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    const id = await savedReport(runtime, "Test Attendance by Class", twoSets);
    await page.goto(`/reports/view/${id}`);
    const table = page.getByRole("table", { name: /Report results/ });
    await expect(table.getByRole("row").nth(2)).toContainText("Test Student B");
    const groups = table.locator(".report-label-group-row th[scope=colgroup][colspan]");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toHaveAttribute("colspan", "6");
    await expect(groups.nth(0)).toContainText("Test Robotics ClassTarget 80% · excused left out");
    await expect(groups.nth(1)).toContainText("Test Build TeamTarget 75% · excused count as missed");
    await expect(groups.nth(1).locator(".ui-status")).toHaveText("Weighted");
    // Short column names under each heading; the full name stays on the controls.
    const headers = table.getByRole("row").nth(1).getByRole("columnheader");
    await expect(headers).toHaveText(["Member", "Overall rate", "Attendance rate", "Target", "Status", "Meetings attended", "Meetings counted", "Excused", "Attendance rate", "Target", "Status", "Meetings attended", "Meetings counted", "Excused"].map((name) => new RegExp(`^${name}`)));
    await expect(page.getByRole("button", { name: "Test Build Team - Status column options" })).toBeVisible();
    const rowOf = (name: string) => table.getByRole("row").filter({ hasText: name });
    // The report covers September, so the recent meeting is outside it.
    await expect(rowOf("Test Student A").getByRole("cell")).toHaveText(["Test Student A", "66.7%", "80%", "80%", "Met", "3", "4", "1", "66.7%", "75%", "Below target", "3", "5", "1"]);
    await expect(rowOf("Test Student A").locator(".ui-status")).toHaveText(["Met", "Below target"]);
    await expect(rowOf("Test Student A").locator(".ui-status").nth(1)).toHaveAttribute("data-tone", "warning");
    await expect(rowOf("Test Student A").locator(".ui-status").nth(0)).toHaveAttribute("data-tone", "success");
    // Test Student C doesn't hold Test Build Team: No policy, and a dash that reads "No value".
    const c = rowOf("Test Student C").getByRole("cell");
    await expect(c.nth(10)).toHaveText("No policy");
    await expect(c.nth(8)).toHaveText("—No value");
    await expect(c.nth(8).locator(".visually-hidden")).toHaveText("No value");
    await page.setViewportSize({ width: 1400, height: 900 });
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("report-sets-desktop.png") });
    await expect(page.locator(".report-weight-note")).toHaveText("WeightedTest Robotics Class, Test Build Team use meeting weights: some meetings count more than once. Counts are plain meetings; the rate uses the weights.");
    // The rate column's tip: definition, the policy in one line and a worked example with fixed numbers.
    await page.getByRole("button", { name: "About Test Robotics Class attendance rate" }).focus();
    const tip = page.getByRole("tooltip").filter({ hasText: "Test Robotics Class: target 80%. Excused meetings are left out." });
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Example: Attended 12 of 15 counted meetings, including 3 that count double, so it's 15 of 18 = 83.3%. Excused meetings aren't counted under this policy. Target 80% → Met.");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "About Overall rate" }).focus();
    await expect(page.getByRole("tooltip").filter({ hasText: "so it's 29 of 36 = 80.6%." })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "About meeting weights in Test Build Team" }).focus();
    await expect(page.getByRole("tooltip").filter({ hasText: "The counts here are plain meetings" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Filters work on set columns: + Filter lists them with the rest of the table.
    await page.getByRole("button", { name: "Filter Test Build Team - Status", exact: true }).click();
    const filter = page.getByRole("dialog", { name: "Filter Test Build Team - Status" });
    await filter.getByRole("combobox").selectOption("equals");
    await filter.getByLabel("Equals", { exact: true }).fill("Below target");
    await filter.getByRole("button", { name: "Apply" }).click();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.locator("tbody tr")).toContainText("Test Student A");
  } finally { await runtime.dispose(); }
});

test("the report CSV has plain numbers, labelled headers with a plain hyphen and a Member ID column", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    const id = await savedReport(runtime, "Test Attendance by Class", twoSets);
    await page.goto(`/reports/view/${id}`);
    await expect(page.getByRole("table", { name: /Report results/ })).toContainText("Test Student D");
    await page.getByText("Export", { exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download report CSV" }).click()]);
    const csv = readFileSync((await download.path())!, "utf8").split("\r\n");
    const names = ["Attendance rate (%)", "Target (%)", "Status", "Meetings attended", "Meetings counted", "Excused meetings"];
    expect(csv[0]).toBe(["Member", "Member ID", "Overall rate (%)", ...names.map((name) => `Test Robotics Class - ${name}`), ...names.map((name) => `Test Build Team - ${name}`)].join(","));
    expect(csv.slice(1)).toEqual([
      "Test Student B,TEST-002,100.0,100.0,80,Met,5,5,0,100.0,75,Met,5,5,0",
      "Test Student A,TEST-001,66.7,80.0,80,Met,3,4,1,66.7,75,Below target,3,5,1",
      "Test Student C,TEST-003,33.3,33.3,80,Below target,2,5,0,,,No policy,,,",
      "Test Student D,TEST-004,,,80,Not enough meetings yet,0,0,0,,75,Not enough meetings yet,0,0,0",
      "",
    ]);
  } finally { await runtime.dispose(); }
});

test("one label in Label group ranks the Leaderboard by its Attendance rate with status pills and hides Below target", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    await page.goto("/reports");
    const board = page.getByRole("table", { name: "Attendance leaderboard" });
    await expect(board.getByRole("row").nth(1)).toContainText("Test Student");
    await expect(page.getByRole("heading", { name: "Below target" })).toBeVisible();
    await expect(page.locator(".report-policy-alerts")).toContainText("Test Robotics Class: 0% of 80% · Below target");
    await expect(board.getByRole("columnheader").nth(1)).toHaveText(/^Overall rate/);
    await page.locator(".leaderboard-heading .info-tip-button").focus();
    await expect(page.getByRole("tooltip").filter({ hasText: "Ranked by Overall rate" })).toContainText("Choose one label in Label group to rank by that label's Attendance rate.");
    await page.keyboard.press("Escape");
    await page.getByLabel("Label group").selectOption({ label: "Test Robotics Class" });
    await page.getByLabel("Label group").focus();
    const sort = page.getByRole("combobox", { name: "Sort attendance leaderboard" });
    await expect(sort).toHaveValue("label-rate");
    await expect(sort.locator("option")).toHaveText(["Attendance rate: Test Robotics Class", "Overall rate", "First name", "Last name"]);
    await expect(page.getByText("Ranked by Test Robotics Class attendance rate because one label is chosen.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Below target" })).toHaveCount(0);
    await expect(board.getByRole("columnheader").nth(1)).toHaveText(/^Attendance rate/);
    // Members without the label (Test Student E) are hidden; ranked by rate, with each status pill beside it.
    const rows = board.getByRole("row").filter({ has: page.getByRole("cell") });
    await expect(rows).toHaveText(["Test Student BMet100%", "Test Student DMet100%", "Test Student AMet83.3%", "Test Student CBelow target28.6%"]);
    await expect(rows.nth(3).locator(".ui-status")).toHaveAttribute("data-tone", "warning");
    await page.locator(".leaderboard-heading .info-tip-button").focus();
    const tip = page.getByRole("tooltip").filter({ hasText: "Ranked by Attendance rate" });
    await expect(tip).toContainText("One label is chosen, so members are ranked by Test Robotics Class's Attendance rate: meetings attended ÷ meetings counted, with excused meetings left out under this policy.");
    await expect(tip).toContainText("Choose All labels to rank by Overall rate again.");
    await page.keyboard.press("Escape");
    await sort.selectOption("regular-desc");
    await expect(board.getByRole("columnheader").nth(1)).toHaveText(/^Overall rate/);
    await page.getByLabel("Label group").selectOption({ label: "All labels" });
    await expect(sort.locator("option")).toHaveText(["Overall rate", "First name", "Last name"]);
  } finally { await runtime.dispose(); }
});

test("on a phone the column sets scroll inside the table with their headings and the Leaderboard pill fits beside the rate", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    await page.setViewportSize({ width: 375, height: 812 });
    const id = await savedReport(runtime, "Test Attendance by Class", twoSets);
    await page.goto(`/reports/view/${id}`);
    const scroller = page.getByRole("region", { name: "Scrollable report results" });
    await expect(scroller.locator("tbody tr")).toHaveCount(4);
    await expect(scroller.locator(".report-label-group-row")).toBeVisible();
    await expect(page.locator(".report-column-filter-button").first()).toBeHidden();
    expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expectResponsiveFit(page, { controls: "main button, main a[href], main select, main input", scrollers: ".report-table-scroll,.report-tabs" });
    // Scrolled to the last column, the set's heading has slid along with it and sits beside the sticky Member column.
    await scroller.scrollIntoViewIfNeeded();
    await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const heading = scroller.locator('th[data-label-set="build"] .report-set-heading');
    await expect(heading).toBeInViewport();
    const member = (await scroller.locator("thead tr:last-child th").first().boundingBox())!;
    expect((await heading.boundingBox())!.x).toBeGreaterThanOrEqual(member.x + member.width - 1);
    await expect(page.locator(".report-weight-note")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("report-sets-phone.png") });
    await page.goto("/reports");
    await page.getByLabel("Label group").selectOption({ label: "Test Robotics Class" });
    const row = page.getByRole("table", { name: "Attendance leaderboard" }).getByRole("row").filter({ hasText: "Test Student C" });
    const pill = await row.locator(".ui-status").boundingBox(); const name = await row.getByRole("link").boundingBox();
    expect(Math.abs(pill!.y + pill!.height / 2 - (name!.y + name!.height / 2))).toBeLessThan(12);
    await expectResponsiveFit(page, { controls: ".leaderboard-card button, .leaderboard-card a[href], .leaderboard-card select, .report-filters select", scrollers: ".report-tabs" });
  } finally { await runtime.dispose(); }
});

test("the Attendance by label preset preselects labels with a policy, says what it adds and creates the report", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    await page.goto("/reports/new");
    const presets = page.getByRole("region", { name: "Start from a preset" });
    await presets.getByRole("button", { name: "Use the Attendance by label preset" }).click();
    const labels = presets.getByRole("group", { name: "Labels to include" });
    await expect(labels.getByRole("checkbox")).toHaveCount(4);
    await expect(labels.getByRole("checkbox", { name: /^Test Robotics Class/ })).toBeChecked();
    await expect(labels.getByRole("checkbox", { name: /^Test Build Team/ })).toBeChecked();
    await expect(labels.getByRole("checkbox", { name: /^Test Outreach Crew/ })).toBeChecked();
    await expect(labels.getByRole("checkbox", { name: /^Test Mentors/ })).toBeDisabled();
    await expect(labels.locator(".report-column-option")).toHaveText(["Test Build TeamTarget 75% · weighted · excused count as missed", "Test MentorsNo policy: no columns to add", "Test Outreach CrewTarget 2 per week", "Test Robotics ClassTarget 80% · weighted · excused left out"]);
    const adds = presets.locator(".report-preset-adds");
    await expect(adds).toContainText("Adds 20 columns");
    await expect(adds).toContainText("(Weeks met in place of Meetings counted for a meetings-per-week label)");
    await labels.getByRole("checkbox", { name: /^Test Outreach Crew/ }).uncheck();
    await expect(adds).toHaveText('Adds 14 columnsMember · Overall rate · then for each label: Attendance rate, Target, Status, Meetings attended, Meetings counted, ExcusedAlso adds the filter "Labels: Test Build Team or Test Robotics Class" and sorts by Overall rate.');
    await presets.getByLabel("Period").selectOption("all");
    await presets.getByLabel("Report name").fill("Test Attendance by Class");
    await presets.getByRole("button", { name: "Create report" }).click();
    await expect(page).toHaveURL(/\/reports\/view\//);
    await expect(page.getByRole("heading", { name: "Test Attendance by Class" })).toBeVisible();
    await expect(page.locator(".report-label-group-row th[colspan]")).toHaveText([/^Test Build Team/, /^Test Robotics Class/]);
    await expect(page.getByRole("button", { name: /^Edit filter: Labels: Test Build Team, Test Robotics Class/ })).toBeVisible();
    const rows = page.getByRole("table", { name: /Report results/ }).locator("tbody tr");
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText("Test Student B");
    await expect(page.locator('th[data-column-id="attendance.member.regular-rate"]')).toHaveAttribute("aria-sort", "descending");
  } finally { await runtime.dispose(); }
});

test("Add column adds or removes a label's whole set from the Attendance by label drill-in", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    const id = await savedReport(runtime, "Test Robotics Report", labelSetDefinition([{ labelId: "robotics" }]));
    await page.goto(`/reports/view/${id}`);
    await expect(page.getByRole("table", { name: /Report results/ }).locator("tbody tr")).toHaveCount(4);
    await page.getByRole("button", { name: "Add column", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add report column" });
    const group = dialog.getByRole("region", { name: "Attendance policies (per label)" });
    await expect(group.getByRole("button").first()).toHaveAccessibleName("Choose labels for Attendance by label");
    await expect(group.getByRole("button").nth(1)).toHaveAccessibleName("Choose a single policy column");
    await group.getByRole("button", { name: "Choose labels for Attendance by label" }).click();
    await expect(dialog.locator(".report-column-option")).toHaveText(["Test Build TeamAdds 6 columns · weighted", "Test MentorsNo policy", "Test Outreach CrewAdds 6 columns · 2 meetings per week", "Test Robotics ClassIn report · 6 columns"]);
    await expect(dialog.getByRole("checkbox", { name: /^Test Mentors/ })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: /^Test Build Team/ }).check();
    await expect(page.locator(".report-label-group-row th[colspan]")).toHaveText([/^Test Robotics Class/, /^Test Build Team/]);
    await expect(page.getByRole("button", { name: /^Edit filter: Labels: Test Robotics Class, Test Build Team/ })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /^Test Build Team/ })).toBeChecked();
    await dialog.getByRole("checkbox", { name: /^Test Robotics Class/ }).uncheck();
    await expect(page.locator(".report-label-group-row th[colspan]")).toHaveText([/^Test Build Team/]);
    await expect(page.getByRole("button", { name: "Test Robotics Class - Status column options" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Back" }).click();
    await dialog.getByRole("button", { name: "Choose a single policy column" }).click();
    await dialog.getByRole("button", { name: "Choose labels for Policy status" }).click();
    await dialog.getByRole("checkbox", { name: "Test Mentors", exact: true }).check();
    await expect(page.getByRole("button", { name: "Test Mentors - Policy status column options" })).toBeVisible();
    await dialog.getByRole("button", { name: "Back" }).click();
    await expect(dialog.getByRole("button", { name: "Choose labels for Policy status" })).toBeVisible();
  } finally { await runtime.dispose(); }
});

test("+ Filter offers per-label fields that aren't in the table through a field-then-label drill-in", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    const id = await savedReport(runtime, "Test Robotics Report", labelSetDefinition([{ labelId: "robotics" }], { labelIds: ["robotics", "build"] }));
    await page.goto(`/reports/view/${id}`);
    await expect(page.getByRole("table", { name: /Report results/ }).locator("tbody tr")).toHaveCount(4);
    await page.getByRole("button", { name: "Add filter" }).click();
    await page.getByRole("button", { name: "Attendance policies (per label) (choose a field, then a label)" }).click();
    await page.getByRole("dialog", { name: "Filter a per-label field" }).getByRole("button", { name: "Status (choose a label)", exact: true }).click();
    const labels = page.getByRole("dialog", { name: "Filter Status: choose a label" });
    await expect(labels.getByRole("button", { name: "Test Robotics Class (in this report)" })).toBeVisible();
    await labels.getByRole("button", { name: "Back" }).click();
    await page.getByRole("dialog", { name: "Filter a per-label field" }).getByRole("button", { name: "Status (choose a label)", exact: true }).click();
    await page.getByRole("dialog", { name: "Filter Status: choose a label" }).getByRole("button", { name: "Test Build Team (not in the table)" }).click();
    const filter = page.getByRole("dialog", { name: "Filter Test Build Team - Status" });
    await expect(filter).toContainText("Not shown");
    await filter.getByRole("combobox").selectOption("equals");
    await filter.getByLabel("Equals", { exact: true }).fill("Below target");
    await filter.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("table", { name: /Report results/ }).locator("tbody tr")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Edit filter: Test Build Team - Status = Below target" })).toContainText("Not shown");
  } finally { await runtime.dispose(); }
});

test("a member profile explains each of the member's rates with their own numbers in a closed-by-default section", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    await page.goto("/roster/TEST-001");
    await expect(page.getByRole("heading", { name: "Test Student A", level: 1 })).toBeVisible();
    // Five September meetings and the recent one: 4 of 6 attended, the build day counting double, 5 of 7 = 71.4%.
    await expect(page.locator(".member-profile-details")).toContainText("71.4% · 2026-08-01 to");
    const section = page.locator("details.calc-disclosure");
    await expect(section).not.toHaveAttribute("open", "");
    await section.getByText("How these rates are calculated").click();
    const overall = section.getByRole("region", { name: "Overall rate" });
    await expect(overall.locator("p")).toHaveText("All 6 required meetings since 2026-08-01, the same rule for everyone. Excused meetings count as missed. Some meetings have a weight other than 1.");
    await expect(overall.locator("li")).toHaveText(["Required meetings6", "Attended4", "Excused, counted as missed1", "With meeting weights5 of 7", "Overall rate: 5 ÷ 771.4%"]);
    // The policy results cover the current-standing window: only the recent meeting.
    const robotics = section.getByRole("region", { name: "Test Robotics Class" });
    await expect(robotics.locator("p")).toHaveText("Attended 1 of 1 counted meetings = 100%. Target 80% → Met.");
    await expect(robotics.locator("li")).toHaveText(["Required meetings for this label1", "Excused, left out0", "Meetings counted1", "Meetings attended1", "Attendance rate: 1 ÷ 1100%", "Target 80%Met"]);
    await expect(robotics.locator(".ui-status")).toHaveAttribute("data-tone", "success");
    await expect(section.getByRole("region", { name: "Test Build Team" }).locator("li").first()).toHaveText("Meetings counted (no excused meetings)1");
    await section.screenshot({ path: test.info().outputPath("profile-calculation.png") });
  } finally { await runtime.dispose(); }
});

test("Settings explains each saved policy in one line and the policy form's calculation follows its fields", async ({ page, baseURL }) => {
  const runtime = await installation(page, baseURL!);
  try {
    await page.goto("/settings/attendance");
    const list = page.locator(".label-period-list > li");
    await expect(list.filter({ hasText: "Test Robotics Class" }).locator(".calc-inline")).toHaveText("Example: 14 of 16 counted meetings = 87.5% → Met.");
    await expect(list.filter({ hasText: "Test Build Team" }).locator(".calc-inline")).toHaveText("Example: 14 of 18 counted meetings = 77.8% → Met.");
    await expect(list.filter({ hasText: "Test Outreach Crew" }).locator(".calc-inline")).toHaveText("Example: 2 meetings attended this week → Met. Before the week ends, fewer than 2 → In progress.");
    await list.filter({ hasText: "Test Robotics Class" }).getByRole("button", { name: "Edit" }).click();
    const box = page.getByRole("note", { name: "How this is calculated" });
    await expect(box).toContainText("minus excused meetings, which this policy leaves out. Meeting weights apply");
    await expect(box.locator(".calc-example")).toHaveText("Example: Attended 14 of 16 counted meetings = 87.5%. 2 excused meetings aren't counted under this policy. Target 80% → Met.");
    await expect(box.locator(".report-field-help")).toHaveText('With "Count as missed" the same member would have 14 of 18 = 77.8% → Below target.');
    await page.locator(".settings-attendance .member-labels-panel").nth(1).screenshot({ path: test.info().outputPath("settings-calculation.png") });
    await page.getByLabel("Excused meetings in this policy").selectOption("count_missed");
    await expect(box.locator(".calc-example")).toHaveText("Example: Attended 14 of 18 counted meetings = 77.8%. 2 excused meetings count as missed under this policy. Target 80% → Below target.");
    await page.getByLabel("Required attendance (%)").fill("75");
    await expect(box.locator(".calc-example")).toContainText("Target 75% → Met.");
    await page.getByLabel("Policy type").selectOption("weekly_count");
    await expect(box).toContainText("Attendance rate = weeks met ÷ weeks due.");
    await expect(box.locator(".report-field-help")).toHaveText("Example: 1 meeting attended this week → Met. Before the week ends, fewer than 1 → In progress.");
  } finally { await runtime.dispose(); }
});

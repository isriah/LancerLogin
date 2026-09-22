import { expect,test,type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

type Role="admin"|"operator";

const referenceSettings={
  organizationName: "Reference Arts Collective",
  subtitle: "Shared operations",
  logoData: "",
  primaryColor: dashboardConformanceReferences.brand.primary,
  secondaryColor: dashboardConformanceReferences.brand.secondary,
  appearance: "dark",
  logoBackdrop: "auto",
  lateScanMinutes: 30,
  anomalyLateThresholdMinutes: 10,
  anomalyEarlyThresholdMinutes: 10,
};

const roster=[
  { id: "member-1",memberId: "A-101",firstName: "Avery",lastName: "Stone",email: "avery@example.org",discordUserId: "123456789012",attendanceRequiredFrom: "2026-01-01",active: 1,hasDashboardAccess: true },
  { id: "member-2",memberId: "A-102",firstName: "Morgan",lastName: "Diaz",email: "morgan@example.org",attendanceRequiredFrom: "2026-02-01",active: 0,hasDashboardAccess: false },
];

async function useReferenceContext(page: Page,role: Role="admin") {
  await page.route("**/setup/status",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ configured: true,installation: { authMode: "local" },settings: referenceSettings }) }));
  await page.route("**/auth/session",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ user: { role } }) }));
  await page.route("**/integrations/capabilities",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ integrations: { google: { enabled: true,configured: true },resend: { enabled: false,configured: false },discord: { enabled: true,configured: true } } }) }));
  await page.route("**/admin/members",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ members: roster,discordConfigured: true }) }));
  await page.route("**/admin/roster/history",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ imports: [{ createdAt: "2026-09-03T18:00:00Z",count: 2,mode: "merge",deactivated: 0 }] }) }));
}

async function expectResponsiveFit(page: Page) {
  const geometry=await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped: Array.from(document.querySelectorAll<HTMLElement>("main button, main a[href], main input, main select, main textarea, main [role='status']")).flatMap((element) => {
      const style=getComputedStyle(element); const bounds=element.getBoundingClientRect();
      if(style.display==="none"||style.visibility==="hidden"||bounds.width===0||element.closest(".report-table,.roster-table-scroll,.member-history-scroll,.table-scroll")) return [];
      return bounds.left<-1||bounds.right>innerWidth+1? [element.getAttribute("aria-label")||element.textContent?.trim()||element.tagName]:[];
    }),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.clipped).toEqual([]);
}

for(const viewport of dashboardConformanceReferences.viewports) {
  for(const theme of dashboardConformanceReferences.themes) {
    test(`Reports and Roster conform at ${viewport.width}x${viewport.height} in ${theme} mode with reference branding`,async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme",savedTheme),theme);
      await useReferenceContext(page);

      await page.goto("/reports");
      await expect(page.locator(".app")).toHaveAttribute("data-theme",theme);
      await expect(page.locator(".app")).toHaveCSS("--primary",dashboardConformanceReferences.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary",dashboardConformanceReferences.brand.secondary);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.getByRole("heading",{ level: 1,name: "Reports" })).toBeVisible();
      await expect(page.getByRole("heading",{ level: 2,name: "Report filters" })).toBeVisible();
      await expect(page.getByRole("table",{ name: "Attendance leaderboard" })).toBeVisible();
      await expect(page.getByRole("img",{ name: /Team attendance trend:/ })).toBeVisible();
      const reportingPeriod=page.getByLabel("Reporting period");
      expect((await reportingPeriod.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await reportingPeriod.focus();
      expect(await reportingPeriod.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      await expectResponsiveFit(page);

      await page.goto("/roster");
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.getByRole("heading",{ level: 1,name: "Roster" })).toBeVisible();
      await expect(page.getByRole("table",{ name: "Roster members" })).toContainText("Avery Stone");
      await page.getByLabel("Show").selectOption("all");
      await expect(page.getByText("Inactive",{ exact: true })).toBeVisible();
      await expect(page.getByText("Not linked",{ exact: true })).toBeVisible();
      await expect(page.getByRole("button",{ name: "Add member" })).toBeVisible();
      await expectResponsiveFit(page);
    });
  }
}

for(const viewport of dashboardConformanceReferences.viewports) {
  for(const theme of dashboardConformanceReferences.themes) {
    test(`member anomaly metric conforms at ${viewport.width}x${viewport.height} in ${theme} mode`,async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme",savedTheme),theme);
      await useReferenceContext(page,"operator");
      await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ member: roster[0],meanAnomalyMinutes: 15,history: [{ meetingId: "meeting-1",title: "Build session",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",checkedInAt: "2026-09-01T18:12:00Z",checkedOutAt: "2026-09-01T19:42:00Z",disposition: "present" }] }) }));
      await page.goto("/roster/A-101");
      await expect(page.getByText("Mean anomalous time",{ exact: true })).toBeVisible();
      await expect(page.getByText("15 minutes",{ exact: true })).toBeVisible();
      await expectResponsiveFit(page);
    });
  }
}

test("saved report views, preserved-history empty state, and CSV export remain operable",async ({ page }) => {
  await useReferenceContext(page);
  await page.route("**/exports/attendance.csv",(route) => route.fulfill({ status: 200,contentType: "text/csv",body: "member_id,status\nA-101,present\n" }));
  await page.goto("/reports");

  await expect(page.getByLabel("Reporting period")).toHaveValue("all");
  await expect(page.getByText(/No operational baseline is configured/)).toBeVisible();
  await page.getByRole("button",{ name: "Use saved view" }).click();
  await expect(page.getByRole("status")).toHaveText("No saved report view is available in this browser.");
  await page.getByLabel("Meeting type").selectOption("optional");
  await page.getByRole("button",{ name: "Save this view" }).click();
  await page.getByLabel("Meeting type").selectOption("regular");
  await page.getByRole("button",{ name: "Use saved view" }).click();
  await expect(page.getByLabel("Meeting type")).toHaveValue("optional");

  const download=page.waitForEvent("download");
  await page.getByRole("button",{ name: "Download attendance CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/^lancerlogin-attendance-\d{4}-\d{2}-\d{2}\.csv$/);

  await page.getByLabel("From").fill("2099-01-01");
  await expect(page.getByText("No attendance records match these filters.")).toBeVisible();
  await expect(page.getByText("No completed meetings match these filters.")).toBeVisible();
});

test("Admin member and import dialogs contain focus, report errors, and return focus with reduced motion",async ({ page }) => {
  await page.setViewportSize({ width: 390,height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce",colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme","dark"));
  await useReferenceContext(page);
  await page.goto("/roster");

  const addMember=page.getByRole("button",{ name: "Add member" });
  await addMember.click();
  const addDialog=page.getByRole("dialog",{ name: "Add roster member" });
  await expect(addDialog.getByRole("button",{ name: "Close add member dialog" })).toBeFocused();
  await addDialog.getByRole("button",{ name: "Import CSV instead" }).click();
  await addDialog.getByLabel("Roster CSV").fill("firstName,lastName\nAvery,Stone");
  await addDialog.getByRole("button",{ name: "Preview roster" }).click();
  await expect(addDialog.getByRole("alert")).toContainText("Header row requires memberId");
  await expect(addDialog.getByRole("alert")).toBeFocused();
  await addDialog.getByLabel("Roster CSV").fill("memberId,firstName,lastName,email,discordUserId\nA-103,Jordan,Lee,jordan@example.org,not-a-discord-id");
  await addDialog.getByRole("button",{ name: "Preview roster" }).click();
  await expect(addDialog.getByRole("table",{ name: "Processed roster import" })).toContainText("A-103");
  await page.keyboard.press("Escape");
  await expect(addDialog).toHaveCount(0);
  await expect(addMember).toBeFocused();
  await expectResponsiveFit(page);

  await page.getByRole("button",{ name: "Edit" }).first().click();
  const editDialog=page.getByRole("dialog",{ name: "Edit roster member" });
  await expect(editDialog.getByRole("button",{ name: "Close member editor" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(editDialog.getByRole("button",{ name: "Save member" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editDialog).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Edit" }).first()).toBeFocused();
});

test("roster import loads CSV files and previews tab-separated spreadsheet rows",async ({ page }) => {
  await page.setViewportSize({ width: 390,height: 844 });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme","dark"));
  await useReferenceContext(page);
  let submitted: unknown;
  await page.route("**/admin/members",async (route) => {
    if(route.request().method()!=="POST") { await route.fallback(); return; }
    submitted=route.request().postDataJSON();
    await route.fulfill({ status: 201,contentType: "application/json",body: JSON.stringify({ warnings: [] }) });
  });
  await page.goto("/roster");
  await page.getByRole("button",{ name: "Add member" }).click();
  const dialog=page.getByRole("dialog",{ name: "Add roster member" });
  await dialog.getByRole("button",{ name: "Import CSV instead" }).click();
  const rosterText=dialog.getByLabel("Roster CSV or spreadsheet rows");
  const fileInput=dialog.locator(".roster-import-file input[type='file']");
  const chooseFile=dialog.getByRole("button",{ name: "Choose CSV file" });
  await expect(fileInput).toBeHidden();
  await fileInput.evaluate((element) => {
    const input=element as HTMLInputElement;
    input.dataset.pickerClicks="0";
    input.addEventListener("click",() => { input.dataset.pickerClicks=String(Number(input.dataset.pickerClicks)+1); });
  });
  await dialog.getByText("CSV file",{ exact: true }).click();
  await dialog.getByText("No file chosen").click();
  await expect(fileInput).toHaveAttribute("data-picker-clicks","0");
  expect((await chooseFile.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  const invalidChooser=page.waitForEvent("filechooser");
  await chooseFile.click();
  await (await invalidChooser).setFiles({ name: "not-a-roster.txt",mimeType: "text/plain",buffer: Buffer.from("ignored") });
  await expect(dialog.getByRole("alert")).toContainText("Choose a nonempty .csv file");
  await expect(rosterText).toBeEmpty();
  const csv='\uFEFFmemberId,firstName,lastName,email,discordUserId\r\nA-103,"Jordan, Jr.",Lee,jordan@example.org,\r\n';
  await chooseFile.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(chooseFile).toBeFocused();
  expect(await chooseFile.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  const validChooser=page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await validChooser).setFiles({ name: "sample-roster.csv",mimeType: "text/csv",buffer: Buffer.from(csv) });
  await expect(fileInput).toHaveAttribute("data-picker-clicks","2");
  await expect(rosterText).toHaveValue(csv.replace(/^\uFEFF/,"").replaceAll("\r\n","\n"));
  await expect(dialog.getByText("sample-roster.csv",{ exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("Loaded sample-roster.csv");
  await dialog.getByRole("button",{ name: "Preview roster" }).click();
  await expect(dialog.getByRole("table",{ name: "Processed roster import" })).toContainText("Jordan, Jr. Lee");

  await dialog.getByRole("button",{ name: "Back",exact: true }).click();
  await rosterText.fill('memberId\tfirstName\tlastName\temail\tdiscordUserId\nA-104\t"Grace, ""Amazing"""\tHopper\tgrace@example.org\t');
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button",{ name: "Preview roster" }).click();
  await expect(dialog.getByRole("table",{ name: "Processed roster import" })).toContainText('Grace, "Amazing" Hopper');
  const backToMember=dialog.getByRole("button",{ name: "Back to one member" });
  await expect(backToMember.locator("..")).toHaveClass(/dialog-actions/);
  const secondary=await backToMember.evaluate((element) => {
    const style=getComputedStyle(element);
    const edit=getComputedStyle(document.querySelector<HTMLElement>(".roster-row-actions button")!);
    return { color: style.color,background: style.backgroundColor,radius: style.borderRadius,height: element.getBoundingClientRect().height,editColor: edit.color,editBackground: edit.backgroundColor,editRadius: edit.borderRadius };
  });
  expect(secondary.color).toBe(secondary.editColor);
  expect(secondary.background).toBe(secondary.editBackground);
  expect(secondary.radius).toBe(secondary.editRadius);
  expect(secondary.height).toBeGreaterThanOrEqual(44);
  await expectResponsiveFit(page);
  await backToMember.click();
  await expect(dialog.getByLabel("Member ID")).toBeFocused();
  await dialog.getByRole("button",{ name: "Import CSV instead" }).click();
  const paste=dialog.getByLabel("Roster CSV or spreadsheet rows");
  await expect(paste).toBeEmpty();
  await paste.fill('firstName\tlastName\nCase\tPerson');
  await dialog.getByRole("button",{ name: "Preview roster" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Header row requires memberId");
  await paste.fill('30001\tAvery\tTest\tavery@example.test\n30002\tBlair\tSample\tblair@example.test');
  await dialog.getByRole("button",{ name: "Preview roster" }).click();
  await expect(dialog.getByRole("table",{ name: "Processed roster import" })).toContainText("Blair Sample");
  await dialog.getByRole("button",{ name: "Confirm import" }).click();
  await expect(dialog).toHaveCount(0);
  expect(submitted).toMatchObject({ mode: "merge",members: [
    { memberId: "30001",firstName: "Avery",lastName: "Test",email: "avery@example.test" },
    { memberId: "30002",firstName: "Blair",lastName: "Sample",email: "blair@example.test" },
  ] });
});

test("roster import back action follows the secondary theme at desktop and mobile sizes",async ({ page },testInfo) => {
  await useReferenceContext(page);
  for(const { width,height,theme } of [
    { width: 1280,height: 900,theme: "light" },
    { width: 390,height: 844,theme: "dark" },
  ] as const) {
    await page.setViewportSize({ width,height });
    await page.goto("/roster");
    await page.evaluate((value) => localStorage.setItem("lancerlogin-theme",value),theme);
    await page.reload();
    await expect(page.locator(".app")).toHaveAttribute("data-theme",theme);
    await page.getByRole("button",{ name: "Add member" }).click();
    const dialog=page.getByRole("dialog",{ name: "Add roster member" });
    await dialog.getByRole("button",{ name: "Import CSV instead" }).click();
    const chooseFile=dialog.getByRole("button",{ name: "Choose CSV file" });
    expect((await chooseFile.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`roster-import-${width}-${theme}.png`),fullPage: true });
    const back=dialog.getByRole("button",{ name: "Back to one member" });
    await expect(back.locator("..")).toHaveClass(/dialog-actions/);
    const colors=await back.evaluate((element) => {
      const style=getComputedStyle(element);
      const edit=getComputedStyle(document.querySelector<HTMLElement>(".roster-row-actions button")!);
      return { back: [style.color,style.backgroundColor,style.borderColor,style.borderRadius],edit: [edit.color,edit.backgroundColor,edit.borderColor,edit.borderRadius] };
    });
    expect(colors.back).toEqual(colors.edit);
    await expectResponsiveFit(page);
    await back.click();
    await expect(dialog.getByLabel("Member ID")).toBeFocused();
  }
});

test("Operator and member-detail states preserve identity policy, history, and unavailable recovery",async ({ page }) => {
  await useReferenceContext(page,"operator");
  await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ member: roster[0],meanAnomalyMinutes: null,history: [{ meetingId: "meeting-1",title: "Build session with a deliberately long name",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",checkedInAt: "2026-09-01T18:05:00Z",checkedOutAt: "2026-09-01T19:58:00Z",disposition: "present" }] }) }));
  await page.route("**/admin/members/missing/history",(route) => route.fulfill({ status: 404,contentType: "application/json",body: JSON.stringify({ error: "Member not found" }) }));

  await page.goto("/roster");
  await expect(page.getByRole("button",{ name: "Add member" })).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Edit" })).toHaveCount(0);
  await page.goto("/roster/A-101");
  await expect(page.getByRole("heading",{ level: 1,name: "Avery Stone" })).toBeVisible();
  await expect(page.getByText("Active roster member",{ exact: true })).toBeVisible();
  await expect(page.getByText("123456789012",{ exact: true })).toBeVisible();
  await expect(page.getByRole("table",{ name: "Complete attendance history" })).toContainText("Build session with a deliberately long name");
  await expect(page.getByText("No anomalous scans",{ exact: true })).toBeVisible();
  await expect(page.getByRole("button",{ name: "Edit" })).toHaveCount(0);

  await page.goto("/roster/missing");
  await expect(page.locator("main h1")).toHaveCount(1);
  await expect(page.getByRole("heading",{ level: 1,name: "Member detail" })).toBeVisible();
  await expect(page.getByRole("heading",{ level: 2,name: "Member unavailable" })).toBeVisible();
  await expect(page.getByRole("link",{ name: "Return to roster" })).toBeVisible();
});

// Roster attendance coverage keeps its reporting data local to these tests; shared fixtures remain unchanged.
const rateMembers=[...roster,{ id: "member-3",memberId: "A-103",firstName: "Jordan",lastName: "Lee",active: 1 }];
const rateMeetings=[
  { id: "old",title: "Preserved session",startsAt: "2020-01-01T10:00:00Z",endsAt: "2020-01-01T11:00:00Z",required: true,attendanceWeight: 2 },
  { id: "present",title: "Weighted session",startsAt: "2020-02-01T10:00:00Z",endsAt: "2020-02-01T11:00:00Z",required: true,attendanceWeight: 0.5 },
  { id: "excused",title: "Optional session",startsAt: "2020-02-02T10:00:00Z",endsAt: "2020-02-02T11:00:00Z",required: false,attendanceWeight: 1 },
  { id: "pre-start",title: "Before participation",startsAt: "2020-02-03T10:00:00Z",endsAt: "2020-02-03T11:00:00Z",required: true,attendanceWeight: 4 },
  { id: "future",title: "Future session",startsAt: "2099-01-01T10:00:00Z",endsAt: "2099-01-01T11:00:00Z",required: true,attendanceWeight: 8 },
  { id: "test",title: "Test session",startsAt: "2020-02-04T10:00:00Z",endsAt: "2020-02-04T11:00:00Z",required: true,attendanceWeight: 8,isTest: true },
];
async function useRateData(page: Page,baseline="",role: Role="admin") {
  await useReferenceContext(page,role);
  await page.route("**/admin/members",(route) => route.fulfill({ json: { members: rateMembers,discordConfigured: true } }));
  await page.route("**/meetings",(route) => route.fulfill({ json: { meetings: rateMeetings,attendanceReportingStartsOn: baseline||null } }));
  await page.route("**/attendance?**",(route) => {
    const url=new URL(route.request().url()); const id=url.searchParams.get("meetingId");
    expect(url.searchParams.get("includeInactive")).toBe("1");
    expect(["old","present","excused","pre-start"]).toContain(id);
    const attendance=rateMembers.map((member) => ({ memberId: member.id,externalId: member.memberId,firstName: member.firstName,lastName: member.lastName,disposition: member.id==="member-2"? "absent":member.id==="member-3"||id==="pre-start"? "not_required":id==="present"? "present":id==="excused"? "excused":"absent" }));
    return route.fulfill({ json: { attendance } });
  });
}

for(const viewport of dashboardConformanceReferences.viewports) for(const theme of dashboardConformanceReferences.themes) for(const baseline of ["","2020-02-01"]) {
  test(`roster primary attendance matches Reports ${baseline? "baseline":"history"} at ${viewport.width}x${viewport.height} ${theme}`,async ({ page },testInfo) => {
    await page.setViewportSize(viewport);
    await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme",savedTheme),theme);
    const role=theme==="dark"? "operator":"admin";
    await useRateData(page,baseline,role);
    await page.goto("/reports");
    const reportRow=page.locator(".report-row:not(.header)").filter({ hasText: "Avery Stone" });
    const expected=baseline? "33%":"14%";
    await expect(reportRow.getByRole("cell").nth(1)).toHaveText(expected);
    await expect(reportRow.getByRole("cell").nth(2)).toHaveText(baseline? "100%":"20%");
    await page.goto("/roster");
    await expect(page.locator("main h1")).toHaveCount(1);
    const rosterRow=page.getByRole("row").filter({ hasText: "Avery Stone" });
    await expect(rosterRow.locator(".roster-attendance-rate")).toHaveText(expected);
    await expect(page.getByRole("row").filter({ hasText: "Jordan Lee" }).locator(".roster-attendance-rate")).toHaveText("No eligible meetings");
    await expect(page.locator(".roster-attendance-help")).toContainText(baseline? "operational baseline":"preserved completed history");
    const show=page.getByLabel("Show"); await show.focus();
    expect(await show.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.keyboard.press("a"); await page.keyboard.press("Enter");
    // selectOption is deterministic across platform native select implementations.
    await show.selectOption("all");
    await expect(page.getByRole("row").filter({ hasText: "Morgan Diaz" }).locator(".roster-attendance-rate")).toHaveText("0%");
    await expect(page.getByRole("button",{ name: "Edit",exact: true })).toHaveCount(role==="admin"? 3:0);
    await page.getByLabel("Search roster").fill("A-101");
    await expect(page.locator(".roster-row:not(.header)")).toHaveCount(1);
    const link=page.getByRole("link",{ name: "Avery Stone" }); await link.focus();
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await page.getByLabel("Search roster").fill("");
    await expectResponsiveFit(page);
    await page.screenshot({ path: testInfo.outputPath("roster-attendance.png"),fullPage: true });
    await link.focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/roster\/A-101$/);
  });
}

test("roster attendance exposes loading, failed requests, retry, missing rows and zero completed meetings",async ({ page }) => {
  await useRateData(page);
  let release!: () => void; const wait=new Promise<void>((resolve) => { release=resolve; });
  await page.route("**/attendance?**",async (route) => { await wait; await route.fulfill({ status: 503,json: { error: "Unavailable" } }); });
  await page.goto("/roster");
  await expect(page.locator(".roster-attendance-rate").first()).toHaveText("Loading\u2026");
  await expect(page.getByRole("link",{ name: "Avery Stone" })).toBeVisible();
  release();
  await expect(page.locator(".roster-attendance-rate").first()).toHaveText("Unavailable");
  await page.unroute("**/attendance?**");
  await page.route("**/attendance?**",(route) => route.fulfill({ json: { attendance: [] } }));
  const retry=page.getByRole("button",{ name: "Retry attendance rates" }); await retry.focus(); await page.keyboard.press("Enter");
  await expect(retry).toHaveCount(0);
  await expect(page.locator(".roster-attendance-rate").first()).toHaveText("Unavailable");
  await page.route("**/meetings",(route) => route.fulfill({ json: { meetings: [] } }));
  await page.reload();
  await expect(page.locator(".roster-attendance-rate").first()).toHaveText("No eligible meetings");
});

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
  await page.route("**/labels",(route) => route.fulfill({ json: { labels: [{ id: "mentor",name: "Mentor",active: 1,formulaEnabled: 1 }],history: [],periods: [],today: "2026-09-22" } }));
  await page.route("**/reports/attendance*",(route) => {
    const from=new URL(route.request().url()).searchParams.get("from"); const meetings=from&&from>"2026-09-01"? []:[{ id: "meeting-1",title: "Build session",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",attendanceClosesAt: "2026-09-01T20:30:00Z",required: true,attendanceWeight: 1,audienceMode: "all",audienceLabelIds: [] }];
    const members=meetings.length? roster.map((member,index) => ({ member,currentLabelIds: [],rows: [{ meetingId: "meeting-1",memberId: member.id,disposition: index? "absent":"present",eligibility: "required",policy: "standard",rateEligible: true,attended: !index,weight: 1,audience: "All",memberLabelIds: [] }],policy: "standard",present: index? 0:1,primaryTotal: 1,adjustedTotal: 1,rate: index? 0:100,adjustedRate: index? 0:100,pooledRate: null,weeks: [],belowTargetWeeks: [] })) : [];
    return route.fulfill({ json: { meetings,members,labels: [{ id: "mentor",name: "Mentor",active: 1,formulaEnabled: 1 }],baseline: null,timeZone: "UTC" } });
  });
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

async function expectLabelButtonTheme(page: Page,name: string,kind: "secondary"|"primary"|"danger") {
  const button=page.locator(".member-labels-panel").getByRole("button",{ name,exact: true });
  await expect(button).toBeVisible();
  const colors=await button.evaluate((element,role) => {
    const app=element.closest(".app")!; const probe=document.createElement("button");
    const tokens=role==="primary"? ["--primary","--on-primary","--primary"]:role==="danger"? ["--ui-error-surface","--ui-error","--ui-error"]:["--ui-surface-subtle","--ui-text","--ui-border"];
    probe.style.backgroundColor=`var(${tokens[0]})`; probe.style.color=`var(${tokens[1]})`; probe.style.borderColor=`var(${tokens[2]})`; probe.style.borderStyle="solid"; probe.style.borderRadius="var(--radius-control)";
    app.append(probe); const actual=getComputedStyle(element); const expected=getComputedStyle(probe);
    const result={ actual: [actual.backgroundColor,actual.color,actual.borderTopColor,actual.borderTopLeftRadius],expected: [expected.backgroundColor,expected.color,expected.borderTopColor,expected.borderTopLeftRadius],height: element.getBoundingClientRect().height };
    probe.remove(); return result;
  },kind);
  expect(colors.actual).toEqual(colors.expected);
  expect(colors.height).toBeGreaterThanOrEqual(44);
}

for(const viewport of dashboardConformanceReferences.viewports) {
  for(const theme of dashboardConformanceReferences.themes) {
    test(`Roster actions and attendance retry follow ${theme} theme at ${viewport.width}x${viewport.height}`,async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme",savedTheme),theme);
      await useReferenceContext(page);
      let failAttendance=true;
      await page.unroute("**/reports/attendance*");
      await page.route("**/reports/attendance*",(route) => failAttendance ? route.fulfill({ status: 503,json: { error: "Unavailable" } }) : route.fulfill({ json: { meetings: [],members: [],labels: [],baseline: null,timeZone: "UTC" } }));
      await page.goto("/roster");
      const add=page.getByRole("button",{ name: "Add member",exact: true });
      const bulk=page.getByRole("button",{ name: "Bulk edit",exact: true });
      const addBox=await add.boundingBox(); const bulkBox=await bulk.boundingBox();
      expect(addBox).not.toBeNull(); expect(bulkBox).not.toBeNull();
      expect(addBox!.x+addBox!.width).toBeLessThanOrEqual(bulkBox!.x);
      expect(Math.abs(addBox!.y+addBox!.height/2-bulkBox!.y-bulkBox!.height/2)).toBeLessThan(2);
      await expect(page.getByText("Attendance rates could not be loaded.")).toBeVisible();
      const retry=page.getByRole("button",{ name: "Retry attendance rates" });
      const style=await retry.evaluate((element) => {
        const app=element.closest(".app")!; const probe=document.createElement("button");
        probe.style.backgroundColor="var(--ui-surface-subtle)"; probe.style.color="var(--ui-text)";
        probe.style.border="1px solid var(--ui-border)"; probe.style.borderRadius="var(--radius-control)";
        app.append(probe); const actual=getComputedStyle(element); const expected=getComputedStyle(probe);
        const result={ actual: [actual.backgroundColor,actual.color,actual.borderTopColor,actual.borderTopLeftRadius],expected: [expected.backgroundColor,expected.color,expected.borderTopColor,expected.borderTopLeftRadius],height: element.getBoundingClientRect().height };
        probe.remove(); return result;
      });
      expect(style.actual).toEqual(style.expected);
      expect(style.height).toBeGreaterThanOrEqual(44);
      await retry.focus();
      expect(await retry.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      failAttendance=false;
      await retry.click();
      await expect(retry).toHaveCount(0);
      await expectResponsiveFit(page);
    });
  }
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
    test("attendance label controls follow the active theme at " + viewport.width + "x" + viewport.height + " in " + theme + " mode",async ({ page },testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme",savedTheme),theme);
      await useReferenceContext(page);
      await page.route("**/attendance/policy",(route) => route.fulfill({ json: { labels: [{ id: "mentor",name: "Mentor",active: 1 },{ id: "drive",name: "Drive Team",active: 0 }],rules: [{ id: "fall",labelId: "mentor",startsOn: "2026-09-01",endsOn: "2026-09-30",ruleType: "weekly_count",meetingsPerWeek: 2,thresholdPercent: null }],recentDays: 30 } }));
      await page.route("**/attendance/policy/preview",(route) => route.fulfill({ json: { impact: [],previewToken: "policy-preview" } }));
      await page.route("**/labels/membership/preview",(route) => route.fulfill({ json: { changes: [{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "2026-09-01" }],impact: [],previewToken: "label-preview" } }));
      await page.goto("/settings/attendance");
      for(const name of ["Create label","Preview new rule","Preview window change"]) await expectLabelButtonTheme(page,name,"primary");
      for(const name of ["Retire","Preview removal"]) await expectLabelButtonTheme(page,name,"danger");
      await expectLabelButtonTheme(page,"Restore","secondary");
      await page.getByRole("button",{ name: "Preview removal" }).click();
      await expectLabelButtonTheme(page,"Apply attendance policy","primary");
      await expectLabelButtonTheme(page,"Back","secondary");
      await expectResponsiveFit(page);
      if(viewport.width===390&&theme==="dark") await page.screenshot({ path: testInfo.outputPath("attendance-settings-dark-mobile.png"),fullPage: true });
      await page.goto("/roster");
      await expectLabelButtonTheme(page,"Preview CSV import","primary");
      const chooser=page.getByLabel("Label changes CSV file");
      const fileStyle=await chooser.evaluate((element) => {
        const app=element.closest(".app")!; const probe=document.createElement("button"); probe.style.backgroundColor="var(--ui-surface)"; probe.style.color="var(--ui-text)"; app.append(probe);
        const actual=getComputedStyle(element,"::file-selector-button"); const expected=getComputedStyle(probe);
        const result={ background: actual.backgroundColor,color: actual.color,expectedBackground: expected.backgroundColor,expectedColor: expected.color,minHeight: parseFloat(actual.minHeight) };
        probe.remove(); return result;
      });
      expect(fileStyle.background).toBe(fileStyle.expectedBackground);
      expect(fileStyle.color).toBe(fileStyle.expectedColor);
      expect(fileStyle.minHeight).toBeGreaterThanOrEqual(44);
      await page.getByLabel("CSV contents").fill("memberId,label,action,effectiveDate\nA-101,Mentor,add,2026-09-01");
      await page.getByRole("button",{ name: "Preview CSV import" }).click();
      await expectLabelButtonTheme(page,"Apply label changes","primary");
      await expectLabelButtonTheme(page,"Back","secondary");
      await expectResponsiveFit(page);
      if(viewport.width===390&&theme==="dark") await page.screenshot({ path: testInfo.outputPath("attendance-label-actions-dark-mobile.png"),fullPage: true });
    });
  }
}

for(const viewport of dashboardConformanceReferences.viewports) {
  for(const theme of dashboardConformanceReferences.themes) {
    test(`member anomaly metric conforms at ${viewport.width}x${viewport.height} in ${theme} mode`,async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme",savedTheme),theme);
      await useReferenceContext(page,"operator");
      await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ member: roster[0],labels: [],labelHistory: [],attendancePolicy: null,meanAnomalyMinutes: 15,history: [{ meetingId: "meeting-1",title: "Build session",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",checkedInAt: "2026-09-01T18:12:00Z",checkedOutAt: "2026-09-01T19:42:00Z",disposition: "present" }] }) }));
      await page.goto("/roster/A-101");
      await expect(page.getByText("Mean anomalous time",{ exact: true })).toBeVisible();
      await expect(page.getByText("15 minutes",{ exact: true })).toBeVisible();
      await expectResponsiveFit(page);
    });
  }
}

test("saved report views, preserved-history empty state, and CSV export remain operable",async ({ page }) => {
  await useReferenceContext(page);
  await page.route("**/exports/attendance.csv?**",(route) => route.fulfill({ status: 200,contentType: "text/csv",body: "memberId,disposition\nA-101,present\n" }));
  await page.goto("/reports");

  await expect(page.getByLabel("Reporting period")).toHaveValue("all");
  await expect(page.getByLabel("Reporting period")).toBeVisible();
  await page.getByRole("button",{ name: "Use saved view" }).click();
  await expect(page.getByRole("status")).toHaveText("No saved report view is available in this browser.");
  await page.getByLabel("Meeting type").selectOption("optional");
  await page.getByRole("button",{ name: "Save this view" }).click();
  await page.getByLabel("Meeting type").selectOption("required");
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

  await page.getByRole("button",{ name: "Edit",exact: true }).first().click();
  const editDialog=page.getByRole("dialog",{ name: "Edit roster member" });
  await expect(editDialog.getByRole("button",{ name: "Close member editor" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(editDialog.getByRole("button",{ name: "Save member" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editDialog).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Edit",exact: true }).first()).toBeFocused();
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
  await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ member: roster[0],labels: [],labelHistory: [],attendancePolicy: null,meanAnomalyMinutes: null,history: [{ meetingId: "meeting-1",title: "Build session with a deliberately long name",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",checkedInAt: "2026-09-01T18:05:00Z",checkedOutAt: "2026-09-01T19:58:00Z",disposition: "present" }] }) }));
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

// Policy responses are calculated by the Worker. The browser must display the same rate in each view.
test("server policy rates agree across Reports and Roster and optional meetings stay out of standard rates",async ({ page }) => {
  await useReferenceContext(page);
  const meeting={ id: "required",title: "Required build",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",attendanceClosesAt: "2026-09-01T20:30:00Z",required: true,attendanceWeight: 1,audienceMode: "all",audienceLabelIds: [] };
  await page.route("**/reports/attendance*",(route) => route.fulfill({ json: { meetings: [meeting,{ ...meeting,id: "optional",title: "Open practice",required: false }],members: [{ member: roster[0],currentLabelIds: [],rows: [],policy: "standard",present: 0,primaryTotal: 1,adjustedTotal: 1,rate: 0,adjustedRate: 0,pooledRate: null,weeks: [],belowTargetWeeks: [] }],labels: [],baseline: null,timeZone: "UTC" } }));
  await page.goto("/reports");
  await expect(page.locator(".report-row:not(.header)").filter({ hasText: "Avery Stone" }).getByRole("cell").nth(1)).toContainText("0%");
  await page.goto("/roster");
  await expect(page.getByRole("row").filter({ hasText: "Avery Stone" }).locator(".roster-attendance-rate")).toHaveText("0%");
});

test("Admin previews and applies a separate dated label CSV; Operator sees labels without mutation controls",async ({ page }) => {
  await useReferenceContext(page);
  let applied=false;
  await page.route("**/labels/membership/preview",async (route) => {
    const body=route.request().postDataJSON() as { changes: Array<{ memberId: string; label: string; action: string; effectiveDate: string }> };
    expect(body.changes).toEqual([{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "2026-09-01" }]);
    await route.fulfill({ json: { changes: body.changes,impact: [{ memberId: "A-101",beforeRate: 50,afterRate: 100,beforePolicy: "standard",afterPolicy: "weekly",affectedCompletedMeetings: 2 }],previewToken: "preview" } });
  });
  await page.route("**/labels/membership/apply",async (route) => { expect(route.request().postDataJSON()).toMatchObject({ previewToken: "preview" }); applied=true; await route.fulfill({ json: { applied: 1 } }); });
  await page.goto("/roster");
  await page.getByLabel("CSV contents").fill("memberId,label,action,effectiveDate\nA-101,Mentor,add,2026-09-01");
  await page.getByRole("button",{ name: "Preview CSV import" }).click();
  await expect(page.getByRole("heading",{ name: "Review dated label changes" })).toBeVisible();
  await expect(page.getByText(/A-101: 50% to 100%/)).toBeVisible();
  await page.getByRole("button",{ name: "Apply label changes" }).click();
  expect(applied).toBe(true);
  await useReferenceContext(page,"operator");
  await page.reload();
  await expect(page.getByRole("heading",{ name: "Bulk label changes" })).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Preview CSV import" })).toHaveCount(0);
});

test("Roster quick labels, CSV defaults, and bulk selection preview changes before applying",async ({ page }) => {
  await page.setViewportSize({ width: 390,height: 844 });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme","dark"));
  await useReferenceContext(page);
  const labelRequests: unknown[]=[]; let statusApplied=false;
  await page.route("**/labels/membership/preview",async (route) => {
    const body=route.request().postDataJSON() as { changes: Array<{ memberId: string; label: string; action: string; effectiveDate: string }> };
    labelRequests.push(body.changes);
    await route.fulfill({ json: { changes: body.changes.map((change) => ({ ...change,action: change.action || "add",effectiveDate: change.effectiveDate || "2026-09-23" })),impact: [],previewToken: "label-preview" } });
  });
  await page.route("**/labels/membership/apply",(route) => route.fulfill({ json: { applied: 1 } }));
  await page.route("**/admin/members/bulk/preview",(route) => route.fulfill({ json: { members: [{ memberId: "A-101",name: "Avery Stone",active: true,willChange: true },{ memberId: "A-102",name: "Morgan Diaz",active: false,willChange: false }],changed: 1,previewToken: "status-preview" } }));
  await page.route("**/admin/members/bulk/apply",(route) => { expect(route.request().postDataJSON()).toMatchObject({ memberIds: ["member-1","member-2"],active: false,previewToken: "status-preview" }); statusApplied=true; return route.fulfill({ json: { applied: 1 } }); });
  await page.goto("/roster");
  await page.getByRole("button",{ name: "Edit",exact: true }).first().click();
  const dialog=page.getByRole("dialog",{ name: "Edit roster member" });
  await expect(dialog.getByText("Current labels: None")).toBeVisible();
  await dialog.getByText("Change labels").click();
  await dialog.getByRole("checkbox",{ name: "Mentor" }).check();
  await dialog.getByRole("button",{ name: "Preview label changes" }).click();
  await expect(dialog.getByText("2026-09-23",{ exact: true })).toBeVisible();
  await dialog.getByRole("button",{ name: "Apply label changes" }).click();
  await dialog.getByRole("button",{ name: "Close member editor" }).click();
  await page.getByLabel("CSV contents").fill("memberId,label\nA-101,Mentor");
  await page.getByRole("button",{ name: "Preview CSV import" }).click();
  await expect(page.getByRole("heading",{ name: "Review dated label changes" })).toBeVisible();
  expect(labelRequests).toContainEqual([{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "" }]);
  await page.getByRole("button",{ name: "Back" }).click();
  await page.getByLabel("Show").selectOption("all");
  await page.getByRole("button",{ name: "Bulk edit" }).click();
  await page.getByRole("checkbox",{ name: "Select all shown members" }).check();
  await expect(page.getByText("2 members selected.",{ exact: false })).toBeVisible();
  await page.getByLabel("Action").selectOption("deactivate");
  await page.getByRole("button",{ name: "Preview bulk change" }).click();
  await expect(page.getByText("1 members will change roster status",{ exact: false })).toBeVisible();
  await page.getByRole("button",{ name: "Apply bulk change" }).click();
  expect(statusApplied).toBe(true);
  await expect(page.getByRole("region",{ name: "Bulk edit" })).toContainText("0 members selected");
  await page.getByRole("checkbox",{ name: "Select all shown members" }).check();
  await page.getByLabel("Action").selectOption("add");
  await page.getByRole("region",{ name: "Bulk edit" }).getByRole("combobox",{ name: "Label" }).selectOption("mentor");
  await page.getByRole("button",{ name: "Preview bulk change" }).click();
  expect(labelRequests).toContainEqual([{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "" },{ memberId: "A-102",label: "Mentor",action: "add",effectiveDate: "" }]);
  await expect(page.getByRole("region",{ name: "Bulk change preview" })).toContainText("2 dated label changes");
  await expectResponsiveFit(page);
});

test("Admin assigns one member label from the profile while Operator only views history",async ({ page }) => {
  await useReferenceContext(page);
  await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ json: { member: roster[0],labels: [{ id: "mentor",name: "Mentor",active: 1 }],labelHistory: [],attendancePolicy: null,meanAnomalyMinutes: null,history: [] } }));
  await page.route("**/labels/membership/preview",(route) => route.fulfill({ json: { changes: [{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "2026-09-22" }],impact: [],previewToken: "one-member" } }));
  await page.goto("/roster/A-101");
  await expect(page.getByRole("heading",{ name: "Assign member labels" })).toBeVisible();
  await page.getByRole("combobox",{ name: "Label",exact: true }).selectOption("mentor");
  await page.getByRole("button",{ name: "Preview label change" }).click();
  await expectLabelButtonTheme(page,"Apply label changes","primary");
  await useReferenceContext(page,"operator");
  await page.reload();
  await expect(page.getByRole("heading",{ name: "Assign member labels" })).toHaveCount(0);
  await expect(page.getByRole("heading",{ name: "Label history" })).toBeVisible();
});

test("report label group offers current and historical views and CSV uses visible filters",async ({ page }) => {
  await useReferenceContext(page);
  let exported="";
  await page.route("**/exports/attendance.csv?**",(route) => { exported=route.request().url(); return route.fulfill({ status: 200,contentType: "text/csv",body: "memberId,eligibility\nA-101,weekly\n" }); });
  await page.goto("/reports");
  await page.getByLabel("Label group").selectOption("mentor");
  await page.getByLabel("Group view").selectOption("historical");
  const download=page.waitForEvent("download");
  await page.getByRole("button",{ name: "Download attendance CSV" }).click();
  await download;
  expect(exported).toContain("labelId=mentor");
  expect(exported).toContain("membership=historical");
});

for(const view of [{ width: 1280,height: 800,theme: "light" },{ width: 390,height: 844,theme: "dark" }]) {
  test(`Discord label role sync preview and status work at ${view.width}px in ${view.theme} mode`,async ({ page }) => {
    await page.setViewportSize({ width: view.width,height: view.height });
    await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme",theme),view.theme);
    await useReferenceContext(page);
    await page.route("**/attendance/policy",(route) => route.fulfill({ json: { labels: [{ id: "frc-321",name: "FRC 321",active: 1 }],rules: [],recentDays: 30 } }));
    await page.route("**/admin/integrations/discord/label-roles",(route) => route.fulfill({ json: { integrationAvailable: true,mappings: [{ labelId: "frc-321",labelName: "FRC 321",roleId: "423456789012345678",roleName: "FRC 321",health: "ready",createdAt: "2026-09-23T00:00:00Z" }] } }));
    await page.route("**/admin/integrations/discord/label-roles/preview",(route) => route.fulfill({ json: { previewId: "preview-1",expiresAt: new Date(Date.now()+60000).toISOString(),labelId: "frc-321",roleName: "FRC 321",memberCount: 4,additions: [{ discordUserId: "111111111111111111",displayName: "Avery",memberId: "A-101" }],removals: [{ discordUserId: "222222222222222222",displayName: "Unpaired" }],unpaired: [{ memberId: "A-102",name: "Morgan Diaz" }],absent: [],inactive: [] } }));
    await page.route("**/admin/integrations/discord/label-roles/apply",(route) => route.fulfill({ json: { jobId: "job-1",status: "pending",additions: 1,removals: 1 } }));
    await page.route("**/admin/integrations/discord/label-role-jobs/job-1",(route) => route.fulfill({ json: { id: "job-1",status: "completed",updatedAt: new Date().toISOString(),items: [{ discordUserId: "111111111111111111",action: "add",status: "completed",attempts: 1 },{ discordUserId: "222222222222222222",action: "remove",status: "completed",attempts: 1 }] } }));
    await page.goto("/settings/attendance");
    await expect(page.getByRole("heading",{ name: "Discord roles" })).toBeVisible();
    await expectLabelButtonTheme(page,"Sync to Discord","primary");
    await page.getByRole("button",{ name: "Sync to Discord" }).click();
    await expect(page.getByRole("heading",{ name: "Review role changes for FRC 321" })).toBeVisible();
    await expect(page.getByText("Unpaired · 222222222222222222")).toBeVisible();
    await expectLabelButtonTheme(page,"Confirm full-server sync","primary");
    await expectResponsiveFit(page);
    await page.getByRole("button",{ name: "Confirm full-server sync" }).click();
    await expect(page.getByRole("heading",{ name: "Role sync status" })).toBeVisible();
    await expect(page.getByText("2 completed, 0 pending, 0 failed.")).toBeVisible();
    await useReferenceContext(page,"operator"); await page.reload();
    await expect(page.getByRole("heading",{ name: "Discord roles" })).toBeVisible();
    await expect(page.getByRole("button",{ name: "Sync to Discord" })).toHaveCount(0);
    await expect(page.getByRole("button",{ name: "Unlink" })).toHaveCount(0);
    await expectResponsiveFit(page);
  });
}

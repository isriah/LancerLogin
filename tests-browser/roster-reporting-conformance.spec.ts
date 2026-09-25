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

const reportColumns=[
  { key: "member",label: "Member",group: "Roster",sortable: true,filterKind: "text" as const },
  { key: "member_id",label: "Member ID",group: "Roster",sortable: true,filterKind: "text" as const },
  { key: "email",label: "Email",group: "Roster",sortable: true,filterKind: "text" as const },
  { key: "discord_id",label: "Discord ID",group: "Roster",sortable: true,filterKind: "text" as const },
  { key: "active_status",label: "Roster status",group: "Roster",sortable: true,filterKind: "text" as const },
  { key: "current_labels",label: "Current labels",group: "Roster",sortable: false,filterKind: "text" as const },
  { key: "attendance_required_from",label: "Attendance starts",group: "Roster",sortable: true,filterKind: "text" as const },
  { key: "regular_attendance",label: "Regular attendance",group: "Regular attendance",sortable: true,filterKind: "number" as const },
  { key: "regular_weighted_present",label: "Regular weighted present",group: "Regular attendance",sortable: true,filterKind: "number" as const },
  { key: "regular_weighted_eligible",label: "Regular weighted eligible",group: "Regular attendance",sortable: true,filterKind: "number" as const },
  { key: "regular_period",label: "Regular reporting period",group: "Regular attendance",sortable: false,filterKind: "text" as const },
  { key: "assigned_policies",label: "Assigned policies",group: "Policies",sortable: false,filterKind: "text" as const },
  { key: "policy_history",label: "Policy history",group: "Policies",sortable: false,filterKind: "text" as const },
  { key: "present_count",label: "Present count",group: "Attendance detail",sortable: true,filterKind: "number" as const },
  { key: "present_dates",label: "Present dates",group: "Attendance detail",sortable: false,filterKind: "text" as const },
  { key: "absent_count",label: "Absent count",group: "Attendance detail",sortable: true,filterKind: "number" as const },
  { key: "absent_dates",label: "Absent dates",group: "Attendance detail",sortable: false,filterKind: "text" as const },
  { key: "excused_count",label: "Excused count",group: "Attendance detail",sortable: true,filterKind: "number" as const },
  { key: "excused_dates",label: "Excused dates",group: "Attendance detail",sortable: false,filterKind: "text" as const },
  ...["official_policy_result","official_policy_status","official_policy_target","official_policy_type","official_policy_excused","official_policy_period","report_policy_result","report_policy_status","report_policy_target","report_policy_period"].map((key) => ({ key,label: key.replaceAll("_"," "),group: "Policies",sortable: !key.endsWith("period"),filterKind: key.endsWith("result")||key.endsWith("target") ? "number" as const : "text" as const,requiresLabel: true })),
  { key: "report_policy_summary",label: "Report-period policies",group: "Policies",sortable: false,filterKind: "text" as const },
];
const defaultReportDefinition={ version: 1 as const,period: { type: "all" as const },roster: "active" as const,meetingType: "all" as const,labelIds: [] as string[],labelMatch: "any" as const,membership: "current" as const,columns: [{ key: "member" },{ key: "regular_attendance" },{ key: "assigned_policies" }],columnFilters: [] as { column: { key: string; labelId?: string }; operator: "contains"|"minimum"; value: string }[],sort: { column: { key: "member" },direction: "asc" as const } };
const reportColumnId=(column: { key: string; labelId?: string }) => `${column.key}${column.labelId ? `:${column.labelId}` : ""}`;
const reportColumnLabel=(column: { key: string; labelId?: string }) => `${column.labelId ? "Mentor - " : ""}${reportColumns.find((item) => item.key===column.key)?.label ?? column.key}`;

function referenceAttendanceReport(from?: string) {
  const meetings=from&&from>"2026-09-01"? []:[{ id: "meeting-1",title: "Build session",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",attendanceClosesAt: "2026-09-01T20:30:00Z",required: true,attendanceWeight: 1,audienceMode: "all",audienceLabelIds: [] }];
  const members=meetings.length? roster.map((member,index) => ({ member,currentLabelIds: index ? []:["mentor"],rows: [{ meetingId: "meeting-1",memberId: member.id,disposition: index? "absent":"present",eligibility: "required",policy: "standard",rateEligible: true,regularEligible: true,attended: !index,weight: 1,regularWeight: 1,audience: "All",memberLabelIds: index ? []:["mentor"] }],regularAttendance: { rate: index? 0:100,attended: index? 0:1,required: 1,from: member.attendanceRequiredFrom,to: "2026-09-22" },currentCompliances: [],currentCompliance: { labelId: null,labelName: null,ruleId: null,ruleType: null,excusedHandling: null,status: "no_rule",threshold: null,from: "2026-08-24",to: "2026-09-22",rate: null,unadjustedRate: null,attended: 0,required: 0 },historySummaries: [],policy: "standard",present: index? 0:1,primaryTotal: 1,adjustedTotal: 1,rate: index? 0:100,adjustedRate: index? 0:100,pooledRate: null,weeks: [],belowTargetWeeks: [] })) : [];
  return { meetings,members,labels: [{ id: "mentor",name: "Mentor",active: 1,formulaEnabled: 1 }],baseline: null,timeZone: "UTC" };
}

async function useReferenceContext(page: Page,role: Role="admin",debugMode=false) {
  let pinnedIds=["class-report"];
  let savedReports=[
    { id: "class-report",ownerUserId: "admin-1",scope: "shared",name: "Class attendance",definition: structuredClone(defaultReportDefinition),revision: 1,createdAt: "2026-09-01T00:00:00Z",updatedAt: "2026-09-01T00:00:00Z",warnings: [],errors: [] },
    { id: "dates-report",ownerUserId: "admin-1",scope: "personal",name: "Attendance dates",definition: { ...structuredClone(defaultReportDefinition),columns: [{ key: "member" },{ key: "absent_dates" }],sort: { column: { key: "member" },direction: "asc" as const } },revision: 1,createdAt: "2026-09-02T00:00:00Z",updatedAt: "2026-09-02T00:00:00Z",warnings: [],errors: [] },
  ];
  await page.route("**/setup/status",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ configured: true,installation: { authMode: "local" },settings: referenceSettings }) }));
  await page.route("**/auth/session",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ user: { role,debugMode } }) }));
  await page.route("**/integrations/capabilities",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ integrations: { google: { enabled: true,configured: true },resend: { enabled: false,configured: false },discord: { enabled: true,configured: true } } }) }));
  await page.route("**/admin/members",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ members: roster,discordConfigured: true }) }));
  await page.route("**/admin/roster/history",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ imports: [{ createdAt: "2026-09-03T18:00:00Z",count: 2,mode: "merge",deactivated: 0 }] }) }));
  await page.route("**/labels",(route) => route.fulfill({ json: { labels: [{ id: "mentor",name: "Mentor",active: 1,formulaEnabled: 1 }],history: [],periods: [],today: "2026-09-22" } }));
  await page.route("**/reports/attendance*",(route) => {
    const from=new URL(route.request().url()).searchParams.get("from") ?? undefined;
    return route.fulfill({ json: referenceAttendanceReport(from) });
  });
  await page.route("**/reports/catalog",(route) => route.fulfill({ json: { columns: reportColumns,labels: [{ id: "mentor",name: "Mentor",active: 1 }],baseline: null,timeZone: "UTC",defaultDefinition: defaultReportDefinition,role } }));
  await page.route("**/reports/views/*",async (route) => {
    const id=decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!); const report=savedReports.find((item) => item.id===id);
    if(!report) return route.fulfill({ status: 404,json: { error: "Report not found" } });
    if(route.request().method()==="DELETE") { savedReports=savedReports.filter((item) => item.id!==id); pinnedIds=pinnedIds.filter((item) => item!==id); return route.fulfill({ json: { deleted: true } }); }
    const body=route.request().postDataJSON() as { name: string; scope: "personal"|"shared"; definition: typeof defaultReportDefinition; revision: number };
    if(body.revision!==report.revision) return route.fulfill({ status: 409,json: { error: "This report changed after you opened it." } });
    Object.assign(report,{ name: body.name,scope: body.scope,definition: body.definition,revision: report.revision+1,updatedAt: "2026-09-22T00:00:00Z" });
    return route.fulfill({ json: { report: { ...report,pinnedPosition: pinnedIds.indexOf(report.id) } } });
  });
  await page.route("**/reports/views",async (route) => {
    if(route.request().method()==="GET") return route.fulfill({ json: { reports: savedReports.map((report) => ({ ...report,pinnedPosition: pinnedIds.includes(report.id)?pinnedIds.indexOf(report.id):null })) } });
    const body=route.request().postDataJSON() as { name: string; scope: "personal"|"shared"; definition: typeof defaultReportDefinition }; const report={ id: `report-${savedReports.length+1}`,ownerUserId: "admin-1",scope: body.scope,name: body.name,definition: body.definition,revision: 1,createdAt: "2026-09-22T00:00:00Z",updatedAt: "2026-09-22T00:00:00Z",warnings: [],errors: [] };
    savedReports.push(report); pinnedIds.push(report.id); return route.fulfill({ status: 201,json: { report: { ...report,pinnedPosition: pinnedIds.length-1 } } });
  });
  await page.route("**/reports/tabs",async (route) => { const body=route.request().postDataJSON() as { reportIds: string[] }; pinnedIds=[...body.reportIds]; return route.fulfill({ json: body }); });
  await page.route("**/reports/leaderboard*",(route) => { const url=new URL(route.request().url()); const data=referenceAttendanceReport(url.searchParams.get("from") ?? undefined); return route.fulfill({ json: { ...data,pagination: { page: 1,pageSize: url.searchParams.get("pageSize")==="all"?"all":Number(url.searchParams.get("pageSize")||25),totalRows: data.members.length,totalPages: 1,rangeStart: data.members.length?1:0,rangeEnd: data.members.length },insights: { policyAlerts: [],trend: data.meetings.map((meeting) => ({ meetingId: meeting.id,title: meeting.title,startsAt: meeting.startsAt,rate: 50 })) } } }); });
  await page.route("**/reports/query",async (route) => {
    const body=route.request().postDataJSON() as { definition: typeof defaultReportDefinition; page?: number; pageSize?: number|"all" }; const columns=body.definition.columns.map((column) => ({ id: reportColumnId(column),key: column.key,label: reportColumnLabel(column),labelId: column.labelId })); const absentDates=["2026-09-01","2026-09-08","2026-09-15","2026-09-22"];
    let rows=roster.map((member,index) => ({ member: { id: member.id,memberId: member.memberId,name: `${member.firstName} ${member.lastName}` },cells: Object.fromEntries(columns.map((column) => [column.id,column.key==="member"?{ text: `${member.firstName} ${member.lastName}`,sortValue: member.lastName }:column.key==="regular_attendance"?{ text: index?"0%":"100%",sortValue: index?0:100 }:column.key==="assigned_policies"?{ text: index?"No assigned policy":"Mentor: N/A",sortValue: null }:column.key==="absent_dates"?{ text: absentDates.join("; "),sortValue: null,dates: absentDates }:{ text: index?"0":"1",sortValue: index?0:1 }] )) }));
    rows=rows.filter((row) => (body.definition.columnFilters??[]).every((filter) => { const value=row.cells[reportColumnId(filter.column)]; return filter.operator==="minimum" ? typeof value?.sortValue==="number"&&value.sortValue>=Number(filter.value) : value?.text.toLowerCase().includes(filter.value.toLowerCase()); }));
    const sortId=reportColumnId(body.definition.sort.column),direction=body.definition.sort.direction==="asc"?1:-1; rows.sort((left,right) => String(left.cells[sortId]?.sortValue??"").localeCompare(String(right.cells[sortId]?.sortValue??""))*direction);
    return route.fulfill({ json: { definition: body.definition,warnings: [],resolvedPeriod: { to: "2026-09-22" },columns,rows,pagination: { page: body.page??1,pageSize: body.pageSize??25,totalRows: rows.length,totalPages: 1,rangeStart: 1,rangeEnd: rows.length } } });
  });
  for(const path of ["report.csv","report-detail.csv"]) await page.route(`**/exports/${path}`,async (route) => route.fulfill({ status: 200,headers: { "content-type": "text/csv","content-disposition": `attachment; filename=${path}` },body: "Member,Absent dates\nAvery Stone,2026-09-01\n" }));
}

async function expectResponsiveFit(page: Page) {
  const geometry=await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped: Array.from(document.querySelectorAll<HTMLElement>("main button, main a[href], main input, main select, main textarea, main [role='status']")).flatMap((element) => {
      const style=getComputedStyle(element); const bounds=element.getBoundingClientRect();
      if(style.display==="none"||style.visibility==="hidden"||bounds.width===0||element.closest(".report-tabs,.report-table,.report-table-data,.roster-table-scroll,.member-history-scroll,.table-scroll")) return [];
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

async function expectReportButtonTheme(page: Page,name: string,primary=false) {
  const button=page.locator(".report-control-actions").getByRole("button",{ name,exact: true });
  await expect(button).toBeVisible();
  const colors=await button.evaluate((element,isPrimary) => {
    const app=element.closest(".app")!; const probe=document.createElement("button");
    probe.style.backgroundColor=`var(${isPrimary?"--primary":"--ui-surface-subtle"})`; probe.style.color=`var(${isPrimary?"--on-primary":"--ui-text"})`; probe.style.borderColor=`var(${isPrimary?"--primary":"--ui-border"})`; probe.style.borderStyle="solid"; probe.style.borderRadius="var(--radius-control)";
    app.append(probe); const actual=getComputedStyle(element),expected=getComputedStyle(probe); const result={ actual: [actual.backgroundColor,actual.color,actual.borderTopColor,actual.borderTopLeftRadius],expected: [expected.backgroundColor,expected.color,expected.borderTopColor,expected.borderTopLeftRadius],height: element.getBoundingClientRect().height }; probe.remove(); return result;
  },primary);
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
    test(`Reports and Roster conform at ${viewport.width}x${viewport.height} in ${theme} mode with reference branding`,async ({ page },testInfo) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme",savedTheme),theme);
      await useReferenceContext(page);

      await page.goto("/reports");
      await expect(page.locator(".app")).toHaveAttribute("data-theme",theme);
      await expect(page.locator(".app")).toHaveCSS("--primary",dashboardConformanceReferences.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary",dashboardConformanceReferences.brand.secondary);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.getByRole("heading",{ level: 1,name: "Reports" })).toBeVisible();
      await expect(page.getByRole("heading",{ level: 2,name: "Leaderboard controls" })).toBeVisible();
      const tabs=page.getByRole("navigation",{ name: "Report pages" });
      await expect(tabs.getByRole("button",{ name: "Leaderboard",exact: true })).toBeVisible();
      await expect(tabs.getByRole("button",{ name: "Class attendance",exact: true })).toBeVisible();
      await expect(tabs.getByText("Browse reports",{ exact: true })).toBeVisible();
      await expect(tabs.getByRole("button",{ name: "Create report" })).toBeVisible();
      const reportInfo=page.locator(".report-filters").getByRole("button",{ name: "More information" });
      await reportInfo.locator(".info-tip-glyph").hover();
      await expect(page.locator(".info-tip-content").filter({ hasText: "Choose the period, meetings, roster" })).toBeVisible();
      const controls=page.locator(".report-filters");
      await expect(controls.locator(".report-control-actions")).toHaveCount(0);
      await expect(page.locator(".report-action-card")).toHaveCount(0);
      await expect(page.getByRole("table",{ name: "Attendance leaderboard" })).toBeVisible();
      await expect(page.getByRole("img",{ name: /Team regular attendance trend:/ })).toBeVisible();
      const leaderboardHeading=page.locator(".leaderboard-heading .info-heading h2");
      const leaderboardInfo=page.locator(".leaderboard-heading .info-tip-glyph");
      const headingBounds=await leaderboardHeading.boundingBox(); const infoBounds=await leaderboardInfo.boundingBox();
      expect(headingBounds).not.toBeNull(); expect(infoBounds).not.toBeNull();
      expect(infoBounds!.x).toBeGreaterThanOrEqual(headingBounds!.x+headingBounds!.width-1);
      expect(infoBounds!.y).toBeLessThan(headingBounds!.y+headingBounds!.height);
      expect(infoBounds!.y+infoBounds!.height).toBeGreaterThan(headingBounds!.y);
      const sortControl=page.getByLabel("Sort attendance leaderboard");
      await expect(sortControl).toBeVisible();
      await expect(page.getByText("Sort attendance leaderboard",{ exact: true })).toHaveCount(0);
      const sortBounds=await sortControl.boundingBox(); const sortIconBounds=await page.locator(".leaderboard-sort-icon").boundingBox();
      expect(sortBounds).not.toBeNull(); expect(sortIconBounds).not.toBeNull();
      expect(sortIconBounds!.x).toBeGreaterThanOrEqual(sortBounds!.x);
      expect(sortIconBounds!.x+sortIconBounds!.width).toBeLessThanOrEqual(sortBounds!.x+sortBounds!.width);
      expect(await sortControl.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft))).toBeGreaterThan(sortIconBounds!.x+sortIconBounds!.width-sortBounds!.x);
      const reportingPeriod=page.getByLabel("Reporting period");
      expect((await reportingPeriod.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await reportingPeriod.focus();
      expect(await reportingPeriod.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      await expectResponsiveFit(page);
      if(viewport.width===390&&theme==="dark") {
        await page.screenshot({ path: testInfo.outputPath("reports-dark-mobile.png"),fullPage: true });
        await testInfo.attach("Reports dark mobile",{ path: testInfo.outputPath("reports-dark-mobile.png"),contentType: "image/png" });
      }

      await tabs.getByRole("button",{ name: "Class attendance",exact: true }).click();
      await expect(page.locator(".report-settings-summary")).toBeVisible();
      await expect(page.getByRole("button",{ name: "Edit",exact: true })).toBeVisible();
      await expect(page.getByLabel("Report name")).toHaveCount(0);
      await expect(page.getByRole("button",{ name: "Add column",exact: true })).toHaveCount(0);
      await expectResponsiveFit(page);
      if(viewport.width===390&&theme==="dark") {
        await page.screenshot({ path: testInfo.outputPath("saved-report-read-only-dark-mobile.png"),fullPage: true });
        await testInfo.attach("Saved report read-only dark mobile",{ path: testInfo.outputPath("saved-report-read-only-dark-mobile.png"),contentType: "image/png" });
      }

      await tabs.getByRole("button",{ name: "Create report" }).click();
      await expect(page.getByRole("heading",{ level: 2,name: "New report" })).toBeVisible();
      await expectReportButtonTheme(page,"Save",true);
      await expectReportButtonTheme(page,"Download report CSV");
      await page.getByRole("button",{ name: "Add column",exact: true }).click();
      await expect(page.getByLabel("Search columns")).toBeVisible();
      const columnCheckbox=page.getByRole("checkbox",{ name: "Absent dates",exact: true });
      const checkboxStyle=await columnCheckbox.evaluate((element) => ({ appearance: getComputedStyle(element).appearance,width: element.getBoundingClientRect().width,height: element.getBoundingClientRect().height,border: getComputedStyle(element).borderTopStyle }));
      expect(checkboxStyle.appearance).toBe("none");
      expect(checkboxStyle.width).toBeGreaterThanOrEqual(20);
      expect(checkboxStyle.height).toBeGreaterThanOrEqual(20);
      expect(checkboxStyle.border).toBe("solid");
      await expectResponsiveFit(page);
      if(viewport.width===390&&theme==="dark") {
        await page.screenshot({ path: testInfo.outputPath("report-builder-dark-mobile.png"),fullPage: true });
        await testInfo.attach("Report builder dark mobile",{ path: testInfo.outputPath("report-builder-dark-mobile.png"),contentType: "image/png" });
      }

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
      await expect(page.getByLabel("Excused meetings")).toHaveValue("exclude");
      for(const name of ["Create label","Preview new rule","Preview window change"]) await expectLabelButtonTheme(page,name,"primary");
      for(const name of ["Remove","Preview removal"]) await expectLabelButtonTheme(page,name,"danger");
      await expect(page.getByRole("button",{ name: "Restore" })).toHaveCount(0);
      await page.getByRole("button",{ name: "Preview removal" }).click();
      await expectLabelButtonTheme(page,"Apply attendance policy","primary");
      await expectLabelButtonTheme(page,"Back","secondary");
      await expectResponsiveFit(page);
      if(viewport.width===390&&theme==="dark") await page.screenshot({ path: testInfo.outputPath("attendance-settings-dark-mobile.png"),fullPage: true });
      await page.goto("/roster");
      await page.getByRole("button",{ name: "Bulk edit" }).click();
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

test("saved report tabs, imported drafts, configurable columns, and exports remain operable",async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lancerlogin-reports-view",JSON.stringify({ meetingType: "optional",roster: "all" })));
  await useReferenceContext(page);
  await page.goto("/reports");
  await page.getByText("Browse reports",{ exact: true }).click();
  await expect(page.getByRole("button",{ name: /Imported browser view/ })).toBeVisible();
  await expect(page.getByRole("button",{ name: /Attendance dates/ })).toBeVisible();
  const browseGeometry=await page.evaluate(() => { const trigger=document.querySelector(".report-browser > summary")!.getBoundingClientRect(); const popup=document.querySelector(".report-browser-popover")!.getBoundingClientRect(); return { triggerLeft: trigger.left,triggerBottom: trigger.bottom,popupLeft: popup.left,popupTop: popup.top }; });
  expect(Math.abs(browseGeometry.popupLeft-browseGeometry.triggerLeft)).toBeLessThanOrEqual(1);
  expect(browseGeometry.popupTop-browseGeometry.triggerBottom).toBeGreaterThanOrEqual(7);
  expect(browseGeometry.popupTop-browseGeometry.triggerBottom).toBeLessThanOrEqual(9);
  await page.getByRole("heading",{ level: 1,name: "Reports" }).click();
  await expect(page.getByRole("button",{ name: /Imported browser view/ })).toBeHidden();
  await page.getByText("Browse reports",{ exact: true }).click();
  await page.getByRole("button",{ name: /Imported browser view/ }).click();
  await expect(page).toHaveURL(/\/reports\/new$/);
  await expect(page.getByLabel("Report name")).toHaveValue("Imported attendance view");
  await expect(page.getByLabel("Meetings")).toHaveValue("optional");
  await expect(page.getByRole("combobox",{ name: "Roster",exact: true })).toHaveValue("all");
  await page.getByRole("button",{ name: "Add column",exact: true }).click();
  const absentDatesOption=page.getByRole("checkbox",{ name: "Absent dates",exact: true });
  await expect(absentDatesOption).toBeVisible();
  expect((await absentDatesOption.locator("..").boundingBox())!.height).toBeLessThanOrEqual(40);
  await expect(page.getByRole("button",{ name: /Choose labels for official policy result/i })).toBeVisible();
  await expect(page.getByRole("checkbox",{ name: /Mentor - official policy result/i })).toHaveCount(0);
  await page.getByRole("button",{ name: /Choose labels for official policy result/i }).click();
  const addColumnDialog=page.getByRole("dialog",{ name: "Add report column" });
  await expect(addColumnDialog.getByLabel("Search labels")).toBeVisible();
  const mentorPolicyColumn=addColumnDialog.getByRole("checkbox",{ name: "Mentor",exact: true });
  await mentorPolicyColumn.check();
  await expect(page.getByRole("button",{ name: /Mentor - official policy result column options/i })).toBeVisible();
  await mentorPolicyColumn.uncheck();
  await page.keyboard.press("Escape");
  await page.getByRole("button",{ name: "Add column",exact: true }).click();
  await absentDatesOption.check();
  await page.keyboard.press("Escape");
  await expect(page.getByText("+1 more").first()).toBeVisible();
  await page.getByText("+1 more").first().click();
  await expect(page.locator(".date-list").first()).toContainText("2026-09-22");
  const regularOptions=page.getByRole("button",{ name: "Regular attendance column options" });
  await regularOptions.click();
  const regularDialog=page.getByRole("dialog",{ name: "Regular attendance options" });
  await expect(regularDialog.getByText("Sort",{ exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Minimum value")).toHaveCount(0);
  const beforeScroll=await page.evaluate(() => { const trigger=document.querySelector<HTMLButtonElement>('[aria-label="Regular attendance column options"]')!.getBoundingClientRect(); const menu=document.querySelector(".report-column-popover")!.getBoundingClientRect(); return { scrollY,offset: menu.top-trigger.bottom }; });
  await page.evaluate((currentY) => window.scrollBy(0,currentY>20?-16:16),beforeScroll.scrollY);
  await expect.poll(async () => page.evaluate(() => { const trigger=document.querySelector<HTMLButtonElement>('[aria-label="Regular attendance column options"]')!.getBoundingClientRect(); const menu=document.querySelector(".report-column-popover")!.getBoundingClientRect(); return menu.top-trigger.bottom; })).toBeCloseTo(beforeScroll.offset,0);
  await page.getByRole("button",{ name: "Descending",exact: true }).click();
  await expect(page.locator(".editable-report-table tbody tr").first()).toContainText("Avery Stone");
  await page.locator('th[data-column-id="absent_dates"]').dragTo(page.locator('th[data-column-id="regular_attendance"]'));
  await expect.poll(async () => page.locator(".editable-report-table thead th .report-column-trigger span").allTextContents()).toEqual(["Member","Absent dates","Regular attendance","Assigned policies"]);
  const summaryDownload=page.waitForEvent("download");
  await page.getByRole("button",{ name: "Download report CSV" }).click();
  expect((await summaryDownload).suggestedFilename()).toBe("lancerlogin-report.csv");
  const detailDownload=page.waitForEvent("download");
  await page.getByRole("button",{ name: "Download detailed attendance CSV" }).click();
  expect((await detailDownload).suggestedFilename()).toBe("lancerlogin-report-detail.csv");
  await page.getByLabel("Report name").fill("Imported optional attendance");
  await page.getByRole("button",{ name: "Save",exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/view\/report-3$/);
  await expect(page.getByRole("button",{ name: "Imported optional attendance",exact: true })).toBeVisible();
  await expect(page.getByRole("button",{ name: "Edit",exact: true })).toBeVisible();
  await expect(page.getByLabel("Report name")).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Add column",exact: true })).toHaveCount(0);
  await expect(page.locator(".report-settings-summary")).toContainText("Optional meetings");
  expect(await page.evaluate(() => localStorage.getItem("lancerlogin-reports-view"))).toBeNull();
  await page.getByRole("button",{ name: "Unpin",exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await page.goto("/reports/view/dates-report");
  await expect(page.getByRole("heading",{ name: "Attendance dates" })).toBeVisible();
  await expect(page.getByRole("button",{ name: "Unpin Attendance dates" })).toBeVisible();
  await expect(page.getByRole("button",{ name: /Move Attendance dates (left|right)/ })).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Absent dates column options" })).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Add column",exact: true })).toHaveCount(0);
  await expect(page.locator(".report-settings-summary")).toContainText("Member, Absent dates");
  await expectResponsiveFit(page);
  await page.getByRole("button",{ name: "Edit",exact: true }).click();
  await expect(page.getByLabel("Report name")).toHaveValue("Attendance dates");
  await expect(page.getByRole("button",{ name: "Add column",exact: true })).toBeVisible();
  await page.getByRole("button",{ name: "Absent dates column options" }).click();
  const columnActions=page.locator(".report-column-actions");
  const moveLeft=columnActions.getByRole("button",{ name: "Move left",exact: true });
  const deleteColumn=columnActions.getByRole("button",{ name: "Delete",exact: true });
  const moveRight=columnActions.getByRole("button",{ name: "Move right",exact: true });
  const actionGeometry=await Promise.all([moveLeft,deleteColumn,moveRight].map(async (button) => { const bounds=await button.boundingBox(); const style=await button.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor,border: getComputedStyle(element).borderTopStyle })); return { ...bounds!,...style }; }));
  expect(actionGeometry[0].x).toBeLessThan(actionGeometry[1].x);
  expect(actionGeometry[1].x).toBeLessThan(actionGeometry[2].x);
  expect(actionGeometry.every((item) => item.height>=44&&item.border==="solid")).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox",{ name: "Rows",exact: true }).selectOption("all");
  await expect(page.locator(".report-pagination")).toContainText("1-2 of 2");
  const paginationGeometry=await page.evaluate(() => { const label=document.querySelector(".report-pagination label")!.getBoundingClientRect(); const select=document.querySelector(".report-pagination select")!.getBoundingClientRect(); const previous=document.querySelector<HTMLButtonElement>(".report-pagination button")!; return { labelCenter: label.top+label.height/2,selectCenter: select.top+select.height/2,buttonHeight: previous.getBoundingClientRect().height,buttonBorder: getComputedStyle(previous).borderTopStyle,buttonRadius: getComputedStyle(previous).borderTopLeftRadius }; });
  expect(Math.abs(paginationGeometry.labelCenter-paginationGeometry.selectCenter)).toBeLessThan(1);
  expect(paginationGeometry.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(paginationGeometry.buttonBorder).toBe("solid");
  expect(parseFloat(paginationGeometry.buttonRadius)).toBeGreaterThan(0);
  await page.getByRole("button",{ name: "Create report" }).click();
  await page.getByLabel("Report name").fill("Dirty draft");
  page.once("dialog",(dialog) => dialog.dismiss());
  await page.getByRole("navigation",{ name: "Primary dashboard navigation" }).getByRole("link",{ name: "Roster",exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/new$/);
  page.once("dialog",(dialog) => dialog.dismiss());
  await page.getByRole("button",{ name: "Leaderboard",exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/new$/);
  page.once("dialog",(dialog) => dialog.accept());
  await page.getByRole("button",{ name: "Leaderboard",exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
});

test("attendance requirement alerts appear in Reports instead of the Dashboard",async ({ page }) => {
  await useReferenceContext(page);
  await page.route("**/meetings",(route) => route.fulfill({ json: { meetings: [] } }));
  await page.route("**/discord/contests",(route) => route.fulfill({ json: { contests: [] } }));
  let reportRequests=0;
  const below={ labelId: "class",labelName: "Class",ruleId: "class-rule",ruleType: "weighted_percentage" as const,excusedHandling: "exclude" as const,status: "below" as const,threshold: 80,from: "2026-08-24",to: "2026-09-22",rate: 70,unadjustedRate: 70,attended: 7,required: 10 };
  await page.route("**/reports/leaderboard*",(route) => { reportRequests+=1; return route.fulfill({ json: { meetings: [],members: [{ member: roster[0],currentLabelIds: ["class"],rows: [],regularAttendance: { rate: 70,attended: 7,required: 10,from: "2026-01-01",to: "2026-09-22" },currentCompliances: [below],currentCompliance: below,historySummaries: [],policy: "standard",present: 7,primaryTotal: 10,adjustedTotal: 10,rate: 70,adjustedRate: 70,pooledRate: null,weeks: [],belowTargetWeeks: [] }],labels: [{ id: "class",name: "Class",active: 1,formulaEnabled: 0 }],baseline: null,timeZone: "UTC",pagination: { page: 1,pageSize: 25,totalRows: 1,totalPages: 1,rangeStart: 1,rangeEnd: 1 },insights: { policyAlerts: [{ key: "member-1:class",memberId: "A-101",name: "Avery Stone",policy: below }],trend: [] } } }); });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading",{ name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading",{ name: "Below attendance requirement" })).toHaveCount(0);
  expect(reportRequests).toBe(0);

  await page.goto("/reports");
  const alerts=page.locator(".policy-alerts-card");
  await expect(alerts.getByRole("heading",{ name: "Below attendance requirement" })).toBeVisible();
  await expect(alerts).toContainText("Avery Stone");
  await expect(alerts).toContainText("Class: 70% of 80% · below");
  expect(reportRequests).toBeGreaterThan(0);
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

// Policy responses are calculated by the Worker. The browser must display the same rates in each view.
test("regular and Class policy attendance agree across Reports, Roster, and member profile",async ({ page }) => {
  await useReferenceContext(page);
  const meeting={ id: "required",title: "Required build",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",attendanceClosesAt: "2026-09-01T20:30:00Z",required: true,attendanceWeight: 1,audienceMode: "all",audienceLabelIds: [] };
  const attendancePolicy={ member: roster[0],currentLabelIds: ["class"],rows: [],regularAttendance: { rate: 60,attended: 3,required: 5,from: "2026-01-01",to: "2026-09-22" },currentCompliance: { labelId: "class",labelName: "Class",ruleId: "class-rule",ruleType: "weighted_percentage" as const,excusedHandling: "exclude" as const,status: "met" as const,threshold: 75,from: "2026-08-24",to: "2026-09-22",rate: 75,unadjustedRate: 60,attended: 3,required: 4 },historySummaries: [{ ruleId: "class-rule",labelId: "class",labelName: "Class",ruleType: "weighted_percentage" as const,excusedHandling: "exclude" as const,startsOn: null,endsOn: null,rate: 75,unadjustedRate: 60,weeksMet: 0,weeksDue: 0,status: "evaluated" }],policy: "standard" as const,present: 3,primaryTotal: 5,adjustedTotal: 4,rate: 60,adjustedRate: 75,pooledRate: null,weeks: [],belowTargetWeeks: [] };
  await page.route("**/reports/attendance*",(route) => route.fulfill({ json: { meetings: [meeting,{ ...meeting,id: "optional",title: "Open practice",required: false }],members: [attendancePolicy],labels: [{ id: "class",name: "Class",active: 1,formulaEnabled: 0 }],baseline: null,timeZone: "UTC" } }));
  await page.route("**/reports/leaderboard*",(route) => route.fulfill({ json: { meetings: [meeting],members: [{ ...attendancePolicy,currentCompliances: [attendancePolicy.currentCompliance] }],labels: [{ id: "class",name: "Class",active: 1,formulaEnabled: 0 }],baseline: null,timeZone: "UTC",pagination: { page: 1,pageSize: 25,totalRows: 1,totalPages: 1,rangeStart: 1,rangeEnd: 1 },insights: { policyAlerts: [],trend: [] } } }));
  await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ json: { member: roster[0],labels: [{ id: "class",name: "Class",active: 1,formulaEnabled: 0 }],labelHistory: [],attendancePolicy,meanAnomalyMinutes: null,history: [] } }));
  await page.goto("/reports");
  const reportRow=page.locator(".report-row:not(.header)").filter({ hasText: "Avery Stone" });
  await expect(reportRow.getByRole("cell").nth(1)).toContainText("60%");
  await expect(reportRow.getByRole("cell").nth(2)).toContainText("Class: 75% of 75% · met");
  await page.goto("/roster");
  await expect(page.getByRole("row").filter({ hasText: "Avery Stone" }).locator(".roster-attendance-rate")).toHaveText("Regular: 60% · Class: 75% of 75% · met");
  await page.goto("/roster/A-101");
  await expect(page.getByText("60% · 2026-01-01 to 2026-09-22",{ exact: true })).toBeVisible();
  await expect(page.getByText("Class: 75% of 75% · met · 2026-08-24 to 2026-09-22",{ exact: true })).toBeVisible();
});

test("weekly assigned policies display meeting counts and pending status",async ({ page }) => {
  await useReferenceContext(page);
  const weeklyPolicy={ member: roster[0],currentLabelIds: ["mentor"],rows: [],regularAttendance: { rate: 100,attended: 2,required: 2,from: "2026-01-01",to: "2026-09-22" },currentCompliance: { labelId: "mentor",labelName: "Mentor",ruleId: "mentor-rule",ruleType: "weekly_count",excusedHandling: null,status: "pending",threshold: 3,from: "2026-09-21",to: "2026-09-27",rate: 67,unadjustedRate: 67,attended: 2,required: 3 },historySummaries: [],policy: "weekly",present: 2,primaryTotal: 3,adjustedTotal: 3,rate: null,adjustedRate: null,pooledRate: null,weeks: [],belowTargetWeeks: [] };
  await page.route("**/reports/attendance*",(route) => route.fulfill({ json: { meetings: [],members: [weeklyPolicy],labels: [{ id: "mentor",name: "Mentor",active: 1,formulaEnabled: 0 }],baseline: null,timeZone: "UTC" } }));
  await page.route("**/reports/leaderboard*",(route) => route.fulfill({ json: { meetings: [],members: [{ ...weeklyPolicy,currentCompliances: [weeklyPolicy.currentCompliance] }],labels: [{ id: "mentor",name: "Mentor",active: 1,formulaEnabled: 0 }],baseline: null,timeZone: "UTC",pagination: { page: 1,pageSize: 25,totalRows: 1,totalPages: 1,rangeStart: 1,rangeEnd: 1 },insights: { policyAlerts: [],trend: [] } } }));
  await page.goto("/reports");
  await expect(page.locator(".report-row:not(.header)").filter({ hasText: "Avery Stone" }).getByRole("cell").nth(2)).toContainText("Mentor: 2 of 3 meetings · pending");
  await page.goto("/roster");
  await expect(page.getByRole("row").filter({ hasText: "Avery Stone" }).locator(".roster-attendance-rate")).toHaveText("Regular: 100% · Mentor: 2 of 3 meetings · pending");
});

test("Admin previews and applies a separate dated label CSV; Operator sees labels without mutation controls",async ({ page }) => {
  await useReferenceContext(page);
  let applied=false;
  await page.route("**/labels/membership/preview",async (route) => {
    const body=route.request().postDataJSON() as { changes: Array<{ memberId: string; label: string; action: string; effectiveDate: string }> };
    expect(body.changes).toEqual([{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "2026-09-01" }]);
    await route.fulfill({ json: { changes: body.changes,impact: [{ memberId: "A-101",beforeRate: 50,afterRate: 100,beforePolicies: [],afterPolicies: [{ labelId: "mentor",labelName: "Mentor",ruleId: "mentor-rule",ruleType: "weekly_count",excusedHandling: null,status: "met",threshold: 1,from: "2026-09-21",to: "2026-09-27",rate: 100,unadjustedRate: 100,attended: 1,required: 1 }],affectedCompletedMeetings: 2 }],previewToken: "preview" } });
  });
  await page.route("**/labels/membership/apply",async (route) => { expect(route.request().postDataJSON()).toMatchObject({ previewToken: "preview" }); applied=true; await route.fulfill({ json: { applied: 1 } }); });
  await page.goto("/roster");
  await page.getByRole("button",{ name: "Bulk edit" }).click();
  await page.getByLabel("CSV contents").fill("memberId,label,action,effectiveDate\nA-101,Mentor,add,2026-09-01");
  await page.getByRole("button",{ name: "Preview CSV import" }).click();
  await expect(page.getByRole("heading",{ name: "Review dated label changes" })).toBeVisible();
  await expect(page.getByText(/regular 50% to 100%; policies No assigned policy to Mentor: 1 of 1 meetings/)).toBeVisible();
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
  await page.getByRole("button",{ name: "Bulk edit" }).click();
  await page.getByLabel("CSV contents").fill("memberId,label\nA-101,Mentor");
  await page.getByRole("button",{ name: "Preview CSV import" }).click();
  await expect(page.getByRole("heading",{ name: "Review dated label changes" })).toBeVisible();
  expect(labelRequests).toContainEqual([{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "" }]);
  await page.getByRole("button",{ name: "Back" }).click();
  await page.locator(".roster-filters label").filter({ hasText: /^Show/ }).locator("select").selectOption("all");
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

test("member labels are edited inside the member editor and Debug mode controls history",async ({ page }) => {
  await useReferenceContext(page);
  await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ json: { member: roster[0],labels: [{ id: "mentor",name: "Mentor",active: 1 }],labelHistory: [],attendancePolicy: null,meanAnomalyMinutes: null,history: [] } }));
  await page.route("**/labels/membership/preview",(route) => route.fulfill({ json: { changes: [{ memberId: "A-101",label: "Mentor",action: "add",effectiveDate: "2026-09-22" }],impact: [],previewToken: "one-member" } }));
  await page.goto("/roster/A-101");
  await expect(page.getByRole("heading",{ name: "Assign member labels" })).toHaveCount(0);
  await page.getByRole("button",{ name: "Edit",exact: true }).click();
  const editor=page.getByRole("dialog",{ name: "Edit roster member" });
  await editor.getByRole("button",{ name: "Change labels" }).click();
  await editor.getByRole("checkbox",{ name: "Mentor" }).check();
  await editor.getByRole("button",{ name: "Preview label changes" }).click();
  await expect(editor.getByRole("button",{ name: "Apply label changes" })).toBeVisible();
  await useReferenceContext(page,"operator");
  await page.reload();
  await expect(page.getByRole("heading",{ name: "Label history" })).toHaveCount(0);
  await useReferenceContext(page,"operator",true);
  await page.reload();
  await expect(page.getByRole("heading",{ name: "Label history" })).toBeVisible();
});

test("Recent roster imports is visible only in the current user's Debug mode",async ({ page }) => {
  await useReferenceContext(page,"admin",false);
  await page.goto("/roster");
  await expect(page.getByRole("heading",{ name: "Recent roster imports" })).toHaveCount(0);
  await useReferenceContext(page,"admin",true);
  await page.reload();
  await expect(page.getByRole("heading",{ name: "Recent roster imports" })).toBeVisible();
});

test("saved reports apply multi-label matching and membership filters to CSV exports",async ({ page }) => {
  await useReferenceContext(page);
  let exported: { definition?: { labelIds?: string[]; labelMatch?: string; membership?: string } }={};
  await page.route("**/exports/report.csv",async (route) => { exported=route.request().postDataJSON(); return route.fulfill({ status: 200,headers: { "content-type": "text/csv","content-disposition": "attachment; filename=report.csv" },body: "Member\nAvery Stone\n" }); });
  await page.goto("/reports/new");
  await page.getByText("Labels (all)",{ exact: true }).click();
  await page.getByRole("checkbox",{ name: "Mentor",exact: true }).check();
  await page.getByRole("heading",{ level: 2,name: "New report" }).click();
  await expect(page.getByRole("checkbox",{ name: "Mentor",exact: true })).toBeHidden();
  await page.getByLabel("Label matching").selectOption("all");
  await page.getByLabel("Membership").selectOption("historical");
  const download=page.waitForEvent("download");
  await page.getByRole("button",{ name: "Download report CSV" }).click();
  await download;
  expect(exported.definition?.labelIds).toEqual(["mentor"]);
  expect(exported.definition?.labelMatch).toBe("all");
  expect(exported.definition?.membership).toBe("historical");
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

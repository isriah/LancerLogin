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

test("Operator and member-detail states preserve identity policy, history, and unavailable recovery",async ({ page }) => {
  await useReferenceContext(page,"operator");
  await page.route("**/admin/members/A-101/history",(route) => route.fulfill({ status: 200,contentType: "application/json",body: JSON.stringify({ member: roster[0],history: [{ meetingId: "meeting-1",title: "Build session with a deliberately long name",startsAt: "2026-09-01T18:00:00Z",endsAt: "2026-09-01T20:00:00Z",checkedInAt: "2026-09-01T18:05:00Z",checkedOutAt: "2026-09-01T19:58:00Z",disposition: "present" }] }) }));
  await page.route("**/admin/members/missing/history",(route) => route.fulfill({ status: 404,contentType: "application/json",body: JSON.stringify({ error: "Member not found" }) }));

  await page.goto("/roster");
  await expect(page.getByRole("button",{ name: "Add member" })).toHaveCount(0);
  await expect(page.getByRole("button",{ name: "Edit" })).toHaveCount(0);
  await page.goto("/roster/A-101");
  await expect(page.getByRole("heading",{ level: 1,name: "Avery Stone" })).toBeVisible();
  await expect(page.getByText("Active roster member",{ exact: true })).toBeVisible();
  await expect(page.getByText("123456789012",{ exact: true })).toBeVisible();
  await expect(page.getByRole("table",{ name: "Complete attendance history" })).toContainText("Build session with a deliberately long name");
  await expect(page.getByRole("button",{ name: "Edit" })).toHaveCount(0);

  await page.goto("/roster/missing");
  await expect(page.locator("main h1")).toHaveCount(1);
  await expect(page.getByRole("heading",{ level: 1,name: "Member detail" })).toBeVisible();
  await expect(page.getByRole("heading",{ level: 2,name: "Member unavailable" })).toBeVisible();
  await expect(page.getByRole("link",{ name: "Return to roster" })).toBeVisible();
});

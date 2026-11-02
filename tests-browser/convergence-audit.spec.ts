import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
import { pairedViews } from "./paired-views";
import { expectResponsiveFit, mockSetupStatus } from "./api-fixtures";

const governedRoutes = [
  ["/dashboard", "Dashboard"],
  ["/meetings/active-meeting", "Build session"],
  ["/reports", "Reports"],
  ["/roster", "Roster"],
  ["/roster/A-101", "Avery Stone"],
  ["/kiosks", "Kiosks"],
  ["/settings/organization", "Organization"],
  ["/settings/configuration", "Configuration"],
  ["/settings/access", "Dashboard access"],
  ["/settings/integrations", "Integrations"],
  ["/settings/data", "Data management"],
  ["/settings/guided-setup", "Attendance setup"],
  ["/settings/updates", "Updates"],
] as const;

const wideRoutes = new Set(["/dashboard", "/meetings/active-meeting", "/reports", "/roster", "/roster/A-101", "/kiosks"]);
const auditedViewports = [{ width: 2560, height: 1440 }, ...dashboardConformanceReferences.viewports] as const;
// Every governed route fits, with no control cut off outside the data tables that scroll sideways on purpose.
const governedFit = {
  controls: "main button, main a[href], main input, main select, main textarea, main summary, main [role='status'], main [role='alert']",
  scrollers: ".report-tabs,.responsive-table,.table-scroll,.roster-table-scroll,.member-history-scroll,.report-table-scroll",
};
// Phone routes with the default fixture data, including the legacy /meetings (the Dashboard's table view),
// /attendance and /settings/privacy addresses.
const phoneRoutes = [
  "/dashboard",
  "/meetings",
  "/attendance",
  "/reports",
  "/roster",
  "/kiosks",
  "/settings/organization",
  "/settings/configuration",
  "/settings/access",
  "/settings/integrations",
  "/settings/privacy",
  "/settings/data",
  "/settings/updates",
];

async function useReferenceContext(page: Page) {
  await mockSetupStatus(page, { settings: {
    organizationName: "Reference Arts Collective",
    subtitle: "Shared operations",
    logoData: "",
    primaryColor: dashboardConformanceReferences.brand.primary,
    secondaryColor: dashboardConformanceReferences.brand.secondary,
    appearance: "dark",
    logoBackdrop: "auto",
    lateScanMinutes: 30,
    discordContestWindowHours: 24,
  } });
}

async function expectGovernedSurface(page: Page, heading: string, route: string) {
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(page.locator("main h1")).toHaveCount(1);
  await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
  await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);

  const audit = await page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
    };
    const name = (element: HTMLElement) => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 80) || element.tagName;
    const main = document.querySelector("main")!;
    const headings = Array.from(main.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).filter(visible);
    const headingLevels = headings.map((element) => Number(element.tagName.slice(1)));
    const headingSkips = headingLevels.flatMap((level, index) => index > 0 && level > headingLevels[index - 1] + 1 ? [`${headings[index - 1].tagName} to ${headings[index].tagName}: ${name(headings[index])}`] : []);
    const controls = Array.from(main.querySelectorAll<HTMLElement>("button,input,select,textarea,summary"));
    const unlabeled = controls.filter(visible).flatMap((element) => {
      if (element.tagName === "BUTTON" || element.tagName === "SUMMARY") {
        const hasName = Boolean(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.textContent?.trim() || element.getAttribute("title"));
        return hasName ? [] : [element.tagName];
      }
      const id = element.id;
      const hasLabel = Boolean(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.closest("label") || (id && document.querySelector(`label[for='${CSS.escape(id)}']`)));
      return hasLabel ? [] : [name(element)];
    });
    const targetSelector = "button,input:not([type='radio']):not([type='checkbox']),select,textarea,summary,a.primary-button,label:has(input[type='radio']),label:has(input[type='checkbox'])";
    const shortTargets = Array.from(main.querySelectorAll<HTMLElement>(targetSelector)).filter(visible).flatMap((element) => element.getBoundingClientRect().height < 43.5 ? [`${name(element)} (${element.getBoundingClientRect().height.toFixed(1)}px)`] : []);
    return { headingSkips, unlabeled, shortTargets };
  });

  expect(audit.headingSkips).toEqual([]);
  expect(audit.unlabeled).toEqual([]);
  expect(audit.shortTargets).toEqual([]);
  await expectResponsiveFit(page, governedFit);

  const shell = page.locator(".dashboard-shell");
  await expect(shell).toHaveAttribute("data-layout", wideRoutes.has(route) ? "wide" : "readable");
  if (page.viewportSize()!.width === 2560 && wideRoutes.has(route)) {
    expect((await shell.boundingBox())!.width).toBeGreaterThanOrEqual(2000);
  }
}

for (const { viewport, theme } of [{ viewport: auditedViewports[0], theme: "dark" }, ...pairedViews] as const) {
    test(`all governed routes converge at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript(({ savedTheme }) => {
        localStorage.setItem("lancerlogin-theme", savedTheme);
        localStorage.setItem("lancerlogin-update-dismissed:0.19.0", "true");
      }, { savedTheme: theme });
      await useReferenceContext(page);

      for (const [route, heading] of governedRoutes) {
        await page.goto(route);
        await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
        await expectGovernedSurface(page, heading, route);
      }
    });
  }

// The 390px phone is audited above; the smaller compact phone only has to fit.
test("phone routes fit a 375x667 compact phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  for (const route of phoneRoutes) {
    await page.goto(route);
    await expect(page.locator("main h1")).toBeVisible();
    await test.step(route, () => expectResponsiveFit(page, governedFit));
  }
});

test("expanded phone routes scroll only where data requires it and keep controls within reach", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const allowedScrollerSelectors = [".responsive-table", ".table-scroll", ".report-table-scroll"];

  for (const route of phoneRoutes) {
    await page.goto(route);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.locator(".dashboard-loading-overlay")).toHaveCount(0);
    while (await page.locator("details:not([open]) > summary").count()) await page.locator("details:not([open]) > summary").first().click();
    const unexpectedScrollers = await page.evaluate((allowed) => Array.from(document.querySelectorAll<HTMLElement>("*")).flatMap((element) => {
      const style = getComputedStyle(element);
      const isScrollable = element.scrollWidth > element.clientWidth + 1 && ["auto", "scroll"].includes(style.overflowX);
      const isAllowed = allowed.some((selector) => element.matches(selector));
      return isScrollable && !isAllowed ? [{ tag: element.tagName, className: element.className }] : [];
    }), allowedScrollerSelectors);
    expect(unexpectedScrollers, route).toEqual([]);
    await test.step(route, () => expectResponsiveFit(page, { controls: "button, input, select, textarea, summary, [role='dialog']", scrollers: ".responsive-table, .table-scroll" }));
  }
});

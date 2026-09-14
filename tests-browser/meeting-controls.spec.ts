import { setDashboardTheme } from "./dashboard-theme";
import { expect, test, type Locator } from "@playwright/test";

async function expectControl(control: Locator, select = false) {
  await expect(control).toBeVisible();
  const style = await control.evaluate((element) => {
    const css = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { height: bounds.height, width: bounds.width, left: bounds.left, right: bounds.right,
      viewport: window.innerWidth, rem: parseFloat(getComputedStyle(document.documentElement).fontSize), font: css.fontFamily, bodyFont: css.getPropertyValue("--font-body").trim(),
      size: css.fontSize, weight: css.fontWeight, padding: css.paddingLeft, rightPadding: css.paddingRight,
      radius: css.borderRadius, border: css.borderStyle, appearance: css.appearance, arrow: css.backgroundImage };
  });
  expect(style.height).toBeGreaterThanOrEqual(44);
  expect(style.left).toBeGreaterThanOrEqual(0);
  expect(style.right).toBeLessThanOrEqual(style.viewport);
  expect(style.font.replaceAll('"', "")).toBe(style.bodyFont.replaceAll('"', ""));
  expect(parseFloat(style.size)).toBe(style.rem);
  expect(style.weight).toBe("400");
  expect(parseFloat(style.padding)).toBeCloseTo(style.rem * .75);
  expect(parseFloat(style.radius)).toBeCloseTo(style.rem * .55);
  expect(style.border).toBe("solid");
  if (select) {
    expect(style.appearance).toBe("none");
    expect(style.arrow).toContain("linear-gradient");
    expect(parseFloat(style.rightPadding)).toBe(style.rem * 3);
    expect(style.width).toBeGreaterThan(100);
  }
  await control.focus();
  await control.page().keyboard.press("Tab");
  await control.page().keyboard.press("Shift+Tab");
  await expect(control).toBeFocused();
  await expect(control).toHaveCSS("outline-style", "solid");
  await expect(control).toHaveCSS("outline-width", "3px");
  // Exercise dormant semantic states without changing production value/disabled behavior.
  await control.evaluate((element) => element.setAttribute("aria-invalid", "true"));
  const errorBorder = await control.evaluate((element) => {
    const probe = document.createElement("span"); probe.style.color = "var(--ui-error)";
    element.parentElement!.append(probe);
    const colors = { actual: getComputedStyle(element).borderColor, expected: getComputedStyle(probe).color };
    probe.remove(); return colors;
  });
  expect(errorBorder.actual).toBe(errorBorder.expected);
  await control.evaluate((element) => { element.removeAttribute("aria-invalid"); element.setAttribute("disabled", ""); });
  await expect(control).toHaveCSS("cursor", "not-allowed");
  await expect(control).toHaveCSS("opacity", "0.7");
  await control.evaluate((element) => element.removeAttribute("disabled"));
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  for (const appearance of ["light", "dark"]) {
    for (const brand of [{ primaryColor: "#8b2f72", secondaryColor: "#e9b949" }, { primaryColor: "#146c5b", secondaryColor: "#dba72d" }]) {
      test(`meeting controls preserve styling and editing at ${viewport.width} ${appearance} ${brand.primaryColor}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.route("**/setup/status", (route) => route.fulfill({ json: {
          configured: true, installation: { authMode: "local" },
          settings: { organizationName: "Reference Arts Collective", subtitle: "Shared operations", logoData: "", ...brand, appearance, logoBackdrop: "auto", lateScanMinutes: 30 },
        } }));
        const now = new Date().setHours(12, 0, 0, 0);
        const meeting = { id: "active-meeting", title: "Build session", startsAt: new Date(now - 30 * 60_000).toISOString(), endsAt: new Date(now + 120 * 60_000).toISOString(), attendanceClosesAt: new Date(now + 150 * 60_000).toISOString(), required: 1, notes: "Original notes", weightCategoryId: "retired", weightCategoryName: "Saved category", attendanceWeight: 2 };
        const submitted: Record<string, unknown>[] = [];
        await page.route("**/meeting-weight-categories", (route) => route.fulfill({ json: { categories: [{ id: "extended", name: "Extended workshop", weight: 3, minimumDurationMinutes: 60, position: 0, active: true }] } }));
        await page.route(/\/meetings\/active-meeting$/, (route) => {
          if (route.request().resourceType() === "document") return route.continue();
          if (route.request().method() === "PATCH") {
            const body = route.request().postDataJSON(); submitted.push(body);
            Object.assign(meeting, body);
            return route.fulfill({ json: {} });
          }
          return route.fulfill({ json: { meeting } });
        });
        await page.goto("/meetings/active-meeting");
        await setDashboardTheme(page, appearance);
        await expect(page.locator(".app")).toHaveAttribute("data-theme", appearance);
        const colors = await page.locator(".app").evaluate((element) => ({ primary: getComputedStyle(element).getPropertyValue("--primary").trim(), secondary: getComputedStyle(element).getPropertyValue("--secondary").trim() }));
        expect(colors).toEqual({ primary: brand.primaryColor, secondary: brand.secondaryColor });
        await expect(page.locator("main h1")).toHaveCount(1);
        const switchMeeting = page.getByLabel("Switch meeting");
        await expectControl(switchMeeting, true);
        await page.screenshot({ path: test.info().outputPath("meeting-navigation.png") });
        const edit = page.getByRole("button", { name: "Edit", exact: true });
        await edit.click();
        const dialog = page.getByRole("dialog", { name: "Edit meeting" });
        const notes = dialog.getByLabel("Notes");
        const weight = dialog.getByLabel("Attendance weight");
        await expectControl(notes);
        await expect(notes).toHaveAttribute("maxlength", "2000");
        await expect(notes).toHaveAttribute("rows", "4");
        await expectControl(weight, true);
        await expect(weight).toHaveAttribute("aria-describedby", "meeting-weight-help");
        await expect(weight).toHaveValue("retired");
        await expect(weight.locator("option")).toHaveText(["Automatic (Extended workshop (3×))", "Default (1×)", "Extended workshop (3×) · 60+ min", "Saved category (2×, retired)"]);
        await notes.fill("Discarded notes");
        await weight.selectOption("automatic");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(edit).toBeFocused();
        expect(submitted).toHaveLength(0);
        await edit.click();
        await expect(notes).toHaveValue("Original notes");
        await expect(weight).toHaveValue("retired");
        await notes.fill("First line\nSecond line");
        await weight.selectOption("extended");
        await page.screenshot({ path: test.info().outputPath("meeting-editor.png") });
        await dialog.getByRole("button", { name: "Save meeting" }).click();
        await expect(dialog).toHaveCount(0);
        expect(submitted[0]).toMatchObject({ notes: "First line\nSecond line", weightCategoryId: "extended" });
        await edit.click();
        await weight.selectOption("default");
        await dialog.getByRole("button", { name: "Save meeting" }).click();
        await expect(dialog).toHaveCount(0);
        expect(submitted[1]).toMatchObject({ weightCategoryId: null });
        await edit.click();
        await weight.selectOption("automatic");
        await dialog.getByRole("button", { name: "Save meeting" }).click();
        await expect(dialog).toHaveCount(0);
        expect(submitted[2]).not.toHaveProperty("weightCategoryId");
        await switchMeeting.focus();
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/meetings\/next-week$/);
        await expect(page.getByRole("heading", { name: "Studio night", exact: true })).toBeVisible();
        const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
      });
    }
  }
}

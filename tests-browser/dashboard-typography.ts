import { expect, type Page } from "@playwright/test";

/** Check semantic text roles across surfaces, including adopter font overrides. */
export async function expectDashboardTypography(page: Page) {
  const failures = await page.locator(".dashboard-page").evaluate((root) => {
    const expected = document.createElement("span");
    root.append(expected);
    const failures: string[] = [];
    function check(element: Element, family: string, size: string, weight: string) {
      if (element.closest(".simulator-page")) return;
      expected.style.fontFamily = `var(${family})`;
      expected.style.fontSize = `var(${size})`;
      const actual = getComputedStyle(element); const reference = getComputedStyle(expected);
      if (actual.fontFamily !== reference.fontFamily || actual.fontSize !== reference.fontSize || actual.fontWeight !== weight) failures.push(element.textContent?.trim().slice(0, 80) ?? element.tagName);
    }
    root.querySelectorAll("h1,h2,h3").forEach((element) => check(element, "--font-display", element.tagName === "H1" ? "--text-page-heading" : element.tagName === "H2" ? "--text-section-heading" : "--text-card-heading", "400"));
    root.querySelectorAll('label:has(> input:not([type="radio"]):not([type="checkbox"])),label:has(> select),label:has(> textarea),.meeting-view-toggle legend').forEach((element) => check(element, "--font-body", "--text-small", "750"));
    root.querySelectorAll(".meeting-browser-select > span").forEach((element) => check(element, "--font-body", "--text-small", "750"));
    expected.remove();
    return failures;
  });
  expect(failures, "Headings and field labels use consistent semantic typography").toEqual([]);
}

import { expect, type Page, type Request, type Route } from "@playwright/test";

// Shared API mocks and checks for browser specs. Every value is synthetic.

type SetupStatus = { configured?: boolean; installation?: Record<string, unknown>; settings?: Record<string, unknown>; [key: string]: unknown };

/**
 * Mocks /setup/status. A configured installation defaults to local sign-in and takes `settings` as given; an
 * unconfigured one (`configured: false`) is sent exactly as passed, with no installation or settings.
 */
export async function mockSetupStatus(page: Page, overrides: SetupStatus = {}) {
  const status = overrides.configured === false ? overrides : { configured: true, installation: { authMode: "local" }, ...overrides };
  await page.route("**/setup/status", route => route.fulfill({ json: status }));
}

/** Mocks /auth/session as a signed-in user with `role`; `user` adds fields such as id or debugMode. */
export async function mockSession(page: Page, role: string, user: Record<string, unknown> = {}) {
  await page.route("**/auth/session", route => route.fulfill({ json: { user: { ...user, role } } }));
}

/**
 * Sends the matching requests to the dashboard preview API's state for `scenario` (x-preview-scenario), so each test
 * gets its own; returns every request other than a GET, in order.
 */
export async function useScenario(page: Page, scenario: string, patterns: string[]) {
  const writes: Request[] = [];
  const tag = async (route: Route) => {
    if (route.request().method() !== "GET") writes.push(route.request());
    await route.continue({ headers: { ...route.request().headers(), "x-preview-scenario": scenario } });
  };
  for (const pattern of patterns) await page.route(pattern, tag);
  return writes;
}

/**
 * The page has no horizontal scroll, and no visible control matching `controls` is cut off at either edge, except
 * inside `scrollers` (elements that scroll sideways on purpose).
 */
export async function expectResponsiveFit(page: Page, { controls, scrollers }: { controls: string; scrollers?: string }) {
  const geometry = await page.evaluate(({ controls, scrollers }) => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped: Array.from(document.querySelectorAll<HTMLElement>(controls)).flatMap((element) => {
      const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || bounds.width === 0 || (scrollers && element.closest(scrollers))) return [];
      return bounds.left < -1 || bounds.right > innerWidth + 1 ? [element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName] : [];
    }),
  }), { controls, scrollers });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.clipped).toEqual([]);
}

/** Opens the clock picker for `label` and chooses the hour, minute and AM or PM. */
export async function chooseClock(page: Page, label: string, hour: number, minute = 0, period: "AM" | "PM" = "AM") {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  const dialog = page.getByRole("dialog", { name: label });
  await dialog.getByRole("button", { name: `${hour} o'clock`, exact: true }).click();
  await dialog.getByRole("button", { name: `${minute} minutes`, exact: true }).click();
  await dialog.getByRole("group", { name: "Choose AM or PM" }).getByRole("button", { name: period, exact: true }).click();
}

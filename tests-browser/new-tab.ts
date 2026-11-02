import { expect, test, type Locator, type Page } from "@playwright/test";

// "This click opens that address in a new tab", checked two ways:
// - Without a real tab, for the app's own logic: a page-level listener records whether the app left a trusted click
//   to the browser (not default-prevented) and then prevents it itself, and window.open calls are recorded instead of
//   opening anything. These checks don't depend on Chromium creating a tab, which Linux headless Chromium sometimes
//   doesn't.
// - With one real tab per link type in a spec (expectOpensRealTab), so the browser side stays covered too.
export type NewTabClick = Parameters<Locator["click"]>[0];
type ProbedClick = { type: string; button: number; href: string | null; target: string | null; prevented: boolean };
type ProbeWindow = Window & { __newTabProbe?: boolean; __newTabArmed?: boolean; __newTabClicks: ProbedClick[]; __newTabOpened: unknown[][] };

async function armProbe(page: Page) {
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    probe.__newTabClicks = []; probe.__newTabOpened = []; probe.__newTabArmed = true;
    if (probe.__newTabProbe) return;
    probe.__newTabProbe = true;
    // The click is recorded, then prevented, after the app's last handler: at the window, or at the element where the
    // app stopped its propagation (as links inside clickable rows do). defaultPrevented is then the app's decision.
    const record = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest("a");
      probe.__newTabClicks.push({ type: event.type, button: event.button, href: anchor?.getAttribute("href") ?? null, target: anchor?.getAttribute("target") ?? null, prevented: event.defaultPrevented });
      event.preventDefault();
    };
    for (const type of ["click", "auxclick"]) {
      window.addEventListener(type, (event) => {
        if (!probe.__newTabArmed) return;
        const mouse = event as MouseEvent;
        let stopped = false;
        const stop = mouse.stopPropagation.bind(mouse);
        mouse.stopPropagation = () => { stopped = true; stop(); };
        // Added last on each element of the path, so each runs after the app's own listeners there.
        const afterApp = (inner: Event) => { if (stopped && inner === mouse) { record(mouse); stopped = false; mouse.stopPropagation = stop; } };
        const path = mouse.composedPath().filter(node => node !== window);
        for (const node of path) node.addEventListener(type, afterApp);
        setTimeout(() => { for (const node of path) node.removeEventListener(type, afterApp); });
      }, { capture: true });
      window.addEventListener(type, (event) => { if (probe.__newTabArmed) record(event as MouseEvent); });
    }
    const realOpen = window.open.bind(window);
    window.open = (...args: Parameters<typeof window.open>) => {
      if (!probe.__newTabArmed) return realOpen(...args);
      probe.__newTabOpened.push(args);
      return null;
    };
  });
}

async function probedClick(page: Page, target: Locator, options: NewTabClick, settled?: () => Promise<void>) {
  await armProbe(page);
  const before = page.context().pages().length;
  const url = page.url();
  await target.click(options);
  await settled?.();
  const result = await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    probe.__newTabArmed = false;
    return { clicks: probe.__newTabClicks, opened: probe.__newTabOpened };
  });
  expect(page.context().pages(), "the probe opened no tab").toHaveLength(before);
  await expect(page).toHaveURL(url);
  return result;
}

/** A link click the app leaves to the browser, which would open `href` in a new tab or window. */
export async function expectLinkLeftToBrowser(page: Page, link: Locator, href: string, options?: NewTabClick) {
  const { clicks, opened } = await probedClick(page, link, options);
  const type = options?.button === "middle" ? "auxclick" : "click";
  expect(clicks.filter(click => click.type === type), `${JSON.stringify(options ?? {})} reaches the browser unprevented`).toEqual([expect.objectContaining({ href, prevented: false })]);
  expect(opened, "the app opens no window itself").toEqual([]);
}

/**
 * A click the app answers by calling window.open itself, as table rows do; returns the recorded calls, each answered
 * with null as a popup blocker would. Pass `settled` to wait for a call the app makes later, after a request.
 */
export async function recordWindowOpen(page: Page, target: Locator, options?: NewTabClick, settled?: () => Promise<void>) {
  return (await probedClick(page, target, options, settled)).opened;
}

// Headless Chromium on Linux now and then drops the tab a trusted modified click asks for, after the page has left the
// click to the browser (it logs "Message 0 rejected by interface blink.mojom.WidgetHost"). Only when no tab appeared,
// none was created and the opener page stayed put is the same click repeated, up to twice; it must still open exactly
// one tab at the address. Pass attempts: 1 for a click with side effects, such as a request. The tab only has to reach
// the address (its URL is polled, no load state): loading the whole dev-server app in a background tab is not what
// this checks, and stalls on a busy runner. Returns the tab's address; the tab is closed.
export async function expectOpensRealTab(page: Page, target: Locator, url: RegExp, options?: NewTabClick, { attempts = 3 } = {}) {
  const context = page.context();
  const before = context.pages().length;
  const openerUrl = page.url();
  // A page may change its own address as soon as it starts (the web kiosk removes #code= once it has read it), and a
  // production build starts before the poll below can see the first address. Each new document records the address it
  // was opened at, before any of its own scripts run.
  await context.addInitScript(() => {
    const record = window as unknown as { __newTabOpenedAt?: string };
    if (window.location.href !== "about:blank") record.__newTabOpenedAt ??= window.location.href;
  });
  let tab: Page | undefined;
  let clicks = 0;
  while (clicks < attempts && !tab) {
    clicks += 1;
    const opened = context.waitForEvent("page", { timeout: 5_000 }).catch(() => undefined);
    await target.click(options);
    tab = await opened;
    if (!tab) {
      expect(context.pages(), "a click that opened no tab created no page either").toHaveLength(before);
      await expect(page).toHaveURL(openerUrl);
    }
  }
  if (clicks > 1) test.info().annotations.push({ type: "repeated-click", description: `${JSON.stringify(options ?? {})} needed ${clicks} clicks` });
  expect(tab, `${JSON.stringify(options ?? {})} opens a new tab`).toBeDefined();
  expect(context.pages()).toHaveLength(before + 1);
  // Linux headless Chromium can also load the page in the new tab while Playwright never sees its navigation, so the
  // tab's url() stays blank (the trace shows the page's requests and console, but no navigation). Then the tab is
  // asked for the address it was opened at, or its own location.
  const location = async () => {
    if (url.test(tab!.url())) return tab!.url();
    const own = tab!.evaluate(() => (window as unknown as { __newTabOpenedAt?: string }).__newTabOpenedAt ?? window.location.href).catch(() => "");
    return Promise.race([own, new Promise<string>(resolve => setTimeout(() => resolve(""), 1_000))]);
  };
  await expect.poll(location, { message: `the new tab reaches ${url}` }).toMatch(url);
  const address = await location();
  if (!url.test(tab!.url())) test.info().annotations.push({ type: "unseen-navigation", description: `the new tab reached ${address} without a navigation Playwright saw` });
  await tab!.close();
  await expect(page).toHaveURL(openerUrl);
  return address;
}

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { expectResponsiveFit, mockSession, useScenario as routeScenario } from "./api-fixtures";
import { discovered } from "./release-discovery";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

// Waiting PIN requests away from Manage kiosk: the count on a kiosk's row of the Kiosks list, and the top bar's count
// with its dialog, against the dashboard preview API's per-scenario PIN state. The preview sends the counts with the
// module refresh, as the Worker does. Every name and value is synthetic.
const mockApi = `http://127.0.0.1:${Number(process.env.LANCERLOGIN_BROWSER_PORT_BASE ?? 43_173) + 1}`;
// Test Student C is not on the preview roster, so the request names them itself.
const students = { A: { memberId: "member-1" }, B: { memberId: "member-2" }, C: { memberId: "member-1", rosterId: "member-3", externalId: "A-103" } } as const;
const bundledVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

async function useScenario(page: Page, id: string, role: "admin" | "operator" | "member" = "admin") {
  const scenario = `pin-request-indicator-${id}`;
  const writes = await routeScenario(page, scenario, ["**/platform/modules", "**/admin/kiosks", "**/admin/kiosks/*", "**/admin/kiosks/*/*", "**/admin/pin-requests/*/*"]);
  if (role !== "admin") await mockSession(page, role, { id: `${role}-1`, debugMode: false });
  /** A kiosk asking for approval, as a kiosk does when a member without a PIN asks for one. */
  const askForPin = async (kioskId: string, student: keyof typeof students, minutesAgo = 0) => {
    const response = await page.request.post(`${mockApi}/preview/pin-requests`, { headers: { "x-preview-scenario": scenario }, data: { kioskId, ...students[student], firstName: "Test", lastName: `Student ${student}`, minutesAgo } });
    expect(response.status()).toBe(201);
  };
  return { writes, askForPin };
}
/** The shell reads the counts again when its tab gets focus, and every 30 seconds while it is visible. */
const refreshShell = (page: Page) => page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
const topCount = (page: Page) => page.locator(".dashboard-toolbar .pin-request-indicator");
const rowCount = (page: Page, kiosk: string) => page.locator(".kiosk-device-option").filter({ has: page.getByRole("button", { name: new RegExp(`^${kiosk}`) }) }).locator(".kiosk-pin-request-count");
const kiosksReady = (page: Page) => expect(page.locator(".kiosk-device-option")).toHaveCount(3);

test("with no PIN request waiting, the Kiosks list and the top bar show no count", async ({ page }, testInfo) => {
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  // A request that ran out a minute ago is not waiting.
  await askForPin("web-kiosk-b", "C", 11);
  await page.goto("/kiosks");
  await kiosksReady(page);
  await expect(page.locator(".contest-indicator").filter({ hasText: "Reviews" })).toBeVisible();
  await expect(topCount(page)).toHaveCount(0);
  await expect(page.locator(".kiosk-pin-request-count")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("one kiosk with two requests shows its count on its row and in the top bar, and the row count opens its Manage page", async ({ page }, testInfo) => {
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await askForPin("web-kiosk-a", "B", 2); await askForPin("web-kiosk-a", "A");
  await page.goto("/kiosks");
  await kiosksReady(page);
  const pill = rowCount(page, "Test web kiosk A");
  await expect(pill).toHaveText("2 PIN requests");
  await expect(pill).toHaveAccessibleName("2 PIN requests waiting at Test web kiosk A. Open them.");
  await expect(pill).toHaveAttribute("href", "/kiosks/web-kiosk-a/manage#kiosk-pin-requests");
  await expect(page.locator(".kiosk-pin-request-count")).toHaveCount(1);
  // The existing warning status pill, as a link with the standard touch target.
  const health = page.locator(".kiosk-device-select .status-pill").first();
  const pillStyle = (locator: typeof pill) => locator.evaluate((element) => { const style = getComputedStyle(element); return [style.borderRadius, style.fontSize, style.fontWeight, style.minHeight, style.fontFamily]; });
  expect(await pillStyle(pill)).toEqual(await pillStyle(health));
  expect(await pill.evaluate((element) => { const probe = document.createElement("span"); probe.className = "status-pill ui-status"; probe.dataset.tone = "warning"; element.parentElement!.append(probe); const expected = getComputedStyle(probe), actual = getComputedStyle(element); const same = expected.color === actual.color && expected.backgroundColor === actual.backgroundColor; probe.remove(); return same && actual.textDecorationLine === "none"; })).toBe(true);
  expect(await pill.evaluate((element) => { const target = getComputedStyle(element, "::after"); return parseFloat(target.height); })).toBeGreaterThanOrEqual(44);
  await pill.focus();
  expect(await pill.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");

  // The top bar's count sits before Reviews in the same style, and names what it opens.
  const count = topCount(page);
  await expect(count).toHaveText("2 PIN requests");
  await expect(count).toHaveAccessibleName("2 PIN requests waiting. Open PIN requests.");
  await expect(count).toHaveAttribute("aria-haspopup", "dialog");
  const reviews = page.locator(".contest-indicator:not(.pin-request-indicator)");
  expect(await page.locator(".toolbar-end > *").evaluateAll((elements) => elements.map((element) => element.className))).toEqual(["contest-indicator pin-request-indicator", "contest-indicator"]);
  const buttonStyle = (locator: typeof count) => locator.evaluate((element) => { const style = getComputedStyle(element); const badge = getComputedStyle(element.querySelector("span")!); return [style.backgroundColor, style.color, style.borderColor, style.borderRadius, style.minHeight, style.fontSize, badge.backgroundColor, badge.borderRadius, badge.height]; });
  expect(await buttonStyle(count)).toEqual(await buttonStyle(reviews));
  expect((await count.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // The row count leads to that kiosk's Manage page, with its PIN requests card in view.
  await pill.click();
  await expect(page).toHaveURL(/\/kiosks\/web-kiosk-a\/manage$/);
  const card = page.locator("#kiosk-pin-requests");
  await expect(card.getByRole("heading", { name: "PIN requests" })).toBeVisible();
  await expect(card.locator(".status-pill")).toHaveText("2 waiting");
  await expect(card).toBeInViewport({ ratio: 1 });
  // The top bar keeps counting there, and follows an answer given on Manage kiosk at once.
  await expect(count).toHaveText("2 PIN requests");
  await card.getByRole("group", { name: "PIN request from Test Student A" }).getByRole("button", { name: "Decline" }).click();
  await expect(count).toHaveText("1 PIN request");
  await expect(count).toHaveAccessibleName("1 PIN request waiting. Open PIN requests.");

  // Opened in a new tab, the link's address lands on the card too.
  await page.goto("/kiosks/web-kiosk-a/manage#kiosk-pin-requests");
  await expect(card).toBeInViewport({ ratio: 1 });
});

test("the top bar's count opens every waiting request by kiosk, and an answer there updates the count and the row", async ({ page }, testInfo) => {
  const { writes, askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`, "operator");
  // Kiosk B had three requests; two ran out, so it counts 1.
  await askForPin("web-kiosk-b", "A", 12); await askForPin("web-kiosk-b", "B", 11);
  await askForPin("web-kiosk-a", "A", 2); await askForPin("web-kiosk-a", "B"); await askForPin("web-kiosk-b", "C", 6);
  await page.goto("/kiosks");
  await kiosksReady(page);
  const count = topCount(page);
  await expect(count).toHaveText("3 PIN requests");
  await expect(rowCount(page, "Test web kiosk A")).toHaveText("2 PIN requests");
  await expect(rowCount(page, "Test web kiosk B")).toHaveText("1 PIN request");
  await expect(rowCount(page, "Test web kiosk B")).toHaveAccessibleName("1 PIN request waiting at Test web kiosk B. Open it.");
  await expect(rowCount(page, "Front desk")).toHaveCount(0);

  await count.click();
  const dialog = page.getByRole("dialog", { name: "PIN requests" });
  await expect(dialog).toBeVisible();
  await expect(count).toHaveAttribute("aria-expanded", "true");
  await expect(dialog).toContainText("Approve or decline waiting PIN requests without leaving your current page.");
  await expect(dialog.getByRole("heading", { level: 3 })).toHaveText(["Test web kiosk A", "Test web kiosk B"]);
  const kioskA = dialog.getByRole("region", { name: "PIN requests at Test web kiosk A" }), kioskB = dialog.getByRole("region", { name: "PIN requests at Test web kiosk B" });
  await expect(kioskA.locator(".kiosk-pin-request")).toHaveText([/^Test Student A · A-101Asked to set up a PIN · 2 minutes agoDeclineApprove$/, /^Test Student B · A-102Asked to set up a PIN · less than a minute agoDeclineApprove$/]);
  await expect(kioskB.locator(".kiosk-pin-request")).toHaveText([/^Test Student C · A-103Asked to set up a PIN · 6 minutes agoDeclineApprove$/]);
  await expect(dialog).toContainText("Approving lets the member choose a PIN on the kiosk within 5 minutes. Admins and Operators can approve.");
  // The rows are Manage kiosk's own: the same list, buttons and theme tokens.
  expect(await dialog.locator(".kiosk-pin-request-list").count()).toBe(2);
  const approve = kioskA.getByRole("group", { name: "PIN request from Test Student A" }).getByRole("button", { name: "Approve" });
  expect(await approve.evaluate((element) => { const style = getComputedStyle(element), app = getComputedStyle(element.closest(".app")!); const probe = document.createElement("i"); probe.style.color = app.getPropertyValue("--primary"); element.append(probe); const primary = getComputedStyle(probe).color; probe.remove(); return style.backgroundColor === primary && parseFloat(style.minHeight) >= 44; })).toBe(true);
  expect((await dialog.getByRole("button", { name: "Close PIN requests dialog" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Focus is held in the dialog.
  const focusInDialog = () => page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")));
  await expect.poll(focusInDialog).toBe(true);
  await page.keyboard.press("Shift+Tab"); expect(await focusInDialog()).toBe(true);
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); expect(await focusInDialog()).toBe(true);

  // Approve, as on Manage kiosk: no confirmation, the same notice, the same route.
  await approve.click();
  await expect(dialog.getByRole("status")).toHaveText("Approved. Test Student A can choose a PIN on the kiosk within 5 minutes.");
  await expect(kioskA.locator(".kiosk-pin-request")).toHaveCount(1);
  await expect(count).toHaveText("2 PIN requests");
  await expect(rowCount(page, "Test web kiosk A")).toHaveText("1 PIN request");
  await expect(rowCount(page, "Test web kiosk B")).toHaveText("1 PIN request");

  // Decline the only request at kiosk B: its group and its row count go.
  await kioskB.getByRole("button", { name: "Decline" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Declined Test Student C's PIN request.");
  await expect(dialog.getByRole("heading", { level: 3 })).toHaveText(["Test web kiosk A"]);
  await expect(count).toHaveText("1 PIN request");
  await expect(rowCount(page, "Test web kiosk B")).toHaveCount(0);

  // Another Operator answers the last one first: the error shows, and the request leaves on the refresh.
  expect((await page.request.post(`${mockApi}/admin/pin-requests/pin-request-4/decline`, { headers: { "x-preview-scenario": `pin-request-indicator-${testInfo.testId}-${testInfo.retry}` }, data: {} })).status()).toBe(200);
  await kioskA.getByRole("button", { name: "Approve" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That PIN request was already answered or has expired.");
  // The count reached 0: the button and the last row count are gone, and the open dialog says so.
  await expect(dialog).toContainText("No PIN requests are waiting.");
  await expect(count).toHaveCount(0);
  await expect(page.locator(".kiosk-pin-request-count")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(writes.map((request) => [request.method(), new URL(request.url()).pathname])).toEqual([["POST", "/admin/pin-requests/pin-request-3/approve"], ["POST", "/admin/pin-requests/pin-request-5/decline"], ["POST", "/admin/pin-requests/pin-request-4/approve"]]);
});

test("the count shows on every page, appears on the shell's next refresh and costs no request of its own", async ({ page }, testInfo) => {
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  const requests: string[] = [];
  page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.startsWith("/admin/") && path.includes("pin-requests") || path === "/platform/modules") requests.push(path); });
  await page.goto("/roster");
  await expect(page.getByRole("heading", { name: "Roster", level: 1 })).toBeVisible();
  await expect(topCount(page)).toHaveCount(0);
  await askForPin("web-kiosk-b", "C", 1);
  await refreshShell(page);
  await expect(topCount(page)).toHaveText("1 PIN request");
  // Only the module refresh was asked, never a route for the count.
  expect(requests.filter((path) => path !== "/platform/modules"), JSON.stringify(requests)).toEqual([]);

  // Opening the dialog reads the requests; closing it stops.
  await topCount(page).click();
  const dialog = page.getByRole("dialog", { name: "PIN requests" });
  await expect(dialog.getByRole("region", { name: "PIN requests at Test web kiosk B" })).toContainText("Test Student C · A-103");
  expect(requests.filter((path) => path !== "/platform/modules")).toEqual(["/admin/kiosks/pin-requests"]);
  const opener = topCount(page);
  await dialog.getByRole("button", { name: "Close PIN requests dialog" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(opener).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page).toHaveURL(/\/reports/);
  await expect(topCount(page)).toHaveText("1 PIN request");
});

test("an account that is neither Operator nor Admin sees no count anywhere", async ({ page }, testInfo) => {
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`, "member");
  await askForPin("web-kiosk-a", "A"); await askForPin("web-kiosk-b", "B");
  await page.goto("/kiosks");
  await kiosksReady(page);
  await refreshShell(page);
  await page.waitForLoadState("networkidle");
  await expect(topCount(page)).toHaveCount(0);
  await expect(page.locator(".kiosk-pin-request-count")).toHaveCount(0);
  await expect(page.getByText(/PIN request/)).toHaveCount(0);
});

/** The preview's organization, with the default brand mark in place of its wide logo when `mark` is set. */
async function useBrand(page: Page, mark: boolean) {
  await page.route("**/setup/status", async (route) => {
    const response = await route.fetch(); const json = await response.json();
    await route.fulfill({ response, json: { ...json, settings: { ...json.settings, organizationName: "Test Robotics Team", ...(mark ? { logoData: "", subtitle: "" } : {}) } } });
  });
}
/** How the top bar's count is drawn: with its label, or as the count alone. Its text is the same either way. */
const countShape = (page: Page) => topCount(page).evaluate((element) => { const style = getComputedStyle(element), badge = getComputedStyle(element.querySelector("span")!), box = element.getBoundingClientRect(); return { labelled: parseFloat(style.fontSize) > 0, width: box.width, height: box.height, badgeFont: parseFloat(badge.fontSize), badgeColor: badge.color }; });
const warningColor = (page: Page) => page.locator(".app").evaluate((app) => { const probe = document.createElement("i"); probe.style.color = "var(--ui-warning)"; app.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });

for (const width of [375, 800, 1280]) test(`counts on two kiosks fit at ${width} px with no side scroll, in the page and the dialog`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await useBrand(page, false);
  await askForPin("web-kiosk-a", "A", 2); await askForPin("web-kiosk-a", "B"); await askForPin("web-kiosk-b", "C", 6);
  await page.goto("/kiosks");
  await kiosksReady(page);
  const count = topCount(page);
  await expect(count).toBeVisible();
  await expect(count).toHaveAccessibleName("3 PIN requests waiting. Open PIN requests.");
  await expect(count).toHaveAttribute("title", "3 PIN requests waiting");
  await expectResponsiveFit(page, { controls: ".dashboard-toolbar button, .dashboard-toolbar a, .kiosk-device-row > *" });

  // The kiosk's name is never squeezed until it breaks inside a word: where the row is too narrow for the name, both
  // pills and the rename button, the count takes its own line under the name.
  for (const kiosk of ["Test web kiosk A", "Test web kiosk B"]) {
    const option = page.locator(".kiosk-device-option").filter({ has: page.getByRole("button", { name: new RegExp(`^${kiosk}`) }) });
    const layout = await option.evaluate((element) => {
      const name = element.querySelector<HTMLElement>(".kiosk-device-name strong")!, select = element.querySelector<HTMLElement>(".kiosk-device-select")!, pill = element.querySelector<HTMLElement>(".kiosk-pin-request-count")!, edit = element.querySelector<HTMLElement>(".kiosk-edit-button")!;
      // A word drawn in more than one piece was broken across lines.
      const text = name.firstChild as Text; const brokenWords: string[] = [];
      for (const match of text.data.matchAll(/\S+/g)) { const range = document.createRange(); range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length); if (range.getClientRects().length > 1) brokenWords.push(match[0]); }
      const box = (item: HTMLElement) => item.getBoundingClientRect();
      return { tile: box(element).width, brokenWords, pillBelow: box(pill).top >= box(select).bottom - 1, pillBeside: box(pill).left >= box(select).right - 1 && box(pill).right <= box(edit).left + 1 && box(pill).top < box(select).bottom, editOnFirstLine: box(edit).top < box(select).bottom && box(edit).left >= box(select).right - 1, pillInside: box(pill).left >= box(element).left && box(pill).right <= box(element).right + 1, rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize) };
    });
    expect(layout.brokenWords, `${kiosk} at ${width}: ${JSON.stringify(layout)}`).toEqual([]);
    expect(layout.pillInside).toBe(true);
    expect(layout.editOnFirstLine).toBe(true);
    if (layout.tile <= 22 * layout.rootFont) expect(layout.pillBelow).toBe(true); else expect(layout.pillBeside).toBe(true);
    // Three tiles share the list at 800 px, so each is narrow there; one tile has the whole width on a phone.
    if (width !== 1280) expect(layout.pillBelow, JSON.stringify(layout)).toBe(true); else expect(layout.pillBeside, JSON.stringify(layout)).toBe(true);
  }

  // From 1000 px down the bar has no room for the label beside the organization name: the count alone, in the warning
  // tone of the row counts. The logo is never pushed under the navigation.
  const shape = await countShape(page);
  expect(shape.height).toBeGreaterThanOrEqual(44);
  if (width === 1280) {
    expect(shape.labelled).toBe(true);
    expect(await page.locator(".dashboard-brand .brand-heading strong").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  } else {
    expect(shape.labelled).toBe(false);
    expect(shape.width).toBeLessThanOrEqual(48); expect(shape.width).toBeGreaterThanOrEqual(44);
    expect(shape.badgeFont).toBeGreaterThanOrEqual(14);
    expect(shape.badgeColor).toBe(await warningColor(page));
  }
  expect(await page.locator(".dashboard-toolbar").evaluate((toolbar) => { const logo = toolbar.querySelector(".dashboard-brand > :first-child")!.getBoundingClientRect(); const next = [...toolbar.querySelectorAll<HTMLElement>(".mobile-menu-toggle, .primary-navigation, .toolbar-end")].filter((element) => element.getClientRects().length && getComputedStyle(element).position !== "fixed").map((element) => element.getBoundingClientRect().left); return logo.right <= Math.min(...next) + 1; })).toBe(true);

  await count.click();
  const dialog = page.getByRole("dialog", { name: "PIN requests" });
  await expect(dialog.locator(".kiosk-pin-request")).toHaveCount(3);
  await expectResponsiveFit(page, { controls: "[role=dialog] button, [role=dialog] h3" });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  for (const button of await dialog.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("at 375 px the organization name stays readable beside the Reviews and PIN request buttons", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await useBrand(page, true);
  await page.goto("/kiosks");
  await kiosksReady(page);
  const name = page.locator(".dashboard-brand .brand-heading strong");
  const nameWidth = () => name.evaluate((element) => element.getBoundingClientRect().width);
  const before = await nameWidth();
  await askForPin("web-kiosk-a", "A"); await askForPin("web-kiosk-a", "B"); await askForPin("web-kiosk-b", "C");
  await refreshShell(page);
  await expect(topCount(page)).toBeVisible();
  // The count costs the name one control and a gap, no more, and leaves it at least 4rem: "TEST ROB…" here.
  const after = await nameWidth();
  expect(before - after).toBeLessThanOrEqual(48 + 8);
  expect(after).toBeGreaterThanOrEqual(64);
  expect((await countShape(page)).labelled).toBe(false);
  // One line: the buttons stay beside the name.
  expect(await page.locator(".dashboard-toolbar").evaluate((toolbar) => toolbar.querySelector(".toolbar-end")!.getBoundingClientRect().top < toolbar.querySelector(".dashboard-brand")!.getBoundingClientRect().bottom)).toBe(true);
  await expectResponsiveFit(page, { controls: ".dashboard-toolbar button, .dashboard-toolbar a" });
});

test("at 375 px the Update, Reviews and PIN request buttons together take their own line, and the organization name keeps the first", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { askForPin } = await useScenario(page, `${testInfo.testId}-${testInfo.retry}`);
  await useBrand(page, true);
  // An update is available, so the Admin's top bar also has the Update button.
  const channel = bundledVersion.includes("-beta.") ? "beta" : "stable";
  await page.route("**/admin/update-channel", route => route.fulfill({ json: { channel, revision: 1 } }));
  await page.route("**/admin/update-info", route => route.fulfill({ json: { releaseVersion: "0.9.0", workflowUrl: "https://github.example.test/actions/workflows/upgrade-web.yml" } }));
  await page.route("**/__lancerlogin-release", route => route.fulfill({ json: { releaseVersion: "0.9.0" } }));
  await page.route("**/admin/releases/latest", async route => route.fulfill({ json: discovered({ tag_name: `v${bundledVersion}`, prerelease: channel === "beta" }, await page.evaluate(() => Date.now()), channel) }));
  for (const student of ["A", "B", "C"] as const) await askForPin("web-kiosk-a", student);
  await page.goto("/kiosks");
  await kiosksReady(page);
  const toolbar = page.locator(".dashboard-toolbar .toolbar-end");
  await expect(toolbar.locator(".update-indicator")).toBeVisible();
  await expect(toolbar.locator(".contest-indicator:not(.pin-request-indicator)")).toBeVisible();
  await expect(topCount(page)).toHaveAccessibleName("3 PIN requests waiting. Open PIN requests.");
  await expectResponsiveFit(page, { controls: ".dashboard-toolbar button, .dashboard-toolbar a" });
  const layout = await page.locator(".dashboard-toolbar").evaluate((toolbar) => {
    const box = (selector: string) => toolbar.querySelector(selector)!.getBoundingClientRect();
    const name = toolbar.querySelector(".brand-heading strong")!, brand = box(".dashboard-brand"), menu = box(".mobile-menu-toggle"), end = box(".toolbar-end");
    return { nameWhole: name.scrollWidth <= name.clientWidth, nameLeftOfMenu: name.getBoundingClientRect().right <= menu.left + 1, ownLine: end.top >= brand.bottom && end.top >= menu.bottom, endInside: end.left >= 0 && end.right <= innerWidth, buttons: [...toolbar.querySelectorAll(".toolbar-end > button")].map((button) => { const rect = button.getBoundingClientRect(); return [Math.round(rect.height), rect.left >= end.left - 1 && rect.right <= end.right + 1]; }) };
  });
  expect(layout, JSON.stringify(layout)).toMatchObject({ nameWhole: true, nameLeftOfMenu: true, ownLine: true, endInside: true });
  expect(layout.buttons).toHaveLength(3);
  for (const [height, inside] of layout.buttons) { expect(height).toBeGreaterThanOrEqual(44); expect(inside).toBe(true); }
  // With a line to itself the count has its label again, in the Reviews style.
  expect(await countShape(page)).toMatchObject({ labelled: true });
  expect((await countShape(page)).badgeColor).not.toBe(await warningColor(page));
});

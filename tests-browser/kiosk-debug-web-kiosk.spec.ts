import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { expectOpensRealTab, recordWindowOpen } from "./new-tab";

// Debug tools > Open web kiosk on this device, against the dashboard preview API's kiosk state. Each test gets its own
// scenario, which also holds "Debug kiosk OLD1", a debug web kiosk that stopped checking in an hour ago.
async function useDebugScenario(page: Page, id: string, deviceId: string) {
  const scenario = `kiosk-debug-${id}`;
  const pairings: Request[] = [];
  const tag = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    if (route.request().method() === "POST") pairings.push(route.request());
    await route.continue({ headers: { ...route.request().headers(), "x-preview-scenario": scenario } });
  };
  await page.route("**/admin/kiosks", tag);
  await page.route("**/admin/pairing-codes", tag);
  await page.addInitScript((device) => { localStorage.setItem("lancerlogin-debug-mode", "true"); localStorage.setItem("lancerlogin.debugKioskDevice", device); }, deviceId);
  return pairings;
}

async function debugKioskPanel(page: Page) {
  await page.goto("/kiosks");
  const panel = page.getByRole("region", { name: "Debug tools" }).getByRole("region", { name: "Open web kiosk on this device" });
  await expect(panel).toBeVisible();
  return panel;
}
const openButton = (panel: Locator) => panel.getByRole("button", { name: "Open web kiosk on this device" });
const kioskAddress = /\/kiosk#code=[A-Z2-9]{8}$/;

test("Open web kiosk on this device creates a web code named after this browser and opens the kiosk page with it", async ({ page }, testInfo) => {
  const pairings = await useDebugScenario(page, testInfo.testId, "TEST");
  const panel = await debugKioskPanel(page);
  // One real tab; the click asks for a code, so it is never repeated.
  const address = await expectOpensRealTab(page, openButton(panel), kioskAddress, undefined, { attempts: 1 });
  expect(pairings.map((request) => request.postDataJSON())).toEqual([{ kioskName: "Debug kiosk TEST", kind: "web" }]);
  expect(new URL(address).pathname).toBe("/kiosk");
  await expect(panel.getByRole("status")).toHaveText("Debug kiosk TEST opened in a new tab. It pairs on its own and appears in the kiosk list once it checks in.");
});

test("Open web kiosk on this device retires and replaces this browser's debug kiosk that stopped checking in", async ({ page }, testInfo) => {
  const pairings = await useDebugScenario(page, testInfo.testId, "OLD1");
  const panel = await debugKioskPanel(page);
  // Without a real tab: the blank tab is refused as a popup blocker would, so the kiosk address opens on its own.
  const opened = await recordWindowOpen(page, openButton(panel), undefined, () => expect(panel.getByRole("status")).toContainText("Debug kiosk OLD1 opened in a new tab."));
  expect(opened).toEqual([["about:blank", "_blank"], [expect.stringMatching(kioskAddress), "_blank", "noopener"]]);
  expect(pairings.map((request) => request.postDataJSON())).toEqual([{ kioskName: "Debug kiosk OLD1", kind: "web" }, { kioskName: "Debug kiosk OLD1", kind: "web", replaceKioskId: "debug-kiosk-old1" }]);
});

test("Open web kiosk on this device is only in Debug mode", async ({ page }, testInfo) => {
  await useDebugScenario(page, testInfo.testId, "TEST");
  await page.addInitScript(() => localStorage.setItem("lancerlogin-debug-mode", "false"));
  await page.goto("/kiosks");
  await expect(page.getByRole("heading", { level: 1, name: "Kiosks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open web kiosk on this device" })).toHaveCount(0);
});

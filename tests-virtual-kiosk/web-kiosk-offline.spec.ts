import { expect, test, type Page } from "@playwright/test";
import { adminApi, status } from "./virtual-kiosk";

// A web kiosk that loses its network, against the real local Worker and dashboard: the scan is saved on the device,
// the page still loads from its service worker with no network, and the scan reaches the server once the network
// returns. Test Student F (1006) is scanned only here.
test.describe.configure({ mode: "serial" });
const settingsPin = "246810";
const kioskName = "Test web kiosk C";

async function pressAll(page: Page, keys: string) {
  for (const key of keys) await page.getByRole("button", { name: key, exact: true }).click();
}

/** How many files the kiosk's service worker cache holds, and whether the kiosk page is one of them. */
async function cachedFiles(page: Page) {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith("lancerlogin-kiosk-"));
    if (names.length !== 1) return { names, count: 0, page: false };
    const keys = await (await caches.open(names[0]!)).keys();
    return { names, count: keys.length, page: keys.some((request) => new URL(request.url).pathname === "/kiosk") };
  });
}

test("a web kiosk saves a scan offline, starts again with no network, and syncs the scan once it is back online", async ({ page, context, request }) => {
  const api = await adminApi(request);
  const { dashboardUrl } = await status(request);
  expect(dashboardUrl).toBeTruthy();
  await page.setViewportSize({ width: 1024, height: 600 });

  const created = await api.post("/admin/pairing-codes", { kioskName, kind: "web" });
  await page.goto(`${dashboardUrl}/kiosk#code=${created.code}`);
  await expect(page.getByRole("heading", { name: "Pair this kiosk" })).toBeVisible({ timeout: 30_000 });
  // Only the kiosk page links the app manifest.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/kiosk.webmanifest");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByText("Choose a settings PIN")).toBeVisible({ timeout: 20_000 });
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 20_000 });

  // The service worker takes control of the page. The local dashboard runs on Vite's development server, whose
  // modules the worker keeps as they load, so load the page once under its control (a kiosk left running does this
  // on its own; a production build lists its few hashed files to the worker straight away).
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 20_000 }).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await cachedFiles(page)).page, { timeout: 20_000 }).toBe(true);
  // Let the worker finish keeping the files that page load used.
  let previous = -1;
  await expect.poll(async () => { const { count } = await cachedFiles(page); const settled = count === previous; previous = count; return settled; }, { timeout: 30_000, intervals: [1_000] }).toBe(true);

  // Offline: the scan is saved on the device.
  await context.setOffline(true);
  await pressAll(page, "1006");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByText("Test Student F")).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Saved for sync")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByText("Offline · 1 waiting")).toBeVisible({ timeout: 20_000 });

  // Still offline, the page starts again from the service worker and the device's saved roster and settings.
  await page.reload();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Offline · 1 waiting")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(kioskName)).toBeVisible();

  // Back online: the waiting scan is sent with its event ID and recorded once, and the heartbeat reports 0 waiting.
  await context.setOffline(false);
  await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 60_000 });
  const kioskRecord = async () => (await api.get("/admin/kiosks")).kiosks.find((item: { name: string; active: number }) => item.name === kioskName && item.active);
  await expect.poll(async () => (await kioskRecord())?.pendingEvents, { timeout: 90_000 }).toBe(0);
  expect((await kioskRecord()).lastSyncAt).toBeTruthy();
  const meeting = (await api.get("/meetings")).meetings.find((item: { title: string }) => item.title === "Test meeting A");
  const rows = (await api.get(`/attendance?meetingId=${encodeURIComponent(meeting.id)}`)).attendance.filter((row: { externalId: string }) => row.externalId === "1006");
  expect(rows).toHaveLength(1);
  expect(rows[0].checkedInAt).toBeTruthy();
  expect(rows[0].checkedOutAt ?? null).toBeNull();
});

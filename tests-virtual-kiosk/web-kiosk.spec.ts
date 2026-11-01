import { expect, test, type Page } from "@playwright/test";
import { adminApi, status } from "./virtual-kiosk";

// A web kiosk against the real local Worker and dashboard: paired with a code from the Kiosks page API, used with member
// ID entry and member search, and told to pair again once retired. Test Students D (1004) and E (1005) are scanned only here.
test.describe.configure({ mode: "serial" });
const settingsPin = "246810";

async function pressAll(page: Page, keys: string) {
  for (const key of keys) await page.getByRole("button", { name: key, exact: true }).click();
}

test("a web kiosk pairs with a one-time code, takes a member ID scan, searches the roster, and asks to pair again once retired", async ({ page, request }) => {
  const api = await adminApi(request);
  const { dashboardUrl } = await status(request);
  expect(dashboardUrl).toBeTruthy();
  await page.setViewportSize({ width: 1024, height: 600 });

  const created = await api.post("/admin/pairing-codes", { kioskName: "Test web kiosk B", kind: "web" });
  expect(created).toMatchObject({ kind: "web", kioskName: "Test web kiosk B" });
  expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  expect(created.displayCode).toBe(`${created.code.slice(0, 4)}-${created.code.slice(4)}`);

  // The link from the QR code prefills the code and removes it from the address.
  await page.goto(`${dashboardUrl}/kiosk#code=${created.code}`);
  await expect(page.getByRole("heading", { name: "Pair this kiosk" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await page.getByRole("button", { name: "Pair", exact: true }).click();

  await expect(page.getByText("Choose a settings PIN")).toBeVisible({ timeout: 20_000 });
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  // Member ID entry, with the numeric keypad because every test member ID is a number.
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/})).toBeVisible({ timeout: 20_000 });
  await pressAll(page, "1004");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByText("Is this you?")).toBeVisible();
  await expect(page.getByText("Test Student D")).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Welcome")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Test Student D")).toBeVisible();

  // Member search, set from the dashboard and picked up when the page loads its settings.
  const kioskId = (await api.get("/admin/kiosks")).kiosks.find((item: { name: string; active: number }) => item.name === "Test web kiosk B" && item.active).id;
  expect((await api.get("/admin/kiosks")).kiosks.find((item: { id: string }) => item.id === kioskId)).toMatchObject({ kind: "web", memberLookup: "entry" });
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "search" });
  await page.reload();
  await expect(page.getByText("Type your name, member ID or email.")).toBeVisible({ timeout: 30_000 });
  for (const key of "test") await page.getByRole("button", { name: key, exact: true }).click();
  await page.getByRole("button", { name: "Space", exact: true }).click();
  for (const key of "st") await page.getByRole("button", { name: key, exact: true }).click();
  await page.getByRole("button", { name: "Space", exact: true }).click();
  await page.getByRole("button", { name: "e", exact: true }).click();
  const result = page.getByRole("button", { name: /Test Student E/ });
  await expect(result).toHaveCount(1);
  await expect(page.getByText("@example.test")).toHaveCount(0);
  await result.click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Welcome")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Test Student E")).toBeVisible();

  // Retiring the kiosk revokes its credential; the page asks to pair again instead of showing a blank screen.
  await api.delete(`/admin/kiosks/${kioskId}`, { confirmation: "RETIRE KIOSK" });
  await page.reload();
  await expect(page.getByText("This kiosk needs pairing again")).toBeVisible({ timeout: 30_000 });
});

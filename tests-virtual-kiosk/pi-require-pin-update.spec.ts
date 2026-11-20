import { expect, test, type APIRequestContext } from "@playwright/test";
import { adminApi, checkoutRelease, kiosk, kioskReady, panelPost, reportRelease, status } from "./virtual-kiosk";

// Require PIN and a Pi kiosk from before member PINs, against the real Worker, dashboard and kiosk heartbeat: while the
// kiosk's last heartbeat reports release 2.0.0, Manage kiosk > Identification keeps Require PIN off with a notice that
// says to update the kiosk, and the Worker refuses the save; once the kiosk reports this checkout's release, an Admin turns it
// on and the kiosk starts asking for PINs. Nothing is scanned here.
// tests-browser/kiosk-pins-admin.spec.ts covers how the control looks and what the page sends, against a fixture server.
// This file sorts after pi-member-modes.spec.ts, and leaves the kiosk on fingerprints and on the release it found.
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => { await kioskReady(request); });
const oldRelease = "2.0.0";
let releaseBefore = "";

/** Waits until the kiosk service itself reports the mode, which it loads from the Worker when it starts. */
async function kioskUses(request: APIRequestContext, expected: { authenticationMethod: string; requirePin: boolean }) {
  const { url } = await kiosk(request);
  await expect.poll(async () => { try { const health = await (await request.get(`${url}health`)).json(); return { authenticationMethod: health.authenticationMethod, requirePin: health.requirePin }; } catch { return null; } }, { timeout: 60_000 }).toEqual(expected);
}
async function restartKiosk(request: APIRequestContext) {
  const { starts } = await kiosk(request);
  await panelPost(request, "/api/kiosks/0/restart");
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > starts; }, { timeout: 30_000 }).toBe(true);
}

test.afterAll(async ({ request }) => {
  const api = await adminApi(request);
  const { kioskId } = await kiosk(request);
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "fingerprint" });
  await restartKiosk(request);
  await kioskUses(request, { authenticationMethod: "fingerprint", requirePin: false });
  if (releaseBefore && releaseBefore !== (await kiosk(request)).release) await reportRelease(request, releaseBefore);
});

test("a Pi kiosk that reports a release from before member PINs is refused Require PIN until it reports an update", async ({ page, context, request }) => {
  // The kiosk's heartbeat tells the Worker it runs 2.0.0, as a Pi that was never updated does.
  releaseBefore = await reportRelease(request, oldRelease);
  const { kioskId } = await kiosk(request);
  const { apiUrl, dashboardUrl } = await status(request);
  expect(dashboardUrl).toBeTruthy();
  // Signing in through the browser context's own requests signs the dashboard in too.
  const api = await adminApi(context.request);
  const record = async () => (await api.get("/admin/kiosks")).kiosks.find((item: { id: string }) => item.id === kioskId);
  expect(await record()).toMatchObject({ releaseVersion: oldRelease, requirePin: false });

  // The Worker refuses to turn Require PIN on, and changes nothing.
  const turnOn = { authenticationMethod: "member_id", memberLookup: "entry", requirePin: true };
  const refused = await context.request.patch(`${apiUrl}/admin/kiosks/${kioskId}/authentication-method`, { headers: { origin: new URL(dashboardUrl!).origin }, data: turnOn });
  expect(refused.status(), await refused.text()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "kiosk_update_required_for_pin", error: expect.stringMatching(/^Update this kiosk before turning on Require PIN\./) });
  expect(await record()).toMatchObject({ requirePin: false });
  // Member ID entry without a PIN is still allowed for the old kiosk.
  expect(await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { ...turnOn, requirePin: false })).toMatchObject({ requirePin: false });

  // The dashboard does not offer it either, and says what to do.
  await page.goto(`${dashboardUrl}/kiosks/${kioskId}/manage`);
  await expect(page.getByRole("heading", { name: "Manage kiosk" })).toBeVisible({ timeout: 30_000 });
  await page.getByText("Identification", { exact: true }).click();
  await expect(page.getByLabel("Authentication method for selected kiosk")).toHaveValue("member_id");
  const requirePin = page.getByRole("checkbox", { name: "Require PIN", exact: true });
  await expect(requirePin).toBeDisabled();
  await expect(requirePin).not.toBeChecked();
  const notice = page.locator("#kiosk-require-pin-warning");
  await expect(notice).toHaveText("Without a PIN, anyone can sign in someone else. Update this kiosk to use Require PIN, or use a fingerprint kiosk where that matters.");

  // The kiosk is updated: its next heartbeat reports this checkout's release.
  await reportRelease(request, checkoutRelease);
  expect(await record()).toMatchObject({ releaseVersion: checkoutRelease, requirePin: false });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Manage kiosk" })).toBeVisible({ timeout: 30_000 });
  await page.getByText("Identification", { exact: true }).click();
  await expect(requirePin).toBeEnabled();
  await expect(notice).toHaveText("Without a PIN, anyone can sign in someone else. Use Require PIN or a fingerprint kiosk where that matters.");
  await requirePin.check();
  await expect(notice).toHaveCount(0);
  await page.getByRole("button", { name: "Save method" }).click();
  await expect.poll(async () => (await record())?.requirePin, { timeout: 20_000 }).toBe(true);
  // The kiosk loads the setting from the Worker when its service starts, and then asks for PINs.
  await restartKiosk(request);
  await kioskUses(request, { authenticationMethod: "member_id", requirePin: true });
});

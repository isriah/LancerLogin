import { expect, test } from "@playwright/test";
import { kiosk, readerFaults, tapFinger, useAuthenticationMethod } from "./virtual-kiosk";

// The virtual kiosk's fingerprint reader: enrollment from the dashboard, scans, an unknown finger and a reader that is
// unplugged and plugged back in. Test Student C (1003) enrolls finger 1; the other specs scan A and B, and the kiosk
// refuses a second scan of one member seconds after the first.
test.describe.configure({ mode: "serial" });
const fingerC = "member:1003:1";

test.afterEach(async ({ request }) => { await readerFaults(request, { image: null, noMatch: false, score: 180, delayMs: 0, unplugged: false }); });

test("an Admin enrolls a member's finger from the dashboard on the virtual reader", async ({ page, request }) => {
  const api = await useAuthenticationMethod(request, "fingerprint");
  const { kioskId, screenUrl } = await kiosk(request);
  const member = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1003");
  await page.goto(screenUrl);
  const { session } = await api.post(`/admin/kiosks/${kioskId}/enrollment`, {});
  await api.patch(`/admin/kiosks/${kioskId}/enrollment/${session.id}`, { memberId: member.id });

  // The kiosk opens the enrollment screen on its next poll and asks the member to confirm their name.
  await page.getByRole("button", { name: "Yes, begin enrollment" }).click({ timeout: 30_000 });
  await expect(page.getByText("Enrollment scan 1 of 2")).toBeVisible({ timeout: 20_000 });
  await tapFinger(request, fingerC);
  await expect(page.getByText("Enrollment scan 2 of 2")).toBeVisible({ timeout: 20_000 });
  await tapFinger(request, fingerC);
  await expect(page.getByText("Enrollment saved").first()).toBeVisible({ timeout: 20_000 });
  expect(Object.values((await kiosk(request)).reader?.slots ?? {})).toContain(fingerC);
  await page.getByRole("link", { name: "Return to kiosk" }).click();
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
});

test("the enrolled finger records attendance and an unknown finger is refused", async ({ page, request }) => {
  await page.goto((await kiosk(request)).screenUrl);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  await tapFinger(request, fingerC);
  await expect(page.locator("#display-name")).toHaveText(/Test Student C/, { timeout: 20_000 });
  await expect(page.locator("#display-meeting")).toHaveText(/Test meeting A/);

  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  await tapFinger(request, "unknown:stranger");
  await expect(page.locator("#display-message")).toHaveText("Fingerprint not recognized", { timeout: 20_000 });
});

test("a faint or smudged read asks the member to scan again instead of showing the reader offline", async ({ page, request }) => {
  await page.goto((await kiosk(request)).screenUrl);
  for (const [fault, detail] of [["faint", /a little firmer/], ["messy", /Wipe the reader/], ["unusable", /flat on the reader/]] as const) {
    await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
    // An unknown finger, so the reads after the faulty one can't record attendance.
    await readerFaults(request, { image: fault });
    await tapFinger(request, `unknown:${fault}`);
    await expect(page.locator("#display-message")).toHaveText("Scan again", { timeout: 20_000 });
    await expect(page.locator("#display-detail")).toHaveText(detail);
  }
});

test("an unplugged reader shows offline and recovers when plugged back in", async ({ page, request }) => {
  await page.goto((await kiosk(request)).screenUrl);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  await readerFaults(request, { unplugged: true });
  await expect(page.locator("#display-message")).toHaveText("Reader offline", { timeout: 20_000 });
  await readerFaults(request, { unplugged: false });
  // The screen recovers by itself once reads work again, without waiting for the next scan.
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  await expect.poll(async () => (await kiosk(request)).readerOnline, { timeout: 20_000 }).toBe(true);
});

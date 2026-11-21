import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { kiosk, kioskReady, readerFaults, tapFinger, useAuthenticationMethod } from "./virtual-kiosk";

// The virtual kiosk's fingerprint reader: enrollment from the dashboard, scans, an unknown finger and a reader that is
// unplugged and plugged back in. Test Student C (1003) enrolls finger 1; the other specs scan A and B, and the kiosk
// refuses a second scan of one member seconds after the first.
test.describe.configure({ mode: "serial" });
// Each scenario starts from a ready kiosk, so one that fails can't leave the next one a kiosk that is still restarting.
test.beforeEach(async ({ request }) => { await kioskReady(request); });
const fingerC = "member:1003:1";

test.afterEach(async ({ request }) => { await readerFaults(request, { image: null, noMatch: false, score: 180, delayMs: 0, unplugged: false, lateReplies: 0, lateMs: 0, noiseReplies: 0 }); });

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

/** Records every message the kiosk screen shows from now on; the returned function reads them back. */
async function watchDisplay(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = []; (window as unknown as { seenMessages: string[] }).seenMessages = seen;
    const target = document.querySelector("#display-message")!;
    new MutationObserver(() => { seen.push(target.textContent ?? ""); }).observe(target, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { seenMessages: string[] }).seenMessages);
}
const readerState = async (request: APIRequestContext) => (await kiosk(request)).reader as unknown as { faults: { image: string | null; lateReplies: number } };

test("a read the reader received garbled is tried again quietly, not shown as the reader offline", async ({ page, request }) => {
  await page.goto((await kiosk(request)).screenUrl);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  const seen = await watchDisplay(page);
  // Two reads in a row come back as "could not receive the request"; the third is clean.
  await readerFaults(request, { image: "garbled", imageReads: 2 });
  await tapFinger(request, "unknown:garbled", 2_500);
  await expect.poll(async () => (await readerState(request)).faults.image, { timeout: 20_000 }).toBe(null);
  await page.waitForTimeout(1_500);
  expect(await seen()).not.toContain("Reader offline");
  expect((await kiosk(request)).readerOnline).toBe(true);
});

test("an answer that arrives after the kiosk stopped waiting does not confuse the next reads", async ({ page, request }) => {
  await page.goto((await kiosk(request)).screenUrl);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  const seen = await watchDisplay(page);
  // One answer takes 900 ms; the virtual kiosk waits 600 ms. No finger is on the reader at any point.
  await readerFaults(request, { lateReplies: 1, lateMs: 900 });
  await expect.poll(async () => (await readerState(request)).faults.lateReplies, { timeout: 20_000 }).toBe(0);
  // Getting no answer is a reader fault, so the screen may say so; it recovers by itself once the exchange is back in step.
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  await expect.poll(async () => (await kiosk(request)).readerOnline, { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(2_000);
  for (const message of await seen()) expect(["Place finger on reader", "Reader offline", "Lift finger"]).toContain(message);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader");
});

test("enrollment carries on after a faint first image instead of stopping", async ({ page, request }) => {
  const api = await useAuthenticationMethod(request, "fingerprint");
  const { kioskId, screenUrl } = await kiosk(request);
  const member = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1003");
  await page.goto(screenUrl);
  const { session } = await api.post(`/admin/kiosks/${kioskId}/enrollment`, {});
  await api.patch(`/admin/kiosks/${kioskId}/enrollment/${session.id}`, { memberId: member.id });
  await page.getByRole("button", { name: "Yes, begin enrollment" }).click({ timeout: 30_000 });
  await expect(page.getByText("Enrollment scan 1 of 2")).toBeVisible({ timeout: 20_000 });
  // The first two images of the first scan are too faint; the finger stays on and the third is good.
  const secondFinger = "member:1003:2";
  await readerFaults(request, { image: "faint", imageReads: 2 });
  await tapFinger(request, secondFinger, 2_500);
  await expect(page.getByText("Enrollment scan 2 of 2")).toBeVisible({ timeout: 20_000 });
  await tapFinger(request, secondFinger);
  await expect(page.getByText("Enrollment saved").first()).toBeVisible({ timeout: 20_000 });
  expect(Object.values((await kiosk(request)).reader?.slots ?? {})).toContain(secondFinger);
  await page.getByRole("link", { name: "Return to kiosk" }).click();
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
});

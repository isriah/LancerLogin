import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminApi, kiosk, panelPost, readerFaults } from "./virtual-kiosk";

// The Pi kiosk without its fingerprint reader: Member ID entry with the "Is this you?" step, Member search, and Require
// PIN with setup approved from the dashboard or set from the kiosk's maintenance screen. Test Student I (1009) and
// Test Student J (1010) are seeded for these scenarios only; each scans at most twice, minutes apart.
// This file sorts after the fingerprint and pairing scenarios, and puts the kiosk back on fingerprints when it is done.
test.describe.configure({ mode: "serial" });
const settingsPin = "246810";
type Mode = { authenticationMethod: "fingerprint" | "member_id"; memberLookup?: "entry" | "search"; requirePin?: boolean };

/** Sets the kiosk's identification mode, then restarts its service so it applies at once instead of on the next poll. */
async function useMode(request: APIRequestContext, mode: Mode) {
  const api = await adminApi(request);
  const { kioskId, url, starts } = await kiosk(request);
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, mode.authenticationMethod === "member_id" ? { memberLookup: "entry", requirePin: false, ...mode } : mode);
  await panelPost(request, "/api/kiosks/0/restart");
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > starts; }, { timeout: 30_000 }).toBe(true);
  const expected = { authenticationMethod: mode.authenticationMethod, memberLookup: mode.memberLookup ?? "entry", requirePin: mode.requirePin ?? false };
  await expect.poll(async () => { try { const health = await (await request.get(`${url}health`)).json(); return { authenticationMethod: health.authenticationMethod, memberLookup: health.memberLookup, requirePin: health.requirePin }; } catch { return null; } }, { timeout: 60_000 }).toEqual(expected);
  return api;
}

async function openScreen(page: Page, request: APIRequestContext) {
  await page.goto((await kiosk(request)).screenUrl);
  await expect(page.locator("#identity-value")).toBeVisible({ timeout: 30_000 });
}
/** Types a member ID on the numeric keypad (every seeded member ID is a number) and submits it. */
async function keyInMemberId(page: Page, memberId: string) {
  const keypad = page.getByLabel("Member ID keypad");
  await expect(keypad).toBeVisible();
  for (const digit of memberId) await keypad.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.locator("#identity-value")).toHaveValue(memberId);
  await page.getByRole("button", { name: "Submit member ID" }).click();
}
async function pressPin(page: Page, pin: string) {
  const keypad = page.getByLabel("PIN keypad", { exact: true });
  for (const digit of pin) await keypad.getByRole("button", { name: digit, exact: true }).click();
}
const title = (page: Page) => page.locator("#member-flow-title");
/** Opens maintenance and unlocks it with the kiosk's local settings PIN. */
async function openMaintenance(page: Page, request: APIRequestContext) {
  await page.goto(`${(await kiosk(request)).screenUrl.replace(/\/$/, "")}/maintenance`);
  const unlock = page.locator("#pin-keypad");
  await expect(unlock).toBeVisible({ timeout: 20_000 });
  for (const digit of settingsPin) await unlock.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Unlock for five minutes" }).click();
  await expect(page.getByRole("heading", { name: "Member PINs" })).toBeVisible({ timeout: 20_000 });
}

test.afterAll(async ({ request }) => {
  await readerFaults(request, { unplugged: false });
  await useMode(request, { authenticationMethod: "fingerprint" });
});

test("Member ID entry asks \"Is this you?\" before recording", async ({ page, request }) => {
  await useMode(request, { authenticationMethod: "member_id" });
  await openScreen(page, request);
  await expect(page.locator("#display-message")).toHaveText("Enter member ID");
  // Not me goes back without recording anything.
  await keyInMemberId(page, "1009");
  await expect(title(page)).toHaveText("Is this you?", { timeout: 20_000 });
  await expect(page.locator("#member-flow-name")).toHaveText("Test Student I");
  await expect(page.locator("#member-flow-detail")).toHaveText("Member ID 1009");
  await expect(page.locator("#member-flow-note")).toContainText("Returns to start in");
  await page.getByRole("button", { name: "Not me" }).click();
  await expect(page.locator("#identity-value")).toBeVisible();
  await expect(page.locator("#identity-value")).toHaveValue("");
  // Confirm records the visit.
  await keyInMemberId(page, "1009");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("#display-name")).toHaveText(/Test Student I/, { timeout: 20_000 });
  await expect(page.locator("#display-meeting")).toHaveText(/Test meeting A/);
  await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 20_000 }).toBe(0);
});

test("Member search finds a member by email, shows only name and ID, and works with the reader unplugged", async ({ page, request }) => {
  await useMode(request, { authenticationMethod: "member_id", memberLookup: "search" });
  // The fingerprint reader stops answering. Member search doesn't use it, so the kiosk must not say "Reader offline".
  await readerFaults(request, { unplugged: true });
  await openScreen(page, request);
  await expect(page.locator("#display-message")).toHaveText("Find your name");
  await expect(page.getByLabel("Search by name, member ID or email")).toBeVisible();
  await page.locator("#identity-value").fill("test.student.j");
  const result = page.locator("#member-results").getByRole("button", { name: /Test Student J/ });
  await expect(result).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#member-results")).toContainText("1010");
  await expect(page.locator("body")).not.toContainText("example.test");
  await result.click();
  await expect(title(page)).toHaveText("Is this you?");
  await expect(page.getByRole("button", { name: "Back to search" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("#display-name")).toHaveText(/Test Student J/, { timeout: 20_000 });
  await expect(page.locator("#display-message")).not.toHaveText("Reader offline");
  await expect(page.locator("#reader-status")).toHaveText("Member ID ready");
  await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 20_000 }).toBe(0);
  await expect(page.locator("#display-message")).toHaveText("Find your name", { timeout: 20_000 });
  const health = await (await request.get(`${(await kiosk(request)).url}health`)).json();
  expect(health.readerOnline).toBe(true);
  await readerFaults(request, { unplugged: false });
});

test("Require PIN: a member without a PIN asks for approval, an Operator approves on the dashboard, and the new PIN records the visit", async ({ page, request }) => {
  const api = await useMode(request, { authenticationMethod: "member_id", requirePin: true });
  const { kioskId } = await kiosk(request);
  await openScreen(page, request);
  await keyInMemberId(page, "1009");
  await expect(title(page)).toHaveText("Is this you?", { timeout: 20_000 });
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(title(page)).toHaveText("You don't have a PIN yet", { timeout: 20_000 });
  await page.getByRole("button", { name: "Ask for approval" }).click();
  await expect(title(page)).toHaveText("Waiting for approval", { timeout: 20_000 });
  await expect(page.locator("#member-flow-note")).toContainText("maintenance screen");

  // The request appears on Manage kiosk; the Operator approves it there.
  let requestId = "";
  await expect.poll(async () => { const { requests } = await api.get(`/admin/kiosks/${kioskId}/pin-requests`); requestId = requests?.find((item: { member: { memberId: string } }) => item.member.memberId === "1009")?.id ?? ""; return requestId; }, { timeout: 20_000 }).not.toBe("");
  await api.post(`/admin/pin-requests/${requestId}/approve`, {});

  await expect(title(page)).toHaveText("Choose a PIN", { timeout: 20_000 });
  await pressPin(page, "2580");
  await expect(page.locator("#member-flow-dots")).toHaveText("●●●●");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(title(page)).toHaveText("Type your PIN again");
  // A different second PIN starts again.
  await pressPin(page, "2581");
  await page.getByRole("button", { name: "Save PIN" }).click();
  await expect(title(page)).toHaveText("Choose a PIN");
  await expect(page.locator("#member-flow-note")).toHaveText("The two PINs don't match. Choose a PIN again.");
  await pressPin(page, "2580"); await page.getByRole("button", { name: "Next" }).click();
  await pressPin(page, "2580"); await page.getByRole("button", { name: "Save PIN" }).click();
  await expect(page.locator("#display-name")).toHaveText(/Test Student I/, { timeout: 20_000 });
  const member = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1009");
  expect((await api.get(`/admin/members/${member.id}/pin`)).pin).toMatchObject({ set: true });

  // A wrong PIN records nothing and says so.
  await expect(page.locator("#identity-value")).toBeVisible({ timeout: 20_000 });
  await keyInMemberId(page, "1009");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(title(page)).toHaveText("Enter your PIN", { timeout: 20_000 });
  await pressPin(page, "0000");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(title(page)).toHaveText("Wrong PIN", { timeout: 20_000 });
  await expect(page.locator("#member-flow-detail")).toHaveText("Try again, or ask an Operator to reset it.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#identity-value")).toBeVisible();
});

test("Require PIN: an Operator sets and resets a member's PIN from the kiosk's maintenance screen", async ({ page, request }) => {
  const api = await useMode(request, { authenticationMethod: "member_id", requirePin: true });
  await openMaintenance(page, request);

  await page.locator("#pin-member-picker").click();
  await page.locator("#member-options").getByRole("button", { name: "J, Test Student · 1010" }).click();
  await page.getByRole("button", { name: "Set member PIN", exact: true }).click();
  const keypad = page.getByLabel("Keypad for the member's PIN");
  for (const digit of "1357") await keypad.getByRole("button", { name: digit, exact: true }).click();
  await page.locator("#member-pin-next").click();
  await expect(page.locator("#member-pin-title")).toHaveText("Type the PIN again");
  for (const digit of "1357") await keypad.getByRole("button", { name: digit, exact: true }).click();
  await page.locator("#member-pin-next").click();
  await expect(page.locator("#message")).toHaveText("PIN set for Test Student J.", { timeout: 20_000 });
  const member = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1010");
  expect((await api.get(`/admin/members/${member.id}/pin`)).pin).toMatchObject({ set: true });

  // Back at attendance, J signs in with the PIN set in maintenance.
  await page.getByRole("link", { name: "Return to kiosk" }).click();
  await expect(page.locator("#identity-value")).toBeVisible({ timeout: 30_000 });
  await keyInMemberId(page, "1010");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(title(page)).toHaveText("Enter your PIN", { timeout: 20_000 });
  await pressPin(page, "1357");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.locator("#display-name")).toHaveText(/Test Student J/, { timeout: 20_000 });

  // Reset removes the PIN; the member then sets a new one.
  await openMaintenance(page, request);
  await page.locator("#pin-member-picker").click();
  await page.locator("#member-options").getByRole("button", { name: "J, Test Student · 1010" }).click();
  await page.getByRole("button", { name: "Reset member PIN", exact: true }).click();
  await page.locator("#accept-action").click();
  await expect(page.locator("#message")).toHaveText("PIN reset for Test Student J.", { timeout: 20_000 });
  expect((await api.get(`/admin/members/${member.id}/pin`)).pin).toMatchObject({ set: false });
  await page.getByRole("link", { name: "Return to kiosk" }).click();
  await expect(page.locator("#identity-value")).toBeVisible({ timeout: 30_000 });
});

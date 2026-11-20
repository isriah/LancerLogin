import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { kiosk, kioskReady, setMeetingState, status, tapFinger, useAuthenticationMethod, type MeetingState, type MeetingStatus } from "./virtual-kiosk";

// The control panel's Meeting card: each state it gives Test meeting A, and what the kiosk shows for a fingerprint scan
// in that state. Test Student M (1013) is scanned only here, so each scan's outcome follows from the ones before it:
// refused with no meeting open (the kiosk says why), an arrival, a repeat, a departure, then refused as already done. The last scenario and
// afterAll put the meeting back in progress, as seeded, for the specs that follow.
test.describe.configure({ mode: "serial" });
// Each scenario starts from a ready kiosk, so one that fails can't leave the next one a kiosk that is still restarting.
test.beforeEach(async ({ request }) => { await kioskReady(request); });
test.afterAll(async ({ request }) => { await setMeetingState(request, "in_progress"); });

const fingerM = "member:1013:1";
// The installation's time zone here is UTC: the Worker decides "today" and shows times in it.
const utcDay = (instant: string | number) => new Date(instant).toISOString().slice(0, 10);
const utcTime = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(instant)).replace(/[\u202f\u00a0]/g, " ");
const noMeetingToday = { message: "No meeting today", detail: "Nothing to scan in for right now" };

/**
 * What the kiosk shows for a scan refused in a state where no meeting takes it. The panel moves the meeting relative to
 * now, so near midnight UTC "later today" starts tomorrow and "ended" ended yesterday: the Worker then says there is no
 * meeting today, and so does this.
 */
function refusalScreen(state: MeetingState, meeting: MeetingStatus) {
  const today = utcDay(Date.now());
  if (state === "later" && utcDay(meeting.startsAt!) === today) return { message: "Too early", detail: `Test meeting A opens for scans at ${utcTime(meeting.opensAt!)}` };
  if (state === "ended" && (utcDay(meeting.startsAt!) === today || utcDay(meeting.endsAt!) === today)) return { message: "Meeting ended", detail: `Scans for Test meeting A closed at ${utcTime(meeting.closesAt!)}` };
  return noMeetingToday;
}
let lastTapAt = 0, arrivedAt = 0;

async function openScreen(page: Page, request: APIRequestContext) {
  await page.goto((await kiosk(request)).screenUrl);
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
}

/** Taps Test Student M's finger once the screen is idle again and the kiosk's 8-second repeat guard for a finger has passed. */
async function scan(page: Page, request: APIRequestContext) {
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
  const wait = lastTapAt + 9_500 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await tapFinger(request, fingerM);
  lastTapAt = Date.now();
}

async function expectScreen(page: Page, message: string, detail: string | RegExp) {
  await expect(page.locator("#display-message")).toHaveText(message, { timeout: 20_000 });
  await expect(page.locator("#display-detail")).toHaveText(detail);
}

async function useMeetingState(request: APIRequestContext, state: MeetingState, scanAccepted: boolean) {
  const meeting = await setMeetingState(request, state);
  // The panel reports the state from the saved times, and both test meetings stay in the list.
  expect(meeting).toMatchObject({ state, title: "Test meeting A", scanAccepted, scanMeetingTitle: scanAccepted ? "Test meeting A" : null });
  expect(meeting?.meetingCount).toBeGreaterThanOrEqual(2);
  return meeting!;
}

test("an Admin enrolls Test Student M's finger and the panel shows the seeded meeting in progress", async ({ page, request }) => {
  expect((await status(request)).meeting).toMatchObject({ state: "in_progress", title: "Test meeting A", scanAccepted: true });
  const api = await useAuthenticationMethod(request, "fingerprint");
  const { kioskId, screenUrl } = await kiosk(request);
  const member = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1013");
  await page.goto(screenUrl);
  const { session } = await api.post(`/admin/kiosks/${kioskId}/enrollment`, {});
  await api.patch(`/admin/kiosks/${kioskId}/enrollment/${session.id}`, { memberId: member.id });
  await page.getByRole("button", { name: "Yes, begin enrollment" }).click({ timeout: 30_000 });
  await expect(page.getByText("Enrollment scan 1 of 2")).toBeVisible({ timeout: 20_000 });
  await tapFinger(request, fingerM);
  await expect(page.getByText("Enrollment scan 2 of 2")).toBeVisible({ timeout: 20_000 });
  await tapFinger(request, fingerM);
  await expect(page.getByText("Enrollment saved").first()).toBeVisible({ timeout: 20_000 });
  lastTapAt = Date.now();
  expect(Object.values((await kiosk(request)).reader?.slots ?? {})).toContain(fingerM);
  // Attendance stays paused until the enrollment screen is left.
  await page.getByRole("link", { name: "Return to kiosk" }).click();
  await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 20_000 });
});

test("the control panel's Meeting card shows the state and moves the meeting", async ({ page, request }) => {
  await page.goto(process.env.LANCERLOGIN_VIRTUAL_KIOSK_PANEL as string);
  const card = page.getByTestId("meeting-card");
  await expect(card.getByRole("button")).toHaveText(["In progress (default)", "Starts soon, arrivals open", "Starts later today", "No meeting today", "Ended, late scans open", "Ended, attendance closed"]);
  await expect(card.getByTestId("meeting-state")).toHaveText("In progress");
  await expect(card.getByTestId("meeting-scan")).toHaveText("Recorded for Test meeting A");
  await card.getByRole("button", { name: "Ended, attendance closed" }).click();
  await expect(card.getByTestId("meeting-state")).toHaveText("Ended, attendance closed");
  await expect(card.getByTestId("meeting-scan")).toHaveText("Refused: no meeting is accepting scans");
  await expect(card.getByRole("button", { name: "Ended, attendance closed" })).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "In progress (default)" }).click();
  await expect(card.getByTestId("meeting-state")).toHaveText("In progress");
});

test("a refused scan says why while no meeting accepts attendance: too early, no meeting today, and meeting ended", async ({ page, request }) => {
  await openScreen(page, request);
  for (const state of ["later", "none_today", "ended"] as const) {
    const meeting = await useMeetingState(request, state, false);
    const expected = state === "none_today" ? noMeetingToday : refusalScreen(state, meeting);
    // The change needs no restart: the kiosk's next scan is refused, with the reason as its headline.
    await scan(page, request);
    const shownAt = Date.now();
    await expectScreen(page, expected.message, expected.detail);
    // A notice, framed in a fixed amber, not the red of a scan that needs help.
    await expect(page.locator(".kiosk-shell")).toHaveClass(/kiosk-shell-scan_notice/);
    await expect(page.locator(".kiosk-shell")).not.toHaveClass(/kiosk-shell-rejected/);
    await expect(page.locator("#display-name")).toBeHidden();
    await expect(page.locator("#display-meeting")).toBeHidden();
    // It stays up for five seconds (other refusals: 2.8), then the kiosk is ready again.
    await page.waitForTimeout(Math.max(0, shownAt + 3_500 - Date.now()));
    await expect(page.locator("#display-message")).toHaveText(expected.message);
    await expect(page.locator("#display-message")).toHaveText("Place finger on reader", { timeout: 8_000 });
  }
  expect((await kiosk(request)).pendingScans).toBe(0);
});

test("a scan inside the early arrival allowance records an arrival, and a repeat moments later changes nothing", async ({ page, request }) => {
  await openScreen(page, request);
  await useMeetingState(request, "early", true);
  await scan(page, request);
  arrivedAt = Date.now();
  await expectScreen(page, "Welcome", "Arrival recorded");
  await expect(page.locator("#display-name")).toHaveText("Test Student M");
  await expect(page.locator("#display-meeting")).toHaveText("Test meeting A");

  await useMeetingState(request, "in_progress", true);
  await scan(page, request);
  await expectScreen(page, "Already recorded", "Attendance was not changed");
});

test("a scan inside the late scan allowance records a departure, and the member is then refused as complete", async ({ page, request }) => {
  await openScreen(page, request);
  await useMeetingState(request, "late", true);
  // The Worker counts a scan within 90 seconds of the member's last one as a repeat, so the departure waits that out.
  const wait = arrivedAt + 95_000 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await scan(page, request);
  await expectScreen(page, "Goodbye", "Departure recorded");
  await expect(page.locator("#display-meeting")).toHaveText("Test meeting A");

  // Back to the seeded state. A member who has arrived and left is refused for the rest of the meeting.
  await useMeetingState(request, "in_progress", true);
  await scan(page, request);
  await expectScreen(page, "Already done", "You've already checked in and out of this meeting");
  await expect(page.locator(".kiosk-shell")).toHaveClass(/kiosk-shell-scan_notice/);
  expect((await kiosk(request)).pendingScans).toBe(0);
});

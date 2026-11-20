import { expect, type Page } from "@playwright/test";

// The web kiosk page (/kiosk) against a mocked kiosk API, for layout checks. The dashboard preview API has no kiosk
// device routes, so every /kiosk/* call is answered here. Every value is synthetic.

export const kioskSettingsPin = "246810";
export const kioskName = "Test web kiosk A";

type Reply = { status?: number; json: unknown };
export type KioskMockOptions = {
  /** Merged over a member ID entry kiosk with numeric member IDs. */
  settings?: Record<string, unknown>;
  members?: Array<Record<string, unknown>>;
  /** The answer to a scan; accepted as a check-in when omitted. */
  attendance?: (scan: Record<string, unknown>) => Reply;
};

/** Twelve members named "Test Student …", so a search for "test" fills the result list. */
export const testMembers = (extra: Record<string, unknown> = {}) => "ABCDEFGHIJKL".split("").map((letter, index) => ({ memberId: String(1001 + index), firstName: "Test", lastName: `Student ${letter}`, ...extra }));

export async function mockKioskApi(page: Page, options: KioskMockOptions = {}) {
  const settings = { organizationName: "Test Robotics Team", authenticationMethod: "member_id", kind: "web", memberLookup: "entry", requirePin: false, discordCode: false, discordCodeBackup: "offline", ...options.settings };
  const members = options.members ?? testMembers();
  await page.route((url) => url.pathname.startsWith("/kiosk/"), (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const reply = (value: Reply) => route.fulfill({ status: value.status ?? 200, json: value.json });
    if (path === "/kiosk/pair") return reply({ json: { kioskId: "web-kiosk-test", kioskToken: "test-kiosk-token", pairingId: "pairing-test", name: kioskName, kind: "web" } });
    if (path === "/kiosk/config") return reply({ json: { kiosk: { id: "web-kiosk-test", name: kioskName }, settings } });
    if (path === "/kiosk/roster") return reply({ json: { members } });
    if (path === "/kiosk/heartbeat") return reply({ json: { ok: true, kioskId: "web-kiosk-test", receivedAt: new Date().toISOString() } });
    if (path === "/kiosk/commands") return reply({ json: { command: null } });
    if (path === "/kiosk/attendance") {
      const scan = request.postDataJSON() as Record<string, unknown>;
      return reply(options.attendance?.(scan) ?? { json: { accepted: true, eventId: scan.eventId, action: "check_in", meeting: { id: "meeting-test", title: "Test Build Session" } } });
    }
    if (path === "/kiosk/scan-reviews") return reply({ json: { reviews: [] } });
    if (path === "/kiosk/pin-failures") return reply({ json: { recorded: 0 } });
    return reply({ status: 404, json: { error: "Not found" } });
  });
}

export async function pressKeys(page: Page, keys: string) {
  for (const key of keys) await page.getByRole("button", { name: key, exact: true }).click();
}

/** Opens /kiosk and stops at the pairing screen. */
export async function openKiosk(page: Page) {
  await page.goto("/kiosk");
  await expect(page.getByRole("heading", { name: "Pair this kiosk" })).toBeVisible();
}

/** Types the pairing code and stops at "Choose a settings PIN". */
export async function enterPairingCode(page: Page) {
  await page.keyboard.type("K7Q2M9XD");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Choose a settings PIN" })).toBeVisible();
}

/** Chooses the settings PIN (typed twice); the kiosk then loads its config and roster and shows its start screen. */
export async function chooseSettingsPin(page: Page) {
  await page.keyboard.type(kioskSettingsPin); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Type the PIN again" })).toBeVisible();
  await page.keyboard.type(kioskSettingsPin); await page.keyboard.press("Enter");
}

export async function pairKiosk(page: Page) {
  await openKiosk(page); await enterPairingCode(page); await chooseSettingsPin(page);
}

/** Holds the organization name for 3 seconds, enters the settings PIN and stops at the maintenance menu. */
export async function openMaintenance(page: Page) {
  await page.getByTestId("wk-brand-hold").dispatchEvent("pointerdown");
  await expect(page.getByRole("heading", { name: "Settings PIN" })).toBeVisible();
  await page.keyboard.type(kioskSettingsPin); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Maintenance" })).toBeVisible();
}

/**
 * The screen the kiosk shows now fits its viewport:
 * - nothing is wider than the screen, so there is no sideways scroll;
 * - scrolled to the top, no content sits above the scroll area, where it could never be reached;
 * - every button can be scrolled fully into view, and the brand row and footer stay on screen;
 * - buttons and fields are at least 44px tall, and at least 44px wide except the on-screen keyboard's keys, which
 *   share a row ten across as a phone keyboard's do.
 */
export async function expectKioskScreenFits(page: Page) {
  const report = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".wk-body")!;
    const shown = (element: Element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
    const name = (element: Element) => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 40) || element.tagName;
    body.scrollTop = 0;
    const frame = body.getBoundingClientRect();
    const content = [...body.querySelectorAll<HTMLElement>("*")].filter(shown);
    const controls = [...document.querySelectorAll<HTMLElement>(".wk-root button, .wk-root .wk-entry, .wk-root .wk-search-field")].filter(shown);
    const small = controls.flatMap((control) => {
      const rect = control.getBoundingClientRect(); const keyboardKey = Boolean(control.closest(".wk-keyboard"));
      return rect.height < 43.5 || !keyboardKey && rect.width < 43.5 ? [`${name(control)} ${Math.round(rect.width)}x${Math.round(rect.height)}`] : [];
    });
    const unreachable = controls.filter((control) => body.contains(control)).flatMap((control) => {
      control.scrollIntoView({ block: "nearest" });
      const rect = control.getBoundingClientRect(); const area = body.getBoundingClientRect();
      return rect.top < area.top - 1 || rect.bottom > area.bottom + 1 ? [name(control)] : [];
    });
    body.scrollTop = 0;
    const chrome = [...document.querySelectorAll<HTMLElement>(".wk-brand, .wk-foot")].flatMap((element) => { const rect = element.getBoundingClientRect(); return rect.top < -1 || rect.bottom > innerHeight + 1 ? [element.className] : []; });
    return {
      sideways: Math.max(body.scrollWidth - body.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      wide: content.filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; }).map(name),
      cutOffAbove: content.filter((element) => element.getBoundingClientRect().top < frame.top - 1).map(name),
      small, unreachable, chrome,
    };
  });
  expect(report).toEqual({ sideways: expect.any(Number), wide: [], cutOffAbove: [], small: [], unreachable: [], chrome: [] });
  expect(report.sideways).toBeLessThanOrEqual(1);
}

export const kioskViewports = [
  { name: "small phone", width: 360, height: 640 },
  { name: "phone", width: 375, height: 812 },
  { name: "landscape phone", width: 640, height: 360 },
  { name: "tablet", width: 768, height: 1024 },
] as const;

/**
 * Walks through the kiosk's main screens. `screen` is called with a name once each screen is showing, so a spec
 * can check it.
 */
export const kioskScenarios: Array<{ name: string; options: KioskMockOptions; run: (page: Page, screen: (name: string) => Promise<void>) => Promise<void> }> = [
  {
    name: "pairing, the settings PIN, member ID entry, confirm and a refusal notice",
    options: { attendance: () => ({ status: 409, json: { error: "No meeting is accepting scans.", code: "no_meeting", reason: "no_meeting_today" } }) },
    async run(page, screen) {
      await openKiosk(page); await screen("pairing");
      await enterPairingCode(page); await screen("settings-pin");
      await chooseSettingsPin(page);
      await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible(); await screen("member-id-entry");
      await page.keyboard.type("1001"); await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Is this you?" })).toBeVisible(); await screen("confirm");
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByRole("heading", { name: "No meeting today" })).toBeVisible(); await screen("refusal-notice");
    },
  },
  {
    name: "member search, the member PIN pad and maintenance",
    options: { settings: { memberLookup: "search", requirePin: true }, members: testMembers({ pin: { hash: "aGFzaA", salt: "c2FsdA", iterations: 100_000 } }) },
    async run(page, screen) {
      await pairKiosk(page);
      await expect(page.getByText("Type your name, member ID or email.")).toBeVisible(); await screen("search-start");
      await page.keyboard.type("test");
      await expect(page.locator(".wk-result-row")).toHaveCount(6); await screen("search-results");
      await page.getByRole("button", { name: /Test Student A/ }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Enter your PIN" })).toBeVisible(); await screen("member-pin");
      await page.keyboard.press("Escape");
      await expect(page.getByText("Type your name, member ID or email.")).toBeVisible();
      await openMaintenance(page); await screen("maintenance");
      await page.getByRole("button", { name: "Set member PIN", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Set member PIN" })).toBeVisible();
      await page.keyboard.type("test");
      await expect(page.locator(".wk-result-row")).toHaveCount(6); await screen("maintenance-member-search");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Unpair this kiosk", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Unpair this kiosk?" })).toBeVisible(); await screen("unpair");
    },
  },
  {
    name: "the Discord code screen and a code that isn't recognized",
    options: { settings: { discordCode: true, discordCodeBackup: "always" }, attendance: () => ({ status: 403, json: { error: "That code isn't valid.", code: "code_invalid" } }) },
    async run(page, screen) {
      await pairKiosk(page);
      await expect(page.getByRole("heading", { name: "Enter your Discord code" })).toBeVisible(); await screen("discord-code");
      await page.keyboard.type("123456"); await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Code not recognized" })).toBeVisible(); await screen("code-not-recognized");
    },
  },
  {
    // An organization name that isn't text makes the brand row throw while it renders.
    name: "the error screen",
    options: { settings: { organizationName: 404 } },
    async run(page, screen) {
      await pairKiosk(page);
      await expect(page.getByRole("heading", { name: "This kiosk hit a problem" })).toBeVisible(); await screen("error");
      await expect(page.getByRole("button", { name: "Reload kiosk" })).toBeVisible();
    },
  },
];

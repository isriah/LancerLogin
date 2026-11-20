import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminApi, kiosk, kioskReady, linkScans, panelPost, refuseScanDeliveries, status } from "./virtual-kiosk";

// Discord code at the Pi kiosk, against the real kiosk service and local Worker: a wrong code is refused, a live code
// records the scan for the member it belongs to, the same code does not work twice, and the backup method is offered
// on the code screen only when the kiosk offers it at any time. Codes are paused while an earlier scan waits to sync.
// The local stack has no Discord, so the test stands in for /code by writing the code's row to the local D1 database
// the way issueDiscordKioskCode (apps/api/src/discord-kiosk-codes.ts) does. Test Student L (1012) is scanned only here.
// Test Students N (1014), O (1015) and P (1016) are scanned only by the paused-codes scenario, once each.
// This file sorts before pi-member-modes.spec.ts, and puts the kiosk back on fingerprints (Discord codes off) when done.
test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => { await kioskReady(request); });
const memberCode = "629481";
const wrongCode = "135790";
type Backup = "offline" | "always";

/** Sets the kiosk's identification mode, then restarts its service so it applies at once instead of on the next poll. */
async function useDiscordCode(request: APIRequestContext, backup: Backup) {
  const api = await adminApi(request);
  const { kioskId, url, starts } = await kiosk(request);
  expect(await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, discordCode: true, discordCodeBackup: backup })).toMatchObject({ discordCode: true, discordCodeBackup: backup });
  await panelPost(request, "/api/kiosks/0/restart");
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > starts; }, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => { try { const health = await (await request.get(`${url}health`)).json(); return { authenticationMethod: health.authenticationMethod, discordCode: health.discordCode, discordCodeBackup: health.discordCodeBackup, cloudOnline: health.cloudOnline }; } catch { return null; } }, { timeout: 60_000 })
    .toEqual({ authenticationMethod: "member_id", discordCode: true, discordCodeBackup: backup, cloudOnline: true });
  return api;
}

const title = (page: Page) => page.locator("#member-flow-title");
async function openCodeScreen(page: Page, request: APIRequestContext) {
  // The Pi's 7-inch touchscreen.
  await page.setViewportSize({ width: 800, height: 480 });
  await page.goto((await kiosk(request)).screenUrl);
  await expect(title(page)).toHaveText("Enter your Discord code", { timeout: 30_000 });
}
async function typeCode(page: Page, code: string) {
  await expect(title(page)).toHaveText("Enter your Discord code", { timeout: 30_000 });
  const keypad = page.getByLabel("Discord code keypad", { exact: true });
  for (const digit of code) await keypad.getByRole("button", { name: digit, exact: true }).click();
}
async function enterCode(page: Page, code: string) {
  await typeCode(page, code);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
}

/** Gives the member a code as /code would: one row holding the code's hash, good for 2 minutes. */
async function issueCode(request: APIRequestContext, rosterId: string, code: string) {
  expect(rosterId).toMatch(/^[\w-]+$/);
  const preview = join(dirname((await status(request)).adminFile), "preview");
  const hash = createHash("sha256").update(`lancerlogin-discord-kiosk-code:${code}`).digest("hex");
  const now = Date.now();
  const sql = `INSERT INTO discord_kiosk_codes (installation_id, member_id, code_hash, expires_at, used_at, created_at) VALUES ('primary', '${rosterId}', '${hash}', '${new Date(now + 120_000).toISOString()}', NULL, '${new Date(now).toISOString()}') ON CONFLICT(installation_id, member_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, used_at = NULL, created_at = excluded.created_at`;
  const result = spawnSync(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "lancerlogin-plugin-dev", "--local", "--config", join(preview, "wrangler.json"), "--persist-to", join(preview, "state"), "--command", sql], { encoding: "utf8", env: { ...process.env, CI: "true" } });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

test.afterAll(async ({ request }) => {
  const api = await adminApi(request);
  const { kioskId, url, starts } = await kiosk(request);
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "fingerprint" });
  await panelPost(request, "/api/kiosks/0/restart");
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > starts; }, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => { try { const health = await (await request.get(`${url}health`)).json(); return { authenticationMethod: health.authenticationMethod, discordCode: health.discordCode }; } catch { return null; } }, { timeout: 60_000 }).toEqual({ authenticationMethod: "fingerprint", discordCode: false });
});

test("a Pi kiosk with Discord code refuses a wrong code and records a live one once", async ({ page, request }) => {
  const api = await useDiscordCode(request, "offline");
  await openCodeScreen(page, request);
  await expect(page.locator("#member-flow-detail")).toHaveText("Run /code in the team Discord to get one.");
  await expect(page.locator("#reader-status")).toHaveText("Discord code ready");
  // The backup is offered only when the kiosk is offline, so the code screen has no way around the code.
  await expect(page.getByRole("button", { name: /^No code\?/ })).toHaveCount(0);
  await expect(page.locator("#identity-value")).toBeHidden();

  const meeting = (await api.get("/meetings")).meetings.find((item: { title: string }) => item.title === "Test meeting A");
  const arrivals = async () => (await api.get(`/attendance?meetingId=${encodeURIComponent(meeting.id)}`)).attendance.filter((row: { externalId: string; checkedInAt?: string | null }) => row.externalId === "1012" && row.checkedInAt).length;
  const rosterId = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1012").id as string;

  // Enter waits for all six digits, which the boxes show as they are typed.
  const enter = page.getByRole("button", { name: "Enter", exact: true });
  await expect(enter).toBeDisabled();
  await typeCode(page, wrongCode.slice(0, 5));
  await expect(page.getByLabel("Code so far: 1 3 5 7 9")).toBeVisible();
  await expect(enter).toBeDisabled();
  await page.getByLabel("Discord code keypad", { exact: true }).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByLabel("No digits entered")).toBeVisible();

  // A code nobody was given is refused and records nothing.
  await enterCode(page, wrongCode);
  await expect(title(page)).toHaveText("Code not recognized", { timeout: 20_000 });
  await expect(page.locator("#member-flow-detail")).toHaveText("Codes work once and expire after 2 minutes. Run /code again for a new one.");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  expect(await arrivals()).toBe(0);

  // L's code records the scan and names L, with no member ID and no PIN.
  await issueCode(request, rosterId, memberCode);
  await enterCode(page, memberCode);
  await expect(page.locator("#display-name")).toHaveText("Test Student L", { timeout: 20_000 });
  await expect(page.locator("#display-message")).toHaveText("Welcome");
  await expect(page.locator("#display-meeting")).toHaveText(/Test meeting A/);
  await expect.poll(arrivals, { timeout: 20_000 }).toBe(1);
  // The code went straight to the server: nothing waits on the kiosk.
  expect((await kiosk(request)).pendingScans).toBe(0);

  // The same code does not work a second time.
  await enterCode(page, memberCode);
  await expect(title(page)).toHaveText("Code not recognized", { timeout: 20_000 });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(title(page)).toHaveText("Enter your Discord code");
  expect(await arrivals()).toBe(1);
});

test("a Pi kiosk that offers the backup at any time opens the member lookup from the code screen and returns to it", async ({ page, request }) => {
  await useDiscordCode(request, "always");
  await openCodeScreen(page, request);
  await page.getByRole("button", { name: "No code? Use member ID", exact: true }).click();
  await expect(page.locator("#identity-value")).toBeVisible();
  await expect(page.locator("#display-message")).toHaveText("Enter member ID");
  await expect(page.getByLabel("Member ID keypad")).toBeVisible();
  // The backup is the usual member lookup: a known ID asks "Is this you?", and Not me stays in the lookup.
  for (const digit of "1012") await page.getByLabel("Member ID keypad").getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Submit member ID" }).click();
  await expect(title(page)).toHaveText("Is this you?", { timeout: 20_000 });
  await expect(page.locator("#member-flow-name")).toHaveText("Test Student L");
  await page.getByRole("button", { name: "Not me" }).click();
  await expect(page.locator("#identity-value")).toBeVisible();
  await page.getByRole("button", { name: "Back to Discord code", exact: true }).click();
  await expect(title(page)).toHaveText("Enter your Discord code");
  await expect(page.locator("#identity-value")).toBeHidden();
});

test("a Pi kiosk that cannot reach the server shows its backup method with a note, and the code screen returns with the connection", async ({ page, request }) => {
  // Still on Discord code with the backup offered at any time, from the scenario above.
  await openCodeScreen(page, request);
  await panelPost(request, "/api/cloud", { online: false });
  try {
    // Codes are checked online only: the code gets no answer, so the kiosk falls back to the member lookup.
    await enterCode(page, wrongCode);
    await expect(page.locator("#identity-value")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#display-message")).toHaveText("Enter member ID");
    await expect(page.locator("#display-notice")).toHaveText("Discord codes need a network connection. Sign in with your member ID instead.");
    await expect(page.getByRole("button", { name: "Back to Discord code", exact: true })).toBeHidden();
    // Nothing about the code waits on the kiosk.
    expect((await kiosk(request)).pendingScans).toBe(0);
  } finally { await panelPost(request, "/api/cloud", { online: true }); }
  await expect(title(page)).toHaveText("Enter your Discord code", { timeout: 90_000 });
  await expect(page.locator("#identity-value")).toBeHidden();
  expect((await kiosk(request)).pendingScans).toBe(0);
});

test("a Pi kiosk pauses Discord codes while an earlier scan waits to sync, and takes them again once the queue is empty", async ({ page, request }) => {
  // Restarting the service starts from no retry delay, whatever the scenarios above left.
  const api = await useDiscordCode(request, "always");
  const meeting = (await api.get("/meetings")).meetings.find((item: { title: string }) => item.title === "Test meeting A");
  const arrivals = async (memberId: string) => (await api.get(`/attendance?meetingId=${encodeURIComponent(meeting.id)}`)).attendance.filter((row: { externalId: string; checkedInAt?: string | null }) => row.externalId === memberId && row.checkedInAt).length;
  const rosterId = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1016").id as string;
  const backupScan = async (memberId: string, name: string) => {
    const keypad = page.getByLabel("Member ID keypad");
    await expect(keypad).toBeVisible();
    for (const digit of memberId) await keypad.getByRole("button", { name: digit, exact: true }).click();
    await page.getByRole("button", { name: "Submit member ID" }).click();
    await expect(title(page)).toHaveText("Is this you?", { timeout: 20_000 });
    await expect(page.locator("#member-flow-name")).toHaveText(name);
    await page.getByRole("button", { name: "Confirm" }).click();
  };
  const deliveries = async () => (await linkScans(request)).map((item) => `${item.scan} ${!item.forwarded ? "refused by the link" : item.status < 300 ? "taken" : `answered ${item.status}`}`);
  expect((await kiosk(request)).pendingScans).toBe(0);
  await openCodeScreen(page, request);

  // The server stays reachable but answers N's backup scan with a refusal the kiosk does not know, so the scan stays queued.
  await refuseScanDeliveries(request, 1, { clearScans: true });
  try {
    await page.getByRole("button", { name: "No code? Use member ID", exact: true }).click();
    await backupScan("1014", "Test Student N");
    await expect(page.locator("#display-detail")).toHaveText("Saved for sync | Welcome", { timeout: 20_000 });
    await expect.poll(deliveries, { timeout: 20_000 }).toEqual(["1014 refused by the link"]);
    // The server did answer, so the kiosk is online and its start screen is still the code entry.
    await expect(title(page)).toHaveText("Enter your Discord code", { timeout: 20_000 });
    await expect(page.locator("#display-notice")).toBeHidden();
    expect(await kiosk(request)).toMatchObject({ cloudOnline: true, pendingScans: 1 });

    // A live code is not sent ahead of the waiting scan: the start screen becomes the backup method and says why.
    await issueCode(request, rosterId, memberCode);
    await enterCode(page, memberCode);
    await expect(page.locator("#identity-value")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#display-message")).toHaveText("Enter member ID");
    await expect(page.locator("#display-notice")).toHaveText("Discord codes are paused while earlier scans sync. Sign in with your member ID instead.");
    await expect(page.getByRole("button", { name: "Back to Discord code", exact: true })).toBeHidden();
    expect(await kiosk(request)).toMatchObject({ cloudOnline: true, pendingScans: 1 });
    expect(await deliveries(), "the code never left the kiosk").toEqual(["1014 refused by the link"]);
    expect([await arrivals("1014"), await arrivals("1016")]).toEqual([0, 0]);

    // O signs in with the backup method meanwhile; that scan joins the queue behind the one from N.
    await backupScan("1015", "Test Student O");
    await expect(page.locator("#display-detail")).toHaveText("Saved for sync | Welcome", { timeout: 20_000 });
  } finally { await refuseScanDeliveries(request, 0); }

  // The kiosk sends the queue again once its retry delay (30 seconds) has passed, at its next check-in with the server
  // (every minute). Both scans reach the server, and the code entry returns with no note.
  await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 120_000 }).toBe(0);
  await expect(title(page)).toHaveText("Enter your Discord code", { timeout: 30_000 });
  await expect(page.locator("#identity-value")).toBeHidden();
  await expect(page.locator("#display-notice")).toBeHidden();
  expect([await arrivals("1014"), await arrivals("1015")]).toEqual([1, 1]);

  // Codes are taken again. The first code may have run out its 2 minutes during the wait, so P gets a new one.
  const laterCode = "408263";
  await issueCode(request, rosterId, laterCode);
  await enterCode(page, laterCode);
  await expect(page.locator("#display-name")).toHaveText("Test Student P", { timeout: 20_000 });
  await expect(page.locator("#display-message")).toHaveText("Welcome");
  await expect.poll(() => arrivals("1016"), { timeout: 20_000 }).toBe(1);
  // The server got the scans in the order they were made: the one from N, the one from O, then the code.
  await expect.poll(deliveries, { timeout: 20_000 }).toEqual(["1014 refused by the link", "1014 taken", "1015 taken", "code taken"]);
  expect((await kiosk(request)).pendingScans).toBe(0);
});

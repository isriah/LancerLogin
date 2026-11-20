import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminApi, status } from "./virtual-kiosk";

// Discord code at a web kiosk, against the real local Worker and dashboard: a wrong code is refused, a live code records
// the scan for the member it belongs to, the same code does not work twice, and the backup method is one tap away.
// The local stack has no Discord, so the test stands in for /code by writing the code's row to the local D1 database
// the way issueDiscordKioskCode (apps/api/src/discord-kiosk-codes.ts) does. Test Student K (1011) is scanned only here.
test.describe.configure({ mode: "serial" });
const settingsPin = "246810";
const kioskName = "Test web kiosk E";
const memberCode = "482916";
const wrongCode = "135790";

async function pressAll(page: Page, keys: string) {
  for (const key of keys) await page.getByRole("button", { name: key, exact: true }).click();
}

async function enterCode(page: Page, code: string) {
  await expect(page.getByRole("heading", { name: "Enter your Discord code" })).toBeVisible({ timeout: 30_000 });
  await pressAll(page, code);
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

test("a web kiosk with Discord code refuses a wrong code, records a live one once, and offers its backup method", async ({ page, request }) => {
  const api = await adminApi(request);
  const { dashboardUrl } = await status(request);
  expect(dashboardUrl).toBeTruthy();
  await page.setViewportSize({ width: 1024, height: 600 });

  // Pair, then choose Discord code with Member ID as a backup offered any time.
  const created = await api.post("/admin/pairing-codes", { kioskName, kind: "web" });
  await page.goto(`${dashboardUrl}/kiosk#code=${created.code}`);
  await expect(page.getByRole("heading", { name: "Pair this kiosk" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByText("Choose a settings PIN")).toBeVisible({ timeout: 20_000 });
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await pressAll(page, settingsPin);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible({ timeout: 20_000 });
  const kioskRecord = async () => (await api.get("/admin/kiosks")).kiosks.find((item: { name: string; active: number }) => item.name === kioskName && item.active);
  const kioskId = (await kioskRecord()).id;
  expect(await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, discordCode: true, discordCodeBackup: "always" })).toMatchObject({ discordCode: true, discordCodeBackup: "always" });
  expect(await kioskRecord()).toMatchObject({ discordCode: true, discordCodeBackup: "always", memberLookup: "entry" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Enter your Discord code" })).toBeVisible({ timeout: 30_000 });

  const meeting = (await api.get("/meetings")).meetings.find((item: { title: string }) => item.title === "Test meeting A");
  const arrivals = async () => (await api.get(`/attendance?meetingId=${encodeURIComponent(meeting.id)}`)).attendance.filter((row: { externalId: string; checkedInAt?: string | null }) => row.externalId === "1011" && row.checkedInAt).length;
  const rosterId = (await api.get("/admin/members")).members.find((item: { memberId: string }) => item.memberId === "1011").id as string;

  // A code nobody was given is refused and records nothing.
  await enterCode(page, wrongCode);
  await expect(page.getByRole("heading", { name: "Code not recognized" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  expect(await arrivals()).toBe(0);

  // K's code records the scan and names K, with no member ID and no PIN.
  await issueCode(request, rosterId, memberCode);
  await enterCode(page, memberCode);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Test Student K")).toBeVisible();
  await expect.poll(arrivals, { timeout: 20_000 }).toBe(1);

  // The same code does not work a second time.
  await enterCode(page, memberCode);
  await expect(page.getByRole("heading", { name: "Code not recognized" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Try again", exact: true }).click();

  // The backup method is offered any time, and leads back to the code.
  await expect(page.getByRole("heading", { name: "Enter your Discord code" })).toBeVisible();
  await page.getByRole("button", { name: "No code? Use member ID", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Enter your\s*member ID/ })).toBeVisible();
  await page.getByRole("button", { name: "Back to Discord code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enter your Discord code" })).toBeVisible();

  await api.delete(`/admin/kiosks/${kioskId}`, { confirmation: "RETIRE KIOSK" });
});

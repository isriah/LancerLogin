import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { passwordProof } from "../packages/shared/src/password-key.mjs";

// Helpers for the virtual kiosk scenarios. The panel (scripts/virtual-kiosk.mjs) reports each kiosk and drives its
// virtual reader; the local Worker is called as the virtual Admin.
export type KioskStatus = { name: string; screenUrl: string; url: string; running: boolean; serviceReachable: boolean; screenReachable: boolean; starts: number; paired: boolean; kioskId: string | null; cloudOnline: boolean; pendingScans: number | null; lastSeenAt: string | null; readerOnline: boolean; reader: { finger: string | null; slots: Record<string, string> } | null;
  bootId: string; network: { connection: string; ssid: string | null }; linkOnline: boolean; clockVerified: boolean | null; release: string;
  commands: { id: string; type: string; completedAt: string | null; success: number | null; resultMessage: string | null; requestedReleaseVersion: string | null }[] };
export type PanelStatus = { cloudOnline: boolean; apiUrl: string; dashboardUrl: string | null; adminFile: string; kiosks: KioskStatus[] };
const panel = () => process.env.LANCERLOGIN_VIRTUAL_KIOSK_PANEL as string;

export async function status(request: APIRequestContext): Promise<PanelStatus> { return (await request.get(`${panel()}/api/status`)).json(); }
export async function kiosk(request: APIRequestContext) { return (await status(request)).kiosks[0]; }
export async function panelPost(request: APIRequestContext, path: string, data: object = {}) {
  const response = await request.post(`${panel()}${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Waits until the kiosk can run a scenario: its service runs, answers on its own port, is paired and answers through
 * the panel's screen proxy. An earlier scenario can leave it restarting (after an update or a reboot), so each scenario
 * starts from a ready kiosk instead of failing on whatever the last one left behind. A kiosk that never becomes ready
 * fails the scenario here, naming the check that did not pass.
 */
export async function kioskReady(request: APIRequestContext, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let failing = "";
  do {
    // The panel reads the local Worker for its status, so a stalled Worker shows here instead of as a hung scenario.
    const response = await request.get(`${panel()}/api/status`, { timeout: 5_000 }).catch(() => undefined);
    const current = response?.ok() ? ((await response.json()) as PanelStatus).kiosks[0] : undefined;
    failing = !current ? "the control panel, which reads the local Worker, did not answer within 5 s"
      : !current.running ? "its kiosk service is not running"
      : !current.serviceReachable ? `its kiosk service does not answer on its own port (${current.url})`
      : !current.paired ? "it is not paired"
      : !current.screenReachable ? `its screen does not answer through the panel's screen proxy (${current.screenUrl})`
      : "";
    if (!failing) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  } while (Date.now() < deadline);
  throw new Error(`Virtual kiosk 1 was not ready within ${Math.round(timeoutMs / 1000)} s: ${failing}.`);
}

/** Signs in to the local Worker as the virtual Admin and returns a dashboard-style API caller. */
export async function adminApi(request: APIRequestContext) {
  const { apiUrl, adminFile } = await status(request);
  const admin = JSON.parse(readFileSync(adminFile, "utf8")) as { username: string; password: string };
  const origin = "http://localhost:" + (Number(new URL(apiUrl).port) + 1);
  const headers = { origin };
  const params = await request.post(`${apiUrl}/auth/local/params`, { headers, data: { username: admin.username } });
  expect(params.ok(), await params.text()).toBe(true);
  const signIn = await request.post(`${apiUrl}/auth/local`, { headers, data: { username: admin.username, ...await passwordProof(admin.password, await params.json()) } });
  expect(signIn.ok(), await signIn.text()).toBe(true);
  return {
    get: async (path: string) => (await request.get(`${apiUrl}${path}`, { headers })).json(),
    patch: async (path: string, data: object) => { const response = await request.patch(`${apiUrl}${path}`, { headers, data }); expect(response.ok(), await response.text()).toBe(true); return response.json(); },
    post: async (path: string, data: object) => { const response = await request.post(`${apiUrl}${path}`, { headers, data }); expect(response.ok(), await response.text()).toBe(true); return response.json(); },
    delete: async (path: string, data: object) => { const response = await request.delete(`${apiUrl}${path}`, { headers, data }); expect(response.ok(), await response.text()).toBe(true); return response.json(); },
  };
}

/** Sets the kiosk's identification method and waits until the kiosk uses it. */
export async function useAuthenticationMethod(request: APIRequestContext, method: "fingerprint" | "member_id") {
  const api = await adminApi(request);
  const { kioskId, url } = await kiosk(request);
  const current = async () => (await (await request.get(`${url}health`)).json()).authenticationMethod;
  if (await current() === method) return api;
  await api.patch(`/admin/kiosks/${kioskId}/authentication-method`, { authenticationMethod: method });
  // The kiosk picks up its configured method on its next configuration poll, at most a minute away.
  await expect.poll(current, { timeout: 75_000 }).toBe(method);
  return api;
}

export async function enterMemberId(page: Page, screenUrl: string, memberId: string) {
  await page.goto(screenUrl);
  await expect(page.locator("#identity-value")).toBeVisible({ timeout: 20_000 });
  await page.locator("#identity-value").fill(memberId);
  await page.getByRole("button", { name: "Submit member ID" }).click();
  // The kiosk asks "Is this you?" before anything is recorded.
  await expect(page.getByRole("heading", { name: "Is this you?" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Confirm" }).click();
}


/** Taps a finger on the kiosk's virtual reader: it rests there for holdMs, then lifts. */
export async function tapFinger(request: APIRequestContext, finger: string, holdMs = 1200) {
  await panelPost(request, "/api/kiosks/0/reader", { action: "present", finger, holdMs });
}

export async function readerFaults(request: APIRequestContext, faults: object) {
  await panelPost(request, "/api/kiosks/0/reader", { action: "faults", faults });
}

import { expect, test, type APIRequestContext } from "@playwright/test";
import { kiosk, kioskReady, panelPost } from "./virtual-kiosk";

// Dashboard commands, kiosk updates, the clock and the network on the virtual kiosk. Nothing here records attendance.
test.describe.configure({ mode: "serial" });
// Each scenario starts from a ready kiosk, so one that fails can't leave the next one a kiosk that is still restarting.
test.beforeEach(async ({ request }) => { await kioskReady(request); });
const settingsPin = "246810";

/** Sends a command as the dashboard's Manage kiosk page does and waits for the kiosk to report the result. */
async function runCommand(request: APIRequestContext, command: string) {
  const queued = await request.post(`${process.env.LANCERLOGIN_VIRTUAL_KIOSK_PANEL}/api/kiosks/0/command`, { data: { command } });
  expect(queued.ok(), await queued.text()).toBe(true);
  const { id } = (await queued.json()).command;
  const result = async () => (await kiosk(request)).commands.find((item) => item.id === id);
  await expect.poll(async () => Boolean((await result())?.completedAt), { timeout: 60_000 }).toBe(true);
  return (await result())!;
}

async function kioskPost(request: APIRequestContext, path: string, data: object) {
  return request.post(`${(await kiosk(request)).url}${path.replace(/^\//, "")}`, { data });
}

test("every dashboard command reaches the virtual kiosk and reports its result", async ({ request }) => {
  expect((await runCommand(request, "reload_display")).resultMessage).toBe("Display reload requested");

  const { starts } = await kiosk(request);
  expect((await runCommand(request, "restart_service")).success).toBe(1);
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > starts; }, { timeout: 30_000 }).toBe(true);

  const { bootId } = await kiosk(request);
  expect((await runCommand(request, "reboot")).success).toBe(1);
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.bootId !== bootId; }, { timeout: 30_000 }).toBe(true);

  expect((await runCommand(request, "erase_unlinked_fingerprints")).resultMessage).toMatch(/^Erased 0 unlinked fingerprints/);

  expect((await runCommand(request, "reset_network_pin")).resultMessage).toBe("Local settings PIN reset");
  expect(await (await request.get(`${(await kiosk(request)).url}maintenance/session`)).json()).toMatchObject({ configured: false });
  // Set the PIN again so the panel and later scenarios can open maintenance.
  expect((await kioskPost(request, "/network/pin", { pin: settingsPin })).status()).toBe(201);
});

test("a failed update is reported to the dashboard, and an installed one restarts the kiosk", async ({ request }) => {
  await panelPost(request, "/api/kiosks/0/system", { nextUpdate: "fail" });
  const failed = await runCommand(request, "install_latest");
  // The kiosk first reports the update as started, then reports the failure once its update step fails.
  await expect.poll(async () => { const latest = (await kiosk(request)).commands.find((item) => item.id === failed.id); return { success: latest?.success, resultMessage: latest?.resultMessage }; }, { timeout: 30_000 })
    .toEqual({ success: 0, resultMessage: "The virtual update failed, as set in the control panel" });

  await panelPost(request, "/api/kiosks/0/system", { nextUpdate: "install" });
  const { starts } = await kiosk(request);
  const installed = await runCommand(request, "install_latest");
  expect(installed.success).toBe(1);
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > starts; }, { timeout: 30_000 }).toBe(true);
  // With GitHub reachable, the Worker names the release to install, and the kiosk then reports it. Without it, the
  // Worker sends an untargeted stable update and the reported release stays the same.
  if (installed.requestedReleaseVersion) expect((await kiosk(request)).release).toBe(installed.requestedReleaseVersion.replace(/^v/, ""));
});

test("a boot without network time waits until an operator confirms the date and time", async ({ page, request }) => {
  await panelPost(request, "/api/kiosks/0/system", { nextBootClockSynced: false });
  try {
    await panelPost(request, "/api/kiosks/0/reboot");
    await expect.poll(async () => { const current = await kiosk(request); return current.running && current.clockVerified === false; }, { timeout: 30_000 }).toBe(true);
    await page.goto((await kiosk(request)).screenUrl);
    await expect(page.locator("#display-message")).toHaveText("Confirm date and time", { timeout: 20_000 });
    expect((await kioskPost(request, "/network/unlock", { pin: settingsPin })).ok()).toBe(true);
    expect((await kioskPost(request, "/maintenance/clock", { currentTime: new Date().toISOString() })).ok()).toBe(true);
    await expect.poll(async () => (await kiosk(request)).clockVerified, { timeout: 20_000 }).toBe(true);
  } finally {
    await panelPost(request, "/api/kiosks/0/system", { nextBootClockSynced: true });
  }
});

test("the kiosk joins Wi-Fi from its settings, refuses a wrong password, and loses the Worker without a network", async ({ request }) => {
  expect((await kioskPost(request, "/network/unlock", { pin: settingsPin })).ok()).toBe(true);
  const networks = await (await request.get(`${(await kiosk(request)).url}network/wifi`)).json();
  expect(networks.networks.map((network: { ssid: string }) => network.ssid)).toEqual(["Virtual Lab", "Virtual Guest"]);

  const wrong = await kioskPost(request, "/network/connect", { ssid: "Virtual Lab", password: "not-the-password" });
  expect(wrong.status()).toBe(400);
  expect((await wrong.json()).error).toMatch(/Secrets were required/);

  expect((await kioskPost(request, "/network/connect", { ssid: "Virtual Lab", password: "virtual-lab-1" })).ok()).toBe(true);
  await expect.poll(async () => (await kiosk(request)).network, { timeout: 10_000 }).toEqual({ connection: "wifi", ssid: "Virtual Lab" });

  await panelPost(request, "/api/kiosks/0/network", { network: { connection: "none", ssid: null } });
  try {
    expect((await kiosk(request)).linkOnline).toBe(false);
    // The kiosk notices on its next contact with the Worker, at most about a minute later.
    await expect.poll(async () => (await kiosk(request)).cloudOnline, { timeout: 120_000 }).toBe(false);
  } finally {
    await panelPost(request, "/api/kiosks/0/network", { network: { connection: "ethernet", ssid: null } });
  }
  await expect.poll(async () => (await kiosk(request)).cloudOnline, { timeout: 120_000 }).toBe(true);
});

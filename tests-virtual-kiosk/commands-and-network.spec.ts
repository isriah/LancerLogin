import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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
  // The Worker names the release to install from the virtual stack's own release feed
  // (scripts/virtual-kiosk/worker-entry.mjs), not from GitHub, and the kiosk then reports that release.
  expect(installed.requestedReleaseVersion).toBe("v2.0.1");
  expect((await kiosk(request)).release).toBe("2.0.1");
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
  expect(networks.networks.map((network: { ssid: string }) => network.ssid)).toEqual(["Virtual Lab", "Virtual Shop", "Virtual Guest", "Virtual Campus"]);

  const wrong = await kioskPost(request, "/network/connect", { ssid: "Virtual Lab", password: "not-the-password" });
  expect(wrong.status()).toBe(400);
  expect((await wrong.json()).error).toMatch(/Secrets were required/);
  // A WPA password of fewer than 8 characters can never be right, and is refused without trying.
  const short = await kioskPost(request, "/network/connect", { ssid: "Virtual Lab", password: "lab-1" });
  expect((await short.json()).error).toMatch(/at least 8 characters/);
  // A network that signs in with a username is listed as one and refused at once, with the reason.
  expect(networks.networks.find((network: { ssid: string }) => network.ssid === "Virtual Campus").enterprise).toBe(true);
  const campus = await kioskPost(request, "/network/connect", { ssid: "Virtual Campus", password: "any-password" });
  expect(campus.status()).toBe(400);
  expect((await campus.json()).error).toMatch(/signs in with a username/);
  expect((await kiosk(request)).network).toEqual({ connection: "ethernet", ssid: null });

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

/** Types text on the Wi-Fi screen's on-screen keyboard by tapping only its keys: Shift for a capital, the layer key for a symbol. */
async function tapOnScreenKeys(page: Page, text: string) {
  const keyboard = page.locator("#touch-keyboard");
  const key = (name: string) => keyboard.locator(`button[data-key=${JSON.stringify(name)}]`);
  for (const character of text) {
    const letter = /[a-z]/i.test(character);
    if (await key(character).count() === 0 && (!letter || await keyboard.getAttribute("data-layer") === "symbols")) await key("layer").click();
    // A capital needs one tap of Shift; a lowercase letter needs Shift off again.
    while (letter && await key(character).count() === 0) await key("shift").click();
    await key(character).click();
  }
}

test("a touchscreen-only kiosk types a Wi-Fi password with capitals, spaces and punctuation and joins with it", async ({ page, request }) => {
  // What scripts/virtual-kiosk/fakes.mjs has for Virtual Shop; the virtual nmcli joins only when it receives exactly this.
  const password = "Shop 7 \"Q\"\\$z~!";
  expect(password).toHaveLength(15);
  const { url, screenUrl } = await kiosk(request);
  await request.delete(`${url}network/session`);
  // The smallest display the kiosk supports.
  await page.setViewportSize({ width: 800, height: 480 });
  try {
    await page.goto(screenUrl);
    await expect(page.locator("#network-panel")).toBeAttached({ timeout: 20_000 });
    // An operator holds the network dot for three seconds, then enters the settings PIN on its keypad.
    const dot = (await page.locator("#network-status").boundingBox())!;
    await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await page.mouse.down(); await page.waitForTimeout(3_300); await page.mouse.up();
    await expect(page.locator("#network-unlock")).toBeVisible();
    for (const digit of settingsPin) await page.locator("#network-unlock-keypad").getByRole("button", { name: digit, exact: true }).click();
    await page.getByRole("button", { name: "Unlock for five minutes" }).click();
    await page.locator("#wifi-list button", { hasText: "Virtual Shop" }).click();

    // Everything needed to type and join is on screen at once, with touch-sized keys.
    const field = page.locator("#wifi-password"); const connect = page.getByRole("button", { name: "Connect", exact: true });
    const keys = page.locator("#touch-keyboard button");
    await expect(keys).toHaveCount(42);
    for (const item of [field, connect, page.locator("#wifi-back"), page.locator("#network-close"), ...await keys.all()]) await expect(item).toBeInViewport({ ratio: 1 });
    for (const key of await keys.all()) expect((await key.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // The same password without its capitals is refused, so capitals reach the network manager as typed.
    await tapOnScreenKeys(page, password.toLowerCase());
    await expect(field).toHaveValue(password.toLowerCase());
    await connect.click();
    await expect(page.locator("#network-message")).toHaveText(/Secrets were required/);
    await expect(field).toHaveValue("");
    expect((await kiosk(request)).network).toEqual({ connection: "ethernet", ssid: null });

    await tapOnScreenKeys(page, password);
    await expect(field).toHaveValue(password);
    // The password stays hidden until the operator asks to see it.
    await expect(field).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(field).toHaveAttribute("type", "text");
    // The password ends with a symbol, so the symbols layer is showing; it is on screen whole too.
    await expect(page.locator("#touch-keyboard")).toHaveAttribute("data-layer", "symbols");
    await expect(keys).toHaveCount(45);
    for (const key of await keys.all()) await expect(key).toBeInViewport({ ratio: 1 });
    await page.locator("#touch-keyboard button[data-key=layer]").click();
    // A USB keyboard types into the same field, and the on-screen Backspace removes what it typed.
    await page.keyboard.type("Zz");
    await expect(field).toHaveValue(`${password}Zz`);
    for (let count = 0; count < 2; count += 1) await page.getByRole("button", { name: "Backspace" }).click();
    await expect(field).toHaveValue(password);
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(field).toHaveAttribute("type", "password");

    await connect.click();
    await expect(page.locator("#network-message")).toHaveText("Connected. Network settings will close.");
    await expect.poll(async () => (await kiosk(request)).network, { timeout: 10_000 }).toEqual({ connection: "wifi", ssid: "Virtual Shop" });
    await expect(page.locator("#network-panel")).toBeHidden();
    await expect(field).toHaveValue("");
  } finally {
    await panelPost(request, "/api/kiosks/0/network", { network: { connection: "ethernet", ssid: null } });
  }
});

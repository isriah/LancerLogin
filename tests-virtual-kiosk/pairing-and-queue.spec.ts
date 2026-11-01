import { expect, test } from "@playwright/test";
import { adminApi, enterMemberId, kiosk, panelPost, useAuthenticationMethod } from "./virtual-kiosk";

// One shared virtual kiosk (scripts/virtual-kiosk.mjs), paired at start-up to a fresh local preview with the synthetic
// members Test Student A (1001) and Test Student B (1002) and the open meeting "Test meeting A".
test.describe.configure({ mode: "serial" });

test("the virtual kiosk pairs to the local preview and sends heartbeats", async ({ request }) => {
  const current = await kiosk(request);
  expect(current).toMatchObject({ name: "Virtual kiosk 1", running: true, paired: true, cloudOnline: true });
  const api = await adminApi(request);
  await expect.poll(async () => (await api.get("/admin/kiosks")).kiosks.find((item: { id: string }) => item.id === current.kioskId)?.lastSeenAt ?? null, { timeout: 30_000 }).not.toBeNull();
});

test("a member ID scan on the virtual kiosk records attendance", async ({ page, request }) => {
  await useAuthenticationMethod(request, "member_id");
  await enterMemberId(page, (await kiosk(request)).screenUrl, "1002");
  await expect(page.locator("#display-name")).toHaveText(/Test Student B/, { timeout: 20_000 });
  await expect(page.locator("#display-meeting")).toHaveText(/Test meeting A/);
  await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 20_000 }).toBe(0);
});

test("a scan made while the cloud is unreachable stays queued across a restart and a reboot, then syncs", async ({ page, request }) => {
  await panelPost(request, "/api/cloud", { online: false });
  try {
    await enterMemberId(page, (await kiosk(request)).screenUrl, "1001");
    // Offline, the kiosk welcomes the member without a name and keeps the scan until the cloud is back.
    await expect(page.locator("#display-detail")).toHaveText(/Saved for sync/, { timeout: 30_000 });
    await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 20_000 }).toBe(1);

    const before = (await kiosk(request)).starts;
    await panelPost(request, "/api/kiosks/0/restart");
    await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > before; }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 20_000 }).toBe(1);

    // A reboot keeps the queue too.
    const { bootId } = await kiosk(request);
    await panelPost(request, "/api/kiosks/0/reboot");
    await expect.poll(async () => { const current = await kiosk(request); return current.running && current.bootId !== bootId; }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 20_000 }).toBe(1);
  } finally {
    await panelPost(request, "/api/cloud", { online: true });
  }
  // Failed deliveries back off, so the first retry after the Worker returns can take a couple of minutes.
  await expect.poll(async () => (await kiosk(request)).pendingScans, { timeout: 170_000 }).toBe(0);
});

test("unpairing and pairing again gives the kiosk a new pairing", async ({ request }) => {
  const before = await kiosk(request);
  await panelPost(request, "/api/kiosks/0/unpair");
  // Unpairing restarts the service with no pairing, as on a Pi.
  await expect.poll(async () => { const current = await kiosk(request); return current.running && current.starts > before.starts && !current.paired; }, { timeout: 30_000 }).toBe(true);
  await panelPost(request, "/api/kiosks/0/pair");
  await expect.poll(async () => (await kiosk(request)).paired, { timeout: 30_000 }).toBe(true);
  const after = await kiosk(request);
  expect(after.kioskId).not.toBeNull();
  expect(after.kioskId).not.toBe(before.kioskId);
});

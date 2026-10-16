import { expect, test } from "@playwright/test";
import { createOperatorPresence } from "../apps/kiosk/src/operator-presence.mjs";

const base = process.env.LANCERLOGIN_KIOSK_BASE_URL ?? "http://127.0.0.1:8792";

test("an attendance tab cannot rearm while another tab displays locked maintenance", async ({ context }) => {
  const coordinator = createOperatorPresence();
  const replies: { mode: string; captureSuspended: boolean }[] = [];
  await context.route(base + "/operator-presence", async route => {
    try {
      const result = coordinator.update(route.request().postDataJSON());
      replies.push(result);
      await route.fulfill({ json: result });
    } catch {
      await route.fulfill({ status: 409, json: { error: "Page session expired. Retry attendance." } });
    }
  });
  const attendance = await context.newPage();
  await attendance.goto(base + "/");
  await expect.poll(() => replies.some(reply => reply.mode === "attendance" && !reply.captureSuspended)).toBe(true);
  const maintenance = await context.newPage();
  await maintenance.goto(base + "/maintenance");
  await expect(maintenance.locator("#unlock")).toBeVisible();
  await expect.poll(() => coordinator.status().captureSuspended).toBe(true);
  replies.length = 0;
  await attendance.reload();
  await expect.poll(() => replies.some(reply => reply.mode === "attendance" && reply.captureSuspended)).toBe(true);
  expect(coordinator.status().captureSuspended).toBe(true);
  await maintenance.locator("#locked-return").click();
  await expect(maintenance).toHaveURL(base + "/");
  await expect.poll(() => coordinator.status().captureSuspended).toBe(false);
});

test("review keeps attendance suspended and returns through the acknowledged operator transition", async ({ page }) => {
  const coordinator = createOperatorPresence();
  const actions: { action: string; mode: string }[] = [];
  await page.route(base + "/operator-presence", async route => {
    const input = route.request().postDataJSON(); actions.push(input);
    try { await route.fulfill({ json: coordinator.update(input) }); }
    catch { await route.fulfill({ status: 409, json: { error: "Page session expired." } }); }
  });
  await page.route(base + "/attendance/rejections", route => route.fulfill({ json: { rejections: [] } }));
  await page.goto(base + "/attendance-review");
  await expect(page.locator("#summary")).toContainText("0 scans need review");
  expect(coordinator.status().captureSuspended).toBe(true);
  await page.getByRole("link", { name: "Back to maintenance" }).click();
  await expect(page).toHaveURL(base + "/maintenance");
  expect(actions.some(action => action.action === "leave" && action.mode === "review")).toBe(true);
  expect(coordinator.status().captureSuspended).toBe(true);
});

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { discovered } from "./release-discovery";

const bundledVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

async function setup(page: Page) {
  let installed = "0.9.0"; let releaseCalls = 0;
  await page.route("**/admin/update-info", route => route.fulfill({ json: { releaseVersion: installed, workflowUrl: "https://github.example.test/actions/workflows/upgrade-web.yml" } }));
  await page.route("**/__lancerlogin-release", route => route.fulfill({ json: { releaseVersion: installed } }));
  await page.route("**/admin/releases/latest", async route => { releaseCalls++; await route.fulfill({ json: discovered({ tag_name: `v${bundledVersion}` }, await page.evaluate(() => Date.now())) }); });
  return { set installed(value: string) { installed = value; }, get releaseCalls() { return releaseCalls; } };
}
const popup = (page: Page) => page.getByRole("status", { name: "Update available", exact: true });

test("update notices clear after installation changes without another release lookup or reload", async ({ page }) => {
  const state = await setup(page); await page.clock.install(); await page.goto("/dashboard");
  await expect(popup(page)).toBeVisible();
  state.installed = bundledVersion; await page.clock.runFor(31_000);
  await expect(popup(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: `LancerLogin ${bundledVersion} is available. Open Updates.`, exact: true })).toHaveCount(0);
  expect(state.releaseCalls).toBe(1);
});

test("dismissal survives background polling and reload, and Updates does not repeat its own popup", async ({ page }) => {
  await setup(page); await page.clock.install(); await page.goto("/dashboard");
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole("button", { name: "Open Updates", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
  await expect(popup(page)).toHaveCount(0);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(popup(page)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss update notice" }).click();
  await page.clock.runFor(31_000); await expect(popup(page)).toHaveCount(0);
  await page.reload(); await expect(popup(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: `LancerLogin ${bundledVersion} is available. Open Updates.`, exact: true })).toBeVisible();
});

test("an old tab offers reload after Worker and Pages converge on a newer deployment", async ({ page }) => {
  const state = await setup(page); const newer = `${Number(bundledVersion.split(".")[0]) + 1}.0.0`; state.installed = newer;
  await page.goto("/dashboard");
  const reload = page.getByRole("status", { name: "Dashboard reload available", exact: true });
  await expect(reload).toContainText(`LancerLogin ${newer} is installed`);
  await expect(reload).toContainText("This tab is still running");
  await expect(reload.getByRole("button", { name: "Reload dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `LancerLogin ${newer} is installed. Open Updates to reload.`, exact: true })).toBeVisible();
});

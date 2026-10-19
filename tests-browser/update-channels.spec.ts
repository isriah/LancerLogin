import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
async function setup(page: Page, installed = "1.2.6", setting = { channel: "stable", revision: 0 }) {
  const writes: unknown[] = []; const prepares: string[] = [];
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Example team", timeZone: "UTC", primaryColor: dashboardConformanceReferences.brand.primary, secondaryColor: dashboardConformanceReferences.brand.secondary, appearance: "dark", logoBackdrop: "auto" } } }));
  await page.route("**/admin/update-channel", async (route) => {
    if (route.request().method() === "PUT") { const input = route.request().postDataJSON(); writes.push(input); setting.channel = input.channel; setting.revision++; }
    await route.fulfill({ json: setting });
  });
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: installed, workflowUrl: "https://github.example.test/actions/workflows/upgrade-web.yml" } }));
  await page.route("**/__lancerlogin-release", (route) => route.fulfill({ json: { releaseVersion: installed } }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ json: { kiosks: [] } }));
  await page.route("**/admin/releases/latest", (route) => route.fulfill({ json: { channel: setting.channel, fresh: true, checkedAt: Date.now(), attemptedAt: Date.now(), release: { tag_name: setting.channel === "beta" ? "v2.0.0-beta.1" : "v1.2.6", draft: false, prerelease: setting.channel === "beta", body: setting.channel === "beta" ? "Example beta notes" : "Example stable notes" } } }));
  await page.route("**/admin/web-updates/prepare", async (route) => { prepares.push(route.request().method()); await route.fulfill({ status: 503, json: { code: "controller_upgrade_required" } }); });
  return { setting, writes, prepares };
}
test("track selection requires consent, starts no update and never offers a downgrade on opt-out", async ({ page }) => {
  const state = await setup(page, "2.0.0-beta.1"); await page.goto("/settings/updates"); await page.getByText("Change update track", { exact: true }).click();
  const select = page.getByLabel("Installation update track"); const save = page.getByRole("button", { name: "Save update track" });
  await expect(select).toHaveValue("stable"); await expect(save).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back up and begin update" }).and(page.locator(":enabled"))).toHaveCount(0);
  await select.selectOption("beta"); await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: /I understand beta/ }).check(); await save.click();
  await expect(page.getByText("Update track saved. No update was started.")).toBeVisible();
  expect(state.writes).toEqual([{ channel: "beta", revision: 0, betaConfirmed: true }]); expect(state.prepares).toEqual([]);
  await expect(page.getByText("Example beta notes")).toBeVisible();
  await select.selectOption("stable"); await save.click();
  await expect(page.getByText("Example stable notes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back up and begin update" }).and(page.locator(":enabled"))).toHaveCount(0);
  const namespaces = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("lancerlogin-release-cache-v3:")));
  expect(namespaces.sort()).toEqual(["lancerlogin-release-cache-v3:beta", "lancerlogin-release-cache-v3:stable"]);
  expect(state.prepares).toEqual([]);
});
test("other tabs refresh server settings without accepting browser authority or losing an unsaved choice", async ({ page, context }) => {
  const first = await setup(page);
  const other = await context.newPage(); const second = await setup(other, "1.2.6", first.setting);
  await page.goto("/settings/updates"); await page.getByText("Change update track", { exact: true }).click(); await other.goto("/settings/updates"); await other.getByText("Change update track", { exact: true }).click();
  const choice = other.getByLabel("Installation update track"); const save = other.getByRole("button", { name: "Save update track" });
  await expect(choice).toHaveValue("stable");
  await page.evaluate(() => localStorage.setItem("lancerlogin-update-channel-notice", "beta"));
  await expect(choice).toHaveValue("stable"); expect(first.setting.channel).toBe("stable");
  await page.getByLabel("Installation update track").selectOption("beta"); await page.getByRole("checkbox", { name: /I understand beta/ }).check(); await page.getByRole("button", { name: "Save update track" }).click();
  await expect(choice).toHaveValue("beta"); await expect(save).toBeDisabled();
  await expect(other.getByText("Example beta notes")).toBeVisible();
  await choice.selectOption("stable");
  first.setting.revision++;
  await page.evaluate(() => localStorage.setItem("lancerlogin-update-channel-notice", crypto.randomUUID()));
  await expect(other.getByText("The installation update track changed. Review your selection before saving.")).toBeVisible();
  await expect(choice).toHaveValue("stable"); await save.click();
  expect(second.writes).toEqual([{ channel: "stable", revision: 2, betaConfirmed: false }]);
  expect([...first.prepares, ...second.prepares]).toEqual([]);
});
test("beta option reveals matching notes and preserves backup-first and controller bootstrap errors", async ({ page }) => {
  const state = await setup(page); await page.goto("/settings/updates"); await page.getByText("Change update track", { exact: true }).click();
  await page.getByLabel("Installation update track").selectOption("beta"); await page.getByRole("checkbox", { name: /I understand beta/ }).check(); await page.getByRole("button", { name: "Save update track" }).click();
  const prepare = page.getByRole("button", { name: "Back up and begin update" }); await expect(prepare).toBeEnabled();
  await expect(page.getByText("Example beta notes")).toBeVisible(); await prepare.click();
  await expect(page.getByText(/maintainer must install the reviewed update-channel controller/)).toBeVisible();
  expect(state.prepares).toEqual(["POST"]);
});
test("track controls use shared branded styles, square checkboxes and keyboard focus at desktop/mobile", async ({ page }) => {
  await setup(page);
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), theme);
    await page.goto("/settings/updates"); await page.getByText("Change update track", { exact: true }).click(); const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Update track", exact: true }) });
    await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
    const select = page.getByLabel("Installation update track"); await select.selectOption("beta");
    const checkbox = card.getByRole("checkbox"); await checkbox.check(); const save = card.getByRole("button", { name: "Save update track" }); await expect(save).toBeEnabled(); await checkbox.focus(); await page.keyboard.press("Tab"); await expect(save).toBeFocused();
    const styles = await save.evaluate((element) => {
      const actual = getComputedStyle(element); const probe = document.createElement("span"); probe.style.color = "var(--on-primary)"; probe.style.backgroundColor = "var(--primary)"; probe.style.borderRadius = "var(--radius-control)"; element.append(probe); const expected = getComputedStyle(probe);
      const result = { background: actual.backgroundColor === expected.backgroundColor, color: actual.color === expected.color, radius: actual.borderRadius === expected.borderRadius, focus: actual.outlineStyle, height: element.getBoundingClientRect().height }; probe.remove(); return result;
    });
    expect(styles).toMatchObject({ background: true, color: true, radius: true }); expect(styles.focus).not.toBe("none"); expect(styles.height).toBeGreaterThanOrEqual(44);
    const box = await checkbox.boundingBox(); expect(box!.width).toBeCloseTo(box!.height);
    expect(await select.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`track-${theme}-${width}.png`) });
  }
});

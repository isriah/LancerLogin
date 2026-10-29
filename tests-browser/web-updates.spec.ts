import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
import { discovered } from "./release-discovery";
import type { UpdateSetup, WebUpdateRequest } from "../apps/dashboard/src/web-update";

// Match the actual JavaScript bundle at every release, including future majors.
const bundledVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const targetTag = `v${Number(bundledVersion.split(".")[0]) + 1}.0.0`;
const releaseUrl = `https://github.com/isriah/LancerLogin/releases/tag/${targetTag}`;
const workflowUrl = "https://github.example.test/private/actions/workflows/upgrade-web.yml";
const pinned = (overrides: Partial<WebUpdateRequest> = {}): WebUpdateRequest => ({ requestId: "11111111-1111-4111-8111-111111111111", targetTag, targetCommit: "a".repeat(40), releaseNotes: "A pinned release.\n<img src=x onerror=alert('unsafe')>", releaseUrl, previousVersion: bundledVersion, state: "prepared", stage: "backup", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), updatedAt: new Date().toISOString(), backupExported: false, maintenance: false, errorCode: null, runUrl: null, reloadReady: false, ...overrides });
async function setup(page: Page, initial: WebUpdateRequest | null = null) {
  let request = initial; let starts = 0; let prepares = 0; let backups = 0; let backupFailure = false;
  let statusFailure = false; let prepareError = ""; let startError = ""; let readiness: UpdateSetup | undefined;
  let installed = bundledVersion; let served = bundledVersion;
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: installed, workflowUrl } }));
  await page.route("**/__lancerlogin-release", (route) => route.fulfill({ json: { releaseVersion: served } }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ json: { kiosks: [] } }));
  await page.route("**/admin/releases/latest", (route) => route.fulfill({ json: discovered({ tag_name: targetTag }) }));
  const result = () => ({ releaseVersion: bundledVersion, workflowUrl, request, ...(readiness ? { setup: readiness } : {}) });
  await page.route("**/admin/web-updates/status", (route) => statusFailure ? route.fulfill({ status: 503, json: { code: "provider_unavailable" } }) : route.fulfill({ json: result() }));
  await page.route("**/admin/web-updates/prepare", (route) => {
    expect(route.request().postDataJSON()).toEqual({}); prepares++;
    if (prepareError) return route.fulfill({ status: 409, json: { code: prepareError } });
    request = pinned(); return route.fulfill({ json: result() });
  });
  await page.route("**/admin/data/backup?scope=installation&updateRequestId=*", (route) => {
    backups++; expect(new URL(route.request().url()).searchParams.get("updateRequestId")).toBe(request?.requestId);
    if (backupFailure) return route.fulfill({ status: 503, body: "{}" });
    request = { ...request!, backupExported: true }; return route.fulfill({ body: "{}", headers: { "content-disposition": 'attachment; filename="synthetic-update-backup.json"', "access-control-expose-headers": "content-disposition" } });
  });
  await page.route("**/admin/web-updates/start", (route) => {
    expect(route.request().postDataJSON()).toEqual({ requestId: request?.requestId, backupSaved: true }); starts++;
    if (startError) return route.fulfill({ status: 409, json: { code: startError } });
    request = { ...request!, state: "dispatching", stage: "dispatch" }; return route.fulfill({ status: 202, json: result() });
  });
  return { set readiness(value: UpdateSetup | undefined) { readiness = value; }, get request() { return request; }, set request(value) { request = value; }, set installed(value: string) { installed = value; }, set served(value: string) { served = value; }, get starts() { return starts; }, get prepares() { return prepares; }, get backups() { return backups; }, set backupFailure(value: boolean) { backupFailure = value; }, set statusFailure(value: boolean) { statusFailure = value; }, set prepareError(value: string) { prepareError = value; }, set startError(value: string) { startError = value; } };
}
const webStatus = (page: Page) => page.locator(".web-update-status");
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh update status", exact: true });
const backupConfirmation = (page: Page) => page.getByRole("checkbox", { name: "I saved this update’s entire-installation backup file securely." });

test("pins release, retries associated backup, requires saved confirmation and tracks verified completion without dispatch reload", async ({ page }) => {
  const state = await setup(page); await page.goto("/settings/updates");
  await page.getByRole("button", { name: "Back up and begin update" }).click();
  await expect(page.getByRole("heading", { name: `Release notes for ${targetTag}` })).toBeVisible();
  await expect(page.locator(".web-update-notes")).toContainText("<img src=x");
  await expect(page.locator(".web-update-notes img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Start update to ${targetTag}` })).toHaveCount(0);
  state.backupFailure = true; await page.getByRole("button", { name: "Download entire-installation backup" }).click();
  await expect(webStatus(page)).toContainText("required pre-update backup could not be created");
  state.backupFailure = false;
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Download entire-installation backup" }).click();
  expect((await download).suggestedFilename()).toBe("synthetic-update-backup.json");
  const confirmation = page.getByRole("checkbox", { name: "I saved this update’s entire-installation backup file securely." });
  await expect(confirmation).toBeFocused();
  const start = page.getByRole("button", { name: `Start update to ${targetTag}` }); await expect(start).toBeDisabled();
  await page.reload(); await expect(confirmation).not.toBeChecked(); await expect(start).toBeDisabled();
  await confirmation.focus(); await page.keyboard.press("Space"); await start.focus(); await page.keyboard.press("Enter");
  await expect(webStatus(page)).toContainText("Dispatch alone does not confirm installation"); expect(state.starts).toBe(1);
  await expect(page.getByRole("button", { name: "Reload updated dashboard" })).toHaveCount(0);
  await page.reload(); await expect(webStatus(page)).toContainText("Submitting"); expect(state.starts).toBe(1); expect(state.prepares).toBe(1);
  for (const item of [{ state: "queued", text: "Update queued" }, { state: "awaiting_approval", text: "Waiting for production approval in GitHub" }, { state: "running", text: "Update running" }, { state: "verifying", text: "Verifying the API" }] as const) {
    state.request = { ...state.request!, state: item.state, stage: "health" }; await refresh(page).click(); await expect(webStatus(page)).toContainText(item.text);
    if (item.state === "awaiting_approval") await expect(page.getByRole("link", { name: "Review approval in GitHub" })).toHaveAttribute("href", workflowUrl);
    await expect(page.getByRole("button", { name: "Reload updated dashboard" })).toHaveCount(0);
  }
  state.request = { ...state.request!, state: "succeeded", reloadReady: true }; state.installed = targetTag.slice(1); state.served = targetTag.slice(1); await page.reload();
  await expect(webStatus(page)).toContainText("Reload this tab"); await expect(page.getByRole("button", { name: "Reload updated dashboard" })).toBeVisible();
  expect(state.starts).toBe(1); expect(state.backups).toBe(2);
});

for (const item of [
  { state: "dispatching", errorCode: "dispatch_ambiguous", text: "response was uncertain" },
  { state: "recovery_required", errorCode: "dispatch_unresolved", text: "No unique workflow run could be matched to this request" },
  { state: "recovery_required", errorCode: null, text: "Recovery required" },
] as const) test(`resumes ${item.state}/${item.errorCode} accurately across reload and tab`, async ({ page, context }) => {
  const state = await setup(page, pinned({ ...item, maintenance: item.state === "recovery_required", stage: "pages_deployment", runUrl: "https://github.example.test/private/actions/runs/1" }));
  await page.goto("/settings/updates"); await expect(webStatus(page)).toContainText(item.text);
  await page.getByText("Diagnostics and manual recovery", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Open diagnostic workflow / manual recovery" })).toHaveAttribute("href", "https://github.example.test/private/actions/runs/1");
  if (item.state === "recovery_required") { await expect(webStatus(page)).toContainText("writes are paused"); await expect(page.getByRole("button", { name: "Back up and begin update" })).toHaveCount(0); }
  await page.reload(); await expect(webStatus(page)).toContainText(item.text); expect(state.starts).toBe(0); expect(state.prepares).toBe(0);
  const second = await context.newPage(); await setup(second, state.request); await second.goto("/settings/updates"); await expect(webStatus(second)).toContainText(item.text); await second.close();
});

for (const code of ["not_configured", "credential_required", "credential_expired", "workflow_required", "not_private", "cooldown"]) test(`prepare safely reports ${code} and can retry after status confirmation`, async ({ page }) => {
  const state = await setup(page); state.prepareError = code; await page.goto("/settings/updates");
  await page.getByRole("button", { name: "Back up and begin update" }).click(); await expect(webStatus(page)).toHaveAttribute("data-tone", "error");
  expect(state.starts).toBe(0); expect(state.backups).toBe(0);
  state.prepareError = ""; await refresh(page).click(); await page.getByRole("button", { name: "Back up and begin update" }).click();
  await expect(webStatus(page)).toContainText("Update prepared");
});

test("unconfirmed status and start error cannot unlock blind dispatch or saved confirmation", async ({ page }) => {
  const state = await setup(page, pinned({ backupExported: true })); await page.goto("/settings/updates");
  await expect(backupConfirmation(page)).toBeVisible();
  state.statusFailure = true; await refresh(page).click(); await expect(webStatus(page)).toContainText("Progress is unconfirmed");
  await backupConfirmation(page).check(); await expect(page.getByRole("button", { name: `Start update to ${targetTag}` })).toBeDisabled();
  state.statusFailure = false; await refresh(page).click(); state.startError = "provider_unavailable";
  await page.getByRole("button", { name: `Start update to ${targetTag}` }).click(); await expect(webStatus(page)).toContainText("never be blindly redispatched");
  await expect(backupConfirmation(page)).not.toBeChecked(); expect(state.starts).toBe(1);
});

test("terminal success for the bundled version does not offer reload or reload on mount", async ({ page }) => {
  await setup(page, pinned({ state: "succeeded", targetTag: `v${bundledVersion}`, releaseUrl: `https://github.com/isriah/LancerLogin/releases/tag/v${bundledVersion}`, reloadReady: true }));
  await page.goto("/settings/updates"); await expect(webStatus(page)).toHaveText(`Dashboard ${bundledVersion} is installed.`);
  await expect(page.getByRole("button", { name: "Reload updated dashboard" })).toHaveCount(0);
  await refresh(page).click(); await expect(webStatus(page)).toHaveText(`Dashboard ${bundledVersion} is installed.`);
});

test("completed failures stay in history instead of overriding healthy installation status", async ({ page }) => {
  await setup(page, pinned({ state: "failed", targetTag: "v0.0.0", releaseNotes: "Old failed request notes", errorCode: "preflight_failed" }));
  await page.goto("/settings/updates");
  await expect(webStatus(page)).toHaveText(`Dashboard ${bundledVersion} is installed.`);
  await expect(page.locator(".web-update-notes")).not.toContainText("Old failed request notes");
  await page.getByText("Diagnostics and manual recovery", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Previous update to v0.0.0", exact: true })).toBeVisible();
  await expect(page.getByText("Old failed request notes", { exact: true })).toBeVisible();
});

test("manual deployment offers reload from served and running versions even when durable history targets an older release", async ({ page }) => {
  await setup(page, pinned({ state: "succeeded", targetTag: "v0.0.0", releaseNotes: "Old completed request notes", reloadReady: true }));
  const installed = targetTag.slice(1);
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: installed, workflowUrl } }));
  await page.route("**/__lancerlogin-release", (route) => route.fulfill({ json: { releaseVersion: installed } }));
  await page.goto("/settings/updates");
  await expect(webStatus(page)).toContainText(`Dashboard ${installed} is installed. Reload this tab`);
  await expect(page.getByRole("button", { name: "Reload updated dashboard", exact: true })).toBeVisible();
  await page.getByText("Diagnostics and manual recovery", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Previous update to v0.0.0", exact: true })).toBeVisible();
});

test("missing workflow and stalled backup cannot duplicate or start an update", async ({ page }) => {
  const state = await setup(page);
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: bundledVersion, workflowUrl: "" } }));
  await page.goto("/settings/updates");
  await expect(page.locator("#release-check-status")).toContainText("Last successful check");
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Back up and begin update" })).toBeDisabled();
  expect(state.prepares).toBe(0);
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: bundledVersion, workflowUrl } }));
  await page.reload(); await page.getByRole("button", { name: "Back up and begin update" }).click();
  let finish!: () => void; const held = new Promise<void>((resolve) => { finish = resolve; }); let backups = 0;
  await page.route("**/admin/data/backup?scope=installation&updateRequestId=*", async (route) => { backups++; await held; await route.fulfill({ status: 503, body: "{}" }); });
  const download = page.getByRole("button", { name: "Download entire-installation backup" }); await download.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Working…" })).toBeDisabled(); await page.keyboard.press("Enter"); expect(backups).toBe(1); expect(state.starts).toBe(0);
  finish(); await expect(webStatus(page)).toContainText("backup could not be created"); await expect(download).toBeEnabled();
});

test("prepared backup confirmation follows native keyboard, branded theme and responsive UI standards", async ({ page }, testInfo) => {
  await setup(page, pinned({ backupExported: true, releaseNotes: "Long pinned release notes.\n".repeat(100) }));
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Reference Arts Collective", primaryColor: dashboardConformanceReferences.brand.primary, secondaryColor: dashboardConformanceReferences.brand.secondary, appearance: "dark" } } }));
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 }); await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), theme);
    await page.goto("/settings/updates"); await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
    await expect(page.locator(".settings-notice")).toContainText("newer release on this update track");
    const dismiss = page.getByRole("button", { name: "Dismiss update notice" }); if (await dismiss.isVisible()) await dismiss.click();
    await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary); await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
    const checkbox = backupConfirmation(page); await expect(checkbox).toBeVisible(); await checkbox.focus(); await page.keyboard.press("Space"); await expect(checkbox).toBeChecked();
    const notesTop = await page.locator(".web-update-notes").evaluate((element) => element.getBoundingClientRect().top);
    for (const control of await page.locator(".web-update-backup, .web-update-card > button").all()) {
      expect(await control.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(notesTop);
      expect(await control.evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector(".web-update-notes")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    }
    expect(await checkbox.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(24);
    expect(await checkbox.evaluate((element) => getComputedStyle(element.closest("label")!).outlineStyle)).not.toBe("none");
    await page.getByText("Diagnostics and manual recovery", { exact: true }).click();
    for (const target of await page.locator(".web-update-card button,.web-update-card a,.web-update-confirmation,.web-update-diagnostics summary").all()) expect(await target.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await expect(page.locator("main h1")).toHaveCount(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`prepared-${width}-${theme}.png`), fullPage: true });
  }
});

for (const updateState of ["prepared", "expired", "succeeded"] as const) test(`current and available stay independent of a ${updateState} update target`, async ({ page }) => {
  await setup(page, pinned({ state: updateState, reloadReady: updateState === "succeeded" }));
  const newerTag = `v${Number(targetTag.slice(1).split(".")[0]) + 1}.0.0`;
  const newerUrl = `https://github.com/isriah/LancerLogin/releases/tag/${newerTag}`;
  await page.route("**/admin/releases/latest", route => route.fulfill({ json: discovered({ tag_name: newerTag, html_url: newerUrl }) }));
  await page.goto("/settings/updates");
  const card = page.locator(".web-update-card");
  await expect(card.locator(".version-grid")).toContainText("Installed");
  await expect(card.locator(".version-grid")).toContainText("Available");
  await expect(card.locator(".version-grid strong").first()).toHaveText(bundledVersion);
  await expect(card.locator(".version-grid strong").last()).toHaveText(newerTag.slice(1));
  await expect(card.getByRole("link", { name: "Read release notes" })).toHaveAttribute("href", newerUrl);
  if (updateState === "prepared") {
    await expect(webStatus(page)).toContainText(`Update to ${targetTag}.`);
    await expect(card.getByRole("heading", { name: `Release notes for ${targetTag}` })).toBeVisible();
  } else {
    await expect(webStatus(page)).toHaveText(`Dashboard ${bundledVersion} is installed.`);
    await expect(card.getByRole("heading", { name: `Release notes for ${newerTag}` })).toBeVisible();
  }
  await expect(card.getByText("Pinned release", { exact: true })).toHaveCount(0);
});


test("an older completed update stays in history while current release notes and status survive reload", async ({ page }, testInfo) => {
  await setup(page, pinned({ state: "succeeded", targetTag: "v0.0.0", releaseNotes: "Old completed request notes", reloadReady: true }));
  const channel = bundledVersion.includes("-beta.") ? "beta" : "stable";
  await page.route("**/admin/update-channel", route => route.fulfill({ json: { channel, revision: 1 } }));
  await page.route("**/admin/releases/latest", route => route.fulfill({ json: discovered({ tag_name: `v${bundledVersion}`, prerelease: channel === "beta", html_url: `https://github.com/isriah/LancerLogin/releases/tag/v${bundledVersion}`, body: "Current release notes. <img src=x onerror=alert('unsafe')>" }, Date.now(), channel) }));
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await page.addInitScript(theme => localStorage.setItem("lancerlogin-theme", theme), theme);
    await page.goto("/settings/updates");
    const card = page.locator(".web-update-card");
    await expect(webStatus(page)).toHaveText(`Dashboard ${bundledVersion} is installed.`);
    await expect(page.getByRole("button", { name: "Reload updated dashboard" })).toHaveCount(0);
    await expect(card.getByRole("heading", { name: `Release notes for v${bundledVersion}` })).toBeVisible();
    await expect(card.locator(".web-update-notes")).toContainText("Current release notes.");
    await expect(card.locator(".web-update-notes img")).toHaveCount(0);
    await expect(card.getByText("Old completed request notes", { exact: true })).toBeHidden();
    const details = card.locator(".web-update-diagnostics summary");
    await details.focus(); await page.keyboard.press("Enter");
    await expect(card.getByText("Previous update to v0.0.0", { exact: true })).toBeVisible();
    await expect(card.getByText("Old completed request notes", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await refresh(page).click(); await page.reload();
    await expect(webStatus(page)).toHaveText(`Dashboard ${bundledVersion} is installed.`);
    await expect(page.getByRole("status", { name: "Update available", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reload updated dashboard" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`completed-${width}-${theme}.png`), fullPage: true });
  }
});

const repository = "example/private-install";
const readiness = (overrides: Partial<UpdateSetup> = {}): UpdateSetup => ({ repository, dispatchCredential: { state: "ready", expiresAt: null }, selectionCredential: { state: "ready", expiresAt: null }, controller: "current", ...overrides });
const setupPanel = (page: Page) => page.getByRole("region", { name: "Setup status" });
const setupRow = (page: Page, name: string) => setupPanel(page).getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });

test("without the optional dashboard update credential, Updates shows how to update and set it up instead of an error", async ({ page }) => {
  const state = await setup(page); state.readiness = readiness({ dispatchCredential: { state: "missing", expiresAt: null }, selectionCredential: { state: "missing", expiresAt: null }, controller: "unknown" });
  await page.goto("/settings/updates");
  const card = page.locator(".web-update-card");
  const notice = card.getByRole("group", { name: "Dashboard updates are not set up yet" });
  await expect(notice).toContainText('run the "Install or upgrade LancerLogin" workflow with operation "upgrade"');
  await expect(notice).toContainText("Actions: Read and write, store it as the production environment secret LANCERLOGIN_WEB_UPDATE_TOKEN, then run the \"Refresh web update credential\" workflow.");
  await expect(notice.getByRole("link", { name: "Run Install or upgrade LancerLogin" })).toHaveAttribute("href", `https://github.com/${repository}/actions/workflows/provision-template.yml`);
  await expect(notice.getByRole("link", { name: "Create a GitHub fine-grained token" })).toHaveAttribute("href", "https://github.com/settings/personal-access-tokens/new");
  await expect(notice.getByRole("link", { name: "Open the deployment repository's environments" })).toHaveAttribute("href", `https://github.com/${repository}/settings/environments`);
  await expect(notice.getByRole("link", { name: "Run Refresh web update credential" })).toHaveAttribute("href", `https://github.com/${repository}/actions/workflows/refresh-web-update-credential.yml`);
  await expect(webStatus(page)).not.toHaveAttribute("data-tone", "error");
  await expect(page.getByRole("button", { name: "Back up and begin update" })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "Dashboard updates are not set up yet, so upgrade by running" })).toBeVisible();
  await expect(setupRow(page, "Dashboard update credential")).toContainText("Not set up");
  await expect(setupRow(page, "Update controller workflow")).toContainText("Not checked");
  await expect(setupRow(page, "Plugin management credential")).toContainText("LANCERLOGIN_MODULE_SELECTION_TOKEN");
  await expect(page.locator(".update-credential-banner")).toHaveCount(0);
  expect(state.prepares).toBe(0);
});

test("an expiring credential shows a dismissible warning, a card notice and readiness rows in both themes and widths", async ({ page }, testInfo) => {
  const state = await setup(page);
  const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
  state.readiness = readiness({ dispatchCredential: { state: "expiring", expiresAt }, selectionCredential: { state: "rejected", expiresAt: null }, controller: "upgrade_required" });
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 }); await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), theme);
    await page.goto("/settings/updates"); await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
    const banner = page.locator(".update-credential-banner");
    await expect(banner).toContainText("replace the production environment secret LANCERLOGIN_WEB_UPDATE_TOKEN");
    await expect(banner).toHaveAttribute("data-tone", "warning");
    await expect(page.locator(".web-update-credential-notice")).toContainText("The dashboard update credential expires");
    await expect(page.getByRole("button", { name: "Back up and begin update" })).toBeEnabled();
    await expect(setupRow(page, "Dashboard update credential").locator(".update-setup-badge")).toHaveText("Expiring soon");
    await expect(setupRow(page, "Dashboard update credential").locator(".update-setup-badge")).toHaveAttribute("data-tone", "warning");
    await expect(setupRow(page, "Update controller workflow")).toContainText("Beta updates need the current controller");
    await expect(setupRow(page, "Update controller workflow").getByRole("link", { name: "Open the update controller workflow" })).toHaveAttribute("href", `https://github.com/${repository}/actions/workflows/upgrade-web.yml`);
    await expect(setupRow(page, "Plugin management credential").locator(".update-setup-badge")).toHaveAttribute("data-tone", "error");
    const dismiss = banner.getByRole("button", { name: "Dismiss credential expiry warning" });
    const styles = await dismiss.evaluate((element) => { const style = getComputedStyle(element); const probe = document.createElement("span"); probe.style.borderRadius = "var(--radius-control)"; element.closest(".app")!.append(probe); const expectedRadius = getComputedStyle(probe).borderTopLeftRadius; probe.remove(); return { height: element.getBoundingClientRect().height, radius: style.borderTopLeftRadius, expectedRadius, background: style.backgroundColor }; });
    expect(styles.height).toBeGreaterThanOrEqual(44); expect(styles.radius).toBe(styles.expectedRadius); expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
    for (const link of await page.locator(".update-fix-links a").all()) expect(await link.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await dismiss.focus(); expect(await dismiss.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    await expect(page.locator("main h1")).toHaveCount(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`setup-${width}-${theme}.png`), fullPage: true });
  }
  const banner = page.locator(".update-credential-banner");
  await banner.getByRole("button", { name: "Dismiss credential expiry warning" }).focus(); await page.keyboard.press("Enter");
  await expect(banner).toHaveCount(0);
  await page.reload(); await expect(page.locator(".web-update-credential-notice")).toBeVisible(); await expect(banner).toHaveCount(0);
  // A renewed credential with a new expiry warns again.
  state.readiness = readiness({ dispatchCredential: { state: "expiring", expiresAt: new Date(Date.now() + 9 * 86_400_000).toISOString() } });
  await page.reload(); await expect(banner).toBeVisible();
});

test("a rejected credential names the secret and workflow to fix, with links", async ({ page }) => {
  const state = await setup(page); state.readiness = readiness(); state.prepareError = "dispatch_credential_rejected";
  await page.goto("/settings/updates");
  await expect(setupRow(page, "Dashboard update credential")).toContainText("No expiry.");
  await page.getByRole("button", { name: "Back up and begin update" }).click();
  await expect(webStatus(page)).toContainText("GitHub rejected the dashboard update credential (LANCERLOGIN_WEB_UPDATE_TOKEN)");
  const fixes = page.locator(".web-update-card").getByRole("list", { name: "Fix this update problem" });
  await expect(fixes.getByRole("link", { name: "Run Refresh web update credential" })).toHaveAttribute("href", `https://github.com/${repository}/actions/workflows/refresh-web-update-credential.yml`);
  await page.getByRole("button", { name: "Refresh update status", exact: true }).click();
  await expect(fixes).toHaveCount(0);
});

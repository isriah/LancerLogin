import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
const jobId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const initial = () => ({ configured: true, recoveryUrl: 'https://recovery.example.invalid/recovery', installedVersion: "1.0.0", schema: 49, job: null as any, admission: null as any, recoveryAvailable: false, availability: { status: "available", version: "2.0.0", releaseId: 200, checked: 30, total: 30, checkedAt: Date.now() } });
const job = (requestId = operationId) => ({ id: jobId, requestId, mode: "update", status: "running", step: "stageArtifact", completedSteps: 0, totalSteps: 7, operationId: null as string | null, failure: null as string | null, retryPreparationOperationId: null });
async function noKiosk(page: Page) { await page.route("**/admin/kiosks", route => route.fulfill({ json: { kiosks: [] } })); }

test('start response retains pinned recovery navigation after maintenance closes app authentication',async({page})=>{
  await noKiosk(page);const state=initial();delete (state as any).recoveryUrl;let closed=false;
  await page.route('**/admin/updater/**',async route=>{if(route.request().url().endsWith('/start')){state.recoveryUrl='https://recovery.example.invalid/recovery';state.job=job(route.request().postDataJSON().requestId);closed=true;return route.fulfill({json:state});}return route.fulfill(closed?{status:503,json:{error:'Application is paused for maintenance'}}:{json:state});});
  await page.goto('/settings/updates');await page.getByRole('button',{name:'Install verified release'}).click();const link=page.getByRole('link',{name:'Open independent updater'});await expect(link).toHaveAttribute('href','https://recovery.example.invalid/recovery');await page.getByRole('button',{name:'Refresh status'}).click();await expect(link).toBeVisible();await page.reload();await expect(link).toHaveAttribute('href','https://recovery.example.invalid/recovery');
});

test("shared updater polling pauses hidden pages, separates kiosks and backs off until explicit refresh", async ({ page }) => {
  await page.clock.install(); let statusReads = 0, kioskReads = 0, fail = false; const state = initial();
  await page.addInitScript(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window as any).testHidden ? 'hidden' : 'visible' }); });
  await page.route('**/admin/kiosks', route => { kioskReads++; return route.fulfill({ json: { kiosks: [] } }); });
  await page.route('**/admin/updater/**', route => { statusReads++; return route.fulfill(fail ? { status: 503, json: { error: 'Synthetic updater unavailable' } } : { json: state }); });
  await page.goto('/settings/updates'); await expect(page.getByRole('button', { name: 'Install verified release' })).toBeEnabled();
  // Header and page may join one flight or finish two sequential mount reads.
  // Measure timer cadence from that settled baseline, not React mount timing.
  await page.clock.runFor(1); const initialReads=statusReads; expect(initialReads).toBeGreaterThanOrEqual(1); expect(initialReads).toBeLessThanOrEqual(2); expect(kioskReads).toBe(1);
  await page.clock.runFor(59_000); expect(statusReads).toBe(initialReads); expect(kioskReads).toBe(1);
  await page.evaluate(() => { (window as any).testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(600_000); expect(statusReads).toBe(initialReads); expect(kioskReads).toBe(1);
  await page.evaluate(() => { (window as any).testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(1); await expect.poll(() => statusReads).toBe(initialReads+1); await expect.poll(() => kioskReads).toBe(2);
  fail = true; await page.getByRole('button', { name: 'Refresh status' }).click(); await expect.poll(() => statusReads).toBe(initialReads+2);
  await expect(page.getByRole('status').filter({ hasText: 'Synthetic updater unavailable' })).toBeVisible();
  await page.clock.runFor(29_000); expect(statusReads).toBe(initialReads+2);
  fail = false; state.job = job(); await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('button', { name: 'Continue update' })).toBeVisible(); const physical = kioskReads;
  await page.clock.runFor(5001); await expect.poll(() => statusReads).toBe(initialReads+4); expect(kioskReads).toBe(physical);
});

test("lost admission acknowledgment retains its UUID, then follows the durable job and completed refresh", async ({ page }) => {
  await noKiosk(page); let state = initial(); const submissions: any[] = [];
  await page.route("**/admin/updater/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/start")) {
      const body = route.request().postDataJSON(); submissions.push(body);
      if (submissions.length === 1) { await route.abort(); return; }
      state.job = job(body.requestId); state.admission = { requestId: body.requestId, state: "accepted", reason: null };
    }
    if (path.endsWith("/advance")) { state.job.operationId = operationId; state.job.status = "reconciling"; }
    await route.fulfill({ json: state });
  });
  await page.goto("/settings/updates");
  await page.getByRole("button", { name: "Install verified release" }).focus();
  await expect(page.getByRole("button", { name: "Install verified release" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Retry same update request" })).toBeEnabled();
  await page.reload(); await page.getByRole("button", { name: "Retry same update request" }).click();
  expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
  await page.getByRole("button", { name: "Continue update" }).click();
  await expect(page.getByRole("button", { name: "Reconcile current operation" })).toBeVisible();
  state.job.status = "succeeded"; state.job.step = "complete"; state.job.completedSteps = 7; state.installedVersion = "2.0.0"; state.availability.status = "no-compatible-release";
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Update installed successfully" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("lancerlogin-updater-admission-v1"))).toBeNull();
  await expect(page.getByRole("button", { name: "Install verified release" })).toBeDisabled();
});

test("authoritative rejection clears the saved admission and permits a new selection", async ({ page }) => {
  await noKiosk(page); const state = initial(), ids: string[] = [];
  await page.route("**/admin/updater/**", async route => {
    if (route.request().url().endsWith("/start")) { const body = route.request().postDataJSON(); ids.push(body.requestId); state.admission = { requestId: body.requestId, state: "rejected", reason: "maintenance-required" }; }
    await route.fulfill({ json: state });
  });
  await page.goto("/settings/updates"); await page.getByRole("button", { name: "Install verified release" }).click();
  await expect(page.getByRole("status").filter({ hasText: "saved update request was rejected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install verified release" })).toBeEnabled();
  await page.getByRole("button", { name: "Install verified release" }).click(); expect(ids[1]).not.toEqual(ids[0]);
});

test("unconfigured service exposes no install action and restoration retains identity after lost acknowledgment", async ({ page }) => {
  await noKiosk(page); let state = initial(); state.configured = false;
  const requests: any[] = [];
  await page.route("**/admin/updater/**", async route => { if (route.request().url().endsWith("/recovery")) { requests.push(route.request().postDataJSON()); await route.abort(); return; } await route.fulfill({ json: state }); });
  await page.goto("/settings/updates"); await expect(page.getByText("The independent updater is not configured for this installation.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Install verified release" })).toHaveCount(0);
  state.configured = true; state.job = { ...job(), status: "failed", failure: "deployPages-failed" }; state.recoveryAvailable = true;
  await page.reload(); await expect(page.getByRole("button", { name: "Restore verified backup" })).toBeDisabled();
  await page.getByLabel("Type RESTORE APPLICATION DATABASE to enable restoration").fill("RESTORE APPLICATION DATABASE");
  await page.getByRole("button", { name: "Restore verified backup" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Refresh status before repeating" })).toBeVisible();
  await page.reload(); await page.getByLabel("Type RESTORE APPLICATION DATABASE to enable restoration").fill("RESTORE APPLICATION DATABASE");
  await page.getByRole("button", { name: "Restore verified backup" }).click();
  await expect.poll(() => requests.length).toBe(2); expect(requests[1]).toEqual(requests[0]);
});

test("updater progress and confirmed physical kiosk remain usable in branded desktop/mobile themes", async ({ page }, testInfo) => {
  const state = initial(); state.job = { ...job(), status: "failed", failure: "deployPages-failed" }; state.recoveryAvailable = true;
  await page.route("**/admin/updater/**", route => route.fulfill({ json: state }));
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Reference Arts Collective", subtitle: "Shared operations", primaryColor: dashboardConformanceReferences.brand.primary, secondaryColor: dashboardConformanceReferences.brand.secondary, appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/admin/kiosks", route => route.fulfill({ json: { kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1, lastSeenAt: new Date().toISOString(), releaseVersion: "0.22.0" }] } }));
  await page.route("**/admin/kiosks/kiosk-1/commands", route => route.fulfill({ json: { commands: [{ id: "update-1", type: "install_latest", createdAt: "2026-09-05T12:00:00.000Z", completedAt: "2026-09-05T12:01:00.000Z", success: 1, requestedReleaseVersion: "v0.22.0", releaseVersionBefore: "0.21.0", resolutionStatus: "succeeded", resolvedReleaseVersion: "0.22.0", resolvedAt: "2026-09-05T12:02:00.000Z" }] } }));
  await page.route("https://api.github.com/repos/isriah/LancerLogin/releases/latest", route => route.fulfill({ json: { tag_name: "v0.23.0", html_url: "https://github.example.test/releases/v0.23.0" } }));
  for (const item of [{ width: 1280, height: 900, theme: "light" }, { width: 1280, height: 900, theme: "dark" }, { width: 390, height: 844, theme: "light" }, { width: 390, height: 844, theme: "dark" }]) {
    await page.setViewportSize(item); await page.addInitScript(({ theme }) => localStorage.setItem("lancerlogin-theme", theme), item);
    await page.goto("/settings/updates"); await expect(page.locator(".app")).toHaveAttribute("data-theme", item.theme);
    await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
    await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
    await expect(page.getByRole("status").filter({ hasText: "Installed successfully. This kiosk now reports 0.22.0." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const recoveryLink = page.getByRole('link', {name:'Open independent updater'}); await expect(recoveryLink).toHaveAttribute('href','https://recovery.example.invalid/recovery'); await expect(recoveryLink).toHaveAttribute('rel','noopener noreferrer'); await recoveryLink.focus(); await expect(recoveryLink).toBeFocused(); expect((await recoveryLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const button of await page.getByRole("button", { name: /Refresh status|Recover previous code|Restore verified backup/ }).all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`updater-${item.width}-${item.theme}.png`), fullPage: true });
  }
});

 test('terminal update retains continuation until maintenance reopens',async({page})=>{await noKiosk(page);const state={...initial(),job:{...job(),status:'succeeded',step:'complete'},maintenance:{state:'closed'}};let advances=0;await page.route('**/admin/updater/**',route=>{if(route.request().url().endsWith('/advance')){advances++;state.maintenance.state='open';}return route.fulfill({json:state});});await page.goto('/settings/updates');await expect(page.getByText('Finishing verification before reopening the application.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Install verified release'})).toHaveCount(0);await page.getByRole('button',{name:'Finish reopening'}).click();expect(advances).toBe(1);await expect(page.getByText('Update installed successfully.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Finish reopening'})).toHaveCount(0);});

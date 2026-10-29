import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { attendanceSnapshot } from "./module-fixtures";
import type { ModuleAccessUse } from "../apps/dashboard/src/module-access-grants";
import type { PluginState } from "../apps/dashboard/src/plugin-management";
import type { WebUpdateRequest } from "../apps/dashboard/src/web-update";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const workflowUrl = "https://github.example.test/private/actions/workflows/upgrade-web.yml";
const source = "https://github.com/example/lancerlogin-carpool.git";
const commit = "c".repeat(40); const next = "d".repeat(40); const selectionSha = "1".repeat(40);
const stableRelease = { tag: "v1.0.0", kind: "stable", commit: "a".repeat(40), url: "https://github.com/example/lancerlogin-carpool/releases/tag/v1.0.0" };
const nightlyRelease = { tag: "v1.1.0-nightly.20261025", kind: "nightly", commit: "b".repeat(40), url: null };
const official = { id: "hour-tracking", source: "https://github.com/isriah/lancerlogin-outreach.git", commit: "e".repeat(40), official: true, selected: false, phase: "enabled" as const };

function pluginState(overrides: Partial<PluginState> = {}): PluginState {
  return {
    releaseVersion: version, repository: "example/private-install",
    credential: { state: "ready", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    selection: { sha: selectionSha, present: true, officialModules: true, modules: [] },
    installed: [official], pending: [],
    allowlist: { state: "none" }, protection: { state: "not_configured" }, activeUpdate: null,
    reauthentication: { freshUntil: null, password: true, google: false }, error: null,
    ...overrides,
  };
}
const review = { action: "add", id: "carpool", source, commit, previousCommit: null, official: false, selectionSha,
  metadata: { state: "compatible", version: "1.0.0", contract: 1, core: ">=2.0.0-beta.11 <3.0.0", tablePrefix: "carpool_", migrations: ["0001_carpool.sql"] },
  declaredNote: "Routes, jobs and Discord commands are declared in plugin code. LancerLogin does not run plugin code to show them here.",
  trustStatement: "A plugin runs inside this installation's Worker and dashboard with the same access as LancerLogin.", allowlist: "none" };

async function setup(page: Page, initial = pluginState()) {
  let state = initial; let update: WebUpdateRequest | null = null;
  const posts: Array<{ path: string; body: unknown }> = [];
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot({ enabled: true, selectionCompleted: true, setupReady: true }) }));
  await page.route("**/admin/update-info", (route) => route.fulfill({ json: { releaseVersion: version, workflowUrl } }));
  await page.route("**/__lancerlogin-release", (route) => route.fulfill({ json: { releaseVersion: version } }));
  await page.route("**/admin/plugins", (route) => route.fulfill({ json: state }));
  await page.route("**/admin/plugins/review", (route) => { posts.push({ path: "review", body: route.request().postDataJSON() }); return route.fulfill({ json: review }); });
  await page.route("**/admin/plugins/release", (route) => {
    const body = route.request().postDataJSON() as { track: string }; posts.push({ path: "release", body });
    return route.fulfill({ json: { track: body.track, release: body.track === "nightly" ? nightlyRelease : stableRelease } });
  });
  await page.route("**/admin/plugins/reauthenticate", (route) => {
    const body = route.request().postDataJSON() as { password: string }; posts.push({ path: "reauthenticate", body: { password: body.password ? "[provided]" : "" } });
    if (body.password !== "correct") return route.fulfill({ status: 401, json: { error: "The password is incorrect.", code: "reauthentication_failed" } });
    return route.fulfill({ json: { ok: true, freshUntil: Date.now() + 600_000 } });
  });
  await page.route("**/admin/plugins/change", (route) => {
    posts.push({ path: "change", body: route.request().postDataJSON() });
    state = { ...state, selection: { ...state.selection!, sha: "2".repeat(40), modules: [{ id: "carpool", source, commit, phase: null }] }, pending: [{ kind: "add", id: "carpool", source, commit }] };
    return route.fulfill({ status: 201, json: { committed: { action: "add", id: "carpool", commit } } });
  });
  const result = () => ({ releaseVersion: version, workflowUrl, request: update, activeRequest: update && !["succeeded", "failed", "expired"].includes(update.state) ? update : null, latestCompletedRequest: null });
  await page.route("**/admin/web-updates/status", (route) => route.fulfill({ json: result() }));
  await page.route("**/admin/web-updates/prepare", (route) => {
    posts.push({ path: "prepare", body: route.request().postDataJSON() });
    update = { requestId: "33333333-3333-4333-8333-333333333333", mode: "modules", targetTag: `v${version}`, targetCommit: "b".repeat(40), releaseNotes: "Apply plugin changes.", releaseUrl: "", previousVersion: version, state: "prepared", stage: "prepared", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1_800_000).toISOString(), updatedAt: new Date().toISOString(), backupExported: false, maintenance: false, errorCode: null, runUrl: null, reloadReady: false };
    return route.fulfill({ json: result() });
  });
  await page.route("**/admin/data/backup?scope=installation&updateRequestId=*", (route) => { update = { ...update!, backupExported: true }; return route.fulfill({ body: "{}", headers: { "content-disposition": 'attachment; filename="plugin-backup.json"', "access-control-expose-headers": "content-disposition" } }); });
  await page.route("**/admin/web-updates/start", (route) => {
    posts.push({ path: "start", body: route.request().postDataJSON() });
    update = { ...update!, state: "awaiting_approval", stage: "dispatch" }; state = { ...state, activeUpdate: { requestId: update.requestId, mode: "modules", state: "awaiting_approval" } };
    return route.fulfill({ status: 202, json: result() });
  });
  return { posts, set state(value: PluginState) { state = value; } };
}

test("Admin adds a plugin with review, trust confirmation and fresh re-authentication, then applies it through backup and start", async ({ page }) => {
  const mock = await setup(page);
  await page.goto("/settings/modules");
  const plugins = page.locator(".plugin-management");
  await expect(plugins.getByRole("heading", { name: "Plugins", exact: true })).toBeVisible();
  await expect(plugins.getByText("Production approval is not configured. We recommend required reviewers")).toBeVisible();
  const officialRow = plugins.locator(".plugin-row").filter({ hasText: "hour-tracking" });
  await expect(officialRow).toContainText("Included with LancerLogin");
  // An unpinned official plugin follows LancerLogin's pin; it has no selection entry, so no track is claimed.
  await expect(officialRow).toContainText("Pinned by LancerLogin");
  await expect(officialRow).not.toContainText("Stable track");
  await expect(officialRow).not.toHaveAttribute("data-track", /.*/);
  await expect(plugins.getByText("No pending changes.")).toBeVisible();
  // Nothing is pending, so the heading must not claim undeployed work.
  await expect(plugins.locator(".plugin-pending-badge")).toHaveCount(0);
  await plugins.getByRole("button", { name: "Add plugin" }).click();
  const dialog = page.getByRole("dialog", { name: "Add plugin" });
  await expect(dialog.getByLabel("Module ID")).toBeFocused();
  await dialog.getByLabel("Module ID").fill("carpool");
  await dialog.getByLabel("Git repository URL").fill(source);
  await dialog.getByLabel("Commit SHA").fill(commit);
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Confirm carpool" })).toBeVisible();
  await expect(dialog).toContainText(commit);
  await expect(dialog).toContainText("Compatible with this installation");
  await expect(dialog).toContainText("Tables named carpool_*");
  await expect(dialog).toContainText("does not run plugin code");
  await expect(dialog).toContainText("same access as LancerLogin");
  const commitButton = dialog.getByRole("button", { name: "Commit change" });
  await expect(commitButton).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "I trust this source and reviewed this exact commit." }).check();
  await expect(commitButton).toBeDisabled();
  await dialog.getByLabel("Your password").fill("wrong");
  await dialog.getByRole("button", { name: "Confirm identity" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The password is incorrect.");
  await dialog.getByLabel("Your password").fill("correct");
  await dialog.getByRole("button", { name: "Confirm identity" }).click();
  await expect(dialog.getByText(/Identity confirmed until/)).toBeVisible();
  await commitButton.click();
  await expect(dialog).toHaveCount(0);
  expect(mock.posts.find((post) => post.path === "change")?.body).toEqual({ action: "add", id: "carpool", source, commit, track: "stable", selectionSha, trustConfirmed: true });
  await expect(plugins.getByRole("status").filter({ hasText: "Added carpool in the private deployment repository" })).toBeVisible();
  const pending = plugins.locator(".plugin-pending");
  await expect(pending.getByRole("heading", { name: /Pending changes/ })).toContainText("Not deployed");
  await expect(pending.locator(".plugin-pending-badge")).toHaveCount(1);
  await expect(pending).toContainText(`Add carpool at ${commit.slice(0, 12)}`);
  await expect(plugins.locator(".plugin-list").first()).not.toContainText("carpool");
  await plugins.getByRole("button", { name: "Back up and apply plugin changes" }).click();
  expect(mock.posts.find((post) => post.path === "prepare")?.body).toEqual({ mode: "modules" });
  const download = page.waitForEvent("download"); await plugins.getByRole("button", { name: "Download entire-installation backup" }).click(); await download;
  const confirmation = plugins.getByRole("checkbox", { name: /I saved this update’s entire-installation backup/ });
  await expect(confirmation).toBeFocused(); await page.keyboard.press("Space");
  await plugins.getByRole("button", { name: "Apply plugin changes", exact: true }).click();
  expect(mock.posts.find((post) => post.path === "start")?.body).toEqual({ requestId: "33333333-3333-4333-8333-333333333333", backupSaved: true });
  await expect(plugins.locator(".web-update-status")).toContainText(`Plugin changes for v${version}. Waiting for production approval`);
  await expect(plugins.getByRole("button", { name: "Add plugin" })).toBeDisabled();
});

test("removal is blocked while a module is enabled, incompatible plugins cannot be committed and a missing credential disables changes", async ({ page }) => {
  const mock = await setup(page, pluginState({ installed: [official, { id: "carpool", source, commit, official: false, selected: true, phase: "enabled" }], selection: { sha: selectionSha, present: true, officialModules: true, modules: [{ id: "carpool", source, commit, phase: "enabled" }] }, protection: { state: "configured", reviewers: 2 } }));
  await page.route("**/admin/plugins/review", (route) => route.fulfill({ json: { ...review, action: "upgrade", commit: next, previousCommit: commit, metadata: { state: "incompatible", reason: "The plugin supports LancerLogin >=3.0.0." } } }));
  await page.goto("/settings/modules");
  const plugins = page.locator(".plugin-management");
  await expect(plugins.getByText("Production approval is required (2 reviewers)")).toBeVisible();
  await expect(plugins.getByRole("button", { name: "Remove carpool" })).toBeDisabled();
  await expect(plugins).toContainText("Disable this module above before removing its plugin.");
  await plugins.getByRole("button", { name: "Upgrade carpool" }).click();
  const dialog = page.getByRole("dialog", { name: "Upgrade plugin" });
  await expect(dialog.getByLabel("Commit SHA")).toBeFocused();
  await dialog.getByLabel("Commit SHA").fill(next);
  await dialog.getByRole("button", { name: "Review change" }).click();
  await expect(dialog).toContainText("Incompatible with this installation");
  await dialog.getByRole("checkbox", { name: /I trust this source/ }).check();
  await expect(dialog.getByRole("button", { name: "Commit change" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(plugins.getByRole("button", { name: "Upgrade carpool" })).toBeFocused();
  mock.state = pluginState({ credential: { state: "missing", expiresAt: null }, selection: null, installed: [official, { id: "carpool", source, commit, official: false, selected: true, phase: "enabled" }], protection: { state: "unknown" } });
  await page.reload();
  await expect(plugins.getByText("Plugin management from the dashboard is not set up yet.")).toBeVisible();
  // Only the Actions-scoped update token is configured: the optional selection token is explained, not reported as broken.
  await expect(plugins.getByText("Plugin management from the dashboard is not set up yet.")).toHaveAttribute("data-tone", "neutral");
  const pending = plugins.locator(".plugin-pending");
  await expect(pending).toContainText("Reading and changing the plugin selection from the dashboard needs the optional module selection token, LANCERLOGIN_MODULE_SELECTION_TOKEN.");
  await expect(pending).toContainText("Without it, installed plugins keep working; edit lancerlogin.modules.json in the private deployment repository instead.");
  await expect(pending).toContainText("\"Plugin selection credential\" in docs/MODULE-PLUGINS.md");
  await expect(pending).not.toContainText("unavailable until the selection can be read");
  // The selection cannot be read without the token, so nothing is reported as pending or undeployed.
  await expect(pending.getByRole("heading", { name: "Pending changes" })).toBeVisible();
  await expect(pending).not.toContainText("Not deployed");
  await expect(pending.locator(".plugin-pending-badge")).toHaveCount(0);
  // Without the selection no plugin track was read, so no row claims one.
  const unreadRows = plugins.locator(".plugin-row");
  await expect(unreadRows).toHaveCount(2);
  for (const unread of await unreadRows.all()) {
    await expect(unread).not.toContainText("Stable track");
    await expect(unread).not.toContainText("Nightly track");
    await expect(unread).not.toContainText("Pinned by LancerLogin");
    await expect(unread).not.toHaveAttribute("data-track", /.*/);
  }
  await expect(plugins.getByText(/could not be checked \(unknown\)/)).toBeVisible();
  await expect(plugins.getByRole("button", { name: "Add plugin" })).toBeDisabled();
  expect(mock.posts.filter((post) => post.path === "change")).toEqual([]);
});

test("Admin moves a plugin to the testing-only Nightly track, and Upgrade offers the newest release on that track", async ({ page }) => {
  const carpool = { id: "carpool", source, commit, official: false, selected: true, phase: "enabled" as const };
  const mock = await setup(page, pluginState({ installed: [official, carpool], selection: { sha: selectionSha, present: true, officialModules: true, modules: [{ id: "carpool", source, commit, phase: "enabled" }] } }));
  await page.route("**/admin/plugins/review", (route) => {
    const body = route.request().postDataJSON() as { commit: string; track: string }; mock.posts.push({ path: "review", body });
    return route.fulfill({ json: { ...review, action: "upgrade", commit: body.commit, previousCommit: commit, track: body.track, previousTrack: "stable" } });
  });
  await page.route("**/admin/plugins/change", (route) => {
    mock.posts.push({ path: "change", body: route.request().postDataJSON() });
    mock.state = pluginState({ installed: [official, carpool], selection: { sha: "2".repeat(40), present: true, officialModules: true, modules: [{ id: "carpool", source, commit: nightlyRelease.commit, track: "nightly", phase: "enabled" }] }, pending: [{ kind: "upgrade", id: "carpool", source, commit: nightlyRelease.commit, installedCommit: commit }] });
    return route.fulfill({ status: 201, json: { committed: { action: "upgrade", id: "carpool", commit: nightlyRelease.commit, track: "nightly" } } });
  });
  await page.goto("/settings/modules");
  const plugins = page.locator(".plugin-management");
  const row = plugins.locator(".plugin-row").filter({ hasText: "carpool" }).first();
  await expect(row).toContainText("Stable track");
  await expect(row).toHaveAttribute("data-track", "stable");
  await expect(row.locator(".plugin-track-badge")).toHaveCount(0);
  await row.getByRole("button", { name: "Upgrade carpool" }).click();
  const dialog = page.getByRole("dialog", { name: "Upgrade plugin" });
  const track = dialog.getByLabel("Release track");
  await expect(track).toHaveValue("stable");
  await expect(dialog.getByRole("status").filter({ hasText: "Newest Stable release: v1.0.0" })).toBeVisible();
  await expect(dialog.getByLabel("Commit SHA")).toHaveValue(stableRelease.commit);
  await expect(dialog.getByRole("link", { name: "Release notes" })).toHaveAttribute("href", stableRelease.url);
  await expect(dialog.getByText(/Nightly releases are testing builds/)).toHaveCount(0);
  // Keyboard: the track is a native select reached with Tab and changed with the arrow keys.
  await dialog.getByLabel("Git repository URL").focus();
  await page.keyboard.press("Tab");
  await expect(track).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(track).toHaveValue("nightly");
  await expect(dialog.getByText("Nightly releases are testing builds. Use the Nightly track only on a test installation")).toBeVisible();
  await expect(dialog.getByRole("status").filter({ hasText: "Newest Nightly (testing only) release: v1.1.0-nightly.20261025 (nightly testing build)" })).toBeVisible();
  await expect(dialog.getByLabel("Commit SHA")).toHaveValue(nightlyRelease.commit);
  const lookups = mock.posts.filter((post) => post.path === "release").map((post) => post.body);
  expect(lookups[0]).toEqual({ id: "carpool", source, track: "stable" }); expect(lookups.at(-1)).toEqual({ id: "carpool", source, track: "nightly" });
  await dialog.getByRole("button", { name: "Review change" }).click();
  await expect(dialog.getByRole("heading", { name: "Confirm carpool" })).toBeVisible();
  await expect(dialog).toContainText("Nightly (testing only), changed from Stable. Release v1.1.0-nightly.20261025.");
  await expect(dialog.locator(".plugin-nightly-warning")).toBeVisible();
  await dialog.getByRole("checkbox", { name: /I trust this source/ }).check();
  await dialog.getByLabel("Your password").fill("correct");
  await dialog.getByRole("button", { name: "Confirm identity" }).click();
  await dialog.getByRole("button", { name: "Commit change" }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.posts.find((post) => post.path === "change")?.body).toEqual({ action: "upgrade", id: "carpool", source, commit: nightlyRelease.commit, track: "nightly", selectionSha, trustConfirmed: true });
  await expect(plugins.getByRole("status").filter({ hasText: "Pinned carpool on the Nightly track (testing only)" })).toBeVisible();
  await expect(plugins.locator(".plugin-row").filter({ hasText: "carpool" }).first().locator(".plugin-track-badge")).toHaveText("Nightly track · testing only");
  // Reopening Upgrade keeps the plugin on its track.
  await plugins.getByRole("button", { name: "Upgrade carpool" }).click();
  await expect(page.getByRole("dialog", { name: "Upgrade plugin" }).getByLabel("Release track")).toHaveValue("nightly");
});

test("plugin controls use shared themed styles at desktop and mobile in light and dark", async ({ page }) => {
  await setup(page, pluginState({ installed: [official, { id: "carpool", source, commit, official: false, selected: true, phase: "disabled" }], pending: [{ kind: "upgrade", id: "carpool", source, commit: next, installedCommit: commit }], selection: { sha: selectionSha, present: true, officialModules: true, modules: [{ id: "carpool", source, commit: next, track: "nightly", phase: "disabled" }] } }));
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript((value) => localStorage.setItem("lancerlogin-theme", value), theme);
    await page.goto("/settings/modules");
    await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
    const add = page.locator(".plugin-management").getByRole("button", { name: "Add plugin" });
    await expect(add).toBeEnabled();
    await expect(page.locator(".plugin-pending")).toContainText("Not deployed");
    await add.focus();
    const styles = await add.evaluate((element) => {
      const actual = getComputedStyle(element); const probe = document.createElement("span"); probe.style.color = "var(--on-primary)"; probe.style.backgroundColor = "var(--primary)"; probe.style.borderRadius = "var(--radius-control)"; element.append(probe); const expected = getComputedStyle(probe);
      const result = { background: actual.backgroundColor === expected.backgroundColor, color: actual.color === expected.color, radius: actual.borderRadius === expected.borderRadius, focus: actual.outlineStyle, height: element.getBoundingClientRect().height }; probe.remove(); return result;
    });
    expect(styles).toMatchObject({ background: true, color: true, radius: true }); expect(styles.focus).not.toBe("none"); expect(styles.height).toBeGreaterThanOrEqual(44);
    const pendingBorder = await page.locator(".plugin-pending").evaluate((element) => getComputedStyle(element).borderStyle);
    expect(pendingBorder).toBe("dashed");
    const badge = await page.locator(".plugin-track-badge").evaluate((element) => {
      const actual = getComputedStyle(element); const probe = document.createElement("span"); probe.style.color = "var(--ui-warning)"; probe.style.backgroundColor = "var(--ui-warning-surface)"; element.append(probe); const expected = getComputedStyle(probe);
      const result = { color: actual.color === expected.color, background: actual.backgroundColor === expected.backgroundColor, text: element.textContent }; probe.remove(); return result;
    });
    expect(badge).toEqual({ color: true, background: true, text: "Nightly track · testing only" });
    await add.click();
    const dialog = page.getByRole("dialog", { name: "Add plugin" });
    for (const label of ["Module ID", "Git repository URL", "Release track", "Commit SHA"]) expect(await dialog.getByLabel(label).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`plugins-${theme}-${width}.png`) });
    await page.keyboard.press("Escape");
  }
});

test("Settings > Updates explains a used module that moved into a plugin and keeps it through the plugin flow", async ({ page }) => {
  const mock = await setup(page);
  let required = [{ id: "carpool", label: "Carpool", plugin: { source, commit } }];
  await page.route("**/admin/plugins/migrations", (route) => route.fulfill({ json: { required } }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ json: { kiosks: [] } }));
  await page.route("**/admin/plugins/change", (route) => { mock.posts.push({ path: "change", body: route.request().postDataJSON() }); required = []; return route.fulfill({ status: 201, json: { committed: { action: "add", id: "carpool", commit } } }); });
  await page.goto("/settings/updates");
  const notice = page.getByRole("group", { name: "Carpool is in use and is now a separate plugin." });
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Back up and begin update" })).toBeDisabled();
  await expect(notice.getByRole("link", { name: "Remove Carpool" })).toHaveAttribute("href", "/settings/modules");
  await notice.getByRole("button", { name: "Keep Carpool (add plugin)" }).click();
  const dialog = page.getByRole("dialog", { name: "Add plugin" });
  await expect(dialog.getByLabel("Module ID")).toHaveValue("carpool");
  await expect(dialog.getByLabel("Git repository URL")).toHaveValue(source);
  await expect(dialog.getByLabel("Commit SHA")).toHaveValue(commit);
  await dialog.getByRole("button", { name: "Review change" }).click();
  await dialog.getByRole("checkbox", { name: /I trust this source/ }).check();
  await dialog.getByLabel("Your password").fill("correct");
  await dialog.getByRole("button", { name: "Confirm identity" }).click();
  await dialog.getByRole("button", { name: "Commit change" }).click();
  await expect(page.getByText("Added the carpool plugin. The next update installs LancerLogin and the plugin together.")).toBeVisible();
  await expect(notice).toHaveCount(0);
  expect(mock.posts.find((post) => post.path === "change")?.body).toMatchObject({ action: "add", id: "carpool", source, commit, trustConfirmed: true });
});

type AccessUse = ModuleAccessUse;
const accessUse = (overrides: Partial<AccessUse> = {}): AccessUse => ({
  consumer: { id: "consumer", label: "Consumer", phase: "enabled" }, provider: { id: "example", label: "Example", state: "ready" },
  interface: { id: "example.items", version: 1, label: "Example items" }, required: false, reason: "Copy Example items into Consumer runs",
  operations: [{ id: "list", label: "List Example items", grantable: true }, { id: "create", label: "Create Example items", grantable: true }, { id: "close", label: "Close Example items", grantable: false }],
  grantable: ["list", "create"], grant: null, ...overrides,
});
async function accessSetup(page: Page) {
  const mock = await setup(page);
  const ledger = accessUse({ consumer: { id: "relay", label: "Relay", phase: "enabled" }, provider: { id: "ledger", label: "Ledger", state: "disabled" }, interface: { id: "ledger.entries", version: 2, label: "Ledger entries" }, required: true, reason: "Post relay totals", operations: [{ id: "post", label: "Post Ledger entries", grantable: true }], grantable: ["post"], grant: { id: "grant-ledger", operations: ["post"], grantedAt: "2026-10-20T15:00:00.000Z", grantedBy: "admin", current: true } });
  let uses = [accessUse(), ledger]; let freshUntil: number | null = null; let stale = false;
  const state = () => ({ uses, reauthentication: { freshUntil, password: true, google: false } });
  await page.route("**/admin/modules/grants", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: state() });
    mock.posts.push({ path: "grant", body: route.request().postDataJSON() });
    if (stale) { stale = false; freshUntil = null; return route.fulfill({ status: 401, json: { error: "Confirm your identity again before changing module access.", code: "reauthentication_required" } }); }
    uses = [accessUse({ grant: { id: "grant-consumer", operations: ["list", "create"], grantedAt: new Date().toISOString(), grantedBy: "admin", current: true } }), ledger];
    return route.fulfill({ status: 201, json: state() });
  });
  await page.route("**/admin/modules/grants/revoke", (route) => {
    mock.posts.push({ path: "revoke", body: route.request().postDataJSON() });
    uses = [accessUse(), ledger];
    return route.fulfill({ json: state() });
  });
  await page.route("**/admin/plugins/reauthenticate", (route) => {
    const body = route.request().postDataJSON() as { password: string; purpose?: string }; mock.posts.push({ path: "reauthenticate", body: { password: body.password ? "[provided]" : "", purpose: body.purpose } });
    if (body.password !== "correct") return route.fulfill({ status: 401, json: { error: "The password is incorrect.", code: "reauthentication_failed" } });
    freshUntil = Date.now() + 600_000;
    return route.fulfill({ json: { ok: true, freshUntil } });
  });
  return { posts: mock.posts, expire() { stale = true; } };
}

test("Admin reviews, grants and revokes module access in Settings > Modules after confirming identity", async ({ page }) => {
  const mock = await accessSetup(page);
  await page.goto("/settings/modules");
  const access = page.locator(".module-access");
  await expect(access.getByRole("heading", { name: "Module access", exact: true })).toBeVisible();
  const consumer = access.locator(".module-access-row").filter({ hasText: "Consumer asks to use Example" });
  await expect(consumer).toContainText("List Example items");
  await expect(consumer).toContainText("Close Example items (signed-in people only)");
  await expect(consumer).toContainText("Reason: Copy Example items into Consumer runs");
  await expect(consumer).toContainText("Not granted. Signed-in people with access to Example can still use it from Consumer.");
  const relay = access.locator(".module-access-row").filter({ hasText: "Relay asks to use Ledger" });
  await expect(relay).toContainText("Ledger is not enabled, so this access is unavailable until it is.");
  await expect(relay).toContainText("Relay cannot be enabled without Ledger.");
  await expect(relay).toContainText("Granted by admin on");
  await expect(relay.getByRole("button", { name: /^Grant/ })).toHaveCount(0);

  // Escape closes the dialog without a change and returns focus to its button.
  const grantButton = consumer.getByRole("button", { name: "Grant Consumer access to Example" });
  await grantButton.click();
  let dialog = page.getByRole("dialog", { name: "Grant Consumer access" });
  await expect(dialog).toContainText("List Example items");
  await expect(dialog).toContainText("Not included: Close Example items. Only signed-in people with access to Example can do this.");
  await expect(dialog).toContainText("Copy Example items into Consumer runs");
  await expect(dialog.getByRole("button", { name: "Grant access" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(grantButton).toBeFocused();

  // A wrong password is refused; the confirmed identity then allows the grant of exactly the grantable operations.
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog", { name: "Grant Consumer access" });
  await dialog.getByLabel("Your password").fill("wrong");
  await dialog.getByRole("button", { name: "Confirm identity" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The password is incorrect.");
  await dialog.getByLabel("Your password").fill("correct");
  await page.keyboard.press("Enter");
  await expect(dialog.getByText(/Identity confirmed until/)).toBeVisible();
  await dialog.getByRole("button", { name: "Grant access" }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.posts.find((post) => post.path === "grant")?.body).toEqual({ consumer: "consumer", interface: "example.items", version: 1, operations: ["list", "create"] });
  expect(mock.posts.filter((post) => post.path === "reauthenticate").map((post) => post.body)).toEqual([{ password: "[provided]", purpose: "module_access" }, { password: "[provided]", purpose: "module_access" }]);
  await expect(access.getByRole("status").filter({ hasText: "Consumer can now use Example without a signed-in user." })).toBeFocused();
  await expect(consumer).toContainText("Granted by admin on");
  await expect(consumer.getByRole("button", { name: /^Grant/ })).toHaveCount(0);

  // Revoking within the confirmation window needs no second password.
  await consumer.getByRole("button", { name: "Revoke Consumer access to Example" }).click();
  dialog = page.getByRole("dialog", { name: "Revoke Consumer access" });
  await expect(dialog).toContainText("A call already running stops at its next step");
  await expect(dialog.getByText(/Identity confirmed until/)).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke access" }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.posts.find((post) => post.path === "revoke")?.body).toEqual({ grantId: "grant-consumer" });
  await expect(access.getByRole("status").filter({ hasText: "Revoked Consumer's access to Example." })).toBeFocused();
  await expect(consumer).toContainText("Not granted.");

  // When the session's confirmation has lapsed, the Worker refuses and the dialog asks for identity again.
  mock.expire();
  await consumer.getByRole("button", { name: "Grant Consumer access to Example" }).click();
  dialog = page.getByRole("dialog", { name: "Grant Consumer access" });
  await dialog.getByRole("button", { name: "Grant access" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Confirm your identity again before changing module access.");
  await expect(dialog.getByLabel("Your password")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Grant access" })).toBeDisabled();
});

test("module access controls use shared themed styles at desktop and mobile in light and dark", async ({ page }) => {
  await accessSetup(page);
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript((value) => localStorage.setItem("lancerlogin-theme", value), theme);
    await page.goto("/settings/modules");
    await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
    const grant = page.getByRole("button", { name: "Grant Consumer access to Example" });
    const revoke = page.getByRole("button", { name: "Revoke Relay access to Ledger" });
    const styles = (locator: typeof grant, expected: { background: string; color: string }) => locator.evaluate((element, colors) => {
      const actual = getComputedStyle(element); const probe = document.createElement("span"); probe.style.color = colors.color; probe.style.backgroundColor = colors.background; probe.style.borderRadius = "var(--radius-control)"; element.append(probe); const reference = getComputedStyle(probe);
      const result = { background: actual.backgroundColor === reference.backgroundColor, color: actual.color === reference.color, radius: actual.borderRadius === reference.borderRadius, focus: actual.outlineStyle, height: element.getBoundingClientRect().height }; probe.remove(); return result;
    }, expected);
    await grant.focus();
    const primary = await styles(grant, { background: "var(--primary)", color: "var(--on-primary)" });
    expect(primary).toMatchObject({ background: true, color: true, radius: true }); expect(primary.focus).not.toBe("none"); expect(primary.height).toBeGreaterThanOrEqual(44);
    await revoke.focus();
    const secondary = await styles(revoke, { background: "var(--ui-surface)", color: "var(--ui-text)" });
    expect(secondary).toMatchObject({ radius: true }); expect(secondary.focus).not.toBe("none"); expect(secondary.height).toBeGreaterThanOrEqual(44);
    const granted = await page.locator(".module-access-row[data-status='granted'] .module-access-status").evaluate((element) => { const probe = document.createElement("span"); probe.style.color = "var(--ui-success)"; element.append(probe); const same = getComputedStyle(element).color === getComputedStyle(probe).color; probe.remove(); return same; });
    expect(granted).toBe(true);
    await page.locator(".module-access").screenshot({ path: test.info().outputPath(`module-access-list-${theme}-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await grant.click();
    const dialog = page.getByRole("dialog", { name: "Grant Consumer access" });
    expect(await dialog.getByLabel("Your password").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await dialog.getByRole("button", { name: "Grant access" }).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`module-access-${theme}-${width}.png`) });
    await page.keyboard.press("Escape");
  }
});

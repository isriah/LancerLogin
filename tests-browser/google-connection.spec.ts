import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences as reference } from "../apps/dashboard/src/design-conformance";

const summary = (extra = {}) => ({ generation: "synthetic-generation", loginEnabled: false, loginVerified: false, calendarEnabled: true, driveEnabled: true, organizationAuthorized: true, grantedScopes: ["https://www.googleapis.com/auth/drive.file"], calendarReady: false, driveReady: true, calendarSelected: false, ...extra });
const snapshot = (extra = {}) => ({ revision: 0, mode: "legacy", active: null, candidate: null, callbackUri: "https://fixture.test/api/admin/connections/google/callback", loginCallbackUri: "https://fixture.test/api/auth/google/callback", ...extra });
const area = (page: Page) => page.getByRole("region", { name: "Google connection", exact: true });
async function context(page: Page, state: () => unknown, theme = "light") {
  await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Connection Team", primaryColor: reference.brand.primary, secondaryColor: reference.brand.secondary, appearance: theme } } }));
  await page.route("**/admin/integrations/discord/channel-manager", route => route.fulfill({ json: { enabled: false, contestWindowHours: 24 } }));
  await page.route("**/admin/integrations/discord/anomaly-reports", route => route.fulfill({ json: { enabled: false, channelId: "" } }));
  await page.route("**/admin/connections/google", route => route.fulfill({ json: state() }));
}
test("fresh setup stages once, clears secrets, pages calendars and explicitly promotes/cancels", async ({ page }) => {
  let state = snapshot(); const writes: unknown[] = []; await context(page, () => state);
  await page.route("**/admin/integrations", route => route.fulfill({ json: { integrations: [] } }));
  await page.route("**/admin/connections/google/candidate", async route => { writes.push(route.request().postDataJSON()); state = snapshot({ revision: state.revision + 1, candidate: route.request().method() === "DELETE" ? null : summary({ organizationAuthorized: false, driveReady: false }) }); await route.fulfill({ json: state }); });
  await page.goto("/settings/integrations"); const view = area(page);
  await expect(page.getByLabel("Calendar OAuth client secret")).toHaveCount(0);
  await view.getByLabel("OAuth client ID", { exact: true }).fill("synthetic-client");
  await view.getByLabel("OAuth client secret", { exact: true }).fill("synthetic-only");
  await view.getByLabel("Attendance Calendar", { exact: true }).check(); await view.getByLabel("Activity Documentation Drive", { exact: true }).check();
  await view.getByRole("button", { name: "Stage Google connection" }).click();
  await expect(view.getByRole("button", { name: "Promote verified candidate" })).toBeDisabled();
  await expect(view.getByRole("status").filter({ hasText: "Change confirmed" })).toBeFocused();
  expect(writes).toEqual([{ revision: 0, loginEnabled: false, calendarEnabled: true, driveEnabled: true, clientId: "synthetic-client", clientSecret: "synthetic-only" }]);
  await expect(view.locator("input[type=password]")).toHaveCount(0);
  state = snapshot({ revision: 2, candidate: summary() }); await view.getByRole("button", { name: "Reload Google connection" }).click();
  const pages: string[] = [];
  await page.route("**/admin/connections/google/calendars?**", route => { pages.push(route.request().url()); return route.fulfill({ json: { revision: 2, calendars: pages.length === 1 ? [{ id: "one", name: "First calendar" }] : [{ id: "two", name: "Second calendar" }], ...(pages.length === 1 ? { nextPageToken: "synthetic-next" } : {}) } }); });
  await view.getByRole("button", { name: "Load writable calendars" }).click(); await view.getByRole("button", { name: "Next calendar page" }).click();
  expect(pages[1]).toContain("pageToken=synthetic-next"); await expect(view.getByRole("option", { name: "First calendar" })).toHaveCount(0);
  await page.route("**/admin/connections/google/calendar", async route => { writes.push(route.request().postDataJSON()); state = snapshot({ revision: 3, candidate: summary({ calendarReady: true, calendarSelected: true, calendarName: "Second calendar" }) }); await route.fulfill({ json: state }); });
  await view.getByLabel("Candidate attendance calendar").selectOption("two"); await view.getByRole("button", { name: "Verify selected calendar" }).click();
  await page.route("**/admin/connections/google/promote", async route => { writes.push(route.request().postDataJSON()); state = snapshot({ revision: 4, mode: "shared", active: summary({ calendarReady: true, calendarSelected: true }) }); await route.fulfill({ json: state }); });
  await view.getByRole("button", { name: "Promote verified candidate" }).click(); await expect(view.getByText("Shared connection mode.", { exact: false })).toBeVisible(); await expect(view.getByRole("status").filter({ hasText: "Change confirmed" })).toBeFocused();
  await view.getByRole("button", { name: "Stage Google connection" }).click(); await view.getByRole("button", { name: "Cancel candidate" }).click();
  expect(writes.at(-1)).toEqual({ revision: 5 }); await expect(view.getByRole("status").filter({ hasText: "Change confirmed" })).toBeFocused();
});

test("uncertain stage fails closed, clears secret and requires explicit reload without retry", async ({ page }) => {
  await context(page, () => snapshot()); let writes = 0;
  await page.route("**/admin/connections/google/candidate", route => { writes++; return route.fulfill({ status: 409, json: { error: "synthetic-private-error" } }); });
  await page.goto("/settings/integrations"); const view = area(page);
  await view.getByLabel("OAuth client ID", { exact: true }).fill("synthetic-client"); await view.getByLabel("OAuth client secret", { exact: true }).fill("synthetic-only");
  await view.getByRole("button", { name: "Stage Google connection" }).click(); await expect(view.getByRole("alert")).toBeFocused();
  await expect(view.getByLabel("OAuth client secret", { exact: true })).toHaveValue(""); await expect(view.getByRole("button", { name: "Stage Google connection" })).toBeDisabled();
  await expect(page.getByText("synthetic-private-error")).toHaveCount(0); expect(writes).toBe(1);
  await view.getByRole("button", { name: "Reload Google connection" }).click(); await expect(view.getByRole("button", { name: "Stage Google connection" })).toBeEnabled(); expect(writes).toBe(1);
});

test("malformed status hides legacy writes and callback failure reloads without trusting marker", async ({ page }) => {
  let state: unknown = { revision: 0 }; await context(page, () => state); await page.goto("/settings/integrations?googleConnection=failed"); const view = area(page);
  await expect(view.getByRole("alert")).toBeVisible(); await expect(page.getByRole("switch", { name: "Enable Google OAuth" })).toHaveCount(0);
  state = snapshot({ candidate: summary({ organizationAuthorized: false, driveReady: false }) });
  await page.goto("/settings/integrations?googleConnection=failed"); await expect(view.getByRole("alert")).toContainText("authorization did not complete");
  await expect(view.getByRole("button", { name: "Promote verified candidate" })).toBeDisabled(); expect(page.url()).not.toContain("googleConnection");
  let consentBody: unknown;
  await page.route("**/admin/connections/google/authorize", route => { consentBody = route.request().postDataJSON(); return route.fulfill({ json: { authorizationUrl: "https://untrusted.example.test/redirect" } }); });
  await view.getByRole("button", { name: "Authorize organizational account" }).click(); await expect(view.getByRole("alert")).toContainText("could not be confirmed");
  expect(consentBody).toEqual({ revision: 0, purpose: "organization", capabilities: ["calendar", "drive"] }); expect(page.url()).not.toContain("untrusted");
});

test("shared mode retains Calendar delivery and exact removal confirmation", async ({ page }) => {
  let state = snapshot({ revision: 3, mode: "shared", active: summary({ calendarReady: true }) }); await context(page, () => state);
  await page.route("**/admin/integrations/google-calendar/sync-all", route => route.fulfill({ json: { selected: 2, synced: 1, queued: 1, failed: 0 } }));
  await page.goto("/settings/integrations"); const view = area(page);
  await view.getByRole("button", { name: "Sync all active meetings" }).click(); await expect(view.getByText(/1 updated, 1 queued/)).toBeVisible();
  await view.getByText("Remove Google connection", { exact: true }).click(); const remove = view.getByRole("button", { name: "Remove shared Google connection" }); await expect(remove).toBeDisabled();
  await view.getByLabel("Removal confirmation").fill("REMOVE GOOGLE CONNECTION");
  await page.route("**/admin/connections/google", async route => { if (route.request().method() === "DELETE") { expect(route.request().postDataJSON()).toEqual({ revision: 3, confirmation: "REMOVE GOOGLE CONNECTION" }); state = snapshot({ revision: 4, mode: "shared" }); } await route.fulfill({ json: state }); });
  await remove.click(); await expect(view.getByText("None in the shared connection.")).toHaveCount(2);
  await expect(page.getByRole("switch", { name: "Enable Google OAuth" })).toHaveCount(0);
});

test("login proof navigates only to the expected Google destination and sends no organizational capabilities", async ({ page }) => {
  await context(page, () => snapshot({ candidate: summary({ loginEnabled: true }) }));
  let input: unknown; const destination = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=" + encodeURIComponent(snapshot().callbackUri);
  await page.route("**/admin/connections/google/authorize", route => { input = route.request().postDataJSON(); return route.fulfill({ json: { authorizationUrl: destination } }); });
  await page.route("https://accounts.google.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Synthetic provider destination</h1>" }));
  await page.goto("/settings/integrations"); await area(page).getByRole("button", { name: "Verify registered Admin sign-in" }).click();
  await expect(page).toHaveURL(destination); expect(input).toEqual({ revision: 0, purpose: "login-proof", capabilities: [] });
});

test("successful write with failed read-back stays locked; explicit reload discovers the candidate", async ({ page }) => {
  let state = snapshot({ revision: 1, mode: "shared", active: summary() }); let invalidRead = false; let writes = 0;
  await context(page, () => invalidRead ? {} : state);
  await page.route("**/admin/connections/google/candidate", route => { writes++; state = snapshot({ revision: 2, mode: "shared", active: summary(), candidate: summary() }); invalidRead = true; return route.fulfill({ json: state }); });
  await page.goto("/settings/integrations"); const view = area(page); await view.getByRole("button", { name: "Stage Google connection" }).click();
  await expect(view.getByRole("alert")).toContainText("could not be confirmed"); await expect(view.getByRole("button", { name: "Stage Google connection" })).toBeDisabled();
  invalidRead = false; await view.getByRole("button", { name: "Reload Google connection" }).click(); await expect(view.getByRole("button", { name: "Cancel candidate" })).toBeEnabled(); expect(writes).toBe(1);
});

for (const theme of ["light", "dark"]) for (const width of [1280, 390]) test(`Google controls ${theme} ${width}: keyboard, brand and geometry`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme as "light" | "dark" });
  await context(page, () => snapshot({ revision: 7, mode: "shared", active: summary({ calendarReady: true, calendarName: "Synthetic attendance calendar" }), candidate: summary({ loginEnabled: true }) }), theme);
  await page.goto("/settings/integrations"); const view = area(page); await expect(view.getByRole("heading", { name: "Candidate connection" })).toBeVisible();
  expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
  const reload = view.getByRole("button", { name: "Reload Google connection" }); await reload.focus(); await expect(reload).toBeFocused(); await page.keyboard.press("Tab");
  await expect(view.getByText("Actual granted scopes (1)").first()).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const button of await view.getByRole("button").all()) if (await button.isVisible()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`google-${theme}-${width}.png`), fullPage: true });
});

import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
import { attendanceSetupState, attendanceSnapshot } from "./module-fixtures";
import { pairedViews } from "./paired-views";

test.use({ timezoneId: "UTC" });

const referenceSettings = {
  organizationName: "Reference Arts Collective",
  subtitle: "Shared operations",
  logoData: "",
  primaryColor: dashboardConformanceReferences.brand.primary,
  secondaryColor: dashboardConformanceReferences.brand.secondary,
  appearance: "dark",
  logoBackdrop: "auto",
  lateScanMinutes: 30,
  discordContestWindowHours: 24,
};

async function configureSignIn(page: Page, authMode: "local" | "google" | "both") {
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, installation: { authMode }, settings: referenceSettings }) }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Authentication required" }) }));
}

async function expectResponsiveFit(page: Page) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    clipped: Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")).flatMap((element) => {
      const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || bounds.width === 0 || element.closest(".table-scroll")) return [];
      return bounds.left < -1 || bounds.right > innerWidth + 1 ? [element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName] : [];
    }),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.clipped).toEqual([]);
}

for (const { viewport, theme } of pairedViews) {
    test(`Attendance setup shows one validated card at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-10-25T23:59:59.900Z"));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      let state = attendanceSetupState({}, ["rules"]); let saved: unknown;
      await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: referenceSettings } }));
      await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot({ setupReady: false }) }));
      await page.route("**/admin/modules/attendance/setup", async (route) => {
        if (route.request().method() === "PUT") { saved = route.request().postDataJSON(); state = attendanceSetupState({ rules: "completed" }, ["rules"]); }
        await route.fulfill({ json: state });
      });
      await page.route("**/module-setup/attendance/rules", (route) => route.fulfill({ json: { values: { lateScanMinutes: 30, attendanceReportingStartsOn: null, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 10 } } }));
      await page.route("**/module-setup/attendance/meeting", (route) => route.fulfill({ json: { meetings: [], timeZone: "UTC" } }));
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "Attendance rules" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2 })).toHaveCount(1);
      await expect(page.getByText(/Roster readiness/i)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
      const next = page.getByRole("button", { name: "Save and continue" });
      await expect(next).toBeVisible();
      await next.click();
      await expect.poll(() => saved).toEqual({ generation: 1, stepId: "rules", outcome: "completed" });
      await expect(page.getByRole("heading", { level: 2, name: "First meeting" })).toBeVisible();
      const starts = await page.getByLabel("Starts").inputValue(); const ends = await page.getByLabel("Ends").inputValue();
      expect(starts.slice(0, 10)).toBe(ends.slice(0, 10));
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
      await expectResponsiveFit(page);
    });
  }

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
    test(`dual sign-in conforms at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await configureSignIn(page, "both");
      await page.goto("/dashboard");

      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".app")).toHaveCSS("--primary", dashboardConformanceReferences.brand.primary);
      await expect(page.locator(".app")).toHaveCSS("--secondary", dashboardConformanceReferences.brand.secondary);
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
      await expectResponsiveFit(page);

      const username = page.getByLabel("Username");
      await username.focus();
      expect(await username.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
      expect((await username.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    });
  }
}

for (const { viewport, theme } of pairedViews) {
    test(`first-Admin Google guidance fits at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false }) }));
      await page.goto("/dashboard");
      await page.getByLabel("Google OAuth").check();

      const guideLink = page.getByRole("link", { name: /Open the complete Google OAuth guide/ });
      await expect(guideLink).toHaveAttribute("href", "https://isriah.github.io/LancerLogin/setup.html#google-oauth");
      await guideLink.focus();
      await expect(guideLink).toBeFocused();
      expect((await guideLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(page.getByText(`${new URL(page.url()).origin}/api/auth/google/callback`, { exact: true })).toBeVisible();
      expect((await page.locator(".oauth-walkthrough").getByRole("button", { name: "Copy" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expectResponsiveFit(page);
    });
  }

test("first-Admin modes expose associated validation and a pending state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("lancerlogin-theme", "dark");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } });
  });
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false }) }));
  await page.route("**/setup/bootstrap", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "The one-time setup code is invalid" }) });
  });
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Create your installation" })).toBeVisible();
  await page.getByLabel("Both methods").check();
  await expect(page.getByRole("group", { name: "Google OAuth guided setup" })).toBeVisible();
  const guideLink = page.getByRole("link", { name: /Open the complete Google OAuth guide/ });
  await expect(guideLink).toHaveAttribute("href", "https://isriah.github.io/LancerLogin/setup.html#google-oauth");
  await guideLink.focus();
  await expect(guideLink).toBeFocused();
  expect((await guideLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const callback = `${new URL(page.url()).origin}/api/auth/google/callback`;
  await expect(page.getByText(callback, { exact: true })).toBeVisible();
  const copyCallback = page.locator(".oauth-walkthrough").getByRole("button", { name: "Copy" });
  await copyCallback.focus();
  await expect(copyCallback).toBeFocused();
  expect((await copyCallback.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await copyCallback.click();
  await expect(page.locator(".oauth-walkthrough").getByRole("button", { name: "Copied" })).toBeVisible();
  await page.getByLabel("One-time setup code").fill("not-the-right-code");
  await page.getByLabel("Organization name").fill("Reference Arts Collective");
  await page.getByLabel("Admin username").fill("admin");
  await page.getByRole("textbox", { name: /^Admin password/ }).fill("correct-horse-battery");
  await page.getByLabel("Confirm Admin password").fill("different-password");
  await expect(page.getByText("Passwords do not match.")).toHaveAttribute("role", "alert");
  await page.getByLabel("First Admin Google email").fill("admin@example.org");
  await page.getByLabel("OAuth client ID").fill("client-id");
  await page.getByLabel("OAuth client secret").fill("client-secret");
  await page.getByLabel("Confirm Admin password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create first Admin" }).click();
  await expect(page.getByRole("button", { name: "Creating installation…" })).toBeDisabled();
  const error = page.getByRole("alert");
  await expect(error).toContainText("one-time setup code is invalid");
  await expect(page.getByLabel("One-time setup code")).toHaveAttribute("aria-describedby", /first-admin-error/);
  await expectResponsiveFit(page);
});

for (const { viewport, theme } of pairedViews) {
  test(`first-Admin form labels every field and offers sign-in methods as a radio group at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
    await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false } }));
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Create your installation" })).toBeVisible();
    await expect(page.locator(".setup-header")).not.toContainText("Community Edition");
    await expect(page.locator(".setup-header .brand-heading")).toHaveText("LancerLogin");

    for (const name of ["Organization name", "Admin username", "Admin password", "Confirm Admin password"]) await expect(page.getByRole("textbox", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Admin password", exact: true })).toHaveAccessibleDescription(/At least 12 characters\. If every Admin loses their password, see Recover access/);
    await expect(page.getByRole("link", { name: /Recover access/ })).toHaveAttribute("href", "https://isriah.github.io/LancerLogin/operations.html");

    // Time zone is a labelled list of IANA zones that starts on the browser's zone (UTC here) and keeps it when the engine omits it.
    const timeZone = page.getByRole("combobox", { name: "Time zone" });
    await expect(timeZone).toHaveValue("UTC");
    expect(await timeZone.locator("option").count()).toBeGreaterThan(100);
    await timeZone.selectOption("America/New_York");
    await expect(timeZone).toHaveValue("America/New_York");

    const methods = page.getByRole("radiogroup", { name: "Dashboard sign-in" });
    await expect(methods.getByRole("radio")).toHaveCount(3);
    // Each radio is named by its visible title, never by its submitted value.
    for (const value of ["local", "google", "both"]) await expect(methods.getByRole("radio", { name: value, exact: true })).toHaveCount(0);
    const local = methods.getByRole("radio", { name: "Username and password", exact: true });
    await expect(local).toBeChecked();
    await expect(local).toHaveAccessibleDescription("Works without an identity provider.");
    await local.focus();
    const card = page.locator(`label.choice[for="auth-mode-local"]`);
    expect(await card.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    expect((await local.boundingBox())!.width).toBeGreaterThan(8);
    await page.keyboard.press("ArrowRight");
    await expect(methods.getByRole("radio", { name: "Google OAuth", exact: true })).toBeChecked();
    await expect(methods.getByRole("radio", { name: "Google OAuth", exact: true })).toBeFocused();
    await expect(page.getByRole("group", { name: "Google OAuth guided setup" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Admin username", exact: true })).toHaveCount(0);
    for (const name of ["First Admin Google email", "OAuth client ID", "OAuth client secret"]) await expect(page.getByLabel(name, { exact: true })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(methods.getByRole("radio", { name: "Both methods", exact: true })).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Admin username", exact: true })).toBeVisible();
    await expectResponsiveFit(page);
  });
}

test("first-Admin setup with a password signs the new Admin straight in", async ({ page }) => {
  let signedIn = false;
  let payload: Record<string, unknown> | undefined;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false } }));
  await page.route("**/setup/bootstrap", (route) => {
    payload = route.request().postDataJSON() as Record<string, unknown>;
    signedIn = true;
    return route.fulfill({ status: 201, json: { configured: true, signedIn: true, user: { id: "admin-1", role: "admin", debugMode: false } } });
  });
  // The session check after setup sees the cookie bootstrap set; before setup there is no session.
  await page.route("**/auth/session", (route) => signedIn ? route.fallback() : route.fulfill({ status: 401, json: { error: "Authentication required" } }));
  let localSignIns = 0;
  await page.route("**/auth/local", (route) => { localSignIns++; return route.fulfill({ status: 500, json: {} }); });
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot() }));
  await page.goto("/dashboard");
  await page.getByLabel("One-time setup code").fill("synthetic-setup-code-0001");
  await page.getByRole("textbox", { name: "Organization name", exact: true }).fill("Reference Arts Collective");
  await page.getByRole("combobox", { name: "Time zone" }).selectOption("Europe/London");
  await page.getByRole("textbox", { name: "Admin username", exact: true }).fill("director");
  await page.getByRole("textbox", { name: "Admin password", exact: true }).fill("correct-horse-battery");
  await page.getByRole("textbox", { name: "Confirm Admin password", exact: true }).fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create first Admin" }).click();
  await expect(page.getByRole("navigation", { name: "Primary dashboard navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Sign in/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toHaveCount(0);
  expect(localSignIns).toBe(0);
  expect(payload).toMatchObject({ organizationName: "Reference Arts Collective", timeZone: "Europe/London", authMode: "local", localUsername: "director" });
  // Without a Worker-reported default the new installation shows the release colors.
  await expect(page.locator(".app")).toHaveCSS("--primary", "#b80100");
  await expect(page.locator(".app")).toHaveCSS("--secondary", "#eeb822");
});

test("first-Admin setup on a development Worker shows the development colors it reports", async ({ page }) => {
  let signedIn = false;
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false, defaultTheme: { primary: "#7c3aed", secondary: "#0f766e" } } }));
  await page.route("**/setup/bootstrap", (route) => { signedIn = true; return route.fulfill({ status: 201, json: { configured: true, signedIn: true, user: { id: "admin-1", role: "admin", debugMode: false } } }); });
  await page.route("**/auth/session", (route) => signedIn ? route.fulfill({ json: { user: { id: "admin-1", role: "admin", debugMode: false } } }) : route.fulfill({ status: 401, json: { error: "Authentication required" } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot() }));
  await page.goto("/dashboard");
  await page.getByLabel("One-time setup code").fill("synthetic-setup-code-0001");
  await page.getByRole("textbox", { name: "Organization name", exact: true }).fill("Test Robotics Team");
  await page.getByRole("textbox", { name: "Admin username", exact: true }).fill("test-admin");
  await page.getByRole("textbox", { name: "Admin password", exact: true }).fill("correct-horse-battery");
  await page.getByRole("textbox", { name: "Confirm Admin password", exact: true }).fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create first Admin" }).click();
  await expect(page.getByRole("navigation", { name: "Primary dashboard navigation" })).toBeVisible();
  await expect(page.locator(".app")).toHaveCSS("--primary", "#7c3aed");
  await expect(page.locator(".app")).toHaveCSS("--secondary", "#0f766e");
});

test("Google-only first-Admin setup asks the new Admin to sign in with Google to finish setup", async ({ page }) => {
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false } }));
  await page.route("**/setup/bootstrap", (route) => route.fulfill({ status: 201, json: { configured: true, signedIn: false } }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 401, json: { error: "Authentication required" } }));
  await page.goto("/dashboard");
  await page.getByRole("radio", { name: "Google OAuth", exact: true }).check();
  await page.getByLabel("One-time setup code").fill("synthetic-setup-code-0001");
  await page.getByRole("textbox", { name: "Organization name", exact: true }).fill("Reference Arts Collective");
  await page.getByLabel("First Admin Google email").fill("admin@example.org");
  await page.getByLabel("OAuth client ID").fill("client-id");
  await page.getByLabel("OAuth client secret").fill("client-secret");
  await page.getByRole("button", { name: "Create first Admin" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to finish setup" })).toBeVisible();
  await expect(page.getByText("Your installation is ready. Continue with Google using the first Admin email to finish setup.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toHaveCount(0);
  await expect(page.getByLabel("Username")).toHaveCount(0);
});

test("a first sign-in after setup without a session does not say Welcome back", async ({ page }) => {
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: false } }));
  await page.route("**/setup/bootstrap", (route) => route.fulfill({ status: 201, json: { configured: true, signedIn: false } }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 401, json: { error: "Authentication required" } }));
  await page.goto("/dashboard");
  await page.getByLabel("One-time setup code").fill("synthetic-setup-code-0001");
  await page.getByRole("textbox", { name: "Organization name", exact: true }).fill("Reference Arts Collective");
  await page.getByRole("textbox", { name: "Admin username", exact: true }).fill("director");
  await page.getByRole("textbox", { name: "Admin password", exact: true }).fill("correct-horse-battery");
  await page.getByRole("textbox", { name: "Confirm Admin password", exact: true }).fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create first Admin" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to finish setup" })).toBeVisible();
  await expect(page.getByText("Your installation is ready. Sign in with the Admin account you just created to finish setup.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.unroute("**/setup/status");
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: referenceSettings } }));
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText("Sign in to manage attendance.")).toBeVisible();
});

test("local sign-in keeps denied and unavailable states explicit without revealing account state", async ({ page }) => {
  await configureSignIn(page, "local");
  let attempts = 0;
  await page.route("**/auth/local", async (route) => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (attempts === 1) await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Invalid username or password" }) });
    else await route.abort("connectionfailed");
  });
  await page.goto("/dashboard");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Invalid username or password");
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Sign-in service unavailable");
});

test("Admin can move back, skip optional integrations, and finish Attendance setup", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  let snapshotReady = false;
  let state = attendanceSetupState({ rules: "completed", meeting: "completed", input: "completed" }, ["rules", "meeting", "input"]);
  const writes: unknown[] = [];
  await page.route("**/platform/modules", (route) => route.fulfill({ json: attendanceSnapshot({ setupReady: snapshotReady }) }));
  await page.route("**/admin/modules/attendance/setup", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { stepId: string; outcome: "completed" | "skipped" };
      writes.push(body);
      const outcomes = Object.fromEntries(state.steps.filter((step) => step.outcome).map((step) => [step.id, step.outcome])) as Record<string, "completed" | "skipped">;
      outcomes[body.stepId] = body.outcome;
      state = attendanceSetupState(outcomes, ["rules", "meeting", "input"]);
      if (body.stepId === "discord") snapshotReady = true;
    }
    await route.fulfill({ json: state });
  });
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Calendar integration" })).toBeVisible();
  await expect(page.getByText("Google Calendar is not configured and verified. You can safely set it up later.")).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Discord integration" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Calendar integration" })).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Discord integration" })).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Attendance is ready" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Meetings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
  expect(writes).toEqual([
    { generation: 1, stepId: "calendar", outcome: "skipped" },
    { generation: 1, stepId: "calendar", outcome: "skipped" },
    { generation: 1, stepId: "discord", outcome: "skipped" },
  ]);
  await expectResponsiveFit(page);
});

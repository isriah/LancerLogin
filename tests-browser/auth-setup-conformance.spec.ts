import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";
import { attendanceSetupState, attendanceSnapshot } from "./module-fixtures";

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

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
    test(`Attendance setup shows one validated card at ${viewport.width}x${viewport.height} in ${theme} mode`, async ({ page }) => {
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
      await page.route("**/module-setup/attendance/meeting", (route) => route.fulfill({ json: { meetings: [] } }));
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { level: 1, name: "Set up Attendance" })).toBeVisible();
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

for (const viewport of dashboardConformanceReferences.viewports) {
  for (const theme of dashboardConformanceReferences.themes) {
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

  await expect(page.getByRole("heading", { level: 1, name: "Set up Attendance" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Calendar integration" })).toBeVisible();
  await expect(page.getByText("Google Calendar is not configured and verified. You can safely set it up later.")).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Discord integration" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Calendar integration" })).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Discord integration" })).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
  expect(writes).toEqual([
    { generation: 1, stepId: "calendar", outcome: "skipped" },
    { generation: 1, stepId: "calendar", outcome: "skipped" },
    { generation: 1, stepId: "discord", outcome: "skipped" },
  ]);
  await expectResponsiveFit(page);
});

import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

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

test("first-Admin modes expose associated validation and a pending state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false }) }));
  await page.route("**/setup/bootstrap", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "The one-time setup code is invalid" }) });
  });
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Create your installation" })).toBeVisible();
  await page.getByLabel("Both methods").check();
  await expect(page.getByRole("group", { name: "Google OAuth guided setup" })).toBeVisible();
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

test("Admin can inspect, skip, reopen, and complete all five guided-setup steps with focus contained", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark"));
  await page.route("**/setup/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, installation: { authMode: "local" }, settings: referenceSettings }) }));
  await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { role: "admin" } }) }));
  await page.route("**/admin/setup/progress", (route) => {
    if (route.request().method() === "PATCH") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test"].map((step) => ({ step })) }) });
  });
  await page.route("**/admin/branding", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: referenceSettings }) }));
  await page.route("**/admin/members", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ members: [{ memberId: "member-1", externalId: "A-101", firstName: "Avery", lastName: "Stone", active: 1 }] }) }));
  await page.route("**/admin/kiosks", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1 }] }) }));
  await page.route("**/meetings", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meetings: [{ id: "meeting-1", title: "Build session", startsAt: new Date().toISOString() }] }) }));
  await page.route("**/admin/simulator", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ simulator: null }) }));
  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Guided setup progress" })).toHaveAttribute("aria-valuenow", "80");
  const steps = ["Organization & brand", "Roster", "Kiosk", "Kiosk input test", "Attendance confirmation"];
  for (const name of steps) {
    await page.getByRole("button", { name: new RegExp(`^${name}:`) }).click();
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Organization & brand: complete" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("button", { name: "Roster: complete" })).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "Attendance confirmation: not complete" }).click();
  await page.getByRole("button", { name: "Refresh attendance" }).click();
  await page.getByRole("button", { name: "Attendance matches — finish setup" }).click();

  const dialog = page.getByRole("dialog", { name: "Setup complete" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Go to Dashboard" })).toBeFocused();
  await expect(page.locator(".confetti")).toHaveCSS("display", "none");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Go to Dashboard" })).toBeFocused();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expectResponsiveFit(page);
});

import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

// Settings > Integrations > FIRST: saving, removing and testing Core's shared FIRST connection, with every /admin/
// integrations/first route answered here. Nothing reaches FIRST. Every username, token and team is synthetic.
type Credential = { saved: boolean; username: string; checkedAt: string | null; readable: boolean };
const unset: Credential = { saved: false, username: "", checkedAt: null, readable: false };

async function useFirst(page: Page, initial: Partial<Record<"FRC" | "FTC", Credential>> = {}) {
  const state = { programs: { FRC: unset, FTC: unset, ...initial }, fll: { available: true }, encryption: true };
  const writes: { method: string; url: string; body: unknown }[] = [];
  await page.route("**/admin/integrations/first**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const body = request.postData() ? request.postDataJSON() : undefined;
    if (request.method() !== "GET") writes.push({ method: request.method(), url: url.pathname + url.search, body });
    if (url.pathname.endsWith("/lookup")) {
      const { program, number } = body as { program: string; number: string };
      if (program === "Challenge" || program === "Explore") {
        if (number === "500") return route.fulfill({ json: { status: "unavailable", reason: "provider-error" } });
        return route.fulfill({ json: number === "321" ? { status: "found", team: { program, number, name: "Test Team Alpha", location: "Testville, PA", season: 2025, source: "first-search" } } : { status: "not-found" } });
      }
      if (!state.programs[program as "FRC" | "FTC"].saved) return route.fulfill({ json: { status: "unavailable", reason: "not-configured" } });
      return route.fulfill({ json: number === "321" ? { status: "found", team: { program, number, name: "Test Robotics A", location: "Testville, PA", season: 2026, source: "events-api" } } : { status: "not-found" } });
    }
    if (request.method() === "PUT") {
      const { program, username, token } = body as { program: "FRC" | "FTC"; username: string; token: string };
      if (token !== "synthetic-token") return route.fulfill({ status: 400, json: { error: `FIRST did not accept this ${program} username and token. Check both and save again.` } });
      state.programs[program] = { saved: true, username, checkedAt: "2026-10-31T16:00:00.000Z", readable: true };
    }
    if (request.method() === "DELETE") state.programs[url.searchParams.get("program") as "FRC" | "FTC"] = unset;
    await route.fulfill({ json: state });
  });
  return writes;
}
const card = (page: Page) => page.locator(".first-integration");
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const viewport of dashboardConformanceReferences.viewports) {
  test(`an Admin saves an FRC credential and tests teams at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    if (viewport.width < 768) { await page.emulateMedia({ colorScheme: "dark" }); await page.addInitScript(() => localStorage.setItem("lancerlogin-theme", "dark")); }
    const writes = await useFirst(page);
    await page.goto("/settings/integrations");
    const first = card(page);
    await expect(first.getByRole("heading", { name: "FIRST", exact: true })).toBeVisible();
    await expect(first.locator(".first-integration-heading .status-pill")).toHaveText("Not connected");
    await expect(first.locator(".first-integration-intro")).toHaveText("Looks up FIRST teams by number for any module that needs it. Only the team number is sent to FIRST. Get a username and token from FIRST's FRC Events API registration (opens in a new tab) and FTC Events API registration (opens in a new tab).");
    await expect(first.getByRole("link", { name: /^FRC/ })).toHaveAttribute("href", "https://frc-events.firstinspires.org/services/API");
    await expect(first.getByRole("link", { name: /^FTC/ })).toHaveAttribute("href", "https://ftc-events.firstinspires.org/services/API");
    // The FIRST card sits just before Discord in the integrations grid.
    await expect(page.locator(".integration-grid > .integration-card").nth(3)).toHaveClass(/first-integration/);
    await expect(page.locator(".integration-grid > .integration-card").nth(4)).toContainText("Discord bot");

    const frc = first.getByRole("form", { name: "FRC" });
    await expect(frc.locator(".status-pill")).toHaveText("Not set");
    const save = frc.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled(); await expect(save).toHaveClass(/ui-button--primary/);
    await expect(frc.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(first.getByRole("region", { name: "FLL" }).locator(".status-pill")).toHaveText("Available");
    await expect(first.getByRole("region", { name: "FLL" })).toContainText("Uses FIRST's public team search. No username or token needed.");

    await frc.getByLabel("Username").fill("test-frc-user");
    await frc.getByLabel("Token").fill("wrong-token");
    await save.click();
    await expect(frc.getByRole("alert")).toHaveText("FIRST did not accept this FRC username and token. Check both and save again.");
    await frc.getByLabel("Token").fill("synthetic-token");
    await save.click();
    await expect(frc.getByRole("status").filter({ hasText: "accepted" })).toHaveText("FIRST accepted the FRC username and token.");
    await expect(first.locator(".first-integration-heading .status-pill")).toHaveText("Connected for FRC");
    await expect(frc.locator(".status-pill")).toHaveText(/^Checked /);
    await expect(frc.getByLabel("Token")).toHaveValue(""); await expect(frc.getByLabel("Token")).toHaveAttribute("placeholder", "Saved, hidden");
    await expect(frc.getByLabel("Username")).toHaveValue("test-frc-user");
    await expect(frc.getByRole("button", { name: "Save", exact: true })).not.toHaveClass(/ui-button--primary/);
    await expect(frc.getByRole("button", { name: "Remove" })).toBeVisible();
    expect(writes.filter((write) => write.method === "PUT").map((write) => write.body)).toEqual([{ program: "FRC", username: "test-frc-user", token: "wrong-token" }, { program: "FRC", username: "test-frc-user", token: "synthetic-token" }]);

    const test = first.getByRole("form", { name: "Test a team" });
    const result = test.locator(".first-test-result");
    await test.getByLabel("Team number").fill("321");
    await test.getByRole("button", { name: "Look up" }).click();
    await expect(result).toHaveText("FRC 321: Test Robotics A, Testville, PA (2026 season)");
    await test.getByLabel("Team number").fill("99999");
    await test.getByRole("button", { name: "Look up" }).click();
    await expect(result).toHaveText("No FRC team 99999 found.");
    await test.getByLabel("Program").selectOption({ label: "FTC" });
    await test.getByRole("button", { name: "Look up" }).click();
    await expect(result).toHaveText("FTC lookups are off. Save an FTC username and token above.");
    await test.getByLabel("Program").selectOption({ label: "FLL Explore" });
    await test.getByRole("button", { name: "Look up" }).click();
    await expect(result).toHaveText("No FLL Explore team 99999 found.");
    await test.getByLabel("Program").selectOption({ label: "FLL Challenge" });
    await test.getByLabel("Team number").fill("321");
    await test.getByRole("button", { name: "Look up" }).click();
    await expect(result).toHaveText("FLL Challenge 321: Test Team Alpha, Testville, PA (2025 season)");
    await test.getByLabel("Team number").fill("500");
    await test.getByRole("button", { name: "Look up" }).click();
    await expect(result).toHaveText("FIRST's answer for FLL Challenge 500 could not be read. Try again later.");
    await test.getByLabel("Team number").fill("0abc");
    await test.getByRole("button", { name: "Look up" }).click();
    await expect(result).toHaveText("Enter a team number of 1 to 6 digits.");
    await test.getByRole("button", { name: "Clear cached answers" }).click();
    await expect(result).toHaveText("Cached answers cleared. The next lookups ask FIRST again.");
    expect(writes.filter((write) => write.url.endsWith("/lookup")).map((write) => write.body)).toEqual([{ program: "FRC", number: "321" }, { program: "FRC", number: "99999" }, { program: "FTC", number: "99999" }, { program: "Explore", number: "99999" }, { program: "Challenge", number: "321" }, { program: "Challenge", number: "500" }]);
    expect(await noSideScroll(page)).toBe(true);
  });
}

test("a credential that can't be read asks to be saved again, and Remove forgets it", async ({ page }) => {
  const writes = await useFirst(page, { FTC: { saved: true, username: "test-ftc-user", checkedAt: "2026-10-30T16:00:00.000Z", readable: false } });
  await page.goto("/settings/integrations");
  const ftc = card(page).getByRole("form", { name: "FTC" });
  await expect(ftc.locator(".status-pill")).toHaveText("Saved, but can't be read");
  await expect(ftc.getByRole("status")).toHaveText("Saved, but can't be read. Save it again.");
  await expect(card(page).locator(".first-integration-heading .status-pill")).toHaveText("Needs attention");
  await expect(ftc.getByLabel("Username")).toHaveValue("test-ftc-user");
  page.once("dialog", (dialog) => void dialog.accept());
  await ftc.getByRole("button", { name: "Remove" }).click();
  await expect(ftc.locator(".status-pill")).toHaveText("Not set");
  await expect(ftc.getByRole("status")).toHaveText("The FTC username and token are removed.");
  expect(writes).toEqual([{ method: "DELETE", url: "/admin/integrations/first?program=FTC", body: undefined }]);
});

test("typed credentials hold the page until they are saved", async ({ page }) => {
  await useFirst(page);
  await page.goto("/settings/integrations");
  const token = card(page).getByRole("form", { name: "FRC" }).getByLabel("Token");
  await token.click(); await token.fill("synthetic-token");
  const prompted = new Promise<string>((resolve) => page.once("dialog", (dialog) => { resolve(dialog.type()); void dialog.accept(); }));
  await page.close({ runBeforeUnload: true });
  expect(await prompted).toBe("beforeunload");
});

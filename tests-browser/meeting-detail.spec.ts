import { expect, test } from "@playwright/test";

test("canonical meeting routes, legacy redirects, switching, and browser history stay synchronized", async ({ page }) => {
  await page.goto("/dashboard");
  await page.locator('.calendar-day button[title^="Build session,"]').click();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.evaluate(() => {
    window.history.pushState({}, "", "/attendance?meetingId=active-meeting");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();

  await page.getByLabel("Switch meeting").selectOption("next-week");
  await expect(page).toHaveURL(/\/meetings\/next-week$/);
  await expect(page.getByRole("heading", { name: "Studio night" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/meetings\/active-meeting$/);
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();

  await page.goto("/attendance");
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/meetings/missing-meeting");
  await expect(page.getByRole("heading", { name: "Meeting unavailable" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Meeting not found" })).toBeVisible();
});

test("meeting detail presents lifecycle and operational context", async ({ page }) => {
  const now = Date.now();
  const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const meetings = [
    { id: "upcoming", title: "Upcoming meeting", startsAt: iso(10), endsAt: iso(70), attendanceClosesAt: iso(100), required: 0 },
    { id: "progress", title: "Current meeting", startsAt: iso(-10), endsAt: iso(20), attendanceClosesAt: iso(50), required: 1, notes: "Use the east entrance.", recurrenceFrequency: "biweekly", recurrenceSequence: 3, recurrenceUntil: iso(30 * 24 * 60) },
    { id: "late", title: "Late meeting", startsAt: iso(-70), endsAt: iso(-10), attendanceClosesAt: iso(20), required: 1 },
    { id: "past", title: "Past meeting", startsAt: iso(-100), endsAt: iso(-60), attendanceClosesAt: iso(-30), required: 1 },
  ];
  await page.route("**/meetings", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meetings }) }));
  await page.route(/\/meetings\/[^/?]+$/, (route) => {
    if (route.request().resourceType() === "document") return route.continue();
    const id = decodeURIComponent(new URL(route.request().url()).pathname.slice("/meetings/".length));
    const meeting = meetings.find((item) => item.id === id);
    return route.fulfill({ status: meeting ? 200 : 404, contentType: "application/json", body: JSON.stringify(meeting ? { meeting } : { error: "Meeting not found" }) });
  });

  for (const [id, label] of [["upcoming", "Upcoming"], ["progress", "In progress"], ["late", "Late scan window"], ["past", "Past"]] as const) {
    await page.goto(`/meetings/${id}`);
    await expect(page.locator(".meeting-lifecycle")).toHaveText(label);
    await expect(page.getByRole("button", { name: "Sync Discord calendar" })).toBeEnabled({ enabled: id === "upcoming" || id === "progress" });
    await expect(page.getByRole("button", { name: "Send Discord absence notice" })).toBeEnabled({ enabled: id !== "upcoming" });
  }
  await page.goto("/meetings/progress");
  const summary = page.locator('[aria-label="Meeting summary"]');
  await expect(summary).toContainText("Required");
  await expect(summary).toContainText("Every two weeks · Occurrence 3");
  await expect(summary).toContainText("Use the east entrance.");
  await expect(summary).toContainText("Attendance closes");
});

test("meeting-local Discord actions and contest review retain their scoped outcomes", async ({ page }) => {
  const calendarBodies: unknown[] = [];
  const absenceBodies: unknown[] = [];
  const resolutionBodies: unknown[] = [];
  let contestLoads = 0;
  await page.route("**/discord/calendar", async (route) => { calendarBodies.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ synced: true, eventId: "event-1" }) }); });
  await page.route("**/discord/missing", async (route) => { absenceBodies.push(route.request().postDataJSON()); await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ posted: true, linkedMissingCount: 1, messageId: "message-1" }) }); });
  await page.route("**/discord/contests/resolve", async (route) => { resolutionBodies.push(route.request().postDataJSON()); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ resolved: true, attendanceChanged: true }) }); });
  await page.route(/\/discord\/contests(?:\?.*)?$/, async (route) => { contestLoads += 1; await route.continue(); });

  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("heading", { name: "Discord operations" })).toBeVisible();
  await page.getByRole("button", { name: "Sync Discord calendar" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Discord calendar updated for this meeting." })).toBeVisible();
  await page.getByRole("button", { name: "Send Discord absence notice" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Discord absence notice sent to 1 linked member." })).toBeVisible();
  expect(calendarBodies).toEqual([{ meetingId: "active-meeting" }]);
  expect(absenceBodies).toEqual([{ meetingId: "active-meeting" }]);

  const contest = page.locator(".meeting-contests .contest-review-list article").filter({ hasText: "Jordan Lee" });
  await contest.getByRole("button", { name: "Approve and mark present" }).click();
  await expect(contest.getByRole("alert")).toHaveText("A review reason is required before resolving this contest.");
  await contest.getByLabel("Review reason").fill("Kiosk error confirmed with the member.");
  const loadsBeforeResolution = contestLoads;
  await contest.getByRole("button", { name: "Approve and mark present" }).click();
  await expect(page.locator(".meeting-contests")).toContainText("No attendance contests need review for this meeting.");
  await expect.poll(() => contestLoads).toBeGreaterThan(loadsBeforeResolution);
  expect(resolutionBodies).toEqual([{ meetingId: "active-meeting", memberId: "member-3", resolution: "approved", reviewNote: "Kiosk error confirmed with the member." }]);
});

test("unverified Discord exposes no meeting actions or global contest notifier", async ({ page }) => {
  await page.route("**/integrations/capabilities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: true, configured: false } } }) }));
  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("heading", { name: "Discord operations" })).toHaveCount(0);
  await expect(page.locator(".meeting-contests")).toHaveCount(0);
  await expect(page.locator(".contest-indicator")).toHaveCount(0);
});

test("meeting operations preserve the custom brand in light and dark desktop layouts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/meetings/active-meeting");
  const app = page.locator(".app");
  const theme = page.getByRole("switch", { name: "Dark mode" });
  await expect(theme).toHaveAttribute("aria-checked", "true");
  const tokens = await app.evaluate((element) => { const style = getComputedStyle(element); return { primary: style.getPropertyValue("--primary").trim(), secondary: style.getPropertyValue("--secondary").trim() }; });
  expect(tokens).toEqual({ primary: "#8b2f72", secondary: "#e9b949" });
  const operations = await page.locator(".meeting-discord-operations").boundingBox();
  const contests = await page.locator(".meeting-contests").boundingBox();
  expect(operations && contests && operations.x < contests.x).toBe(true);
  await theme.click();
  await expect(theme).toHaveAttribute("aria-checked", "false");
  await expect(app).toHaveAttribute("data-theme", "light");
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("attendance refreshes manually and every 30 seconds only while its window is open", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  let activeRequests = 0;
  let pastRequests = 0;
  await page.route(/\/attendance\?meetingId=active-meeting$/, async (route) => { activeRequests += 1; await route.continue(); });
  await page.route(/\/attendance\?meetingId=past-regular$/, async (route) => { pastRequests += 1; await route.continue(); });

  await page.goto("/meetings/active-meeting");
  await expect.poll(() => activeRequests).toBe(1);
  await page.clock.fastForward(30_000);
  await expect.poll(() => activeRequests).toBe(2);
  await page.getByRole("button", { name: "Refresh attendance" }).click();
  await expect.poll(() => activeRequests).toBe(3);
  await expect(page.getByRole("status").filter({ hasText: "Attendance refreshed." })).toBeVisible();

  await page.getByLabel("Switch meeting").selectOption("past-regular");
  await expect.poll(() => pastRequests).toBe(1);
  await page.clock.fastForward(60_000);
  expect(pastRequests).toBe(1);
});

test("meeting attendance preserves member-local corrections and Admin-only clear", async ({ page }) => {
  const corrections: Record<string, unknown>[] = [];
  let cleanup: Record<string, unknown> | undefined;
  await page.route("**/attendance/corrections", async (route) => { corrections.push(route.request().postDataJSON()); await route.fulfill({ status: 201, contentType: "application/json", body: "{}" }); });
  await page.route("**/attendance/cleanup", async (route) => { cleanup = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cleared: 1 }) }); });

  await page.goto("/meetings/active-meeting");
  const avery = page.locator(".attendance-row").filter({ hasText: "Avery Stone" });
  page.once("dialog", (dialog) => dialog.accept(""));
  await avery.getByRole("button", { name: "Present" }).click();
  await expect(avery.getByRole("status")).toHaveText("Marked present.");
  page.once("dialog", (dialog) => dialog.accept(""));
  await avery.getByRole("button", { name: "Excuse" }).click();
  await expect(avery.getByRole("status")).toHaveText("A reason is required for this change.");
  page.once("dialog", (dialog) => dialog.accept("Medical appointment"));
  await avery.getByRole("button", { name: "Excuse" }).click();
  await expect(avery.getByRole("status")).toHaveText("Marked excused.");
  page.once("dialog", (dialog) => dialog.accept("No contact"));
  await avery.getByRole("button", { name: "Absent" }).click();
  await expect(avery.getByRole("status")).toHaveText("Marked absent.");
  expect(corrections).toEqual([
    { memberId: "member-1", meetingId: "active-meeting", disposition: "present", reason: "" },
    { memberId: "member-1", meetingId: "active-meeting", disposition: "excused", reason: "Medical appointment" },
    { memberId: "member-1", meetingId: "active-meeting", disposition: "absent", reason: "No contact" },
  ]);
  page.once("dialog", (dialog) => dialog.accept());
  await avery.getByRole("button", { name: "Clear" }).click();
  await expect(avery.getByRole("status")).toHaveText("Attendance records cleared.");
  expect(cleanup).toEqual({ memberId: "member-1", meetingId: "active-meeting", confirmation: "CLEAR ATTENDANCE" });

  await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { role: "operator" } }) }));
  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Present" }).first()).toBeVisible();
});

test("meeting detail remains operable and contained at a compact mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  for (const control of await page.locator(".meeting-detail-workspace button, .meeting-detail-workspace select").all()) {
    const bounds = await control.boundingBox();
    if (bounds) expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
});

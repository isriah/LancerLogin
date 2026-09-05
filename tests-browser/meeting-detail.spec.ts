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
    { id: "progress", title: "Current meeting", startsAt: iso(-10), endsAt: iso(20), attendanceClosesAt: iso(50), required: 1, notes: "Use the east entrance.", recurrenceFrequency: "biweekly", recurrenceSequence: 3, recurrenceUntil: iso(30 * 24 * 60), weightCategoryId: "extended", weightCategoryName: "Extended", attendanceWeight: 2 },
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
  await expect(summary).toContainText("Extended · 2×");
});

test("detail dialogs manage occurrence and future-series scope, return focus, and carry deletion Undo to Dashboard", async ({ page }) => {
  const submitted: { url: string; method: string; body: Record<string, unknown> }[] = [];
  await page.route("**/meeting-weight-categories", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [{ id: "extended", name: "Extended", weight: 2, minimumDurationMinutes: 60, position: 0, active: true }] }) }));
  await page.route(/\/(meeting-series\/weekly-build|meetings\/active-meeting(?:\/restore)?|meetings)$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.continue();
    submitted.push({ url: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() });
    if (request.method() === "POST" && new URL(request.url()).pathname === "/meetings") return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ meetings: [{ id: "duplicate-1" }] }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.goto("/meetings/active-meeting");
  const editButton = page.getByRole("button", { name: "Edit" });
  await editButton.click();
  let dialog = page.getByRole("dialog", { name: "Edit meeting" });
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await dialog.getByRole("radio", { name: "This and future occurrences" }).check();
  await dialog.getByLabel("Title", { exact: true }).fill("Build session shifted");
  await dialog.getByLabel("Attendance weight").selectOption("extended");
  await dialog.getByRole("button", { name: "Save meeting" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editButton).toBeFocused();

  const duplicateButton = page.getByRole("button", { name: "Duplicate" });
  await duplicateButton.click();
  dialog = page.getByRole("dialog", { name: "Duplicate meeting" });
  await expect(dialog.getByLabel("Title", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("Frequency")).toHaveValue("weekly");
  await dialog.getByLabel("Title", { exact: true }).fill("Build session copy");
  await dialog.getByRole("button", { name: "Duplicate recurring series" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(duplicateButton).toBeFocused();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Delete meeting" });
  await expect(dialog.getByRole("button", { name: "Delete this and future meetings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete meeting" }).getByRole("button", { name: "Delete this and future meetings" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("status").filter({ hasText: "This and future series occurrences were deleted." })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "This and future series occurrences were restored." })).toBeVisible();

  expect(submitted).toEqual([
    expect.objectContaining({ url: "/meeting-series/weekly-build", method: "PATCH", body: expect.objectContaining({ meetingId: "active-meeting", title: "Build session shifted", weightCategoryId: "extended" }) }),
    expect.objectContaining({ url: "/meetings", method: "POST", body: expect.objectContaining({ title: "Build session copy", recurrence: expect.objectContaining({ frequency: "weekly" }) }) }),
    { url: "/meetings/active-meeting", method: "DELETE", body: { scope: "future" } },
    { url: "/meetings/active-meeting/restore", method: "POST", body: { scope: "future" } },
  ]);
});

test("editing meeting details without changing weight preserves the saved snapshot", async ({ page }) => {
  const now = Date.now(); let submitted: Record<string, unknown> | undefined;
  const meeting = { id: "active-meeting", title: "Saved weight meeting", startsAt: new Date(now - 30 * 60_000).toISOString(), endsAt: new Date(now + 60 * 60_000).toISOString(), attendanceClosesAt: new Date(now + 90 * 60_000).toISOString(), required: 1, weightCategoryId: "extended", weightCategoryName: "Extended when saved", attendanceWeight: 2 };
  await page.route("**/meeting-weight-categories", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [{ id: "extended", name: "Extended now", weight: 3, minimumDurationMinutes: 60, position: 0, active: true }] }) }));
  await page.route(/\/meetings\/active-meeting$/, async (route) => {
    if (route.request().resourceType() === "document") return route.continue();
    if (route.request().method() === "PATCH") { submitted = route.request().postDataJSON() as Record<string, unknown>; return route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meeting }) });
  });
  await page.goto("/meetings/active-meeting");
  await page.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit meeting" });
  await expect(dialog.getByLabel("Attendance weight")).toHaveValue("extended");
  await dialog.getByLabel("Title", { exact: true }).fill("Title only change");
  await dialog.getByRole("button", { name: "Save meeting" }).click();
  expect(submitted).toMatchObject({ title: "Title only change" });
  expect(submitted).not.toHaveProperty("weightCategoryId");
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
  await expect(contest.getByText("3", { exact: true })).toBeVisible();
  await expect(contest.getByText("Partial — checked in, no check-out")).toBeVisible();
  await contest.getByRole("button", { name: "Approve and mark present" }).click();
  await expect(contest.getByRole("alert")).toHaveText("A review reason is required before resolving this contest.");
  await contest.getByLabel("Review reason").fill("Kiosk error confirmed with the member.");
  const loadsBeforeResolution = contestLoads;
  await contest.getByRole("button", { name: "Approve and mark present" }).click();
  await expect(page.locator(".meeting-contests")).toContainText("No attendance contests need review for this meeting.");
  await expect.poll(() => contestLoads).toBeGreaterThan(loadsBeforeResolution);
  expect(resolutionBodies).toEqual([{ meetingId: "active-meeting", memberId: "member-3", resolution: "approved", reviewNote: "Kiosk error confirmed with the member." }]);
});

test("meeting contest review distinguishes partial, missing, and complete raw scans responsively", async ({ page }) => {
  const contests = [
    { meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "member-1", externalId: "A-101", firstName: "Avery", lastName: "Stone", status: "open", createdAt: "2026-09-03T20:05:00Z", lifetimeContestCount: 4, hasPartialScan: true, rawScanStatus: "partial" },
    { meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "member-2", externalId: "A-102", firstName: "Morgan", lastName: "Diaz", status: "open", createdAt: "2026-09-03T20:06:00Z", lifetimeContestCount: 2, hasPartialScan: false, rawScanStatus: "none" },
    { meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: "2026-09-03T20:00:00Z", memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", status: "open", createdAt: "2026-09-03T20:07:00Z", lifetimeContestCount: 1, hasPartialScan: false, rawScanStatus: "complete" },
  ];
  await page.route(/\/discord\/contests(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contests }) }));

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/meetings/active-meeting");
    const review = page.locator(".meeting-contests");
    for (const [name, count, scan] of [["Avery Stone", "4", "Partial — checked in, no check-out"], ["Morgan Diaz", "2", "No scans"], ["Jordan Lee", "1", "Complete — checked in and out"]] as const) {
      const contest = review.locator("article").filter({ hasText: name });
      await expect(contest.getByText(count, { exact: true })).toBeVisible();
      await expect(contest.getByText(scan, { exact: true })).toBeVisible();
    }
    const widths = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
    const firstReason = review.getByLabel("Review reason").first();
    await firstReason.focus();
    await expect(firstReason).toBeFocused();
    const theme = page.getByRole("switch", { name: "Dark mode" });
    if (!await theme.isChecked()) await theme.click();
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
    await theme.click();
    await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  }
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

test("meeting attendance shows authoritative scan times for complete, partial, missing, and corrected rows", async ({ page }) => {
  const attendance = [
    { memberId: "member-1", externalId: "A-101", firstName: "Avery", lastName: "Stone", disposition: "active", checkedInAt: "2026-09-03T20:05:00Z" },
    { memberId: "member-2", externalId: "A-102", firstName: "Morgan", lastName: "Diaz", disposition: "present", checkedInAt: "2026-09-03T20:02:00Z", checkedOutAt: "2026-09-03T21:01:00Z" },
    { memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", disposition: "absent" },
    { memberId: "member-4", externalId: "A-104", firstName: "Riley", lastName: "Chen", disposition: "excused", checkedInAt: "2026-09-03T20:07:00Z", checkedOutAt: "2026-09-03T20:48:00Z", reason: "Approved correction" },
  ];
  await page.route(/\/attendance\?meetingId=active-meeting$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ attendance }) }));

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.goto("/meetings/active-meeting");
      const themeSwitch = page.getByRole("switch", { name: "Dark mode" });
      if ((await themeSwitch.getAttribute("aria-checked")) !== String(theme === "dark")) await themeSwitch.click();
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);

      const table = page.getByRole("table", { name: "Meeting attendance" });
      const partial = table.getByRole("row").filter({ hasText: "Avery Stone" });
      const complete = table.getByRole("row").filter({ hasText: "Morgan Diaz" });
      const missing = table.getByRole("row").filter({ hasText: "Jordan Lee" });
      const corrected = table.getByRole("row").filter({ hasText: "Riley Chen" });
      await expect(partial.locator('time[datetime="2026-09-03T20:05:00Z"]')).toBeVisible();
      await expect(partial.getByText("Not recorded", { exact: true })).toBeVisible();
      await expect(complete.locator("time")).toHaveCount(2);
      await expect(missing.getByText("Not recorded", { exact: true })).toHaveCount(2);
      await expect(corrected.locator("time")).toHaveCount(2);
      await expect(corrected.locator(".attendance-state")).toHaveText("excused");
      for (const row of [partial, complete, missing, corrected]) {
        await expect(row.getByText("Check-in", { exact: true })).toBeVisible();
        await expect(row.getByText("Check-out", { exact: true })).toBeVisible();
      }

      await partial.getByRole("button", { name: "Present" }).focus();
      await expect(partial.getByRole("button", { name: "Present" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(partial.getByRole("button", { name: "Excuse" })).toBeFocused();
      const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    }
  }
});

test("meeting detail remains operable and contained at a compact mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/meetings/active-meeting");
  await expect(page.getByRole("heading", { name: "Build session" })).toBeVisible();
  await page.getByRole("switch", { name: "Dark mode" }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Duplicate" }).click();
  const dialog = page.getByRole("dialog", { name: "Duplicate meeting" });
  await expect(dialog).toBeVisible();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  for (const control of await dialog.locator('button, input:not([type="checkbox"]):not([type="radio"]), select, textarea, .inline-options label').all()) {
    const bounds = await control.boundingBox();
    if (bounds) expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Duplicate" })).toBeFocused();
});

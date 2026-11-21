import { expect, test, type Page } from "@playwright/test";
import { attendanceSetupState, attendanceSnapshot, type AttendanceSetupState } from "./module-fixtures";
import { pairedViews } from "./paired-views";

test.use({ timezoneId: "UTC" });

type SetupFixture = {
  meetings: Array<{ id: string; title: string; startsAt: string; endsAt: string }>;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  revoke(): void;
  rejectMeeting(): void;
};

async function attendanceSetup(page: Page, existingMeeting = false): Promise<SetupFixture> {
  let enabled = true;
  let snapshotReady = false;
  let rejectMeeting = false;
  const meetings = existingMeeting
    ? [{ id: "old-meeting", title: "Unsuitable old meeting", startsAt: "2026-09-27T10:00:00.000Z", endsAt: "2026-09-27T11:00:00.000Z" }]
    : [];
  const requests: SetupFixture["requests"] = [];
  const outcomes: Record<string, "completed" | "skipped"> = { rules: "completed" };
  const valid = new Set(["rules"]);
  let state: AttendanceSetupState = attendanceSetupState(outcomes, [...valid]);

  await page.route("**/platform/modules", (route) =>
    route.fulfill({ json: attendanceSnapshot({ enabled, setupReady: snapshotReady }) }),
  );
  await page.route("**/admin/modules/attendance/setup", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        stepId: string;
        outcome: "completed" | "skipped";
      };
      outcomes[body.stepId] = body.outcome;
      if (body.stepId === "meeting" && meetings.length) valid.add("meeting");
      // A web kiosk paired earlier has checked in, so the server accepts Verified attendance input.
      if (body.stepId === "input") valid.add("input");
      state = attendanceSetupState(outcomes, [...valid]);
      if (body.stepId === "discord") snapshotReady = true;
    }
    await route.fulfill({ json: state });
  });
  await page.route("**/module-setup/attendance/meeting", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { meetings, timeZone: "UTC" } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push({ path: "meeting", body });
    if (rejectMeeting) {
      return route.fulfill({
        status: 409,
        json: { error: "Meeting attendance windows overlap; choose another time and retry" },
      });
    }
    const meeting = {
      id: `meeting-${meetings.length + 1}`,
      title: String(body.title),
      startsAt: String(body.startsAt),
      endsAt: String(body.endsAt),
    };
    meetings.unshift(meeting);
    await route.fulfill({ status: 201, json: { id: meeting.id } });
  });
  await page.route("**/module-setup/attendance/input", async (route) => {
    requests.push({ path: `input:${route.request().method()}`, body: {} });
    await route.fulfill({ json: { kiosks: [{ id: "kiosk-1", name: "Test web kiosk A", kind: "web", lastSeenAt: "2026-10-25T00:00:00.000Z" }] } });
  });
  await page.goto("/dashboard");
  return {
    meetings,
    requests,
    revoke: () => {
      enabled = false;
    },
    rejectMeeting: () => {
      rejectMeeting = true;
    },
  };
}

// The preview roster already has active members, so the Roster card is complete and only needs Continue.
async function continuePastRoster(page: Page) {
  await expect(page.getByRole("heading", { level: 2, name: "Roster" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

async function finishOptionalSteps(page: Page) {
  await expect(page.getByRole("heading", { level: 2, name: "Calendar integration" })).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Discord integration" })).toBeVisible();
  await page.getByRole("button", { name: "Set up later and continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Attendance is ready" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Meetings" }).click();
}

for (const { viewport, theme } of pairedViews) {
    test(`empty Attendance setup creates a same-day meeting and verifies a paired kiosk at ${viewport.width} in ${theme}`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date(viewport.width === 390 ? "2026-10-25T00:02:00.000Z" : "2026-10-25T23:59:59.900Z"));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await page.addInitScript((savedTheme) => localStorage.setItem("lancerlogin-theme", savedTheme), theme);
      const fixture = await attendanceSetup(page);
      await expect(page.getByRole("heading", { level: 2, name: "First meeting" })).toBeVisible();
      const starts = page.getByLabel("Starts");
      const ends = page.getByLabel("Ends");
      expect((await starts.inputValue()).slice(0, 10)).toBe((await ends.inputValue()).slice(0, 10));
      await page.getByLabel("Meeting title").fill("Synthetic attendance rehearsal");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await continuePastRoster(page);
      await expect(page.getByRole("heading", { level: 2, name: "Verified attendance input" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Paired kiosks" })).toContainText("Test web kiosk A (web kiosk) - checked in");
      await page.getByRole("button", { name: "Save and continue" }).click();
      await finishOptionalSteps(page);
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
      const meeting = fixture.requests.find((item) => item.path === "meeting")!.body;
      expect(String(meeting.startsAt).slice(0, 10)).toBe(String(meeting.endsAt).slice(0, 10));
      const now = await page.evaluate(() => Date.now());
      expect(Date.parse(String(meeting.startsAt))).toBeLessThanOrEqual(now);
      expect(Date.parse(String(meeting.endsAt))).toBeGreaterThanOrEqual(now);
      // Setup only reads the paired kiosks; it records no check-in of its own.
      expect(new Set(fixture.requests.filter((item) => item.path.startsWith("input:")).map((item) => item.path))).toEqual(new Set(["input:GET"]));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
    });
  }

test("meeting validation preserves the Attendance setup draft for correction", async ({ page }) => {
  const fixture = await attendanceSetup(page);
  fixture.rejectMeeting();
  await page.getByLabel("Meeting title").fill("My corrected meeting draft");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("overlap");
  await expect(page.getByLabel("Meeting title")).toHaveValue("My corrected meeting draft");
  await expect(page.getByRole("heading", { level: 2, name: "First meeting" })).toBeVisible();
});

test("an unsuitable first meeting can be replaced with a current same-day meeting", async ({ page }) => {
  const fixture = await attendanceSetup(page, true);
  await expect(page.getByText("Unsuitable old meeting")).toBeVisible();
  await page.getByLabel("Create a different meeting before continuing").check();
  await page.getByLabel("Meeting title").fill("Current replacement meeting");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await continuePastRoster(page);
  await expect(page.getByRole("heading", { level: 2, name: "Verified attendance input" })).toBeVisible();
  expect(fixture.meetings[0]?.title).toBe("Current replacement meeting");
});

test("harmless module refresh preserves a draft and revocation removes it immediately", async ({ page }) => {
  const fixture = await attendanceSetup(page);
  const title = page.getByLabel("Meeting title");
  await title.fill("Preserve this draft");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(title).toHaveValue("Preserve this draft");
  fixture.revoke();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { level: 1, name: "Attendance setup" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByLabel("Meeting title")).toHaveCount(0);
});


test.describe("organization day differs from browser day", () => {
  test.use({ timezoneId: "Asia/Tokyo" });
  test("first meeting defaults honor the organization date while displaying browser-local inputs", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-25T23:59:59.900Z"));
    const fixture = await attendanceSetup(page);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await continuePastRoster(page);
    await expect(page.getByRole("heading", { level: 2, name: "Verified attendance input" })).toBeVisible();
    const meeting = fixture.requests.find(item => item.path === "meeting")!.body;
    expect(meeting.startsAt).toBe("2026-10-25T23:54:00.000Z");
    expect(meeting.endsAt).toBe("2026-10-25T23:59:59.999Z");
  });
});


test.describe("browser clock repeats an hour", () => {
  test.use({ timezoneId: "America/New_York" });
  test("unchanged setup defaults retain their instants across the repeated hour", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-01T06:02:00.000Z"));
    const fixture = await attendanceSetup(page);
    await page.getByLabel("Meeting title").fill("Repeated-hour rehearsal");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await continuePastRoster(page);
    await expect(page.getByRole("heading", { level: 2, name: "Verified attendance input" })).toBeVisible();
    const meeting = fixture.requests.find(item => item.path === "meeting")!.body;
    expect(meeting.startsAt).toBe("2026-11-01T05:57:00.000Z");
    expect(meeting.endsAt).toBe("2026-11-01T06:57:00.000Z");
  });
});

// A datetime-local field's segments and picker button live inside the input, so the page's active element is the input
// for all of them. The accessibility tree names the one that has focus.
async function focusedPart(page: Page) {
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send("Accessibility.getFullAXTree"); await client.detach();
  const focused = nodes.filter((node) => node.properties?.some((property) => property.name === "focused" && property.value.value === true)).at(-1);
  const part = /Month|Day|Year|Hours|Minutes|AM\/PM|Show .*picker/.exec(String(focused?.name?.value ?? ""))?.[0] ?? String(focused?.role?.value ?? "none");
  const field = await page.evaluate(() => document.activeElement?.closest("label")?.firstChild?.textContent?.trim() ?? document.activeElement?.tagName ?? "");
  return `${field}: ${part}`;
}

test("Tab after a digit that completes a segment of the meeting's Starts and Ends stays on the segment typing moved to", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-25T12:00:00.000Z"));
  const fixture = await attendanceSetup(page);
  await expect(page.getByRole("heading", { level: 2, name: "First meeting" })).toBeVisible();
  const press = async (key: string, expected: string) => { await page.keyboard.press(key); expect(await focusedPart(page), `after ${key}`).toBe(expected); };
  await page.getByLabel("Meeting title").fill("Synthetic tab order meeting");
  // 0 completes the month (after 1), 5 the day (after 2) and 9 the hour, so the field has moved on when each Tab arrives;
  // the year waits for more digits, so Tab moves on from it.
  await press("Tab", "Starts: Month"); await press("1", "Starts: Month"); await press("0", "Starts: Day"); await press("Tab", "Starts: Day");
  await press("2", "Starts: Day"); await press("5", "Starts: Year"); await press("Tab", "Starts: Year"); await press("Tab", "Starts: Hours");
  await press("9", "Starts: Minutes"); await press("Tab", "Starts: Minutes"); await press("3", "Starts: Minutes"); await press("0", "Starts: AM/PM"); await press("Tab", "Starts: AM/PM");
  await press("a", "Starts: AM/PM");
  await expect(page.getByLabel("Starts")).toHaveValue("2026-10-25T09:30");
  await press("Tab", "Starts: Show local date and time picker"); await press("Tab", "Ends: Month");
  // 2 to 9 complete a month and 4 to 9 a day on their own.
  await press("9", "Ends: Day"); await press("Tab", "Ends: Day"); await press("4", "Ends: Year"); await press("Tab", "Ends: Year"); await press("Tab", "Ends: Hours");
  await press("1", "Ends: Hours"); await press("1", "Ends: Minutes"); await press("Tab", "Ends: Minutes"); await press("1", "Ends: Minutes"); await press("5", "Ends: AM/PM"); await press("Tab", "Ends: AM/PM");
  await press("a", "Ends: AM/PM");
  await expect(page.getByLabel("Ends")).toHaveValue("2026-09-04T11:15");
  // A digit that leaves its segment open, and Shift+Tab, keep the browser's own order.
  await press("Shift+Tab", "Ends: Minutes"); await press("Shift+Tab", "Ends: Hours"); await press("Shift+Tab", "Ends: Year"); await press("Shift+Tab", "Ends: Day"); await press("Shift+Tab", "Ends: Month");
  await press("1", "Ends: Month"); await press("Tab", "Ends: Day"); await press("2", "Ends: Day"); await press("Tab", "Ends: Year");
  await expect(page.getByLabel("Ends")).toHaveValue("2026-01-02T11:15");
  await press("Shift+Tab", "Ends: Day"); await press("Shift+Tab", "Ends: Month"); await press("1", "Ends: Month"); await press("0", "Ends: Day"); await press("Tab", "Ends: Day"); await press("2", "Ends: Day"); await press("5", "Ends: Year");
  await expect(page.getByLabel("Ends")).toHaveValue("2026-10-25T11:15");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect.poll(() => fixture.requests.filter((item) => item.path === "meeting").length).toBe(1);
  expect(fixture.requests.find((item) => item.path === "meeting")!.body).toMatchObject({ title: "Synthetic tab order meeting", startsAt: "2026-10-25T09:30:00.000Z", endsAt: "2026-10-25T11:15:00.000Z" });
});

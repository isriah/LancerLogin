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
      if (body.stepId === "input" && requests.some((item) => item.path === "input:scan")) valid.add("input");
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
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          simulator: null,
          members: [{ id: "TRANS001", label: "Rehearsal One" }],
          meetings,
        },
      });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push({ path: `input:${String(body.action)}`, body });
    await route.fulfill({
      status: body.action === "scan" ? 202 : 200,
      json: { accepted: true, action: "check_in" },
    });
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
    test(`empty Attendance setup creates a same-day meeting and verifies browser input at ${viewport.width} in ${theme}`, async ({
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
      await expect(page.getByText("It does not test or store fingerprint data.")).toBeVisible();
      await page.getByRole("button", { name: "Save and continue" }).click();
      await finishOptionalSteps(page);
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard", exact: true })).toBeVisible();
      const meeting = fixture.requests.find((item) => item.path === "meeting")!.body;
      expect(String(meeting.startsAt).slice(0, 10)).toBe(String(meeting.endsAt).slice(0, 10));
      const now = await page.evaluate(() => Date.now());
      expect(Date.parse(String(meeting.startsAt))).toBeLessThanOrEqual(now);
      expect(Date.parse(String(meeting.endsAt))).toBeGreaterThanOrEqual(now);
      expect(fixture.requests.filter((item) => item.path.startsWith("input:")).map((item) => item.path)).toEqual([
        "input:start",
        "input:scan",
      ]);
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

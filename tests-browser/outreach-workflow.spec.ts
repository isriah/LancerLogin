import { expect, test, type Locator, type Page } from "@playwright/test";
import { attendanceSnapshot, outreachSetupState, outreachSnapshot, type OutreachSetupState } from "./module-fixtures";

type WorkspaceState = { activities: Record<string, unknown>[]; entries: Record<string, unknown>[]; countedMinutes: number; labels?: Record<string, unknown>[]; windows?: Record<string, unknown>[]; corrections?: Record<string, unknown>[]; publications?: Record<string, unknown>[] };

async function chooseClock(page: Page, label: string, hour: number) {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click(); const dialog = page.getByRole("dialog", { name: label });
  await dialog.getByRole("button", { name: `${hour} o'clock` }).click(); await dialog.getByRole("button", { name: "0 minutes", exact: true }).click(); await dialog.getByRole("group", { name: "Choose AM or PM" }).getByRole("button", { name: "AM", exact: true }).click();
}

async function controlAppearance(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
    return { background: style.backgroundColor, borderColor: style.borderTopColor, borderStyle: style.borderTopStyle, borderRadius: style.borderRadius, color: style.color, cursor: style.cursor, fontFamily: style.fontFamily, height: bounds.height, opacity: style.opacity, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
}

async function resolvedThemeColor(page: Page, token: string) {
  return page.locator(".app").evaluate((app, variable) => {
    const probe = document.createElement("span"); probe.style.color = `var(${variable})`; app.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  }, token);
}

async function expectPrimaryControl(page: Page, control: Locator) {
  const appearance = await controlAppearance(control);
  expect(appearance.background).toBe(await resolvedThemeColor(page, "--primary"));
  expect(appearance.borderColor).toBe(await resolvedThemeColor(page, "--primary"));
  expect(appearance.color).toBe(await resolvedThemeColor(page, "--on-primary"));
  expect(appearance.borderStyle).toBe("solid");
  expect(appearance.height).toBeGreaterThanOrEqual(44);
}

async function expectSurfaceControl(page: Page, control: Locator, textToken = "--ui-text") {
  const appearance = await controlAppearance(control);
  expect(appearance.background).toBe(await resolvedThemeColor(page, "--ui-surface-subtle"));
  expect(appearance.borderColor).toBe(await resolvedThemeColor(page, "--ui-border"));
  expect(appearance.color).toBe(await resolvedThemeColor(page, textToken));
  expect(appearance.borderStyle).toBe("solid");
  expect(appearance.height).toBeGreaterThanOrEqual(44);
}

async function expectFocusedControl(page: Page, control: Locator) {
  await expect(control).toBeFocused();
  const appearance = await controlAppearance(control);
  expect(appearance.borderColor).toBe(await resolvedThemeColor(page, "--primary"));
  expect(appearance.outlineStyle).toBe("solid");
}

async function expectInlineViewIcons(page: Page) {
  const layouts = await page.locator(".meeting-view-toggle label").evaluateAll((labels) => labels.map((label) => {
    const icon = label.querySelector(".meeting-view-icon")!.getBoundingClientRect();
    const text = label.querySelector(".meeting-view-label")!.getBoundingClientRect();
    return { gap: text.left - icon.right, centerDifference: Math.abs(text.top + text.height / 2 - (icon.top + icon.height / 2)) };
  }));
  expect(layouts).toHaveLength(2);
  for (const layout of layouts) {
    expect(layout.gap).toBeGreaterThan(0);
    expect(layout.centerDifference).toBeLessThanOrEqual(1);
  }
}

async function routeWorkspaceReads(page: Page, state: WorkspaceState) {
  await page.clock.install({ time: new Date("2026-09-28T18:00:00Z") });
  await page.route("**/module-setup/hour-tracking/rules", route => route.fulfill({ json: { values: { reportingDays: 30, reopenHours: 24, revision: 0 } } }));
  const teams: Record<string, unknown>[] = [{ id: "team-901", name: "Robotics Team 901", number: "901", program: "FIRST", archived: false, revision: 0, participantCount: state.entries.length, countedMinutes: state.countedMinutes }];
  const members = [{ id: "member-1", label: "Avery Member", externalId: "M-001", active: true }];
  const labels = state.labels ?? (state.labels = []); const windows = state.windows ?? (state.windows = []); const corrections = state.corrections ?? (state.corrections = []); const publications = state.publications ?? (state.publications = []);
  await page.route(/\/admin\/hours\/labels(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const method = route.request().method(); const path = new URL(route.request().url()).pathname;
    if (method === "POST") { const body = route.request().postDataJSON() as Record<string, unknown>; const created = { id: `label-${labels.length + 1}`, name: body.name, archived: false, revision: 0 }; labels.push(created); return route.fulfill({ status: 201, json: created }); }
    if (method === "PATCH") { const id = path.split("/").at(-1); const index = labels.findIndex((item) => item.id === id); const body = route.request().postDataJSON() as Record<string, unknown>; labels[index] = { ...labels[index], ...body, revision: Number(labels[index]?.revision ?? 0) + 1 }; return route.fulfill({ json: labels[index] }); }
    return route.fulfill({ json: { items: labels, nextCursor: null } });
  });
  await page.route(/\/admin\/hours\/teams(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const method = route.request().method(); const path = new URL(route.request().url()).pathname;
    if (method === "POST") { const body = route.request().postDataJSON() as Record<string, unknown>; const created = { id: `team-${teams.length + 1}`, ...body, revision: 0, participantCount: 0, countedMinutes: 0 }; teams.push(created); return route.fulfill({ status: 201, json: created }); }
    if (method === "PATCH") { const id = path.split("/").at(-1); const index = teams.findIndex((item) => item.id === id); const body = route.request().postDataJSON() as Record<string, unknown>; teams[index] = { ...teams[index], ...body, revision: Number(teams[index]?.revision ?? 0) + 1 }; return route.fulfill({ json: teams[index] }); }
    return route.fulfill({ json: { items: teams, nextCursor: null } });
  });
  await page.route(/\/admin\/hours\/activities(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const method = route.request().method(); const path = new URL(route.request().url()).pathname;
    if (method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const labelIds = body.labelIds as string[]; const created = { id: "activity-1", revision: 0, ...body, labels: labels.filter((label) => labelIds.includes(String(label.id))) };
      state.activities.push(created);
      return route.fulfill({ json: created });
    }
    if (method === "PATCH") { const id = path.split("/").at(-1); const index = state.activities.findIndex((item) => item.id === id); const body = route.request().postDataJSON() as Record<string, unknown>; const existingLabelIds = state.activities[index]?.labelIds; const labelIds = Array.isArray(body.labelIds) ? body.labelIds as string[] : Array.isArray(existingLabelIds) ? existingLabelIds as string[] : []; state.activities[index] = { ...state.activities[index], ...body, labelIds, labels: labels.filter((label) => labelIds.includes(String(label.id))), revision: Number(state.activities[index]?.revision ?? 0) + 1 }; return route.fulfill({ json: state.activities[index] }); }
    return route.fulfill({ json: { items: state.activities, nextCursor: null } });
  });
  await page.route(/\/admin\/hours\/member-choices(?:\?.*)?$/, (route) => route.fulfill({ json: { items: members, nextCursor: null } }));
  await page.route(/\/admin\/hours\/entries(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const activity = state.activities.find((item) => item.id === body.activityId)!;
      const created = { id: "entry-1", memberId: "member-1", activityId: activity.id, revision: 0, status: "counted", memberName: "Avery Member", externalId: "M-001", activityTitle: activity.title, teamName: null, serviceDate: activity.serviceDate, startLocal: body.startLocal, endLocal: body.endLocal, durationMinutes: 60, taskNotes: body.taskNotes, staffReason: body.staffReason, attribution: "staff_recorded" };
      state.entries.push(created); state.countedMinutes = 60;
      return route.fulfill({ json: created });
    }
    const activityId = new URL(route.request().url()).searchParams.get("activityId");
    return route.fulfill({ json: { items: activityId ? state.entries.filter((entry) => entry.activityId === activityId) : state.entries, nextCursor: null } });
  });
  await page.route(/\/admin\/hours\/reopen-windows(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const method = route.request().method(); const path = new URL(route.request().url()).pathname;
    if (method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>; const activity = state.activities.find((item) => item.id === body.activityId);
      const created = { id: `window-${windows.length + 1}`, activityId: body.activityId, activityTitle: activity?.title ?? null, activityServiceDate: activity?.serviceDate ?? null, startsMs: Date.parse("2026-09-28T18:00:00Z"), expiresMs: Date.parse("2026-09-29T18:00:00Z"), reason: body.reason, revoked: false, revision: 0, active: true };
      windows.push(created); return route.fulfill({ status: 201, json: created });
    }
    if (method === "PATCH") {
      const id = path.split("/").at(-1); const index = windows.findIndex((item) => item.id === id); windows[index] = { ...windows[index], revoked: true, active: false, revision: Number(windows[index]?.revision ?? 0) + 1 };
      return route.fulfill({ json: windows[index] });
    }
    return route.fulfill({ json: { items: windows, nextCursor: null } });
  });
  await page.route(/\/admin\/hours\/corrections(?:\/[^/?]+\/resolve)?(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const path = new URL(route.request().url()).pathname; const id = path.split("/").at(-2); const body = route.request().postDataJSON() as Record<string, unknown>; const index = corrections.findIndex((item) => item.id === id);
      corrections[index] = { ...corrections[index], status: "resolved", revision: 1, resolutionAction: body.action, resolutionNote: body.note };
      return route.fulfill({ json: { id, status: "resolved", revision: 1, action: body.action } });
    }
    return route.fulfill({ json: { items: corrections, nextCursor: null } });
  });
  await page.route("**/admin/hours/publication-providers", (route) => route.fulfill({ json: { google_calendar: true, discord: true } }));
  await page.route("**/admin/hours/publication-settings", async (route) => route.fulfill({ json: { automatic: false, revision: route.request().method() === "PATCH" ? 1 : 0 } }));
  await page.route("**/admin/hours/publications", (route) => route.fulfill({ json: { items: publications, nextCursor: null } }));
  await page.route(/\/admin\/hours\/activities\/[^/?]+\/publication(?:\/retry)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname; const activityId = path.split("/")[4]!; const index = publications.findIndex(item => item.activityId === activityId);
    if (route.request().method() === "GET") return route.fulfill({ json: index >= 0 ? publications[index] : null });
    const body = route.request().postDataJSON() as Record<string, unknown>; const activity = state.activities.find(item => item.id === activityId)!;
    if (path.endsWith("/retry")) { const key = body.provider === "discord" ? "discordStatus" : "googleStatus"; publications[index] = { ...publications[index], [key]: "pending", [body.provider === "discord" ? "discordAction" : "googleAction"]: "publish", revision: Number(publications[index]?.revision ?? 0) + 1 }; return route.fulfill({ status: 202, json: { activityId, revision: publications[index]?.revision } }); }
    const prefix = body.provider === "discord" ? "discord" : "google";
    const saved = { ...(index >= 0 ? publications[index] : {}), activityId, revision: index >= 0 ? Number(publications[index]?.revision ?? 0) + 1 : 0, [prefix === "google" ? "googleCalendar" : "discord"]: true, [`${prefix}Status`]: "pending", [`${prefix}Action`]: "publish", [`${prefix}Error`]: null, activityRevision: activity.revision, requestedActivityRevision: body.activityRevision, requestedPublicationRevision: body.publicationRevision };
    if (index >= 0) publications[index] = saved; else publications.push(saved); return route.fulfill({ status: 202, json: { activityId, revision: saved.revision } });
  });
  await page.route("**/admin/hours/context", (route) => route.fulfill({ json: { reportingDays: 30, reopenHours: 24, revision: 0, timeZone: "America/New_York", today: "2026-09-28" } }));
  await page.route("**/admin/hours/totals", (route) => route.fulfill({ json: { summary: { entries: state.entries.length, participants: state.entries.length, countedMinutes: state.countedMinutes }, members: state.entries.length ? [{ id: "member-1", name: "Avery Member", externalId: "M-001", entries: 1, countedMinutes: state.countedMinutes }] : [], teams: [{ id: "team-901", name: "Robotics Team 901", number: "901", program: "FIRST", participants: 0, entries: 0, countedMinutes: 0 }] } }));
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`Meetings and Outreach share the same operational browser geometry at ${viewport.width}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const attendance = attendanceSnapshot(); const outreach = outreachSnapshot();
  await page.route("**/platform/modules", (route) => route.fulfill({ json: { revision: 0, selectionCompleted: true, capabilities: [...new Set([...attendance.capabilities, ...outreach.capabilities])], modules: [attendance.modules[0], outreach.modules[1], outreach.modules[2]] } }));
  await page.route("**/auth/walkthroughs/*", (route) => { const pageId = new URL(route.request().url()).pathname.split("/").at(-1); return route.fulfill({ json: { progress: { pageId, version: 1, status: "completed", stepId: null } } }); });
  await page.route(/\/meetings(?:\?.*)?$/, (route) => route.fulfill({ json: { meetings: [{ id: "meeting-1", title: "Community planning", startsAt: "2026-09-28T13:00:00.000Z", endsAt: "2026-09-28T14:00:00.000Z", attendanceClosesAt: "2026-09-28T15:00:00.000Z", required: 1, notes: "", audienceMode: "all", audienceLabelIds: [] }] } }));
  await routeWorkspaceReads(page, { activities: [{ id: "activity-1", mode: "event", labelIds: [], labels: [], serviceDate: "2026-09-28", teamId: null, title: "Community planning", description: "", location: "", impactRelevant: true, archived: false, revision: 0, eventStartLocal: "09:00", eventEndLocal: "10:00", eventStartOccurrence: null, eventEndOccurrence: null }], entries: [], countedMinutes: 0 });
  const capture = () => page.evaluate(() => Object.fromEntries(Object.entries({ intro: ".operational-page-intro", controls: ".meeting-browser-controls", browser: ".dashboard-meeting-calendar", browserHeading: ".dashboard-meeting-calendar .calendar-heading" }).map(([key, selector]) => { const bounds = document.querySelector(selector)!.getBoundingClientRect(); return [key, { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height }]; })));
  const captureBox = (selector: string) => page.locator(selector).evaluate((element) => { const bounds = element.getBoundingClientRect(); return { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height }; });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Meeting calendar" })).toBeVisible();
  await expect(page.locator(".meeting-view-icon")).toHaveCount(2);
  await expectInlineViewIcons(page);
  const meetingControlHeights = await page.locator(".meeting-browser-controls").evaluate((controls) => [...controls.querySelectorAll(":scope > .meeting-view-toggle > div,:scope > .meeting-browser-select select,:scope > button")].map((element) => element.getBoundingClientRect().height));
  expect(Math.max(...meetingControlHeights) - Math.min(...meetingControlHeights)).toBeLessThanOrEqual(1);
  expect(Math.min(...meetingControlHeights)).toBeGreaterThanOrEqual(44);
  const meetings = await capture();
  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.getByRole("heading", { name: "Existing meetings" })).toBeVisible();
  const meetingTable = await captureBox(".meeting-directory");
  await page.goto("/hours");
  await expect(page.getByRole("heading", { name: "Activity calendar" })).toBeVisible();
  await expect(page.locator(".meeting-view-icon")).toHaveCount(2);
  await expectInlineViewIcons(page);
  const activityControlHeights = await page.locator(".meeting-browser-controls").evaluate((controls) => [...controls.querySelectorAll(":scope > .meeting-view-toggle > div,.meeting-browser-select select,.outreach-activity-visibility > summary,:scope > button")].map((element) => element.getBoundingClientRect().height));
  expect(Math.max(...activityControlHeights) - Math.min(...activityControlHeights)).toBeLessThanOrEqual(1);
  expect(Math.min(...activityControlHeights)).toBeGreaterThanOrEqual(44);
  const navigationStyles = await page.evaluate(() => { const primary = getComputedStyle(document.querySelector('.primary-navigation a[aria-current="page"]')!); const secondary = getComputedStyle(document.querySelector('.outreach-tabs button[aria-pressed="true"]')!); return { primary: { background: primary.backgroundColor, borderWidth: primary.borderTopWidth, color: primary.color, radius: primary.borderRadius }, secondary: { background: secondary.backgroundColor, borderWidth: secondary.borderTopWidth, color: secondary.color, radius: secondary.borderRadius } }; });
  expect(navigationStyles.secondary).toEqual(navigationStyles.primary);
  const activities = await capture();
  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.getByRole("heading", { name: "Activity table" })).toBeVisible();
  const activityTable = await captureBox(".meeting-directory");
  for (const key of ["intro", "controls", "browser", "browserHeading"] as const) {
    for (const dimension of ["top", "left", "width", "height"] as const) expect(Math.abs(meetings[key][dimension] - activities[key][dimension]), `${key} ${dimension}`).toBeLessThanOrEqual(1);
  }
  for (const dimension of ["top", "left", "width"] as const) expect(Math.abs(meetingTable[dimension] - activityTable[dimension]), `table ${dimension}`).toBeLessThanOrEqual(1);
});

test("Outreach activity views default to scheduled events and persist visibility choices", async ({ page }) => {
  const activities = [
    { id: "activity-event", mode: "event", labelIds: [], labels: [], serviceDate: "2026-09-28", teamId: null, title: "Scheduled service fair", description: "", location: "Library", impactRelevant: true, archived: false, revision: 0, eventStartLocal: "09:00", eventEndLocal: "10:00", eventStartOccurrence: null, eventEndOccurrence: null },
    { id: "activity-team", mode: "team", labelIds: [], labels: [], serviceDate: "2026-09-28", teamId: "team-901", title: "Robotics Team 901 support", description: "", location: "Workshop", impactRelevant: true, archived: false, revision: 0, eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null },
    { id: "activity-task", mode: "task", labelIds: [], labels: [], serviceDate: "2026-09-28", teamId: null, title: "Individual donation sorting", description: "", location: "Food bank", impactRelevant: true, archived: false, revision: 0, eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null },
  ];
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot() }));
  await page.route("**/auth/walkthroughs/*", (route) => { const pageId = new URL(route.request().url()).pathname.split("/").at(-1); return route.fulfill({ json: { progress: { pageId, version: 1, status: "completed", stepId: null } } }); });
  await routeWorkspaceReads(page, { activities, entries: [], countedMinutes: 0 });

  await page.goto("/hours");
  await expect(page.getByRole("button", { name: "Open Scheduled service fair" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Robotics Team 901 support" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Individual donation sorting" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Activity", exact: true }).locator("option")).toHaveCount(4);

  const visibility = page.locator(".outreach-activity-visibility");
  const visibilitySummary = visibility.locator("summary");
  await expectSurfaceControl(page, visibilitySummary);
  await visibilitySummary.click();
  await expect(visibility.getByRole("group", { name: "Show activity types" })).toBeVisible();
  const visibilitySpacing = await visibility.getByRole("group", { name: "Show activity types" }).evaluate((element) => { const style = getComputedStyle(element); const bounds = element.getBoundingClientRect(); return { gap: style.rowGap, paddingTop: style.paddingTop, width: bounds.width }; });
  expect(visibilitySpacing.gap).toBe("0px");
  expect(Number.parseFloat(visibilitySpacing.paddingTop)).toBeLessThanOrEqual(9);
  expect(visibilitySpacing.width).toBeLessThanOrEqual(256);
  await expect(visibility.getByRole("checkbox", { name: "Scheduled events" })).toBeChecked();
  await expect(visibility.getByRole("checkbox", { name: "Team support" })).not.toBeChecked();
  await expect(visibility.getByRole("checkbox", { name: "Other service" })).not.toBeChecked();
  const checkboxBounds = await visibility.getByRole("checkbox", { name: "Team support" }).evaluate((element) => { const bounds = element.getBoundingClientRect(); return { width: bounds.width, height: bounds.height }; });
  expect(checkboxBounds.width).toBe(checkboxBounds.height);

  await visibility.getByRole("checkbox", { name: "Team support" }).check();
  await visibility.getByRole("checkbox", { name: "Other service" }).check();
  await visibility.getByRole("checkbox", { name: "Scheduled events" }).uncheck();
  await visibilitySummary.click();
  await expect(page.getByRole("button", { name: "Open Scheduled service fair" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Robotics Team 901 support" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Individual donation sorting" })).toBeVisible();

  await page.getByRole("radio", { name: "Table" }).check();
  const table = page.getByRole("table");
  await expect(table).not.toContainText("Scheduled service fair");
  await expect(table).toContainText("Robotics Team 901 support");
  await expect(table).toContainText("Individual donation sorting");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Activity table" })).toBeVisible();
  await visibilitySummary.click();
  await expect(visibility.getByRole("checkbox", { name: "Scheduled events" })).not.toBeChecked();
  await expect(visibility.getByRole("checkbox", { name: "Team support" })).toBeChecked();
  await expect(visibility.getByRole("checkbox", { name: "Other service" })).toBeChecked();
});

test("Admin completes the focused Outreach setup flow", async ({ page }) => {
  let ready = false;
  let state: OutreachSetupState = outreachSetupState({}, []);
  const teams: Record<string, unknown>[] = [];
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot({ setupReady: ready }) }));
  await page.route("**/admin/modules/hour-tracking/setup", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { stepId: string; outcome: "completed" | "skipped" };
      const outcomes = Object.fromEntries(state.steps.filter((step) => step.outcome).map((step) => [step.id, step.outcome])) as Record<string, "completed" | "skipped">;
      outcomes[body.stepId] = body.outcome;
      const valid = ["rules", ...(teams.length ? ["catalog"] : [])];
      state = outreachSetupState(outcomes, valid);
      if (body.stepId === "catalog") ready = true;
    }
    await route.fulfill({ json: state });
  });
  await page.route("**/module-setup/hour-tracking/rules", async (route) => route.fulfill({ json: { values: route.request().method() === "PUT" ? route.request().postDataJSON() : { reportingDays: 30, reopenHours: 24, revision: 0 } } }));
  await page.route("**/module-setup/hour-tracking/catalog", async (route) => {
    if (route.request().method() === "POST") teams.push({ id: "team-901", ...route.request().postDataJSON() as object });
    await route.fulfill({ json: route.request().method() === "POST" ? teams[0] : { teams } });
  });
  await routeWorkspaceReads(page, { activities: [], entries: [], countedMinutes: 0 });

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Set up Outreach" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Entry rules" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(1);
  const setupBack = page.getByRole("button", { name: "Back" });
  const setupContinue = page.getByRole("button", { name: "Save and continue" });
  await expectSurfaceControl(page, setupBack, "--ui-text-muted");
  await expectPrimaryControl(page, setupContinue);
  expect(Number((await controlAppearance(setupBack)).opacity)).toBeLessThan(1);
  await setupContinue.click();
  await expect(page.getByRole("heading", { level: 2, name: "Labels and supported teams" })).toBeVisible();
  const supportedTeamName = page.getByLabel("Supported team name");
  await expectSurfaceControl(page, supportedTeamName);
  await supportedTeamName.fill("Robotics Team 901");
  await page.getByLabel("Team number").fill("901");
  await page.getByRole("combobox", { name: "Program", exact: true }).selectOption("FRC");
  const finishSetup = page.getByRole("button", { name: "Finish Outreach setup" });
  await expectPrimaryControl(page, finishSetup);
  await finishSetup.click();
  await expect(page.getByRole("heading", { level: 1, name: "Outreach Participation" })).toBeVisible();
});

test("Admin creates an activity, records time with the accessible clock, and reviews the Submission Log", async ({ page }) => {
  const state = { activities: [] as Record<string, unknown>[], entries: [] as Record<string, unknown>[], countedMinutes: 0 };
  const attendanceSourceRequests: string[] = []; const totalsRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/admin/hours/attendance-sources")) attendanceSourceRequests.push(request.url()); if (request.url().includes("/admin/hours/totals")) totalsRequests.push(request.url()); });
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot() }));
  await routeWorkspaceReads(page, state);

  await page.goto("/hours");
  await expect(page.getByRole("heading", { level: 1, name: "Outreach Participation" })).toBeVisible();
  await expect(page.getByText("Reuse Attendance details", { exact: false })).toHaveCount(0);
  expect(attendanceSourceRequests).toEqual([]);
  expect(totalsRequests).toEqual([]);
  await expect(page.getByRole("radio", { name: "Calendar" })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Activity calendar" })).toBeVisible();
  await page.getByRole("radio", { name: "Table" }).check();
  await expect(page.getByRole("heading", { name: "Activity table" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Table" })).toBeChecked();
  await page.getByRole("radio", { name: "Calendar" }).check();
  await expect(page.getByLabel("Activity type")).toHaveCount(0);
  for (const theme of ["light", "dark"] as const) {
    await page.locator(".app").evaluate((element, value) => element.setAttribute("data-theme", value), theme);
    for (const control of [page.getByRole("button", { name: "Submission Log" })]) {
      const appearance = await control.evaluate((element) => {
        const style = getComputedStyle(element); const expected = getComputedStyle(document.querySelector(".primary-navigation a:not(.active)")!);
        return { actual: [style.backgroundColor, style.borderTopWidth, style.color, style.borderRadius], expected: [expected.backgroundColor, expected.borderTopWidth, expected.color, expected.borderRadius], height: element.getBoundingClientRect().height };
      });
      expect(appearance.actual).toEqual(appearance.expected);
      expect(appearance.height).toBeGreaterThanOrEqual(44);
    }
    for (const control of [page.getByRole("combobox", { name: "Activity", exact: true })]) {
      const appearance = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement("div");
        probe.style.cssText = "background:var(--ui-surface-subtle);border:1px solid var(--ui-border);border-radius:var(--radius-control);color:var(--ui-text)";
        document.querySelector(".app")!.append(probe);
        const expected = getComputedStyle(probe);
        const result = {
          actual: [style.backgroundColor, style.borderTopColor, style.color, style.borderRadius],
          expected: [expected.backgroundColor, expected.borderTopColor, expected.color, expected.borderRadius],
          height: element.getBoundingClientRect().height,
        };
        probe.remove();
        return result;
      });
      expect(appearance.actual).toEqual(appearance.expected);
      expect(appearance.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(mobileWidth.scrollWidth).toBeLessThanOrEqual(mobileWidth.clientWidth);
  await expect(page.getByRole("button", { name: /Corrections/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await page.goto("/settings/outreach-setup");
  await page.getByRole("button", { name: /^Supported teams(?: \(|$)/ }).click();
  await expect(page.getByRole("heading", { name: "Supported teams", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outreach labels", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Team name")).toHaveCount(0);
  await expect(page.getByLabel("Label name")).toHaveCount(0);
  const addTeam = page.getByRole("button", { name: "Add team", exact: true });
  await expectPrimaryControl(page, addTeam);
  await addTeam.click();
  const teamDialog = page.getByRole("dialog", { name: "Add supported team" });
  await expect(teamDialog).toBeVisible();
  await expectFocusedControl(page, teamDialog.getByLabel("Team name"));
  await teamDialog.getByRole("button", { name: "Close team dialog" }).focus();
  for (const control of [teamDialog.getByLabel("Team name"), teamDialog.getByLabel("Team number"), teamDialog.getByLabel("Program")]) await expectSurfaceControl(page, control);
  await teamDialog.getByLabel("Team name").fill("Community Team 2");
  await teamDialog.getByLabel("Team number").fill("2");
  await teamDialog.getByRole("combobox", { name: "Program", exact: true }).selectOption("FRC");
  await teamDialog.getByRole("button", { name: "Add team", exact: true }).click();
  await expect(page.getByText("Team added.")).toBeVisible();
  await expect(teamDialog).toHaveCount(0);
  await expect(page.getByRole("rowheader", { name: "Community Team 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Labels(?: \(|$)/ }).click();
  const addLabel = page.getByRole("button", { name: "Add label", exact: true });
  await expectPrimaryControl(page, addLabel);
  await addLabel.click();
  const labelDialog = page.getByRole("dialog", { name: "Add Outreach label" });
  await expect(labelDialog).toBeVisible();
  const newLabel = labelDialog.getByLabel("Label name");
  await expectFocusedControl(page, newLabel);
  await labelDialog.getByRole("button", { name: "Close label dialog" }).focus();
  await expectSurfaceControl(page, newLabel);
  await newLabel.fill("Community-facing");
  await labelDialog.getByRole("button", { name: "Add label", exact: true }).click();
  await expect(page.getByText("Label added.")).toBeVisible();
  await expect(labelDialog).toHaveCount(0);

  await page.goto("/settings/outreach-setup");
  await expect(page.getByRole("heading", { level: 1, name: "Outreach", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Supported teams(?: \(|$)/ }).click(); await expect(page.getByRole("rowheader", { name: "Community Team 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Labels(?: \(|$)/ }).click();
  await page.getByRole("button", { name: "Edit Community-facing", exact: true }).click(); const editLabel = page.getByRole("dialog", { name: "Edit Outreach label" });
  const labelName = editLabel.getByLabel("Label name"); await expect(labelName).toHaveValue("Community-facing"); await expectFocusedControl(page, labelName); await editLabel.getByRole("button", { name: "Close label dialog" }).focus(); await expectSurfaceControl(page, labelName); await labelName.fill("Community event");
  await editLabel.getByRole("button", { name: "Save label" }).click(); await expect(page.getByText("Label updated.")).toBeVisible();
  await page.getByRole("button", { name: "Archive Community event", exact: true }).click(); await expect(page.getByText("Label archived.")).toBeVisible();
  await page.getByLabel("Label status").selectOption("true"); await page.getByRole("button", { name: "Reopen Community event", exact: true }).click(); await expect(page.getByText("Label reopened.")).toBeVisible();
  await page.goto("/hours");
  await page.getByRole("button", { name: "Create activity" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create Outreach activity" });
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "Close create activity" }).focus();
  for (const control of [createDialog.getByLabel("Activity type"), createDialog.getByLabel("Description")]) await expectSurfaceControl(page, control);
  await expect(page.getByLabel("Service date")).toHaveValue("2026-09-28");
  await page.getByLabel("Activity type").selectOption("team");
  await expect(page.getByLabel("Supported team")).toBeVisible();
  await page.getByLabel("Activity type").selectOption("event");
  await expect(page.getByLabel("Supported team")).toHaveCount(0);
  await expect(createDialog.getByLabel("Community event")).not.toBeChecked();
  await createDialog.getByLabel("Community event").check();
  await page.getByLabel("Activity title").fill("Community open house");
  await page.getByLabel("Location").fill("Main campus");
  const createActivity = createDialog.getByRole("button", { name: "Create activity", exact: true });
  await expectPrimaryControl(page, createActivity);
  await createActivity.click();
  await expect(page.getByText("Dated Outreach activity created.")).toBeVisible();
  await page.getByRole("radio", { name: "Table" }).check();
  const activitySearch = page.getByLabel("Search activities");
  await activitySearch.fill("not present");
  await expect(page.getByText("No activities match this search.")).toBeVisible();
  await activitySearch.fill("community open house");
  await expect(page.getByRole("row", { name: /Community open house/ })).toBeVisible();
  const tableMobileWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(tableMobileWidth.scrollWidth).toBeLessThanOrEqual(tableMobileWidth.clientWidth);
  await page.getByRole("radio", { name: "Calendar" }).check();
  await page.getByRole("button", { name: "Create activity" }).click();
  await expect(page.getByRole("dialog", { name: "Create Outreach activity" }).getByLabel("Community event")).not.toBeChecked();
  await page.getByRole("dialog", { name: "Create Outreach activity" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Open Community open house" })).toBeVisible();
  await page.getByRole("button", { name: "Open Community open house" }).click();
  await expect(page.getByRole("heading", { name: "Community open house" })).toBeVisible();
  await expect(page.getByLabel("Activity summary").getByText("Community event", { exact: true })).toBeVisible();
  await expect(page.getByText("Closes Oct 28, 2026, 12:00 AM")).toBeVisible();
  await page.getByRole("button", { name: "Add member participation" }).click();
  await page.getByRole("button", { name: /Start time:/ }).click();
  await expect(page.getByRole("dialog", { name: "Start time" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Staff reason").fill("Transferred a signed paper record.");
  await page.getByLabel("Task notes (optional)").fill("Welcomed visitors and answered program questions.");
  const saveManualParticipation = page.getByRole("button", { name: "Save manual participation" });
  await expectPrimaryControl(page, saveManualParticipation);
  await saveManualParticipation.click();
  await expect(page.getByText("Manual Outreach participation counted and attributed to Staff.")).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "Submission Log" }).click();
  await expect(page.getByRole("heading", { name: "Submission Log" })).toBeVisible();
  await expect(page.getByText(/Avery Member - Community open house/)).toBeVisible();
  await expect(page.getByText(/Counted - Staff-added entry - Staff reason: Transferred a signed paper record/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Totals" })).toHaveCount(0);
  await expect(page.getByText("Open Reports for participation totals.")).toHaveCount(1);
  expect(totalsRequests).toEqual([]);
});

test("Staff handles activity-scoped reporting, corrections, and Event publication", async ({ page }) => {
  const activity = { id: "activity-old", mode: "event", labelIds: [], labels: [], serviceDate: "2026-08-01", teamId: null, title: "Older community drive", description: "", location: "Library", impactRelevant: true, archived: false, revision: 0, eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null };
  const futureActivity = { id: "activity-future", mode: "event", labelIds: [], labels: [], serviceDate: "2026-09-30", teamId: null, title: "Future service fair", description: "Meet community partners", location: "Gym", impactRelevant: true, archived: false, revision: 0, eventStartLocal: null, eventEndLocal: null, eventStartOccurrence: null, eventEndOccurrence: null };
  const state: WorkspaceState = { activities: [activity, futureActivity], entries: [], countedMinutes: 60, windows: [], publications: [], corrections: [{ id: "correction-1", channel: "public", memberName: "Avery Member", externalId: "M-001", entryId: "entry-1", claimedServiceDate: "2026-08-01", message: "I stayed until 10:30.", status: "open", revision: 0, createdAt: "2026-09-28T18:00:00.000Z", entryRevision: 0, entryStatus: "counted", entryMemberId: "member-1", entryActivityId: "activity-old", entryServiceDate: "2026-08-01", startLocal: "09:00", endLocal: "10:00", startOccurrence: null, endOccurrence: null, taskNotes: "Welcomed visitors", activityTitle: "Older community drive", resolutionAction: null, resolutionNote: null }] };
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot() }));
  await routeWorkspaceReads(page, state);

  await page.goto("/hours");
  await expect(page.getByRole("button", { name: "Reporting windows" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Corrections", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Categories" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Publication" })).toHaveCount(0);
  await page.getByRole("button", { name: /Corrections 1/ }).click();
  await expect(page.getByRole("dialog", { name: "Open Outreach corrections" })).toContainText("Avery Member");
  await page.getByRole("button", { name: "Review in activity" }).click();
  await expect(page.getByRole("heading", { name: "Older community drive" })).toBeVisible();
  await expect(page.getByText("Report closed", { exact: true })).toBeVisible();
  const reopenReporting = page.getByRole("button", { name: "Reopen for 24 hours" }); await expectSurfaceControl(page, reopenReporting); await reopenReporting.click();
  await expect(page.getByText("Reporting reopened for 24 hours.")).toBeVisible(); await expect(page.getByText(/Closes/)).toBeVisible();
  await expect(page.getByLabel("Window length in hours")).toHaveCount(0); await expect(page.getByRole("button", { name: "Revoke reporting window" })).toHaveCount(0);

  await expect(page.getByText("I stayed until 10:30.")).toBeVisible();
  const staffReviewNote = page.getByLabel("Staff review note");
  await expectSurfaceControl(page, staffReviewNote);
  await staffReviewNote.fill("Verified against the event lead's sign-out sheet.");
  const resolveCorrection = page.getByRole("button", { name: "Resolve correction" });
  await expectPrimaryControl(page, resolveCorrection);
  await resolveCorrection.click();
  await expect(page.getByText("Correction applied as one immutable entry revision.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Corrections/ })).toHaveCount(0);
  await page.getByText("Resolved correction history (1)").click();
  await expect(page.getByText("Avery Member - corrected")).toBeVisible();

  const oldActivityDetail = page.locator('article[aria-labelledby="outreach-activity-activity-old"]');
  await page.goBack();
  await page.getByRole("button", { name: "Open Future service fair" }).click();
  const futureActivityDetail = page.locator('article[aria-labelledby="outreach-activity-activity-future"]');
  await expect(page.getByText("Report closed", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Add member participation" })).toHaveCount(0);
  await expect(futureActivityDetail.getByText("All day", { exact: true })).toBeVisible();
  await futureActivityDetail.getByRole("button", { name: "Google Calendar: Not published", exact: true }).click(); await expect(page.getByText("Publication queued for this destination.")).toBeVisible();
  await expect(futureActivityDetail.getByRole("button", { name: "Google Calendar: Queued", exact: true })).toBeDisabled();
  await futureActivityDetail.getByRole("button", { name: "Discord: Not published", exact: true }).click(); await expect(futureActivityDetail.getByRole("button", { name: "Discord: Queued", exact: true })).toBeDisabled();
  expect(state.publications![0]).toMatchObject({ googleCalendar: true, discord: true, googleStatus: "pending", discordStatus: "pending" });

});

test("Member records participation publicly and can retry the exact uncertain submission", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/setup/status", (route) => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Synthetic Robotics", subtitle: "Member services", logoData: "", primaryColor: "#6d28d9", secondaryColor: "#0f766e", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, discordContestWindowHours: 24 } } }));
  await page.route("**/public/hours/context", (route) => route.fulfill({ json: { organizationName: "Synthetic Robotics", timeZone: "America/New_York", today: "2026-09-28", earliestServiceDate: "2026-08-30", reportingDays: 30 } }));
  await page.route(/\/public\/hours\/(?:activities|correction-activities)(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [{ id: "activity-1", categoryId: "other-service", categoryName: "Other Service", title: "Reopened community drive", serviceDate: "2026-08-15", location: "Library", reopened: true }], nextCursor: null } }));
  const submissions: Record<string, unknown>[] = [];
  const corrections: Record<string, unknown>[] = [];
  await page.route("**/public/hours/entries", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>; submissions.push(body);
    if (submissions.length === 1) return route.fulfill({ status: 503, json: { error: "The submission result is temporarily uncertain" } });
    return route.fulfill({ status: 201, json: { id: "receipt-public-1", serviceDate: body.serviceDate, startLocal: body.startLocal, endLocal: body.endLocal, durationMinutes: 60, createdAt: "2026-09-28T14:00:00.000Z" } });
  });
  await page.route("**/public/hours/corrections", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>; corrections.push(body);
    if (corrections.length === 1) return route.fulfill({ status: 503, json: { error: "The correction result is temporarily uncertain" } });
    return route.fulfill({ status: 202, json: { reference: "correction-public-1", status: "open", createdAt: "2026-09-28T14:05:00.000Z" } });
  });

  await page.goto("/submit-hours");
  await expect(page.getByRole("heading", { level: 1, name: "Record Outreach Participation" })).toBeVisible();
  const mobileWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(mobileWidth.scrollWidth).toBeLessThanOrEqual(mobileWidth.clientWidth);
  const memberId = page.getByLabel("Roster member ID");
  const activity = page.getByLabel("Dated activity");
  const notes = page.getByLabel("Private task notes (optional)");
  const correctionButton = page.getByRole("button", { name: "Request a correction instead" });
  const submitButton = page.getByRole("button", { name: "Record completed participation" });
  const startTime = page.getByRole("button", { name: /^Start time:/ });
  const darkSurface = await resolvedThemeColor(page, "--ui-surface-subtle");
  const darkBorder = await resolvedThemeColor(page, "--ui-border");
  const primary = await resolvedThemeColor(page, "--primary");
  const onPrimary = await resolvedThemeColor(page, "--on-primary");
  for (const control of [memberId, activity, notes]) {
    const appearance = await controlAppearance(control);
    expect(appearance.background).toBe(darkSurface); expect(appearance.borderColor).toBe(darkBorder); expect(appearance.borderStyle).toBe("solid"); expect(parseFloat(appearance.borderRadius)).toBeGreaterThan(0); expect(appearance.height).toBeGreaterThanOrEqual(44); expect(appearance.fontFamily).toContain("Roboto");
  }
  const secondaryAppearance = await controlAppearance(correctionButton);
  expect(secondaryAppearance.background).toBe(darkSurface); expect(secondaryAppearance.borderColor).toBe(darkBorder); expect(secondaryAppearance.height).toBeGreaterThanOrEqual(44); expect(parseFloat(secondaryAppearance.borderRadius)).toBeGreaterThan(0);
  const disabledPrimary = await controlAppearance(submitButton);
  expect(disabledPrimary.background).toBe(primary); expect(disabledPrimary.borderColor).toBe(primary); expect(disabledPrimary.color).toBe(onPrimary); expect(disabledPrimary.cursor).toBe("not-allowed"); expect(Number(disabledPrimary.opacity)).toBeLessThan(1); expect(disabledPrimary.height).toBeGreaterThanOrEqual(44);
  await memberId.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  const focusedInput = await controlAppearance(memberId);
  expect(focusedInput.outlineStyle).not.toBe("none"); expect(parseFloat(focusedInput.outlineWidth)).toBeGreaterThanOrEqual(2);
  await activity.selectOption("activity-1");
  await chooseClock(page, "Start time", 9); await chooseClock(page, "End time", 10);
  await startTime.click();
  const clockDialog = page.getByRole("dialog", { name: "Start time" });
  await expect(clockDialog).toBeVisible();
  const selectedHour = clockDialog.getByRole("button", { name: "9 o'clock" });
  const selectedHourAppearance = await controlAppearance(selectedHour);
  expect(selectedHourAppearance.background).toBe(primary); expect(selectedHourAppearance.color).toBe(onPrimary); expect(selectedHourAppearance.height).toBeGreaterThanOrEqual(44);
  const cancelClock = clockDialog.getByRole("button", { name: "Cancel" });
  const cancelAppearance = await controlAppearance(cancelClock);
  expect(cancelAppearance.background).toBe(darkSurface); expect(cancelAppearance.borderColor).toBe(darkBorder); expect(cancelAppearance.height).toBeGreaterThanOrEqual(44);
  await cancelClock.click();
  const themeToggle = page.getByRole("switch", { name: "Dark mode" });
  await expect(themeToggle).toHaveAttribute("aria-checked", "true");
  await themeToggle.click();
  await expect(themeToggle).toHaveAttribute("aria-checked", "false");
  await page.setViewportSize({ width: 1280, height: 900 });
  const lightSurface = await resolvedThemeColor(page, "--ui-surface-subtle");
  expect(lightSurface).not.toBe(darkSurface);
  expect((await controlAppearance(memberId)).background).toBe(lightSurface);
  const desktopWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(desktopWidth.scrollWidth).toBeLessThanOrEqual(desktopWidth.clientWidth);
  await memberId.fill("M-001");
  await activity.selectOption("activity-1");
  await notes.fill("Sorted donated supplies");
  await submitButton.click();
  await expect(page.getByRole("alert")).toContainText("retry the exact submission");
  await page.getByRole("button", { name: "Retry exact submission" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Participation recorded" })).toBeVisible();
  await expect(page.getByText("Receipt reference:")).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]?.idempotencyKey).toBe(submissions[0]?.idempotencyKey);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]?.activityId).toBe("activity-1");
  expect(submissions[0]).not.toHaveProperty("categoryId");
  await page.getByRole("button", { name: "Request a correction" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Request an Outreach correction" })).toBeVisible();
  await expect(page.getByLabel("Outreach activity")).toHaveValue("activity-1");
  await expect(page.getByLabel("Participation receipt reference")).toHaveCount(0);
  const correctionMessage = page.getByLabel("What should Staff review?");
  expect((await controlAppearance(correctionMessage)).background).toBe(lightSurface);
  await correctionMessage.fill("I stayed until 10:30.");
  await page.getByRole("button", { name: "Send correction request" }).click();
  await expect(page.getByRole("alert")).toContainText("retry the exact request");
  await page.getByRole("button", { name: "Retry exact request" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Correction request received" })).toBeVisible();
  expect(corrections).toHaveLength(2);
  expect(corrections[1]).toEqual(corrections[0]);
  expect(corrections[0]?.activityId).toBe("activity-1");
  expect(corrections[0]).not.toHaveProperty("receiptId");
});

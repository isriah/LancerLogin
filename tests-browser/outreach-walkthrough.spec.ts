import { expect, test, type Page } from "@playwright/test";
import { outreachSnapshot } from "./module-fixtures";

type Progress = { pageId: "outreach"; version: number; status: string; stepId: string | null };

const activity = {
  id: "activity-1",
  mode: "event",
  labelIds: [],
  labels: [],
  serviceDate: "2026-09-20",
  teamId: null,
  title: "Community open house",
  description: "Welcome neighbors to the workshop.",
  location: "Library",
  impactRelevant: true,
  archived: false,
  revision: 0,
  eventStartLocal: "09:00",
  eventEndLocal: "12:00",
  eventStartOccurrence: null,
  eventEndOccurrence: null,
};

async function routeOutreach(page: Page, role: "admin" | "operator", state: { progress: Progress }) {
  await page.route("**/auth/session", (route) => route.fulfill({ json: { user: { id: `${role}-1`, role, debugMode: true } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot() }));
  await page.route("**/integrations/capabilities", (route) => route.fulfill({ json: { integrations: { google: { enabled: false, configured: false }, resend: { enabled: false, configured: false }, discord: { enabled: true, configured: true } } } }));
  await page.route("**/auth/walkthroughs/outreach", async (route) => {
    if (route.request().method() === "PATCH") state.progress = { ...route.request().postDataJSON(), pageId: "outreach" };
    await route.fulfill({ json: { progress: state.progress } });
  });
  await page.route(/\/admin\/hours(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/hours/labels") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/admin/hours/teams") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/admin/hours/activities") return route.fulfill({ json: { items: [activity], nextCursor: null } });
    if (path === "/admin/hours/member-choices") return route.fulfill({ json: { items: [{ id: "member-1", label: "Avery Member", externalId: "M-001", active: true }], nextCursor: null } });
    if (path === "/admin/hours/entries") return route.fulfill({ json: { items: [{ id: "entry-1", memberId: "member-1", activityId: activity.id, memberName: "Avery Member", externalId: "M-001", activityTitle: activity.title, teamName: null, serviceDate: activity.serviceDate, startLocal: "09:00", endLocal: "10:00", durationMinutes: 60, taskNotes: "Welcomed visitors", staffReason: null, attribution: "member_submitted", status: "counted", revision: 0 }], nextCursor: null } });
    if (path === "/admin/hours/reopen-windows") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/admin/hours/corrections") return route.fulfill({ json: { items: [{ id: "correction-1", channel: "public", memberName: "Avery Member", externalId: "M-001", entryId: "entry-1", claimedServiceDate: activity.serviceDate, message: "I stayed until 10:30.", status: "open", revision: 0, createdAt: "2026-09-21T14:00:00.000Z", entryRevision: 0, entryStatus: "counted", entryMemberId: "member-1", entryActivityId: activity.id, entryServiceDate: activity.serviceDate, startLocal: "09:00", endLocal: "10:00", startOccurrence: null, endOccurrence: null, taskNotes: "Welcomed visitors", activityTitle: activity.title, resolutionAction: null, resolutionNote: null }], nextCursor: null } });
    if (path === "/admin/hours/publications") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/admin/hours/publication-providers") return route.fulfill({ json: { google_calendar: false, discord: false } });
    if (path === "/admin/hours/context") return route.fulfill({ json: { reportingDays: 30, reopenHours: 24, revision: 0, timeZone: "America/New_York", today: "2026-09-29" } });
    if (path === "/admin/hours/totals") return route.fulfill({ json: { summary: { entries: 1, participants: 1, countedMinutes: 60 }, members: [], teams: [] } });
    return route.fulfill({ status: 404, json: { error: `Unexpected Outreach request: ${path}` } });
  });
}

for (const view of [
  { width: 1280, height: 900, theme: "light", role: "admin" as const },
  { width: 390, height: 844, theme: "dark", role: "operator" as const },
]) {
  test(`Outreach walkthrough follows the safe staff flow at ${view.width} for ${view.role}`, async ({ page }) => {
    await page.setViewportSize(view);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((theme) => localStorage.setItem("lancerlogin-theme", theme), view.theme);
    const state = { progress: { pageId: "outreach", version: 1, status: "not_started", stepId: null } as Progress };
    await routeOutreach(page, view.role, state);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && !request.url().includes("/auth/walkthroughs/")) writes.push(request.url());
    });

    await page.goto("/hours");
    const panel = page.locator(".walkthrough-panel");
    await expect(panel).toContainText("Follow the Outreach workflow");
    await panel.getByRole("button", { name: "Start walkthrough" }).click();

    const titles = [
      "Start with a dated activity",
      "Let members submit their participation",
      "Review the Submission Log",
      "Review corrections inside the activity",
      "Use staff entry only for an exception",
      "Continue into Reports",
    ];
    for (const [index, title] of titles.entries()) {
      await expect(panel).toContainText(`Step ${index + 1} of ${titles.length}`);
      await expect(panel.getByRole("heading", { name: title })).toBeFocused();
      await expect(page.locator(".walkthrough-highlight").first()).toBeVisible();
      if (title === "Continue into Reports") {
        await expect(page.locator('#primary-dashboard-navigation a[href="/reports"]')).toBeVisible();
        if (view.width <= 760) await expect(page.locator("#primary-dashboard-navigation")).toHaveClass(/mobile-open/);
      }
      await panel.getByRole("button", { name: "Next", exact: true }).click();
    }

    await expect(panel).toContainText("You're ready to manage Outreach");
    await panel.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator('[data-walkthrough-page="outreach"]')).toBeFocused();
    await expect(page.locator("#primary-dashboard-navigation")).not.toHaveClass(/mobile-open/);
    await expect.poll(() => state.progress.status).toBe("completed");
    expect(writes).toEqual([]);

    await page.reload();
    await expect(panel).toHaveCount(0);
    const reset = page.getByRole("button", { name: "Reset page walkthrough" });
    await expect(reset).toBeVisible();
    await reset.click();
    await expect(panel).toContainText("Follow the Outreach workflow");
    await panel.getByRole("button", { name: "Not now" }).click();
  });
}

test("Outreach walkthrough stays unavailable without module workspace access", async ({ page }) => {
  let walkthroughRequests = 0;
  await page.route("**/auth/session", (route) => route.fulfill({ json: { user: { id: "operator-1", role: "operator", debugMode: true } } }));
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot({ access: false }) }));
  await page.route("**/auth/walkthroughs/outreach", async (route) => { walkthroughRequests += 1; await route.fulfill({ json: { error: "Unexpected walkthrough request" }, status: 500 }); });
  await page.goto("/hours");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await expect(page.locator(".walkthrough-panel")).toHaveCount(0);
  expect(walkthroughRequests).toBe(0);
});

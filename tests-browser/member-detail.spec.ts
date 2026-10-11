import { expect, test, type Page } from "@playwright/test";
import { dashboardConformanceReferences } from "../apps/dashboard/src/design-conformance";

async function memberFixture(page: Page, role: "admin" | "operator" = "admin") {
  const member = { id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: "avery@example.test", active: 1, attendanceRequiredFrom: "2026-01-01" };
  const state = {
    writes: [] as Array<{ path: string; body: Record<string, unknown> }>,
    reads: 0,
    history: [
      { meetingId: "meeting-one", title: "Completed build session", startsAt: "2026-09-01T18:00:00Z", endsAt: "2026-09-01T20:00:00Z", checkedInAt: "2026-09-01T18:05:00Z" as string | undefined, checkedOutAt: undefined as string | undefined, disposition: "absent", reason: "", audience: "All", eligibility: "required", policy: "standard" },
      { meetingId: "meeting-two", title: "Another completed meeting", startsAt: "2026-09-02T18:00:00Z", endsAt: "2026-09-02T20:00:00Z", checkedInAt: "2026-09-02T18:00:00Z" as string | undefined, checkedOutAt: "2026-09-02T20:00:00Z" as string | undefined, disposition: "present", reason: "", audience: "All", eligibility: "required", policy: "standard" },
    ],
  };
  await page.route("**/setup/status", route => route.fulfill({ json: { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Reference Arts Collective", subtitle: "Shared operations", primaryColor: dashboardConformanceReferences.brand.primary, secondaryColor: dashboardConformanceReferences.brand.secondary, appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30 } } }));
  await page.route("**/auth/session", route => route.fulfill({ json: { user: { role, debugMode: false } } }));
  await page.route("**/labels", route => route.fulfill({ json: { labels: [], history: [], periods: [], today: "2026-09-25" } }));
  await page.route("**/admin/members/A-101/history", route => {
    state.reads += 1;
    const attended = state.history.filter(row => row.disposition === "present").length;
    return route.fulfill({ json: { member, labels: [], labelHistory: [], meanAnomalyMinutes: null, attendancePolicy: { currentLabelIds: [], currentCompliances: [], regularAttendance: { rate: attended * 50, from: "2026-01-01", to: "2026-09-25" }, belowTargetWeeks: [], historySummaries: [] }, history: state.history } });
  });
  for (const path of ["/attendance/corrections", "/attendance/cleanup"]) {
    await page.route("**" + path, route => {
      expect(route.request().method()).toBe("POST");
      const body = route.request().postDataJSON();
      state.writes.push({ path, body });
      expect(body.memberId).toBe(member.id);
      const row = state.history.find(item => item.meetingId === body.meetingId)!;
      expect(row).toBeDefined();
      row.disposition = path.endsWith("cleanup") ? "absent" : body.disposition;
      row.reason = path.endsWith("cleanup") ? "" : body.reason;
      if (path.endsWith("cleanup")) { row.checkedInAt = undefined; row.checkedOutAt = undefined; }
      return route.fulfill({ json: { cleared: 1 } });
    });
  }
  return state;
}

function historyRow(page: Page, title = "Completed build session") {
  return page.getByRole("table", { name: "Complete attendance history" }).getByRole("row").filter({ hasText: title });
}

test("member history applies meeting status actions and refreshes outcomes and profile rates", async ({ page }) => {
  const state = await memberFixture(page);
  await page.goto("/roster/A-101");
  const row = historyRow(page);
  await expect(row.getByRole("button", { name: "Absent", exact: true })).toBeDisabled();
  await expect(page.locator(".member-profile-details")).toContainText("50%");
  const initialReads = state.reads;
  page.once("dialog", dialog => dialog.accept(""));
  await row.getByRole("button", { name: "Present", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Marked present.");
  await expect(row.getByRole("button", { name: "Present", exact: true })).toBeDisabled();
  await expect(page.locator(".member-profile-details")).toContainText("100%");

  page.once("dialog", dialog => dialog.accept("   "));
  await row.getByRole("button", { name: "Excuse", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("A reason is required for this change.");
  page.once("dialog", dialog => dialog.dismiss());
  await row.getByRole("button", { name: "Excuse", exact: true }).click();
  expect(state.writes).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept("School event"));
  await row.getByRole("button", { name: "Excuse", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Marked excused.");
  await expect(row.locator(".member-history-outcome")).toContainText("School event");
  await expect(row.getByRole("button", { name: "Excuse", exact: true })).toBeDisabled();
  page.once("dialog", dialog => dialog.accept(""));
  await row.getByRole("button", { name: "Absent", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("A reason is required for this change.");
  expect(state.writes).toHaveLength(2);
  page.once("dialog", dialog => dialog.accept("No contact"));
  await row.getByRole("button", { name: "Absent", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Marked absent.");

  page.once("dialog", dialog => { expect(dialog.message()).toContain("Completed build session"); return dialog.dismiss(); });
  await row.getByRole("button", { name: "Clear", exact: true }).click();
  expect(state.writes).toHaveLength(3);
  page.once("dialog", dialog => dialog.accept());
  await row.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Attendance records cleared.");
  await expect(row.locator(".member-history-check-in")).toHaveText("Not recorded");
  await expect(row.locator(".member-history-check-out")).toHaveText("Not recorded");
  await expect(historyRow(page, "Another completed meeting").locator(".attendance-state")).toHaveText("present");
  expect(state.writes).toEqual([
    { path: "/attendance/corrections", body: { memberId: "member-1", meetingId: "meeting-one", disposition: "present", reason: "" } },
    { path: "/attendance/corrections", body: { memberId: "member-1", meetingId: "meeting-one", disposition: "excused", reason: "School event" } },
    { path: "/attendance/corrections", body: { memberId: "member-1", meetingId: "meeting-one", disposition: "absent", reason: "No contact" } },
    { path: "/attendance/cleanup", body: { memberId: "member-1", meetingId: "meeting-one", confirmation: "CLEAR ATTENDANCE" } },
  ]);
  expect(state.reads).toBe(initialReads + 4);
});

test("Operators can correct member history but cannot clear attendance or edit the member", async ({ page }) => {
  const state = await memberFixture(page, "operator");
  await page.goto("/roster/A-101");
  await expect(page.getByRole("group", { name: "Member actions", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toHaveCount(0);
  const row = historyRow(page, "Another completed meeting");
  page.once("dialog", dialog => dialog.accept("Approved absence"));
  await row.getByRole("button", { name: "Excuse", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Marked excused.");
  expect(state.writes).toEqual([{ path: "/attendance/corrections", body: { memberId: "member-1", meetingId: "meeting-two", disposition: "excused", reason: "Approved absence" } }]);
});

test("member attendance shows pending and failed saves without changing the displayed outcome", async ({ page }) => {
  const state = await memberFixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let fail = true;
  await page.route("**/attendance/corrections", async route => {
    if (!fail) return route.fallback();
    await pending;
    return route.fulfill({ status: 500, json: { error: "Attendance could not be saved" } });
  });
  await page.goto("/roster/A-101");
  const row = historyRow(page);
  page.once("dialog", dialog => dialog.accept(""));
  await row.getByRole("button", { name: "Present", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Saving attendance…");
  for (const button of await page.locator(".member-attendance-actions button").all()) await expect(button).toBeDisabled();
  await expect(row.locator(".attendance-state")).toHaveText("absent");
  release();
  await expect(row.getByRole("status")).toHaveText("Attendance could not be saved");
  await expect(row.getByRole("button", { name: "Present", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(0);
  fail = false;
  page.once("dialog", dialog => dialog.accept("Confirmed with member"));
  await row.getByRole("button", { name: "Present", exact: true }).click();
  await expect(row.getByRole("status")).toHaveText("Marked present.");
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test("member controls stay horizontal, themed and keyboard accessible at " + width + " in " + theme, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript(value => localStorage.setItem("lancerlogin-theme", value), theme);
      await memberFixture(page);
      await page.goto("/roster/A-101");
      await expect(page.locator(".app")).toHaveAttribute("data-theme", theme);
      const profile = page.getByRole("group", { name: "Member actions", exact: true });
      const edit = profile.getByRole("button", { name: "Edit", exact: true });
      const deactivate = profile.getByRole("button", { name: "Deactivate", exact: true });
      const remove = profile.getByRole("button", { name: "Delete", exact: true });
      const bounds = await Promise.all([edit, deactivate, remove].map(button => button.boundingBox()));
      expect(bounds[0]!.y).toBe(bounds[1]!.y);
      expect(bounds[1]!.y).toBe(bounds[2]!.y);
      expect(bounds[0]!.x + bounds[0]!.width).toBeLessThan(bounds[1]!.x);
      expect(bounds[1]!.x + bounds[1]!.width).toBeLessThan(bounds[2]!.x);
      await edit.focus();
      await page.keyboard.press("Tab");
      await expect(deactivate).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(remove).toBeFocused();
      for (const button of await page.locator(".member-profile-card .roster-row-actions button, .member-attendance-actions button").all()) {
        const styles = await button.evaluate(element => {
          const style = getComputedStyle(element);
          const tokenColor = (name: string) => {
            const probe = document.createElement("span");
            element.appendChild(probe);
            probe.style.color = "var(" + name + ")";
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          };
          const danger = element.classList.contains("ui-button--danger");
          const disabled = (element as HTMLButtonElement).disabled;
          const probe = document.createElement("span");
          element.appendChild(probe);
          probe.style.borderRadius = "var(--radius-control)";
          const tokenRadius = getComputedStyle(probe).borderRadius;
          probe.remove();
          return { actual: [style.backgroundColor, style.color, style.borderTopColor], expected: danger ? [tokenColor("--ui-error-surface"), tokenColor("--ui-error"), tokenColor("--ui-error")] : [tokenColor("--ui-surface-subtle"), tokenColor(disabled ? "--ui-text-muted" : "--ui-text"), tokenColor("--ui-border")], radius: style.borderRadius, tokenRadius, height: element.getBoundingClientRect().height, opacity: style.opacity };
        });
        expect(styles.actual).toEqual(styles.expected);
        expect(styles.height).toBeGreaterThanOrEqual(44);
        expect(styles.radius).toBe(styles.tokenRadius);
        if (await button.isDisabled()) expect(Number(styles.opacity)).toBeLessThan(1);
      }
      const present = historyRow(page).getByRole("button", { name: "Present", exact: true });
      await present.focus();
      await expect(present).toBeFocused();
      expect(await present.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
      await page.keyboard.press("Tab");
      await expect(historyRow(page).getByRole("button", { name: "Excuse", exact: true })).toBeFocused();
      await present.hover();
      const hover = await present.evaluate(element => {
        const probe = document.createElement("span");
        element.appendChild(probe);
        probe.style.backgroundColor = "var(--ui-surface)";
        probe.style.borderColor = "var(--primary)";
        const expected = [getComputedStyle(probe).backgroundColor, getComputedStyle(probe).borderTopColor];
        const actual = [getComputedStyle(element).backgroundColor, getComputedStyle(element).borderTopColor];
        probe.remove();
        return { actual, expected };
      });
      expect(hover.actual).toEqual(hover.expected);
      await page.mouse.move(0, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (width === 390) {
        const scroller = page.locator(".member-history-scroll");
        expect(await scroller.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath("member-controls.png"), fullPage: true });
      await edit.click();
      await expect(page.getByRole("dialog", { name: "Edit roster member" })).toBeVisible();
    });
  }
}

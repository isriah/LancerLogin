import { expect, test } from "@playwright/test";
import { attendanceSnapshot } from "./module-fixtures";

function snapshot({ enabled, selected, operator = false, revision = 0 }: { enabled: boolean; selected: boolean; operator?: boolean; revision?: number }) {
  return attendanceSnapshot({ enabled, selectionCompleted: selected, setupReady: true, access: !operator, revision });
}

test("fresh Admin chooses modules before opening the workspace", async ({ page }) => {
  let state = snapshot({ enabled: false, selected: false });
  let saved: unknown;
  await page.route("**/platform/modules", (route) => route.fulfill({ json: state }));
  await page.route("**/admin/modules", async (route) => {
    saved = route.request().postDataJSON();
    state = snapshot({ enabled: true, selected: true, revision: 1 });
    await route.fulfill({ json: state });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Choose modules" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary dashboard navigation" })).toHaveCount(0);
  await expect(page.getByText("You can turn modules on or off later in Settings > Modules.", { exact: false })).toBeVisible();
  // Attendance starts selected and recommended; each switch is named by its module alone.
  const attendance = page.getByRole("switch", { name: "Attendance", exact: true });
  await expect(attendance).toBeChecked();
  const choice = page.locator(".module-choice").filter({ has: attendance });
  await expect(choice.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(choice.getByText("Built-in", { exact: true })).toBeVisible();
  // The status follows the draft switch, not the saved state.
  await expect(choice.getByText("Turns on when you continue", { exact: true })).toBeVisible();
  await expect(choice.getByText("Disabled", { exact: true })).toHaveCount(0);
  await attendance.uncheck();
  await expect(choice.getByText("Disabled", { exact: true })).toBeVisible();
  await attendance.check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => saved).toEqual({ enabled: ["attendance"], revision: 0, confirmDisable: [] });
  await expect(page.getByRole("link", { name: "Meetings" })).toBeVisible();
});

test("continuing with no modules explains Core-only use and asks for confirmation", async ({ page }) => {
  let state = snapshot({ enabled: false, selected: false });
  let saved: unknown;
  await page.route("**/platform/modules", (route) => route.fulfill({ json: state }));
  await page.route("**/admin/modules", async (route) => {
    saved = route.request().postDataJSON();
    state = snapshot({ enabled: false, selected: true, revision: 1 });
    await route.fulfill({ json: state });
  });
  await page.goto("/dashboard");
  await page.getByRole("switch", { name: "Attendance", exact: true }).uncheck();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const review = page.getByRole("region", { name: "Continue without modules?" });
  await expect(review).toBeFocused();
  await expect(review).toContainText("Only Core features will be available");
  expect(saved).toBeUndefined();
  await review.getByRole("button", { name: "Choose modules" }).click();
  await expect(review).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue without modules" }).click();
  await expect.poll(() => saved).toEqual({ enabled: [], revision: 0, confirmDisable: [] });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

test("Core-only home keeps roster and reports while hiding Attendance surfaces", async ({ page }) => {
  await page.route("**/platform/modules", (route) => route.fulfill({ json: snapshot({ enabled: false, selected: true }) }));
  const fields = [
    { id: "core.member.identity", label: "Member record ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
    { id: "core.member.name", label: "Member", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
    { id: "core.member.id", label: "Member ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
    { id: "core.member.status", label: "Roster status", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
    { id: "core.member.labels", label: "Current labels", group: "Roster", kind: "dimension", valueType: "text", sortable: false, filterOperators: ["contains"] },
  ];
  const dataset = { id: "core.members", label: "Members", description: "Core roster identities and current label membership.", available: true, rowIdentity: "core.member.identity", capability: "core.roster", fields, filters: ["roster", "labels"], groupBy: ["core.member.identity"], defaultColumns: ["core.member.name", "core.member.id", "core.member.status", "core.member.labels"], defaultSort: { field: "core.member.name", direction: "asc" }, relationships: [] };
  const definition = { version: 2, dataset: "core.members", groupBy: ["core.member.identity"], period: { type: "all" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: dataset.defaultColumns.map((key) => ({ key })), columnFilters: [], sort: { column: { key: "core.member.name" }, direction: "asc" } };
  await page.route("**/reports/catalog", (route) => route.fulfill({ json: { datasets: [dataset], columns: fields.map((field) => ({ key: field.id, label: field.label, group: field.group, sortable: field.sortable, filterKind: field.valueType, datasets: [dataset.id] })), labels: [], reportFilters: [], baseline: null, timeZone: "UTC", defaultDefinition: definition, role: "admin", attendanceAvailable: false } }));
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Roster", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reports", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kiosks", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Build a report" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
});

test("Admin assigns Attendance explicitly to an Operator", async ({ page }) => {
  let assignments = { userId: "operator-1", revision: 0, capabilities: [] as string[] };
  await page.route("**/platform/modules", (route) => route.fulfill({ json: snapshot({ enabled: true, selected: true }) }));
  await page.route("**/admin/users", (route) => route.fulfill({ json: { users: [{ id: "operator-1", localUsername: "desk", role: "operator", active: 1, createdAt: "2026-09-01T00:00:00.000Z" }] } }));
  await page.route("**/admin/modules/assignments/operator-1", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { capabilities: string[] };
      assignments = { userId: "operator-1", revision: 1, capabilities: body.capabilities };
    }
    await route.fulfill({ json: assignments });
  });
  await page.goto("/settings/access");
  await page.getByRole("button", { name: "Module assignments for desk" }).click();
  await page.getByRole("checkbox", { name: /Manage Attendance/ }).check();
  await page.getByRole("button", { name: "Save assignments" }).click();
  await expect(page.getByText("Module assignments saved.")).toBeVisible();
  expect(assignments.capabilities).toEqual(["attendance.manage"]);
});

test("an unavailable plugin keeps the workspace usable and explains itself in Settings", async ({ page }) => {
  const removed = { id: "retired-plugin", label: "Retired Plugin", description: "Code no longer installed", contractVersion: 1, enabled: true, phase: "enabled", generation: 2, dependencies: [], permissions: [], effectiveCapabilities: [], workspaceReady: false, navigation: [], settings: [], setup: { version: 1, steps: [], ready: true }, deletion: { disabledAt: null, deleteAfter: null, contentStillPresent: false, cleanupFailure: null, data: ["Retired records"] }, unavailable: "removed" };
  let state: any = snapshot({ enabled: true, selected: true }); state.modules.push(removed);
  await page.route("**/platform/modules", (route) => route.fulfill({ json: state }));
  await page.goto("/settings/modules");
  await expect(page.getByRole("heading", { name: "Modules", exact: true })).toBeVisible();
  await expect(page.getByText("Module access unavailable")).toHaveCount(0);
  await expect(page.getByText("Code is no longer installed. Disable it to delete its retained data.")).toBeVisible();
  await expect(page.getByRole("switch", { name: /Retired Plugin/ })).toBeChecked();
  await expect(page.locator(".module-choice").filter({ has: page.getByRole("switch", { name: "Retired Plugin", exact: true }) }).getByText("Plugin", { exact: true })).toBeVisible();

  // An installed module whose database setup has not completed is reported as such, not as a cleanup problem.
  state = snapshot({ enabled: false, selected: true });
  const attendance = state.modules.find((module: any) => module.id === "attendance");
  Object.assign(attendance, { enabled: false, phase: "disabled", generation: 0, permissions: [], effectiveCapabilities: [], workspaceReady: false, navigation: [], settings: [], unavailable: "setup-incomplete", setup: { ...attendance.setup, ready: false }, deletion: { ...attendance.deletion, cleanupFailure: "Database setup for this module has not completed. LancerLogin retries automatically." } });
  state.capabilities = [];
  await page.reload();
  await expect(page.getByRole("heading", { name: "Modules", exact: true })).toBeVisible();
  await expect(page.getByText("Database setup has not completed. LancerLogin retries automatically.")).toBeVisible();
  await expect(page.getByText("Cleanup needs recovery attention and will retry.")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: /Attendance/ })).toBeDisabled();
});

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
  await page.getByRole("switch", { name: /Attendance/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => saved).toEqual({ enabled: ["attendance"], revision: 0, confirmDisable: [] });
  await expect(page.getByRole("link", { name: "Meetings" })).toBeVisible();
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
  await page.route("**/reports/catalog", (route) => route.fulfill({ json: { datasets: [dataset], columns: fields.map((field) => ({ key: field.id, label: field.label, group: field.group, sortable: field.sortable, filterKind: field.valueType, datasets: [dataset.id] })), labels: [], outreachLabels: [], baseline: null, timeZone: "UTC", defaultDefinition: definition, role: "admin", attendanceAvailable: false } }));
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

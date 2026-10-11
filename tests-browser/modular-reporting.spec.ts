import { expect, test, type Page } from "@playwright/test";
import { combinedMemberDataset, reportFieldSourceDataset } from "../apps/api/src/report-builder.ts";
import { reportColumnLabel } from "../apps/dashboard/src/saved-reports.ts";
import { attendanceModule, coreReportDatasets, outreachModule, type ReportDatasetDefinition } from "../packages/shared/src/module-platform.ts";
import { outreachSnapshot } from "./module-fixtures";

const definitions = [
  ...coreReportDatasets,
  combinedMemberDataset,
  ...(attendanceModule.reportDatasets ?? []),
  ...(outreachModule.reportDatasets ?? []),
];
const accessible = new Set(["core.members", combinedMemberDataset.id, ...(outreachModule.reportDatasets ?? []).map((dataset) => dataset.id)]);
const datasets = definitions.map((dataset) => ({ ...dataset, available: accessible.has(dataset.id), fields: dataset.fields.map((field) => { const sourceDataset = reportFieldSourceDataset(dataset.id, field.id) ?? dataset.id; const available = accessible.has(sourceDataset); return { ...field, sourceDataset, available, explanation: available ? undefined : "Attendance is unavailable for your current module access. It will return when access is restored." }; }) }));
const fieldCatalog = new Map<string, { field: ReportDatasetDefinition["fields"][number]; datasets: string[] }>();
for (const dataset of definitions) for (const field of dataset.fields) {
  const current = fieldCatalog.get(field.id) ?? { field, datasets: [] };
  current.datasets.push(dataset.id);
  fieldCatalog.set(field.id, current);
}
const columns = [...fieldCatalog.values()].map(({ field, datasets: fieldDatasets }) => ({
  key: field.id,
  label: field.label,
  group: field.group,
  sortable: field.sortable,
  filterKind: field.valueType === "number" ? "number" : "text",
  requiresLabel: field.requiresLabel,
  durationUnits: field.durationUnits,
  defaultDurationUnit: field.defaultDurationUnit,
  datasets: fieldDatasets,
}));

type Definition = {
  version: 2;
  dataset: string;
  groupBy: string[];
  period: { type: "all" } | { type: "last_days"; days: 7 | 30 | 60 | 90 };
  roster: "active" | "all";
  meetingType: "all" | "required" | "optional";
  labelIds: string[];
  labelMatch: "any" | "all";
  membership: "current" | "historical";
  columns: { key: string; labelId?: string; unit?: "minutes" | "hours" }[];
  columnFilters: { column: { key: string; labelId?: string; unit?: "minutes" | "hours" }; operator: "contains" | "minimum"; value: string }[];
  sort: { column: { key: string; labelId?: string; unit?: "minutes" | "hours" }; direction: "asc" | "desc" };
};

function definitionFor(datasetId: string): Definition {
  const dataset = datasets.find((item) => item.id === datasetId)!;
  return {
    version: 2,
    dataset: dataset.id,
    groupBy: [...dataset.groupBy],
    period: { type: "all" },
    roster: "active",
    meetingType: "all",
    labelIds: [],
    labelMatch: "any",
    membership: "current",
    columns: dataset.defaultColumns.map((key) => { const unit = dataset.fields.find((field) => field.id === key)?.defaultDurationUnit; return unit ? { key, unit } : { key }; }),
    columnFilters: [],
    sort: { column: (() => { const unit = dataset.fields.find((field) => field.id === dataset.defaultSort.field)?.defaultDurationUnit; return unit ? { key: dataset.defaultSort.field, unit } : { key: dataset.defaultSort.field }; })(), direction: dataset.defaultSort.direction },
  };
}

const values: Record<string, { id: string; label: string; href?: string; values: Record<string, string | number> }[]> = {
  "core.members": [
    { id: "member-1", label: "Avery Member", href: "/roster/M-001", values: { "core.member.name": "Avery Member", "core.member.id": "M-001", "core.member.status": "Active", "core.member.labels": "Mentor" } },
  ],
  "core.combined-members": [
    { id: "member-1", label: "Avery Member", href: "/roster/M-001", values: { "core.member.name": "Avery Member", "attendance.member.regular-rate": 92, "outreach.member.minutes": 165 } },
  ],
  "outreach.members": [
    { id: "member-1", label: "Avery Member", href: "/roster/M-001", values: { "core.member.name": "Avery Member", "outreach.member.minutes": 165, "outreach.member.entries": 2, "outreach.member.activities": 2, "outreach.member.supported-teams": 1, "outreach.member.last-service-date": "2026-09-20" } },
  ],
  "outreach.activities": [
    { id: "activity-1", label: "Community open house", values: { "outreach.activity.title": "Community open house", "outreach.activity.date": "2026-09-20", "outreach.activity.category": "Event", "outreach.activity.mode": "event", "outreach.activity.team": "N/A", "outreach.activity.participants": 2, "outreach.activity.entries": 2, "outreach.activity.minutes": 120 } },
    { id: "activity-2", label: "Team 901 design review", values: { "outreach.activity.title": "Team 901 design review", "outreach.activity.date": "2026-09-18", "outreach.activity.category": "Team Support", "outreach.activity.mode": "team support", "outreach.activity.team": "Robotics Team 901", "outreach.activity.participants": 1, "outreach.activity.entries": 1, "outreach.activity.minutes": 45 } },
  ],
  "outreach.entries": [
    { id: "entry-1", label: "Community open house", values: { "outreach.entry.member": "Avery Member", "outreach.entry.activity": "Community open house", "outreach.entry.date": "2026-09-20", "outreach.entry.minutes": 120, "outreach.entry.channel": "staff", "outreach.entry.status": "counted" } },
    { id: "entry-2", label: "Team 901 design review", values: { "outreach.entry.member": "Avery Member", "outreach.entry.activity": "Team 901 design review", "outreach.entry.date": "2026-09-18", "outreach.entry.minutes": 45, "outreach.entry.channel": "public", "outreach.entry.status": "counted" } },
  ],
  "outreach.teams": [
    { id: "team-901", label: "Robotics Team 901", values: { "outreach.team.name": "Robotics Team 901", "outreach.team.number": "901", "outreach.team.program": "FIRST", "outreach.team.participants": 1, "outreach.team.activities": 1, "outreach.team.entries": 1, "outreach.team.minutes": 45 } },
  ],
};

function reportResult(definition: Definition, pageSize: number | "all" = 25) {
  const dataset = datasets.find((item) => item.id === definition.dataset)!;
  const availability = new Map(dataset.fields.map((field) => [field.id, field]));
  const unavailableControls = [...definition.groupBy, definition.sort.column.key, ...definition.columnFilters.map((filter) => filter.column.key)].filter((key) => availability.get(key)?.available === false);
  const paused = !dataset.available || unavailableControls.length > 0;
  const selectedColumns = definition.columns.map((column) => {
    const item = columns.find((candidate) => candidate.key === column.key)!; const field = availability.get(column.key)!;
    return { id: column.key, key: column.key, label: field.durationUnits ? reportColumnLabel(column, item.label) : item.label, unit: column.unit, available: field.available, sourceDataset: field.sourceDataset, explanation: field.explanation };
  });
  let rows = paused ? [] : (values[definition.dataset] ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    href: row.href,
    cells: Object.fromEntries(definition.columns.map((column) => {
      const field = availability.get(column.key)!; const value = row.values[column.key] ?? "N/A";
      const displayed = column.unit === "hours" && typeof value === "number" ? Math.round(value / 60 * 100) / 100 : value;
      return [column.key, field.available ? { text: column.unit === "hours" && typeof displayed === "number" ? displayed.toFixed(2) : String(displayed), sortValue: displayed === "N/A" ? null : displayed } : { text: "Unavailable", sortValue: null, unavailable: true, explanation: field.explanation }];
    })),
  }));
  for (const filter of definition.columnFilters) rows = rows.filter((row) => {
    const value = row.cells[filter.column.key];
    return filter.operator === "minimum"
      ? typeof value?.sortValue === "number" && value.sortValue >= Number(filter.value)
      : value?.text.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
  });
  const sortKey = definition.sort.column.key;
  rows.sort((left, right) => {
    const a = left.cells[sortKey]?.sortValue;
    const b = right.cells[sortKey]?.sortValue;
    const order = typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""));
    return definition.sort.direction === "asc" ? order : -order;
  });
  return {
    state: paused ? "paused" : "ready",
    pausedReasons: paused ? ["Attendance is unavailable for your current module access. Results are paused because this source controls grouping, filtering, or sorting."] : [],
    definition,
    warnings: !paused && selectedColumns.some((column) => !column.available) ? ["Attendance is unavailable for your current module access. Affected columns are muted without cached or zero values."] : [],
    resolvedPeriod: { to: "2026-09-28" },
    columns: selectedColumns,
    rows,
    pagination: { page: 1, pageSize, totalRows: rows.length, totalPages: 1, rangeStart: rows.length ? 1 : 0, rangeEnd: rows.length },
  };
}

async function routeOutreachReports(page: Page, seen: Definition[]) {
  await page.route("**/platform/modules", (route) => route.fulfill({ json: outreachSnapshot() }));
  await page.route("**/reports/catalog", (route) => route.fulfill({ json: { datasets, columns, labels: [{ id: "mentor", name: "Mentor", active: 1 }], outreachLabels: [{ id: "community", name: "Community", archived: false }], baseline: null, timeZone: "America/New_York", defaultDefinition: definitionFor("outreach.members"), role: "admin", attendanceAvailable: false } }));
  await page.route("**/reports/views", (route) => route.fulfill({ json: { reports: [] } }));
  await page.route("**/reports/query", async (route) => {
    const body = route.request().postDataJSON() as { definition: Definition; pageSize?: number | "all" };
    seen.push(structuredClone(body.definition));
    await route.fulfill({ json: reportResult(body.definition, body.pageSize) });
  });
}

test("Outreach-only reports expose member, activity, entry, and supported-team datasets", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);

  await page.goto("/reports");
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Build a report" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Leaderboard", exact: true })).toHaveCount(0);
  for (const name of ["Members", "Members - combined", "Members - Outreach", "Outreach activities", "Outreach entries", "Supported teams"]) await expect(page.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();

  await page.locator(".report-dataset-cards article").filter({ hasText: "Members - Outreach" }).getByRole("button", { name: "Create report" }).click();
  await expect(page).toHaveURL(/\/reports\/new$/);
  const rows = page.getByRole("combobox", { name: "Report rows", exact: true });
  const memberTable = page.getByRole("table", { name: /Report results/ });
  await expect(rows).toHaveValue("outreach.members");
  await expect(page.getByRole("button", { name: "Outreach hours column options" })).toBeVisible();
  await expect(memberTable).toContainText("2.75");
  await page.getByRole("button", { name: "Outreach hours column options" }).click();
  await page.getByLabel("Units").selectOption("minutes");
  await page.getByRole("heading", { level: 2, name: "New report" }).click();
  await expect(page.getByRole("button", { name: "Outreach minutes column options" })).toBeVisible();
  await expect(memberTable).toContainText("165");
  await expect.poll(() => seen.at(-1)?.columns.find((column) => column.key === "outreach.member.minutes")?.unit).toBe("minutes");

  await rows.selectOption("outreach.activities");
  await expect(rows).toHaveValue("outreach.activities");
  await expect(page.getByRole("table", { name: /Report results/ })).toContainText("Community open house");
  await expect(page.getByRole("table", { name: /Report results/ })).toContainText("Distinct participants");

  await page.getByRole("button", { name: "Minutes column options" }).click();
  await page.getByLabel("Minimum").fill("60");
  await page.getByRole("heading", { level: 2, name: "New report" }).click();
  await expect.poll(() => seen.at(-1)?.columnFilters).toEqual([{ column: { key: "outreach.activity.minutes", unit: "minutes" }, operator: "minimum", value: "60" }]);
  await expect(page.getByRole("table", { name: /Report results/ })).not.toContainText("Team 901 design review");

  await rows.selectOption("outreach.teams");
  await expect(page.getByText("Supported-team participation totals from designated team-support activities.")).toBeVisible();
  const table = page.getByRole("table", { name: /Report results/ });
  await expect(table).toContainText("Robotics Team 901");
  await expect(table).toContainText("FIRST");
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await page.getByRole("checkbox", { name: "Entries", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(table).toContainText("Entries");

  await rows.selectOption("outreach.entries");
  await expect(table).toContainText("Submission channel");
  await expect(table).toContainText("public");
  await expect.poll(() => new Set(seen.map((definition) => definition.dataset))).toEqual(new Set(["outreach.members", "outreach.activities", "outreach.teams", "outreach.entries"]));

  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth);
});

test("combined reports mute unavailable columns and pause unavailable controls", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);

  await page.goto("/reports");
  await page.locator(".report-dataset-cards article").filter({ hasText: "Members - combined" }).getByRole("button", { name: "Create report" }).click();
  const table = page.getByRole("table", { name: /Report results/ });
  await expect(table).toContainText("Avery Member");
  await expect(table).toContainText("2.75");
  await expect(table).toContainText("Unavailable");
  const unavailable = page.getByRole("button", { name: /Regular attendance is unavailable/ });
  await expect(unavailable).toHaveAttribute("title", /Attendance is unavailable/);
  await expect(page.getByRole("button", { name: "Download report CSV" })).toBeEnabled();
  await page.getByRole("combobox", { name: "Membership" }).selectOption("historical");
  await expect.poll(() => seen.at(-1)?.membership).toBe("historical");
  await expect(table).toContainText("Avery Member");
  await expect(page.getByRole("button", { name: "Download report CSV" })).toBeEnabled();

  await unavailable.click();
  await page.getByRole("button", { name: "Descending" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(page.getByText(/definition and its controls have been preserved/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download report CSV" })).toBeDisabled();
  await expect.poll(() => seen.at(-1)?.sort.column.key).toBe("attendance.member.regular-rate");
});

test("saved reports keep unavailable module definitions editable while results and exports pause", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);
  const definition = definitionFor("attendance.members");
  await page.route("**/reports/views", (route) => route.fulfill({ json: { reports: [{ id: "attendance-history", ownerUserId: "admin-1", scope: "shared", name: "Attendance history", definition, revision: 3, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", pinnedPosition: 0, warnings: [], errors: [] }] } }));

  await page.goto("/reports/view/attendance-history");
  await expect(page.getByRole("heading", { level: 2, name: "Attendance history" })).toBeVisible();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(page.getByText(/dataset is unavailable for your current module access/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download report CSV" })).toBeDisabled();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Report rows" })).toHaveValue("attendance.members");
  await expect(page.getByRole("button", { name: /Regular attendance is unavailable/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

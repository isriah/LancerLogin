import { expect, test, type Page } from "@playwright/test";
import { filterAndSortReportRows, combinedMemberDataset, formatReportCellForColumn, reportDatasetDefinition, reportFieldSourceDataset } from "../apps/api/src/report-builder.ts";
import { reportColumnLabel } from "../apps/dashboard/src/saved-reports.ts";
import { attendanceModule, bundledModuleRegistry, coreReportDatasets, type ReportDatasetDefinition } from "../packages/shared/src/module-platform.ts";
import { outreachSnapshot } from "./module-fixtures";
import { requireOutreachPlugin } from "./outreach-fixtures";

// These reports cover Outreach datasets and the Outreach label filter, contributed by the official Outreach plugin.
requireOutreachPlugin();
const outreachModule = bundledModuleRegistry.get("hour-tracking");
const outreachLabelFilter = bundledModuleRegistry.reportFilters.find((filter) => filter.id === "outreach-labels");

const definitions = [
  ...coreReportDatasets,
  combinedMemberDataset,
  ...(attendanceModule.reportDatasets ?? []),
  ...(outreachModule?.reportDatasets ?? []),
].map((dataset) => reportDatasetDefinition(dataset.id) ?? dataset); // Core's catalog form, which adds H:MM to duration fields.
const accessible = new Set(["core.members", combinedMemberDataset.id, ...(outreachModule?.reportDatasets ?? []).map((dataset) => dataset.id)]);
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
  columns: { key: string; labelId?: string; unit?: "minutes" | "hours" | "hours_minutes" }[];
  columnFilters: { column: { key: string; labelId?: string; unit?: "minutes" | "hours" | "hours_minutes" }; operator: "contains" | "minimum" | "equals" | "maximum" | "between" | "empty" | "not_empty"; value: string; upperValue?: string }[];
  sort: { column: { key: string; labelId?: string; unit?: "minutes" | "hours" | "hours_minutes" }; direction: "asc" | "desc" };
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

function reportResult(definition: Definition, pageSize: number | "all" = 25, sources = datasets) {
  const dataset = sources.find((item) => item.id === definition.dataset)!;
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
      return [column.key, field.available ? formatReportCellForColumn(column, { text: String(value), sortValue: value === "N/A" ? null : value }) : { text: "Unavailable", sortValue: null, unavailable: true, explanation: field.explanation }];
    })),
  }));
  rows = filterAndSortReportRows(definition, rows);
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
  await page.route("**/reports/catalog", (route) => route.fulfill({ json: { datasets, columns, labels: [{ id: "mentor", name: "Mentor", active: 1 }], reportFilters: outreachLabelFilter ? [{ ...outreachLabelFilter, options: [{ id: "community", name: "Community", archived: false }] }] : [], baseline: null, timeZone: "America/New_York", defaultDefinition: definitionFor("outreach.members"), role: "admin", attendanceAvailable: false } }));
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
  for (const name of ["Members", "Outreach activities", "Outreach entries", "Supported teams"]) await expect(page.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
  await expect(page.locator(".report-dataset-cards article")).toHaveCount(4);

  await page.locator(".report-dataset-cards article").filter({ has: page.getByRole("heading", { name: "Members", exact: true }) }).getByRole("button", { name: "Create report" }).click();
  await expect(page).toHaveURL(/\/reports\/new$/);
  const rows = page.getByRole("combobox", { name: "Report type", exact: true });
  const memberTable = page.getByRole("table", { name: /Report results/ });
  await expect(rows).toHaveValue("core.combined-members");
  await expect(rows.locator("option").filter({ hasText: /Members/ })).toHaveCount(1);
  await expect(memberTable).not.toContainText("Unavailable");
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
  await expect(page.getByLabel("Minimum")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect.poll(() => seen.at(-1)?.columnFilters).toEqual([]);

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
  await expect.poll(() => new Set(seen.map((definition) => definition.dataset))).toEqual(new Set(["core.combined-members", "outreach.activities", "outreach.teams", "outreach.entries"]));

  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth);
});

test("combined reports mute unavailable columns and pause unavailable controls", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);

  await page.route("**/reports/views", (route) => route.fulfill({ json: { reports: [{ id: "combined-history", ownerUserId: "admin-1", scope: "shared", name: "Combined history", definition: definitionFor("core.combined-members"), revision: 1, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", pinnedPosition: 0, warnings: [], errors: [] }] } }));
  await page.goto("/reports/view/combined-history");
  const table = page.getByRole("table", { name: /Report results/ });
  await expect(table).toContainText("Avery Member");
  await expect(table).toContainText("2.75");
  await expect(table).toContainText("Unavailable");
  const unavailable = page.getByRole("button", { name: /Overall rate is unavailable/ });
  await expect(unavailable).toHaveAttribute("title", /Attendance is unavailable/);
  const exportMenu = page.locator(".report-menu").filter({ has: page.locator("summary").filter({ hasText: /^Export$/ }) });
  // Native details opens synchronously, before its queued toggle event updates React.
  const immediateDismissal = await exportMenu.evaluate(element => {
    const details = element as HTMLDetailsElement;
    const summary = details.querySelector("summary")!;
    summary.click();
    const opened = details.open;
    summary.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { opened, closed: !details.open, focusReturned: document.activeElement === summary };
  });
  expect(immediateDismissal).toEqual({ opened: true, closed: true, focusReturned: true });
  await openReportExport(page);
  await expect(page.getByRole("button", { name: "Download report CSV" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(exportMenu).not.toHaveAttribute("open");
  await page.getByRole("button", { name: /^Report period:/ }).click();
  await page.getByRole("dialog", { name: "Report period" }).getByRole("combobox", { name: "Membership" }).selectOption("historical");
  await page.getByRole("dialog", { name: "Report period" }).getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.membership).toBe("historical");
  await expect(table).toContainText("Avery Member");
  await openReportExport(page);
  await expect(page.getByRole("button", { name: "Download report CSV" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(exportMenu).not.toHaveAttribute("open");

  await unavailable.click();
  await page.getByRole("button", { name: "Descending" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(page.getByText(/definition and its controls have been preserved/i)).toBeVisible();
  await openReportExport(page);
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
  await openReportExport(page);
  await expect(page.getByRole("button", { name: "Download report CSV" })).toBeDisabled();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Report type" })).toHaveValue("core.combined-members");
  expect(seen[0].dataset).toBe("attendance.members");
  await expect(page.getByRole("button", { name: /Overall rate is unavailable/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByLabel("Report name").fill("Revised attendance history");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

async function openReportExport(page: Page) {
  const menu = page.locator(".report-menu").filter({ has: page.locator("summary").filter({ hasText: /^Export$/ }) });
  if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
}

test("saved Outreach member reports can add Roster and Attendance columns from the unified picker", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);
  const sources = datasets.map((dataset) => ({ ...dataset, available: true, fields: dataset.fields.map((field) => ({ ...field, available: true, explanation: undefined })) }));
  const definition = definitionFor("outreach.members");
  await page.route("**/reports/catalog", (route) => route.fulfill({ json: { datasets: sources, columns, labels: [], reportFilters: outreachLabelFilter ? [{ ...outreachLabelFilter, options: [] }] : [], baseline: null, timeZone: "America/New_York", defaultDefinition: definition, role: "admin", attendanceAvailable: true } }));
  await page.route("**/reports/views", (route) => route.fulfill({ json: { reports: [{ id: "outreach", ownerUserId: "admin-1", scope: "shared", name: "Outreach members", definition, revision: 1, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", pinnedPosition: 0, warnings: [], errors: [] }] } }));
  await page.route("**/reports/query", async (route) => {
    const body = route.request().postDataJSON(); seen.push(structuredClone(body.definition));
    await route.fulfill({ json: reportResult(body.definition, body.pageSize, sources) });
  });
  await page.goto("/reports/view/outreach");
  await expect(page.getByRole("table", { name: /Report results/ })).toContainText("2.75");
  expect(seen[0].dataset).toBe("outreach.members");
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  const pickerFields = combinedMemberDataset.fields.filter((field) => field.id !== "core.member.name");
  const labelFields = pickerFields.filter((field) => field.requiresLabel);
  expect(labelFields.length).toBeGreaterThan(0);
  for (const field of pickerFields.filter((field) => !field.requiresLabel)) {
    await expect(page.getByRole("checkbox", { name: reportColumnLabel({ key: field.id, unit: field.defaultDurationUnit }, field.label), exact: true })).toBeEnabled();
  }
  // Label-policy columns sit behind the "Single policy column" drill-in rather than the top-level list.
  await page.getByRole("button", { name: "Choose a single policy column", exact: true }).click();
  for (const field of labelFields) {
    await expect(page.getByRole("button", { name: `Choose labels for ${reportColumnLabel({ key: field.id, unit: field.defaultDurationUnit }, field.label)}`, exact: true })).toBeEnabled();
  }
  await page.getByRole("dialog", { name: "Add report column" }).getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("checkbox", { name: "Email", exact: true }).check();
  await page.getByRole("checkbox", { name: "Overall rate", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect.poll(() => seen.at(-1)?.dataset).toBe("core.combined-members");
  await expect(page.getByRole("table", { name: /Report results/ })).toContainText("92");
  expect(seen.at(-1)?.columns).toEqual([...definition.columns, { key: "core.member.email" }, { key: "attendance.member.regular-rate" }]);
  await openReportExport(page);
  await expect(page.getByRole("button", { name: "Download detailed attendance CSV" })).toBeEnabled();
});

test("legacy member reports keep their definition until a column edit and offer all accessible member fields", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);
  const definition = definitionFor("core.members");
  definition.roster = "all";
  definition.columnFilters = [{ column: { key: "core.member.name" }, operator: "contains", value: "Avery" }];
  await page.route("**/reports/views", (route) => route.fulfill({ json: { reports: [{ id: "roster", ownerUserId: "admin-1", scope: "shared", name: "Saved roster", definition, revision: 2, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", pinnedPosition: 0, warnings: [], errors: [] }] } }));
  await page.goto("/reports/view/roster");
  await expect(page.getByRole("table", { name: /Report results/ })).toContainText("Avery Member");
  expect(seen[0]).toMatchObject(definition);
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Email", exact: true })).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: /Overall rate/ })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Outreach hours", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect.poll(() => seen.at(-1)?.dataset).toBe("core.combined-members");
  expect(seen.at(-1)).toMatchObject({ roster: "all", period: definition.period, columnFilters: definition.columnFilters });
  expect(seen.at(-1)?.columns).toEqual([...definition.columns, { key: "outreach.member.minutes", unit: "hours" }]);
  await expect(page.getByRole("table", { name: /Report results/ })).toContainText("2.75");
  await expect(page.getByRole("button", { name: "Save view", exact: true })).toBeEnabled();
});


test("saved report column filters support ranges, empty values and unit conversion", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);
  const definition = definitionFor("outreach.activities");
  await page.route("**/reports/views", (route) => route.fulfill({ json: { reports: [{ id: "filters", ownerUserId: "admin-1", scope: "shared", name: "Filtered activities", definition, revision: 1, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", pinnedPosition: 0, warnings: [], errors: [] }] } }));
  await page.goto("/reports/view/filters");
  const table = page.getByRole("table", { name: /Report results/ });
  await expect(table).toContainText("Community open house");
  // Column menus keep sort, units, move and remove; filters open from each column's funnel button.
  await page.getByRole("button", { name: "Minutes column options" }).click();
  await expect(page.getByRole("combobox", { name: "Filter condition", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Filter Minutes", exact: true }).click();
  const minutes = page.getByRole("dialog", { name: "Filter Minutes" });
  await minutes.getByRole("combobox", { name: "Filter condition", exact: true }).selectOption("between");
  await minutes.getByLabel("From (minutes)", { exact: true }).fill("45");
  await expect(minutes.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await minutes.getByLabel("To (minutes)", { exact: true }).fill("120");
  await minutes.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.columnFilters).toEqual([{ column: { key: "outreach.activity.minutes", unit: "minutes" }, operator: "between", value: "45", upperValue: "120" }]);
  await expect(page.getByRole("button", { name: "Filter Minutes", exact: true })).toHaveClass(/is-active/);
  await page.getByRole("button", { name: "Minutes column options" }).click();
  await page.getByRole("combobox", { name: "Units", exact: true }).selectOption("hours");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Filter Hours", exact: true }).click();
  await expect(page.getByLabel("From (hours)", { exact: true })).toHaveValue("0.75");
  await expect(page.getByLabel("To (hours)", { exact: true })).toHaveValue("2");
  await page.keyboard.press("Escape");
  // H:MM shows hours and minutes but filters on minutes, so the range converts back and reads as H:MM.
  await page.getByRole("button", { name: "Hours column options" }).click();
  await page.getByRole("combobox", { name: "Units", exact: true }).selectOption("hours_minutes");
  await expect(page.getByRole("combobox", { name: "Units", exact: true }).locator("option:checked")).toHaveText("Hours and minutes (H:MM)");
  await page.keyboard.press("Escape");
  await expect.poll(() => seen.at(-1)?.columnFilters).toEqual([{ column: { key: "outreach.activity.minutes", unit: "hours_minutes" }, operator: "between", value: "45", upperValue: "120" }]);
  await expect(page.getByRole("button", { name: "Edit filter: Hours (H:MM) 0:45 to 2:00", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /Hours \(H:MM\)/ })).toBeVisible();
  await expect(table).toContainText("2:00"); await expect(table).toContainText("0:45");
  await page.getByRole("button", { name: "Filter Hours (H:MM)", exact: true }).click();
  const hoursMinutes = page.getByRole("dialog", { name: "Filter Hours (H:MM)" });
  await expect(hoursMinutes.getByLabel("From (H:MM)", { exact: true })).toHaveValue("0:45");
  await expect(hoursMinutes.getByLabel("To (H:MM)", { exact: true })).toHaveValue("2:00");
  await hoursMinutes.getByLabel("From (H:MM)", { exact: true }).fill("1:5");
  await expect(hoursMinutes.getByRole("alert")).toHaveText("Enter hours and minutes, like 1:30.");
  await expect(hoursMinutes.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await hoursMinutes.getByLabel("From (H:MM)", { exact: true }).fill("1:00");
  await hoursMinutes.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.columnFilters).toEqual([{ column: { key: "outreach.activity.minutes", unit: "hours_minutes" }, operator: "between", value: "60", upperValue: "120" }]);
  await page.getByRole("button", { name: "Hours (H:MM) column options" }).click();
  await page.getByRole("combobox", { name: "Units", exact: true }).selectOption("hours");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Filter Hours", exact: true }).click();
  const hours = page.getByRole("dialog", { name: "Filter Hours" });
  await expect(hours.getByLabel("From (hours)", { exact: true })).toHaveValue("1");
  await hours.getByRole("combobox", { name: "Filter condition", exact: true }).selectOption("maximum");
  await hours.getByLabel("Maximum (hours)", { exact: true }).fill("0.75");
  await hours.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.columnFilters[0]?.operator).toBe("maximum");
  await expect(table).not.toContainText("Community open house");
  await page.getByRole("button", { name: "Filter Hours", exact: true }).click();
  await hours.getByRole("button", { name: "Clear", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.columnFilters).toEqual([]);
  const activity = page.getByRole("dialog", { name: "Filter Activity" });
  await page.getByRole("button", { name: "Filter Activity", exact: true }).click();
  await activity.getByRole("combobox", { name: "Filter condition", exact: true }).selectOption("equals");
  await activity.getByLabel("Equals", { exact: true }).fill("community open house");
  await activity.getByLabel("Equals", { exact: true }).press("Enter");
  await expect(table).not.toContainText("Team 901 design review");
  await page.getByRole("button", { name: "Edit filter: Activity = community open house", exact: true }).click();
  await activity.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(table).toContainText("Team 901 design review");
  await page.getByRole("button", { name: "Filter Activity", exact: true }).click();
  await activity.getByRole("combobox", { name: "Filter condition", exact: true }).selectOption("empty");
  await expect(activity.getByLabel("Equals", { exact: true })).toHaveCount(0);
  await activity.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.columnFilters[0]).toMatchObject({ operator: "empty", value: "" });
  await expect(table).not.toContainText("Community open house");
  await page.getByRole("button", { name: "Filter Activity", exact: true }).click();
  await activity.getByRole("combobox", { name: "Filter condition", exact: true }).selectOption("not_empty");
  await activity.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(table).toContainText("Community open house");
  await expect(page.getByRole("button", { name: "Filter Activity", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(activity).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(activity).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter Activity", exact: true })).toBeFocused();
  // Outreach labels are a module list filter: a field in + Filter, not a column, with a "Not shown" chip.
  await page.getByRole("button", { name: "Add filter", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Add a filter" });
  await expect(picker.getByRole("button", { name: "Outreach labels (text)", exact: true })).toBeVisible();
  await picker.getByRole("button", { name: "Outreach labels (choose from a list)", exact: true }).click();
  const labels = page.getByRole("dialog", { name: "Filter Outreach labels" });
  await labels.getByRole("checkbox", { name: "Community", exact: true }).check();
  await labels.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.outreachLabelIds).toEqual(["community"]);
  await expect(page.getByRole("button", { name: "Edit filter: Outreach labels: Community", exact: true })).toContainText("Not shown");
  await page.getByRole("button", { name: "Remove filter: Outreach labels: Community", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.outreachLabelIds).toEqual([]);
  const serviceDate = page.getByRole("dialog", { name: "Filter Service date" });
  await page.getByRole("button", { name: "Filter Service date", exact: true }).click();
  await serviceDate.getByRole("combobox", { name: "Filter condition", exact: true }).selectOption("between");
  await serviceDate.getByLabel("From", { exact: true }).fill("2026-09-19");
  await serviceDate.getByLabel("To", { exact: true }).fill("2026-09-20");
  await serviceDate.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(table).toContainText("Community open house");
  await expect(table).not.toContainText("Team 901 design review");
  await page.getByRole("button", { name: "Edit filter: Service date 2026-09-19 to 2026-09-20", exact: true }).click();
  for (const theme of ["light", "dark"]) for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.locator(".app").evaluate((element, theme) => { element.setAttribute("data-theme", theme); (element as HTMLElement).style.setProperty("--primary", "#176b55"); (element as HTMLElement).style.setProperty("--secondary", "#a16f32"); }, theme);
    const clear = serviceDate.getByRole("button", { name: "Clear", exact: true });
    await clear.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await clear.focus();
    await expect(clear).toBeFocused();
    const style = await clear.evaluate((element) => {
      const actual = getComputedStyle(element); const probe = document.createElement("span"); element.append(probe);
      probe.style.cssText = "background:var(--ui-surface-subtle);color:var(--ui-text);border:1px solid var(--ui-border);border-radius:var(--radius-control)";
      const expected = getComputedStyle(probe);
      const result = { background: actual.backgroundColor, text: actual.color, border: actual.borderTopColor, radius: actual.borderRadius, height: element.getBoundingClientRect().height, expectedBackground: expected.backgroundColor, expectedText: expected.color, expectedBorder: expected.borderTopColor, expectedRadius: expected.borderRadius };
      probe.remove(); return result;
    });
    expect(style.background).toBe(style.expectedBackground); expect(style.text).toBe(style.expectedText); expect(style.border).toBe(style.expectedBorder); expect(style.radius).toBe(style.expectedRadius); expect(style.height).toBeGreaterThanOrEqual(44);
    const bounds = (await serviceDate.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    const width = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth);
  }
});

test("each report names its module's baseline and a mixed Members report chooses one for the whole report", async ({ page }) => {
  const seen: Definition[] = [];
  await routeOutreachReports(page, seen);
  const owner = (id: string) => id === "attendance.members" ? "attendance" : id.startsWith("outreach.") ? "hour-tracking" : undefined;
  const sources = datasets.map((dataset) => ({ ...dataset, baselineModule: owner(dataset.id), available: true, fields: dataset.fields.map((field) => ({ ...field, available: true, explanation: undefined })) }));
  const baseline = { type: "baseline" } as unknown as Definition["period"];
  const combined = { ...definitionFor("core.combined-members"), period: baseline };
  const activities = { ...definitionFor("outreach.activities"), period: baseline };
  await page.route("**/reports/catalog", (route) => route.fulfill({ json: { datasets: sources, columns, labels: [], reportFilters: outreachLabelFilter ? [{ ...outreachLabelFilter, options: [] }] : [], baseline: "2026-09-01", baselines: [{ moduleId: "attendance", label: "Attendance", startsOn: "2026-09-01" }, { moduleId: "hour-tracking", label: "Outreach", startsOn: "2026-08-15" }], today: "2026-11-03", timeZone: "America/New_York", defaultDefinition: combined, role: "admin", attendanceAvailable: true } }));
  const saved = (id: string, name: string, definition: Definition, pinnedPosition: number) => ({ id, ownerUserId: "admin-1", scope: "shared", name, definition, revision: 1, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z", pinnedPosition, warnings: [], errors: [] });
  await page.route("**/reports/views", (route) => route.fulfill({ json: { reports: [saved("combined", "Members by module", combined, 0), saved("activities", "Outreach activities", activities, 1)] } }));
  await page.route("**/reports/query", async (route) => {
    const body = route.request().postDataJSON(); seen.push(structuredClone(body.definition));
    await route.fulfill({ json: reportResult(body.definition, body.pageSize, sources) });
  });

  const scope = page.locator(".report-period-chip");
  const periodDialog = page.getByRole("dialog", { name: "Report period" });
  await page.goto("/reports/view/activities");
  await expect(scope).toContainText("Outreach baseline (2026-08-15)");
  await scope.click();
  await expect(periodDialog.getByRole("combobox", { name: "Period", exact: true }).locator("option:checked")).toHaveText("Outreach baseline");
  await expect(periodDialog.getByRole("combobox", { name: "Baseline", exact: true })).toHaveCount(0);
  // Outreach activities have no label membership, so the period popover offers none.
  await expect(periodDialog.getByRole("combobox", { name: "Membership", exact: true })).toHaveCount(0);

  await page.goto("/reports/view/combined");
  await expect(scope).toContainText("Attendance baseline (2026-09-01)");
  await scope.click();
  await expect(periodDialog.getByRole("combobox", { name: "Period", exact: true }).locator("option:checked")).toHaveText("Attendance baseline");
  const choice = periodDialog.getByRole("combobox", { name: "Baseline", exact: true });
  await expect(choice.locator("option")).toHaveText(["Attendance baseline (2026-09-01)", "Outreach baseline (2026-08-15)"]);
  await expect(periodDialog.getByText("This report has columns from more than one module, so one baseline sets the period for every column.")).toBeVisible();
  await choice.selectOption("hour-tracking");
  await periodDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.period).toEqual({ type: "baseline", module: "hour-tracking" });
  await expect(scope).toContainText("Outreach baseline (2026-08-15)");
  await scope.click();
  await periodDialog.getByRole("combobox", { name: "Period", exact: true }).selectOption("last_30");
  await expect(choice).toHaveCount(0);
  await periodDialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => seen.at(-1)?.period).toEqual({ type: "last_days", days: 30 });

});

import type { ReportCatalog, ReportDataset, ReportDefinition } from "./saved-reports";

const memberIdentity = "core.member.identity";

export function isMemberReport(catalog: ReportCatalog, datasetId: string): boolean {
  return catalog.datasets.some((dataset) => dataset.id === datasetId && dataset.rowIdentity === memberIdentity);
}

export function membersDataset(catalog: ReportCatalog): ReportDataset | undefined {
  return catalog.datasets.find((dataset) => dataset.id === "core.combined-members")
    ?? catalog.datasets.find((dataset) => dataset.rowIdentity === memberIdentity);
}

export function reportDisplayDataset(catalog: ReportCatalog, datasetId: string): ReportDataset {
  const original = catalog.datasets.find((dataset) => dataset.id === datasetId)!;
  if (original.rowIdentity !== memberIdentity) return original;
  return {
    ...membersDataset(catalog)!,
    label: "Members",
    description: "One row per member. Add roster, Attendance and Outreach columns from the modules you can access.",
    available: original.available,
  };
}

export function reportTypes(catalog: ReportCatalog): ReportDataset[] {
  const members = membersDataset(catalog);
  return catalog.datasets.filter((dataset) => dataset.rowIdentity !== memberIdentity || dataset.id === members?.id)
    .map((dataset) => reportDisplayDataset(catalog, dataset.id));
}

// Opening a saved report keeps its original query. A definition edit enables the
// shared member field catalog without changing its columns, filters or period.
export function useMemberFields(definition: ReportDefinition, catalog: ReportCatalog): void {
  const members = membersDataset(catalog);
  if (!members || !isMemberReport(catalog, definition.dataset)) return;
  definition.dataset = members.id;
  definition.groupBy = [...members.groupBy];
}

import type { ReportCatalog, ReportDefinition } from "./saved-reports.ts";

// Which module's reporting start date (operational baseline) a report's Operational baseline period uses, mirroring
// reportBaselineModule in the API: a single-module report uses its owner's; a combined Members report uses one module's
// date for the whole report, the saved choice or else the first that has started (Attendance first).
export type ReportBaselineInfo = { moduleId: string; label: string; startsOn: string | null };
const combinedDatasetId = "core.combined-members";

/** Every module's reporting start date, Attendance first; older APIs report only Attendance's. */
export function catalogBaselines(catalog: Pick<ReportCatalog, "baselines" | "baseline">): ReportBaselineInfo[] {
  return catalog.baselines ?? [{ moduleId: "attendance", label: "Attendance", startsOn: catalog.baseline }];
}

export const baselineStarted = (startsOn: string | null | undefined, today: string | undefined) => Boolean(startsOn && (!today || startsOn <= today));

/** The modules a combined Members report can take its baseline from: those its columns come from, else all of them. */
export function combinedBaselineChoices(catalog: Pick<ReportCatalog, "baselines" | "baseline" | "datasets">, definition: Pick<ReportDefinition, "dataset" | "columns">): ReportBaselineInfo[] {
  const all = catalogBaselines(catalog); const dataset = catalog.datasets.find((item) => item.id === definition.dataset);
  const owners = new Set(definition.columns.map((column) => dataset?.fields.find((field) => field.id === column.key)?.sourceDataset).map((source) => catalog.datasets.find((item) => item.id === source)?.baselineModule).filter((id): id is string => Boolean(id)));
  const used = all.filter((item) => owners.has(item.moduleId));
  return used.length ? used : all;
}

/** The baseline a definition uses, or undefined when its dataset has none (Core members). */
export function definitionBaseline(catalog: Pick<ReportCatalog, "baselines" | "baseline" | "datasets" | "today">, definition: Pick<ReportDefinition, "dataset" | "columns" | "period">): ReportBaselineInfo | undefined {
  const all = catalogBaselines(catalog);
  if (definition.dataset !== combinedDatasetId) { const owner = catalog.datasets.find((item) => item.id === definition.dataset)?.baselineModule ?? (catalog.baselines ? undefined : "attendance"); return all.find((item) => item.moduleId === owner); }
  const chosen = definition.period.type === "baseline" ? definition.period.module : undefined;
  const choices = combinedBaselineChoices(catalog, definition);
  return all.find((item) => item.moduleId === chosen) ?? choices.find((item) => baselineStarted(item.startsOn, catalog.today)) ?? choices.find((item) => item.startsOn) ?? choices[0];
}

/** "Outreach baseline (2026-09-01)", or "Operational baseline" when the dataset has none. */
export function baselinePeriodText(baseline: ReportBaselineInfo | undefined): string {
  if (!baseline) return "Operational baseline";
  return `${baseline.label} baseline${baseline.startsOn ? ` (${baseline.startsOn})` : " (not set)"}`;
}

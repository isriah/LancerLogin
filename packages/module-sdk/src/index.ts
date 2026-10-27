// Module manifests: the declarations Core validates before composing a module.
// Report field helpers for manifests. They come from a module that imports no installed manifests, so a manifest can call
// them while Core is still loading the installed manifests.
export { coreMemberReportFieldDefinitions, reportFilterOperators } from "../../shared/src/module-report-fields.ts";
export type {
  ModuleApiRouteDefinition,
  ModuleCapabilityDefinition,
  ModuleDefinition,
  ModuleDiscordCommandDefinition,
  ModuleLifecyclePhase,
  ReportDatasetDefinition,
  ReportDurationUnit,
  ReportFieldDefinition,
  ReportFilterOperator,
  ReportModuleFilterDefinition,
  ModuleSnapshotItem,
} from "../../shared/src/module-platform.ts";
import type { ModuleDefinition } from "../../shared/src/module-platform.ts";

// Civil-time conversion shared by Worker and dashboard code: wall-clock dates and times in an IANA time zone, with explicit
// handling of repeated and skipped local times. Callers keep the zone and the selected instant.
export { addCalendarDays, CivilTimeError, elapsedIntegerMinutes, instantToCivil, resolveCivilTime, selectCivilTime } from "../../shared/src/civil-time.ts";
export type { CivilTimeCandidate, CivilTimeErrorCode, CivilTimeFields, CivilTimeInput, CivilTimeOccurrence } from "../../shared/src/civil-time.ts";

/** Identity helper that type-checks a module manifest. */
export function defineModuleManifest<const Manifest extends ModuleDefinition>(manifest: Manifest): Manifest {
  return manifest;
}

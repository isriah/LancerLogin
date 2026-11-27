// Module manifests: the declarations Core validates before composing a module.
// Report field helpers for manifests. They come from a module that imports no installed manifests, so a manifest can call
// them while Core is still loading the installed manifests.
export { coreMemberReportFieldDefinitions, reportFilterOperators } from "../../shared/src/module-report-fields.ts";
export type {
  ModuleApiRouteDefinition,
  ModuleCapabilityDefinition,
  ModuleDefinition,
  ModuleDiscordCommandDefinition,
  ModuleInterfaceDefinition,
  ModuleInterfaceOperationDefinition,
  ModuleInterfaceUse,
  ModuleLifecyclePhase,
  ModuleNotionBindingDefinition,
  ModuleNotionDefinition,
  ModuleNotionOperation,
  ModuleNotionUserOperation,
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

// The CSV import kit's parsers (SDK 1.4.0), for a module Worker that checks imported rows again. The dashboard entry adds the template download.
export { csvFieldFor, csvText, delimiterFor, formatCsvDate, formatCsvTime, formatCsvTimeRange, mapCsvHeader, normaliseCsvHeader, parseCsvDate, parseCsvDuration, parseCsvTime, parseDelimited } from "../../shared/src/csv-import.ts";
export type { CsvHeaderMapping, CsvHeaderSpec, CsvValue } from "../../shared/src/csv-import.ts";

// Notion ID and link helpers (SDK 1.8.0), for Worker and dashboard code alike. They call nothing: `parseNotionId` reads the
// ID out of a Notion link or bare ID, `formatNotionId` and `sameNotionId` normalize and compare IDs, `notionLink` builds a
// link from an ID, `validNotionUrl` accepts only https links on Notion's hosts, and `decodedNotionPropertyId` compares
// property IDs that Notion reports encoded in some places and plain in others.
export { decodedNotionPropertyId, formatNotionId, notionLink, parseNotionId, sameNotionId, validNotionUrl } from "../../shared/src/notion-ids.ts";
export type { NotionIdResult } from "../../shared/src/notion-ids.ts";

/** Identity helper that type-checks a module manifest. */
export function defineModuleManifest<const Manifest extends ModuleDefinition>(manifest: Manifest): Manifest {
  return manifest;
}

// Worker-side module interfaces. Plugins import only from this SDK, never from Core source.
export type { D1Database, D1Result, D1Statement } from "../../../apps/api/src/d1-usage.ts";
export { HttpError } from "../../../apps/api/src/http-error.ts";
export type {
  ApiModuleContribution,
  CoreModuleServices,
  ModuleJobContext,
  ModuleLifecycleContext,
  ModulePrincipal,
  ModuleRole,
  ModuleRouteContext,
  ModuleRouteHandler,
  ModuleSetupBinding,
  SqlPredicate,
  ModuleBackupAdapter,
  ModuleBackupRestoreContext,
  ModuleBackupSource,
  ModuleBackupTables,
  ModuleReportFilterHandler,
  ModuleReportFilterOption,
  ModuleRosterReferences,
} from "../../../apps/api/src/module-contributions.ts";
export type { CleanupStep } from "../../../apps/api/src/module-cleanup.ts";
export type { ModuleCredentials } from "../../../apps/api/src/integration-crypto.ts";
export type { DiscordModuleInteraction, DiscordModuleInteractionHandler } from "../../../apps/api/src/module-discord.ts";
export type { ReportProjectionContext, ReportProjectionHandler, ReportRosterMember } from "../../../apps/api/src/module-reporting.ts";

// Report projection helpers. Member-level datasets read roster fields and label membership with `reportRosterData`, fill the
// shared roster cells with `reportMemberValues`, apply Core's roster and label filters with `reportMemberIncluded`, read their
// own module filter with `reportFilterSelection`, build rows with `reportRow`, and finish with `filterAndSortReportRows`.
export { reportMemberIncluded, reportMemberValues, reportRosterData, reportRow } from "../../../apps/api/src/module-reporting.ts";
export { filterAndSortReportRows, reportFilterSelection } from "../../../apps/api/src/report-builder.ts";
export type { NormalizedReportDefinition, ReportCell, ReportResultRow } from "../../../apps/api/src/report-builder.ts";

// Permission-scoped Core projections. Pass the module's captured database from the request or job context.
export { activeRosterIdentity, listActiveRosterIdentities } from "../../../apps/api/src/core-roster-projection.ts";
export { createMeetingReferenceAccess, type MeetingReference, type MeetingReferenceAccess } from "../../../apps/api/src/attendance-meeting-reference.ts";

import type { ApiModuleContribution } from "../../../apps/api/src/module-contributions.ts";

/**
 * Identity helper that type-checks a module's Worker contribution. External modules receive no Worker environment: Core
 * passes them none, and composition refuses `cloudflare:` imports such as `cloudflare:workers`, which would expose it.
 * Plugins are still fully trusted code; this keeps Core secrets out of reach by accident, not by sandboxing.
 */
export function defineApiModule<Environment = unknown>(contribution: ApiModuleContribution<Environment>): ApiModuleContribution<Environment> {
  return contribution;
}

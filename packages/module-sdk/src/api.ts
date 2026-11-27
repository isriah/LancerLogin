// Worker-side module interfaces. Plugins import only from this SDK, never from Core source.
export type { D1Database, D1Result, D1Statement } from "../../../apps/api/src/d1-usage.ts";
export { HttpError } from "../../../apps/api/src/http-error.ts";
export type {
  ApiModuleContribution,
  CoreModuleServices,
  ModuleInterfaceCallContext,
  ModuleInterfaceCaller,
  ModuleInterfaceClient,
  ModuleInterfaceHandler,
  ModuleJobContext,
  ModuleJobScheduler,
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
export type { ModuleEmailMessage } from "../../../apps/api/src/module-email.ts";
export type { FirstDataService, FirstLegacyCredential, FirstLookup, FirstProgram, FirstProgramStatus, FirstSearchResult, FirstTeam, FirstUnavailableReason } from "../../../apps/api/src/first-data.ts";
// From SDK 1.8.0: Notion through Core's one connection (`services.notion`). Declare databases in the manifest's `notion` field.
export type { NotionBinding, NotionCapabilities, NotionCapability, NotionCapabilityState, NotionLegacyConnection, NotionQuery, NotionService, NotionServiceStatus, NotionUser } from "../../../apps/api/src/module-notion.ts";
export type { NotionJson } from "../../../apps/api/src/notion-client.ts";
export type { DiscordModuleInteraction, DiscordModuleInteractionHandler } from "../../../apps/api/src/module-discord.ts";
export type { ReportProjectionContext, ReportProjectionHandler, ReportRosterMember } from "../../../apps/api/src/module-reporting.ts";

// Report projection helpers. Member-level datasets read roster fields and label membership with `reportRosterData`, fill the
// shared roster cells with `reportMemberValues`, apply Core's roster and label filters with `reportMemberIncluded`, read their
// own module filter with `reportFilterSelection`, build rows with `reportRow`, and finish with `filterAndSortReportRows`.
export { reportMemberIncluded, reportMemberValues, reportRosterData, reportRow } from "../../../apps/api/src/module-reporting.ts";
export { filterAndSortReportRows, reportFilterSelection } from "../../../apps/api/src/report-builder.ts";
export type { NormalizedReportDefinition, ReportCell, ReportResultRow } from "../../../apps/api/src/report-builder.ts";

// Permission-scoped Core projections. Pass the module's captured database from the request or job context.
export { activeRosterIdentity, listActiveRosterIdentities, listActiveRosterWithLabels, type ActiveRosterMemberWithLabels } from "../../../apps/api/src/core-roster-projection.ts";
// From SDK 1.7.0: one organization-local day of Attendance, read-only; each returns undefined while Attendance is unavailable.
export { expectedMembersForDay, meetingsOnLocalDate, presentMembersForDay, type AttendanceDayOptions, type DayExpectation, type DayExpectationReason, type DayMeeting, type DayPresence } from "../../../apps/api/src/attendance-day-projection.ts";
export { installationTimeZone } from "../../../apps/api/src/core-installation-projection.ts";
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

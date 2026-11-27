import { validateInactivePeriods } from "../member-participation.ts";
import { removedWalkthroughPages, validWalkthroughProgress } from "../../../../packages/shared/src/walkthrough.ts";
import { discordCodeBackups } from "../discord-kiosk-codes.ts";
import { DEFAULT_ANOMALY_THRESHOLD_MINUTES, DEFAULT_EARLY_SCAN_MINUTES } from "../attendance-lifecycle.ts";
import { validEarlyScanMinutes } from "../attendance-allowances.ts";
import { participationStartDate, validDate } from "../attendance-policy.ts";
import { reportDatasetDefinition, validateReportDefinition } from "../report-builder.ts";
import { HttpError } from "../http-error.ts";
import { extractedModuleTables, extractedModules, liftExtractedModules, unavailableExtractedWalkthroughPages } from "../extracted-modules.ts";
import type { ModuleDefinition } from "../../../../packages/shared/src/module-platform.ts";
import { stagedPayload } from "../data-transfer.ts";
import { externalModuleBackupSchema, firstPartyBackupRegistry, parseExternalModuleSection, planExternalModuleRestore, prepareIncludedModule, removeExcludedModuleRows, requireConfirmedExclusions, type ExcludedModuleSummary, type PreparedExternalModule } from "../module-backup.ts";
import { type BackupScope, type BackupTable, backupEnvelopeFormat, backupEnvelopeVersion, backupOwnership, backupSchemaVersion, backupTableAt, installationTables, installedExternalBackupModuleIds, installedExternalBackupModules, meetingTables, rosterTables, safeBackupValue, tableColumns, tablesForScope } from "./backup.ts";
import { type KioskAuthenticationMethod, isObject, kioskAuthenticationMethods, kioskKinds, kioskMemberLookups, validTimeZone, validTimestamp } from "./core.ts";
import { parseStoredReportDefinition } from "./reports.ts";


export type NormalizedBackup = { product: "LancerLogin"; schemaVersion: number; scope: BackupScope; exportedAt: string; /** How the file's rows are shaped (the schema its columns follow), and which of its tables are uploaded in parts. */ source: { schemaVersion: number; community22: boolean; exactColumns: boolean; staged: BackupTable[] }; attendanceRecentDays: number; attendancePolicyActivatedOn: string | null; tables: Record<BackupTable, Record<string, unknown>[]>; recovery: { revokedKiosks: number; invalidatedPairingCodes: number; pausedProviderOperations: number }; externalModules: { included: readonly PreparedExternalModule[]; excluded: readonly ExcludedModuleSummary[] } };
const legacyTableColumns: Partial<Record<BackupTable, readonly string[]>> = {
  organization_settings: tableColumns.organization_settings.slice(0, -17),
  attendance_events: tableColumns.attendance_events.slice(0, -1),
  discord_attendance_contests: tableColumns.discord_attendance_contests.slice(0, -3),
};
const legacyInstallationTables = installationTables.filter((table) => !["member_labels", "member_label_changes", "discord_label_role_mappings", "label_weekly_targets", "label_attendance_rules", "saved_report_views", "saved_report_tabs", "meeting_audience_labels", "meeting_weight_categories", "meeting_templates", "discord_attendance_notifications", "discord_attendance_recipients", "discord_anomaly_reports", "google_calendar_authorizations", "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations"].includes(table));
const legacyMeetingTables = meetingTables.filter((table) => !["meeting_audience_labels", "meeting_weight_categories", "meeting_templates", "discord_attendance_notifications", "discord_attendance_recipients", "discord_anomaly_reports"].includes(table));
const legacyTablesForScope = (scope: BackupScope) => scope === "installation" ? legacyInstallationTables : scope === "meetings" ? legacyMeetingTables : rosterTables;

function canonicalBackupJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBackupJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalBackupJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const portableAuthorityValue = (value: unknown, minimum: number) => Number.isSafeInteger(value)
  && Number(value) >= minimum
  && Number(value) < Number.MAX_SAFE_INTEGER - 1;

function validatePortableTableScope(tables: Record<BackupTable, Record<string, unknown>[]>, scope: BackupScope) {
  for (const table of tablesForScope(scope)) for (const row of tables[table]) {
    const installationId = table === "installations" ? row.id : row.installation_id;
    if (installationId !== "primary") throw new HttpError(400, `Backup table ${table} is not scoped to this installation`);
  }
}

function validateInstallationBackupState(tables: Record<BackupTable, Record<string, unknown>[]>, includedExternalModules: readonly ModuleDefinition[] = []) {
  if (tables.installations.length !== 1 || tables.platform_module_administration.length !== 1 || tables.platform_module_administration_epochs.length !== 1) throw new HttpError(400, "Backup module administration state is incomplete");
  const administration = tables.platform_module_administration[0]!; const administrationEpoch = tables.platform_module_administration_epochs[0]!;
  if (!portableAuthorityValue(administration.revision, 0) || administration.revision !== administrationEpoch.revision || ![0, 1].includes(Number(administration.selection_completed))) throw new HttpError(400, "Backup module administration authority is invalid");
  // First-party modules plus installed external modules restored from this backup. Excluded modules' rows were removed beforehand.
  const definitions = new Map([...firstPartyBackupRegistry.modules, ...includedExternalModules].map((module) => [module.id, module]));
  const modules = new Map<string, Record<string, unknown>>(); const epochs = new Map<string, Record<string, unknown>>();
  for (const row of tables.platform_module_epochs) {
    const id = String(row.module_id); if (!definitions.has(id) || epochs.has(id) || !portableAuthorityValue(row.generation, 1)) throw new HttpError(400, "Backup module generation authority is invalid");
    epochs.set(id, row);
  }
  for (const row of tables.platform_modules) {
    const id = String(row.module_id); const definition = definitions.get(id); const phase = String(row.phase);
    if (!definition || modules.has(id) || row.contract_version !== definition.contractVersion || row.setup_version !== definition.setup.version || row.generation !== epochs.get(id)?.generation || !["disabled", "enabled", "retained", "deleting", "deleted"].includes(phase) || ![0, 1].includes(Number(row.setup_complete)) || !Number.isSafeInteger(row.deletion_cursor) || Number(row.deletion_cursor) < 0 || Number(row.deletion_cursor) > definition.lifecycle.cleanupTargets.length || row.cleanup_failure !== null && row.cleanup_failure !== "retry-required") throw new HttpError(400, "Backup module lifecycle state is invalid");
    const hasCountdown = phase === "retained" || phase === "deleting";
    if (hasCountdown) {
      const disabledAt = Date.parse(String(row.disabled_at)); const deleteAfter = Date.parse(String(row.delete_after));
      if (!Number.isFinite(disabledAt) || deleteAfter - disabledAt !== 7 * 86_400_000) throw new HttpError(400, "Backup module retention state is invalid");
    } else if (row.disabled_at !== null || row.delete_after !== null || phase === "deleted" && row.deletion_cursor !== 0) throw new HttpError(400, "Backup module retention state is invalid");
    modules.set(id, row);
  }
  if (modules.size !== definitions.size || epochs.size !== definitions.size) throw new HttpError(400, "Backup module registrations do not match this application");
  for (const [id, definition] of definitions) if (String(modules.get(id)?.phase) === "enabled" && definition.dependencies.some((dependency) => String(modules.get(dependency)?.phase) !== "enabled")) throw new HttpError(400, "Backup module dependencies are invalid");

  const users = new Map(tables.users.map((row) => [String(row.id), row]));
  const assignmentEpochs = new Map<string, Record<string, unknown>>(); const assignmentRevisions = new Map<string, Record<string, unknown>>();
  for (const row of tables.platform_module_assignment_epochs) {
    const userId = String(row.user_id); if (assignmentEpochs.has(userId) || !portableAuthorityValue(row.revision, 0)) throw new HttpError(400, "Backup assignment authority is invalid");
    assignmentEpochs.set(userId, row);
  }
  for (const row of tables.platform_module_assignment_revisions) {
    const userId = String(row.user_id); if (!users.has(userId) || assignmentRevisions.has(userId) || row.revision !== assignmentEpochs.get(userId)?.revision) throw new HttpError(400, "Backup assignment authority is invalid");
    assignmentRevisions.set(userId, row);
  }
  if ([...users].some(([userId]) => !assignmentRevisions.has(userId))) throw new HttpError(400, "Backup assignment authority is incomplete");
  const assignments = new Set<string>();
  for (const row of tables.platform_module_assignments) {
    const userId = String(row.user_id); const moduleId = String(row.module_id); const definition = definitions.get(moduleId); let capabilities: unknown;
    try { capabilities = JSON.parse(String(row.capabilities_json)); } catch { throw new HttpError(400, "Backup module assignment is invalid"); }
    const key = `${userId}:${moduleId}`;
    if (!definition || !users.has(userId) || users.get(userId)?.role !== "operator" || String(modules.get(moduleId)?.phase) !== "enabled" || assignments.has(key) || !Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string" || !definition.capabilities.some((item) => item.operator && item.id === capability))) throw new HttpError(400, "Backup module assignment is invalid");
    assignments.add(key);
  }
  const setup = new Set<string>();
  for (const row of tables.platform_module_setup_progress) {
    const moduleId = String(row.module_id); const stepId = String(row.step_id); const definition = definitions.get(moduleId); const key = `${moduleId}:${stepId}`;
    if (!definition || setup.has(key) || row.setup_version !== definition.setup.version || !definition.setup.steps.some((step) => step.id === stepId) || !["completed", "skipped"].includes(String(row.outcome))) throw new HttpError(400, "Backup module setup progress is invalid");
    setup.add(key);
  }
  for (const definition of definitions.values()) if (modules.get(definition.id)?.setup_complete === 1 && definition.setup.steps.some((step) => step.required && !setup.has(`${definition.id}:${step.id}`))) throw new HttpError(400, "Backup module setup progress is incomplete");
}

/**
 * Tables a restore may upload in parts (data-transfer.ts): the ones that grow with every meeting, scan and audited action.
 * Nothing about one of their rows depends on another row or table, so each part is checked and normalized alone
 * (normalizeStagedPart), exactly as normalizeBackup does for rows the backup document carries itself.
 */
export const stagedBackupTables: ReadonlySet<BackupTable> = new Set<BackupTable>(["meetings", "meeting_audience_labels", "attendance_events", "attendance_corrections", "member_label_changes", "audit_log", "integration_deliveries", "integration_state", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports", "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations"]);

/** The columns a table's rows carry in a backup of the given schema. */
function backupSourceColumns(table: BackupTable, schemaVersion: number, community22: boolean): readonly string[] {
  return schemaVersion < 45 && (table === "member_label_changes" || table === "discord_label_role_mappings") ? tableColumns[table].slice(0, -1) : table === "discord_attendance_contests" && schemaVersion < 41 ? tableColumns.discord_attendance_contests.slice(0, schemaVersion === 1 ? -3 : -1) : community22 && ["discord_attendance_notifications", "discord_attendance_recipients"].includes(table) ? tableColumns[table] : schemaVersion < 7 && table === "installations" ? tableColumns.installations.slice(0, -4) : schemaVersion < 12 && table === "installations" ? tableColumns.installations.slice(0, -1) : schemaVersion < 23 && table === "platform_modules" ? tableColumns.platform_modules.slice(0, -2) : table === "kiosks" && schemaVersion < 52 ? tableColumns.kiosks.slice(0, schemaVersion < 28 ? -8 : schemaVersion < 31 ? -7 : schemaVersion < 40 ? -6 : schemaVersion < 46 ? -5 : schemaVersion < 47 ? -3 : -2) : table === "pairing_codes" && schemaVersion < 46 ? tableColumns.pairing_codes.slice(0, -2) : schemaVersion < 14 && table === "members" ? tableColumns.members.slice(0, -2) : schemaVersion < 34 && table === "members" ? tableColumns.members.slice(0, -1) : schemaVersion < 19 && table === "users" ? tableColumns.users.slice(0, -1) : schemaVersion === 1 ? legacyTableColumns[table] ?? (table === "meetings" ? tableColumns.meetings.slice(0, -9) : table === "encrypted_integrations" ? tableColumns.encrypted_integrations.slice(0, -1) : tableColumns[table]) : schemaVersion === 2 && table === "meetings" ? tableColumns.meetings.slice(0, -9) : schemaVersion < 4 && table === "encrypted_integrations" ? tableColumns.encrypted_integrations.slice(0, -1) : schemaVersion < 5 && table === "meetings" ? tableColumns.meetings.slice(0, -5) : schemaVersion < 11 && table === "meetings" ? tableColumns.meetings.slice(0, -4) : schemaVersion < 14 && table === "meetings" ? tableColumns.meetings.slice(0, -1) : schemaVersion < 8 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -15) : schemaVersion < 9 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -13) : schemaVersion < 10 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -11) : schemaVersion < 15 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -8) : schemaVersion < 31 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -6) : schemaVersion < 41 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -5) : schemaVersion < 47 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -4) : schemaVersion < 51 && table === "organization_settings" ? tableColumns.organization_settings.slice(0, -1) : schemaVersion < 8 && table === "discord_attendance_notifications" ? tableColumns.discord_attendance_notifications.slice(0, -5) : schemaVersion < 19 && table === "discord_attendance_notifications" ? tableColumns.discord_attendance_notifications.slice(0, -2) : schemaVersion < 32 && ["discord_attendance_notifications", "discord_attendance_recipients"].includes(table) ? tableColumns[table].slice(0, -1) : schemaVersion < 18 && table === "label_attendance_rules" ? tableColumns.label_attendance_rules.slice(0, -1) : tableColumns[table];
}

/** Every row is an object of scalar values with the expected columns, and no others where the format is exact. */
function validateBackupRows(table: BackupTable, tableRows: readonly unknown[], columns: readonly string[], exactColumns: boolean) {
  // This loop runs once per record of a backup that may hold 150,000, so it allocates nothing per row.
  const known: ReadonlySet<string> = new Set(columns);
  for (const row of tableRows) {
    let valid = isObject(row);
    if (valid) for (const column of columns) if (!safeBackupValue((row as Record<string, unknown>)[column])) { valid = false; break; }
    if (valid && exactColumns) for (const column in row as Record<string, unknown>) if (!known.has(column)) { valid = false; break; }
    if (!valid) throw new HttpError(400, `Backup table ${table} contains an invalid row`);
  }
}

/**
 * Row-by-row normalization of a table that may arrive in parts: defaults for columns the backup's schema did not have,
 * and queued provider work stopped for explicit review. `paused` counts that stopped work. Other tables pass through.
 */
function normalizeStagedTable(table: BackupTable, rows: Record<string, unknown>[], source: { schemaVersion: number; exportedAt: unknown }): { rows: Record<string, unknown>[]; paused: number } {
  let paused = 0;
  const stop = (pending: (row: Record<string, unknown>) => boolean, stopped: Record<string, unknown>) => rows.map((row) => { if (!pending(row)) return row; paused += 1; return { ...row, ...stopped }; });
  const isPending = (row: Record<string, unknown>) => row.status === "pending";
  if (table === "meetings") rows = rows.map((row) => {
    const normalized: Record<string, unknown> = { series_id: null, recurrence_frequency: null, recurrence_until: null, recurrence_sequence: null, deleted_at: null, weight_category_id: null, weight_category_name: null, attendance_weight: 1, audience_mode: "all", ...row };
    if (normalized.ends_at !== null) return normalized;
    const start = Date.parse(String(row.starts_at));
    return { ...normalized, ends_at: Number.isFinite(start) ? new Date(start + 60 * 60_000).toISOString() : row.starts_at };
  });
  else if (table === "attendance_events") { if (source.schemaVersion === 1) rows = rows.map((row) => ({ ...row, action: "check_in" })); }
  else if (table === "discord_attendance_notifications") {
    rows = rows.map((row) => ({ channel_id: null, expires_at: null, deleted_at: null, thread_created_at: null, delivery_id: null, ...row }));
    rows = stop(isPending, { status: "failed", last_error: "Restore requires explicit notification review", processed_at: source.exportedAt });
  }
  else if (table === "discord_attendance_recipients") rows = rows.map((row) => ({ delivery_id: null, ...row }));
  else if (table === "discord_attendance_contests") {
    rows = rows.map((row) => ({ submitted_by_discord_user_id: null, review_note: null, prior_reviews_json: "[]", ...row }));
    for (const row of rows) {
      try {
        const history = JSON.parse(String(row.prior_reviews_json));
        if (!Array.isArray(history) || history.some(review => !isObject(review) || review.status !== "rejected"
          || typeof review.createdAt !== "string" || !validTimestamp(review.createdAt)
          || typeof review.messageId !== "string" || !review.messageId
          || ![review.resolvedBy, review.submittedByDiscordUserId, review.reviewNote].every(value => value === null || typeof value === "string")
          || review.resolvedAt !== null && (typeof review.resolvedAt !== "string" || !validTimestamp(review.resolvedAt)))) throw new Error();
      } catch { throw new HttpError(400, "Backup contest review history is invalid"); }
    }
  }
  else if (table === "member_label_changes") {
    // Before schema 45 every label change came from the dashboard.
    rows = rows.map((row) => ({ source: "dashboard", ...row }));
    if (rows.some((row) => row.source !== "dashboard" && row.source !== "discord")) throw new HttpError(400, "Backup label change has an invalid source");
  }
  else if (table === "integration_deliveries") rows = stop(isPending, { status: "failed" });
  else if (table === "google_calendar_operations") rows = stop(isPending, { status: "failed", next_attempt_at: null, last_error: "Restore requires explicit Calendar review" });
  else if (table === "discord_calendar_operations") rows = stop((row) => ["pending", "processing"].includes(String(row.status)), { status: "failed", next_attempt_at: null, lease_token: null, lease_expires_at: null, last_error: "Restore requires explicit Calendar review" });
  else if (table === "discord_anomaly_reports") rows = stop(isPending, { status: "failed", last_error: "Restore requires explicit anomaly report review", processed_at: source.exportedAt });
  return { rows, paused };
}

/** Check and normalize one uploaded part of a staged table, and return it in its staged form. */
export function normalizeStagedPart(table: BackupTable, rows: unknown[], source: { schemaVersion: number; community22: boolean; exactColumns: boolean; exportedAt: unknown }): { payload: string; paused: number } {
  validateBackupRows(table, rows, backupSourceColumns(table, source.schemaVersion, source.community22), source.exactColumns);
  const normalized = normalizeStagedTable(table, rows as Record<string, unknown>[], source);
  for (const row of normalized.rows) if (row.installation_id !== "primary") throw new HttpError(400, `Backup table ${table} is not scoped to this installation`);
  return { payload: stagedPayload(table, tableColumns[table], normalized.rows), paused: normalized.paused };
}

export function normalizeBackup(value: unknown, scope: BackupScope, excludeModules?: unknown, stagedRows?: ReadonlyMap<BackupTable, number>): NormalizedBackup {
  if (!isObject(value) || value.product !== "LancerLogin" || !Number.isSafeInteger(Number(value.schemaVersion)) || Number(value.schemaVersion) < 1 || Number(value.schemaVersion) > backupSchemaVersion || value.scope !== scope || typeof value.exportedAt !== "string" || !validTimestamp(value.exportedAt) || !isObject(value.tables)) throw new HttpError(400, "The selected file is not a matching current LancerLogin backup");
  const sourceSchemaVersion = Number(value.schemaVersion);
  // Public Community 1.2.5 and early Modular archives both used schema 22.
  // Recognize the complete Community table manifest, never a partial Modular
  // archive or an archive carrying Modular ownership metadata.
  const communityTables = tablesForScope(scope).filter(table => !table.startsWith("platform_module") && table !== "user_preferences" && backupTableAt(table, 22));
  const community22 = sourceSchemaVersion === 22 && value.format === undefined && value.formatVersion === undefined && value.ownership === undefined
    && canonicalBackupJson(Object.keys(value.tables).sort()) === canonicalBackupJson([...communityTables].sort());
  const schemaVersion = community22 ? 21 : sourceSchemaVersion;
  const sourceTables = value.tables;
  if (sourceSchemaVersion >= 31 && (value.format !== backupEnvelopeFormat || value.formatVersion !== backupEnvelopeVersion || canonicalBackupJson(value.ownership) !== canonicalBackupJson(backupOwnership(scope, sourceSchemaVersion)))) throw new HttpError(400, "Backup ownership does not match this Community-based application");
  // Rows of modules that were first-party when this backup was made sit in Core's section (extracted-modules.ts).
  // They restore through the installed plugin's adapter, or are refused unless discarded like any unavailable plugin section.
  const extracted = liftExtractedModules(scope, schemaVersion, sourceTables, installedExternalBackupModuleIds);
  const reservedModuleIds = new Set(extractedModules.filter((module) => sourceSchemaVersion < module.extractedAtSchema).map((module) => module.id));
  // Schema 41 and earlier carry no external module section; other top-level fields are ignored as before.
  const externalPlan = planExternalModuleRestore([...extracted.entries, ...sourceSchemaVersion >= externalModuleBackupSchema ? parseExternalModuleSection(value.externalModules, scope, reservedModuleIds) : []], scope === "installation" ? installedExternalBackupModules : [], excludeModules);
  const knownTables = new Set<unknown>([...tablesForScope(scope), ...extractedModuleTables(scope, schemaVersion)]);
  if (Object.keys(sourceTables).some((table) => !knownTables.has(table))) throw new HttpError(400, "Backup contains tables that are not owned by this Community-based application");
  const requiredTables = (schemaVersion < 6 ? legacyTablesForScope(scope) : tablesForScope(scope)).filter((table) => !(schemaVersion < 22 && table.startsWith("platform_module")) && !(schemaVersion < 24 && table === "user_preferences") && !(schemaVersion < 23 && table === "platform_module_setup_progress") && !(schemaVersion < 21 && table === "user_walkthroughs") && !(schemaVersion < 10 && table === "discord_anomaly_reports") && !(schemaVersion < 11 && table === "meeting_weight_categories") && !(schemaVersion < 12 && ["google_calendar_authorizations", "google_calendar_event_mappings", "google_calendar_operations"].includes(table)) && !(schemaVersion < 13 && ["discord_calendar_event_mappings", "discord_calendar_operations"].includes(table)) && !(schemaVersion < 14 && ["member_labels", "member_label_changes", "label_weekly_targets", "meeting_audience_labels"].includes(table)) && !(schemaVersion < 15 && table === "label_attendance_rules") && !(schemaVersion < 16 && table === "discord_label_role_mappings") && !(schemaVersion < 20 && ["saved_report_views", "saved_report_tabs"].includes(table)) && backupTableAt(table, schemaVersion));
  let rows = 0; const exactColumns = sourceSchemaVersion >= 31 || community22; const staged: BackupTable[] = [];
  for (const table of requiredTables) {
    const tableRows = sourceTables[table]; if (!Array.isArray(tableRows)) throw new HttpError(400, `Backup table ${table} is missing`);
    // A table uploaded in parts is empty in the document; its rows were declared with the parts and are checked as each arrives.
    const stagedCount = stagedRows?.get(table);
    if (stagedCount !== undefined) { if (tableRows.length) throw new HttpError(400, `Backup table ${table} was sent both in the backup document and in parts`); rows += stagedCount; staged.push(table); continue; }
    rows += tableRows.length;
    const columns = backupSourceColumns(table, schemaVersion, community22);
    validateBackupRows(table, tableRows, columns, exactColumns);
  }
  rows += externalPlan.entries.reduce((total, entry) => total + entry.rows, 0);
  if (rows > 150_000) throw new HttpError(400, "Backup contains too many records for dashboard restore; use the documented D1 restore workflow");

  const tables = Object.fromEntries((Object.keys(tableColumns) as BackupTable[]).map((table) => [table, [] as Record<string, unknown>[]])) as Record<BackupTable, Record<string, unknown>[]>;
  // The rows are this request's own parsed JSON and every later step replaces rows rather than changing them, so the
  // arrays are copied but the rows are not.
  for (const table of requiredTables) tables[table] = (sourceTables[table] as Record<string, unknown>[]).slice();
  // Tables that may arrive in parts are normalized row by row, here for the rows the document itself carries.
  let pausedProviderOperations = 0;
  for (const table of stagedBackupTables) { const normalized = normalizeStagedTable(table, tables[table], { schemaVersion, exportedAt: value.exportedAt }); tables[table] = normalized.rows; pausedProviderOperations += normalized.paused; }
  if (tables.organization_settings) tables.organization_settings = tables.organization_settings.map((row) => ({ late_scan_minutes: 30, logo_backdrop: "auto", discord_contest_window_hours: 24, discord_block_recontests_after_rejection: 0, discord_channel_manager_enabled: 0, attendance_reporting_starts_on: null, anomaly_late_threshold_minutes: DEFAULT_ANOMALY_THRESHOLD_MINUTES, anomaly_early_threshold_minutes: DEFAULT_ANOMALY_THRESHOLD_MINUTES, discord_anomaly_reports_enabled: 0, discord_anomaly_report_channel_id: null, discord_anomaly_reports_enabled_at: null, attendance_recent_days: 30, pin_lockout_enabled: 0, pin_lockout_attempts: 5, pin_lockout_minutes: 15, early_scan_minutes: DEFAULT_EARLY_SCAN_MINUTES, attendance_policy_activated_on: null, ...row, ...(schemaVersion < 31 ? { kiosk_authentication_method: "fingerprint" } : {}) }));
  if (tables.encrypted_integrations) tables.encrypted_integrations = tables.encrypted_integrations.map((row) => ({ verified_at: null, ...row }));
  if (tables.pairing_codes) tables.pairing_codes = tables.pairing_codes.map((row) => ({ kiosk_kind: "pi", kiosk_name: null, ...row }));
  if (tables.kiosks) tables.kiosks = tables.kiosks.map((row) => ({ pairing_bound: 0, kind: "pi", member_lookup: "entry", require_pin: 0, discord_code: 0, discord_code_backup: "offline", ...row, ...(schemaVersion < 31 ? { authentication_method: "fingerprint" } : {}), ...(schemaVersion < 40 ? { configured_authentication_method: tables.organization_settings.find(settings => settings.installation_id === row.installation_id)?.kiosk_authentication_method ?? "fingerprint" } : {}) }));
  if (tables.kiosks.some(row => !kioskAuthenticationMethods.has(row.configured_authentication_method as KioskAuthenticationMethod) || !kioskAuthenticationMethods.has(row.authentication_method as KioskAuthenticationMethod))) throw new HttpError(400, "Backup contains an invalid kiosk authentication method");
  if (tables.kiosks.some(row => !kioskKinds.has(row.kind) || !kioskMemberLookups.has(row.member_lookup) || row.kind === "web" && row.configured_authentication_method !== "member_id") || tables.pairing_codes.some(row => !kioskKinds.has(row.kiosk_kind))) throw new HttpError(400, "Backup contains an invalid kiosk kind or member lookup");
  if (tables.kiosks.some(row => ![0, 1].includes(row.require_pin as number) || row.require_pin === 1 && row.configured_authentication_method !== "member_id")) throw new HttpError(400, "Backup contains an invalid kiosk Require PIN setting");
  if (tables.kiosks.some(row => ![0, 1].includes(row.discord_code as number) || row.discord_code === 1 && row.configured_authentication_method !== "member_id" || typeof row.discord_code_backup !== "string" || !discordCodeBackups.has(row.discord_code_backup))) throw new HttpError(400, "Backup contains an invalid kiosk Discord code setting");
  if (tables.organization_settings.some(row => !validEarlyScanMinutes(row.early_scan_minutes))) throw new HttpError(400, "Backup early arrival allowance is invalid");
  if (tables.organization_settings.some(row => ![0, 1].includes(row.pin_lockout_enabled as number) || !Number.isInteger(row.pin_lockout_attempts) || Number(row.pin_lockout_attempts) < 3 || Number(row.pin_lockout_attempts) > 20 || !Number.isInteger(row.pin_lockout_minutes) || Number(row.pin_lockout_minutes) < 1 || Number(row.pin_lockout_minutes) > 1440)) throw new HttpError(400, "Backup PIN lockout setting is invalid");
  const pinMembers = new Set(tables.members.map((row) => row.id)); const pinKiosks = new Set(tables.kiosks.map((row) => row.id));
  if (tables.member_pins.some(row => !pinMembers.has(row.member_id) || row.set_kiosk_id !== null && !pinKiosks.has(row.set_kiosk_id) || typeof row.pin_hash !== "string" || !row.pin_hash || typeof row.pin_salt !== "string" || !row.pin_salt || !Number.isInteger(row.pin_iterations) || Number(row.pin_iterations) < 1 || Number(row.pin_iterations) > 100_000 || !Number.isInteger(row.failed_attempts) || Number(row.failed_attempts) < 0 || typeof row.set_at !== "string" || typeof row.updated_at !== "string" || row.locked_until !== null && typeof row.locked_until !== "string")) throw new HttpError(400, "Backup contains an invalid member PIN");
  if (tables.first_credentials.some(row => !["FRC", "FTC"].includes(row.program as string) || [row.username, row.ciphertext, row.iv, row.checked_at, row.updated_at].some(value => typeof value !== "string" || !value) || String(row.username).length > 100 || String(row.ciphertext).length > 4000 || String(row.iv).length > 200 || !Number.isInteger(row.key_version) || Number(row.key_version) < 1) || new Set(tables.first_credentials.map(row => row.program)).size !== tables.first_credentials.length) throw new HttpError(400, "Backup contains an invalid FIRST credential");
  const notionIdText = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const notionName = (value: unknown, maximum: number) => typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= maximum;
  const notionCapabilityRecord = (value: unknown) => { if (typeof value !== "string" || value.length > 1000) return false; try { const parsed = JSON.parse(value) as unknown; return isObject(parsed) && Object.entries(parsed).every(([key, state]) => ["read", "insert", "update", "comment", "users", "email"].includes(key) && (state === "ok" || state === "refused")); } catch { return false; } };
  if (tables.notion_connection.length > 1 || tables.notion_connection.some(row => [row.ciphertext, row.iv, row.checked_at, row.updated_at].some(value => typeof value !== "string" || !value) || String(row.ciphertext).length > 4000 || String(row.iv).length > 200 || !Number.isInteger(row.key_version) || Number(row.key_version) < 1 || ![0, 1].includes(row.enabled as number) || [row.bot_name, row.workspace_name].some(value => typeof value !== "string" || value.length > 200) || !notionCapabilityRecord(row.capabilities_json) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0)) throw new HttpError(400, "Backup contains an invalid Notion connection");
  if (tables.notion_bindings.some(row => !notionName(row.module_id, 64) || !notionName(row.binding_id, 40) || !notionIdText(row.database_id) || !notionIdText(row.data_source_id) || typeof row.name !== "string" || row.name.length > 200 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || typeof row.updated_at !== "string" || !row.updated_at) || new Set(tables.notion_bindings.map(row => `${row.module_id}:${row.binding_id}`)).size !== tables.notion_bindings.length) throw new HttpError(400, "Backup contains an invalid Notion database choice");
  if (tables.notion_comment_names.some(row => !notionName(row.module_id, 64) || typeof row.name !== "string" || !row.name || row.name.length > 100 || row.name !== row.name.trim() || /[\u0000-\u001f\u007f]/.test(row.name) || typeof row.updated_at !== "string" || !row.updated_at) || new Set(tables.notion_comment_names.map(row => row.module_id)).size !== tables.notion_comment_names.length) throw new HttpError(400, "Backup contains an invalid Notion comment name");
  if (tables.module_report_baselines.some(row => typeof row.module_id !== "string" || !row.module_id || row.module_id === "attendance" || row.module_id.length > 64 || row.starts_on !== null && (typeof row.starts_on !== "string" || !validDate(row.starts_on)) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || typeof row.updated_at !== "string" || !row.updated_at) || new Set(tables.module_report_baselines.map(row => row.module_id)).size !== tables.module_report_baselines.length) throw new HttpError(400, "Backup contains an invalid reporting start date");
  // Before schema 50 one reporting start date served every report; Outreach starts with Attendance's, as migration 0096 did.
  if (scope === "installation" && schemaVersion < 50) { const startsOn = tables.organization_settings.find((row) => row.installation_id === "primary")?.attendance_reporting_starts_on; if (typeof startsOn === "string" && validDate(startsOn)) tables.module_report_baselines = [{ installation_id: "primary", module_id: "hour-tracking", starts_on: startsOn, revision: 0, updated_at: String(value.exportedAt ?? new Date().toISOString()) }]; }
  if (schemaVersion < 7 && tables.installations) { const providers = new Set(tables.encrypted_integrations.map((row) => row.provider)); tables.installations = tables.installations.map((row) => ({ ...row, google_enabled: providers.has("google") ? 1 : 0, resend_enabled: providers.has("resend") ? 1 : 0, discord_enabled: providers.has("discord") ? 1 : 0 })); }
  if (schemaVersion < 12 && tables.installations) tables.installations = tables.installations.map((row) => ({ google_calendar_enabled: 0, ...row }));
  // A backup from before participation dates starts each member on their roster-added day in the backup's own time zone
  // (a roster backup carries none, so UTC as before).
  const backupZone = tables.organization_settings.find((row) => row.installation_id === "primary")?.time_zone; const backupTimeZone = typeof backupZone === "string" && validTimeZone(backupZone) ? backupZone : "UTC";
  if (tables.members) tables.members = tables.members.map((row) => ({ ...("attendance_required_from" in row ? {} : { attendance_required_from: participationStartDate({ rosterAddedAt: String(row.created_at ?? "") }, backupTimeZone) }), ...row, ...(schemaVersion < 34 ? { inactive_periods_json: row.active === 0 ? JSON.stringify([[new Date().toISOString(), null]]) : "[]" } : {}) }));
  try { for (const member of tables.members ?? []) validateInactivePeriods(member.inactive_periods_json, member.active); } catch { throw new HttpError(400, "Backup contains invalid member inactivity history"); }
  if (tables.users) tables.users = tables.users.map((row) => ({ debug_mode: 0, ...row }));
  if (scope === "installation" && schemaVersion < 22) {
    tables.platform_module_administration = [{ installation_id: "primary", revision: 0, selection_completed: 1 }];
    tables.platform_module_administration_epochs = [{ installation_id: "primary", revision: 0 }];
    tables.platform_module_epochs = [{ installation_id: "primary", module_id: "attendance", generation: 1 }];
    tables.platform_modules = [{ installation_id: "primary", module_id: "attendance", contract_version: 1, generation: 1, phase: "enabled", setup_version: 2, setup_complete: 1, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null }];
    tables.platform_module_assignment_epochs = tables.users.map((row) => ({ installation_id: "primary", user_id: row.id, revision: 0 }));
    tables.platform_module_assignment_revisions = tables.users.map((row) => ({ installation_id: "primary", user_id: row.id, revision: 0 }));
    tables.platform_module_assignments = tables.users.filter((row) => row.role === "operator").map((row) => ({ installation_id: "primary", user_id: row.id, module_id: "attendance", capabilities_json: '["attendance.manage"]' }));
  }
  if (scope === "installation" && schemaVersion >= 22 && schemaVersion < 23) {
    tables.platform_modules = tables.platform_modules.map((row) => ({ ...row, setup_version: row.module_id === "attendance" ? 2 : row.setup_version, deletion_cursor: 0, cleanup_failure: null }));
  }
  if (scope === "installation" && schemaVersion < 23) {
    const attendance = tables.platform_modules.find((row) => row.module_id === "attendance");
    if (attendance?.setup_complete === 1) {
      const completedAt = String(tables.installations.find((row) => row.id === "primary")?.created_at ?? value.exportedAt);
      const completedBy = tables.users.find((row) => row.role === "admin")?.id ?? null;
      tables.platform_module_setup_progress = ["rules", "meeting", "input", "calendar", "discord"].map((stepId) => ({ installation_id: "primary", module_id: "attendance", step_id: stepId, setup_version: 2, outcome: ["calendar", "discord"].includes(stepId) ? "skipped" : "completed", completed_at: completedAt, completed_by: completedBy }));
    }
  }
  // Schema 1 recorded arrivals only; each member's latest scan of a meeting also closes their attendance. Events
  // uploaded in parts get the same check-outs from the final batch (legacyCheckoutStatement).
  if (schemaVersion === 1 && tables.attendance_events) {
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of tables.attendance_events) {
      if (row.meeting_id === null) continue;
      const key = `${row.installation_id}:${row.member_id}:${row.meeting_id}`;
      const saved = latest.get(key);
      if (!saved || String(row.occurred_at) > String(saved.occurred_at)) latest.set(key, row);
    }
    for (const row of latest.values()) tables.attendance_events.push({ ...row, id: `legacy-restore-checkout:${row.member_id}:${row.meeting_id}`, source: "manual", kiosk_event_id: null, action: "check_out" });
  }
  if (tables.organization_settings.some(row => row.discord_block_recontests_after_rejection !== 0 && row.discord_block_recontests_after_rejection !== 1)) throw new HttpError(400, "Backup contest rejection setting is invalid");
  if (schemaVersion < 15) {
    tables.label_attendance_rules = tables.label_weekly_targets.map((row) => ({ id: "legacy:" + row.id, installation_id: row.installation_id, label_id: row.label_id, starts_on: row.starts_on, ends_on: row.ends_on, rule_type: "weekly_count", threshold_percent: null, meetings_per_week: row.meetings_per_week, created_by: row.created_by, created_at: row.created_at, updated_at: row.created_at }));
    if (tables.member_labels.some((row) => row.formula_enabled === 1) || tables.label_attendance_rules.length) tables.organization_settings = tables.organization_settings.map((row) => ({ ...row, attendance_policy_activated_on: new Date().toISOString().slice(0, 10) }));
  }
  tables.label_attendance_rules = tables.label_attendance_rules.map((row) => ({ excused_handling: "exclude", ...row }));
  // Before schema 45 every label change came from the dashboard (normalizeStagedTable) and every role link synced Dashboard to Discord.
  tables.discord_label_role_mappings = tables.discord_label_role_mappings.map((row) => ({ sync_direction: "to_discord", ...row }));
  if (tables.discord_label_role_mappings.some((row) => row.sync_direction !== "to_discord" && row.sync_direction !== "two_way")) throw new HttpError(400, "Backup Discord role link has an invalid sync direction");
  if (tables.label_attendance_rules.some((row) => !["exclude", "count_missed"].includes(String(row.excused_handling)))) throw new HttpError(400, "Backup attendance rule has invalid excused-meeting handling");
  if (scope === "installation" && schemaVersion >= 20) {
    const restoredLabels = tables.member_labels.map((row) => ({ id: String(row.id), name: String(row.name), active: Boolean(row.active), formulaEnabled: Boolean(row.formula_enabled) }));
    for (const row of tables.saved_report_views) {
      // A saved report keeps working when its module returns: a report whose dataset belongs to a module this build does
      // not have is restored as saved. Missing labels and module filter options only warn, so options need not be read here.
      const stored = parseStoredReportDefinition(String(row.definition_json)) as { version?: unknown; dataset?: unknown } | undefined;
      if (stored?.version === 2 && typeof stored.dataset === "string" && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(stored.dataset) && !reportDatasetDefinition(stored.dataset)) continue;
      const validation = validateReportDefinition(stored, restoredLabels, { allowMissingLabels: true });
      if (!validation.definition || validation.errors.length) throw new HttpError(400, "Backup contains an invalid saved report definition", validation.errors);
    }
  }
  // Walkthrough progress on pages of extracted modules whose plugins are not installed is not restored.
  const unavailablePages = unavailableExtractedWalkthroughPages(installedExternalBackupModuleIds);
  if (unavailablePages.size) tables.user_walkthroughs = tables.user_walkthroughs.filter((row) => !unavailablePages.has(String(row.page_id)));
  tables.user_walkthroughs = tables.user_walkthroughs.filter((row) => !removedWalkthroughPages.has(String(row.page_id)));
  for (const row of tables.user_walkthroughs) {
    if (row.installation_id !== "primary" || !tables.users.some((user) => user.id === row.user_id && user.installation_id === row.installation_id)
      || !validWalkthroughProgress({ pageId: row.page_id, version: row.content_version, status: row.status, stepId: row.step_id })) throw new HttpError(400, "Backup walkthrough progress is invalid");
  }
  validatePortableTableScope(tables, scope);
  // Discarded modules, and extracted modules that were never used and have no plugin here, restore as absent.
  if (scope === "installation") { removeExcludedModuleRows(tables, new Set([...externalPlan.excludedIds, ...extracted.dropped])); validateInstallationBackupState(tables, externalPlan.included.map(({ module }) => module.definition)); }
  const restoredAt = new Date().toISOString();
  const installationCreatedAt = tables.installations.find((row) => row.id === "primary")?.created_at;
  const includedExternalModules = externalPlan.included.map((included) => prepareIncludedModule(included, { installationId: "primary", exportedAt: value.exportedAt as string, restoredAt }, schemaVersion, typeof installationCreatedAt === "string" ? installationCreatedAt : null));
  requireConfirmedExclusions(externalPlan);

  const invalidatedPairingCodes = tables.pairing_codes.length; const revokedKiosks = tables.kiosks.length;
  tables.pairing_codes = tables.pairing_codes.map((row) => ({ ...row, code_hash: `restored-${crypto.randomUUID()}`, expires_at: value.exportedAt, redeemed_at: value.exportedAt }));
  tables.kiosks = tables.kiosks.map((row) => ({ ...row, token_hash: `restored-${crypto.randomUUID()}`, active: 0 }));
  // Schema 47 and earlier carry the browser simulator's session; its table no longer exists.
  tables.simulated_kiosk_sessions = [];
  const attendanceRecentDays = scope === "roster" && schemaVersion >= 15 ? Number(value.attendanceRecentDays) : 30;
  if (!Number.isSafeInteger(attendanceRecentDays) || attendanceRecentDays < 1 || attendanceRecentDays > 365) throw new HttpError(400, "Backup attendance window is invalid");
  const attendancePolicyActivatedOn = scope === "roster" && schemaVersion >= 15 ? value.attendancePolicyActivatedOn ?? null : schemaVersion < 15 && (tables.member_labels.some((row) => row.formula_enabled === 1) || tables.label_attendance_rules.length) ? new Date().toISOString().slice(0, 10) : null;
  if (attendancePolicyActivatedOn !== null && !validDate(attendancePolicyActivatedOn)) throw new HttpError(400, "Backup attendance policy activation date is invalid");
  // Provider work an included module paused for review counts with Core's paused operations.
  const pausedModuleOperations = includedExternalModules.reduce((total, module) => total + module.pausedOperations, 0);
  return { product: "LancerLogin", schemaVersion: sourceSchemaVersion, scope, exportedAt: value.exportedAt, source: { schemaVersion, community22, exactColumns, staged }, attendanceRecentDays, attendancePolicyActivatedOn, tables, recovery: { revokedKiosks, invalidatedPairingCodes, pausedProviderOperations: pausedProviderOperations + pausedModuleOperations }, externalModules: { included: includedExternalModules, excluded: externalPlan.unavailable } };
}

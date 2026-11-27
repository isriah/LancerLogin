// How many database rows a restore writes, estimated from the number of records a backup holds.
//
// Cloudflare D1 counts a written row for the record itself and one for every index on its table, and its Free plan allows
// 100,000 rows written a day across the account; once that is used no query runs, reads included, until 00:00 UTC. A
// restore of more than a few thousand scans can pass it in its one transaction, so the restore dialog warns first.
//
// `restoreWriteCosts` is rows written per restored record: 1 plus the table's indexes. A restore sets the report revision
// triggers aside for its transaction (apps/api/src/index.ts, applyRestore), so they add nothing. The estimate counts
// what the restore inserts; the rows it removes first are extra, about one written row for each record removed.
// tests-ts/restore-in-parts.test.ts keeps the numbers in step with the schema.

/** Rows the Free plan lets an account write to D1 in a day. */
export const d1FreeDailyRowsWritten = 100_000;
/** The restore dialog warns before a restore estimated to write more than this. */
export const restoreWriteWarningRows = 80_000;
/** For a table not listed, such as a plugin's: the record and two indexes. */
export const defaultRestoreWriteCost = 3;

export const restoreWriteCosts: Readonly<Record<string, number>> = {
  installations: 3, platform_module_administration: 2, platform_module_administration_epochs: 2, platform_module_epochs: 2, platform_modules: 3,
  platform_module_assignment_epochs: 2, platform_module_assignment_revisions: 2, platform_module_assignments: 2, platform_module_setup_progress: 2,
  organization_settings: 2, module_report_baselines: 2, user_walkthroughs: 2, users: 5, user_preferences: 2, members: 6, member_labels: 3,
  member_label_changes: 4, discord_label_role_mappings: 3, label_weekly_targets: 3, label_attendance_rules: 5, saved_report_views: 5,
  saved_report_tabs: 4, meeting_weight_categories: 4, meetings: 7, meeting_audience_labels: 2, meeting_templates: 4, attendance_events: 6,
  attendance_corrections: 5, setup_progress: 2, pairing_codes: 3, kiosks: 5, member_pins: 2, encrypted_integrations: 3,
  google_calendar_authorizations: 2, first_credentials: 2, notion_connection: 2, notion_bindings: 2, google_calendar_event_mappings: 3, google_calendar_operations: 4,
  discord_calendar_event_mappings: 3, discord_calendar_operations: 4, integration_deliveries: 4, integration_state: 2,
  discord_attendance_notifications: 3, discord_attendance_recipients: 5, discord_attendance_contests: 3, discord_anomaly_reports: 3,
  audit_log: 3, telemetry_diagnostics: 2,
};

/** Rows a restore writes for the given number of records per table. */
export function estimateRestoreWrites(records: Readonly<Record<string, number>>): number {
  let rows = 0;
  for (const table of Object.keys(records)) rows += (records[table] ?? 0) * (restoreWriteCosts[table] ?? defaultRestoreWriteCost);
  return rows;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Records per table of a parsed backup file, plugin sections included. Anything not shaped like a backup counts nothing. */
export function backupRecordCounts(backup: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (tables: unknown) => { if (isObject(tables)) for (const table of Object.keys(tables)) { const rows = tables[table]; if (Array.isArray(rows)) counts[table] = (counts[table] ?? 0) + rows.length; } };
  if (!isObject(backup)) return counts;
  add(backup.tables);
  if (Array.isArray(backup.externalModules)) for (const module of backup.externalModules) if (isObject(module)) add(module.tables);
  return counts;
}

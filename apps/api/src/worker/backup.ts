import { recordUpdateBackup, requirePreparedUpdate } from "../web-updates.ts";
import { HttpError } from "../http-error.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { twoWayRestorePaused } from "../discord-label-two-way.ts";
import { extractedModuleOwnership } from "../extracted-modules.ts";
import { backupPartPayload, createBackupSession, deleteTransferSession, finishBackupSession, validTransferSessionId, type BackupSource } from "../data-transfer.ts";
import { externalModuleExport, externalBackupModules, firstPartyBackupRegistry, moduleKeyedTables } from "../module-backup.ts";
import { type Env, auditStatement, baseHeaders, parseJson, requireDatabase, requireRole, response, writeAudit } from "./core.ts";
import { apiModules } from "./module-runtime.ts";


export type BackupScope = "meetings" | "roster" | "installation";
export const tableColumns = {
  installations: ["id", "created_at", "auth_mode", "telemetry_accepted_at", "telemetry_install_id", "google_enabled", "resend_enabled", "discord_enabled", "google_calendar_enabled"],
  platform_module_administration: ["installation_id", "revision", "selection_completed"],
  platform_module_administration_epochs: ["installation_id", "revision"],
  platform_module_epochs: ["installation_id", "module_id", "generation"],
  platform_modules: ["installation_id", "module_id", "contract_version", "generation", "phase", "setup_version", "setup_complete", "disabled_at", "delete_after", "deletion_cursor", "cleanup_failure"],
  platform_module_assignment_epochs: ["installation_id", "user_id", "revision"],
  platform_module_assignment_revisions: ["installation_id", "user_id", "revision"],
  platform_module_assignments: ["installation_id", "user_id", "module_id", "capabilities_json"],
  platform_module_setup_progress: ["installation_id", "module_id", "step_id", "setup_version", "outcome", "completed_at", "completed_by"],
  organization_settings: ["installation_id", "organization_name", "subtitle", "logo_data", "primary_color", "secondary_color", "appearance", "time_zone", "late_scan_minutes", "logo_backdrop", "discord_contest_window_hours", "discord_channel_manager_enabled", "attendance_reporting_starts_on", "anomaly_late_threshold_minutes", "anomaly_early_threshold_minutes", "discord_anomaly_reports_enabled", "discord_anomaly_report_channel_id", "discord_anomaly_reports_enabled_at", "attendance_recent_days", "attendance_policy_activated_on", "kiosk_authentication_method", "discord_block_recontests_after_rejection", "pin_lockout_enabled", "pin_lockout_attempts", "pin_lockout_minutes", "early_scan_minutes"],
  module_report_baselines: ["installation_id", "module_id", "starts_on", "revision", "updated_at"],
  user_walkthroughs: ["installation_id", "user_id", "page_id", "content_version", "status", "step_id", "updated_at"],
  users: ["id", "installation_id", "email", "local_username", "password_hash", "failed_login_count", "locked_until", "role", "active", "created_at", "member_id", "debug_mode"],
  user_preferences: ["installation_id", "user_id", "developer_scheduler_enabled", "revision", "updated_at"],
  members: ["id", "installation_id", "external_id", "first_name", "last_name", "email", "discord_user_id", "active", "created_at", "attendance_required_from", "inactive_periods_json"],
  member_labels: ["id", "installation_id", "name", "active", "formula_enabled", "created_by", "created_at"],
  member_label_changes: ["id", "installation_id", "member_id", "label_id", "action", "effective_date", "created_by", "created_at", "source"],
  discord_label_role_mappings: ["installation_id", "label_id", "guild_id", "role_id", "role_name", "created_by", "created_at", "sync_direction"],
  label_weekly_targets: ["id", "installation_id", "label_id", "starts_on", "ends_on", "meetings_per_week", "created_by", "created_at"],
  label_attendance_rules: ["id", "installation_id", "label_id", "starts_on", "ends_on", "rule_type", "threshold_percent", "meetings_per_week", "created_by", "created_at", "updated_at", "excused_handling"],
  saved_report_views: ["id", "installation_id", "owner_user_id", "scope", "name", "definition_json", "revision", "created_by", "updated_by", "created_at", "updated_at"],
  saved_report_tabs: ["installation_id", "user_id", "report_view_id", "position", "pinned_at"],
  meeting_weight_categories: ["id", "installation_id", "name", "weight", "minimum_duration_minutes", "position", "active", "created_by", "created_at", "updated_at"],
  meetings: ["id", "installation_id", "title", "starts_at", "ends_at", "required", "notes", "created_by", "created_at", "is_test", "series_id", "recurrence_frequency", "recurrence_until", "recurrence_sequence", "deleted_at", "weight_category_id", "weight_category_name", "attendance_weight", "audience_mode"],
  meeting_audience_labels: ["installation_id", "meeting_id", "label_id"],
  meeting_templates: ["id", "installation_id", "name", "title", "start_time", "duration_minutes", "required", "notes", "recurrence_frequency", "recurrence_duration_days", "created_by", "created_at", "updated_at"],
  attendance_events: ["id", "installation_id", "member_id", "meeting_id", "source", "occurred_at", "kiosk_event_id", "created_by", "action"],
  attendance_corrections: ["id", "installation_id", "member_id", "meeting_id", "disposition", "reason", "created_by", "created_at"],
  setup_progress: ["installation_id", "step", "completed_at", "completed_by"],
  pairing_codes: ["id", "installation_id", "code_hash", "expires_at", "redeemed_at", "created_by", "created_at", "purpose", "kiosk_kind", "kiosk_name"],
  kiosks: ["id", "installation_id", "pairing_code_id", "name", "token_hash", "active", "last_seen_at", "created_at", "reader_online", "release_version", "pending_events", "last_sync_at", "error_category", "pairing_bound", "authentication_method", "configured_authentication_method", "kind", "member_lookup", "require_pin", "discord_code", "discord_code_backup"],
  member_pins: ["installation_id", "member_id", "pin_hash", "pin_salt", "pin_iterations", "set_at", "set_kiosk_id", "failed_attempts", "locked_until", "updated_at"],
  simulated_kiosk_sessions: ["installation_id", "pairing_code_id", "name", "active", "online", "last_seen_at", "created_by", "created_at"],
  encrypted_integrations: ["id", "installation_id", "provider", "ciphertext", "iv", "key_version", "updated_at", "verified_at"],
  google_calendar_authorizations: ["installation_id", "ciphertext", "iv", "key_version", "authorized_at", "verified_at", "updated_at"],
  first_credentials: ["installation_id", "program", "username", "ciphertext", "iv", "key_version", "checked_at", "updated_at"],
  notion_connection: ["installation_id", "ciphertext", "iv", "key_version", "enabled", "bot_name", "workspace_name", "checked_at", "capabilities_json", "revision", "updated_at"],
  notion_bindings: ["installation_id", "module_id", "binding_id", "database_id", "data_source_id", "name", "revision", "updated_at"],
  notion_comment_names: ["installation_id", "module_id", "name", "updated_at"],
  google_calendar_event_mappings: ["installation_id", "meeting_id", "event_id", "generation", "active", "synced_at", "last_error", "updated_at"],
  google_calendar_operations: ["installation_id", "meeting_id", "event_id", "action", "starts_at", "ends_at", "status", "attempts", "next_attempt_at", "last_error", "updated_at"],
  discord_calendar_event_mappings: ["installation_id", "meeting_id", "event_id", "generation", "active", "synced_at", "last_error", "updated_at"],
  discord_calendar_operations: ["installation_id", "meeting_id", "generation", "action", "event_id", "status", "attempts", "revision", "next_attempt_at", "lease_token", "lease_expires_at", "last_error", "actor_user_id", "updated_at"],
  integration_deliveries: ["id", "installation_id", "provider", "delivery_key", "status", "external_id", "created_at", "updated_at"],
  integration_state: ["installation_id", "provider", "state_key", "external_id", "content_hash", "updated_at"],
  discord_attendance_notifications: ["installation_id", "meeting_id", "status", "message_id", "attempts", "last_error", "processed_at", "updated_at", "channel_id", "expires_at", "deleted_at", "thread_created_at", "delivery_id"],
  discord_attendance_recipients: ["installation_id", "meeting_id", "member_id", "discord_user_id", "message_id", "delivered_at", "delivery_id"],
  discord_attendance_contests: ["installation_id", "meeting_id", "member_id", "message_id", "status", "resolved_by", "resolved_at", "created_at", "submitted_by_discord_user_id", "review_note", "prior_reviews_json"],
  discord_anomaly_reports: ["installation_id", "meeting_id", "channel_id", "status", "nonce", "message_id", "attempts", "last_error", "processed_at", "updated_at"],
  audit_log: ["id", "installation_id", "actor_user_id", "action", "target_type", "target_id", "metadata_json", "created_at"],
  telemetry_diagnostics: ["installation_id", "error_category", "last_seen_at"],
} as const;
export type BackupTable = keyof typeof tableColumns;
// Restore parents before children so SQLite's immediate foreign-key checks remain valid.
export const installationTables: BackupTable[] = [
  "installations", "platform_module_administration", "platform_module_administration_epochs", "platform_module_epochs", "platform_modules", "organization_settings", "module_report_baselines", "members", "users", "user_preferences", "platform_module_assignment_epochs", "platform_module_assignment_revisions", "platform_module_assignments", "platform_module_setup_progress", "user_walkthroughs", "member_labels", "member_label_changes", "discord_label_role_mappings", "label_weekly_targets", "label_attendance_rules", "saved_report_views", "saved_report_tabs", "meeting_weight_categories", "meetings", "meeting_audience_labels", "meeting_templates",
  "attendance_events", "attendance_corrections", "setup_progress", "pairing_codes",
  "kiosks", "member_pins", "simulated_kiosk_sessions", "encrypted_integrations", "google_calendar_authorizations", "first_credentials", "notion_connection", "notion_bindings", "notion_comment_names", "integration_deliveries",
  "integration_state", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports", "audit_log", "telemetry_diagnostics",
  "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations",
];
export const meetingTables: BackupTable[] = ["meeting_weight_categories", "meetings", "meeting_audience_labels", "meeting_templates", "attendance_events", "attendance_corrections", "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports"];
export const rosterTables: BackupTable[] = ["members", "member_labels", "member_label_changes", "label_weekly_targets", "label_attendance_rules"];
export const tablesForScope = (scope: BackupScope) => scope === "installation" ? installationTables : scope === "meetings" ? meetingTables : rosterTables;
// Core tables added after the backup format existed; a backup older than the schema that added one never carries it.
const backupTablesAddedAt: Partial<Record<BackupTable, number>> = { member_pins: 47, first_credentials: 49, module_report_baselines: 50, notion_connection: 53, notion_bindings: 53, notion_comment_names: 54 };
// Tables dropped after the backup format existed, with the first schema that no longer carries them and the module that
// owned them, so older backups still match their ownership metadata. Their rows are read and then ignored.
const backupTablesRemovedAt: Partial<Record<BackupTable, { schema: number; owner: string }>> = { simulated_kiosk_sessions: { schema: 48, owner: "attendance" } };
export const backupTableAt = (table: BackupTable, schemaVersion: number) => (backupTablesAddedAt[table] ?? 0) <= schemaVersion && schemaVersion < (backupTablesRemovedAt[table]?.schema ?? Infinity);
const backupTableOwner = (table: BackupTable) => firstPartyBackupRegistry.tableOwner(table)?.id ?? backupTablesRemovedAt[table]?.owner;
export const safeBackupValue = (value: unknown) => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
// Schema 43 and 44: modules that moved into plugins (extracted-modules.ts: Carpool at 43, Outreach at 44) left Core's
// section; their plugins export them in `externalModules`.
// Schema 45: each dated label change records its source (dashboard or Discord), and each Discord role link its sync
// direction. A label exported as two-way restores paused until an Admin reviews it again (discord-label-two-way.ts).
// Schema 46: each kiosk records its kind (Pi or web) and member lookup (entry or search), and each pairing code the kind
// and name of the kiosk it pairs. Older backups restore every kiosk and code as a Pi one on member ID entry.
// Schema 47: member PINs (member_pins, hashes only) and each kiosk's Require PIN, with the PIN lockout settings, in
// entire-installation backups. Older backups restore with no PINs, Require PIN off and lockout off (5 tries, 15 minutes).
// PIN setup requests are short-lived and bound to kiosk credentials, so they never travel.
// Schema 48: the browser simulator is gone (migration 0092 drops simulated_kiosk_sessions). Older backups' simulator rows
// are ignored on restore.
// Schema 49: Core's FIRST connection credentials (first_credentials: username and encrypted token per program, never the
// token itself) in entire-installation backups. Older backups restore with no FIRST credential. A restored credential
// the current integration key cannot decrypt shows as saved but unreadable until an Admin saves it again. FIRST's cached
// answers, seasons and request counts never travel.
// Schema 50: each module's own reporting start date (module_report_baselines; Attendance's stays in organization_settings)
// in entire-installation backups. Older backups had one date for every report, so Outreach restores with Attendance's.
// Schema 51: the early arrival allowance (organization_settings.early_scan_minutes, migration 0099) in entire-installation
// backups. Older backups restore with the 15-minute default, as the upgrade gives existing installations.
// Schema 52: each kiosk's Discord code mode and its backup choice (kiosks.discord_code and discord_code_backup, migration
// 0100) in entire-installation backups. Older backups restore every kiosk with Discord codes off and the backup choice at
// offline. The codes themselves last two minutes and the wrong-code throttle is operational, so neither ever travels.
// Schema 53: Core's Notion connection (notion_connection: the encrypted token, never the token itself, with whether it is
// on and what it has been seen to allow) and each module's chosen databases (notion_bindings, migration 0108) in
// entire-installation backups. Older backups restore with no Notion connection and no chosen databases. A restored token
// the current integration key cannot decrypt shows as saved but unreadable until an Admin saves it again. The pause after
// a rate limit is operational and never travels.
// Schema 54: the name Notion shows on each module's comments (notion_comment_names, migration 0109) in
// entire-installation backups, for modules in the build being backed up. Older backups restore with no names, so each
// module's comments carry its label.
export const backupSchemaVersion = 54;
/** Exported values computed from other columns: a label paused after a restore is still two-way in a backup. */
const backupColumnExpressions: Partial<Record<BackupTable, Record<string, string>>> = {
  discord_label_role_mappings: { sync_direction: `CASE WHEN sync_direction = 'to_discord' AND two_way_error = '${twoWayRestorePaused}' THEN 'two_way' ELSE sync_direction END` },
};
const backupSelectColumns = (table: BackupTable) => tableColumns[table].map((column) => { const expression = backupColumnExpressions[table]?.[column]; return expression ? `${expression} AS ${column}` : column; }).join(", ");
export const backupEnvelopeFormat = "lancerlogin-community-modular";
export const backupEnvelopeVersion = 1;
/** Installed plugin modules. Their portable rows travel in the `externalModules` section, outside the first-party Core envelope. */
export const installedExternalBackupModules = externalBackupModules(bundledModuleRegistry, apiModules);
export const installedExternalBackupModuleIds: ReadonlySet<string> = new Set(installedExternalBackupModules.map(({ definition }) => definition.id));

export function backupOwnership(scope: BackupScope, schemaVersion = backupSchemaVersion) {
  const scoped = tablesForScope(scope).filter((table) => backupTableAt(table, schemaVersion));
  const core = scoped.filter((table) => !backupTableOwner(table));
  const modules = firstPartyBackupRegistry.modules.map((module) => ({
    id: module.id,
    contractVersion: module.contractVersion,
    backupVersion: module.backup.version,
    tables: scoped.filter((table) => backupTableOwner(table) === module.id),
    sharedFields: module.persistence.sharedFields.filter((field) => scoped.includes(field.table as BackupTable)).map(field => ({ ...field, columns: field.columns.filter(column => (schemaVersion >= 41 || column !== "discord_block_recontests_after_rejection") && (schemaVersion >= 51 || column !== "early_scan_minutes")) })),
    transientAuthority: module.persistence.transientAuthority.filter((field) => scoped.includes(field.table as BackupTable)),
  }));
  // Backups made before a module moved into a plugin recorded it as first-party; their ownership metadata still matches exactly.
  return { core: { version: 1, tables: core }, modules: [...modules, ...extractedModuleOwnership(scope, schemaVersion)] };
}

export async function backupData(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env); const scope = new URL(request.url).searchParams.get("scope") as BackupScope;
  if (!["meetings", "roster", "installation"].includes(scope)) throw new HttpError(400, "Backup scope must be meetings, roster, or installation");
  // Every table is read in one D1 batch. A batch is one transaction, so the file is a single snapshot: rows written while
  // the backup runs cannot leave a child without its parent and fail the restore on a foreign key. It is also one query
  // against the Workers Free limit of 50 per request, however many tables Core and the installed plugins have; one read
  // per table had reached 51. D1's per-query limits apply to each statement in the batch, not to the batch as a whole.
  const tables = tablesForScope(scope).filter((table) => backupTableAt(table, backupSchemaVersion));
  const external = scope === "installation" ? externalModuleExport(db, installedExternalBackupModules) : undefined;
  const results = await db.batch([
    ...tables.map((table) => db.prepare(`SELECT ${backupSelectColumns(table)} FROM ${table} WHERE ${table === "installations" ? "id = 'primary'" : "installation_id = 'primary'"}`)),
    ...(external?.statements ?? []),
    ...(scope === "roster" ? [db.prepare("SELECT attendance_recent_days AS recentDays, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = 'primary'")] : []),
  ]);
  const entries = tables.map((table, index) => {
    const tableRows = (results[index]?.results ?? []) as Record<string, unknown>[];
    // Lifecycle, assignment and setup rows of a module whose code is not in this build (a removed plugin, or a module that moved into a
    // plugin that is not composed) stay out: the backup carries none of that module's data, and this build could not restore them.
    return [table, (moduleKeyedTables as readonly string[]).includes(table) ? tableRows.filter((row) => bundledModuleRegistry.get(String(row.module_id))) : tableRows] as const;
  });
  const externalModules = external?.section(results.slice(tables.length));
  const exportedAt = new Date().toISOString(); const policySettings = scope === "roster" ? (results.at(-1)?.results?.[0] ?? null) as { recentDays: number; policyActivatedOn: string | null } | null : null; const backup = { product: "LancerLogin", format: backupEnvelopeFormat, formatVersion: backupEnvelopeVersion, schemaVersion: backupSchemaVersion, scope, exportedAt, ownership: backupOwnership(scope), tables: Object.fromEntries(entries), ...(externalModules ? { externalModules } : {}), ...(policySettings ? { attendanceRecentDays: policySettings.recentDays, attendancePolicyActivatedOn: policySettings.policyActivatedOn } : {}) };
  const updateRequestId = new URL(request.url).searchParams.get("updateRequestId");
  if (updateRequestId) {
    if (scope !== "installation") throw new HttpError(400, "Web updates require an entire-installation backup");
    await recordUpdateBackup(env, updateRequestId);
  }
  await writeAudit(db, principal, "data.backup_exported", "installation", "primary", { scope, schemaVersion: backupSchemaVersion });
  return response(backup, 200, { "content-disposition": `attachment; filename="lancerlogin-${scope}-backup-${exportedAt.slice(0, 10)}.json"` });
}

/**
 * Backup in parts, for an installation too large to read and serialize in one request (data-transfer.ts). Starting a
 * session copies every table into staged parts in one batch, so the file is one snapshot exactly as the single-request
 * backup above is, and writes the same audit entry. The dashboard downloads each part and assembles the same file.
 * - POST   /admin/data/backup/sessions                     { scope, updateRequestId? } -> the document without rows, its parts, and their columns
 * - GET    /admin/data/backup/sessions/:id/parts/:seq      one part: a JSON array of rows, each an array in column order
 * - POST   /admin/data/backup/sessions/:id/complete        every part was received: clears staging, records a web update's backup
 * - DELETE /admin/data/backup/sessions/:id                 cancel
 * Queries per request, after the session check: one (a batch, when starting).
 */
export async function backupSessions(request: Request, env: Env, pathname: string): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const match = /^\/admin\/data\/backup\/sessions(?:\/([^/]+)(?:\/(parts\/\d{1,12}|complete))?)?$/.exec(pathname); const id = match?.[1]; const action = match?.[2];
  if (!match || id !== undefined && !validTransferSessionId(id)) return response({ error: "Not found" }, 404);
  if (id === undefined) {
    if (request.method !== "POST") return response({ error: "Not found" }, 404);
    const input = await parseJson<{ scope?: BackupScope; updateRequestId?: unknown }>(request); const scope = input.scope as BackupScope;
    if (!["meetings", "roster", "installation"].includes(scope)) throw new HttpError(400, "Backup scope must be meetings, roster, or installation");
    if (input.updateRequestId !== undefined && (typeof input.updateRequestId !== "string" || !input.updateRequestId || input.updateRequestId.length > 200)) throw new HttpError(400, "The update request is invalid");
    if (input.updateRequestId !== undefined && scope !== "installation") throw new HttpError(400, "Web updates require an entire-installation backup");
    // An update that can no longer take its backup is refused before anything is staged; completing the download records it.
    if (input.updateRequestId !== undefined) await requirePreparedUpdate(env, input.updateRequestId);
    const tables = tablesForScope(scope).filter((table) => backupTableAt(table, backupSchemaVersion));
    // Lifecycle, assignment and setup rows of a module whose code is not in this build stay out, as in the single-request backup.
    const bundled = bundledModuleRegistry.modules.map((module) => `'${module.id.replaceAll("'", "''")}'`).join(", ");
    const external = scope === "installation" ? installedExternalBackupModules : [];
    const externalTables = external.flatMap(({ definition, adapter }) => Object.entries(adapter?.tables ?? {}).map(([table, columns]) => ({ module: definition.id, table, columns })));
    const sources: (BackupSource & { module?: string })[] = [
      ...tables.map((table) => ({ table, columns: tableColumns[table], expressions: backupColumnExpressions[table], where: `${table === "installations" ? "id = 'primary'" : "installation_id = 'primary'"}${(moduleKeyedTables as readonly string[]).includes(table) ? ` AND module_id IN (${bundled})` : ""}` })),
      ...externalTables.map(({ module, table, columns }) => ({ module, table, columns, where: "installation_id = 'primary'" })),
    ];
    const session = await createBackupSession(db, {
      userId: principal.userId, scope, sources, context: input.updateRequestId === undefined ? {} : { updateRequestId: input.updateRequestId },
      reads: [
        ...(external.length ? [db.prepare("SELECT module_id AS moduleId,source,source_commit AS sourceCommit FROM platform_module_catalog WHERE installation_id='primary'")] : []),
        ...(scope === "roster" ? [db.prepare("SELECT attendance_recent_days AS recentDays, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = 'primary'")] : []),
      ],
      writes: [auditStatement(db, principal, "data.backup_exported", "installation", "primary", { scope, schemaVersion: backupSchemaVersion })],
    });
    const recorded = new Map(((external.length ? session.reads[0]?.results ?? [] : []) as { moduleId: string; source: string | null; sourceCommit: string | null }[]).map((row) => [row.moduleId, row]));
    const externalModules = scope === "installation" ? external.map(({ definition }) => ({ id: definition.id, label: definition.label, contractVersion: definition.contractVersion, backupVersion: definition.backup.version, source: recorded.get(definition.id)?.source ?? null, commit: recorded.get(definition.id)?.sourceCommit ?? null, tables: Object.fromEntries(externalTables.filter((entry) => entry.module === definition.id).map((entry) => [entry.table, []])) })) : undefined;
    const policySettings = scope === "roster" ? (session.reads.at(-1)?.results?.[0] ?? null) as { recentDays: number; policyActivatedOn: string | null } | null : null;
    const exportedAt = new Date().toISOString();
    // The same fields in the same order as the single-request backup, with every table present and empty.
    const document = { product: "LancerLogin", format: backupEnvelopeFormat, formatVersion: backupEnvelopeVersion, schemaVersion: backupSchemaVersion, scope, exportedAt, ownership: backupOwnership(scope), tables: Object.fromEntries(tables.map((table) => [table, []])), ...(externalModules ? { externalModules } : {}), ...(policySettings ? { attendanceRecentDays: policySettings.recentDays, attendancePolicyActivatedOn: policySettings.policyActivatedOn } : {}) };
    const parts = session.parts.map((part) => { const source = sources[part.source]!; return { seq: part.seq, rows: part.rows, table: source.table, ...(source.module ? { module: source.module } : {}) }; });
    // Each part's rows are arrays; `columns` names their values, once per table that has parts.
    const columns = Object.fromEntries([...new Set(session.parts.map((part) => part.source))].map((index) => [sources[index]!.table, sources[index]!.columns]));
    return response({ id: session.id, expiresAt: session.expiresAt, filename: `lancerlogin-${scope}-backup-${exportedAt.slice(0, 10)}.json`, document, columns, parts }, 201);
  }
  if (action?.startsWith("parts/") && request.method === "GET") return new Response(await backupPartPayload(db, id, principal.userId, Number(action.slice(6))), { status: 200, headers: baseHeaders });
  if (action === "complete" && request.method === "POST") {
    const context = await finishBackupSession(db, id, principal.userId);
    if (!context) throw new HttpError(404, "This backup is no longer being prepared. Download the backup again.", undefined, "transfer_session_missing");
    if (typeof context.updateRequestId === "string") await recordUpdateBackup(env, context.updateRequestId);
    return response({ completed: true });
  }
  if (action === undefined && request.method === "DELETE") { await deleteTransferSession(db, "backup", id, principal.userId); return response({ cancelled: true }); }
  return response({ error: "Not found" }, 404);
}

import { DatabaseSync } from "node:sqlite";
import { extractedModuleOwnership, extractedModuleTables, extractedModules } from "../../apps/api/src/extracted-modules.ts";
import { readCoreMigrations } from "./d1-database.ts";

let coreColumns: Map<string, Set<string>> | undefined;
/** Columns a table has with Core migrations alone: what first-party Core's section carried, before plugin migrations added more. */
function coreSchemaColumns(table: string): Set<string> | undefined {
  if (!coreColumns) {
    const database = new DatabaseSync(":memory:"); coreColumns = new Map();
    try {
      for (const file of readCoreMigrations()) database.exec(file.content);
      for (const { name } of database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]) coreColumns.set(name, new Set((database.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((column) => column.name)));
    } finally { database.close(); }
  }
  return coreColumns.get(table);
}

/** The plugin-section rows of a module in a current backup, by table, or undefined when the backup has no section for it. */
export function pluginSectionTables(backup: any, moduleId: string): Record<string, Record<string, unknown>[]> | undefined {
  return (backup.externalModules as { id: string; tables: Record<string, Record<string, unknown>[]> }[] | undefined)?.find((entry) => entry.id === moduleId)?.tables;
}

// Shape a current synthetic archive as the declared older version: remove fields introduced after it, and restore what Core's
// section carried then for modules that have since moved into plugins (their ownership metadata and tables). Rows a composed
// plugin exported in its own section move back into Core's section, as the module's first-party Core exported them: without
// columns the plugin's own migrations added after it left Core, which that Core never had.
export function omitContestResubmissionFields(backup: any) {
  for (const module of extractedModules) {
    if (backup.schemaVersion >= module.extractedAtSchema) continue;
    const section = pluginSectionTables(backup, module.id);
    if (section && backup.tables) for (const table of extractedModuleTables(backup.scope, backup.schemaVersion)) if (Object.hasOwn(section, table)) {
      const columns = coreSchemaColumns(table);
      backup.tables[table] = columns ? section[table]!.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => columns.has(column)))) : section[table];
    }
    if (Array.isArray(backup.externalModules)) backup.externalModules = backup.externalModules.filter((entry: { id: string }) => entry.id !== module.id);
  }
  if (backup.schemaVersion < 42) delete backup.externalModules;
  const extracted = extractedModuleOwnership(backup.scope, backup.schemaVersion);
  if (backup.ownership?.modules) for (const module of extracted) if (!backup.ownership.modules.some((item: { id: string }) => item.id === module.id)) backup.ownership.modules.push(module);
  if (backup.tables) for (const table of extractedModuleTables(backup.scope, backup.schemaVersion)) backup.tables[table] ??= [];
  // The early arrival allowance travels in entire-installation backups from schema 51 (migration 0099).
  if (backup.schemaVersion < 51) {
    for (const row of backup.tables?.organization_settings ?? []) delete row.early_scan_minutes;
    for (const module of backup.ownership?.modules ?? []) for (const field of module.sharedFields ?? []) {
      if (field.table === "organization_settings") field.columns = field.columns.filter((column: string) => column !== "early_scan_minutes");
    }
  }
  // Each module's own reporting start date travels in entire-installation backups from schema 50 (migration 0096).
  if (backup.schemaVersion < 50) {
    if (backup.tables) delete backup.tables.module_report_baselines;
    if (Array.isArray(backup.ownership?.core?.tables)) backup.ownership.core.tables = backup.ownership.core.tables.filter((table: string) => table !== "module_report_baselines");
  }
  // Core's FIRST credentials travel in entire-installation backups from schema 49 (migration 0093).
  if (backup.schemaVersion < 49) {
    if (backup.tables) delete backup.tables.first_credentials;
    if (Array.isArray(backup.ownership?.core?.tables)) backup.ownership.core.tables = backup.ownership.core.tables.filter((table: string) => table !== "first_credentials");
  }
  // The browser simulator's sessions travelled in entire-installation backups until schema 48 (migration 0092).
  if (backup.schemaVersion < 48 && backup.scope === "installation") {
    if (backup.tables) backup.tables.simulated_kiosk_sessions ??= [];
    const attendance = backup.ownership?.modules?.find((module: { id: string }) => module.id === "attendance");
    if (Array.isArray(attendance?.tables) && !attendance.tables.includes("simulated_kiosk_sessions")) attendance.tables.splice(attendance.tables.indexOf("kiosks") + 1, 0, "simulated_kiosk_sessions");
  }
  if (backup.schemaVersion < 47) {
    if (backup.tables) delete backup.tables.member_pins;
    if (Array.isArray(backup.ownership?.core?.tables)) backup.ownership.core.tables = backup.ownership.core.tables.filter((table: string) => table !== "member_pins");
    for (const row of backup.tables?.kiosks ?? []) delete row.require_pin;
    for (const row of backup.tables?.organization_settings ?? []) { delete row.pin_lockout_enabled; delete row.pin_lockout_attempts; delete row.pin_lockout_minutes; }
  }
  if (backup.schemaVersion < 46) {
    for (const row of backup.tables?.kiosks ?? []) { delete row.kind; delete row.member_lookup; }
    for (const row of backup.tables?.pairing_codes ?? []) { delete row.kiosk_kind; delete row.kiosk_name; }
  }
  if (backup.schemaVersion < 45) {
    for (const row of backup.tables?.member_label_changes ?? []) delete row.source;
    for (const row of backup.tables?.discord_label_role_mappings ?? []) delete row.sync_direction;
  }
  if (backup.schemaVersion >= 41) return;
  for (const row of backup.tables?.organization_settings ?? []) delete row.discord_block_recontests_after_rejection;
  for (const row of backup.tables?.discord_attendance_contests ?? []) delete row.prior_reviews_json;
  for (const module of backup.ownership?.modules ?? []) for (const field of module.sharedFields ?? []) {
    if (field.table === "organization_settings") field.columns = field.columns.filter((column: string) => column !== "discord_block_recontests_after_rejection");
  }
}

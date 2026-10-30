import { extractedModuleOwnership, extractedModuleTables, extractedModules } from "../../apps/api/src/extracted-modules.ts";

/** The plugin-section rows of a module in a current backup, by table, or undefined when the backup has no section for it. */
export function pluginSectionTables(backup: any, moduleId: string): Record<string, Record<string, unknown>[]> | undefined {
  return (backup.externalModules as { id: string; tables: Record<string, Record<string, unknown>[]> }[] | undefined)?.find((entry) => entry.id === moduleId)?.tables;
}

// Shape a current synthetic archive as the declared older version: remove fields introduced after it, and restore what Core's
// section carried then for modules that have since moved into plugins (their ownership metadata and tables). Rows a composed
// plugin exported in its own section move back into Core's section, as the module's first-party Core exported them.
export function omitContestResubmissionFields(backup: any) {
  for (const module of extractedModules) {
    if (backup.schemaVersion >= module.extractedAtSchema) continue;
    const section = pluginSectionTables(backup, module.id);
    if (section && backup.tables) for (const table of extractedModuleTables(backup.scope, backup.schemaVersion)) if (Object.hasOwn(section, table)) backup.tables[table] = section[table];
    if (Array.isArray(backup.externalModules)) backup.externalModules = backup.externalModules.filter((entry: { id: string }) => entry.id !== module.id);
  }
  if (backup.schemaVersion < 42) delete backup.externalModules;
  const extracted = extractedModuleOwnership(backup.scope, backup.schemaVersion);
  if (backup.ownership?.modules) for (const module of extracted) if (!backup.ownership.modules.some((item: { id: string }) => item.id === module.id)) backup.ownership.modules.push(module);
  if (backup.tables) for (const table of extractedModuleTables(backup.scope, backup.schemaVersion)) backup.tables[table] ??= [];
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

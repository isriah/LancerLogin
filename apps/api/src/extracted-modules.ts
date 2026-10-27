// Frozen descriptions of modules that were first-party before they moved into plugins. Like historical migrations, they
// describe data that already exists: backups made before the extraction carry the module's rows in Core's section, and
// installations upgraded straight past the extraction may hold its lifecycle and retained data without a catalog entry.
// Never edit an entry. Core code must not branch on these module IDs; it reads only this table.
import { HttpError } from "./http-error.ts";
import type { CatalogDefinition } from "./module-catalog.ts";
import type { ExternalModuleBackupEntry } from "./module-backup.ts";

export type ExtractedModule = {
  readonly id: string;
  readonly label: string;
  readonly contractVersion: number;
  /** Module backup version recorded for the module in historical ownership metadata. Its rows reach the plugin's `normalize` as this version. */
  readonly backupVersion: number;
  /** First entire-installation backup schema without the module's rows in Core's section. */
  readonly extractedAtSchema: number;
  /** Portable tables in Core's historical restore order, with the first backup schema that carried each. */
  readonly tables: readonly { readonly name: string; readonly sinceSchema: number }[];
  /** The definition Core recorded in the installed-module catalog while the module was first-party. */
  readonly catalogDefinition: CatalogDefinition;
  /** Transient authority recorded in historical ownership metadata of entire-installation backups. */
  readonly transientAuthority?: readonly { readonly table: string; readonly columns: readonly string[] }[];
  /**
   * Tables whose rows every installation received while the module was first-party (default settings and catalog rows).
   * Rows there alone do not mean the module was used.
   */
  readonly seedTables?: readonly string[];
  /** Page walkthroughs the module owned. Without its plugin, progress on these pages is not restored. */
  readonly walkthroughPages?: readonly string[];
  /** Module columns that refer to roster members. Without its plugin, Core still keeps retained history from losing its member. */
  readonly rosterReferences?: { readonly label: string; readonly columns: readonly { readonly table: string; readonly column: string }[] };
};

/** Historical ownership lists these modules after the first-party modules, in this order. */
export const extractedModules: readonly ExtractedModule[] = Object.freeze([
  Object.freeze({
    id: "hour-tracking",
    label: "Outreach Participation",
    contractVersion: 1,
    backupVersion: 2,
    extractedAtSchema: 44,
    tables: Object.freeze([
      { name: "hours_categories", sinceSchema: 25 },
      { name: "hours_labels", sinceSchema: 29 },
      { name: "hours_teams", sinceSchema: 25 },
      { name: "hours_entry_settings", sinceSchema: 25 },
      { name: "hours_public_form_settings", sinceSchema: 33 },
      { name: "hours_publication_settings", sinceSchema: 29 },
      { name: "hours_activities", sinceSchema: 25 },
      { name: "hours_activity_labels", sinceSchema: 29 },
      { name: "hours_entries", sinceSchema: 25 },
      { name: "hours_entry_revisions", sinceSchema: 25 },
      { name: "hours_submission_keys", sinceSchema: 25 },
      { name: "hours_reopen_windows", sinceSchema: 26 },
      { name: "hours_correction_requests", sinceSchema: 26 },
      { name: "hours_correction_resolutions", sinceSchema: 26 },
      { name: "hours_activity_publications", sinceSchema: 27 },
      { name: "hours_publication_operations", sinceSchema: 27 },
    ]),
    catalogDefinition: Object.freeze({
      label: "Outreach Participation",
      description: "Outreach labels, supported teams, dated activities, member submissions, staff exceptions, and participation totals.",
      dependencies: [],
      tables: ["hours_categories", "hours_labels", "hours_teams", "hours_activities", "hours_activity_labels", "hours_entry_settings", "hours_entries", "hours_entry_revisions", "hours_submission_keys", "hours_reopen_windows", "hours_correction_requests", "hours_correction_resolutions", "hours_publication_settings", "hours_activity_publications", "hours_publication_operations", "hours_public_form_settings", "hours_public_lookup_limits"],
      deletedData: ["Outreach labels, supported teams, and activities", "Member submissions, staff exceptions, integer-minute totals, and immutable entry history", "Outreach setup and assignment records"],
      cleanup: [
        { kind: "delete", table: "hours_publication_operations" },
        { kind: "delete", table: "hours_activity_publications" },
        { kind: "delete", table: "hours_correction_resolutions" },
        { kind: "delete", table: "hours_correction_requests" },
        { kind: "delete", table: "hours_reopen_windows" },
        { kind: "delete", table: "hours_submission_keys" },
        { kind: "delete", table: "hours_entry_revisions" },
        { kind: "delete", table: "hours_entries" },
        { kind: "delete", table: "hours_activities" },
        { kind: "delete", table: "hours_teams" },
        { kind: "delete", table: "hours_categories" },
        { kind: "delete", table: "hours_entry_settings" },
        { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["hour-tracking"] },
        { kind: "assignments" },
        { kind: "delete", table: "hours_activity_labels" },
        { kind: "delete", table: "hours_labels" },
        { kind: "delete", table: "hours_public_form_settings" },
        { kind: "delete", table: "hours_public_lookup_limits" },
      ],
      migrationHead: null,
    } satisfies CatalogDefinition),
    transientAuthority: Object.freeze([{ table: "hours_publication_operations", columns: ["status", "next_attempt_at", "lease_token", "lease_expires_at"] }]),
    seedTables: Object.freeze(["hours_entry_settings", "hours_categories", "hours_publication_settings", "hours_public_form_settings"]),
    walkthroughPages: Object.freeze(["outreach"]),
    rosterReferences: Object.freeze({ label: "Outreach", columns: Object.freeze([{ table: "hours_entries", column: "member_id" }, { table: "hours_correction_requests", column: "requester_member_id" }]) }),
  }),
  Object.freeze({
    id: "carpool",
    label: "Carpool",
    contractVersion: 1,
    backupVersion: 1,
    extractedAtSchema: 43,
    tables: Object.freeze([
      { name: "carpool_settings", sinceSchema: 35 },
      { name: "carpool_plans", sinceSchema: 30 },
      { name: "carpool_people", sinceSchema: 30 },
      { name: "carpool_assignments", sinceSchema: 30 },
      { name: "carpool_unresolved", sinceSchema: 30 },
      { name: "carpool_import_profiles", sinceSchema: 30 },
      { name: "carpool_location_cache", sinceSchema: 30 },
    ]),
    catalogDefinition: Object.freeze({
      label: "Carpool",
      description: "Independent outbound and return ride planning with optional roster and event references.",
      dependencies: [],
      tables: ["carpool_settings", "carpool_geocoding_credentials", "carpool_location_resolution", "carpool_plans", "carpool_people", "carpool_assignments", "carpool_unresolved", "carpool_import_profiles", "carpool_location_cache"],
      deletedData: ["Carpool plans and optional event snapshots", "Participants, locations, vehicles, assignments, imports, and unresolved ride reasons"],
      cleanup: [
        { kind: "delete", table: "carpool_assignments" },
        { kind: "delete", table: "carpool_unresolved" },
        { kind: "delete", table: "carpool_people" },
        { kind: "delete", table: "carpool_plans" },
        { kind: "delete", table: "carpool_import_profiles" },
        { kind: "delete", table: "carpool_location_cache" },
        { kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["carpool"] },
        { kind: "assignments" },
        { kind: "delete", table: "carpool_geocoding_credentials" },
        { kind: "delete", table: "carpool_settings" },
        { kind: "delete", table: "carpool_location_resolution" },
      ],
      migrationHead: null,
    } satisfies CatalogDefinition),
  }),
]);

type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
const legacyTables = (module: ExtractedModule, schemaVersion: number) => schemaVersion < module.extractedAtSchema ? module.tables.filter((table) => table.sinceSchema <= schemaVersion).map((table) => table.name) : [];

/** Ownership metadata a backup of this schema recorded for modules that were still first-party. */
export function extractedModuleOwnership(scope: string, schemaVersion: number) {
  return extractedModules.filter((module) => schemaVersion < module.extractedAtSchema).map((module) => ({
    id: module.id, contractVersion: module.contractVersion, backupVersion: module.backupVersion,
    tables: scope === "installation" ? legacyTables(module, schemaVersion) : [], sharedFields: [],
    transientAuthority: scope === "installation" ? (module.transientAuthority ?? []).filter((field) => legacyTables(module, schemaVersion).includes(field.table)) : [],
  }));
}

/** Core-section tables that a backup of this schema carries for extracted modules. */
/** Walkthrough pages of extracted modules whose plugins are not installed. */
export function unavailableExtractedWalkthroughPages(installed: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(extractedModules.filter((module) => !installed.has(module.id)).flatMap((module) => module.walkthroughPages ?? []));
}

export function extractedModuleTables(scope: string, schemaVersion: number): string[] {
  return scope === "installation" ? extractedModules.flatMap((module) => legacyTables(module, schemaVersion)) : [];
}

/**
 * True when a historical backup holds data or lifecycle state for the module, rather than the disabled row and default seed
 * rows every installation received. `rows` counts the module's rows outside its seed tables.
 */
function holdsModuleState(moduleId: string, tables: Readonly<Record<string, unknown>>, rows: number) {
  const keyed = (table: string) => (Array.isArray(tables[table]) ? tables[table] as unknown[] : []).filter((row): row is Row => isObject(row) && row.module_id === moduleId);
  return rows > 0 || keyed("platform_module_assignments").length > 0 || keyed("platform_module_setup_progress").length > 0
    || keyed("platform_modules").some((row) => ["enabled", "retained", "deleting"].includes(String(row.phase)));
}

/**
 * Lift extracted modules' rows out of Core's section of a historical entire-installation backup. A module whose plugin is
 * installed always becomes a backup entry, so its rows and lifecycle restore through the plugin's adapter. Without the
 * plugin, a module that holds data or lifecycle state becomes an entry too, which restore refuses unless it is explicitly
 * discarded. A module that was never used is `dropped`: its disabled lifecycle rows are left out with nothing to discard.
 */
export function liftExtractedModules(scope: string, schemaVersion: number, tables: Readonly<Record<string, unknown>>, installed: ReadonlySet<string>) {
  const entries: ExternalModuleBackupEntry[] = []; const dropped = new Set<string>();
  if (scope !== "installation") return { entries, dropped };
  for (const module of extractedModules) {
    if (schemaVersion >= module.extractedAtSchema || !module.tables.some((table) => table.sinceSchema <= schemaVersion)) continue;
    const lifted: Record<string, Row[]> = {}; let rows = 0; let used = 0;
    for (const table of legacyTables(module, schemaVersion)) {
      const tableRows = tables[table];
      if (!Array.isArray(tableRows)) throw new HttpError(400, `Backup table ${table} is missing`);
      for (const row of tableRows) if (!isObject(row) || Object.values(row).some((value) => !scalar(value))) throw new HttpError(400, `Backup table ${table} contains an invalid row`);
      lifted[table] = tableRows.map((row) => ({ ...row as Row })); rows += tableRows.length;
      if (!module.seedTables?.includes(table)) used += tableRows.length;
    }
    if (!installed.has(module.id) && !holdsModuleState(module.id, tables, used)) { dropped.add(module.id); continue; }
    entries.push({ id: module.id, label: module.label, contractVersion: module.contractVersion, backupVersion: module.backupVersion, source: null, commit: null, tables: lifted, rows, coreSection: true });
  }
  return { entries, dropped };
}

/** Runs one read-only SQL query; the Worker passes D1 and the update controller passes the D1 HTTP query API. */
export type UsageQuery = (sql: string, params?: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;
/**
 * Extracted modules that this database uses but `composed` lacks. "Used" is the definition historical backups apply
 * (see liftExtractedModules): rows outside the module's seed tables, module assignments or setup progress, or an
 * enabled, retained or deleting lifecycle. A module deliberately disabled, or whose retained data was deleted, is not
 * used. Tables an older schema lacks count as empty.
 */
export async function extractedModulesInUse(query: UsageQuery, composed: ReadonlySet<string>): Promise<ExtractedModule[]> {
  const candidates = extractedModules.filter((module) => !composed.has(module.id));
  if (!candidates.length) return [];
  const existing = new Set((await query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => String(row.name)));
  const inUse: ExtractedModule[] = [];
  for (const module of candidates) {
    const parts: string[] = []; const params: unknown[] = [];
    // Table names come from the frozen list above, never from input.
    for (const table of module.tables) if (!module.seedTables?.includes(table.name) && existing.has(table.name)) parts.push(`(SELECT COUNT(*) FROM ${table.name})`);
    for (const table of ["platform_module_assignments", "platform_module_setup_progress"]) if (existing.has(table)) { parts.push(`(SELECT COUNT(*) FROM ${table} WHERE module_id = ?)`); params.push(module.id); }
    if (existing.has("platform_modules")) { parts.push("(SELECT COUNT(*) FROM platform_modules WHERE module_id = ? AND phase IN ('enabled', 'retained', 'deleting'))"); params.push(module.id); }
    if (!parts.length) continue;
    const [row] = await query(`SELECT ${parts.join(" + ")} AS used`, params);
    if (Number(row?.used ?? 0) > 0) inUse.push(module);
  }
  return inUse;
}

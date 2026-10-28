import { createModuleRegistry, firstPartyModules, requiredModuleIds, type ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";
import type { D1Database, D1Statement } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { externalModuleIds, type ApiModuleContribution, type ModuleBackupAdapter, type ModuleBackupRestoreContext, type ModuleBackupTables } from "./module-contributions.ts";

/**
 * Core backup ownership, table lists and historical normalization describe first-party modules only, so the existing
 * envelope is identical whether or not plugins are installed. External modules travel in the separate `externalModules` section.
 */
export const firstPartyBackupRegistry = createModuleRegistry(firstPartyModules);
/** Backup schema that introduced the `externalModules` section for entire-installation backups. */
export const externalModuleBackupSchema = 42;

type Row = Record<string, unknown>;
type MutableTables = Record<string, Row[]>;
export type ExternalBackupModule = {
  readonly definition: ModuleDefinition;
  readonly adapter?: ModuleBackupAdapter;
};
export type ExternalModuleSource = { readonly source: string | null; readonly commit: string | null };
export type ExternalModuleBackupEntry = {
  readonly id: string;
  readonly label: string;
  readonly contractVersion: number;
  readonly backupVersion: number;
  readonly source: string | null;
  readonly commit: string | null;
  readonly tables: MutableTables;
  readonly rows: number;
  /** Rows Core carried in its own section while the module was first-party (see extracted-modules.ts), not a plugin section. */
  readonly coreSection: boolean;
};
export type UnavailableModuleStatus = "missing" | "newer" | "incompatible";
export type ExcludedModuleSummary = {
  readonly id: string;
  readonly label: string;
  readonly status: UnavailableModuleStatus;
  readonly requiredBackupVersion: number;
  readonly installedBackupVersion: number | null;
  readonly requiredContractVersion: number;
  readonly installedContractVersion: number | null;
  readonly source: string | null;
  readonly commit: string | null;
  readonly rows: number;
};
export type IncludedExternalModule = { readonly module: ExternalBackupModule; readonly entry: ExternalModuleBackupEntry };
export type ExternalModuleRestorePlan = {
  readonly entries: readonly ExternalModuleBackupEntry[];
  readonly included: readonly IncludedExternalModule[];
  readonly unavailable: readonly ExcludedModuleSummary[];
  readonly excludedIds: ReadonlySet<string>;
  /** True when nothing is unavailable, or the request named exactly the unavailable modules. */
  readonly confirmed: boolean;
};
export type PreparedExternalModule = { readonly module: ExternalBackupModule; readonly tables: Readonly<Record<string, readonly Row[]>>; readonly pausedOperations: number };

const moduleIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const safeName = /^[a-z][a-z0-9_]*$/;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const printable = /^[^\u0000-\u001f\u007f]+$/;
const entryKeys = ["id", "label", "contractVersion", "backupVersion", "source", "commit", "tables"];
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeValue = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1;
const invalidSection = () => new HttpError(400, "Backup external module section is invalid");

/** Installed external modules in registry order. External modules are identified by the composed plugin manifest list. */
export function externalBackupModules(registry: { readonly modules: readonly ModuleDefinition[] }, contributions: { get(moduleId: string): Pick<ApiModuleContribution<never>, "backup"> | undefined }, external: ReadonlySet<string> = externalModuleIds): readonly ExternalBackupModule[] {
  return Object.freeze(registry.modules.filter((module) => external.has(module.id)).map((definition) => {
    const contribution = contributions.get(definition.id);
    return Object.freeze({ definition, adapter: contribution?.backup });
  }));
}

/** The plugin's git source and pinned commit as recorded in the installed-module catalog, or null before the first reconciliation. */
export async function installedExternalModuleSource(db: D1Database, moduleId: string): Promise<ExternalModuleSource> {
  const row = await db.prepare("SELECT source,source_commit AS sourceCommit FROM platform_module_catalog WHERE installation_id='primary' AND module_id=?").bind(moduleId).first<{ source: string | null; sourceCommit: string | null }>();
  return { source: row?.source ?? null, commit: row?.sourceCommit ?? null };
}

/** The `externalModules` section of an entire-installation backup. Every installed external module has an entry. */
export async function exportExternalModules(db: D1Database, modules: readonly ExternalBackupModule[], source = installedExternalModuleSource) {
  return Promise.all(modules.map(async ({ definition, adapter }) => {
    const tables = Object.fromEntries(await Promise.all(Object.entries(adapter?.tables ?? {}).map(async ([table, columns]) => {
      const result = await db.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE installation_id = 'primary'`).all<Row>();
      return [table, result.results ?? []] as const;
    })));
    const recorded = await source(db, definition.id);
    return { id: definition.id, label: definition.label, contractVersion: definition.contractVersion, backupVersion: definition.backup.version, source: recorded.source, commit: recorded.commit, tables };
  }));
}

/**
 * Validate the section's structure and scalar values. Declared tables and columns are checked once the installed adapter is known.
 * `reserved` names modules whose rows this backup carries in Core's section, so they cannot also appear here.
 */
export function parseExternalModuleSection(value: unknown, scope: string, reserved: ReadonlySet<string> = new Set()): ExternalModuleBackupEntry[] {
  if (scope !== "installation") {
    if (value !== undefined) throw invalidSection();
    return [];
  }
  if (!Array.isArray(value) || value.length > 256) throw invalidSection();
  const firstParty = new Set(firstPartyModules.map((module) => module.id));
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isObject(entry) || Object.keys(entry).length !== entryKeys.length || entryKeys.some((key) => !Object.hasOwn(entry, key))) throw invalidSection();
    const { id, label, contractVersion, backupVersion, source, commit, tables } = entry;
    if (typeof id !== "string" || !moduleIdPattern.test(id) || id.length > 64 || firstParty.has(id) || reserved.has(id) || seen.has(id)) throw invalidSection();
    seen.add(id);
    if (typeof label !== "string" || !printable.test(label) || label.length > 120 || !positiveInteger(contractVersion) || !positiveInteger(backupVersion)) throw invalidSection();
    if (source !== null && (typeof source !== "string" || !printable.test(source) || source.length > 2048) || commit !== null && (typeof commit !== "string" || !commitPattern.test(commit))) throw invalidSection();
    if (!isObject(tables)) throw invalidSection();
    let rows = 0; const copied: MutableTables = {};
    for (const [table, tableRows] of Object.entries(tables)) {
      if (!safeName.test(table) || !Array.isArray(tableRows)) throw invalidSection();
      for (const row of tableRows) if (!isObject(row) || Object.entries(row).some(([column, cell]) => !safeName.test(column) || !safeValue(cell))) throw new HttpError(400, `Backup module ${id} table ${table} contains an invalid row`);
      rows += tableRows.length; copied[table] = tableRows.map((row) => ({ ...row }));
    }
    return { id, label, contractVersion: Number(contractVersion), backupVersion: Number(backupVersion), source: source as string | null, commit: commit as string | null, tables: copied, rows, coreSection: false };
  });
}

function requestedExclusions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some((id) => typeof id !== "string" || !moduleIdPattern.test(id) || id.length > 64) || new Set(value).size !== value.length) throw new HttpError(400, "excludeModules must list unique module identifiers");
  return value as string[];
}

export class ModuleRestoreRefusal extends HttpError {
  readonly body: Record<string, unknown>;
  constructor(body: { error: string; details: string[] } & Record<string, unknown>) {
    super(409, body.error, body.details);
    this.body = body;
  }
}

function describe(module: ExcludedModuleSummary) {
  const reason = module.status === "missing" ? "is not installed" : module.status === "newer" ? `is older than the backup (installed module backup version ${module.installedBackupVersion}, contract ${module.installedContractVersion})` : `uses a different module contract (installed contract ${module.installedContractVersion})`;
  const origin = [module.source ? `source ${module.source}` : "", module.commit ? `commit ${module.commit}` : ""].filter(Boolean).join(", ");
  return `${module.label} (${module.id}) ${reason}. The backup needs module backup version ${module.requiredBackupVersion} with contract ${module.requiredContractVersion}${origin ? ` from ${origin}` : ""} and holds ${module.rows} record${module.rows === 1 ? "" : "s"}.`;
}

function refusal(plan: Pick<ExternalModuleRestorePlan, "unavailable">, dependencies: readonly { moduleId: string; label: string; dependsOn: string }[]) {
  const blocked = dependencies.length > 0;
  const labels = new Map(plan.unavailable.map((module) => [module.id, module.label]));
  return new ModuleRestoreRefusal({
    error: blocked
      ? "This backup contains module data that cannot be discarded because restored modules depend on it. Install the listed modules and retry."
      : "This backup contains module data this installation cannot restore. Install the listed modules and retry, or confirm a restore that discards their data.",
    code: "module-restore-refused",
    reason: blocked ? "excluded-module-dependency" : "unavailable-modules",
    modules: plan.unavailable,
    dependencies: dependencies.map(({ moduleId, label, dependsOn }) => ({ moduleId, label, dependsOn })),
    optOut: { available: !blocked, excludeModules: plan.unavailable.map((module) => module.id) },
    details: [...plan.unavailable.map(describe), ...dependencies.map((item) => `${item.label} (${item.moduleId}) depends on ${labels.get(item.dependsOn) ?? item.dependsOn} (${item.dependsOn}).`)],
  });
}

/**
 * Decide which external modules restore and which are unavailable. A module is unavailable when it is not installed, the backup is
 * newer than the installed module, or it was exported under a different module contract. Unavailable modules are refused unless the
 * request names exactly those modules in `excludeModules`; the opt-out itself is refused while an included module depends on one.
 */
export function planExternalModuleRestore(entries: readonly ExternalModuleBackupEntry[], installed: readonly ExternalBackupModule[], excludeModules: unknown): ExternalModuleRestorePlan {
  const requested = requestedExclusions(excludeModules);
  const byId = new Map(installed.map((module) => [module.definition.id, module]));
  const included: IncludedExternalModule[] = []; const unavailable: ExcludedModuleSummary[] = [];
  for (const entry of entries) {
    const module = byId.get(entry.id); const definition = module?.definition;
    const status: UnavailableModuleStatus | undefined = !definition ? "missing" : entry.backupVersion > definition.backup.version || entry.contractVersion > definition.contractVersion ? "newer" : entry.contractVersion !== definition.contractVersion ? "incompatible" : undefined;
    if (!status) { included.push({ module: module!, entry }); continue; }
    unavailable.push({ id: entry.id, label: entry.label, status, requiredBackupVersion: entry.backupVersion, installedBackupVersion: definition?.backup.version ?? null, requiredContractVersion: entry.contractVersion, installedContractVersion: definition?.contractVersion ?? null, source: entry.source, commit: entry.commit, rows: entry.rows });
  }
  const excludedIds = new Set(unavailable.map((module) => module.id));
  const dependencies = included.flatMap(({ module }) => requiredModuleIds(module.definition).filter((dependency) => excludedIds.has(dependency)).map((dependsOn) => ({ moduleId: module.definition.id, label: module.definition.label, dependsOn })));
  if (dependencies.length) throw refusal({ unavailable }, dependencies);
  if (!unavailable.length && requested.length) throw new HttpError(400, "excludeModules may name only modules this installation cannot restore");
  const confirmed = requested.length === excludedIds.size && requested.every((id) => excludedIds.has(id));
  return { entries, included, unavailable, excludedIds, confirmed };
}

/** Refuse a restore whose unavailable modules were not explicitly excluded. Call after every other validation passes. */
export function requireConfirmedExclusions(plan: ExternalModuleRestorePlan) {
  if (!plan.confirmed) throw refusal(plan, []);
}

/** Core tables keyed by module identity. Excluded modules restore absent from each. Cleanup leases are non-portable. */
export const moduleKeyedTables = ["platform_module_epochs", "platform_modules", "platform_module_assignments", "platform_module_setup_progress"] as const;

export function removeExcludedModuleRows(tables: Record<(typeof moduleKeyedTables)[number], Row[]>, excluded: ReadonlySet<string>) {
  if (!excluded.size) return;
  for (const table of moduleKeyedTables) tables[table] = tables[table].filter((row) => !excluded.has(String(row.module_id)));
}

function declaredTables(module: ExternalBackupModule, tables: ModuleBackupTables): MutableTables {
  const { definition, adapter } = module; const declared = adapter?.tables ?? {}; const names = Object.keys(declared);
  const invalid = () => new HttpError(400, `Backup data for ${definition.label} does not match its declared tables`);
  if (!isObject(tables) || Object.keys(tables).length !== names.length || names.some((table) => !Object.hasOwn(tables, table))) throw invalid();
  return Object.fromEntries(names.map((table) => {
    const columns = declared[table]!; const rows = tables[table];
    if (!Array.isArray(rows)) throw invalid();
    for (const row of rows) {
      if (!isObject(row) || Object.keys(row).length !== columns.length || columns.some((column) => !Object.hasOwn(row, column) || !safeValue(row[column]))) throw invalid();
      if (row.installation_id !== "primary") throw new HttpError(400, `Backup table ${table} is not scoped to this installation`);
    }
    return [table, rows.map((row) => ({ ...row }))];
  }));
}

function runAdapter<T>(label: string, step: () => T): T {
  try { return step(); }
  catch (error) { if (error instanceof HttpError && error.status === 400) throw error; throw new HttpError(400, `Backup data for ${label} is invalid`); }
}

/**
 * Normalize, validate and neutralize an included module's rows. Returns rows for exactly the declared tables in restore order.
 * Rows from Core's section of a historical backup always pass through `normalize`, because their shape follows the file's schema.
 */
export function prepareIncludedModule({ module, entry }: IncludedExternalModule, context: ModuleBackupRestoreContext, backupSchemaVersion: number, installationCreatedAt: string | null = null): PreparedExternalModule {
  const { definition, adapter } = module; let tables: ModuleBackupTables = entry.tables;
  if (adapter && (entry.coreSection || entry.backupVersion < adapter.version)) {
    const normalize = adapter.normalize;
    if (!normalize) throw new HttpError(400, `Backup data for ${definition.label} uses module backup version ${entry.backupVersion}, which the installed module cannot upgrade`);
    const source = { backupSchemaVersion, coreSection: entry.coreSection, exportedAt: context.exportedAt, installationCreatedAt };
    tables = runAdapter(definition.label, () => normalize(structuredClone(entry.tables), entry.backupVersion, source));
  }
  let restored = declaredTables(module, tables);
  if (adapter?.validate) { const validate = adapter.validate; runAdapter(definition.label, () => validate(structuredClone(restored))); }
  let pausedOperations = 0;
  if (adapter?.pausedOperations) {
    const count = adapter.pausedOperations; pausedOperations = runAdapter(definition.label, () => count(structuredClone(restored)));
    if (!Number.isSafeInteger(pausedOperations) || pausedOperations < 0) throw new HttpError(400, `Backup data for ${definition.label} is invalid`);
  }
  if (adapter?.neutralize) { const neutralize = adapter.neutralize; restored = declaredTables(module, runAdapter(definition.label, () => neutralize(structuredClone(restored), context))); }
  return { module, tables: restored, pausedOperations };
}

/**
 * Clear every installed external module's declared tables before Core rows are replaced. Non-portable operational tables are treated as
 * children of portable tables, so they are cleared first; portable tables are cleared child-first in reverse declared order.
 */
export function clearExternalModuleStatements(db: D1Database, modules: readonly ExternalBackupModule[]): D1Statement[] {
  return modules.flatMap(({ definition, adapter }) => {
    const portable = adapter ? Object.keys(adapter.tables) : [...definition.backup.tables];
    const tables = [...(definition.backup.nonPortableTables ?? [])].reverse().concat([...portable].reverse());
    return tables.filter((table) => safeName.test(table)).map((table) => db.prepare(`DELETE FROM ${table} WHERE installation_id = 'primary'`));
  });
}

/**
 * Installed external modules absent from the restored state start fresh with a newer generation. External modules
 * have no installation seed; their `freshEnable` rows are created on first enablement.
 */
export function freshExternalModuleStatements(db: D1Database, modules: readonly ExternalBackupModule[], _now: string): D1Statement[] {
  return modules.flatMap(({ definition }) => [
    db.prepare(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES('primary',?,1)
      ON CONFLICT(installation_id,module_id) DO UPDATE SET generation=MAX(platform_module_epochs.generation,excluded.generation-1)+1`).bind(definition.id),
    db.prepare(`INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete)
      SELECT 'primary',?,?,generation,'disabled',?,0 FROM platform_module_epochs WHERE installation_id='primary' AND module_id=?`).bind(definition.id, definition.contractVersion, definition.setup.version, definition.id),
  ]);
}

export function insertExternalModuleStatements(db: D1Database, modules: readonly PreparedExternalModule[]): D1Statement[] {
  return modules.flatMap(({ module, tables }) => Object.entries(module.adapter?.tables ?? {}).flatMap(([table, columns]) => (tables[table] ?? []).map((row) =>
    db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...columns.map((column) => row[column])))));
}

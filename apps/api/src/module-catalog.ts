import { bundledModuleRegistry, type ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";
import { externalModuleManifests } from "../../../packages/shared/src/generated/external-manifests.ts";
import type { D1Database, D1Statement } from "./d1-usage.ts";
import type { CleanupStep } from "./module-cleanup.ts";
import { installedApiModule } from "./installed-api-modules.ts";
import { externalModuleMigrations, externalModuleSources } from "./generated/external-module-data.ts";
import { applyModuleMigrations, d1ModuleMigrationExecutor, type ModuleMigrationPackage } from "./module-migrations.ts";
import { extractedModules } from "./extracted-modules.ts";

const installationId = "primary";
const safeName = /^[a-z][a-z0-9_]*$/;

/** What Core needs to describe and delete a module's retained data without its code. */
export type CatalogDefinition = {
  readonly label: string;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly tables: readonly string[];
  readonly deletedData: readonly string[];
  readonly cleanup: readonly CleanupStep[];
  /** Hash of the last reviewed module migration (or adopted baseline), so new migrations trigger reconciliation. */
  readonly migrationHead?: string | null;
};
type CatalogRow = { moduleId: string; definitionSha256: string; installed: number };
/** `unconfigured` means there was work to record but the installation does not exist yet (before first-Admin setup). */
export type ModuleReconciliation = { readonly changed: boolean; readonly failures: readonly { readonly moduleId: string; readonly message: string }[]; readonly unconfigured?: true };
type ReconcileOptions = {
  readonly migrations?: readonly ModuleMigrationPackage[];
  readonly sources?: Readonly<Record<string, { readonly source: string; readonly commit: string }>>;
};

function definitionFor(module: ModuleDefinition, migrations?: ModuleMigrationPackage): CatalogDefinition {
  const cleanup = installedApiModule(module.id)?.cleanup.steps;
  if (!cleanup) throw new Error(`Module ${module.id} implementation is missing`);
  const migrationHead = migrations ? migrations.migrations.at(-1)?.sha256 ?? migrations.baseline?.sha256 ?? null : null;
  return { label: module.label, description: module.description, dependencies: module.dependencies, tables: module.persistence.tables, deletedData: module.deletedData, cleanup, migrationHead };
}

async function coreAppliedMigrations(db: D1Database): Promise<string[]> {
  try { return ((await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results ?? []).map((row) => row.name); }
  catch { return []; }
}

async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Apply each module's pending reviewed migrations, record installed module definitions, and register modules seen
 * for the first time as disabled. A module whose migrations fail stays unregistered and retries on the next pass,
 * without affecting other modules. Steady state costs one read; writes happen only when installed code changed.
 *
 * A module that moved from first-party into a plugin may have lifecycle state from before the catalog existed. When its
 * plugin is not installed and the catalog never recorded it, the definition it had as a first-party module is recorded as
 * removed (once, with no extra read), so Settings still describes any retained data and cleanup can still delete it.
 */
export async function reconcileInstalledModules(db: D1Database, now = new Date(), options: ReconcileOptions = {}): Promise<ModuleReconciliation> {
  const migrationPackages = new Map((options.migrations ?? externalModuleMigrations).map((pkg) => [pkg.moduleId, pkg]));
  const sources = options.sources ?? externalModuleSources;
  const recorded = new Map(((await db.prepare(`SELECT module_id AS moduleId,definition_sha256 AS definitionSha256,installed
    FROM platform_module_catalog WHERE installation_id=?`).bind(installationId).all<CatalogRow>()).results ?? []).map((row) => [row.moduleId, row]));
  const external = new Set(externalModuleManifests.map((module) => module.id));
  const changedModules: { module: ModuleDefinition; definitionJson: string; definitionSha256: string }[] = [];
  for (const module of bundledModuleRegistry.modules) {
    const definitionJson = JSON.stringify(definitionFor(module, migrationPackages.get(module.id))); const definitionSha256 = await sha256Hex(definitionJson);
    const current = recorded.get(module.id);
    if (current?.installed !== 1 || current.definitionSha256 !== definitionSha256) changedModules.push({ module, definitionJson, definitionSha256 });
  }
  const removed = [...recorded.values()].filter((row) => row.installed === 1 && !bundledModuleRegistry.get(row.moduleId));
  const retiredModules = extractedModules.filter((module) => !bundledModuleRegistry.get(module.id) && !recorded.has(module.id));
  if (!changedModules.length && !removed.length && !retiredModules.length) return { changed: false, failures: [] };
  const configured = await db.prepare("SELECT 1 AS configured FROM platform_module_administration WHERE installation_id=?").bind(installationId).first();
  if (!configured) return { changed: false, failures: [], unconfigured: true };

  const timestamp = now.toISOString();
  const failures: { moduleId: string; message: string }[] = [];
  const statements: D1Statement[] = [];
  let coreApplied: string[] | undefined;
  for (const { module, definitionJson, definitionSha256 } of changedModules) {
    const migrations = migrationPackages.get(module.id);
    if (migrations) {
      try { await applyModuleMigrations(d1ModuleMigrationExecutor(db), migrations, { coreAppliedMigrations: coreApplied ??= await coreAppliedMigrations(db), now: () => timestamp }); }
      catch (error) { failures.push({ moduleId: module.id, message: error instanceof Error ? error.message : "Module migrations failed" }); continue; }
    }
    const source = sources[module.id];
    statements.push(
      db.prepare(`INSERT INTO platform_module_catalog(installation_id,module_id,origin,source,source_commit,contract_version,definition_json,definition_sha256,installed,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,1,?) ON CONFLICT(installation_id,module_id) DO UPDATE SET origin=excluded.origin,source=excluded.source,source_commit=excluded.source_commit,
        contract_version=excluded.contract_version,definition_json=excluded.definition_json,definition_sha256=excluded.definition_sha256,installed=1,recorded_at=excluded.recorded_at`)
        .bind(installationId, module.id, external.has(module.id) ? "external" : "first-party", source?.source ?? null, source?.commit ?? null, module.contractVersion, definitionJson, definitionSha256, timestamp),
      db.prepare("INSERT OR IGNORE INTO platform_module_epochs(installation_id,module_id,generation) VALUES(?,?,1)").bind(installationId, module.id),
      db.prepare(`INSERT OR IGNORE INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete)
        SELECT ?,?,?,generation,'disabled',?,0 FROM platform_module_epochs WHERE installation_id=? AND module_id=?`)
        .bind(installationId, module.id, module.contractVersion, module.setup.version, installationId, module.id),
    );
  }
  for (const row of removed) statements.push(db.prepare("UPDATE platform_module_catalog SET installed=0,recorded_at=? WHERE installation_id=? AND module_id=?").bind(timestamp, installationId, row.moduleId));
  for (const module of retiredModules) {
    const definitionJson = JSON.stringify(module.catalogDefinition);
    statements.push(db.prepare(`INSERT INTO platform_module_catalog(installation_id,module_id,origin,source,source_commit,contract_version,definition_json,definition_sha256,installed,recorded_at)
      VALUES(?,?,'first-party',NULL,NULL,?,?,?,0,?) ON CONFLICT(installation_id,module_id) DO NOTHING`)
      .bind(installationId, module.id, module.contractVersion, definitionJson, await sha256Hex(definitionJson), timestamp));
  }
  if (statements.length) await db.batch(statements);
  return { changed: statements.length > 0, failures };
}

const isolateReconciliation = new WeakMap<object, { done: boolean; pending?: Promise<void>; retryAt: number }>();
const reconciliationRetryMs = 60_000;

/**
 * Reconcile once per Worker isolate and database binding, before the first request is served. A deployment starts new
 * isolates, so a plugin's new migrations and definition are applied before its code handles a request, without waiting
 * for the scheduled pass. Skipped while an update holds maintenance; a failed attempt, including one in which a module's
 * migrations failed and that module was left unrecorded, retries after a minute. Before
 * first-Admin setup there is nothing to record, so the isolate keeps checking on later requests instead of waiting for
 * the scheduled pass once the installation exists.
 */
export function ensureModulesReconciled(db: D1Database, key: object, suspended: () => Promise<boolean>, now = () => Date.now(), reconcile: (db: D1Database) => Promise<ModuleReconciliation> = reconcileInstalledModules): Promise<void> {
  let state = isolateReconciliation.get(key);
  if (!state) isolateReconciliation.set(key, state = { done: false, retryAt: 0 });
  if (state.done) return Promise.resolve();
  if (state.pending) return state.pending;
  if (now() < state.retryAt) return Promise.resolve();
  const current = state;
  current.pending = (async () => {
    try {
      if (await suspended()) return;
      const result = await reconcile(db);
      if (result.failures.length) current.retryAt = now() + reconciliationRetryMs;
      else if (!result.unconfigured) current.done = true;
    }
    catch { current.retryAt = now() + reconciliationRetryMs; }
    finally { current.pending = undefined; }
  })();
  return current.pending;
}

function parseDefinition(value: string): CatalogDefinition {
  const definition = JSON.parse(value) as CatalogDefinition;
  const strings = (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string");
  if (typeof definition.label !== "string" || typeof definition.description !== "string" || !strings(definition.dependencies) || !strings(definition.tables) || !strings(definition.deletedData)
    || definition.migrationHead !== undefined && definition.migrationHead !== null && typeof definition.migrationHead !== "string"
    || !Array.isArray(definition.cleanup) || !definition.cleanup.length || definition.cleanup.some((step) => step.kind !== "assignments" && !safeName.test(step.table))) throw new Error("Recorded module definition is invalid");
  return definition;
}

/** Recorded definitions of modules whose code is no longer installed. */
export async function readRemovedModuleDefinitions(db: D1Database, moduleIds: readonly string[]): Promise<Map<string, CatalogDefinition>> {
  const removed = moduleIds.filter((moduleId) => !bundledModuleRegistry.get(moduleId));
  if (!removed.length) return new Map();
  const rows = (await db.prepare(`SELECT module_id AS moduleId,definition_json AS definitionJson FROM platform_module_catalog
    WHERE installation_id=? AND installed=0 AND module_id IN (${removed.map(() => "?").join(",")})`).bind(installationId, ...removed).all<{ moduleId: string; definitionJson: string }>()).results ?? [];
  return new Map(rows.map((row) => [row.moduleId, parseDefinition(row.definitionJson)]));
}

// Child process for scripts/compose-modules.mjs. Imports a plugin's manifest and API entries and prints only
// declarative data: the manifest, and the names and shapes of the API contribution's handlers. It runs with a
// minimal environment so plugin module code never sees deployment credentials held by the composing process.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// The module SDK always resolves to this Core's copy, wherever the plugin checkout is, as it does in a composed build.
const coreParent = new URL("../package.json", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@lancerlogin/module-sdk" || specifier.startsWith("@lancerlogin/module-sdk/")) return nextResolve(specifier, { ...context, parentURL: coreParent });
    return nextResolve(specifier, context);
  },
});

const [manifestPath, apiPath] = process.argv.slice(2);
if (!manifestPath || !apiPath) throw new Error("Usage: inspect-module-plugin.mjs <manifest> <api>");

const handlerNames = (value, name) => {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`API contribution ${name} must be an object of handlers`);
  for (const [key, handler] of Object.entries(value)) if (typeof handler !== "function") throw new Error(`API contribution ${name}.${key} must be a function`);
  return Object.keys(value);
};

const manifest = (await import(pathToFileURL(manifestPath).href)).default;
const api = (await import(pathToFileURL(apiPath).href)).default;
if (!manifest || typeof manifest !== "object") throw new Error("The manifest entry must default-export a module definition");
if (!api || typeof api !== "object") throw new Error("The api entry must default-export an API module contribution");
const known = new Set(["moduleId", "routes", "coreRoutes", "privateResponseRoutes", "setup", "jobs", "reports", "reportFilters", "discord", "rosterReferences", "cleanup", "installationSeed", "freshEnable", "backup"]);
const unknown = Object.keys(api).filter((key) => !known.has(key));
if (unknown.length) throw new Error(`API contribution has unknown fields: ${unknown.join(", ")}`);
if (!api.setup || typeof api.setup.stepValid !== "function") throw new Error("API contribution setup.stepValid must be a function");
if (!api.cleanup || !Array.isArray(api.cleanup.steps)) throw new Error("API contribution cleanup.steps must be an array");
for (const name of ["installationSeed", "freshEnable"]) if (api[name] !== undefined && typeof api[name] !== "function") throw new Error(`API contribution ${name} must be a function`);
const blocker = api.cleanup.blocker;
if (blocker !== undefined && (!blocker || typeof blocker.sql !== "string" || typeof blocker.bindings !== "function")) throw new Error("API contribution cleanup.blocker is invalid");
if (api.privateResponseRoutes !== undefined && (!Array.isArray(api.privateResponseRoutes) || api.privateResponseRoutes.some((path) => typeof path !== "string"))) throw new Error("API contribution privateResponseRoutes must be route paths");
const backup = api.backup;
if (backup !== undefined) {
  if (!backup || typeof backup !== "object" || Array.isArray(backup) || !Number.isSafeInteger(backup.version) || !backup.tables || typeof backup.tables !== "object" || Array.isArray(backup.tables)
    || Object.values(backup.tables).some((columns) => !Array.isArray(columns) || columns.some((column) => typeof column !== "string"))) throw new Error("API contribution backup adapter is invalid");
  for (const hook of ["normalize", "validate", "neutralize", "pausedOperations"]) if (backup[hook] !== undefined && typeof backup[hook] !== "function") throw new Error(`API contribution backup.${hook} must be a function`);
}
const filters = api.reportFilters;
if (filters !== undefined && (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.values(filters).some((handler) => !handler || typeof handler.options !== "function"))) throw new Error("API contribution reportFilters must map filter IDs to handlers with options");
const references = api.rosterReferences;
if (references !== undefined && (!references || typeof references.label !== "string" || !Array.isArray(references.columns) || references.columns.some((item) => !item || typeof item.table !== "string" || typeof item.column !== "string"))) throw new Error("API contribution rosterReferences is invalid");

process.stdout.write(JSON.stringify({
  manifest: JSON.parse(JSON.stringify(manifest)),
  api: {
    moduleId: api.moduleId,
    coreRoutes: api.coreRoutes,
    privateResponseRoutes: api.privateResponseRoutes,
    installationSeed: api.installationSeed !== undefined,
    freshEnable: api.freshEnable !== undefined,
    backup: backup ? { version: backup.version, tables: backup.tables, hooks: ["normalize", "validate", "neutralize", "pausedOperations"].filter((hook) => backup[hook] !== undefined) } : undefined,
    reportFilters: Object.keys(filters ?? {}),
    rosterReferences: references ? { label: references.label, columns: references.columns.map(({ table, column }) => ({ table, column })) } : undefined,
    routes: handlerNames(api.routes, "routes"),
    setupPredicates: handlerNames(api.setup.predicates, "setup.predicates"),
    jobs: handlerNames(api.jobs, "jobs"),
    reports: handlerNames(api.reports, "reports"),
    discord: handlerNames(api.discord, "discord"),
    cleanup: { steps: JSON.parse(JSON.stringify(api.cleanup.steps)), blocker: blocker ? { sql: blocker.sql, recordFailure: blocker.recordFailure } : undefined },
  },
}));

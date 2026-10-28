import type { ModuleDefinition } from "../../../packages/shared/src/module-platform.ts";
import { externalModuleManifests } from "../../../packages/shared/src/generated/external-manifests.ts";
import type { D1Database, D1Statement } from "./d1-usage.ts";
import type { ModuleCredentials } from "./integration-crypto.ts";
import type { CleanupStep } from "./module-cleanup.ts";
import type { DiscordModuleInteractionHandler } from "./module-discord.ts";
import type { ModuleEmailMessage } from "./module-email.ts";
import type { ReportProjectionHandler } from "./module-reporting.ts";

export type ModuleRole = "admin" | "operator";
export type ModulePrincipal = { readonly userId: string; readonly role: ModuleRole };
export type SqlPredicate = { readonly sql: string; readonly bindings: readonly unknown[] };

/** Shared provider access bound to the current module-scoped environment. Credentials stay with Core. */
export type CoreModuleServices = {
  readonly googleCalendar: {
    ready(): Promise<boolean>;
    access(): Promise<{ readonly accessToken: string; readonly calendarId: string | null }>;
    operationPath(calendarId: string, eventId?: string): string;
    request(accessToken: string, path: string, init: RequestInit): Promise<unknown>;
    /** HTTP status of a Google Calendar provider failure, or undefined for any other error. */
    providerStatus(error: unknown): number | undefined;
  };
  readonly discord: {
    ready(): Promise<boolean>;
    client(): Promise<{ readonly guildId: string; request<T = Record<string, unknown>>(path: string, init: RequestInit): Promise<{ readonly body: T }> }>;
    /** HTTP status of a Discord response failure, or undefined for any other error. */
    providerStatus(error: unknown): number | undefined;
  };
  /** One message at a time through the installation's verified Resend connection. Core keeps the API key and From address. */
  readonly email: {
    /** Resend is enabled and verified. */
    ready(): Promise<boolean>;
    /** Send to one recipient. Core prefixes the idempotency key with the module ID. Returns Resend's message ID. */
    send(message: ModuleEmailMessage): Promise<{ readonly id: string | null }>;
    /** HTTP status of a Resend rejection, or undefined for any other error. */
    providerStatus(error: unknown): number | undefined;
  };
  /** Encrypt module-owned credentials with Core's integration key. */
  readonly credentials: ModuleCredentials;
  /** Other modules' interfaces this module declares in `uses` (SDK 1.1.0). */
  readonly modules: {
    /**
     * A client for a declared interface use, or undefined when the module did not declare it, the provider is not installed,
     * enabled and set up, or neither an Admin's grant nor the signed-in user authorizes any of the declared operations.
     */
    interface(id: string, version: number): Promise<ModuleInterfaceClient | undefined>;
  };
};

/** Calls one declared interface. Each call rechecks authority; a provider failure arrives as an `HttpError`. */
export type ModuleInterfaceClient = {
  /** Call a declared operation with a JSON input; resolves to the provider's JSON result. */
  call(operation: string, input?: unknown): Promise<unknown>;
};
/** Who is calling an interface operation: the calling module, with the signed-in user or the Admin grant it called under. */
export type ModuleInterfaceCaller = { readonly moduleId: string; readonly userId?: string; readonly grantId?: string };
/** What a provider's interface handler receives besides the input. `db` and `services` are the provider's own, for its current generation. */
export type ModuleInterfaceCallContext = { readonly db: D1Database; readonly services: CoreModuleServices; readonly caller: ModuleInterfaceCaller };
/** Validate the input; return a JSON result or throw an `HttpError` the caller receives with its status and message. */
export type ModuleInterfaceHandler = (context: ModuleInterfaceCallContext, input: unknown) => Promise<unknown>;

/** Core-owned request services handed to module route handlers. `env` and `db` are already module scoped. */
export type ModuleRouteContext<Environment> = {
  readonly request: Request;
  readonly url: URL;
  readonly env: Environment;
  readonly db: D1Database;
  readonly services: CoreModuleServices;
  requireRole(roles: readonly ModuleRole[]): Promise<ModulePrincipal>;
  /** Parse a bounded JSON request body. */
  json<T = unknown>(maxBytes?: number): Promise<T>;
  /** The bounded JSON body for mutating methods, or undefined for GET. */
  body<T = unknown>(maxBytes?: number): Promise<T | undefined>;
  respond(body: unknown, status?: number): Response;
  requireDashboardOrigin(message: string): void;
  /** The installation's dashboard origin, for example to check that a public form was submitted from the dashboard. */
  readonly dashboardOrigin: string | undefined;
};
/** Return undefined when the route family is declared but this exact request is not handled. */
export type ModuleRouteHandler<Environment> = (context: ModuleRouteContext<Environment>) => Promise<Response | undefined>;

export type ModuleJobContext<Environment> = { readonly env: Environment; readonly db: D1Database; readonly services: CoreModuleServices };
export type ModuleSetupBinding = {
  readonly predicates: Readonly<Record<string, (installationId: string) => SqlPredicate>>;
  readonly stepValid: (db: D1Database, stepId: string) => Promise<boolean>;
};
export type ModuleLifecycleContext = { readonly installationId: string; readonly now: string };

/** Rows of a module's declared portable tables, keyed by table name. Values are JSON scalars. */
export type ModuleBackupTables = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
export type ModuleBackupRestoreContext = { readonly installationId: string; readonly exportedAt: string; readonly restoredAt: string };
/** Where rows handed to `normalize` came from. */
export type ModuleBackupSource = {
  /** Schema version of the whole backup file. */
  readonly backupSchemaVersion: number;
  /** When the backup was exported. */
  readonly exportedAt: string;
  /** When the backed-up installation was created, from the backup's Core section, or null if the file does not say. */
  readonly installationCreatedAt: string | null;
  /**
   * True for rows Core carried in its own section of a backup made while the module was first-party, before it moved into a
   * plugin. Their shape follows `backupSchemaVersion`, and `fromVersion` is the module backup version recorded in that file.
   */
  readonly coreSection: boolean;
};
/**
 * Portable backup handling for an external module. Core exports and restores only the declared tables and columns,
 * scoped to the installation, inside the same atomic restore batch as Core data.
 */
export type ModuleBackupAdapter = {
  /** Equals the manifest's `backup.version`. Increase it whenever the exported shape changes. */
  readonly version: number;
  /** Every portable table in the manifest's `backup.tables`, in parent-first restore order, with its exported columns. */
  readonly tables: Readonly<Record<string, readonly string[]>>;
  /** Convert rows exported by an older module backup version into the current declared shape. */
  readonly normalize?: (tables: ModuleBackupTables, fromVersion: number, source: ModuleBackupSource) => ModuleBackupTables;
  /** Throw to reject restored content before any write. */
  readonly validate?: (tables: ModuleBackupTables) => void;
  /** Replace transient authority before insertion so credentials, leases, grants and pending work never revive. */
  readonly neutralize?: (tables: ModuleBackupTables, context: ModuleBackupRestoreContext) => ModuleBackupTables;
  /** Provider operations in the validated rows that `neutralize` pauses for explicit review. Core reports the total after restore. */
  readonly pausedOperations?: (tables: ModuleBackupTables) => number;
};

/** One choice of a module report filter, such as a label. Archived options stay listed so saved filters remain readable. */
export type ModuleReportFilterOption = { readonly id: string; readonly name: string; readonly archived: boolean };
/** Server-side handling of a report filter the module declares. Core validates saved selections against these options. */
export type ModuleReportFilterHandler = {
  /**
   * All options. Core calls this with its database outside module lifecycle checks, as it read Outreach labels while
   * Outreach was first-party, so saved selections stay readable while the module is disabled. Read only the module's own tables.
   */
  options(db: D1Database): Promise<readonly ModuleReportFilterOption[]>;
};
/**
 * Module tables that refer to roster members. Core refuses to delete a member, or the whole roster, while any row refers
 * to it, and names the module with `label` in the message, so history never loses its member.
 */
export type ModuleRosterReferences = {
  readonly label: string;
  readonly columns: readonly { readonly table: string; readonly column: string }[];
};

export type ApiModuleContribution<Environment> = {
  readonly moduleId: string;
  /** Handlers keyed by each declared API route path. */
  readonly routes?: Readonly<Record<string, ModuleRouteHandler<Environment>>>;
  /** First-party only: declared routes remain in the Core dispatcher. */
  readonly coreRoutes?: true;
  /** Declared route paths whose responses, including errors, must not be cached or indexed. */
  readonly privateResponseRoutes?: readonly string[];
  readonly setup: ModuleSetupBinding;
  readonly jobs?: Readonly<Record<string, (context: ModuleJobContext<Environment>) => Promise<unknown>>>;
  readonly reports?: Readonly<Record<string, ReportProjectionHandler>>;
  /** Handlers keyed by each report filter the manifest declares in `reportFilters`. */
  readonly reportFilters?: Readonly<Record<string, ModuleReportFilterHandler>>;
  readonly rosterReferences?: ModuleRosterReferences;
  readonly discord?: Readonly<Record<string, DiscordModuleInteractionHandler>>;
  /** Handlers for every operation of every interface the manifest declares in `interfaces`, keyed by interface ID then operation ID. */
  readonly interfaces?: Readonly<Record<string, Readonly<Record<string, ModuleInterfaceHandler>>>>;
  readonly cleanup: {
    readonly steps: readonly CleanupStep[];
    /** Work that must drain before retained data is deleted. */
    readonly blocker?: { readonly sql: string; readonly bindings: (installationId: string) => readonly unknown[]; readonly recordFailure?: boolean };
  };
  /** First-party only: rows created with a new installation. External modules seed in `freshEnable`, after their migrations. */
  readonly installationSeed?: (db: D1Database, context: ModuleLifecycleContext) => readonly D1Statement[];
  /** Idempotent rows created in the same batch as a first enablement, including enablement after completed deletion. */
  readonly freshEnable?: (db: D1Database, context: ModuleLifecycleContext) => readonly D1Statement[];
  /** External modules only: portable backup handling. Required when the manifest declares portable tables. First-party backup handling stays in Core. */
  readonly backup?: ModuleBackupAdapter;
};

type Registry = { readonly modules: readonly ModuleDefinition[] };
const safeName = /^[a-z][a-z0-9_]*$/;

function sameKeys(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((key) => expected.includes(key));
}

/** Composed plugin modules. First-party modules are the repository's own and keep their backup handling in Core. */
export const externalModuleIds: ReadonlySet<string> = new Set(externalModuleManifests.map((module) => module.id));

function validateBackupAdapter(module: ModuleDefinition, adapter: ModuleBackupAdapter | undefined, external: boolean) {
  if (!external) {
    if (adapter) throw new Error(`First-party module ${module.id} keeps backup handling in Core`);
    return;
  }
  if (module.persistence.sharedFields.length) throw new Error(`External module ${module.id} cannot own fields on Core rows`);
  if (!adapter) {
    if (module.backup.tables.length) throw new Error(`External module ${module.id} requires a backup adapter for its portable tables`);
    return;
  }
  const tables = Object.keys(adapter.tables);
  if (!Number.isSafeInteger(adapter.version) || adapter.version !== module.backup.version) throw new Error(`Module ${module.id} backup adapter version does not match its manifest`);
  if (!sameKeys(tables, module.backup.tables) || tables.some((table) => !safeName.test(table))) throw new Error(`Module ${module.id} backup adapter tables do not match its portable tables`);
  for (const table of tables) {
    const columns = adapter.tables[table]!;
    if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length || columns.some((column) => typeof column !== "string" || !safeName.test(column)) || !columns.includes("installation_id")) throw new Error(`Module ${module.id} backup adapter columns for ${table} are invalid`);
  }
  for (const hook of [adapter.normalize, adapter.validate, adapter.neutralize, adapter.pausedOperations]) if (hook !== undefined && typeof hook !== "function") throw new Error(`Module ${module.id} backup adapter hooks are invalid`);
  const transient = module.persistence.transientAuthority.filter((field) => tables.includes(field.table));
  if (transient.length && !adapter.neutralize) throw new Error(`Module ${module.id} backup adapter must neutralize transient authority`);
  if (transient.some((field) => field.columns.some((column) => !adapter.tables[field.table]!.includes(column)))) throw new Error(`Module ${module.id} transient authority must be exported to be neutralized`);
}

/** Bind module implementations to their registry declarations, rejecting any missing or undeclared contribution. */
export function createApiModuleSet<Environment>(registry: Registry, contributions: readonly ApiModuleContribution<Environment>[], options: { readonly externalModuleIds?: ReadonlySet<string> } = {}) {
  const external = options.externalModuleIds ?? externalModuleIds;
  const byId = new Map<string, ApiModuleContribution<Environment>>();
  for (const contribution of contributions) {
    const module = registry.modules.find((item) => item.id === contribution.moduleId);
    if (!module || byId.has(module.id)) throw new Error("Invalid or duplicate module contribution");
    if (contribution.coreRoutes ? contribution.routes : !sameKeys(Object.keys(contribution.routes ?? {}), module.apiRoutes.map((route) => route.path))) throw new Error(`Module ${module.id} route handlers do not match declared routes`);
    if (contribution.privateResponseRoutes?.some((path) => !module.apiRoutes.some((route) => route.path === path))) throw new Error(`Module ${module.id} private response routes must be declared`);
    if (!sameKeys(Object.keys(contribution.setup.predicates), module.setup.steps.map((step) => step.id))) throw new Error(`Module ${module.id} setup bindings do not match declared steps`);
    if (!sameKeys(Object.keys(contribution.jobs ?? {}), module.jobs.map((job) => job.id))) throw new Error(`Module ${module.id} job handlers do not match declared jobs`);
    if (!sameKeys(Object.keys(contribution.reports ?? {}), (module.reportDatasets ?? []).map((dataset) => dataset.id))) throw new Error(`Module ${module.id} report handlers do not match declared datasets`);
    if (!sameKeys(Object.keys(contribution.reportFilters ?? {}), (module.reportFilters ?? []).map((filter) => filter.id)) || Object.values(contribution.reportFilters ?? {}).some((handler) => typeof handler?.options !== "function")) throw new Error(`Module ${module.id} report filter handlers do not match declared filters`);
    const references = contribution.rosterReferences;
    if (references && (typeof references.label !== "string" || !references.label.trim() || references.label.length > 40 || !Array.isArray(references.columns) || !references.columns.length || references.columns.some((item) => !module.persistence.tables.includes(item.table) || !safeName.test(item.column)))) throw new Error(`Module ${module.id} roster references must name its own tables`);
    if (!sameKeys(Object.keys(contribution.discord ?? {}), module.discordCommands.map((command) => command.name))) throw new Error(`Module ${module.id} Discord handlers do not match declared commands`);
    const interfaces = contribution.interfaces ?? {};
    if (!sameKeys(Object.keys(interfaces), (module.interfaces ?? []).map((definition) => definition.id)) || (module.interfaces ?? []).some((definition) => {
      const handlers = interfaces[definition.id];
      return !handlers || typeof handlers !== "object" || !sameKeys(Object.keys(handlers), definition.operations.map((operation) => operation.id)) || Object.values(handlers).some((handler) => typeof handler !== "function");
    })) throw new Error(`Module ${module.id} interface handlers do not match declared interface operations`);
    if (external.has(module.id) && (contribution.coreRoutes || contribution.installationSeed)) throw new Error(`External module ${module.id} cannot use Core routes or installation seeds`);
    if (!contribution.cleanup.steps.length || contribution.cleanup.steps.some((step) => step.kind !== "assignments" && !safeName.test(step.table))) throw new Error(`Module ${module.id} cleanup steps are invalid`);
    validateBackupAdapter(module, contribution.backup, external.has(module.id));
    byId.set(module.id, contribution);
  }
  for (const module of registry.modules) if (!byId.has(module.id)) throw new Error(`Module ${module.id} implementation is missing`);
  const all = registry.modules.map((module) => byId.get(module.id)!);
  return Object.freeze({
    all,
    get: (moduleId: string) => byId.get(moduleId),
    require(moduleId: string) { const contribution = byId.get(moduleId); if (!contribution) throw new Error("Unknown module contribution"); return contribution; },
  });
}

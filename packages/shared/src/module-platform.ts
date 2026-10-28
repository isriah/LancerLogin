import { externalModuleManifests } from "./generated/external-manifests.ts";
import { coreMemberReportFieldDefinitions, reportFilterOperators } from "./module-report-fields.ts";

// Report field helpers live in a module without imports of installed manifests, so plugin manifests can use them while
// this registry module is still loading those manifests.
export { coreMemberReportFieldDefinitions, reportFilterOperators };

export type ModuleLifecyclePhase = "disabled" | "enabled" | "retained" | "deleting" | "deleted";

export type ModuleCapabilityDefinition = {
  readonly id: string;
  readonly label: string;
  readonly operator: boolean;
};

export type ModuleApiRouteDefinition = {
  readonly path: string;
  readonly match: "exact" | "prefix" | "pattern";
  readonly access: "workspace" | "service" | "setup";
};

export type ModuleDiscordCommandDefinition = {
  readonly name: string;
  readonly type: 1;
  readonly description: string;
  readonly options?: readonly { readonly name: string; readonly description: string; readonly type: 3; readonly required?: boolean }[];
};

export type ReportFilterOperator = "contains" | "minimum" | "equals" | "maximum" | "between" | "empty" | "not_empty";

export type ReportDurationUnit = "minutes" | "hours";

export type ReportFieldDefinition = {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly kind: "dimension" | "measure";
  readonly valueType: "text" | "number" | "date";
  readonly sortable: boolean;
  readonly filterOperators: readonly ReportFilterOperator[];
  readonly requiresLabel?: boolean;
  readonly durationUnits?: readonly ReportDurationUnit[];
  readonly defaultDurationUnit?: ReportDurationUnit;
};

export type ReportDatasetDefinition = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly rowIdentity: string;
  readonly capability: string;
  readonly fields: readonly ReportFieldDefinition[];
  /** Core filter IDs (`coreReportFilterIds`) and filters declared in the owning module's `reportFilters`. */
  readonly filters: readonly string[];
  readonly groupBy: readonly string[];
  readonly defaultColumns: readonly string[];
  readonly defaultSort: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly relationships: readonly { readonly dataset: string; readonly localField: string; readonly foreignField: string }[];
  /** Former field IDs that saved report definitions may still use, mapped to the current field ID of this dataset. */
  readonly fieldAliases?: Readonly<Record<string, string>>;
};

/** Filters Core applies itself. Module filters use other, namespaced IDs. */
export const coreReportFilterIds = Object.freeze(["period", "roster", "meeting-type", "labels", "membership"] as const);
export type CoreReportFilterId = (typeof coreReportFilterIds)[number];
/** Report definition properties owned by Core. Module filters store their selections under other property names. */
export const coreReportDefinitionKeys = Object.freeze(["version", "dataset", "groupBy", "period", "roster", "meetingType", "labelIds", "labelMatch", "membership", "columns", "columnFilters", "sort"] as const);

/**
 * A report filter a module contributes: a selection of the module's own options (such as its labels), matched any or all.
 * Core validates and stores the selection; the module's report projections apply it and its API contribution lists the options.
 * The ID is namespaced by the module's report datasets: `<namespace>-<name>` or `<namespace>.<name>`, where `<namespace>` is the
 * first segment of one of the module's dataset IDs. Saved definitions keep the selection under `selectionKey` and the match
 * mode under `matchKey`, so a filter keeps working for existing saved reports when it moves between modules.
 */
export type ReportModuleFilterDefinition = {
  readonly id: string;
  readonly kind: "option-set";
  /** Plural name of the options, for example "Outreach labels". */
  readonly label: string;
  /** Singular name of one option, for example "Outreach label". */
  readonly optionLabel: string;
  /** Lowercase generic noun used in match choices, for example "label" in "Any selected label". */
  readonly optionNoun: string;
  readonly selectionKey: string;
  readonly matchKey: string;
};

/** One request and response operation of a provided interface. */
export type ModuleInterfaceOperationDefinition = {
  readonly id: string;
  /** Plain-language description an Admin reads when granting access, for example "Create Outreach supported teams". */
  readonly label: string;
  /** One of the provider's own capabilities. A signed-in caller needs it; a standing grant replaces it only when grantable. */
  readonly capability: string;
  /** Whether an Admin may grant this operation to another module, for calls from jobs and public requests. */
  readonly grantable: boolean;
};

/** Worker calls a module offers other modules. The ID is namespaced by the provider: `<module id>.<name>`. */
export type ModuleInterfaceDefinition = {
  readonly id: string;
  /** Major version. A consumer names the version it was written for; an incompatible change is a new version. */
  readonly version: number;
  readonly label: string;
  readonly operations: readonly ModuleInterfaceOperationDefinition[];
};

/** Another module's interface this module calls. A required use behaves like a dependency; an optional one may be missing. */
export type ModuleInterfaceUse = {
  readonly interface: string;
  readonly version: number;
  readonly operations: readonly string[];
  readonly required: boolean;
  /** Why the module asks, shown to Admins who grant it access. */
  readonly reason: string;
};

export type ModuleDefinition = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly contractVersion: number;
  readonly available: boolean;
  readonly dependencies: readonly string[];
  /** Interfaces this module provides to other modules (SDK 1.1.0). */
  readonly interfaces?: readonly ModuleInterfaceDefinition[];
  /** Interfaces of other modules this module calls (SDK 1.1.0). */
  readonly uses?: readonly ModuleInterfaceUse[];
  readonly capabilities: readonly ModuleCapabilityDefinition[];
  readonly navigation: readonly { readonly label: string; readonly path: string }[];
  readonly settings: readonly { readonly label: string; readonly path: string }[];
  readonly setup: {
    readonly version: number;
    readonly steps: readonly { readonly id: string; readonly label: string; readonly required: boolean }[];
  };
  /** Scheduled jobs. `label` names the job in scheduler controls. */
  readonly jobs: readonly { readonly id: string; readonly interval: number; readonly label?: string }[];
  readonly discordCommands: readonly ModuleDiscordCommandDefinition[];
  readonly reportDatasets?: readonly ReportDatasetDefinition[];
  /** Report filters this module's datasets offer in addition to Core filters. */
  readonly reportFilters?: readonly ReportModuleFilterDefinition[];
  /** Page walkthroughs whose progress Core stores per account: page ID to content version and step IDs. */
  readonly walkthroughs?: Readonly<Record<string, { readonly version: number; readonly steps: readonly string[] }>>;
  readonly apiRoutes: readonly ModuleApiRouteDefinition[];
  /** Name prefix of every table, index and trigger the module owns. First-party Attendance keeps its historical names and declares none. */
  readonly tablePrefix?: string;
  readonly persistence: {
    /** Tables whose data and cleanup behavior belong to this module. */
    readonly tables: readonly string[];
    /** Module-owned fields stored on a Core row. */
    readonly sharedFields: readonly { readonly table: string; readonly columns: readonly string[] }[];
    /** Portable fields that must be replaced or neutralized during restore. */
    readonly transientAuthority: readonly { readonly table: string; readonly columns: readonly string[] }[];
  };
  readonly backup: {
    readonly version: number;
    readonly tables: readonly string[];
    /** Operational state excluded from portable exports and removed on recovery. */
    readonly nonPortableTables?: readonly string[];
  };
  readonly lifecycle: {
    /** Declared tables, filtered rows, or shared fields handled by retained-data cleanup. */
    readonly cleanupTargets: readonly string[];
  };
  readonly deletedData: readonly string[];
};

export type ModuleSnapshotItem = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly contractVersion: number;
  readonly enabled: boolean;
  readonly phase: ModuleLifecyclePhase;
  readonly generation: number;
  readonly dependencies: readonly string[];
  readonly permissions: readonly ModuleCapabilityDefinition[];
  readonly effectiveCapabilities: readonly string[];
  readonly workspaceReady: boolean;
  readonly navigation: ModuleDefinition["navigation"];
  readonly settings: ModuleDefinition["settings"];
  readonly setup: ModuleDefinition["setup"] & { readonly ready: boolean };
  readonly deletion: {
    readonly disabledAt: string | null;
    readonly deleteAfter: string | null;
    readonly contentStillPresent: boolean;
    readonly cleanupFailure: string | null;
    readonly data: readonly string[];
  };
  /** `removed`: code is no longer installed but lifecycle or retained data remains. `setup-incomplete`: installed, database setup still pending. */
  readonly unavailable?: "removed" | "setup-incomplete";
};

export type ModulePlatformSnapshot = {
  readonly revision: number;
  readonly selectionCompleted: boolean;
  readonly capabilities: readonly string[];
  readonly modules: readonly ModuleSnapshotItem[];
};

const moduleIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const capabilityPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const tablePrefixPattern = /^[a-z][a-z0-9_]*_$/;
const interfaceIdPattern = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const operationIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const plainText = (value: unknown, maximum: number) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum;
const interfaceVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000;
// Manifests arrive as untyped JSON from plugin inspection; a boolean check keeps their declared element types.
const isList = (value: unknown): boolean => Array.isArray(value);

/** The module whose ID prefixes an interface ID, or undefined for a malformed ID. */
export function interfaceProviderId(interfaceId: string): string | undefined {
  return interfaceId.length <= 80 ? interfaceIdPattern.exec(interfaceId)?.[1] : undefined;
}

/** Modules that must be enabled first: declared dependencies, then the providers of required interface uses. */
export function requiredModuleIds(module: ModuleDefinition): string[] {
  return [...new Set([...module.dependencies, ...(module.uses ?? []).filter((use) => use.required).map((use) => interfaceProviderId(use.interface) ?? use.interface)])];
}

/**
 * Why a module's use of an interface cannot be served by the given modules, or undefined when the provider declares that
 * interface at that version with every operation the use names. Composition refuses required uses that have a reason.
 */
export function interfaceUseProblem(use: ModuleInterfaceUse, modules: readonly ModuleDefinition[]): string | undefined {
  const provider = modules.find((module) => module.interfaces?.some((item) => item.id === use.interface));
  const definition = provider?.interfaces?.find((item) => item.id === use.interface);
  if (!provider || !definition) return `no installed module provides ${use.interface}`;
  if (definition.version !== use.version) return `${provider.id} provides ${use.interface} version ${definition.version}, not ${use.version}`;
  const missing = use.operations.filter((operation) => !definition.operations.some((item) => item.id === operation));
  return missing.length ? `${provider.id} ${use.interface} version ${use.version} has no ${missing.join(", ")} operation${missing.length === 1 ? "" : "s"}` : undefined;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createModuleRegistry(input: readonly ModuleDefinition[]) {
  const modules = freeze(structuredClone(input)) as readonly ModuleDefinition[];
  const ids = new Set<string>();
  const capabilities = new Map<string, ModuleDefinition>();
  const discordCommands = new Map<string, ModuleDefinition>();
  const reportDatasets = new Map<string, ModuleDefinition>();
  const persistenceTables = new Map<string, ModuleDefinition>();
  const sharedPersistenceFields = new Map<string, ModuleDefinition>();
  const datasetDefinitions = new Map<string, ReportDatasetDefinition>();
  const reportFields = new Map<string, string>();
  const reportFilters = new Map<string, { readonly module: ModuleDefinition; readonly filter: ReportModuleFilterDefinition }>();
  const reportDefinitionKeys = new Set<string>(coreReportDefinitionKeys);
  const fieldAliases = new Map<string, string>();
  const walkthroughPages = new Set<string>();
  const interfaces = new Map<string, { readonly module: ModuleDefinition; readonly definition: ModuleInterfaceDefinition }>();
  const fieldSignature = (field: ReportFieldDefinition) => JSON.stringify({ label: field.label, group: field.group, kind: field.kind, valueType: field.valueType, sortable: field.sortable, filterOperators: [...field.filterOperators], requiresLabel: field.requiresLabel ?? false, durationUnits: field.durationUnits ? [...field.durationUnits] : [], defaultDurationUnit: field.defaultDurationUnit ?? null });
  const registerDatasetDefinition = (dataset: ReportDatasetDefinition) => {
    if (datasetDefinitions.has(dataset.id)) throw new Error("Invalid or duplicate report dataset contribution");
    for (const field of dataset.fields) {
      const signature = fieldSignature(field); const existing = reportFields.get(field.id);
      if (existing && existing !== signature) throw new Error("Conflicting shared report field contribution");
      reportFields.set(field.id, signature);
    }
    datasetDefinitions.set(dataset.id, dataset);
  };
  for (const dataset of coreReportDatasets) registerDatasetDefinition(dataset);
  for (const module of modules) {
    if (!moduleIdPattern.test(module.id) || ids.has(module.id) || !module.label || !module.description || !Number.isSafeInteger(module.contractVersion) || module.contractVersion < 1 || !Number.isSafeInteger(module.setup.version) || module.setup.version < 1) throw new Error("Invalid module definition");
    ids.add(module.id);
    if (new Set(module.dependencies).size !== module.dependencies.length || new Set(module.capabilities.map((capability) => capability.id)).size !== module.capabilities.length || new Set(module.setup.steps.map((step) => step.id)).size !== module.setup.steps.length || new Set(module.jobs.map((job) => job.id)).size !== module.jobs.length) throw new Error("Duplicate module declaration");
    if (!Number.isSafeInteger(module.backup.version) || module.backup.version < 1 || !module.lifecycle.cleanupTargets.length || new Set(module.lifecycle.cleanupTargets).size !== module.lifecycle.cleanupTargets.length) throw new Error("Invalid module persistence declaration");
    const tableName = /^[a-z][a-z0-9_]*$/;
    const columnName = /^[a-z][a-z0-9_]*$/;
    if (new Set(module.persistence.tables).size !== module.persistence.tables.length || module.persistence.tables.some((table) => !tableName.test(table) || persistenceTables.has(table))) throw new Error("Invalid or duplicate module persistence table");
    if (module.tablePrefix !== undefined && (typeof module.tablePrefix !== "string" || !tablePrefixPattern.test(module.tablePrefix) || module.persistence.tables.some((table) => !table.startsWith(module.tablePrefix!)))) throw new Error("Invalid module table prefix");
    const classifiedTables = [...module.backup.tables, ...(module.backup.nonPortableTables ?? [])];
    if (new Set(classifiedTables).size !== classifiedTables.length || classifiedTables.length !== module.persistence.tables.length || classifiedTables.some((table) => !module.persistence.tables.includes(table)) || module.backup.nonPortableTables?.some((table) => !module.lifecycle.cleanupTargets.includes(table))) throw new Error("Invalid module backup ownership");
    for (const fieldSet of [...module.persistence.sharedFields, ...module.persistence.transientAuthority]) {
      if (!tableName.test(fieldSet.table) || !fieldSet.columns.length || new Set(fieldSet.columns).size !== fieldSet.columns.length || fieldSet.columns.some((column) => !columnName.test(column))) throw new Error("Invalid module persistence field ownership");
    }
    for (const fieldSet of module.persistence.transientAuthority) if (!module.persistence.tables.includes(fieldSet.table)) throw new Error("Transient authority must belong to a module table");
    for (const fieldSet of module.persistence.sharedFields) for (const column of fieldSet.columns) {
      const key = `${fieldSet.table}.${column}`; if (sharedPersistenceFields.has(key)) throw new Error("Duplicate shared persistence field ownership");
      sharedPersistenceFields.set(key, module);
    }
    for (const table of module.persistence.tables) persistenceTables.set(table, module);
    if (module.setup.steps.some((step) => !moduleIdPattern.test(step.id) || !step.label || typeof step.required !== "boolean")) throw new Error("Invalid module setup step");
    if (module.jobs.some((job) => !capabilityPattern.test(job.id) || !job.id.startsWith(`${module.id}.`) || !Number.isSafeInteger(job.interval) || job.interval < 300_000 || job.label !== undefined && (typeof job.label !== "string" || !job.label.trim() || job.label.length > 80))) throw new Error("Invalid module job");
    const namespaces = new Set((module.reportDatasets ?? []).map((dataset) => dataset.id.split(".")[0]!));
    const ownFilters = new Set<string>();
    for (const filter of module.reportFilters ?? []) {
      const namespace = /^([a-z][a-z0-9]*)[-.][a-z0-9]+(?:[-.][a-z0-9]+)*$/.exec(filter.id)?.[1];
      if (!namespace || !namespaces.has(namespace) || (coreReportFilterIds as readonly string[]).includes(filter.id) || reportFilters.has(filter.id) || filter.kind !== "option-set") throw new Error("Invalid or duplicate report filter contribution");
      if ([filter.label, filter.optionLabel, filter.optionNoun].some((text) => typeof text !== "string" || !text.trim() || text.length > 60)) throw new Error("Invalid report filter labels");
      for (const key of [filter.selectionKey, filter.matchKey]) if (typeof key !== "string" || !/^[a-z][A-Za-z0-9]{0,47}$/.test(key) || reportDefinitionKeys.has(key)) throw new Error("Invalid or duplicate report filter definition key");
      if (filter.selectionKey === filter.matchKey) throw new Error("Invalid or duplicate report filter definition key");
      reportDefinitionKeys.add(filter.selectionKey); reportDefinitionKeys.add(filter.matchKey);
      reportFilters.set(filter.id, { module, filter }); ownFilters.add(filter.id);
    }
    for (const [pageId, walkthrough] of Object.entries(module.walkthroughs ?? {})) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(pageId) || walkthroughPages.has(pageId) || !Number.isSafeInteger(walkthrough.version) || walkthrough.version < 1 || !Array.isArray(walkthrough.steps) || !walkthrough.steps.length || new Set(walkthrough.steps).size !== walkthrough.steps.length || walkthrough.steps.some((step) => typeof step !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(step))) throw new Error("Invalid or duplicate module walkthrough");
      walkthroughPages.add(pageId);
    }
    if (new Set(module.discordCommands.map((command) => command.name)).size !== module.discordCommands.length) throw new Error("Duplicate module Discord command");
    for (const command of module.discordCommands) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(command.name) || !command.description || command.description.length > 100 || command.type !== 1 || discordCommands.has(command.name)) throw new Error("Invalid or duplicate Discord command contribution");
      const options = command.options ?? [];
      if (new Set(options.map((option) => option.name)).size !== options.length || options.some((option) => !/^[a-z][a-z0-9-]{0,31}$/.test(option.name) || !option.description || option.description.length > 100 || option.type !== 3)) throw new Error("Invalid Discord command option");
      discordCommands.set(command.name, module);
    }
    for (const dataset of module.reportDatasets ?? []) {
      const fields = new Map(dataset.fields.map((field) => [field.id, field]));
      if (!capabilityPattern.test(dataset.id) || !dataset.label || !dataset.description || !capabilityPattern.test(dataset.rowIdentity) || reportDatasets.has(dataset.id)) throw new Error("Invalid or duplicate report dataset contribution");
      if (!module.capabilities.some((capability) => capability.id === dataset.capability) || fields.size !== dataset.fields.length || !fields.has(dataset.rowIdentity)) throw new Error("Invalid report dataset authority or row identity");
      if (dataset.fields.some((field) => !capabilityPattern.test(field.id) || !field.label || !field.group || !["dimension", "measure"].includes(field.kind) || !["text", "number", "date"].includes(field.valueType) || field.filterOperators.some((operator) => !reportFilterOperators(field.valueType).includes(operator)) || field.durationUnits && (field.valueType !== "number" || !field.durationUnits.length || new Set(field.durationUnits).size !== field.durationUnits.length || field.durationUnits.some((unit) => !["minutes", "hours"].includes(unit)) || !field.defaultDurationUnit || !field.durationUnits.includes(field.defaultDurationUnit)) || !field.durationUnits && field.defaultDurationUnit)) throw new Error("Invalid report field contribution");
      if (!dataset.defaultColumns.length || dataset.defaultColumns.some((field) => !fields.has(field)) || new Set(dataset.defaultColumns).size !== dataset.defaultColumns.length || !fields.get(dataset.defaultSort.field)?.sortable) throw new Error("Invalid report dataset defaults");
      if (dataset.groupBy.some((field) => fields.get(field)?.kind !== "dimension") || new Set(dataset.groupBy).size !== dataset.groupBy.length || new Set(dataset.filters).size !== dataset.filters.length || dataset.filters.some((filter) => !(coreReportFilterIds as readonly string[]).includes(filter) && !ownFilters.has(filter))) throw new Error("Invalid report dataset grouping or filters");
      for (const [alias, field] of Object.entries(dataset.fieldAliases ?? {})) {
        if (!capabilityPattern.test(alias) || fields.has(alias) || !fields.has(field) || fieldAliases.has(alias) && fieldAliases.get(alias) !== field) throw new Error("Invalid report field alias");
        fieldAliases.set(alias, field);
      }
      if (dataset.relationships.some((relationship) => !capabilityPattern.test(relationship.dataset) || !fields.has(relationship.localField) || !capabilityPattern.test(relationship.foreignField))) throw new Error("Invalid report dataset relationship");
      registerDatasetDefinition(dataset);
      reportDatasets.set(dataset.id, module);
    }
    for (const capability of module.capabilities) {
      if (!capabilityPattern.test(capability.id) || !capability.label || capabilities.has(capability.id)) throw new Error("Invalid module capability");
      capabilities.set(capability.id, module);
    }
    for (const route of module.apiRoutes) {
      if ((route.match === "pattern" ? !route.path.startsWith("^") : !route.path.startsWith("/")) || !["exact", "prefix", "pattern"].includes(route.match) || !["workspace", "service", "setup"].includes(route.access)) throw new Error("Invalid module API route");
      if (route.match === "pattern") new RegExp(route.path);
    }
    if (module.interfaces !== undefined && !isList(module.interfaces)) throw new Error("Invalid module interface");
    for (const definition of module.interfaces ?? []) {
      // An interface is namespaced by its provider, and an operation requires one of the provider's own capabilities.
      if (!definition || typeof definition !== "object" || interfaceProviderId(definition.id) !== module.id || !interfaceVersion(definition.version) || !plainText(definition.label, 80) || !isList(definition.operations) || !definition.operations.length) throw new Error("Invalid module interface");
      if (interfaces.has(definition.id)) throw new Error("Duplicate module interface");
      if (new Set(definition.operations.map((operation) => operation?.id)).size !== definition.operations.length) throw new Error("Duplicate module interface operation");
      for (const operation of definition.operations) {
        if (!operation || typeof operation !== "object" || typeof operation.id !== "string" || operation.id.length > 40 || !operationIdPattern.test(operation.id) || !plainText(operation.label, 120) || typeof operation.grantable !== "boolean") throw new Error("Invalid module interface operation");
        if (!module.capabilities.some((capability) => capability.id === operation.capability)) throw new Error("Module interface operations require the provider's own capabilities");
      }
      interfaces.set(definition.id, { module, definition });
    }
    if (module.uses !== undefined && !isList(module.uses)) throw new Error("Invalid module interface use");
    for (const use of module.uses ?? []) {
      const provider = use && typeof use === "object" && typeof use.interface === "string" ? interfaceProviderId(use.interface) : undefined;
      if (!provider || !interfaceVersion(use.version) || !isList(use.operations) || !use.operations.length || new Set(use.operations).size !== use.operations.length || use.operations.some((operation) => typeof operation !== "string" || operation.length > 40 || !operationIdPattern.test(operation)) || typeof use.required !== "boolean" || !plainText(use.reason, 200)) throw new Error("Invalid module interface use");
      if (provider === module.id) throw new Error("A module cannot use its own interface");
    }
    if (new Set((module.uses ?? []).map((use) => `${use.interface}@${use.version}`)).size !== (module.uses ?? []).length) throw new Error("Duplicate module interface use");
  }
  for (const module of modules) if (module.dependencies.some((dependency) => !ids.has(dependency))) throw new Error("Unknown module dependency");
  // A prefix claims every name that starts with it, so no prefix may contain another or another module's declared table.
  for (const module of modules) {
    const prefix = module.tablePrefix; if (prefix === undefined) continue;
    for (const other of modules) if (other !== module && (other.tablePrefix !== undefined && (other.tablePrefix.startsWith(prefix) || prefix.startsWith(other.tablePrefix)) || other.persistence.tables.some((table) => table.startsWith(prefix)))) throw new Error("Overlapping module table prefix");
  }
  for (const alias of fieldAliases.keys()) if (reportFields.has(alias)) throw new Error("Invalid report field alias");
  for (const dataset of datasetDefinitions.values()) for (const relationship of dataset.relationships) {
    const target = datasetDefinitions.get(relationship.dataset);
    if (!target?.fields.some((field) => field.id === relationship.foreignField)) throw new Error("Report dataset relationship target is unavailable");
  }

  const get = (moduleId: string) => modules.find((module) => module.id === moduleId);
  const routeOwner = (pathname: string) => {
    for (const module of modules) for (const route of module.apiRoutes) {
      const matches = route.match === "exact" ? pathname === route.path : route.match === "prefix" ? pathname === route.path || pathname.startsWith(route.path + "/") : new RegExp(route.path).test(pathname);
      if (matches) return { module, route };
    }
    return undefined;
  };
  const validateSelection = (selected: readonly string[]) => {
    if (new Set(selected).size !== selected.length || selected.some((id) => !get(id)?.available)) throw new Error("Unknown or unavailable module");
    for (const id of selected) if (requiredModuleIds(get(id)!).some((dependency) => !selected.includes(dependency))) throw new Error("Missing module dependency");
    return [...selected];
  };
  return freeze({ modules, get, routeOwner, validateSelection, capabilityOwner: (capability: string) => capabilities.get(capability), discordCommandOwner: (name: string) => discordCommands.get(name), reportDatasetOwner: (datasetId: string) => reportDatasets.get(datasetId), tableOwner: (table: string) => persistenceTables.get(table),
    interfaceOwner: (interfaceId: string) => interfaces.get(interfaceId), requiredModules: (moduleId: string) => { const module = get(moduleId); return module ? requiredModuleIds(module) : []; },
    reportFilters: [...reportFilters.values()].map(({ filter }) => filter), reportFilterOwner: (filterId: string) => reportFilters.get(filterId)?.module, reportFieldAliases: Object.fromEntries(fieldAliases) as Readonly<Record<string, string>> });
}

export const coreMemberReportFields = Object.freeze<readonly ReportFieldDefinition[]>(coreMemberReportFieldDefinitions());

export const coreReportDatasets = Object.freeze<readonly ReportDatasetDefinition[]>([
  {
    id: "core.members", label: "Members", description: "Core roster identities and current label membership.", rowIdentity: "core.member.identity", capability: "core.roster",
    fields: coreMemberReportFields, filters: ["roster", "labels"], groupBy: ["core.member.identity"], defaultColumns: ["core.member.name", "core.member.id", "core.member.status", "core.member.labels"], defaultSort: { field: "core.member.name", direction: "asc" }, relationships: [],
  },
]);

const attendanceFields = Object.freeze<readonly ReportFieldDefinition[]>([
  ...coreMemberReportFields,
  { id: "attendance.member.required-from", label: "Attendance starts", group: "Attendance", kind: "dimension", valueType: "date", sortable: true, filterOperators: reportFilterOperators("date") },
  { id: "attendance.member.regular-rate", label: "Regular attendance", group: "Regular attendance", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "attendance.member.weighted-present", label: "Regular weighted present", group: "Regular attendance", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "attendance.member.weighted-eligible", label: "Regular weighted eligible", group: "Regular attendance", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
  { id: "attendance.member.regular-period", label: "Regular reporting period", group: "Regular attendance", kind: "dimension", valueType: "text", sortable: false, filterOperators: reportFilterOperators("text") },
  { id: "attendance.member.assigned-policies", label: "Assigned policies", group: "Policies", kind: "dimension", valueType: "text", sortable: false, filterOperators: reportFilterOperators("text") },
  ...["official-result", "official-status", "official-target", "official-type", "official-excused", "official-period", "report-result", "report-status", "report-target", "report-period"].map((id): ReportFieldDefinition => ({ id: `attendance.policy.${id}`, label: ({ "official-result": "Official policy result", "official-status": "Official policy status", "official-target": "Official policy target", "official-type": "Official policy type", "official-excused": "Official excuse handling", "official-period": "Official policy period", "report-result": "Report-period policy result", "report-status": "Report-period policy status", "report-target": "Report-period policy target", "report-period": "Report-period policy period" } as Record<string, string>)[id]!, group: "Policies", kind: id.includes("target") || id.includes("result") ? "measure" : "dimension", valueType: id.includes("target") || id.includes("result") ? "number" : "text", sortable: !id.includes("period"), filterOperators: reportFilterOperators(id.includes("target") || id.includes("result") ? "number" : "text"), requiresLabel: true })),
  { id: "attendance.policy.report-summary", label: "Report-period policies", group: "Policies", kind: "dimension", valueType: "text", sortable: false, filterOperators: reportFilterOperators("text") },
  { id: "attendance.policy.history", label: "Policy history", group: "Policies", kind: "dimension", valueType: "text", sortable: false, filterOperators: reportFilterOperators("text") },
  ...["present", "absent", "excused"].flatMap((status): ReportFieldDefinition[] => [
    { id: `attendance.detail.${status}-count`, label: `${status[0]!.toUpperCase()}${status.slice(1)} count`, group: "Attendance detail", kind: "measure", valueType: "number", sortable: true, filterOperators: reportFilterOperators("number") },
    { id: `attendance.detail.${status}-dates`, label: `${status[0]!.toUpperCase()}${status.slice(1)} dates`, group: "Attendance detail", kind: "dimension", valueType: "text", sortable: false, filterOperators: reportFilterOperators("text") },
  ]),
]);

export const attendanceModule = freeze<ModuleDefinition>({
  id: "attendance",
  label: "Attendance",
  description: "Meetings, check-ins, corrections, attendance calculations, kiosks, and attendance delivery workflows.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "attendance.manage", label: "Manage Attendance", operator: true }],
  navigation: [{ label: "Meetings", path: "/dashboard" }, { label: "Kiosks", path: "/kiosks" }],
  settings: [{ label: "Attendance", path: "/settings/attendance" }],
  setup: {
    version: 2,
    steps: [
      { id: "rules", label: "Attendance rules", required: true },
      { id: "meeting", label: "First meeting", required: true },
      { id: "input", label: "Verified attendance input", required: true },
      { id: "calendar", label: "Calendar integration", required: false },
      { id: "discord", label: "Discord integration", required: false },
    ],
  },
  jobs: [
    { id: "attendance.google-calendar", interval: 300_000 },
    { id: "attendance.discord-calendar", interval: 300_000 },
    { id: "attendance.discord-channel", interval: 300_000 },
    { id: "attendance.discord-notices", interval: 300_000 },
    { id: "attendance.discord-anomalies", interval: 300_000 },
    { id: "attendance.discord-label-roles", interval: 300_000 },
  ],
  discordCommands: [],
  reportDatasets: [{
    id: "attendance.members", label: "Members - Attendance", description: "Member-level Attendance measures with Community roster fields.", rowIdentity: "core.member.identity", capability: "attendance.manage",
    fields: attendanceFields, filters: ["period", "roster", "meeting-type", "labels", "membership"], groupBy: ["core.member.identity"], defaultColumns: ["core.member.name", "attendance.member.regular-rate", "attendance.member.assigned-policies"], defaultSort: { field: "core.member.name", direction: "asc" }, relationships: [{ dataset: "core.members", localField: "core.member.identity", foreignField: "core.member.identity" }],
  }],
  apiRoutes: [
    { path: "/module-setup/attendance", match: "prefix", access: "setup" },
    { path: "/meeting-weight-categories", match: "prefix", access: "workspace" },
    { path: "/admin/meeting-weight-categories", match: "prefix", access: "workspace" },
    { path: "/meetings", match: "prefix", access: "workspace" },
    { path: "/meeting-series", match: "prefix", access: "workspace" },
    { path: "/meeting-templates", match: "prefix", access: "workspace" },
    { path: "/attendance", match: "prefix", access: "workspace" },
    { path: "/labels/targets", match: "prefix", access: "workspace" },
    { path: "/reports/attendance", match: "exact", access: "workspace" },
    { path: "/reports/leaderboard", match: "exact", access: "workspace" },
    { path: "/exports/report-detail.csv", match: "exact", access: "workspace" },
    { path: "/exports/attendance.csv", match: "exact", access: "workspace" },
    { path: "^/admin/members/[^/]+/history$", match: "pattern", access: "workspace" },
    { path: "/admin/attendance/members", match: "prefix", access: "workspace" },
    { path: "/admin/pairing-codes", match: "prefix", access: "workspace" },
    { path: "/admin/kiosks", match: "prefix", access: "workspace" },
    { path: "/admin/simulator", match: "prefix", access: "workspace" },
    { path: "/communications/email", match: "exact", access: "workspace" },
    { path: "/calendars/sync", match: "exact", access: "workspace" },
    // Google returns the browser here cross-site, without the SameSite=Strict session cookie. The handler authenticates
    // the Admin through its signed, purpose-bound state instead, so this one path is a service route.
    { path: "/admin/integrations/google-calendar/callback", match: "exact", access: "service" },
    { path: "^/admin/integrations/(google-calendar|discord/(calendar|channel-manager|anomaly-reports|label-roles|label-role-jobs))", match: "pattern", access: "workspace" },
    { path: "/discord/contests", match: "prefix", access: "workspace" },
    { path: "/discord/calendar", match: "exact", access: "workspace" },
    { path: "/discord/kiosk-status", match: "exact", access: "workspace" },
    { path: "/discord/missing", match: "exact", access: "workspace" },
    { path: "/kiosk", match: "prefix", access: "service" },
  ],
  persistence: {
    tables: [
      "label_weekly_targets", "label_attendance_rules", "meeting_weight_categories", "meetings", "meeting_audience_labels", "meeting_templates",
      "kiosk_scan_reviews", "kiosk_enrollment_sessions",
      "attendance_events", "attendance_corrections", "pairing_codes", "kiosks", "simulated_kiosk_sessions",
      "kiosk_fingerprint_sync", "kiosk_fingerprint_keys", "kiosk_fingerprint_deliveries",
      "kiosk_fingerprint_vault_settings", "kiosk_fingerprint_vault_templates", "kiosk_fingerprint_vault_enrollments", "kiosk_fingerprint_vault_retirements",
      "kiosk_fingerprint_review_requests", "kiosk_fingerprint_review_manifests", "kiosk_fingerprint_review_slots", "kiosk_fingerprint_reset_batches", "kiosk_fingerprint_reset_commands",
      "kiosk_fingerprint_retired_review_grants",
      "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations",
      "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports",
    ],
    sharedFields: [
      { table: "members", columns: ["attendance_required_from"] },
      { table: "organization_settings", columns: ["late_scan_minutes", "discord_contest_window_hours", "discord_block_recontests_after_rejection", "discord_channel_manager_enabled", "attendance_reporting_starts_on", "anomaly_late_threshold_minutes", "anomaly_early_threshold_minutes", "discord_anomaly_reports_enabled", "discord_anomaly_report_channel_id", "discord_anomaly_reports_enabled_at", "attendance_recent_days", "attendance_policy_activated_on", "kiosk_authentication_method"] },
    ],
    transientAuthority: [
      { table: "kiosk_enrollment_sessions", columns: ["state", "expires_at"] },
      { table: "pairing_codes", columns: ["code_hash", "expires_at", "redeemed_at"] },
      { table: "kiosk_fingerprint_sync", columns: ["enabled", "sync_id"] },
      { table: "kiosk_fingerprint_keys", columns: ["pairing_id", "key_id"] },
      { table: "kiosk_fingerprint_deliveries", columns: ["status", "expires_at"] },
      { table: "kiosk_fingerprint_vault_settings", columns: ["enabled", "vault_id", "key_id"] },
      { table: "kiosk_fingerprint_review_slots", columns: ["status", "grant_id"] },
      { table: "kiosk_fingerprint_reset_commands", columns: ["acknowledged_at"] },
      { table: "kiosks", columns: ["token_hash", "active"] },
      { table: "google_calendar_operations", columns: ["status", "next_attempt_at"] },
      { table: "discord_calendar_operations", columns: ["status", "next_attempt_at", "lease_token", "lease_expires_at"] },
      { table: "discord_attendance_notifications", columns: ["status", "processed_at"] },
      { table: "discord_anomaly_reports", columns: ["status", "processed_at"] },
    ],
  },
  backup: {
    version: 2,
    nonPortableTables: ["kiosk_scan_reviews", "kiosk_enrollment_sessions", "kiosk_fingerprint_sync", "kiosk_fingerprint_keys", "kiosk_fingerprint_deliveries", "kiosk_fingerprint_vault_settings", "kiosk_fingerprint_vault_templates", "kiosk_fingerprint_vault_enrollments", "kiosk_fingerprint_vault_retirements", "kiosk_fingerprint_review_requests", "kiosk_fingerprint_review_manifests", "kiosk_fingerprint_review_slots", "kiosk_fingerprint_reset_batches", "kiosk_fingerprint_reset_commands", "kiosk_fingerprint_retired_review_grants"],
    tables: [
      "label_weekly_targets", "label_attendance_rules", "meeting_weight_categories", "meetings", "meeting_audience_labels", "meeting_templates",
      "attendance_events", "attendance_corrections", "pairing_codes", "kiosks", "simulated_kiosk_sessions",
      "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations",
      "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports",
    ],
  },
  lifecycle: {
    cleanupTargets: [
      "kiosk_scan_reviews", "kiosk_enrollment_sessions", "kiosk_commands", "simulated_kiosk_sessions", "kiosks", "pairing_codes", "discord_attendance_recipients", "discord_attendance_contests",
      "discord_attendance_notifications", "discord_anomaly_reports", "discord_calendar_operations", "discord_calendar_event_mappings",
      "google_calendar_operations", "google_calendar_event_mappings", "attendance_corrections", "attendance_events", "meeting_audience_labels",
      "meetings", "meeting_templates", "label_attendance_rules", "meeting_weight_categories", "integration_deliveries:attendance",
      "platform_module_setup_progress:attendance", "setup_progress:attendance", "platform_module_assignments:attendance",
      "members.attendance_required_from", "organization_settings:attendance", "label_weekly_targets",
      "kiosk_fingerprint_deliveries", "kiosk_fingerprint_keys", "kiosk_fingerprint_sync",
      "kiosk_fingerprint_vault_enrollments", "kiosk_fingerprint_vault_retirements", "kiosk_fingerprint_vault_templates", "kiosk_fingerprint_vault_settings",
      "kiosk_fingerprint_review_slots", "kiosk_fingerprint_review_manifests", "kiosk_fingerprint_review_requests", "kiosk_fingerprint_reset_commands", "kiosk_fingerprint_reset_batches",
      "kiosk_fingerprint_retired_review_grants",
    ],
  },
  deletedData: [
    "Meetings and meeting templates",
    "Attendance events and corrections",
    "Kiosk, simulator, and pairing records",
    "Attendance policy and delivery records",
  ],
});

/** Modules maintained in this repository. Core backup ownership and historical normalization consider only these. */
export const firstPartyModules = Object.freeze<readonly ModuleDefinition[]>([attendanceModule]);
export const bundledModuleRegistry = createModuleRegistry([...firstPartyModules, ...externalModuleManifests]);

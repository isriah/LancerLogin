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

export type ReportDurationUnit = "minutes" | "hours";

export type ReportFieldDefinition = {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly kind: "dimension" | "measure";
  readonly valueType: "text" | "number" | "date";
  readonly sortable: boolean;
  readonly filterOperators: readonly ("contains" | "minimum")[];
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
  readonly filters: readonly ("period" | "roster" | "meeting-type" | "labels" | "membership" | "outreach-labels")[];
  readonly groupBy: readonly string[];
  readonly defaultColumns: readonly string[];
  readonly defaultSort: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly relationships: readonly { readonly dataset: string; readonly localField: string; readonly foreignField: string }[];
};

export type ModuleDefinition = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly contractVersion: number;
  readonly available: boolean;
  readonly dependencies: readonly string[];
  readonly capabilities: readonly ModuleCapabilityDefinition[];
  readonly navigation: readonly { readonly label: string; readonly path: string }[];
  readonly settings: readonly { readonly label: string; readonly path: string }[];
  readonly setup: {
    readonly version: number;
    readonly steps: readonly { readonly id: string; readonly label: string; readonly required: boolean }[];
  };
  readonly jobs: readonly { readonly id: string; readonly interval: number }[];
  readonly discordCommands: readonly ModuleDiscordCommandDefinition[];
  readonly reportDatasets?: readonly ReportDatasetDefinition[];
  readonly apiRoutes: readonly ModuleApiRouteDefinition[];
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
};

export type ModulePlatformSnapshot = {
  readonly revision: number;
  readonly selectionCompleted: boolean;
  readonly capabilities: readonly string[];
  readonly modules: readonly ModuleSnapshotItem[];
};

const moduleIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const capabilityPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

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
    if (module.jobs.some((job) => !capabilityPattern.test(job.id) || !job.id.startsWith(`${module.id}.`) || !Number.isSafeInteger(job.interval) || job.interval < 300_000)) throw new Error("Invalid module job");
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
      if (dataset.fields.some((field) => !capabilityPattern.test(field.id) || !field.label || !field.group || !["dimension", "measure"].includes(field.kind) || !["text", "number", "date"].includes(field.valueType) || field.filterOperators.some((operator) => operator !== (field.valueType === "number" ? "minimum" : "contains")) || field.durationUnits && (field.valueType !== "number" || !field.durationUnits.length || new Set(field.durationUnits).size !== field.durationUnits.length || field.durationUnits.some((unit) => !["minutes", "hours"].includes(unit)) || !field.defaultDurationUnit || !field.durationUnits.includes(field.defaultDurationUnit)) || !field.durationUnits && field.defaultDurationUnit)) throw new Error("Invalid report field contribution");
      if (!dataset.defaultColumns.length || dataset.defaultColumns.some((field) => !fields.has(field)) || new Set(dataset.defaultColumns).size !== dataset.defaultColumns.length || !fields.get(dataset.defaultSort.field)?.sortable) throw new Error("Invalid report dataset defaults");
      if (dataset.groupBy.some((field) => fields.get(field)?.kind !== "dimension") || new Set(dataset.groupBy).size !== dataset.groupBy.length || new Set(dataset.filters).size !== dataset.filters.length) throw new Error("Invalid report dataset grouping or filters");
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
  }
  for (const module of modules) if (module.dependencies.some((dependency) => !ids.has(dependency))) throw new Error("Unknown module dependency");
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
    for (const id of selected) if (get(id)!.dependencies.some((dependency) => !selected.includes(dependency))) throw new Error("Missing module dependency");
    return [...selected];
  };
  return freeze({ modules, get, routeOwner, validateSelection, capabilityOwner: (capability: string) => capabilities.get(capability), discordCommandOwner: (name: string) => discordCommands.get(name), reportDatasetOwner: (datasetId: string) => reportDatasets.get(datasetId), tableOwner: (table: string) => persistenceTables.get(table) });
}

const memberFields = Object.freeze<readonly ReportFieldDefinition[]>([
  { id: "core.member.identity", label: "Member record ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "core.member.name", label: "Member", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "core.member.id", label: "Member ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "core.member.email", label: "Email", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "core.member.discord-id", label: "Discord ID", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "core.member.status", label: "Roster status", group: "Roster", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "core.member.labels", label: "Current labels", group: "Roster", kind: "dimension", valueType: "text", sortable: false, filterOperators: ["contains"] },
]);

export const coreReportDatasets = Object.freeze<readonly ReportDatasetDefinition[]>([
  {
    id: "core.members", label: "Members", description: "Core roster identities and current label membership.", rowIdentity: "core.member.identity", capability: "core.roster",
    fields: memberFields, filters: ["roster", "labels"], groupBy: ["core.member.identity"], defaultColumns: ["core.member.name", "core.member.id", "core.member.status", "core.member.labels"], defaultSort: { field: "core.member.name", direction: "asc" }, relationships: [],
  },
]);

const attendanceFields = Object.freeze<readonly ReportFieldDefinition[]>([
  ...memberFields,
  { id: "attendance.member.required-from", label: "Attendance starts", group: "Attendance", kind: "dimension", valueType: "date", sortable: true, filterOperators: ["contains"] },
  { id: "attendance.member.regular-rate", label: "Regular attendance", group: "Regular attendance", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "attendance.member.weighted-present", label: "Regular weighted present", group: "Regular attendance", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "attendance.member.weighted-eligible", label: "Regular weighted eligible", group: "Regular attendance", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "attendance.member.regular-period", label: "Regular reporting period", group: "Regular attendance", kind: "dimension", valueType: "text", sortable: false, filterOperators: ["contains"] },
  { id: "attendance.member.assigned-policies", label: "Assigned policies", group: "Policies", kind: "dimension", valueType: "text", sortable: false, filterOperators: ["contains"] },
  ...["official-result", "official-status", "official-target", "official-type", "official-excused", "official-period", "report-result", "report-status", "report-target", "report-period"].map((id): ReportFieldDefinition => ({ id: `attendance.policy.${id}`, label: ({ "official-result": "Official policy result", "official-status": "Official policy status", "official-target": "Official policy target", "official-type": "Official policy type", "official-excused": "Official excuse handling", "official-period": "Official policy period", "report-result": "Report-period policy result", "report-status": "Report-period policy status", "report-target": "Report-period policy target", "report-period": "Report-period policy period" } as Record<string, string>)[id]!, group: "Policies", kind: id.includes("target") || id.includes("result") ? "measure" : "dimension", valueType: id.includes("target") || id.includes("result") ? "number" : "text", sortable: !id.includes("period"), filterOperators: id.includes("target") || id.includes("result") ? ["minimum"] : ["contains"], requiresLabel: true })),
  { id: "attendance.policy.report-summary", label: "Report-period policies", group: "Policies", kind: "dimension", valueType: "text", sortable: false, filterOperators: ["contains"] },
  { id: "attendance.policy.history", label: "Policy history", group: "Policies", kind: "dimension", valueType: "text", sortable: false, filterOperators: ["contains"] },
  ...["present", "absent", "excused"].flatMap((status): ReportFieldDefinition[] => [
    { id: `attendance.detail.${status}-count`, label: `${status[0]!.toUpperCase()}${status.slice(1)} count`, group: "Attendance detail", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
    { id: `attendance.detail.${status}-dates`, label: `${status[0]!.toUpperCase()}${status.slice(1)} dates`, group: "Attendance detail", kind: "dimension", valueType: "text", sortable: false, filterOperators: ["contains"] },
  ]),
]);

const outreachMemberFields = Object.freeze<readonly ReportFieldDefinition[]>([
  ...memberFields,
  { id: "outreach.member.minutes", label: "Outreach minutes", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"], durationUnits: ["minutes", "hours"], defaultDurationUnit: "hours" },
  { id: "outreach.member.entries", label: "Participation entries", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.member.activities", label: "Distinct activities", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.member.supported-teams", label: "Supported teams", group: "Outreach participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.member.last-service-date", label: "Last participation date", group: "Outreach participation", kind: "dimension", valueType: "date", sortable: true, filterOperators: ["contains"] },
]);

const outreachActivityFields = Object.freeze<readonly ReportFieldDefinition[]>([
  { id: "outreach.activity.id", label: "Activity record ID", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.activity.title", label: "Activity", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.activity.date", label: "Service date", group: "Activity", kind: "dimension", valueType: "date", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.activity.labels", label: "Outreach labels", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.activity.mode", label: "Activity type", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.activity.team-id", label: "Supported team record ID", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.activity.team", label: "Supported team", group: "Activity", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.activity.participants", label: "Distinct participants", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.activity.entries", label: "Entries", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.activity.minutes", label: "Minutes", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"], durationUnits: ["minutes", "hours"], defaultDurationUnit: "minutes" },
]);

const outreachEntryFields = Object.freeze<readonly ReportFieldDefinition[]>([
  { id: "outreach.entry.id", label: "Entry record ID", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.member", label: "Member", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.activity-id", label: "Activity record ID", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.activity", label: "Activity", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.labels", label: "Outreach labels", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.date", label: "Service date", group: "Entry", kind: "dimension", valueType: "date", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.start", label: "Start", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.end", label: "End", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.minutes", label: "Minutes", group: "Entry", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"], durationUnits: ["minutes", "hours"], defaultDurationUnit: "minutes" },
  { id: "outreach.entry.channel", label: "Submission channel", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.entry.status", label: "Status", group: "Entry", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
]);

const outreachTeamFields = Object.freeze<readonly ReportFieldDefinition[]>([
  { id: "outreach.team.id", label: "Team record ID", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.team.name", label: "Supported team", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.team.number", label: "Team number", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.team.program", label: "Program", group: "Team", kind: "dimension", valueType: "text", sortable: true, filterOperators: ["contains"] },
  { id: "outreach.team.participants", label: "Distinct participants", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.team.activities", label: "Activities", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.team.entries", label: "Entries", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"] },
  { id: "outreach.team.minutes", label: "Minutes", group: "Participation", kind: "measure", valueType: "number", sortable: true, filterOperators: ["minimum"], durationUnits: ["minutes", "hours"], defaultDurationUnit: "minutes" },
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
      { table: "organization_settings", columns: ["late_scan_minutes", "discord_contest_window_hours", "discord_channel_manager_enabled", "attendance_reporting_starts_on", "anomaly_late_threshold_minutes", "anomaly_early_threshold_minutes", "discord_anomaly_reports_enabled", "discord_anomaly_report_channel_id", "discord_anomaly_reports_enabled_at", "attendance_recent_days", "attendance_policy_activated_on", "kiosk_authentication_method"] },
    ],
    transientAuthority: [
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
    nonPortableTables: ["kiosk_fingerprint_sync", "kiosk_fingerprint_keys", "kiosk_fingerprint_deliveries", "kiosk_fingerprint_vault_settings", "kiosk_fingerprint_vault_templates", "kiosk_fingerprint_vault_enrollments", "kiosk_fingerprint_vault_retirements", "kiosk_fingerprint_review_requests", "kiosk_fingerprint_review_manifests", "kiosk_fingerprint_review_slots", "kiosk_fingerprint_reset_batches", "kiosk_fingerprint_reset_commands", "kiosk_fingerprint_retired_review_grants"],
    tables: [
      "label_weekly_targets", "label_attendance_rules", "meeting_weight_categories", "meetings", "meeting_audience_labels", "meeting_templates",
      "attendance_events", "attendance_corrections", "pairing_codes", "kiosks", "simulated_kiosk_sessions",
      "google_calendar_event_mappings", "google_calendar_operations", "discord_calendar_event_mappings", "discord_calendar_operations",
      "discord_attendance_notifications", "discord_attendance_recipients", "discord_attendance_contests", "discord_anomaly_reports",
    ],
  },
  lifecycle: {
    cleanupTargets: [
      "kiosk_commands", "simulated_kiosk_sessions", "kiosks", "pairing_codes", "discord_attendance_recipients", "discord_attendance_contests",
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

export const outreachModule = freeze<ModuleDefinition>({
  id: "hour-tracking",
  label: "Outreach Participation",
  description: "Outreach labels, supported teams, dated activities, member submissions, staff exceptions, and participation totals.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "hours.manage", label: "Manage Outreach Participation", operator: true }],
  navigation: [{ label: "Outreach", path: "/hours" }],
  settings: [{ label: "Outreach", path: "/settings/outreach-setup" }],
  setup: {
    version: 1,
    steps: [
      { id: "rules", label: "Entry rules", required: true },
      { id: "catalog", label: "Labels and supported teams", required: true },
    ],
  },
  jobs: [{ id: "hour-tracking.publication", interval: 300_000 }],
  discordCommands: [
    { name: "outreach-submit", type: 1, description: "Record completed Outreach participation for your linked member", options: [
      { name: "activity", description: "Dated Outreach activity reference or exact title", type: 3, required: true },
      { name: "start", description: "Local start time in HH:MM format", type: 3, required: true },
      { name: "end", description: "Local end time in HH:MM format", type: 3, required: true },
      { name: "notes", description: "Private task notes for Staff", type: 3 },
    ] },
    { name: "outreach-correction", type: 1, description: "Ask Staff to review linked Outreach participation", options: [
      { name: "message", description: "What Staff should review", type: 3, required: true },
      { name: "receipt", description: "Participation receipt reference", type: 3 },
      { name: "date", description: "Service date in YYYY-MM-DD format", type: 3 },
    ] },
  ],
  reportDatasets: [
    { id: "outreach.members", label: "Members - Outreach", description: "Member-level Outreach participation totals.", rowIdentity: "core.member.identity", capability: "hours.manage", fields: outreachMemberFields, filters: ["period", "roster", "labels", "outreach-labels"], groupBy: ["core.member.identity"], defaultColumns: ["core.member.name", "outreach.member.minutes", "outreach.member.entries", "outreach.member.activities"], defaultSort: { field: "core.member.name", direction: "asc" }, relationships: [{ dataset: "core.members", localField: "core.member.identity", foreignField: "core.member.identity" }] },
    { id: "outreach.activities", label: "Outreach activities", description: "Dated Outreach activities with participation totals.", rowIdentity: "outreach.activity.id", capability: "hours.manage", fields: outreachActivityFields, filters: ["period", "outreach-labels"], groupBy: ["outreach.activity.id", "outreach.activity.title", "outreach.activity.date", "outreach.activity.labels", "outreach.activity.mode", "outreach.activity.team"], defaultColumns: ["outreach.activity.title", "outreach.activity.date", "outreach.activity.labels", "outreach.activity.participants", "outreach.activity.minutes"], defaultSort: { field: "outreach.activity.date", direction: "desc" }, relationships: [{ dataset: "outreach.entries", localField: "outreach.activity.id", foreignField: "outreach.entry.activity-id" }] },
    { id: "outreach.entries", label: "Outreach entries", description: "Individual Outreach participation entries.", rowIdentity: "outreach.entry.id", capability: "hours.manage", fields: outreachEntryFields, filters: ["period", "outreach-labels"], groupBy: ["outreach.entry.id", "outreach.entry.member", "outreach.entry.activity", "outreach.entry.date", "outreach.entry.channel", "outreach.entry.status"], defaultColumns: ["outreach.entry.member", "outreach.entry.activity", "outreach.entry.date", "outreach.entry.minutes", "outreach.entry.channel"], defaultSort: { field: "outreach.entry.date", direction: "desc" }, relationships: [{ dataset: "outreach.activities", localField: "outreach.entry.activity-id", foreignField: "outreach.activity.id" }] },
    { id: "outreach.teams", label: "Supported teams", description: "Supported-team participation totals from designated team-support activities.", rowIdentity: "outreach.team.id", capability: "hours.manage", fields: outreachTeamFields, filters: ["period", "outreach-labels"], groupBy: ["outreach.team.id", "outreach.team.name", "outreach.team.number", "outreach.team.program"], defaultColumns: ["outreach.team.name", "outreach.team.number", "outreach.team.program", "outreach.team.participants", "outreach.team.minutes"], defaultSort: { field: "outreach.team.name", direction: "asc" }, relationships: [{ dataset: "outreach.activities", localField: "outreach.team.id", foreignField: "outreach.activity.team-id" }] },
  ],
  apiRoutes: [
    { path: "/module-setup/hour-tracking", match: "prefix", access: "setup" },
    { path: "/admin/hours", match: "prefix", access: "workspace" },
    { path: "/public/hours", match: "prefix", access: "service" },
  ],
  persistence: {
    tables: [
      "hours_categories", "hours_labels", "hours_teams", "hours_activities", "hours_activity_labels", "hours_entry_settings", "hours_entries", "hours_entry_revisions",
      "hours_submission_keys", "hours_reopen_windows", "hours_correction_requests", "hours_correction_resolutions",
      "hours_publication_settings", "hours_activity_publications", "hours_publication_operations",
      "hours_public_form_settings", "hours_public_lookup_limits",
    ],
    sharedFields: [],
    transientAuthority: [
      { table: "hours_publication_operations", columns: ["status", "next_attempt_at", "lease_token", "lease_expires_at"] },
    ],
  },
  backup: {
    version: 2,
    tables: [
      "hours_categories", "hours_labels", "hours_teams", "hours_activities", "hours_activity_labels", "hours_entry_settings", "hours_entries", "hours_entry_revisions",
      "hours_submission_keys", "hours_reopen_windows", "hours_correction_requests", "hours_correction_resolutions",
      "hours_publication_settings", "hours_activity_publications", "hours_publication_operations",
      "hours_public_form_settings",
    ],
    nonPortableTables: ["hours_public_lookup_limits"],
  },
  lifecycle: {
    cleanupTargets: [
      "hours_publication_operations", "hours_activity_publications", "hours_correction_resolutions", "hours_correction_requests",
      "hours_reopen_windows", "hours_submission_keys", "hours_entry_revisions", "hours_entries", "hours_activities", "hours_teams",
      "hours_categories", "hours_publication_settings", "hours_entry_settings", "platform_module_setup_progress:hour-tracking", "platform_module_assignments:hour-tracking", "hours_activity_labels", "hours_labels",
      "hours_public_form_settings", "hours_public_lookup_limits",
    ],
  },
  deletedData: [
    "Outreach labels, supported teams, and activities",
    "Member submissions, staff exceptions, integer-minute totals, and immutable entry history",
    "Outreach setup and assignment records",
  ],
});

export const carpoolModule = freeze<ModuleDefinition>({
  id: "carpool",
  label: "Carpool",
  description: "Independent outbound and return ride planning with optional roster and event references.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "carpool.manage", label: "Manage Carpool", operator: true }],
  navigation: [{ label: "Carpool", path: "/carpool" }],
  settings: [{ label: "Carpool", path: "/settings/carpool" }],
  setup: { version: 1, steps: [{ id: "workspace", label: "First Carpool plan", required: true }] },
  jobs: [],
  discordCommands: [],
  reportDatasets: [],
  apiRoutes: [
    { path: "/module-setup/carpool", match: "prefix", access: "setup" },
    { path: "/admin/carpool", match: "prefix", access: "workspace" },
  ],
  persistence: {
    tables: ["carpool_settings", "carpool_geocoding_credentials", "carpool_location_resolution", "carpool_plans", "carpool_people", "carpool_assignments", "carpool_unresolved", "carpool_import_profiles", "carpool_location_cache"],
    sharedFields: [],
    transientAuthority: [],
  },
  backup: { version: 1, nonPortableTables: ["carpool_geocoding_credentials", "carpool_location_resolution"], tables: ["carpool_settings", "carpool_plans", "carpool_people", "carpool_assignments", "carpool_unresolved", "carpool_import_profiles", "carpool_location_cache"] },
  lifecycle: { cleanupTargets: ["carpool_geocoding_credentials", "carpool_location_resolution", "carpool_settings", "carpool_assignments", "carpool_unresolved", "carpool_people", "carpool_plans", "carpool_import_profiles", "carpool_location_cache", "platform_module_setup_progress:carpool", "platform_module_assignments:carpool"] },
  deletedData: ["Carpool plans and optional event snapshots", "Participants, locations, vehicles, assignments, imports, and unresolved ride reasons"],
});

export const bundledModuleRegistry = createModuleRegistry([attendanceModule, outreachModule, carpoolModule]);

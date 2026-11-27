import { moduleCredentials } from "../integration-crypto.ts";
import { firstDataService, firstVisitorKey, type FirstDataDeps } from "../first-data.ts";
import { notionService, type NotionDeps } from "../module-notion.ts";
import { evaluateAttendanceKept } from "../attendance-policy.ts";
import { buildReportRows, reportDatasetDefinition, reportFilterSourceDataset, reportLabelsMatch, reportModuleFilters, type NormalizedReportDefinition } from "../report-builder.ts";
import { createModuleReportDispatcher, type ReportProjectionContext } from "../module-reporting.ts";
import { type D1Database } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { DiscordRateLimitError } from "../discord-rate-limit.ts";
import { bundledModuleRegistry } from "../../../../packages/shared/src/module-platform.ts";
import { requireModuleWorkspace } from "../module-platform.ts";
import { captureModuleWorkspaceDatabase, isModuleAuthorityDenied } from "../module-database-scope.ts";
import { createApiModuleSet, type ApiModuleContribution, type CoreModuleServices, type ModuleRouteContext } from "../module-contributions.ts";
import { installedApiModules } from "../installed-api-modules.ts";
import { moduleInterfaceServices } from "../module-interfaces.ts";
import { attendanceApiModule } from "../attendance-api-module.ts";
import { externalModuleManifests } from "../../../../packages/shared/src/generated/external-manifests.ts";
import { extractedModules } from "../extracted-modules.ts";
import { DiscordResponseError, EmailProviderError, type Env, GoogleCalendarProviderError, type Principal, moduleScopedEnvironment, parseJson, principalFor, requireDatabase, requireProviderAuthority, requireRole, response } from "./core.ts";
import { deliveryPausedUntil, requireDeliveryRunning } from "./delivery.ts";
import { discordCalendarIsReady, processDiscordCalendarOperations } from "./discord-calendar.ts";
import { discordConfiguration, discordRequest } from "./discord-core.ts";
import { syncDiscordManagedSurface } from "./discord-kiosk-status.ts";
import { processDiscordLabelRoles } from "./discord-label-jobs.ts";
import { processDiscordAnomalyReports, processDiscordAttendanceNotifications } from "./discord-notifications.ts";
import { resendIsReady, sendModuleEmail } from "./email.ts";
import { googleCalendarAccessToken, googleCalendarIsReady, googleCalendarOperationPath, googleCalendarProviderRequest, processGoogleCalendarOperations } from "./google-calendar.ts";
import { policyData } from "./policy-data.ts";
import type { ReportAccess } from "./reports.ts";

export async function attendanceReportProjection(db: D1Database, definition: NormalizedReportDefinition, context: ReportProjectionContext) {
  const data = await policyData(db);
  const resolved = { from: context.from, to: context.to };
  const meetings = data.meetings.filter((meeting) => definition.meetingType === "all" || Boolean(meeting.required) === (definition.meetingType === "required"));
  const officialMembers = evaluateAttendanceKept(data, "official"); const columnLabelIds = definition.columns.flatMap((column) => column.labelId ? [column.labelId] : []); const summaryLabelIds = [...new Set([...definition.labelIds, ...columnLabelIds])];
  const historicalLabelIds = definition.membership === "historical" ? definition.labelIds : [];
  const periodMembers = evaluateAttendanceKept(data, JSON.stringify(["builder", definition.meetingType, resolved.from ?? null, resolved.to ?? null, definition.membership, historicalLabelIds, definition.labelMatch, summaryLabelIds]), (source) => ({ ...source, meetings, from: resolved.from, to: resolved.to, membership: definition.membership, historicalLabelIds, historicalLabelMatch: definition.labelMatch, summaryLabelIds }))
    .filter((item) => (definition.roster === "all" || Boolean(item.member.active)) && (definition.membership === "historical" ? !definition.labelIds.length || item.rows.length > 0 : reportLabelsMatch(item.currentLabelIds, definition.labelIds, definition.labelMatch)));
  const rows = buildReportRows({ definition, official: officialMembers, period: periodMembers, meetings, labels: data.labels, rules: data.rules, timeZone: data.timeZone, from: resolved.from, to: resolved.to });
  const matchingMemberIds = new Set(rows.map((row) => row.id));
  return { rows, periodMembers: periodMembers.filter((member) => matchingMemberIds.has(member.member.id)), officialMembers, meetings, labels: data.labels, rules: data.rules, timeZone: data.timeZone };
}

// Each registered job runs one small batch per scheduler slice (see platform-scheduler.ts), which on the Workers Free plan
// must fit 10 ms CPU, 50 external requests and 50 D1 queries. It leaves the rest queued in D1 and reports more work, so
// the scheduler runs it again within seconds; nothing expects one slice to drain a queue. A module job's provider call
// also costs one D1 check. While an Admin's Stop is active, every delivery path leaves its work queued.
/** Attendance delivery jobs and its report projection are implemented in the Worker, so they are bound here. */
export const attendanceRuntime = {
  jobs: {
    // Google Calendar delivery retries safely on the next scheduled pass.
    "attendance.google-calendar": ({ env }) => processGoogleCalendarOperations(env),
    "attendance.discord-calendar": ({ env }) => processDiscordCalendarOperations(env),
    "attendance.discord-channel": ({ env }) => syncDiscordManagedSurface(env),
    "attendance.discord-notices": ({ env }) => processDiscordAttendanceNotifications(env),
    "attendance.discord-anomalies": ({ env }) => processDiscordAnomalyReports(env),
    "attendance.discord-label-roles": ({ env }) => processDiscordLabelRoles(env),
  },
  reports: { "attendance.members": async (db, definition, context) => (await attendanceReportProjection(db, definition, context)).rows },
} satisfies Pick<ApiModuleContribution<Env>, "jobs" | "reports">;
export const apiModules = createApiModuleSet<Env>(bundledModuleRegistry, installedApiModules.map((module) => module === attendanceApiModule ? { ...module, ...attendanceRuntime } : module));
export const moduleReportDispatcher = createModuleReportDispatcher(bundledModuleRegistry, apiModules.all.flatMap((module) => module.reports ? [{ moduleId: module.moduleId, handlers: module.reports }] : []));

/**
 * The owning module's database for a report source, or undefined when the user can't open it. A generation the request's
 * access check already read is reused: the scoped database's guard rechecks it with every read, and a projection whose
 * guard finds access gone counts as unavailable (see projectModuleReport).
 */
export async function moduleReportDatabase(db: D1Database, principal: Principal, datasetId: string, access?: ReportAccess): Promise<D1Database | undefined> {
  const owner = moduleReportDispatcher.owner(datasetId); const dataset = reportDatasetDefinition(datasetId);
  if (!owner || !dataset) return;
  try {
    const generation = access?.generations?.get(owner.id) ?? await requireModuleWorkspace(db, principal.userId, owner.id);
    return captureModuleWorkspaceDatabase(db, owner.id, generation, principal.userId, dataset.capability);
  } catch (error) {
    if (error instanceof HttpError && [403, 409, 503].includes(error.status)) return;
    throw error;
  }
}

/** A projection's result, or undefined when the module's access ended after the request's check, as a fresh check would find. */
export async function projectModuleReport<T>(project: () => Promise<T>): Promise<T | undefined> {
  try { return await project(); }
  catch (error) { if (isModuleAuthorityDenied(error)) return undefined; throw error; }
}

/** Report sources that apply each module filter with a selection; a module's own projection applies its filter. */
export function activeModuleFilterSources(definition: NormalizedReportDefinition): (string | undefined)[] {
  return reportModuleFilters.filter((filter) => { const ids = definition[filter.selectionKey]; return Array.isArray(ids) && ids.length > 0; }).map((filter) => reportFilterSourceDataset(definition.dataset, filter.id));
}

/** Installed modules' roster references, and those of extracted modules whose plugins are absent but whose tables remain. */
export function moduleRosterReferences() {
  const installed = apiModules.all.flatMap((module) => module.rosterReferences ? [module.rosterReferences] : []);
  const retained = extractedModules.filter((module) => !bundledModuleRegistry.get(module.id)).flatMap((module) => module.rosterReferences ? [module.rosterReferences] : []);
  const references = [...installed, ...retained];
  return { labels: references.map((item) => item.label), columns: references.flatMap((item) => item.columns) };
}

export const firstDataDeps = (env: Env, db = requireDatabase(env)): FirstDataDeps => ({ db, fetch: (input, init) => { env.schedulerPass?.budget.chargeExternal(); return fetch(input, init); }, now: Date.now, credentials: moduleCredentials(env.INTEGRATION_KEY) });
/**
 * Core's Notion connection for the current environment. Inside a module scope `authority` counts each Notion request
 * against the scheduler budget and rechecks the module's authority (one D1 read), as Discord requests do. `fetch` is
 * called as a plain function: a stored `fetch` called as a method throws on Workers. Logs carry no IDs or content.
 */
export const notionDeps = (env: Env, db = requireDatabase(env)): NotionDeps => ({
  db, fetch: (input, init) => fetch(input, init), now: Date.now, credentials: moduleCredentials(env.INTEGRATION_KEY),
  authority: () => requireProviderAuthority(env), deliveryPausedUntil: () => deliveryPausedUntil(env),
  log: (entry) => console.log(JSON.stringify({ event: "notion_request", ...entry })),
});
/**
 * Whom a module's FIRST lookups count against: null for a signed-in user or a job, else the hashed address of the visitor
 * on a public route. A service route without a user still counts as staff when its request carries a valid session.
 */
async function firstVisitor(env: Env, caller: ModuleServiceCaller): Promise<string | null> {
  if (caller.userId || !caller.request) return null;
  try { await principalFor(caller.request, env); return null; } catch { return firstVisitorKey(caller.request.headers.get("cf-connecting-ip")); }
}
type ModuleServiceCaller = { readonly userId?: string; readonly nested?: boolean; readonly request?: Request };
/**
 * Shared provider access for module code, bound to the current (module-scoped) environment. `userId` is the signed-in user
 * of a workspace or setup request, whose own access can authorize interface calls; `nested` marks an interface handler.
 * `request` is the route's request, which tells `services.first` whether a public visitor is asking.
 */
export function coreModuleServices(env: Env, moduleId: string, caller: ModuleServiceCaller = {}): CoreModuleServices {
  return Object.freeze({
    googleCalendar: Object.freeze({
      ready: async () => await deliveryPausedUntil(env) === null && await googleCalendarIsReady(env),
      async access() { const { accessToken, secret } = await googleCalendarAccessToken(env, true); return { accessToken, calendarId: secret.calendarId ?? null }; },
      operationPath: googleCalendarOperationPath,
      request: async (accessToken: string, path: string, init: RequestInit) => { if ((init.method ?? "GET").toUpperCase() !== "GET") await requireDeliveryRunning(env); return (await googleCalendarProviderRequest(accessToken, path, init, env.moduleProviderAuthority)).body; },
      providerStatus: (error: unknown) => error instanceof GoogleCalendarProviderError ? error.providerStatus : undefined,
    }),
    discord: Object.freeze({
      ready: async () => await deliveryPausedUntil(env) === null && await discordCalendarIsReady(env),
      async client() { const config = await discordConfiguration(env); return { guildId: config.guildId, request: async <T,>(path: string, init: RequestInit) => { if ((init.method ?? "GET").toUpperCase() !== "GET") await requireDeliveryRunning(env); return discordRequest<T>(config, path, init, "requests"); } }; },
      providerStatus: (error: unknown) => error instanceof DiscordResponseError ? error.discordStatus : error instanceof DiscordRateLimitError ? 429 : undefined,
      retryAfterMs: (error: unknown) => error instanceof DiscordRateLimitError ? error.retryAfterMs : undefined,
    }),
    email: Object.freeze({
      ready: async () => await deliveryPausedUntil(env) === null && await resendIsReady(env),
      send: async (message: unknown) => { await requireDeliveryRunning(env); return sendModuleEmail(env, moduleId, message); },
      providerStatus: (error: unknown) => error instanceof EmailProviderError ? error.emailStatus : undefined,
    }),
    credentials: moduleCredentials(env.INTEGRATION_KEY),
    first: firstDataService(firstDataDeps(env), { moduleId, visitor: () => firstVisitor(env, caller) }),
    notion: notionService(notionDeps(env), { moduleId, definition: bundledModuleRegistry.get(moduleId) }),
    modules: moduleInterfaceServices({
      db: requireDatabase(env), consumerId: moduleId, userId: caller.userId, nested: caller.nested, handlers: (providerId) => apiModules.get(providerId)?.interfaces,
      providerServices: (db, providerId) => coreModuleServices(moduleScopedEnvironment(env, db), providerId, { nested: true, request: caller.userId ? undefined : caller.request }),
    }),
  });
}

const externalModuleIds = new Set(externalModuleManifests.map((module) => module.id));
/** External plugins receive Core services, never the Worker environment and its secrets. */
export function moduleEnvironment(moduleId: string, env: Env): Env {
  return externalModuleIds.has(moduleId) ? Object.freeze({}) as Env : env;
}

/** `userId`: the signed-in user of a workspace or setup route. Service routes act without one. */
export function moduleRouteContext(moduleId: string, request: Request, env: Env, url: URL, userId?: string): ModuleRouteContext<Env> {
  return {
    request, url, env: moduleEnvironment(moduleId, env), db: requireDatabase(env), services: coreModuleServices(env, moduleId, { userId, request }),
    requireRole: (roles) => requireRole(request, env, [...roles]),
    json: <T,>(maxBytes?: number) => parseJson<T>(request, maxBytes),
    body: async <T,>(maxBytes?: number) => request.method === "GET" ? undefined : parseJson<T>(request, maxBytes),
    respond: (body, status) => response(body, status),
    requireDashboardOrigin(message) { if (request.headers.get("origin") !== env.ALLOWED_ORIGIN) throw new HttpError(403, message); },
    dashboardOrigin: env.ALLOWED_ORIGIN || undefined,
  };
}

export function privateModuleResponse(pathname: string): boolean {
  const owner = bundledModuleRegistry.routeOwner(pathname);
  return Boolean(owner && apiModules.get(owner.module.id)?.privateResponseRoutes?.includes(owner.route.path));
}

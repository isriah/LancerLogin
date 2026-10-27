import type { ComponentType, ReactNode } from "react";
import type { ModuleDefinition, ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import type { WalkthroughExperienceDefinition } from "./page-walkthrough";

export type DashboardRole = "admin" | "operator";
export type DashboardNavigate = (path: string, replace?: boolean) => void;
/** Path parameters captured by a matched path pattern. */
export type DashboardPathParams = Readonly<Record<string, string>>;

/** Core-owned values handed to a module page. */
export type DashboardPageContext = {
  readonly role: DashboardRole;
  readonly navigate: DashboardNavigate;
  /** Decoded parameters captured by the matched path pattern. */
  readonly params: DashboardPathParams;
  /** Reopen this module's guided setup. Core opens it only for Admins. */
  readonly openSetup: () => void;
};

export type DashboardWorkspaceRoute = {
  /**
   * Path pattern: literal segments, `:name` for one non-empty segment, or a final `:name+` for the non-empty remainder.
   * Each route is a declared navigation path or nested beneath one.
   */
  readonly path: string;
  readonly render: (context: DashboardPageContext) => ReactNode;
  /** Use the wide workspace layout on this path, whether or not the module is ready. */
  readonly wide?: true;
};

export type DashboardSettingsPage = {
  /** A settings path declared by the module manifest. */
  readonly path: string;
  readonly render: (context: DashboardPageContext) => ReactNode;
  /** Settings pages are Admin-only unless Operators may also open them. */
  readonly operator?: true;
};

export type DashboardSetupProps = {
  readonly module: ModuleSnapshotItem;
  readonly navigate: (path: string) => void;
  readonly onReady: () => Promise<void> | void;
};

export type DashboardModuleWalkthrough = {
  /** One of the contribution's workspace route patterns. */
  readonly path: string;
  readonly definition: WalkthroughExperienceDefinition;
};

/**
 * A page anyone can open without signing in, such as a public submission form. Core renders it with the installation's
 * branding header, outside the signed-in dashboard, whenever the module's dashboard contribution is installed. The page
 * calls only the module's `service` routes, which enforce enablement and their own rules.
 */
export type DashboardPublicPage = {
  /** An exact single-segment path such as `/submit-hours`, outside Core's own pages and every module's navigation. */
  readonly path: string;
  /** Text of the skip link that moves focus to the page content. */
  readonly skipLinkLabel: string;
  readonly render: () => ReactNode;
};

/** Paths of Core's signed-in pages. Public pages may not use them. */
export const coreDashboardPaths = Object.freeze(["/", "/admin", "/attendance", "/dashboard", "/integrations", "/kiosks", "/meetings", "/reports", "/roster", "/settings", "/simulator", "/login", "/setup"]);

/** A meeting reference handed to slot contributions. Contributions load their own permission-scoped data. */
export type DashboardMeetingReference = { readonly id: string };

/**
 * Named slots owned by host pages. A data slot wraps a host region and runs each contribution's data hook once for it;
 * render slots place contributed UI inside the host. Contributions appear only while the host module and the
 * contributing module are both workspace-ready.
 */
export const dashboardSlots = {
  /** Attendance pages that list meetings (Dashboard calendar and table). Runs once per loaded meeting collection. */
  "attendance.meeting-collection": { host: "attendance", kind: "data" },
  /** The Attendance meeting workspace. `meeting` is undefined while it loads. */
  "attendance.meeting-workspace": { host: "attendance", kind: "data" },
  /** Inline after a meeting title in the Dashboard meeting calendar, inside `attendance.meeting-collection`. */
  "attendance.calendar-meeting-badge": { host: "attendance", kind: "inline" },
  /** Inline after a meeting title in the Dashboard meeting table, inside `attendance.meeting-collection`. */
  "attendance.meeting-directory-badge": { host: "attendance", kind: "inline" },
  /** Panel below the meeting heading in the meeting workspace, inside `attendance.meeting-workspace`. */
  "attendance.meeting-detail-panel": { host: "attendance", kind: "block" },
} as const satisfies Readonly<Record<string, { readonly host: string; readonly kind: "data" | "inline" | "block" }>>;

export type DashboardSlotProps = {
  "attendance.meeting-collection": { readonly meetings: readonly DashboardMeetingReference[] };
  "attendance.meeting-workspace": { readonly meeting: DashboardMeetingReference | undefined };
  "attendance.calendar-meeting-badge": { readonly meetingId: string };
  "attendance.meeting-directory-badge": { readonly meetingId: string };
  "attendance.meeting-detail-panel": { readonly meetingId: string; readonly navigate: (path: string) => void };
};
export type DashboardSlotId = keyof typeof dashboardSlots & keyof DashboardSlotProps;
export type DashboardDataSlotId = { [Id in DashboardSlotId]: (typeof dashboardSlots)[Id]["kind"] extends "data" ? Id : never }[DashboardSlotId];
export type DashboardRenderSlotId = Exclude<DashboardSlotId, DashboardDataSlotId>;

export type DashboardModuleContribution = {
  readonly moduleId: string;
  /** First-party only: declared navigation and settings pages remain integrated in the Core shell. */
  readonly coreShell?: true;
  /** Workspace pages rendered for workspace-ready modules. */
  readonly routes?: readonly DashboardWorkspaceRoute[];
  /** Settings pages, one for each declared settings path. */
  readonly settingsPages?: readonly DashboardSettingsPage[];
  /** Guided setup shown while the enabled module is not set up. Required when the manifest declares setup steps. */
  readonly setup?: ComponentType<DashboardSetupProps>;
  readonly walkthroughs?: readonly DashboardModuleWalkthrough[];
  /** Public pages served without signing in. */
  readonly publicPages?: readonly DashboardPublicPage[];
  /** Data hooks run once per host data slot. The module's slot components read the result with `useModuleSlotData`. */
  readonly slotData?: { readonly [Id in DashboardDataSlotId]?: (props: DashboardSlotProps[Id]) => unknown };
  /** Components rendered in host render slots, each inside the module root. */
  readonly slots?: { readonly [Id in DashboardRenderSlotId]?: ComponentType<DashboardSlotProps[Id]> };
};

export type DashboardModuleEntry = { readonly manifest: ModuleDefinition; readonly contribution: DashboardModuleContribution };

type Registry = { readonly modules: readonly ModuleDefinition[] };
const literalSegment = /^[A-Za-z0-9._~-]+$/;
const parameterSegment = /^:[a-z][A-Za-z0-9]*\+?$/;

function patternSegments(pattern: string) {
  return pattern.slice(1).split("/");
}

/** Whether a path pattern uses the supported literal, `:name` and final `:name+` segments. */
export function validDashboardPathPattern(pattern: string) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) return false;
  const segments = patternSegments(pattern);
  const names = segments.filter((segment) => segment.startsWith(":")).map((segment) => segment.replace(/^:|\+$/g, ""));
  return segments.every((segment, index) => literalSegment.test(segment) || parameterSegment.test(segment) && (!segment.endsWith("+") || index === segments.length - 1)) && new Set(names).size === names.length;
}

/** Match a normalized dashboard path against a pattern, returning raw (still encoded) parameters. */
export function matchDashboardPath(pattern: string, path: string): DashboardPathParams | undefined {
  if (!path.startsWith("/")) return undefined;
  const expected = patternSegments(pattern);
  const actual = path.slice(1).split("/");
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    if (segment.endsWith("+")) {
      const rest = actual.slice(index).join("/");
      if (!rest) return undefined;
      params[segment.slice(1, -1)] = rest;
      return params;
    }
    const value = actual[index];
    if (value === undefined) return undefined;
    if (segment.startsWith(":")) {
      if (!value) return undefined;
      params[segment.slice(1)] = value;
    } else if (value !== segment) return undefined;
  }
  return actual.length === expected.length ? params : undefined;
}

/** Decode matched parameters for a page. Malformed escapes throw, as the hand-written routes did. */
export function decodeDashboardPathParams(params: DashboardPathParams): DashboardPathParams {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, decodeURIComponent(value)]));
}

function sameKeys(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((key) => expected.includes(key));
}

function within(path: string, base: string) {
  return path === base || path.startsWith(`${base}/`);
}

/** Bind dashboard implementations to their registry declarations, rejecting any missing or undeclared contribution. */
export function createDashboardModuleSet(registry: Registry, contributions: readonly DashboardModuleContribution[]) {
  const byId = new Map<string, DashboardModuleContribution>();
  const navigationOwners = new Map<string, string>();
  for (const module of registry.modules) for (const item of module.navigation) {
    if (navigationOwners.has(item.path)) throw new Error(`Module ${module.id} navigation path ${item.path} is already declared`);
    navigationOwners.set(item.path, module.id);
  }
  const publicPaths = new Set<string>();
  for (const contribution of contributions) {
    const module = registry.modules.find((item) => item.id === contribution.moduleId);
    if (!module || byId.has(module.id)) throw new Error("Invalid or duplicate module contribution");
    const routes = contribution.routes ?? [];
    const settingsPages = contribution.settingsPages ?? [];
    const walkthroughs = contribution.walkthroughs ?? [];
    if (contribution.coreShell) {
      if (contribution.routes || contribution.settingsPages || contribution.walkthroughs) throw new Error(`Module ${module.id} pages remain in the Core shell`);
    } else {
      if (routes.some((route) => !validDashboardPathPattern(route.path) || route.path.startsWith("/settings/") || !module.navigation.some((item) => within(route.path, item.path))) || new Set(routes.map((route) => route.path)).size !== routes.length) throw new Error(`Module ${module.id} workspace routes do not match declared navigation`);
      if (module.navigation.some((item) => !routes.some((route) => matchDashboardPath(route.path, item.path)))) throw new Error(`Module ${module.id} declared navigation is not rendered`);
      if (settingsPages.some((page) => !page.path.startsWith("/settings/")) || !sameKeys(settingsPages.map((page) => page.path), module.settings.map((item) => item.path))) throw new Error(`Module ${module.id} settings pages do not match declared settings`);
      if (walkthroughs.some((walkthrough) => !routes.some((route) => route.path === walkthrough.path)) || new Set(walkthroughs.map((walkthrough) => walkthrough.path)).size !== walkthroughs.length) throw new Error(`Module ${module.id} walkthroughs do not match workspace routes`);
    }
    if (module.setup.steps.length ? typeof contribution.setup !== "function" : contribution.setup) throw new Error(`Module ${module.id} setup workspace does not match declared setup`);
    for (const page of contribution.publicPages ?? []) {
      const reserved = [...coreDashboardPaths, ...registry.modules.flatMap((item) => [...item.navigation, ...item.settings].map((entry) => entry.path))];
      if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.path) || reserved.some((path) => within(page.path, path) || within(path, page.path)) || publicPaths.has(page.path) || typeof page.render !== "function" || typeof page.skipLinkLabel !== "string" || !page.skipLinkLabel.trim()) throw new Error(`Module ${module.id} public pages are invalid`);
      publicPaths.add(page.path);
    }
    const slotEntries = [...Object.entries(contribution.slots ?? {}).map(([id, value]) => [id, value, false] as const), ...Object.entries(contribution.slotData ?? {}).map(([id, value]) => [id, value, true] as const)];
    if (slotEntries.some(([id, value, data]) => !Object.hasOwn(dashboardSlots, id) || (dashboardSlots[id as DashboardSlotId].kind === "data") !== data || !registry.modules.some((item) => item.id === dashboardSlots[id as DashboardSlotId].host) || !["function", "object"].includes(typeof value) || !value)) throw new Error(`Module ${module.id} slot contributions do not match host slots`);
    byId.set(module.id, contribution);
  }
  for (const module of registry.modules) if (!byId.has(module.id)) throw new Error(`Module ${module.id} dashboard implementation is missing`);
  const entries: readonly DashboardModuleEntry[] = Object.freeze(registry.modules.map((manifest) => Object.freeze({ manifest, contribution: byId.get(manifest.id)! })));
  return Object.freeze({
    entries,
    all: Object.freeze(entries.map((entry) => entry.contribution)),
    get: (moduleId: string) => byId.get(moduleId),
    require(moduleId: string) { const contribution = byId.get(moduleId); if (!contribution) throw new Error("Unknown module contribution"); return contribution; },
  });
}

export type DashboardModuleSet = ReturnType<typeof createDashboardModuleSet>;

/**
 * Compose first-party contributions with plugin contributions. A plugin whose dashboard contribution is invalid, or whose
 * manifest is missing, is left out and reported, so Core and every other module keep working.
 */
export function composeDashboardModules(input: {
  readonly firstParty: readonly ModuleDefinition[];
  readonly firstPartyContributions: readonly DashboardModuleContribution[];
  readonly externalManifests: readonly ModuleDefinition[];
  readonly externalContributions: readonly DashboardModuleContribution[];
  readonly createRegistry: (modules: readonly ModuleDefinition[]) => Registry;
  readonly report?: (moduleId: string, error: unknown) => void;
}) {
  const accepted: { manifest: ModuleDefinition; contribution: DashboardModuleContribution }[] = [];
  for (const contribution of input.externalContributions) {
    const manifest = input.externalManifests.find((module) => module.id === contribution?.moduleId);
    try {
      if (!manifest) throw new Error("No installed manifest matches this dashboard contribution");
      const candidate = [...accepted, { manifest, contribution }];
      createDashboardModuleSet(input.createRegistry([...input.firstParty, ...candidate.map((item) => item.manifest)]), [...input.firstPartyContributions, ...candidate.map((item) => item.contribution)]);
      accepted.push({ manifest, contribution });
    } catch (error) { input.report?.(String(contribution?.moduleId), error); }
  }
  return createDashboardModuleSet(input.createRegistry([...input.firstParty, ...accepted.map((item) => item.manifest)]), [...input.firstPartyContributions, ...accepted.map((item) => item.contribution)]);
}
/** A matched module page. `params` are still encoded; decode them with `decodeDashboardPathParams` when rendering. */
export type DashboardModulePage = { readonly moduleId: string; readonly params: DashboardPathParams; readonly render: (context: DashboardPageContext) => ReactNode };

/** Contributed modules whose pages render in the dashboard, in registry order. */
export function contributedModules(modules: DashboardModuleSet, ready: (moduleId: string) => boolean = () => true) {
  return modules.entries.filter(({ manifest, contribution }) => !contribution.coreShell && ready(manifest.id));
}

/** The workspace route or settings page a ready module renders for this path. */
export function resolveDashboardModulePage(modules: DashboardModuleSet, path: string, role: DashboardRole, ready: (moduleId: string) => boolean): DashboardModulePage | undefined {
  for (const { manifest, contribution } of contributedModules(modules, ready)) {
    for (const route of contribution.routes ?? []) {
      const params = matchDashboardPath(route.path, path);
      if (params) return { moduleId: manifest.id, params, render: route.render };
    }
    for (const page of contribution.settingsPages ?? []) if (page.path === path && (role === "admin" || page.operator)) return { moduleId: manifest.id, params: {}, render: page.render };
  }
  return undefined;
}

/** Modules contributing to a slot, in registry order, while the slot's host and the contributing module are ready. */
export function dashboardSlotContributors(modules: DashboardModuleSet, slot: DashboardSlotId, ready: (moduleId: string) => boolean) {
  if (!ready(dashboardSlots[slot].host)) return [];
  const field = dashboardSlots[slot].kind === "data" ? "slotData" : "slots";
  return modules.entries.filter(({ manifest, contribution }) => (contribution[field] as Readonly<Record<string, unknown>> | undefined)?.[slot] && ready(manifest.id));
}

/** The public page a contributed module serves at exactly this path. */
export function resolveDashboardPublicPage(modules: DashboardModuleSet, path: string) {
  for (const { manifest, contribution } of modules.entries) {
    const page = contribution.publicPages?.find((item) => item.path === path);
    if (page) return { moduleId: manifest.id, page };
  }
  return undefined;
}

/** Whether a contributed workspace route asks for the wide layout on this path. */
export function dashboardModuleWideLayout(modules: DashboardModuleSet, path: string) {
  return contributedModules(modules).some(({ contribution }) => contribution.routes?.some((route) => route.wide && matchDashboardPath(route.path, path)));
}

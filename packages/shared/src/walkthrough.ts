import { bundledModuleRegistry } from "./module-platform.ts";

/** Walkthroughs of Core pages. Modules declare their own pages in their manifest `walkthroughs`. */
export const coreWalkthroughs = {
  dashboard: {
    version: 1,
    steps: ["navigation", "calendar", "find-meeting", "table", "search", "selection", "add-meeting", "essentials", "audience", "recurrence"],
  },
  roster: {
    version: 1,
    steps: ["filters", "member-rows", "attendance", "member-actions", "bulk-tools"],
  },
  member: {
    version: 1,
    steps: ["profile", "labels", "attendance-policy", "history", "member-actions"],
  },
  reports: {
    version: 1,
    steps: ["tabs", "filters", "leaderboard", "trend", "report-builder", "report-actions"],
  },
  meeting: {
    version: 1,
    steps: ["navigation", "summary", "management", "integrations", "contests", "attendance", "corrections"],
  },
  kiosks: {
    version: 1,
    steps: ["status", "diagnostics", "pairing", "device-actions", "rename", "fingerprints", "restart", "network-pin", "updates", "retirement", "simulator", "history"],
  },
  simulator: {
    version: 1,
    steps: ["boundary", "preview", "inputs", "simulate"],
  },
} as const;

type WalkthroughDefinition = { readonly version: number; readonly steps: readonly string[] };
/** Core pages plus the pages installed modules declare, keyed by page ID. */
export const walkthroughs: Readonly<Record<string, WalkthroughDefinition>> = (() => {
  const pages: Record<string, WalkthroughDefinition> = { ...coreWalkthroughs };
  for (const module of bundledModuleRegistry.modules) for (const [pageId, definition] of Object.entries(module.walkthroughs ?? {})) {
    if (Object.hasOwn(pages, pageId)) throw new Error(`Module ${module.id} walkthrough page ${pageId} is already declared`);
    pages[pageId] = definition;
  }
  return Object.freeze(pages);
})();

/** A Core page ID, or a page ID an installed module declares. */
export type WalkthroughPage = keyof typeof coreWalkthroughs | (string & {});
export type WalkthroughStatus = "not_started" | "in_progress" | "completed" | "dismissed";
export type WalkthroughProgress = { pageId: WalkthroughPage; version: number; status: WalkthroughStatus; stepId: string | null };

export function validWalkthroughProgress(value: unknown): value is WalkthroughProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as WalkthroughProgress;
  if (!Object.hasOwn(walkthroughs, progress.pageId)) return false;
  const definition = walkthroughs[progress.pageId]!;
  return typeof progress.pageId === "string" && Number.isInteger(progress.version) && progress.version > 0 && progress.version <= definition.version
    && ["not_started", "in_progress", "completed", "dismissed"].includes(progress.status)
    // Retain saved progress from the removed roster summary step. Resuming starts at filters.
    && (progress.stepId === null ? progress.status !== "in_progress" : (definition.steps as readonly string[]).includes(progress.stepId) || progress.pageId === "roster" && progress.stepId === "summary");
}

export const initialWalkthroughProgress = (pageId: WalkthroughPage): WalkthroughProgress => ({ pageId, version: walkthroughs[pageId]!.version, status: "not_started", stepId: null });

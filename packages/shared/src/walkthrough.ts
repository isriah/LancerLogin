export const walkthroughs = {
  dashboard: {
    version: 1,
    steps: ["navigation", "calendar", "find-meeting", "table", "search", "selection", "add-meeting", "essentials", "audience", "recurrence"],
  },
  roster: {
    version: 1,
    steps: ["summary", "filters", "member-rows", "attendance", "member-actions", "bulk-tools"],
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

export type WalkthroughPage = keyof typeof walkthroughs;
export type WalkthroughStatus = "not_started" | "in_progress" | "completed" | "dismissed";
export type WalkthroughProgress = { pageId: WalkthroughPage; version: number; status: WalkthroughStatus; stepId: string | null };

export function validWalkthroughProgress(value: unknown): value is WalkthroughProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as WalkthroughProgress;
  if (!Object.hasOwn(walkthroughs, progress.pageId)) return false;
  const definition = walkthroughs[progress.pageId];
  return Number.isInteger(progress.version) && progress.version > 0 && progress.version <= definition.version
    && ["not_started", "in_progress", "completed", "dismissed"].includes(progress.status)
    && (progress.stepId === null ? progress.status !== "in_progress" : (definition.steps as readonly string[]).includes(progress.stepId));
}

export const initialWalkthroughProgress = (pageId: WalkthroughPage): WalkthroughProgress => ({ pageId, version: walkthroughs[pageId].version, status: "not_started", stepId: null });

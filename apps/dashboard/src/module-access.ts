import type { ModulePlatformSnapshot } from "../../../packages/shared/src/module-platform.ts";

/**
 * Why module access could not be confirmed:
 * - `unavailable`: no usable response (network failure, rate limit or server error). Worth retrying.
 * - `unverified`: the Worker answered, but its module state does not match this dashboard bundle. This is expected for a
 *   short time during a web update, after the Worker deploys and before the new dashboard is served.
 * - `signed-out`: the session is no longer valid.
 */
export type ModuleAccessFailure = "unavailable" | "unverified" | "signed-out";
export type ModuleNavigationResult = { receivedAt: number } & ({ snapshot: ModulePlatformSnapshot; error?: false } | { snapshot?: undefined; error: true; reason: ModuleAccessFailure });
export type ModuleAccessState = { snapshot?: ModulePlatformSnapshot; failure?: ModuleAccessFailure; stale: boolean };

/** Background module refresh interval. Focus, tab visibility and explicit reloads refresh sooner. */
export const moduleRefreshIntervalMs = 30_000;

/** Classify a failed module read by HTTP status; `undefined` means no response arrived. */
export function moduleFailureForStatus(status: number | undefined): ModuleAccessFailure {
  if (status === 401) return "signed-out";
  return status === undefined || status === 429 || status >= 500 ? "unavailable" : "unverified";
}

/**
 * Next module access state after a refresh. A transient failure keeps the last confirmed snapshot (marked stale) so the
 * open page and its unsaved work survive a network blip. An unverifiable snapshot still fails closed.
 */
export function nextModuleAccess(current: ModuleAccessState, result: ModuleNavigationResult): ModuleAccessState {
  if (!result.error) return { snapshot: result.snapshot, stale: false };
  if (result.reason === "unavailable" && current.snapshot) return { snapshot: current.snapshot, stale: true };
  if (result.reason === "signed-out") return { snapshot: current.snapshot, failure: "signed-out", stale: false };
  return { failure: result.reason, stale: false };
}

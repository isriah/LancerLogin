import { useEffect, useState } from "react";
import type { ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api, ApiError } from "./dashboard-api";
import { readModuleSnapshot } from "./module-client";
import { moduleFailureForStatus, moduleRefreshIntervalMs, nextModuleAccess, type ModuleAccessState, type ModuleNavigationResult } from "./module-access";

export type { ModuleAccessFailure, ModuleNavigationResult } from "./module-access";

export async function loadModuleNavigation(): Promise<ModuleNavigationResult> {
  let value: unknown;
  try { value = await api<unknown>("/platform/modules"); }
  catch (error) { return { error: true, reason: moduleFailureForStatus(error instanceof ApiError ? error.status : undefined), receivedAt: Date.now() }; }
  try { return { snapshot: readModuleSnapshot(value), receivedAt: Date.now() }; }
  catch { return { error: true, reason: "unverified", receivedAt: Date.now() }; }
}

export function useModuleNavigation(initialRequest?: Promise<ModuleNavigationResult>) {
  const [state, setState] = useState<ModuleAccessState>({ stale: false });
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true; let running = false; let queued = false;
    const load = async (initial = false) => {
      // One request at a time. A refresh requested meanwhile runs once the current one finishes.
      if (running) { queued = true; return; }
      running = true;
      if (initial) setLoading(true);
      try {
        const preloaded = initial && version === 0 && initialRequest;
        let next = await (preloaded ? initialRequest : loadModuleNavigation());
        if (preloaded && Date.now() - next.receivedAt >= 5_000) next = await loadModuleNavigation();
        if (active) setState((current) => nextModuleAccess(current, next));
      } catch {
        if (active) setState((current) => nextModuleAccess(current, { error: true, reason: "unavailable", receivedAt: Date.now() }));
      } finally {
        running = false;
        if (active) { if (initial) setLoading(false); if (queued) { queued = false; void load(); } }
      }
    };
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    void load(true);
    // Hidden tabs do not poll; they refresh as soon as they are shown again.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && !running) void load(); }, moduleRefreshIntervalMs);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [version]);
  const { snapshot, failure, stale } = state;
  const module = (moduleId: string): ModuleSnapshotItem | undefined => snapshot?.modules.find((item) => item.id === moduleId);
  return { snapshot, module, loading, error: !snapshot && Boolean(failure), failure, stale, reload: () => setVersion((value) => value + 1) };
}

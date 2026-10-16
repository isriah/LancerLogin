import { useEffect, useState } from "react";
import type { ModulePlatformSnapshot, ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import { readModuleSnapshot } from "./module-client";

export type ModuleNavigationResult = { receivedAt: number } & ({ snapshot: ModulePlatformSnapshot; error?: false } | { snapshot?: undefined; error: true });

export async function loadModuleNavigation(): Promise<ModuleNavigationResult> {
  try { return { snapshot: readModuleSnapshot(await api<unknown>("/platform/modules")), receivedAt: Date.now() }; }
  catch { return { error: true, receivedAt: Date.now() }; }
}

export function useModuleNavigation(initialRequest?: Promise<ModuleNavigationResult>) {
  const [snapshot, setSnapshot] = useState<ModulePlatformSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true; let sequence = 0;
    const load = async (initial = false) => {
      const request = ++sequence;
      if (initial) setLoading(true);
      try {
        let next = await (initial && version === 0 && initialRequest ? initialRequest : loadModuleNavigation());
        if (initial && initialRequest && Date.now() - next.receivedAt >= 5_000) next = await loadModuleNavigation();
        if (active && request === sequence) { setSnapshot(next.snapshot); setError(Boolean(next.error)); }
      } catch {
        if (active && request === sequence) { setSnapshot(undefined); setError(true); }
      } finally { if (active && request === sequence) setLoading(false); }
    };
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    void load(true);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [version]);
  const module = (moduleId: string): ModuleSnapshotItem | undefined => snapshot?.modules.find((item) => item.id === moduleId);
  return { snapshot, module, loading, error, reload: () => setVersion((value) => value + 1) };
}

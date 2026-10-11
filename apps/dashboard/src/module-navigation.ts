import { useEffect, useState } from "react";
import type { ModulePlatformSnapshot, ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import { readModuleSnapshot } from "./module-client";

export function useModuleNavigation() {
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
        const next = readModuleSnapshot(await api<unknown>("/platform/modules"));
        if (active && request === sequence) { setSnapshot(next); setError(false); }
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

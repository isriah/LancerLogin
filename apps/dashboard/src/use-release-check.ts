import { useEffect, useState } from "react";
import { releaseCache, releaseCacheKey } from "./update-release";

// The local scheduler updates expiry/retry UI; successful remote checks occur at most every 15 minutes.
export function useReleaseCheck() {
  const [state, setState] = useState(releaseCache.snapshot);
  useEffect(() => {
    const update = () => setState(releaseCache.snapshot());
    const onStorage = (event: StorageEvent) => { if (event.key === releaseCacheKey) { releaseCache.sync(); update(); } };
    window.addEventListener("storage", onStorage);
    const unsubscribe = releaseCache.subscribe(update);
    const refresh = () => { update(); void releaseCache.check().catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { unsubscribe(); window.removeEventListener("storage", onStorage); window.clearInterval(timer); };
  }, []);
  return { ...state, check: (force = false) => releaseCache.check(force) };
}

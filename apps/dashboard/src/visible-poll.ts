/** Serial background refreshes pause in hidden tabs and resume when shown. */
export function visiblePoll(refresh: () => Promise<unknown>, intervalMs: number, onError: (error: Error) => void = () => undefined, immediate = false): () => void {
  let stopped = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { if (!stopped && !document.hidden) timer = setTimeout(() => void tick(), intervalMs); };
  async function tick() {
    if (stopped || running || document.hidden) return;
    running = true;
    try { await refresh(); } catch (error) { if (!stopped) onError(error as Error); }
    finally { running = false; schedule(); }
  }
  function visibility() {
    clearTimeout(timer);
    if (!document.hidden) void tick();
  }
  document.addEventListener("visibilitychange", visibility);
  if (immediate) void tick(); else schedule();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
}

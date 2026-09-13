// One timer and one request owner per resource, shared by all mounted consumers.
export function createUpdatePolling<T>({ read, cadence, visible = () => document.visibilityState === 'visible', now = Date.now, later = (run: () => void, ms: number) => setTimeout(run, ms), cancel = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer) }: {
  read: () => Promise<T>; cadence: (value: T) => number; visible?: () => boolean; now?: () => number;
  later?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const listeners = new Set<{ value: (value: T) => void; error: (error: unknown) => void }>();
  let timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<T> | undefined, forced: Promise<T> | undefined;
  let due = 0, failures = 0, generation = 0;
  function stop() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function schedule() { stop(); if (listeners.size && visible() && !flight && !forced) timer = later(() => { void automatic(); }, Math.max(0, due - now())); }
  function launch(task: () => Promise<T>) {
    stop(); const current = generation;
    const running = task().then(value => {
      if (current === generation) { failures = 0; due = now() + cadence(value); for (const listener of listeners) listener.value(value); }
      return value;
    }, error => {
      if (current === generation) { due = now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures++, 4)); for (const listener of listeners) listener.error(error); }
      throw error;
    }).finally(() => { if (flight === running) flight = undefined; schedule(); });
    flight = running; return running;
  }
  async function automatic() { if (!visible() || !listeners.size || flight || forced) return; if (now() < due) { schedule(); return; } try { await launch(read); } catch { /* Backoff is scheduled by launch. */ } }
  function fresh(task: () => Promise<T> = read): Promise<T> {
    stop(); generation++; due = 0;
    const previous = forced ?? flight;
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => launch(task)).finally(() => { if (forced === next) forced = undefined; schedule(); });
    forced = next; return next;
  }
  return {
    subscribe(value: (value: T) => void, error: (error: unknown) => void = () => {}) {
      const listener = { value, error }; listeners.add(listener); schedule();
      return () => { listeners.delete(listener); if (!listeners.size) stop(); };
    },
    refresh() { if (forced) return forced; return fresh(); },
    join() { return forced ?? flight ?? fresh(); },
    action(task: () => Promise<T>) { return fresh(task); },
    invalidate() { generation++; due = 0; schedule(); },
    visibilityChanged() { stop(); schedule(); },
  };
}

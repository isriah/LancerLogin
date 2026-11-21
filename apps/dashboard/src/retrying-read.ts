// A read the dashboard keeps showing through failures: the integration capabilities that gate Discord features
// (integration-capabilities.ts) and the Reviews count (contest-indicator.tsx). A failed read is not an answer. It keeps
// the last value that was read, or nothing yet, and reads again after 2, 5, 15 and 30 seconds, then every 60 seconds
// until a read succeeds or the reader is stopped.
//
// This file has no React import, so tests-ts can load it.

/** Milliseconds before each read again after a failure; the last one repeats until a read succeeds. */
export const retryDelays: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];

type Timer = ReturnType<typeof setTimeout>;
export type RetryingReadOptions<T> = {
  /** One request; it may reject. */
  fetch: () => Promise<T>;
  /** Called with each successful answer that is still the newest read, while the reader runs. Never called for a failure. */
  onValue: (value: T) => void;
  /** What a failed read resolves to before any read has succeeded. */
  empty: T;
  delays?: readonly number[];
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

/**
 * `read` returns the current read, starting one if none has started or the last one failed with no retry pending (after
 * `stop`); `load` always starts a new one. Neither promise rejects: a failure resolves to the last value read, or
 * `empty` before any. `stop` cancels a pending retry, any retry a read still in flight would schedule, and the answers
 * of reads in flight; a later `read` or `load` resumes.
 */
export function createRetryingRead<T>({ fetch, onValue, empty, delays = retryDelays, setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = (timer) => clearTimeout(timer) }: RetryingReadOptions<T>) {
  let known: { value: T } | undefined; let current: Promise<T> | undefined; let timer: Timer | undefined; let stopped = false; let failed = false;
  const cancelRetry = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  function load(attempt: number): Promise<T> {
    cancelRetry(); stopped = false; failed = false;
    const request: Promise<T> = fetch().then((value) => {
      known = { value }; if (current === request && !stopped) onValue(value);
      return value;
    }, () => {
      // Only the newest read retries, so a slow failure cannot restart retries that a later read already settled.
      if (current === request) failed = true;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      if (!stopped && current === request && delay !== undefined) timer = setTimer(() => { timer = undefined; void load(attempt + 1); }, delay);
      return known ? known.value : empty;
    });
    current = request;
    return request;
  }
  return {
    load: () => load(0),
    read: () => { stopped = false; return !current || failed && timer === undefined ? load(0) : current; },
    stop: () => { stopped = true; cancelRetry(); },
  };
}

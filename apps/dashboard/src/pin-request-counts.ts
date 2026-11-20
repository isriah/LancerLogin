import { useSyncExternalStore } from "react";

/**
 * How many PIN requests are waiting, in total and at each kiosk. One shared answer for the top bar's count and the
 * Kiosks list's row counts, so the two always agree.
 *
 * The Worker sends the counts with the module refresh (GET /platform/modules), which the shell already repeats every 30
 * seconds while the tab is visible, so knowing the count on every page adds no request. A page that reads the requests
 * themselves (Manage kiosk, the PIN requests dialog) reports what it saw, so an answer shows in the counts at once.
 * Only requests that are pending and have not run out are ever counted.
 */
export type PinRequestCounts = { readonly total: number; readonly kiosks: Readonly<Record<string, number>> };

const none: PinRequestCounts = Object.freeze({ total: 0, kiosks: Object.freeze({}) });
let current = none;
const listeners = new Set<() => void>();

function counts(entries: Iterable<readonly [string, number]>): PinRequestCounts {
  const kiosks: Record<string, number> = {}; let total = 0;
  for (const [kioskId, count] of entries) if (count > 0) { kiosks[kioskId] = (kiosks[kioskId] ?? 0) + count; total += count; }
  return total ? { total, kiosks } : none;
}
const same = (left: PinRequestCounts, right: PinRequestCounts) => left.total === right.total && Object.keys(left.kiosks).length === Object.keys(right.kiosks).length && Object.entries(left.kiosks).every(([kioskId, count]) => right.kiosks[kioskId] === count);

/** The counts in a module refresh, `{ kiosks: [{ kioskId, count }] }`; undefined when the answer carries none or they are malformed. */
export function readPinRequestCounts(value: unknown): PinRequestCounts | undefined {
  const list = value && typeof value === "object" ? (value as { kiosks?: unknown }).kiosks : undefined;
  if (!Array.isArray(list)) return undefined;
  const entries: [string, number][] = [];
  for (const item of list) {
    const { kioskId, count } = (item && typeof item === "object" ? item : {}) as { kioskId?: unknown; count?: unknown };
    if (typeof kioskId !== "string" || !kioskId || !Number.isSafeInteger(count) || Number(count) < 0) return undefined;
    entries.push([kioskId, Number(count)]);
  }
  return counts(entries);
}

/** The counts of a list of waiting requests, each naming its kiosk. */
export function countPinRequests(requests: readonly { kioskId: string }[]): PinRequestCounts {
  return counts(requests.map((request) => [request.kioskId, 1] as const));
}

export function pinRequestCounts(): PinRequestCounts { return current; }

export function setPinRequestCounts(next: PinRequestCounts) {
  if (same(current, next)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/** One kiosk's count, as its Manage page just read it; the other kiosks keep theirs. */
export function setKioskPinRequestCount(kioskId: string, count: number) {
  setPinRequestCounts(counts(Object.entries({ ...current.kiosks, [kioskId]: count })));
}

/** Forgets the counts, for a session that ended. */
export function clearPinRequestCounts() { setPinRequestCounts(none); }

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function usePinRequestCounts(): PinRequestCounts { return useSyncExternalStore(subscribe, pinRequestCounts); }

/** "2 PIN requests", "1 PIN request". */
export function pinRequestCountText(count: number) { return `${count} PIN ${count === 1 ? "request" : "requests"}`; }

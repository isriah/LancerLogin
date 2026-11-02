import { parseReleaseVersion, compareReleaseVersions, kioskReleaseTransition, releaseAllowed, type UpdateChannel } from "../../../packages/shared/src/release-policy.mjs";
export type Release = { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean; body?: string; channel?: UpdateChannel };

// Compare only complete stable versions; partial or malformed tags are unknown.
export function hasComparableStableVersions(release: Release | undefined, installed: string) {
  const tag = release?.tag_name;
  return Boolean(release && release.draft !== true && typeof tag === "string" && releaseAllowed(tag.startsWith("v") ? tag : `v${tag}`, release.channel ?? "stable", release.prerelease ?? false) && parseReleaseVersion(installed));
}

export function isNewerRelease(candidate: string, installed: string) {
  return compareReleaseVersions(candidate, installed) === 1;
}

export function kioskUpdateTransition(release: Release | undefined, installed: string) {
  if (!release || !hasComparableStableVersions(release, "0.0.0")) return "unavailable";
  return kioskReleaseTransition(release.tag_name, installed);
}

export const latestReleaseUrl = `${(import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api"}/admin/releases/latest`;
export const latestReleaseTimeoutMs = 6_000;
type CheckedRelease = Release & { checkedAt?: number; attemptedAt?: number; checkedAgeMs?: number };
type Discovery = { release?: Release; checkedAt?: number; attemptedAt?: number; retryAt?: number; fresh?: boolean; code?: string; error?: string; channel?: UpdateChannel; checkedAgeMs?: number; refreshAfterMs?: number };
/** Durations from the server, never its clock: a usable value is a finite, non-negative number of milliseconds. */
const duration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export async function fetchLatestRelease(
  fetcher: typeof fetch = fetch,
  timeoutMs = latestReleaseTimeoutMs,
  channel: UpdateChannel = "stable",
  refresh = false,
): Promise<CheckedRelease> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Check for updates asks the server to read GitHub now instead of answering from its 15-minute cache.
    const response = await fetcher(refresh ? `${latestReleaseUrl}?refresh=now` : latestReleaseUrl, {
      headers: { accept: "application/json" }, credentials: "include", cache: "no-store",
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({})) as Discovery;
    if ((result.channel ?? "stable") !== channel) throw new ReleaseCheckError("The update track changed. Refresh its setting.", response, { ...result, code: "channel_changed" });
    if (!response.ok || result.fresh !== true || !result.release || typeof result.checkedAt !== "number") {
      throw new ReleaseCheckError(discoveryMessage(result.code), response, result);
    }
    return { ...result.release, ...(channel === "beta" ? { channel } : {}), checkedAt: result.checkedAt, attemptedAt: result.attemptedAt, ...(duration(result.checkedAgeMs) ? { checkedAgeMs: result.checkedAgeMs } : {}) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Latest release check timed out.");
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export function createSingleFlight<T>(load: () => Promise<T>) {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const request = Promise.resolve().then(load);
    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  };
}

/** Single-flight read that also reuses its last success for `ttlMs`, so readers mounting together share one request. `invalidate` makes the next read go to the server, even while an older read is still in flight. */
export function createCachedRead<T>(load: () => Promise<T>, ttlMs: number, now: () => number = () => Date.now()) {
  let inFlight: Promise<T> | undefined;
  let cached: { value: T; at: number } | undefined;
  const read = (): Promise<T> => {
    if (inFlight) return inFlight;
    const age = cached ? now() - cached.at : -1;
    if (cached && age >= 0 && age < ttlMs) return Promise.resolve(cached.value);
    const tracked: Promise<T> = Promise.resolve().then(load).then((value) => { if (inFlight === tracked) cached = { value, at: now() }; return value; })
      .finally(() => { if (inFlight === tracked) inFlight = undefined; });
    inFlight = tracked;
    return tracked;
  };
  return Object.assign(read, { invalidate() { inFlight = undefined; cached = undefined; } });
}

// The old direct-browser cache cannot confirm same-origin discovery or block it.
export const releaseCacheKey = "lancerlogin-release-cache-v3:stable";
export const releaseCacheKeyForChannel = (channel: UpdateChannel) => releaseCacheKey.replace(/stable$/, channel);
export const releaseCacheTtlMs = 15 * 60_000;
export const releaseCacheMaximumRetryMs = 60 * 60_000;
/** `refreshAt` is when Check for updates may ask the server again during a failure cooldown, if sooner than `retryAt`. */
export type ReleaseSnapshot = { release?: Release; checkedAt?: number; attemptedAt?: number; retryAt?: number; refreshAt?: number; error?: string; code?: string; checking: boolean; fresh: boolean };
type Stored = { release?: Release; checkedAt?: number; attemptedAt?: number; retryAt?: number; refreshAt?: number; failures: number; error?: string; code?: string };
function discoveryMessage(code?: string) {
  switch (code) {
    case "rate_limited": return "GitHub release discovery is rate limited.";
    case "timeout": return "Latest release check timed out.";
    case "network": return "The server could not reach GitHub release discovery.";
    case "invalid_release": return "A compatible stable release could not be confirmed.";
    default: return "Latest release is temporarily unavailable.";
  }
}
export class ReleaseCheckError extends Error {
  response: Response;
  discovery?: Discovery;
  retryAfterMs?: number;
  constructor(message: string, response: Response, discovery?: Discovery) {
    super(message); this.response = response; this.discovery = discovery;
    const after = response.headers.get("retry-after");
    if (after && /^\d+$/.test(after.trim())) this.retryAfterMs = Math.min(Number(after) * 1000, releaseCacheMaximumRetryMs);
  }
}
function safeRelease(value: unknown, channel: UpdateChannel = "stable"): Release | undefined {
  if (!value || typeof value !== "object") return;
  const release = value as Release;
  if (!hasComparableStableVersions({ ...release, channel }, "0.0.0") || [release.draft, release.prerelease].some((flag) => flag !== undefined && typeof flag !== "boolean")) return;
  const result: Release = { tag_name: release.tag_name, ...(channel === "beta" ? { prerelease: release.prerelease ?? false, channel } : {}) };
  if (typeof release.body === "string") result.body = release.body.slice(0, 32_000);
  // Never turn persisted or provider-controlled metadata into an unsafe link.
  if (typeof release.html_url === "string") {
    try { const url = new URL(release.html_url); if (url.protocol === "https:" && !url.username && !url.password) result.html_url = url.href; } catch { /* Notes are optional. */ }
  }
  return result;
}
export function createReleaseCache({ channel = "stable", load = (refresh) => fetchLatestRelease(fetch, latestReleaseTimeoutMs, channel, refresh), now = Date.now, storage = () => globalThis.localStorage }: {
  load?: (refresh: boolean) => Promise<CheckedRelease>; now?: () => number; storage?: () => Pick<Storage, "getItem" | "setItem">;
  channel?: UpdateChannel;
} = {}) {
  const cacheKey = releaseCacheKeyForChannel(channel);
  let data: Stored = { failures: 0 };
  let inFlight: Promise<Release> | undefined;
  const listeners = new Set<() => void>();
  const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
  let lastSaved: string | null | undefined;
  function sync() {
    try {
      const raw = storage().getItem(cacheKey);
      if (raw === lastSaved) return;
      lastSaved = raw;
      if (raw) {
        const saved = JSON.parse(raw) as Stored;
        if (saved && typeof saved === "object" && Number.isInteger(saved.failures) && saved.failures >= 0 && saved.failures <= 10
          && [saved.checkedAt, saved.attemptedAt, saved.retryAt, saved.refreshAt].every((value) => value === undefined || timestamp(value))
          && (saved.failures === 0 ? saved.retryAt === undefined : Boolean(saved.attemptedAt && saved.retryAt))) {
          const release = safeRelease(saved.release, channel);
          const localNow = now();
          const attemptedAt = saved.attemptedAt ? Math.min(saved.attemptedAt, localNow) : undefined;
          const retryAt = saved.retryAt ? Math.min(saved.retryAt, localNow + releaseCacheMaximumRetryMs) : undefined;
          const refreshAt = retryAt && saved.refreshAt ? Math.min(saved.refreshAt, retryAt) : undefined;
          data = { failures: saved.failures, attemptedAt, retryAt, ...(refreshAt ? { refreshAt } : {}),
            ...(release && saved.checkedAt ? { release, checkedAt: Math.min(saved.checkedAt, localNow) } : {}),
            ...(saved.failures ? { code: saved.code, error: discoveryMessage(saved.code) } : {}) };
        }
      }
    } catch { /* In-memory checks work when storage is unavailable or malformed. */ }
  }
  sync();
  const snapshot = (): ReleaseSnapshot => ({ ...data, checking: Boolean(inFlight), fresh: Boolean(data.release && data.checkedAt && now() >= data.checkedAt && now() - data.checkedAt < releaseCacheTtlMs && !data.error) });
  function publish() { for (const listener of listeners) listener(); }
  function persist() { try { const raw = JSON.stringify(data); storage().setItem(cacheKey, raw); lastSaved = raw; } catch { /* Storage is optional. */ } }
  /**
   * `force` skips this browser's fresh cache. `refresh` (Check for updates) also asks the server to read GitHub now, and may
   * run during a failure cooldown once the server's `refreshAt` has passed. Automatic checks pass neither.
   */
  function check(force = false, refresh = false): Promise<Release> {
    if (inFlight) return inFlight;
    sync();
    const refreshAllowed = refresh && data.refreshAt !== undefined && now() >= data.refreshAt;
    if (data.retryAt && now() < data.retryAt && !refreshAllowed) return Promise.reject(new Error(data.error ?? "Latest release is temporarily unavailable."));
    if (!force && snapshot().fresh) return Promise.resolve(data.release!);
    data.attemptedAt = now();
    const request = Promise.resolve().then(() => load(refresh)).then((value) => {
      const release = safeRelease(value, channel);
      if (!release) throw new Error("A compatible stable release could not be confirmed.");
      const receivedAt = now();
      // The authenticated same-origin response is fresh when received, less the age the server reports for its cached
      // answer, so Last successful check shows when GitHub was read. Only that duration crosses over: browser and
      // server wall clocks never participate in cache freshness or cooldown math.
      const age = duration(value?.checkedAgeMs) ? Math.min(value.checkedAgeMs, releaseCacheTtlMs) : 0;
      data = { release, checkedAt: receivedAt - age, attemptedAt: receivedAt, failures: 0 };
      persist(); return release;
    }).catch((error: unknown) => {
      const failures = Math.min(data.failures + 1, 10);
      let retryAt = now() + Math.min(30_000 * 2 ** (failures - 1), releaseCacheTtlMs);
      if (error instanceof ReleaseCheckError && error.retryAfterMs) retryAt = Math.max(retryAt, now() + error.retryAfterMs);
      const discovery = error instanceof ReleaseCheckError ? error.discovery : undefined;
      retryAt = Math.min(retryAt, now() + releaseCacheMaximumRetryMs);
      // With the web-update credential the server lets Check for updates through sooner than automatic backoff.
      const refreshAt = duration(discovery?.refreshAfterMs) ? Math.min(now() + discovery.refreshAfterMs, retryAt) : undefined;
      data = { ...data, failures, retryAt, refreshAt, code: discovery?.code, error: error instanceof Error ? error.message : "Latest release is temporarily unavailable." };
      if (refreshAt === undefined) delete data.refreshAt;
      const previousRelease = safeRelease(discovery?.release, channel);
      if (previousRelease) data.release = previousRelease;
      persist(); throw error;
    });
    const tracked = request.finally(() => { inFlight = undefined; publish(); });
    inFlight = tracked; publish(); return tracked;
  }
  return { check, snapshot, sync, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
export const releaseCache = createReleaseCache();
const betaReleaseCache = createReleaseCache({ channel: "beta" });
export const releaseCacheForChannel = (channel: UpdateChannel) => channel === "beta" ? betaReleaseCache : releaseCache;

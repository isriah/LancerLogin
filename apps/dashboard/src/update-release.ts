export type Release = { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };

// Compare only complete stable versions; partial or malformed tags are unknown.
export function hasComparableStableVersions(release: Release | undefined, installed: string) {
  const stable = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const valid = (value: unknown) => typeof value === "string" && stable.test(value)
    && value.replace(/^v/, "").split(".").every((part) => Number.isSafeInteger(Number(part)));
  return Boolean(release && release.draft !== true && release.prerelease !== true
    && valid(release.tag_name) && valid(installed));
}

export const latestReleaseUrl = `${(import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api"}/admin/releases/latest`;
export const latestReleaseTimeoutMs = 6_000;
type CheckedRelease = Release & { checkedAt?: number; attemptedAt?: number };
type Discovery = { release?: Release; checkedAt?: number; attemptedAt?: number; retryAt?: number; fresh?: boolean; code?: string; error?: string };

export async function fetchLatestRelease(
  fetcher: typeof fetch = fetch,
  timeoutMs = latestReleaseTimeoutMs,
): Promise<CheckedRelease> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(latestReleaseUrl, {
      headers: { accept: "application/json" }, credentials: "include", cache: "no-store",
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({})) as Discovery;
    if (!response.ok || result.fresh !== true || !result.release || typeof result.checkedAt !== "number") {
      throw new ReleaseCheckError(discoveryMessage(result.code), response, result);
    }
    return { ...result.release, checkedAt: result.checkedAt, attemptedAt: result.attemptedAt };
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

// The old direct-browser cache cannot confirm same-origin discovery or block it.
export const releaseCacheKey = "lancerlogin-release-cache-v2";
export const releaseCacheTtlMs = 15 * 60_000;
export type ReleaseSnapshot = { release?: Release; checkedAt?: number; attemptedAt?: number; retryAt?: number; error?: string; code?: string; checking: boolean; fresh: boolean };
type Stored = { release?: Release; checkedAt?: number; attemptedAt?: number; retryAt?: number; failures: number; error?: string; code?: string };
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
  constructor(message: string, response: Response, discovery?: Discovery) { super(message); this.response = response; this.discovery = discovery; }
}
function safeRelease(value: unknown): Release | undefined {
  if (!value || typeof value !== "object") return;
  const release = value as Release;
  if (!hasComparableStableVersions(release, "0.0.0") || [release.draft, release.prerelease].some((flag) => flag !== undefined && typeof flag !== "boolean")) return;
  const result: Release = { tag_name: release.tag_name };
  // Never turn persisted or provider-controlled metadata into an unsafe link.
  if (typeof release.html_url === "string") {
    try { const url = new URL(release.html_url); if (url.protocol === "https:" && !url.username && !url.password) result.html_url = url.href; } catch { /* Notes are optional. */ }
  }
  return result;
}
export function createReleaseCache({ load = () => fetchLatestRelease(), now = Date.now, storage = () => globalThis.localStorage }: {
  load?: () => Promise<CheckedRelease>; now?: () => number; storage?: () => Pick<Storage, "getItem" | "setItem">;
} = {}) {
  let data: Stored = { failures: 0 };
  let inFlight: Promise<Release> | undefined;
  const listeners = new Set<() => void>();
  const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
  let lastSaved: string | null | undefined;
  function sync() {
    try {
      const raw = storage().getItem(releaseCacheKey);
      if (raw === lastSaved) return;
      lastSaved = raw;
      if (raw) {
        const saved = JSON.parse(raw) as Stored;
        if (saved && typeof saved === "object" && Number.isInteger(saved.failures) && saved.failures >= 0 && saved.failures <= 10
          && [saved.checkedAt, saved.attemptedAt, saved.retryAt].every((value) => value === undefined || timestamp(value))
          && (saved.failures === 0 ? saved.retryAt === undefined : Boolean(saved.attemptedAt && saved.retryAt))
          && (!saved.checkedAt || saved.checkedAt <= now()) && (!saved.attemptedAt || saved.attemptedAt <= now())) {
          const release = safeRelease(saved.release);
          data = { failures: saved.failures, attemptedAt: saved.attemptedAt, retryAt: saved.retryAt,
            ...(release && saved.checkedAt ? { release, checkedAt: saved.checkedAt } : {}),
            ...(saved.failures ? { code: saved.code, error: discoveryMessage(saved.code) } : {}) };
        }
      }
    } catch { /* In-memory checks work when storage is unavailable or malformed. */ }
  }
  sync();
  const snapshot = (): ReleaseSnapshot => ({ ...data, checking: Boolean(inFlight), fresh: Boolean(data.release && data.checkedAt && now() >= data.checkedAt && now() - data.checkedAt < releaseCacheTtlMs && !data.error) });
  function publish() { for (const listener of listeners) listener(); }
  function persist() { try { const raw = JSON.stringify(data); storage().setItem(releaseCacheKey, raw); lastSaved = raw; } catch { /* Storage is optional. */ } }
  function check(force = false): Promise<Release> {
    if (inFlight) return inFlight;
    sync();
    if (data.retryAt && now() < data.retryAt) return Promise.reject(new Error(data.error ?? "Latest release is temporarily unavailable."));
    if (!force && snapshot().fresh) return Promise.resolve(data.release!);
    data.attemptedAt = now();
    const request = Promise.resolve().then(load).then((value) => {
      const release = safeRelease(value);
      if (!release) throw new Error("A compatible stable release could not be confirmed.");
      const receivedAt = now();
      const serverCheckedAt = value.checkedAt ?? receivedAt;
      // Independent browser and server clocks can differ slightly. Clamp a small
      // future timestamp to receipt time so it cannot extend the cache lifetime.
      if (!timestamp(serverCheckedAt) || serverCheckedAt - receivedAt > 60_000 || receivedAt - serverCheckedAt >= releaseCacheTtlMs) throw new Error("A compatible stable release could not be confirmed.");
      const checkedAt = Math.min(serverCheckedAt, receivedAt);
      const attemptedAt = timestamp(value.attemptedAt) && value.attemptedAt - receivedAt <= 60_000
        ? Math.min(value.attemptedAt, receivedAt) : data.attemptedAt;
      data = { release, checkedAt, attemptedAt, failures: 0 };
      persist(); return release;
    }).catch((error: unknown) => {
      const failures = Math.min(data.failures + 1, 10);
      let retryAt = now() + Math.min(30_000 * 2 ** (failures - 1), releaseCacheTtlMs);
      if (error instanceof ReleaseCheckError && [403, 429].includes(error.response.status)) {
        const headers = error.response.headers;
        const after = headers.get("retry-after");
        const delay = after && /^\d+$/.test(after.trim()) ? now() + Number(after) * 1000 : after ? Date.parse(after) : NaN;
        if (Number.isSafeInteger(delay) && delay > now()) retryAt = Math.max(retryAt, delay);
        const reset = Number(headers.get("x-ratelimit-reset")) * 1000;
        if (headers.get("x-ratelimit-remaining") === "0" && Number.isSafeInteger(reset) && reset > now()) retryAt = Math.max(retryAt, reset);
      }
      const discovery = error instanceof ReleaseCheckError ? error.discovery : undefined;
      if (timestamp(discovery?.retryAt) && discovery!.retryAt! > now()) retryAt = discovery!.retryAt!;
      data = { ...data, failures, retryAt, code: discovery?.code, error: error instanceof Error ? error.message : "Latest release is temporarily unavailable." };
      // Preserve the server's last successful check separately from its failed attempt.
      if (discovery && timestamp(discovery.attemptedAt) && discovery.attemptedAt <= now()) data.attemptedAt = discovery.attemptedAt;
      const previousRelease = safeRelease(discovery?.release);
      if (previousRelease && timestamp(discovery?.checkedAt) && discovery!.checkedAt! <= now()) {
        data.release = previousRelease; data.checkedAt = discovery!.checkedAt;
      }
      persist(); throw error;
    });
    const tracked = request.finally(() => { inFlight = undefined; publish(); });
    inFlight = tracked; publish(); return tracked;
  }
  return { check, snapshot, sync, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
export const releaseCache = createReleaseCache();

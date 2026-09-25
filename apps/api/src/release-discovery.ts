import { officialWebRelease } from "./web-updates.ts";

export const officialReleaseUrl = "https://api.github.com/repos/isriah/LancerLogin/releases/latest";
export const discoveryTtlMs = 15 * 60_000;
export type DiscoveryRelease = { tag_name: string; html_url: string; draft: false; prerelease: false };
export type DiscoveryCode = "rate_limited" | "timeout" | "network" | "provider_unavailable" | "invalid_release";
export type DiscoverySnapshot = {
  release?: DiscoveryRelease; checkedAt?: number; attemptedAt?: number; retryAt?: number;
  error?: string; code?: DiscoveryCode; fresh: boolean;
};
export type ReleaseCredential = { WEB_UPDATE_TOKEN?: string; WEB_UPDATE_TOKEN_EXPIRES_AT?: string };
const messages: Record<DiscoveryCode, string> = {
  rate_limited: "GitHub release discovery is rate limited.",
  timeout: "Latest release check timed out.",
  network: "The server could not reach GitHub release discovery.",
  provider_unavailable: "Latest release is temporarily unavailable.",
  invalid_release: "A complete stable official release could not be confirmed.",
};

export function releaseRequestHeaders(credential?: ReleaseCredential, now = Date.now()): Headers {
  const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "LancerLogin", "x-github-api-version": "2026-03-10" });
  const expiry = Date.parse(credential?.WEB_UPDATE_TOKEN_EXPIRES_AT ?? "");
  if (credential?.WEB_UPDATE_TOKEN && Number.isFinite(expiry) && expiry > now) headers.set("authorization", `Bearer ${credential.WEB_UPDATE_TOKEN}`);
  return headers;
}

// One fixed public feed with optional fixed Worker credentials and no browser-selected URLs.
// Cache/coalescing is bounded to this Worker isolate, not a global provider lock.
export function createReleaseDiscovery({ fetcher = fetch, now = Date.now, timeoutMs = 4_000 }: {
  fetcher?: typeof fetch; now?: () => number; timeoutMs?: number;
} = {}) {
  let data: DiscoverySnapshot = { fresh: false };
  let failures = 0;
  let inFlight: Promise<DiscoverySnapshot> | undefined;
  const snapshot = (): DiscoverySnapshot => ({ ...data, fresh: Boolean(data.release && data.checkedAt !== undefined
    && now() >= data.checkedAt && now() - data.checkedAt < discoveryTtlMs && !data.error) });
  function fail(code: DiscoveryCode, response?: Response) {
    failures = Math.min(failures + 1, 6);
    let retryAt = now() + Math.max(code === "rate_limited" ? 60_000 : 30_000, Math.min(30_000 * 2 ** (failures - 1), discoveryTtlMs));
    if (response) {
      const after = response.headers.get("retry-after");
      const delay = after && /^\d+$/.test(after.trim()) ? now() + Number(after) * 1000 : after ? Date.parse(after) : NaN;
      if (Number.isSafeInteger(delay) && delay > now()) retryAt = Math.max(retryAt, delay);
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isSafeInteger(reset) && reset > now()) retryAt = Math.max(retryAt, reset);
    }
    data = { ...data, fresh: false, code, error: messages[code], retryAt };
    return snapshot();
  }
  async function load(credential?: ReleaseCredential) {
    data.attemptedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fetcher(officialReleaseUrl, { headers: releaseRequestHeaders(credential, now()), redirect: "manual", signal: controller.signal, cache: "no-store" });
      if (!result.ok) {
        const limited = result.status === 429 || result.status === 403 && (result.headers.has("retry-after") || result.headers.get("x-ratelimit-remaining") === "0");
        return fail(limited ? "rate_limited" : "provider_unavailable", result);
      }
      const release = officialWebRelease(await result.json().catch(() => undefined));
      if (!release || !release.tag.slice(1).split(".").every((part) => Number.isSafeInteger(Number(part)))) return fail("invalid_release");
      data = { release: { tag_name: release.tag, html_url: `https://github.com/isriah/LancerLogin/releases/tag/${release.tag}`, draft: false, prerelease: false }, checkedAt: now(), attemptedAt: data.attemptedAt, fresh: true };
      failures = 0;
      return snapshot();
    } catch {
      return fail(controller.signal.aborted ? "timeout" : "network");
    } finally { clearTimeout(timer); }
  }
  function check(credential?: ReleaseCredential): Promise<DiscoverySnapshot> {
    if (inFlight) return inFlight;
    if (snapshot().fresh || data.retryAt && now() < data.retryAt) return Promise.resolve(snapshot());
    const tracked = load(credential).finally(() => { inFlight = undefined; });
    inFlight = tracked;
    return tracked;
  }
  return { check, snapshot };
}
export const releaseDiscovery = createReleaseDiscovery({ fetcher: (...args) => fetch(...args) });

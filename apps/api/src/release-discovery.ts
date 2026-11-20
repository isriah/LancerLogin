import { completeOfficialRelease, newestOfficialRelease, type UpdateChannel, type OfficialRelease } from "../../../packages/shared/src/release-policy.mjs";
import { credentialRejected, credentialUsable, observeCredentialResponse } from "./github-credential.ts";
import { HttpError } from "./http-error.ts";

export const officialReleaseUrl = "https://api.github.com/repos/isriah/LancerLogin/releases/latest";
export const discoveryTtlMs = 15 * 60_000;
export const discoveryMaximumRetryMs = 60 * 60_000;
/** A manual "Check for updates" reaches GitHub at most this often per isolate, and only with the web-update credential. */
export const discoveryForcedFloorMs = 60_000;
export type DiscoveryRelease = { tag_name: string; html_url: string; body: string; draft: false; prerelease: boolean };
export type DiscoveryCode = "rate_limited" | "timeout" | "network" | "provider_unavailable" | "invalid_release";
export type DiscoverySnapshot = {
  release?: DiscoveryRelease; checkedAt?: number; attemptedAt?: number; retryAt?: number;
  error?: string; code?: DiscoveryCode; fresh: boolean;
  /** With `invalid_release`: GitHub's answer could not be read at all, so it says nothing about which releases exist. */
  unreadable?: boolean;
  /** How long ago, by this server's clock, GitHub last answered successfully. A duration, so browsers never compare clocks. */
  checkedAgeMs?: number;
};
export type ReleaseCredential = { WEB_UPDATE_TOKEN?: string; WEB_UPDATE_TOKEN_EXPIRES_AT?: string };
const messages: Record<DiscoveryCode, string> = {
  rate_limited: "GitHub release discovery is rate limited.",
  timeout: "Latest release check timed out.",
  network: "The server could not reach GitHub release discovery.",
  provider_unavailable: "Latest release is temporarily unavailable.",
  invalid_release: "A complete official release on the selected track could not be confirmed.",
};

// Stable stays on GitHub Latest. Beta considers stable and beta releases by SemVer,
// not publication date. A truncated feed cannot prove a newest release, so fail closed.
// `unreadable` is called when a successful answer was not a readable, complete feed, as opposed to a feed that was
// read and holds no qualifying release.
export async function resolveOfficialRelease(channel: UpdateChannel, get: (path: string) => Promise<Response>, unreadable?: () => void): Promise<OfficialRelease | undefined> {
  if (channel === "stable") {
    const response = await get("/repos/isriah/LancerLogin/releases/latest");
    if (!response.ok) return;
    const value: unknown = await response.json().catch(() => undefined);
    if (!value || typeof value !== "object" || Array.isArray(value)) { unreadable?.(); return; }
    return completeOfficialRelease(value);
  }
  const releases: unknown[] = [];
  for (let page = 1; page <= 5; page++) {
    const response = await get(`/repos/isriah/LancerLogin/releases?per_page=100&page=${page}`);
    if (!response.ok) return;
    const values: unknown = await response.json().catch(() => undefined);
    if (!Array.isArray(values)) { unreadable?.(); return; }
    releases.push(...values);
    if (values.length < 100) return newestOfficialRelease(releases, channel);
  }
  unreadable?.();
}

/**
 * Official releases are public, so the optional dispatch credential only raises GitHub's rate limit. It is sent while it
 * is unexpired (or has no expiry) and GitHub has not rejected it; otherwise discovery reads the feed anonymously.
 */
export function releaseRequestHeaders(credential?: ReleaseCredential, now = Date.now()): Headers {
  const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "LancerLogin", "x-github-api-version": "2026-03-10" });
  const token = credential?.WEB_UPDATE_TOKEN;
  if (credentialUsable("dispatch", token, credential?.WEB_UPDATE_TOKEN_EXPIRES_AT, now) && !credentialRejected("dispatch", token)) headers.set("authorization", `Bearer ${token}`);
  return headers;
}
/** A fetch of the fixed public feed that falls back to an anonymous request when GitHub rejects the credential. */
export async function fetchReleaseFeed(fetcher: typeof fetch, url: string, init: RequestInit & { headers: Headers }, credential?: ReleaseCredential): Promise<Response> {
  const result = await fetcher(url, init);
  const token = credential?.WEB_UPDATE_TOKEN;
  if (!token || init.headers.get("authorization") !== `Bearer ${token}`) return result;
  observeCredentialResponse("dispatch", token, result);
  if (result.status !== 401) return result;
  const headers = new Headers(init.headers); headers.delete("authorization");
  return fetcher(url, { ...init, headers });
}
/** GitHub's primary and secondary rate limits: 429, or 403 with Retry-After or an exhausted quota. */
function rateLimitedResponse(result: Response) {
  return result.status === 429 || result.status === 403 && (result.headers.has("retry-after") || result.headers.get("x-ratelimit-remaining") === "0");
}
/** When GitHub says a failed request may be repeated (Retry-After or the rate-limit reset), at most an hour ahead. */
function providerRetryTime(response: Response, now: number): number | undefined {
  let retryAt: number | undefined;
  const after = response.headers.get("retry-after");
  const delay = after && /^\d+$/.test(after.trim()) ? now + Number(after) * 1000 : after ? Date.parse(after) : NaN;
  if (Number.isSafeInteger(delay) && delay > now) retryAt = Math.min(delay, now + discoveryMaximumRetryMs);
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isSafeInteger(reset) && reset > now) retryAt = Math.max(retryAt ?? 0, Math.min(reset, now + discoveryMaximumRetryMs));
  return retryAt;
}

// One fixed public feed with optional fixed Worker credentials and no browser-selected URLs.
// Cache/coalescing is bounded to this Worker isolate, not a global provider lock.
export function createReleaseDiscovery({ fetcher = fetch, now = Date.now, timeoutMs = 4_000, channel = "stable" }: {
  fetcher?: typeof fetch; now?: () => number; timeoutMs?: number;
  channel?: UpdateChannel;
} = {}) {
  let data: DiscoverySnapshot = { fresh: false };
  let failures = 0;
  let inFlight: Promise<DiscoverySnapshot> | undefined;
  // GitHub's own Retry-After or rate-limit reset from the last failure. Unlike local backoff, a forced check never skips it.
  let providerRetryAt: number | undefined;
  const snapshot = (): DiscoverySnapshot => ({ ...data, fresh: Boolean(data.release && data.checkedAt !== undefined
    && now() >= data.checkedAt && now() - data.checkedAt < discoveryTtlMs && !data.error),
    ...(data.checkedAt !== undefined ? { checkedAgeMs: Math.max(0, now() - data.checkedAt) } : {}) });
  const authenticated = (credential?: ReleaseCredential) => releaseRequestHeaders(credential, now()).has("authorization");
  const refreshAt = () => Math.max(data.attemptedAt === undefined ? 0 : data.attemptedAt + discoveryForcedFloorMs, providerRetryAt ?? 0);
  function fail(code: DiscoveryCode, response?: Response, unreadable = false) {
    failures = Math.min(failures + 1, 6);
    let retryAt = now() + Math.max(code === "rate_limited" ? 60_000 : 30_000, Math.min(30_000 * 2 ** (failures - 1), discoveryTtlMs));
    providerRetryAt = response ? providerRetryTime(response, now()) : undefined;
    if (providerRetryAt !== undefined) retryAt = Math.max(retryAt, providerRetryAt);
    retryAt = Math.min(retryAt, now() + discoveryMaximumRetryMs);
    const { unreadable: _previous, ...kept } = data;
    data = { ...kept, fresh: false, code, error: messages[code], retryAt, ...(unreadable ? { unreadable } : {}) };
    return snapshot();
  }
  async function load(credential?: ReleaseCredential) {
    data.attemptedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let failure: DiscoverySnapshot | undefined; let unreadable = false;
      const release = await resolveOfficialRelease(channel, async (path) => {
        const result = await fetchReleaseFeed(fetcher, `https://api.github.com${path}`, { headers: releaseRequestHeaders(credential, now()), redirect: "manual", signal: controller.signal, cache: "no-store" }, credential);
        if (!result.ok) failure = fail(rateLimitedResponse(result) ? "rate_limited" : "provider_unavailable", result);
        return result;
      }, () => { unreadable = true; });
      if (failure) return failure;
      if (!release) return fail("invalid_release", undefined, unreadable);
      data = { release: { tag_name: release.tag, html_url: `https://github.com/isriah/LancerLogin/releases/tag/${release.tag}`, body: release.notes, draft: false, prerelease: release.prerelease }, checkedAt: now(), attemptedAt: data.attemptedAt, fresh: true };
      failures = 0; providerRetryAt = undefined;
      return snapshot();
    } catch {
      return fail(controller.signal.aborted ? "timeout" : "network");
    } finally { clearTimeout(timer); }
  }
  /**
   * Automatic checks reuse a fresh answer for 15 minutes and wait out failure backoff. A forced check (an Admin pressing
   * Check for updates) skips both, but only when the web-update credential would be sent, at most once per
   * discoveryForcedFloorMs, and never before GitHub's own Retry-After or rate-limit reset. Anonymous reads share the
   * Cloudflare egress IP's 60 requests an hour, so without the credential a forced check behaves like an automatic one.
   */
  function check(credential?: ReleaseCredential, { force = false }: { force?: boolean } = {}): Promise<DiscoverySnapshot> {
    if (inFlight) return inFlight;
    const wait = force && authenticated(credential) ? now() < refreshAt() : snapshot().fresh || Boolean(data.retryAt && now() < data.retryAt);
    if (wait) return Promise.resolve(snapshot());
    const tracked = load(credential).finally(() => { inFlight = undefined; });
    inFlight = tracked;
    return tracked;
  }
  /** When a forced check could next reach GitHub, or undefined when forcing is unavailable because the credential would not be sent. */
  function forcedRefreshAt(credential?: ReleaseCredential) { return authenticated(credential) ? refreshAt() : undefined; }
  /** Forgets everything this isolate learned. For tests that share the module-level discoveries. */
  function reset() { data = { fresh: false }; failures = 0; inFlight = undefined; providerRetryAt = undefined; }
  return { check, snapshot, forcedRefreshAt, reset };
}
export const releaseDiscovery = createReleaseDiscovery({ fetcher: (...args) => fetch(...args) });
export const betaReleaseDiscovery = createReleaseDiscovery({ channel: "beta", fetcher: (...args) => fetch(...args) });
export function discoveryForChannel(channel: UpdateChannel) { return channel === "beta" ? betaReleaseDiscovery : releaseDiscovery; }

export type KioskReleaseCode = "kiosk_release_rate_limited" | "kiosk_release_timeout" | "kiosk_release_unreachable" | "kiosk_release_github_error" | "kiosk_release_unreadable" | "kiosk_release_none";
type KioskReleaseFailure = DiscoveryCode | "unreadable";
const kioskReleaseCodes: Record<KioskReleaseFailure, KioskReleaseCode> = {
  rate_limited: "kiosk_release_rate_limited", timeout: "kiosk_release_timeout", network: "kiosk_release_unreachable",
  provider_unavailable: "kiosk_release_github_error", unreadable: "kiosk_release_unreadable", invalid_release: "kiosk_release_none",
};
/**
 * Why an Admin's Update kiosk could not be pinned to a release. Every case is a 503 with its own stable `code`, and says
 * what happened and what to do. Only `kiosk_release_none` says no release exists: the feed was read and none qualified.
 */
export function kioskReleaseError(failure: KioskReleaseFailure, { channel, retryAt, now, authenticated }: { channel: UpdateChannel; retryAt?: number; now: number; authenticated: boolean }): HttpError {
  const seconds = retryAt !== undefined && retryAt > now ? Math.ceil((retryAt - now) / 1000) : undefined;
  const minutes = seconds === undefined ? undefined : Math.ceil(seconds / 60);
  const again = `Try again ${minutes === undefined ? "in a few minutes" : minutes === 1 ? "in about a minute" : `in about ${minutes} minutes`}.`;
  const notStarted = "so the kiosk update was not started. Nothing is wrong with the kiosk.";
  const message = failure === "rate_limited" ? `GitHub is limiting release checks right now, ${notStarted} ${again}${authenticated ? "" : " Setting up or refreshing the optional web update token (Settings > Updates) signs this server's release checks, which avoids this shared limit."}`
    : failure === "timeout" ? `GitHub did not answer the release check in time, ${notStarted} ${again}`
    : failure === "network" ? `This server could not reach GitHub to check the release, ${notStarted} ${again}`
    : failure === "provider_unavailable" ? `GitHub returned an error for the release check, ${notStarted} ${again}`
    : failure === "unreadable" ? `GitHub's answer to the release check could not be read, ${notStarted} ${again}`
    : `GitHub's release list was read, but it has no complete official kiosk release on the ${channel === "beta" ? "Beta" : "Stable"} track, so there is nothing to install yet.`;
  return new HttpError(503, message, undefined, kioskReleaseCodes[failure], seconds === undefined || failure === "invalid_release" ? undefined : { retryAfterSeconds: seconds });
}

/**
 * Pins the release and exact commit for a kiosk update. The release comes from the cached discovery, so an update started
 * while the dashboard's answer is fresh (15 minutes) reads no feed; a stale or failed discovery is never acted on. A
 * published release is immutable, so its tag's commit is remembered for the isolate's lifetime. Cold, this makes the same
 * GitHub requests as before (the feed, then /commits/<tag>); warm, none. Each request has its own timeout.
 */
export function createKioskReleaseLookup({ discovery = discoveryForChannel, fetcher = fetch, now = Date.now, timeoutMs = 4_000 }: {
  discovery?: (channel: UpdateChannel) => Pick<ReturnType<typeof createReleaseDiscovery>, "check">; fetcher?: typeof fetch; now?: () => number; timeoutMs?: number;
} = {}) {
  const commits = new Map<string, string>();
  // GitHub's own reset time from a rate-limited commit read; no commit is requested before it.
  let commitRetryAt = 0;
  const authenticated = (credential?: ReleaseCredential) => releaseRequestHeaders(credential, now()).has("authorization");
  async function commit(tag: string, channel: UpdateChannel, credential?: ReleaseCredential): Promise<string> {
    const known = commits.get(tag);
    if (known) return known;
    if (now() < commitRetryAt) throw kioskReleaseError("rate_limited", { channel, retryAt: commitRetryAt, now: now(), authenticated: authenticated(credential) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let failure: KioskReleaseFailure; let retryAt: number | undefined;
    try {
      const result = await fetchReleaseFeed(fetcher, `https://api.github.com/repos/isriah/LancerLogin/commits/${tag}`, { headers: releaseRequestHeaders(credential, now()), redirect: "manual", signal: controller.signal, cache: "no-store" }, credential);
      if (result.ok) {
        const value = await result.json().catch(() => undefined) as { sha?: unknown } | undefined;
        if (typeof value?.sha === "string" && /^[0-9a-f]{40}$/.test(value.sha)) {
          if (commits.size >= 16) commits.clear();
          commits.set(tag, value.sha);
          return value.sha;
        }
        failure = controller.signal.aborted ? "timeout" : "unreadable";
      } else if (rateLimitedResponse(result)) {
        failure = "rate_limited"; retryAt = commitRetryAt = providerRetryTime(result, now()) ?? now() + 60_000;
      } else failure = "provider_unavailable";
    } catch { failure = controller.signal.aborted ? "timeout" : "network"; }
    finally { clearTimeout(timer); }
    throw kioskReleaseError(failure, { channel, retryAt, now: now(), authenticated: authenticated(credential) });
  }
  async function lookup(credential: ReleaseCredential | undefined, channel: UpdateChannel): Promise<OfficialRelease & { sha: string }> {
    const found = await discovery(channel).check(credential);
    if (!found.fresh || !found.release) throw kioskReleaseError(found.code === "invalid_release" && found.unreadable ? "unreadable" : found.code ?? "provider_unavailable", { channel, retryAt: found.retryAt, now: now(), authenticated: authenticated(credential) });
    const sha = await commit(found.release.tag_name, channel, credential);
    return { tag: found.release.tag_name, notes: found.release.body, prerelease: found.release.prerelease, sha };
  }
  /** Forgets remembered commits and GitHub's reset time. For tests that share the module-level lookup. */
  function reset() { commits.clear(); commitRetryAt = 0; }
  return { lookup, reset };
}
export const kioskReleaseLookup = createKioskReleaseLookup({ fetcher: (...args) => fetch(...args) });
/** Clears the module-level release caches, so a test starts as a new Worker isolate would. */
export function resetReleaseCaches() { releaseDiscovery.reset(); betaReleaseDiscovery.reset(); kioskReleaseLookup.reset(); }

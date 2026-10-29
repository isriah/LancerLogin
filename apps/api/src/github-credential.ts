/**
 * Readiness of the optional GitHub credentials stored as Worker secrets: WEB_UPDATE_TOKEN dispatches dashboard updates and
 * MODULE_SELECTION_TOKEN commits the plugin selection. Provisioning writes each *_EXPIRES_AT secret from GitHub's
 * GitHub-Authentication-Token-Expiration header and leaves it absent for a token without an expiry.
 *
 * The Worker also remembers, per isolate and per token, the expiry GitHub reports on its own calls and whether GitHub last
 * rejected the token. Changing a Worker secret starts new isolates, so this memory never outlives the token it describes.
 * It refines what the dashboard shows and the minimum-validity checks; nothing is stored in D1.
 */
export type CredentialKind = "dispatch" | "selection";
export type CredentialState = "missing" | "ready" | "expiring" | "expired" | "rejected";
export type CredentialStatus = { state: CredentialState; expiresAt: string | null };
/** Admins are warned this long before a credential expires. */
export const credentialWarningWindowMs = 14 * 24 * 60 * 60_000;
export const expirationHeader = "github-authentication-token-expiration";

type Observation = { token: string; expiry?: number | null; rejected?: boolean };
const observations = new Map<CredentialKind, Observation>();
function observation(kind: CredentialKind, token: string): Observation {
  const current = observations.get(kind);
  if (current?.token === token) return current;
  const fresh: Observation = { token };
  observations.set(kind, fresh);
  return fresh;
}
/** Test hook: forget what earlier GitHub responses reported. */
export function resetCredentialObservations(): void { observations.clear(); }

/** GitHub sends "2026-11-29 12:00:00 UTC" or "2026-11-29 12:00:00 -0700". */
export function parseGitHubExpiration(value: string | null | undefined): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const zone = match[3] === "UTC" || match[3] === "Z" ? "Z" : `${match[3]!.slice(0, 3)}:${match[3]!.slice(-2)}`;
  const parsed = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Record what GitHub said about the token on a response to a request that carried it. */
export function observeCredentialResponse(kind: CredentialKind, token: string, response: Response): void {
  const seen = observation(kind, token);
  if (response.status === 401) { seen.rejected = true; return; }
  if (response.status >= 200 && response.status < 300) seen.rejected = false;
  const expiry = parseGitHubExpiration(response.headers.get(expirationHeader));
  if (expiry !== undefined) seen.expiry = expiry;
}

/**
 * The token's expiry: a number, null when it does not expire, or NaN when the configured value is unreadable (fail closed).
 * An expiry GitHub reported for this token takes precedence over the configured one.
 */
export function credentialExpiry(kind: CredentialKind, token: string, configured: string | undefined): number | null {
  const seen = observations.get(kind);
  if (seen?.token === token && typeof seen.expiry === "number") return seen.expiry;
  if (configured === undefined || configured.trim() === "") return null;
  return Date.parse(configured);
}

export function credentialRejected(kind: CredentialKind, token: string): boolean {
  const seen = observations.get(kind);
  return seen?.token === token && seen.rejected === true;
}

/** True when the token exists and has not expired, or has no expiry. */
export function credentialUsable(kind: CredentialKind, token: string | undefined, configured: string | undefined, now = Date.now()): token is string {
  if (!token) return false;
  const expiry = credentialExpiry(kind, token, configured);
  return expiry === null || Number.isFinite(expiry) && expiry > now;
}

export function credentialStatus(kind: CredentialKind, token: string | undefined, configured: string | undefined, now = Date.now()): CredentialStatus {
  if (!token) return { state: "missing", expiresAt: null };
  const expiry = credentialExpiry(kind, token, configured);
  const expiresAt = typeof expiry === "number" && Number.isFinite(expiry) ? new Date(expiry).toISOString() : null;
  if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) return { state: "expired", expiresAt };
  if (credentialRejected(kind, token)) return { state: "rejected", expiresAt };
  if (expiry !== null && expiry - now < credentialWarningWindowMs) return { state: "expiring", expiresAt };
  return { state: "ready", expiresAt };
}

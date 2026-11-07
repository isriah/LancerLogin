import { HttpError } from "./http-error.ts";

/**
 * Discord rate limiting, labelled by the Core feature whose request Discord refused. Module requests go through
 * `services.discord.client()` and are labelled "requests", so a module names its own feature from `providerStatus` 429.
 * The message is stored and shown again later (operation errors, module `last_error` columns), so it names no exact
 * countdown that would be wrong by the time anyone reads it; `retryAfterMs` carries Discord's delay for callers that wait.
 */
export class DiscordRateLimitError extends HttpError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, operation = "requests") { super(503, discordRateLimitMessage(retryAfterMs, operation)); this.retryAfterMs = retryAfterMs; }
}

export function discordRateLimitMessage(retryAfterMs: number, operation = "requests"): string {
  return `Discord is rate limiting ${operation}. ${discordRetryHint(retryAfterMs)}`;
}

/** A coarse, still-true-later hint instead of an exact number of seconds that freezes once the message is stored. */
export function discordRetryHint(retryAfterMs: number): string {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 15_000) return "Try again in a few seconds.";
  if (retryAfterMs <= 90_000) return "Try again in about a minute.";
  return `Try again in about ${Math.ceil(retryAfterMs / 60_000)} minutes.`;
}

/** The Core feature a Discord API path belongs to, for the rate-limit message. */
export function discordRateLimitOperation(path: string): string {
  if (path.includes("/members/") && path.includes("/roles/") || /\/members(?:\?|$)/.test(path)) return "role sync";
  if (path.includes("/commands")) return "command setup";
  if (path.includes("/scheduled-events")) return "calendar sync";
  return "requests";
}

/** Role sync and member listing fail fast so their jobs reschedule; other requests wait out a short delay in place. */
export function discordRateLimitFailsFast(path: string, retryAfterMs: number): boolean {
  return path.includes("/members/") && path.includes("/roles/") || path.includes("/members?") || retryAfterMs > 2_000;
}

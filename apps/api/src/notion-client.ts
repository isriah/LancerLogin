// Core's Notion API client: one request, no retries. Moved from the Part Requests plugin, whose client was tested live.
// Traps it records, all kept here: `fetch` must not be stored and called as a method on Workers; `redirect: "error"`
// throws a TypeError there, so redirects are "manual" and treated as failures; and a create that Notion did not confirm
// may still have happened, so it is reported as uncertain and never sent again automatically.
//
// Error messages are fixed text chosen by status. Nothing Notion sends back is copied into a message, and the token is
// only ever placed in the Authorization header.
import { HttpError } from "./http-error.ts";

export const notionVersion = "2026-03-11";
export const notionApiOrigin = "https://api.notion.com";
export const notionTimeoutMs = 20_000;
/** The longest wait a Retry-After is trusted for, so one odd header cannot stop Notion for a day. */
export const notionMaximumRetryAfterMs = 10 * 60_000;
/** The wait assumed after a rate limit that named none. */
export const notionDefaultRetryAfterMs = 1_000;

export type NotionJson = Record<string, any>;
export type NotionMethod = "GET" | "POST" | "PATCH";
export type NotionRequest = {
  readonly path: string;
  readonly method?: NotionMethod;
  readonly body?: unknown;
  /** A request that creates something. A failure that leaves the outcome unknown is then marked uncertain. */
  readonly creates?: boolean;
};

/**
 * A Notion request that failed, or one Core refused before sending. `code` is stable: `notion_<status>` for an answer
 * from Notion, `notion_network` when no answer arrived, `notion_response` for an answer that could not be read, and a
 * named code for each refusal. The HTTP status is what a module route that does not catch it answers with.
 */
export class NotionError extends HttpError {
  /** Notion's HTTP status, or undefined when Notion did not answer or Core refused the call. */
  readonly providerStatus: number | undefined;
  /** True when Notion may have done the work anyway. An uncertain create is never sent again automatically. */
  readonly uncertain: boolean;
  /** How long Notion asked callers to wait, after a rate limit. */
  readonly retryAfterMs: number | undefined;
  declare readonly code: string;
  constructor(message: string, code: string, options: { readonly status?: number; readonly providerStatus?: number; readonly uncertain?: boolean; readonly retryAfterMs?: number } = {}) {
    super(options.status ?? 502, message, undefined, code);
    this.name = "NotionError";
    this.providerStatus = options.providerStatus; this.uncertain = options.uncertain === true; this.retryAfterMs = options.retryAfterMs;
  }
}

const statusMessage = (status: number) => status === 401 ? "The Notion token is invalid or expired. An Admin needs to replace it."
  : status === 403 ? "The Notion connection lacks permission. Check its content and user capabilities."
  : status === 404 ? "Notion cannot access that database or page. Add the connection to the database and check its link."
  : status === 429 ? "Notion is rate limiting requests. Wait a moment before trying again."
  : status === 400 ? "Notion rejected the request. Check the fields, or ask an Admin to check the connection."
  : status === 409 ? "Notion reported a conflict. Check the database before trying again."
  : "Notion did not confirm the operation. Check the database before trying again.";

/** Milliseconds from a Retry-After header in seconds, or undefined when it names no usable wait. */
export function notionRetryAfterMs(header: string | null): number | undefined {
  const seconds = header === null || header.trim() === "" ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds * 1_000), notionMaximumRetryAfterMs) : undefined;
}

const supportedPath = /^\/(?:databases|data_sources|pages|users|comments)(?:\/|\?|$)/;

/**
 * Send one request to the Notion API and return its JSON. Throws a NotionError for anything else. `fetcher` is called
 * as a plain function. Nothing is retried: the caller decides, knowing whether the failure was uncertain.
 */
export async function notionRequest(fetcher: typeof fetch, token: string, request: NotionRequest): Promise<NotionJson> {
  if (!supportedPath.test(request.path) || request.path.includes("..")) throw new NotionError("Unsupported Notion operation.", "notion_unsupported", { status: 500 });
  const creates = request.creates === true;
  let response: Response;
  try {
    response = await fetcher(`${notionApiOrigin}/v1${request.path}`, {
      method: request.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": notionVersion, "Content-Type": "application/json" },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: "manual", signal: AbortSignal.timeout(notionTimeoutMs),
    });
  } catch {
    throw new NotionError("Could not confirm the Notion response.", "notion_network", { uncertain: creates });
  }
  if (!response.ok) {
    const status = response.status;
    // Drain the body so the connection is released; its text is never used.
    try { await response.body?.cancel(); } catch { /* Nothing to release. */ }
    const retryAfterMs = status === 429 ? notionRetryAfterMs(response.headers.get("retry-after")) ?? notionDefaultRetryAfterMs : undefined;
    // A redirect (manual, so 3xx or an opaque status 0), a server error or a conflict leaves a create's outcome unknown.
    throw new NotionError(statusMessage(status), `notion_${status}`, { status: status === 429 ? 429 : 502, providerStatus: status, uncertain: creates && (status >= 500 || status === 409 || status < 400), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }
  let body: unknown;
  try { body = await response.json(); } catch { body = undefined; }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new NotionError("Notion returned an unreadable response.", "notion_response", { providerStatus: response.status, uncertain: creates });
  return body as NotionJson;
}

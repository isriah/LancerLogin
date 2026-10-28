export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** A non-OK API response. `status` lets callers tell a signed-out session (401) from a transient failure. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "ApiError"; this.status = status; }
}

/** True for failures worth retrying silently: no response at all, rate limiting, or a server-side error. */
export function transientApiFailure(error: unknown) {
  return !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await result.json().catch(() => ({})) as T & { error?: string; details?: string[] };
  if (!result.ok) throw new ApiError(body.details?.join(" ") ?? body.error ?? "Request failed", result.status);
  return body;
}

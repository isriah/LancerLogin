export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await result.json().catch(() => ({})) as T & { error?: string; details?: string[] };
  if (!result.ok) throw new Error(body.details?.join(" ") ?? body.error ?? "Request failed");
  return body;
}

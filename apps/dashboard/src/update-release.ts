export type Release = { tag_name?: string; html_url?: string };

export const latestReleaseUrl = "https://api.github.com/repos/isriah/LancerLogin/releases/latest";
export const latestReleaseTimeoutMs = 4_000;

export async function fetchLatestRelease(
  fetcher: typeof fetch = fetch,
  timeoutMs = latestReleaseTimeoutMs,
): Promise<Release> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(latestReleaseUrl, {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Latest release is temporarily unavailable.");
    return await response.json() as Release;
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

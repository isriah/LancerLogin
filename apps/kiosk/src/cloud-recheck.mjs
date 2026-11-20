import { normalizeApiUrl } from "./cloud-client.mjs";

/** How often an offline Discord code kiosk asks whether the server answers again. The full heartbeat keeps its own interval. */
export const cloudRecheckMs = 15_000;

/**
 * Whether the Worker answers: one unauthenticated GET of its /health, which reads no data. Anything else that answers
 * on the way (a captive portal, a proxy error page) is not the Worker, so it does not count.
 */
export async function workerReachable(config, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/health`, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => undefined);
    return response.ok && body?.service === "lancerlogin-api";
  } catch { return false; }
}

/**
 * The light check between heartbeats. While `wanted()` holds (a Discord code kiosk that lost the cloud), each tick asks
 * only `reachable()`. The full `heartbeat()` runs once when the answer turns from no to yes; it then decides whether the
 * kiosk is online. A server that answers the check while the heartbeat keeps failing is therefore not sent a heartbeat
 * every tick: the next one waits for the normal interval, or for the server to be lost and found again.
 */
export function createCloudRecheck({ wanted, reachable, heartbeat }) {
  let checking = false, answered = false;
  return {
    async tick() {
      if (!wanted()) { answered = false; return; }
      if (checking) return;
      checking = true;
      try {
        let now = false;
        try { now = await reachable() === true; } catch { /* No answer. */ }
        const returned = now && !answered;
        answered = now;
        if (returned && wanted()) await heartbeat();
      } finally { checking = false; }
    },
  };
}

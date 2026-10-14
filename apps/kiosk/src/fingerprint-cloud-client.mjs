import { normalizeApiUrl } from "./cloud-client.mjs";

export function createFingerprintCloudClient(config, { fetchImpl = fetch } = {}) {
  const base = normalizeApiUrl(config.apiUrl);
  const identifier = value => {
    if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error("Invalid fingerprint delivery identifier");
    return value;
  };
  async function request(path, method = "GET", value) {
    let response;
    try {
      response = await fetchImpl(`${base}/kiosk/fingerprint-sync${path}`, { method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${config.kioskToken}`, ...(value === undefined ? {} : { "content-type": "application/json" }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error("Fingerprint relay request was not accepted");
        error.status = response.status; throw error;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response");
      let size = 0; const chunks = [];
      try {
        while (true) {
          const { done, value: chunk } = await reader.read(); if (done) break;
          size += chunk.byteLength;
          if (size > 65536) throw new Error("Oversized response");
          chunks.push(chunk);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (cause) {
      // Do not surface response bodies, URLs, credentials or template payloads.
      const error = new Error("Fingerprint relay is unavailable; saved deliveries will retry");
      if (Number.isInteger(cause?.status)) error.status = cause.status;
      throw error;
    }
  }
  return {
    configuration: () => request(""),
    register: identity => request("/identity", "PUT", identity),
    revoke: () => request("/identity", "DELETE"),
    peers: () => request("/peers"),
    pending: after => request(`/deliveries${after === undefined ? "" : `?after=${encodeURIComponent(identifier(after))}`}`),
    send: envelope => request("/deliveries", "POST", envelope),
    status: transferId => request(`/deliveries/${identifier(transferId)}`),
    acknowledge: (transferId, result) => request(`/deliveries/${identifier(transferId)}/result`, "POST", { status: result.status, digest: result.digest }),
  };
}

import { normalizeApiUrl } from "./cloud-client.mjs";

export function createFingerprintRequester(config, prefix, { fetchImpl = fetch, maximumResponseBytes = 32768 } = {}) {
  const base = normalizeApiUrl(config.apiUrl);
  async function request(path, method = "GET", value) {
    let response, bytes;
    try {
      response = await fetchImpl(`${base}${prefix}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${config.kioskToken}`, ...(value === undefined ? {} : { "content-type": "application/json" }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      if (!response.ok) {
        const error = new Error("Fingerprint cloud storage did not accept the request"); error.status = response.status; throw error;
      }
      const reader = response.body?.getReader(); if (!reader) throw new Error("Missing response");
      let size = 0; const chunks = [];
      try {
        while (true) {
          const { done, value: chunk } = await reader.read(); if (done) break;
          size += chunk.byteLength; if (size > maximumResponseBytes) { chunk.fill(0); throw new Error("Oversized response"); } chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks); return JSON.parse(bytes.toString("utf8"));
      } finally { for (const chunk of chunks) chunk.fill(0); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch (cause) {
      const error = new Error("Fingerprint cloud storage is unavailable; synchronization will retry");
      if (Number.isInteger(cause?.status)) error.status = cause.status;
      throw error;
    } finally { bytes?.fill(0); await response?.body?.cancel().catch(() => undefined); }
  }
  return request;
}

export function createFingerprintVaultClient(config, options = {}) {
  const request = createFingerprintRequester(config, "/kiosk/fingerprint-vault", options);
  const identifier = value => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid fingerprint vault identifier");
    return value;
  };
  return {
    configuration: () => request(""),
    store: enrollment => request("/templates", "POST", enrollment),
    list: after => request(`/templates${after === undefined ? "" : `?after=${identifier(after)}`}`),
    template: fingerprintId => request(`/templates/${identifier(fingerprintId)}`),
  };
}

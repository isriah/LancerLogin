const normalizeApiUrl = (value) => {
  const url = new URL(String(value));
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("The Worker API URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
};

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `LancerLogin API returned ${response.status}`);
  return body;
}

export async function pairInstallation({ apiUrl, code, kioskName, fetchImpl = fetch }) {
  const endpoint = normalizeApiUrl(apiUrl);
  if (!String(code).trim() || !String(kioskName).trim()) throw new Error("Pairing code and kiosk name are required");
  const response = await fetchImpl(`${endpoint}/kiosk/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: String(code).trim().toUpperCase(), kioskName: String(kioskName).trim() }),
  });
  const paired = await parseResponse(response);
  if (!paired.kioskId || !paired.kioskToken) throw new Error("The pairing response did not include kiosk credentials");
  return { apiUrl: endpoint, kioskId: paired.kioskId, kioskToken: paired.kioskToken, kioskName: paired.name ?? kioskName, pairedAt: new Date().toISOString() };
}

export async function sendHeartbeat(config, { readerOnline = false, releaseVersion = "development", fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ readerOnline: Boolean(readerOnline), releaseVersion }),
  });
  return parseResponse(response);
}

export { normalizeApiUrl };

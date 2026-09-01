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

export async function sendHeartbeat(config, { readerOnline = false, releaseVersion = "development", pendingEvents = 0, lastSyncAt = null, errorCategory = null, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ readerOnline: Boolean(readerOnline), releaseVersion, pendingEvents, lastSyncAt, errorCategory }),
  });
  return parseResponse(response);
}

export async function fetchKioskConfiguration(config, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/config`, { headers: { authorization: `Bearer ${config.kioskToken}` } });
  return parseResponse(response);
}

export async function sendAttendance(config, event, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/attendance`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ eventId: event.eventId, memberId: event.memberId, ...(event.meetingId ? { meetingId: event.meetingId } : {}), occurredAt: event.occurredAt }),
  });
  if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 403) {
    const body = await response.json().catch(() => ({}));
    return { accepted: false, rejected: true, error: body.error ?? "The scan was not accepted" };
  }
  return parseResponse(response);
}

export { normalizeApiUrl };

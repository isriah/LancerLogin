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

export async function sendHeartbeat(config, { readerOnline = false, releaseVersion = "development", uptimeSeconds = 0, networkType = "offline", networkSignal = null, lastWifiScanAt = null, pendingEvents = 0, lastSyncAt = null, errorCategory = null, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ readerOnline: Boolean(readerOnline), releaseVersion, uptimeSeconds, networkType, networkSignal, lastWifiScanAt, pendingEvents, lastSyncAt, errorCategory }),
  });
  return parseResponse(response);
}

export async function fetchKioskConfiguration(config, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/config`, { headers: { authorization: `Bearer ${config.kioskToken}` } });
  return parseResponse(response);
}

export async function fetchKioskRoster(config, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/roster`, { headers: { authorization: `Bearer ${config.kioskToken}` } });
  return parseResponse(response);
}

export async function fetchKioskCommand(config, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/commands`, { headers: { authorization: `Bearer ${config.kioskToken}` } });
  return parseResponse(response);
}

export async function completeKioskCommand(config, commandId, result, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/commands/${encodeURIComponent(commandId)}/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ success: Boolean(result.success), message: String(result.message || "").slice(0, 200) }),
  });
  return parseResponse(response);
}

export async function sendAttendance(config, event, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/attendance`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ eventId: event.eventId, memberId: event.memberId, ...(event.meetingId ? { meetingId: event.meetingId } : {}), occurredAt: event.occurredAt }),
  });
  if (response.status >= 400 && response.status < 500 && ![401, 403, 408, 425, 429].includes(response.status)) {
    const body = await response.json().catch(() => ({}));
    const error = typeof body.error === "string" ? body.error : "The scan was not accepted";
    const code = response.status === 404 && /not linked to an active roster member/i.test(error) ? "roster_inactive"
      : response.status === 409 && /No meeting is accepting/i.test(error) ? "no_eligible_meeting"
      : response.status === 409 && /already complete/i.test(error) ? "attendance_complete"
      : response.status === 409 && /begins on/i.test(error) ? "participation_not_started"
      : response.status === 400 ? "invalid_scan" : `http_${response.status}`;
    return { accepted: false, rejected: true, status: response.status, code, error };
  }
  const result = await parseResponse(response);
  if (result?.eventId !== event.eventId || (result.accepted !== true && result.duplicate !== true)) throw new Error("The attendance response did not confirm this scan");
  return result;
}

export { normalizeApiUrl };

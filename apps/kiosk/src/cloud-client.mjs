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
  if (!paired.kioskId || !paired.kioskToken || !paired.pairingId) throw new Error("The pairing response did not include kiosk credentials");
  return { apiUrl: endpoint, kioskId: paired.kioskId, kioskToken: paired.kioskToken, pairingId: paired.pairingId, kioskName: paired.name ?? kioskName, pairedAt: new Date().toISOString() };
}

export async function sendHeartbeat(config, { readerOnline = false, authenticationMethod, releaseVersion = "development", uptimeSeconds = 0, networkType = "offline", networkSignal = null, lastWifiScanAt = null, pendingEvents = 0, lastSyncAt = null, errorCategory = null, updatePolicyVersion, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    // The Worker records a missing policy as 1 and rejects unknown values, so send only a recognized installed-helper policy.
    body: JSON.stringify({ readerOnline: Boolean(readerOnline), ...(authenticationMethod ? { authenticationMethod } : {}), releaseVersion, uptimeSeconds, networkType, networkSignal, lastWifiScanAt, pendingEvents, lastSyncAt, errorCategory, ...(updatePolicyVersion === 1 || updatePolicyVersion === 2 ? { updatePolicyVersion } : {}) }),
  });
  return parseResponse(response);
}

export async function sendScanReviews(config, records, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/scan-reviews`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ records }),
  });
  try { return await parseResponse(response); }
  catch (error) { error.status = response.status; throw error; }
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

export async function fetchKioskEnrollment(config, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/enrollment`, { headers: { authorization: `Bearer ${config.kioskToken}` } });
  if ([404, 405].includes(response.status)) { await response.body?.cancel(); return null; }
  const value = await parseResponse(response);
  if (!Object.hasOwn(value, "enrollment")) throw new Error("Dashboard enrollment authority is unavailable.");
  return value.enrollment;
}

export async function sendKioskEnrollmentProgress(config, sessionId, progress, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/enrollment/${encodeURIComponent(sessionId)}/progress`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` }, body: JSON.stringify(progress),
  });
  const value = await parseResponse(response);
  if (!Object.hasOwn(value, "session")) throw new Error("Dashboard enrollment progress was not confirmed.");
  return value.session;
}

// Reasons the API uses to reject a scan on its merits. Only these stop delivery;
// the scan is then retained locally for review. Anything else (a bare 404 from a
// misrouted deploy or proxy, 405, 410, 413, an HTML error page) is treated as
// transient, so the scan stays queued and is retried with backoff.
export const permanentScanRejections = new Set(["roster_inactive", "no_eligible_meeting", "attendance_complete", "participation_not_started", "pairing_mismatch", "scan_window_closed", "invalid_scan"]);

// Older APIs send no code. Recognize only their exact semantic messages.
function legacyRejectionCode(status, error) {
  if (status === 404 && /(?:fingerprint|identity) is not linked to an active roster member/i.test(error)) return "roster_inactive";
  if (status === 409 && /No meeting is accepting/i.test(error)) return "no_eligible_meeting";
  if (status === 409 && /already complete/i.test(error)) return "attendance_complete";
  if (status === 409 && /begins on/i.test(error)) return "participation_not_started";
  if (status === 409 && /different kiosk pairing/i.test(error)) return "pairing_mismatch";
  if (status === 409 && /(?:meeting has not started|Attendance is closed for this meeting)/i.test(error)) return "scan_window_closed";
  if (status === 400 && /eventId, memberId, and a valid occurredAt timestamp are required/i.test(error)) return "invalid_scan";
  return undefined;
}

export class TransientDeliveryError extends Error {
  constructor(status, message) { super(message || `LancerLogin API returned ${status}; the scan stays queued`); this.status = status; this.transient = true; }
}

// Unexpected HTTP rejections (not plain connectivity loss) pause replay with
// capped exponential backoff so a misrouted API is not hammered by every scan.
export function createDeliveryBackoff({ now = Date.now, baseMs = 30_000, maxMs = 15 * 60_000 } = {}) {
  let failures = 0, until = 0;
  return {
    blocked: () => now() < until,
    retryAt: () => until > now() ? until : null,
    succeeded() { failures = 0; until = 0; },
    failed(error) {
      if (!error?.transient) return;
      failures = Math.min(failures + 1, 32);
      until = now() + Math.min(maxMs, baseMs * 2 ** (failures - 1));
    },
  };
}

export async function sendAttendance(config, event, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${normalizeApiUrl(config.apiUrl)}/kiosk/attendance`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.kioskToken}` },
    body: JSON.stringify({ eventId: event.eventId, memberId: event.memberId, ...(event.meetingId ? { meetingId: event.meetingId } : {}), occurredAt: event.occurredAt, ...(event.pairingId ? { pairingId: event.pairingId } : {}) }),
  });
  if (response.status >= 400 && response.status < 500) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = /^application\/json(?:\s*;|\s*$)/i.test(contentType) ? await response.json().catch(() => ({})) : (await response.body?.cancel(), {});
    const error = typeof body?.error === "string" ? body.error.slice(0, 300) : "";
    const code = typeof body?.code === "string" && permanentScanRejections.has(body.code) ? body.code : legacyRejectionCode(response.status, error);
    if (code) return { accepted: false, rejected: true, status: response.status, code, error };
    throw new TransientDeliveryError(response.status, error);
  }
  const result = await parseResponse(response);
  if (result?.eventId !== event.eventId || (result.accepted !== true && result.duplicate !== true)) throw new Error("The attendance response did not confirm this scan");
  return result;
}

export { normalizeApiUrl };

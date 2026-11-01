// The web kiosk's calls to the LancerLogin API. It uses the same API base as the dashboard but never the dashboard's
// cookies: every call omits credentials and sends the kiosk's own bearer token.

export type KioskSettings = {
  organizationName?: string; subtitle?: string; logoData?: string; primaryColor?: string; secondaryColor?: string; logoBackdrop?: string;
  authenticationMethod?: string; kind?: "pi" | "web"; memberLookup?: "entry" | "search";
  /** Members enter a PIN after Confirm (phase 3); the roster then carries each member's PIN hash. */
  requirePin?: boolean; pinLockout?: { enabled?: boolean; attempts?: number; minutes?: number };
};
export type KioskConfig = { kiosk: { id: string; name: string }; settings: KioskSettings | null };
/** A member's PIN as the roster carries it to a Require PIN kiosk: a PBKDF2-SHA256 hash, never the PIN. */
export type MemberPinHash = { hash: string; salt: string; iterations: number };
/** `pin` and `pinLockedUntil` come only to a kiosk with Require PIN; `pin` is null for a member with no PIN yet. */
export type RosterMember = { rosterId?: string; memberId: string; firstName: string; lastName: string; email?: string; pin?: MemberPinHash | null; pinLockedUntil?: string | null };
export type PairingResult = { kioskId: string; kioskToken: string; pairingId: string; name: string; kind?: "pi" | "web" };
export type KioskCommand = { id: string; type: string; createdAt?: string };
export type AttendanceResult = { accepted?: boolean; duplicate?: boolean; eventId?: string; action?: "check_in" | "check_out"; meeting?: { id: string; title: string }; member?: { id: string; externalId?: string; displayName?: string } };
/** `pin` goes only with a scan sent straight away; a scan queued after the cached hash matched says `pinCheck: "offline"`. */
export type AttendanceScan = { eventId: string; memberId: string; occurredAt: string; pairingId: string; rescanSupported: true; pin?: string; pinCheck?: "offline" };
export type Heartbeat = { readerOnline: true; authenticationMethod: "member_id"; releaseVersion: string; pendingEvents: number; lastSyncAt?: string };
export type HeartbeatReply = { ok?: boolean; kioskId?: string; receivedAt?: string };
/** A refused scan as `POST /kiosk/scan-reviews` takes it: the same evidence a Pi kiosk uploads. */
export type ScanReviewRecord = { eventId: string; memberId: string; occurredAt: string; pairingId?: string; reasonCode: string; httpStatus: number | null; reviewStatus: "open" | "reviewed" };
export type ScanReviewAcknowledgement = { eventId: string; reviewStatus: "open" | "reviewed" };
export type PinRequestStatus = "pending" | "approved" | "declined" | "used" | "expired";
export type PinRequest = { id: string; status: PinRequestStatus; expiresAt: string };
/** Wrong PIN tries made offline, reported on sync (`POST /kiosk/pin-failures`). */
export type PinFailureReport = { memberId: string; count: number; lastAt: string };

/**
 * What became of one attempt to send a scan:
 * - `accepted`: recorded, or already recorded under the same event ID (`result.duplicate`);
 * - `rejected`: refused on its merits, a 4xx answer with a JSON error body such as "no meeting is accepting scans".
 *   Sending it again can't change that;
 * - `rescan`: refused because the member scanned on another kiosk moments apart; nothing to record or review;
 * - `credential`: the kiosk's credential was refused (401), so the kiosk needs pairing again;
 * - `unreachable`: no answer (a network error or timeout); `retry`: an answer that doesn't settle the scan, such as a
 *   5xx, a 429 or a proxy's error page. Both keep the scan queued.
 */
export type SendOutcome =
  | { kind: "accepted"; result: AttendanceResult }
  | { kind: "rejected"; status: number; code?: string; message: string; lockedUntil?: string; attemptsLeft?: number }
  | { kind: "rescan"; status: number; code: string; message: string }
  | { kind: "credential" }
  | { kind: "unreachable" }
  | { kind: "retry"; status: number };

/** The API answered with an error status. `code` is the API's machine-readable reason, when it gives one. */
export class KioskApiError extends Error {
  readonly status: number; readonly code?: string; readonly lockedUntil?: string;
  constructor(message: string, status: number, code?: string, lockedUntil?: string) { super(message); this.name = "KioskApiError"; this.status = status; this.code = code; if (lockedUntil) this.lockedUntil = lockedUntil; }
}
/** No answer at all: the network or the server couldn't be reached. */
export class KioskNetworkError extends Error {
  constructor(message = "Couldn't reach the server.") { super(message); this.name = "KioskNetworkError"; }
}

export type KioskApiOptions = { baseUrl: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

/** How long the kiosk waits for an answer before treating the server as unreachable. */
export const requestTimeoutMs = 8_000;

/** Sends one request. A network failure, or no answer within the timeout, is a KioskNetworkError. */
async function send(options: KioskApiOptions, path: string, init: RequestInit = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (init.body) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller?.abort(); reject(new KioskNetworkError("The server didn't answer in time.")); }, options.timeoutMs ?? requestTimeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(`${options.baseUrl}${path}`, { method: init.method ?? "GET", body: init.body, headers, credentials: "omit", cache: "no-store", signal: controller?.signal }), timeout]);
  } catch (error) { throw error instanceof KioskNetworkError ? error : new KioskNetworkError(); }
  finally { clearTimeout(timer); }
}

async function call<T>(options: KioskApiOptions, path: string, init: RequestInit & { allowNotModified?: boolean } = {}): Promise<{ body: T; status: number; headers: Headers }> {
  const reply = await send(options, path, init);
  if (reply.status === 304 && init.allowNotModified) return { body: undefined as T, status: 304, headers: reply.headers };
  const body = await reply.json().catch(() => ({})) as T & { error?: string; details?: string[]; code?: string; lockedUntil?: unknown };
  if (!reply.ok) throw new KioskApiError(body.details?.join(" ") || body.error || "Request failed", reply.status, body.code, lockedUntilFrom(body.lockedUntil));
  return { body, status: reply.status, headers: reply.headers };
}

const json = (value: unknown) => JSON.stringify(value);

const jsonContent = (reply: Response) => /^application\/json(?:\s*;|\s*$)/i.test(reply.headers.get("content-type") ?? "");
/** Answers that never settle a scan, whatever their body says: the server or a proxy is busy or timed out. */
const retryStatuses = new Set([408, 425, 429]);
/** The Worker's code for a member who scanned on another kiosk moments apart: the member just scans again. */
const rescanCodes = new Set(["possible_wrong_match"]);
/** A wrong PIN is a 403 with this code. Only a 401 without a code is a refused credential. */
const wrongPinCode = "pin_incorrect";
function lockedUntilFrom(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined; }

/** Sends one scan and says what became of it. It never throws: every answer, or no answer, is a SendOutcome. */
export async function deliverScan(options: KioskApiOptions, scan: AttendanceScan): Promise<SendOutcome> {
  let reply: Response;
  try { reply = await send(options, "/kiosk/attendance", { method: "POST", body: json(scan) }); }
  catch { return { kind: "unreachable" }; }
  let body: (AttendanceResult & { error?: unknown; code?: unknown; lockedUntil?: unknown; attemptsLeft?: unknown }) | undefined;
  if (jsonContent(reply)) body = await reply.json().catch(() => undefined);
  else await reply.body?.cancel().catch(() => undefined);
  if (reply.status === 401 && !(body && typeof body === "object" && body.code === wrongPinCode)) return { kind: "credential" };
  if (reply.ok) {
    // Only an answer about this scan settles it; anything else (a proxy's page, another event's answer) is retried.
    const settles = body && typeof body === "object" && (body.eventId === undefined || body.eventId === scan.eventId) && (body.accepted === true || body.duplicate === true);
    return settles ? { kind: "accepted", result: { ...body, eventId: scan.eventId } } : { kind: "retry", status: reply.status };
  }
  if (reply.status >= 400 && reply.status < 500 && !retryStatuses.has(reply.status) && body && typeof body === "object" && (typeof body.error === "string" || typeof body.code === "string")) {
    const code = typeof body.code === "string" && body.code ? body.code : undefined;
    const message = typeof body.error === "string" ? body.error.slice(0, 300) : "";
    if (code && rescanCodes.has(code)) return { kind: "rescan", status: reply.status, code, message };
    const lockedUntil = lockedUntilFrom(body.lockedUntil);
    const attemptsLeft = Number.isInteger(body.attemptsLeft) && Number(body.attemptsLeft) >= 0 ? Number(body.attemptsLeft) : undefined;
    return { kind: "rejected", status: reply.status, ...(code ? { code } : {}), message, ...(lockedUntil ? { lockedUntil } : {}), ...(attemptsLeft !== undefined ? { attemptsLeft } : {}) };
  }
  return { kind: "retry", status: reply.status };
}

/** Redeem a one-time web pairing code. No token: the code alone pairs the device. */
export async function pairWebKiosk(options: KioskApiOptions, code: string) {
  return (await call<PairingResult>({ ...options, token: undefined }, "/kiosk/pair", { method: "POST", body: json({ code }) })).body;
}

export function createKioskApi(options: KioskApiOptions & { token: string }) {
  return {
    async config() { return (await call<KioskConfig>(options, "/kiosk/config")).body; },
    /** The active roster; `undefined` members when the server says the cached copy (matching `etag`) is current. */
    async roster(etag?: string) {
      const reply = await call<{ members: RosterMember[] }>(options, "/kiosk/roster", { headers: etag ? { "if-none-match": etag } : {}, allowNotModified: true });
      return { members: reply.status === 304 ? undefined : reply.body.members ?? [], etag: reply.headers.get("etag") ?? etag };
    },
    async command() { return (await call<{ command: KioskCommand | null }>(options, "/kiosk/commands")).body.command; },
    async completeCommand(id: string, result: { success: boolean; message?: string }) {
      await call(options, `/kiosk/commands/${encodeURIComponent(id)}/result`, { method: "POST", body: json(result) });
    },
    /** Reports that this kiosk is running and how many scans wait in its queue. The reply carries the server's time. */
    async heartbeat(releaseVersion: string, pendingEvents = 0, lastSyncAt?: string) {
      const body: Heartbeat = { readerOnline: true, authenticationMethod: "member_id", releaseVersion, pendingEvents, ...(lastSyncAt ? { lastSyncAt } : {}) };
      return (await call<HeartbeatReply>(options, "/kiosk/heartbeat", { method: "POST", body: json(body) })).body;
    },
    async attendance(scan: AttendanceScan) { return (await call<AttendanceResult>(options, "/kiosk/attendance", { method: "POST", body: json(scan) })).body; },
    /** Sends a scan and classifies the answer, without throwing; the offline queue uses this. */
    deliver(scan: AttendanceScan) { return deliverScan(options, scan); },
    /** Uploads refused scans for review on the dashboard; the reply says which ones the server now holds. */
    async scanReviews(records: ScanReviewRecord[]) {
      const body = (await call<{ reviews?: ScanReviewAcknowledgement[] }>(options, "/kiosk/scan-reviews", { method: "POST", body: json({ records }) })).body;
      return Array.isArray(body.reviews) ? body.reviews : [];
    },
    /** Reports wrong PIN tries made offline; the server adds them to each member's count. */
    async pinFailures(failures: PinFailureReport[]) {
      return (await call<{ recorded?: number }>(options, "/kiosk/pin-failures", { method: "POST", body: json({ failures }) })).body;
    },
    /** Asks an Operator to approve a PIN for a member with none: a new request, or the one already waiting. */
    async requestPin(memberId: string) { return (await call<{ request: PinRequest }>(options, "/kiosk/pin-requests", { method: "POST", body: json({ memberId }) })).body.request; },
    async pinRequest(id: string) { return (await call<{ request: PinRequest }>(options, `/kiosk/pin-requests/${encodeURIComponent(id)}`)).body.request; },
    /** Sets the member's PIN under an approved request. */
    async choosePin(id: string, pin: string) { return (await call<{ request: PinRequest }>(options, `/kiosk/pin-requests/${encodeURIComponent(id)}/pin`, { method: "POST", body: json({ pin }) })).body.request; },
    /** Maintenance: sets a PIN for a member with none (an Operator opened maintenance with the settings PIN). */
    async setMemberPin(memberId: string, pin: string) { return (await call<{ pin: { set: boolean; setAt: string } }>(options, "/kiosk/pins", { method: "POST", body: json({ memberId, pin }) })).body.pin; },
    /** Maintenance: removes the member's PIN; false when they had none. */
    async resetMemberPin(memberId: string) { return (await call<{ reset?: boolean }>(options, `/kiosk/pins/${encodeURIComponent(memberId)}/reset`, { method: "POST" })).body.reset === true; },
  };
}
export type KioskApi = ReturnType<typeof createKioskApi>;

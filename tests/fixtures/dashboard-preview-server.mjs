import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { defaultModuleSnapshot } from "./default-module-snapshot.mjs";

const port = Number(process.env.LANCERLOGIN_MOCK_PORT ?? 8787);
// Browser-side password hashing: the dashboard asks for the account's salt before it computes K and signs in.
const passwordParamsPaths = new Set(["/auth/local/params", "/admin/plugins/reauthenticate/params"]);
const previewPasswordParams = { algorithm: "scrypt", N: 32768, r: 8, p: 1, dkLen: 32, salt: "AQEBAQEBAQEBAQEBAQEBAQ", legacy: false };
const now = Date.now();
const iso = (offsetMinutes) => new Date(now + offsetMinutes * 60_000).toISOString();
const logo = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="80" y="82" fill="white" font-size="72" font-family="sans-serif" font-weight="700">NOVA</text></svg>').toString("base64")}`;
const meetings = [
  { id: "past-regular", title: "Completed build session", startsAt: iso(-4 * 24 * 60), endsAt: iso(-4 * 24 * 60 + 120), attendanceClosesAt: iso(-4 * 24 * 60 + 150), required: 1, isTest: 0 },
  { id: "past-optional", title: "Completed open workshop", startsAt: iso(-3 * 24 * 60), endsAt: iso(-3 * 24 * 60 + 120), attendanceClosesAt: iso(-3 * 24 * 60 + 150), required: 0, isTest: 0 },
  { id: "past-test", title: "Completed test session", startsAt: iso(-2 * 24 * 60), endsAt: iso(-2 * 24 * 60 + 120), attendanceClosesAt: iso(-2 * 24 * 60 + 150), required: 1, isTest: 1 },
  { id: "active-meeting", title: "Build session", startsAt: iso(-30), endsAt: iso(60), attendanceClosesAt: iso(90), required: 1, isTest: 0, notes: "Bring safety glasses.", seriesId: "weekly-build", recurrenceFrequency: "weekly", recurrenceUntil: iso(28 * 24 * 60), recurrenceSequence: 2 },
  { id: "next-week", title: "Studio night", startsAt: iso(7 * 24 * 60), endsAt: iso(7 * 24 * 60 + 120), attendanceClosesAt: iso(7 * 24 * 60 + 150), required: 1, isTest: 0 },
];
const members = [
  { id: "member-1", memberId: "A-101", firstName: "Avery", lastName: "Stone", email: "avery@example.org", discordUserId: "123456789012", active: 1, hasDashboardAccess: true },
  { id: "member-2", memberId: "A-102", firstName: "Morgan", lastName: "Diaz", email: "morgan@example.org", active: 1, hasDashboardAccess: false },
];
const labels = [{ id: "mentor", name: "Mentor", active: 1, formulaEnabled: 1 }];
const labelData = { labels, history: [], periods: [], today: new Date().toISOString().slice(0, 10) };
const completedMeetings = meetings.slice(0, 2).map((meeting) => ({ ...meeting, attendanceWeight: 1, audienceMode: "all", audienceLabelIds: [] }));
const report = { meetings: completedMeetings, members: members.map((member, index) => ({ member, currentLabelIds: [], rows: completedMeetings.map((meeting) => ({ meetingId: meeting.id, memberId: member.id, disposition: index ? "absent" : "present", eligibility: meeting.required ? "required" : "optional", policy: "standard", rateEligible: Boolean(meeting.required), regularEligible: Boolean(meeting.required), attended: !index, weight: 1, regularWeight: 1, audience: "All", memberLabelIds: [] })), regularAttendance: { rate: index ? 0 : 100, attended: index ? 0 : 1, required: 1, from: member.attendanceRequiredFrom ?? member.createdAt?.slice(0, 10) ?? null, to: new Date().toISOString().slice(0, 10) }, currentCompliances: [], currentCompliance: { labelId: null, labelName: null, ruleId: null, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, from: new Date(now - 29 * 24 * 60 * 60_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), rate: null, unadjustedRate: null, attended: 0, required: 0 }, historySummaries: [], policy: "standard", present: index ? 0 : 1, primaryTotal: 1, adjustedTotal: 1, rate: index ? 0 : 100, adjustedRate: index ? 0 : 100, pooledRate: null, weeks: [], belowTargetWeeks: [] })), labels, baseline: null, timeZone: "UTC" };
const reportColumns = [
  { key: "core.member.identity", label: "Member record ID", group: "Roster", sortable: true, filterKind: "text" },
  { key: "core.member.name", label: "Member", group: "Roster", sortable: true, filterKind: "text" },
  { key: "core.member.id", label: "Member ID", group: "Roster", sortable: true, filterKind: "text" },
  { key: "core.member.email", label: "Email", group: "Roster", sortable: true, filterKind: "text" },
  { key: "attendance.member.regular-rate", label: "Overall rate", group: "Overall attendance", sortable: true, filterKind: "number" },
  { key: "attendance.member.assigned-policies", label: "Last 30 days: policy results (all labels)", group: "Attendance policies (per label)", sortable: false, filterKind: "text" },
  { key: "attendance.detail.absent-dates", label: "Absent dates", group: "Meetings by outcome", sortable: false, filterKind: "text" },
].map((column) => ({ ...column, datasets: ["attendance.members"] }));
const attendanceDataset = {
  id: "attendance.members", label: "Members - Attendance", description: "Member-level Attendance measures with Community roster fields.", available: true,
  rowIdentity: "core.member.identity", capability: "attendance.manage",
  fields: reportColumns.map((column) => ({ id: column.key, label: column.label, group: column.group, kind: column.filterKind === "number" ? "measure" : "dimension", valueType: column.filterKind, sortable: column.sortable, filterOperators: [column.filterKind === "number" ? "minimum" : "contains"] })),
  filters: ["period", "roster", "meeting-type", "labels", "membership"], groupBy: ["core.member.identity"],
  defaultColumns: ["core.member.name", "attendance.member.regular-rate", "attendance.member.assigned-policies"], defaultSort: { field: "core.member.name", direction: "asc" }, relationships: [],
};
const defaultReportDefinition = { version: 2, dataset: "attendance.members", groupBy: ["core.member.identity"], period: { type: "all" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: attendanceDataset.defaultColumns.map((key) => ({ key })), columnFilters: [], sort: { column: { key: "core.member.name" }, direction: "asc" } };
const leaderboardReport = { ...report, pagination: { page: 1, pageSize: 25, totalRows: report.members.length, totalPages: 1, rangeStart: 1, rangeEnd: report.members.length }, insights: { policyAlerts: [], trend: completedMeetings.filter((meeting) => meeting.required).map((meeting) => ({ meetingId: meeting.id, title: meeting.title, startsAt: meeting.startsAt, rate: 50 })) } };
const customReport = { definition: defaultReportDefinition, warnings: [], resolvedPeriod: { to: new Date().toISOString().slice(0, 10) }, columns: [{ id: "core.member.name", key: "core.member.name", label: "Member" }, { id: "attendance.member.regular-rate", key: "attendance.member.regular-rate", label: "Overall rate" }, { id: "attendance.member.assigned-policies", key: "attendance.member.assigned-policies", label: "Last 30 days: policy results (all labels)" }], rows: report.members.map((item) => ({ id: item.member.id, label: `${item.member.firstName} ${item.member.lastName}`, href: `/roster/${item.member.memberId}`, cells: { "core.member.name": { text: `${item.member.firstName} ${item.member.lastName}`, sortValue: item.member.lastName }, "attendance.member.regular-rate": { text: `${item.regularAttendance.rate}%`, sortValue: item.regularAttendance.rate }, "attendance.member.assigned-policies": { text: "No assigned policy", sortValue: null } } })), pagination: { page: 1, pageSize: 25, totalRows: report.members.length, totalPages: 1, rangeStart: 1, rangeEnd: report.members.length } };
const memberDetail = (member) => ({ member, labels, labelHistory: [], attendancePolicy: report.members.find((item) => item.member.id === member.id), history: [{ meetingId: "past-regular", title: "Completed build session", startsAt: meetings[0].startsAt, endsAt: meetings[0].endsAt, checkedInAt: iso(-4 * 24 * 60 + 5), checkedOutAt: iso(-4 * 24 * 60 + 115), disposition: "present", eligibility: "required", audience: "All", policy: "standard" }] });
// Kiosk management state for the web kiosk contract. Each browser test sends its own x-preview-scenario header so parallel
// tests never share kiosks; requests without one use a "default" scenario holding only the Pi kiosk below.
const pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const kioskScenarios = new Map();
const seedKiosks = (scenario) => scenario === "default"
  ? [{ id: "kiosk-1", name: "Front desk", kind: "pi", memberLookup: "entry", requirePin: false, active: 1, lastSeenAt: iso(0), readerOnline: 1, releaseVersion: "0.8.0", pairedAt: iso(-1440) }]
  : [
    { id: "kiosk-1", name: "Front desk", kind: "pi", active: 1, seenMinutesAgo: 0, readerOnline: 1, configuredAuthenticationMethod: "fingerprint", authenticationMethod: "fingerprint", memberLookup: "entry", requirePin: false, releaseVersion: "0.8.0", pairedAt: iso(-1440) },
    { id: "web-kiosk-a", name: "Test web kiosk A", kind: "web", active: 1, seenMinutesAgo: 0, readerOnline: 1, configuredAuthenticationMethod: "member_id", authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, releaseVersion: "0.8.0", pendingEvents: 0, pairedAt: iso(-720) },
    { id: "web-kiosk-b", name: "Test web kiosk B", kind: "web", active: 1, seenMinutesAgo: 45, readerOnline: 1, configuredAuthenticationMethod: "member_id", authenticationMethod: "member_id", memberLookup: "search", requirePin: false, releaseVersion: "0.8.0", pendingEvents: 0, pairedAt: iso(-2880) },
    // A Debug kiosk from browser OLD1 that stopped checking in, for Debug tools > Open web kiosk on this device.
    ...(scenario.startsWith("kiosk-debug-") ? [{ id: "debug-kiosk-old1", name: "Debug kiosk OLD1", kind: "web", active: 1, seenMinutesAgo: 60, readerOnline: 1, configuredAuthenticationMethod: "member_id", authenticationMethod: "member_id", memberLookup: "entry", requirePin: false, releaseVersion: "0.8.0", pendingEvents: 0, pairedAt: iso(-1440) }] : []),
  ];
function kioskScenario(request) {
  const id = String(request.headers["x-preview-scenario"] ?? "default");
  if (!kioskScenarios.has(id)) kioskScenarios.set(id, { kiosks: seedKiosks(id), pairingCodes: [], commands: [], ...seedPins() });
  return kioskScenarios.get(id);
}
// seenMinutesAgo keeps a seeded kiosk online (or stale) however long the server has run; the default kiosk keeps its fixed time.
const listedKiosk = ({ seenMinutesAgo, ...kiosk }) => seenMinutesAgo === undefined ? kiosk : { ...kiosk, lastSeenAt: new Date(Date.now() - seenMinutesAgo * 60_000).toISOString() };
const staleKiosk = (kiosk) => { const lastSeenAt = listedKiosk(kiosk).lastSeenAt; return !lastSeenAt || Date.now() - Date.parse(lastSeenAt) >= 10 * 60_000; };
const randomCode = (length) => Array.from(randomBytes(length), (byte) => pairingAlphabet[byte % pairingAlphabet.length]).join("");
// Organization settings the preview shows and Settings > Modules > Attendance > Meeting configuration saves.
const previewSettings = { organizationName: "Nova Arts Collective", subtitle: "Make things together", logoData: logo, primaryColor: "#8b2f72", secondaryColor: "#e9b949", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30, earlyScanMinutes: 15, discordContestWindowHours: 24, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 10, attendanceReportingStartsOn: null };
const allowanceMinutes = (value) => Number.isInteger(value) && value >= 0 && value <= 180;
/** PATCH /admin/branding with the Worker's allowance checks; the preview has no meetings that a longer allowance could overlap. */
async function brandingRoute(request, path) {
  if (path !== "/admin/branding" || request.method !== "PATCH") return undefined;
  const body = await readBody(request);
  if (!allowanceMinutes(body.lateScanMinutes)) return [400, { error: "Invalid branding", details: ["Late scan window must be from 0 to 180 minutes"] }];
  if (body.earlyScanMinutes !== undefined && !allowanceMinutes(body.earlyScanMinutes)) return [400, { error: "Invalid branding", details: ["Early arrival allowance must be from 0 to 180 minutes"] }];
  for (const key of Object.keys(previewSettings)) if (body[key] !== undefined) previewSettings[key] = body[key];
  return [200, { ok: true }];
}
const readBody = (request) => new Promise((resolve) => { let text = ""; request.on("data", (chunk) => { text += chunk; }); request.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); } }); });
/** The kiosk routes the dashboard writes to, answered from the scenario's state; undefined for every other request. */
async function kioskRoute(request, path) {
  const kioskPath = /^\/admin\/kiosks\/([^/]+)(?:\/(authentication-method|commands))?$/.exec(path);
  const isPairing = path === "/admin/pairing-codes" && request.method === "POST";
  if (!(path === "/admin/kiosks" && request.method === "GET") && !isPairing && !(kioskPath && ["PATCH", "POST", "DELETE"].includes(request.method))) return undefined;
  if (kioskPath && ["fingerprint-sync", "fingerprint-vault", "fingerprint-reset", "fingerprint-match", "scan-reviews"].includes(kioskPath[1])) return undefined;
  const state = kioskScenario(request);
  if (path === "/admin/kiosks") return [200, { kiosks: state.kiosks.map(listedKiosk) }];
  const body = await readBody(request);
  if (isPairing) {
    const kioskName = String(body.kioskName ?? "").trim(); const kind = body.kind ?? "pi";
    if (!kioskName || kioskName.length > 80) return [400, { error: "Kiosk name is required and must be at most 80 characters" }];
    if (!["pi", "web"].includes(kind)) return [400, { error: "Kiosk kind must be pi or web" }];
    const holder = state.kiosks.find((kiosk) => kiosk.active === 1 && kiosk.name.toLowerCase() === kioskName.toLowerCase());
    if (body.replaceKioskId !== undefined) {
      const replaced = state.kiosks.find((kiosk) => kiosk.id === body.replaceKioskId && kiosk.active === 1);
      if (!replaced || replaced !== holder || !staleKiosk(replaced)) return [409, { error: "That kiosk is still checking in or no longer uses this name, so it can't be replaced.", code: "kiosk_not_replaceable" }];
      replaced.active = 0;
    } else if (holder) return [409, { error: "An active kiosk already uses that name. Choose a distinct device name.", code: "kiosk_name_in_use", ...(staleKiosk(holder) ? { replaceableKioskId: holder.id } : {}) }];
    const code = kind === "web" ? randomCode(8) : randomCode(12); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    state.pairingCodes = [...state.pairingCodes.filter((entry) => entry.kind !== kind), { code, kind, kioskName, expiresAt }];
    return [201, kind === "web" ? { code, displayCode: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt, kioskName, kind } : { code, expiresAt, kioskName, workerApiUrl: `http://127.0.0.1:${port}`, kind }];
  }
  const kiosk = state.kiosks.find((entry) => entry.id === decodeURIComponent(kioskPath[1]));
  if (!kiosk || kiosk.active !== 1) return [404, { error: "Kiosk not found" }];
  if (kioskPath[2] === "authentication-method" && request.method === "PATCH") {
    const method = body.authenticationMethod;
    if (!["fingerprint", "rfid", "nfc", "member_id", "qr"].includes(method)) return [400, { error: "Unsupported authentication method" }];
    if (kiosk.kind === "web" && method !== "member_id") return [400, { error: "Web kiosks identify members by member ID or member search." }];
    if (body.memberLookup !== undefined && (method !== "member_id" || !["entry", "search"].includes(body.memberLookup))) return [400, { error: "Member lookup is entry or search, and only with member ID." }];
    if (body.requirePin !== undefined && (typeof body.requirePin !== "boolean" || body.requirePin && method !== "member_id")) return [400, { error: "Require PIN is a true or false choice, and only with member ID." }];
    kiosk.configuredAuthenticationMethod = method; kiosk.memberLookup = method === "member_id" ? body.memberLookup ?? "entry" : "entry";
    kiosk.requirePin = method === "member_id" ? body.requirePin ?? kiosk.requirePin ?? false : false;
    return [200, { kioskId: kiosk.id, authenticationMethod: method, memberLookup: kiosk.memberLookup, requirePin: kiosk.requirePin }];
  }
  if (kioskPath[2] === "commands" && request.method === "POST") {
    if (kiosk.kind === "web" && !["reload_display", "reset_network_pin"].includes(body.command)) return [409, { error: "Web kiosks can only reload their display or reset their settings PIN." }];
    const command = { id: `command-${state.commands.length + 1}`, kioskId: kiosk.id, command: body.command };
    state.commands.push(command); return [201, command];
  }
  if (!kioskPath[2] && request.method === "DELETE") { kiosk.active = 0; return [200, { retired: true }]; }
  if (!kioskPath[2] && request.method === "PATCH") { kiosk.name = String(body.name ?? kiosk.name).trim(); return [200, { kiosk: listedKiosk(kiosk) }]; }
  return undefined;
}
// Member PIN state for the phase 3 contract, kept per x-preview-scenario like the kiosks. member-1 (A-101) has a PIN;
// member-2 (A-102) has one locked after five wrong tries. Nothing here is a real PIN or person.
function seedPins() {
  return {
    pinRequests: [],
    memberPins: new Map([
      ["member-1", { setAt: iso(-2 * 24 * 60), setKioskName: "Test web kiosk A", failedAttempts: 0, lockedUntil: null }],
      ["member-2", { setAt: iso(-5 * 24 * 60), setKioskName: "Front desk", failedAttempts: 5, lockedUntil: iso(30) }],
    ]),
    pinLockout: { enabled: false, attempts: 5, minutes: 15 },
  };
}
const pinView = (pin) => pin ? { set: true, setAt: pin.setAt, setKioskName: pin.setKioskName, failedAttempts: pin.failedAttempts, lockedUntil: pin.lockedUntil && Date.parse(pin.lockedUntil) > Date.now() ? pin.lockedUntil : null } : { set: false, setAt: null, setKioskName: null, failedAttempts: 0, lockedUntil: null };
const requestView = ({ id, status, expiresAt }) => ({ id, status, expiresAt });
/** The member PIN routes, answered from the scenario's state; undefined for every other request. */
async function pinRoute(request, path) {
  const kioskRequests = /^\/admin\/kiosks\/([^/]+)\/pin-requests$/.exec(path);
  const answer = /^\/admin\/pin-requests\/([^/]+)\/(approve|decline)$/.exec(path);
  const memberPin = /^\/admin\/members\/([^/]+)\/pin(\/unlock)?$/.exec(path);
  const lockout = path === "/admin/settings/pin-lockout";
  // Stands in for a kiosk asking for approval, so browser tests can add a request while the page polls.
  const simulated = path === "/preview/pin-requests" && request.method === "POST";
  if (!kioskRequests && !answer && !memberPin && !lockout && !simulated) return undefined;
  const state = kioskScenario(request);
  if (kioskRequests && request.method === "GET") {
    const kioskId = decodeURIComponent(kioskRequests[1]);
    for (const item of state.pinRequests) if (item.status === "pending" && Date.parse(item.expiresAt) <= Date.now()) item.status = "expired";
    return [200, { requests: state.pinRequests.filter((item) => item.kioskId === kioskId && item.status === "pending").map(({ id, member, createdAt, expiresAt }) => ({ id, member, createdAt, expiresAt })) }];
  }
  const body = request.method === "GET" || request.method === "DELETE" ? {} : await readBody(request);
  if (simulated) {
    const member = members.find((item) => item.id === body.memberId);
    if (!member) return [404, { error: "Member not found" }];
    const createdAt = new Date(Date.now() - Number(body.minutesAgo ?? 0) * 60_000).toISOString();
    const item = { id: `pin-request-${state.pinRequests.length + 1}`, kioskId: String(body.kioskId), status: "pending", member: { rosterId: member.id, memberId: member.memberId, firstName: body.firstName ?? member.firstName, lastName: body.lastName ?? member.lastName }, createdAt, expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString() };
    state.pinRequests.push(item); return [201, { request: requestView(item) }];
  }
  if (answer && request.method === "POST") {
    const item = state.pinRequests.find((entry) => entry.id === decodeURIComponent(answer[1]));
    if (!item) return [404, { error: "PIN request not found" }];
    if (item.status !== "pending") return [409, { error: "That PIN request was already answered or has expired.", code: "pin_request_not_pending" }];
    item.status = answer[2] === "approve" ? "approved" : "declined"; item.decidedAt = new Date().toISOString();
    return [200, { request: requestView(item) }];
  }
  if (memberPin) {
    const rosterId = decodeURIComponent(memberPin[1]);
    if (!members.some((item) => item.id === rosterId)) return [404, { error: "Member not found" }];
    if (!memberPin[2] && request.method === "GET") return [200, { pin: pinView(state.memberPins.get(rosterId)) }];
    if (!memberPin[2] && request.method === "DELETE") { state.memberPins.delete(rosterId); return [200, { pin: pinView(undefined) }]; }
    if (memberPin[2] && request.method === "POST") { const pin = state.memberPins.get(rosterId); if (pin) { pin.failedAttempts = 0; pin.lockedUntil = null; } return [200, { pin: pinView(pin) }]; }
    return undefined;
  }
  if (lockout && request.method === "GET") return [200, state.pinLockout];
  if (lockout && request.method === "PUT") {
    const { enabled, attempts, minutes } = body;
    if (typeof enabled !== "boolean") return [400, { error: "Lockout is on or off." }];
    if (!Number.isInteger(attempts) || attempts < 3 || attempts > 20) return [400, { error: "Wrong tries must be a whole number from 3 to 20." }];
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return [400, { error: "Lock for must be a whole number of minutes from 1 to 1440." }];
    state.pinLockout = { enabled, attempts, minutes }; return [200, state.pinLockout];
  }
  return undefined;
}
const walkthroughLastSteps ={ dashboard: "recurrence", roster: "bulk-tools", member: "member-actions", outreach: "reports-handoff", reports: "report-actions", meeting: "corrections", kiosks: "history" };
const server = createServer(async (request, response) => {
  const origin = request.headers.origin ?? "http://127.0.0.1:5173";
  response.setHeader("access-control-allow-origin", origin); response.setHeader("access-control-allow-credentials", "true"); response.setHeader("content-type", "application/json");
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`); const path = url.pathname;
  // Only the kiosk and Meeting configuration write routes answer preflights, so other unmocked writes still fail as before.
  if (request.method === "OPTIONS") { if (passwordParamsPaths.has(path) || path === "/admin/pairing-codes" || path.startsWith("/admin/kiosks/") || path.startsWith("/admin/pin-requests/") || /^\/admin\/members\/[^/]+\/pin(\/unlock)?$/.test(path) || path === "/admin/settings/pin-lockout" || path === "/preview/pin-requests" || path === "/admin/branding") { response.setHeader("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE"); response.setHeader("access-control-allow-headers", "content-type, x-preview-scenario"); } response.statusCode = 204; response.end(); return; }
  const kioskResult = await pinRoute(request, path) ?? await kioskRoute(request, path) ?? await brandingRoute(request, path);
  if (kioskResult) { response.statusCode = kioskResult[0]; response.end(JSON.stringify(kioskResult[1])); return; }
  const requestedMeeting = path.startsWith("/meetings/") ? meetings.find((meeting) => meeting.id === decodeURIComponent(path.slice("/meetings/".length))) : undefined;
  const walkthroughPage = path.startsWith("/auth/walkthroughs/") ? path.slice("/auth/walkthroughs/".length) : "";
  // The salt lookups before a sign-in or identity confirmation; specs that check the exchange route their own.
  if (passwordParamsPaths.has(path) && request.method === "POST") { response.end(JSON.stringify(previewPasswordParams)); return; }
  const payload = path === "/setup/status" ? { configured: true, installation: { authMode: "local" }, settings: previewSettings }
    : Object.hasOwn(walkthroughLastSteps, walkthroughPage) ? { progress: { pageId: walkthroughPage, version: 1, status: "completed", stepId: walkthroughLastSteps[walkthroughPage] } }
    : path === "/auth/session" ? { user: { id: "admin-1", role: "admin", debugMode: false } }
    : path === "/platform/modules" ? defaultModuleSnapshot
    : path.startsWith("/admin/modules/assignments/") ? { userId: decodeURIComponent(path.split("/")[4]), revision: 0, capabilities: [] }
    : path === "/admin/modules/grants" ? { uses: [], reauthentication: { freshUntil: null, password: true, google: false } }
    : path === "/admin/setup/progress" ? { completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map((step) => ({ step })) }
    : path === "/integrations/capabilities" ? { integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: true, configured: true } } }
    : path === "/meetings" ? { meetings, lateScanMinutes: previewSettings.lateScanMinutes, earlyScanMinutes: previewSettings.earlyScanMinutes }
    : path === "/labels" ? labelData
    : path === "/reports/catalog" ? { datasets: [attendanceDataset], columns: reportColumns, recentDays: 30, labels, reportFilters: [], baseline: null, timeZone: "UTC", defaultDefinition: defaultReportDefinition, role: "admin", attendanceAvailable: true }
    : path === "/reports/views" ? { reports: [] }
    : path === "/reports/tabs" ? { reportIds: [] }
    : path === "/reports/leaderboard" ? leaderboardReport
    : path === "/reports/query" ? customReport
    : path === "/reports/attendance" ? (() => { const type = url.searchParams.get("meetingType"); const from = url.searchParams.get("from"); const to = url.searchParams.get("to"); const selected = report.meetings.filter((meeting) => (!type || type === "all" || Boolean(meeting.required) === (type === "required")) && (!from || meeting.startsAt.slice(0, 10) >= from) && (!to || meeting.startsAt.slice(0, 10) <= to)); const ids = new Set(selected.map((meeting) => meeting.id)); return { ...report, meetings: selected, members: report.members.map((member) => ({ ...member, rows: member.rows.filter((row) => ids.has(row.meetingId)) })) }; })()
    : path.endsWith("/impact") && path.startsWith("/meetings/") ? { changed: false, completed: false, impact: [], previewToken: "current" }
    : path.startsWith("/meetings/") ? requestedMeeting ? { meeting: requestedMeeting } : { error: "Meeting not found" }
    : path === "/meeting-templates" ? { templates: [] }
    : path === "/discord/contests" ? { contests: [{ meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: meetings[2].startsAt, memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", status: "open", createdAt: iso(-5), lifetimeContestCount: 3, hasPartialScan: true, rawScanStatus: "partial" }] }
    : path === "/attendance" ? { finalized: false, attendanceClosesAt: iso(90), attendance: [{ memberId: "member-1", externalId: "A-101", firstName: "Avery", lastName: "Stone", disposition: "active", checkedInAt: iso(-20) }, { memberId: "member-2", externalId: "A-102", firstName: "Morgan", lastName: "Diaz", disposition: "present", checkedInAt: iso(-25), checkedOutAt: iso(-2) }, { memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", disposition: "absent" }] }
    : path === "/admin/members/A-101/history" ? memberDetail(members[0])
    : path === "/admin/members/A-102/history" ? memberDetail(members[1])
    : path === "/admin/attendance/members" ? { members: members.map((member) => ({ memberId: member.memberId, attendanceRequiredFrom: new Date().toISOString().slice(0, 10) })) }
    : path === "/admin/members" ? request.method === "POST" ? { imported: 1, deactivated: 0, warnings: [] } : { members }
    : path === "/admin/users" ? { users: [{ id: "user-1", localUsername: "admin", role: "admin", active: 1, memberId: "member-1", memberExternalId: "A-101", memberFirstName: "Avery", memberLastName: "Stone", createdAt: iso(-30 * 24 * 60) }] }
    : path === "/admin/kiosks/fingerprint-sync" && request.method === "GET" ? { enabled: false }
    : path === "/admin/kiosks/fingerprint-vault" && request.method === "GET" ? { enabled: false, keyStatus: "ready", storedFingerprints: 0, serverManagedKeys: true }
    : path === "/admin/kiosks/fingerprint-reset" && request.method === "GET" ? { resetCommands: [] }
    : path === "/admin/kiosks" ? { kiosks: seedKiosks("default") }
    : path === "/admin/web-updates/status" ? { releaseVersion: "0.23.2", workflowUrl: "https://github.example.test/private/actions/workflows/upgrade-web.yml", request: null }
    : path === "/admin/releases/latest" ? { channel: "stable", fresh: true, checkedAt: Date.now(), attemptedAt: Date.now(), release: { tag_name: "v0.8.0" } }
    : path === "/admin/update-channel" ? { channel: "stable", revision: 0 }
    : path === "/admin/integrations" ? { integrations: [{ provider: "google", enabled: true, saved: true, configured: true, state: "configured", verifiedAt: iso(-60) }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled", pendingOperations: 0, failedOperations: 0 }, { provider: "resend", enabled: true, saved: true, configured: false, state: "verification_required" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] }
    : path === "/admin/integrations/first" ? { programs: { FRC: { saved: false, username: "", checkedAt: null, readable: false }, FTC: { saved: false, username: "", checkedAt: null, readable: false } }, fll: { available: false }, encryption: true }
    : { error: "Preview route not implemented" };
  response.statusCode = payload.error ? 404 : 200; response.end(JSON.stringify(payload));
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`Dashboard preview API listening on http://127.0.0.1:${port}\n`));

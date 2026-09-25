import { createServer } from "node:http";

const port = Number(process.env.LANCERLOGIN_MOCK_PORT ?? 8787);
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
const report = { meetings: completedMeetings, members: members.map((member, index) => ({ member, currentLabelIds: [], rows: completedMeetings.map((meeting) => ({ meetingId: meeting.id, memberId: member.id, disposition: index ? "absent" : "present", eligibility: meeting.required ? "required" : "optional", policy: "standard", rateEligible: Boolean(meeting.required), regularEligible: Boolean(meeting.required), attended: !index, weight: 1, regularWeight: 1, audience: "All", memberLabelIds: [] })), regularAttendance: { rate: index ? 0 : 100, attended: index ? 0 : 1, required: 1, from: member.attendanceRequiredFrom ?? member.createdAt?.slice(0, 10) ?? null, to: new Date().toISOString().slice(0, 10) }, currentCompliance: { labelId: null, labelName: null, ruleId: null, ruleType: null, excusedHandling: null, status: "no_rule", threshold: null, from: new Date(now - 29 * 24 * 60 * 60_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), rate: null, unadjustedRate: null, attended: 0, required: 0 }, historySummaries: [], policy: "standard", present: index ? 0 : 1, primaryTotal: 1, adjustedTotal: 1, rate: index ? 0 : 100, adjustedRate: index ? 0 : 100, pooledRate: null, weeks: [], belowTargetWeeks: [] })), labels, baseline: null, timeZone: "UTC" };
const memberDetail = (member) => ({ member, labels, labelHistory: [], attendancePolicy: report.members.find((item) => item.member.id === member.id), history: [{ meetingId: "past-regular", title: "Completed build session", startsAt: meetings[0].startsAt, endsAt: meetings[0].endsAt, checkedInAt: iso(-4 * 24 * 60 + 5), checkedOutAt: iso(-4 * 24 * 60 + 115), disposition: "present", eligibility: "required", audience: "All", policy: "standard" }] });

const server = createServer((request, response) => {
  const origin = request.headers.origin ?? "http://127.0.0.1:5173";
  response.setHeader("access-control-allow-origin", origin); response.setHeader("access-control-allow-credentials", "true"); response.setHeader("content-type", "application/json");
  if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`); const path = url.pathname;
  const requestedMeeting = path.startsWith("/meetings/") ? meetings.find((meeting) => meeting.id === decodeURIComponent(path.slice("/meetings/".length))) : undefined;
  const payload = path === "/setup/status" ? { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Nova Arts Collective", subtitle: "Make things together", logoData: logo, primaryColor: "#8b2f72", secondaryColor: "#e9b949", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30 } }
    : path === "/auth/session" ? { user: { role: "admin" } }
    : path === "/admin/setup/progress" ? { completedSteps: ["branding", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map((step) => ({ step })) }
    : path === "/integrations/capabilities" ? { integrations: { google: { enabled: true, configured: true }, resend: { enabled: true, configured: false }, discord: { enabled: true, configured: true } } }
    : path === "/meetings" ? { meetings, lateScanMinutes: 30 }
    : path === "/labels" ? labelData
    : path === "/reports/attendance" ? (() => { const type = url.searchParams.get("meetingType"); const from = url.searchParams.get("from"); const to = url.searchParams.get("to"); const selected = report.meetings.filter((meeting) => (!type || type === "all" || Boolean(meeting.required) === (type === "required")) && (!from || meeting.startsAt.slice(0, 10) >= from) && (!to || meeting.startsAt.slice(0, 10) <= to)); const ids = new Set(selected.map((meeting) => meeting.id)); return { ...report, meetings: selected, members: report.members.map((member) => ({ ...member, rows: member.rows.filter((row) => ids.has(row.meetingId)) })) }; })()
    : path.endsWith("/impact") && path.startsWith("/meetings/") ? { changed: false, completed: false, impact: [], previewToken: "current" }
    : path.startsWith("/meetings/") ? requestedMeeting ? { meeting: requestedMeeting } : { error: "Meeting not found" }
    : path === "/meeting-templates" ? { templates: [] }
    : path === "/discord/contests" ? { contests: [{ meetingId: "active-meeting", meetingTitle: "Build session", meetingStartsAt: meetings[2].startsAt, memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", status: "open", createdAt: iso(-5), lifetimeContestCount: 3, hasPartialScan: true, rawScanStatus: "partial" }] }
    : path === "/attendance" ? { finalized: false, attendanceClosesAt: iso(90), attendance: [{ memberId: "member-1", externalId: "A-101", firstName: "Avery", lastName: "Stone", disposition: "active", checkedInAt: iso(-20) }, { memberId: "member-2", externalId: "A-102", firstName: "Morgan", lastName: "Diaz", disposition: "present", checkedInAt: iso(-25), checkedOutAt: iso(-2) }, { memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", disposition: "absent" }] }
    : path === "/admin/members/A-101/history" ? memberDetail(members[0])
    : path === "/admin/members/A-102/history" ? memberDetail(members[1])
    : path === "/admin/members" ? request.method === "POST" ? { imported: 1, deactivated: 0, warnings: [] } : { members }
    : path === "/admin/users" ? { users: [{ id: "user-1", localUsername: "admin", role: "admin", active: 1, memberId: "member-1", memberExternalId: "A-101", memberFirstName: "Avery", memberLastName: "Stone", createdAt: iso(-30 * 24 * 60) }] }
    : path === "/admin/kiosks" ? { kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1, lastSeenAt: iso(0), readerOnline: 1, releaseVersion: "0.8.0", pairedAt: iso(-1440) }] }
    : path === "/admin/web-updates/status" ? { releaseVersion: "0.23.2", workflowUrl: "https://github.example.test/private/actions/workflows/upgrade-web.yml", request: null }
    : path === "/admin/releases/latest" ? { fresh: true, checkedAt: Date.now(), attemptedAt: Date.now(), release: { tag_name: "v0.8.0" } }
    : path === "/admin/simulator" ? { simulator: { name: "Browser test", active: 1, online: 1, lastSeenAt: iso(0), readerOnline: false, releaseVersion: "browser simulator" } }
    : path === "/admin/integrations" ? { integrations: [{ provider: "google", enabled: true, saved: true, configured: true, state: "configured", verifiedAt: iso(-60) }, { provider: "google_calendar", enabled: false, saved: false, authorized: false, configured: false, state: "disabled", pendingOperations: 0, failedOperations: 0 }, { provider: "resend", enabled: true, saved: true, configured: false, state: "verification_required" }, { provider: "discord", enabled: false, saved: false, configured: false, state: "disabled" }] }
    : { error: "Preview route not implemented" };
  response.statusCode = payload.error ? 404 : 200; response.end(JSON.stringify(payload));
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`Dashboard preview API listening on http://127.0.0.1:${port}\n`));

import { createServer } from "node:http";

const port = Number(process.env.LANCERLOGIN_MOCK_PORT ?? 8787);
const now = Date.now();
const iso = (offsetMinutes) => new Date(now + offsetMinutes * 60_000).toISOString();
const logo = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><text x="80" y="82" fill="white" font-size="72" font-family="sans-serif" font-weight="700">NOVA</text></svg>').toString("base64")}`;
const meetings = [
  { id: "active-meeting", title: "Build session", startsAt: iso(-30), endsAt: iso(60), attendanceClosesAt: iso(90), required: 1, isTest: 0 },
  { id: "next-week", title: "Studio night", startsAt: iso(7 * 24 * 60), endsAt: iso(7 * 24 * 60 + 120), attendanceClosesAt: iso(7 * 24 * 60 + 150), required: 1, isTest: 0 },
];

const server = createServer((request, response) => {
  const origin = request.headers.origin ?? "http://127.0.0.1:5173";
  response.setHeader("access-control-allow-origin", origin); response.setHeader("access-control-allow-credentials", "true"); response.setHeader("content-type", "application/json");
  if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  const payload = path === "/setup/status" ? { configured: true, installation: { authMode: "local" }, settings: { organizationName: "Nova Arts Collective", subtitle: "Make things together", logoData: logo, primaryColor: "#8b2f72", secondaryColor: "#e9b949", appearance: "dark", logoBackdrop: "auto", lateScanMinutes: 30 } }
    : path === "/auth/session" ? { user: { role: "admin" } }
    : path === "/admin/setup/progress" ? { completedSteps: ["branding", "test-meeting", "roster", "pair-kiosk", "fingerprint-test", "confirm-attendance"].map((step) => ({ step })) }
    : path === "/meetings" ? { meetings, lateScanMinutes: 30 }
    : path === "/discord/contests" ? { contests: [{ meetingId: "active-meeting", meetingTitle: "Build session", memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", status: "open", createdAt: iso(-5) }] }
    : path === "/attendance" ? { finalized: false, attendanceClosesAt: iso(90), attendance: [{ memberId: "member-1", externalId: "A-101", firstName: "Avery", lastName: "Stone", disposition: "active", checkedInAt: iso(-20) }, { memberId: "member-2", externalId: "A-102", firstName: "Morgan", lastName: "Diaz", disposition: "present", checkedInAt: iso(-25), checkedOutAt: iso(-2) }, { memberId: "member-3", externalId: "A-103", firstName: "Jordan", lastName: "Lee", disposition: "absent" }] }
    : path === "/admin/kiosks" ? { kiosks: [{ id: "kiosk-1", name: "Front desk", active: 1, lastSeenAt: iso(0), readerOnline: 1, releaseVersion: "0.5.0", pairedAt: iso(-1440) }] }
    : path === "/admin/simulator" ? { simulator: { name: "Browser test", active: 1, online: 1, lastSeenAt: iso(0), readerOnline: false, releaseVersion: "browser simulator" } }
    : { error: "Preview route not implemented" };
  response.statusCode = payload.error ? 404 : 200; response.end(JSON.stringify(payload));
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`Dashboard preview API listening on http://127.0.0.1:${port}\n`));

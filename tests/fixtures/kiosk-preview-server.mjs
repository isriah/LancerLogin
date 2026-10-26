import { createServer } from "node:http";
import { kioskApp, kioskHtml, kioskIdentityStyles, kioskStatusStyles, kioskStyles } from "../../apps/kiosk/src/ui.mjs";
import { networkApp, networkStyles } from "../../apps/kiosk/src/network-ui.mjs";
import { maintenanceApp, maintenanceHtml, maintenanceStyles, maintenanceLayoutStyles, dashboardEnrollmentStyles } from "../../apps/kiosk/src/maintenance-ui.mjs";
import { dashboardEnrollmentApp } from "../../apps/kiosk/src/dashboard-enrollment-ui.mjs";
import { recoveryApp } from "../../apps/kiosk/src/recovery-ui.mjs";
import { attendanceReviewApp, attendanceReviewHtml, attendanceReviewStyles } from "../../apps/kiosk/src/attendance-review.mjs";
import { kioskScrollbarStyles, maintenanceScrollbarStyles } from "../../apps/kiosk/src/scrollbar-styles.mjs";
import { operatorPresenceApp } from "../../apps/kiosk/src/operator-presence-ui.mjs";

const port = Number(process.env.LANCERLOGIN_KIOSK_PREVIEW_PORT ?? 8792);
const baseState = {
  display: { id: "ready", tone: "ready", message: "Place finger on reader", detail: "Attendance kiosk ready" },
  branding: { organizationName: "Example Arts Club", subtitle: "Create together", logoData: "", primaryColor: "#8b2f72", secondaryColor: "#2f8b72", logoBackdrop: "auto" },
  kioskName: "Main kiosk", readerOnline: true, cloudOnline: true, pendingEvents: 0, releaseVersion: "1.0.2", displayReloadToken: 0,
};
const previewDisplays = {
  ready: baseState.display,
  processing: { id: "processing", tone: "processing", message: "Checking scan", detail: "Hold still" },
  duplicate: { id: "duplicate", tone: "notice", message: "Already recorded", detail: "Attendance was not changed", name: "Avery Stone", meetingTitle: "Build Night" },
  offline: { id: "offline", tone: "offline", message: "Saved for sync", detail: "This scan is stored on the kiosk and will sync automatically" },
  unknown: { id: "unknown", tone: "error", message: "Fingerprint not recognized", detail: "Try the same finger again, or ask an operator for help" },
  rejected: { id: "rejected", tone: "error", message: "Scan needs help", detail: "No meeting is accepting attendance scans at this time" },
};

function previewState(request) {
  const preview = String(request.headers["x-lancerlogin-preview-state"] || "ready");
  const cloudOnline = request.headers["x-lancerlogin-preview-cloud"] !== "offline";
  return { ...baseState, display: previewDisplays[preview] || previewDisplays.ready, cloudOnline, pendingEvents: cloudOnline ? 0 : 1 };
}

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (path === "/operator-presence.js") { response.setHeader("content-type", "text/javascript; charset=utf-8"); response.end(operatorPresenceApp); return; }
  if (path === "/operator-presence" && request.method === "POST") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    // Screens use an isolated preview acknowledgement. Multi-page behavior is
    // covered with the real coordinator in service and browser integration tests.
    try { let value = ""; for await (const chunk of request) value += chunk; const input = JSON.parse(value); response.end(JSON.stringify({ pageId: input.pageId, generation: input.generation ?? 1, mode: input.mode, captureSuspended: input.mode !== "attendance", reason: input.mode === "attendance" ? null : "operator_active", expiresInMs: 15_000 })); }
    catch { response.statusCode = 409; response.end(JSON.stringify({ error: "Kiosk page session unavailable. Retry attendance." })); }
    return;
  }
  if (path === "/styles.css") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(kioskStyles + kioskStatusStyles + kioskIdentityStyles + kioskScrollbarStyles); return; }
  if (path === "/attendance-review.css") { response.setHeader("content-type", "text/css; charset=utf-8"); response.end(attendanceReviewStyles + maintenanceScrollbarStyles); return; }
  const assets = { "/dashboard-enrollment.js": ["text/javascript; charset=utf-8", dashboardEnrollmentApp], "/": ["text/html; charset=utf-8", kioskHtml], "/styles.css": ["text/css; charset=utf-8", kioskStyles + kioskStatusStyles + kioskScrollbarStyles], "/app.js": ["text/javascript; charset=utf-8", kioskApp], "/network.css": ["text/css; charset=utf-8", networkStyles], "/network.js": ["text/javascript; charset=utf-8", networkApp], "/maintenance": ["text/html; charset=utf-8", maintenanceHtml], "/maintenance.css": ["text/css; charset=utf-8", maintenanceStyles + maintenanceLayoutStyles + maintenanceScrollbarStyles + dashboardEnrollmentStyles], "/maintenance.js": ["text/javascript; charset=utf-8", maintenanceApp], "/recovery.js": ["text/javascript; charset=utf-8", recoveryApp], "/attendance-review": ["text/html; charset=utf-8", attendanceReviewHtml], "/attendance-review.css": ["text/css; charset=utf-8", attendanceReviewStyles], "/attendance-review.js": ["text/javascript; charset=utf-8", attendanceReviewApp] };
  if (assets[path]) { response.setHeader("content-type", assets[path][0]); response.end(assets[path][1]); return; }
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (path === "/health") response.end(JSON.stringify({ ok: true, paired: true }));
  else if (path === "/display-state") response.end(JSON.stringify(previewState(request)));
  else if (path === "/network/session") response.end(JSON.stringify({ configured: true, authorized: false, network: { online: true, connection: "Studio WiFi" } }));
  else if (path === "/maintenance/session") response.end(JSON.stringify({ configured: true, authorized: false, lockedUntil: null }));
  else { response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" })); }
}).listen(port, "127.0.0.1", () => console.log(`Kiosk preview fixture listening on ${port}`));

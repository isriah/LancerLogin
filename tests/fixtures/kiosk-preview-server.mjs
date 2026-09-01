import { createServer } from "node:http";
import { kioskApp, kioskHtml, kioskStyles } from "../../apps/kiosk/src/ui.mjs";
import { networkApp, networkStyles } from "../../apps/kiosk/src/network-ui.mjs";
import { recoveryApp } from "../../apps/kiosk/src/recovery-ui.mjs";

const port = Number(process.env.LANCERLOGIN_KIOSK_PREVIEW_PORT ?? 8792);
const displayState = {
  display: { id: "ready", tone: "ready", message: "Place finger on reader", detail: "Attendance kiosk ready" },
  branding: { organizationName: "Example Arts Club", subtitle: "Create together", logoData: "", primaryColor: "#8b2f72", secondaryColor: "#2f8b72", logoBackdrop: "auto" },
  kioskName: "Main kiosk", readerOnline: true, cloudOnline: true, pendingEvents: 0, displayReloadToken: 0,
};

createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  const assets = { "/": ["text/html; charset=utf-8", kioskHtml], "/styles.css": ["text/css; charset=utf-8", kioskStyles], "/app.js": ["text/javascript; charset=utf-8", kioskApp], "/network.css": ["text/css; charset=utf-8", networkStyles], "/network.js": ["text/javascript; charset=utf-8", networkApp], "/recovery.js": ["text/javascript; charset=utf-8", recoveryApp] };
  if (assets[path]) { response.setHeader("content-type", assets[path][0]); response.end(assets[path][1]); return; }
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (path === "/health") response.end(JSON.stringify({ ok: true, paired: true }));
  else if (path === "/display-state") response.end(JSON.stringify(displayState));
  else if (path === "/network/session") response.end(JSON.stringify({ configured: true, authorized: false, network: { online: true, connection: "Studio WiFi" } }));
  else { response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" })); }
}).listen(port, "127.0.0.1", () => console.log(`Kiosk preview fixture listening on ${port}`));

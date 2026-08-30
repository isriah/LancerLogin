import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { sendHeartbeat } from "./cloud-client.mjs";

const port = Number(process.env.LANCERLOGIN_KIOSK_PORT ?? 8788);
const configPath = process.env.LANCERLOGIN_CONFIG ?? "/var/lib/lancerlogin/pairing.json";
let state = { paired: false, readerOnline: false, cloudOnline: false, kioskName: undefined };

async function loadPairing() { try { const config = JSON.parse(await readFile(configPath, "utf8")); state = { ...state, paired: true, kioskName: config.kioskName }; return config; } catch { return undefined; } }
async function heartbeat() { const config = await loadPairing(); if (!config) return; try { await sendHeartbeat(config, { readerOnline: state.readerOnline, releaseVersion: process.env.LANCERLOGIN_VERSION ?? "development" }); state.cloudOnline = true; } catch { state.cloudOnline = false; } }

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (request.url === "/health") { await loadPairing(); response.end(JSON.stringify({ ok: true, service: "lancerlogin-kiosk", ...state })); return; }
  response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" }));
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, "127.0.0.1", () => console.log(`LancerLogin kiosk service listening on http://127.0.0.1:${port}`));
  heartbeat(); setInterval(heartbeat, 60_000).unref();
}

export { server };

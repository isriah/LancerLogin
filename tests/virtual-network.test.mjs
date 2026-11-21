import test from "node:test";
import assert from "node:assert/strict";
import { createNetworkManager } from "../apps/kiosk/src/network-manager.mjs";
import { createServer } from "node:http";
import { createVirtualNmcli, networkOnline, validNetworkState } from "../scripts/virtual-kiosk/fakes.mjs";
import { startCloudLink } from "../scripts/virtual-kiosk.mjs";

// The kiosk's real network manager, reading the virtual nmcli.
test("the real network manager reads wired, Wi-Fi and disconnected states from the virtual nmcli", async () => {
  const nmcli = createVirtualNmcli(); const network = createNetworkManager({ run: nmcli.run, connectSecure: nmcli.connectSecure });
  assert.deepEqual(await network.diagnostics(), { type: "ethernet", signal: null });
  assert.equal((await network.status()).connection, "Virtual wired network");

  nmcli.set({ connection: "none", ssid: null });
  assert.equal((await network.status()).online, false);
  assert.deepEqual(await network.diagnostics(), { type: "offline", signal: null });

  nmcli.set({ connection: "wifi", ssid: "Virtual Guest" });
  assert.deepEqual(await network.diagnostics(), { type: "wifi", signal: 52 });
  assert.deepEqual((await network.wifi()).map(({ ssid, active, secured }) => ({ ssid, active, secured })), [
    { ssid: "Virtual Guest", active: true, secured: false }, { ssid: "Virtual Lab", active: false, secured: true }, { ssid: "Virtual Shop", active: false, secured: true }, { ssid: "Virtual Campus", active: false, secured: true },
  ]);
  assert.throws(() => nmcli.set({ connection: "wifi", ssid: "Somewhere else" }), /listed network/);
});

test("joining Wi-Fi checks the password and reports the new network", async () => {
  const changes = [];
  const nmcli = createVirtualNmcli({ onChange: (state) => changes.push(state) });
  const network = createNetworkManager({ run: nmcli.run, connectSecure: nmcli.connectSecure });
  await assert.rejects(network.connect("Virtual Lab", "wrong"), /Secrets were required/);
  assert.deepEqual(changes, []);
  const joined = await network.connect("Virtual Lab", "virtual-lab-1");
  assert.equal(joined.type, "wifi"); assert.equal(joined.connection, "Virtual Lab");
  await network.connect("Virtual Guest");
  assert.deepEqual(changes, [{ connection: "wifi", ssid: "Virtual Lab" }, { connection: "wifi", ssid: "Virtual Guest" }]);
  // Virtual Shop's password has a capital, spaces, quotes, a backslash and a dollar sign; only that exact text joins.
  const shopPassword = "Shop 7 \"Q\"\\$z~!";
  for (const wrong of [shopPassword.toLowerCase(), shopPassword.replaceAll(" ", ""), `${shopPassword} `, shopPassword.replace("\\", "")]) await assert.rejects(network.connect("Virtual Shop", wrong), /Secrets were required/);
  assert.equal((await network.connect("Virtual Shop", shopPassword)).connection, "Virtual Shop");
  assert.deepEqual(changes.at(-1), { connection: "wifi", ssid: "Virtual Shop" });
  // The real network manager hands a password of every printable ASCII character to nmcli unchanged.
  const received = [];
  const recording = createNetworkManager({ run: nmcli.run, connectSecure: async (ssid, password) => { received.push([ssid, password]); } });
  const everyCharacter = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("");
  await recording.connect("Virtual Shop", everyCharacter);
  assert.deepEqual(received, [["Virtual Shop", everyCharacter]]);
  assert.equal(networkOnline({ connection: "none", ssid: null }), false);
  assert.equal(validNetworkState({ connection: "ethernet", ssid: "Virtual Lab" }), false);
});

// The virtual kiosk's link to the Worker (scripts/virtual-kiosk.mjs), in front of a stand-in server.
test("the cloud link refuses the scan deliveries it is told to, passes everything else, and lists deliveries in order", async (t) => {
  const reached = [];
  const upstream = createServer((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { reached.push(`${request.method} ${request.url} ${body}`); response.writeHead(request.url === "/kiosk/attendance" ? 201 : 200, { "content-type": "application/json" }); response.end("{\"ok\":true}"); });
  });
  await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  let online = true;
  const link = startCloudLink({ port: 0, target: `http://127.0.0.1:${upstream.address().port}`, online: () => online });
  await link.listening;
  t.after(() => { link.server.close(); upstream.close(); link.server.closeAllConnections(); upstream.closeAllConnections(); });
  const url = `http://127.0.0.1:${link.server.address().port}`;
  const send = (path, body) => fetch(`${url}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  link.refuseScans = 1;
  // The refused delivery gets an answer the kiosk does not know, and never reaches the server.
  const refused = await send("/kiosk/attendance", { eventId: "event-1", memberId: "1012" });
  assert.deepEqual([refused.status, await refused.json()], [404, { error: "Not found" }]);
  assert.deepEqual(reached, []);
  // Other requests pass meanwhile, and so does the next delivery, body and all.
  assert.equal((await send("/kiosk/heartbeat", { pendingEvents: 1 })).status, 200);
  assert.equal((await send("/kiosk/attendance", { eventId: "event-1", memberId: "1012" })).status, 201);
  assert.equal((await send("/kiosk/attendance", { eventId: "event-2", discordCode: "246813" })).status, 201);
  assert.equal((await send("/setup/status")).status, 200);
  assert.deepEqual(reached, [
    "POST /kiosk/heartbeat {\"pendingEvents\":1}", "POST /kiosk/attendance {\"eventId\":\"event-1\",\"memberId\":\"1012\"}",
    "POST /kiosk/attendance {\"eventId\":\"event-2\",\"discordCode\":\"246813\"}", "GET /setup/status ",
  ]);
  // The list names a code scan without keeping the code.
  assert.deepEqual(link.scans, [{ scan: "1012", status: 404, forwarded: false }, { scan: "1012", status: 201, forwarded: true }, { scan: "code", status: 201, forwarded: true }]);
  assert.equal(link.refuseScans, 0);

  // Offline, the link drops the connection as before, scan or not.
  online = false;
  await assert.rejects(send("/kiosk/attendance", { eventId: "event-3", memberId: "1013" }));
  assert.equal(link.scans.length, 3);
});

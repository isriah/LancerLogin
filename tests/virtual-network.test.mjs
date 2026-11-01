import test from "node:test";
import assert from "node:assert/strict";
import { createNetworkManager } from "../apps/kiosk/src/network-manager.mjs";
import { createVirtualNmcli, networkOnline, validNetworkState } from "../scripts/virtual-kiosk/fakes.mjs";

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
    { ssid: "Virtual Guest", active: true, secured: false }, { ssid: "Virtual Lab", active: false, secured: true },
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
  assert.equal(networkOnline({ connection: "none", ssid: null }), false);
  assert.equal(validNetworkState({ connection: "ethernet", ssid: "Virtual Lab" }), false);
});

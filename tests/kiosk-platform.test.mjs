import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { configureKioskPlatform, kioskPlatform } from "../apps/kiosk/src/kiosk-platform.mjs";
import { parseArguments, pairingKey, virtualPorts } from "../scripts/virtual-kiosk.mjs";
import { decodePairingKey } from "../apps/kiosk/src/pairing-key.mjs";

test("the kiosk service reaches hardware and the operating system only through the kiosk platform", async () => {
  const service = await readFile(new URL("../apps/kiosk/src/service.mjs", import.meta.url), "utf8");
  for (const direct of ["node:child_process", "createSerialExchange(", "createR503(", "createR503Transaction(", "createNetworkManager(", "startVerifiedKioskUpdate(", "prepareVerifiedKioskUpdate(", "/usr/bin/systemctl"]) {
    assert.equal(service.includes(direct), false, `service.mjs uses ${direct} directly`);
  }
  for (const hook of ["kioskPlatform.sensor(", "kioskPlatform.templateTransaction(", "kioskPlatform.networkManager()", "kioskPlatform.clock", "kioskPlatform.reboot()", "kioskPlatform.prepareUpdate(", "kioskPlatform.startUpdate("]) {
    assert.ok(service.includes(hook), `service.mjs no longer uses ${hook}`);
  }
});

test("the default platform keeps the Pi's sensor rule and refuses unknown hooks", () => {
  assert.equal(kioskPlatform.sensor("disabled"), undefined);
  assert.equal(typeof kioskPlatform.sensor("/dev/serial0").status, "function");
  assert.deepEqual(kioskPlatform.clock, {});
  assert.throws(() => configureKioskPlatform({ shell: () => undefined }), /Unknown kiosk platform hook shell/);
});

test("virtual kiosk arguments, ports and pairing keys", () => {
  assert.deepEqual(parseArguments([]), { kiosks: 1, reset: false, dashboard: true, portBase: 8790, state: parseArguments([]).state });
  assert.equal(parseArguments(["--kiosks", "2", "--reset", "--no-dashboard"]).kiosks, 2);
  assert.throws(() => parseArguments(["--kiosks", "5"]), /1 to 4/);
  assert.throws(() => parseArguments(["--state", "../elsewhere"]), /under .provision/);
  assert.deepEqual(virtualPorts(9000, 2), { panel: 9000, api: 9002, dashboard: 9003, kiosks: [9010, 9011], screens: [9020, 9021], links: [9030, 9031] });
  assert.deepEqual(decodePairingKey(pairingKey("http://127.0.0.1:9001", "ABC123DEF456", "Virtual kiosk 1")), { apiUrl: "http://127.0.0.1:9001", code: "ABC123DEF456", kioskName: "Virtual kiosk 1" });
});

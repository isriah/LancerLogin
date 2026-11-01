import { spawn } from "node:child_process";
import { createNetworkManager } from "./network-manager.mjs";
import { createR503 } from "./r503.mjs";
import { createR503Transaction } from "./r503-transaction.mjs";
import { createSerialExchange } from "./serial-transport.mjs";
import { prepareVerifiedKioskUpdate, startVerifiedKioskUpdate } from "./update-command.mjs";

// Hardware and operating-system access for the kiosk service. A Pi uses these defaults. The virtual Pi
// (scripts/virtual-kiosk.mjs) replaces them with fakes before it imports service.mjs, which reads them once
// at load. Nothing in a kiosk release calls configureKioskPlatform.
export const kioskPlatform = {
  // The R503 reader on the serial path, or undefined when LANCERLOGIN_SENSOR_PATH is "disabled".
  sensor: path => path === "disabled" ? undefined : createR503(createSerialExchange(path)),
  templateTransaction: path => createR503Transaction(path),
  networkManager: () => createNetworkManager(),
  // Options for createAttendanceClock; the defaults read /proc and timedatectl.
  clock: {},
  reboot: () => { const child = spawn("/usr/bin/systemctl", ["reboot"], { detached: true, stdio: "ignore" }); child.unref(); },
  prepareUpdate: command => prepareVerifiedKioskUpdate(command),
  startUpdate: options => startVerifiedKioskUpdate(options),
};

export function configureKioskPlatform(overrides) {
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(kioskPlatform, key)) throw new Error(`Unknown kiosk platform hook ${key}`);
  Object.assign(kioskPlatform, overrides);
}

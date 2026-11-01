// One virtual kiosk: the real kiosk service (apps/kiosk/src/service.mjs) with fake hardware. scripts/virtual-kiosk.mjs
// starts it with LANCERLOGIN_* paths under a state folder and restarts it when it exits, as systemd does on a Pi.
import { dirname, join } from "node:path";
import { configureKioskPlatform } from "../../apps/kiosk/src/kiosk-platform.mjs";
import { createNetworkManager } from "../../apps/kiosk/src/network-manager.mjs";
import { createR503 } from "../../apps/kiosk/src/r503.mjs";
import { prepareVerifiedKioskUpdate } from "../../apps/kiosk/src/update-command.mjs";
import { createVirtualNmcli, rebootExitCode, updateExitCode } from "./fakes.mjs";
import { createVirtualR503 } from "./virtual-r503.mjs";

const bootId = process.env.LANCERLOGIN_VIRTUAL_BOOT_ID;
const bootStartedAt = Number(process.env.LANCERLOGIN_VIRTUAL_BOOT_STARTED_AT);
if (!bootId || !Number.isFinite(bootStartedAt)) throw new Error("Start virtual kiosks with npm run kiosk:virtual");
const stateDirectory = dirname(process.env.LANCERLOGIN_CONFIG);
const reader = createVirtualR503({ path: process.env.LANCERLOGIN_VIRTUAL_READER });
// Whether this boot got network time; without it the kiosk asks an operator to confirm the date and time.
const clockSynced = process.env.LANCERLOGIN_VIRTUAL_CLOCK_SYNCED !== "0";
// What happens to the next update the dashboard sends: it installs (the service restarts) or it fails.
let nextUpdate = process.env.LANCERLOGIN_VIRTUAL_NEXT_UPDATE === "fail" ? "fail" : "install";
// The supervisor owns the network state; a Wi-Fi join made on the kiosk's own screen is reported back to it.
const nmcli = createVirtualNmcli({ state: JSON.parse(process.env.LANCERLOGIN_VIRTUAL_NETWORK ?? "null") ?? undefined, onChange: (network) => process.send?.({ event: "network", network }) });

const status = () => ({ ...reader.status(), network: nmcli.state(), system: { nextUpdate, clockSynced } });
// The control panel drives the virtual hardware through the supervisor's process channel.
process.on("message", (message) => {
  if (!message || typeof message.id !== "number") return;
  try {
    if (message.action === "present") reader.present(message.finger, message.holdMs);
    else if (message.action === "lift") reader.lift();
    else if (message.action === "faults") reader.setFaults(message.faults ?? {});
    else if (message.action === "network") nmcli.set(message.network);
    else if (message.action === "next-update") { if (!["install", "fail"].includes(message.outcome)) throw new Error("The next update must install or fail"); nextUpdate = message.outcome; }
    else if (message.action !== "status") throw new Error("Unknown virtual hardware action");
    process.send?.({ id: message.id, result: status() });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});

configureKioskPlatform({
  sensor: () => createR503(reader.exchange),
  templateTransaction: () => async () => { throw new Error("Virtual kiosks don't share fingerprint templates"); },
  networkManager: () => createNetworkManager({ run: nmcli.run, connectSecure: nmcli.connectSecure }),
  // A boot keeps its identity across service restarts and gets a new one on a virtual reboot, like /proc on a Pi.
  clock: { sample: async () => ({ bootId, elapsedMs: Date.now() - bootStartedAt, wallMs: Date.now() }), synchronized: async () => clockSynced },
  reboot: () => process.exit(rebootExitCode),
  // The real request check, writing into this kiosk's state folder instead of /var/lib/lancerlogin.
  prepareUpdate: (command) => prepareVerifiedKioskUpdate(command, join(stateDirectory, "update-request.json")),
  startUpdate: ({ onFailure }) => {
    if (nextUpdate === "fail") { onFailure("The virtual update failed, as set in the control panel"); return; }
    // On a Pi the update service installs the release and restarts the kiosk; a virtual kiosk keeps this checkout.
    process.exit(updateExitCode);
  },
});

await import("../../apps/kiosk/src/service.mjs");

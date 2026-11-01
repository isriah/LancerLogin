// Fake hardware and system answers for virtual kiosks. Shared by the kiosk process, the supervisor and the tests.

// Exit codes a virtual kiosk uses to ask its supervisor for a reboot (new boot identity) or an installed update.
export const rebootExitCode = 75;
export const updateExitCode = 76;

// Nearby Wi-Fi networks every virtual kiosk can see. Synthetic; the passwords are shown in the control panel.
export const virtualWifiNetworks = Object.freeze([
  Object.freeze({ ssid: "Virtual Lab", signal: 78, security: "WPA2", password: "virtual-lab-1" }),
  Object.freeze({ ssid: "Virtual Guest", signal: 52, security: "--", password: "" }),
]);

/** A kiosk's network: wired, on a Wi-Fi network, or with no connection. */
export function defaultNetworkState() { return { connection: "ethernet", ssid: null }; }

export function validNetworkState(value) {
  if (!value || typeof value !== "object") return false;
  if (value.connection === "ethernet" || value.connection === "none") return value.ssid === null;
  return value.connection === "wifi" && virtualWifiNetworks.some((network) => network.ssid === value.ssid);
}

export const networkOnline = (state) => state.connection !== "none";

// nmcli's terse output escapes ":" and "\" inside fields.
const field = (value) => String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");

/**
 * Answers the nmcli commands the kiosk service runs (apps/kiosk/src/network-manager.mjs) from a network state, and
 * joins Wi-Fi networks the way nmcli does. onChange receives the new state after a successful join.
 */
export function createVirtualNmcli({ state = defaultNetworkState(), onChange = () => undefined } = {}) {
  let current = { ...state };
  const join = (ssid, password) => {
    const network = virtualWifiNetworks.find((item) => item.ssid === ssid);
    if (!network) throw Object.assign(new Error(`Error: No network with SSID '${ssid}' found.`), { code: 10 });
    if (network.password && network.password !== password) throw Object.assign(new Error("Error: Connection activation failed: Secrets were required, but not provided."), { code: 4 });
    current = { connection: "wifi", ssid }; onChange({ ...current });
  };
  return {
    state: () => ({ ...current }),
    set(next) { if (!validNetworkState(next)) throw new Error("Network must be ethernet, none, or wifi with a listed network"); current = { ...next }; },
    async run(args) {
      if (args.includes("device") && args.includes("status")) {
        const wired = current.connection === "ethernet" ? "connected:Virtual wired network" : "unavailable:--";
        const wireless = current.connection === "wifi" ? `connected:${field(current.ssid)}` : "disconnected:--";
        return `eth0:ethernet:${wired}\nwlan0:wifi:${wireless}\nlo:loopback:connected (externally):lo\n`;
      }
      if (args.includes("radio")) return "";
      if (args.includes("wifi") && args.includes("list")) {
        const inUse = (network) => current.connection === "wifi" && current.ssid === network.ssid ? "*" : " ";
        if (args.includes("IN-USE,SIGNAL")) return virtualWifiNetworks.map((network) => `${inUse(network)}:${network.signal}`).join("\n") + "\n";
        return virtualWifiNetworks.map((network) => `${inUse(network)}:${field(network.ssid)}:${network.signal}:${network.security}`).join("\n") + "\n";
      }
      if (args[0] === "device" && args[1] === "wifi" && args[2] === "connect") { join(args[3], ""); return ""; }
      return "";
    },
    async connectSecure(ssid, password) { join(ssid, password); },
  };
}

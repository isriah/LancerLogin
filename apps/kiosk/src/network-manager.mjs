import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const unescapeNmcli = (value) => value.replaceAll("\\:", ":").replaceAll("\\\\", "\\");
const splitNmcli = (line) => { const fields = []; let value = ""; let escaped = false; for (const character of line) { if (escaped) { value += character; escaped = false; } else if (character === "\\") escaped = true; else if (character === ":") { fields.push(value); value = ""; } else value += character; } fields.push(value); return fields.map(unescapeNmcli); };

async function defaultRun(args) { const result = await exec("nmcli", args, { encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, LC_ALL: "C" } }); return result.stdout; }
const joinFailure = "Could not join that Wi-Fi network. Check the password and try again.";
export const enterpriseRefusal = "This network signs in with a username (802.1X), which this kiosk cannot use. Choose another network.";
/** nmcli's SECURITY column lists 802.1X for a network that signs in with a username (WPA-Enterprise). */
export const isEnterpriseSecurity = (security) => /802\.1X/i.test(String(security ?? ""));
const usesPassphrase = (security) => /WPA|SAE|RSN/i.test(String(security ?? "")) && !isEnterpriseSecurity(security);

/**
 * Counts nmcli's password prompts in what it has printed. `text` is what has not been counted yet; the result is the
 * number of complete prompts in it and the text after the last one, to pass in with the next chunk.
 */
export function passwordPrompts(text) {
  let count = 0, rest = text;
  for (let match = /password[^:]*:/i.exec(rest); match; match = /password[^:]*:/i.exec(rest)) { count += 1; rest = rest.slice(match.index + match[0].length); }
  return { count, rest: rest.slice(-16_384) };
}

/**
 * Joins a secured network as before: `nmcli --ask device wifi connect`, with the password typed at nmcli's prompt, so
 * it is never on a command line. One addition: when nmcli asks for the password a second time, the first was refused.
 * Nothing would answer and the join would sit until the 30 second limit, so nmcli is ended there, and the profile
 * that attempt created is deleted. Only a profile that did not exist before the attempt is ever deleted, and only
 * after a refused password, never after a timeout.
 */
export function createSecureConnect({ run = defaultRun, spawnImpl = spawn, limitMs = 30_000 } = {}) {
  const wifiProfiles = async () => (await run(["-t", "-f", "UUID,TYPE,NAME", "connection", "show"])).trim().split(/\r?\n/).filter(Boolean).map(splitNmcli).filter(([, type]) => type === "802-11-wireless").map(([uuid, , name]) => ({ uuid, name }));
  return async (ssid, password) => {
    // Without this list nothing can be told apart from what was already saved, so nothing is deleted.
    const before = await wifiProfiles().then((profiles) => new Set(profiles.map((profile) => profile.uuid)), () => undefined);
    let refused = false;
    try {
      await new Promise((resolve, reject) => {
        const child = spawnImpl("nmcli", ["--ask", "device", "wifi", "connect", ssid], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" }, windowsHide: true });
        let unread = ""; let prompts = 0; const timer = setTimeout(() => child.kill("SIGTERM"), limitMs);
        const read = (chunk) => {
          const seen = passwordPrompts(`${unread}${chunk}`); unread = seen.rest;
          for (let index = 0; index < seen.count; index += 1) {
            prompts += 1;
            if (prompts === 1) child.stdin.write(`${password}\n`);
            else if (!refused) { refused = true; child.kill("SIGTERM"); }
          }
        };
        child.stdout.on("data", read); child.stderr.on("data", read); child.once("error", (error) => { clearTimeout(timer); reject(error); }); child.once("exit", (code) => { clearTimeout(timer); child.stdin.end(); if (code === 0 && !refused) resolve(); else reject(new Error(joinFailure)); });
      });
    } catch (error) {
      if (refused && before) {
        const created = await wifiProfiles().then((profiles) => profiles.filter((profile) => !before.has(profile.uuid) && profile.name === ssid), () => []);
        for (const profile of created) await run(["connection", "delete", "uuid", profile.uuid]).catch(() => undefined);
      }
      throw error;
    }
  };
}

export function createNetworkManager({ run = defaultRun, connectSecure = createSecureConnect({ run }) } = {}) {
  // What the last scan said about each network, so a join that cannot work is refused before nmcli is run.
  const scanned = new Map();
  return {
    async status() {
      const output = await run(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]); const devices = output.trim().split(/\r?\n/).filter(Boolean).map(splitNmcli).map(([device, type, state, connection]) => ({ device, type, state, connection }));
      const active = devices.find((device) => ["wifi", "ethernet"].includes(device.type) && device.state === "connected"); return { online: Boolean(active), connection: active?.connection || null, type: active?.type || null, devices };
    },
    async diagnostics() {
      const status = await this.status();
      if (status.type !== "wifi") return { type: status.type === "ethernet" ? "ethernet" : "offline", signal: null };
      const output = await run(["-t", "-f", "IN-USE,SIGNAL", "device", "wifi", "list", "--rescan", "no"]);
      const active = output.trim().split(/\r?\n/).filter(Boolean).map(splitNmcli).find(([inUse]) => inUse === "*");
      const signal = Number(active?.[1]);
      return { type: "wifi", signal: Number.isInteger(signal) && signal >= 0 && signal <= 100 ? signal : null };
    },
    async wifi() {
      const status = await this.status(); const device = status.devices.find((item) => item.type === "wifi")?.device;
      await run(["radio", "wifi", "on"]);
      // Wait for fresh scan results instead of reading the cache just after requesting a scan.
      const output = await run(["-t", "--escape", "yes", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes", ...(device ? ["ifname", device] : [])]); const seen = new Set(); const networks = []; scanned.clear();
      for (const line of output.trim().split(/\r?\n/).filter(Boolean)) { const [active, ssid, signal, security] = splitNmcli(line); if (!ssid || seen.has(ssid)) continue; seen.add(ssid); const enterprise = isEnterpriseSecurity(security); scanned.set(ssid, { enterprise, passphrase: usesPassphrase(security) }); networks.push({ ssid, signal: Number(signal) || 0, secured: Boolean(security && security !== "--"), active: active === "*", ...(enterprise ? { enterprise: true } : {}) }); }
      return networks.sort((left, right) => Number(right.active) - Number(left.active) || right.signal - left.signal);
    },
    async connect(ssid, password = "") {
      const name = String(ssid).trim(); if (!name || name.length > 64 || password.length > 128) throw new Error("Choose a valid Wi-Fi network and password");
      const known = scanned.get(name);
      // nmcli would only ask for a username nothing can answer.
      if (known?.enterprise) throw new Error(enterpriseRefusal);
      // A WPA passphrase is 8 to 63 characters (or 64 hexadecimal digits); a shorter one can never be right.
      if (known?.passphrase && password && password.length < 8) throw new Error("A Wi-Fi password has at least 8 characters. Check it and try again.");
      if (password) await connectSecure(name, password); else await run(["device", "wifi", "connect", name]);
      return this.status();
    },
  };
}

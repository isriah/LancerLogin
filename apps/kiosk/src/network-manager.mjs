import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const unescapeNmcli = (value) => value.replaceAll("\\:", ":").replaceAll("\\\\", "\\");
const splitNmcli = (line) => { const fields = []; let value = ""; let escaped = false; for (const character of line) { if (escaped) { value += character; escaped = false; } else if (character === "\\") escaped = true; else if (character === ":") { fields.push(value); value = ""; } else value += character; } fields.push(value); return fields.map(unescapeNmcli); };

async function defaultRun(args) { const result = await exec("nmcli", args, { encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, LC_ALL: "C" } }); return result.stdout; }
function secureConnect(ssid, password) {
  return new Promise((resolve, reject) => {
    const child = spawn("nmcli", ["--ask", "device", "wifi", "connect", ssid], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" }, windowsHide: true });
    let output = ""; let supplied = false; const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    const read = (chunk) => { output = `${output}${chunk}`.slice(-16_384); if (!supplied && /password[^:]*:/i.test(output)) { supplied = true; child.stdin.write(`${password}\n`); } };
    child.stdout.on("data", read); child.stderr.on("data", read); child.once("error", (error) => { clearTimeout(timer); reject(error); }); child.once("exit", (code) => { clearTimeout(timer); child.stdin.end(); if (code === 0) resolve(); else reject(new Error("Could not join that Wi-Fi network. Check the password and try again.")); });
  });
}

export function createNetworkManager({ run = defaultRun, connectSecure = secureConnect } = {}) {
  return {
    async status() {
      const output = await run(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]); const devices = output.trim().split(/\r?\n/).filter(Boolean).map(splitNmcli).map(([device, type, state, connection]) => ({ device, type, state, connection }));
      const active = devices.find((device) => ["wifi", "ethernet"].includes(device.type) && device.state === "connected"); return { online: Boolean(active), connection: active?.connection || null, type: active?.type || null, devices };
    },
    async wifi() {
      const status = await this.status(); const device = status.devices.find((item) => item.type === "wifi")?.device;
      await run(["radio", "wifi", "on"]); await run(["device", "wifi", "rescan", ...(device ? ["ifname", device] : [])]); const output = await run(["-t", "--escape", "yes", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "no", ...(device ? ["ifname", device] : [])]); const seen = new Set(); const networks = [];
      for (const line of output.trim().split(/\r?\n/).filter(Boolean)) { const [active, ssid, signal, security] = splitNmcli(line); if (!ssid || seen.has(ssid)) continue; seen.add(ssid); networks.push({ ssid, signal: Number(signal) || 0, secured: Boolean(security && security !== "--"), active: active === "*" }); }
      return networks.sort((left, right) => Number(right.active) - Number(left.active) || right.signal - left.signal);
    },
    async connect(ssid, password = "") {
      const name = String(ssid).trim(); if (!name || name.length > 64 || password.length > 128) throw new Error("Choose a valid Wi-Fi network and password");
      if (password) await connectSecure(name, password); else await run(["device", "wifi", "connect", name]);
      return this.status();
    },
  };
}

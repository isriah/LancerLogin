import { spawn } from "node:child_process";
import { writeFile, rename, rm, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export async function kioskUpdatePolicyVersion() {
  try {
    const helper = "/usr/local/sbin/lancerlogin-install-release";
    const info = await stat(helper);
    if (info.uid !== 0 || (info.mode & 0o777) !== 0o755 || !(await readFile(helper, "utf8")).includes("/opt/lancerlogin/src/resolve-kiosk-release.mjs")) return 1;
    await stat("/opt/lancerlogin/src/resolve-kiosk-release.mjs"); return 2;
  } catch { return 1; }
}

export async function prepareVerifiedKioskUpdate(command, path = "/var/lib/lancerlogin/update-request.json") {
  if (!command.targetTag && !command.targetCommit) {
    if (command.channel && command.channel !== "stable") throw new Error("A beta update needs an exact release target");
    await rm(path, { force: true }); return; // A pre-bridge Worker can request stable only.
  }
  const created = Date.parse(command.createdAt);
  if (!Number.isFinite(created)) throw new Error("The kiosk update request has no valid creation time");
  const expiresAt = new Date(created + 15 * 60_000).toISOString();
  if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(command.targetTag ?? "") || !/^[0-9a-f]{40}$/.test(command.targetCommit ?? "") || !["stable", "beta"].includes(command.channel) || !Number.isFinite(created) || created > Date.now() || Date.now() >= Date.parse(expiresAt)) throw new Error("The kiosk update request is invalid or expired");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify({ targetTag: command.targetTag, targetCommit: command.targetCommit, channel: command.channel, expiresAt }), { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export function startVerifiedKioskUpdate({ spawnImpl = spawn, onFailure = () => undefined } = {}) {
  const child = spawnImpl("/usr/bin/systemctl", ["start", "lancerlogin-update.service"], { stdio: "ignore" });
  let reported = false;
  const report = (message) => {
    if (reported) return;
    reported = true;
    void Promise.resolve(onFailure(message)).catch(() => undefined);
  };
  child.once("error", () => report("The verified kiosk update service could not be started"));
  child.once("exit", (code) => { if (code !== 0) report(`The verified kiosk update service failed with status ${code ?? "unknown"}`); });
  child.unref();
  return child;
}

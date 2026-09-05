import { spawn } from "node:child_process";

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

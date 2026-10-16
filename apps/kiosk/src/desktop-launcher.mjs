import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function kioskBrowserArguments(profile) {
  if (!isAbsolute(profile)) throw new Error("Desktop profile must be absolute");
  return [`--user-data-dir=${profile}`, "--kiosk", "--noerrdialogs", "--disable-infobars", "--start-fullscreen", "http://127.0.0.1:8788/"];
}

export async function createDesktopLauncherClient({ fetchImpl = fetch, baseUrl = "http://127.0.0.1:8788", instanceId = randomUUID(), secret = randomBytes(32).toString("base64url") } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(baseUrl)) throw new Error("Desktop control must use loopback");
  let serviceId, registrationPending = false;
  async function request(operation, extra = {}) {
    const response = await fetchImpl(`${baseUrl}/desktop/launcher/${operation}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000),
      headers: { "content-type": "application/json", "x-lancerlogin-launcher": secret }, body: JSON.stringify({ instanceId, ...extra }) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("Desktop control request failed"), { status: response.status }); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Invalid desktop control response");
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 2048) throw new Error("Invalid desktop control response");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async function register() {
    const result = await request("register");
    if (result?.registered !== true || !uuid(result.serviceId)) throw new Error("Invalid desktop registration");
    serviceId = result.serviceId; registrationPending = false;
  }
  function renewIdentity() { instanceId = randomUUID(); secret = randomBytes(32).toString("base64url"); }
  async function recoverRegistration() {
    try { await register(); }
    catch (error) { if (error.status === 410) renewIdentity(); throw error; }
  }
  return { register,
    async poll() {
      if (registrationPending) { await recoverRegistration(); return null; }
      let result;
      try { result = await request("poll"); }
      catch (error) {
        if (![404, 409, 410].includes(error.status)) throw error;
        if (error.status !== 404) renewIdentity();
        // A retired registration cannot be reused, and its exit request must
        // not survive recovery. A live competing owner still rejects register.
        registrationPending = true;
        await recoverRegistration(); return null;
      }
      if (result?.serviceId !== serviceId || result.instanceId !== instanceId || !["none", "exit"].includes(result.action)) throw new Error("Desktop instance changed");
      if (result.action === "none" && result.requestId === null) return null;
      if (result.action !== "exit" || !uuid(result.requestId)) throw new Error("Invalid desktop exit request");
      return result.requestId;
    },
    acknowledge: requestId => request("ack", { requestId }),
    detach: () => request("detach"),
  };
}

// Only this process's ChildProcess handle is signalled. No global process scan,
// arbitrary PID, elevated helper or desktop-session impersonation is needed.
export async function superviseKioskBrowser({ launch, client, signal, pollIntervalMs = 1000, graceMs = 2000, registrationAttempts = 1 }) {
  for (let attempt = 0; ; attempt++) {
    try { await client.register(); break; }
    catch (error) {
      if (signal?.aborted || attempt + 1 >= registrationAttempts || [400, 409, 410].includes(error?.status)) throw error;
      await delay(pollIntervalMs);
    }
  }
  let child, exited = false, exitPromise;
  async function stop() {
    if (!child || exited) return;
    child.kill("SIGTERM");
    let timer;
    await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]);
    clearTimeout(timer);
    if (!exited) { child.kill("SIGKILL"); await exitPromise; }
  }
  try {
    if (signal?.aborted) return { exited: true };
    child = launch();
    exitPromise = new Promise((resolve, reject) => {
      child.once("exit", () => { exited = true; resolve(); });
      child.once("error", error => { exited = true; reject(error); });
    });
    // Observe spawn errors immediately even when the first poll is pending.
    exitPromise.catch(() => undefined);
    while (!exited && !signal?.aborted) {
      try {
        const requestId = await client.poll();
        if (requestId) { await stop(); await client.acknowledge(requestId); return { exited: true }; }
      } catch (error) {
        if (error?.status === 400) throw new Error("Desktop registration is invalid. Relaunch the kiosk.");
        // Outage/lease recovery and a competing live registration never grant
        // permission to close this browser. Retry without taking over its owner.
      }
      await Promise.race([exitPromise, delay(pollIntervalMs)]);
    }
    await stop();
    return { exited: true };
  } finally { await stop(); await client.detach().catch(() => undefined); }
}

export async function runDesktopLauncher(browserPath) {
  if (process.platform !== "linux" || process.getuid?.() === 0 || !isAbsolute(browserPath) || !["chromium", "chromium-browser"].includes(basename(browserPath))) throw new Error("Open the kiosk from the desktop account");
  const profile = join(homedir(), ".local", "share", "lancerlogin", "chromium");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const info = await lstat(profile);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("The kiosk browser profile needs local review");
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    return await superviseKioskBrowser({ client: await createDesktopLauncherClient(), signal: abort.signal, registrationAttempts: 10,
      launch: () => spawn(browserPath, kioskBrowserArguments(profile), { stdio: "ignore", shell: false }) });
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) { console.error("Open the kiosk with the installed desktop shortcut."); process.exitCode = 2; }
  else runDesktopLauncher(process.argv[2]).catch(() => { console.error("The kiosk could not start. Check its local service and relaunch from the desktop."); process.exitCode = 1; });
}

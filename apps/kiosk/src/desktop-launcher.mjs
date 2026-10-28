import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export const kioskUrl = "http://127.0.0.1:8788/";

// Static, script-free page shown while the local service is still starting
// (slow boot, wait-online delays, crash loop). It needs no network or service.
export const kioskWaitingUrl = `data:text/html;charset=utf-8,${encodeURIComponent("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>LancerLogin kiosk</title><style>html,body{height:100%;margin:0;background:#424a53;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;text-align:center}h1{font-size:44px;margin:0 0 16px}p{font-size:22px;margin:0 24px;opacity:.85}</style></head><body><main><h1>Starting attendance...</h1><p>The kiosk service is starting. This screen opens attendance automatically when it is ready.</p><p>If it stays here for several minutes, restart the device or ask an Administrator to check the kiosk service.</p></main></body></html>")}`;

export function kioskBrowserArguments(profile, url = kioskUrl) {
  if (!isAbsolute(profile)) throw new Error("Desktop profile must be absolute");
  if (![kioskUrl, kioskWaitingUrl].includes(url)) throw new Error("Unsupported kiosk browser page");
  return [`--user-data-dir=${profile}`, "--kiosk", "--noerrdialogs", "--disable-infobars", "--start-fullscreen", url];
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
function ownChild(child, graceMs) {
  const handle = { child, exited: false };
  handle.exitPromise = new Promise((resolve, reject) => {
    child.once("exit", () => { handle.exited = true; resolve(); });
    child.once("error", error => { handle.exited = true; reject(error); });
  });
  // Observe spawn errors immediately even when the first poll is pending.
  handle.exitPromise.catch(() => undefined);
  handle.stop = async () => {
    if (handle.exited) return;
    child.kill("SIGTERM");
    let timer;
    await Promise.race([handle.exitPromise.catch(() => undefined), new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]);
    clearTimeout(timer);
    if (!handle.exited) { child.kill("SIGKILL"); await handle.exitPromise.catch(() => undefined); }
  };
  return handle;
}

export function registrationRetryDelay(failuresAfterWaiting, { retryDelayMs = 1000, maxRetryDelayMs = 30_000 } = {}) {
  return Math.min(maxRetryDelayMs, retryDelayMs * 2 ** Math.min(Math.max(failuresAfterWaiting, 0), 16));
}

// Registration retries quickly a few times. When launchWaiting is supplied and
// the service is still unavailable, a static "starting" page is opened and
// registration keeps retrying with capped exponential backoff, so an offline or
// slow boot never leaves the bare desktop. A live competing registration (409)
// or an invalid request (400/410) still stops without taking over its owner.
export async function superviseKioskBrowser({ launch, launchWaiting, client, signal, pollIntervalMs = 1000, graceMs = 2000, registrationAttempts = 1, retryDelayMs = pollIntervalMs, maxRetryDelayMs = 30_000 }) {
  let waiting;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await client.register(); break; }
      catch (error) {
        if (signal?.aborted || [400, 409, 410].includes(error?.status)) throw error;
        const exhausted = attempt + 1 >= registrationAttempts;
        if (exhausted && !launchWaiting) throw error;
        if (exhausted && !waiting) waiting = ownChild(launchWaiting(), graceMs);
        // Closing the waiting screen (shortcut, crash) ends this launcher.
        if (waiting?.exited) throw error;
        const wait = waiting ? registrationRetryDelay(attempt + 1 - registrationAttempts, { retryDelayMs, maxRetryDelayMs }) : pollIntervalMs;
        let timer;
        await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, wait); signal?.addEventListener("abort", resolve, { once: true }); }), waiting?.exitPromise.catch(() => undefined)].filter(Boolean));
        clearTimeout(timer);
        if (signal?.aborted) { await waiting?.stop(); return { exited: true }; }
      }
    }
  } catch (error) { await waiting?.stop(); throw error; }
  // The real attendance page replaces the waiting page only after registration.
  await waiting?.stop();
  let owned;
  async function stop() { await owned?.stop(); }
  try {
    if (signal?.aborted) return { exited: true };
    owned = ownChild(launch(), graceMs);
    while (!owned.exited && !signal?.aborted) {
      try {
        const requestId = await client.poll();
        if (requestId) { await stop(); await client.acknowledge(requestId); return { exited: true }; }
      } catch (error) {
        if (error?.status === 400) throw new Error("Desktop registration is invalid. Relaunch the kiosk.");
        // Outage/lease recovery and a competing live registration never grant
        // permission to close this browser. Retry without taking over its owner.
      }
      await Promise.race([owned.exitPromise, delay(pollIntervalMs)]);
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
      launch: () => spawn(browserPath, kioskBrowserArguments(profile), { stdio: "ignore", shell: false }),
      launchWaiting: () => spawn(browserPath, kioskBrowserArguments(profile, kioskWaitingUrl), { stdio: "ignore", shell: false }) });
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) { console.error("Open the kiosk with the installed desktop shortcut."); process.exitCode = 2; }
  else runDesktopLauncher(process.argv[2]).catch(() => { console.error("The kiosk could not start. Check its local service and relaunch from the desktop."); process.exitCode = 1; });
}

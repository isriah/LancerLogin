// Starts the virtual kiosk stack (scripts/virtual-kiosk.mjs) for the scenarios in tests-virtual-kiosk, from Playwright's
// global setup (tests-virtual-kiosk/global-setup.ts).
//
// The start retries once, and only when it fails with a known start-up signature: a port the stack needs is taken,
// the local Worker (wrangler and workerd) or a preview server fails to start, a request fails while the stack seeds
// the preview or pairs the kiosk, or the kiosk's screen proxy can't listen or answer. Those come from the runner, not
// from the code under test (the maintainers' testing guide, "Virtual kiosk: known harness failures"). Any other start-up
// failure, such as a seeding request the Worker refuses or a Worker that doesn't build, fails at once. Nothing here
// retries a scenario: Playwright's own retries stay at 0, and a scenario that fails after the stack started stays
// failed.
//
// Before each attempt it picks the first block of ports that is free, from the requested base up in steps of 100, so a
// stack left running by an earlier local run, or a socket the system handed out, doesn't fail the start.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The stack listens on ports from its base up to base + 33 (scripts/virtual-kiosk.mjs, virtualPorts, for up to 4 kiosks). */
export const stackPortSpan = 34;
/** Where the start-up writes the port base it chose, for scripts/virtual-kiosk/sample-stack.sh. */
export const portBaseFile = join(root, ".provision/virtual-kiosk-port-base");

/**
 * Start-up failures that come from the runner rather than from the code under test. The first that matches the output
 * of a failed start names it; the start then runs once more. Keep these in step with the testing guide's list.
 */
export const startupSignatures = Object.freeze([
  { id: "port-in-use", label: "a port the stack needs was already in use",
    pattern: /EADDRINUSE|address already in use|Port \d+ is already in use|could not listen on 127\.0\.0\.1:\d+/i },
  { id: "workerd", label: "the local Worker (wrangler and workerd) failed to start",
    pattern: /Workers runtime failed to start|ERR_RUNTIME_FAILURE|workerd[^\n]*(?:failed|exited|crashed)|The local Worker did not start within/i },
  { id: "preview-server-exit", label: "a local preview server (the Worker or the dashboard) stopped while the stack started",
    pattern: /A local preview server stopped \(exit/ },
  { id: "pairing-fetch", label: "a request failed while the stack seeded the preview or paired the kiosk",
    pattern: /Virtual kiosk failed: (?:TypeError: )?fetch failed|Pairing Virtual kiosk \d+ failed:[^\n]*fetch failed/i },
  { id: "screen-proxy", label: "the kiosk's screen proxy could not listen or did not answer",
    pattern: /screen proxy did not start within|kiosk screen proxy could not listen|screen proxy[^\n]*ECONNREFUSED/i },
]);
/** Output that means the code under test is broken, so the start is never retried even when a signature also matches. */
const realFailures = /Build failed with \d+ error|\[ERROR\] Could not resolve|Applying Core migrations to the local database failed/;

/** The known start-up signature in a failed start's output, or undefined when it failed for another reason. */
export function startupSignature(output) {
  if (realFailures.test(output)) return undefined;
  return startupSignatures.find((signature) => signature.pattern.test(output));
}

/** Whether a TCP port can be bound on loopback now, over IPv4 and, where the system has it, IPv6. */
export async function portFree(port) {
  const bind = (host) => new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", (error) => resolveBind(host === "::1" && ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolveBind(true)));
  });
  return await bind("127.0.0.1") && await bind("::1");
}

/** The first base, from the requested one up in steps of 100, whose whole block of stack ports is free. */
export async function choosePortBase(requested, { candidates = 5, step = 100, isFree = portFree } = {}) {
  const busy = [];
  for (let index = 0; index < candidates; index++) {
    const base = requested + index * step;
    if (base < 1_024 || base + stackPortSpan > 65_536) break;
    let taken;
    for (let port = base; port < base + stackPortSpan && taken === undefined; port++) if (!await isFree(port)) taken = port;
    if (taken === undefined) return base;
    busy.push(`${base} (port ${taken} is in use)`);
  }
  throw new Error(`No free block of ${stackPortSpan} ports for the virtual kiosk stack: tried ${busy.join(", ")}. Stop the program holding them (an earlier virtual kiosk run, for example), or set LANCERLOGIN_VIRTUAL_KIOSK_PORT_BASE.`);
}

/** Whether the stack's control panel answers, which it does only once the stack seeded the preview and paired the kiosk. */
export async function panelReady(base) {
  try { return (await fetch(`http://127.0.0.1:${base}/api/status`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { return false; }
}

/** Stops a process and everything it started: its process group on Linux and macOS, its process tree on Windows. */
function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit()));
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already gone. */ }
    const force = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ } }, 10_000);
    force.unref(); void exited.then(() => clearTimeout(force));
  }
  return exited;
}

/** Launches scripts/virtual-kiosk.mjs on a port base and state folder, and hands each line it prints to onLine. */
export function launchStack({ base, state, onLine }) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/virtual-kiosk.mjs", "--reset", "--port-base", String(base), "--state", state], {
    cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { const lines = (partial + chunk).split(/\r?\n/); partial = lines.pop() ?? ""; for (const line of lines) onLine(line); });
    stream.on("end", () => { if (partial) onLine(partial); partial = ""; });
  }
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit(code ?? signal)));
  return { exited, stop: () => stopTree(child) };
}

const pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Starts the stack and resolves once its control panel answers, with { base, panelUrl, attempts, stop }. A start that
 * fails with a known start-up signature is stopped and run once more on a fresh state folder; any other failure, or a
 * second failure, rejects with the reason and the end of the stack's output.
 */
export async function startVirtualKioskStack({
  requestedBase, attempts = 2, readyTimeoutMs = 300_000, pollMs = 500, log = (line) => console.log(line),
  launch = launchStack, isReady = panelReady, pickBase = choosePortBase, recordBase = (base) => { mkdirSync(dirname(portBaseFile), { recursive: true }); writeFileSync(portBaseFile, `${base}\n`); },
} = {}) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const base = await pickBase(requestedBase);
    if (base !== requestedBase) log(`[virtual kiosk] Ports from ${requestedBase} are in use; starting the stack on ports from ${base}.`);
    recordBase(base);
    // A first start on the requested ports keeps the usual folder; any other start gets its own, so a stack still
    // holding the usual one (an earlier run that didn't stop) isn't reset from under it.
    const state = attempt === 1 && base === requestedBase ? ".provision/virtual-kiosk-tests" : `.provision/virtual-kiosk-tests-${base}-${attempt}`;
    const tail = [];
    const stack = launch({ base, state, onLine: (line) => { log(`[virtual kiosk] ${line}`); tail.push(line); if (tail.length > 400) tail.shift(); } });
    let exitCode; let exited = false;
    void stack.exited.then((code) => { exited = true; exitCode = code; });
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    while (!exited && Date.now() < deadline) {
      if (await isReady(base)) { ready = true; break; }
      await pause(pollMs);
    }
    if (ready) {
      void stack.exited.then((code) => log(`[virtual kiosk] The stack stopped (exit ${code}).`));
      return { base, panelUrl: `http://127.0.0.1:${base}`, attempts: attempt, failures, stop: () => stack.stop() };
    }
    // Read how the attempt ended before stopping it, since stopping it makes it exit.
    const reason = exited ? `the stack exited (${exitCode}) before its control panel answered` : `the stack's control panel did not answer within ${Math.round(readyTimeoutMs / 1000)} s`;
    await stack.stop();
    // Let the stack's last lines arrive before reading them.
    await pause(Math.min(pollMs, 200));
    const output = tail.join("\n");
    const signature = startupSignature(output);
    failures.push(`Attempt ${attempt} on ports from ${base}: ${reason}${signature ? `; ${signature.label} [${signature.id}]` : ""}.`);
    if (!signature || attempt === attempts) {
      const advice = signature ? "It failed the same known way twice: see \"Virtual kiosk: known harness failures\" in the testing guide before rerunning."
        : "This is not a known start-up signature, so it was not retried: treat it as a real failure.";
      throw new Error(`The virtual kiosk stack did not start. ${failures.join(" ")} ${advice}\nLast lines from the stack:\n${tail.slice(-60).join("\n")}`);
    }
    log(`[virtual kiosk] Start-up failed: ${signature.label} [${signature.id}]. Stopping what started and starting the stack once more.`);
  }
  throw new Error("The virtual kiosk stack did not start.");
}

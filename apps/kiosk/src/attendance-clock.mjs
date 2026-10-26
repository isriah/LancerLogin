import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const developmentBootId = `development-${randomUUID()}`;
async function systemSample() {
  // Non-Linux development hosts require confirmation after every service start.
  if (process.platform !== "linux") return { bootId: developmentBootId, elapsedMs: Math.round(performance.now()), wallMs: Date.now() };
  const [bootId, uptime] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile("/proc/uptime", "utf8")]);
  return { bootId: bootId.trim(), elapsedMs: Math.round(Number(uptime.split(" ")[0]) * 1000), wallMs: Date.now() };
}
async function systemSynchronized() {
  try { return (await exec("timedatectl", ["show", "--property=NTPSynchronized", "--value"], { timeout: 2000, windowsHide: true })).stdout.trim() === "yes"; }
  catch { return false; }
}
const validSample = value => typeof value?.bootId === "string" && value.bootId.length > 0 && value.bootId.length <= 128
  && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && Number.isFinite(value.wallMs) && Math.abs(value.wallMs) <= 8.64e15;

// Wall time is trusted after OS synchronization or explicit operator confirmation. Boot elapsed time
// survives service restarts and includes suspend; it never spans a power cycle.
export function createAttendanceClock(path, { sample = systemSample, synchronized = systemSynchronized } = {}) {
  let anchors, loading, refreshing, verified = false;
  let operations = Promise.resolve();
  function exclusive(operation) { const result = operations.then(operation); operations = result.catch(() => undefined); return result; }
  async function load() {
    if (!loading) loading = (async () => {
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (value?.version !== 1 || !Array.isArray(value.anchors) || value.anchors.some(anchor => !validSample(anchor))) throw Error("Invalid attendance clock evidence");
        anchors = value.anchors;
      } catch (error) { if (error.code !== "ENOENT") throw error; anchors = []; }
    })();
    await loading;
  }
  async function save(next) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, anchors: next }) + "\n"); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      if (process.platform !== "win32") { const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); } }
      anchors = next;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async function current() { const value = await sample(); if (!validSample(value)) throw Error("Clock evidence unavailable"); return value; }
  function resolve(event) {
    const evidence = event.clock;
    if (evidence?.version !== 1 || typeof evidence.bootId !== "string" || !Number.isSafeInteger(evidence.elapsedMs) || evidence.elapsedMs < 0) return;
    const anchor = anchors.findLast(item => item.bootId === evidence.bootId);
    if (!anchor) return;
    const occurredAt = new Date(anchor.wallMs + evidence.elapsedMs - anchor.elapsedMs).toISOString();
    return { ...event, occurredAt, clock: { ...evidence, verified: true, source: anchor.source ?? "network" } };
  }
  return {
    refresh() {
      if (!refreshing) refreshing = exclusive(async () => {
        await load();
        if (!await synchronized()) { const value = await current(); verified = anchors.some(item => item.bootId === value.bootId); return; }
        const anchor = await current();
        if (!anchors.some(item => item.bootId === anchor.bootId && item.source !== "operator")) await save([...anchors, { ...anchor, source: "network" }]);
        verified = true;
      }).catch(error => { verified = false; throw error; }).finally(() => { refreshing = undefined; });
      return refreshing;
    },
    isVerified() { return verified; },
    confirm(isoTime) { return exclusive(async () => {
      const wallMs = typeof isoTime === "string" ? Date.parse(isoTime) : NaN;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(isoTime) || !Number.isFinite(wallMs)
        || new Date(wallMs).toISOString() !== isoTime || wallMs < Date.UTC(2020, 0, 1) || wallMs >= Date.UTC(2100, 0, 1)) throw Error("Enter a valid current date and time.");
      await load();
      const value = await current();
      if (anchors.some(item => item.bootId === value.bootId && item.source !== "operator")) throw Error("The clock has already synchronized. Return to the kiosk.");
      await save([...anchors, { ...value, wallMs, source: "operator" }]);
      verified = true;
    }); },
    async capture() {
      try {
        await load(); const value = await current();
        const event = { occurredAt: new Date(value.wallMs).toISOString(), clock: { version: 1, bootId: value.bootId, elapsedMs: value.elapsedMs, observedAt: new Date(value.wallMs).toISOString(), verified: false } };
        return resolve(event) ?? event;
      } catch { return { occurredAt: new Date().toISOString(), clock: { version: 1, verified: false } }; }
    },
    async prepare(event) {
      await load();
      // A resolved queue timestamp is durable before its first delivery attempt.
      // Never redate an event after an acknowledgement may have been lost.
      if (event.clock?.version === 1 && event.clock.verified === true) return { event };
      const resolved = resolve(event);
      if (resolved) return { event: resolved };
      const value = await current();
      if (event.clock?.version === 1 && event.clock.bootId === value.bootId && Number.isSafeInteger(event.clock.elapsedMs) && event.clock.elapsedMs >= 0) return { deferred: true };
      return { rejected: true, code: "clock_unverified", error: "Scan time could not be verified. Ask an operator to review attendance." };
    },
    async status() {
      try {
        await load(); const value = await current(); const anchor = anchors.findLast(item => item.bootId === value.bootId);
        verified = Boolean(anchor);
        return { verified, source: anchor?.source ?? (anchor ? "network" : undefined), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      catch { verified = false; return { verified: false }; }
    },
  };
}

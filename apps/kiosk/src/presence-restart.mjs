import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const processBootId = `process-${randomUUID()}`;
const modes = new Set(["attendance", "maintenance", "network", "sync", "review", "desktop"]);
const limit = 32_768;
async function systemSample() {
  if (process.platform !== "linux") return { bootId: processBootId, elapsedMs: Math.floor(performance.now()) };
  const [bootId, uptime] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile("/proc/uptime", "utf8")]);
  return { bootId: bootId.trim(), elapsedMs: Math.floor(Number(uptime.split(" ")[0]) * 1000) };
}
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const validSample = value => typeof value?.bootId === "string" && value.bootId.length > 0 && value.bootId.length <= 128 && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0;
const validBinding = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
function validPresence(value) {
  if (!keys(value, ["generation", "lost", "pages"]) || !Number.isSafeInteger(value.generation) || value.generation < 0 || typeof value.lost !== "boolean" || !Array.isArray(value.pages) || value.pages.length > 32) return false;
  const ids = new Set();
  return value.pages.every(page => {
    if (!keys(page, ["pageId", "mode", "generation", "remainingMs"]) || typeof page.pageId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(page.pageId) || ids.has(page.pageId) || !modes.has(page.mode) || !Number.isSafeInteger(page.generation) || page.generation < 1 || page.generation > value.generation || !Number.isFinite(page.remainingMs) || page.remainingMs < 0 || page.remainingMs > 15_000) return false;
    ids.add(page.pageId); return true;
  });
}
function safeOwner(info) {
  return process.platform === "win32" || (info.uid === process.getuid() && (info.mode & 0o077) === 0);
}
async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

// A single-use checkpoint for orderly service restarts, never PIN authorization.
// Deadlines are tied to the OS boot clock; rebooting cannot renew a page lease.
export function createPresenceRestartStore(path, { sample = systemSample } = {}) {
  let operations = Promise.resolve();
  function exclusive(operation) { const result = operations.then(operation); operations = result.catch(() => undefined); return result; }
  async function directory(create = false) {
    if (create) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const info = await lstat(dirname(path));
    if (!info.isDirectory() || info.isSymbolicLink() || !safeOwner(info)) throw Error("Unsafe presence checkpoint directory");
  }
  return {
    save(snapshot, binding) {
      const started = performance.now();
      return exclusive(async () => {
      if (!validBinding(binding) || !validPresence(snapshot)) throw Error("Invalid presence checkpoint");
      // Copy before awaiting so callers cannot alter the checked payload.
      const presence = structuredClone(snapshot);
      const clock = await sample();
      if (!validSample(clock)) throw Error("Presence restart clock unavailable");
      const samplingElapsed = Math.max(0, Math.ceil(performance.now() - started));
      presence.pages = presence.pages.map(page => ({ ...page, remainingMs: Math.max(0, page.remainingMs - samplingElapsed) }));
      await directory(true);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !safeOwner(info)) throw Error("Unsafe presence checkpoint file");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const data = JSON.stringify({ version: 1, bootId: clock.bootId, savedElapsedMs: clock.elapsedMs, binding, presence });
      if (Buffer.byteLength(data) > limit) throw Error("Presence checkpoint is too large");
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, path);
        await syncDirectory(dirname(path));
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }); },
    take(binding) { return exclusive(async () => {
      const claimed = `${path}.${randomUUID()}.consumed`;
      let moved = false;
      try {
        await directory();
        // Rename claims across store instances/processes; only one can consume.
        await rename(path, claimed); moved = true;
        const info = await lstat(claimed);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !safeOwner(info) || info.size > limit) return;
        const handle = await open(claimed, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let data;
        try {
          const current = await handle.stat();
          if (current.ino !== info.ino || current.dev !== info.dev || current.size > limit || current.nlink !== 1 || !safeOwner(current)) return;
          const buffer = Buffer.alloc(limit + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > limit) return;
          data = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        } finally { await handle.close(); }
        const sampleStarted = performance.now();
        const clock = await sample();
        if (!keys(data, ["version", "bootId", "savedElapsedMs", "binding", "presence"]) || data.version !== 1 || !validBinding(binding) || data.binding !== binding || !validSample(clock) || !validSample({ bootId: data.bootId, elapsedMs: data.savedElapsedMs }) || clock.bootId !== data.bootId || clock.elapsedMs < data.savedElapsedMs || !validPresence(data.presence)) return;
        // Consumption must be durable before the caller can resume capture.
        await unlink(claimed); moved = false;
        await syncDirectory(dirname(path));
        // Conservatively charge sampling and durable consumption latency too.
        const elapsed = clock.elapsedMs - data.savedElapsedMs + Math.max(0, Math.ceil(performance.now() - sampleStarted));
        return { ...data.presence, pages: data.presence.pages.map(page => ({ ...page, remainingMs: page.remainingMs - elapsed })) };
      } catch { return undefined; }
      finally {
        if (moved) {
          await unlink(claimed).catch(() => undefined);
          await syncDirectory(dirname(path)).catch(() => undefined);
        }
      }
    }); },
  };
}

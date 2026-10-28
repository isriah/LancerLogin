import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const failure = () => { throw new Error("Unpairing needs protected local-state recovery. Existing reader fingerprints are unchanged."); };
const privateMode = entry => process.platform === "win32" || ((Number(entry.mode) & 0o077) === 0 && Number(entry.uid) === process.getuid());
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const safeName = name => /^[A-Za-z0-9._-]{1,128}$/.test(name) && ![".", ".."].includes(name);
const controlName = "reassociation";
const archiveName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const purgingName = /^purging-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const archiveRetentionMs = 30 * 24 * 60 * 60_000;

// A local, confirmed installation switch archives state instead of copying it
// into the new pairing. There is no reader operation or automatic restore here.
export function createUnpairingStore(root, { pinPath, statePaths = [], move = rename, now = Date.now } = {}) {
  root = resolve(root);
  if (dirname(root) === root) return failure();
  const pinName = pinPath ? basename(pinPath) : "network-pin.json";
  const supported = pinPath && safeName(pinName) && samePath(dirname(resolve(pinPath)), root) && pinName !== controlName
    && statePaths.every(path => { const part = relative(root, resolve(path)); return part && !isAbsolute(part) && !part.startsWith("..") && !samePath(resolve(path), resolve(pinPath)) && part.split(/[\\/]/)[0] !== controlName; });
  const control = join(root, controlName);
  const journal = join(control, "current.json");
  let tail = Promise.resolve();
  const exclusive = operation => { const result = tail.then(operation, operation); tail = result.then(() => undefined, () => undefined); return result; };
  async function entry(path) {
    try { return await lstat(path, { bigint: true }); } catch (error) { if (error.code === "ENOENT") return null; return failure(); }
  }
  async function directory(path) {
    const info = await entry(path);
    if (!info?.isDirectory() || info.isSymbolicLink() || !privateMode(info) || !samePath(await realpath(path), resolve(path))) return failure();
  }
  async function syncDirectory(path) {
    if (process.platform === "win32") return;
    const file = await open(path, "r");
    try { await file.sync(); } finally { await file.close(); }
  }
  async function privateTree(path, budget = { entries: 0 }, depth = 0) {
    const info = await entry(path);
    if (!info || info.isSymbolicLink() || !privateMode(info) || ++budget.entries > 10000 || depth > 16) return failure();
    if (info.isDirectory()) {
      for (const name of await readdir(path)) { if (!safeName(name)) return failure(); await privateTree(join(path, name), budget, depth + 1); }
    } else if (!info.isFile() || info.nlink !== 1n || info.size > 64 * 1024 * 1024) return failure();
    return { name: basename(path), directory: info.isDirectory(), ino: info.ino.toString(), dev: info.dev.toString() };
  }
  async function readJournal() {
    if (!await entry(root)) return null;
    await directory(root);
    if (!await entry(control)) return null;
    await directory(control);
    const before = await entry(journal);
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink() || !privateMode(before) || before.nlink !== 1n || before.size > 65536) return failure();
    const file = await open(journal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await file.stat({ bigint: true });
      if (actual.ino !== before.ino || actual.dev !== before.dev || !privateMode(actual)) return failure();
      const state = JSON.parse(await file.readFile("utf8"));
      if (state.version !== 1 || !["archiving", "complete"].includes(state.phase)
        || !/^[0-9a-f-]{36}$/.test(state.archiveId) || !Array.isArray(state.entries) || state.entries.length > 128
        || new Set(state.entries.map(item => item.name)).size !== state.entries.length
        || state.entries.some(item => !safeName(item.name) || [pinName, controlName].includes(item.name)
          || typeof item.directory !== "boolean" || !/^[0-9]{1,32}$/.test(item.ino) || !/^[0-9]{1,32}$/.test(item.dev))) return failure();
      return state;
    } catch { return failure(); } finally { await file.close(); }
  }
  async function persist(state) {
    const temporary = join(control, `current.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state) + "\n"); await file.sync();
      await file.close(); await rename(temporary, journal); await syncDirectory(control);
    } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
  async function finish(state) {
    const archive = join(control, state.archiveId);
    await directory(archive);
    const allowed = new Set([pinName, controlName, ...state.entries.map(item => item.name)]);
    if ((await readdir(root)).some(name => !allowed.has(name))) return failure();
    const archivedNames = new Set(state.entries.map(item => item.name));
    if ((await readdir(archive)).some(name => !archivedNames.has(name))) return failure();
    for (const expected of state.entries) {
      const source = join(root, expected.name), target = join(archive, expected.name);
      const old = await entry(source), saved = await entry(target);
      if (Boolean(old) === Boolean(saved)) return failure();
      const actual = await privateTree(old ? source : target);
      if (actual.ino !== expected.ino || actual.dev !== expected.dev || actual.directory !== expected.directory) return failure();
      if (old) { await move(source, target); await syncDirectory(root); await syncDirectory(archive); }
    }
    await persist({ ...state, phase: "complete", completedAt: new Date().toISOString() });
    return { unpaired: true, archiveId: state.archiveId, readerTemplatesRetained: true, localPinRetained: true };
  }
  // Archived installations hold the old credential, roster, mappings and
  // fingerprint state. They are deleted after the retention window, and all of
  // them when the kiosk is paired again. Each archive is first renamed to
  // purging-<id> so an interrupted deletion is finished on the next run and a
  // half-deleted archive is never mistaken for a complete one.
  async function purge({ all = false, olderThanMs = archiveRetentionMs } = {}) {
    if (!await entry(root)) return { purged: [] };
    await directory(root);
    if (!await entry(control)) return { purged: [] };
    await directory(control);
    const state = await readJournal();
    const purged = [];
    const remove = async (path, id) => {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      if (await entry(path)) return failure();
      await syncDirectory(control);
      purged.push(id);
    };
    for (const name of (await readdir(control)).sort()) {
      const leftover = purgingName.exec(name);
      if (leftover) { await remove(join(control, name), leftover[1]); continue; }
      if (!archiveName.test(name)) continue;
      // An unfinished archive transaction is never purged.
      if (state?.phase === "archiving" && state.archiveId === name) continue;
      const info = await entry(join(control, name));
      if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
      const age = now() - Number(info.mtimeMs);
      if (!all && !(age > olderThanMs)) continue;
      const target = join(control, `purging-${name}`);
      await rename(join(control, name), target); await syncDirectory(control);
      if (state?.archiveId === name && state.phase === "complete") { await unlink(journal).catch(error => { if (error.code !== "ENOENT") throw error; }); await syncDirectory(control); }
      await remove(target, name);
    }
    return { purged };
  }
  return {
    inspect: () => exclusive(async () => { const state = await readJournal(); return { recoveryPending: Boolean(state?.phase === "archiving") }; }),
    purgeArchives: options => exclusive(async () => { try { return await purge(options); } catch { return failure(); } }),
    unpair: () => exclusive(async () => {
      try {
        if (!supported) return failure();
        await privateTree(pinPath);
        const previous = await readJournal();
        if (previous?.phase === "archiving") return await finish(previous);
        await directory(root);
        const names = (await readdir(root)).filter(name => ![pinName, controlName].includes(name)).sort();
        if (!names.length || names.length > 128 || names.some(name => !safeName(name))) return failure();
        const entries = [];
        for (const name of names) entries.push(await privateTree(join(root, name)));
        if (!await entry(control)) { await mkdir(control, { mode: 0o700 }); await syncDirectory(root); }
        await directory(control);
        const archiveId = randomUUID(); await mkdir(join(control, archiveId), { mode: 0o700 }); await syncDirectory(control);
        const state = { version: 1, phase: "archiving", archiveId, entries, createdAt: new Date().toISOString() };
        await persist(state);
        return await finish(state);
      } catch { return failure(); }
    }),
  };
}

export function createInstallationActivities() {
  const active = new Set();
  let paused = false;
  return {
    run(operation) {
      if (paused) return Promise.reject(new Error("Kiosk pairing is changing. Wait for setup to finish."));
      const current = Promise.resolve().then(operation).finally(() => active.delete(current));
      active.add(current); return current;
    },
    pause() { paused = true; },
    resume() { paused = false; },
    async drain(timeoutMs = 20000) {
      let timer;
      try {
        await Promise.race([Promise.allSettled([...active]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Kiosk is busy. Finish the current operation, then try unpairing again.")), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

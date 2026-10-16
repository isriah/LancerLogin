import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFingerprintStateLock } from "./fingerprint-state-lock.mjs";

const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const privateMode = stat => process.platform === "win32" || (stat.mode & 0o077) === 0 && stat.uid === process.getuid();
const fail = () => { throw new Error("Fingerprint mapping reset requires protected local-state recovery"); };
const recoveryValid = state => (state.lastResetCommand === null || identifier(state.lastResetCommand))
  && (state.pendingResetCommand === null || identifier(state.pendingResetCommand))
  && Array.isArray(state.completedCommands) && state.completedCommands.length <= 32 && state.completedCommands.every(identifier)
  && (state.lastResetCommand === null || state.completedCommands.includes(state.lastResetCommand));

// Only reset intent, completion and namespace metadata are active. Historical
// association state stays untouched; its keys, snapshots and decisions are not
// used. Copy its recovery boundary once so an upgrade cannot revive old queues
// or forget an interrupted mappings-only reset.
export function createFingerprintResetStore(path, binding, { legacyPath } = {}) {
  if (!identifier(binding?.kioskId) || !identifier(binding?.pairingId) || path === legacyPath) return fail();
  const bound = { kioskId: binding.kioskId, pairingId: binding.pairingId };
  let tail = Promise.resolve();
  const exclusive = operation => { const result = tail.then(operation, operation); tail = result.then(() => undefined, () => undefined); return result; };
  const empty = () => ({ version: 1, binding: bound, lastResetCommand: null, pendingResetCommand: null, completedCommands: [] });
  async function readProtected(target, maximum) {
    let file;
    try {
      const parent = await lstat(dirname(target));
      const entry = await lstat(target);
      if (!parent.isDirectory() || parent.isSymbolicLink() || !privateMode(parent) || !entry.isFile() || entry.isSymbolicLink() || !privateMode(entry)) return fail();
      file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const stat = await file.stat();
      if (!stat.isFile() || !privateMode(stat) || stat.size > maximum || stat.ino !== entry.ino || stat.dev !== entry.dev) return fail();
      const bytes = await file.readFile();
      try { return JSON.parse(bytes.toString("utf8")); } finally { bytes.fill(0); }
    } finally { await file?.close(); }
  }
  async function load() {
    try {
      const state = await readProtected(path, 16384);
      if (state?.version !== 1 || Object.keys(state).length !== 5 || state.binding?.kioskId !== bound.kioskId || state.binding?.pairingId !== bound.pairingId || !recoveryValid(state)) return fail();
      return { state };
    } catch (error) { if (error?.code !== "ENOENT") return fail(); }
    if (!legacyPath) return { state: empty() };
    let legacyLock;
    try {
      try { await lstat(legacyPath); } catch (error) { if (error?.code === "ENOENT") return { state: empty() }; throw error; }
      legacyLock = await acquireFingerprintStateLock(`${legacyPath}.lock`);
      const old = await readProtected(legacyPath, 262144);
      if (old?.version !== 1 || old.binding?.kioskId !== bound.kioskId || old.binding?.pairingId !== bound.pairingId || !recoveryValid(old)) return fail();
      // Historical completion IDs mixed review and reset commands. Only the
      // explicit last reset is proven reset completion, so no retired review
      // command can accidentally count as an already completed reset.
      return { state: { ...empty(), lastResetCommand: old.lastResetCommand, pendingResetCommand: old.pendingResetCommand,
        completedCommands: old.lastResetCommand ? [old.lastResetCommand] : [] }, legacyLock };
    } catch {
      await legacyLock?.close();
      return fail();
    }
  }
  async function save(state) {
    const temporary = `${path}.${randomUUID()}.tmp`; let file;
    try {
      file = await open(temporary, "wx", 0o600); await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); file = undefined;
      await chmod(temporary, 0o600); await rename(temporary, path);
      if (process.platform !== "win32") { const parent = await open(dirname(path), constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); } }
    } finally { await file?.close(); await unlink(temporary).catch(() => undefined); }
  }
  async function operation(callback) {
    return exclusive(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink() || !privateMode(parent)) return fail();
      let lock, migration;
      try {
        lock = await acquireFingerprintStateLock(`${path}.lock`); migration = await load();
        const result = await callback(migration.state); await save(migration.state); return result;
      } finally {
        try { await migration?.legacyLock?.close(); }
        finally { await lock?.close(); }
      }
    });
  }
  return {
    commandCompleted: id => operation(state => { if (!identifier(id)) return fail(); return state.completedCommands.includes(id); }),
    resetEpoch: () => operation(state => state.lastResetCommand),
    pendingReset: () => operation(state => state.pendingResetCommand),
    beginReset: id => operation(state => { if (!identifier(id) || state.pendingResetCommand !== null && state.pendingResetCommand !== id) return fail(); state.pendingResetCommand = id; }),
    completeCommand: id => operation(state => {
      if (!identifier(id) || state.pendingResetCommand !== id) return fail();
      state.completedCommands = [...new Set([...state.completedCommands, id])].slice(-32);
      state.lastResetCommand = id; state.pendingResetCommand = null;
    }),
  };
}

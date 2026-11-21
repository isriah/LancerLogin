import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback); const validPin = (pin) => /^\d{6,12}$/.test(String(pin));
const attemptsPerLockout = 5, baseLockMs = 30_000, maxLockMs = 60 * 60_000;

/** The backup copy of the PIN record, beside it. Unpairing keeps it with the PIN. */
export const networkPinBackupPath = path => `${path}.backup`;

const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const decodesTo = (value, length) => typeof value === "string" && base64.test(value) && Buffer.from(value, "base64").length === length;
const counter = value => value === undefined || Number.isSafeInteger(value) && value >= 0;
/** A PIN record as set() writes it, with the optional failure counter and lockout. Anything else is unreadable. */
export function validNetworkPinRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (value.version === undefined || value.version === 1)
    && decodesTo(value.salt, 16) && decodesTo(value.hash, 32) && counter(value.failures) && counter(value.lockouts) && counter(value.lockedUntil);
}

// The failure counter and lockout live in the owner-only PIN file, so a
// service restart (or a crash forced by an attacker) does not reset them.
// Each further lockout doubles, up to one hour, until a correct PIN.
//
// Durability. Every change is written twice, each time to a temporary file
// that is fsynced, renamed over the target, and followed by a directory fsync:
// first the backup copy (`<path>.backup`), then the PIN file. A power cut
// therefore leaves each file whole, old or new, and the backup is never
// behind the PIN file. Leftover temporary files from an interrupted write are
// removed on first use.
//
// An unreadable PIN file (empty, truncated, not a PIN record) never counts as
// "no PIN": that would let anyone at the kiosk who can cut its power choose a
// new PIN. The kiosk falls back to the backup copy and rewrites the PIN file
// from it ("restored"). Only when neither copy can be read does it report
// "unreadable": the PIN still counts as set, nobody can unlock or set one
// locally, and an Admin's Reset network PIN (which removes both copies) is the
// way out. Both states are shown on the kiosk screens and in its heartbeat.
export function createNetworkPinStore(path, { now = () => Date.now(), log = message => console.warn(message), onStep = async () => {} } = {}) {
  const backupPath = networkPinBackupPath(path), directory = dirname(path);
  const leftover = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.backup)?\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`);
  let sessionUntil = 0; let files = Promise.resolve(); let attempts = Promise.resolve();
  let recovery = null, leftoversRemoved = false, backupChecked = false;
  // One file operation at a time, so a repair never races a change.
  function serialized(operation) {
    const result = files.then(operation);
    files = result.then(() => undefined, () => undefined);
    return result;
  }
  async function syncDirectory() {
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function writeDurable(target, value) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(value)}\n`); await onStep("write", target); await file.sync(); await onStep("sync", target); }
      finally { await file.close(); }
      await chmod(temporary, 0o600);
      await rename(temporary, target); await onStep("rename", target);
      await syncDirectory(); await onStep("directory", target);
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  async function readCopy(target) {
    let text;
    try { text = await readFile(target, "utf8"); } catch (error) { return error?.code === "ENOENT" ? { missing: true } : { problem: error?.code ?? "read_failed" }; }
    try { const value = JSON.parse(text); return validNetworkPinRecord(value) ? { value } : { problem: "invalid_record" }; } catch { return { problem: text.length ? "invalid_json" : "empty" }; }
  }
  async function removeLeftovers() {
    if (leftoversRemoved) return;
    leftoversRemoved = true;
    let names = [];
    try { names = await readdir(directory); } catch { return; }
    for (const name of names.filter(name => leftover.test(name))) {
      await unlink(join(directory, name)).then(() => log(`Removed ${join(directory, name)}, left by an interrupted network PIN write.`), () => undefined);
    }
  }
  const at = () => new Date(now()).toISOString();
  // The saved record, undefined when no PIN is set, or { unreadable: true }.
  function record() {
    return serialized(async () => {
      await removeLeftovers();
      const main = await readCopy(path);
      if (main.value) {
        if (!backupChecked) {
          backupChecked = true;
          // A PIN saved by an earlier release has no backup yet.
          const backup = await readCopy(backupPath);
          if (!backup.value) await writeDurable(backupPath, main.value).catch(error => log(`Could not write the network PIN backup ${backupPath}: ${error?.message ?? error}`));
        }
        if (recovery?.state === "unreadable") recovery = null;
        return main.value;
      }
      const backup = await readCopy(backupPath);
      if (main.missing && backup.missing) { if (recovery?.state === "unreadable") recovery = null; return undefined; }
      if (backup.value) {
        backupChecked = true;
        if (recovery?.state !== "restored") {
          recovery = { state: "restored", at: at() };
          log(`Network PIN file ${path} could not be read (${main.missing ? "missing" : main.problem}). Restored it from ${backupPath}; the PIN is unchanged.`);
        }
        await writeDurable(path, backup.value).catch(error => log(`Could not rewrite ${path} from its backup: ${error?.message ?? error}`));
        return backup.value;
      }
      if (recovery?.state !== "unreadable") {
        recovery = { state: "unreadable", at: at() };
        log(`Network PIN file ${path} (${main.missing ? "missing" : main.problem}) and its backup (${backup.missing ? "missing" : backup.problem}) cannot be read. Network settings and maintenance stay locked until an Admin uses Reset network PIN.`);
      }
      return { unreadable: true };
    });
  }
  // The backup is written first, so it is never behind the PIN file.
  const save = value => serialized(async () => { await writeDurable(backupPath, value); await writeDurable(path, value); });
  // A wall clock corrected backwards must not extend a lockout beyond its maximum.
  function lockedUntil(saved) {
    const until = Number.isSafeInteger(saved?.lockedUntil) ? saved.lockedUntil : 0;
    return until - now() > maxLockMs ? now() + maxLockMs : until;
  }
  async function verifyNow(pin) {
      const saved = await record();
      if (saved?.unreadable) return { authorized: false, lockedUntil: null, unreadable: true };
      const until = lockedUntil(saved);
      if (until !== (saved?.lockedUntil ?? 0) && until > now()) await save({ ...saved, lockedUntil: until });
      if (now() < until) return { authorized: false, lockedUntil: new Date(until).toISOString() };
      if (!saved || !validPin(pin)) return { authorized: false };
      const actual = await scrypt(String(pin), Buffer.from(saved.salt, "base64"), 32);
      const valid = timingSafeEqual(Buffer.from(actual), Buffer.from(saved.hash, "base64"));
      const { failures: _failures, lockouts: _lockouts, lockedUntil: _locked, ...credential } = saved;
      if (!valid) {
        const failures = (Number.isSafeInteger(saved.failures) ? saved.failures : 0) + 1;
        const lockouts = Number.isSafeInteger(saved.lockouts) ? saved.lockouts : 0;
        if (failures >= attemptsPerLockout) {
          const next = now() + Math.min(maxLockMs, baseLockMs * 2 ** Math.min(lockouts, 16));
          await save({ ...credential, failures: 0, lockouts: lockouts + 1, lockedUntil: next });
          return { authorized: false, lockedUntil: new Date(next).toISOString() };
        }
        await save({ ...credential, failures, lockouts });
        return { authorized: false, lockedUntil: null };
      }
      if (saved.failures || saved.lockouts || saved.lockedUntil) await save(credential);
      sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() };
  }
  return {
    // `recovery` appears only after the PIN file was found unreadable: "restored" (from the backup, until the service
    // restarts or the PIN is reset) or "unreadable" (both copies, while it lasts).
    async status() {
      const saved = await record(); const until = saved?.unreadable ? 0 : lockedUntil(saved);
      return { configured: Boolean(saved), authorized: !saved?.unreadable && now() < sessionUntil, lockedUntil: until > now() ? new Date(until).toISOString() : null, ...(recovery ? { recovery: { ...recovery } } : {}) };
    },
    async set(pin) { if (!validPin(pin)) throw new Error("Network settings PIN must contain 6 to 12 digits"); const salt = randomBytes(16); const hash = await scrypt(String(pin), salt, 32); await save({ version: 1, salt: salt.toString("base64"), hash: Buffer.from(hash).toString("base64") }); recovery = null; sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() }; },
    // Attempts are serialized so parallel guesses cannot race the counter.
    verify(pin) {
      const result = attempts.then(() => verifyNow(pin));
      attempts = result.then(() => undefined, () => undefined);
      return result;
    },
    authorizeBootstrap() { sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() }; },
    close() { sessionUntil = 0; },
    // The backup goes first: an interrupted reset leaves the PIN set, never only a backup to restore from.
    reset() {
      return serialized(async () => {
        for (const target of [backupPath, path]) await unlink(target).catch(error => { if (error?.code !== "ENOENT") throw error; });
        await syncDirectory(); recovery = null; sessionUntil = 0; return { configured: false };
      });
    },
  };
}

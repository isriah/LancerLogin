import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback); const validPin = (pin) => /^\d{6,12}$/.test(String(pin));
const attemptsPerLockout = 5, baseLockMs = 30_000, maxLockMs = 60 * 60_000;

// The failure counter and lockout live in the owner-only PIN file, so a
// service restart (or a crash forced by an attacker) does not reset them.
// Each further lockout doubles, up to one hour, until a correct PIN.
export function createNetworkPinStore(path, { now = () => Date.now() } = {}) {
  let sessionUntil = 0; let writes = Promise.resolve(); let attempts = Promise.resolve();
  async function record() { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
  function save(value) {
    const result = writes.then(async () => {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); await chmod(path, 0o600); }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    });
    writes = result.then(() => undefined, () => undefined);
    return result;
  }
  // A wall clock corrected backwards must not extend a lockout beyond its maximum.
  function lockedUntil(saved) {
    const until = Number.isSafeInteger(saved?.lockedUntil) ? saved.lockedUntil : 0;
    return until - now() > maxLockMs ? now() + maxLockMs : until;
  }
  async function verifyNow(pin) {
      const saved = await record();
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
    async status() { const saved = await record(); const until = lockedUntil(saved); return { configured: Boolean(saved), authorized: now() < sessionUntil, lockedUntil: until > now() ? new Date(until).toISOString() : null }; },
    async set(pin) { if (!validPin(pin)) throw new Error("Network settings PIN must contain 6 to 12 digits"); const salt = randomBytes(16); const hash = await scrypt(String(pin), salt, 32); await save({ version: 1, salt: salt.toString("base64"), hash: Buffer.from(hash).toString("base64") }); sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() }; },
    // Attempts are serialized so parallel guesses cannot race the counter.
    verify(pin) {
      const result = attempts.then(() => verifyNow(pin));
      attempts = result.then(() => undefined, () => undefined);
      return result;
    },
    authorizeBootstrap() { sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() }; },
    close() { sessionUntil = 0; },
    async reset() { await rm(path, { force: true }); sessionUntil = 0; return { configured: false }; },
  };
}

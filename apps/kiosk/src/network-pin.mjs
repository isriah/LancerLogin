import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback); const validPin = (pin) => /^\d{6,12}$/.test(String(pin));
export function createNetworkPinStore(path, { now = () => Date.now() } = {}) {
  let failures = 0; let lockedUntil = 0; let sessionUntil = 0;
  async function record() { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
  return {
    async status() { return { configured: Boolean(await record()), authorized: now() < sessionUntil, lockedUntil: lockedUntil > now() ? new Date(lockedUntil).toISOString() : null }; },
    async set(pin) { if (!validPin(pin)) throw new Error("Network settings PIN must contain 6 to 12 digits"); const salt = randomBytes(16); const hash = await scrypt(String(pin), salt, 32); const temporary = `${path}.${process.pid}.${now()}.tmp`; await writeFile(temporary, `${JSON.stringify({ version: 1, salt: salt.toString("base64"), hash: Buffer.from(hash).toString("base64") })}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); await chmod(path, 0o600); failures = 0; lockedUntil = 0; sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() }; },
    async verify(pin) { if (now() < lockedUntil) return { authorized: false, lockedUntil: new Date(lockedUntil).toISOString() }; const saved = await record(); if (!saved || !validPin(pin)) return { authorized: false }; const actual = await scrypt(String(pin), Buffer.from(saved.salt, "base64"), 32); const valid = timingSafeEqual(Buffer.from(actual), Buffer.from(saved.hash, "base64")); if (!valid) { failures += 1; if (failures >= 5) { failures = 0; lockedUntil = now() + 30_000; } return { authorized: false, lockedUntil: lockedUntil ? new Date(lockedUntil).toISOString() : null }; } failures = 0; sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() }; },
    authorizeBootstrap() { sessionUntil = now() + 5 * 60_000; return { authorized: true, expiresAt: new Date(sessionUntil).toISOString() }; },
    close() { sessionUntil = 0; },
    async reset() { await rm(path, { force: true }); failures = 0; lockedUntil = 0; sessionUntil = 0; return { configured: false }; },
  };
}

import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const params = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashLocalPassword(password, random = randomBytes) {
  if (typeof password !== "string" || password.length < 12) throw new Error("Password must be at least 12 characters");
  const salt = random(16);
  const derived = await scrypt(password, salt, 32, params);
  return `scrypt$${params.N}$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyLocalPassword(password, encoded) {
  const [kind, cost, saltText, expectedText] = String(encoded).split("$");
  if (kind !== "scrypt" || Number(cost) !== params.N || !saltText || !expectedText) return false;
  const expected = Buffer.from(expectedText, "base64url");
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, "base64url"), expected.length, params));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function resetLocalPassword({ adminToolAuthorized, password, random }) {
  if (adminToolAuthorized !== true) throw new Error("Local setup-tool authorization required");
  return hashLocalPassword(password, random);
}

export function createSecretVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Installation key must be 32 bytes");
  const records = new Map();
  return {
    save(provider, secret, random = randomBytes) {
      const iv = random(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
      records.set(provider, { ciphertext: ciphertext.toString("base64url"), iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), updatedAt: new Date().toISOString() });
    },
    status(provider) { const record = records.get(provider); return record ? { configured: true, updatedAt: record.updatedAt } : { configured: false }; },
    decryptForServer(provider) {
      const record = records.get(provider); if (!record) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
    },
    remove(provider) { return records.delete(provider); },
  };
}

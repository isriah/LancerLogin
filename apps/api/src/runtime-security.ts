import { scryptAsync } from "@noble/hashes/scrypt.js";

const encoder = new TextEncoder();
const scryptOptions = { N: 32_768, r: 8, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024, asyncTick: 5 } as const;

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

const asArrayBuffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;

export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  if (password.length < 12) throw new Error("Password must be at least 12 characters");
  const derived = await scryptAsync(password, salt, scryptOptions);
  return `scrypt$${scryptOptions.N}$${scryptOptions.r}$${scryptOptions.p}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallel, saltText, expectedText] = encoded.split("$");
  if (algorithm !== "scrypt" || Number(cost) !== scryptOptions.N || Number(blockSize) !== scryptOptions.r || Number(parallel) !== scryptOptions.p || !saltText || !expectedText) return false;
  const expected = decodeBase64Url(expectedText);
  const actual = await scryptAsync(password, decodeBase64Url(saltText), { ...scryptOptions, dkLen: expected.length });
  return constantTimeEqual(actual, expected);
}

export type SessionPrincipal = { userId: string; role: "admin" | "operator"; expiresAt: number };

export function createSessionCodec(secret: string, now = () => Date.now()) {
  const keyBytes = decodeBase64Url(secret);
  if (keyBytes.length < 32) throw new Error("SESSION_KEY must contain at least 32 random bytes");
  const importKey = () => crypto.subtle.importKey("raw", asArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async issue(principal: Omit<SessionPrincipal, "expiresAt">, ttlMs = 8 * 60 * 60_000): Promise<string> {
      const payload = encodeBase64Url(encoder.encode(JSON.stringify({ ...principal, expiresAt: now() + ttlMs })));
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await importKey(), encoder.encode(payload)));
      return `${payload}.${encodeBase64Url(signature)}`;
    },
    async verify(token: string): Promise<SessionPrincipal | undefined> {
      const [payload, signature] = token.split(".");
      if (!payload || !signature) return undefined;
      const valid = await crypto.subtle.verify("HMAC", await importKey(), asArrayBuffer(decodeBase64Url(signature)), encoder.encode(payload));
      if (!valid) return undefined;
      try {
        const principal = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as SessionPrincipal;
        return principal.expiresAt > now() && ["admin", "operator"].includes(principal.role) && principal.userId ? principal : undefined;
      } catch { return undefined; }
    },
  };
}

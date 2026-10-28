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

/**
 * authenticatedAt records when the user last proved their identity (sign-in or re-authentication); older sessions omit it.
 * epoch is the user's session epoch when the token was issued. Bumping users.session_epoch revokes every older token.
 * Tokens issued before epochs existed omit it and count as epoch 0, so a deploy does not sign anyone out.
 */
export type SessionPrincipal = { userId: string; role: "admin" | "operator"; expiresAt: number; authenticatedAt?: number; epoch?: number };

export function createSessionCodec(secret: string, now = () => Date.now()) {
  const keyBytes = decodeBase64Url(secret);
  if (keyBytes.length < 32) throw new Error("SESSION_KEY must contain at least 32 random bytes");
  const importKey = () => crypto.subtle.importKey("raw", asArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async issue(principal: Omit<SessionPrincipal, "expiresAt" | "authenticatedAt">, ttlMs = 8 * 60 * 60_000): Promise<string> {
      const issuedAt = now();
      const payload = encodeBase64Url(encoder.encode(JSON.stringify({ ...principal, expiresAt: issuedAt + ttlMs, authenticatedAt: issuedAt })));
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await importKey(), encoder.encode(payload)));
      return `${payload}.${encodeBase64Url(signature)}`;
    },
    async verify(token: string): Promise<SessionPrincipal | undefined> {
      const [payload, signature] = token.split(".");
      if (!payload || !signature) return undefined;
      const valid = await crypto.subtle.verify("HMAC", await importKey(), asArrayBuffer(decodeBase64Url(signature)), encoder.encode(payload));
      if (!valid) return undefined;
      try {
        const principal = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as SessionPrincipal & { purpose?: unknown };
        // A purpose-bound token (such as an OAuth state) is never a session, even if it were signed with the session key.
        if ("purpose" in principal || (principal.epoch !== undefined && (!Number.isSafeInteger(principal.epoch) || principal.epoch < 0))) return undefined;
        return principal.expiresAt > now() && ["admin", "operator"].includes(principal.role) && principal.userId ? principal : undefined;
      } catch { return undefined; }
    },
  };
}

export type SignedState = { purpose: string; nonce: string; expiresAt: number; userId?: string };

/**
 * Short-lived signed values that travel in URLs, such as OAuth `state`. Each purpose signs with its own key derived from
 * SESSION_KEY (HMAC of a purpose label), and the payload names the purpose, so a state can never verify as a session
 * token or as a state for another purpose, and a session token can never verify as a state.
 */
export function createSignedStateCodec(secret: string, purpose: string, now = () => Date.now()) {
  const keyBytes = decodeBase64Url(secret);
  if (keyBytes.length < 32) throw new Error("SESSION_KEY must contain at least 32 random bytes");
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(purpose)) throw new Error("Signed state purpose is invalid");
  const derivedKey = async () => {
    const root = await crypto.subtle.importKey("raw", asArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, encoder.encode(`lancerlogin:signed-state:${purpose}`)));
    return crypto.subtle.importKey("raw", asArrayBuffer(derived), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  };
  return {
    async issue(values: { userId?: string } = {}, ttlMs = 10 * 60_000): Promise<string> {
      const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const payload = encodeBase64Url(encoder.encode(JSON.stringify({ purpose, nonce, expiresAt: now() + ttlMs, ...(values.userId ? { userId: values.userId } : {}) })));
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await derivedKey(), encoder.encode(payload)));
      return `${payload}.${encodeBase64Url(signature)}`;
    },
    async verify(token: string): Promise<SignedState | undefined> {
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined) return undefined;
      try {
        if (!await crypto.subtle.verify("HMAC", await derivedKey(), asArrayBuffer(decodeBase64Url(signature)), encoder.encode(payload))) return undefined;
        const state = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as SignedState;
        return state.purpose === purpose && typeof state.nonce === "string" && typeof state.expiresAt === "number" && state.expiresAt > now() ? state : undefined;
      } catch { return undefined; }
    },
  };
}

import { clientPasswordHash, constantTimeEqual, decodeFixedBytes, encodeBase64Url as encodeBytes, parsePasswordHash, passwordSaltBytes, passwordScrypt, passwordVerifier } from "../../../packages/shared/src/password-hash.mjs";
import { derivePasswordKey } from "../../../packages/shared/src/password-key.mjs";

const encoder = new TextEncoder();

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

const asArrayBuffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;

/*
 * Local-account passwords ("server relief"). The browser computes K = scrypt(password, salt, N=32768, r=8, p=1, dkLen=32)
 * and sends K; the Worker stores `scrypt-c$32768$8$1$<salt>$<SHA-256("lancerlogin:password:v2" ‖ K)>` and compares in
 * constant time. That costs well under 1 ms of CPU, where server-side scrypt cost 179–354 ms against the Free plan's 10 ms.
 *
 * The Worker never sees the password for a `scrypt-c` row, so it cannot check the 12-character minimum: the dashboard
 * and scripts/reset-local-password.mjs enforce it (packages/shared/src/password-key.mjs). Only the person choosing a
 * password could bypass it, and only for a password they choose themselves.
 *
 * Legacy `scrypt$` rows hold K itself. They are never converted without the password, because backups exported before
 * this change contain those K values, and a converted row would let such a K sign in directly. Instead the client sends
 * the password once with a new salt and its new K; the Worker checks the password with server-side scrypt (one burst
 * per user, inside the sign-in throttle and account lock) and stores the new K under the new salt.
 */
export { passwordSaltBytes, passwordScrypt };
export type PasswordFormat = "scrypt-c" | "legacy";

/** Which path a stored hash takes, or undefined when it can't sign in at all (no password, or a malformed row). */
export function passwordFormat(encoded: string | null | undefined): PasswordFormat | undefined {
  const parsed = parsePasswordHash(encoded);
  return parsed?.format === "scrypt-c" ? "scrypt-c" : parsed?.format === "scrypt" ? "legacy" : undefined;
}

/** The salt stored in a `scrypt-c` row, as base64url. */
export function storedPasswordSalt(encoded: string): string | undefined {
  const parsed = parsePasswordHash(encoded);
  return parsed?.format === "scrypt-c" ? encodeBytes(parsed.salt) : undefined;
}

/** A 32-byte K sent by the client, or undefined for anything else. */
export const parsePasswordKey = (value: unknown) => decodeFixedBytes(value, passwordScrypt.dkLen);
/** A 16-byte salt sent by the client, or undefined for anything else. */
export const parsePasswordSalt = (value: unknown) => decodeFixedBytes(value, passwordSaltBytes);

/** A password set by setup, account creation or a reset: `{ salt, key }`, both base64url. Returns the `scrypt-c` row. */
export async function passwordHashFromCredential(value: unknown): Promise<string | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { salt, key, ...extra } = value as Record<string, unknown>;
  const saltBytes = parsePasswordSalt(salt); const keyBytes = parsePasswordKey(key);
  return saltBytes && keyBytes && !Object.keys(extra).length ? clientPasswordHash(saltBytes, keyBytes) : undefined;
}

/** Compares K with a `scrypt-c` row in constant time. Any other row, or a malformed K, is false. */
export async function verifyPasswordKey(key: Uint8Array, encoded: string | null | undefined): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  const actual = await passwordVerifier(key);
  return parsed?.format === "scrypt-c" && key.length === passwordScrypt.dkLen && constantTimeEqual(actual, parsed.verifier);
}

/** The one server-side scrypt left: checks the password against a legacy `scrypt$` row before it is re-salted. */
export async function verifyLegacyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (parsed?.format !== "scrypt" || !password) return false;
  return constantTimeEqual(await derivePasswordKey(password, parsed.salt), parsed.key);
}

/**
 * The salt the params endpoint gives for a username with no `scrypt-c` password (unknown, inactive or Google-only): the
 * first 16 bytes of HMAC-SHA256(HMAC(SESSION_KEY, "lancerlogin:pw-salt"), username). It is the same on every request and
 * looks like a stored salt, so the response doesn't reveal which usernames exist. It replaces the old timing equalizer.
 */
export async function fakePasswordSalt(secret: string, username: string): Promise<string> {
  const keyBytes = decodeBase64Url(secret);
  if (keyBytes.length < 32) throw new Error("SESSION_KEY must contain at least 32 random bytes");
  const root = await crypto.subtle.importKey("raw", asArrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, encoder.encode("lancerlogin:pw-salt")));
  const saltKey = await crypto.subtle.importKey("raw", asArrayBuffer(derived), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", saltKey, encoder.encode(username))).slice(0, passwordSaltBytes));
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

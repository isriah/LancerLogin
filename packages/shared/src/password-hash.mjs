// Local-account password storage ("server relief"). The browser runs scrypt on the password and sends the 32-byte result
// K; the Worker stores and compares only SHA-256("lancerlogin:password:v2" ‖ K). That keeps sign-in far under the Workers
// Free plan's 10 ms CPU limit while an offline attacker with a stored hash still pays a full scrypt N=32768 per guess.
// This module has no scrypt in it, so the Worker, the dashboard's main bundle and scripts can share the format cheaply.
// The scrypt step itself is in password-key.mjs, which the dashboard loads only on the pages that hash.

/** The exact scrypt parameters. The server accepts these and nothing else, the same strictness as the legacy format. */
export const passwordScrypt = Object.freeze({ N: 32_768, r: 8, p: 1, dkLen: 32 });
export const passwordSaltBytes = 16;
/**
 * The minimum length for a new password. The server never sees the password any more, so it cannot check this: the
 * dashboard and the reset script enforce it. Only the person choosing a password (the setup operator, or an Admin
 * creating or resetting an account) could bypass it, and only for a password they choose themselves.
 */
export const minimumPasswordLength = 12;
/** Domain separation for the stored verifier, so K is never stored or compared as-is. */
export const passwordVerifierLabel = "lancerlogin:password:v2";
/** New rows: `scrypt-c$N$r$p$<salt>$<SHA-256(label ‖ K)>`. Legacy rows, still verified once on the server: `scrypt$N$r$p$<salt>$<K>`. */
export const clientPasswordFormat = "scrypt-c";
export const legacyPasswordFormat = "scrypt";

export function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Strict decoding: anything that isn't unpadded base64url gives undefined rather than a best guess. */
export function decodeBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  try { return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); } catch { return undefined; }
}

/** A base64url value that decodes to exactly `length` bytes, or undefined. */
export function decodeFixedBytes(text, length) {
  const bytes = decodeBase64Url(text);
  return bytes && bytes.length === length && encodeBase64Url(bytes) === text ? bytes : undefined;
}

/** Compares every byte whatever the first difference, so the time taken doesn't reveal where two values differ. */
export function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

const encoder = new TextEncoder();

/** SHA-256(label ‖ K): the only password-derived value a `scrypt-c` row holds. */
export async function passwordVerifier(key) {
  const label = encoder.encode(passwordVerifierLabel);
  const input = new Uint8Array(label.length + key.length);
  input.set(label); input.set(key, label.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

/** The stored `scrypt-c` value for a salt and the browser's K. The dashboard never needs this; the Worker and scripts do. */
export async function clientPasswordHash(salt, key) {
  if (salt.length !== passwordSaltBytes || key.length !== passwordScrypt.dkLen) throw new Error("Password salt or key has the wrong length");
  const { N, r, p } = passwordScrypt;
  return `${clientPasswordFormat}$${N}$${r}$${p}$${encodeBase64Url(salt)}$${encodeBase64Url(await passwordVerifier(key))}`;
}

/**
 * Reads a stored hash with the exact parameters. Returns undefined for anything else, including other parameters, a
 * missing field or the wrong lengths, so a malformed row never signs in.
 */
export function parsePasswordHash(encoded) {
  if (typeof encoded !== "string") return undefined;
  const parts = encoded.split("$");
  if (parts.length !== 6) return undefined;
  const [format, cost, blockSize, parallel, saltText, valueText] = parts;
  const { N, r, p, dkLen } = passwordScrypt;
  if (cost !== String(N) || blockSize !== String(r) || parallel !== String(p)) return undefined;
  const salt = decodeBase64Url(saltText); const value = decodeFixedBytes(valueText, 32);
  // Legacy rows were written with 16-byte salts by both the Worker and the reset script; accept any non-empty salt there.
  if (!salt?.length || !value) return undefined;
  if (format === clientPasswordFormat) return salt.length === passwordSaltBytes ? { format, salt, verifier: value } : undefined;
  if (format === legacyPasswordFormat) return dkLen === value.length ? { format, salt, key: value } : undefined;
  return undefined;
}

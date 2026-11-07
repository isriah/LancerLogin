// The scrypt step of local-account passwords. It runs in the browser for sign-in, setup, account creation and identity
// confirmation, in scripts that set or check passwords, and in the Worker only to check a legacy `scrypt$` row once.
// The dashboard imports this module dynamically, so noble scrypt is loaded only on the pages that hash.
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { decodeFixedBytes, encodeBase64Url, minimumPasswordLength, passwordSaltBytes, passwordScrypt } from "./password-hash.mjs";

/**
 * K = scrypt(password, salt, N=32768, r=8, p=1, dkLen=32), the same noble code and parameters the Worker used before.
 * The password is UTF-8 exactly as typed, with no normalization, so the legacy and new paths agree byte for byte.
 * asyncTick yields to the event loop every few milliseconds, so the page keeps painting its busy state while it hashes.
 */
export function derivePasswordKey(password, salt) {
  if (typeof password !== "string" || !password) throw new Error("A password is required");
  return scryptAsync(password, salt, { ...passwordScrypt, maxmem: 64 * 1024 * 1024, asyncTick: 10 });
}

export function newPasswordSalt() {
  return crypto.getRandomValues(new Uint8Array(passwordSaltBytes));
}

/**
 * The value to send when setting a password: a fresh salt and K, both base64url. The server can't see the password, so
 * this is where the minimum length is enforced; the forms also enforce it with minLength before submitting.
 */
export async function newPasswordCredential(password) {
  if (typeof password !== "string" || password.length < minimumPasswordLength) throw new Error(`The password must be at least ${minimumPasswordLength} characters`);
  const salt = newPasswordSalt();
  return { salt: encodeBase64Url(salt), key: encodeBase64Url(await derivePasswordKey(password, salt)) };
}

/**
 * The proof to send for a sign-in or identity confirmation, from the salt endpoint's answer. For a legacy row the server
 * asks for the password too, checks it once with server-side scrypt and then stores the new K under the salt it sent.
 */
export async function passwordProof(password, params) {
  const salt = decodeFixedBytes(params?.salt, passwordSaltBytes);
  const { N, r, p, dkLen } = passwordScrypt;
  if (!salt || params.N !== N || params.r !== r || params.p !== p || params.dkLen !== dkLen) throw new Error("The password parameters are not supported");
  const key = encodeBase64Url(await derivePasswordKey(password, salt));
  return params.legacy ? { key, salt: params.salt, password } : { key };
}

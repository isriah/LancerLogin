import { HttpError } from "./http-error.ts";

export const fingerprintVaultFormat = "r503-model-1536";
export type FingerprintVaultBinding = { vaultId: string; keyId: string; fingerprintId: string; memberId: string; templateDigest: string; sourceKioskId: string; sourcePairingId: string; enrollmentId: string; createdAt: number };
const encode = (value: string) => new TextEncoder().encode(value);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
export const fingerprintVaultBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export function fingerprintVaultDecode(value: unknown, size: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length !== Math.ceil(size / 3) * 4) throw new HttpError(400, "Invalid fingerprint template");
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    if (bytes.length !== size || fingerprintVaultBase64(bytes) !== value) throw new Error();
    return bytes;
  } catch { throw new HttpError(400, "Invalid fingerprint template"); }
}
function keyBytes(secret: string | undefined): Uint8Array<ArrayBuffer> {
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new HttpError(503, "Fingerprint cloud storage needs its separate encryption key. Preserve or restore FINGERPRINT_VAULT_KEY before enabling it.");
  try { return fingerprintVaultDecode(secret.replace(/-/g, "+").replace(/_/g, "/") + "=", 32); }
  catch { throw new HttpError(503, "Fingerprint cloud storage needs a valid separate FINGERPRINT_VAULT_KEY. Recover the original key without changing stored data."); }
}
export async function fingerprintVaultKeyId(secret: string | undefined): Promise<string> {
  const bytes = keyBytes(secret);
  try { return hex(await crypto.subtle.digest("SHA-256", bytes)); }
  finally { bytes.fill(0); }
}
async function derivedKey(secret: string, purpose: "encryption" | "digest", usages: KeyUsage[]) {
  const bytes = keyBytes(secret);
  try {
    const root = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encode("LancerLogin fingerprint vault v1"), info: encode(purpose) }, root,
      purpose === "encryption" ? { name: "AES-GCM", length: 256 } : { name: "HMAC", hash: "SHA-256", length: 256 }, false, usages);
  } finally { bytes.fill(0); }
}
export async function fingerprintVaultDigest(secret: string, template: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await derivedKey(secret, "digest", ["sign"]), template));
}
export async function fingerprintVaultId(binding: Omit<FingerprintVaultBinding, "fingerprintId">): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encode(JSON.stringify(["LancerLogin fingerprint vault identity v1", "primary", fingerprintVaultFormat, binding.vaultId, binding.keyId, binding.memberId, binding.templateDigest]))));
}
// Content digests authenticate bytes; source enrollment identity survives reader
// evolution. Keep the older identity function for historical record decoding.
export async function fingerprintVaultEnrollmentId(binding: Omit<FingerprintVaultBinding, "fingerprintId">): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encode(JSON.stringify(["LancerLogin fingerprint enrollment v2", "primary", binding.vaultId, binding.keyId, binding.memberId, binding.sourceKioskId, binding.sourcePairingId, binding.enrollmentId]))));
}
function aad(binding: FingerprintVaultBinding) {
  return encode(JSON.stringify(["LancerLogin fingerprint vault v1", "primary", fingerprintVaultFormat, binding.vaultId, binding.keyId, binding.fingerprintId, binding.memberId, binding.templateDigest, binding.sourceKioskId, binding.sourcePairingId, binding.enrollmentId, binding.createdAt]));
}
export async function sealFingerprintVault(template: Uint8Array<ArrayBuffer>, binding: FingerprintVaultBinding, secret: string): Promise<{ ciphertext: string; nonce: string }> {
  if (template.length !== 1536) throw new HttpError(400, "Invalid fingerprint template");
  const nonce = crypto.getRandomValues(new Uint8Array(12)), key = await derivedKey(secret, "encryption", ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(binding), tagLength: 128 }, key, template));
  try { return { ciphertext: fingerprintVaultBase64(ciphertext), nonce: fingerprintVaultBase64(nonce) }; }
  finally { ciphertext.fill(0); }
}
export async function openFingerprintVault(record: { ciphertext: string; nonce: string }, binding: FingerprintVaultBinding, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  let template: Uint8Array<ArrayBuffer> | undefined;
  try {
    const key = await derivedKey(secret, "encryption", ["decrypt"]);
    template = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fingerprintVaultDecode(record.nonce, 12), additionalData: aad(binding), tagLength: 128 }, key, fingerprintVaultDecode(record.ciphertext, 1552)));
    if (template.length !== 1536 || await fingerprintVaultDigest(secret, template) !== binding.templateDigest) throw new Error();
    const result = template; template = undefined; return result;
  } catch { throw new HttpError(503, "Fingerprint cloud storage could not be decrypted. Preserve the stored data and recover the original vault key before retrying."); }
  finally { template?.fill(0); }
}

// The web kiosk's local settings PIN: 6 to 12 digits chosen on the device when it pairs, guarding the maintenance
// screen. Only a salted PBKDF2-SHA256 hash is kept in the browser's storage, never the PIN.

export type SettingsPinHash = { salt: string; hash: string; iterations: number };

export const settingsPinIterations = 100_000;
export const settingsPinMinLength = 6;
export const settingsPinMaxLength = 12;

export function validSettingsPin(pin: string) {
  return new RegExp(`^\\d{${settingsPinMinLength},${settingsPinMaxLength}}$`).test(pin);
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number, subtle: SubtleCrypto) {
  const key = await subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}

/** A new salted hash of the PIN. */
export async function hashSettingsPin(pin: string, options: { iterations?: number; cryptoImpl?: Crypto } = {}): Promise<SettingsPinHash> {
  if (!validSettingsPin(pin)) throw new Error(`The settings PIN must be ${settingsPinMinLength} to ${settingsPinMaxLength} digits.`);
  const cryptoImpl = options.cryptoImpl ?? globalThis.crypto; const iterations = options.iterations ?? settingsPinIterations;
  const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
  return { salt: toBase64(salt), hash: toBase64(await derive(pin, salt, iterations, cryptoImpl.subtle)), iterations };
}

/**
 * True when the PIN derives the stored PBKDF2-SHA256 hash (a 256-bit key). Compares every byte so the time taken doesn't
 * depend on where they differ. A malformed stored hash, or more than `maxIterations`, never matches.
 */
export async function verifyPinHash(pin: string, stored: SettingsPinHash, { cryptoImpl = globalThis.crypto, maxIterations = Number.MAX_SAFE_INTEGER }: { cryptoImpl?: Crypto; maxIterations?: number } = {}) {
  if (!stored || typeof stored.salt !== "string" || typeof stored.hash !== "string" || !stored.salt || !stored.hash || !Number.isSafeInteger(stored.iterations) || stored.iterations < 1 || stored.iterations > maxIterations) return false;
  let salt: Uint8Array, expected: Uint8Array;
  try { salt = fromBase64(stored.salt); expected = fromBase64(stored.hash); } catch { return false; }
  const actual = await derive(pin, salt, stored.iterations, cryptoImpl.subtle);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}

/** True when the PIN matches the stored hash. */
export async function verifySettingsPin(pin: string, stored: SettingsPinHash, cryptoImpl: Crypto = globalThis.crypto) {
  return validSettingsPin(pin) && await verifyPinHash(pin, stored, { cryptoImpl });
}

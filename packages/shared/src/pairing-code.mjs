// One-time web kiosk pairing codes: 8 characters an Admin reads off the dashboard and types on a tablet. Letters and
// digits that look alike (0 and O, 1 and I) are left out. A code works once and expires, and pairing is rate-limited.
export const pairingCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const webPairingCodeLength = 8;

/** Uppercase, without spaces, dashes or anything else that isn't a letter or digit: "k7q2-m9xd" is "K7Q2M9XD". */
export function normalizePairingCode(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function validWebPairingCode(input) {
  const code = normalizePairingCode(input);
  return code.length === webPairingCodeLength && [...code].every((character) => pairingCodeAlphabet.includes(character));
}

/** "K7Q2M9XD" as "K7Q2-M9XD", easier to read aloud. */
export function formatPairingCode(input) {
  const code = normalizePairingCode(input);
  return code.length === webPairingCodeLength ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * A new code from randomBytes(count), which returns that many random bytes (crypto.getRandomValues or
 * node:crypto.randomBytes). Bytes at or above the largest multiple of the alphabet size are skipped, so every
 * character is equally likely.
 */
export function generateWebPairingCode(randomBytes) {
  const limit = 256 - (256 % pairingCodeAlphabet.length);
  let code = "";
  while (code.length < webPairingCodeLength) {
    for (const byte of randomBytes(16)) {
      if (byte < limit && code.length < webPairingCodeLength) code += pairingCodeAlphabet[byte % pairingCodeAlphabet.length];
    }
  }
  return code;
}

export const pairingCodeAlphabet: string;
export const webPairingCodeLength: number;
export function normalizePairingCode(input: unknown): string;
export function validWebPairingCode(input: unknown): boolean;
export function formatPairingCode(input: unknown): string;
export function generateWebPairingCode(randomBytes: (count: number) => ArrayLike<number> & Iterable<number>): string;

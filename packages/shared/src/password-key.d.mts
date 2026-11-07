/** The salt endpoint's answer: the same shape for every username, known or not. */
export type PasswordParams = { algorithm: "scrypt"; N: number; r: number; p: number; dkLen: number; salt: string; legacy: boolean };
export type PasswordCredential = { salt: string; key: string };
export type PasswordProof = { key: string } | { key: string; salt: string; password: string };
export function derivePasswordKey(password: string, salt: Uint8Array): Promise<Uint8Array>;
export function newPasswordSalt(): Uint8Array;
export function newPasswordCredential(password: string): Promise<PasswordCredential>;
export function passwordProof(password: string, params: PasswordParams): Promise<PasswordProof>;

// Local-account passwords are hashed in the browser ("server relief"): scrypt runs here and the Worker stores and compares
// only a SHA-256 of the result. noble scrypt is loaded with a dynamic import, so it is fetched only by the pages that hash
// a password (sign-in, first-Admin setup, account creation and identity confirmation), never by the main bundle.
import type { PasswordCredential, PasswordParams, PasswordProof } from "../../../packages/shared/src/password-key.mjs";

export type { PasswordCredential, PasswordParams, PasswordProof };

const passwordKeyModule = () => import("../../../packages/shared/src/password-key.mjs");

/**
 * The minimum length for a new password. The Worker never sees the password, so it can't check this; each form checks it
 * with minLength and again before hashing, and shows the same message the Worker used to send.
 */
export { minimumPasswordLength } from "../../../packages/shared/src/password-hash.mjs";

/** `{ salt, key }` for setup, a new account or a reset. */
export async function newPasswordCredential(password: string): Promise<PasswordCredential> {
  return (await passwordKeyModule()).newPasswordCredential(password);
}

/** The body for a sign-in or identity confirmation, from the Worker's salt and parameters. */
export async function passwordProof(password: string, params: PasswordParams): Promise<PasswordProof> {
  return (await passwordKeyModule()).passwordProof(password, params);
}

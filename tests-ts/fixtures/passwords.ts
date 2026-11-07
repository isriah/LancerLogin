// Synthetic password rows and request bodies for Worker tests, built with the same shared code the dashboard and scripts
// use, so a test that passes here proves the client and the Worker agree.
import { clientPasswordHash, encodeBase64Url } from "../../packages/shared/src/password-hash.mjs";
import { derivePasswordKey, newPasswordCredential, newPasswordSalt, passwordProof, type PasswordParams } from "../../packages/shared/src/password-key.mjs";

/** A `scrypt-c` row, as setup, account creation, a reset or the reset script now writes it. */
export async function storedPassword(password: string, salt = newPasswordSalt()): Promise<string> {
  return clientPasswordHash(salt, await derivePasswordKey(password, salt));
}

/** A legacy `scrypt$` row, byte for byte what the Worker wrote before server relief. */
export async function legacyPassword(password: string, salt = newPasswordSalt()): Promise<string> {
  return `scrypt$32768$8$1$${encodeBase64Url(salt)}$${encodeBase64Url(await derivePasswordKey(password, salt))}`;
}

/** `{ salt, key }` for setup, POST /admin/users or a reset. */
export const passwordCredential = (password: string) => newPasswordCredential(password);

/** A well-formed K that matches nothing, for wrong-password attempts without paying for scrypt. */
export const randomKey = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** Signs in as the dashboard does: POST /auth/local/params, scrypt in "the browser", then POST /auth/local. */
export async function localSignIn(post: (path: string, body: unknown) => Promise<Response>, username: string, password: string): Promise<Response> {
  const params = await post("/auth/local/params", { username });
  if (!params.ok) return params;
  return post("/auth/local", { username, ...await passwordProof(password, await params.json() as PasswordParams) });
}

/** Identity confirmation as the dashboard does it, for the signed-in Admin behind `post`. */
export async function reauthenticate(post: (path: string, body: unknown) => Promise<Response>, password: string, purpose?: string): Promise<Response> {
  const params = await post("/admin/plugins/reauthenticate/params", {});
  if (!params.ok) return params;
  return post("/admin/plugins/reauthenticate", { ...await passwordProof(password, await params.json() as PasswordParams), ...(purpose ? { purpose } : {}) });
}

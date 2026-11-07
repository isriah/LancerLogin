#!/usr/bin/env node
import { spawn } from "node:child_process";
import { clientPasswordHash, minimumPasswordLength } from "../packages/shared/src/password-hash.mjs";
import { derivePasswordKey, newPasswordSalt } from "../packages/shared/src/password-key.mjs";
import { verifyCloudflareAccountToken } from "./select-cloudflare-account.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
const database = args.database; const username = args.username?.toLowerCase();
if (!database || !/^[a-z][a-z0-9-]{2,62}$/.test(database) || !username || !/^[a-z0-9._-]{3,64}$/.test(username)) {
  console.error("Usage: npm run reset-password -- --database <installation-slug-data> --username <local-username>"); process.exit(2);
}
if (!process.stdin.isTTY) { console.error("Password reset requires an interactive terminal."); process.exit(2); }
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const configuredAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!apiToken || !configuredAccountId) { console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for the selected adopter-owned account."); process.exit(2); }

let accountId;
try { accountId = await verifyCloudflareAccountToken(apiToken, configuredAccountId); } catch (error) { console.error(error.message); process.exit(2); }

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt); let value = ""; process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
    const input = (character) => { if (character === "\r" || character === "\n") { process.stdin.off("data", input); process.stdin.setRawMode?.(false); process.stdin.pause(); process.stdout.write("\n"); resolve(value); } else if (character === "\u0003") process.exit(130); else if (character === "\u007f" || character === "\b") value = value.slice(0, -1); else value += character; };
    process.stdin.on("data", input);
  });
}
const password = await readHidden("New local password (at least 12 characters): ");
const confirmation = await readHidden("Confirm new local password: ");
// The Worker no longer sees passwords, so this script, like the dashboard, is where the minimum length is enforced.
if (password !== confirmation || password.length < minimumPasswordLength) { console.error("Passwords must match and contain at least 12 characters."); process.exit(2); }

// The same `scrypt-c` row the dashboard produces: scrypt runs here, and D1 stores only SHA-256("lancerlogin:password:v2" + K).
const salt = newPasswordSalt();
const hash = await clientPasswordHash(salt, await derivePasswordKey(password, salt));
const command = `UPDATE users SET password_hash = '${hash}', failed_login_count = 0, locked_until = NULL WHERE installation_id = 'primary' AND local_username = '${username}'; SELECT changes() AS passwords_reset;`;
const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(executable, ["wrangler", "d1", "execute", database, "--remote", "--command", command], { stdio: "inherit", shell: false, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } });
child.on("exit", (code) => process.exit(code ?? 1));

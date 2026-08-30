#!/usr/bin/env node
import { spawn } from "node:child_process";
import { scryptAsync } from "@noble/hashes/scrypt.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
const database = args.database; const username = args.username?.toLowerCase();
if (!database || !/^[a-z][a-z0-9-]{2,62}$/.test(database) || !username || !/^[a-z0-9._-]{3,64}$/.test(username)) {
  console.error("Usage: npm run reset-password -- --database <installation-slug-data> --username <local-username>"); process.exit(2);
}
if (!process.stdin.isTTY) { console.error("Password reset requires an interactive terminal."); process.exit(2); }

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt); let value = ""; process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
    const input = (character) => { if (character === "\r" || character === "\n") { process.stdin.off("data", input); process.stdin.setRawMode?.(false); process.stdin.pause(); process.stdout.write("\n"); resolve(value); } else if (character === "\u0003") process.exit(130); else if (character === "\u007f" || character === "\b") value = value.slice(0, -1); else value += character; };
    process.stdin.on("data", input);
  });
}
const password = await readHidden("New local password (at least 12 characters): ");
const confirmation = await readHidden("Confirm new local password: ");
if (password !== confirmation || password.length < 12) { console.error("Passwords must match and contain at least 12 characters."); process.exit(2); }

const salt = crypto.getRandomValues(new Uint8Array(16)); const options = { N: 32_768, r: 8, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024, asyncTick: 5 };
const encoded = (value) => Buffer.from(value).toString("base64url");
const hash = `scrypt$${options.N}$${options.r}$${options.p}$${encoded(salt)}$${encoded(await scryptAsync(password, salt, options))}`;
const command = `UPDATE users SET password_hash = '${hash}' WHERE installation_id = 'primary' AND local_username = '${username}'; SELECT changes() AS passwords_reset;`;
const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(executable, ["wrangler", "d1", "execute", database, "--remote", "--command", command], { stdio: "inherit", shell: false, env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));

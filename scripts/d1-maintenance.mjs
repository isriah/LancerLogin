#!/usr/bin/env node
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { verifyCloudflareAccountToken } from "./select-cloudflare-account.mjs";

export function parseD1MaintenanceArgs(argv) {
  const [operation, ...values] = argv;
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--") || !values[index + 1] || values[index + 1].startsWith("--")) throw new Error("Options must use --name value");
    options[value.slice(2)] = values[index + 1];
    index += 1;
  }
  if (!["backup", "restore"].includes(operation)) throw new Error("Choose backup or restore");
  if (!/^[a-z][a-z0-9-]{2,62}-data$/.test(options.database ?? "")) throw new Error("--database must be an installation database ending in -data");
  const file = operation === "backup" ? options.output : options.file;
  if (!file) throw new Error(operation === "backup" ? "--output is required" : "--file is required");
  if (operation === "restore" && options.confirm !== `RESTORE ${options.database}`) throw new Error(`Restore requires --confirm "RESTORE ${options.database}"`);
  return { operation, database: options.database, file: resolve(file) };
}

export function wranglerD1Args({ operation, database, file }) {
  return operation === "backup"
    ? ["wrangler", "d1", "export", database, "--remote", "--output", file]
    : ["wrangler", "d1", "execute", database, "--remote", "--file", file];
}

export async function runD1Maintenance(config, dependencies = {}) {
  const accessImpl = dependencies.accessImpl ?? access;
  if (config.operation === "backup") {
    try { await accessImpl(config.file); throw new Error(`Refusing to overwrite existing backup: ${config.file}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  } else {
    try { await accessImpl(config.file); }
    catch { throw new Error(`Restore file is not readable: ${config.file}`); }
  }
  const accountId = await verifyCloudflareAccountToken(process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID, dependencies.fetchImpl);
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  return await new Promise((resolveExit, reject) => {
    const child = spawnImpl(executable, wranglerD1Args(config), {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

async function main() {
  const config = parseD1MaintenanceArgs(process.argv.slice(2));
  const code = await runD1Maintenance(config);
  process.exitCode = code;
}

if (process.argv[1]?.endsWith("d1-maintenance.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 2; });

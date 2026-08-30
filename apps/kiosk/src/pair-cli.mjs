#!/usr/bin/env node
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pairInstallation } from "./cloud-client.mjs";

const [apiUrl, code, kioskName = "Main kiosk", output = "/var/lib/lancerlogin/pairing.json"] = process.argv.slice(2);
if (!apiUrl || !code) { console.error("Usage: pair-cli.mjs <worker-api-url> <one-time-code> [kiosk-name] [output-file]"); process.exit(2); }

try {
  const config = await pairInstallation({ apiUrl, code, kioskName });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, output);
  await chmod(output, 0o600);
  console.log(`Paired ${config.kioskName}. Credentials saved with owner-only permissions.`);
} catch (error) { console.error(error instanceof Error ? error.message : "Pairing failed"); process.exit(1); }

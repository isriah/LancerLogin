import { readFile } from "node:fs/promises";

export function resourceExists(kind, name, payload) {
  const entries = Array.isArray(payload) ? payload : payload.result ?? [];
  if (kind === "pages") return entries.some((entry) => entry.name === name || entry.project_name === name);
  throw new Error(`Unsupported resource kind: ${kind}`);
}

async function main() {
  const [kind, name, path] = process.argv.slice(2);
  if (!kind || !name || !path) throw new Error("Usage: cloudflare-resource-state.mjs <kind> <name> <json-file>");
  const payload = JSON.parse(await readFile(path, "utf8"));
  process.stdout.write(resourceExists(kind, name, payload) ? "exists" : "missing");
}

if (process.argv[1]?.endsWith("cloudflare-resource-state.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

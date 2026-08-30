import { readFile } from "node:fs/promises";

export function selectCloudflareAccount(document) {
  if (!document?.success || !Array.isArray(document.result)) throw new Error("Cloudflare account discovery failed");
  if (document.result.length !== 1) throw new Error("The API token must be restricted to exactly one Cloudflare account");
  const accountId = document.result[0]?.id;
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Cloudflare returned an invalid account identifier");
  return accountId;
}

async function main() {
  const [input] = process.argv.slice(2);
  if (!input) throw new Error("Usage: select-cloudflare-account.mjs <accounts-response.json>");
  process.stdout.write(selectCloudflareAccount(JSON.parse(await readFile(input, "utf8"))));
}

if (process.argv[1]?.endsWith("select-cloudflare-account.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

import { readFile } from "node:fs/promises";

export function selectCloudflareAccount(document) {
  if (!document?.success || !Array.isArray(document.result)) throw new Error("Cloudflare account discovery failed");
  if (document.result.length !== 1) throw new Error("The API token must be restricted to exactly one Cloudflare account");
  const accountId = document.result[0]?.id;
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Cloudflare returned an invalid account identifier");
  return accountId;
}

export async function discoverCloudflareAccount(apiToken, fetchImpl = fetch) {
  if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN to a token restricted to exactly one adopter-owned account");
  let response;
  try {
    response = await fetchImpl("https://api.cloudflare.com/client/v4/accounts", {
      headers: { authorization: `Bearer ${apiToken}`, accept: "application/json" },
    });
  } catch {
    throw new Error("Could not reach Cloudflare to discover the token's account");
  }
  const document = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error("Cloudflare account discovery failed. Check the scoped token and try again");
  return selectCloudflareAccount(document);
}

async function main() {
  const [input] = process.argv.slice(2);
  if (!input) throw new Error("Usage: select-cloudflare-account.mjs <accounts-response.json>");
  process.stdout.write(selectCloudflareAccount(JSON.parse(await readFile(input, "utf8"))));
}

if (process.argv[1]?.endsWith("select-cloudflare-account.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

import { mkdir, readFile, writeFile } from "node:fs/promises";

const slugPattern = /^[a-z][a-z0-9-]{2,40}$/;

export function buildProvisionConfig(slug, databases = []) {
  if (!slugPattern.test(slug)) throw new Error("Invalid installation slug");
  const databaseName = `${slug}-data`;
  const database = databases.find((entry) => entry.name === databaseName);
  const databaseId = database?.uuid ?? database?.database_id ?? database?.id;
  const config = { name: `${slug}-api`, main: "../apps/api/src/index.ts", compatibility_date: "2026-08-01", workers_dev: true, vars: { APP_MODE: "configured", ALLOWED_ORIGIN: `https://${slug}-dashboard.pages.dev`, RELEASE_VERSION: "0.1.0" }, triggers: { crons: ["0 3 * * *"] } };
  if (databaseId) config.d1_databases = [{ binding: "DB", database_name: databaseName, database_id: databaseId, migrations_dir: "../apps/api/migrations" }];
  return { state: databaseId ? "exists" : "missing", config };
}

async function main() {
  const [slug, listPath] = process.argv.slice(2);
  if (!slug) throw new Error("Usage: prepare-cloudflare-provision.mjs <slug> [d1-list.json]");
  let databases = [];
  if (listPath) { const parsed = JSON.parse(await readFile(listPath, "utf8")); databases = Array.isArray(parsed) ? parsed : parsed.result ?? []; }
  const result = buildProvisionConfig(slug, databases);
  await mkdir(".provision", { recursive: true });
  await writeFile(".provision/wrangler.json", `${JSON.stringify(result.config, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(result.state);
}

if (process.argv[1]?.endsWith("prepare-cloudflare-provision.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

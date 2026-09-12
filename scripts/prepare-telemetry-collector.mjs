import { mkdir, readFile, writeFile } from "node:fs/promises";

const databaseName = "lancerlogin-community-telemetry";

export function buildTelemetryCollectorConfig(databases = [], options = {}) {
  const database = databases.find((entry) => entry.name === databaseName);
  const databaseId = database?.uuid ?? database?.database_id ?? database?.id;
  const namespace = (value, fallback) => {
    const selected = String(value ?? fallback);
    if (!/^[1-9]\d{0,9}$/.test(selected)) throw new Error("Rate-limit namespace IDs must be positive integers");
    return selected;
  };
  const globalNamespaceId = namespace(options.globalNamespaceId, "47411001");
  const installNamespaceId = namespace(options.installNamespaceId, "47411002");
  if (globalNamespaceId === installNamespaceId) throw new Error("Rate-limit namespace IDs must be different");
  const config = {
    name: "lancerlogin-community-telemetry",
    main: "../apps/telemetry-collector/src/index.ts",
    compatibility_date: "2026-08-01",
    workers_dev: true,
    observability: { enabled: false },
    vars: { RETENTION_DAYS: "30", MAX_DAILY_NEW_INSTALLS: "10000" },
    triggers: { crons: ["17 4 * * *"] },
    ratelimits: [
      { name: "GLOBAL_LIMITER", namespace_id: globalNamespaceId, simple: { limit: 300, period: 60 } },
      { name: "INSTALL_LIMITER", namespace_id: installNamespaceId, simple: { limit: 6, period: 60 } },
    ],
  };
  if (databaseId) config.d1_databases = [{ binding: "DB", database_name: databaseName, database_id: databaseId, migrations_dir: "../apps/telemetry-collector/migrations" }];
  return { state: databaseId ? "exists" : "missing", config };
}

async function main() {
  const [listPath, globalNamespaceId, installNamespaceId] = process.argv.slice(2);
  let databases = [];
  if (listPath) { const parsed = JSON.parse(await readFile(listPath, "utf8")); databases = Array.isArray(parsed) ? parsed : parsed.result ?? []; }
  const result = buildTelemetryCollectorConfig(databases, { globalNamespaceId, installNamespaceId });
  await mkdir(".collector", { recursive: true });
  await writeFile(".collector/wrangler.json", `${JSON.stringify(result.config, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(result.state);
}

if (process.argv[1]?.endsWith("prepare-telemetry-collector.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

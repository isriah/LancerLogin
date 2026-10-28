import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Written by scripts/compose-modules.mjs (stagedMigrationManifest) for every composition.
export const stagedMigrationManifestPath = ".provision/module-migrations.json";

/**
 * The installation workflow's upgrade and resume paths run this after composition and before any build, migration or
 * deployment. Like the web update controller's preflight, it refuses to deploy a build that would drop a module that
 * moved out of LancerLogin into a plugin while the installation still uses it (enabled, retained, being deleted, or
 * holding its own data). Nothing in the installation is changed; the D1 query only reads.
 */
export async function composedModuleIds(read = (path) => readFile(path, "utf8")) {
  let text;
  try { text = await read(stagedMigrationManifestPath); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const staged = JSON.parse(text);
  if (staged?.format !== 1 || !Array.isArray(staged.modules)) throw new Error("module_composition_record_invalid");
  return staged.modules.map((module) => String(module.id));
}

export async function provisionModuleRefusal({ composed, query }) {
  const { extractedModulesInUse } = await import("../apps/api/src/extracted-modules.ts");
  return (await extractedModulesInUse(query, new Set(composed))).map((module) => ({ id: module.id, label: module.label }));
}

export function d1Query({ accountId, apiToken, databaseId, request = fetch }) {
  if (!/^[0-9a-f]{32}$/.test(accountId ?? "") || !apiToken?.startsWith("cfat_")) throw new Error("scoped_account_credential_required");
  if (!/^[0-9a-f-]{36}$/.test(databaseId ?? "")) throw new Error("fixed_database_required");
  return async (sql, params = []) => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: "POST", headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("database_request_failed");
    const document = await response.json();
    if (!document.success || document.result?.some((entry) => entry.success === false)) throw new Error("database_query_failed");
    return document.result?.[0]?.results ?? [];
  };
}

async function main() {
  const config = JSON.parse(await readFile(resolve(process.env.WEB_UPDATE_CONFIG ?? ".provision/wrangler.json"), "utf8"));
  const databaseId = config.d1_databases?.find((binding) => binding.binding === "DB")?.database_id;
  const query = d1Query({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, apiToken: process.env.CLOUDFLARE_API_TOKEN, databaseId });
  const inUse = await provisionModuleRefusal({ composed: await composedModuleIds(), query });
  if (!inUse.length) { console.log("No module that moved into a plugin would be dropped."); return; }
  console.error(`Upgrade refused before any change: ${inUse.map((module) => `${module.label} (${module.id})`).join(" and ")} ${inUse.length > 1 ? "are" : "is"} in use and now a separate plugin that this build does not include.`);
  console.error("Add the module's plugin entry (scripts/known-modules.json lists its repository and released commit) to lancerlogin.modules.json in this private repository, or disable the module in Settings > Modules and let its data be deleted, then run the upgrade again. See docs/MODULE-PLUGINS.md.");
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("check-provision-modules.mjs")) main().catch((error) => { console.error(`Module check failed before any change: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; });

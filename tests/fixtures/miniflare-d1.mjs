// quick-check: covers apps/api/migrations/**
// Real local D1 (Miniflare's workerd) with Core migrations, for tests that need D1's own SQL engine and batch semantics.
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const migrationDirectory = new URL("../../apps/api/migrations/", import.meta.url);

/** Every Core migration file name, in order. */
export const coreMigrationNames = () => readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort();

/**
 * Run one Core migration on a D1 database. D1's exec() runs one statement per line, so comment lines are dropped and the
 * file is joined into one line first.
 */
export async function applyMigration(database, name) {
  await database.exec(readFileSync(new URL(name, migrationDirectory), "utf8").replace(/^\s*--.*$/gm, "").replace(/\r?\n/g, " "));
}

/**
 * A Miniflare runtime whose `DB` binding has the given Core migrations applied (all of them by default). Other options are
 * Miniflare's own, such as `script` and `bindings`; without a script the runtime serves a placeholder Worker. Dispose of
 * `runtime` when done; it is disposed of here if a migration fails.
 */
export async function createMiniflareD1({ migrations = coreMigrationNames(), ...options } = {}) {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', compatibilityDate: "2026-08-01", d1Databases: ["DB"], ...options }));
  try {
    const database = await runtime.getD1Database("DB");
    for (const name of migrations) await applyMigration(database, name);
    return { runtime, database };
  } catch (error) { await runtime.dispose(); throw error; }
}

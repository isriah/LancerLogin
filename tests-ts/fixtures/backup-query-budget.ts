// The D1 queries a dashboard backup makes, as the Cloudflare Workers Free plan counts them (50 per invocation; a db.batch()
// is one). Every table is read in one batch, so the count is the same for every scope and does not grow with the number of
// Core or plugin tables. Shared by the Core test and the test with plugins composed.
import assert from "node:assert/strict";
import { reportInstallation } from "./report-query-budget.ts";

type Fetcher = { fetch(request: Request, env: unknown): Promise<Response> };
/** The session check, the one batch of reads, and the audit entry. */
export const backupQueries = 3;
/** A pre-update backup also reads the prepared update request and records that its backup was exported. */
export const updateBackupQueries = backupQueries + 2;
/** A new isolate's first request also checks for update maintenance and reconciles installed modules (two more today). */
export const coldBackupBudget = 10;
const updateRequestId = "11111111-1111-4111-8111-111111111111";

export type BackupMeasurement = { scope: string; queries: number; coldQueries: number; reads: number; tables: number; pluginTables: number; modules: string[] };

/** Measure every backup scope and the pre-update backup on one installation with `enabled` modules. */
export async function measureBackups(worker: Fetcher, enabled: readonly string[]) {
  const installation = await reportInstallation(worker, enabled);
  try {
    const now = new Date().toISOString();
    installation.db.raw.prepare(`INSERT INTO web_update_requests(id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at)
      VALUES(?,'primary','v9.9.9',?,'Synthetic update','9.9.8','prepared',?,?,?)`).run(updateRequestId, "a".repeat(40), now, new Date(Date.now() + 3_600_000).toISOString(), now);
    const results: BackupMeasurement[] = [];
    for (const [scope, query] of [["installation", "scope=installation"], ["meetings", "scope=meetings"], ["roster", "scope=roster"], ["installation before an update", `scope=installation&updateRequestId=${updateRequestId}`]] as const) {
      const warm = await installation.measure(`/admin/data/backup?${query}`);
      const body = JSON.parse(warm.body) as { tables: Record<string, unknown[]>; externalModules?: { id: string; tables: Record<string, unknown[]> }[] };
      const batches = warm.log.filter((entry) => entry.startsWith("batch("));
      assert.equal(batches.length, 1, `${scope}: every table is read in one batch\n${warm.log.join("\n")}`);
      // Nothing outside the batch reads a backed-up table, so the file is one snapshot.
      const lone = warm.log.filter((entry) => !entry.startsWith("batch(") && /^SELECT .* FROM \w+ WHERE (?:installation_id|id) = 'primary'$/.test(entry));
      assert.deepEqual(lone, [], `${scope}: no table is read outside the batch`);
      const pluginTables = (body.externalModules ?? []).reduce((total, module) => total + Object.keys(module.tables).length, 0);
      const reads = Number(/^batch\((\d+)\)/.exec(batches[0]!)![1]);
      // One read per Core table, one per plugin table, the plugin catalog when plugins are composed, the policy settings for a roster.
      assert.equal(reads, Object.keys(body.tables).length + pluginTables + (body.externalModules?.length ? 1 : 0) + (scope === "roster" ? 1 : 0), `${scope}: ${batches[0]}`);
      const cold = scope === "installation before an update" ? warm : await installation.measure(`/admin/data/backup?${query}`, undefined, { cold: true });
      results.push({ scope, queries: warm.queries, coldQueries: cold.queries, reads, tables: Object.keys(body.tables).length, pluginTables, modules: (body.externalModules ?? []).map((module) => module.id) });
      if (scope === "installation before an update") assert.equal(installation.db.raw.prepare("SELECT backup_exported_at IS NOT NULL AS recorded FROM web_update_requests WHERE id = ?").get(updateRequestId)!.recorded, 1, "the pre-update backup is recorded");
    }
    return results;
  } finally { installation.db.raw.close(); }
}

/** The assertions both builds share: a fixed number of queries, whatever the build's tables. */
export function assertBackupBudget(results: readonly BackupMeasurement[]) {
  for (const result of results) {
    assert.equal(result.queries, result.scope === "installation before an update" ? updateBackupQueries : backupQueries, `${result.scope} backup made ${result.queries} D1 queries`);
    assert.ok(result.coldQueries <= coldBackupBudget, `${result.scope} backup made ${result.coldQueries} D1 queries in a new isolate`);
  }
}

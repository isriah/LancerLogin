import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../apps/api/src/index.ts";
import { assertBackupBudget, backupQueries, measureBackups } from "../fixtures/backup-query-budget.ts";

test(`a backup with Outreach and Guest Visits composed still makes ${backupQueries} D1 queries, and a pre-update backup two more`, async (t) => {
  const results = await measureBackups(worker, ["attendance", "hour-tracking", "visits"]);
  for (const result of results) t.diagnostic(`${result.scope}: ${result.queries} D1 queries (${result.coldQueries} in a new isolate), ${result.reads} reads in the batch for ${result.tables} Core tables and ${result.pluginTables} plugin tables`);
  assertBackupBudget(results);
  const installation = results.find((result) => result.scope === "installation")!;
  assert.deepEqual([...installation.modules].sort(), ["hour-tracking", "visits"]);
  assert.ok(installation.pluginTables > 0, "plugin tables are read");
  // Core tables, plugin tables and the plugin catalog, all in the one batch.
  assert.equal(installation.reads, installation.tables + installation.pluginTables + 1);
});

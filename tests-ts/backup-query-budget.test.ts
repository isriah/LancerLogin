// quick-check: covers apps/api/migrations/**
// The D1 queries a dashboard backup makes in a Core build, against the Workers Free plan's 50 per invocation. One read per
// table had reached 51 for an entire-installation backup, which is also the backup a web update requires first.
// tests-ts/backup-query-budget-composed.test.ts pins the same count with Outreach and Guest Visits composed.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/index.ts";
import { assertBackupBudget, backupQueries, measureBackups } from "./fixtures/backup-query-budget.ts";

test(`a Core backup of any scope makes ${backupQueries} D1 queries, and a pre-update backup two more`, async (t) => {
  const results = await measureBackups(worker, ["attendance"]);
  for (const result of results) t.diagnostic(`${result.scope}: ${result.queries} D1 queries (${result.coldQueries} in a new isolate), ${result.reads} reads in the batch for ${result.tables} Core tables`);
  assertBackupBudget(results);
  const installation = results.find((result) => result.scope === "installation")!;
  // A plain test process composes no plugin, so this is the Core-only build.
  assert.deepEqual(installation.modules, []);
  assert.equal(installation.reads, installation.tables);
  assert.ok(installation.tables >= 47, "an entire-installation backup reads every Core table");
});

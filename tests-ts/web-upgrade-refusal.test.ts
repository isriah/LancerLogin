import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { preflightModules, refuseUnclaimedRequest } from "../scripts/run-web-upgrade.mjs";
import { webUpdateStatus } from "../apps/api/src/web-updates.ts";

const id = "55555555-5555-4555-8555-555555555555";
const releaseSha = "b".repeat(40);
const context = { requestId: id, tag: "v2.0.0-beta.12", sha: releaseSha, runId: "91" };
// The exact status write of an installed v2.0.0-beta.11 Worker after GitHub reports a failed run. It cannot be changed.
const beta11FailedRunSql = "UPDATE web_update_requests SET state = ?, error_code = ?, updated_at = ? WHERE installation_id = 'primary' AND id = ? AND state NOT IN ('succeeded','failed','expired','recovery_required')";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("apps/api/migrations").sort()) sqlite.exec(readFileSync(join("apps/api/migrations", file), "utf8"));
  sqlite.exec("INSERT INTO installations (id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'); INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version) VALUES ('primary','carpool',1,1,'enabled',1)");
  return sqlite;
}
function insertRequest(sqlite: DatabaseSync, values: { state: string; run_id?: string | null; executor_run_id?: string | null; error_code?: string | null }) {
  sqlite.prepare("INSERT INTO web_update_requests (id,installation_id,release_tag,release_sha,release_notes,previous_version,state,created_at,expires_at,updated_at,started_at,run_id,executor_run_id,error_code,backup_exported_at) VALUES (?,'primary',?,?,'n','2.0.0-beta.11',?,'2026-01-01','2999-01-01','2026-01-01','2026-01-01',?,?,?,'2026-01-01')")
    .run(id, context.tag, releaseSha, values.state, values.run_id ?? null, values.executor_run_id ?? null, values.error_code ?? null);
}
// The controller's D1 HTTP query shape: one result per statement with its change count.
const controllerSql = (sqlite: DatabaseSync) => async (query: string, params: unknown[] = []) => {
  const statement = sqlite.prepare(query);
  if (/^\s*(SELECT|PRAGMA)/i.test(query)) return [{ results: statement.all(...params as []), meta: { changes: 0 } }];
  return [{ results: [], meta: { changes: Number(statement.run(...params as []).changes) } }];
};
const row = (sqlite: DatabaseSync) => ({ ...sqlite.prepare("SELECT state, stage, error_code, run_id, executor_run_id FROM web_update_requests WHERE id = ?").get(id) });
function workerEnv(sqlite: DatabaseSync) {
  const DB = { prepare(sql: string) {
    let params: unknown[] = [];
    return { bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { return (sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...params as []).changes) } }; } };
  } };
  return { DB, ALLOWED_ORIGIN: "https://example-dashboard.pages.dev", RELEASE_VERSION: "2.0.0-beta.11", UPDATE_REPOSITORY: "example/private-install",
    WEB_UPDATE_TOKEN: "synthetic-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 2 * 86_400_000).toISOString() };
}
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const previous = console.error; console.error = () => {};
  try { return await run(); } finally { console.error = previous; }
}
const preflight = (sqlite: DatabaseSync, overrides: Partial<Parameters<typeof preflightModules>[0]> = {}) => quietly(() => preflightModules({
  pinnedSelectionSha: null, selectionPath: "missing-lancerlogin.modules.json", compose: async () => ["hour-tracking"],
  query: async (query: string, params: unknown[] = []) => (await controllerSql(sqlite)(query, params))[0]!.results,
  refuse: (code: string) => refuseUnclaimedRequest(controllerSql(sqlite), context, code), ...overrides }));

test("a used module refusal fails the unclaimed request with its code, which an installed beta.11 Worker keeps", async () => {
  for (const state of ["dispatching", "queued", "awaiting_approval", "running"]) {
    const sqlite = database(); insertRequest(sqlite, { state, run_id: state === "dispatching" ? null : "91" });
    await assert.rejects(preflight(sqlite), /module_migration_required/);
    assert.deepEqual(row(sqlite), { state: "failed", stage: "preflight", error_code: "module_migration_required:carpool", run_id: "91", executor_run_id: null }, state);
    const polled = sqlite.prepare(beta11FailedRunSql).run("failed", "preflight_failed", "2026-10-27", id);
    assert.equal(Number(polled.changes), 0, "beta.11 leaves a failed request alone");
    assert.equal(row(sqlite).error_code, "module_migration_required:carpool");
  }
  // The plugin-era Worker reports the terminal request without polling GitHub.
  const sqlite = database(); insertRequest(sqlite, { state: "queued", run_id: "91" });
  await assert.rejects(preflight(sqlite), /module_migration_required/);
  const previous = globalThis.fetch; globalThis.fetch = async () => assert.fail("no provider polling for a failed request");
  try {
    const view = await webUpdateStatus(workerEnv(sqlite) as never);
    assert.equal(view.activeRequest, null);
    assert.equal(view.latestCompletedRequest?.state, "failed");
    assert.equal(view.latestCompletedRequest?.errorCode, "module_migration_required:carpool");
    assert.match(view.latestCompletedRequest?.runUrl ?? "", /\/actions\/runs\/91$/);
  } finally { globalThis.fetch = previous; }
});

test("a changed plugin selection refusal fails the unclaimed request with module_selection_preflight", async () => {
  const sqlite = database(); insertRequest(sqlite, { state: "queued", run_id: "91" });
  await assert.rejects(preflight(sqlite, { pinnedSelectionSha: "a".repeat(40) }), /module_selection_changed/);
  assert.deepEqual(row(sqlite), { state: "failed", stage: "preflight", error_code: "module_selection_preflight", run_id: "91", executor_run_id: null });
});

test("a claimed, finished or differently bound request is never touched by a refusal", async () => {
  const cases = [
    { state: "running", run_id: "91", executor_run_id: "91" },
    { state: "verifying", run_id: "91", executor_run_id: "91" },
    { state: "recovery_required", run_id: "91", executor_run_id: null, error_code: "dispatch_unresolved" },
    { state: "succeeded", run_id: "91", executor_run_id: "91" },
    { state: "failed", run_id: "91", executor_run_id: null, error_code: "preflight_failed" },
    { state: "expired", run_id: null, executor_run_id: null },
    { state: "prepared", run_id: null, executor_run_id: null },
    { state: "queued", run_id: "92", executor_run_id: null },
  ];
  for (const values of cases) {
    const sqlite = database(); insertRequest(sqlite, values); const before = row(sqlite);
    await assert.rejects(preflight(sqlite), /module_migration_required/);
    assert.deepEqual(row(sqlite), before, JSON.stringify(values));
  }
  const sqlite = database(); insertRequest(sqlite, { state: "queued", run_id: "91" }); const before = row(sqlite);
  await quietly(() => refuseUnclaimedRequest(controllerSql(sqlite), { ...context, sha: "c".repeat(40) }, "module_migration_required:carpool"));
  assert.deepEqual(row(sqlite), before, "another release's request");
});

test("other preflight failures and a composed module leave the request for the Worker to reconcile", async () => {
  const failures: Array<[Partial<Parameters<typeof preflightModules>[0]>, RegExp]> = [
    [{ pinnedSelectionSha: "not-a-sha" }, /module_selection_invalid/],
    [{ compose: async () => { throw new Error("plugin_incompatible"); } }, /plugin_incompatible/],
    [{ query: async () => { throw new Error("database_query_failed"); } }, /database_query_failed/],
  ];
  for (const [overrides, error] of failures) {
    const sqlite = database(); insertRequest(sqlite, { state: "queued", run_id: "91" }); const before = row(sqlite);
    await assert.rejects(preflight(sqlite, overrides), error);
    assert.deepEqual(row(sqlite), before);
  }
  const sqlite = database(); insertRequest(sqlite, { state: "queued", run_id: "91" }); const before = row(sqlite);
  assert.deepEqual(await preflight(sqlite, { compose: async () => ["hour-tracking", "carpool"] }), ["hour-tracking", "carpool"]);
  assert.deepEqual(row(sqlite), before, "nothing is refused when the module is composed");
});

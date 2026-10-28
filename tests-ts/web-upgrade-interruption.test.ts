import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLiveUpgradeIO, executeWebUpgrade, interruptUnchanged, validateUpgradeEnvironment } from "../scripts/run-web-upgrade.mjs";
import { syntheticUpgradeIO } from "../scripts/rehearse-web-upgrade.mjs";
import { webUpdateStatus } from "../apps/api/src/web-updates.ts";
import { composedModuleIds, d1Query, provisionModuleRefusal } from "../scripts/check-provision-modules.mjs";

const env = { REPOSITORY_PRIVATE: "true", UPDATE_REPOSITORY: "example/private-install", REQUEST_ID: "11111111-1111-4111-8111-111111111111", RELEASE_TAG: "v2.0.0", RELEASE_SHA: "b".repeat(40), EXECUTOR_RUN_ID: "123", INSTALLATION_SLUG: "example", DATABASE_ID: "22222222-2222-2222-2222-222222222222", API_URL: "https://example-api.account.workers.dev", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "cfat_synthetic", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString() };
const context = validateUpgradeEnvironment(env);

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("apps/api/migrations").sort()) sqlite.exec(readFileSync(join("apps/api/migrations", file), "utf8"));
  sqlite.exec("INSERT INTO installations (id,created_at,auth_mode) VALUES ('primary','2026-01-01','local')");
  return sqlite;
}
function insertClaimed(sqlite: DatabaseSync, stage: string, maintenance: number) {
  sqlite.prepare("INSERT INTO web_update_requests (id,installation_id,release_tag,release_sha,release_notes,previous_version,state,stage,maintenance,created_at,expires_at,updated_at,started_at,run_id,executor_run_id,backup_exported_at) VALUES (?,'primary',?,?,'n','2.0.0-beta.12','running',?,?,'2026-01-01','2999-01-01','2026-01-01','2026-01-01',?,?,'2026-01-01')")
    .run(context.requestId, context.tag, context.sha, stage, maintenance, context.runId, context.runId);
}
const row = (sqlite: DatabaseSync) => ({ ...sqlite.prepare("SELECT state, stage, maintenance, error_code FROM web_update_requests WHERE id = ?").get(context.requestId) });
// The Cloudflare D1 HTTP API shape the controller reads, backed by SQLite.
async function withD1(sqlite: DatabaseSync, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.match(String(url), /\/d1\/database\/22222222-2222-2222-2222-222222222222\/query$/);
    const { sql, params } = JSON.parse(String(init.body));
    const statement = sqlite.prepare(sql);
    const result = /^\s*(SELECT|PRAGMA)/i.test(sql) ? { success: true, results: statement.all(...params), meta: { changes: 0 } } : { success: true, results: [], meta: { changes: Number(statement.run(...params).changes) } };
    return Response.json({ success: true, result: [result] });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = previous; }
}
async function liveIO() {
  const source = await mkdtemp(join(tmpdir(), "lancerlogin-interrupt-"));
  return { source, io: await createLiveUpgradeIO(context, { PATH: process.env.PATH }, source) };
}

test("a cancelled run clears maintenance and fails the request only while nothing was migrated or deployed", async () => {
  for (const stage of ["preflight", "building", "maintenance"]) {
    const sqlite = database(); insertClaimed(sqlite, stage, stage === "maintenance" ? 1 : 0);
    const { source, io } = await liveIO();
    try {
      await withD1(sqlite, async () => assert.equal(await interruptUnchanged(io, { claimed: true, stage }), "released"));
      assert.deepEqual(row(sqlite), { state: "failed", stage, maintenance: 0, error_code: `${stage}_cancelled` });
    } finally { await rm(source, { recursive: true, force: true }); }
  }
  // A stored stage at or after migrations is never released, even if the controller's own progress were wrong.
  for (const stage of ["migrations", "api_deployment", "pages_deployment", "health"]) {
    const sqlite = database(); insertClaimed(sqlite, stage, 1);
    const { source, io } = await liveIO();
    try {
      await withD1(sqlite, async () => assert.rejects(interruptUnchanged(io, { claimed: true, stage: "maintenance" }), /request_state_conflict/));
      assert.deepEqual(row(sqlite), { state: "running", stage, maintenance: 1, error_code: null });
    } finally { await rm(source, { recursive: true, force: true }); }
  }
});

test("interruption before claim changes nothing, and after a mutation may have started it is left for recovery", async () => {
  let releases = 0; const io = { releaseUnchanged: async () => { releases++; } };
  assert.equal(await interruptUnchanged(io, {}), "not_claimed");
  assert.equal(await interruptUnchanged(io, { claimed: true, stage: "maintenance", mutationStarting: true }), "mutation_possible");
  assert.equal(releases, 0);
});

test("a run interrupted during the drain never migrates, and the request is released unchanged", async () => {
  const { installation, io } = syntheticUpgradeIO({ initialVersion: "2.0.0-beta.12" });
  let finishDrain = () => {}; const draining = new Promise<void>((done) => { finishDrain = done; });
  let released = 0;
  const progress: Record<string, unknown> = {};
  Object.assign(io, { drain: () => draining, releaseUnchanged: async () => { released++; installation.state = "failed"; installation.maintenance = 0; } });
  const run = executeWebUpgrade({ runId: "123", tag: "v2.0.0" }, io, progress);
  while (progress.stage !== "maintenance") await new Promise((done) => setImmediate(done));
  assert.equal(installation.maintenance, 1);
  assert.equal(await interruptUnchanged(io, progress), "released");
  finishDrain();
  await assert.rejects(run, /checkpoint_failed/);
  assert.equal(released, 1); assert.equal(installation.mutations, 0); assert.equal(installation.maintenance, 0);
  assert.equal(installation.stages.includes("migrate"), false);
});

test("the Worker fails a stopped run with nothing changed and still requires recovery after a mutation stage", async () => {
  const run = { path: ".github/workflows/upgrade-web.yml", display_title: `LancerLogin web update ${context.requestId}`, event: "workflow_dispatch", status: "completed", conclusion: "cancelled" };
  const workerEnv = (sqlite: DatabaseSync) => ({ DB: { prepare(sql: string) {
    let params: unknown[] = [];
    return { bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { return (sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...params as []).changes) } }; } };
  } }, ALLOWED_ORIGIN: "https://example-dashboard.pages.dev", RELEASE_VERSION: "2.0.0-beta.12", UPDATE_REPOSITORY: "example/private-install",
  WEB_UPDATE_TOKEN: "synthetic-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(run)) as typeof fetch;
  try {
    for (const [stage, expected] of [["preflight", { state: "failed", maintenance: 0, error_code: "workflow_stopped_unchanged" }], ["building", { state: "failed", maintenance: 0, error_code: "workflow_stopped_unchanged" }],
      ["maintenance", { state: "failed", maintenance: 0, error_code: "workflow_stopped_unchanged" }], ["migrations", { state: "recovery_required", maintenance: 1, error_code: "workflow_incomplete" }],
      ["health", { state: "recovery_required", maintenance: 1, error_code: "workflow_incomplete" }]] as const) {
      const sqlite = database(); insertClaimed(sqlite, stage, 1);
      await webUpdateStatus(workerEnv(sqlite) as never);
      assert.deepEqual(row(sqlite), { stage, ...expected }, stage);
    }
  } finally { globalThis.fetch = previous; }
});

test("every update run deploys its own deployment marker for health to match", async () => {
  const first = await liveIO(); const second = await liveIO();
  try {
    const marker = async (source: string) => JSON.parse(await readFile(join(source, ".provision/wrangler.json"), "utf8")).vars.DEPLOYMENT_MARKER;
    const [a, b] = [await marker(first.source), await marker(second.source)];
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, b);
  } finally { await rm(first.source, { recursive: true, force: true }); await rm(second.source, { recursive: true, force: true }); }
});

test("provision upgrade refuses a build that drops a used module that moved into a plugin", async () => {
  const sqlite = database();
  sqlite.exec("INSERT INTO platform_modules (installation_id,module_id,contract_version,generation,phase,setup_version) VALUES ('primary','carpool',1,1,'enabled',1)");
  const query = async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params as []);
  assert.deepEqual((await provisionModuleRefusal({ composed: ["hour-tracking"], query })).map((module) => module.id), ["carpool"]);
  assert.deepEqual(await provisionModuleRefusal({ composed: ["hour-tracking", "carpool"], query }), []);
  sqlite.exec("UPDATE platform_modules SET phase = 'disabled'");
  assert.deepEqual(await provisionModuleRefusal({ composed: ["hour-tracking"], query }), []);
  // The composition record lists composed plugins; without one (no composition), nothing counts as composed.
  assert.deepEqual(await composedModuleIds(async () => JSON.stringify({ format: 1, modules: [{ id: "hour-tracking" }, { id: "carpool" }] })), ["hour-tracking", "carpool"]);
  assert.deepEqual(await composedModuleIds(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }), []);
  await assert.rejects(composedModuleIds(async () => JSON.stringify({ format: 2 })), /module_composition_record_invalid/);
  assert.throws(() => d1Query({ accountId: "a".repeat(32), apiToken: "unscoped", databaseId: env.DATABASE_ID }), /scoped_account_credential_required/);
  let requested = "";
  const d1 = d1Query({ accountId: "a".repeat(32), apiToken: "cfat_synthetic", databaseId: env.DATABASE_ID, request: (async (url: string) => { requested = url; return Response.json({ success: true, result: [{ success: true, results: [{ used: 0 }] }] }); }) as typeof fetch });
  assert.deepEqual(await d1("SELECT 0 AS used"), [{ used: 0 }]);
  assert.equal(requested, `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/d1/database/${env.DATABASE_ID}/query`);
});

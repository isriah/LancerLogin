// quick-check: covers apps/api/src/report-builder.ts
// The D1 queries one uncached report run makes in a Core build, for every dataset, against the Free plan's 50 per
// invocation. tests-ts/report-query-budget-composed.test.ts runs the same budget with Outreach and Guest Visits composed.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/index.ts";
import type { D1Database, D1Result, D1Statement } from "../apps/api/src/d1-usage.ts";
import { coalescingDatabase, readCoalescer } from "../apps/api/src/d1-coalesce.ts";
import { HttpError } from "../apps/api/src/http-error.ts";
import { measureReportDatasets, reportQueryBudget } from "./fixtures/report-query-budget.ts";

for (const cold of [false, true]) {
  test(`every Core report dataset stays within ${reportQueryBudget} D1 queries in a ${cold ? "new isolate's first request" : "warm isolate"}`, async (t) => {
    const results = await measureReportDatasets(worker, ["attendance"], { cold });
    for (const result of results) t.diagnostic(`${result.id}: ${result.queries} D1 queries`);
    assert.deepEqual(results.map((result) => result.id.replace(/ \(every column\)$/, "")).filter((id, index, ids) => ids.indexOf(id) === index), ["core.members", "core.combined-members", "attendance.members"]);
    for (const result of results) assert.ok(result.queries <= reportQueryBudget, `${result.id} made ${result.queries} D1 queries:\n${result.log.join("\n")}`);
    // An Attendance report reads all its source data in one guarded batch, between the cache's two revision reads, rather
    // than one guarded batch per table.
    const attendance = results.find((result) => result.id === "attendance.members")!;
    const guarded = attendance.log.filter((sql) => /^batch\(\d+\): SELECT CASE WHEN/.test(sql)).map((sql) => sql.slice(0, sql.indexOf(")") + 1));
    assert.deepEqual(guarded, ["batch(3)", "batch(11)", "batch(3)"], attendance.log.join("\n"));
  });
}

/** A fake D1 database that records each call: `batch(n)` for a batch of n statements, the SQL for a lone read. */
function recordingDatabase(fail?: (sql: string) => boolean) {
  const calls: string[] = [];
  const statement = (sql: string): D1Statement & { sql: string } => ({
    sql, bind: () => statement(sql),
    async first<T>() { calls.push(sql); if (fail?.(sql)) throw new Error(`failed ${sql}`); return { sql } as T; },
    async all<T>() { calls.push(sql); if (fail?.(sql)) throw new Error(`failed ${sql}`); return { results: [{ sql }] as T[] }; },
    async run() { calls.push(`run ${sql}`); return { success: true }; },
  });
  const db: D1Database = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      calls.push(`batch(${statements.length})`);
      const sqls = statements.map((item) => (item as unknown as { sql: string }).sql);
      if (sqls.some((sql) => fail?.(sql))) throw new Error("batch failed");
      return sqls.map((sql) => ({ results: [{ sql }] })) as D1Result[];
    },
  };
  return { db, calls };
}

test("reads started together share one batch; a lone read, a write and a later read go out on their own", async () => {
  const { db, calls } = recordingDatabase(); const coalesced = coalescingDatabase(db);
  const [first, all, other] = await Promise.all([
    coalesced.prepare("SELECT 1").first<{ sql: string }>(),
    coalesced.prepare("SELECT 2").bind(1).all<{ sql: string }>(),
    coalesced.prepare("WITH x AS (SELECT 3) SELECT * FROM x").all<{ sql: string }>(),
  ]);
  assert.deepEqual([first, all.results, other.results], [{ sql: "SELECT 1" }, [{ sql: "SELECT 2" }], [{ sql: "WITH x AS (SELECT 3) SELECT * FROM x" }]]);
  assert.deepEqual(calls, ["batch(3)"]);
  calls.length = 0;
  assert.deepEqual(await coalesced.prepare("SELECT 4").first(), { sql: "SELECT 4" });
  await Promise.all([coalesced.prepare("UPDATE t SET a = 1").run(), coalesced.prepare("INSERT INTO t VALUES (1) RETURNING a").all()]);
  assert.deepEqual(calls, ["SELECT 4", "run UPDATE t SET a = 1", "INSERT INTO t VALUES (1) RETURNING a"]);
});

test("a failed batch retries each read alone, so only the failing read rejects", async () => {
  const { db, calls } = recordingDatabase((sql) => sql === "SELECT bad"); const coalesced = coalescingDatabase(db);
  const results = await Promise.allSettled([coalesced.prepare("SELECT good").all(), coalesced.prepare("SELECT bad").all()]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
  assert.deepEqual(calls, ["batch(2)", "SELECT good", "SELECT bad"]);
});

test("an error the whole batch shares, such as a module authority denial, rejects every read without retrying", async () => {
  let batches = 0, singles = 0;
  const read = readCoalescer(async () => { batches++; throw new HttpError(403, "denied"); }, async () => { singles++; return { results: [] }; }, (error) => error instanceof HttpError);
  const statement = {} as D1Statement;
  const results = await Promise.allSettled([read(statement), read(statement)]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.deepEqual([batches, singles], [1, 0]);
});

test("a module disabled after the request's access check pauses its report, as a fresh check would", async () => {
  const { reportInstallation } = await import("./fixtures/report-query-budget.ts");
  const installation = await reportInstallation(worker, ["attendance"]);
  try {
    const { sessionSecret } = await import("./fixtures/backup-database.ts"); const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");
    const raw = installation.db as unknown as D1Database; let checked = false;
    // Disable Attendance right after the batch that reads module generations, before its projection's first read.
    const database: D1Database = {
      prepare: (sql) => raw.prepare(sql),
      async batch(statements) {
        const results = await raw.batch(statements);
        if (!checked && statements.some((statement) => /SELECT m\.generation/.test((statement as unknown as { sql?: string }).sql ?? ""))) { checked = true; installation.db.raw.exec("UPDATE platform_modules SET phase='disabled' WHERE module_id='attendance'"); }
        return results;
      },
    };
    const env = { DB: database, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" };
    const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
    const definition = { ...(await import("../apps/api/src/report-builder.ts")).defaultReportDefinition(false, "attendance.members"), period: { type: "all" } };
    const response = await worker.fetch(new Request("https://api.example.test/reports/query", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ definition }) }), env);
    assert.equal(response.status, 200, await response.clone().text()); assert.ok(checked, "the access check ran in a batch");
    const body = await response.json() as { state: string; rows: unknown[]; pausedReasons: string[] };
    assert.deepEqual([body.state, body.rows.length], ["paused", 0]); assert.match(body.pausedReasons.join(" "), /unavailable/);
  } finally { installation.db.raw.close(); }
});

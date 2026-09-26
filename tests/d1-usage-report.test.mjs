import test from "node:test";
import assert from "node:assert/strict";
import { readD1Usage } from "../scripts/d1-usage-report.mjs";

const options = { accountId: "a".repeat(32), token: "synthetic-secret", date: "2026-09-26" };
function response(reads) {
  return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: reads.map((rowsRead, i) => ({ dimensions: { databaseId: i % 2 ? "dev" : "production" }, sum: { rowsRead, rowsWritten: 1, readQueries: 2, writeQueries: 1 } })) }] } } });
}
test("usage report aggregates every database within exact UTC boundaries without leaking credentials", async () => {
  const report = await readD1Usage({ ...options, fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql"); assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body); assert.equal(body.variables.filter.datetimeHour_geq, "2026-09-26T00:00:00.000Z"); assert.equal(body.variables.filter.datetimeHour_lt, "2026-09-27T00:00:00.000Z");
    return response([2_000_000, 500_000, 1_000_000]);
  } });
  assert.equal(report.totalRowsRead, 3_500_000); assert.equal(report.level, "watch"); assert.equal(report.databases[0].rowsRead, 3_000_000);
  assert.equal(JSON.stringify(report).includes(options.token), false);
});
test("thresholds warn before account exhaustion and unavailable analytics fail visibly", async () => {
  for (const [reads, level] of [[1, "normal"], [2_500_000, "watch"], [3_750_000, "warning"], [4_500_000, "critical"]]) assert.equal((await readD1Usage({ ...options, fetchImpl: async () => response([reads]) })).level, level);
  await assert.rejects(readD1Usage({ ...options, fetchImpl: async () => Response.json({ errors: [{ message: "denied" }] }) }), /unavailable/);
  await assert.rejects(readD1Usage({ ...options, date: "2026-02-30" }), /valid UTC date/);
});

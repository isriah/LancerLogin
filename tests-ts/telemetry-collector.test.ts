import test from "node:test";
import assert from "node:assert/strict";
import collector, { configuredRetentionDays, hashInstallId, parseTelemetryReport, purgeExpired, type Env } from "../apps/telemetry-collector/src/index.ts";

class FakeStatement {
  values: unknown[] = [];
  readonly sql: string;
  readonly database: FakeDatabase;
  constructor(sql: string, database: FakeDatabase) { this.sql = sql; this.database = database; }
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { this.database.calls.push(this); return (this.database.firstResult(this.sql) ?? null) as T | null; }
  async all<T>() { this.database.calls.push(this); return { results: (this.database.allResult(this.sql) ?? []) as T[] }; }
  async run() { this.database.calls.push(this); return { success: true, meta: { changes: 1 } }; }
}

class FakeDatabase {
  calls: FakeStatement[] = [];
  batches: FakeStatement[][] = [];
  firstRows = new Map<string, unknown>();
  allRows = new Map<string, unknown[]>();
  prepare(sql: string) { return new FakeStatement(sql, this); }
  async batch(statements: FakeStatement[]) { this.batches.push(statements); return statements.map(() => ({ success: true })); }
  firstResult(sql: string) { for (const [fragment, value] of this.firstRows) if (sql.includes(fragment)) return value; return undefined; }
  allResult(sql: string) { for (const [fragment, value] of this.allRows) if (sql.includes(fragment)) return value; return undefined; }
}

const limiter = (success = true) => ({ limit: async (_input: { key: string }) => ({ success }) });
const report = { installId: "2f1c7d4a-81cb-4cef-934e-4c23181933fd", releaseVersion: "0.1.0", activeKioskCount: 1 };
const request = (body: unknown, headers: HeadersInit = {}) => new Request("https://collector.example.test/v1/report", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("collector accepts only the documented privacy payload", () => {
  assert.deepEqual(parseTelemetryReport({ ...report, metro: "New York", errorCategory: "worker-internal" }), { ...report, metro: "New York", errorCategory: "worker-internal" });
  assert.throws(() => parseTelemetryReport({ ...report, roster: ["Person"] }), /unsupported field/);
  assert.throws(() => parseTelemetryReport({ ...report, activeKioskCount: 2 }), /zero or one/);
  assert.throws(() => parseTelemetryReport({ ...report, metro: "192.0.2.1" }), /metro is invalid/);
  assert.throws(() => parseTelemetryReport({ ...report, metro: "2001:db8::1" }), /metro is invalid/);
});

test("collector hashes the opaque install ID with a private pepper", async () => {
  const first = await hashInstallId(report.installId, "a".repeat(32));
  const second = await hashInstallId(report.installId, "b".repeat(32));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, new RegExp(report.installId));
  await assert.rejects(() => hashInstallId(report.installId, "short"), /securely/);
});

test("collector persists no raw install ID and limits each install to one daily row", async () => {
  const database = new FakeDatabase();
  database.firstRows.set("COUNT(*) AS count FROM telemetry_installations", { count: 0 });
  const env = { DB: database, GLOBAL_LIMITER: limiter(), INSTALL_LIMITER: limiter(), INSTALL_ID_PEPPER: "p".repeat(32) } as Env;
  const response = await collector.fetch(request({ ...report, metro: "Example Metro" }), env);
  assert.equal(response.status, 204);
  const values = database.calls.flatMap((call) => call.values);
  assert.equal(values.includes(report.installId), false);
  assert.ok(database.calls.some((call) => call.sql.includes("ON CONFLICT(install_hash, report_day) DO UPDATE")));
  assert.ok(database.calls.every((call) => !call.sql.toLowerCase().includes("ip_address")));
});

test("collector enforces actual body size and edge rate limiting", async () => {
  const database = new FakeDatabase();
  const base = { DB: database, INSTALL_ID_PEPPER: "p".repeat(32), INSTALL_LIMITER: limiter() } as Env;
  const limited = await collector.fetch(request(report), { ...base, GLOBAL_LIMITER: limiter(false) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const oversized = new Request("https://collector.example.test/v1/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...report, padding: "x".repeat(5000) }) });
  const rejected = await collector.fetch(oversized, { ...base, GLOBAL_LIMITER: limiter() });
  assert.equal(rejected.status, 413);
});

test("summary is authenticated, aggregate-only, and k-anonymizes metros", async () => {
  const database = new FakeDatabase();
  database.firstRows.set("WITH recent AS", { uniqueInstallations: 7, reports: 10, activeKiosks: 6 });
  database.allRows.set("GROUP BY release_version", [{ releaseVersion: "0.1.0", installations: 7 }]);
  database.allRows.set("GROUP BY error_category", [{ errorCategory: "worker-internal", reports: 1 }]);
  database.allRows.set("GROUP BY metro", [{ metro: "Example Metro", installations: 5 }]);
  const token = "summary-token-".padEnd(40, "x");
  const env = { DB: database, ADMIN_BEARER_TOKEN: token } as Env;
  const denied = await collector.fetch(new Request("https://collector.example.test/v1/summary"), env);
  assert.equal(denied.status, 401);
  const accepted = await collector.fetch(new Request("https://collector.example.test/v1/summary", { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(accepted.status, 200);
  const body = JSON.stringify(await accepted.json());
  assert.doesNotMatch(body, /installHash|installId/);
  assert.ok(database.calls.some((call) => call.sql.includes("SUM(active_kiosk_count) FROM latest")));
  assert.ok(database.calls.some((call) => call.sql.includes("HAVING COUNT(DISTINCT install_hash) >= 5")));
});

test("maintainers can delete a requested installation without persisting its raw reference", async () => {
  const database = new FakeDatabase();
  const token = "deletion-token-".padEnd(40, "x");
  const env = { DB: database, ADMIN_BEARER_TOKEN: token, INSTALL_ID_PEPPER: "p".repeat(32) } as Env;
  const url = "https://collector.example.test/v1/admin/delete-installation";
  const denied = await collector.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installId: report.installId }) }), env);
  assert.equal(denied.status, 401);
  const accepted = await collector.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ installId: report.installId }) }), env);
  assert.equal(accepted.status, 204);
  assert.equal(database.batches.length, 1);
  assert.ok(database.batches[0].every((call) => call.sql.includes("DELETE FROM telemetry_")));
  assert.ok(database.batches[0].every((call) => call.values[0] !== report.installId && /^[a-f0-9]{64}$/.test(String(call.values[0]))));
});

test("scheduled retention is bounded and deletes orphan install hashes", async () => {
  assert.equal(configuredRetentionDays(undefined), 30);
  assert.throws(() => configuredRetentionDays("366"), /invalid/);
  const database = new FakeDatabase();
  await purgeExpired({ DB: database, RETENTION_DAYS: "30" }, new Date("2026-08-30T00:00:00.000Z"));
  assert.equal(database.batches.length, 1);
  assert.equal(database.batches[0][0].values[0], "2026-07-31T00:00:00.000Z");
  assert.match(database.batches[0][1].sql, /NOT EXISTS/);
});

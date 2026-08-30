import test from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../apps/api/src/index.ts";

class FakeStatement {
  values: unknown[] = [];
  readonly sql: string;
  readonly database: FakeDatabase;
  constructor(sql: string, database: FakeDatabase) { this.sql = sql; this.database = database; }
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { this.database.calls.push(this); return (this.database.firstResult(this.sql, this.values) ?? null) as T | null; }
  async all<T>() { this.database.calls.push(this); return { results: [] as T[] }; }
  async run() { this.database.calls.push(this); return { success: true }; }
}

class FakeDatabase {
  calls: FakeStatement[] = [];
  batches: FakeStatement[][] = [];
  user?: { id: string; role: "admin" | "operator"; passwordHash: string | null };
  prepare(sql: string) { return new FakeStatement(sql, this); }
  async batch(statements: FakeStatement[]) { this.batches.push(statements); return statements.map(() => ({ success: true })); }
  firstResult(sql: string, _values: unknown[]) {
    if (sql.includes("FROM users")) return this.user;
    return undefined;
  }
}

const request = (path: string, body?: unknown) => new Request(`https://api.example.test${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);

test("Worker bootstrap validates input before writing D1", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example" }), env);
  assert.equal(result.status, 400);
  assert.equal(database.batches.length, 0);
});

test("Worker bootstrap creates one Admin and four audited records", async () => {
  const database = new FakeDatabase();
  const env = { APP_MODE: "unconfigured", ALLOWED_ORIGIN: "https://dashboard.example.test", DB: database } as unknown as Env;
  const result = await worker.fetch(request("/setup/bootstrap", { organizationName: "Example Arts Club", timeZone: "America/New_York", authMode: "local", localUsername: "director", localPassword: "correct horse battery staple", telemetryAccepted: false }), env);
  assert.equal(result.status, 201);
  assert.equal(database.batches.length, 1);
  assert.equal(database.batches[0].length, 4);
  const userInsert = database.batches[0].find((statement) => statement.sql.includes("INSERT INTO users"));
  assert.match(String(userInsert?.values[4]), /^scrypt\$/);
  assert.equal((await result.json() as { telemetryAccepted: boolean }).telemetryAccepted, false);
});

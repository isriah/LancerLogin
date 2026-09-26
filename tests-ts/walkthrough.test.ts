import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { walkthroughs } from "../packages/shared/src/walkthrough.ts";

class Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    for (const file of readdirSync("apps/api/migrations").sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec("INSERT INTO installations (id, created_at, auth_mode) VALUES ('primary', '2026-09-25', 'local'), ('other', '2026-09-25', 'local'); INSERT INTO users (id, installation_id, local_username, role, created_at) VALUES ('admin', 'primary', 'admin', 'admin', '2026-09-25'), ('operator', 'primary', 'operator', 'operator', '2026-09-25'), ('outsider', 'other', 'outsider', 'admin', '2026-09-25'); INSERT INTO organization_settings (installation_id, time_zone) VALUES ('primary', 'UTC');");
  }
  prepare(sql: string) {
    let values: unknown[] = []; const db = this.sqlite;
    return { bind(...next: unknown[]) { values = next; return this; },
      async first() { return db.prepare(sql).get(...values as []) ?? null; },
      async all() { return { results: db.prepare(sql).all(...values as []) }; },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values as []).changes) } }; } };
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
const secret = "A".repeat(43);
const origin = "https://dashboard.example.test";
async function call(database: Database, path: string, user = "admin", body?: unknown, requestOrigin = origin) {
  const token = user ? await createSessionCodec(secret).issue({ userId: user, role: user === "operator" ? "operator" : "admin" }) : "";
  const request = new Request(`https://api.example.test${path}`, { method: body ? path === "/admin/data/restore" || path === "/admin/setup/reset" ? "POST" : "PATCH" : "GET", headers: { origin: requestOrigin, "content-type": "application/json", cookie: `lancerlogin_session=${token}` }, body: body ? JSON.stringify(body) : undefined });
  return worker.fetch(request, { APP_MODE: "configured", ALLOWED_ORIGIN: origin, SESSION_KEY: secret, DB: database } as unknown as Env);
}
const endpoint = "/auth/walkthroughs/dashboard";
const progress = { version: 1, status: "in_progress", stepId: "search" };

test("walkthrough progress persists per account and enforces session, installation, origin and input boundaries", async () => {
  const db = new Database();
  try {
    assert.equal((await call(db, endpoint, "")).status, 401);
    assert.equal((await call(db, endpoint, "outsider")).status, 401);
    for (const user of ["admin", "operator"]) {
      assert.equal((await (await call(db, endpoint, user)).json() as any).progress.status, "not_started");
      assert.equal((await call(db, endpoint, user, progress)).status, 200);
    }
    await call(db, endpoint, "admin", { ...progress, status: "dismissed" });
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "dismissed");
    assert.equal((await (await call(db, endpoint, "operator")).json() as any).progress.status, "in_progress");
    assert.equal((await call(db, endpoint, "admin", progress, "https://untrusted.example")).status, 403);
    for (const invalid of [{ ...progress, userId: "operator" }, { ...progress, status: "unknown" }, { ...progress, version: 2 }, { ...progress, stepId: null }, { ...progress, stepId: "missing" }, { status: "completed" }]) assert.equal((await call(db, endpoint, "admin", invalid)).status, 400);
    assert.equal((await call(db, "/auth/walkthroughs/missing")).status, 404);
    assert.equal((await call(db, "/auth/walkthroughs/__proto__")).status, 404);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM user_walkthroughs").get()?.n, 2);
    db.sqlite.exec("UPDATE users SET active = 0 WHERE id = 'operator'");
    assert.equal((await call(db, endpoint, "operator", progress)).status, 401);
  } finally { db.sqlite.close(); }
});

test("every registered page accepts independent walkthrough progress", async () => {
  const db = new Database();
  try {
    for (const [pageId, definition] of Object.entries(walkthroughs)) {
      const pageEndpoint = `/auth/walkthroughs/${pageId}`;
      const initial = await (await call(db, pageEndpoint)).json() as any;
      assert.deepEqual(initial.progress, { pageId, version: definition.version, status: "not_started", stepId: null });
      const stepId = definition.steps.at(-1)!;
      const response = await call(db, pageEndpoint, "admin", { version: definition.version, status: "completed", stepId });
      assert.equal(response.status, 200, `${pageId}: ${await response.clone().text()}`);
      const saved = await (await call(db, pageEndpoint)).json() as any;
      assert.deepEqual(saved.progress, { pageId, version: definition.version, status: "completed", stepId });
    }
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM user_walkthroughs").get()?.n, Object.keys(walkthroughs).length);
  } finally { db.sqlite.close(); }
});

test("entire-installation backups round-trip progress, older backups reset it, and category restores preserve it", async () => {
  const db = new Database();
  try {
    await call(db, endpoint, "admin", { ...progress, status: "completed", stepId: "recurrence" });
    const backup = await (await call(db, "/admin/data/backup?scope=installation")).json() as any;
    assert.equal(backup.schemaVersion, 21);
    assert.equal(backup.tables.user_walkthroughs.length, 1);
    const restore = async (scope: string, source: unknown) => call(db, "/admin/data/restore", "admin", { scope, confirmation: `RESTORE ${scope.toUpperCase()}`, backup: source });
    let result = await restore("installation", backup); assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "completed");
    assert.equal((await call(db, "/admin/setup/reset", "admin", { confirmation: "RESET ONBOARDING" })).status, 200);
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "completed");
    for (const scope of ["roster", "meetings"]) {
      const category = await (await call(db, `/admin/data/backup?scope=${scope}`)).json() as any;
      assert.equal(category.tables.user_walkthroughs, undefined);
      result = await restore(scope, category); assert.equal(result.status, 200, await result.clone().text());
      assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "completed");
    }
    const invalid = structuredClone(backup); invalid.tables.user_walkthroughs[0].user_id = "outsider";
    assert.equal((await restore("installation", invalid)).status, 400);
    const old = structuredClone(backup); old.schemaVersion = 20; delete old.tables.user_walkthroughs;
    result = await restore("installation", old); assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await (await call(db, endpoint)).json() as any).progress.status, "not_started");
    assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.sqlite.close(); }
});

test("walkthrough migration preserves an existing installation and saved reports", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migration = "0038_page_walkthroughs.sql";
    for (const file of readdirSync("apps/api/migrations").sort().filter((name) => name < migration)) db.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    db.exec("INSERT INTO installations (id, created_at, auth_mode) VALUES ('primary', '2026-09-25', 'local'); INSERT INTO users (id, installation_id, local_username, role, created_at) VALUES ('admin', 'primary', 'admin', 'admin', '2026-09-25');");
    db.prepare("INSERT INTO saved_report_views VALUES (?,?,?,?,?,?,1,?,?,?,?)").run("report", "primary", "admin", "personal", "Existing report", "{}", "admin", "admin", "2026-09-25", "2026-09-25");
    db.prepare("INSERT INTO saved_report_tabs VALUES (?,?,?,?,?)").run("primary", "admin", "report", 0, "2026-09-25");
    const before = db.prepare("SELECT name, type, sql FROM sqlite_master ORDER BY name").all();
    db.exec(readFileSync(`apps/api/migrations/${migration}`, "utf8"));
    assert.deepEqual(db.prepare("SELECT name, type, sql FROM sqlite_master WHERE tbl_name != 'user_walkthroughs' ORDER BY name").all(), before);
    assert.equal(db.prepare("SELECT name FROM saved_report_views WHERE id = 'report'").get()?.name, "Existing report");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM saved_report_tabs").get()?.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_walkthroughs").get()?.count, 0);
    db.exec("INSERT INTO user_walkthroughs VALUES ('primary', 'admin', 'reports', 1, 'in_progress', 'filters', '2026-09-26');");
    assert.equal(db.prepare("SELECT local_username FROM users WHERE id = 'admin'").get()?.local_username, "admin");
  } finally { db.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { officialWebRelease, newerRelease, prepareWebUpdate, startWebUpdate, recordUpdateBackup, webUpdateStatus, latestUpdate, fixedWorkflowPath } from "../apps/api/src/web-updates.ts";
import { sendAttendance } from "../apps/kiosk/src/cloud-client.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";

class D1 {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    const path = "apps/api/migrations";
    for (const file of readdirSync(path).sort()) this.sqlite.exec(readFileSync(join(path, file), "utf8"));
    this.sqlite.exec("INSERT INTO installations (id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'); INSERT INTO users (id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01'), ('operator','primary','operator','operator','2026-01-01'); INSERT INTO organization_settings (installation_id,time_zone) VALUES ('primary','UTC');");
  }
  prepare(sql: string) {
    let params: unknown[] = []; const database = this;
    return { bind(...values: unknown[]) { params = values; return this; },
      async first<T>() { return (database.sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
      async all<T>() { return { results: database.sqlite.prepare(sql).all(...params as []) as T[] }; },
      async run() {
        // D1 reports total_changes() deltas, including trigger writes, rather than direct statement changes.
        const before = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        database.sqlite.prepare(sql).run(...params as []);
        const after = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        return { success: true, meta: { changes: after - before } };
      } };
  }
  async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map((statement) => statement.run())); }
}
const secret = "A".repeat(43);
function environment(database = new D1()): Env {
  return { APP_MODE: "configured", ALLOWED_ORIGIN: "https://example-dashboard.pages.dev", SESSION_KEY: secret,
    RELEASE_VERSION: "0.24.0", UPDATE_REPOSITORY: "example/private-install", WEB_UPDATE_TOKEN: "synthetic-token",
    WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString(), DB: database } as unknown as Env;
}
function release(tag = "v1.0.0") { const version = tag.slice(1); return { tag_name: tag, draft: false, prerelease: false, body: "Synthetic release notes",
  assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => [`lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz.sha256`])].map((name) => ({ name })) }; }
const sha = "b".repeat(40);
async function withGitHub(run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>, dispatch?: (init?: RequestInit) => Promise<Response>, status?: object) {
  const previous = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url); calls.push({ url: path, init });
    if (path.includes("/dispatches")) return dispatch ? dispatch(init) : Response.json({ workflow_run_id: 123 });
    if (path.includes("/releases/latest")) return Response.json(release());
    if (path.includes("/commits/")) return Response.json({ sha });
    if (path.includes("/runs?")) return Response.json(status ?? { workflow_runs: [] });
    if (path.includes("/actions/runs/")) return Response.json(status ?? { path: ".github/workflows/upgrade-web.yml", display_title: "unknown", event: "workflow_dispatch", status: "waiting" });
    if (path.includes("/workflows/")) return Response.json({ state: "active", path: ".github/workflows/upgrade-web.yml" });
    return Response.json({ private: true });
  };
  try { await run(calls); } finally { globalThis.fetch = previous; }
}
async function prepared(env: Env) { await prepareWebUpdate(env); return (await latestUpdate(env))!; }

test("web release contract accepts strict stable majors and requires complete assets", () => {
  for (const tag of ["v0.24.0", "v1.0.0", "v12.3.4"]) assert.equal(officialWebRelease(release(tag))?.tag, tag);
  for (const tag of ["v01.0.0", "v1.2.3\n", "v1.2.3-rc1", "v1.2.3+build", "1.2.3"]) assert.equal(officialWebRelease(release(tag)), undefined);
  assert.equal(officialWebRelease({ ...release(), draft: true }), undefined);
  assert.equal(officialWebRelease({ ...release(), prerelease: true }), undefined);
  assert.equal(officialWebRelease({ ...release(), assets: [] }), undefined);
  assert.equal(newerRelease("v1.0.0", "0.24.0"), true);
  assert.equal(newerRelease("v12.0.0", "1.0.0"), true);
  assert.equal(newerRelease("v1.0.0", "1.0.0"), false);
  assert.equal(newerRelease("v1.0.0", "2.0.0"), false);
  assert.equal(fixedWorkflowPath(".github/workflows/upgrade-web.yml@main"), true);
  assert.equal(fixedWorkflowPath(".github/workflows/upgrade-web.yml@hostile"), false);
});
test("simultaneous prepare/start and replay dispatch only one fixed request", async () => {
  const database = new D1(); const env = environment(database);
  await withGitHub(async (calls) => {
    await Promise.all([prepareWebUpdate(env, "admin"), prepareWebUpdate(env, "admin")]);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM web_update_requests").get()?.n, 1);
    const row = (await latestUpdate(env))!;
    await assert.rejects(startWebUpdate(env, { requestId: row.id, backupSaved: true }), { code: "backup_required" });
    await recordUpdateBackup(env, row.id);
    await Promise.all([startWebUpdate(env, { requestId: row.id, backupSaved: true }, "admin"), startWebUpdate(env, { requestId: row.id, backupSaved: true }, "admin")]);
    await startWebUpdate(env, { requestId: row.id, backupSaved: true }, "admin");
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'web_update.prepared'").get()?.n, 1);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'web_update.started'").get()?.n, 1);
    const outbound = calls.filter((call) => call.url.endsWith("/dispatches")); assert.equal(outbound.length, 1);
    assert.deepEqual(JSON.parse(String(outbound[0]!.init?.body)), { ref: "main", inputs: { request_id: row.id, release_tag: "v1.0.0", release_sha: sha } });
    for (const call of calls.filter((entry) => entry.url.includes("/repos/isriah/LancerLogin"))) assert.equal(new Headers(call.init?.headers).has("authorization"), false);
    assert.equal(JSON.stringify(await latestUpdate(env)).includes("synthetic-token"), false);
  });
});
test("ambiguous dispatch reconciles exact request title; no blind redispatch", async () => {
  const env = environment(); let id = "";
  await withGitHub(async () => { const row = await prepared(env); id = row.id; await recordUpdateBackup(env, id); await startWebUpdate(env, { requestId: id, backupSaved: true }); await startWebUpdate(env, { requestId: id, backupSaved: true }); }, async () => { throw new Error("lost response"); });
  assert.equal((await latestUpdate(env))?.error_code, "dispatch_ambiguous");
  await withGitHub(async (calls) => { await webUpdateStatus(env); assert.equal(calls.some((call) => call.url.endsWith("/dispatches")), false); }, undefined, { workflow_runs: [{ id: 123, display_title: `LancerLogin web update ${id}`, path: ".github/workflows/upgrade-web.yml" }], display_title: `LancerLogin web update ${id}`, path: ".github/workflows/upgrade-web.yml", event: "workflow_dispatch", status: "queued" });
  assert.equal((await latestUpdate(env))?.run_id, "123");
});
test("definite credential rejection retains safe diagnostic and one-way request", async () => {
  const env = environment();
  await withGitHub(async (calls) => { const row = await prepared(env); await recordUpdateBackup(env, row.id); await startWebUpdate(env, { requestId: row.id, backupSaved: true }); await startWebUpdate(env, { requestId: row.id, backupSaved: true }); assert.equal(calls.filter((call) => call.url.endsWith("/dispatches")).length, 1); }, async () => new Response(null, { status: 401 }));
  assert.equal((await latestUpdate(env))?.error_code, "credential_required");
  assert.equal((await latestUpdate(env))?.state, "failed");
});
test("credential expiry, selectors, expiration and cross-installation IDs fail closed", async () => {
  const env = environment(); await assert.rejects(prepareWebUpdate({ ...env, WEB_UPDATE_TOKEN_EXPIRES_AT: "2020-01-01" }), { code: "credential_expired" });
  await withGitHub(async () => { const row = await prepared(env); await assert.rejects(startWebUpdate(env, { requestId: row.id, repository: "hostile/repo", backupSaved: true }), { code: "invalid_request" });
    await assert.rejects(startWebUpdate(env, { requestId: "11111111-1111-1111-1111-111111111111", backupSaved: true }), { code: "request_missing" });
    (env.DB as unknown as D1).sqlite.prepare("UPDATE web_update_requests SET expires_at = '2020-01-01' WHERE id = ?").run(row.id);
    await assert.rejects(startWebUpdate(env, { requestId: row.id, backupSaved: true }), { code: "request_expired" }); });
});
test("status preserves workflow-finalized success and never succeeds from GitHub alone", async () => {
  for (const finalized of [false, true]) {
    const database = new D1(); const env = environment(database); let id = "";
    await withGitHub(async () => { const row = await prepared(env); id = row.id; await recordUpdateBackup(env, id); await startWebUpdate(env, { requestId: id, backupSaved: true }); });
    database.sqlite.prepare("UPDATE web_update_requests SET executor_run_id = '123', state = ?, maintenance = ? WHERE id = ?").run(finalized ? "succeeded" : "verifying", finalized ? 0 : 1, id);
    await withGitHub(async () => { const result = await webUpdateStatus(env); assert.equal(result.request?.reloadReady, finalized); }, undefined, { path: ".github/workflows/upgrade-web.yml", display_title: `LancerLogin web update ${id}`, event: "workflow_dispatch", status: "completed", conclusion: "success" });
    assert.equal((await latestUpdate(env))?.state, finalized ? "succeeded" : "recovery_required");
  }
});
test("waiting approval, poll admission and safe preflight failure are durable", async () => {
  const database = new D1(); const env = environment(database); let id = "";
  await withGitHub(async () => { const row = await prepared(env); id = row.id; await recordUpdateBackup(env, id); await startWebUpdate(env, { requestId: id, backupSaved: true }); });
  const identity = { path: ".github/workflows/upgrade-web.yml", display_title: `LancerLogin web update ${id}`, event: "workflow_dispatch" };
  await withGitHub(async (calls) => { await Promise.all([webUpdateStatus(env), webUpdateStatus(env)]); assert.equal(calls.length, 1); }, undefined, { ...identity, status: "waiting" });
  assert.equal((await latestUpdate(env))?.state, "awaiting_approval");
  database.sqlite.exec("UPDATE web_update_requests SET last_poll_at = NULL");
  await withGitHub(async () => { await webUpdateStatus(env); }, undefined, { ...identity, status: "completed", conclusion: "failure" });
  assert.equal((await latestUpdate(env))?.state, "failed"); assert.equal((await latestUpdate(env))?.error_code, "preflight_failed");
});
test("unresolved dispatch retains recovery lock and never permits another active request", async () => {
  const database = new D1(); const env = environment(database);
  await withGitHub(async () => { const row = await prepared(env); await recordUpdateBackup(env, row.id); await startWebUpdate(env, { requestId: row.id, backupSaved: true }); }, async () => { throw new Error("uncertain"); });
  database.sqlite.exec("UPDATE web_update_requests SET started_at = '2020-01-01'");
  await withGitHub(async (calls) => { await webUpdateStatus(env); const result = await prepareWebUpdate(env); assert.equal(result.request?.state, "recovery_required"); assert.equal(calls.length, 1); });
  assert.equal((await latestUpdate(env))?.error_code, "dispatch_unresolved");
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS n FROM web_update_requests").get()?.n, 1);
});
test("Worker binds the backup download to the request and maintenance keeps login available", async () => {
  const database = new D1(); const env = environment(database);
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  await withGitHub(async () => {
    const row = await prepared(env);
    const backup = await worker.fetch(new Request(`https://api.test/admin/data/backup?scope=installation&updateRequestId=${row.id}`, { headers: { cookie } }), env);
    assert.equal(backup.status, 200); assert.equal((await latestUpdate(env))?.backup_exported_at != null, true);
    const start = await worker.fetch(new Request("https://api.test/admin/web-updates/start", { method: "POST", headers: { cookie, origin: env.ALLOWED_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ requestId: row.id, backupSaved: true }) }), env);
    assert.equal(start.status, 202);
  });
  database.sqlite.exec("UPDATE web_update_requests SET maintenance = 1, state = 'recovery_required'");
  const login = await worker.fetch(new Request("https://api.test/auth/local", { method: "POST" }), env);
  assert.equal(login.status, 415); // Authentication/content boundary remains reachable, not maintenance503.
});
test("Worker uses current Admin role, origin and strict no-selector prepare", async () => {
  const database = new D1(); const env = environment(database);
  const adminCookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  const request = (body: object, origin = env.ALLOWED_ORIGIN, cookie = adminCookie) => new Request("https://api.test/admin/web-updates/prepare", { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(request({}, env.ALLOWED_ORIGIN, ""), env)).status, 401);
  assert.equal((await worker.fetch(request({}, "https://hostile.test"), env)).status, 403);
  assert.equal((await worker.fetch(request({ release: "v12.0.0" }), env)).status, 400);
  database.sqlite.exec("UPDATE users SET role = 'operator' WHERE id = 'admin'");
  assert.equal((await worker.fetch(request({}), env)).status, 403);
});
test("operational locks survive category backup/delete and kiosk scans retry503 across restart", async () => {
  const database = new D1(); const env = environment(database);
  await withGitHub(async () => { await prepared(env); });
  database.sqlite.exec("UPDATE web_update_requests SET state = 'recovery_required', maintenance = 1");
  const temp = await mkdtemp(join(tmpdir(), "ll-synthetic-queue-")); const config = { apiUrl: "https://api.test", kioskToken: "synthetic" };
  const event = { eventId: "synthetic-event", memberId: "synthetic-member", occurredAt: new Date().toISOString() };
  try {
    const queue = createFileQueue(join(temp, "queue.json")); await queue.enqueue(event);
    const fetchImpl = async (url: string, init: RequestInit) => worker.fetch(new Request(url, init), env);
    assert.deepEqual(await queue.flush((scan: typeof event) => sendAttendance(config, scan, { fetchImpl })), []);
    const restarted = createFileQueue(join(temp, "queue.json")); assert.equal((await restarted.pending()).length, 1);
    assert.deepEqual(await restarted.flush((scan: typeof event) => sendAttendance(config, scan, { fetchImpl: async () => Response.json({ accepted: true }) })), [event.eventId]);
    const response = await worker.fetch(new Request("https://api.test/kiosk/attendance", { method: "POST" }), env); assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
    const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
    const backup = await worker.fetch(new Request("https://api.test/admin/data/backup?scope=installation", { headers: { cookie } }), env);
    assert.equal(backup.status, 200); const content = await backup.json(); assert.equal("web_update_requests" in content.tables, false); assert.equal(JSON.stringify(content).includes("synthetic-token"), false);
    database.sqlite.exec("DELETE FROM installations WHERE id = 'primary'");
    assert.equal((await latestUpdate(env))?.state, "recovery_required");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

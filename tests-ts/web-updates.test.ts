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
import { createReleaseDiscovery, discoveryTtlMs, officialReleaseUrl } from "../apps/api/src/release-discovery.ts";

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

test("discovery coalesces a fixed authenticated feed and expires without extending successful time", async () => {
  let now = 100_000; let calls = 0; let finish!: (response: Response) => void;
  const credential = { WEB_UPDATE_TOKEN: "synthetic-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(now + 86_400_000).toISOString() };
  const discovery = createReleaseDiscovery({ now: () => now, fetcher: async (url, init) => {
    calls++; assert.equal(url, officialReleaseUrl); assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
    assert.equal(new Headers(init?.headers).get("user-agent"), "LancerLogin");
    return new Promise<Response>((resolve) => { finish = resolve; });
  } });
  const first = discovery.check(credential); assert.equal(discovery.check(credential), first); assert.equal(calls, 1);
  finish(Response.json({ ...release("v1.0.4"), html_url: "https://evil.test/notes" }));
  const result = await first;
  assert.equal(result.release?.html_url, "https://github.com/isriah/LancerLogin/releases/tag/v1.0.4");
  now += discoveryTtlMs - 1;
  assert.equal((await discovery.check(credential)).checkedAt, 100_000); assert.equal(calls, 1);
  now++;
  const expired = discovery.check(credential); assert.equal(calls, 2); finish(Response.json(release("v1.0.5")));
  assert.equal((await expired).release?.tag_name, "v1.0.5");
});

test("discovery omits missing or expired credentials from the fixed public feed", async () => {
  let now = 100_000;
  for (const credential of [undefined, { WEB_UPDATE_TOKEN: "synthetic-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(now - 1).toISOString() }]) {
    const discovery = createReleaseDiscovery({ now: () => now, fetcher: async (_url, init) => {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json(release("v1.0.4"));
    } });
    assert.equal((await discovery.check(credential)).fresh, true);
    now++;
  }
});

test("discovery honors provider seconds/date/reset cooldowns and distinguishes unrelated403", async () => {
  for (const [status, headers, delay, code] of [
    [429, { "retry-after": "120" }, 120_000, "rate_limited"],
    [429, {}, 60_000, "rate_limited"],
    [429, { "retry-after": new Date(280_000).toUTCString() }, 180_000, "rate_limited"],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3700" }, 3_600_000, "rate_limited"],
    [403, { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "3700" }, 30_000, "provider_unavailable"],
    [503, { "retry-after": "120" }, 120_000, "provider_unavailable"],
  ] as const) {
    let now = 100_000; let calls = 0;
    const discovery = createReleaseDiscovery({ now: () => now, fetcher: async () => {
      calls++; return calls === 1 ? new Response("{}", { status, headers }) : Response.json(release("v1.0.4"));
    } });
    const failed = await discovery.check(); assert.equal(failed.code, code); assert.equal(failed.retryAt, now + delay);
    assert.equal(failed.fresh, false); now += delay - 1; await discovery.check(); assert.equal(calls, 1);
    now++; assert.equal((await discovery.check()).fresh, true); assert.equal(calls, 2);
  }
});

test("discovery retains successful metadata as stale during bounded transient backoff", async () => {
  let now = 100_000; let failing = false; let calls = 0;
  const discovery = createReleaseDiscovery({ now: () => now, fetcher: async () => { calls++; if (failing) throw new TypeError("sensitive network details"); return Response.json(release("v1.0.4")); } });
  await discovery.check(); now += discoveryTtlMs; failing = true;
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    const result = await discovery.check(); assert.equal(result.retryAt, now + delay); assert.equal(result.code, "network");
    assert.equal(result.checkedAt, 100_000); assert.equal(result.attemptedAt, now); assert.equal(result.fresh, false);
    assert.equal(result.release?.tag_name, "v1.0.4"); assert.equal(JSON.stringify(result).includes("sensitive"), false);
    await discovery.check(); now += delay;
  }
  assert.equal(calls, 8); failing = false; assert.equal((await discovery.check()).fresh, true);
});

test("discovery aborts timeouts and rejects redirects, malformedJSON and incomplete releases", async () => {
  const stalled = createReleaseDiscovery({ timeoutMs: 10, fetcher: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("abort")), { once: true });
  }) });
  assert.equal((await stalled.check()).code, "timeout");
  for (const result of [Response.json(release(), { status: 302, headers: { location: "https://evil.test" } }), new Response("{"), Response.json({ ...release(), assets: [] }), Response.json({ ...release(), prerelease: true })]) {
    let calls = 0;
    const discovery = createReleaseDiscovery({ fetcher: async () => { calls++; return result; } });
    const checked = await discovery.check(); assert.equal(checked.fresh, false); assert.equal(calls, 1);
    assert.equal(checked.code, result.status === 302 ? "provider_unavailable" : "invalid_release");
  }
});

test("release discovery route authenticates before provider access and cannot authorize stale preparation", async () => {
  const env = environment(); env.RELEASE_VERSION = "1.0.3";
  await withGitHub(async (calls) => {
    const url = "https://api.test/admin/releases/latest?url=https://evil.test";
    assert.equal((await worker.fetch(new Request(url), env)).status, 401);
    const codec = createSessionCodec(secret);
    const operator = `lancerlogin_session=${await codec.issue({ userId: "operator", role: "operator" })}`;
    assert.equal((await worker.fetch(new Request(url, { headers: { cookie: operator } }), env)).status, 403);
    assert.equal(calls.length, 0);
    const cookie = `lancerlogin_session=${await codec.issue({ userId: "admin", role: "admin" })}`;
    const response = await worker.fetch(new Request(url, { headers: { cookie } }), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).fresh, true); assert.equal(calls.length, 1);
    // Discovery's display cache must not be used by preparation. The current feed here is older than installed.
    await assert.rejects(prepareWebUpdate(env), { code: "already_current" });
    assert.equal(calls.filter((call) => call.url === officialReleaseUrl).length, 2);
    assert.equal(await latestUpdate(env), null);
  });
});

test("v1.0.4 preparation still pins a commit, requires its backup and dispatches exactly once", async () => {
  const env = environment(); env.RELEASE_VERSION = "1.0.3";
  const previous = globalThis.fetch; let dispatches = 0;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/releases/latest")) return Response.json(release("v1.0.4"));
    if (path.endsWith("/commits/v1.0.4")) return Response.json({ sha });
    if (path.endsWith("/dispatches")) { dispatches++; assert.equal(JSON.parse(String(init?.body)).inputs.release_sha, sha); return Response.json({ workflow_run_id: 123 }); }
    if (path.includes("/workflows/")) return Response.json({ state: "active", path: ".github/workflows/upgrade-web.yml" });
    return Response.json({ private: true });
  };
  try {
    const view = await prepareWebUpdate(env, "admin"); const id = view.request!.requestId;
    assert.equal(view.request!.targetTag, "v1.0.4"); assert.equal(view.request!.targetCommit, sha);
    await assert.rejects(startWebUpdate(env, { requestId: id, backupSaved: true }), { code: "backup_required" });
    await recordUpdateBackup(env, id);
    await assert.rejects(startWebUpdate(env, { requestId: id, backupSaved: false }), { code: "backup_required" });
    await Promise.all([startWebUpdate(env, { requestId: id, backupSaved: true }), startWebUpdate(env, { requestId: id, backupSaved: true })]);
    assert.equal(dispatches, 1);
  } finally { globalThis.fetch = previous; }
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
    for (const call of calls.filter((entry) => entry.url.includes("/repos/isriah/LancerLogin"))) assert.equal(new Headers(call.init?.headers).get("authorization"), "Bearer synthetic-token");
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
    assert.deepEqual(await restarted.flush((scan: typeof event) => sendAttendance(config, scan, { fetchImpl: async () => Response.json({ accepted: true, eventId: scan.eventId }) })), [event.eventId]);
    const response = await worker.fetch(new Request("https://api.test/kiosk/attendance", { method: "POST" }), env); assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
    const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
    const backup = await worker.fetch(new Request("https://api.test/admin/data/backup?scope=installation", { headers: { cookie } }), env);
    assert.equal(backup.status, 200); const content = await backup.json(); assert.equal("web_update_requests" in content.tables, false); assert.equal(JSON.stringify(content).includes("synthetic-token"), false);
    database.sqlite.exec("DELETE FROM installations WHERE id = 'primary'");
    assert.equal((await latestUpdate(env))?.state, "recovery_required");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

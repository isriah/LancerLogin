import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const requestId = "11111111-1111-1111-1111-111111111111";
const sha = "b".repeat(40);
const release = { tag_name: "v1.0.0", draft: false, prerelease: false, body: "Synthetic notes", assets: ["install-lancerlogin.sh", "install-lancerlogin.sh.sha256", ...["arm64", "armv7"].flatMap((arch) => [`lancerlogin-kiosk-1.0.0-linux-${arch}.tar.gz`, `lancerlogin-kiosk-1.0.0-linux-${arch}.tar.gz.sha256`])].map((name) => ({ name })) };
// Run the actual updater module inside workerd; only its outbound provider is synthetic.
const updater = (await transform(await readFile("apps/api/src/web-updates.ts", "utf8"), { loader: "ts", format: "esm" })).code.replace(/\nexport \{[\s\S]*?\};\s*$/, "");
const script = `${updater}
export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/runtime') return Response.json({ manual: new Request('https://example.invalid', { redirect: 'manual' }).redirect, timeout: typeof AbortSignal.timeout });
  try { const result = path === '/prepare' ? await prepareWebUpdate(env, 'synthetic-admin') : path === '/start' ? await startWebUpdate(env, await request.json(), 'synthetic-admin') : await webUpdateStatus(env); return Response.json(result); }
  catch(error) { return Response.json({ code: error.code, error: error.message }, { status: error.status || 500 }); }
} };`;

async function runtime({ redirectPath, redirectStatus = 302, statusRunId = "123" } = {}) {
  const calls = [];
  const worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: "2026-08-01", d1Databases: ["DB"],
    bindings: { ALLOWED_ORIGIN: "https://example-dashboard.pages.dev", RELEASE_VERSION: "0.24.0", UPDATE_REPOSITORY: "example/private-install", WEB_UPDATE_TOKEN: "synthetic-runtime-token", WEB_UPDATE_TOKEN_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString() },
    outboundService: async (request) => {
      const url = new URL(request.url); const path = url.pathname; calls.push({ path, url: request.url, method: request.method, authorization: request.headers.get("authorization") });
      assert.equal(url.origin, "https://api.github.com", "No provider redirect may be followed");
      if (path === redirectPath) return new Response(null, { status: redirectStatus, headers: { location: "https://redirect-target.invalid/credential-sink" } });
      if (path.endsWith("/dispatches")) return Response.json({ workflow_run_id: 123 });
      if (path.endsWith("/releases/latest")) return Response.json(release);
      if (path.includes("/commits/")) return Response.json({ sha });
      if (path.endsWith("/runs")) return Response.json({ workflow_runs: [{ id: Number(statusRunId), display_title: `LancerLogin web update ${requestId}`, path: ".github/workflows/upgrade-web.yml" }] });
      if (path.includes("/actions/runs/")) return Response.json({ event: "workflow_dispatch", status: "waiting", display_title: `LancerLogin web update ${requestId}`, path: ".github/workflows/upgrade-web.yml" });
      if (path.includes("/workflows/")) return Response.json({ state: "active", path: ".github/workflows/upgrade-web.yml" });
      return Response.json({ private: true });
    },
  }));
  try {
    const database = await worker.getD1Database("DB");
    await database.exec("CREATE TABLE audit_log (id TEXT PRIMARY KEY, installation_id TEXT, actor_user_id TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT)");
    await database.exec((await readFile("apps/api/migrations/0029_web_updates.sql", "utf8")).replace(/^--.*$/gm, "").replaceAll("\n", " "));
    const fetch = (path, body) => worker.dispatchFetch(`http://localhost${path}`, body ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {});
    const seed = async ({ state = "prepared", runId = null } = {}) => database.prepare("INSERT INTO web_update_requests (id, installation_id, release_tag, release_sha, release_notes, previous_version, state, created_at, expires_at, updated_at, backup_exported_at, started_at, run_id) VALUES (?, 'primary', 'v1.0.0', ?, '', '0.24.0', ?, ?, ?, ?, ?, ?, ?)").bind(requestId, sha, state, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString(), new Date().toISOString(), state === "prepared" ? null : new Date().toISOString(), runId).run();
    return { worker, database, fetch, seed, calls };
  } catch (error) { await worker.dispose(); throw error; }
}

test("actual workerd updater prepare performs supported fixed manual GETs", async () => {
  const instance = await runtime();
  try {
    const probe = await (await instance.fetch("/runtime")).json();
    assert.equal(probe.manual, "manual"); assert.equal(probe.timeout, "function");
    const prepared = await instance.fetch("/prepare", {}); assert.equal(prepared.status, 200); const result = await prepared.json(); assert.equal(result.request.targetTag, "v1.0.0"); assert.equal(result.request.targetCommit, sha);
    assert.equal(instance.calls.length, 4);
    assert.equal(instance.calls.slice(0, 2).every((call) => call.authorization === "Bearer synthetic-runtime-token"), true);
    assert.equal(instance.calls.slice(2).every((call) => call.authorization === null), true);
  } finally { await instance.worker.dispose(); }
});

test("actual workerd prepare rejects 3xx before persistence on authenticated and public GETs", async () => {
  for (const redirectStatus of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    for (const [redirectPath, count] of [["/repos/example/private-install", 1], ["/repos/example/private-install/actions/workflows/upgrade-web.yml", 2], ["/repos/isriah/LancerLogin/releases/latest", 3], ["/repos/isriah/LancerLogin/commits/v1.0.0", 4]]) {
      const instance = await runtime({ redirectPath, redirectStatus });
      try {
        const result = await instance.fetch("/prepare", {}); assert.equal(result.status, 503, `${redirectStatus} ${redirectPath}`); const error = await result.json(); assert.equal(error.code, "provider_unavailable"); assert.match(error.error, /redirect/i);
        assert.equal(instance.calls.length, count);
        assert.equal((await instance.database.prepare("SELECT COUNT(*) AS count FROM web_update_requests").first()).count, 0);
      } finally { await instance.worker.dispose(); }
    }
  }
});

test("actual workerd normal dispatch and status preserve the pinned request", async () => {
  const instance = await runtime();
  try {
    await instance.seed();
    const started = await (await instance.fetch("/start", { requestId, backupSaved: true })).json();
    assert.equal(started.request.state, "queued"); assert.equal(started.request.targetCommit, sha);
    const status = await (await instance.fetch("/status")).json();
    assert.equal(status.request.state, "awaiting_approval"); assert.equal(status.request.requestId, requestId);
    assert.deepEqual(instance.calls.map((call) => call.method), ["POST", "GET"]);
    assert.equal(instance.calls.every((call) => call.authorization === "Bearer synthetic-runtime-token"), true);
  } finally { await instance.worker.dispose(); }
});

test("actual workerd D1 includes the started audit trigger in change metadata", async () => {
  const instance = await runtime();
  try {
    await instance.seed();
    const result = await instance.database.prepare("UPDATE web_update_requests SET state = 'dispatching', started_at = ?, started_by = 'synthetic-admin' WHERE id = ? AND state = 'prepared'").bind(new Date().toISOString(), requestId).run();
    assert.equal(result.meta.changes, 2);
    assert.equal((await instance.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'web_update.started'").first()).count, 1);
  } finally { await instance.worker.dispose(); }
});

test("actual workerd simultaneous Admin starts and replay dispatch once and audit once", async () => {
  const instance = await runtime();
  try {
    await instance.seed(); const input = { requestId, backupSaved: true };
    await Promise.all(Array.from({ length: 3 }, () => instance.fetch("/start", input)));
    const replay = await (await instance.fetch("/start", input)).json();
    assert.equal(replay.request.state, "queued"); assert.equal(replay.request.targetCommit, sha);
    assert.equal(instance.calls.length, 1); assert.equal(instance.calls[0].method, "POST");
    const row = await instance.database.prepare("SELECT started_by, run_id FROM web_update_requests WHERE id = ?").bind(requestId).first();
    assert.deepEqual(row, { started_by: "synthetic-admin", run_id: "123" });
    assert.equal((await instance.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'web_update.started'").first()).count, 1);
  } finally { await instance.worker.dispose(); }
});

test("actual workerd redirected dispatch retains ambiguity and replay never dispatches twice", async () => {
  const instance = await runtime({ redirectPath: "/repos/example/private-install/actions/workflows/upgrade-web.yml/dispatches", redirectStatus: 307 });
  try {
    await instance.seed(); const input = { requestId, backupSaved: true };
    for (let replay = 0; replay < 2; replay++) {
      const result = await (await instance.fetch("/start", input)).json(); assert.equal(result.request.state, "dispatching"); assert.equal(result.request.errorCode, "dispatch_ambiguous");
    }
    assert.equal(instance.calls.length, 1); assert.equal(instance.calls[0].method, "POST"); assert.equal(instance.calls[0].authorization, "Bearer synthetic-runtime-token");
  } finally { await instance.worker.dispose(); }
});

test("actual workerd status rejects redirected reconciliation/details and retains durable claim", async () => {
  for (const [runId, redirectPath] of [[null, "/repos/example/private-install/actions/workflows/upgrade-web.yml/runs"], ["123", "/repos/example/private-install/actions/runs/123"]]) {
    const instance = await runtime({ redirectPath });
    try {
      await instance.seed({ state: "dispatching", runId });
      const result = await instance.fetch("/status"); assert.equal(result.status, 503); assert.equal((await result.json()).code, "provider_unavailable");
      const row = await instance.database.prepare("SELECT * FROM web_update_requests WHERE id = ?").bind(requestId).first(); assert.equal(row.state, "dispatching"); assert.equal(row.run_id, runId);
      assert.equal(instance.calls.length, 1); assert.equal(instance.calls[0].method, "GET"); assert.equal(instance.calls[0].authorization, "Bearer synthetic-runtime-token");
    } finally { await instance.worker.dispose(); }
  }
});

// quick-check: covers apps/api/migrations/**
// The bulk Discord label routes on real local D1 (Miniflare's workerd), with a synthetic Discord server answered inside the
// Worker: D1's own batches, json_each and change counts, at 25 labels. The harness counts what the Workers Free plan counts
// toward its 50 subrequests per invocation: each D1 query, each db.batch() and each Discord request. No request leaves
// the process. tests-ts/discord-label-bulk-limits.test.ts covers the results and failures in detail.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { createMiniflareD1 } from "./fixtures/miniflare-d1.mjs";

const harness = `import worker from './apps/api/src/index.ts';
import { encryptIntegration } from './apps/api/src/integration-crypto.ts';
const guildId = '123456789012345678', botId = '523456789012345678', botRoleId = '623456789012345678';
const roleId = (index) => String(700000000000000000n + BigInt(index)), userId = (index) => String(800000000000000000n + BigInt(index));
// Fifty roles: 1 to 25 are linked to the seeded labels, 26 to 50 are not linked yet. Twelve members (or SYNTHETIC_MEMBERS),
// each holding a few roles. A role change is accepted and changes nothing, so a job pass has every member left to do.
const roles = [{ id: guildId, name: '@everyone', position: 0, permissions: '0' }, { id: botRoleId, name: 'Test Bot', position: 100, permissions: String(1 << 28) }, ...Array.from({ length: 50 }, (_, index) => ({ id: roleId(index + 1), name: 'Test Role ' + (index + 1), position: index + 1, permissions: '0' }))];
const membersFor = (count) => Array.from({ length: count }, (_, index) => ({ user: { id: userId(index + 1), username: 'test-student-' + (index + 1) }, roles: Array.from({ length: 25 }, (_, role) => role + 1).filter((role) => (role + index) % 4 === 0).map(roleId) }));
function discord(url, memberCount) {
  if (url.endsWith('/roles')) return Response.json(roles);
  if (url.endsWith('/users/@me')) return Response.json({ id: botId });
  if (url.endsWith('/members/' + botId)) return Response.json({ user: { id: botId }, roles: [botRoleId] });
  if (url.includes('/members?limit=1000')) return Response.json(membersFor(memberCount));
  if (url.includes('/members/') && url.includes('/roles/')) return new Response(null, { status: 204 });
  return Response.json({ message: 'Unexpected synthetic Discord request' }, { status: 500 });
}
function counting(database, count) {
  const originals = new WeakMap();
  const wrap = (statement) => {
    const wrapped = { bind: (...values) => wrap(statement.bind(...values)), first: (...args) => { count(); return statement.first(...args); }, all: () => { count(); return statement.all(); }, run: () => { count(); return statement.run(); }, raw: (...args) => { count(); return statement.raw(...args); } };
    originals.set(wrapped, statement); return wrapped;
  };
  return { prepare: (sql) => wrap(database.prepare(sql)), batch: (statements) => { count(); return database.batch(statements.map((statement) => originals.get(statement) ?? statement)); } };
}
// One wrapper for the isolate, as a Worker has one binding: Core keeps per-database state by the database's identity.
let subrequests = 0, database;
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/__seed-discord') {
    const encrypted = await encryptIntegration({ botToken: 'synthetic-bot-token', guildId }, env.INTEGRATION_KEY);
    await env.DB.prepare("INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, verified_at, updated_at) VALUES ('discord-1', 'primary', 'discord', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')").bind(encrypted.ciphertext, encrypted.iv).run();
    return new Response('seeded');
  }
  subrequests = 0; database ??= counting(env.DB, () => { subrequests += 1; }); const original = globalThis.fetch;
  const memberCount = Number(env.SYNTHETIC_MEMBERS ?? 12);
  globalThis.fetch = async (input) => { subrequests += 1; return discord(String(input instanceof Request ? input.url : input), memberCount); };
  try {
    // With x-test-background, the work the request leaves running in its invocation (waitUntil) is run and counted too.
    const running = [];
    const result = await worker.fetch(request, { ...env, DB: database }, request.headers.get('x-test-background') ? { waitUntil: (promise) => { running.push(promise); } } : undefined);
    const body = await result.arrayBuffer(); await Promise.all(running);
    const response = new Response(body, result); response.headers.set('x-test-subrequests', String(subrequests)); return response;
  } finally { globalThis.fetch = original; }
} };`;

/** Well under the 50 the plan allows. */
const subrequestBudget = 15;

/**
 * A Worker on local D1 with `members` synthetic members (member `unpaired` has no Discord account) and 25 labels linked to
 * roles 1 to 25; member m holds label l when (l + m) % 3 = 0.
 */
async function start(members = 12, unpaired = 12) {
  const bundled = await build({ stdin: { contents: harness, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
  const secret = "A".repeat(43);
  const { runtime, database } = await createMiniflareD1({ script: bundled.outputFiles[0].text, bindings: { APP_MODE: "configured", ALLOWED_ORIGIN: "https://example.test", SESSION_KEY: secret, INTEGRATION_KEY: secret, SYNTHETIC_MEMBERS: String(members) } });
  try {
    await database.exec(`INSERT INTO installations(id,created_at,auth_mode,discord_enabled) VALUES ('primary','2026-01-01','local',1);
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${members}) INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,created_at) SELECT 'm'||x,'primary','TEST-'||x,'Test Student','No. '||x,CASE WHEN x=${unpaired} THEN NULL ELSE CAST(800000000000000000+x AS TEXT) END,'2026-01-01' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<25) INSERT INTO member_labels(id,installation_id,name,created_at) SELECT 'label'||x,'primary','Test Label '||printf('%02d',x),'2026-01-01' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<25) INSERT INTO discord_label_role_mappings(installation_id,label_id,guild_id,role_id,role_name,created_at) SELECT 'primary','label'||x,'123456789012345678',CAST(700000000000000000+x AS TEXT),'Test Role '||x,'2026-01-01' FROM n;
      WITH RECURSIVE l(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM l WHERE x<25), m(y) AS (VALUES(1) UNION ALL SELECT y+1 FROM m WHERE y<${members}) INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_by,created_at) SELECT 'c'||x||'-'||y,'primary','m'||y,'label'||x,'add','2026-02-01','admin','2026-02-01T00:00:00.000Z' FROM l CROSS JOIN m WHERE (x+y)%3=0;`.replace(/\n/g, " "));
    const payload = Buffer.from(JSON.stringify({ userId: "admin", role: "admin", expiresAt: Date.now() + 60_000 })).toString("base64url");
    const cookie = `lancerlogin_session=${payload}.${createHmac("sha256", Buffer.from(secret, "base64url")).update(payload).digest("base64url")}`;
    assert.equal(await (await runtime.dispatchFetch("https://example.test/__seed-discord")).text(), "seeded");
    await (await runtime.dispatchFetch("https://example.test/health")).text();
    const post = async (path, body, background = false) => {
      const result = await runtime.dispatchFetch(`https://example.test/admin/integrations/discord/${path.startsWith("label-role-jobs/") ? path : `label-roles/${path}`}`, { method: "POST", headers: { cookie, "content-type": "application/json", ...(background ? { "x-test-background": "1" } : {}) }, body: JSON.stringify(body) });
      return { status: result.status, subrequests: Number(result.headers.get("x-test-subrequests")), body: await result.json() };
    };
    const count = async (sql) => (await database.prepare(sql).first()).n;
    return { runtime, database, post, count };
  } catch (error) { await runtime.dispose(); throw error; }
}

test("real D1 runs the bulk Discord label routes at 25 labels in a fixed, small number of subrequests", async () => {
  const { runtime, database, post, count } = await start();
  try {

    const previewed = await post("preview-all", {});
    assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
    assert.equal(previewed.body.previews.length, 25); assert.deepEqual(previewed.body.skipped, []);
    assert.ok(previewed.subrequests > 0 && previewed.subrequests <= subrequestBudget, `preview-all made ${previewed.subrequests} subrequests`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM discord_label_role_previews"), 25);
    const changes = previewed.body.previews.reduce((total, preview) => total + preview.additions.length + preview.removals.length, 0);
    assert.ok(changes > 25, "the synthetic server differs from the roster for most labels");

    const applied = await post("apply-all", { previewIds: previewed.body.previews.map((preview) => preview.previewId) });
    assert.equal(applied.status, 202, JSON.stringify(applied.body));
    assert.equal(applied.body.jobs.length, 25); assert.deepEqual(applied.body.failed, []);
    assert.ok(applied.subrequests > 0 && applied.subrequests <= subrequestBudget, `apply-all made ${applied.subrequests} subrequests`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM discord_label_role_jobs"), 25);
    assert.equal(await count("SELECT COUNT(*) AS n FROM discord_label_role_job_items WHERE status = 'pending' AND action IN ('add','remove') AND length(discord_user_id) = 18"), changes);
    assert.equal(await count("SELECT COUNT(*) AS n FROM discord_label_role_previews WHERE used_at IS NOT NULL"), 25);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'discord.label_role_sync_requested'"), 25);
    for (const job of applied.body.jobs) assert.equal(await count(`SELECT COUNT(*) AS n FROM discord_label_role_job_items WHERE job_id = '${job.jobId}'`), job.additions + job.removals);

    // A used preview starts nothing, by D1's own change count.
    const repeated = await post("apply-all", { previewIds: previewed.body.previews.map((preview) => preview.previewId) });
    assert.deepEqual(repeated.body.jobs, []); assert.equal(repeated.body.failed.length, 25);
    assert.equal(await count("SELECT COUNT(*) AS n FROM discord_label_role_jobs"), 25);

    // Roles 26 to 50 become labels: five reuse an existing unlinked label whatever its capitalization, twenty are created.
    await database.exec("WITH RECURSIVE n(x) AS (VALUES(26) UNION ALL SELECT x+1 FROM n WHERE x<30) INSERT INTO member_labels(id,installation_id,name,created_at) SELECT 'existing'||x,'primary','TEST ROLE '||x,'2026-01-01' FROM n;");
    const imported = await post("from-roles", { roleIds: Array.from({ length: 25 }, (_, index) => String(700000000000000026n + BigInt(index))) });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.linked.length, 25); assert.equal(imported.body.linked.filter((item) => item.created).length, 20);
    assert.deepEqual(imported.body.linked.slice(0, 5).map((item) => [item.labelId, item.labelName]), [26, 27, 28, 29, 30].map((x) => [`existing${x}`, `TEST ROLE ${x}`]));
    assert.ok(imported.subrequests > 0 && imported.subrequests <= subrequestBudget, `from-roles made ${imported.subrequests} subrequests`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM discord_label_role_mappings"), 50); assert.equal(await count("SELECT COUNT(*) AS n FROM member_labels"), 50);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'discord.label_role_associated'"), 25); assert.equal(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'label.created'"), 20);
    // Importing them again is refused as a whole.
    const again = await post("from-roles", { roleIds: ["700000000000000026", "700000000000000051"] });
    assert.ok([400, 409].includes(again.status)); assert.equal(await count("SELECT COUNT(*) AS n FROM discord_label_role_mappings"), 50);
    console.log(JSON.stringify({ benchmark: "discord_label_bulk_subrequests_d1", labels: 25, previewAll: previewed.subrequests, applyAll: applied.subrequests, fromRoles: imported.subrequests }));
  } finally { await runtime.dispose(); }
});

/** A request together with the job pass it starts in its invocation: under the 50 the plan allows, with room to spare. */
const invocationBudget = 45;

test("real D1 keeps each one-label sync route and the job pass it starts within one invocation's subrequests", async () => {
  // Thirty paired members: labels 1 and 2 each have more role changes than a job pass does.
  const { runtime, database, post, count } = await start(30, 0);
  try {
    const items = (jobId, status) => count(`SELECT COUNT(*) AS n FROM discord_label_role_job_items WHERE job_id = '${jobId}' AND status = '${status}'`);
    const preview = await post("preview", { labelId: "label1" });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const changes = preview.body.additions.length + preview.body.removals.length;
    assert.ok(changes >= 8, `${changes} role changes`);
    const applied = await post("apply", { previewId: preview.body.previewId }, true);
    assert.equal(applied.status, 202, JSON.stringify(applied.body));
    assert.ok(applied.subrequests > 0 && applied.subrequests <= invocationBudget, `apply and its job pass made ${applied.subrequests} subrequests`);
    const done = await items(applied.body.jobId, "completed");
    assert.ok(done > 0 && done < changes, "the pass changed some members and left the rest pending"); assert.equal(await items(applied.body.jobId, "pending"), changes - done);

    await database.exec(`UPDATE discord_label_role_jobs SET status = 'partial' WHERE id = '${applied.body.jobId}'; UPDATE discord_label_role_job_items SET status = 'failed' WHERE job_id = '${applied.body.jobId}';`);
    const retried = await post(`label-role-jobs/${applied.body.jobId}/retry`, {}, true);
    assert.equal(retried.status, 202, JSON.stringify(retried.body)); assert.equal(retried.body.retried, changes);
    assert.ok(retried.subrequests > 0 && retried.subrequests <= invocationBudget, `retry and its job pass made ${retried.subrequests} subrequests`);
    assert.ok(await items(retried.body.jobId, "completed") > 0 && await items(retried.body.jobId, "pending") > 0);

    const review = await post("two-way/preview", { labelId: "label2" });
    assert.equal(review.status, 200, JSON.stringify(review.body)); assert.ok(review.body.mismatches.length >= 8, `${review.body.mismatches.length} mismatches`);
    const confirmed = await post("two-way/confirm", { previewId: review.body.previewId, all: "dashboard" }, true);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body)); assert.equal(confirmed.body.rolesAdded + confirmed.body.rolesRemoved, review.body.mismatches.length);
    assert.ok(confirmed.subrequests > 0 && confirmed.subrequests <= invocationBudget, `two-way confirm and its job pass made ${confirmed.subrequests} subrequests`);
    assert.ok(await items(confirmed.body.jobId, "completed") > 0 && await items(confirmed.body.jobId, "pending") > 0);
    console.log(JSON.stringify({ benchmark: "discord_label_single_subrequests_d1", apply: applied.subrequests, retry: retried.subrequests, twoWayConfirm: confirmed.subrequests }));
  } finally { await runtime.dispose(); }
});

// End to end: compose the unshipped Example plugin, which provides `example.items`, and the unshipped Consumer plugin, which
// optionally uses it, from local git commits, then run their calls through the real Worker. Composition runs in a child
// process, and this process redirects Core's generated plugin files to its output before importing any application module.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareTestComposition } from "../scripts/test-plugin-sources.mjs";
import { isolatedGitEnv } from "../scripts/git-env.mjs";

const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-interface-worker-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: isolatedGitEnv() });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
function repository(name: string) {
  const directory = join(scratch, "source", name);
  cpSync(`tests/fixtures/module-plugins/${name}`, directory, { recursive: true });
  git(directory, "init", "--quiet"); git(directory, "add", "-A"); git(directory, "commit", "--quiet", "-m", "Synthetic plugin");
  return { id: name, source: pathToFileURL(directory).href, commit: git(directory, "rev-parse", "HEAD") };
}
const output = join(scratch, "output");
mkdirSync(join(output, "apps/dashboard/src"), { recursive: true });
writeFileSync(join(output, "apps/dashboard/src/module-contributions.ts"), "export type DashboardModuleContribution = unknown;\n");
// Official modules stay out: these calls involve only the two synthetic plugins.
const prepared = prepareTestComposition({ modules: [repository("example"), repository("consumer")], officialModules: false, scratch });
if ("reason" in prepared) throw new Error(prepared.reason as string);
const composed = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/compose-modules.mjs", ...prepared.args, "--output-root", output, "--work-directory", join(scratch, "plugins")], { encoding: "utf8", env: prepared.env });
if (composed.status !== 0) throw new Error(`Composition failed: ${composed.stderr}${composed.stdout}`);

const redirected = ["packages/shared/src/generated/external-manifests.ts", "apps/api/src/generated/external-modules.ts", "apps/api/src/generated/external-module-data.ts"];
const coreParent = new URL("../package.json", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@lancerlogin/module-sdk" || specifier.startsWith("@lancerlogin/module-sdk/")) return nextResolve(specifier, { ...context, parentURL: coreParent });
    const resolved = nextResolve(specifier, context);
    const target = redirected.find((path) => resolved.url.endsWith(`/${path}`));
    return target ? { ...resolved, url: pathToFileURL(join(output, target)).href } : resolved;
  },
});
const { default: worker, registeredModuleSchedulerJobs } = await import("../apps/api/src/index.ts");
const { BackupDatabase, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");
const { runModuleCleanup } = await import("../apps/api/src/module-cleanup.ts");

/** The migrated fixture database with D1 batch semantics. `beforeBatch` runs once before the next matching batch. */
class PluginDatabase extends BackupDatabase {
  beforeBatch?: { match: string; run: () => Promise<void> };
  prepare(sql: string) {
    let values: unknown[] = []; const raw = this.raw;
    const statement = {
      sql,
      bind(...args: unknown[]) { values = args; return statement; },
      async first() { return raw.prepare(sql).get(...values as never[]) ?? null; },
      async all() { return { results: raw.prepare(sql).all(...values as never[]), meta: { changes: 0 } }; },
      async run() { const result = raw.prepare(sql).run(...values as never[]); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  }
  async batch(statements: { sql?: string; all(): Promise<unknown>; run(): Promise<unknown> }[]) {
    const hook = this.beforeBatch;
    if (hook && statements.some((statement) => statement.sql?.includes(hook.match))) { this.beforeBatch = undefined; await hook.run(); }
    this.batches += 1; this.raw.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(/^\s*(?:SELECT|WITH)\b/i.test(statement.sql ?? "") ? await statement.all() : await statement.run()); this.raw.exec("COMMIT"); return results; }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
}

const origin = "https://dashboard.example.test";
type CallOptions = { method?: string; body?: unknown; dashboard?: boolean; signedIn?: boolean; user?: "admin" | "operator"; stale?: boolean };
function installation() {
  const db = new PluginDatabase();
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: origin };
  const call = async (path: string, init: CallOptions = {}) => {
    const headers: Record<string, string> = {};
    // A stale session was signed in more than ten minutes ago, outside the fresh-authentication window.
    const issuedAt = init.stale ? Date.now() - 11 * 60_000 : Date.now();
    if (init.signedIn !== false) headers.cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret, () => issuedAt).issue({ userId: init.user ?? "admin", role: init.user ?? "admin" });
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.dashboard) headers.origin = origin;
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env as never);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const configure = async (enabled: string[], confirmDisable: { moduleId: string; generation: number }[] = []) => {
    const current = await call("/platform/modules");
    const result = await call("/admin/modules", { method: "PUT", body: { enabled, revision: current.body.revision, confirmDisable } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const generation = async (moduleId: string) => (await call("/platform/modules")).body.modules.find((module: any) => module.id === moduleId).generation as number;
  const setUp = async (moduleId: string, stepId: string) => assert.equal((await call(`/admin/modules/${moduleId}/setup`, { method: "PUT", body: { generation: await generation(moduleId), stepId, outcome: "completed" } })).status, 200);
  const job = async () => registeredModuleSchedulerJobs.find((item) => item.id === "consumer.sync")!.run(env as never);
  const runs = () => db.rows<{ outcome: string; detail: string }>("SELECT outcome, detail FROM consumer_runs ORDER BY rowid DESC LIMIT 1")[0];
  const viaUser = (operation: string, input?: unknown, user: "admin" | "operator" = "admin") => call("/admin/consumer/call", { body: { operation, input }, dashboard: true, user });
  const viaGrant = (operation: string, input?: unknown) => call("/public/consumer/call", { body: { operation, input }, signedIn: false });
  const grants = async () => (await call("/admin/modules/grants")).body;
  const grant = (operations: string[], init: CallOptions = {}) => call("/admin/modules/grants", { body: { consumer: "consumer", interface: "example.items", version: 1, operations }, dashboard: true, ...init });
  return { db, env, call, configure, generation, setUp, job, runs, viaUser, viaGrant, grants, grant };
}

test("a consumer calls a provider's interface with a signed-in user's access or an Admin's grant, and nothing else", async () => {
  const { db, call, configure, generation, setUp, job, runs, viaUser, viaGrant, grants, grant } = installation();
  assert.deepEqual((await call("/health", { signedIn: false })).body.modules, ["attendance", "example", "consumer"]);

  // The consumer works on its own: with the provider disabled, every path reports the interface unavailable.
  await configure(["attendance", "consumer"]);
  await setUp("consumer", "settings");
  assert.deepEqual((await viaUser("list")).body, { available: false });
  assert.deepEqual((await viaGrant("list")).body, { available: false });
  await job(); assert.equal(runs()?.outcome, "unavailable");
  let listed = await grants();
  assert.deepEqual(listed.uses, [{
    consumer: { id: "consumer", label: "Consumer", phase: "enabled" }, provider: { id: "example", label: "Example", state: "disabled" },
    interface: { id: "example.items", version: 1, label: "Example items" }, required: false, reason: "Copy Example items into Consumer runs",
    operations: [{ id: "list", label: "List Example items", grantable: true }, { id: "create", label: "Create Example items", grantable: true }, { id: "close", label: "Close Example items", grantable: false }],
    grantable: ["list", "create"], grant: null,
  }]);
  assert.deepEqual(listed.reauthentication, { freshUntil: listed.reauthentication.freshUntil, password: false, google: false });

  // Enabled but not set up is still unavailable.
  await configure(["attendance", "consumer", "example"]);
  assert.equal((await grants()).uses[0].provider.state, "setup-required");
  assert.deepEqual((await viaUser("list")).body, { available: false });
  db.raw.exec("INSERT INTO example_items(installation_id,id,title,created_at) VALUES ('primary','first','First item','2026-10-26T00:00:00.000Z')");
  await setUp("example", "catalog");
  assert.equal((await grants()).uses[0].provider.state, "ready");

  // A signed-in Admin's own access authorizes the call; without a user or a grant there is none.
  assert.deepEqual((await viaUser("list")).body, { available: true, result: { items: [{ id: "first", title: "First item" }] } });
  assert.deepEqual((await viaGrant("list")).body, { available: false });
  await job(); assert.equal(runs()?.outcome, "unavailable");
  assert.deepEqual(db.rows("SELECT actor_user_id, target_id, json_extract(metadata_json,'$.consumer') AS consumer, json_extract(metadata_json,'$.operation') AS operation FROM audit_log WHERE action='module.interface_called'"), [{ actor_user_id: "admin", target_id: "example.items", consumer: "consumer", operation: "list" }]);

  // An Operator needs the provider's capability, not just the consumer's.
  let assignments = await call("/admin/modules/assignments/operator");
  assignments = await call("/admin/modules/assignments/operator", { method: "PUT", body: { capabilities: ["consumer.manage"], revision: assignments.body.revision } });
  assert.equal(assignments.status, 200, JSON.stringify(assignments.body));
  assert.deepEqual((await viaUser("list", {}, "operator")).body, { available: false });
  assignments = await call("/admin/modules/assignments/operator", { method: "PUT", body: { capabilities: ["consumer.manage", "example.manage"], revision: assignments.body.revision } });
  assert.equal((await viaUser("list", {}, "operator")).body.available, true);

  // Granting needs an active Admin, the dashboard origin, fresh authentication and exactly the operations reviewed.
  assert.equal((await grant(["list", "create"], { dashboard: false })).status, 403);
  const stale = await grant(["list", "create"], { stale: true });
  assert.equal(stale.status, 401); assert.equal(stale.body.code, "reauthentication_required");
  assert.equal((await grant(["list", "create"], { user: "operator" })).status, 403);
  for (const operations of [["list"], ["list", "create", "close"]]) { const changed = await grant(operations); assert.equal(changed.status, 409); assert.equal(changed.body.code, "grant_changed"); }
  assert.equal((await call("/admin/modules/grants", { body: { consumer: "consumer", interface: "example.items", version: 2, operations: ["list"] }, dashboard: true })).status, 404);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_interface_grants"), 0);
  const granted = await grant(["list", "create"]);
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  const grantId = granted.body.uses[0].grant.id as string;
  assert.deepEqual(granted.body.uses[0].grant, { id: grantId, operations: ["list", "create"], grantedAt: granted.body.uses[0].grant.grantedAt, grantedBy: "admin", current: true });
  assert.deepEqual(db.rows("SELECT actor_user_id, target_id, json_extract(metadata_json,'$.operations') AS operations FROM audit_log WHERE action='module.interface_granted'"), [{ actor_user_id: "admin", target_id: grantId, operations: '["list","create"]' }]);

  // The grant authorizes a job and a public request; it never covers an operation the provider keeps for signed-in users.
  assert.deepEqual((await viaGrant("list")).body, { available: true, result: { items: [{ id: "first", title: "First item" }] } });
  await job(); assert.deepEqual(runs(), { outcome: "listed", detail: "first" });
  assert.deepEqual((await viaGrant("create", { id: "granted", title: "Granted item" })).body, { available: true, result: { id: "granted" } });
  assert.deepEqual(db.rows("SELECT note FROM example_requests WHERE id='granted-origin'"), [{ note: "Created by consumer with a grant" }]);
  assert.deepEqual((await viaGrant("close", { id: "granted" })).body, { available: true, failed: { status: 403, message: "Consumer has no access to Close Example items" } });
  assert.deepEqual((await viaUser("close", { id: "granted" })).body, { available: true, result: { closed: "granted" } });
  // Provider errors reach the caller with the provider's status and message; undeclared operations are refused.
  assert.deepEqual((await viaGrant("create", { id: "granted", title: "Again" })).body, { available: true, failed: { status: 409, message: "That Example item already exists" } });
  assert.deepEqual((await viaGrant("create", { title: "No ID" })).body, { available: true, failed: { status: 400, message: "An item ID and title are required" } });
  assert.deepEqual((await viaUser("close", { id: "missing" })).body, { available: true, failed: { status: 404, message: "That Example item does not exist" } });
  assert.deepEqual((await viaGrant("delete", { id: "granted" })).body, { available: true, failed: { status: 403, message: "Consumer did not declare that operation of Example items" } });
  const calls = db.rows<{ grantId: string | null; userId: string | null; actor: string | null }>("SELECT json_extract(metadata_json,'$.grantId') AS grantId, json_extract(metadata_json,'$.userId') AS userId, actor_user_id AS actor FROM audit_log WHERE action='module.interface_called'");
  assert.ok(calls.some((row) => row.grantId === grantId && row.actor === null && row.userId === null));
  assert.ok(calls.every((row) => Boolean(row.grantId) !== Boolean(row.userId)));

  // A grant covers the operations declared when it was granted. One made before `create` was declared does not cover it.
  db.raw.exec(`UPDATE platform_module_interface_grants SET operations_json='["list"]' WHERE id='${grantId}'`);
  listed = await grants();
  assert.equal(listed.uses[0].grant.current, false);
  assert.deepEqual((await viaGrant("create", { id: "uncovered", title: "Uncovered" })).body, { available: true, failed: { status: 403, message: "Consumer has no access to Create Example items" } });
  assert.equal((await viaGrant("list")).body.available, true);
  const regranted = await grant(["list", "create"]);
  assert.equal(regranted.status, 201);
  const currentId = regranted.body.uses[0].grant.id as string;
  assert.notEqual(currentId, grantId);
  assert.deepEqual(db.rows("SELECT id, revoked_by FROM platform_module_interface_grants ORDER BY granted_at, revoked_at IS NULL"), [{ id: grantId, revoked_by: "admin" }, { id: currentId, revoked_by: null }]);

  // Revoking during a call, between two writes of the provider's handler, stops the second write.
  db.beforeBatch = { match: "INSERT INTO example_requests", run: async () => assert.equal((await call("/admin/modules/grants/revoke", { body: { grantId: currentId }, dashboard: true })).status, 200) };
  assert.deepEqual((await viaGrant("create", { id: "midway", title: "Midway" })).body, { available: true, failed: { status: 403, message: "Module authority changed; reload current state" } });
  assert.equal(db.count("SELECT COUNT(*) AS n FROM example_items WHERE id='midway'"), 1);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM example_requests WHERE id='midway-origin'"), 0);
  assert.deepEqual((await viaGrant("list")).body, { available: false });
  const again = await call("/admin/modules/grants/revoke", { body: { grantId: currentId }, dashboard: true });
  assert.equal(again.status, 409); assert.equal(again.body.code, "grant_changed");
  assert.equal((await call("/admin/modules/grants/revoke", { body: { grantId: currentId }, dashboard: true, stale: true })).status, 401);
  assert.deepEqual(db.rows("SELECT actor_user_id, target_id FROM audit_log WHERE action='module.interface_revoked'"), [{ actor_user_id: "admin", target_id: currentId }]);
  assert.equal((await grants()).uses[0].grant, null);

  // Disabling either module makes the grant unusable at once; it works again when the module returns within retention.
  assert.equal((await grant(["list", "create"])).status, 201);
  await configure(["attendance", "consumer"], [{ moduleId: "example", generation: await generation("example") }]);
  assert.deepEqual((await viaGrant("list")).body, { available: false });
  await job(); assert.equal(runs()?.outcome, "unavailable");
  await configure(["attendance", "consumer", "example"]);
  assert.equal((await viaGrant("list")).body.available, true);
  await configure(["attendance", "example"], [{ moduleId: "consumer", generation: await generation("consumer") }]);
  assert.equal((await viaGrant("list")).status, 409);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_interface_grants WHERE revoked_at IS NULL"), 1);

  // Deleting either module's retained data deletes its grants; enabling it again starts without access.
  db.raw.exec("UPDATE platform_modules SET disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z' WHERE module_id='consumer'");
  for (let pass = 0; pass < 10 && db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='consumer' AND phase='deleted'") === 0; pass += 1) await runModuleCleanup(db as never);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='consumer' AND phase='deleted'"), 1);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_interface_grants"), 0);
  await configure(["attendance", "example", "consumer"]);
  await setUp("consumer", "settings");
  assert.equal((await grants()).uses[0].grant, null);
  assert.deepEqual((await viaGrant("list")).body, { available: false });
  assert.equal(db.count("SELECT COUNT(*) AS n FROM example_items WHERE id IN ('first','granted','midway')"), 3);
});

test("grants are not portable: backups leave them out and an installation restore removes them", async () => {
  const { db, call, configure, setUp, viaGrant, grants, grant } = installation();
  await configure(["attendance", "example", "consumer"]);
  db.raw.exec("INSERT INTO example_items(installation_id,id,title,created_at) VALUES ('primary','first','First item','2026-10-26T00:00:00.000Z')");
  await setUp("example", "catalog"); await setUp("consumer", "settings");
  assert.equal((await grant(["list", "create"])).status, 201);
  assert.equal((await viaGrant("list")).body.available, true);
  const backup = await call("/admin/data/backup?scope=installation");
  assert.equal(backup.status, 200);
  assert.equal(JSON.stringify(backup.body).includes("platform_module_interface_grants"), false);
  assert.ok(backup.body.externalModules.some((entry: any) => entry.id === "consumer"));
  const restored = await call("/admin/data/restore", { body: { scope: "installation", confirmation: "RESTORE INSTALLATION", backup: backup.body } });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_interface_grants"), 0);
  assert.equal((await grants()).uses[0].grant, null);
  assert.equal((await grants()).uses[0].provider.state, "ready");
  assert.deepEqual((await viaGrant("list")).body, { available: false });
  // An Admin grants again after the restore.
  assert.equal((await grant(["list", "create"])).status, 201);
  assert.equal((await viaGrant("list")).body.available, true);
});

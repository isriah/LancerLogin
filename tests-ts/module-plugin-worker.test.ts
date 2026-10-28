// End to end: compose the unshipped Example plugin from a pinned git commit, then run it through the real Worker.
// Composition runs in a child process, and this process redirects Core's generated plugin files to its output
// before importing any application module, exactly as a composed build would bundle them.
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

const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-plugin-worker-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: isolatedGitEnv() });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const plugin = join(scratch, "source", "example");
cpSync("tests/fixtures/module-plugins/example", plugin, { recursive: true });
git(plugin, "init", "--quiet"); git(plugin, "add", "-A"); git(plugin, "commit", "--quiet", "-m", "Synthetic plugin");
const pin = { source: pathToFileURL(plugin).href, commit: git(plugin, "rev-parse", "HEAD") };
const output = join(scratch, "output");
mkdirSync(join(output, "apps/dashboard/src"), { recursive: true });
writeFileSync(join(output, "apps/dashboard/src/module-contributions.ts"), "export type DashboardModuleContribution = unknown;\n");
// Core's official modules (Outreach) compose beside Example as an installation build does, when their repository is
// reachable (LANCERLOGIN_PLUGIN_TOKEN or a local checkout); otherwise Example composes alone and the test reports why.
let prepared = prepareTestComposition({ modules: [{ id: "example", ...pin }], scratch });
const officialUnavailable = "reason" in prepared ? prepared.reason as string : undefined;
if (officialUnavailable && process.env.LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN === "1") throw new Error(officialUnavailable);
if (officialUnavailable) prepared = prepareTestComposition({ modules: [{ id: "example", ...pin }], officialModules: false, scratch });
if ("reason" in prepared) throw new Error(prepared.reason as string);
const composed = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/compose-modules.mjs", ...prepared.args, "--output-root", output, "--work-directory", join(scratch, "plugins")], { encoding: "utf8", env: prepared.env });
if (composed.status !== 0) throw new Error(`Composition failed: ${composed.stderr}${composed.stdout}`);

// Composition includes Core's official modules (Outreach) beside Example, as an installation build does; the module SDK
// resolves to this Core's copy wherever a plugin checkout is.
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
const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");
const { runModuleCleanup } = await import("../apps/api/src/module-cleanup.ts");

/** The migrated fixture database, with D1 batch semantics: every statement runs in one transaction and reads return rows. */
class PluginDatabase extends BackupDatabase {
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
    this.batches += 1; this.raw.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(/^\s*(?:SELECT|WITH)\b/i.test(statement.sql ?? "") ? await statement.all() : await statement.run()); this.raw.exec("COMMIT"); return results; }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
}

const origin = "https://dashboard.example.test";
function installation() {
  const db = new PluginDatabase();
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: origin };
  const call = async (path: string, init: { method?: string; body?: unknown; dashboard?: boolean; signedIn?: boolean } = {}) => {
    const headers: Record<string, string> = {};
    if (init.signedIn !== false) headers.cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.dashboard) headers.origin = origin;
    const response = await worker.fetch(new Request(`https://api.example.test${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env as never);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { db, env, call };
}

test("a composed plugin is migrated, registered, enabled, served, scheduled, backed up and deleted by the Worker", async (t) => {
  if (officialUnavailable) t.diagnostic(`Official modules were not composed: ${officialUnavailable}`);
  const { db, env, call } = installation();

  // Health reports the composed module set so an update can verify what was deployed.
  assert.deepEqual((await call("/health", { signedIn: false })).body.modules, ["attendance", ...officialUnavailable ? [] : ["hour-tracking"], "example"]);

  // The first request a new isolate serves, of any kind, applies the plugin's reviewed migration and records it before
  // any plugin code runs, without waiting for the scheduled pass or an Administrator.
  assert.deepEqual(db.rows("SELECT module_id, name FROM platform_module_migrations WHERE module_id='example'"), [{ module_id: "example", name: "0001_create_example_tables.sql" }]);
  assert.deepEqual(db.rows("SELECT origin, source_commit FROM platform_module_catalog WHERE module_id='example'"), [{ origin: "external", source_commit: pin.commit }]);

  // The snapshot then lists the registered module as disabled.
  let modules = await call("/platform/modules");
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  assert.deepEqual(modules.body.modules.find((module: any) => module.id === "example")?.phase, "disabled");
  assert.deepEqual(db.rows("SELECT module_id, sequence, name FROM platform_module_migrations"), [{ module_id: "example", sequence: 1, name: "0001_create_example_tables.sql" }]);
  assert.deepEqual(db.rows("SELECT origin, source, source_commit FROM platform_module_catalog WHERE module_id='example'"), [{ origin: "external", source: pin.source, source_commit: pin.commit }]);

  // Enabling requires setup before the workspace opens.
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance", "example"], revision: modules.body.revision } });
  assert.equal(modules.status, 200, JSON.stringify(modules.body));
  assert.equal((await call("/admin/example/items")).status, 403);
  db.raw.exec("INSERT INTO example_items(installation_id,id,title,created_at) VALUES ('primary','first','First item','2026-10-26T00:00:00.000Z')");
  const generation = modules.body.modules.find((module: any) => module.id === "example").generation;
  assert.equal((await call("/admin/modules/example/setup", { method: "PUT", body: { generation, stepId: "catalog", outcome: "completed" } })).status, 200);

  // Workspace, dashboard-origin mutation and public service routes are served by the plugin's handlers.
  assert.deepEqual((await call("/admin/example/items")).body, { items: [{ id: "first", title: "First item", requests: 0 }] });
  assert.equal((await call("/admin/example/items", { body: { id: "second", title: "Second item" } })).status, 403);
  assert.equal((await call("/admin/example/items", { body: { id: "second", title: "Second item" }, dashboard: true })).status, 201);
  assert.equal((await call("/public/example/requests", { body: { id: "request-1", itemId: "first" }, signedIn: false })).status, 202);
  assert.deepEqual((await call("/admin/example/environment")).body, { environmentKeys: [], credentials: true });

  // The scheduler runs the plugin's job inside its module-scoped database.
  await worker.scheduled({ cron: "*/5 * * * *" } as never, env as never);
  assert.deepEqual(db.rows("SELECT id, digest_count FROM example_items ORDER BY id"), [{ id: "first", digest_count: 1 }, { id: "second", digest_count: 1 }]);

  // Backups carry the plugin's portable rows in its own section with its pinned source.
  const backup = await call("/admin/data/backup?scope=installation");
  const section = backup.body.externalModules.find((entry: any) => entry.id === "example");
  assert.equal(section.source, pin.source); assert.equal(section.commit, pin.commit);
  assert.deepEqual(section.tables.example_items.map((row: any) => row.id).sort(), ["first", "second"]);
  assert.equal("example_requests" in section.tables, false);

  // Disabling retains the data; after the deadline, cleanup deletes only the plugin's rows.
  modules = await call("/platform/modules");
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance"], revision: modules.body.revision, confirmDisable: [{ moduleId: "example", generation }] } });
  assert.equal(modules.body.modules.find((module: any) => module.id === "example")?.phase, "retained");
  assert.equal((await call("/admin/example/items")).status, 403);
  db.raw.exec("UPDATE platform_modules SET disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z' WHERE module_id='example'");
  for (let pass = 0; pass < 10 && db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='example' AND phase='deleted'") === 0; pass += 1) await runModuleCleanup(db as never);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM example_items") + db.count("SELECT COUNT(*) AS n FROM example_requests"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='example' AND phase='deleted'"), 1);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM members"), 1);
});

test("first-Admin setup registers composed plugins at once, after earlier requests found no installation", async () => {
  const db = new PluginDatabase();
  // A new installation: the migrated database without the fixture's installation or any installation-scoped row.
  db.raw.exec("PRAGMA foreign_keys=OFF");
  for (const { name } of db.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'")) db.raw.exec(`DELETE FROM "${name}"`);
  db.raw.exec("PRAGMA foreign_keys=ON");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_administration"), 0);
  const setupCode = "synthetic setup code";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(setupCode)));
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: origin, BOOTSTRAP_CODE_HASH: Buffer.from(digest).toString("base64url") };
  const fetch = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://api.example.test${path}`, init), env as never, { waitUntil() {}, passThroughOnException() {} } as never);

  // Requests before setup reconcile nothing, because there is no installation yet.
  assert.equal((await fetch("/health")).status, 200);
  assert.equal((await fetch("/setup/status")).status, 200);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_catalog"), 0);

  const created = await fetch("/setup/bootstrap", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ setupCode, organizationName: "Synthetic", timeZone: "UTC", authMode: "local", localUsername: "admin", localPassword: "synthetic password 1234" }) });
  assert.equal(created.status, 201, await created.clone().text());
  // Setup itself applies the plugin's migration and records the catalog; no scheduled pass is needed.
  assert.deepEqual(db.rows("SELECT module_id, name FROM platform_module_migrations WHERE module_id='example'"), [{ module_id: "example", name: "0001_create_example_tables.sql" }]);
  assert.deepEqual(db.rows("SELECT origin, source_commit, installed FROM platform_module_catalog WHERE module_id='example'"), [{ origin: "external", source_commit: pin.commit, installed: 1 }]);
  assert.deepEqual(db.rows("SELECT phase FROM platform_modules WHERE module_id='example'"), [{ phase: "disabled" }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('example_items','example_requests')"), 2);

  // If setup's own reconciliation had failed, the next request in the same isolate would still record the modules.
  db.raw.exec("DELETE FROM platform_module_catalog");
  assert.equal((await fetch("/health")).status, 200);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_catalog WHERE module_id='example'"), 1);
});

test("a composed plugin sends email through Core's Resend connection and reads the installation time zone", async (t) => {
  const { db, env, call } = installation();
  const { encryptIntegration } = await import("../apps/api/src/integration-crypto.ts");
  let modules = await call("/platform/modules");
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance", "example"], revision: modules.body.revision } });
  db.raw.exec("INSERT INTO example_items(installation_id,id,title,created_at) VALUES ('primary','first','First item','2026-10-26T00:00:00.000Z')");
  const generation = modules.body.modules.find((module: any) => module.id === "example").generation;
  assert.equal((await call("/admin/modules/example/setup", { method: "PUT", body: { generation, stepId: "catalog", outcome: "completed" } })).status, 200);
  const timeZone = db.rows<{ time_zone: string }>("SELECT time_zone FROM organization_settings WHERE installation_id='primary'")[0]!.time_zone;

  // Without a verified Resend connection the service reports not ready and nothing is sent.
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let reply = () => new Response(JSON.stringify({ id: "email-1" }), { status: 200, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.resend.com/")) throw new Error(`Unexpected provider request ${url}`);
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return reply();
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  assert.deepEqual((await call("/admin/example/notify", { body: { to: "guest@example.test", key: "1" }, dashboard: true })).body, { ready: false, timeZone });
  db.raw.exec("UPDATE installations SET resend_enabled=1 WHERE id='primary'");
  const encrypted = await encryptIntegration({ apiKey: "re_synthetic_key", fromEmail: "team@example.test" }, sessionSecret);
  db.raw.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at) VALUES ('resend','primary','resend',?,?,'2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
  assert.equal((await call("/admin/example/notify", { body: { to: "guest@example.test", key: "1" }, dashboard: true })).body.ready, false, "an unverified connection is not ready");
  assert.equal(sent.length, 0);

  // A verified connection sends one message from Core's address, with a module-namespaced idempotency key.
  db.raw.exec("UPDATE encrypted_integrations SET verified_at='2026-01-02' WHERE provider='resend'");
  const delivered = await call("/admin/example/notify", { body: { to: "guest@example.test", key: "1" }, dashboard: true });
  assert.deepEqual(delivered.body, { ready: true, timeZone, id: "email-1" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers.get("idempotency-key"), "module-example-notice-1");
  assert.equal(sent[0]!.headers.get("authorization"), "Bearer re_synthetic_key");
  assert.deepEqual(sent[0]!.body, { from: "team@example.test", to: ["guest@example.test"], subject: "Example notice", text: `Example notice (${timeZone})` });
  assert.equal(JSON.stringify(delivered.body).includes("re_synthetic_key"), false);

  // A provider rejection reaches the plugin as a status it can act on; a malformed message never reaches Resend.
  reply = () => new Response(JSON.stringify({ message: "Invalid `to` field" }), { status: 422, headers: { "content-type": "application/json" } });
  assert.deepEqual(await call("/admin/example/notify", { body: { to: "guest@example.test", key: "2" }, dashboard: true }), { status: 502, body: { ready: true, timeZone, providerStatus: 422 } });
  assert.equal((await call("/admin/example/notify", { body: { to: "not an address", key: "3" }, dashboard: true })).status, 400);
  assert.equal(sent.length, 2);
});

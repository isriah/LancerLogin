// quick-check: covers tests/fixtures/module-plugins/**
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
import { passwordCredential } from "./fixtures/passwords.ts";

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
const { externalModuleMigrations } = await import("../apps/api/src/generated/external-module-data.ts");
const { expectedModuleLedger } = await import("./fixtures/d1-database.ts");

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
  // Official Outreach, when composed, records its adopted baseline and its own migrations beside Example's.
  const outreachLedger = expectedModuleLedger(externalModuleMigrations.find((pkg) => pkg.moduleId === "hour-tracking")).map((row) => ({ module_id: "hour-tracking", ...row }));
  assert.equal(outreachLedger.length > 0, !officialUnavailable);
  assert.deepEqual(db.rows("SELECT module_id, sequence, name FROM platform_module_migrations ORDER BY module_id, sequence"), [{ module_id: "example", sequence: 1, name: "0001_create_example_tables.sql" }, ...outreachLedger]);
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

  // The scheduler runs the plugin's job inside its module-scoped database, where it reads today's Attendance day
  // projections (the installation keeps UTC): one required meeting with a check-in, one optional and one test meeting.
  const today = new Date().toISOString().slice(0, 10);
  db.raw.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,is_test,created_by,created_at) VALUES
    ('day-required','primary','Test required meeting','${today}T00:00:01.000Z','${today}T23:59:00.000Z',1,0,'admin','2026-01-01'),
    ('day-optional','primary','Test optional meeting','${today}T00:00:02.000Z','${today}T23:59:00.000Z',0,0,'admin','2026-01-01'),
    ('day-test','primary','Test setup meeting','${today}T00:00:03.000Z','${today}T23:59:00.000Z',1,1,'admin','2026-01-01');
    INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) VALUES ('day-event','primary','member','day-required','kiosk','${today}T00:00:05.000Z','check_in')`);
  await worker.scheduled({ cron: "*/5 * * * *" } as never, env as never);
  assert.deepEqual(db.rows("SELECT id, digest_count FROM example_items ORDER BY id"), [{ id: "first", digest_count: 1 }, { id: "second", digest_count: 1 }]);
  assert.deepEqual(db.rows("SELECT item_id, note FROM example_requests WHERE id='attendance-day'"), [{ item_id: "first", note: `${today}: 1 meetings, 1 present, 1 expected, 1 on the roster` }]);

  // Backups carry the plugin's portable rows in its own section with its pinned source.
  const backup = await call("/admin/data/backup?scope=installation");
  const section = backup.body.externalModules.find((entry: any) => entry.id === "example");
  assert.equal(section.source, pin.source); assert.equal(section.commit, pin.commit);
  assert.deepEqual(section.tables.example_items.map((row: any) => row.id).sort(), ["first", "second"]);
  assert.equal("example_requests" in section.tables, false);

  // Disabling retains the data; after the deadline, cleanup deletes only the plugin's rows, with the Notion database an
  // Admin chose for it. Another module's choice stays.
  db.raw.exec(`INSERT INTO notion_bindings(installation_id,module_id,binding_id,database_id,data_source_id,name,updated_at) VALUES
    ('primary','example','items','dddddddd-dddd-dddd-dddd-dddddddddd01','55555555-5555-5555-5555-555555555501','Test Items','2026-11-26T00:00:00.000Z'),
    ('primary','attendance','other','dddddddd-dddd-dddd-dddd-dddddddddd02','55555555-5555-5555-5555-555555555502','Test Other','2026-11-26T00:00:00.000Z')`);
  db.raw.exec("INSERT INTO notion_comment_names(installation_id,module_id,name,updated_at) VALUES ('primary','example','Test Team 0000','2026-11-26T00:00:00.000Z'),('primary','attendance','Test Other Name','2026-11-26T00:00:00.000Z')");
  modules = await call("/platform/modules");
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance"], revision: modules.body.revision, confirmDisable: [{ moduleId: "example", generation }] } });
  assert.equal(modules.body.modules.find((module: any) => module.id === "example")?.phase, "retained");
  assert.equal((await call("/admin/example/items")).status, 403);
  db.raw.exec("UPDATE platform_modules SET disabled_at='2026-01-01T00:00:00.000Z',delete_after='2026-01-08T00:00:00.000Z' WHERE module_id='example'");
  for (let pass = 0; pass < 10 && db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='example' AND phase='deleted'") === 0; pass += 1) await runModuleCleanup(db as never);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM example_items") + db.count("SELECT COUNT(*) AS n FROM example_requests"), 0);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_modules WHERE module_id='example' AND phase='deleted'"), 1);
  assert.deepEqual(db.rows("SELECT module_id, binding_id FROM notion_bindings"), [{ module_id: "attendance", binding_id: "other" }], "deleting a module's data removes its Notion database choices only");
  assert.deepEqual(db.rows("SELECT module_id FROM notion_comment_names"), [{ module_id: "attendance" }], "and its comment name only");
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

  const created = await fetch("/setup/bootstrap", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ setupCode, organizationName: "Synthetic", timeZone: "UTC", authMode: "local", localUsername: "admin", localPasswordKey: await passwordCredential("synthetic password 1234") }) });
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

test("a composed plugin looks up FIRST teams through Core, counted per visitor only on public requests", async (t) => {
  const { db, call } = installation();
  const { encryptIntegration } = await import("../apps/api/src/integration-crypto.ts");
  let modules = await call("/platform/modules");
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance", "example"], revision: modules.body.revision } });
  db.raw.exec("INSERT INTO example_items(installation_id,id,title,created_at) VALUES ('primary','first','First item','2026-10-26T00:00:00.000Z')");
  const generation = modules.body.modules.find((module: any) => module.id === "example").generation;
  assert.equal((await call("/admin/modules/example/setup", { method: "PUT", body: { generation, stepId: "catalog", outcome: "completed" } })).status, 200);
  const encrypted = await encryptIntegration({ token: "synthetic-frc-token" }, sessionSecret);
  db.raw.prepare("INSERT INTO first_credentials(installation_id,program,username,ciphertext,iv,checked_at,updated_at) VALUES ('primary','FRC','test-frc-user',?,?,'2026-10-31T00:00:00.000Z','2026-10-31T00:00:00.000Z')").run(encrypted.ciphertext, encrypted.iv);
  const realFetch = globalThis.fetch; const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input); asked.push(url);
    if (!url.startsWith("https://frc-api.firstinspires.org/v3.0/")) throw new Error(`Unexpected provider request ${url}`);
    return url.includes("/teams?") ? Response.json({ teams: [{ teamNumber: Number(new URL(url).searchParams.get("teamNumber")), nameShort: "Test Robotics A", city: "Testville", stateProv: "PA", country: "USA" }] }) : Response.json({ currentSeason: 2026 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const visitorRows = () => db.count("SELECT COUNT(*) AS n FROM first_requests WHERE bucket LIKE 'visitor:%'");

  const guest = await call("/public/example/first", { body: { number: "321" }, signedIn: false });
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  assert.deepEqual(guest.body.lookup, { status: "found", team: { program: "FRC", number: "321", name: "Test Robotics A", location: "Testville, PA", season: 2026, source: "events-api" } });
  assert.equal(guest.body.importStatus, 403, "only Guest Visits may import a legacy credential");
  assert.equal(visitorRows(), 1, "a public request counts toward the visitor's limit");
  assert.equal(JSON.stringify(guest.body).includes("synthetic-frc-token"), false);
  const staff = await call("/public/example/first", { body: { number: "322" } });
  assert.equal(staff.body.lookup.status, "found");
  assert.equal(visitorRows(), 1, "a signed-in request on the same route counts only toward the installation limit");
  await call("/public/example/first", { body: { number: "321" }, signedIn: false });
  assert.equal(visitorRows(), 1, "a cache hit counts toward nothing");
  assert.ok(asked.every((url) => url.startsWith("https://frc-api.firstinspires.org/")));
});

test("a composed plugin uses Notion through Core: an Admin chooses its database and Core keeps it to that database", async (t) => {
  const { db, env, call } = installation();
  let modules = await call("/platform/modules");
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance", "example"], revision: modules.body.revision } });
  db.raw.exec("INSERT INTO example_items(installation_id,id,title,created_at) VALUES ('primary','first','First item','2026-10-26T00:00:00.000Z')");
  const generation = modules.body.modules.find((module: any) => module.id === "example").generation;
  assert.equal((await call("/admin/modules/example/setup", { method: "PUT", body: { generation, stepId: "catalog", outcome: "completed" } })).status, 200);

  // A synthetic Notion: one database the connection was added to, with one data source, and a page of another database.
  const token = "ntn_synthetic_token_0001";
  const database = "dddddddd-dddd-dddd-dddd-dddddddddd01", source = "55555555-5555-5555-5555-555555555501", otherSource = "55555555-5555-5555-5555-555555555502";
  const listedPage = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01", createdPage = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02", otherPage = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa09";
  const pageIn = (id: string, dataSourceId: string) => ({ object: "page", id, url: `https://www.notion.so/${id.replaceAll("-", "")}`, parent: { type: "data_source_id", data_source_id: dataSourceId }, properties: {} });
  const realFetch = globalThis.fetch; const sent: { method: string; path: string; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== "https://api.notion.com") throw new Error(`Unexpected provider request ${url}`);
    const method = init.method ?? "GET", path = url.pathname.slice(3) + url.search;
    sent.push({ method, path, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (new Headers(init.headers).get("authorization") !== `Bearer ${token}`) return new Response("", { status: 401 });
    if (path === "/users/me") return Response.json({ object: "user", name: "Test Bot", bot: { workspace_name: "Test Workspace" } });
    if (path.startsWith("/users?")) return Response.json({ results: [{ id: "cccccccc-cccc-cccc-cccc-cccccccccc01", type: "person", name: "Test Student A", person: { email: "test.student.a@example.test" } }] });
    if (path === `/databases/${database}`) return Response.json({ object: "database", id: database, data_sources: [{ id: source, name: "Test Items" }] });
    if (path === `/data_sources/${source}`) return Response.json({ object: "data_source", id: source, properties: {} });
    if (path === `/data_sources/${source}/query`) return Response.json({ results: [pageIn(listedPage, source)], has_more: false });
    if (method === "POST" && path === "/pages") return Response.json(pageIn(createdPage, source));
    if (method === "PATCH" && path === `/pages/${createdPage}`) return Response.json(pageIn(createdPage, source));
    if (method === "POST" && path === "/comments") return Response.json({ object: "comment", id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01" });
    if (method === "GET" && path === `/pages/${otherPage}`) return Response.json(pageIn(otherPage, otherSource));
    return new Response("", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  t.mock.method(console, "log", () => {});
  const seen: unknown[] = [];
  const admin = async (path: string, init: Parameters<typeof call>[1] = {}) => { const result = await call(path, init); seen.push(result.body); return result; };
  const bindingPath = "/admin/integrations/notion/bindings/example/items";

  // Settings > Integrations > Notion is Admin only, and changes need the dashboard origin.
  for (const [path, method, body] of [["/admin/integrations/notion", "GET"], ["/admin/integrations/notion", "PUT", { token }], ["/admin/integrations/notion", "DELETE"], [bindingPath, "PUT", { database }], [bindingPath, "DELETE"]] as const) {
    assert.equal((await call(path, { method, body, signedIn: false, dashboard: true })).status, 401, `${method} ${path} needs a session`);
    if (method !== "GET") assert.equal((await call(path, { method, body })).status, 403, `${method} ${path} needs the dashboard origin`);
  }
  assert.equal(sent.length, 0);
  const empty = await admin("/admin/integrations/notion");
  assert.equal(empty.body.saved, false);
  assert.deepEqual(empty.body.bindings.filter((binding: any) => binding.moduleId === "example"), [{ moduleId: "example", moduleLabel: "Example", id: "items", label: "Example items database", reason: "Example items are copied to this Notion database", required: false, operations: ["query", "pages.create", "pages.update", "comments.create"], bound: false, databaseId: null, dataSourceId: null, name: "", link: null }]);
  const exampleBinding = (body: any) => body.bindings.find((binding: any) => binding.moduleId === "example" && binding.id === "items");

  // Before an Admin connects Notion, every call the plugin makes is refused without a request.
  let result = await admin("/admin/example/notion", { body: {} });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ready, false); assert.equal(result.body.status.saved, false);
  assert.deepEqual(result.body.status.bindings, [{ id: "items", required: false, bound: false }]);
  assert.deepEqual([result.body.rows.code, result.body.created.code, result.body.trashed.code, result.body.users.code], ["notion_unbound", "notion_unbound", "notion_not_declared", "notion_not_configured"]);
  assert.equal(result.body.imported.status, 403, "only Part Requests may import a legacy connection");
  assert.equal(sent.length, 0);

  // The Admin saves the token (checked with Notion) and chooses the plugin's database by its link.
  assert.equal((await admin("/admin/integrations/notion", { method: "PUT", body: { token: "ntn_wrong_token_0009", revision: 0 }, dashboard: true })).status, 400);
  assert.equal((await admin("/admin/integrations/notion", { method: "PUT", body: { token }, dashboard: true })).status, 400, "a change names the revision the page loaded");
  const saved = await admin("/admin/integrations/notion", { method: "PUT", body: { token, revision: 0 }, dashboard: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual({ saved: saved.body.saved, enabled: saved.body.enabled, readable: saved.body.readable, botName: saved.body.botName, workspaceName: saved.body.workspaceName, users: saved.body.capabilities.users, email: saved.body.capabilities.email }, { saved: true, enabled: true, readable: true, botName: "Test Bot", workspaceName: "Test Workspace", users: "ok", email: "ok" });
  assert.equal((await admin("/admin/integrations/notion/bindings/example/missing", { method: "PUT", body: { database }, dashboard: true })).status, 404);
  assert.equal((await admin("/admin/integrations/notion/bindings/attendance/items", { method: "PUT", body: { database }, dashboard: true })).status, 404);
  const chosen = await admin(bindingPath, { method: "PUT", body: { database: `https://www.notion.so/test-workspace/Items-${database.replaceAll("-", "")}?v=1` }, dashboard: true });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.equal(chosen.body.bound, true);
  const bound = exampleBinding(chosen.body.integration);
  assert.deepEqual({ bound: bound.bound, databaseId: bound.databaseId, dataSourceId: bound.dataSourceId, name: bound.name }, { bound: true, databaseId: database, dataSourceId: source, name: "Test Items" });
  assert.deepEqual(db.rows("SELECT action, target_id FROM audit_log WHERE action LIKE 'integration.%' ORDER BY rowid"), [{ action: "integration.saved", target_id: "notion" }, { action: "integration.notion_binding_set", target_id: "notion:example:items" }]);

  // The plugin now works in its database: it lists a row, creates one and updates the row Core just returned with no
  // extra request. A page of another database costs one read and is refused; an undeclared operation is refused
  // before any request; users come back without email because the plugin did not declare it.
  sent.length = 0;
  result = await admin("/admin/example/notion", { body: { pageId: otherPage } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ready, true);
  assert.deepEqual(result.body.binding, { ok: { id: "items", databaseId: database, dataSourceId: source, name: "Test Items" } });
  assert.deepEqual(result.body.rows, { ok: [listedPage] });
  assert.deepEqual(result.body.created, { ok: createdPage }); assert.deepEqual(result.body.updatedOwn, { ok: createdPage });
  assert.deepEqual(result.body.updatedOther, { code: "notion_out_of_scope", status: 403, providerStatus: null, retryAfterMs: null, uncertain: false });
  assert.equal(result.body.trashed.code, "notion_not_declared");
  assert.deepEqual(result.body.users, { ok: [{ id: "cccccccc-cccc-cccc-cccc-cccccccccc01", type: "person", name: "Test Student A" }] });
  assert.deepEqual(sent.map((request) => `${request.method} ${request.path}`), [`POST /data_sources/${source}/query`, "POST /pages", `PATCH /pages/${createdPage}`, `GET /pages/${otherPage}`, "GET /users?page_size=100"]);
  assert.deepEqual(sent[1]!.body.parent, { type: "data_source_id", data_source_id: source });
  assert.deepEqual(db.rows("SELECT metadata_json FROM audit_log WHERE action='integration.notion_refused'").map((row: any) => JSON.parse(row.metadata_json)), [{ moduleId: "example", binding: "items", operation: "pages.update", reason: "page-outside-binding" }]);
  const status = await admin("/admin/integrations/notion");
  assert.deepEqual(status.body.capabilities, { read: "ok", insert: "ok", update: "ok", comment: "unknown", users: "ok", email: "ok" });
  assert.equal("commentName" in status.body, false, "the Notion card carries no comment name: it is each module's own setting");

  // The name on the plugin's comments is the plugin's own setting, kept by Core: Admin only, from the dashboard, audited.
  // A module that declared no comments has none. Until a name is set, comments carry the module's label.
  const namePath = "/admin/modules/example/notion-comment-name";
  const commentName = async () => { sent.length = 0; const reply = await admin("/admin/example/notion", { body: { comment: true } }); assert.equal(reply.body.commented.ok, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01", JSON.stringify(reply.body.commented)); return sent.find((request) => request.path === "/comments")!.body.display_name; };
  const asOperator = async (method: string, body?: unknown) => (await worker.fetch(new Request(`https://api.example.test${namePath}`, { method, headers: { cookie: "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "operator", role: "operator" }), origin, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never)).status;
  assert.deepEqual((await admin(namePath)).body, { moduleId: "example", label: "Example", name: "" });
  assert.deepEqual(await commentName(), { type: "custom", custom: { name: "Example" } });
  assert.equal((await call(namePath, { signedIn: false })).status, 401);
  assert.equal((await call(namePath, { method: "PUT", body: { name: "Test Team 0000" }, signedIn: false, dashboard: true })).status, 401);
  assert.equal(await asOperator("GET"), 403, "an Operator cannot read the name");
  assert.equal(await asOperator("PUT", { name: "Test Team 0000" }), 403, "an Operator cannot change the name");
  assert.equal((await call(namePath, { method: "PUT", body: { name: "Test Team 0000" } })).status, 403, "a change needs the dashboard origin");
  assert.equal((await call(namePath, { method: "PUT", body: { name: "N".repeat(101) }, dashboard: true })).status, 400);
  assert.equal((await call(namePath, { method: "PUT", body: { name: "Test Team 0000", token }, dashboard: true })).status, 400);
  for (const other of ["attendance", "missing"]) {
    assert.equal((await call(`/admin/modules/${other}/notion-comment-name`)).status, 404, `${other} does not comment in Notion`);
    assert.equal((await call(`/admin/modules/${other}/notion-comment-name`, { method: "PUT", body: { name: "Test Team 0000" }, dashboard: true })).status, 404);
  }
  assert.equal(db.count("SELECT COUNT(*) AS n FROM notion_comment_names"), 0, "a refused change stores nothing");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'integration.notion_comment_name%'"), 0, "and records nothing");
  const revisionBefore = db.rows("SELECT revision, key_version FROM notion_connection")[0];
  const named = await admin(namePath, { method: "PUT", body: { name: "  Test Team 0000 " }, dashboard: true });
  assert.equal(named.status, 200, JSON.stringify(named.body)); assert.deepEqual(named.body, { moduleId: "example", label: "Example", name: "Test Team 0000" });
  assert.deepEqual(db.rows("SELECT module_id, name FROM notion_comment_names"), [{ module_id: "example", name: "Test Team 0000" }]);
  assert.deepEqual(db.rows("SELECT revision, key_version FROM notion_connection")[0], revisionBefore, "the token is not touched");
  assert.deepEqual(await commentName(), { type: "custom", custom: { name: "Test Team 0000" } });
  assert.equal((await admin(namePath, { method: "PUT", body: { name: "Test Team 0000" }, dashboard: true })).status, 200, "saving the same name again is not an error");
  const blank = await admin(namePath, { method: "PUT", body: { name: "" }, dashboard: true });
  assert.deepEqual(blank.body, { moduleId: "example", label: "Example", name: "" }); assert.equal(db.count("SELECT COUNT(*) AS n FROM notion_comment_names"), 0);
  assert.deepEqual(await commentName(), { type: "custom", custom: { name: "Example" } });
  assert.deepEqual(db.rows("SELECT action, actor_user_id, target_type, target_id FROM audit_log WHERE action LIKE 'integration.notion_comment_name%' ORDER BY rowid"), [
    { action: "integration.notion_comment_name_set", actor_user_id: "admin", target_type: "integration", target_id: "notion:example" },
    { action: "integration.notion_comment_name_cleared", actor_user_id: "admin", target_type: "integration", target_id: "notion:example" },
  ], "each change is recorded once; saving an unchanged name is not");
  assert.equal((await admin(namePath, { method: "PUT", body: { name: "Test Team 0000" }, dashboard: true })).status, 200);

  // Turned off, the token is kept and every call is refused; the database choice can be cleared and the token removed.
  assert.equal((await admin("/admin/integrations/notion", { method: "PUT", body: { enabled: false, revision: 1 }, dashboard: true })).body.enabled, false);
  const stale = await admin("/admin/integrations/notion", { method: "PUT", body: { enabled: true, revision: 1 }, dashboard: true });
  assert.equal(stale.status, 409, "a page that loaded an older revision cannot undo the turn-off"); assert.equal(stale.body.code, "notion_connection_changed");
  sent.length = 0;
  result = await admin("/admin/example/notion", { body: {} });
  assert.equal(result.body.ready, false); assert.deepEqual([result.body.rows.code, result.body.users.code], ["notion_disabled", "notion_disabled"]); assert.equal(sent.length, 0);
  assert.equal((await admin("/admin/integrations/notion", { method: "PUT", body: { enabled: true, revision: 2 }, dashboard: true })).body.enabled, true);
  const removed = await admin("/admin/integrations/notion", { method: "DELETE", dashboard: true });
  assert.equal(removed.body.saved, false); assert.equal(exampleBinding(removed.body).bound, true, "removing the token keeps the chosen database");
  const cleared = await admin(bindingPath, { method: "DELETE", dashboard: true });
  assert.equal(exampleBinding(cleared.body.integration).bound, false);
  assert.deepEqual((await admin(namePath)).body, { moduleId: "example", label: "Example", name: "Test Team 0000" }, "removing the token and clearing the database keep the module's comment name, which its settings page still shows");
  assert.deepEqual(db.rows("SELECT action FROM audit_log WHERE action LIKE 'integration.%' AND action<>'integration.notion_refused' AND action NOT LIKE 'integration.notion_comment_name%' ORDER BY rowid").map((row: any) => row.action).slice(2), ["integration.notion_disabled", "integration.notion_enabled", "integration.removed", "integration.notion_binding_removed"]);
  // The token appears in no response and no stored row.
  assert.equal(JSON.stringify(seen).includes("ntn_"), false);
  assert.equal(JSON.stringify(db.rows("SELECT * FROM audit_log")).includes("ntn_"), false);
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

test("a composed plugin's Discord rate limit arrives as a neutral 429 with Discord's delay, never as role sync", async (t) => {
  const { db, call } = installation();
  const { encryptIntegration } = await import("../apps/api/src/integration-crypto.ts");
  let modules = await call("/platform/modules");
  modules = await call("/admin/modules", { method: "PUT", body: { enabled: ["attendance", "example"], revision: modules.body.revision } });
  db.raw.exec("INSERT INTO example_items(installation_id,id,title,created_at) VALUES ('primary','first','First item','2026-10-26T00:00:00.000Z')");
  const generation = modules.body.modules.find((module: any) => module.id === "example").generation;
  assert.equal((await call("/admin/modules/example/setup", { method: "PUT", body: { generation, stepId: "catalog", outcome: "completed" } })).status, 200);
  const encrypted = await encryptIntegration({ botToken: "synthetic-bot-token", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  db.raw.exec("UPDATE installations SET discord_enabled=1 WHERE id='primary'");
  db.raw.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES ('discord','primary','discord',?,?,'2026-01-01','2026-01-02')").run(encrypted.ciphertext, encrypted.iv);

  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://discord.com/api/")) throw new Error(`Unexpected provider request ${url}`);
    asked.push(url);
    return new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 9.2, global: false }), { status: 429, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const limited = await call("/admin/example/discord-events");
  assert.deepEqual(limited, { status: 502, body: { providerStatus: 429, retryAfterMs: 9_200, message: "Discord is rate limiting requests. Try again in a few seconds." } });
  assert.deepEqual(asked, ["https://discord.com/api/v10/guilds/123456789012345678/scheduled-events"], "a long delay is not waited out or retried in place");
  assert.equal(JSON.stringify(limited.body).includes("synthetic-bot-token"), false);
});

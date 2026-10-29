// The whole path for an installation that used Carpool while it was part of LancerLogin: an update without the plugin is
// refused before it claims the installation, the Admin keeps Carpool by adding its plugin through Settings, the next build
// composes LancerLogin with Carpool, and the existing data and settings carry over unchanged (adopted baseline, no SQL).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker, { type Env } from "../../apps/api/src/index.ts";
import { reconcileInstalledModules } from "../../apps/api/src/module-catalog.ts";
import { commitPluginChange, requiredModuleMigrations } from "../../apps/api/src/plugin-selection.ts";
import { createSessionCodec } from "../../apps/api/src/runtime-security.ts";
import { effectiveSelection, parseSelectionFile } from "../../scripts/compose-modules.mjs";
import { composeUpdateModules, preflightModuleGuard } from "../../scripts/run-web-upgrade.mjs";
import { PluginDatabase } from "../fixtures/plugin-database.ts";
import { sessionSecret } from "../fixtures/worker-fake-database.ts";

const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

test("an installation using first-party Carpool keeps it by adding the plugin, and its data survives the composed update", async (t) => {
  const db = new PluginDatabase(); t.after(() => db.raw.close()); db.recordCoreMigrations();
  const recorded = JSON.parse(await readFile(new URL("../fixtures/carpool-first-party-catalog.json", import.meta.url), "utf8")) as { json: string; sha: string };
  db.raw.exec(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','carpool',2);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','carpool',1,2,'enabled',1,1);
    INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ('primary','operator','carpool','["carpool.manage"]');
    INSERT INTO carpool_plans(installation_id,id,title,created_at,updated_at) VALUES('primary','kept-plan','Synthetic kept plan','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z');
    INSERT INTO carpool_people(installation_id,plan_id,id,display_name,outbound_status,return_status,created_at,updated_at) VALUES('primary','kept-plan','kept-person','Synthetic Person','arranged','arranged','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z');`);
  db.raw.prepare("INSERT INTO platform_module_catalog(installation_id,module_id,origin,source,source_commit,contract_version,definition_json,definition_sha256,installed,recorded_at) VALUES ('primary','carpool','first-party',NULL,NULL,1,?,?,1,'2026-03-01T00:00:00.000Z')").run(recorded.json, recorded.sha);
  const query = async (sql: string, params: readonly unknown[] = []) => db.raw.prepare(sql).all(...params as never[]) as Record<string, unknown>[];
  const official = parseSelectionFile(await readFile("scripts/official-modules.json", "utf8"), { allowFileSources: true, name: "official-modules.json", official: true });
  const composedFrom = async (selectionPath: string | undefined) => composeUpdateModules({ selectionPath, environment: {}, compose: async ({ selectionPath: path }: { selectionPath: string | null }) => ({
    modules: effectiveSelection({ selection: path ? parseSelectionFile(await readFile(path, "utf8")) : undefined, official }).map((entry: { id: string }) => entry.id),
  }) });

  // 1. The update's build without the plugin: the controller stops before claim with the sanitized code.
  const diagnostics: string[] = [];
  await assert.rejects(preflightModuleGuard({ query, composed: await composedFrom(undefined), record: async (code: string) => { diagnostics.push(code); } }), /module_migration_required/);
  assert.deepEqual(diagnostics, ["module_migration_required:carpool"]);

  // 2. The Worker offers the known plugin and the Admin adds it through the plugin change flow (synthetic GitHub).
  const files = new Map<string, string>();
  const env = { DB: db, SESSION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", RELEASE_VERSION: "2.0.0-beta.11", UPDATE_REPOSITORY: "example/private-install",
    MODULE_SELECTION_TOKEN: "synthetic-selection", MODULE_SELECTION_TOKEN_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString() } as unknown as Env;
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/example/private-install") return Response.json({ private: true });
    const file = /\/contents\/(.+)$/.exec(url.pathname);
    if (file && url.pathname.startsWith("/repos/example/private-install/")) {
      const name = decodeURIComponent(file[1]!);
      if (init?.method === "PUT") { const text = Buffer.from(JSON.parse(String(init.body)).content, "base64").toString("utf8"); files.set(name, text); return Response.json({ content: { sha: blob(text) }, commit: { sha: "f".repeat(40) } }, { status: 201 }); }
      const text = files.get(name);
      return text === undefined ? new Response(null, { status: 404 }) : Response.json({ type: "file", sha: blob(text), encoding: "base64", content: Buffer.from(text).toString("base64"), size: text.length });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const withoutPlugin = {}; // The installed build that dropped Carpool.
    const [required] = await requiredModuleMigrations(env as never, withoutPlugin);
    assert.equal(required?.id, "carpool"); assert.ok(required.plugin);
    const signedInAt = Date.now(); // One reading, so the session spans exactly the lifetime freshUntil requires.
    const admin = { userId: "admin", expiresAt: signedInAt + 8 * 3_600_000, authenticatedAt: signedInAt };
    await commitPluginChange(env as never, admin, { action: "add", id: "carpool", source: required.plugin!.source, commit: required.plugin!.commit, selectionSha: "0".repeat(40), trustConfirmed: true }, withoutPlugin);
    assert.deepEqual(await requiredModuleMigrations(env as never, withoutPlugin), []);
  } finally { globalThis.fetch = previous; }

  // 3. The next update composes LancerLogin with Carpool from the committed selection and passes the guard before claim.
  const controller = await mkdtemp(join(tmpdir(), "lancerlogin-carpool-path-")); t.after(() => rm(controller, { recursive: true, force: true }));
  const selectionPath = join(controller, "lancerlogin.modules.json"); await writeFile(selectionPath, files.get("lancerlogin.modules.json")!);
  const composed = await composedFrom(selectionPath);
  assert.ok(composed.includes("carpool"));
  await preflightModuleGuard({ query, composed, record: async () => assert.fail("no diagnostic once Carpool is composed") });

  // 4. With the plugin composed (this process), reconciliation adopts the existing schema without SQL and the data is intact.
  assert.deepEqual(await reconcileInstalledModules(db as never), { changed: true, failures: [] });
  assert.deepEqual(db.rows("SELECT sequence, name FROM platform_module_migrations WHERE module_id='carpool'"), [{ sequence: 0, name: "adopted-baseline" }]);
  assert.deepEqual(db.rows("SELECT phase, generation, setup_complete FROM platform_modules WHERE module_id='carpool'"), [{ phase: "enabled", generation: 2, setup_complete: 1 }]);
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "operator", role: "operator" });
  const context = await worker.fetch(new Request("https://api.example.test/admin/carpool/context", { headers: { cookie } }), env);
  assert.equal(context.status, 200);
  assert.deepEqual((await context.json() as { plans: Array<{ id: string }> }).plans.map((plan) => plan.id), ["kept-plan"]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM carpool_people WHERE id = 'kept-person'"), 1);
});

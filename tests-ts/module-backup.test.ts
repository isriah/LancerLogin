// Module backup adapter contract and the plugin-free backup envelope.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../apps/api/src/index.ts";
import { bundledModuleRegistry, createModuleRegistry, firstPartyModules, type ModuleDefinition } from "../packages/shared/src/module-platform.ts";
import { createApiModuleSet, externalModuleIds, type ApiModuleContribution, type ModuleBackupAdapter } from "../apps/api/src/module-contributions.ts";
import { installedApiModules } from "../apps/api/src/installed-api-modules.ts";
import { clearExternalModuleStatements, externalBackupModules, ModuleRestoreRefusal, parseExternalModuleSection, planExternalModuleRestore, prepareIncludedModule } from "../apps/api/src/module-backup.ts";
import { HttpError } from "../apps/api/src/http-error.ts";
import { extractedModuleOwnership, extractedModuleTables } from "../apps/api/src/extracted-modules.ts";
import { BackupDatabase, backupClient } from "./fixtures/backup-database.ts";
import { syntheticAddonModule, syntheticNotesModule } from "./fixtures/synthetic-plugin/external-manifests.ts";
import { syntheticAddonApiModule, syntheticNotesApiModule } from "./fixtures/synthetic-plugin/external-modules.ts";

const golden = JSON.parse(readFileSync(new URL("./fixtures/first-party-backup-envelope.json", import.meta.url), "utf8"));
// The envelope Core exported at schemas 41 and 42, while Carpool and Outreach were first-party.
const historicalGolden = JSON.parse(readFileSync(new URL("./fixtures/first-party-backup-envelope-schema-42.json", import.meta.url), "utf8"));
// The envelope Core exported at schema 43, while Outreach was first-party.
const schema43Golden = JSON.parse(readFileSync(new URL("./fixtures/first-party-backup-envelope-schema-43.json", import.meta.url), "utf8"));
const without = (envelope: any, moduleId: string, prefix: string) => ({ ...envelope, ownership: { ...envelope.ownership, modules: envelope.ownership.modules.filter((module: { id: string }) => module.id !== moduleId) }, tables: envelope.tables.filter((table: string) => !table.startsWith(prefix)) });
const pluginRegistry = createModuleRegistry([...firstPartyModules, syntheticNotesModule, syntheticAddonModule]);
const pluginIds: ReadonlySet<string> = new Set(["synthetic-notes", "synthetic-addon"]);
const attendanceRuntime = { jobs: Object.fromEntries(bundledModuleRegistry.get("attendance")!.jobs.map((job) => [job.id, async () => undefined])), reports: Object.fromEntries((bundledModuleRegistry.get("attendance")!.reportDatasets ?? []).map((dataset) => [dataset.id, async () => []])) };
const firstParty = installedApiModules.map((module) => module.moduleId === "attendance" ? { ...module, ...attendanceRuntime } : module) as ApiModuleContribution<unknown>[];
const notesAdapter = syntheticNotesApiModule.backup!;

function compose(notes: Partial<ApiModuleContribution<unknown>> = {}, manifest: Partial<ModuleDefinition> = {}) {
  const registry = createModuleRegistry([...firstPartyModules, { ...syntheticNotesModule, ...manifest }, syntheticAddonModule]);
  return createApiModuleSet(registry, [...firstParty, { ...syntheticNotesApiModule, ...notes }, syntheticAddonApiModule], { externalModuleIds: pluginIds });
}
const withAdapter = (changes: Partial<ModuleBackupAdapter>) => ({ backup: { ...notesAdapter, ...changes } });

test("plugin-free builds keep the first-party backup envelope and an empty plugin section", async (t) => {
  assert.equal(externalModuleIds.size, 0);
  assert.deepEqual(firstPartyModules.map((module) => module.id), ["attendance"]);
  assert.deepEqual(bundledModuleRegistry.modules.map((module) => module.id), ["attendance"]);
  const db = new BackupDatabase(); t.after(() => db.raw.close()); const client = backupClient(worker, db);
  for (const scope of ["meetings", "roster", "installation"] as const) {
    const backup = await client.backup(scope);
    assert.equal(backup.schemaVersion, 45);
    assert.deepEqual(backup.ownership, golden[scope].ownership, `${scope} ownership matches the schema 44 envelope`);
    assert.deepEqual(Object.keys(backup.tables), golden[scope].tables);
    // Schema 43 differs from the schema 41 and 42 envelope only by Carpool, and schema 44 from schema 43 only by Outreach:
    // each moved into a plugin with its own section.
    assert.deepEqual(without(historicalGolden[scope], "carpool", "carpool_"), schema43Golden[scope]);
    assert.deepEqual(without(schema43Golden[scope], "hour-tracking", "hours_"), golden[scope]);
    // Core still recognizes the historical metadata and Core-section tables of both modules exactly.
    assert.deepEqual(historicalGolden[scope].ownership.modules.slice(1), extractedModuleOwnership(scope, 42));
    assert.deepEqual(schema43Golden[scope].ownership.modules.slice(1), extractedModuleOwnership(scope, 43));
    assert.deepEqual(historicalGolden[scope].tables.filter((table: string) => table.startsWith("hours_") || table.startsWith("carpool_")), extractedModuleTables(scope, 42));
    assert.deepEqual(schema43Golden[scope].tables.filter((table: string) => table.startsWith("hours_")), extractedModuleTables(scope, 43));
    assert.deepEqual(backup.externalModules, scope === "installation" ? [] : undefined);
  }
  const restored = await client.restore(await client.backup("installation")); assert.equal(restored.status, 200, await restored.clone().text());
});

test("external module backup adapters must match their manifest exactly", () => {
  assert.deepEqual(compose().all.map((module) => module.moduleId), pluginRegistry.modules.map((module) => module.id));
  const rejects = (pattern: RegExp, notes: Partial<ApiModuleContribution<unknown>>, manifest: Partial<ModuleDefinition> = {}) => assert.throws(() => compose(notes, manifest), pattern);
  rejects(/requires a backup adapter/, { backup: undefined });
  rejects(/adapter version does not match/, withAdapter({ version: 3 }));
  rejects(/adapter tables do not match/, withAdapter({ tables: { synthetic_notes_entries: notesAdapter.tables.synthetic_notes_entries!, synthetic_notes_tags: notesAdapter.tables.synthetic_notes_tags! } }));
  rejects(/adapter tables do not match/, withAdapter({ tables: { ...notesAdapter.tables, synthetic_notes_tokens: ["installation_id", "token"] } }));
  rejects(/columns for synthetic_notes_entries are invalid/, withAdapter({ tables: { ...notesAdapter.tables, synthetic_notes_entries: ["id", "body"] } }));
  rejects(/columns for synthetic_notes_entries are invalid/, withAdapter({ tables: { ...notesAdapter.tables, synthetic_notes_entries: ["installation_id", "id", "id"] } }));
  rejects(/columns for synthetic_notes_entries are invalid/, withAdapter({ tables: { ...notesAdapter.tables, synthetic_notes_entries: ["installation_id", "body; DROP TABLE members"] } }));
  rejects(/must neutralize transient authority/, withAdapter({ neutralize: undefined }));
  rejects(/transient authority must be exported/, withAdapter({ tables: { ...notesAdapter.tables, synthetic_notes_jobs: ["installation_id", "id", "status"] } }));
  rejects(/hooks are invalid/, withAdapter({ validate: "yes" as never }));
  rejects(/cannot own fields on Core rows/, {}, { persistence: { ...syntheticNotesModule.persistence, sharedFields: [{ table: "members", columns: ["synthetic_flag"] }] } });
  const withoutPortableTables: Partial<ModuleDefinition> = { persistence: { tables: ["synthetic_notes_tokens"], sharedFields: [], transientAuthority: [] }, backup: { version: 1, tables: [], nonPortableTables: ["synthetic_notes_tokens"] }, lifecycle: { cleanupTargets: ["synthetic_notes_tokens"] } };
  assert.doesNotThrow(() => compose({ backup: undefined }, withoutPortableTables), "an external module without portable tables needs no adapter");
});

test("first-party modules keep backup handling in Core and do not accept adapters", () => {
  assert.throws(() => createApiModuleSet(bundledModuleRegistry, firstParty.map((module) => module.moduleId === "attendance" ? { ...module, backup: { version: 1, tables: {} } } : module)), /First-party module attendance keeps backup handling in Core/);
  assert.doesNotThrow(() => createApiModuleSet(bundledModuleRegistry, firstParty));
});

test("restore planning names unavailable modules and requires an exact opt-out", () => {
  const installed = externalBackupModules(pluginRegistry, compose(), pluginIds);
  const entry = (id: string, contractVersion: number, backupVersion: number) => ({ id, label: id, contractVersion, backupVersion, source: null, commit: null, tables: { [id.replaceAll("-", "_")]: [{ installation_id: "primary" }] } });
  const entries = parseExternalModuleSection([entry("synthetic-addon", 1, 2), entry("synthetic-gone", 1, 1)], "installation");
  const refused = planExternalModuleRestore(entries, installed, undefined);
  assert.deepEqual(refused.unavailable.map((module) => [module.id, module.status]), [["synthetic-addon", "newer"], ["synthetic-gone", "missing"]]);
  assert.equal(refused.confirmed, false);
  assert.equal(planExternalModuleRestore(entries, installed, ["synthetic-gone", "synthetic-addon"]).confirmed, true);
  assert.equal(planExternalModuleRestore(entries, installed, ["synthetic-gone"]).confirmed, false);
  const incompatible = planExternalModuleRestore(parseExternalModuleSection([{ ...entry("synthetic-addon", 1, 1), contractVersion: 1 }], "installation"), externalBackupModules(createModuleRegistry([...firstPartyModules, syntheticNotesModule, { ...syntheticAddonModule, contractVersion: 2 }]), compose(), pluginIds), undefined);
  assert.deepEqual(incompatible.unavailable.map((module) => module.status), ["incompatible"]);
  assert.throws(() => planExternalModuleRestore(parseExternalModuleSection([entry("synthetic-notes", 1, 3), entry("synthetic-addon", 1, 1)], "installation"), installed, ["synthetic-notes"]), (error) => error instanceof ModuleRestoreRefusal && error.status === 409 && error.body.reason === "excluded-module-dependency");
  assert.throws(() => parseExternalModuleSection([], "meetings"), HttpError);
  assert.deepEqual(parseExternalModuleSection(undefined, "roster"), []);
});

test("adapter hooks fail closed and clearing runs child-first", () => {
  const [notes] = externalBackupModules(pluginRegistry, compose(), pluginIds);
  const context = { installationId: "primary", exportedAt: "2026-01-01T00:00:00.000Z", restoredAt: "2026-01-02T00:00:00.000Z" };
  const entry = { id: "synthetic-notes", label: "Synthetic Notes", contractVersion: 1, backupVersion: 1, source: null, commit: null, tables: { synthetic_notes_entries: [{ installation_id: "primary", id: "n", member_id: null, body: "Body" }], synthetic_notes_tags: [] }, rows: 1 };
  assert.deepEqual(prepareIncludedModule({ module: notes!, entry }, context).tables, { synthetic_notes_entries: [{ installation_id: "primary", id: "n", member_id: null, body: "Body", pinned: 0 }], synthetic_notes_tags: [], synthetic_notes_jobs: [] });
  const failure = (adapter: Partial<ModuleBackupAdapter>, pattern: RegExp) => assert.throws(() => prepareIncludedModule({ module: { ...notes!, adapter: { ...notesAdapter, ...adapter } }, entry }, context), (error) => error instanceof HttpError && error.status === 400 && pattern.test(error.message));
  failure({ normalize: undefined }, /cannot upgrade/);
  failure({ validate: () => { throw new Error("internal detail"); } }, /^Backup data for Synthetic Notes is invalid$/);
  failure({ neutralize: (tables) => ({ ...tables, synthetic_notes_jobs: [{ installation_id: "primary", id: "j", status: "x", lease_token: null, extra: 1 }] }) }, /does not match its declared tables/);
  const statements: string[] = [];
  const db = { prepare: (sql: string) => { statements.push(sql); return {} as never; }, batch: async () => [] };
  clearExternalModuleStatements(db, [notes!]);
  assert.deepEqual(statements.map((sql) => sql.match(/DELETE FROM (\w+)/)?.[1]), ["synthetic_notes_tokens", "synthetic_notes_jobs", "synthetic_notes_tags", "synthetic_notes_entries"]);
});

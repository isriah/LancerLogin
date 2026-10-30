// Entire-installation backup and restore with two composed synthetic plugins on a real migrated SQLite database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";

await import("./fixtures/synthetic-plugin/compose.ts");
const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, backupClient } = await import("./fixtures/backup-database.ts");
const { syntheticPluginSchema } = await import("./fixtures/synthetic-plugin/external-manifests.ts");
const golden = JSON.parse(readFileSync(new URL("./fixtures/first-party-backup-envelope.json", import.meta.url), "utf8"));

type Backup = Record<string, any>;
const moduleKeyedTables = ["platform_module_epochs", "platform_modules", "platform_module_assignments", "platform_module_setup_progress"];
const retiredSource = "https://example.test/synthetic-retired.git";
const retiredCommit = "a".repeat(40);

function pluginDatabase() {
  const db = new BackupDatabase();
  db.raw.exec(syntheticPluginSchema);
  db.raw.exec(`INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','synthetic-notes',3),('primary','synthetic-addon',1);
    INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','synthetic-notes',1,3,'enabled',1,1),('primary','synthetic-addon',1,1,'disabled',1,0);
    INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) VALUES ('primary','synthetic-notes','workspace',1,'completed','2026-01-02T00:00:00.000Z','admin');
    INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ('primary','operator','synthetic-notes','["synthetic-notes.manage"]');
    INSERT INTO synthetic_notes_entries VALUES ('primary','note-1','member','First synthetic note',1),('primary','note-2',NULL,'Second synthetic note',0);
    INSERT INTO synthetic_notes_tags VALUES ('primary','note-1','alpha'),('primary','note-2','beta');
    INSERT INTO synthetic_notes_jobs VALUES ('primary','job-a-pending','pending','synthetic-lease'),('primary','job-b-done','completed',NULL);
    INSERT INTO synthetic_notes_tokens VALUES ('primary','synthetic-plugin-secret');
    INSERT INTO synthetic_addon_items VALUES ('primary','item-1','Synthetic item');
    INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES ('pair-a','primary','hash-a','2099-01-01','admin','2026-01-01');
    INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at) VALUES ('kiosk-a','primary','pair-a','Kiosk A','token-a','2026-01-01');`);
  return { db, client: backupClient(worker, db) };
}

function withRetiredPlugin(backup: Backup) {
  const copy = structuredClone(backup);
  copy.externalModules.push({ id: "synthetic-retired", label: "Retired Synthetic Plugin", contractVersion: 1, backupVersion: 3, source: retiredSource, commit: retiredCommit, tables: { synthetic_retired_rows: [{ installation_id: "primary", id: "retired-1" }, { installation_id: "primary", id: "retired-2" }] } });
  copy.tables.platform_module_epochs.push({ installation_id: "primary", module_id: "synthetic-retired", generation: 2 });
  copy.tables.platform_modules.push({ installation_id: "primary", module_id: "synthetic-retired", contract_version: 1, generation: 2, phase: "enabled", setup_version: 1, setup_complete: 1, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null });
  copy.tables.platform_module_setup_progress.push({ installation_id: "primary", module_id: "synthetic-retired", step_id: "workspace", setup_version: 1, outcome: "completed", completed_at: "2026-01-03T00:00:00.000Z", completed_by: "admin" });
  copy.tables.platform_module_assignments.push({ installation_id: "primary", user_id: "operator", module_id: "synthetic-retired", capabilities_json: '["synthetic-retired.manage"]' });
  return copy;
}

const section = (backup: Backup, id: string) => backup.externalModules.find((entry: Record<string, unknown>) => entry.id === id);
const lastRestoreAudit = (db: InstanceType<typeof BackupDatabase>) => JSON.parse(String(db.rows<{ metadata_json: string }>("SELECT metadata_json FROM audit_log WHERE action='data.backup_restored' ORDER BY rowid DESC LIMIT 1")[0]!.metadata_json));
const moduleRows = (db: InstanceType<typeof BackupDatabase>, moduleId: string) => moduleKeyedTables.reduce((total, table) => total + db.count(`SELECT COUNT(*) AS n FROM ${table} WHERE module_id=?`, moduleId), 0);

test("composed plugins export a separate section beside an unchanged first-party envelope", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  for (const scope of ["meetings", "roster", "installation"] as const) {
    const backup = await client.backup(scope);
    assert.equal(backup.schemaVersion, 45);
    assert.deepEqual(backup.ownership, golden[scope].ownership, `${scope} ownership is unchanged by installed plugins`);
    assert.deepEqual(Object.keys(backup.tables), golden[scope].tables, `${scope} Core tables are unchanged by installed plugins`);
    assert.equal("externalModules" in backup, scope === "installation");
  }
  const backup = await client.backup("installation");
  assert.deepEqual(backup.externalModules, [
    { id: "synthetic-notes", label: "Synthetic Notes", contractVersion: 1, backupVersion: 2, source: null, commit: null, tables: {
      synthetic_notes_entries: [{ installation_id: "primary", id: "note-1", member_id: "member", body: "First synthetic note", pinned: 1 }, { installation_id: "primary", id: "note-2", member_id: null, body: "Second synthetic note", pinned: 0 }],
      synthetic_notes_tags: [{ installation_id: "primary", note_id: "note-1", tag: "alpha" }, { installation_id: "primary", note_id: "note-2", tag: "beta" }],
      synthetic_notes_jobs: [{ installation_id: "primary", id: "job-a-pending", status: "pending", lease_token: "synthetic-lease" }, { installation_id: "primary", id: "job-b-done", status: "completed", lease_token: null }],
    } },
    { id: "synthetic-addon", label: "Synthetic Add-on", contractVersion: 1, backupVersion: 1, source: null, commit: null, tables: { synthetic_addon_items: [{ installation_id: "primary", id: "item-1", label: "Synthetic item" }] } },
  ]);
  assert.doesNotMatch(JSON.stringify(backup), /synthetic-plugin-secret/, "non-portable plugin tables stay out of the file");
  assert.ok(backup.tables.platform_modules.some((row: Record<string, unknown>) => row.module_id === "synthetic-notes"));
});

test("installation restore round-trips plugin rows, neutralizes authority, clears plugin tables and still revokes kiosks", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  const backup = await client.backup("installation");
  db.raw.exec("INSERT INTO synthetic_notes_entries VALUES ('primary','note-later',NULL,'Created after the backup',0); INSERT INTO synthetic_notes_tokens VALUES ('primary','another-secret'); DELETE FROM synthetic_addon_items;");
  const restored = await client.restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  const body = await restored.json() as Record<string, unknown>;
  assert.deepEqual(body.recovery, { revokedKiosks: 1, invalidatedPairingCodes: 1, pausedProviderOperations: 0 });
  assert.equal("excludedModules" in body, false);
  assert.deepEqual(db.rows("SELECT id, member_id, body, pinned FROM synthetic_notes_entries ORDER BY id"), [{ id: "note-1", member_id: "member", body: "First synthetic note", pinned: 1 }, { id: "note-2", member_id: null, body: "Second synthetic note", pinned: 0 }]);
  assert.deepEqual(db.rows("SELECT note_id, tag FROM synthetic_notes_tags ORDER BY note_id"), [{ note_id: "note-1", tag: "alpha" }, { note_id: "note-2", tag: "beta" }]);
  assert.deepEqual(db.rows("SELECT id, status, lease_token FROM synthetic_notes_jobs ORDER BY id"), [{ id: "job-a-pending", status: "cancelled", lease_token: null }, { id: "job-b-done", status: "completed", lease_token: null }], "pending plugin work and leases do not revive");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM synthetic_notes_tokens"), 0, "non-portable plugin credentials are cleared");
  assert.deepEqual(db.rows("SELECT id, label FROM synthetic_addon_items"), [{ id: "item-1", label: "Synthetic item" }]);
  assert.deepEqual(db.rows("SELECT phase, generation, setup_complete FROM platform_modules WHERE module_id='synthetic-notes'"), [{ phase: "enabled", generation: 4, setup_complete: 1 }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_assignments WHERE module_id='synthetic-notes'"), 1);
  const kiosk = db.rows<{ token_hash: string; active: number }>("SELECT token_hash, active FROM kiosks")[0]!;
  assert.equal(kiosk.active, 0); assert.match(kiosk.token_hash, /^restored-/);
  assert.deepEqual(db.rows("SELECT code_hash LIKE 'restored-%' AS replaced FROM pairing_codes"), [{ replaced: 1 }]);
  assert.equal("excludedModules" in lastRestoreAudit(db), false);
  const snapshot = await client.call("/platform/modules"); assert.equal(snapshot.status, 200, await snapshot.clone().text());
  assert.deepEqual((await snapshot.json() as { modules: { id: string }[] }).modules.map((module) => module.id), ["attendance", "synthetic-notes", "synthetic-addon"]);
});

test("restore refuses a missing plugin before writes and accepts only an exact audited opt-out", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  const backup = withRetiredPlugin(await client.backup("installation"));
  db.raw.exec("INSERT INTO synthetic_notes_entries VALUES ('primary','note-later',NULL,'Created after the backup',0)");
  const refused = await client.restore(backup); assert.equal(refused.status, 409);
  const body = await refused.json() as Record<string, any>;
  assert.equal(body.code, "module-restore-refused"); assert.equal(body.reason, "unavailable-modules");
  assert.deepEqual(body.modules, [{ id: "synthetic-retired", label: "Retired Synthetic Plugin", status: "missing", requiredBackupVersion: 3, installedBackupVersion: null, requiredContractVersion: 1, installedContractVersion: null, source: retiredSource, commit: retiredCommit, rows: 2 }]);
  assert.deepEqual(body.optOut, { available: true, excludeModules: ["synthetic-retired"] });
  assert.deepEqual(body.dependencies, []);
  assert.match(body.details.join(" "), /Retired Synthetic Plugin \(synthetic-retired\) is not installed.*synthetic-retired\.git.*2 records/);
  for (const excludeModules of [[], ["synthetic-notes"], ["synthetic-retired", "synthetic-notes"]]) assert.equal((await client.restore(backup, { excludeModules })).status, 409);
  for (const excludeModules of ["synthetic-retired", [7], ["synthetic-retired", "synthetic-retired"], ["Synthetic Retired"]]) assert.equal((await client.restore(backup, { excludeModules })).status, 400);
  assert.equal(db.batches, 0); assert.equal(db.count("SELECT COUNT(*) AS n FROM synthetic_notes_entries WHERE id='note-later'"), 1);

  const catalog = () => db.rows("SELECT module_id, origin, source, source_commit, definition_sha256, installed FROM platform_module_catalog ORDER BY module_id");
  const recorded = catalog(); assert.ok(recorded.some((row: any) => row.module_id === "synthetic-notes" && row.origin === "external"));
  const accepted = await client.restore(backup, { excludeModules: ["synthetic-retired"] }); assert.equal(accepted.status, 200, await accepted.clone().text());
  // Recreating the installation row cascades the catalog away; the restore records it again before it responds.
  assert.deepEqual(catalog(), recorded);
  const excluded = [{ id: "synthetic-retired", label: "Retired Synthetic Plugin", status: "missing", backupVersion: 3, source: retiredSource, commit: retiredCommit, rows: 2 }];
  assert.deepEqual((await accepted.json() as Record<string, unknown>).excludedModules, excluded);
  assert.deepEqual(lastRestoreAudit(db).excludedModules, excluded);
  assert.equal(moduleRows(db, "synthetic-retired"), 0, "excluded modules restore with no lifecycle, epoch, assignment or setup rows");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM synthetic_notes_entries"), 2);
  const snapshot = await client.call("/platform/modules"); assert.equal(snapshot.status, 200, await snapshot.clone().text());
});

test("restore refuses newer plugins and refuses an opt-out that would break an included dependency", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  const current = await client.backup("installation");
  const newerNotes = structuredClone(current); section(newerNotes, "synthetic-notes").backupVersion = 3;
  for (const extra of [{}, { excludeModules: ["synthetic-notes"] }]) {
    const refused = await client.restore(newerNotes, extra); assert.equal(refused.status, 409);
    const body = await refused.json() as Record<string, any>;
    assert.equal(body.reason, "excluded-module-dependency");
    assert.deepEqual(body.optOut, { available: false, excludeModules: ["synthetic-notes"] });
    assert.deepEqual(body.dependencies, [{ moduleId: "synthetic-addon", label: "Synthetic Add-on", dependsOn: "synthetic-notes" }]);
    assert.equal(body.modules[0].status, "newer"); assert.equal(body.modules[0].installedBackupVersion, 2); assert.equal(body.modules[0].rows, 6);
    assert.match(body.details.join(" "), /Synthetic Add-on \(synthetic-addon\) depends on Synthetic Notes/);
  }
  const newerContract = structuredClone(current); section(newerContract, "synthetic-addon").contractVersion = 2;
  assert.equal((await client.restore(newerContract)).status, 409);
  assert.equal(db.batches, 0);

  const newerAddon = structuredClone(current); section(newerAddon, "synthetic-addon").backupVersion = 2;
  const refused = await client.restore(newerAddon); assert.equal(refused.status, 409);
  assert.deepEqual((await refused.json() as Record<string, any>).modules.map((module: Record<string, unknown>) => [module.id, module.status, module.installedBackupVersion]), [["synthetic-addon", "newer", 1]]);
  const accepted = await client.restore(newerAddon, { excludeModules: ["synthetic-addon"] }); assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.deepEqual((await accepted.json() as Record<string, any>).excludedModules.map((module: Record<string, unknown>) => [module.id, module.rows]), [["synthetic-addon", 1]]);
  assert.deepEqual(db.rows("SELECT phase, generation, setup_complete FROM platform_modules WHERE module_id='synthetic-addon'"), [{ phase: "disabled", generation: 2, setup_complete: 0 }], "an installed excluded module starts fresh with a newer generation");
  assert.deepEqual(db.rows("SELECT id FROM synthetic_addon_items"), [], "its backup rows are discarded; it seeds on first enablement");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM synthetic_notes_entries"), 2);
});

test("the plugin section is validated strictly before any write", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  const current = await client.backup("installation");
  const notes = (backup: Backup) => section(backup, "synthetic-notes");
  const unavailable = (rows: unknown[]) => (backup: Backup) => { backup.externalModules.push({ id: "synthetic-retired", label: "Retired", contractVersion: 1, backupVersion: 1, source: null, commit: null, tables: { synthetic_retired_rows: rows } }); };
  const mutations: [string, (backup: Backup) => void][] = [
    ["unknown entry key", (backup) => { notes(backup).extra = true; }],
    ["missing entry key", (backup) => { delete notes(backup).source; }],
    ["nested value", (backup) => { notes(backup).tables.synthetic_notes_entries[0].body = { nested: true }; }],
    ["undeclared table", (backup) => { notes(backup).tables.synthetic_unknown = []; }],
    ["unsafe table name", (backup) => { notes(backup).tables["synthetic_notes_entries; DROP TABLE members"] = []; }],
    ["missing declared table", (backup) => { delete notes(backup).tables.synthetic_notes_jobs; }],
    ["undeclared column", (backup) => { notes(backup).tables.synthetic_notes_entries[0].extra = 1; }],
    ["missing column", (backup) => { delete notes(backup).tables.synthetic_notes_entries[0].pinned; }],
    ["foreign installation", (backup) => { notes(backup).tables.synthetic_notes_entries[0].installation_id = "other"; }],
    ["adapter validation", (backup) => { notes(backup).tables.synthetic_notes_tags[0].note_id = "missing-note"; }],
    ["first-party identity", (backup) => { backup.externalModules.push({ ...structuredClone(notes(backup)), id: "attendance" }); }],
    ["duplicate identity", (backup) => { backup.externalModules.push(structuredClone(notes(backup))); }],
    ["branch instead of commit", (backup) => { notes(backup).commit = "main"; }],
    ["missing section", (backup) => { delete backup.externalModules; }],
    ["section object", (backup) => { backup.externalModules = {}; }],
    ["plugin rows in Core tables", (backup) => { backup.tables.synthetic_notes_entries = []; }],
    ["undeclared module state", (backup) => { backup.tables.platform_module_epochs.push({ installation_id: "primary", module_id: "synthetic-ghost", generation: 1 }); backup.tables.platform_modules.push({ installation_id: "primary", module_id: "synthetic-ghost", contract_version: 1, generation: 1, phase: "disabled", setup_version: 1, setup_complete: 0, disabled_at: null, delete_after: null, deletion_cursor: 0, cleanup_failure: null }); }],
    ["installed module state missing", (backup) => { for (const table of moduleKeyedTables) backup.tables[table] = backup.tables[table].filter((row: Record<string, unknown>) => row.module_id !== "synthetic-addon"); }],
    ["invalid unavailable row", unavailable([{ nested: {} }])],
    ["row limit includes plugin rows", unavailable(Array.from({ length: 150_001 }, () => ({})))],
  ];
  for (const [name, mutate] of mutations) {
    const backup = structuredClone(current); mutate(backup);
    const result = await client.restore(backup, name.includes("unavailable") || name.includes("row limit") ? { excludeModules: ["synthetic-retired"] } : {});
    assert.equal(result.status, 400, `${name}: ${await result.clone().text()}`);
  }
  const meetings = await client.backup("meetings");
  assert.equal((await client.call("/admin/data/restore", { scope: "meetings", confirmation: "RESTORE MEETINGS", backup: { ...meetings, externalModules: [] } })).status, 400);
  assert.equal((await client.call("/admin/data/restore", { scope: "roster", confirmation: "RESTORE ROSTER", backup: await client.backup("roster"), excludeModules: ["synthetic-notes"] })).status, 400);
  assert.equal((await client.restore(current, { excludeModules: ["synthetic-notes"] })).status, 400, "only unavailable modules can be excluded");
  assert.equal(db.batches, 0);
});

test("older plugin backup versions normalize through the installed adapter", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  const older = await client.backup("installation"); const notes = section(older, "synthetic-notes");
  notes.backupVersion = 1; delete notes.tables.synthetic_notes_jobs; for (const row of notes.tables.synthetic_notes_entries) delete row.pinned;
  const restored = await client.restore(older); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(db.rows("SELECT id, pinned FROM synthetic_notes_entries ORDER BY id"), [{ id: "note-1", pinned: 0 }, { id: "note-2", pinned: 0 }]);
  assert.equal(db.count("SELECT COUNT(*) AS n FROM synthetic_notes_jobs"), 0);
});

test("schema 41 backups restore as before and leave installed plugins fresh and empty", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  const current = await client.backup("installation");
  const legacy = structuredClone(current); legacy.schemaVersion = 41; delete legacy.externalModules; omitContestResubmissionFields(legacy);
  const pluginState = structuredClone(legacy);
  for (const table of moduleKeyedTables) legacy.tables[table] = legacy.tables[table].filter((row: Record<string, unknown>) => !String(row.module_id).startsWith("synthetic-"));
  assert.equal((await client.restore(pluginState)).status, 400, "schema 41 never declared plugin module state");
  assert.equal(db.batches, 0);
  const ignored = { ...structuredClone(legacy), externalModules: current.externalModules };
  for (const backup of [legacy, ignored]) {
    const restored = await client.restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal("excludedModules" in (await restored.json() as Record<string, unknown>), false);
    for (const table of ["synthetic_notes_entries", "synthetic_notes_tags", "synthetic_notes_jobs", "synthetic_notes_tokens"]) assert.equal(db.count(`SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} is cleared`);
    assert.deepEqual(db.rows("SELECT id FROM synthetic_addon_items"), []);
    assert.deepEqual(db.rows("SELECT module_id, phase, setup_complete FROM platform_modules WHERE module_id LIKE 'synthetic-%' ORDER BY module_id"), [{ module_id: "synthetic-addon", phase: "disabled", setup_complete: 0 }, { module_id: "synthetic-notes", phase: "disabled", setup_complete: 0 }]);
    assert.equal(db.count("SELECT COUNT(*) AS n FROM platform_module_assignments WHERE module_id LIKE 'synthetic-%'") + db.count("SELECT COUNT(*) AS n FROM platform_module_setup_progress WHERE module_id LIKE 'synthetic-%'"), 0);
    const kiosk = db.rows<{ active: number }>("SELECT active FROM kiosks")[0]!; assert.equal(kiosk.active, 0);
  }
  assert.deepEqual(db.rows("SELECT module_id, generation FROM platform_module_epochs WHERE module_id LIKE 'synthetic-%' ORDER BY module_id"), [{ module_id: "synthetic-addon", generation: 3 }, { module_id: "synthetic-notes", generation: 5 }], "each restore advances absent plugin authority");
  const snapshot = await client.call("/platform/modules"); assert.equal(snapshot.status, 200, await snapshot.clone().text());
});

test("DELETE INSTALLATION clears installed plugin tables, including ones that do not cascade from the installation", async (t) => {
  const { db, client } = pluginDatabase(); t.after(() => db.raw.close());
  await client.call("/health");
  const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");
  const { sessionSecret } = await import("./fixtures/backup-database.ts");
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" };
  const deleted = await worker.fetch(new Request("https://fixture.test/admin/data", { method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ scope: "installation", confirmation: "DELETE INSTALLATION" }) }), env);
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(db.count("SELECT COUNT(*) AS n FROM installations"), 0);
  for (const table of ["synthetic_notes_entries", "synthetic_notes_tags", "synthetic_notes_jobs", "synthetic_notes_tokens", "synthetic_addon_items"]) assert.equal(db.count(`SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} is cleared`);
});

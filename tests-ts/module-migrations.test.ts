import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ModuleMigrationError, adoptedBaselineName, applyModuleMigrations, assertPrefixClearOfCoreTables, checkModuleMigrationSql, coreIdentityTables, coreMigrationTables,
  createAdoptedBaseline, d1ModuleMigrationExecutor, loadModuleMigrationPackage, migrationSha256, planModuleMigrations, readModuleMigrationDirectory, readModuleMigrationLedger,
  splitSqlStatements, tablesAfterStatements, validateModuleMigrationFiles, validateTablePrefix, type ModuleMigrationPackage,
} from "../apps/api/src/module-migrations.ts";
import { TestD1Database, createTestD1Database, nodeMigrationDirectoryReader, readCoreMigrations } from "./fixtures/d1-database.ts";

const carpoolBaseline = ["0049_carpool_module.sql", "0058_carpool_meeting_links.sql", "0063_carpool_settings.sql", "0067_carpool_people_workspace.sql", "0068_carpool_groups_workspace.sql", "0069_carpool_share_schedule.sql", "0074_carpool_location_resolution.sql"];
const sha = (content: string) => createHash("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex");
const code = (expected: string, pattern?: RegExp) => (error: unknown) => error instanceof ModuleMigrationError && error.code === expected && (!pattern || pattern.test(error.message));
const items = `-- Example items linked to Core people.
CREATE TABLE example_items (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80 AND title <> ';'),
  PRIMARY KEY(installation_id, id)
);
CREATE INDEX example_items_member ON example_items(installation_id, member_id);
`;
const notes = "ALTER TABLE example_items ADD COLUMN notes TEXT NOT NULL DEFAULT '';\r\nCREATE TABLE example_audit (id INTEGER PRIMARY KEY, item_id TEXT NOT NULL, action TEXT NOT NULL);\r\n";
const files = [{ name: "0001_create_items.sql", content: items }, { name: "0002_add_notes.sql", content: notes }];
const reviewed = files.map((file) => ({ name: file.name, sha256: sha(file.content) }));

function moduleDirectory(t: test.TestContext, entries: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "lancerlogin-module-migrations-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(entries)) writeFileSync(join(directory, name), content);
  return directory;
}

test("the module migration ledger is a reviewed Core migration without installation ownership", () => {
  const name = "0079_module_migration_ledger.sql";
  const content = readFileSync(`apps/api/migrations/${name}`, "utf8");
  const policy = JSON.parse(readFileSync("scripts/web-upgrade-policy.json", "utf8"));
  assert.deepEqual(policy.reviewedMigrations.find((entry: { name: string }) => entry.name === name), { name, sha256: sha(content), forwardCompatible: true });
  assert.match(content, /CREATE TABLE platform_module_migrations/);
  assert.doesNotMatch(content, /REFERENCES|installation_id/);
  const database = new TestD1Database();
  database.sqlite.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-26','local')");
  const insert = database.sqlite.prepare("INSERT INTO platform_module_migrations(module_id,sequence,name,sha256,applied_at) VALUES(?,?,?,?,?)");
  insert.run("carpool", 0, adoptedBaselineName, "a".repeat(64), "2026-10-26T00:00:00.000Z");
  insert.run("example", 1, "0001_create_items.sql", "b".repeat(64), "2026-10-26T00:00:00.000Z");
  for (const row of [
    ["Example", 2, "0002_x.sql", "b".repeat(64), "2026-10-26T00:00:00Z"], ["example", 3, "0002_x.sql", "b".repeat(64), "2026-10-26T00:00:00Z"],
    ["example", 0, "0000_x.sql", "b".repeat(64), "2026-10-26T00:00:00Z"], ["example", 4, "0004_X.sql", "b".repeat(64), "2026-10-26T00:00:00Z"],
    ["example", 5, "0005_x.sql", "B".repeat(64), "2026-10-26T00:00:00Z"], ["example", 6, "0006_x.sql", "b".repeat(64), "not a time"],
    ["example", 1, "0001_create_items.sql", "c".repeat(64), "2026-10-26T00:00:00Z"], ["example", 7, "0001_create_items.sql", "c".repeat(64), "2026-10-26T00:00:00Z"],
  ]) assert.throws(() => insert.run(...row as [string, number, string, string, string]), undefined, JSON.stringify(row));
  // Installation data deletion and restore cascade from installations; the ledger must survive both.
  database.sqlite.exec("DELETE FROM installations WHERE id = 'primary'");
  assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS count FROM platform_module_migrations").get() as { count: number }).count, 2);
});

test("module migration files must be contiguous, reviewed in order and match LF-normalized hashes", async () => {
  const migrations = await validateModuleMigrationFiles({ moduleId: "example", tablePrefix: "example_", files: [...files].reverse(), reviewed });
  assert.deepEqual(migrations.map((migration) => [migration.sequence, migration.name, migration.statements.length]), [[1, "0001_create_items.sql", 2], [2, "0002_add_notes.sql", 2]]);
  assert.equal(migrations[1]!.sha256, sha(notes.replaceAll("\r\n", "\n")));
  assert.equal(await migrationSha256(notes), await migrationSha256(notes.replaceAll("\r\n", "\n")));
  const validate = (input: Partial<Parameters<typeof validateModuleMigrationFiles>[0]>) => validateModuleMigrationFiles({ moduleId: "example", tablePrefix: "example_", files, reviewed, ...input });
  await assert.rejects(validate({ files: [files[0]!, { ...files[1]!, name: "0003_add_notes.sql" }], reviewed: [reviewed[0], { ...reviewed[1], name: "0003_add_notes.sql" }] }), code("module_migration_path_review_required", /contiguously/));
  await assert.rejects(validate({ files: [{ ...files[0]!, name: "0001-create-items.sql" }] }), code("module_migration_invalid", /NNNN_name\.sql/));
  await assert.rejects(validate({ files: [{ ...files[0]!, name: "0001_Create.sql" }] }), code("module_migration_invalid"));
  await assert.rejects(validate({ reviewed: [reviewed[0]] }), code("module_migration_path_review_required", /exactly the migration files/));
  await assert.rejects(validate({ reviewed: [reviewed[1], reviewed[0]] }), code("module_migration_path_review_required"));
  await assert.rejects(validate({ files: [files[0]!, { ...files[1]!, content: notes + "\n" }] }), code("module_migration_hash_review_required", /0002_add_notes\.sql/));
  await assert.rejects(validate({ reviewed: [reviewed[0], { ...reviewed[1], extra: true }] }), code("module_migration_invalid", /exactly name and sha256/));
  await assert.rejects(validate({ reviewed: { migrations: reviewed } }), code("module_migration_invalid", /must be an array/));
  await assert.rejects(validate({ reviewed: [reviewed[0], { ...reviewed[1], sha256: "ABC" }] }), code("module_migration_invalid"));
  await assert.rejects(validate({ moduleId: "Example" }), code("module_migration_invalid"));
  await assert.rejects(validate({ files: [{ name: "0001_empty.sql", content: "-- nothing\n" }], reviewed: [{ name: "0001_empty.sql", sha256: sha("-- nothing\n") }] }), code("module_migration_invalid", /no statements/));
});

test("module migration directories are read through an injected reader and fail closed on stray entries", async (t) => {
  const directory = moduleDirectory(t, { ...Object.fromEntries(files.map((file) => [file.name, file.content])), "reviewed.json": JSON.stringify(reviewed) });
  const migrations = await readModuleMigrationDirectory(nodeMigrationDirectoryReader, { moduleId: "example", tablePrefix: "example_", directory });
  assert.deepEqual(migrations.map((migration) => migration.name), ["0001_create_items.sql", "0002_add_notes.sql"]);
  writeFileSync(join(directory, "notes.txt"), "stray");
  await assert.rejects(readModuleMigrationDirectory(nodeMigrationDirectoryReader, { moduleId: "example", tablePrefix: "example_", directory }), code("module_migration_invalid", /unexpected entries/));
  rmSync(join(directory, "notes.txt")); rmSync(join(directory, "reviewed.json"));
  await assert.rejects(readModuleMigrationDirectory(nodeMigrationDirectoryReader, { moduleId: "example", tablePrefix: "example_", directory }), code("module_migration_invalid", /reviewed\.json is required/));
  writeFileSync(join(directory, "reviewed.json"), "{not json");
  await assert.rejects(readModuleMigrationDirectory(nodeMigrationDirectoryReader, { moduleId: "example", tablePrefix: "example_", directory }), code("module_migration_invalid", /not valid JSON/));
  mkdirSync(join(directory, "nested"));
  await assert.rejects(readModuleMigrationDirectory(nodeMigrationDirectoryReader, { moduleId: "example", tablePrefix: "example_", directory }), code("module_migration_invalid", /nested/));
});

test("module migration SQL may change only prefixed schema and reference Core identity with a delete action", () => {
  const check = (sql: string) => checkModuleMigrationSql({ sql, tablePrefix: "example_", label: "Example 0001_test.sql" });
  assert.deepEqual(coreIdentityTables, ["installations", "members", "users", "member_labels"]);
  const accepted = [
    items,
    "CREATE TABLE IF NOT EXISTS \"example_quoted\" (id TEXT PRIMARY KEY, label_id TEXT, created_by TEXT, FOREIGN KEY(label_id) REFERENCES member_labels(id) ON DELETE CASCADE, CONSTRAINT owner FOREIGN KEY(created_by) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL) WITHOUT ROWID",
    "CREATE TABLE example_children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES example_items(id), state TEXT CHECK(CASE WHEN state = 'a' THEN 1 ELSE 0 END = 1))",
    "CREATE UNIQUE INDEX IF NOT EXISTS example_items_title ON example_items(installation_id, lower(title)) WHERE member_id IS NOT NULL",
    "ALTER TABLE example_items ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL",
    "ALTER TABLE example_items RENAME TO example_entries", "ALTER TABLE example_items RENAME COLUMN title TO name", "ALTER TABLE example_items DROP COLUMN title",
    "DROP TABLE IF EXISTS example_items", "DROP INDEX example_items_member", "DROP TRIGGER IF EXISTS example_items_touch",
    "INSERT INTO example_items(installation_id, id, member_id, title) SELECT m.installation_id, m.id, m.id, 'Synthetic' FROM members AS m LEFT JOIN users u ON u.member_id = m.id WHERE m.active = 1",
    "INSERT OR IGNORE INTO example_items(installation_id, id, title) VALUES ('primary', 'one', 'One') ON CONFLICT DO NOTHING",
    "REPLACE INTO example_items(installation_id, id, title) VALUES ('primary', 'two', 'Two')",
    "UPDATE example_items SET title = replace(title, 'a', 'b') WHERE member_id IN (SELECT id FROM members WHERE active = 0)",
    "DELETE FROM example_items WHERE id NOT IN (SELECT value FROM json_each('[\"one\"]'))",
    "CREATE TRIGGER example_items_touch AFTER UPDATE OF title ON example_items FOR EACH ROW WHEN NEW.title <> OLD.title BEGIN INSERT INTO example_audit(item_id, action) VALUES (NEW.id, CASE WHEN NEW.title = '' THEN 'cleared' ELSE 'renamed' END); SELECT RAISE(ABORT, 'blocked') WHERE NEW.title = 'blocked'; END",
  ];
  for (const sql of accepted) assert.ok(check(sql).length >= 1, sql);
  assert.equal(check(accepted.at(-1)! + ";\nDROP TRIGGER example_items_touch;").length, 2);
  const rejected: [string, RegExp][] = [
    ["CREATE TABLE members_extra (id TEXT)", /outside the module table prefix/],
    ["CREATE TABLE example_ (id TEXT)", /outside the module table prefix/],
    ["ALTER TABLE members ADD COLUMN example_flag INTEGER", /outside the module table prefix/],
    ["DROP TABLE members", /outside the module table prefix/],
    ["DROP VIEW example_view", /expected TABLE or INDEX or TRIGGER/],
    ["INSERT INTO members(id) VALUES ('x')", /outside the module table prefix/],
    ["UPDATE users SET role = 'admin'", /outside the module table prefix/],
    ["DELETE FROM hours_entries", /outside the module table prefix/],
    ["CREATE INDEX example_members_name ON members(first_name)", /indexed table members/],
    ["CREATE INDEX members_example ON example_items(id)", /index members_example/],
    ["CREATE TRIGGER example_members AFTER DELETE ON members BEGIN DELETE FROM example_items WHERE member_id = OLD.id; END", /trigger table members/],
    ["CREATE TRIGGER example_items_leak AFTER INSERT ON example_items BEGIN UPDATE members SET active = 0; END", /UPDATE target members/],
    ["CREATE TRIGGER example_items_view INSTEAD OF INSERT ON example_items BEGIN SELECT 1; END", /INSTEAD OF/],
    ["CREATE TABLE example_links (meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE)", /neither module owned nor a Core identity table/],
    ["CREATE TABLE example_links (member_id TEXT REFERENCES members(id))", /ON DELETE CASCADE or ON DELETE SET NULL/],
    ["CREATE TABLE example_links (member_id TEXT REFERENCES members(id) ON DELETE RESTRICT)", /ON DELETE CASCADE or ON DELETE SET NULL/],
    ["CREATE TABLE example_links (member_id TEXT REFERENCES members(id) ON UPDATE CASCADE)", /ON DELETE CASCADE or ON DELETE SET NULL/],
    ["CREATE TABLE example_links (member_id TEXT REFERENCES main.members(id) ON DELETE CASCADE)", /plain table/],
    ["CREATE TABLE main.example_links (id TEXT)", /schema-qualified/],
    ["CREATE TEMP TABLE example_scratch (id TEXT)", /CREATE TEMP/],
    ["CREATE VIEW example_view AS SELECT * FROM members", /CREATE VIEW/],
    ["CREATE VIRTUAL TABLE example_search USING fts5(title)", /CREATE VIRTUAL/],
    ["CREATE TABLE example_copy AS SELECT * FROM members", /CREATE TABLE AS/],
    ["INSERT INTO example_items(id) SELECT id FROM kiosk_fingerprint_vault_templates", /reads kiosk_fingerprint_vault_templates/],
    ["INSERT INTO example_items(id) SELECT id FROM main.members", /schema-qualified source/],
    ["INSERT INTO example_items(id) SELECT key FROM pragma_table_info('members')", /table function/],
    ["WITH source AS (SELECT id FROM members) INSERT INTO example_items(id) SELECT id FROM source", /WITH is not allowed/],
    ["INSERT INTO example_items(id) VALUES (?)", /bound parameters/],
    ["PRAGMA foreign_keys = OFF", /PRAGMA is not allowed/],
    ["PRAGMA defer_foreign_keys = 1", /PRAGMA is not allowed/],
    ["ATTACH DATABASE 'other.db' AS other", /ATTACH is not allowed/],
    ["VACUUM", /VACUUM is not allowed/],
    ["BEGIN TRANSACTION", /not an allowed migration statement/],
    ["SELECT 1", /not an allowed migration statement/],
    ["ANALYZE example_items", /not an allowed migration statement/],
    ["REINDEX example_items", /not an allowed migration statement/],
  ];
  for (const [sql, pattern] of rejected) assert.throws(() => check(sql), code("module_migration_ownership_violation", pattern), sql);
  assert.throws(() => check("INSERT INTO example_items(id) VALUES ('unterminated)"), code("module_migration_invalid", /unterminated/));
  assert.throws(() => check("CREATE TABLE example_x (id TEXT) # comment"), code("module_migration_invalid", /unsupported character/));
  assert.throws(() => check(`${items}; PRAGMA writable_schema = 1;`), code("module_migration_ownership_violation", /PRAGMA/));
  assert.deepEqual(splitSqlStatements("CREATE TABLE example_a (v TEXT DEFAULT ';'); -- ; comment\n/* ; */ INSERT INTO example_a VALUES ('it''s;');"), ["CREATE TABLE example_a (v TEXT DEFAULT ';')", "INSERT INTO example_a VALUES ('it''s;')"]);
});

test("table prefixes are validated against reserved names and Core tables", () => {
  for (const prefix of ["example_", "ex_a_", "carpool_"]) assert.equal(validateTablePrefix(prefix), prefix);
  for (const prefix of ["Example_", "example", "_x_", "1x_", "", "x".repeat(40) + "_"]) assert.throws(() => validateTablePrefix(prefix), code("module_migration_invalid"), prefix);
  for (const prefix of ["sqlite_", "d1_", "platform_", "platform_module_", "core_", "cf_"]) assert.throws(() => validateTablePrefix(prefix), code("module_migration_invalid", /reserved/), prefix);
  const coreTables = coreMigrationTables(readCoreMigrations());
  assert.ok(coreTables.includes("members") && coreTables.includes("carpool_plans") && coreTables.includes("hours_entries"));
  assert.doesNotThrow(() => assertPrefixClearOfCoreTables("example_", coreTables));
  assert.throws(() => assertPrefixClearOfCoreTables("meeting_", coreTables), code("module_migration_ownership_violation", /meeting_templates, meeting_weight_categories/));
  assert.throws(() => assertPrefixClearOfCoreTables("carpool_", coreTables), code("module_migration_ownership_violation", /carpool_plans/));
  const adopted = readCoreMigrations().filter((file) => carpoolBaseline.includes(file.name));
  assert.doesNotThrow(() => assertPrefixClearOfCoreTables("carpool_", coreTables, coreMigrationTables(adopted)));
});

test("an adopted baseline names only historical Core migrations that change the module's own tables", async () => {
  const coreMigrations = readCoreMigrations();
  const baseline = await createAdoptedBaseline({ moduleId: "carpool", tablePrefix: "carpool_", adopted: carpoolBaseline, coreMigrations });
  assert.deepEqual(baseline.migrations.map((migration) => migration.name), carpoolBaseline);
  const policy = JSON.parse(readFileSync("scripts/web-upgrade-policy.json", "utf8")) as { reviewedMigrations: { name: string; sha256: string }[] };
  for (const migration of baseline.migrations) assert.equal(migration.sha256, policy.reviewedMigrations.find((entry) => entry.name === migration.name)?.sha256);
  assert.equal(baseline.sha256, sha(baseline.migrations.map((migration) => `${migration.name} ${migration.sha256}\n`).join("")));
  const create = (adopted: string[], tablePrefix = "carpool_") => createAdoptedBaseline({ moduleId: "carpool", tablePrefix, adopted, coreMigrations });
  await assert.rejects(create(["0001_initial.sql"]), code("module_migration_ownership_violation", /must change only carpool_ tables/));
  await assert.rejects(create(["0042_outreach_participation.sql"]), code("module_migration_ownership_violation"));
  await assert.rejects(create(["0049_carpool_module.sql"], "hours_"), code("module_migration_ownership_violation"));
  await assert.rejects(create(["9999_missing.sql"]), code("module_migration_baseline_unavailable"));
  await assert.rejects(create(["0058_carpool_meeting_links.sql", "0049_carpool_module.sql"]), code("module_migration_invalid", /ascending/));
  await assert.rejects(create(["0049_carpool_module.sql", "0049_carpool_module.sql"]), code("module_migration_invalid", /ascending/));
  await assert.rejects(create([]), code("module_migration_invalid"));
});

test("an applied module ledger must be an exact prefix of the package and never newer than it", async () => {
  const migrations = await validateModuleMigrationFiles({ moduleId: "example", tablePrefix: "example_", files, reviewed });
  const pkg: ModuleMigrationPackage = { moduleId: "example", tablePrefix: "example_", migrations };
  const entry = (index: number) => ({ sequence: migrations[index]!.sequence, name: migrations[index]!.name, sha256: migrations[index]!.sha256 });
  assert.deepEqual(planModuleMigrations(pkg, [], []).pending.map((pending) => pending.name), ["0001_create_items.sql", "0002_add_notes.sql"]);
  assert.deepEqual(planModuleMigrations(pkg, [entry(0)], []).pending.map((pending) => pending.name), ["0002_add_notes.sql"]);
  assert.deepEqual(planModuleMigrations(pkg, [entry(1), entry(0)], []).pending, []);
  assert.throws(() => planModuleMigrations(pkg, [entry(0), entry(1), { sequence: 3, name: "0003_newer.sql", sha256: "c".repeat(64) }], []), code("module_migration_downgrade_refused", /0003_newer\.sql/));
  assert.throws(() => planModuleMigrations({ ...pkg, migrations: migrations.slice(0, 1) }, [entry(0), entry(1)], []), code("module_migration_downgrade_refused"));
  assert.throws(() => planModuleMigrations(pkg, [entry(1)], []), code("module_migration_path_review_required"));
  assert.throws(() => planModuleMigrations(pkg, [{ ...entry(0), sha256: "d".repeat(64) }], []), code("module_migration_hash_review_required"));
  assert.throws(() => planModuleMigrations(pkg, [{ sequence: 0, name: adoptedBaselineName, sha256: "e".repeat(64) }], []), code("module_migration_downgrade_refused"));
  const baseline = await createAdoptedBaseline({ moduleId: "carpool", tablePrefix: "carpool_", adopted: carpoolBaseline, coreMigrations: readCoreMigrations() });
  const adopted = { moduleId: "carpool", tablePrefix: "carpool_", migrations: [], baseline };
  assert.deepEqual(planModuleMigrations(adopted, [], carpoolBaseline).pending.map((pending) => [pending.kind, pending.sequence, pending.name]), [["baseline", 0, adoptedBaselineName]]);
  assert.throws(() => planModuleMigrations(adopted, [], carpoolBaseline.slice(1)), code("module_migration_baseline_unavailable", /0049_carpool_module\.sql/));
  assert.throws(() => planModuleMigrations(adopted, [{ sequence: 0, name: adoptedBaselineName, sha256: "f".repeat(64) }], carpoolBaseline), code("module_migration_hash_review_required"));
  assert.deepEqual(planModuleMigrations(adopted, [{ sequence: 0, name: adoptedBaselineName, sha256: baseline.sha256 }], []).pending, []);
});

test("the runner applies each migration atomically with its ledger row and records nothing for a failure", async (t) => {
  const database = await createTestD1Database();
  assert.deepEqual(database.sqlite.prepare("SELECT * FROM platform_module_migrations").all(), []);
  const executor = d1ModuleMigrationExecutor(database);
  const broken = "CREATE TABLE example_broken (id TEXT PRIMARY KEY);\nINSERT INTO example_broken(missing_column) VALUES ('x');\n";
  const directory = moduleDirectory(t, { [files[0]!.name]: files[0]!.content, "0002_broken.sql": broken, "reviewed.json": JSON.stringify([reviewed[0], { name: "0002_broken.sql", sha256: sha(broken) }]) });
  const load = () => loadModuleMigrationPackage(nodeMigrationDirectoryReader, { moduleId: "example", tablePrefix: "example_", directory, coreMigrations: database.coreMigrations });
  await assert.rejects(applyModuleMigrations(executor, await load(), { coreAppliedMigrations: [], now: () => "2026-10-26T12:00:00.000Z" }), code("module_migration_failed", /0002_broken\.sql failed and was not recorded/));
  assert.deepEqual(await readModuleMigrationLedger(executor, "example"), [{ sequence: 1, name: "0001_create_items.sql", sha256: reviewed[0]!.sha256 }]);
  assert.equal(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'example_broken'").get(), undefined);
  assert.ok(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'example_items'").get());
  // A repaired release ships a different reviewed migration under the same unapplied name.
  writeFileSync(join(directory, "0002_broken.sql"), notes);
  writeFileSync(join(directory, "reviewed.json"), JSON.stringify([reviewed[0], { name: "0002_broken.sql", sha256: sha(notes) }]));
  assert.deepEqual((await applyModuleMigrations(executor, await load(), { coreAppliedMigrations: [] })).applied, ["0002_broken.sql"]);
  assert.deepEqual((await applyModuleMigrations(executor, await load(), { coreAppliedMigrations: [] })).applied, []);
  assert.deepEqual(database.sqlite.prepare("SELECT module_id, sequence, name, applied_at FROM platform_module_migrations ORDER BY sequence").all().map((row) => ({ ...row })), [
    { module_id: "example", sequence: 1, name: "0001_create_items.sql", applied_at: "2026-10-26T12:00:00.000Z" },
    { module_id: "example", sequence: 2, name: "0002_broken.sql", applied_at: (database.sqlite.prepare("SELECT applied_at FROM platform_module_migrations WHERE sequence = 2").get() as { applied_at: string }).applied_at },
  ]);
  assert.ok(database.sqlite.prepare("SELECT 1 FROM pragma_table_info('example_items') WHERE name = 'notes'").get());
  // An older package that lacks the applied migration is refused before any change.
  writeFileSync(join(directory, "reviewed.json"), JSON.stringify([reviewed[0]])); rmSync(join(directory, "0002_broken.sql"));
  await assert.rejects(async () => applyModuleMigrations(executor, await load(), { coreAppliedMigrations: [] }), code("module_migration_downgrade_refused"));
});

test("the shared test database applies module migrations and adopted baselines only when asked", async (t) => {
  const directory = moduleDirectory(t, { ...Object.fromEntries(files.map((file) => [file.name, file.content])), "reviewed.json": JSON.stringify(reviewed) });
  const database = await createTestD1Database({ now: () => "2026-10-26T12:00:00.000Z", modules: [
    { moduleId: "carpool", tablePrefix: "carpool_", adoptedCoreMigrations: carpoolBaseline },
    { moduleId: "example", tablePrefix: "example_", directory },
  ] });
  const schemaBefore = new TestD1Database().sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'carpool%' ORDER BY name").all();
  assert.deepEqual(database.sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'carpool%' ORDER BY name").all(), schemaBefore);
  const ledger = database.sqlite.prepare("SELECT module_id, sequence, name FROM platform_module_migrations ORDER BY module_id, sequence").all().map((row) => ({ ...row }));
  assert.deepEqual(ledger, [
    { module_id: "carpool", sequence: 0, name: adoptedBaselineName },
    { module_id: "example", sequence: 1, name: "0001_create_items.sql" },
    { module_id: "example", sequence: 2, name: "0002_add_notes.sql" },
  ]);
  assert.deepEqual(await database.applyModuleMigrations([{ moduleId: "example", tablePrefix: "example_", directory }]), { example: [] });
  database.sqlite.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-10-26','local'); INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','1','Synthetic','Member','2026-10-26'); INSERT INTO example_items(installation_id,id,member_id,title) VALUES('primary','item','member','Item');");
  database.sqlite.exec("DELETE FROM members WHERE id = 'member'");
  assert.deepEqual({ ...database.sqlite.prepare("SELECT member_id FROM example_items").get() as object }, { member_id: null });
  await assert.rejects(database.applyModuleMigrations([{ moduleId: "intruder", tablePrefix: "carpool_", directory }]), code("module_migration_ownership_violation", /would claim Core tables/));
});

test("schema simulation follows table creation, renames and drops", () => {
  assert.deepEqual(tablesAfterStatements([
    "CREATE TABLE example_a (id TEXT)", "ALTER TABLE example_a RENAME TO example_b; CREATE TABLE IF NOT EXISTS \"example_c\" (id TEXT)",
    "CREATE INDEX example_b_id ON example_b(id)", "DROP TABLE IF EXISTS example_c", "ALTER TABLE example_b ADD COLUMN note TEXT",
  ], ["carpool_plans"]), ["carpool_plans", "example_b"]);
  assert.ok(tablesAfterStatements(readCoreMigrations().map((file) => file.content)).includes("organization_settings"));
  assert.equal(tablesAfterStatements(readCoreMigrations().map((file) => file.content)).includes("organization_settings_next"), false);
});

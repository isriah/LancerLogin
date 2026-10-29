import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { captureCommunityState, assertCommunityStateRetained } from "../scripts/rehearse-community-upgrade.mjs";

function fixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE d1_migrations(id INTEGER, name TEXT);
    CREATE TABLE _cf_METADATA(key TEXT, value TEXT);
    CREATE TABLE members(id TEXT PRIMARY KEY, active INTEGER, email TEXT);
    CREATE TABLE empty_history(id TEXT PRIMARY KEY, notes TEXT);
    INSERT INTO members VALUES('member-b',0,NULL),('member-a',1,'synthetic@example.invalid');
  `);
  const execute = async (sql) => sql.split(";").filter((statement) => statement.trim())
    .map((statement) => ({ results: database.prepare(statement).all().map((row) => ({ ...row })) }));
  return { database, execute };
}

test("Community snapshot retains every application column, inactive row and empty table", async (t) => {
  const { execute } = fixture(t);
  const before = await captureCommunityState(execute);
  assert.deepEqual(before, [
    { name: "empty_history", columns: ["id", "notes"], rows: [] },
    { name: "members", columns: ["id", "active", "email"], rows: [
      { id: "member-a", active: 1, email: "synthetic@example.invalid" },
      { id: "member-b", active: 0, email: null },
    ] },
  ]);
  await assertCommunityStateRetained(execute, before);
});

test("Community snapshot allows additive module tables and new columns", async (t) => {
  const { database, execute } = fixture(t);
  const before = await captureCommunityState(execute);
  database.exec("ALTER TABLE members ADD COLUMN new_setting TEXT DEFAULT 'new'; CREATE TABLE module_owned(id TEXT);");
  await assertCommunityStateRetained(execute, before);
});

for (const [name, sql] of [
  ["changed setting", "UPDATE members SET email=NULL WHERE id='member-a'"],
  ["deleted inactive member", "DELETE FROM members WHERE active=0"],
  ["unexpected legacy row", "INSERT INTO empty_history VALUES('unexpected','changed')"],
  ["missing empty legacy table", "DROP TABLE empty_history"],
]) {
  test(`Community snapshot rejects a ${name}`, async (t) => {
    const { database, execute } = fixture(t);
    const before = await captureCommunityState(execute);
    database.exec(sql);
    await assert.rejects(() => assertCommunityStateRetained(execute, before));
  });
}

test("upgrade guide links carry-over, web-first updates and restore authority boundaries", async () => {
  const guide = await readFile("docs/COMMUNITY-UPGRADE.md", "utf8");
  assert.match(guide, /Only a complete published official release is an update target, never a private build or source branch/);
  assert.match(guide, /v1\.2\.6 Community bridge/);
  assert.match(guide, /Update the web software first, then each kiosk/);
  assert.match(guide, /password hashes/);
  assert.match(guide, /pinned report tabs and walkthrough progress/);
  assert.match(guide, /Outreach starts disabled/);
  assert.match(guide, /intentionally revokes kiosk and pairing authority/);
  assert.match(guide, /Do not automatically roll back code, restore D1, restore an old queue/);
  for (const match of guide.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https:\/\/isriah\.github\.io\/LancerLogin\//.test(match[1])) continue; // the public documentation site
    await access(resolve("docs", match[1].split("#")[0]));
  }
  for (const path of ["README.md", "docs/WEB-UPDATES.md", "docs/KIOSK.md"]) {
    assert.match(await readFile(path, "utf8"), /\]\((?:docs\/)?COMMUNITY-UPGRADE\.md\)/);
  }
});

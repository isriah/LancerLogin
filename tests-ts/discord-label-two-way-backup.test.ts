// Backup and restore of two-way label sync, through the Worker on a real SQLite database with every Core migration.
// Synthetic data only, and no Discord call: the two-way functions receive a synthetic server's state.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../apps/api/src/index.ts";
import { confirmTwoWay, disableTwoWay, hasTwoWayLabels, pollTwoWayLabels, previewTwoWay, twoWayRestorePaused, type TwoWayServer } from "../apps/api/src/discord-label-two-way.ts";
import type { D1Database } from "../apps/api/src/d1-usage.ts";
import { BackupDatabase, backupClient } from "./fixtures/backup-database.ts";
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";

const guildId = "123456789012345678", roleId = "423456789012345678";
const ids = { a: "111111111111111111", b: "222222222222222222", stranger: "999999999999999999" };
const at = (minutes: number) => new Date(Date.parse("2026-10-30T12:00:00.000Z") + minutes * 60_000);
const deps = (minutes: number) => ({ sourceFingerprint: async () => "source", now: () => at(minutes) });

/** Test Student A holds the label from Discord, Test Student B from the dashboard; the label syncs both ways. */
function seed(t: { after(fn: () => void): void }) {
  const db = new BackupDatabase(); t.after(() => db.raw.close());
  db.raw.exec(`INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id,created_at,attendance_required_from) VALUES
      ('m-a','primary','T-A','Test Student','A','test-student-a@example.test','${ids.a}','2026-01-01','2026-01-01'),
      ('m-b','primary','T-B','Test Student','B','test-student-b@example.test','${ids.b}','2026-01-01','2026-01-01');
    INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('label-build','primary','Test Build Team','2026-01-01T00:00:00.000Z'),('label-pit','primary','Test Pit Crew','2026-01-01T00:00:00.000Z');
    INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_by,created_at,source) VALUES
      ('change-a','primary','m-a','label-build','add','2026-09-01',NULL,'2026-09-01T00:00:00.000Z','discord'),
      ('change-b','primary','m-b','label-build','add','2026-09-01','admin','2026-09-01T00:00:00.000Z','dashboard'),
      ('change-pit','primary','m-a','label-pit','add','2026-09-01','admin','2026-09-01T00:00:00.000Z','dashboard');
    INSERT INTO discord_label_role_mappings(installation_id,label_id,guild_id,role_id,role_name,created_at,sync_direction,two_way_enabled_at,two_way_checked_at) VALUES
      ('primary','label-build','${guildId}','${roleId}','Test Builders','2026-09-01T00:00:00.000Z','two_way','2026-09-01T00:00:00.000Z','2026-10-30T11:55:00.000Z'),
      ('primary','label-pit','${guildId}','523456789012345678','Test Pit','2026-09-01T00:00:00.000Z','to_discord',NULL,NULL);
    INSERT INTO discord_label_two_way_members(installation_id,label_id,member_id,discord_user_id,synced_state,synced_at) VALUES ('primary','label-build','m-a','${ids.a}',1,'2026-10-30T11:55:00.000Z'),('primary','label-build','m-b','${ids.b}',1,'2026-10-30T11:55:00.000Z');
    INSERT INTO discord_label_unmatched_role_members(installation_id,label_id,discord_user_id,display_name,seen_at) VALUES ('primary','label-build','${ids.stranger}','test-stranger','2026-10-30T11:55:00.000Z');
    INSERT INTO discord_label_two_way_previews(id,installation_id,label_id,guild_id,role_id,fingerprint,actor_user_id,expires_at,created_at) VALUES ('old-preview','primary','label-build','${guildId}','${roleId}','f','admin','2026-10-30T12:05:00.000Z','2026-10-30T11:55:00.000Z');`);
  return db;
}
/** The synthetic server after the restore: A still holds the role, B lost it in Discord. */
function server(holders = new Set([ids.a, ids.stranger])): TwoWayServer {
  return { guildId, guildMembers: [ids.a, ids.b, ids.stranger].map((id) => ({ user: { id, username: `test-${id.slice(0, 3)}` }, roles: holders.has(id) ? [roleId] : [] })), roleProblem: () => undefined, roleName: () => "Test Builders" };
}
const d1 = (db: BackupDatabase) => db as unknown as D1Database;
const mapping = (db: BackupDatabase, labelId = "label-build") => db.rows<{ sync_direction: string; two_way_error: string | null; two_way_enabled_at: string | null; two_way_checked_at: string | null }>("SELECT sync_direction, two_way_error, two_way_enabled_at, two_way_checked_at FROM discord_label_role_mappings WHERE label_id = ?", labelId)[0];
const sources = (db: BackupDatabase) => Object.fromEntries(db.rows<{ id: string; source: string }>("SELECT id, source FROM member_label_changes ORDER BY id").map((row) => [row.id, row.source]));
const twoWayState = (db: BackupDatabase) => ({
  baseline: db.count("SELECT COUNT(*) AS n FROM discord_label_two_way_members"),
  unmatched: db.count("SELECT COUNT(*) AS n FROM discord_label_unmatched_role_members"),
  previews: db.count("SELECT COUNT(*) AS n FROM discord_label_two_way_previews"),
  jobs: db.count("SELECT COUNT(*) AS n FROM discord_label_role_jobs"),
});

test("installation backups carry each label change's source and each role link's sync direction", async (t) => {
  const db = seed(t); const client = backupClient(worker, db);
  const backup = await client.backup("installation");
  assert.equal(backup.schemaVersion, 45);
  assert.deepEqual(Object.fromEntries(backup.tables.member_label_changes.map((row: { id: string; source: string }) => [row.id, row.source])), { "change-a": "discord", "change-b": "dashboard", "change-pit": "dashboard" });
  assert.deepEqual(backup.tables.discord_label_role_mappings.map((row: { label_id: string; sync_direction: string }) => [row.label_id, row.sync_direction]), [["label-build", "two_way"], ["label-pit", "to_discord"]]);
  // The baseline, unmatched list and reviews are operational state and never travel.
  for (const table of ["discord_label_two_way_members", "discord_label_unmatched_role_members", "discord_label_two_way_previews"]) assert.equal(Object.hasOwn(backup.tables, table), false);
  const roster = await client.backup("roster");
  assert.equal(roster.tables.member_label_changes.find((row: { id: string }) => row.id === "change-a").source, "discord");
});

test("a restored two-way label keeps its Discord history and stays paused until an Admin reconciles it again", async (t) => {
  const db = seed(t); const client = backupClient(worker, db);
  const backup = await client.backup("installation");
  const restored = await client.restore(backup); assert.equal(restored.status, 200, await restored.clone().text());

  assert.deepEqual(sources(db), { "change-a": "discord", "change-b": "dashboard", "change-pit": "dashboard" }, "From Discord history stays from Discord");
  assert.deepEqual(mapping(db), { sync_direction: "to_discord", two_way_error: twoWayRestorePaused, two_way_enabled_at: null, two_way_checked_at: null });
  assert.deepEqual(mapping(db, "label-pit"), { sync_direction: "to_discord", two_way_error: null, two_way_enabled_at: null, two_way_checked_at: null });
  assert.deepEqual(twoWayState(db), { baseline: 0, unmatched: 0, previews: 0, jobs: 0 });

  // The scheduled pass skips it: nothing is read from or pushed to Discord, and no label changes.
  assert.equal(await hasTwoWayLabels(d1(db)), false);
  assert.deepEqual(await pollTwoWayLabels(d1(db), server(), deps(0)), []);
  assert.deepEqual(twoWayState(db), { baseline: 0, unmatched: 0, previews: 0, jobs: 0 });
  assert.deepEqual(sources(db), { "change-a": "discord", "change-b": "dashboard", "change-pit": "dashboard" });

  // The dashboard sees it as paused, not as a failed check or a plain Dashboard to Discord label.
  const listed = await (await client.call("/admin/integrations/discord/label-roles")).json() as { mappings: { labelId: string; syncDirection: string; twoWayPaused?: boolean; twoWayError: string | null }[] };
  assert.deepEqual(listed.mappings.map((row) => [row.labelId, row.syncDirection, Boolean(row.twoWayPaused), row.twoWayError]), [["label-build", "to_discord", true, null], ["label-pit", "to_discord", false, null]]);

  // A backup of the paused label still records it as two-way, so restoring that backup pauses it again.
  const again = await client.backup("installation");
  assert.equal(again.tables.discord_label_role_mappings.find((row: { label_id: string }) => row.label_id === "label-build").sync_direction, "two_way");
  assert.equal((await client.restore(again)).status, 200);
  assert.equal(mapping(db).two_way_error, twoWayRestorePaused);

  // The reconciliation preview accepts the paused label; confirming re-creates the baseline and resumes two-way sync.
  const preview = await previewTwoWay(d1(db), "admin", "label-build", server(), deps(1));
  assert.deepEqual(preview.mismatches.map((row) => [row.memberId, row.hasLabel, row.hasRole]), [["T-B", true, false]]);
  const confirmed = await confirmTwoWay(d1(db), "admin", { previewId: preview.previewId, all: "discord" }, server(), deps(2));
  assert.equal(confirmed.labelsRemoved, 1);
  assert.deepEqual({ ...mapping(db), two_way_enabled_at: Boolean(mapping(db).two_way_enabled_at) }, { sync_direction: "two_way", two_way_error: null, two_way_enabled_at: true, two_way_checked_at: at(2).toISOString() });
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_two_way_members WHERE label_id = 'label-build'"), 2);
  assert.equal(await hasTwoWayLabels(d1(db)), true);
  const [checked] = await pollTwoWayLabels(d1(db), server(), deps(7));
  assert.equal(checked?.status, "checked"); assert.equal(checked?.unmatched, 1);
});

test("switching a paused label to Dashboard to Discord clears the pause without changing labels or roles", async (t) => {
  const db = seed(t); const client = backupClient(worker, db);
  assert.equal((await client.restore(await client.backup("installation"))).status, 200);
  assert.deepEqual(await disableTwoWay(d1(db), "admin", "label-build"), { syncDirection: "to_discord" });
  assert.deepEqual(mapping(db), { sync_direction: "to_discord", two_way_error: null, two_way_enabled_at: null, two_way_checked_at: null });
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'discord.label_two_way_disabled'"), 1);
  assert.deepEqual(twoWayState(db), { baseline: 0, unmatched: 0, previews: 0, jobs: 0 });
  const listed = await (await client.call("/admin/integrations/discord/label-roles")).json() as { mappings: { labelId: string; twoWayPaused?: boolean }[] };
  assert.equal(listed.mappings.some((row) => row.twoWayPaused), false);
});

test("a roster restore pauses two-way labels whose history it replaces", async (t) => {
  const db = seed(t); const client = backupClient(worker, db);
  const roster = await client.backup("roster");
  const restored = await client.call("/admin/data/restore", { scope: "roster", confirmation: "RESTORE ROSTER", backup: roster }); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(sources(db), { "change-a": "discord", "change-b": "dashboard", "change-pit": "dashboard" });
  assert.equal(mapping(db).two_way_error, twoWayRestorePaused);
  assert.deepEqual(twoWayState(db), { baseline: 0, unmatched: 0, previews: 0, jobs: 0 });
  assert.deepEqual(await pollTwoWayLabels(d1(db), server(), deps(0)), []);
});

test("backups from before schema 45 restore exactly as before", async (t) => {
  const db = seed(t); const client = backupClient(worker, db);
  const current = await client.backup("installation");
  const legacy = structuredClone(current); legacy.schemaVersion = 44; omitContestResubmissionFields(legacy);
  assert.equal(Object.hasOwn(legacy.tables.member_label_changes[0], "source"), false);
  assert.equal(Object.hasOwn(legacy.tables.discord_label_role_mappings[0], "sync_direction"), false);
  const restored = await client.restore(legacy); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(sources(db), { "change-a": "dashboard", "change-b": "dashboard", "change-pit": "dashboard" });
  assert.deepEqual(mapping(db), { sync_direction: "to_discord", two_way_error: null, two_way_enabled_at: null, two_way_checked_at: null });

  // A schema 44 file carrying the new fields was not made by a schema 44 build and is refused, and a schema 45 file
  // with an unknown source or direction is refused.
  const mixed = structuredClone(legacy); mixed.tables.member_label_changes[0].source = "discord";
  assert.equal((await client.restore(mixed)).status, 400);
  const badSource = structuredClone(current); badSource.tables.member_label_changes[0].source = "kiosk";
  assert.equal((await client.restore(badSource)).status, 400);
  const badDirection = structuredClone(current); badDirection.tables.discord_label_role_mappings[0].sync_direction = "from_discord";
  assert.equal((await client.restore(badDirection)).status, 400);
});

test("the stored paused state is safe for a Worker deployed before it existed", async (t) => {
  const db = seed(t); const client = backupClient(worker, db);
  assert.equal((await client.restore(await client.backup("installation"))).status, 200);
  // The deployed scheduled pass selects labels by these exact conditions, and its claim requires two-way too.
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_mappings x JOIN member_labels l ON l.id = x.label_id AND l.installation_id = x.installation_id WHERE x.installation_id = 'primary' AND x.sync_direction = 'two_way' AND l.active = 1"), 0);
  assert.equal(db.raw.prepare("UPDATE discord_label_role_mappings SET two_way_lease_expires_at = ? WHERE installation_id = 'primary' AND label_id = ? AND sync_direction = 'two_way' AND (two_way_lease_expires_at IS NULL OR two_way_lease_expires_at <= ?)").run("2026-10-30T12:02:00.000Z", "label-build", "2026-10-30T12:00:00.000Z").changes, 0);
  // Its unmatched-users list shows two-way labels only, so nothing stale is listed for the paused label.
  assert.equal(db.count("SELECT COUNT(*) AS n FROM discord_label_role_mappings WHERE installation_id = 'primary' AND sync_direction = 'two_way'"), 0);
});

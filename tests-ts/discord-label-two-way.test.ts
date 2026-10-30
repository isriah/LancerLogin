// Two-way label and Discord role sync, run against every Core migration with a synthetic Discord server. No Discord call
// is made: the Worker loads the server once and hands its state to these functions.
import test from "node:test";
import assert from "node:assert/strict";
import { TestD1Database } from "./fixtures/d1-database.ts";
import { confirmTwoWay, decideTwoWay, disableTwoWay, pollTwoWayLabels, previewTwoWay, sortRolesByName, unmatchedRoleMembers, type TwoWayGuildMember, type TwoWayServer } from "../apps/api/src/discord-label-two-way.ts";
import { HttpError } from "../apps/api/src/http-error.ts";

const guildId = "123456789012345678", roleId = "423456789012345678";
const ids = { ada: "111111111111111111", bo: "222222222222222222", cy: "333333333333333333", di: "444444444444444444", fay: "555555555555555555", gus: "666666666666666666", stranger: "999999999999999999", visitor: "888888888888888888" };
const at = (minutes: number) => new Date(Date.parse("2026-10-30T12:00:00.000Z") + minutes * 60_000);

function seed() {
  const db = new TestD1Database(); const sql = db.sqlite;
  sql.exec(`INSERT INTO installations (id, created_at, auth_mode) VALUES ('primary', '2026-09-01T00:00:00Z', 'local');
    INSERT INTO organization_settings (installation_id, time_zone) VALUES ('primary', 'UTC');
    INSERT INTO users (id, installation_id, email, role, created_at) VALUES ('admin-1', 'primary', 'test-admin-a@example.test', 'admin', '2026-09-01T00:00:00Z'), ('admin-2', 'primary', 'test-admin-b@example.test', 'admin', '2026-09-01T00:00:00Z');
    INSERT INTO member_labels (id, installation_id, name, created_at) VALUES ('label-build', 'primary', 'Build Team', '2026-09-01T00:00:00Z');
    INSERT INTO discord_label_role_mappings (installation_id, label_id, guild_id, role_id, role_name, created_at) VALUES ('primary', 'label-build', '${guildId}', '${roleId}', 'Builders', '2026-09-01T00:00:00Z');`);
  const member = sql.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, discord_user_id, active, created_at) VALUES (?, 'primary', ?, 'Test Student', ?, ?, ?, '2026-09-01T00:00:00Z')");
  member.run("m-ada", "T-ADA", "A", ids.ada, 1); member.run("m-bo", "T-BO", "B", ids.bo, 1); member.run("m-cy", "T-CY", "C", ids.cy, 1);
  member.run("m-di", "T-DI", "D", ids.di, 0); member.run("m-eve", "T-EVE", "E", null, 1);
  member.run("m-fay", "T-FAY", "F", ids.fay, 1); member.run("m-gus", "T-GUS", "G", ids.gus, 1);
  for (const memberId of ["m-ada", "m-cy", "m-di", "m-eve", "m-gus"]) addChange(db, memberId, "add", "2026-09-01", "2026-09-01T00:00:00Z");
  return db;
}
function addChange(db: TestD1Database, memberId: string, action: "add" | "remove", effectiveDate: string, createdAt: string) {
  db.sqlite.prepare("INSERT INTO member_label_changes (id, installation_id, member_id, label_id, action, effective_date, created_by, created_at) VALUES (?, 'primary', ?, 'label-build', ?, ?, 'admin-1', ?)").run(crypto.randomUUID(), memberId, action, effectiveDate, createdAt);
}
/** A synthetic server: who holds the role is edited in place between passes. */
function server(holders: Set<string>, everyone = [ids.ada, ids.bo, ids.cy, ids.di, ids.fay, ids.gus, ids.stranger, ids.visitor]): TwoWayServer {
  const guildMembers = (): TwoWayGuildMember[] => everyone.map((id) => ({ user: { id, username: `test-${id.slice(0, 3)}` }, roles: holders.has(id) ? [roleId] : [] }));
  return { guildId, get guildMembers() { return guildMembers(); }, roleProblem: () => undefined, roleName: () => "Builders" };
}
const deps = (minutes: number) => ({ sourceFingerprint: async () => "source", now: () => at(minutes) });
const labelState = (db: TestD1Database, memberId: string) => { const row = db.sqlite.prepare("SELECT action, source FROM member_label_changes WHERE member_id = ? AND label_id = 'label-build' AND effective_date <= '2026-10-30' ORDER BY effective_date DESC, created_at DESC, id DESC LIMIT 1").get(memberId) as { action: string; source: string } | undefined; return row && { ...row }; };
const jobs = (db: TestD1Database) => db.sqlite.prepare("SELECT j.id, j.status, i.discord_user_id AS discordUserId, i.action FROM discord_label_role_jobs j JOIN discord_label_role_job_items i ON i.job_id = j.id ORDER BY j.created_at, i.discord_user_id").all() as { id: string; status: string; discordUserId: string; action: string }[];
const finishJobs = (db: TestD1Database) => db.sqlite.exec("UPDATE discord_label_role_jobs SET status = 'completed'; UPDATE discord_label_role_job_items SET status = 'completed'");
async function rejects(work: Promise<unknown>, status: number, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof HttpError && error.status === status && pattern.test(error.message));
}

test("the side that changed wins, the dashboard wins when both changed, and agreement needs no change", () => {
  assert.equal(decideTwoWay({ hasLabel: true, hasRole: true, syncedState: false }), "none");
  assert.equal(decideTwoWay({ hasLabel: false, hasRole: true, syncedState: false }), "add_label", "role added in Discord");
  assert.equal(decideTwoWay({ hasLabel: true, hasRole: false, syncedState: true }), "remove_label", "role removed in Discord");
  assert.equal(decideTwoWay({ hasLabel: true, hasRole: false, syncedState: false }), "add_role", "label added in the dashboard");
  assert.equal(decideTwoWay({ hasLabel: false, hasRole: true, syncedState: true }), "remove_role", "label removed in the dashboard");
  assert.equal(decideTwoWay({ hasLabel: true, hasRole: false, syncedState: true, dashboardChanged: true }), "add_role", "both changed: the dashboard wins");
  assert.equal(decideTwoWay({ hasLabel: false, hasRole: true }), "remove_role", "no baseline yet: the dashboard wins");
});

test("Discord role pickers sort by name, ignoring case and accents", () => {
  const roles = [{ name: "gamma" }, { name: "Beta" }, { name: "alpha" }, { name: "Émile" }, { name: "Alpha" }, { name: "delta" }];
  assert.deepEqual(sortRolesByName(roles).map((role) => role.name), ["alpha", "Alpha", "Beta", "delta", "Émile", "gamma"]);
  assert.deepEqual(roles.map((role) => role.name)[0], "gamma", "the input is not reordered in place");
});

test("turning on two-way sync reviews mismatches, refuses stale or incomplete choices and stores the baseline", async () => {
  const db = seed(); const holders = new Set([ids.ada, ids.bo, ids.gus, ids.stranger]); const discord = server(holders);
  // Bo has the role but not the label; Cy has the label but not the role. Di is inactive and Eve is unpaired: neither is listed.
  const preview = await previewTwoWay(db, "admin-1", "label-build", discord, deps(0));
  assert.deepEqual(preview.mismatches.map((row) => [row.memberId, row.hasLabel, row.hasRole]), [["T-BO", false, true], ["T-CY", true, false]]);
  assert.equal(preview.pairedCount, 5); assert.equal(preview.unmatchedCount, 1); assert.equal(preview.roleName, "Builders");
  assert.deepEqual(preview.attendance, { affectsAttendance: false, attendanceRules: 0, weeklyTargets: 0, meetingAudiences: 0 });

  // A role change in Discord after the review makes it stale.
  holders.add(ids.cy);
  await rejects(confirmTwoWay(db, "admin-1", { previewId: preview.previewId, all: "dashboard" }, discord, deps(1)), 409, /changed since this review/);
  holders.delete(ids.cy);
  const fresh = await previewTwoWay(db, "admin-1", "label-build", discord, deps(2));
  await rejects(confirmTwoWay(db, "admin-2", { previewId: fresh.previewId, all: "dashboard" }, discord, deps(3)), 409, /expired or was already used/);
  await rejects(confirmTwoWay(db, "admin-1", { previewId: fresh.previewId, choices: { "T-BO": "discord" } }, discord, deps(3)), 400, /correct side for 1 person/);
  await rejects(confirmTwoWay(db, "admin-1", { previewId: fresh.previewId, choices: { "T-BO": "maybe" } }, discord, deps(3)), 400, /dashboard or discord/);
  const expired = await previewTwoWay(db, "admin-1", "label-build", discord, deps(4));
  await rejects(confirmTwoWay(db, "admin-1", { previewId: expired.previewId, all: "dashboard" }, discord, deps(20)), 409, /expired/);

  // A per-row choice overrides "for everyone".
  const confirmed = await confirmTwoWay(db, "admin-1", { previewId: fresh.previewId, all: "dashboard", choices: { "T-BO": "discord" } }, discord, deps(5));
  assert.deepEqual({ ...confirmed, jobId: Boolean(confirmed.jobId) }, { enabled: true, labelId: "label-build", syncDirection: "two_way", labelsAdded: 1, labelsRemoved: 0, rolesAdded: 1, rolesRemoved: 0, jobId: true });
  assert.deepEqual(labelState(db, "m-bo"), { action: "add", source: "discord" }, "Discord was chosen for Bo");
  assert.deepEqual(jobs(db).map((row) => [row.discordUserId, row.action]), [[ids.cy, "add"]], "the dashboard was chosen for Cy");
  assert.equal((db.sqlite.prepare("SELECT sync_direction AS direction FROM discord_label_role_mappings").get() as { direction: string }).direction, "two_way");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM discord_label_two_way_members").get() as { count: number }).count, 5);
  await rejects(confirmTwoWay(db, "admin-1", { previewId: fresh.previewId, all: "dashboard" }, discord, deps(6)), 409, /expired or was already used/);
  await rejects(previewTwoWay(db, "admin-1", "label-build", discord, deps(6)), 409, /already syncs both ways/);
});

test("a label that drives attendance needs the warning acknowledged before two-way sync starts", async () => {
  const db = seed(); const discord = server(new Set([ids.ada, ids.cy, ids.gus]));
  db.sqlite.exec(`INSERT INTO label_attendance_rules (id, installation_id, label_id, rule_type, threshold_percent, created_at, updated_at) VALUES ('rule-1', 'primary', 'label-build', 'weighted_percentage', 75, '2026-09-01', '2026-09-01');
    INSERT INTO label_attendance_rules (id, installation_id, label_id, starts_on, ends_on, rule_type, meetings_per_week, created_at, updated_at) VALUES ('target-1', 'primary', 'label-build', '2026-09-01', '2026-12-31', 'weekly_count', 2, '2026-09-01', '2026-09-01');
    INSERT INTO meetings (id, installation_id, title, starts_at, ends_at, created_by, created_at, audience_mode) VALUES ('meeting-1', 'primary', 'Test Meeting A', '2026-11-02T18:00:00Z', '2026-11-02T20:00:00Z', 'admin-1', '2026-09-01', 'labels');
    INSERT INTO meeting_audience_labels (installation_id, meeting_id, label_id) VALUES ('primary', 'meeting-1', 'label-build');`);
  const preview = await previewTwoWay(db, "admin-1", "label-build", discord, deps(0));
  assert.deepEqual(preview.attendance, { affectsAttendance: true, attendanceRules: 1, weeklyTargets: 1, meetingAudiences: 1 });
  assert.equal(preview.mismatches.length, 0, "everyone already matches");
  await assert.rejects(confirmTwoWay(db, "admin-1", { previewId: preview.previewId }, discord, deps(1)), (error: unknown) => error instanceof HttpError && error.code === "attendance_acknowledgement_required");
  const confirmed = await confirmTwoWay(db, "admin-1", { previewId: preview.previewId, acknowledgeAttendance: true }, discord, deps(1));
  assert.equal(confirmed.enabled, true); assert.equal(confirmed.jobId, undefined, "nothing to push");
});

test("the scheduled check follows Discord, pushes dashboard changes, never ping-pongs and records unmatched users", async () => {
  const db = seed(); const holders = new Set([ids.ada, ids.cy, ids.gus, ids.stranger]); const discord = server(holders);
  const preview = await previewTwoWay(db, "admin-1", "label-build", discord, deps(0));
  assert.equal(preview.mismatches.length, 0);
  await confirmTwoWay(db, "admin-1", { previewId: preview.previewId }, discord, deps(1));
  const poll = async (minutes: number) => (await pollTwoWayLabels(db, discord, deps(minutes)))[0];

  // Nothing changed: no label change, no role job.
  assert.deepEqual(await poll(5), { labelId: "label-build", status: "checked", labelsAdded: 0, labelsRemoved: 0, rolesAdded: 0, rolesRemoved: 0, unmatched: 1, jobId: undefined });
  assert.deepEqual((await unmatchedRoleMembers(db)).labels.map((label) => [label.labelName, label.users.map((user) => user.discordUserId)]), [["Build Team", [ids.stranger]]]);

  // Role added in Discord adds the label; role removed in Discord removes it. Both are recorded as from Discord.
  holders.add(ids.fay); holders.delete(ids.ada);
  const fromDiscord = await poll(10);
  assert.equal(fromDiscord.labelsAdded, 1); assert.equal(fromDiscord.labelsRemoved, 1); assert.equal(fromDiscord.jobId, undefined);
  assert.deepEqual(labelState(db, "m-fay"), { action: "add", source: "discord" }); assert.deepEqual(labelState(db, "m-ada"), { action: "remove", source: "discord" });
  // The next pass reads its own writes back as agreement, not as dashboard changes.
  const settled = await poll(15);
  assert.equal(settled.labelsAdded + settled.labelsRemoved + settled.rolesAdded + settled.rolesRemoved, 0); assert.equal(jobs(db).length, 0);

  // Label removed in the dashboard: the role is removed through a role sync job, and the label is left alone.
  addChange(db, "m-cy", "remove", "2026-10-30", at(16).toISOString());
  const pushed = await poll(20);
  assert.equal(pushed.rolesRemoved, 1); assert.ok(pushed.jobId); assert.deepEqual(jobs(db).map((row) => [row.discordUserId, row.action]), [[ids.cy, "remove"]]);
  assert.equal(labelState(db, "m-cy")?.action, "remove");
  // While the job runs the label is skipped, so the role it has not removed yet is not read as a Discord change.
  assert.equal((await poll(25)).status, "syncing");
  finishJobs(db); holders.delete(ids.cy);
  const afterPush = await poll(30);
  assert.equal(afterPush.labelsAdded + afterPush.labelsRemoved + afterPush.rolesAdded + afterPush.rolesRemoved, 0);

  // Both changed: Gus's label was edited in the dashboard (it ends where it was) while his role was removed in Discord.
  addChange(db, "m-gus", "remove", "2026-10-28", at(31).toISOString()); addChange(db, "m-gus", "add", "2026-10-29", at(32).toISOString());
  holders.delete(ids.gus);
  const conflict = await poll(35);
  assert.equal(conflict.labelsRemoved, 0, "the dashboard wins"); assert.equal(conflict.rolesAdded, 1);
  assert.deepEqual(jobs(db).at(-1) && [jobs(db).at(-1)!.discordUserId, jobs(db).at(-1)!.action], [ids.gus, "add"]);
  assert.equal(labelState(db, "m-gus")?.action, "add");

  // An overlapping pass that finds the lease held changes nothing.
  finishJobs(db); holders.add(ids.gus);
  db.sqlite.prepare("UPDATE discord_label_role_mappings SET two_way_lease_expires_at = ?").run(at(60).toISOString());
  holders.add(ids.bo);
  assert.equal((await poll(40)).status, "busy"); assert.equal(labelState(db, "m-bo"), undefined);
  db.sqlite.exec("UPDATE discord_label_role_mappings SET two_way_lease_expires_at = NULL");
  assert.equal((await poll(45)).labelsAdded, 1, "the next pass applies it once");
  assert.equal((await poll(50)).labelsAdded, 0);

  // Back to Dashboard to Discord: the scheduled check stops and the two-way state is forgotten.
  await disableTwoWay(db, "admin-1", "label-build");
  assert.deepEqual(await pollTwoWayLabels(db, discord, deps(55)), []);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS count FROM discord_label_unmatched_role_members").get() as { count: number }).count, 0);
});

test("a role the bot can no longer manage pauses the label instead of clearing it", async () => {
  const db = seed(); const holders = new Set([ids.ada, ids.cy, ids.gus]); const discord = server(holders);
  await confirmTwoWay(db, "admin-1", { previewId: (await previewTwoWay(db, "admin-1", "label-build", discord, deps(0))).previewId }, discord, deps(1));
  holders.clear();
  const result = (await pollTwoWayLabels(db, { ...discord, guildMembers: discord.guildMembers, roleProblem: () => "The mapped Discord role no longer exists" }, deps(5)))[0];
  assert.equal(result.status, "error"); assert.equal(labelState(db, "m-ada")?.action, "add");
  assert.match((db.sqlite.prepare("SELECT two_way_error AS error FROM discord_label_role_mappings").get() as { error: string }).error, /no longer exists/);
});

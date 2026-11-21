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
  // No baseline yet: nothing is removed on either side. The first check takes the union.
  assert.equal(decideTwoWay({ hasLabel: false, hasRole: true }), "add_label", "a role already held is adopted as the label");
  assert.equal(decideTwoWay({ hasLabel: true, hasRole: false }), "add_role", "a label already held adds the role");
  assert.equal(decideTwoWay({ hasLabel: false, hasRole: true, dashboardChanged: true }), "add_label", "still nothing to compare a change with");
  assert.equal(decideTwoWay({ hasLabel: true, hasRole: true }), "none"); assert.equal(decideTwoWay({ hasLabel: false, hasRole: false }), "none");
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

test("a scheduled pass checks a limited number of two-way labels, least recently checked first", async () => {
  const db = seed(); const discord = server(new Set([ids.ada, ids.cy, ids.gus]));
  db.sqlite.exec(`INSERT INTO member_labels (id, installation_id, name, created_at) VALUES ('label-art', 'primary', 'Art Team', '2026-09-01T00:00:00Z'), ('label-code', 'primary', 'Code Team', '2026-09-01T00:00:00Z');
    INSERT INTO discord_label_role_mappings (installation_id, label_id, guild_id, role_id, role_name, created_at) VALUES ('primary', 'label-art', '${guildId}', '423456789012345679', 'Artists', '2026-09-01T00:00:00Z'), ('primary', 'label-code', '${guildId}', '423456789012345680', 'Coders', '2026-09-01T00:00:00Z');
    UPDATE discord_label_role_mappings SET sync_direction = 'two_way', two_way_enabled_at = '2026-10-30T09:00:00.000Z';
    UPDATE discord_label_role_mappings SET two_way_checked_at = CASE label_id WHEN 'label-build' THEN '2026-10-30T11:00:00.000Z' WHEN 'label-code' THEN '2026-10-30T10:00:00.000Z' END;`);
  // Art Team was never checked, then Code Team (10:00) before Build Team (11:00).
  assert.deepEqual((await pollTwoWayLabels(db, discord, deps(1), 2)).map((result) => result.labelId), ["label-art", "label-code"]);
  assert.deepEqual((await pollTwoWayLabels(db, discord, deps(6), 2)).map((result) => result.labelId), ["label-build", "label-art"], "the next pass starts with the label this one left");
  assert.equal((await pollTwoWayLabels(db, discord, deps(11))).length, 3, "without a limit every label is checked");
});

test("the scheduled check follows Discord, pushes dashboard changes, never ping-pongs and records unmatched users", async () => {
  const db = seed(); const holders = new Set([ids.ada, ids.cy, ids.gus, ids.stranger]); const discord = server(holders);
  const preview = await previewTwoWay(db, "admin-1", "label-build", discord, deps(0));
  assert.equal(preview.mismatches.length, 0);
  await confirmTwoWay(db, "admin-1", { previewId: preview.previewId }, discord, deps(1));
  const poll = async (minutes: number) => (await pollTwoWayLabels(db, discord, deps(minutes)))[0];

  // Nothing changed: no label change, no role job.
  assert.deepEqual(await poll(5), { labelId: "label-build", status: "checked", labelsAdded: 0, labelsRemoved: 0, labelsAdopted: 0, rolesAdded: 0, rolesRemoved: 0, unmatched: 1, jobId: undefined });
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

test("a member's first check removes nothing: a role already held becomes the label, and a label already held adds the role", async () => {
  const db = seed(); const ian = "777777777777777777";
  // Hal and Ian are on the roster without the label; Hal has no Discord account yet and Ian is inactive. Eve has the label
  // and no account. The visitor and Ian's account hold the role, and so do Ada, Cy and Gus, who have the label.
  const member = db.sqlite.prepare("INSERT INTO members (id, installation_id, external_id, first_name, last_name, discord_user_id, active, created_at) VALUES (?, 'primary', ?, 'Test Student', ?, ?, ?, '2026-09-01T00:00:00Z')");
  member.run("m-hal", "T-HAL", "H", null, 1); member.run("m-ian", "T-IAN", "I", ian, 0);
  const holders = new Set([ids.ada, ids.cy, ids.gus, ids.visitor, ian]);
  const discord = server(holders, [ids.ada, ids.bo, ids.cy, ids.di, ids.fay, ids.gus, ids.stranger, ids.visitor, ian]);
  await confirmTwoWay(db, "admin-1", { previewId: (await previewTwoWay(db, "admin-1", "label-build", discord, deps(0))).previewId }, discord, deps(1));
  const poll = async (minutes: number) => (await pollTwoWayLabels(db, discord, deps(minutes)))[0];
  const baseline = (memberId: string) => (db.sqlite.prepare("SELECT synced_state AS state FROM discord_label_two_way_members WHERE member_id = ?").get(memberId) as { state: number } | undefined)?.state;
  const unmatched = async () => (await unmatchedRoleMembers(db)).labels[0].users.map((user) => user.discordUserId);
  const quiet = await poll(5);
  assert.equal(quiet.labelsAdded + quiet.rolesAdded + quiet.rolesRemoved + quiet.labelsRemoved, 0, "unlinked and inactive role holders are left alone");
  assert.deepEqual(await unmatched(), [ids.visitor]); assert.equal(labelState(db, "m-ian"), undefined); assert.equal(baseline("m-hal"), undefined);

  // Hal links the visitor's account (/pair), which already holds the role: he gets the label, and the role stays.
  db.sqlite.prepare("UPDATE members SET discord_user_id = ? WHERE id = 'm-hal'").run(ids.visitor);
  const adopted = await poll(10);
  assert.deepEqual([adopted.labelsAdded, adopted.labelsAdopted, adopted.labelsRemoved, adopted.rolesAdded, adopted.rolesRemoved, adopted.jobId], [1, 1, 0, 0, 0, undefined]);
  assert.equal(jobs(db).length, 0, "no role is removed"); assert.ok(holders.has(ids.visitor));
  // Recorded like any label change from Discord: dated today, with no dashboard user, and counted in the audit entry.
  assert.deepEqual({ ...db.sqlite.prepare("SELECT action, source, effective_date AS effectiveDate, created_by AS createdBy FROM member_label_changes WHERE member_id = 'm-hal'").get() }, { action: "add", source: "discord", effectiveDate: "2026-10-30", createdBy: null });
  assert.deepEqual(JSON.parse((db.sqlite.prepare("SELECT metadata_json AS metadata FROM audit_log WHERE action = 'discord.label_two_way_applied' ORDER BY created_at DESC LIMIT 1").get() as { metadata: string }).metadata), { roleId, labelsAdded: 1, labelsRemoved: 0, labelsAdopted: 1 });
  assert.equal(baseline("m-hal"), 1, "the union is the baseline"); assert.deepEqual(await unmatched(), []);
  const settled = await poll(15);
  assert.equal(settled.labelsAdded + settled.labelsAdopted + settled.rolesAdded + settled.rolesRemoved + settled.labelsRemoved, 0);

  // Eve has the label and links an account without the role: the role is added, and her label is left alone.
  db.sqlite.prepare("UPDATE members SET discord_user_id = ? WHERE id = 'm-eve'").run(ids.stranger);
  const pushed = await poll(20);
  assert.deepEqual([pushed.labelsAdded, pushed.labelsRemoved, pushed.rolesAdded, pushed.rolesRemoved], [0, 0, 1, 0]); assert.ok(pushed.jobId);
  assert.deepEqual(jobs(db).map((row) => [row.discordUserId, row.action]), [[ids.stranger, "add"]]); assert.deepEqual(labelState(db, "m-eve"), { action: "add", source: "dashboard" });
  assert.equal(baseline("m-eve"), undefined, "no baseline until the role is there");
  finishJobs(db); holders.add(ids.stranger);
  assert.equal((await poll(25)).rolesAdded, 0); assert.equal(baseline("m-eve"), 1);

  // With a baseline the usual rules apply: removing Hal's role in Discord removes his label, and a label removed in the
  // dashboard removes the role.
  holders.delete(ids.visitor);
  const later = await poll(30);
  assert.deepEqual([later.labelsRemoved, later.labelsAdopted], [1, 0]); assert.deepEqual(labelState(db, "m-hal"), { action: "remove", source: "discord" });
  addChange(db, "m-eve", "remove", "2026-10-30", at(31).toISOString());
  assert.equal((await poll(35)).rolesRemoved, 1);
  finishJobs(db); holders.delete(ids.stranger); await poll(40);

  // Linking a different account starts over for that member: Bo moves to an account that holds the role and keeps it.
  holders.add(ids.visitor); db.sqlite.exec("UPDATE members SET discord_user_id = NULL WHERE id = 'm-hal'");
  await poll(45);
  db.sqlite.prepare("UPDATE members SET discord_user_id = ? WHERE id = 'm-bo'").run(ids.visitor);
  const moved = await poll(50);
  assert.deepEqual([moved.labelsAdded, moved.labelsAdopted, moved.rolesRemoved], [1, 1, 0]); assert.deepEqual(labelState(db, "m-bo"), { action: "add", source: "discord" });

  // A member the sync skips is never adopted: Ian is inactive, and a label paused after a restore is not checked at all.
  assert.equal(labelState(db, "m-ian"), undefined);
  db.sqlite.exec("UPDATE discord_label_role_mappings SET sync_direction = 'to_discord', two_way_error = 'restore_review_required'; DELETE FROM discord_label_two_way_members; UPDATE members SET active = 1 WHERE id = 'm-ian'");
  assert.deepEqual(await pollTwoWayLabels(db, discord, deps(55)), []); assert.equal(labelState(db, "m-ian"), undefined);
  // Reviewing it again lists Ian as a difference for the Admin to decide, as for any label being turned on.
  assert.deepEqual((await previewTwoWay(db, "admin-1", "label-build", discord, deps(56))).mismatches.map((row) => [row.memberId, row.hasLabel, row.hasRole]), [["T-IAN", false, true]]);
});

test("a role the bot can no longer manage pauses the label instead of clearing it", async () => {
  const db = seed(); const holders = new Set([ids.ada, ids.cy, ids.gus]); const discord = server(holders);
  await confirmTwoWay(db, "admin-1", { previewId: (await previewTwoWay(db, "admin-1", "label-build", discord, deps(0))).previewId }, discord, deps(1));
  holders.clear();
  const result = (await pollTwoWayLabels(db, { ...discord, guildMembers: discord.guildMembers, roleProblem: () => "The mapped Discord role no longer exists" }, deps(5)))[0];
  assert.equal(result.status, "error"); assert.equal(labelState(db, "m-ada")?.action, "add");
  assert.match((db.sqlite.prepare("SELECT two_way_error AS error FROM discord_label_role_mappings").get() as { error: string }).error, /no longer exists/);
});

// D1 Free allows 100,000 rows written a day, and past that every write in the installation fails, kiosk scans included.
// A two-way label is checked every five minutes (288 times a day), so what one unchanged check writes is what matters.
test("a check that finds nothing changed writes two rows however many unmatched users hold the role", async () => {
  const strangers = Array.from({ length: 110 }, (_, index) => String(700000000000000000n + BigInt(index)));
  const written: Record<number, number> = {};
  for (const count of [0, 1, 110]) {
    const db = seed(); const holders = new Set([ids.ada, ids.cy, ids.gus, ...strangers.slice(0, count)]);
    const discord = server(holders, [ids.ada, ids.bo, ids.cy, ids.di, ids.fay, ids.gus, ...strangers.slice(0, count)]);
    const preview = await previewTwoWay(db, "admin-1", "label-build", discord, deps(0));
    await confirmTwoWay(db, "admin-1", { previewId: preview.previewId, all: "dashboard" }, discord, deps(1));
    const changes = () => Number((db.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    const stored = () => db.sqlite.prepare("SELECT discord_user_id AS id, display_name AS name, seen_at AS seenAt FROM discord_label_unmatched_role_members ORDER BY discord_user_id").all();
    // The first scheduled check settles anything the confirmation left; the second and third find nothing changed.
    assert.equal((await pollTwoWayLabels(db, discord, deps(5)))[0]!.unmatched, count);
    const settled = stored(); assert.equal(settled.length, count);
    const before = changes();
    assert.equal((await pollTwoWayLabels(db, discord, deps(10)))[0]!.status, "checked");
    written[count] = changes() - before;
    assert.deepEqual(stored(), settled, "no unmatched row is rewritten");
    // The dashboard's "Discord users not on the roster" section still shows when the list was last checked.
    const listed = (await unmatchedRoleMembers(db)).labels[0]!;
    assert.equal(listed.checkedAt, at(10).toISOString()); assert.equal(listed.users.length, count);
  }
  // The two rows are the label's own: the lease that keeps passes from overlapping, and its checked time.
  assert.deepEqual(written, { 0: 2, 1: 2, 110: 2 }, "rows written by one unchanged check, by unmatched holders");
});

test("the unmatched list follows the server: users who leave it are removed, new ones added, and a new name updated", async () => {
  const db = seed(); const holders = new Set([ids.ada, ids.cy, ids.gus, ids.stranger]);
  const discord = server(holders);
  const preview = await previewTwoWay(db, "admin-1", "label-build", discord, deps(0));
  await confirmTwoWay(db, "admin-1", { previewId: preview.previewId, all: "dashboard" }, discord, deps(1));
  const stored = () => (db.sqlite.prepare("SELECT discord_user_id AS id, display_name AS name, seen_at AS seenAt FROM discord_label_unmatched_role_members ORDER BY discord_user_id").all() as { id: string; name: string; seenAt: string }[]).map((row) => ({ ...row }));
  assert.deepEqual(stored(), [{ id: ids.stranger, name: "test-999", seenAt: at(1).toISOString() }]);
  holders.add(ids.visitor); await pollTwoWayLabels(db, discord, deps(5));
  assert.deepEqual(stored(), [{ id: ids.visitor, name: "test-888", seenAt: at(5).toISOString() }, { id: ids.stranger, name: "test-999", seenAt: at(1).toISOString() }], "a new holder is added; the other row keeps the time it was first seen");
  holders.delete(ids.stranger);
  const renamed: TwoWayServer = { ...discord, guildMembers: discord.guildMembers.map((member) => member.user?.id === ids.visitor ? { ...member, nick: "Test Visitor" } : member) };
  await pollTwoWayLabels(db, renamed, deps(10));
  assert.deepEqual(stored(), [{ id: ids.visitor, name: "Test Visitor", seenAt: at(5).toISOString() }], "the user who lost the role is removed and the new name stored");
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { validateMigrationPolicy } from "./run-web-upgrade.mjs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const communityMigration = "0039_discord_attendance_delivery_batches.sql";
const bridgeMigration = "0061_update_channels.sql";

const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

function tableQuery(name, columns) {
  const selected = columns.map(identifier).join(",");
  return `SELECT ${selected} FROM ${identifier(name)} ORDER BY ${selected};`;
}

// Snapshot only application state, never SQLite or Wrangler migration bookkeeping.
// The caller uses a local synthetic database, not an installation export.
export async function captureCommunityState(execute) {
  const catalog = await execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;");
  const names = catalog[0].results.map((row) => row.name)
    .filter((name) => name !== "d1_migrations" && !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
  const schemas = await execute(names.map((name) => `PRAGMA table_info(${identifier(name)});`).join("\n"));
  const tables = names.map((name, index) => ({ name, columns: schemas[index].results.map((row) => row.name) }));
  const results = await execute(tables.map(({ name, columns }) => tableQuery(name, columns)).join("\n"));
  return tables.map((table, index) => ({ ...table, rows: results[index].results }));
}

export async function assertCommunityStateRetained(execute, before) {
  const results = await execute(before.map(({ name, columns }) => tableQuery(name, columns)).join("\n"));
  for (const [index, table] of before.entries()) {
    assert.deepEqual(results[index].results, table.rows, `Community table ${table.name} changed during upgrade`);
  }
}

function inside(parent, target) {
  const value = relative(resolve(parent), resolve(target));
  return Boolean(value && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function wrangler(workspace, temporary, configPath, stateDirectory, args, { json = false } = {}) {
  const entry = join(workspace, "node_modules", "wrangler", "bin", "wrangler.js");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entry, ...args, "--config", configPath, "--persist-to", stateDirectory], {
      cwd: workspace,
      shell: false,
      env: { ...process.env, CI: "true", WRANGLER_LOG_PATH: join(temporary, "wrangler-logs"), WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun(json ? JSON.parse(stdout) : stdout) : rejectRun(new Error(`Community upgrade rehearsal failed (${code}).\n${stdout}\n${stderr}`)));
  });
}

const config = (databaseName, migrationsDir) => ({
  name: "lancerlogin-community-upgrade-rehearsal",
  main: "../apps/api/src/index.ts",
  compatibility_date: "2026-08-01",
  d1_databases: [{ binding: "DB", database_name: databaseName, database_id: "00000000-0000-4000-8000-000000000008", migrations_dir: migrationsDir }],
});

const syntheticCommunitySeed = `PRAGMA foreign_keys=ON;
INSERT INTO installations(id,created_at,auth_mode,google_enabled,resend_enabled,discord_enabled,google_calendar_enabled)
VALUES('primary','2026-09-01T00:00:00Z','google',1,0,0,1);
INSERT INTO organization_settings(installation_id,organization_name,subtitle,primary_color,secondary_color,appearance,time_zone,late_scan_minutes,logo_backdrop,attendance_recent_days)
VALUES('primary','Synthetic Community Team','Upgrade rehearsal','#123456','#654321','themed','America/New_York',45,'dark',60);
UPDATE organization_settings SET discord_contest_window_hours=48,attendance_reporting_starts_on='2026-09-01',
  attendance_policy_activated_on='2026-09-01',anomaly_late_threshold_minutes=15,anomaly_early_threshold_minutes=20,
  logo_data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aELsAAAAASUVORK5CYII='
WHERE installation_id='primary';
INSERT INTO users(id,installation_id,email,role,active,created_at,debug_mode)
VALUES('admin-1','primary','admin@synthetic.invalid','admin',1,'2026-09-01T00:00:00Z',1),
      ('operator-1','primary','operator@synthetic.invalid','operator',1,'2026-09-01T00:00:00Z',0);
UPDATE users SET password_hash='synthetic-retained-password-hash' WHERE id='admin-1';
INSERT INTO members(id,installation_id,external_id,first_name,last_name,active,created_at,attendance_required_from)
VALUES('member-1','primary','SYN-001','Avery','Stone',1,'2026-09-01T00:00:00Z','2026-09-01');
UPDATE members SET email='avery@synthetic.invalid',discord_user_id='synthetic-member-discord' WHERE id='member-1';
INSERT INTO members(id,installation_id,external_id,first_name,last_name,active,created_at,attendance_required_from)
VALUES('member-inactive','primary','SYN-002','Jordan','River',0,'2026-09-01T00:00:00Z',NULL);
INSERT INTO member_labels(id,installation_id,name,active,formula_enabled,created_by,created_at)
VALUES('label-1','primary','Synthetic regular',1,1,'admin-1','2026-09-01T00:00:00Z');
INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_by,created_at)
VALUES('label-change-1','primary','member-1','label-1','add','2026-09-01','admin-1','2026-09-01T00:00:00Z');
INSERT INTO label_attendance_rules(id,installation_id,label_id,rule_type,threshold_percent,excused_handling,created_by,created_at,updated_at)
VALUES('rule-1','primary','label-1','weighted_percentage',70,'count_missed','admin-1','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at,is_test,attendance_weight,audience_mode)
VALUES('meeting-1','primary','Synthetic build','2026-09-27T20:00:00Z','2026-09-27T21:00:00Z',1,'admin-1','2026-09-01T00:00:00Z',0,1,'all');
INSERT INTO meeting_templates(id,installation_id,name,title,start_time,duration_minutes,required,notes,recurrence_frequency,recurrence_duration_days,created_by,created_at,updated_at)
VALUES('template-1','primary','Synthetic weekly','Synthetic build','16:00',90,1,'Synthetic scheduling notes','weekly',60,'admin-1','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at)
VALUES('correction-1','primary','member-inactive','meeting-1','excused','Synthetic excused absence','admin-1','2026-09-27T21:00:00Z');
INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,kiosk_event_id,action)
VALUES('attendance-1','primary','member-1','meeting-1','kiosk','2026-09-27T20:01:00Z','synthetic-event-1','check_in');
INSERT INTO setup_progress(installation_id,step,completed_at,completed_by)
VALUES('primary','pair-kiosk','2026-09-01T00:00:00Z','admin-1');
INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,redeemed_at,created_by,created_at,purpose)
VALUES('pairing-legacy','primary','synthetic-retained-pairing-hash','2026-09-01T00:10:00Z','2026-09-01T00:01:00Z','admin-1','2026-09-01T00:00:00Z','hardware');
INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,active,last_seen_at,created_at,reader_online,release_version,pending_events,last_sync_at)
VALUES('kiosk-legacy','primary','pairing-legacy','Front desk','synthetic-retained-token-hash',1,'2026-09-27T21:00:00Z','2026-09-01T00:01:00Z',1,'1.2.4',2,'2026-09-27T21:00:00Z');
UPDATE kiosks SET network_type='wifi',network_signal=82,uptime_seconds=3600,last_wifi_scan_at='2026-09-27T21:00:00Z'
WHERE id='kiosk-legacy';
INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,key_version,updated_at,verified_at)
VALUES('integration-google','primary','google','not-a-credential','not-an-initialization-vector',1,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO saved_report_views(id,installation_id,owner_user_id,scope,name,definition_json,revision,created_by,updated_by,created_at,updated_at)
VALUES('report-1','primary','admin-1','shared','Synthetic attendance','{"version":1,"scope":"attendance"}',1,'admin-1','admin-1','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO saved_report_tabs(installation_id,user_id,report_view_id,position,pinned_at)
VALUES('primary','admin-1','report-1',0,'2026-09-01T00:00:00Z');
INSERT INTO user_walkthroughs(installation_id,user_id,page_id,content_version,status,step_id,updated_at)
VALUES('primary','admin-1','reports',1,'completed',NULL,'2026-09-01T00:00:00Z');
`;

export async function rehearseCommunityUpgrade(workspace = resolve(process.cwd()), boundary = communityMigration) {
  const migrationsDirectory = join(workspace, "apps", "api", "migrations");
  const temporary = await mkdtemp(join(workspace, ".community-upgrade-rehearsal-"));
  const legacyDirectory = join(temporary, "community-migrations"); const stateDirectory = join(temporary, "state");
  const configPath = join(temporary, "wrangler.json"); const seedPath = join(temporary, "community-seed.sql");
  const databaseName = "lancerlogin-community-upgrade-rehearsal";
  try {
    if (!inside(workspace, temporary)) throw new Error(`Unsafe Community upgrade rehearsal directory: ${temporary}`);
    await mkdir(legacyDirectory, { recursive: true }); await mkdir(stateDirectory, { recursive: true });
    const migrations = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    assert.ok(["0038_page_walkthroughs.sql", communityMigration, bridgeMigration].includes(boundary), "Unsupported Community baseline");
    const communityIndex = migrations.indexOf(boundary);
    assert.ok(communityIndex >= 0, "Released Community migration boundary is missing");
    const communityMigrations = boundary === bridgeMigration ? migrations.filter((name) => name <= communityMigration || name === bridgeMigration) : migrations.slice(0, communityIndex + 1);
    const candidateMigrations = migrations.filter((name) => !communityMigrations.includes(name));
    const policy = JSON.parse(await readFile(join(workspace, "scripts/web-upgrade-policy.json"), "utf8"));
    await validateMigrationPolicy(policy, await Promise.all(migrations.map(async (name) => ({ name, content: await readFile(join(migrationsDirectory, name), "utf8") }))), communityMigrations, boundary === bridgeMigration ? "1.2.6" : "1.2.5", "v2.0.0-beta.1");
    for (const name of communityMigrations) await copyFile(join(migrationsDirectory, name), join(legacyDirectory, name));
    await writeFile(configPath, `${JSON.stringify(config(databaseName, "./community-migrations"), null, 2)}\n`, { mode: 0o600 });
    const deliverySeed = boundary !== "0038_page_walkthroughs.sql" ? `
INSERT INTO discord_attendance_notifications(installation_id,meeting_id,status,message_id,attempts,updated_at,delivery_id)
VALUES('primary','meeting-1','failed','synthetic-message',1,'2026-09-27T21:00:00Z','synthetic-delivery');
INSERT INTO discord_attendance_recipients(installation_id,meeting_id,member_id,discord_user_id,message_id,delivered_at,delivery_id)
VALUES('primary','meeting-1','member-1','synthetic-discord-user','synthetic-message','2026-09-27T21:00:00Z','synthetic-delivery');
` : "";
    const bridgeSeed = boundary === bridgeMigration ? "UPDATE installation_update_settings SET update_channel='beta',update_channel_revision=1; UPDATE kiosks SET release_version='1.2.6', update_policy_version=2;" : "";
    await writeFile(seedPath, syntheticCommunitySeed + deliverySeed + bridgeSeed, { mode: 0o600 });
    await wrangler(workspace, temporary, configPath, stateDirectory, ["d1", "migrations", "apply", databaseName, "--local"]);
    await wrangler(workspace, temporary, configPath, stateDirectory, ["d1", "execute", databaseName, "--local", "--file", seedPath]);
    const execute = (command) => wrangler(workspace, temporary, configPath, stateDirectory,
      ["d1", "execute", databaseName, "--local", "--json", "--command", command], { json: true });
    const before = await captureCommunityState(execute);
    await writeFile(configPath, `${JSON.stringify(config(databaseName, "../apps/api/migrations"), null, 2)}\n`, { mode: 0o600 });
    await wrangler(workspace, temporary, configPath, stateDirectory, ["d1", "migrations", "apply", databaseName, "--local"]);
    // Initializing inactivity history invalidates cached reports once per inactive member.
    const expected = structuredClone(before);
    if (candidateMigrations.includes("0062_member_inactive_periods.sql")) {
      for (const row of expected.find((table) => table.name === "report_data_revision")?.rows ?? []) {
        row.revision += before.find((table) => table.name === "members")?.rows.filter((member) => member.installation_id === row.installation_id && member.active === 0).length ?? 0;
      }
    }
    await assertCommunityStateRetained(execute, expected);
    const results = await wrangler(workspace, temporary, configPath, stateDirectory, ["d1", "execute", databaseName, "--local", "--json", "--command", `
      SELECT organization_name AS organizationName,time_zone AS timeZone,late_scan_minutes AS lateScanMinutes,appearance,logo_backdrop AS logoBackdrop,attendance_recent_days AS attendanceRecentDays FROM organization_settings WHERE installation_id='primary';
      SELECT id,external_id AS externalId,first_name AS firstName,last_name AS lastName,attendance_required_from AS attendanceRequiredFrom FROM members WHERE id='member-1';
      SELECT id,title FROM meetings WHERE installation_id='primary';
      SELECT id,kiosk_event_id AS kioskEventId FROM attendance_events WHERE installation_id='primary';
      SELECT id,name,definition_json AS definitionJson FROM saved_report_views WHERE installation_id='primary';
      SELECT page_id AS pageId,status FROM user_walkthroughs WHERE installation_id='primary';
      SELECT provider,verified_at AS verifiedAt FROM encrypted_integrations WHERE installation_id='primary';
      SELECT id,name,active,token_hash AS tokenHash,pending_events AS pendingEvents,pairing_bound AS pairingBound FROM kiosks WHERE installation_id='primary';
      SELECT module_id AS moduleId,phase,setup_version AS setupVersion,setup_complete AS setupComplete,disabled_at AS disabledAt,delete_after AS deleteAfter FROM platform_modules WHERE installation_id='primary' ORDER BY module_id;
      SELECT user_id AS userId,module_id AS moduleId,capabilities_json AS capabilitiesJson FROM platform_module_assignments WHERE installation_id='primary' ORDER BY user_id,module_id;
      SELECT name FROM d1_migrations ORDER BY id;
      SELECT status,message_id AS messageId,delivery_id AS deliveryId FROM discord_attendance_notifications WHERE installation_id='primary';
      SELECT message_id AS messageId,delivery_id AS deliveryId FROM discord_attendance_recipients WHERE installation_id='primary';
      SELECT password_hash AS passwordHash FROM users WHERE id='admin-1';
      SELECT ciphertext,iv,key_version AS keyVersion FROM encrypted_integrations WHERE installation_id='primary';
      SELECT code_hash AS codeHash FROM pairing_codes WHERE id='pairing-legacy';
    `], { json: true });
    const rows = results.map((result) => result.results ?? []);
    assert.deepEqual(rows[0][0], { organizationName: "Synthetic Community Team", timeZone: "America/New_York", lateScanMinutes: 45, appearance: "themed", logoBackdrop: "dark", attendanceRecentDays: 60 });
    assert.deepEqual(rows[1][0], { id: "member-1", externalId: "SYN-001", firstName: "Avery", lastName: "Stone", attendanceRequiredFrom: "2026-09-01" });
    assert.deepEqual(rows[2][0], { id: "meeting-1", title: "Synthetic build" }); assert.deepEqual(rows[3][0], { id: "attendance-1", kioskEventId: "synthetic-event-1" });
    assert.deepEqual(rows[4][0], { id: "report-1", name: "Synthetic attendance", definitionJson: '{"version":1,"scope":"attendance"}' });
    assert.deepEqual(rows[5][0], { pageId: "reports", status: "completed" }); assert.deepEqual(rows[6][0], { provider: "google", verifiedAt: "2026-09-01T00:00:00Z" });
    assert.deepEqual(rows[7][0], { id: "kiosk-legacy", name: "Front desk", active: 1, tokenHash: "synthetic-retained-token-hash", pendingEvents: 2, pairingBound: 0 });
    assert.deepEqual(rows[8], [
      { moduleId: "attendance", phase: "enabled", setupVersion: 2, setupComplete: 1, disabledAt: null, deleteAfter: null },
      { moduleId: "carpool", phase: "disabled", setupVersion: 1, setupComplete: 0, disabledAt: null, deleteAfter: null },
      { moduleId: "hour-tracking", phase: "disabled", setupVersion: 1, setupComplete: 0, disabledAt: null, deleteAfter: null },
    ]);
    assert.deepEqual(rows[9], [{ userId: "operator-1", moduleId: "attendance", capabilitiesJson: '["attendance.manage"]' }]);
    assert.deepEqual(rows[10].map((row) => row.name), [...communityMigrations, ...candidateMigrations]);
    assert.deepEqual(rows[11], boundary !== "0038_page_walkthroughs.sql" ? [{ status: "failed", messageId: "synthetic-message", deliveryId: "synthetic-delivery" }] : []);
    assert.deepEqual(rows[12], boundary !== "0038_page_walkthroughs.sql" ? [{ messageId: "synthetic-message", deliveryId: "synthetic-delivery" }] : []);
    assert.deepEqual(rows[13], [{ passwordHash: "synthetic-retained-password-hash" }]);
    assert.deepEqual(rows[14], [{ ciphertext: "not-a-credential", iv: "not-an-initialization-vector", keyVersion: 1 }]);
    assert.deepEqual(rows[15], [{ codeHash: "synthetic-retained-pairing-hash" }]);
    return { kind: "synthetic-community-upgrade", communityMigration: boundary, appliedCandidateMigrations: candidateMigrations,
      preservedTables: before.map(({ name, columns, rows }) => ({ name, columns: columns.length, rows: rows.length })),
      preserved: ["all existing application columns and rows", "roster and label history", "attendance policies and corrections", "settings", "reports", "walkthroughs", "provider grants", "legacy kiosk credential and queue status", "Discord delivery retry state"], modules: { attendance: "enabled", outreach: "disabled", carpool: "disabled" }, providerAcceptance: false, physicalKioskAcceptance: false };
  } finally {
    if (inside(workspace, temporary)) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("rehearse-community-upgrade.mjs")) (async () => {
  for (const boundary of ["0038_page_walkthroughs.sql", communityMigration, bridgeMigration]) console.log(JSON.stringify(await rehearseCommunityUpgrade(undefined, boundary), null, 2));
})().catch((error) => { console.error(error instanceof Error ? error.message : "Synthetic Community upgrade rehearsal failed."); process.exitCode = 1; });

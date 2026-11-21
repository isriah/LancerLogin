// quick-check: covers apps/api/migrations/**
// The scheduled clean-up of short-lived rows nothing else deletes: old PIN setup requests, Discord label two-way previews
// and wrong-PIN report ids, 30 days after they stopped mattering, a bounded number per pass.
import test from "node:test";
import assert from "node:assert/strict";
import { KIOSK_COMMAND_HISTORY, KIOSK_COMMAND_RETENTION_DAYS, LABEL_ROLE_JOB_BATCH, pruneStaleRows, RETAINED_ROW_BATCH, retainedRowPruning, STALE_ROW_BATCH, STALE_ROW_DAYS } from "../apps/api/src/stale-row-pruning.ts";
import { Statement, TestD1Database } from "./fixtures/d1-database.ts";

const now = Date.parse("2026-11-19T12:00:00.000Z");
const noRetained = { discordAttendanceRecipients: 0, emailDeliveries: 0, discordLabelRoleJobs: 0, discordLabelRolePreviews: 0, discordLabelRoleChallenges: 0, kioskCommands: 0 };
const ago = (days: number, minutes = 0) => new Date(now - days * 86_400_000 - minutes * 60_000).toISOString();

function fixture() {
  const database = new TestD1Database({ seed: `
    INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
    INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES ('test-a','primary','TEST-A','Test Student','A','2026-01-01'), ('test-b','primary','TEST-B','Test Student','B','2026-01-01');
    INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,created_by,created_at) VALUES ('test-pairing','primary','synthetic-hash','2026-01-02','admin','2026-01-01');
    INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,created_at,configured_authentication_method,require_pin) VALUES ('test-kiosk','primary','test-pairing','Test Kiosk A','synthetic-token-hash','2026-01-01','member_id',1);
    INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('test-label','primary','Test Label A','2026-01-01');` });
  const { sqlite } = database;
  const request = sqlite.prepare("INSERT INTO pin_setup_requests(id,installation_id,kiosk_id,member_id,status,created_at,expires_at,decided_at,decided_by) VALUES (?, 'primary', 'test-kiosk', 'test-a', ?, ?, ?, ?, ?)");
  const preview = sqlite.prepare("INSERT INTO discord_label_two_way_previews(id,installation_id,label_id,guild_id,role_id,fingerprint,actor_user_id,expires_at,used_at,created_at) VALUES (?, 'primary', 'test-label', 'test-guild', 'test-role', 'synthetic-fingerprint', 'admin', ?, ?, ?)");
  const reportId = sqlite.prepare("INSERT INTO kiosk_pin_failure_reports(installation_id,kiosk_id,report_id,recorded,applied_at) VALUES ('primary', 'test-kiosk', ?, 1, ?)");
  const code = sqlite.prepare("INSERT INTO discord_kiosk_codes(installation_id,member_id,code_hash,expires_at,used_at,created_at) VALUES ('primary', ?, ?, ?, ?, ?)");
  const left = (table: string, key = "id") => sqlite.prepare(`SELECT ${key} AS id FROM ${table} ORDER BY ${key}`).all().map((row) => String(row.id));
  return { database, sqlite, request, preview, reportId, code, left };
}

test("rows 30 days past their use are removed; pending, recent and live rows are kept", async (context) => {
  const { database, request, preview, reportId, code, left } = fixture(); context.after(() => database.close());
  assert.equal(STALE_ROW_DAYS, 30);
  // PIN setup requests. A pending request runs out 10 minutes after it is made; an approval 5 minutes after the decision.
  request.run("test-pending-live", "pending", ago(0, 5), new Date(now + 5 * 60_000).toISOString(), null, null); // waiting for an Operator
  request.run("test-pending-ran-out-29", "pending", ago(29, 10), ago(29), null, null);
  request.run("test-pending-ran-out-31", "pending", ago(31, 10), ago(31), null, null); // never decided: expiry is computed on read
  request.run("test-approved-unused-31", "approved", ago(31, 20), ago(31), ago(31, 5), "admin");
  request.run("test-used-31", "used", ago(31, 20), ago(31), ago(31, 5), "admin");
  request.run("test-declined-31", "declined", ago(31, 10), ago(31), ago(31, 8), "admin");
  request.run("test-used-29", "used", ago(29, 20), ago(29), ago(29, 5), "admin");
  request.run("test-declined-edge", "declined", ago(30, 9), ago(30, -1), ago(30, 5), "admin"); // expiry one minute short of 30 days ago
  // Discord label two-way previews expire a few minutes after they are made, used or not.
  preview.run("test-preview-old-unused", ago(31), null, ago(31, 10));
  preview.run("test-preview-old-used", ago(40), ago(40, 2), ago(40, 10));
  preview.run("test-preview-recent", ago(2), ago(2, 1), ago(2, 10));
  preview.run("test-preview-live", new Date(now + 60_000).toISOString(), null, ago(0, 1));
  // Report ids, and Discord kiosk codes (used or expired ones go at once, as before).
  reportId.run("test-report-old", ago(31)); reportId.run("test-report-recent", ago(29));
  code.run("test-a", "synthetic-code-hash-a", ago(0, 1), null, ago(0, 3)); // expired a minute ago
  code.run("test-b", "synthetic-code-hash-b", new Date(now + 60_000).toISOString(), null, ago(0, 1)); // live

  let batches = 0; const batch = database.batch.bind(database); database.batch = (statements) => { batches += 1; return batch(statements); };
  const reads = database.reads;
  assert.deepEqual(await pruneStaleRows(database, now), { pinSetupRequests: 4, discordLabelPreviews: 2, pinFailureReports: 1, discordKioskCodes: 1, staleEmailDeliveries: 0, googleCalendarOperations: 0, discordCalendarOperations: 0, ...noRetained });
  assert.deepEqual([batches, database.reads - reads], [1, 0], "one D1 subrequest: a single batch and no other query");
  assert.deepEqual(left("pin_setup_requests"), ["test-declined-edge", "test-pending-live", "test-pending-ran-out-29", "test-used-29"]);
  assert.deepEqual(left("discord_label_two_way_previews"), ["test-preview-live", "test-preview-recent"]);
  assert.deepEqual(left("kiosk_pin_failure_reports", "report_id"), ["test-report-recent"]);
  assert.deepEqual(left("discord_kiosk_codes", "member_id"), ["test-b"]);
  // Nothing more to remove: a second pass changes nothing.
  assert.deepEqual(await pruneStaleRows(database, now), { pinSetupRequests: 0, discordLabelPreviews: 0, pinFailureReports: 0, discordKioskCodes: 0, staleEmailDeliveries: 0, googleCalendarOperations: 0, discordCalendarOperations: 0, ...noRetained });
});

test("one pass removes a bounded number of rows of each table, oldest first", async (context) => {
  const { database, request, preview, reportId, left } = fixture(); context.after(() => database.close());
  assert.equal(STALE_ROW_BATCH, 200);
  for (let index = 0; index < 5; index += 1) {
    request.run(`test-request-${index}`, "used", ago(40 + index, 20), ago(40 + index), ago(40 + index, 5), "admin");
    preview.run(`test-preview-${index}`, ago(40 + index), null, ago(40 + index, 10));
    reportId.run(`test-report-${index}`, ago(40 + index));
  }
  assert.deepEqual(await pruneStaleRows(database, now, 2), { pinSetupRequests: 2, discordLabelPreviews: 2, pinFailureReports: 2, discordKioskCodes: 0, staleEmailDeliveries: 0, googleCalendarOperations: 0, discordCalendarOperations: 0, ...noRetained });
  assert.deepEqual(left("pin_setup_requests"), ["test-request-0", "test-request-1", "test-request-2"], "the two oldest went first");
  assert.deepEqual(left("discord_label_two_way_previews"), ["test-preview-0", "test-preview-1", "test-preview-2"]);
  assert.deepEqual(left("kiosk_pin_failure_reports", "report_id"), ["test-report-0", "test-report-1", "test-report-2"]);
  assert.deepEqual(await pruneStaleRows(database, now, 2), { pinSetupRequests: 2, discordLabelPreviews: 2, pinFailureReports: 2, discordKioskCodes: 0, staleEmailDeliveries: 0, googleCalendarOperations: 0, discordCalendarOperations: 0, ...noRetained });
  assert.deepEqual(await pruneStaleRows(database, now, 2), { pinSetupRequests: 1, discordLabelPreviews: 1, pinFailureReports: 1, discordKioskCodes: 0, staleEmailDeliveries: 0, googleCalendarOperations: 0, discordCalendarOperations: 0, ...noRetained });
  assert.deepEqual(left("pin_setup_requests"), []);
});

// Audit finding 25: finished rows of tables nothing pruned before, kept while anything reads them.
function retainedFixture() {
  const fixtureDatabase = fixture(); const { sqlite } = fixtureDatabase;
  sqlite.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('test-m1','primary','Test Meeting 1','2026-09-01T18:00:00.000Z','2026-09-01T20:00:00.000Z','admin','2026-01-01'),
      ('test-m2','primary','Test Meeting 2','2026-09-02T18:00:00.000Z','2026-09-02T20:00:00.000Z','admin','2026-01-01'), ('test-m3','primary','Test Meeting 3','2026-09-03T18:00:00.000Z','2026-09-03T20:00:00.000Z','admin','2026-01-01');
    INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('test-label-b','primary','Test Label B','2026-01-01');`);
  const notice = sqlite.prepare("INSERT INTO discord_attendance_notifications(installation_id,meeting_id,status,message_id,updated_at,deleted_at,delivery_id) VALUES ('primary', ?, 'delivered', 'synthetic-message', ?, ?, ?)");
  const recipient = sqlite.prepare("INSERT INTO discord_attendance_recipients(installation_id,meeting_id,member_id,discord_user_id,message_id,delivered_at,delivery_id) VALUES ('primary', ?, ?, 'synthetic-user', ?, ?, ?)");
  const delivery = sqlite.prepare("INSERT INTO integration_deliveries(id,installation_id,provider,delivery_key,status,created_at,updated_at) VALUES (?, 'primary', ?, ?, ?, ?, ?)");
  const job = sqlite.prepare("INSERT INTO discord_label_role_jobs(id,installation_id,label_id,guild_id,role_id,status,source_fingerprint,next_attempt_at,created_at,updated_at,completed_at) VALUES (?, 'primary', ?, 'test-guild', 'test-role', ?, 'synthetic', ?, ?, ?, ?)");
  const item = sqlite.prepare("INSERT INTO discord_label_role_job_items(installation_id,job_id,discord_user_id,action,status) VALUES ('primary', ?, ?, 'add', 'completed')");
  const rolePreview = sqlite.prepare("INSERT INTO discord_label_role_previews(id,installation_id,label_id,guild_id,role_id,fingerprint,actor_user_id,expires_at,created_at) VALUES (?, 'primary', 'test-label', 'test-guild', 'test-role', 'synthetic', 'admin', ?, ?)");
  const challenge = sqlite.prepare("INSERT INTO discord_label_role_challenges(id_hash,installation_id,label_id,guild_id,role_id,discord_user_id,expires_at,created_at) VALUES (?, 'primary', 'test-label', 'test-guild', 'test-role', 'synthetic-user', ?, ?)");
  const command = sqlite.prepare("INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at,completed_at,success) VALUES (?, 'primary', 'test-kiosk', ?, 'admin', ?, ?, ?)");
  return { ...fixtureDatabase, notice, recipient, delivery, job, item, rolePreview, challenge, command };
}

test("finished rows nothing reads again are removed a few a pass; live, recent and still-needed rows are kept", async (context) => {
  const f = retainedFixture(); context.after(() => f.database.close());
  assert.deepEqual([STALE_ROW_DAYS, RETAINED_ROW_BATCH, LABEL_ROLE_JOB_BATCH, KIOSK_COMMAND_RETENTION_DAYS, KIOSK_COMMAND_HISTORY], [30, 10, 1, 90, 12]);
  // Notice recipients: meeting 1's notice was deleted from Discord; meeting 2's is still posted; meeting 3's was sent again.
  f.notice.run("test-m1", ago(40), ago(33), "delivery-1"); f.notice.run("test-m2", ago(40), null, "delivery-2"); f.notice.run("test-m3", ago(40), null, "delivery-3b");
  f.recipient.run("test-m1", "test-a", "message-1a", ago(40), "delivery-1"); f.recipient.run("test-m1", "test-b", "message-1b", ago(40), "delivery-1");
  f.recipient.run("test-m2", "test-a", "message-2", ago(40), "delivery-2"); // the live notice's messages are deleted from these later
  f.recipient.run("test-m3", "test-a", "message-3a", ago(41), "delivery-3a"); f.recipient.run("test-m3", "test-b", "message-3b", ago(40), "delivery-3b");
  f.recipient.run("test-m1", "test-a", "message-1c", ago(20), "delivery-1"); // delivered 20 days ago: inside the retention
  // Email sends: failed and dated report keys go; a delivered missed-meeting key is what stops a second send, so it stays.
  f.delivery.run("test-failed-old", "resend", "missed:test-m1:test-a", "failed", ago(31), ago(31));
  f.delivery.run("test-report-old", "resend", "report:test-a:2026-10-01", "delivered", ago(49), ago(49));
  f.delivery.run("test-report-recent", "resend", "report:test-b:2026-11-01", "delivered", ago(18), ago(18));
  f.delivery.run("test-missed-old", "resend", "missed:test-m2:test-a", "delivered", ago(400), ago(400));
  f.delivery.run("test-pending-old", "resend", "report:test-b:2026-10-01", "pending", ago(31), ago(31)); // marked failed by this pass, removed 30 days on
  f.delivery.run("test-discord-old", "discord", "synthetic", "failed", ago(60), ago(60));
  // Label role sync jobs: Test Label's two older jobs go, oldest first; each label's latest job stays, however old.
  f.job.run("test-job-1", "test-label", "completed", ago(60), ago(60), ago(60), ago(60)); f.job.run("test-job-2", "test-label", "partial", ago(45), ago(45), ago(45), ago(45));
  f.job.run("test-job-3", "test-label", "completed", ago(35), ago(35), ago(35), ago(35)); f.job.run("test-job-b", "test-label-b", "stale", ago(90), ago(90), ago(90), ago(90));
  for (const job of ["test-job-1", "test-job-2", "test-job-3"]) for (const user of ["user-a", "user-b"]) f.item.run(job, user);
  f.rolePreview.run("test-role-preview-old", ago(31), ago(31, 10)); f.rolePreview.run("test-role-preview-recent", ago(29), ago(29, 10));
  f.challenge.run("test-challenge-old", ago(31), ago(31, 5)); f.challenge.run("test-challenge-recent", ago(29), ago(29, 5));
  // Kiosk commands, all 91 days old or more: the kiosk's newest 12 stay, and so does an update waiting for the kiosk to report its release.
  f.command.run("test-update-waiting", "install_latest", ago(200), ago(200), 1);
  for (let index = 0; index < 14; index += 1) f.command.run(`test-command-${String(index).padStart(2, "0")}`, "reload_display", ago(91 + index), ago(91 + index), 1);

  let batches = 0; const batch = f.database.batch.bind(f.database); f.database.batch = (statements) => { batches += 1; return batch(statements); };
  assert.deepEqual(await pruneStaleRows(f.database, now), { pinSetupRequests: 0, discordLabelPreviews: 0, pinFailureReports: 0, discordKioskCodes: 0, staleEmailDeliveries: 1, googleCalendarOperations: 0, discordCalendarOperations: 0,
    discordAttendanceRecipients: 3, emailDeliveries: 2, discordLabelRoleJobs: 1, discordLabelRolePreviews: 1, discordLabelRoleChallenges: 1, kioskCommands: 2 });
  assert.equal(batches, 1, "still one D1 subrequest");
  assert.deepEqual(f.left("discord_attendance_recipients", "message_id"), ["message-1c", "message-2", "message-3b"]);
  assert.deepEqual(f.left("integration_deliveries"), ["test-discord-old", "test-missed-old", "test-pending-old", "test-report-recent"]);
  assert.deepEqual(f.left("discord_label_role_jobs"), ["test-job-2", "test-job-3", "test-job-b"]);
  assert.deepEqual(f.left("discord_label_role_job_items", "job_id || ':' || discord_user_id"), ["test-job-2:user-a", "test-job-2:user-b", "test-job-3:user-a", "test-job-3:user-b"], "a job's items go with it");
  assert.deepEqual(f.left("discord_label_role_previews"), ["test-role-preview-recent"]);
  assert.deepEqual(f.left("discord_label_role_challenges", "id_hash"), ["test-challenge-recent"]);
  assert.deepEqual(f.left("kiosk_commands"), [...Array.from({ length: 12 }, (_, index) => `test-command-${String(index).padStart(2, "0")}`), "test-update-waiting"]);
  // The next pass takes the next job; then nothing is left that may go.
  assert.equal((await pruneStaleRows(f.database, now)).discordLabelRoleJobs, 1);
  assert.deepEqual(f.left("discord_label_role_jobs"), ["test-job-3", "test-job-b"]);
  assert.deepEqual(await pruneStaleRows(f.database, now), { pinSetupRequests: 0, discordLabelPreviews: 0, pinFailureReports: 0, discordKioskCodes: 0, staleEmailDeliveries: 0, googleCalendarOperations: 0, discordCalendarOperations: 0, ...noRetained });
});

test("each retained-row prune searches an index for its oldest finished rows instead of scanning its table", (context) => {
  const f = retainedFixture(); context.after(() => f.database.close());
  // Each prune's search, by migration 0104's index on the column it ages rows by. Without them each searched by installation
  // alone or scanned its table, and removing a job scanned every job's items for the foreign key cascade.
  const searches: [string, RegExp[]][] = [
    ["discord_attendance_recipients", [/SEARCH r USING INDEX idx_discord_attendance_recipients_delivered \(installation_id=\? AND delivered_at<\?\)/]],
    ["integration_deliveries", [/SEARCH integration_deliveries USING INDEX idx_integration_deliveries_status \(installation_id=\? AND status=\? AND updated_at<\?\)/]],
    ["discord_label_role_jobs", [/SEARCH j USING INDEX idx_discord_label_role_jobs_completed \(installation_id=\? AND completed_at<\?\)/, /SEARCH n EXISTS USING COVERING INDEX idx_discord_label_role_jobs_label \(installation_id=\? AND label_id=\? AND created_at>\?\)/, /SEARCH discord_label_role_job_items USING COVERING INDEX idx_discord_label_role_job_items_job \(job_id=\?\)/]],
    ["discord_label_role_previews", [/SEARCH discord_label_role_previews USING COVERING INDEX idx_discord_label_role_previews_expiry \(installation_id=\? AND expires_at<\?\)/]],
    ["discord_label_role_challenges", [/SEARCH discord_label_role_challenges USING COVERING INDEX idx_discord_label_role_challenges_expiry \(installation_id=\? AND expires_at<\?\)/]],
    ["kiosk_commands", [/SEARCH c USING INDEX idx_kiosk_commands_created \(installation_id=\? AND created_at<\?\)/, /SEARCH n USING COVERING INDEX idx_kiosk_commands_pending \(kiosk_id=\?\)/]],
  ];
  const statements = retainedRowPruning(f.database, now) as Statement[];
  assert.equal(statements.length, searches.length);
  for (const [index, statement] of statements.entries()) {
    const [table, expected] = searches[index]!;
    // The plan of the rows each DELETE picks (its rowid IN subquery), with the subqueries it runs per row.
    const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.values as never[]).map((row) => String((row as { detail: string }).detail)).join("\n");
    assert.doesNotMatch(plan, /\bSCAN (r|j|n|c|discord_attendance_\w+|integration_deliveries|discord_label_role_\w+|kiosk_commands)\b/, `${table} is not scanned whole:\n${plan}`);
    for (const search of expected) assert.match(plan, search, `${table}:\n${plan}`);
  }
});

test("migration 0101 adds the report id table and removes a kiosk's ids with the kiosk", (context) => {
  const { database, sqlite, reportId } = fixture(); context.after(() => database.close());
  reportId.run("test-report-1", ago(1));
  assert.throws(() => reportId.run("test-report-1", ago(0)), /UNIQUE|PRIMARY/);
  assert.throws(() => sqlite.exec("INSERT INTO kiosk_pin_failure_reports(installation_id,kiosk_id,report_id,recorded,applied_at) VALUES ('primary','test-kiosk','test-negative',-1,'2026-11-19')"), /CHECK/);
  assert.throws(() => sqlite.exec("INSERT INTO kiosk_pin_failure_reports(installation_id,kiosk_id,report_id,recorded,applied_at) VALUES ('primary','test-no-such-kiosk','test-orphan',1,'2026-11-19')"), /FOREIGN KEY/);
  sqlite.exec("DELETE FROM kiosks WHERE id = 'test-kiosk'");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_pin_failure_reports").get()!.n, 0);
});

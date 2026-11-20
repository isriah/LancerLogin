// quick-check: covers apps/api/migrations/**
// The scheduled clean-up of short-lived rows nothing else deletes: old PIN setup requests, Discord label two-way previews
// and wrong-PIN report ids, 30 days after they stopped mattering, a bounded number per pass.
import test from "node:test";
import assert from "node:assert/strict";
import { pruneStaleRows, STALE_ROW_BATCH, STALE_ROW_DAYS } from "../apps/api/src/stale-row-pruning.ts";
import { TestD1Database } from "./fixtures/d1-database.ts";

const now = Date.parse("2026-11-19T12:00:00.000Z");
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
  assert.deepEqual(await pruneStaleRows(database, now), { pinSetupRequests: 4, discordLabelPreviews: 2, pinFailureReports: 1, discordKioskCodes: 1 });
  assert.deepEqual([batches, database.reads - reads], [1, 0], "one D1 subrequest: a single batch and no other query");
  assert.deepEqual(left("pin_setup_requests"), ["test-declined-edge", "test-pending-live", "test-pending-ran-out-29", "test-used-29"]);
  assert.deepEqual(left("discord_label_two_way_previews"), ["test-preview-live", "test-preview-recent"]);
  assert.deepEqual(left("kiosk_pin_failure_reports", "report_id"), ["test-report-recent"]);
  assert.deepEqual(left("discord_kiosk_codes", "member_id"), ["test-b"]);
  // Nothing more to remove: a second pass changes nothing.
  assert.deepEqual(await pruneStaleRows(database, now), { pinSetupRequests: 0, discordLabelPreviews: 0, pinFailureReports: 0, discordKioskCodes: 0 });
});

test("one pass removes a bounded number of rows of each table, oldest first", async (context) => {
  const { database, request, preview, reportId, left } = fixture(); context.after(() => database.close());
  assert.equal(STALE_ROW_BATCH, 200);
  for (let index = 0; index < 5; index += 1) {
    request.run(`test-request-${index}`, "used", ago(40 + index, 20), ago(40 + index), ago(40 + index, 5), "admin");
    preview.run(`test-preview-${index}`, ago(40 + index), null, ago(40 + index, 10));
    reportId.run(`test-report-${index}`, ago(40 + index));
  }
  assert.deepEqual(await pruneStaleRows(database, now, 2), { pinSetupRequests: 2, discordLabelPreviews: 2, pinFailureReports: 2, discordKioskCodes: 0 });
  assert.deepEqual(left("pin_setup_requests"), ["test-request-0", "test-request-1", "test-request-2"], "the two oldest went first");
  assert.deepEqual(left("discord_label_two_way_previews"), ["test-preview-0", "test-preview-1", "test-preview-2"]);
  assert.deepEqual(left("kiosk_pin_failure_reports", "report_id"), ["test-report-0", "test-report-1", "test-report-2"]);
  assert.deepEqual(await pruneStaleRows(database, now, 2), { pinSetupRequests: 2, discordLabelPreviews: 2, pinFailureReports: 2, discordKioskCodes: 0 });
  assert.deepEqual(await pruneStaleRows(database, now, 2), { pinSetupRequests: 1, discordLabelPreviews: 1, pinFailureReports: 1, discordKioskCodes: 0 });
  assert.deepEqual(left("pin_setup_requests"), []);
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

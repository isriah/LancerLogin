// quick-check: covers apps/api/src/index.ts apps/api/src/fingerprint-match.ts
// Settings and roster changes write their audit row in the same D1 batch as the change, on a real migrated SQLite
// database: the change and its audit row commit together, and an audit insert that fails rolls the change back.
import test from "node:test";
import assert from "node:assert/strict";

const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");

const dashboardOrigin = "https://dashboard.example.test";

/** BackupDatabase that records the SQL of each batch. */
class RecordingDatabase extends BackupDatabase {
  batchSql: string[][] = [];
  override async batch(statements: Parameters<BackupDatabase["batch"]>[0]) {
    this.batchSql.push(statements.map((statement) => (statement as { sql?: string }).sql ?? ""));
    return super.batch(statements);
  }
}

async function fixture() {
  const db = new RecordingDatabase();
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: dashboardOrigin };
  await worker.fetch(new Request("https://fixture.test/health"), env);
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  const send = (method: string, path: string, body?: unknown) => worker.fetch(new Request("https://fixture.test" + path, { method, headers: { cookie, origin: dashboardOrigin, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  db.raw.exec(`INSERT INTO meeting_weight_categories(id,installation_id,name,weight,position,active,created_by,created_at,updated_at) VALUES ('weight','primary','Synthetic build',2,0,1,'admin','2026-01-01','2026-01-01');
    INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('label','primary','Synthetic label','2026-01-01');
    INSERT INTO members(id,installation_id,external_id,first_name,last_name,active,created_at) VALUES ('spare','primary','002','Test Student','B',1,'2026-01-01');`);
  return { db, send };
}
const failAudits = (db: RecordingDatabase) => db.raw.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;");
const allowAudits = (db: RecordingDatabase) => db.raw.exec("DROP TRIGGER synthetic_audit_failure");

type Case = { name: string; action: string; request: (send: Awaited<ReturnType<typeof fixture>>["send"]) => Promise<Response>; change: string; changed: (db: RecordingDatabase) => unknown; after: unknown; prepare?: (send: Awaited<ReturnType<typeof fixture>>["send"]) => Promise<unknown> };
const brandingBody = async (send: Awaited<ReturnType<typeof fixture>>["send"]) => ({ ...(await (await send("GET", "/admin/branding")).json() as { settings: Record<string, unknown> }).settings, organizationName: "Synthetic Renamed Club", primaryColor: "#123456", secondaryColor: "#654321", appearance: "system", logoBackdrop: "auto", discordContestWindowHours: 24, lateScanMinutes: 30 });
const cases: Case[] = [
  { name: "branding", action: "branding.updated", request: async (send) => send("PATCH", "/admin/branding", await brandingBody(send)), change: "UPDATE organization_settings", changed: (db) => db.rows("SELECT organization_name AS name FROM organization_settings")[0], after: { name: "Synthetic Renamed Club" } },
  { name: "meeting weight category", action: "meeting_weight_category.updated", request: (send) => send("PATCH", "/admin/meeting-weight-categories/weight", { name: "Synthetic long build" }), change: "UPDATE meeting_weight_categories", changed: (db) => db.rows("SELECT name FROM meeting_weight_categories WHERE id = 'weight'")[0], after: { name: "Synthetic long build" } },
  { name: "label", action: "label.updated", request: (send) => send("PATCH", "/labels/label", { name: "Synthetic renamed label" }), change: "UPDATE member_labels", changed: (db) => db.rows("SELECT name FROM member_labels WHERE id = 'label'")[0], after: { name: "Synthetic renamed label" } },
  { name: "member update", action: "roster.member_updated", request: (send) => send("PATCH", "/admin/members/member", { firstName: "Test Student" }), change: "UPDATE members", changed: (db) => db.rows("SELECT first_name AS firstName FROM members WHERE id = 'member'")[0], after: { firstName: "Test Student" } },
  { name: "member delete", action: "roster.member_deleted", request: (send) => send("DELETE", "/admin/members/spare", { confirmation: "DELETE MEMBER 002" }), change: "DELETE FROM members", changed: (db) => db.count("SELECT COUNT(*) AS n FROM members WHERE id = 'spare'"), after: 0 },
  { name: "scheduler stop", action: "scheduler.stop", request: (send) => send("POST", "/admin/scheduler/stop", {}), change: "INSERT INTO platform_scheduler_state", changed: (db) => db.count("SELECT COUNT(*) AS n FROM platform_scheduler_state WHERE paused_until IS NOT NULL"), after: 1 },
  { name: "scheduler start", action: "scheduler.start", prepare: (send) => send("POST", "/admin/scheduler/stop", {}), request: (send) => send("POST", "/admin/scheduler/start", {}), change: "UPDATE platform_scheduler_state", changed: (db) => db.count("SELECT COUNT(*) AS n FROM platform_scheduler_state WHERE paused_until IS NOT NULL"), after: 0 },
  { name: "fingerprint minimum score", action: "kiosk.fingerprint_minimum_score_changed", request: (send) => send("PUT", "/admin/kiosks/fingerprint-match", { minimumScore: 120 }), change: "INSERT INTO kiosk_fingerprint_match_settings", changed: (db) => db.rows("SELECT minimum_score AS score FROM kiosk_fingerprint_match_settings")[0]?.score ?? null, after: 120 },
];

for (const item of cases) {
  test(`a ${item.name} change and its audit row commit together in one batch`, async (t) => {
    const { db, send } = await fixture(); t.after(() => db.raw.close());
    if (item.prepare) assert.ok((await item.prepare(send)).ok);
    const audits = () => db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?", item.action);
    const before = audits(); const unchanged = item.changed(db);

    failAudits(db);
    const failed = await item.request(send);
    assert.ok(!failed.ok, `the request fails when its audit row cannot be written: ${failed.status}`);
    assert.deepEqual(item.changed(db), unchanged, "a failed audit insert rolls the change back");
    allowAudits(db);

    db.batchSql = [];
    const result = await item.request(send);
    assert.ok(result.ok, await result.clone().text());
    assert.deepEqual(item.changed(db), item.after);
    // One audit row, and it came from the batch that made the change: the audit insert is not a request of its own.
    assert.equal(audits(), before + 1);
    const batches = db.batchSql.filter((sql) => sql.some((text) => text.trimStart().startsWith(item.change)));
    assert.equal(batches.length, 1, `one batch makes the change: ${JSON.stringify(db.batchSql)}`);
    assert.equal(batches[0]!.filter((text) => text.startsWith("INSERT INTO audit_log")).length, 1, "the change's batch carries its audit insert");
  });
}

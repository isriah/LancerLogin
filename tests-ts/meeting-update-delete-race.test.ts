// quick-check: covers apps/api/src/index.ts
// A meeting edit that races a delete on a real migrated SQLite database: the delete lands after the edit route has read the
// live meeting but before its write batch, so the batch must leave the deleted meeting's audience and the audit log alone.
import test from "node:test";
import assert from "node:assert/strict";

const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");

const dashboardOrigin = "https://dashboard.example.test";

/** BackupDatabase that runs `beforeBatch` once, just before the meeting edit's write batch, to inject a concurrent write. */
class RaceDatabase extends BackupDatabase {
  beforeBatch?: () => void;
  override async batch(statements: Parameters<BackupDatabase["batch"]>[0]) {
    if (statements.some((statement) => (statement as { sql?: string }).sql?.startsWith("UPDATE meetings SET title"))) { const inject = this.beforeBatch; this.beforeBatch = undefined; inject?.(); }
    return super.batch(statements);
  }
}

async function fixture() {
  const db = new RaceDatabase();
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: dashboardOrigin };
  await worker.fetch(new Request("https://fixture.test/health"), env);
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  const patch = (path: string, body: unknown) => worker.fetch(new Request("https://fixture.test" + path, { method: "PATCH", headers: { cookie, "content-type": "application/json", origin: dashboardOrigin }, body: JSON.stringify(body) }), env);
  // A synthetic upcoming meeting for two labels, so the edit needs no historical impact preview.
  db.raw.exec(`INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('label-a','primary','Synthetic A','2026-01-01'),('label-b','primary','Synthetic B','2026-01-01'),('label-c','primary','Synthetic C','2026-01-01');
    INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at,audience_mode) VALUES ('meeting','primary','Synthetic build','2030-03-01T18:00:00.000Z','2030-03-01T20:00:00.000Z','admin','2026-01-01T00:00:00.000Z','labels');
    INSERT INTO meeting_audience_labels(installation_id,meeting_id,label_id) VALUES ('primary','meeting','label-a'),('primary','meeting','label-b');`);
  return { db, patch };
}

const edit = { title: "Synthetic build (edited)", startsAt: "2030-03-01T18:00:00.000Z", endsAt: "2030-03-01T20:00:00.000Z", required: true, audienceMode: "labels", audienceLabelIds: ["label-c"] };
const audience = (db: RaceDatabase) => db.rows<{ label_id: string }>("SELECT label_id FROM meeting_audience_labels WHERE meeting_id = 'meeting' ORDER BY label_id").map((row) => row.label_id);

test("a meeting edit replaces the audience and writes its audit row while the meeting is live", async (t) => {
  const { db, patch } = await fixture(); t.after(() => db.raw.close());
  const result = await patch("/meetings/meeting", edit);
  assert.equal(result.status, 200, await result.clone().text());
  assert.deepEqual(audience(db), ["label-c"]);
  assert.equal(db.rows<{ title: string }>("SELECT title FROM meetings WHERE id = 'meeting'")[0]!.title, "Synthetic build (edited)");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'meeting.updated' AND target_id = 'meeting'"), 1);
});

test("a meeting edit whose meeting is deleted before its batch leaves the audience and audit log unchanged", async (t) => {
  const { db, patch } = await fixture(); t.after(() => db.raw.close());
  // The delete lands after the route read the live meeting and its audience, just before the edit's write batch.
  db.beforeBatch = () => db.raw.exec("UPDATE meetings SET deleted_at = '2026-11-20T00:00:00.000Z' WHERE id = 'meeting'");
  await patch("/meetings/meeting", edit);
  assert.equal(db.beforeBatch, undefined, "the delete was injected before the edit's batch");
  assert.deepEqual(db.rows("SELECT title, deleted_at AS deletedAt FROM meetings WHERE id = 'meeting'"), [{ title: "Synthetic build", deletedAt: "2026-11-20T00:00:00.000Z" }], "the guarded update leaves the deleted meeting as it was");
  assert.deepEqual(audience(db), ["label-a", "label-b"], "the deleted meeting keeps the audience a restore brings back");
  assert.equal(db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'meeting.updated'"), 0, "no audit row records an edit that did not apply");
});

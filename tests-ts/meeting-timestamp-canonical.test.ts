// quick-check: covers apps/api/src/index.ts apps/api/src/attendance-policy.ts
// Meeting times are stored in one canonical form (toISOString: UTC with milliseconds) whatever ISO 8601 variant a client
// sends, and meetings saved earlier with an offset are still compared by time, on a real migrated SQLite database.
import test from "node:test";
import assert from "node:assert/strict";

const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, backupClient, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");

const dashboardOrigin = "https://dashboard.example.test";

async function fixture() {
  const db = new BackupDatabase(); const client = backupClient(worker, db);
  const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured", ALLOWED_ORIGIN: dashboardOrigin };
  const cookie = "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" });
  const patch = (path: string, body: unknown) => worker.fetch(new Request("https://fixture.test" + path, { method: "PATCH", headers: { cookie, "content-type": "application/json", origin: dashboardOrigin }, body: JSON.stringify(body) }), env);
  return { db, client, patch };
}
const stored = (db: InstanceType<typeof BackupDatabase>, id: string) => db.rows<{ startsAt: string; endsAt: string }>("SELECT starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE id = ?", id)[0];
/** The instant `epoch` written as local time at a fixed offset, e.g. "2026-03-01T10:00:00-08:00", as an older client might have saved it. */
const withOffset = (epoch: number, offsetHours: number) => `${new Date(epoch + offsetHours * 3_600_000).toISOString().slice(0, 19)}${offsetHours < 0 ? "-" : "+"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
const meetingRow = (id: string, startsAt: string, endsAt: string) => `INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('${id}','primary','Synthetic ${id}','${startsAt}','${endsAt}','admin','2026-01-01T00:00:00.000Z');`;

test("a meeting posted with an offset or without milliseconds is stored and returned in canonical UTC", async (t) => {
  const { db, client, patch } = await fixture(); t.after(() => db.raw.close());
  const offset = await client.call("/meetings", { title: "Synthetic offset", startsAt: "2030-03-01T10:00:00-08:00", endsAt: "2030-03-01T12:00:00-08:00", required: true });
  assert.equal(offset.status, 201, await offset.clone().text());
  const created = await offset.json() as { meeting: { id: string; startsAt: string; endsAt: string } };
  assert.deepEqual(stored(db, created.meeting.id), { startsAt: "2030-03-01T18:00:00.000Z", endsAt: "2030-03-01T20:00:00.000Z" });
  assert.deepEqual([created.meeting.startsAt, created.meeting.endsAt], ["2030-03-01T18:00:00.000Z", "2030-03-01T20:00:00.000Z"], "the response carries the stored form");

  const seconds = await client.call("/meetings", { title: "Synthetic no milliseconds", startsAt: "2030-03-08T18:00:00Z", endsAt: "2030-03-08T20:00Z", required: true });
  assert.equal(seconds.status, 201, await seconds.clone().text());
  const second = await seconds.json() as { meeting: { id: string } };
  assert.deepEqual(stored(db, second.meeting.id), { startsAt: "2030-03-08T18:00:00.000Z", endsAt: "2030-03-08T20:00:00.000Z" });

  // An edit (as the dashboard sends back the saved value, or any client with an offset) is stored canonically too.
  const edited = await patch(`/meetings/${encodeURIComponent(second.meeting.id)}`, { title: "Synthetic no milliseconds", startsAt: "2030-03-08T19:00:00+01:00", endsAt: "2030-03-08T21:30:00+01:00", required: true });
  assert.equal(edited.status, 200, await edited.clone().text());
  assert.deepEqual(stored(db, second.meeting.id), { startsAt: "2030-03-08T18:00:00.000Z", endsAt: "2030-03-08T20:30:00.000Z" });
  assert.deepEqual((await edited.json() as { meeting: { startsAt: string } }).meeting.startsAt, "2030-03-08T18:00:00.000Z");

  // The comparison that sorts these now runs on one form: text order is time order.
  assert.deepEqual(db.rows<{ title: string }>("SELECT title FROM meetings ORDER BY starts_at").map((row) => row.title), ["Synthetic offset", "Synthetic no milliseconds"]);
  const invalid = await client.call("/meetings", { title: "Synthetic invalid", startsAt: "not a time", endsAt: "2030-03-08T20:00:00Z", required: true });
  assert.equal(invalid.status, 400);
});

test("member history and policy order still compare meetings saved with an offset by time", async (t) => {
  const { db, client } = await fixture(); t.after(() => db.raw.close());
  const now = Date.now(); const hour = 3_600_000;
  // "ended": ended two hours ago, saved at +10:00, so its text reads eight hours ahead and a plain text comparison with
  // the current time would hide it from history. "later": the later of two finished meetings, saved at -12:00 so its text
  // sorts before "earlier"; policy rows must still list it second.
  db.raw.exec(`${meetingRow("ended", withOffset(now - 4 * hour, 10), withOffset(now - 2 * hour, 10))}
    ${meetingRow("earlier", new Date(now - 30 * hour).toISOString(), new Date(now - 28 * hour).toISOString())}
    ${meetingRow("later", withOffset(now - 20 * hour, -12), withOffset(now - 18 * hour, -12))}`);
  assert.ok(db.rows<{ endsAt: string }>("SELECT ends_at AS endsAt FROM meetings WHERE id = 'ended'")[0]!.endsAt > new Date(now).toISOString(), "the stored text alone reads as not yet ended");

  const result = await client.call("/admin/members/001/history");
  assert.equal(result.status, 200, await result.clone().text());
  const body = await result.json() as { history: { meetingId: string }[]; attendancePolicy: { rows: { meetingId: string }[] } };
  assert.deepEqual(body.history.map((row) => row.meetingId).sort(), ["earlier", "ended", "later"], "the meeting that ended two hours ago is in history");
  assert.deepEqual(body.attendancePolicy.rows.map((row) => row.meetingId), ["earlier", "later", "ended"], "policy rows follow start time, not stored text");
});

// A member's participation starts on the organization-local date they were added to the roster, not the UTC date of
// that instant. Around midnight UTC the two differ: west of UTC an evening addition is already "tomorrow" in UTC, and
// east of UTC an early-morning addition is still "yesterday" in UTC. Every check compares organization-local dates.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { runSchedulerSlice, registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, type Env } from "../apps/api/src/index.ts";
import { evaluateAttendance, participationStartDate, type PolicyMeeting, type PolicyMember } from "../apps/api/src/attendance-policy.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { InstallationSeed, TestD1Database, attendanceWithOutreachDisabled } from "./fixtures/d1-database.ts";
import { sessionSecret } from "./fixtures/worker-fake-database.ts";
import { BackupDatabase, backupClient } from "./fixtures/backup-database.ts";
import { omitContestResubmissionFields } from "./fixtures/backup-versions.ts";

const hour = 3_600_000;
const meeting = (id: string, startsAt: string): PolicyMeeting => ({ id, title: `Test ${id}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 2 * hour).toISOString(), attendanceClosesAt: new Date(Date.parse(startsAt) + 2.5 * hour).toISOString(), required: true, attendanceWeight: 1, audienceMode: "all", audienceLabelIds: [] });

// America/Los_Angeles is UTC-7 in September: added 18:00 local on Sep 14 is 01:00Z on Sep 15.
const west = {
  timeZone: "America/Los_Angeles", addedAt: "2026-09-15T01:00:00.000Z", startsOn: "2026-09-14",
  counted: meeting("west-evening", "2026-09-15T01:30:00.000Z"), // Sep 14 18:30 local: the evening the member was added
  excluded: meeting("west-day-before", "2026-09-14T01:30:00.000Z"), // Sep 13 18:30 local
};
// Asia/Tokyo is UTC+9: added 07:00 local on Sep 15 is 22:00Z on Sep 14.
const east = {
  timeZone: "Asia/Tokyo", addedAt: "2026-09-14T22:00:00.000Z", startsOn: "2026-09-15",
  counted: meeting("east-same-day", "2026-09-15T09:00:00.000Z"), // Sep 15 18:00 local
  excluded: meeting("east-day-before", "2026-09-14T09:00:00.000Z"), // Sep 14 18:00 local: the previous local day
};

test("the default participation start is the organization-local date the member was added", () => {
  assert.equal(participationStartDate({ rosterAddedAt: west.addedAt }, west.timeZone), "2026-09-14");
  assert.equal(participationStartDate({ rosterAddedAt: east.addedAt }, east.timeZone), "2026-09-15");
  assert.equal(participationStartDate({ rosterAddedAt: west.addedAt }, "UTC"), "2026-09-15");
  assert.equal(participationStartDate({ rosterAddedAt: "2026-09-15 01:00:00" }, west.timeZone), "2026-09-14", "a SQLite timestamp without a zone is UTC");
  assert.equal(participationStartDate({ rosterAddedAt: "2026-09-15" }, west.timeZone), "2026-09-15", "a bare date is already a date");
  assert.equal(participationStartDate({ attendanceRequiredFrom: "2026-09-20", rosterAddedAt: west.addedAt }, west.timeZone), "2026-09-20", "an explicit start date wins");
  assert.equal(participationStartDate({}, west.timeZone), "");
});

for (const zone of [west, east]) {
  test(`attendance policy counts meetings from the local roster-added day (${zone.timeZone})`, () => {
    const member: PolicyMember = { id: "test-a", memberId: "TEST-A", firstName: "Test Student", lastName: "A", active: 1, rosterAddedAt: zone.addedAt };
    const [result] = evaluateAttendance({ members: [member], labels: [], changes: [], rules: [], meetings: [zone.counted, zone.excluded], observations: [], timeZone: zone.timeZone, now: "2026-10-01T00:00:00.000Z" });
    const eligibility = Object.fromEntries(result!.rows.map((row) => [row.meetingId, row.eligibility]));
    assert.deepEqual(eligibility, { [zone.counted.id]: "required", [zone.excluded.id]: "before_start" });
    assert.equal(result!.regularAttendance.meetingsRequired, 1);
    assert.equal(result!.regularAttendance.from, zone.startsOn);
  });
}

const cookie = async () => `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
async function installation(timeZone: string, zone: typeof west) {
  const db = new TestD1Database({ seed: new InstallationSeed("2026-09-01T00:00:00Z").users("admin").organization(timeZone).modules(...attendanceWithOutreachDisabled(true)) });
  // Synthetic members: one with no explicit start (roster-added date applies), one whose explicit start is the local day.
  db.sqlite.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,created_at,attendance_required_from) VALUES ('test-a','primary','TEST-A','Test Student','A','test-student-a@example.test',?,NULL),('test-b','primary','TEST-B','Test Student','B','test-student-b@example.test','2026-09-01T00:00:00.000Z',?)").run(zone.addedAt, zone.startsOn);
  for (const item of [zone.counted, zone.excluded]) db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES (?,'primary',?,?,?,'admin','2026-09-01T00:00:00Z')").run(item.id, item.title, item.startsAt, item.endsAt);
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: db } as unknown as Env;
  const call = async (path: string, body?: unknown) => worker.fetch(new Request(`https://api.example.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: await cookie(), ...(body === undefined ? {} : { "content-type": "application/json", origin: env.ALLOWED_ORIGIN }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { db, env, call };
}
const minutesAfter = (instant: string, minutes: number) => new Date(Date.parse(instant) + minutes * 60_000).toISOString();

for (const zone of [west, east]) {
  test(`manual attendance, the meeting roster and member history use the local roster-added day (${zone.timeZone})`, async () => {
    const { db, call } = await installation(zone.timeZone, zone);
    const record = (eventId: string, memberId: string, item: PolicyMeeting) => call("/attendance", { eventId, memberId, meetingId: item.id, occurredAt: minutesAfter(item.startsAt, 5) });
    const refused = await record("test-excluded", "TEST-A", zone.excluded); assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json().then((body: { code?: string; error?: string }) => [body.code, body.error]), ["participation_not_started", `Attendance for Test Student begins on ${zone.startsOn}`]);
    const accepted = await record("test-counted", "TEST-A", zone.counted); assert.equal(accepted.status, 202, await accepted.clone().text());

    const roster = async (item: PolicyMeeting) => { const result = await call(`/attendance?meetingId=${item.id}`); assert.equal(result.status, 200, await result.clone().text()); return Object.fromEntries((await result.json() as { attendance: { memberId: string; eligibility: string }[] }).attendance.map((row) => [row.memberId, row.eligibility])); };
    assert.deepEqual(await roster(zone.counted), { "test-a": "required", "test-b": "required" });
    assert.deepEqual(await roster(zone.excluded), { "test-a": "before_start", "test-b": "before_start" });

    const history = await call("/admin/members/TEST-A/history"); assert.equal(history.status, 200, await history.clone().text());
    assert.deepEqual((await history.json() as { history: { meetingId: string }[] }).history.map((row) => row.meetingId), [zone.counted.id]);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM attendance_events WHERE member_id='test-a'").get()?.count, 1);
  });
}

test("restoring a backup from before participation dates starts members on their local roster-added day", async () => {
  const db = new BackupDatabase(); const client = backupClient(worker, db);
  db.raw.prepare("UPDATE organization_settings SET time_zone = ? WHERE installation_id = 'primary'").run(east.timeZone);
  db.raw.prepare("UPDATE members SET created_at = ? WHERE id = 'member'").run(east.addedAt);
  const backup = await client.backup("installation");
  // Schema 13 backups carry neither participation dates nor inactivity history.
  backup.schemaVersion = 13; omitContestResubmissionFields(backup);
  for (const row of backup.tables.members) { delete row.attendance_required_from; delete row.inactive_periods_json; }
  const restored = await client.restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(db.rows("SELECT created_at AS createdAt, attendance_required_from AS startsOn FROM members"), [{ createdAt: east.addedAt, startsOn: east.startsOn }]);
});

const jobIds =[...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs].map((job) => job.id);
test("the Discord anomaly report includes members from their local participation day", async () => {
  for (const zone of [west, east]) {
    const { db, env } = await installation(zone.timeZone, zone);
    const discord = await encryptIntegration({ botToken: "synthetic-bot-token", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
    db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES ('discord-1','primary','discord',?,?,'2026-09-01','2026-09-01')").run(discord.ciphertext, discord.iv);
    db.sqlite.exec("UPDATE installations SET discord_enabled = 1 WHERE id = 'primary'");
    db.sqlite.exec("UPDATE organization_settings SET discord_anomaly_reports_enabled = 1, discord_anomaly_report_channel_id = '323456789012345678', discord_anomaly_reports_enabled_at = '2026-09-01T00:00:00.000Z' WHERE installation_id = 'primary'");
    const now = Date.now();
    db.sqlite.prepare("INSERT INTO platform_scheduler_state(installation_id,jobs_json,updated_at) VALUES ('primary',?,?)").run(JSON.stringify(Object.fromEntries(jobIds.map((id) => [id, { next: now + hour, last: now - 60_000, outcome: "ok" }]))), new Date(now).toISOString());
    // Both synthetic members arrive 30 minutes late to both meetings; only meetings on or after their local start report them.
    for (const item of [zone.counted, zone.excluded]) for (const memberId of ["test-a", "test-b"]) db.sqlite.prepare("INSERT INTO attendance_events(id,installation_id,kiosk_event_id,member_id,meeting_id,action,occurred_at,source) VALUES (?,'primary',?,?,?,'check_in',?,'manual')").run(`${item.id}-${memberId}`, `${item.id}-${memberId}`, memberId, item.id, minutesAfter(item.startsAt, 30));
    const posted: { channel: string; content: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); if (init?.method === "POST") posted.push({ channel: url, content: JSON.parse(String(init.body)).content });
      return Response.json({ id: `message-${posted.length}` });
    }) as typeof fetch;
    try { await runSchedulerSlice(env, { "attendance.discord-anomalies": now }, now); } finally { globalThis.fetch = original; }
    const reports = Object.fromEntries((db.sqlite.prepare("SELECT meeting_id AS meetingId, status FROM discord_anomaly_reports").all() as { meetingId: string; status: string }[]).map((row) => [row.meetingId, row.status]));
    assert.deepEqual(reports, { [zone.counted.id]: "delivered", [zone.excluded.id]: "no_anomalies" }, zone.timeZone);
    assert.equal(posted.length, 1, zone.timeZone);
    assert.match(posted[0]!.content, /Test Student A \(TEST-A\)/); assert.match(posted[0]!.content, /Test Student B \(TEST-B\)/);
  }
});
